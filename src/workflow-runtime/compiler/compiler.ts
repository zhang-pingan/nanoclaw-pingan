import {
  assertJsonObject,
  StrictJsonError,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  CompilerConformanceDiagnosticV1,
  CompiledScopePlanV2Document,
  CompiledStaticChildPlanClosureMemberV1,
} from '../contracts/compiler-contract-repair-types.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import {
  compileTriggerProgram,
  compareAscii,
  compareStableId,
  expressionSteps,
  minimumLimit,
  PLAN_DOMAIN_SEPARATOR,
  pointerTokens,
  semanticHash,
  sortObjectKeys,
  STATIC_CLOSURE_DOMAIN_SEPARATOR,
  STATIC_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
} from './normalizer.js';
import {
  compileCompatibilityProof,
  compileConditionProgram,
  CompilerProofError,
} from './proofs.js';
import { assertSourceObject, validateClosedSource } from './schema-profile.js';
import {
  bindCompilerSnapshot,
  catalogHash,
  childPolicy,
  type BoundCompilerSnapshot,
  interfaceIdentity,
  interfacePlanSnapshot,
  refKey,
  type SnapshotResource,
} from './snapshot.js';
import type {
  WorkflowCompilerFailure,
  WorkflowCompilerIdentity,
  WorkflowCompilerOutcome,
  WorkflowCompilerRequest,
  WorkflowCompilerSuccess,
  WorkflowCompilerSourceKind,
} from './types.js';

export const STATIC_LOWERING_CONTRACT_REF = {
  id: 'icarus.workflow-definition-static-lowering-contract',
  version: '1.0.0',
} as const;
export const STATIC_LOWERING_CONTRACT_HASH =
  'sha256:905b433c6909d6e61663a65d532850f60b0e62a9c6c5f039a1280e3dad44b430' as const;

const SOURCE_DOMAINS: Record<WorkflowCompilerSourceKind, string> = {
  graph_scope: 'icarus:workflow-graph-source:1\n',
  workflow_definition: 'icarus:workflow-definition-source:1\n',
  workflow_schema: 'icarus:workflow-schema-source:1\n',
};

interface CompilationState {
  snapshot: BoundCompilerSnapshot;
  identity: WorkflowCompilerIdentity;
  proofHashes: Set<Sha256Hash>;
  programHashes: Set<Sha256Hash>;
}

class CompilerDiagnosticError extends Error {
  constructor(readonly diagnostic: CompilerConformanceDiagnosticV1) {
    super(diagnostic.code);
    this.name = 'CompilerDiagnosticError';
  }
}

function diagnostic(
  code: CompilerConformanceDiagnosticV1['code'],
  phase: CompilerConformanceDiagnosticV1['phase'],
  instancePointer: string,
  stableObjectId: string | null = null,
  schemaPointer: string | null = null,
): CompilerConformanceDiagnosticV1 {
  return {
    code,
    phase,
    instance_pointer: instancePointer,
    schema_pointer: schemaPointer,
    stable_object_id: stableObjectId,
    detail_ref: null,
  };
}

function reject(
  sourceHash: Sha256Hash | null,
  issue: CompilerConformanceDiagnosticV1,
): WorkflowCompilerOutcome {
  const value: WorkflowCompilerFailure = {
    sourceHash,
    diagnostics: [issue],
  };
  return { ok: false, value };
}

function sourceHash(
  kind: WorkflowCompilerSourceKind,
  source: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(SOURCE_DOMAINS[kind], source);
}

function isMutableVersion(value: JsonValue): boolean {
  return (
    typeof value === 'string' &&
    /^(?:current|head|latest|main|master|next|snapshot)$/i.test(value)
  );
}

function objectRef(value: JsonValue): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function assertPinnedRef(
  ref: JsonObject,
  pointer: string,
  stableId?: string,
): void {
  if (isMutableVersion(ref.version)) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'registry_ref_unpinned',
        'bind',
        `${pointer}/version`,
        stableId ?? (typeof ref.id === 'string' ? ref.id : null),
      ),
    );
  }
}

function asObjectArray(value: JsonValue): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('Compiler expected an array');
  return value.map((entry) => {
    assertJsonObject(entry);
    return entry;
  });
}

function graphNodes(source: JsonObject): JsonObject[] {
  return asObjectArray(source.nodes);
}

function controlEdges(source: JsonObject): JsonObject[] {
  return asObjectArray(source.control_edges);
}

function dataEdges(source: JsonObject): JsonObject[] {
  return asObjectArray(source.data_edges);
}

function versionedRefsEqual(left: JsonObject, right: JsonObject): boolean {
  return left.id === right.id && left.version === right.version;
}

function refAllowed(ref: JsonObject, list: JsonValue): boolean {
  return (
    Array.isArray(list) &&
    list.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        versionedRefsEqual(ref, entry),
    )
  );
}

function resourceForRef(
  snapshot: BoundCompilerSnapshot,
  ref: JsonObject,
  expectedType?: string,
): SnapshotResource | null {
  const resource = snapshot.resourceByKey.get(refKey(ref)) ?? null;
  return resource && (!expectedType || resource.resourceType === expectedType)
    ? resource
    : null;
}

function validateGraphBindings(
  source: JsonObject,
  state: CompilationState,
): void {
  const { snapshot } = state;
  assertJsonObject(source.interface_ref);
  assertPinnedRef(source.interface_ref, '/interface_ref');
  if (!snapshot.interfaceByKey.has(refKey(source.interface_ref))) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'registry_ref_not_found',
        'bind',
        '/interface_ref',
        String(source.interface_ref.id),
      ),
    );
  }
  const nodes = graphNodes(source);
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    const id = String(node.id);
    if (seen.has(id)) {
      throw new CompilerDiagnosticError(
        diagnostic('graph_id_duplicate', 'bind', `/nodes/${index}/id`, id),
      );
    }
    seen.add(id);
  });
  for (const [index, node] of nodes.entries()) {
    if (
      !Array.isArray(snapshot.rootPolicy.allowed_node_types) ||
      !snapshot.rootPolicy.allowed_node_types.includes(node.type)
    ) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'capability_not_allowed',
          'bind',
          `/nodes/${index}/type`,
          String(node.id),
        ),
      );
    }
    const capabilityRef = objectRef(node.capability_ref);
    if (capabilityRef) {
      assertPinnedRef(
        capabilityRef,
        `/nodes/${index}/capability_ref`,
        String(node.id),
      );
      const capability = resourceForRef(snapshot, capabilityRef, 'capability');
      if (!capability) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'registry_ref_not_found',
            'bind',
            `/nodes/${index}/capability_ref`,
            String(capabilityRef.id),
          ),
        );
      }
      if (
        !refAllowed(capabilityRef, snapshot.rootPolicy.allowed_capabilities)
      ) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'capability_not_allowed',
            'bind',
            `/nodes/${index}/capability_ref`,
            String(node.id),
          ),
        );
      }
      validateQualityRevision(capability, index, String(node.id));
    }
    const wait = objectRef(node.wait);
    if (wait) {
      assertJsonObject(wait.contract_ref);
      assertPinnedRef(
        wait.contract_ref,
        `/nodes/${index}/wait/contract_ref`,
        String(node.id),
      );
      if (!resourceForRef(snapshot, wait.contract_ref, 'wait_contract')) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'registry_ref_not_found',
            'bind',
            `/nodes/${index}/wait/contract_ref`,
            String(wait.contract_ref.id),
          ),
        );
      }
    }
    const childPolicyRef = objectRef(node.child_policy_ref);
    if (childPolicyRef)
      validateChildPolicyBinding(childPolicyRef, index, node, snapshot);
  }
}

function validateQualityRevision(
  capability: SnapshotResource,
  nodeIndex: number,
  nodeId: string,
): void {
  const revision = objectRef(capability.content.quality_revision_policy);
  if (!revision) return;
  if (
    !objectRef(revision.feedback_schema_ref) ||
    !objectRef(capability.content.quality_gate_ref)
  ) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'quality_revision_contract_invalid',
        'bind',
        `/nodes/${nodeIndex}/capability_ref`,
        nodeId,
      ),
    );
  }
  const effect = objectRef(capability.content.effect);
  const key = effect ? objectRef(effect.key) : null;
  if (effect?.type !== 'pure' && key?.scope !== 'attempt') {
    throw new CompilerDiagnosticError(
      diagnostic(
        'quality_revision_effect_key_incompatible',
        'bind',
        `/nodes/${nodeIndex}/capability_ref`,
        nodeId,
      ),
    );
  }
}

function validateChildPolicyBinding(
  ref: JsonObject,
  index: number,
  node: JsonObject,
  snapshot: BoundCompilerSnapshot,
): void {
  const binding = childPolicy(snapshot, ref);
  if (!binding) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'registry_ref_not_found',
        'bind',
        `/nodes/${index}/child_policy_ref`,
        String(ref.id),
      ),
    );
  }
  const request = binding.request;
  const root = snapshot.rootPolicy;
  const subsetFields = [
    'allowed_node_types',
    'allowed_capabilities',
    'allowed_templates',
    'allowed_interface_refs',
    'allowed_wait_contracts',
    'allowed_child_policy_refs',
    'allowed_claim_ids',
  ];
  const escalatesSet = subsetFields.some((field) => {
    const requested = request[field];
    const allowed = root[field];
    if (!Array.isArray(requested) || !Array.isArray(allowed)) return false;
    return requested.some(
      (entry) =>
        !allowed.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(entry),
        ),
    );
  });
  const impactRank: Record<string, number> = {
    read_only: 0,
    mutable_effects: 1,
    irreversible: 2,
  };
  const requestEffect = objectRef(request.effect_policy);
  const rootEffect = objectRef(root.effect_policy);
  const escalatesImpact =
    requestEffect && rootEffect
      ? (impactRank[String(requestEffect.max_impact)] ?? 99) >
        (impactRank[String(rootEffect.max_impact)] ?? -1)
      : false;
  if (
    escalatesSet ||
    escalatesImpact ||
    (request.allow_early_close === true && root.allow_early_close !== true)
  ) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'policy_escalation',
        'bind',
        `/nodes/${index}/child_policy_ref`,
        String(node.id),
      ),
    );
  }
}

function validateGraphStructure(
  source: JsonObject,
  state: CompilationState,
): void {
  const nodes = graphNodes(source);
  const nodeIds = new Set(nodes.map((node) => String(node.id)));
  const edges = controlEdges(source);
  for (const [index, edge] of edges.entries()) {
    for (const field of ['from_node_id', 'to_node_id'] as const) {
      const endpoint = String(edge[field]);
      if (endpoint.includes('::')) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'graph_cross_scope_edge',
            'bind',
            `/control_edges/${index}/${field}`,
            String(edge.id),
          ),
        );
      }
      if (!nodeIds.has(endpoint)) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'graph_endpoint_not_found',
            'bind',
            `/control_edges/${index}/${field}`,
            String(edge.id),
          ),
        );
      }
    }
  }
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    const target = String(edge.to_node_id);
    const set = incoming.get(target) ?? new Set<string>();
    set.add(String(edge.id));
    incoming.set(target, set);
  }
  for (const [index, node] of nodes.entries()) {
    assertJsonObject(node.trigger);
    const referenced = new Set(
      Array.isArray(node.trigger.edge_ids)
        ? node.trigger.edge_ids.map((entry) => String(entry))
        : [],
    );
    const expected = incoming.get(String(node.id)) ?? new Set<string>();
    if (
      (node.trigger.type === 'root' && expected.size > 0) ||
      (node.trigger.type !== 'root' &&
        (referenced.size !== expected.size ||
          [...referenced].some((edgeId) => !expected.has(edgeId))))
    ) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'trigger_contract_invalid',
          'prove',
          `/nodes/${index}/trigger`,
          String(node.id),
        ),
      );
    }
  }
  assertAcyclic(edges);
  validateRouteGroups(source);
  validateCompletion(source, state);
  validateSafety(source, state.snapshot);
}

function assertAcyclic(edges: JsonObject[]): void {
  const outgoing = new Map<string, Array<{ target: string; id: string }>>();
  for (const edge of edges) {
    const list = outgoing.get(String(edge.from_node_id)) ?? [];
    list.push({ target: String(edge.to_node_id), id: String(edge.id) });
    outgoing.set(String(edge.from_node_id), list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): string | null => {
    if (visiting.has(nodeId)) return '';
    if (visited.has(nodeId)) return null;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      const nested = visit(edge.target);
      if (nested !== null) return nested || edge.id;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  };
  for (const nodeId of [...outgoing.keys()].sort()) {
    const cycleEdge = visit(nodeId);
    if (cycleEdge !== null) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'graph_dependency_cycle',
          'prove',
          '/control_edges',
          edges.map((edge) => String(edge.id)).sort()[0] ?? cycleEdge,
        ),
      );
    }
  }
}

function validateRouteGroups(source: JsonObject): void {
  const groups = source.route_groups ? asObjectArray(source.route_groups) : [];
  const edges = controlEdges(source);
  groups.forEach((group, index) => {
    if (group.mode !== 'first_matching') return;
    const members = edges.filter((edge) => edge.route_group_id === group.id);
    const priorities = new Set<number>();
    for (const edge of members) {
      if (edge.default === true) continue;
      const priority = typeof edge.priority === 'number' ? edge.priority : 0;
      if (priorities.has(priority)) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'route_group_ambiguous',
            'prove',
            `/route_groups/${index}`,
            String(group.id),
          ),
        );
      }
      priorities.add(priority);
    }
  });
}

function validateCompletion(source: JsonObject, state: CompilationState): void {
  assertJsonObject(source.completion);
  const interfaceEntry = state.snapshot.interfaceByKey.get(
    refKey(source.interface_ref as JsonObject),
  );
  if (!interfaceEntry) throw new Error('Bound interface disappeared');
  assertJsonObject(interfaceEntry.exits);
  for (const [collection, rules] of [
    ['early_rules', source.completion.early_rules],
    ['settled_rules', source.completion.settled_rules],
  ] as const) {
    if (!Array.isArray(rules)) continue;
    for (const [index, value] of rules.entries()) {
      assertJsonObject(value);
      assertJsonObject(value.select);
      if (Array.isArray(value.select.exits)) {
        for (const [exitIndex, exit] of value.select.exits.entries()) {
          if (!(String(exit) in interfaceEntry.exits)) {
            throw new CompilerDiagnosticError(
              diagnostic(
                'completion_contract_invalid',
                'prove',
                `/completion/${collection}/${index}/select/exits/${exitIndex}`,
                String(value.id),
              ),
            );
          }
        }
      }
      if (collection === 'early_rules') {
        assertJsonObject(value.when);
        if (value.when.cmp === 'eq' || value.when.op === 'not') {
          throw new CompilerDiagnosticError(
            diagnostic(
              'early_completion_non_monotone',
              'prove',
              `/completion/early_rules/${index}/when`,
              String(value.id),
            ),
          );
        }
        const unsafe = graphNodes(source).some((node) => {
          const ref = objectRef(node.capability_ref);
          const capability = ref
            ? resourceForRef(state.snapshot, ref, 'capability')
            : null;
          return (
            capability?.content.cancellation &&
            objectRef(capability.content.cancellation)?.type ===
              'requires_compensation'
          );
        });
        if (unsafe) {
          throw new CompilerDiagnosticError(
            diagnostic(
              'early_completion_cancellation_unsafe',
              'prove',
              `/completion/early_rules/${index}`,
              String(value.id),
            ),
          );
        }
      }
    }
  }
}

function validateSafety(
  source: JsonObject,
  snapshot: BoundCompilerSnapshot,
): void {
  assertJsonObject(snapshot.safety.scope);
  const maxNodes = Number(snapshot.safety.scope.max_nodes_per_scope);
  if (graphNodes(source).length > maxNodes) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'runtime_safety_limit_exceeded',
        'prove',
        '/nodes',
        String(source.scope_key),
      ),
    );
  }
}

function validateDefinitionBindings(
  source: JsonObject,
  state: CompilationState,
): void {
  assertJsonObject(source.ref);
  const definitionRef = source.ref;
  assertJsonObject(source.states);
  const recipeResources = state.snapshot.resources
    .filter((resource) => resource.resourceType === 'recipe')
    .sort((left, right) => compareAscii(refKey(left.ref), refKey(right.ref)));
  const owningRecipes = recipeResources.filter((resource) => {
    const candidateRef = objectRef(resource.content.definition_ref);
    return candidateRef && versionedRefsEqual(candidateRef, definitionRef);
  });
  const owningRecipe = owningRecipes[0] ?? null;
  const directChildRecipes: Array<{ key: string; pointer: string }> = [];
  for (const [stateKey, value] of Object.entries(source.states)) {
    assertJsonObject(value);
    const capabilityRef = objectRef(value.capability_ref);
    if (capabilityRef) {
      const capability = resourceForRef(
        state.snapshot,
        capabilityRef,
        'capability',
      );
      if (!capability) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'registry_ref_not_found',
            'bind',
            `/states/${stateKey}/capability_ref`,
            String(capabilityRef.id),
          ),
        );
      }
    }
    for (const slot of definitionTransitions(value, stateKey)) {
      const operations = objectRef(slot.transition.effects)?.operations;
      if (!Array.isArray(operations)) continue;
      for (const [operationIndex, operationValue] of operations.entries()) {
        assertJsonObject(operationValue);
        if (operationValue.type !== 'start_child_workflow') continue;
        assertJsonObject(operationValue.recipe_ref);
        const operationPointer = `${slot.pointer}/effects/operations/${operationIndex}/recipe_ref`;
        const childKey = refKey(operationValue.recipe_ref);
        if (directChildRecipes.some((entry) => entry.key === childKey)) {
          throw new CompilerDiagnosticError(
            diagnostic(
              'child_recipe_set_mismatch',
              'bind',
              operationPointer,
              String(owningRecipe?.ref.id ?? definitionRef.id),
            ),
          );
        }
        directChildRecipes.push({ key: childKey, pointer: operationPointer });
        if (owningRecipe) {
          const allowed = owningRecipe.content.allowed_child_recipe_refs;
          if (!refAllowed(operationValue.recipe_ref, allowed)) {
            throw new CompilerDiagnosticError(
              diagnostic(
                'child_recipe_set_mismatch',
                'bind',
                operationPointer,
                String(owningRecipe.ref.id),
              ),
            );
          }
        }
      }
    }
  }
  if (owningRecipe) {
    const allowed = Array.isArray(
      owningRecipe.content.allowed_child_recipe_refs,
    )
      ? owningRecipe.content.allowed_child_recipe_refs
      : [];
    const allowedKeys = allowed.map((value) => {
      assertJsonObject(value);
      return refKey(value);
    });
    if (
      new Set(allowedKeys).size !== allowedKeys.length ||
      allowedKeys.some(
        (allowedKey) =>
          !directChildRecipes.some((entry) => entry.key === allowedKey),
      )
    ) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'child_recipe_set_mismatch',
          'bind',
          '/ref',
          String(owningRecipe.ref.id),
        ),
      );
    }
  }
  const cycleRoots =
    owningRecipes.length > 0
      ? owningRecipes
      : recipeResources.filter(
          (resource) => !objectRef(resource.content.definition_ref),
        );
  const cycleStart = findRecipeCycle(state.snapshot, cycleRoots);
  if (cycleStart) {
    throw new CompilerDiagnosticError(
      diagnostic('child_recipe_dependency_cycle', 'prove', '/ref', cycleStart),
    );
  }
}

function definitionTransitions(
  state: JsonObject,
  stateKey: string,
): Array<{ pointer: string; transition: JsonObject }> {
  const output: Array<{ pointer: string; transition: JsonObject }> = [];
  const onComplete = objectRef(state.on_complete);
  if (onComplete) {
    for (const name of ['success', 'failure']) {
      const transition = objectRef(onComplete[name]);
      if (transition)
        output.push({
          pointer: `/states/${stateKey}/on_complete/${name}`,
          transition,
        });
    }
  }
  for (const name of ['on_error', 'on_local_cancel']) {
    const transition = objectRef(state[name]);
    if (transition)
      output.push({ pointer: `/states/${stateKey}/${name}`, transition });
  }
  return output;
}

function findRecipeCycle(
  snapshot: BoundCompilerSnapshot,
  roots: SnapshotResource[],
): string | null {
  const recipes = snapshot.resources.filter(
    (resource) => resource.resourceType === 'recipe',
  );
  const byKey = new Map(
    recipes.map((resource) => [refKey(resource.ref), resource]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (resource: SnapshotResource): string | null => {
    const key = refKey(resource.ref);
    if (visiting.has(key)) return resource.ref.id;
    if (visited.has(key)) return null;
    visiting.add(key);
    const children = resource.content.allowed_child_recipe_refs;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (!child || typeof child !== 'object' || Array.isArray(child))
          continue;
        const nested = byKey.get(refKey(child));
        if (nested) {
          const cycle = visit(nested);
          if (cycle) return cycle;
        }
      }
    }
    visiting.delete(key);
    visited.add(key);
    return null;
  };
  for (const recipe of [...roots].sort((left, right) =>
    compareAscii(refKey(left.ref), refKey(right.ref)),
  )) {
    const cycle = visit(recipe);
    if (cycle) return cycle;
  }
  return null;
}

function effectiveLimits(
  requested: JsonObject,
  policy: JsonObject,
  safety: JsonObject,
): JsonObject {
  assertJsonObject(policy.limits);
  const policyLimits = policy.limits;
  assertJsonObject(safety.run);
  assertJsonObject(safety.scope);
  assertJsonObject(safety.map);
  assertJsonObject(safety.wait);
  assertJsonObject(safety.reconciliation);
  const safetyByLimit: Record<string, number> = {
    max_scopes: Number(safety.run.max_scopes_total),
    max_nodes: Number(safety.run.max_nodes_total),
    max_nodes_per_scope: Number(safety.scope.max_nodes_per_scope),
    max_edges_per_scope: Number(safety.scope.max_edges_per_scope),
    max_nesting_depth: Number(safety.scope.max_nesting_depth),
    max_map_items: Number(safety.map.max_items_per_map),
    max_concurrency: Number(safety.map.max_child_concurrency_per_map),
    max_total_attempts: Number(safety.run.max_attempts_total),
    max_total_waits: Number(safety.run.max_waits_total),
    max_total_output_bytes: Number(safety.run.max_logical_output_bytes_total),
    max_scope_spec_bytes: Number(safety.scope.max_scope_spec_bytes),
    max_condition_steps: Number(
      safety.reconciliation.max_condition_steps_per_evaluation,
    ),
    max_wait_duration_ms: Number(safety.wait.max_finite_wait_duration_ms),
    max_pending_signals: Number(safety.wait.max_pending_signals_per_run),
    max_fixed_point_facts: Number(
      safety.reconciliation.max_facts_per_transaction,
    ),
    max_frontier_bytes: Number(safety.scope.max_frontier_bytes),
  };
  return Object.fromEntries(
    Object.keys(safetyByLimit).map((key) => [
      key,
      minimumLimit(
        typeof requested[key] === 'number' ? requested[key] : null,
        typeof policyLimits[key] === 'number' ? policyLimits[key] : null,
        safetyByLimit[key],
      ),
    ]),
  );
}

function compiledSchema(
  snapshot: BoundCompilerSnapshot,
  ref: JsonObject,
): JsonObject {
  const resource = resourceForRef(snapshot, ref, 'schema');
  if (!resource) throw new Error(`Schema binding disappeared: ${refKey(ref)}`);
  return {
    type: 'registry',
    ref: resource.ref,
    schema_hash: resource.contentHash,
  };
}

function compileInputPorts(
  ports: JsonObject,
  snapshot: BoundCompilerSnapshot,
): JsonObject {
  return Object.fromEntries(
    Object.keys(ports)
      .sort()
      .map((name) => {
        const contract = ports[name];
        assertJsonObject(contract);
        assertJsonObject(contract.schema_ref);
        return [
          name,
          {
            schema: compiledSchema(snapshot, contract.schema_ref),
            max_bytes:
              typeof contract.max_bytes === 'number'
                ? contract.max_bytes
                : null,
            aggregation: contract.aggregation ?? {
              type: 'single',
              required: false,
              select: 'only',
            },
          },
        ];
      }),
  );
}

function compileOutputPorts(
  ports: JsonObject,
  snapshot: BoundCompilerSnapshot,
): JsonObject {
  return Object.fromEntries(
    Object.keys(ports)
      .sort()
      .map((name) => {
        const contract = ports[name];
        assertJsonObject(contract);
        assertJsonObject(contract.schema_ref);
        return [
          name,
          {
            schema: compiledSchema(snapshot, contract.schema_ref),
            max_bytes:
              typeof contract.max_bytes === 'number'
                ? contract.max_bytes
                : null,
            required: contract.required === true,
          },
        ];
      }),
  );
}

function nodeBase(node: JsonObject, state: CompilationState): JsonObject {
  assertJsonObject(node.trigger);
  const triggerProgram = compileTriggerProgram(node.trigger);
  state.programHashes.add(triggerProgram.truth_program_hash as Sha256Hash);
  let inputPorts = objectRef(node.input_ports) ?? {};
  let outputPorts = objectRef(node.output_ports) ?? {};
  const capabilityRef = objectRef(node.capability_ref);
  if (capabilityRef) {
    const capability = resourceForRef(
      state.snapshot,
      capabilityRef,
      'capability',
    );
    if (!capability) throw new Error('Capability binding disappeared');
    assertJsonObject(capability.content.input_ports);
    assertJsonObject(capability.content.output_ports);
    inputPorts = capability.content.input_ports;
    outputPorts = capability.content.output_ports;
  }
  const wait = objectRef(node.wait);
  if (wait) {
    assertJsonObject(wait.contract_ref);
    const contract = resourceForRef(
      state.snapshot,
      wait.contract_ref,
      'wait_contract',
    );
    if (!contract) throw new Error('Wait binding disappeared');
    assertJsonObject(contract.content.input_ports);
    assertJsonObject(contract.content.output_ports);
    inputPorts = contract.content.input_ports;
    outputPorts = contract.content.output_ports;
  }
  return {
    id: node.id,
    type: node.type,
    source_config_hash: semanticHash(
      'icarus:workflow-node-source-config:1\n',
      node,
    ),
    trigger_program: triggerProgram,
    input_ports: compileInputPorts(inputPorts, state.snapshot),
    output_ports: compileOutputPorts(outputPorts, state.snapshot),
    effective_limits: {},
  };
}

function effectiveRetryPolicy(
  capability: SnapshotResource,
  state: CompilationState,
): JsonObject {
  assertJsonObject(capability.content.retry_policy);
  const revision = objectRef(capability.content.quality_revision_policy);
  let qualityRevision: JsonObject | null = null;
  if (revision) {
    assertJsonObject(revision.feedback_schema_ref);
    const schema = resourceForRef(
      state.snapshot,
      revision.feedback_schema_ref,
      'schema',
    );
    if (!schema) throw new Error('Feedback schema binding disappeared');
    qualityRevision = {
      feedback_schema_ref: schema.ref,
      feedback_schema_hash: schema.contentHash,
      effective_max_feedback_bytes: Number(revision.max_feedback_bytes),
      context_mode: 'base_input_plus_latest_revision',
    };
  }
  const withoutHash = {
    effective_node_max_attempts: Number(
      capability.content.retry_policy.max_attempts,
    ),
    effective_retry_on: capability.content.retry_policy.retry_on,
    backoff: capability.content.retry_policy.backoff,
    quality_revision: qualityRevision,
  };
  return {
    ...withoutHash,
    policy_hash: semanticHash(
      'icarus:workflow-effective-retry-policy:1\n',
      withoutHash,
    ),
  };
}

function compileCapabilityNode(
  node: JsonObject,
  state: CompilationState,
): JsonObject {
  const base = nodeBase(node, state);
  assertJsonObject(node.capability_ref);
  const capability = resourceForRef(
    state.snapshot,
    node.capability_ref,
    'capability',
  );
  if (!capability) throw new Error('Capability binding disappeared');
  return {
    ...base,
    capability_binding: capability.content,
    effective_retry_policy: effectiveRetryPolicy(capability, state),
  };
}

interface FactoryCompilation {
  binding: JsonObject;
  childPlan: CompiledScopePlanV2Document;
  scopeKey: string;
  sourceHash: Sha256Hash;
  sourceRef: VersionedRef | null;
  kind: 'inline' | 'template';
}

function compileFactory(
  factory: JsonObject,
  ownerPath: string[],
  state: CompilationState,
): FactoryCompilation {
  let childSource: JsonObject;
  let sourceRef: VersionedRef | null = null;
  let sourceSnapshotRef: string;
  if (factory.type === 'template') {
    assertJsonObject(factory.template_ref);
    const template = resourceForRef(
      state.snapshot,
      factory.template_ref,
      'template',
    );
    if (!template) throw new Error('Template binding disappeared');
    childSource = template.content;
    sourceRef = template.ref;
    sourceSnapshotRef = `registry:${refKey(template.ref)}`;
  } else {
    assertJsonObject(factory.scope);
    childSource = factory.scope;
    sourceSnapshotRef = `inline:${ownerPath.join('/')}`;
  }
  const childPlan = compileGraphPlan(childSource, state);
  const hash = sourceHash('graph_scope', childSource);
  return {
    binding: {
      kind: factory.type,
      ...(sourceRef ? { source_ref: sourceRef } : {}),
      source_snapshot_ref: sourceSnapshotRef,
      source_hash: hash,
      precompiled_plan_hash: childPlan.plan_hash,
      interface_snapshot: childPlan.interface_snapshot,
    },
    childPlan,
    scopeKey: String(childSource.scope_key),
    sourceHash: hash,
    sourceRef,
    kind: factory.type as 'inline' | 'template',
  };
}

function compiledChildPolicy(
  ref: JsonObject,
  state: CompilationState,
): JsonObject {
  const binding = childPolicy(state.snapshot, ref);
  if (!binding) throw new Error('Child policy binding disappeared');
  return {
    profile_ref: binding.profile,
    effective_policy_snapshot: binding.request,
    effective_policy_hash: binding.hash,
  };
}

function compileGraphNode(
  node: JsonObject,
  state: CompilationState,
  ownerPath: string[],
  factoryByNode: Map<string, FactoryCompilation>,
): JsonObject {
  if (node.type === 'delegation' || node.type === 'system') {
    return compileCapabilityNode(node, state);
  }
  const base = nodeBase(node, state);
  if (node.type === 'terminal') return { ...base, exit: node.exit };
  if (node.type === 'wait') {
    assertJsonObject(node.wait);
    assertJsonObject(node.wait.contract_ref);
    const contract = resourceForRef(
      state.snapshot,
      node.wait.contract_ref,
      'wait_contract',
    );
    if (!contract) throw new Error('Wait binding disappeared');
    assertJsonObject(state.snapshot.safety.wait);
    return {
      ...base,
      wait_binding: {
        ...node.wait,
        contract_snapshot: contract.content,
        effective_max_duration_ms: minimumLimit(
          typeof node.wait.timeout_ms === 'number'
            ? node.wait.timeout_ms
            : null,
          Number(state.snapshot.safety.wait.max_finite_wait_duration_ms),
        ),
      },
    };
  }
  if (node.type === 'join') return { ...base, expose: node.expose };
  if (node.type === 'subgraph') {
    assertJsonObject(node.scope);
    assertJsonObject(node.child_policy_ref);
    const factory = compileFactory(node.scope, ownerPath, state);
    factoryByNode.set(String(node.id), factory);
    return {
      ...base,
      factory_binding: factory.binding,
      child_input_bindings: node.child_input_bindings,
      completion_output_port: node.completion_output_port,
      expose: node.expose,
      child_policy: compiledChildPolicy(node.child_policy_ref, state),
    };
  }
  if (node.type === 'expand') {
    assertJsonObject(node.child_interface_ref);
    assertJsonObject(node.child_policy_ref);
    const childInterface = state.snapshot.interfaceByKey.get(
      refKey(node.child_interface_ref),
    );
    if (!childInterface) throw new Error('Expand child interface disappeared');
    return {
      ...base,
      graph_spec_input_port: node.graph_spec_input_port,
      child_interface_snapshot: interfacePlanSnapshot(childInterface),
      child_input_bindings: node.child_input_bindings,
      completion_output_port: node.completion_output_port,
      expose: node.expose,
      child_policy: compiledChildPolicy(node.child_policy_ref, state),
    };
  }
  if (node.type === 'map') {
    assertJsonObject(node.body);
    assertJsonObject(node.child_policy_ref);
    const factory = compileFactory(node.body, ownerPath, state);
    factoryByNode.set(String(node.id), factory);
    assertJsonObject(state.snapshot.safety.map);
    return {
      ...base,
      body_binding: factory.binding,
      items_input_port: node.items_input_port,
      item_child_input_port: node.item_child_input_port,
      shared_child_input_bindings: node.shared_child_input_bindings,
      result_output_port: node.result_output_port,
      ...(typeof node.item_key_pointer === 'string'
        ? { item_key_pointer: node.item_key_pointer }
        : {}),
      effective_max_items: minimumLimit(
        typeof node.requested_max_items === 'number'
          ? node.requested_max_items
          : null,
        Number(state.snapshot.safety.map.max_items_per_map),
      ),
      effective_child_concurrency: minimumLimit(
        typeof node.requested_child_concurrency === 'number'
          ? node.requested_child_concurrency
          : null,
        Number(state.snapshot.safety.map.max_child_concurrency_per_map),
      ),
      completion: node.completion,
      child_policy: compiledChildPolicy(node.child_policy_ref, state),
      result_order: 'item_index',
    };
  }
  throw new Error(`Unsupported compiled node type: ${String(node.type)}`);
}

function compileControlEdges(
  source: JsonObject,
  state: CompilationState,
  interfaceSnapshot: JsonObject,
): JsonObject[] {
  const nodes = new Map(
    graphNodes(source).map((node) => [String(node.id), node]),
  );
  const limits = effectiveLimits(
    source.requested_limits as JsonObject,
    state.snapshot.rootPolicy,
    state.snapshot.safety,
  );
  return controlEdges(source)
    .map((edge, index) => {
      let conditionProgram: JsonObject | null = null;
      if (
        edge.when &&
        typeof edge.when === 'object' &&
        !Array.isArray(edge.when)
      ) {
        const fromNode = nodes.get(String(edge.from_node_id));
        if (!fromNode) throw new Error('Control source disappeared');
        try {
          conditionProgram = compileConditionProgram(
            edge.when,
            fromNode,
            state.snapshot,
            interfaceSnapshot,
            Number(limits.max_condition_steps),
          );
        } catch (error) {
          if (error instanceof CompilerProofError) {
            throw new CompilerDiagnosticError(
              diagnostic(
                error.code,
                'prove',
                `/control_edges/${index}/when`,
                String(edge.id),
              ),
            );
          }
          throw error;
        }
        state.programHashes.add(conditionProgram.program_hash as Sha256Hash);
      }
      const withoutHash = {
        id: edge.id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        outcome_match: edge.on ?? null,
        condition_program: conditionProgram,
        route_group_id: edge.route_group_id ?? null,
        priority: typeof edge.priority === 'number' ? edge.priority : null,
        is_default: edge.default === true,
        source_config_hash: semanticHash(
          'icarus:workflow-control-edge-source:1\n',
          edge,
        ),
      };
      return {
        ...withoutHash,
        compiled_edge_hash: semanticHash(
          'icarus:workflow-control-edge-compiled:1\n',
          withoutHash,
        ),
      };
    })
    .sort(compareStableId);
}

function compileDataEdges(
  source: JsonObject,
  state: CompilationState,
  interfaceSnapshot: JsonObject,
): JsonObject[] {
  const nodes = new Map(
    graphNodes(source).map((node) => [String(node.id), node]),
  );
  return dataEdges(source)
    .map((edge, index) => {
      let compiled;
      try {
        compiled = compileCompatibilityProof(
          edge,
          nodes,
          state.snapshot,
          state.identity,
          interfaceSnapshot,
        );
      } catch (error) {
        if (error instanceof CompilerProofError) {
          const pointer =
            error.code === 'json_pointer_non_total'
              ? `/data_edges/${index}/from/pointer`
              : `/data_edges/${index}`;
          throw new CompilerDiagnosticError(
            diagnostic(error.code, 'prove', pointer, String(edge.id)),
          );
        }
        throw error;
      }
      state.proofHashes.add(compiled.proof.proof_hash as Sha256Hash);
      assertJsonObject(edge.from);
      const canonicalPointer =
        typeof edge.from.pointer === 'string' ? edge.from.pointer : null;
      const withoutHash = {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        guard_control_edge_id: edge.guard_control_edge_id ?? null,
        canonical_pointer: canonicalPointer,
        pointer_tokens: pointerTokens(canonicalPointer),
        on_missing: edge.on_missing ?? 'error',
        producer_schema_hash: compiled.proof.producer_schema_hash,
        derived_schema: compiled.derivedSchema,
        consumer_schema_hash: compiled.proof.consumer_schema_hash,
        compatibility_proof: compiled.proof,
        source_config_hash: semanticHash(
          'icarus:workflow-data-edge-source:1\n',
          edge,
        ),
      };
      return {
        ...withoutHash,
        compiled_edge_hash: semanticHash(
          'icarus:workflow-data-edge-compiled:1\n',
          withoutHash,
        ),
      };
    })
    .sort(compareStableId);
}

function compileRouteGroups(source: JsonObject): JsonObject[] {
  const edges = controlEdges(source);
  const groups = source.route_groups ? asObjectArray(source.route_groups) : [];
  return groups
    .map((group) => {
      const orderedEdgeIds = edges
        .filter((edge) => edge.route_group_id === group.id)
        .sort((left, right) => {
          if (left.default === true && right.default !== true) return 1;
          if (right.default === true && left.default !== true) return -1;
          const priorityDifference =
            Number(right.priority ?? 0) - Number(left.priority ?? 0);
          return (
            priorityDifference ||
            compareAscii(String(left.id), String(right.id))
          );
        })
        .map((edge) => String(edge.id));
      const withoutHash = {
        id: group.id,
        from_node_id: group.from_node_id,
        mode: group.mode,
        no_match: group.no_match,
        ordered_edge_ids: orderedEdgeIds,
      };
      return {
        ...withoutHash,
        group_hash: semanticHash(
          'icarus:workflow-route-group:1\n',
          withoutHash,
        ),
      };
    })
    .sort(compareStableId);
}

function compileCompletion(
  source: JsonObject,
  state: CompilationState,
): JsonObject {
  assertJsonObject(source.completion);
  const compileRules = (values: JsonValue): JsonObject[] => {
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => {
        assertJsonObject(value);
        assertJsonObject(value.when);
        assertJsonObject(value.select);
        const factProgramHash = semanticHash(
          'icarus:workflow-completion-fact-program:1\n',
          value.when,
        );
        state.programHashes.add(factProgramHash);
        const selectorHash = semanticHash(
          'icarus:workflow-completion-selector:1\n',
          value.select,
        );
        const withoutHash = {
          id: value.id,
          phase: value.phase,
          normalized_fact_expression: sortObjectKeys(value.when),
          fact_program_hash: factProgramHash,
          max_steps: expressionSteps(value.when),
          selector: sortObjectKeys(value.select),
          selector_contract_hash: selectorHash,
          priority:
            typeof value.priority === 'number'
              ? value.priority
              : Number(value.same_event_priority),
          monotonicity_proof: null,
          cancellation_safety_proof: null,
        };
        return {
          ...withoutHash,
          rule_hash: semanticHash(
            'icarus:workflow-completion-rule:1\n',
            withoutHash,
          ),
        };
      })
      .sort(
        (left, right) =>
          Number(right.priority) - Number(left.priority) ||
          compareStableId(left, right),
      );
  };
  const withoutHash = {
    early_rules: compileRules(source.completion.early_rules),
    settled_rules: compileRules(source.completion.settled_rules),
    no_match: source.completion.no_match,
    early_close: source.completion.early_close,
  };
  return {
    ...withoutHash,
    policy_hash: semanticHash(
      'icarus:workflow-completion-policy:1\n',
      withoutHash,
    ),
  };
}

function closureMember(
  factory: FactoryCompilation,
  nodeId: string,
  parentClosureKey: string | null,
  ownerPath: string[],
): CompiledStaticChildPlanClosureMemberV1 {
  const closureKey = parentClosureKey
    ? `${parentClosureKey}/${nodeId}`
    : nodeId;
  const withoutHash = {
    closure_key: closureKey,
    parent_closure_key: parentClosureKey,
    scope_key: factory.scopeKey,
    owner_node_path: ownerPath,
    factory_kind: factory.kind,
    source_ref: factory.sourceRef,
    source_hash: factory.sourceHash,
    plan_ref: `candidate:plan:${factory.childPlan.plan_hash}`,
    plan_hash: factory.childPlan.plan_hash as Sha256Hash,
    interface_snapshot_hash: factory.childPlan
      .interface_snapshot_hash as Sha256Hash,
  };
  return {
    ...withoutHash,
    member_hash: semanticHash(
      STATIC_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
      withoutHash,
    ),
  } as CompiledStaticChildPlanClosureMemberV1;
}

function staticClosure(
  source: JsonObject,
  factoryByNode: Map<string, FactoryCompilation>,
): JsonObject {
  const members: CompiledStaticChildPlanClosureMemberV1[] = [];
  const append = (
    nodeId: string,
    factory: FactoryCompilation,
    parentClosureKey: string | null,
    ownerPath: string[],
  ): void => {
    const direct = closureMember(factory, nodeId, parentClosureKey, ownerPath);
    members.push(direct);
    for (const child of factory.childPlan.static_child_plan_closure.members) {
      const rebasedWithoutHash = {
        ...child,
        closure_key: `${direct.closure_key}/${child.closure_key}`,
        parent_closure_key:
          child.parent_closure_key === null
            ? direct.closure_key
            : `${direct.closure_key}/${child.parent_closure_key}`,
        owner_node_path: [...ownerPath, ...child.owner_node_path],
      };
      delete (
        rebasedWithoutHash as Partial<CompiledStaticChildPlanClosureMemberV1>
      ).member_hash;
      members.push({
        ...rebasedWithoutHash,
        member_hash: semanticHash(
          STATIC_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
          rebasedWithoutHash as JsonObject,
        ),
      } as CompiledStaticChildPlanClosureMemberV1);
    }
  };
  for (const node of graphNodes(source).sort(compareStableId)) {
    const factory = factoryByNode.get(String(node.id));
    if (factory) append(String(node.id), factory, null, [String(node.id)]);
  }
  const withoutHash = { members, member_count: members.length };
  return {
    ...withoutHash,
    closure_hash: semanticHash(STATIC_CLOSURE_DOMAIN_SEPARATOR, withoutHash),
  };
}

function complexitySummary(
  nodes: JsonObject[],
  controls: JsonObject[],
  data: JsonObject[],
  completion: JsonObject,
): JsonObject {
  const fanOut = new Map<string, number>();
  for (const edge of controls) {
    const source = String(edge.from_node_id);
    fanOut.set(source, (fanOut.get(source) ?? 0) + 1);
  }
  const conditionSteps = controls.map(
    (edge) => objectRef(edge.condition_program)?.max_steps ?? 0,
  );
  const triggerSteps = nodes.map(
    (node) => objectRef(node.trigger_program)?.max_steps ?? 0,
  );
  const completionRules = [
    ...(Array.isArray(completion.early_rules) ? completion.early_rules : []),
    ...(Array.isArray(completion.settled_rules)
      ? completion.settled_rules
      : []),
  ] as JsonValue[];
  const completionSteps = completionRules.map((rule) => {
    assertJsonObject(rule);
    return Number(rule.max_steps);
  });
  const withoutHash = {
    node_count: nodes.length,
    control_edge_count: controls.length,
    data_edge_count: data.length,
    max_source_fan_out: Math.max(0, ...fanOut.values()),
    max_condition_steps: Math.max(0, ...conditionSteps.map(Number)),
    max_trigger_steps: Math.max(1, ...triggerSteps.map(Number)),
    max_completion_steps: Math.max(1, ...completionSteps),
    max_reconcile_facts_per_ingress: Math.max(
      1,
      nodes.length + controls.length,
    ),
    max_frontier_bytes: Math.max(1, nodes.length * 64),
  };
  return {
    ...withoutHash,
    summary_hash: semanticHash(
      'icarus:workflow-complexity-summary:1\n',
      withoutHash,
    ),
  };
}

function compileGraphPlan(
  source: JsonObject,
  state: CompilationState,
): CompiledScopePlanV2Document {
  assertJsonObject(source.interface_ref);
  assertJsonObject(source.requested_limits);
  const interfaceEntry = state.snapshot.interfaceByKey.get(
    refKey(source.interface_ref),
  );
  if (!interfaceEntry) throw new Error('Graph interface binding disappeared');
  const interfaceSnapshot = interfacePlanSnapshot(interfaceEntry);
  const factoryByNode = new Map<string, FactoryCompilation>();
  const nodes = graphNodes(source)
    .map((node) =>
      compileGraphNode(node, state, [String(node.id)], factoryByNode),
    )
    .sort(compareStableId);
  const routeGroups = compileRouteGroups(source);
  const controls = compileControlEdges(source, state, interfaceSnapshot);
  const data = compileDataEdges(source, state, interfaceSnapshot);
  const completion = compileCompletion(source, state);
  const closure = staticClosure(source, factoryByNode);
  const withoutHash = {
    format: 'icarus.workflow-graph-scope-plan/2' as const,
    compiler_version: state.identity.compiler_version,
    compiler_build_hash: state.identity.compiler_build_hash,
    compiler_toolchain_ref: state.identity.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash: state.identity.compiler_toolchain_hash,
    compiler_error_catalog_hash: state.identity.error_catalog_hash,
    canonical_normalizer_version: state.identity.canonical_normalizer_version,
    canonical_normalizer_hash: state.identity.canonical_normalizer_hash,
    proof_algorithm_version: state.identity.proof_algorithm_version,
    proof_algorithm_hash: state.identity.proof_algorithm_hash,
    source_hash: sourceHash('graph_scope', source),
    interface_snapshot_hash: interfaceIdentity(interfaceEntry),
    policy_snapshot_hash: state.snapshot.rootPolicyHash,
    effective_policy_snapshot: state.snapshot.rootPolicy,
    capability_catalog_hash: catalogHash(state.snapshot, 'capability'),
    wait_contract_catalog_hash: catalogHash(state.snapshot, 'wait_contract'),
    interface_snapshot: interfaceSnapshot,
    nodes,
    route_groups: routeGroups,
    control_edges: controls,
    data_edges: data,
    completion,
    complexity_summary: complexitySummary(nodes, controls, data, completion),
    static_child_plan_closure: closure,
    effective_limits: effectiveLimits(
      source.requested_limits,
      state.snapshot.rootPolicy,
      state.snapshot.safety,
    ),
    effective_usage_budget: state.snapshot.rootPolicy.usage_budget,
    runtime_safety_snapshot: state.snapshot.safety,
    runtime_safety_hash: state.snapshot.safetyHash,
  };
  return {
    ...withoutHash,
    plan_hash: semanticHash(PLAN_DOMAIN_SEPARATOR, withoutHash),
  } as CompiledScopePlanV2Document;
}

function compileDefinitionPlan(
  source: JsonObject,
  state: CompilationState,
): CompiledScopePlanV2Document {
  assertJsonObject(source.ref);
  assertJsonObject(source.entry_points);
  assertJsonObject(source.states);
  const entry = source.entry_points.default;
  assertJsonObject(entry);
  const stateKey = String(entry.state_key);
  const definitionState = source.states[stateKey];
  assertJsonObject(definitionState);
  assertJsonObject(definitionState.policy);
  const generatedInterface = {
    ref: {
      id: `generated.${String(source.ref.id)}.${stateKey}`,
      version: String(source.ref.version),
    },
    inputs: {},
    exits: {
      success: { output_ports: {} },
      failure: { output_ports: {} },
    },
  };
  const generatedInterfaceHash = semanticHash(
    'icarus:workflow-generated-definition-interface:1\n',
    generatedInterface,
  );
  const nodeSource = {
    id: stateKey,
    type: definitionState.type,
    trigger: { type: 'root' },
    capability_ref: definitionState.capability_ref,
  } as JsonObject;
  const node = compileCapabilityNode(nodeSource, state);
  const completionSource = {
    completion: {
      settled_rules: [
        {
          id: 'select_capability_outcome',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['success', 'failure'],
            pick: { type: 'first_reached' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
  } as JsonObject;
  const completion = compileCompletion(completionSource, state);
  const closureWithoutHash = { members: [], member_count: 0 };
  const closure = {
    ...closureWithoutHash,
    closure_hash: semanticHash(
      STATIC_CLOSURE_DOMAIN_SEPARATOR,
      closureWithoutHash,
    ),
  };
  const requestedLimits = definitionState.policy.limits;
  assertJsonObject(requestedLimits);
  const withoutHash = {
    format: 'icarus.workflow-graph-scope-plan/2' as const,
    compiler_version: state.identity.compiler_version,
    compiler_build_hash: state.identity.compiler_build_hash,
    compiler_toolchain_ref: state.identity.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash: state.identity.compiler_toolchain_hash,
    compiler_error_catalog_hash: state.identity.error_catalog_hash,
    canonical_normalizer_version: state.identity.canonical_normalizer_version,
    canonical_normalizer_hash: state.identity.canonical_normalizer_hash,
    proof_algorithm_version: state.identity.proof_algorithm_version,
    proof_algorithm_hash: state.identity.proof_algorithm_hash,
    source_hash: sourceHash('workflow_definition', source),
    interface_snapshot_hash: generatedInterfaceHash,
    policy_snapshot_hash: semanticHash(
      'icarus:workflow-definition-effective-policy:1\n',
      definitionState.policy,
    ),
    effective_policy_snapshot: definitionState.policy,
    capability_catalog_hash: catalogHash(state.snapshot, 'capability'),
    wait_contract_catalog_hash: catalogHash(state.snapshot, 'wait_contract'),
    interface_snapshot: generatedInterface,
    nodes: [node],
    route_groups: [],
    control_edges: [],
    data_edges: [],
    completion,
    complexity_summary: complexitySummary([node], [], [], completion),
    static_child_plan_closure: closure,
    effective_limits: effectiveLimits(
      requestedLimits,
      definitionState.policy,
      state.snapshot.safety,
    ),
    effective_usage_budget: definitionState.policy.usage_budget,
    runtime_safety_snapshot: state.snapshot.safety,
    runtime_safety_hash: state.snapshot.safetyHash,
  };
  return {
    ...withoutHash,
    plan_hash: semanticHash(PLAN_DOMAIN_SEPARATOR, withoutHash),
  } as CompiledScopePlanV2Document;
}

function compileSuccess(
  request: WorkflowCompilerRequest,
  source: JsonObject,
  hash: Sha256Hash,
  snapshot: BoundCompilerSnapshot,
): WorkflowCompilerSuccess {
  const state: CompilationState = {
    snapshot,
    identity: request.identity,
    proofHashes: new Set(),
    programHashes: new Set(),
  };
  let plan: CompiledScopePlanV2Document;
  if (request.sourceKind === 'workflow_definition') {
    validateDefinitionBindings(source, state);
    plan = compileDefinitionPlan(source, state);
  } else if (request.sourceKind === 'graph_scope') {
    validateGraphBindings(source, state);
    validateGraphStructure(source, state);
    plan = compileGraphPlan(source, state);
  } else {
    throw new CompilerDiagnosticError(
      diagnostic(
        'schema_profile_keyword_unsupported',
        'schema',
        '',
        null,
        '#/profile/sourceKind',
      ),
    );
  }
  return {
    sourceHash: hash,
    plan,
    proofHashes: [...state.proofHashes].sort(),
    programHashes: [...state.programHashes].sort(),
    staticLowering: request.sourceKind === 'workflow_definition',
  };
}

export function compileWorkflow(
  request: WorkflowCompilerRequest,
): WorkflowCompilerOutcome {
  let parsed: JsonValue;
  try {
    parsed = strictParseJsonBytes(request.rawSourceBytes);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return reject(
        null,
        diagnostic(
          error.code as CompilerConformanceDiagnosticV1['code'],
          'parse',
          error.pointer,
        ),
      );
    }
    throw error;
  }
  const source = assertSourceObject(parsed);
  const hash = sourceHash(request.sourceKind, source);
  try {
    if (request.sourceKind === 'graph_scope') {
      const interfaceRef = objectRef(source.interface_ref);
      if (interfaceRef) assertPinnedRef(interfaceRef, '/interface_ref');
    }
    const schemaIssue = validateClosedSource(request.sourceKind, source);
    if (schemaIssue) return reject(hash, schemaIssue);
    const snapshot = bindCompilerSnapshot(request.inputSnapshot);
    if (!snapshot.identityMatch) {
      return reject(
        hash,
        diagnostic('compiler_integrity_mismatch', 'hash', ''),
      );
    }
    return { ok: true, value: compileSuccess(request, source, hash, snapshot) };
  } catch (error) {
    if (error instanceof CompilerDiagnosticError) {
      return reject(hash, error.diagnostic);
    }
    throw error;
  }
}
