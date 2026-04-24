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
  getCredentialProxyOpenAiCompatConfig,
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
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      text: async () =>
        JSON.stringify({
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
      stream: true,
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
      text: async () => 'bad gateway',
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

  it('aggregates anthropic sse responses for non-stream callers', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-test',
      NANOCLAW_AGENT_API_BASE_URL: 'https://example.test/api/',
      NANOCLAW_AGENT_API_MODEL: 'claude-test',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'false',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'text/event-stream' : null,
      },
      text: async () =>
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":"}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"true}"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
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
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'claude-test',
      stream: true,
    });
    expect(res).toEqual({
      text: '{"ok":true}',
      raw: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { output_tokens: 4 },
      },
      model: 'claude-test',
    });
  });

  it('routes callAnthropicMessages through the compat helper when enabled', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-anthropic',
      NANOCLAW_AGENT_API_BASE_URL: 'https://anthropic.example.test/api/',
      NANOCLAW_AGENT_API_MODEL: 'claude-test',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'true',
      NANOCLAW_AGENT_API_OPENAI_KEY: 'sk-openai',
      NANOCLAW_AGENT_API_OPENAI_BASE_URL: 'https://example.test/api/',
      NANOCLAW_AGENT_API_OPENAI_MODEL: 'gpt-4.1',
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

  it('ignores input.model and uses env-backed models for both non-compat and compat calls', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_AGENT_API_API_KEY: 'sk-anthropic',
      NANOCLAW_AGENT_API_BASE_URL: 'https://anthropic.example.test/api/',
      NANOCLAW_AGENT_API_MODEL: 'claude-env',
      NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'true',
      NANOCLAW_AGENT_API_OPENAI_KEY: 'sk-openai',
      NANOCLAW_AGENT_API_OPENAI_BASE_URL: 'https://openai.example.test/api/',
      NANOCLAW_AGENT_API_OPENAI_MODEL: 'gpt-env',
      NANOCLAW_AGENT_API_OPENAI_PROTOCOL: 'responses',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"model":"gpt-env","status":"in_progress"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"OK"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"model":"gpt-env","output_text":"OK"}}',
          '',
        ].join('\n'),
    });

    await callAnthropicMessages(
      {
        model: 'ignored-input-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openai.example.test/api/v1/responses');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-env',
    });
  });

  it('uses per-call timeout overrides for openai-compatible calls', async () => {
    vi.useFakeTimers();
    try {
      readEnvFileMock.mockReturnValue({
        NANOCLAW_AGENT_API_API_KEY: 'sk-anthropic',
        NANOCLAW_AGENT_API_BASE_URL: 'https://anthropic.example.test/api/',
        NANOCLAW_AGENT_API_MODEL: 'claude-test',
        NANOCLAW_AGENT_API_USE_OPENAI_COMPAT: 'true',
        NANOCLAW_AGENT_API_OPENAI_KEY: 'sk-openai',
        NANOCLAW_AGENT_API_OPENAI_BASE_URL: 'https://example.test/api/',
        NANOCLAW_AGENT_API_OPENAI_MODEL: 'gpt-4.1',
        NANOCLAW_AGENT_API_OPENAI_PROTOCOL: 'chat_completions',
      });
      let capturedSignal: AbortSignal | undefined;
      let outcome: unknown = 'pending';
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      });

      const promise = callAnthropicMessages(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        fetchMock as unknown as typeof fetch,
        45000,
      ).then(
        () => {
          outcome = 'resolved';
        },
        (err) => {
          outcome = err;
        },
      );

      await vi.advanceTimersByTimeAsync(30000);
      expect(capturedSignal?.aborted).toBe(false);
      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(15000);
      await promise;
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toContain('45000ms');
    } finally {
      vi.useRealTimers();
    }
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

  it('reads credential proxy compat config from env', () => {
    readEnvFileMock.mockReturnValue({
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-proxy',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'https://proxy.example.test/',
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4-mini',
      CREDENTIAL_PROXY_OPENAI_TIMEOUT_MS: '45000',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });

    expect(getCredentialProxyOpenAiCompatConfig()).toEqual({
      enabled: true,
      apiKey: 'sk-proxy',
      baseUrl: 'https://proxy.example.test',
      model: 'gpt-5.4-mini',
      timeoutMs: 45000,
      openAiProtocol: 'responses',
    });
  });

  it('maps anthropic tools, tool_use and tool_result into openai requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"done"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
    });

    await forwardAnthropicRequestToOpenAi(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'checking' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'weather',
                input: { city: 'Shanghai' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [{ type: 'text', text: '{"temp":25}' }],
              },
            ],
          },
        ],
        tools: [
          {
            name: 'weather',
            description: 'Get weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
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

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: [
        {
          type: 'function',
          function: {
            name: 'weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: {
                name: 'weather',
                arguments: '{"city":"Shanghai"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_1',
          content: '{"temp":25}',
        },
      ],
    });
  });

  it('maps anthropic tools into responses API tool format', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"model":"gpt-5.4","status":"in_progress"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"done"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"model":"gpt-5.4","output_text":"done"}}',
          '',
        ].join('\n'),
    });

    await forwardAnthropicRequestToOpenAi(
      {
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            name: 'weather',
            description: 'Get weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
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

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    });
  });

  it('converts chat completions tool calls back to anthropic tool_use blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"I will check."}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Shang"}}]}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hai\\"}"}}]},"finish_reason":"tool_calls"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
    });

    const res = await forwardAnthropicRequestToOpenAi(
      {
        messages: [{ role: 'user', content: 'weather?' }],
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

    expect(res.stream).toBe(false);
    if (!res.stream) {
      expect(res.anthropicResponse).toEqual({
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-4.1',
        content: [
          { type: 'text', text: 'I will check.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'weather',
            input: { city: 'Shanghai' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
      });
    }
  });

  it('converts responses function call events into anthropic stream tool blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        [
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","output_index":0,"delta":"Need a tool."}',
          '',
          'event: response.output_item.added',
          'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_2","name":"weather"}}',
          '',
          'event: response.function_call_arguments.delta',
          'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":\\"Shanghai\\"}"}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"model":"gpt-5.4","status":"completed"}}',
          '',
        ].join('\n'),
    });

    const res = await forwardAnthropicRequestToOpenAi(
      {
        messages: [{ role: 'user', content: 'weather?' }],
        stream: true,
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

    expect(res.stream).toBe(true);
    if (res.stream) {
      expect(res.body).toContain('"type":"text_delta","text":"Need a tool."');
      expect(res.body).toContain('"type":"tool_use","id":"call_2","name":"weather"');
      expect(res.body).toContain('"type":"input_json_delta","partial_json":"{\\"city\\":\\"Shanghai\\"}"');
    }
  });
});
