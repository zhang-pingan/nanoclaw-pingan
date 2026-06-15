import http from 'http';

import { logger } from '../logger.js';
import {
  handleInternalAgentRunOnce,
  RunOnceHandlerOptions,
} from './handler.js';

export interface InternalAgentRunOnceServerOptions extends RunOnceHandlerOptions {
  host: string;
  port: number;
}

export function startInternalAgentRunOnceServer(
  opts: InternalAgentRunOnceServerOptions,
): http.Server | null {
  if (!opts.token) {
    logger.warn('Internal agent run-once server disabled: missing token');
    return null;
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${opts.host}:${opts.port}`);
    if (reqUrl.pathname !== '/internal/agent/run-once') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    handleInternalAgentRunOnce(req, res, opts).catch((err) => {
      logger.error({ err }, 'Unhandled internal run-once request error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    });
  });

  server.listen(opts.port, opts.host, () => {
    logger.info(
      { host: opts.host, port: opts.port },
      'Internal agent run-once server started',
    );
  });
  return server;
}
