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
}

export interface AnthropicMessagesResponse {
  text: string;
  raw: unknown;
  model: string;
}

type FetchLike = typeof fetch;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 30000;

function resolveConfigValue(
  key: string,
  envFile: Record<string, string>,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key];
  }
  return envFile[key];
}

function getAgentApiConfig(): {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
} {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'NANOCLAW_AGENT_API_MODEL',
    'NANOCLAW_AGENT_API_TIMEOUT_MS',
  ]);

  const apiKey = resolveConfigValue('ANTHROPIC_API_KEY', env) || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const rawBaseUrl =
    resolveConfigValue('ANTHROPIC_BASE_URL', env) ||
    'https://api.anthropic.com';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model =
    resolveConfigValue('NANOCLAW_AGENT_API_MODEL', env) ||
    DEFAULT_MODEL;
  const timeoutMs = Math.max(
    1000,
    Number.parseInt(
      resolveConfigValue('NANOCLAW_AGENT_API_TIMEOUT_MS', env) ||
        String(DEFAULT_TIMEOUT_MS),
      10,
    ) || DEFAULT_TIMEOUT_MS,
  );

  return { apiKey, baseUrl, model, timeoutMs };
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

export async function callAnthropicMessages(
  input: AnthropicMessagesRequest,
  fetchImpl: FetchLike = fetch,
): Promise<AnthropicMessagesResponse> {
  const config = getAgentApiConfig();
  const endpoint = `${config.baseUrl}/v1/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
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
      throw new Error(`Anthropic API request failed with status ${response.status}`);
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
      model: typeof raw.model === 'string' ? raw.model : input.model || config.model,
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
