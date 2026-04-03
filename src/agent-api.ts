import { readEnvFile } from './env.js';

export interface AgentApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicMessagesRequest {
  system?: string;
  messages: AgentApiMessage[];
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

interface AgentApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  useOpenAiCompat: boolean;
  openAiProtocol: 'chat_completions' | 'responses';
}

interface ParsedSseEvent {
  event?: string;
  data: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 30000;

function getEnvValue(
  key: string,
  envFile: Record<string, string>,
): string | undefined {
  return envFile[key];
}

function getAgentApiConfig(): AgentApiConfig {
  const env = readEnvFile([
    'NANOCLAW_AGENT_API_API_KEY',
    'NANOCLAW_AGENT_API_BASE_URL',
    'NANOCLAW_AGENT_API_MODEL',
    'NANOCLAW_AGENT_API_TIMEOUT_MS',
    'NANOCLAW_AGENT_API_USE_OPENAI_COMPAT',
    'NANOCLAW_AGENT_API_OPENAI_PROTOCOL',
  ]);

  const apiKey = getEnvValue('NANOCLAW_AGENT_API_API_KEY', env) || '';
  if (!apiKey) throw new Error('NANOCLAW_AGENT_API_API_KEY is required');

  const rawBaseUrl =
    getEnvValue('NANOCLAW_AGENT_API_BASE_URL', env) ||
    'https://api.anthropic.com';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = getEnvValue('NANOCLAW_AGENT_API_MODEL', env) || DEFAULT_MODEL;
  const timeoutMs = Math.max(
    1000,
    Number.parseInt(
      getEnvValue('NANOCLAW_AGENT_API_TIMEOUT_MS', env) ||
        String(DEFAULT_TIMEOUT_MS),
      10,
    ) || DEFAULT_TIMEOUT_MS,
  );
  const useOpenAiCompat =
    (getEnvValue('NANOCLAW_AGENT_API_USE_OPENAI_COMPAT', env) || '')
      .trim()
      .toLowerCase() === 'true';
  const rawOpenAiProtocol = (
    getEnvValue('NANOCLAW_AGENT_API_OPENAI_PROTOCOL', env) || 'chat_completions'
  )
    .trim()
    .toLowerCase();
  const openAiProtocol =
    rawOpenAiProtocol === 'responses' ? 'responses' : 'chat_completions';

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    useOpenAiCompat,
    openAiProtocol,
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

function toOpenAiChatMessages(
  input: AnthropicMessagesRequest,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [];

  if (typeof input.system === 'string' && input.system.trim()) {
    messages.push({ role: 'system', content: input.system });
  }

  for (const message of input.messages) {
    messages.push({
      role: message.role,
      content: message.content,
    });
  }

  return messages;
}

function toOpenAiResponsesInput(
  input: AnthropicMessagesRequest,
): Array<{
  role: 'system' | 'user' | 'assistant';
  content: Array<{ type: 'input_text'; text: string }>;
}> {
  return toOpenAiChatMessages(input).map((message) => ({
    role: message.role,
    content: [
      {
        type: 'input_text',
        text: message.content,
      },
    ],
  }));
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

function buildAnthropicMessageResponse(
  text: string,
  model: string,
): Record<string, unknown> {
  return {
    id: 'msg_openai_compat',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
  };
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
  let text = '';
  const rawChunks: unknown[] = [];
  let streamBody = '';

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
    streamBody += formatSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
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
      const delta = (choice as Record<string, unknown>).delta;
      if (!delta || typeof delta !== 'object') continue;
      const content = (delta as Record<string, unknown>).content;
      const deltaText = extractChatCompletionDeltaText(content);
      if (!deltaText) continue;
      text += deltaText;

      if (shouldStream) {
        streamBody += formatSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: deltaText },
        });
      }
    }
  }

  if (!text) {
    throw new Error('OpenAI-compatible API returned no text content');
  }

  const anthropicResponse = buildAnthropicMessageResponse(text, model);

  if (shouldStream) {
    streamBody += formatSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    streamBody += formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
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
  let text = '';
  let completedResponse: Record<string, unknown> | null = null;
  let streamBody = '';

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
    streamBody += formatSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
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
        text += delta;
        if (shouldStream) {
          streamBody += formatSseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta },
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
        const outputText = completedResponse.output_text;
        if (!text && typeof outputText === 'string' && outputText.trim()) {
          text = outputText.trim();
        }
      }
    }
  }

  if (!text && completedResponse) {
    const output = completedResponse.output;
    if (Array.isArray(output)) {
      text = output
        .flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const content = (item as Record<string, unknown>).content;
          if (!Array.isArray(content)) return [];
          return content.flatMap((part) => {
            if (!part || typeof part !== 'object') return [];
            const value =
              (part as Record<string, unknown>).text ??
              (part as Record<string, unknown>).output_text;
            return typeof value === 'string' && value.trim() ? [value.trim()] : [];
          });
        })
        .join('\n')
        .trim();
    }
  }

  if (!text) {
    throw new Error('OpenAI-compatible API returned no text content');
  }

  const anthropicResponse = buildAnthropicMessageResponse(text, model);

  if (shouldStream) {
    streamBody += formatSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    streamBody += formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
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
            max_output_tokens: anthropicRequest.max_tokens ?? 1200,
            temperature: anthropicRequest.temperature ?? 0,
            stream: true,
          }
        : {
            model: anthropicRequest.model || config.model,
            max_tokens: anthropicRequest.max_tokens ?? 1200,
            temperature: anthropicRequest.temperature ?? 0,
            messages: toOpenAiChatMessages(anthropicRequest),
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
      throw new Error(
        `OpenAI-compatible API request failed with status ${response.status}`,
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    if (config.useOpenAiCompat) {
      const compatResult = await forwardAnthropicRequestToOpenAi(
        input,
        {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
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
        model: input.model || config.model,
        max_tokens: input.max_tokens ?? 1200,
        temperature: input.temperature ?? 0,
        system: input.system,
        messages: input.messages,
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
