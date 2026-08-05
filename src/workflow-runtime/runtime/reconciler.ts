import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { PlanGeneratedSchemaGenerator } from '../contracts/generated-schema-authority.js';
import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import type { WorkflowCompilerStaticChildPlanBundle } from '../contracts/static-child-plan-bundle-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  applicableCompletionRules,
  evaluateConditionProgram,
  evaluateInputSeal,
  evaluateTriggerProgram,
  validateCompiledInputValue,
  verifyCompletionPolicyAuthority,
  type CompletionCandidateObservation,
  type CompletionNodeObservation,
  type DataResolutionObservation,
  type InputSchemaAuthority,
  type InputSealEvaluation,
  type TriggerEdgeObservation,
} from './fixed-point-authority.js';
import {
  G5RuntimeError,
  insertGraphEvent,
  insertGraphEvents,
  insertInlineValue,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
  type GraphEventInsertInput,
  type GraphFactInsertInput,
  type G5TransactionFault,
  type InlineValueSchemaAuthority,
} from './graph-store.js';
import { requestScopeCloseT7aInTransaction } from './graph-runtime.js';
import {
  buildCanonicalNodeOutputEnvelope,
  loadPersistedPlanGeneratedSchemaAuthority,
  nodeOutputPortContractHash,
  persistPlanGeneratedSchemaAuthorities,
  verifyPersistedPlanGeneratedSchemaAuthorities,
  type PersistedPlanIdentity,
  type PublishedNodeOutputPort,
} from './generated-schema-runtime.js';
import {
  chargeAndInsertGraphFact,
  chargeAndInsertGraphFacts,
  reserveLedgerResources,
} from './ledger.js';
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
  verifyCompiledPlanAuthority,
} from './plan-authority.js';
import {
  verifyStaticChildPlanBundle,
  type VerifiedStaticChildPlan,
} from './static-child-plan-bundle.js';

interface T2PlanArtifact {
  readonly source: JsonObject;
  readonly sourceHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
}

function contentAddressedPlanId(graphRunId: string, planHash: string): string {
  return stableRuntimeId('plan', {
    graph_run_id: graphRunId,
    plan_hash: planHash,
  });
}

function persistOrVerifyT2Plan(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  artifact: T2PlanArtifact,
  nowMs: number,
  allowInsert: boolean,
): string {
  const planId = contentAddressedPlanId(graphRunId, artifact.plan.plan_hash);
  const expected = {
    id: planId,
    graph_run_id: graphRunId,
    plan_hash: artifact.plan.plan_hash,
    format: artifact.plan.format,
    compiler_version: artifact.plan.compiler_version,
    source_json: canonicalJson(artifact.source),
    source_value_id: null,
    source_hash: artifact.sourceHash,
    compiled_plan_json: canonicalJson(artifact.plan),
    compiled_plan_value_id: null,
    interface_snapshot_json: canonicalJson(artifact.plan.interface_snapshot),
    interface_snapshot_hash: artifact.plan.interface_snapshot_hash,
    policy_snapshot_json: canonicalJson(
      artifact.plan.effective_policy_snapshot,
    ),
    policy_snapshot_hash: artifact.plan.policy_snapshot_hash,
    capability_catalog_hash: artifact.plan.capability_catalog_hash,
  };
  const rows = transaction.queryAll<typeof expected>(
    `SELECT id, graph_run_id, plan_hash, format, compiler_version, source_json,
            source_value_id, source_hash, compiled_plan_json,
            compiled_plan_value_id, interface_snapshot_json,
            interface_snapshot_hash, policy_snapshot_json,
            policy_snapshot_hash, capability_catalog_hash
       FROM workflow_graph_scope_plans
      WHERE id = ? OR (graph_run_id = ? AND plan_hash = ?)
      ORDER BY id COLLATE BINARY`,
    [planId, graphRunId, artifact.plan.plan_hash],
  );
  if (rows.length > 0) {
    if (
      rows.length !== 1 ||
      canonicalJson(rows[0]!) !== canonicalJson(expected)
    ) {
      throw new G5RuntimeError(
        'integrity_violation',
        `T2a content-addressed Plan collision: ${artifact.plan.plan_hash}`,
      );
    }
    verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
      planId,
      graphRunId,
      planHash: artifact.plan.plan_hash as Sha256Hash,
      plan: artifact.plan,
    });
    return planId;
  }
  if (!allowInsert) {
    throw new G5RuntimeError(
      'integrity_violation',
      `T2a compiled replay is missing Plan ${artifact.plan.plan_hash}`,
    );
  }
  transaction.execute(
    `INSERT INTO workflow_graph_scope_plans (
       id, graph_run_id, plan_hash, format, compiler_version, source_json,
       source_value_id, source_hash, compiled_plan_json, compiled_plan_value_id,
       interface_snapshot_json, interface_snapshot_hash, policy_snapshot_json,
       policy_snapshot_hash, capability_catalog_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      expected.id,
      expected.graph_run_id,
      expected.plan_hash,
      expected.format,
      expected.compiler_version,
      expected.source_json,
      expected.source_hash,
      expected.compiled_plan_json,
      expected.interface_snapshot_json,
      expected.interface_snapshot_hash,
      expected.policy_snapshot_json,
      expected.policy_snapshot_hash,
      expected.capability_catalog_hash,
      nowMs,
    ],
  );
  persistPlanGeneratedSchemaAuthorities(
    transaction,
    {
      planId,
      graphRunId,
      planHash: artifact.plan.plan_hash as Sha256Hash,
      plan: artifact.plan,
    },
    nowMs,
    (compiledSchema, label) =>
      loadCompiledSchemaAuthority(transaction, compiledSchema, label).schema,
  );
  return planId;
}

export interface T2CompileInput {
  readonly graphRunId: string;
  readonly buildId: string;
  readonly expectedBuildRowVersion: number;
  readonly expectedRunWorkFenceEpoch: number;
  readonly expectedOwnerScopeWorkFenceEpoch: number;
  readonly expectedCompilerSnapshotHash: Sha256Hash;
  readonly expectedBuildLease: {
    readonly owner: string;
    readonly token: string;
    readonly expiresAtMs: number;
  } | null;
  readonly sourceJson: JsonObject;
  readonly sourceHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
  readonly staticChildPlanBundle: WorkflowCompilerStaticChildPlanBundle;
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
  const staticChildPlans = verifyStaticChildPlanBundle(
    input.plan,
    input.staticChildPlanBundle,
  );
  const planId = contentAddressedPlanId(input.graphRunId, input.plan.plan_hash);
  const planArtifacts: readonly T2PlanArtifact[] = [
    {
      source: input.sourceJson,
      sourceHash: input.sourceHash,
      plan: input.plan,
    },
    ...staticChildPlans.map((child: VerifiedStaticChildPlan) => ({
      source: child.source,
      sourceHash: child.sourceHash,
      plan: child.plan,
    })),
  ];
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      const build = transaction.queryOne<{
        graph_run_id: string;
        owner_scope_id: string | null;
        target_scope_id: string | null;
        compiler_snapshot_hash: string;
        run_work_fence_epoch: number;
        owner_scope_work_fence_epoch: number;
        status: string;
        compiled_plan_id: string | null;
        compiled_plan_hash: string | null;
        lease_owner: string | null;
        lease_token: string | null;
        lease_expires_at_ms: number | null;
        row_version: number;
      }>(
        `SELECT graph_run_id, owner_scope_id, target_scope_id,
              compiler_snapshot_hash, run_work_fence_epoch,
              owner_scope_work_fence_epoch, status, compiled_plan_id,
              compiled_plan_hash, lease_owner, lease_token,
              lease_expires_at_ms, row_version
         FROM workflow_graph_scope_builds WHERE id = ?`,
        [input.buildId],
      );
      const run = transaction.queryOne<{
        runtime_safety_snapshot_hash: string;
        source_seed_hash: string;
        work_fence_epoch: number;
      }>(
        `SELECT runtime_safety_snapshot_hash, source_seed_hash, work_fence_epoch
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
      const fenceScopeId = build?.owner_scope_id ?? build?.target_scope_id;
      const fenceScope = fenceScopeId
        ? transaction.queryOne<{ work_fence_epoch: number }>(
            'SELECT work_fence_epoch FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
            [fenceScopeId, input.graphRunId],
          )
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
        planPin.compiler_version !== input.plan.compiler_version ||
        planPin.provenance !== 'golden_corpus' ||
        input.plan.compiler_version !== WORKFLOW_COMPILER_VERSION ||
        run.source_seed_hash !== input.sourceHash ||
        input.plan.runtime_safety_hash !== run.runtime_safety_snapshot_hash
      )
        throw new G5RuntimeError(
          'integrity_violation',
          'T2a Plan version or safety compatibility drift',
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
        for (const artifact of planArtifacts) {
          persistOrVerifyT2Plan(
            transaction,
            input.graphRunId,
            artifact,
            input.nowMs,
            false,
          );
        }
        return { planId, disposition: 'exact_replay' };
      }
      if (
        !['ready_to_compile', 'compiling'].includes(build.status) ||
        build.row_version !== input.expectedBuildRowVersion ||
        build.run_work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        build.owner_scope_work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch ||
        run.work_fence_epoch !== input.expectedRunWorkFenceEpoch ||
        !fenceScope ||
        fenceScope.work_fence_epoch !==
          input.expectedOwnerScopeWorkFenceEpoch ||
        build.compiler_snapshot_hash !== input.expectedCompilerSnapshotHash ||
        (build.status === 'ready_to_compile'
          ? input.expectedBuildLease !== null ||
            build.lease_owner !== null ||
            build.lease_token !== null ||
            build.lease_expires_at_ms !== null
          : input.expectedBuildLease === null ||
            build.lease_owner !== input.expectedBuildLease.owner ||
            build.lease_token !== input.expectedBuildLease.token ||
            build.lease_expires_at_ms !==
              input.expectedBuildLease.expiresAtMs ||
            input.expectedBuildLease.expiresAtMs <= input.nowMs)
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T2a lease, epoch, hash, or row version is stale',
        );
      for (const artifact of planArtifacts) {
        persistOrVerifyT2Plan(
          transaction,
          input.graphRunId,
          artifact,
          input.nowMs,
          true,
        );
      }
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
      verifyPersistedPlanGeneratedSchemaAuthorities(transaction, {
        planId: input.planId,
        graphRunId: input.graphRunId,
        planHash: input.plan.plan_hash as Sha256Hash,
        plan: input.plan,
      });
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
            nodeOutputPortContractHash(objectField(node, 'output_ports') ?? {}),
            ['subgraph', 'expand', 'map'].includes(nodeType) ? 'sealing' : null,
            ['subgraph', 'expand', 'map'].includes(nodeType) ? 0 : null,
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
  readonly manifestSchema: RuntimeRegistryRef;
  readonly terminalStatus?: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  readonly nowMs: number;
}

type AppendFixedPointFact = (
  factKind: string,
  stableObjectKind: string,
  stableObjectId: string,
  factKey: string,
  payload: RuntimeValueRef,
  wave: number,
  payloadJson?: JsonValue,
) => number;

interface T3NodeRow extends Record<string, unknown> {
  readonly id: string;
  readonly node_key: string;
  readonly phase: string;
  readonly trigger_state: string;
  readonly input_state: string;
  readonly current_attempt_id: string | null;
  readonly terminal_status: string | null;
  readonly terminal_code: string | null;
  readonly child_exit: string | null;
  readonly published_output_envelope_value_id: string | null;
  readonly published_output_envelope_hash: Sha256Hash | null;
  readonly row_version: number;
}

interface T3MaterializedNodeRow extends T3NodeRow {
  readonly normalized_node_json: string;
  readonly capability_resource_id: string | null;
  readonly capability_version: string | null;
  readonly capability_hash: string | null;
  readonly registry_publication_state: string | null;
  readonly registry_resource_id: string | null;
  readonly registry_resource_version: string | null;
  readonly registry_content_hash: string | null;
}

interface T3MaterializedControlEdgeRow extends Record<string, unknown> {
  readonly id: string;
  readonly edge_key: string;
  readonly compiled_edge_json: string;
  readonly state: TriggerEdgeObservation['state'];
  readonly resolution_seq: number | null;
}

interface InlineValueAuthority {
  readonly ref: RuntimeValueRef;
  readonly content: JsonValue;
  readonly byteLength: number;
  readonly schemaAuthority: InlineValueSchemaAuthority;
  readonly schemaHash: Sha256Hash;
}

interface CompiledSchemaAuthority {
  readonly schema: JsonObject;
  readonly valueAuthority: InlineValueSchemaAuthority;
  readonly hash: Sha256Hash;
}

function loadInlineValueAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  valueHash: string,
  label: string,
): InlineValueAuthority {
  const row = transaction.queryOne<{
    storage_kind: string;
    inline_canonical_json: string | null;
    content_hash: string;
    byte_length: number;
    schema_resource_id: string | null;
    schema_resource_hash: string | null;
    schema_authority_kind: string;
    schema_plan_id: string | null;
    schema_plan_hash: string | null;
    generated_schema_ref: string | null;
    generated_schema_hash: string | null;
    generated_schema_generator: string | null;
    generated_schema_parameter_hash: string | null;
    payload_state: string;
  }>(
    `SELECT storage_kind, inline_canonical_json, content_hash, byte_length,
            schema_resource_id, schema_resource_hash, schema_authority_kind,
            schema_plan_id, schema_plan_hash, generated_schema_ref,
            generated_schema_hash, generated_schema_generator,
            generated_schema_parameter_hash, payload_state
       FROM workflow_values WHERE id = ? AND content_hash = ?`,
    [valueId, valueHash],
  );
  if (
    !row ||
    row.storage_kind !== 'inline' ||
    row.inline_canonical_json === null ||
    row.content_hash !== valueHash ||
    row.payload_state !== 'live'
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} Value is unavailable or not inline canonical JSON`,
    );
  const parsed = JSON.parse(row.inline_canonical_json) as JsonValue;
  if (
    canonicalJson(parsed) !== row.inline_canonical_json ||
    Buffer.byteLength(row.inline_canonical_json, 'utf8') !== row.byte_length
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} Value byte authority drifted`,
    );
  let schemaAuthority: InlineValueSchemaAuthority;
  if (
    row.schema_authority_kind === 'registry' &&
    row.schema_resource_id !== null &&
    row.schema_resource_hash !== null &&
    row.schema_plan_id === null &&
    row.schema_plan_hash === null &&
    row.generated_schema_ref === null &&
    row.generated_schema_hash === null &&
    row.generated_schema_generator === null &&
    row.generated_schema_parameter_hash === null
  ) {
    schemaAuthority = {
      kind: 'registry',
      resourceId: row.schema_resource_id,
      resourceHash: row.schema_resource_hash as Sha256Hash,
    };
  } else if (
    row.schema_authority_kind === 'plan_generated' &&
    row.schema_resource_id === null &&
    row.schema_resource_hash === null &&
    row.schema_plan_id !== null &&
    row.schema_plan_hash !== null &&
    row.generated_schema_ref !== null &&
    row.generated_schema_hash !== null &&
    [
      'join_expose',
      'child_completion',
      'map_result',
      'node_output_envelope',
    ].includes(String(row.generated_schema_generator)) &&
    row.generated_schema_parameter_hash !== null
  ) {
    schemaAuthority = {
      kind: 'plan_generated',
      planId: row.schema_plan_id,
      planHash: row.schema_plan_hash as Sha256Hash,
      schemaRef: row.generated_schema_ref,
      schemaHash: row.generated_schema_hash as Sha256Hash,
      generator: row.generated_schema_generator as PlanGeneratedSchemaGenerator,
      parameterHash: row.generated_schema_parameter_hash as Sha256Hash,
    };
  } else {
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} Value schema authority shape drifted`,
    );
  }
  return {
    ref: { id: valueId, hash: valueHash as Sha256Hash },
    content: parsed,
    byteLength: row.byte_length,
    schemaAuthority,
    schemaHash:
      schemaAuthority.kind === 'registry'
        ? schemaAuthority.resourceHash
        : schemaAuthority.schemaHash,
  };
}

function loadInlineValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  valueHash: string,
  label: string,
): JsonValue {
  return loadInlineValueAuthority(transaction, valueId, valueHash, label)
    .content;
}

function loadCompiledSchemaAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  compiledSchema: JsonObject,
  label: string,
  planIdentity?: PersistedPlanIdentity,
): CompiledSchemaAuthority {
  const claimedHash = compiledSchema.schema_hash;
  if (typeof claimedHash !== 'string')
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} compiled schema hash is missing`,
    );
  if (compiledSchema.type === 'generated') {
    if (!planIdentity)
      throw new G5RuntimeError(
        'integrity_violation',
        `${label} generated schema requires exact persisted Plan authority`,
      );
    const persisted = loadPersistedPlanGeneratedSchemaAuthority(
      transaction,
      planIdentity,
      compiledSchema,
      label,
    );
    return {
      schema: persisted.schema,
      valueAuthority: persisted.authority,
      hash: claimedHash as Sha256Hash,
    };
  }
  if (compiledSchema.type !== 'registry')
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} compiled schema type is unsupported`,
    );
  const ref = requiredObjectField(compiledSchema, 'ref', `${label} schema`);
  const resourceId = registryResourceId({
    resource_type: 'schema',
    ref: { id: String(ref.id), version: String(ref.version) },
  });
  const row = transaction.queryOne<{
    resource_type: string;
    resource_id: string;
    resource_version: string;
    content_hash: string;
    publication_state: string;
    canonical_value_id: string;
  }>(
    `SELECT resource_type, resource_id, resource_version, content_hash,
            publication_state, canonical_value_id
       FROM workflow_registry_resources WHERE id = ?`,
    [resourceId],
  );
  if (
    !row ||
    row.resource_type !== 'schema' ||
    row.resource_id !== ref.id ||
    row.resource_version !== ref.version ||
    row.content_hash !== claimedHash ||
    row.publication_state !== 'published'
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not the exact Published Registry schema`,
    );
  const value = loadInlineValueAuthority(
    transaction,
    row.canonical_value_id,
    claimedHash,
    `${label} Registry schema`,
  );
  if (
    !value.content ||
    typeof value.content !== 'object' ||
    Array.isArray(value.content)
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} Registry schema content is not an object`,
    );
  return {
    schema: value.content as JsonObject,
    valueAuthority: {
      kind: 'registry',
      resourceId,
      resourceHash: claimedHash as Sha256Hash,
    },
    hash: claimedHash as Sha256Hash,
  };
}

function inputSchemaAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  planIdentity: PersistedPlanIdentity,
): InputSchemaAuthority {
  const plan = planIdentity.plan;
  const safety = objectField(
    plan as unknown as JsonObject,
    'runtime_safety_snapshot',
  );
  const valueSafety = safety ? objectField(safety, 'value') : undefined;
  const maximum = valueSafety?.max_single_value_bytes;
  return {
    resolveSchema: (compiledSchema, label) =>
      loadCompiledSchemaAuthority(
        transaction,
        compiledSchema,
        label,
        planIdentity,
      ).schema,
    maxSingleValueBytes:
      maximum === undefined || maximum === null
        ? null
        : Number.isSafeInteger(maximum) && Number(maximum) >= 0
          ? Number(maximum)
          : (() => {
              throw new G5RuntimeError(
                'integrity_violation',
                'Plan Runtime Safety max_single_value_bytes is invalid',
              );
            })(),
  };
}

function valueAtPointer(
  value: JsonValue,
  pointer: unknown,
): JsonValue | undefined {
  if (pointer === null || pointer === undefined || pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/'))
    throw new G5RuntimeError(
      'integrity_violation',
      'Plan JSON Pointer is malformed',
    );
  let current: JsonValue = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length)
        return undefined;
      current = current[index]!;
    } else if (current && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token))
        return undefined;
      current = current[token]!;
    } else return undefined;
  }
  return current;
}

function portValue(
  transaction: WorkflowRuntimeWriteTransaction,
  root: JsonValue,
  port: string,
): JsonValue | undefined {
  if (!root || typeof root !== 'object' || Array.isArray(root))
    return undefined;
  const ports = root.ports;
  if (!ports || typeof ports !== 'object' || Array.isArray(ports))
    return undefined;
  const entry = ports[port];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return undefined;
  if (entry.state === 'absent') return undefined;
  const valueId = entry.value_ref;
  const valueHash = entry.value_hash;
  if (typeof valueId !== 'string' || typeof valueHash !== 'string')
    return undefined;
  const authority = loadInlineValueAuthority(
    transaction,
    valueId,
    valueHash,
    `Output port ${port}`,
  );
  if (
    entry.schema_hash !== authority.schemaHash ||
    !Number.isSafeInteger(entry.byte_length) ||
    entry.byte_length !== authority.byteLength
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `Output port ${port} Value metadata drifted`,
    );
  return authority.content;
}

interface SelectedPortValue {
  readonly content: JsonValue;
  readonly authority: InlineValueAuthority | null;
}

function selectedPortValue(
  transaction: WorkflowRuntimeWriteTransaction,
  root: InlineValueAuthority,
  port: string,
  label: string,
): SelectedPortValue | undefined {
  const value = root.content;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const ports = value.ports;
  if (!ports || typeof ports !== 'object' || Array.isArray(ports))
    return undefined;
  const entry = ports[port];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    return undefined;
  if (entry.state === 'absent') return undefined;
  const valueId = entry.value_ref;
  const valueHash = entry.value_hash;
  if (typeof valueId !== 'string' || typeof valueHash !== 'string')
    return undefined;
  const authority = loadInlineValueAuthority(
    transaction,
    valueId,
    valueHash,
    `${label} port ${port}`,
  );
  if (
    entry.schema_hash !== authority.schemaHash ||
    !Number.isSafeInteger(entry.byte_length) ||
    entry.byte_length !== authority.byteLength
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} port ${port} Value metadata drifted`,
    );
  return { content: authority.content, authority };
}

function assertNodeOutputEnvelopeAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  planIdentity: PersistedPlanIdentity,
  node: JsonObject,
  root: InlineValueAuthority,
): void {
  const nodeId = String(node.id);
  const descriptor = requiredObjectField(
    node,
    'output_envelope_schema',
    `Plan node ${nodeId}`,
  );
  const outputPorts = requiredObjectField(
    node,
    'output_ports',
    `Plan node ${nodeId}`,
  );
  const persisted = loadPersistedPlanGeneratedSchemaAuthority(
    transaction,
    planIdentity,
    descriptor,
    `Node ${nodeId} output envelope`,
  );
  if (
    root.schemaAuthority.kind !== 'plan_generated' ||
    root.schemaAuthority.planId !== planIdentity.planId ||
    root.schemaAuthority.planHash !== planIdentity.planHash ||
    root.schemaAuthority.schemaRef !== persisted.authority.schemaRef ||
    root.schemaAuthority.schemaHash !== persisted.authority.schemaHash ||
    root.schemaAuthority.generator !== 'node_output_envelope' ||
    root.schemaAuthority.parameterHash !== persisted.authority.parameterHash ||
    root.schemaHash !== descriptor.schema_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `Node ${nodeId} output envelope schema authority drifted`,
    );
  const validation = validateCompiledInputValue(
    root.content,
    descriptor,
    null,
    inputSchemaAuthority(transaction, planIdentity),
    `Node ${nodeId} output envelope`,
  );
  if (validation !== null)
    throw new G5RuntimeError(
      'integrity_violation',
      `Node ${nodeId} output envelope ${validation}`,
    );
  const content = requiredObjectField(
    { content: root.content },
    'content',
    `Node ${nodeId} output envelope`,
  );
  const ports = requiredObjectField(
    content,
    'ports',
    `Node ${nodeId} output envelope`,
  );
  const expected = buildCanonicalNodeOutputEnvelope(
    outputPorts,
    ports as unknown as Record<string, PublishedNodeOutputPort>,
  );
  if (
    canonicalJson(content) !== canonicalJson(expected) ||
    root.ref.hash !== expected.envelope_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      `Node ${nodeId} output envelope payload/hash drifted`,
    );
}

function planDataTargetContract(
  plan: CompiledScopePlanV2Document,
  edge: JsonObject,
): { schema: JsonObject; maxBytes: unknown } {
  const target = requiredObjectField(edge, 'to', 'Plan data edge');
  const node = (plan.nodes as JsonObject[]).find(
    (candidate) => candidate.id === target.node_id,
  );
  if (!node)
    throw new G5RuntimeError(
      'integrity_violation',
      `Plan data target node is missing: ${String(target.node_id)}`,
    );
  const ports = requiredObjectField(node, 'input_ports', 'Plan data target');
  const contract = objectField(ports, String(target.port));
  if (!contract)
    throw new G5RuntimeError(
      'integrity_violation',
      `Plan data target port is missing: ${String(target.port)}`,
    );
  const aggregation = requiredObjectField(
    contract,
    'aggregation',
    'Plan input port',
  );
  return aggregation.type === 'list'
    ? {
        schema: requiredObjectField(
          contract,
          'item_schema',
          'Plan list input port',
        ),
        maxBytes: contract.item_max_bytes,
      }
    : {
        schema: requiredObjectField(contract, 'schema', 'Plan input port'),
        maxBytes: contract.max_bytes,
      };
}

function persistPlanSelectedValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly planIdentity: PersistedPlanIdentity;
    readonly edge: JsonObject;
    readonly content: JsonValue;
    readonly sourceIdentity: JsonValue;
    readonly nowMs: number;
  },
): RuntimeValueRef {
  const derivedSchema = requiredObjectField(
    input.edge,
    'derived_schema',
    'Plan data edge',
  );
  const schema = loadCompiledSchemaAuthority(
    transaction,
    derivedSchema,
    'Plan data edge derived schema',
    input.planIdentity,
  );
  const plan = input.planIdentity.plan;
  const identity: JsonObject = {
    plan_hash: plan.plan_hash,
    edge_id: String(input.edge.id),
    source: input.sourceIdentity,
    value: input.content,
  };
  const value = {
    id: stableRuntimeId('selected-data-value', identity),
    hash: runtimeObjectHash('selected-data-value', identity),
  };
  insertInlineValue(transaction, {
    id: value.id,
    content: input.content,
    contentHash: value.hash,
    schemaAuthority: schema.valueAuthority,
    provenanceRef: `plan-data:${plan.plan_hash}:${String(input.edge.id)}`,
    retentionClass: 'run_recovery',
    createdAtMs: input.nowMs,
  });
  return value;
}

function selectAndValidateDataValue(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly planIdentity: PersistedPlanIdentity;
    readonly edge: JsonObject;
    readonly root: InlineValueAuthority | null;
    readonly literal: JsonValue | undefined;
    readonly nowMs: number;
    readonly label: string;
  },
):
  | { readonly state: 'available'; readonly value: RuntimeValueRef }
  | { readonly state: 'missing' }
  | { readonly state: 'error'; readonly errorCode: string } {
  try {
    const plan = input.planIdentity.plan;
    const from = requiredObjectField(input.edge, 'from', 'Plan data edge');
    const selection =
      input.literal !== undefined
        ? { content: input.literal, authority: null }
        : input.root
          ? selectedPortValue(
              transaction,
              input.root,
              String(from.port),
              input.label,
            )
          : undefined;
    if (!selection) return { state: 'missing' };
    const hasPointer = typeof from.pointer === 'string' && from.pointer !== '';
    const selected = hasPointer
      ? valueAtPointer(selection.content, from.pointer)
      : selection.content;
    if (selected === undefined) return { state: 'missing' };
    if (
      selection.authority &&
      typeof input.edge.producer_schema_hash === 'string' &&
      selection.authority.schemaHash !== input.edge.producer_schema_hash
    )
      return { state: 'error', errorCode: 'data_value_authority_invalid' };
    const schemaAuthority = inputSchemaAuthority(
      transaction,
      input.planIdentity,
    );
    const target = planDataTargetContract(plan, input.edge);
    const targetFailure = validateCompiledInputValue(
      selected,
      target.schema,
      target.maxBytes,
      schemaAuthority,
      `${input.label} target input`,
    );
    const derivedSchema = requiredObjectField(
      input.edge,
      'derived_schema',
      'Plan data edge',
    );
    const derivedFailure = validateCompiledInputValue(
      selected,
      derivedSchema,
      target.maxBytes,
      schemaAuthority,
      `${input.label} derived value`,
    );
    const failure = targetFailure ?? derivedFailure;
    if (failure) return { state: 'error', errorCode: failure };
    if (!hasPointer && selection.authority)
      return { state: 'available', value: selection.authority.ref };
    return {
      state: 'available',
      value: persistPlanSelectedValue(transaction, {
        planIdentity: input.planIdentity,
        edge: input.edge,
        content: selected,
        sourceIdentity:
          input.literal !== undefined
            ? { type: 'literal' }
            : {
                type: 'selected_port',
                root_value_id: input.root!.ref.id,
                root_value_hash: input.root!.ref.hash,
                port: String(from.port),
                pointer: hasPointer ? String(from.pointer) : null,
              },
        nowMs: input.nowMs,
      }),
    };
  } catch (error) {
    if (error instanceof G5RuntimeError)
      return { state: 'error', errorCode: 'data_value_authority_invalid' };
    throw error;
  }
}

function scopePlanAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  scopeId: string,
): PersistedPlanIdentity {
  const first = transaction.queryOne<{ id: string }>(
    'SELECT id FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY LIMIT 1',
    [graphRunId, scopeId],
  );
  if (!first)
    throw new G5RuntimeError(
      'precondition_failed',
      'T3 materialized scope has no Plan nodes',
    );
  const authority = loadMaterializedNodeAuthority(
    transaction,
    graphRunId,
    scopeId,
    first.id,
  );
  return {
    planId: authority.planId,
    graphRunId: authority.graphRunId,
    planHash: authority.planHash,
    plan: authority.plan,
  };
}

function loadT3ScopeNodeAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly planIdentity: PersistedPlanIdentity;
  },
): Map<string, T3MaterializedNodeRow> {
  const rows = transaction.queryAll<T3MaterializedNodeRow>(
    `SELECT n.id, n.node_key, n.phase, n.trigger_state, n.input_state,
            n.current_attempt_id, n.terminal_status, n.terminal_code,
            n.child_exit, n.published_output_envelope_value_id,
            n.published_output_envelope_hash, n.row_version,
            n.normalized_node_json, n.capability_resource_id,
            n.capability_version, n.capability_hash,
            rr.publication_state AS registry_publication_state,
            rr.resource_id AS registry_resource_id,
            rr.resource_version AS registry_resource_version,
            rr.content_hash AS registry_content_hash
       FROM workflow_graph_nodes n
       LEFT JOIN workflow_registry_resources rr
         ON rr.id = n.capability_resource_id
        AND rr.resource_type = 'capability'
      WHERE n.graph_run_id = ? AND n.scope_id = ?
      ORDER BY n.node_key COLLATE BINARY`,
    [input.graphRunId, input.scopeId],
  );
  const planNodes = input.planIdentity.plan.nodes as JsonObject[];
  if (rows.length !== planNodes.length)
    throw new G5RuntimeError(
      'integrity_violation',
      'T3 materialized Scope node set differs from the persisted Plan',
    );
  const byNodeKey = new Map(rows.map((row) => [row.node_key, row]));
  for (const planNode of planNodes) {
    const nodeKey = String(planNode.id);
    const row = byNodeKey.get(nodeKey);
    if (!row || row.normalized_node_json !== canonicalJson(planNode))
      throw new G5RuntimeError(
        'integrity_violation',
        `T3 materialized node authority drifted: ${nodeKey}`,
      );
    const capability = planNode.capability_binding;
    if (capability === null || capability === undefined) {
      if (
        row.capability_resource_id !== null ||
        row.capability_version !== null ||
        row.capability_hash !== null ||
        row.registry_publication_state !== null
      )
        throw new G5RuntimeError(
          'integrity_violation',
          `T3 non-capability node carries capability authority: ${nodeKey}`,
        );
      continue;
    }
    const binding = requiredObjectField(
      planNode,
      'capability_binding',
      'Plan node',
    );
    const ref = requiredObjectField(binding, 'ref', 'Plan capability binding');
    if (
      row.capability_resource_id === null ||
      row.capability_version !== ref.version ||
      row.capability_hash === null ||
      row.registry_publication_state !== 'published' ||
      row.registry_resource_id !== ref.id ||
      row.registry_resource_version !== ref.version ||
      row.registry_content_hash !== row.capability_hash
    )
      throw new G5RuntimeError(
        'precondition_failed',
        `T3 exact Published capability authority is unavailable: ${nodeKey}`,
      );
  }
  return byNodeKey;
}

function loadT3ScopeControlEdgeAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly planIdentity: PersistedPlanIdentity;
  },
): Map<string, T3MaterializedControlEdgeRow> {
  const rows = transaction.queryAll<T3MaterializedControlEdgeRow>(
    `SELECT e.id, e.edge_key, e.compiled_edge_json, r.state, r.resolution_seq
       FROM workflow_graph_edges e
       JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
      WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_kind = 'control'
      ORDER BY e.edge_key COLLATE BINARY`,
    [input.graphRunId, input.scopeId],
  );
  const planEdges = input.planIdentity.plan.control_edges as JsonObject[];
  if (rows.length !== planEdges.length)
    throw new G5RuntimeError(
      'integrity_violation',
      'T3 materialized Scope control-edge set differs from the persisted Plan',
    );
  const byEdgeKey = new Map(rows.map((row) => [row.edge_key, row]));
  for (const planEdge of planEdges) {
    const edgeKey = String(planEdge.id);
    const row = byEdgeKey.get(edgeKey);
    if (!row || row.compiled_edge_json !== canonicalJson(planEdge))
      throw new G5RuntimeError(
        'integrity_violation',
        `T3 materialized control-edge authority drifted: ${edgeKey}`,
      );
  }
  return byEdgeKey;
}

function planEdge(
  plan: CompiledScopePlanV2Document,
  edgeId: string,
  kind: 'control' | 'data',
): JsonObject {
  const values = (kind === 'control' ? plan.control_edges : plan.data_edges) as
    | JsonObject[]
    | undefined;
  const found = values?.find((edge) => edge.id === edgeId);
  if (!found)
    throw new G5RuntimeError(
      'integrity_violation',
      `Materialized ${kind} edge is absent from the persisted Plan: ${edgeId}`,
    );
  return found;
}

function outcomeMatches(node: T3NodeRow, matchValue: unknown): boolean {
  if (
    !matchValue ||
    typeof matchValue !== 'object' ||
    Array.isArray(matchValue)
  )
    return false;
  const match = matchValue as JsonObject;
  const memberships: Array<[unknown, string | null]> = [
    [match.statuses, node.terminal_status],
    [match.codes, node.terminal_code],
    [match.child_exits, node.child_exit],
  ];
  return memberships.every(
    ([values, observed]) =>
      values === undefined ||
      (Array.isArray(values) && observed !== null && values.includes(observed)),
  );
}

function resolveConditionReference(
  transaction: WorkflowRuntimeWriteTransaction,
  reference: JsonObject,
  scopeInput: JsonValue,
  sourceOutput: JsonValue | undefined,
  source: T3NodeRow,
): JsonValue | undefined {
  if (reference.source === 'scope_input')
    return portValue(transaction, scopeInput, String(reference.port));
  if (reference.source === 'edge_source_output')
    return sourceOutput === undefined
      ? undefined
      : portValue(transaction, sourceOutput, String(reference.port));
  if (reference.source === 'edge_source_fact') {
    if (reference.field === 'status')
      return source.terminal_status ?? undefined;
    if (reference.field === 'code') return source.terminal_code ?? undefined;
    if (reference.field === 'child_exit') return source.child_exit ?? undefined;
  }
  throw new G5RuntimeError(
    'integrity_violation',
    `Unsupported Plan condition reference: ${String(reference.source)}`,
  );
}

function resolveControlEdge(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    edge: JsonObject;
    state: 'taken' | 'not_taken' | 'error';
    errorCode?: string;
    source: T3NodeRow;
    payload: RuntimeValueRef;
    append: AppendFixedPointFact;
    controlEdgeRows?: Map<string, T3MaterializedControlEdgeRow>;
    nowMs: number;
  },
): void {
  const edgeKey = String(input.edge.id);
  const row =
    input.controlEdgeRows?.get(edgeKey) ??
    transaction.queryOne<T3MaterializedControlEdgeRow>(
      `SELECT e.id, e.edge_key, e.compiled_edge_json, r.state, r.resolution_seq
         FROM workflow_graph_edges e
         JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
        WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_key = ?
          AND e.compiled_edge_json = ?`,
      [input.graphRunId, input.scopeId, edgeKey, canonicalJson(input.edge)],
    );
  if (!row)
    throw new G5RuntimeError(
      'integrity_violation',
      `Plan control edge was not materialized exactly: ${String(input.edge.id)}`,
    );
  if (row.state !== 'unresolved')
    throw new G5RuntimeError(
      'integrity_violation',
      `T3a control edge was not unresolved: ${row.id}`,
    );
  const resolutionSequence = input.append(
    'control_edge_resolved',
    'edge',
    row.id,
    `control-edge:${row.id}`,
    input.payload,
    1,
  );
  const decision = {
    source_node_id: input.source.id,
    terminal_status: input.source.terminal_status,
    terminal_code: input.source.terminal_code,
    child_exit: input.source.child_exit,
    state: input.state,
  };
  const changed = transaction.execute(
    input.state === 'error'
      ? "UPDATE workflow_graph_control_edge_resolutions SET state = 'error', decision_input_hash = NULL, decision_json = NULL, error_code = ?, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'"
      : "UPDATE workflow_graph_control_edge_resolutions SET state = ?, decision_input_hash = ?, decision_json = ?, error_code = NULL, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'",
    input.state === 'error'
      ? [
          input.errorCode ?? 'condition_error',
          resolutionSequence,
          input.nowMs,
          row.id,
        ]
      : [
          input.state,
          runtimeObjectHash('control-decision', decision),
          canonicalJson(decision),
          resolutionSequence,
          input.nowMs,
          row.id,
        ],
  ).changes;
  if (changed !== 1)
    throw new G5RuntimeError(
      'cas_conflict',
      `T3a control edge CAS failed: ${row.id}`,
    );
  input.controlEdgeRows?.set(edgeKey, {
    ...row,
    state: input.state,
    resolution_seq: resolutionSequence,
  });
}

function resolveTerminalControlRoutes(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    planIdentity: PersistedPlanIdentity;
    source: T3NodeRow;
    scopeInput: JsonValue;
    payload: RuntimeValueRef;
    append: AppendFixedPointFact;
    controlEdgeRows?: Map<string, T3MaterializedControlEdgeRow>;
    nowMs: number;
  },
): boolean {
  const plan = input.planIdentity.plan;
  const edges = (plan.control_edges as JsonObject[]).filter(
    (edge) => edge.from_node_id === input.source.node_key,
  );
  const sourceOutputAuthority =
    input.source.published_output_envelope_value_id &&
    input.source.published_output_envelope_hash
      ? loadInlineValueAuthority(
          transaction,
          input.source.published_output_envelope_value_id,
          input.source.published_output_envelope_hash,
          `Node ${input.source.node_key} output`,
        )
      : undefined;
  if (sourceOutputAuthority) {
    const sourceNode = (plan.nodes as JsonObject[]).find(
      (candidate) => candidate.id === input.source.node_key,
    );
    if (!sourceNode)
      throw new G5RuntimeError(
        'integrity_violation',
        `Control source node is missing from Plan: ${input.source.node_key}`,
      );
    assertNodeOutputEnvelopeAuthority(
      transaction,
      input.planIdentity,
      sourceNode,
      sourceOutputAuthority,
    );
  }
  const sourceOutput = sourceOutputAuthority?.content;
  const evaluate = (edge: JsonObject): 'taken' | 'not_taken' | 'error' => {
    if (edge.is_default === true) return 'not_taken';
    if (!outcomeMatches(input.source, edge.outcome_match)) return 'not_taken';
    try {
      return evaluateConditionProgram(edge.condition_program, (reference) =>
        resolveConditionReference(
          transaction,
          reference,
          input.scopeInput,
          sourceOutput,
          input.source,
        ),
      )
        ? 'taken'
        : 'not_taken';
    } catch (error) {
      if (error instanceof G5RuntimeError) return 'error';
      throw error;
    }
  };
  const resolve = (
    edge: JsonObject,
    state: 'taken' | 'not_taken' | 'error',
  ): void => {
    resolveControlEdge(transaction, {
      ...input,
      edge,
      state,
      errorCode: state === 'error' ? 'condition_error' : undefined,
    });
  };
  const grouped = new Set<string>();
  let orchestrationError = false;
  const routeGroups = Array.isArray(plan.route_groups)
    ? (plan.route_groups as JsonObject[])
    : [];
  for (const group of routeGroups.filter(
    (candidate) => candidate.from_node_id === input.source.node_key,
  )) {
    const members = edges.filter((edge) => edge.route_group_id === group.id);
    members.forEach((edge) => grouped.add(String(edge.id)));
    const orderedIds = Array.isArray(group.ordered_edge_ids)
      ? group.ordered_edge_ids.map(String)
      : [];
    const ordered = orderedIds.map((edgeId) => {
      const edge = members.find((candidate) => candidate.id === edgeId);
      if (!edge)
        throw new G5RuntimeError(
          'integrity_violation',
          `Route group references an unknown edge: ${edgeId}`,
        );
      return edge;
    });
    const decisions = new Map<string, 'taken' | 'not_taken' | 'error'>();
    if (group.mode === 'first_matching') {
      let selected: JsonObject | null = null;
      let conditionError = false;
      const fallback = ordered.find((edge) => edge.is_default === true) ?? null;
      for (const edge of ordered.filter(
        (candidate) => candidate.is_default !== true,
      )) {
        const decision = evaluate(edge);
        if (decision === 'error') {
          decisions.set(String(edge.id), 'error');
          conditionError = true;
          break;
        }
        if (decision === 'taken') {
          selected = edge;
          break;
        }
      }
      if (!conditionError && !selected) selected = fallback;
      for (const edge of ordered)
        if (!decisions.has(String(edge.id)))
          decisions.set(
            String(edge.id),
            selected?.id === edge.id ? 'taken' : 'not_taken',
          );
      if (!conditionError && !selected && group.no_match === 'error') {
        orchestrationError = true;
        for (const edge of ordered) decisions.set(String(edge.id), 'error');
      }
    } else if (group.mode === 'all_matching') {
      let anyTaken = false;
      for (const edge of ordered) {
        const decision = evaluate(edge);
        decisions.set(String(edge.id), decision);
        anyTaken ||= decision === 'taken';
        orchestrationError ||= decision === 'error';
      }
      if (!anyTaken && group.no_match === 'error') {
        orchestrationError = true;
        for (const edge of ordered) decisions.set(String(edge.id), 'error');
      }
    } else
      throw new G5RuntimeError(
        'integrity_violation',
        `Unsupported route group mode: ${String(group.mode)}`,
      );
    for (const edge of ordered) {
      const decision = decisions.get(String(edge.id))!;
      orchestrationError ||= decision === 'error';
      resolve(edge, decision);
    }
  }
  for (const edge of edges.filter(
    (candidate) => !grouped.has(String(candidate.id)),
  )) {
    const decision = evaluate(edge);
    orchestrationError ||= decision === 'error';
    resolve(edge, decision);
  }
  return orchestrationError;
}

function resolveDataEdge(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    edge: JsonObject;
    state: 'available' | 'unavailable' | 'error';
    value?: RuntimeValueRef;
    schemaHash?: Sha256Hash;
    sourceAttemptId?: string | null;
    errorCode?: string;
    payload: RuntimeValueRef;
    append: AppendFixedPointFact;
    nowMs: number;
  },
): void {
  const row = transaction.queryOne<{ id: string; state: string }>(
    `SELECT e.id, r.state
       FROM workflow_graph_edges e
       JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
      WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_key = ?
        AND e.compiled_edge_json = ?`,
    [
      input.graphRunId,
      input.scopeId,
      String(input.edge.id),
      canonicalJson(input.edge),
    ],
  );
  if (!row)
    throw new G5RuntimeError(
      'integrity_violation',
      `Plan data edge was not materialized exactly: ${String(input.edge.id)}`,
    );
  if (row.state !== 'unresolved') return;
  const resolutionSequence = input.append(
    'data_edge_resolved',
    'edge',
    row.id,
    `data-edge:${row.id}`,
    input.payload,
    1,
  );
  const changed = transaction.execute(
    input.state === 'available'
      ? "UPDATE workflow_graph_data_edge_resolutions SET state = 'available', value_value_id = ?, value_hash = ?, schema_hash = ?, source_attempt_id = ?, error_code = NULL, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'"
      : input.state === 'unavailable'
        ? "UPDATE workflow_graph_data_edge_resolutions SET state = 'unavailable', value_value_id = NULL, value_hash = NULL, schema_hash = NULL, source_attempt_id = ?, error_code = NULL, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'"
        : "UPDATE workflow_graph_data_edge_resolutions SET state = 'error', value_value_id = NULL, value_hash = NULL, schema_hash = NULL, source_attempt_id = ?, error_code = ?, resolution_seq = ?, resolved_at_ms = ?, row_version = row_version + 1 WHERE edge_id = ? AND state = 'unresolved'",
    input.state === 'available'
      ? [
          input.value!.id,
          input.value!.hash,
          input.schemaHash!,
          input.sourceAttemptId ?? null,
          resolutionSequence,
          input.nowMs,
          row.id,
        ]
      : input.state === 'unavailable'
        ? [
            input.sourceAttemptId ?? null,
            resolutionSequence,
            input.nowMs,
            row.id,
          ]
        : [
            input.sourceAttemptId ?? null,
            input.errorCode ?? 'data_resolution_error',
            resolutionSequence,
            input.nowMs,
            row.id,
          ],
  ).changes;
  if (changed !== 1)
    throw new G5RuntimeError(
      'cas_conflict',
      `T3a data edge CAS failed: ${row.id}`,
    );
}

function resolveTerminalDataEdges(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    planIdentity: PersistedPlanIdentity;
    source: T3NodeRow;
    payload: RuntimeValueRef;
    append: AppendFixedPointFact;
    nowMs: number;
  },
): boolean {
  const plan = input.planIdentity.plan;
  const edges = (plan.data_edges as JsonObject[])
    .filter(
      (candidate) =>
        objectField(candidate, 'from')?.node_id === input.source.node_key,
    )
    .sort((left, right) =>
      String(left.id).localeCompare(String(right.id), 'en'),
    );
  if (edges.length === 0) return false;
  let output: InlineValueAuthority | undefined;
  let outputAuthorityError = false;
  if (
    input.source.published_output_envelope_value_id &&
    input.source.published_output_envelope_hash
  ) {
    try {
      output = loadInlineValueAuthority(
        transaction,
        input.source.published_output_envelope_value_id,
        input.source.published_output_envelope_hash,
        `Node ${input.source.node_key} output`,
      );
      const sourceNode = (plan.nodes as JsonObject[]).find(
        (candidate) => candidate.id === input.source.node_key,
      );
      if (!sourceNode)
        throw new G5RuntimeError(
          'integrity_violation',
          `Data source node is missing from Plan: ${input.source.node_key}`,
        );
      assertNodeOutputEnvelopeAuthority(
        transaction,
        input.planIdentity,
        sourceNode,
        output,
      );
    } catch (error) {
      if (!(error instanceof G5RuntimeError)) throw error;
      outputAuthorityError = true;
    }
  }
  let orchestrationError = false;
  for (const edge of edges) {
    const from = requiredObjectField(edge, 'from', 'Plan data edge');
    const guardId =
      typeof edge.guard_control_edge_id === 'string'
        ? edge.guard_control_edge_id
        : null;
    if (guardId) {
      const guard = transaction.queryOne<{ state: string }>(
        `SELECT r.state FROM workflow_graph_edges e
          JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
         WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_key = ?`,
        [input.graphRunId, input.scopeId, guardId],
      );
      if (!guard || guard.state === 'unresolved') continue;
      if (guard.state === 'not_taken') {
        resolveDataEdge(transaction, { ...input, edge, state: 'unavailable' });
        continue;
      }
      if (guard.state === 'error') {
        orchestrationError = true;
        resolveDataEdge(transaction, {
          ...input,
          edge,
          state: 'error',
          errorCode: 'guard_error',
        });
        continue;
      }
    }
    if (outputAuthorityError) {
      orchestrationError = true;
      resolveDataEdge(transaction, {
        ...input,
        edge,
        state: 'error',
        errorCode: 'data_value_authority_invalid',
      });
      continue;
    }
    if (input.source.terminal_status !== 'succeeded' || output === undefined) {
      resolveDataEdge(transaction, { ...input, edge, state: 'unavailable' });
      continue;
    }
    const selected = selectAndValidateDataValue(transaction, {
      planIdentity: input.planIdentity,
      edge,
      root: output,
      literal: undefined,
      nowMs: input.nowMs,
      label: `Node ${input.source.node_key} output`,
    });
    if (selected.state === 'missing') {
      const unavailable = edge.on_missing === 'unavailable';
      orchestrationError ||= !unavailable;
      resolveDataEdge(transaction, {
        ...input,
        edge,
        state: unavailable ? 'unavailable' : 'error',
        errorCode: unavailable ? undefined : 'data_pointer_missing',
      });
      continue;
    }
    if (selected.state === 'error') {
      orchestrationError = true;
      resolveDataEdge(transaction, {
        ...input,
        edge,
        state: 'error',
        errorCode: selected.errorCode,
      });
      continue;
    }
    const derivedSchema = requiredObjectField(
      edge,
      'derived_schema',
      'Plan data edge',
    );
    resolveDataEdge(transaction, {
      ...input,
      edge,
      state: 'available',
      value: selected.value,
      schemaHash: String(derivedSchema.schema_hash) as Sha256Hash,
      sourceAttemptId: input.source.current_attempt_id,
    });
  }
  return orchestrationError;
}

interface T3ScopeObservations {
  readonly controlByNodeKey: Map<string, TriggerEdgeObservation[]>;
  readonly dataByNodeKey: Map<string, DataResolutionObservation[]>;
}

function loadT3ScopeObservations(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  scopeId: string,
  controlEdgeRows?: ReadonlyMap<string, T3MaterializedControlEdgeRow>,
): T3ScopeObservations {
  const controlByNodeKey = new Map<string, TriggerEdgeObservation[]>();
  const controlRows = controlEdgeRows
    ? [...controlEdgeRows.values()].sort((left, right) =>
        left.edge_key.localeCompare(right.edge_key, 'en'),
      )
    : transaction.queryAll<T3MaterializedControlEdgeRow>(
        `SELECT e.id, e.edge_key, e.compiled_edge_json, r.state, r.resolution_seq
           FROM workflow_graph_edges e
           JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_kind = 'control'
          ORDER BY e.edge_key COLLATE BINARY`,
        [graphRunId, scopeId],
      );
  for (const row of controlRows) {
    const targetNodeKey = String(
      (JSON.parse(row.compiled_edge_json) as JsonObject).to_node_id,
    );
    const observations = controlByNodeKey.get(targetNodeKey) ?? [];
    observations.push({
      edgeId: row.edge_key,
      state: row.state,
      resolutionSequence: row.resolution_seq,
    });
    controlByNodeKey.set(targetNodeKey, observations);
  }

  const dataByNodeKey = new Map<string, DataResolutionObservation[]>();
  for (const row of transaction.queryAll<{
    edge_id: string;
    edge_key: string;
    compiled_edge_json: string;
    state: DataResolutionObservation['state'];
    value_value_id: string | null;
    value_hash: Sha256Hash | null;
    schema_hash: Sha256Hash | null;
    resolution_seq: number | null;
  }>(
    `SELECT e.id AS edge_id, e.edge_key, e.compiled_edge_json, r.state,
            r.value_value_id, r.value_hash, r.schema_hash, r.resolution_seq
       FROM workflow_graph_edges e
       JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
      WHERE e.graph_run_id = ? AND e.scope_id = ? AND e.edge_kind = 'data'
      ORDER BY e.edge_key COLLATE BINARY`,
    [graphRunId, scopeId],
  )) {
    const compiledEdge = JSON.parse(row.compiled_edge_json) as JsonObject;
    const targetNodeKey = String(objectField(compiledEdge, 'to')?.node_id);
    const value =
      row.state === 'available' && row.value_value_id && row.value_hash
        ? loadInlineValueAuthority(
            transaction,
            row.value_value_id,
            row.value_hash,
            `Data edge ${row.edge_key}`,
          )
        : null;
    if (row.state === 'available' && value === null)
      throw new G5RuntimeError(
        'integrity_violation',
        `Available data edge ${row.edge_key} has no Value authority`,
      );
    const observations = dataByNodeKey.get(targetNodeKey) ?? [];
    observations.push({
      edgeId: row.edge_key,
      edgeKey: row.edge_key,
      port: String(objectField(compiledEdge, 'to')?.port),
      state: row.state,
      valueId: row.value_value_id,
      valueHash: row.value_hash,
      schemaHash: row.schema_hash,
      resolutionSequence: row.resolution_seq,
      value: value?.content ?? null,
      byteLength: value?.byteLength ?? null,
    });
    dataByNodeKey.set(targetNodeKey, observations);
  }
  return { controlByNodeKey, dataByNodeKey };
}

function materializeSealedInputValues(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly planIdentity: PersistedPlanIdentity;
    readonly node: JsonObject;
    readonly seal: InputSealEvaluation;
    readonly nowMs: number;
  },
): { snapshot: JsonObject; primaryValue: RuntimeValueRef | null } {
  if (input.seal.snapshot === null)
    throw new G5RuntimeError(
      'integrity_violation',
      'Sealed input snapshot is missing',
    );
  const snapshot = JSON.parse(canonicalJson(input.seal.snapshot)) as JsonObject;
  const plan = input.planIdentity.plan;
  const snapshotPorts = requiredObjectField(
    snapshot,
    'ports',
    'Sealed input snapshot',
  );
  const values: RuntimeValueRef[] = [];
  for (const portValue of input.seal.portValues) {
    const schema = loadCompiledSchemaAuthority(
      transaction,
      portValue.schema,
      `Plan input port ${portValue.port}`,
      input.planIdentity,
    );
    let value: RuntimeValueRef;
    let valueSchemaHash: Sha256Hash;
    if (portValue.existingValueId && portValue.existingValueHash) {
      const existing = loadInlineValueAuthority(
        transaction,
        portValue.existingValueId,
        portValue.existingValueHash,
        `Plan input port ${portValue.port}`,
      );
      if (canonicalJson(existing.content) !== canonicalJson(portValue.value))
        throw new G5RuntimeError(
          'integrity_violation',
          `Plan input port ${portValue.port} Value content drifted`,
        );
      value = existing.ref;
      valueSchemaHash = existing.schemaHash;
    } else {
      const identity: JsonObject = {
        plan_hash: plan.plan_hash,
        node_id: String(input.node.id),
        port: portValue.port,
        aggregation: portValue.aggregation,
        value: portValue.value,
      };
      value = {
        id: stableRuntimeId('input-port-value', identity),
        hash: runtimeObjectHash('input-port-value', identity),
      };
      insertInlineValue(transaction, {
        id: value.id,
        content: portValue.value,
        contentHash: value.hash,
        schemaAuthority: schema.valueAuthority,
        provenanceRef: `plan-input:${plan.plan_hash}:${String(input.node.id)}:${portValue.port}`,
        retentionClass: 'run_recovery',
        createdAtMs: input.nowMs,
      });
      valueSchemaHash = schema.hash;
    }
    const portSnapshot = requiredObjectField(
      snapshotPorts,
      portValue.port,
      'Sealed input port snapshot',
    );
    portSnapshot.logical_value = {
      value_id: value.id,
      value_hash: value.hash,
      schema_hash: valueSchemaHash,
      byte_length: Buffer.byteLength(canonicalJson(portValue.value), 'utf8'),
    };
    values.push(value);
  }
  return {
    snapshot,
    primaryValue: values.length === 1 ? values[0]! : null,
  };
}

function advancePendingNodesT3(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    planIdentity: PersistedPlanIdentity;
    runWorkFenceEpoch: number;
    scopeWorkFenceEpoch: number;
    scopeInput: RuntimeValueRef;
    payload: RuntimeValueRef;
    append: AppendFixedPointFact;
    nodeRows?: Map<string, T3MaterializedNodeRow>;
    controlEdgeRows?: Map<string, T3MaterializedControlEdgeRow>;
    onPostStateTerminal?: (eventSequence: number) => void;
    nowMs: number;
  },
): {
  readyNodeIds: string[];
  skippedNodeIds: string[];
  orchestrationError: boolean;
} {
  const readyNodeIds: string[] = [];
  const skippedNodeIds: string[] = [];
  let orchestrationError = false;
  const plan = input.planIdentity.plan;
  const nodeRows =
    input.nodeRows ??
    loadT3ScopeNodeAuthority(transaction, {
      graphRunId: input.graphRunId,
      scopeId: input.scopeId,
      planIdentity: input.planIdentity,
    });
  const pendingPlanNodes = [...(plan.nodes as JsonObject[])]
    .sort((left, right) =>
      String(left.id).localeCompare(String(right.id), 'en'),
    )
    .filter(
      (planNode) => nodeRows.get(String(planNode.id))?.phase === 'pending',
    );
  if (pendingPlanNodes.length === 0)
    return { readyNodeIds, skippedNodeIds, orchestrationError };
  const observations = loadT3ScopeObservations(
    transaction,
    input.graphRunId,
    input.scopeId,
    input.controlEdgeRows,
  );
  const schemaAuthority = inputSchemaAuthority(transaction, input.planIdentity);
  const decidedTriggerCuts = new Map<string, JsonObject>();
  for (const planNode of pendingPlanNodes) {
    let row = nodeRows.get(String(planNode.id));
    if (!row || row.phase !== 'pending') continue;
    const control = observations.controlByNodeKey.get(row.node_key) ?? [];
    if (control.some((edge) => edge.state === 'error')) {
      orchestrationError = true;
      continue;
    }
    if (row.trigger_state === 'unknown') {
      const trigger = evaluateTriggerProgram(planNode.trigger_program, control);
      if (trigger.truth !== 'unknown') {
        const cut: JsonObject = {
          truth: trigger.truth,
          witness: trigger.witness,
          truth_program_hash: trigger.truthProgramHash,
        };
        decidedTriggerCuts.set(row.id, cut);
        input.append(
          'trigger_decided',
          'node',
          row.id,
          `trigger-decided:${row.id}`,
          input.payload,
          2,
          cut,
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET trigger_state = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'pending' AND trigger_state = 'unknown'",
            [trigger.truth, input.nowMs, row.id, row.row_version],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            `T3 trigger CAS failed: ${row.id}`,
          );
        row = {
          ...row,
          trigger_state: trigger.truth,
          row_version: row.row_version + 1,
        };
        nodeRows.set(row.node_key, row);
        if (trigger.truth === 'false') {
          const skippedSequence = input.append(
            'node_skipped',
            'node',
            row.id,
            `node-skipped:${row.id}`,
            input.payload,
            2,
          );
          if (
            transaction.execute(
              "UPDATE workflow_graph_nodes SET phase = 'terminal', input_state = 'impossible', terminal_status = 'skipped', terminal_code = 'trigger_false', terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'pending' AND trigger_state = 'false'",
              [input.nowMs, input.nowMs, row.id, row.row_version],
            ).changes !== 1
          )
            throw new G5RuntimeError(
              'cas_conflict',
              `T3 skip CAS failed: ${row.id}`,
            );
          void skippedSequence;
          nodeRows.set(row.node_key, {
            ...row,
            phase: 'terminal',
            input_state: 'impossible',
            terminal_status: 'skipped',
            terminal_code: 'trigger_false',
            row_version: row.row_version + 1,
          });
          input.onPostStateTerminal?.(skippedSequence);
          skippedNodeIds.push(row.id);
          continue;
        }
      }
    }
    if (row.trigger_state !== 'true') continue;
    if (row.input_state === 'open') {
      let seal: InputSealEvaluation;
      try {
        const data = observations.dataByNodeKey.get(row.node_key) ?? [];
        seal = evaluateInputSeal(planNode, data, schemaAuthority);
      } catch (error) {
        if (!(error instanceof G5RuntimeError)) throw error;
        orchestrationError = true;
        continue;
      }
      if (seal.state === 'error') {
        orchestrationError = true;
        continue;
      }
      if (seal.state === 'impossible') {
        const skippedSequence = input.append(
          'node_skipped',
          'node',
          row.id,
          `node-skipped:${row.id}`,
          input.payload,
          2,
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET phase = 'terminal', input_state = 'impossible', terminal_status = 'skipped', terminal_code = 'input_unavailable', terminal_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'pending' AND trigger_state = 'true'",
            [input.nowMs, input.nowMs, row.id, row.row_version],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            `T3 input skip CAS failed: ${row.id}`,
          );
        input.onPostStateTerminal?.(skippedSequence);
        nodeRows.set(row.node_key, {
          ...row,
          phase: 'terminal',
          input_state: 'impossible',
          terminal_status: 'skipped',
          terminal_code: 'input_unavailable',
          row_version: row.row_version + 1,
        });
        skippedNodeIds.push(row.id);
        continue;
      }
      if (seal.state === 'sealed') {
        let sealedSnapshot: JsonObject;
        try {
          sealedSnapshot = materializeSealedInputValues(transaction, {
            planIdentity: input.planIdentity,
            node: planNode,
            seal,
            nowMs: input.nowMs,
          }).snapshot;
        } catch (error) {
          if (!(error instanceof G5RuntimeError)) throw error;
          orchestrationError = true;
          continue;
        }
        input.append(
          'input_sealed',
          'node',
          row.id,
          `input-sealed:${row.id}`,
          input.payload,
          2,
        );
        if (
          transaction.execute(
            "UPDATE workflow_graph_nodes SET input_state = 'sealed', input_snapshot_json = ?, selected_edges_json = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'pending' AND input_state = 'open'",
            [
              canonicalJson(sealedSnapshot),
              canonicalJson(seal.selectedEdgeIds),
              input.nowMs,
              row.id,
              row.row_version,
            ],
          ).changes !== 1
        )
          throw new G5RuntimeError(
            'cas_conflict',
            `T3 input seal CAS failed: ${row.id}`,
          );
        row = {
          ...row,
          input_state: 'sealed',
          row_version: row.row_version + 1,
        };
        nodeRows.set(row.node_key, row);
      }
    }
    if (row.trigger_state === 'true' && row.input_state === 'sealed') {
      let triggerCut = decidedTriggerCuts.get(row.id);
      if (!triggerCut) {
        const triggerEvent = transaction.queryOne<{
          payload_json: string | null;
        }>(
          'SELECT payload_json FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = ?',
          [input.graphRunId, `trigger-decided:${row.id}`],
        );
        if (!triggerEvent?.payload_json)
          throw new G5RuntimeError(
            'integrity_violation',
            'T3 trigger cut Event authority is missing',
          );
        triggerCut = JSON.parse(triggerEvent.payload_json) as JsonObject;
        if (canonicalJson(triggerCut) !== triggerEvent.payload_json)
          throw new G5RuntimeError(
            'integrity_violation',
            'T3 trigger cut Event bytes drifted',
          );
      }
      let data: DataResolutionObservation[];
      let seal: InputSealEvaluation;
      let materialized: {
        snapshot: JsonObject;
        primaryValue: RuntimeValueRef | null;
      };
      try {
        data = observations.dataByNodeKey.get(row.node_key) ?? [];
        seal = evaluateInputSeal(planNode, data, schemaAuthority);
        if (seal.state !== 'sealed' || seal.snapshot === null)
          throw new G5RuntimeError(
            'integrity_violation',
            'T3 sealed input no longer matches the persisted Plan',
          );
        materialized = materializeSealedInputValues(transaction, {
          planIdentity: input.planIdentity,
          node: planNode,
          seal,
          nowMs: input.nowMs,
        });
      } catch (error) {
        if (!(error instanceof G5RuntimeError)) throw error;
        orchestrationError = true;
        continue;
      }
      const selected = data.filter((edge) =>
        seal.selectedEdgeIds.includes(edge.edgeId),
      );
      const passthrough =
        materialized.primaryValue ??
        (selected.length === 1 && selected[0]!.valueId && selected[0]!.valueHash
          ? { id: selected[0]!.valueId, hash: selected[0]!.valueHash }
          : data.length === 0 && control.length === 0
            ? input.scopeInput
            : null);
      const inputSnapshotHash = runtimeObjectHash(
        'input-snapshot',
        materialized.snapshot,
      );
      const readySequence = input.append(
        'node_ready',
        'node',
        row.id,
        `node-ready:${row.id}`,
        input.payload,
        2,
      );
      if (
        transaction.execute(
          "UPDATE workflow_graph_nodes SET phase = 'ready', trigger_cut_json = ?, trigger_cut_hash = ?, input_snapshot_json = ?, input_snapshot_value_id = ?, input_snapshot_hash = ?, selected_edges_json = ?, activation_event_seq = ?, run_work_fence_epoch_at_activation = ?, scope_work_fence_epoch_at_activation = ?, ready_at_ms = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND phase = 'pending' AND trigger_state = 'true' AND input_state = 'sealed'",
          [
            canonicalJson(triggerCut),
            runtimeObjectHash('trigger-cut', triggerCut),
            canonicalJson(materialized.snapshot),
            passthrough?.id ?? null,
            passthrough?.hash ?? inputSnapshotHash,
            canonicalJson(seal.selectedEdgeIds),
            readySequence,
            input.runWorkFenceEpoch,
            input.scopeWorkFenceEpoch,
            input.nowMs,
            input.nowMs,
            row.id,
            row.row_version,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          `T3 ready CAS failed: ${row.id}`,
        );
      readyNodeIds.push(row.id);
      nodeRows.set(row.node_key, {
        ...row,
        phase: 'ready',
        row_version: row.row_version + 1,
      });
    }
  }
  return { readyNodeIds, skippedNodeIds, orchestrationError };
}

function recordAndArbitrateEarlyCompletionT3(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    graphRunId: string;
    scopeId: string;
    plan: CompiledScopePlanV2Document;
    runControl: string;
    runWorkFenceEpoch: number;
    scopeWorkFenceEpoch: number;
    scopeRowVersion: number;
    eligibilityEventSequence: number;
    payload: RuntimeValueRef;
    manifestSchema: RuntimeRegistryRef;
    append: AppendFixedPointFact;
    recordOnly?: boolean;
    nowMs: number;
  },
): { closed: boolean; eventSequence: number | null } {
  const completion = verifyCompletionPolicyAuthority(
    requiredObjectField(
      input.plan as unknown as JsonObject,
      'completion',
      'Compiled Plan v2',
    ),
  );
  const nodeRows = transaction.queryAll<{
    id: string;
    node_key: string;
    phase: string;
    terminal_status: string | null;
    terminal_code: string | null;
    row_version: number;
  }>(
    'SELECT id, node_key, phase, terminal_status, terminal_code, row_version FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY',
    [input.graphRunId, input.scopeId],
  );
  const candidateRows = transaction.queryAll<{
    id: string;
    terminal_node_id: string;
    node_key: string;
    exit_name: string;
    candidate_seq: number;
    output_snapshot_value_id: string;
    output_snapshot_hash: Sha256Hash;
  }>(
    `SELECT c.id, c.terminal_node_id, n.node_key, c.exit_name,
            c.candidate_seq, c.output_snapshot_value_id, c.output_snapshot_hash
       FROM workflow_graph_terminal_candidates c
       JOIN workflow_graph_nodes n ON n.id = c.terminal_node_id
      WHERE c.graph_run_id = ? AND c.scope_id = ?
      ORDER BY c.candidate_seq, c.id COLLATE BINARY`,
    [input.graphRunId, input.scopeId],
  );
  const state = {
    nodes: nodeRows.map<CompletionNodeObservation>((node) => ({
      nodeId: node.id,
      nodeKey: node.node_key,
      phase: node.phase,
      terminalStatus: node.terminal_status,
      terminalCode: node.terminal_code,
    })),
    candidates: candidateRows.map<CompletionCandidateObservation>(
      (candidate) => ({
        id: candidate.id,
        terminalNodeId: candidate.terminal_node_id,
        terminalNodeKey: candidate.node_key,
        exitName: candidate.exit_name,
        candidateSequence: candidate.candidate_seq,
        outputValueId: candidate.output_snapshot_value_id,
        outputHash: candidate.output_snapshot_hash,
      }),
    ),
  };
  const applicable = applicableCompletionRules(completion.early_rules, state);
  const factRows = transaction.queryAll<JsonObject>(
    'SELECT fact_key, payload_hash FROM workflow_graph_facts WHERE graph_run_id = ? AND scope_id = ? ORDER BY event_seq, fact_key COLLATE BINARY',
    [input.graphRunId, input.scopeId],
  );
  const factSnapshotHash = runtimeObjectHash('fact-snapshot', factRows);
  for (const match of applicable) {
    const ruleId = String(match.rule.id);
    const existing = transaction.queryOne<{ id: string }>(
      'SELECT id FROM workflow_graph_completion_eligibilities WHERE scope_id = ? AND rule_id = ?',
      [input.scopeId, ruleId],
    );
    if (existing) continue;
    const eligibilityId = stableRuntimeId('eligibility', {
      graph_run_id: input.graphRunId,
      scope_id: input.scopeId,
      rule_id: ruleId,
      phase: 'early',
    });
    transaction.execute(
      "INSERT INTO workflow_graph_completion_eligibilities (id, graph_run_id, scope_id, rule_id, phase, eligibility_event_seq, selected_candidate_id, fact_snapshot_json, fact_snapshot_hash, created_at_ms) VALUES (?, ?, ?, ?, 'early', ?, ?, ?, ?, ?)",
      [
        eligibilityId,
        input.graphRunId,
        input.scopeId,
        ruleId,
        input.eligibilityEventSequence,
        match.candidate.id,
        canonicalJson(factRows),
        factSnapshotHash,
        input.nowMs,
      ],
    );
    input.append(
      'completion_eligibility',
      'scope',
      input.scopeId,
      `completion-eligibility:${eligibilityId}`,
      input.payload,
      3,
    );
  }
  if (input.recordOnly || input.runControl !== 'running')
    return { closed: false, eventSequence: null };
  const persisted = transaction.queryAll<{
    id: string;
    rule_id: string;
    eligibility_event_seq: number;
    selected_candidate_id: string;
    fact_snapshot_json: string;
    fact_snapshot_hash: Sha256Hash;
  }>(
    "SELECT id, rule_id, eligibility_event_seq, selected_candidate_id, fact_snapshot_json, fact_snapshot_hash FROM workflow_graph_completion_eligibilities WHERE graph_run_id = ? AND scope_id = ? AND phase = 'early'",
    [input.graphRunId, input.scopeId],
  );
  if (persisted.length === 0) return { closed: false, eventSequence: null };
  const rules = new Map(
    ((completion.early_rules ?? []) as JsonObject[]).map((rule) => [
      String(rule.id),
      rule,
    ]),
  );
  const selectedEligibility = [...persisted].sort((left, right) => {
    const leftRule = rules.get(left.rule_id);
    const rightRule = rules.get(right.rule_id);
    if (!leftRule || !rightRule)
      throw new G5RuntimeError(
        'integrity_violation',
        'Persisted early eligibility is absent from the current Plan',
      );
    return (
      left.eligibility_event_seq - right.eligibility_event_seq ||
      Number(rightRule.priority) - Number(leftRule.priority) ||
      left.rule_id.localeCompare(right.rule_id, 'en')
    );
  })[0]!;
  const selectedCandidate = state.candidates.find(
    (candidate) => candidate.id === selectedEligibility.selected_candidate_id,
  );
  if (!selectedCandidate)
    throw new G5RuntimeError(
      'integrity_violation',
      'Early completion candidate is no longer persisted',
    );
  const currentRun = transaction.queryOne<{
    row_version: number;
    next_event_seq: number;
  }>(
    'SELECT row_version, next_event_seq FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  )!;
  const factHead = transaction.queryOne<{ value: number }>(
    'SELECT max(seq) AS value FROM workflow_graph_events WHERE graph_run_id = ?',
    [input.graphRunId],
  )!.value;
  if (
    transaction.execute(
      'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND next_event_seq = ?',
      [
        factHead,
        input.nowMs,
        input.graphRunId,
        currentRun.row_version,
        currentRun.next_event_seq,
      ],
    ).changes !== 1
  )
    throw new G5RuntimeError('cas_conflict', 'T3 early fact-head CAS failed');
  const refreshedRun = transaction.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  )!;
  const closed = requestScopeCloseT7aInTransaction(transaction, {
    graphRunId: input.graphRunId,
    scopeId: input.scopeId,
    expectedRunRowVersion: refreshedRun.row_version,
    expectedScopeRowVersion: input.scopeRowVersion,
    expectedRunWorkFenceEpoch: input.runWorkFenceEpoch,
    expectedScopeWorkFenceEpoch: input.scopeWorkFenceEpoch,
    cause: {
      reason: 'normal',
      selectedRuleId: selectedEligibility.rule_id,
      candidateId: selectedCandidate.id,
      eligibilityEventSeq: selectedEligibility.eligibility_event_seq,
    },
    manifestSchema: input.manifestSchema,
    nowMs: input.nowMs,
  });
  const eventSequence = transaction.queryOne<{ next_event_seq: number }>(
    'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  )!.next_event_seq;
  return { closed: closed.disposition === 'close_requested', eventSequence };
}

export function initializeScopeFixedPointT3a(
  store: WorkflowRuntimeStore,
  input: {
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly expectedRunRowVersion: number;
    readonly manifestSchema: RuntimeRegistryRef;
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
        row_version: number;
      }>(
        'SELECT input_snapshot_value_id, input_snapshot_hash, work_fence_epoch, lifecycle, row_version FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
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
      let causalSequence: number | null = null;
      const scopeInput = {
        id: scope.input_snapshot_value_id,
        hash: scope.input_snapshot_hash,
      };
      const append: AppendFixedPointFact = (
        factKind,
        stableObjectKind,
        stableObjectId,
        factKey,
        payload,
        wave,
        payloadJson,
      ) => {
        sequence += 1;
        if (causalSequence === null) causalSequence = sequence;
        insertGraphEvent(transaction, {
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: stableObjectKind === 'node' ? stableObjectId : null,
          attemptId: null,
          eventType: factKind,
          idempotencyKey: factKey,
          payloadJson: payloadJson ?? null,
          payloadValueId: payloadJson === undefined ? payload.id : null,
          payloadHash: payloadJson === undefined ? payload.hash : null,
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
          causalEventSeq: wave === 0 ? sequence : causalSequence,
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
      const planIdentity = scopePlanAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
      );
      const plan = planIdentity.plan;
      const scopeInputAuthority = loadInlineValueAuthority(
        transaction,
        scopeInput.id,
        scopeInput.hash,
        'Scope input',
      );
      let orchestrationError = false;
      for (const edge of (plan.data_edges as JsonObject[])
        .filter((candidate) =>
          ['scope_input', 'literal'].includes(
            String(objectField(candidate, 'from')?.type),
          ),
        )
        .sort((left, right) =>
          String(left.id).localeCompare(String(right.id), 'en'),
        )) {
        const from = requiredObjectField(edge, 'from', 'Plan data edge');
        const derivedSchema = requiredObjectField(
          edge,
          'derived_schema',
          'Plan data edge',
        );
        const selected = selectAndValidateDataValue(transaction, {
          planIdentity,
          edge,
          root: from.type === 'scope_input' ? scopeInputAuthority : null,
          literal:
            from.type === 'literal' ? (from.value as JsonValue) : undefined,
          nowMs: input.nowMs,
          label:
            from.type === 'literal'
              ? `Plan literal edge ${String(edge.id)}`
              : `Scope input edge ${String(edge.id)}`,
        });
        const missingUnavailable =
          selected.state === 'missing' && edge.on_missing === 'unavailable';
        orchestrationError ||=
          selected.state === 'error' ||
          (selected.state === 'missing' && !missingUnavailable);
        resolveDataEdge(transaction, {
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          edge,
          state:
            selected.state === 'available'
              ? 'available'
              : missingUnavailable
                ? 'unavailable'
                : 'error',
          value: selected.state === 'available' ? selected.value : undefined,
          schemaHash: String(derivedSchema.schema_hash) as Sha256Hash,
          errorCode:
            selected.state === 'error'
              ? selected.errorCode
              : selected.state === 'missing' && !missingUnavailable
                ? 'data_pointer_missing'
                : undefined,
          payload: scopeInput,
          append,
          nowMs: input.nowMs,
        });
      }
      const advanced = advancePendingNodesT3(transaction, {
        graphRunId: input.graphRunId,
        scopeId: input.scopeId,
        planIdentity,
        runWorkFenceEpoch: run.work_fence_epoch,
        scopeWorkFenceEpoch: scope.work_fence_epoch,
        scopeInput,
        payload: scopeInput,
        append,
        nowMs: input.nowMs,
      });
      orchestrationError ||= advanced.orchestrationError;
      if (orchestrationError) {
        const refreshed = transaction.queryOne<{ row_version: number }>(
          'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
          [input.graphRunId],
        );
        if (!refreshed)
          throw new G5RuntimeError(
            'integrity_violation',
            'T3a initialization Run disappeared before engine close',
          );
        closeFixedPointEngineErrorT3(transaction, {
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          expectedRunRowVersion: refreshed.row_version,
          expectedScopeRowVersion: scope.row_version,
          runNextEventSequence: sequence,
          runWorkFenceEpoch: run.work_fence_epoch,
          scopeWorkFenceEpoch: scope.work_fence_epoch,
          errorCode: 'fixed_point_resolution_error',
          manifestSchema: input.manifestSchema,
          nowMs: input.nowMs,
        });
        const closedHead = transaction.queryOne<{ next_event_seq: number }>(
          'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
          [input.graphRunId],
        )!;
        return {
          readyNodeIds: advanced.readyNodeIds,
          lastEventSequence: closedHead.next_event_seq,
        };
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
        sequence !== run.next_event_seq &&
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
        readyNodeIds: advanced.readyNodeIds,
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
        row_version: number;
        input_snapshot_value_id: string | null;
        input_snapshot_hash: Sha256Hash | null;
      }>(
        'SELECT lifecycle, work_fence_epoch, row_version, input_snapshot_value_id, input_snapshot_hash FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?',
        [input.scopeId, input.graphRunId],
      );
      if (
        !run ||
        !scope ||
        run.row_version !== input.expectedRunRowVersion ||
        !['running', 'paused'].includes(run.control) ||
        run.operational_state !== 'healthy' ||
        scope.lifecycle !== 'active' ||
        scope.input_snapshot_value_id === null ||
        scope.input_snapshot_hash === null
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3a Run row version or operational state is stale',
        );
      let sequence = run.next_event_seq;
      let ingressSequence: number | null = null;
      const pendingEvents: GraphEventInsertInput[] = [];
      const pendingFacts: GraphFactInsertInput[] = [];
      const flushFacts = (): void => {
        insertGraphEvents(transaction, pendingEvents);
        chargeAndInsertGraphFacts(transaction, pendingFacts);
        pendingEvents.length = 0;
        pendingFacts.length = 0;
      };
      const append = (
        factKind: string,
        stableObjectKind: string,
        stableObjectId: string,
        factKey: string,
        payload: RuntimeValueRef,
        wave: number,
        payloadJson?: JsonValue,
      ): number => {
        sequence += 1;
        pendingEvents.push({
          graphRunId: input.graphRunId,
          sequence,
          scopeId: input.scopeId,
          nodeId: stableObjectKind === 'node' ? stableObjectId : null,
          attemptId: null,
          eventType: factKind,
          idempotencyKey: factKey,
          payloadJson: payloadJson ?? null,
          payloadValueId: payloadJson === undefined ? payload.id : null,
          payloadHash: payloadJson === undefined ? payload.hash : null,
          occurredAtMs: input.nowMs,
          createdAtMs: input.nowMs,
        });
        pendingFacts.push({
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
      const appendAndFlush: AppendFixedPointFact = (...arguments_) => {
        const appendedSequence = append(...arguments_);
        flushFacts();
        return appendedSequence;
      };
      ingressSequence = append(
        input.factKind,
        input.stableObjectKind,
        input.stableObjectId,
        input.factKey,
        input.payload,
        0,
      );
      const planIdentity = scopePlanAuthority(
        transaction,
        input.graphRunId,
        input.scopeId,
      );
      if (input.factKind === 'node_terminal' && input.terminalStatus) {
        const nodeRows = loadT3ScopeNodeAuthority(transaction, {
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          planIdentity,
        });
        const controlEdgeRows = loadT3ScopeControlEdgeAuthority(transaction, {
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          planIdentity,
        });
        const nodeKeysById = new Map(
          [...nodeRows.values()].map((row) => [row.id, row.node_key]),
        );
        const sourceNodeKey = nodeKeysById.get(input.stableObjectId);
        const source =
          sourceNodeKey === undefined ? undefined : nodeRows.get(sourceNodeKey);
        if (!source)
          throw new G5RuntimeError(
            'precondition_failed',
            'T3a source node is missing',
          );
        if (
          source.phase !== 'terminal' ||
          source.terminal_status !== input.terminalStatus ||
          (input.terminalStatus === 'succeeded' &&
            (source.published_output_envelope_value_id !== input.payload.id ||
              source.published_output_envelope_hash !== input.payload.hash))
        )
          throw new G5RuntimeError(
            'precondition_failed',
            'T3a terminal fact is not backed by persisted Node output',
          );
        const plan = planIdentity.plan;
        const scopeInput = {
          id: scope.input_snapshot_value_id,
          hash: scope.input_snapshot_hash,
        };
        const scopeInputJson = loadInlineValue(
          transaction,
          scopeInput.id,
          scopeInput.hash,
          'Scope input',
        );
        const recordEarlyAt = (eligibilityEventSequence: number): void => {
          flushFacts();
          recordAndArbitrateEarlyCompletionT3(transaction, {
            graphRunId: input.graphRunId,
            scopeId: input.scopeId,
            plan,
            runControl: run.control,
            runWorkFenceEpoch: run.work_fence_epoch,
            scopeWorkFenceEpoch: scope.work_fence_epoch,
            scopeRowVersion: scope.row_version,
            eligibilityEventSequence,
            payload: input.payload,
            manifestSchema: input.manifestSchema,
            append,
            recordOnly: true,
            nowMs: input.nowMs,
          });
        };
        recordEarlyAt(ingressSequence);
        const queue: T3NodeRow[] = [source];
        let orchestrationError = false;
        while (queue.length > 0) {
          const terminal = queue.shift()!;
          orchestrationError =
            resolveTerminalControlRoutes(transaction, {
              graphRunId: input.graphRunId,
              scopeId: input.scopeId,
              planIdentity,
              source: terminal,
              scopeInput: scopeInputJson,
              payload: input.payload,
              append,
              controlEdgeRows,
              nowMs: input.nowMs,
            }) || orchestrationError;
          orchestrationError =
            resolveTerminalDataEdges(transaction, {
              graphRunId: input.graphRunId,
              scopeId: input.scopeId,
              planIdentity,
              source: terminal,
              payload: input.payload,
              append,
              nowMs: input.nowMs,
            }) || orchestrationError;
          const advanced = advancePendingNodesT3(transaction, {
            graphRunId: input.graphRunId,
            scopeId: input.scopeId,
            planIdentity,
            runWorkFenceEpoch: run.work_fence_epoch,
            scopeWorkFenceEpoch: scope.work_fence_epoch,
            scopeInput,
            payload: input.payload,
            append,
            nodeRows,
            controlEdgeRows,
            onPostStateTerminal: recordEarlyAt,
            nowMs: input.nowMs,
          });
          orchestrationError ||= advanced.orchestrationError;
          for (const skippedId of advanced.skippedNodeIds) {
            const skippedNodeKey = nodeKeysById.get(skippedId);
            const skipped =
              skippedNodeKey === undefined
                ? undefined
                : nodeRows.get(skippedNodeKey);
            if (!skipped)
              throw new G5RuntimeError(
                'integrity_violation',
                'T3a skipped node disappeared during fixed point',
              );
            queue.push(skipped);
          }
        }
        if (orchestrationError) {
          flushFacts();
          const refreshed = transaction.queryOne<{ row_version: number }>(
            'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
            [input.graphRunId],
          )!;
          closeFixedPointEngineErrorT3(transaction, {
            graphRunId: input.graphRunId,
            scopeId: input.scopeId,
            expectedRunRowVersion: refreshed.row_version,
            expectedScopeRowVersion: scope.row_version,
            runNextEventSequence: sequence,
            runWorkFenceEpoch: run.work_fence_epoch,
            scopeWorkFenceEpoch: scope.work_fence_epoch,
            errorCode: 'fixed_point_resolution_error',
            manifestSchema: input.manifestSchema,
            nowMs: input.nowMs,
          });
          return {
            disposition: 'reconciled',
            eventSequence: transaction.queryOne<{ next_event_seq: number }>(
              'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
              [input.graphRunId],
            )!.next_event_seq,
          };
        }
      }
      flushFacts();
      const early = recordAndArbitrateEarlyCompletionT3(transaction, {
        graphRunId: input.graphRunId,
        scopeId: input.scopeId,
        plan: planIdentity.plan,
        runControl: run.control,
        runWorkFenceEpoch: run.work_fence_epoch,
        scopeWorkFenceEpoch: scope.work_fence_epoch,
        scopeRowVersion: scope.row_version,
        eligibilityEventSequence: sequence,
        payload: input.payload,
        manifestSchema: input.manifestSchema,
        append: appendAndFlush,
        nowMs: input.nowMs,
      });
      if (early.closed)
        return {
          disposition: 'reconciled',
          eventSequence: early.eventSequence!,
        };
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

function closeFixedPointEngineErrorT3(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly scopeId: string;
    readonly expectedRunRowVersion: number;
    readonly expectedScopeRowVersion: number;
    readonly runNextEventSequence: number;
    readonly runWorkFenceEpoch: number;
    readonly scopeWorkFenceEpoch: number;
    readonly errorCode: string;
    readonly manifestSchema: RuntimeRegistryRef;
    readonly nowMs: number;
  },
): string {
  const errorSequence = input.runNextEventSequence + 1;
  insertGraphEvent(transaction, {
    graphRunId: input.graphRunId,
    sequence: errorSequence,
    scopeId: input.scopeId,
    nodeId: null,
    attemptId: null,
    eventType: 'orchestration_error',
    idempotencyKey: `orchestration-error:${input.scopeId}:${input.errorCode}`,
    payloadJson: { error_code: input.errorCode },
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs,
  });
  const persistedHead = transaction.queryOne<{
    next_event_seq: number;
    row_version: number;
  }>(
    'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  );
  if (
    !persistedHead ||
    persistedHead.row_version !== input.expectedRunRowVersion ||
    transaction.execute(
      'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND next_event_seq = ?',
      [
        errorSequence,
        input.nowMs,
        input.graphRunId,
        input.expectedRunRowVersion,
        persistedHead.next_event_seq,
      ],
    ).changes !== 1
  )
    throw new G5RuntimeError('cas_conflict', 'T3 engine-error head CAS failed');
  const refreshedRun = transaction.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  )!;
  return requestScopeCloseT7aInTransaction(transaction, {
    graphRunId: input.graphRunId,
    scopeId: input.scopeId,
    expectedRunRowVersion: refreshedRun.row_version,
    expectedScopeRowVersion: input.expectedScopeRowVersion,
    expectedRunWorkFenceEpoch: input.runWorkFenceEpoch,
    expectedScopeWorkFenceEpoch: input.scopeWorkFenceEpoch,
    cause: { reason: 'engine_error', errorCode: input.errorCode },
    manifestSchema: input.manifestSchema,
    nowMs: input.nowMs,
  }).closeRequestId;
}

export interface T3bSettledCloseInput {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly expectedRunRowVersion: number;
  readonly expectedScopeRowVersion: number;
  readonly manifestSchema: RuntimeRegistryRef;
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
      verifyCompletionPolicyAuthority(completion);
      const settledRules = completion.settled_rules;
      const completionPolicyHash = completion.policy_hash as Sha256Hash;
      const prior = transaction.queryOne<{
        id: string;
        selected_rule_id: string | null;
        error_code: string | null;
      }>(
        'SELECT id, selected_rule_id, error_code FROM workflow_graph_scope_close_requests WHERE graph_run_id = ? AND scope_id = ?',
        [input.graphRunId, input.scopeId],
      );
      if (prior) {
        const knownRule =
          prior.selected_rule_id === null
            ? prior.error_code === 'no_exit_selected'
            : Array.isArray(settledRules) &&
              settledRules.some(
                (rule) =>
                  rule &&
                  typeof rule === 'object' &&
                  !Array.isArray(rule) &&
                  rule.id === prior.selected_rule_id,
              );
        if (!knownRule)
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
        exit_name: string;
        candidate_seq: number;
        output_snapshot_value_id: string;
        output_snapshot_hash: Sha256Hash;
      }>(
        `SELECT c.id, c.terminal_node_id, n.node_key, c.exit_name, c.candidate_seq,
                c.output_snapshot_value_id, c.output_snapshot_hash
           FROM workflow_graph_terminal_candidates c
           JOIN workflow_graph_nodes n ON n.id = c.terminal_node_id
          WHERE c.graph_run_id = ? AND c.scope_id = ?
          ORDER BY c.candidate_seq, c.id COLLATE BINARY`,
        [input.graphRunId, input.scopeId],
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
        node_key: string;
        phase: string;
        terminal_status: string | null;
        terminal_code: string | null;
        row_version: number;
      }>(
        'SELECT id, node_key, phase, terminal_status, terminal_code, row_version FROM workflow_graph_nodes WHERE graph_run_id = ? AND scope_id = ? ORDER BY node_key COLLATE BINARY',
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
      const completionState = {
        nodes: nodeRows.map<CompletionNodeObservation>((node) => ({
          nodeId: node.id,
          nodeKey: node.node_key,
          phase: node.phase,
          terminalStatus: node.terminal_status,
          terminalCode: node.terminal_code,
        })),
        candidates: candidates.map<CompletionCandidateObservation>(
          (candidate) => ({
            id: candidate.id,
            terminalNodeId: candidate.terminal_node_id,
            terminalNodeKey: candidate.node_key,
            exitName: candidate.exit_name,
            candidateSequence: candidate.candidate_seq,
            outputValueId: candidate.output_snapshot_value_id,
            outputHash: candidate.output_snapshot_hash,
          }),
        ),
      };
      const applicable = applicableCompletionRules(
        settledRules,
        completionState,
      ).sort((left, right) => {
        const byPriority =
          Number(right.rule.priority) - Number(left.rule.priority);
        return byPriority !== 0
          ? byPriority
          : String(left.rule.id).localeCompare(String(right.rule.id), 'en');
      });
      const selected = applicable[0];
      if (!selected) {
        const closeRequestId = closeFixedPointEngineErrorT3(transaction, {
          graphRunId: input.graphRunId,
          scopeId: input.scopeId,
          expectedRunRowVersion: input.expectedRunRowVersion,
          expectedScopeRowVersion: input.expectedScopeRowVersion,
          runNextEventSequence: run.next_event_seq,
          runWorkFenceEpoch: run.work_fence_epoch,
          scopeWorkFenceEpoch: scope.work_fence_epoch,
          errorCode: 'no_exit_selected',
          manifestSchema: input.manifestSchema,
          nowMs: input.nowMs,
        });
        return { disposition: 'close_requested', closeRequestId };
      }
      const selectedRule = selected.rule;
      const selectedRuleId = String(selectedRule.id);
      const candidate = selected.candidate;
      const eligibilitySequence = run.next_event_seq + 1;
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
      insertGraphEvent(transaction, {
        graphRunId: input.graphRunId,
        sequence: eligibilitySequence,
        scopeId: input.scopeId,
        nodeId: null,
        attemptId: null,
        eventType: 'completion_eligibility',
        idempotencyKey: `completion-eligibility:${eligibilityId}`,
        payloadValueId: candidate.outputValueId,
        payloadHash: candidate.outputHash,
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
        payloadValueId: candidate.outputValueId,
        payloadHash: candidate.outputHash,
        createdAtMs: input.nowMs,
      });
      const runAfterEligibility = transaction.queryOne<{
        next_event_seq: number;
        row_version: number;
      }>(
        'SELECT next_event_seq, row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      if (
        transaction.execute(
          'UPDATE workflow_graph_runs SET next_event_seq = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND row_version = ? AND next_event_seq = ?',
          [
            eligibilitySequence,
            input.nowMs,
            input.graphRunId,
            runAfterEligibility.row_version,
            runAfterEligibility.next_event_seq,
          ],
        ).changes !== 1
      )
        throw new G5RuntimeError(
          'cas_conflict',
          'T3b eligibility event-head CAS failed',
        );
      const refreshedRun = transaction.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [input.graphRunId],
      )!;
      const closed = requestScopeCloseT7aInTransaction(transaction, {
        graphRunId: input.graphRunId,
        scopeId: input.scopeId,
        expectedRunRowVersion: refreshedRun.row_version,
        expectedScopeRowVersion: input.expectedScopeRowVersion,
        expectedRunWorkFenceEpoch: run.work_fence_epoch,
        expectedScopeWorkFenceEpoch: scope.work_fence_epoch,
        cause: {
          reason: 'normal',
          selectedRuleId,
          candidateId: candidate.id,
          eligibilityEventSeq: eligibilitySequence,
        },
        manifestSchema: input.manifestSchema,
        nowMs: input.nowMs,
      });
      return {
        disposition: 'close_requested',
        closeRequestId: closed.closeRequestId,
      };
    },
    fault,
  );
}
