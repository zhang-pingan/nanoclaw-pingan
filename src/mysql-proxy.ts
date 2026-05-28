/**
 * MySQL proxy for container isolation.
 * Containers connect here instead of directly to MySQL.
 * The proxy injects real credentials so containers never see them.
 *
 * Protocol:
 *   POST /query
 *   Body: { "service": "catstory", "sql": "SELECT * FROM users LIMIT 10" }
 *   Response: { "rows": [...], "fields": [...] }
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import type { Pool, PoolOptions } from 'mysql2/promise';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  database: string;
}

interface QueryRequest {
  service: string;
  sql: string;
}

interface Mysql2Promise {
  createPool(options: PoolOptions): Pool;
}

// Service configs from services.json
const serviceMysqlConfigs: Record<string, MysqlConfig> = {};
const pools: Map<string, Pool> = new Map();

function normalizeMysqlConfig(
  service: string,
  config: unknown,
): MysqlConfig | null {
  if (!config || typeof config !== 'object') return null;
  const mysqlConfig = (config as Record<string, unknown>).mysql;
  if (!mysqlConfig || typeof mysqlConfig !== 'object') return null;

  const c = mysqlConfig as Record<string, unknown>;
  const host = typeof c.host === 'string' ? c.host.trim() : '';
  const user = typeof c.user === 'string' ? c.user.trim() : '';
  const database = typeof c.database === 'string' ? c.database.trim() : '';
  const rawPort = Number(c.port || 3306);
  const port = Number.isFinite(rawPort) ? Math.round(rawPort) : 3306;
  if (!service || !host || !user || !database) return null;

  return {
    host,
    port,
    user,
    database,
  };
}

function mysqlConfigChanged(
  current: MysqlConfig | undefined,
  next: MysqlConfig | undefined,
): boolean {
  if (!current && !next) return false;
  if (!current || !next) return true;
  return (
    current.host !== next.host ||
    current.port !== next.port ||
    current.user !== next.user ||
    current.database !== next.database
  );
}

// Load MySQL configs from services.json
export function loadMysqlConfigs(configs: Record<string, unknown>): void {
  const nextConfigs: Record<string, MysqlConfig> = {};
  for (const [service, config] of Object.entries(configs)) {
    const mysqlConfig = normalizeMysqlConfig(service, config);
    if (mysqlConfig) {
      nextConfigs[service] = mysqlConfig;
      logger.info(
        { service, host: mysqlConfig.host, database: mysqlConfig.database },
        'Loaded MySQL config for service',
      );
    }
  }

  for (const [service, pool] of pools.entries()) {
    if (mysqlConfigChanged(serviceMysqlConfigs[service], nextConfigs[service])) {
      pools.delete(service);
      void pool.end().catch((err) => {
        logger.warn({ err, service }, 'Failed to close stale MySQL pool');
      });
    }
  }

  for (const service of Object.keys(serviceMysqlConfigs)) {
    delete serviceMysqlConfigs[service];
  }
  Object.assign(serviceMysqlConfigs, nextConfigs);
}

async function getPool(service: string): Promise<Pool> {
  // Return cached pool if exists
  const cached = pools.get(service);
  if (cached) {
    return cached;
  }

  const config = serviceMysqlConfigs[service];
  if (!config) {
    throw new Error(`No MySQL config for service: ${service}`);
  }

  // Read password from env: MYSQL_PASSWORD_{service}
  const secrets = readEnvFile([`MYSQL_PASSWORD_${service}`]);
  const password = secrets[`MYSQL_PASSWORD_${service}`];
  if (!password) {
    throw new Error(
      `No password configured for service: ${service} (MYSQL_PASSWORD_${service})`,
    );
  }

  const mysql2 = (await import('mysql2/promise')) as Mysql2Promise;
  const pool = mysql2.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  pools.set(service, pool);
  return pool;
}

function parseBody(req: IncomingMessage): Promise<QueryRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleQuery(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/query') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  try {
    const { service, sql } = await parseBody(req);

    // Security check: only SELECT queries allowed
    const sqlTrimmed = sql.trim().toUpperCase();
    if (!sqlTrimmed.startsWith('SELECT')) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Only SELECT queries are allowed' }));
      return;
    }

    logger.info(
      { service, sql: sql.substring(0, 100) },
      'Executing MySQL query',
    );

    const pool = await getPool(service);
    const [rows, fields] = await pool.query(sql);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        rows,
        fields: Array.isArray(fields)
          ? fields.map((f: unknown) => (f as { name: string }).name)
          : [],
      }),
    );
  } catch (err) {
    logger.error({ err }, 'MySQL query error');
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

export function startMysqlProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleQuery);

    server.listen(port, host, () => {
      logger.info({ port, host }, 'MySQL proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
