// Local adapter: accepts the Anthropic Messages API from Claude Code
// and talks to an OpenAI-compatible /chat/completions endpoint.
//
//   node src/proxy/server.mjs [--port 8787] [--config <path>]
//
// Config (~/.claude/claudapter/proxy.json):
//   { "port": 8787, "upstreams": { "openai": { "baseUrl": "https://api.openai.com/v1" } } }
// A Claude Code profile points ANTHROPIC_BASE_URL at http://127.0.0.1:8787/openai
// The key comes from the profile's ANTHROPIC_AUTH_TOKEN (sent as a header) or from upstream.apiKey.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { anthropicToOpenAI, openAIToAnthropic, createStreamTranslator, estimateTokens } from './translate.mjs';
import {
    anthropicToResponses,
    responsesToAnthropic,
    createResponsesStreamTranslator,
    createResponsesCollector,
} from './translate-responses.mjs';
import { getAuth } from './auth-chatgpt.mjs';

const RUNTIME = path.join(os.homedir(), '.claude', 'ui-ext');
const DEFAULT_CONFIG = path.join(RUNTIME, 'proxy.json');
const LOG_FILE = path.join(RUNTIME, 'proxy.log');
const PROFILES_DIR = path.join(os.homedir(), '.claude', 'profiles');

// protocol: 'chat' = /chat/completions with an API key; 'responses' = /responses (Responses API).
// auth: 'key' = key from header/config; 'chatgpt-oauth' = ChatGPT subscription token.
const DEFAULTS = {
    port: 8787,
    upstreams: {
        openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'chat' },
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', protocol: 'chat' },
        groq: { baseUrl: 'https://api.groq.com/openai/v1', protocol: 'chat' },
        together: { baseUrl: 'https://api.together.xyz/v1', protocol: 'chat' },
        ollama: { baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat' },
        'openai-responses': { baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
        codex: {
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            protocol: 'responses',
            auth: 'chatgpt-oauth',
            codexBackend: true,
        },
    },
};

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadConfig() {
    const file = arg('config', DEFAULT_CONFIG);
    let config = { ...DEFAULTS };
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        config = { ...config, ...raw, upstreams: { ...DEFAULTS.upstreams, ...(raw.upstreams || {}) } };
    } catch {}
    config.port = Number(arg('port', process.env.CCX_PROXY_PORT || config.port));
    config.profilesDir = arg('profiles-dir', config.profilesDir || PROFILES_DIR);
    return config;
}

const FAMILY_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// The CLI applies ANTHROPIC_DEFAULT_<FAMILY>_MODEL only to family aliases ("fable", "opus");
// a literal id like "claude-fable-5" — the built-in picker entry, a subagent's `model:`, a
// stale settings.json value — passes through untouched and 400s on a non-Anthropic upstream.
// The proxy closes that gap with the same env block: any claude-<family>-* id is remapped to
// the profile's model for that family. A profile applies to the upstream named by the first
// path segment of its ANTHROPIC_BASE_URL, when that URL routes to this proxy. An optional
// modelOverrides block in the profile still wins for exact ids.
function profileModelRules(port, profilesDir) {
    const byUpstream = {};
    let files = [];
    try {
        files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json'));
    } catch {
        return byUpstream;
    }
    for (const file of files) {
        let profile;
        try {
            profile = JSON.parse(fs.readFileSync(path.join(profilesDir, file), 'utf8'));
        } catch {
            continue;
        }
        const env = profile.env || {};
        const base = env.ANTHROPIC_BASE_URL;
        if (!base) continue;
        let url;
        try {
            url = new URL(base);
        } catch {
            continue;
        }
        if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) continue;
        const defaultPort = url.protocol === 'https:' ? 443 : 80;
        if (Number(url.port || defaultPort) !== port) continue;
        const name = url.pathname.split('/').filter(Boolean)[0];
        if (!name) continue;

        const families = {};
        for (const [family, envVar] of Object.entries(FAMILY_ENV)) if (env[envVar]) families[family] = env[envVar];
        const exact = profile.modelOverrides && typeof profile.modelOverrides === 'object' ? profile.modelOverrides : {};
        if (!Object.keys(families).length && !Object.keys(exact).length) continue;

        const prev = byUpstream[name] || { exact: {}, families: {} };
        byUpstream[name] = {
            exact: { ...prev.exact, ...exact },
            families: { ...prev.families, ...families },
        };
    }
    return byUpstream;
}

// Profiles are read per request, cached by mtime/size: editing a profile applies on the next
// request, no proxy restart. The stat pass is a handful of tiny files — noise next to the call.
function createModelRulesLoader(config) {
    const dir = config.profilesDir || PROFILES_DIR;
    let signature = null;
    let rules = {};
    return (name) => {
        let sig = '';
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.json')) continue;
                const st = fs.statSync(path.join(dir, f));
                sig += `${f}:${st.mtimeMs}:${st.size};`;
            }
        } catch {
            sig = '';
        }
        if (sig !== signature) {
            signature = sig;
            rules = profileModelRules(config.port, dir);
        }
        return rules[name];
    };
}

// Remaps the model the caller sent to what the upstream should get. Exact ids (a profile's
// optional modelOverrides block) win; otherwise a claude-* id is resolved by family.
// A trailing [1m]/[2m] context marker is stripped before lookup so "claude-fable-5[1m]" matches.
function resolveUpstreamModel(model, rules) {
    if (!rules || !model) return model;
    const stripped = model.replace(/\[[12]m\]$/i, '');
    const exact = rules.exact?.[model] ?? rules.exact?.[stripped];
    if (exact) return exact;
    if (!/^claude-/i.test(stripped)) return model;
    const family = Object.keys(FAMILY_ENV).find((f) => stripped.includes(f));
    return (family && rules.families?.[family]) || model;
}

function log(...parts) {
    const line = `${new Date().toISOString()} ${parts
        .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
        .join(' ')}\n`;
    process.stdout.write(line);
    try {
        fs.mkdirSync(RUNTIME, { recursive: true });
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {}
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function sendError(res, status, message, type = 'api_error') {
    log('error', status, message);
    if (!res.headersSent) return sendJson(res, status, { type: 'error', error: { type, message } });
    res.end();
}

function upstreamKey(req, upstream) {
    const header = req.headers['x-api-key'] || '';
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return upstream.apiKey || process.env.CCX_UPSTREAM_API_KEY || header || bearer || '';
}

function writeEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function buildUpstreamCall(req, anthropic, upstream, name, { upstreamModel } = {}) {
    const protocol = upstream.protocol || 'chat';
    const base = upstream.baseUrl.replace(/\/$/, '');
    // What the caller asked for, which is not always what the upstream is asked for: the codex
    // backend only streams, so `request.stream` can be true while the caller wants one JSON body.
    const clientStream = !!anthropic.stream;
    // modelOverrides remap the model the caller asked for before the upstream ever sees it
    const request = upstreamModel ? { ...anthropic, model: upstreamModel } : anthropic;

    if (protocol === 'responses') {
        const translated = anthropicToResponses(request, {
            codexBackend: !!upstream.codexBackend,
            reasoningEffort: upstream.reasoningEffort,
        });
        const headers = { 'content-type': 'application/json', ...(upstream.headers || {}) };

        if (upstream.auth === 'chatgpt-oauth') {
            const { accessToken, accountId } = await getAuth();
            headers.authorization = `Bearer ${accessToken}`;
            if (accountId) headers['chatgpt-account-id'] = accountId;
            headers.originator = 'codex_cli_rs';
            headers.session_id = randomUUID();
        } else {
            const key = upstreamKey(req, upstream);
            if (key) headers.authorization = `Bearer ${key}`;
        }
        return { protocol, url: `${base}/responses`, headers, request: translated, stream: clientStream };
    }

    const translated = anthropicToOpenAI(request);
    const key = upstreamKey(req, upstream);
    return {
        protocol,
        url: `${base}/chat/completions`,
        headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(upstream.headers || {}),
        },
        request: translated,
        stream: clientStream,
    };
}

async function handleMessages(req, res, body, upstream, name, modelRules) {
    let anthropic;
    try {
        anthropic = JSON.parse(body);
    } catch {
        return sendError(res, 400, 'invalid JSON body', 'invalid_request_error');
    }

    // Remap the model the caller asked for (e.g. a literal "claude-fable-5" from the
    // built-in picker) to what the profile's env block says this upstream should get
    const requestedModel = anthropic.model;
    const upstreamModel = resolveUpstreamModel(requestedModel, modelRules);

    let call;
    try {
        call = await buildUpstreamCall(req, anthropic, upstream, name, { upstreamModel });
    } catch (e) {
        return sendError(res, 401, e.message, 'authentication_error');
    }
    const { protocol, url, headers, request } = call;

    log('request', {
        upstream: name,
        protocol,
        model: request.model,
        ...(requestedModel !== upstreamModel ? { requested: requestedModel } : {}),
        stream: !!call.stream,
        items: protocol === 'responses' ? request.input.length : request.messages.length,
        tools: request.tools ? request.tools.length : 0,
    });

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
    } catch (e) {
        return sendError(res, 502, `upstream unreachable: ${e.message}`);
    }

    if (!upstreamResponse.ok) {
        const text = await upstreamResponse.text().catch(() => '');
        return sendError(res, upstreamResponse.status, `upstream ${upstreamResponse.status}: ${text.slice(0, 500)}`);
    }

    if (!call.stream) {
        // The codex backend only streams, so an upstream stream can sit behind a caller that wants
        // one JSON body — answering it with SSE gives the SDK a string where a message should be
        if (protocol === 'responses' && request.stream)
            return collectResponses(req, res, upstreamResponse, request);

        const payload = await upstreamResponse.json();
        return sendJson(
            res,
            200,
            protocol === 'responses'
                ? responsesToAnthropic(payload, request.model)
                : openAIToAnthropic(payload, request.model)
        );
    }

    if (protocol === 'responses') return streamResponses(req, res, upstreamResponse, request);

    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });

    const translator = createStreamTranslator(request.model);
    const emit = (events) => {
        for (const { event, data } of events) writeEvent(res, event, data);
    };

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closed = false;

    req.on('close', () => {
        closed = true;
        reader.cancel().catch(() => {});
    });

    try {
        while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sep;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                for (const line of raw.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        emit(translator.chunk(JSON.parse(payload)));
                    } catch (e) {
                        log('chunk parse failed', e.message);
                    }
                }
            }
        }
        emit(translator.finish());
    } catch (e) {
        log('stream failed', e.message);
        emit(translator.finish());
    }
    res.end();
}

// Splits an SSE body into (event name, payload) pairs. Shared by both Responses paths so the
// streamed and the collected answer are built from exactly the same framing.
async function readSse(req, upstreamResponse, onEvent) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let closed = false;

    req.on('close', () => {
        closed = true;
        reader.cancel().catch(() => {});
    });

    while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);

            let eventName = null;
            let dataLine = '';
            for (const line of block.split('\n')) {
                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
            }
            if (!dataLine || dataLine === '[DONE]') continue;

            let payload;
            try {
                payload = JSON.parse(dataLine);
            } catch (e) {
                log('responses chunk parse failed', e.message);
                continue;
            }
            onEvent(eventName || payload.type, payload);
        }
    }
}

// An overloaded upstream is retryable, so it keeps the status the CLI backs off on
const failureStatus = (message) => (/overload|try again|temporarily/i.test(message) ? 529 : 502);

async function streamResponses(req, res, upstreamResponse, request) {
    // Headers are sent lazily: while they are pending, a failure can still be reported with a real HTTP status;
    // otherwise the CLI sees "200 with an empty body" and cannot tell it was an error
    const ensureHeaders = () => {
        if (res.headersSent) return;
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
    };

    const translator = createResponsesStreamTranslator(request.model);
    const emit = (events) => {
        if (!events.length) return;
        ensureHeaders();
        for (const { event, data } of events) writeEvent(res, event, data);
    };

    try {
        await readSse(req, upstreamResponse, (name, payload) => emit(translator.event(name, payload)));

        // A failure must not be closed like a normal response: the CLI would treat it as success and never retry
        if (translator.failure) {
            log('upstream reported failure', translator.failure);
            const status = failureStatus(translator.failure);
            const type = status === 529 ? 'overloaded_error' : 'api_error';
            if (!res.headersSent) return sendError(res, status, translator.failure, type);
            writeEvent(res, 'error', { type: 'error', error: { type, message: translator.failure } });
        } else {
            emit(translator.finish());
        }
    } catch (e) {
        log('stream failed', e.message);
        if (!res.headersSent) return sendError(res, 502, e.message);
        writeEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: e.message } });
    }
    res.end();
}

// Non-streaming caller in front of a streaming backend: collect the SSE, answer with one message
async function collectResponses(req, res, upstreamResponse, request) {
    const collector = createResponsesCollector();

    try {
        await readSse(req, upstreamResponse, (name, payload) => collector.event(name, payload));
    } catch (e) {
        log('stream failed', e.message);
        return sendError(res, 502, e.message);
    }

    if (collector.failure) {
        log('upstream reported failure', collector.failure);
        const status = failureStatus(collector.failure);
        return sendError(res, status, collector.failure, status === 529 ? 'overloaded_error' : 'api_error');
    }

    const payload = collector.result;
    if (!payload) return sendError(res, 502, 'upstream closed without a response');
    return sendJson(res, 200, responsesToAnthropic(payload, request.model));
}

function createServer(config) {
    const rulesFor = createModelRulesLoader(config);
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean);

        if (url.pathname === '/health') return sendJson(res, 200, { ok: true, upstreams: Object.keys(config.upstreams) });
        if (req.method !== 'POST') return sendError(res, 404, `not found: ${req.method} ${url.pathname}`);

        const name = segments[0] && !segments[0].startsWith('v1') ? segments[0] : 'openai';
        const upstream = config.upstreams[name];
        if (!upstream) return sendError(res, 404, `unknown upstream "${name}"`, 'invalid_request_error');

        const body = await readBody(req);

        if (url.pathname.endsWith('/count_tokens')) {
            try {
                return sendJson(res, 200, { input_tokens: estimateTokens(JSON.parse(body)) });
            } catch {
                return sendError(res, 400, 'invalid JSON body', 'invalid_request_error');
            }
        }
        if (url.pathname.endsWith('/v1/messages') || url.pathname.endsWith('/messages'))
            return handleMessages(req, res, body, upstream, name, rulesFor(name));

        return sendError(res, 404, `not found: ${url.pathname}`);
    });
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
    const config = loadConfig();
    const server = createServer(config);
    server.listen(config.port, '127.0.0.1', () => {
        log(`proxy listening on http://127.0.0.1:${config.port}`, { upstreams: Object.keys(config.upstreams) });
    });
    server.on('error', (e) => {
        log('listen failed', e.message);
        process.exit(1);
    });
}

export { createServer, loadConfig, DEFAULTS, profileModelRules };
