import { PassThrough, Writable } from 'stream';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'http';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: `${process.env.TMPDIR || '/tmp'}/icarus-run-once-handler-${process.pid}`,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
}));

import { _initTestDatabase } from '../db.js';
import { GroupQueue } from '../group-queue.js';
import type { RegisteredGroup } from '../types.js';
import {
  handleInternalAgentRunOnce,
  handleInternalAgentRunOnceFileDownload,
} from './handler.js';
import { InternalAgentRunOnceService } from './service.js';
import type { RunOnceRequestInput, RunOnceResponse } from './schemas.js';

class LocalServerResponse extends Writable {
  statusCode = 200;
  headers: IncomingHttpHeaders = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  private finishResolver: (() => void) | null = null;
  readonly finished = new Promise<void>((resolve) => {
    this.finishResolver = resolve;
  });

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
        typeof finalChunk === 'string' ? Buffer.from(finalChunk) : finalChunk,
      );
    }

    this.headersSent = true;
    return super.end(() => {
      finalCallback?.();
      this.finishResolver?.();
    });
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }

  get json(): unknown {
    return JSON.parse(this.body);
  }
}

const group: RegisteredGroup = {
  name: 'L3 Agent',
  folder: 'handler_l3agent',
  trigger: '@Andy',
  added_at: '2026-06-15T00:00:00.000Z',
};

type RunOnceFn = (request: RunOnceRequestInput) => Promise<RunOnceResponse>;
type RunOnceMock = ReturnType<typeof vi.fn<RunOnceFn>>;

function makeService(runOnce: RunOnceMock): InternalAgentRunOnceService {
  const service = new InternalAgentRunOnceService({
    registeredGroups: () => ({ 'web:l3agent': group }),
    queue: new GroupQueue(),
    onProcess: vi.fn(),
    maxInputChars: 10000,
  });
  vi.spyOn(service, 'runOnce').mockImplementation(runOnce);
  return service;
}

function makeRunOnceMock(implementation: RunOnceFn): RunOnceMock {
  return vi.fn<RunOnceFn>(implementation);
}

async function postToHandler(input: {
  body: Buffer | string;
  contentType: string;
  token?: string;
  service: InternalAgentRunOnceService;
}): Promise<LocalServerResponse> {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = 'POST';
  req.url = '/internal/agent/run-once';
  req.headers = {
    authorization: `Bearer ${input.token || 'secret'}`,
    'content-type': input.contentType,
  };
  const res = new LocalServerResponse();

  const handled = handleInternalAgentRunOnce(
    req,
    res as unknown as ServerResponse,
    {
      service: input.service,
      token: 'secret',
      maxBodyBytes: 1024 * 1024,
    },
  );
  req.end(input.body);
  await handled;
  return res;
}

async function downloadFromHandler(input: {
  path: string;
  token?: string;
  service: InternalAgentRunOnceService;
}): Promise<LocalServerResponse> {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = 'GET';
  req.url = input.path;
  req.headers = {
    authorization: `Bearer ${input.token || 'secret'}`,
  };
  const res = new LocalServerResponse();
  const reqUrl = new URL(input.path, 'http://127.0.0.1:3004');

  await handleInternalAgentRunOnceFileDownload(
    req,
    res as unknown as ServerResponse,
    reqUrl,
    {
      service: input.service,
      token: 'secret',
      maxBodyBytes: 1024 * 1024,
    },
  );
  await res.finished;
  return res;
}

function multipartBody(parts: {
  boundary: string;
  request: unknown;
  files: Array<{
    fieldName?: string;
    filename: string;
    contentType: string;
    data: Buffer | string;
  }>;
}): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(
    Buffer.from(
      `--${parts.boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`,
      'utf-8',
    ),
  );
  chunks.push(Buffer.from(JSON.stringify(parts.request), 'utf-8'));

  for (const file of parts.files) {
    chunks.push(
      Buffer.from(
        `\r\n--${parts.boundary}\r\nContent-Disposition: form-data; name="${file.fieldName || 'files'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        'utf-8',
      ),
    );
    chunks.push(
      typeof file.data === 'string'
        ? Buffer.from(file.data, 'utf-8')
        : file.data,
    );
  }
  chunks.push(Buffer.from(`\r\n--${parts.boundary}--\r\n`, 'utf-8'));
  return Buffer.concat(chunks);
}

describe('internal run-once handler', () => {
  beforeEach(() => {
    _initTestDatabase();
    fs.rmSync(
      path.join(TEST_DATA_DIR, 'run-once-workspaces', 'handler_l3agent'),
      {
        recursive: true,
        force: true,
      },
    );
  });

  afterAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('keeps the existing JSON body contract', async () => {
    const runOnce = makeRunOnceMock(async () => ({
      ok: true as const,
      text: 'answer',
      run_id: 'run-json',
      query_id: 'query-json',
      model: 'test-model',
    }));
    const service = makeService(runOnce);

    const res = await postToHandler({
      service,
      contentType: 'application/json',
      body: JSON.stringify({
        system: 'system prompt',
        chat_jid: 'web:l3agent',
        messages: [{ role: 'user', content: 'question' }],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json).toMatchObject({ ok: true, text: 'answer' });
    expect(runOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'system prompt',
        chat_jid: 'web:l3agent',
        files: [],
      }),
    );
  });

  it('accepts multipart request and saves uploaded files into run-once workspace', async () => {
    const runOnce = makeRunOnceMock(async () => ({
      ok: true as const,
      text: 'file answer',
      run_id: 'run-multipart',
      query_id: 'query-multipart',
      model: 'test-model',
    }));
    const service = makeService(runOnce);
    const boundary = '----IcarusRunOnceBoundary';
    const body = multipartBody({
      boundary,
      request: {
        system: 'system prompt',
        chat_jid: 'web:l3agent',
        messages: [{ role: 'user', content: 'summarize attachment' }],
        metadata: { trace_id: 'trace-upload' },
      },
      files: [
        {
          filename: '报告?.md',
          contentType: 'text/markdown',
          data: '# 风险\n',
        },
      ],
    });

    const res = await postToHandler({
      service,
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    });

    expect(res.statusCode).toBe(200);
    const request = runOnce.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('request was not captured');
    expect(request).toMatchObject({
      chat_jid: 'web:l3agent',
      metadata: {
        trace_id: 'trace-upload',
        uploaded_file_count: 1,
        upload_id: expect.any(String),
      },
      files: [
        {
          name: '报告_.md',
          agent_path: expect.stringMatching(
            /^\/workspace\/run-once\/inputs\/[^/]+\/报告_\.md$/,
          ),
          relative_path: expect.stringMatching(/^inputs\/[^/]+\/报告_\.md$/),
          size: Buffer.byteLength('# 风险\n'),
          sha256: expect.any(String),
          content_type: 'text/markdown',
        },
      ],
    });

    const uploaded = request.files?.[0];
    expect(uploaded).toBeDefined();
    if (!uploaded?.relative_path) throw new Error('upload was not captured');
    const hostPath = path.resolve(
      TEST_DATA_DIR,
      'run-once-workspaces',
      'handler_l3agent',
      uploaded.relative_path,
    );
    expect(fs.readFileSync(hostPath, 'utf-8')).toBe('# 风险\n');
  });

  it('rejects multipart bodies without a request field', async () => {
    const service = makeService(
      makeRunOnceMock(async () => ({
        ok: true as const,
        text: 'unused',
        run_id: 'run',
        query_id: 'query',
        model: 'test-model',
      })),
    );
    const boundary = '----IcarusMissingRequest';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\nhello\r\n--${boundary}--\r\n`,
      'utf-8',
    );

    const res = await postToHandler({
      service,
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({
      ok: false,
      error: 'Multipart field "request" is required',
    });
  });

  it('downloads generated output files with the internal token', async () => {
    const service = makeService(
      makeRunOnceMock(async () => ({
        ok: true as const,
        text: 'unused',
        run_id: 'run',
        query_id: 'query',
        model: 'test-model',
      })),
    );
    const relativePath = 'outputs/run-download/report.md';
    const hostPath = path.resolve(
      TEST_DATA_DIR,
      'run-once-workspaces',
      'handler_l3agent',
      relativePath,
    );
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, '# Download\n');

    const res = await downloadFromHandler({
      service,
      path: `/internal/agent/run-once/files?chat_jid=${encodeURIComponent(
        'web:l3agent',
      )}&path=${encodeURIComponent(relativePath)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/markdown');
    expect(res.body).toBe('# Download\n');
  });

  it('rejects output file download path traversal', async () => {
    const service = makeService(
      makeRunOnceMock(async () => ({
        ok: true as const,
        text: 'unused',
        run_id: 'run',
        query_id: 'query',
        model: 'test-model',
      })),
    );

    const res = await downloadFromHandler({
      service,
      path: `/internal/agent/run-once/files?chat_jid=${encodeURIComponent(
        'web:l3agent',
      )}&path=${encodeURIComponent('outputs/run/../secret.txt')}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({
      ok: false,
      error: 'Invalid output file path',
    });
  });
});
