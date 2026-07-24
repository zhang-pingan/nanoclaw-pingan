import crypto from 'crypto';

import type Database from 'better-sqlite3';

import { domainSeparatedSha256 } from '../../contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';
import {
  buildQueryFixtures,
  renderCheckExpression,
} from './manifest-support.js';
import {
  MIGRATION_RELATIVE_PATH,
  renderIndex,
  renderTable,
  renderUniqueIndex,
} from './ddl.js';
import type {
  ExecutableSchemaSource,
  SchemaManifestColumn,
  SchemaManifestForeignKey,
  SchemaManifestIndex,
  SchemaManifestTable,
  SchemaManifestUniqueKey,
  SchemaTriggerDefinition,
  WorkflowRuntimeSchemaManifestPayload,
} from './types.js';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface SchemaRow {
  type: 'table' | 'index' | 'trigger';
  name: string;
  tbl_name: string;
  sql: string | null;
}

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function rawSha256(value: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function exactKeys(value: object, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new Error(`${label} is not closed: ${actual.join(',')}`);
  }
}

function schemaRows(database: Database.Database): Map<string, SchemaRow> {
  const rows = database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as SchemaRow[];
  return new Map(rows.map((row) => [`${row.type}:${row.name}`, row]));
}

function assertSql(
  rows: Map<string, SchemaRow>,
  type: SchemaRow['type'],
  name: string,
  expected: string,
): string {
  const row = rows.get(`${type}:${name}`);
  if (!row || row.sql !== expected) {
    throw new Error(
      `sqlite_schema ${type} ${name} differs from the canonical migration`,
    );
  }
  return row.sql;
}

function columnMetadataComment(
  tableSql: string,
  column: ExecutableSchemaSource['tables'][number]['columns'][number],
): void {
  const logical = `logical_type=${column.logical_type}`;
  if (!tableSql.includes(`${q(column.name)} ${column.sqlite_type_intent}`)) {
    throw new Error(`sqlite_schema is missing column ${column.name}`);
  }
  if (!tableSql.includes(logical)) {
    throw new Error(`sqlite_schema is missing ${column.name} logical metadata`);
  }
  if (column.external_reference) {
    const tokens = [
      'external_ref=1',
      `validator_owner=${column.external_reference.validator_owner}`,
      `reference_domain=${column.external_reference.reference_domain}`,
      `immutable=${column.external_reference.immutable ? 1 : 0}`,
    ];
    for (const token of tokens) {
      if (!tableSql.includes(token)) {
        throw new Error(`sqlite_schema is missing external metadata ${token}`);
      }
    }
  }
}

function buildColumns(
  database: Database.Database,
  table: ExecutableSchemaSource['tables'][number],
  tableSql: string,
): SchemaManifestColumn[] {
  const rows = database
    .prepare(`PRAGMA table_info(${q(table.name)})`)
    .all() as TableInfoRow[];
  if (rows.length !== table.columns.length) {
    throw new Error(`${table.name} column count differs from logical input`);
  }
  return rows.map((row, index) => {
    const logical = table.columns[index];
    if (
      row.cid !== index ||
      row.name !== logical.name ||
      row.type !== logical.sqlite_type_intent ||
      (row.notnull === 0) !== logical.nullable
    ) {
      throw new Error(`${table.name}.${logical.name} PRAGMA metadata drifted`);
    }
    columnMetadataComment(tableSql, logical);
    return {
      cid: row.cid,
      name: row.name,
      sqlite_type: row.type,
      nullable: row.notnull === 0,
      default_sql: row.dflt_value,
      primary_key_ordinal: row.pk,
      logical_type: logical.logical_type,
      external_reference: logical.external_reference,
    };
  });
}

function buildForeignKeys(
  database: Database.Database,
  table: ExecutableSchemaSource['tables'][number],
  tableSql: string,
): SchemaManifestForeignKey[] {
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${q(table.name)})`)
    .all() as ForeignKeyRow[];
  const grouped = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.id) ?? [];
    group.push(row);
    grouped.set(row.id, group);
  }
  if (grouped.size !== table.foreign_keys.length) {
    throw new Error(`${table.name} foreign key count differs`);
  }
  return table.foreign_keys.map((relation) => {
    const match = [...grouped.entries()].find(([, candidates]) => {
      const ordered = [...candidates].sort(
        (left, right) => left.seq - right.seq,
      );
      return (
        ordered[0]?.table === relation.target_table &&
        ordered.map((row) => row.from).join('\0') ===
          relation.source_columns.join('\0') &&
        ordered.map((row) => row.to).join('\0') ===
          relation.target_columns.join('\0')
      );
    });
    if (!match) {
      throw new Error(`${table.name} is missing ${relation.relation_id}`);
    }
    const action = relation.on_delete.replace('_', ' ').toUpperCase();
    if (match[1][0].on_delete !== action) {
      throw new Error(`${relation.relation_id} ON DELETE drifted`);
    }
    const deferrability =
      relation.deferrability === 'deferred'
        ? 'DEFERRABLE INITIALLY DEFERRED'
        : 'NOT DEFERRABLE';
    if (
      !tableSql.includes(`CONSTRAINT ${q(relation.relation_id)} FOREIGN KEY`) ||
      !tableSql.includes(deferrability)
    ) {
      throw new Error(`${relation.relation_id} constraint metadata drifted`);
    }
    return { ...relation, pragma_id: match[0] };
  });
}

function indexColumns(
  database: Database.Database,
  indexName: string,
): string[] {
  return (
    database
      .prepare(`PRAGMA index_info(${q(indexName)})`)
      .all() as IndexInfoRow[]
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map((row) => row.name);
}

function buildUniqueKeys(
  database: Database.Database,
  table: ExecutableSchemaSource['tables'][number],
  rows: Map<string, SchemaRow>,
  indexList: IndexListRow[],
): SchemaManifestUniqueKey[] {
  return table.unique_keys.map((key) => {
    const physical = indexList.find((index) => index.name === key.key_id);
    if (!physical || physical.unique !== 1) {
      throw new Error(`${table.name} is missing unique key ${key.key_id}`);
    }
    const columns = indexColumns(database, key.key_id);
    if (columns.join('\0') !== key.columns.join('\0')) {
      throw new Error(`${key.key_id} columns drifted`);
    }
    const sql = assertSql(
      rows,
      'index',
      key.key_id,
      renderUniqueIndex(table, key),
    );
    return { ...key, origin: physical.origin, sql };
  });
}

function buildIndexes(
  database: Database.Database,
  table: ExecutableSchemaSource['tables'][number],
  rows: Map<string, SchemaRow>,
  indexList: IndexListRow[],
): SchemaManifestIndex[] {
  return table.indexes.map((index) => {
    const physical = indexList.find(
      (candidate) => candidate.name === index.index_id,
    );
    if (!physical || physical.unique !== 0) {
      throw new Error(`${table.name} is missing index ${index.index_id}`);
    }
    if (
      indexColumns(database, index.index_id).join('\0') !==
      index.columns.join('\0')
    ) {
      throw new Error(`${index.index_id} columns drifted`);
    }
    const sql = assertSql(
      rows,
      'index',
      index.index_id,
      renderIndex(table, index),
    );
    return { ...index, unique: false, sql };
  });
}

function buildTableManifest(
  database: Database.Database,
  source: ExecutableSchemaSource,
  table: ExecutableSchemaSource['tables'][number],
  rows: Map<string, SchemaRow>,
): SchemaManifestTable {
  const tableSql = assertSql(rows, 'table', table.name, renderTable(table));
  const indexList = database
    .prepare(`PRAGMA index_list(${q(table.name)})`)
    .all() as IndexListRow[];
  for (const check of table.checks) {
    if (
      !tableSql.includes(`CONSTRAINT ${q(check.check_id)} CHECK`) ||
      !tableSql.includes(`check_kind=${check.kind}`)
    ) {
      throw new Error(`${table.name} is missing named CHECK ${check.check_id}`);
    }
  }
  return {
    ordinal: table.ordinal,
    name: table.name,
    sql: tableSql,
    columns: buildColumns(database, table, tableSql),
    primary_key: {
      columns: table.primary_key.columns,
      auto_increment: table.primary_key.auto_increment_intent,
    },
    unique_keys: buildUniqueKeys(database, table, rows, indexList),
    foreign_keys: buildForeignKeys(database, table, tableSql),
    checks: table.checks.map((check) => ({
      ...check,
      expression_sql: renderCheckExpression(check, table.columns),
    })),
    indexes: buildIndexes(database, table, rows, indexList),
  };
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

export function reconstructSchemaManifest(
  database: Database.Database,
  source: ExecutableSchemaSource,
  migrationSql: string,
  statementCount: number,
  triggers: SchemaTriggerDefinition[],
): WorkflowRuntimeSchemaManifestPayload {
  const rows = schemaRows(database);
  const expectedObjectNames = new Set([
    ...source.tables.map((table) => `table:${table.name}`),
    ...source.tables.flatMap((table) => [
      ...table.unique_keys.map((key) => `index:${key.key_id}`),
      ...table.indexes.map((index) => `index:${index.index_id}`),
    ]),
    ...triggers.map((trigger) => `trigger:${trigger.name}`),
  ]);
  for (const key of rows.keys()) {
    if (!expectedObjectNames.has(key)) {
      throw new Error(`Unexpected sqlite_schema object: ${key}`);
    }
  }
  if (rows.size !== expectedObjectNames.size) {
    throw new Error('sqlite_schema is missing a canonical object');
  }
  const tables = source.tables.map((table) =>
    buildTableManifest(database, source, table, rows),
  );
  const manifestTriggers = triggers.map((trigger) => ({
    ...trigger,
    sql: assertSql(rows, 'trigger', trigger.name, trigger.sql),
  }));
  const queryFixtures = buildQueryFixtures(source);
  const payloadWithoutHash = {
    schema_id: source.schema_id,
    database_name: 'workflow-runtime.db',
    database_schema_version: source.database_schema_version,
    logical_inputs: source.logical_inputs,
    migration_path: MIGRATION_RELATIVE_PATH,
    migration_sha256: rawSha256(migrationSql),
    migration_statement_count: statementCount,
    table_count: tables.length,
    column_count: tables.reduce(
      (total, table) => total + table.columns.length,
      0,
    ),
    primary_key_count: tables.length,
    unique_key_count: tables.reduce(
      (total, table) => total + table.unique_keys.length,
      0,
    ),
    foreign_key_count: tables.reduce(
      (total, table) => total + table.foreign_keys.length,
      0,
    ),
    check_count: tables.reduce(
      (total, table) => total + table.checks.length,
      0,
    ),
    index_count: tables.reduce(
      (total, table) => total + table.indexes.length,
      0,
    ),
    trigger_count: manifestTriggers.length,
    external_reference_count: tables.reduce(
      (total, table) =>
        total +
        table.columns.filter((column) => column.external_reference !== null)
          .length,
      0,
    ),
    tables,
    triggers: manifestTriggers,
    query_fixtures: queryFixtures,
  };
  const schemaHash = domainSeparatedSha256(
    'icarus:workflow-runtime-schema:1\n',
    asJson(payloadWithoutHash),
  );
  const payload = {
    ...payloadWithoutHash,
    schema_hash: schemaHash,
  } as unknown as WorkflowRuntimeSchemaManifestPayload;
  assertClosedSchemaManifest(payload);
  return payload;
}

export function assertClosedSchemaManifest(
  payload: WorkflowRuntimeSchemaManifestPayload,
): void {
  exactKeys(
    payload,
    [
      'schema_id',
      'database_name',
      'database_schema_version',
      'logical_inputs',
      'migration_path',
      'migration_sha256',
      'migration_statement_count',
      'table_count',
      'column_count',
      'primary_key_count',
      'unique_key_count',
      'foreign_key_count',
      'check_count',
      'index_count',
      'trigger_count',
      'external_reference_count',
      'tables',
      'triggers',
      'query_fixtures',
      'schema_hash',
    ],
    'Schema Manifest',
  );
  exactKeys(
    payload.logical_inputs,
    [
      'logical_schema_source_hash',
      'typed_relation_catalog_hash',
      'query_catalog_hash',
      'capacity_delta_hash',
      'publisher_schema_prerequisite_hash',
      'feature_release_activation_schema_prerequisite_hash',
      'activation_failure_replay_schema_prerequisite_hash',
      'generated_schema_authority_prerequisite_hash',
      'sqlite_profile_hash',
    ],
    'Schema Manifest logical_inputs',
  );
  for (const table of payload.tables) {
    exactKeys(
      table,
      [
        'ordinal',
        'name',
        'sql',
        'columns',
        'primary_key',
        'unique_keys',
        'foreign_keys',
        'checks',
        'indexes',
      ],
      `${table.name} manifest`,
    );
    for (const column of table.columns) {
      exactKeys(
        column,
        [
          'cid',
          'name',
          'sqlite_type',
          'nullable',
          'default_sql',
          'primary_key_ordinal',
          'logical_type',
          'external_reference',
        ],
        `${table.name}.${column.name}`,
      );
      if (column.external_reference) {
        exactKeys(
          column.external_reference,
          ['validator_owner', 'reference_domain', 'immutable'],
          `${table.name}.${column.name} external reference`,
        );
      }
    }
    exactKeys(
      table.primary_key,
      ['columns', 'auto_increment'],
      `${table.name} primary key`,
    );
    for (const uniqueKey of table.unique_keys) {
      exactKeys(
        uniqueKey,
        ['key_id', 'columns', 'predicate_intent', 'origin', 'sql'],
        `${table.name}.${uniqueKey.key_id}`,
      );
    }
    for (const foreignKey of table.foreign_keys) {
      exactKeys(
        foreignKey,
        [
          'relation_id',
          'source_columns',
          'target_table',
          'target_columns',
          'on_delete',
          'deferrability',
          'pragma_id',
        ],
        `${table.name}.${foreignKey.relation_id}`,
      );
    }
    for (const check of table.checks) {
      exactKeys(
        check,
        ['check_id', 'kind', 'columns', 'expression_intent', 'expression_sql'],
        `${table.name}.${check.check_id}`,
      );
    }
    for (const index of table.indexes) {
      exactKeys(
        index,
        [
          'index_id',
          'kind',
          'columns',
          'predicate_intent',
          'supports_query_ids',
          'unique',
          'sql',
        ],
        `${table.name}.${index.index_id}`,
      );
    }
  }
  for (const trigger of payload.triggers) {
    exactKeys(
      trigger,
      ['name', 'table', 'timing', 'event', 'owner_intent', 'sql'],
      `Schema Manifest trigger ${trigger.name}`,
    );
  }
  for (const fixture of payload.query_fixtures) {
    exactKeys(
      fixture,
      [
        'query_id',
        'owner',
        'coverage_area',
        'sql',
        'parameter_count',
        'required_index_id',
      ],
      `Schema Manifest query fixture ${fixture.query_id}`,
    );
  }
  const withoutHash = { ...payload } as Record<string, unknown>;
  delete withoutHash.schema_hash;
  const expected = domainSeparatedSha256(
    'icarus:workflow-runtime-schema:1\n',
    asJson(withoutHash),
  );
  if (payload.schema_hash !== expected) {
    throw new Error(
      `Schema Manifest hash mismatch: expected ${expected}, received ${payload.schema_hash}`,
    );
  }
}

export function payloadAsJsonObject(
  payload: WorkflowRuntimeSchemaManifestPayload,
): JsonObject {
  return payload as unknown as JsonObject;
}
