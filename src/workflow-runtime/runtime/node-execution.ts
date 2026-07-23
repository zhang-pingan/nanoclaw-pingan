import type { RuntimeValueRef } from '../contracts/g5-basic-runtime-types.js';
import type { Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertGraphEvent,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import {
  chargeAndInsertGraphFact,
  releaseLedgerReservationGroup,
  reserveLedgerResources,
} from './ledger.js';

export interface T6aResultInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly expectedAttemptRowVersion: number;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly executionOutcome: 'succeeded' | 'failed' | 'cancelled';
  readonly qualityDecision: 'pass' | 'needs_revision' | 'fail' | null;
  readonly result: RuntimeValueRef | null;
  readonly evaluation: RuntimeValueRef | null;
  readonly feedback: RuntimeValueRef | null;
  readonly errorCode: string | null;
  readonly retry: {
    readonly continuationKind: 'execution_retry' | 'quality_revision';
    readonly reasonCode: string;
    readonly retryPolicyHash: Sha256Hash;
    readonly backoffMs: number;
    readonly eligibleAtMs: number;
    readonly maxAttempts: number;
  } | null;
  readonly factPayload: RuntimeValueRef;
  readonly nowMs: number;
}

export interface T6aResultReceipt {
  readonly disposition: 'terminal' | 'retry_scheduled' | 'exact_replay';
  readonly retryScheduleId: string | null;
  readonly eventSequence: number;
}

export function acceptInternalResultT6a(
  store: WorkflowRuntimeStore,
  input: T6aResultInput,
  fault?: G5TransactionFault,
): T6aResultReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const attempt = transaction.queryOne<{
        attempt_no: number;
        continuation_kind: 'initial' | 'execution_retry' | 'quality_revision';
        phase: string;
        acceptance_state: string;
        execution_outcome: string | null;
        quality_decision: string | null;
        result_value_id: string | null;
        result_hash: string | null;
        evaluation_value_id: string | null;
        evaluation_hash: string | null;
        quality_revision_feedback_value_id: string | null;
        quality_revision_feedback_hash: string | null;
        retry_reason_code: string | null;
        error_code: string | null;
        resource_reservation_group_id: string;
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        lease_owner: string | null;
        lease_token: string | null;
        row_version: number;
      }>(
        'SELECT attempt_no, continuation_kind, phase, acceptance_state, execution_outcome, quality_decision, result_value_id, result_hash, evaluation_value_id, evaluation_hash, quality_revision_feedback_value_id, quality_revision_feedback_hash, retry_reason_code, error_code, resource_reservation_group_id, run_work_fence_epoch, scope_work_fence_epoch, lease_owner, lease_token, row_version FROM workflow_graph_node_attempts WHERE id = ? AND graph_run_id = ? AND scope_id = ? AND node_id = ?',
        [input.attemptId, input.graphRunId, input.scopeId, input.nodeId],
      );
      if (!attempt)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6a attempt is missing',
        );
      if (attempt.phase === 'terminal') {
        const expectedQuality =
          input.qualityDecision ??
          (input.executionOutcome === 'succeeded' ? 'pass' : null);
        const expectedFeedback =
          input.qualityDecision === 'needs_revision'
            ? input.feedback
            : attempt.continuation_kind === 'quality_revision'
              ? {
                  id: attempt.quality_revision_feedback_value_id,
                  hash: attempt.quality_revision_feedback_hash,
                }
              : null;
        const expectedErrorCode =
          input.qualityDecision === 'needs_revision' &&
          (!input.retry || attempt.attempt_no >= input.retry.maxAttempts)
            ? 'quality_revision_exhausted'
            : input.qualityDecision === 'fail'
              ? 'quality_rejected'
              : input.errorCode;
        if (
          attempt.execution_outcome !== input.executionOutcome ||
          attempt.quality_decision !== expectedQuality ||
          attempt.result_value_id !== (input.result?.id ?? null) ||
          attempt.result_hash !== (input.result?.hash ?? null) ||
          attempt.evaluation_value_id !== (input.evaluation?.id ?? null) ||
          attempt.evaluation_hash !== (input.evaluation?.hash ?? null) ||
          attempt.quality_revision_feedback_value_id !==
            (expectedFeedback?.id ?? null) ||
          attempt.quality_revision_feedback_hash !==
            (expectedFeedback?.hash ?? null) ||
          attempt.retry_reason_code !== (input.retry?.reasonCode ?? null) ||
          attempt.error_code !== expectedErrorCode
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T6a duplicate result bytes drifted',
          );
        const event = transaction.queryOne<{ seq: number }>(
          'SELECT seq FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = ?',
          [input.graphRunId, `attempt-result:${input.attemptId}`],
        );
        const retrySchedule = transaction.queryOne<{ id: string }>(
          'SELECT id FROM workflow_graph_retry_schedules WHERE source_attempt_id = ?',
          [input.attemptId],
        );
        return {
          disposition: 'exact_replay',
          retryScheduleId: retrySchedule?.id ?? null,
          eventSequence: event?.seq ?? 0,
        };
      }
      if (
        attempt.acceptance_state !== 'open' ||
        attempt.row_version !== input.expectedAttemptRowVersion ||
        attempt.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        attempt.scope_work_fence_epoch !== input.expectedScopeWorkFenceEpoch ||
        attempt.lease_owner !== input.leaseOwner ||
        attempt.lease_token !== input.leaseToken ||
        !['running', 'evaluating', 'dispatch_pending'].includes(attempt.phase)
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6a acceptance, lease, epoch, or row version is stale',
        );
      if (input.executionOutcome === 'succeeded' && !input.result)
        throw new G5RuntimeError(
          'contract_invalid',
          'Successful T6a result requires immutable result bytes',
        );
      if (input.qualityDecision === 'needs_revision' && !input.feedback)
        throw new G5RuntimeError(
          'contract_invalid',
          'Quality revision requires validated feedback',
        );
      if (input.qualityDecision !== 'needs_revision' && input.feedback)
        throw new G5RuntimeError(
          'contract_invalid',
          'Feedback is only valid for quality revision',
        );
      const persistedFeedback =
        input.qualityDecision === 'needs_revision'
          ? input.feedback
          : attempt.continuation_kind === 'quality_revision'
            ? {
                id: attempt.quality_revision_feedback_value_id!,
                hash: attempt.quality_revision_feedback_hash as Sha256Hash,
              }
            : null;
      if (
        attempt.continuation_kind === 'quality_revision' &&
        (!attempt.quality_revision_feedback_value_id ||
          !attempt.quality_revision_feedback_hash)
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'Quality revision successor lost its durable feedback',
        );
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      if (!run)
        throw new G5RuntimeError('precondition_failed', 'T6a Run is missing');
      let retryScheduleId: string | null = null;
      let disposition: T6aResultReceipt['disposition'] = 'terminal';
      const shouldRetry =
        input.retry !== null && attempt.attempt_no < input.retry.maxAttempts;
      if (shouldRetry) {
        const retry = input.retry!;
        if (
          retry.continuationKind === 'quality_revision' &&
          input.qualityDecision !== 'needs_revision'
        )
          throw new G5RuntimeError(
            'contract_invalid',
            'Quality retry requires needs_revision',
          );
        if (
          retry.continuationKind === 'execution_retry' &&
          input.qualityDecision === 'needs_revision'
        )
          throw new G5RuntimeError(
            'contract_invalid',
            'Execution retry cannot carry quality revision',
          );
        retryScheduleId = stableRuntimeId('retry-schedule', {
          source_attempt_id: input.attemptId,
          next_attempt_no: attempt.attempt_no + 1,
        });
        const reservationGroupId = stableRuntimeId('reservation-group', {
          retry_schedule_id: retryScheduleId,
        });
        const [reservationId] = reserveLedgerResources(transaction, {
          graphRunId: input.graphRunId,
          reservationGroupId,
          consumer: { attemptId: input.attemptId },
          amounts: { attempts_total: 1 },
          purpose: 'retry_attempt',
          settlementMode: 'consume_on_create',
          nowMs: input.nowMs,
        });
        transaction.execute(
          `INSERT INTO workflow_graph_retry_schedules (
         id, graph_run_id, scope_id, node_id, source_attempt_id,
         source_attempt_no, next_attempt_no, continuation_kind,
         quality_revision_feedback_value_id, quality_revision_feedback_hash,
         retry_reason_code, retry_policy_hash, backoff_ms, eligible_at_ms,
         attempt_reservation_id, status, row_version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?)`,
          [
            retryScheduleId,
            input.graphRunId,
            input.scopeId,
            input.nodeId,
            input.attemptId,
            attempt.attempt_no,
            attempt.attempt_no + 1,
            retry.continuationKind,
            input.feedback?.id ?? null,
            input.feedback?.hash ?? null,
            retry.reasonCode,
            retry.retryPolicyHash,
            retry.backoffMs,
            retry.eligibleAtMs,
            reservationId,
            input.nowMs,
            input.nowMs,
          ],
        );
        disposition = 'retry_scheduled';
      }
      const terminalQuality =
        input.qualityDecision ??
        (input.executionOutcome === 'succeeded' ? 'pass' : null);
      const terminalErrorCode =
        disposition === 'terminal' && input.qualityDecision === 'needs_revision'
          ? 'quality_revision_exhausted'
          : disposition === 'terminal' && input.qualityDecision === 'fail'
            ? 'quality_rejected'
            : input.errorCode;
      const changedAttempt = transaction.execute(
        `UPDATE workflow_graph_node_attempts
          SET phase = 'terminal', execution_outcome = ?, quality_decision = ?,
              result_value_id = ?, result_hash = ?, evaluation_value_id = ?,
              evaluation_hash = ?, quality_revision_feedback_value_id = ?,
              quality_revision_feedback_hash = ?, retry_reason_code = ?,
              error_code = ?, acceptance_state = 'fenced', lease_owner = NULL,
              lease_token = NULL, lease_expires_at_ms = NULL,
              evaluation_lease_owner = NULL, evaluation_lease_token = NULL,
              evaluation_lease_expires_at_ms = NULL,
              row_version = row_version + 1, updated_at_ms = ?, finished_at_ms = ?
        WHERE id = ? AND row_version = ? AND acceptance_state = 'open'
          AND run_work_fence_epoch = ? AND scope_work_fence_epoch = ?`,
        [
          input.executionOutcome,
          terminalQuality,
          input.result?.id ?? null,
          input.result?.hash ?? null,
          input.evaluation?.id ?? null,
          input.evaluation?.hash ?? null,
          persistedFeedback?.id ?? null,
          persistedFeedback?.hash ?? null,
          input.retry?.reasonCode ?? null,
          terminalErrorCode,
          input.nowMs,
          input.nowMs,
          input.attemptId,
          input.expectedAttemptRowVersion,
          input.expectedRunWorkFenceEpoch,
          input.expectedScopeWorkFenceEpoch,
        ],
      ).changes;
      if (changedAttempt !== 1)
        throw new G5RuntimeError('cas_conflict', 'T6a attempt CAS failed');
      releaseLedgerReservationGroup(
        transaction,
        input.graphRunId,
        attempt.resource_reservation_group_id,
        input.nowMs,
      );
      const terminalSuccess =
        disposition === 'terminal' &&
        input.executionOutcome === 'succeeded' &&
        terminalQuality === 'pass';
      if (disposition === 'retry_scheduled') {
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'retry_wait', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND current_attempt_id = ?",
            [input.nowMs, input.nodeId, input.attemptId],
          ).changes !== 1
        )
          throw new G5RuntimeError('cas_conflict', 'T6a Node retry CAS failed');
      } else {
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'terminal', terminal_status = ?, terminal_code = ?, published_output_envelope_value_id = ?, published_output_envelope_hash = ?, terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND current_attempt_id = ?",
            [
              terminalSuccess
                ? 'succeeded'
                : input.executionOutcome === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
              terminalErrorCode,
              terminalSuccess ? (input.result?.id ?? null) : null,
              terminalSuccess ? (input.result?.hash ?? null) : null,
              input.nowMs,
              input.nowMs,
              input.nodeId,
              input.attemptId,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T6a Node terminal CAS failed',
          );
      }
      let sequence = run.next_event_seq + 1;
      if (retryScheduleId) {
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: input.nodeId,
          attemptId: input.attemptId,
          eventType: 'retry_schedule_created',
          idempotencyKey: `retry-schedule:${retryScheduleId}`,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        sequence += 1;
      }
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: input.scopeId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        eventType:
          disposition === 'retry_scheduled'
            ? 'orchestration_error'
            : 'node_terminal',
        idempotencyKey: `attempt-result:${input.attemptId}`,
        payloadValueId: input.factPayload.id,
        payloadHash: input.factPayload.hash,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      chargeAndInsertGraphFact(transaction, {
        id: stableRuntimeId('fact', {
          graph_run_id: input.graphRunId,
          fact_key: `attempt-result:${input.attemptId}`,
        }),
        graphRunId: input.graphRunId,
        scopeId: input.scopeId,
        eventSeq: sequence,
        causalEventSeq: sequence,
        causalWave: 0,
        factKind:
          disposition === 'retry_scheduled'
            ? 'orchestration_error'
            : 'node_terminal',
        stableObjectKind: 'attempt',
        stableObjectId: input.attemptId,
        factKey: `attempt-result:${input.attemptId}`,
        payloadValueId: input.factPayload.id,
        payloadHash: input.factPayload.hash,
        createdAtMs: input.nowMs,
      });
      const refreshed = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [sequence, input.nowMs, input.graphRunId, refreshed.row_version],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6a event head CAS failed');
      return { disposition, retryScheduleId, eventSequence: sequence };
    },
    fault,
  );
}

export interface T6bCallbackInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly delegationId: string;
  readonly externalExecutionId: string;
  readonly providerEventId: string;
  readonly result: RuntimeValueRef;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly nowMs: number;
}

export function acceptDelegationCallbackT6b(
  store: WorkflowRuntimeStore,
  input: T6bCallbackInput,
  fault?: G5TransactionFault,
): 'accepted' | 'duplicate' | 'late' | 'conflict' {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const attempt = transaction.queryOne<{
        delegation_id: string | null;
        external_execution_id: string | null;
        acceptance_state: string;
        result_value_id: string | null;
        result_hash: string | null;
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT delegation_id, external_execution_id, acceptance_state, result_value_id, result_hash, run_work_fence_epoch, scope_work_fence_epoch, row_version FROM workflow_graph_node_attempts WHERE id = ? AND graph_run_id = ?',
        [input.attemptId, input.graphRunId],
      );
      if (!attempt)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6b attempt is missing',
        );
      const identityMatches =
        (attempt.delegation_id === null ||
          attempt.delegation_id === input.delegationId) &&
        (attempt.external_execution_id === null ||
          attempt.external_execution_id === input.externalExecutionId);
      if (attempt.result_value_id !== null) {
        if (
          identityMatches &&
          attempt.result_value_id === input.result.id &&
          attempt.result_hash === input.result.hash
        )
          return 'duplicate';
        const lateId = stableRuntimeId('late-result', {
          attempt_id: input.attemptId,
          provider_event_id: input.providerEventId,
        });
        const priorLate = transaction.queryOne<{
          payload_value_id: string;
          payload_hash: string;
          fence_reason: string;
        }>(
          'SELECT payload_value_id, payload_hash, fence_reason FROM workflow_graph_late_results WHERE id = ?',
          [lateId],
        );
        const fenceReason = identityMatches
          ? 'result_already_accepted'
          : 'execution_identity_conflict';
        if (priorLate) {
          if (
            priorLate.payload_value_id !== input.result.id ||
            priorLate.payload_hash !== input.result.hash ||
            priorLate.fence_reason !== fenceReason
          )
            throw new G5RuntimeError(
              'integrity_violation',
              'T6b provider event replay drifted',
            );
        } else
          transaction.execute(
            'INSERT INTO workflow_graph_late_results (id, graph_run_id, scope_id, node_id, attempt_id, wait_id, source_event_id, payload_value_id, payload_hash, fence_reason, received_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
            [
              lateId,
              input.graphRunId,
              input.scopeId,
              input.nodeId,
              input.attemptId,
              input.providerEventId,
              input.result.id,
              input.result.hash,
              fenceReason,
              input.nowMs,
            ],
          );
        return 'conflict';
      }
      const open =
        attempt.acceptance_state === 'open' &&
        attempt.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
        attempt.scope_work_fence_epoch === input.expectedScopeWorkFenceEpoch;
      if (!identityMatches || !open) {
        transaction.execute(
          'INSERT INTO workflow_graph_late_results (id, graph_run_id, scope_id, node_id, attempt_id, wait_id, source_event_id, payload_value_id, payload_hash, fence_reason, received_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
          [
            stableRuntimeId('late-result', {
              attempt_id: input.attemptId,
              provider_event_id: input.providerEventId,
            }),
            input.graphRunId,
            input.scopeId,
            input.nodeId,
            input.attemptId,
            input.providerEventId,
            input.result.id,
            input.result.hash,
            identityMatches
              ? 'acceptance_fenced'
              : 'execution_identity_conflict',
            input.nowMs,
          ],
        );
        return identityMatches ? 'late' : 'conflict';
      }
      const changed = transaction.execute(
        "UPDATE workflow_graph_node_attempts SET delegation_id = ?, external_execution_id = ?, result_value_id = ?, result_hash = ?, phase = 'evaluating', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND acceptance_state = 'open'",
        [
          input.delegationId,
          input.externalExecutionId,
          input.result.id,
          input.result.hash,
          input.nowMs,
          input.attemptId,
          attempt.row_version,
        ],
      ).changes;
      if (changed !== 1)
        throw new G5RuntimeError('cas_conflict', 'T6b callback CAS failed');
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      const sequence = run.next_event_seq + 1;
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: input.scopeId,
        nodeId: input.nodeId,
        attemptId: input.attemptId,
        eventType: 'attempt_phase_changed',
        idempotencyKey: `delegation-callback:${input.providerEventId}`,
        payloadValueId: input.result.id,
        payloadHash: input.result.hash,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [sequence, input.nowMs, input.graphRunId, run.row_version],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6b event head CAS failed');
      return 'accepted';
    },
    fault,
  );
}

export interface T6dConsumeInput {
  readonly retryScheduleId: string;
  readonly expectedScheduleRowVersion: number;
  readonly automaticTimer: true;
  readonly nowMs: number;
}

export function consumeRetryScheduleT6d(
  store: WorkflowRuntimeStore,
  input: T6dConsumeInput,
  fault?: G5TransactionFault,
): { disposition: 'consumed' | 'duplicate_timer'; attemptId: string } {
  if (input.automaticTimer !== true)
    throw new G5RuntimeError(
      'forbidden_surface',
      'G5 does not authorize manual retry',
    );
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const schedule = transaction.queryOne<{
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        source_attempt_id: string;
        source_attempt_no: number;
        next_attempt_no: number;
        continuation_kind: 'execution_retry' | 'quality_revision';
        quality_revision_feedback_value_id: string | null;
        quality_revision_feedback_hash: string | null;
        eligible_at_ms: number;
        attempt_reservation_id: string;
        status: string;
        row_version: number;
      }>(
        'SELECT graph_run_id, scope_id, node_id, source_attempt_id, source_attempt_no, next_attempt_no, continuation_kind, quality_revision_feedback_value_id, quality_revision_feedback_hash, eligible_at_ms, attempt_reservation_id, status, row_version FROM workflow_graph_retry_schedules WHERE id = ?',
        [input.retryScheduleId],
      );
      if (!schedule)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6d retry schedule is missing',
        );
      const attemptId = stableRuntimeId('attempt', {
        graph_run_id: schedule.graph_run_id,
        node_id: schedule.node_id,
        attempt_no: schedule.next_attempt_no,
      });
      if (schedule.status === 'consumed')
        return { disposition: 'duplicate_timer', attemptId };
      if (
        schedule.status !== 'scheduled' ||
        schedule.row_version !== input.expectedScheduleRowVersion ||
        schedule.eligible_at_ms > input.nowMs
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6d retry schedule is stale or not due',
        );
      const source = transaction.queryOne<{
        input_snapshot_json: string | null;
        input_snapshot_value_id: string | null;
        input_snapshot_hash: string | null;
        selected_edges_json: string;
        context_pack_value_id: string;
        context_pack_hash: string;
        action_name: string | null;
        query_id: string | null;
      }>(
        'SELECT input_snapshot_json, input_snapshot_value_id, input_snapshot_hash, selected_edges_json, context_pack_value_id, context_pack_hash, action_name, query_id FROM workflow_graph_node_attempts WHERE id = ?',
        [schedule.source_attempt_id],
      );
      const reservation = transaction.queryOne<{
        reservation_group_id: string;
      }>(
        'SELECT reservation_group_id FROM workflow_graph_resource_reservations WHERE id = ?',
        [schedule.attempt_reservation_id],
      );
      const run = transaction.queryOne<{
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT control, operational_state, work_fence_epoch, next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [schedule.graph_run_id],
      );
      const scope = transaction.queryOne<{
        work_fence_epoch: number;
        lifecycle: string;
      }>(
        'SELECT work_fence_epoch, lifecycle FROM workflow_graph_scopes WHERE id = ?',
        [schedule.scope_id],
      );
      if (
        !source ||
        !reservation ||
        !run ||
        !scope ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        scope.lifecycle !== 'active'
      )
        throw new G5RuntimeError(
          'precondition_failed',
          'T6d run/scope/source is not executable',
        );
      reserveLedgerResources(transaction, {
        graphRunId: schedule.graph_run_id,
        reservationGroupId: reservation.reservation_group_id,
        consumer: { attemptId },
        amounts: { active_executions: 1 },
        purpose: 'scheduler_admission',
        settlementMode: 'hold_then_release',
        nowMs: input.nowMs,
      });
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', NULL, NULL, ?, ?, ?, ?, ?, ?,
       NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'open', ?, ?, ?,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 1, ?, ?, NULL)`,
        [
          attemptId,
          schedule.graph_run_id,
          schedule.scope_id,
          schedule.node_id,
          schedule.next_attempt_no,
          schedule.continuation_kind,
          schedule.source_attempt_id,
          schedule.source_attempt_no,
          source.input_snapshot_json ?? null,
          source.input_snapshot_value_id ?? null,
          source.input_snapshot_hash ?? null,
          source.selected_edges_json,
          source.context_pack_value_id,
          source.context_pack_hash,
          source.action_name ?? null,
          source.query_id ?? null,
          schedule.quality_revision_feedback_value_id,
          schedule.quality_revision_feedback_hash,
          run.work_fence_epoch,
          scope.work_fence_epoch,
          reservation.reservation_group_id,
          input.nowMs,
          input.nowMs,
        ],
      );
      if (
        transaction.execute(
          "UPDATE workflow_graph_retry_schedules SET status = 'consumed', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND status = 'scheduled'",
          [
            input.nowMs,
            input.retryScheduleId,
            input.expectedScheduleRowVersion,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6d schedule CAS failed');
      if (
        transaction.execute(
          "UPDATE workflow_graph_nodes SET phase = 'active', current_attempt_id = ?, current_attempt_no = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND phase = 'retry_wait' AND current_attempt_id = ?",
          [
            attemptId,
            schedule.next_attempt_no,
            input.nowMs,
            schedule.node_id,
            schedule.source_attempt_id,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6d Node retry CAS failed');
      const refreshedRun = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [schedule.graph_run_id],
      )!;
      const sequence = refreshedRun.next_event_seq + 1;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [
            sequence,
            input.nowMs,
            schedule.graph_run_id,
            refreshedRun.row_version,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6d event head CAS failed');
      insertGraphEvent(transaction, {
        graphRunId: schedule.graph_run_id,
        sequence,
        scopeId: schedule.scope_id,
        nodeId: schedule.node_id,
        attemptId,
        eventType: 'retry_schedule_consumed',
        idempotencyKey: `retry-consumed:${input.retryScheduleId}`,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      return { disposition: 'consumed', attemptId };
    },
    fault,
  );
}

export interface T6dWatchdogInput {
  readonly attemptId: string;
  readonly automaticTimer: true;
  readonly expectedAttemptRowVersion: number;
  readonly retry: Omit<
    NonNullable<T6aResultInput['retry']>,
    'continuationKind'
  > | null;
  readonly factPayload: RuntimeValueRef;
  readonly nowMs: number;
}

export function fireAttemptWatchdogT6d(
  store: WorkflowRuntimeStore,
  input: T6dWatchdogInput,
  fault?: G5TransactionFault,
): {
  disposition: 'timed_out' | 'duplicate_timer';
  retryScheduleId: string | null;
} {
  if (input.automaticTimer !== true)
    throw new G5RuntimeError(
      'forbidden_surface',
      'G5 watchdog accepts automatic timers only',
    );
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const attempt = transaction.queryOne<{
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        attempt_no: number;
        phase: string;
        acceptance_state: string;
        dispatch_deadline_at_ms: number | null;
        execution_deadline_at_ms: number | null;
        resource_reservation_group_id: string;
        row_version: number;
      }>(
        'SELECT graph_run_id, scope_id, node_id, attempt_no, phase, acceptance_state, dispatch_deadline_at_ms, execution_deadline_at_ms, resource_reservation_group_id, row_version FROM workflow_graph_node_attempts WHERE id = ?',
        [input.attemptId],
      );
      if (!attempt)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6d watchdog attempt is missing',
        );
      if (attempt.acceptance_state === 'fenced' || attempt.phase === 'terminal')
        return { disposition: 'duplicate_timer', retryScheduleId: null };
      const deadline =
        attempt.phase === 'dispatch_pending'
          ? attempt.dispatch_deadline_at_ms
          : attempt.execution_deadline_at_ms;
      if (
        attempt.row_version !== input.expectedAttemptRowVersion ||
        deadline === null ||
        deadline > input.nowMs
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6d watchdog is stale or not due',
        );
      const changedAttempt = transaction.execute(
        "UPDATE workflow_graph_node_attempts SET phase = 'terminal', execution_outcome = 'failed', quality_decision = NULL, acceptance_state = 'fenced', retry_reason_code = 'attempt_timeout', error_code = 'attempt_timeout', timeout_event_id = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, row_version = row_version + 1, updated_at_ms = ?, finished_at_ms = ? WHERE id = ? AND row_version = ? AND acceptance_state = 'open'",
        [
          input.nowMs,
          input.nowMs,
          input.attemptId,
          input.expectedAttemptRowVersion,
        ],
      ).changes;
      if (changedAttempt !== 1)
        throw new G5RuntimeError(
          'cas_conflict',
          'T6d watchdog Attempt CAS failed',
        );
      transaction.execute(
        "UPDATE workflow_outbox SET status = 'reconciling', lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, last_result_kind = 'timeout_fenced', updated_at_ms = ? WHERE effect_operation_id IN (SELECT id FROM workflow_graph_effect_operations WHERE attempt_id = ?) AND status IN ('pending', 'processing')",
        [input.nowMs, input.attemptId],
      );
      releaseLedgerReservationGroup(
        transaction,
        attempt.graph_run_id,
        attempt.resource_reservation_group_id,
        input.nowMs,
      );
      let retryScheduleId: string | null = null;
      if (input.retry && attempt.attempt_no < input.retry.maxAttempts) {
        retryScheduleId = stableRuntimeId('retry-schedule', {
          source_attempt_id: input.attemptId,
          next_attempt_no: attempt.attempt_no + 1,
        });
        const reservationGroupId = stableRuntimeId('reservation-group', {
          retry_schedule_id: retryScheduleId,
        });
        const [reservationId] = reserveLedgerResources(transaction, {
          graphRunId: attempt.graph_run_id,
          reservationGroupId,
          consumer: { attemptId: input.attemptId },
          amounts: { attempts_total: 1 },
          purpose: 'execution_retry',
          settlementMode: 'consume_on_create',
          nowMs: input.nowMs,
        });
        transaction.execute(
          "INSERT INTO workflow_graph_retry_schedules (id, graph_run_id, scope_id, node_id, source_attempt_id, source_attempt_no, next_attempt_no, continuation_kind, quality_revision_feedback_value_id, quality_revision_feedback_hash, retry_reason_code, retry_policy_hash, backoff_ms, eligible_at_ms, attempt_reservation_id, status, row_version, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'execution_retry', NULL, NULL, ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?)",
          [
            retryScheduleId,
            attempt.graph_run_id,
            attempt.scope_id,
            attempt.node_id,
            input.attemptId,
            attempt.attempt_no,
            attempt.attempt_no + 1,
            input.retry.reasonCode,
            input.retry.retryPolicyHash,
            input.retry.backoffMs,
            input.retry.eligibleAtMs,
            reservationId,
            input.nowMs,
            input.nowMs,
          ],
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'retry_wait', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND current_attempt_id = ?",
            [input.nowMs, attempt.node_id, input.attemptId],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T6d watchdog retry CAS failed',
          );
      } else {
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'terminal', terminal_status = 'failed', terminal_code = 'attempt_timeout', terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND current_attempt_id = ?",
            [input.nowMs, input.nowMs, attempt.node_id, input.attemptId],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T6d watchdog terminal CAS failed',
          );
      }
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [attempt.graph_run_id],
      )!;
      let sequence = run.next_event_seq + 1;
      if (retryScheduleId) {
        insertGraphEvent(transaction, {
          graphRunId: attempt.graph_run_id,
          sequence,
          scopeId: attempt.scope_id,
          nodeId: attempt.node_id,
          attemptId: input.attemptId,
          eventType: 'retry_schedule_created',
          idempotencyKey: `retry-schedule:${retryScheduleId}`,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        sequence += 1;
      }
      insertGraphEvent(transaction, {
        graphRunId: attempt.graph_run_id,
        sequence,
        scopeId: attempt.scope_id,
        nodeId: attempt.node_id,
        attemptId: input.attemptId,
        eventType: retryScheduleId ? 'orchestration_error' : 'node_terminal',
        idempotencyKey: `attempt-timeout:${input.attemptId}`,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      chargeAndInsertGraphFact(transaction, {
        id: stableRuntimeId('fact', {
          graph_run_id: attempt.graph_run_id,
          fact_key: `attempt-timeout:${input.attemptId}`,
        }),
        graphRunId: attempt.graph_run_id,
        scopeId: attempt.scope_id,
        eventSeq: sequence,
        causalEventSeq: sequence,
        causalWave: 0,
        factKind: retryScheduleId ? 'orchestration_error' : 'node_terminal',
        stableObjectKind: 'attempt',
        stableObjectId: input.attemptId,
        factKey: `attempt-timeout:${input.attemptId}`,
        payloadValueId: input.factPayload.id,
        payloadHash: input.factPayload.hash,
        createdAtMs: input.nowMs,
      });
      const refreshed = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [attempt.graph_run_id],
      )!;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [sequence, input.nowMs, attempt.graph_run_id, refreshed.row_version],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6d watchdog event head CAS failed',
        );
      return { disposition: 'timed_out', retryScheduleId };
    },
    fault,
  );
}
