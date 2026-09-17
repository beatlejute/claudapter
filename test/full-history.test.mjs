// History before compaction. A compaction deletes nothing from the .jsonl — the page stops at the
// compact_boundary only because that line is written with `parentUuid: null`, and the walk that rebuilds a
// transcript follows parentUuid back from the newest message. With the switch on, the host joins every
// boundary back to the conversation it closed before that walk runs, and the page lifts its 600-message
// cap and keeps fork/rewind away from messages the model no longer has.
// Four things are checked: the host's stitch and switch, the stock walk itself taken from the installed
// bundle with the hook patched in, the page, and the patcher wiring between them.
//   node test/full-history.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path, { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// The installed extension is looked up before HOME is pointed at the sandbox below.
const EXTENSIONS_ROOT = join(homedir(), '.vscode', 'extensions');

// --- Part 1: the host — the switch on disk, and the stitch -------------------------------------

const home = join(tmpdir(), `ccx-history-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(runtime, { recursive: true });
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
const copy = join(tmpdir(), `ccx-host-history-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let host;
try {
    host = require(copy);
} finally {
    rmSync(copy, { force: true });
}
const HISTORY_FILE = join(runtime, 'full-history.json');

function fakeWebview() {
    const handlers = [];
    const posted = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    host.renderScript(webview, 'nonce');
    return { posted, send: (m) => handlers.forEach((fn) => fn(m)) };
}
const lastState = (t) => t.posted.filter((m) => m.type === 'ccx:state').at(-1);

// The shape the CLI writes: the part before the compaction, the kept tail (u3, a3), the boundary with no
// parent, the summary, and what came after. Every field the walk reads is the one on disk.
let seq = 0;
const at = () => new Date(Date.UTC(2026, 8, 1, 10, seq++)).toISOString();
const user = (uuid, parentUuid, text, extra) => ({
    type: 'user', uuid, parentUuid, sessionId: 's', timestamp: at(), isSidechain: false,
    message: { role: 'user', content: text }, ...extra,
});
const assistant = (uuid, parentUuid, text) => ({
    type: 'assistant', uuid, parentUuid, sessionId: 's', timestamp: at(), isSidechain: false,
    message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] },
});
function transcript() {
    seq = 0;
    return [
        user('u1', null, 'first'),
        assistant('a1', 'u1', 'one'),
        user('u2', 'a1', 'second'),
        assistant('a2', 'u2', 'two'),
        user('u3', 'a2', 'kept prompt'),
        assistant('a3', 'u3', 'kept answer'),
        {
            type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, logicalParentUuid: 'a3',
            sessionId: 's', timestamp: at(), isSidechain: false,
            compactMetadata: {
                trigger: 'auto', preTokens: 160000,
                preservedSegment: { headUuid: 'u3', anchorUuid: 's1', tailUuid: 'a3' },
                preservedMessages: { anchorUuid: 's1', uuids: ['u3', 'a3'], allUuids: ['u3', 'a3'] },
            },
        },
        user('s1', 'b1', 'This session is being continued from a previous conversation…', {
            isCompactSummary: true, isVisibleInTranscriptOnly: true,
        }),
        user('u4', 's1', 'after'),
        assistant('a4', 'u4', 'four'),
    ];
}
const byUuid = (rows) => new Map(rows.map((r) => [r.uuid, r]));

// 1. Off by default: no file, the state push says false, and the map is left exactly as read.
{
    const t = fakeWebview();
    assert.equal(lastState(t).historyBeforeCompaction, false, 'the switch starts off');
    const map = byUuid(transcript());
    assert.equal(host.stitchCompactions(map), 0, 'nothing is stitched while the switch is off');
    assert.equal(map.get('b1').parentUuid, null, 'the boundary keeps its null parent while off');
    assert.equal(host.historyBeforeCompaction(), false);

    // 2. The menu message writes the file and every tab hears about it.
    t.posted.length = 0;
    t.send({ type: 'ccx:historyBeforeCompaction', enabled: true });
    assert.deepEqual(JSON.parse(readFileSync(HISTORY_FILE, 'utf8')), { enabled: true }, 'the switch survives on disk');
    assert.equal(lastState(t).historyBeforeCompaction, true, 'the new value reaches the page without being asked');
    assert.equal(host.historyBeforeCompaction(), true);
}

// 3. On: the boundary is joined to what came before the kept tail — not to logicalParentUuid, which is the
//    tail itself and would lead the walk back into it.
{
    const rows = transcript();
    const map = byUuid(rows);
    assert.equal(host.stitchCompactions(map), 1);
    assert.equal(map.get('b1').parentUuid, 'a2', 'the boundary follows the message before the kept tail');
    assert.equal(rows[6].parentUuid, null, 'the line as read is not mutated — the map gets a copy');
}

// 4. A kept list with a uuid missing from the map is not relinked by the stock walk either, so the tail
//    stays in place and logicalParentUuid is the right link.
{
    const map = byUuid(transcript());
    const b1 = map.get('b1');
    map.set('b1', { ...b1, compactMetadata: { ...b1.compactMetadata, preservedMessages: { anchorUuid: 's1', uuids: ['u3', 'gone'] } } });
    host.stitchCompactions(map);
    assert.equal(map.get('b1').parentUuid, 'a3', 'an unrelinked tail is followed through logicalParentUuid');
}

// 5. Nothing to join to: the part before was never read, or the kept tail opens the transcript.
{
    const map = byUuid(transcript().filter((r) => !['u1', 'a1', 'u2', 'a2', 'u3', 'a3'].includes(r.uuid)));
    assert.equal(host.stitchCompactions(map), 0, 'a boundary whose past is not in the map is left alone');
    const head = byUuid(transcript());
    head.set('u3', { ...head.get('u3'), parentUuid: null });
    assert.equal(host.stitchCompactions(head), 0, 'a kept tail with nothing before it has nothing to show');
    assert.equal(host.stitchCompactions(null), 0, 'garbage is not a map');
}

console.log('OK — the host keeps the switch on disk and joins a boundary to what preceded the kept tail');

// --- Part 2: the stock walk from the installed bundle, with the hook patched in ----------------
//
// The stitch only means something against the walk it feeds, and that walk is Anthropic's code: the
// relink of the kept tail, the leaf choice, the loop guard. A hand-written stand-in would only prove that
// the stand-in agrees. So the patcher runs over a copy of the real bundle, and the patched walk is lifted
// out of it along with whatever it calls.

function cleanExtension() {
    let obsolete = {};
    try {
        obsolete = JSON.parse(readFileSync(join(EXTENSIONS_ROOT, '.obsolete'), 'utf8')) || {};
    } catch {}
    const version = (name) => (name.match(/-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const dir = readdirSync(EXTENSIONS_ROOT)
        .filter((name) => name.startsWith('anthropic.claude-code-') && !obsolete[name])
        .sort((a, b) => {
            const [x, y] = [version(a), version(b)];
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        })
        .pop();
    assert.ok(dir, `no Claude Code extension under ${EXTENSIONS_ROOT} — the stock walk cannot be exercised`);
    const pick = (rel) => {
        const file = join(EXTENSIONS_ROOT, dir, rel);
        return existsSync(`${file}.ccx-orig`) ? `${file}.ccx-orig` : file;
    };
    return { dir, extension: pick('extension.js'), webview: pick(join('webview', 'index.js')) };
}

// Balanced braces from the first `{` after the parameter list, skipping string and template contents.
function functionAt(src, start) {
    let i = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw Error('unbalanced function body');
}

function definitionOf(src, name) {
    const escaped = name.replace(/\$/g, '\\$');
    const fn = new RegExp(`(?:async )?function ${escaped}\\(`).exec(src);
    if (fn && !/[\w$]/.test(src[fn.index - 1])) return functionAt(src, fn.index);
    const value = new RegExp(`(?<![\\w$.])${escaped}=(\\d+|"[^"]*"|![01])[,;]`).exec(src);
    if (value) return `var ${name}=${value[1]};`;
    throw Error(`cannot find ${name} in the bundle`);
}

const stock = cleanExtension();
const fixture = join(tmpdir(), `ccx-history-bundle-${process.pid}`, path.basename(stock.dir));
mkdirSync(join(fixture, 'webview'), { recursive: true });
copyFileSync(stock.extension, join(fixture, 'extension.js'));
copyFileSync(stock.webview, join(fixture, 'webview', 'index.js'));
const patcher = new URL('../scripts/apply-patch.mjs', import.meta.url);
const run = spawnSync(process.execPath, [patcher.pathname.replace(/^\/([A-Za-z]:)/, '$1'), `--dir=${fixture}`], {
    encoding: 'utf8',
    env: { ...process.env, CCX_NO_UPSTREAM_CHECK: '1' },
});
assert.equal(run.status, 0, `the patcher failed on the installed bundle:\n${run.stdout}${run.stderr}`);
const patched = readFileSync(join(fixture, 'extension.js'), 'utf8');
const patchedPage = readFileSync(join(fixture, 'webview', 'index.js'), 'utf8');
rmSync(path.dirname(fixture), { recursive: true, force: true });

const hook = patched.indexOf('stitchCompactions(');
assert.ok(hook !== -1, 'the walk carries no stitch hook');
assert.equal(patched.split('stitchCompactions(').length - 1, 2, 'both copies of the walk are hooked');
assert.equal(patched.split('historyBeforeCompaction()').length - 1, 2, 'both readers ask before skipping to the last boundary');
const walkStart = patched.lastIndexOf('async function ', hook);
const walkName = /^async function ([\w$]+)\(/.exec(patched.slice(walkStart))[1];

const walkContext = {
    setImmediate, Promise, Map, Set, Error, console,
    require: (id) => (id === 'path' ? path : id === 'os' ? { homedir: () => home } : host),
};
vm.createContext(walkContext);
vm.runInContext(functionAt(patched, walkStart), walkContext);
const loaded = new Set([walkName]);

async function walk(rows) {
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            return await walkContext[walkName](rows.map((r) => ({ ...r })));
        } catch (e) {
            // Thrown from inside the vm context, so it is that context's ReferenceError, not this one's
            const missing = e && typeof e.message === 'string' && /^([\w$]+) is not defined$/.exec(e.message);
            if (!missing || loaded.has(missing[1])) throw e;
            loaded.add(missing[1]);
            vm.runInContext(definitionOf(patched, missing[1]), walkContext);
        }
    }
    throw Error('the walk kept asking for more of the bundle');
}

const ids = (chain) => chain.map((r) => r.uuid);

writeFileSync(HISTORY_FILE, JSON.stringify({ enabled: false }));
const before = ids(await walk(transcript()));
assert.deepEqual(before, ['b1', 's1', 'u3', 'a3', 'u4', 'a4'], 'off: the stock walk starts at the boundary');

writeFileSync(HISTORY_FILE, JSON.stringify({ enabled: true }));
const after = ids(await walk(transcript()));
assert.deepEqual(
    after,
    ['u1', 'a1', 'u2', 'a2', 'b1', 's1', 'u3', 'a3', 'u4', 'a4'],
    'on: everything before the compaction leads in, and the kept tail is shown once, after the summary',
);
assert.deepEqual(after.slice(-before.length), before, 'what the stock walk showed is untouched at the end');

// Two compactions: the second boundary's kept tail starts right after the first summary's own kept tail.
{
    const rows = transcript();
    rows.push(
        user('u5', 'a4', 'kept again'),
        assistant('a5', 'u5', 'kept again answer'),
        {
            type: 'system', subtype: 'compact_boundary', uuid: 'b2', parentUuid: null, logicalParentUuid: 'a5',
            sessionId: 's', timestamp: at(), isSidechain: false,
            compactMetadata: {
                trigger: 'manual', preTokens: 90000,
                preservedSegment: { headUuid: 'u5', anchorUuid: 's2', tailUuid: 'a5' },
                preservedMessages: { anchorUuid: 's2', uuids: ['u5', 'a5'], allUuids: ['u5', 'a5'] },
            },
        },
        user('s2', 'b2', 'This session is being continued…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
        user('u6', 's2', 'latest'),
        assistant('a6', 'u6', 'six'),
    );
    const chain = ids(await walk(rows));
    assert.deepEqual(
        chain,
        ['u1', 'a1', 'u2', 'a2', 'b1', 's1', 'u3', 'a3', 'u4', 'a4', 'b2', 's2', 'u5', 'a5', 'u6', 'a6'],
        'every compaction is crossed, each kept tail once',
    );
}

console.log(`OK — the stock walk (${walkName}) crosses every compaction once the boundary is stitched`);

// --- Part 3: the page — the switch, the cap, and fork/rewind above the compaction --------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this.textContent = '';
        this.dataset = {};
        this.attrs = {};
        this.style = {};
        this.parentElement = null;
    }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

const pageDocument = {
    body: new El('body'),
    head: new El('head'),
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
};
const posted = [];
const storage = new Map();
const pageWindow = {
    document: pageDocument,
    addEventListener: (type, fn) => { if (type === 'message') pageWindow.onMessage = fn; },
    removeEventListener() {},
    getSelection: () => null,
    localStorage: {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
    },
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: () => ({}),
    clearTimeout: () => {},
};
pageWindow.window = pageWindow;
const pageContext = {
    window: pageWindow, document: pageDocument, console, Intl, Date, Math, JSON, Map, Set, WeakMap,
    setTimeout: pageWindow.setTimeout, clearTimeout: pageWindow.clearTimeout,
    setInterval: () => ({}), clearInterval: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
pageContext.globalThis = pageContext;
vm.createContext(pageContext);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), pageContext);
assert.ok(pageWindow.onMessage, 'page did not register a message listener');
const fromHost = (m) => pageWindow.onMessage({ data: m });
const ccx = pageWindow.__ccx;

const actions = new Map();
const sections = new Map();
const registry = {
    sections,
    registerAction: (action, section, runIt) => {
        const list = sections.get(section) || [];
        const i = list.findIndex((a) => a.id === action.id);
        if (i !== -1) list[i] = action;
        else list.push(action);
        sections.set(section, list);
        actions.set(action.id, { action, section, run: runIt });
    },
};
function StockSwitch() {}
registry.registerAction(
    { id: 'toggle-thinking', label: 'Thinking', trailingComponent: { type: StockSwitch, props: { isOn: true } } },
    'Model',
    () => {},
);
ccx.onRegistry({ commandRegistry: registry }, (tag, props) => ({ tag, props }), { messages: { value: [] } });

const entry = actions.get('ccx-full-history');
assert.ok(entry, 'the switch registers its own action');
assert.equal(entry.section, 'Model');
assert.equal(entry.action.label, 'History before compaction');
assert.equal(entry.action.keepMenuOpen, true, 'the switch must not close the menu on click');
assert.equal(entry.action.trailingComponent.tag, StockSwitch, 'the stock switch is borrowed, not redrawn');
assert.equal(entry.action.trailingComponent.props.isOn, false, 'off by default');
assert.equal(ccx.keepEveryMessage(), false, 'the cap stays while the switch is off');

// A reopened transcript as the page holds it: summary and kept tail after the old part, then the new.
const msg = (type, uuid) => ({ type, uuid, content: [] });
const list = [msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2'), msg('user', 's1'), msg('user', 'u3'), msg('user', 'u4')];
fromHost({
    type: 'from-extension',
    message: {
        type: 'response',
        requestId: 'r1',
        response: { type: 'get_session_response', messages: [{ type: 'user', uuid: 's1', isCompactSummary: true }, { type: 'user', uuid: 'u4' }] },
    },
});
assert.equal(ccx.beforeCompaction(list, list[0]), false, 'off: every message keeps its actions');

// Clicking asks the host and flips the page's own copy at once — the cap is consulted while a
// transcript is being rebuilt, which may well be before the host's answer arrives.
entry.run();
assert.deepEqual(posted.at(-1), { type: 'ccx:historyBeforeCompaction', enabled: true });
assert.equal(actions.get('ccx-full-history').action.trailingComponent.props.isOn, true, 'the switch follows the click');
assert.equal(ccx.keepEveryMessage(), true, 'on: the cap is lifted');
assert.equal(storage.get('ccx.historyBeforeCompaction'), '1', 'the last value is kept for the next page to start from');

assert.equal(ccx.beforeCompaction(list, list[0]), true, 'a prompt above the summary loses fork/rewind');
assert.equal(ccx.beforeCompaction(list, list[2]), true);
assert.equal(ccx.beforeCompaction(list, list[3]), false, 'the summary itself is left as the stock page has it');
assert.equal(ccx.beforeCompaction(list, list[4]), false, 'a kept message is still in the model context');
assert.equal(ccx.beforeCompaction(list, list[5]), false);
assert.equal(ccx.beforeCompaction(list, msg('user', 'elsewhere')), false, 'a message not in the list is not judged');

// A live compaction leaves a divider of its own in the list instead of a summary from disk.
const live = [msg('user', 'x1'), msg('compact', 'divider'), msg('user', 'x2')];
assert.equal(ccx.beforeCompaction(live, live[0]), true, 'a live compaction divides the same way');
assert.equal(ccx.beforeCompaction(live, live[2]), false);
// Appended in place: the cached edge is recomputed rather than trusted.
live.push(msg('compact', 'divider2'));
assert.equal(ccx.beforeCompaction(live, live[2]), true, 'a list that grew is re-indexed');

// The host's state push is authoritative, and a fresh page starts from the remembered value.
fromHost({ type: 'ccx:state', now: Date.now(), active: null, profiles: [], sessionId: 's', historyBeforeCompaction: false });
assert.equal(ccx.keepEveryMessage(), false, 'the host turning it off wins');
assert.equal(ccx.beforeCompaction(list, list[0]), false);
assert.equal(storage.get('ccx.historyBeforeCompaction'), '0');

console.log('OK — the page lifts the cap and hides fork/rewind above the last compaction only while on');

// --- Part 4: the wiring — what the patched page calls is what the page exposes ------------------

for (const name of ['keepEveryMessage', 'beforeCompaction']) {
    assert.ok(patchedPage.includes(`globalThis.__ccx.${name}(`), `the patched page never calls ${name}`);
    assert.equal(typeof ccx[name], 'function', `window.__ccx does not expose ${name}`);
}
assert.equal(patchedPage.split('globalThis.__ccx.beforeCompaction(').length - 1, 2, 'both the action menu and the Rewind list ask');
assert.ok(
    patchedPage.includes('"ccx-autocompact","ccx-full-history","switch-models-on-flag"'),
    'the Model sort order places the switch under auto-compact',
);

console.log('\nOK — history before compaction reaches the page, and only as a view');
rmSync(home, { recursive: true, force: true });
// attachWebview leaves fs.watch handles behind; nothing unrefs them.
process.exit(0);
