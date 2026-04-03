import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...options,
        hostname: '127.0.0.1',
        port,
        headers: {
          connection: 'close',
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamBody: string;
  let upstreamHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastUpstreamBody = '';
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamHeaders = { ...req.headers };
        lastUpstreamBody = Buffer.concat(chunks).toString();
        upstreamHandler(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    proxyServer?.closeAllConnections?.();
    upstreamServer?.closeAllConnections?.();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('model override replaces model in request body', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hello' }] }),
    );

    const body = JSON.parse(lastUpstreamBody);
    expect(body.model).toBe('gpt-4o');
  });

  it('model override injects model when request body is missing model', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    );

    const body = JSON.parse(lastUpstreamBody);
    expect(body.model).toBe('gpt-4o');
  });

  it('model override does nothing when body is not JSON', async () => {
    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      'not json body',
    );

    expect(lastUpstreamBody).toBe('not json body');
  });

  it('model override does nothing when ANTHROPIC_CLAUDE_MODEL is not set', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' },
      },
      JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    );

    const body = JSON.parse(lastUpstreamBody);
    expect(body.model).toBe('claude-opus-4-6');
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('uses OpenAI compat for non-stream anthropic messages when enabled', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
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
      );
    };

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(lastUpstreamBody)).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
    });
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer sk-openai-real');
    expect(JSON.parse(res.body)).toEqual({
      id: 'msg_openai_compat',
      type: 'message',
      role: 'assistant',
      model: 'gpt-5.4',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
  });

  it('uses OpenAI compat for stream anthropic messages when enabled', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"Hel"}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"lo"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    };

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'chat_completions',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_delta');
    expect(res.body).toContain('"text":"Hel"');
    expect(res.body).toContain('"text":"lo"');
    expect(res.body).toContain('event: message_stop');
  });

  it('preserves tool_use blocks in non-stream compat responses', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"Checking."}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Shang"}}]}}]}',
          '',
          'data: {"model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hai\\"}"}}]},"finish_reason":"tool_calls"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    };

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'chat_completions',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      JSON.stringify({ messages: [{ role: 'user', content: 'weather?' }] }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      id: 'msg_openai_compat',
      type: 'message',
      role: 'assistant',
      model: 'gpt-4.1',
      content: [
        { type: 'text', text: 'Checking.' },
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
  });

  it('preserves tool_use deltas in stream compat responses', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
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
      );
    };

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'weather?' }],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"text_delta","text":"Need a tool."');
    expect(res.body).toContain('"type":"tool_use","id":"call_2","name":"weather"');
    expect(res.body).toContain(
      '"type":"input_json_delta","partial_json":"{\\"city\\":\\"Shanghai\\"}"',
    );
  });

  it('ignores ANTHROPIC_CLAUDE_MODEL in compat mode and uses compat model config instead', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
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
      );
    };

    proxyPort = await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'claude-should-not-apply',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    );

    expect(JSON.parse(lastUpstreamBody)).toMatchObject({
      model: 'gpt-5.4',
    });
    expect(JSON.parse(lastUpstreamBody).model).not.toBe('claude-should-not-apply');
  });
});
