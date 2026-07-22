import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { LogicalTableMetadata } from '../../contracts/logical-schema-types.js';
import { buildActivationRepairSchemaPrerequisitePayload } from './activation-repair-source.js';
import { buildQueryFixtures, renderMigration } from './ddl.js';
import {
  loadExecutableSchemaSource,
  loadSchema3ExecutableSchemaSource,
} from './source.js';
import { createMigratedDatabase, verifyQueryPlans } from './sqlite-gate.js';

const source = loadExecutableSchemaSource();
const schema3 = loadSchema3ExecutableSchemaSource();
const migration = renderMigration(source);

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function table(name: string): LogicalTableMetadata {
  const metadata = source.tables.find((candidate) => candidate.name === name);
  if (!metadata) throw new Error(`Unknown table ${name}`);
  return metadata;
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

function insertRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null> = {},
  suffix = crypto.randomUUID(),
): void {
  const metadata = table(tableName);
  const autoColumn = metadata.primary_key.auto_increment_intent
    ? metadata.primary_key.columns[0]
    : null;
  const columns = metadata.columns.filter(
    (column) => column.name !== autoColumn,
  );
  database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(
      ...columns.map((column) =>
        Object.hasOwn(overrides, column.name)
          ? overrides[column.name]
          : defaultValue(tableName, column, suffix),
      ),
    );
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

function withDatabase(callback: (database: Database.Database) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g16-schema-'));
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

function result(prefix: string): Record<string, string> {
  return {
    result_value_id: `${prefix}:value`,
    result_hash: hash(`${prefix}:value`),
    result_schema_resource_id: `${prefix}:schema`,
    result_schema_hash: hash(`${prefix}:schema`),
  };
}

function referencedResult(prefix: string): Record<string, string> {
  return {
    referenced_terminal_result_value_id: `${prefix}:value`,
    referenced_terminal_result_hash: hash(`${prefix}:value`),
    referenced_terminal_result_schema_resource_id: `${prefix}:schema`,
    referenced_terminal_result_schema_hash: hash(`${prefix}:schema`),
  };
}

function terminalHeader(
  prefix: string,
  invocationId: string,
  invocationNo: number,
  invocationHash: string,
  submittedRequestHash: string,
): Record<string, string | number> {
  return {
    terminal_disposition: prefix.endsWith(':applied')
      ? 'applied'
      : prefix.endsWith(':conflict')
        ? 'conflict'
        : 'failed',
    canonical_terminal_result_value_id: `${prefix}:value`,
    canonical_terminal_result_hash: hash(`${prefix}:value`),
    canonical_terminal_result_schema_resource_id: `${prefix}:schema`,
    canonical_terminal_result_schema_hash: hash(`${prefix}:schema`),
    canonical_terminal_invocation_id: invocationId,
    canonical_terminal_invocation_no: invocationNo,
    canonical_terminal_invocation_hash: invocationHash,
    canonical_terminal_submitted_request_hash: submittedRequestHash,
  };
}

describe('G1.6 Activation failure and replay persistence schema', () => {
  it('consumes the exact G3.8A 62 columns, 12 composite FKs, 7 UKs, relations, checks, triggers, and queries', () => {
    const repair = buildActivationRepairSchemaPrerequisitePayload();
    expect(repair.column_requirements).toHaveLength(62);
    expect(repair.foreign_key_requirements).toHaveLength(12);
    expect(repair.unique_key_requirements).toHaveLength(7);
    expect(repair.relation_requirements).toHaveLength(6);

    const rebuilt = new Map(
      repair.rebuilt_tables.map((metadata) => [metadata.name, metadata]),
    );
    expect([...rebuilt.keys()]).toEqual([
      'workflow_feature_release_activation_commands',
      'workflow_feature_release_activation_invocations',
      'workflow_feature_release_activation_events',
    ]);
    for (const [name, metadata] of rebuilt) {
      expect(table(name)).toEqual(metadata);
    }
    expect(
      repair.relation_requirements.map((requirement) => ({
        relation: requirement.relation,
        action: requirement.action,
      })),
    ).toEqual([
      {
        relation: 'workflow_feature_release_activation_commands',
        action: 'rebuild',
      },
      {
        relation: 'workflow_feature_release_activation_invocations',
        action: 'rebuild',
      },
      {
        relation: 'workflow_feature_release_activation_events',
        action: 'rebuild',
      },
      { relation: 'workflow_feature_releases', action: 'preserve' },
      { relation: 'workflow_feature_active_releases', action: 'preserve' },
      {
        relation: 'workflow_registry_retention_handles',
        action: 'modify',
      },
    ]);
    for (const requirement of repair.column_requirements) {
      const column = rebuilt
        .get(requirement.relation)
        ?.columns.find((candidate) => candidate.name === requirement.name);
      expect(
        column,
        `${requirement.relation}.${requirement.name}`,
      ).toMatchObject({
        name: requirement.name,
        sqlite_type_intent: requirement.sqlite_type,
        nullable: requirement.nullable,
        safe_integer_intent: requirement.safe_integer,
        enum_values: requirement.enum_values,
      });
    }
    expect(
      repair.foreign_key_requirements.map((requirement) => {
        const relation = rebuilt
          .get(requirement.source_relation)
          ?.foreign_keys.find(
            (candidate) => candidate.relation_id === requirement.relation_id,
          );
        return {
          relation_id: relation?.relation_id,
          source_relation: requirement.source_relation,
          source_columns: relation?.source_columns,
          target_relation: relation?.target_table,
          target_columns: relation?.target_columns,
          nullable: relation?.source_columns.some(
            (name) =>
              rebuilt
                .get(requirement.source_relation)
                ?.columns.find((column) => column.name === name)?.nullable,
          ),
          deferrability: relation?.deferrability,
        };
      }),
    ).toEqual(repair.foreign_key_requirements);
    expect(
      repair.unique_key_requirements.map((requirement) => {
        const key = rebuilt
          .get(requirement.relation)
          ?.unique_keys.find(
            (candidate) => candidate.key_id === requirement.key_id,
          );
        return {
          key_id: key?.key_id,
          relation: requirement.relation,
          columns: key?.columns,
          predicate: key?.predicate_intent,
        };
      }),
    ).toEqual(repair.unique_key_requirements);

    for (const preserved of [
      'workflow_feature_releases',
      'workflow_feature_active_releases',
      'workflow_registry_retention_handles',
    ]) {
      expect(
        source.tables.find((candidate) => candidate.name === preserved),
      ).toEqual(
        schema3.tables.find((candidate) => candidate.name === preserved),
      );
    }
    const commandChecks = table(
      'workflow_feature_release_activation_commands',
    ).checks.map((check) => check.check_id);
    expect(commandChecks).toEqual(
      expect.arrayContaining([
        'ck:activation_commands:verified_prefix',
        'ck:activation_commands:pointer_observation_shape',
        'ck:activation_commands:lifecycle',
        'ck:activation_commands:canonical_terminal_result',
        'ck:activation_commands:canonical_terminal_invocation',
      ]),
    );
    const triggerNames = (relation: string) =>
      migration.triggers
        .filter((trigger) => trigger.table === relation)
        .map((trigger) => trigger.name);
    expect(
      triggerNames('workflow_feature_release_activation_commands').sort(),
    ).toEqual([
      'trg:activation_commands:immutable_delete',
      'trg:activation_commands:immutable_identity',
      'trg:activation_commands:terminalization',
      'trg:activation_commands:verified_fact_transition',
    ]);
    expect(
      triggerNames('workflow_feature_release_activation_invocations'),
    ).toEqual([
      'trg:activation_invocations:hash_chain',
      'trg:activation_invocations:terminal_reference',
      'trg:activation_invocations:closed_replay_disposition',
      'trg:activation_invocations:immutable_update',
      'trg:activation_invocations:immutable_delete',
    ]);
    expect(triggerNames('workflow_feature_release_activation_events')).toEqual([
      'trg:activation_events:command_binding',
      'trg:activation_events:hash_chain',
      'trg:activation_events:immutable_update',
      'trg:activation_events:immutable_delete',
    ]);
    expect(triggerNames('workflow_feature_releases')).toEqual([
      'trg:feature_releases:immutable_identity',
      'trg:feature_releases:lifecycle_transition',
      'trg:feature_releases:protected_delete',
    ]);
    expect(triggerNames('workflow_feature_active_releases')).toEqual([
      'trg:feature_active_releases:target_active_insert',
      'trg:feature_active_releases:cas_update',
      'trg:feature_active_releases:immutable_delete',
    ]);
    expect(triggerNames('workflow_registry_retention_handles')).toEqual([
      'trg:retention_handles:immutable_published_identity',
      'trg:retention_handles:release_transition',
      'trg:retention_handles:protected_delete',
    ]);
    expect(repair.trigger_intents).toHaveLength(9);
    expect(migration.triggers.map((trigger) => trigger.name)).not.toContain(
      'trg:activation_commands:retention_observation_insert',
    );
    expect(
      source.queries.filter((intent) =>
        repair.replaced_query_ids.includes(intent.query_id),
      ),
    ).toEqual(repair.query_intents);
    expect(
      buildQueryFixtures(source)
        .filter((fixture) => fixture.query_id.startsWith('activation_'))
        .map((fixture) => fixture.query_id),
    ).toEqual(repair.query_intents.map((intent) => intent.query_id));
    withDatabase((database) =>
      verifyQueryPlans(database, buildQueryFixtures(source)),
    );
  });

  it('persists owner and Retention drift as request-only failed results without fabricated verified facts', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const commandId = 'activation:failed:command';
      const domainHash = hash('activation:failed:request');
      insertRow(database, 'workflow_feature_release_activation_commands', {
        command_id: commandId,
        idempotency_domain: 'activation:feature',
        idempotency_key: 'failed',
        domain_request_hash: domainHash,
      });
      expect(
        database
          .prepare(
            'SELECT lifecycle, verified_feature_id, terminal_disposition, canonical_receipt_value_id, row_version FROM workflow_feature_release_activation_commands WHERE command_id=?',
          )
          .get(commandId),
      ).toEqual({
        lifecycle: 'pending',
        verified_feature_id: null,
        terminal_disposition: null,
        canonical_receipt_value_id: null,
        row_version: 0,
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_commands', {
          command_id: 'activation:failed:duplicate-key',
          idempotency_domain: 'activation:feature',
          idempotency_key: 'failed',
        }),
      ).toThrow('UNIQUE constraint failed');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_commands SET verified_compatibility_result_value_id='hole:value', verified_compatibility_result_hash=?, verified_compatibility_result_schema_resource_id='hole:schema', verified_compatibility_result_schema_hash=?, row_version=1 WHERE command_id=?`,
          )
          .run(hash('hole:value'), hash('hole:schema'), commandId),
      ).toThrow('ck:activation_commands:verified_prefix');

      const invocationId = 'activation:failed:invocation:1';
      const invocationHash = hash(invocationId);
      const failedResult =
        'activation:failed:owner-retention-identity-status-row-version-drift';
      const domainDriftHash = hash('activation:failed:invocation:3');
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: invocationId,
        command_id: commandId,
        invocation_no: 1,
        invocation_kind: 'submit',
        command_domain_request_hash: domainHash,
        submitted_request_hash: domainHash,
        disposition: 'failed',
        ...result(failedResult),
        ...referencedResult(failedResult),
        previous_invocation_hash: null,
        invocation_hash: invocationHash,
      });
      const header = terminalHeader(
        failedResult,
        invocationId,
        1,
        invocationHash,
        domainHash,
      );
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_commands SET lifecycle='failed', terminal_disposition=?, canonical_terminal_result_value_id=?, canonical_terminal_result_hash=?, canonical_terminal_result_schema_resource_id=?, canonical_terminal_result_schema_hash=?, canonical_terminal_invocation_id=?, canonical_terminal_invocation_no=?, canonical_terminal_invocation_hash=?, canonical_terminal_submitted_request_hash=?, canonical_receipt_value_id='forbidden:receipt', canonical_receipt_hash=?, canonical_receipt_schema_resource_id='forbidden:receipt:schema', canonical_receipt_schema_hash=?, finalized_at_ms=20, row_version=1 WHERE command_id=?`,
          )
          .run(
            ...Object.values(header),
            hash('forbidden:receipt'),
            hash('forbidden:receipt:schema'),
            commandId,
          ),
      ).toThrow('ck:activation_commands:lifecycle');
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET lifecycle='failed', terminal_disposition=?, canonical_terminal_result_value_id=?, canonical_terminal_result_hash=?, canonical_terminal_result_schema_resource_id=?, canonical_terminal_result_schema_hash=?, canonical_terminal_invocation_id=?, canonical_terminal_invocation_no=?, canonical_terminal_invocation_hash=?, canonical_terminal_submitted_request_hash=?, finalized_at_ms=20, row_version=1 WHERE command_id=?`,
        )
        .run(...Object.values(header), commandId);
      expect(
        database
          .prepare(
            'SELECT lifecycle, terminal_disposition, canonical_terminal_result_value_id, canonical_receipt_value_id, applied_pointer_row_version, verified_feature_id, verified_target_retention_handle_id, verified_target_retention_observed_status, verified_target_retention_observed_row_version FROM workflow_feature_release_activation_commands WHERE command_id=?',
          )
          .get(commandId),
      ).toEqual({
        lifecycle: 'failed',
        terminal_disposition: 'failed',
        canonical_terminal_result_value_id: `${failedResult}:value`,
        canonical_receipt_value_id: null,
        applied_pointer_row_version: null,
        verified_feature_id: null,
        verified_target_retention_handle_id: null,
        verified_target_retention_observed_status: null,
        verified_target_retention_observed_row_version: null,
      });

      const duplicateHash = hash('activation:failed:invocation:2');
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: 'activation:failed:invocation:2',
        command_id: commandId,
        invocation_no: 2,
        invocation_kind: 'recovery',
        command_domain_request_hash: domainHash,
        submitted_request_hash: domainHash,
        disposition: 'duplicate',
        ...referencedResult(failedResult),
        previous_invocation_hash: invocationHash,
        invocation_hash: duplicateHash,
      });
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: 'activation:failed:invocation:3',
        command_id: commandId,
        invocation_no: 3,
        invocation_kind: 'submit',
        command_domain_request_hash: domainHash,
        submitted_request_hash: hash('activation:domain-drift'),
        disposition: 'conflict',
        ...referencedResult(failedResult),
        previous_invocation_hash: duplicateHash,
        invocation_hash: domainDriftHash,
      });
      expect(
        database
          .prepare(
            'SELECT lifecycle, canonical_terminal_invocation_id, canonical_terminal_result_value_id FROM workflow_feature_release_activation_commands WHERE command_id=?',
          )
          .get(commandId),
      ).toEqual({
        lifecycle: 'failed',
        canonical_terminal_invocation_id: invocationId,
        canonical_terminal_result_value_id: `${failedResult}:value`,
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_invocations', {
          id: 'activation:failed:invocation:4:not-duplicate',
          command_id: commandId,
          invocation_no: 4,
          invocation_kind: 'recovery',
          command_domain_request_hash: domainHash,
          submitted_request_hash: domainHash,
          disposition: 'failed',
          ...result('activation:failed:replayed-as-failed'),
          ...referencedResult('activation:failed:replayed-as-failed'),
          previous_invocation_hash: domainDriftHash,
          invocation_hash: hash('activation:failed:invocation:4:not-duplicate'),
        }),
      ).toThrow('activation_invocation_closed_replay_must_be_duplicate');
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_invocations', {
          id: 'activation:failed:invocation:4:bad-chain',
          command_id: commandId,
          invocation_no: 4,
          invocation_kind: 'recovery',
          command_domain_request_hash: domainHash,
          submitted_request_hash: domainHash,
          disposition: 'duplicate',
          ...referencedResult(failedResult),
          previous_invocation_hash: hash('wrong-previous'),
          invocation_hash: hash('activation:failed:invocation:4'),
        }),
      ).toThrow('activation_invocation_hash_chain_invalid');
      expect(() =>
        database
          .prepare(
            'UPDATE workflow_feature_release_activation_invocations SET decided_at_ms=decided_at_ms WHERE id=?',
          )
          .run(invocationId),
      ).toThrow('activation_invocation_is_immutable');
    });
  });

  it('enforces applied-only receipt, pointer-conflict terminal binding, Event release prefixes, and tamper rejection', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const featureId = 'feature:g16';
      const releaseId = 'release:g16';
      const releaseHash = hash(releaseId);
      const releaseRef = 'feature.g16.release';
      const releaseVersion = '1.0.0';
      const retentionId = 'retention:g16';
      const closureId = 'closure:g16';
      const closureHash = hash(closureId);
      seedRow(database, 'workflow_feature_releases', {
        id: releaseId,
        feature_id: featureId,
        release_ref: releaseRef,
        release_version: releaseVersion,
        release_hash: releaseHash,
        status: 'active',
        staged_at_ms: 1,
        activated_at_ms: 2,
        disabled_at_ms: null,
        row_version: 1,
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
        released_at_ms: null,
        row_version: 0,
      });
      insertRow(database, 'workflow_feature_active_releases', {
        feature_id: featureId,
        release_id: releaseId,
        release_hash: releaseHash,
        row_version: 1,
        activated_at_ms: 2,
      });

      const verified = {
        verified_compatibility_input_value_id: 'g16:compat:input',
        verified_compatibility_input_hash: hash('g16:compat:input'),
        verified_compatibility_input_schema_resource_id:
          'g16:compat:input:schema',
        verified_compatibility_input_schema_hash: hash(
          'g16:compat:input:schema',
        ),
        verified_compatibility_result_value_id: 'g16:compat:result',
        verified_compatibility_result_hash: hash('g16:compat:result'),
        verified_compatibility_result_schema_resource_id:
          'g16:compat:result:schema',
        verified_compatibility_result_schema_hash: hash(
          'g16:compat:result:schema',
        ),
        verified_feature_id: featureId,
        verified_target_feature_release_id: releaseId,
        verified_target_feature_release_ref: releaseRef,
        verified_target_feature_release_version: releaseVersion,
        verified_target_feature_release_hash: releaseHash,
        verified_target_retention_handle_id: retentionId,
        verified_target_retention_handle_kind: 'published',
        verified_target_retention_feature_release_id: releaseId,
        verified_target_retention_closure_manifest_id: closureId,
        verified_target_retention_closure_hash: closureHash,
        verified_target_retention_observed_status: 'held',
        verified_target_retention_observed_row_version: 0,
        observed_pointer_state: 'absent',
      } as const;

      const commandId = 'activation:applied:command';
      const domainHash = hash('activation:applied:request');
      insertRow(database, 'workflow_feature_release_activation_commands', {
        command_id: commandId,
        idempotency_domain: 'activation:feature:g16',
        idempotency_key: 'applied',
        domain_request_hash: domainHash,
      });
      const {
        observed_pointer_state: _unverifiedPointer,
        ...verifiedWithoutPointer
      } = verified;
      const setColumns = Object.keys(verifiedWithoutPointer)
        .map((name) => `${q(name)}=?`)
        .join(', ');
      const verifiedSetColumns = Object.keys(verified)
        .map((name) => `${q(name)}=?`)
        .join(', ');
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET ${setColumns}, row_version=1 WHERE command_id=?`,
        )
        .run(...Object.values(verifiedWithoutPointer), commandId);
      const appliedResult = 'activation:terminal:applied';
      const invocationId = 'activation:applied:invocation:1';
      const invocationHash = hash(invocationId);
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: invocationId,
        command_id: commandId,
        invocation_no: 1,
        invocation_kind: 'submit',
        command_domain_request_hash: domainHash,
        submitted_request_hash: domainHash,
        disposition: 'applied',
        ...result(appliedResult),
        ...referencedResult(appliedResult),
        previous_invocation_hash: null,
        invocation_hash: invocationHash,
        applied_at_ms: 10,
      });
      const header = terminalHeader(
        appliedResult,
        invocationId,
        1,
        invocationHash,
        domainHash,
      );
      const terminalizeApplied = database.prepare(
        `UPDATE workflow_feature_release_activation_commands SET lifecycle='applied', terminal_disposition=?, canonical_terminal_result_value_id=?, canonical_terminal_result_hash=?, canonical_terminal_result_schema_resource_id=?, canonical_terminal_result_schema_hash=?, canonical_terminal_invocation_id=?, canonical_terminal_invocation_no=?, canonical_terminal_invocation_hash=?, canonical_terminal_submitted_request_hash=?, applied_pointer_row_version=1, canonical_receipt_value_id='activation:receipt', canonical_receipt_hash=?, canonical_receipt_schema_resource_id='activation:receipt:schema', canonical_receipt_schema_hash=?, finalized_at_ms=11, row_version=? WHERE command_id=?`,
      );
      expect(() =>
        terminalizeApplied.run(
          ...Object.values(header),
          hash('activation:receipt'),
          hash('activation:receipt:schema'),
          2,
          commandId,
        ),
      ).toThrow('activation_command_terminalization_invalid');
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET observed_pointer_state='absent', row_version=2 WHERE command_id=?`,
        )
        .run(commandId);
      terminalizeApplied.run(
        ...Object.values(header),
        hash('activation:receipt'),
        hash('activation:receipt:schema'),
        3,
        commandId,
      );
      expect(
        database
          .prepare(
            'SELECT lifecycle, terminal_disposition, applied_pointer_row_version, canonical_receipt_value_id FROM workflow_feature_release_activation_commands WHERE command_id=?',
          )
          .get(commandId),
      ).toEqual({
        lifecycle: 'applied',
        terminal_disposition: 'applied',
        applied_pointer_row_version: 1,
        canonical_receipt_value_id: 'activation:receipt',
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_commands SET canonical_terminal_invocation_hash=?, row_version=4 WHERE command_id=?`,
          )
          .run(hash('tampered-terminal-invocation'), commandId),
      ).toThrow('activation_command_verified_fact_transition_invalid');

      const eventHash = hash('activation:g16:event:1');
      insertRow(database, 'workflow_feature_release_activation_events', {
        command_id: commandId,
        event_no: 1,
        attempt_no: 1,
        phase: 'finalize',
        event_type: 'terminal_result_committed',
        verified_feature_id: featureId,
        verified_target_feature_release_id: releaseId,
        verified_target_feature_release_ref: releaseRef,
        verified_target_feature_release_version: releaseVersion,
        verified_target_feature_release_hash: releaseHash,
        previous_event_hash: null,
        event_hash: eventHash,
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_events', {
          command_id: commandId,
          event_no: 2,
          attempt_no: 1,
          phase: 'finalize',
          event_type: 'terminal_replayed',
          verified_feature_id: 'wrong-feature',
          verified_target_feature_release_id: releaseId,
          verified_target_feature_release_ref: releaseRef,
          verified_target_feature_release_version: releaseVersion,
          verified_target_feature_release_hash: releaseHash,
          previous_event_hash: eventHash,
          event_hash: hash('activation:g16:event:2:wrong-binding'),
        }),
      ).toThrow('activation_event_command_binding_invalid');
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_events', {
          command_id: commandId,
          event_no: 2,
          attempt_no: 1,
          phase: 'finalize',
          event_type: 'terminal_replayed',
          verified_feature_id: featureId,
          verified_target_feature_release_id: releaseId,
          verified_target_feature_release_ref: releaseRef,
          verified_target_feature_release_version: releaseVersion,
          verified_target_feature_release_hash: releaseHash,
          previous_event_hash: hash('wrong-event-parent'),
          event_hash: hash('activation:g16:event:2:wrong-chain'),
        }),
      ).toThrow('activation_event_hash_chain_invalid');
      expect(() =>
        database
          .prepare(
            'DELETE FROM workflow_feature_release_activation_events WHERE command_id=? AND event_no=1',
          )
          .run(commandId),
      ).toThrow('activation_event_is_immutable');

      const conflictCommand = 'activation:conflict:command';
      const conflictDomain = hash('activation:conflict:request');
      insertRow(database, 'workflow_feature_release_activation_commands', {
        command_id: conflictCommand,
        idempotency_domain: 'activation:feature:g16',
        idempotency_key: 'conflict',
        domain_request_hash: conflictDomain,
      });
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET ${verifiedSetColumns}, row_version=1 WHERE command_id=?`,
        )
        .run(...Object.values(verified), conflictCommand);
      const conflictResult = 'activation:terminal:conflict';
      const conflictInvocation = 'activation:conflict:invocation:1';
      const conflictInvocationHash = hash(conflictInvocation);
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: conflictInvocation,
        command_id: conflictCommand,
        invocation_no: 1,
        invocation_kind: 'submit',
        command_domain_request_hash: conflictDomain,
        submitted_request_hash: conflictDomain,
        disposition: 'conflict',
        ...result(conflictResult),
        ...referencedResult(conflictResult),
        previous_invocation_hash: null,
        invocation_hash: conflictInvocationHash,
      });
      const conflictHeader = terminalHeader(
        conflictResult,
        conflictInvocation,
        1,
        conflictInvocationHash,
        conflictDomain,
      );
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET lifecycle='conflict', terminal_disposition=?, canonical_terminal_result_value_id=?, canonical_terminal_result_hash=?, canonical_terminal_result_schema_resource_id=?, canonical_terminal_result_schema_hash=?, canonical_terminal_invocation_id=?, canonical_terminal_invocation_no=?, canonical_terminal_invocation_hash=?, canonical_terminal_submitted_request_hash=?, finalized_at_ms=12, row_version=2 WHERE command_id=?`,
        )
        .run(...Object.values(conflictHeader), conflictCommand);
      expect(
        database
          .prepare(
            'SELECT lifecycle, canonical_receipt_value_id, applied_pointer_row_version FROM workflow_feature_release_activation_commands WHERE command_id=?',
          )
          .get(conflictCommand),
      ).toEqual({
        lifecycle: 'conflict',
        canonical_receipt_value_id: null,
        applied_pointer_row_version: null,
      });
    });
  });
});
