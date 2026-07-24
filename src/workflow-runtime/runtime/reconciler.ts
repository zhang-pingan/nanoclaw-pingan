import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  G5_DATABASE_SCHEMA_HASH,
  G5_DATABASE_SCHEMA_VERSION,
  type RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertGraphEvent,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type G5TransactionFault,
} from './graph-store.js';
import { chargeAndInsertGraphFact, reserveLedgerResources } from './ledger.js';
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
  verifyCompiledPlanAuthority,
} from './plan-authority.js';

export interface T2CompileInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly expectedCompilerSnapshotHash: Sha256Hash;
  readonly sourceJson: JsonObject;
  readonly sourceHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
  readonly nowMs: number;
}

export function persistCompileResultT2a(
  store: WorkflowRuntimeStore,
  input: T2CompileInput,
  fault?: G5TransactionFault,
): { planId: string; disposition: 'compiled' | 'exact_replay' } {
  const claimedPlanHash = verifyCompiledPlanAuthority(input.plan);
  const observedSourceHash = domainSeparatedSha256(
    'icarus:workflow-graph-source:1\n',
    input.sourceJson,
  );
  if (
    input.plan.format !== 'icarus.workflow-graph-scope-plan/2' ||
    input.plan.source_hash !== input.sourceHash ||
    input.sourceHash !== observedSourceHash ||
    claimedPlanHash !== input.plan.plan_hash
  ) {
    throw new G5RuntimeError(
      'contract_invalid',
      'T2a requires the pinned Compiler Plan v2 result',
    );
  }
  const planId = stableRuntimeId('plan', {
    graph_run_id: input.graphRunId,
    plan_hash: input.plan.plan_hash,
  });
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const build = transaction.queryOne<{
        graph_run_id: string;
        compiler_snapshot_hash: string;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
        status: string;
        compiled_plan_id: string | null;
        compiled_plan_hash: string | null;
        row_version: number;
      }>(
        `SELECT graph_run_id, compiler_snapshot_hash, run_work_fence_epoch,
              owner_scope_work_fence_epoch, status, compiled_plan_id,
              compiled_plan_hash, row_version
         FROM workflow_graph_scope_builds WHERE id = ?`,
        [input.buildId],
      );
      const run = transaction.queryOne<{
        runtime_safety_snapshot_hash: string;
        compiler_toolchain_resource_hash: string;
        source_seed_hash: string;
        database_schema_version: number;
        database_schema_hash: string;
      }>(
        `SELECT runtime_safety_snapshot_hash, compiler_toolchain_resource_hash,
                source_seed_hash,
                database_schema_version, database_schema_hash
           FROM workflow_graph_runs WHERE id = ?`,
        [input.graphRunId],
      );
      const definition = transaction.queryOne<{
        publication_state: string;
        payload_state: string;
        inline_canonical_json: string | null;
      }>(
        `SELECT rr.publication_state, v.payload_state, v.inline_canonical_json
           FROM workflow_graph_runs r
           JOIN workflow_state_activations a ON a.id = r.state_instance_id
           JOIN workflow_registry_resources rr
             ON rr.id = a.workflow_definition_resource_id
            AND rr.content_hash = a.workflow_definition_resource_hash
           JOIN workflow_values v ON v.id = rr.canonical_value_id
          WHERE r.id = ? AND rr.resource_type = 'definition'`,
        [input.graphRunId],
      );
      const definitionContent =
        definition?.inline_canonical_json === null ||
        definition?.inline_canonical_json === undefined
          ? null
          : (JSON.parse(definition.inline_canonical_json) as JsonObject);
      const planPin = definitionContent
        ? objectField(definitionContent, 'compiled_plan_pin')
        : null;
      if (!build || build.graph_run_id !== input.graphRunId)
        throw new G5RuntimeError('precondition_failed', 'T2a build is missing');
      if (
        !run ||
        !definition ||
        definition.publication_state !== 'published' ||
        definition.payload_state !== 'live' ||
        !planPin ||
        planPin.plan_hash !== input.plan.plan_hash ||
        planPin.plan_format !== input.plan.format ||
        planPin.compiler_toolchain_hash !==
          input.plan.compiler_toolchain_hash ||
        planPin.compiler_build_hash !== input.plan.compiler_build_hash ||
        planPin.provenance !== 'sealed_g2_expected' ||
        run.source_seed_hash !== input.sourceHash ||
        input.plan.runtime_safety_hash !== run.runtime_safety_snapshot_hash ||
        input.plan.compiler_toolchain_hash !==
          run.compiler_toolchain_resource_hash ||
        run.database_schema_version !== G5_DATABASE_SCHEMA_VERSION ||
        run.database_schema_hash !== G5_DATABASE_SCHEMA_HASH
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T2a Plan safety, toolchain, or Schema 5 identity drift',
        );
      if (build.status === 'compiled') {
        if (
          build.compiled_plan_id !== planId ||
          build.compiled_plan_hash !== input.plan.plan_hash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T2a same build has different compiled bytes',
          );
        return { planId, disposition: 'exact_replay' };
      }
      if (
        !['ready_to_compile', 'compiling'].includes(build.status) ||
        build.row_version !== input.expectedBuildRowVersion ||
        build.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        build.owner_scope_work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch ||
        build.compiler_snapshot_hash !== input.expectedCompilerSnapshotHash
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T2a lease, epoch, hash, or row version is stale',
        );
      transaction.execute(
        `INSERT INTO workflow_graph_scope_plans (
       id, graph_run_id, plan_hash, format, compiler_version, source_json,
       source_value_id, source_hash, compiled_plan_json, compiled_plan_value_id,
       interface_snapshot_json, interface_snapshot_hash, policy_snapshot_json,
       policy_snapshot_hash, capability_catalog_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          input.graphRunId,
          input.plan.plan_hash,
          input.plan.format,
          input.plan.compiler_version,
          canonicalJson(input.sourceJson),
          input.sourceHash,
          canonicalJson(input.plan),
          canonicalJson(input.plan.interface_snapshot),
          input.plan.interface_snapshot_hash,
          canonicalJson(input.plan.effective_policy_snapshot),
          input.plan.policy_snapshot_hash,
          input.plan.capability_catalog_hash,
          input.nowMs,
        ],
      );
      const changed = transaction.execute(
        `UPDATE workflow_graph_scope_builds
          SET status = 'compiled', compiled_plan_id = ?, compiled_plan_hash = ?,
              lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
              row_version = row_version + 1, updated_at_ms = ?
        WHERE id = ? AND row_version = ? AND status IN ('ready_to_compile', 'compiling')
          AND run_work_fence_epoch = ? AND owner_scope_work_fence_epoch = ?
          AND compiler_snapshot_hash = ?`,
        [
          planId,
          input.plan.plan_hash,
          input.nowMs,
          input.buildId,
          input.expectedBuildRowVersion,
          input.expectedRunWorkFenceEpoch,
          input.expectedOwnerScopeWorkFenceEpoch,
          input.expectedCompilerSnapshotHash,
        ],
      ).changes;
      if (changed !== 1)
        throw new G5RuntimeError('cas_conflict', 'T2a build CAS failed');
      return { planId, disposition: 'compiled' };
    },
    fault,
  );
}

export interface T2MaterializeInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly rootScopeId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunRowVersion: number;
  readonly expectedScopeRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly planId: string;
  readonly plan: CompiledScopePlanV2Document;
  readonly inputSnapshot: RuntimeValueRef;
  readonly nowMs: number;
}

function objectField(value: JsonObject, key: string): JsonObject | null {
  const candidate = value[key];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as JsonObject)
    : null;
}

export function materializeRootScopeT2b(
  store: WorkflowRuntimeStore,
  input: T2MaterializeInput,
  fault?: G5TransactionFault,
): {
  manifestHash: Sha256Hash;
  nodeCount: number;
  edgeCount: number;
  disposition: 'materialized' | 'exact_replay';
} {
  verifyCompiledPlanAuthority(input.plan);
  const nodes = input.plan.nodes as JsonObject[];
  const dynamicNode = nodes.find((node) =>
    ['subgraph', 'expand', 'map'].includes(String(node.type)),
  );
  if (dynamicNode)
    throw new G5RuntimeError(
      'forbidden_surface',
      `T2b dynamic node ${String(dynamicNode.id)} belongs to G6`,
    );
  const edges = [
    ...(input.plan.control_edges as JsonObject[]),
    ...(input.plan.data_edges as JsonObject[]),
  ];
  const manifestPayload: JsonObject = {
    graph_run_id: input.graphRunId,
    manifest_seq: 1,
    entry_kind: 'scope_materialized',
    scope_id: input.rootScopeId,
    parent_scope_id: null,
    owner_node_id: null,
    child_key: null,
    scope_kind: 'root',
    source_hash: input.plan.source_hash,
    plan_hash: input.plan.plan_hash,
    interface_hash: input.plan.interface_snapshot_hash,
    input_hash: input.inputSnapshot.hash,
    policy_hash: input.plan.policy_snapshot_hash,
    previous_manifest_hash: `sha256:${'0'.repeat(64)}`,
    created_at_ms: input.nowMs,
  };
  const manifestHash = runtimeObjectHash('run-manifest-entry', manifestPayload);
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const existing = transaction.queryOne<{ manifest_hash: Sha256Hash }>(
        'SELECT manifest_hash FROM workflow_graph_run_manifest WHERE graph_run_id = ? AND manifest_seq = 1',
        [input.graphRunId],
      );
      if (existing) {
        if (existing.manifest_hash !== manifestHash)
          throw new G5RuntimeError('integrity_violation', 'T2b manifest drift');
        return {
          manifestHash,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          disposition: 'exact_replay',
        };
      }
      const run = transaction.queryOne<{
        control: string;
        operational_state: string;
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT control, operational_state, lifecycle, work_fence_epoch, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT lifecycle, work_fence_epoch, row_version FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.rootScopeId, input.graphRunId],
      );
      const build = transaction.queryOne<{
        status: string;
        compiled_plan_id: string | null;
        compiled_plan_hash: string | null;
        row_version: number;
      }>(
        'SELECT status, compiled_plan_id, compiled_plan_hash, row_version FROM workflow_graph_scope_builds WHERE id = ? AND graph_run_id = ?',
        [input.buildId, input.graphRunId],
      );
      const persistedPlan = transaction.queryOne<{
        compiled_plan_json: string;
        plan_hash: string;
      }>(
        'SELECT compiled_plan_json, plan_hash FROM workflow_graph_scope_plans WHERE id = ? AND graph_run_id = ?',
        [input.planId, input.graphRunId],
      );
      if (
        !run ||
        !scope ||
        !build ||
        !persistedPlan ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        run.row_version !== input.expectedRunRowVersion ||
        scope.lifecycle !== 'materializing' ||
        scope.row_version !== input.expectedScopeRowVersion ||
        build.status !== 'compiled' ||
        build.compiled_plan_id !== input.planId ||
        build.compiled_plan_hash !== input.plan.plan_hash ||
        persistedPlan.plan_hash !== input.plan.plan_hash ||
        persistedPlan.compiled_plan_json !== canonicalJson(input.plan) ||
        build.row_version !== input.expectedBuildRowVersion
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T2b run, scope, build, or epoch precondition failed',
        );
      const reservationGroupId = stableRuntimeId('reservation-group', {
        graph_run_id: input.graphRunId,
        scope_id: input.rootScopeId,
        purpose: 'materialization',
      });
      const materializationAmounts: Record<string, number> = {
        scopes_total: 1,
        nodes_total: nodes.length,
      };
      if (edges.length > 0) materializationAmounts.edges_total = edges.length;
      reserveLedgerResources(transaction, {
        graphRunId: input.graphRunId,
        reservationGroupId,
        consumer: { scopeId: input.rootScopeId },
        amounts: materializationAmounts,
        purpose: 'scope_materialization',
        settlementMode: 'consume_on_create',
        nowMs: input.nowMs,
      });
      for (const node of [...nodes].sort((left, right) =>
        String(left.id).localeCompare(String(right.id), 'en'),
      )) {
        const nodeKey = String(node.id);
        const nodeType = String(node.type);
        const binding = objectField(node, 'capability_binding');
        const capabilityRef = binding ? objectField(binding, 'ref') : null;
        const capabilityRowId = capabilityRef
          ? registryResourceId({
              resource_type: 'capability',
              ref: {
                id: String(capabilityRef.id),
                version: String(capabilityRef.version),
              },
            })
          : null;
        const capabilityResource = capabilityRowId
          ? transaction.queryOne<{
              id: string;
              content_hash: string;
              publication_state: string;
            }>(
              `SELECT id, content_hash, publication_state
                 FROM workflow_registry_resources
                WHERE id = ? AND resource_type = 'capability'
                  AND resource_id = ? AND resource_version = ?`,
              [
                capabilityRowId,
                String(capabilityRef!.id),
                String(capabilityRef!.version),
              ],
            )
          : null;
        if (
          capabilityRowId &&
          (!capabilityResource ||
            capabilityResource.publication_state !== 'published')
        )
          throw new G5RuntimeError(
            'precondition_failed',
            `T2b exact Published capability is unavailable: ${nodeKey}`,
          );
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
         published_output_envelope_hash, port_contract_hash, current_attempt_id,
         current_attempt_no, active_wait_id, controller_state,
         controller_decision_json, controller_decision_hash,
         controller_remaining_count, controller_reservation_group_id,
         row_version, ready_at_ms, terminal_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unknown', 'open',
         NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, NULL,
         1, NULL, NULL, ?, ?)`,
          [
            stableRuntimeId('node', {
              graph_run_id: input.graphRunId,
              scope_id: input.rootScopeId,
              node_key: nodeKey,
            }),
            input.graphRunId,
            input.rootScopeId,
            nodeKey,
            nodeType,
            capabilityRowId,
            capabilityRef ? String(capabilityRef.version) : null,
            capabilityResource?.content_hash ?? null,
            canonicalJson(node),
            input.plan.interface_snapshot_hash,
            null,
            null,
            input.nowMs,
            input.nowMs,
          ],
        );
      }
      for (const edge of edges.sort((left, right) =>
        String(left.id).localeCompare(String(right.id), 'en'),
      )) {
        const edgeKey = String(edge.id);
        const edgeKind = (input.plan.control_edges as JsonObject[]).includes(
          edge,
        )
          ? 'control'
          : 'data';
        const edgeId = stableRuntimeId('edge', {
          graph_run_id: input.graphRunId,
          scope_id: input.rootScopeId,
          edge_key: edgeKey,
        });
        const compiledHash = String(edge.compiled_edge_hash) as Sha256Hash;
        transaction.execute(
          'INSERT INTO workflow_graph_edges (id, graph_run_id, scope_id, edge_key, edge_kind, compiled_edge_json, compiled_edge_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            edgeId,
            input.graphRunId,
            input.rootScopeId,
            edgeKey,
            edgeKind,
            canonicalJson(edge),
            compiledHash,
          ],
        );
        if (edgeKind === 'control')
          transaction.execute(
            "INSERT INTO workflow_graph_control_edge_resolutions (edge_id, state, decision_input_hash, decision_json, error_code, resolution_seq, resolved_at_ms, row_version) VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, 1)",
            [edgeId],
          );
        else
          transaction.execute(
            "INSERT INTO workflow_graph_data_edge_resolutions (edge_id, state, value_value_id, value_hash, schema_hash, source_attempt_id, error_code, resolution_seq, resolved_at_ms, row_version) VALUES (?, 'unresolved', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)",
            [edgeId],
          );
      }
      transaction.execute(
        `INSERT INTO workflow_graph_run_manifest (
       graph_run_id, manifest_seq, entry_kind, scope_id, expansion_manifest_id,
       parent_scope_id, owner_node_id, child_key, scope_kind, source_hash,
       plan_hash, interface_hash, input_hash, policy_hash, expansion_hash,
       item_count, previous_manifest_hash, manifest_hash, created_at_ms
     ) VALUES (?, 1, 'scope_materialized', ?, NULL, NULL, NULL, NULL, 'root', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        [
          input.graphRunId,
          input.rootScopeId,
          input.plan.source_hash,
          input.plan.plan_hash,
          input.plan.interface_snapshot_hash,
          input.inputSnapshot.hash,
          input.plan.policy_snapshot_hash,
          `sha256:${'0'.repeat(64)}`,
          manifestHash,
          input.nowMs,
        ],
      );
      if (
        transaction.execute(
          "UPDATE workflow_graph_scopes SET plan_id = ?, plan_hash = ?, materialization_reservation_group_id = ?, lifecycle = 'active', row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND lifecycle = 'materializing'",
          [
            input.planId,
            input.plan.plan_hash,
            reservationGroupId,
            input.nowMs,
            input.rootScopeId,
            input.expectedScopeRowVersion,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T2b scope CAS failed');
      if (
        transaction.execute(
          "UPDATE workflow_graph_scope_builds SET status = 'materialized', scope_id = ?, materialization_reservation_group_id = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND status = 'compiled'",
          [
            input.rootScopeId,
            reservationGroupId,
            input.nowMs,
            input.buildId,
            input.expectedBuildRowVersion,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T2b build CAS failed');
      const refreshed = transaction.queryOne<{
        row_version: number;
        next_event_seq: number;
      }>(
        'SELECT row_version, next_event_seq FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      const sequence = refreshed.next_event_seq + 1;
      if (
        transaction.execute(
          "UPDATE workflow_graph_runs SET root_plan_hash = ?, manifest_seq = 1, manifest_head_hash = ?, lifecycle = 'executing', next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND control = 'running' AND operational_state = 'healthy'",
          [
            input.plan.plan_hash,
            manifestHash,
            sequence,
            input.nowMs,
            input.graphRunId,
            refreshed.row_version,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T2b Run CAS failed');
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence,
        scopeId: input.rootScopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'scope_materialized',
        idempotencyKey: `scope-materialized:${input.rootScopeId}`,
        payloadJson: null,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      return {
        manifestHash,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        disposition: 'materialized',
      };
    },
    fault,
  );
}

export interface ReconcileIngressFact {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly expectedRunRowVersion: number;
  readonly factKind:
    | 'node_terminal'
    | 'node_output_published'
    | 'wait_resolved'
    | 'build_failed'
    | 'orchestration_error';
  readonly stableObjectKind: string;
  readonly stableObjectId: string;
  readonly factKey: string;
  readonly payload: RuntimeValueRef;
  readonly terminalStatus?: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  readonly nowMs: number;
}

export function initializeScopeFixedPointT3a(
  store: WorkflowRuntimeStore,
  input: {
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly expectedRunRowVersion: number;
    readonly nowMs: number;
  },
  fault?: G5TransactionFault,
): { readyNodeIds: string[]; lastEventSequence: number } {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
        work_fence_epoch: number;
        control: string;
        operational_state: string;
      }>(
        'SELECT next_event_seq, row_version, work_fence_epoch, control, operational_state FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        input_snapshot_value_id: string | null;
        input_snapshot_hash: Sha256Hash | null;
        work_fence_epoch: number;
        lifecycle: string;
      }>(
        'SELECT input_snapshot_value_id, input_snapshot_hash, work_fence_epoch, lifecycle FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.scopeId, input.graphRunId],
      );
      if (
        !run ||
        !scope ||
        run.row_version !== input.expectedRunRowVersion ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        scope.lifecycle !== 'active' ||
        scope.input_snapshot_value_id === null ||
        scope.input_snapshot_hash === null
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a scope initialization precondition failed',
        );
      let sequence = run.next_event_seq;
      const scopeInputEdges = transaction.queryAll<{
        id: string;
        edge_key: string;
        compiled_edge_json: string;
      }>(
        `SELECT e.id, e.edge_key, e.compiled_edge_json
           FROM workflow_graph_edges e
           JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_kind = 'data'
            AND json_extract(e.compiled_edge_json, '$.from.type') = 'scope_input'
            AND r.state = 'unresolved'
          ORDER BY e.edge_key COLLATE BINARY`,
        [input.graphRunId, input.scopeId],
      );
      for (const edge of scopeInputEdges) {
        const compiled = JSON.parse(edge.compiled_edge_json) as JsonObject;
        const derivedSchema = objectField(compiled, 'derived_schema');
        sequence += 1;
        if (
          transaction.execute(
            "UPDATE workflow_graph_data_edge_resolutions SET state = 'available', value_value_id = ?, value_hash = ?, schema_hash = ?, source_attempt_id = NULL, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'",
            [
              scope.input_snapshot_value_id,
              scope.input_snapshot_hash,
              String(
                derivedSchema?.schema_hash ?? compiled.producer_schema_hash,
              ),
              sequence,
              input.nowMs,
              edge.id,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            `T3a scope-input edge CAS failed: ${edge.id}`,
          );
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: null,
          attemptId: null,
          eventType: 'data_edge_resolved',
          idempotencyKey: `data-edge:${edge.id}`,
          payloadValueId: scope.input_snapshot_value_id,
          payloadHash: scope.input_snapshot_hash,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        chargeAndInsertGraphFact(transaction, {
          id: stableRuntimeId('fact', {
            graph_run_id: input.graphRunId,
            fact_key: `data-edge:${edge.id}`,
          }),
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          eventSeq: sequence,
          causalEventSeq: sequence,
          causalWave: 0,
          factKind: 'data_edge_resolved',
          stableObjectKind: 'edge',
          stableObjectId: edge.id,
          factKey: `data-edge:${edge.id}`,
          payloadValueId: scope.input_snapshot_value_id,
          payloadHash: scope.input_snapshot_hash,
          createdAtMs: input.nowMs,
        });
      }
      const sources = transaction.queryAll<{ id: string; row_version: number }>(
        `SELECT n.id, n.row_version
         FROM workflow_graph_nodes n
        WHERE n.graph_run_id = ? AND n.scope_id = ? AND n.phase = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_edges e
             WHERE e.graph_run_id = n.graph_run_id AND e.scope_id = n.scope_id
               AND e.edge_kind = 'control'
               AND json_extract(e.compiled_edge_json, '$.to_node_id') = n.node_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM workflow_graph_edges e
            JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
             WHERE e.graph_run_id = n.graph_run_id AND e.scope_id = n.scope_id
               AND json_extract(e.compiled_edge_json, '$.to.node_id') = n.node_key
               AND r.state <> 'available'
          )
        ORDER BY n.node_key COLLATE BINARY`,
        [input.graphRunId, input.scopeId],
      );
      for (const source of sources) {
        const triggerHash = runtimeObjectHash('trigger-cut', {
          node_id: source.id,
          source: true,
        });
        sequence += 1;
        const changed = transaction.execute(
          `UPDATE workflow_graph_nodes
            SET phase = 'ready', trigger_state = 'true', input_state = 'sealed',
                trigger_cut_json = '{"source":true}', trigger_cut_hash = ?,
                input_snapshot_json = NULL, input_snapshot_value_id = ?,
                input_snapshot_hash = ?, selected_edges_json = '[]',
                activation_event_seq = ?, run_work_fence_epoch_at_activation = ?,
                scope_work_fence_epoch_at_activation = ?, ready_at_ms = ?,
                row_version = row_version + 1, updated_at_ms = ?
          WHERE id = ? AND row_version = ? AND phase = 'pending'`,
          [
            triggerHash,
            scope.input_snapshot_value_id,
            scope.input_snapshot_hash,
            sequence,
            run.work_fence_epoch,
            scope.work_fence_epoch,
            input.nowMs,
            input.nowMs,
            source.id,
            source.row_version,
          ],
        ).changes;
        if (changed !== 1)
          throw new G5RuntimeError(
            'cas_conflict',
            'T3a source node CAS failed',
          );
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: source.id,
          attemptId: null,
          eventType: 'node_ready',
          idempotencyKey: `node-ready:${source.id}`,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        chargeAndInsertGraphFact(transaction, {
          id: stableRuntimeId('fact', {
            graph_run_id: input.graphRunId,
            fact_key: `node-ready:${source.id}`,
          }),
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          eventSeq: sequence,
          causalEventSeq: sequence,
          causalWave: 0,
          factKind: 'node_ready',
          stableObjectKind: 'node',
          stableObjectId: source.id,
          factKey: `node-ready:${source.id}`,
          payloadValueId: scope.input_snapshot_value_id,
          payloadHash: scope.input_snapshot_hash,
          createdAtMs: input.nowMs,
        });
      }
      const refreshed = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      if (refreshed.next_event_seq !== run.next_event_seq)
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a source event head changed during initialization',
        );
      if (
        sources.length > 0 &&
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
          [sequence, input.nowMs, input.graphRunId, refreshed.row_version],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a source event head CAS failed',
        );
      return {
        readyNodeIds: sources.map((row) => row.id),
        lastEventSequence: sequence,
      };
    },
    fault,
  );
}

export function reconcileFactT3a(
  store: WorkflowRuntimeStore,
  input: ReconcileIngressFact,
  fault?: G5TransactionFault,
): { disposition: 'reconciled' | 'exact_replay'; eventSequence: number } {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const duplicate = transaction.queryOne<{
        event_seq: number;
        payload_hash: string | null;
      }>(
        'SELECT event_seq, payload_hash FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?',
        [input.graphRunId, input.factKey],
      );
      if (duplicate) {
        if (duplicate.payload_hash !== (input.payload?.hash ?? null))
          throw new G5RuntimeError(
            'integrity_violation',
            'T3a duplicate fact payload drift',
          );
        return {
          disposition: 'exact_replay',
          eventSequence: duplicate.event_seq,
        };
      }
      const run = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
        work_fence_epoch: number;
        control: string;
        operational_state: string;
      }>(
        'SELECT next_event_seq, row_version, work_fence_epoch, control, operational_state FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
      }>(
        'SELECT lifecycle, work_fence_epoch FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.scopeId, input.graphRunId],
      );
      if (
        !run ||
        !scope ||
        run.row_version !== input.expectedRunRowVersion ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        scope.lifecycle !== 'active'
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a Run row version or operational state is stale',
        );
      let sequence = run.next_event_seq;
      let ingressSequence: number | null = null;
      const append = (
        factKind: string,
        stableObjectKind: string,
        stableObjectId: string,
        factKey: string,
        payload: RuntimeValueRef,
        wave: number,
      ): number => {
        sequence += 1;
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: stableObjectKind === 'node' ? stableObjectId : null,
          attemptId: null,
          eventType: factKind,
          idempotencyKey: factKey,
          payloadJson: null,
          payloadValueId: payload.id,
          payloadHash: payload.hash,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        chargeAndInsertGraphFact(transaction, {
          id: stableRuntimeId('fact', {
            graph_run_id: input.graphRunId,
            fact_key: factKey,
          }),
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          eventSeq: sequence,
          causalEventSeq: wave === 0 ? sequence : ingressSequence!,
          causalWave: wave,
          factKind,
          stableObjectKind,
          stableObjectId,
          factKey,
          payloadValueId: payload.id,
          payloadHash: payload.hash,
          createdAtMs: input.nowMs,
        });
        return sequence;
      };
      ingressSequence = append(
        input.factKind,
        input.stableObjectKind,
        input.stableObjectId,
        input.factKey,
        input.payload,
        0,
      );
      if (input.factKind === 'node_terminal' && input.terminalStatus) {
        const node = transaction.queryOne<{
          id: string;
          node_key: string;
          phase: string;
          current_attempt_id: string | null;
          row_version: number;
        }>(
          'SELECT id, node_key, phase, current_attempt_id, row_version FROM workflow_graph_nodes WHERE id = ? AND graph_run_id = ? AND scope_id = ?',
          [input.stableObjectId, input.graphRunId, input.scopeId],
        );
        if (!node)
          throw new G5RuntimeError(
            'precondition_failed',
            'T3a source node is missing',
          );
        const persistedTerminal = transaction.queryOne<{
          terminal_status: string | null;
          published_output_envelope_value_id: string | null;
          published_output_envelope_hash: string | null;
        }>(
          "SELECT terminal_status, published_output_envelope_value_id, published_output_envelope_hash FROM workflow_graph_nodes WHERE id = ? AND phase = 'terminal'",
          [node.id],
        );
        if (
          !persistedTerminal ||
          persistedTerminal.terminal_status !== input.terminalStatus ||
          (input.terminalStatus === 'succeeded' &&
            (persistedTerminal.published_output_envelope_value_id !==
              input.payload.id ||
              persistedTerminal.published_output_envelope_hash !==
                input.payload.hash))
        )
          throw new G5RuntimeError(
            'precondition_failed',
            'T3a terminal fact is not backed by persisted Node output',
          );
        const outgoing = transaction.queryAll<{
          id: string;
          edge_key: string;
          edge_kind: 'control' | 'data';
          compiled_edge_json: string;
        }>(
          'SELECT id, edge_key, edge_kind, compiled_edge_json FROM workflow_graph_edges WHERE graph_run_id = ? AND scope_id = ? ORDER BY edge_key COLLATE BINARY',
          [input.graphRunId, input.scopeId],
        );
        for (const edge of outgoing.filter(
          (candidate) => candidate.edge_kind === 'control',
        )) {
          const compiled = JSON.parse(edge.compiled_edge_json) as JsonObject;
          if (compiled.from_node_id !== node.node_key) continue;
          const statuses = ((compiled.outcome_match as JsonObject | undefined)
            ?.statuses ?? []) as unknown[];
          const taken = statuses.includes(input.terminalStatus);
          const resolutionHash = runtimeObjectHash('control-decision', {
            edge_id: edge.id,
            terminal_status: input.terminalStatus,
            taken,
          });
          const changed = transaction.execute(
            "UPDATE workflow_graph_control_edge_resolutions SET state = ?, decision_input_hash = ?, decision_json = ?, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'",
            [
              taken ? 'taken' : 'not_taken',
              input.payload.hash ?? resolutionHash,
              canonicalJson({ terminal_status: input.terminalStatus, taken }),
              sequence + 1,
              input.nowMs,
              edge.id,
            ],
          ).changes;
          if (changed !== 1)
            throw new G5RuntimeError(
              'integrity_violation',
              `T3a control edge was not unresolved: ${edge.id}`,
            );
          append(
            'control_edge_resolved',
            'edge',
            edge.id,
            `control-edge:${edge.id}`,
            input.payload,
            1,
          );
        }
        for (const edge of outgoing.filter(
          (candidate) => candidate.edge_kind === 'data',
        )) {
          const compiled = JSON.parse(edge.compiled_edge_json) as JsonObject;
          const from = objectField(compiled, 'from');
          if (from?.node_id !== node.node_key) continue;
          const available = input.terminalStatus === 'succeeded';
          const derivedSchema = available
            ? objectField(compiled, 'derived_schema')
            : null;
          const changed = transaction.execute(
            available
              ? "UPDATE workflow_graph_data_edge_resolutions SET state = 'available', value_value_id = ?, value_hash = ?, schema_hash = ?, source_attempt_id = ?, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'"
              : "UPDATE workflow_graph_data_edge_resolutions SET state = 'unavailable', value_value_id = NULL, value_hash = NULL, schema_hash = NULL, source_attempt_id = ?, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'",
            available
              ? [
                  input.payload.id,
                  input.payload.hash,
                  String(
                    derivedSchema?.schema_hash ?? compiled.producer_schema_hash,
                  ),
                  node.current_attempt_id,
                  sequence + 1,
                  input.nowMs,
                  edge.id,
                ]
              : [node.current_attempt_id, sequence + 1, input.nowMs, edge.id],
          ).changes;
          if (changed !== 1)
            throw new G5RuntimeError(
              'integrity_violation',
              `T3a data edge was not unresolved: ${edge.id}`,
            );
          append(
            'data_edge_resolved',
            'edge',
            edge.id,
            `data-edge:${edge.id}`,
            input.payload,
            1,
          );
        }
        const targetKeys = outgoing
          .map((row) => {
            const compiled = JSON.parse(row.compiled_edge_json) as JsonObject;
            return compiled.to_node_id ?? objectField(compiled, 'to')?.node_id;
          })
          .filter((value): value is string => typeof value === 'string');
        for (const targetKey of [...new Set(targetKeys)].sort()) {
          const target = transaction.queryOne<{
            id: string;
            phase: string;
            row_version: number;
            node_type: string;
          }>(
            'SELECT id, phase, row_version, node_type FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? AND node_key = ?',
            [input.graphRunId, input.scopeId, targetKey],
          );
          if (!target || target.phase !== 'pending') continue;
          const unresolved = transaction.queryOne<{ count: number }>(
            `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND json_extract(e.compiled_edge_json, '$.to_node_id') = ? AND r.state = 'unresolved'`,
            [input.graphRunId, input.scopeId, targetKey],
          )!;
          const taken = transaction.queryOne<{ count: number }>(
            `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND json_extract(e.compiled_edge_json, '$.to_node_id') = ? AND r.state = 'taken'`,
            [input.graphRunId, input.scopeId, targetKey],
          )!;
          const controlTotal = transaction.queryOne<{ count: number }>(
            `SELECT count(*) AS count FROM workflow_graph_edges e WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_kind = 'control' AND json_extract(e.compiled_edge_json, '$.to_node_id') = ?`,
            [input.graphRunId, input.scopeId, targetKey],
          )!;
          const unresolvedData = transaction.queryOne<{ count: number }>(
            `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND json_extract(e.compiled_edge_json, '$.to.node_id') = ? AND r.state = 'unresolved'`,
            [input.graphRunId, input.scopeId, targetKey],
          )!;
          const unavailableData = transaction.queryOne<{ count: number }>(
            `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND json_extract(e.compiled_edge_json, '$.to.node_id') = ? AND r.state IN ('unavailable', 'error')`,
            [input.graphRunId, input.scopeId, targetKey],
          )!;
          if (unresolved.count === 0) {
            if (
              (controlTotal.count === 0 ||
                taken.count === controlTotal.count) &&
              unresolvedData.count === 0 &&
              unavailableData.count === 0
            ) {
              const inputEdges = transaction.queryAll<{
                edge_key: string;
                value_value_id: string;
                value_hash: string;
                schema_hash: string;
              }>(
                `SELECT e.edge_key, r.value_value_id, r.value_hash, r.schema_hash
                   FROM workflow_graph_edges e
                   JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
                  WHERE e.graph_run_id = ? AND e.scope_id = ?
                    AND json_extract(e.compiled_edge_json, '$.to.node_id') = ?
                    AND r.state = 'available'
                  ORDER BY e.edge_key COLLATE BINARY`,
                [input.graphRunId, input.scopeId, targetKey],
              );
              const inputSnapshot = inputEdges.map((edge) => ({
                edge_key: edge.edge_key,
                value_id: edge.value_value_id,
                value_hash: edge.value_hash,
                schema_hash: edge.schema_hash,
              }));
              if (
                transaction.execute(
                  "UPDATE workflow_graph_nodes SET phase = 'ready', trigger_state = 'true', input_state = 'sealed', trigger_cut_json = '{}', trigger_cut_hash = ?, input_snapshot_json = ?, input_snapshot_value_id = NULL, input_snapshot_hash = ?, activation_event_seq = ?, run_work_fence_epoch_at_activation = ?, scope_work_fence_epoch_at_activation = ?, ready_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?",
                  [
                    runtimeObjectHash('trigger-cut', { node_id: target.id }),
                    canonicalJson(inputSnapshot),
                    runtimeObjectHash('input-snapshot', inputSnapshot),
                    sequence + 1,
                    run.work_fence_epoch,
                    scope.work_fence_epoch,
                    input.nowMs,
                    input.nowMs,
                    target.id,
                    target.row_version,
                  ],
                ).changes !== 1
              )
                throw new G5RuntimeError(
                  'cas_conflict',
                  `T3a target ready CAS failed: ${target.id}`,
                );
              append(
                'node_ready',
                'node',
                target.id,
                `node-ready:${target.id}`,
                input.payload,
                2,
              );
            } else if (
              (controlTotal.count > 0 && taken.count !== controlTotal.count) ||
              unavailableData.count > 0
            ) {
              if (
                transaction.execute(
                  "UPDATE workflow_graph_nodes SET phase = 'terminal', trigger_state = 'false', input_state = 'impossible', terminal_status = 'skipped', terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?",
                  [input.nowMs, input.nowMs, target.id, target.row_version],
                ).changes !== 1
              )
                throw new G5RuntimeError(
                  'cas_conflict',
                  `T3a target skip CAS failed: ${target.id}`,
                );
              append(
                'node_skipped',
                'node',
                target.id,
                `node-skipped:${target.id}`,
                input.payload,
                2,
              );
            }
          }
        }
      }
      const refreshed = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      if (refreshed.next_event_seq !== run.next_event_seq)
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a event head changed during fixed-point reconciliation',
        );
      const changed = transaction.execute(
        'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ?',
        [sequence, input.nowMs, input.graphRunId, refreshed.row_version],
      ).changes;
      if (changed !== 1)
        throw new G5RuntimeError('cas_conflict', 'T3a event head CAS failed');
      return { disposition: 'reconciled', eventSequence: sequence };
    },
    fault,
  );
}

export interface T3bSettledCloseInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly expectedRunRowVersion: number;
  readonly expectedScopeRowVersion: number;
  readonly nowMs: number;
}

export function requestSettledCloseT3b(
  store: WorkflowRuntimeStore,
  input: T3bSettledCloseInput,
  fault?: G5TransactionFault,
): { disposition: 'close_requested' | 'exact_replay'; closeRequestId: string } {
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const authorityNode = transaction.queryOne<{ id: string }>(
        'SELECT id FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY LIMIT 1',
        [input.graphRunId, input.scopeId],
      );
      if (!authorityNode)
        throw new G5RuntimeError(
          'precondition_failed',
          'T3b materialized scope has no Plan nodes',
        );
      const authority = loadMaterializedNodeAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
        authorityNode.id,
      );
      const completion = requiredObjectField(
        authority.plan as unknown as JsonObject,
        'completion',
        'Compiled Plan v2',
      );
      const settledRules = Array.isArray(completion.settled_rules)
        ? (completion.settled_rules as JsonObject[])
        : [];
      const selectedRule = [...settledRules].sort((left, right) => {
        const byPriority = Number(right.priority) - Number(left.priority);
        return byPriority !== 0
          ? byPriority
          : String(left.id).localeCompare(String(right.id), 'en');
      })[0];
      if (!selectedRule || typeof selectedRule.id !== 'string')
        throw new G5RuntimeError(
          'precondition_failed',
          'T3b Plan has no settled completion rule',
        );
      const selectedRuleId = selectedRule.id;
      const completionPolicyHash = String(completion.policy_hash) as Sha256Hash;
      const prior = transaction.queryOne<{
        id: string;
        selected_rule_id: string | null;
      }>(
        'SELECT id, selected_rule_id FROM workflow_graph_scope_close_requests WHERE graph_run_id = ? AND scope_id = ?',
        [input.graphRunId, input.scopeId],
      );
      if (prior) {
        if (prior.selected_rule_id !== selectedRuleId)
          throw new G5RuntimeError(
            'integrity_violation',
            'T3b close arbitration drift',
          );
        return { disposition: 'exact_replay', closeRequestId: prior.id };
      }
      const run = transaction.queryOne<{
        lifecycle: string;
        control: string;
        operational_state: string;
        next_event_seq: number;
        work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT lifecycle, control, operational_state, next_event_seq, work_fence_epoch, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      );
      const scope = transaction.queryOne<{
        lifecycle: string;
        work_fence_epoch: number;
        row_version: number;
      }>(
        'SELECT lifecycle, work_fence_epoch, row_version FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.scopeId, input.graphRunId],
      );
      if (
        !run ||
        !scope ||
        run.lifecycle !== 'executing' ||
        run.control !== 'running' ||
        run.operational_state !== 'healthy' ||
        run.row_version !== input.expectedRunRowVersion ||
        scope.lifecycle !== 'active' ||
        scope.row_version !== input.expectedScopeRowVersion
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3b requires a running healthy quiescent scope',
        );
      const nonterminal = transaction.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? AND phase <> 'terminal'",
        [input.graphRunId, input.scopeId],
      )!.count;
      const unresolvedControl = transaction.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND r.state = 'unresolved'`,
        [input.graphRunId, input.scopeId],
      )!.count;
      const unresolvedData = transaction.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_edges e JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id WHERE e.graph_run_id = ? AND e.scope_id = ? AND r.state = 'unresolved'`,
        [input.graphRunId, input.scopeId],
      )!.count;
      if (nonterminal !== 0 || unresolvedControl !== 0 || unresolvedData !== 0)
        throw new G5RuntimeError(
          'precondition_failed',
          'T3b fixed point is not quiescent',
        );
      const candidates = transaction.queryAll<{
        id: string;
        terminal_node_id: string;
        node_key: string;
        candidate_seq: number;
        output_snapshot_value_id: string;
        output_snapshot_hash: Sha256Hash;
      }>(
        `SELECT c.id, c.terminal_node_id, n.node_key, c.candidate_seq,
                c.output_snapshot_value_id, c.output_snapshot_hash
           FROM workflow_graph_terminal_candidates c
           JOIN workflow_graph_nodes n ON n.id = c.terminal_node_id
          WHERE c.graph_run_id = ? AND c.scope_id = ?
          ORDER BY n.node_key COLLATE BINARY`,
        [input.graphRunId, input.scopeId],
      );
      const selector = requiredObjectField(
        selectedRule,
        'selector',
        'Plan settled completion rule',
      );
      const exits = Array.isArray(selector.exits)
        ? selector.exits.map(String)
        : [];
      const candidate = candidates.find((row) => exits.includes(row.node_key));
      if (!candidate)
        throw new G5RuntimeError(
          'precondition_failed',
          'T3b no terminal candidate matched',
        );
      const factRows = transaction.queryAll<{
        fact_key: string;
        payload_hash: string | null;
      }>(
        'SELECT fact_key, payload_hash FROM workflow_graph_facts WHERE graph_run_id = ? AND scope_id = ? ORDER BY event_seq, fact_key COLLATE BINARY',
        [input.graphRunId, input.scopeId],
      );
      const nodeRows = transaction.queryAll<{
        id: string;
        phase: string;
        terminal_status: string | null;
        row_version: number;
      }>(
        'SELECT id, phase, terminal_status, row_version FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY',
        [input.graphRunId, input.scopeId],
      );
      const edgeRows = transaction.queryAll<{ id: string; edge_kind: string }>(
        'SELECT id, edge_kind FROM workflow_graph_edges WHERE graph_run_id = ? AND scope_id = ? ORDER BY edge_key COLLATE BINARY',
        [input.graphRunId, input.scopeId],
      );
      const factSnapshotHash = runtimeObjectHash(
        'fact-snapshot',
        factRows as unknown as JsonObject[],
      );
      const nodeFrontierHash = runtimeObjectHash(
        'node-frontier',
        nodeRows as unknown as JsonObject[],
      );
      const edgeFrontierHash = runtimeObjectHash(
        'edge-frontier',
        edgeRows as unknown as JsonObject[],
      );
      const eligibilitySequence = run.next_event_seq + 1;
      const closeSequence = eligibilitySequence + 1;
      const eligibilityId = stableRuntimeId('eligibility', {
        graph_run_id: input.graphRunId,
        scope_id: input.scopeId,
        rule_id: selectedRuleId,
        phase: 'settled',
      });
      transaction.execute(
        "INSERT INTO workflow_graph_completion_eligibilities (id, graph_run_id, scope_id, rule_id, phase, eligibility_event_seq, selected_candidate_id, fact_snapshot_json, fact_snapshot_hash, created_at_ms) VALUES (?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?)",
        [
          eligibilityId,
          input.graphRunId,
          input.scopeId,
          selectedRuleId,
          eligibilitySequence,
          candidate.id,
          canonicalJson(factRows as unknown as JsonObject[]),
          factSnapshotHash,
          input.nowMs,
        ],
      );
      const requestPayload: JsonObject = {
        graph_run_id: input.graphRunId,
        scope_id: input.scopeId,
        selected_rule_id: selectedRuleId,
        candidate_id: candidate.id,
        fact_snapshot_hash: factSnapshotHash,
        node_frontier_hash: nodeFrontierHash,
        edge_frontier_hash: edgeFrontierHash,
        completion_policy_hash: completionPolicyHash,
        trigger_event_seq: closeSequence,
        fenced_work_epoch: scope.work_fence_epoch,
      };
      const requestHash = runtimeObjectHash(
        'scope-close-request',
        requestPayload,
      );
      const closeRequestId = stableRuntimeId('close-request', {
        graph_run_id: input.graphRunId,
        scope_id: input.scopeId,
        request_hash: requestHash,
      });
      transaction.execute(
        `INSERT INTO workflow_graph_scope_close_requests (
       id, graph_run_id, scope_id, selected_rule_id, candidate_id,
       eligibility_event_seq, fact_snapshot_json, fact_snapshot_hash,
       node_frontier_json, node_frontier_hash, edge_frontier_json,
       edge_frontier_hash, trigger_event_seq, fenced_work_epoch_at_creation,
       reason, error_code, error_detail_value_id, error_detail_hash,
       cancel_payload_json, cancel_payload_hash, request_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', NULL, NULL,
       NULL, NULL, NULL, ?, ?)`,
        [
          closeRequestId,
          input.graphRunId,
          input.scopeId,
          selectedRuleId,
          candidate.id,
          eligibilitySequence,
          canonicalJson(factRows as unknown as JsonObject[]),
          factSnapshotHash,
          canonicalJson(nodeRows as unknown as JsonObject[]),
          nodeFrontierHash,
          canonicalJson(edgeRows as unknown as JsonObject[]),
          edgeFrontierHash,
          closeSequence,
          scope.work_fence_epoch,
          requestHash,
          input.nowMs,
        ],
      );
      if (
        transaction.execute(
          "UPDATE workflow_graph_scopes SET lifecycle = 'closing', close_request_id = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND lifecycle = 'active'",
          [
            closeRequestId,
            input.nowMs,
            input.scopeId,
            input.expectedScopeRowVersion,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T3b Scope close CAS failed');
      if (
        transaction.execute(
          "UPDATE workflow_graph_runs SET lifecycle = 'closing', root_close_request_id = ?, next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND lifecycle = 'executing'",
          [
            closeRequestId,
            closeSequence,
            input.nowMs,
            input.graphRunId,
            input.expectedRunRowVersion,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError('cas_conflict', 'T3b Run close CAS failed');
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence: eligibilitySequence,
        scopeId: input.scopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'completion_eligibility',
        idempotencyKey: `completion-eligibility:${eligibilityId}`,
        payloadValueId: candidate.output_snapshot_value_id,
        payloadHash: candidate.output_snapshot_hash,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      chargeAndInsertGraphFact(transaction, {
        id: stableRuntimeId('fact', {
          graph_run_id: input.graphRunId,
          fact_key: `completion-eligibility:${eligibilityId}`,
        }),
        graphRunId: input.graphRunId,
        scopeId: input.scopeId,
        eventSeq: eligibilitySequence,
        causalEventSeq: eligibilitySequence,
        causalWave: 0,
        factKind: 'completion_eligibility',
        stableObjectKind: 'scope',
        stableObjectId: input.scopeId,
        factKey: `completion-eligibility:${eligibilityId}`,
        payloadValueId: candidate.output_snapshot_value_id,
        payloadHash: candidate.output_snapshot_hash,
        createdAtMs: input.nowMs,
      });
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence: closeSequence,
        scopeId: input.scopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'scope_close_requested',
        idempotencyKey: `scope-close:${input.scopeId}`,
        payloadJson: requestPayload,
        occurredAtMs: input.nowMs,
        createdAtMs: input.nowMs,
      });
      return { disposition: 'close_requested', closeRequestId };
    },
    fault,
  );
}
