import { canonicalJson } from '../contracts/hash.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { handoffRequiredChildDomainClaim } from '../creation/domain-claims.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  assertNoDeferredForeignKeyViolations,
  insertGraphEvent,
  insertInlineValue,
  loadInlineValue,
  requireSingleChange,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import {
  activateWorkflowT1InTransaction,
  type T1ActivationInput,
  type T1ActivationReceipt,
} from './lifecycle.js';
import { chargeWorkflowLifetimeResources } from './ledger.js';

interface RootFinalizationScheduleRow extends Record<string, unknown> {
  id: string;
  workflow_id: string;
  source_state_instance_id: string;
  source_run_id: string;
  root_scope_id: string;
  close_request_id: string;
  transition_effect_id: string;
  transition_intake_id: string;
  creation_request_id: string;
  recipe_resource_id: string;
  recipe_resource_hash: Sha256Hash;
  routing_scope_resource_id: string;
  routing_scope_resource_hash: Sha256Hash;
  principal_ref: string;
  principal_hash: Sha256Hash;
  input_snapshot_value_id: string;
  input_snapshot_hash: Sha256Hash;
  creation_domain: string;
  creation_key: string;
  creation_intent_hash: Sha256Hash;
  finalization_policy_resource_id: string;
  finalization_policy_resource_hash: Sha256Hash;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_eligible_at_ms: number | null;
  deadline_at_ms: number;
  child_workflow_id: string | null;
  row_version: number;
}

export interface RootFinalizationAttemptInput {
  readonly scheduleId: string;
  readonly expectedScheduleRowVersion: number;
  readonly frozenResolution: RuntimeValueRef;
  readonly claimPreflight: RuntimeValueRef;
  readonly result: 'ready' | 'retryable_conflict' | 'permanent_rejection';
  readonly errorCode?: string;
  readonly errorDetail?: RuntimeValueRef;
  readonly nextEligibleAtMs?: number;
  readonly exhaustionEvidence: RuntimeValueRef;
  readonly remediationPolicy: RuntimeRegistryRef;
  readonly remediationDeadlineAtMs: number;
  readonly nowMs: number;
}

export interface RootFinalizationAttemptReceipt {
  readonly disposition: 'recorded' | 'exact_replay';
  readonly scheduleId: string;
  readonly attemptNo: number;
  readonly status: 'ready' | 'retry_wait' | 'exhausted';
  readonly blockerId: string | null;
}

function loadSchedule(
  transaction: WorkflowRuntimeWriteTransaction,
  scheduleId: string,
): RootFinalizationScheduleRow | undefined {
  return transaction.queryOne<RootFinalizationScheduleRow>(
    `SELECT id, workflow_id, source_state_instance_id, source_run_id,
            root_scope_id, close_request_id, transition_effect_id,
            transition_intake_id, creation_request_id, recipe_resource_id,
            recipe_resource_hash, routing_scope_resource_id,
            routing_scope_resource_hash, principal_ref, principal_hash,
            input_snapshot_value_id, input_snapshot_hash, creation_domain,
            creation_key, creation_intent_hash,
            finalization_policy_resource_id,
            finalization_policy_resource_hash, status, attempt_count,
            max_attempts, next_eligible_at_ms, deadline_at_ms,
            child_workflow_id, row_version
       FROM workflow_root_finalization_schedules WHERE id = ?`,
    [scheduleId],
  );
}

function assertStoredValue(
  transaction: WorkflowRuntimeWriteTransaction,
  value: RuntimeValueRef,
  label: string,
): void {
  loadInlineValue(transaction, value.id, value.hash, label);
}

function appendRootFinalizationEvent(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scheduleId: string;
    status: string;
    nowMs: number;
    suffix: string;
  },
): number {
  const run = transaction.queryOne<{
    next_event_seq: number;
    row_version: number;
  }>(
    'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  );
  if (!run)
    throw new G5RuntimeError(
      'precondition_failed',
      'Root Finalization Run is missing',
    );
  const sequence = run.next_event_seq + 1;
  insertGraphEvent(transaction, {
    graphRunId: input.graphRunId,
    sequence,
    scopeId: null,
    nodeId: null,
    attemptId: null,
    eventType: 'root_finalization_changed',
    idempotencyKey: `root-finalization:${input.scheduleId}:${input.suffix}`,
    payloadJson: {
      schedule_id: input.scheduleId,
      status: input.status,
    },
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET next_event_seq = ?, row_version = row_version + 1,
              updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND next_event_seq = ?`,
      [
        sequence,
        input.nowMs,
        input.graphRunId,
        run.row_version,
        run.next_event_seq,
      ],
    ).changes,
    'Root Finalization event head',
  );
  return sequence;
}

function openExhaustionBlocker(
  transaction: WorkflowRuntimeWriteTransaction,
  input: RootFinalizationAttemptInput,
  schedule: RootFinalizationScheduleRow,
): string {
  assertExactPublishedRegistryResource(
    transaction,
    input.remediationPolicy,
    'Root Finalization remediation policy',
  );
  assertStoredValue(
    transaction,
    input.exhaustionEvidence,
    'Root Finalization exhaustion evidence',
  );
  if (
    !Number.isSafeInteger(input.remediationDeadlineAtMs) ||
    input.remediationDeadlineAtMs < input.nowMs
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Root Finalization exhaustion requires a finite remediation deadline',
    );
  const blockerId = stableRuntimeId('blocker', {
    graph_run_id: schedule.source_run_id,
    blocker_kind: 'root_finalization_exhausted',
    source_kind: 'root_finalization',
    source_identity: schedule.id,
  });
  const existing = transaction.queryOne<{
    id: string;
    status: string;
    source_root_finalization_schedule_id: string | null;
  }>(
    `SELECT id, status, source_root_finalization_schedule_id
       FROM workflow_operational_blockers WHERE id = ?`,
    [blockerId],
  );
  if (existing) {
    if (
      existing.status !== 'open' ||
      existing.source_root_finalization_schedule_id !== schedule.id
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Root Finalization exhaustion blocker drifted',
      );
    return blockerId;
  }
  const sequence = appendRootFinalizationEvent(transaction, {
    graphRunId: schedule.source_run_id,
    scheduleId: schedule.id,
    status: 'exhausted',
    nowMs: input.nowMs,
    suffix: 'blocker-open',
  });
  transaction.execute(
    `INSERT INTO workflow_operational_blockers (
       id, workflow_id, graph_run_id, blocker_kind, severity,
       source_effect_operation_id, source_outbox_id,
       source_root_finalization_schedule_id, source_claim_id, source_event_seq,
       error_code, evidence_manifest_value_id, evidence_manifest_hash, status,
       remediation_policy_resource_id, remediation_policy_resource_hash,
       remediation_attempt_count, next_remediation_at_ms,
       remediation_deadline_at_ms, opened_event_seq, resolved_event_seq,
       resolution_command_id, resolution_value_id, resolution_hash, row_version,
       opened_at_ms, resolved_at_ms, abandoned_at_ms
     ) VALUES (?, ?, ?, 'root_finalization_exhausted', 'action_required',
       NULL, NULL, ?, NULL, NULL, ?, ?, ?, 'open', ?, ?, 0, NULL, ?, ?, NULL,
       NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    [
      blockerId,
      schedule.workflow_id,
      schedule.source_run_id,
      schedule.id,
      input.errorCode ?? 'root_finalization_exhausted',
      input.exhaustionEvidence.id,
      input.exhaustionEvidence.hash,
      input.remediationPolicy.rowId,
      input.remediationPolicy.hash,
      input.remediationDeadlineAtMs,
      sequence,
      input.nowMs,
    ],
  );
  const cache = transaction.queryOne<{
    run_state: string;
    workflow_state: string;
  }>(
    `SELECT r.operational_state AS run_state,
            w.operational_state AS workflow_state
       FROM workflow_graph_runs r JOIN workflows w ON w.id = r.workflow_id
      WHERE r.id = ?`,
    [schedule.source_run_id],
  );
  if (
    cache?.run_state !== 'action_required' ||
    cache.workflow_state !== 'action_required'
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Root Finalization blocker cache did not converge',
    );
  return blockerId;
}

export function recordRootFinalizationAttempt(
  store: WorkflowRuntimeStore,
  input: RootFinalizationAttemptInput,
  fault?: G5TransactionFault,
): RootFinalizationAttemptReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const schedule = loadSchedule(transaction, input.scheduleId);
      if (!schedule)
        throw new G5RuntimeError(
          'precondition_failed',
          'Root Finalization Schedule is missing',
        );
      const replayingRecordedAttempt =
        schedule.row_version === input.expectedScheduleRowVersion + 1 &&
        schedule.attempt_count > 0;
      const attemptNo = replayingRecordedAttempt
        ? schedule.attempt_count
        : schedule.attempt_count + 1;
      const attemptKey = `root-finalization:${schedule.id}:${attemptNo}`;
      const replay = transaction.queryOne<{
        result: string;
        frozen_resolution_value_id: string;
        frozen_resolution_hash: string;
        claim_preflight_value_id: string;
        claim_preflight_hash: string;
      }>(
        `SELECT result, frozen_resolution_value_id, frozen_resolution_hash,
                claim_preflight_value_id, claim_preflight_hash
           FROM workflow_root_finalization_attempts WHERE attempt_key = ?`,
        [attemptKey],
      );
      if (replay) {
        const replayStatus = loadSchedule(transaction, schedule.id)!.status;
        if (
          replay.result !== input.result ||
          replay.frozen_resolution_value_id !== input.frozenResolution.id ||
          replay.frozen_resolution_hash !== input.frozenResolution.hash ||
          replay.claim_preflight_value_id !== input.claimPreflight.id ||
          replay.claim_preflight_hash !== input.claimPreflight.hash ||
          !['ready', 'retry_wait', 'exhausted'].includes(replayStatus)
        )
          throw new G5RuntimeError(
            'idempotency_conflict',
            'Root Finalization attempt replay drifted',
          );
        const replayBlocker =
          replayStatus === 'exhausted'
            ? transaction.queryOne<{ id: string }>(
                `SELECT id FROM workflow_operational_blockers
                  WHERE source_root_finalization_schedule_id = ?
                    AND blocker_kind = 'root_finalization_exhausted'`,
                [schedule.id],
              )
            : undefined;
        return {
          disposition: 'exact_replay',
          scheduleId: schedule.id,
          attemptNo,
          status: replayStatus as 'ready' | 'retry_wait' | 'exhausted',
          blockerId: replayBlocker?.id ?? null,
        };
      }
      if (
        !['pending', 'retry_wait'].includes(schedule.status) ||
        schedule.row_version !== input.expectedScheduleRowVersion ||
        schedule.attempt_count >= schedule.max_attempts ||
        (schedule.next_eligible_at_ms !== null &&
          input.nowMs < schedule.next_eligible_at_ms)
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'Root Finalization Schedule is not eligible for this attempt',
        );
      assertStoredValue(
        transaction,
        input.frozenResolution,
        'Frozen resolution',
      );
      assertStoredValue(transaction, input.claimPreflight, 'Claim preflight');
      if (
        input.result === 'ready' &&
        (input.errorCode !== undefined || input.errorDetail !== undefined)
      )
        throw new G5RuntimeError(
          'contract_invalid',
          'A ready finalization attempt cannot carry an error',
        );
      if (input.errorDetail)
        assertStoredValue(transaction, input.errorDetail, 'Finalization error');
      const exhausted =
        input.result === 'permanent_rejection' ||
        attemptNo >= schedule.max_attempts ||
        input.nowMs >= schedule.deadline_at_ms;
      const status =
        input.result === 'ready'
          ? 'ready'
          : exhausted
            ? 'exhausted'
            : 'retry_wait';
      if (
        status === 'retry_wait' &&
        (!Number.isSafeInteger(input.nextEligibleAtMs) ||
          input.nextEligibleAtMs! <= input.nowMs ||
          input.nextEligibleAtMs! > schedule.deadline_at_ms)
      )
        throw new G5RuntimeError(
          'contract_invalid',
          'Retryable finalization requires a finite eligible time',
        );
      transaction.execute(
        `INSERT INTO workflow_root_finalization_attempts (
           schedule_id, attempt_no, attempt_key, frozen_resolution_value_id,
           frozen_resolution_hash, claim_preflight_value_id,
           claim_preflight_hash, result, error_code, error_detail_value_id,
           error_detail_hash, started_at_ms, finished_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          schedule.id,
          attemptNo,
          attemptKey,
          input.frozenResolution.id,
          input.frozenResolution.hash,
          input.claimPreflight.id,
          input.claimPreflight.hash,
          input.result,
          input.result === 'ready'
            ? null
            : (input.errorCode ?? 'root_finalization_conflict'),
          input.errorDetail?.id ?? null,
          input.errorDetail?.hash ?? null,
          input.nowMs,
          input.nowMs,
        ],
      );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_root_finalization_schedules
              SET status = ?, attempt_count = ?, next_eligible_at_ms = ?,
                  last_error_code = ?, last_error_detail_value_id = ?,
                  last_error_detail_hash = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND status IN ('pending','retry_wait')`,
          [
            status,
            attemptNo,
            status === 'retry_wait' ? (input.nextEligibleAtMs ?? null) : null,
            status === 'ready'
              ? null
              : (input.errorCode ?? 'root_finalization_conflict'),
            status === 'ready' ? null : (input.errorDetail?.id ?? null),
            status === 'ready' ? null : (input.errorDetail?.hash ?? null),
            input.nowMs,
            schedule.id,
            schedule.row_version,
          ],
        ).changes,
        'Root Finalization Schedule attempt',
      );
      appendRootFinalizationEvent(transaction, {
        graphRunId: schedule.source_run_id,
        scheduleId: schedule.id,
        status,
        nowMs: input.nowMs,
        suffix: `attempt:${attemptNo}`,
      });
      const blockerId =
        status === 'exhausted'
          ? openExhaustionBlocker(transaction, input, schedule)
          : null;
      assertNoDeferredForeignKeyViolations(
        transaction,
        'Root Finalization attempt',
      );
      return {
        disposition: 'recorded',
        scheduleId: schedule.id,
        attemptNo,
        status,
        blockerId,
      };
    },
    fault,
  );
}

export interface RequiredChildClaimHandoffInput {
  readonly parentClaimId: string;
  readonly expectedParentClaimRowVersion: number;
  readonly expectedHeadRowVersion: number;
  readonly expectedParentFencingToken: number;
}

export interface RequiredChildCommitInput {
  readonly scheduleId: string;
  readonly expectedScheduleRowVersion: number;
  readonly commandPolicy: RuntimeRegistryRef;
  readonly inputSchema: RuntimeRegistryRef;
  readonly contextContract: RuntimeRegistryRef;
  readonly contextSnapshot: RuntimeValueRef;
  readonly ownershipHash: Sha256Hash;
  readonly recipeVersion: string;
  readonly definitionVersion: string;
  readonly deadlineAtMs: number | null;
  readonly resourceLimits: Readonly<Record<string, number>>;
  readonly initialActivation: Omit<
    T1ActivationInput,
    'workflowId' | 'expectedWorkflowRowVersion'
  >;
  readonly claimHandoffs: readonly RequiredChildClaimHandoffInput[];
}

export interface BestEffortTransitionOutboxInput {
  readonly transitionEffectId: string;
  readonly effectType: string;
  readonly adapter: RuntimeRegistryRef;
  readonly deliveryPolicy: RuntimeRegistryRef;
  readonly policySnapshot: RuntimeValueRef;
  readonly payload: RuntimeValueRef;
  readonly nextAttemptAtMs: number;
  readonly deadlineAtMs: number;
}

export type RootTransitionTarget =
  | {
      readonly kind: 'nonterminal';
      readonly stateKey: string;
      readonly activation: Omit<
        T1ActivationInput,
        'workflowId' | 'expectedWorkflowRowVersion' | 'stateKey'
      >;
    }
  | {
      readonly kind: 'terminal';
      readonly stateKey: string;
      readonly definition: RuntimeRegistryRef;
      readonly definitionVersion: string;
      readonly stateConfig: RuntimeValueRef;
      readonly terminalKind: 'normal' | 'errored';
      readonly output: RuntimeValueRef | null;
      readonly outputSchemaHash: Sha256Hash | null;
      readonly errorCode: string | null;
      readonly errorDetail: RuntimeValueRef | null;
    }
  | { readonly kind: 'global_cancel' };

export interface T8RootCommitInput {
  readonly workflowId: string;
  readonly sourceActivationId: string;
  readonly sourceRunId: string;
  readonly rootScopeId: string;
  readonly closeRequestId: string;
  readonly expectedWorkflowRowVersion: number;
  readonly expectedSourceActivationRowVersion: number;
  readonly expectedSourceRunRowVersion: number;
  readonly expectedRootScopeRowVersion: number;
  readonly routeSource: string;
  readonly target: RootTransitionTarget;
  readonly contextValueSchema: RuntimeRegistryRef;
  readonly requiredChildren: readonly RequiredChildCommitInput[];
  readonly bestEffortOutbox: readonly BestEffortTransitionOutboxInput[];
  readonly nowMs: number;
}

export interface T8RootCommitReceipt {
  readonly disposition: 'committed' | 'exact_replay';
  readonly completionCutId: string;
  readonly transitionHistoryId: string;
  readonly checkpointId: string;
  readonly targetActivation: T1ActivationReceipt | null;
  readonly childWorkflowIds: readonly string[];
}

interface RootCutAuthority {
  outcomeKind: 'completed' | 'errored' | 'cancelled';
  selectedRuleId: string | null;
  candidateId: string | null;
  exitName: string | null;
  output: RuntimeValueRef | null;
  errorCode: string | null;
  errorDetail: RuntimeValueRef | null;
  cancelReason: string | null;
  completionPolicyHash: Sha256Hash;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not an object`,
    );
  return value as JsonObject;
}

function rootCutAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
): RootCutAuthority {
  const close = transaction.queryOne<{
    reason: string;
    selected_rule_id: string | null;
    candidate_id: string | null;
    error_code: string | null;
    error_detail_value_id: string | null;
    error_detail_hash: Sha256Hash | null;
    cancel_payload_json: string | null;
  }>(
    `SELECT reason, selected_rule_id, candidate_id, error_code,
            error_detail_value_id, error_detail_hash, cancel_payload_json
       FROM workflow_graph_scope_close_requests
      WHERE id = ? AND graph_run_id = ? AND scope_id = ?`,
    [input.closeRequestId, input.sourceRunId, input.rootScopeId],
  );
  const plan = transaction.queryOne<{ compiled_plan_json: string }>(
    `SELECT p.compiled_plan_json FROM workflow_graph_scopes s
       JOIN workflow_graph_scope_plans p ON p.id = s.plan_id
      WHERE s.id = ? AND s.graph_run_id = ? AND p.plan_hash = s.plan_hash`,
    [input.rootScopeId, input.sourceRunId],
  );
  if (!close || !plan)
    throw new G5RuntimeError(
      'precondition_failed',
      'T8 root close or exact Plan authority is missing',
    );
  const planJson = requiredObject(
    JSON.parse(plan.compiled_plan_json),
    'Root Plan',
  );
  const completion = requiredObject(planJson.completion, 'Root completion');
  const completionPolicyHash = completion.policy_hash as Sha256Hash;
  if (close.reason === 'normal') {
    const candidate = transaction.queryOne<{
      exit_name: string;
      output_snapshot_value_id: string;
      output_snapshot_hash: Sha256Hash;
    }>(
      `SELECT exit_name, output_snapshot_value_id, output_snapshot_hash
         FROM workflow_graph_terminal_candidates
        WHERE id = ? AND scope_id = ?`,
      [close.candidate_id, input.rootScopeId],
    );
    if (
      !candidate ||
      close.selected_rule_id === null ||
      close.candidate_id === null
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T8 normal root close lacks its selected candidate',
      );
    return {
      outcomeKind: 'completed',
      selectedRuleId: close.selected_rule_id,
      candidateId: close.candidate_id,
      exitName: candidate.exit_name,
      output: {
        id: candidate.output_snapshot_value_id,
        hash: candidate.output_snapshot_hash,
      },
      errorCode: null,
      errorDetail: null,
      cancelReason: null,
      completionPolicyHash,
    };
  }
  if (close.reason === 'engine_error')
    return {
      outcomeKind: 'errored',
      selectedRuleId: null,
      candidateId: null,
      exitName: null,
      output: null,
      errorCode: close.error_code,
      errorDetail:
        close.error_detail_value_id && close.error_detail_hash
          ? { id: close.error_detail_value_id, hash: close.error_detail_hash }
          : null,
      cancelReason: null,
      completionPolicyHash,
    };
  if (
    ['local_cancel', 'workflow_cancel'].includes(close.reason) &&
    close.cancel_payload_json
  )
    return {
      outcomeKind: 'cancelled',
      selectedRuleId: null,
      candidateId: null,
      exitName: null,
      output: null,
      errorCode: null,
      errorDetail: null,
      cancelReason: close.reason,
      completionPolicyHash,
    };
  throw new G5RuntimeError(
    'integrity_violation',
    'T8 root close reason cannot produce a root Cut',
  );
}

function loadTransitionAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  authority: RootCutAuthority,
): { transition: JsonObject | null; effects: JsonObject[] } {
  if (authority.cancelReason === 'workflow_cancel') {
    if (
      input.target.kind !== 'global_cancel' ||
      input.routeSource !== 'workflow_cancel'
    )
      throw new G5RuntimeError(
        'contract_invalid',
        'T8 workflow cancel cannot use a Definition route',
      );
    return { transition: null, effects: [] };
  }
  if (input.target.kind === 'global_cancel')
    throw new G5RuntimeError(
      'contract_invalid',
      'Only workflow_cancel may omit the target transition',
    );
  const source = transaction.queryOne<{
    state_key: string;
    workflow_definition_resource_id: string;
    workflow_definition_resource_hash: Sha256Hash;
    inline_canonical_json: string | null;
  }>(
    `SELECT a.state_key, a.workflow_definition_resource_id,
            a.workflow_definition_resource_hash, v.inline_canonical_json
       FROM workflow_state_activations a
       JOIN workflow_registry_resources rr
         ON rr.id = a.workflow_definition_resource_id
        AND rr.content_hash = a.workflow_definition_resource_hash
       JOIN workflow_values v ON v.id = rr.canonical_value_id
      WHERE a.id = ? AND a.workflow_id = ?
        AND rr.publication_state = 'published' AND v.payload_state = 'live'`,
    [input.sourceActivationId, input.workflowId],
  );
  if (!source?.inline_canonical_json)
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 source Definition authority is unavailable',
    );
  const definition = requiredObject(
    JSON.parse(source.inline_canonical_json),
    'Workflow Definition',
  );
  const states = requiredObject(
    definition.states,
    'Workflow Definition states',
  );
  const state = requiredObject(states[source.state_key], 'Source State');
  let route: JsonValue | undefined;
  let expectedRouteSource: string;
  if (authority.outcomeKind === 'completed') {
    expectedRouteSource = `exit:${authority.exitName}`;
    const routes = requiredObject(
      state.exit_routes ?? state.on_complete,
      'Source completed routes',
    );
    route = routes[authority.exitName!];
  } else if (authority.outcomeKind === 'errored') {
    expectedRouteSource = 'on_error';
    route = state.on_error;
  } else {
    expectedRouteSource = 'on_local_cancel';
    route = state.on_local_cancel;
  }
  if (input.routeSource !== expectedRouteSource || route === undefined)
    throw new G5RuntimeError(
      'precondition_failed',
      'T8 exact outcome route is absent or drifted',
    );
  const transition = requiredObject(route, 'Workflow transition');
  if (transition.target !== input.target.stateKey)
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 target does not match the published Definition route',
    );
  const targetState = requiredObject(
    states[input.target.stateKey],
    'Target State',
  );
  if ((input.target.kind === 'terminal') !== (targetState.type === 'terminal'))
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 target kind differs from the published Definition',
    );
  const effects = transition.effects
    ? requiredObject(transition.effects, 'Transition effects').operations
    : [];
  if (!Array.isArray(effects))
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 transition effects are not an ordered array',
    );
  return {
    transition,
    effects: effects.map((effect) =>
      requiredObject(effect, 'Transition effect'),
    ),
  };
}

function persistContextRevision(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  completionCutId: string,
  workflowRevision: number,
): {
  patchHash: Sha256Hash;
  snapshotId: string;
  snapshotHash: Sha256Hash;
} {
  assertExactPublishedRegistryResource(
    transaction,
    input.contextValueSchema,
    'T8 context Value schema',
  );
  const previous = transaction.queryOne<{
    current_context_snapshot_id: string;
    current_context_snapshot_hash: Sha256Hash;
    context_contract_resource_id: string;
    context_contract_resource_hash: Sha256Hash;
  }>(
    `SELECT current_context_snapshot_id, current_context_snapshot_hash,
            context_contract_resource_id, context_contract_resource_hash
       FROM workflows WHERE id = ?`,
    [input.workflowId],
  )!;
  const slots = transaction.queryAll<{
    slot_name: string;
    value_value_id: string;
    value_hash: Sha256Hash;
    schema_resource_id: string;
    schema_resource_hash: Sha256Hash;
    byte_length: number;
    provenance_ref: string;
  }>(
    `SELECT slot_name, value_value_id, value_hash, schema_resource_id,
            schema_resource_hash, byte_length, provenance_ref
       FROM workflow_context_slot_values WHERE snapshot_id = ?
      ORDER BY slot_name COLLATE BINARY`,
    [previous.current_context_snapshot_id],
  );
  const patchPayload: JsonObject = {
    format: 'icarus.workflow-context-patch/1',
    operations: [],
  };
  const patchHash = runtimeObjectHash('context-patch', patchPayload);
  const patchValueId = stableRuntimeId('value', {
    workflow_id: input.workflowId,
    completion_cut_id: completionCutId,
    kind: 'context-patch',
  });
  insertInlineValue(transaction, {
    id: patchValueId,
    content: patchPayload,
    contentHash: patchHash,
    schemaResourceId: input.contextValueSchema.rowId,
    schemaResourceHash: input.contextValueSchema.hash,
    provenanceRef: `t8:${completionCutId}:context-patch`,
    retentionClass: 'workflow_audit',
    ownerWorkflowId: input.workflowId,
    createdAtMs: input.nowMs,
  });
  const slotsPayload = slots.map((slot) => ({
    slot_name: slot.slot_name,
    value_id: slot.value_value_id,
    value_hash: slot.value_hash,
    schema_resource_id: slot.schema_resource_id,
    schema_resource_hash: slot.schema_resource_hash,
    byte_length: slot.byte_length,
    provenance_ref: slot.provenance_ref,
  }));
  const slotsHash = runtimeObjectHash('context-slots-manifest', slotsPayload);
  const slotsValueId = stableRuntimeId('value', {
    workflow_id: input.workflowId,
    revision: workflowRevision,
    kind: 'context-slots',
  });
  insertInlineValue(transaction, {
    id: slotsValueId,
    content: slotsPayload,
    contentHash: slotsHash,
    schemaResourceId: input.contextValueSchema.rowId,
    schemaResourceHash: input.contextValueSchema.hash,
    provenanceRef: `t8:${completionCutId}:context-slots`,
    retentionClass: 'workflow_audit',
    ownerWorkflowId: input.workflowId,
    createdAtMs: input.nowMs,
  });
  const snapshotId = stableRuntimeId('context', {
    workflow_id: input.workflowId,
    revision: workflowRevision,
  });
  const snapshotHash = runtimeObjectHash('context-snapshot', {
    workflow_id: input.workflowId,
    revision: workflowRevision,
    previous_snapshot_id: previous.current_context_snapshot_id,
    previous_snapshot_hash: previous.current_context_snapshot_hash,
    slots_manifest_hash: slotsHash,
  });
  transaction.execute(
    `INSERT INTO workflow_context_patches (
       id, workflow_id, source_run_id, completion_cut_id, patch_value_id,
       patch_hash, operation_count, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      stableRuntimeId('context-patch', { completion_cut_id: completionCutId }),
      input.workflowId,
      input.sourceRunId,
      completionCutId,
      patchValueId,
      patchHash,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_context_snapshots (
       id, workflow_id, revision, contract_resource_id, contract_resource_hash,
       previous_snapshot_id, previous_snapshot_hash, slots_manifest_value_id,
       slots_manifest_hash, snapshot_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshotId,
      input.workflowId,
      workflowRevision,
      previous.context_contract_resource_id,
      previous.context_contract_resource_hash,
      previous.current_context_snapshot_id,
      previous.current_context_snapshot_hash,
      slotsValueId,
      slotsHash,
      snapshotHash,
      input.nowMs,
    ],
  );
  for (const slot of slots)
    transaction.execute(
      `INSERT INTO workflow_context_slot_values (
         snapshot_id, slot_name, value_value_id, value_hash,
         schema_resource_id, schema_resource_hash, byte_length, provenance_ref
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        slot.slot_name,
        slot.value_value_id,
        slot.value_hash,
        slot.schema_resource_id,
        slot.schema_resource_hash,
        slot.byte_length,
        slot.provenance_ref,
      ],
    );
  return { patchHash, snapshotId, snapshotHash };
}

function assertFiniteLimits(limits: Readonly<Record<string, number>>): void {
  for (const required of [
    'state_activations_total',
    'graph_runs_total',
    'descendant_workflows_total',
  ])
    if (!Number.isSafeInteger(limits[required]) || limits[required]! <= 0)
      throw new G5RuntimeError(
        'contract_invalid',
        `Required Child requires finite positive ${required}`,
      );
}

function createRequiredChild(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  child: RequiredChildCommitInput,
  completionCutId: string,
): { childWorkflowId: string; relationId: string } {
  const schedule = loadSchedule(transaction, child.scheduleId);
  if (
    !schedule ||
    schedule.workflow_id !== input.workflowId ||
    schedule.source_state_instance_id !== input.sourceActivationId ||
    schedule.source_run_id !== input.sourceRunId ||
    schedule.root_scope_id !== input.rootScopeId ||
    schedule.close_request_id !== input.closeRequestId ||
    schedule.status !== 'ready' ||
    schedule.row_version !== child.expectedScheduleRowVersion ||
    schedule.child_workflow_id !== null
  )
    throw new G5RuntimeError(
      'cas_conflict',
      'T8 required Child Schedule authority is stale',
    );
  assertFiniteLimits(child.resourceLimits);
  for (const [label, resource] of Object.entries({
    commandPolicy: child.commandPolicy,
    inputSchema: child.inputSchema,
    contextContract: child.contextContract,
    definition: child.initialActivation.definition,
  }))
    assertExactPublishedRegistryResource(
      transaction,
      resource,
      `T8 required Child ${label}`,
    );
  assertStoredValue(transaction, child.contextSnapshot, 'Child context');
  const request = transaction.queryOne<{
    intake_id: string;
    creation_domain: string;
    creation_key: string;
    recipe_resource_id: string;
    recipe_resource_hash: Sha256Hash;
    definition_resource_id: string;
    definition_resource_hash: Sha256Hash;
    execution_policy_resource_id: string;
    execution_policy_resource_hash: Sha256Hash;
    input_snapshot_value_id: string;
    input_snapshot_hash: Sha256Hash;
    attachment_manifest_value_id: string;
    attachment_manifest_hash: Sha256Hash;
    creation_intent_hash: Sha256Hash;
    runtime_safety_hash: Sha256Hash;
    status: string;
    workflow_id: string | null;
  }>(
    `SELECT intake_id, creation_domain, creation_key, recipe_resource_id,
            recipe_resource_hash, definition_resource_id,
            definition_resource_hash, execution_policy_resource_id,
            execution_policy_resource_hash, input_snapshot_value_id,
            input_snapshot_hash, attachment_manifest_value_id,
            attachment_manifest_hash, creation_intent_hash,
            runtime_safety_hash, status, workflow_id
       FROM workflow_creation_requests WHERE id = ?`,
    [schedule.creation_request_id],
  );
  if (
    !request ||
    request.status !== 'pending' ||
    request.workflow_id !== null ||
    request.intake_id !== schedule.transition_intake_id ||
    request.creation_domain !== schedule.creation_domain ||
    request.creation_key !== schedule.creation_key ||
    request.recipe_resource_id !== schedule.recipe_resource_id ||
    request.recipe_resource_hash !== schedule.recipe_resource_hash ||
    request.input_snapshot_value_id !== schedule.input_snapshot_value_id ||
    request.input_snapshot_hash !== schedule.input_snapshot_hash ||
    request.creation_intent_hash !== schedule.creation_intent_hash ||
    request.definition_resource_id !==
      child.initialActivation.definition.rowId ||
    request.definition_resource_hash !==
      child.initialActivation.definition.hash ||
    request.runtime_safety_hash !==
      child.initialActivation.runtimeSafetySnapshot.hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 required Child Creation Request drifted',
    );
  const parent = transaction.queryOne<{
    root_workflow_id: string;
    workflow_depth: number;
    lineage_budget_account_id: string;
    ownership_hash: Sha256Hash;
    child_workflow_count: number;
  }>(
    `SELECT root_workflow_id, workflow_depth, lineage_budget_account_id,
            ownership_hash, child_workflow_count
       FROM workflows WHERE id = ?`,
    [input.workflowId],
  )!;
  if (child.ownershipHash !== parent.ownership_hash)
    throw new G5RuntimeError(
      'integrity_violation',
      'Required Child ownership hash differs from Parent authority',
    );
  const childWorkflowId = stableRuntimeId('workflow', {
    creation_domain: schedule.creation_domain,
    creation_key: schedule.creation_key,
  });
  const contextSnapshotId = stableRuntimeId('context', {
    workflow_id: childWorkflowId,
    revision: 0,
  });
  const activationId = stableRuntimeId('activation', {
    workflow_id: childWorkflowId,
    activation_no: 1,
  });
  transaction.execute(
    `INSERT INTO workflows (
       id, status, operational_state, recipe_resource_id, recipe_resource_hash,
       recipe_version, creation_request_id, creation_domain, creation_key,
       owner_principal_ref, controlling_feature_id, creator_automation_ref,
       ownership_hash, root_workflow_id, parent_workflow_id, workflow_depth,
       lineage_budget_account_id, workflow_execution_policy_resource_id,
       workflow_execution_policy_resource_hash,
       workflow_command_policy_resource_id, workflow_command_policy_resource_hash,
       workflow_input_value_id, workflow_input_hash,
       workflow_input_schema_resource_id, workflow_input_schema_resource_hash,
       context_contract_resource_id, context_contract_resource_hash,
       current_context_snapshot_id, current_context_snapshot_hash,
       runtime_safety_hash, state_activation_count, graph_run_count,
       state_transition_count, child_workflow_count, started_at_ms, deadline_at_ms,
       workflow_definition_version, state_instance_id, current_graph_run_id,
       final_outcome_kind, final_output_value_id, final_output_hash,
       final_output_schema_hash, final_error_code, final_error_detail_value_id,
       final_error_detail_hash, final_cancel_reason, workflow_revision,
       row_version, created_at_ms, updated_at_ms, finished_at_ms
     ) VALUES (?, 'active', 'healthy', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, ?, ?, NULL)`,
    [
      childWorkflowId,
      schedule.recipe_resource_id,
      schedule.recipe_resource_hash,
      child.recipeVersion,
      schedule.creation_request_id,
      schedule.creation_domain,
      schedule.creation_key,
      schedule.principal_ref,
      child.ownershipHash,
      parent.root_workflow_id,
      input.workflowId,
      parent.workflow_depth + 1,
      parent.lineage_budget_account_id,
      request.execution_policy_resource_id,
      request.execution_policy_resource_hash,
      child.commandPolicy.rowId,
      child.commandPolicy.hash,
      request.input_snapshot_value_id,
      request.input_snapshot_hash,
      child.inputSchema.rowId,
      child.inputSchema.hash,
      child.contextContract.rowId,
      child.contextContract.hash,
      contextSnapshotId,
      child.contextSnapshot.hash,
      request.runtime_safety_hash,
      input.nowMs,
      child.deadlineAtMs,
      child.definitionVersion,
      activationId,
      input.nowMs,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_context_snapshots (
       id, workflow_id, revision, contract_resource_id, contract_resource_hash,
       previous_snapshot_id, previous_snapshot_hash, slots_manifest_value_id,
       slots_manifest_hash, snapshot_hash, created_at_ms
     ) VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      contextSnapshotId,
      childWorkflowId,
      child.contextContract.rowId,
      child.contextContract.hash,
      child.contextSnapshot.id,
      child.contextSnapshot.hash,
      child.contextSnapshot.hash,
      input.nowMs,
    ],
  );
  for (const [resourceType, hardLimit] of Object.entries(
    child.resourceLimits,
  ).sort(([left], [right]) => left.localeCompare(right, 'en')))
    transaction.execute(
      `INSERT INTO workflow_graph_resource_accounts (
         id, deployment_scope_ref, workflow_id, graph_run_id, scope_id, node_id,
         execution_group_resource_id, execution_group_resource_hash,
         resource_type, hard_limit, reserved_amount, consumed_amount, row_version
       ) VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 0, 0, 1)`,
      [
        stableRuntimeId('account', {
          workflow_id: childWorkflowId,
          resource_type: resourceType,
        }),
        childWorkflowId,
        resourceType,
        hardLimit,
      ],
    );
  const activation = activateWorkflowT1InTransaction(transaction, {
    ...child.initialActivation,
    workflowId: childWorkflowId,
    expectedWorkflowRowVersion: 1,
  });
  const relationId = stableRuntimeId('workflow-relation', {
    parent_workflow_id: input.workflowId,
    source_completion_cut_id: completionCutId,
    transition_effect_id: schedule.transition_effect_id,
  });
  transaction.execute(
    `INSERT INTO workflow_relations (
       id, parent_workflow_id, child_workflow_id, root_workflow_id,
       workflow_depth, lineage_budget_account_id, source_state_instance_id,
       source_run_id, source_completion_cut_id, transition_effect_id,
       relation_kind, recipe_resource_id, recipe_resource_hash, creation_key,
       created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transition_child', ?, ?, ?, ?)`,
    [
      relationId,
      input.workflowId,
      childWorkflowId,
      parent.root_workflow_id,
      parent.workflow_depth + 1,
      parent.lineage_budget_account_id,
      input.sourceActivationId,
      input.sourceRunId,
      completionCutId,
      schedule.transition_effect_id,
      schedule.recipe_resource_id,
      schedule.recipe_resource_hash,
      schedule.creation_key,
      input.nowMs,
    ],
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_creation_requests
          SET status = 'created', workflow_id = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'pending' AND workflow_id IS NULL`,
      [childWorkflowId, input.nowMs, schedule.creation_request_id],
    ).changes,
    'T8 required Child Creation Request',
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_task_intakes
          SET status = 'created', workflow_id = ?, row_version = row_version + 1,
              updated_at_ms = ?
        WHERE id = ? AND status = 'ready_to_create' AND workflow_id IS NULL`,
      [childWorkflowId, input.nowMs, schedule.transition_intake_id],
    ).changes,
    'T8 required Child Intake',
  );
  requireSingleChange(
    transaction.execute(
      `UPDATE workflow_root_finalization_schedules
          SET status = 'succeeded', child_workflow_id = ?,
              next_eligible_at_ms = NULL, completed_at_ms = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND status = 'ready'
          AND child_workflow_id IS NULL`,
      [
        childWorkflowId,
        input.nowMs,
        input.nowMs,
        schedule.id,
        schedule.row_version,
      ],
    ).changes,
    'T8 required Child Schedule',
  );
  transaction.execute(
    `UPDATE workflow_root_finalization_attempts
        SET result = 'applied'
      WHERE schedule_id = ? AND attempt_no = ? AND result = 'ready'`,
    [schedule.id, schedule.attempt_count],
  );
  chargeWorkflowLifetimeResources(transaction, {
    graphRunId: input.sourceRunId,
    workflowId: childWorkflowId,
    accountWorkflowId: parent.root_workflow_id,
    reservationGroupId: stableRuntimeId('reservation-group', {
      graph_run_id: input.sourceRunId,
      child_workflow_id: childWorkflowId,
      purpose: 'required_child_lineage',
    }),
    amounts: { descendant_workflows_total: 1 },
    purpose: 'required_child_lineage',
    nowMs: input.nowMs,
  });
  for (const handoff of child.claimHandoffs) {
    const parentClaim = transaction.queryOne<{
      namespace: string;
      key_hash: Sha256Hash;
    }>(
      'SELECT namespace, key_hash FROM workflow_domain_resource_claims WHERE id = ?',
      [handoff.parentClaimId],
    );
    if (!parentClaim)
      throw new G5RuntimeError(
        'precondition_failed',
        'T8 required Child Parent Claim is missing',
      );
    handoffRequiredChildDomainClaim(transaction, {
      parentClaimId: handoff.parentClaimId,
      parentWorkflowId: input.workflowId,
      expectedParentClaimRowVersion: handoff.expectedParentClaimRowVersion,
      expectedHeadRowVersion: handoff.expectedHeadRowVersion,
      expectedParentFencingToken: handoff.expectedParentFencingToken,
      child: {
        namespace: parentClaim.namespace,
        keyHash: parentClaim.key_hash,
        mode: 'exclusive',
        ownerWorkflowId: childWorkflowId,
        recipeResourceId: schedule.recipe_resource_id,
        recipeResourceHash: schedule.recipe_resource_hash,
        sourceIntakeId: schedule.transition_intake_id,
        creationKey: schedule.creation_key,
        acquiredAtMs: input.nowMs,
      },
      rootFinalizationScheduleId: schedule.id,
      creationRequestId: schedule.creation_request_id,
      workflowRelationId: relationId,
      transferredAtMs: input.nowMs,
    });
  }
  return { childWorkflowId, relationId };
}

function insertBestEffortOutbox(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  item: BestEffortTransitionOutboxInput,
): void {
  for (const [label, resource] of Object.entries({
    adapter: item.adapter,
    deliveryPolicy: item.deliveryPolicy,
  }))
    assertExactPublishedRegistryResource(
      transaction,
      resource,
      `T8 best-effort ${label}`,
    );
  assertStoredValue(transaction, item.policySnapshot, 'Best-effort policy');
  assertStoredValue(transaction, item.payload, 'Best-effort payload');
  if (
    !Number.isSafeInteger(item.nextAttemptAtMs) ||
    !Number.isSafeInteger(item.deadlineAtMs) ||
    item.nextAttemptAtMs < input.nowMs ||
    item.deadlineAtMs < item.nextAttemptAtMs
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'T8 best-effort Outbox requires a finite delivery window',
    );
  const effectKey = `workflow-transition:${input.closeRequestId}:${item.transitionEffectId}`;
  transaction.execute(
    `INSERT INTO workflow_outbox (
       id, effect_key, workflow_id, attempt_id, wait_id, effect_operation_id,
       domain_claim_id, projection_target_ref, aggregate_row_version,
       effect_type, adapter_resource_id, adapter_resource_hash,
       delivery_policy_resource_id, delivery_policy_resource_hash,
       policy_snapshot_value_id, policy_snapshot_hash, delivery_lane,
       delivery_requirement, payload_value_id, payload_hash, status,
       delivery_attempt_count, reconcile_attempt_count, next_attempt_at_ms,
       deadline_at_ms, lease_owner, lease_token, lease_expires_at_ms,
       last_result_kind, last_error_code, created_at_ms, delivered_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?,
       'normal_execution', 'best_effort', ?, ?, 'pending', 0, 0, ?, ?, NULL,
       NULL, NULL, NULL, NULL, ?, NULL, ?)`,
    [
      stableRuntimeId('outbox', { effect_key: effectKey }),
      effectKey,
      input.workflowId,
      input.expectedWorkflowRowVersion,
      item.effectType,
      item.adapter.rowId,
      item.adapter.hash,
      item.deliveryPolicy.rowId,
      item.deliveryPolicy.hash,
      item.policySnapshot.id,
      item.policySnapshot.hash,
      item.payload.id,
      item.payload.hash,
      item.nextAttemptAtMs,
      item.deadlineAtMs,
      input.nowMs,
      input.nowMs,
    ],
  );
}

function assertTransitionEffectIntent(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  effects: readonly JsonObject[],
): void {
  const requiredEffectIds = effects
    .filter(
      (effect) =>
        effect.type === 'start_child_workflow' &&
        effect.delivery_requirement === 'required',
    )
    .map((effect) => String(effect.id))
    .sort();
  const requestedRequired = input.requiredChildren.map(
    (child) =>
      loadSchedule(transaction, child.scheduleId)?.transition_effect_id,
  );
  if (requestedRequired.some((effectId) => effectId === undefined))
    throw new G5RuntimeError(
      'precondition_failed',
      'T8 required Child Schedule is missing',
    );
  requestedRequired.sort();
  const bestEffortEffectIds = effects
    .filter(
      (effect) =>
        effect.type !== 'start_child_workflow' ||
        effect.delivery_requirement === 'best_effort',
    )
    .map((effect) => String(effect.id))
    .sort();
  const requestedBestEffort = input.bestEffortOutbox
    .map((item) => item.transitionEffectId)
    .sort();
  if (
    canonicalJson(requiredEffectIds) !==
      canonicalJson(requestedRequired as string[]) ||
    canonicalJson(bestEffortEffectIds) !== canonicalJson(requestedBestEffort)
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 transition effect set differs from the published Definition',
    );
}

interface T8ReplayRow extends Record<string, unknown> {
  cut_id: string;
  history_id: string;
  checkpoint_id: string;
  target_state_instance_id: string | null;
  target_run_id: string | null;
}

function assertT8Replay(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T8RootCommitInput,
  replay: T8ReplayRow,
): T8RootCommitReceipt {
  const authority = rootCutAuthority(transaction, input);
  const route = loadTransitionAuthority(transaction, input, authority);
  assertTransitionEffectIntent(transaction, input, route.effects);
  const cut = transaction.queryOne<{
    id: string;
    selected_rule_id: string | null;
    candidate_id: string | null;
    outcome_kind: string;
    exit_name: string | null;
    output_value_id: string | null;
    output_hash: Sha256Hash | null;
    completion_policy_hash: Sha256Hash;
    cut_event_seq: number;
    cut_hash: Sha256Hash;
  }>(
    `SELECT id, selected_rule_id, candidate_id, outcome_kind, exit_name,
            output_value_id, output_hash, completion_policy_hash,
            cut_event_seq, cut_hash
       FROM workflow_graph_completion_cuts
      WHERE id = ? AND graph_run_id = ? AND scope_id = ?
        AND close_request_id = ?`,
    [replay.cut_id, input.sourceRunId, input.rootScopeId, input.closeRequestId],
  );
  const cutPayload: JsonObject = {
    graph_run_id: input.sourceRunId,
    scope_id: input.rootScopeId,
    close_request_id: input.closeRequestId,
    selected_rule_id: authority.selectedRuleId,
    candidate_id: authority.candidateId,
    outcome_kind: authority.outcomeKind,
    exit_name: authority.exitName,
    output_hash: authority.output?.hash ?? null,
    completion_policy_hash: authority.completionPolicyHash,
    cut_event_seq: cut?.cut_event_seq ?? -1,
  };
  const expectedCutHash = runtimeObjectHash('completion-cut', cutPayload);
  if (
    !cut ||
    cut.id !==
      stableRuntimeId('completion-cut', {
        graph_run_id: input.sourceRunId,
        scope_id: input.rootScopeId,
        close_request_id: input.closeRequestId,
      }) ||
    cut.selected_rule_id !== authority.selectedRuleId ||
    cut.candidate_id !== authority.candidateId ||
    cut.outcome_kind !== authority.outcomeKind ||
    cut.exit_name !== authority.exitName ||
    cut.output_value_id !== (authority.output?.id ?? null) ||
    cut.output_hash !== (authority.output?.hash ?? null) ||
    cut.completion_policy_hash !== authority.completionPolicyHash ||
    cut.cut_hash !== expectedCutHash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 replay completion Cut authority drifted',
    );
  const history = transaction.queryOne<{
    workflow_id: string;
    source_state_instance_id: string;
    source_run_id: string;
    target_state_key: string | null;
    target_state_instance_id: string | null;
    target_run_id: string | null;
    workflow_revision: number;
    context_patch_hash: Sha256Hash;
  }>(
    `SELECT workflow_id, source_state_instance_id, source_run_id,
            target_state_key, target_state_instance_id, target_run_id,
            workflow_revision, context_patch_hash
       FROM workflow_state_transition_history WHERE id = ?`,
    [replay.history_id],
  );
  const expectedTargetStateKey =
    input.target.kind === 'global_cancel' ? null : input.target.stateKey;
  if (
    !history ||
    history.workflow_id !== input.workflowId ||
    history.source_state_instance_id !== input.sourceActivationId ||
    history.source_run_id !== input.sourceRunId ||
    history.target_state_key !== expectedTargetStateKey ||
    history.target_state_instance_id !== replay.target_state_instance_id ||
    history.target_run_id !== replay.target_run_id
  )
    throw new G5RuntimeError(
      'idempotency_conflict',
      'T8 replay transition target differs from committed history',
    );
  const patch = transaction.queryOne<{
    patch_hash: Sha256Hash;
    operation_count: number;
    inline_canonical_json: string | null;
    content_hash: Sha256Hash;
    schema_resource_id: string | null;
    schema_resource_hash: Sha256Hash | null;
    payload_state: string;
  }>(
    `SELECT p.patch_hash, p.operation_count, v.inline_canonical_json,
            v.content_hash, v.schema_resource_id, v.schema_resource_hash,
            v.payload_state
       FROM workflow_context_patches p
       JOIN workflow_values v ON v.id = p.patch_value_id
      WHERE p.completion_cut_id = ? AND p.workflow_id = ?
        AND p.source_run_id = ?`,
    [replay.cut_id, input.workflowId, input.sourceRunId],
  );
  const emptyPatch: JsonObject = {
    format: 'icarus.workflow-context-patch/1',
    operations: [],
  };
  const emptyPatchBytes = canonicalJson(emptyPatch);
  const emptyPatchHash = runtimeObjectHash('context-patch', emptyPatch);
  if (
    !patch ||
    patch.operation_count !== 0 ||
    patch.inline_canonical_json !== emptyPatchBytes ||
    patch.patch_hash !== emptyPatchHash ||
    patch.content_hash !== emptyPatchHash ||
    patch.schema_resource_id !== input.contextValueSchema.rowId ||
    patch.schema_resource_hash !== input.contextValueSchema.hash ||
    patch.payload_state !== 'live' ||
    history.context_patch_hash !== emptyPatchHash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 replay context-patch authority drifted',
    );
  const checkpoint = transaction.queryOne<{
    snapshot_json: string;
    snapshot_hash: Sha256Hash;
  }>(
    'SELECT snapshot_json, snapshot_hash FROM workflow_checkpoints WHERE id = ?',
    [replay.checkpoint_id],
  );
  let checkpointPayload: JsonObject | null = null;
  try {
    checkpointPayload = checkpoint
      ? requiredObject(JSON.parse(checkpoint.snapshot_json), 'T8 checkpoint')
      : null;
  } catch {
    checkpointPayload = null;
  }
  const completed = checkpointPayload
    ? requiredObject(checkpointPayload.completed, 'T8 completed checkpoint')
    : null;
  if (
    !checkpoint ||
    !checkpointPayload ||
    !completed ||
    canonicalJson(checkpointPayload) !== checkpoint.snapshot_json ||
    runtimeObjectHash('checkpoint', checkpointPayload) !==
      checkpoint.snapshot_hash ||
    completed.state_instance_id !== input.sourceActivationId ||
    completed.run_id !== input.sourceRunId ||
    completed.root_scope_id !== input.rootScopeId ||
    completed.completion_cut_id !== replay.cut_id ||
    completed.row_version !== input.expectedSourceRunRowVersion + 1
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T8 replay checkpoint authority drifted',
    );
  if (input.target.kind === 'global_cancel') {
    if (
      replay.target_state_instance_id !== null ||
      replay.target_run_id !== null
    )
      throw new G5RuntimeError(
        'idempotency_conflict',
        'T8 replay global cancel has a committed target Activation',
      );
  } else {
    const target = transaction.queryOne<{
      state_key: string;
      state_type: string;
      workflow_definition_resource_id: string;
      workflow_definition_resource_hash: Sha256Hash;
      workflow_definition_version: string;
      state_config_value_id: string;
      state_config_hash: Sha256Hash;
      graph_run_id: string | null;
      terminal_kind: string | null;
      terminal_output_value_id: string | null;
      terminal_output_hash: Sha256Hash | null;
      terminal_output_schema_hash: Sha256Hash | null;
      terminal_error_code: string | null;
      terminal_error_detail_value_id: string | null;
      terminal_error_detail_hash: Sha256Hash | null;
    }>(
      `SELECT state_key, state_type, workflow_definition_resource_id,
              workflow_definition_resource_hash, workflow_definition_version,
              state_config_value_id, state_config_hash, graph_run_id,
              terminal_kind, terminal_output_value_id, terminal_output_hash,
              terminal_output_schema_hash, terminal_error_code,
              terminal_error_detail_value_id, terminal_error_detail_hash
         FROM workflow_state_activations WHERE id = ? AND workflow_id = ?`,
      [replay.target_state_instance_id, input.workflowId],
    );
    const definition =
      input.target.kind === 'terminal'
        ? input.target.definition
        : input.target.activation.definition;
    const definitionVersion =
      input.target.kind === 'terminal'
        ? input.target.definitionVersion
        : input.target.activation.definitionVersion;
    const stateConfig =
      input.target.kind === 'terminal'
        ? input.target.stateConfig
        : input.target.activation.stateConfig;
    if (
      !target ||
      target.state_key !== input.target.stateKey ||
      target.state_type !==
        (input.target.kind === 'terminal'
          ? 'terminal'
          : input.target.activation.stateType) ||
      target.workflow_definition_resource_id !== definition.rowId ||
      target.workflow_definition_resource_hash !== definition.hash ||
      target.workflow_definition_version !== definitionVersion ||
      target.state_config_value_id !== stateConfig.id ||
      target.state_config_hash !== stateConfig.hash ||
      target.graph_run_id !== replay.target_run_id ||
      (input.target.kind === 'terminal' &&
        (target.terminal_kind !== input.target.terminalKind ||
          target.terminal_output_value_id !==
            (input.target.output?.id ?? null) ||
          target.terminal_output_hash !== (input.target.output?.hash ?? null) ||
          target.terminal_output_schema_hash !==
            input.target.outputSchemaHash ||
          target.terminal_error_code !== input.target.errorCode ||
          target.terminal_error_detail_value_id !==
            (input.target.errorDetail?.id ?? null) ||
          target.terminal_error_detail_hash !==
            (input.target.errorDetail?.hash ?? null)))
    )
      throw new G5RuntimeError(
        'idempotency_conflict',
        'T8 replay target Activation differs from committed intent',
      );
  }
  const committedChildren = transaction.queryAll<{
    transition_effect_id: string;
    child_workflow_id: string;
  }>(
    `SELECT transition_effect_id, child_workflow_id FROM workflow_relations
      WHERE parent_workflow_id = ? AND source_completion_cut_id = ?
      ORDER BY transition_effect_id COLLATE BINARY`,
    [input.workflowId, replay.cut_id],
  );
  const requestedChildren = input.requiredChildren
    .map((child) => {
      const schedule = loadSchedule(transaction, child.scheduleId);
      if (
        !schedule ||
        schedule.workflow_id !== input.workflowId ||
        schedule.source_state_instance_id !== input.sourceActivationId ||
        schedule.source_run_id !== input.sourceRunId ||
        schedule.root_scope_id !== input.rootScopeId ||
        schedule.close_request_id !== input.closeRequestId ||
        schedule.status !== 'succeeded' ||
        schedule.row_version !== child.expectedScheduleRowVersion + 1 ||
        schedule.child_workflow_id === null
      )
        throw new G5RuntimeError(
          'idempotency_conflict',
          'T8 replay required Child Schedule differs from committed intent',
        );
      return {
        transition_effect_id: schedule.transition_effect_id,
        child_workflow_id: schedule.child_workflow_id,
      };
    })
    .sort((left, right) =>
      left.transition_effect_id.localeCompare(right.transition_effect_id, 'en'),
    );
  if (canonicalJson(committedChildren) !== canonicalJson(requestedChildren))
    throw new G5RuntimeError(
      'idempotency_conflict',
      'T8 replay required Child set differs from committed relations',
    );
  const committedOutbox = transaction.queryAll<JsonObject>(
    `SELECT effect_key, aggregate_row_version, effect_type,
            adapter_resource_id, adapter_resource_hash,
            delivery_policy_resource_id, delivery_policy_resource_hash,
            policy_snapshot_value_id, policy_snapshot_hash,
            payload_value_id, payload_hash, next_attempt_at_ms, deadline_at_ms
       FROM workflow_outbox
      WHERE workflow_id = ? AND effect_key LIKE ? ESCAPE '\\'
      ORDER BY effect_key COLLATE BINARY`,
    [input.workflowId, `workflow-transition:${input.closeRequestId}:%`],
  );
  const requestedOutbox = input.bestEffortOutbox
    .map((item) => ({
      effect_key: `workflow-transition:${input.closeRequestId}:${item.transitionEffectId}`,
      aggregate_row_version: input.expectedWorkflowRowVersion,
      effect_type: item.effectType,
      adapter_resource_id: item.adapter.rowId,
      adapter_resource_hash: item.adapter.hash,
      delivery_policy_resource_id: item.deliveryPolicy.rowId,
      delivery_policy_resource_hash: item.deliveryPolicy.hash,
      policy_snapshot_value_id: item.policySnapshot.id,
      policy_snapshot_hash: item.policySnapshot.hash,
      payload_value_id: item.payload.id,
      payload_hash: item.payload.hash,
      next_attempt_at_ms: item.nextAttemptAtMs,
      deadline_at_ms: item.deadlineAtMs,
    }))
    .sort((left, right) =>
      left.effect_key.localeCompare(right.effect_key, 'en'),
    );
  if (canonicalJson(committedOutbox) !== canonicalJson(requestedOutbox))
    throw new G5RuntimeError(
      'idempotency_conflict',
      'T8 replay best-effort Outbox differs from committed intent',
    );
  return {
    disposition: 'exact_replay',
    completionCutId: replay.cut_id,
    transitionHistoryId: replay.history_id,
    checkpointId: replay.checkpoint_id,
    targetActivation: replay.target_state_instance_id
      ? {
          activationId: replay.target_state_instance_id,
          graphRunId: replay.target_run_id ?? '',
          rootScopeId: replay.target_run_id
            ? stableRuntimeId('scope', {
                graph_run_id: replay.target_run_id,
                scope_kind: 'root',
              })
            : '',
          rootBuildId: replay.target_run_id
            ? stableRuntimeId('build', {
                graph_run_id: replay.target_run_id,
                invocation_key: 'root',
              })
            : '',
          disposition: 'exact_replay',
        }
      : null,
    childWorkflowIds: committedChildren.map((row) => row.child_workflow_id),
  };
}

export function commitRootT8(
  store: WorkflowRuntimeStore,
  input: T8RootCommitInput,
  fault?: G5TransactionFault,
): T8RootCommitReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const replay = transaction.queryOne<T8ReplayRow>(
        `SELECT c.id AS cut_id, h.id AS history_id, cp.id AS checkpoint_id,
                h.target_state_instance_id, h.target_run_id
           FROM workflow_graph_completion_cuts c
           JOIN workflow_state_transition_history h
             ON h.completion_cut_id = c.id
           JOIN workflow_checkpoints cp ON cp.completion_cut_id = c.id
          WHERE c.close_request_id = ? AND c.graph_run_id = ?
            AND c.scope_id = ?`,
        [input.closeRequestId, input.sourceRunId, input.rootScopeId],
      );
      if (replay) return assertT8Replay(transaction, input, replay);
      const workflow = transaction.queryOne<{
        status: string;
        operational_state: string;
        state_instance_id: string;
        current_graph_run_id: string | null;
        workflow_revision: number;
        state_activation_count: number;
        state_transition_count: number;
        child_workflow_count: number;
        row_version: number;
      }>(
        `SELECT status, operational_state, state_instance_id,
                current_graph_run_id, workflow_revision,
                state_activation_count, state_transition_count,
                child_workflow_count, row_version
           FROM workflows WHERE id = ?`,
        [input.workflowId],
      );
      const run = transaction.queryOne<{
        lifecycle: string;
        operational_state: string;
        root_scope_id: string;
        root_close_request_id: string | null;
        root_cancel_scope: string | null;
        work_fence_epoch: number;
        next_event_seq: number;
        row_version: number;
      }>(
        `SELECT lifecycle, operational_state, root_scope_id,
                root_close_request_id, root_cancel_scope, work_fence_epoch, next_event_seq,
                row_version
           FROM workflow_graph_runs WHERE id = ? AND workflow_id = ?`,
        [input.sourceRunId, input.workflowId],
      );
      const root = transaction.queryOne<{
        lifecycle: string;
        close_request_id: string | null;
        work_fence_epoch: number;
        row_version: number;
      }>(
        `SELECT lifecycle, close_request_id, work_fence_epoch, row_version
           FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
        [input.rootScopeId, input.sourceRunId],
      );
      const activation = transaction.queryOne<{
        status: string;
        row_version: number;
      }>(
        `SELECT status, row_version FROM workflow_state_activations
          WHERE id = ? AND workflow_id = ? AND graph_run_id = ?`,
        [input.sourceActivationId, input.workflowId, input.sourceRunId],
      );
      if (
        !workflow ||
        !run ||
        !root ||
        !activation ||
        workflow.status !== 'active' ||
        workflow.operational_state !== 'healthy' ||
        workflow.state_instance_id !== input.sourceActivationId ||
        workflow.current_graph_run_id !== input.sourceRunId ||
        workflow.row_version !== input.expectedWorkflowRowVersion ||
        run.lifecycle !== 'closing' ||
        run.operational_state !== 'healthy' ||
        run.root_scope_id !== input.rootScopeId ||
        run.root_close_request_id !== input.closeRequestId ||
        run.row_version !== input.expectedSourceRunRowVersion ||
        root.lifecycle !== 'closing' ||
        root.close_request_id !== input.closeRequestId ||
        root.row_version !== input.expectedRootScopeRowVersion ||
        activation.status !== 'active' ||
        activation.row_version !== input.expectedSourceActivationRowVersion
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T8 Workflow, Run, Scope, or Activation authority is stale',
        );
      const descendant = transaction.queryOne<{ id: string }>(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM workflow_graph_scopes WHERE parent_scope_id = ?
           UNION ALL
           SELECT child.id FROM workflow_graph_scopes child
           JOIN subtree parent ON child.parent_scope_id = parent.id
         ) SELECT s.id FROM subtree tree
           JOIN workflow_graph_scopes s ON s.id = tree.id
          WHERE s.lifecycle <> 'closed' LIMIT 1`,
        [input.rootScopeId],
      );
      const unsettledCompensation = transaction.queryOne<{ id: string }>(
        `SELECT id FROM workflow_graph_effect_operations
          WHERE graph_run_id = ? AND execution_lane = 'close_cleanup'
            AND status NOT IN ('compensated','compensation_not_required')
          LIMIT 1`,
        [input.sourceRunId],
      );
      if (descendant || unsettledCompensation)
        throw new G5RuntimeError(
          'precondition_failed',
          'T8 requires closed descendants and successful compensation',
        );
      const cut = rootCutAuthority(transaction, input);
      const expectedRootCancelScope =
        cut.cancelReason === 'workflow_cancel'
          ? 'workflow'
          : cut.cancelReason === 'local_cancel'
            ? 'local_graph'
            : null;
      if (run.root_cancel_scope !== expectedRootCancelScope)
        throw new G5RuntimeError(
          'integrity_violation',
          'T8 root outcome does not match the frozen Run cancel scope',
        );
      const route = loadTransitionAuthority(transaction, input, cut);
      assertTransitionEffectIntent(transaction, input, route.effects);
      const cutSequence = run.next_event_seq + 1;
      const completionCutId = stableRuntimeId('completion-cut', {
        graph_run_id: input.sourceRunId,
        scope_id: input.rootScopeId,
        close_request_id: input.closeRequestId,
      });
      const cutPayload: JsonObject = {
        graph_run_id: input.sourceRunId,
        scope_id: input.rootScopeId,
        close_request_id: input.closeRequestId,
        selected_rule_id: cut.selectedRuleId,
        candidate_id: cut.candidateId,
        outcome_kind: cut.outcomeKind,
        exit_name: cut.exitName,
        output_hash: cut.output?.hash ?? null,
        completion_policy_hash: cut.completionPolicyHash,
        cut_event_seq: cutSequence,
      };
      const cutHash = runtimeObjectHash('completion-cut', cutPayload);
      insertGraphEvent(transaction, {
        graphRunId: input.sourceRunId,
        sequence: cutSequence,
        scopeId: input.rootScopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'completion_cut_committed',
        idempotencyKey: `root-cut:${input.closeRequestId}`,
        payloadJson: cutPayload,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_completion_cuts (
           id, graph_run_id, scope_id, close_request_id, selected_rule_id,
           candidate_id, outcome_kind, exit_name, output_value_id, output_hash,
           completion_policy_hash, cut_event_seq, cut_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          completionCutId,
          input.sourceRunId,
          input.rootScopeId,
          input.closeRequestId,
          cut.selectedRuleId,
          cut.candidateId,
          cut.outcomeKind,
          cut.exitName,
          cut.output?.id ?? null,
          cut.output?.hash ?? null,
          cut.completionPolicyHash,
          cutSequence,
          cutHash,
          input.nowMs,
        ],
      );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_state_activations
              SET status = 'completed', finished_at_ms = ?,
                  row_version = row_version + 1
            WHERE id = ? AND row_version = ? AND status = 'active'`,
          [
            input.nowMs,
            input.sourceActivationId,
            input.expectedSourceActivationRowVersion,
          ],
        ).changes,
        'T8 source Activation',
      );
      const workflowRevision = workflow.workflow_revision + 1;
      const context = persistContextRevision(
        transaction,
        input,
        completionCutId,
        workflowRevision,
      );
      const childResults = input.requiredChildren.map((child) =>
        createRequiredChild(transaction, input, child, completionCutId),
      );
      for (const item of input.bestEffortOutbox)
        insertBestEffortOutbox(transaction, input, item);
      const transitionHistoryId = stableRuntimeId('transition', {
        workflow_id: input.workflowId,
        source_state_instance_id: input.sourceActivationId,
        completion_cut_id: completionCutId,
      });
      let targetActivation: T1ActivationReceipt | null = null;
      let targetActivationId: string | null = null;
      let targetRunId: string | null = null;
      let terminalActivationCount = workflow.state_activation_count;
      if (input.target.kind === 'nonterminal') {
        const current = transaction.queryOne<{ row_version: number }>(
          'SELECT row_version FROM workflows WHERE id = ?',
          [input.workflowId],
        )!;
        targetActivation = activateWorkflowT1InTransaction(
          transaction,
          {
            ...input.target.activation,
            workflowId: input.workflowId,
            expectedWorkflowRowVersion: current.row_version,
            stateKey: input.target.stateKey,
          },
          { writeInitialCheckpoint: false },
        );
        targetActivationId = targetActivation.activationId;
        targetRunId = targetActivation.graphRunId;
      } else if (input.target.kind === 'terminal') {
        if (
          (cut.outcomeKind === 'completed' &&
            (input.target.terminalKind !== 'normal' ||
              input.target.output === null ||
              input.target.outputSchemaHash === null ||
              input.target.errorCode !== null ||
              input.target.errorDetail !== null)) ||
          (cut.outcomeKind === 'errored' &&
            (input.target.terminalKind !== 'errored' ||
              input.target.output !== null ||
              input.target.outputSchemaHash !== null ||
              input.target.errorCode !== cut.errorCode))
        )
          throw new G5RuntimeError(
            'contract_invalid',
            'T8 terminal Activation outcome shape is invalid',
          );
        if (input.target.output)
          assertStoredValue(
            transaction,
            input.target.output,
            'Terminal output',
          );
        if (input.target.errorDetail)
          assertStoredValue(
            transaction,
            input.target.errorDetail,
            'Terminal error detail',
          );
        assertExactPublishedRegistryResource(
          transaction,
          input.target.definition,
          'T8 terminal Definition',
        );
        terminalActivationCount += 1;
        targetActivationId = stableRuntimeId('activation', {
          workflow_id: input.workflowId,
          activation_no: terminalActivationCount,
        });
        transaction.execute(
          `INSERT INTO workflow_state_activations (
             id, workflow_id, state_key, state_type, activation_no,
             workflow_definition_resource_id,
             workflow_definition_resource_hash, workflow_definition_version,
             state_config_value_id, state_config_hash, status, graph_run_id,
             entered_via_transition_id, terminal_kind,
             terminal_output_value_id, terminal_output_hash,
             terminal_output_schema_hash, terminal_error_code,
             terminal_error_detail_value_id, terminal_error_detail_hash,
             started_at_ms, finished_at_ms, row_version
           ) VALUES (?, ?, ?, 'terminal', ?, ?, ?, ?, ?, ?, 'completed', NULL,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            targetActivationId,
            input.workflowId,
            input.target.stateKey,
            terminalActivationCount,
            input.target.definition.rowId,
            input.target.definition.hash,
            input.target.definitionVersion,
            input.target.stateConfig.id,
            input.target.stateConfig.hash,
            transitionHistoryId,
            input.target.terminalKind,
            input.target.output?.id ?? null,
            input.target.output?.hash ?? null,
            input.target.outputSchemaHash,
            input.target.errorCode,
            input.target.errorDetail?.id ?? null,
            input.target.errorDetail?.hash ?? null,
            input.nowMs,
            input.nowMs,
          ],
        );
        chargeWorkflowLifetimeResources(transaction, {
          graphRunId: input.sourceRunId,
          workflowId: input.workflowId,
          reservationGroupId: stableRuntimeId('reservation-group', {
            graph_run_id: input.sourceRunId,
            activation_id: targetActivationId,
            purpose: 'terminal_activation',
          }),
          amounts: { state_activations_total: 1 },
          purpose: 'terminal_activation',
          nowMs: input.nowMs,
        });
      }
      transaction.execute(
        `INSERT INTO workflow_state_transition_history (
           id, workflow_id, source_state_instance_id, source_run_id,
           completion_cut_id, target_state_key, target_state_instance_id,
           target_run_id, workflow_revision, context_patch_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transitionHistoryId,
          input.workflowId,
          input.sourceActivationId,
          input.sourceRunId,
          completionCutId,
          input.target.kind === 'global_cancel' ? null : input.target.stateKey,
          targetActivationId,
          targetRunId,
          workflowRevision,
          context.patchHash,
          input.nowMs,
        ],
      );
      if (input.target.kind === 'nonterminal')
        requireSingleChange(
          transaction.execute(
            `UPDATE workflow_state_activations
                SET entered_via_transition_id = ?
              WHERE id = ? AND entered_via_transition_id IS NULL`,
            [transitionHistoryId, targetActivationId],
          ).changes,
          'T8 target Activation transition',
        );
      const checkpointVersion = transaction.queryOne<{ value: number }>(
        `SELECT coalesce(max(checkpoint_version), 0) + 1 AS value
             FROM workflow_checkpoints WHERE workflow_id = ?`,
        [input.workflowId],
      )!.value;
      const checkpointId = stableRuntimeId('checkpoint', {
        workflow_id: input.workflowId,
        checkpoint_version: checkpointVersion,
      });
      const checkpointPayload: JsonObject = {
        completed: {
          state_instance_id: input.sourceActivationId,
          run_id: input.sourceRunId,
          root_scope_id: input.rootScopeId,
          completion_cut_id: completionCutId,
          work_fence_epoch: run.work_fence_epoch,
          row_version: input.expectedSourceRunRowVersion + 1,
          completed_at_ms: input.nowMs,
        },
        current:
          targetRunId === null
            ? null
            : {
                state_instance_id: targetActivationId,
                run_id: targetRunId,
                root_scope_id: targetActivation!.rootScopeId,
                root_build_id: targetActivation!.rootBuildId,
                row_version: 1,
                started_at_ms: input.nowMs,
              },
      };
      transaction.execute(
        `INSERT INTO workflow_checkpoints (
           id, workflow_id, checkpoint_version, workflow_revision,
           source_state_instance_id, source_run_id, completion_cut_id,
           snapshot_json, snapshot_value_id, snapshot_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          checkpointId,
          input.workflowId,
          checkpointVersion,
          workflowRevision,
          input.sourceActivationId,
          input.sourceRunId,
          completionCutId,
          canonicalJson(checkpointPayload),
          runtimeObjectHash('checkpoint', checkpointPayload),
          input.nowMs,
        ],
      );
      const runAfterLedger = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [input.sourceRunId],
      )!;
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_scopes
              SET lifecycle = 'closed', outcome_kind = ?, exit_name = ?,
                  candidate_node_id = ?, output_value_id = ?, output_hash = ?,
                  error_code = ?, error_detail_value_id = ?,
                  error_detail_hash = ?, completion_cut_id = ?,
                  finished_at_ms = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND lifecycle = 'closing'
              AND close_request_id = ?`,
          [
            cut.outcomeKind,
            cut.exitName,
            cut.candidateId,
            cut.output?.id ?? null,
            cut.output?.hash ?? null,
            cut.errorCode,
            cut.errorDetail?.id ?? null,
            cut.errorDetail?.hash ?? null,
            completionCutId,
            input.nowMs,
            input.nowMs,
            input.rootScopeId,
            input.expectedRootScopeRowVersion,
            input.closeRequestId,
          ],
        ).changes,
        'T8 root Scope Cut',
      );
      requireSingleChange(
        transaction.execute(
          `UPDATE workflow_graph_runs
              SET lifecycle = 'closed', completion_cut_id = ?,
                  outcome_kind = ?, exit_name = ?, output_value_id = ?,
                  output_hash = ?, error_code = ?, error_detail_value_id = ?,
                  error_detail_hash = ?, next_event_seq = ?, finished_at_ms = ?,
                  row_version = row_version + 1, updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND lifecycle = 'closing'
              AND root_close_request_id = ?`,
          [
            completionCutId,
            cut.outcomeKind,
            cut.exitName,
            cut.output?.id ?? null,
            cut.output?.hash ?? null,
            cut.errorCode,
            cut.errorDetail?.id ?? null,
            cut.errorDetail?.hash ?? null,
            cutSequence,
            input.nowMs,
            input.nowMs,
            input.sourceRunId,
            runAfterLedger.row_version,
            input.closeRequestId,
          ],
        ).changes,
        'T8 source Run Cut',
      );
      const workflowAfterTarget = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflows WHERE id = ?',
        [input.workflowId],
      )!;
      const terminalStatus =
        input.target.kind === 'global_cancel'
          ? 'cancelled'
          : input.target.kind === 'terminal'
            ? input.target.terminalKind === 'normal'
              ? 'completed'
              : 'errored'
            : 'active';
      requireSingleChange(
        transaction.execute(
          `UPDATE workflows
              SET status = ?, state_instance_id = ?, current_graph_run_id = ?,
                  current_context_snapshot_id = ?,
                  current_context_snapshot_hash = ?, workflow_revision = ?,
                  state_transition_count = state_transition_count + 1,
                  state_activation_count = ?,
                  child_workflow_count = child_workflow_count + ?,
                  final_outcome_kind = ?, final_output_value_id = ?,
                  final_output_hash = ?, final_output_schema_hash = ?,
                  final_error_code = ?, final_error_detail_value_id = ?,
                  final_error_detail_hash = ?, final_cancel_reason = ?,
                  finished_at_ms = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ?`,
          [
            terminalStatus,
            targetActivationId ?? input.sourceActivationId,
            targetRunId,
            context.snapshotId,
            context.snapshotHash,
            workflowRevision,
            input.target.kind === 'terminal'
              ? terminalActivationCount
              : input.target.kind === 'nonterminal'
                ? workflow.state_activation_count + 1
                : workflow.state_activation_count,
            childResults.length,
            terminalStatus === 'completed'
              ? 'normal'
              : terminalStatus === 'errored'
                ? 'errored'
                : terminalStatus === 'cancelled'
                  ? 'cancelled'
                  : null,
            input.target.kind === 'terminal'
              ? (input.target.output?.id ?? null)
              : null,
            input.target.kind === 'terminal'
              ? (input.target.output?.hash ?? null)
              : null,
            input.target.kind === 'terminal'
              ? input.target.outputSchemaHash
              : null,
            terminalStatus === 'errored'
              ? input.target.kind === 'terminal'
                ? input.target.errorCode
                : cut.errorCode
              : null,
            terminalStatus === 'errored' && input.target.kind === 'terminal'
              ? (input.target.errorDetail?.id ?? null)
              : null,
            terminalStatus === 'errored' && input.target.kind === 'terminal'
              ? (input.target.errorDetail?.hash ?? null)
              : null,
            terminalStatus === 'cancelled' ? cut.cancelReason : null,
            terminalStatus === 'active' ? null : input.nowMs,
            input.nowMs,
            input.workflowId,
            workflowAfterTarget.row_version,
          ],
        ).changes,
        'T8 Workflow transition',
      );
      appendRootFinalizationEvent(transaction, {
        graphRunId: input.sourceRunId,
        scheduleId: input.closeRequestId,
        status: 'committed',
        nowMs: input.nowMs,
        suffix: 't8',
      });
      assertNoDeferredForeignKeyViolations(transaction, 'T8 root commit');
      return {
        disposition: 'committed',
        completionCutId,
        transitionHistoryId,
        checkpointId,
        targetActivation,
        childWorkflowIds: childResults.map((result) => result.childWorkflowId),
      };
    },
    fault,
  );
}
