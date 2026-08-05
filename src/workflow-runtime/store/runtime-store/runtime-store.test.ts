import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureCapacityDefaults } from '../../capacity/defaults.js';
import {
  calculateRegistrySnapshotHash,
  G3_REGISTRY_SNAPSHOT_DOMAIN,
} from '../../contracts/g3-registry-persistence.js';
import { domainSeparatedSha256 } from '../../contracts/hash.js';
import type { Sha256Hash } from '../../contracts/types.js';
import { WORKFLOW_COMPILER_VERSION } from '../../compiler/version.js';
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

const MIGRATION_HASH = `sha256:${'a'.repeat(64)}` as Sha256Hash;
const MIGRATION_SCHEMA_HASH = `sha256:${'b'.repeat(64)}` as Sha256Hash;
const MIGRATION_CLOSURE_HASH = `sha256:${'c'.repeat(64)}` as Sha256Hash;

function seedSchema11PreservedState(databasePath: string): {
  oldSnapshotHash: Sha256Hash;
  newSnapshotHash: Sha256Hash;
} {
  const snapshotRef = { id: 'migration.definition', version: '1.0.0' };
  const closureRef = { id: 'migration.definition', version: '1.0.0' };
  const oldSnapshotHash = domainSeparatedSha256(G3_REGISTRY_SNAPSHOT_DOMAIN, {
    format: 'icarus.workflow-registry-snapshot/1',
    ref: snapshotRef,
    closure_ref: closureRef,
    closure_hash: MIGRATION_CLOSURE_HASH,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    core_build_hash: MIGRATION_HASH,
    database_schema_hash: MIGRATION_SCHEMA_HASH,
  });
  const newSnapshotHash = calculateRegistrySnapshotHash({
    format: 'icarus.workflow-registry-snapshot/1',
    ref: snapshotRef,
    closure_ref: closureRef,
    closure_hash: MIGRATION_CLOSURE_HASH,
    compiler_version: WORKFLOW_COMPILER_VERSION,
  });
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN');
    const insertValue = database.prepare(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, created_at_ms, row_version,
         schema_authority_kind
       ) VALUES (?, 'inline', '{}', ?, 2, 'application/json', ?, ?,
                 'migration-test', 'pinned', 'live', 1, 1, 'registry')`,
    );
    insertValue.run(
      'value:migration-schema',
      MIGRATION_SCHEMA_HASH,
      'registry-resource:schema:migration.schema@1.0.0',
      MIGRATION_SCHEMA_HASH,
    );
    database
      .prepare(
        `INSERT INTO workflow_registry_resources (
           id, resource_type, resource_id, resource_version, owner_core_ref,
           canonical_value_id, content_hash, publication_state, created_at_ms,
           published_at_ms, row_version
         ) VALUES (?, 'schema', 'migration.schema', '1.0.0', 'icarus.core@local',
                   ?, ?, 'published', 1, 1, 1)`,
      )
      .run(
        'registry-resource:schema:migration.schema@1.0.0',
        'value:migration-schema',
        MIGRATION_SCHEMA_HASH,
      );
    insertValue.run(
      'value:migration-definition',
      MIGRATION_HASH,
      'registry-resource:schema:migration.schema@1.0.0',
      MIGRATION_SCHEMA_HASH,
    );
    database
      .prepare(
        `INSERT INTO workflow_registry_resources (
           id, resource_type, resource_id, resource_version, owner_core_ref,
           canonical_value_id, content_hash, publication_state, created_at_ms,
           published_at_ms, row_version
         ) VALUES (?, 'definition', 'migration.definition', '1.0.0',
                   'icarus.core@local', ?, ?, 'published', 1, 1, 1)`,
      )
      .run(
        'registry-resource:definition:migration.definition@1.0.0',
        'value:migration-definition',
        MIGRATION_HASH,
      );
    insertValue.run(
      'value:migration-closure',
      MIGRATION_CLOSURE_HASH,
      'registry-resource:schema:migration.schema@1.0.0',
      MIGRATION_SCHEMA_HASH,
    );
    database
      .prepare(
        `INSERT INTO workflow_registry_closure_manifests (
           id, closure_hash, manifest_value_id, manifest_hash, created_at_ms
         ) VALUES (?, ?, 'value:migration-closure', ?, 1)`,
      )
      .run(
        'registry-closure:migration.definition@1.0.0',
        MIGRATION_CLOSURE_HASH,
        MIGRATION_CLOSURE_HASH,
      );
    database
      .prepare(
        `INSERT INTO workflow_registry_snapshots (
           id, snapshot_hash, closure_manifest_id, closure_hash,
           compiler_version, core_build_hash, database_schema_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        'registry-snapshot:migration.definition@1.0.0',
        oldSnapshotHash,
        'registry-closure:migration.definition@1.0.0',
        MIGRATION_CLOSURE_HASH,
        WORKFLOW_COMPILER_VERSION,
        MIGRATION_HASH,
        MIGRATION_SCHEMA_HASH,
      );
    database.exec(
      `INSERT INTO runtime_capacity_head (
         singleton_key, current_capacity_revision, current_change_id,
         current_config_hash, current_publication_hash, pending_change_id,
         row_version, created_at_ms, updated_at_ms
       ) VALUES (1, NULL, NULL, NULL, NULL, NULL, 7, 11, 12)`,
    );
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  return { oldSnapshotHash, newSnapshotHash };
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

  it('migrates Schema 11 while preserving Registry, definition, and Capacity state', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 11);
    const { oldSnapshotHash, newSnapshotHash } =
      seedSchema11PreservedState(databasePath);
    expect(oldSnapshotHash).not.toBe(newSnapshotHash);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(store.schemaVersion).toBe(12);
    expect(
      store.queryOne<{ snapshot_hash: string }>(
        'SELECT snapshot_hash FROM workflow_registry_snapshots WHERE id = ?',
        ['registry-snapshot:migration.definition@1.0.0'],
      ),
    ).toEqual({ snapshot_hash: newSnapshotHash });
    expect(
      store.queryOne<{ publication_state: string }>(
        'SELECT publication_state FROM workflow_registry_resources WHERE id = ?',
        ['registry-resource:definition:migration.definition@1.0.0'],
      ),
    ).toEqual({ publication_state: 'published' });
    expect(
      store.queryOne<{ row_version: number; updated_at_ms: number }>(
        'SELECT row_version, updated_at_ms FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      ),
    ).toEqual({ row_version: 7, updated_at_ms: 12 });
  });

  it('rejects Schema 11 with persisted Runs and rolls back', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 11);
    const database = new Database(databasePath);
    try {
      seedUncheckedRow(database, 'workflow_graph_runs');
    } finally {
      database.close();
    }
    expect(() =>
      WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'open_existing',
      }),
    ).toThrow('does not support persisted Workflow Runs; found 1 row(s)');
    const unchanged = new Database(databasePath, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(11);
      expect(
        unchanged
          .prepare('SELECT count(*) FROM workflow_graph_runs')
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      unchanged.close();
    }
  });

  it('creates Schema 12 without obsolete snapshot or Run identity columns', () => {
    const store = openFresh();
    const columns = (table: string) =>
      store
        .queryAll<{ name: string }>(`PRAGMA table_info("${table}")`, [])
        .map(({ name }) => name);
    expect(columns('workflow_registry_snapshots')).not.toEqual(
      expect.arrayContaining(['core_build_hash', 'database_schema_hash']),
    );
    expect(columns('workflow_graph_runs')).not.toEqual(
      expect.arrayContaining([
        'compiler_toolchain_resource_id',
        'core_release_hash',
        'core_build_hash',
        'run_protocol_major',
        'executor_abi_major',
        'database_schema_version',
        'database_schema_hash',
      ]),
    );
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
    [
      'obsolete column',
      (database: Database.Database) =>
        database.exec(
          'ALTER TABLE workflow_graph_runs ADD COLUMN database_schema_hash TEXT',
        ),
      'contains obsolete column workflow_graph_runs.database_schema_hash',
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
