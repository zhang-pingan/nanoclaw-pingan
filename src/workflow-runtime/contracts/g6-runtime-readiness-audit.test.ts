import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { checkR020ChildConsumptionLineageContract } from './r020-child-consumption-lineage-contract.js';
import { checkR021MapTerminalConsumptionContract } from './r021-map-terminal-consumption-contract.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';
import { WorkflowRuntimeConnectionFactory } from '../store/runtime-store/index.js';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');

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
  it('preserves the T7b atomic cut, unique parent consumption, and single map-slot terminal outcome contract', () => {
    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const t7b = objects(transactions.payload.entries).find(
      (entry) => entry.transaction_id === 'T7b',
    )!;
    expect(t7b).toMatchObject({
      name: 'child_database_finalizer_and_consumer',
      atomic_writes: expect.arrayContaining([
        'child_completion_cut',
        'unique_parent_consumption_disposition',
      ]),
      idempotency_constraints: expect.arrayContaining([
        'unique_child_scope_cut',
        'unique_child_scope_consumption',
        'single_map_slot_terminal_outcome',
      ]),
    });
  });

  it('preserves R-020 Schema 8 provenance and selects the R-021 Schema 9 successor while keeping G6 Production at zero', () => {
    const predecessor = checkR020ChildConsumptionLineageContract();
    expect(predecessor.payload).toMatchObject({
      gate: 'R-020_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      g6_production_implementation_count: 0,
    });
    const current = checkR021MapTerminalConsumptionContract();
    expect(current.payload).toMatchObject({
      gate: 'R-021_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      affected_gate_status: 'IN_PROGRESS',
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
    });
    for (const relativePath of [
      'src/workflow-runtime/runtime/g6-dynamic-close.ts',
      'src/workflow-runtime/runtime/child-database-finalizer.ts',
      'src/workflow-runtime/runtime/dynamic-scope-materializer.ts',
      'src/workflow-runtime/runtime/root-finalization-coordinator.ts',
      'src/workflow-runtime/runtime/g6-runtime.ts',
    ]) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  it('proves the current Schema 9 Manifest and a fresh real-file Store expose all six exact composite FKs and four terminal pairs', () => {
    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@3.json',
    );
    expect(manifest.payload.database_schema_version).toBe(9);
    const consumption = objects(manifest.payload.tables).find(
      (table) => table.name === 'workflow_graph_child_completion_consumptions',
    )!;
    const expected = objects(consumption.foreign_keys)
      .map((foreignKey) => foreignKey.source_columns as string[])
      .sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
    expect(expected).toEqual(
      [
        ['graph_run_id', 'child_scope_id', 'parent_scope_id', 'owner_node_id'],
        ['graph_run_id', 'child_scope_id', 'child_completion_cut_id'],
        ['graph_run_id', 'parent_scope_id'],
        ['graph_run_id', 'parent_scope_id', 'owner_node_id'],
        [
          'graph_run_id',
          'parent_scope_id',
          'owner_node_id',
          'map_slot_id',
          'child_scope_id',
          'map_slot_outcome_state',
        ],
        ['graph_run_id', 'disposition_event_seq'],
      ].sort((left, right) => left.join('\0').localeCompare(right.join('\0'))),
    );
    const checks = objects(consumption.checks);
    expect(
      checks.find(
        (check) =>
          check.check_id ===
          'ck:workflow_graph_child_completion_consumptions:disposition:enum',
      )?.expression_sql,
    ).toContain(
      "'map_slot_completed', 'map_slot_errored', 'map_slot_cancelled', 'map_slot_fenced'",
    );
    expect(
      checks.find(
        (check) =>
          check.check_id ===
          'ck:workflow_graph_child_completion_consumptions:map_slot_outcome_state:enum',
      )?.expression_sql,
    ).toContain("'completed', 'errored', 'cancelled', 'fenced'");

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
        expect(
          store.queryOne<{ user_version: number }>('PRAGMA user_version', [])
            ?.user_version,
        ).toBe(9);
        const rows = store.queryAll<{
          id: number;
          seq: number;
          source_column: string;
        }>(
          `SELECT id, seq, "from" AS source_column
             FROM pragma_foreign_key_list('workflow_graph_child_completion_consumptions')
            ORDER BY id, seq`,
          [],
        );
        const grouped = new Map<number, string[]>();
        for (const row of rows) {
          const columns = grouped.get(row.id) ?? [];
          columns.push(row.source_column);
          grouped.set(row.id, columns);
        }
        expect(
          [...grouped.values()].sort((left, right) =>
            left.join('\0').localeCompare(right.join('\0')),
          ),
        ).toEqual(expected);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
