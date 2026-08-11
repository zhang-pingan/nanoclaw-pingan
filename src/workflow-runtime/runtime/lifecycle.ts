import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION } from '../store/runtime-store/config.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import {
  chargeWorkflowLifetimeResources,
  reserveLedgerResources,
} from './ledger.js';

const EMPTY_CHAIN_HASH = `sha256:${'0'.repeat(64)}` as Sha256Hash;

export interface T1ActivationInput {
  readonly workflowId: string;
  readonly expectedWorkflowRowVersion: number;
  readonly stateKey: string;
  readonly stateType: 'delegation' | 'system' | 'interrupt' | 'graph';
  readonly definition: RuntimeRegistryRef;
  readonly definitionVersion: string;
  readonly stateConfig: RuntimeValueRef;
  readonly registrySnapshotId: string;
  readonly registrySnapshotHash: Sha256Hash;
  readonly closureManifestId: string;
  readonly closureHash: Sha256Hash;
  readonly runtimeSafetySnapshot: RuntimeValueRef;
  readonly runtimeSupportedLimits: RuntimeRegistryRef;
  readonly sqliteExecutionProfile: RuntimeRegistryRef;
  readonly sourceSeedHash: Sha256Hash;
  readonly compilerSnapshotHash: Sha256Hash;
  readonly inputSnapshot: RuntimeValueRef;
  readonly runResourceLimits: Readonly<Record<string, number>>;
  readonly checkpoint: JsonObject;
  readonly nowMs: number;
}

export interface T1ActivationReceipt {
  readonly activationId: string;
  readonly graphRunId: string;
  readonly rootScopeId: string;
  readonly rootBuildId: string;
  readonly disposition: 'activated' | 'exact_replay';
}

export function activateWorkflowT1(
  store: WorkflowRuntimeStore,
  input: T1ActivationInput,
  fault?: G5TransactionFault,
): T1ActivationReceipt {
  if (store.schemaVersion !== CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION)
    throw new G5RuntimeError(
      'integrity_violation',
      'T1 requires the current Schema version',
    );
  return runImmediateG5Transaction(
    store,
    (transaction) => activateWorkflowT1InTransaction(transaction, input),
    fault,
  );
}

export function activateWorkflowT1InTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  input: T1ActivationInput,
  options: { readonly writeInitialCheckpoint?: boolean } = {},
): T1ActivationReceipt {
  for (const [label, resource] of Object.entries({
    definition: input.definition,
    runtimeSupportedLimits: input.runtimeSupportedLimits,
    sqliteExecutionProfile: input.sqliteExecutionProfile,
  }))
    assertExactPublishedRegistryResource(transaction, resource, `T1 ${label}`);
  const requiredRunResources = [
    'scopes_total',
    'nodes_total',
    'edges_total',
    'builds_total',
    'build_attempts_total',
    'attempts_total',
    'waits_total',
    'effect_operations_total',
    'facts_total',
    'active_waits',
    'active_executions',
  ] as const;
  for (const resourceType of requiredRunResources) {
    const limit = input.runResourceLimits[resourceType];
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new G5RuntimeError(
        'contract_invalid',
        `T1 requires a finite positive ${resourceType} account`,
      );
  }
  const workflow = transaction.queryOne<{
    status: string;
    operational_state: string;
    state_activation_count: number;
    graph_run_count: number;
    state_instance_id: string;
    current_graph_run_id: string | null;
    row_version: number;
  }>(
    `SELECT status, operational_state, state_activation_count, graph_run_count,
              state_instance_id, current_graph_run_id, row_version
         FROM workflows WHERE id = ?`,
    [input.workflowId],
  );
  if (
    !workflow ||
    workflow.status !== 'active' ||
    workflow.operational_state !== 'healthy'
  ) {
    throw new G5RuntimeError(
      'precondition_failed',
      'T1 requires an active healthy Workflow',
    );
  }
  const activationNo = workflow.state_activation_count + 1;
  const runNo = workflow.graph_run_count + 1;
  const activationId = stableRuntimeId('activation', {
    workflow_id: input.workflowId,
    activation_no: activationNo,
  });
  const graphRunId = stableRuntimeId('run', {
    workflow_id: input.workflowId,
    graph_run_no: runNo,
  });
  const rootScopeId = stableRuntimeId('scope', {
    graph_run_id: graphRunId,
    scope_kind: 'root',
  });
  const rootBuildId = stableRuntimeId('build', {
    graph_run_id: graphRunId,
    invocation_key: 'root',
  });
  const retentionHandleId = stableRuntimeId('retention', {
    graph_run_id: graphRunId,
  });
  const existing = transaction.queryOne<{ graph_run_id: string | null }>(
    'SELECT graph_run_id FROM workflow_state_activations WHERE id = ?',
    [activationId],
  );
  if (existing) {
    if (
      existing.graph_run_id !== graphRunId ||
      workflow.current_graph_run_id !== graphRunId
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'T1 activation identity drift',
      );
    return {
      activationId,
      graphRunId,
      rootScopeId,
      rootBuildId,
      disposition: 'exact_replay',
    };
  }
  if (workflow.row_version !== input.expectedWorkflowRowVersion)
    throw new G5RuntimeError(
      'cas_conflict',
      'T1 Workflow row version is stale',
    );
  transaction.execute(
    `INSERT INTO workflow_state_activations (
       id, workflow_id, state_key, state_type, activation_no,
       workflow_definition_resource_id, workflow_definition_resource_hash,
       workflow_definition_version, state_config_value_id, state_config_hash,
       status, graph_run_id, entered_via_transition_id, terminal_kind,
       terminal_output_value_id, terminal_output_hash, terminal_output_schema_hash,
       terminal_error_code, terminal_error_detail_value_id,
       terminal_error_detail_hash, started_at_ms, finished_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, 1)`,
    [
      activationId,
      input.workflowId,
      input.stateKey,
      input.stateType,
      activationNo,
      input.definition.rowId,
      input.definition.hash,
      input.definitionVersion,
      input.stateConfig.id,
      input.stateConfig.hash,
      graphRunId,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_graph_runs (
       id, workflow_id, state_key, state_instance_id, workflow_definition_version,
       state_config_value_id, state_config_hash, registry_snapshot_id,
       registry_snapshot_hash, registry_retention_handle_id,
       runtime_safety_snapshot_value_id, runtime_safety_snapshot_hash,
       runtime_supported_limits_resource_id, runtime_supported_limits_resource_hash,
       sqlite_execution_profile_resource_id, sqlite_execution_profile_resource_hash,
       source_seed_hash, root_scope_id, root_build_id, root_plan_hash,
       manifest_seq, manifest_head_hash, ledger_seq, ledger_head_hash,
       lifecycle, control, operational_state, root_cancel_scope,
       root_close_request_id, completion_cut_id, work_fence_epoch, outcome_kind,
       exit_name, output_value_id, output_hash, error_code, error_detail_value_id,
       error_detail_hash, next_event_seq, last_admission_seq, row_version,
       started_at_ms, finished_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 0, ?, 'initializing', 'running', 'healthy', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 2, NULL, 1, ?, NULL, ?, ?)`,
    [
      graphRunId,
      input.workflowId,
      input.stateKey,
      activationId,
      input.definitionVersion,
      input.stateConfig.id,
      input.stateConfig.hash,
      input.registrySnapshotId,
      input.registrySnapshotHash,
      retentionHandleId,
      input.runtimeSafetySnapshot.id,
      input.runtimeSafetySnapshot.hash,
      input.runtimeSupportedLimits.rowId,
      input.runtimeSupportedLimits.hash,
      input.sqliteExecutionProfile.rowId,
      input.sqliteExecutionProfile.hash,
      input.sourceSeedHash,
      rootScopeId,
      rootBuildId,
      EMPTY_CHAIN_HASH,
      EMPTY_CHAIN_HASH,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_registry_retention_handles (
       id, handle_kind, pack_release_id, graph_run_id, backup_id,
       external_actor_ref, closure_manifest_id, closure_hash, status,
       created_at_ms, released_at_ms, row_version
     ) VALUES (?, 'active_run', NULL, ?, NULL, NULL, ?, ?, 'held', ?, NULL, 1)`,
    [
      retentionHandleId,
      graphRunId,
      input.closureManifestId,
      input.closureHash,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_graph_scopes (
       id, graph_run_id, parent_scope_id, owner_node_id, child_key, scope_kind,
       depth, plan_id, plan_hash, input_snapshot_json, input_snapshot_value_id,
       input_snapshot_hash, materialization_reservation_group_id,
       owner_run_work_fence_epoch, owner_scope_work_fence_epoch, lifecycle,
       work_fence_epoch, outcome_kind, exit_name, candidate_node_id,
       output_value_id, output_hash, error_code, error_detail_value_id,
       error_detail_hash, close_request_id, completion_cut_id,
       next_resolution_seq, next_candidate_seq, row_version, created_at_ms,
       finished_at_ms, updated_at_ms
     ) VALUES (?, ?, NULL, NULL, NULL, 'root', 0, NULL, NULL, NULL, ?, ?, NULL, 0, 0, 'materializing', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 1, ?, NULL, ?)`,
    [
      rootScopeId,
      graphRunId,
      input.inputSnapshot.id,
      input.inputSnapshot.hash,
      input.nowMs,
      input.nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_graph_scope_builds (
       id, graph_run_id, owner_scope_id, owner_node_id, target_scope_id,
       invocation_key, scope_kind, item_key_json, item_index, source_seed_json,
       source_seed_value_id, source_seed_hash, source_snapshot_json,
       source_snapshot_value_id, source_snapshot_hash, input_snapshot_json,
       input_snapshot_value_id, input_snapshot_hash, compiler_snapshot_hash,
       run_work_fence_epoch, owner_scope_work_fence_epoch, status,
       compiled_plan_id, compiled_plan_hash, scope_id,
       materialization_reservation_group_id, attempt_count, next_attempt_at_ms,
       deadline_at_ms, lease_owner, lease_token, lease_expires_at_ms, error_code,
       error_detail_value_id, error_detail_hash, row_version, created_at_ms,
       updated_at_ms
     ) VALUES (?, ?, NULL, NULL, ?, 'root', 'root', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 0, 0, 'ready_to_compile', NULL, NULL, NULL, NULL, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
    [
      rootBuildId,
      graphRunId,
      rootScopeId,
      input.sourceSeedHash,
      input.inputSnapshot.id,
      input.inputSnapshot.hash,
      input.compilerSnapshotHash,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    ],
  );
  for (const [resourceType, hardLimit] of Object.entries(
    input.runResourceLimits,
  ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    transaction.execute(
      `INSERT INTO workflow_graph_resource_accounts (
         id, deployment_scope_ref, workflow_id, graph_run_id, scope_id, node_id,
         execution_group_resource_id, execution_group_resource_hash,
         resource_type, hard_limit, reserved_amount, consumed_amount, row_version
       ) VALUES (?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, 0, 0, 1)`,
      [
        stableRuntimeId('account', {
          graph_run_id: graphRunId,
          resource_type: resourceType,
        }),
        graphRunId,
        resourceType,
        hardLimit,
      ],
    );
  }
  chargeWorkflowLifetimeResources(transaction, {
    graphRunId,
    workflowId: input.workflowId,
    reservationGroupId: stableRuntimeId('reservation-group', {
      graph_run_id: graphRunId,
      workflow_id: input.workflowId,
      purpose: 'state_activation_and_run',
    }),
    amounts: { state_activations_total: 1, graph_runs_total: 1 },
    purpose: 'state_activation_and_run',
    nowMs: input.nowMs,
  });
  reserveLedgerResources(transaction, {
    graphRunId,
    reservationGroupId: stableRuntimeId('reservation-group', {
      graph_run_id: graphRunId,
      build_id: rootBuildId,
      purpose: 'root_build_create',
    }),
    consumer: { buildId: rootBuildId },
    amounts: { builds_total: 1, build_attempts_total: 1 },
    purpose: 'root_build_create',
    settlementMode: 'consume_on_create',
    nowMs: input.nowMs,
  });
  transaction.execute(
    `INSERT INTO workflow_graph_events (
       graph_run_id, seq, scope_id, node_id, attempt_id, event_type,
       idempotency_key, payload_json, payload_value_id, payload_hash,
       occurred_at_ms, created_at_ms
     ) VALUES (?, 1, NULL, NULL, NULL, 'state_activation_created', ?, NULL, NULL, NULL, ?, ?)`,
    [graphRunId, `activation:${activationId}`, input.nowMs, input.nowMs],
  );
  transaction.execute(
    `INSERT INTO workflow_graph_events (
       graph_run_id, seq, scope_id, node_id, attempt_id, event_type,
       idempotency_key, payload_json, payload_value_id, payload_hash,
       occurred_at_ms, created_at_ms
     ) VALUES (?, 2, ?, NULL, NULL, 'run_created', ?, NULL, NULL, NULL, ?, ?)`,
    [graphRunId, rootScopeId, `run:${graphRunId}`, input.nowMs, input.nowMs],
  );
  if (options.writeInitialCheckpoint !== false)
    transaction.execute(
      `INSERT INTO workflow_checkpoints (
       id, workflow_id, checkpoint_version, workflow_revision,
       source_state_instance_id, source_run_id, completion_cut_id,
       snapshot_json, snapshot_value_id, snapshot_hash, created_at_ms
     ) VALUES (?, ?, 1, 0, ?, ?, NULL, ?, NULL, ?, ?)`,
      [
        stableRuntimeId('checkpoint', {
          workflow_id: input.workflowId,
          checkpoint_version: 1,
        }),
        input.workflowId,
        activationId,
        graphRunId,
        JSON.stringify(input.checkpoint),
        input.runtimeSafetySnapshot.hash,
        input.nowMs,
      ],
    );
  const changed = transaction.execute(
    `UPDATE workflows
          SET state_activation_count = ?, graph_run_count = ?,
              state_instance_id = ?, current_graph_run_id = ?,
              row_version = row_version + 1,
              updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND status = 'active'
          AND operational_state = 'healthy'`,
    [
      activationNo,
      runNo,
      activationId,
      graphRunId,
      input.nowMs,
      input.workflowId,
      input.expectedWorkflowRowVersion,
    ],
  ).changes;
  if (changed !== 1)
    throw new G5RuntimeError('cas_conflict', 'T1 Workflow CAS failed');
  return {
    activationId,
    graphRunId,
    rootScopeId,
    rootBuildId,
    disposition: 'activated',
  };
}
