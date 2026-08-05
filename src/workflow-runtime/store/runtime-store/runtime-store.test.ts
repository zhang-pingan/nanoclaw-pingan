import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureCapacityDefaults } from '../../capacity/defaults.js';
import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  readFreshWorkflowRuntimeSchemaSql,
  WORKFLOW_RUNTIME_SQLITE_CONFIG,
} from './config.js';
import {
  WorkflowRuntimeConnectionFactory,
  WorkflowRuntimeStoreError,
  type WorkflowRuntimeStore,
} from './index.js';

const roots: string[] = [];
const stores: WorkflowRuntimeStore[] = [];

function temporaryDatabase(): { root: string; databasePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-store-test-'));
  roots.push(root);
  return { root, databasePath: path.join(root, 'workflow-runtime.db') };
}

function openFresh(): WorkflowRuntimeStore {
  const { databasePath } = temporaryDatabase();
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'create',
  });
  stores.push(store);
  return store;
}

function createVersionDatabase(databasePath: string, version: number): void {
  const migrationPath = path.resolve(
    import.meta.dirname,
    version === 3
      ? '../schema/migration/workflow-runtime-schema-v1.sql'
      : `../schema/migration/workflow-runtime-schema-v${version}.sql`,
  );
  const database = new Database(databasePath);
  try {
    database.pragma(`page_size = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.pageSize}`);
    database.pragma('auto_vacuum = INCREMENTAL');
    database.exec(fs.readFileSync(migrationPath, 'utf8'));
    database.pragma(`user_version = ${version}`);
    database.pragma('journal_mode = WAL');
  } finally {
    database.close();
  }
}

function seedUncheckedRow(database: Database.Database, table: string): void {
  const columns = database.pragma(`table_info("${table}")`) as Array<{
    name: string;
    type: string;
  }>;
  const names = columns.map(({ name }) => `"${name.replaceAll('"', '""')}"`);
  const values = columns.map(({ type }) =>
    type.toUpperCase().includes('INT') ? 1 : 'migration-test',
  );
  database.pragma('foreign_keys = OFF');
  database.pragma('ignore_check_constraints = ON');
  try {
    database
      .prepare(
        `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      .run(...values);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function corruptCurrentDatabase(
  mutate: (database: Database.Database) => void,
): string {
  const { databasePath } = temporaryDatabase();
  const database = new Database(databasePath);
  try {
    database.pragma(`page_size = ${WORKFLOW_RUNTIME_SQLITE_CONFIG.pageSize}`);
    database.pragma('auto_vacuum = INCREMENTAL');
    database.exec(readFreshWorkflowRuntimeSchemaSql());
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = OFF');
    mutate(database);
  } finally {
    database.close();
  }
  return databasePath;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.isOpen) store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Workflow Runtime Store schema compatibility', () => {
  it('creates a fresh current database and usable Capacity defaults once', () => {
    const store = openFresh();
    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne<{ current_capacity_revision: number }>(
        'SELECT current_capacity_revision FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      ),
    ).toEqual({ current_capacity_revision: 1 });
    expect(ensureCapacityDefaults(store, 123)).toBe('preserved');
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM runtime_capacity_admin_commands',
        [],
      )?.count,
    ).toBe(1);
  });

  it('preserves an existing Capacity head byte-for-byte on reopen', () => {
    const store = openFresh();
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE runtime_capacity_head SET updated_at_ms = ?, row_version = ? WHERE singleton_key = 1',
        [987_654, 7],
      );
    });
    const before = store.queryOne<Record<string, unknown>>(
      'SELECT * FROM runtime_capacity_head WHERE singleton_key = 1',
      [],
    );
    const databasePath = store.databasePath;
    store.close();

    const reopened = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(reopened);
    expect(
      reopened.queryOne<Record<string, unknown>>(
        'SELECT * FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      ),
    ).toEqual(before);
  });

  it('transactionally migrates a supported Schema 10 database', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 10);
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(
      store.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM pragma_foreign_key_check',
        [],
      )?.count,
    ).toBe(0);
  });

  it('transactionally migrates an empty supported Schema 3 database', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 3);
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM pragma_foreign_key_check',
        [],
      )?.count,
    ).toBe(0);
  });

  it('rejects Schema 3 migration when activation state is not empty', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 3);
    const database = new Database(databasePath);
    try {
      seedUncheckedRow(
        database,
        'workflow_feature_release_activation_commands',
      );
    } finally {
      database.close();
    }
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
      }),
    ).toThrow('requires empty relation');
  });

  it('persists an explicit legacy metadata version once before migration', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 10);
    const legacy = new Database(databasePath);
    try {
      legacy.pragma('user_version = 0');
      legacy.exec(
        `CREATE TABLE workflow_runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO workflow_runtime_metadata (key, value) VALUES ('schema_version', '10')`,
      );
    } finally {
      legacy.close();
    }
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(
      store.queryOne<{ user_version: number }>('PRAGMA user_version', [])
        ?.user_version,
    ).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
  });

  it.each([
    ['unknown', 1, 'unknown'],
    ['newer', CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION + 1, 'newer'],
  ])(
    'rejects a %s schema version with an actionable diagnostic',
    (_, version, word) => {
      const databasePath = corruptCurrentDatabase((database) => {
        database.pragma(`user_version = ${version}`);
      });
      expect(() =>
        WorkflowRuntimeConnectionFactory.openStore({
          databasePath,
          databaseMode: 'open_existing',
        }),
      ).toThrow(word);
    },
  );

  it('rejects a database with no version and no explicit legacy metadata', () => {
    const databasePath = corruptCurrentDatabase((database) => {
      database.pragma('user_version = 0');
    });
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
      }),
    ).toThrow('no supported legacy metadata');
  });

  it.each([
    [
      'table',
      (database: Database.Database) =>
        database.exec('DROP TABLE runtime_capacity_head'),
      'missing required table runtime_capacity_head',
    ],
    [
      'column',
      (database: Database.Database) =>
        database.exec(
          'ALTER TABLE runtime_capacity_head RENAME COLUMN row_version TO removed_row_version',
        ),
      'missing required column runtime_capacity_head.row_version',
    ],
    [
      'index',
      (database: Database.Database) =>
        database.exec('DROP INDEX "idx:capacity_head:singleton"'),
      'missing required index idx:capacity_head:singleton',
    ],
  ])(
    'rejects a current database with a missing required %s',
    (_, mutate, message) => {
      const databasePath = corruptCurrentDatabase(mutate);
      expect(() =>
        WorkflowRuntimeConnectionFactory.openStore({
          databasePath,
          databaseMode: 'open_existing',
        }),
      ).toThrow(message);
    },
  );
});

describe('Workflow Runtime Store connection boundary', () => {
  it('rejects invalid paths and duplicate writers', () => {
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath: ':memory:',
        databaseMode: 'create',
      }),
    ).toThrowError(WorkflowRuntimeStoreError);

    const store = openFresh();
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath: store.databasePath,
        databaseMode: 'open_existing',
      }),
    ).toThrow('already owns the writer');
  });

  it('commits synchronous transactions and rolls back failures', () => {
    const store = openFresh();
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE runtime_capacity_head SET updated_at_ms = ?, row_version = ? WHERE singleton_key = 1',
        [2, 2],
      );
    });
    expect(
      store.queryOne<{ updated_at_ms: number }>(
        'SELECT updated_at_ms FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      )?.updated_at_ms,
    ).toBe(2);

    expect(() =>
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          'UPDATE runtime_capacity_head SET updated_at_ms = ?, row_version = ? WHERE singleton_key = 1',
          [3, 3],
        );
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(
      store.queryOne<{ updated_at_ms: number }>(
        'SELECT updated_at_ms FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      )?.updated_at_ms,
    ).toBe(2);
  });

  it('opens a query-only reader and rejects writes through the read API', () => {
    const store = openFresh();
    const reader = WorkflowRuntimeConnectionFactory.openReadOnly({
      databasePath: store.databasePath,
    });
    expect(
      reader.queryOne<{ query_only: number }>('PRAGMA query_only', [])
        ?.query_only,
    ).toBe(1);
    expect(() => reader.queryAll('DELETE FROM workflows', [])).toThrow(
      'row-returning',
    );
    reader.close();
  });
});
