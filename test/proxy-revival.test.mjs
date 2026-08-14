// The adapter is a detached process, so it can die while the tab stays open — a crash, a kill, the
// machine sleeping. Before this was wired up, every prompt after that died on ConnectionRefused and
// nothing brought the adapter back until the user launched a new session: ensureProxy only ran on
// launch_claude and ccx:apply. This pins the revival check on the user-turn path.
//
// host.js is driven through renderScript(), which is what attaches the message handler in production.
// Loading it needs the same .cjs-copy + 'vscode' stub dance as the other host tests, plus a temp HOME,
// because the module resolves ~/.claude paths at load time.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const PORT = 8799; // not the real 8787 — this must never collide with a live adapter
const home = join(tmpdir(), `ccx-revive-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(profiles, { recursive: true });
mkdirSync(join(runtime, 'proxy'), { recursive: true });

writeFileSync(
    join(profiles, 'codex.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}/codex`, ANTHROPIC_AUTH_TOKEN: 'sk-x' } }),
);
// A profile that talks straight to a provider — it has no local adapter, so it must not be probed.
writeFileSync(
    join(profiles, 'deepseek.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-y' } }),
);
writeFileSync(join(runtime, 'bindings.json'), JSON.stringify({ 'sess-codex': 'codex', 'sess-direct': 'deepseek' }));
// ensureProxy bails before probing if the adapter script is absent, so it has to exist. It is never
// executed here: the port is held open for the cases that assert a probe, and the spawn path is not
// what this test is about.
writeFileSync(join(runtime, 'proxy', 'server.mjs'), '// stub\n');
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

const copy = join(tmpdir(), `ccx-host-revive-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

// Stand in for the port the adapter would hold, and count the probes that reach it.
let probes = 0;
const server = createServer((socket) => {
    probes++;
    socket.destroy();
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

function fakeWebview() {
    const handlers = [];
    const webview = {
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    assert.ok(handlers.length, 'renderScript did not attach a message handler');
    return { webview, send: (m) => handlers.forEach((fn) => fn(m)) };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

// 1. A user turn on a session bound to the local adapter must check the port.
const a = fakeWebview();
a.webview.__ccxSessionId = 'sess-codex';
probes = 0;
a.send({ type: 'io_message', channelId: 'ch1', message: { type: 'user' } });
await settle();
assert.equal(probes, 1, 'a user turn on an adapter-backed session did not check that the adapter is up');

// 2. A session bound to a direct provider has no adapter, so nothing must be probed.
const b = fakeWebview();
b.webview.__ccxSessionId = 'sess-direct';
probes = 0;
b.send({ type: 'io_message', channelId: 'ch2', message: { type: 'user' } });
await settle();
assert.equal(probes, 0, 'a direct provider must not be probed for a local adapter');

// 3. An unbound session resolves to no profile — also nothing to probe.
const c = fakeWebview();
c.webview.__ccxSessionId = 'sess-unknown';
probes = 0;
c.send({ type: 'io_message', channelId: 'ch3', message: { type: 'user' } });
await settle();
assert.equal(probes, 0, 'an unbound session must not be probed');

// 4. Messages that are not a user turn must not probe on every keystroke of housekeeping traffic.
const d = fakeWebview();
d.webview.__ccxSessionId = 'sess-codex';
probes = 0;
d.send({ type: 'request', request: { type: 'update_session_state', sessionId: 'sess-codex', state: 'idle' } });
d.send({ type: 'request', request: { type: 'log_event', eventName: 'time_to_response' } });
await settle();
assert.equal(probes, 0, 'housekeeping traffic must not probe the adapter');

await new Promise((r) => server.close(r));
rmSync(home, { recursive: true, force: true });
console.log('\nOK — a dead adapter is revived on the next user turn');
// attachWebview installs fs.watch handles on settings, bindings and profiles. Inside the extension
// host they are meant to live for the session, so nothing unrefs them and the loop never drains —
// correct there, a hang here.
process.exit(0);
