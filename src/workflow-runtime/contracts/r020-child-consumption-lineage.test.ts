import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildR020ChildConsumptionLineageArtifactsForTest,
  checkR020ChildConsumptionLineageContract,
  R020_CONTRACT_PATH,
  R020_SPEC_HEADING,
} from './r020-child-consumption-lineage-contract.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { LogicalTableMetadata } from './logical-schema-types.js';
import type { JsonObject } from './types.js';
import {
  buildChildCompletionLineageSchemaPrerequisiteArtifact,
  CHILD_COMPLETION_LINEAGE_QUERY,
} from '../store/schema/child-completion-lineage-source.js';
import {
  renderMigration,
  renderSchema7To8Upgrade,
} from '../store/schema/ddl.js';
import { calculateDatabaseSqliteSchemaIdentity } from '../store/schema/database-identity.js';
import {
  loadExecutableSchemaSource,
  loadSchema7ExecutableSchemaSource,
} from '../store/schema/source.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../store/runtime-store/profile.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const schema8 = loadExecutableSchemaSource();
const schema7 = loadSchema7ExecutableSchemaSource();
const schema8Migration = renderMigration(schema8);
const schema7Migration = renderMigration(schema7);
const schema7To8Upgrade = renderSchema7To8Upgrade(schema7, schema8);

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function defaultValue(
  tableName: string,
  column: LogicalTableMetadata['columns'][number],
  suffix: string,
): string | number | null {
  if (column.nullable) return null;
  if (column.enum_values.length > 0) return column.enum_values[0];
  if (column.logical_type === 'integer') {
    return column.safe_integer_intent === 'positive' ? 1 : 0;
  }
  if (column.logical_type === 'boolean_integer') return 0;
  if (column.logical_type === 'hash') {
    return hash(`${tableName}:${column.name}:${suffix}`);
  }
  if (column.logical_type === 'canonical_json') return '{}';
  return `${tableName}:${column.name}:${suffix}`;
}

function seedRow(
  database: Database.Database,
  source: typeof schema8,
  tableName: string,
  overrides: Record<string, string | number | null>,
  suffix: string,
): void {
  const table = source.tables.find((candidate) => candidate.name === tableName);
  if (!table) throw new Error(`Missing seed table ${tableName}`);
  const columns = table.columns.filter(
    (column) =>
      !(
        table.primary_key.auto_increment_intent &&
        table.primary_key.columns[0] === column.name
      ),
  );
  const values = columns.map((column) =>
    Object.hasOwn(overrides, column.name)
      ? overrides[column.name]!
      : defaultValue(tableName, column, suffix),
  );
  database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
}

interface Lineage {
  run: string;
  parent: string;
  owner: string;
  child: string;
  cut: string;
  mapSlot: string;
  eventSeq: number;
}

function seedLineage(
  database: Database.Database,
  source: typeof schema8,
  lineage: Lineage,
): void {
  const suffix = lineage.run;
  seedRow(
    database,
    source,
    'workflow_graph_scopes',
    {
      id: lineage.parent,
      graph_run_id: lineage.run,
      parent_scope_id: null,
      owner_node_id: null,
    },
    `${suffix}:parent`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_nodes',
    {
      id: lineage.owner,
      graph_run_id: lineage.run,
      scope_id: lineage.parent,
    },
    `${suffix}:owner`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_scopes',
    {
      id: lineage.child,
      graph_run_id: lineage.run,
      parent_scope_id: lineage.parent,
      owner_node_id: lineage.owner,
    },
    `${suffix}:child`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_completion_cuts',
    {
      id: lineage.cut,
      graph_run_id: lineage.run,
      scope_id: lineage.child,
    },
    `${suffix}:cut`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_events',
    { graph_run_id: lineage.run, seq: lineage.eventSeq },
    `${suffix}:event`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_map_item_results',
    {
      id: lineage.mapSlot,
      graph_run_id: lineage.run,
      owner_scope_id: lineage.parent,
      owner_node_id: lineage.owner,
      scope_id: lineage.child,
      item_index: 2,
      outcome_state: 'completed',
    },
    `${suffix}:map`,
  );
}

const lineageA: Lineage = {
  run: 'run-a',
  parent: 'parent-a',
  owner: 'owner-a',
  child: 'child-a',
  cut: 'cut-a',
  mapSlot: 'map-a',
  eventSeq: 1,
};
const lineageB: Lineage = {
  run: 'run-b',
  parent: 'parent-b',
  owner: 'owner-b',
  child: 'child-b',
  cut: 'cut-b',
  mapSlot: 'map-b',
  eventSeq: 2,
};
const sameRunSibling: Lineage = {
  run: lineageA.run,
  parent: lineageA.parent,
  owner: lineageA.owner,
  child: 'child-a-sibling',
  cut: 'cut-a-sibling',
  mapSlot: 'map-a-sibling',
  eventSeq: 3,
};

function seedSiblingLineage(
  database: Database.Database,
  source: typeof schema8,
  lineage: Lineage,
): void {
  const suffix = `${lineage.run}:${lineage.child}`;
  seedRow(
    database,
    source,
    'workflow_graph_scopes',
    {
      id: lineage.child,
      graph_run_id: lineage.run,
      parent_scope_id: lineage.parent,
      owner_node_id: lineage.owner,
    },
    `${suffix}:child`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_completion_cuts',
    {
      id: lineage.cut,
      graph_run_id: lineage.run,
      scope_id: lineage.child,
    },
    `${suffix}:cut`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_events',
    { graph_run_id: lineage.run, seq: lineage.eventSeq },
    `${suffix}:event`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_map_item_results',
    {
      id: lineage.mapSlot,
      graph_run_id: lineage.run,
      owner_scope_id: lineage.parent,
      owner_node_id: lineage.owner,
      scope_id: lineage.child,
      outcome_state: 'completed',
    },
    `${suffix}:map`,
  );
}

function withSeededDatabase(
  source: typeof schema8,
  migrationSql: string,
  callback: (database: Database.Database, databasePath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-r020-'));
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createMigratedDatabase(databasePath, migrationSql);
  try {
    database.pragma('foreign_keys = OFF');
    database.pragma('ignore_check_constraints = ON');
    seedLineage(database, source, lineageA);
    seedLineage(database, source, lineageB);
    seedSiblingLineage(database, source, sameRunSibling);
    database.pragma('ignore_check_constraints = OFF');
    database.pragma('foreign_keys = ON');
    callback(database, databasePath);
  } finally {
    if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function insertConsumption(
  database: Database.Database,
  values: Partial<{
    id: string;
    graphRun: string;
    child: string;
    cut: string;
    parent: string;
    owner: string;
    mapSlot: string | null;
    mapOutcome: string | null;
    disposition: string;
    eventSeq: number;
  }> = {},
): void {
  const row = {
    id: 'consumption-a',
    graphRun: lineageA.run,
    child: lineageA.child,
    cut: lineageA.cut,
    parent: lineageA.parent,
    owner: lineageA.owner,
    mapSlot: lineageA.mapSlot,
    mapOutcome: 'completed',
    disposition: 'map_slot_completed',
    eventSeq: lineageA.eventSeq,
    ...values,
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO workflow_graph_child_completion_consumptions
         (id, graph_run_id, child_scope_id, child_completion_cut_id,
          parent_scope_id, owner_node_id, map_slot_id,
          map_slot_outcome_state, disposition, parent_work_fence_epoch,
          disposition_event_seq, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
      )
      .run(
        row.id,
        row.graphRun,
        row.child,
        row.cut,
        row.parent,
        row.owner,
        row.mapSlot,
        row.mapOutcome,
        row.disposition,
        row.eventSeq,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function insertSchema7Consumption(
  database: Database.Database,
  values: Partial<{
    id: string;
    child: string;
    cut: string;
    parent: string;
    owner: string;
    mapSlot: string | null;
    disposition: string;
    eventSeq: number;
  }> = {},
): void {
  const row = {
    id: 'schema7-consumption',
    child: lineageA.child,
    cut: lineageA.cut,
    parent: lineageA.parent,
    owner: lineageA.owner,
    mapSlot: null,
    disposition: 'owner_output_published',
    eventSeq: lineageA.eventSeq,
    ...values,
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO workflow_graph_child_completion_consumptions
         (id, child_scope_id, child_completion_cut_id, parent_scope_id,
          owner_node_id, map_slot_id, disposition,
          parent_work_fence_epoch, disposition_event_seq, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
      )
      .run(
        row.id,
        row.child,
        row.cut,
        row.parent,
        row.owner,
        row.mapSlot,
        row.disposition,
        row.eventSeq,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function expectConsumptionRejected(
  overrides: Parameters<typeof insertConsumption>[1],
): void {
  withSeededDatabase(schema8, schema8Migration.sql, (database) => {
    expect(() => insertConsumption(database, overrides)).toThrow();
    expect(
      database
        .prepare(
          'SELECT count(*) FROM workflow_graph_child_completion_consumptions',
        )
        .pluck()
        .get(),
    ).toBe(0);
  });
}

describe('R-020 child cut / parent consumption database lineage', () => {
  it('binds the normative section, Contract, prerequisite, Logical table, typed relations, query, DDL, and introspection exactly', () => {
    const pack = checkR020ChildConsumptionLineageContract();
    expect(pack.payload).toMatchObject({
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      g6_production_implementation_count: 0,
      g7_through_g9_status: 'NOT_READY',
    });
    const prerequisite =
      buildChildCompletionLineageSchemaPrerequisiteArtifact();
    const prerequisiteBytes = fs.readFileSync(
      path.join(
        projectRoot,
        'src/workflow-runtime/store/schema/inputs/workflow-child-completion-lineage-schema-prerequisite@1.json',
      ),
    );
    expect(
      parseContractArtifactEnvelope(strictParseJsonBytes(prerequisiteBytes)),
    ).toEqual(prerequisite);
    const table = schema8.tables.find(
      (candidate) =>
        candidate.name === 'workflow_graph_child_completion_consumptions',
    )!;
    const typed = prerequisite.payload.typed_relations as Array<{
      relation_id: string;
      source_columns: string[];
      target_table: string;
      target_columns: string[];
    }>;
    expect(
      typed.map(
        ({ relation_id, source_columns, target_table, target_columns }) => ({
          relation_id,
          source_columns,
          target_table,
          target_columns,
        }),
      ),
    ).toEqual(
      table.foreign_keys.map(
        ({ relation_id, source_columns, target_table, target_columns }) => ({
          relation_id,
          source_columns,
          target_table,
          target_columns,
        }),
      ),
    );
    expect(schema8.queries.at(-1)).toEqual(CHILD_COMPLETION_LINEAGE_QUERY);
    const manifest = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(
          path.join(
            projectRoot,
            'src/workflow-runtime/store/schema/artifacts/workflow-runtime-schema-manifest@2.json',
          ),
        ),
      ),
    );
    const physical = (manifest.payload.tables as JsonObject[]).find(
      (candidate) => candidate.name === table.name,
    )!;
    const typedCore = typed.map(
      ({ relation_id, source_columns, target_table, target_columns }) => ({
        relation_id,
        source_columns,
        target_table,
        target_columns,
      }),
    );
    expect(
      (physical.foreign_keys as JsonObject[]).map((relation) => ({
        relation_id: relation.relation_id,
        source_columns: relation.source_columns,
        target_table: relation.target_table,
        target_columns: relation.target_columns,
      })),
    ).toEqual(typedCore);
    expect(schema8Migration.sql).toContain(
      'CONSTRAINT "fk:child_consumptions:child_cut_lineage" FOREIGN KEY ("graph_run_id", "child_scope_id", "child_completion_cut_id")',
    );

    const document = fs.readFileSync(
      path.join(projectRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
      'utf8',
    );
    const changed = document.replace(
      '不采用应用层查询、boolean preauthorization',
      '采用应用层查询、boolean preauthorization',
    );
    expect(document).toContain(R020_SPEC_HEADING);
    expect(
      buildR020ChildConsumptionLineageArtifactsForTest(changed).get(
        R020_CONTRACT_PATH,
      ),
    ).not.toBe(
      buildR020ChildConsumptionLineageArtifactsForTest(document).get(
        R020_CONTRACT_PATH,
      ),
    );
  });

  it('commits same-lineage consumption, reopens it, and rejects a second parent consumption', () => {
    withSeededDatabase(
      schema8,
      schema8Migration.sql,
      (database, databasePath) => {
        insertConsumption(database);
        expect(
          database
            .prepare(
              'SELECT graph_run_id, child_scope_id, child_completion_cut_id FROM workflow_graph_child_completion_consumptions',
            )
            .get(),
        ).toEqual({
          graph_run_id: lineageA.run,
          child_scope_id: lineageA.child,
          child_completion_cut_id: lineageA.cut,
        });
        expect(
          database
            .prepare(
              "SELECT count(*) FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
            )
            .pluck()
            .get(),
        ).toBe(0);
        database.close();
        const reopened = new Database(databasePath);
        try {
          reopened.pragma('foreign_keys = ON');
          expect(
            reopened
              .prepare(
                'SELECT id FROM workflow_graph_child_completion_consumptions WHERE graph_run_id = ? AND child_scope_id = ?',
              )
              .pluck()
              .get(lineageA.run, lineageA.child),
          ).toBe('consumption-a');
          expect(() =>
            insertConsumption(reopened, { id: 'consumption-replay' }),
          ).toThrow();
        } finally {
          reopened.close();
        }
      },
    );
  });

  it('fails closed on cross-scope, cross-run, parent, owner, map-slot, terminal-outcome, and Event lineage splices', () => {
    expectConsumptionRejected({ cut: sameRunSibling.cut });
    expectConsumptionRejected({ cut: lineageB.cut });
    expectConsumptionRejected({ graphRun: lineageB.run });
    expectConsumptionRejected({ child: sameRunSibling.child });
    expectConsumptionRejected({
      parent: lineageB.parent,
      owner: lineageB.owner,
    });
    expectConsumptionRejected({ owner: lineageB.owner });
    expectConsumptionRejected({ mapSlot: sameRunSibling.mapSlot });
    expectConsumptionRejected({ mapSlot: lineageB.mapSlot });
    expectConsumptionRejected({
      disposition: 'map_slot_fenced',
      mapOutcome: 'fenced',
    });
    expectConsumptionRejected({ eventSeq: lineageB.eventSeq });
  });

  it('reproducibly upgrades valid nonempty Schema 7 and rolls cross-lineage history back to exact Schema 7', () => {
    withSeededDatabase(schema7, schema7Migration.sql, (database) => {
      insertSchema7Consumption(database, { id: 'schema7-valid' });
      database.pragma('foreign_keys = OFF');
      database.exec('BEGIN IMMEDIATE');
      database.exec(schema7To8Upgrade.sql);
      expect(
        database
          .prepare(
            "SELECT * FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
          )
          .all(),
      ).toEqual([]);
      database.exec('COMMIT');
      database.pragma('foreign_keys = ON');
      expect(database.pragma('user_version', { simple: true })).toBe(8);
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
      );
      expect(
        database
          .prepare(
            'SELECT graph_run_id, map_slot_outcome_state FROM workflow_graph_child_completion_consumptions',
          )
          .get(),
      ).toEqual({ graph_run_id: lineageA.run, map_slot_outcome_state: null });
    });

    const invalidHistory = [
      ['same-run-cross-scope-cut', { cut: sameRunSibling.cut }],
      ['cross-run-cut', { cut: lineageB.cut }],
      [
        'cross-run-parent-owner',
        { parent: lineageB.parent, owner: lineageB.owner },
      ],
      [
        'same-run-wrong-map-child',
        {
          mapSlot: sameRunSibling.mapSlot,
          disposition: 'map_slot_completed',
        },
      ],
      [
        'cross-run-map-slot',
        { mapSlot: lineageB.mapSlot, disposition: 'map_slot_completed' },
      ],
      [
        'wrong-map-terminal-outcome',
        { mapSlot: lineageA.mapSlot, disposition: 'map_slot_fenced' },
      ],
      ['cross-run-event', { eventSeq: lineageB.eventSeq }],
    ] as const;
    for (const [id, overrides] of invalidHistory) {
      withSeededDatabase(schema7, schema7Migration.sql, (database) => {
        insertSchema7Consumption(database, {
          id: `schema7-${id}`,
          ...overrides,
        });
        const beforeIdentity = calculateDatabaseSqliteSchemaIdentity(database);
        const beforeRows = database
          .prepare('SELECT * FROM workflow_graph_child_completion_consumptions')
          .all();
        database.pragma('foreign_keys = OFF');
        database.exec('BEGIN IMMEDIATE');
        database.exec(schema7To8Upgrade.sql);
        const violations = database
          .prepare(
            "SELECT * FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
          )
          .all();
        expect(violations.length).toBeGreaterThan(0);
        database.exec('ROLLBACK');
        database.pragma('foreign_keys = ON');
        expect(database.pragma('user_version', { simple: true })).toBe(7);
        expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
          beforeIdentity,
        );
        expect(
          database
            .prepare(
              'SELECT * FROM workflow_graph_child_completion_consumptions',
            )
            .all(),
        ).toEqual(beforeRows);
      });
    }
  });

  it('keeps every historical Schema 5/6/7 migration and existing upgrade byte-exact', () => {
    const expected = new Map([
      [
        'workflow-runtime-schema-v1.sql',
        '2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
      ],
      [
        'workflow-runtime-schema-v6.sql',
        '16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
      ],
      [
        'workflow-runtime-schema-v7.sql',
        'b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
      ],
      [
        'workflow-runtime-schema-v3-to-v4.sql',
        '5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
      ],
      [
        'workflow-runtime-schema-v4-to-v5.sql',
        '97479810c2c079d71270d5a714faa4b8fa8ebd6af629ef2f7d772af270c2bb0a',
      ],
      [
        'workflow-runtime-schema-v5-to-v6.sql',
        'dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d',
      ],
      [
        'workflow-runtime-schema-v6-to-v7.sql',
        '225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062',
      ],
    ]);
    for (const [file, expectedHash] of expected) {
      const bytes = fs.readFileSync(
        path.join(
          projectRoot,
          'src/workflow-runtime/store/schema/migration',
          file,
        ),
      );
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
        expectedHash,
      );
    }
  });
});
