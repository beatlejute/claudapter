// A stdio MCP server that runs a Claude Code agent under a *different* provider profile.
//
// Claude Code binds a session to one provider for its whole life: a subagent's frontmatter has no
// `env` and no endpoint field, so it always inherits the parent's ANTHROPIC_BASE_URL and credentials
// (docs/en/sub-agents lists every supported field — `model` picks a model, never a provider). The
// one place a provider can still change is where a process is born, which is what claudapter already
// does per tab. This server does the same for a delegated task: it spawns `claude -p` with the env
// of a profile from ~/.claude/profiles and hands the answer back as a tool result.
//
//   claude mcp add --scope user claudapter-agents -- node <abs path to this file>
//
// The profile/env logic below mirrors host.js rather than importing it: host.js is CommonJS and
// requires("vscode"), so it cannot be loaded outside the extension host. Two deliberate divergences
// from envFor() are marked at their site.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Overridable so the test suite can point at a fixture tree instead of the user's real profiles
const PROFILES_DIR = process.env.CLAUDAPTER_PROFILES_DIR || path.join(HOME, '.claude', 'profiles');
const RUNTIME = process.env.CLAUDAPTER_RUNTIME_DIR || path.join(HOME, '.claude', 'claudapter');
const BINDINGS_FILE = path.join(RUNTIME, 'bindings.json');
// A delegated run that can be resumed has to be findable again: which profile started it, and in
// which tree. bindings.json cannot carry that — host.js reads it as a flat sessionId → profile map.
const SESSIONS_FILE = path.join(RUNTIME, 'agent-sessions.json');
// What each provider said the last time it was called, so list_profiles can answer "is this one
// usable right now" without spending a call on every listing.
const HEALTH_FILE = path.join(RUNTIME, 'agent-health.json');
// One small manifest per delegated run, written before the CLI is spawned and updated when it
// ends. It is the only thing that tells the extension host a run exists at all: this server talks
// stdio to its parent CLI and has no channel to a VS Code window. The `session` field is what makes
// the run watchable — the host resolves it to <projects>/<slug>/<id>.jsonl and tails that.
const RUNS_DIR = path.join(RUNTIME, 'agent-runs');
const PROXY_SCRIPT = path.join(RUNTIME, 'proxy', 'server.mjs');
const LOG_FILE = path.join(RUNTIME, 'agent-server.log');

const SERVER_NAME = 'claudapter-agents';
const SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
// A model alias resolves through the profile's own ANTHROPIC_DEFAULT_<FAMILY>_MODEL; a literal id
// would reach a non-Anthropic upstream untouched and 400 there. So the default is an alias.
const DEFAULT_MODEL = 'sonnet';
// The child loads the user's MCP config too, so it can reach this very server. Depth is carried in
// the environment and refused past the second level — an agent delegating to an agent is useful,
// an unbounded chain of them is a fork bomb with an API bill.
const DEPTH_VAR = 'CLAUDAPTER_AGENT_DEPTH';
const MAX_DEPTH = 2;
// A delegate that delegates again is the one case where the work is not where the tab is looking:
// the run the tab started sits there dispatching while its own child does everything. The child's
// server learns whose child it is from the environment its parent was spawned with — there is no
// other channel, since the two are separate processes that never speak.
const PARENT_VAR = 'CLAUDAPTER_PARENT_RUN';

// A manifest outlives its run only long enough for the frame to show the final line. Both bounds
// are swept on every write, so a machine that never runs another agent still ends up clean.
const MAX_RUN_FILES = 40;
const RUN_FILE_TTL_MS = 2 * 60 * 60 * 1000;
// The prompt is carried so the page can tell which run belongs to which run_agent block. It is
// already in the tool call the user is looking at and in the agent's own transcript, so this adds
// no exposure — but it is capped rather than copied whole.
const MAX_RUN_PROMPT = 8000;

const MAX_SESSIONS = 300;
// A finished background task is kept so its report can be collected more than once; the oldest are
// dropped rather than held for the life of the server.
const MAX_FINISHED_TASKS = 50;
const MAX_WAIT_MS = 10 * 60 * 1000;

function log(...parts) {
    const line = `${new Date().toISOString()} ${parts
        .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
        .join(' ')}\n`;
    try {
        fs.mkdirSync(RUNTIME, { recursive: true });
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

function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    } catch (e) {
        log('write failed', file, e.message);
    }
}

function listProfiles() {
    try {
        return fs
            .readdirSync(PROFILES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''))
            .sort();
    } catch {
        return [];
    }
}

function readProfile(name) {
    return readJson(path.join(PROFILES_DIR, `${name}.json`));
}

function profileEnv(name) {
    const p = readProfile(name);
    return p && typeof p.env === 'object' && p.env ? p.env : {};
}

// Optional, and only claudapter reads it — the CLI never sees this key. USD per million tokens,
// keyed by the model id the provider actually serves, with "*" as a catch-all:
//   "pricing": { "*": { "input": 0.28, "output": 0.42, "cache_read": 0.028 } }
function profilePricing(name) {
    const p = readProfile(name);
    return p && typeof p.pricing === 'object' && p.pricing ? p.pricing : null;
}

// Every key any profile declares. A key nobody declares is a key nobody deletes, which is how a
// leftover from the parent session would ride along to another provider.
function managedKeys() {
    const keys = new Set();
    for (const n of listProfiles()) for (const k of Object.keys(profileEnv(n))) keys.add(k);
    return keys;
}

const CREDENTIAL_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
];

// Inherited from the CLI that spawned this server. They describe *that* session — its IDE socket,
// its entrypoint — and would either point the child at the wrong place or make it announce itself
// as something it is not.
const SESSION_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

function localProxyPort(profile) {
    const url = profileEnv(profile).ANTHROPIC_BASE_URL || '';
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    return match ? Number(match[1]) : null;
}

// Divergence from host.js#envFor: the credential strip is unconditional here. There, the ambient
// environment is the user's own and a profile with an empty env ("the Anthropic subscription")
// should keep inheriting it. Here the ambient environment belongs to the *calling session's*
// provider, so inheriting it would send the subscription profile out on DeepSeek's key.
function envForProfile(profile, depth) {
    const env = { ...process.env };
    for (const k of managedKeys()) delete env[k];
    for (const k of CREDENTIAL_KEYS) delete env[k];
    for (const k of SESSION_KEYS) delete env[k];
    Object.assign(env, profileEnv(profile));

    // Without this the CLI routes even 127.0.0.1 through the corporate proxy and cannot connect
    if (localProxyPort(profile)) {
        const noProxy = '127.0.0.1,localhost';
        env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
        env.no_proxy = env.NO_PROXY;
    }
    env[DEPTH_VAR] = String(depth + 1);
    return env;
}

// Several versions linger on disk after an update, so compare version numbers, not names
function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function resolveClaudeBinary() {
    if (process.env.CLAUDAPTER_CLAUDE_BIN) return process.env.CLAUDAPTER_CLAUDE_BIN;
    const root = path.join(HOME, '.vscode', 'extensions');
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    try {
        const dir = fs
            .readdirSync(root)
            .filter((d) => d.startsWith('anthropic.claude-code-'))
            .sort((a, b) => {
                const [x, y] = [versionOf(a), versionOf(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            })
            .pop();
        if (dir) {
            const bin = path.join(root, dir, 'resources', 'native-binary', exe);
            if (fs.existsSync(bin)) return bin;
        }
    } catch {}
    return exe; // fall back to PATH
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

// A profile pointing at 127.0.0.1 is served by the local adapter, which the extension normally
// starts when such a tab spawns. A delegated run can be the first thing to need it.
async function ensureProxy(profile) {
    const port = localProxyPort(profile);
    if (!port || !fs.existsSync(PROXY_SCRIPT)) return;
    if (await portIsOpen(port)) return;
    try {
        const extraEnv = readJson(path.join(RUNTIME, 'proxy.json'))?.env || {};
        const child = spawn(process.execPath, ['--use-env-proxy', PROXY_SCRIPT, '--port', String(port)], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...extraEnv },
        });
        child.unref();
        log('proxy spawned', { port, profile });
        // The adapter binds in well under a second; the CLI's own retry covers the rest
        await new Promise((r) => setTimeout(r, 700));
    } catch (e) {
        log('proxy spawn failed', e.message);
    }
}

// --------------------------------------------------------------------------- provider preflight

// Providers fail in ways the CLI hides: an exhausted balance or a spent quota comes back as 429,
// which it treats as retryable and backs off on until something kills it. The task then dies on a
// timeout whose message says nothing about why — an exhausted GLM balance and a hung network look
// identical. One cheap call up front turns that into the provider's own words, immediately.
//
// Deliberately non-blocking on anything but a clear refusal: a probe that times out or cannot
// connect proves nothing the real run will not find out for itself, and must not stop it.
const PREFLIGHT_TIMEOUT_MS = 8000;

// Which route the probe takes. Plain fetch() ignores HTTPS_PROXY: left to its own devices the probe
// rides the direct network path while the run it vouches for rides the configured proxy — and
// behind a filtering gateway that difference is the whole answer, because the gateway answers the
// probe with a refusal of its own that no provider ever sent. When the run's environment declares a
// proxy, the request is therefore handed to a re-executed copy of this file (PROBE_CHILD_FLAG)
// started with --use-env-proxy — the same treatment ensureProxy above gives processes whose fetch
// must honor those variables. Loopback endpoints skip the child: nothing on 127.0.0.1 has any use
// for a corporate proxy, and the tests themselves serve the probe from exactly there.
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const PROBE_CHILD_FLAG = '--probe-child';
// The child inherits the fetch timeout plus room for node itself to start; a slow spawn must never
// read as a provider refusal.
const PROBE_CHILD_GRACE_MS = 5000;

// The adapter wraps an upstream refusal as `upstream 429: {…}`, so the body is JSON with a sentence
// in front of it. Dig the object out of whichever shape arrived.
function embeddedJson(body) {
    const text = String(body || '');
    try {
        return JSON.parse(text);
    } catch {}
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    if (open === -1 || close < open) return null;
    try {
        return JSON.parse(text.slice(open, close + 1));
    } catch {
        return null;
    }
}

// The local adapter forwards an upstream refusal inside an envelope of its own, so the provider's
// actual words can sit a layer or two down as a string that is itself JSON:
//   {"error":{"message":"upstream 429: {\"error\":{\"message\":\"The usage limit has been reached\"}}"}}
// Peel until nothing more comes out, or the listing shows the envelope instead of the reason.
function deepestError(body, depth = 0) {
    const payload = embeddedJson(body);
    if (!payload) return null;
    const message = payload.error?.message ?? payload.message;
    if (typeof message === 'string' && message.includes('{') && depth < 4) {
        const inner = deepestError(message, depth + 1);
        if (inner) return inner;
    }
    return payload;
}

function providerMessage(body) {
    const payload = deepestError(body);
    const message = payload?.error?.message || payload?.message;
    if (message) return String(message);
    return String(body || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

// When a refusal lifts. Providers say it in at least three ways: a unix `resets_at`, a countdown in
// seconds, or plain words in the message. Without this a listing can only report that a profile
// failed, which is the half of the answer that does not help — the other half is whether to wait
// for it or switch to something else.
function parseResetAt(body, headers, now = Date.now()) {
    const asIso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
    const payload = deepestError(body) || {};
    const fields = { ...payload, ...(payload.error || {}) };

    for (const key of ['resets_at', 'reset_at', 'resetsAt', 'resetAt']) {
        const v = fields[key];
        if (typeof v === 'number' && v > 0) return asIso(v > 1e12 ? v : v * 1000);
        if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return asIso(Date.parse(v));
    }
    for (const key of ['resets_in_seconds', 'reset_in_seconds', 'retry_after']) {
        const v = Number(fields[key]);
        if (Number.isFinite(v) && v > 0) return asIso(now + v * 1000);
    }

    const retryAfter = headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) return asIso(now + seconds * 1000);
        if (!Number.isNaN(Date.parse(retryAfter))) return asIso(Date.parse(retryAfter));
    }

    // "The quota will reset at 08-27 08:17:00 UTC." — a month and day with no year, so the year has
    // to be inferred: a date more than a week in the past is next year's, not this year's.
    const words = /reset[a-z]*\s+(?:\w+\s+){0,2}?at\s+(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC/i.exec(
        String(body || ''),
    );
    if (words) {
        const [, mm, dd, hh, mi, ss] = words;
        const year = new Date(now).getUTCFullYear();
        let when = Date.UTC(year, +mm - 1, +dd, +hh, +mi, +(ss || 0));
        if (when < now - 7 * 24 * 3600 * 1000) when = Date.UTC(year + 1, +mm - 1, +dd, +hh, +mi, +(ss || 0));
        return asIso(when);
    }
    return null;
}

const FAMILY_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// What the provider will actually be asked for. The probe has to name the same model the run will,
// or it proves nothing: a quota can be spent on one model while another still answers. An alias the
// profile never mapped resolves to nothing — probing the bare word "sonnet" would draw a 400 from a
// provider that has no such model and refuse a run that would have worked.
function probeModel(env, requested) {
    const alias = String(requested || '').toLowerCase();
    const model = FAMILY_ENV[alias] ? env[FAMILY_ENV[alias]] || null : requested || null;
    // A trailing "[1m]" is the CLI's own marker for the long-context variant: it strips the suffix
    // and sends a beta header instead. Probing the id with the suffix still on would draw a 400
    // from a provider that has no such model and refuse a run that works.
    return model ? model.replace(/\[[^\]]*\]$/, '') : null;
}

// `profile` is optional and only names the row to record the answer under — the probe itself needs
// nothing but the environment.
async function preflight(env, requestedModel, profile) {
    if (process.env.CLAUDAPTER_SKIP_PREFLIGHT) return null;
    const base = (env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '');
    // An empty env means the Anthropic subscription: its auth lives in the keychain, not here, so
    // there is nothing this probe could authenticate with
    if (!base) return null;
    // The CLI resolves auth first-match-wins, API key before auth token — probe with whichever the
    // profile declares. With neither, an empty header would draw a 401 and refuse a run that the
    // child, authenticating some other way, would have completed.
    const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
    if (!key) return null;
    const model = probeModel(env, requestedModel);
    if (!model) return null;

    // A header value has to be Latin-1. fetch() builds the Headers object before it opens a socket,
    // so a credential carrying a Cyrillic character — almost always a placeholder like "sk-ЗАМЕНИТЕ…"
    // left in the profile — never reaches the network, and the TypeError it throws instead reads as a
    // protocol bug ("Cannot convert argument to a ByteString because the character at index 3 has a
    // value of 1047") rather than as an unfilled field. Answering it here costs one scan of a string
    // this function was about to send anyway.
    const offending = [...key].findIndex((c) => c.codePointAt(0) > 0xff);
    if (offending > -1) {
        const which = env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
        // The value itself never travels: a credential is not something to quote back, and the
        // position alone says which character to look at.
        const message = `${which} is not a usable key — character ${offending + 1} is outside Latin-1, so ~/.claude/profiles/${profile}.json still holds a placeholder`;
        recordHealth(profile, { ok: false, message, model });
        return message;
    }

    const verdict = await probeOnce(
        env,
        `${base}/v1/messages`,
        {
            'content-type': 'application/json',
            'x-api-key': key,
            authorization: `Bearer ${key}`,
            'anthropic-version': '2023-06-01',
        },
        JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    );

    if (verdict.unreachable) {
        recordHealth(profile, { ok: false, unreachable: true, message: verdict.message || 'no answer', model });
        return null;
    }
    if (verdict.status >= 200 && verdict.status < 300) {
        recordHealth(profile, { ok: true, model });
        return null;
    }
    const text = verdict.body || '';
    const retryAfter = { get: (name) => (String(name).toLowerCase() === 'retry-after' ? verdict.retry_after || null : null) };
    recordHealth(profile, {
        ok: false,
        status: verdict.status,
        message: providerMessage(text),
        resets_at: parseResetAt(text, retryAfter),
        model,
    });
    return `HTTP ${verdict.status} — ${providerMessage(text)}`;
}

// Where the probe request actually goes out. A run whose environment declares a proxy must be
// probed through it — see the PROXY_VARS comment above. Loopback endpoints never take the child:
// nothing local has any use for a corporate proxy, and the test suite serves the probe from
// 127.0.0.1.
function loopbackHost(url) {
    try {
        return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname);
    } catch {
        return false;
    }
}

async function probeOnce(env, url, headers, body) {
    if (!PROXY_VARS.some((n) => env[n]) || loopbackHost(url)) {
        try {
            const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
            return {
                status: res.status,
                body: await res.text().catch(() => ''),
                retry_after: res.headers.get('retry-after'),
            };
        } catch (e) {
            return { unreachable: true, message: e?.message || 'no answer' };
        }
    }
    return probeThroughChild(env, url, headers, body);
}

// One request, answered by a fresh `node --use-env-proxy` copy of this file (PROBE_CHILD_FLAG).
// The spec travels over stdin rather than argv so the credentials stay out of process listings,
// and the single JSON line back carries just what preflight maps into health records and refusal
// text: status, body, retry-after.
function probeThroughChild(env, url, headers, body) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (verdict) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(verdict);
        };
        const timer = setTimeout(() => {
            killTree(child);
            finish({ unreachable: true, message: 'the probe did not answer in time' });
        }, PREFLIGHT_TIMEOUT_MS + PROBE_CHILD_GRACE_MS);

        const self = fileURLToPath(import.meta.url);
        const child = spawn(process.execPath, ['--use-env-proxy', self, PROBE_CHILD_FLAG], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        // A child that dies before reading the spec breaks this pipe under the write; without a
        // listener that EPIPE would take the whole server down with it.
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ url, headers, body, timeout_ms: PREFLIGHT_TIMEOUT_MS }));
        child.once('error', (e) => finish({ unreachable: true, message: e.message }));
        child.once('close', () => {
            let verdict = null;
            const line = out.split('\n').find((l) => l.trim());
            try {
                verdict = line ? JSON.parse(line) : null;
            } catch {}
            if (verdict && (typeof verdict.status === 'number' || verdict.unreachable)) return finish(verdict);
            // An older node without --use-env-proxy refuses to start at all; probing directly beats
            // reporting every provider unreachable forever.
            if (/bad option|invalid option/i.test(err)) return probeOnce({}, url, headers, body).then(finish);
            log('probe child produced no verdict', err.slice(0, 200));
            finish({ unreachable: true, message: err.trim().slice(0, 200) || 'no verdict from the probe' });
        });
    });
}

// The other end of probeThroughChild: this same file under --probe-child, one spec on stdin, one
// JSON verdict on stdout. The caller starts it with --use-env-proxy, which is the entire point —
// this process's fetch honors the proxy variables the real run will honor.
async function probeChildMain() {
    const spec = await new Promise((resolve) => {
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (buffer += c));
        process.stdin.on('end', () => resolve(buffer));
        process.stdin.on('error', () => resolve(''));
    });
    const done = (verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`);
    let parsed;
    try {
        parsed = JSON.parse(spec);
    } catch {
        return done({ unreachable: true, message: 'unreadable probe spec' });
    }
    try {
        const res = await fetch(parsed.url, {
            method: 'POST',
            headers: parsed.headers,
            body: parsed.body,
            signal: AbortSignal.timeout(Number(parsed.timeout_ms) || PREFLIGHT_TIMEOUT_MS),
        });
        done({
            status: res.status,
            body: await res.text().catch(() => ''),
            retry_after: res.headers.get('retry-after'),
        });
    } catch (e) {
        done({ unreachable: true, message: e?.message || 'no answer' });
    }
}

// ------------------------------------------------------------------------------- profile health

function recordHealth(profile, entry) {
    if (!profile) return;
    const all = readJson(HEALTH_FILE) || {};
    all[profile] = { at: new Date().toISOString(), ...entry };
    writeJson(HEALTH_FILE, all);
}

function span(ms) {
    const s = Math.round(Math.abs(ms) / 1000);
    if (s < 90) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// What list_profiles appends to a profile line. Nothing at all when the profile has never been
// called: an unknown status must not read as a healthy one.
function describeHealth(profile, now = Date.now(), health = readJson(HEALTH_FILE) || {}) {
    const h = health[profile];
    if (!h || !h.at) return '';
    const age = span(now - Date.parse(h.at));
    if (h.ok) return `ok ${age} ago`;
    // A probe that could not connect is not a provider that refused: reporting it as a refusal
    // would send the reader to fix a quota when the adapter is simply down.
    if (h.unreachable) return `no answer ${age} ago — the endpoint did not respond to a test call`;
    const parts = [`FAILED ${age} ago`];
    if (h.status) parts.push(`HTTP ${h.status}`);
    if (h.message) parts.push(String(h.message).slice(0, 140));
    if (h.resets_at) {
        const at = Date.parse(h.resets_at);
        const stamp = `${h.resets_at.replace('T', ' ').slice(0, 16)}Z`;
        parts.push(
            Number.isFinite(at) && at > now ? `resets ${stamp} (in ${span(at - now)})` : `resets ${stamp} (passed — worth retrying)`,
        );
    }
    return parts.join(' · ');
}

// ------------------------------------------------------------------------------ spend reporting

// The whole-run totals. `modelUsage` is preferred over `usage`: it is the same cumulative figure
// broken down per model, it is the only place the served model id appears, and it is the only shape
// that survives a run which touched more than one model.
//
// Both are already whole-run cumulative — verified against the transcript, where they equal the sum
// over *distinct* assistant message ids. Summing the transcript's lines instead returns a multiple
// of the truth: the CLI writes one line per content block and repeats the full message usage on
// each, so a run whose messages carry text plus a tool call appears to have cost twice what it did.
function usageTotals(payload) {
    const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const perModel = [];
    const models = payload?.modelUsage && typeof payload.modelUsage === 'object' ? payload.modelUsage : null;
    if (models && Object.keys(models).length) {
        for (const [model, u] of Object.entries(models)) {
            const row = {
                model,
                input: Number(u?.inputTokens) || 0,
                output: Number(u?.outputTokens) || 0,
                cacheWrite: Number(u?.cacheCreationInputTokens) || 0,
                cacheRead: Number(u?.cacheReadInputTokens) || 0,
            };
            perModel.push(row);
            totals.input += row.input;
            totals.output += row.output;
            totals.cacheWrite += row.cacheWrite;
            totals.cacheRead += row.cacheRead;
        }
        return { ...totals, perModel };
    }
    const u = payload?.usage;
    if (!u) return { ...totals, perModel };
    return {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        perModel,
    };
}

const num = (v) => Number(v || 0).toLocaleString('en-US');

// One line, the same four columns for every provider whether or not it charges for them — a column
// that disappears when it is zero is a column that cannot be compared across two runs.
function formatTokens(totals) {
    return `tokens: in ${num(totals.input)} · out ${num(totals.output)} · cache write ${num(totals.cacheWrite)} · cache read ${num(
        totals.cacheRead,
    )}`;
}

function isAnthropicProfile(profile) {
    const base = profileEnv(profile).ANTHROPIC_BASE_URL || '';
    if (!base) return true; // the subscription profile
    try {
        return /(^|\.)anthropic\.com$/.test(new URL(base).hostname);
    } catch {
        return false;
    }
}

function rateFor(pricing, model) {
    return pricing?.[model] || pricing?.['*'] || null;
}

// The CLI's own total_cost_usd prices every run against Anthropic's table — the result even carries
// `provider: "firstParty"` for a DeepSeek call — so it is only the truth on Anthropic itself.
// Anywhere else the number comes from the profile's own "pricing" block, and where there is none
// the honest answer is that there is no number, said out loud rather than by dropping the line.
function formatCost(profile, totals, payload) {
    const cliCost = Number(payload?.total_cost_usd);
    const money = (v) => `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`;

    if (isAnthropicProfile(profile))
        return Number.isFinite(cliCost) ? `cost: ${money(cliCost)} · Anthropic billing` : 'cost: — · the CLI reported none';

    const pricing = profilePricing(profile);
    if (pricing) {
        const rows = totals.perModel.length ? totals.perModel : [{ model: '*', ...totals }];
        let usd = 0;
        const unpriced = [];
        for (const row of rows) {
            const rate = rateFor(pricing, row.model);
            if (!rate) {
                unpriced.push(row.model);
                continue;
            }
            usd +=
                (row.input * (Number(rate.input) || 0) +
                    row.output * (Number(rate.output) || 0) +
                    row.cacheWrite * (Number(rate.cache_write ?? rate.input) || 0) +
                    row.cacheRead * (Number(rate.cache_read ?? rate.input) || 0)) /
                1e6;
        }
        if (!unpriced.length) return `cost: ${money(usd)} · "${profile}" profile pricing`;
        return `cost: ${money(usd)} · "${profile}" profile pricing, no rate for ${unpriced.join(', ')}`;
    }
    const hint = Number.isFinite(cliCost) ? ` (the CLI's ${money(cliCost)} is Anthropic's table, not ${profile}'s)` : '';
    return `cost: — · add "pricing" to ~/.claude/profiles/${profile}.json to price this run${hint}`;
}

// The model a run was *asked* for is an alias the profile redirects; the model that answered is
// what the tokens were spent on. Reporting only the first sends the reader to the transcript to
// find out which model the numbers above belong to.
function describeModel(payload, env, requested) {
    const served = usageTotals(payload).perModel.map((r) => r.model);
    const resolved = served.length ? served : [probeModel(env, requested)].filter(Boolean);
    const list = resolved.join(', ');
    if (!list || list === requested) return `model: ${requested}`;
    return `model: ${requested} → ${list}`;
}

// ----------------------------------------------------------------------- sessions and bindings

// The history list reads this file — a flat sessionId → profile map — to mark each session with its
// provider. Recording the binding is what gives a delegated run the same provider icon as a tab.
function recordBinding(sessionId, profile) {
    if (!sessionId || !profile) return;
    try {
        const raw = readJson(BINDINGS_FILE);
        const bindings = raw && typeof raw === 'object' ? raw : {};
        bindings[sessionId] = profile;
        fs.mkdirSync(RUNTIME, { recursive: true });
        fs.writeFileSync(BINDINGS_FILE, JSON.stringify(bindings, null, 2) + '\n', 'utf8');
    } catch (e) {
        log('binding write failed', e.message);
    }
}

function recordSession(sessionId, info) {
    if (!sessionId) return;
    const all = readJson(SESSIONS_FILE) || {};
    all[sessionId] = { ...(all[sessionId] || {}), ...info, at: new Date().toISOString() };
    const ids = Object.keys(all).sort((a, b) => Date.parse(all[a].at || 0) - Date.parse(all[b].at || 0));
    while (ids.length > MAX_SESSIONS) delete all[ids.shift()];
    writeJson(SESSIONS_FILE, all);
}

function lookupSession(sessionId) {
    if (!sessionId) return null;
    const recorded = (readJson(SESSIONS_FILE) || {})[sessionId];
    if (recorded) return recorded;
    // A tab's session is not in the agent store but is in bindings.json, and continuing one under
    // its own provider is coherent — so the provider is still knowable, just not the directory.
    const profile = (readJson(BINDINGS_FILE) || {})[sessionId];
    return profile ? { profile } : null;
}

// -------------------------------------------------------------------------------- run manifests

// Nothing about a delegated run is visible from the outside while it happens: the answer arrives in
// one piece at the end, and a fifteen-minute run looks identical to a hung one. The manifest is the
// hook the extension host needs — written before the spawn, so a run is watchable from its first
// second, and rewritten once with the outcome.
function runFile(id) {
    return path.join(RUNS_DIR, `${id}.json`);
}

function sweepRuns(now = Date.now()) {
    let files = [];
    try {
        files = fs
            .readdirSync(RUNS_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ f, at: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
            .sort((a, b) => a.at - b.at);
    } catch {
        return;
    }
    const drop = new Set();
    for (const { f, at } of files) if (now - at > RUN_FILE_TTL_MS) drop.add(f);
    for (let i = 0; files.length - drop.size > MAX_RUN_FILES && i < files.length; i++) drop.add(files[i].f);
    for (const f of drop) {
        try {
            fs.unlinkSync(path.join(RUNS_DIR, f));
        } catch {}
    }
}

function writeRun(id, patch) {
    if (!id) return;
    const current = readJson(runFile(id)) || {};
    writeJson(runFile(id), { ...current, ...patch, id, at: new Date().toISOString() });
}

function openRun(ctx) {
    // A resumed run keeps the id it is resuming, which is also the transcript the host will tail —
    // so the two cases need no different treatment here.
    const id = ctx.liveSession;
    if (!id) return null;
    sweepRuns();
    writeRun(id, {
        session: id,
        parent: process.env[PARENT_VAR] || null,
        profile: ctx.profile,
        model: ctx.model,
        mode: ctx.mode,
        cwd: ctx.cwd,
        depth: ctx.depth,
        resumed: Boolean(ctx.session),
        prompt: ctx.prompt.slice(0, MAX_RUN_PROMPT),
        promptLength: ctx.prompt.length,
        startedAt: Date.now(),
        finishedAt: null,
        state: 'running',
    });
    return id;
}

function closeRun(id, state, extra = {}) {
    if (!id) return;
    writeRun(id, { state, finishedAt: Date.now(), ...extra });
}

// ------------------------------------------------------------------------------ child processes

// Every CLI still running under this server. A delegated run outlives nothing: whatever ends it —
// a timeout, or this server's own stdin closing — has to end its children too.
const running = new Set();

// The delegated CLI spawns children of its own (it loads the user's MCP config, this server
// included). On Windows child.kill() is a TerminateProcess on that one pid, so those grandchildren
// survive as orphans and keep spending the provider. taskkill /T walks the tree.
function killTree(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
                'error',
                () => child.kill(),
            );
            return;
        } catch {
            /* fall through to the plain kill */
        }
    }
    child.kill();
}

// ------------------------------------------------------------------------------------ run modes

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

// What `exec` adds to `read`. Read-only by intent, not by enforcement — the tool description says
// so out loud. Everything here reads, searches or aggregates; nothing that copies, moves, deletes,
// installs or opens a socket is on the list, and a command that is not on the list is denied
// outright rather than approved.
//
// `python`/`node` are here deliberately. A collection task is arithmetic over what was read, and
// without an interpreter it cannot be done at all: the run this mode exists for spent 72k tokens
// over 34 turns and returned nothing, because every aggregation step it tried was refused.
const EXEC_COMMANDS = [
    'git log',
    'git show',
    'git diff',
    'git status',
    'git blame',
    'git ls-files',
    'git ls-tree',
    'git cat-file',
    'git rev-parse',
    'git rev-list',
    'git shortlog',
    'git describe',
    'git branch',
    'git tag',
    'git remote',
    'git config --get',
    'ls',
    'cat',
    'head',
    'tail',
    'file',
    'stat',
    'du',
    'find',
    'tree',
    'grep',
    'rg',
    'egrep',
    'fgrep',
    'wc',
    'sort',
    'uniq',
    'cut',
    'tr',
    'awk',
    'sed',
    'jq',
    'diff',
    'comm',
    'paste',
    'column',
    'basename',
    'dirname',
    'realpath',
    'python',
    'python3',
    'node',
    'npm ls',
    'npm view',
    'pip show',
    'pip list',
];

// A PreToolUse hook can rewrite a command before the permission check ever sees it. The run this
// mode exists for had every `git …` rewritten to `rtk git …` by the user's own token-saving proxy
// and denied for it — the allowlist matched the text the model wrote, the check read the text the
// hook produced. Each command is therefore allowed under its wrappers as well. Set the variable to
// an empty string to switch that off.
const EXEC_WRAPPERS = (process.env.CLAUDAPTER_EXEC_WRAPPERS ?? 'rtk')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function execAllowlist() {
    const rules = [];
    for (const cmd of EXEC_COMMANDS) {
        rules.push(`Bash(${cmd}:*)`);
        for (const w of EXEC_WRAPPERS) rules.push(`Bash(${w} ${cmd}:*)`);
    }
    return rules;
}

// Read-only is the default because a delegated run answers with text far more often than it edits,
// and because the provider on the other end is not the one the user is currently supervising. The
// ladder is cumulative: read ⊂ exec ⊂ write ⊂ full.
const MODES = {
    read: ['--allowedTools', READ_TOOLS.join(',')],
    exec: ['--allowedTools', [...READ_TOOLS, ...execAllowlist()].join(',')],
    // acceptEdits auto-accepts edits and nothing else — without the same allowlist a `write` run
    // could rewrite a file but not run the test that proves it still works.
    write: ['--permission-mode', 'acceptEdits', '--allowedTools', [...READ_TOOLS, ...execAllowlist()].join(',')],
    full: ['--permission-mode', 'bypassPermissions'],
};

// The names this mode was asked for before it existed
const MODE_ALIASES = { 'read+exec': 'exec', 'read-exec': 'exec', readexec: 'exec' };

function describeProfile(name, now = Date.now(), health = readJson(HEALTH_FILE) || {}) {
    const env = profileEnv(name);
    const base = env.ANTHROPIC_BASE_URL || '';
    let endpoint = 'Anthropic subscription';
    if (base) {
        try {
            const url = new URL(base);
            endpoint = localProxyPort(name) ? `local adapter (${url.pathname.split('/').filter(Boolean)[0]})` : url.host;
        } catch {
            endpoint = base;
        }
    }
    const models = {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || '',
    };
    const mapped = Object.entries(models)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    const status = describeHealth(name, now, health);
    return `${name} — ${endpoint}${mapped ? ` — ${mapped}` : ''}${status ? `\n    ${status}` : ''}`;
}

// ----------------------------------------------------------------------------------- delegation

// Everything that can fail before a token is spent, resolved once. A background run goes through
// this synchronously too, so an unknown profile or a spent quota is answered now rather than
// fifteen minutes from now by a task nobody is watching.
async function prepare(params) {
    const depth = Number(process.env[DEPTH_VAR] || 0);
    if (depth >= MAX_DEPTH)
        throw new Error(`delegation depth ${depth} reached the limit of ${MAX_DEPTH} — this run is already a delegated agent`);

    const prompt = String(params.prompt || '');
    if (!prompt.trim()) throw new Error('prompt is required');

    const session = params.session ? String(params.session).trim() : '';
    if (session && !/^[0-9a-fA-F][0-9a-fA-F-]{7,}$/.test(session)) throw new Error(`"${session}" is not a session id`);
    const known = session ? lookupSession(session) : null;

    let profile = String(params.profile || '').trim();
    if (!profile && known?.profile) profile = known.profile;
    if (!profile)
        throw new Error(
            session
                ? `profile is required — session "${session}" is not one this server started, so its provider is unknown`
                : 'profile is required',
        );

    const available = listProfiles();
    if (!available.includes(profile))
        throw new Error(`unknown profile "${profile}" — available: ${available.join(', ') || '(none)'}`);

    // Continuing a session under a different provider replays one provider's history to another: it
    // works, it costs the whole transcript again, and it is never what was meant.
    if (known?.profile && known.profile !== profile)
        throw new Error(
            `session "${session}" belongs to the "${known.profile}" profile, not "${profile}" — pass profile: "${known.profile}" to continue it, or omit session to start a new run`,
        );

    // A continued run keeps the directory, the mode and the model it was started with unless the
    // caller says otherwise — swapping the model or dropping the shell halfway through a
    // conversation is never what "carry on" meant.
    const requestedMode = String(params.mode || known?.mode || 'read');
    const mode = MODE_ALIASES[requestedMode] || requestedMode;
    if (!MODES[mode]) throw new Error(`unknown mode "${requestedMode}" — expected one of: ${Object.keys(MODES).join(', ')}`);

    const cwd = params.cwd ? String(params.cwd) : known?.cwd || process.cwd();
    if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

    const timeout = Math.min(Number(params.timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const model = String(params.model || known?.model || DEFAULT_MODEL);

    await ensureProxy(profile);

    const bin = resolveClaudeBinary();
    const env = envForProfile(profile, depth);

    const refused = await preflight(env, model, profile);
    if (refused) throw new Error(`the "${profile}" provider refused a test call, so the task was not started — ${refused}`);

    // The id is chosen here rather than read out of the result, which is what makes a run watchable
    // while it runs: the CLI writes <projects>/<slug>/<id>.jsonl under exactly this id, so the host
    // can tail it from the first turn instead of learning the id once everything is already over. A
    // resumed run already has one — passing --session-id alongside --resume would be two answers to
    // the same question.
    const liveSession = session || randomUUID();
    // Inherited by everything the delegate spawns, its own copy of this server included, which is
    // what lets a nested run name the run it belongs to.
    env[PARENT_VAR] = liveSession;

    const args = ['-p', '--output-format', 'json', '--model', model, ...MODES[mode]];
    if (params.effort) args.push('--effort', String(params.effort));
    if (params.agent) args.push('--agent', String(params.agent));
    if (session) args.push('--resume', session);
    else args.push('--session-id', liveSession);

    return { profile, prompt, mode, cwd, timeout, model, session, liveSession, bin, env, args, depth };
}

async function execute(ctx, task) {
    const { profile, mode, cwd, timeout, model, session, bin, env, args } = ctx;
    log('run', { profile, mode, model, session: session || null, cwd, depth: ctx.depth, background: !!task });

    const startedAt = Date.now();
    const run = openRun(ctx);
    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);
    if (task) task.child = child;

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    // A child that dies before it has read the whole prompt breaks the pipe under the write. With no
    // listener that EPIPE is an unhandled stream error, which takes this server — and every other
    // task running under it — down with it.
    child.stdin.on('error', (e) => log('prompt write failed', e.message));
    // The prompt goes over stdin, not argv: a task description easily outgrows the Windows
    // command-line limit, and nothing here has to be escaped for a shell that is never involved.
    child.stdin.end(ctx.prompt);

    const outcome = await new Promise((resolve) => {
        let timer = setTimeout(() => {
            timer = null;
            killTree(child);
            resolve({ timedOut: true, code: null });
        }, timeout);
        child.once('error', (e) => {
            clearTimeout(timer);
            timer = null;
            resolve({ spawnError: e.message, code: null });
        });
        child.once('close', (code) => {
            if (!timer) return; // already resolved by the timeout or a spawn error
            clearTimeout(timer);
            timer = null;
            resolve({ code });
        });
    });
    running.delete(child);
    if (task) task.child = null;

    if (outcome.spawnError) {
        closeRun(run, 'failed', { error: outcome.spawnError });
        throw new Error(`could not start the CLI (${bin}): ${outcome.spawnError}`);
    }
    if (task?.stopped) {
        closeRun(run, 'stopped');
        throw new Error(`the "${profile}" agent was stopped after ${span(Date.now() - startedAt)}`);
    }
    if (outcome.timedOut) {
        closeRun(run, 'timeout');
        throw new Error(`the "${profile}" agent was killed after ${Math.round(timeout / 1000)}s${stderr ? `: ${stderr.slice(-500)}` : ''}`);
    }

    let payload = null;
    try {
        payload = JSON.parse(stdout);
    } catch {}

    if (!payload) {
        const detail = (stderr || stdout).trim().slice(-800);
        closeRun(run, 'failed', { error: detail || `exit ${outcome.code}` });
        throw new Error(`the "${profile}" agent produced no result (exit ${outcome.code})${detail ? `: ${detail}` : ''}`);
    }

    // The alias the run asked for ("sonnet") is not what answered: the profile redirects it, and a
    // health row saying `sonnet` for a codex endpoint reads as a misconfigured profile. Preflight
    // records the served id, so a run has to as well — falling back to the alias only when the result
    // carries no per-model usage at all.
    const servedModel = usageTotals(payload).perModel.map((r) => r.model).filter(Boolean)[0] || model;
    recordHealth(profile, { ok: !payload.is_error, model: servedModel, via: 'run' });
    recordBinding(payload.session_id, profile);
    recordSession(payload.session_id, { profile, cwd, model, mode, turns: payload.num_turns ?? null });

    // The id the CLI reports wins over the one that was asked for: --session-id is a request, and a
    // run that forked or was resumed can legitimately answer with another. Closing the wrong manifest
    // would leave the frame spinning on a run that already ended.
    const finalRun = payload.session_id || run;
    if (finalRun !== run) closeRun(run, 'done', { session: finalRun });
    closeRun(finalRun, payload.is_error ? 'failed' : 'done', {
        session: finalRun,
        turns: payload.num_turns ?? null,
        tokens: formatTokens(usageTotals(payload)),
    });

    const text = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result ?? '');
    if (payload.is_error) throw new Error(`the "${profile}" agent reported an error — ${text.slice(0, 800)}`);
    return `${text}\n\n---\n${report(ctx, payload, Date.now() - startedAt)}`;
}

// One block, the same lines in the same order for every profile — the point of it is that two runs
// on two providers can be laid side by side without opening either transcript.
function report(ctx, payload, elapsedMs) {
    const totals = usageTotals(payload);
    const id = payload.session_id;
    return [
        [
            `profile: ${ctx.profile}`,
            describeModel(payload, ctx.env, ctx.model),
            `mode: ${ctx.mode}`,
            `turns: ${payload.num_turns ?? '?'}`,
            span(elapsedMs),
            ctx.session ? 'resumed' : null,
        ]
            .filter(Boolean)
            .join(' · '),
        formatTokens(totals),
        formatCost(ctx.profile, totals, payload),
        id ? `session: ${id} · continue it with run_agent({ session: "${id}", prompt: … })` : null,
    ]
        .filter(Boolean)
        .join('\n');
}

// ----------------------------------------------------------------------------- background tasks

const tasks = new Map();
let taskSeq = 0;

function forgetOldTasks() {
    const finished = [...tasks.values()].filter((t) => t.state !== 'running').sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > MAX_FINISHED_TASKS) tasks.delete(finished.shift().id);
}

function startTask(ctx) {
    const task = {
        id: `task_${++taskSeq}`,
        profile: ctx.profile,
        model: ctx.model,
        mode: ctx.mode,
        summary: ctx.prompt.replace(/\s+/g, ' ').trim().slice(0, 70),
        state: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        report: null,
        error: null,
        child: null,
        stopped: false,
    };
    tasks.set(task.id, task);
    // Both outcomes are handled here, so nothing ever awaits a promise that can reject
    task.promise = execute(ctx, task).then(
        (r) => {
            task.state = 'done';
            task.report = r;
            task.finishedAt = Date.now();
            forgetOldTasks();
        },
        (e) => {
            task.state = 'failed';
            task.error = e.message;
            task.finishedAt = Date.now();
            forgetOldTasks();
        },
    );
    return task;
}

function taskLine(t, now = Date.now()) {
    const age = t.state === 'running' ? `running ${span(now - t.startedAt)}` : `${t.state} ${span(now - t.finishedAt)} ago`;
    return `${t.id} · ${t.profile} · ${t.mode} · ${age} · "${t.summary}"`;
}

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function checkAgent(params) {
    const id = params.task ? String(params.task).trim() : '';
    if (!id) {
        if (!tasks.size) return 'No background tasks have been started in this session.';
        return [...tasks.values()].map((t) => taskLine(t)).join('\n');
    }
    const task = tasks.get(id);
    if (!task)
        throw new Error(
            `unknown task "${id}" — ${
                tasks.size ? `known: ${[...tasks.keys()].join(', ')}` : 'no background task has been started in this session'
            }`,
        );

    const wait = Math.min(Math.max(Number(params.wait_ms) || 0, 0), MAX_WAIT_MS);
    if (task.state === 'running' && wait) await Promise.race([task.promise, sleep(wait)]);

    if (task.state === 'running')
        return `${task.id} is still running — ${span(Date.now() - task.startedAt)} elapsed on "${
            task.profile
        }". Check again later, or pass wait_ms to block until it finishes.`;
    if (task.state === 'failed') throw new Error(task.error);
    return task.report;
}

function stopAgent(params) {
    const id = String(params.task || '').trim();
    const task = tasks.get(id);
    if (!task) throw new Error(`unknown task "${id}"`);
    if (task.state !== 'running') return `${id} had already finished (${task.state}).`;
    task.stopped = true;
    if (task.child) killTree(task.child);
    return `${id} was stopped after ${span(Date.now() - task.startedAt)}.`;
}

async function runAgent(params) {
    const ctx = await prepare(params);
    if (!params.background) return execute(ctx);
    const task = startTask(ctx);
    return [
        `${task.id} started — the "${ctx.profile}" agent is running in the background (model ${ctx.model}, mode ${ctx.mode}, up to ${span(
            ctx.timeout,
        )}).`,
        '',
        `Collect it with check_agent({ task: "${task.id}" }), or check_agent({ task: "${task.id}", wait_ms: 120000 }) to block until it finishes.`,
        'Nothing arrives on its own when it completes — an MCP server cannot interrupt the session, so the result has to be asked for.',
    ].join('\n');
}

// ---------------------------------------------------------------------------------- MCP surface

const TOOLS = [
    {
        name: 'list_profiles',
        description:
            'List the provider profiles a delegated agent can run under: name, endpoint, the model each family alias maps to, and how the provider answered the last time it was called — including when a spent quota resets. Call this before run_agent when unsure which profile names exist, or when one has been refusing.',
        inputSchema: {
            type: 'object',
            properties: {
                probe: {
                    type: 'boolean',
                    description:
                        'Send a one-token test call to every profile first, so the status shown is current rather than last known. Takes a few seconds.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'run_agent',
        description:
            "Run a Claude Code agent under ANOTHER provider profile and return its answer. Use this to delegate a self-contained task to a different provider (DeepSeek, GLM, Qwen, MiniMax, OpenAI, Codex, the Anthropic subscription) — a normal subagent cannot do this, because it always inherits this session's provider and credentials. A new run starts with no memory of this conversation, so the prompt must carry every fact it needs; it reads files itself, so paths are usually enough. Pass `session` instead to continue an earlier delegated run, which keeps everything that run already knows.",
        inputSchema: {
            type: 'object',
            properties: {
                profile: {
                    type: 'string',
                    description:
                        'Profile name from ~/.claude/profiles — see list_profiles. Optional when `session` names a run this server started: that run’s own profile is reused.',
                },
                prompt: {
                    type: 'string',
                    description:
                        'The complete task. A new agent shares no context with this conversation and needs every fact; a resumed one already has its own, so a follow-up sentence is enough.',
                },
                session: {
                    type: 'string',
                    description:
                        'Continue an earlier delegated run instead of starting a new one — the id printed as "session:" under a previous result. The agent keeps its files, findings and conversation. Same profile only; the working directory defaults to that run’s.',
                },
                agent: {
                    type: 'string',
                    description: 'Optional subagent type from .claude/agents to run as (e.g. "Explore", "code-reviewer").',
                },
                model: {
                    type: 'string',
                    description:
                        'Optional model. Prefer a family alias (sonnet, opus, haiku, fable), which the profile maps to its own model; a literal id is sent to the provider as-is. Default: sonnet.',
                },
                effort: {
                    type: 'string',
                    enum: ['low', 'medium', 'high', 'xhigh', 'max'],
                    description: 'Optional reasoning effort for the delegated run.',
                },
                mode: {
                    type: 'string',
                    enum: ['read', 'exec', 'write', 'full'],
                    description:
                        'read (default): Read, Grep, Glob, WebFetch, WebSearch — no shell at all. exec: read plus a fixed allowlist of read-only and aggregating shell commands (git log/show/diff/blame, find, grep, awk, sed, jq, wc, sort, python -c, node -e) — choose this for any task that has to count, group or cross-reference, because a collection task with no shell simply fails. Nothing outside the list runs, but the list is a convention rather than a sandbox: an interpreter on it can still write if the agent asks it to. write: file edits are auto-accepted as well. full: every permission check is bypassed. Ask the user before choosing write or full.',
                },
                background: {
                    type: 'boolean',
                    description:
                        'Return a task id immediately instead of waiting, so a long run does not hold this turn. The profile and its quota are still checked first, so a hopeless call still fails now. Nothing arrives on its own when it finishes — collect it with check_agent.',
                },
                cwd: {
                    type: 'string',
                    description:
                        'Working directory for the agent. Defaults to the directory of the resumed session, or to this session’s own.',
                },
                timeout_ms: {
                    type: 'number',
                    description: 'Kill the agent after this long. Default 900000 (15 min), max 3600000 (60 min).',
                },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
    },
    {
        name: 'check_agent',
        description:
            'Collect a run started with background: true. With no task, lists every background task of this session and its state. With wait_ms, blocks until the task finishes or that long passes, whichever comes first — use that when there is nothing else left to do meanwhile.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'Task id from run_agent, e.g. "task_1". Omit to list them all.' },
                wait_ms: {
                    type: 'number',
                    description:
                        'Block up to this long for the task to finish. Default 0 (answer with the current state), max 600000. The client’s own tool timeout still applies and is usually shorter — a wait that is cut off does not stop the task, so ask again.',
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'stop_agent',
        description:
            'Kill a background run that is no longer wanted. Without this it keeps working — and keeps spending the provider — until its own timeout.',
        inputSchema: {
            type: 'object',
            properties: { task: { type: 'string', description: 'Task id from run_agent, e.g. "task_1".' } },
            required: ['task'],
            additionalProperties: false,
        },
    },
];

async function callTool(name, args) {
    const params = args || {};
    if (name === 'list_profiles') {
        const names = listProfiles();
        if (!names.length) return `No profiles found in ${PROFILES_DIR}`;
        if (params.probe)
            await Promise.all(
                names.map(async (p) => {
                    // A profile served by the local adapter cannot be probed while the adapter is
                    // down, and "could not connect" is not an answer about the provider — start it
                    // first, exactly as a run would.
                    await ensureProxy(p).catch(() => {});
                    return preflight(envForProfile(p, 0), DEFAULT_MODEL, p).catch(() => null);
                }),
            );
        const now = Date.now();
        const health = readJson(HEALTH_FILE) || {};
        return names.map((p) => describeProfile(p, now, health)).join('\n');
    }
    if (name === 'run_agent') return runAgent(params);
    if (name === 'check_agent') return checkAgent(params);
    if (name === 'stop_agent') return stopAgent(params);
    throw new Error(`unknown tool "${name}"`);
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
    const { id, method, params } = message;
    // A notification carries no id and must never be answered
    const isRequest = id !== undefined && id !== null;

    switch (method) {
        case 'initialize':
            return (
                isRequest &&
                reply(id, {
                    // Echo a protocol the client asked for when we know it, so an older client is not
                    // handed a version it cannot parse
                    protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                })
            );
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return;
        case 'ping':
            return isRequest && reply(id, {});
        case 'tools/list':
            return isRequest && reply(id, { tools: TOOLS });
        case 'tools/call': {
            if (!isRequest) return;
            try {
                const text = await callTool(params?.name, params?.arguments);
                return reply(id, { content: [{ type: 'text', text }] });
            } catch (e) {
                log('tool failed', params?.name, e.message);
                // A tool-level failure is reported inside the result, not as a JSON-RPC error: the
                // model should see what went wrong and be able to correct the call
                return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
            }
        }
        default:
            return isRequest && replyError(id, -32601, `method not found: ${method}`);
    }
}

function main() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                log('unparseable line', line.slice(0, 200));
                continue;
            }
            handle(message).catch((e) => log('handler failed', e.message));
        }
    });
    // The client closing the pipe ends this server, and a task still running under it would be left
    // orphaned — a headless CLI with nobody to report to, still billing. Background tasks included:
    // nothing survives the session that asked for it.
    process.stdin.on('end', () => {
        for (const child of running) killTree(child);
        process.exit(0);
    });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
    if (process.argv.includes(PROBE_CHILD_FLAG)) await probeChildMain();
    else main();
}

export {
    TOOLS,
    callTool,
    handle,
    prepare,
    envForProfile,
    describeProfile,
    describeHealth,
    resolveClaudeBinary,
    preflight,
    providerMessage,
    parseResetAt,
    usageTotals,
    formatTokens,
    formatCost,
    describeModel,
    execAllowlist,
    span,
    MODES,
    MODE_ALIASES,
};
