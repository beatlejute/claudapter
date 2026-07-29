// End-to-end adapter test against a fake OpenAI server: no keys, no outbound network.
//   node test/proxy.test.mjs

import http from 'node:http';
import assert from 'node:assert';
import { createServer } from '../src/proxy/server.mjs';
import { anthropicToOpenAI, openAIToAnthropic, estimateTokens } from '../src/proxy/translate.mjs';

const CHUNKS = [
    { id: 'chatcmpl-1', model: 'gpt-test', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { choices: [{ index: 0, delta: { content: 'Let me check' } }] },
    {
        choices: [
            {
                index: 0,
                delta: {
                    tool_calls: [
                        { index: 0, id: 'call_abc', type: 'function', function: { name: 'Read', arguments: '' } },
                    ],
                },
            },
        ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.js"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 34 } },
];

let lastUpstreamRequest = null;

const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        lastUpstreamRequest = { headers: req.headers, body: JSON.parse(body) };
        if (!lastUpstreamRequest.body.stream) {
            const payload = {
                id: 'chatcmpl-2',
                model: 'gpt-test',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'done',
                            tool_calls: [
                                { id: 'call_z', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 7, completion_tokens: 3 },
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(payload));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of CHUNKS) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });
});

function parseSse(text) {
    const events = [];
    for (const block of text.split('\n\n')) {
        const event = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
}

async function main() {
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

    const proxy = createServer({ port: 0, upstreams: { mock: { baseUrl: upstreamUrl } } });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}/mock`;

    const request = {
        model: 'gpt-test[1m]',
        max_tokens: 1024,
        system: [{ type: 'text', text: 'you are an assistant', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'Read', description: 'reads a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'look at a.js' }] },
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_prev', name: 'Read', input: { file_path: 'b.js' } }],
            },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: 'contents of b' }] },
        ],
        stream: true,
    };

    // --- 1. streaming
    const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    assert.strictEqual(res.status, 200, 'stream: HTTP 200');
    const events = parseSse(await res.text());
    const types = events.map((e) => e.event);

    assert.strictEqual(types[0], 'message_start', 'first event is message_start');
    assert.strictEqual(types.at(-1), 'message_stop', 'last event is message_stop');
    assert.ok(types.includes('content_block_start'), 'content_block_start present');

    const textDeltas = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text);
    assert.strictEqual(textDeltas.join(''), 'Let me check', 'text assembled from deltas');

    const toolStart = events.find((e) => e.data.content_block?.type === 'tool_use');
    assert.ok(toolStart, 'tool_use block present');
    assert.strictEqual(toolStart.data.content_block.id, 'call_abc', 'tool id preserved');
    assert.strictEqual(toolStart.data.content_block.name, 'Read', 'tool name preserved');

    const jsonDeltas = events
        .filter((e) => e.data.delta?.type === 'input_json_delta')
        .map((e) => e.data.delta.partial_json)
        .join('');
    assert.deepStrictEqual(JSON.parse(jsonDeltas), { file_path: 'a.js' }, 'tool arguments assemble into valid JSON');

    const messageDelta = events.find((e) => e.event === 'message_delta');
    assert.strictEqual(messageDelta.data.delta.stop_reason, 'tool_use', 'stop_reason=tool_use');
    assert.strictEqual(messageDelta.data.usage.output_tokens, 34, 'usage forwarded');

    const blockIndexes = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
    assert.deepStrictEqual(blockIndexes, [...new Set(blockIndexes)], 'block indexes are unique');
    for (const index of blockIndexes)
        assert.ok(
            events.some((e) => e.event === 'content_block_stop' && e.data.index === index),
            `block ${index} closed`
        );

    // --- upstream received a well-formed OpenAI request
    const sent = lastUpstreamRequest.body;
    assert.strictEqual(sent.model, 'gpt-test', '[1m] suffix stripped');
    assert.strictEqual(sent.messages[0].role, 'system', 'system message comes first');
    assert.strictEqual(sent.messages[0].content, 'you are an assistant', 'system assembled from blocks (cache_control dropped)');
    assert.ok(sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_prev'), 'tool_result -> role:tool');
    assert.ok(
        sent.messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_prev'),
        'tool_use -> assistant.tool_calls'
    );
    assert.strictEqual(sent.tools[0].function.name, 'Read', 'tools forwarded');
    assert.strictEqual(sent.stream_options.include_usage, true, 'usage requested');
    assert.strictEqual(lastUpstreamRequest.headers.authorization, 'Bearer sk-test', 'key forwarded from x-api-key');

    // --- 2. non-streaming
    const plain = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({ ...request, stream: false }),
    });
    const message = await plain.json();
    assert.strictEqual(message.type, 'message', 'response is a message');
    assert.strictEqual(message.content[0].text, 'done', 'text present');
    assert.strictEqual(message.content[1].type, 'tool_use', 'tool_use present');
    assert.deepStrictEqual(message.content[1].input, { cmd: 'ls' }, 'arguments parsed');
    assert.strictEqual(message.stop_reason, 'tool_use', 'stop_reason correct');
    assert.strictEqual(message.usage.input_tokens, 7, 'usage.input_tokens');

    // --- 3. count_tokens
    const counted = await fetch(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });
    const tokens = await counted.json();
    assert.ok(tokens.input_tokens > 0, 'count_tokens returned an estimate');

    // --- 4. reasoning models use max_completion_tokens instead of max_tokens
    const reasoning = anthropicToOpenAI({ model: 'gpt-5.2', max_tokens: 100, temperature: 0.7, messages: [] });
    assert.strictEqual(reasoning.max_completion_tokens, 100, 'gpt-5 -> max_completion_tokens');
    assert.strictEqual(reasoning.max_tokens, undefined, 'gpt-5 has no max_tokens');
    assert.strictEqual(reasoning.temperature, undefined, 'gpt-5 has no temperature');

    const classic = anthropicToOpenAI({ model: 'gpt-4o', max_tokens: 100, temperature: 0.7, messages: [] });
    assert.strictEqual(classic.max_tokens, 100, 'gpt-4o -> max_tokens');
    assert.strictEqual(classic.temperature, 0.7, 'gpt-4o keeps temperature');

    // --- 5. stop_reason mapping
    assert.strictEqual(openAIToAnthropic({ choices: [{ finish_reason: 'length' }] }).stop_reason, 'max_tokens');
    assert.strictEqual(openAIToAnthropic({ choices: [{ finish_reason: 'stop' }] }).stop_reason, 'end_turn');
    assert.ok(estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }) >= 100);

    proxy.close();
    upstream.close();
    console.log('\nOK — all checks passed');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
