'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'claudapter');
const PROFILES_DIR = path.join(HOME, '.claude', 'profiles');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const ICONS_DIR = path.join(DIR, 'icons');
const BINDINGS_FILE = path.join(DIR, 'bindings.json');
const HIDDEN_FILE = path.join(DIR, 'hidden-messages.json');
const PINNED_FILE = path.join(DIR, 'pinned.json');
const ICON_EXTENSIONS = ['png', 'svg'];
// An icon is inlined into the webview as base64 — past this size it is a mistake, not an icon
const MAX_ICON_BYTES = 512 * 1024;

// Several versions linger on disk after an update, so compare version numbers, not names
function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

const EXTENSIONS_ROOT = path.join(HOME, '.vscode', 'extensions');

// Retired folders linger on disk until VS Code garbage-collects them, and .obsolete is what marks them.
// Skipping them matters for the update watcher, which reads "the newest folder is not the one this
// window is running" as an update having landed — an obsolete folder answering that question would send
// the patcher at a version nobody is about to load.
function newestExtensionDir({ includeObsolete = false } = {}) {
    try {
        let obsolete = {};
        if (!includeObsolete) {
            try {
                obsolete = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_ROOT, '.obsolete'), 'utf8')) || {};
            } catch {}
        }
        const dir = fs
            .readdirSync(EXTENSIONS_ROOT)
            .filter((d) => d.startsWith('anthropic.claude-code-') && !obsolete[d])
            .sort((a, b) => {
                const [x, y] = [versionOf(a), versionOf(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            })
            .pop();
        return dir ? path.join(EXTENSIONS_ROOT, dir) : null;
    } catch {
        return null;
    }
}

// The extension flips the tab icon between these three on every rename_tab
const STOCK_LOGO = { idle: 'claude-logo.svg', done: 'claude-logo-done.svg', pending: 'claude-logo-pending.svg' };

function defaultIcon(state = 'idle') {
    // An icon is only a file to read, so an obsolete folder still serves it — better a stale logo than
    // none on the window that is running one
    const dir = newestExtensionDir() || newestExtensionDir({ includeObsolete: true });
    if (!dir) return null;
    const icon = path.join(dir, 'resources', STOCK_LOGO[state] || STOCK_LOGO.idle);
    return fs.existsSync(icon) ? icon : null;
}

const S = (globalThis.__ccxState ||= {
    webviews: new Set(),
    panels: new Map(),
    settingsWatcher: null,
    bindingsWatcher: null,
    profilesWatcher: null,
    extensionsWatcher: null,
    repatching: false,
    repatchTries: new Map(),
    activeSessionByPanel: new Map(),
    profileByWebview: new Map(),
    pendingProfile: null,
    badges: new Map(),
    iconUris: new Map(),
    warnedOverrides: new Set(),
});

const LOG_FILE = path.join(DIR, 'debug.log');

function dlog(...parts) {
    try {
        const line = `${new Date().toISOString()} ${parts
            .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
            .join(' ')}\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {}
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// The built-in Claude Code checker is rendered only by its terminal UI; the VS Code composer does not
// receive its results. This bridge runs the same local Hunspell dictionary from the extension host and
// returns only the misspelled tokens, never the complete draft or anything over the network.
const SPELLCHECK_MAX_WORDS = 200;
const SPELLCHECK_MAX_WORD_LENGTH = 80;
const SPELLCHECK_TIMEOUT_MS = 1500;

function spellcheckConfig() {
    const config = readJson(SETTINGS_FILE)?.spellcheck;
    if (!config || config.enabled !== true) return null;
    if (config.checker && config.checker !== 'hunspell' && config.checker !== 'auto') return null;
    return { language: typeof config.language === 'string' && config.language ? config.language : null };
}

function hunspellPath() {
    // winget puts its user-facing command links here. Fall back to PATH for other installers and OSes.
    const link =
        process.platform === 'win32' && process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'hunspell.exe')
            : null;
    return link && fs.existsSync(link) ? link : 'hunspell';
}

function checkedWords(words) {
    const config = spellcheckConfig();
    if (!config || !Array.isArray(words)) return Promise.resolve(null);
    const accepted = [];
    for (const word of words) {
        if (
            typeof word === 'string' &&
            word.length > 1 &&
            word.length <= SPELLCHECK_MAX_WORD_LENGTH &&
            /^[А-Яа-яЁё]+$/.test(word) &&
            !accepted.includes(word)
        ) {
            accepted.push(word);
            if (accepted.length === SPELLCHECK_MAX_WORDS) break;
        }
    }
    if (!accepted.length) return Promise.resolve({ unknown: new Set(), suggestions: {} });

    const args = [];
    if (config.language) args.push('-d', config.language);
    // -a emits one machine-readable line per word, including suggestions for misspellings.
    args.push('-a');
    return new Promise((resolve) => {
        let done = false;
        let stdout = '';
        let child;
        let timer = null;
        const finish = (result) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        try {
            child = spawn(hunspellPath(), args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        } catch {
            finish(null);
            return;
        }
        timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, SPELLCHECK_TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.length > 64 * 1024) {
                child.kill();
                finish(null);
            }
        });
        child.once('error', () => finish(null));
        child.once('close', (code) => {
            if (code !== 0) return finish(null);
            const unknown = new Set();
            const suggestions = {};
            for (const line of stdout.split(/\r?\n/)) {
                const match = /^&\s+(\S+)\s+\d+\s+\d+:\s*(.*)$/.exec(line);
                if (!match) continue;
                const word = match[1].toLowerCase();
                unknown.add(word);
                const list = match[2]
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => /^[А-Яа-яЁё]+$/.test(item))
                    .slice(0, 5);
                if (list.length) suggestions[word] = list;
            }
            finish({ unknown, suggestions });
        });
        child.stdin.end(accepted.join('\n') + '\n', 'utf8');
    });
}

function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
        console.error('ccx: writeJson failed', e);
    }
}

function listProfiles() {
    try {
        return fs
            .readdirSync(PROFILES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
    } catch {
        return [];
    }
}

function profileEnv(name) {
    const p = readJson(path.join(PROFILES_DIR, name + '.json'));
    return p && typeof p.env === 'object' && p.env ? p.env : {};
}

function currentEnv() {
    const cfg = readJson(SETTINGS_FILE);
    return cfg && typeof cfg.env === 'object' && cfg.env ? cfg.env : {};
}

function modelOf(env) {
    return env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '';
}

function profileMatchesEnv(name, env) {
    const pEnv = profileEnv(name);
    if (!env.ANTHROPIC_BASE_URL) return Object.keys(pEnv).length === 0;
    return pEnv.ANTHROPIC_BASE_URL === env.ANTHROPIC_BASE_URL;
}

function loadBindings() {
    const raw = readJson(BINDINGS_FILE);
    return raw && typeof raw === 'object' ? raw : {};
}

function saveBindings(bindings) {
    writeJson(BINDINGS_FILE, bindings);
}

function getBinding(sessionId) {
    if (!sessionId) return null;
    const bindings = loadBindings();
    const v = bindings[sessionId];
    return v && listProfiles().includes(v) ? v : null;
}

function setBinding(sessionId, name) {
    if (!sessionId) return;
    const bindings = loadBindings();
    if (name === null) delete bindings[sessionId];
    else if (listProfiles().includes(name)) bindings[sessionId] = name;
    saveBindings(bindings);
}

// --- Retracted messages -----------------------------------------------------------------------
//
// The retract gesture hides a message visually without touching the .jsonl — the agent keeps the
// context, only the view drops the turn. The hidden uuids live here, keyed by session, so a resume
// re-hides them and content search skips them. The set only ever grows: there is no un-retract.
function loadHidden() {
    const raw = readJson(HIDDEN_FILE);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function hiddenMessagesFor(sessionId) {
    if (!sessionId) return [];
    const arr = loadHidden()[sessionId];
    return Array.isArray(arr) ? arr : [];
}

function addHidden(sessionId, uuids) {
    if (!sessionId || !Array.isArray(uuids) || !uuids.length) return;
    const map = loadHidden();
    const set = new Set(map[sessionId] || []);
    for (const u of uuids) if (typeof u === 'string') set.add(u);
    map[sessionId] = [...set];
    writeJson(HIDDEN_FILE, map);
    // The search/timestamp caches hold the session's text as it was before the retract; drop them so
    // the next read rebuilds without the hidden lines.
    S.transcriptTextCache && S.transcriptTextCache.delete(sessionId);
    S.transcriptTimeCache && S.transcriptTimeCache.delete(sessionId);
}

// --- Pinned sessions --------------------------------------------------------------------------
//
// Session ids the history list floats above the rest. A flat array rather than a map: the list is
// short, it is read on every state push, and nothing about it is per-session except membership.
// The order stored here is the order they were pinned in and is not the order they render in — the
// list keeps its own recency order inside the pinned block, so pinning never reshuffles it.
function loadPinned() {
    const raw = readJson(PINNED_FILE);
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id) : [];
}

function setPinned(sessionId, pinned) {
    if (!sessionId || typeof sessionId !== 'string') return;
    const list = loadPinned().filter((id) => id !== sessionId);
    if (pinned) list.push(sessionId);
    writeJson(PINNED_FILE, list);
}

// Nothing else ever revisits the list, and a deleted session's id can never come back — without
// this it would hold its slot for as long as the file lives.
function forgetPinned(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const list = loadPinned();
    if (!list.includes(sessionId)) return false;
    writeJson(PINNED_FILE, list.filter((id) => id !== sessionId));
    return true;
}

function profileFromSettings() {
    const env = currentEnv();
    for (const name of listProfiles()) if (profileMatchesEnv(name, env)) return name;
    return null;
}

function effectiveProfile(sessionId, webview) {
    if (webview && S.profileByWebview.has(webview)) return S.profileByWebview.get(webview);
    return getBinding(sessionId) || profileFromSettings();
}

function managedKeys() {
    const keys = new Set();
    for (const n of listProfiles()) for (const k of Object.keys(profileEnv(n))) keys.add(k);
    return keys;
}

// Credentials and routing that must never cross a provider change. The union of profile keys is
// not enough: a key nobody declares is a key nobody deletes, so an ANTHROPIC_API_KEY sitting in the
// ambient environment would ride along to DeepSeek or GLM. The CLI resolves auth first-match-wins
// (ANTHROPIC_API_KEY before ANTHROPIC_AUTH_TOKEN) and rejects requests carrying both, so a leftover
// key does not just leak — it also breaks the profile's own auth.
const CREDENTIAL_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
];

// True when the profile brings its own routing or credentials, and the ambient ones must therefore go.
// Keying this on ANTHROPIC_BASE_URL alone would miss two real shapes: a profile that only overrides
// ANTHROPIC_AUTH_TOKEN (same endpoint, different account) and one that flips CLAUDE_CODE_USE_BEDROCK
// or _USE_VERTEX. In both, a leftover ANTHROPIC_API_KEY still wins — the CLI reads it first.
//
// A profile with an empty env means "the Anthropic subscription": it declares none of these, so
// nothing is stripped and it keeps inheriting exactly what the user already had.
function crossesProvider(profile) {
    const env = profileEnv(profile);
    return CREDENTIAL_KEYS.some((k) => k in env);
}

const PROXY_SCRIPT = path.join(DIR, 'proxy', 'server.mjs');

function localProxyPort(profile) {
    const url = profileEnv(profile).ANTHROPIC_BASE_URL || '';
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    return match ? Number(match[1]) : null;
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(400);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function ensureProxy(profile) {
    const port = localProxyPort(profile);
    if (!port || !fs.existsSync(PROXY_SCRIPT)) return;
    if (S.proxyStarting) return;
    if (await portIsOpen(port)) return;

    S.proxyStarting = true;
    try {
        const extraEnv = readJson(path.join(DIR, 'proxy.json'))?.env || {};
        const child = spawn(process.execPath, ['--use-env-proxy', PROXY_SCRIPT, '--port', String(port)], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.unref();
        dlog('proxy spawned', { port, profile });
    } catch (e) {
        dlog('proxy spawn failed', e.message);
    } finally {
        setTimeout(() => (S.proxyStarting = false), 3000);
    }
}

const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// The CLI writes <projects>/<cwd-slug>/<sessionId>.jsonl on the first user turn — not on system/init.
// So an id can be perfectly real (the CLI announced it) and still resume to nothing: a session that
// was launched and died before anyone typed. That is what `--resume` answers with "No conversation
// found with session ID …". The disk is the only source that cannot be early, so it is the one that
// decides. Scanned across all project folders, because the id is unique and the slug is not ours to
// reconstruct.
function transcriptPathFor(sessionId) {
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    let dirs = [];
    try {
        dirs = fs.readdirSync(PROJECTS_DIR);
    } catch {
        return null;
    }
    for (const d of dirs) {
        const file = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function transcriptExists(sessionId) {
    return transcriptPathFor(sessionId) !== null;
}

// --- A message id from another provider closes the way back ---------------------------------
//
// The CLI sends `diagnostics: {previous_message_id: <id of the previous answer>}` — its own
// prompt-cache-break diagnosis — and only when the request goes to Anthropic. The id is read off
// the transcript, so a tab that answered on someone else's backend carries that provider's id
// shape: OpenRouter hands out `gen-1787815743-…`. Switch such a session back to Anthropic and
// every turn dies on
//   400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response
//       (starts with `msg_`)
// with no answer at all. There is no retry without the field — the CLI only classifies the failure
// as `previous_message_id_invalid` — and relaunching does not clear it, because the id comes back
// off disk. From Anthropic the session is then unreachable for good.
//
// The CLI builds the field as `previous_message_id: u ?? null` and null is accepted, so dropping
// `message.id` is enough. Only ids no Anthropic endpoint could have issued are touched, only on the
// spawn that is actually going to Anthropic, and every other line is written back byte for byte.
const ANTHROPIC_HOST = /^https?:\/\/api\.anthropic\.com(?:[:\/]|$)/i;

// Where this spawn's requests will land. A profile that brings its own routing answers for itself;
// one with an empty env is the Anthropic subscription and inherits, so the ambient environment and
// settings.json decide — the same layering the CLI itself applies.
function targetsAnthropic(profile, baseEnv) {
    const url =
        profile && crossesProvider(profile)
            ? profileEnv(profile).ANTHROPIC_BASE_URL || ''
            : currentEnv().ANTHROPIC_BASE_URL || (baseEnv && baseEnv.ANTHROPIC_BASE_URL) || '';
    return !url || ANTHROPIC_HOST.test(url);
}

// Rewritten in place rather than through a temp file and a rename: on Windows a rename over a path
// the CLI still holds open fails outright, and this runs in the gap between the old process going
// away and the new one starting.
function stripForeignMessageIds(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return 0;
    let lines;
    try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
        return 0;
    }
    let stripped = 0;
    const out = lines.map((line) => {
        if (!line.includes('"assistant"')) return line;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            return line; // a partially written trailing line while the CLI is mid-append
        }
        const message = row && row.type === 'assistant' ? row.message : null;
        if (!message || typeof message.id !== 'string' || message.id.startsWith('msg_')) return line;
        delete message.id;
        stripped++;
        return JSON.stringify(row);
    });
    if (!stripped) return 0;
    try {
        fs.writeFileSync(file, out.join('\n'), 'utf8');
    } catch (e) {
        console.error('ccx: could not strip foreign message ids', e);
        return 0;
    }
    // Both caches key on mtime+size and would otherwise keep serving the pre-strip bytes
    S.transcriptTextCache && S.transcriptTextCache.delete(sessionId);
    S.transcriptTimeCache && S.transcriptTimeCache.delete(sessionId);
    dlog('foreign message ids stripped', { session: sessionId, lines: stripped });
    console.log(`ccx: dropped ${stripped} foreign message id(s) from ${sessionId} before an Anthropic spawn`);
    return stripped;
}

// --- Live view of a delegated agent ---------------------------------------------------------
//
// A run started through the claudapter MCP server is a separate `claude -p` process: it says nothing
// until it is finished, and from the tab it looks the same whether it is thinking or hung. The server
// now picks the session id before the spawn and drops a manifest in agent-runs/, so the transcript it
// is about to write is known here from the run's first second and can simply be followed.
//
// Everything below is one-way, host to page. Nothing read out of an agent's transcript is ever sent
// back into the tab's own conversation: the parent session's context stays exactly what it was — the
// tool call it made and, at the end, the tool result. This is a window onto the run, not a channel
// into the turn.
const AGENT_RUNS_DIR = path.join(DIR, 'agent-runs');
// A frame shows the tail of a run, not its history. Older lines are dropped as they scroll past,
// which also keeps a long agent transcript from being carried into the page in one message.
const MAX_RUN_EVENTS = 160;
const MAX_EVENT_TEXT = 1200;
// A transcript line is JSON on one line, but a 400 KB tool result is also JSON on one line. The tail
// is read in bounded chunks so a single enormous line cannot pull the whole file into the host.
const MAX_TAIL_BYTES = 512 * 1024;
const RUN_POLL_MS = 700;

function readAgentRuns() {
    let files = [];
    try {
        files = fs.readdirSync(AGENT_RUNS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const runs = [];
    for (const f of files) {
        const run = readJson(path.join(AGENT_RUNS_DIR, f));
        if (run && typeof run.session === 'string') runs.push(run);
    }
    return runs.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// One readable line per tool call: the argument that names what it touched, not the whole input.
function toolArgument(input) {
    if (!input || typeof input !== 'object') return '';
    for (const key of ['file_path', 'command', 'pattern', 'path', 'query', 'url', 'prompt', 'description']) {
        const v = input[key];
        if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return '';
}

function blockEvents(entry, out) {
    const content = entry.message && entry.message.content;
    if (typeof content === 'string') {
        if (content.trim()) out.push({ k: entry.type === 'user' ? 'prompt' : 'text', t: content.slice(0, MAX_EVENT_TEXT) });
        return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim())
            out.push({ k: entry.type === 'user' ? 'prompt' : 'text', t: block.text.slice(0, MAX_EVENT_TEXT) });
        else if (block.type === 'thinking') out.push({ k: 'thinking' });
        else if (block.type === 'tool_use') out.push({ k: 'tool', n: String(block.name || 'tool'), t: toolArgument(block.input) });
        else if (block.type === 'tool_result') out.push({ k: 'result', ok: !block.is_error });
    }
}

// Read only what has been appended since the last pass. A transcript that came back shorter than the
// offset (a fork, a manual edit) is re-read from the start rather than decoded from the middle.
function tailTranscript(sessionId, state) {
    const file = transcriptPathFor(sessionId);
    if (!file) return state;
    let size = 0;
    try {
        size = fs.statSync(file).size;
    } catch {
        return state;
    }
    if (size === state.size) return state;
    let from = size < state.size ? 0 : state.offset;
    if (size < state.size) state.events = [];
    if (size - from > MAX_TAIL_BYTES) from = size - MAX_TAIL_BYTES;

    let text = '';
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(size - from);
        fs.readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString('utf8');
    } catch {
        return state;
    } finally {
        if (fd !== null)
            try {
                fs.closeSync(fd);
            } catch {}
    }

    // The last line may be half-written; its bytes are left unconsumed for the next pass.
    const lines = text.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.trim()) continue;
        let entry = null;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
        blockEvents(entry, state.events);
    }
    if (state.events.length > MAX_RUN_EVENTS) state.events = state.events.slice(-MAX_RUN_EVENTS);
    state.size = size;
    state.offset = size - Buffer.byteLength(trailing, 'utf8');
    return state;
}

function agentRunsPayload() {
    const tails = (S.agentTails ||= new Map());
    const runs = readAgentRuns();
    const alive = new Set(runs.map((r) => r.session));
    for (const id of [...tails.keys()]) if (!alive.has(id)) tails.delete(id);

    return runs.map((run) => {
        let state = tails.get(run.session);
        if (!state) tails.set(run.session, (state = { offset: 0, size: -1, events: [] }));
        tailTranscript(run.session, state);
        return {
            session: run.session,
            parent: typeof run.parent === 'string' ? run.parent : null,
            profile: run.profile || null,
            model: run.model || null,
            mode: run.mode || null,
            cwd: run.cwd || null,
            prompt: typeof run.prompt === 'string' ? run.prompt : '',
            promptLength: run.promptLength ?? (run.prompt ? run.prompt.length : 0),
            resumed: Boolean(run.resumed),
            startedAt: run.startedAt || null,
            finishedAt: run.finishedAt || null,
            state: run.state || 'running',
            turns: run.turns ?? null,
            tokens: run.tokens || null,
            error: run.error || null,
            events: state.events,
        };
    });
}

// Polled rather than watched: the manifest changes twice in a run's life, while the transcript it
// points at grows all the way through. The timer only exists while something is actually running,
// and stops itself one pass after the last run has ended.
function pumpAgentRuns() {
    let payload = [];
    try {
        payload = agentRunsPayload();
    } catch (e) {
        dlog('agent runs failed', e.message);
    }
    const stamp = JSON.stringify(payload);
    if (stamp !== S.agentRunsStamp) {
        S.agentRunsStamp = stamp;
        for (const w of S.webviews) post(w, { type: 'ccx:agentRuns', runs: payload });
    }
    const live = payload.some((r) => r.state === 'running');
    clearTimeout(S.agentRunsTimer);
    S.agentRunsTimer = live ? setTimeout(pumpAgentRuns, RUN_POLL_MS) : null;
}

// A manifest appearing is the one moment the poll has to be woken up; after that it keeps itself
// going for as long as a run is live.
function wakeAgentRuns() {
    clearTimeout(S.agentRunsTimer);
    S.agentRunsTimer = setTimeout(pumpAgentRuns, 0);
}

// --- Content search for the session picker --------------------------------------------------
//
// The stock search box only matches a row's title and git branch, both already in memory for every
// visible row. Matching the conversation itself means reading the transcript, so it stays a separate,
// lazy pass: the webview sends the ids it currently has on screen, keyed on a search query, and this
// greps each one's raw .jsonl text — no JSON parsing, the query sits in the encoded message content
// either way and parsing every line just to throw the structure away buys nothing.
//
// Cached per session on mtime+size, because the picker searches on every keystroke's pause and a
// transcript that has not changed since the last one costs nothing to check again. Capped rather than
// left to grow: transcripts run from a few KB to several MB, and a long-lived window that has searched
// its way through a large history should not end up holding all of it in memory at once.
const MAX_CACHED_TRANSCRIPTS = 200;

function transcriptSearchText(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return null;
    const cache = (S.transcriptTextCache ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        const hit = cache.get(sessionId);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.lower;
        const raw = fs.readFileSync(file, 'utf8');
        let lower;
        const hidden = hiddenMessagesFor(sessionId);
        if (hidden.length) {
            // A retracted message must stop matching content search. That means parsing per line to
            // know each line's uuid — a cost only paid for sessions that have retracted something;
            // every other session keeps the plain raw-text grep.
            const skip = new Set(hidden);
            const parts = [];
            for (const line of raw.split('\n')) {
                if (!line) continue;
                let row;
                try {
                    row = JSON.parse(line);
                } catch {
                    parts.push(line.toLowerCase());
                    continue;
                }
                if (row && typeof row.uuid === 'string' && skip.has(row.uuid)) continue;
                parts.push(line.toLowerCase());
            }
            lower = parts.join('\n');
        } else {
            lower = raw.toLowerCase();
        }
        if (cache.size >= MAX_CACHED_TRANSCRIPTS) cache.delete(cache.keys().next().value);
        cache.set(sessionId, { mtimeMs, size, lower });
        return lower;
    } catch {
        return null;
    }
}

function searchTranscripts(query, sessionIds) {
    const needle = (query || '').toLowerCase().trim();
    if (!needle || !Array.isArray(sessionIds)) return [];
    const out = [];
    for (const id of sessionIds) {
        if (typeof id !== 'string') continue;
        const text = transcriptSearchText(id);
        if (text && text.includes(needle)) out.push(id);
    }
    return out;
}

// --- When each message was actually sent, keyed by message uuid ------------------------------
//
// The webview cannot answer this about its own transcript. Its message class declares
// `constructor(type, content, {uuid, betaMessageId, timestamp = Date.now(), …})` — the timestamp is
// an OPTIONAL field defaulting to now, and history replayed to seed a resume is rebuilt without one.
// So every past message reports the moment the transcript was reconstructed, which is why they all
// showed the same near-current time no matter how old the conversation was. Live messages are the
// only ones whose in-page timestamp means anything, and only until the next reload.
//
// The .jsonl line each message came from does carry the real one, next to the same uuid the page
// holds. Same mtime+size cache as the content search, and the same cap — parsing is per line, so a
// long transcript is worth not re-reading on every repaint.
function transcriptTimestamps(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return null;
    const cache = (S.transcriptTimeCache ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        const hit = cache.get(sessionId);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.map;
        const map = {};
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            let row;
            try {
                row = JSON.parse(line);
            } catch {
                continue; // a partially written trailing line while the CLI is mid-append
            }
            if (!row || typeof row.uuid !== 'string' || !row.timestamp) continue;
            const ms = Date.parse(row.timestamp);
            // Milliseconds rather than the ISO string: a few thousand of these travel in one message,
            // and the page only ever feeds them to `new Date(...)` anyway.
            if (!isNaN(ms)) map[row.uuid] = ms;
        }
        if (cache.size >= MAX_CACHED_TRANSCRIPTS) cache.delete(cache.keys().next().value);
        cache.set(sessionId, { mtimeMs, size, map });
        return map;
    } catch {
        return null;
    }
}

function envFor(baseEnv, resumeSessionId, opts) {
    // Guarding the resume is independent of the profile: even a plain Anthropic tab can be relaunched
    // by the extension itself with an id whose transcript never came to be. Clearing opts.resume here
    // is what turns `--resume=<id>` into a fresh start — the SDK reads that field after this runs.
    if (opts && resumeSessionId && !transcriptExists(resumeSessionId)) {
        dlog('resume dropped', { session: resumeSessionId, reason: 'no transcript on disk' });
        console.log(`ccx: dropping --resume ${resumeSessionId} — no transcript on disk, starting fresh`);
        opts.resume = undefined;
        resumeSessionId = undefined;
    }
    const profile = S.pendingProfile || getBinding(resumeSessionId);
    // Ahead of the early return, because a tab with no profile at all is the plainest way back to
    // Anthropic — and the one that would otherwise keep failing with nothing in the log to explain it.
    if (resumeSessionId && targetsAnthropic(profile, baseEnv)) stripForeignMessageIds(resumeSessionId);
    if (!profile) return baseEnv;
    const env = { ...baseEnv };
    for (const k of managedKeys()) delete env[k];
    if (crossesProvider(profile)) for (const k of CREDENTIAL_KEYS) delete env[k];
    Object.assign(env, profileEnv(profile));

    // Local adapter: without this the CLI routes even 127.0.0.1 through the corporate proxy and cannot connect
    if (localProxyPort(profile)) {
        const noProxy = '127.0.0.1,localhost';
        env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
        env.no_proxy = env.NO_PROXY;
    }
    dlog('envFor', { profile, session: resumeSessionId || 'new', baseUrl: profileEnv(profile).ANTHROPIC_BASE_URL });
    console.log(`ccx: spawning with profile "${profile}" (session ${resumeSessionId || 'new'})`);
    return env;
}

// The CLI layers ~/.claude/settings.json's `env` block on top of the spawn environment. Its own
// filter would strip provider keys, but only for hosts it treats as managed — the list is
// ["claude-desktop","claude-desktop-3p","local-agent"] and "claude-vscode" is not in it. So whatever
// is left in that block silently outranks the per-tab profile, which is exactly the hand-editing
// this project exists to replace. Warn instead of editing: settings.json is the user's file and
// claudapter never writes to it.
function warnSettingsOverride(profile) {
    const settings = currentEnv();
    const wanted = profileEnv(profile);
    // Coerced, because settings.json is hand-written JSON and a number or boolean there means the same
    // thing as its string form once it reaches process.env — warning about that would be pure noise.
    const conflicting = Object.keys(settings).filter((k) =>
        k in wanted ? String(settings[k]) !== String(wanted[k]) : CREDENTIAL_KEYS.includes(k),
    );
    if (!conflicting.length) return;

    const stamp = `${profile}:${conflicting.slice().sort().join(',')}`;
    if (S.warnedOverrides.has(stamp)) return;
    S.warnedOverrides.add(stamp);
    dlog('settings override', { profile, keys: conflicting });
    vscode.window.showWarningMessage(
        `~/.claude/settings.json sets ${conflicting.join(', ')}. Claude Code applies that on top of ` +
            `the spawn environment, so it overrides the "${profile}" profile in every tab. ` +
            `Remove those keys from settings.json for per-tab switching to take effect.`,
    );
}

function panelProfile(panel) {
    const sessionId = S.activeSessionByPanel.get(panel);
    return effectiveProfile(sessionId, panel.webview);
}

function modelsOf(name) {
    const env = profileEnv(name);
    return {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '',
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || '',
    };
}

// --- The attachment draft, in the language from /config ------------------------------------------
//
// /config writes `language` into ~/.claude/settings.json, and the CLI accepts three shapes for it: a
// name ("russian"), that name in its own script ("русский"), or a code or locale ("ru", "ru-RU").
// The twenty languages below are exactly the ones it resolves; anything else falls back to English
// there, so it falls back here too — the draft should never be in a language the answer will not be.
//
// The wording is the payload: one row per language, the noun going into %s so the carrier sentence
// is written once. To reword a language, edit its row and nothing else.
const NOUN_KEYS = ['image', 'images', 'attachment', 'attachments'];

// The retract instruction is deliberately NOT localised the way the attachment and resume prompts
// are. Those are written into the user's visible composer, so they must read like the user's own
// prose; the retract instruction is meant to be hidden the moment it renders, and the extension's
// own UI is English, so the wording is English for every language.
const RETRACT_TEMPLATE = 'The message «%s» was a mistake — ignore it and your response to it.';

const LANGUAGES = {
    en: {
        names: ['english'],
        prompt: 'Analyse the %s in the context of this conversation',
        nouns: ['image', 'images', 'attachment', 'attachments'],
        resume: "Continue from where you stopped",
    },
    es: {
        names: ['spanish', 'español', 'espanol'],
        prompt: 'Analiza %s en el contexto de esta conversación',
        nouns: ['la imagen', 'las imágenes', 'el archivo adjunto', 'los archivos adjuntos'],
        resume: "Continúa desde donde lo dejaste",
    },
    fr: {
        names: ['french', 'français', 'francais'],
        prompt: 'Analyse %s dans le contexte de cette conversation',
        nouns: ["l'image", 'les images', 'la pièce jointe', 'les pièces jointes'],
        resume: "Reprends là où tu t'es arrêté",
    },
    ja: {
        names: ['japanese', '日本語'],
        prompt: 'この会話の文脈で%sを分析してください',
        nouns: ['画像', '画像', '添付ファイル', '添付ファイル'],
        resume: "中断したところから続けてください",
    },
    de: {
        names: ['german', 'deutsch'],
        prompt: 'Analysiere %s im Kontext dieser Unterhaltung',
        nouns: ['das Bild', 'die Bilder', 'den Anhang', 'die Anhänge'],
        resume: "Mach dort weiter, wo du aufgehört hast",
    },
    pt: {
        names: ['portuguese', 'português', 'portugues'],
        prompt: 'Analise %s no contexto desta conversa',
        nouns: ['a imagem', 'as imagens', 'o anexo', 'os anexos'],
        resume: "Continue de onde parou",
    },
    it: {
        names: ['italian', 'italiano'],
        prompt: 'Analizza %s nel contesto di questa conversazione',
        nouns: ["l'immagine", 'le immagini', "l'allegato", 'gli allegati'],
        resume: "Riprendi da dove ti sei fermato",
    },
    ko: {
        // The object particle is part of the noun: 이미지 takes 를, 첨부 파일 takes 을
        names: ['korean', '한국어'],
        prompt: '이 대화의 맥락에서 %s 분석해 주세요',
        nouns: ['이미지를', '이미지들을', '첨부 파일을', '첨부 파일들을'],
        resume: "중단된 지점부터 이어서 진행해 주세요",
    },
    hi: {
        names: ['hindi', 'हिन्दी', 'हिंदी'],
        prompt: 'इस बातचीत के संदर्भ में %s का विश्लेषण करें',
        nouns: ['छवि', 'छवियों', 'संलग्न फ़ाइल', 'संलग्न फ़ाइलों'],
        resume: "जहाँ रुके थे वहीं से जारी रखें",
    },
    id: {
        names: ['indonesian', 'bahasa indonesia', 'bahasa'],
        prompt: 'Analisis %s dalam konteks percakapan ini',
        nouns: ['gambar', 'gambar-gambar', 'lampiran', 'lampiran-lampiran'],
        resume: "Lanjutkan dari tempat kamu berhenti",
    },
    ru: {
        names: ['russian', 'русский'],
        prompt: 'Проанализируй %s в контексте этого диалога',
        nouns: ['изображение', 'изображения', 'вложение', 'вложения'],
        resume: "Продолжай с того места, где остановился",
    },
    pl: {
        names: ['polish', 'polski'],
        prompt: 'Przeanalizuj %s w kontekście tej rozmowy',
        nouns: ['obraz', 'obrazy', 'załącznik', 'załączniki'],
        resume: "Kontynuuj od miejsca, w którym przerwałeś",
    },
    tr: {
        names: ['turkish', 'türkçe', 'turkce'],
        prompt: 'Bu sohbetin bağlamında %s analiz et',
        nouns: ['görseli', 'görselleri', 'eki', 'ekleri'],
        resume: "Kaldığın yerden devam et",
    },
    nl: {
        names: ['dutch', 'nederlands'],
        prompt: 'Analyseer %s in de context van dit gesprek',
        nouns: ['de afbeelding', 'de afbeeldingen', 'de bijlage', 'de bijlagen'],
        resume: "Ga verder waar je gebleven was",
    },
    uk: {
        names: ['ukrainian', 'українська'],
        prompt: 'Проаналізуй %s у контексті цієї розмови',
        nouns: ['зображення', 'зображення', 'вкладення', 'вкладення'],
        resume: "Продовжуй з того місця, де зупинився",
    },
    el: {
        names: ['greek', 'ελληνικά'],
        prompt: 'Ανάλυσε %s στο πλαίσιο αυτής της συζήτησης',
        nouns: ['την εικόνα', 'τις εικόνες', 'το συνημμένο', 'τα συνημμένα'],
        resume: "Συνέχισε από εκεί που σταμάτησες",
    },
    cs: {
        names: ['czech', 'čeština', 'cestina'],
        prompt: 'Analyzuj %s v kontextu této konverzace',
        nouns: ['obrázek', 'obrázky', 'přílohu', 'přílohy'],
        resume: "Pokračuj tam, kde jsi skončil",
    },
    da: {
        names: ['danish', 'dansk'],
        prompt: 'Analysér %s i konteksten af denne samtale',
        nouns: ['billedet', 'billederne', 'den vedhæftede fil', 'de vedhæftede filer'],
        resume: "Fortsæt hvor du slap",
    },
    sv: {
        names: ['swedish', 'svenska'],
        prompt: 'Analysera %s i kontexten av den här konversationen',
        nouns: ['bilden', 'bilderna', 'bilagan', 'bilagorna'],
        resume: "Fortsätt där du slutade",
    },
    no: {
        names: ['norwegian', 'norsk'],
        prompt: 'Analyser %s i konteksten av denne samtalen',
        nouns: ['bildet', 'bildene', 'vedlegget', 'vedleggene'],
        resume: "Fortsett der du slapp",
    },
};

// Same order of attempts as the CLI: an exact code, then a name, then the part before the dash so a
// full locale still lands. Unrecognised is English, which is also what the CLI answers in.
function languageOf(value) {
    if (typeof value !== 'string') return 'en';
    const wanted = value.toLowerCase().trim();
    if (!wanted) return 'en';
    if (LANGUAGES[wanted]) return wanted;
    for (const code of Object.keys(LANGUAGES)) if (LANGUAGES[code].names.includes(wanted)) return code;
    const base = wanted.split('-')[0];
    return LANGUAGES[base] ? base : 'en';
}

// The webview is handed the four finished sentences rather than the language, so it only has to look
// at what is attached. Riding on ccx:state means a /config change repaints them without a reload:
// settings.json is already watched, and every change broadcasts.
function attachmentPrompts() {
    const lang = LANGUAGES[languageOf(readJson(SETTINGS_FILE)?.language)] || LANGUAGES.en;
    const out = {};
    NOUN_KEYS.forEach((key, i) => {
        out[key] = lang.prompt.replace('%s', lang.nouns[i]);
    });
    // The resume and retract phrases ride on the same payload — one less field on ccx:state, and the
    // webview reads them from the same place it reads the attachment prompts. The resume prompt is
    // per-language like the drafts; the retract instruction is English for every language (see above).
    out.resume = lang.resume;
    out.retract = RETRACT_TEMPLATE;
    return out;
}

function selectedModelAndEffort() {
    const settings = readJson(SETTINGS_FILE);
    const model = typeof settings?.model === 'string' ? settings.model.replace(/\[1m\]$/, '').trim() : '';
    const effort = typeof settings?.effortLevel === 'string' ? settings.effortLevel.trim() : '';
    return { model: model || null, effort: effort || null };
}

function stateFor(sessionId, webview) {
    const profiles = listProfiles();
    const active = effectiveProfile(sessionId, webview);
    const selection = selectedModelAndEffort();
    return {
        // A weak id stays on the host. The page adopts whatever arrives here as state.sessionId and
        // hands it straight back on ccx:apply as the id to resume — so a weak one would leave here as
        // a guess and come back as an authoritative `--resume <id>`. It resolves the profile and the
        // models exactly as before; it is only not repeated to the page.
        sessionId: (webview && webview.__ccxSessionWeak ? null : sessionId) || null,
        active,
        selectedModel: selection.model,
        effortLevel: selection.effort,
        // The history list resolves each row's provider from here
        bindings: loadBindings(),
        attachmentPrompts: attachmentPrompts(),
        hiddenMessages: hiddenMessagesFor(sessionId),
        // Not about this tab's session — the whole list, since the history list is what reads it
        pinnedSessions: loadPinned(),
        models: active && active !== 'claude' ? modelsOf(active) : null,
        profiles: profiles.map((name) => {
            const env = profileEnv(name);
            return {
                name,
                model: modelOf(env),
                baseUrl: env.ANTHROPIC_BASE_URL || '',
            };
        }),
    };
}

// Profile icon lives next to the profile itself: ~/.claude/profiles/<name>.png|svg
function profileIconFile(name) {
    for (const ext of ICON_EXTENSIONS) {
        const file = path.join(PROFILES_DIR, `${name}.${ext}`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function hue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}

function generatedIcon(name) {
    const color = `hsl(${hue(name)} 65% 52%)`;
    const letter = name[0].toUpperCase();
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
        `<circle cx="8" cy="8" r="7" fill="${color}"/>` +
        `<text x="8" y="11.5" font-family="Segoe UI, sans-serif" font-size="9" font-weight="600" ` +
        `text-anchor="middle" fill="#fff">${letter}</text></svg>`;
    const out = path.join(ICONS_DIR, 'generated', `${name}.svg`);
    try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== svg) fs.writeFileSync(out, svg, 'utf8');
        return out;
    } catch {
        return null;
    }
}

function iconForProfile(name) {
    if (!name) return defaultIcon();
    const own = profileIconFile(name);
    if (own) return own;
    // Anthropic subscription profile (empty env) without its own icon keeps the stock logo
    if (Object.keys(profileEnv(name)).length === 0) return defaultIcon();
    return generatedIcon(name) || defaultIcon();
}

function brandIconFor(panel) {
    const profile = panelProfile(panel);
    if (!profile) return null;
    const icon = iconForProfile(profile);
    return icon && icon !== defaultIcon() ? icon : null;
}

// Which of the three stock logos the extension is trying to install, if any
function stockLogoState(value) {
    const uri = value && (value.fsPath || value.path || value.light?.fsPath || value.light?.path);
    if (typeof uri !== 'string') return null;
    const file = path.basename(uri).toLowerCase();
    for (const [state, name] of Object.entries(STOCK_LOGO)) if (file === name) return state;
    return null;
}

const BADGE_COLOR = { done: '#D97757', pending: '#3B82F6' };
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };

// A stock indicator icon is the logo with a hole punched in the corner and a dot dropped into it.
// Repeat that geometry over the profile icon, otherwise indication simply replaces the brand.
function badgedIcon(src, state) {
    const color = BADGE_COLOR[state];
    if (!color) return src;
    const cache = (S.badges ||= new Map());
    const key = `${src}|${state}`;
    try {
        const { mtimeMs, size } = fs.statSync(src);
        const hit = cache.get(key);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size && fs.existsSync(hit.out)) return hit.out;

        const ext = path.extname(src).toLowerCase();
        const data = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(src).toString('base64')}`;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em">` +
            `<defs><mask id="ccx-badge"><rect width="24" height="24" fill="white"/>` +
            `<circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs>` +
            `<image href="${data}" x="0" y="0" width="24" height="24" mask="url(#ccx-badge)"/>` +
            `<circle cx="19.5" cy="4.5" r="4.5" fill="${color}"/></svg>`;
        const out = path.join(ICONS_DIR, 'badged', `${path.basename(src, ext)}-${state}.svg`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        let current = null;
        try {
            current = fs.readFileSync(out, 'utf8');
        } catch {}
        if (current !== svg) fs.writeFileSync(out, svg, 'utf8');
        cache.set(key, { mtimeMs, size, out });
        return out;
    } catch {
        return src;
    }
}

// The webview cannot reference ~/.claude/profiles by URI — localResourceRoots covers only the
// extension's own webview/ and resources/ — so the bytes travel inside the message instead.
// The webview CSP lists data: in img-src, which is what makes this work at all.
function iconDataUri(file) {
    if (!file) return null;
    // Cached on S, not in a module const: the injected require() drops this module from the cache every call
    const cache = (S.iconUris ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        if (size > MAX_ICON_BYTES) return null;
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.uri;
        const ext = path.extname(file).toLowerCase();
        const uri = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
        cache.set(file, { mtimeMs, size, uri });
        return uri;
    } catch {
        return null;
    }
}

// { profileName: dataUri } — the same resolution order as the tab icon, without the state badge:
// the history list wants the plain brand mark, not a pending/done indicator
function profileIcons() {
    const out = {};
    for (const name of listProfiles()) {
        try {
            const uri = iconDataUri(iconForProfile(name));
            if (uri) out[name] = uri;
        } catch {}
    }
    return out;
}

function iconFor(panel, state) {
    const brand = brandIconFor(panel);
    if (brand) return badgedIcon(brand, state);
    return defaultIcon(state) || defaultIcon();
}

function hookIcon(panel) {
    if (panel.__ccxIconHooked) return;
    const proto = Object.getPrototypeOf(panel);
    const d =
        Object.getOwnPropertyDescriptor(panel, 'iconPath') || (proto && Object.getOwnPropertyDescriptor(proto, 'iconPath'));
    if (!d || !d.set || !d.get) return;
    panel.__ccxIconHooked = true;
    Object.defineProperty(panel, 'iconPath', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
            return d.get.call(panel);
        },
        set(value) {
            const state = stockLogoState(value);
            if (!state) return d.set.call(panel, value);
            // Remembered so a later decorate() re-paints the icon in the state the extension last asked for
            panel.__ccxIconState = state;
            const icon = iconFor(panel, state);
            if (!icon) return d.set.call(panel, value);
            const uri = vscode.Uri.file(icon);
            d.set.call(panel, { light: uri, dark: uri });
        },
    });
}

function decorate(panel) {
    hookIcon(panel);
    try {
        const uri = vscode.Uri.file(iconFor(panel, panel.__ccxIconState || 'idle'));
        panel.iconPath = { light: uri, dark: uri };
    } catch {}
}

function post(webview, message) {
    try {
        Promise.resolve(webview.postMessage(message)).catch(() => S.webviews.delete(webview));
    } catch {
        S.webviews.delete(webview);
    }
}

// A session with no binding ran on whatever settings.json said at the time, so the row falls back to the
// profile that matches settings.json now — for an untouched install that is the Anthropic subscription and
// the stock mark. Where settings.json points somewhere no profile describes, we genuinely do not know.
function fallbackIcon(icons) {
    const name = profileFromSettings();
    if (name) return icons[name] ? { name, uri: icons[name] } : null;
    if (currentEnv().ANTHROPIC_BASE_URL) return null;
    const uri = iconDataUri(defaultIcon());
    return uri ? { name: 'claude', uri } : null;
}

// Tens of kilobytes of base64. Sent once per webview and again only when the icon set actually
// changes — deliberately not folded into ccx:state, which is re-posted on every binding write
function postIcons(webview) {
    try {
        const icons = profileIcons();
        const fallback = fallbackIcon(icons);
        const stamp =
            Object.keys(icons)
                .map((n) => `${n}:${icons[n].length}`)
                .join(',') + `|${fallback ? `${fallback.name}:${fallback.uri.length}` : ''}`;
        if (webview.__ccxIconStamp === stamp) return;
        webview.__ccxIconStamp = stamp;
        post(webview, { type: 'ccx:icons', icons, fallback });
    } catch {}
}

function broadcast() {
    for (const panel of S.panels.keys()) decorate(panel);
    for (const w of S.webviews) {
        postIcons(w);
        const sessionId = w.__ccxSessionId || null;
        post(w, { type: 'ccx:state', ...stateFor(sessionId, w) });
    }
}

// Returns the watcher: without it the caller's `if (!S.xWatcher)` guard never latches and every
// attach installs another fs.watch on the same directory
function watchFile(file, onChange) {
    if (!fs.existsSync(path.dirname(file))) return null;
    let timer = null;
    try {
        return fs.watch(path.dirname(file), (_e, name) => {
            if (name && path.basename(file) !== name) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, 200);
        });
    } catch {
        return null;
    }
}

function watchDir(dir, onChange, delay = 200) {
    if (!fs.existsSync(dir)) return null;
    let timer = null;
    try {
        return fs.watch(dir, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, delay);
        });
    } catch {
        return null;
    }
}

const PATCHER = path.join(DIR, 'apply-patch.mjs');
// A folder still being unpacked reads exactly like one whose signatures moved, so a failure is retried
// a couple of times before it is reported
const REPATCH_TRIES = 3;

function offerReload(message) {
    try {
        vscode.window.showInformationMessage(message, 'Reload Window').then((choice) => {
            if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    } catch {}
}

// Matching signatures are not a promise that the code around them still means the same thing — most of
// them match the *shape* of an assignment, and a release can move what is being assigned without moving
// the shape. A hand-run patch prints the version mismatch for someone who is reading; an automatic one
// has no reader, so the notification is the only place the mismatch can surface.
function reloadMessage(out) {
    const [, installed, verified] = out.match(/^ccx-unverified: (\S+) (\S+)$/m) || [];
    if (!installed) return 'Claudapter: Claude Code was updated — the patch has been re-applied.';
    const published = upstreamCovers(out);
    if (published)
        return (
            `Claudapter: the patch was re-applied on Claude Code ${installed}, verified only against ` +
            `${verified}. It went on cleanly, and Claudapter ${published} is published — pull it for ` +
            'signatures that were checked against this release.'
        );
    return (
        `Claudapter: the patch was re-applied on Claude Code ${installed}, which is newer than the ` +
        `${verified} it was verified against. It went on cleanly, but nothing has checked this version.`
    );
}

function versionOfDir(dir) {
    return (path.basename(dir).match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
}

// The patcher answers "is there a release that knows this extension" on its last line; `covers` is the
// only answer worth acting on, and it turns "the patch broke" into "pull and re-run the installer"
function upstreamCovers(out) {
    const [, published, standing] = out.match(/^ccx-upstream: (\S+) (\S+)$/m) || [];
    return standing === 'covers' ? published : null;
}

function repositoryUrl() {
    const url = readJson(path.join(DIR, 'patch-version.json'))?.repository;
    return typeof url === 'string' ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null;
}

function showUpdateProblem(message) {
    const repository = repositoryUrl();
    const actions = [...(repository ? ['Open repository'] : []), 'Show log'];
    try {
        vscode.window.showWarningMessage(message, ...actions).then((choice) => {
            if (choice === 'Open repository') vscode.env.openExternal(vscode.Uri.parse(repository));
            if (choice === 'Show log') vscode.window.showTextDocument(vscode.Uri.file(LOG_FILE));
        });
    } catch {}
}

// A Claude Code update installs a new folder beside the running one, and the patch lives inside the
// folder it replaces — so every update throws it away. This window keeps running the old, patched
// bundle until it reloads, and that is the only stretch of time in which anything of Claudapter is
// alive to notice: the window that comes up afterwards loads a clean bundle, which never requires this
// file. Patching the new folder now means the reload VS Code is about to ask for comes up patched, with
// no second reload and nothing to run by hand. The case this cannot reach — an update applied while VS
// Code was closed — is what the keeper extension is for.
//
// process.execPath is Code.exe in the extension host; ELECTRON_RUN_AS_NODE turns it back into node, the
// same way the proxy is spawned.
function repatchAfterUpdate() {
    const tries = (S.repatchTries ||= new Map());
    if (S.repatching || !fs.existsSync(PATCHER)) return;

    let running = null;
    try {
        running = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath || null;
    } catch {}
    const newest = newestExtensionDir();
    if (!running || !newest || path.resolve(newest) === path.resolve(running)) return;

    // Every write anywhere under ~/.vscode/extensions wakes the watcher, so a folder already settled —
    // patched, or refused because its signatures moved — must not be spawned against again
    const attempt = tries.get(newest) || 0;
    if (attempt >= REPATCH_TRIES) return;
    tries.set(newest, attempt + 1);
    S.repatching = true;

    let out = '';
    const settle = (code) => {
        S.repatching = false;
        dlog('repatch', { dir: path.basename(newest), code, out: out.trim() });
        if (code === 0) {
            tries.set(newest, REPATCH_TRIES);
            if (out.includes('ccx-result: patched')) offerReload(reloadMessage(out));
            return;
        }
        if (attempt + 1 < REPATCH_TRIES) return void setTimeout(repatchAfterUpdate, 15000);
        // The patcher never writes when a signature no longer matches, so the new bundle is intact and
        // clean: Claude Code works, Claudapter is off until the signatures are updated. The frozen copy
        // cannot update itself, so the one thing worth saying is whether the fix is already published.
        const version = versionOfDir(newest) || 'as installed';
        const published = upstreamCovers(out);
        showUpdateProblem(
            published
                ? `Claudapter: the patch does not fit Claude Code ${version}, but Claudapter ${published} is ` +
                      'published. Pull it and re-run "node scripts/install.mjs".'
                : `Claudapter: the patch does not fit Claude Code ${version} — its signatures moved, so it ` +
                      'was not applied. Claude Code itself is untouched and working.',
        );
    };

    try {
        const child = spawn(process.execPath, [PATCHER, '--if-needed', `--dir=${newest}`], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
        });
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (out += b));
        child.on('error', (e) => {
            out += `\n${e.message}`;
            settle(1);
        });
        child.on('close', settle);
    } catch (e) {
        out += `\n${e.message}`;
        settle(1);
    }
}

// Installed from attachWebview, not only from attachPanel: the session list is a sidebar webview
// with no panel of its own, and it still has to see bindings.json change to repaint its icons
function ensureWatchers() {
    if (!S.agentRunsWatcher) {
        try {
            fs.mkdirSync(AGENT_RUNS_DIR, { recursive: true });
        } catch {}
        S.agentRunsWatcher = watchDir(AGENT_RUNS_DIR, wakeAgentRuns);
    }
    if (!S.settingsWatcher) S.settingsWatcher = watchFile(SETTINGS_FILE, broadcast);
    if (!S.bindingsWatcher) S.bindingsWatcher = watchFile(BINDINGS_FILE, broadcast);
    if (!S.profilesWatcher) S.profilesWatcher = watchDir(PROFILES_DIR, broadcast);
    if (!S.extensionsWatcher) {
        // An extension install writes a whole tree and then renames it into place, so the burst is long
        // — 200 ms would spawn the patcher at a half-written folder
        S.extensionsWatcher = watchDir(EXTENSIONS_ROOT, repatchAfterUpdate, 3000);
        // The update may already have landed before this tab was opened, and that write is gone
        repatchAfterUpdate();
    }
}

function panelFor(webview) {
    for (const p of S.panels.keys()) if (p.webview === webview) return p;
    return null;
}

// `weak` marks an id lifted out of a request envelope rather than out of this tab's own channel.
// Those ids are not reliably the active session, so they may only fill a gap — never overwrite an id
// the channel gave us, and never create a binding. Getting that wrong writes a profile against a
// session the user never switched, and the wrong provider then sticks to it.
function noteSessionId(webview, sessionId, weak = false) {
    if (!sessionId || webview.__ccxSessionId === sessionId) return;
    if (weak && webview.__ccxSessionId) return;
    webview.__ccxSessionId = sessionId;
    // Remembered so a later ccx:apply does not bind against an id only a weak source ever confirmed
    webview.__ccxSessionWeak = weak;
    const forTab = S.profileByWebview.get(webview);
    if (forTab && !weak) setBinding(sessionId, forTab);
    const panel = panelFor(webview);
    if (panel) {
        S.activeSessionByPanel.set(panel, sessionId);
        decorate(panel);
    }
    post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
}

function interceptOutgoing(webview) {
    if (webview.__ccxPatched) return;
    webview.__ccxPatched = true;
    const original = webview.postMessage.bind(webview);
    webview.postMessage = (msg) => {
        try {
            const envelope = msg && msg.type === 'from-extension' ? msg.message : null;
            const sdk = envelope && envelope.type === 'io_message' ? envelope.message : null;
            if (sdk && sdk.type === 'system' && sdk.subtype === 'init' && sdk.session_id)
                noteSessionId(webview, sdk.session_id);
        } catch {}
        return original(msg);
    };
}

function attachWebview(webview) {
    interceptOutgoing(webview);
    ensureWatchers();
    if (S.webviews.has(webview)) return;
    S.webviews.add(webview);

    webview.onDidReceiveMessage((m) => {
        if (!m || typeof m.type !== 'string') return;

        if (m.type === 'launch_claude') {
            if (m.resume) webview.__ccxSessionId = m.resume;
            S.pendingProfile = S.profileByWebview.get(webview) || getBinding(m.resume) || null;
            dlog('launch_claude', { channelId: m.channelId, resume: m.resume || null, profile: S.pendingProfile });
            if (S.pendingProfile) ensureProxy(S.pendingProfile);
            return;
        }
        // Launch is not the only moment the adapter has to be up. It is a detached process, so it can
        // outlive nothing in particular: a crash, a kill, or the machine sleeping leaves the port shut
        // while the tab stays open, and every prompt then dies on ConnectionRefused with no path back —
        // the CLI's retries cannot help, and nothing here was listening. `io_message` is the webview
        // handing over a user turn, which is exactly when it matters, and ensureProxy already no-ops
        // unless the profile routes through 127.0.0.1 and that port is actually closed.
        if (m.type === 'io_message') {
            const profile = effectiveProfile(webview.__ccxSessionId, webview);
            if (profile && localProxyPort(profile)) ensureProxy(profile);
            return;
        }
        // Only update_session_state is about the tab's own session; delete_session, rename_session and
        // open_in_editor carry the id of whichever history row the user clicked. Even this one is emitted
        // once more for the session that just STOPPED being active, so it counts as a weak source.
        if (m.type === 'request' && m.request && m.request.type === 'update_session_state') {
            const id = m.request.sessionId;
            if (id && typeof id === 'string') noteSessionId(webview, id, true);
        }
        // A pin outlives the session it points at unless the deletion is noticed here — this is the
        // only moment the id passes through, and the row is gone by the time anything else looks.
        if (m.type === 'request' && m.request && m.request.type === 'delete_session') {
            if (forgetPinned(m.request.sessionId)) broadcast();
        }
        if (!m.type.startsWith('ccx:')) return;

        const sessionId = webview.__ccxSessionId || m.sessionId || null;
        if (m.type === 'ccx:get') {
            postIcons(webview);
            post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
            // A tab that opens while a run is already going gets its frame filled in rather than
            // waiting for the next line of that agent's transcript.
            S.agentRunsStamp = null;
            wakeAgentRuns();
        } else if (m.type === 'ccx:session') {
            // The webview tracks the active channel itself, so this id is authoritative
            webview.__ccxSessionId = m.sessionId || null;
            webview.__ccxSessionWeak = false;
            const forTab = S.profileByWebview.get(webview);
            if (webview.__ccxSessionId && forTab) setBinding(webview.__ccxSessionId, forTab);
            for (const p of S.panels.keys())
                if (p.webview === webview) {
                    S.activeSessionByPanel.set(p, webview.__ccxSessionId);
                    decorate(p);
                }
            post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
        } else if (m.type === 'ccx:apply') {
            const name = m.name || null;
            try {
                S.profileByWebview.set(webview, name);
                S.pendingProfile = name;
                if (name) {
                    ensureProxy(name);
                    warnSettingsOverride(name);
                }
                // m.sessionId comes from the webview's own channel bookkeeping, so it outranks an id
                // only a weak source confirmed. With neither, the binding waits: profileByWebview is
                // already set, so noteSessionId writes it as soon as the channel reports a real id.
                //
                // A weak id is never echoed back either — the webview adopts whatever it receives here
                // as state.sessionId and resumes on it, so handing it a guess would reopen the wrong
                // conversation. Sending null leaves it on its own per-channel record, which is right.
                const known = (webview.__ccxSessionWeak ? null : webview.__ccxSessionId) || m.sessionId || null;
                if (known) setBinding(known, name);
                broadcast();
                dlog('ccx:apply', { name, sessionId: known, bound: Boolean(known) });
                post(webview, { type: 'ccx:applied', sessionId: known, name });
            } catch (e) {
                vscode.window.showErrorMessage(`Provider switch failed: ${e.message}`);
            }
        } else if (m.type === 'ccx:searchContent') {
            post(webview, { type: 'ccx:searchResults', seq: m.seq, matches: searchTranscripts(m.query, m.sessionIds) });
        } else if (m.type === 'ccx:spellcheck') {
            // The request contains a bounded, de-duplicated list of Russian words, not the draft. Do
            // not log it: a prompt can contain names, hostnames or other sensitive project context.
            checkedWords(m.words).then((result) => {
                post(webview, {
                    type: 'ccx:spellcheckResult',
                    seq: typeof m.seq === 'number' ? m.seq : null,
                    unknown: result ? [...result.unknown] : null,
                    suggestions: result ? result.suggestions : null,
                });
            });
        } else if (m.type === 'ccx:timestamps') {
            const id = m.sessionId || sessionId;
            post(webview, { type: 'ccx:timestampsResult', sessionId: id, times: transcriptTimestamps(id) || {} });
        } else if (m.type === 'ccx:debug') {
            dlog('ccx:debug indicator', m);
        } else if (m.type === 'ccx:pinSession') {
            // The row's own id, not the tab's: the pin is toggled from whichever history row was
            // clicked, exactly like delete_session and rename_session above.
            if (m.sessionId && typeof m.sessionId === 'string') {
                setPinned(m.sessionId, Boolean(m.pinned));
                // Every tab draws the same history list, so all of them have to be told.
                broadcast();
            }
        } else if (m.type === 'ccx:hideMessages') {
            const id = m.sessionId || sessionId;
            if (id) {
                addHidden(id, m.uuids);
                // Echo the authoritative list back so the page's in-memory set converges on the file.
                post(webview, { type: 'ccx:state', ...stateFor(id, webview) });
            }
        }
    });

    postIcons(webview);
    post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
}

function renderScript(webview, nonce) {
    let code;
    try {
        code = fs.readFileSync(path.join(DIR, 'webview.js'), 'utf8');
    } catch {
        return '';
    }
    attachWebview(webview);
    return `<script nonce="${nonce}">\n${code.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
}

function attachPanel(panel) {
    if (!S.panels.has(panel)) {
        S.panels.set(panel, true);
        try {
            panel.onDidDispose(() => {
                S.panels.delete(panel);
                S.activeSessionByPanel.delete(panel);
            });
        } catch {}
    }
    ensureWatchers();
    decorate(panel);
}

module.exports = { renderScript, attachPanel, envFor, profileIcons, agentRunsPayload };