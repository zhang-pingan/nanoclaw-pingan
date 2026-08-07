import {
  assertJsonObject,
  StrictJsonError,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  CompilerConformanceDiagnosticV1,
  CompiledScopePlanV2Document,
  CompiledStaticChildPlanClosureV1,
  CompiledStaticChildPlanClosureMemberV1,
} from '../contracts/compiler-contract-repair-types.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type { WorkflowCompilerStaticChildPlanBundleEntry } from '../contracts/static-child-plan-bundle-types.js';
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
  schemaAssignable,
} from './proofs.js';
import {
  buildGeneratedSchema,
  buildNodeOutputEnvelopeSchema,
} from '../contracts/generated-schema-authority.js';
import { assertSourceObject, validateClosedSource } from './schema-profile.js';
import {
  bindCompilerSnapshot,
  childPolicy,
  type BoundCompilerSnapshot,
  interfacePlanSnapshot,
  refKey,
  resourceDependencyRefs,
  type SnapshotDependencyClosure,
  type SnapshotResource,
} from './snapshot.js';
import type {
  WorkflowCompilerFailure,
  WorkflowCompilerOutcome,
  WorkflowCompilerRequest,
  WorkflowCompilerSuccess,
  WorkflowCompilerSourceKind,
} from './types.js';
import { WORKFLOW_COMPILER_VERSION } from './version.js';

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
const OUTBOX_ADAPTER_DOMAIN = 'icarus:workflow-outbox-adapter:1\n';
const OUTBOX_POLICY_DOMAIN = 'icarus:workflow-outbox-delivery-policy:1\n';
const OUTBOX_EFFECTIVE_POLICY_SNAPSHOT_DOMAIN =
  'icarus:workflow-outbox-effective-policy-snapshot:1\n';
const CAPABILITY_OUTBOX_BINDING_DOMAIN =
  'icarus:workflow-capability-outbox-execution-binding:1\n';
const COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1 =
  'icarus:workflow-registry-dependency-closure:1\n';

interface CompilationState {
  snapshot: BoundCompilerSnapshot;
  policy: JsonObject;
  policyHash: Sha256Hash;
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

function normalizePolicy(policy: JsonObject): JsonObject {
  const normalized = sortObjectKeys(policy);
  for (const key of [
    'allowed_capabilities',
    'allowed_templates',
    'allowed_interface_refs',
    'allowed_wait_contracts',
    'allowed_child_policy_refs',
  ]) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = [...normalized[key]].sort((left, right) =>
        compareAscii(
          refKey(objectRef(left) ?? {}),
          refKey(objectRef(right) ?? {}),
        ),
      );
    }
  }
  for (const key of ['allowed_node_types', 'allowed_claim_ids']) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = [...normalized[key]].sort((left, right) =>
        compareAscii(String(left), String(right)),
      );
    }
  }
  const effectPolicy = objectRef(normalized.effect_policy);
  if (effectPolicy && Array.isArray(effectPolicy.allowed_recovery_kinds)) {
    effectPolicy.allowed_recovery_kinds = [
      ...effectPolicy.allowed_recovery_kinds,
    ].sort((left, right) => compareAscii(String(left), String(right)));
  }
  return normalized;
}

function intersectLimits(
  inherited: JsonObject,
  requested: JsonObject,
): JsonObject {
  return Object.fromEntries(
    Object.keys(inherited)
      .sort(compareAscii)
      .map((key) => {
        const parent =
          typeof inherited[key] === 'number' ? inherited[key] : null;
        const child =
          typeof requested[key] === 'number' ? requested[key] : null;
        return [
          key,
          parent === null
            ? child
            : child === null
              ? parent
              : Math.min(parent, child),
        ];
      }),
  );
}

function effectivePolicy(
  inherited: JsonObject,
  requestedLimits: JsonObject,
): JsonObject {
  const policy = normalizePolicy(inherited);
  assertJsonObject(policy.limits);
  policy.limits = intersectLimits(policy.limits, requestedLimits);
  return policy;
}

function effectiveChildPolicy(
  parent: JsonObject,
  request: JsonObject,
): JsonObject {
  const normalizedParent = normalizePolicy(parent);
  const normalizedRequest = normalizePolicy(request);
  const intersected = { ...normalizedRequest };
  const parentNodeTypes = new Set(
    (normalizedParent.allowed_node_types as JsonValue[]).map(String),
  );
  intersected.allowed_node_types = (
    normalizedRequest.allowed_node_types as JsonValue[]
  ).filter((entry) => parentNodeTypes.has(String(entry)));
  for (const key of [
    'allowed_capabilities',
    'allowed_templates',
    'allowed_interface_refs',
    'allowed_wait_contracts',
    'allowed_child_policy_refs',
  ]) {
    const parentKeys = new Set(
      (Array.isArray(normalizedParent[key]) ? normalizedParent[key] : []).map(
        (entry) => refKey(objectRef(entry) ?? {}),
      ),
    );
    intersected[key] = (
      Array.isArray(normalizedRequest[key]) ? normalizedRequest[key] : []
    ).filter((entry) => parentKeys.has(refKey(objectRef(entry) ?? {})));
  }
  const parentClaims = new Set(
    (normalizedParent.allowed_claim_ids as JsonValue[]).map(String),
  );
  intersected.allowed_claim_ids = (
    normalizedRequest.allowed_claim_ids as JsonValue[]
  ).filter((entry) => parentClaims.has(String(entry)));
  intersected.allow_early_close =
    normalizedParent.allow_early_close === true &&
    normalizedRequest.allow_early_close === true;
  intersected.allow_indefinite_waits =
    normalizedParent.allow_indefinite_waits === true &&
    normalizedRequest.allow_indefinite_waits === true;
  intersected.limits = intersectLimits(
    normalizedParent.limits as JsonObject,
    normalizedRequest.limits as JsonObject,
  );
  return intersected;
}

function scopedInterfaceHash(interfaceSnapshot: JsonObject): Sha256Hash {
  return semanticHash('icarus:workflow-scope-interface:1\n', interfaceSnapshot);
}

function scopedCatalogHash(
  snapshot: BoundCompilerSnapshot,
  resourceType: string,
  domain: string,
): Sha256Hash {
  return semanticHash(
    domain,
    snapshot.resources
      .filter((resource) => resource.resourceType === resourceType)
      .map((resource) => ({ ref: resource.ref, hash: resource.contentHash }))
      .sort((left, right) => compareAscii(refKey(left.ref), refKey(right.ref))),
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

function dependencyClosurePayload(
  closure: SnapshotDependencyClosure,
): JsonObject {
  return {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: closure.rootResourceType,
    root_ref: closure.rootRef,
    members: closure.members.map((member) => ({
      resource_type: member.resourceType,
      ref: member.ref,
      content_hash: member.contentHash,
    })),
    member_count: closure.memberCount,
  };
}

function validateResourceDependencyClosure(
  root: SnapshotResource,
  sourcePointer: string,
  stableObjectId: string,
  state: CompilationState,
): void {
  const closure = state.snapshot.dependencyClosureByKey.get(
    `${root.resourceType}:${refKey(root.ref)}`,
  );
  if (!closure) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'compiler_integrity_mismatch',
        'hash',
        sourcePointer,
        stableObjectId,
      ),
    );
  }
  const expected = new Map<string, SnapshotResource>();
  const visited = new Set<string>([refKey(root.ref)]);
  const queue = resourceDependencyRefs(root);
  while (queue.length > 0) {
    const dependencyRef = queue.shift() as VersionedRef;
    const key = refKey(dependencyRef);
    if (visited.has(key)) continue;
    visited.add(key);
    const dependency = state.snapshot.resourceByKey.get(key);
    if (!dependency) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'registry_ref_not_found',
          'bind',
          sourcePointer,
          String(dependencyRef.id),
        ),
      );
    }
    expected.set(key, dependency);
    queue.push(...resourceDependencyRefs(dependency));
  }
  const expectedMembers = [...expected.values()]
    .sort((left, right) => compareAscii(refKey(left.ref), refKey(right.ref)))
    .map((resource) => ({
      resource_type: resource.resourceType,
      ref: resource.ref,
      content_hash: resource.contentHash,
    }));
  const actualPayload = dependencyClosurePayload(closure);
  const expectedPayload: JsonObject = {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: root.resourceType,
    root_ref: root.ref,
    members: expectedMembers,
    member_count: expectedMembers.length,
  };
  const expectedHash = domainSeparatedSha256(
    COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1,
    expectedPayload,
  );
  if (
    JSON.stringify(actualPayload) !== JSON.stringify(expectedPayload) ||
    closure.closureHash !== expectedHash ||
    (root.resourceType === 'capability' &&
      root.content.dependency_closure_hash !== expectedHash)
  ) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'compiler_integrity_mismatch',
        'hash',
        sourcePointer,
        stableObjectId,
      ),
    );
  }
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
  if (!refAllowed(source.interface_ref, state.policy.allowed_interface_refs)) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'capability_not_allowed',
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
      !Array.isArray(state.policy.allowed_node_types) ||
      !state.policy.allowed_node_types.includes(node.type)
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
      if (!refAllowed(capabilityRef, state.policy.allowed_capabilities)) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'capability_not_allowed',
            'bind',
            `/nodes/${index}/capability_ref`,
            String(node.id),
          ),
        );
      }
      if (capability.content.node_type !== node.type) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'capability_not_allowed',
            'bind',
            `/nodes/${index}/capability_ref`,
            String(node.id),
          ),
        );
      }
      validateCapabilityContract(
        capability,
        `/nodes/${index}/capability_ref`,
        String(node.id),
        state,
      );
      validateResourceDependencyClosure(
        capability,
        `/nodes/${index}/capability_ref`,
        String(node.id),
        state,
      );
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
      const waitContract = resourceForRef(
        snapshot,
        wait.contract_ref,
        'wait_contract',
      );
      if (!waitContract) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'registry_ref_not_found',
            'bind',
            `/nodes/${index}/wait/contract_ref`,
            String(wait.contract_ref.id),
          ),
        );
      }
      validateResourceDependencyClosure(
        waitContract,
        `/nodes/${index}/wait/contract_ref`,
        String(node.id),
        state,
      );
      if (!refAllowed(wait.contract_ref, state.policy.allowed_wait_contracts)) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'capability_not_allowed',
            'bind',
            `/nodes/${index}/wait/contract_ref`,
            String(node.id),
          ),
        );
      }
    }
    const childPolicyRef = objectRef(node.child_policy_ref);
    if (childPolicyRef)
      validateChildPolicyBinding(childPolicyRef, index, node, state);
  }
  validateRequiredNodeInputs(source, state);
}

function validateCapabilityContract(
  capability: SnapshotResource,
  sourcePointer: string,
  nodeId: string,
  state: CompilationState,
): void {
  const effect = objectRef(capability.content.effect);
  const cancellation = objectRef(capability.content.cancellation);
  const valid =
    (cancellation?.type === 'fence_only' &&
      cancellation.safe_to_abandon === true) ||
    (cancellation?.type === 'cooperative' &&
      cancellation.ack_required_before_close === false &&
      cancellation.safe_if_cancel_lost === true) ||
    (cancellation?.type === 'requires_compensation' &&
      effect?.type === 'compensatable');
  if (!valid) {
    throw new CompilerDiagnosticError(
      diagnostic('capability_not_allowed', 'bind', sourcePointer, nodeId),
    );
  }
  validateCapabilityOutboxContract(capability, sourcePointer, nodeId, state);
}

function keysEqual(value: JsonObject, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort(compareAscii)) ===
    JSON.stringify([...expected].sort(compareAscii))
  );
}

function positiveInteger(value: JsonValue): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function nonnegativeInteger(value: JsonValue): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function capabilityOutboxResources(
  capability: SnapshotResource,
  sourcePointer: string,
  nodeId: string,
  state: CompilationState,
): {
  effect: JsonObject;
  adapter: SnapshotResource;
  policy: SnapshotResource;
} {
  const effect = objectRef(capability.content.outbox_effect);
  if (
    !effect ||
    !keysEqual(effect, [
      'effect_type',
      'adapter_ref',
      'delivery_policy_ref',
      'delivery_lane',
      'reconciliation',
      'idempotency',
      'delivery_requirement',
    ]) ||
    effect.effect_type !== 'capability_dispatch' ||
    effect.delivery_lane !== 'normal_execution' ||
    effect.delivery_requirement !== 'required' ||
    !['provider_key', 'external_lookup'].includes(String(effect.idempotency))
  ) {
    throw new CompilerDiagnosticError(
      diagnostic('capability_not_allowed', 'bind', sourcePointer, nodeId),
    );
  }
  const reconciliation = objectRef(effect.reconciliation);
  const reconciliationValid =
    (reconciliation?.type === 'not_required' &&
      keysEqual(reconciliation, ['type'])) ||
    (reconciliation?.type === 'by_effect_key' &&
      keysEqual(reconciliation, ['type', 'reconcile_action_ref']) &&
      objectRef(reconciliation.reconcile_action_ref) !== null);
  if (!reconciliationValid) {
    throw new CompilerDiagnosticError(
      diagnostic('capability_not_allowed', 'bind', sourcePointer, nodeId),
    );
  }
  const adapterRef = objectRef(effect.adapter_ref);
  const policyRef = objectRef(effect.delivery_policy_ref);
  if (!adapterRef || !policyRef) {
    throw new CompilerDiagnosticError(
      diagnostic('capability_not_allowed', 'bind', sourcePointer, nodeId),
    );
  }
  assertPinnedRef(
    adapterRef,
    `${sourcePointer}/outbox_effect/adapter_ref`,
    nodeId,
  );
  assertPinnedRef(
    policyRef,
    `${sourcePointer}/outbox_effect/delivery_policy_ref`,
    nodeId,
  );
  const adapter = resourceForRef(state.snapshot, adapterRef, 'outbox_adapter');
  const policy = resourceForRef(state.snapshot, policyRef, 'outbox_policy');
  if (!adapter || !policy) {
    throw new CompilerDiagnosticError(
      diagnostic('registry_ref_not_found', 'bind', sourcePointer, nodeId),
    );
  }
  if (
    adapter.publicationState !== 'published' ||
    policy.publicationState !== 'published'
  ) {
    throw new CompilerDiagnosticError(
      diagnostic('capability_not_allowed', 'bind', sourcePointer, nodeId),
    );
  }
  return { effect, adapter, policy };
}

function validateCapabilityOutboxContract(
  capability: SnapshotResource,
  sourcePointer: string,
  nodeId: string,
  state: CompilationState,
): void {
  const { effect, adapter, policy } = capabilityOutboxResources(
    capability,
    sourcePointer,
    nodeId,
    state,
  );
  const adapterContent = adapter.content;
  const { adapter_hash: adapterHash, ...adapterWithoutHash } = adapterContent;
  const adapterValid =
    adapterContent.format === 'icarus.workflow-outbox-adapter/1' &&
    objectRef(adapterContent.ref) !== null &&
    versionedRefsEqual(adapterContent.ref as JsonObject, adapter.ref) &&
    adapterHash ===
      semanticHash(OUTBOX_ADAPTER_DOMAIN, adapterWithoutHash as JsonObject) &&
    Array.isArray(adapterContent.supported_effect_types) &&
    adapterContent.supported_effect_types.includes(effect.effect_type) &&
    Array.isArray(adapterContent.supported_delivery_lanes) &&
    adapterContent.supported_delivery_lanes.includes(effect.delivery_lane) &&
    Array.isArray(adapterContent.supported_reconciliation) &&
    adapterContent.supported_reconciliation.includes(
      (effect.reconciliation as JsonObject).type,
    ) &&
    Array.isArray(adapterContent.supported_idempotency) &&
    adapterContent.supported_idempotency.includes(effect.idempotency);
  const policyContent = policy.content;
  const { policy_hash: policyHash, ...policyWithoutHash } = policyContent;
  const retryable = policyContent.retryable_error_codes;
  const permanent = policyContent.permanent_error_codes;
  const policyValid =
    policyContent.format === 'icarus.workflow-outbox-delivery-policy/1' &&
    objectRef(policyContent.ref) !== null &&
    versionedRefsEqual(policyContent.ref as JsonObject, policy.ref) &&
    policyHash ===
      semanticHash(OUTBOX_POLICY_DOMAIN, policyWithoutHash as JsonObject) &&
    positiveInteger(policyContent.max_delivery_attempts) &&
    nonnegativeInteger(policyContent.max_reconcile_attempts) &&
    positiveInteger(policyContent.delivery_duration_ms) &&
    positiveInteger(policyContent.attempt_timeout_ms) &&
    policyContent.attempt_timeout_ms <= policyContent.delivery_duration_ms &&
    nonnegativeInteger(policyContent.initial_backoff_ms) &&
    nonnegativeInteger(policyContent.max_backoff_ms) &&
    policyContent.initial_backoff_ms <= policyContent.max_backoff_ms &&
    ['fixed', 'exponential'].includes(String(policyContent.backoff)) &&
    nonnegativeInteger(policyContent.deterministic_jitter_micros) &&
    policyContent.deterministic_jitter_micros <= 1_000_000 &&
    typeof policyContent.honor_retry_after === 'boolean' &&
    Array.isArray(retryable) &&
    Array.isArray(permanent) &&
    retryable.every((code) => typeof code === 'string') &&
    permanent.every((code) => typeof code === 'string') &&
    new Set(retryable).size === retryable.length &&
    new Set(permanent).size === permanent.length &&
    retryable.every((code) => !permanent.includes(code));
  if (!adapterValid || !policyValid) {
    throw new CompilerDiagnosticError(
      diagnostic('compiler_integrity_mismatch', 'hash', sourcePointer, nodeId),
    );
  }
}

function nodeInputContracts(
  node: JsonObject,
  state: CompilationState,
): JsonObject {
  const capabilityRef = objectRef(node.capability_ref);
  if (capabilityRef) {
    const capability = resourceForRef(
      state.snapshot,
      capabilityRef,
      'capability',
    );
    if (!capability) return {};
    assertJsonObject(capability.content.input_ports);
    return capability.content.input_ports;
  }
  const wait = objectRef(node.wait);
  if (wait) {
    const contractRef = objectRef(wait.contract_ref);
    const contract = contractRef
      ? resourceForRef(state.snapshot, contractRef, 'wait_contract')
      : null;
    if (!contract) return {};
    assertJsonObject(contract.content.input_ports);
    return contract.content.input_ports;
  }
  return objectRef(node.input_ports) ?? {};
}

function validateRequiredNodeInputs(
  source: JsonObject,
  state: CompilationState,
): void {
  const edges = dataEdges(source);
  for (const [nodeIndex, node] of graphNodes(source).entries()) {
    const ports = nodeInputContracts(node, state);
    for (const [portName, contractValue] of Object.entries(ports)) {
      assertJsonObject(contractValue);
      const aggregation = objectRef(contractValue.aggregation);
      if (!aggregation || aggregation.type !== 'single') continue;
      const sources = edges.filter((edge) => {
        const target = objectRef(edge.to);
        return target?.node_id === node.id && target.port === portName;
      });
      if (aggregation.select === 'only' && sources.length > 1) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'schema_not_assignable',
            'bind',
            `/nodes/${nodeIndex}`,
            String(node.id),
          ),
        );
      }
      if (
        aggregation.required === true &&
        aggregation.default === undefined &&
        sources.length === 0
      ) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'schema_not_assignable',
            'bind',
            `/nodes/${nodeIndex}`,
            String(node.id),
          ),
        );
      }
    }
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
  state: CompilationState,
): void {
  const binding = childPolicy(state.snapshot, ref);
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
  if (!refAllowed(ref, state.policy.allowed_child_policy_refs)) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'policy_escalation',
        'bind',
        `/nodes/${index}/child_policy_ref`,
        String(node.id),
      ),
    );
  }
  const request = binding.request;
  const root = state.policy;
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
  if (!nodes.some((node) => node.type === 'terminal')) {
    throw new CompilerDiagnosticError(
      diagnostic(
        'completion_contract_invalid',
        'prove',
        '/nodes',
        String(source.scope_key),
      ),
    );
  }
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
      if (capability.content.node_type !== value.type) {
        throw new CompilerDiagnosticError(
          diagnostic(
            'capability_not_allowed',
            'bind',
            `/states/${stateKey}/capability_ref`,
            stateKey,
          ),
        );
      }
      validateCapabilityContract(
        capability,
        `/states/${stateKey}/capability_ref`,
        stateKey,
        state,
      );
      validateResourceDependencyClosure(
        capability,
        `/states/${stateKey}/capability_ref`,
        stateKey,
        state,
      );
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
    validateResourceDependencyClosure(
      owningRecipe,
      '/ref',
      String(owningRecipe.ref.id),
      state,
    );
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
  const cycleStart = findRecipeCycle(state.snapshot, owningRecipes);
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
  for (const name of ['on_error', 'on_local_cancel', 'on_temporary_replan']) {
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
): JsonObject {
  assertJsonObject(policy.limits);
  return intersectLimits(policy.limits, requested);
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
        const compiled: JsonObject = {
          schema: compiledSchema(snapshot, contract.schema_ref),
          max_bytes: contract.max_bytes,
          aggregation: contract.aggregation,
        };
        assertJsonObject(contract.aggregation);
        if (contract.aggregation.type === 'list') {
          assertJsonObject(contract.item_contract);
          assertJsonObject(contract.item_contract.schema_ref);
          compiled.item_schema = compiledSchema(
            snapshot,
            contract.item_contract.schema_ref,
          );
          compiled.item_max_bytes = contract.item_contract.max_bytes;
        }
        return [name, compiled];
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
            max_bytes: contract.max_bytes,
            required: contract.required,
          },
        ];
      }),
  );
}

function generatedCompiledSchema(
  generator: 'child_completion' | 'map_result',
  childInterface: JsonObject,
  compilerVersion: string,
): JsonObject {
  assertJsonObject(childInterface.exits);
  const exits = Object.keys(childInterface.exits).sort(compareAscii);
  const parameters = {
    generator,
    child_interface_ref: childInterface.ref,
    exits,
  } as JsonObject;
  const schemaJson: JsonObject =
    compilerVersion === '3.0.6'
      ? generator === 'child_completion'
        ? childCompletionSchema(exits)
        : mapResultSchema()
      : generator === 'child_completion'
        ? {
            type: 'object',
            additionalProperties: false,
            required: ['exit', 'output_ports'],
            properties: {
              exit: { type: 'string', enum: exits },
              output_ports: { type: 'object' },
            },
          }
        : {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item_index', 'outcome'],
              properties: {
                item_index: { type: 'integer', minimum: 0 },
                outcome: {
                  type: 'string',
                  enum: ['completed', 'errored', 'cancelled'],
                },
              },
            },
          };
  return buildGeneratedSchema(generator, parameters, schemaJson);
}

function childCompletionSchema(exits: string[]): JsonObject {
  const hash = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'scope_id',
      'exit',
      'output_envelope_ref',
      'output_envelope_hash',
      'plan_hash',
      'cut_event_seq',
    ],
    properties: {
      scope_id: { type: 'string', minLength: 1 },
      exit: { type: 'string', enum: exits },
      output_envelope_ref: { type: 'string', minLength: 1 },
      output_envelope_hash: hash,
      plan_hash: hash,
      cut_event_seq: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

function registrySchemaJson(
  schema: JsonObject,
  snapshot: BoundCompilerSnapshot,
): JsonObject {
  if (schema.type !== 'registry') {
    throw new Error(
      'Join input schema must be compiled from Registry authority',
    );
  }
  assertJsonObject(schema.ref);
  const resource = resourceForRef(snapshot, schema.ref, 'schema');
  if (!resource) throw new Error('Join input schema binding disappeared');
  return resource.content;
}

function joinOutputPorts(
  node: JsonObject,
  state: CompilationState,
): JsonObject {
  const inputs = compileInputPorts(
    objectRef(node.input_ports) ?? {},
    state.snapshot,
  );
  const expose = objectRef(node.expose) ?? {};
  return Object.fromEntries(
    Object.keys(expose)
      .sort(compareAscii)
      .map((outputName) => {
        const binding = expose[outputName];
        assertJsonObject(binding);
        const inputName = String(binding.input_port);
        const input = inputs[inputName];
        if (!input || Array.isArray(input) || typeof input !== 'object') {
          throw new CompilerDiagnosticError(
            diagnostic(
              'schema_not_assignable',
              'bind',
              '/nodes',
              String(node.id),
            ),
          );
        }
        assertJsonObject(input.schema);
        assertJsonObject(input.aggregation);
        const required =
          input.aggregation.type === 'list' ||
          input.aggregation.required === true ||
          Object.hasOwn(input.aggregation, 'default');
        const parameters: JsonObject = {
          node_id: node.id,
          output_port: outputName,
          input_port: inputName,
          input_schema: input.schema,
          aggregation: input.aggregation,
          max_bytes: input.max_bytes,
          required,
          ...(input.aggregation.type === 'list'
            ? {
                item_schema: input.item_schema,
                item_max_bytes: input.item_max_bytes,
              }
            : {}),
        };
        return [
          outputName,
          {
            schema: buildGeneratedSchema(
              'join_expose',
              parameters,
              registrySchemaJson(input.schema, state.snapshot),
            ),
            max_bytes: input.max_bytes,
            required,
          },
        ];
      }),
  );
}

function childOwnerOutputPorts(
  node: JsonObject,
  childInterface: JsonObject,
  state: CompilationState,
): JsonObject {
  assertJsonObject(state.snapshot.safety.value);
  const completionPort = String(node.completion_output_port);
  const output: JsonObject = {
    [completionPort]: {
      schema: generatedCompiledSchema(
        'child_completion',
        childInterface,
        WORKFLOW_COMPILER_VERSION,
      ),
      max_bytes: Number(state.snapshot.safety.value.max_single_value_bytes),
      required: true,
    },
  };
  const expose = objectRef(node.expose) ?? {};
  assertJsonObject(childInterface.exits);
  for (const [portName, exposeValue] of Object.entries(expose)) {
    if (portName === completionPort) {
      throw new CompilerDiagnosticError(
        diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
      );
    }
    assertJsonObject(exposeValue);
    const exit = childInterface.exits[String(exposeValue.from_exit)];
    assertJsonObject(exit);
    assertJsonObject(exit.output_ports);
    const childPort = exit.output_ports[String(exposeValue.child_port)];
    assertJsonObject(childPort);
    assertJsonObject(childPort.schema_ref);
    output[portName] = {
      schema: compiledSchema(state.snapshot, childPort.schema_ref),
      max_bytes:
        typeof childPort.max_bytes === 'number' ? childPort.max_bytes : null,
      required: exposeValue.required === true,
    };
  }
  return output;
}

function mapResultSchema(): JsonObject {
  const hash = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'expansion_manifest_ref',
      'expansion_manifest_hash',
      'completion_policy_hash',
      'selected_indices',
      'item_results_manifest_ref',
      'item_results_manifest_hash',
      'item_count',
    ],
    properties: {
      expansion_manifest_ref: { type: 'string', minLength: 1 },
      expansion_manifest_hash: hash,
      completion_policy_hash: hash,
      selected_indices: {
        type: 'array',
        items: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      item_results_manifest_ref: { type: 'string', minLength: 1 },
      item_results_manifest_hash: hash,
      item_count: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

function mapOwnerOutputPorts(
  node: JsonObject,
  childInterface: JsonObject,
  state: CompilationState,
): JsonObject {
  assertJsonObject(state.snapshot.safety.value);
  const resultPort = String(node.result_output_port);
  return {
    [resultPort]: {
      schema: generatedCompiledSchema(
        'map_result',
        childInterface,
        WORKFLOW_COMPILER_VERSION,
      ),
      max_bytes: Number(state.snapshot.safety.value.max_single_value_bytes),
      required: true,
    },
  };
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
      'icarus:workflow-graph-node-source:1\n',
      node,
    ),
    trigger_program: triggerProgram,
    input_ports: compileInputPorts(inputPorts, state.snapshot),
    output_ports: compileOutputPorts(outputPorts, state.snapshot),
    effective_limits: {},
  };
}

function effectiveRetryPolicy(
  node: JsonObject,
  capability: SnapshotResource,
  state: CompilationState,
): JsonObject {
  assertJsonObject(capability.content.retry_policy);
  assertJsonObject(state.snapshot.safety.value);
  assertJsonObject(state.snapshot.safety.execution);
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
      effective_max_feedback_bytes: minimumLimit(
        Number(revision.max_feedback_bytes),
        Number(state.snapshot.safety.value.max_single_value_bytes),
      ),
      context_mode: revision.context_mode,
    };
  }
  const requested = objectRef(node.retry_request);
  const withoutHash = {
    effective_node_max_attempts: minimumLimit(
      Number(capability.content.retry_policy.max_attempts),
      requested && typeof requested.max_attempts === 'number'
        ? requested.max_attempts
        : null,
      Number(state.snapshot.safety.execution.max_attempts_per_node),
    ),
    effective_retry_on:
      requested?.retry_on ?? capability.content.retry_policy.retry_on,
    backoff: capability.content.retry_policy.backoff,
    quality_revision: qualityRevision,
  };
  return {
    ...withoutHash,
    policy_hash: semanticHash(
      'icarus:workflow-capability-retry-policy:1\n',
      withoutHash,
    ),
  };
}

function compileCapabilityOutboxBinding(
  capability: SnapshotResource,
  state: CompilationState,
): JsonObject {
  const { effect, adapter, policy } = capabilityOutboxResources(
    capability,
    '/capability_ref',
    String(capability.ref.id),
    state,
  );
  assertJsonObject(state.snapshot.safety.execution);
  const executionSafety = state.snapshot.safety.execution;
  const policyContent = policy.content;
  const effectiveDeliveryDurationMs = Math.min(
    Number(policyContent.delivery_duration_ms),
    Number(executionSafety.max_outbox_delivery_duration_ms),
  );
  const effectiveMaxBackoffMs = Math.min(
    Number(policyContent.max_backoff_ms),
    Number(executionSafety.max_retry_backoff_ms),
  );
  const effectivePolicy: JsonObject = {
    max_delivery_attempts: Math.min(
      Number(policyContent.max_delivery_attempts),
      Number(executionSafety.max_outbox_attempts_per_message),
    ),
    max_reconcile_attempts: Math.min(
      Number(policyContent.max_reconcile_attempts),
      Number(executionSafety.max_outbox_reconcile_attempts_per_message),
    ),
    delivery_duration_ms: effectiveDeliveryDurationMs,
    attempt_timeout_ms: Math.min(
      Number(policyContent.attempt_timeout_ms),
      Number(executionSafety.max_outbox_attempt_duration_ms),
      effectiveDeliveryDurationMs,
    ),
    initial_backoff_ms: Math.min(
      Number(policyContent.initial_backoff_ms),
      effectiveMaxBackoffMs,
    ),
    max_backoff_ms: effectiveMaxBackoffMs,
    backoff: policyContent.backoff,
    deterministic_jitter_micros: policyContent.deterministic_jitter_micros,
    honor_retry_after: policyContent.honor_retry_after,
    retryable_error_codes: policyContent.retryable_error_codes,
    permanent_error_codes: policyContent.permanent_error_codes,
  };
  const snapshotWithoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-effective-policy-snapshot/1',
    source_policy_ref: policy.ref,
    source_policy_content_hash: policy.contentHash,
    source_policy_hash: policyContent.policy_hash,
    effective_policy: effectivePolicy,
    runtime_safety_hash: state.snapshot.safetyHash,
  };
  const effectivePolicySnapshot: JsonObject = {
    ...snapshotWithoutHash,
    snapshot_hash: semanticHash(
      OUTBOX_EFFECTIVE_POLICY_SNAPSHOT_DOMAIN,
      snapshotWithoutHash,
    ),
  };
  const withoutHash: JsonObject = {
    effect_contract: effect,
    adapter_identity: {
      resource_type: 'outbox_adapter',
      ref: adapter.ref,
      content_hash: adapter.contentHash,
    },
    delivery_policy_identity: {
      resource_type: 'outbox_policy',
      ref: policy.ref,
      content_hash: policy.contentHash,
    },
    effective_policy_snapshot: effectivePolicySnapshot,
  };
  return {
    ...withoutHash,
    binding_hash: semanticHash(CAPABILITY_OUTBOX_BINDING_DOMAIN, withoutHash),
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
  assertJsonObject(capability.content.retry_policy);
  assertJsonObject(state.snapshot.safety.execution);
  const requested = objectRef(node.retry_request);
  const maxAttempts = minimumLimit(
    Number(capability.content.retry_policy.max_attempts),
    requested && typeof requested.max_attempts === 'number'
      ? requested.max_attempts
      : null,
    Number(state.snapshot.safety.execution.max_attempts_per_node),
  );
  const timeoutMs = Math.min(
    typeof node.timeout_ms === 'number'
      ? node.timeout_ms
      : Number(capability.content.timeout_ceiling_ms),
    Number(state.snapshot.safety.execution.max_attempt_duration_ms),
  );
  return {
    ...base,
    effective_limits: {
      max_attempts: maxAttempts,
      timeout_ms: timeoutMs,
    },
    capability_binding: capability.content,
    outbox_execution_binding: compileCapabilityOutboxBinding(capability, state),
    effective_retry_policy: effectiveRetryPolicy(node, capability, state),
  };
}

interface FactoryCompilation {
  binding: JsonObject;
  childPlan: CompiledScopePlanV2Document;
  staticChildPlans: WorkflowCompilerStaticChildPlanBundleEntry[];
  scopeKey: string;
  sourceHash: Sha256Hash;
  sourceRef: VersionedRef | null;
  kind: 'inline' | 'template';
}

function compileFactory(
  factory: JsonObject,
  ownerPath: string[],
  state: CompilationState,
  childPolicyRef: JsonObject,
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
    sourceSnapshotRef = 'inline:pending';
  }
  const policyBinding = childPolicy(state.snapshot, childPolicyRef);
  if (!policyBinding) throw new Error('Child policy binding disappeared');
  const childEffectivePolicy = effectiveChildPolicy(
    state.policy,
    policyBinding.request,
  );
  const childState: CompilationState = {
    ...state,
    policy: childEffectivePolicy,
    policyHash: semanticHash(
      'icarus:workflow-effective-child-policy:1\n',
      childEffectivePolicy,
    ),
    proofHashes: new Set(),
    programHashes: new Set(),
  };
  validateGraphBindings(childSource, childState);
  validateGraphStructure(childSource, childState);
  const childCompilation = compileGraphPlan(childSource, childState, ownerPath);
  const childPlan = childCompilation.plan;
  const hash = sourceHash('graph_scope', childSource);
  if (factory.type === 'inline') sourceSnapshotRef = `inline:${hash}`;
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
    staticChildPlans: [
      {
        closureKey: ownerPath.join('/'),
        source: childSource,
        plan: childPlan,
      },
      ...childCompilation.staticChildPlans,
    ],
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
  const effective = effectiveChildPolicy(state.policy, binding.request);
  return {
    profile_ref: binding.profile,
    effective_policy_snapshot: effective,
    effective_policy_hash: semanticHash(
      'icarus:workflow-child-policy-binding:1\n',
      effective,
    ),
  };
}

function compileGraphNodeCore(
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
    const maxDuration = minimumLimit(
      typeof node.wait.timeout_ms === 'number' ? node.wait.timeout_ms : null,
      Number(state.snapshot.safety.wait.max_finite_wait_duration_ms),
    );
    return {
      ...base,
      effective_limits: { max_wait_duration_ms: maxDuration },
      wait_binding: {
        ...node.wait,
        contract_snapshot: contract.content,
        effective_max_duration_ms: maxDuration,
      },
    };
  }
  if (node.type === 'join') {
    return {
      ...base,
      output_ports: joinOutputPorts(node, state),
      expose: node.expose,
    };
  }
  if (node.type === 'subgraph') {
    assertJsonObject(state.snapshot.safety.scope);
    assertJsonObject(node.scope);
    assertJsonObject(node.child_policy_ref);
    const factory = compileFactory(
      node.scope,
      [...ownerPath, String(node.id)],
      state,
      node.child_policy_ref,
    );
    validateChildInputBindings(node, factory.childPlan.interface_snapshot);
    factoryByNode.set(String(node.id), factory);
    return {
      ...base,
      output_ports: childOwnerOutputPorts(
        node,
        factory.childPlan.interface_snapshot,
        state,
      ),
      factory_binding: factory.binding,
      child_input_bindings: node.child_input_bindings,
      completion_output_port: node.completion_output_port,
      expose: node.expose,
      child_policy: compiledChildPolicy(node.child_policy_ref, state),
      effective_limits: {
        max_nesting_depth: Number(
          state.snapshot.safety.scope.max_nesting_depth,
        ),
      },
    };
  }
  if (node.type === 'expand') {
    assertJsonObject(state.snapshot.safety.scope);
    assertJsonObject(node.child_interface_ref);
    assertJsonObject(node.child_policy_ref);
    const childInterface = state.snapshot.interfaceByKey.get(
      refKey(node.child_interface_ref),
    );
    if (!childInterface) throw new Error('Expand child interface disappeared');
    if (
      !refAllowed(node.child_interface_ref, state.policy.allowed_interface_refs)
    ) {
      throw new CompilerDiagnosticError(
        diagnostic('capability_not_allowed', 'bind', '/nodes', String(node.id)),
      );
    }
    validateChildInputBindings(node, childInterface);
    return {
      ...base,
      output_ports: childOwnerOutputPorts(node, childInterface, state),
      graph_spec_input_port: node.graph_spec_input_port,
      child_interface_snapshot: interfacePlanSnapshot(childInterface),
      child_input_bindings: node.child_input_bindings,
      completion_output_port: node.completion_output_port,
      expose: node.expose,
      child_policy: compiledChildPolicy(node.child_policy_ref, state),
      effective_limits: {
        max_nesting_depth: Number(
          state.snapshot.safety.scope.max_nesting_depth,
        ),
        max_scope_spec_bytes: Number(
          state.snapshot.safety.scope.max_scope_spec_bytes,
        ),
      },
    };
  }
  if (node.type === 'map') {
    assertJsonObject(node.body);
    assertJsonObject(node.child_policy_ref);
    const factory = compileFactory(
      node.body,
      [...ownerPath, String(node.id)],
      state,
      node.child_policy_ref,
    );
    validateMapChildBinding(node, factory.childPlan.interface_snapshot, state);
    factoryByNode.set(String(node.id), factory);
    assertJsonObject(state.snapshot.safety.map);
    assertJsonObject(state.snapshot.safety.scope);
    return {
      ...base,
      output_ports: mapOwnerOutputPorts(
        node,
        factory.childPlan.interface_snapshot,
        state,
      ),
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
      effective_limits: {
        max_items: minimumLimit(
          typeof node.requested_max_items === 'number'
            ? node.requested_max_items
            : null,
          Number(state.snapshot.safety.map.max_items_per_map),
        ),
        child_concurrency: minimumLimit(
          typeof node.requested_child_concurrency === 'number'
            ? node.requested_child_concurrency
            : null,
          Number(state.snapshot.safety.map.max_child_concurrency_per_map),
        ),
        max_nesting_depth: Number(
          state.snapshot.safety.scope.max_nesting_depth,
        ),
      },
    };
  }
  throw new Error(`Unsupported compiled node type: ${String(node.type)}`);
}

function compileGraphNode(
  node: JsonObject,
  state: CompilationState,
  ownerPath: string[],
  factoryByNode: Map<string, FactoryCompilation>,
): JsonObject {
  const compiled = compileGraphNodeCore(node, state, ownerPath, factoryByNode);
  assertJsonObject(compiled.output_ports);
  return {
    ...compiled,
    output_envelope_schema: buildNodeOutputEnvelopeSchema(
      String(compiled.id),
      compiled.output_ports,
    ),
  };
}

function validateChildInputBindings(
  node: JsonObject,
  childInterface: JsonObject,
): void {
  assertJsonObject(childInterface.inputs);
  const bindings = objectRef(node.child_input_bindings) ?? {};
  for (const [name, value] of Object.entries(childInterface.inputs)) {
    assertJsonObject(value);
    if (
      value.required === true &&
      value.default === undefined &&
      !(name in bindings)
    ) {
      throw new CompilerDiagnosticError(
        diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
      );
    }
  }
  for (const name of Object.keys(bindings)) {
    if (!(name in childInterface.inputs)) {
      throw new CompilerDiagnosticError(
        diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
      );
    }
  }
}

function validateMapChildBinding(
  node: JsonObject,
  childInterface: JsonObject,
  state: CompilationState,
): void {
  assertJsonObject(childInterface.inputs);
  const itemPort = String(node.item_child_input_port);
  if (!(itemPort in childInterface.inputs)) {
    throw new CompilerDiagnosticError(
      diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
    );
  }
  const inputPorts = objectRef(node.input_ports) ?? {};
  const itemsContract = inputPorts[String(node.items_input_port)];
  const childItemContract = childInterface.inputs[itemPort];
  assertJsonObject(itemsContract);
  assertJsonObject(childItemContract);
  assertJsonObject(itemsContract.schema_ref);
  assertJsonObject(childItemContract.schema_ref);
  const itemsSchema = resourceForRef(
    state.snapshot,
    itemsContract.schema_ref,
    'schema',
  );
  const childItemSchema = resourceForRef(
    state.snapshot,
    childItemContract.schema_ref,
    'schema',
  );
  const itemSchema = itemsSchema ? objectRef(itemsSchema.content.items) : null;
  if (
    !itemsSchema ||
    itemsSchema.content.type !== 'array' ||
    !itemSchema ||
    !childItemSchema ||
    !schemaAssignable(itemSchema, childItemSchema.content)
  ) {
    throw new CompilerDiagnosticError(
      diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
    );
  }
  const shared = objectRef(node.shared_child_input_bindings) ?? {};
  for (const [name, value] of Object.entries(childInterface.inputs)) {
    if (name === itemPort) continue;
    assertJsonObject(value);
    if (
      value.required === true &&
      value.default === undefined &&
      !(name in shared)
    ) {
      throw new CompilerDiagnosticError(
        diagnostic('schema_not_assignable', 'bind', '/nodes', String(node.id)),
      );
    }
  }
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
    state.policy,
  );
  assertJsonObject(state.snapshot.safety.reconciliation);
  const maxConditionSteps =
    typeof limits.max_condition_steps === 'number'
      ? limits.max_condition_steps
      : Number(
          state.snapshot.safety.reconciliation
            .max_condition_steps_per_evaluation,
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
            maxConditionSteps,
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
          'icarus:workflow-compiled-control-edge:1\n',
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
  compiledNodes: JsonObject[],
): JsonObject[] {
  const nodes = new Map(compiledNodes.map((node) => [String(node.id), node]));
  return dataEdges(source)
    .map((edge, index) => {
      let compiled;
      try {
        compiled = compileCompatibilityProof(
          edge,
          nodes,
          state.snapshot,
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
          'icarus:workflow-compiled-data-edge:1\n',
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
        const fact = sortObjectKeys(value.when);
        const selector = sortObjectKeys(value.select);
        const factProgramWithoutHash = {
          normalized_fact_expression: fact,
          max_steps: expressionSteps(fact),
        };
        const factProgramHash = semanticHash(
          'icarus:workflow-completion-fact-program:1\n',
          factProgramWithoutHash,
        );
        state.programHashes.add(factProgramHash);
        const selectorHash = semanticHash(
          'icarus:workflow-completion-selector:1\n',
          selector,
        );
        const early = value.phase === 'early';
        const monotonicityDetail = {
          rule_id: value.id,
          normalized_fact_expression: fact,
        };
        const monotonicityProof = early
          ? {
              algorithm_version: '2.0.0',
              classification: 'monotone',
              proof_detail_ref: `inline:completion-monotonicity:${String(value.id)}`,
              proof_detail_hash: semanticHash(
                'icarus:workflow-completion-monotonicity-detail:1\n',
                monotonicityDetail,
              ),
              proof_hash: semanticHash(
                'icarus:workflow-completion-monotonicity-proof:1\n',
                monotonicityDetail,
              ),
            }
          : null;
        const coveredContracts = early
          ? graphNodes(source)
              .map((node) => objectRef(node.capability_ref))
              .filter((ref): ref is JsonObject => ref !== null)
              .map((ref) => resourceForRef(state.snapshot, ref, 'capability'))
              .filter(
                (resource): resource is SnapshotResource => resource !== null,
              )
              .map((resource) => resource.contentHash)
              .sort()
          : [];
        const cancellationDetail = {
          rule_id: value.id,
          covered_node_contract_hashes: coveredContracts,
          valid_contract_model: 'fence_or_cooperative_or_compensation_barrier',
        };
        const cancellationSafetyProof = early
          ? {
              algorithm_version: '3.0.0',
              covered_node_contract_hashes: coveredContracts,
              proof_detail_ref: `inline:cancellation-safety:${String(value.id)}`,
              proof_detail_hash: semanticHash(
                'icarus:workflow-cancellation-safety-detail:1\n',
                cancellationDetail,
              ),
              proof_hash: semanticHash(
                'icarus:workflow-cancellation-safety-proof:1\n',
                cancellationDetail,
              ),
            }
          : null;
        if (monotonicityProof) {
          state.proofHashes.add(monotonicityProof.proof_hash);
        }
        if (cancellationSafetyProof) {
          state.proofHashes.add(cancellationSafetyProof.proof_hash);
        }
        const withoutHash = {
          id: value.id,
          phase: value.phase,
          normalized_fact_expression: fact,
          fact_program_hash: factProgramHash,
          max_steps: expressionSteps(fact),
          selector,
          selector_contract_hash: selectorHash,
          priority:
            typeof value.priority === 'number'
              ? value.priority
              : Number(value.same_event_priority),
          monotonicity_proof: monotonicityProof,
          cancellation_safety_proof: cancellationSafetyProof,
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
    plan_ref: `content-addressed:workflow-plan/${String(factory.childPlan.plan_hash).slice(7)}`,
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
  ownerPath: string[],
): CompiledStaticChildPlanClosureV1 {
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
      members.push(child);
    }
  };
  for (const node of graphNodes(source).sort(compareStableId)) {
    const factory = factoryByNode.get(String(node.id));
    if (factory) {
      const path = [...ownerPath, String(node.id)];
      append(
        String(node.id),
        factory,
        ownerPath.length > 0 ? ownerPath.join('/') : null,
        path,
      );
    }
  }
  const withoutHash = { members, member_count: members.length };
  return {
    ...withoutHash,
    closure_hash: semanticHash(STATIC_CLOSURE_DOMAIN_SEPARATOR, withoutHash),
  } as CompiledStaticChildPlanClosureV1;
}

function complexitySummary(
  nodes: JsonObject[],
  controls: JsonObject[],
  data: JsonObject[],
  completion: JsonObject,
  frontierBytes: number,
): JsonObject {
  const fanOut = new Map<string, number>();
  for (const edge of [...controls, ...data]) {
    const source = String(
      edge.from_node_id ?? objectRef(edge.from)?.node_id ?? '',
    );
    if (!source) continue;
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
    max_reconcile_facts_per_ingress:
      nodes.length + controls.length + data.length,
    max_frontier_bytes: frontierBytes,
  };
  return {
    ...withoutHash,
    summary_hash: semanticHash(
      'icarus:workflow-compiled-complexity-summary:1\n',
      withoutHash,
    ),
  };
}

function compileLiteralExpandCandidates(
  source: JsonObject,
  state: CompilationState,
): void {
  const edges = dataEdges(source);
  for (const node of graphNodes(source)) {
    if (node.type !== 'expand') continue;
    const candidateEdge = edges.find((edge) => {
      const target = objectRef(edge.to);
      return (
        target?.node_id === node.id &&
        target.port === node.graph_spec_input_port
      );
    });
    const from = candidateEdge ? objectRef(candidateEdge.from) : null;
    const candidate = from?.type === 'literal' ? objectRef(from.value) : null;
    if (!candidate) continue;
    assertJsonObject(node.child_interface_ref);
    assertJsonObject(node.child_policy_ref);
    assertJsonObject(candidate.interface_ref);
    if (
      !versionedRefsEqual(candidate.interface_ref, node.child_interface_ref)
    ) {
      throw new CompilerDiagnosticError(
        diagnostic(
          'schema_not_assignable',
          'bind',
          '/data_edges',
          String(node.id),
        ),
      );
    }
    const policyBinding = childPolicy(state.snapshot, node.child_policy_ref);
    if (!policyBinding) throw new Error('Expand child policy disappeared');
    const childEffectivePolicy = effectiveChildPolicy(
      state.policy,
      policyBinding.request,
    );
    const childState: CompilationState = {
      ...state,
      policy: childEffectivePolicy,
      policyHash: semanticHash(
        'icarus:workflow-effective-child-policy:1\n',
        childEffectivePolicy,
      ),
      proofHashes: new Set(),
      programHashes: new Set(),
    };
    validateGraphBindings(candidate, childState);
    validateGraphStructure(candidate, childState);
    compileGraphPlan(candidate, childState);
  }
}

interface CompiledGraphPlanResult {
  plan: CompiledScopePlanV2Document;
  staticChildPlans: WorkflowCompilerStaticChildPlanBundleEntry[];
}

function compileGraphPlan(
  source: JsonObject,
  state: CompilationState,
  ownerPath: string[] = [],
): CompiledGraphPlanResult {
  assertJsonObject(source.interface_ref);
  assertJsonObject(source.requested_limits);
  const planPolicy = effectivePolicy(state.policy, source.requested_limits);
  const planState: CompilationState = {
    ...state,
    policy: planPolicy,
    policyHash: semanticHash(
      'icarus:workflow-effective-policy:1\n',
      planPolicy,
    ),
  };
  const interfaceEntry = state.snapshot.interfaceByKey.get(
    refKey(source.interface_ref),
  );
  if (!interfaceEntry) throw new Error('Graph interface binding disappeared');
  const interfaceSnapshot = interfacePlanSnapshot(interfaceEntry);
  compileLiteralExpandCandidates(source, planState);
  const factoryByNode = new Map<string, FactoryCompilation>();
  const nodes = graphNodes(source)
    .map((node) => compileGraphNode(node, planState, ownerPath, factoryByNode))
    .sort(compareStableId);
  const routeGroups = compileRouteGroups(source);
  const controls = compileControlEdges(source, planState, interfaceSnapshot);
  const data = compileDataEdges(source, planState, interfaceSnapshot, nodes);
  const completion = compileCompletion(source, planState);
  const closure = staticClosure(source, factoryByNode, ownerPath);
  assertJsonObject(planState.snapshot.safety.scope);
  const withoutHash = {
    format: 'icarus.workflow-graph-scope-plan/2' as const,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    source_hash: sourceHash('graph_scope', source),
    interface_snapshot_hash: scopedInterfaceHash(interfaceSnapshot),
    policy_snapshot_hash: planState.policyHash,
    effective_policy_snapshot: planPolicy,
    capability_catalog_hash: scopedCatalogHash(
      state.snapshot,
      'capability',
      'icarus:workflow-capability-catalog-snapshot:1\n',
    ),
    wait_contract_catalog_hash: scopedCatalogHash(
      state.snapshot,
      'wait_contract',
      'icarus:workflow-wait-catalog-snapshot:1\n',
    ),
    interface_snapshot: interfaceSnapshot,
    nodes,
    route_groups: routeGroups,
    control_edges: controls,
    data_edges: data,
    completion,
    complexity_summary: complexitySummary(
      nodes,
      controls,
      data,
      completion,
      Number(planState.snapshot.safety.scope.max_frontier_bytes),
    ),
    static_child_plan_closure: closure,
    effective_limits: planPolicy.limits,
    effective_usage_budget: planPolicy.usage_budget,
    runtime_safety_snapshot: planState.snapshot.safety,
    runtime_safety_hash: planState.snapshot.safetyHash,
  };
  const plan = {
    ...withoutHash,
    plan_hash: semanticHash(PLAN_DOMAIN_SEPARATOR, withoutHash),
  } as CompiledScopePlanV2Document;
  const childByClosureKey = new Map<
    string,
    WorkflowCompilerStaticChildPlanBundleEntry
  >();
  for (const factory of factoryByNode.values()) {
    for (const child of factory.staticChildPlans) {
      if (childByClosureKey.has(child.closureKey)) {
        throw new Error(
          `Duplicate static child closure key: ${child.closureKey}`,
        );
      }
      childByClosureKey.set(child.closureKey, child);
    }
  }
  const staticChildPlans = closure.members.map((member) => {
    const child = childByClosureKey.get(String(member.closure_key));
    if (!child) {
      throw new Error(
        `Static child Plan bytes are missing: ${String(member.closure_key)}`,
      );
    }
    return child;
  });
  if (staticChildPlans.length !== childByClosureKey.size) {
    throw new Error('Static child Plan bundle contains an unreferenced entry');
  }
  return { plan, staticChildPlans };
}

function compileDefinitionPlan(
  source: JsonObject,
  state: CompilationState,
  entryPoint: string,
): CompiledScopePlanV2Document {
  assertJsonObject(source.ref);
  assertJsonObject(source.entry_points);
  assertJsonObject(source.states);
  const entry = source.entry_points[entryPoint];
  assertJsonObject(entry);
  const stateKey = String(entry.state_key);
  const definitionState = source.states[stateKey];
  assertJsonObject(definitionState);
  assertJsonObject(definitionState.policy);
  const generatedInterface = {
    ref: {
      id: `${String(source.ref.id)}.lowered.${stateKey}`,
      version: String(source.ref.version),
    },
    inputs: {},
    exits: {
      success: { output_ports: {} },
      failure: { output_ports: {} },
    },
  };
  const loweredSource = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: `definition.${stateKey}`,
    interface_ref: generatedInterface.ref,
    nodes: [
      {
        id: 'capability',
        type: definitionState.type,
        trigger: { type: 'root' },
        capability_ref: definitionState.capability_ref,
        ...(definitionState.retry_request
          ? { retry_request: definitionState.retry_request }
          : {}),
        ...(definitionState.timeout_ms
          ? { timeout_ms: definitionState.timeout_ms }
          : {}),
      },
      {
        id: 'failure',
        type: 'terminal',
        trigger: { type: 'all', edge_ids: ['failed_to_failure'] },
        exit: 'failure',
      },
      {
        id: 'success',
        type: 'terminal',
        trigger: { type: 'all', edge_ids: ['succeeded_to_success'] },
        exit: 'success',
      },
    ],
    control_edges: [
      {
        id: 'failed_to_failure',
        kind: 'control',
        from_node_id: 'capability',
        to_node_id: 'failure',
        on: { statuses: ['failed'] },
      },
      {
        id: 'succeeded_to_success',
        kind: 'control',
        from_node_id: 'capability',
        to_node_id: 'success',
        on: { statuses: ['succeeded'] },
      },
    ],
    data_edges: [],
    requested_limits: definitionState.policy.limits,
    completion: {
      settled_rules: [
        {
          id: 'select_named_exit',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['failure', 'success'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
  } as JsonObject;
  const factoryByNode = new Map<string, FactoryCompilation>();
  const nodes = graphNodes(loweredSource)
    .map((node) =>
      compileGraphNode(node, state, [String(node.id)], factoryByNode),
    )
    .sort(compareStableId);
  const controls = compileControlEdges(
    loweredSource,
    state,
    generatedInterface,
  );
  const completion = compileCompletion(loweredSource, state);
  const closureWithoutHash = { members: [], member_count: 0 };
  const closure = {
    ...closureWithoutHash,
    closure_hash: semanticHash(
      STATIC_CLOSURE_DOMAIN_SEPARATOR,
      closureWithoutHash,
    ),
  };
  assertJsonObject(state.snapshot.safety.scope);
  const withoutHash = {
    format: 'icarus.workflow-graph-scope-plan/2' as const,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    source_hash: sourceHash('workflow_definition', source),
    interface_snapshot_hash: scopedInterfaceHash(generatedInterface),
    policy_snapshot_hash: state.policyHash,
    effective_policy_snapshot: state.policy,
    capability_catalog_hash: scopedCatalogHash(
      state.snapshot,
      'capability',
      'icarus:workflow-capability-catalog-snapshot:1\n',
    ),
    wait_contract_catalog_hash: scopedCatalogHash(
      state.snapshot,
      'wait_contract',
      'icarus:workflow-wait-catalog-snapshot:1\n',
    ),
    interface_snapshot: generatedInterface,
    nodes,
    route_groups: [],
    control_edges: controls,
    data_edges: [],
    completion,
    complexity_summary: complexitySummary(
      nodes,
      controls,
      [],
      completion,
      Number(state.snapshot.safety.scope.max_frontier_bytes),
    ),
    static_child_plan_closure: closure,
    effective_limits: state.policy.limits,
    effective_usage_budget: state.policy.usage_budget,
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
    policy: snapshot.rootPolicy,
    policyHash: snapshot.rootPolicyHash,
    proofHashes: new Set(),
    programHashes: new Set(),
  };
  let plan: CompiledScopePlanV2Document;
  let staticChildPlans: WorkflowCompilerStaticChildPlanBundleEntry[] = [];
  if (request.sourceKind === 'workflow_definition') {
    assertJsonObject(source.entry_points);
    assertJsonObject(source.states);
    const entryPoint = request.entryPoint ?? 'default';
    const entry = source.entry_points[entryPoint];
    assertJsonObject(entry);
    const definitionState = source.states[String(entry.state_key)];
    assertJsonObject(definitionState);
    assertJsonObject(definitionState.policy);
    state.policy = normalizePolicy(definitionState.policy);
    state.policyHash = semanticHash(
      'icarus:workflow-effective-policy:1\n',
      state.policy,
    );
    validateDefinitionBindings(source, state);
    plan = compileDefinitionPlan(source, state, entryPoint);
  } else if (request.sourceKind === 'graph_scope') {
    validateGraphBindings(source, state);
    validateGraphStructure(source, state);
    const compiled = compileGraphPlan(source, state);
    plan = compiled.plan;
    staticChildPlans = compiled.staticChildPlans;
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
    staticChildPlanBundle: {
      format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
      entries: staticChildPlans,
    },
    proofHashes: [...state.proofHashes].sort(),
    programHashes: [...state.programHashes].sort(),
    staticLowering: request.sourceKind === 'workflow_definition',
  };
}

function definitionIdentityMatches(source: JsonObject): boolean {
  const { definition_hash: definitionHash, ...withoutHash } = source;
  return (
    definitionHash ===
    domainSeparatedSha256(
      'icarus:workflow-definition:1\n',
      withoutHash as JsonValue,
    )
  );
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
    if (
      request.sourceKind === 'workflow_definition' &&
      !definitionIdentityMatches(source)
    ) {
      return reject(
        hash,
        diagnostic('compiler_integrity_mismatch', 'hash', '/definition_hash'),
      );
    }
    const snapshot = bindCompilerSnapshot(request.inputSnapshot);
    return { ok: true, value: compileSuccess(request, source, hash, snapshot) };
  } catch (error) {
    if (error instanceof CompilerDiagnosticError) {
      return reject(hash, error.diagnostic);
    }
    throw error;
  }
}
