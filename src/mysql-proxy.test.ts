import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'stream';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'http';

const {
  createPoolMock,
  createServerMock,
  endMock,
  getLastRequestHandler,
  queryMock,
  readEnvFileMock,
  resetHttpMock,
} = vi.hoisted(() => {
  let lastRequestHandler:
    | ((req: IncomingMessage, res: ServerResponse) => void)
    | undefined;
  const fakeServer = {
    listen: vi.fn(
      (
        _port: number,
        _host: string,
        callback?: () => void,
      ): typeof fakeServer => {
        callback?.();
        return fakeServer;
      },
    ),
    on: vi.fn((): typeof fakeServer => fakeServer),
  };

  return {
    createPoolMock: vi.fn(),
    createServerMock: vi.fn(
      (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        lastRequestHandler = handler;
        return fakeServer;
      },
    ),
    endMock: vi.fn(),
    getLastRequestHandler: () => lastRequestHandler,
    queryMock: vi.fn(),
    readEnvFileMock: vi.fn(),
    resetHttpMock: () => {
      lastRequestHandler = undefined;
      fakeServer.listen.mockClear();
      fakeServer.on.mockClear();
    },
  };
});

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  },
}));

vi.mock('mysql2/promise', () => ({
  createPool: createPoolMock,
}));

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    createServer: createServerMock,
  };
});

async function loadProxy(): Promise<typeof import('./mysql-proxy.js')> {
  vi.resetModules();
  return import('./mysql-proxy.js');
}

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
        typeof finalChunk === 'string' ? Buffer.from(finalChunk) : finalChunk,
      );
    }

    this.headersSent = true;
    return super.end(finalCallback);
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

async function postQuery(body: unknown): Promise<LocalServerResponse> {
  const handler = getLastRequestHandler();
  if (!handler) throw new Error('MySQL proxy handler was not registered');

  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.method = 'POST';
  req.url = '/query';
  const res = new LocalServerResponse();

  const handled = handler(req, res as unknown as ServerResponse);
  req.end(JSON.stringify(body));
  await handled;

  return res;
}

function mockMysqlPool(result: unknown = [[{ affectedRows: 1 }], []]): void {
  createPoolMock.mockReturnValue({
    end: endMock,
    query: queryMock.mockResolvedValue(result),
  });
  readEnvFileMock.mockReturnValue({
    MYSQL_PASSWORD_demo: 'secret',
  });
}

function demoMysqlConfig(): Record<string, unknown> {
  return {
    demo: {
      mysql: {
        database: 'demo_db',
        host: '127.0.0.1',
        port: 3306,
        user: 'demo_user',
      },
      staging: {
        mysql: {
          database: 'demo_gray_db',
          host: '192.0.2.10',
          port: 3307,
          user: 'demo_gray_user',
        },
      },
    },
  };
}

describe('mysql-proxy', () => {
  afterEach(() => {
    createPoolMock.mockReset();
    createServerMock.mockClear();
    endMock.mockReset();
    queryMock.mockReset();
    readEnvFileMock.mockReset();
    resetHttpMock();
  });

  it('returns snowflake-sized bigint values as JSON strings', async () => {
    const snowflakeId = '9223372036854775807';
    const mockPool = {
      end: endMock,
      query: queryMock.mockResolvedValue([
        [{ id: snowflakeId, name: 'demo' }],
        [{ name: 'id' }, { name: 'name' }],
      ]),
    };
    createPoolMock.mockReturnValue(mockPool);
    readEnvFileMock.mockReturnValue({
      MYSQL_PASSWORD_demo: 'secret',
    });

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs({
      demo: {
        mysql: {
          database: 'demo_db',
          host: '127.0.0.1',
          port: 3306,
          user: 'demo_user',
        },
      },
    });

    await startMysqlProxy(0);
    const response = await postQuery({
      service: 'demo',
      sql: 'SELECT id, name FROM users LIMIT 1',
    });
    const parsed = JSON.parse(response.body) as {
      fields: string[];
      rows: Array<{ id: unknown; name: string }>;
    };

    expect(response.statusCode).toBe(200);
    expect(parsed.rows[0]?.id).toBe(snowflakeId);
    expect(typeof parsed.rows[0]?.id).toBe('string');
    expect(parsed.fields).toEqual(['id', 'name']);
    expect(response.body).toContain(`"id":"${snowflakeId}"`);
    expect(response.body).not.toContain('9223372036854776000');

    expect(createPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bigNumberStrings: true,
        supportBigNumbers: true,
      }),
    );
  });

  it('uses staging MySQL config when staging environment is requested', async () => {
    mockMysqlPool([[], []]);

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      environment: 'staging',
      service: 'demo',
      sql: 'SELECT id, name FROM users_gray LIMIT 1',
    });

    expect(response.statusCode).toBe(200);
    expect(createPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        database: 'demo_gray_db',
        host: '192.0.2.10',
        port: 3307,
        user: 'demo_gray_user',
      }),
    );
  });

  it('rejects DML outside staging even when the table is _gray suffixed', async () => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      service: 'demo',
      sql: 'UPDATE users_gray SET name = "demo" WHERE id = 1',
    });
    const parsed = JSON.parse(response.body) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(parsed.error).toContain('staging/pre');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects staging DML against non-_gray tables', async () => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      environment: 'pre',
      service: 'demo',
      sql: 'UPDATE users SET name = "demo" WHERE id = 1',
    });
    const parsed = JSON.parse(response.body) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(parsed.error).toContain('_gray');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows staging DML against _gray tables', async () => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const sql = 'UPDATE users_gray SET name = "demo" WHERE id = 1';
    const response = await postQuery({
      environment: 'staging',
      service: 'demo',
      sql,
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(sql);
  });

  it.each([
    'CREATE TABLE IF NOT EXISTS users_gray (id BIGINT)',
    'CREATE INDEX idx_users_gray_created ON users_gray (created_at)',
    'ALTER TABLE users_gray ADD COLUMN nickname VARCHAR(64)',
    'ALTER TABLE users_gray RENAME TO users_archive_gray',
    'RENAME TABLE users_gray TO users_archive_gray',
    'DROP TABLE IF EXISTS users_gray',
    'TRUNCATE TABLE users_gray',
  ])('allows staging DDL against _gray tables: %s', async (sql) => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      environment: 'staging',
      service: 'demo',
      sql,
    });

    expect(response.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(sql);
  });

  it('rejects staging DDL against non-_gray tables', async () => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      environment: 'staging',
      service: 'demo',
      sql: 'ALTER TABLE users ADD COLUMN nickname VARCHAR(64)',
    });
    const parsed = JSON.parse(response.body) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(parsed.error).toContain('users');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects multiple SQL statements', async () => {
    mockMysqlPool();

    const { loadMysqlConfigs, startMysqlProxy } = await loadProxy();
    loadMysqlConfigs(demoMysqlConfig());

    await startMysqlProxy(0);
    const response = await postQuery({
      environment: 'staging',
      service: 'demo',
      sql: 'UPDATE users_gray SET name = "demo"; UPDATE users_gray SET name = "demo2"',
    });
    const parsed = JSON.parse(response.body) as { error: string };

    expect(response.statusCode).toBe(400);
    expect(parsed.error).toContain('Only one SQL statement');
    expect(queryMock).not.toHaveBeenCalled();
  });
});
