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

const {
    TOOLS,
    callTool,
    handle,
    envForProfile,
    describeProfile,
    describeHealth,
    preflight,
    providerMessage,
    parseResetAt,
    usageTotals,
    formatTokens,
    formatCost,
    describeModel,
    execAllowlist,
    MODES,
    MODE_ALIASES,
} = await import('../src/mcp/agent-server.mjs');

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
    assert.deepStrictEqual(names, ['check_agent', 'list_profiles', 'run_agent', 'stop_agent'], 'every tool listed');
    const runAgent = TOOLS.find((t) => t.name === 'run_agent');
    // profile is not required any more: a resumed session already knows which provider it belongs to
    assert.deepStrictEqual(runAgent.inputSchema.required, ['prompt'], 'only the prompt is always required');
    assert.ok(runAgent.inputSchema.properties.session, 'a run can be continued');
    assert.ok(runAgent.inputSchema.properties.background, 'a run can be backgrounded');
    assert.deepStrictEqual(runAgent.inputSchema.properties.mode.enum, ['read', 'exec', 'write', 'full']);

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
    assert.deepStrictEqual(MODES.full, ['--permission-mode', 'bypassPermissions']);

    // exec is read plus a shell that can only collect. The commands a data-gathering task actually
    // needs have to be on it — without them the run burns its budget being refused — and the ones
    // that change the tree must not be.
    const exec = MODES.exec[1].split(',');
    assert.strictEqual(MODES.exec[0], '--allowedTools');
    for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(exec.includes(tool), `exec keeps ${tool} from read`);
    for (const rule of ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(python:*)', 'Bash(awk:*)', 'Bash(find:*)', 'Bash(wc:*)'])
        assert.ok(exec.includes(rule), `exec allows ${rule}`);
    for (const banned of ['Bash(rm:*)', 'Bash(mv:*)', 'Bash(cp:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git push:*)', 'Bash(npm install:*)'])
        assert.ok(!exec.includes(banned), `exec does not allow ${banned}`);
    assert.ok(!exec.includes('Edit') && !exec.includes('Write'), 'exec cannot edit files');

    // A PreToolUse hook may rewrite `git log` to `rtk git log` before the permission check sees it,
    // and the allowlist has to match what the check reads, not what the model wrote
    assert.ok(exec.includes('Bash(rtk git log:*)'), 'wrapped commands are allowed too');
    assert.ok(execAllowlist().every((r) => r.startsWith('Bash(') && r.endsWith(':*)')), 'every rule is a bash prefix rule');

    // write is exec plus auto-accepted edits: a run that may rewrite a file must be able to run the
    // test that proves it still works
    assert.strictEqual(MODES.write[0], '--permission-mode');
    assert.strictEqual(MODES.write[1], 'acceptEdits');
    assert.deepStrictEqual(MODES.write.slice(2), MODES.exec, 'write is a superset of exec');
    assert.strictEqual(MODE_ALIASES['read+exec'], 'exec', 'the name the mode was asked for still works');

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
    const handleProbeRequest = (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            probed = JSON.parse(body);
            res.writeHead(reply.status, { 'content-type': 'application/json' });
            res.end(reply.body);
        });
    };
    const provider = http.createServer(handleProbeRequest);
    let probed = null;
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    // A twin of the provider server bound on every interface, so the routed-probe tests can reach
    // it under 127.0.0.2 — an address loopbackHost() does not exempt, which is what sends those
    // probes through a proxy. (Loopback /8 works on Windows and Linux; on macOS this twin would
    // need an alias, and these two cases would need to be skipped there.)
    const wide = http.createServer(handleProbeRequest);
    await new Promise((r) => wide.listen(0, r));
    const widePort = wide.address().port;
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
    // A credential left as a placeholder is caught before the request: a header value must be Latin-1,
    // so fetch() would throw "Cannot convert argument to a ByteString…" from inside Headers and the
    // provider would be recorded as unreachable — pointing at the endpoint instead of at the profile.
    probed = null;
    const placeholder = { ...providerEnv, ANTHROPIC_AUTH_TOKEN: 'sk-ЗАМЕНИТЕ' };
    const refusal = await preflight(placeholder, 'haiku', 'placeholder');
    assert.match(refusal, /ANTHROPIC_AUTH_TOKEN is not a usable key/, 'the profile is named, not the network');
    assert.match(refusal, /character 4 is outside Latin-1/, 'and the position of the first bad character with it');
    assert.ok(!refusal.includes('ЗАМЕНИТЕ'), 'a credential is never quoted back');
    assert.strictEqual(probed, null, 'no request goes out for a key that cannot become a header');
    assert.match(describeHealth('placeholder'), /FAILED/, 'and the verdict is recorded as a refusal, not as silence');

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

    // --- the probe takes the route the run will take. A declared proxy applies to the probe too —
    //     plain fetch() would ignore it, and behind a filtering gateway the direct route draws a
    //     refusal no provider ever sent. Loopback endpoints are the exception: nothing local has
    //     any use for a corporate proxy, and this suite serves the probe from 127.0.0.1.
    const proxiedEnv = {
        ...providerEnv,
        ANTHROPIC_BASE_URL: `http://127.0.0.2:${widePort}`,
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
    };

    // nothing on the loopback needs a proxy: even with one declared, the request must not be routed
    probed = null;
    await preflight({ ...providerEnv, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' }, 'haiku');
    assert.strictEqual(probed.max_tokens, 1, 'a loopback endpoint is probed directly even under a declared proxy');

    // a non-loopback target whose proxy cannot be reached cannot be asked at all
    await preflight(proxiedEnv, 'haiku', 'routed-dead');
    assert.match(
        describeHealth('routed-dead'),
        /no answer .*did not respond/,
        'a proxy that cannot be reached is recorded as unanswered, never as a refusal',
    );
    assert.strictEqual(await preflight(proxiedEnv, 'haiku'), null, 'an unanswered route does not block the run');
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
    wide.close();
    assert.strictEqual(providerMessage('{"error":{"message":"deep"}}'), 'deep');
    assert.strictEqual(providerMessage('{"message":"flat"}'), 'flat');
    // the adapter hands an upstream refusal on with a sentence in front of the JSON
    assert.strictEqual(
        providerMessage('upstream 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}'),
        'The usage limit has been reached',
        'a wrapped body still yields the provider’s own sentence',
    );

    // --- a refusal that says when it lifts is the difference between waiting and switching
    const noon = Date.parse('2026-08-21T12:00:00Z');
    assert.strictEqual(
        parseResetAt('upstream 429: {"error":{"resets_at":1787826173,"resets_in_seconds":530718}}', null, noon),
        new Date(1787826173000).toISOString(),
        'a unix resets_at wins over the countdown beside it',
    );
    assert.strictEqual(
        parseResetAt('{"message":"slow down"}', new Headers({ 'retry-after': '120' }), noon),
        new Date(noon + 120000).toISOString(),
        'a retry-after header counts as a reset time',
    );
    assert.strictEqual(
        parseResetAt('Your token-plan 1-week quota has been exhausted. The quota will reset at 08-27 08:17:00 UTC.', null, noon),
        '2026-08-27T08:17:00.000Z',
        'a reset stated in words is understood',
    );
    // a month/day with no year that already passed belongs to next year, not this one
    assert.strictEqual(
        parseResetAt('The quota will reset at 01-05 00:00:00 UTC.', null, noon),
        '2027-01-05T00:00:00.000Z',
        'a date already behind us rolls into next year',
    );
    assert.strictEqual(parseResetAt('plain refusal', null, noon), null, 'a refusal that says nothing yields nothing');

    // --- the last thing a provider said, shown in the listing so a spent quota is known before a
    //     call rather than during one
    const health = {
        glm: { at: new Date(noon - 300000).toISOString(), ok: false, status: 429, message: 'Insufficient balance.' },
        qwen: { at: new Date(noon - 60000).toISOString(), ok: false, status: 429, message: 'Quota exhausted.', resets_at: '2026-08-27T08:17:00.000Z' },
        deepseek: { at: new Date(noon - 3600000).toISOString(), ok: true },
    };
    assert.match(describeHealth('glm', noon, health), /FAILED 5m ago · HTTP 429 · Insufficient balance\./);
    assert.match(describeHealth('qwen', noon, health), /resets 2026-08-27 08:17Z \(in 5d 20h\)/, 'and when it lifts');
    assert.strictEqual(describeHealth('deepseek', noon, health), 'ok 60m ago');
    assert.strictEqual(describeHealth('codex', noon, health), '', 'a profile never called says nothing — silence is not health');
    assert.match(describeProfile('qwen', noon, health), /\n {4}FAILED/, 'the status hangs under the profile line');

    // --- spend: the same four columns for every provider, from the whole-run totals
    //
    // `usage` and `modelUsage` are both cumulative over the run — they equal the sum over *distinct*
    // assistant message ids in the transcript. Summing the transcript's lines instead multiplies
    // that, because the CLI repeats a message's usage on every content block it writes.
    const payload = {
        usage: { input_tokens: 20841, output_tokens: 1355, cache_read_input_tokens: 20992, cache_creation_input_tokens: 0 },
        modelUsage: {
            'deepseek-chat': { inputTokens: 20841, outputTokens: 1355, cacheReadInputTokens: 20992, cacheCreationInputTokens: 0 },
        },
        total_cost_usd: 0.148576,
    };
    const totals = usageTotals(payload);
    assert.strictEqual(totals.input, 20841);
    assert.strictEqual(totals.cacheRead, 20992);
    assert.deepStrictEqual(
        totals.perModel.map((r) => r.model),
        ['deepseek-chat'],
        'the model that answered comes from modelUsage',
    );
    assert.strictEqual(
        formatTokens(totals),
        'tokens: in 20,841 · out 1,355 · cache write 0 · cache read 20,992',
        'a zero column is printed, not dropped — a column that vanishes cannot be compared',
    );
    assert.deepStrictEqual(usageTotals({ usage: payload.usage }), { ...totals, perModel: [] }, 'usage alone still totals the same');
    assert.strictEqual(usageTotals(undefined).input, 0, 'a result with no usage at all is zero, not a crash');

    // the alias the run asked for and the model that answered are both named: one is what was
    // typed, the other is what the tokens above were spent on
    assert.strictEqual(describeModel(payload, {}, 'sonnet'), 'model: sonnet → deepseek-chat');
    assert.strictEqual(
        describeModel({}, { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash' }, 'sonnet'),
        'model: sonnet → deepseek-v4-flash',
        'with no modelUsage the profile’s own mapping answers',
    );
    assert.strictEqual(describeModel({}, {}, 'some-literal-id'), 'model: some-literal-id', 'a literal id is not repeated twice');

    // the CLI prices every provider against Anthropic's table, so its figure is only the truth on
    // Anthropic itself. Anywhere else the number comes from the profile, or it is not claimed.
    assert.match(formatCost('claude', totals, payload), /^cost: \$0\.1486 · Anthropic billing$/);
    assert.match(formatCost('deepseek', totals, payload), /^cost: — · add "pricing"/, 'an unpriced provider says so');
    assert.match(formatCost('deepseek', totals, payload), /the CLI's \$0\.1486 is Anthropic's table/, 'and why the CLI number is not it');

    writeProfile('priced', {
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-x' },
        pricing: { 'deepseek-chat': { input: 0.28, output: 0.42, cache_read: 0.028 } },
    });
    // (20841·0.28 + 1355·0.42 + 20992·0.028) / 1e6
    assert.strictEqual(formatCost('priced', totals, payload), 'cost: $0.00699 · "priced" profile pricing');
    assert.match(
        formatCost('priced', { ...totals, perModel: [{ model: 'other-model', input: 10, output: 10, cacheWrite: 0, cacheRead: 0 }] }, payload),
        /no rate for other-model/,
        'a model the pricing block never mentions is named rather than silently priced at zero',
    );

    // --- continuing a delegated run: the session store is what makes a cheap provider usable for
    //     anything longer than one exchange
    fs.writeFileSync(
        path.join(runtime, 'agent-sessions.json'),
        JSON.stringify({
            'aaaaaaaa-1111-2222-3333-444444444444': { profile: 'deepseek', cwd: dir, model: 'sonnet', mode: 'read', at: new Date().toISOString() },
        }),
    );

    out = await capture(() =>
        handle({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'run_agent', arguments: { session: 'aaaaaaaa-1111-2222-3333-444444444444', prompt: 'and now?', profile: 'claude' } },
        }),
    );
    assert.ok(out[0].result.isError, 'a session cannot change providers mid-conversation');
    assert.match(out[0].result.content[0].text, /belongs to the "deepseek" profile/, 'and the run it belongs to is named');

    out = await capture(() =>
        handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'run_agent', arguments: { session: 'not-a-session', prompt: 'hi' } } }),
    );
    assert.match(out[0].result.content[0].text, /is not a session id/, 'a session id is checked before anything is spawned');

    out = await capture(() =>
        handle({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: { name: 'run_agent', arguments: { session: 'bbbbbbbb-1111-2222-3333-444444444444', prompt: 'hi' } },
        }),
    );
    assert.match(out[0].result.content[0].text, /profile is required/, 'an unknown session cannot supply a provider');

    // --- background: the call returns a task id at once instead of holding the turn for 15 minutes
    //
    // The CLI path is deliberately bogus, so the run fails the moment it is spawned: what is under
    // test is the task's lifecycle, not the child's answer.
    process.env.CLAUDAPTER_CLAUDE_BIN = path.join(dir, 'no-such-claude-binary');
    const started = await callTool('run_agent', { profile: 'claude', prompt: 'count the files', background: true });
    assert.match(started, /^task_1 started/, 'a task id comes back immediately');
    assert.match(started, /check_agent\(\{ task: "task_1" \}\)/, 'and says how to collect it');
    assert.match(started, /cannot interrupt the session/, 'and is honest that nothing will arrive on its own');

    assert.match(await callTool('check_agent', {}), /^task_1 · claude · read · /, 'a listing shows every task and its state');

    // wait_ms blocks until it settles rather than making the caller poll
    await assert.rejects(
        () => callTool('check_agent', { task: 'task_1', wait_ms: 10000 }),
        /could not start the CLI/,
        'a failed background run surfaces its own error when collected',
    );
    assert.match(await callTool('check_agent', {}), /task_1 · claude · read · failed /, 'and the listing remembers the failure');
    assert.match(await callTool('stop_agent', { task: 'task_1' }), /had already finished \(failed\)/);
    await assert.rejects(() => callTool('check_agent', { task: 'task_99' }), /unknown task "task_99"/);
    delete process.env.CLAUDAPTER_CLAUDE_BIN;

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
