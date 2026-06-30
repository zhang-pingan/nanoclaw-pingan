import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ZodError } from 'zod';

import { logger } from '../logger.js';
import {
  ensureUniqueUploadPath,
  getMultipartTextField,
  parseMultipartBoundary,
  parseMultipartFileParts,
  parseMultipartParts,
  sanitizeUploadFilename,
} from '../multipart.js';
import {
  parseRunOnceRequest,
  RunOnceFile,
  RunOnceRequest,
  RunOnceResponse,
  UnsupportedMessagesShapeError,
} from './schemas.js';
import { contentTypeForFile, resolveRunOnceDownloadFile } from './files.js';
import { InternalAgentRunOnceService, RunOnceInputError } from './service.js';
import { runOnceWorkspaceHostPath } from './trace-writer.js';
import {
  AgentChatResponse,
  parseAgentChatRequest,
} from './chat-schemas.js';
import { InternalAgentChatService } from './chat-service.js';

export interface RunOnceHandlerOptions {
  service: InternalAgentRunOnceService;
  token: string;
  maxBodyBytes: number;
}

export interface AgentChatHandlerOptions {
  chatService: InternalAgentChatService;
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

function sendFile(res: http.ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeForFile(filePath) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(filePath).replace(/"/g, '_')}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

function bearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || '';
}

async function readRequestBody(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

function parseJsonBuffer(body: Buffer): unknown {
  const raw = body.toString('utf-8');
  if (!raw.trim()) throw new RunOnceInputError('Request body is required');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RunOnceInputError('Invalid JSON body');
  }
}

function createUploadId(): string {
  return crypto.randomUUID();
}

function sha256Buffer(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function parseMultipartRequestBody(
  body: Buffer,
  contentType: string,
): {
  requestBody: unknown;
  fileParts: ReturnType<typeof parseMultipartFileParts>;
} {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    throw new RunOnceInputError('Missing multipart boundary');
  }

  const parts = parseMultipartParts(body, boundary);
  const requestText = getMultipartTextField(parts, 'request');
  if (!requestText) {
    throw new RunOnceInputError('Multipart field "request" is required');
  }

  let requestBody: unknown;
  try {
    requestBody = JSON.parse(requestText);
  } catch {
    throw new RunOnceInputError('Multipart field "request" must be JSON');
  }

  return {
    requestBody,
    fileParts: parseMultipartFileParts(body, boundary),
  };
}

function saveMultipartFiles(input: {
  groupFolder: string;
  uploadId: string;
  fileParts: ReturnType<typeof parseMultipartFileParts>;
}): RunOnceFile[] {
  if (input.fileParts.length === 0) return [];

  const relativeDir = path.join('inputs', input.uploadId);
  const uploadDir = path.join(
    runOnceWorkspaceHostPath(input.groupFolder),
    relativeDir,
  );
  fs.mkdirSync(uploadDir, { recursive: true });

  return input.fileParts.map((part) => {
    const filename = sanitizeUploadFilename(part.filename);
    const hostPath = ensureUniqueUploadPath(uploadDir, filename);
    fs.writeFileSync(hostPath, part.data);
    const storedName = path.basename(hostPath);
    const relativePath = path.posix.join('inputs', input.uploadId, storedName);
    return {
      name: storedName,
      agent_path: `/workspace/run-once/${relativePath}`,
      relative_path: relativePath,
      size: part.data.length,
      sha256: sha256Buffer(part.data),
      content_type: part.contentType,
    };
  });
}

function withUploadedFiles(
  request: RunOnceRequest,
  uploadedFiles: RunOnceFile[],
  uploadId: string,
): RunOnceRequest {
  if (uploadedFiles.length === 0) return request;
  return {
    ...request,
    files: [...request.files, ...uploadedFiles],
    metadata: {
      ...request.metadata,
      uploaded_file_count: uploadedFiles.length,
      upload_id: uploadId,
    },
  };
}

async function readRunOnceRequest(
  req: http.IncomingMessage,
  opts: RunOnceHandlerOptions,
): Promise<RunOnceRequest> {
  const contentType = String(req.headers['content-type'] || '');
  const body = await readRequestBody(req, opts.maxBodyBytes);

  if (contentType.includes('multipart/form-data')) {
    const uploadId = createUploadId();
    const { requestBody, fileParts } = parseMultipartRequestBody(
      body,
      contentType,
    );
    const request = parseRunOnceRequest(requestBody);
    const groupFolder = opts.service.resolveGroupFolder(request.chat_jid);
    const uploadedFiles = saveMultipartFiles({
      groupFolder,
      uploadId,
      fileParts,
    });
    return withUploadedFiles(request, uploadedFiles, uploadId);
  }

  const requestBody = parseJsonBuffer(body);
  return parseRunOnceRequest(requestBody);
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
    const request = await readRunOnceRequest(req, opts);
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

export async function handleInternalAgentChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AgentChatHandlerOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  if (!opts.token || bearerToken(req) !== opts.token) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  let result: AgentChatResponse;
  try {
    const body = await readRequestBody(req, opts.maxBodyBytes);
    const requestBody = parseJsonBuffer(body);
    const request = parseAgentChatRequest(requestBody);
    result = await opts.chatService.chat(request);
  } catch (err) {
    if (err instanceof ZodError) {
      sendJson(res, 400, {
        ok: false,
        error: 'Invalid request body',
        details: err.issues,
      });
      return;
    }
    if (err instanceof RunOnceInputError) {
      sendJson(res, err.status, { ok: false, error: err.message });
      return;
    }
    logger.error({ err }, 'Internal agent chat handler failed');
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    });
    return;
  }

  sendJson(res, result.ok ? 200 : 502, result);
}

export async function handleInternalAgentRunOnceFileDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqUrl: URL,
  opts: RunOnceHandlerOptions,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  if (!opts.token || bearerToken(req) !== opts.token) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  const chatJid = reqUrl.searchParams.get('chat_jid') || '';
  const relativePath = reqUrl.searchParams.get('path') || '';
  if (!chatJid || !relativePath) {
    sendJson(res, 400, {
      ok: false,
      error: 'chat_jid and path are required',
    });
    return;
  }

  try {
    const groupFolder = opts.service.resolveGroupFolder(chatJid);
    const filePath = resolveRunOnceDownloadFile({
      groupFolder,
      relativePath,
    });
    sendFile(res, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'File download failed';
    const statusCode = message.includes('not found') ? 404 : 400;
    sendJson(res, statusCode, { ok: false, error: message });
  }
}
