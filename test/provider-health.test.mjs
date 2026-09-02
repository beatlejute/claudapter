// The stock Account & Usage panel reports one subscription. An install that switches provider per tab
// has several endpoints, each with a quota of its own, and the MCP server already writes down what it
// learned about them: agent-health.json holds one verdict per profile, refreshed by the probe that
// runs before every delegated run. Two halves are checked here — that the host forwards those
// verdicts with each state push, and that the page turns them into an entry of its own in the
// command menu — Provider status… — beside the stock Account & Usage one.
//   node test/provider-health.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// --- Part 1: the host side — a verdict per profile in ccx:state -------------------------------

const home = join(tmpdir(), `ccx-health-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
const profiles = join(home, '.claude', 'profiles');
mkdirSync(runtime, { recursive: true });
mkdirSync(profiles, { recursive: true });
copyFileSync(new URL('../src/webview.js', import.meta.url), join(runtime, 'webview.js'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const profile = (name, env) => writeFileSync(join(profiles, `${name}.json`), JSON.stringify({ env }));
// The Anthropic subscription declares nothing at all — that is what makes it the subscription.
profile('claude', {});
profile('codex', {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/codex',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.6-luna',
});
profile('glm', { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.2' });
profile('minimax', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/minimax' });

const HEALTH_FILE = join(runtime, 'agent-health.json');
const now = Date.now();
const stamp = (msAgo) => new Date(now - msAgo).toISOString();
const long = 'x'.repeat(400);
writeFileSync(
    HEALTH_FILE,
    JSON.stringify({
        codex: { at: stamp(120_000), ok: true, model: 'gpt-5.6-luna' },
        glm: {
            at: stamp(3_600_000),
            ok: false,
            status: 429,
            message: long,
            resets_at: new Date(now + 7_200_000).toISOString(),
            model: 'glm-5.2',
        },
        minimax: { at: stamp(600_000), ok: false, unreachable: true, message: 'no answer' },
        // A profile that no longer exists must not invent a row of its own
        retired: { at: stamp(60_000), ok: true },
    }),
);

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
const opened = [];
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? {
              Uri: { file: (p) => ({ fsPath: p }) },
              window: {
                  showWarningMessage() {},
                  showErrorMessage() {},
                  showTextDocument: (uri) => opened.push(uri.fsPath),
              },
          }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-health-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}

function openWebview() {
    const posted = [];
    const handlers = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    return { posted, send: (m) => handlers.forEach((fn) => fn(m)) };
}

const fakeWebview = () => openWebview().posted.filter((m) => m.type === 'ccx:state').at(-1);

const state = fakeWebview();
const byName = Object.fromEntries(state.profiles.map((p) => [p.name, p]));
assert.deepEqual(Object.keys(byName).sort(), ['claude', 'codex', 'glm', 'minimax'], 'a health entry is not a profile');

assert.ok(state.now >= now, 'every age in the panel is measured from one stamp, and the host sets it');

// A profile nothing has ever probed reports no verdict at all — an unknown state must never be able
// to render as a healthy one.
assert.equal(byName.claude.health, null, 'an unprobed profile carries no health record');
assert.equal(byName.claude.endpoint, 'Anthropic subscription');

assert.equal(byName.codex.health.ok, true);
assert.equal(byName.codex.health.model, 'gpt-5.6-luna', 'the model the probe reached travels with the verdict');
assert.equal(byName.codex.endpoint, 'adapter :8787 · codex', 'a local adapter is named by the upstream it fronts');

assert.equal(byName.glm.health.ok, false);
assert.equal(byName.glm.health.unreachable, false, 'a refusal is not an unreachable endpoint');
assert.equal(byName.glm.health.status, 429);
assert.equal(byName.glm.health.message.length, 200, "a provider's own error text reaches the page bounded");
assert.equal(byName.glm.health.resetsAt, Date.parse(new Date(now + 7_200_000).toISOString()));
assert.equal(byName.glm.endpoint, 'open.bigmodel.cn', 'a remote endpoint is named by its host');

assert.equal(byName.minimax.health.unreachable, true, 'no answer is kept apart from a refusal');
assert.equal(byName.minimax.health.ok, false);

// The file is written by another process mid-run, so a half-written or hand-edited one has to read as
// "nothing known" rather than take down every state push in the tab.
writeFileSync(HEALTH_FILE, '{"codex": {"at": ');
const corrupt = fakeWebview();
assert.ok(
    corrupt.profiles.every((p) => p.health === null),
    'a corrupt agent-health.json degrades to no verdicts',
);
writeFileSync(HEALTH_FILE, JSON.stringify({ codex: { at: 'not a date', ok: true } }));
assert.equal(fakeWebview().profiles.find((p) => p.name === 'codex').health, null, 'an unparsable stamp is no verdict');

// The opening postIcons() happens while the HTML is still being generated, so that message reaches no
// page at all — and the stamp it set would silence every later send. A page asking for state is a page
// that holds nothing, so the icons have to come with the answer.
const tab = openWebview();
tab.posted.length = 0;
tab.send({ type: 'ccx:get' });
assert.ok(
    tab.posted.some((m) => m.type === 'ccx:icons'),
    'ccx:get must answer with the icon set, not just the state',
);

// Every question the list raises is answered in the profile file, so the page can ask for it by name
// — and only by name: an id that is not a profile must never become a path the host opens.
tab.send({ type: 'ccx:openProfile', name: 'glm' });
assert.deepEqual(opened, [join(profiles, 'glm.json')], 'the named profile is opened');
tab.send({ type: 'ccx:openProfile', name: '../../../etc/passwd' });
tab.send({ type: 'ccx:openProfile', name: 'not-a-profile' });
assert.equal(opened.length, 1, 'a name that is not a profile opens nothing');

console.log('OK — the host forwards one bounded verdict per profile');
rmSync(home, { recursive: true, force: true });

// --- Part 2: the page side — its own entry in the Model section --------------------------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this._text = '';
        this.title = '';
        this.src = '';
        this.dataset = {};
        this.attrs = {};
        this.parentElement = null;
        this.onclick = null;
    }
    set textContent(v) {
        this._text = v;
        if (v === '') this.children = [];
    }
    get textContent() {
        return this._text + this.children.map((c) => c.textContent).join('');
    }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(n) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        this.children.push(n);
        return n;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    insertBefore(n, ref) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at < 0) this.children.push(n);
        else this.children.splice(at, 0, n);
        return n;
    }
    cloneNode() {
        const copy = new El(this.tagName);
        copy.className = this.className;
        copy._text = this._text;
        return copy;
    }
    walk(out) {
        out.push(this);
        for (const c of this.children) c.walk(out);
        return out;
    }
    // Only the one selector shape the page actually asks for: [class*="prefix_"]
    matches(sel) {
        const m = /^\[class\*="([^"]+)"\]$/.exec(sel);
        return Boolean(m) && String(this.className).includes(m[1]);
    }
    querySelector(sel) {
        return this.walk([]).find((n) => n !== this && n.matches(sel)) || null;
    }
    querySelectorAll(sel) {
        return this.walk([]).filter((n) => n !== this && n.matches(sel));
    }
}

const pageDocument = {
    body: new El('body'),
    head: new El('head'),
    createElement: (t) => new El(t),
    querySelector: (sel) => pageDocument.body.querySelector(sel),
    querySelectorAll: (sel) => pageDocument.body.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
};
const posted = [];
const pageWindow = {
    document: pageDocument,
    addEventListener: (type, fn) => { if (type === 'message') pageWindow.onMessage = fn; },
    removeEventListener() {},
    getSelection: () => null,
    localStorage: {
        map: new Map(),
        getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
        setItem(k, v) { this.map.set(k, String(v)); },
    },
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: (fn) => ({ fn }),
    clearTimeout: () => {},
};
pageWindow.window = pageWindow;
const pageContext = {
    window: pageWindow,
    document: pageDocument,
    console,
    Intl,
    Date,
    Math,
    JSON,
    setTimeout: pageWindow.setTimeout,
    clearTimeout: pageWindow.clearTimeout,
    setInterval: () => ({}),
    clearInterval: () => {},
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

// The command menu, as the bundle hands it over at injection point #4: a registry that takes
// (action, section, handler) and a jsx factory for the trailing component.
const actions = new Map();
const registry = {
    registerAction: (action, section, run) => actions.set(action.id, { action, section, run }),
};
pageWindow.__ccx.onRegistry({ commandRegistry: registry }, (tag, props) => ({ tag, props }), null);

const at = (msAgo) => now - msAgo;
const ICON = 'data:image/png;base64,iVBORw0KGgo=';
const profileRow = (name, extra = {}) => ({ name, model: '', endpoint: '', health: null, ...extra });
const push = (extra = {}) =>
    fromHost({
        type: 'ccx:state',
        now,
        active: 'codex',
        profiles: [
            profileRow('claude', { endpoint: 'Anthropic subscription' }),
            profileRow('codex', {
                model: 'gpt-5.6-luna',
                endpoint: 'adapter :8787 · codex',
                health: { at: at(120_000), ok: true, unreachable: false, status: null, message: '', resetsAt: null, model: 'gpt-5.6-luna' },
            }),
            profileRow('glm', {
                model: 'glm-5.2',
                endpoint: 'open.bigmodel.cn',
                health: {
                    at: at(3_600_000),
                    ok: false,
                    unreachable: false,
                    status: 429,
                    message: 'Insufficient balance or no resource package',
                    resetsAt: now + 7_200_000,
                    model: 'glm-5.2',
                },
            }),
            profileRow('minimax', {
                model: 'MiniMax-M3',
                endpoint: 'adapter :8787 · minimax',
                health: { at: at(2 * 24 * 3_600_000), ok: false, unreachable: true, status: null, message: 'fetch failed', resetsAt: null, model: '' },
            }),
        ],
        ...extra,
    });

fromHost({ type: 'ccx:icons', icons: { codex: ICON }, fallback: null });
push();

// 1. An entry of its own, next to the stock account panel rather than inside it.
const entry = actions.get('ccx-health');
assert.ok(entry, 'the status list must register its own action');
assert.equal(entry.section, 'Model');
assert.equal(entry.action.label, 'Provider status…');
assert.ok(actions.has('ccx-provider'), 'the picker keeps its own entry');
// The menu row carries the count, so "is anything down" is answerable without opening anything.
assert.equal(entry.action.trailingComponent.props.children, '2 down');
// One chip style: the count is the message, the colour is not.
assert.equal(entry.action.trailingComponent.props.className, 'ccx-prov-tag');

// 2. Opening it draws one overlay, with a row per profile in the order the host sent them.
const overlays = () => pageDocument.body.children.filter((c) => c.className === 'ccx-overlay');
entry.run();
assert.equal(overlays().length, 1, 'the status list opens exactly one overlay');
const box = () => overlays()[0].children[0];
const list = () => box().children.find((c) => c.className === 'ccx-prov-list');
assert.match(box().className, /ccx-health-box/);
assert.equal(box().children[0].children[0].textContent, '1 ok · 2 down', 'the tally counts only what was probed');
// Said out loud: nothing here opens a connection, so a row is only as fresh as the last real call.
assert.match(box().children[1].textContent, /never from here/);

const rows = list().children;
assert.deepEqual(rows.map((r) => r.children[0].children[1].textContent), ['claude', 'codex', 'glm', 'minimax']);
assert.deepEqual(rows.map((r) => r.getAttribute('data-ccx-prov')), ['unknown', 'ok', 'failed', 'silent']);
// Badge, name, age — no model column: it repeats across every row on one adapter and says nothing
// about whether the provider answers. It stays in the row's tooltip.
assert.equal(rows[1].children[0].children.length, 3);
assert.equal(rows[0].children[0].children[2].textContent, 'never', 'an unprobed provider says so instead of showing an age');
assert.equal(rows[1].children[0].children[2].textContent, '2m');
assert.match(rows[1].title, /gpt-5\.6-luna/);
assert.equal(rows[1].getAttribute('data-ccx-prov-active'), '1', 'the bound profile is marked');
assert.equal(rows[2].getAttribute('data-ccx-prov-active'), null);

// 3. The brand mark is a real <img> inside the badge wrapper — the wrapper is what carries the
//    status dot, and an <img> renders no pseudo-element of its own.
const badge = (row) => row.children[0].children[0];
assert.equal(badge(rows[1]).tagName, 'span');
assert.equal(badge(rows[1]).children[0].tagName, 'img');
assert.equal(badge(rows[1]).children[0].src, ICON);
assert.equal(badge(rows[1]).className, 'ccx-prov-icon');
assert.equal(badge(rows[0]).children.length, 0, 'a profile with no icon still gets the slot');
assert.match(badge(rows[0]).className, /ccx-prov-icon-blank/);

// 4. Every row is one line: the refusal is a hint on the mark the dot sits on, quoting the provider
//    and saying when the quota comes back. Silence is not a refusal.
assert.equal(rows[2].children.length, 1, 'a refusal costs no second line in the list');
assert.equal(badge(rows[0]).title, 'never probed');
assert.equal(badge(rows[1]).title, 'answered 2m ago');
assert.equal(badge(rows[2]).title, 'HTTP 429 · Insufficient balance or no resource package · resets in 2h');
assert.equal(badge(rows[3]).title, 'no answer · fetch failed');
assert.equal(rows[3].getAttribute('data-ccx-prov-stale'), '1', 'a two-day-old verdict is drawn as old');
assert.equal(rows[1].getAttribute('data-ccx-prov-stale'), null);

// 4b. A click on a row asks the host for that profile's file, and the overlay steps aside.
posted.length = 0;
rows[2].onclick();
assert.deepEqual(posted, [{ type: 'ccx:openProfile', name: 'glm' }], 'the row names the profile it opens');
assert.equal(overlays().length, 0, 'and the overlay closes behind it');
entry.run();

// 5. A state push repaints the open list in place — a provider that just came back does not need a
//    reopen — and never stacks a second overlay on top of the first.
push({
    profiles: [
        profileRow('glm', {
            model: 'glm-5.2',
            endpoint: 'open.bigmodel.cn',
            health: { at: at(1000), ok: true, unreachable: false, status: null, message: '', resetsAt: null, model: 'glm-5.2' },
        }),
    ],
});
assert.equal(overlays().length, 1, 'a repaint replaces the overlay rather than adding one');
assert.equal(list().children.length, 1);
assert.equal(list().children[0].getAttribute('data-ccx-prov'), 'ok', 'a recovered provider turns green');
assert.equal(box().children[0].children[0].textContent, '1 ok');
assert.equal(actions.get('ccx-health').action.trailingComponent.props.children, 'all ok', 'the menu row follows');

// 6. Closed, the list stops following state — and nothing is left behind in the body.
overlays()[0].onclick({ target: overlays()[0] });
push();
assert.equal(overlays().length, 0, 'a closed status list stays closed');

console.log('OK — the page gives the verdicts an entry and an overlay of their own');

// --- Part 3: the same verdicts as a section in the sessions sidebar ----------------------------

// The sidebar's own stack, as the bundle draws it: a header per section (chevron + label, plus a
// "View details" link on the account one) with the section's body as its sibling. Every class name
// carries a per-build hash, which is why the page lifts them off these nodes.
function sidebarHeader(label, withLink) {
    const header = new El('div');
    header.className = 'sectionHeader_djirOA';
    const toggle = new El('button');
    toggle.className = 'sectionToggle_djirOA';
    const chevron = new El('svg');
    chevron.className = 'sectionChevron_djirOA';
    const text = new El('span');
    text.className = 'sectionLabel_djirOA';
    text.textContent = label;
    toggle.appendChild(chevron);
    toggle.appendChild(text);
    header.appendChild(toggle);
    if (withLink) {
        const link = new El('button');
        link.className = 'sectionLink_djirOA';
        link.textContent = 'View details';
        header.appendChild(link);
    }
    return header;
}

const stack = new El('div');
stack.className = 'root_djirOA';
const accountHeader = sidebarHeader('Account & usage', true);
const accountBody = new El('div');
accountBody.className = 'accountUsageBody_djirOA';
const sessionsHeader = sidebarHeader('Session manager', false);
const sessionsBody = new El('div');
sessionsBody.className = 'sessionsBody_djirOA';
for (const n of [accountHeader, accountBody, sessionsHeader, sessionsBody]) stack.appendChild(n);
pageDocument.body.appendChild(stack);

push();
const side = stack.children.find((c) => String(c.className).includes('ccx-side-section'));
assert.ok(side, 'the sidebar stack must get a section of its own');
assert.equal(
    stack.children.indexOf(side) + 1,
    stack.children.indexOf(sessionsHeader),
    'it goes in front of the session manager, under account & usage',
);

// 1. Built out of the sidebar's own header markup, down to the cloned chevron.
const sideHead = side.children[0];
assert.equal(sideHead.className, 'sectionHeader_djirOA', 'the header class is lifted off the live one');
assert.equal(sideHead.children[0].className, 'sectionToggle_djirOA');
assert.equal(sideHead.children[0].children[0].children[0].tagName, 'svg', "the app's own chevron is cloned, not redrawn");
assert.equal(sideHead.children[0].children[1].textContent, 'Providers');

// 2. The link sits where "View details" sits and carries the count.
const sideLink = sideHead.children[1];
// The same chip the menu entry carries, not the sidebar's link class: one fact, one control.
assert.match(sideLink.className, /ccx-prov-tag/);
assert.equal(sideLink.textContent, '2 down');
assert.equal(sideLink.getAttribute('data-ccx-down'), '1');

// 3. One row per profile, the same painter as the overlay.
const sideRows = side.children[1].children;
assert.deepEqual(sideRows.map((r) => r.children[0].children[1].textContent), ['claude', 'codex', 'glm', 'minimax']);
assert.deepEqual(sideRows.map((r) => r.getAttribute('data-ccx-prov')), ['unknown', 'ok', 'failed', 'silent']);

// 4. The fold is remembered, so a collapsed section does not spring open on the next state push.
assert.equal(side.getAttribute('data-ccx-open'), '1');
sideHead.children[0].onclick();
assert.equal(side.getAttribute('data-ccx-open'), '0');
assert.equal(pageWindow.localStorage.getItem('ccx.providers.collapsed'), '1');
push();
assert.equal(side.getAttribute('data-ccx-open'), '0', 'a state push must not unfold the section');

// 5. Repeated passes find the section again rather than adding a second one.
push();
assert.equal(
    stack.children.filter((c) => String(c.className).includes('ccx-side-section')).length,
    1,
    'the section is found again, not added again',
);

// 6. The link opens the same overlay the menu entry does.
sideLink.onclick();
assert.equal(overlays().length, 1, 'the sidebar link opens the full list');

console.log('OK — the sidebar stack gets the same verdicts, folded where the user left them');

// attachWebview leaves fs.watch handles on settings, bindings, profiles and agent-health; nothing
// unrefs them, so the assertions above are the end of the run.
process.exit(0);
