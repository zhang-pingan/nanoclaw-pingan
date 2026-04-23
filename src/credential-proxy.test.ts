import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import type { IncomingHttpHeaders, RequestOptions, Server } from 'http';

interface MockCompatResult {
  stream: boolean;
  contentType?: string;
  body?: string;
  anthropicResponse?: unknown;
  model?: string;
}

type UpstreamResult =
  | {
      statusCode: number;
      headers?: IncomingHttpHeaders;
      body?: string;
    }
  | {
      error: Error;
    };

class LocalServerResponse extends Writable {
  statusCode = 200;
  headers: IncomingHttpHeaders = {};
  headersSent = false;
  private chunks: Buffer[] = [];

  writeHead(statusCode: number, headers: IncomingHttpHeaders = {}): this {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    callback();
  }

  override end(
    chunk?: Buffer | string | (() => void),
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    let finalChunk: Buffer | string | undefined;
    let finalCallback = callback;

    if (typeof chunk === 'function') {
      finalCallback = chunk;
    } else {
      finalChunk = chunk;
      if (typeof encoding === 'function') {
        finalCallback = encoding;
      }
    }

    if (finalChunk !== undefined) {
      this.chunks.push(
        typeof finalChunk === 'string'
          ? Buffer.from(finalChunk)
          : finalChunk,
      );
    }

    this.headersSent = true;
    return super.end(finalCallback);
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

let mockEnv: Record<string, string>;
let lastServer:
  | {
      handler: (
        req: PassThrough,
        res: Writable & {
          statusCode: number;
          headers: IncomingHttpHeaders;
          body: string;
        },
      ) => void;
    }
  | undefined;
let lastUpstreamHeaders: IncomingHttpHeaders;
let lastUpstreamBody: string;
let mockCompatResult: MockCompatResult | null;
let mockCompatError: Error | null;
let upstreamResponder: (
  options: RequestOptions,
  body: string,
) => Promise<UpstreamResult>;
let compatCalls: unknown[][];
let compatConfigCalls: number;
let modelResolutionCalls: unknown[][];
let OpenAiCompatRequestErrorCtor:
  | (new (status: number, endpoint: string, responseBody: string) => Error)
  | undefined;
let startCredentialProxy: typeof import('./credential-proxy.js').startCredentialProxy;

function setupModuleMocks(): void {
  vi.doMock('./env.js', () => ({
    readEnvFile: () => ({ ...mockEnv }),
  }));

  vi.doMock('./logger.js', () => ({
    logger: {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn: () => {},
    },
  }));

  vi.doMock('./model-resolution.js', () => ({
    recordModelResolution: (...args: unknown[]) => {
      modelResolutionCalls.push(args);
    },
  }));

  vi.doMock('./agent-api.js', () => {
    class OpenAiCompatRequestError extends Error {
      status: number;
      endpoint: string;
      responseBody: string;

      constructor(status: number, endpoint: string, responseBody: string) {
        super(`Compat request failed with status ${status}`);
        this.status = status;
        this.endpoint = endpoint;
        this.responseBody = responseBody;
      }
    }

    OpenAiCompatRequestErrorCtor = OpenAiCompatRequestError;

    return {
      forwardAnthropicRequestToOpenAi: async (...args: unknown[]) => {
        compatCalls.push(args);
        if (mockCompatError) throw mockCompatError;
        if (!mockCompatResult) {
          throw new Error('No compatibility result configured');
        }
        return mockCompatResult;
      },
      getCredentialProxyOpenAiCompatConfig: () => {
        compatConfigCalls += 1;
        return {
          enabled:
            (mockEnv.CREDENTIAL_PROXY_OPENAI_COMPAT || '')
              .trim()
              .toLowerCase() === 'true',
          apiKey: mockEnv.CREDENTIAL_PROXY_OPENAI_API_KEY || '',
          baseUrl:
            mockEnv.CREDENTIAL_PROXY_OPENAI_BASE_URL || 'http://openai.test',
          model: mockEnv.CREDENTIAL_PROXY_OPENAI_MODEL || 'gpt-5.4',
          timeoutMs: 30000,
          openAiProtocol:
            mockEnv.CREDENTIAL_PROXY_OPENAI_PROTOCOL || 'chat_completions',
        };
      },
      OpenAiCompatRequestError,
    };
  });

  vi.doMock('http', () => {
    class FakeServerResponse extends Writable {
      statusCode = 200;
      headers: IncomingHttpHeaders = {};
      headersSent = false;
      private chunks: Buffer[] = [];

      writeHead(statusCode: number, headers: IncomingHttpHeaders = {}): this {
        this.statusCode = statusCode;
        this.headers = { ...this.headers, ...headers };
        this.headersSent = true;
        return this;
      }

      _write(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.chunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
        );
        callback();
      }

      override end(
        chunk?: Buffer | string | (() => void),
        encoding?: BufferEncoding | (() => void),
        callback?: () => void,
      ): this {
        let finalChunk: Buffer | string | undefined;
        let finalCallback = callback;

        if (typeof chunk === 'function') {
          finalCallback = chunk;
        } else {
          finalChunk = chunk;
          if (typeof encoding === 'function') {
            finalCallback = encoding;
          }
        }

        if (finalChunk !== undefined) {
          this.chunks.push(
            typeof finalChunk === 'string'
              ? Buffer.from(finalChunk)
              : finalChunk,
          );
        }

        this.headersSent = true;
        return super.end(finalCallback);
      }

      get body(): string {
        return Buffer.concat(this.chunks).toString();
      }
    }

    class FakeServer extends EventEmitter {
      listening = false;
      readonly handler: (
        req: PassThrough,
        res: FakeServerResponse,
      ) => void;

      constructor(
        handler: (req: PassThrough, res: FakeServerResponse) => void,
      ) {
        super();
        this.handler = handler;
      }

      listen(_port: number, _host: string, callback?: () => void): this {
        this.listening = true;
        queueMicrotask(() => callback?.());
        return this;
      }

      closeAllConnections(): void {}

      close(callback?: () => void): this {
        this.listening = false;
        queueMicrotask(() => callback?.());
        return this;
      }
    }

    return {
      createServer: (
        handler: (req: PassThrough, res: FakeServerResponse) => void,
      ) => {
        const server = new FakeServer(handler);
        lastServer = server as unknown as typeof lastServer;
        return server as unknown as Server;
      },
      request: (
        options: RequestOptions,
        callback?: (res: PassThrough & {
          statusCode: number;
          headers: IncomingHttpHeaders;
        }) => void,
      ) => {
        const req = new EventEmitter() as EventEmitter & {
          write: (chunk: Buffer | string) => void;
          end: () => void;
        };

        const chunks: Buffer[] = [];

        req.write = (chunk: Buffer | string) => {
          chunks.push(
            typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
          );
        };

        req.end = () => {
          lastUpstreamHeaders = {
            ...((options.headers || {}) as IncomingHttpHeaders),
          };
          lastUpstreamBody = Buffer.concat(chunks).toString();

          void upstreamResponder(options, lastUpstreamBody)
            .then((result) => {
              if ('error' in result) {
                req.emit('error', result.error);
                return;
              }

              const upstreamResponse = new PassThrough() as PassThrough & {
                statusCode: number;
                headers: IncomingHttpHeaders;
              };
              upstreamResponse.statusCode = result.statusCode;
              upstreamResponse.headers = result.headers || {};
              callback?.(upstreamResponse);
              upstreamResponse.end(result.body || '');
            })
            .catch((error) => {
              req.emit(
                'error',
                error instanceof Error ? error : new Error(String(error)),
              );
            });
        };

        return req;
      },
    };
  });
}

async function reloadCredentialProxyModule(): Promise<void> {
  vi.resetModules();
  setupModuleMocks();
  ({ startCredentialProxy } = await import('./credential-proxy.js'));
}

async function startProxy(env: Record<string, string> = {}): Promise<void> {
  Object.assign(mockEnv, env, {
    ANTHROPIC_BASE_URL: 'http://upstream.test',
  });
  await startCredentialProxy(0);
}

async function invokeProxyRequest(input: {
  method: string;
  path: string;
  headers?: IncomingHttpHeaders;
  body?: string;
}): Promise<{
  statusCode: number;
  body: string;
  headers: IncomingHttpHeaders;
}> {
  if (!lastServer) {
    throw new Error('Credential proxy server was not created');
  }

  const req = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
  };
  req.method = input.method;
  req.url = input.path;
  req.headers = input.headers || {};

  const res = new LocalServerResponse();
  const completed = new Promise<{
    statusCode: number;
    body: string;
    headers: IncomingHttpHeaders;
  }>((resolve) => {
    res.on('finish', () => {
      resolve({
        statusCode: res.statusCode,
        body: res.body,
        headers: res.headers,
      });
    });
  });

  lastServer.handler(req, res as never);
  req.end(input.body || '');

  return completed;
}

describe('credential-proxy', () => {
  beforeEach(async () => {
    mockEnv = {};
    lastServer = undefined;
    lastUpstreamHeaders = {};
    lastUpstreamBody = '';
    mockCompatResult = null;
    mockCompatError = null;
    upstreamResponder = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }));
    compatCalls = [];
    compatConfigCalls = 0;
    modelResolutionCalls = [];
    OpenAiCompatRequestErrorCtor = undefined;
    await reloadCredentialProxyModule();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: '{}',
    });
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    await startProxy({ CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token' });
    await invokeProxyRequest({
      method: 'POST',
      path: '/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
      body: '{}',
    });
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    await startProxy({ CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token' });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'temp-key-from-exchange',
      },
      body: '{}',
    });
    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
      },
      body: '{}',
    });
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('model override replaces model in request body', async () => {
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(JSON.parse(lastUpstreamBody).model).toBe('gpt-4o');
  });

  it('model override leaves body unchanged when request model is missing', async () => {
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(JSON.parse(lastUpstreamBody).model).toBeUndefined();
  });

  it('model override does nothing when body is not JSON', async () => {
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: 'not json body',
    });
    expect(lastUpstreamBody).toBe('not json body');
  });

  it('model override does nothing when ANTHROPIC_CLAUDE_MODEL is not set', async () => {
    await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    expect(JSON.parse(lastUpstreamBody).model).toBe('claude-opus-4-6');
  });

  it('returns 502 when upstream is unreachable', async () => {
    upstreamResponder = vi.fn(async () => ({
      error: new Error('connect ECONNREFUSED'),
    }));
    await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('uses OpenAI compat for non-stream anthropic messages when enabled', async () => {
    mockCompatResult = {
      stream: false,
      model: 'gpt-5.4',
      anthropicResponse: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const [requestArg, configArg] = compatCalls[0] || [];
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(requestArg).toEqual(
      expect.objectContaining({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(configArg).toEqual(
      expect.objectContaining({
        apiKey: 'sk-openai-real',
        baseUrl: 'http://openai.test',
        model: 'gpt-5.4',
        openAiProtocol: 'responses',
      }),
    );
    expect(JSON.parse(res.body)).toEqual(mockCompatResult.anthropicResponse);
  });

  it('overrides request model with CREDENTIAL_PROXY_OPENAI_MODEL when compat is enabled', async () => {
    mockCompatResult = {
      stream: false,
      model: 'gpt-5.4',
      anthropicResponse: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const [requestArg] = compatCalls[0] || [];
    expect(requestArg).toEqual(
      expect.objectContaining({
        model: 'gpt-5.4',
      }),
    );
  });

  it('returns upstream compat status and body instead of masking as 502', async () => {
    if (!OpenAiCompatRequestErrorCtor) {
      throw new Error('OpenAiCompatRequestError mock was not initialized');
    }
    mockCompatError = new OpenAiCompatRequestErrorCtor(
      400,
      'http://openai.test/v1/responses',
      JSON.stringify({ detail: 'Model not supported' }),
    );
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Gateway compatibility translation request failed',
      actualRequestApi: 'http://openai.test/v1/responses',
      upstreamStatus: 400,
      upstreamBody: {
        detail: 'Model not supported',
      },
    });
  });

  it('uses OpenAI compat for stream anthropic messages when enabled', async () => {
    mockCompatResult = {
      stream: true,
      model: 'gpt-4.1',
      contentType: 'text/event-stream',
      body: [
        'event: message_start',
        'data: {"type":"message_start"}',
        '',
        'event: content_block_delta',
        'data: {"delta":{"type":"text_delta","text":"Hel"}}',
        '',
        'event: content_block_delta',
        'data: {"delta":{"type":"text_delta","text":"lo"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'chat_completions',
    });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_delta');
    expect(res.body).toContain('"text":"Hel"');
    expect(res.body).toContain('"text":"lo"');
    expect(res.body).toContain('event: message_stop');
  });

  it('preserves tool_use blocks in non-stream compat responses', async () => {
    mockCompatResult = {
      stream: false,
      model: 'gpt-4.1',
      anthropicResponse: {
        id: 'msg_tool_use',
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
      },
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'chat_completions',
    });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'weather' }],
      }),
    });
    expect(JSON.parse(res.body)).toEqual(mockCompatResult.anthropicResponse);
  });

  it('preserves tool_use deltas in stream compat responses', async () => {
    mockCompatResult = {
      stream: true,
      model: 'gpt-4.1',
      contentType: 'text/event-stream',
      body: [
        'event: content_block_start',
        'data: {"content_block":{"type":"tool_use","id":"call_1","name":"weather","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Shang"}}',
        '',
        'event: content_block_delta',
        'data: {"delta":{"type":"input_json_delta","partial_json":"hai\\"}"}}',
        '',
      ].join('\n'),
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'chat_completions',
    });
    const res = await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'weather' }],
      }),
    });
    expect(res.body).toContain('event: content_block_start');
    expect(res.body).toContain('"type":"tool_use"');
    expect(res.body).toContain('"partial_json":"{\\"city\\":\\"Shang"');
    expect(res.body).toContain('"partial_json":"hai\\"}"');
  });

  it('ignores ANTHROPIC_CLAUDE_MODEL in compat mode and uses compat model config instead', async () => {
    mockCompatResult = {
      stream: false,
      model: 'gpt-5.4',
      anthropicResponse: {
        id: 'msg_openai_compat',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    };
    await startProxy({
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_CLAUDE_MODEL: 'claude-opus-4-6',
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_API_KEY: 'sk-openai-real',
      CREDENTIAL_PROXY_OPENAI_BASE_URL: 'http://openai.test',
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4',
      CREDENTIAL_PROXY_OPENAI_PROTOCOL: 'responses',
    });
    await invokeProxyRequest({
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const [requestArg, configArg] = compatCalls[0] || [];
    expect(requestArg).toEqual(
      expect.objectContaining({
        model: 'gpt-5.4',
      }),
    );
    expect(configArg).toEqual(
      expect.objectContaining({
        model: 'gpt-5.4',
      }),
    );
  });
});
