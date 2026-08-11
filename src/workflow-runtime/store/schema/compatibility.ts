import type Database from 'better-sqlite3';

import { CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION } from '../runtime-store/config.js';

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
    'owner_principal_ref',
    'content_hash',
    'publication_state',
  ],
  workflow_pack_releases: [
    'id',
    'pack_id',
    'release_ref',
    'release_version',
    'release_hash',
    'execution_artifact_resource_id',
    'execution_artifact_hash',
    'status',
  ],
  workflow_pack_release_activation_commands: [
    'command_id',
    'request_value_id',
    'verified_target_pack_release_id',
    'lifecycle',
    'row_version',
  ],
  workflow_personal_releases: [
    'id',
    'owner_principal_ref',
    'personal_workflow_id',
    'release_hash',
    'recipe_resource_id',
    'graph_template_resource_id',
    'registry_snapshot_id',
    'compiled_plan_hash',
    'status',
    'row_version',
  ],
  workflow_personal_active_releases: [
    'owner_principal_ref',
    'personal_workflow_id',
    'release_id',
    'release_hash',
    'row_version',
  ],
  workflow_personal_release_operations: [
    'operation_id',
    'idempotency_domain',
    'idempotency_key',
    'operation_type',
    'request_hash',
    'disposition',
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
  workflow_pack_releases: [
    'compatibility_snapshot_ref',
    'compatibility_snapshot_hash',
  ],
  workflow_pack_release_activation_commands: [
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
  'uk:pack_releases:single_active',
  'uk:personal_releases:single_active',
  'uk:personal_release_operations:idempotency',
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
