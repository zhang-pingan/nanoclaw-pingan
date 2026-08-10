import type http from 'node:http';

import { assertSafeWorkflowPackId } from './manifest.js';
import { WorkflowPackManager } from './management.js';

const API_PREFIX = '/api/workflow-packs';
const MAX_BODY_BYTES = 64 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function confirmationBody(req: http.IncomingMessage): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  const body = JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}',
  ) as unknown;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    (body as { confirm?: unknown }).confirm !== true
  ) {
    throw new Error('The exact body {"confirm":true} is required');
  }
}

export class WorkflowPackWebApi {
  constructor(private readonly manager: WorkflowPackManager) {}

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === API_PREFIX) {
      if (req.method !== 'GET') {
        send(res, 405, { error: 'Method not allowed' });
        return true;
      }
      send(res, 200, { packs: this.manager.list() });
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/workflow-packs\/([^/]+)\/(enable|disable|uninstall|purge-preview|purge)$/,
    );
    if (!match) return false;
    const action = match[2];
    try {
      const packId = assertSafeWorkflowPackId(decodeURIComponent(match[1]));
      if (action === 'purge-preview') {
        if (req.method !== 'GET') {
          send(res, 405, { error: 'Method not allowed' });
          return true;
        }
        send(res, 200, { preview: this.manager.purgePreview(packId) });
        return true;
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (action === 'enable' || action === 'disable') {
        const result = this.manager.setDesiredEnabled(
          packId,
          action === 'enable',
        );
        send(res, 200, { ok: true, ...result });
        return true;
      }
      await confirmationBody(req);
      const result =
        action === 'uninstall'
          ? this.manager.uninstall(packId)
          : this.manager.purge(packId);
      send(res, 200, { ok: true, result });
      return true;
    } catch (error) {
      send(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}
