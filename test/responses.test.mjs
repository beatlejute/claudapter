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
    createReasoningStore,
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
let mode = 'ok';

const FAIL_EVENTS = [
    ['response.created', { type: 'response.created', response: { id: 'resp_f', model: 'gpt-5.5' } }],
    [
        'response.failed',
        { type: 'response.failed', response: { error: { message: 'Our servers are currently overloaded.' } } },
    ],
];

const REASONING_ITEM = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAAB-opaque' };

// The plan item comes out before the answer it produced, which is how it has to go back in
const REASONING_EVENTS = [
    EVENTS[0],
    ['response.output_item.done', { type: 'response.output_item.done', item_id: 'rs_1', item: REASONING_ITEM }],
    ...EVENTS.slice(1, -1),
    [
        'response.completed',
        {
            type: 'response.completed',
            response: {
                ...EVENTS.at(-1)[1].response,
                output: [REASONING_ITEM, ...EVENTS.at(-1)[1].response.output],
            },
        },
    ],
];

// The same run, answered off the prefix cache: the hit is counted *inside* input_tokens here
const CACHED_EVENTS = [
    ...EVENTS.slice(0, -1),
    [
        'response.completed',
        {
            type: 'response.completed',
            response: {
                ...EVENTS.at(-1)[1].response,
                usage: { input_tokens: 210, output_tokens: 44, input_tokens_details: { cached_tokens: 180 } },
            },
        },
    ],
];

// The connection simply ends: no failure to report, no terminal event either
const TRUNCATED_EVENTS = [EVENTS[0], EVENTS[1]];

const SCRIPTS = {
    ok: EVENTS,
    fail: FAIL_EVENTS,
    'fail-immediate': FAIL_EVENTS.slice(1),
    reasoning: REASONING_EVENTS,
    cached: CACHED_EVENTS,
    truncated: TRUNCATED_EVENTS,
};

let rejectReasoning = false;

const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        if (rejectReasoning && lastRequest.body.input.some((i) => i.type === 'reasoning')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Item 'rs_1' of type 'reasoning' is not allowed here" } }));
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [name, payload] of SCRIPTS[mode])
            res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
        if (mode !== 'truncated') res.write('data: [DONE]\n\n');
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

    // message_start is written before the backend has counted anything, and the CLI takes its context
    // meter and its auto-compact threshold from that number — at zero it never compacts.
    assert.ok(events[0].data.message.usage.input_tokens > 0, 'message_start opens with an input estimate');
    assert.strictEqual(messageDelta.data.usage.input_tokens, 210, 'message_delta corrects it with the real count');

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
    assert.deepStrictEqual(sent.include, ['reasoning.encrypted_content'], 'encrypted reasoning requested back');
    assert.match(
        sent.prompt_cache_key,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
        'the request names a prompt cache key: the conversation id, so the turns of one session share a cache'
    );

    // --- the harness prompt is restated next to the live turn.
    // First position is the far end of a growing input; by turn twenty everything after it outweighs
    // it, and the model answers conversationally — announcing a step instead of taking it.
    const last = sent.input.at(-1);
    assert.strictEqual(last.role, 'user', 'the reminder is the last input item');
    assert.match(last.content[0].text, /never end a turn by announcing/i, 'agent loop restated');

    // --- non-codex mode keeps the system prompt in instructions
    const plain = anthropicToResponses({ model: 'gpt-5.5', system: 'instruction', messages: [] });
    assert.strictEqual(plain.instructions, 'instruction', 'without codex the system prompt stays in instructions');
    assert.strictEqual(plain.input.length, 0, 'no extra input messages added');

    // --- a call that cannot act gets no reminder: title and classifier requests arrive without tools
    const toolless = anthropicToResponses(
        { model: 'gpt-5.5', system: 'rules', messages: [{ role: 'user', content: 'name this chat' }] },
        { codexBackend: true }
    );
    assert.strictEqual(toolless.input.length, 2, 'system + user only, no reminder without tools');

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
    assert.strictEqual(message.usage.cache_read_input_tokens, 0, 'no cache hit reported when there was none');

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

    // --- a cache hit is reported as one instead of being folded into the input count.
    // Caching here is implicit and a hit arrives inside `input_tokens`; Anthropic counts it beside
    // the input, and everything downstream sums the two — the CLI's context meter, claudapter's own
    // cost line. Left folded in, a hit is invisible and is charged again at the uncached rate.
    mode = 'cached';
    const hit = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    const hitDelta = parseSse(await hit.text()).find((e) => e.event === 'message_delta');
    assert.strictEqual(hitDelta.data.usage.cache_read_input_tokens, 180, 'the cached prefix is reported');
    assert.strictEqual(hitDelta.data.usage.input_tokens, 30, 'and subtracted from the input that counted it');
    assert.strictEqual(hitDelta.data.usage.output_tokens, 44, 'output is untouched');
    mode = 'ok';

    // --- 6a. failure BEFORE the first event: a real HTTP status instead of "200 with an empty body"
    mode = 'fail-immediate';
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
    mode = 'fail';
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

    // --- 6c. the stream just stops: no failure event, no terminal event either.
    // Closed as a normal answer this reads as a clean end_turn — the CLI sees success, does not retry,
    // and the agent silently gives up mid-task. It has to look like the error it is.
    mode = 'truncated';
    const cut = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    });
    const cutEvents = parseSse(await cut.text());
    assert.ok(
        cutEvents.some((e) => e.event === 'error'),
        'a stream without a terminal event produces an error event'
    );
    assert.ok(!cutEvents.some((e) => e.event === 'message_stop'), 'and never closes as a finished message');

    const cutSingle = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({ ...request, stream: false }),
    });
    assert.strictEqual(cutSingle.status, 502, 'the non-streaming caller gets a real error too');

    // --- 7. reasoning survives the turn.
    // The plan lives in reasoning items the visible answer never carries, and `store: false` leaves
    // the backend no copy — so without this the model re-derives its intent from its own prose every
    // request and abandons work it had already committed to.
    mode = 'reasoning';
    await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(request),
    }).then((r) => r.text());
    const firstSession = lastRequest.body.prompt_cache_key;

    const followUp = {
        ...request,
        messages: [
            ...request.messages,
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc', name: 'Read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'ok' }] },
        ],
    };
    await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(followUp),
    }).then((r) => r.text());

    const replayed = lastRequest.body.input;
    const planAt = replayed.findIndex((i) => i.type === 'reasoning');
    assert.ok(planAt !== -1, 'the reasoning item is replayed on the next turn');
    assert.strictEqual(replayed[planAt].encrypted_content, 'gAAAAAB-opaque', 'replayed verbatim');
    assert.strictEqual(
        replayed[planAt + 1].call_id,
        'call_abc',
        'and sits immediately before the call it produced'
    );
    assert.strictEqual(
        lastRequest.body.prompt_cache_key,
        firstSession,
        'both turns carry the same conversation id — a fresh one per request invalidates the replay, and misses the cache'
    );

    // --- a backend that refuses the replay must not take the session down with it.
    // Nothing else in the request can be rejected outright, and a rejected turn stays rejected: without
    // the fallback one bad assumption about the item format kills every following turn of the session.
    rejectReasoning = true;
    const rejected = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify(followUp),
    });
    assert.strictEqual(rejected.status, 200, 'a rejected replay is retried plainly, not surfaced as a 400');
    assert.ok(!lastRequest.body.input.some((i) => i.type === 'reasoning'), 'the retry carries no reasoning');
    assert.strictEqual(lastRequest.body.include, undefined, 'and stops asking for it');
    rejectReasoning = false;

    // --- the store keys on what actually comes back through the history
    const store = createReasoningStore();
    store.remember([REASONING_ITEM, { type: 'message', content: [{ type: 'output_text', text: 'thought' }] }]);
    assert.deepStrictEqual(
        store.recall([{ type: 'text', text: 'thought' }]),
        [REASONING_ITEM],
        'a turn without tool calls is recalled by its text'
    );
    assert.strictEqual(store.recall([{ type: 'text', text: 'other' }]), null, 'and nothing else matches it');

    mode = 'ok';
    proxy.close();
    backend.close();
    console.log('\nOK — Responses mode works');
}

main().catch((e) => {
    console.error('\nFAIL:', e.message);
    process.exit(1);
});
