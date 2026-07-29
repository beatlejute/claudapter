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
} from './translate-responses.mjs';
import { getAuth } from './auth-chatgpt.mjs';

const RUNTIME = path.join(os.homedir(), '.claude', 'ui-ext');
const DEFAULT_CONFIG = path.join(RUNTIME, 'proxy.json');
const LOG_FILE = path.join(RUNTIME, 'proxy.log');

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
    return config;
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

async function buildUpstreamCall(req, anthropic, upstream, name) {
    const protocol = upstream.protocol || 'chat';
    const base = upstream.baseUrl.replace(/\/$/, '');

    if (protocol === 'responses') {
        const request = anthropicToResponses(anthropic, {
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
        return { protocol, url: `${base}/responses`, headers, request, stream: request.stream };
    }

    const request = anthropicToOpenAI(anthropic);
    const key = upstreamKey(req, upstream);
    return {
        protocol,
        url: `${base}/chat/completions`,
        headers: {
            'content-type': 'application/json',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...(upstream.headers || {}),
        },
        request,
        stream: !!request.stream,
    };
}

async function handleMessages(req, res, body, upstream, name) {
    let anthropic;
    try {
        anthropic = JSON.parse(body);
    } catch {
        return sendError(res, 400, 'invalid JSON body', 'invalid_request_error');
    }

    let call;
    try {
        call = await buildUpstreamCall(req, anthropic, upstream, name);
    } catch (e) {
        return sendError(res, 401, e.message, 'authentication_error');
    }
    const { protocol, url, headers, request } = call;

    log('request', {
        upstream: name,
        protocol,
        model: request.model,
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
        const payload = await upstreamResponse.json();
        return sendJson(
            res,
            200,
            protocol === 'responses'
                ? responsesToAnthropic(payload, request.model)
                : openAIToAnthropic(payload, request.model)
        );
    }

    if (protocol === 'responses') return streamResponses(req, res, upstreamResponse, request, anthropic);

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

async function streamResponses(req, res, upstreamResponse, request, anthropic) {
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
                emit(translator.event(eventName || payload.type, payload));
            }
        }
        // A failure must not be closed like a normal response: the CLI would treat it as success and never retry
        if (translator.failure) {
            log('upstream reported failure', translator.failure);
            const overloaded = /overload|try again|temporarily/i.test(translator.failure);
            if (!res.headersSent)
                return sendError(res, overloaded ? 529 : 502, translator.failure, 'overloaded_error');
            writeEvent(res, 'error', {
                type: 'error',
                error: { type: overloaded ? 'overloaded_error' : 'api_error', message: translator.failure },
            });
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

function createServer(config) {
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
            return handleMessages(req, res, body, upstream, name);

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

export { createServer, loadConfig, DEFAULTS };
