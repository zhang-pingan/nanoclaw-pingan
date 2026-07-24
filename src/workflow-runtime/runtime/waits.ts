import type { RuntimeValueRef } from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject } from '../contracts/types.js';
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
} from './ledger.js';
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
} from './plan-authority.js';

function assertAuthorizationValue(
  transaction: WorkflowRuntimeWriteTransaction,
  value: RuntimeValueRef,
  format: string,
  phase: string,
): void {
  const row = transaction.queryOne<{
    inline_canonical_json: string | null;
    content_hash: string;
    payload_state: string;
  }>(
    'SELECT inline_canonical_json, content_hash, payload_state FROM workflow_values WHERE id = ?',
    [value.id],
  );
  if (
    !row ||
    row.inline_canonical_json === null ||
    row.content_hash !== value.hash ||
    row.payload_state !== 'live'
  )
    throw new G5RuntimeError(
      'precondition_failed',
      `T6c ${phase} authorization Value is unavailable`,
    );
  const content = JSON.parse(row.inline_canonical_json) as JsonObject;
  if (content.format !== format || content.phase !== phase)
    throw new G5RuntimeError(
      'contract_invalid',
      `T6c ${phase} authorization Value has the wrong typed contract`,
    );
}

export interface T6cWaitResolutionInput {
  readonly waitId: string;
  readonly providerRef: string;
  readonly providerEventId: string;
  readonly principalRef: string;
  readonly workflowId: string;
  readonly resolution: 'signal' | 'timeout' | 'cancel';
  readonly payload: RuntimeValueRef;
  readonly payloadByteLength: number;
  readonly ingressAuthorization: RuntimeValueRef;
  readonly bindingAuthorization: RuntimeValueRef;
  readonly expectedWaitRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly receivedAtMs: number;
  readonly expiresAtMs: number;
}

export interface T6cWaitResolutionReceipt {
  readonly disposition: 'accepted' | 'duplicate' | 'conflict' | 'late';
  readonly inboxSequence: number;
  readonly eventSequence: number | null;
}

export function resolveWaitT6c(
  store: WorkflowRuntimeStore,
  input: T6cWaitResolutionInput,
  fault?: G5TransactionFault,
): T6cWaitResolutionReceipt {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const priorInbox = transaction.queryOne<{
        inbox_seq: number;
        principal_ref: string;
        workflow_id: string;
        graph_run_id: string;
        contract_resource_id: string;
        contract_resource_hash: string;
        correlation_key_hash: string;
        payload_hash: string;
        byte_length: number;
        ingress_authorization_value_id: string;
        ingress_authorization_hash: string;
        binding_authorization_value_id: string;
        binding_authorization_hash: string;
        target_wait_id: string | null;
        disposition: string;
      }>(
        'SELECT inbox_seq, principal_ref, workflow_id, graph_run_id, contract_resource_id, contract_resource_hash, correlation_key_hash, payload_hash, byte_length, ingress_authorization_value_id, ingress_authorization_hash, binding_authorization_value_id, binding_authorization_hash, target_wait_id, disposition FROM workflow_graph_inbox_events WHERE provider_ref = ? AND provider_event_id = ?',
        [input.providerRef, input.providerEventId],
      );
      if (priorInbox) {
        const priorWait = transaction.queryOne<{
          graph_run_id: string;
          scope_id: string;
          node_id: string;
          contract_resource_id: string;
          contract_resource_hash: string;
          correlation_key_hash: string;
          status: string;
          run_work_fence_epoch: number;
          scope_work_fence_epoch: number;
        }>(
          'SELECT graph_run_id, scope_id, node_id, contract_resource_id, contract_resource_hash, correlation_key_hash, status, run_work_fence_epoch, scope_work_fence_epoch FROM workflow_graph_waits WHERE id = ?',
          [input.waitId],
        );
        if (
          input.ingressAuthorization.id === input.bindingAuthorization.id ||
          !priorWait
        )
          return {
            disposition: 'conflict',
            inboxSequence: priorInbox.inbox_seq,
            eventSequence: null,
          };
        assertAuthorizationValue(
          transaction,
          input.ingressAuthorization,
          'icarus.workflow-wait-ingress-authorization/1',
          'ingress',
        );
        assertAuthorizationValue(
          transaction,
          input.bindingAuthorization,
          'icarus.workflow-wait-binding-authorization/1',
          'binding',
        );
        const priorAuthority = loadMaterializedNodeAuthority(
          transaction,
          priorWait.graph_run_id,
          priorWait.scope_id,
          priorWait.node_id,
        );
        const priorWaitBinding = requiredObjectField(
          priorAuthority.node,
          'wait_binding',
          'Plan node',
        );
        const priorContractSnapshot = requiredObjectField(
          priorWaitBinding,
          'contract_snapshot',
          'Plan wait_binding',
        );
        const expectedWaitStatus =
          input.resolution === 'signal'
            ? 'resolved'
            : input.resolution === 'timeout'
              ? 'timed_out'
              : 'cancelled';
        const exact =
          priorInbox.principal_ref === input.principalRef &&
          priorInbox.workflow_id === input.workflowId &&
          priorInbox.target_wait_id === input.waitId &&
          priorInbox.payload_hash === input.payload.hash &&
          priorInbox.byte_length === input.payloadByteLength &&
          priorInbox.ingress_authorization_value_id ===
            input.ingressAuthorization.id &&
          priorInbox.ingress_authorization_hash ===
            input.ingressAuthorization.hash &&
          priorInbox.binding_authorization_value_id ===
            input.bindingAuthorization.id &&
          priorInbox.binding_authorization_hash ===
            input.bindingAuthorization.hash &&
          priorInbox.graph_run_id === priorWait.graph_run_id &&
          priorInbox.contract_resource_id === priorWait.contract_resource_id &&
          priorInbox.contract_resource_hash ===
            priorWait.contract_resource_hash &&
          priorInbox.correlation_key_hash === priorWait.correlation_key_hash &&
          priorWait.contract_resource_hash ===
            priorContractSnapshot.contract_hash &&
          priorAuthority.runWorkFenceEpoch ===
            input.expectedRunWorkFenceEpoch &&
          priorAuthority.scopeWorkFenceEpoch ===
            input.expectedScopeWorkFenceEpoch &&
          priorWait.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
          priorWait.scope_work_fence_epoch ===
            input.expectedScopeWorkFenceEpoch &&
          (priorInbox.disposition !== 'accepted' ||
            priorWait.status === expectedWaitStatus);
        return {
          disposition: exact ? 'duplicate' : 'conflict',
          inboxSequence: priorInbox.inbox_seq,
          eventSequence: null,
        };
      }
      const wait = transaction.queryOne<{
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        wait_type: string;
        contract_resource_id: string;
        contract_resource_hash: string;
        correlation_key: string;
        correlation_key_hash: string;
        status: string;
        run_work_fence_epoch: number;
        scope_work_fence_epoch: number;
        resource_reservation_group_id: string;
        row_version: number;
      }>(
        'SELECT graph_run_id, scope_id, node_id, wait_type, contract_resource_id, contract_resource_hash, correlation_key, correlation_key_hash, status, run_work_fence_epoch, scope_work_fence_epoch, resource_reservation_group_id, row_version FROM workflow_graph_waits WHERE id = ?',
        [input.waitId],
      );
      if (!wait)
        throw new G5RuntimeError('precondition_failed', 'T6c wait is missing');
      const authority = loadMaterializedNodeAuthority(
        transaction,
        wait.graph_run_id,
        wait.scope_id,
        wait.node_id,
      );
      const waitBinding = requiredObjectField(
        authority.node,
        'wait_binding',
        'Plan node',
      );
      const contractSnapshot = requiredObjectField(
        waitBinding,
        'contract_snapshot',
        'Plan wait_binding',
      );
      const run = transaction.queryOne<{
        workflow_id: string;
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT workflow_id, control, operational_state, work_fence_epoch, next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [wait.graph_run_id],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
      }>(
        'SELECT lifecycle, work_fence_epoch FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [wait.scope_id, wait.graph_run_id],
      );
      if (
        !run ||
        !scope ||
        run.workflow_id !== input.workflowId ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        scope.lifecycle !== 'active' ||
        wait.contract_resource_hash !== contractSnapshot.contract_hash ||
        wait.wait_type !== waitBinding.type
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T6c current Run/Scope/wait Plan authority drifted',
        );
      if (input.ingressAuthorization.id === input.bindingAuthorization.id)
        throw new G5RuntimeError(
          'contract_invalid',
          'T6c requires distinct ingress and binding authorizations',
        );
      assertAuthorizationValue(
        transaction,
        input.ingressAuthorization,
        'icarus.workflow-wait-ingress-authorization/1',
        'ingress',
      );
      assertAuthorizationValue(
        transaction,
        input.bindingAuthorization,
        'icarus.workflow-wait-binding-authorization/1',
        'binding',
      );
      const inboxSequence = transaction.queryOne<{ value: number }>(
        'SELECT coalesce(max(inbox_seq), 0) + 1 AS value FROM workflow_graph_inbox_events',
        [],
      )!.value;
      const open =
        wait.status === 'armed' &&
        wait.row_version === input.expectedWaitRowVersion &&
        run.work_fence_epoch === input.expectedRunWorkFenceEpoch &&
        scope.work_fence_epoch === input.expectedScopeWorkFenceEpoch &&
        authority.runWorkFenceEpoch === input.expectedRunWorkFenceEpoch &&
        authority.scopeWorkFenceEpoch === input.expectedScopeWorkFenceEpoch &&
        wait.run_work_fence_epoch === input.expectedRunWorkFenceEpoch &&
        wait.scope_work_fence_epoch === input.expectedScopeWorkFenceEpoch;
      if (!open) {
        transaction.execute(
          `INSERT INTO workflow_graph_inbox_events (
         inbox_seq, provider_ref, provider_event_id, principal_ref, workflow_id,
         graph_run_id, contract_resource_id, contract_resource_hash,
         correlation_key, correlation_key_hash, target_wait_id, payload_value_id,
         payload_hash, byte_length, ingress_authorization_value_id,
         ingress_authorization_hash, binding_authorization_value_id,
         binding_authorization_hash, disposition, received_at_ms, expires_at_ms,
         resolved_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'late', ?, ?, ?)`,
          [
            inboxSequence,
            input.providerRef,
            input.providerEventId,
            input.principalRef,
            input.workflowId,
            wait.graph_run_id,
            wait.contract_resource_id,
            wait.contract_resource_hash,
            wait.correlation_key,
            wait.correlation_key_hash,
            input.waitId,
            input.payload.id,
            input.payload.hash,
            input.payloadByteLength,
            input.ingressAuthorization.id,
            input.ingressAuthorization.hash,
            input.bindingAuthorization.id,
            input.bindingAuthorization.hash,
            input.receivedAtMs,
            input.expiresAtMs,
            input.receivedAtMs,
          ],
        );
        transaction.execute(
          'INSERT INTO workflow_graph_late_results (id, graph_run_id, scope_id, node_id, attempt_id, wait_id, source_event_id, payload_value_id, payload_hash, fence_reason, received_at_ms) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          [
            stableRuntimeId('late-result', {
              wait_id: input.waitId,
              provider_event_id: input.providerEventId,
            }),
            wait.graph_run_id,
            wait.scope_id,
            wait.node_id,
            input.waitId,
            input.providerEventId,
            input.payload.id,
            input.payload.hash,
            'wait_already_terminal_or_epoch_fenced',
            input.receivedAtMs,
          ],
        );
        return { disposition: 'late', inboxSequence, eventSequence: null };
      }
      transaction.execute(
        `INSERT INTO workflow_graph_inbox_events (
       inbox_seq, provider_ref, provider_event_id, principal_ref, workflow_id,
       graph_run_id, contract_resource_id, contract_resource_hash,
       correlation_key, correlation_key_hash, target_wait_id, payload_value_id,
       payload_hash, byte_length, ingress_authorization_value_id,
       ingress_authorization_hash, binding_authorization_value_id,
       binding_authorization_hash, disposition, received_at_ms, expires_at_ms,
       resolved_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
        [
          inboxSequence,
          input.providerRef,
          input.providerEventId,
          input.principalRef,
          input.workflowId,
          wait.graph_run_id,
          wait.contract_resource_id,
          wait.contract_resource_hash,
          wait.correlation_key,
          wait.correlation_key_hash,
          input.waitId,
          input.payload.id,
          input.payload.hash,
          input.payloadByteLength,
          input.ingressAuthorization.id,
          input.ingressAuthorization.hash,
          input.bindingAuthorization.id,
          input.bindingAuthorization.hash,
          input.receivedAtMs,
          input.expiresAtMs,
          input.receivedAtMs,
        ],
      );
      const terminalWaitStatus =
        input.resolution === 'signal'
          ? 'resolved'
          : input.resolution === 'timeout'
            ? 'timed_out'
            : 'cancelled';
      if (
        transaction.execute(
          "UPDATE workflow_graph_waits SET status = ?, payload_value_id = ?, payload_hash = ?, resolved_at_ms = ?, registration_lease_owner = NULL, registration_lease_token = NULL, registration_lease_expires_at_ms = NULL, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND status = 'armed' AND run_work_fence_epoch = ? AND scope_work_fence_epoch = ?",
          [
            terminalWaitStatus,
            input.payload.id,
            input.payload.hash,
            input.receivedAtMs,
            input.receivedAtMs,
            input.waitId,
            input.expectedWaitRowVersion,
            input.expectedRunWorkFenceEpoch,
            input.expectedScopeWorkFenceEpoch,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6c wait winner CAS failed');
      if (
        transaction.execute(
          "UPDATE workflow_graph_nodes SET phase = 'terminal', terminal_status = ?, terminal_code = ?, published_output_envelope_value_id = ?, published_output_envelope_hash = ?, terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND active_wait_id = ? AND phase = 'waiting'",
          [
            input.resolution === 'signal'
              ? 'succeeded'
              : input.resolution === 'timeout'
                ? 'failed'
                : 'cancelled',
            input.resolution === 'timeout' ? 'wait_timeout' : null,
            input.resolution === 'signal' ? input.payload.id : null,
            input.resolution === 'signal' ? input.payload.hash : null,
            input.receivedAtMs,
            input.receivedAtMs,
            wait.node_id,
            input.waitId,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T6c Node winner CAS failed');
      if (
        transaction.execute(
          `UPDATE workflow_graph_node_attempts
          SET phase = 'terminal', execution_outcome = ?, quality_decision = ?,
              result_value_id = ?, result_hash = ?, acceptance_state = 'fenced',
              error_code = ?, row_version = row_version + 1,
              updated_at_ms = ?, finished_at_ms = ?
        WHERE id = (SELECT current_attempt_id FROM workflow_graph_nodes WHERE id = ?)
          AND acceptance_state = 'open'`,
          [
            input.resolution === 'signal'
              ? 'succeeded'
              : input.resolution === 'cancel'
                ? 'cancelled'
                : 'failed',
            input.resolution === 'signal' ? 'pass' : null,
            input.resolution === 'signal' ? input.payload.id : null,
            input.resolution === 'signal' ? input.payload.hash : null,
            input.resolution === 'timeout' ? 'wait_timeout' : null,
            input.receivedAtMs,
            input.receivedAtMs,
            wait.node_id,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T6c Attempt winner CAS failed',
        );
      releaseLedgerReservationGroup(
        transaction,
        wait.graph_run_id,
        wait.resource_reservation_group_id,
        input.receivedAtMs,
      );
      const eventSequence = run.next_event_seq + 1;
      insertGraphEvent(transaction, {
        graphRunId: wait.graph_run_id,
        sequence: eventSequence,
        scopeId: wait.scope_id,
        nodeId: wait.node_id,
        attemptId: null,
        eventType: 'wait_resolved',
        idempotencyKey: `wait-winner:${input.waitId}`,
        payloadValueId: input.payload.id,
        payloadHash: input.payload.hash,
        occurredAtMs: input.receivedAtMs,
        createdAtMs: input.receivedAtMs,
      });
      chargeAndInsertGraphFact(transaction, {
        id: stableRuntimeId('fact', {
          graph_run_id: wait.graph_run_id,
          fact_key: `wait-winner:${input.waitId}`,
        }),
        graphRunId: wait.graph_run_id,
        scopeId: wait.scope_id,
        eventSeq: eventSequence,
        causalEventSeq: eventSequence,
        causalWave: 0,
        factKind: 'wait_resolved',
        stableObjectKind: 'wait',
        stableObjectId: input.waitId,
        factKey: `wait-winner:${input.waitId}`,
        payloadValueId: input.payload.id,
        payloadHash: input.payload.hash,
        createdAtMs: input.receivedAtMs,
      });
      const refreshed = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [wait.graph_run_id],
      )!;
      transaction.execute(
        'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
        [
          eventSequence,
          input.receivedAtMs,
          wait.graph_run_id,
          refreshed.row_version,
        ],
      );
      return { disposition: 'accepted', inboxSequence, eventSequence };
    },
    fault,
  );
}
