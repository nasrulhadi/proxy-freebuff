'use strict';

const { clientSessionId } = require('./upstream');

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function sval(value) {
  return typeof value === 'string' ? value : '';
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const t = sval(v).trim();
    if (t) return t;
  }
  return '';
}

function injectMetadata(payload, { model, runId, sessionInstanceID }) {
  const cloned = clone(payload);
  cloned.model = model;
  if (Array.isArray(cloned.tools)) normalizeToolSchemas(cloned.tools);
  let metadata = cloned.codebuff_metadata;
  if (!metadata || typeof metadata !== 'object') metadata = {};
  metadata.run_id = runId;
  metadata.client_id = clientSessionId();
  if (sessionInstanceID) metadata.freebuff_instance_id = sessionInstanceID;
  cloned.codebuff_metadata = metadata;
  return JSON.stringify(cloned);
}

function normalizeToolSchemas(tools) {
  for (const tool of tools) {
    const fn = tool && tool.function;
    if (!fn || typeof fn.parameters !== 'object' || fn.parameters === null) continue;
    fn.parameters = normalizeSchemaMap(fn.parameters, extractDefinitions(fn.parameters), 12);
  }
}

function extractDefinitions(schema) {
  const merged = {};
  const defs = schema.definitions;
  if (defs && typeof defs === 'object') Object.assign(merged, defs);
  const defs2 = schema.$defs;
  if (defs2 && typeof defs2 === 'object') Object.assign(merged, defs2);
  return Object.keys(merged).length ? merged : null;
}

function mergeDefinitions(parent, local) {
  if (!parent) return local;
  if (!local) return parent;
  return { ...parent, ...local };
}

function normalizeSchemaMap(node, defs, maxDepth) {
  if (maxDepth <= 0) return clone(node);
  defs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, defs);
  if (replaced !== null) {
    if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
      return normalizeSchemaMap(replaced, defs, maxDepth - 1);
    }
    return clone(node);
  }
  let normalized = {};
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1);
  }
  delete normalized.definitions;
  delete normalized.$defs;
  delete normalized.nullable;
  normalized = simplifyNullableCombinator(normalized, 'anyOf');
  normalized = simplifyNullableCombinator(normalized, 'oneOf');
  normalizeTypeField(normalized);
  normalizeEnumField(normalized);
  normalizeConstField(normalized);
  return normalized;
}

function normalizeSchemaValue(value, defs, maxDepth) {
  if (Array.isArray(value)) return value.map((v) => normalizeSchemaValue(v, defs, maxDepth));
  if (value && typeof value === 'object') return normalizeSchemaMap(value, defs, maxDepth);
  return value;
}

function tryResolveRef(node, defs) {
  const ref = sval(node.$ref);
  if (!ref || Object.keys(node).length !== 1 || !defs) return null;
  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (!name) return null;
  if (!Object.prototype.hasOwnProperty.call(defs, name)) return null;
  return clone(defs[name]);
}

function isNullSchema(schema) {
  if (sval(schema.type) === 'null') return true;
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === null) return true;
  return false;
}

function simplifyNullableCombinator(schema, key) {
  if (!Array.isArray(schema[key])) return schema;
  const filtered = schema[key].filter((o) => !(o && typeof o === 'object' && !Array.isArray(o) && isNullSchema(o)));
  if (!filtered.length) {
    delete schema[key];
    return schema;
  }
  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    const merged = {};
    for (const [k, v] of Object.entries(schema)) if (k !== key) merged[k] = v;
    Object.assign(merged, filtered[0]);
    return merged;
  }
  schema[key] = filtered;
  return schema;
}

function normalizeTypeField(schema) {
  const rawType = schema.type;
  if (!Array.isArray(rawType)) return;
  const nonNull = rawType.filter((t) => typeof t === 'string' && t.trim() !== '' && t !== 'null');
  if (!nonNull.length) delete schema.type;
  else schema.type = nonNull[0];
}

function normalizeEnumField(schema) {
  if (!Array.isArray(schema.enum)) return;
  const seen = new Set();
  const filtered = [];
  for (const entry of schema.enum) {
    if (entry === null) continue;
    const key = `${typeof entry}:${JSON.stringify(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }
  if (!filtered.length) delete schema.enum;
  else schema.enum = filtered;
}

function normalizeConstField(schema) {
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && schema.const === null) delete schema.const;
}

function convertClaudeToOpenAI(root) {
  const modelName = sval(root.model).trim();
  if (!modelName) throw new Error('model is required');
  const stream = root.stream === true;
  const out = { model: modelName, messages: [], stream };

  const maxTokens = numInt(root.max_tokens);
  if (maxTokens > 0) out.max_tokens = maxTokens;

  const temperature = numFloat(root.temperature);
  if (temperature !== null) out.temperature = temperature;
  else {
    const topP = numFloat(root.top_p);
    if (topP !== null) out.top_p = topP;
  }

  const stops = (Array.isArray(root.stop_sequences) ? root.stop_sequences : []).map(sval).filter((s) => s.trim());
  if (stops.length === 1) out.stop = stops[0];
  else if (stops.length > 1) out.stop = stops;

  const effort = claudeThinkingToReasoningEffort(root);
  if (effort) out.reasoning_effort = effort;

  const messages = [];
  if (root.system != null) {
    const systemMessage = claudeSystemToOpenAIMessage(root.system);
    if (systemMessage) messages.push(systemMessage);
  }

  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages)) throw new Error('messages must be an array');

  for (const rawMessage of rawMessages) {
    const message = rawMessage;
    if (!message || typeof message !== 'object') continue;
    const role = sval(message.role).trim();
    if (!role) continue;

    const parts = claudeMessageContent(role, message.content);
    for (const toolResult of parts.beforeMessages) messages.push(toolResult);

    if (role === 'assistant') {
      if (!parts.contentParts.length && !parts.toolCalls.length && !parts.reasoning) continue;
      const openAIMessage = { role: 'assistant' };
      openAIMessage.content = parts.contentParts.length ? normalizeOpenAIContent(parts.contentParts) : '';
      if (parts.reasoning) openAIMessage.reasoning_content = parts.reasoning;
      if (parts.toolCalls.length) openAIMessage.tool_calls = parts.toolCalls;
      messages.push(openAIMessage);
    } else if (role === 'user') {
      if (!parts.contentParts.length) continue;
      messages.push({ role: 'user', content: normalizeOpenAIContent(parts.contentParts) });
    }

    for (const toolResult of parts.afterMessages) messages.push(toolResult);
  }
  out.messages = messages;

  const builtinToolKinds = {};
  if (Array.isArray(root.tools) && root.tools.length) {
    const tools = [];
    for (const rawTool of root.tools) {
      const tool = rawTool;
      if (!tool || typeof tool !== 'object') continue;
      const mapped = claudeToolDefinitionToOpenAI(tool);
      if (!mapped) continue;
      const kind = mapped.builtinKind;
      if (kind) {
        const name = sval(tool.name).trim();
        if (name) builtinToolKinds[name] = kind;
      }
      tools.push(mapped.tool);
    }
    if (tools.length) out.tools = tools;
  }

  if (root.tool_choice && typeof root.tool_choice === 'object') {
    const mappedChoice = claudeToolChoiceToOpenAI(root.tool_choice, builtinToolKinds);
    if (mappedChoice) out.tool_choice = mappedChoice;
  }

  const userValue = sval(root.user).trim();
  if (userValue) out.user = userValue;

  return { payload: out, model: modelName, stream };
}

function claudeToolDefinitionToOpenAI(tool) {
  const toolType = sval(tool.type).toLowerCase().trim();
  const builtin = claudeBuiltinToolType(toolType);
  if (builtin) {
    const mapped = clone(tool);
    mapped.type = builtin;
    delete mapped.name;
    return { tool: mapped, builtinKind: builtin };
  }
  const fn = {
    name: sval(tool.name),
    description: sval(tool.description),
  };
  if (tool.input_schema != null) fn.parameters = tool.input_schema;
  return { tool: { type: 'function', function: fn }, builtinKind: '' };
}

function claudeBuiltinToolType(toolType) {
  if (toolType === 'web_search_20250305' || toolType === 'web_search') return 'web_search';
  return '';
}

function claudeToolChoiceToOpenAI(toolChoice, builtinToolKinds) {
  const type = sval(toolChoice.type).toLowerCase().trim();
  if (type === 'none') return 'none';
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'tool') {
    const name = sval(toolChoice.name).trim();
    if (!name) return null;
    const builtinType = builtinToolKinds[name];
    if (builtinType) return { type: builtinType };
    return { type: 'function', function: { name } };
  }
  return null;
}

function claudeSystemToOpenAIMessage(system) {
  if (typeof system === 'string') {
    const text = system.trim();
    if (!text) return null;
    return { role: 'system', content: text };
  }
  if (Array.isArray(system)) {
    const parts = [];
    for (const rawPart of system) {
      const part = rawPart;
      if (!part || typeof part !== 'object') continue;
      if (sval(part.type).toLowerCase() === 'text') {
        const text = sval(part.text).trim();
        if (!text) continue;
        parts.push({ type: 'text', text });
      }
    }
    if (!parts.length) return null;
    return { role: 'system', content: normalizeOpenAIContent(parts) };
  }
  return null;
}

function claudeMessageContent(role, content) {
  const result = { contentParts: [], beforeMessages: [], afterMessages: [], toolCalls: [], reasoning: '' };

  if (typeof content === 'string') {
    if (content.trim()) result.contentParts.push({ type: 'text', text: content });
    return result;
  }
  if (!Array.isArray(content)) return result;

  const reasoningParts = [];
  for (const rawPart of content) {
    const part = rawPart;
    if (!part || typeof part !== 'object') continue;
    const partType = sval(part.type).toLowerCase().trim();

    if (partType === 'text') {
      const text = sval(part.text).trim();
      if (!text) continue;
      result.contentParts.push({ type: 'text', text });
    } else if (partType === 'image') {
      const imagePart = claudeImagePartToOpenAI(part);
      if (imagePart) result.contentParts.push(imagePart);
    } else if (partType === 'tool_use' || partType === 'server_tool_use') {
      if (role !== 'assistant') continue;
      const toolCallID = sanitizeClaudeToolID(sval(part.id));
      result.toolCalls.push({
        id: toolCallID,
        type: 'function',
        function: { name: sval(part.name), arguments: marshalJSONObject(part.input) },
      });
    } else if (partType === 'tool_result') {
      const toolMessage = buildOpenAIToolResultMessage(part.tool_use_id, part.content);
      if (toolMessage) result.beforeMessages.push(toolMessage);
    } else if (partType === 'thinking') {
      if (role !== 'assistant') continue;
      const thinkingText = firstNonEmpty(part.thinking, part.text).trim();
      if (thinkingText) reasoningParts.push(thinkingText);
    } else if (partType.endsWith('_tool_use')) {
      if (role !== 'assistant') continue;
      const toolCallID = sanitizeClaudeToolID(firstNonEmpty(part.tool_use_id, part.id));
      result.toolCalls.push({
        id: toolCallID,
        type: 'function',
        function: { name: firstNonEmpty(part.name, part.tool_name), arguments: marshalJSONObject(part.input) },
      });
    } else if (partType.endsWith('_tool_result')) {
      const toolContent = Object.prototype.hasOwnProperty.call(part, 'content') ? part.content : clone(part);
      const toolMessage = buildOpenAIToolResultMessage(firstNonEmpty(part.tool_use_id, part.id), toolContent);
      if (toolMessage) {
        if (role === 'assistant') result.afterMessages.push(toolMessage);
        else result.beforeMessages.push(toolMessage);
      }
    } else {
      result.contentParts.push({ type: 'text', text: JSON.stringify(part) });
    }
  }

  if (reasoningParts.length) result.reasoning = reasoningParts.join('\n\n');
  return result;
}

function buildOpenAIToolResultMessage(toolUseID, content) {
  const rawID = sval(toolUseID).trim();
  if (!rawID) return null;
  return {
    role: 'tool',
    tool_call_id: sanitizeClaudeToolID(rawID),
    content: claudeToolResultContentToOpenAI(content),
  };
}

function claudeImagePartToOpenAI(part) {
  let imageURL = '';
  if (part.source && typeof part.source === 'object') {
    const source = part.source;
    const sourceType = sval(source.type).toLowerCase();
    if (sourceType === 'base64') {
      const data = sval(source.data);
      if (data) {
        const mediaType = sval(source.media_type) || 'application/octet-stream';
        imageURL = `data:${mediaType};base64,${data}`;
      }
    } else if (sourceType === 'url') {
      imageURL = sval(source.url);
    }
  }
  if (!imageURL) imageURL = sval(part.url);
  if (!imageURL.trim()) return null;
  return { type: 'image_url', image_url: { url: imageURL } };
}

function claudeToolResultContentToOpenAI(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    const contentParts = [];
    let hasStructured = false;
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        contentParts.push({ type: 'text', text: item });
      } else if (item && typeof item === 'object') {
        const itemType = sval(item.type).toLowerCase();
        if (itemType === 'text') {
          const text = sval(item.text);
          parts.push(text);
          contentParts.push({ type: 'text', text });
        } else if (itemType === 'image') {
          const imagePart = claudeImagePartToOpenAI(item);
          if (imagePart) {
            contentParts.push(imagePart);
            hasStructured = true;
          }
        } else {
          hasStructured = true;
          parts.push(JSON.stringify(item));
        }
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    if (contentParts.length) return normalizeOpenAIContent(contentParts);
    return parts.join('\n\n');
  }
  if (typeof content === 'object') {
    const type = sval(content.type).toLowerCase();
    if (type === 'text') return sval(content.text);
    if (type === 'image') {
      const imagePart = claudeImagePartToOpenAI(content);
      if (imagePart) return [imagePart];
    }
    return JSON.stringify(content);
  }
  return JSON.stringify(content);
}

function normalizeOpenAIContent(contentParts) {
  if (!contentParts.length) return '';
  if (contentParts.length === 1) {
    const part = contentParts[0];
    if (part && typeof part === 'object' && sval(part.type).toLowerCase() === 'text') return sval(part.text);
  }
  return contentParts;
}

function claudeThinkingToReasoningEffort(root) {
  const thinking = root.thinking;
  if (!thinking || typeof thinking !== 'object') return null;
  const type = sval(thinking.type).toLowerCase();
  if (type === 'disabled') return 'none';
  if (type === 'enabled') {
    const budget = numInt(thinking.budget_tokens);
    return budget !== null ? budgetToReasoningEffort(budget) : 'auto';
  }
  if (type === 'adaptive' || type === 'auto') {
    const outputConfig = root.output_config && typeof root.output_config === 'object' ? root.output_config : {};
    const effort = sval(outputConfig.effort).toLowerCase();
    if (effort === '' || effort === 'auto') return 'auto';
    if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
    if (effort === 'max') return 'xhigh';
    return 'auto';
  }
  return null;
}

function budgetToReasoningEffort(budget) {
  if (budget <= 0) return 'none';
  if (budget <= 512) return 'minimal';
  if (budget <= 1024) return 'low';
  if (budget <= 8192) return 'medium';
  if (budget <= 24576) return 'high';
  return 'xhigh';
}

function marshalJSONObject(value) {
  if (value === null || value === undefined) return '{}';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify(trimmed);
    }
  }
  try {
    const encoded = JSON.stringify(value);
    return encoded || '{}';
  } catch {
    return '{}';
  }
}

function sanitizeClaudeToolID(id) {
  id = sval(id).trim();
  if (!id) return 'toolu_' + clientSessionId();
  let out = '';
  for (const ch of id) {
    if (/[a-zA-Z0-9_-]/.test(ch)) out += ch;
  }
  return out || 'toolu_' + clientSessionId();
}

function parseJSONObject(raw) {
  const trimmed = sval(raw).trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  return {};
}

function convertOpenAIResponseToClaude(body) {
  const response = JSON.parse(body);
  const message = {
    id: sval(response.id),
    type: 'message',
    role: 'assistant',
    model: sval(response.model),
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  let hasToolCall = false;
  const choice = response.choices && response.choices[0];
  if (choice) {
    for (const text of collectReasoningTexts(choice.message && choice.message.reasoning_content)) {
      message.content.push({ type: 'thinking', thinking: text });
    }
    for (const block of openAIContentToClaudeBlocks(choice.message && choice.message.content)) {
      message.content.push(block);
    }
    for (const toolCall of (choice.message && choice.message.tool_calls) || []) {
      hasToolCall = true;
      message.content.push({
        type: 'tool_use',
        id: sanitizeClaudeToolID(toolCall.id),
        name: toolCall.function && toolCall.function.name,
        input: parseJSONObject(toolCall.function && toolCall.function.arguments),
      });
    }
    if (choice.finish_reason) message.stop_reason = mapOpenAIFinishReasonToClaude(choice.finish_reason);
  }

  if (response.usage) {
    const { inputTokens, outputTokens, cachedTokens } = extractOpenAIUsage(response.usage);
    message.usage.input_tokens = inputTokens;
    message.usage.output_tokens = outputTokens;
    if (cachedTokens > 0) message.usage.cache_read_input_tokens = cachedTokens;
  }

  if (message.stop_reason === 'end_turn' && hasToolCall) message.stop_reason = 'tool_use';
  return JSON.stringify(message);
}

function openAIContentToClaudeBlocks(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? [{ type: 'text', text }] : [];
  }
  if (!Array.isArray(raw)) return [];
  const blocks = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const itemType = sval(item.type).toLowerCase();
    if (itemType === 'text') {
      const text = sval(item.text).trim();
      if (text) blocks.push({ type: 'text', text });
    } else if (itemType === 'reasoning') {
      const text = firstNonEmpty(item.text, item.thinking).trim();
      if (text) blocks.push({ type: 'thinking', thinking: text });
    } else if (itemType === 'tool_calls') {
      for (const rawToolCall of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
        const toolCall = rawToolCall;
        if (!toolCall || typeof toolCall !== 'object') continue;
        const fn = toolCall.function || {};
        blocks.push({
          type: 'tool_use',
          id: sanitizeClaudeToolID(toolCall.id),
          name: sval(fn.name),
          input: parseJSONObject(fn.arguments),
        });
      }
    }
  }
  return blocks;
}

function collectReasoningTexts(raw) {
  const texts = [];
  collectReasoningTextValues(raw, texts);
  return texts;
}

function collectReasoningTextValues(value, out) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReasoningTextValues(item, out);
  } else if (value && typeof value === 'object') {
    const text = firstNonEmpty(value.text, value.thinking).trim();
    if (text) out.push(text);
  }
}

function createClaudeStreamConverter(model) {
  const state = {
    messageId: '',
    model,
    messageStarted: false,
    textStarted: false,
    textBlockIdx: -1,
    thinkingStarted: false,
    thinkingBlockIdx: -1,
    nextBlockIdx: 0,
    toolBlocks: new Map(),
    toolBlockIndexes: new Map(),
    finishReason: '',
    sawToolCall: false,
    messageDeltaSent: false,
    messageStopSent: false,
    contentBlocksStopped: false,
  };

  function toolCallBlockIndex(toolIndex) {
    if (state.toolBlockIndexes.has(toolIndex)) return state.toolBlockIndexes.get(toolIndex);
    const index = state.nextBlockIdx++;
    state.toolBlockIndexes.set(toolIndex, index);
    return index;
  }

  function stopThinking(events) {
    if (!state.thinkingStarted) return;
    events.push({ name: 'content_block_stop', payload: { index: state.thinkingBlockIdx } });
    state.thinkingStarted = false;
    state.thinkingBlockIdx = -1;
  }

  function stopText(events) {
    if (!state.textStarted) return;
    events.push({ name: 'content_block_stop', payload: { index: state.textBlockIdx } });
    state.textStarted = false;
    state.textBlockIdx = -1;
  }

  function appendFinalContentEvents() {
    if (state.contentBlocksStopped) return [];
    const events = [];
    stopThinking(events);
    stopText(events);

    const indexes = [...state.toolBlocks.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const toolCall = state.toolBlocks.get(index);
      if (!toolCall.started) continue;
      const blockIndex = toolCallBlockIndex(index);
      const partialJSON = toolCall.args.trim();
      if (partialJSON) {
        events.push({
          name: 'content_block_delta',
          payload: { index: blockIndex, delta: { type: 'input_json_delta', partial_json: partialJSON } },
        });
      }
      events.push({ name: 'content_block_stop', payload: { index: blockIndex } });
    }
    state.contentBlocksStopped = true;
    return events;
  }

  function appendMessageDeltaAndStop(usage) {
    const events = [];
    if (!state.messageDeltaSent) {
      const usagePayload = { input_tokens: 0, output_tokens: 0 };
      if (usage) {
        const { inputTokens, outputTokens, cachedTokens } = extractOpenAIUsage(usage);
        usagePayload.input_tokens = inputTokens;
        usagePayload.output_tokens = outputTokens;
        if (cachedTokens > 0) usagePayload.cache_read_input_tokens = cachedTokens;
      }
      events.push({
        name: 'message_delta',
        payload: {
          delta: { stop_reason: mapOpenAIFinishReasonToClaude(effectiveFinishReason()), stop_sequence: null },
          usage: usagePayload,
        },
      });
      state.messageDeltaSent = true;
    }
    if (!state.messageStopSent) {
      events.push({ name: 'message_stop', payload: { type: 'message_stop' } });
      state.messageStopSent = true;
    }
    return events;
  }

  function effectiveFinishReason() {
    if (state.sawToolCall) return 'tool_calls';
    return state.finishReason.trim() || 'stop';
  }

  function processPayload(payload) {
    if (payload.trim() === '[DONE]') return finish();
    const chunk = JSON.parse(payload);
    const events = [];
    if (!state.messageId) state.messageId = sval(chunk.id) || 'msg_' + clientSessionId();
    if (sval(chunk.model).trim()) state.model = chunk.model;

    if (!state.messageStarted) {
      events.push({
        name: 'message_start',
        payload: {
          type: 'message_start',
          message: {
            id: state.messageId,
            type: 'message',
            role: 'assistant',
            model: state.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      });
      state.messageStarted = true;
    }

    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return events;

    const delta = choice.delta || {};
    for (const text of collectReasoningTexts(delta.reasoning_content)) {
      stopText(events);
      if (!state.thinkingStarted) {
        state.thinkingBlockIdx = state.nextBlockIdx++;
        state.thinkingStarted = true;
        events.push({
          name: 'content_block_start',
          payload: { type: 'content_block_start', index: state.thinkingBlockIdx, content_block: { type: 'thinking', thinking: '' } },
        });
      }
      events.push({
        name: 'content_block_delta',
        payload: { type: 'content_block_delta', index: state.thinkingBlockIdx, delta: { type: 'thinking_delta', thinking: text } },
      });
    }

    if (delta.content) {
      stopThinking(events);
      if (!state.textStarted) {
        state.textBlockIdx = state.nextBlockIdx++;
        state.textStarted = true;
        events.push({
          name: 'content_block_start',
          payload: { type: 'content_block_start', index: state.textBlockIdx, content_block: { type: 'text', text: '' } },
        });
      }
      events.push({
        name: 'content_block_delta',
        payload: { type: 'content_block_delta', index: state.textBlockIdx, delta: { type: 'text_delta', text: delta.content } },
      });
    }

    for (const toolCall of delta.tool_calls || []) {
      state.sawToolCall = true;
      stopThinking(events);
      stopText(events);

      let acc = state.toolBlocks.get(toolCall.index);
      if (!acc) {
        acc = { id: '', name: '', started: false, args: '' };
        state.toolBlocks.set(toolCall.index, acc);
      }
      if (sval(toolCall.id).trim()) acc.id = toolCall.id;
      if (toolCall.function && sval(toolCall.function.name).trim()) acc.name = toolCall.function.name;
      if (toolCall.function && toolCall.function.arguments) acc.args += toolCall.function.arguments;

      if (!acc.started && acc.name) {
        const blockIndex = toolCallBlockIndex(toolCall.index);
        events.push({
          name: 'content_block_start',
          payload: {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: sanitizeClaudeToolID(acc.id), name: acc.name, input: {} },
          },
        });
        acc.started = true;
      }
    }

    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
      events.push(...appendFinalContentEvents());
    }
    if (state.finishReason && chunk.usage) {
      events.push(...appendMessageDeltaAndStop(chunk.usage));
    }
    return events;
  }

  function finish() {
    const events = [...appendFinalContentEvents(), ...appendMessageDeltaAndStop(null)];
    return events;
  }

  return { processPayload, finish };
}

function extractOpenAIUsage(usage) {
  const inputTokens = numInt(usage.prompt_tokens) || 0;
  const outputTokens = numInt(usage.completion_tokens) || 0;
  let cachedTokens = 0;
  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') {
    cachedTokens = numInt(usage.prompt_tokens_details.cached_tokens) || 0;
  }
  if (cachedTokens > 0) {
    return { inputTokens: Math.max(0, inputTokens - cachedTokens), outputTokens, cachedTokens };
  }
  return { inputTokens, outputTokens, cachedTokens };
}

function mapOpenAIFinishReasonToClaude(reason) {
  const r = sval(reason).toLowerCase().trim();
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return 'end_turn';
}

function countOpenAIPayloadTokens(payload) {
  const segments = [];
  collectCountSegments(payload.messages, segments);
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      addCountSegment(segments, JSON.stringify(tool));
    }
  }
  addCountSegment(segments, JSON.stringify(payload.tool_choice));
  addCountSegment(segments, JSON.stringify(payload.response_format));
  const joined = segments.join('\n').trim();
  return joined ? Math.max(1, Math.ceil(joined.length / 4)) : 0;
}

function collectCountSegments(messages, segments) {
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    addCountSegment(segments, sval(message.role));
    addCountSegment(segments, sval(message.content));
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object') {
          addCountSegment(segments, sval(part.text));
          addCountSegment(segments, sval(part.name));
          if (part.image_url && typeof part.image_url === 'object') addCountSegment(segments, sval(part.image_url.url));
        } else if (part != null) {
          addCountSegment(segments, JSON.stringify(part));
        }
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        addCountSegment(segments, JSON.stringify(tc));
      }
    }
  }
}

function addCountSegment(segments, value) {
  const trimmed = sval(value).trim();
  if (trimmed) segments.push(trimmed);
}

function extractUpstreamError(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { message: body.trim(), type: 'upstream_error', code: '' };
  }
  let message = '';
  let errorType = 'upstream_error';
  let code = '';
  if (payload.error != null) {
    if (typeof payload.error === 'string') code = payload.error;
    else if (typeof payload.error === 'object') {
      message = sval(payload.error.message);
      errorType = sval(payload.error.type) || errorType;
      code = sval(payload.error.code);
    }
  }
  if (sval(payload.message)) message = sval(payload.message);
  if (!message) message = body.trim();
  return { message, type: errorType, code };
}

function openAIErrorBody(status, message, errorType, code) {
  const error = { message: message || 'error', type: errorType || 'api_error' };
  if (code) error.code = code;
  return JSON.stringify({ error });
}

function claudeErrorBody(status, message, errorType) {
  return JSON.stringify({
    type: 'error',
    error: { type: normalizeClaudeErrorType(status, errorType), message: message || 'error' },
  });
}

function normalizeClaudeErrorType(status, upstreamType) {
  const t = sval(upstreamType).trim();
  if (
    t === 'invalid_request_error' || t === 'authentication_error' || t === 'permission_error' ||
    t === 'not_found_error' || t === 'rate_limit_error' || t === 'api_error' || t === 'overloaded_error'
  ) {
    return t;
  }
  if (status === 400 || status === 405 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503 || status === 502 || status === 504) return 'overloaded_error';
  return 'api_error';
}

function numInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function numFloat(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

module.exports = {
  injectMetadata,
  convertClaudeToOpenAI,
  convertOpenAIResponseToClaude,
  createClaudeStreamConverter,
  countOpenAIPayloadTokens,
  extractUpstreamError,
  openAIErrorBody,
  claudeErrorBody,
  normalizeClaudeErrorType,
  sanitizeClaudeToolID,
};
