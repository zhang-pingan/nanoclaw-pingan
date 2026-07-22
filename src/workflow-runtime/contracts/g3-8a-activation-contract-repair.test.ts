import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  G38A_REPAIR_SCHEMA,
  G38A_SCENARIO_SCHEMA,
  G38A_NEGATIVE_CASES_SCHEMA,
  checkG38AActivationContractRepair,
  evaluateG38AActivationScenario,
  g38aActivationContractRepairFixturesForTest,
  g38aEvaluateNegativeFixtureForTest,
} from './g3-8a-activation-contract-repair.js';
import type { LogicalTableMetadata } from './logical-schema-types.js';
import { renderMigration } from '../store/schema/ddl.js';
import { loadExecutableSchemaSource } from '../store/schema/source.js';
import { createMigratedDatabase } from '../store/schema/sqlite-gate.js';

const source = loadExecutableSchemaSource();
const migration = renderMigration(source);

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function table(name: string): LogicalTableMetadata {
  const result = source.tables.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Unknown table ${name}`);
  return result;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
  overrides: Record<string, string | number | null>,
  suffix = crypto.randomUUID(),
): void {
  const metadata = table(tableName);
  const columns = metadata.columns;
  const values = columns.map((column) =>
    Object.hasOwn(overrides, column.name)
      ? overrides[column.name]
      : defaultValue(tableName, column, suffix),
  );
  database
    .prepare(
      `INSERT INTO ${quote(tableName)} (${columns
        .map((column) => quote(column.name))
        .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values);
}

function seedRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null>,
): void {
  database.pragma('ignore_check_constraints = ON');
  try {
    insertRow(database, tableName, overrides);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function withSchema3Database(
  callback: (database: Database.Database) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g3-8a-schema3-'));
  const database = createMigratedDatabase(
    path.join(root, 'workflow-runtime.db'),
    migration.sql,
  );
  try {
    callback(database);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('G3.8A Activation failure/replay Contract Repair', () => {
  it('checks the versioned pack and both closed schemas', () => {
    const pack = checkG38AActivationContractRepair();
    const ajv = new Ajv2020({ strict: true });
    expect(ajv.compile(G38A_REPAIR_SCHEMA as AnySchema)).toBeTypeOf('function');
    expect(ajv.compile(G38A_SCENARIO_SCHEMA as AnySchema)).toBeTypeOf(
      'function',
    );
    expect(ajv.compile(G38A_NEGATIVE_CASES_SCHEMA as AnySchema)).toBeTypeOf(
      'function',
    );
    expect(pack.payload).toMatchObject({
      g3_8a_status: 'SCHEMA_REPAIR_REQUIRED',
      production_reachable: false,
      current_database_schema_version: 3,
      required_database_schema_version: 4,
      g3_9_status: 'BLOCKED_BY_G1_6',
    });
  });

  it('replays every positive and fault scenario exactly', () => {
    const fixtures = g38aActivationContractRepairFixturesForTest();
    expect(fixtures.positive).toHaveLength(9);
    expect(fixtures.fault).toHaveLength(17);
    for (const caseFixture of [...fixtures.positive, ...fixtures.fault]) {
      expect(
        evaluateG38AActivationScenario(caseFixture.scenario),
        caseFixture.case_id,
      ).toEqual(caseFixture.expected);
    }

    const byId = new Map(
      fixtures.positive.map((entry) => [entry.case_id, entry.expected]),
    );
    expect(byId.get('exact-replay-applied')).toMatchObject({
      invocation_disposition: 'duplicate',
      canonical_terminal_disposition: 'applied',
      receipt: 'original_transition_receipt',
      pointer_transition_count: 0,
    });
    expect(byId.get('exact-replay-failed')).toMatchObject({
      invocation_disposition: 'duplicate',
      canonical_terminal_disposition: 'failed',
      receipt: null,
      pointer_transition_count: 0,
    });
    expect(byId.get('repeated-same-key-domain-drift-conflict')).toMatchObject({
      invocation_disposition: 'conflict',
      receipt: null,
      pointer_transition_count: 0,
    });
    expect(byId.get('exact-replay-pointer-cas-conflict')).toMatchObject({
      invocation_disposition: 'duplicate',
      canonical_terminal_disposition: 'conflict',
      receipt: null,
      pointer_transition_count: 0,
    });
  });

  it('fails closed for every removed, unknown, extra, missing, and semantic drift fixture', () => {
    const fixtures = g38aActivationContractRepairFixturesForTest();
    expect(fixtures.negative).toHaveLength(12);
    for (const caseFixture of fixtures.negative) {
      expect(
        g38aEvaluateNegativeFixtureForTest(caseFixture),
        caseFixture.case_id,
      ).toBe(caseFixture.expected_code);
    }
    expect(fixtures.rejection).toHaveLength(47);
    expect(
      fixtures.rejection.filter(
        (entry) => entry.outer_code === 'g3_6_preflight_rejected',
      ),
    ).toHaveLength(20);
    expect(
      fixtures.rejection.every(
        (entry) =>
          entry.receipt === null && entry.pointer_transition_count === 0,
      ),
    ).toBe(true);
  });

  it('reproduces all four Schema 3 blockers in a real migrated SQLite file', () => {
    withSchema3Database((database) => {
      expect(database.pragma('user_version', { simple: true })).toBe(3);
      database.pragma('foreign_keys = OFF');

      const featureId = 'feature:g3-8a';
      const releaseId = 'release:g3-8a';
      const releaseHash = hash(releaseId);
      const releaseRef = 'feature.g3-8a.release';
      const releaseVersion = '1.0.0';
      const closureId = 'closure:g3-8a';
      const closureHash = hash(closureId);
      const retentionId = 'retention:g3-8a';
      seedRow(database, 'workflow_feature_releases', {
        id: releaseId,
        feature_id: featureId,
        release_ref: releaseRef,
        release_version: releaseVersion,
        release_hash: releaseHash,
        status: 'staged',
        staged_at_ms: 1,
        activated_at_ms: null,
        disabled_at_ms: null,
        row_version: 0,
      });
      seedRow(database, 'workflow_registry_retention_handles', {
        id: retentionId,
        handle_kind: 'published',
        feature_release_id: releaseId,
        graph_run_id: null,
        backup_id: null,
        external_actor_ref: null,
        closure_manifest_id: closureId,
        closure_hash: closureHash,
        status: 'held',
        created_at_ms: 1,
        released_at_ms: null,
        row_version: 0,
      });

      const command = {
        command_type: 'activate_feature_release',
        idempotency_domain: 'feature-release-activation',
        domain_request_hash: hash('domain-request'),
        feature_id: featureId,
        target_feature_release_id: releaseId,
        target_feature_release_ref: releaseRef,
        target_feature_release_version: releaseVersion,
        target_feature_release_hash: releaseHash,
        expected_pointer_state: 'absent',
        expected_pointer_row_version: null,
        previous_feature_release_id: null,
        previous_feature_release_ref: null,
        previous_feature_release_version: null,
        previous_feature_release_hash: null,
        target_retention_handle_id: retentionId,
        target_retention_handle_kind: 'published',
        target_retention_closure_manifest_id: closureId,
        target_retention_closure_hash: closureHash,
        target_retention_observed_status: 'held',
        target_retention_observed_row_version: 0,
        previous_retention_handle_id: null,
        previous_retention_handle_kind: null,
        previous_retention_closure_manifest_id: null,
        previous_retention_closure_hash: null,
        previous_retention_observed_status: null,
        previous_retention_observed_row_version: null,
        lifecycle: 'pending',
        created_at_ms: 2,
        finalized_at_ms: null,
        row_version: 0,
      };
      insertRow(database, 'workflow_feature_release_activation_commands', {
        ...command,
        command_id: 'activation:failed',
        idempotency_key: 'failed',
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_commands
                SET lifecycle='failed', finalized_at_ms=3, row_version=1,
                    canonical_receipt_value_id='receipt',
                    canonical_receipt_hash=?,
                    canonical_receipt_schema_resource_id='receipt-schema',
                    canonical_receipt_schema_hash=?
              WHERE command_id='activation:failed'`,
          )
          .run(hash('receipt'), hash('receipt-schema')),
      ).toThrow('ck:activation_commands:lifecycle');
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands
              SET lifecycle='failed', finalized_at_ms=3, row_version=1
            WHERE command_id='activation:failed'`,
        )
        .run();
      expect(
        database
          .prepare(
            `SELECT canonical_receipt_value_id FROM workflow_feature_release_activation_commands WHERE command_id='activation:failed'`,
          )
          .get(),
      ).toEqual({ canonical_receipt_value_id: null });

      const columns = database.pragma(
        'table_info(workflow_feature_release_activation_commands)',
      ) as Array<{ name: string }>;
      expect(columns.map((entry) => entry.name)).not.toContain(
        'canonical_terminal_result_value_id',
      );
      expect(columns.map((entry) => entry.name)).not.toContain(
        'terminal_disposition',
      );

      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_commands', {
          ...command,
          command_id: 'activation:retention-drift',
          idempotency_key: 'retention-drift',
          target_retention_observed_row_version: 1,
        }),
      ).toThrow('activation_retention_observation_invalid');
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_commands', {
          ...command,
          command_id: 'activation:owner-mismatch',
          idempotency_key: 'owner-mismatch',
          feature_id: 'feature:other-owner',
        }),
      ).toThrow('activation_retention_observation_invalid');

      const foreignKeys = database.pragma(
        'foreign_key_list(workflow_feature_release_activation_commands)',
      ) as Array<{ id: number; from: string; table: string; to: string }>;
      const targetForeignKeyId = foreignKeys.find(
        (entry) =>
          entry.table === 'workflow_feature_releases' &&
          entry.from === 'target_feature_release_id',
      )?.id;
      expect(
        foreignKeys
          .filter((entry) => entry.id === targetForeignKeyId)
          .map((entry) => [entry.from, entry.to]),
      ).toEqual([
        ['feature_id', 'feature_id'],
        ['target_feature_release_id', 'id'],
        ['target_feature_release_hash', 'release_hash'],
      ]);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM workflow_feature_release_activation_commands WHERE command_id IN ('activation:retention-drift','activation:owner-mismatch')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    });
  });
});
