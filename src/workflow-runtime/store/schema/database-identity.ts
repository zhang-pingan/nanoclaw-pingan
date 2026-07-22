import type Database from 'better-sqlite3';

import { domainSeparatedSha256 } from '../../contracts/hash.js';
import type { JsonValue, Sha256Hash } from '../../contracts/types.js';
import type { WorkflowRuntimeSchemaManifestPayload } from './types.js';

export const SQLITE_SCHEMA_IDENTITY_DOMAIN_SEPARATOR =
  'icarus:workflow-runtime-sqlite-schema-identity:1\n';

interface SqliteSchemaIdentityRow {
  type: 'index' | 'table' | 'trigger';
  name: string;
  tbl_name: string;
  sql: string;
}

function compareRows(
  left: SqliteSchemaIdentityRow,
  right: SqliteSchemaIdentityRow,
): number {
  const leftKey = `${left.type}\0${left.name}`;
  const rightKey = `${right.type}\0${right.name}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function hashRows(rows: SqliteSchemaIdentityRow[]): Sha256Hash {
  return domainSeparatedSha256(
    SQLITE_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
    [...rows].sort(compareRows) as unknown as JsonValue,
  );
}

export function calculateDatabaseSqliteSchemaIdentity(
  database: Database.Database,
): Sha256Hash {
  const rows = database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<SqliteSchemaIdentityRow & { sql: string | null }>;
  if (rows.some((row) => row.sql === null)) {
    throw new Error('Canonical sqlite_schema contains a null SQL definition');
  }
  return hashRows(rows as SqliteSchemaIdentityRow[]);
}

export function calculateManifestSqliteSchemaIdentity(
  manifest: WorkflowRuntimeSchemaManifestPayload,
): Sha256Hash {
  const rows: SqliteSchemaIdentityRow[] = [];
  for (const table of manifest.tables) {
    rows.push({
      type: 'table',
      name: table.name,
      tbl_name: table.name,
      sql: table.sql,
    });
    for (const key of table.unique_keys) {
      rows.push({
        type: 'index',
        name: key.key_id,
        tbl_name: table.name,
        sql: key.sql,
      });
    }
    for (const index of table.indexes) {
      rows.push({
        type: 'index',
        name: index.index_id,
        tbl_name: table.name,
        sql: index.sql,
      });
    }
  }
  for (const trigger of manifest.triggers) {
    rows.push({
      type: 'trigger',
      name: trigger.name,
      tbl_name: trigger.table,
      sql: trigger.sql,
    });
  }
  return hashRows(rows);
}
