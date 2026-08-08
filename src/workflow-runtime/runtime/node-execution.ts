import type { CapacitySnapshotWatcher } from '../capacity/publication.js';
import type { RuntimeValueRef } from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
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
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
} from './plan-authority.js';
import { persistNodeOutputEnvelope } from './generated-schema-runtime.js';

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
  readonly outputPorts: Readonly<Record<string, RuntimeValueRef | null>> | null;
  readonly evaluation: RuntimeValueRef | null;
  readonly feedback: RuntimeValueRef | null;
  readonly errorCode: string | null;
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
      const authority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
        input.nodeId,
      );
      if (
        authority.runWorkFenceEpoch !== input.expectedRunWorkFenceEpoch ||
        authority.scopeWorkFenceEpoch !== input.expectedScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6a current Run/Scope work epoch drifted',
        );
      const retryPolicy = requiredObjectField(
        authority.node,
        'effective_retry_policy',
        'Plan node',
      );
      const maxAttempts = Number(retryPolicy.effective_node_max_attempts);
      const retryOn = Array.isArray(retryPolicy.effective_retry_on)
        ? retryPolicy.effective_retry_on.map(String)
        : [];
      const qualityRevision =
        retryPolicy.quality_revision &&
        typeof retryPolicy.quality_revision === 'object' &&
        !Array.isArray(retryPolicy.quality_revision)
          ? (retryPolicy.quality_revision as JsonObject)
          : null;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
        throw new G5RuntimeError(
          'integrity_violation',
          'T6a Plan retry attempts are not finite',
        );
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
        const retryReason =
          input.qualityDecision === 'needs_revision' && qualityRevision
            ? 'quality_needs_revision'
            : input.executionOutcome === 'failed' &&
                input.errorCode !== null &&
                retryOn.includes(input.errorCode)
              ? input.errorCode
              : null;
        const expectedErrorCode =
          input.qualityDecision === 'needs_revision' &&
          (retryReason === null || attempt.attempt_no >= maxAttempts)
            ? 'quality_revision_exhausted'
            : input.qualityDecision === 'fail'
              ? 'quality_rejected'
              : input.errorCode;
        const expectedTerminalSuccess =
          retryReason === null &&
          input.executionOutcome === 'succeeded' &&
          expectedQuality === 'pass';
        if (expectedTerminalSuccess !== (input.outputPorts !== null))
          throw new G5RuntimeError(
            'contract_invalid',
            'T6a output port publication must exist only for terminal success',
          );
        const published = expectedTerminalSuccess
          ? persistNodeOutputEnvelope(transaction, {
              identity: authority,
              node: authority.node,
              sourcePorts: input.outputPorts!,
              nowMs: input.nowMs,
            })
          : null;
        const terminalNode = transaction.queryOne<{
          published_output_envelope_value_id: string | null;
          published_output_envelope_hash: string | null;
        }>(
          `SELECT published_output_envelope_value_id,
                  published_output_envelope_hash
             FROM workflow_graph_nodes WHERE id = ?`,
          [input.nodeId],
        );
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
          attempt.retry_reason_code !== retryReason ||
          attempt.error_code !== expectedErrorCode ||
          !terminalNode ||
          terminalNode.published_output_envelope_value_id !==
            (published?.id ?? null) ||
          terminalNode.published_output_envelope_hash !==
            (published?.hash ?? null)
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
      const continuationKind =
        input.qualityDecision === 'needs_revision' && qualityRevision
          ? 'quality_revision'
          : input.executionOutcome === 'failed' &&
              input.errorCode !== null &&
              retryOn.includes(input.errorCode)
            ? 'execution_retry'
            : null;
      const retryReasonCode =
        continuationKind === 'quality_revision'
          ? 'quality_needs_revision'
          : continuationKind === 'execution_retry'
            ? input.errorCode
            : null;
      const shouldRetry =
        continuationKind !== null && attempt.attempt_no < maxAttempts;
      if (shouldRetry) {
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
            continuationKind,
            input.feedback?.id ?? null,
            input.feedback?.hash ?? null,
            retryReasonCode,
            String(retryPolicy.policy_hash),
            0,
            input.nowMs,
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
          retryReasonCode,
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
      if (terminalSuccess !== (input.outputPorts !== null))
        throw new G5RuntimeError(
          'contract_invalid',
          'T6a output port publication must exist only for terminal success',
        );
      const published = terminalSuccess
        ? persistNodeOutputEnvelope(transaction, {
            identity: authority,
            node: authority.node,
            sourcePorts: input.outputPorts!,
            nowMs: input.nowMs,
          })
        : null;
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
              published?.id ?? null,
              published?.hash ?? null,
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

export interface T6bDelegationStartInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly delegationId: string;
  readonly outboxId: string;
  readonly externalExecutionId: string;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly nowMs: number;
}

export interface T6bDelegationReservationInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly delegationId: string;
  readonly outboxId: string;
  readonly externalExecutionId: string;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly nowMs: number;
}

export function reserveDelegationExecutionIdentityT6b(
  store: WorkflowRuntimeStore,
  input: T6bDelegationReservationInput,
): 'registered' | 'duplicate' | 'late_cancellation_registered' | 'late' {
  return store.withImmediateTransaction((transaction) => {
    const row = transaction.queryOne<{
      delegation_id: string | null;
      external_execution_id: string | null;
      phase: string;
      acceptance_state: string;
      run_work_fence_epoch: number;
      scope_work_fence_epoch: number;
      attempt_row_version: number;
      normalized_node_json: string;
      effect_operation_id: string;
      effect_close_request_id: string | null;
      outbox_id: string;
      adapter_resource_id: string;
      adapter_resource_hash: Sha256Hash;
      adapter_ref_id: string;
      scope_close_request_id: string | null;
    }>(
      `SELECT attempt.delegation_id, attempt.external_execution_id,
              attempt.phase, attempt.acceptance_state,
              attempt.run_work_fence_epoch, attempt.scope_work_fence_epoch,
              attempt.row_version AS attempt_row_version,
              node.normalized_node_json,
              effect.id AS effect_operation_id,
              effect.close_request_id AS effect_close_request_id,
              outbox.id AS outbox_id, outbox.adapter_resource_id,
              outbox.adapter_resource_hash,
              adapter.resource_id AS adapter_ref_id,
              scope.close_request_id AS scope_close_request_id
         FROM workflow_graph_node_attempts attempt
         JOIN workflow_graph_nodes node
           ON node.graph_run_id = attempt.graph_run_id
          AND node.scope_id = attempt.scope_id AND node.id = attempt.node_id
         JOIN workflow_graph_scopes scope
           ON scope.graph_run_id = attempt.graph_run_id
          AND scope.id = attempt.scope_id
         JOIN workflow_graph_effect_operations effect
           ON effect.attempt_id = attempt.id
          AND effect.graph_run_id = attempt.graph_run_id
         JOIN workflow_outbox outbox ON outbox.effect_operation_id = effect.id
         JOIN workflow_registry_resources adapter
           ON adapter.id = outbox.adapter_resource_id
          AND adapter.content_hash = outbox.adapter_resource_hash
        WHERE attempt.id = ? AND attempt.graph_run_id = ?
          AND attempt.scope_id = ? AND attempt.node_id = ? AND outbox.id = ?`,
      [
        input.attemptId,
        input.graphRunId,
        input.scopeId,
        input.nodeId,
        input.outboxId,
      ],
    );
    if (!row)
      throw new G5RuntimeError(
        'precondition_failed',
        'T6b delegation reservation authority is missing',
      );
    if (
      row.delegation_id !== input.delegationId ||
      (row.external_execution_id !== null &&
        row.external_execution_id !== input.externalExecutionId)
    ) {
      throw new G5RuntimeError(
        'integrity_violation',
        'T6b delegation reservation identity drifted',
      );
    }
    if (row.phase !== 'dispatch_pending') return 'late';

    const identityInserted = row.external_execution_id === null;
    if (identityInserted) {
      if (
        transaction.execute(
          `UPDATE workflow_graph_node_attempts
              SET external_execution_id = ?, row_version = row_version + 1,
                  updated_at_ms = ?
            WHERE id = ? AND row_version = ? AND phase = 'dispatch_pending'
              AND external_execution_id IS NULL AND delegation_id = ?`,
          [
            input.externalExecutionId,
            input.nowMs,
            input.attemptId,
            row.attempt_row_version,
            input.delegationId,
          ],
        ).changes !== 1
      ) {
        throw new G5RuntimeError(
          'cas_conflict',
          'T6b delegation reservation identity CAS failed',
        );
      }
    }

    const currentFenceMatches =
      row.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
      row.scope_work_fence_epoch === input.expectedScopeWorkFenceEpoch;
    const late = row.acceptance_state !== 'open' || !currentFenceMatches;
    const closeRequestId =
      row.effect_close_request_id ?? row.scope_close_request_id;
    const node = JSON.parse(row.normalized_node_json) as JsonObject;
    const capability = node.capability_binding as JsonObject | undefined;
    const cancellation = capability?.cancellation as JsonObject | undefined;
    const cancellationRequired =
      cancellation?.type === 'cooperative' &&
      cancellation.ack_required_before_close === true &&
      cancellation.safe_if_cancel_lost === false;
    let cancellationInserted = false;
    let cancellationId: string | null = null;
    if (late && closeRequestId && cancellationRequired) {
      cancellationId = stableRuntimeId('provider-cancellation', {
        graph_run_id: input.graphRunId,
        attempt_id: input.attemptId,
        external_execution_id: input.externalExecutionId,
        close_request_id: closeRequestId,
      });
      const existing = transaction.queryOne<{
        id: string;
        external_execution_id: string;
        close_request_id: string;
      }>(
        `SELECT id, external_execution_id, close_request_id
           FROM workflow_provider_cancellation_requests WHERE attempt_id = ?`,
        [input.attemptId],
      );
      if (existing) {
        if (
          existing.id !== cancellationId ||
          existing.external_execution_id !== input.externalExecutionId ||
          existing.close_request_id !== closeRequestId
        ) {
          throw new G5RuntimeError(
            'integrity_violation',
            'T6b late provider cancellation identity drifted',
          );
        }
      } else {
        cancellationInserted =
          transaction.execute(
            `INSERT INTO workflow_provider_cancellation_requests (
               id, graph_run_id, scope_id, node_id, attempt_id,
               effect_operation_id, outbox_id, close_request_id,
               adapter_resource_id, adapter_resource_hash, adapter_ref_id,
               external_execution_id, status, attempt_count,
               next_attempt_at_ms, lease_owner, lease_token,
               lease_expires_at_ms, last_error, requested_at_ms,
               settled_at_ms, updated_at_ms, row_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 0,
                       ?, NULL, NULL, NULL, NULL, ?, NULL, ?, 1)`,
            [
              cancellationId,
              input.graphRunId,
              input.scopeId,
              input.nodeId,
              input.attemptId,
              row.effect_operation_id,
              row.outbox_id,
              closeRequestId,
              row.adapter_resource_id,
              row.adapter_resource_hash,
              row.adapter_ref_id,
              input.externalExecutionId,
              input.nowMs,
              input.nowMs,
              input.nowMs,
            ],
          ).changes === 1;
      }
    }

    if (identityInserted || cancellationInserted) {
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      let sequence = run.next_event_seq;
      if (identityInserted) {
        sequence += 1;
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: input.nodeId,
          attemptId: input.attemptId,
          eventType: 'attempt_phase_changed',
          idempotencyKey: `delegation-execution-reserved:${input.attemptId}:${input.externalExecutionId}`,
          payloadJson: {
            phase: 'dispatch_pending',
            external_execution_id: input.externalExecutionId,
            identity_state: 'reserved',
          },
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
      }
      if (cancellationInserted) {
        sequence += 1;
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: input.nodeId,
          attemptId: input.attemptId,
          eventType: 'provider_cancellation_requested',
          idempotencyKey: `provider-cancellation-requested:${cancellationId}`,
          payloadJson: {
            cancellation_request_id: cancellationId,
            external_execution_id: input.externalExecutionId,
            adapter_ref_id: row.adapter_ref_id,
            close_request_id: closeRequestId,
          },
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
      }
      if (
        transaction.execute(
          `UPDATE workflow_graph_runs SET next_event_seq = ?,
                  row_version = row_version + 1, updated_at_ms = ?
            WHERE id = ? AND row_version = ?`,
          [sequence, input.nowMs, input.graphRunId, run.row_version],
        ).changes !== 1
      ) {
        throw new G5RuntimeError(
          'cas_conflict',
          'T6b delegation reservation event head CAS failed',
        );
      }
    }
    if (late)
      return cancellationRequired && closeRequestId
        ? 'late_cancellation_registered'
        : 'late';
    return identityInserted ? 'registered' : 'duplicate';
  });
}

export function acceptDelegationStartT6bInTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T6bDelegationStartInput,
): 'accepted' | 'duplicate' | 'late' | 'conflict' {
  const authority = loadMaterializedNodeAuthority(
    transaction,
    input.graphRunId,
    input.scopeId,
    input.nodeId,
  );
  if (authority.node.type !== 'delegation')
    throw new G5RuntimeError(
      'contract_invalid',
      'T6b start acceptance requires a Plan-pinned delegation node',
    );
  const effectiveLimits = authority.node.effective_limits;
  const timeoutMs =
    effectiveLimits && typeof effectiveLimits === 'object'
      ? Number((effectiveLimits as JsonObject).timeout_ms)
      : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new G5RuntimeError(
      'integrity_violation',
      'T6b delegation execution timeout is not finite',
    );
  const executionDeadlineAtMs = input.nowMs + timeoutMs;
  if (!Number.isSafeInteger(executionDeadlineAtMs))
    throw new G5RuntimeError(
      'integrity_violation',
      'T6b delegation execution deadline exceeds the safe integer range',
    );
  const attempt = transaction.queryOne<{
    delegation_id: string | null;
    external_execution_id: string | null;
    phase: string;
    acceptance_state: string;
    execution_started_at_ms: number | null;
    execution_deadline_at_ms: number | null;
    run_work_fence_epoch: number;
    scope_work_fence_epoch: number;
    row_version: number;
  }>(
    `SELECT delegation_id, external_execution_id, phase, acceptance_state,
            execution_started_at_ms, execution_deadline_at_ms,
            run_work_fence_epoch, scope_work_fence_epoch, row_version
       FROM workflow_graph_node_attempts
      WHERE id = ? AND graph_run_id = ? AND scope_id = ? AND node_id = ?`,
    [input.attemptId, input.graphRunId, input.scopeId, input.nodeId],
  );
  if (!attempt)
    throw new G5RuntimeError(
      'precondition_failed',
      'T6b delegation start attempt is missing',
    );
  const dispatched = transaction.queryOne<{ external_id: string }>(
    `SELECT outbox_attempt.external_id
       FROM workflow_graph_effect_operations effect
       JOIN workflow_outbox outbox ON outbox.effect_operation_id = effect.id
       JOIN workflow_outbox_attempts outbox_attempt
         ON outbox_attempt.outbox_id = outbox.id
      WHERE effect.attempt_id = ? AND outbox.id = ?
        AND outbox_attempt.result_kind = 'applied_with_receipt'
        AND outbox_attempt.external_id IS NOT NULL
      ORDER BY outbox_attempt.history_seq DESC LIMIT 1`,
    [input.attemptId, input.outboxId],
  );
  if (
    attempt.delegation_id !== input.delegationId ||
    dispatched?.external_id !== input.externalExecutionId ||
    (attempt.external_execution_id !== null &&
      attempt.external_execution_id !== input.externalExecutionId)
  ) {
    return 'conflict';
  }
  if (
    attempt.phase === 'running' &&
    attempt.external_execution_id === input.externalExecutionId &&
    attempt.execution_started_at_ms !== null &&
    attempt.execution_deadline_at_ms !== null
  ) {
    return 'duplicate';
  }
  const currentFenceMatches =
    authority.runWorkFenceEpoch === input.expectedRunWorkFenceEpoch &&
    authority.scopeWorkFenceEpoch === input.expectedScopeWorkFenceEpoch &&
    attempt.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
    attempt.scope_work_fence_epoch === input.expectedScopeWorkFenceEpoch;
  if (
    attempt.acceptance_state !== 'open' ||
    attempt.phase !== 'dispatch_pending' ||
    !currentFenceMatches
  ) {
    return 'late';
  }
  if (
    transaction.execute(
      `UPDATE workflow_graph_node_attempts
          SET external_execution_id = ?, phase = 'running',
              execution_started_at_ms = ?, execution_deadline_at_ms = ?,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND phase = 'dispatch_pending'
          AND acceptance_state = 'open' AND delegation_id = ?
          AND (external_execution_id IS NULL OR external_execution_id = ?)
          AND run_work_fence_epoch = ? AND scope_work_fence_epoch = ?`,
      [
        input.externalExecutionId,
        input.nowMs,
        executionDeadlineAtMs,
        input.nowMs,
        input.attemptId,
        attempt.row_version,
        input.delegationId,
        input.externalExecutionId,
        input.expectedRunWorkFenceEpoch,
        input.expectedScopeWorkFenceEpoch,
      ],
    ).changes !== 1
  ) {
    throw new G5RuntimeError(
      'cas_conflict',
      'T6b delegation start acceptance CAS failed',
    );
  }
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
    idempotencyKey: `delegation-start:${input.attemptId}:${input.externalExecutionId}`,
    payloadJson: {
      phase: 'running',
      external_execution_id: input.externalExecutionId,
      execution_deadline_at_ms: executionDeadlineAtMs,
    },
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });
  if (
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET next_event_seq = ?, row_version = row_version + 1,
              updated_at_ms = ?
        WHERE id = ? AND row_version = ?`,
      [sequence, input.nowMs, input.graphRunId, run.row_version],
    ).changes !== 1
  ) {
    throw new G5RuntimeError(
      'cas_conflict',
      'T6b delegation start event head CAS failed',
    );
  }
  return 'accepted';
}

export function acceptDelegationStartT6b(
  store: WorkflowRuntimeStore,
  input: T6bDelegationStartInput,
): 'accepted' | 'duplicate' | 'late' | 'conflict' {
  return store.withImmediateTransaction((transaction) =>
    acceptDelegationStartT6bInTransaction(transaction, input),
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
      const authority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
        input.nodeId,
      );
      if (authority.node.type !== 'delegation')
        throw new G5RuntimeError(
          'contract_invalid',
          'T6b callback requires a Plan-pinned delegation node',
        );
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
        'SELECT delegation_id, external_execution_id, acceptance_state, result_value_id, result_hash, run_work_fence_epoch, scope_work_fence_epoch, row_version FROM workflow_graph_node_attempts WHERE id = ? AND graph_run_id = ? AND scope_id = ? AND node_id = ?',
        [input.attemptId, input.graphRunId, input.scopeId, input.nodeId],
      );
      if (!attempt)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6b attempt is missing',
        );
      const dispatched = transaction.queryOne<{ external_id: string }>(
        `SELECT oa.external_id
           FROM workflow_graph_effect_operations e
           JOIN workflow_outbox o ON o.effect_operation_id = e.id
           JOIN workflow_outbox_attempts oa ON oa.outbox_id = o.id
          WHERE e.attempt_id = ? AND oa.external_id IS NOT NULL
          ORDER BY oa.kind_attempt_no DESC LIMIT 1`,
        [input.attemptId],
      );
      const identityMatches =
        attempt.delegation_id === input.delegationId &&
        dispatched?.external_id === input.externalExecutionId &&
        (attempt.external_execution_id === null ||
          attempt.external_execution_id === input.externalExecutionId);
      const currentFenceMatches =
        authority.runWorkFenceEpoch === input.expectedRunWorkFenceEpoch &&
        authority.scopeWorkFenceEpoch === input.expectedScopeWorkFenceEpoch &&
        attempt.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
        attempt.scope_work_fence_epoch === input.expectedScopeWorkFenceEpoch;
      if (attempt.result_value_id !== null) {
        if (
          identityMatches &&
          currentFenceMatches &&
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
        const fenceReason = !identityMatches
          ? 'execution_identity_conflict'
          : currentFenceMatches
            ? 'result_already_accepted'
            : 'acceptance_fenced';
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
        return identityMatches && !currentFenceMatches ? 'late' : 'conflict';
      }
      const open = attempt.acceptance_state === 'open' && currentFenceMatches;
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
        "UPDATE workflow_graph_node_attempts SET external_execution_id = ?, result_value_id = ?, result_hash = ?, phase = 'evaluating', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND acceptance_state = 'open' AND delegation_id = ? AND run_work_fence_epoch = ? AND scope_work_fence_epoch = ?",
        [
          input.externalExecutionId,
          input.result.id,
          input.result.hash,
          input.nowMs,
          input.attemptId,
          attempt.row_version,
          input.delegationId,
          input.expectedRunWorkFenceEpoch,
          input.expectedScopeWorkFenceEpoch,
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

export interface T6dConsumePrimitiveInput {
  readonly retryScheduleId: string;
  readonly expectedScheduleRowVersion: number;
  readonly ingress: 'automatic_timer' | 'authorized_manual_retry';
  readonly nowMs: number;
}

export function consumeExistingRetryScheduleT6dInTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  watcher: Pick<CapacitySnapshotWatcher, 'current'>,
  input: T6dConsumePrimitiveInput,
): { disposition: 'consumed' | 'duplicate_timer'; attemptId: string } {
  const capacity = watcher.current();
  if (!capacity)
    throw new G5RuntimeError(
      'resource_unavailable',
      'T6d live Capacity snapshot is unavailable',
    );
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
    retry_reason_code: string;
    retry_policy_hash: string;
    backoff_ms: number;
    eligible_at_ms: number;
    attempt_reservation_id: string;
    status: string;
    row_version: number;
  }>(
    'SELECT graph_run_id, scope_id, node_id, source_attempt_id, source_attempt_no, next_attempt_no, continuation_kind, quality_revision_feedback_value_id, quality_revision_feedback_hash, retry_reason_code, retry_policy_hash, backoff_ms, eligible_at_ms, attempt_reservation_id, status, row_version FROM workflow_graph_retry_schedules WHERE id = ?',
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
    (input.ingress === 'automatic_timer' &&
      schedule.eligible_at_ms > input.nowMs)
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
    run_work_fence_epoch: number;
    scope_work_fence_epoch: number;
  }>(
    'SELECT input_snapshot_json, input_snapshot_value_id, input_snapshot_hash, selected_edges_json, context_pack_value_id, context_pack_hash, action_name, query_id, run_work_fence_epoch, scope_work_fence_epoch FROM workflow_graph_node_attempts WHERE id = ?',
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
    runtime_supported_limits_resource_hash: string;
    next_event_seq: number;
    row_version: number;
  }>(
    'SELECT control, operational_state, work_fence_epoch, runtime_supported_limits_resource_hash, next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
    [schedule.graph_run_id],
  );
  const scope = transaction.queryOne<{
    work_fence_epoch: number;
    lifecycle: string;
  }>(
    'SELECT work_fence_epoch, lifecycle FROM workflow_graph_scopes WHERE id = ?',
    [schedule.scope_id],
  );
  const capacityHead = transaction.queryOne<{
    current_capacity_revision: number | null;
    current_change_id: string | null;
    current_config_hash: string | null;
    pending_change_id: string | null;
  }>(
    'SELECT current_capacity_revision, current_change_id, current_config_hash, pending_change_id FROM runtime_capacity_head WHERE singleton_key = 1',
    [],
  );
  const authority = loadMaterializedNodeAuthority(
    transaction,
    schedule.graph_run_id,
    schedule.scope_id,
    schedule.node_id,
  );
  const retryPolicy = requiredObjectField(
    authority.node,
    'effective_retry_policy',
    'Plan node',
  );
  if (
    !source ||
    !reservation ||
    !run ||
    !scope ||
    run.control !==
      (input.ingress === 'automatic_timer' ? 'running' : 'paused') ||
    run.operational_state !== 'healthy' ||
    scope.lifecycle !== 'active' ||
    source.run_work_fence_epoch !== authority.runWorkFenceEpoch ||
    source.scope_work_fence_epoch !== authority.scopeWorkFenceEpoch ||
    run.work_fence_epoch !== authority.runWorkFenceEpoch ||
    scope.work_fence_epoch !== authority.scopeWorkFenceEpoch ||
    schedule.retry_policy_hash !== String(retryPolicy.policy_hash) ||
    (schedule.continuation_kind === 'quality_revision' &&
      retryPolicy.quality_revision === null) ||
    (schedule.continuation_kind === 'execution_retry' &&
      (!Array.isArray(retryPolicy.effective_retry_on) ||
        !retryPolicy.effective_retry_on
          .map(String)
          .includes(schedule.retry_reason_code))) ||
    !capacityHead ||
    capacityHead.pending_change_id !== null ||
    capacityHead.current_capacity_revision !== capacity.capacity_revision ||
    capacityHead.current_change_id !== capacity.capacity_change_id ||
    capacityHead.current_config_hash !== capacity.capacity.config_hash
  )
    throw new G5RuntimeError(
      'precondition_failed',
      'T6d run/scope/source is not executable',
    );
  const activeCount = transaction.queryOne<{ count: number }>(
    "SELECT count(*) AS count FROM workflow_graph_node_attempts WHERE phase IN ('preparing', 'dispatch_pending', 'running', 'evaluating')",
    [],
  )!.count;
  if (activeCount >= capacity.capacity.max_active_executions)
    throw new G5RuntimeError(
      'resource_unavailable',
      'T6d live Capacity has no execution slot',
    );
  const [slotReservationId] = reserveLedgerResources(transaction, {
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
  const retryEvent = transaction.queryOne<{ seq: number }>(
    'SELECT seq FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = ?',
    [schedule.graph_run_id, `retry-schedule:${input.retryScheduleId}`],
  );
  if (!retryEvent)
    throw new G5RuntimeError(
      'integrity_violation',
      'T6d retry schedule has no causal event',
    );
  const admissionInsert = transaction.execute(
    `INSERT INTO workflow_graph_scheduler_admissions (
           graph_run_id, scope_id, node_id, attempt_id,
           eligible_event_seq, execution_reservation_id, capacity_config_hash,
           runtime_supported_limits_hash, created_at_ms, capacity_revision,
           capacity_change_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      schedule.graph_run_id,
      schedule.scope_id,
      schedule.node_id,
      attemptId,
      retryEvent.seq,
      slotReservationId,
      capacity.capacity.config_hash,
      run.runtime_supported_limits_resource_hash,
      input.nowMs,
      capacity.capacity_revision,
      capacity.capacity_change_id,
    ],
  );
  const admissionSequence = Number(admissionInsert.lastInsertRowid);
  if (
    admissionInsert.changes !== 1 ||
    !Number.isSafeInteger(admissionSequence) ||
    admissionSequence <= 0
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T6d failed to allocate retry admission sequence',
    );
  if (
    transaction.execute(
      "UPDATE workflow_graph_retry_schedules SET status = 'consumed', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND status = 'scheduled'",
      [input.nowMs, input.retryScheduleId, input.expectedScheduleRowVersion],
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
      'UPDATE workflow_graph_runs SET last_admission_seq = ?, next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
      [
        admissionSequence,
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
}

export function consumeRetryScheduleT6d(
  store: WorkflowRuntimeStore,
  watcher: Pick<CapacitySnapshotWatcher, 'current'>,
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
    (transaction) =>
      consumeExistingRetryScheduleT6dInTransaction(transaction, watcher, {
        ...input,
        ingress: 'automatic_timer',
      }),
    fault,
  );
}

export interface T6dWatchdogInput {
  readonly attemptId: string;
  readonly automaticTimer: true;
  readonly expectedAttemptRowVersion: number;
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
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT graph_run_id, scope_id, node_id, attempt_no, phase, acceptance_state, dispatch_deadline_at_ms, execution_deadline_at_ms, resource_reservation_group_id, run_work_fence_epoch, scope_work_fence_epoch, row_version FROM workflow_graph_node_attempts WHERE id = ?',
        [input.attemptId],
      );
      if (!attempt)
        throw new G5RuntimeError(
          'precondition_failed',
          'T6d watchdog attempt is missing',
        );
      if (attempt.acceptance_state === 'fenced' || attempt.phase === 'terminal')
        return { disposition: 'duplicate_timer', retryScheduleId: null };
      const authority = loadMaterializedNodeAuthority(
        transaction,
        attempt.graph_run_id,
        attempt.scope_id,
        attempt.node_id,
      );
      const retryPolicy = requiredObjectField(
        authority.node,
        'effective_retry_policy',
        'Plan node',
      );
      const maxAttempts = Number(retryPolicy.effective_node_max_attempts);
      const retryOn = Array.isArray(retryPolicy.effective_retry_on)
        ? retryPolicy.effective_retry_on.map(String)
        : [];
      const deadline =
        attempt.phase === 'dispatch_pending'
          ? attempt.dispatch_deadline_at_ms
          : attempt.execution_deadline_at_ms;
      if (
        attempt.row_version !== input.expectedAttemptRowVersion ||
        attempt.run_work_fence_epoch !== authority.runWorkFenceEpoch ||
        attempt.scope_work_fence_epoch !== authority.scopeWorkFenceEpoch ||
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
      if (
        retryOn.includes('attempt_timeout') &&
        attempt.attempt_no < maxAttempts
      ) {
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
            'attempt_timeout',
            String(retryPolicy.policy_hash),
            0,
            input.nowMs,
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
