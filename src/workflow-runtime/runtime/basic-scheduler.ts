import type { CapacitySnapshotWatcher } from '../capacity/publication.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject } from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertGraphEvent,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { reserveLedgerResources } from './ledger.js';

export type T4ActivationRequest =
  | {
      readonly kind: 'execution';
      readonly contextPack: RuntimeValueRef;
      readonly actionName: string | null;
      readonly queryId: string | null;
    }
  | {
      readonly kind: 'wait';
      readonly contextPack: RuntimeValueRef;
      readonly waitType: 'signal' | 'timer' | 'approval';
      readonly contract: RuntimeRegistryRef;
      readonly correlationKey: string;
      readonly correlationKeyHash: `sha256:${string}`;
      readonly payload: RuntimeValueRef | null;
      readonly deadlineAtMs: number | null;
    }
  | {
      readonly kind: 'structural';
      readonly output: RuntimeValueRef;
    };

export interface T4SchedulerInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly expectedNodeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedScopeWorkFenceEpoch: number;
  readonly eligibleEventSeq: number;
  readonly activation: T4ActivationRequest;
  readonly nowMs: number;
}

export interface T4SchedulerReceipt {
  readonly disposition: 'activated' | 'backpressure' | 'exact_replay';
  readonly attemptId: string | null;
  readonly waitId: string | null;
  readonly admissionSequence: number | null;
}

export function scheduleReadyNodeT4(
  store: WorkflowRuntimeStore,
  watcher: Pick<CapacitySnapshotWatcher, 'current'>,
  input: T4SchedulerInput,
  fault?: G5TransactionFault,
): T4SchedulerReceipt {
  const capacity = watcher.current();
  if (!capacity)
    return {
      disposition: 'backpressure',
      attemptId: null,
      waitId: null,
      admissionSequence: null,
    };
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const run = transaction.queryOne<{
        control: string;
        operational_state: string;
        work_fence_epoch: number;
        last_admission_seq: number | null;
        runtime_supported_limits_resource_hash: string;
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT control, operational_state, work_fence_epoch, last_admission_seq, runtime_supported_limits_resource_hash, next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
      }>(
        'SELECT lifecycle, work_fence_epoch FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.scopeId, input.graphRunId],
      );
      const node = transaction.queryOne<{
        node_type: string;
        phase: string;
        input_snapshot_json: string | null;
        input_snapshot_value_id: string | null;
        input_snapshot_hash: string | null;
        selected_edges_json: string;
        current_attempt_id: string | null;
        active_wait_id: string | null;
        row_version: number;
      }>(
        'SELECT node_type, phase, input_snapshot_json, input_snapshot_value_id, input_snapshot_hash, selected_edges_json, current_attempt_id, active_wait_id, row_version FROM workflow_graph_nodes WHERE id = ? AND graph_run_id = ? AND scope_id = ?',
        [input.nodeId, input.graphRunId, input.scopeId],
      );
      if (
        !run ||
        !scope ||
        !node ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        scope.lifecycle !== 'active' ||
        scope.work_fence_epoch !== input.expectedScopeWorkFenceEpoch ||
        node.row_version !== input.expectedNodeRowVersion
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T4 run, scope, node, or work epoch is stale',
        );
      if (node.phase !== 'ready') {
        if (
          node.current_attempt_id ||
          node.active_wait_id ||
          node.phase === 'terminal'
        )
          return {
            disposition: 'exact_replay',
            attemptId: node.current_attempt_id,
            waitId: node.active_wait_id,
            admissionSequence: null,
          };
        throw new G5RuntimeError(
          'precondition_failed',
          'T4 requires a ready node',
        );
      }
      if (['subgraph', 'expand', 'map'].includes(node.node_type))
        throw new G5RuntimeError(
          'forbidden_surface',
          'Dynamic node activation belongs to G6',
        );
      if (
        input.activation.kind === 'execution' &&
        !['delegation', 'system'].includes(node.node_type)
      )
        throw new G5RuntimeError(
          'contract_invalid',
          'Ordinary attempts are only valid for delegation/system nodes',
        );
      if (input.activation.kind === 'wait' && node.node_type !== 'wait')
        throw new G5RuntimeError(
          'contract_invalid',
          'Wait activation requires a wait node',
        );
      if (
        input.activation.kind === 'structural' &&
        !['join', 'terminal'].includes(node.node_type)
      )
        throw new G5RuntimeError(
          'contract_invalid',
          'Structural activation requires join/terminal',
        );
      const activeCount = transaction.queryOne<{ count: number }>(
        input.activation.kind === 'wait'
          ? "SELECT count(*) AS count FROM workflow_graph_waits WHERE status IN ('registering', 'armed')"
          : "SELECT count(*) AS count FROM workflow_graph_node_attempts WHERE phase IN ('preparing', 'dispatch_pending', 'running', 'evaluating')",
        [],
      )!.count;
      const physicalLimit =
        input.activation.kind === 'wait'
          ? capacity.capacity.max_active_waits
          : capacity.capacity.max_active_executions;
      if (activeCount >= physicalLimit)
        return {
          disposition: 'backpressure',
          attemptId: null,
          waitId: null,
          admissionSequence: null,
        };
      const eventSequence = run.next_event_seq + 1;
      if (input.activation.kind === 'structural') {
        const candidateSequence = transaction.queryOne<{ value: number }>(
          'SELECT count(*) + 1 AS value FROM workflow_graph_terminal_candidates WHERE graph_run_id = ? AND scope_id = ?',
          [input.graphRunId, input.scopeId],
        )!.value;
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'terminal', terminal_status = 'succeeded', published_output_envelope_value_id = ?, published_output_envelope_hash = ?, terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'ready'",
            [
              input.activation.output.id,
              input.activation.output.hash,
              input.nowMs,
              input.nowMs,
              input.nodeId,
              input.expectedNodeRowVersion,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T4 structural Node CAS failed',
          );
        if (node.node_type === 'terminal')
          transaction.execute(
            'INSERT INTO workflow_graph_terminal_candidates (id, graph_run_id, scope_id, terminal_node_id, exit_name, output_snapshot_value_id, output_snapshot_hash, candidate_seq, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              stableRuntimeId('terminal-candidate', {
                graph_run_id: input.graphRunId,
                scope_id: input.scopeId,
                terminal_node_id: input.nodeId,
              }),
              input.graphRunId,
              input.scopeId,
              input.nodeId,
              input.nodeId,
              input.activation.output.id,
              input.activation.output.hash,
              candidateSequence,
              input.nowMs,
            ],
          );
        if (
          transaction.execute(
            'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
            [eventSequence, input.nowMs, input.graphRunId, run.row_version],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T4 structural event head CAS failed',
          );
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence: eventSequence,
          scopeId: input.scopeId,
          nodeId: input.nodeId,
          attemptId: null,
          eventType: 'node_terminal',
          idempotencyKey: `structural-terminal:${input.nodeId}`,
          payloadValueId: input.activation.output.id,
          payloadHash: input.activation.output.hash,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        return {
          disposition: 'activated',
          attemptId: null,
          waitId: null,
          admissionSequence: null,
        };
      }
      const reservationGroupId = stableRuntimeId('reservation-group', {
        graph_run_id: input.graphRunId,
        node_id: input.nodeId,
        eligible_event_seq: input.eligibleEventSeq,
      });
      const attemptId = stableRuntimeId('attempt', {
        graph_run_id: input.graphRunId,
        node_id: input.nodeId,
        attempt_no: 1,
      });
      const waitId =
        input.activation.kind === 'wait'
          ? stableRuntimeId('wait', {
              graph_run_id: input.graphRunId,
              node_id: input.nodeId,
            })
          : null;
      const cumulativeResourceType =
        input.activation.kind === 'wait' ? 'waits_total' : 'attempts_total';
      const slotResourceType =
        input.activation.kind === 'wait' ? 'active_waits' : 'active_executions';
      reserveLedgerResources(transaction, {
        graphRunId: input.graphRunId,
        reservationGroupId,
        consumer:
          input.activation.kind === 'wait'
            ? { waitId: waitId! }
            : { attemptId },
        amounts: { [cumulativeResourceType]: 1 },
        purpose: 'scheduler_admission_count',
        settlementMode: 'consume_on_create',
        nowMs: input.nowMs,
      });
      const [slotReservationId] = reserveLedgerResources(transaction, {
        graphRunId: input.graphRunId,
        reservationGroupId,
        consumer:
          input.activation.kind === 'wait'
            ? { waitId: waitId! }
            : { attemptId },
        amounts: { [slotResourceType]: 1 },
        purpose: 'scheduler_admission',
        settlementMode: 'hold_then_release',
        nowMs: input.nowMs,
      });
      if (input.activation.kind === 'execution') {
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
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'preparing', NULL, NULL,
         ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, 'open', ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, 0, NULL, NULL, 1, ?, ?, NULL)`,
          [
            attemptId,
            input.graphRunId,
            input.scopeId,
            input.nodeId,
            node.input_snapshot_json,
            node.input_snapshot_value_id,
            node.input_snapshot_hash,
            node.selected_edges_json,
            input.activation.contextPack.id,
            input.activation.contextPack.hash,
            input.activation.actionName,
            input.activation.queryId,
            input.expectedRunWorkFenceEpoch,
            input.expectedScopeWorkFenceEpoch,
            reservationGroupId,
            input.nowMs,
            input.nowMs,
          ],
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'active', current_attempt_id = ?, current_attempt_no = 1, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'ready'",
            [
              attemptId,
              input.nowMs,
              input.nodeId,
              input.expectedNodeRowVersion,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T4 execution Node CAS failed',
          );
      } else {
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
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'running', NULL, NULL,
         ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, 'open', ?, ?, ?, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, 0, NULL, NULL, 1, ?, ?, NULL)`,
          [
            attemptId,
            input.graphRunId,
            input.scopeId,
            input.nodeId,
            node.input_snapshot_json,
            node.input_snapshot_value_id,
            node.input_snapshot_hash,
            node.selected_edges_json,
            input.activation.contextPack.id,
            input.activation.contextPack.hash,
            input.expectedRunWorkFenceEpoch,
            input.expectedScopeWorkFenceEpoch,
            reservationGroupId,
            input.nowMs,
            input.nowMs,
          ],
        );
        transaction.execute(
          `INSERT INTO workflow_graph_waits (
         id, graph_run_id, scope_id, node_id, wait_type, contract_resource_id,
         contract_resource_hash, correlation_key, correlation_key_hash,
         registration_key, payload_value_id, payload_hash, status, armed_at_ms,
         deadline_at_ms, resolved_at_ms, registration_lease_owner,
         registration_lease_token, registration_lease_expires_at_ms,
         run_work_fence_epoch, scope_work_fence_epoch,
         resource_reservation_group_id, row_version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, NULL,
         NULL, NULL, NULL, ?, ?, ?, 1, ?, ?)`,
          [
            waitId,
            input.graphRunId,
            input.scopeId,
            input.nodeId,
            input.activation.waitType,
            input.activation.contract.rowId,
            input.activation.contract.hash,
            input.activation.correlationKey,
            input.activation.correlationKeyHash,
            `wait-register:${waitId}`,
            input.activation.payload?.id ?? null,
            input.activation.payload?.hash ?? null,
            input.nowMs,
            input.activation.deadlineAtMs,
            input.expectedRunWorkFenceEpoch,
            input.expectedScopeWorkFenceEpoch,
            reservationGroupId,
            input.nowMs,
            input.nowMs,
          ],
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'waiting', current_attempt_id = ?, current_attempt_no = 1, active_wait_id = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'ready'",
            [
              attemptId,
              waitId,
              input.nowMs,
              input.nodeId,
              input.expectedNodeRowVersion,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError('cas_conflict', 'T4 wait Node CAS failed');
      }
      const admissionInsert = transaction.execute(
        `INSERT INTO workflow_graph_scheduler_admissions (
       graph_run_id, scope_id, node_id, attempt_id,
       eligible_event_seq, execution_reservation_id, capacity_config_hash,
       runtime_supported_limits_hash, created_at_ms, capacity_revision,
       capacity_change_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.graphRunId,
          input.scopeId,
          input.nodeId,
          attemptId!,
          input.eligibleEventSeq,
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
          'T4 failed to allocate a global admission sequence',
        );
      const refreshedRun = transaction.queryOne<{
        row_version: number;
        next_event_seq: number;
      }>(
        'SELECT row_version, next_event_seq FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      const sequence = refreshedRun.next_event_seq + 1;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET last_admission_seq = ?, next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [
            admissionSequence,
            sequence,
            input.nowMs,
            input.graphRunId,
            refreshedRun.row_version,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T4 admission head CAS failed',
        );
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: input.scopeId,
        nodeId: input.nodeId,
        attemptId,
        eventType:
          input.activation.kind === 'execution'
            ? 'attempt_created'
            : 'wait_armed',
        idempotencyKey: `admission:${admissionSequence}`,
        payloadJson: {
          capacity_revision: capacity.capacity_revision,
          capacity_change_id: capacity.capacity_change_id,
        } as JsonObject,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      return { disposition: 'activated', attemptId, waitId, admissionSequence };
    },
    fault,
  );
}
