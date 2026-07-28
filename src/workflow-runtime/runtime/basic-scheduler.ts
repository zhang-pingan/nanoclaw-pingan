import type { CapacitySnapshotWatcher } from '../capacity/publication.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  insertGraphEvent,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { reserveLedgerResources } from './ledger.js';
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
} from './plan-authority.js';
import { persistStructuralNodeOutputEnvelope } from './generated-schema-runtime.js';

export type T4ActivationRequest =
  | {
      readonly kind: 'execution';
    }
  | {
      readonly kind: 'wait';
    }
  | {
      readonly kind: 'structural';
    }
  | {
      readonly kind: 'child_owner';
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
        activation_event_seq: number | null;
        run_work_fence_epoch_at_activation: number | null;
        scope_work_fence_epoch_at_activation: number | null;
        published_output_envelope_value_id: string | null;
        published_output_envelope_hash: string | null;
        port_contract_hash: string;
        row_version: number;
      }>(
        'SELECT node_type, phase, input_snapshot_json, input_snapshot_value_id, input_snapshot_hash, selected_edges_json, current_attempt_id, active_wait_id, activation_event_seq, run_work_fence_epoch_at_activation, scope_work_fence_epoch_at_activation, published_output_envelope_value_id, published_output_envelope_hash, port_contract_hash, row_version FROM workflow_graph_nodes WHERE id = ? AND graph_run_id = ? AND scope_id = ?',
        [input.nodeId, input.graphRunId, input.scopeId],
      );
      const authority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
        input.nodeId,
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
        authority.runWorkFenceEpoch !== input.expectedRunWorkFenceEpoch ||
        authority.scopeWorkFenceEpoch !== input.expectedScopeWorkFenceEpoch ||
        node.activation_event_seq !== input.eligibleEventSeq ||
        node.run_work_fence_epoch_at_activation !==
          input.expectedRunWorkFenceEpoch ||
        node.scope_work_fence_epoch_at_activation !==
          input.expectedScopeWorkFenceEpoch
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T4 run, scope, node, or work epoch is stale',
        );
      const childOwner = ['subgraph', 'expand', 'map'].includes(node.node_type);
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
      if (input.activation.kind === 'child_owner' && !childOwner)
        throw new G5RuntimeError(
          'contract_invalid',
          'Child-owner activation requires subgraph/expand/map',
        );
      if (input.activation.kind !== 'child_owner' && childOwner)
        throw new G5RuntimeError(
          'contract_invalid',
          'Dynamic nodes require child-owner activation',
        );
      const derivedInput =
        node.input_snapshot_value_id !== null &&
        node.input_snapshot_hash !== null
          ? {
              id: node.input_snapshot_value_id,
              hash: node.input_snapshot_hash,
            }
          : (transaction.queryOne<{ id: string; hash: string }>(
              `SELECT r.value_value_id AS id, r.value_hash AS hash
                 FROM workflow_graph_edges e
                 JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
                WHERE e.graph_run_id = ? AND e.scope_id = ?
                  AND json_extract(e.compiled_edge_json, '$.to.node_id') = ?
                  AND r.state = 'available'
                ORDER BY e.edge_key COLLATE BINARY LIMIT 1`,
              [input.graphRunId, input.scopeId, String(authority.node.id)],
            ) ??
            transaction.queryOne<{ id: string; hash: string }>(
              `SELECT source.published_output_envelope_value_id AS id,
                      source.published_output_envelope_hash AS hash
                 FROM workflow_graph_edges e
                 JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
                 JOIN workflow_graph_nodes source
                   ON source.graph_run_id = e.graph_run_id
                  AND source.scope_id = e.scope_id
                  AND source.node_key = json_extract(e.compiled_edge_json, '$.from_node_id')
                WHERE e.graph_run_id = ? AND e.scope_id = ?
                  AND json_extract(e.compiled_edge_json, '$.to_node_id') = ?
                  AND r.state = 'taken'
                  AND source.published_output_envelope_value_id IS NOT NULL
                ORDER BY e.edge_key COLLATE BINARY LIMIT 1`,
              [input.graphRunId, input.scopeId, String(authority.node.id)],
            ));
      if (!derivedInput)
        throw new G5RuntimeError(
          'integrity_violation',
          'T4 requires a Plan-derived sealed input Value',
        );
      const contextPack = {
        id: derivedInput.id,
        hash: derivedInput.hash as `sha256:${string}`,
      };
      const structuralOutput =
        input.activation.kind === 'structural'
          ? (() => {
              if (node.input_snapshot_json === null)
                throw new G5RuntimeError(
                  'integrity_violation',
                  'T4 structural node requires a canonical input snapshot',
                );
              const output = persistStructuralNodeOutputEnvelope(transaction, {
                identity: {
                  planId: authority.planId,
                  graphRunId: authority.graphRunId,
                  planHash: authority.planHash,
                  plan: authority.plan,
                },
                node: authority.node,
                inputSnapshotJson: node.input_snapshot_json,
                carrierValueId: contextPack.id,
                carrierValueHash: contextPack.hash,
                nowMs: input.nowMs,
              });
              if (node.port_contract_hash !== output.portContractHash)
                throw new G5RuntimeError(
                  'integrity_violation',
                  'T4 structural Node output port Contract drifted',
                );
              return output;
            })()
          : null;
      if (node.phase !== 'ready') {
        if (
          input.activation.kind === 'structural' &&
          node.phase === 'terminal' &&
          structuralOutput !== null &&
          node.row_version === input.expectedNodeRowVersion + 1
        ) {
          if (
            node.published_output_envelope_value_id !== structuralOutput.id ||
            node.published_output_envelope_hash !== structuralOutput.hash ||
            node.port_contract_hash !== structuralOutput.portContractHash
          )
            throw new G5RuntimeError(
              'integrity_violation',
              'T4 structural exact replay publication drifted',
            );
          const event = transaction.queryOne<{
            payload_value_id: string | null;
            payload_hash: string | null;
          }>(
            "SELECT payload_value_id, payload_hash FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = ? AND event_type = 'node_terminal'",
            [input.graphRunId, `structural-terminal:${input.nodeId}`],
          );
          if (
            !event ||
            event.payload_value_id !== structuralOutput.id ||
            event.payload_hash !== structuralOutput.hash
          )
            throw new G5RuntimeError(
              'integrity_violation',
              'T4 structural exact replay event drifted',
            );
          return {
            disposition: 'exact_replay',
            attemptId: null,
            waitId: null,
            admissionSequence: null,
          };
        }
        if (node.current_attempt_id || node.active_wait_id)
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
      if (node.row_version !== input.expectedNodeRowVersion)
        throw new G5RuntimeError(
          'cas_conflict',
          'T4 Node row version is stale',
        );
      let waitBinding: JsonObject | null = null;
      let waitContract: {
        rowId: string;
        resourceType: string;
        ref: { id: string; version: string };
        hash: `sha256:${string}`;
      } | null = null;
      if (input.activation.kind === 'wait') {
        waitBinding = requiredObjectField(
          authority.node,
          'wait_binding',
          'Plan node',
        );
        const contractSnapshot = requiredObjectField(
          waitBinding,
          'contract_snapshot',
          'Plan wait_binding',
        );
        const contractRef = requiredObjectField(
          waitBinding,
          'contract_ref',
          'Plan wait_binding',
        );
        if (
          canonicalJson(contractRef) !== canonicalJson(contractSnapshot.ref) ||
          contractSnapshot.contract_hash === undefined
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T4 wait Contract snapshot identity drifted',
          );
        waitContract = {
          rowId: registryResourceId({
            resource_type: 'wait_contract',
            ref: {
              id: String(contractRef.id),
              version: String(contractRef.version),
            },
          }),
          resourceType: 'wait_contract',
          ref: {
            id: String(contractRef.id),
            version: String(contractRef.version),
          },
          hash: String(contractSnapshot.contract_hash) as `sha256:${string}`,
        };
        assertExactPublishedRegistryResource(
          transaction,
          waitContract,
          'T4 Plan-pinned wait Contract',
        );
      }
      if (
        input.activation.kind !== 'structural' &&
        input.activation.kind !== 'child_owner'
      ) {
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
      }
      const eventSequence = run.next_event_seq + 1;
      if (input.activation.kind === 'child_owner') {
        if (
          transaction.execute(
            `UPDATE workflow_graph_nodes
                SET phase = 'active', row_version = row_version + 1,
                    updated_at_ms = ?
              WHERE id = ? AND row_version = ? AND phase = 'ready'
                AND controller_state = 'sealing'`,
            [input.nowMs, input.nodeId, input.expectedNodeRowVersion],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T4 child-owner Node CAS failed',
          );
        if (
          transaction.execute(
            `UPDATE workflow_graph_runs
                SET next_event_seq = ?, row_version = row_version + 1,
                    updated_at_ms = ?
              WHERE id = ? AND row_version = ?`,
            [eventSequence, input.nowMs, input.graphRunId, run.row_version],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'T4 child-owner event head CAS failed',
          );
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence: eventSequence,
          scopeId: input.scopeId,
          nodeId: input.nodeId,
          attemptId: null,
          eventType: 'scheduler_admitted',
          idempotencyKey: `child-owner-admitted:${input.nodeId}`,
          payloadJson: { node_type: node.node_type },
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
      if (input.activation.kind === 'structural') {
        if (structuralOutput === null)
          throw new G5RuntimeError(
            'integrity_violation',
            'T4 structural output was not materialized',
          );
        const candidateSequence = transaction.queryOne<{ value: number }>(
          'SELECT count(*) + 1 AS value FROM workflow_graph_terminal_candidates WHERE graph_run_id = ? AND scope_id = ?',
          [input.graphRunId, input.scopeId],
        )!.value;
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'terminal', terminal_status = 'succeeded', published_output_envelope_value_id = ?, published_output_envelope_hash = ?, port_contract_hash = ?, terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'ready'",
            [
              structuralOutput.id,
              structuralOutput.hash,
              structuralOutput.portContractHash,
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
        if (node.node_type === 'terminal') {
          if (
            typeof authority.node.exit !== 'string' ||
            authority.node.exit.length === 0
          )
            throw new G5RuntimeError(
              'integrity_violation',
              'T4 terminal candidate requires the Plan-pinned named exit',
            );
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
              authority.node.exit,
              structuralOutput.id,
              structuralOutput.hash,
              candidateSequence,
              input.nowMs,
            ],
          );
        }
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
          payloadValueId: structuralOutput.id,
          payloadHash: structuralOutput.hash,
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
            contextPack.id,
            contextPack.hash,
            null,
            null,
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
            contextPack.id,
            contextPack.hash,
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
            String(waitBinding!.type),
            waitContract!.rowId,
            waitContract!.hash,
            `plan-input:${contextPack.id}`,
            contextPack.hash,
            `wait-register:${waitId}`,
            contextPack.id,
            contextPack.hash,
            input.nowMs,
            Number(waitBinding!.effective_max_duration_ms) > 0
              ? input.nowMs + Number(waitBinding!.effective_max_duration_ms)
              : null,
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
