import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { LogicalTableMetadata } from './logical-schema-types.js';
import { renderMigration } from '../store/schema/ddl.js';
import { loadSchema8ExecutableSchemaSource } from '../store/schema/source.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';

const schema8 = loadSchema8ExecutableSchemaSource();
const migration = renderMigration(schema8);

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function defaultValue(
  tableName: string,
  column: LogicalTableMetadata['columns'][number],
): string | number | null {
  if (column.nullable) return null;
  if (column.enum_values.length > 0) return column.enum_values[0];
  if (column.logical_type === 'integer')
    return column.safe_integer_intent === 'positive' ? 1 : 0;
  if (column.logical_type === 'boolean_integer') return 0;
  if (column.logical_type === 'hash')
    return hash(`${tableName}:${column.name}`);
  if (column.logical_type === 'canonical_json') return '{}';
  return `${tableName}:${column.name}`;
}

function seedRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null>,
): void {
  const table = schema8.tables.find(
    (candidate) => candidate.name === tableName,
  );
  if (!table) throw new Error(`Missing seed table ${tableName}`);
  const columns = table.columns.filter(
    (column) =>
      !(
        table.primary_key.auto_increment_intent &&
        table.primary_key.columns[0] === column.name
      ),
  );
  database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(
      ...columns.map((column) =>
        Object.hasOwn(overrides, column.name)
          ? overrides[column.name]!
          : defaultValue(tableName, column),
      ),
    );
}

function seedTerminalMapLineage(
  database: Database.Database,
  terminalOutcome: 'errored' | 'cancelled',
): void {
  database.pragma('foreign_keys = OFF');
  database.pragma('ignore_check_constraints = ON');
  seedRow(database, 'workflow_graph_scopes', {
    id: 'parent',
    graph_run_id: 'run',
    parent_scope_id: null,
    owner_node_id: null,
  });
  seedRow(database, 'workflow_graph_nodes', {
    id: 'map-owner',
    graph_run_id: 'run',
    scope_id: 'parent',
    node_type: 'map',
  });
  seedRow(database, 'workflow_graph_scopes', {
    id: 'child',
    graph_run_id: 'run',
    parent_scope_id: 'parent',
    owner_node_id: 'map-owner',
    scope_kind: 'map_item',
  });
  seedRow(database, 'workflow_graph_completion_cuts', {
    id: 'child-cut',
    graph_run_id: 'run',
    scope_id: 'child',
    outcome_kind: terminalOutcome,
  });
  seedRow(database, 'workflow_graph_events', {
    graph_run_id: 'run',
    seq: 1,
    event_type: 'child_completion_consumed',
  });
  seedRow(database, 'workflow_graph_map_item_results', {
    id: 'map-slot',
    graph_run_id: 'run',
    owner_scope_id: 'parent',
    owner_node_id: 'map-owner',
    scope_id: 'child',
    item_index: 0,
    outcome_state: terminalOutcome,
    exit_name: null,
    error_code: terminalOutcome === 'errored' ? 'child_scope_errored' : null,
    reason: terminalOutcome === 'cancelled' ? 'child_scope_cancelled' : null,
    output_value_id: null,
    output_hash: null,
    completion_seq: terminalOutcome === 'cancelled' ? 1 : null,
    fence_event_seq: null,
    resolved_at_ms: 1,
  });
  database.pragma('ignore_check_constraints = OFF');
  database.pragma('foreign_keys = ON');
}

function tryConsumption(
  database: Database.Database,
  disposition: string,
  mapOutcome: string | null,
  carrySlot = true,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO workflow_graph_child_completion_consumptions (
           id, graph_run_id, child_scope_id, child_completion_cut_id,
           parent_scope_id, owner_node_id, map_slot_id,
           map_slot_outcome_state, disposition, parent_work_fence_epoch,
           disposition_event_seq, created_at_ms
         ) VALUES (?, 'run', 'child', 'child-cut', 'parent', 'map-owner', ?, ?,
           ?, 0, 1, 1)`,
      )
      .run(
        `consumption:${disposition}`,
        carrySlot ? 'map-slot' : null,
        mapOutcome,
        disposition,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

describe('G6 map terminal child-consumption blocker', () => {
  it('reproduces the Schema 8 impossibility for errored and cancelled map children on fresh real-file SQLite databases', () => {
    for (const terminalOutcome of ['errored', 'cancelled'] as const) {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'icarus-g6-map-consumption-blocker-'),
      );
      const databasePath = path.join(root, 'workflow-runtime.db');
      const database = createMigratedDatabase(databasePath, migration.sql);
      try {
        seedTerminalMapLineage(database, terminalOutcome);
        expect(
          database
            .prepare(
              "SELECT outcome_state FROM workflow_graph_map_item_results WHERE id = 'map-slot'",
            )
            .pluck()
            .get(),
        ).toBe(terminalOutcome);

        expect(() =>
          tryConsumption(database, 'map_slot_completed', 'completed'),
        ).toThrow(/FOREIGN KEY constraint failed/);
        expect(() =>
          tryConsumption(database, 'map_slot_fenced', 'fenced'),
        ).toThrow(/FOREIGN KEY constraint failed/);

        for (const disposition of [
          'owner_output_published',
          'non_publish_parent_fenced',
          'non_publish_owner_fenced',
        ]) {
          expect(() =>
            tryConsumption(database, disposition, terminalOutcome),
          ).toThrow(/CHECK constraint failed/);
        }
        expect(
          database
            .prepare(
              'SELECT count(*) FROM workflow_graph_child_completion_consumptions',
            )
            .pluck()
            .get(),
        ).toBe(0);
        expect(
          database
            .prepare(
              "SELECT * FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
            )
            .all(),
        ).toEqual([]);
      } finally {
        database.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('pins the exact conflicting closed catalogs rather than choosing a G6 workaround', () => {
    const consumption = schema8.tables.find(
      (table) => table.name === 'workflow_graph_child_completion_consumptions',
    )!;
    const slotOutcome = consumption.columns.find(
      (column) => column.name === 'map_slot_outcome_state',
    )!;
    const disposition = consumption.columns.find(
      (column) => column.name === 'disposition',
    )!;
    expect(slotOutcome.enum_values).toEqual(['completed', 'fenced']);
    expect(disposition.enum_values).toEqual([
      'owner_output_published',
      'map_slot_completed',
      'map_slot_fenced',
      'non_publish_parent_fenced',
      'non_publish_owner_fenced',
    ]);
    expect(
      schema8.tables
        .find((table) => table.name === 'workflow_graph_map_item_results')!
        .columns.find((column) => column.name === 'outcome_state')!.enum_values,
    ).toEqual(['open', 'completed', 'errored', 'cancelled', 'fenced']);
  });
});
