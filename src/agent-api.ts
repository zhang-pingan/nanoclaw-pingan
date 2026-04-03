import { readEnvFile } from './env.js';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AgentApiMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  system?: string;
  messages: AgentApiMessage[];
  tools?: AnthropicTool[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface AnthropicMessagesResponse {
  text: string;
  raw: unknown;
  model: string;
}

export interface OpenAiCompatConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  openAiProtocol: 'chat_completions' | 'responses';
}

export interface OpenAiCompatStreamResult {
  stream: true;
  body: string;
  contentType: string;
  model: string;
  raw: unknown;
}

export interface OpenAiCompatAggregatedResult {
  stream: false;
  anthropicResponse: Record<string, unknown>;
  text: string;
  model: string;
  raw: unknown;
}

export type OpenAiCompatResult =
  | OpenAiCompatStreamResult
  | OpenAiCompatAggregatedResult;

type FetchLike = typeof fetch;

export class OpenAiCompatRequestError extends Error {
  status: number;
  endpoint: string;
  responseBody: string;

  constructor(status: number, endpoint: string, responseBody: string) {
    const bodySuffix = responseBody
      ? ` body=${responseBody.slice(0, 2000)}`
      : '';
    super(
      `OpenAI-compatible API request failed with status ${status} endpoint=${endpoint}${bodySuffix}`,
    );
    this.name = 'OpenAiCompatRequestError';
    this.status = status;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

interface AgentApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  useOpenAiCompat: boolean;
  openAiApiKey: string;
  openAiBaseUrl: string;
  openAiModel: string;
  openAiProtocol: 'chat_completions' | 'responses';
}

interface ParsedSseEvent {
  event?: string;
  data: string;
}

interface OpenAiChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: OpenAiChatToolCall[];
  tool_call_id?: string;
}

interface StreamBlockState {
  type: 'text' | 'tool_use';
  text: string;
  id?: string;
  name?: string;
  inputJson: string;
  started: boolean;
  stopped: boolean;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 30000;

function getEnvValue(
  key: string,
  envFile: Record<string, string>,
): string | undefined {
  return envFile[key];
}

function parseOpenAiProtocol(
  value: string | undefined,
): 'chat_completions' | 'responses' {
  return (value || '').trim().toLowerCase() === 'responses'
    ? 'responses'
    : 'chat_completions';
}

function parseTimeoutMs(value: string | undefined): number {
  return Math.max(
    1000,
    Number.parseInt(value || String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS,
  );
}

function getAgentApiConfig(): AgentApiConfig {
  const env = readEnvFile([
    'NANOCLAW_AGENT_API_API_KEY',
    'NANOCLAW_AGENT_API_BASE_URL',
    'NANOCLAW_AGENT_API_MODEL',
    'NANOCLAW_AGENT_API_TIMEOUT_MS',
    'NANOCLAW_AGENT_API_USE_OPENAI_COMPAT',
    'NANOCLAW_AGENT_API_OPENAI_KEY',
    'NANOCLAW_AGENT_API_OPENAI_BASE_URL',
    'NANOCLAW_AGENT_API_OPENAI_MODEL',
    'NANOCLAW_AGENT_API_OPENAI_PROTOCOL',
  ]);

  const apiKey = getEnvValue('NANOCLAW_AGENT_API_API_KEY', env) || '';
  if (!apiKey) throw new Error('NANOCLAW_AGENT_API_API_KEY is required');

  const rawBaseUrl =
    getEnvValue('NANOCLAW_AGENT_API_BASE_URL', env) ||
    'https://api.anthropic.com';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = getEnvValue('NANOCLAW_AGENT_API_MODEL', env) || DEFAULT_MODEL;
  const timeoutMs = parseTimeoutMs(getEnvValue('NANOCLAW_AGENT_API_TIMEOUT_MS', env));
  const useOpenAiCompat =
    (getEnvValue('NANOCLAW_AGENT_API_USE_OPENAI_COMPAT', env) || '')
      .trim()
      .toLowerCase() === 'true';
  const openAiApiKey =
    getEnvValue('NANOCLAW_AGENT_API_OPENAI_KEY', env) || apiKey;
  const openAiBaseUrl = (
    getEnvValue('NANOCLAW_AGENT_API_OPENAI_BASE_URL', env) || rawBaseUrl
  ).replace(/\/+$/, '');
  const openAiModel =
    getEnvValue('NANOCLAW_AGENT_API_OPENAI_MODEL', env) || model;
  const openAiProtocol = parseOpenAiProtocol(
    getEnvValue('NANOCLAW_AGENT_API_OPENAI_PROTOCOL', env),
  );

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    useOpenAiCompat,
    openAiApiKey,
    openAiBaseUrl,
    openAiModel,
    openAiProtocol,
  };
}

export function getCredentialProxyOpenAiCompatConfig(): OpenAiCompatConfig & {
  enabled: boolean;
} {
  const env = readEnvFile([
    'CREDENTIAL_PROXY_OPENAI_COMPAT',
    'CREDENTIAL_PROXY_OPENAI_API_KEY',
    'CREDENTIAL_PROXY_OPENAI_BASE_URL',
    'CREDENTIAL_PROXY_OPENAI_MODEL',
    'CREDENTIAL_PROXY_OPENAI_TIMEOUT_MS',
    'CREDENTIAL_PROXY_OPENAI_PROTOCOL',
  ]);

  return {
    enabled:
      (getEnvValue('CREDENTIAL_PROXY_OPENAI_COMPAT', env) || '')
        .trim()
        .toLowerCase() === 'true',
    apiKey: getEnvValue('CREDENTIAL_PROXY_OPENAI_API_KEY', env) || '',
    baseUrl: (
      getEnvValue('CREDENTIAL_PROXY_OPENAI_BASE_URL', env) ||
      'https://api.openai.com'
    ).replace(/\/+$/, ''),
    model:
      getEnvValue('CREDENTIAL_PROXY_OPENAI_MODEL', env) || 'gpt-5.4',
    timeoutMs: parseTimeoutMs(
      getEnvValue('CREDENTIAL_PROXY_OPENAI_TIMEOUT_MS', env),
    ),
    openAiProtocol: parseOpenAiProtocol(
      getEnvValue('CREDENTIAL_PROXY_OPENAI_PROTOCOL', env),
    ),
  };
}

function extractTextFromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) return '';

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const record = block as Record<string, unknown>;
      if (record.type !== 'text' || typeof record.text !== 'string') return [];
      return [record.text];
    })
    .join('\n')
    .trim();
}

function normalizeAnthropicBlocks(
  content: string | AnthropicContentBlock[],
): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function stringifyToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .flatMap((block) => {
      if (block.type !== 'text') return [];
      return [block.text];
    })
    .join('\n')
    .trim();
}

function getAnthropicMessageText(
  content: string | AnthropicContentBlock[],
): string {
  return normalizeAnthropicBlocks(content)
    .flatMap((block) => {
      if (block.type !== 'text') return [];
      return [block.text];
    })
    .join('\n')
    .trim();
}

function getAnthropicMessageToolUses(
  content: string | AnthropicContentBlock[],
): AnthropicToolUseBlock[] {
  return normalizeAnthropicBlocks(content).flatMap((block) =>
    block.type === 'tool_use' ? [block] : [],
  );
}

function getAnthropicMessageToolResults(
  content: string | AnthropicContentBlock[],
): AnthropicToolResultBlock[] {
  return normalizeAnthropicBlocks(content).flatMap((block) =>
    block.type === 'tool_result' ? [block] : [],
  );
}

function toOpenAiTools(
  tools: AnthropicTool[] | undefined,
  protocol: 'chat_completions' | 'responses',
): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map((tool) =>
    protocol === 'responses'
      ? {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        }
      : {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        },
  );
}

function toOpenAiChatMessages(input: AnthropicMessagesRequest): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];

  if (typeof input.system === 'string' && input.system.trim()) {
    messages.push({ role: 'system', content: input.system });
  }

  for (const message of input.messages) {
    const textContent = getAnthropicMessageText(message.content);
    const toolUses = getAnthropicMessageToolUses(message.content);
    const toolResults = getAnthropicMessageToolResults(message.content);

    if (message.role === 'user') {
      if (textContent) {
        messages.push({ role: 'user', content: textContent });
      }
      for (const toolResult of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: toolResult.tool_use_id,
          content: stringifyToolResultContent(toolResult.content),
        });
      }
      continue;
    }

    const assistantMessage: OpenAiChatMessage = { role: 'assistant' };
    if (textContent) assistantMessage.content = textContent;
    if (toolUses.length > 0) {
      assistantMessage.tool_calls = toolUses.map((toolUse) => ({
        id: toolUse.id,
        type: 'function',
        function: {
          name: toolUse.name,
          arguments: JSON.stringify(toolUse.input ?? {}),
        },
      }));
    }
    if (assistantMessage.content || assistantMessage.tool_calls?.length) {
      messages.push(assistantMessage);
    }
  }

  return messages;
}

function toOpenAiResponsesInput(input: AnthropicMessagesRequest): unknown[] {
  const messages: unknown[] = [];

  if (typeof input.system === 'string' && input.system.trim()) {
    messages.push({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: input.system }],
    });
  }

  for (const message of input.messages) {
    const textContent = getAnthropicMessageText(message.content);
    const toolUses = getAnthropicMessageToolUses(message.content);
    const toolResults = getAnthropicMessageToolResults(message.content);

    if (message.role === 'user') {
      if (textContent) {
        messages.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: textContent }],
        });
      }
      for (const toolResult of toolResults) {
        messages.push({
          type: 'function_call_output',
          call_id: toolResult.tool_use_id,
          output: stringifyToolResultContent(toolResult.content),
        });
      }
      continue;
    }

    if (textContent) {
      messages.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: textContent }],
      });
    }
    for (const toolUse of toolUses) {
      messages.push({
        type: 'function_call',
        call_id: toolUse.id,
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input ?? {}),
      });
    }
  }

  return messages;
}

function parseSseEvents(payload: string): ParsedSseEvent[] {
  const normalized = payload.replace(/\r\n/g, '\n');
  const chunks = normalized.split('\n\n');
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }

    if (dataLines.length === 0) continue;
    events.push({
      event,
      data: dataLines.join('\n'),
    });
  }

  return events;
}

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapStopReason(value: unknown): string {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  if (value === 'length' || value === 'max_output_tokens') return 'max_tokens';
  return 'end_turn';
}

function buildAnthropicMessageResponse(
  content: AnthropicContentBlock[],
  model: string,
  stopReason = 'end_turn',
): Record<string, unknown> {
  return {
    id: 'msg_openai_compat',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
  };
}

function extractTextFromBlocks(content: AnthropicContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function ensureStreamBlock(
  blocks: StreamBlockState[],
  index: number,
  type: 'text' | 'tool_use',
): StreamBlockState {
  if (!blocks[index]) {
    blocks[index] = {
      type,
      text: '',
      inputJson: '',
      started: false,
      stopped: false,
    };
  }
  return blocks[index];
}

function startStreamBlock(
  streamBody: string,
  blocks: StreamBlockState[],
  index: number,
): string {
  const block = blocks[index];
  if (!block || block.started) return streamBody;
  block.started = true;

  if (block.type === 'tool_use') {
    return (
      streamBody +
      formatSseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
    );
  }

  return (
    streamBody +
    formatSseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
  );
}

function stopAllStreamBlocks(streamBody: string, blocks: StreamBlockState[]): string {
  let next = streamBody;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || !block.started || block.stopped) continue;
    block.stopped = true;
    next += formatSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }
  return next;
}

function parseJsonObjectOrDefault(value: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractChatCompletionDeltaText(delta: unknown): string {
  if (typeof delta === 'string') return delta;
  if (!Array.isArray(delta)) return '';

  return delta
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      if (typeof record.text !== 'string') return [];
      return [record.text];
    })
    .join('');
}

function convertChatCompletionsSse(
  ssePayload: string,
  fallbackModel: string,
  shouldStream: boolean,
): OpenAiCompatResult {
  const events = parseSseEvents(ssePayload);
  let model = fallbackModel;
  const rawChunks: unknown[] = [];
  const blocks: StreamBlockState[] = [];
  let streamBody = '';
  let stopReason = 'end_turn';

  if (shouldStream) {
    streamBody += formatSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
      },
    });
  }

  for (const event of events) {
    if (event.data === '[DONE]') continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    rawChunks.push(parsed);
    if (typeof parsed.model === 'string' && parsed.model.trim()) {
      model = parsed.model;
    }

    const choices = parsed.choices;
    if (!Array.isArray(choices)) continue;

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const choiceRecord = choice as Record<string, unknown>;
      if (typeof choiceRecord.finish_reason === 'string' && choiceRecord.finish_reason) {
        stopReason = mapStopReason(choiceRecord.finish_reason);
      }

      const delta = choiceRecord.delta;
      if (!delta || typeof delta !== 'object') continue;

      const deltaRecord = delta as Record<string, unknown>;
      const content = deltaRecord.content;
      const deltaText = extractChatCompletionDeltaText(content);
      if (deltaText) {
        const block = ensureStreamBlock(blocks, 0, 'text');
        block.text += deltaText;
        if (shouldStream) {
          streamBody = startStreamBlock(streamBody, blocks, 0);
          streamBody += formatSseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: deltaText },
          });
        }
      }

      const toolCalls = deltaRecord.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        const toolRecord = toolCall as Record<string, unknown>;
        const rawIndex = toolRecord.index;
        const index =
          typeof rawIndex === 'number' && rawIndex >= 0 ? rawIndex + 1 : blocks.length;
        const block = ensureStreamBlock(blocks, index, 'tool_use');
        const id = typeof toolRecord.id === 'string' ? toolRecord.id : undefined;
        if (id) block.id = id;
        const fn = toolRecord.function;
        if (fn && typeof fn === 'object') {
          const fnRecord = fn as Record<string, unknown>;
          if (typeof fnRecord.name === 'string') block.name = fnRecord.name;
          if (typeof fnRecord.arguments === 'string') {
            block.inputJson += fnRecord.arguments;
            if (shouldStream) {
              streamBody = startStreamBlock(streamBody, blocks, index);
              streamBody += formatSseEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: fnRecord.arguments,
                },
              });
            }
          }
        }
      }
    }
  }

  const content: AnthropicContentBlock[] = blocks.flatMap<AnthropicContentBlock>((block) => {
    if (block.type === 'tool_use') {
      return [
        {
          type: 'tool_use' as const,
          id: block.id || `toolu_openai_${Math.random().toString(36).slice(2, 10)}`,
          name: block.name || 'unknown_tool',
          input: block.inputJson ? parseJsonObjectOrDefault(block.inputJson) : {},
        },
      ];
    }
    if (!block.text) return [];
    return [{ type: 'text' as const, text: block.text }];
  });
  const text = extractTextFromBlocks(content);
  if (content.length === 0) {
    throw new Error('OpenAI-compatible API returned no text content');
  }

  const anthropicResponse = buildAnthropicMessageResponse(content, model, stopReason);

  if (shouldStream) {
    streamBody = stopAllStreamBlocks(streamBody, blocks);
    streamBody += formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    streamBody += formatSseEvent('message_stop', { type: 'message_stop' });

    return {
      stream: true,
      body: streamBody,
      contentType: 'text/event-stream',
      model,
      raw: rawChunks,
    };
  }

  return {
    stream: false,
    anthropicResponse,
    text,
    model,
    raw: anthropicResponse,
  };
}

function convertResponsesSse(
  ssePayload: string,
  fallbackModel: string,
  shouldStream: boolean,
): OpenAiCompatResult {
  const events = parseSseEvents(ssePayload);
  let model = fallbackModel;
  let completedResponse: Record<string, unknown> | null = null;
  const blocks: StreamBlockState[] = [];
  let streamBody = '';
  let stopReason = 'end_turn';

  if (shouldStream) {
    streamBody += formatSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
      },
    });
  }

  for (const event of events) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const responseRecord = parsed.response;
    if (responseRecord && typeof responseRecord === 'object') {
      const responseModel = (responseRecord as Record<string, unknown>).model;
      if (typeof responseModel === 'string' && responseModel.trim()) {
        model = responseModel;
      }
    }

    if (
      event.event === 'response.output_text.delta' ||
      parsed.type === 'response.output_text.delta'
    ) {
      const delta = parsed.delta;
      if (typeof delta === 'string' && delta) {
        const index =
          typeof parsed.output_index === 'number' ? Number(parsed.output_index) : 0;
        const block = ensureStreamBlock(blocks, index, 'text');
        block.text += delta;
        if (shouldStream) {
          streamBody = startStreamBlock(streamBody, blocks, index);
          streamBody += formatSseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: delta },
          });
        }
      }
      continue;
    }

    if (
      event.event === 'response.output_item.added' ||
      parsed.type === 'response.output_item.added'
    ) {
      const item = parsed.item;
      if (!item || typeof item !== 'object') continue;
      const itemRecord = item as Record<string, unknown>;
      const outputIndex =
        typeof parsed.output_index === 'number'
          ? Number(parsed.output_index)
          : blocks.length;
      if (itemRecord.type === 'function_call') {
        const block = ensureStreamBlock(blocks, outputIndex, 'tool_use');
        if (typeof itemRecord.call_id === 'string') block.id = itemRecord.call_id;
        if (typeof itemRecord.name === 'string') block.name = itemRecord.name;
        if (shouldStream) {
          streamBody = startStreamBlock(streamBody, blocks, outputIndex);
        }
      } else if (itemRecord.type === 'message') {
        const block = ensureStreamBlock(blocks, outputIndex, 'text');
        if (shouldStream && !block.started) {
          streamBody = startStreamBlock(streamBody, blocks, outputIndex);
        }
      }
      continue;
    }

    if (
      event.event === 'response.function_call_arguments.delta' ||
      parsed.type === 'response.function_call_arguments.delta'
    ) {
      const delta = parsed.delta;
      const outputIndex =
        typeof parsed.output_index === 'number'
          ? Number(parsed.output_index)
          : blocks.length;
      if (typeof delta === 'string') {
        const block = ensureStreamBlock(blocks, outputIndex, 'tool_use');
        block.inputJson += delta;
        if (shouldStream) {
          streamBody = startStreamBlock(streamBody, blocks, outputIndex);
          streamBody += formatSseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: outputIndex,
            delta: { type: 'input_json_delta', partial_json: delta },
          });
        }
      }
      continue;
    }

    if (
      event.event === 'response.completed' ||
      parsed.type === 'response.completed'
    ) {
      if (responseRecord && typeof responseRecord === 'object') {
        completedResponse = responseRecord as Record<string, unknown>;
        if (typeof completedResponse.status === 'string') {
          stopReason =
            completedResponse.status === 'incomplete' ? 'max_tokens' : stopReason;
        }
      }
    }
  }

  let content: AnthropicContentBlock[] = blocks.flatMap<AnthropicContentBlock>((block) => {
    if (block.type === 'tool_use') {
      return [
        {
          type: 'tool_use' as const,
          id: block.id || `toolu_openai_${Math.random().toString(36).slice(2, 10)}`,
          name: block.name || 'unknown_tool',
          input: block.inputJson ? parseJsonObjectOrDefault(block.inputJson) : {},
        },
      ];
    }
    if (!block.text) return [];
    return [{ type: 'text' as const, text: block.text }];
  });

  if (content.length === 0 && completedResponse) {
    const output = completedResponse.output;
    if (Array.isArray(output)) {
      content = output.flatMap<AnthropicContentBlock>((item) => {
        if (!item || typeof item !== 'object') return [];
        const itemRecord = item as Record<string, unknown>;
        if (itemRecord.type === 'function_call') {
          return [
            {
              type: 'tool_use' as const,
              id:
                typeof itemRecord.call_id === 'string'
                  ? itemRecord.call_id
                  : `toolu_openai_${Math.random().toString(36).slice(2, 10)}`,
              name:
                typeof itemRecord.name === 'string'
                  ? itemRecord.name
                  : 'unknown_tool',
              input: itemRecord.arguments
                ? parseJsonObjectOrDefault(String(itemRecord.arguments))
                : {},
            },
          ];
        }
        const itemContent = itemRecord.content;
        if (!Array.isArray(itemContent)) return [];
        return itemContent.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const partRecord = part as Record<string, unknown>;
          const value = partRecord.text ?? partRecord.output_text;
          return typeof value === 'string' && value.trim()
            ? [{ type: 'text' as const, text: value.trim() }]
            : [];
        });
      });
    }
  }

  const text = extractTextFromBlocks(content);
  if (content.length === 0) {
    throw new Error('OpenAI-compatible API returned no text content');
  }

  const anthropicResponse = buildAnthropicMessageResponse(content, model, stopReason);

  if (shouldStream) {
    streamBody = stopAllStreamBlocks(streamBody, blocks);
    streamBody += formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    streamBody += formatSseEvent('message_stop', { type: 'message_stop' });

    return {
      stream: true,
      body: streamBody,
      contentType: 'text/event-stream',
      model,
      raw: completedResponse || { model, output_text: text },
    };
  }

  return {
    stream: false,
    anthropicResponse,
    text,
    model,
    raw: anthropicResponse,
  };
}

export async function forwardAnthropicRequestToOpenAi(
  anthropicRequest: AnthropicMessagesRequest,
  config: OpenAiCompatConfig,
  fetchImpl: FetchLike = fetch,
): Promise<OpenAiCompatResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const endpoint =
      config.openAiProtocol === 'responses'
        ? `${config.baseUrl}/v1/responses`
        : `${config.baseUrl}/v1/chat/completions`;
    const body =
      config.openAiProtocol === 'responses'
        ? {
            model: anthropicRequest.model || config.model,
            input: toOpenAiResponsesInput(anthropicRequest),
            tools: toOpenAiTools(anthropicRequest.tools, 'responses'),
            max_output_tokens: anthropicRequest.max_tokens ?? 1200,
            temperature: anthropicRequest.temperature ?? 0,
            stream: true,
          }
        : {
            model: anthropicRequest.model || config.model,
            max_tokens: anthropicRequest.max_tokens ?? 1200,
            temperature: anthropicRequest.temperature ?? 0,
            messages: toOpenAiChatMessages(anthropicRequest),
            tools: toOpenAiTools(anthropicRequest.tools, 'chat_completions'),
            stream: true,
          };

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = (await response.text()).trim();
      throw new OpenAiCompatRequestError(
        response.status,
        endpoint,
        errorText,
      );
    }

    const ssePayload = await response.text();
    return config.openAiProtocol === 'responses'
      ? convertResponsesSse(
          ssePayload,
          anthropicRequest.model || config.model,
          anthropicRequest.stream === true,
        )
      : convertChatCompletionsSse(
          ssePayload,
          anthropicRequest.model || config.model,
          anthropicRequest.stream === true,
        );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `OpenAI-compatible API request timed out after ${config.timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callAnthropicMessages(
  input: AnthropicMessagesRequest,
  fetchImpl: FetchLike = fetch,
): Promise<AnthropicMessagesResponse> {
  const config = getAgentApiConfig();
  const normalizedInput: AnthropicMessagesRequest = {
    ...input,
    model: config.model,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    if (config.useOpenAiCompat) {
      const compatResult = await forwardAnthropicRequestToOpenAi(
        {
          ...normalizedInput,
          model: config.openAiModel,
        },
        {
          apiKey: config.openAiApiKey,
          baseUrl: config.openAiBaseUrl,
          model: config.openAiModel,
          timeoutMs: config.timeoutMs,
          openAiProtocol: config.openAiProtocol,
        },
        fetchImpl,
      );

      if (compatResult.stream) {
        throw new Error(
          'callAnthropicMessages does not support streaming responses',
        );
      }

      return {
        text: compatResult.text,
        raw: compatResult.anthropicResponse,
        model: compatResult.model,
      };
    }

    const response = await fetchImpl(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: normalizedInput.model,
        max_tokens: normalizedInput.max_tokens ?? 1200,
        temperature: normalizedInput.temperature ?? 0,
        system: normalizedInput.system,
        messages: normalizedInput.messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API request failed with status ${response.status}`,
      );
    }

    const raw = (await response.json()) as {
      content?: unknown;
      model?: unknown;
    };
    const text = extractTextFromAnthropicContent(raw.content);
    if (!text) throw new Error('Anthropic API returned no text content');

    return {
      text,
      raw,
      model:
        typeof raw.model === 'string' ? raw.model : input.model || config.model,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Anthropic API request timed out after ${config.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
