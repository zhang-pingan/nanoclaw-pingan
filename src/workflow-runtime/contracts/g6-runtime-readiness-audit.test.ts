import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';
import { WorkflowRuntimeConnectionFactory } from '../store/runtime-store/index.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function objects(value: unknown): JsonObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonObject[];
}

describe('G6 Dynamic / Close readiness audit', () => {
  it('proves T7b requires one child cut and its unique parent consumption atomically', () => {
    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const t7b = objects(transactions.payload.entries).find(
      (entry) => entry.transaction_id === 'T7b',
    )!;

    expect(t7b).toMatchObject({
      name: 'child_database_finalizer_and_consumer',
      preconditions: expect.arrayContaining([
        'child_logically_fenced',
        'required_compensation_successfully_terminal',
      ]),
      atomic_writes: expect.arrayContaining([
        'child_completion_cut',
        'unique_parent_consumption_disposition',
      ]),
      idempotency_constraints: expect.arrayContaining([
        'unique_child_scope_cut',
        'unique_child_scope_consumption',
        'single_map_slot_terminal_outcome',
      ]),
      forbidden: expect.arrayContaining([
        'publish_to_fenced_parent_or_owner',
        'cut_before_required_compensation_success',
      ]),
    });
  });

  it('proves the current logical authority cannot bind a consumption to its child cut lineage', () => {
    const logical = readArtifact(
      'sqlite/workflow-runtime-logical-schema-source@1.json',
    );
    const consumption = objects(logical.payload.tables).find(
      (table) => table.name === 'workflow_graph_child_completion_consumptions',
    )!;
    const columns = objects(consumption.columns).map((column) => column.name);
    const foreignKeys = objects(consumption.foreign_keys);

    expect(columns).toEqual([
      'id',
      'child_scope_id',
      'child_completion_cut_id',
      'parent_scope_id',
      'owner_node_id',
      'map_slot_id',
      'disposition',
      'parent_work_fence_epoch',
      'disposition_event_seq',
      'created_at_ms',
    ]);
    expect(columns).not.toContain('graph_run_id');
    expect(
      foreignKeys.find(
        (foreignKey) =>
          foreignKey.relation_id === 'fk:child_consumptions:child_scope',
      ),
    ).toMatchObject({
      source_columns: ['child_scope_id'],
      target_table: 'workflow_graph_scopes',
      target_columns: ['id'],
    });
    expect(
      foreignKeys.find(
        (foreignKey) =>
          foreignKey.relation_id === 'fk:child_consumptions:child_cut',
      ),
    ).toMatchObject({
      source_columns: ['child_completion_cut_id'],
      target_table: 'workflow_graph_completion_cuts',
      target_columns: ['id'],
    });
    expect(
      foreignKeys.some(
        (foreignKey) =>
          Array.isArray(foreignKey.source_columns) &&
          foreignKey.source_columns.includes('child_scope_id') &&
          foreignKey.source_columns.includes('child_completion_cut_id'),
      ),
    ).toBe(false);

    const relations = readArtifact(
      'sqlite/workflow-runtime-typed-relation-catalog@1.json',
    );
    const consumptionRelations = objects(relations.payload.relations).filter(
      (relation) =>
        relation.source_table ===
        'workflow_graph_child_completion_consumptions',
    );
    expect(
      consumptionRelations.some(
        (relation) =>
          Array.isArray(relation.source_columns) &&
          relation.source_columns.includes('child_scope_id') &&
          relation.source_columns.includes('child_completion_cut_id'),
      ),
    ).toBe(false);
  });

  it('proves Schema 7 has neither a composite foreign key nor an equivalent trigger', () => {
    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    );
    expect(manifest.payload.database_schema_version).toBe(7);
    const consumption = objects(manifest.payload.tables).find(
      (table) => table.name === 'workflow_graph_child_completion_consumptions',
    )!;
    const foreignKeys = objects(consumption.foreign_keys);

    expect(
      foreignKeys.find(
        (foreignKey) =>
          foreignKey.relation_id === 'fk:child_consumptions:child_scope',
      )?.source_columns,
    ).toEqual(['child_scope_id']);
    expect(
      foreignKeys.find(
        (foreignKey) =>
          foreignKey.relation_id === 'fk:child_consumptions:child_cut',
      )?.source_columns,
    ).toEqual(['child_completion_cut_id']);
    expect(
      foreignKeys.some(
        (foreignKey) =>
          Array.isArray(foreignKey.source_columns) &&
          foreignKey.source_columns.length > 1 &&
          foreignKey.source_columns.includes('child_scope_id'),
      ),
    ).toBe(false);

    const triggers = objects(manifest.payload.triggers).filter(
      (trigger) =>
        trigger.table === 'workflow_graph_child_completion_consumptions',
    );
    expect(triggers).toEqual([]);

    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-g6-readiness-audit-'),
    );
    try {
      const store = WorkflowRuntimeConnectionFactory.openStore({
        databasePath: path.join(root, 'workflow-runtime.db'),
        databaseMode: 'create',
        identityMode: 'candidate_development',
      });
      try {
        const physicalColumns = store.queryAll<{ name: string }>(
          `SELECT name
             FROM pragma_table_info('workflow_graph_child_completion_consumptions')
            ORDER BY cid`,
          [],
        );
        expect(physicalColumns.map((column) => column.name)).toEqual(
          objects(consumption.columns).map((column) => column.name),
        );

        const physicalForeignKeys = store.queryAll<{
          id: number;
          source_column: string;
        }>(
          `SELECT id, "from" AS source_column
             FROM pragma_foreign_key_list('workflow_graph_child_completion_consumptions')
            ORDER BY id, seq`,
          [],
        );
        expect(
          new Set(physicalForeignKeys.map((foreignKey) => foreignKey.id)).size,
        ).toBe(5);
        const physicalForeignKeyColumns = new Map<number, string[]>();
        for (const foreignKey of physicalForeignKeys) {
          const sourceColumns =
            physicalForeignKeyColumns.get(foreignKey.id) ?? [];
          sourceColumns.push(foreignKey.source_column);
          physicalForeignKeyColumns.set(foreignKey.id, sourceColumns);
        }
        expect(
          [...physicalForeignKeyColumns.values()].some(
            (sourceColumns) =>
              sourceColumns.includes('child_scope_id') &&
              sourceColumns.includes('child_completion_cut_id'),
          ),
        ).toBe(false);

        expect(
          store.queryAll<{ name: string }>(
            `SELECT name
               FROM sqlite_schema
              WHERE type = 'trigger'
                AND tbl_name = ?
              ORDER BY name`,
            ['workflow_graph_child_completion_consumptions'],
          ),
        ).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
