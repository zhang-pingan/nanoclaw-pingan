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

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

function parseProxyErrorBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
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

        if (openAiCompat.enabled && req.url?.split('?')[0] === '/v1/messages' && parsedJsonBody) {
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
              res.writeHead(200, {
                'content-type': compatResult.contentType,
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });
              res.end(compatResult.body);
              return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(compatResult.anthropicResponse));
            return;
          } catch (err) {
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

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: basePath + req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
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
