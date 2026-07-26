import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeWriteTransaction } from '../store/runtime-store/index.js';
import { G5RuntimeError } from './graph-store.js';

export interface MaterializedNodeAuthority {
  readonly planId: string;
  readonly graphRunId: string;
  readonly plan: CompiledScopePlanV2Document;
  readonly node: JsonObject;
  readonly planHash: Sha256Hash;
  readonly runWorkFenceEpoch: number;
  readonly scopeWorkFenceEpoch: number;
  readonly runtimeSafetyHash: Sha256Hash;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} is not an object`,
    );
  return value as JsonObject;
}

export function verifyCompiledPlanAuthority(
  plan: CompiledScopePlanV2Document,
): Sha256Hash {
  const { plan_hash: claimedPlanHash, ...withoutHash } = plan;
  const observed = domainSeparatedSha256(
    COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
    withoutHash as JsonObject,
  );
  if (
    plan.format !== 'icarus.workflow-graph-scope-plan/2' ||
    !['3.0.4', '3.0.5'].includes(plan.compiler_version) ||
    claimedPlanHash !== observed ||
    !Array.isArray(plan.nodes) ||
    !Array.isArray(plan.control_edges) ||
    !Array.isArray(plan.data_edges)
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Compiled Plan v2 authority is malformed or hash-drifted',
    );
  const nodeIds = plan.nodes.map((candidate) => String(candidate.id));
  if (
    nodeIds.some((id) => id.length === 0) ||
    new Set(nodeIds).size !== nodeIds.length
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Compiled Plan v2 node identities are not unique and finite',
    );
  return claimedPlanHash as Sha256Hash;
}

export function loadMaterializedNodeAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  scopeId: string,
  nodeId: string,
): MaterializedNodeAuthority {
  const row = transaction.queryOne<{
    plan_id: string;
    root_plan_hash: string | null;
    runtime_safety_snapshot_hash: string;
    compiler_toolchain_resource_hash: string;
    run_work_fence_epoch: number;
    scope_plan_hash: string | null;
    scope_work_fence_epoch: number;
    plan_hash: string;
    compiled_plan_json: string | null;
    node_key: string;
    normalized_node_json: string;
    capability_resource_id: string | null;
    capability_version: string | null;
    capability_hash: string | null;
  }>(
    `SELECT p.id AS plan_id, r.root_plan_hash, r.runtime_safety_snapshot_hash,
            r.compiler_toolchain_resource_hash,
            r.work_fence_epoch AS run_work_fence_epoch,
            s.plan_hash AS scope_plan_hash,
            s.work_fence_epoch AS scope_work_fence_epoch,
            p.plan_hash, p.compiled_plan_json,
            n.node_key, n.normalized_node_json,
            n.capability_resource_id, n.capability_version, n.capability_hash
       FROM workflow_graph_runs r
       JOIN workflow_graph_scopes s
         ON s.graph_run_id = r.id AND s.id = ?
       JOIN workflow_graph_scope_plans p
         ON p.graph_run_id = r.id AND p.id = s.plan_id
       JOIN workflow_graph_nodes n
         ON n.graph_run_id = r.id AND n.scope_id = s.id AND n.id = ?
      WHERE r.id = ?`,
    [scopeId, nodeId, graphRunId],
  );
  if (!row || row.compiled_plan_json === null)
    throw new G5RuntimeError(
      'precondition_failed',
      'Materialized Plan/node authority is unavailable',
    );
  const plan = object(
    JSON.parse(row.compiled_plan_json),
    'persisted Compiled Plan v2',
  ) as CompiledScopePlanV2Document;
  const planHash = verifyCompiledPlanAuthority(plan);
  if (
    row.scope_plan_hash !== planHash ||
    row.plan_hash !== planHash ||
    row.root_plan_hash !== planHash ||
    plan.runtime_safety_hash !== row.runtime_safety_snapshot_hash ||
    plan.compiler_toolchain_hash !== row.compiler_toolchain_resource_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Run/Scope/Plan safety or toolchain authority drifted',
    );
  const planNode = (plan.nodes as JsonObject[]).find(
    (candidate) => candidate.id === row.node_key,
  );
  if (!planNode || canonicalJson(planNode) !== row.normalized_node_json)
    throw new G5RuntimeError(
      'integrity_violation',
      'Materialized node is not the exact node pinned by the Plan',
    );
  const capability = planNode.capability_binding;
  if (capability === null || capability === undefined) {
    if (
      row.capability_resource_id !== null ||
      row.capability_version !== null ||
      row.capability_hash !== null
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Non-capability node carries capability authority',
      );
  } else {
    const binding = object(capability, 'Plan capability binding');
    const ref = object(binding.ref, 'Plan capability ref');
    if (
      row.capability_resource_id === null ||
      row.capability_version !== ref.version ||
      row.capability_hash === null
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Capability authority was not completely materialized',
      );
    const registry = transaction.queryOne<{
      id: string;
      content_hash: string;
      publication_state: string;
      resource_id: string;
      resource_version: string;
    }>(
      `SELECT id, content_hash, publication_state, resource_id, resource_version
         FROM workflow_registry_resources
        WHERE id = ? AND resource_type = 'capability'`,
      [row.capability_resource_id],
    );
    if (
      !registry ||
      registry.publication_state !== 'published' ||
      registry.resource_id !== ref.id ||
      registry.resource_version !== ref.version ||
      registry.content_hash !== row.capability_hash
    )
      throw new G5RuntimeError(
        'precondition_failed',
        'Exact Published capability authority is unavailable',
      );
  }
  return {
    planId: row.plan_id,
    graphRunId,
    plan,
    node: planNode,
    planHash,
    runWorkFenceEpoch: row.run_work_fence_epoch,
    scopeWorkFenceEpoch: row.scope_work_fence_epoch,
    runtimeSafetyHash: row.runtime_safety_snapshot_hash as Sha256Hash,
  };
}

export function requiredObjectField(
  value: JsonObject,
  key: string,
  label: string,
): JsonObject {
  return object(value[key], `${label}.${key}`);
}
