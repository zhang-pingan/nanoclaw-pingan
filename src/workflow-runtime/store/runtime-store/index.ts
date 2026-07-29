import fs from 'fs';
import path from 'path';
import { types as utilTypes } from 'node:util';

import Database from 'better-sqlite3';

import { calculateDatabaseSqliteSchemaIdentity } from '../schema/database-identity.js';
import {
  assertRuntimeHostIdentity,
  collectWorkflowRuntimeIdentityEvidence,
  type WorkflowRuntimeIdentityEvidence,
  type WorkflowRuntimeIdentityMode,
} from './identity.js';
import {
  loadFrozenWorkflowRuntimeStoreInputs,
  type FrozenWorkflowRuntimeStoreInputs,
} from './profile.js';
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
  readonly identityMode: WorkflowRuntimeIdentityMode;
}

export interface OpenWorkflowRuntimeReadOnlyOptions {
  readonly databasePath: string;
  readonly identityMode: WorkflowRuntimeIdentityMode;
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

function verifyDatabaseLevelProfile(
  database: Database.Database,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
): void {
  const profile = inputs.profile;
  assertEqual(
    String(scalarPragma(database, 'journal_mode')).toLowerCase(),
    profile.journal_mode,
    'journal_mode',
  );
  assertEqual(
    Number(scalarPragma(database, 'page_size')),
    profile.page_size,
    'page_size',
  );
  assertEqual(Number(scalarPragma(database, 'auto_vacuum')), 2, 'auto_vacuum');
}

function configureConnection(
  database: Database.Database,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
  readOnly: boolean,
): void {
  const profile = inputs.profile;
  if (!readOnly) {
    database.pragma('journal_mode = WAL');
  }
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${profile.busy_timeout_ms}`);
  database.pragma('temp_store = MEMORY');
  database.pragma(`wal_autocheckpoint = ${profile.wal_autocheckpoint_pages}`);
  database.pragma(`journal_size_limit = ${profile.journal_size_limit_bytes}`);
  database.pragma(`cache_size = -${profile.cache_size_kib}`);
  database.pragma(`mmap_size = ${profile.mmap_size_bytes}`);
  database.pragma('trusted_schema = OFF');
  database.pragma('recursive_triggers = OFF');
  database.pragma('read_uncommitted = OFF');
  database.pragma('locking_mode = NORMAL');
  database.pragma(`query_only = ${readOnly ? 'ON' : 'OFF'}`);
}

function verifyCompleteProfile(
  database: Database.Database,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
  readOnly: boolean,
): void {
  const profile = inputs.profile;
  verifyDatabaseLevelProfile(database, inputs);
  const expected: Array<[string, string | number]> = [
    ['synchronous', 2],
    ['foreign_keys', 1],
    ['busy_timeout', profile.busy_timeout_ms],
    ['temp_store', 2],
    ['wal_autocheckpoint', profile.wal_autocheckpoint_pages],
    ['journal_size_limit', profile.journal_size_limit_bytes],
    ['cache_size', -profile.cache_size_kib],
    ['mmap_size', profile.mmap_size_bytes],
    ['trusted_schema', 0],
    ['recursive_triggers', 0],
    ['read_uncommitted', 0],
    ['locking_mode', profile.locking_mode],
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

function verifyFrozenSchema(
  database: Database.Database,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
): void {
  try {
    assertEqual(
      Number(scalarPragma(database, 'user_version')),
      inputs.schemaManifest.database_schema_version,
      'user_version',
    );
    const observed = calculateDatabaseSqliteSchemaIdentity(database);
    if (observed !== inputs.sqliteSchemaIdentity) {
      throw new Error(
        `sqlite_schema identity mismatch: expected ${inputs.sqliteSchemaIdentity}, received ${observed}`,
      );
    }
  } catch (error) {
    throw new WorkflowRuntimeStoreError(
      'database_schema_mismatch',
      `workflow-runtime.db schema does not match frozen G1.1: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function upgradeSchemaIfEligible(
  databasePath: string,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
): void {
  const database = new Database(databasePath, {
    fileMustExist: true,
    timeout: inputs.profile.busy_timeout_ms,
  });
  try {
    verifyDatabaseLevelProfile(database, inputs);
    const version = Number(scalarPragma(database, 'user_version'));
    if (version === inputs.schemaManifest.database_schema_version) return;
    if (
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6 &&
      version !== 7 &&
      version !== 8 &&
      version !== 9 &&
      version !== 10
    ) {
      throw new WorkflowRuntimeStoreError(
        'database_schema_mismatch',
        `Schema upgrade requires user_version 3, 4, 5, 6, 7, 8, 9, 10, or ${inputs.schemaManifest.database_schema_version}, received ${version}`,
      );
    }
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      if (version === 3) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema3SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 3 sqlite_schema identity mismatch: expected ${inputs.schema3SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
        for (const relation of inputs.schema3RequiredEmptyRelations) {
          const count = database
            .prepare(`SELECT count(*) AS count FROM "${relation}"`)
            .pluck()
            .get() as number;
          if (count !== 0) {
            throw new Error(
              `Schema 3 upgrade requires empty relation ${relation}, received ${count} row(s)`,
            );
          }
        }
        database.exec(inputs.schema3To4UpgradeSql);
        if (
          Number(scalarPragma(database, 'user_version')) !== 4 ||
          calculateDatabaseSqliteSchemaIdentity(database) !==
            inputs.schema4SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            'Schema 3 to 4 upgrade did not produce frozen historical Schema 4',
          );
        }
      } else if (version === 4) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema4SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 4 sqlite_schema identity mismatch: expected ${inputs.schema4SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version === 3 || version === 4) {
        database.exec(inputs.schema4To5UpgradeSql);
        if (
          Number(scalarPragma(database, 'user_version')) !== 5 ||
          calculateDatabaseSqliteSchemaIdentity(database) !==
            inputs.schema5SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 5 upgrade did not produce frozen historical Schema 5`,
          );
        }
      } else if (version === 5) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema5SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 5 sqlite_schema identity mismatch: expected ${inputs.schema5SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version === 3 || version === 4 || version === 5) {
        database.exec(inputs.schema5To6UpgradeSql);
        if (
          Number(scalarPragma(database, 'user_version')) !== 6 ||
          calculateDatabaseSqliteSchemaIdentity(database) !==
            inputs.schema6SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 6 upgrade did not produce frozen historical Schema 6`,
          );
        }
      } else if (version === 6) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema6SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 6 sqlite_schema identity mismatch: expected ${inputs.schema6SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version < 7) {
        database.exec(inputs.schema6To7UpgradeSql);
        const schema7Version = Number(scalarPragma(database, 'user_version'));
        const schema7Identity = calculateDatabaseSqliteSchemaIdentity(database);
        if (
          schema7Version !== 7 ||
          schema7Identity !== inputs.schema7SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 7 upgrade did not produce frozen Schema 7: expected identity ${inputs.schema7SourceSqliteSchemaIdentity}, received version ${schema7Version} identity ${schema7Identity}`,
          );
        }
      } else if (version === 7) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema7SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 7 sqlite_schema identity mismatch: expected ${inputs.schema7SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version < 8) {
        database.exec(inputs.schema7To8UpgradeSql);
        const schema8Version = Number(scalarPragma(database, 'user_version'));
        const schema8Identity = calculateDatabaseSqliteSchemaIdentity(database);
        if (
          schema8Version !== 8 ||
          schema8Identity !== inputs.schema8SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 8 upgrade did not produce frozen Schema 8: expected identity ${inputs.schema8SourceSqliteSchemaIdentity}, received version ${schema8Version} identity ${schema8Identity}`,
          );
        }
      } else if (version === 8) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema8SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 8 sqlite_schema identity mismatch: expected ${inputs.schema8SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version < 9) {
        database.exec(inputs.schema8To9UpgradeSql);
        const schema9Version = Number(scalarPragma(database, 'user_version'));
        const schema9Identity = calculateDatabaseSqliteSchemaIdentity(database);
        if (
          schema9Version !== 9 ||
          schema9Identity !== inputs.schema9SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 9 upgrade did not produce frozen Schema 9: expected identity ${inputs.schema9SourceSqliteSchemaIdentity}, received version ${schema9Version} identity ${schema9Identity}`,
          );
        }
      } else if (version === 9) {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema9SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 9 sqlite_schema identity mismatch: expected ${inputs.schema9SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      if (version < 10) {
        database.exec(inputs.schema9To10UpgradeSql);
        const schema10Version = Number(scalarPragma(database, 'user_version'));
        const schema10Identity =
          calculateDatabaseSqliteSchemaIdentity(database);
        if (
          schema10Version !== 10 ||
          schema10Identity !== inputs.schema10SourceSqliteSchemaIdentity
        ) {
          throw new Error(
            `Schema ${version} to 10 upgrade did not produce frozen Schema 10: expected identity ${inputs.schema10SourceSqliteSchemaIdentity}, received version ${schema10Version} identity ${schema10Identity}`,
          );
        }
      } else {
        const sourceIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        if (sourceIdentity !== inputs.schema10SourceSqliteSchemaIdentity) {
          throw new Error(
            `Schema 10 sqlite_schema identity mismatch: expected ${inputs.schema10SourceSqliteSchemaIdentity}, received ${sourceIdentity}`,
          );
        }
      }
      database.exec(inputs.schema10To11UpgradeSql);
      const upgradedVersion = Number(scalarPragma(database, 'user_version'));
      const upgradedIdentity = calculateDatabaseSqliteSchemaIdentity(database);
      if (
        upgradedVersion !== inputs.schemaManifest.database_schema_version ||
        upgradedIdentity !== inputs.sqliteSchemaIdentity
      ) {
        throw new Error(
          `Schema ${version} to 11 upgrade did not produce current Schema 11: expected version ${inputs.schemaManifest.database_schema_version} identity ${inputs.sqliteSchemaIdentity}, received version ${upgradedVersion} identity ${upgradedIdentity}`,
        );
      }
      verifyIntegrity(database);
      database.exec('COMMIT');
      database.pragma('foreign_keys = ON');
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      database.pragma('foreign_keys = ON');
      throw error;
    }
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

function bootstrapFreshDatabase(
  databasePath: string,
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
): void {
  const profile = inputs.profile;
  const bootstrap = new Database(databasePath, {
    timeout: profile.busy_timeout_ms,
  });
  try {
    bootstrap.pragma(`page_size = ${profile.page_size}`);
    bootstrap.pragma('auto_vacuum = INCREMENTAL');
    assertEqual(
      Number(scalarPragma(bootstrap, 'page_size')),
      profile.page_size,
      'bootstrap page_size',
    );
    assertEqual(
      Number(scalarPragma(bootstrap, 'auto_vacuum')),
      2,
      'bootstrap auto_vacuum',
    );
    bootstrap.pragma('foreign_keys = ON');
    bootstrap.exec(inputs.migrationSql);
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
  inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
  readOnly: boolean,
): Database.Database {
  const database = new Database(databasePath, {
    readonly: readOnly,
    fileMustExist: true,
    timeout: inputs.profile.busy_timeout_ms,
  });
  try {
    // Existing databases are verified before any profile-setting PRAGMA is issued.
    verifyDatabaseLevelProfile(database, inputs);
    configureConnection(database, inputs, readOnly);
    verifyCompleteProfile(database, inputs, readOnly);
    verifyIntegrity(database);
    verifyFrozenSchema(database, inputs);
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
  readonly identityEvidence: WorkflowRuntimeIdentityEvidence;
  readonly frozenInputs: Readonly<FrozenWorkflowRuntimeStoreInputs>;
  #writer: Database.Database;
  #reader: WorkflowRuntimeReadConnection;
  #releaseWriter: () => void;
  #transactionActive = false;

  constructor(
    token: symbol,
    databasePath: string,
    writer: Database.Database,
    reader: WorkflowRuntimeReadConnection,
    identityEvidence: WorkflowRuntimeIdentityEvidence,
    frozenInputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
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
    this.identityEvidence = identityEvidence;
    this.frozenInputs = frozenInputs;
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
    const inputs = loadFrozenWorkflowRuntimeStoreInputs();
    assertRuntimeHostIdentity(inputs.profile, options.identityMode);
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
        bootstrapFreshDatabase(databasePath, inputs);
      } else {
        upgradeSchemaIfEligible(databasePath, inputs);
      }
      writer = openConfiguredDatabase(databasePath, inputs, false);
      const identityEvidence = collectWorkflowRuntimeIdentityEvidence(
        writer,
        inputs.profile,
        options.identityMode,
      );
      reader = this.openReadOnlyInternal(
        databasePath,
        inputs,
        options.identityMode,
      );
      return new WorkflowRuntimeStore(
        storeConstructorToken,
        databasePath,
        writer,
        reader,
        identityEvidence,
        inputs,
        () => writerOwners.delete(databasePath),
      );
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
    const inputs = loadFrozenWorkflowRuntimeStoreInputs();
    assertRuntimeHostIdentity(inputs.profile, options.identityMode);
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
    return this.openReadOnlyInternal(
      databasePath,
      inputs,
      options.identityMode,
    );
  }

  private static openReadOnlyInternal(
    databasePath: string,
    inputs: Readonly<FrozenWorkflowRuntimeStoreInputs>,
    identityMode: WorkflowRuntimeIdentityMode,
  ): WorkflowRuntimeReadConnection {
    const database = openConfiguredDatabase(databasePath, inputs, true);
    try {
      collectWorkflowRuntimeIdentityEvidence(
        database,
        inputs.profile,
        identityMode,
      );
      return new ReadConnection(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
