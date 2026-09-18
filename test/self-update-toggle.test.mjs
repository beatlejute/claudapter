// The command-menu switch for self-update. Unlike the two switches beside it, this one keeps no local
// preference: arming writes a file that apply-patch.mjs reads from another process entirely, so the
// host's answer is the only truth there is and the page has to follow it rather than its own click.
//
// What is worth pinning is the round trip — the message writes the file, the state that comes back says
// so, and disarming removes it — plus the one guard the page depends on: no clone on record means no
// repoPath in the state, and the row is never drawn at all.
//
// host.js requires('vscode') and reads everything out of homedir(), so both are stubbed and the module
// is loaded as CommonJS from a .cjs copy — the same shape as profile-icons.test.mjs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');

const HOME = path.join(tmpdir(), `ccx-selfupdate-${process.pid}`);
const RUNTIME = path.join(HOME, '.claude', 'claudapter');
const ARMED = path.join(RUNTIME, 'self-update.json');
const STAMP = path.join(RUNTIME, 'patch-version.json');
const CLONE = path.join(HOME, 'clone');

rmSync(HOME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });
mkdirSync(path.join(HOME, '.claude', 'profiles'), { recursive: true });
writeFileSync(path.join(RUNTIME, 'webview.js'), '/* page */\n');

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode')
        return {
            Uri: { file: (p) => ({ fsPath: p }), parse: (p) => p },
            window: { showInformationMessage: () => Promise.resolve(), showWarningMessage: () => Promise.resolve() },
            commands: { executeCommand: () => {} },
            env: { openExternal: () => {} },
            extensions: { getExtension: () => undefined },
        };
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => HOME };
    return load(request, ...rest);
};

const copy = path.join(tmpdir(), `ccx-host-selfupdate-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));

let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

// The page as host.js sees it: one handler in, every ccx:state out
const posted = [];
let handler = null;
const webview = {
    postMessage: (message) => {
        posted.push(message);
        return Promise.resolve(true);
    },
    onDidReceiveMessage: (fn) => {
        handler = fn;
        return { dispose() {} };
    },
};

function lastState() {
    for (let i = posted.length - 1; i >= 0; i--) if (posted[i]?.type === 'ccx:state') return posted[i];
    return null;
}

function closeWatchers() {
    const state = globalThis.__ccxState || {};
    for (const key of ['extensionsWatcher', 'agentRunsWatcher', 'settingsWatcher', 'bindingsWatcher', 'profilesWatcher'])
        try {
            state[key]?.close();
        } catch {}
}

try {
    renderScript(webview, 'nonce');
    assert.ok(handler, 'host.js never registered a message handler');

    // --- no clone on record -----------------------------------------------------------------------
    // The stamp is what an install leaves behind. Without one there is nothing to pull, and the page
    // uses exactly this field to decide whether to draw the row.
    posted.length = 0;
    handler({ type: 'ccx:selfUpdate', enabled: true });
    assert.equal(lastState()?.selfUpdateRepo, null, 'a clone was invented out of nothing');
    assert.equal(lastState()?.selfUpdate, false, 'self-update armed with no clone to pull');
    assert.ok(!existsSync(ARMED), 'an arming file was written with no repoPath in it');
    console.log('OK — with no clone on record the switch cannot arm and the row is never offered');

    // --- arming -----------------------------------------------------------------------------------
    mkdirSync(CLONE, { recursive: true });
    writeFileSync(STAMP, JSON.stringify({ version: '9.9.9', repoPath: CLONE }));

    posted.length = 0;
    handler({ type: 'ccx:selfUpdate', enabled: true });
    assert.ok(existsSync(ARMED), 'arming wrote no file for the patcher to find');
    const armed = JSON.parse(readFileSync(ARMED, 'utf8'));
    assert.equal(armed.enabled, true, 'the arming file does not say it is armed');
    assert.equal(armed.repoPath, CLONE, 'the arming file points at the wrong clone');
    assert.equal(lastState()?.selfUpdate, true, 'the state that came back does not say it is armed');
    assert.equal(lastState()?.selfUpdateRepo, CLONE, 'the state names the wrong clone');
    console.log('OK — the switch arms self-update against the clone the installer recorded');

    // --- disarming --------------------------------------------------------------------------------
    posted.length = 0;
    handler({ type: 'ccx:selfUpdate', enabled: false });
    assert.ok(!existsSync(ARMED), 'disarming left the arming file behind');
    assert.equal(lastState()?.selfUpdate, false, 'the state still says armed after disarming');
    // The row stays available: the clone is still on record, only the switch is off
    assert.equal(lastState()?.selfUpdateRepo, CLONE, 'disarming also forgot the clone');
    console.log('OK — disarming removes the file and keeps the row, with the clone still known');

    // --- every window reads the file, not its own memory -------------------------------------------
    // Each VS Code window is a separate extension host, so a flip in one has to reach the next
    writeFileSync(ARMED, JSON.stringify({ enabled: true, repoPath: CLONE }));
    posted.length = 0;
    handler({ type: 'ccx:refresh' });
    const seen = lastState();
    if (seen) assert.equal(seen.selfUpdate, true, 'the state was cached instead of read off disk');
    assert.ok(existsSync(ARMED), 'a refresh removed the arming file');
    console.log('OK — the switch is read off disk, so another window flipping it is seen here');
} finally {
    closeWatchers();
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}

// host.js is written for an extension host that runs until the window closes — it has no teardown, and
// attaching a page leaves handles behind that nothing is meant to release. Every assertion above has
// run by now, so the exit is the teardown.
process.exit(0);
