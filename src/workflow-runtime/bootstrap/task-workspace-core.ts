import fs from 'node:fs';
import path from 'node:path';

import { compileWorkflow } from '../compiler/compiler.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import {
  TASK_WORKSPACE_CORE_VERSION,
  TASK_WORKSPACE_TEMPORARY_REFS,
  WORKFLOW_AGENT_DISPATCH_REQUEST_SCHEMA,
  WORKFLOW_AGENT_RESULT_SCHEMA,
} from './task-workspace-temporary-contract.js';

const CORE_OWNER = `icarus.core.task-workspace@${TASK_WORKSPACE_CORE_VERSION}`;
const CORE_VERSION = TASK_WORKSPACE_CORE_VERSION;

function hash(kind: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(`icarus:task-workspace-core-${kind}:1\n`, value);
}

function rowId(
  resourceType: string,
  resourceId: string,
  version = CORE_VERSION,
): string {
  return `registry-resource:${resourceType}:${resourceId}@${version}`;
}

function valueId(
  resourceType: string,
  resourceId: string,
  version = CORE_VERSION,
): string {
  return `registry-value:${resourceType}:${resourceId}@${version}`;
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

function readExpandFixture(): { source: JsonObject; snapshot: JsonObject } {
  const candidates = [
    path.resolve(import.meta.dirname, '../compiler/golden/cases@1.json'),
    path.resolve(
      process.cwd(),
      'src/workflow-runtime/compiler/golden/cases@1.json',
    ),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error('Workflow compiler Core fixture is unavailable');
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    cases: Array<{
      case_id: string;
      raw_source_base64: string;
      registry_snapshot: JsonObject;
    }>;
  };
  const entry = corpus.cases.find(
    (candidate) => candidate.case_id === 'positive.expand',
  );
  if (!entry)
    throw new Error('Workflow compiler Expand fixture is unavailable');
  return {
    source: JSON.parse(
      Buffer.from(entry.raw_source_base64, 'base64').toString('utf8'),
    ) as JsonObject,
    snapshot: entry.registry_snapshot,
  };
}

interface CoreResource {
  readonly type: string;
  readonly id: string;
  readonly version?: string;
  readonly content: JsonObject;
  readonly contentHash?: Sha256Hash;
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

function insertResource(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: CoreResource,
  schemaRowId: string,
  schemaHash: Sha256Hash,
  nowMs: number,
): void {
  const version = resource.version ?? CORE_VERSION;
  const id = rowId(resource.type, resource.id, version);
  const contentHash = coreResourceContentHash(resource);
  const existing = transaction.queryOne<{
    content_hash: string;
    publication_state: string;
  }>(
    `SELECT content_hash, publication_state
       FROM workflow_registry_resources WHERE id = ?`,
    [id],
  );
  if (existing) {
    if (
      existing.content_hash !== contentHash ||
      existing.publication_state !== 'published'
    ) {
      throw new Error(`Task Workspace Core resource collision: ${id}`);
    }
    return;
  }
  const canonical = canonicalJson(resource.content);
  transaction.execute(
    `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
               ?, ?, 'icarus.task-workspace-core/1', 'pinned', 'live', NULL,
               ?, 1)`,
    [
      valueId(resource.type, resource.id, version),
      canonical,
      contentHash,
      Buffer.byteLength(canonical, 'utf8'),
      schemaRowId,
      schemaHash,
      nowMs,
    ],
  );
  transaction.execute(
    `INSERT INTO workflow_registry_resources (
       id, resource_type, resource_id, resource_version, owner_core_ref,
       owner_feature_id, canonical_value_id, content_hash, publication_state,
       created_at_ms, published_at_ms, retired_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'published', ?, ?, NULL, 1)`,
    [
      id,
      resource.type,
      resource.id,
      version,
      CORE_OWNER,
      valueId(resource.type, resource.id, version),
      contentHash,
      nowMs,
      nowMs,
    ],
  );
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
  const policySnapshot = snapshot.policy_snapshot as JsonObject;
  const completePolicy = policySnapshot.complete_policy as JsonObject;
  const rootPolicy = completePolicy.root_policy as JsonObject;
  const childProfiles = completePolicy.child_profiles as JsonObject[];
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
  registrySnapshot.dependency_closure_count = dependencyClosures.length;

  const allowedCapabilities = rootPolicy.allowed_capabilities as JsonObject[];
  allowedCapabilities.push(refs.capability);
  const childProfile = childProfiles.find(
    (candidate) =>
      (candidate.ref as JsonObject).id === 'fixture.policy.child-tight',
  );
  if (!childProfile) {
    throw new Error('Task Workspace Core child policy fixture is unavailable');
  }
  const childRequest = childProfile.request as JsonObject;
  childRequest.allowed_node_types = ['delegation', 'terminal'];
  childRequest.allowed_capabilities = [refs.capability];
  const { policy_hash: _priorPolicyHash, ...policyWithoutHash } =
    completePolicy;
  completePolicy.policy_hash = domainSeparatedSha256(
    'icarus:task-workspace-core-compiler-policy:1\n',
    policyWithoutHash,
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
  const recipeRowId = rowId('recipe', 'ad_hoc_personal_task');
  if (
    store.queryOne<{ id: string }>(
      `SELECT id FROM workflow_registry_resources
        WHERE id = ? AND publication_state = 'published'`,
      [recipeRowId],
    )
  ) {
    return 'preserved';
  }

  const fixture = readExpandFixture();
  const augmented = augmentCompilerSnapshot(fixture.snapshot);
  const compiled = compileWorkflow({
    caseId: 'core.ad-hoc-personal-task.outer',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(fixture.source), 'utf8'),
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
  const genericSchemaRowId = rowId(
    'schema',
    'icarus.task-workspace.generic-json',
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
        graph_source: fixture.source,
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

  const compilerResources = (
    (fixture.snapshot.registry_snapshot as JsonObject).resources as JsonObject[]
  ).map((resource) => ({
    type: String(resource.resource_type),
    id: String((resource.ref as JsonObject).id),
    version: String((resource.ref as JsonObject).version),
    content: resource.content as JsonObject,
    contentHash: resource.content_hash as Sha256Hash,
  }));
  for (const resource of compilerResources) {
    if (
      !resources.some(
        (candidate) =>
          candidate.type === resource.type &&
          candidate.id === resource.id &&
          (candidate.version ?? CORE_VERSION) === resource.version,
      )
    ) {
      resources.push(resource);
    }
  }

  store.withImmediateTransaction((transaction) => {
    for (const resource of resources) {
      insertResource(
        transaction,
        resource,
        genericSchemaRowId,
        genericSchemaHash,
        nowMs,
      );
    }
    const closureId = `registry-closure:icarus.task-workspace-core@${CORE_VERSION}`;
    const snapshotId = `registry-snapshot:icarus.task-workspace-core@${CORE_VERSION}`;
    const closureMembers = resources.map((resource) => ({
      resource_id: rowId(
        resource.type,
        resource.id,
        resource.version ?? CORE_VERSION,
      ),
      resource_type: resource.type,
      content_hash: coreResourceContentHash(resource),
    }));
    const closureHash = hash('closure', closureMembers);
    const closureManifest: JsonObject = {
      format: 'icarus.workflow-registry-dependency-closure/1',
      ref: { id: 'icarus.task-workspace-core', version: CORE_VERSION },
      members: closureMembers,
      closure_hash: closureHash,
    };
    const manifestHash = hash('closure-manifest', closureManifest);
    const manifestValueId = `registry-value:closure:icarus.task-workspace-core@${CORE_VERSION}`;
    const manifestCanonical = canonicalJson(closureManifest);
    transaction.execute(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
                 ?, ?, 'icarus.task-workspace-core/1', 'pinned', 'live', NULL,
                 ?, 1)`,
      [
        manifestValueId,
        manifestCanonical,
        manifestHash,
        Buffer.byteLength(manifestCanonical, 'utf8'),
        genericSchemaRowId,
        genericSchemaHash,
        nowMs,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_closure_manifests (
         id, closure_hash, manifest_value_id, manifest_hash, created_at_ms
       ) VALUES (?, ?, ?, ?, ?)`,
      [closureId, closureHash, manifestValueId, manifestHash, nowMs],
    );
    closureMembers.forEach((member, index) => {
      transaction.execute(
        `INSERT INTO workflow_registry_closure_members (
           closure_manifest_id, resource_id, resource_type, content_hash,
           member_index
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          closureId,
          member.resource_id,
          member.resource_type,
          member.content_hash,
          index,
        ],
      );
    });
    transaction.execute(
      `INSERT INTO workflow_registry_snapshots (
         id, snapshot_hash, closure_manifest_id, closure_hash,
         compiler_version, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        hash('snapshot', {
          closure_hash: closureHash,
          compiler_version: WORKFLOW_COMPILER_VERSION,
        }),
        closureId,
        closureHash,
        WORKFLOW_COMPILER_VERSION,
        nowMs,
      ],
    );
  });
  return 'initialized';
}
