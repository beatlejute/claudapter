// A delegated run says nothing until it is over. Three separate pieces make it watchable while it
// happens, and each one is checked here:
//
//   1. the MCP server picks the session id BEFORE the spawn (--session-id) and drops a manifest in
//      agent-runs/, so the transcript the run is about to write is knowable from its first second;
//   2. host.js follows that transcript incrementally and turns it into a bounded event tail;
//   3. the page hangs a frame off the tool-call block — the Task one built from messages it already
//      holds, the run_agent one from what the host sent — and neither path feeds anything back into
//      the tab's own conversation.
//
//   node test/agent-live-frame.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// One home for both sides: the MCP server writes its manifests where host.js goes looking, so the
// handover between the two is exercised rather than mocked.
const home = join(tmpdir(), `ccx-frame-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'claudapter');
const projects = join(home, '.claude', 'projects');
const slug = join(projects, 'c--somewhere');
for (const d of [profiles, runtime, slug]) mkdirSync(d, { recursive: true });
writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDAPTER_PROFILES_DIR = profiles;
process.env.CLAUDAPTER_RUNTIME_DIR = runtime;

const { prepare, callTool } = await import('../src/mcp/agent-server.mjs');

// --- 1. the id is chosen up front, and a resumed run keeps the one it is resuming ----------------

const fresh = await prepare({ profile: 'claude', prompt: 'count the files' });
const idFlag = fresh.args.indexOf('--session-id');
assert.ok(idFlag > -1, 'a new run must name its session id before the CLI is spawned');
assert.match(fresh.args[idFlag + 1], /^[0-9a-f-]{36}$/, 'and it must be a real uuid, not a placeholder');
assert.equal(fresh.args[idFlag + 1], fresh.liveSession, 'the id given to the CLI is the one the manifest will carry');
assert.ok(!fresh.args.includes('--resume'), 'a new run resumes nothing');

const resumed = await prepare({
    profile: 'claude',
    prompt: 'and now?',
    session: 'aaaaaaaa-1111-2222-3333-444444444444',
});
assert.ok(
    !resumed.args.includes('--session-id'),
    '--session-id alongside --resume is two answers to the same question; the resumed id already decides it',
);
assert.equal(resumed.liveSession, 'aaaaaaaa-1111-2222-3333-444444444444', 'a resumed run is watched under the id it resumes');

// --- 2. the manifest exists while the run is live and records how it ended -----------------------
//
// The CLI path is deliberately bogus, so the child dies the moment it is spawned. What is under test
// is that a manifest was written before that and closed after it — not the child's answer.
process.env.CLAUDAPTER_CLAUDE_BIN = join(home, 'no-such-claude-binary');
await assert.rejects(() => callTool('run_agent', { profile: 'claude', prompt: 'watch me' }), /could not start the CLI/);
delete process.env.CLAUDAPTER_CLAUDE_BIN;

const runsDir = join(runtime, 'agent-runs');
const manifests = readdirSync(runsDir).map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));
assert.equal(manifests.length, 1, 'preparing a run writes nothing — only a run that actually starts does');
const watched = manifests[0];
assert.equal(watched.prompt, 'watch me', 'the prompt is carried so the page can tell which block this run belongs to');
assert.equal(watched.profile, 'claude');
assert.equal(watched.session, watched.id, 'the manifest is keyed by the session it points at');
assert.equal(watched.state, 'failed', 'a run that could not start is not left looking like it is still going');
assert.ok(watched.finishedAt, 'and it is stamped, so a frame can stop counting');

// --- 3. the host turns a growing transcript into a bounded tail ----------------------------------

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-frame-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let agentRunsPayload;
try {
    ({ agentRunsPayload } = require(copy));
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}
assert.ok(typeof agentRunsPayload === 'function', 'host.js must expose the run reader');

const sessionId = watched.session;
const transcript = join(slug, `${sessionId}.jsonl`);
const assistant = (blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } }) + '\n';
const user = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n';

writeFileSync(
    transcript,
    user([{ type: 'text', text: 'watch me' }]) +
        assistant([{ type: 'thinking', thinking: 'hmm' }]) +
        assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/host.js' } }]),
);

const followed = () => agentRunsPayload().find((r) => r.session === sessionId);
const first = followed();
assert.ok(first, 'the failed run is still followed — its transcript is what says why');
assert.equal(first.profile, 'claude');
assert.deepStrictEqual(
    first.events,
    [
        { k: 'prompt', t: 'watch me' },
        { k: 'thinking' },
        { k: 'tool', n: 'Read', t: 'src/host.js' },
    ],
    'a transcript line becomes one compact event per content block',
);

// Appended lines are read from the offset rather than by re-reading the file, so nothing is doubled.
appendFileSync(transcript, assistant([{ type: 'text', text: 'done looking' }]));
const grown = followed();
assert.equal(grown.events.length, 4, 'the second pass appends rather than re-reads');
assert.deepStrictEqual(grown.events[3], { k: 'text', t: 'done looking' });

// A half-written last line is left for the next pass rather than parsed as truncated JSON.
appendFileSync(transcript, '{"type":"assistant","message":{"role":"assist');
assert.equal(followed().events.length, 4, 'an incomplete line adds nothing');
appendFileSync(transcript, 'ant","content":[{"type":"text","text":"tail"}]}}\n');
assert.deepStrictEqual(followed().events[4], { k: 'text', t: 'tail' }, 'and is read once it is whole');

// --- 4. the page draws a frame on a Task call and on a run_agent call ----------------------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this._text = '';
        this.dataset = {};
        this.attrs = {};
        this.parentElement = null;
        this.listeners = {};
    }
    // The real one drops every child; the frame body relies on that to rebuild itself.
    set textContent(v) {
        this._text = v;
        if (v === '') this.children = [];
    }
    get textContent() {
        return this._text;
    }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {}, preventDefault() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

const child = (node, className) => node.children.find((c) => c.className === className) || null;
const frameOf = (node) => child(node, 'ccx-agent-frame');
const titleOf = (node) => child(child(frameOf(node), 'ccx-agent-head'), 'ccx-agent-title').textContent;
const linesOf = (node) => {
    const body = child(frameOf(node), 'ccx-agent-body');
    return body ? body.children.map((c) => `${c.className}:${c.textContent}`) : null;
};

let toolNodes = [];
const pageDocument = {
    body: new El('body'),
    head: new El('head'),
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[class*="toolUse_"]' ? toolNodes.slice() : []),
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
};
const pageWindow = {
    document: pageDocument,
    removeEventListener() {},
    getSelection: () => null,
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: (fn) => ({ fn }),
    clearTimeout: () => {},
};
pageWindow.window = pageWindow;
let onMessage = null;
pageWindow.addEventListener = (type, fn) => { if (type === 'message') onMessage = fn; };
const posted = [];
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
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
pageContext.globalThis = pageContext;
vm.createContext(pageContext);
vm.runInContext(readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8'), pageContext);
assert.ok(onMessage, 'page did not register a message listener');
const fromHost = (m) => onMessage({ data: m });

// A tool-call div carries the block only on the fiber of the component that rendered it, wrapped the
// way the app wraps every content block: {content: rawBlock, toolResult: signal}.
function toolNode(block, finished) {
    const node = new El('div');
    node.className = 'toolUse_uq5aLg';
    const wrapper = { content: block, toolResult: { value: finished ? [{ type: 'text', text: 'ok' }] : undefined } };
    const component = { memoizedProps: { content: wrapper }, return: null };
    node['__reactFiber$abc'] = { memoizedProps: { className: node.className }, return: component };
    return node;
}

// The page reads a native subagent's turns off the session object the registry handed it — the same
// object the model/effort chip reads. They are ordinary messages tagged with the Task call's id.
const messages = { value: [] };
const subagentTasks = { value: new Map() };
pageContext.window.__ccx.onRegistry(null, null, { messages, subagentTasks });

const inlineBlock = {
    type: 'tool_use',
    id: 'toolu_task_1',
    name: 'Task',
    input: { subagent_type: 'Explore', description: 'find the watchers', prompt: 'where are the fs watchers' },
};
const wrap = (raw) => ({ content: raw });
messages.value = [
    { type: 'user', parentToolUseId: 'toolu_task_1', content: [wrap({ type: 'text', text: 'where are the fs watchers' })] },
    {
        type: 'assistant',
        sdkParentToolUseId: 'toolu_task_1',
        content: [wrap({ type: 'tool_use', name: 'Grep', input: { pattern: 'fs.watch' } })],
    },
    // another subagent's turn, and a turn of the main conversation: neither belongs in this frame
    { type: 'assistant', parentToolUseId: 'toolu_other', content: [wrap({ type: 'text', text: 'not mine' })] },
    { type: 'assistant', content: [wrap({ type: 'text', text: 'main thread' })] },
];

const running = toolNode(inlineBlock, false);
toolNodes = [running];
fromHost({ type: 'ccx:agentRuns', runs: [] });

assert.ok(frameOf(running), 'a running Task call gets a frame');
assert.equal(frameOf(running).dataset.ccxOpen, '1', 'and it opens itself while the run is going');
assert.deepStrictEqual(
    linesOf(running),
    ['ccx-agent-prompt:where are the fs watchers', 'ccx-agent-tool:Grep fs.watch'],
    'only the turns tagged with this call belong in its frame',
);
assert.match(titleOf(running), /Explore/, 'the frame is titled by the agent that is running');

// Once the tool result lands the run has ended, so the frame folds away — the answer is the tool
// result right below it.
const finished = toolNode(inlineBlock, true);
toolNodes = [finished];
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.equal(frameOf(finished).dataset.ccxOpen, '0', 'a finished run collapses on its own');
// ...unless the reader opens it by hand, which then sticks.
child(frameOf(finished), 'ccx-agent-head').click();
assert.equal(frameOf(finished).dataset.ccxOpen, '1', 'a frame the reader opened stays open');
assert.deepStrictEqual(linesOf(finished), ['ccx-agent-prompt:where are the fs watchers', 'ccx-agent-tool:Grep fs.watch']);

// --- 5. the task shape: turns the page never receives, only progress ----------------------------
//
// The Agent tool runs its subagent as a task (task_type "local_agent"), foreground or background, and
// those turns go to the task's own output file rather than onto this tab's stream. What the page gets
// is the progress feed the app files into `subagentTasks` and otherwise only counts.
const taskBlock = {
    type: 'tool_use',
    id: 'toolu_task_2',
    name: 'Agent',
    input: { subagent_type: 'Explore', description: 'trace the frame', prompt: 'where is ccx-agent-frame created' },
};
subagentTasks.value = new Map([
    [
        'task_abc',
        {
            taskId: 'task_abc',
            toolUseId: 'toolu_task_2',
            description: 'trace the frame',
            prompt: 'where is ccx-agent-frame created',
            summary: 'found it in paintFrame',
            recentTools: ['Grep', 'Read'],
            usage: { totalTokens: 19147, toolUses: 6, durationMs: 30719 },
            status: 'running',
        },
    ],
]);

const taskNode = toolNode(taskBlock, false);
toolNodes = [taskNode];
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.ok(frameOf(taskNode), 'a task-shaped subagent gets a frame even though its turns never reach the page');
assert.deepStrictEqual(
    linesOf(taskNode),
    ['ccx-agent-prompt:where is ccx-agent-frame created', 'ccx-agent-tool:Grep', 'ccx-agent-tool:Read', 'ccx-agent-text:found it in paintFrame'],
    'the progress feed is what a task-shaped run can show',
);
const taskNote = child(child(frameOf(taskNode), 'ccx-agent-head'), 'ccx-agent-note').textContent;
assert.match(taskNote, /6 tool calls/, "the task's own total beats counting the last-three list");
assert.match(taskNote, /19,147 tok/, 'and it carries what the run has spent');

// The app deletes the entry the moment the task ends. A frame that blanked itself right then would go
// empty at the one moment it is worth reading, so the last snapshot is kept.
subagentTasks.value = new Map();
const endedNode = toolNode(taskBlock, true);
toolNodes = [endedNode];
fromHost({ type: 'ccx:agentRuns', runs: [] });
child(frameOf(endedNode), 'ccx-agent-head').click();
assert.deepStrictEqual(
    linesOf(endedNode),
    ['ccx-agent-prompt:where is ccx-agent-frame created', 'ccx-agent-tool:Grep', 'ccx-agent-tool:Read', 'ccx-agent-text:found it in paintFrame'],
    'the last progress a task reported survives the app forgetting it',
);

// Where both sources exist, the conversation wins: a summary is never as good as the turns.
subagentTasks.value = new Map([
    ['task_zzz', { taskId: 'task_zzz', toolUseId: 'toolu_task_1', summary: 'a summary', recentTools: ['Bash'] }],
]);
toolNodes = [toolNode(inlineBlock, false)];
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.deepStrictEqual(
    linesOf(toolNodes[0]),
    ['ccx-agent-prompt:where are the fs watchers', 'ccx-agent-tool:Grep fs.watch'],
    'messages beat a progress summary wherever the page has them',
);
subagentTasks.value = new Map();

// A delegated run is matched to its block by the prompt — an MCP server never learns the tool_use id.
const mcpBlock = {
    type: 'tool_use',
    id: 'toolu_mcp_1',
    name: 'mcp__claudapter-agents__run_agent',
    input: { profile: 'deepseek', prompt: 'review src/host.js' },
};
const mcpNode = toolNode(mcpBlock, false);
toolNodes = [mcpNode];
fromHost({
    type: 'ccx:agentRuns',
    runs: [
        {
            session: 'bbbbbbbb-1111-2222-3333-444444444444',
            profile: 'deepseek',
            model: 'deepseek-v4-pro',
            prompt: 'review src/host.js',
            state: 'running',
            startedAt: Date.now() - 5000,
            events: [
                { k: 'tool', n: 'Read', t: 'src/host.js' },
                { k: 'text', t: 'reading the watchers' },
            ],
        },
    ],
});
assert.ok(frameOf(mcpNode), 'a run_agent call gets a frame too');
assert.match(titleOf(mcpNode), /deepseek/, 'and it is titled by the provider the run went out on');
assert.deepStrictEqual(linesOf(mcpNode), ['ccx-agent-tool:Read src/host.js', 'ccx-agent-text:reading the watchers']);

// Nothing about a frame travels anywhere: the page sends the host nothing in response to a run.
assert.equal(
    posted.filter((m) => m && typeof m.type === 'string' && m.type.startsWith('ccx:agent')).length,
    0,
    'a frame is a view, not a channel — it must not post anything back',
);

// A run_agent block with no matching run left (swept, or started by another window) shows nothing
// rather than an empty shell.
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.equal(frameOf(mcpNode), null, 'a block with no run behind it keeps no frame');

// Two live runs started with the same prompt do not share one frame.
const twinA = toolNode({ ...mcpBlock, id: 'toolu_mcp_a' }, false);
const twinB = toolNode({ ...mcpBlock, id: 'toolu_mcp_b' }, false);
toolNodes = [twinA, twinB];
fromHost({
    type: 'ccx:agentRuns',
    runs: [
        { session: 'cccccccc-1111-2222-3333-444444444444', profile: 'p1', prompt: 'review src/host.js', state: 'running', startedAt: 1, events: [{ k: 'text', t: 'one' }] },
        { session: 'dddddddd-1111-2222-3333-444444444444', profile: 'p2', prompt: 'review src/host.js', state: 'running', startedAt: 2, events: [{ k: 'text', t: 'two' }] },
    ],
});
assert.notDeepStrictEqual(linesOf(twinA), linesOf(twinB), 'two identical prompts must not be shown the same run');

// An ordinary tool call is never touched.
const plain = toolNode({ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'a.js' } }, true);
toolNodes = [plain];
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.equal(frameOf(plain), null, 'a Read call is not an agent');

// A node whose fiber carries no tool_use at all is left alone rather than taking the pass down.
const stray = new El('div');
stray.className = 'toolUse_uq5aLg';
stray['__reactFiber$zzz'] = { memoizedProps: { className: 'x' }, return: null };
toolNodes = [stray];
fromHost({ type: 'ccx:agentRuns', runs: [] });
assert.equal(frameOf(stray), null);

console.log('\nOK — a delegated run is watchable while it runs, from both sources, and feeds nothing back');
