// Pure translation helpers: Anthropic Messages API <-> OpenAI Chat Completions.
// No network, no process state — so they can be tested independently of the server.

const REASONING_MODEL = /^(o\d|gpt-5)/i;

function stripModelSuffix(model) {
    return String(model || '').replace(/\[[^\]]*\]$/, '');
}

function textOf(blocks) {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    return blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
}

function imageUrlOf(block) {
    const src = block.source || {};
    if (src.type === 'base64') return `data:${src.media_type || 'image/png'};base64,${src.data}`;
    if (src.type === 'url') return src.url;
    return null;
}

function userContentToOpenAI(blocks) {
    if (typeof blocks === 'string') return blocks;
    const parts = [];
    for (const block of blocks || []) {
        if (!block) continue;
        if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
        else if (block.type === 'image') {
            const url = imageUrlOf(block);
            if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
    }
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts.length ? parts : '';
}

function toolResultContent(block) {
    const content = block.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const text = textOf(content);
        if (text) return text;
        const hasImage = content.some((c) => c && c.type === 'image');
        return hasImage ? '[image omitted]' : '';
    }
    return '';
}

function messagesToOpenAI(anthropicMessages) {
    const out = [];
    for (const message of anthropicMessages || []) {
        const role = message.role;
        const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];

        if (role === 'user') {
            const results = blocks.filter((b) => b && b.type === 'tool_result');
            for (const r of results)
                out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: toolResultContent(r) });

            const rest = blocks.filter((b) => b && b.type !== 'tool_result');
            if (rest.length) {
                const content = userContentToOpenAI(rest);
                if (content && (typeof content !== 'string' || content.trim())) out.push({ role: 'user', content });
            }
            continue;
        }

        const text = textOf(blocks);
        const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
        const assistant = { role: 'assistant' };
        if (text) assistant.content = text;
        if (toolUses.length)
            assistant.tool_calls = toolUses.map((t) => ({
                id: t.id,
                type: 'function',
                function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
            }));
        if (assistant.content || assistant.tool_calls) out.push(assistant);
    }
    return out;
}

function toolsToOpenAI(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    return tools
        .filter((t) => t && t.name && !t.type)
        .map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} },
            },
        }));
}

function toolChoiceToOpenAI(choice) {
    if (!choice) return undefined;
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'any') return 'required';
    if (choice.type === 'none') return 'none';
    if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
    return undefined;
}

function anthropicToOpenAI(body) {
    const model = stripModelSuffix(body.model);
    const messages = [];

    const system = textOf(body.system);
    if (system) messages.push({ role: 'system', content: system });
    messages.push(...messagesToOpenAI(body.messages));

    const request = { model, messages };
    const isReasoning = REASONING_MODEL.test(model);

    if (body.max_tokens) {
        if (isReasoning) request.max_completion_tokens = body.max_tokens;
        else request.max_tokens = body.max_tokens;
    }
    if (!isReasoning) {
        if (typeof body.temperature === 'number') request.temperature = body.temperature;
        if (typeof body.top_p === 'number') request.top_p = body.top_p;
    }
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) request.stop = body.stop_sequences;

    const tools = toolsToOpenAI(body.tools);
    if (tools) {
        request.tools = tools;
        const choice = toolChoiceToOpenAI(body.tool_choice);
        if (choice) request.tool_choice = choice;
    }
    if (body.stream) {
        request.stream = true;
        request.stream_options = { include_usage: true };
    }
    return request;
}

function stopReasonFor(finishReason) {
    switch (finishReason) {
        case 'tool_calls':
        case 'function_call':
            return 'tool_use';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'refusal';
        case 'stop':
        default:
            return 'end_turn';
    }
}

function parseArgs(raw) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

// `prompt_tokens` already includes whatever the prefix cache served; Anthropic reports the cached
// part beside the input rather than inside it, and every reader downstream sums the two. Split it
// out so a cache hit shows as one, instead of being billed a second time at the uncached rate.
function usageToAnthropic(usage = {}, previous = {}) {
    const total = Number(usage.prompt_tokens ?? previous.input_tokens) || 0;
    const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
    return {
        input_tokens: Math.max(0, total - cached),
        output_tokens: Number(usage.completion_tokens ?? previous.output_tokens) || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    };
}

function openAIToAnthropic(completion, fallbackModel) {
    const choice = (completion.choices || [])[0] || {};
    const message = choice.message || {};
    const content = [];

    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.tool_calls || [])
        content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input: parseArgs(call.function?.arguments),
        });

    const usage = completion.usage || {};
    return {
        id: completion.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: completion.model || fallbackModel,
        content,
        stop_reason: stopReasonFor(choice.finish_reason),
        stop_sequence: null,
        usage: usageToAnthropic(usage),
    };
}

// Incremental SSE converter: OpenAI chunks -> Anthropic events.
// Every call returns an array of {event, data} ready to be flushed.
function createStreamTranslator(model) {
    let started = false;
    let nextIndex = 0;
    let textIndex = null;
    const toolBlocks = new Map(); // openai tool_call index -> {anthropicIndex, sentStart}
    let finishReason = null;
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let messageId = `msg_${Date.now()}`;

    const events = [];
    const push = (event, data) => events.push({ event, data });
    const drain = () => events.splice(0, events.length);

    function start(chunk) {
        if (started) return;
        started = true;
        if (chunk?.id) messageId = chunk.id;
        push('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: chunk?.model || model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage,
            },
        });
    }

    function closeOpenBlocks() {
        if (textIndex !== null) {
            push('content_block_stop', { type: 'content_block_stop', index: textIndex });
            textIndex = null;
        }
        for (const [, block] of toolBlocks) {
            if (!block.stopped) {
                push('content_block_stop', { type: 'content_block_stop', index: block.anthropicIndex });
                block.stopped = true;
            }
        }
    }

    return {
        chunk(raw) {
            start(raw);
            if (raw.usage) usage = usageToAnthropic(raw.usage, usage);

            const choice = (raw.choices || [])[0];
            if (choice) {
                const delta = choice.delta || {};

                if (delta.content) {
                    if (textIndex === null) {
                        textIndex = nextIndex++;
                        push('content_block_start', {
                            type: 'content_block_start',
                            index: textIndex,
                            content_block: { type: 'text', text: '' },
                        });
                    }
                    push('content_block_delta', {
                        type: 'content_block_delta',
                        index: textIndex,
                        delta: { type: 'text_delta', text: delta.content },
                    });
                }

                for (const call of delta.tool_calls || []) {
                    const key = call.index ?? 0;
                    let block = toolBlocks.get(key);
                    if (!block) {
                        if (textIndex !== null) {
                            push('content_block_stop', { type: 'content_block_stop', index: textIndex });
                            textIndex = null;
                        }
                        block = { anthropicIndex: nextIndex++, stopped: false };
                        toolBlocks.set(key, block);
                        push('content_block_start', {
                            type: 'content_block_start',
                            index: block.anthropicIndex,
                            content_block: {
                                type: 'tool_use',
                                id: call.id || `call_${key}`,
                                name: call.function?.name || '',
                                input: {},
                            },
                        });
                    }
                    const args = call.function?.arguments;
                    if (args)
                        push('content_block_delta', {
                            type: 'content_block_delta',
                            index: block.anthropicIndex,
                            delta: { type: 'input_json_delta', partial_json: args },
                        });
                }

                if (choice.finish_reason) finishReason = choice.finish_reason;
            }
            return drain();
        },

        finish() {
            start(null);
            closeOpenBlocks();
            push('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReasonFor(finishReason), stop_sequence: null },
                usage: { ...usage },
            });
            push('message_stop', { type: 'message_stop' });
            return drain();
        },
    };
}

function estimateTokens(body) {
    const system = textOf(body.system);
    let chars = system.length;
    for (const message of body.messages || []) {
        const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
        chars += textOf(blocks).length;
        for (const b of blocks) {
            if (b?.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length + (b.name?.length || 0);
            else if (b?.type === 'tool_result') chars += toolResultContent(b).length;
        }
    }
    for (const tool of body.tools || [])
        chars += (tool.name?.length || 0) + (tool.description?.length || 0) + JSON.stringify(tool.input_schema || {}).length;
    return Math.max(1, Math.ceil(chars / 4));
}

export {
    anthropicToOpenAI,
    openAIToAnthropic,
    createStreamTranslator,
    estimateTokens,
    stopReasonFor,
    stripModelSuffix,
    messagesToOpenAI,
    toolsToOpenAI,
};
