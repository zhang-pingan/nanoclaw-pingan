export {
  insertInlineValue,
  runtimeObjectHash,
  stableRuntimeId,
} from '../runtime/graph-store.js';
export {
  acceptDelegationCallbackT6b,
  reserveDelegationExecutionIdentityT6b,
} from '../runtime/node-execution.js';
export {
  leaseOutboxWork,
  recordOutboxResult,
  type OutboxLease,
} from '../runtime/outbox.js';
export type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
export {
  createWorkflowT0 as createFiniteWorkflowRun,
  type T0CreationInput as FiniteWorkflowCreationInput,
  type T0CreationReceipt as FiniteWorkflowCreationReceipt,
} from '../creation/task-intake.js';

import {
  calculateCreationIntentHash,
  type T0CreationInput,
} from '../creation/task-intake.js';
import { insertGraphEvent } from '../runtime/graph-store.js';
import { acceptDelegationStartT6bInTransaction } from '../runtime/node-execution.js';
import {
  recordOutboxResultInTransaction,
  type OutboxLease,
} from '../runtime/outbox.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';

export type FiniteWorkflowCreationTemplate = Omit<
  T0CreationInput,
  | 'requestId'
  | 'creationDomain'
  | 'creationKey'
  | 'source'
  | 'actor'
  | 'launchPolicy'
  | 'launchAuthorization'
  | 'entryPoint'
  | 'creationIntentHash'
  | 'nowMs'
  | 'initialActivation'
> & {
  readonly initialActivation: Omit<
    T0CreationInput['initialActivation'],
    'nowMs'
  >;
};

export function recordDelegationAcceptance(
  store: WorkflowRuntimeStore,
  input: {
    readonly lease: OutboxLease;
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly nodeId: string;
    readonly attemptId: string;
    readonly delegationId: string;
    readonly externalExecutionId: string;
    readonly expectedRunWorkFenceEpoch: number;
    readonly expectedScopeWorkFenceEpoch: number;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
  },
): 'accepted' | 'duplicate' | 'late_cancellation_registered' {
  return store.withImmediateTransaction((transaction) => {
    const outboxStatus = recordOutboxResultInTransaction(
      transaction,
      input.lease,
      {
        resultKind: 'applied_with_receipt',
        resultCode: null,
        receipt: input.lease.request,
        afterState: input.lease.request,
        immutableOutput: input.lease.request,
        externalId: input.externalExecutionId,
        nextAttemptAtMs: null,
        attemptsExhausted: input.lease.kindAttemptNo >= input.lease.maxAttempts,
        startedAtMs: input.startedAtMs,
        finishedAtMs: input.finishedAtMs,
      },
    );
    if (outboxStatus !== 'succeeded')
      throw new Error('Delegation acceptance Outbox did not commit succeeded');
    const disposition = acceptDelegationStartT6bInTransaction(transaction, {
      graphRunId: input.graphRunId,
      scopeId: input.scopeId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      delegationId: input.delegationId,
      outboxId: input.lease.outboxId,
      externalExecutionId: input.externalExecutionId,
      expectedRunWorkFenceEpoch: input.expectedRunWorkFenceEpoch,
      expectedScopeWorkFenceEpoch: input.expectedScopeWorkFenceEpoch,
      nowMs: input.finishedAtMs,
    });
    if (disposition === 'late') {
      const cancellation = transaction.queryOne<{ id: string }>(
        `SELECT id FROM workflow_provider_cancellation_requests
          WHERE attempt_id = ? AND outbox_id = ?
            AND external_execution_id = ?`,
        [input.attemptId, input.lease.outboxId, input.externalExecutionId],
      );
      if (cancellation) return 'late_cancellation_registered';
    }
    if (disposition !== 'accepted' && disposition !== 'duplicate')
      throw new Error(`Delegation start acceptance was ${disposition}`);
    return disposition;
  });
}

export interface FiniteWorkflowCreationRequest {
  readonly requestId: string;
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly source: T0CreationInput['source'];
  readonly actor: T0CreationInput['actor'];
  readonly launchPolicy: T0CreationInput['launchPolicy'];
  readonly launchAuthorization: T0CreationInput['launchAuthorization'];
  readonly entryPoint: string;
  readonly nowMs: number;
  readonly template: FiniteWorkflowCreationTemplate;
}

export function resolveFiniteWorkflowCreationInput(
  request: FiniteWorkflowCreationRequest,
): T0CreationInput {
  const input: T0CreationInput = {
    ...request.template,
    requestId: request.requestId,
    creationDomain: request.creationDomain,
    creationKey: request.creationKey,
    source: request.source,
    actor: request.actor,
    launchPolicy: request.launchPolicy,
    launchAuthorization: request.launchAuthorization,
    entryPoint: request.entryPoint,
    creationIntentHash: calculateCreationIntentHash({
      creationDomain: request.creationDomain,
      creationKey: request.creationKey,
      principalRef: request.template.principalRef,
      ownershipHash: request.template.ownershipHash,
      routingScope: request.template.routingScope,
      recipe: request.template.recipe,
      entryPoint: request.entryPoint,
      inputHash: request.template.input.hash,
      attachmentManifestHash: request.template.attachments.hash,
    }),
    initialActivation: {
      ...request.template.initialActivation,
      nowMs: request.nowMs,
    },
    nowMs: request.nowMs,
  };
  return input;
}

export interface FiniteWorkflowRunObservation {
  readonly state:
    | 'running'
    | 'waiting_approval'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly lifecycle: string;
  readonly control: string;
  readonly operationalState: string;
  readonly outcomeKind: string | null;
  readonly exitName: string | null;
  readonly outputHash: string | null;
  readonly output: unknown;
  readonly errorCode: string | null;
}

export function observeFiniteWorkflowRun(
  store: WorkflowRuntimeStore,
  graphRunId: string,
): FiniteWorkflowRunObservation | null {
  const row = store.queryOne<{
    workflow_id: string;
    lifecycle: string;
    control: string;
    operational_state: string;
    outcome_kind: string | null;
    exit_name: string | null;
    output_hash: string | null;
    error_code: string | null;
    inline_canonical_json: string | null;
  }>(
    `SELECT run.workflow_id, run.lifecycle, run.control,
            run.operational_state, run.outcome_kind, run.exit_name,
            run.output_hash, run.error_code, value.inline_canonical_json
       FROM workflow_graph_runs run
  LEFT JOIN workflow_values value ON value.id = run.output_value_id
      WHERE run.id = ?`,
    [graphRunId],
  );
  if (!row) return null;
  const state =
    row.lifecycle !== 'closed'
      ? row.operational_state === 'action_required'
        ? ('waiting_approval' as const)
        : ('running' as const)
      : row.outcome_kind === 'normal'
        ? ('succeeded' as const)
        : row.outcome_kind === 'cancelled'
          ? ('cancelled' as const)
          : ('failed' as const);
  return {
    state,
    workflowId: row.workflow_id,
    graphRunId,
    lifecycle: row.lifecycle,
    control: row.control,
    operationalState: row.operational_state,
    outcomeKind: row.outcome_kind,
    exitName: row.exit_name,
    outputHash: row.output_hash,
    output: row.inline_canonical_json
      ? (JSON.parse(row.inline_canonical_json) as unknown)
      : null,
    errorCode: row.error_code,
  };
}

export interface ProviderCancellationLease {
  readonly requestId: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly effectOperationId: string;
  readonly outboxId: string;
  readonly closeRequestId: string;
  readonly adapterResourceId: string;
  readonly adapterResourceHash: string;
  readonly adapterRefId: string;
  readonly externalExecutionId: string;
  readonly attemptCount: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

interface ProviderCancellationRow extends Record<string, unknown> {
  id: string;
  graph_run_id: string;
  scope_id: string;
  node_id: string;
  attempt_id: string;
  effect_operation_id: string;
  outbox_id: string;
  close_request_id: string;
  adapter_resource_id: string;
  adapter_resource_hash: string;
  adapter_ref_id: string;
  external_execution_id: string;
  attempt_count: number;
}

export function leaseProviderCancellationRequests(
  store: WorkflowRuntimeStore,
  input: {
    readonly leaseOwner: string;
    readonly leaseToken: () => string;
    readonly leaseDurationMs: number;
    readonly nowMs: number;
    readonly limit?: number;
  },
): ProviderCancellationLease[] {
  return store.withImmediateTransaction((transaction) => {
    const rows = transaction.queryAll<ProviderCancellationRow>(
      `SELECT id, graph_run_id, scope_id, node_id, attempt_id,
              effect_operation_id, outbox_id, close_request_id,
              adapter_resource_id, adapter_resource_hash, adapter_ref_id,
              external_execution_id, attempt_count
         FROM workflow_provider_cancellation_requests
        WHERE (status = 'requested'
            OR (status = 'retry_wait' AND next_attempt_at_ms <= ?)
            OR (status = 'processing' AND lease_expires_at_ms <= ?))
        ORDER BY requested_at_ms, id COLLATE BINARY
        LIMIT ?`,
      [input.nowMs, input.nowMs, input.limit ?? 16],
    );
    return rows.flatMap((row) => {
      const leaseToken = input.leaseToken();
      const changed = transaction.execute(
        `UPDATE workflow_provider_cancellation_requests
            SET status = 'processing', attempt_count = attempt_count + 1,
                next_attempt_at_ms = NULL, lease_owner = ?, lease_token = ?,
                lease_expires_at_ms = ?, updated_at_ms = ?,
                row_version = row_version + 1
          WHERE id = ? AND (status = 'requested'
             OR (status = 'retry_wait' AND next_attempt_at_ms <= ?)
             OR (status = 'processing' AND lease_expires_at_ms <= ?))`,
        [
          input.leaseOwner,
          leaseToken,
          input.nowMs + input.leaseDurationMs,
          input.nowMs,
          row.id,
          input.nowMs,
          input.nowMs,
        ],
      ).changes;
      return changed === 1
        ? [
            {
              requestId: row.id,
              graphRunId: row.graph_run_id,
              scopeId: row.scope_id,
              nodeId: row.node_id,
              attemptId: row.attempt_id,
              effectOperationId: row.effect_operation_id,
              outboxId: row.outbox_id,
              closeRequestId: row.close_request_id,
              adapterResourceId: row.adapter_resource_id,
              adapterResourceHash: row.adapter_resource_hash,
              adapterRefId: row.adapter_ref_id,
              externalExecutionId: row.external_execution_id,
              attemptCount: row.attempt_count + 1,
              leaseOwner: input.leaseOwner,
              leaseToken,
            },
          ]
        : [];
    });
  });
}

export function hasUnsettledProviderCancellation(
  store: WorkflowRuntimeStore,
  externalExecutionId: string,
): boolean {
  return Boolean(
    store.queryOne<{ id: string }>(
      `SELECT id FROM workflow_provider_cancellation_requests
        WHERE external_execution_id = ?
          AND status NOT IN ('acknowledged', 'not_required')`,
      [externalExecutionId],
    ),
  );
}

export function recordProviderCancellationResult(
  store: WorkflowRuntimeStore,
  lease: ProviderCancellationLease,
  input:
    | {
        readonly disposition: 'acknowledged' | 'not_required';
        readonly nowMs: number;
      }
    | {
        readonly disposition: 'retry_wait';
        readonly error: string;
        readonly nextAttemptAtMs: number;
        readonly nowMs: number;
      },
): void {
  store.withImmediateTransaction((transaction) => {
    const run = transaction.queryOne<{
      next_event_seq: number;
      row_version: number;
    }>(
      'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
      [lease.graphRunId],
    );
    if (!run) throw new Error('Provider cancellation Runtime Run is missing');
    const settled = input.disposition !== 'retry_wait';
    const changed = transaction.execute(
      `UPDATE workflow_provider_cancellation_requests
          SET status = ?, next_attempt_at_ms = ?, lease_owner = NULL,
              lease_token = NULL, lease_expires_at_ms = NULL, last_error = ?,
              settled_at_ms = ?, updated_at_ms = ?, row_version = row_version + 1
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
          AND lease_token = ? AND graph_run_id = ? AND scope_id = ?
          AND node_id = ? AND attempt_id = ? AND external_execution_id = ?`,
      [
        input.disposition,
        input.disposition === 'retry_wait' ? input.nextAttemptAtMs : null,
        input.disposition === 'retry_wait' ? input.error.slice(0, 2000) : null,
        settled ? input.nowMs : null,
        input.nowMs,
        lease.requestId,
        lease.leaseOwner,
        lease.leaseToken,
        lease.graphRunId,
        lease.scopeId,
        lease.nodeId,
        lease.attemptId,
        lease.externalExecutionId,
      ],
    ).changes;
    if (changed !== 1)
      throw new Error('Provider cancellation lease authority is stale');
    const sequence = run.next_event_seq + 1;
    insertGraphEvent(transaction, {
      graphRunId: lease.graphRunId,
      sequence,
      scopeId: lease.scopeId,
      nodeId: lease.nodeId,
      attemptId: lease.attemptId,
      eventType:
        input.disposition === 'retry_wait'
          ? 'provider_cancellation_retry_scheduled'
          : input.disposition === 'acknowledged'
            ? 'provider_cancellation_acknowledged'
            : 'provider_cancellation_not_required',
      idempotencyKey: `provider-cancellation:${lease.requestId}:${lease.attemptCount}:${input.disposition}`,
      payloadJson: {
        cancellation_request_id: lease.requestId,
        external_execution_id: lease.externalExecutionId,
        adapter_ref_id: lease.adapterRefId,
        attempt_count: lease.attemptCount,
        disposition: input.disposition,
        ...(input.disposition === 'retry_wait'
          ? {
              error: input.error.slice(0, 2000),
              next_attempt_at_ms: input.nextAttemptAtMs,
            }
          : {}),
      },
      occurredAtMs: input.nowMs,
      createdAtMs: input.nowMs,
    });
    if (
      transaction.execute(
        `UPDATE workflow_graph_runs SET next_event_seq = ?,
                row_version = row_version + 1, updated_at_ms = ?
          WHERE id = ? AND row_version = ?`,
        [sequence, input.nowMs, lease.graphRunId, run.row_version],
      ).changes !== 1
    ) {
      throw new Error('Provider cancellation event Run authority is stale');
    }
  });
}
