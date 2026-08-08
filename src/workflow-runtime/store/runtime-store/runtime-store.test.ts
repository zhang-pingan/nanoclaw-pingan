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

function seedSchema12PreservedState(databasePath: string): {
  featureRelease: Record<string, unknown>;
  activeRelease: Record<string, unknown>;
  retentionHandle: Record<string, unknown>;
  activationCommand: Record<string, unknown>;
  capacityCommand: Record<string, unknown>;
  capacityHead: Record<string, unknown>;
  capacityEvent: Record<string, unknown>;
} {
  const featureReleaseId = 'feature-release:migration.feature@1.0.0';
  const closureId = 'registry-closure:migration.feature@1.0.0';
  const schemaResourceId = 'registry-resource:schema:migration.schema@1.0.0';
  const database = new Database(databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN');
    database
      .prepare(
        `INSERT INTO workflow_values (
           id, storage_kind, inline_canonical_json, content_hash, byte_length,
           media_type, schema_resource_id, schema_resource_hash, provenance_ref,
           retention_class, payload_state, created_at_ms, row_version,
           schema_authority_kind
         ) VALUES (?, 'inline', '{}', ?, 2, 'application/json', ?, ?,
                   'schema-12-migration-test', 'pinned', 'live', 17, 1,
                   'registry')`,
      )
      .run(
        'value:schema-12-migration',
        MIGRATION_SCHEMA_HASH,
        schemaResourceId,
        MIGRATION_SCHEMA_HASH,
      );
    database
      .prepare(
        `INSERT INTO workflow_registry_resources (
           id, resource_type, resource_id, resource_version, owner_core_ref,
           canonical_value_id, content_hash, publication_state, created_at_ms,
           published_at_ms, row_version
         ) VALUES (?, 'schema', 'migration.schema', '1.0.0',
                   'icarus.core@local', ?, ?, 'published', 17, 18, 2)`,
      )
      .run(
        schemaResourceId,
        'value:schema-12-migration',
        MIGRATION_SCHEMA_HASH,
      );
    const insertValue = database.prepare(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, created_at_ms, row_version,
         schema_authority_kind
       ) VALUES (?, 'inline', '{}', ?, 2, 'application/json', ?, ?,
                 'schema-12-migration-test', 'pinned', 'live', 19, 1,
                 'registry')`,
    );
    insertValue.run(
      'value:schema-12-closure',
      MIGRATION_CLOSURE_HASH,
      schemaResourceId,
      MIGRATION_SCHEMA_HASH,
    );
    insertValue.run(
      'value:schema-12-request',
      MIGRATION_HASH,
      schemaResourceId,
      MIGRATION_SCHEMA_HASH,
    );
    database
      .prepare(
        `INSERT INTO workflow_registry_closure_manifests (
           id, closure_hash, manifest_value_id, manifest_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, 20)`,
      )
      .run(
        closureId,
        MIGRATION_CLOSURE_HASH,
        'value:schema-12-closure',
        MIGRATION_CLOSURE_HASH,
      );
    database
      .prepare(
        `INSERT INTO workflow_feature_releases (
           id, feature_id, release_ref, release_version, release_hash,
           execution_artifact_resource_id, execution_artifact_hash, status,
           compatibility_snapshot_ref, compatibility_snapshot_hash,
           staged_at_ms, activated_at_ms, disabled_at_ms, row_version
         ) VALUES (?, 'migration.feature', 'migration.feature', '1.0.0', ?,
                   NULL, NULL, 'active', 'legacy-compatibility', ?, 21, 22,
                   NULL, 4)`,
      )
      .run(featureReleaseId, MIGRATION_HASH, MIGRATION_SCHEMA_HASH);
    database
      .prepare(
        `INSERT INTO workflow_feature_active_releases (
           feature_id, release_id, release_hash, row_version, activated_at_ms
         ) VALUES ('migration.feature', ?, ?, 1, 22)`,
      )
      .run(featureReleaseId, MIGRATION_HASH);
    database
      .prepare(
        `INSERT INTO workflow_registry_retention_handles (
           id, handle_kind, feature_release_id, graph_run_id, backup_id,
           external_actor_ref, closure_manifest_id, closure_hash, status,
           created_at_ms, released_at_ms, row_version
         ) VALUES ('retention:migration.feature@1.0.0', 'published', ?, NULL,
                   NULL, NULL, ?, ?, 'held', 23, NULL, 6)`,
      )
      .run(featureReleaseId, closureId, MIGRATION_CLOSURE_HASH);
    database
      .prepare(
        `INSERT INTO workflow_feature_release_activation_commands (
           command_id, command_type, idempotency_domain, idempotency_key,
           request_value_id, request_hash, request_schema_resource_id,
           request_schema_hash, domain_request_hash,
           verified_compatibility_input_value_id,
           verified_compatibility_input_hash,
           verified_compatibility_input_schema_resource_id,
           verified_compatibility_input_schema_hash,
           verified_compatibility_result_value_id,
           verified_compatibility_result_hash,
           verified_compatibility_result_schema_resource_id,
           verified_compatibility_result_schema_hash,
           lifecycle, created_at_ms, finalized_at_ms, row_version
         ) VALUES ('activation-command:migration', 'activate_feature_release',
                   'migration', 'activation', 'value:schema-12-request', ?, ?,
                   ?, ?, 'value:schema-12-request', ?, ?, ?,
                   'value:schema-12-request', ?, ?, ?, 'pending', 24, NULL, 1)`,
      )
      .run(
        MIGRATION_HASH,
        schemaResourceId,
        MIGRATION_SCHEMA_HASH,
        MIGRATION_CLOSURE_HASH,
        MIGRATION_HASH,
        schemaResourceId,
        MIGRATION_SCHEMA_HASH,
        MIGRATION_HASH,
        schemaResourceId,
        MIGRATION_SCHEMA_HASH,
      );
    database
      .prepare(
        `INSERT INTO runtime_capacity_admin_commands (
           command_id, idempotency_domain, idempotency_key, command_type,
           expected_capacity_revision, expected_config_hash,
           assigned_capacity_revision, assigned_change_id,
           genesis_core_release_hash, proposed_capacity_json,
           proposed_config_hash, request_hash, reason_code,
           reason_text_value_id, reason_text_hash, evidence_manifest_value_id,
           evidence_manifest_hash, canonical_result_value_id,
           canonical_result_hash, created_at_ms, finalized_at_ms
         ) VALUES ('capacity-command:migration', 'migration', 'capacity',
                   'initialize_deployment_capacity', NULL, NULL, 7,
                   'capacity-change:migration', ?, '{}', ?, ?,
                   'initial_provisioning', NULL, NULL,
                   'value:schema-12-request', ?, NULL, NULL, 25, NULL)`,
      )
      .run(
        MIGRATION_SCHEMA_HASH,
        MIGRATION_HASH,
        MIGRATION_CLOSURE_HASH,
        MIGRATION_HASH,
      );
    database
      .prepare(
        `INSERT INTO runtime_capacity_head (
           singleton_key, current_capacity_revision, current_change_id,
           current_config_hash, current_publication_hash, pending_change_id,
           row_version, created_at_ms, updated_at_ms
         ) VALUES (1, 7, 'capacity-change:migration', ?, ?, NULL, 8, 25, 26)`,
      )
      .run(MIGRATION_HASH, MIGRATION_SCHEMA_HASH);
    database
      .prepare(
        `INSERT INTO runtime_capacity_change_events (
           event_seq, change_id, command_id, capacity_revision, event_type,
           config_hash, publication_hash, previous_event_hash, event_hash,
           detail_value_id, detail_hash, created_at_ms
         ) VALUES (1, 'capacity-change:migration', 'capacity-command:migration',
                   7, 'head_committed', ?, ?, NULL, ?, NULL, NULL, 26)`,
      )
      .run(MIGRATION_HASH, MIGRATION_SCHEMA_HASH, MIGRATION_CLOSURE_HASH);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }

  const selectOne = (sql: string): Record<string, unknown> =>
    database.prepare(sql).get() as Record<string, unknown>;
  const state = {
    featureRelease: selectOne(
      `SELECT id, feature_id, release_ref, release_version, release_hash,
              execution_artifact_resource_id, execution_artifact_hash, status,
              staged_at_ms, activated_at_ms, disabled_at_ms, row_version
         FROM workflow_feature_releases`,
    ),
    activeRelease: selectOne('SELECT * FROM workflow_feature_active_releases'),
    retentionHandle: selectOne(
      'SELECT * FROM workflow_registry_retention_handles',
    ),
    activationCommand: selectOne(
      `SELECT command_id, command_type, idempotency_domain, idempotency_key,
              request_value_id, request_hash, request_schema_resource_id,
              request_schema_hash, domain_request_hash, lifecycle,
              created_at_ms, finalized_at_ms, row_version
         FROM workflow_feature_release_activation_commands`,
    ),
    capacityCommand: selectOne(
      `SELECT command_id, idempotency_domain, idempotency_key, command_type,
              expected_capacity_revision, expected_config_hash,
              assigned_capacity_revision, assigned_change_id,
              proposed_capacity_json, proposed_config_hash, request_hash,
              reason_code, reason_text_value_id, reason_text_hash,
              evidence_manifest_value_id, evidence_manifest_hash,
              canonical_result_value_id, canonical_result_hash, created_at_ms,
              finalized_at_ms
         FROM runtime_capacity_admin_commands`,
    ),
    capacityHead: selectOne('SELECT * FROM runtime_capacity_head'),
    capacityEvent: selectOne('SELECT * FROM runtime_capacity_change_events'),
  };
  database.close();
  return state;
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
    expect(
      store.queryOne<{ legacy_alter_table: number }>(
        'PRAGMA legacy_alter_table',
        [],
      )?.legacy_alter_table,
    ).toBe(0);
    const namedIndexes = new Set(
      store
        .queryAll<{ name: string }>(
          `SELECT name FROM sqlite_schema
            WHERE type = 'index' AND sql IS NOT NULL`,
          [],
        )
        .map(({ name }) => name),
    );
    for (const index of [
      'uk:feature_releases:id_hash',
      'uk:feature_releases:owner_identity',
      'uk:activation_commands:id_domain_request',
      'uk:activation_commands:idempotency',
      'uk:capacity_commands:assigned_lineage',
      'uk:capacity_commands:assigned_change',
      'uk:capacity_commands:idempotency',
    ]) {
      expect(namedIndexes.has(index), `missing migrated index ${index}`).toBe(
        true,
      );
    }
  });

  it('migrates Schema 15 closed enums without retargeting rebuilt foreign keys', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 15);
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);

    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    const activationSql = store.queryOne<{ sql: string }>(
      `SELECT sql FROM sqlite_schema
        WHERE type = 'table' AND name = 'workflow_state_activations'`,
      [],
    )!.sql;
    const eventSql = store.queryOne<{ sql: string }>(
      `SELECT sql FROM sqlite_schema
        WHERE type = 'table' AND name = 'workflow_graph_events'`,
      [],
    )!.sql;
    expect(activationSql).toContain("'normal', 'errored', 'cancelled'");
    for (const eventType of [
      'provider_cancellation_requested',
      'provider_cancellation_retry_scheduled',
      'provider_cancellation_acknowledged',
      'provider_cancellation_not_required',
    ]) {
      expect(eventSql).toContain(`'${eventType}'`);
    }
    for (const table of [
      'workflow_state_activations',
      'workflow_graph_events',
      'workflow_provider_cancellation_requests',
    ]) {
      const foreignKeys = store.queryAll<{ table: string }>(
        `PRAGMA foreign_key_list('${table}')`,
        [],
      );
      expect(foreignKeys.length).toBeGreaterThan(0);
      expect(
        foreignKeys.every((foreignKey) => !foreignKey.table.endsWith('_v15')),
      ).toBe(true);
    }
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM pragma_foreign_key_check',
        [],
      ),
    ).toEqual({ count: 0 });
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
    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
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

  it('migrates nonempty Schema 12 state without altering retained fields', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 12);
    const before = seedSchema12PreservedState(databasePath);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne(
        'SELECT id, feature_id, release_ref, release_version, release_hash, execution_artifact_resource_id, execution_artifact_hash, status, staged_at_ms, activated_at_ms, disabled_at_ms, row_version FROM workflow_feature_releases',
        [],
      ),
    ).toEqual(before.featureRelease);
    expect(
      store.queryOne('SELECT * FROM workflow_feature_active_releases', []),
    ).toEqual(before.activeRelease);
    expect(
      store.queryOne('SELECT * FROM workflow_registry_retention_handles', []),
    ).toEqual(before.retentionHandle);
    expect(
      store.queryOne(
        'SELECT command_id, command_type, idempotency_domain, idempotency_key, request_value_id, request_hash, request_schema_resource_id, request_schema_hash, domain_request_hash, lifecycle, created_at_ms, finalized_at_ms, row_version FROM workflow_feature_release_activation_commands',
        [],
      ),
    ).toEqual(before.activationCommand);
    expect(
      store.queryOne(
        'SELECT command_id, idempotency_domain, idempotency_key, command_type, expected_capacity_revision, expected_config_hash, assigned_capacity_revision, assigned_change_id, proposed_capacity_json, proposed_config_hash, request_hash, reason_code, reason_text_value_id, reason_text_hash, evidence_manifest_value_id, evidence_manifest_hash, canonical_result_value_id, canonical_result_hash, created_at_ms, finalized_at_ms FROM runtime_capacity_admin_commands',
        [],
      ),
    ).toEqual(before.capacityCommand);
    expect(store.queryOne('SELECT * FROM runtime_capacity_head', [])).toEqual(
      before.capacityHead,
    );
    expect(
      store.queryOne('SELECT * FROM runtime_capacity_change_events', []),
    ).toEqual(before.capacityEvent);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM pragma_foreign_key_check',
        [],
      )?.count,
    ).toBe(0);
  });

  it('migrates Schema 13 intake state and enables task_workspace intake source', () => {
    const { databasePath } = temporaryDatabase();
    createVersionDatabase(databasePath, 13);
    const legacy = new Database(databasePath);
    const contentHash = `sha256:${'d'.repeat(64)}`;
    const revisionHash = `sha256:${'e'.repeat(64)}`;
    try {
      legacy.pragma('foreign_keys = ON');
      legacy.transaction(() => {
        legacy
          .prepare(
            `INSERT INTO workflow_registry_resources (
               id, resource_type, resource_id, resource_version,
               owner_core_ref, owner_feature_id, canonical_value_id,
               content_hash, publication_state, created_at_ms,
               published_at_ms, retired_at_ms, row_version
             ) VALUES (?, 'schema', 'migration.intake', '1.0.0',
                       'icarus.core@migration', NULL, ?, ?, 'published',
                       100, 100, NULL, 1)`,
          )
          .run(
            'registry-resource:migration-intake',
            'value:migration-intake',
            contentHash,
          );
        legacy
          .prepare(
            `INSERT INTO workflow_values (
               id, storage_kind, inline_canonical_json, blob_hash,
               immutable_external_locator, expected_hash, content_hash,
               byte_length, media_type, schema_resource_id,
               schema_resource_hash, provenance_ref, retention_class,
               payload_state, payload_pruned_at_ms, created_at_ms, row_version
             ) VALUES (?, 'inline', '{}', NULL, NULL, NULL, ?, 2,
                       'application/json', ?, ?, 'migration-test', 'pinned',
                       'live', NULL, 100, 1)`,
          )
          .run(
            'value:migration-intake',
            contentHash,
            'registry-resource:migration-intake',
            contentHash,
          );
        legacy
          .prepare(
            `INSERT INTO workflow_task_intakes (
               id, request_id, creation_domain, creation_key, source,
               principal_ref, routing_scope_resource_id,
               routing_scope_resource_hash, raw_request_value_id,
               raw_request_hash, initial_input_value_id, initial_input_hash,
               attachment_manifest_value_id, attachment_manifest_hash,
               explicit_task_kind, explicit_recipe_resource_id, status,
               selected_recipe_resource_id, selected_recipe_hash,
               current_revision_id, current_revision_no, current_revision_hash,
               workflow_id, next_attempt_no, row_version, created_at_ms,
               updated_at_ms
             ) VALUES (?, ?, ?, ?, 'api', 'human:local-owner', ?, ?, NULL,
                       NULL, ?, ?, ?, ?, NULL, NULL, 'routing', NULL, NULL, ?,
                       0, ?, NULL, 1, 1, 101, 101)`,
          )
          .run(
            'intake:migration-13',
            'request:migration-13',
            'migration-test',
            'intake-13',
            'registry-resource:migration-intake',
            contentHash,
            'value:migration-intake',
            contentHash,
            'value:migration-intake',
            contentHash,
            'revision:migration-13',
            revisionHash,
          );
        legacy
          .prepare(
            `INSERT INTO workflow_task_intake_revisions (
               id, intake_id, revision_no, parent_revision_id,
               amendment_value_id, amendment_hash, effective_input_value_id,
               effective_input_hash, attachment_manifest_value_id,
               attachment_manifest_hash, clarification_contract_resource_id,
               clarification_contract_resource_hash, source_routing_attempt_id,
               actor_kind, principal_ref, idempotency_key, revision_hash,
               created_at_ms
             ) VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL,
                       NULL, 'human', 'human:local-owner', 'migration-13', ?, 101)`,
          )
          .run(
            'revision:migration-13',
            'intake:migration-13',
            'value:migration-intake',
            contentHash,
            'value:migration-intake',
            contentHash,
            revisionHash,
          );
      })();
    } finally {
      legacy.close();
    }

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
    });
    stores.push(store);
    expect(store.schemaVersion).toBe(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION);
    expect(
      store.queryOne<Record<string, unknown>>(
        `SELECT id, request_id, creation_domain, creation_key, source,
                principal_ref, current_revision_id, current_revision_no,
                current_revision_hash, next_attempt_no, row_version,
                created_at_ms, updated_at_ms
           FROM workflow_task_intakes WHERE id = ?`,
        ['intake:migration-13'],
      ),
    ).toEqual({
      id: 'intake:migration-13',
      request_id: 'request:migration-13',
      creation_domain: 'migration-test',
      creation_key: 'intake-13',
      source: 'api',
      principal_ref: 'human:local-owner',
      current_revision_id: 'revision:migration-13',
      current_revision_no: 0,
      current_revision_hash: revisionHash,
      next_attempt_no: 1,
      row_version: 1,
      created_at_ms: 101,
      updated_at_ms: 101,
    });
    expect(() =>
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          `UPDATE workflow_task_intakes SET source = 'task_workspace',
                  row_version = row_version + 1, updated_at_ms = 102
            WHERE id = ?`,
          ['intake:migration-13'],
        );
      }),
    ).not.toThrow();
    expect(
      store.queryOne<{ source: string }>(
        'SELECT source FROM workflow_task_intakes WHERE id = ?',
        ['intake:migration-13'],
      ),
    ).toEqual({ source: 'task_workspace' });
    expect(() =>
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          `INSERT INTO workflow_runtime_command_ingress_invocations (
            id, idempotency_domain, idempotency_key, ingress_no,
            submitted_command_id, canonical_request_json,
            submitted_request_hash, command_type, claimed_target_kind,
            claimed_workflow_id, claimed_run_id, claimed_node_id,
            claimed_retry_schedule_id, claimed_effect_operation_id,
            claimed_operational_blocker_id, actor_ref, actor_kind,
            auth_session_ref, entrypoint, source_feature_id,
            delegation_chain_ref, resolution_result, authorization_result,
            execution_result, denial_code, canonical_result_json,
            canonical_result_hash, resolved_command_id,
            resolved_invocation_id, requested_at_ms, decided_at_ms,
            applied_at_ms, terminal_binding_hash
          ) VALUES (?, ?, ?, 1, ?, ?, ?, 'pause_run', 'run', NULL, ?, NULL,
                    NULL, NULL, NULL, ?, 'human', ?, 'task_workspace', NULL,
                    NULL, 'prepared', 'pending', 'prepared', NULL, NULL, NULL,
                    NULL, NULL, ?, NULL, NULL, NULL)`,
          [
            'ingress:migrated-task-workspace',
            'task-workspace:migration-test',
            'pause-run',
            'command:migrated-task-workspace',
            '{"command":"pause"}',
            MIGRATION_HASH,
            'run:migrated-task-workspace',
            'human:local-owner',
            'auth:migration-test',
            103,
          ],
        );
      }),
    ).not.toThrow();
    expect(
      store.queryOne<{ entrypoint: string }>(
        'SELECT entrypoint FROM workflow_runtime_command_ingress_invocations WHERE id = ?',
        ['ingress:migrated-task-workspace'],
      ),
    ).toEqual({ entrypoint: 'task_workspace' });
  });

  it('creates Schema 13 without obsolete governance columns', () => {
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
    expect(columns('workflow_feature_releases')).not.toEqual(
      expect.arrayContaining([
        'compatibility_snapshot_ref',
        'compatibility_snapshot_hash',
      ]),
    );
    expect(columns('workflow_feature_release_activation_commands')).not.toEqual(
      expect.arrayContaining([
        'verified_compatibility_input_value_id',
        'verified_compatibility_result_value_id',
      ]),
    );
    expect(columns('runtime_capacity_admin_commands')).not.toContain(
      'genesis_core_release_hash',
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
