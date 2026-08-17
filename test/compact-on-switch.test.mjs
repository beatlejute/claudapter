// A provider change on a tab with history is offered a compaction first: the prompt cache never
// survives the change anyway, so sending the compact summary instead of the raw transcript is what
// makes the first turn on the new backend cheaper. It is a question, and it must never trap the
// switch — every branch has to end in a restart. This drives the real webview.js in a minimal DOM
// with a fake session, and checks each way the offer can resolve.
//   node test/compact-on-switch.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

// --- a DOM just big enough for the page script ------------------------------------------------
class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this.textContent = '';
        this.style = {};
        this.dataset = {};
        this.parentElement = null;
        this.onclick = null;
        this.offsetParent = {};
    }
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); this.parentElement = null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    closest() { return null; }
    setAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0 }; }
}
const body = new El('body');
const head = new El('head');
const document = {
    body, head,
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
    execCommand: () => true,
};
const timers = [];
const window = {
    document,
    addEventListener() {}, removeEventListener() {},
    getSelection: () => null,
    innerWidth: 1000, innerHeight: 800,
    setTimeout: (fn, ms) => { const t = { fn, ms, fired: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
};
window.window = window;
const posted = [];
let listener = null;
window.addEventListener = (type, fn) => { if (type === 'message') listener = fn; };
const context = {
    window, document, console,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), context);
const ccx = context.window.__ccx;
assert.ok(ccx && typeof ccx.onRegistry === 'function', 'page did not install window.__ccx');
assert.ok(listener, 'page did not register a message listener');
const fromHost = (m) => listener({ data: m });

// --- fake app: registry, connection, active session --------------------------------------------
const launches = [];
const sends = [];
let sendImpl = () => Promise.resolve();
const session = {
    messages: { value: [{ type: 'user' }, { type: 'assistant' }] },
    busy: { value: false },
    // The stock "Switch model… → <model>" indicator: filled from the last assistant turn while history
    // replays for a resume, so after a provider switch it names the OLD provider's model until the new
    // one answers. Every restart of a switch has to clear it.
    lastServedModel: { value: 'deepseek-v4-pro' },
    send: (text) => { sends.push(text); return sendImpl(text); },
};
// Deliberately WITHOUT activeSession: in the real bundle the session lives on another class entirely
// (`MX`, while this object is `t_e`) and there is no route to it from here. Reading ctx.activeSession
// was the bug — it was always undefined, so canCompact() said no and the offer never appeared. The
// session arrives as onRegistry's third argument, which is what injection point #4 now passes.
const host = {
    commandRegistry: { registerAction() {}, subscribe() {}, executeCommand() {}, commandActions: new Map() },
    comms: { connection: { value: { launchClaude: (...a) => launches.push(a) } } },
};
ccx.onRegistry(host, () => null, session);

// The page learns the channel from the app's own outgoing launch_claude (through the proxied api)
const api = context.window.acquireVsCodeApi();
api.postMessage({ type: 'launch_claude', channelId: 'ch1', cwd: '/w', resume: 'sess-1', permissionMode: 'default', thinkingLevel: 'x' });

function toastBars() { return body.children.filter((c) => c.className === 'ccx-toast'); }
function offerBar() { return toastBars().find((b) => b.children.some((c) => c.tagName === 'button')); }
function fireTimers(pred) { for (const t of timers) if (!t.fired && !t.cleared && pred(t)) { t.fired = true; t.fn(); } }
// The host answers close_channel by echoing it; the page then relaunches. Every restart in these
// steps is completed this way, because pendingRestart stays set until it is — exactly as in the app.
function completeRestart(channelId) {
    fromHost({ type: 'from-extension', message: { type: 'close_channel', channelId: channelId || 'ch1' } });
    fireTimers((t) => t.ms === 150);
}
function reset() { launches.length = 0; sends.length = 0; timers.length = 0; body.children.length = 0; posted.length = 0; }

// 1. Applying a profile on a tab with history OFFERS compaction instead of restarting straight away.
reset();
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
let bar = offerBar();
assert.ok(bar, 'no compact offer was shown');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 0, 'must not close the channel before the user answers');
assert.equal(sends.length, 0, 'must not send anything before the user answers');

// 2. "Switch as is" → immediate restart, no /compact sent.
const no = bar.children.find((c) => c.tagName === 'button' && /as is/.test(c.textContent));
no.onclick();
assert.equal(sends.length, 0, 'switch-as-is must not compact');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'switch-as-is must restart');
assert.equal(offerBar(), undefined, 'offer must be dismissed');
assert.equal(session.lastServedModel.value, undefined, 'switch-as-is must forget the served model of the old provider');
completeRestart();
session.lastServedModel.value = 'deepseek-v4-pro';

// 3. "Compact & switch" → /compact is sent through the session, restart waits for the boundary.
reset();
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
bar = offerBar();
const yes = bar.children.find((c) => c.tagName === 'button' && /Compact/.test(c.textContent));
yes.onclick();
assert.deepEqual(sends, ['/compact'], 'must send /compact through the session');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 0, 'must not restart before the boundary');
assert.equal(session.lastServedModel.value, 'deepseek-v4-pro', 'must not touch the indicator before the restart actually goes');
// The CLI reports the boundary on the channel → restart follows (after the short settle beat).
fromHost({ type: 'from-extension', message: { type: 'io_message', channelId: 'ch1', message: { type: 'system', subtype: 'compact_boundary' } } });
fireTimers((t) => t.ms === 400);
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'restart must follow the compact boundary');
assert.equal(session.lastServedModel.value, undefined, 'the restart after compaction must forget the served model');
// The resume carried through is the real session, so history survives
completeRestart();
assert.equal(launches.length, 1, 'launchClaude must be called once');
assert.equal(launches[0][1], 'sess-1', 'the compacted session must be resumed, not started fresh');

// 4. A boundary on ANOTHER channel must not release the wait.
reset();
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
offerBar().children.find((c) => c.tagName === 'button' && /Compact/.test(c.textContent)).onclick();
fromHost({ type: 'from-extension', message: { type: 'io_message', channelId: 'other', message: { type: 'system', subtype: 'compact_boundary' } } });
fireTimers((t) => t.ms === 400);
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 0, 'a foreign channel boundary must be ignored');
// … and the wait timeout then restarts as is, so the switch is never held hostage.
fireTimers((t) => t.ms === 90000);
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'timeout must restart uncompacted');
completeRestart();

// 5. send() rejecting → restart as is, no hang.
reset();
sendImpl = () => Promise.reject(new Error('boom'));
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
offerBar().children.find((c) => c.tagName === 'button' && /Compact/.test(c.textContent)).onclick();
await new Promise((r) => setImmediate(r));
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'a failed /compact must still restart');
completeRestart();
sendImpl = () => Promise.resolve();

// 6. Unanswered offer → restarts as is after its own timeout (the profile is already applied on the host).
reset();
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
assert.ok(offerBar());
fireTimers((t) => t.ms === 20000);
assert.equal(offerBar(), undefined, 'unanswered offer must be dismissed');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'unanswered offer must still switch');
assert.equal(sends.length, 0);
completeRestart();

// 7. No offer when there is nothing to compact: a busy session, or one with no assistant turn.
reset();
session.busy.value = true;
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
assert.equal(offerBar(), undefined, 'must not offer while a turn is running');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1, 'busy session restarts directly');
completeRestart();
session.busy.value = false;
reset();
session.messages.value = [{ type: 'user' }];
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: 'sess-1' });
assert.equal(offerBar(), undefined, 'must not offer with no assistant turn');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1);
completeRestart();
session.messages.value = [{ type: 'user' }, { type: 'assistant' }];

// 8. A fresh tab (nothing to resume) is never offered compaction — it starts fresh at once.
reset();
api.postMessage({ type: 'launch_claude', channelId: 'ch2', cwd: '/w', resume: null, permissionMode: 'default', thinkingLevel: 'x' });
fromHost({ type: 'ccx:applied', name: 'codex', sessionId: null });
assert.equal(offerBar(), undefined, 'a fresh tab must not be offered compaction');
assert.equal(posted.filter((m) => m.type === 'close_channel').length, 1);
completeRestart('ch2');

// 9. The wiring itself: the patcher must hand the session to onRegistry, and the page must take it
//    from there rather than from the context object. Read off the sources, because a mismatch between
//    the two is exactly the failure this file exists to catch and it is invisible at runtime — the
//    offer just never appears.
const patcher = readFileSync(new URL('../scripts/apply-patch.mjs', import.meta.url), 'utf8');
assert.ok(
    /onRegistry\(\$\{ctx\},b,\$\{session\}\)/.test(patcher),
    'injection point #4 must pass the session as onRegistry\'s third argument',
);
const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
assert.ok(
    /onRegistry: function \(host, jsxFactory, session\)/.test(page),
    'onRegistry must accept the session',
);
assert.ok(!/ctx\.activeSession/.test(page), 'the session must not be read off the context object — it is not there');

console.log('\nOK — a provider switch offers compaction and every branch still restarts');
