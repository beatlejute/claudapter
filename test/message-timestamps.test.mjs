// A message bubble carries its transcript timestamp only on the React fiber of the component that
// rendered it (`message.timestamp` — same shape as the .jsonl line it came from), not anywhere in the
// DOM or in ccx:state. decorateTranscript() reads it the same way the session-list icons read the
// session id off a row's fiber, and writes it back as data-ccx-time / data-ccx-date so a CSS
// pseudo-element can show it — chosen specifically so a re-render of the bubble (an assistant message
// keeps re-rendering while it streams) cannot wipe an injected child node.
//   node test/message-timestamps.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

// --- a DOM with just enough querySelectorAll to answer decorateTranscript()'s one selector --------
const TRANSCRIPT_SELECTOR = '[data-testid="assistant-message"], [class*="userMessageContainer_"]';

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this.textContent = '';
        this.dataset = {};
        this.attrs = {};
        this.parentElement = null;
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
}

// What the page actually renders into a bubble, by class name
const labelOf = (node, className) => node.children.find((c) => c.className === className) || null;

// The registry decorateTranscript() actually walks — nodes pushed here in document order, exactly
// what querySelectorAll(TRANSCRIPT_SELECTOR) would return in the real page.
let transcriptNodes = [];
const body = new El('body');
const head = new El('head');
const document2 = {
    body, head,
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === TRANSCRIPT_SELECTOR ? transcriptNodes.slice() : []),
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
let listener2 = null;
window2.addEventListener = (type, fn) => { if (type === 'message') listener2 = fn; };
const context2 = {
    window: window2, document: document2, console, Intl,
    setTimeout: window2.setTimeout, clearTimeout: window2.clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
context2.globalThis = context2;
vm.createContext(context2);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), context2);
assert.ok(listener2, 'page did not register a message listener');
const fromHost = (m) => listener2({ data: m });

// A bubble's `message` prop lives one level up from the host div's own fiber — the component fiber
// that actually received {session, message, index, ...} in JSX — exactly like sessionIdOfRow walks up
// for `.session`. The host fiber itself carries only DOM props (className etc), never `message`.
//
// The object built here carries the full transcript-message shape (type/uuid/content/timestamp), not
// just a timestamp: isTranscriptMessage() checks all of it, because a bare 'timestamp' in message test
// also matched unrelated objects further up the tree and put the same near-current time on every bubble.
let uuidCounter = 0;
function transcriptMessage(type, timestamp) {
    const message = { type, uuid: `uuid-${++uuidCounter}`, content: [] };
    if (timestamp !== undefined) message.timestamp = timestamp;
    return message;
}

function messageNode(message) {
    const node = new El('div');
    if (message && message.type === 'assistant') node.setAttribute('data-testid', 'assistant-message');
    else node.className = 'userMessageContainer_07S1Yg';
    const componentFiber = { memoizedProps: { message }, return: null };
    const hostFiber = { memoizedProps: { className: node.className }, return: componentFiber };
    node['__reactFiber$abc123'] = hostFiber;
    return node;
}

function formatTime(date) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

// 1. A message with a real timestamp gets data-ccx-time, formatted the same way the page does — and
//    being the first (only) message, also opens with a date separator.
transcriptNodes = [messageNode(transcriptMessage('user', '2026-08-18T10:53:07.156Z'))];
fromHost({ type: 'ccx:state', profiles: [], active: null });
const first = transcriptNodes[0];
assert.equal(first.dataset.ccxTime, formatTime(new Date('2026-08-18T10:53:07.156Z')), 'time must match Intl formatting of the message timestamp');
assert.ok(first.dataset.ccxDate, 'the first message in the transcript must open with a date separator');

// 2. A second message the same day must NOT repeat the separator, but every message — including this
//    one, right after the one that opened the day — still gets its own time. There is no run-collapsing
//    here: a corner-anchored label doesn't cost a line the way a full-width one would, so nothing needs
//    hiding to keep a run of bubbles readable.
const sameDay = messageNode(transcriptMessage('assistant', '2026-08-18T11:10:00.000Z'));
transcriptNodes = [first, sameDay];
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.ok(!sameDay.dataset.ccxDate, 'a same-day message must not get its own date separator');
assert.equal(sameDay.dataset.ccxTime, formatTime(new Date('2026-08-18T11:10:00.000Z')));
assert.ok(first.dataset.ccxTime, 'every message keeps its own time, including this one\'s neighbour');

// 3. A message the NEXT day gets its own separator, and it reads "yesterday" relative to a message
//    exactly 26h later (so both the day and the wall-clock hour differ, ruling out an off-by-time-of-day
//    match) — computed via the same Intl call the page uses, so this does not hardcode English wording.
const day1 = new Date('2026-08-18T09:00:00.000Z');
const day2 = new Date(day1.getTime() + 26 * 3600 * 1000); // next calendar day, different hour
const a = messageNode(transcriptMessage('user', day1.toISOString()));
const b = messageNode(transcriptMessage('user', day2.toISOString()));
transcriptNodes = [a, b];
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.ok(a.dataset.ccxDate && b.dataset.ccxDate, 'both messages open a new day here');
assert.notEqual(a.dataset.ccxDate, b.dataset.ccxDate, 'two different calendar days must not share a label');

// 3b. A whole turn — a thinking summary, two tool calls, the final text — renders as several
//     consecutive assistant bubbles. Every one of them still gets its own time: the corner label costs
//     no extra line, so there is nothing to collapse the way a full-width one would have needed.
const thinking = messageNode(transcriptMessage('assistant', '2026-08-19T09:00:00.000Z'));
const toolA = messageNode(transcriptMessage('assistant', '2026-08-19T09:00:01.000Z'));
const toolB = messageNode(transcriptMessage('assistant', '2026-08-19T09:00:02.000Z'));
const answer = messageNode(transcriptMessage('assistant', '2026-08-19T09:00:39.000Z'));
transcriptNodes = [thinking, toolA, toolB, answer];
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.equal(thinking.dataset.ccxTime, formatTime(new Date('2026-08-19T09:00:00.000Z')), 'every bubble in a same-speaker run keeps its own time');
assert.equal(toolA.dataset.ccxTime, formatTime(new Date('2026-08-19T09:00:01.000Z')));
assert.equal(toolB.dataset.ccxTime, formatTime(new Date('2026-08-19T09:00:02.000Z')));
assert.equal(answer.dataset.ccxTime, formatTime(new Date('2026-08-19T09:00:39.000Z')));

// 4. No timestamp on the message (a synthetic/local entry) — decorated with nothing, and it must not
//    throw or leave a stale attribute from an earlier pass.
const withDate = messageNode(transcriptMessage('user', '2026-08-18T09:00:00.000Z'));
transcriptNodes = [withDate];
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.ok(withDate.dataset.ccxTime, 'sanity: the first pass did set a time');
withDate.dataset.ccxTime = 'stale';
withDate.dataset.ccxDate = 'stale';
transcriptNodes = [messageNode(transcriptMessage('user' /* no timestamp */))];
transcriptNodes[0].dataset.ccxTime = 'stale';
transcriptNodes[0].dataset.ccxDate = 'stale';
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.equal(transcriptNodes[0].dataset.ccxTime, undefined, 'a message with no timestamp must not keep a stale one');
assert.equal(transcriptNodes[0].dataset.ccxDate, undefined);

// 5. A node whose fiber has no `message` prop at all (unrelated component, or React internals changed)
//    is left alone rather than throwing and taking the whole decoration pass down with it.
const noProps = new El('div');
noProps['__reactFiber$xyz'] = { memoizedProps: { className: 'x' }, return: null };
transcriptNodes = [noProps];
assert.doesNotThrow(() => fromHost({ type: 'ccx:state', profiles: [], active: null }));
assert.equal(noProps.dataset.ccxTime, undefined);

// 6. The regression that made every bubble show the same near-current time: an ancestor carrying its own
//    `message` object that happens to have a `timestamp` field — a live status/notification object, say —
//    but none of the rest of a transcript message's shape. The walk must skip it and keep going for the
//    real one behind it, not stop at the first `timestamp` it happens to see.
const realMessage = transcriptMessage('assistant', '2026-08-19T08:00:00.000Z');
const impostor = { timestamp: new Date().toISOString(), state: 'connected' };
const decoy = new El('div');
decoy.setAttribute('data-testid', 'assistant-message');
const realFiber = { memoizedProps: { message: realMessage }, return: null };
const impostorFiber = { memoizedProps: { message: impostor }, return: realFiber };
decoy['__reactFiber$abc123'] = { memoizedProps: { className: '' }, return: impostorFiber };
transcriptNodes = [decoy];
fromHost({ type: 'ccx:state', profiles: [], active: null });
assert.equal(
    decoy.dataset.ccxTime,
    formatTime(new Date('2026-08-19T08:00:00.000Z')),
    'an ancestor object that merely has a timestamp must not be mistaken for the transcript message',
);

// 7. The real bug behind "every message shows the current time": the page's own message.timestamp is
//    worthless for replayed history — the message class defaults that field to Date.now() and history
//    rebuilt for a resume passes no timestamp, so every past message claims the moment the transcript
//    was reconstructed. The truth lives in the .jsonl, which the host reads and sends back keyed by
//    uuid; a uuid present there must win over whatever the in-page object claims.
const replayed = transcriptMessage('assistant', new Date().toISOString()); // "now", exactly as replay produces
const REAL_MS = Date.parse('2026-08-17T07:20:00.000Z');
const replayedNode = messageNode(replayed);
transcriptNodes = [replayedNode];
fromHost({ type: 'ccx:state', profiles: [], active: null, sessionId: 'sess-times' });
const asked = posted.filter((m) => m.type === 'ccx:timestamps');
assert.equal(asked.length, 1, 'the page must ask the host for the session\'s real timestamps');
assert.equal(asked[0].sessionId, 'sess-times');
fromHost({ type: 'ccx:timestampsResult', sessionId: 'sess-times', times: { [replayed.uuid]: REAL_MS } });
assert.equal(
    replayedNode.dataset.ccxTime,
    formatTime(new Date(REAL_MS)),
    'the transcript timestamp from disk must win over the page\'s replay-time default',
);

// 7b. A live turn is not in the file yet — that one keeps its in-page timestamp, which is genuine
//     because the object really was constructed when the message arrived.
const live = transcriptMessage('assistant', '2026-08-19T10:15:00.000Z');
const liveNode = messageNode(live);
transcriptNodes = [replayedNode, liveNode];
fromHost({ type: 'ccx:timestampsResult', sessionId: 'sess-times', times: { [replayed.uuid]: REAL_MS } });
assert.equal(replayedNode.dataset.ccxTime, formatTime(new Date(REAL_MS)), 'the known message still reads from disk');
assert.equal(
    liveNode.dataset.ccxTime,
    formatTime(new Date('2026-08-19T10:15:00.000Z')),
    'a message the file does not know yet falls back to its own timestamp',
);

// 8. A bubble that renders another matching container inside itself must be decorated once, not twice
//    — both nest to the same message, and decorating both printed one timestamp directly under another.
const outer = messageNode(transcriptMessage('assistant', '2026-08-19T11:00:00.000Z'));
const inner = messageNode(transcriptMessage('assistant', '2026-08-19T11:00:00.000Z'));
outer.appendChild(inner);
transcriptNodes = [outer, inner]; // document order: ancestor first, exactly as querySelectorAll returns
fromHost({ type: 'ccx:state', profiles: [], active: null, sessionId: 'sess-times' });
assert.ok(outer.dataset.ccxTime, 'the outermost container of a nest carries the timestamp');
assert.equal(inner.dataset.ccxTime, undefined, 'a nested container must not repeat its ancestor\'s timestamp');

// 9. The labels must be real child nodes, and the stylesheet must not generate content into either
//    pseudo-element of a message. Both slots belong to the app on an assistant bubble —
//    `.timelineMessage_:before` is the status dot, `.timelineMessage_:after` is the vertical timeline
//    rail — and writing to either replaces it, which is exactly how the rail was first stretched and
//    then lost entirely. This is invisible to a DOM test, so the stylesheet is read directly.
const labelled = messageNode(transcriptMessage('assistant', '2026-08-19T12:00:00.000Z'));
transcriptNodes = [labelled];
fromHost({ type: 'ccx:state', profiles: [], active: null, sessionId: 'sess-times' });
const timeLabel = labelOf(labelled, 'ccx-msg-time');
assert.ok(timeLabel, 'the time must be a real child node, not generated content');
assert.equal(timeLabel.textContent, formatTime(new Date('2026-08-19T12:00:00.000Z')));
assert.ok(labelOf(labelled, 'ccx-msg-date'), 'the date pill must be a real child node too');

const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
for (const forbidden of ['[data-ccx-time]::after', '[data-ccx-time]::before', '[data-ccx-date]::before', '[data-ccx-date]::after']) {
    assert.ok(
        !page.includes(forbidden),
        `${forbidden} would overwrite the app's own status dot or timeline rail — use a child node`,
    );
}

// 9b. A message that stops qualifying must have its labels removed, not just its attributes — a
//     leftover node would keep printing a stale time with nothing left to update it.
transcriptNodes = [messageNode(transcriptMessage('user' /* no timestamp */))];
transcriptNodes[0].appendChild(Object.assign(new El('span'), { className: 'ccx-msg-time', textContent: 'stale' }));
fromHost({ type: 'ccx:state', profiles: [], active: null, sessionId: 'sess-times' });
assert.equal(labelOf(transcriptNodes[0], 'ccx-msg-time'), null, 'a stale label must be removed, not left behind');

console.log('\nOK — transcript messages get chat-style timestamps and date separators');
process.exit(0);
