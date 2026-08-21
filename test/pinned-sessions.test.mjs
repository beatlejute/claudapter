// A pinned session sits above the rest of the history list — and stays there under a search, as long
// as the row still matches. The list is re-derived from scratch on every render, so the pin cannot be
// a DOM move: it is a sort applied where the app computes the list (injection point #7), which is also
// the list its keyboard navigation indexes, so arrow keys keep agreeing with what is on screen.
// Three things are checked here: that the host stores and prunes the pinned ids, that the page sorts
// and toggles correctly, and that the patcher still hands the component what the page relies on.
//   node test/pinned-sessions.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// --- Part 1: the host side — the pinned list on disk ------------------------------------------

const home = join(tmpdir(), `ccx-pin-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(runtime, { recursive: true });
// renderScript() reads this file to build the injected <script> — without it it fails closed (empty
// string) and never even calls attachWebview, which would make every assertion below pass vacuously.
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
const copy = join(tmpdir(), `ccx-host-pin-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const A = 'aaaaaaaa-1111-4222-8333-444444444444';
const B = 'bbbbbbbb-1111-4222-8333-444444444444';
const PINNED_FILE = join(runtime, 'pinned.json');

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

const lastState = (t) => t.posted.filter((m) => m.type === 'ccx:state').at(-1);

// 1. Nothing pinned yet: the state push still carries the field, as an empty list rather than
//    undefined — the page treats a missing field as "no answer" and leaves its own copy alone.
const t = fakeWebview();
assert.deepEqual(lastState(t).pinnedSessions, [], 'a fresh runtime must report an empty pinned list');

// 2. Pinning writes the file and pushes the new list to the page without being asked for it.
t.posted.length = 0;
t.send({ type: 'ccx:pinSession', sessionId: A, pinned: true });
assert.deepEqual(lastState(t).pinnedSessions, [A], 'a pin must reach the page in the next state push');
assert.deepEqual(JSON.parse(readFileSync(PINNED_FILE, 'utf8')), [A], 'a pin must survive on disk');

// 3. A second pin is appended, not replaced — and the id of the tab itself is irrelevant: the
//    message carries whichever history row was clicked.
t.posted.length = 0;
t.send({ type: 'ccx:pinSession', sessionId: B, pinned: true });
assert.deepEqual(lastState(t).pinnedSessions, [A, B]);

// 4. Unpinning removes exactly one.
t.posted.length = 0;
t.send({ type: 'ccx:pinSession', sessionId: A, pinned: false });
assert.deepEqual(lastState(t).pinnedSessions, [B], 'unpinning must leave the other pins alone');

// 5. Deleting a session drops its pin: nothing else ever revisits the list, and the id cannot come
//    back, so a pin left behind would hold a slot for a session that no longer exists.
t.send({ type: 'ccx:pinSession', sessionId: A, pinned: true });
t.posted.length = 0;
t.send({ type: 'request', request: { type: 'delete_session', sessionId: A } });
assert.deepEqual(lastState(t).pinnedSessions, [B], 'a deleted session must lose its pin');

// 6. A delete for a session that was never pinned changes nothing and pushes nothing.
t.posted.length = 0;
t.send({ type: 'request', request: { type: 'delete_session', sessionId: A } });
assert.equal(lastState(t), undefined, 'an unrelated delete must not cost a state broadcast');

// 7. Garbage never reaches the file.
t.send({ type: 'ccx:pinSession', sessionId: null, pinned: true });
t.send({ type: 'ccx:pinSession', sessionId: 42, pinned: true });
assert.deepEqual(JSON.parse(readFileSync(PINNED_FILE, 'utf8')), [B]);

// 8. A corrupt file reads as "nothing pinned" rather than throwing on every state push.
writeFileSync(PINNED_FILE, '{"not":"a list"}');
const t2 = fakeWebview();
assert.deepEqual(lastState(t2).pinnedSessions, [], 'a corrupt pinned.json must degrade to no pins');

console.log('OK — the host stores, prunes and republishes the pinned list');

rmSync(home, { recursive: true, force: true });
assert.ok(!existsSync(home));

// --- Part 2: the page side — the sort, the mark, and the toggle -------------------------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this.textContent = '';
        this.title = '';
        this.dataset = {};
        this.attrs = {};
        this.parentElement = null;
        this.onclick = null;
        this.onmousedown = null;
        this.style = { setProperty() {}, removeProperty() {} };
    }
    get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild(n) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        this.children.push(n);
        return n;
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    // Only the one selector applyRowPin actually asks for
    querySelector(sel) {
        return sel === ':scope > .ccx-pin' ? this.children.find((c) => c.className === 'ccx-pin') || null : null;
    }
    querySelectorAll() { return []; }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    closest() { return null; }
}

const ROW_SELECTOR = 'button[class*="sessionItem_"]';
let rows = [];
const body = new El('body');
const head = new El('head');
const document2 = {
    body, head,
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === ROW_SELECTOR ? rows.slice() : []),
    addEventListener() {}, removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
    execCommand: () => true,
};
const timers = [];
const window2 = {
    document: document2,
    addEventListener() {}, removeEventListener() {},
    getSelection: () => null,
    innerWidth: 1000, innerHeight: 800,
    setTimeout: (fn, ms) => { const t = { fn, ms, fired: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
};
window2.window = window2;
const posted = [];
let listener = null;
window2.addEventListener = (type, fn) => { if (type === 'message') listener = fn; };
const context = {
    window: window2, document: document2, console,
    setTimeout: window2.setTimeout, clearTimeout: window2.clearTimeout,
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
assert.ok(typeof ccx.onPinState === 'function', 'page did not expose onPinState');
assert.ok(typeof ccx.pinSort === 'function', 'page did not expose pinSort');

const fireTimers = (pred) => { for (const t of timers) if (!t.fired && !t.cleared && pred(t)) { t.fired = true; t.fn(); } };
const fromHost = (m) => listener({ data: m });
// What the app hands pinSort: the session objects it is about to render, ids behind signals
const session = (id) => ({ sessionId: { value: id } });

// The list stands in for the app's own state pair — pinSort is called with whatever was last set,
// which is the only way the component learns the order has to change.
let pinState = null;
const pinPushes = [];
ccx.onPinState((next) => { pinPushes.push(next); pinState = next; });
fireTimers((t) => t.ms === 0);

const S1 = session('11111111-1111-4222-8333-444444444444');
const S2 = session('22222222-1111-4222-8333-444444444444');
const S3 = session('33333333-1111-4222-8333-444444444444');
const list = [S1, S2, S3];

// 9. With nothing pinned the app's own order is returned untouched — not a copy, so an unpinned
//    list costs the render nothing.
assert.strictEqual(ccx.pinSort(list, pinState), list, 'no pins must leave the list exactly as it was');

// 10. A pin floats its row to the front and everything else keeps its order.
fromHost({ type: 'ccx:state', pinnedSessions: [S3.sessionId.value] });
fireTimers((t) => t.ms === 0);
assert.deepEqual(ccx.pinSort(list, pinState), [S3, S1, S2], 'a pinned session must come first');

// 11. Two pins keep the list's own recency order between them — pinning is not a second ordering.
fromHost({ type: 'ccx:state', pinnedSessions: [S3.sessionId.value, S1.sessionId.value] });
fireTimers((t) => t.ms === 0);
assert.deepEqual(ccx.pinSort(list, pinState), [S1, S3, S2], 'pinned rows keep the list order among themselves');

// 12. Under a search the app hands over only the rows that matched; a pinned row that did not match
//     is simply not there to float, and the ones that did keep the same rule.
assert.deepEqual(ccx.pinSort([S2, S3], pinState), [S3, S2], 'a filtered list is sorted by the same rule');
assert.deepEqual(ccx.pinSort([S2], pinState), [S2], 'a search that excludes every pin is left alone');

// 13. A pin id that matches nothing on screen must not reorder anything.
fromHost({ type: 'ccx:state', pinnedSessions: ['99999999-1111-4222-8333-444444444444'] });
fireTimers((t) => t.ms === 0);
assert.strictEqual(ccx.pinSort(list, pinState), list, 'a pin for an absent session changes nothing');

// 14. A state push that repeats the list must not re-render it — the Set identity is the signal.
const before = pinPushes.length;
fromHost({ type: 'ccx:state', pinnedSessions: ['99999999-1111-4222-8333-444444444444'] });
fireTimers((t) => t.ms === 0);
assert.equal(pinPushes.length, before, 'an unchanged pinned list must not push new state');

// 15. The row mark: a history row gets a pin control carrying its own session id, and the control
//     reports the current state so CSS can keep a pinned row lit once the pointer leaves.
const PINNED = '11111111-1111-4222-8333-444444444444';
const UNPINNED = '22222222-1111-4222-8333-444444444444';
function fakeRow(id) {
    const row = new El('button');
    row.className = 'sessionItem_OOQiHg';
    // What sessionIdOfRow actually reads: the fiber key, which is the session id at the call site
    row['__reactFiber$abc123'] = { key: id, memoizedProps: {}, return: null };
    return row;
}
const pinnedRow = fakeRow(PINNED);
const plainRow = fakeRow(UNPINNED);
rows = [pinnedRow, plainRow];
fromHost({ type: 'ccx:state', pinnedSessions: [PINNED] });
fireTimers((t) => t.ms === 0);

const pinOf = (row) => row.children.find((c) => c.className === 'ccx-pin') || null;
assert.ok(pinOf(pinnedRow), 'a resolved row must get a pin control');
assert.equal(pinOf(pinnedRow).dataset.ccxSession, PINNED, 'the control must carry its own row id');
assert.equal(pinOf(pinnedRow).dataset.ccxPinned, '1');
assert.equal(pinOf(plainRow).dataset.ccxPinned, '0');
assert.equal(pinOf(pinnedRow), pinnedRow.lastElementChild, 'the control belongs past the time column');

// 16. A second pass over the same rows must not add a second control.
fromHost({ type: 'ccx:state', pinnedSessions: [PINNED] });
assert.equal(pinnedRow.children.filter((c) => c.className === 'ccx-pin').length, 1, 'the control must not duplicate');

// 17. A row whose session id cannot be resolved gets nothing: pinning the wrong session is worse
//     than not offering it, the same rule the provider icon follows.
const unresolved = new El('button');
unresolved.className = 'sessionItem_OOQiHg';
rows = [unresolved];
fromHost({ type: 'ccx:state', pinnedSessions: [PINNED] });
assert.equal(pinOf(unresolved), null, 'an unresolved row must not offer a pin');

// 18. Clicking the control tells the host, and moves the row before the answer comes back — a pin
//     that waited for the round trip would look like a dropped click.
rows = [pinnedRow, plainRow];
posted.length = 0;
const stop = { calls: 0 };
const clickEvent = { preventDefault: () => stop.calls++, stopPropagation: () => stop.calls++ };
pinOf(plainRow).onclick(clickEvent);
assert.equal(stop.calls, 2, 'the click must not reach the row button underneath');
const sent = posted.filter((m) => m.type === 'ccx:pinSession');
assert.deepEqual(sent, [{ type: 'ccx:pinSession', sessionId: UNPINNED, pinned: true }]);
assert.deepEqual(ccx.pinSort([session(PINNED), session(UNPINNED)], pinState).map((s) => s.sessionId.value), [
    PINNED,
    UNPINNED,
]);
assert.equal(pinOf(plainRow).dataset.ccxPinned, '1', 'the mark must flip on the click, not on the answer');

// 19. Clicking again unpins, and the host is told exactly that.
posted.length = 0;
pinOf(plainRow).onclick(clickEvent);
assert.deepEqual(posted.filter((m) => m.type === 'ccx:pinSession'), [
    { type: 'ccx:pinSession', sessionId: UNPINNED, pinned: false },
]);

// 20. The host's answer is what settles it: a pin the host refused to keep goes away again.
fromHost({ type: 'ccx:state', pinnedSessions: [] });
fireTimers((t) => t.ms === 0);
assert.equal(pinOf(plainRow).dataset.ccxPinned, '0');
assert.equal(pinOf(pinnedRow).dataset.ccxPinned, '0');

// 21. A state push with no pinned field at all (an older host) leaves the page's own copy alone
//     rather than clearing every pin.
fromHost({ type: 'ccx:state', pinnedSessions: [PINNED] });
fireTimers((t) => t.ms === 0);
fromHost({ type: 'ccx:state' });
assert.equal(pinOf(pinnedRow).dataset.ccxPinned, '1', 'a missing field is not an empty list');

console.log('OK — the page sorts, marks and toggles pins without waiting for the host');

// --- Part 3: the wiring — the patcher must hand the component what the page relies on ---------

const patcher = readFileSync(new URL('../scripts/apply-patch.mjs', import.meta.url), 'utf8');
assert.ok(/onPinState\(ccxSetPinnedIds\)/.test(patcher), 'the pin state hook must be handed to onPinState');
assert.ok(/\[ccxPinnedIds,ccxSetPinnedIds\]=\$\{useState\}\(null\)/.test(patcher), 'the pin state pair must be declared');
assert.ok(/pinSort\(ccxL,ccxPinnedIds\)/.test(patcher), 'the rendered list must go through pinSort');
const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
assert.ok(/onPinState: onPinState/.test(page) && /pinSort: pinSort/.test(page), 'window.__ccx must expose both hooks');
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
assert.ok(/m\.type === 'ccx:pinSession'/.test(host), 'the host must answer ccx:pinSession');
assert.ok(/pinnedSessions: loadPinned\(\)/.test(host), 'every state push must carry the pinned list');
assert.ok(/function forgetPinned/.test(host), 'a deleted session must be able to lose its pin');

console.log('\nOK — pinned sessions float to the top of the history list');
process.exit(0);
