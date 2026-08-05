import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  buildR021MapTerminalConsumptionArtifactsForTest,
  checkR021MapTerminalConsumptionContract,
  R021_CONTRACT_PATH,
  R021_SPEC_HEADING,
} from './r021-map-terminal-consumption-contract.js';
import type { LogicalTableMetadata } from './logical-schema-types.js';
import {
  buildMapTerminalConsumptionSchemaPrerequisiteArtifact,
  MAP_TERMINAL_DISPOSITIONS,
  MAP_TERMINAL_OUTCOMES,
  NON_MAP_CHILD_CONSUMPTION_DISPOSITIONS,
} from '../store/schema/map-terminal-consumption-source.js';
import {
  renderMigration,
  renderSchema8To9Upgrade,
} from '../store/schema/ddl.js';
import { calculateDatabaseSqliteSchemaIdentity } from '../store/schema/database-identity.js';
import {
  loadExecutableSchemaSource,
  loadSchema8ExecutableSchemaSource,
} from '../store/schema/source.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';
import { WorkflowRuntimeConnectionFactory } from '../store/runtime-store/index.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../store/runtime-store/profile.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const schema9 = loadExecutableSchemaSource();
const schema8 = loadSchema8ExecutableSchemaSource();
const schema9Migration = renderMigration(schema9);
const schema8Migration = renderMigration(schema8);
const schema8To9Upgrade = renderSchema8To9Upgrade(schema8, schema9);

type Source = typeof schema9;
type TerminalOutcome = (typeof MAP_TERMINAL_OUTCOMES)[number];

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
  source: Source,
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
  database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(
      ...columns.map((column) =>
        Object.hasOwn(overrides, column.name)
          ? overrides[column.name]!
          : defaultValue(tableName, column, suffix),
      ),
    );
}

interface Lineage {
  suffix: string;
  run: string;
  parent: string;
  owner: string;
  child: string;
  cut: string;
  mapSlot: string | null;
  eventSeq: number;
  terminalOutcome: TerminalOutcome | null;
}

function lineage(suffix: string, outcome: TerminalOutcome | null): Lineage {
  return {
    suffix,
    run: `run:${suffix}`,
    parent: `parent:${suffix}`,
    owner: `owner:${suffix}`,
    child: `child:${suffix}`,
    cut: `cut:${suffix}`,
    mapSlot: outcome ? `slot:${suffix}` : null,
    eventSeq: Number(suffix.replaceAll(/\D/g, '')) + 1,
    terminalOutcome: outcome,
  };
}

function seedLineage(
  database: Database.Database,
  source: Source,
  value: Lineage,
  ownerNodeType = value.terminalOutcome ? 'map' : 'subgraph',
): void {
  seedRow(
    database,
    source,
    'workflow_graph_scopes',
    {
      id: value.parent,
      graph_run_id: value.run,
      parent_scope_id: null,
      owner_node_id: null,
    },
    `${value.suffix}:parent`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_nodes',
    {
      id: value.owner,
      graph_run_id: value.run,
      scope_id: value.parent,
      node_type: ownerNodeType,
    },
    `${value.suffix}:owner`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_scopes',
    {
      id: value.child,
      graph_run_id: value.run,
      parent_scope_id: value.parent,
      owner_node_id: value.owner,
      scope_kind: value.terminalOutcome ? 'map_item' : 'subgraph',
    },
    `${value.suffix}:child`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_completion_cuts',
    {
      id: value.cut,
      graph_run_id: value.run,
      scope_id: value.child,
      outcome_kind:
        value.terminalOutcome === 'completed'
          ? 'completed'
          : value.terminalOutcome === 'errored'
            ? 'errored'
            : 'cancelled',
    },
    `${value.suffix}:cut`,
  );
  seedRow(
    database,
    source,
    'workflow_graph_events',
    {
      graph_run_id: value.run,
      seq: value.eventSeq,
      event_type: 'child_completion_consumed',
    },
    `${value.suffix}:event`,
  );
  if (value.terminalOutcome && value.mapSlot) {
    seedRow(
      database,
      source,
      'workflow_graph_map_item_results',
      {
        id: value.mapSlot,
        graph_run_id: value.run,
        owner_scope_id: value.parent,
        owner_node_id: value.owner,
        scope_id: value.child,
        item_index: value.eventSeq,
        outcome_state: value.terminalOutcome,
      },
      `${value.suffix}:slot`,
    );
  }
}

function withDatabase(
  source: Source,
  migrationSql: string,
  lineages: readonly Lineage[],
  callback: (database: Database.Database, databasePath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-r021-'));
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createMigratedDatabase(databasePath, migrationSql);
  try {
    database.pragma('foreign_keys = OFF');
    database.pragma('ignore_check_constraints = ON');
    for (const value of lineages) seedLineage(database, source, value);
    database.pragma('ignore_check_constraints = OFF');
    database.pragma('foreign_keys = ON');
    callback(database, databasePath);
  } finally {
    if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

interface ConsumptionOverrides {
  id?: string;
  graphRun?: string;
  child?: string;
  cut?: string;
  parent?: string;
  owner?: string;
  mapSlot?: string | null;
  mapOutcome?: string | null;
  disposition?: string;
  eventSeq?: number;
}

function insertConsumption(
  database: Database.Database,
  value: Lineage,
  overrides: ConsumptionOverrides = {},
): void {
  const terminalIndex = value.terminalOutcome
    ? MAP_TERMINAL_OUTCOMES.indexOf(value.terminalOutcome)
    : -1;
  const row = {
    id: `consumption:${value.suffix}`,
    graphRun: value.run,
    child: value.child,
    cut: value.cut,
    parent: value.parent,
    owner: value.owner,
    mapSlot: value.mapSlot,
    mapOutcome: value.terminalOutcome,
    disposition:
      terminalIndex >= 0
        ? MAP_TERMINAL_DISPOSITIONS[terminalIndex]
        : 'owner_output_published',
    eventSeq: value.eventSeq,
    ...overrides,
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

function consumptionRows(database: Database.Database): unknown[] {
  return database
    .prepare(
      'SELECT * FROM workflow_graph_child_completion_consumptions ORDER BY id',
    )
    .all();
}

const terminals = MAP_TERMINAL_OUTCOMES.map((outcome, index) =>
  lineage(`terminal-${index}`, outcome),
);

describe('R-021 map terminal consumption directed repair', () => {
  it('machine-binds the unique spec, Contract, prerequisite, and pending-regression boundary', () => {
    const pack = checkR021MapTerminalConsumptionContract();
    expect(pack.payload).toMatchObject({
      gate: 'R-021_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      affected_gate_status: 'IN_PROGRESS',
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
    });
    const prerequisite =
      buildMapTerminalConsumptionSchemaPrerequisiteArtifact();
    expect(prerequisite.payload).toMatchObject({
      decision_id: 'R-021',
      database_schema_version: 9,
      predecessor_database_schema_version: 8,
    });
    const document = fs.readFileSync(
      path.join(
        projectRoot,
        'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      ),
      'utf8',
    );
    const changed = document.replace(
      'wrong disposition/outcome',
      'changed disposition/outcome',
    );
    expect(document).toContain(R021_SPEC_HEADING);
    expect(
      buildR021MapTerminalConsumptionArtifactsForTest(changed).get(
        R021_CONTRACT_PATH,
      ),
    ).not.toBe(
      buildR021MapTerminalConsumptionArtifactsForTest(document).get(
        R021_CONTRACT_PATH,
      ),
    );
  });

  it('commits, reopens, and exact-replays all four real map-slot terminal tuples', () => {
    withDatabase(
      schema9,
      schema9Migration.sql,
      terminals,
      (database, dbPath) => {
        for (const value of terminals) insertConsumption(database, value);
        expect(
          database
            .prepare(
              `SELECT disposition, map_slot_outcome_state
               FROM workflow_graph_child_completion_consumptions
              ORDER BY map_slot_outcome_state`,
            )
            .all(),
        ).toEqual(
          MAP_TERMINAL_OUTCOMES.map((outcome, index) => ({
            disposition: MAP_TERMINAL_DISPOSITIONS[index],
            map_slot_outcome_state: outcome,
          })).sort((left, right) =>
            left.map_slot_outcome_state.localeCompare(
              right.map_slot_outcome_state,
            ),
          ),
        );
        expect(
          database
            .prepare(
              "SELECT count(*) FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
            )
            .pluck()
            .get(),
        ).toBe(0);
        const before = consumptionRows(database);
        database.close();
        const reopened = new Database(dbPath);
        try {
          reopened.pragma('foreign_keys = ON');
          expect(consumptionRows(reopened)).toEqual(before);
          for (const value of terminals) {
            expect(() =>
              insertConsumption(reopened, value, {
                id: `replay:${value.suffix}`,
              }),
            ).toThrow();
          }
          expect(consumptionRows(reopened)).toEqual(before);
        } finally {
          reopened.close();
        }
      },
    );
  });

  it.each(NON_MAP_CHILD_CONSUMPTION_DISPOSITIONS)(
    'keeps non-map disposition %s mutually slotless and outcome-less',
    (disposition) => {
      const value = lineage(`non-map-${disposition}`, null);
      const wrong = lineage(`non-map-wrong-${disposition}`, null);
      withDatabase(
        schema9,
        schema9Migration.sql,
        [value, wrong],
        (database) => {
          insertConsumption(database, value, { disposition });
          expect(consumptionRows(database)).toHaveLength(1);
          expect(() =>
            insertConsumption(database, wrong, {
              mapSlot: 'forbidden-slot',
              mapOutcome: 'completed',
              disposition,
            }),
          ).toThrow();
        },
      );
    },
  );

  it('fails closed on wrong pair, missing fields, every exact lineage splice, and duplicate consumption', () => {
    withDatabase(schema9, schema9Migration.sql, terminals, (database) => {
      const first = terminals[0];
      const second = terminals[1];
      const cases: ConsumptionOverrides[] = [
        { disposition: 'map_slot_errored', mapOutcome: 'completed' },
        { disposition: 'map_slot_completed', mapOutcome: 'errored' },
        { mapSlot: null },
        { mapOutcome: null },
        { graphRun: second.run },
        { child: second.child },
        { cut: second.cut },
        { parent: second.parent, owner: second.owner },
        { owner: second.owner },
        { mapSlot: second.mapSlot },
        { eventSeq: second.eventSeq },
      ];
      for (const [index, overrides] of cases.entries()) {
        expect(
          () =>
            insertConsumption(database, first, {
              id: `invalid:${index}`,
              ...overrides,
            }),
          `negative case ${index}: ${JSON.stringify(overrides)}`,
        ).toThrow();
        expect(consumptionRows(database)).toEqual([]);
      }
      insertConsumption(database, first);
      const committed = consumptionRows(database);
      expect(() =>
        insertConsumption(database, first, { id: 'duplicate' }),
      ).toThrow();
      expect(consumptionRows(database)).toEqual(committed);
    });
  });

  it('surfaces map-slot outcome tamper and rejects current sqlite_schema identity drift on Store reopen', () => {
    withDatabase(schema9, schema9Migration.sql, [terminals[0]], (database) => {
      insertConsumption(database, terminals[0]);
      database.pragma('foreign_keys = OFF');
      database.pragma('ignore_check_constraints = ON');
      database
        .prepare(
          'UPDATE workflow_graph_map_item_results SET outcome_state = ? WHERE id = ?',
        )
        .run('errored', terminals[0].mapSlot);
      database.pragma('ignore_check_constraints = OFF');
      expect(
        database
          .prepare(
            "SELECT count(*) FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
          )
          .pluck()
          .get(),
      ).toBeGreaterThan(0);
    });
  });

  it('upgrades legal nonempty Schema 8 row-for-row and rolls invalid history or copy faults back exactly', () => {
    const historical = [
      lineage('history-completed-10', 'completed'),
      lineage('history-fenced-11', 'fenced'),
      lineage('history-owner-12', null),
      lineage('history-parent-fence-13', null),
      lineage('history-owner-fence-14', null),
    ];
    withDatabase(
      schema8,
      schema8Migration.sql,
      historical,
      (database, dbPath) => {
        insertConsumption(database, historical[0]);
        insertConsumption(database, historical[1]);
        insertConsumption(database, historical[2], {
          disposition: 'owner_output_published',
        });
        insertConsumption(database, historical[3], {
          disposition: 'non_publish_parent_fenced',
        });
        insertConsumption(database, historical[4], {
          disposition: 'non_publish_owner_fenced',
        });
        const before = consumptionRows(database);
        database.pragma('foreign_keys = OFF');
        database.exec('BEGIN IMMEDIATE');
        database.exec(schema8To9Upgrade.sql);
        expect(
          database
            .prepare(
              "SELECT * FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
            )
            .all(),
        ).toEqual([]);
        database.exec('COMMIT');
        database.pragma('foreign_keys = ON');
        expect(database.pragma('user_version', { simple: true })).toBe(9);
        expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
          CURRENT_G1_SCHEMA_IDENTITIES.schema9SourceSqliteSchema,
        );
        expect(consumptionRows(database)).toEqual(before);
        database.close();
        const reopened = new Database(dbPath, { readonly: true });
        try {
          expect(consumptionRows(reopened)).toEqual(before);
        } finally {
          reopened.close();
        }
      },
    );

    const invalid = [
      lineage('invalid-a-20', 'completed'),
      lineage('invalid-b-21', 'completed'),
    ];
    withDatabase(schema8, schema8Migration.sql, invalid, (database) => {
      insertConsumption(database, invalid[0]);
      database.pragma('foreign_keys = OFF');
      database
        .prepare(
          `UPDATE workflow_graph_child_completion_consumptions
              SET map_slot_id = ?
            WHERE child_scope_id = ?`,
        )
        .run(invalid[1].mapSlot, invalid[0].child);
      const beforeIdentity = calculateDatabaseSqliteSchemaIdentity(database);
      const before = consumptionRows(database);
      database.exec('BEGIN IMMEDIATE');
      database.exec(schema8To9Upgrade.sql);
      expect(
        database
          .prepare(
            "SELECT count(*) FROM pragma_foreign_key_check('workflow_graph_child_completion_consumptions')",
          )
          .pluck()
          .get(),
      ).toBeGreaterThan(0);
      database.exec('ROLLBACK');
      database.pragma('foreign_keys = ON');
      expect(database.pragma('user_version', { simple: true })).toBe(8);
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        beforeIdentity,
      );
      expect(consumptionRows(database)).toEqual(before);
    });

    withDatabase(schema8, schema8Migration.sql, [historical[0]], (database) => {
      insertConsumption(database, historical[0]);
      const beforeIdentity = calculateDatabaseSqliteSchemaIdentity(database);
      const before = consumptionRows(database);
      const faultSql = schema8To9Upgrade.sql.replace(
        'DROP TABLE "workflow_graph_child_completion_consumptions_schema8";',
        'SELECT * FROM "missing_r021_copy_fault";\n\nDROP TABLE "workflow_graph_child_completion_consumptions_schema8";',
      );
      database.pragma('foreign_keys = OFF');
      database.exec('BEGIN IMMEDIATE');
      expect(() => database.exec(faultSql)).toThrow('missing_r021_copy_fault');
      database.exec('ROLLBACK');
      database.pragma('foreign_keys = ON');
      expect(database.pragma('user_version', { simple: true })).toBe(8);
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        beforeIdentity,
      );
      expect(consumptionRows(database)).toEqual(before);
    });
  });

  it('keeps Schema 8 and every earlier frozen migration, upgrade, and @2 artifact byte-exact', () => {
    const expected = new Map([
      [
        'migration/workflow-runtime-schema-v1.sql',
        '2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
      ],
      [
        'migration/workflow-runtime-schema-v6.sql',
        '16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
      ],
      [
        'migration/workflow-runtime-schema-v7.sql',
        'b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
      ],
      [
        'migration/workflow-runtime-schema-v8.sql',
        'b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad',
      ],
      [
        'migration/workflow-runtime-schema-v3-to-v4.sql',
        '5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
      ],
      [
        'migration/workflow-runtime-schema-v4-to-v5.sql',
        '97479810c2c079d71270d5a714faa4b8fa8ebd6af629ef2f7d772af270c2bb0a',
      ],
      [
        'migration/workflow-runtime-schema-v5-to-v6.sql',
        'dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d',
      ],
      [
        'migration/workflow-runtime-schema-v6-to-v7.sql',
        '225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062',
      ],
      [
        'migration/workflow-runtime-schema-v7-to-v8.sql',
        '544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9',
      ],
    ]);
    const schemaRoot = path.join(
      projectRoot,
      'src/workflow-runtime/store/schema',
    );
    for (const [relativePath, expectedHash] of expected) {
      const bytes = fs.readFileSync(path.join(schemaRoot, relativePath));
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
        expectedHash,
      );
    }
    const schema8Pack = new Map([
      [
        'artifacts/workflow-runtime-schema-dependency-manifest-contract@2.json',
        'a88334112f52c46447ee1ff14d38add808ca5f3cc50319cc967a0bd69ddf7656',
      ],
      [
        'artifacts/workflow-runtime-schema-dependency-manifest@2.json',
        'c6317c5e90a00f5f49ca858841c74c53dd57d22c21367656014e9de87f2fb0be',
      ],
      [
        'artifacts/workflow-runtime-schema-manifest@2.json',
        'ef6e8a6582460efcfff5dd06bc7a06b27e3a20a3c72ab5cd0016c23b91a615ad',
      ],
      [
        'artifacts/workflow-runtime-executable-ddl@2.json',
        '9f276ee9ea7fb2976a3465d09346a4f435a2ce9b1746ee46e19282a9d4cf9009',
      ],
      [
        'artifacts/workflow-runtime-schema-lint@2.json',
        'f532062b185f7bdd95e6b1311f5705e2a8a25aaf6625ea0d3ecd6b917080406b',
      ],
      [
        'catalogs/workflow-runtime-schema-domain-separators@2.json',
        'b4d86aaade08456b47b22287c4565471bd5d35858a5e75a1fe1510627d50f7c4',
      ],
      [
        'fixtures/workflow-runtime-constraint-trigger-fixtures@2.json',
        'a3791d610fc9f4dfc4279f5d3ae4b76ae13c8a0aa168366009b0dd2379220851',
      ],
      [
        'fixtures/workflow-runtime-query-plan-fixtures@2.json',
        '9d68815815618d3ed839e38c03956288a8f6a22c81009c86a3b02df1902a6118',
      ],
      [
        'contract-pack-g1-executable-schema-v8.json',
        '5fee133c4b8493f7fb703d954e01416c7c531914855fcfcdf928078555e5192f',
      ],
    ]);
    for (const [relativePath, expectedHash] of schema8Pack) {
      const bytes = fs.readFileSync(path.join(schemaRoot, relativePath));
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
        expectedHash,
      );
    }
  });
});
