// The in-session half of the automatic re-apply: while VS Code is open, a Claude Code update unpacks a
// new extension folder beside the running one, and the patch lives in the folder it replaces. This is
// the only moment Claudapter is still alive to notice, so host.js watches ~/.vscode/extensions and runs
// the patcher against the new folder before the reload.
//
// Two things are worth pinning. That it fires at all — the comparison is against the folder VS Code
// says it is running, not against anything on disk. And that it fires once: every write anywhere under
// that directory wakes the watcher, and a folder already settled must not be spawned against again.
//
// host.js requires('vscode') and reads everything out of homedir(), neither of which exists here, so
// both are stubbed and the module is loaded as CommonJS from a .cjs copy — the same shape as
// profile-icons.test.mjs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');

const HOME = path.join(tmpdir(), `ccx-watcher-${process.pid}`);
const EXTENSIONS = path.join(HOME, '.vscode', 'extensions');
const RUNTIME = path.join(HOME, '.claude', 'claudapter');
const RUNNING = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.247-win32-x64');
const UPDATED = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.248-win32-x64');
const RECORD = path.join(RUNTIME, 'record.log');

rmSync(HOME, { recursive: true, force: true });
for (const dir of [RUNTIME, RUNNING, UPDATED]) mkdirSync(dir, { recursive: true });

// renderScript refuses to do anything without the page bundle beside it
writeFileSync(path.join(RUNTIME, 'webview.js'), '/* page */\n');

// Stands in for apply-patch.mjs: records how it was called, then answers the way a fresh patch onto a
// version nobody has verified does — the case the watcher has to word differently
writeFileSync(
    path.join(RUNTIME, 'apply-patch.mjs'),
    [
        "import { appendFileSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        "const record = fileURLToPath(new URL('./record.log', import.meta.url));",
        "appendFileSync(record, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "console.log('ccx-result: patched');",
        "console.log('ccx-unverified: 2.1.248 2.1.247');",
        "console.log('ccx-upstream: 2.1.248 covers');",
        '',
    ].join('\n'),
);

const shown = [];
const executed = [];
const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }) },
    window: {
        showInformationMessage: (message, ...actions) => {
            shown.push({ message, actions });
            return Promise.resolve(undefined);
        },
        showWarningMessage: (message) => {
            shown.push({ message, actions: [] });
            return Promise.resolve(undefined);
        },
    },
    commands: { executeCommand: (id) => executed.push(id) },
    extensions: { getExtension: (id) => (id === 'anthropic.claude-code' ? { extensionPath: RUNNING } : undefined) },
};

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode') return vscodeStub;
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => HOME };
    return load(request, ...rest);
};

const copy = path.join(tmpdir(), `ccx-host-watcher-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));

let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const webview = {
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: () => ({ dispose() {} }),
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, ms = 8000) {
    for (let waited = 0; waited < ms; waited += 100) {
        if (check()) return;
        await sleep(100);
    }
    assert.fail(what);
}

function calls() {
    return existsSync(RECORD)
        ? readFileSync(RECORD, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];
}

function closeWatchers() {
    const state = globalThis.__ccxState || {};
    for (const key of ['extensionsWatcher', 'agentRunsWatcher', 'settingsWatcher', 'bindingsWatcher', 'profilesWatcher'])
        try {
            state[key]?.close();
        } catch {}
}

try {
    // Opening a tab installs the watchers, and the update may have landed before that — so the check
    // runs once directly, not only on the next write
    renderScript(webview, 'nonce');

    await until('the patcher was never spawned against the updated folder', () => calls().length > 0);
    assert.deepEqual(
        calls()[0],
        ['--if-needed', `--dir=${UPDATED}`],
        'the watcher did not aim the patcher at the newest folder with --if-needed',
    );
    console.log('OK — a folder newer than the running extension sends the patcher at it');

    await until('no reload was offered after a successful patch', () => shown.length > 0);
    assert.deepEqual(shown[0].actions, ['Reload Window'], 'the notification did not offer a reload');
    // A signature matching is not a promise the code around it still means the same thing, and nobody
    // reads an automatic run's stdout — so the version it went onto has to be in the notification
    assert.match(shown[0].message, /2\.1\.248/, `the notification does not name the version patched: ${shown[0].message}`);
    assert.match(shown[0].message, /2\.1\.247/, `the notification does not name the verified version: ${shown[0].message}`);
    // The frozen copy cannot update itself, so knowing the fix is already published is the whole point
    assert.match(shown[0].message, /published|pull/i, `the notification does not point at the release: ${shown[0].message}`);
    console.log('OK — a patch onto an unverified version says so, names the release, and offers the reload');

    // Every write under ~/.vscode/extensions wakes the watcher; a settled folder must not be run again
    writeFileSync(path.join(EXTENSIONS, 'unrelated.marker'), 'x');
    await sleep(4500);
    assert.equal(calls().length, 1, `the patcher ran ${calls().length} times for one update`);
    console.log('OK — later writes under the extensions directory do not spawn the patcher again');

    // An obsolete folder is a version VS Code has retired: newer on paper, never going to be loaded
    rmSync(RECORD, { force: true });
    closeWatchers();
    const state = globalThis.__ccxState;
    state.extensionsWatcher = null;
    state.repatchTries = new Map();
    writeFileSync(path.join(EXTENSIONS, '.obsolete'), JSON.stringify({ [path.basename(UPDATED)]: true }));

    renderScript(webview, 'nonce');
    await sleep(1500);
    assert.equal(calls().length, 0, 'the patcher was sent at a folder VS Code has already retired');
    console.log('OK — a retired folder is not mistaken for an update');
} finally {
    closeWatchers();
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}
