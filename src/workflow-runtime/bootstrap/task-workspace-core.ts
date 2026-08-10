import { compileWorkflow } from '../compiler/compiler.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { buildClosedSchemaArtifacts } from '../contracts/closed-schema-artifacts.js';
import {
  buildDependencyClosure,
  calculateRegistrySnapshotHash,
  compareAscii,
  registryResourceKey,
} from '../contracts/g3-registry-persistence.js';
import {
  G3_REGISTRY_DEPENDENCY_KIND,
  G3_REGISTRY_PERSISTENCE_FORMATS,
  type G3RegistryPersistenceBatch,
  type G3RegistryResourceDependency,
  type G3RegistryResourceRecord,
  type G3RegistryResourceType,
  type G3RegistrySnapshot,
} from '../contracts/g3-registry-persistence-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { buildSafetySqliteSemanticArtifacts } from '../contracts/safety-sqlite-artifacts.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import { publishWorkflowBundle } from '../authoring/workflow-bundle-publisher.js';
import {
  TASK_WORKSPACE_CORE_VERSION,
  TASK_WORKSPACE_TEMPORARY_REFS,
  WORKFLOW_AGENT_DISPATCH_REQUEST_SCHEMA,
  WORKFLOW_AGENT_RESULT_SCHEMA,
} from './task-workspace-temporary-contract.js';

const CORE_OWNER = `icarus.core.task-workspace@${TASK_WORKSPACE_CORE_VERSION}`;
const CORE_VERSION = TASK_WORKSPACE_CORE_VERSION;
const CORE_COMPILER_REFS = {
  rootInterface: {
    id: 'icarus.core.task-workspace.interface.root',
    version: CORE_VERSION,
  },
  childPolicy: {
    id: 'icarus.core.task-workspace.policy.child',
    version: CORE_VERSION,
  },
  rootPolicy: {
    id: 'icarus.core.task-workspace.policy.root',
    version: CORE_VERSION,
  },
  graphScopeSchema: {
    id: 'icarus.core.task-workspace.schema.graph-scope',
    version: CORE_VERSION,
  },
} as const satisfies Record<string, VersionedRef>;

function rowId(
  resourceType: string,
  resourceId: string,
  version = CORE_VERSION,
): string {
  return `registry-resource:${resourceType}:${resourceId}@${version}`;
}

function registryResourceContentHash(
  resourceType: string,
  ref: VersionedRef,
  content: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-registry-resource-content:1\n',
    {
      format: 'icarus.workflow-registry-resource/1',
      resource_type: resourceType,
      ref,
      content,
    },
  );
}

interface CoreResource {
  readonly type: G3RegistryResourceType;
  readonly id: string;
  readonly version?: string;
  readonly content: JsonObject;
  readonly contentHash?: Sha256Hash;
}

function buildCoreRegistryBatch(
  resources: readonly CoreResource[],
  schemaHash: Sha256Hash,
  nowMs: number,
): G3RegistryPersistenceBatch {
  const owner = {
    kind: 'core' as const,
    ref: { id: 'icarus.core.task-workspace', version: CORE_VERSION },
  };
  const schemaRef = {
    id: 'icarus.task-workspace.generic-json',
    version: CORE_VERSION,
  };
  const identities = resources.map((resource) => ({
    resource_type: resource.type,
    ref: { id: resource.id, version: resource.version ?? CORE_VERSION },
    content_hash: coreResourceContentHash(resource),
  }));
  const recipeRef = { id: 'ad_hoc_personal_task', version: CORE_VERSION };
  const records = resources.map((resource): G3RegistryResourceRecord => {
    const ref = { id: resource.id, version: resource.version ?? CORE_VERSION };
    let dependencies: G3RegistryResourceDependency[] = [];
    if (resource.type === 'recipe') {
      dependencies = identities
        .filter(
          (candidate) =>
            candidate.resource_type !== 'recipe' ||
            candidate.ref.id !== recipeRef.id ||
            candidate.ref.version !== recipeRef.version,
        )
        .map((candidate) => ({
          ...candidate,
          dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
        }));
    } else if (resource.type !== 'schema' || resource.id !== schemaRef.id) {
      dependencies = [
        {
          resource_type: 'schema',
          ref: schemaRef,
          content_hash: schemaHash,
          dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
        },
      ];
    }
    dependencies.sort((left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
    );
    return {
      format: G3_REGISTRY_PERSISTENCE_FORMATS.resource,
      resource_type: resource.type,
      ref,
      owner,
      schema_ref: schemaRef,
      schema_hash: schemaHash,
      content: resource.content,
      content_hash: coreResourceContentHash(resource),
      dependencies,
    };
  });
  records.sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    records,
    { resource_type: 'recipe', ref: recipeRef },
    { id: 'icarus.task-workspace-core', version: CORE_VERSION },
    { ...schemaRef, hash: schemaHash },
  );
  const snapshotWithoutHash = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.snapshot,
    ref: { id: 'icarus.task-workspace-core', version: CORE_VERSION },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: WORKFLOW_COMPILER_VERSION,
  } satisfies Omit<G3RegistrySnapshot, 'snapshot_hash'>;
  return {
    resources: records,
    closure,
    snapshot: {
      ...snapshotWithoutHash,
      snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
    },
    created_at_ms: nowMs,
  };
}

function coreResourceContentHash(resource: CoreResource): Sha256Hash {
  return (
    resource.contentHash ??
    registryResourceContentHash(
      resource.type,
      { id: resource.id, version: resource.version ?? CORE_VERSION },
      resource.content,
    )
  );
}

const GRAPH_LIMIT_KEYS = [
  'max_scopes',
  'max_nodes',
  'max_nodes_per_scope',
  'max_edges_per_scope',
  'max_nesting_depth',
  'max_map_items',
  'max_concurrency',
  'max_total_attempts',
  'max_total_waits',
  'max_total_output_bytes',
  'max_scope_spec_bytes',
  'max_condition_steps',
  'max_wait_duration_ms',
  'max_pending_signals',
  'max_fixed_point_facts',
  'max_frontier_bytes',
] as const;

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function graphLimits(
  overrides: Partial<Record<(typeof GRAPH_LIMIT_KEYS)[number], number>> = {},
): JsonObject {
  return Object.fromEntries(
    GRAPH_LIMIT_KEYS.map((key) => [key, overrides[key] ?? null]),
  ) as JsonObject;
}

function usageBudget(): JsonObject {
  return {
    max_total_tool_calls: null,
    max_total_input_tokens: null,
    max_total_output_tokens: null,
    max_total_cost_micros: null,
  };
}

function graphScopeSchema(): JsonObject {
  const artifact = buildClosedSchemaArtifacts().find(
    ([artifactPath]) =>
      artifactPath === 'schemas/graph-scope-source-schema.json',
  )?.[1];
  if (!artifact || !artifact.payload || Array.isArray(artifact.payload)) {
    throw new Error('Canonical Graph Scope schema is unavailable');
  }
  return cloneJson(artifact.payload as JsonObject);
}

function runtimeSafetyProfile(): {
  readonly hash: Sha256Hash;
  readonly ceilings: JsonObject;
} {
  const artifact = buildSafetySqliteSemanticArtifacts().find(
    ([, candidate]) =>
      candidate.format === 'icarus.workflow-runtime-safety-profile/1',
  )?.[1];
  const payload = artifact?.payload;
  if (
    !artifact ||
    !payload ||
    Array.isArray(payload) ||
    !payload.ceilings ||
    typeof payload.ceilings !== 'object' ||
    Array.isArray(payload.ceilings)
  ) {
    throw new Error('Canonical Runtime safety profile is unavailable');
  }
  return {
    hash: artifact.hash,
    ceilings: cloneJson(payload.ceilings as JsonObject),
  };
}

function scopeInterface(ref: VersionedRef): JsonObject {
  const snapshot: JsonObject = {
    ref,
    inputs: {},
    exits: { done: { output_ports: {} } },
  };
  return {
    format: 'icarus.workflow-scope-interface/1',
    ...snapshot,
    interface_hash: domainSeparatedSha256(
      'icarus:workflow-scope-interface:1\n',
      snapshot,
    ),
  };
}

function graphPolicyResource(
  ref: VersionedRef,
  request: JsonObject,
): JsonObject {
  const content: JsonObject = {
    format: 'icarus.workflow-graph-policy/1',
    ref,
    request,
  };
  return {
    ...content,
    policy_hash: domainSeparatedSha256(
      'icarus:workflow-graph-policy:1\n',
      content,
    ),
  };
}

interface CoreCompilerBase {
  readonly source: JsonObject;
  readonly snapshot: JsonObject;
  readonly resources: CoreResource[];
}

function buildCoreCompilerBase(): CoreCompilerBase {
  const refs = TASK_WORKSPACE_TEMPORARY_REFS;
  const childInterface = scopeInterface(refs.interface);
  const rootInterface = scopeInterface(CORE_COMPILER_REFS.rootInterface);
  const childPolicy: JsonObject = {
    allowed_node_types: ['delegation', 'terminal'],
    allowed_capabilities: [refs.capability],
    allowed_templates: [],
    allowed_interface_refs: [refs.interface],
    allowed_wait_contracts: [],
    allowed_child_policy_refs: [],
    allowed_claim_ids: [],
    allow_early_close: false,
    allow_indefinite_waits: false,
    effect_policy: {
      allowed_recovery_kinds: ['pure'],
      max_impact: 'read_only',
    },
    build_retry: null,
    limits: graphLimits({ max_nodes: 16, max_edges_per_scope: 32 }),
    usage_budget: usageBudget(),
  };
  const rootPolicy: JsonObject = {
    allowed_node_types: ['expand', 'delegation', 'terminal'],
    allowed_capabilities: [refs.capability],
    allowed_templates: [],
    allowed_interface_refs: [refs.interface, CORE_COMPILER_REFS.rootInterface],
    allowed_wait_contracts: [],
    allowed_child_policy_refs: [CORE_COMPILER_REFS.childPolicy],
    allowed_claim_ids: [],
    allow_early_close: true,
    allow_indefinite_waits: false,
    effect_policy: {
      allowed_recovery_kinds: ['pure'],
      max_impact: 'read_only',
    },
    build_retry: null,
    limits: graphLimits(),
    usage_budget: usageBudget(),
  };
  const graphSchemaResource: CoreResource = {
    type: 'schema',
    id: CORE_COMPILER_REFS.graphScopeSchema.id,
    content: graphScopeSchema(),
  };
  const rootInterfaceResource: CoreResource = {
    type: 'scope_interface',
    id: CORE_COMPILER_REFS.rootInterface.id,
    content: rootInterface,
  };
  const childInterfaceResource: CoreResource = {
    type: 'scope_interface',
    id: refs.interface.id,
    content: childInterface,
  };
  const rootPolicyResource: CoreResource = {
    type: 'graph_policy',
    id: CORE_COMPILER_REFS.rootPolicy.id,
    content: graphPolicyResource(CORE_COMPILER_REFS.rootPolicy, rootPolicy),
  };
  const childPolicyResource: CoreResource = {
    type: 'graph_policy',
    id: CORE_COMPILER_REFS.childPolicy.id,
    content: graphPolicyResource(CORE_COMPILER_REFS.childPolicy, childPolicy),
  };
  const resources = [
    graphSchemaResource,
    rootInterfaceResource,
    childInterfaceResource,
    rootPolicyResource,
    childPolicyResource,
  ];
  const registryResources = resources.map((resource) => ({
    resource_type: resource.type,
    ref: { id: resource.id, version: resource.version ?? CORE_VERSION },
    content: resource.content,
    publication_state: 'published',
    launchability: 'production',
    content_hash: coreResourceContentHash(resource),
  }));
  const registrySnapshotWithoutHash: JsonObject = {
    snapshot_ref: `icarus:task-workspace:registry@${CORE_VERSION}`,
    resource_count: registryResources.length,
    resources: registryResources,
    dependency_closure_count: 0,
    dependency_closures: [],
  };
  const registrySnapshot: JsonObject = {
    ...registrySnapshotWithoutHash,
    snapshot_hash: domainSeparatedSha256(
      'icarus:task-workspace-core-compiler-registry-snapshot:1\n',
      registrySnapshotWithoutHash,
    ),
  };
  const interfaceEntries = [childInterface, rootInterface];
  const interfaceSnapshotWithoutHash: JsonObject = {
    snapshot_ref: `icarus:task-workspace:interfaces@${CORE_VERSION}`,
    interface_count: interfaceEntries.length,
    interfaces: interfaceEntries,
  };
  const interfaceSnapshot: JsonObject = {
    ...interfaceSnapshotWithoutHash,
    snapshot_hash: domainSeparatedSha256(
      'icarus:task-workspace-core-compiler-interface-snapshot:1\n',
      interfaceSnapshotWithoutHash,
    ),
  };
  const completePolicyWithoutHash: JsonObject = {
    root_policy_ref: CORE_COMPILER_REFS.rootPolicy,
    root_policy: rootPolicy,
    child_profiles: [
      { ref: CORE_COMPILER_REFS.childPolicy, request: childPolicy },
    ],
    intersection_order: [
      'global',
      'workflow',
      'state',
      'parent',
      'child_request',
      'runtime_safety',
    ],
  };
  const policySnapshot: JsonObject = {
    snapshot_ref: `icarus:task-workspace:policy@${CORE_VERSION}`,
    complete_policy: {
      ...completePolicyWithoutHash,
      policy_hash: domainSeparatedSha256(
        'icarus:task-workspace-core-compiler-policy:1\n',
        completePolicyWithoutHash,
      ),
    },
  };
  const safetyProfile = runtimeSafetyProfile();
  const safetySnapshot: JsonObject = {
    snapshot_ref: `icarus:task-workspace:safety@${CORE_VERSION}`,
    source_artifact_hash: safetyProfile.hash,
    ceilings: safetyProfile.ceilings,
  };
  const snapshotWithoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-input-snapshot/2',
    snapshot_id: `icarus.task-workspace.compiler@${CORE_VERSION}`,
    launchability: 'production',
    registry_snapshot: registrySnapshot,
    interface_snapshot: interfaceSnapshot,
    policy_snapshot: policySnapshot,
    safety_snapshot: safetySnapshot,
  };
  const snapshot: JsonObject = {
    ...snapshotWithoutHash,
    snapshot_hash: domainSeparatedSha256(
      'icarus:task-workspace-core-compiler-snapshot:1\n',
      snapshotWithoutHash,
    ),
  };
  const source: JsonObject = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'task_workspace_outer',
    interface_ref: CORE_COMPILER_REFS.rootInterface,
    nodes: [
      {
        id: 'expand_child',
        type: 'expand',
        trigger: { type: 'root' },
        child_interface_ref: refs.interface,
        input_ports: {
          graph_spec: {
            schema_ref: CORE_COMPILER_REFS.graphScopeSchema,
            max_bytes: 1_048_576,
            aggregation: { type: 'single', required: true, select: 'only' },
          },
        },
        graph_spec_input_port: 'graph_spec',
        child_input_bindings: {},
        completion_output_port: 'completion',
        expose: {},
        child_policy_ref: CORE_COMPILER_REFS.childPolicy,
      },
      {
        id: 'done',
        type: 'terminal',
        trigger: { type: 'all', edge_ids: ['edge.expanded'] },
        exit: 'done',
      },
    ],
    control_edges: [
      {
        id: 'edge.expanded',
        kind: 'control',
        from_node_id: 'expand_child',
        to_node_id: 'done',
        on: { statuses: ['succeeded'] },
      },
    ],
    data_edges: [
      {
        id: 'data.graph-spec',
        kind: 'data',
        from: {
          type: 'literal',
          value: {
            format: 'icarus.workflow-graph-scope/1',
            scope_key: 'dynamic_child',
            interface_ref: refs.interface,
            nodes: [
              {
                id: 'child_done',
                type: 'terminal',
                trigger: { type: 'root' },
                exit: 'done',
              },
            ],
            control_edges: [],
            data_edges: [],
            completion: {
              settled_rules: [
                {
                  id: 'select_done',
                  phase: 'settled',
                  priority: 100,
                  when: { fact: 'all_nodes_terminal' },
                  select: {
                    exits: ['done'],
                    pick: { type: 'lowest_terminal_node_id' },
                  },
                },
              ],
              no_match: 'error',
              early_close: 'cancel_and_fence_remaining',
            },
            requested_limits: graphLimits(),
          },
        },
        to: { node_id: 'expand_child', port: 'graph_spec' },
      },
    ],
    completion: {
      settled_rules: [
        {
          id: 'select_done',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
    requested_limits: graphLimits(),
    metadata: { owner: CORE_OWNER },
  };
  return { source, snapshot, resources };
}

function augmentCompilerSnapshot(input: JsonObject): {
  snapshot: JsonObject;
  resources: CoreResource[];
} {
  const snapshot = JSON.parse(JSON.stringify(input)) as JsonObject;
  const registrySnapshot = snapshot.registry_snapshot as JsonObject;
  const registryResources = registrySnapshot.resources as JsonObject[];
  const dependencyClosures =
    registrySnapshot.dependency_closures as JsonObject[];
  const refs = TASK_WORKSPACE_TEMPORARY_REFS;

  const adapterBase: JsonObject = {
    format: 'icarus.workflow-outbox-adapter/1',
    ref: refs.adapter,
    supported_effect_types: ['capability_dispatch'],
    supported_delivery_lanes: ['normal_execution'],
    supported_reconciliation: ['not_required'],
    supported_idempotency: ['provider_key'],
  };
  const adapter: JsonObject = {
    ...adapterBase,
    adapter_hash: domainSeparatedSha256(
      'icarus:workflow-outbox-adapter:1\n',
      adapterBase,
    ),
  };
  const policyBase: JsonObject = {
    format: 'icarus.workflow-outbox-delivery-policy/1',
    ref: refs.outboxPolicy,
    max_delivery_attempts: 3,
    max_reconcile_attempts: 0,
    delivery_duration_ms: 3_600_000,
    attempt_timeout_ms: 3_600_000,
    initial_backoff_ms: 1_000,
    max_backoff_ms: 30_000,
    backoff: 'exponential',
    deterministic_jitter_micros: 100_000,
    honor_retry_after: true,
    retryable_error_codes: [
      'provider_unavailable',
      'rate_limited',
      'workflow_adapter_completion_failed',
    ],
    permanent_error_codes: ['contract_rejected', 'permission_denied'],
  };
  const outboxPolicy: JsonObject = {
    ...policyBase,
    policy_hash: domainSeparatedSha256(
      'icarus:workflow-outbox-delivery-policy:1\n',
      policyBase,
    ),
  };
  const executor: JsonObject = {
    ref: refs.executor,
    contract_kind: 'executor',
    contract_hash: domainSeparatedSha256(
      'icarus:task-workspace-codex-executor:1\n',
      { ref: refs.executor, adapter_ref: refs.adapter },
    ),
  };
  const dependencies: CoreResource[] = [
    {
      type: 'outbox_adapter',
      id: refs.adapter.id,
      content: adapter,
    },
    {
      type: 'executor_implementation',
      id: refs.executor.id,
      content: executor,
    },
    {
      type: 'outbox_policy',
      id: refs.outboxPolicy.id,
      content: outboxPolicy,
    },
    {
      type: 'schema',
      id: refs.requestSchema.id,
      content: WORKFLOW_AGENT_DISPATCH_REQUEST_SCHEMA,
    },
    {
      type: 'schema',
      id: refs.resultSchema.id,
      content: WORKFLOW_AGENT_RESULT_SCHEMA,
    },
  ];
  const closureMembers = dependencies
    .map((resource) => ({
      resource_type: resource.type,
      ref: {
        id: resource.id,
        version: resource.version ?? CORE_VERSION,
      },
      content_hash: coreResourceContentHash(resource),
    }))
    .sort((left, right) => {
      const leftKey = `${left.ref.id}@${left.ref.version}`;
      const rightKey = `${right.ref.id}@${right.ref.version}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const closurePayload: JsonObject = {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: 'capability',
    root_ref: refs.capability,
    members: closureMembers,
    member_count: closureMembers.length,
  };
  const dependencyClosureHash = domainSeparatedSha256(
    'icarus:workflow-registry-dependency-closure:1\n',
    closurePayload,
  );
  const capability: JsonObject = {
    ref: refs.capability,
    node_type: 'delegation',
    executor_ref: refs.executor,
    skill_refs: [],
    input_ports: {
      request: {
        schema_ref: refs.requestSchema,
        max_bytes: 1_048_576,
        aggregation: { type: 'single', required: true, select: 'only' },
      },
    },
    output_ports: {
      result: {
        schema_ref: refs.resultSchema,
        max_bytes: 1_048_576,
        required: true,
      },
    },
    no_artifact_expected: false,
    no_evaluation_expected: true,
    quality_revision_policy: null,
    required_tools: [],
    required_mcp_methods: [],
    required_file_scopes: [],
    required_claims: [],
    allowed_groups: [],
    retry_policy: {
      max_attempts: 1,
      retry_on: [],
      backoff: 'fixed',
    },
    timeout_ceiling_ms: 3_600_000,
    effect_impact: 'read_only',
    effect: { type: 'pure' },
    cancellation: { type: 'fence_only', safe_to_abandon: true },
    dependency_closure_hash: dependencyClosureHash,
    outbox_effect: {
      effect_type: 'capability_dispatch',
      adapter_ref: refs.adapter,
      delivery_policy_ref: refs.outboxPolicy,
      delivery_lane: 'normal_execution',
      reconciliation: { type: 'not_required' },
      idempotency: 'provider_key',
      delivery_requirement: 'required',
    },
  };
  const capabilityResource: CoreResource = {
    type: 'capability',
    id: refs.capability.id,
    content: capability,
  };
  const resources = [...dependencies, capabilityResource];

  for (const resource of resources) {
    registryResources.push({
      resource_type: resource.type,
      ref: {
        id: resource.id,
        version: resource.version ?? CORE_VERSION,
      },
      content: resource.content,
      publication_state: 'published',
      launchability: 'production',
      content_hash: coreResourceContentHash(resource),
    });
  }
  dependencyClosures.push({
    ...closurePayload,
    closure_hash: dependencyClosureHash,
  });
  registrySnapshot.resource_count = registryResources.length;
  registrySnapshot.dependency_closure_count = dependencyClosures.length;
  const { snapshot_hash: _priorRegistryHash, ...registryWithoutHash } =
    registrySnapshot;
  registrySnapshot.snapshot_hash = domainSeparatedSha256(
    'icarus:task-workspace-core-compiler-registry-snapshot:1\n',
    registryWithoutHash,
  );
  const { snapshot_hash: _priorSnapshotHash, ...snapshotWithoutHash } =
    snapshot;
  snapshot.snapshot_hash = domainSeparatedSha256(
    'icarus:task-workspace-core-compiler-snapshot:1\n',
    snapshotWithoutHash,
  );
  return { snapshot, resources };
}

export type EnsureTaskWorkspaceCoreResult = 'initialized' | 'preserved';

/** Publishes the fixed Core outer Workflow used by Temporary and Personal runs. */
export function ensureTaskWorkspaceCore(
  store: WorkflowRuntimeStore,
  nowMs = Date.now(),
): EnsureTaskWorkspaceCoreResult {
  const compilerBase = buildCoreCompilerBase();
  const augmented = augmentCompilerSnapshot(compilerBase.snapshot);
  const compiled = compileWorkflow({
    caseId: 'core.ad-hoc-personal-task.outer',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(compilerBase.source), 'utf8'),
    inputSnapshot: augmented.snapshot,
  });
  if (!compiled.ok) {
    throw new Error('Fixed Task Workspace Core outer Plan no longer compiles');
  }

  const genericSchema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:task-workspace:generic-json:1',
    title: 'Task Workspace JSON',
  };
  const genericSchemaHash = registryResourceContentHash(
    'schema',
    { id: 'icarus.task-workspace.generic-json', version: CORE_VERSION },
    genericSchema,
  );
  const definition: JsonObject = {
    format: 'icarus.workflow-definition/1',
    ref: { id: 'icarus.core.ad-hoc-personal-task', version: CORE_VERSION },
    entry_points: {
      workspace_run: { state_key: 'run' },
    },
    states: {
      run: {
        type: 'graph',
        graph_source: compilerBase.source,
        exit_routes: { done: { target: 'completed' } },
        on_error: { target: 'failed' },
        on_local_cancel: { target: 'cancelled' },
        on_temporary_replan: { target: 'run' },
      },
      completed: { type: 'terminal', terminal_kind: 'normal' },
      failed: {
        type: 'terminal',
        terminal_kind: 'errored',
        error_code: 'ad_hoc_workflow_failed',
      },
      cancelled: {
        type: 'terminal',
        terminal_kind: 'errored',
        error_code: 'ad_hoc_workflow_cancelled',
      },
    },
    compiled_plan_pin: {
      plan_hash: compiled.value.plan.plan_hash,
      plan_format: compiled.value.plan.format,
      compiler_version: compiled.value.plan.compiler_version,
      provenance: 'golden_corpus',
    },
    precompiled_plan: compiled.value.plan as unknown as JsonObject,
  };
  const commandPolicy: JsonObject = {
    command_policy_allow_pause: true,
    command_policy_allow_resume: true,
    command_policy_allows_local_graph_cancel: true,
    command_policy_allows_workflow_cancel: true,
    command_policy_allow_manual_skip: false,
    command_policy_allow_retry_wait_advance: false,
    receipt_remediation_contract_allows_reconcile: false,
    receipt_remediation_contract_allows_verified_receipt: false,
    receipt_remediation_contract_allows_not_applied_proof: false,
    command_policy_administrative_abandon_allowed: false,
    administrative_abandon_release_claims: false,
  };
  const recipe: JsonObject = {
    format: 'icarus.workflow-recipe/1',
    ref: { id: 'ad_hoc_personal_task', version: CORE_VERSION },
    catalog_visibility: 'system_only',
    system_purposes: ['temporary_workflow', 'personal_workflow'],
    name: 'Temporary Workflow',
    description: 'Plan and confirm a task-specific Workflow.',
    recipe_family: 'core.task-workspace.ad-hoc',
    workflow_definition_ref: {
      id: 'icarus.core.ad-hoc-personal-task',
      version: CORE_VERSION,
    },
    entry_point: 'workspace_run',
    initial_state_key: 'run',
    workflow_execution_policy_ref: {
      id: 'icarus.core.task-workspace.execution',
      version: CORE_VERSION,
    },
    workflow_command_policy_ref: {
      id: 'icarus.core.task-workspace.commands',
      version: CORE_VERSION,
    },
    input_schema_ref: {
      id: 'icarus.task-workspace.generic-json',
      version: CORE_VERSION,
    },
    output_schema_ref: {
      id: 'icarus.task-workspace.generic-json',
      version: CORE_VERSION,
    },
    context_contract_ref: {
      id: 'icarus.core.task-workspace.context',
      version: CORE_VERSION,
    },
    routing_scope_ref: {
      id: 'icarus.core.task-workspace.explicit-routing',
      version: CORE_VERSION,
    },
    launch_policy: 'confirm',
    effect_ceiling: 'read_only',
    input_summary: { accepts_text: true, accepts_attachments: true },
    compiler_input_snapshot: augmented.snapshot,
  };

  const resources: CoreResource[] = [
    ...compilerBase.resources,
    ...augmented.resources,
    {
      type: 'schema',
      id: 'icarus.task-workspace.generic-json',
      content: genericSchema,
      contentHash: genericSchemaHash,
    },
    { type: 'recipe', id: 'ad_hoc_personal_task', content: recipe },
    {
      type: 'definition',
      id: 'icarus.core.ad-hoc-personal-task',
      content: definition,
    },
    {
      type: 'execution_policy',
      id: 'icarus.core.task-workspace.execution',
      content: { launch_source: 'task_workspace', effect_ceiling: 'read_only' },
    },
    {
      type: 'command_policy',
      id: 'icarus.core.task-workspace.commands',
      content: commandPolicy,
    },
    {
      type: 'context_contract',
      id: 'icarus.core.task-workspace.context',
      content: { slots: {} },
    },
    {
      type: 'routing_scope',
      id: 'icarus.core.task-workspace.explicit-routing',
      content: { mode: 'explicit_recipe_only' },
    },
    {
      type: 'runtime_supported_limits',
      id: 'icarus.core.task-workspace.limits',
      content: { profile: 'local_single_user' },
    },
    {
      type: 'sqlite_execution_profile',
      id: 'icarus.core.task-workspace.sqlite',
      content: { profile: 'local_single_user_sqlite' },
    },
  ];

  const batch = buildCoreRegistryBatch(resources, genericSchemaHash, nowMs);
  const publication = publishWorkflowBundle(store, {
    owner: {
      kind: 'core',
      ref: { id: 'icarus.core.task-workspace', version: CORE_VERSION },
    },
    resources: batch.resources,
    registry_batch: batch,
    published_at_ms: nowMs,
    publication_ref: `core:icarus.task-workspace@${CORE_VERSION}`,
  });
  return publication.disposition === 'published' ? 'initialized' : 'preserved';
}
