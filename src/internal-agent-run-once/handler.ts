import http from 'http';
import { ZodError } from 'zod';

import { logger } from '../logger.js';
import {
  parseRunOnceRequest,
  RunOnceResponse,
  UnsupportedMessagesShapeError,
} from './schemas.js';
import { InternalAgentRunOnceService, RunOnceInputError } from './service.js';

export interface RunOnceHandlerOptions {
  service: InternalAgentRunOnceService;
  token: string;
  maxBodyBytes: number;
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function bearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || '';
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) {
      throw new RunOnceInputError('Request body too large');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) throw new RunOnceInputError('Request body is required');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RunOnceInputError('Invalid JSON body');
  }
}

export async function handleInternalAgentRunOnce(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RunOnceHandlerOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  if (!opts.token || bearerToken(req) !== opts.token) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  let result: RunOnceResponse;
  try {
    const body = await readJsonBody(req, opts.maxBodyBytes);
    const request = parseRunOnceRequest(body);
    result = await opts.service.runOnce(request);
  } catch (err) {
    if (err instanceof ZodError) {
      sendJson(res, 400, {
        ok: false,
        error: 'Invalid request body',
        details: err.issues,
      });
      return;
    }
    if (err instanceof UnsupportedMessagesShapeError) {
      sendJson(res, err.status, { ok: false, error: err.message });
      return;
    }
    if (err instanceof RunOnceInputError) {
      sendJson(res, err.status, { ok: false, error: err.message });
      return;
    }
    logger.error({ err }, 'Internal run-once handler failed');
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
    return;
  }

  sendJson(res, result.ok ? 200 : 502, result);
}
