import type Database from 'better-sqlite3';

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
    'release_version',
    'release_hash',
    'status',
  ],
  workflows: ['id', 'status', 'current_graph_run_id', 'row_version'],
  workflow_graph_runs: ['id', 'workflow_id', 'database_schema_version'],
  runtime_capacity_head: [
    'singleton_key',
    'current_capacity_revision',
    'current_config_hash',
    'row_version',
  ],
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
