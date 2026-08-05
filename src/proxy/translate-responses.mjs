// Translation between Anthropic Messages API and OpenAI Responses API.
// Spoken by the ChatGPT subscription backend (chatgpt.com/backend-api/codex) and api.openai.com/v1/responses.

import { stopReasonFor, stripModelSuffix } from './translate.mjs';

const CODEX_INSTRUCTIONS = 'You are Claude Code, a software engineering agent running in a terminal.';

// The backend keeps its own `instructions`, so the harness prompt travels as the opening user turn.
// By turn twenty it sits behind everything that came after it, and the only text in the slot the
// model weighs most is the one line above — which says nothing about finishing the job. This is the
// restatement that rides next to the live turn.
const CODEX_AGENT_REMINDER = [
    '<system-reminder>',
    'The instructions in the first message of this conversation are the operating rules for this session and are still in force.',
    'You are running as an autonomous agent inside a tool loop, not in a chat: carry the task through to completion.',
    'If the next step is a tool call, make it in this turn — never end a turn by announcing an action you have not taken.',
    '</system-reminder>',
].join('\n');

function textOf(blocks) {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    return blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
}

function imageItem(block) {
    const src = block.source || {};
    if (src.type === 'base64') return { type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` };
    if (src.type === 'url') return { type: 'input_image', image_url: src.url };
    return null;
}

function toolResultText(block) {
    const content = block.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return textOf(content) || '';
    return '';
}

// A gpt-5 turn plans inside its reasoning items; the visible answer carries only the conclusion.
// Nothing brings those items back on the next request — Claude Code stores what it was shown, and
// `store: false` leaves the backend no copy either — so the model re-derives its intent from its own
// prose every time and abandons work it had already decided to do. The proxy keeps them instead,
// keyed by what does survive the round trip: the call_ids of that same response, or its text when
// the turn made no tool call. A miss (proxy restarted, entry evicted) just means today's behaviour.
function createReasoningStore(limit = 400) {
    const byKey = new Map();
    const textKey = (text) => (text ? `t:${text.length}:${text.slice(0, 200)}` : null);

    function keysOf(output) {
        const keys = [];
        let text = '';
        for (const item of output || []) {
            if (item?.type === 'function_call' && item.call_id) keys.push(`c:${item.call_id}`);
            if (item?.type === 'message')
                for (const part of item.content || []) if (part.type === 'output_text' && part.text) text += part.text;
        }
        if (keys.length) return keys;
        const key = textKey(text);
        return key ? [key] : [];
    }

    return {
        remember(output) {
            const items = (output || []).filter((i) => i?.type === 'reasoning');
            if (!items.length) return;
            for (const key of keysOf(output)) {
                byKey.set(key, items);
                if (byKey.size > limit) byKey.delete(byKey.keys().next().value);
            }
        },

        // The blocks of one assistant message -> the reasoning items that produced it
        recall(blocks) {
            for (const block of blocks)
                if (block?.type === 'tool_use' && block.id) {
                    const hit = byKey.get(`c:${block.id}`);
                    if (hit) return hit;
                }
            return byKey.get(textKey(textOf(blocks))) || null;
        },

        clear() {
            byKey.clear();
        },

        get size() {
            return byKey.size;
        },
    };
}

function messagesToInput(messages, reasoning) {
    const input = [];
    for (const message of messages || []) {
        const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];

        if (message.role === 'user') {
            for (const block of blocks)
                if (block?.type === 'tool_result')
                    input.push({
                        type: 'function_call_output',
                        call_id: block.tool_use_id,
                        output: toolResultText(block),
                    });

            const content = [];
            for (const block of blocks) {
                if (block?.type === 'text' && block.text) content.push({ type: 'input_text', text: block.text });
                else if (block?.type === 'image') {
                    const image = imageItem(block);
                    if (image) content.push(image);
                }
            }
            if (content.length) input.push({ type: 'message', role: 'user', content });
            continue;
        }

        // Ahead of the items it produced, which is where the API expects it
        const recalled = reasoning?.recall(blocks);
        if (recalled) input.push(...recalled);

        const text = textOf(blocks);
        if (text)
            input.push({
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text }],
            });

        for (const block of blocks)
            if (block?.type === 'tool_use')
                input.push({
                    type: 'function_call',
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {}),
                    status: 'completed',
                });
    }
    return input;
}

function toolsToResponses(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    return tools
        .filter((t) => t && t.name && !t.type)
        .map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} },
        }));
}

function toolChoiceToResponses(choice) {
    if (!choice) return undefined;
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'any') return 'required';
    if (choice.type === 'none') return 'none';
    if (choice.type === 'tool' && choice.name) return { type: 'function', name: choice.name };
    return undefined;
}

function anthropicToResponses(body, options = {}) {
    const { codexBackend = false, reasoningEffort, reasoning } = options;
    const system = textOf(body.system);

    const request = {
        model: stripModelSuffix(body.model),
        input: messagesToInput(body.messages, reasoning),
        stream: codexBackend ? true : !!body.stream,
        store: false,
    };

    // Nothing is stored upstream, so the encrypted plan has to come back with the answer or it is lost
    if (reasoning) request.include = ['reasoning.encrypted_content'];

    // The codex backend only accepts its own instructions, so the system prompt moves into the first input message
    if (codexBackend) {
        request.instructions = CODEX_INSTRUCTIONS;
        if (system) request.input.unshift({ type: 'message', role: 'user', content: [{ type: 'input_text', text: system }] });
    } else if (system) {
        request.instructions = system;
    }

    if (typeof body.temperature === 'number') request.temperature = body.temperature;
    if (typeof body.top_p === 'number') request.top_p = body.top_p;

    const tools = toolsToResponses(body.tools);
    if (tools) {
        request.tools = tools;
        const choice = toolChoiceToResponses(body.tool_choice);
        if (choice) request.tool_choice = choice;
        // Only for a call that can act: title and classifier requests arrive without tools
        if (codexBackend)
            request.input.push({
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: CODEX_AGENT_REMINDER }],
            });
    }
    if (reasoningEffort) request.reasoning = { effort: reasoningEffort };

    return request;
}

function responsesToAnthropic(payload, fallbackModel) {
    const content = [];
    for (const item of payload.output || []) {
        if (item.type === 'message')
            for (const part of item.content || [])
                if (part.type === 'output_text' && part.text) content.push({ type: 'text', text: part.text });
        if (item.type === 'function_call')
            content.push({
                type: 'tool_use',
                id: item.call_id,
                name: item.name,
                input: safeParse(item.arguments),
            });
    }
    const usage = payload.usage || {};
    const truncated = payload.incomplete_details?.reason === 'max_output_tokens';
    return {
        id: payload.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: payload.model || fallbackModel,
        content,
        stop_reason: content.some((c) => c.type === 'tool_use')
            ? 'tool_use'
            : stopReasonFor(truncated ? 'length' : 'stop'),
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
    };
}

// Collects a Responses SSE stream back into one response object.
// The codex backend only ever streams, so a caller that asked for a non-streaming
// answer needs the stream reassembled before it can be translated.
function createResponsesCollector() {
    let response = null;
    let failure = null;
    let completed = false;
    const items = [];

    return {
        event(name, payload) {
            switch (name) {
                case 'response.output_item.done':
                    if (payload.item) items.push(payload.item);
                    break;

                case 'response.completed':
                case 'response.incomplete':
                    completed = true;
                    if (payload.response) response = payload.response;
                    break;

                case 'response.failed':
                    failure = payload.response?.error?.message || 'upstream failure';
                    break;

                case 'error':
                    failure = payload.error?.message || payload.message || 'upstream error';
                    break;
            }
        },

        get failure() {
            return failure;
        },

        // Whether a terminal event arrived at all. A stream that just stops is a broken answer,
        // and the caller has to be able to tell that from a short but finished one.
        get completed() {
            return completed;
        },

        // The terminal event normally carries the whole response; the items seen along the way
        // are the fallback for a stream that ends without one.
        get result() {
            if (response) return response.output?.length ? response : { ...response, output: items };
            return items.length ? { output: items } : null;
        },
    };
}

function safeParse(raw) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

// Incremental converter: Responses SSE -> Anthropic events.
function createResponsesStreamTranslator(model, options = {}) {
    let started = false;
    let nextIndex = 0;
    let textIndex = null;
    let messageId = `msg_${Date.now()}`;
    // message_start goes out before the backend has counted anything, and it is the number the CLI
    // draws its context meter and its auto-compact threshold from — left at zero it never compacts.
    // So it opens with our estimate and the terminal event corrects it.
    let usage = { input_tokens: options.inputTokens || 0, output_tokens: 0 };
    let sawToolCall = false;
    let stopReason = 'end_turn';
    let failure = null;
    let completed = false;
    let output = [];
    const toolByItem = new Map();

    const events = [];
    const push = (event, data) => events.push({ event, data });
    const drain = () => events.splice(0, events.length);

    function start(payload) {
        if (started) return;
        started = true;
        if (payload?.response?.id) messageId = payload.response.id;
        push('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: payload?.response?.model || model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage,
            },
        });
    }

    function openText() {
        if (textIndex !== null) return;
        textIndex = nextIndex++;
        push('content_block_start', {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
        });
    }

    function closeText() {
        if (textIndex === null) return;
        push('content_block_stop', { type: 'content_block_stop', index: textIndex });
        textIndex = null;
    }

    return {
        event(name, payload) {
            switch (name) {
                case 'response.created':
                    start(payload);
                    break;

                case 'response.output_text.delta':
                    start(payload);
                    openText();
                    if (payload.delta)
                        push('content_block_delta', {
                            type: 'content_block_delta',
                            index: textIndex,
                            delta: { type: 'text_delta', text: payload.delta },
                        });
                    break;

                case 'response.output_item.added': {
                    start(payload);
                    const item = payload.item || {};
                    if (item.type !== 'function_call') break;
                    closeText();
                    sawToolCall = true;
                    const index = nextIndex++;
                    toolByItem.set(payload.item_id || item.id || item.call_id, { index, stopped: false });
                    push('content_block_start', {
                        type: 'content_block_start',
                        index,
                        content_block: { type: 'tool_use', id: item.call_id, name: item.name || '', input: {} },
                    });
                    break;
                }

                case 'response.function_call_arguments.delta': {
                    const block = toolByItem.get(payload.item_id);
                    if (!block || !payload.delta) break;
                    push('content_block_delta', {
                        type: 'content_block_delta',
                        index: block.index,
                        delta: { type: 'input_json_delta', partial_json: payload.delta },
                    });
                    break;
                }

                case 'response.output_item.done': {
                    if (payload.item) output.push(payload.item);
                    const block = toolByItem.get(payload.item_id);
                    if (block && !block.stopped) {
                        push('content_block_stop', { type: 'content_block_stop', index: block.index });
                        block.stopped = true;
                    }
                    break;
                }

                case 'response.completed':
                case 'response.incomplete': {
                    const response = payload.response || {};
                    completed = true;
                    if (response.output?.length) output = response.output;
                    if (response.usage)
                        usage = {
                            input_tokens: response.usage.input_tokens ?? usage.input_tokens,
                            output_tokens: response.usage.output_tokens ?? 0,
                        };
                    if (response.incomplete_details?.reason === 'max_output_tokens') stopReason = 'max_tokens';
                    break;
                }

                case 'response.failed':
                    failure = payload.response?.error?.message || 'upstream failure';
                    break;

                case 'error':
                    failure = payload.error?.message || payload.message || 'upstream error';
                    break;
            }
            return drain();
        },

        finish() {
            start(null);
            closeText();
            for (const block of toolByItem.values())
                if (!block.stopped) {
                    push('content_block_stop', { type: 'content_block_stop', index: block.index });
                    block.stopped = true;
                }
            push('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: sawToolCall ? 'tool_use' : stopReason, stop_sequence: null },
                usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
            });
            push('message_stop', { type: 'message_stop' });
            return drain();
        },

        get failure() {
            return failure;
        },

        get completed() {
            return completed;
        },

        // The raw Responses items behind the answer — what the reasoning store is fed from
        get output() {
            return output;
        },
    };
}

export {
    anthropicToResponses,
    responsesToAnthropic,
    createResponsesStreamTranslator,
    createResponsesCollector,
    createReasoningStore,
    CODEX_INSTRUCTIONS,
    CODEX_AGENT_REMINDER,
};
