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
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Overridable so the test suite can point at a fixture tree instead of the user's real profiles
const PROFILES_DIR = process.env.CLAUDAPTER_PROFILES_DIR || path.join(HOME, '.claude', 'profiles');
const RUNTIME = process.env.CLAUDAPTER_RUNTIME_DIR || path.join(HOME, '.claude', 'claudapter');
const BINDINGS_FILE = path.join(RUNTIME, 'bindings.json');
const PROXY_SCRIPT = path.join(RUNTIME, 'proxy', 'server.mjs');
const LOG_FILE = path.join(RUNTIME, 'agent-server.log');

const SERVER_NAME = 'claudapter-agents';
const SERVER_VERSION = '1.0.0';
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

function profileEnv(name) {
    const p = readJson(path.join(PROFILES_DIR, `${name}.json`));
    return p && typeof p.env === 'object' && p.env ? p.env : {};
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

// Providers fail in ways the CLI hides: an exhausted balance or a spent quota comes back as 429,
// which it treats as retryable and backs off on until something kills it. The task then dies on a
// timeout whose message says nothing about why — an exhausted GLM balance and a hung network look
// identical. One cheap call up front turns that into the provider's own words, immediately.
//
// Deliberately non-blocking on anything but a clear refusal: a probe that times out or cannot
// connect proves nothing the real run will not find out for itself, and must not stop it.
const PREFLIGHT_TIMEOUT_MS = 8000;

function providerMessage(body) {
    try {
        const payload = JSON.parse(body);
        const message = payload?.error?.message || payload?.message;
        if (message) return String(message);
    } catch {}
    return body.replace(/\s+/g, ' ').trim().slice(0, 300);
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
    if (FAMILY_ENV[alias]) return env[FAMILY_ENV[alias]] || null;
    return requested || null;
}

async function preflight(env, requestedModel) {
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

    try {
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': key,
                authorization: `Bearer ${key}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
            signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        });
        if (res.ok) return null;
        return `HTTP ${res.status} — ${providerMessage(await res.text().catch(() => ''))}`;
    } catch {
        return null;
    }
}

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

// Read-only is the default because a delegated run answers with text far more often than it edits,
// and because the provider on the other end is not the one the user is currently supervising.
const MODES = {
    read: ['--allowedTools', 'Read,Grep,Glob,WebFetch,WebSearch'],
    write: ['--permission-mode', 'acceptEdits'],
    full: ['--permission-mode', 'bypassPermissions'],
};

function describeProfile(name) {
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
    return `${name} — ${endpoint}${mapped ? ` — ${mapped}` : ''}`;
}

async function runAgent(params) {
    const depth = Number(process.env[DEPTH_VAR] || 0);
    if (depth >= MAX_DEPTH)
        throw new Error(`delegation depth ${depth} reached the limit of ${MAX_DEPTH} — this run is already a delegated agent`);

    const profile = String(params.profile || '').trim();
    const prompt = String(params.prompt || '');
    if (!profile) throw new Error('profile is required');
    if (!prompt.trim()) throw new Error('prompt is required');

    const available = listProfiles();
    if (!available.includes(profile))
        throw new Error(`unknown profile "${profile}" — available: ${available.join(', ') || '(none)'}`);

    const mode = String(params.mode || 'read');
    if (!MODES[mode]) throw new Error(`unknown mode "${mode}" — expected one of: ${Object.keys(MODES).join(', ')}`);

    const cwd = params.cwd ? String(params.cwd) : process.cwd();
    if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

    const timeout = Math.min(Number(params.timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    await ensureProxy(profile);

    const bin = resolveClaudeBinary();
    const env = envForProfile(profile, depth);

    const refused = await preflight(env, params.model || DEFAULT_MODEL);
    if (refused) throw new Error(`the "${profile}" provider refused a test call, so the task was not started — ${refused}`);

    const args = ['-p', '--output-format', 'json', '--model', String(params.model || DEFAULT_MODEL), ...MODES[mode]];
    if (params.effort) args.push('--effort', String(params.effort));
    if (params.agent) args.push('--agent', String(params.agent));
    log('run', { profile, mode, model: params.model || DEFAULT_MODEL, agent: params.agent || null, cwd, depth });

    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);

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
    child.stdin.end(prompt);

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

    if (outcome.spawnError) throw new Error(`could not start the CLI (${bin}): ${outcome.spawnError}`);
    if (outcome.timedOut)
        throw new Error(`the "${profile}" agent was killed after ${Math.round(timeout / 1000)}s${stderr ? `: ${stderr.slice(-500)}` : ''}`);

    let payload = null;
    try {
        payload = JSON.parse(stdout);
    } catch {}

    if (!payload) {
        const detail = (stderr || stdout).trim().slice(-800);
        throw new Error(`the "${profile}" agent produced no result (exit ${outcome.code})${detail ? `: ${detail}` : ''}`);
    }

    recordBinding(payload.session_id, profile);

    const text = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result ?? '');
    const cost = typeof payload.total_cost_usd === 'number' ? `$${payload.total_cost_usd.toFixed(4)}` : 'n/a';
    const footer = [
        `profile: ${profile}`,
        `model: ${params.model || DEFAULT_MODEL}`,
        `mode: ${mode}`,
        `turns: ${payload.num_turns ?? '?'}`,
        `cost: ${cost}`,
        payload.session_id ? `session: ${payload.session_id}` : null,
    ]
        .filter(Boolean)
        .join(' · ');

    if (payload.is_error) throw new Error(`the "${profile}" agent reported an error — ${text.slice(0, 800)}`);
    return `${text}\n\n---\n${footer}`;
}

const TOOLS = [
    {
        name: 'list_profiles',
        description:
            'List the provider profiles a delegated agent can run under: name, endpoint, and the model each family alias maps to. Call this before run_agent when unsure which profile names exist.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'run_agent',
        description:
            "Run a Claude Code agent under ANOTHER provider profile and return its answer. Use this to delegate a self-contained task to a different provider (DeepSeek, GLM, Qwen, MiniMax, OpenAI, Codex, the Anthropic subscription) — a normal subagent cannot do this, because it always inherits this session's provider and credentials. The agent starts with no memory of this conversation, so the prompt must carry every fact it needs. It reads files itself, so paths are usually enough.",
        inputSchema: {
            type: 'object',
            properties: {
                profile: {
                    type: 'string',
                    description: 'Profile name from ~/.claude/profiles — see list_profiles.',
                },
                prompt: {
                    type: 'string',
                    description: 'The complete, self-contained task. The agent shares no context with this conversation.',
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
                    enum: ['read', 'write', 'full'],
                    description:
                        'read (default): the agent may only read, search and fetch. write: file edits are auto-accepted. full: all permission checks are bypassed. Ask the user before choosing anything but read.',
                },
                cwd: {
                    type: 'string',
                    description: 'Working directory for the agent. Defaults to this session’s directory.',
                },
                timeout_ms: {
                    type: 'number',
                    description: 'Kill the agent after this long. Default 900000 (15 min), max 3600000 (60 min).',
                },
            },
            required: ['profile', 'prompt'],
            additionalProperties: false,
        },
    },
];

async function callTool(name, args) {
    if (name === 'list_profiles') {
        const names = listProfiles();
        if (!names.length) return `No profiles found in ${PROFILES_DIR}`;
        return names.map(describeProfile).join('\n');
    }
    if (name === 'run_agent') return runAgent(args || {});
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
    // orphaned — a headless CLI with nobody to report to, still billing.
    process.stdin.on('end', () => {
        for (const child of running) killTree(child);
        process.exit(0);
    });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) main();

export { TOOLS, callTool, handle, envForProfile, describeProfile, resolveClaudeBinary, preflight, providerMessage, MODES };
