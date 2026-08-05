import fs from 'fs';
import path from 'path';
import { types as utilTypes } from 'node:util';

import Database from 'better-sqlite3';

import {
  assertCurrentWorkflowRuntimeStructure,
  migrateWorkflowRuntimeSchema,
} from '../schema/compatibility.js';
import { ensureCapacityDefaults } from '../../capacity/defaults.js';
import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  readFreshWorkflowRuntimeSchemaSql,
  WORKFLOW_RUNTIME_SQLITE_CONFIG,
} from './config.js';
import { assertRuntimeCommandIngressIntegrity } from './command-ingress-integrity.js';

export type WorkflowRuntimeSqlValue = string | number | bigint | Buffer | null;

export interface WorkflowRuntimeWriteResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface WorkflowRuntimeReadConnection {
  readonly isOpen: boolean;
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[];
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined;
  close(): void;
}

export interface WorkflowRuntimeWriteTransaction {
  readonly transactionKind: 'immediate';
  stageTransientIdSet?(setKey: string, ids: readonly string[]): number;
  execute(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): WorkflowRuntimeWriteResult;
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[];
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined;
}

export interface OpenWorkflowRuntimeStoreOptions {
  readonly databasePath: string;
  readonly databaseMode: 'create' | 'open_existing';
}

export interface OpenWorkflowRuntimeReadOnlyOptions {
  readonly databasePath: string;
}

export class WorkflowRuntimeStoreError extends Error {
  constructor(
    readonly code:
      | 'database_path_invalid'
      | 'database_exists'
      | 'database_missing'
      | 'database_profile_mismatch'
      | 'database_schema_mismatch'
      | 'database_integrity_mismatch'
      | 'writer_already_owned'
      | 'connection_closed'
      | 'transaction_already_active'
      | 'transaction_callback_async'
      | 'transient_id_set_invalid'
      | 'write_statement_forbidden'
      | 'read_statement_required',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'WorkflowRuntimeStoreError';
  }
}

const writerOwners = new Set<string>();
const storeConstructorToken = Symbol('WorkflowRuntimeStore');

function scalarPragma(
  database: Database.Database,
  pragma: string,
): string | number {
  const value = database.pragma(pragma, { simple: true }) as unknown;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`PRAGMA ${pragma} did not return a scalar`);
  }
  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new WorkflowRuntimeStoreError(
      'database_profile_mismatch',
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function verifyDatabaseLevelProfile(database: Database.Database): void {
  assertEqual(
    String(scalarPragma(database, 'journal_mode')).toLowerCase(),
    'wal',
    'journal_mode',
  );
  assertEqual(
    Number(scalarPragma(database, 'page_size')),
    WORKFLOW_RUNTIME_SQLITE_CONFIG.pageSize,
    'page_size',
  );
  assertEqual(Number(scalarPragma(database, 'auto_vacuum')), 2, 'auto_vacuum');
}

function configureConnection(
  database: Database.Database,
  readOnly: boolean,
): void {
  if (!readOnly) {
    database.pragma('journal_mode = WAL');
  }
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma(
    `busy_timeout = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.busyTimeoutMs}`,
  );
  database.pragma('temp_store = MEMORY');
  database.pragma(
    `wal_autocheckpoint = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.walAutocheckpointPages}`,
  );
  database.pragma(
    `journal_size_limit = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.journalSizeLimitBytes}`,
  );
  database.pragma(
    `cache_size = -${WORKFLOW_RUNTIME_SQLITE_CONFIG.cacheSizeKib}`,
  );
  database.pragma(
    `mmap_size = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.mmapSizeBytes}`,
  );
  database.pragma('trusted_schema = OFF');
  database.pragma('recursive_triggers = OFF');
  database.pragma('read_uncommitted = OFF');
  database.pragma('locking_mode = NORMAL');
  database.pragma(`query_only = ${readOnly ? 'ON' : 'OFF'}`);
}

const TRANSIENT_ID_SET_TABLE = 'workflow_runtime_transient_id_sets';

function configureWriterTransientTables(database: Database.Database): void {
  database.exec(
    `CREATE TEMP TABLE ${TRANSIENT_ID_SET_TABLE} (
       set_key TEXT NOT NULL,
       ordinal INTEGER NOT NULL,
       id TEXT NOT NULL,
       PRIMARY KEY (set_key, id),
       UNIQUE (set_key, ordinal)
     ) WITHOUT ROWID`,
  );
}

function verifyCompleteProfile(
  database: Database.Database,
  readOnly: boolean,
): void {
  verifyDatabaseLevelProfile(database);
  const expected: Array<[string, string | number]> = [
    ['synchronous', 2],
    ['foreign_keys', 1],
    ['busy_timeout', WORKFLOW_RUNTIME_SQLITE_CONFIG.busyTimeoutMs],
    ['temp_store', 2],
    [
      'wal_autocheckpoint',
      WORKFLOW_RUNTIME_SQLITE_CONFIG.walAutocheckpointPages,
    ],
    [
      'journal_size_limit',
      WORKFLOW_RUNTIME_SQLITE_CONFIG.journalSizeLimitBytes,
    ],
    ['cache_size', -WORKFLOW_RUNTIME_SQLITE_CONFIG.cacheSizeKib],
    ['mmap_size', WORKFLOW_RUNTIME_SQLITE_CONFIG.mmapSizeBytes],
    ['trusted_schema', 0],
    ['recursive_triggers', 0],
    ['read_uncommitted', 0],
    ['locking_mode', 'normal'],
    ['query_only', readOnly ? 1 : 0],
  ];
  for (const [pragma, expectedValue] of expected) {
    const actual = scalarPragma(database, pragma);
    assertEqual(
      typeof expectedValue === 'string'
        ? String(actual).toLowerCase()
        : Number(actual),
      expectedValue,
      pragma,
    );
  }
}

function verifyIntegrity(database: Database.Database): void {
  assertEqual(
    database.pragma('integrity_check', { simple: true }),
    'ok',
    'integrity_check',
  );
  const foreignKeyFailures = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length !== 0) {
    throw new WorkflowRuntimeStoreError(
      'database_schema_mismatch',
      'foreign_key_check returned violations',
    );
  }
}

function verifyCurrentSchema(database: Database.Database): void {
  try {
    assertCurrentWorkflowRuntimeStructure(database);
  } catch (error) {
    throw new WorkflowRuntimeStoreError(
      'database_schema_mismatch',
      `workflow-runtime.db schema is incompatible: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function upgradeSchemaIfEligible(databasePath: string): void {
  const database = new Database(databasePath, {
    fileMustExist: true,
    timeout: WORKFLOW_RUNTIME_SQLITE_CONFIG.busyTimeoutMs,
  });
  try {
    verifyDatabaseLevelProfile(database);
    const version = Number(scalarPragma(database, 'user_version'));
    if (version === CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION) {
      verifyCurrentSchema(database);
      return;
    }
    migrateWorkflowRuntimeSchema(database);
  } catch (error) {
    if (error instanceof WorkflowRuntimeStoreError) throw error;
    throw new WorkflowRuntimeStoreError(
      'database_schema_mismatch',
      `Schema ${String(Number(scalarPragma(database, 'user_version')))} upgrade failed closed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    database.close();
  }
}

function bootstrapFreshDatabase(databasePath: string): void {
  const bootstrap = new Database(databasePath, {
    timeout: WORKFLOW_RUNTIME_SQLITE_CONFIG.busyTimeoutMs,
  });
  try {
    bootstrap.pragma(`page_size = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.pageSize}`);
    bootstrap.pragma('auto_vacuum = INCREMENTAL');
    assertEqual(
      Number(scalarPragma(bootstrap, 'page_size')),
      WORKFLOW_RUNTIME_SQLITE_CONFIG.pageSize,
      'bootstrap page_size',
    );
    assertEqual(
      Number(scalarPragma(bootstrap, 'auto_vacuum')),
      2,
      'bootstrap auto_vacuum',
    );
    bootstrap.pragma('foreign_keys = ON');
    bootstrap.exec(readFreshWorkflowRuntimeSchemaSql());
    assertCurrentWorkflowRuntimeStructure(bootstrap);
    assertEqual(
      String(
        bootstrap.pragma('journal_mode = WAL', { simple: true }),
      ).toLowerCase(),
      'wal',
      'bootstrap journal_mode',
    );
  } finally {
    bootstrap.close();
  }
}

function cleanupFreshDatabase(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function canonicalDatabasePath(
  databasePath: string,
  mode: OpenWorkflowRuntimeStoreOptions['databaseMode'] | 'read_only',
): string {
  if (
    databasePath === ':memory:' ||
    databasePath.startsWith('file:') ||
    path.basename(databasePath) !== 'workflow-runtime.db'
  ) {
    throw new WorkflowRuntimeStoreError(
      'database_path_invalid',
      'Workflow Runtime requires a real file named workflow-runtime.db',
    );
  }
  const absolute = path.resolve(databasePath);
  const parent = path.dirname(absolute);
  if (mode === 'create') {
    fs.mkdirSync(parent, { recursive: true });
  }
  if (!fs.existsSync(parent)) {
    throw new WorkflowRuntimeStoreError(
      'database_missing',
      `Workflow Runtime database directory does not exist: ${parent}`,
    );
  }
  const canonicalParent = fs.realpathSync(parent);
  const canonical = path.join(canonicalParent, 'workflow-runtime.db');
  if (fs.existsSync(canonical) && fs.lstatSync(canonical).isSymbolicLink()) {
    throw new WorkflowRuntimeStoreError(
      'database_path_invalid',
      'workflow-runtime.db must not be a symbolic link',
    );
  }
  return canonical;
}

function openConfiguredDatabase(
  databasePath: string,
  readOnly: boolean,
): Database.Database {
  const database = new Database(databasePath, {
    readonly: readOnly,
    fileMustExist: true,
    timeout: WORKFLOW_RUNTIME_SQLITE_CONFIG.busyTimeoutMs,
  });
  try {
    // Existing databases are verified before any profile-setting PRAGMA is issued.
    verifyDatabaseLevelProfile(database);
    configureConnection(database, readOnly);
    verifyCompleteProfile(database, readOnly);
    verifyIntegrity(database);
    verifyCurrentSchema(database);
    try {
      assertRuntimeCommandIngressIntegrity(new ReadConnection(database));
    } catch (error) {
      throw new WorkflowRuntimeStoreError(
        'database_integrity_mismatch',
        'Runtime Command ingress trusted terminal authority is invalid',
        { cause: error },
      );
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function prepareReadStatement<T extends Record<string, unknown>>(
  database: Database.Database,
  sql: string,
): Database.Statement<WorkflowRuntimeSqlValue[], T> {
  const statement = database.prepare<WorkflowRuntimeSqlValue[], T>(sql);
  if (!statement.reader) {
    throw new WorkflowRuntimeStoreError(
      'read_statement_required',
      'Workflow Runtime query API accepts only row-returning statements',
    );
  }
  return statement;
}

class ReadConnection implements WorkflowRuntimeReadConnection {
  #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  get isOpen(): boolean {
    return this.#database.open;
  }

  private assertOpen(): void {
    if (!this.#database.open) {
      throw new WorkflowRuntimeStoreError(
        'connection_closed',
        'Workflow Runtime read connection is closed',
      );
    }
  }

  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    this.assertOpen();
    return prepareReadStatement<T>(this.#database, sql).all(...parameters);
  }

  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    this.assertOpen();
    return prepareReadStatement<T>(this.#database, sql).get(...parameters);
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }
}

class WriteTransaction implements WorkflowRuntimeWriteTransaction {
  readonly transactionKind = 'immediate' as const;
  #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  stageTransientIdSet(setKey: string, ids: readonly string[]): number {
    if (
      setKey.length === 0 ||
      ids.length === 0 ||
      ids.some((id) => id.length === 0) ||
      new Set(ids).size !== ids.length
    ) {
      throw new WorkflowRuntimeStoreError(
        'transient_id_set_invalid',
        'Transient ID sets require a non-empty key and non-empty unique IDs',
      );
    }
    this.#database
      .prepare(`DELETE FROM temp.${TRANSIENT_ID_SET_TABLE} WHERE set_key = ?`)
      .run(setKey);
    const result = this.#database
      .prepare(
        `INSERT INTO temp.${TRANSIENT_ID_SET_TABLE} (set_key, ordinal, id)
         SELECT ?, CAST(key AS INTEGER), value
           FROM json_each(?)
          ORDER BY CAST(key AS INTEGER)`,
      )
      .run(setKey, JSON.stringify(ids));
    if (result.changes !== ids.length) {
      throw new WorkflowRuntimeStoreError(
        'transient_id_set_invalid',
        `Transient ID set staging changed ${result.changes} rows; expected ${ids.length}`,
      );
    }
    return result.changes;
  }

  execute(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): WorkflowRuntimeWriteResult {
    if (!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
      throw new WorkflowRuntimeStoreError(
        'write_statement_forbidden',
        'Write transactions accept only parameterized DML; DDL, PRAGMA, ATTACH, VACUUM, and transaction control are owned by the Store',
      );
    }
    const statement = this.#database.prepare<WorkflowRuntimeSqlValue[]>(sql);
    if (statement.readonly || statement.reader) {
      throw new WorkflowRuntimeStoreError(
        'write_statement_forbidden',
        'Write transaction execute() requires a non-row-returning DML statement',
      );
    }
    const result = statement.run(...parameters);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    const statement = prepareReadStatement<T>(this.#database, sql);
    if (!statement.readonly) {
      throw new WorkflowRuntimeStoreError(
        'read_statement_required',
        'Transaction query API accepts only read-only statements',
      );
    }
    return statement.all(...parameters);
  }

  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    const statement = prepareReadStatement<T>(this.#database, sql);
    if (!statement.readonly) {
      throw new WorkflowRuntimeStoreError(
        'read_statement_required',
        'Transaction query API accepts only read-only statements',
      );
    }
    return statement.get(...parameters);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class WorkflowRuntimeStore {
  readonly databasePath: string;
  readonly schemaVersion = CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION;
  #writer: Database.Database;
  #reader: WorkflowRuntimeReadConnection;
  #releaseWriter: () => void;
  #transactionActive = false;

  constructor(
    token: symbol,
    databasePath: string,
    writer: Database.Database,
    reader: WorkflowRuntimeReadConnection,
    releaseWriter: () => void,
  ) {
    if (token !== storeConstructorToken) {
      throw new Error(
        'WorkflowRuntimeStore instances must be created by WorkflowRuntimeConnectionFactory',
      );
    }
    this.databasePath = databasePath;
    this.#writer = writer;
    this.#reader = reader;
    this.#releaseWriter = releaseWriter;
  }

  get isOpen(): boolean {
    return this.#writer.open;
  }

  private assertOpen(): void {
    if (!this.#writer.open) {
      throw new WorkflowRuntimeStoreError(
        'connection_closed',
        'WorkflowRuntimeStore is closed',
      );
    }
  }

  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    this.assertOpen();
    return this.#reader.queryAll<T>(sql, parameters);
  }

  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    this.assertOpen();
    return this.#reader.queryOne<T>(sql, parameters);
  }

  withImmediateTransaction<T>(
    callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
  ): T {
    this.assertOpen();
    if (this.#transactionActive || this.#writer.inTransaction) {
      throw new WorkflowRuntimeStoreError(
        'transaction_already_active',
        'Nested or concurrent Store write transactions are forbidden',
      );
    }
    if (utilTypes.isAsyncFunction(callback)) {
      throw new WorkflowRuntimeStoreError(
        'transaction_callback_async',
        'Workflow Runtime transaction callbacks must be synchronous; async callbacks are rejected before BEGIN IMMEDIATE',
      );
    }
    this.#transactionActive = true;
    this.#writer.exec('BEGIN IMMEDIATE');
    try {
      this.#writer.prepare(`DELETE FROM temp.${TRANSIENT_ID_SET_TABLE}`).run();
      const result = callback(new WriteTransaction(this.#writer));
      if (isThenable(result)) {
        throw new WorkflowRuntimeStoreError(
          'transaction_callback_async',
          'Workflow Runtime transaction callbacks must be synchronous; Agent/tool/file/network work is forbidden inside the transaction',
        );
      }
      this.#writer.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#writer.open && this.#writer.inTransaction) {
        try {
          this.#writer.exec('ROLLBACK');
        } catch (rollbackError) {
          if (error instanceof Error) {
            Object.defineProperty(error, 'rollbackError', {
              value: rollbackError,
              enumerable: false,
            });
          }
        }
      }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  close(): void {
    if (!this.#writer.open) return;
    if (this.#transactionActive || this.#writer.inTransaction) {
      throw new WorkflowRuntimeStoreError(
        'transaction_already_active',
        'WorkflowRuntimeStore cannot close during a write transaction',
      );
    }
    try {
      this.#reader.close();
      this.#writer.close();
    } finally {
      this.#releaseWriter();
      this.#releaseWriter = () => undefined;
    }
  }
}

export class WorkflowRuntimeConnectionFactory {
  private constructor() {}

  static openStore(
    options: OpenWorkflowRuntimeStoreOptions,
  ): WorkflowRuntimeStore {
    const databasePath = canonicalDatabasePath(
      options.databasePath,
      options.databaseMode,
    );
    const exists = fs.existsSync(databasePath);
    if (options.databaseMode === 'create' && exists) {
      throw new WorkflowRuntimeStoreError(
        'database_exists',
        `Refusing to bootstrap an existing database: ${databasePath}`,
      );
    }
    if (options.databaseMode === 'open_existing' && !exists) {
      throw new WorkflowRuntimeStoreError(
        'database_missing',
        `Existing Workflow Runtime database is missing: ${databasePath}`,
      );
    }
    if (writerOwners.has(databasePath)) {
      throw new WorkflowRuntimeStoreError(
        'writer_already_owned',
        `A WorkflowRuntimeStore already owns the writer for ${databasePath}`,
      );
    }
    writerOwners.add(databasePath);
    let writer: Database.Database | undefined;
    let reader: WorkflowRuntimeReadConnection | undefined;
    let fresh = false;
    try {
      if (options.databaseMode === 'create') {
        fresh = true;
        bootstrapFreshDatabase(databasePath);
      } else {
        upgradeSchemaIfEligible(databasePath);
      }
      writer = openConfiguredDatabase(databasePath, false);
      configureWriterTransientTables(writer);
      reader = this.openReadOnlyInternal(databasePath);
      const store = new WorkflowRuntimeStore(
        storeConstructorToken,
        databasePath,
        writer,
        reader,
        () => writerOwners.delete(databasePath),
      );
      ensureCapacityDefaults(store);
      return store;
    } catch (error) {
      reader?.close();
      if (writer?.open) writer.close();
      writerOwners.delete(databasePath);
      if (fresh) cleanupFreshDatabase(databasePath);
      throw error;
    }
  }

  static openReadOnly(
    options: OpenWorkflowRuntimeReadOnlyOptions,
  ): WorkflowRuntimeReadConnection {
    const databasePath = canonicalDatabasePath(
      options.databasePath,
      'read_only',
    );
    if (!fs.existsSync(databasePath)) {
      throw new WorkflowRuntimeStoreError(
        'database_missing',
        `Existing Workflow Runtime database is missing: ${databasePath}`,
      );
    }
    return this.openReadOnlyInternal(databasePath);
  }

  private static openReadOnlyInternal(
    databasePath: string,
  ): WorkflowRuntimeReadConnection {
    const database = openConfiguredDatabase(databasePath, true);
    return new ReadConnection(database);
  }
}
