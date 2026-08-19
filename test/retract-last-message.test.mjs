// "Retract last message" replaces the stock fork-rewind: instead of forking the session it hides the
// erroneous message (and the assistant's answer to it) from the transcript and tells the agent — under
// the hood, in a hidden user turn — that the message was a mistake. This drives the real webview.js in
// a minimal DOM with a fake session and checks what is sent, what is hidden, and that a busy or empty
// transcript fails gracefully.
//   node test/retract-last-message.test.mjs
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
    removeAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0 }; }
}
const body = new El('body');
const head = new El('head');
// The composer is a contenteditable. The retract fill writes textContent directly (mirroring the app's
// own setInputText), so the fake needs no execCommand for that path; the leftover execCommand fake
// still backs the attachment/resume/quote inserts. dispatchEvent records the synthetic input event the
// page fires after the fill to sync the app's draft signal (without it, the app's "clear when the
// draft is empty" effect would wipe the fill).
const composerInputs = [];
const composer = new El('div');
composer.focus = () => {};
composer.dispatchEvent = (evt) => { composerInputs.push(evt); return true; };
const document = {
    body, head,
    createElement: (t) => new El(t),
    querySelector: (sel) => (sel === '[role="textbox"][aria-label="Message input"]' ? composer : null),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (cmd, _unused, value) => {
        if (cmd === 'delete') { composer.textContent = ''; return true; }
        if (cmd === 'insertText') { composer.textContent += value; return true; }
        if (cmd === 'insertLineBreak') { composer.textContent += '\n'; return true; }
        return true;
    },
};
const timers = [];
const window = {
    document,
    addEventListener() {}, removeEventListener() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {}, rangeCount: 1 }),
    innerWidth: 1000, innerHeight: 800,
    setTimeout: (fn, ms) => { const t = { fn, ms, fired: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
};
window.window = window;
const posted = [];
let listener = null;
window.addEventListener = (type, fn) => { if (type === 'message') listener = fn; };
// A minimal event constructor so the page's `new InputEvent('input', {...})` (and its Event
// fallback) do not throw in the vm.
class Ev {
    constructor(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); }
}
const context = {
    window, document, console,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    Event: Ev,
    InputEvent: Ev,
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), context);
const ccx = context.window.__ccx;
assert.ok(ccx && typeof ccx.retract === 'function', 'page did not expose window.__ccx.retract');
assert.ok(listener, 'page did not register a message listener');
const fromHost = (m) => listener({ data: m });

// --- fake app: registry, connection, active session --------------------------------------------
// The page reads message text through messageText(), which expects the app's real shape: a message's
// `content` is an array of block wrappers (class Bp), each wrapping the raw block at `.content`
// ({type:"text", text}). A flat {type,text} here would silently read as no text — the very bug the
// retract test exists to catch.
const sends = [];
const messages = [
    { type: 'user', uuid: 'u1', content: [{ content: { type: 'text', text: 'wrong command' } }] },
    { type: 'assistant', uuid: 'a1', content: [{ content: { type: 'text', text: 'done' } }] },
];
const session = {
    messages: { value: messages },
    busy: { value: false },
    lastServedModel: { value: 'x' },
    // The real send() appends the user turn to messages.value before the CLI answers — mirror that.
    send: (text) => {
        sends.push(text);
        session.messages.value.push({ type: 'user', uuid: 'u-instr', content: [{ content: { type: 'text', text } }] });
        return Promise.resolve();
    },
};
const host = {
    commandRegistry: { registerAction() {}, subscribe() {}, executeCommand() {}, commandActions: new Map() },
    comms: { connection: { value: { launchClaude: () => {} } } },
};
ccx.onRegistry(host, () => null, session);

// The page learns its session id from ccx:state (and ccx:apply / ccx:session); establish it first so
// the retract's ccx:hideMessages carries the real id and the hidden set is not reset mid-test.
fromHost({ type: 'ccx:state', sessionId: 'sess-1', hiddenMessages: [] });

function toasts() { return body.children.filter((c) => c.className === 'ccx-toast'); }
function hidePosts() { return posted.filter((m) => m.type === 'ccx:hideMessages'); }
function reset() {
    sends.length = 0;
    posted.length = 0;
    body.children.length = 0;
    composer.textContent = '';
    composerInputs.length = 0;
    session.messages.value = [
        { type: 'user', uuid: 'u1', content: [{ content: { type: 'text', text: 'wrong command' } }] },
        { type: 'assistant', uuid: 'a1', content: [{ content: { type: 'text', text: 'done' } }] },
    ];
    session.busy.value = false;
}

// 1. Retract sends the English "ignore it" instruction, puts the message back in the composer, and
//    persists the failed exchange's uuids.
reset();
ccx.retract();
assert.equal(sends.length, 1, 'must send the instruction');
assert.ok(
    /^The message «wrong command» was a mistake — ignore it and your response to it\.$/.test(sends[0]),
    'the instruction must be English and quote the retracted message',
);
assert.equal(composer.textContent, 'wrong command', 'the retracted message must go back into the composer');
assert.equal(composerInputs.length, 1, 'the fill must fire a synthetic input so the draft signal syncs');
assert.deepEqual(hidePosts().map((m) => m.uuids), [['u1', 'a1']], 'must hide the message and its answer');
assert.equal(hidePosts()[0].sessionId, 'sess-1', 'the hide must name the session');

// 2. The instruction's own turn is hidden the moment applyHidden resolves it.
fromHost({ type: 'ccx:state', sessionId: 'sess-1', hiddenMessages: [] });
const all = hidePosts();
assert.equal(all.length, 2, 'the instruction uuid must be persisted on top of the exchange');
assert.deepEqual(all[1].uuids, ['u-instr'], 'the second hide must be the instruction turn');

// 2b. The assistant's answer to the instruction is hidden too — otherwise it would dangle as an
//     orphan reply to a turn nothing renders.
session.messages.value.push({ type: 'assistant', uuid: 'a2', content: [{ content: { type: 'text', text: 'Understood' } }] });
fromHost({ type: 'ccx:state', sessionId: 'sess-1', hiddenMessages: [] });
const ans = hidePosts();
assert.equal(ans.length, 3, 'the instruction answer must be hidden as well');
assert.deepEqual(ans[2].uuids, ['a2'], 'the third hide must be the instruction answer');

// 3. A busy session refuses with a toast and sends nothing.
reset();
session.busy.value = true;
ccx.retract();
assert.equal(sends.length, 0, 'must not send while a turn is running');
assert.equal(hidePosts().length, 0, 'must not hide while a turn is running');
assert.ok(toasts().length, 'a busy session must explain itself');

// 4. A transcript with no user message has nothing to retract.
reset();
session.messages.value = [{ type: 'assistant', uuid: 'a1', content: [{ content: { type: 'text', text: 'done' } }] }];
ccx.retract();
assert.equal(sends.length, 0, 'must not send with no user message');
assert.ok(toasts().length, 'an empty transcript must explain itself');

// 5. The wiring: the retract gesture must go through the session, not the stock rewind action.
const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
assert.ok(!/executeCommand\(REWIND_ACTION\)|openRewind|rewindAvailable/.test(page), 'no stock rewind dependency may remain');
assert.ok(/retract: retractLastMessage/.test(page), 'retract must be exposed on window.__ccx');

console.log('\nOK — retract hides the failed exchange, instructs the agent, and fails gracefully');
