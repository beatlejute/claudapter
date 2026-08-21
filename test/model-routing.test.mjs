// A subagent's `model:` can carry a `@<upstream>[:<model>]` marker that re-routes the request to
// a different proxied upstream than the one the session's base URL names. The bare form defaults
// to the sonnet family (resolved by the target's own rules); an explicit `:model` is resolved by
// that upstream too, or passed through unchanged when it is not a claude-* id.
//   node test/model-routing.test.mjs

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer, routeByModel } from '../src/proxy/server.mjs';

const BACKEND_EVENTS = (model) => [
    ['response.created', { type: 'response.created', response: { id: 'r1', model } }],
    [
        'response.completed',
        {
            type: 'response.completed',
            response: {
                id: 'r1',
                model,
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
                usage: { input_tokens: 3, output_tokens: 1 },
            },
        },
    ],
];

async function main() {
    // --- routeByModel: marker parsing in isolation
    assert.deepStrictEqual(routeByModel('@deepseek'), { name: 'deepseek', model: 'claude-sonnet-5' });
    assert.deepStrictEqual(routeByModel('@deepseek:claude-opus-4-8'), { name: 'deepseek', model: 'claude-opus-4-8' });
    assert.deepStrictEqual(routeByModel('@codex:gpt-5.6-terra'), { name: 'codex', model: 'gpt-5.6-terra' });
    assert.deepStrictEqual(routeByModel('@openai-responses:'), { name: 'openai-responses', model: 'claude-sonnet-5' });
    assert.strictEqual(routeByModel('claude-sonnet-5'), null);
    assert.strictEqual(routeByModel('gpt-5.6-terra'), null);
    assert.strictEqual(routeByModel(undefined), null);
    assert.strictEqual(routeByModel(''), null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-rt-'));
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    const writeProfile = (name, obj) =>
        fs.writeFileSync(path.join(dir, 'profiles', `${name}.json`), JSON.stringify(obj));

    writeProfile('codex', {
        env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/codex',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-luna',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.6-terra',
        },
    });
    writeProfile('deepseek', {
        env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/deepseek',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-ultra',
        },
    });

    // --- one backend, two paths: the proxy appends /<upstream>/responses so the backend can tell
    //     which upstream handled the request
    let last = null;
    const backend = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const request = JSON.parse(body);
            last = { url: req.url, model: request.model };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const [name, payload] of BACKEND_EVENTS(request.model))
                res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    await new Promise((r) => backend.listen(0, '127.0.0.1', r));
    const backendUrl = `http://127.0.0.1:${backend.address().port}`;

    const proxy = createServer({
        port: 8787,
        profilesDir: path.join(dir, 'profiles'),
        upstreams: {
            codex: { baseUrl: `${backendUrl}/codex`, protocol: 'responses', codexBackend: true, auth: 'key' },
            deepseek: { baseUrl: `${backendUrl}/deepseek`, protocol: 'responses', codexBackend: true, auth: 'key' },
        },
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}/codex`;

    const send = async (model) => {
        const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: false }),
        });
        assert.strictEqual(res.status, 200, `HTTP 200 for ${model}`);
        await res.json();
        return last;
    };

    // baseline: no marker → the session's upstream, sonnet remapped by its own rules
    assert.deepStrictEqual(await send('claude-sonnet-5'), { url: '/codex/responses', model: 'gpt-5.6-luna' }, 'no marker stays on codex');

    // bare marker → target upstream, default sonnet family resolved by the target's rules
    assert.deepStrictEqual(await send('@deepseek'), { url: '/deepseek/responses', model: 'deepseek-v4-pro' }, '@deepseek → deepseek, default model');

    // explicit model → resolved by the target's family rules
    assert.deepStrictEqual(await send('@deepseek:claude-opus-4-8'), { url: '/deepseek/responses', model: 'deepseek-v4-ultra' }, 'explicit model resolved by target family');

    // explicit non-claude model → passed through untouched
    assert.deepStrictEqual(await send('@deepseek:gpt-5.6-terra'), { url: '/deepseek/responses', model: 'gpt-5.6-terra' }, 'non-claude model passes through');

    // unknown target → 404, not silently dropped onto the default upstream
    const bad = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: '@unknown', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    assert.strictEqual(bad.status, 404, 'unknown upstream 404s');

    proxy.close();
    backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\nOK — a @upstream marker re-routes the request to another proxied upstream');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
