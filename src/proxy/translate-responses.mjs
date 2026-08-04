// Translation between Anthropic Messages API and OpenAI Responses API.
// Spoken by the ChatGPT subscription backend (chatgpt.com/backend-api/codex) and api.openai.com/v1/responses.

import { stopReasonFor, stripModelSuffix } from './translate.mjs';

const CODEX_INSTRUCTIONS = 'You are Claude Code, a software engineering agent running in a terminal.';

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

function messagesToInput(messages) {
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
    const { codexBackend = false, reasoningEffort } = options;
    const system = textOf(body.system);

    const request = {
        model: stripModelSuffix(body.model),
        input: messagesToInput(body.messages),
        stream: codexBackend ? true : !!body.stream,
        store: false,
    };

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
    const items = [];

    return {
        event(name, payload) {
            switch (name) {
                case 'response.output_item.done':
                    if (payload.item) items.push(payload.item);
                    break;

                case 'response.completed':
                case 'response.incomplete':
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
function createResponsesStreamTranslator(model) {
    let started = false;
    let nextIndex = 0;
    let textIndex = null;
    let messageId = `msg_${Date.now()}`;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let sawToolCall = false;
    let stopReason = 'end_turn';
    let failure = null;
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
                    if (response.usage)
                        usage = {
                            input_tokens: response.usage.input_tokens ?? 0,
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
                usage: { output_tokens: usage.output_tokens },
            });
            push('message_stop', { type: 'message_stop' });
            return drain();
        },

        get failure() {
            return failure;
        },
    };
}

export {
    anthropicToResponses,
    responsesToAnthropic,
    createResponsesStreamTranslator,
    createResponsesCollector,
    CODEX_INSTRUCTIONS,
};
