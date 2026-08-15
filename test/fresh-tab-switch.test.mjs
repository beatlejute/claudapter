// A provider switch on a tab that has not sent anything yet used to relaunch with `--resume <id>`
// for a session the CLI had never written, and the CLI answered "No conversation found with session
// ID …". The id was real enough to look at — the webview holds a provisional id per channel before
// the first message — but only a weak source (update_session_state) had ever confirmed it. The host
// already refused to *bind* on a weak id; it still echoed it back in ccx:state, and the page adopted
// that as state.sessionId and handed it back on ccx:apply as the id to resume. This pins both ends:
// a weak id never leaves the host, and a fresh-tab apply binds nothing and echoes nothing.
//   node test/fresh-tab-switch.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-fresh-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(profiles, { recursive: true });
mkdirSync(runtime, { recursive: true });
writeFileSync(join(profiles, 'codex.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid/codex' } }));
copyFileSync(new URL('../src/webview.js', import.meta.url), join(runtime, 'webview.js'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-fresh-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

function fakeWebview() {
    const handlers = [];
    const posted = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    return { webview, posted, send: (m) => handlers.forEach((fn) => fn(m)) };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const bindings = () => JSON.parse(readFileSync(join(runtime, 'bindings.json'), 'utf8'));
const WEAK = 'cb962f8c-2d1d-45da-9653-e4a09a6c259e';

// 1. A weak id is held on the host but never repeated to the page in ccx:state.
const t = fakeWebview();
t.posted.length = 0;
t.send({ type: 'request', request: { type: 'update_session_state', sessionId: WEAK, state: 'idle' } });
await settle();
assert.equal(t.webview.__ccxSessionId, WEAK, 'the host should still track the weak id for itself');
assert.equal(t.webview.__ccxSessionWeak, true);
const states = t.posted.filter((m) => m.type === 'ccx:state');
assert.ok(states.length, 'a weak id should still trigger a ccx:state (profile/model resolution)');
for (const s of states) assert.equal(s.sessionId, null, `a weak id leaked to the page in ccx:state: ${s.sessionId}`);

// 2. A fresh-tab apply — no strong id anywhere — binds nothing and echoes nothing to resume.
t.posted.length = 0;
t.send({ type: 'ccx:apply', name: 'codex', sessionId: null, channelId: 'ch-fresh' });
await settle();
const applied = t.posted.find((m) => m.type === 'ccx:applied');
assert.ok(applied, 'ccx:applied was not posted');
assert.equal(applied.sessionId, null, `fresh-tab apply echoed an id to resume: ${applied.sessionId}`);
assert.equal(applied.name, 'codex');
let b = {};
try { b = bindings(); } catch {}
assert.ok(!(WEAK in b), 'a weak id must not be written to bindings.json');

// 3. Once the CLI announces the real session (system/init through postMessage), the pending profile
//    binds to THAT id — the fresh restart is what makes this the first thing the CLI says.
const REAL = '11111111-2222-4333-8444-555555555555';
t.webview.postMessage({ type: 'from-extension', message: { type: 'io_message', channelId: 'ch-fresh', message: { type: 'system', subtype: 'init', session_id: REAL } } });
await settle();
assert.equal(t.webview.__ccxSessionId, REAL);
assert.equal(t.webview.__ccxSessionWeak, false);
assert.equal(bindings()[REAL], 'codex', 'the real session should bind to the profile chosen on the fresh tab');
const after = t.posted.filter((m) => m.type === 'ccx:state').pop();
assert.equal(after.sessionId, REAL, 'a strong id must reach the page');

// 4. The page side: restartChannel must not fall back to state.sessionId for resume. Read the source
//    rather than a DOM harness — the invariant is a single expression and this keeps it from drifting.
const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
const body = page.slice(page.indexOf('function restartChannel'), page.indexOf('function doLaunch'));
assert.ok(/var resume = sessionByChannel\[activeChannelId\] \|\| \(launch && launch\.resume\) \|\| undefined;/.test(body),
    'restartChannel must resume only from the channel record or the launch it was started with');
assert.ok(!/resume:[^\n]*state\.sessionId/.test(body), 'restartChannel must not resume from state.sessionId');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — a provider switch on a fresh tab restarts without a phantom --resume');
process.exit(0);
