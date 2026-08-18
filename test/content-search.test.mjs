// The stock session search box only matches a row's title and git branch, both already in the page.
// Finding a session by something that was actually SAID needs the transcript itself, which the page
// does not hold — so that half runs on the host: it greps the .jsonl file for whichever session ids
// the page currently has on screen. Two things are checked here: that the host answers a
// ccx:searchContent request correctly (real files, real matching), and that the page (src/webview.js)
// debounces the request and never lets a stale answer overwrite a newer query's result.
//   node test/content-search.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// --- Part 1: the host side — real transcript files on disk ------------------------------------

const home = join(tmpdir(), `ccx-search-${process.pid}`);
const projects = join(home, '.claude', 'projects', 'c--some-workspace');
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(projects, { recursive: true });
mkdirSync(runtime, { recursive: true });
// renderScript() reads this file to build the injected <script> — without it it fails closed (empty
// string) and never even calls attachWebview, which would make every assertion below fail silently.
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
const copy = join(tmpdir(), `ccx-host-search-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const AUTH = 'aaaaaaaa-1111-4222-8333-444444444444';
const LOGIN = 'bbbbbbbb-1111-4222-8333-444444444444';
const GARBAGE = '../../etc/passwd';
writeFileSync(
    join(projects, `${AUTH}.jsonl`),
    '{"type":"user","message":{"content":"please refactor the AUTH module"}}\n',
);
writeFileSync(
    join(projects, `${LOGIN}.jsonl`),
    '{"type":"user","message":{"content":"there is a bug in the login form"}}\n',
);

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

// 1. A query matches only the session whose transcript actually contains it, case-insensitively, and
//    a stray id from a garbage sessionIds entry is skipped rather than thrown on.
let t = fakeWebview();
t.posted.length = 0;
t.send({ type: 'ccx:searchContent', query: 'auth module', sessionIds: [AUTH, LOGIN, GARBAGE], seq: 42 });
let result = t.posted.find((m) => m.type === 'ccx:searchResults');
assert.ok(result, 'no ccx:searchResults was posted');
assert.equal(result.seq, 42, 'the response must echo the request it answers');
assert.deepEqual(result.matches, [AUTH], 'only the session whose transcript contains the query should match');

// 2. A query nobody's transcript contains comes back empty, not an error.
t.posted.length = 0;
t.send({ type: 'ccx:searchContent', query: 'nonexistent phrase', sessionIds: [AUTH, LOGIN], seq: 1 });
result = t.posted.find((m) => m.type === 'ccx:searchResults');
assert.deepEqual(result.matches, [], 'no match anywhere must come back as an empty list');

// 3. An id with no transcript on disk at all is silently skipped, same as garbage.
const MISSING = 'cccccccc-1111-4222-8333-444444444444';
t.posted.length = 0;
t.send({ type: 'ccx:searchContent', query: 'login', sessionIds: [MISSING, LOGIN], seq: 2 });
result = t.posted.find((m) => m.type === 'ccx:searchResults');
assert.deepEqual(result.matches, [LOGIN]);

console.log('OK — the host greps only the requested transcripts and echoes the request back');

rmSync(home, { recursive: true, force: true });

// --- Part 2: the page side — debounce, staleness, and clearing on every keystroke -------------

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
const document2 = {
    body, head,
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: () => [],
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
const posted2 = [];
let listener2 = null;
window2.addEventListener = (type, fn) => { if (type === 'message') listener2 = fn; };
const context2 = {
    window: window2, document: document2, console,
    setTimeout: window2.setTimeout, clearTimeout: window2.clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted2.push(m), getState: () => ({}), setState() {} }),
};
context2.globalThis = context2;
vm.createContext(context2);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), context2);
const ccx = context2.window.__ccx;
assert.ok(typeof ccx.onSearchState === 'function', 'page did not expose onSearchState');
assert.ok(typeof ccx.onSearchQuery === 'function', 'page did not expose onSearchQuery');

function fireTimers(pred) { for (const t of timers) if (!t.fired && !t.cleared && pred(t)) { t.fired = true; t.fn(); } }
const fromHost = (m) => listener2({ data: m });

const setterCalls = [];
ccx.onSearchState((matches) => setterCalls.push(matches));

// 4. Typing clears any previous result immediately (before the debounce even starts) and does not
//    send anything until the debounce settles.
posted2.length = 0;
setterCalls.length = 0;
ccx.onSearchQuery('auth', ['id-1', 'id-2']);
assert.deepEqual(setterCalls, [null], 'a new query must clear the previous result right away');
assert.equal(posted2.filter((m) => m.type === 'ccx:searchContent').length, 0, 'must not fire before the debounce settles');
fireTimers((t) => t.ms === 250);
const sent = posted2.filter((m) => m.type === 'ccx:searchContent');
assert.equal(sent.length, 1);
assert.equal(sent[0].query, 'auth');
assert.deepEqual(sent[0].sessionIds, ['id-1', 'id-2']);

// 5. The host's answer reaches the setter as a Set. Not `instanceof Set` — the Set was built inside
//    the vm context's own realm, a different Set constructor than this module's, so that check would
//    fail even on a correct answer; `.has` is what the page actually calls, so that is what is real.
fromHost({ type: 'ccx:searchResults', seq: sent[0].seq, matches: ['id-1'] });
const firstAnswer = setterCalls.at(-1);
assert.ok(firstAnswer && typeof firstAnswer.has === 'function' && firstAnswer.has('id-1'), 'a real answer must reach the setter as a Set');

// 6. An empty query clears the result and never reaches the host at all.
posted2.length = 0;
setterCalls.length = 0;
ccx.onSearchQuery('', ['id-1']);
assert.deepEqual(setterCalls, [null]);
fireTimers((t) => !t.fired);
assert.equal(posted2.filter((m) => m.type === 'ccx:searchContent').length, 0, 'an empty query must never be sent to the host');

// 7. A stale answer — one that lost the race to a newer query — must not overwrite the newer result.
posted2.length = 0;
setterCalls.length = 0;
ccx.onSearchQuery('first', ['id-1']);
fireTimers((t) => t.ms === 250);
const firstReq = posted2.filter((m) => m.type === 'ccx:searchContent').at(-1);
ccx.onSearchQuery('second', ['id-1']);
fireTimers((t) => t.ms === 250);
const secondReq = posted2.filter((m) => m.type === 'ccx:searchContent').at(-1);
assert.notEqual(firstReq.seq, secondReq.seq, 'each query must carry its own sequence number');
setterCalls.length = 0;
fromHost({ type: 'ccx:searchResults', seq: firstReq.seq, matches: ['id-1'] });
assert.deepEqual(setterCalls, [], 'a stale answer for an abandoned query must be dropped');
fromHost({ type: 'ccx:searchResults', seq: secondReq.seq, matches: ['id-1'] });
assert.equal(setterCalls.length, 1, 'the current query answer must still go through');

console.log('OK — the page debounces content search and never applies a stale answer');

// --- Part 3: the wiring itself — the patcher must expose what the page relies on, and vice versa ----

const patcher = readFileSync(new URL('../scripts/apply-patch.mjs', import.meta.url), 'utf8');
assert.ok(/onSearchState\(ccxSetContentMatches\)/.test(patcher), 'the state hook must be handed to onSearchState');
assert.ok(/onSearchQuery\(\$\{param\}\.target\.value/.test(patcher), 'the search input must forward every keystroke');
assert.ok(/globalThis\.__ccxSearchCandidates/.test(patcher), 'the candidate id list must be exposed for the onChange hook');
const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
assert.ok(/onSearchState: onSearchState/.test(page) && /onSearchQuery: onSearchQuery/.test(page), 'window.__ccx must expose both hooks');
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
assert.ok(/m\.type === 'ccx:searchContent'/.test(host), 'the host must answer ccx:searchContent');
assert.ok(/function searchTranscripts/.test(host), 'the host must grep the requested transcripts');

console.log('\nOK — session search matches by content as well as by title');
process.exit(0);
