import type Database from 'better-sqlite3';

import { calculateRegistrySnapshotHash } from '../../contracts/g3-registry-persistence.js';
import type { Sha256Hash, VersionedRef } from '../../contracts/types.js';
import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  readWorkflowRuntimeUpgradeSql,
  SCHEMA_3_REQUIRED_EMPTY_RELATIONS,
} from '../runtime-store/config.js';

export interface WorkflowRuntimeSchemaInspection {
  readonly schemaVersion: number;
  readonly current: boolean;
}

const REQUIRED_COLUMNS = {
  workflow_values: ['id', 'content_hash', 'schema_resource_id', 'row_version'],
  workflow_registry_resources: [
    'id',
    'resource_type',
    'resource_id',
    'resource_version',
    'content_hash',
    'publication_state',
  ],
  workflow_feature_releases: [
    'id',
    'feature_id',
    'release_ref',
    'release_version',
    'release_hash',
    'execution_artifact_resource_id',
    'execution_artifact_hash',
    'status',
  ],
  workflow_feature_release_activation_commands: [
    'command_id',
    'request_value_id',
    'verified_target_feature_release_id',
    'lifecycle',
    'row_version',
  ],
  workflow_registry_snapshots: [
    'id',
    'snapshot_hash',
    'closure_manifest_id',
    'closure_hash',
    'compiler_version',
    'created_at_ms',
  ],
  workflows: ['id', 'status', 'current_graph_run_id', 'row_version'],
  workflow_graph_runs: [
    'id',
    'workflow_id',
    'registry_snapshot_id',
    'registry_snapshot_hash',
    'source_seed_hash',
    'root_scope_id',
    'root_build_id',
    'lifecycle',
    'control',
    'row_version',
  ],
  runtime_capacity_head: [
    'singleton_key',
    'current_capacity_revision',
    'current_config_hash',
    'row_version',
  ],
  runtime_capacity_admin_commands: [
    'command_id',
    'command_type',
    'assigned_capacity_revision',
    'assigned_change_id',
    'proposed_capacity_json',
    'proposed_config_hash',
  ],
} as const;

const FORBIDDEN_COLUMNS = {
  workflow_registry_snapshots: ['core_build_hash', 'database_schema_hash'],
  workflow_graph_runs: [
    'compiler_toolchain_resource_id',
    'compiler_toolchain_resource_hash',
    'core_release_ref',
    'core_release_hash',
    'core_build_hash',
    'run_protocol_major',
    'executor_abi_major',
    'database_schema_version',
    'database_schema_hash',
  ],
  workflow_feature_releases: [
    'compatibility_snapshot_ref',
    'compatibility_snapshot_hash',
  ],
  workflow_feature_release_activation_commands: [
    'verified_compatibility_input_value_id',
    'verified_compatibility_input_hash',
    'verified_compatibility_input_schema_resource_id',
    'verified_compatibility_input_schema_hash',
    'verified_compatibility_result_value_id',
    'verified_compatibility_result_hash',
    'verified_compatibility_result_schema_resource_id',
    'verified_compatibility_result_schema_hash',
  ],
  runtime_capacity_admin_commands: ['genesis_core_release_hash'],
} as const;

const REQUIRED_INDEXES = [
  'uk:values:id_hash',
  'uk:registry_resources:type_ref',
  'uk:registry_resources:id_hash',
  'uk:feature_releases:single_active',
  'idx:capacity_head:singleton',
] as const;

function scalarUserVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true }) as unknown;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(
      `Workflow Runtime PRAGMA user_version is invalid: ${String(value)}`,
    );
  }
  return Number(value);
}

function hasTable(database: Database.Database, table: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function inferLegacySchemaVersion(database: Database.Database): number | null {
  if (!hasTable(database, 'workflow_runtime_metadata')) return null;
  const columns = new Set(
    (
      database.pragma('table_info(workflow_runtime_metadata)') as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (!columns.has('key') || !columns.has('value')) return null;
  const row = database
    .prepare(
      'SELECT value FROM workflow_runtime_metadata WHERE key = ? LIMIT 1',
    )
    .get('schema_version') as { value?: unknown } | undefined;
  const version = Number(row?.value);
  return Number.isSafeInteger(version) ? version : null;
}

function parseStoredVersionedRef(value: string, prefix: string): VersionedRef {
  if (!value.startsWith(prefix)) {
    throw new Error(`Malformed stored Registry reference ${value}`);
  }
  const serialized = value.slice(prefix.length);
  const separator = serialized.lastIndexOf('@');
  if (separator <= 0 || separator === serialized.length - 1) {
    throw new Error(`Malformed stored Registry reference ${value}`);
  }
  return {
    id: serialized.slice(0, separator),
    version: serialized.slice(separator + 1),
  };
}

function migrateSchema11RegistrySnapshotHashes(
  database: Database.Database,
): void {
  const rows = database
    .prepare(
      `SELECT id, closure_manifest_id, closure_hash, compiler_version
         FROM workflow_registry_snapshots ORDER BY id`,
    )
    .all() as Array<{
    id: string;
    closure_manifest_id: string;
    closure_hash: Sha256Hash;
    compiler_version: string;
  }>;
  const update = database.prepare(
    'UPDATE workflow_registry_snapshots SET snapshot_hash = ? WHERE id = ?',
  );
  for (const row of rows) {
    const snapshotHash = calculateRegistrySnapshotHash({
      format: 'icarus.workflow-registry-snapshot/1',
      ref: parseStoredVersionedRef(row.id, 'registry-snapshot:'),
      closure_ref: parseStoredVersionedRef(
        row.closure_manifest_id,
        'registry-closure:',
      ),
      closure_hash: row.closure_hash,
      compiler_version: row.compiler_version,
    });
    update.run(snapshotHash, row.id);
  }
}

function assertSchema11HasNoRuns(database: Database.Database): void {
  const count = Number(
    database.prepare('SELECT count(*) FROM workflow_graph_runs').pluck().get(),
  );
  if (count !== 0) {
    throw new Error(
      `Schema 11 migration does not support persisted Workflow Runs; found ${count} row(s)`,
    );
  }
}

export function inspectWorkflowRuntimeSchema(
  database: Database.Database,
): WorkflowRuntimeSchemaInspection {
  const schemaVersion = scalarUserVersion(database);
  return {
    schemaVersion,
    current: schemaVersion === CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  };
}

export function assertCurrentWorkflowRuntimeStructure(
  database: Database.Database,
): void {
  const version = scalarUserVersion(database);
  if (version !== CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `Workflow Runtime schema version ${version} is not current version ${CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION}`,
    );
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!hasTable(database, table)) {
      throw new Error(
        `Workflow Runtime schema is missing required table ${table}`,
      );
    }
    const columns = new Set(
      (
        database.pragma(`table_info("${table}")`) as Array<{ name: string }>
      ).map((column) => column.name),
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(
          `Workflow Runtime schema is missing required column ${table}.${column}`,
        );
      }
    }
    for (const column of FORBIDDEN_COLUMNS[
      table as keyof typeof FORBIDDEN_COLUMNS
    ] ?? []) {
      if (columns.has(column)) {
        throw new Error(
          `Workflow Runtime schema contains obsolete column ${table}.${column}`,
        );
      }
    }
  }

  for (const index of REQUIRED_INDEXES) {
    const found = database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get(index);
    if (!found) {
      throw new Error(
        `Workflow Runtime schema is missing required index ${index}`,
      );
    }
  }
}

export function migrateWorkflowRuntimeSchema(
  database: Database.Database,
): void {
  let version = scalarUserVersion(database);
  if (version === 0) {
    const inferred = inferLegacySchemaVersion(database);
    if (inferred === null) {
      throw new Error(
        'Workflow Runtime schema version is missing and no supported legacy metadata was found',
      );
    }
    version = inferred;
  }
  if (version > CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `Workflow Runtime schema version ${version} is newer than supported version ${CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION}`,
    );
  }
  if (version < MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `Workflow Runtime schema version ${version} is unknown; supported versions are ${MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION}-${CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION}`,
    );
  }

  database.pragma('foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    if (scalarUserVersion(database) === 0) {
      database.pragma(`user_version = ${version}`);
    }
    if (version === 3) {
      for (const relation of SCHEMA_3_REQUIRED_EMPTY_RELATIONS) {
        if (!hasTable(database, relation)) {
          throw new Error(
            `Schema 3 migration is missing required relation ${relation}`,
          );
        }
        const escaped = relation.replaceAll('"', '""');
        const count = Number(
          database.prepare(`SELECT count(*) FROM "${escaped}"`).pluck().get(),
        );
        if (count !== 0) {
          throw new Error(
            `Schema 3 migration requires empty relation ${relation}, received ${count} row(s)`,
          );
        }
      }
    }
    while (version < CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION) {
      if (version === 11) {
        assertSchema11HasNoRuns(database);
        migrateSchema11RegistrySnapshotHashes(database);
      }
      database.exec(readWorkflowRuntimeUpgradeSql(version));
      const observed = scalarUserVersion(database);
      if (observed !== version + 1) {
        throw new Error(
          `Schema ${version} migration produced user_version ${observed}, expected ${version + 1}`,
        );
      }
      version = observed;
    }
    assertCurrentWorkflowRuntimeStructure(database);
    const integrity = database.pragma('integrity_check', {
      simple: true,
    }) as unknown;
    if (integrity !== 'ok') {
      throw new Error(
        `Workflow Runtime integrity_check failed: ${String(integrity)}`,
      );
    }
    const foreignKeyFailures = database.pragma(
      'foreign_key_check',
    ) as unknown[];
    if (foreignKeyFailures.length !== 0) {
      throw new Error('Workflow Runtime foreign_key_check returned violations');
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
