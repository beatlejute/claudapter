// The delegated-agent MCP server: the JSON-RPC surface Claude Code talks to, and the environment
// a delegated run is spawned with. The env is the part that carries the whole feature — a leaked
// ANTHROPIC_AUTH_TOKEN from the calling session would silently send the agent to the wrong provider
// with the wrong key, and nothing downstream would notice.
//   node test/agent-server.test.mjs

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-mcp-'));
const profiles = path.join(dir, 'profiles');
const runtime = path.join(dir, 'runtime');
fs.mkdirSync(profiles, { recursive: true });
fs.mkdirSync(runtime, { recursive: true });

const writeProfile = (name, obj) => fs.writeFileSync(path.join(profiles, `${name}.json`), JSON.stringify(obj));

writeProfile('claude', { env: {} });
writeProfile('deepseek', {
    env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-deepseek',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        NO_PROXY: 'api.deepseek.com',
    },
});
writeProfile('codex', {
    env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/codex',
        ANTHROPIC_AUTH_TOKEN: 'sk-codex',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-luna',
    },
});

// The module reads these at import time
process.env.CLAUDAPTER_PROFILES_DIR = profiles;
process.env.CLAUDAPTER_RUNTIME_DIR = runtime;

const { TOOLS, callTool, handle, envForProfile, describeProfile, preflight, providerMessage, MODES } = await import(
    '../src/mcp/agent-server.mjs'
);

// Collects everything the server writes to stdout while running `fn`
async function capture(fn) {
    const written = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
        written.push(String(chunk));
        return true;
    };
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

async function main() {
    // --- initialize: the client's protocol version is echoed back, tools are advertised
    let out = await capture(() => handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));
    assert.strictEqual(out.length, 1, 'initialize answered once');
    assert.strictEqual(out[0].id, 1);
    assert.strictEqual(out[0].result.protocolVersion, '2024-11-05', 'client protocol echoed');
    assert.ok(out[0].result.capabilities.tools, 'tools capability advertised');
    assert.strictEqual(out[0].result.serverInfo.name, 'claudapter-agents');

    // --- a notification carries no id and must never be answered
    out = await capture(() => handle({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.strictEqual(out.length, 0, 'notification draws no reply');

    // --- tools/list
    out = await capture(() => handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const names = out[0].result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['list_profiles', 'run_agent'], 'both tools listed');
    const runAgent = TOOLS.find((t) => t.name === 'run_agent');
    assert.deepStrictEqual(runAgent.inputSchema.required, ['profile', 'prompt'], 'profile and prompt are required');

    // --- unknown method
    out = await capture(() => handle({ jsonrpc: '2.0', id: 3, method: 'tools/nope' }));
    assert.strictEqual(out[0].error.code, -32601, 'unknown method → method not found');

    // --- list_profiles reports the endpoint each profile resolves to
    const listed = await callTool('list_profiles', {});
    assert.match(listed, /claude — Anthropic subscription/, 'an empty env means the subscription');
    assert.match(listed, /deepseek — api\.deepseek\.com/, 'a direct provider shows its host');
    assert.match(listed, /codex — local adapter \(codex\)/, 'a 127.0.0.1 profile shows the adapter and its upstream');
    assert.match(listed, /sonnet=deepseek-v4-flash/, 'family mapping is reported');

    // --- env: the calling session's provider must not survive into the delegated run
    const parent = {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-glm-parent',
        ANTHROPIC_API_KEY: 'sk-ambient',
        CLAUDECODE: '1',
        CLAUDE_CODE_SSE_PORT: '55555',
        PATH: process.env.PATH,
    };
    const saved = { ...process.env };
    Object.assign(process.env, parent);

    let env = envForProfile('deepseek', 0);
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic', 'profile endpoint applied');
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek', "profile token replaces the caller's");
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined, 'ambient API key stripped — the CLI reads it before AUTH_TOKEN');
    assert.strictEqual(env.CLAUDECODE, undefined, "the caller's session vars are stripped");
    assert.strictEqual(env.CLAUDE_CODE_SSE_PORT, undefined, "the caller's IDE socket is stripped");
    assert.strictEqual(env.CLAUDAPTER_AGENT_DEPTH, '1', 'depth is stamped for the child');
    assert.strictEqual(env.NO_PROXY, 'api.deepseek.com', 'profile NO_PROXY applied');

    // the subscription profile declares nothing, so it must inherit *nothing* from the caller either
    env = envForProfile('claude', 0);
    assert.strictEqual(env.ANTHROPIC_BASE_URL, undefined, 'subscription profile carries no base url');
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, undefined, "the caller's token does not leak into the subscription");
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined, 'nor does an ambient key');

    // a proxied profile has to reach 127.0.0.1 past the corporate proxy
    env = envForProfile('codex', 1);
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787/codex');
    assert.match(env.NO_PROXY, /127\.0\.0\.1,localhost/, 'loopback excluded from the corporate proxy');
    assert.strictEqual(env.no_proxy, env.NO_PROXY, 'lowercase alias kept in step');
    assert.strictEqual(env.CLAUDAPTER_AGENT_DEPTH, '2', 'depth increments from the caller');

    process.env = saved;

    // --- modes map to the flags that bound what a delegated agent may do
    assert.deepStrictEqual(MODES.read, ['--allowedTools', 'Read,Grep,Glob,WebFetch,WebSearch'], 'read mode is a read-only allowlist');
    assert.deepStrictEqual(MODES.write, ['--permission-mode', 'acceptEdits']);
    assert.deepStrictEqual(MODES.full, ['--permission-mode', 'bypassPermissions']);

    // --- bad calls are reported as tool errors the model can correct, not as transport failures
    out = await capture(() =>
        handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_agent', arguments: { profile: 'nope', prompt: 'hi' } } }),
    );
    assert.ok(out[0].result.isError, 'unknown profile is an error result');
    assert.match(out[0].result.content[0].text, /unknown profile "nope"/, 'and it names the profile');
    assert.match(out[0].result.content[0].text, /claude, codex, deepseek/, 'and lists the ones that exist');

    out = await capture(() =>
        handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_agent', arguments: { profile: 'deepseek', prompt: '  ' } } }),
    );
    assert.match(out[0].result.content[0].text, /prompt is required/, 'an empty prompt is refused');

    out = await capture(() =>
        handle({
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: { name: 'run_agent', arguments: { profile: 'deepseek', prompt: 'hi', mode: 'sudo' } },
        }),
    );
    assert.match(out[0].result.content[0].text, /unknown mode "sudo"/, 'an invented mode is refused');

    // --- preflight: a provider that refuses must say so in its own words, not as a timeout
    //     15 minutes later. Both shapes seen in the wild are covered: Anthropic-style
    //     {error:{message}} (z.ai, the ChatGPT adapter) and a bare {message} (Alibaba).
    let reply = { status: 200, body: '{"content":[]}' };
    const provider = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            probed = JSON.parse(body);
            res.writeHead(reply.status, { 'content-type': 'application/json' });
            res.end(reply.body);
        });
    });
    let probed = null;
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    const providerEnv = {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
        ANTHROPIC_AUTH_TOKEN: 'sk-test',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cheap-model',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'expensive-model',
    };

    assert.strictEqual(await preflight(providerEnv, 'haiku'), null, 'a healthy provider does not block the run');
    assert.strictEqual(probed.max_tokens, 1, 'the probe asks for a single token');

    // The probe must name the model the run will use: a quota spent on one model while another
    // still answers would otherwise pass the probe and die on a timeout anyway
    assert.strictEqual(probed.model, 'cheap-model', 'the haiku alias resolves through the profile');
    await preflight(providerEnv, 'opus');
    assert.strictEqual(probed.model, 'expensive-model', 'the opus alias resolves to the opus model, not the cheapest one');
    await preflight(providerEnv, 'some-literal-id');
    assert.strictEqual(probed.model, 'some-literal-id', 'a literal id is probed as-is');

    // An alias the profile never mapped is an unknown model: probing the bare word would draw a 400
    // and refuse a run that the CLI, resolving it some other way, might well have completed
    probed = null;
    assert.strictEqual(await preflight(providerEnv, 'fable'), null, 'an unmapped alias is not probed');
    assert.strictEqual(probed, null, 'and no request goes out for it');

    // The CLI reads ANTHROPIC_API_KEY before ANTHROPIC_AUTH_TOKEN, so a profile may carry either
    const keyEnv = { ...providerEnv, ANTHROPIC_API_KEY: 'sk-key', ANTHROPIC_AUTH_TOKEN: undefined };
    delete keyEnv.ANTHROPIC_AUTH_TOKEN;
    assert.strictEqual(await preflight(keyEnv, 'haiku'), null, 'a profile authenticating by API key is probed too');
    probed = null;
    const { ANTHROPIC_AUTH_TOKEN, ...noAuth } = providerEnv;
    assert.strictEqual(await preflight(noAuth, 'haiku'), null, 'a profile with no credential at all is not probed');
    assert.strictEqual(probed, null, 'an empty auth header would draw a 401 and refuse a working run');

    reply = { status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"Insufficient balance. Please recharge."}}' };
    assert.match(await preflight(providerEnv, 'haiku'), /HTTP 429 — Insufficient balance/, "an exhausted balance is reported in the provider's words");

    reply = { status: 429, body: '{"code":"Throttling.AllocationQuota","message":"Your 1-week quota has been exhausted."}' };
    assert.match(await preflight(providerEnv, 'haiku'), /HTTP 429 — Your 1-week quota/, 'a bare {message} body is understood too');

    reply = { status: 400, body: 'not json at all' };
    assert.match(await preflight(providerEnv, 'haiku'), /HTTP 400 — not json at all/, 'an unparseable body is passed through verbatim');

    // the refusal reaches the caller as the reason the task never started. The profile has to map
    // the default (sonnet) family, or the probe would decline to guess and let the run proceed.
    writeProfile('broken', { env: { ...providerEnv, ANTHROPIC_DEFAULT_SONNET_MODEL: 'mid-model' } });
    out = await capture(() =>
        handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'run_agent', arguments: { profile: 'broken', prompt: 'hi' } } }),
    );
    assert.ok(out[0].result.isError, 'a refused provider fails the call');
    assert.match(out[0].result.content[0].text, /the task was not started/, 'and says the task never ran');
    assert.match(out[0].result.content[0].text, /HTTP 400/, 'and carries the provider status');

    // an env with no endpoint is the subscription profile — there is nothing to probe with
    assert.strictEqual(await preflight({}, 'sonnet'), null, 'the subscription profile is never probed');

    provider.close();
    assert.strictEqual(providerMessage('{"error":{"message":"deep"}}'), 'deep');
    assert.strictEqual(providerMessage('{"message":"flat"}'), 'flat');

    // --- the depth guard stops an agent chain from spawning itself forever
    process.env.CLAUDAPTER_AGENT_DEPTH = '2';
    out = await capture(() =>
        handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run_agent', arguments: { profile: 'deepseek', prompt: 'hi' } } }),
    );
    assert.match(out[0].result.content[0].text, /delegation depth 2 reached the limit/, 'depth is capped');
    delete process.env.CLAUDAPTER_AGENT_DEPTH;

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\nOK — the agent server answers JSON-RPC and spawns each profile with only its own credentials');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
