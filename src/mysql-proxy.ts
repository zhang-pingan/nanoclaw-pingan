/**
 * MySQL proxy for container isolation.
 * Containers connect here instead of directly to MySQL.
 * The proxy injects real credentials so containers never see them.
 *
 * Protocol:
 *   POST /query
 *   Body: { "service": "catstory", "environment": "staging", "sql": "SELECT * FROM users_gray LIMIT 10" }
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

type MysqlEnvironment = 'default' | 'staging';

interface ServiceMysqlConfig {
  default?: MysqlConfig;
  staging?: MysqlConfig;
}

interface QueryRequest {
  service: string;
  sql: string;
  env?: string;
  environment?: string;
}

interface Mysql2Promise {
  createPool(options: PoolOptions): Pool;
}

// Service configs from services.json
const serviceMysqlConfigs: Record<string, ServiceMysqlConfig> = {};
const pools: Map<string, Pool> = new Map();

interface SqlToken {
  text: string;
  upper: string;
  quoted: boolean;
}

interface SqlPolicy {
  ok: boolean;
  error?: string;
}

const DML_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const DDL_COMMANDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
const IDENTIFIER_PUNCTUATION = new Set([',', '.', '(', ')', ';']);

function normalizeSingleMysqlConfig(
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

function normalizeServiceMysqlConfig(
  service: string,
  config: unknown,
): ServiceMysqlConfig | null {
  if (!config || typeof config !== 'object') return null;
  const record = config as Record<string, unknown>;
  const defaultConfig = normalizeSingleMysqlConfig(service, record);
  const stagingConfig = normalizeSingleMysqlConfig(service, record.staging);

  if (!defaultConfig && !stagingConfig) return null;
  return {
    default: defaultConfig ?? undefined,
    staging: stagingConfig ?? undefined,
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

function serviceMysqlConfigChanged(
  current: ServiceMysqlConfig | undefined,
  next: ServiceMysqlConfig | undefined,
): boolean {
  if (!current && !next) return false;
  if (!current || !next) return true;
  return (
    mysqlConfigChanged(current.default, next.default) ||
    mysqlConfigChanged(current.staging, next.staging)
  );
}

// Load MySQL configs from services.json
export function loadMysqlConfigs(configs: Record<string, unknown>): void {
  const nextConfigs: Record<string, ServiceMysqlConfig> = {};
  for (const [service, config] of Object.entries(configs)) {
    const mysqlConfig = normalizeServiceMysqlConfig(service, config);
    if (mysqlConfig) {
      nextConfigs[service] = mysqlConfig;
      logger.info(
        {
          service,
          defaultDatabase: mysqlConfig.default?.database,
          defaultHost: mysqlConfig.default?.host,
          stagingDatabase: mysqlConfig.staging?.database,
          stagingHost: mysqlConfig.staging?.host,
        },
        'Loaded MySQL config for service',
      );
    }
  }

  for (const [service, pool] of pools.entries()) {
    const [serviceName] = service.split(':');
    if (
      serviceMysqlConfigChanged(
        serviceMysqlConfigs[serviceName],
        nextConfigs[serviceName],
      )
    ) {
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

function normalizeEnvironment(value: unknown): MysqlEnvironment {
  const normalized =
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'staging' ||
    normalized === 'pre' ||
    normalized === 'gray' ||
    normalized === 'grey' ||
    normalized === '预发'
  ) {
    return 'staging';
  }
  return 'default';
}

async function getPool(
  service: string,
  environment: MysqlEnvironment,
): Promise<Pool> {
  // Return cached pool if exists
  const poolKey = `${service}:${environment}`;
  const cached = pools.get(poolKey);
  if (cached) {
    return cached;
  }

  const config = serviceMysqlConfigs[service]?.[environment];
  if (!config) {
    throw new Error(`No MySQL ${environment} config for service: ${service}`);
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

  pools.set(poolKey, pool);
  return pool;
}

function isIdentifierToken(token: SqlToken | undefined): token is SqlToken {
  return Boolean(
    token &&
    !IDENTIFIER_PUNCTUATION.has(token.text) &&
    !/^\d+(?:\.\d+)?$/.test(token.text),
  );
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;

  const push = (text: string, quoted = false) => {
    tokens.push({ text, upper: text.toUpperCase(), quoted });
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += i < sql.length ? 2 : 0;
      continue;
    }

    if (ch === '#' || (ch === '-' && next === '-')) {
      i += ch === '#' ? 1 : 2;
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '`') {
      i += 1;
      let text = '';
      while (i < sql.length) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            text += '`';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      if (text) push(text, true);
      continue;
    }

    if (IDENTIFIER_PUNCTUATION.has(ch)) {
      push(ch);
      i += 1;
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(ch)) {
      let text = ch;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) {
        text += sql[i];
        i += 1;
      }
      push(text);
      continue;
    }

    i += 1;
  }

  return tokens;
}

function getSingleStatementTokens(tokens: SqlToken[]): SqlToken[] | null {
  const firstSemicolon = tokens.findIndex((token) => token.text === ';');
  if (firstSemicolon === -1) return tokens;

  const hasTrailingStatement = tokens
    .slice(firstSemicolon + 1)
    .some((token) => token.text !== ';');
  if (hasTrailingStatement) return null;
  return tokens.slice(0, firstSemicolon);
}

function readQualifiedIdentifier(
  tokens: SqlToken[],
  index: number,
): { name: string; next: number } | null {
  if (!isIdentifierToken(tokens[index])) return null;

  const parts = [tokens[index].text];
  let next = index + 1;
  while (tokens[next]?.text === '.' && isIdentifierToken(tokens[next + 1])) {
    parts.push(tokens[next + 1].text);
    next += 2;
  }

  return { name: parts.join('.'), next };
}

function baseTableName(name: string): string {
  const parts = name.split('.');
  return (parts[parts.length - 1] || '').trim();
}

function isGrayTable(name: string): boolean {
  return baseTableName(name).toLowerCase().endsWith('_gray');
}

function skipOptionalTokens(
  tokens: SqlToken[],
  index: number,
  optional: Set<string>,
): number {
  let next = index;
  while (optional.has(tokens[next]?.upper || '')) {
    next += 1;
  }
  return next;
}

function findNextKeyword(
  tokens: SqlToken[],
  start: number,
  keywords: Set<string>,
): number {
  for (let i = start; i < tokens.length; i += 1) {
    if (keywords.has(tokens[i].upper)) return i;
  }
  return -1;
}

function findRangeEnd(
  tokens: SqlToken[],
  start: number,
  endKeywords: Set<string>,
): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.text === '(') {
      depth += 1;
      continue;
    }
    if (token.text === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && endKeywords.has(token.upper)) {
      return i;
    }
  }
  return tokens.length;
}

function collectTableReferenceRange(
  tokens: SqlToken[],
  start: number,
  end: number,
  tables: Set<string>,
): void {
  let expectingTable = true;

  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (token.text === ',') {
      expectingTable = true;
      continue;
    }
    if (token.upper.endsWith('JOIN')) {
      expectingTable = true;
      continue;
    }
    if (!expectingTable) continue;
    if (
      token.upper === 'AS' ||
      token.upper === 'ONLY' ||
      token.upper === 'LOW_PRIORITY' ||
      token.upper === 'IGNORE'
    ) {
      continue;
    }
    if (token.text === '(') {
      expectingTable = false;
      continue;
    }

    const identifier = readQualifiedIdentifier(tokens, i);
    if (identifier) {
      tables.add(identifier.name);
      i = identifier.next - 1;
      expectingTable = false;
    }
  }
}

function addIdentifierAt(
  tokens: SqlToken[],
  index: number,
  tables: Set<string>,
): number {
  const identifier = readQualifiedIdentifier(tokens, index);
  if (!identifier) return index;
  tables.add(identifier.name);
  return identifier.next;
}

function collectGlobalTableReferences(
  tokens: SqlToken[],
  tables: Set<string>,
): void {
  const endKeywords = new Set([
    'WHERE',
    'ON',
    'SET',
    'VALUES',
    'ORDER',
    'GROUP',
    'HAVING',
    'LIMIT',
    'RETURNING',
    'UNION',
    'EXCEPT',
    'INTERSECT',
    'FOR',
  ]);

  for (let i = 0; i < tokens.length; i += 1) {
    if (
      tokens[i].upper !== 'FROM' &&
      tokens[i].upper !== 'JOIN' &&
      tokens[i].upper !== 'USING'
    ) {
      continue;
    }
    if (tokens[i].upper === 'USING' && tokens[i + 1]?.text === '(') {
      continue;
    }

    const end = findRangeEnd(tokens, i + 1, endKeywords);
    collectTableReferenceRange(tokens, i + 1, end, tables);
  }
}

function collectReferencesTables(
  tokens: SqlToken[],
  tables: Set<string>,
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].upper === 'REFERENCES') {
      i = addIdentifierAt(tokens, i + 1, tables) - 1;
    }
  }
}

function collectInsertOrReplaceTables(
  tokens: SqlToken[],
  tables: Set<string>,
): void {
  let index = skipOptionalTokens(
    tokens,
    1,
    new Set(['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE']),
  );
  if (tokens[index]?.upper === 'INTO') index += 1;
  addIdentifierAt(tokens, index, tables);
}

function collectUpdateTables(tokens: SqlToken[], tables: Set<string>): void {
  const start = skipOptionalTokens(
    tokens,
    1,
    new Set(['LOW_PRIORITY', 'IGNORE']),
  );
  const setIndex = findNextKeyword(tokens, start, new Set(['SET']));
  const end = setIndex === -1 ? tokens.length : setIndex;
  collectTableReferenceRange(tokens, start, end, tables);
}

function collectDeleteTables(tokens: SqlToken[], tables: Set<string>): void {
  collectGlobalTableReferences(tokens, tables);
}

function collectCreateTables(tokens: SqlToken[], tables: Set<string>): void {
  const tableIndex = findNextKeyword(tokens, 1, new Set(['TABLE']));
  if (tableIndex !== -1) {
    let index = skipOptionalTokens(
      tokens,
      tableIndex + 1,
      new Set(['TEMPORARY', 'IF', 'NOT', 'EXISTS']),
    );
    if (tokens[index]?.upper === 'IF') {
      index = skipOptionalTokens(
        tokens,
        index,
        new Set(['IF', 'NOT', 'EXISTS']),
      );
    }
    addIdentifierAt(tokens, index, tables);
  }

  const onIndex = findNextKeyword(tokens, 1, new Set(['ON']));
  if (onIndex !== -1) {
    addIdentifierAt(tokens, onIndex + 1, tables);
  }

  const likeIndex = findNextKeyword(tokens, 1, new Set(['LIKE']));
  if (likeIndex !== -1) {
    addIdentifierAt(tokens, likeIndex + 1, tables);
  }
}

function collectAlterTables(tokens: SqlToken[], tables: Set<string>): void {
  const tableIndex = findNextKeyword(tokens, 1, new Set(['TABLE']));
  if (tableIndex !== -1) {
    addIdentifierAt(tokens, tableIndex + 1, tables);
  }

  for (let i = 1; i < tokens.length; i += 1) {
    if (
      tokens[i].upper === 'RENAME' &&
      (tokens[i + 1]?.upper === 'TO' || tokens[i + 1]?.upper === 'AS')
    ) {
      i = addIdentifierAt(tokens, i + 2, tables) - 1;
    }
  }
}

function collectDropTables(tokens: SqlToken[], tables: Set<string>): void {
  const tableIndex = findNextKeyword(tokens, 1, new Set(['TABLE']));
  if (tableIndex !== -1) {
    const start = skipOptionalTokens(
      tokens,
      tableIndex + 1,
      new Set(['IF', 'EXISTS', 'TEMPORARY']),
    );
    const end = findRangeEnd(tokens, start, new Set(['RESTRICT', 'CASCADE']));
    collectTableReferenceRange(tokens, start, end, tables);
  }

  const onIndex = findNextKeyword(tokens, 1, new Set(['ON']));
  if (onIndex !== -1) {
    addIdentifierAt(tokens, onIndex + 1, tables);
  }
}

function collectTruncateTables(tokens: SqlToken[], tables: Set<string>): void {
  const index = tokens[1]?.upper === 'TABLE' ? 2 : 1;
  addIdentifierAt(tokens, index, tables);
}

function collectRenameTables(tokens: SqlToken[], tables: Set<string>): void {
  let index = tokens[1]?.upper === 'TABLE' ? 2 : 1;
  while (index < tokens.length) {
    if (tokens[index].upper === 'TO' || tokens[index].text === ',') {
      index += 1;
      continue;
    }
    const next = addIdentifierAt(tokens, index, tables);
    index = next === index ? index + 1 : next;
  }
}

function collectMutableTables(tokens: SqlToken[]): Set<string> {
  const tables = new Set<string>();
  const command = tokens[0]?.upper || '';

  if (command === 'INSERT' || command === 'REPLACE') {
    collectInsertOrReplaceTables(tokens, tables);
  } else if (command === 'UPDATE') {
    collectUpdateTables(tokens, tables);
  } else if (command === 'DELETE') {
    collectDeleteTables(tokens, tables);
  } else if (command === 'CREATE') {
    collectCreateTables(tokens, tables);
  } else if (command === 'ALTER') {
    collectAlterTables(tokens, tables);
  } else if (command === 'DROP') {
    collectDropTables(tokens, tables);
  } else if (command === 'TRUNCATE') {
    collectTruncateTables(tokens, tables);
  } else if (command === 'RENAME') {
    collectRenameTables(tokens, tables);
  }

  collectGlobalTableReferences(tokens, tables);
  collectReferencesTables(tokens, tables);
  return tables;
}

function isSupportedDdlForm(tokens: SqlToken[]): boolean {
  const command = tokens[0]?.upper || '';
  if (command === 'CREATE') {
    return (
      findNextKeyword(tokens, 1, new Set(['TABLE'])) !== -1 ||
      findNextKeyword(tokens, 1, new Set(['INDEX'])) !== -1
    );
  }
  if (command === 'ALTER') {
    return findNextKeyword(tokens, 1, new Set(['TABLE'])) !== -1;
  }
  if (command === 'DROP') {
    return (
      findNextKeyword(tokens, 1, new Set(['TABLE'])) !== -1 ||
      findNextKeyword(tokens, 1, new Set(['INDEX'])) !== -1
    );
  }
  return command === 'TRUNCATE' || command === 'RENAME';
}

function validateSqlPolicy(
  sql: string,
  environment: MysqlEnvironment,
): SqlPolicy {
  const tokens = getSingleStatementTokens(tokenizeSql(sql));
  if (!tokens) {
    return { ok: false, error: 'Only one SQL statement is allowed' };
  }
  if (tokens.length === 0) {
    return { ok: false, error: 'SQL must not be empty' };
  }

  const command = tokens[0].upper;
  if (command === 'SELECT') {
    return { ok: true };
  }
  if (!DML_COMMANDS.has(command) && !DDL_COMMANDS.has(command)) {
    return {
      ok: false,
      error: 'Only SELECT, staging DML, and staging DDL queries are allowed',
    };
  }
  if (environment !== 'staging') {
    return {
      ok: false,
      error:
        'DML and DDL queries are only allowed for staging/pre environments',
    };
  }
  if (DDL_COMMANDS.has(command) && !isSupportedDdlForm(tokens)) {
    return {
      ok: false,
      error: 'Only table/index DDL is allowed for staging/pre _gray tables',
    };
  }

  const tables = [...collectMutableTables(tokens)];
  if (tables.length === 0) {
    return {
      ok: false,
      error:
        'DML and DDL queries must reference at least one _gray table in staging/pre',
    };
  }

  const nonGrayTables = tables.filter((table) => !isGrayTable(table));
  if (nonGrayTables.length > 0) {
    return {
      ok: false,
      error: `DML and DDL queries are only allowed on _gray tables in staging/pre: ${nonGrayTables.join(', ')}`,
    };
  }

  return { ok: true };
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
    const {
      environment: rawEnvironment,
      env,
      service,
      sql,
    } = await parseBody(req);
    if (typeof service !== 'string' || typeof sql !== 'string') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'service and sql are required' }));
      return;
    }

    const environment = normalizeEnvironment(rawEnvironment || env);
    const policy = validateSqlPolicy(sql, environment);
    if (!policy.ok) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: policy.error }));
      return;
    }

    logger.info(
      { environment, service, sql: sql.substring(0, 100) },
      'Executing MySQL query',
    );

    const pool = await getPool(service, environment);
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
