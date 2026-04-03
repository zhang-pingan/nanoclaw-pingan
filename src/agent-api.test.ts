import { afterEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

import {
  callAnthropicMessages,
  forwardAnthropicRequestToOpenAi,
} from './agent-api.js';

describe('agent-api', () => {
  afterEach(() => {
    readEnvFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it('calls anthropic messages endpoint using env config', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-test',
      NANOCLAW_AGENT_API_BASE_URL: 'https://example.test/api/',
      NANOCLAW_AGENT_API_MODEL: 'claude-test',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'false',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'claude-test',
        content: [{ type: 'text', text: '{"ok":true}' }],
      }),
    });

    const res = await callAnthropicMessages(
      {
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hello' }],
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/api/v1/messages');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'claude-test',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res).toEqual({
      text: '{"ok":true}',
      raw: {
        model: 'claude-test',
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
      model: 'claude-test',
    });
  });

  it('throws when api key is missing', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_BASE_URL: 'https://example.test',
    });

    await expect(
      callAnthropicMessages(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        vi.fn() as unknown as typeof fetch,
      ),
    ).rejects.toThrow('NANOCLAW_AGENT_API_API_KEY is required');
  });

  it('throws on non-ok anthropic responses', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-test',
      NANOCLAW_AGENT_API_BASE_URL: 'https://example.test',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'false',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    });

    await expect(
      callAnthropicMessages(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Anthropic API request failed with status 502');
  });

  it('routes callAnthropicMessages through the compat helper when enabled', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-openai',
      NANOCLAW_AGENT_API_BASE_URL: 'https://example.test/api/',
      NANOCLAW_AGENT_API_MODEL: 'gpt-4.1',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'true',
      NANOCLAW_AGENT_API_OPENAI_PROTOCOL: 'chat_completions',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"{\\"ok\\":"}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"true}"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
    });

    const res = await callAnthropicMessages(
      {
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hello' }],
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.test/api/v1/chat/completions',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-4.1',
      stream: true,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(res).toEqual({
      text: '{"ok":true}',
      raw: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-4.1',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      model: 'gpt-4.1',
    });
  });

  it('aggregates responses protocol into anthropic format for non-stream requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"model":"gpt-5.4","status":"in_progress"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"OK"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"model":"gpt-5.4","output_text":"OK"}}',
          '',
        ].join('\n'),
    });

    const res = await forwardAnthropicRequestToOpenAi(
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
      {
        apiKey: 'sk-openai',
        baseUrl: 'https://example.test/api',
        model: 'gpt-5.4',
        timeoutMs: 30000,
        openAiProtocol: 'responses',
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/api/v1/responses');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
    });
    expect(res).toEqual({
      stream: false,
      anthropicResponse: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      text: 'OK',
      model: 'gpt-5.4',
      raw: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    });
  });

  it('returns anthropic-style sse when the request is stream=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"Hel"}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"lo"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
    });

    const res = await forwardAnthropicRequestToOpenAi(
      {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
      {
        apiKey: 'sk-openai',
        baseUrl: 'https://example.test/api',
        model: 'gpt-4.1',
        timeoutMs: 30000,
        openAiProtocol: 'chat_completions',
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(res.stream).toBe(true);
    if (res.stream) {
      expect(res.contentType).toBe('text/event-stream');
      expect(res.model).toBe('gpt-4.1');
      expect(res.body).toContain('event: message_start');
      expect(res.body).toContain('event: content_block_delta');
      expect(res.body).toContain('"text":"Hel"');
      expect(res.body).toContain('"text":"lo"');
      expect(res.body).toContain('event: message_stop');
    }
  });
});
