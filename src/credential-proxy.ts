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

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
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
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  // Preserve base path from ANTHROPIC_BASE_URL (e.g. '/anthropic' for proxies)
  const basePath = upstreamUrl.pathname.replace(/\/+$/, '');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Extract requested model from POST body (for response rewriting)
        let requestedModel: string | undefined;
        if (req.method === 'POST' && body.length > 0) {
          try {
            const parsed = JSON.parse(body.toString());
            if (parsed.model) requestedModel = parsed.model;
          } catch { /* not JSON, ignore */ }
        }

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
            const contentType = upRes.headers['content-type'] || '';
            const isStreaming = contentType.includes('text/event-stream');

            // Rewrite model field in upstream responses so the SDK sees
            // the model it requested, not the upstream provider's alias.
            if (requestedModel) {
              if (isStreaming) {
                // SSE: replace model field in each chunk
                const upstreamHeaders = { ...upRes.headers };
                delete upstreamHeaders['content-length'];
                delete upstreamHeaders['transfer-encoding'];
                res.writeHead(upRes.statusCode!, {
                  ...upstreamHeaders,
                  'transfer-encoding': 'chunked',
                });
                upRes.on('data', (chunk: Buffer) => {
                  const text = chunk.toString();
                  const rewritten = text.replace(
                    /"model"\s*:\s*"[^"]*"/g,
                    `"model":"${requestedModel}"`,
                  );
                  res.write(rewritten);
                });
                upRes.on('end', () => res.end());
              } else {
                // Non-streaming: buffer, rewrite, send
                const resChunks: Buffer[] = [];
                upRes.on('data', (c: Buffer) => resChunks.push(c));
                upRes.on('end', () => {
                  let resBody = Buffer.concat(resChunks).toString();
                  resBody = resBody.replace(
                    /"model"\s*:\s*"[^"]*"/g,
                    `"model":"${requestedModel}"`,
                  );
                  const upstreamHeaders = { ...upRes.headers };
                  delete upstreamHeaders['content-length'];
                  delete upstreamHeaders['transfer-encoding'];
                  res.writeHead(upRes.statusCode!, {
                    ...upstreamHeaders,
                    'content-length': Buffer.byteLength(resBody),
                  });
                  res.end(resBody);
                });
              }
            } else {
              // No model rewriting needed — pipe through
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            }
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

        upstream.write(body);
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
