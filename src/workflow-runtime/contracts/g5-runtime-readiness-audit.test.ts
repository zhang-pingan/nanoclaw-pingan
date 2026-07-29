import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

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

describe('G5 Basic Runtime readiness audit', () => {
  it('binds the current G5 repair exit candidate without marking G5 done', () => {
    const repair = readArtifact('contract-pack-g5-basic-runtime-repair.json');
    expect(repair.payload).toMatchObject({
      status:
        'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      g5_done: false,
      g6_through_g9: 'NOT_READY',
      historical_g5_candidate_authority: 'forbidden',
    });
    const protocol = readArtifact(
      'conformance/g5-basic-runtime-repair/g5-basic-runtime-repair-protocol@1.json',
    );
    expect(protocol.payload).toMatchObject({
      database_schema_version: 11,
      database_schema_hash:
        'sha256:ad998b2d0bb5e5f158b0be6d13db79cb6a0c0650d5064b267262551af266189c',
      plan_authority:
        'persisted_hash_verified_sealed_plan_plus_exact_generated_content_and_binding_rows',
      generated_value_authority:
        'business_members_use_exact_compiled_schema_and_envelope_uses_exact_node_output_envelope_schema',
      output_publication:
        'canonical_node_output_envelope_with_exact_port_values',
      next_task_only:
        'independent_G2_G3_G4_G5_generated_output_schema_affected_chain_regression',
    });
    const bindings = objects(protocol.payload.bindings);
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'database_schema_11',
          hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
        }),
        expect.objectContaining({
          name: 'r020_child_consumption_lineage',
          hash: 'sha256:8a24efc4bd98c02b92cc6d6ce70f13c879d7e537e1081e4d57d561a63ea85c5a',
        }),
        expect.objectContaining({
          name: 'r021_map_terminal_consumption',
          hash: 'sha256:b5e9237d09d829946c496e19eddf16b21c94fb4fd59b3588900f4764332d0699',
        }),
        expect.objectContaining({
          name: 'r022_domain_claim_handoff',
          hash: 'sha256:ea97a3d52a2e4a14fb2671b2191b1b1cb6acc22c4ecded7db2e141a1716b516e',
        }),
        expect.objectContaining({
          name: 'g4_node_output_envelope_authority_successor',
          hash: 'sha256:1cd67bad72a3fb147db7943d669800c2f56fabf4c255d42af8f7704f0e9a0cae',
        }),
      ]),
    );
    expect(
      bindings.find(
        (entry) =>
          entry.name ===
          'g2_current_compiler_3_0_6_generated_output_schema_replay_authority',
      ),
    ).toMatchObject({
      hash: 'sha256:54c4030977a9aef6f7c713c18085d5fc5cb52632dc4f86732c3a7137b2da9edf',
      bundle_hash:
        'sha256:7b60eec3adfa1308e185c050d2c82a9725e41a880ea4670fd2f21cc29c2378a7',
    });
    const readiness = readArtifact(
      'conformance/current/g2-generated-output-schema-authority-replay-v8/g2-g5-readiness@2.json',
    );
    expect(readiness.payload).toMatchObject({
      g2_status: 'IN_PROGRESS',
      g3_status: 'IN_PROGRESS',
      g4_status: 'IN_PROGRESS',
      g5_status: 'IN_PROGRESS',
      g6_through_g9_status: 'NOT_READY',
      current_replay_case_count: 40,
      current_replay_exact_required: true,
      semantic_approval_created: false,
      independent_regression_created: false,
      closure_performed: false,
    });
  });

  it('proves G5-owned T6d is executable without Gateway or Command writes', () => {
    const authority = readArtifact(
      'governance/workflow-runtime-gate-ownership@1.json',
    );
    expect(authority.payload.status).toBe(
      'T6D_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION',
    );
    const matrix = objects(authority.payload.matrix);
    const g5 = matrix.find((entry) => entry.gate === 'G5')!;
    const g7 = matrix.find((entry) => entry.gate === 'G7')!;

    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const transactionEntries = objects(transactions.payload.entries);
    const t6d = transactionEntries.find(
      (entry) => entry.transaction_id === 'T6d',
    )!;
    expect(g5.owned_transaction_protocols).toContain('T6d');
    expect(g5.explicitly_excluded_semantics).toContain(
      'runtime_command_gateway',
    );
    expect(g7.owned_semantics).toContain('runtime_command_gateway');
    expect(g5.owned_semantics).toEqual(
      expect.arrayContaining([
        't6d_automatic_attempt_dispatch_execution_watchdog',
        't6d_automatic_execution_retry_timer',
        't6d_automatic_quality_revision_timer',
        't6d_retry_schedule_consumption_primitive',
      ]),
    );
    expect(t6d).toMatchObject({
      name: 'attempt_watchdog_and_retry_timers',
      cas_guards: [
        'attempt_acceptance_open_for_watchdog',
        'retry_schedule_scheduled_row_version',
      ],
      atomic_writes: [
        'attempt_timeout_fence_and_fact',
        'cancel_reconcile_or_compensation_effects',
        'schedule_consumed_and_exact_next_attempt',
        'node_retry_wait_to_active',
      ],
      idempotency_constraints: [
        'unique_attempt_timeout_event',
        'unique_schedule_source_and_next_attempt',
      ],
      failure_or_late_outcomes: ['duplicate_timer'],
    });
    expect(t6d.invocation_contract).toMatchObject({
      automatic_timer: {
        owner_gate: 'G5',
        gateway_authorization: 'not_applicable',
      },
      authorized_manual_retry: {
        owner_gate: 'G7',
        authorization_boundary: 'runtime_command_gateway_before_t6d',
        command_invocation_audit: 'required_before_primitive',
        g5_primitive: 'consume_existing_retry_schedule',
      },
    });
    const removedDeadlineTokens = [
      ...(t6d.cas_guards as string[]),
      ...(t6d.atomic_writes as string[]),
      ...(t6d.idempotency_constraints as string[]),
      ...(t6d.failure_or_late_outcomes as string[]),
    ];
    expect(removedDeadlineTokens).not.toEqual(
      expect.arrayContaining([
        'workflow_deadline_current_run',
        'stable_workflow_deadline_t7c_command',
        'stable_workflow_deadline_command_key',
        'late_deadline_command',
      ]),
    );
    expect(t6d.forbidden).toEqual(
      expect.arrayContaining([
        'workflow_deadline_command_creation',
        'runtime_command_or_invocation_audit_write',
        'manual_retry_without_gateway_authorization',
      ]),
    );
  });

  it('proves G7 owns a closed deadline Gateway -> T7c path and authorized manual retry handoff', () => {
    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const t7c = objects(transactions.payload.entries).find(
      (entry) => entry.transaction_id === 'T7c',
    )!;
    const commands = readArtifact(
      'protocols/workflow-runtime-command-protocol-table.json',
    );
    const commandEntries = objects(commands.payload.entries);
    const deadlineCancel = commandEntries.find(
      (entry) => entry.command_type === 'cancel_workflow',
    )!;
    const manualRetryAdvance = commandEntries.find(
      (entry) => entry.command_type === 'advance_retry_schedule',
    )!;

    expect(deadlineCancel.transaction_protocol).toBe('T7c');
    expect(deadlineCancel.system_grant).toMatchObject({
      actor_kind: 'system',
      reason_codes: ['deadline_enforced', 'safety_enforced'],
      predicate: 'due_target',
      authority_scope: 'cancel_workflow_only',
      idempotency_domain: 'system:deadline-watchdog',
      idempotency_key_template:
        'workflow-deadline:<workflow_id>:<deadline_at_ms>',
      invocation_audit: 'required',
    });
    expect(t7c.preconditions).toContain('authorized_cancel_command');
    expect(t7c.atomic_writes).toContain('command_invocation_audit');
    expect(t7c.idempotency_constraints).toContain(
      'stable_system_deadline_key_workflow-deadline:<workflow_id>:<deadline_at_ms>',
    );
    expect(t7c.failure_or_late_outcomes).toEqual(
      expect.arrayContaining([
        'loser_records_late_command_only',
        'duplicate_returns_canonical_result_with_invocation_audit',
      ]),
    );
    expect(manualRetryAdvance.transaction_protocol).toBe('T6d');
    expect(manualRetryAdvance.primitive_handoff).toMatchObject({
      authorization_owner: 'G7_runtime_command_gateway',
      audit_owner: 'G7_runtime_command_gateway',
      primitive_owner: 'G5',
      invocation_mode: 'authorized_manual_retry',
      unauthorized_direct_invocation: 'forbidden',
    });
  });

  it('proves Schema 7 needs no deadline handoff relation and still denies G5 Command ownership', () => {
    const queries = readArtifact(
      'sqlite/workflow-runtime-query-catalog@1.json',
    );
    const queryEntries = objects(queries.payload.queries);
    const deadlineDue = queryEntries.find(
      (entry) => entry.query_id === 'query:workflow_deadline_due',
    )!;
    const commandLookup = queryEntries.find(
      (entry) => entry.query_id === 'query:command_idempotency_lookup',
    )!;
    expect(deadlineDue.owner).toBe('workflow_watchdog');
    expect(commandLookup.owner).toBe('command_gateway');
    const authority = readArtifact(
      'governance/workflow-runtime-gate-ownership@1.json',
    );
    const g5 = objects(authority.payload.matrix).find(
      (entry) => entry.gate === 'G5',
    )!;
    expect(g5.explicitly_excluded_semantics).toEqual(
      expect.arrayContaining([
        'workflow_deadline_watchdog',
        'workflow_deadline_gateway_submission',
        'workflow_deadline_command_invocation_audit',
        'runtime_command_gateway',
      ]),
    );

    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    );
    expect(manifest.hash).toBe(
      'sha256:cf623c1fe300b8f6065b2e5edce07a5ce6dc8c5d84453c457387953493336b4f',
    );
    expect(manifest.payload.database_schema_version).toBe(7);
    const schemaTables = objects(manifest.payload.tables);
    const tableNames = schemaTables.map((table) => String(table.name));
    const handoffPattern =
      /deadline.*(?:handoff|intent|command)|(?:handoff|intent|command).*deadline|watchdog/;
    expect(tableNames.filter((name) => handoffPattern.test(name))).toEqual([]);
    expect(
      schemaTables.flatMap((table) =>
        objects(table.columns)
          .map((column) => `${String(table.name)}.${String(column.name)}`)
          .filter((name) => handoffPattern.test(name)),
      ),
    ).toEqual([]);
    expect(tableNames).toContain('workflow_runtime_commands');
    expect(tableNames).toContain('workflow_runtime_command_invocations');
  });
});
