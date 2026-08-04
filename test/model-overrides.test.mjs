// The proxy derives model remap rules from the profile's own env block: the CLI applies
// ANTHROPIC_DEFAULT_<FAMILY>_MODEL only to family aliases ("fable"), so a literal id like
// "claude-fable-5" — the built-in picker entry, a subagent's `model:` — would pass through
// and 400 on a non-Anthropic upstream. The proxy remaps any claude-<family>-* id with the
// same env vars; an optional modelOverrides block in the profile wins for exact ids.
//   node test/model-overrides.test.mjs

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { createServer, profileModelRules } from '../src/proxy/server.mjs';

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
    // --- profileModelRules: rules come from the env block of profiles routed to this port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-mo-'));
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    const writeProfile = (name, obj) =>
        fs.writeFileSync(path.join(dir, 'profiles', `${name}.json`), JSON.stringify(obj));

    writeProfile('codex', {
        env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/codex',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.6-terra',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-luna',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.6-luna',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-5.6-sol',
        },
        modelOverrides: { 'claude-opus-4-1': 'gpt-5.6-legacy' },
    });
    writeProfile('wrong-port', {
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/codex', ANTHROPIC_DEFAULT_FABLE_MODEL: 'nope' },
    });
    writeProfile('not-loopback', {
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_DEFAULT_FABLE_MODEL: 'nope' },
    });

    const rules = profileModelRules(8787, path.join(dir, 'profiles'));
    assert.deepStrictEqual(rules, {
        codex: {
            exact: { 'claude-opus-4-1': 'gpt-5.6-legacy' },
            families: {
                fable: 'gpt-5.6-sol',
                opus: 'gpt-5.6-terra',
                sonnet: 'gpt-5.6-luna',
                haiku: 'gpt-5.6-luna',
            },
        },
    });

    // --- end to end: the proxy remaps the model before the request hits the backend
    let lastRequest = null;
    const backend = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            lastRequest = JSON.parse(body);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const [name, payload] of BACKEND_EVENTS(lastRequest.model))
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
            codex: {
                baseUrl: backendUrl,
                protocol: 'responses',
                codexBackend: true,
                auth: 'key',
            },
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
        return lastRequest.model;
    };

    assert.strictEqual(await send('claude-fable-5'), 'gpt-5.6-sol', 'fable literal → fable model');
    assert.strictEqual(await send('claude-fable-5[1m]'), 'gpt-5.6-sol', '[1m] marker stripped before lookup');
    assert.strictEqual(await send('claude-opus-5'), 'gpt-5.6-terra', 'opus literal → opus model');
    assert.strictEqual(await send('claude-opus-4-8'), 'gpt-5.6-terra', 'older opus id resolved by family');
    assert.strictEqual(await send('claude-sonnet-5'), 'gpt-5.6-luna', 'sonnet literal → sonnet model');
    assert.strictEqual(await send('claude-haiku-4-5'), 'gpt-5.6-luna', 'haiku literal → haiku model');
    assert.strictEqual(await send('claude-opus-4-1'), 'gpt-5.6-legacy', 'exact modelOverrides beats the family rule');
    assert.strictEqual(await send('gpt-5.6-terra'), 'gpt-5.6-terra', 'non-claude model passes through');

    // --- editing a profile applies on the next request — no proxy restart
    writeProfile('codex', {
        env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/codex',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-6-nova',
        },
    });
    assert.strictEqual(await send('claude-fable-5'), 'gpt-6-nova', 'profile edit picked up without restart');

    proxy.close();
    backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\nOK — model rules derived from the profile env are applied');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
