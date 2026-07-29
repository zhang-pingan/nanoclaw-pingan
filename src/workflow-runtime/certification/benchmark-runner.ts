import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type {
  G8BenchmarkCaseObservation,
  G8BenchmarkProfile,
  G8BenchmarkStatistics,
  G8BenchmarkTransaction,
  G8SupportedLimitValues,
} from '../contracts/g8-certification-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import {
  G8_BENCHMARK_PROFILES,
  G8_BENCHMARK_SHAPES,
  G8_PRODUCT_FLOOR_COVERAGE,
  G8_SUPPORTED_LIMITS,
  G8SupportedLimitError,
  assertG8DimensionsWithinSupportedLimits,
  invokeWithinG8SupportedLimits,
  percentile,
} from '../contracts/g8-limits.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeIdentityMode } from '../store/runtime-store/identity.js';
import {
  buildDeploymentCapacityPublication,
  calculateDeploymentCapacityConfigHash,
} from '../contracts/capacity-control-plane-source.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
  type WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { requestScopeCloseT7a } from '../runtime/graph-runtime.js';
import {
  assertNoDeferredForeignKeyViolations,
  stableRuntimeId,
} from '../runtime/graph-store.js';
import { scheduleReadyNodeT4 } from '../runtime/basic-scheduler.js';
import {
  createG6MapFixture,
  g6Hash,
  type G6MapFixture,
} from '../runtime/g6-test-support.js';
import { openG5IsolatedBootstrap } from '../runtime/g5-test-bootstrap.js';
import {
  initializeScopeFixedPointT3a,
  reconcileFactT3a,
} from '../runtime/reconciler.js';
import { acceptInternalResultT6a } from '../runtime/node-execution.js';
import {
  calculateCreationIntentHash,
  prepareRequiredFinalizationT0p,
} from '../creation/task-intake.js';
import {
  commitRootT8,
  recordRootFinalizationAttempt,
} from '../runtime/root-finalizer.js';
import {
  compileG8T3Fixture,
  g8T3ShapeDimensions,
  type G8T3Shape,
} from './benchmark-shapes.js';

const T3_INDEX_EVIDENCE = [
  'query:t3_affected_edges->idx:edges:scope_kind',
  'query:t3_fact_frontier->idx:facts:scope_event',
  'query:t3_fact_queue->idx:facts:queue',
] as const;

const T7_INDEX_EVIDENCE = [
  'recursive-subtree-anchor->sqlite_autoindex_workflow_graph_scopes_2',
  'recursive-subtree-child->idx:scopes:parent',
  'staged-subtree-membership->temp.workflow_runtime_transient_id_sets',
] as const;

const T8_INDEX_EVIDENCE = [
  'required-schedule->idx:root_finalization_schedules:close_status',
  'child-creation->uk:workflows:creation',
  'child-relation->uk:workflow_relations:effect',
  'claim-handoff->uk:domain_claim_handoffs:parent',
] as const;

const NORMAL_PROFILES = G8_BENCHMARK_PROFILES.filter(
  (profile) => profile !== 'beyond_limit',
);

interface PreparedBenchmarkCase {
  readonly transaction: G8BenchmarkTransaction;
  readonly shape: string;
  readonly profile: G8BenchmarkProfile;
  readonly scalePercent: number;
  readonly baseDatabasePath: string;
  readonly dimensions: JsonObject;
  readonly supportedLimitDimensions: Partial<G8SupportedLimitValues>;
  readonly productionEntry: string;
  readonly productionIndexEvidence: readonly string[];
  readonly correctnessInvariants: readonly string[];
  readonly invoke: (store: WorkflowRuntimeStore) => void;
  readonly verify: (store: WorkflowRuntimeStore) => void;
}

interface BenchmarkSample {
  readonly durationMs: number;
  readonly walBytes: number;
  readonly peakRssBytes: number;
  readonly affectedRows: number;
}

export interface RunG8BenchmarkOptions {
  readonly rootDir: string;
  readonly identityMode: WorkflowRuntimeIdentityMode;
  readonly warmupIterations?: number;
  readonly measurementIterations?: number;
  readonly profiles?: readonly G8BenchmarkProfile[];
  readonly transactions?: readonly G8BenchmarkTransaction[];
  readonly shapes?: Readonly<
    Partial<Record<G8BenchmarkTransaction, readonly string[]>>
  >;
  readonly onCaseCompleted?: (observation: G8BenchmarkCaseObservation) => void;
}

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function fileBytes(filePath: string): number {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function scaleForProfile(profile: G8BenchmarkProfile): number {
  switch (profile) {
    case 'smoke':
      return 1 / 32;
    case 'scaling_25':
      return 0.25;
    case 'scaling_50':
      return 0.5;
    case 'scaling_100':
    case 'supported_limit':
      return 1;
    case 'beyond_limit':
      return 1;
  }
}

function scalePercent(profile: G8BenchmarkProfile): number {
  if (profile === 'smoke') return 3.125;
  if (profile === 'scaling_25') return 25;
  if (profile === 'scaling_50') return 50;
  return 100;
}

function integerScale(maximum: number, profile: G8BenchmarkProfile): number {
  return Math.max(1, Math.ceil(maximum * scaleForProfile(profile)));
}

function assertEmptyDirectory(rootDir: string): string {
  const canonical = fs.realpathSync(rootDir);
  if (
    !fs.statSync(canonical).isDirectory() ||
    fs.readdirSync(canonical).length !== 0
  ) {
    throw new Error('G8 benchmark root must be an existing empty directory');
  }
  return canonical;
}

function runRow(fixture: G6MapFixture): {
  row_version: number;
  work_fence_epoch: number;
} {
  const row = fixture.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
  }>(
    'SELECT row_version, work_fence_epoch FROM workflow_graph_runs WHERE id = ?',
    [fixture.graphRunId],
  );
  if (!row) throw new Error('G8 benchmark Graph Run is missing');
  return row;
}

function scopeRow(
  fixture: G6MapFixture,
  scopeId: string,
): { row_version: number; work_fence_epoch: number } {
  const row = fixture.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
  }>(
    `SELECT row_version, work_fence_epoch
       FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
    [scopeId, fixture.graphRunId],
  );
  if (!row) throw new Error(`G8 benchmark Scope is missing: ${scopeId}`);
  return row;
}

function benchmarkLimits(): Record<string, number> {
  return {
    scopes_total: G8_SUPPORTED_LIMITS.max_scopes_total,
    nodes_total: G8_SUPPORTED_LIMITS.max_nodes_total,
    edges_total: G8_SUPPORTED_LIMITS.max_edges_total,
    map_items_total: G8_SUPPORTED_LIMITS.max_map_items_total,
    builds_total: G8_SUPPORTED_LIMITS.max_builds_total,
    build_attempts_total: G8_SUPPORTED_LIMITS.max_builds_total * 3,
    attempts_total: G8_SUPPORTED_LIMITS.max_attempts_total,
    waits_total: G8_SUPPORTED_LIMITS.max_waits_total,
    effect_operations_total: G8_SUPPORTED_LIMITS.max_effect_operations_total,
    facts_total: 262144,
    active_waits: 512,
    active_executions: 1024,
  };
}

function benchmarkCapacityPublication() {
  const values = {
    max_active_executions: 1024,
    max_active_waits: 512,
    max_pending_signals: 512,
    max_outbox_inflight: 512,
    max_physical_blob_bytes: 21_474_836_480,
    soft_blob_high_water_bytes: 17_179_869_184,
    minimum_free_disk_bytes: 5_368_709_120,
  };
  return buildDeploymentCapacityPublication(1, 'g8-benchmark-capacity', null, {
    ...values,
    config_hash: calculateDeploymentCapacityConfigHash(values),
  });
}

function installBenchmarkCapacity(fixture: G6MapFixture): void {
  const capacity = benchmarkCapacityPublication();
  fixture.instance.store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO runtime_capacity_admin_commands (
       command_id, idempotency_domain, idempotency_key, command_type,
       expected_capacity_revision, expected_config_hash,
       assigned_capacity_revision, assigned_change_id,
       genesis_core_release_hash, proposed_capacity_json,
       proposed_config_hash, request_hash, reason_code, reason_text_value_id,
       reason_text_hash, evidence_manifest_value_id, evidence_manifest_hash,
       canonical_result_value_id, canonical_result_hash, created_at_ms,
       finalized_at_ms
     ) VALUES ('capacity:g8-benchmark', 'deployment_capacity',
       'capacity:g8-benchmark', 'initialize_deployment_capacity', NULL, NULL,
       1, ?, ?, ?, ?, ?, 'initial_provisioning', NULL, NULL, ?, ?, ?, ?,
       1, 1)`,
      [
        capacity.capacity_change_id,
        g6Hash('g8-benchmark-core-release'),
        canonicalJson(capacity.capacity as unknown as JsonValue),
        capacity.capacity.config_hash,
        g6Hash('g8-benchmark-capacity-request'),
        fixture.seed.values.context!.id,
        fixture.seed.values.context!.hash,
        fixture.seed.values.input!.id,
        fixture.seed.values.input!.hash,
      ],
    );
    transaction.execute(
      `INSERT INTO runtime_capacity_head (
       singleton_key, current_capacity_revision, current_change_id,
       current_config_hash, current_publication_hash, pending_change_id,
       row_version, created_at_ms, updated_at_ms
     ) VALUES (1, 1, ?, ?, ?, NULL, 1, 1, 1)`,
      [
        capacity.capacity_change_id,
        capacity.capacity.config_hash,
        capacity.publication_hash,
      ],
    );
    assertNoDeferredForeignKeyViolations(transaction, 'G8 benchmark Capacity');
  });
}

function prepareT3Case(
  caseRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
  shape: G8T3Shape,
  profile: G8BenchmarkProfile,
): PreparedBenchmarkCase {
  const nodeCount = Math.max(4, integerScale(128, profile));
  const compiled = compileG8T3Fixture(shape, nodeCount);
  const instance = openG5IsolatedBootstrap(caseRoot, identityMode);
  const fixture = createG6MapFixture(`g8-t3-${shape}-${profile}`, {
    compiledFixture: compiled,
    bootstrapInstance: instance,
    runResourceLimits: benchmarkLimits(),
  });
  installBenchmarkCapacity(fixture);
  initializeScopeFixedPointT3a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion: runRow(fixture).row_version,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs: 100,
  });
  const source = fixture.instance.store.queryOne<{
    id: string;
    phase: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    `SELECT id, phase, row_version, activation_event_seq
       FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ? AND node_key = 'node-0000'`,
    [fixture.graphRunId, fixture.rootScopeId],
  );
  if (!source || source.phase !== 'ready') {
    throw new Error(`G8 T3 ${shape} source node did not become ready`);
  }
  const admission = scheduleReadyNodeT4(
    fixture.instance.store,
    {
      current: () => benchmarkCapacityPublication(),
    },
    {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      nodeId: source.id,
      expectedNodeRowVersion: source.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: source.activation_event_seq,
      activation: { kind: 'execution' },
      nowMs: 101,
    },
  );
  if (!admission.attemptId)
    throw new Error('G8 T3 source execution admission failed');
  fixture.instance.store.withImmediateTransaction((transaction) => {
    if (
      transaction.execute(
        `UPDATE workflow_graph_node_attempts
            SET phase = 'dispatch_pending', row_version = row_version + 1,
                updated_at_ms = 102
          WHERE id = ? AND phase = 'preparing'`,
        [admission.attemptId],
      ).changes !== 1
    )
      throw new Error('G8 T3 source Attempt dispatch preparation failed');
  });
  const attempt = fixture.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_node_attempts WHERE id = ?',
    [admission.attemptId],
  )!;
  const sourcePlanNode = (compiled.plan.nodes as JsonObject[]).find(
    (node) => node.id === 'node-0000',
  );
  const sourcePortContracts = sourcePlanNode?.output_ports;
  if (
    !sourcePortContracts ||
    typeof sourcePortContracts !== 'object' ||
    Array.isArray(sourcePortContracts)
  ) {
    throw new Error('G8 T3 source output port authority is unavailable');
  }
  const outputValue = {
    id: 'value:g8:t3-output',
    hash: g6Hash(`g8-t3-output:${shape}:${profile}`),
  };
  const outputContent = canonicalJson({ ok: true });
  fixture.instance.store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
       ?, ?, 'g8-benchmark', 'run_recovery', 'live', NULL, 103, 1)`,
      [
        outputValue.id,
        outputContent,
        outputValue.hash,
        Buffer.byteLength(outputContent),
        fixture.seed.refs.schema!.rowId,
        fixture.seed.refs.schema!.hash,
      ],
    );
  });
  const outputPorts = Object.fromEntries(
    Object.keys(sourcePortContracts).map((portName) => [portName, outputValue]),
  );
  acceptInternalResultT6a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    nodeId: source.id,
    attemptId: admission.attemptId,
    expectedAttemptRowVersion: attempt.row_version,
    leaseOwner: null,
    leaseToken: null,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    executionOutcome: 'succeeded',
    qualityDecision: 'pass',
    result: outputValue,
    outputPorts,
    evaluation: null,
    feedback: null,
    errorCode: null,
    factPayload: outputValue,
    nowMs: 103,
  });
  const sourceOutput = fixture.instance.store.queryOne<{
    id: string;
    hash: Sha256Hash;
  }>(
    `SELECT published_output_envelope_value_id AS id,
            published_output_envelope_hash AS hash
       FROM workflow_graph_nodes WHERE id = ?`,
    [source.id],
  );
  if (!sourceOutput?.id || !sourceOutput.hash)
    throw new Error('G8 T3 source output envelope is unavailable');
  const expectedRunRowVersion = runRow(fixture).row_version;
  const dimensions = {
    ...g8T3ShapeDimensions(compiled),
    max_scopes_total: 1,
  };
  assertG8DimensionsWithinSupportedLimits(dimensions);
  const input: Parameters<typeof reconcileFactT3a>[1] = {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion,
    factKind: 'node_terminal',
    stableObjectKind: 'node',
    stableObjectId: source.id,
    factKey: `g8-benchmark-t3:${shape}:${profile}`,
    payload: sourceOutput,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    terminalStatus: 'succeeded',
    nowMs: 102,
  };
  fixture.instance.closeStore();
  return {
    transaction: 't3',
    shape,
    profile,
    scalePercent: scalePercent(profile),
    baseDatabasePath: fixture.instance.databasePath,
    dimensions,
    supportedLimitDimensions: dimensions,
    productionEntry: 'reconcileFactT3a',
    productionIndexEvidence: T3_INDEX_EVIDENCE,
    correctnessInvariants: [
      'terminal ingress fact is backed by persisted Node output',
      'fixed-point facts and edge resolutions commit atomically',
      'Graph Run event head advances by CAS exactly once',
    ],
    invoke: (store) => {
      const receipt = reconcileFactT3a(store, input);
      if (receipt.disposition !== 'reconciled')
        throw new Error('G8 T3 benchmark unexpectedly replayed');
    },
    verify: (store) => {
      const fact = store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?',
        [fixture.graphRunId, input.factKey],
      );
      if (fact?.count !== 1)
        throw new Error('G8 T3 ingress fact did not commit exactly once');
    },
  };
}

interface T7Dimensions {
  readonly scopeCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly attemptCount: number;
  readonly waitCount: number;
  readonly buildCount: number;
  readonly mapItemCount: number;
  readonly effectCount: number;
  readonly nodesPerScopeMaximum: number;
  readonly edgesPerScopeMaximum: number;
}

function t7Dimensions(profile: G8BenchmarkProfile): T7Dimensions {
  return {
    scopeCount: integerScale(G8_SUPPORTED_LIMITS.max_scopes_total, profile),
    nodeCount: integerScale(G8_SUPPORTED_LIMITS.max_nodes_total, profile),
    edgeCount: integerScale(G8_SUPPORTED_LIMITS.max_edges_total, profile),
    attemptCount: integerScale(G8_SUPPORTED_LIMITS.max_attempts_total, profile),
    waitCount: integerScale(G8_SUPPORTED_LIMITS.max_waits_total, profile),
    buildCount: integerScale(G8_SUPPORTED_LIMITS.max_builds_total, profile),
    mapItemCount: integerScale(
      G8_SUPPORTED_LIMITS.max_map_items_total,
      profile,
    ),
    effectCount: integerScale(
      G8_SUPPORTED_LIMITS.max_effect_operations_total,
      profile,
    ),
    nodesPerScopeMaximum: integerScale(
      G8_PRODUCT_FLOOR_COVERAGE.max_nodes_per_scope,
      profile,
    ),
    edgesPerScopeMaximum: integerScale(
      G8_PRODUCT_FLOOR_COVERAGE.max_edges_per_scope,
      profile,
    ),
  };
}

function distribute(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from(
    { length: buckets },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

function distributeWithFirst(
  total: number,
  buckets: number,
  first: number,
): number[] {
  if (buckets < 1 || first > total)
    throw new Error('G8 benchmark distribution is invalid');
  return [first, ...distribute(total - first, buckets - 1)];
}

function t7ParentIndex(shape: string, index: number): number {
  if (index === 0) return -1;
  if (shape === 'wide_tree' || shape === 'effect_heavy_subtree') return 0;
  if (shape === 'deep_tree') return index <= 8 ? index - 1 : index % 8;
  if (shape === 'large_nested_map')
    return Math.max(0, index - (index % 8 || 8));
  return Math.floor((index - 1) / 2);
}

function cloneScope(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  scopeId: string,
  parentScopeId: string,
  ownerNodeId: string,
  depth: number,
  scopeKind: 'subgraph' | 'map_item',
  lifecycle: 'active' | 'materializing',
): void {
  transaction.execute(
    `INSERT INTO workflow_graph_scopes (
       id, graph_run_id, parent_scope_id, owner_node_id, child_key,
       scope_kind, depth, plan_id, plan_hash, input_snapshot_json,
       input_snapshot_value_id, input_snapshot_hash,
       materialization_reservation_group_id, owner_run_work_fence_epoch,
       owner_scope_work_fence_epoch, lifecycle, work_fence_epoch,
       outcome_kind, exit_name, candidate_node_id, output_value_id,
       output_hash, error_code, error_detail_value_id, error_detail_hash,
       close_request_id, completion_cut_id, next_resolution_seq,
       next_candidate_seq, row_version, created_at_ms, finished_at_ms,
       updated_at_ms)
     SELECT ?, graph_run_id, ?, ?, ?, ?, ?, plan_id, plan_hash,
            input_snapshot_json, input_snapshot_value_id, input_snapshot_hash,
            NULL, 0, 0, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, 0, 0, 1, 200, NULL, 200
       FROM workflow_graph_scopes WHERE id = ?`,
    [
      scopeId,
      parentScopeId,
      ownerNodeId,
      `g8-child:${scopeId}`,
      scopeKind,
      depth,
      lifecycle,
      fixture.rootScopeId,
    ],
  );
}

interface TemplateNode extends Record<string, unknown> {
  readonly id: string;
  readonly node_key: string;
}

interface TemplateEdge extends Record<string, unknown> {
  readonly id: string;
  readonly edge_key: string;
  readonly edge_kind: 'control' | 'data';
}

function cloneNode(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  template: TemplateNode,
  scopeId: string,
): string {
  const nodeId = stableRuntimeId('node', {
    graph_run_id: fixture.graphRunId,
    scope_id: scopeId,
    node_key: template.node_key,
  });
  transaction.execute(
    `INSERT INTO workflow_graph_nodes (
       id, graph_run_id, scope_id, node_key, node_type,
       capability_resource_id, capability_version, capability_hash,
       normalized_node_json, phase, trigger_state, input_state,
       trigger_cut_json, trigger_cut_hash, input_snapshot_json,
       input_snapshot_value_id, input_snapshot_hash, selected_edges_json,
       activation_event_seq, run_work_fence_epoch_at_activation,
       scope_work_fence_epoch_at_activation, terminal_status, terminal_code,
       child_exit, published_output_envelope_value_id,
       published_output_envelope_hash, port_contract_hash,
       current_attempt_id, current_attempt_no, active_wait_id,
       controller_state, controller_decision_json, controller_decision_hash,
       controller_remaining_count, controller_reservation_group_id,
       row_version, ready_at_ms, terminal_at_ms, created_at_ms, updated_at_ms)
     SELECT ?, graph_run_id, ?, ?, node_type,
            capability_resource_id, capability_version, capability_hash,
            normalized_node_json, 'pending', 'unknown', 'open', NULL, NULL,
            NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, port_contract_hash, NULL, NULL, NULL,
            controller_state, NULL, NULL, controller_remaining_count, NULL,
            1, NULL, NULL, 200, 200
       FROM workflow_graph_nodes WHERE id = ?`,
    [nodeId, scopeId, template.node_key, template.id],
  );
  return nodeId;
}

function cloneEdge(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  template: TemplateEdge,
  scopeId: string,
  ordinal: number,
): void {
  const edgeKey = `g8-edge-${String(ordinal).padStart(4, '0')}`;
  const edgeId = stableRuntimeId('edge', {
    graph_run_id: fixture.graphRunId,
    scope_id: scopeId,
    edge_key: edgeKey,
  });
  transaction.execute(
    `INSERT INTO workflow_graph_edges (
       id, graph_run_id, scope_id, edge_key, edge_kind,
       compiled_edge_json, compiled_edge_hash)
     SELECT ?, graph_run_id, ?, ?, edge_kind,
            compiled_edge_json, compiled_edge_hash
       FROM workflow_graph_edges WHERE id = ?`,
    [edgeId, scopeId, edgeKey, template.id],
  );
  transaction.execute(
    template.edge_kind === 'control'
      ? `INSERT INTO workflow_graph_control_edge_resolutions (
           edge_id, state, decision_input_hash, decision_json, error_code,
           resolution_seq, resolved_at_ms, row_version)
         VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, 1)`
      : `INSERT INTO workflow_graph_data_edge_resolutions (
           edge_id, state, value_value_id, value_hash, schema_hash,
           source_attempt_id, error_code, resolution_seq, resolved_at_ms,
           row_version)
         VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`,
    [edgeId],
  );
}

function seedAttempt(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  scopeId: string,
  nodeId: string,
  nodeAttemptIndex: number,
): string {
  const attemptNo = nodeAttemptIndex + 1;
  const attemptId = `attempt:g8:${scopeId}:${nodeId}:${attemptNo}`;
  const parentAttemptId =
    attemptNo === 1 ? null : `attempt:g8:${scopeId}:${nodeId}:${attemptNo - 1}`;
  const terminal = attemptNo < 4;
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
       created_at_ms, updated_at_ms, finished_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', NULL, NULL, '[]',
       ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL,
       NULL, ?, 0, 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL,
       1, 201, 201, ?)`,
    [
      attemptId,
      fixture.graphRunId,
      scopeId,
      nodeId,
      attemptNo,
      attemptNo === 1 ? 'initial' : 'execution_retry',
      parentAttemptId,
      attemptNo === 1 ? null : attemptNo - 1,
      terminal ? 'terminal' : 'preparing',
      terminal ? 'failed' : null,
      fixture.seed.values.context!.id,
      fixture.seed.values.context!.hash,
      attemptNo === 1 ? null : 'provider_unavailable',
      terminal ? 'provider_unavailable' : null,
      terminal ? 'fenced' : 'open',
      `reservation-group:g8:${attemptId}`,
      terminal ? null : 'worker:g8-benchmark',
      terminal ? null : `lease:g8:${attemptId}`,
      terminal ? null : 1000,
      terminal ? 201 : null,
    ],
  );
  return attemptId;
}

function seedWait(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  scopeId: string,
  nodeId: string,
  ordinal: number,
  waitContract: { id: string; content_hash: Sha256Hash },
): void {
  const waitId = `wait:g8:${ordinal}`;
  transaction.execute(
    `INSERT INTO workflow_graph_waits (
       id, graph_run_id, scope_id, node_id, wait_type,
       contract_resource_id, contract_resource_hash, correlation_key,
       correlation_key_hash, registration_key, payload_value_id, payload_hash,
       status, armed_at_ms, deadline_at_ms, resolved_at_ms,
       registration_lease_owner, registration_lease_token,
       registration_lease_expires_at_ms, run_work_fence_epoch,
       scope_work_fence_epoch, resource_reservation_group_id, row_version,
       created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'signal', ?, ?, ?, ?, ?, NULL, NULL, 'registering',
       NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, 1, 202, 202)`,
    [
      waitId,
      fixture.graphRunId,
      scopeId,
      nodeId,
      waitContract.id,
      waitContract.content_hash,
      `g8-correlation:${ordinal}`,
      g6Hash(`g8-correlation:${ordinal}`),
      `g8-registration:${ordinal}`,
      `reservation-group:g8:${waitId}`,
    ],
  );
}

function seedBuild(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  scopeId: string,
  ownerNodeId: string,
  ordinal: number,
): void {
  transaction.execute(
    `INSERT INTO workflow_graph_scope_builds (
       id, graph_run_id, owner_scope_id, owner_node_id, target_scope_id,
       invocation_key, scope_kind, item_key_json, item_index,
       source_seed_json, source_seed_value_id, source_seed_hash,
       source_snapshot_json, source_snapshot_value_id, source_snapshot_hash,
       input_snapshot_json, input_snapshot_value_id, input_snapshot_hash,
       compiler_snapshot_hash, run_work_fence_epoch,
       owner_scope_work_fence_epoch, status, compiled_plan_id,
       compiled_plan_hash, scope_id, materialization_reservation_group_id,
       attempt_count, next_attempt_at_ms, deadline_at_ms, lease_owner,
       lease_token, lease_expires_at_ms, error_code, error_detail_value_id,
       error_detail_hash, row_version, created_at_ms, updated_at_ms)
     SELECT ?, graph_run_id, ?, ?, NULL, ?, 'subgraph', NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            compiler_snapshot_hash, 0, 0, 'compiled', compiled_plan_id,
            compiled_plan_hash, NULL, NULL, 1, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, 1, 203, 203
       FROM workflow_graph_scope_builds WHERE id = ?`,
    [
      `build:g8:${ordinal}`,
      scopeId,
      ownerNodeId,
      `g8-build:${ordinal}`,
      fixture.rootBuildId,
    ],
  );
}

function seedEffect(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  scopeId: string,
  nodeId: string,
  attemptId: string,
  ordinal: number,
): void {
  const value = fixture.seed.values.context!;
  transaction.execute(
    `INSERT INTO workflow_graph_effect_operations (
       id, graph_run_id, scope_id, node_id, attempt_id, operation_key,
       key_strategy_json, key_strategy_hash, execution_lane, close_request_id,
       effect_type, status, request_value_id, request_hash, receipt_value_id,
       receipt_hash, before_state_value_id, before_state_hash,
       after_state_value_id, after_state_hash, immutable_output_snapshot_value_id,
       immutable_output_snapshot_hash, compensation_value_id, compensation_hash,
       lease_owner, lease_token, lease_expires_at_ms, row_version, created_at_ms,
       updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 'normal', NULL, 'g8_benchmark',
       'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
       NULL, 1, 204, 204)`,
    [
      `effect:g8:${ordinal}`,
      fixture.graphRunId,
      scopeId,
      nodeId,
      attemptId,
      `operation:g8:${ordinal}`,
      g6Hash(`g8-effect-strategy:${ordinal}`),
      value.id,
      value.hash,
      value.id,
      value.hash,
      value.id,
      value.hash,
      value.id,
      value.hash,
      value.id,
      value.hash,
    ],
  );
}

function seedMapSlots(
  transaction: WorkflowRuntimeWriteTransaction,
  fixture: G6MapFixture,
  owners: readonly { readonly scopeId: string; readonly nodeId: string }[],
  count: number,
): void {
  const manifestCounts = distribute(
    count,
    Math.ceil(count / G8_PRODUCT_FLOOR_COVERAGE.max_items_per_map),
  );
  if (owners.length < manifestCounts.length)
    throw new Error('G8 nested map fixture has too few distinct owners');
  let globalIndex = 0;
  for (const [manifestIndex, manifestCount] of manifestCounts.entries()) {
    const owner = owners[manifestIndex]!;
    const expansionManifestId = stableRuntimeId('expansion-manifest', {
      graph_run_id: fixture.graphRunId,
      owner_scope_id: owner.scopeId,
      owner_node_id: owner.nodeId,
      benchmark: 'g8-large-nested-map',
      manifest_index: manifestIndex,
    });
    const manifestHash = g6Hash(
      `g8-large-nested-map-manifest:${manifestIndex}`,
    );
    const childPolicy = { mode: 'all', failures: 'collect' };
    transaction.execute(
      `INSERT INTO workflow_graph_expansion_manifests (
       id, graph_run_id, scope_id, owner_node_id, producer_attempt_id,
       mode, source_artifact_value_id, source_artifact_hash,
       manifest_json, manifest_value_id, manifest_hash, item_count,
       child_completion_policy_json, child_completion_policy_hash,
       sealed_at_ms, row_version
     ) VALUES (?, ?, ?, ?, NULL, 'map', ?, ?, ?, NULL, ?, ?, ?, ?, 205, 1)`,
      [
        expansionManifestId,
        fixture.graphRunId,
        owner.scopeId,
        owner.nodeId,
        fixture.seed.values.childSource!.id,
        fixture.seed.values.childSource!.hash,
        canonicalJson({
          benchmark: 'g8-large-nested-map',
          manifest_index: manifestIndex,
          item_count: manifestCount,
        }),
        manifestHash,
        manifestCount,
        canonicalJson(childPolicy),
        g6Hash(`g8-map-policy:${canonicalJson(childPolicy)}`),
      ],
    );
    for (let itemIndex = 0; itemIndex < manifestCount; itemIndex += 1) {
      const itemKey = { manifest_index: manifestIndex, item_index: itemIndex };
      transaction.execute(
        `INSERT INTO workflow_graph_map_item_results (
       id, graph_run_id, owner_scope_id, owner_node_id,
       expansion_manifest_id, item_index, item_key_json, item_key_hash,
       build_id, scope_id, outcome_state, exit_name, error_code, reason,
       output_value_id, output_hash, completion_seq, fence_event_seq,
       row_version, created_at_ms, resolved_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'open', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, 1, 205, NULL)`,
        [
          stableRuntimeId('map-item-result', {
            expansion_manifest_id: expansionManifestId,
            item_index: itemIndex,
          }),
          fixture.graphRunId,
          owner.scopeId,
          owner.nodeId,
          expansionManifestId,
          itemIndex,
          canonicalJson(itemKey),
          g6Hash(`g8-map-item:${globalIndex}`),
        ],
      );
      globalIndex += 1;
    }
  }
}

function seedT7Workload(
  fixture: G6MapFixture,
  shape: string,
  dimensions: T7Dimensions,
): void {
  const store = fixture.instance.store;
  const templateNodes = store.queryAll<TemplateNode>(
    `SELECT id, node_key FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY`,
    [fixture.graphRunId, fixture.rootScopeId],
  );
  const templateEdges = store.queryAll<TemplateEdge>(
    `SELECT id, edge_key, edge_kind FROM workflow_graph_edges
      WHERE graph_run_id = ? AND scope_id = ? ORDER BY edge_key COLLATE BINARY`,
    [fixture.graphRunId, fixture.rootScopeId],
  );
  if (templateNodes.length === 0 || templateEdges.length === 0)
    throw new Error('G8 T7 template Plan is empty');
  const scopeIds = Array.from({ length: dimensions.scopeCount }, (_, index) =>
    index === 0
      ? fixture.rootScopeId
      : stableRuntimeId('scope', {
          graph_run_id: fixture.graphRunId,
          benchmark_scope_index: index,
        }),
  );
  const nodesPerScope =
    shape === 'wide_tree'
      ? distributeWithFirst(
          dimensions.nodeCount,
          dimensions.scopeCount,
          Math.max(templateNodes.length, dimensions.nodesPerScopeMaximum),
        )
      : distribute(dimensions.nodeCount, dimensions.scopeCount);
  const edgesPerScope =
    shape === 'wide_tree'
      ? distributeWithFirst(
          dimensions.edgeCount,
          dimensions.scopeCount,
          Math.max(templateEdges.length, dimensions.edgesPerScopeMaximum),
        )
      : distribute(dimensions.edgeCount, dimensions.scopeCount);
  const allNodes: Array<{ scopeId: string; nodeId: string }> = [];
  const attemptIds: Array<{
    scopeId: string;
    nodeId: string;
    attemptId: string;
  }> = [];
  const firstNodeByScope = new Map<string, string>([
    [fixture.rootScopeId, templateNodes[0]!.id],
  ]);
  store.withImmediateTransaction((transaction) => {
    for (let scopeIndex = 1; scopeIndex < scopeIds.length; scopeIndex += 1) {
      const parentIndex = t7ParentIndex(shape, scopeIndex);
      const parentScopeId = scopeIds[parentIndex]!;
      const ownerNodeId = firstNodeByScope.get(parentScopeId);
      if (!ownerNodeId)
        throw new Error('G8 T7 parent Scope owner Node is unavailable');
      const parentDepth = transaction.queryOne<{ depth: number }>(
        'SELECT depth FROM workflow_graph_scopes WHERE id = ?',
        [parentScopeId],
      )!.depth;
      cloneScope(
        transaction,
        fixture,
        scopeIds[scopeIndex]!,
        parentScopeId,
        ownerNodeId,
        Math.min(8, parentDepth + 1),
        shape === 'large_nested_map' ? 'map_item' : 'subgraph',
        shape === 'mixed_lifecycle' && scopeIndex % 3 === 0
          ? 'materializing'
          : 'active',
      );
      for (
        let nodeIndex = 0;
        nodeIndex < nodesPerScope[scopeIndex]!;
        nodeIndex += 1
      ) {
        const template = templateNodes[nodeIndex % templateNodes.length]!;
        const nodeId = cloneNode(
          transaction,
          fixture,
          {
            ...template,
            node_key: `g8-node-${String(nodeIndex).padStart(4, '0')}`,
          },
          scopeIds[scopeIndex]!,
        );
        if (nodeIndex === 0)
          firstNodeByScope.set(scopeIds[scopeIndex]!, nodeId);
        allNodes.push({
          scopeId: scopeIds[scopeIndex]!,
          nodeId,
        });
      }
      for (
        let edgeIndex = 0;
        edgeIndex < edgesPerScope[scopeIndex]!;
        edgeIndex += 1
      )
        cloneEdge(
          transaction,
          fixture,
          templateEdges[edgeIndex % templateEdges.length]!,
          scopeIds[scopeIndex]!,
          edgeIndex,
        );
    }
    const rootNodes = store.queryAll<TemplateNode>(
      `SELECT id, node_key FROM workflow_graph_nodes
        WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY`,
      [fixture.graphRunId, fixture.rootScopeId],
    );
    for (const node of rootNodes)
      allNodes.push({ scopeId: fixture.rootScopeId, nodeId: node.id });
    for (
      let nodeIndex = rootNodes.length;
      nodeIndex < nodesPerScope[0]!;
      nodeIndex += 1
    ) {
      const template = templateNodes[nodeIndex % templateNodes.length]!;
      allNodes.push({
        scopeId: fixture.rootScopeId,
        nodeId: cloneNode(
          transaction,
          fixture,
          {
            ...template,
            node_key: `g8-root-node-${String(nodeIndex).padStart(4, '0')}`,
          },
          fixture.rootScopeId,
        ),
      });
    }
    for (
      let edgeIndex = templateEdges.length;
      edgeIndex < edgesPerScope[0]!;
      edgeIndex += 1
    )
      cloneEdge(
        transaction,
        fixture,
        templateEdges[edgeIndex % templateEdges.length]!,
        fixture.rootScopeId,
        edgeIndex,
      );
    let attemptsRemaining = dimensions.attemptCount;
    for (const node of allNodes) {
      const count = Math.min(4, attemptsRemaining);
      for (let attemptIndex = 0; attemptIndex < count; attemptIndex += 1) {
        attemptIds.push({
          ...node,
          attemptId: seedAttempt(
            transaction,
            fixture,
            node.scopeId,
            node.nodeId,
            attemptIndex,
          ),
        });
      }
      attemptsRemaining -= count;
      if (attemptsRemaining === 0) break;
    }
    if (attemptsRemaining !== 0)
      throw new Error('G8 T7 attempt distribution exceeded four per Node');
    const waitContract = {
      id: fixture.seed.refs.waitContract!.rowId,
      content_hash: fixture.seed.refs.waitContract!.hash,
    };
    for (let index = 0; index < dimensions.waitCount; index += 1) {
      const node = allNodes[index % allNodes.length]!;
      seedWait(
        transaction,
        fixture,
        node.scopeId,
        node.nodeId,
        index,
        waitContract,
      );
    }
    for (let index = 0; index < dimensions.buildCount - 1; index += 1) {
      const node = allNodes[index % allNodes.length]!;
      seedBuild(transaction, fixture, node.scopeId, node.nodeId, index);
    }
    for (let index = 0; index < dimensions.effectCount; index += 1) {
      const attempt = attemptIds[index % attemptIds.length]!;
      seedEffect(
        transaction,
        fixture,
        attempt.scopeId,
        attempt.nodeId,
        attempt.attemptId,
        index,
      );
    }
    if (shape === 'large_nested_map') {
      const nestedMapOwners = [
        ...new Map(allNodes.map((node) => [node.scopeId, node])).values(),
      ];
      seedMapSlots(
        transaction,
        fixture,
        nestedMapOwners,
        dimensions.mapItemCount,
      );
    }
    assertNoDeferredForeignKeyViolations(transaction, 'G8 T7 fixture');
  });
  const observed = {
    scopes: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_scopes WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    nodes: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_nodes WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    edges: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_edges WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    attempts: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_node_attempts WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    waits: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_waits WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    builds: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_scope_builds WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    effects: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_effect_operations WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
    mapItems: store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_map_item_results WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )!.count,
  };
  if (
    observed.scopes !== dimensions.scopeCount ||
    observed.nodes !== dimensions.nodeCount ||
    observed.edges !== dimensions.edgeCount ||
    observed.attempts !== dimensions.attemptCount ||
    observed.waits !== dimensions.waitCount ||
    observed.builds !== dimensions.buildCount ||
    observed.effects !== dimensions.effectCount ||
    observed.mapItems !==
      (shape === 'large_nested_map' ? dimensions.mapItemCount : 0)
  ) {
    throw new Error(
      `G8 T7 fixture dimensions drifted: ${canonicalJson(observed)}`,
    );
  }
}

function prepareT7Case(
  caseRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
  shape: string,
  profile: G8BenchmarkProfile,
): PreparedBenchmarkCase {
  const dimensions = t7Dimensions(profile);
  const compiled = compileG8T3Fixture('long_chain', 8);
  const instance = openG5IsolatedBootstrap(caseRoot, identityMode);
  const fixture = createG6MapFixture(`g8-t7-${shape}-${profile}`, {
    compiledFixture: compiled,
    bootstrapInstance: instance,
    runResourceLimits: benchmarkLimits(),
  });
  seedT7Workload(fixture, shape, dimensions);
  const run = runRow(fixture);
  const root = scopeRow(fixture, fixture.rootScopeId);
  const maximumNodesPerScope = fixture.instance.store.queryOne<{
    count: number;
  }>(
    `SELECT max(scope_count) AS count FROM (
       SELECT count(*) AS scope_count FROM workflow_graph_nodes
        WHERE graph_run_id = ? GROUP BY scope_id
     )`,
    [fixture.graphRunId],
  )?.count;
  const maximumEdgesPerScope = fixture.instance.store.queryOne<{
    count: number;
  }>(
    `SELECT max(scope_count) AS count FROM (
       SELECT count(*) AS scope_count FROM workflow_graph_edges
        WHERE graph_run_id = ? GROUP BY scope_id
     )`,
    [fixture.graphRunId],
  )?.count;
  const maximumNestingDepth = fixture.instance.store.queryOne<{
    depth: number;
  }>(
    'SELECT max(depth) AS depth FROM workflow_graph_scopes WHERE graph_run_id = ?',
    [fixture.graphRunId],
  )?.depth;
  if (
    maximumNodesPerScope === undefined ||
    maximumEdgesPerScope === undefined ||
    maximumNestingDepth === undefined
  ) {
    throw new Error('G8 T7 per-Scope dimensions are unavailable');
  }
  const input: Parameters<typeof requestScopeCloseT7a>[1] = {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion: run.row_version,
    expectedScopeRowVersion: root.row_version,
    expectedRunWorkFenceEpoch: run.work_fence_epoch,
    expectedScopeWorkFenceEpoch: root.work_fence_epoch,
    cause: { reason: 'engine_error', errorCode: 'g8_benchmark_root_fence' },
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs: 300,
  };
  const limitDimensions: JsonObject = {
    max_scopes_total: dimensions.scopeCount,
    max_nodes_total: dimensions.nodeCount,
    max_edges_total: dimensions.edgeCount,
    max_attempts_total: dimensions.attemptCount,
    max_waits_total: dimensions.waitCount,
    max_builds_total: dimensions.buildCount,
    max_effect_operations_total: dimensions.effectCount,
    max_subtree_scopes_per_fence: dimensions.scopeCount,
    max_subtree_nodes_per_fence: dimensions.nodeCount,
    max_subtree_edges_per_fence: dimensions.edgeCount,
    max_subtree_attempts_per_fence: dimensions.attemptCount,
    max_subtree_waits_per_fence: dimensions.waitCount,
    max_subtree_builds_per_fence: dimensions.buildCount,
    max_subtree_effects_per_fence: dimensions.effectCount,
    ...(shape === 'large_nested_map'
      ? {
          max_map_items_total: dimensions.mapItemCount,
          max_subtree_map_slots_per_fence: dimensions.mapItemCount,
        }
      : {}),
  };
  assertG8DimensionsWithinSupportedLimits(limitDimensions);
  const publicDimensions: JsonObject = {
    ...limitDimensions,
    observed_max_nodes_per_scope: maximumNodesPerScope,
    observed_max_edges_per_scope: maximumEdgesPerScope,
    observed_max_nesting_depth: maximumNestingDepth,
    ...(shape === 'large_nested_map'
      ? {
          observed_max_items_per_map: Math.min(
            dimensions.mapItemCount,
            G8_PRODUCT_FLOOR_COVERAGE.max_items_per_map,
          ),
        }
      : {}),
  };
  fixture.instance.closeStore();
  return {
    transaction: 't7',
    shape,
    profile,
    scalePercent: scalePercent(profile),
    baseDatabasePath: fixture.instance.databasePath,
    dimensions: publicDimensions,
    supportedLimitDimensions: limitDimensions,
    productionEntry: 'requestScopeCloseT7a',
    productionIndexEvidence: T7_INDEX_EVIDENCE,
    correctnessInvariants: [
      'Recursive CTE discovers the complete bounded subtree once',
      'TEMP ID staging drives set-based fence updates without dynamic IN SQL',
      'all descendant close requests, epochs, work manifests, and cleanup keys commit atomically',
    ],
    invoke: (store) => {
      const receipt = requestScopeCloseT7a(store, input);
      if (
        receipt.disposition !== 'close_requested' ||
        receipt.fencedScopeIds.length !== dimensions.scopeCount
      ) {
        throw new Error('G8 T7 fence receipt dimensions drifted');
      }
    },
    verify: (store) => {
      const closeRequests = store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [fixture.graphRunId],
      )!.count;
      const openAttempts = store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_node_attempts WHERE graph_run_id = ? AND acceptance_state = 'open'",
        [fixture.graphRunId],
      )!.count;
      const normalEffects = store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_effect_operations WHERE graph_run_id = ? AND execution_lane = 'normal'",
        [fixture.graphRunId],
      )!.count;
      const openMapSlots = store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_map_item_results WHERE graph_run_id = ? AND outcome_state = 'open'",
        [fixture.graphRunId],
      )!.count;
      if (
        closeRequests !== dimensions.scopeCount ||
        openAttempts !== 0 ||
        normalEffects !== 0 ||
        openMapSlots !== 0
      ) {
        throw new Error('G8 T7 post-fence invariant failed');
      }
    },
  };
}

interface T8WorkflowRow extends Record<string, unknown> {
  readonly state_instance_id: string;
  readonly root_workflow_id: string;
  readonly ownership_hash: Sha256Hash;
  readonly row_version: number;
}

function t8RequiredChildCount(
  shape: string,
  profile: G8BenchmarkProfile,
): number {
  if (shape === 'maximum_required_child' || shape === 'all_or_nothing') {
    return integerScale(
      G8_SUPPORTED_LIMITS.max_required_child_creations_per_t8,
      profile,
    );
  }
  return 1;
}

function prepareT8Case(
  caseRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
  shape: string,
  profile: G8BenchmarkProfile,
): PreparedBenchmarkCase {
  const childCount = t8RequiredChildCount(shape, profile);
  const transitionEffectIds = Array.from(
    { length: childCount },
    (_, index) => `effect:g8:required-child:${String(index).padStart(2, '0')}`,
  );
  const claimKeyHash = g6Hash(`g8-t8-claim:${shape}:${profile}`);
  const fixture = createG6MapFixture(`g8-t8-${shape}-${profile}`, {
    bootstrapInstance: openG5IsolatedBootstrap(caseRoot, identityMode),
    errorTransitionEffects: transitionEffectIds.map((id) => ({
      id,
      type: 'start_child_workflow',
      delivery_requirement: 'required',
    })),
    ...(shape === 'claim_handoff_competition'
      ? {
          domainClaims: [
            {
              namespace: 'g8-benchmark-resource',
              keyHash: claimKeyHash,
              mode: 'exclusive' as const,
            },
          ],
        }
      : {}),
    runResourceLimits: benchmarkLimits(),
  });
  const runBeforeClose = runRow(fixture);
  const rootBeforeClose = scopeRow(fixture, fixture.rootScopeId);
  const close = requestScopeCloseT7a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion: runBeforeClose.row_version,
    expectedScopeRowVersion: rootBeforeClose.row_version,
    expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
    expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
    cause: { reason: 'engine_error', errorCode: 'g8_benchmark_root_fence' },
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs: 400,
  });
  const workflow = fixture.instance.store.queryOne<T8WorkflowRow>(
    `SELECT state_instance_id, root_workflow_id, ownership_hash, row_version
       FROM workflows WHERE id = ?`,
    [fixture.workflowId],
  );
  if (!workflow) throw new Error('G8 T8 Workflow authority is unavailable');
  const creationDomain = `parent_workflow_lineage:${workflow.root_workflow_id}`;
  const requiredChildren: Array<
    Parameters<typeof commitRootT8>[1]['requiredChildren'][number]
  > = [];
  for (const [index, transitionEffectId] of transitionEffectIds.entries()) {
    const creationKey = domainSeparatedSha256(
      'icarus:child-workflow-creation-key:1\n',
      {
        parent_workflow_id: fixture.workflowId,
        source_state_instance_id: workflow.state_instance_id,
        source_close_request_id: close.closeRequestId,
        transition_effect_id: transitionEffectId,
      },
    );
    const creationIntentHash = calculateCreationIntentHash({
      creationDomain,
      creationKey,
      principalRef: 'human:local-owner',
      ownershipHash: workflow.ownership_hash,
      routingScope: fixture.seed.refs.routingScope!,
      recipe: fixture.seed.refs.recipe!,
      entryPoint: 'default',
      inputHash: fixture.seed.values.childInput!.hash,
      attachmentManifestHash: fixture.seed.values.attachments!.hash,
    });
    const prepared = prepareRequiredFinalizationT0p(fixture.instance.store, {
      workflowId: fixture.workflowId,
      sourceStateInstanceId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      transitionEffectId,
      recipe: fixture.seed.refs.recipe!,
      definition: fixture.seed.refs.definition!,
      executionPolicy: fixture.seed.refs.executionPolicy!,
      routingScope: fixture.seed.refs.routingScope!,
      finalizationPolicy: fixture.seed.refs.finalizationPolicy!,
      principalRef: 'human:local-owner',
      principalHash: g6Hash('principal'),
      input: fixture.seed.values.childInput!,
      attachments: fixture.seed.values.attachments!,
      routingDecision: fixture.seed.values.routing!,
      creationIntentHash,
      runtimeSafetyHash: fixture.seed.values.safety!.hash,
      maxAttempts: 3,
      deadlineAtMs: 10_000,
      nowMs: 410 + index * 3,
    });
    let expectedScheduleRowVersion = 1;
    if (shape === 'retry_exhaustion' && index === 0) {
      const retry = recordRootFinalizationAttempt(fixture.instance.store, {
        scheduleId: prepared.scheduleId,
        expectedScheduleRowVersion,
        frozenResolution: fixture.seed.values.routing!,
        claimPreflight: fixture.seed.values.context!,
        result: 'retryable_conflict',
        errorCode: 'claim_conflict',
        errorDetail: fixture.seed.values.context!,
        nextEligibleAtMs: 412 + index * 3,
        exhaustionEvidence: fixture.seed.values.context!,
        remediationPolicy: fixture.seed.refs.finalizationPolicy!,
        remediationDeadlineAtMs: 10_000,
        nowMs: 411 + index * 3,
      });
      if (retry.status !== 'retry_wait')
        throw new Error('G8 T8 retry precondition did not enter retry_wait');
      expectedScheduleRowVersion += 1;
    }
    const ready = recordRootFinalizationAttempt(fixture.instance.store, {
      scheduleId: prepared.scheduleId,
      expectedScheduleRowVersion,
      frozenResolution: fixture.seed.values.routing!,
      claimPreflight: fixture.seed.values.context!,
      result: 'ready',
      exhaustionEvidence: fixture.seed.values.context!,
      remediationPolicy: fixture.seed.refs.finalizationPolicy!,
      remediationDeadlineAtMs: 10_000,
      nowMs: 412 + index * 3,
    });
    if (ready.status !== 'ready')
      throw new Error('G8 T8 required Child Schedule did not become ready');
    requiredChildren.push({
      scheduleId: prepared.scheduleId,
      expectedScheduleRowVersion: expectedScheduleRowVersion + 1,
      commandPolicy: fixture.seed.refs.commandPolicy!,
      inputSchema: fixture.seed.refs.inputSchema!,
      contextContract: fixture.seed.refs.contextContract!,
      contextSnapshot: fixture.seed.values.context!,
      ownershipHash: workflow.ownership_hash,
      recipeVersion: '1.0.0',
      definitionVersion: '1.0.0',
      deadlineAtMs: null,
      resourceLimits: {
        state_activations_total: 4,
        graph_runs_total: 4,
        descendant_workflows_total: 4,
      },
      initialActivation: {
        stateKey: 'run',
        stateType: 'graph',
        definition: fixture.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: fixture.seed.values.stateConfig!,
        registrySnapshotId: fixture.seed.snapshotId,
        registrySnapshotHash: fixture.seed.snapshotHash,
        closureManifestId: fixture.seed.closureId,
        closureHash: fixture.seed.closureHash,
        runtimeSafetySnapshot: fixture.seed.values.safety!,
        runtimeSupportedLimits: fixture.seed.refs.supportedLimits!,
        sqliteExecutionProfile: fixture.seed.refs.sqliteProfile!,
        compilerToolchain: fixture.seed.refs.compilerToolchain!,
        coreReleaseRef: 'icarus.core@1.0.0',
        coreReleaseHash: g6Hash('core-release'),
        coreBuildHash: fixture.plan.compiler_build_hash as Sha256Hash,
        databaseSchemaHash: fixture.instance.store.frozenInputs.schemaHash,
        sourceSeedHash: fixture.plan.source_hash as Sha256Hash,
        compilerSnapshotHash: g6Hash('compiler-snapshot'),
        inputSnapshot: fixture.seed.values.childInput!,
        runResourceLimits: benchmarkLimits(),
        checkpoint: { status: 'g8-required-child-initial' },
        nowMs: 500,
      },
      claimHandoffs: [],
    });
  }
  if (shape === 'claim_handoff_competition') {
    const parentClaim = fixture.instance.store.queryOne<{
      id: string;
      row_version: number;
      fencing_token: number;
    }>(
      `SELECT id, row_version, fencing_token
         FROM workflow_domain_resource_claims
        WHERE owner_workflow_id = ? AND namespace = ? AND key_hash = ?
          AND status = 'held'`,
      [fixture.workflowId, 'g8-benchmark-resource', claimKeyHash],
    );
    const claimHead = fixture.instance.store.queryOne<{ row_version: number }>(
      `SELECT row_version FROM workflow_domain_resource_heads
        WHERE namespace = ? AND key_hash = ?`,
      ['g8-benchmark-resource', claimKeyHash],
    );
    if (!parentClaim || !claimHead)
      throw new Error('G8 T8 parent Claim authority is unavailable');
    requiredChildren[0] = {
      ...requiredChildren[0]!,
      claimHandoffs: [
        {
          parentClaimId: parentClaim.id,
          expectedParentClaimRowVersion: parentClaim.row_version,
          expectedHeadRowVersion: claimHead.row_version,
          expectedParentFencingToken: parentClaim.fencing_token,
        },
      ],
    };
  }
  const activation = fixture.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_state_activations WHERE id = ?',
    [workflow.state_instance_id],
  );
  const run = runRow(fixture);
  const root = scopeRow(fixture, fixture.rootScopeId);
  if (!activation) throw new Error('G8 T8 source Activation is unavailable');
  const input: Parameters<typeof commitRootT8>[1] = {
    workflowId: fixture.workflowId,
    sourceActivationId: workflow.state_instance_id,
    sourceRunId: fixture.graphRunId,
    rootScopeId: fixture.rootScopeId,
    closeRequestId: close.closeRequestId,
    expectedWorkflowRowVersion: workflow.row_version,
    expectedSourceActivationRowVersion: activation.row_version,
    expectedSourceRunRowVersion: run.row_version,
    expectedRootScopeRowVersion: root.row_version,
    routeSource: 'on_error',
    target: {
      kind: 'terminal',
      stateKey: 'failed',
      definition: fixture.seed.refs.definition!,
      definitionVersion: '1.0.0',
      stateConfig: fixture.seed.values.stateConfig!,
      terminalKind: 'errored',
      output: null,
      outputSchemaHash: null,
      errorCode: 'g8_benchmark_root_fence',
      errorDetail: null,
    },
    contextValueSchema: fixture.seed.refs.schema!,
    requiredChildren,
    bestEffortOutbox: [],
    nowMs: 500,
  };
  if (shape === 'all_or_nothing') {
    let faulted = false;
    try {
      commitRootT8(fixture.instance.store, input, { point: 'before_commit' });
    } catch (error) {
      faulted =
        error instanceof Error &&
        /Injected fault before commit/.test(error.message);
    }
    const cuts = fixture.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_completion_cuts WHERE graph_run_id = ?',
      [fixture.graphRunId],
    )?.count;
    const children = fixture.instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_relations WHERE parent_workflow_id = ?',
      [fixture.workflowId],
    )?.count;
    if (!faulted || cuts !== 0 || children !== 0)
      throw new Error('G8 T8 all-or-nothing rollback precondition failed');
  }
  const publicDimensions: JsonObject = {
    max_required_child_creations_per_t8: childCount,
  };
  assertG8DimensionsWithinSupportedLimits(publicDimensions);
  fixture.instance.closeStore();
  return {
    transaction: 't8',
    shape,
    profile,
    scalePercent: scalePercent(profile),
    baseDatabasePath: fixture.instance.databasePath,
    dimensions: publicDimensions,
    supportedLimitDimensions: publicDimensions,
    productionEntry: 'commitRootT8',
    productionIndexEvidence: T8_INDEX_EVIDENCE,
    correctnessInvariants: [
      'all required Child Schedules are ready with frozen provenance before T8',
      'required Child Workflows, relations, optional Claim handoffs, Cut, checkpoint, and terminal Activation commit atomically',
      ...(shape === 'retry_exhaustion'
        ? ['retry_wait advances to ready under the frozen finite Schedule']
        : []),
      ...(shape === 'all_or_nothing'
        ? ['before_commit fault leaves Cut and Child relations absent']
        : []),
    ],
    invoke: (store) => {
      const receipt = commitRootT8(store, input);
      if (
        receipt.disposition !== 'committed' ||
        receipt.childWorkflowIds.length !== childCount
      ) {
        throw new Error('G8 T8 commit receipt dimensions drifted');
      }
    },
    verify: (store) => {
      const children = store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_relations WHERE parent_workflow_id = ?',
        [fixture.workflowId],
      )?.count;
      const succeededSchedules = store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_root_finalization_schedules
          WHERE workflow_id = ? AND status = 'succeeded'`,
        [fixture.workflowId],
      )?.count;
      const workflowStatus = store.queryOne<{ status: string }>(
        'SELECT status FROM workflows WHERE id = ?',
        [fixture.workflowId],
      )?.status;
      if (
        children !== childCount ||
        succeededSchedules !== childCount ||
        workflowStatus !== 'errored'
      ) {
        throw new Error('G8 T8 post-commit invariant failed');
      }
    },
  };
}

function cloneDatabase(
  baseDatabasePath: string,
  iterationRoot: string,
): string {
  fs.mkdirSync(iterationRoot, { recursive: true });
  const target = path.join(iterationRoot, 'workflow-runtime.db');
  fs.copyFileSync(baseDatabasePath, target);
  return target;
}

function instrumentAffectedRows(store: WorkflowRuntimeStore): {
  readonly store: WorkflowRuntimeStore;
  readonly affectedRows: () => number;
} {
  let affectedRows = 0;
  const instrumented = new Proxy(store, {
    get(target, property) {
      if (property === 'withImmediateTransaction') {
        return <T>(
          callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
        ): T =>
          target.withImmediateTransaction((transaction) => {
            const observedTransaction = new Proxy(transaction, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === 'execute') {
                  return (
                    sql: string,
                    parameters: Parameters<
                      WorkflowRuntimeWriteTransaction['execute']
                    >[1],
                  ) => {
                    const result = transactionTarget.execute(sql, parameters);
                    affectedRows += result.changes;
                    return result;
                  };
                }
                const value = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                );
                return typeof value === 'function'
                  ? value.bind(transactionTarget)
                  : value;
              },
            });
            return callback(observedTransaction);
          });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: instrumented, affectedRows: () => affectedRows };
}

function assertStoreIntegrity(store: WorkflowRuntimeStore): void {
  const integrity = store.queryOne<{ integrity_check: string }>(
    'SELECT integrity_check FROM pragma_integrity_check',
    [],
  );
  const foreignKeyFailures = store.queryAll<Record<string, unknown>>(
    'SELECT * FROM pragma_foreign_key_check',
    [],
  );
  if (integrity?.integrity_check !== 'ok' || foreignKeyFailures.length !== 0) {
    throw new Error('G8 benchmark database integrity verification failed');
  }
}

function measurePreparedCase(
  prepared: PreparedBenchmarkCase,
  iterationRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
): BenchmarkSample {
  const databasePath = cloneDatabase(prepared.baseDatabasePath, iterationRoot);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'open_existing',
    identityMode,
  });
  try {
    const instrumented = instrumentAffectedRows(store);
    const beforeRss = process.memoryUsage.rss();
    const startedAt = performance.now();
    invokeWithinG8SupportedLimits(prepared.supportedLimitDimensions, () =>
      prepared.invoke(instrumented.store),
    );
    const durationMs = performance.now() - startedAt;
    const affectedRows = instrumented.affectedRows();
    const peakRssBytes = Math.max(beforeRss, process.memoryUsage.rss());
    const walBytes = fileBytes(`${databasePath}-wal`);
    prepared.verify(store);
    assertStoreIntegrity(store);
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      affectedRows <= 0 ||
      peakRssBytes <= 0
    ) {
      throw new Error('G8 benchmark sample metrics are invalid');
    }
    return { durationMs, walBytes, peakRssBytes, affectedRows };
  } finally {
    store.close();
  }
}

function statistics(
  samples: readonly BenchmarkSample[],
): G8BenchmarkStatistics {
  const durations = samples.map((sample) => sample.durationMs);
  return {
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    p99_ms: percentile(durations, 99),
    max_ms: Math.max(...durations),
    wal_bytes: Math.max(...samples.map((sample) => sample.walBytes)),
    peak_rss_bytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
    affected_rows: Math.max(...samples.map((sample) => sample.affectedRows)),
  };
}

function benchmarkCaseId(
  transaction: G8BenchmarkTransaction,
  shape: string,
  profile: G8BenchmarkProfile,
): string {
  return `g8:${transaction}:${shape}:${profile}`;
}

function beyondLimitDimensions(
  transaction: G8BenchmarkTransaction,
): Partial<G8SupportedLimitValues> {
  if (transaction === 't3')
    return {
      max_facts_per_transaction:
        G8_SUPPORTED_LIMITS.max_facts_per_transaction + 1,
    };
  if (transaction === 't7')
    return {
      max_subtree_scopes_per_fence:
        G8_SUPPORTED_LIMITS.max_subtree_scopes_per_fence + 1,
    };
  return {
    max_required_child_creations_per_t8:
      G8_SUPPORTED_LIMITS.max_required_child_creations_per_t8 + 1,
  };
}

function beyondLimitObservation(
  transaction: G8BenchmarkTransaction,
  shape: string,
  baseDatabasePath: string,
  warmupIterations: number,
  measurementIterations: number,
): G8BenchmarkCaseObservation {
  const dimensions = beyondLimitDimensions(transaction);
  const beforeHash = rawSha256(baseDatabasePath);
  let rejection: G8SupportedLimitError | null = null;
  let productionEntryInvoked = false;
  try {
    invokeWithinG8SupportedLimits(dimensions, () => {
      productionEntryInvoked = true;
    });
  } catch (error) {
    if (error instanceof G8SupportedLimitError) rejection = error;
    else throw error;
  }
  const afterHash = rawSha256(baseDatabasePath);
  if (!rejection || productionEntryInvoked || beforeHash !== afterHash)
    throw new Error('G8 Beyond Limit did not reject before atomic write');
  return {
    case_id: benchmarkCaseId(transaction, shape, 'beyond_limit'),
    transaction,
    shape,
    profile: 'beyond_limit',
    scale_percent: null,
    warmup_iterations: warmupIterations,
    measurement_iterations: measurementIterations,
    dimensions: dimensions as JsonObject,
    production_entry:
      transaction === 't3'
        ? 'reconcileFactT3a'
        : transaction === 't7'
          ? 'requestScopeCloseT7a'
          : 'commitRootT8',
    production_index_evidence:
      transaction === 't3'
        ? [...T3_INDEX_EVIDENCE]
        : transaction === 't7'
          ? [...T7_INDEX_EVIDENCE]
          : [],
    correctness_invariants: [
      'RuntimeSupportedLimits guard executes before production transaction invocation',
      'production transaction callback remains uninvoked on rejection',
      'database bytes remain identical across deterministic rejection',
    ],
    statistics: null,
    beyond_limit_rejection: {
      status: 'rejected_before_atomic_write',
      error_code: rejection.code,
      attempted_dimensions: dimensions as JsonObject,
      database_before_hash: beforeHash,
      database_after_hash: afterHash,
      affected_rows: 0,
    },
  };
}

function prepareCase(
  caseRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
  transaction: G8BenchmarkTransaction,
  shape: string,
  profile: G8BenchmarkProfile,
): PreparedBenchmarkCase {
  if (transaction === 't3')
    return prepareT3Case(caseRoot, identityMode, shape as G8T3Shape, profile);
  if (transaction === 't7')
    return prepareT7Case(caseRoot, identityMode, shape, profile);
  return prepareT8Case(caseRoot, identityMode, shape, profile);
}

export function runG8BenchmarkCases(
  options: RunG8BenchmarkOptions,
): G8BenchmarkCaseObservation[] {
  const rootDir = assertEmptyDirectory(options.rootDir);
  const warmupIterations = options.warmupIterations ?? 10;
  const measurementIterations = options.measurementIterations ?? 100;
  if (
    !Number.isSafeInteger(warmupIterations) ||
    warmupIterations < 0 ||
    !Number.isSafeInteger(measurementIterations) ||
    measurementIterations < 1
  ) {
    throw new Error('G8 benchmark iteration counts are invalid');
  }
  const profiles = options.profiles ?? G8_BENCHMARK_PROFILES;
  const transactions = options.transactions ?? (['t3', 't7', 't8'] as const);
  const cases: G8BenchmarkCaseObservation[] = [];
  for (const transaction of transactions) {
    const shapes =
      options.shapes?.[transaction] ?? G8_BENCHMARK_SHAPES[transaction];
    for (const shape of shapes) {
      let supportedBase: string | null = null;
      for (const profile of profiles.filter(
        (candidate) => candidate !== 'beyond_limit',
      )) {
        const caseId = benchmarkCaseId(transaction, shape, profile);
        const caseRoot = path.join(
          rootDir,
          'bases',
          caseId.replaceAll(':', '-'),
        );
        fs.mkdirSync(caseRoot, { recursive: true });
        const prepared = prepareCase(
          caseRoot,
          options.identityMode,
          transaction,
          shape,
          profile,
        );
        if (profile === 'supported_limit')
          supportedBase = prepared.baseDatabasePath;
        for (let index = 0; index < warmupIterations; index += 1) {
          measurePreparedCase(
            prepared,
            path.join(
              rootDir,
              'warmup',
              caseId.replaceAll(':', '-'),
              String(index),
            ),
            options.identityMode,
          );
        }
        const samples: BenchmarkSample[] = [];
        for (let index = 0; index < measurementIterations; index += 1) {
          samples.push(
            measurePreparedCase(
              prepared,
              path.join(
                rootDir,
                'measurements',
                caseId.replaceAll(':', '-'),
                String(index),
              ),
              options.identityMode,
            ),
          );
        }
        const observation: G8BenchmarkCaseObservation = {
          case_id: caseId,
          transaction,
          shape,
          profile,
          scale_percent: prepared.scalePercent,
          warmup_iterations: warmupIterations,
          measurement_iterations: measurementIterations,
          dimensions: prepared.dimensions,
          production_entry: prepared.productionEntry,
          production_index_evidence: [...prepared.productionIndexEvidence],
          correctness_invariants: [...prepared.correctnessInvariants],
          statistics: statistics(samples),
          beyond_limit_rejection: null,
        };
        cases.push(observation);
        options.onCaseCompleted?.(observation);
      }
      if (profiles.includes('beyond_limit')) {
        if (!supportedBase) {
          const caseRoot = path.join(
            rootDir,
            'bases',
            `${transaction}-${shape}-beyond-source`,
          );
          fs.mkdirSync(caseRoot, { recursive: true });
          supportedBase = prepareCase(
            caseRoot,
            options.identityMode,
            transaction,
            shape,
            'smoke',
          ).baseDatabasePath;
        }
        const observation = beyondLimitObservation(
          transaction,
          shape,
          supportedBase,
          warmupIterations,
          measurementIterations,
        );
        cases.push(observation);
        options.onCaseCompleted?.(observation);
      }
    }
  }
  return cases;
}

export function hashG8BenchmarkCases(
  cases: readonly G8BenchmarkCaseObservation[],
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-runtime-benchmark-cases:1\n',
    cases as unknown as JsonValue,
  );
}

export const G8_BENCHMARK_NORMAL_PROFILES = NORMAL_PROFILES;
