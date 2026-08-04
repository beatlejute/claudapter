// End-to-end test of the Responses mode (ChatGPT subscription / api.openai.com/v1/responses)
// against a fake backend: no tokens, no outbound network.
//   node test/responses.test.mjs

import http from 'node:http';
import assert from 'node:assert';
import { createServer } from '../src/proxy/server.mjs';
import {
    anthropicToResponses,
    responsesToAnthropic,
    createResponsesCollector,
} from '../src/proxy/translate-responses.mjs';

const EVENTS = [
    ['response.created', { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Let me ' }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'check' }],
    [
        'response.output_item.added',
        {
            type: 'response.output_item.added',
            item_id: 'item_1',
            item: { type: 'function_call', call_id: 'call_abc', name: 'Read' },
        },
    ],
    [
        'response.function_call_arguments.delta',
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"file_' },
    ],
    [
        'response.function_call_arguments.delta',
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: 'path":"a.js"}' },
    ],
    [
        'response.output_item.done',
        {
            type: 'response.output_item.done',
            item_id: 'item_1',
            item: { type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"a.js"}' },
        },
    ],
    [
        'response.completed',
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.5',
                output: [
                    { type: 'message', content: [{ type: 'output_text', text: 'Let me check' }] },
                    { type: 'function_call', call_id: 'call_abc', name: 'Read', arguments: '{"file_path":"a.js"}' },
                ],
                usage: { input_tokens: 210, output_tokens: 44 },
            },
        },
    ],
];

let lastRequest = null;
let failMode = false;

const FAIL_EVENTS = [
    ['response.created', { type: 'response.created', response: { id: 'resp_f', model: 'gpt-5.5' } }],
    [
        'response.failed',
        { type: 'response.failed', response: { error: { message: 'Our servers are currently overloaded.' } } },
    ],
];

const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const script =
            failMode === 'immediate' ? FAIL_EVENTS.slice(1) : failMode ? FAIL_EVENTS : EVENTS;
        for (const [name, payload] of script) res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
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
    await new Promise((r) => backend.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${backend.address().port}`;

    const proxy = createServer({
        port: 0,
        upstreams: {
            sub: { baseUrl, protocol: 'responses', codexBackend: true, auth: 'key' },
        },
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${proxy.address().port}/sub`;

    const request = {
        model: 'gpt-5.5[1m]',
        max_tokens: 4096,
        system: [{ type: 'text', text: 'you are an assistant', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'Read', description: 'reads a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: [{ type: 'text', text: 'look at a.js' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call_prev', name: 'Read', input: { p: 1 } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: 'contents' }] },
        ],
        stream: true,
    };

    const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    assert.strictEqual(res.status, 200, 'HTTP 200');
    const events = parseSse(await res.text());

    assert.strictEqual(events[0].event, 'message_start', 'first event is message_start');
    assert.strictEqual(events.at(-1).event, 'message_stop', 'last event is message_stop');

    const text = events
        .filter((e) => e.data.delta?.type === 'text_delta')
        .map((e) => e.data.delta.text)
        .join('');
    assert.strictEqual(text, 'Let me check', 'text assembled from deltas');

    const toolStart = events.find((e) => e.data.content_block?.type === 'tool_use');
    assert.ok(toolStart, 'tool_use block present');
    assert.strictEqual(toolStart.data.content_block.id, 'call_abc', 'call_id forwarded as tool id');
    assert.strictEqual(toolStart.data.content_block.name, 'Read', 'tool name');

    const args = events
        .filter((e) => e.data.delta?.type === 'input_json_delta')
        .map((e) => e.data.delta.partial_json)
        .join('');
    assert.deepStrictEqual(JSON.parse(args), { file_path: 'a.js' }, 'arguments assembled into valid JSON');

    const messageDelta = events.find((e) => e.event === 'message_delta');
    assert.strictEqual(messageDelta.data.delta.stop_reason, 'tool_use', 'stop_reason=tool_use');
    assert.strictEqual(messageDelta.data.usage.output_tokens, 44, 'usage forwarded');

    const starts = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
    assert.deepStrictEqual(starts, [...new Set(starts)], 'block indexes are unique');
    for (const index of starts)
        assert.ok(
            events.some((e) => e.event === 'content_block_stop' && e.data.index === index),
            `block ${index} closed`
        );

    // --- backend received a Responses-shaped request
    assert.strictEqual(lastRequest.url, '/responses', 'path is /responses');
    const sent = lastRequest.body;
    assert.strictEqual(sent.model, 'gpt-5.5', '[1m] suffix stripped');
    assert.strictEqual(sent.store, false, 'store=false');
    assert.strictEqual(sent.stream, true, 'codex backend always streams');
    assert.match(sent.instructions, /Claude Code/, 'codex instructions injected');
    assert.strictEqual(sent.input[0].content[0].text, 'you are an assistant', 'system moved into the first input message');
    assert.ok(
        sent.input.some((i) => i.type === 'function_call' && i.call_id === 'call_prev'),
        'tool_use -> function_call'
    );
    assert.ok(
        sent.input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_prev'),
        'tool_result -> function_call_output'
    );
    assert.strictEqual(sent.tools[0].type, 'function', 'tools are flat (Responses shape)');
    assert.strictEqual(sent.tools[0].name, 'Read', 'tool name at top level');

    // --- non-codex mode keeps the system prompt in instructions
    const plain = anthropicToResponses({ model: 'gpt-5.5', system: 'instruction', messages: [] });
    assert.strictEqual(plain.instructions, 'instruction', 'without codex the system prompt stays in instructions');
    assert.strictEqual(plain.input.length, 0, 'no extra input messages added');

    // --- non-streaming parsing
    const message = responsesToAnthropic(
        {
            id: 'resp_2',
            model: 'gpt-5.5',
            output: [
                { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
                { type: 'function_call', call_id: 'call_z', name: 'Bash', arguments: '{"cmd":"ls"}' },
            ],
            usage: { input_tokens: 5, output_tokens: 2 },
        },
        'gpt-5.5'
    );
    assert.strictEqual(message.content[0].text, 'done', 'text parsed');
    assert.deepStrictEqual(message.content[1].input, { cmd: 'ls' }, 'arguments parsed');
    assert.strictEqual(message.stop_reason, 'tool_use', 'stop_reason with tool_use present');

    // --- a non-streaming caller gets one JSON message, not SSE.
    // Claude Code's auto-mode permission classifier asks this way; served with text/event-stream
    // the SDK hands back the raw body as a string and the classifier dies on `usage.input_tokens`,
    // which fails closed and denies every Edit.
    const single = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({ ...request, stream: false }),
    });
    assert.strictEqual(single.status, 200, 'non-streaming HTTP 200');
    assert.match(
        single.headers.get('content-type') || '',
        /application\/json/,
        'non-streaming request answered as JSON'
    );
    const body = await single.json();
    assert.strictEqual(body.type, 'message', 'body is an Anthropic message');
    assert.strictEqual(body.usage.input_tokens, 210, 'usage.input_tokens present — the classifier reads it');
    assert.strictEqual(body.usage.output_tokens, 44, 'usage.output_tokens present');
    assert.strictEqual(body.content[0].text, 'Let me check', 'text collected from the stream');
    assert.deepStrictEqual(body.content[1].input, { file_path: 'a.js' }, 'tool arguments collected');
    assert.strictEqual(body.stop_reason, 'tool_use', 'stop_reason set');
    assert.strictEqual(lastRequest.body.stream, true, 'the codex backend is still asked to stream');

    // --- collector fallback: a terminal event without `output` falls back to the items seen
    const collector = createResponsesCollector();
    collector.event('response.output_item.done', {
        item: { type: 'message', content: [{ type: 'output_text', text: 'partial' }] },
    });
    collector.event('response.completed', { response: { usage: { input_tokens: 7, output_tokens: 1 } } });
    const rebuilt = responsesToAnthropic(collector.result, 'gpt-5.5');
    assert.strictEqual(rebuilt.content[0].text, 'partial', 'output rebuilt from item events');
    assert.strictEqual(rebuilt.usage.input_tokens, 7, 'usage kept from the terminal event');

    // --- truncated answers report max_tokens
    const truncated = responsesToAnthropic(
        { output: [], incomplete_details: { reason: 'max_output_tokens' }, usage: {} },
        'gpt-5.5'
    );
    assert.strictEqual(truncated.stop_reason, 'max_tokens', 'max_output_tokens -> max_tokens');

    // --- 6a. failure BEFORE the first event: a real HTTP status instead of "200 with an empty body"
    failMode = 'immediate';
    const early = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    assert.strictEqual(early.status, 529, 'immediate failure surfaces as HTTP 529 (overloaded)');
    const earlyBody = await early.json();
    assert.strictEqual(earlyBody.error.type, 'overloaded_error', 'error type is overloaded_error');
    assert.match(earlyBody.error.message, /overloaded/i, 'backend message preserved');

    // --- 6b. failure AFTER the stream started: an error event inside the SSE
    failMode = true;
    const failed = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    const failEvents = parseSse(await failed.text());
    const errorEvent = failEvents.find((e) => e.event === 'error');
    assert.ok(errorEvent, 'response.failed produces an error event');
    assert.match(errorEvent.data.error.message, /overloaded/i, 'backend error message preserved');
    assert.ok(
        !failEvents.some((e) => e.event === 'message_stop'),
        'message_stop is NOT sent — otherwise the CLI treats the answer as successful and never retries'
    );
    failMode = false;

    proxy.close();
    backend.close();
    console.log('\nOK — Responses mode works');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
