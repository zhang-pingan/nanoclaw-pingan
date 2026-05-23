/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import {
  AnthropicMessagesRequest,
  forwardAnthropicRequestToOpenAi,
  getCredentialProxyOpenAiCompatConfig,
  OpenAiCompatRequestError,
} from './agent-api.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { recordModelResolution } from './model-resolution.js';
import type { AgentQueryRecord } from './types.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface ProxyRequestContext {
  runId?: string;
  queryId?: string;
  path: string;
}

export function resolveCredentialProxyExecutionModel(
  requestedModel: string,
): string {
  const secrets = readEnvFile(['ANTHROPIC_CLAUDE_MODEL']);
  const openAiCompat = getCredentialProxyOpenAiCompatConfig();

  if (openAiCompat.enabled && openAiCompat.model) {
    return openAiCompat.model;
  }

  const overrideModel = (secrets.ANTHROPIC_CLAUDE_MODEL || '').trim();
  if (overrideModel) {
    return overrideModel;
  }

  return requestedModel;
}

function extractProxyRequestContext(rawUrl: string | undefined): ProxyRequestContext {
  const url = rawUrl || '/';
  const match = url.match(
    /^\/__icarus__\/([^/]+)\/([^/]+)(\/.*)?$/,
  );
  if (!match) {
    return { path: url };
  }

  return {
    runId: decodeURIComponent(match[1]),
    queryId: decodeURIComponent(match[2]),
    path: match[3] || '/',
  };
}

function parseProxyErrorBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function estimateAnthropicCost(_model: string | undefined): number | undefined {
  return undefined;
}

function headerValue(
  headers: Record<string, string | string[] | number | undefined>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? '' : String(value);
}

function isEventStreamResponse(
  headers: Record<string, string | string[] | number | undefined>,
): boolean {
  return headerValue(headers, 'content-type')
    .toLowerCase()
    .includes('text/event-stream');
}

function requestModelFromBody(
  parsedJsonBody: Record<string, unknown> | null,
): string | undefined {
  return parsedJsonBody && typeof parsedJsonBody.model === 'string'
    ? parsedJsonBody.model
    : undefined;
}

async function getTraceManager(): Promise<{
  appendStructuredEvent: (input: {
    queryId: string;
    category: string;
    eventName: string;
    status?: string | null;
    severity?: 'debug' | 'info' | 'warn' | 'error';
    summary?: string | null;
    payload?: Record<string, unknown>;
    latencyMs?: number | null;
  }) => unknown;
  updateQuery: (queryId: string, patch: Partial<AgentQueryRecord>) => void;
} | null> {
  try {
    const module = await import('./agent-query-trace.js');
    return module.agentQueryTraceManager;
  } catch {
    return null;
  }
}

function appendModelTraceEvent(
  context: ProxyRequestContext,
  event: {
    name: string;
    status: 'running' | 'success' | 'error';
    summary: string;
    payload: Record<string, unknown>;
    latencyMs?: number;
  },
): void {
  if (!context.queryId) return;
  void getTraceManager().then((manager) => {
    if (!manager || !context.queryId) return;
    try {
      manager.appendStructuredEvent({
        queryId: context.queryId,
        category: 'model',
        eventName: event.name,
        status: event.status,
        severity: event.status === 'error' ? 'error' : 'info',
        summary: event.summary,
        payload: event.payload,
        latencyMs: event.latencyMs,
      });
    } catch {
      // The proxy can serve model calls before/without an active trace.
    }
  }).catch(() => {});
}

function updateQueryFromModelUsage(
  context: ProxyRequestContext,
  payload: Record<string, unknown>,
): void {
  if (!context.queryId) return;
  const patch: Partial<AgentQueryRecord> = {};
  if (typeof payload.actualModel === 'string') patch.actual_model = payload.actualModel;
  const inputTokens = numberValue(payload.inputTokens);
  if (inputTokens !== undefined) patch.input_tokens = inputTokens;
  const outputTokens = numberValue(payload.outputTokens);
  if (outputTokens !== undefined) patch.output_tokens = outputTokens;
  const cacheReadTokens = numberValue(payload.cacheReadTokens);
  if (cacheReadTokens !== undefined) patch.cache_read_tokens = cacheReadTokens;
  const cacheWriteTokens = numberValue(payload.cacheWriteTokens);
  if (cacheWriteTokens !== undefined) patch.cache_write_tokens = cacheWriteTokens;
  const estimatedCost = numberValue(payload.estimatedCost);
  if (estimatedCost !== undefined) patch.estimated_cost = estimatedCost;
  if (Object.keys(patch).length === 0) return;
  void getTraceManager().then((manager) => {
    if (!manager || !context.queryId) return;
    try {
      manager.updateQuery(context.queryId, patch);
    } catch {
      // ignore inactive or uninitialized trace storage
    }
  }).catch(() => {});
}

function normalizeUsagePayload(
  requestedModel: string | undefined,
  actualModel: string | undefined,
  usage: Record<string, unknown> | undefined,
  latencyMs: number,
): Record<string, unknown> {
  const inputTokens = numberValue(usage?.input_tokens);
  const outputTokens = numberValue(usage?.output_tokens);
  const cacheReadTokens = numberValue(usage?.cache_read_input_tokens);
  const cacheWriteTokens = numberValue(usage?.cache_creation_input_tokens);
  return {
    provider: 'anthropic',
    traceSource: 'credential_proxy',
    requestedModel,
    actualModel,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCost: estimateAnthropicCost(actualModel),
    latencyMs,
  };
}

function recordModelTraceResolution(
  context: ProxyRequestContext,
  requestedModel: string | undefined,
  actualModel: string | undefined,
  source: 'proxy_forward' | 'compat_response',
  latencyMs: number,
  usage?: Record<string, unknown>,
): void {
  if (!context.runId || !context.queryId || !actualModel) return;
  recordModelResolution({
    runId: context.runId,
    queryId: context.queryId,
    requestedModel,
    actualModel,
    source,
    updatedAt: Date.now(),
  });
  const payload = normalizeUsagePayload(requestedModel, actualModel, usage, latencyMs);
  appendModelTraceEvent(context, {
    name: 'model_resolution',
    status: 'success',
    summary: `Model resolved: ${actualModel}`,
    payload,
    latencyMs,
  });
  updateQueryFromModelUsage(context, payload);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CLAUDE_MODEL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const modelOverride = secrets.ANTHROPIC_CLAUDE_MODEL;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  // Preserve base path from ANTHROPIC_BASE_URL (e.g. '/anthropic' for proxies)
  const basePath = upstreamUrl.pathname.replace(/\/+$/, '');
  const openAiCompat = getCredentialProxyOpenAiCompatConfig();

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const requestContext = extractProxyRequestContext(req.url);
        const targetPath = requestContext.path.split('?')[0] || '/';
        const requestStartedAt = Date.now();
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Model override: replace model in request body before forwarding
        let forwardedBody = body;
        let parsedJsonBody: Record<string, unknown> | null = null;
        if (modelOverride) {
          try {
            const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
            parsedJsonBody = parsed;
            if (parsed.model) {
              parsed.model = modelOverride;
              forwardedBody = Buffer.from(JSON.stringify(parsed));
              headers['content-length'] = forwardedBody.length;
            }
          } catch {
            // Not JSON or parseable — forward body as-is
          }
        } else {
          try {
            parsedJsonBody = JSON.parse(body.toString()) as Record<string, unknown>;
          } catch {
            parsedJsonBody = null;
          }
        }

        if (openAiCompat.enabled && targetPath === '/v1/messages' && parsedJsonBody) {
          appendModelTraceEvent(requestContext, {
            name: 'model_request_started',
            status: 'running',
            summary: `Model request started: ${String(parsedJsonBody.model || openAiCompat.model)}`,
            payload: {
              provider: 'openai-compatible',
              traceSource: 'credential_proxy',
              requestedModel:
                typeof parsedJsonBody.model === 'string'
                  ? parsedJsonBody.model
                  : undefined,
              requestPath: targetPath,
            },
          });
          try {
            if (!openAiCompat.apiKey) {
              throw new Error('CREDENTIAL_PROXY_OPENAI_API_KEY is required');
            }

            const compatResult = await forwardAnthropicRequestToOpenAi(
              {
                ...((parsedJsonBody as unknown) as AnthropicMessagesRequest),
                model: openAiCompat.model,
              },
              {
                apiKey: openAiCompat.apiKey,
                baseUrl: openAiCompat.baseUrl,
                model: openAiCompat.model,
                timeoutMs: openAiCompat.timeoutMs,
                openAiProtocol: openAiCompat.openAiProtocol,
              },
            );

            if (compatResult.stream) {
              const latencyMs = Date.now() - requestStartedAt;
              const actualModel = compatResult.model || openAiCompat.model;
              recordModelTraceResolution(
                requestContext,
                typeof parsedJsonBody.model === 'string'
                  ? parsedJsonBody.model
                  : undefined,
                actualModel,
                'compat_response',
                latencyMs,
              );
              appendModelTraceEvent(requestContext, {
                name: 'model_response_completed',
                status: 'success',
                summary: `Model stream completed: ${compatResult.model || openAiCompat.model}`,
                payload: {
                  provider: 'openai-compatible',
                  traceSource: 'credential_proxy',
                  requestedModel:
                    typeof parsedJsonBody.model === 'string'
                      ? parsedJsonBody.model
                      : undefined,
                  actualModel,
                  latencyMs,
                },
                latencyMs,
              });
              res.writeHead(200, {
                'content-type': compatResult.contentType,
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });
              res.end(compatResult.body);
              return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            const latencyMs = Date.now() - requestStartedAt;
            const usage =
              compatResult.anthropicResponse &&
              typeof compatResult.anthropicResponse === 'object' &&
              'usage' in compatResult.anthropicResponse &&
              typeof compatResult.anthropicResponse.usage === 'object'
                ? (compatResult.anthropicResponse.usage as Record<string, unknown>)
                : undefined;
            const actualModel = compatResult.model || openAiCompat.model;
            recordModelTraceResolution(
              requestContext,
              typeof parsedJsonBody.model === 'string'
                ? parsedJsonBody.model
                : undefined,
              actualModel,
              'compat_response',
              latencyMs,
              usage,
            );
            appendModelTraceEvent(requestContext, {
              name: 'model_response_completed',
              status: 'success',
              summary: `Model response completed: ${compatResult.model || openAiCompat.model}`,
              payload: normalizeUsagePayload(
                typeof parsedJsonBody.model === 'string'
                  ? parsedJsonBody.model
                  : undefined,
                actualModel,
                usage,
                latencyMs,
              ),
              latencyMs,
            });
            res.end(JSON.stringify(compatResult.anthropicResponse));
            return;
          } catch (err) {
            appendModelTraceEvent(requestContext, {
              name: 'model_request_failed',
              status: 'error',
              summary:
                err instanceof Error ? err.message : 'Model request failed',
              payload: {
                provider: 'openai-compatible',
                traceSource: 'credential_proxy',
                requestedModel:
                  typeof parsedJsonBody.model === 'string'
                    ? parsedJsonBody.model
                    : undefined,
                latencyMs: Date.now() - requestStartedAt,
                error: err instanceof Error ? err.message : String(err),
              },
              latencyMs: Date.now() - requestStartedAt,
            });
            const compatError =
              err instanceof OpenAiCompatRequestError
                ? {
                    upstreamStatus: err.status,
                    actualRequestApi: err.endpoint,
                    upstreamBody: parseProxyErrorBody(err.responseBody),
                  }
                : undefined;
            logger.error(
              { err, url: req.url, ...compatError },
              'Credential proxy OpenAI compatibility error',
            );
            if (!res.headersSent) {
              if (err instanceof OpenAiCompatRequestError) {
                res.writeHead(err.status, { 'content-type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Gateway compatibility translation request failed',
                    actualRequestApi: err.endpoint,
                    upstreamStatus: err.status,
                    upstreamBody: parseProxyErrorBody(err.responseBody),
                  }),
                );
              } else {
                res.writeHead(502);
                res.end('Bad Gateway');
              }
            }
            return;
          }
        }

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        if (
          requestContext.runId &&
          requestContext.queryId &&
          parsedJsonBody &&
          targetPath === '/v1/messages'
        ) {
          const requestedModel =
            typeof parsedJsonBody.model === 'string' && parsedJsonBody.model.trim()
              ? parsedJsonBody.model
              : undefined;
          if (requestedModel) {
            appendModelTraceEvent(requestContext, {
              name: 'model_request_started',
              status: 'running',
              summary: `Model request started: ${requestedModel}`,
              payload: {
                provider: 'anthropic',
                traceSource: 'credential_proxy',
                requestedModel,
                requestPath: targetPath,
              },
            });
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: basePath + requestContext.path,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const statusCode = upRes.statusCode || 502;
            const requestedModel = requestModelFromBody(parsedJsonBody);
            if (
              targetPath === '/v1/messages' &&
              isEventStreamResponse(upRes.headers)
            ) {
              res.writeHead(statusCode, upRes.headers);
              upRes.on('end', () => {
                const latencyMs = Date.now() - requestStartedAt;
                if (statusCode >= 400) {
                  appendModelTraceEvent(requestContext, {
                    name: 'model_request_failed',
                    status: 'error',
                    summary: `Model stream failed: HTTP ${statusCode}`,
                    payload: {
                      provider: 'anthropic',
                      traceSource: 'credential_proxy',
                      requestedModel,
                      actualModel: requestedModel,
                      upstreamStatus: statusCode,
                      latencyMs,
                    },
                    latencyMs,
                  });
                  return;
                }
                recordModelTraceResolution(
                  requestContext,
                  requestedModel,
                  requestedModel,
                  'proxy_forward',
                  latencyMs,
                );
                appendModelTraceEvent(requestContext, {
                  name: 'model_response_completed',
                  status: 'success',
                  summary: `Model stream completed: ${requestedModel || 'unknown'}`,
                  payload: {
                    provider: 'anthropic',
                    traceSource: 'credential_proxy',
                    requestedModel,
                    actualModel: requestedModel,
                    latencyMs,
                  },
                  latencyMs,
                });
              });
              upRes.pipe(res);
              return;
            }

            const chunks: Buffer[] = [];
            upRes.on('data', (chunk) => {
              chunks.push(Buffer.from(chunk));
            });
            upRes.on('end', () => {
              const responseBody = Buffer.concat(chunks);
              const latencyMs = Date.now() - requestStartedAt;
              let responseJson: Record<string, unknown> | null = null;
              try {
                responseJson = JSON.parse(responseBody.toString('utf-8')) as Record<string, unknown>;
              } catch {
                responseJson = null;
              }
              const usage =
                responseJson?.usage && typeof responseJson.usage === 'object'
                  ? (responseJson.usage as Record<string, unknown>)
                  : undefined;
              const actualModel =
                responseJson && typeof responseJson.model === 'string'
                  ? responseJson.model
                  : requestedModel;

              if (targetPath === '/v1/messages') {
                if (upRes.statusCode && upRes.statusCode >= 400) {
                  appendModelTraceEvent(requestContext, {
                    name: 'model_request_failed',
                    status: 'error',
                    summary: `Model request failed: HTTP ${upRes.statusCode}`,
                    payload: {
                      provider: 'anthropic',
                      traceSource: 'credential_proxy',
                      requestedModel,
                      actualModel,
                      upstreamStatus: upRes.statusCode,
                      latencyMs,
                    },
                    latencyMs,
                  });
                } else {
                  const usagePayload = normalizeUsagePayload(
                    requestedModel,
                    actualModel,
                    usage,
                    latencyMs,
                  );
                  recordModelTraceResolution(
                    requestContext,
                    requestedModel,
                    actualModel,
                    'proxy_forward',
                    latencyMs,
                    usage,
                  );
                  appendModelTraceEvent(requestContext, {
                    name: 'model_response_completed',
                    status: 'success',
                    summary: `Model response completed: ${actualModel || requestedModel || 'unknown'}`,
                    payload: usagePayload,
                    latencyMs,
                  });
                  updateQueryFromModelUsage(requestContext, usagePayload);
                }
              }

              res.writeHead(upRes.statusCode!, upRes.headers);
              res.end(responseBody);
            });
          },
        );

        upstream.on('error', (err) => {
          appendModelTraceEvent(requestContext, {
            name: 'model_request_failed',
            status: 'error',
            summary: err.message,
            payload: {
              provider: 'anthropic',
              traceSource: 'credential_proxy',
              requestPath: targetPath,
              latencyMs: Date.now() - requestStartedAt,
              error: err.message,
            },
            latencyMs: Date.now() - requestStartedAt,
          });
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(forwardedBody);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
