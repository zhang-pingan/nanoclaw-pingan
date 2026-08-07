import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import type { WorkflowRuntimeCommandDocument } from '../contracts/closed-schema-types.js';
import type { RuntimePermissionCode } from '../contracts/catalog-protocol-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { releaseDomainClaim } from '../creation/domain-claims.js';
import {
  calculateCreationIntentHash,
  prepareRequiredFinalizationT0p,
} from '../creation/task-intake.js';
import {
  coordinateGraphRecoveryG7,
  requestScopeCloseT7a,
} from './graph-runtime.js';
import {
  fireWorkflowDeadlineWatchdog,
  submitRuntimeCommand,
  type RuntimeCommandGatewayInput,
} from './commands.js';
import { openOperationalBlocker } from './operational-blockers.js';
import {
  insertGraphEvent,
  insertInlineValue,
  stableRuntimeId,
} from './graph-store.js';
import { reserveLedgerResources } from './ledger.js';
import {
  recordRootFinalizationAttempt,
  type T8RootCommitInput,
} from './root-finalizer.js';
import { createG7Fixture, g7Hash, type G7Fixture } from './g7-test-support.js';
import { WorkflowRuntimeTransactionAuthority } from '../service.js';

const fixtures: G7Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.instance.cleanup();
});

function fixture(key: string, claims: boolean | number = false): G7Fixture {
  const claimCount = claims === true ? 1 : claims === false ? 0 : claims;
  const created = createG7Fixture(
    key,
    claimCount > 0
      ? {
          domainClaims: Array.from({ length: claimCount }, (_, index) => ({
            namespace: 'g7.test',
            keyHash: g7Hash(`claim:${key}:${index}`),
            mode: 'exclusive' as const,
          })),
        }
      : {},
  );
  fixtures.push(created);
  return created;
}

function tamperTerminalIngress(
  databasePath: string,
  commandId: string,
  assignmentSql: string,
  parameters: readonly (string | number | null)[] = [],
): void {
  const database = new Database(databasePath);
  let triggerSql: string | null = null;
  let triggerDropped = false;
  try {
    database.pragma('foreign_keys = ON');
    triggerSql = database
      .prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type='trigger' AND name='trg:command_ingress:terminal_transition'`,
      )
      .pluck()
      .get() as string;
    database.exec('DROP TRIGGER "trg:command_ingress:terminal_transition"');
    triggerDropped = true;
    database
      .prepare(
        `UPDATE workflow_runtime_command_ingress_invocations
            SET ${assignmentSql}
          WHERE submitted_command_id = ?`,
      )
      .run(...parameters, commandId);
  } finally {
    if (triggerDropped && triggerSql !== null) database.exec(triggerSql);
    database.close();
  }
}

function runVersion(target: G7Fixture): number {
  return target.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [target.graphRunId],
  )!.row_version;
}

function workflowVersion(target: G7Fixture): number {
  return target.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflows WHERE id = ?',
    [target.workflowId],
  )!.row_version;
}

function firstNode(target: G7Fixture): {
  id: string;
  node_key: string;
  row_version: number;
} {
  return target.instance.store.queryOne<{
    id: string;
    node_key: string;
    row_version: number;
  }>(
    `SELECT id, node_key, row_version FROM workflow_graph_nodes
      WHERE graph_run_id = ? ORDER BY id COLLATE BINARY LIMIT 1`,
    [target.graphRunId],
  )!;
}

function seedTerminalAttemptAndEffect(
  target: G7Fixture,
  key: string,
): { attemptId: string; effectId: string; operationKey: string } {
  const node = firstNode(target);
  const attemptId = `attempt:g7:${key}`;
  const effectId = `effect:g7:${key}`;
  const operationKey = `operation:g7:${key}`;
  const value = target.seed.values.context!;
  target.instance.store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_graph_node_attempts (
         id, graph_run_id, scope_id, node_id, attempt_no, continuation_kind,
         parent_attempt_id, parent_attempt_no, phase, execution_outcome,
         quality_decision, input_snapshot_json, input_snapshot_value_id,
         input_snapshot_hash, selected_edges_json, context_pack_value_id,
         context_pack_hash, delegation_id, external_execution_id, action_name,
         query_id, dispatch_started_at_ms, dispatch_deadline_at_ms,
         execution_started_at_ms, execution_deadline_at_ms, timeout_event_id,
         artifact_refs_value_id, artifact_refs_hash, result_value_id, result_hash,
         evaluation_value_id, evaluation_hash, quality_revision_feedback_value_id,
         quality_revision_feedback_hash, retry_reason_code, error_code,
         error_detail_value_id, error_detail_hash, usage_summary_value_id,
         usage_summary_hash, acceptance_state, run_work_fence_epoch,
         scope_work_fence_epoch, resource_reservation_group_id, lease_owner,
         lease_token, lease_expires_at_ms, heartbeat_at_ms,
         evaluation_lease_owner, evaluation_lease_token,
         evaluation_lease_expires_at_ms, evaluation_attempt_count,
         evaluation_next_attempt_at_ms, evaluation_deadline_at_ms, row_version,
         created_at_ms, updated_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'terminal', 'failed',
         NULL, '{}', NULL, NULL, '[]', ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, 'provider_unknown', 'provider_unknown', NULL, NULL, NULL, NULL,
         'fenced', 0, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
         NULL, NULL, 1, 700, 700, 700)`,
      [
        attemptId,
        target.graphRunId,
        target.rootScopeId,
        node.id,
        value.id,
        value.hash,
        `reservation-group:g7:${key}`,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_effect_operations (
         id, graph_run_id, scope_id, node_id, attempt_id, operation_key,
         key_strategy_json, key_strategy_hash, execution_lane, close_request_id,
         effect_type, status, request_value_id, request_hash, receipt_value_id,
         receipt_hash, before_state_value_id, before_state_hash,
         after_state_value_id, after_state_hash, immutable_output_snapshot_value_id,
         immutable_output_snapshot_hash, compensation_value_id, compensation_hash,
         lease_owner, lease_token, lease_expires_at_ms, row_version, created_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', NULL, 'mutable_fixture',
         'action_required', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, 1, 700, 700)`,
      [
        effectId,
        target.graphRunId,
        target.rootScopeId,
        node.id,
        attemptId,
        operationKey,
        canonicalJson({ type: 'attempt' }),
        g7Hash(`effect-key-strategy:${key}`),
        value.id,
        value.hash,
      ],
    );
  });
  return { attemptId, effectId, operationKey };
}

function appendIntegrityDetectionEvent(
  target: G7Fixture,
  key: string,
  evidence = target.seed.values.context!,
): number {
  return target.instance.store.withImmediateTransaction((transaction) => {
    const run = transaction.queryOne<{
      next_event_seq: number;
      row_version: number;
    }>(
      'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
      [target.graphRunId],
    )!;
    const sequence = run.next_event_seq + 1;
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET next_event_seq = ?, row_version = row_version + 1,
              updated_at_ms = 400
        WHERE id = ? AND row_version = ?`,
      [sequence, target.graphRunId, run.row_version],
    );
    insertGraphEvent(transaction, {
      graphRunId: target.graphRunId,
      sequence,
      scopeId: target.rootScopeId,
      nodeId: null,
      attemptId: null,
      eventType: 'orchestration_error',
      idempotencyKey: `integrity-detection:${key}`,
      payloadValueId: evidence.id,
      payloadHash: evidence.hash,
      occurredAtMs: 400,
      createdAtMs: 400,
    });
    return sequence;
  });
}

function prepareManualRetry(target: G7Fixture): {
  scheduleId: string;
  sourceAttemptId: string;
} {
  const node = firstNode(target);
  const plan = structuredClone(target.plan) as unknown as JsonObject;
  const planNodes = plan.nodes as JsonObject[];
  const planNode = planNodes.find(
    (candidate) => candidate.id === node.node_key,
  )!;
  const retryPolicy = planNode.effective_retry_policy as JsonObject;
  const policyHash = g7Hash('manual-retry-policy');
  planNode.effective_retry_policy = {
    ...retryPolicy,
    effective_node_max_attempts: 2,
    effective_retry_on: ['attempt_timeout'],
    policy_hash: policyHash,
  };
  const planWithoutHash = { ...plan };
  delete planWithoutHash.plan_hash;
  const planHash = domainSeparatedSha256(
    COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
    planWithoutHash,
  );
  plan.plan_hash = planHash;
  const sourceAttemptId = `attempt:g7:manual-retry`;
  const scheduleId = `retry-schedule:g7:manual`;
  const value = target.seed.values.context!;
  target.instance.store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `UPDATE workflow_graph_scope_plans SET compiled_plan_json = ?, plan_hash = ?
        WHERE id = ? AND graph_run_id = ?`,
      [canonicalJson(plan), planHash, target.rootPlanId, target.graphRunId],
    );
    transaction.execute(
      `UPDATE workflow_graph_scopes SET plan_hash = ?
        WHERE id = ? AND graph_run_id = ?`,
      [planHash, target.rootScopeId, target.graphRunId],
    );
    transaction.execute(
      `UPDATE workflow_graph_scope_builds SET compiled_plan_hash = ?
        WHERE compiled_plan_id = ? AND graph_run_id = ?`,
      [planHash, target.rootPlanId, target.graphRunId],
    );
    transaction.execute(
      `UPDATE workflow_plan_generated_schemas SET plan_hash = ?
        WHERE plan_id = ? AND graph_run_id = ?`,
      [planHash, target.rootPlanId, target.graphRunId],
    );
    transaction.execute(
      `UPDATE workflow_graph_runs SET root_plan_hash = ?
        WHERE id = ?`,
      [planHash, target.graphRunId],
    );
    transaction.execute(
      `UPDATE workflow_graph_nodes SET normalized_node_json = ?
        WHERE id = ?`,
      [canonicalJson(planNode), node.id],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_node_attempts (
         id, graph_run_id, scope_id, node_id, attempt_no, continuation_kind,
         parent_attempt_id, parent_attempt_no, phase, execution_outcome,
         quality_decision, input_snapshot_json, input_snapshot_value_id,
         input_snapshot_hash, selected_edges_json, context_pack_value_id,
         context_pack_hash, delegation_id, external_execution_id, action_name,
         query_id, dispatch_started_at_ms, dispatch_deadline_at_ms,
         execution_started_at_ms, execution_deadline_at_ms, timeout_event_id,
         artifact_refs_value_id, artifact_refs_hash, result_value_id, result_hash,
         evaluation_value_id, evaluation_hash, quality_revision_feedback_value_id,
         quality_revision_feedback_hash, retry_reason_code, error_code,
         error_detail_value_id, error_detail_hash, usage_summary_value_id,
         usage_summary_hash, acceptance_state, run_work_fence_epoch,
         scope_work_fence_epoch, resource_reservation_group_id, lease_owner,
         lease_token, lease_expires_at_ms, heartbeat_at_ms,
         evaluation_lease_owner, evaluation_lease_token,
         evaluation_lease_expires_at_ms, evaluation_attempt_count,
         evaluation_next_attempt_at_ms, evaluation_deadline_at_ms, row_version,
         created_at_ms, updated_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'terminal', 'failed',
         NULL, '{}', NULL, NULL, '[]', ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, 'attempt_timeout', 'attempt_timeout', NULL, NULL, NULL, NULL,
         'fenced', 0, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
         NULL, NULL, 1, 710, 710, 710)`,
      [
        sourceAttemptId,
        target.graphRunId,
        target.rootScopeId,
        node.id,
        value.id,
        value.hash,
        'reservation-group:g7:manual-retry-source',
      ],
    );
    const [reservationId] = reserveLedgerResources(transaction, {
      graphRunId: target.graphRunId,
      reservationGroupId: 'reservation-group:g7:manual-retry',
      consumer: { attemptId: sourceAttemptId },
      amounts: { attempts_total: 1 },
      purpose: 'execution_retry',
      settlementMode: 'consume_on_create',
      nowMs: 711,
    });
    const run = transaction.queryOne<{
      next_event_seq: number;
      row_version: number;
    }>(
      'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
      [target.graphRunId],
    )!;
    const sequence = run.next_event_seq + 1;
    transaction.execute(
      `UPDATE workflow_graph_runs SET next_event_seq = ?, control = 'paused',
              row_version = row_version + 1, updated_at_ms = 711
        WHERE id = ? AND row_version = ?`,
      [sequence, target.graphRunId, run.row_version],
    );
    insertGraphEvent(transaction, {
      graphRunId: target.graphRunId,
      sequence,
      scopeId: target.rootScopeId,
      nodeId: node.id,
      attemptId: sourceAttemptId,
      eventType: 'attempt_phase_changed',
      idempotencyKey: `retry-schedule:${scheduleId}`,
      occurredAtMs: 711,
      createdAtMs: 711,
    });
    transaction.execute(
      `UPDATE workflow_graph_nodes SET phase = 'retry_wait', ready_at_ms = 710,
              current_attempt_id = ?, current_attempt_no = 1,
              row_version = row_version + 1, updated_at_ms = 711
        WHERE id = ?`,
      [sourceAttemptId, node.id],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_retry_schedules (
         id, graph_run_id, scope_id, node_id, source_attempt_id,
         source_attempt_no, next_attempt_no, continuation_kind,
         quality_revision_feedback_value_id, quality_revision_feedback_hash,
         retry_reason_code, retry_policy_hash, backoff_ms, eligible_at_ms,
         attempt_reservation_id, status, row_version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 1, 2, 'execution_retry', NULL, NULL,
         'attempt_timeout', ?, 500, 1_211, ?, 'scheduled', 1, 711, 711)`,
      [
        scheduleId,
        target.graphRunId,
        target.rootScopeId,
        node.id,
        sourceAttemptId,
        policyHash,
        reservationId,
      ],
    );
  });
  return { scheduleId, sourceAttemptId };
}

function prepareReadyRootSchedules(
  target: G7Fixture,
  count: number,
): {
  closeRequestId: string;
  scheduleIds: readonly string[];
  rootCommit: T8RootCommitInput;
} {
  const runBeforeClose = target.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
  }>(
    'SELECT row_version, work_fence_epoch FROM workflow_graph_runs WHERE id = ?',
    [target.graphRunId],
  )!;
  const rootBeforeClose = target.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
  }>(
    `SELECT row_version, work_fence_epoch FROM workflow_graph_scopes
      WHERE id = ? AND graph_run_id = ?`,
    [target.rootScopeId, target.graphRunId],
  )!;
  const close = requestScopeCloseT7a(target.instance.store, {
    graphRunId: target.graphRunId,
    scopeId: target.rootScopeId,
    expectedRunRowVersion: runBeforeClose.row_version,
    expectedScopeRowVersion: rootBeforeClose.row_version,
    expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
    expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
    cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
    manifestSchema: target.seed.refs.fenceManifestSchema!,
    nowMs: 900,
  });
  const workflow = target.instance.store.queryOne<{
    state_instance_id: string;
    root_workflow_id: string;
    ownership_hash: Sha256Hash;
  }>(
    `SELECT state_instance_id, root_workflow_id, ownership_hash
       FROM workflows WHERE id = ?`,
    [target.workflowId],
  )!;
  const scheduleIds = Array.from({ length: count }, (_, index) => {
    const transitionEffectId = `g7:root-effect:${index}`;
    const creationDomain = `parent_workflow_lineage:${workflow.root_workflow_id}`;
    const creationKey = domainSeparatedSha256(
      'icarus:child-workflow-creation-key:1\n',
      {
        parent_workflow_id: target.workflowId,
        source_state_instance_id: workflow.state_instance_id,
        source_close_request_id: close.closeRequestId,
        transition_effect_id: transitionEffectId,
      },
    );
    const prepared = prepareRequiredFinalizationT0p(target.instance.store, {
      workflowId: target.workflowId,
      sourceStateInstanceId: workflow.state_instance_id,
      sourceRunId: target.graphRunId,
      rootScopeId: target.rootScopeId,
      closeRequestId: close.closeRequestId,
      transitionEffectId,
      recipe: target.seed.refs.recipe!,
      definition: target.seed.refs.definition!,
      executionPolicy: target.seed.refs.executionPolicy!,
      routingScope: target.seed.refs.routingScope!,
      finalizationPolicy: target.seed.refs.finalizationPolicy!,
      principalRef: 'human:local-owner',
      principalHash: g7Hash(`root-principal:${index}`),
      input: target.seed.values.childInput!,
      attachments: target.seed.values.attachments!,
      routingDecision: target.seed.values.routing!,
      creationIntentHash: calculateCreationIntentHash({
        creationDomain,
        creationKey,
        principalRef: 'human:local-owner',
        ownershipHash: workflow.ownership_hash,
        routingScope: target.seed.refs.routingScope!,
        recipe: target.seed.refs.recipe!,
        entryPoint: 'default',
        inputHash: target.seed.values.childInput!.hash,
        attachmentManifestHash: target.seed.values.attachments!.hash,
      }),
      runtimeSafetyHash: target.seed.values.safety!.hash,
      maxAttempts: 3,
      deadlineAtMs: 10_000,
      nowMs: 901 + index * 2,
    });
    expect(
      recordRootFinalizationAttempt(target.instance.store, {
        scheduleId: prepared.scheduleId,
        expectedScheduleRowVersion: 1,
        frozenResolution: target.seed.values.context!,
        claimPreflight: target.seed.values.context!,
        result: 'ready',
        exhaustionEvidence: target.seed.values.context!,
        remediationPolicy: target.remediationPolicy,
        remediationDeadlineAtMs: 10_000,
        nowMs: 902 + index * 2,
      }).status,
    ).toBe('ready');
    return prepared.scheduleId;
  });
  const authority = target.instance.store.queryOne<{
    workflow_row_version: number;
    activation_row_version: number;
    run_row_version: number;
    root_row_version: number;
  }>(
    `SELECT w.row_version AS workflow_row_version,
            a.row_version AS activation_row_version,
            r.row_version AS run_row_version, s.row_version AS root_row_version
       FROM workflows w
       JOIN workflow_state_activations a ON a.id = w.state_instance_id
       JOIN workflow_graph_runs r ON r.id = w.current_graph_run_id
       JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
      WHERE w.id = ?`,
    [target.workflowId],
  )!;
  return {
    closeRequestId: close.closeRequestId,
    scheduleIds,
    rootCommit: {
      workflowId: target.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: target.graphRunId,
      rootScopeId: target.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: authority.workflow_row_version + 100,
      expectedSourceActivationRowVersion: authority.activation_row_version,
      expectedSourceRunRowVersion: authority.run_row_version,
      expectedRootScopeRowVersion: authority.root_row_version,
      routeSource: 'on_error',
      target: {
        kind: 'terminal',
        stateKey: 'failed',
        definition: target.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: target.seed.values.stateConfig!,
        terminalKind: 'errored',
        output: null,
        outputSchemaHash: null,
        errorCode: 'root_fixture_error',
        errorDetail: null,
      },
      contextValueSchema: target.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs: 920,
    },
  };
}

function commandInput(
  target: G7Fixture,
  command: WorkflowRuntimeCommandDocument,
  nowMs: number,
  overrides: Partial<RuntimeCommandGatewayInput> = {},
): RuntimeCommandGatewayInput {
  return {
    command,
    actor: target.actor,
    auditSchema: target.seed.refs.schema!,
    fenceManifestSchema: target.seed.refs.fenceManifestSchema!,
    capacityWatcher: target.capacityWatcher,
    nowMs,
    ...overrides,
  };
}

function expectCommandAuditAbsent(
  target: G7Fixture,
  submittedCommandId: string,
): void {
  expect(
    target.instance.store.queryOne<{ count: number }>(
      `SELECT
         (SELECT count(*) FROM workflow_runtime_commands
           WHERE command_id = ?) +
         (SELECT count(*) FROM workflow_runtime_command_invocations
           WHERE command_id = ?) +
         (SELECT count(*) FROM workflow_runtime_command_ingress_invocations
           WHERE submitted_command_id = ?) AS count`,
      [submittedCommandId, submittedCommandId, submittedCommandId],
    )!.count,
  ).toBe(0);
}

describe('G7 command, recovery, and resolution', () => {
  it('audits pause/resume duplicate and conflict invocations and resumes without resetting authority', () => {
    const target = fixture('control-idempotency');
    const pause: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:pause:1',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'pause:1',
      expected_row_version: runVersion(target),
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    const applied = submitRuntimeCommand(
      target.instance.store,
      commandInput(target, pause, 100),
    );
    expect(applied).toMatchObject({
      executionResult: 'applied',
      denialCode: null,
    });
    const canonicalHeader = target.instance.store.queryOne<{
      canonical_result_value_id: string;
      canonical_result_hash: Sha256Hash;
    }>(
      `SELECT canonical_result_value_id, canonical_result_hash
         FROM workflow_runtime_commands WHERE command_id = ?`,
      [pause.command_id],
    )!;
    const valueCount = target.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_values',
      [],
    )!.count;
    const duplicate = submitRuntimeCommand(
      target.instance.store,
      commandInput(target, pause, 101, {
        actor: {
          ...target.actor,
          permissions: new Set<RuntimePermissionCode>(),
        },
      }),
    );
    expect(duplicate).toMatchObject({
      commandId: 'g7:pause:1',
      executionResult: 'duplicate',
      canonicalResult: applied.canonicalResult,
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_values',
        [],
      )!.count,
    ).toBe(valueCount);
    const conflict = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        { ...pause, command_id: 'g7:pause:drift', reason_text: 'different' },
        102,
      ),
    );
    expect(conflict).toMatchObject({
      commandId: 'g7:pause:1',
      executionResult: 'conflict',
      denialCode: 'idempotency_conflict',
    });
    expect(
      target.instance.store.queryAll(
        'SELECT id FROM workflow_runtime_command_invocations WHERE command_id = ? ORDER BY invocation_no',
        ['g7:pause:1'],
      ),
    ).toHaveLength(3);
    expect(
      target.instance.store.queryAll(
        `SELECT execution_result, authorization_result, resolution_result,
                resolved_command_id, resolved_invocation_id
           FROM workflow_runtime_command_ingress_invocations
          WHERE idempotency_key = ? ORDER BY ingress_no`,
        [pause.idempotency_key],
      ),
    ).toEqual([
      expect.objectContaining({
        execution_result: 'applied',
        authorization_result: 'allowed',
        resolution_result: 'resolved',
        resolved_command_id: pause.command_id,
        resolved_invocation_id: applied.invocationId,
      }),
      expect.objectContaining({
        execution_result: 'duplicate',
        authorization_result: 'not_evaluated',
        resolution_result: 'resolved',
        resolved_command_id: pause.command_id,
        resolved_invocation_id: duplicate.invocationId,
      }),
      expect.objectContaining({
        execution_result: 'conflict',
        authorization_result: 'not_evaluated',
        resolution_result: 'resolved',
        resolved_command_id: pause.command_id,
        resolved_invocation_id: conflict.invocationId,
      }),
    ]);
    expect(
      target.instance.store.queryOne(
        `SELECT canonical_result_value_id, canonical_result_hash
           FROM workflow_runtime_commands WHERE command_id = ?`,
        [pause.command_id],
      ),
    ).toEqual(canonicalHeader);

    const resume = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:resume:1',
          command_type: 'resume_run',
          target: { run_id: target.graphRunId },
          idempotency_key: 'resume:1',
          expected_row_version: runVersion(target),
          reason_code: 'operator_requested',
          evidence_refs: [],
        },
        110,
      ),
    );
    expect(resume.canonicalResult).toMatchObject({ control: 'resuming' });
    const before = target.instance.store.queryOne<{
      work_fence_epoch: number;
      ledger_seq: number;
      lifecycle: string;
      row_version: number;
    }>(
      'SELECT work_fence_epoch, ledger_seq, lifecycle, row_version FROM workflow_graph_runs WHERE id = ?',
      [target.graphRunId],
    )!;
    const recovered = coordinateGraphRecoveryG7(target.instance.store, {
      graphRunId: target.graphRunId,
      expectedRunRowVersion: before.row_version,
      integrityEvidence: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      remediationDeadlineAtMs: 10_000,
      nowMs: 120,
    });
    expect(recovered.disposition).toBe('resumed');
    expect(
      target.instance.store.queryOne(
        'SELECT control, work_fence_epoch, ledger_seq, lifecycle FROM workflow_graph_runs WHERE id = ?',
        [target.graphRunId],
      ),
    ).toMatchObject({
      control: 'running',
      work_fence_epoch: before.work_fence_epoch,
      ledger_seq: before.ledger_seq,
      lifecycle: before.lifecycle,
    });
    target.instance.closeStore();
    target.instance.reopenStore();
    expect(
      target.instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_events WHERE graph_run_id = ? AND event_type = 'recovery_decision_recorded'",
        [target.graphRunId],
      )!.count,
    ).toBe(1);
  });

  it('persists closed authorization denials without mutating the target', () => {
    const target = fixture('authorization');
    const version = runVersion(target);
    const base: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:auth:permission',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'auth:permission',
      expected_row_version: version,
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    const denied = submitRuntimeCommand(
      target.instance.store,
      commandInput(target, base, 200, {
        actor: {
          ...target.actor,
          permissions: new Set<RuntimePermissionCode>(),
        },
      }),
    );
    expect(denied).toMatchObject({
      executionResult: 'denied',
      denialCode: 'permission_denied',
    });
    const ceiling = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          ...base,
          command_id: 'g7:auth:ceiling',
          idempotency_key: 'auth:ceiling',
        },
        201,
        { actor: { ...target.actor, featurePermissionCeiling: new Set() } },
      ),
    );
    expect(ceiling.denialCode).toBe('feature_ceiling_denied');
    const stale = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          ...base,
          command_id: 'g7:auth:stale',
          idempotency_key: 'auth:stale',
          expected_row_version: version + 1,
        },
        202,
      ),
    );
    expect(stale).toMatchObject({
      executionResult: 'conflict',
      denialCode: 'row_version_conflict',
    });
    expect(runVersion(target)).toBe(version);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_command_invocations',
        [],
      )!.count,
    ).toBe(3);
    const missing = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          ...base,
          command_id: 'g7:missing',
          idempotency_key: 'missing',
          target: { run_id: 'missing-run' },
        },
        203,
      ),
    );
    expect(missing).toMatchObject({
      commandId: null,
      invocationId: null,
      denialCode: 'target_not_found',
    });
    expect(missing.ingressInvocationId).toMatch(/^runtime-command-ingress:/);
    expect(
      target.instance.store.queryOne(
        `SELECT resolution_result, execution_result, denial_code,
                resolved_command_id, resolved_invocation_id
           FROM workflow_runtime_command_ingress_invocations WHERE id = ?`,
        [missing.ingressInvocationId],
      ),
    ).toMatchObject({
      resolution_result: 'target_not_found',
      execution_result: 'denied',
      denial_code: 'target_not_found',
      resolved_command_id: null,
      resolved_invocation_id: null,
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_commands WHERE command_id = ?',
        ['g7:missing'],
      )!.count,
    ).toBe(0);

    const mismatched = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          ...base,
          command_id: 'g7:target-kind-invalid',
          idempotency_key: 'target-kind-invalid',
          target: { workflow_id: target.workflowId },
        } as unknown as WorkflowRuntimeCommandDocument,
        204,
      ),
    );
    expect(mismatched).toMatchObject({
      commandId: null,
      invocationId: null,
      executionResult: 'denied',
      denialCode: 'target_kind_invalid',
    });
    expect(mismatched.ingressInvocationId).toMatch(/^runtime-command-ingress:/);
  });

  it('uses the fixed deadline System Grant/key and audits winner, duplicate, and late decisions', () => {
    const target = fixture('deadline');
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflows SET deadline_at_ms = 300 WHERE id = ?',
        [target.workflowId],
      );
    });
    const [winner] = fireWorkflowDeadlineWatchdog(target.instance.store, {
      auditSchema: target.seed.refs.schema!,
      fenceManifestSchema: target.seed.refs.fenceManifestSchema!,
      capacityWatcher: target.capacityWatcher,
      reasonCode: 'deadline_enforced',
      nowMs: 300,
    });
    expect(winner).toMatchObject({ executionResult: 'applied' });
    const header = target.instance.store.queryOne<{
      idempotency_domain: string;
      idempotency_key: string;
    }>(
      'SELECT idempotency_domain, idempotency_key FROM workflow_runtime_commands WHERE command_id = ?',
      [winner!.commandId],
    )!;
    expect(header).toEqual({
      idempotency_domain: 'system:deadline-watchdog',
      idempotency_key: `workflow-deadline:${target.workflowId}:300`,
    });
    const [duplicate] = fireWorkflowDeadlineWatchdog(target.instance.store, {
      auditSchema: target.seed.refs.schema!,
      fenceManifestSchema: target.seed.refs.fenceManifestSchema!,
      capacityWatcher: target.capacityWatcher,
      reasonCode: 'deadline_enforced',
      nowMs: 301,
    });
    expect(duplicate).toMatchObject({ executionResult: 'duplicate' });

    const lateTarget = fixture('deadline-late');
    const humanWinner = submitRuntimeCommand(
      lateTarget.instance.store,
      commandInput(
        lateTarget,
        {
          command_id: 'g7:human-cancel',
          command_type: 'cancel_workflow',
          target: { workflow_id: lateTarget.workflowId },
          idempotency_key: 'human-cancel',
          expected_row_version: workflowVersion(lateTarget),
          reason_code: 'operator_requested',
          evidence_refs: [],
        },
        310,
      ),
    );
    expect(humanWinner).toMatchObject({
      executionResult: 'applied',
      denialCode: null,
    });
    lateTarget.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflows SET deadline_at_ms = 311 WHERE id = ?',
        [lateTarget.workflowId],
      );
    });
    const [late] = fireWorkflowDeadlineWatchdog(lateTarget.instance.store, {
      auditSchema: lateTarget.seed.refs.schema!,
      fenceManifestSchema: lateTarget.seed.refs.fenceManifestSchema!,
      capacityWatcher: lateTarget.capacityWatcher,
      reasonCode: 'safety_enforced',
      nowMs: 311,
    });
    expect(late).toMatchObject({
      executionResult: 'late',
      denialCode: 'late_command',
    });
  });

  it('applies manual skip and local-run cancel without reopening terminal work', () => {
    const skipTarget = fixture('manual-skip');
    const pause = submitRuntimeCommand(
      skipTarget.instance.store,
      commandInput(
        skipTarget,
        {
          command_id: 'g7:skip-pause',
          command_type: 'pause_run',
          target: { run_id: skipTarget.graphRunId },
          idempotency_key: 'skip-pause',
          expected_row_version: runVersion(skipTarget),
          reason_code: 'operator_requested',
          evidence_refs: [],
        },
        350,
      ),
    );
    expect(pause.executionResult).toBe('applied');
    const node = firstNode(skipTarget);
    const skipped = submitRuntimeCommand(
      skipTarget.instance.store,
      commandInput(
        skipTarget,
        {
          command_id: 'g7:manual-skip',
          command_type: 'skip_node',
          target: { node_id: node.id },
          idempotency_key: 'manual-skip',
          expected_row_version: node.row_version,
          reason_code: 'no_longer_needed',
          evidence_refs: [],
        },
        351,
      ),
    );
    expect(skipped).toMatchObject({ executionResult: 'applied' });
    expect(
      skipTarget.instance.store.queryOne(
        'SELECT phase, terminal_status, terminal_code FROM workflow_graph_nodes WHERE id = ?',
        [node.id],
      ),
    ).toMatchObject({
      phase: 'terminal',
      terminal_status: 'skipped',
      terminal_code: 'manual_skip',
    });
    expect(
      skipTarget.instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_kind = 'node_terminal'",
        [skipTarget.graphRunId],
      )!.count,
    ).toBe(1);

    const cancelTarget = fixture('cancel-run');
    const cancelled = submitRuntimeCommand(
      cancelTarget.instance.store,
      commandInput(
        cancelTarget,
        {
          command_id: 'g7:cancel-run',
          command_type: 'cancel_run',
          target: { run_id: cancelTarget.graphRunId },
          idempotency_key: 'cancel-run',
          expected_row_version: runVersion(cancelTarget),
          reason_code: 'operator_requested',
          evidence_refs: [],
        },
        352,
      ),
    );
    expect(cancelled).toMatchObject({ executionResult: 'applied' });
    expect(
      cancelTarget.instance.store.queryOne(
        'SELECT lifecycle, control, root_cancel_scope FROM workflow_graph_runs WHERE id = ?',
        [cancelTarget.graphRunId],
      ),
    ).toMatchObject({
      lifecycle: 'closing',
      control: 'cancelling',
      root_cancel_scope: 'local_graph',
    });
    expect(
      new WorkflowRuntimeTransactionAuthority(
        cancelTarget.instance.store,
      ).advance('close', 4, 353).processed,
    ).toBe(1);
    expect(
      cancelTarget.instance.store.queryOne<{
        status: string;
        current_graph_run_id: string | null;
        state_key: string;
      }>(
        `SELECT workflow.status, workflow.current_graph_run_id,
                activation.state_key
           FROM workflows workflow
           JOIN workflow_state_activations activation
             ON activation.id = workflow.state_instance_id
          WHERE workflow.id = ?`,
        [cancelTarget.workflowId],
      ),
    ).toEqual({
      status: 'errored',
      current_graph_run_id: null,
      state_key: 'cancelled',
    });
  });

  it('replans only from trusted supersession evidence after the T7a compensation barrier', () => {
    const oldConfirmation = {
      format: 'icarus.temporary-workflow-confirmation/1',
      source_json: { scope_key: 'old-child' },
      source_hash: g7Hash('temporary-replan:old-source'),
      plan_hash: g7Hash('temporary-replan:old-plan'),
    };
    const stateInvariant = { fixed_outer: 'g7-temporary-replan' };
    const target = createG7Fixture('temporary-replan', {
      temporaryReplanRoute: true,
      stateConfigContent: {
        ...stateInvariant,
        temporary_confirmation: oldConfirmation,
      },
    });
    fixtures.push(target);
    const sourceActivationId = target.instance.store.queryOne<{
      state_instance_id: string;
    }>('SELECT state_instance_id FROM workflows WHERE id = ?', [
      target.workflowId,
    ])!.state_instance_id;
    const targetConfigId = stableRuntimeId('value', {
      kind: 'temporary-replan-state-config',
      workflow_id: target.workflowId,
      creation_key: 'replan:g7:1',
    });
    const targetConfigHash = g7Hash('temporary-replan:target-state-config');
    const targetConfig: JsonObject = {
      ...stateInvariant,
      temporary_confirmation: {
        format: 'icarus.temporary-workflow-confirmation/1',
        source_json: { scope_key: 'new-child' },
        source_hash: g7Hash('temporary-replan:new-source'),
        plan_hash: g7Hash('temporary-replan:new-plan'),
      },
      temporary_replan: {
        format: 'icarus.temporary-replan-target/1',
        source_workflow_id: target.workflowId,
        source_activation_id: sourceActivationId,
        source_run_id: target.graphRunId,
        source_state_config_hash: target.seed.values.stateConfig!.hash,
        creation_key: 'replan:g7:1',
        confirmation_ref: 'confirmation:g7:temporary-replan',
      },
    };
    target.instance.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: targetConfigId,
        content: targetConfig,
        contentHash: targetConfigHash,
        schemaResourceId: target.seed.refs.schema!.rowId,
        schemaResourceHash: target.seed.refs.schema!.hash,
        provenanceRef: 'task-workspace:replan:g7:1:state-config',
        retentionClass: 'run_recovery',
        ownerGraphRunId: target.graphRunId,
        createdAtMs: 1_000,
      });
    });
    const effect = seedTerminalAttemptAndEffect(target, 'temporary-replan');
    const recoveryValue = target.seed.values.context!;
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_effect_operations
            SET status = 'succeeded', receipt_value_id = ?, receipt_hash = ?,
                after_state_value_id = ?, after_state_hash = ?,
                immutable_output_snapshot_value_id = ?,
                immutable_output_snapshot_hash = ?, row_version = row_version + 1
          WHERE id = ? AND status = 'action_required'`,
        [
          recoveryValue.id,
          recoveryValue.hash,
          recoveryValue.id,
          recoveryValue.hash,
          recoveryValue.id,
          recoveryValue.hash,
          effect.effectId,
        ],
      );
    });
    const frozenPlanBytes = canonicalJson(
      target.instance.store.queryAll<Record<string, unknown>>(
        `SELECT id, plan_hash, compiled_plan_json
           FROM workflow_graph_scope_plans WHERE graph_run_id = ?
          ORDER BY id COLLATE BINARY`,
        [target.graphRunId],
      ) as unknown as JsonObject[],
    );
    const cancelled = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:temporary-replan',
          command_type: 'cancel_run',
          target: { run_id: target.graphRunId },
          idempotency_key: 'temporary-replan',
          expected_row_version: runVersion(target),
          reason_code: 'superseded',
          evidence_refs: [targetConfigId, targetConfigHash],
        },
        1_001,
        {
          actor: {
            ...target.actor,
            authSessionRef: 'task-workspace:temporary-replan',
            entrypoint: 'task_workspace',
          },
        },
      ),
    );
    expect(cancelled).toMatchObject({
      executionResult: 'applied',
      denialCode: null,
    });
    expect(
      target.instance.store.queryOne<{
        status: string;
        execution_lane: string;
      }>(
        'SELECT status, execution_lane FROM workflow_graph_effect_operations WHERE id = ?',
        [effect.effectId],
      ),
    ).toEqual({
      status: 'compensation_pending',
      execution_lane: 'close_cleanup',
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_events
          WHERE graph_run_id = ? AND event_type = 'subtree_fenced'`,
        [target.graphRunId],
      )!.count,
    ).toBe(1);

    const authority = new WorkflowRuntimeTransactionAuthority(
      target.instance.store,
    );
    expect(() => authority.advance('close', 8, 1_002)).toThrow(
      /successful compensation/,
    );
    expect(
      target.instance.store.queryOne<{ current_graph_run_id: string }>(
        'SELECT current_graph_run_id FROM workflows WHERE id = ?',
        [target.workflowId],
      )!.current_graph_run_id,
    ).toBe(target.graphRunId);

    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_effect_operations
            SET status = 'compensated', compensation_value_id = ?,
                compensation_hash = ?, row_version = row_version + 1,
                updated_at_ms = ?
          WHERE id = ? AND status = 'compensation_pending'`,
        [recoveryValue.id, recoveryValue.hash, 1_003, effect.effectId],
      );
    });
    expect(authority.advance('close', 8, 1_004).processed).toBe(1);
    const workflow = target.instance.store.queryOne<{
      status: string;
      state_instance_id: string;
      current_graph_run_id: string;
      state_activation_count: number;
      graph_run_count: number;
    }>(
      `SELECT status, state_instance_id, current_graph_run_id,
              state_activation_count, graph_run_count
         FROM workflows WHERE id = ?`,
      [target.workflowId],
    )!;
    expect(workflow).toMatchObject({
      status: 'active',
      state_activation_count: 2,
      graph_run_count: 2,
    });
    expect(workflow.current_graph_run_id).not.toBe(target.graphRunId);
    expect(workflow.state_instance_id).not.toBe(sourceActivationId);
    expect(
      target.instance.store.queryOne<{
        workflow_id: string;
        state_key: string;
        state_config_value_id: string;
      }>(
        'SELECT workflow_id, state_key, state_config_value_id FROM workflow_graph_runs WHERE id = ?',
        [workflow.current_graph_run_id],
      ),
    ).toEqual({
      workflow_id: target.workflowId,
      state_key: 'run',
      state_config_value_id: targetConfigId,
    });
    expect(
      target.instance.store.queryOne<{
        lifecycle: string;
        outcome_kind: string;
        completion_cut_id: string;
      }>(
        'SELECT lifecycle, outcome_kind, completion_cut_id FROM workflow_graph_runs WHERE id = ?',
        [target.graphRunId],
      ),
    ).toMatchObject({ lifecycle: 'closed', outcome_kind: 'cancelled' });
    expect(
      canonicalJson(
        target.instance.store.queryAll<Record<string, unknown>>(
          `SELECT id, plan_hash, compiled_plan_json
             FROM workflow_graph_scope_plans WHERE graph_run_id = ?
            ORDER BY id COLLATE BINARY`,
          [target.graphRunId],
        ) as unknown as JsonObject[],
      ),
    ).toBe(frozenPlanBytes);
  });

  it('authorizes manual retry before consuming the existing T6d schedule early', () => {
    const target = fixture('manual-retry');
    const prepared = prepareManualRetry(target);
    const receipt = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:advance-retry',
          command_type: 'advance_retry_schedule',
          target: { retry_schedule_id: prepared.scheduleId },
          idempotency_key: 'advance-retry',
          expected_row_version: 1,
          reason_code: 'operator_requested',
          evidence_refs: [],
        },
        712,
      ),
    );
    expect(receipt).toMatchObject({ executionResult: 'applied' });
    expect(
      target.instance.store.queryOne(
        'SELECT status, row_version FROM workflow_graph_retry_schedules WHERE id = ?',
        [prepared.scheduleId],
      ),
    ).toMatchObject({ status: 'consumed', row_version: 2 });
    const nextAttempt = target.instance.store.queryOne<{
      id: string;
      parent_attempt_id: string;
      attempt_no: number;
      phase: string;
      input_snapshot_json: string;
    }>(
      'SELECT id, parent_attempt_id, attempt_no, phase, input_snapshot_json FROM workflow_graph_node_attempts WHERE parent_attempt_id = ?',
      [prepared.sourceAttemptId],
    )!;
    expect(nextAttempt).toMatchObject({
      parent_attempt_id: prepared.sourceAttemptId,
      attempt_no: 2,
      phase: 'preparing',
      input_snapshot_json: '{}',
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_command_invocations WHERE command_id = ?',
        ['g7:advance-retry'],
      )!.count,
    ).toBe(1);
  });

  it('runs all three effect remediation commands through T6e source verification', () => {
    const cases = [
      {
        key: 'effect-reconcile',
        commandType: 'reconcile_effect' as const,
        reasonCode: 'provider_reconciled' as const,
        verification: { kind: 'retry_wait' as const, nextEligibleAtMs: 850 },
        expectedEffectStatus: 'action_required',
        expectedBlockerStatus: 'open',
      },
      {
        key: 'effect-receipt',
        commandType: 'submit_effect_receipt' as const,
        reasonCode: 'receipt_recovered' as const,
        verification: 'receipt' as const,
        expectedEffectStatus: 'succeeded',
        expectedBlockerStatus: 'resolved',
      },
      {
        key: 'effect-not-applied',
        commandType: 'verify_effect_not_applied' as const,
        reasonCode: 'not_applied_verified' as const,
        verification: 'not_applied' as const,
        expectedEffectStatus: 'failed',
        expectedBlockerStatus: 'resolved',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const target = fixture(testCase.key);
      const effect = seedTerminalAttemptAndEffect(target, testCase.key);
      const blocker = openOperationalBlocker(target.instance.store, {
        workflowId: target.workflowId,
        graphRunId: target.graphRunId,
        blockerKind: 'effect_unknown',
        severity: 'action_required',
        source: { kind: 'effect', id: effect.effectId },
        errorCode: 'effect_outcome_unknown',
        evidenceManifest: target.seed.values.context!,
        remediationPolicy: target.remediationPolicy,
        nextRemediationAtMs: null,
        remediationDeadlineAtMs: 10_000,
        nowMs: 800 + index,
      });
      const value = target.seed.values.context!;
      const verification =
        testCase.verification === 'receipt'
          ? {
              kind: 'effect_receipt' as const,
              operationKey: effect.operationKey,
              receipt: value,
              afterSnapshot: value,
              immutableOutputSnapshot: value,
            }
          : testCase.verification === 'not_applied'
            ? {
                kind: 'effect_not_applied' as const,
                operationKey: effect.operationKey,
              }
            : testCase.verification;
      const result = submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          {
            command_id: `g7:${testCase.key}`,
            command_type: testCase.commandType,
            target: { effect_operation_id: effect.effectId },
            idempotency_key: testCase.key,
            expected_row_version: 1,
            reason_code: testCase.reasonCode,
            evidence_refs: ['provider-evidence'],
          },
          810 + index,
          { verification },
        ),
      );
      expect(result.executionResult).toBe('applied');
      expect(
        target.instance.store.queryOne(
          'SELECT status FROM workflow_graph_effect_operations WHERE id = ?',
          [effect.effectId],
        ),
      ).toMatchObject({ status: testCase.expectedEffectStatus });
      expect(
        target.instance.store.queryOne(
          'SELECT status FROM workflow_operational_blockers WHERE id = ?',
          [blocker.blockerId],
        ),
      ).toMatchObject({ status: testCase.expectedBlockerStatus });
    }
  });

  it('resolves compensation and resource blockers only from their typed sources', () => {
    const compensationTarget = fixture('compensation-source');
    const effect = seedTerminalAttemptAndEffect(
      compensationTarget,
      'compensation-source',
    );
    const compensationBlocker = openOperationalBlocker(
      compensationTarget.instance.store,
      {
        workflowId: compensationTarget.workflowId,
        graphRunId: compensationTarget.graphRunId,
        blockerKind: 'compensation_dead_letter',
        severity: 'action_required',
        source: { kind: 'effect', id: effect.effectId },
        errorCode: 'compensation_dead_letter',
        evidenceManifest: compensationTarget.seed.values.context!,
        remediationPolicy: compensationTarget.remediationPolicy,
        nextRemediationAtMs: null,
        remediationDeadlineAtMs: 10_000,
        nowMs: 820,
      },
    );
    const compensation = submitRuntimeCommand(
      compensationTarget.instance.store,
      commandInput(
        compensationTarget,
        {
          command_id: 'g7:compensation-source',
          command_type: 'remediate_operational_blocker',
          target: {
            operational_blocker_id: compensationBlocker.blockerId,
          },
          idempotency_key: 'compensation-source',
          expected_row_version: 1,
          reason_code: 'receipt_recovered',
          evidence_refs: ['compensation-receipt'],
        },
        821,
        {
          verification: {
            kind: 'compensation_succeeded',
            operationKey: effect.operationKey,
            compensation: compensationTarget.seed.values.context!,
          },
        },
      ),
    );
    expect(compensation.executionResult).toBe('applied');
    expect(
      compensationTarget.instance.store.queryOne(
        'SELECT status FROM workflow_graph_effect_operations WHERE id = ?',
        [effect.effectId],
      ),
    ).toMatchObject({ status: 'compensated' });

    const resourceTarget = fixture('resource-source');
    const schedule = prepareManualRetry(resourceTarget);
    const eventSequence = resourceTarget.instance.store.queryOne<{
      seq: number;
    }>(
      'SELECT max(seq) AS seq FROM workflow_graph_events WHERE graph_run_id = ?',
      [resourceTarget.graphRunId],
    )!.seq;
    const resourceBlocker = openOperationalBlocker(
      resourceTarget.instance.store,
      {
        workflowId: resourceTarget.workflowId,
        graphRunId: resourceTarget.graphRunId,
        blockerKind: 'resource_or_credential_unavailable',
        severity: 'action_required',
        source: { kind: 'event', sequence: eventSequence },
        errorCode: 'credential_unavailable',
        evidenceManifest: resourceTarget.seed.values.context!,
        remediationPolicy: resourceTarget.remediationPolicy,
        nextRemediationAtMs: null,
        remediationDeadlineAtMs: 10_000,
        nowMs: 822,
      },
    );
    const resource = submitRuntimeCommand(
      resourceTarget.instance.store,
      commandInput(
        resourceTarget,
        {
          command_id: 'g7:resource-source',
          command_type: 'remediate_operational_blocker',
          target: { operational_blocker_id: resourceBlocker.blockerId },
          idempotency_key: 'resource-source',
          expected_row_version: 1,
          reason_code: 'credential_restored',
          evidence_refs: ['credential-preflight'],
        },
        823,
        {
          verification: {
            kind: 'resource_preflight_scheduled',
            retryScheduleId: schedule.scheduleId,
          },
        },
      ),
    );
    expect(resource.executionResult).toBe('applied');
  });

  it('rejects a resource preflight schedule spliced onto another persisted source event', () => {
    const target = fixture('resource-source-splice');
    const schedule = prepareManualRetry(target);
    const unrelatedEventSequence = target.instance.store.queryOne<{
      seq: number;
    }>(
      'SELECT min(seq) AS seq FROM workflow_graph_events WHERE graph_run_id = ?',
      [target.graphRunId],
    )!.seq;
    const blocker = openOperationalBlocker(target.instance.store, {
      workflowId: target.workflowId,
      graphRunId: target.graphRunId,
      blockerKind: 'resource_or_credential_unavailable',
      severity: 'action_required',
      source: { kind: 'event', sequence: unrelatedEventSequence },
      errorCode: 'credential_unavailable',
      evidenceManifest: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 824,
    });
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          {
            command_id: 'g7:resource-source-splice',
            command_type: 'remediate_operational_blocker',
            target: { operational_blocker_id: blocker.blockerId },
            idempotency_key: 'resource-source-splice',
            expected_row_version: 1,
            reason_code: 'credential_restored',
            evidence_refs: ['credential-preflight'],
          },
          825,
          {
            verification: {
              kind: 'resource_preflight_scheduled',
              retryScheduleId: schedule.scheduleId,
            },
          },
        ),
      ),
    ).toThrow(/persisted source event/);
    expect(
      target.instance.store.queryOne(
        'SELECT status FROM workflow_operational_blockers WHERE id = ?',
        [blocker.blockerId],
      ),
    ).toMatchObject({ status: 'open' });
  });

  it('resolves source-verified blockers and restores only after the last severity closes', () => {
    const target = fixture('blockers', 2);
    const [claim, otherClaim] = target.instance.store.queryAll<{
      id: string;
      row_version: number;
      fencing_token: number;
      namespace: string;
      key_hash: string;
    }>(
      `SELECT id, row_version, fencing_token, namespace, key_hash
         FROM workflow_domain_resource_claims WHERE owner_workflow_id = ?
        ORDER BY id COLLATE BINARY`,
      [target.workflowId],
    );
    expect(claim).toBeDefined();
    expect(otherClaim).toBeDefined();
    const action = openOperationalBlocker(target.instance.store, {
      workflowId: target.workflowId,
      graphRunId: target.graphRunId,
      blockerKind: 'claim_release_failed',
      severity: 'action_required',
      source: { kind: 'claim', id: claim.id },
      errorCode: 'claim_release_failed',
      evidenceManifest: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 400,
    });
    const sourceEvent = appendIntegrityDetectionEvent(
      target,
      'last-blocker-restoration',
    );
    const quarantine = openOperationalBlocker(target.instance.store, {
      workflowId: target.workflowId,
      graphRunId: target.graphRunId,
      blockerKind: 'integrity_quarantine',
      severity: 'quarantine',
      source: { kind: 'event', sequence: sourceEvent },
      errorCode: 'integrity_hash_mismatch',
      evidenceManifest: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 401,
    });
    const claimHeads = [claim!, otherClaim!].map((candidate) => ({
      claim: candidate,
      head: target.instance.store.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_domain_resource_heads WHERE namespace = ? AND key_hash = ?',
        [candidate.namespace, candidate.key_hash],
      )!,
    }));
    target.instance.store.withImmediateTransaction((transaction) => {
      for (const candidate of claimHeads)
        releaseDomainClaim(transaction, {
          claimId: candidate.claim.id,
          ownerWorkflowId: target.workflowId,
          expectedClaimRowVersion: candidate.claim.row_version,
          expectedHeadRowVersion: candidate.head.row_version,
          expectedFencingToken: candidate.claim.fencing_token,
          releasedAtMs: 402,
        });
    });
    const actionVersion = target.instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_operational_blockers WHERE id = ?', [
      action.blockerId,
    ])!.row_version;
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          {
            command_id: 'g7:resolve-unbound-claim',
            command_type: 'remediate_operational_blocker',
            target: { operational_blocker_id: action.blockerId },
            idempotency_key: 'resolve-unbound-claim',
            expected_row_version: actionVersion,
            reason_code: 'dependency_recovered',
            evidence_refs: ['other-claim-release-receipt'],
          },
          403,
          {
            verification: {
              kind: 'claim_released',
              claimId: otherClaim!.id,
            },
          },
        ),
      ),
    ).toThrow(/verification did not close claim_release_failed/);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_commands WHERE command_id = ?',
        ['g7:resolve-unbound-claim'],
      )!.count,
    ).toBe(0);
    const resolved = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:resolve-claim',
          command_type: 'remediate_operational_blocker',
          target: { operational_blocker_id: action.blockerId },
          idempotency_key: 'resolve-claim',
          expected_row_version: actionVersion,
          reason_code: 'dependency_recovered',
          evidence_refs: ['claim-release-receipt'],
        },
        403,
        { verification: { kind: 'claim_released', claimId: claim!.id } },
      ),
    );
    expect(resolved.executionResult).toBe('applied');
    expect(
      target.instance.store.queryOne(
        'SELECT operational_state FROM workflow_graph_runs WHERE id = ?',
        [target.graphRunId],
      ),
    ).toMatchObject({ operational_state: 'quarantined' });
    const quarantineVersion = target.instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_operational_blockers WHERE id = ?', [
      quarantine.blockerId,
    ])!.row_version;
    const restored = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:restore-integrity',
          command_type: 'restore_integrity',
          target: { operational_blocker_id: quarantine.blockerId },
          idempotency_key: 'restore-integrity',
          expected_row_version: quarantineVersion,
          reason_code: 'hash_revalidated',
          evidence_refs: ['trusted-backup', 'full-chain'],
        },
        404,
        {
          verification: {
            kind: 'integrity_restored',
            expectedHash: target.seed.values.context!.hash,
            restoredHash: target.seed.values.context!.hash,
            fullChainVerified: true,
          },
        },
      ),
    );
    expect(restored.executionResult).toBe('applied');
    expect(
      target.instance.store.queryOne(
        'SELECT operational_state FROM workflows WHERE id = ?',
        [target.workflowId],
      ),
    ).toMatchObject({ operational_state: 'healthy' });
  });

  it('rejects integrity restoration spliced onto a non-detection event with the same evidence hash', () => {
    const target = fixture('integrity-source-splice');
    const unrelatedEvent = target.instance.store.queryOne<{
      seq: number;
    }>(
      `SELECT seq FROM workflow_graph_events
        WHERE graph_run_id = ? AND event_type <> 'orchestration_error'
        ORDER BY seq LIMIT 1`,
      [target.graphRunId],
    )!.seq;
    const blocker = openOperationalBlocker(target.instance.store, {
      workflowId: target.workflowId,
      graphRunId: target.graphRunId,
      blockerKind: 'integrity_quarantine',
      severity: 'quarantine',
      source: { kind: 'event', sequence: unrelatedEvent },
      errorCode: 'integrity_hash_mismatch',
      evidenceManifest: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 405,
    });
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          {
            command_id: 'g7:integrity-source-splice',
            command_type: 'restore_integrity',
            target: { operational_blocker_id: blocker.blockerId },
            idempotency_key: 'integrity-source-splice',
            expected_row_version: 1,
            reason_code: 'hash_revalidated',
            evidence_refs: ['trusted-backup', 'full-chain'],
          },
          406,
          {
            verification: {
              kind: 'integrity_restored',
              expectedHash: target.seed.values.context!.hash,
              restoredHash: target.seed.values.context!.hash,
              fullChainVerified: true,
            },
          },
        ),
      ),
    ).toThrow(/verification did not close integrity_quarantine/);
    expect(
      target.instance.store.queryOne(
        `SELECT status, remediation_attempt_count, row_version
           FROM workflow_operational_blockers WHERE id = ?`,
        [blocker.blockerId],
      ),
    ).toMatchObject({
      status: 'open',
      remediation_attempt_count: 0,
      row_version: 1,
    });
  });

  it('binds root remediation to its frozen Schedule and rolls T6e back when T8 fails', () => {
    const target = fixture('root-t8-rollback');
    const prepared = prepareReadyRootSchedules(target, 2);
    const [sourceScheduleId, otherScheduleId] = prepared.scheduleIds;
    const blocker = openOperationalBlocker(target.instance.store, {
      workflowId: target.workflowId,
      graphRunId: target.graphRunId,
      blockerKind: 'root_finalization_exhausted',
      severity: 'action_required',
      source: { kind: 'root_finalization', id: sourceScheduleId! },
      errorCode: 'root_finalization_exhausted',
      evidenceManifest: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 921,
    });
    const command = (
      key: string,
      scheduleId: string,
    ): WorkflowRuntimeCommandDocument => ({
      command_id: `g7:${key}`,
      command_type: 'remediate_operational_blocker',
      target: { operational_blocker_id: blocker.blockerId },
      idempotency_key: key,
      expected_row_version: 1,
      reason_code: 'dependency_recovered',
      evidence_refs: [`schedule:${scheduleId}`],
    });
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          command('root-unbound-schedule', otherScheduleId!),
          922,
          {
            verification: {
              kind: 'root_finalization_ready',
              scheduleId: otherScheduleId!,
              rootCommit: prepared.rootCommit,
            },
          },
        ),
      ),
    ).toThrow(/verification did not close root_finalization_exhausted/);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_commands WHERE command_id = ?',
        ['g7:root-unbound-schedule'],
      )!.count,
    ).toBe(0);

    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command('root-t8-stale', sourceScheduleId!), 923, {
          verification: {
            kind: 'root_finalization_ready',
            scheduleId: sourceScheduleId!,
            rootCommit: prepared.rootCommit,
          },
        }),
      ),
    ).toThrow(/stale|CAS|authority|precondition/i);
    expect(
      target.instance.store.queryOne(
        `SELECT status, remediation_attempt_count, resolution_command_id,
                row_version FROM workflow_operational_blockers WHERE id = ?`,
        [blocker.blockerId],
      ),
    ).toMatchObject({
      status: 'open',
      remediation_attempt_count: 0,
      resolution_command_id: null,
      row_version: 1,
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_operational_blocker_remediation_attempts WHERE blocker_id = ?',
        [blocker.blockerId],
      )!.count,
    ).toBe(0);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_commands WHERE command_id = ?',
        ['g7:root-t8-stale'],
      )!.count,
    ).toBe(0);
    expect(
      target.instance.store.queryAll(
        `SELECT id, status, row_version FROM workflow_root_finalization_schedules
          WHERE id IN (?, ?) ORDER BY id COLLATE BINARY`,
        [sourceScheduleId!, otherScheduleId!],
      ),
    ).toEqual(
      expect.arrayContaining([
        { id: sourceScheduleId, status: 'ready', row_version: 2 },
        { id: otherScheduleId, status: 'ready', row_version: 2 },
      ]),
    );
  });

  it('quarantines cache corruption and rolls recovery back at the fault boundary', () => {
    const target = fixture('recovery-tamper');
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_runs SET operational_state = 'action_required' WHERE id = ?",
        [target.graphRunId],
      );
    });
    const version = runVersion(target);
    expect(() =>
      coordinateGraphRecoveryG7(
        target.instance.store,
        {
          graphRunId: target.graphRunId,
          expectedRunRowVersion: version,
          integrityEvidence: target.seed.values.context!,
          remediationPolicy: target.remediationPolicy,
          remediationDeadlineAtMs: 10_000,
          nowMs: 500,
        },
        { point: 'before_commit' },
      ),
    ).toThrow(/fault/i);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_operational_blockers WHERE graph_run_id = ? AND blocker_kind = 'integrity_quarantine'",
        [target.graphRunId],
      )!.count,
    ).toBe(0);
    const receipt = coordinateGraphRecoveryG7(target.instance.store, {
      graphRunId: target.graphRunId,
      expectedRunRowVersion: version,
      integrityEvidence: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      remediationDeadlineAtMs: 10_000,
      nowMs: 501,
    });
    expect(receipt).toMatchObject({
      disposition: 'quarantined',
      finding: 'operational_blocker_cache_mismatch',
    });
    const source = target.instance.store.queryOne<{
      source_event_seq: number;
      evidence_manifest_value_id: string;
      evidence_manifest_hash: Sha256Hash;
    }>(
      `SELECT source_event_seq, evidence_manifest_value_id,
              evidence_manifest_hash
         FROM workflow_operational_blockers WHERE id = ?`,
      [receipt.blockerId!],
    )!;
    expect(source).toMatchObject({
      evidence_manifest_value_id: target.seed.values.context!.id,
      evidence_manifest_hash: target.seed.values.context!.hash,
    });
    expect(
      target.instance.store.queryOne(
        `SELECT event_type, payload_json, payload_value_id, payload_hash
           FROM workflow_graph_events WHERE graph_run_id = ? AND seq = ?`,
        [target.graphRunId, source.source_event_seq],
      ),
    ).toEqual({
      event_type: 'orchestration_error',
      payload_json: null,
      payload_value_id: target.seed.values.context!.id,
      payload_hash: target.seed.values.context!.hash,
    });

    const restore: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:recovery-integrity-restore',
      command_type: 'restore_integrity',
      target: { operational_blocker_id: receipt.blockerId! },
      idempotency_key: 'recovery-integrity-restore',
      expected_row_version: 1,
      reason_code: 'hash_revalidated',
      evidence_refs: ['trusted-backup', 'full-chain'],
    };
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, restore, 502, {
          verification: {
            kind: 'integrity_restored',
            expectedHash: target.seed.values.context!.hash,
            restoredHash: target.seed.values.context!.hash,
            fullChainVerified: true,
          },
        }),
        { point: 'before_commit' },
      ),
    ).toThrow(/fault/i);
    expectCommandAuditAbsent(target, restore.command_id);
    expect(
      target.instance.store.queryOne(
        'SELECT status, row_version FROM workflow_operational_blockers WHERE id = ?',
        [receipt.blockerId!],
      ),
    ).toMatchObject({ status: 'open', row_version: 1 });

    target.instance.closeStore();
    target.instance.reopenStore();
    expect(
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, restore, 503, {
          verification: {
            kind: 'integrity_restored',
            expectedHash: target.seed.values.context!.hash,
            restoredHash: target.seed.values.context!.hash,
            fullChainVerified: true,
          },
        }),
      ).executionResult,
    ).toBe('applied');
    expect(
      target.instance.store.queryOne(
        'SELECT status FROM workflow_operational_blockers WHERE id = ?',
        [receipt.blockerId!],
      ),
    ).toMatchObject({ status: 'resolved' });
    expect(
      target.instance.store.queryOne(
        'SELECT operational_state FROM workflow_graph_runs WHERE id = ?',
        [target.graphRunId],
      ),
    ).toMatchObject({ operational_state: 'healthy' });
  });

  it('rejects Recovery integrity evidence spliced to its decision event', () => {
    const target = fixture('recovery-source-splice');
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_runs SET operational_state = 'action_required' WHERE id = ?",
        [target.graphRunId],
      );
    });
    const recovery = coordinateGraphRecoveryG7(target.instance.store, {
      graphRunId: target.graphRunId,
      expectedRunRowVersion: runVersion(target),
      integrityEvidence: target.seed.values.context!,
      remediationPolicy: target.remediationPolicy,
      remediationDeadlineAtMs: 10_000,
      nowMs: 510,
    });
    const decision = target.instance.store.queryOne<{ seq: number }>(
      `SELECT seq FROM workflow_graph_events
        WHERE graph_run_id = ? AND event_type = 'recovery_decision_recorded'
          AND json_extract(payload_json, '$.blocker_id') = ?`,
      [target.graphRunId, recovery.blockerId!],
    )!.seq;
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_operational_blockers SET source_event_seq = ? WHERE id = ?',
        [decision, recovery.blockerId!],
      );
    });
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(
          target,
          {
            command_id: 'g7:recovery-source-splice',
            command_type: 'restore_integrity',
            target: { operational_blocker_id: recovery.blockerId! },
            idempotency_key: 'recovery-source-splice',
            expected_row_version: 1,
            reason_code: 'hash_revalidated',
            evidence_refs: ['trusted-backup', 'full-chain'],
          },
          511,
          {
            verification: {
              kind: 'integrity_restored',
              expectedHash: target.seed.values.context!.hash,
              restoredHash: target.seed.values.context!.hash,
              fullChainVerified: true,
            },
          },
        ),
      ),
    ).toThrow(/verification did not close integrity_quarantine/);
    expect(
      target.instance.store.queryOne(
        'SELECT status, row_version FROM workflow_operational_blockers WHERE id = ?',
        [recovery.blockerId!],
      ),
    ).toMatchObject({ status: 'open', row_version: 1 });
  });

  it('rolls command authority and audit back together at every gateway fault boundary', () => {
    const controlTarget = fixture('rollback-control');
    const controlVersion = runVersion(controlTarget);
    expect(() =>
      submitRuntimeCommand(
        controlTarget.instance.store,
        commandInput(
          controlTarget,
          {
            command_id: 'g7:rollback-control',
            command_type: 'pause_run',
            target: { run_id: controlTarget.graphRunId },
            idempotency_key: 'rollback-control',
            expected_row_version: controlVersion,
            reason_code: 'operator_requested',
            evidence_refs: [],
          },
          550,
        ),
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      controlTarget.instance.store.queryOne(
        'SELECT control, row_version FROM workflow_graph_runs WHERE id = ?',
        [controlTarget.graphRunId],
      ),
    ).toMatchObject({ control: 'running', row_version: controlVersion });
    expectCommandAuditAbsent(controlTarget, 'g7:rollback-control');

    const cancelTarget = fixture('rollback-t7c');
    expect(() =>
      submitRuntimeCommand(
        cancelTarget.instance.store,
        commandInput(
          cancelTarget,
          {
            command_id: 'g7:rollback-t7c',
            command_type: 'cancel_workflow',
            target: { workflow_id: cancelTarget.workflowId },
            idempotency_key: 'rollback-t7c',
            expected_row_version: workflowVersion(cancelTarget),
            reason_code: 'operator_requested',
            evidence_refs: [],
          },
          551,
        ),
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      cancelTarget.instance.store.queryOne(
        'SELECT lifecycle, control, root_close_request_id FROM workflow_graph_runs WHERE id = ?',
        [cancelTarget.graphRunId],
      ),
    ).toMatchObject({
      lifecycle: 'executing',
      control: 'running',
      root_close_request_id: null,
    });
    expect(
      cancelTarget.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [cancelTarget.graphRunId],
      )!.count,
    ).toBe(0);
    expectCommandAuditAbsent(cancelTarget, 'g7:rollback-t7c');

    const retryTarget = fixture('rollback-t6d');
    const prepared = prepareManualRetry(retryTarget);
    expect(() =>
      submitRuntimeCommand(
        retryTarget.instance.store,
        commandInput(
          retryTarget,
          {
            command_id: 'g7:rollback-t6d',
            command_type: 'advance_retry_schedule',
            target: { retry_schedule_id: prepared.scheduleId },
            idempotency_key: 'rollback-t6d',
            expected_row_version: 1,
            reason_code: 'operator_requested',
            evidence_refs: [],
          },
          552,
        ),
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      retryTarget.instance.store.queryOne(
        'SELECT status, row_version FROM workflow_graph_retry_schedules WHERE id = ?',
        [prepared.scheduleId],
      ),
    ).toMatchObject({ status: 'scheduled', row_version: 1 });
    expect(
      retryTarget.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_node_attempts WHERE parent_attempt_id = ?',
        [prepared.sourceAttemptId],
      )!.count,
    ).toBe(0);
    expectCommandAuditAbsent(retryTarget, 'g7:rollback-t6d');

    const remediationTarget = fixture('rollback-t6e');
    const effect = seedTerminalAttemptAndEffect(
      remediationTarget,
      'rollback-t6e',
    );
    const blocker = openOperationalBlocker(remediationTarget.instance.store, {
      workflowId: remediationTarget.workflowId,
      graphRunId: remediationTarget.graphRunId,
      blockerKind: 'effect_unknown',
      severity: 'action_required',
      source: { kind: 'effect', id: effect.effectId },
      errorCode: 'effect_outcome_unknown',
      evidenceManifest: remediationTarget.seed.values.context!,
      remediationPolicy: remediationTarget.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 10_000,
      nowMs: 553,
    });
    expect(() =>
      submitRuntimeCommand(
        remediationTarget.instance.store,
        commandInput(
          remediationTarget,
          {
            command_id: 'g7:rollback-t6e',
            command_type: 'verify_effect_not_applied',
            target: { effect_operation_id: effect.effectId },
            idempotency_key: 'rollback-t6e',
            expected_row_version: 1,
            reason_code: 'not_applied_verified',
            evidence_refs: ['provider-proof'],
          },
          554,
          {
            verification: {
              kind: 'effect_not_applied',
              operationKey: effect.operationKey,
            },
          },
        ),
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      remediationTarget.instance.store.queryOne(
        'SELECT status, row_version FROM workflow_graph_effect_operations WHERE id = ?',
        [effect.effectId],
      ),
    ).toMatchObject({ status: 'action_required', row_version: 1 });
    expect(
      remediationTarget.instance.store.queryOne(
        'SELECT status, remediation_attempt_count, row_version FROM workflow_operational_blockers WHERE id = ?',
        [blocker.blockerId],
      ),
    ).toMatchObject({
      status: 'open',
      remediation_attempt_count: 0,
      row_version: 1,
    });
    expectCommandAuditAbsent(remediationTarget, 'g7:rollback-t6e');

    const abandonTarget = fixture('rollback-abandon');
    const abandonVersion = workflowVersion(abandonTarget);
    const request = submitRuntimeCommand(
      abandonTarget.instance.store,
      commandInput(
        abandonTarget,
        {
          command_id: 'g7:rollback-abandon-request',
          command_type: 'request_administrative_abandon',
          target: { workflow_id: abandonTarget.workflowId },
          idempotency_key: 'rollback-abandon-request',
          expected_row_version: abandonVersion,
          reason_code: 'unrecoverable_state',
          evidence_refs: ['incident:rollback'],
        },
        555,
      ),
    );
    expect(() =>
      submitRuntimeCommand(
        abandonTarget.instance.store,
        commandInput(
          abandonTarget,
          {
            command_id: 'g7:rollback-abandon-confirm',
            command_type: 'confirm_administrative_abandon',
            target: { workflow_id: abandonTarget.workflowId },
            confirmation_ref: String(request.canonicalResult.confirmation_ref),
            idempotency_key: 'rollback-abandon-confirm',
            expected_row_version: abandonVersion,
            reason_code: 'unrecoverable_state',
            evidence_refs: ['incident:rollback'],
          },
          556,
        ),
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      abandonTarget.instance.store.queryOne(
        'SELECT status, operational_state FROM workflows WHERE id = ?',
        [abandonTarget.workflowId],
      ),
    ).toMatchObject({ status: 'active', operational_state: 'healthy' });
    expect(
      abandonTarget.instance.store.queryOne(
        'SELECT status, consumed_at_ms FROM workflow_runtime_command_confirmations WHERE id = ?',
        [String(request.canonicalResult.confirmation_ref)],
      ),
    ).toMatchObject({ status: 'pending', consumed_at_ms: null });
    expectCommandAuditAbsent(abandonTarget, 'g7:rollback-abandon-confirm');
  });

  it('requires and consumes the same-session administrative abandon confirmation', () => {
    const target = fixture('abandon');
    const expected = workflowVersion(target);
    const request = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-request',
          command_type: 'request_administrative_abandon',
          target: { workflow_id: target.workflowId },
          idempotency_key: 'abandon-request',
          expected_row_version: expected,
          reason_code: 'unrecoverable_state',
          reason_text: 'Original irreversible abandon intent',
          evidence_refs: ['incident:1', 'operator-approval'],
        },
        600,
      ),
    );
    const confirmation = String(request.canonicalResult.confirmation_ref);
    const wrongSession = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-wrong-session',
          command_type: 'confirm_administrative_abandon',
          target: { workflow_id: target.workflowId },
          confirmation_ref: confirmation,
          idempotency_key: 'abandon-wrong-session',
          expected_row_version: expected,
          reason_code: 'unrecoverable_state',
          evidence_refs: ['incident:1', 'operator-approval'],
        },
        601,
        { actor: { ...target.actor, authSessionRef: 'session:other' } },
      ),
    );
    expect(wrongSession.denialCode).toBe('confirmation_required');
    const replacedIntent = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-replaced-intent',
          command_type: 'confirm_administrative_abandon',
          target: { workflow_id: target.workflowId },
          confirmation_ref: confirmation,
          idempotency_key: 'abandon-replaced-intent',
          expected_row_version: expected,
          reason_code: 'unrecoverable_state',
          reason_text: 'Replacement intent must not be accepted',
          evidence_refs: ['incident:1', 'operator-approval'],
        },
        601,
      ),
    );
    expect(replacedIntent.denialCode).toBe('confirmation_required');
    const changedReason = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-changed-reason',
          command_type: 'confirm_administrative_abandon',
          target: { workflow_id: target.workflowId },
          confirmation_ref: confirmation,
          idempotency_key: 'abandon-changed-reason',
          expected_row_version: expected,
          reason_code: 'data_loss_accepted',
          reason_text: 'Original irreversible abandon intent',
          evidence_refs: ['incident:1', 'operator-approval'],
        },
        601,
      ),
    );
    expect(changedReason.denialCode).toBe('confirmation_required');
    const changedEvidence = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-changed-evidence',
          command_type: 'confirm_administrative_abandon',
          target: { workflow_id: target.workflowId },
          confirmation_ref: confirmation,
          idempotency_key: 'abandon-changed-evidence',
          expected_row_version: expected,
          reason_code: 'unrecoverable_state',
          reason_text: 'Original irreversible abandon intent',
          evidence_refs: ['incident:2', 'operator-approval'],
        },
        601,
      ),
    );
    expect(changedEvidence.denialCode).toBe('confirmation_required');
    const confirm: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:abandon-confirm',
      command_type: 'confirm_administrative_abandon',
      target: { workflow_id: target.workflowId },
      confirmation_ref: confirmation,
      idempotency_key: 'abandon-confirm',
      expected_row_version: expected,
      reason_code: 'unrecoverable_state',
      reason_text: 'Original irreversible abandon intent',
      evidence_refs: ['incident:1', 'operator-approval'],
    };
    const applied = submitRuntimeCommand(
      target.instance.store,
      commandInput(target, confirm, 602),
    );
    expect(applied).toMatchObject({ executionResult: 'applied' });
    expect(
      target.instance.store.queryOne(
        'SELECT status, operational_state FROM workflows WHERE id = ?',
        [target.workflowId],
      ),
    ).toMatchObject({
      status: 'administratively_abandoned',
      operational_state: 'administratively_abandoned',
    });
    expect(
      target.instance.store.queryOne(
        `SELECT status, consumed_at_ms, row_version
           FROM workflow_runtime_command_confirmations WHERE id = ?`,
        [confirmation],
      ),
    ).toMatchObject({
      status: 'consumed',
      consumed_at_ms: 602,
      row_version: 2,
    });
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_completion_cuts WHERE graph_run_id = ?',
        [target.graphRunId],
      )!.count,
    ).toBe(0);
    const duplicate = submitRuntimeCommand(
      target.instance.store,
      commandInput(target, confirm, 603),
    );
    expect(duplicate.executionResult).toBe('duplicate');
    expect(
      target.instance.store.queryOne(
        `SELECT status, consumed_at_ms, row_version
           FROM workflow_runtime_command_confirmations WHERE id = ?`,
        [confirmation],
      ),
    ).toMatchObject({
      status: 'consumed',
      consumed_at_ms: 602,
      row_version: 2,
    });
  });

  it('expires administrative abandon confirmation without changing workflow authority', () => {
    const target = fixture('abandon-expired');
    const expected = workflowVersion(target);
    const request = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-expired-request',
          command_type: 'request_administrative_abandon',
          target: { workflow_id: target.workflowId },
          idempotency_key: 'abandon-expired-request',
          expected_row_version: expected,
          reason_code: 'data_loss_accepted',
          evidence_refs: ['incident:expired'],
        },
        900,
      ),
    );
    const confirmation = String(request.canonicalResult.confirmation_ref);
    const expired = submitRuntimeCommand(
      target.instance.store,
      commandInput(
        target,
        {
          command_id: 'g7:abandon-expired-confirm',
          command_type: 'confirm_administrative_abandon',
          target: { workflow_id: target.workflowId },
          confirmation_ref: confirmation,
          idempotency_key: 'abandon-expired-confirm',
          expected_row_version: expected,
          reason_code: 'data_loss_accepted',
          evidence_refs: ['incident:expired'],
        },
        300_900,
      ),
    );
    expect(expired).toMatchObject({
      executionResult: 'denied',
      denialCode: 'confirmation_required',
    });
    expect(
      target.instance.store.queryOne(
        'SELECT status FROM workflow_runtime_command_confirmations WHERE id = ?',
        [confirmation],
      ),
    ).toMatchObject({ status: 'expired' });
    expect(
      target.instance.store.queryOne(
        'SELECT status, operational_state FROM workflows WHERE id = ?',
        [target.workflowId],
      ),
    ).toMatchObject({ status: 'active', operational_state: 'healthy' });
  });

  it('fails closed on canonical command-result tamper after reopen', () => {
    const target = fixture('command-tamper');
    const command: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:tamper-pause',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'tamper-pause',
      expected_row_version: runVersion(target),
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    expect(
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 950),
      ).executionResult,
    ).toBe('applied');
    const result = target.instance.store.queryOne<{
      id: string;
      inline_canonical_json: string;
    }>(
      `SELECT v.id, v.inline_canonical_json
         FROM workflow_runtime_commands c
         JOIN workflow_values v ON v.id = c.canonical_result_value_id
        WHERE c.command_id = ?`,
      [command.command_id],
    )!;
    const tampered = canonicalJson({
      ...(JSON.parse(result.inline_canonical_json) as JsonObject),
      control: 'running',
    });
    target.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_values SET inline_canonical_json = ?, byte_length = ?
          WHERE id = ?`,
        [tampered, Buffer.byteLength(tampered), result.id],
      );
    });
    target.instance.closeStore();
    target.instance.reopenStore();
    const invocationCount = target.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_runtime_command_invocations WHERE command_id = ?',
      [command.command_id],
    )!.count;
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 951),
      ),
    ).toThrow(/command-result Value hash authority drifted/);
    expect(
      target.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_runtime_command_invocations WHERE command_id = ?',
        [command.command_id],
      )!.count,
    ).toBe(invocationCount);
  });

  it('fails closed on authenticated ingress request tamper after reopen', () => {
    const target = fixture('ingress-tamper');
    const command: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:tamper-ingress-pause',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'tamper-ingress-pause',
      expected_row_version: runVersion(target),
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    expect(
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 960),
      ).executionResult,
    ).toBe('applied');
    target.instance.closeStore();
    const database = new Database(target.instance.databasePath);
    try {
      const trigger = database
        .prepare(
          `SELECT sql FROM sqlite_schema
            WHERE type='trigger' AND name='trg:command_ingress:terminal_transition'`,
        )
        .pluck()
        .get() as string;
      database.exec('DROP TRIGGER "trg:command_ingress:terminal_transition"');
      database
        .prepare(
          `UPDATE workflow_runtime_command_ingress_invocations
              SET canonical_request_json='{}'
            WHERE submitted_command_id=?`,
        )
        .run(command.command_id);
      database.exec(trigger);
    } finally {
      database.close();
    }
    expect(() => target.instance.reopenStore()).toThrow(
      /ingress trusted terminal authority is invalid/i,
    );
  });

  it.each([
    ['actor identity', 'actor_ref = ?', ['human:forged']],
    ['authentication session', 'auth_session_ref = ?', ['session:forged']],
    ['entrypoint', 'entrypoint = ?', ['deadline_watchdog']],
    ['source feature', 'source_feature_id = ?', ['feature:forged']],
    ['delegation chain', 'delegation_chain_ref = ?', ['delegation:forged']],
    [
      'terminal disposition',
      `authorization_result = 'not_evaluated',
       execution_result = 'duplicate', applied_at_ms = NULL`,
      [],
    ],
    ['chronology', 'requested_at_ms = requested_at_ms - 1', []],
  ] as const)(
    'rejects schema-valid ingress %s tamper during Store startup',
    (_label, assignmentSql, parameters) => {
      const target = fixture(`ingress-${String(_label).replaceAll(' ', '-')}`);
      const command: WorkflowRuntimeCommandDocument = {
        command_id: `g7:ingress:${String(_label).replaceAll(' ', '-')}`,
        command_type: 'pause_run',
        target: { run_id: target.graphRunId },
        idempotency_key: `ingress:${String(_label).replaceAll(' ', '-')}`,
        expected_row_version: runVersion(target),
        reason_code: 'operator_requested',
        evidence_refs: [],
      };
      expect(
        submitRuntimeCommand(
          target.instance.store,
          commandInput(target, command, 1_000),
        ).executionResult,
      ).toBe('applied');
      target.instance.closeStore();
      tamperTerminalIngress(
        target.instance.databasePath,
        command.command_id,
        assignmentSql,
        parameters,
      );
      expect(() => target.instance.reopenStore()).toThrow(
        /ingress trusted terminal authority is invalid/i,
      );
    },
  );

  it('rejects a schema-valid resolved Invocation identity splice on reopen', () => {
    const target = fixture('ingress-resolved-identity');
    const command: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:ingress:resolved-identity',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'ingress:resolved-identity',
      expected_row_version: runVersion(target),
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    expect(
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 1_100),
      ).executionResult,
    ).toBe('applied');
    target.instance.closeStore();
    const database = new Database(target.instance.databasePath);
    try {
      database.pragma('foreign_keys = ON');
      database
        .prepare(
          `INSERT INTO workflow_runtime_command_invocations (
             id, command_id, invocation_no, submitted_request_hash, actor_ref,
             actor_kind, auth_session_ref, entrypoint, source_feature_id,
             delegation_chain_ref, required_permission,
             command_policy_resource_id, command_policy_resource_hash,
             authorization_result, execution_result, target_before_hash,
             target_after_hash, resulting_event_seq, close_request_id,
             effect_operation_id, requested_at_ms, decided_at_ms, applied_at_ms
           )
           SELECT 'command-invocation:integrity-splice', command_id,
                  invocation_no + 1, submitted_request_hash, actor_ref,
                  actor_kind, auth_session_ref, entrypoint, source_feature_id,
                  delegation_chain_ref, required_permission,
                  command_policy_resource_id, command_policy_resource_hash,
                  authorization_result, execution_result, target_before_hash,
                  target_after_hash, resulting_event_seq, close_request_id,
                  effect_operation_id, requested_at_ms, decided_at_ms,
                  applied_at_ms
             FROM workflow_runtime_command_invocations
            WHERE command_id = ? AND invocation_no = 1`,
        )
        .run(command.command_id);
    } finally {
      database.close();
    }
    tamperTerminalIngress(
      target.instance.databasePath,
      command.command_id,
      'resolved_invocation_id = ?',
      ['command-invocation:integrity-splice'],
    );
    expect(() => target.instance.reopenStore()).toThrow(
      /ingress trusted terminal authority is invalid/i,
    );
  });

  it('rejects trusted ingress identity drift before exact replay append', () => {
    const target = fixture('ingress-replay-verifier');
    const command: WorkflowRuntimeCommandDocument = {
      command_id: 'g7:ingress:replay-verifier',
      command_type: 'pause_run',
      target: { run_id: target.graphRunId },
      idempotency_key: 'ingress:replay-verifier',
      expected_row_version: runVersion(target),
      reason_code: 'operator_requested',
      evidence_refs: [],
    };
    expect(
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 1_200),
      ).executionResult,
    ).toBe('applied');
    const before = target.instance.store.queryOne<{
      ingress_count: number;
      invocation_count: number;
    }>(
      `SELECT
         (SELECT count(*) FROM workflow_runtime_command_ingress_invocations
           WHERE idempotency_key = ?) AS ingress_count,
         (SELECT count(*) FROM workflow_runtime_command_invocations
           WHERE command_id = ?) AS invocation_count`,
      [command.idempotency_key, command.command_id],
    )!;
    tamperTerminalIngress(
      target.instance.databasePath,
      command.command_id,
      'actor_ref = ?',
      ['human:replay-forged'],
    );
    expect(() =>
      submitRuntimeCommand(
        target.instance.store,
        commandInput(target, command, 1_201),
      ),
    ).toThrow(/trusted terminal binding drifted/i);
    expect(
      target.instance.store.queryOne<{
        ingress_count: number;
        invocation_count: number;
      }>(
        `SELECT
           (SELECT count(*) FROM workflow_runtime_command_ingress_invocations
             WHERE idempotency_key = ?) AS ingress_count,
           (SELECT count(*) FROM workflow_runtime_command_invocations
             WHERE command_id = ?) AS invocation_count`,
        [command.idempotency_key, command.command_id],
      ),
    ).toEqual(before);
  });
});
