import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { LogicalTableMetadata } from '../../contracts/logical-schema-types.js';
import { checkG1Artifacts } from './artifacts.js';
import { buildQueryFixtures, renderMigration } from './ddl.js';
import {
  assertClosedSchemaManifest,
  reconstructSchemaManifest,
} from './manifest.js';
import { loadExecutableSchemaSource } from './source.js';
import {
  createMigratedDatabase,
  verifyQueryPlans,
  verifyReadOnlyConnection,
} from './sqlite-gate.js';
import type { WorkflowRuntimeSchemaManifestPayload } from './types.js';

const source = loadExecutableSchemaSource();
const migration = renderMigration(source);

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hash(label: string): string {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function table(name: string): LogicalTableMetadata {
  const result = source.tables.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Unknown table ${name}`);
  return result;
}

function defaultValue(
  tableName: string,
  column: LogicalTableMetadata['columns'][number],
  suffix: string,
): string | number | null {
  if (column.nullable) return null;
  if (column.enum_values.length > 0) return column.enum_values[0];
  switch (column.logical_type) {
    case 'integer':
      return column.safe_integer_intent === 'positive' ? 1 : 0;
    case 'boolean_integer':
      return 0;
    case 'hash':
      return hash(`${tableName}:${column.name}:${suffix}`);
    case 'canonical_json':
      return '{}';
    case 'identifier':
    case 'text':
    case 'external_reference':
      return `${tableName}:${column.name}:${suffix}`;
  }
}

function insertRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null> = {},
  suffix: string = crypto.randomUUID(),
): number | bigint {
  const metadata = table(tableName);
  const autoColumn = metadata.primary_key.auto_increment_intent
    ? metadata.primary_key.columns[0]
    : null;
  const columns = metadata.columns.filter(
    (column) => column.name !== autoColumn,
  );
  const values = columns.map((column) =>
    Object.hasOwn(overrides, column.name)
      ? overrides[column.name]
      : defaultValue(tableName, column, suffix),
  );
  return database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values).lastInsertRowid;
}

function seedRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null> = {},
  suffix?: string,
): number | bigint {
  database.pragma('ignore_check_constraints = ON');
  try {
    return insertRow(database, tableName, overrides, suffix);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function withDatabase(
  callback: (database: Database.Database, databasePath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-schema-test-'));
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createMigratedDatabase(databasePath, migration.sql);
  try {
    callback(database, databasePath);
  } finally {
    if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('G1.1 executable workflow runtime schema', () => {
  it('regenerates byte-identical artifacts and a byte-identical introspected manifest', () => {
    const built = checkG1Artifacts();
    expect(built.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.environmentSummary.managed_node_version).toBe('v26.5.0');
    expect(built.environmentSummary.better_sqlite3_version).toBe('12.11.1');
    expect(built.artifacts.at(-1)?.[1].payload).toMatchObject({
      gate: 'G1.1',
      g0_10_root_hash:
        'sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec',
    });
    withDatabase((database, databasePath) => {
      const manifest = reconstructSchemaManifest(
        database,
        source,
        migration.sql,
        migration.statement_count,
        migration.triggers,
      );
      expect(manifest.schema_hash).toBe(built.schemaHash);
      expect(manifest).toEqual(built.manifest.payload);
      verifyQueryPlans(database, buildQueryFixtures(source));
      database.close();
      verifyReadOnlyConnection(databasePath);
    });
  });

  it('rejects unknown fields at every nested Schema Manifest object level', () => {
    const built = checkG1Artifacts();
    const selectors: Array<
      (payload: WorkflowRuntimeSchemaManifestPayload) => object
    > = [
      (payload) => payload,
      (payload) => payload.logical_inputs,
      (payload) => payload.tables[0],
      (payload) => payload.tables[0].columns[0],
      (payload) =>
        payload.tables
          .flatMap((table) => table.columns)
          .find((column) => column.external_reference)?.external_reference ??
        {},
      (payload) => payload.tables[0].primary_key,
      (payload) =>
        payload.tables.find((table) => table.unique_keys.length > 0)
          ?.unique_keys[0] ?? {},
      (payload) =>
        payload.tables.find((table) => table.foreign_keys.length > 0)
          ?.foreign_keys[0] ?? {},
      (payload) =>
        payload.tables.find((table) => table.checks.length > 0)?.checks[0] ??
        {},
      (payload) =>
        payload.tables.find((table) => table.indexes.length > 0)?.indexes[0] ??
        {},
      (payload) => payload.triggers[0],
      (payload) => payload.query_fixtures[0],
    ];
    for (const select of selectors) {
      const payload = structuredClone(
        built.manifest.payload,
      ) as unknown as WorkflowRuntimeSchemaManifestPayload;
      (select(payload) as Record<string, unknown>).unknown_field = true;
      expect(() => assertClosedSchemaManifest(payload)).toThrow(
        'is not closed',
      );
    }
  });

  it('rejects an illegal value through every published enum CHECK', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      let checked = 0;
      for (const metadata of source.tables) {
        for (const column of metadata.columns.filter(
          (candidate) => candidate.enum_values.length > 0,
        )) {
          const checkId = `ck:${metadata.name}:${column.name}:enum`;
          expect(() =>
            insertRow(database, metadata.name, {
              [column.name]: '__invalid_closed_enum__',
            }),
          ).toThrow(checkId);
          checked += 1;
        }
      }
      expect(checked).toBe(
        source.tables.reduce(
          (total, metadata) =>
            total +
            metadata.columns.filter((column) => column.enum_values.length > 0)
              .length,
          0,
        ),
      );
    });
  });

  it('rejects unsafe integers and typed-relation zero/multi target shapes', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      expect(() =>
        insertRow(database, 'workflow_graph_scheduler_admissions', {
          eligible_event_seq: -1,
        }),
      ).toThrow(
        'ck:workflow_graph_scheduler_admissions:eligible_event_seq:safe_integer',
      );
      expect(() =>
        insertRow(database, 'workflow_graph_events', {
          occurred_at_ms: 9007199254740992,
        }),
      ).toThrow('safe_integer');

      expect(() =>
        insertRow(database, 'workflow_graph_resource_accounts', {
          deployment_scope_ref: null,
          workflow_id: null,
          graph_run_id: null,
          scope_id: null,
          node_id: null,
          execution_group_resource_id: null,
          execution_group_resource_hash: null,
        }),
      ).toThrow('exactly_one');
      expect(() =>
        insertRow(database, 'workflow_graph_resource_accounts', {
          deployment_scope_ref: 'deployment',
          workflow_id: 'workflow',
        }),
      ).toThrow('exactly_one');
    });
  });

  it('enforces activation, workflow, attempt, terminal, and blocker state shapes', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      expect(() =>
        insertRow(database, 'workflow_state_activations', {
          state_type: 'terminal',
          status: 'active',
          graph_run_id: 'run',
          terminal_kind: null,
        }),
      ).toThrow('ck:state_activations:type_run');
      expect(() =>
        insertRow(database, 'workflows', {
          status: 'completed',
          operational_state: 'healthy',
          finished_at_ms: null,
        }),
      ).toThrow('ck:workflows:status_time');
      expect(() =>
        insertRow(database, 'workflow_graph_node_attempts', {
          attempt_no: 2,
          continuation_kind: 'initial',
          parent_attempt_id: null,
          parent_attempt_no: null,
        }),
      ).toThrow('ck:node_attempts:continuation');
      expect(() =>
        insertRow(database, 'workflow_graph_completion_cuts', {
          outcome_kind: 'completed',
          exit_name: null,
          output_value_id: null,
          output_hash: null,
          selected_rule_id: null,
          candidate_id: null,
        }),
      ).toThrow('ck:completion_cuts:outcome_shape');
      expect(() =>
        insertRow(database, 'workflow_operational_blockers', {
          source_effect_operation_id: null,
          source_outbox_id: null,
          source_root_finalization_schedule_id: null,
          source_claim_id: null,
          source_event_seq: null,
        }),
      ).toThrow('exactly_one');
      expect(() =>
        insertRow(database, 'workflow_operational_blockers', {
          source_effect_operation_id: 'effect',
          source_outbox_id: 'outbox',
        }),
      ).toThrow('exactly_one');
    });
  });

  it('enforces composite lineage, single successor, idempotency, and root uniqueness', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const runId = 'run:root-unique';
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:root:1',
        graph_run_id: runId,
        parent_scope_id: null,
      });
      expect(() =>
        seedRow(database, 'workflow_graph_scopes', {
          id: 'scope:root:2',
          graph_run_id: runId,
          parent_scope_id: null,
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_runtime_commands', {
        command_id: 'command:1',
        idempotency_domain: 'human:local-owner',
        idempotency_key: 'same',
      });
      expect(() =>
        seedRow(database, 'workflow_runtime_commands', {
          command_id: 'command:2',
          idempotency_domain: 'human:local-owner',
          idempotency_key: 'same',
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_graph_node_attempts', {
        id: 'attempt:parent',
        node_id: 'node:parent',
        attempt_no: 1,
        parent_attempt_id: null,
      });
      seedRow(database, 'workflow_graph_node_attempts', {
        id: 'attempt:child:1',
        node_id: 'node:parent',
        attempt_no: 2,
        parent_attempt_id: 'attempt:parent',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_node_attempts', {
          id: 'attempt:child:2',
          node_id: 'node:other',
          attempt_no: 3,
          parent_attempt_id: 'attempt:parent',
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_graph_scope_close_requests', {
        id: 'close:1',
        graph_run_id: runId,
        scope_id: 'scope:root:1',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_scope_close_requests', {
          id: 'close:2',
          graph_run_id: runId,
          scope_id: 'scope:root:1',
        }),
      ).toThrow('UNIQUE constraint failed');
      seedRow(database, 'workflow_graph_completion_cuts', {
        id: 'cut:1',
        graph_run_id: runId,
        scope_id: 'scope:root:1',
        close_request_id: 'close:1',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_completion_cuts', {
          id: 'cut:2',
          graph_run_id: runId,
          scope_id: 'scope:root:1',
          close_request_id: 'close:2',
        }),
      ).toThrow('UNIQUE constraint failed');
    });

    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      database.pragma('ignore_check_constraints = ON');
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:a',
        workflow_id: 'workflow:a',
      });
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:b',
        workflow_id: 'workflow:b',
      });
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:a',
        graph_run_id: 'run:a',
      });
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:b',
        graph_run_id: 'run:b',
      });
      seedRow(database, 'workflow_graph_nodes', {
        id: 'node:b',
        graph_run_id: 'run:b',
        scope_id: 'scope:b',
      });
      database.pragma('foreign_keys = ON');
      expect(() =>
        insertRow(database, 'workflow_graph_scheduler_admissions', {
          graph_run_id: 'run:a',
          scope_id: 'scope:a',
          node_id: 'node:b',
          attempt_id: 'attempt:b',
        }),
      ).toThrow('FOREIGN KEY constraint failed');
      database.pragma('ignore_check_constraints = OFF');
    });
  });

  it('maintains blocker caches and enforces confirmation and planless-root triggers', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      seedRow(database, 'workflows', {
        id: 'workflow:blocker',
        status: 'active',
        operational_state: 'healthy',
        finished_at_ms: null,
      });
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:blocker',
        workflow_id: 'workflow:blocker',
        operational_state: 'healthy',
      });
      const base = {
        workflow_id: 'workflow:blocker',
        graph_run_id: 'run:blocker',
        source_effect_operation_id: null,
        source_outbox_id: null,
        source_root_finalization_schedule_id: null,
        source_claim_id: null,
        status: 'open',
      } as const;
      insertRow(database, 'workflow_operational_blockers', {
        ...base,
        id: 'blocker:action',
        severity: 'action_required',
        source_event_seq: 1,
      });
      expect(
        database
          .prepare(
            'SELECT operational_state FROM workflow_graph_runs WHERE id = ?',
          )
          .pluck()
          .get('run:blocker'),
      ).toBe('action_required');
      insertRow(database, 'workflow_operational_blockers', {
        ...base,
        id: 'blocker:quarantine',
        severity: 'quarantine',
        source_event_seq: 2,
      });
      expect(
        database
          .prepare('SELECT operational_state FROM workflows WHERE id = ?')
          .pluck()
          .get('workflow:blocker'),
      ).toBe('quarantined');
      database
        .prepare(
          `UPDATE workflow_operational_blockers SET status='resolved', resolved_at_ms=10, resolution_command_id='command:resolve', resolved_event_seq=10 WHERE id='blocker:quarantine'`,
        )
        .run();
      expect(
        database
          .prepare('SELECT operational_state FROM workflows WHERE id = ?')
          .pluck()
          .get('workflow:blocker'),
      ).toBe('action_required');

      seedRow(database, 'workflow_runtime_commands', {
        command_id: 'command:ttl',
        created_at_ms: 1000,
      });
      expect(() =>
        seedRow(database, 'workflow_runtime_command_confirmations', {
          id: 'confirmation:bad',
          request_command_id: 'command:ttl',
          expires_at_ms: 300999,
        }),
      ).toThrow('command_confirmation_ttl_invalid');

      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:planless',
        graph_run_id: 'run:planless',
        plan_id: null,
        lifecycle: 'materializing',
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_graph_scopes SET lifecycle='closing' WHERE id='scope:planless'`,
          )
          .run(),
      ).toThrow('planless_root_close_without_setup_error_or_cancel');
    });
  });

  it('implements the complete Capacity lineage, partial uniqueness, and hash chain intent', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const configHash = hash('capacity:config');
      insertRow(database, 'runtime_capacity_admin_commands', {
        command_id: 'capacity:command:1',
        command_type: 'initialize_deployment_capacity',
        assigned_capacity_revision: 1,
        assigned_change_id: 'capacity:change:1',
        genesis_core_release_hash: hash('core:release'),
        proposed_config_hash: configHash,
        reason_code: 'initial_provisioning',
      });
      insertRow(database, 'runtime_capacity_head', {
        singleton_key: 1,
        current_capacity_revision: null,
        current_change_id: null,
        current_config_hash: null,
        current_publication_hash: null,
        pending_change_id: 'capacity:change:1',
      });
      database
        .prepare(
          `UPDATE runtime_capacity_head SET current_capacity_revision=1, current_change_id='capacity:change:1', current_config_hash=?, current_publication_hash=?, pending_change_id=NULL WHERE singleton_key=1`,
        )
        .run(configHash, hash('capacity:publication:1'));
      expect(
        database
          .prepare(
            'SELECT current_capacity_revision FROM runtime_capacity_head WHERE singleton_key=1',
          )
          .pluck()
          .get(),
      ).toBe(1);

      let previous: string | null = null;
      for (const [index, eventType] of [
        'prepared',
        'recovered',
        'recovered',
        'failed',
        'failed',
        'unauthorized_file_rejected',
        'unauthorized_file_rejected',
      ].entries()) {
        const eventHash = hash(`capacity:event:${index + 1}`);
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: eventType,
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: previous,
          event_hash: eventHash,
        });
        previous = eventHash;
      }
      expect(
        database
          .prepare(
            `SELECT count(*) FROM runtime_capacity_change_events WHERE event_type IN ('recovered','failed','unauthorized_file_rejected')`,
          )
          .pluck()
          .get(),
      ).toBe(6);
      expect(() =>
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: 'prepared',
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: previous,
          event_hash: hash('capacity:event:duplicate-milestone'),
        }),
      ).toThrow('UNIQUE constraint failed');
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_capacity_change_events SET created_at_ms=created_at_ms WHERE event_seq=1`,
          )
          .run(),
      ).toThrow('capacity_event_is_immutable');
      expect(() =>
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: 'recovered',
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: hash('wrong-previous'),
          event_hash: hash('capacity:event:bad-chain'),
        }),
      ).toThrow('capacity_event_hash_chain_invalid');
    });
  });
});
