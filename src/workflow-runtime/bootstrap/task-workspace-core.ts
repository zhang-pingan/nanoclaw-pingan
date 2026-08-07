import fs from 'node:fs';
import path from 'node:path';

import { compileWorkflow } from '../compiler/compiler.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

const CORE_OWNER = 'icarus.core.task-workspace@1.0.0';
const CORE_VERSION = '1.0.0';

function hash(kind: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(`icarus:task-workspace-core-${kind}:1\n`, value);
}

function rowId(resourceType: string, resourceId: string): string {
  return `registry-resource:${resourceType}:${resourceId}@${CORE_VERSION}`;
}

function valueId(resourceType: string, resourceId: string): string {
  return `registry-value:${resourceType}:${resourceId}@${CORE_VERSION}`;
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
  readonly content: JsonObject;
  readonly contentHash?: Sha256Hash;
}

function insertResource(
  transaction: WorkflowRuntimeWriteTransaction,
  resource: CoreResource,
  schemaRowId: string,
  schemaHash: Sha256Hash,
  nowMs: number,
): void {
  const id = rowId(resource.type, resource.id);
  const contentHash =
    resource.contentHash ??
    hash('resource', {
      resource_type: resource.type,
      resource_id: resource.id,
      resource_version: CORE_VERSION,
      content: resource.content,
    });
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
      valueId(resource.type, resource.id),
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
      CORE_VERSION,
      CORE_OWNER,
      valueId(resource.type, resource.id),
      contentHash,
      nowMs,
      nowMs,
    ],
  );
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
  const compiled = compileWorkflow({
    caseId: 'core.ad-hoc-personal-task.outer',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(fixture.source), 'utf8'),
    inputSnapshot: fixture.snapshot,
  });
  if (!compiled.ok) {
    throw new Error('Fixed Task Workspace Core outer Plan no longer compiles');
  }

  const genericSchema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:task-workspace:generic-json:1',
    title: 'Task Workspace JSON',
  };
  const genericSchemaHash = hash('resource', {
    resource_type: 'schema',
    resource_id: 'icarus.task-workspace.generic-json',
    resource_version: CORE_VERSION,
    content: genericSchema,
  });
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
    compiler_input_snapshot: fixture.snapshot,
  };

  const resources: CoreResource[] = [
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
    content: resource.content as JsonObject,
    contentHash: resource.content_hash as Sha256Hash,
  }));
  for (const resource of compilerResources) {
    if (
      !resources.some(
        (candidate) =>
          candidate.type === resource.type && candidate.id === resource.id,
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
    const closureId = 'registry-closure:icarus.task-workspace-core@1.0.0';
    const snapshotId = 'registry-snapshot:icarus.task-workspace-core@1.0.0';
    const closureMembers = resources.map((resource) => ({
      resource_id: rowId(resource.type, resource.id),
      resource_type: resource.type,
      content_hash:
        resource.contentHash ??
        hash('resource', {
          resource_type: resource.type,
          resource_id: resource.id,
          resource_version: CORE_VERSION,
          content: resource.content,
        }),
    }));
    const closureHash = hash('closure', closureMembers);
    const closureManifest: JsonObject = {
      format: 'icarus.workflow-registry-dependency-closure/1',
      ref: { id: 'icarus.task-workspace-core', version: CORE_VERSION },
      members: closureMembers,
      closure_hash: closureHash,
    };
    const manifestHash = hash('closure-manifest', closureManifest);
    const manifestValueId =
      'registry-value:closure:icarus.task-workspace-core@1.0.0';
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
