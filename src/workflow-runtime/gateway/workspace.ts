import crypto from 'node:crypto';

import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type { RuntimeRegistryRef } from '../contracts/g5-basic-runtime-types.js';
import { compileWorkflow } from '../compiler/compiler.js';
import { dynamicChildCompilerInputSnapshot } from '../compiler/dynamic-snapshot.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import {
  activatePersonalWorkflowRelease,
  publishPersonalWorkflowRelease,
  queryActivePersonalWorkflowReleases,
  type ActivePersonalWorkflowRelease,
  type PersonalWorkflowReleaseActivateResult,
  type PersonalWorkflowReleasePublishResult,
} from '../authoring/personal-workflow-registry.js';
import {
  buildDependencyClosure,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compareAscii,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceDependency,
  G3RegistryResourceRecord,
  G3RegistrySnapshot,
} from '../contracts/g3-registry-persistence-types.js';
import { buildDeploymentCapacityPublication } from '../contracts/capacity-control-plane-source.js';
import type { DeploymentRuntimeCapacitySnapshot } from '../contracts/capacity-control-plane-types.js';
import type { WorkflowRuntimeCommandDocument } from '../contracts/closed-schema-types.js';
import type { RuntimePermissionCode } from '../contracts/catalog-protocol-types.js';
import {
  calculateCreationIntentHash,
  createWorkflowT0,
  type T0CreationInput,
  type T0CreationReceipt,
} from '../creation/task-intake.js';
import {
  insertInlineValue,
  runtimeObjectHash,
  stableRuntimeId,
} from '../runtime/graph-store.js';
import {
  loadMaterializedNodeAuthority,
  requiredObjectField,
} from '../runtime/plan-authority.js';
import { submitRuntimeCommand } from '../runtime/commands.js';
import type { T6cWaitResolutionReceipt } from '../runtime/waits.js';
import { resolveWaitT6c } from '../runtime/waits.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';

export type WorkspaceRecipeKind = 'core' | 'feature' | 'personal';
export type WorkspaceLaunchPolicy = 'auto' | 'confirm' | 'manual_only';

export interface WorkspaceRecipeCatalogItemV1 {
  readonly recipe_kind: WorkspaceRecipeKind;
  readonly recipe_ref: VersionedRef;
  readonly recipe_hash: Sha256Hash;
  readonly display_name: string;
  readonly description: string | null;
  readonly launch_policy: WorkspaceLaunchPolicy;
  readonly input_summary: JsonObject;
  readonly selection_token: string;
}

export interface WorkspaceRecipeCatalogRequest {
  readonly principal_ref: string;
  readonly now_ms: number;
}

export interface WorkspaceRecipeCatalog {
  readonly format: 'icarus.workspace-recipe-catalog/1';
  readonly items: readonly WorkspaceRecipeCatalogItemV1[];
  readonly expires_at_ms: number;
}

export interface WorkspaceRecipeSelectionRefreshRequest {
  readonly principal_ref: string;
  readonly recipe_ref: VersionedRef;
  readonly recipe_hash: Sha256Hash;
  readonly now_ms: number;
}

export type WorkspacePublishedCreationInput = Omit<
  T0CreationInput,
  | 'source'
  | 'actor'
  | 'recipe'
  | 'entryPoint'
  | 'launchPolicy'
  | 'launchAuthorization'
>;

export interface WorkspacePublishedCreationRequest {
  readonly principal_ref: string;
  readonly selection_token: string;
  readonly authorization_ref: string;
  readonly creation: WorkspacePublishedCreationInput;
  readonly now_ms: number;
}

export interface WorkspaceLaunchCreationV1 {
  readonly request_id: string;
  readonly creation_domain: string;
  readonly creation_key: string;
  readonly effective_input_json: JsonValue;
  readonly effective_input_hash: Sha256Hash;
  readonly attachment_manifest_json: JsonValue;
  readonly attachment_manifest_hash: Sha256Hash;
  readonly deadline_at_ms: number | null;
}

export interface WorkspaceResolvedLaunchRequest {
  readonly principal_ref: string;
  readonly selection_token: string;
  readonly authorization_ref: string;
  readonly launch: WorkspaceLaunchCreationV1;
  readonly now_ms: number;
}

export interface WorkspaceResolvedTemporaryLaunchRequest extends WorkspaceResolvedLaunchRequest {
  readonly confirmed_revision_id: string;
  readonly confirmed_source_json: JsonObject;
  readonly confirmed_source_hash: Sha256Hash;
  readonly confirmed_plan_hash: Sha256Hash;
  readonly resource_closure_hash: Sha256Hash;
  readonly policy_ceiling_hash: Sha256Hash;
}

export interface WorkspaceTemporaryDraftRequest {
  readonly principal_ref: string;
  readonly selection_token: string;
  readonly source_json: JsonObject;
  readonly now_ms: number;
}

export interface WorkspaceTemporaryDraftCompilation {
  readonly format: 'icarus.workspace-temporary-draft-compilation/1';
  readonly source_hash: Sha256Hash;
  readonly compiled_plan_json: JsonObject;
  readonly compiled_plan_hash: Sha256Hash;
  readonly compiler_version: string;
  readonly resource_closure_hash: Sha256Hash;
  readonly policy_ceiling_hash: Sha256Hash;
  readonly risk_summary_json: JsonObject;
}

export interface WorkspaceTemporaryCreationRequest extends WorkspacePublishedCreationRequest {
  readonly confirmed_revision_id: string;
  readonly confirmed_source_hash: Sha256Hash;
  readonly confirmed_plan_hash: Sha256Hash;
  readonly resource_closure_hash: Sha256Hash;
  readonly policy_ceiling_hash: Sha256Hash;
}

export interface WorkspaceCreationLookup {
  readonly creation_domain: string;
  readonly creation_key: string;
  readonly principal_ref: string;
}

export interface WorkspaceCreationResult {
  readonly found: boolean;
  readonly workflow_id: string | null;
  readonly intake_id: string | null;
  readonly creation_request_id: string | null;
  readonly creation_intent_hash: Sha256Hash | null;
  readonly status: string | null;
}

export interface WorkspaceRuntimeDetailRequest {
  readonly principal_ref: string;
  readonly workflow_ids: readonly string[];
}

export interface WorkspaceRuntimeDetail {
  readonly format: 'icarus.workspace-runtime-detail/1';
  readonly freshness: 'ready' | 'degraded';
  readonly workflows: readonly JsonObject[];
}

export interface WorkspaceRuntimeEventRequest {
  readonly principal_ref: string;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly after_event_seq: number;
  readonly limit?: number;
}

export interface WorkspaceRuntimeEventPage {
  readonly format: 'icarus.workspace-runtime-event-page/1';
  readonly workflow_id: string;
  readonly run_id: string;
  readonly events: readonly JsonObject[];
  readonly next_event_seq: number;
  readonly has_more: boolean;
}

export interface WorkspaceInteractionRequest {
  readonly principal_ref: string;
  readonly interaction_id: string;
  readonly wait_id: string;
  readonly rendered_snapshot_hash: Sha256Hash;
  readonly action_id: string;
  readonly payload_json: JsonValue;
  readonly payload_hash: Sha256Hash;
  readonly expected_target_row_version: number;
  readonly idempotency_key: string;
  readonly now_ms: number;
}

export interface WorkspaceRuntimeCommandRequest {
  readonly principal_ref: string;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly action: 'pause' | 'resume' | 'cancel';
  readonly expected_target_row_version: number;
  readonly idempotency_key: string;
  readonly operation_ref: string;
  readonly now_ms: number;
}

export interface WorkspaceRuntimeCommandReceipt extends JsonObject {
  readonly format: 'icarus.workspace-runtime-command-receipt/1';
  readonly execution_result:
    | 'applied'
    | 'denied'
    | 'conflict'
    | 'duplicate'
    | 'late';
  readonly denial_code: string | null;
  readonly ingress_invocation_id: string;
  readonly command_id: string | null;
  readonly invocation_id: string | null;
  readonly canonical_result: JsonObject;
}

export interface WorkspacePersonalDraftExtractionRequest {
  readonly principal_ref: string;
  readonly workflow_id: string;
  readonly run_id: string;
}

export interface WorkspacePersonalDraftExtraction extends JsonObject {
  readonly format: 'icarus.workspace-personal-draft-extraction/1';
  readonly source_workflow_id: string;
  readonly source_run_id: string;
  readonly source_json: JsonObject;
  readonly source_hash: Sha256Hash;
  readonly compiled_plan_json: JsonObject;
  readonly compiled_plan_hash: Sha256Hash;
  readonly compiler_version: string;
}

export interface WorkspacePersonalDraftPreparationRequest {
  readonly principal_ref: string;
  readonly source_workflow_id: string;
  readonly source_run_id: string;
  readonly source_json: JsonObject;
}

export interface WorkspacePersonalReleasePublishRequest {
  readonly principal_ref: string;
  readonly personal_workflow_id: string;
  readonly release_ref: VersionedRef;
  readonly display_name: string;
  readonly description: string | null;
  readonly source_workflow_id: string;
  readonly source_run_id: string;
  readonly source_json: JsonObject;
  readonly expected_source_hash: Sha256Hash;
  readonly expected_plan_hash: Sha256Hash;
  readonly idempotency_key: string;
  readonly now_ms: number;
}

export interface WorkspacePersonalReleaseActivateRequest {
  readonly principal_ref: string;
  readonly personal_workflow_id: string;
  readonly release_id: string;
  readonly release_hash: Sha256Hash;
  readonly expected_pointer_row_version: number | null;
  readonly idempotency_key: string;
  readonly now_ms: number;
}

export interface WorkspaceTemporaryReplanPrepareRequest extends JsonObject {
  readonly principal_ref: string;
  readonly source_workflow_id: string;
  readonly source_activation_id: string;
  readonly source_run_id: string;
  readonly source_json: JsonObject;
  readonly idempotency_key: string;
  readonly now_ms: number;
}

export interface WorkspaceTemporaryReplanSourceAuthority extends JsonObject {
  readonly workflow_id: string;
  readonly workflow_row_version: number;
  readonly workflow_revision: number;
  readonly activation_id: string;
  readonly activation_row_version: number;
  readonly run_id: string;
  readonly run_row_version: number;
  readonly run_work_fence_epoch: number;
  readonly manifest_seq: number;
  readonly manifest_head_hash: Sha256Hash;
  readonly ledger_seq: number;
  readonly ledger_head_hash: Sha256Hash;
  readonly root_scope_id: string;
  readonly root_scope_row_version: number;
  readonly root_scope_work_fence_epoch: number;
  readonly event_seq: number;
  readonly state_config_value_id: string;
  readonly state_config_hash: Sha256Hash;
  readonly registry_snapshot_id: string;
  readonly registry_snapshot_hash: Sha256Hash;
  readonly closure_manifest_id: string;
  readonly closure_hash: Sha256Hash;
  readonly runtime_safety_snapshot_value_id: string;
  readonly runtime_safety_snapshot_hash: Sha256Hash;
  readonly input_snapshot_value_id: string;
  readonly input_snapshot_hash: Sha256Hash;
  readonly compiler_snapshot_hash: Sha256Hash;
  readonly context_snapshot_id: string;
  readonly context_snapshot_hash: Sha256Hash;
  readonly root_plan_hash: Sha256Hash;
  readonly frontier_hash: Sha256Hash;
  readonly effect_safety_hash: Sha256Hash;
}

export interface WorkspaceTemporaryReplanPreparation extends JsonObject {
  readonly format: 'icarus.workspace-temporary-replan-preparation/1';
  readonly proposal_hash: Sha256Hash;
  readonly replan_creation_key: string;
  readonly confirmation_ref: string;
  readonly confirmation_hash: Sha256Hash;
  readonly source_authority: WorkspaceTemporaryReplanSourceAuthority;
  readonly source_frontier_json: JsonObject;
  readonly effect_safety_json: JsonObject;
  readonly old_source_hash: Sha256Hash;
  readonly old_plan_hash: Sha256Hash;
  readonly new_source_json: JsonObject;
  readonly new_source_hash: Sha256Hash;
  readonly new_plan_json: JsonObject;
  readonly new_plan_hash: Sha256Hash;
  readonly diff_json: JsonObject;
  readonly risk_summary_json: JsonObject;
}

export interface WorkspaceTemporaryReplanApplyRequest extends JsonObject {
  readonly principal_ref: string;
  readonly preparation: WorkspaceTemporaryReplanPreparation;
  readonly confirmation_ref: string;
  readonly confirmation_hash: Sha256Hash;
  readonly now_ms: number;
}

export interface WorkspaceTemporaryReplanReconcileRequest extends JsonObject {
  readonly principal_ref: string;
  readonly source_workflow_id: string;
  readonly source_activation_id: string;
  readonly source_run_id: string;
  readonly replan_creation_key: string;
  readonly proposal_hash: Sha256Hash;
  readonly confirmation_ref: string;
  readonly confirmation_hash: Sha256Hash;
}

export interface WorkspaceReplanReceipt extends JsonObject {
  readonly format: 'icarus.workspace-temporary-replan-receipt/1';
  readonly disposition: 'applying' | 'applied' | 'duplicate' | 'denied';
  readonly code: string;
  readonly source_workflow_id: string;
  readonly source_activation_id: string;
  readonly source_run_id: string;
  readonly proposal_hash: Sha256Hash;
  readonly replan_creation_key: string;
  readonly confirmation_ref: string;
  readonly confirmation_hash: Sha256Hash;
  readonly source_fence_receipt: JsonObject | null;
  readonly target_activation_id: string | null;
  readonly target_run_id: string | null;
}

export class RuntimeWorkspaceGatewayError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'selection_stale'
      | 'permission_denied'
      | 'target_not_found'
      | 'lineage_mismatch'
      | 'active_attempt_unsafe'
      | 'effect_state_unsafe'
      | 'operational_blocked'
      | 'integrity_quarantine'
      | 'unsupported_by_temporary_workflow',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeWorkspaceGatewayError';
  }
}

interface SelectionTokenPayload extends JsonObject {
  readonly format: 'icarus.workspace-recipe-selection/1';
  readonly principal_ref: string;
  readonly recipe_row_id: string;
  readonly recipe_ref: VersionedRef;
  readonly recipe_hash: Sha256Hash;
  readonly entry_point: string;
  readonly launch_policy: WorkspaceLaunchPolicy;
  readonly personal_release_id: string | null;
  readonly personal_release_hash: Sha256Hash | null;
  readonly personal_pointer_row_version: number | null;
  readonly personal_registry_snapshot_id: string | null;
  readonly personal_registry_snapshot_hash: Sha256Hash | null;
  readonly personal_compiled_plan_hash: Sha256Hash | null;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

interface RecipeRow extends Record<string, unknown> {
  id: string;
  resource_id: string;
  resource_version: string;
  owner_core_ref: string | null;
  owner_feature_id: string | null;
  owner_principal_ref: string | null;
  content_hash: Sha256Hash;
  publication_state: string;
  inline_canonical_json: string;
}

export interface RuntimeWorkspaceGatewayOptions {
  readonly token_ttl_ms?: number;
  readonly on_runtime_commit?: (hint: {
    readonly workflow_id: string;
    readonly run_id?: string;
  }) => void;
}

function assertPrincipal(value: string): void {
  if (!value || value.length > 512) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'A bounded authenticated principal is required',
    );
  }
}

const WORKSPACE_INTERACTION_KEYS = [
  'principal_ref',
  'interaction_id',
  'wait_id',
  'rendered_snapshot_hash',
  'action_id',
  'payload_json',
  'payload_hash',
  'expected_target_row_version',
  'idempotency_key',
  'now_ms',
] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_COMMAND_KEYS = [
  'principal_ref',
  'workflow_id',
  'run_id',
  'action',
  'expected_target_row_version',
  'idempotency_key',
  'operation_ref',
  'now_ms',
] as const;
const WORKSPACE_REPLAN_PREPARE_KEYS = [
  'principal_ref',
  'source_workflow_id',
  'source_activation_id',
  'source_run_id',
  'source_json',
  'idempotency_key',
  'now_ms',
] as const;
const WORKSPACE_REPLAN_APPLY_KEYS = [
  'principal_ref',
  'preparation',
  'confirmation_ref',
  'confirmation_hash',
  'now_ms',
] as const;
const WORKSPACE_REPLAN_RECONCILE_KEYS = [
  'principal_ref',
  'source_workflow_id',
  'source_activation_id',
  'source_run_id',
  'replan_creation_key',
  'proposal_hash',
  'confirmation_ref',
  'confirmation_hash',
] as const;
const WORKSPACE_REPLAN_PREPARATION_KEYS = [
  'format',
  'proposal_hash',
  'replan_creation_key',
  'confirmation_ref',
  'confirmation_hash',
  'source_authority',
  'source_frontier_json',
  'effect_safety_json',
  'old_source_hash',
  'old_plan_hash',
  'new_source_json',
  'new_source_hash',
  'new_plan_json',
  'new_plan_hash',
  'diff_json',
  'risk_summary_json',
] as const;
const WORKSPACE_REPLAN_SOURCE_AUTHORITY_KEYS = [
  'workflow_id',
  'workflow_row_version',
  'workflow_revision',
  'activation_id',
  'activation_row_version',
  'run_id',
  'run_row_version',
  'run_work_fence_epoch',
  'manifest_seq',
  'manifest_head_hash',
  'ledger_seq',
  'ledger_head_hash',
  'root_scope_id',
  'root_scope_row_version',
  'root_scope_work_fence_epoch',
  'event_seq',
  'state_config_value_id',
  'state_config_hash',
  'registry_snapshot_id',
  'registry_snapshot_hash',
  'closure_manifest_id',
  'closure_hash',
  'runtime_safety_snapshot_value_id',
  'runtime_safety_snapshot_hash',
  'input_snapshot_value_id',
  'input_snapshot_hash',
  'compiler_snapshot_hash',
  'context_snapshot_id',
  'context_snapshot_hash',
  'root_plan_hash',
  'frontier_hash',
  'effect_safety_hash',
] as const;

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      `${label} is not a closed document`,
    );
  }
}

function assertBoundedReplanText(label: string, value: string): void {
  if (!value || value.length > 512) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      `${label} is invalid`,
    );
  }
}

function assertWorkspaceTemporaryReplanPrepareRequest(
  request: WorkspaceTemporaryReplanPrepareRequest,
): void {
  assertExactKeys(
    request,
    WORKSPACE_REPLAN_PREPARE_KEYS,
    'Replan prepare request',
  );
  assertPrincipal(request.principal_ref);
  for (const [label, value] of [
    ['source_workflow_id', request.source_workflow_id],
    ['source_activation_id', request.source_activation_id],
    ['source_run_id', request.source_run_id],
    ['idempotency_key', request.idempotency_key],
  ] as const) {
    assertBoundedReplanText(label, value);
  }
  if (!isObject(request.source_json)) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan source must be a JSON object',
    );
  }
  try {
    canonicalJson(request.source_json);
  } catch {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan source is not canonical JSON',
    );
  }
  if (!Number.isSafeInteger(request.now_ms) || request.now_ms < 0) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan prepare time is invalid',
    );
  }
}

function assertWorkspaceTemporaryReplanPreparation(
  preparation: WorkspaceTemporaryReplanPreparation,
): void {
  assertExactKeys(
    preparation,
    WORKSPACE_REPLAN_PREPARATION_KEYS,
    'Replan preparation',
  );
  if (
    preparation.format !== 'icarus.workspace-temporary-replan-preparation/1' ||
    !isObject(preparation.source_authority) ||
    !isObject(preparation.source_frontier_json) ||
    !isObject(preparation.effect_safety_json) ||
    !isObject(preparation.new_source_json) ||
    !isObject(preparation.new_plan_json) ||
    !isObject(preparation.diff_json) ||
    !isObject(preparation.risk_summary_json)
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan preparation shape is invalid',
    );
  }
  assertExactKeys(
    preparation.source_authority,
    WORKSPACE_REPLAN_SOURCE_AUTHORITY_KEYS,
    'Replan source authority',
  );
  for (const value of [
    preparation.proposal_hash,
    preparation.confirmation_hash,
    preparation.old_source_hash,
    preparation.old_plan_hash,
    preparation.new_source_hash,
    preparation.new_plan_hash,
    preparation.source_authority.state_config_hash,
    preparation.source_authority.registry_snapshot_hash,
    preparation.source_authority.closure_hash,
    preparation.source_authority.runtime_safety_snapshot_hash,
    preparation.source_authority.input_snapshot_hash,
    preparation.source_authority.compiler_snapshot_hash,
    preparation.source_authority.manifest_head_hash,
    preparation.source_authority.ledger_head_hash,
    preparation.source_authority.context_snapshot_hash,
    preparation.source_authority.root_plan_hash,
    preparation.source_authority.frontier_hash,
    preparation.source_authority.effect_safety_hash,
  ]) {
    if (!SHA256_PATTERN.test(value)) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Replan preparation contains an invalid authority hash',
      );
    }
  }
  assertBoundedReplanText(
    'replan_creation_key',
    preparation.replan_creation_key,
  );
  assertBoundedReplanText('confirmation_ref', preparation.confirmation_ref);
}

function assertWorkspaceTemporaryReplanApplyRequest(
  request: WorkspaceTemporaryReplanApplyRequest,
): void {
  assertExactKeys(request, WORKSPACE_REPLAN_APPLY_KEYS, 'Replan apply request');
  assertPrincipal(request.principal_ref);
  assertWorkspaceTemporaryReplanPreparation(request.preparation);
  assertBoundedReplanText('confirmation_ref', request.confirmation_ref);
  if (
    !SHA256_PATTERN.test(request.confirmation_hash) ||
    !Number.isSafeInteger(request.now_ms) ||
    request.now_ms < 0
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan confirmation hash or apply time is invalid',
    );
  }
}

function assertWorkspaceTemporaryReplanReconcileRequest(
  request: WorkspaceTemporaryReplanReconcileRequest,
): void {
  assertExactKeys(
    request,
    WORKSPACE_REPLAN_RECONCILE_KEYS,
    'Replan reconcile request',
  );
  assertPrincipal(request.principal_ref);
  for (const [label, value] of [
    ['source_workflow_id', request.source_workflow_id],
    ['source_activation_id', request.source_activation_id],
    ['source_run_id', request.source_run_id],
    ['replan_creation_key', request.replan_creation_key],
    ['confirmation_ref', request.confirmation_ref],
  ] as const) {
    assertBoundedReplanText(label, value);
  }
  if (
    !SHA256_PATTERN.test(request.proposal_hash) ||
    !SHA256_PATTERN.test(request.confirmation_hash)
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Replan reconcile identity hash is invalid',
    );
  }
}

export function calculateWorkspaceTemporaryReplanConfirmationHash(input: {
  readonly principal_ref: string;
  readonly source_workflow_id: string;
  readonly source_activation_id: string;
  readonly source_run_id: string;
  readonly replan_creation_key: string;
  readonly proposal_hash: Sha256Hash;
  readonly confirmation_ref: string;
}): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:task-workspace:temporary-replan-confirmation:1\n',
    {
      format: 'icarus.workspace-temporary-replan-confirmation/1',
      ...input,
    },
  );
}

export function calculateWorkspaceInteractionPayloadHash(
  payload: JsonValue,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:task-workspace:interaction-payload:1\n',
    payload,
  );
}

function assertWorkspaceInteractionRequest(
  request: WorkspaceInteractionRequest,
): void {
  const keys = Object.keys(request).sort();
  const expected = [...WORKSPACE_INTERACTION_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace interaction request is not a closed document',
    );
  }
  assertPrincipal(request.principal_ref);
  for (const [label, value, maximum] of [
    ['interaction_id', request.interaction_id, 512],
    ['wait_id', request.wait_id, 512],
    ['action_id', request.action_id, 255],
    ['idempotency_key', request.idempotency_key, 512],
  ] as const) {
    if (!value || value.length > maximum) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        `${label} is invalid`,
      );
    }
  }
  if (
    !SHA256_PATTERN.test(request.rendered_snapshot_hash) ||
    !SHA256_PATTERN.test(request.payload_hash) ||
    !Number.isSafeInteger(request.expected_target_row_version) ||
    request.expected_target_row_version < 0 ||
    !Number.isSafeInteger(request.now_ms) ||
    request.now_ms < 0
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace interaction hashes, row version, or timestamp are invalid',
    );
  }
  let observedPayloadHash: Sha256Hash;
  try {
    canonicalJson(request.payload_json);
    observedPayloadHash = calculateWorkspaceInteractionPayloadHash(
      request.payload_json,
    );
  } catch {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace interaction payload is not canonical JSON',
    );
  }
  if (observedPayloadHash !== request.payload_hash) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace interaction payload hash mismatch',
    );
  }
}

function assertWorkspaceCommandRequest(
  request: WorkspaceRuntimeCommandRequest,
): void {
  const keys = Object.keys(request).sort();
  const expected = [...WORKSPACE_COMMAND_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace Runtime command request is not a closed document',
    );
  }
  assertPrincipal(request.principal_ref);
  if (
    !request.workflow_id ||
    request.workflow_id.length > 512 ||
    !request.run_id ||
    request.run_id.length > 512 ||
    !['pause', 'resume', 'cancel'].includes(request.action) ||
    !Number.isSafeInteger(request.expected_target_row_version) ||
    request.expected_target_row_version < 1 ||
    !request.idempotency_key ||
    request.idempotency_key.length > 512 ||
    !request.operation_ref ||
    request.operation_ref.length > 512 ||
    !Number.isSafeInteger(request.now_ms) ||
    request.now_ms < 0
  ) {
    throw new RuntimeWorkspaceGatewayError(
      'invalid_request',
      'Workspace Runtime command fields are invalid',
    );
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseStoredJson(value: unknown): JsonValue | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function stringField(value: JsonObject | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' ? field : null;
}

function workspaceArtifactHash(input: {
  resultHash: Sha256Hash;
  artifactIndex: number;
  artifact: JsonObject;
}): Sha256Hash {
  const supplied = stringField(input.artifact, 'sha256');
  if (supplied && SHA256_PATTERN.test(supplied)) return supplied as Sha256Hash;
  if (supplied && /^[0-9a-f]{64}$/.test(supplied)) {
    return `sha256:${supplied}` as Sha256Hash;
  }
  return domainSeparatedSha256(
    'icarus:workspace-runtime-artifact-metadata:1\n',
    {
      result_hash: input.resultHash,
      artifact_index: input.artifactIndex,
      artifact: input.artifact,
    },
  );
}

function recipeKind(row: RecipeRow, content: JsonObject): WorkspaceRecipeKind {
  return row.owner_principal_ref ||
    typeof content.owner_principal_ref === 'string'
    ? 'personal'
    : row.owner_feature_id
      ? 'feature'
      : 'core';
}

export class RuntimeWorkspaceGateway {
  private readonly tokenTtlMs: number;

  constructor(
    private readonly store: WorkflowRuntimeStore,
    private readonly tokenSecret: Buffer,
    private readonly options: RuntimeWorkspaceGatewayOptions = {},
  ) {
    if (tokenSecret.byteLength < 32) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Workspace selection token secret must contain at least 32 bytes',
      );
    }
    this.tokenTtlMs = options.token_ttl_ms ?? 5 * 60_000;
  }

  private sign(payload: SelectionTokenPayload): string {
    const body = Buffer.from(canonicalJson(payload), 'utf8').toString(
      'base64url',
    );
    const signature = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(body, 'ascii')
      .digest('base64url');
    return `${body}.${signature}`;
  }

  private verify(
    token: string,
    principalRef: string,
    nowMs: number,
  ): SelectionTokenPayload {
    const [body, suppliedSignature, extra] = token.split('.');
    if (!body || !suppliedSignature || extra !== undefined) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Recipe selection token is malformed',
      );
    }
    const expected = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(body, 'ascii')
      .digest();
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    if (
      supplied.byteLength !== expected.byteLength ||
      !crypto.timingSafeEqual(supplied, expected)
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Recipe selection signature is invalid',
      );
    }
    let payload: SelectionTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Recipe selection payload is invalid',
      );
    }
    if (
      payload.format !== 'icarus.workspace-recipe-selection/1' ||
      payload.principal_ref !== principalRef ||
      payload.expires_at_ms <= nowMs ||
      payload.issued_at_ms > nowMs ||
      !isObject(payload.recipe_ref) ||
      typeof payload.entry_point !== 'string' ||
      !['auto', 'confirm', 'manual_only'].includes(payload.launch_policy)
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Recipe selection is stale or belongs to another principal',
      );
    }
    return payload;
  }

  private recipeRows(): RecipeRow[] {
    return this.store.queryAll<RecipeRow>(
      `SELECT rr.id, rr.resource_id, rr.resource_version, rr.owner_core_ref,
              rr.owner_feature_id, rr.owner_principal_ref, rr.content_hash,
              rr.publication_state,
              v.inline_canonical_json
         FROM workflow_registry_resources rr
         JOIN workflow_values v ON v.id = rr.canonical_value_id
        WHERE rr.resource_type = 'recipe'
          AND rr.publication_state = 'published'
          AND v.storage_kind = 'inline' AND v.payload_state = 'live'
        ORDER BY rr.resource_id COLLATE BINARY, rr.resource_version COLLATE BINARY DESC`,
      [],
    );
  }

  private assertActiveRecipe(payload: SelectionTokenPayload): RecipeRow {
    const row = this.recipeRows().find(
      (candidate) => candidate.id === payload.recipe_row_id,
    );
    if (
      !row ||
      row.content_hash !== payload.recipe_hash ||
      row.resource_id !== payload.recipe_ref.id ||
      row.resource_version !== payload.recipe_ref.version
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'The selected exact Recipe is no longer active',
      );
    }
    const content = JSON.parse(row.inline_canonical_json) as JsonObject;
    if (
      content.entry_point !== payload.entry_point ||
      content.launch_policy !== payload.launch_policy ||
      (row.owner_principal_ref !== null &&
        row.owner_principal_ref !== payload.principal_ref) ||
      (typeof content.owner_principal_ref === 'string' &&
        content.owner_principal_ref !== payload.principal_ref)
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Recipe selection identity drifted',
      );
    }
    if (row.owner_feature_id) {
      const active = this.store.queryOne<{ found: number }>(
        `SELECT 1 AS found
           FROM workflow_feature_active_releases ar
           JOIN workflow_feature_release_resources r ON r.release_id = ar.release_id
          WHERE ar.feature_id = ? AND r.resource_id = ? AND r.content_hash = ?
          LIMIT 1`,
        [row.owner_feature_id, row.id, row.content_hash],
      );
      if (!active) {
        throw new RuntimeWorkspaceGatewayError(
          'selection_stale',
          'Feature Recipe is disabled or no longer active',
        );
      }
    }
    if (row.owner_principal_ref) {
      const active = this.store.queryOne<{
        release_id: string;
        release_hash: Sha256Hash;
        registry_snapshot_id: string;
        registry_snapshot_hash: Sha256Hash;
        compiled_plan_hash: Sha256Hash;
        row_version: number;
      }>(
        `SELECT active.release_id, active.release_hash,
                release.registry_snapshot_id, release.registry_snapshot_hash,
                release.compiled_plan_hash, active.row_version
           FROM workflow_personal_active_releases active
           JOIN workflow_personal_releases release
             ON release.id = active.release_id
            AND release.release_hash = active.release_hash
           JOIN workflow_personal_release_resources resource
             ON resource.release_id = release.id
            AND resource.resource_role = 'recipe'
          WHERE active.owner_principal_ref = ?
            AND resource.resource_id = ? AND resource.content_hash = ?
            AND release.status = 'active'`,
        [payload.principal_ref, row.id, row.content_hash],
      );
      if (
        !active ||
        active.release_id !== payload.personal_release_id ||
        active.release_hash !== payload.personal_release_hash ||
        active.row_version !== payload.personal_pointer_row_version ||
        active.registry_snapshot_id !== payload.personal_registry_snapshot_id ||
        active.registry_snapshot_hash !==
          payload.personal_registry_snapshot_hash ||
        active.compiled_plan_hash !== payload.personal_compiled_plan_hash
      ) {
        throw new RuntimeWorkspaceGatewayError(
          'selection_stale',
          'Personal Recipe Release is no longer active',
        );
      }
    }
    return row;
  }

  private activePersonalRelease(
    selection: SelectionTokenPayload,
    recipeRow: RecipeRow,
  ): ActivePersonalWorkflowRelease & {
    readonly source_json: JsonObject;
    readonly source_hash: Sha256Hash;
    readonly closure_id: string;
    readonly closure_hash: Sha256Hash;
  } {
    const release = queryActivePersonalWorkflowReleases(
      this.store,
      selection.principal_ref,
    ).find(
      (candidate) =>
        candidate.release_id === selection.personal_release_id &&
        candidate.release_hash === selection.personal_release_hash &&
        candidate.recipe_ref.id === recipeRow.resource_id &&
        candidate.recipe_ref.version === recipeRow.resource_version &&
        candidate.recipe_hash === recipeRow.content_hash,
    );
    const snapshot = release
      ? this.store.queryOne<{
          closure_manifest_id: string;
          closure_hash: Sha256Hash;
        }>(
          `SELECT closure_manifest_id, closure_hash
             FROM workflow_registry_snapshots
            WHERE id = ? AND snapshot_hash = ?`,
          [release.registry_snapshot_id, release.registry_snapshot_hash],
        )
      : null;
    if (!release || !snapshot) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'Personal Recipe Release snapshot is unavailable',
      );
    }
    const sourceJson = this.resourceContent(
      this.resourceByRef('graph_template', release.graph_template_ref),
    );
    return {
      ...release,
      source_json: sourceJson,
      source_hash: domainSeparatedSha256(
        'icarus:workflow-graph-source:1\n',
        sourceJson,
      ),
      closure_id: snapshot.closure_manifest_id,
      closure_hash: snapshot.closure_hash,
    };
  }

  private temporaryDynamicAuthority(
    principalRef: string,
    workflowId: string,
    runId: string,
  ): {
    readonly source: JsonObject;
    readonly sourceHash: Sha256Hash;
    readonly plan: JsonObject;
    readonly planHash: Sha256Hash;
    readonly compilerInput: JsonObject;
    readonly ownerNode: JsonObject;
  } {
    assertPrincipal(principalRef);
    const row = this.store.queryOne<{
      owner_principal_ref: string;
      recipe_id: string;
      workflow_status: string;
      workflow_outcome_kind: string | null;
      lifecycle: string;
      outcome_kind: string | null;
      state_config_json: string;
      source_json: string;
      source_hash: Sha256Hash;
      compiled_plan_json: string | null;
      compiled_plan_value_json: string | null;
      plan_hash: Sha256Hash;
      owner_node_json: string;
    }>(
      `SELECT workflow.owner_principal_ref, recipe.resource_id AS recipe_id,
              workflow.status AS workflow_status,
              workflow.final_outcome_kind AS workflow_outcome_kind,
              run.lifecycle, run.outcome_kind,
              state_config.inline_canonical_json AS state_config_json,
              source.inline_canonical_json AS source_json,
              build.source_snapshot_hash AS source_hash,
              plan.compiled_plan_json,
              plan_value.inline_canonical_json AS compiled_plan_value_json,
              plan.plan_hash, owner.normalized_node_json AS owner_node_json
         FROM workflows workflow
         JOIN workflow_registry_resources recipe
           ON recipe.id = workflow.recipe_resource_id
          AND recipe.content_hash = workflow.recipe_resource_hash
         JOIN workflow_graph_runs run
           ON run.workflow_id = workflow.id AND run.id = ?
         JOIN workflow_values state_config
           ON state_config.id = run.state_config_value_id
          AND state_config.content_hash = run.state_config_hash
         JOIN workflow_graph_scope_builds build
           ON build.graph_run_id = run.id
          AND build.owner_scope_id = run.root_scope_id
          AND build.scope_kind = 'expansion'
         JOIN workflow_graph_nodes owner
           ON owner.graph_run_id = build.graph_run_id
          AND owner.scope_id = build.owner_scope_id
          AND owner.id = build.owner_node_id
         JOIN workflow_values source
           ON source.id = build.source_snapshot_value_id
          AND source.content_hash = build.source_snapshot_hash
         JOIN workflow_graph_scope_plans plan
           ON plan.id = build.compiled_plan_id
          AND plan.plan_hash = build.compiled_plan_hash
    LEFT JOIN workflow_values plan_value
           ON plan_value.id = plan.compiled_plan_value_id
          AND plan_value.content_hash = plan.plan_hash
        WHERE workflow.id = ?
          AND state_config.payload_state = 'live'
          AND source.payload_state = 'live'
        ORDER BY build.created_at_ms, build.id COLLATE BINARY LIMIT 1`,
      [runId, workflowId],
    );
    const stateConfig = row
      ? (JSON.parse(row.state_config_json) as JsonObject)
      : null;
    const confirmation = stateConfig?.temporary_confirmation;
    const compilerInput = isObject(stateConfig?.compiler_input_snapshot)
      ? stateConfig.compiler_input_snapshot
      : null;
    if (
      !row ||
      row.owner_principal_ref !== principalRef ||
      row.recipe_id !== 'ad_hoc_personal_task' ||
      row.workflow_status !== 'completed' ||
      row.workflow_outcome_kind !== 'normal' ||
      row.lifecycle !== 'closed' ||
      row.outcome_kind !== 'completed' ||
      !isObject(confirmation) ||
      confirmation.format !== 'icarus.temporary-workflow-confirmation/1' ||
      !compilerInput
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Personal Workflow extraction requires a successful Temporary Run',
      );
    }
    const source = JSON.parse(row.source_json) as JsonObject;
    const planJson = row.compiled_plan_json ?? row.compiled_plan_value_json;
    if (!planJson) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Temporary Dynamic Child compiled Plan is unavailable',
      );
    }
    const plan = JSON.parse(planJson) as JsonObject;
    const sourceHash = domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      source,
    );
    if (
      sourceHash !== row.source_hash ||
      plan.plan_hash !== row.plan_hash ||
      plan.source_hash !== sourceHash
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Temporary Dynamic Child source or Plan authority drifted',
      );
    }
    return {
      source,
      sourceHash,
      plan,
      planHash: row.plan_hash,
      compilerInput,
      ownerNode: JSON.parse(row.owner_node_json) as JsonObject,
    };
  }

  private compilePersonalSource(
    principalRef: string,
    workflowId: string,
    runId: string,
    source: JsonObject,
  ): WorkspaceTemporaryDraftCompilation {
    const authority = this.temporaryDynamicAuthority(
      principalRef,
      workflowId,
      runId,
    );
    const outcome = compileWorkflow({
      caseId: `workspace-personal:${workflowId}:${runId}`,
      sourceKind: 'graph_scope',
      rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
      inputSnapshot: dynamicChildCompilerInputSnapshot(
        authority.compilerInput,
        authority.ownerNode,
      ),
    });
    if (!outcome.ok) {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        `Personal Workflow source failed compile: ${canonicalJson(
          outcome.value.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            phase: diagnostic.phase,
            pointer: diagnostic.pointer,
          })),
        )}`,
      );
    }
    const plan = outcome.value.plan as unknown as JsonObject;
    const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
    return {
      format: 'icarus.workspace-temporary-draft-compilation/1',
      source_hash: outcome.value.sourceHash,
      compiled_plan_json: plan,
      compiled_plan_hash: outcome.value.plan.plan_hash as Sha256Hash,
      compiler_version: WORKFLOW_COMPILER_VERSION,
      resource_closure_hash: domainSeparatedSha256(
        'icarus:workspace-personal-source-authority:1\n',
        {
          source_workflow_id: workflowId,
          source_run_id: runId,
          source_hash: outcome.value.sourceHash,
          plan_hash: outcome.value.plan.plan_hash,
        },
      ),
      policy_ceiling_hash: domainSeparatedSha256(
        'icarus:workspace-personal-policy-ceiling:1\n',
        {
          compiler_snapshot_hash: authority.compilerInput.snapshot_hash ?? null,
          owner_policy_hash:
            isObject(authority.ownerNode.child_policy) &&
            typeof authority.ownerNode.child_policy.effective_policy_hash ===
              'string'
              ? authority.ownerNode.child_policy.effective_policy_hash
              : null,
        },
      ),
      risk_summary_json: {
        effect_ceiling: 'read_only',
        node_count: nodes.length,
        requested_limits: source.requested_limits ?? null,
      },
    };
  }

  prepareTemporaryReplan(
    request: WorkspaceTemporaryReplanPrepareRequest,
  ): WorkspaceTemporaryReplanPreparation {
    assertWorkspaceTemporaryReplanPrepareRequest(request);
    const source = this.store.queryOne<{
      owner_principal_ref: string;
      workflow_status: string;
      workflow_operational_state: string;
      workflow_row_version: number;
      workflow_revision: number;
      current_state_instance_id: string;
      current_graph_run_id: string | null;
      context_snapshot_id: string;
      context_snapshot_hash: Sha256Hash;
      workflow_input_value_id: string;
      workflow_input_hash: Sha256Hash;
      recipe_id: string;
      activation_status: string;
      activation_row_version: number;
      state_key: string;
      run_lifecycle: string;
      run_control: string;
      run_operational_state: string;
      run_row_version: number;
      run_work_fence_epoch: number;
      manifest_seq: number;
      manifest_head_hash: Sha256Hash;
      ledger_seq: number;
      ledger_head_hash: Sha256Hash;
      next_event_seq: number;
      root_close_request_id: string | null;
      run_completion_cut_id: string | null;
      run_outcome_kind: string | null;
      root_scope_id: string;
      root_scope_lifecycle: string;
      root_scope_row_version: number;
      root_scope_work_fence_epoch: number;
      root_scope_close_request_id: string | null;
      state_config_value_id: string;
      state_config_hash: Sha256Hash;
      state_config_json: string;
      registry_snapshot_id: string;
      registry_snapshot_hash: Sha256Hash;
      closure_manifest_id: string;
      closure_hash: Sha256Hash;
      runtime_safety_snapshot_value_id: string;
      runtime_safety_snapshot_hash: Sha256Hash;
      input_snapshot_value_id: string;
      input_snapshot_hash: Sha256Hash;
      compiler_snapshot_hash: Sha256Hash;
      root_plan_hash: Sha256Hash | null;
      root_plan_json: string | null;
      root_plan_value_json: string | null;
      definition_json: string;
    }>(
      `SELECT workflow.owner_principal_ref,
              workflow.status AS workflow_status,
              workflow.operational_state AS workflow_operational_state,
              workflow.row_version AS workflow_row_version,
              workflow.workflow_revision,
              workflow.state_instance_id AS current_state_instance_id,
              workflow.current_graph_run_id,
              workflow.current_context_snapshot_id AS context_snapshot_id,
              workflow.current_context_snapshot_hash AS context_snapshot_hash,
              workflow.workflow_input_value_id,
              workflow.workflow_input_hash,
              recipe.resource_id AS recipe_id,
              activation.status AS activation_status,
              activation.row_version AS activation_row_version,
              run.state_key, run.lifecycle AS run_lifecycle,
              run.control AS run_control,
              run.operational_state AS run_operational_state,
              run.row_version AS run_row_version,
              run.work_fence_epoch AS run_work_fence_epoch,
              run.manifest_seq, run.manifest_head_hash,
              run.ledger_seq, run.ledger_head_hash,
              run.next_event_seq, run.root_scope_id,
              run.root_close_request_id,
              run.completion_cut_id AS run_completion_cut_id,
              run.outcome_kind AS run_outcome_kind,
              root.lifecycle AS root_scope_lifecycle,
              root.row_version AS root_scope_row_version,
              root.work_fence_epoch AS root_scope_work_fence_epoch,
              root.close_request_id AS root_scope_close_request_id,
              run.state_config_value_id, run.state_config_hash,
              state_config.inline_canonical_json AS state_config_json,
              run.registry_snapshot_id, run.registry_snapshot_hash,
              snapshot.closure_manifest_id, snapshot.closure_hash,
              run.runtime_safety_snapshot_value_id,
              run.runtime_safety_snapshot_hash,
              root.input_snapshot_value_id, root.input_snapshot_hash,
              root_build.compiler_snapshot_hash,
              run.root_plan_hash, plan.compiled_plan_json AS root_plan_json,
              plan_value.inline_canonical_json AS root_plan_value_json,
              definition_value.inline_canonical_json AS definition_json
         FROM workflows workflow
         JOIN workflow_registry_resources recipe
           ON recipe.id = workflow.recipe_resource_id
          AND recipe.content_hash = workflow.recipe_resource_hash
         JOIN workflow_state_activations activation
           ON activation.workflow_id = workflow.id
          AND activation.id = ?
         JOIN workflow_graph_runs run
           ON run.workflow_id = workflow.id
          AND run.state_instance_id = activation.id
          AND run.id = ?
         JOIN workflow_graph_scopes root
           ON root.graph_run_id = run.id AND root.id = run.root_scope_id
         JOIN workflow_values state_config
           ON state_config.id = run.state_config_value_id
          AND state_config.content_hash = run.state_config_hash
          AND state_config.payload_state = 'live'
         JOIN workflow_registry_snapshots snapshot
           ON snapshot.id = run.registry_snapshot_id
          AND snapshot.snapshot_hash = run.registry_snapshot_hash
         JOIN workflow_graph_scope_builds root_build
           ON root_build.id = run.root_build_id
          AND root_build.graph_run_id = run.id
          AND root_build.scope_kind = 'root'
          AND root_build.status = 'materialized'
         JOIN workflow_graph_scope_plans plan
           ON plan.id = root_build.compiled_plan_id
          AND plan.graph_run_id = run.id
          AND plan.plan_hash = root_build.compiled_plan_hash
          AND plan.plan_hash = run.root_plan_hash
    LEFT JOIN workflow_values plan_value
           ON plan_value.id = plan.compiled_plan_value_id
          AND plan_value.content_hash = plan.plan_hash
         JOIN workflow_registry_resources definition
           ON definition.id = activation.workflow_definition_resource_id
          AND definition.content_hash = activation.workflow_definition_resource_hash
          AND definition.publication_state = 'published'
         JOIN workflow_values definition_value
           ON definition_value.id = definition.canonical_value_id
          AND definition_value.content_hash = definition.content_hash
          AND definition_value.payload_state = 'live'
        WHERE workflow.id = ?`,
      [
        request.source_activation_id,
        request.source_run_id,
        request.source_workflow_id,
      ],
    );
    if (!source) {
      throw new RuntimeWorkspaceGatewayError(
        'target_not_found',
        'Temporary Replan source authority is unavailable',
      );
    }
    if (source.owner_principal_ref !== request.principal_ref) {
      throw new RuntimeWorkspaceGatewayError(
        'permission_denied',
        'Temporary Replan source belongs to another principal',
      );
    }
    if (
      source.workflow_status !== 'active' ||
      source.current_state_instance_id !== request.source_activation_id ||
      source.current_graph_run_id !== request.source_run_id ||
      source.activation_status !== 'active' ||
      !['initializing', 'executing'].includes(source.run_lifecycle) ||
      source.run_control !== 'running' ||
      source.root_close_request_id !== null ||
      source.run_completion_cut_id !== null ||
      source.run_outcome_kind !== null ||
      source.root_scope_lifecycle !== 'active' ||
      source.root_scope_close_request_id !== null
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Temporary Replan requires the exact unfenced current source Run',
      );
    }
    if (
      source.workflow_operational_state === 'quarantined' ||
      source.run_operational_state === 'quarantined'
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'integrity_quarantine',
        'Temporary Replan is denied while source integrity is quarantined',
      );
    }
    if (
      source.workflow_operational_state !== 'healthy' ||
      source.run_operational_state !== 'healthy'
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'operational_blocked',
        'Temporary Replan is denied while source operation is blocked',
      );
    }
    const stateConfig = JSON.parse(source.state_config_json) as JsonObject;
    const confirmation = isObject(stateConfig.temporary_confirmation)
      ? stateConfig.temporary_confirmation
      : null;
    const compilerInput = isObject(stateConfig.compiler_input_snapshot)
      ? stateConfig.compiler_input_snapshot
      : null;
    const definition = JSON.parse(source.definition_json) as JsonObject;
    const states = isObject(definition.states) ? definition.states : null;
    const stateValue = states?.[source.state_key];
    const state = isObject(stateValue) ? stateValue : null;
    const route =
      state && isObject(state.on_temporary_replan)
        ? state.on_temporary_replan
        : null;
    const rootPlanBytes = source.root_plan_json ?? source.root_plan_value_json;
    const rootPlan = rootPlanBytes
      ? (JSON.parse(rootPlanBytes) as JsonObject)
      : null;
    const dynamicBuild = this.store.queryOne<{
      owner_node_id: string;
      owner_node_key: string;
      compiler_snapshot_hash: Sha256Hash;
      source_snapshot_json: string | null;
      source_snapshot_value_json: string | null;
      source_snapshot_hash: Sha256Hash;
      compiled_plan_hash: Sha256Hash;
      compiled_plan_json: string | null;
      compiled_plan_value_json: string | null;
    }>(
      `SELECT build.owner_node_id, owner.node_key AS owner_node_key,
              build.compiler_snapshot_hash,
              build.source_snapshot_json,
              source_value.inline_canonical_json AS source_snapshot_value_json,
              build.source_snapshot_hash, build.compiled_plan_hash,
              child_plan.compiled_plan_json,
              plan_value.inline_canonical_json AS compiled_plan_value_json
         FROM workflow_graph_scope_builds build
    LEFT JOIN workflow_values source_value
           ON source_value.id = build.source_snapshot_value_id
          AND source_value.content_hash = build.source_snapshot_hash
          AND source_value.payload_state = 'live'
         JOIN workflow_graph_scope_plans child_plan
           ON child_plan.id = build.compiled_plan_id
          AND child_plan.graph_run_id = build.graph_run_id
          AND child_plan.plan_hash = build.compiled_plan_hash
         JOIN workflow_graph_nodes owner
           ON owner.graph_run_id = build.graph_run_id
          AND owner.scope_id = build.owner_scope_id
          AND owner.id = build.owner_node_id
    LEFT JOIN workflow_values plan_value
           ON plan_value.id = child_plan.compiled_plan_value_id
          AND plan_value.content_hash = child_plan.plan_hash
          AND plan_value.payload_state = 'live'
        WHERE build.graph_run_id = ? AND build.scope_kind = 'expansion'
          AND build.status = 'materialized'
        ORDER BY build.created_at_ms, build.id COLLATE BINARY LIMIT 1`,
      [request.source_run_id],
    );
    const dynamicOwner =
      dynamicBuild && Array.isArray(rootPlan?.nodes)
        ? (rootPlan.nodes as JsonObject[]).find(
            (node) =>
              node.id === dynamicBuild.owner_node_key &&
              node.type === 'expand' &&
              isObject(node.child_policy),
          )
        : null;
    const unsupportedReasons = [
      source.recipe_id !== 'ad_hoc_personal_task' ? 'recipe' : null,
      !confirmation ||
      confirmation.format !== 'icarus.temporary-workflow-confirmation/1' ||
      !isObject(confirmation.source_json) ||
      typeof confirmation.source_hash !== 'string' ||
      typeof confirmation.plan_hash !== 'string'
        ? 'confirmation'
        : null,
      !compilerInput ? 'compiler_input' : null,
      !rootPlan || rootPlan.plan_hash !== source.root_plan_hash
        ? 'root_plan'
        : null,
      !dynamicBuild ? 'dynamic_build' : null,
      !dynamicOwner ? 'dynamic_owner' : null,
      compilerInput &&
      (typeof compilerInput.snapshot_hash !== 'string' ||
        dynamicBuild?.compiler_snapshot_hash !== compilerInput.snapshot_hash)
        ? 'compiler_snapshot'
        : null,
      route?.target !== 'run' ? 'definition_route' : null,
    ].filter((reason): reason is string => reason !== null);
    if (unsupportedReasons.length > 0) {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        `Source Run is not an exact Core Temporary Workflow replan authority: ${unsupportedReasons.join(', ')}`,
      );
    }
    const exactConfirmation = confirmation as JsonObject & {
      readonly source_json: JsonObject;
      readonly source_hash: Sha256Hash;
      readonly plan_hash: Sha256Hash;
    };
    const exactCompilerInput = compilerInput as JsonObject;
    const exactDynamicBuild = dynamicBuild!;
    const exactDynamicOwner = dynamicOwner!;

    const compile = (sourceJson: JsonObject, label: string) => {
      const outcome = compileWorkflow({
        caseId: `workspace-temporary-replan:${request.source_run_id}:${label}`,
        sourceKind: 'graph_scope',
        rawSourceBytes: Buffer.from(canonicalJson(sourceJson), 'utf8'),
        inputSnapshot: dynamicChildCompilerInputSnapshot(
          exactCompilerInput,
          exactDynamicOwner,
        ),
      });
      if (!outcome.ok) {
        throw new RuntimeWorkspaceGatewayError(
          'unsupported_by_temporary_workflow',
          `Temporary Replan ${label} source failed compile: ${canonicalJson(
            outcome.value.diagnostics.map((diagnostic) => ({
              code: diagnostic.code,
              phase: diagnostic.phase,
              pointer: diagnostic.pointer,
            })),
          )}`,
        );
      }
      return {
        sourceHash: outcome.value.sourceHash,
        plan: outcome.value.plan as unknown as JsonObject,
        planHash: outcome.value.plan.plan_hash as Sha256Hash,
      };
    };
    const oldCompiled = compile(exactConfirmation.source_json, 'old');
    const authoritativeOldSourceBytes =
      exactDynamicBuild.source_snapshot_json ??
      exactDynamicBuild.source_snapshot_value_json;
    const authoritativeOldPlanBytes =
      exactDynamicBuild.compiled_plan_json ??
      exactDynamicBuild.compiled_plan_value_json;
    const authoritativeOldSource = authoritativeOldSourceBytes
      ? (JSON.parse(authoritativeOldSourceBytes) as JsonObject)
      : null;
    const authoritativeOldPlan = authoritativeOldPlanBytes
      ? (JSON.parse(authoritativeOldPlanBytes) as JsonObject)
      : null;
    if (
      !authoritativeOldSource ||
      !authoritativeOldPlan ||
      canonicalJson(authoritativeOldSource) !==
        canonicalJson(exactConfirmation.source_json) ||
      domainSeparatedSha256(
        'icarus:workflow-graph-source:1\n',
        authoritativeOldSource,
      ) !== exactDynamicBuild.source_snapshot_hash ||
      authoritativeOldPlan.plan_hash !== exactDynamicBuild.compiled_plan_hash ||
      authoritativeOldPlan.source_hash !==
        exactDynamicBuild.source_snapshot_hash ||
      oldCompiled.sourceHash !== exactConfirmation.source_hash ||
      oldCompiled.planHash !== exactConfirmation.plan_hash ||
      oldCompiled.sourceHash !== exactDynamicBuild.source_snapshot_hash ||
      oldCompiled.planHash !== exactDynamicBuild.compiled_plan_hash ||
      canonicalJson(oldCompiled.plan) !== canonicalJson(authoritativeOldPlan)
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Temporary Replan source confirmation no longer compiles to its sealed Plan',
      );
    }
    const nextCompiled = compile(request.source_json, 'new');
    if (
      nextCompiled.sourceHash === oldCompiled.sourceHash &&
      nextCompiled.planHash === oldCompiled.planHash
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        'Temporary Replan must change the confirmed Dynamic Child source',
      );
    }

    const scopes = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, parent_scope_id, owner_node_id, scope_kind, depth, lifecycle,
              work_fence_epoch, outcome_kind, close_request_id,
              completion_cut_id, row_version
         FROM workflow_graph_scopes WHERE graph_run_id = ?
        ORDER BY depth, id COLLATE BINARY`,
      [request.source_run_id],
    );
    const nodes = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, scope_id, node_key, node_type, phase, trigger_state,
              input_state, activation_event_seq, terminal_status,
              current_attempt_id, active_wait_id, controller_state, row_version
         FROM workflow_graph_nodes WHERE graph_run_id = ?
        ORDER BY scope_id COLLATE BINARY, node_key COLLATE BINARY`,
      [request.source_run_id],
    );
    const attempts = this.store.queryAll<Record<string, unknown>>(
      `SELECT attempt.id, attempt.scope_id, attempt.node_id, attempt.attempt_no,
              attempt.phase, attempt.delegation_id, attempt.external_execution_id,
              attempt.acceptance_state, attempt.run_work_fence_epoch,
              attempt.scope_work_fence_epoch, attempt.row_version,
              node.normalized_node_json
         FROM workflow_graph_node_attempts attempt
         JOIN workflow_graph_nodes node
           ON node.graph_run_id = attempt.graph_run_id
          AND node.scope_id = attempt.scope_id AND node.id = attempt.node_id
        WHERE attempt.graph_run_id = ? AND attempt.phase <> 'terminal'
        ORDER BY attempt.scope_id COLLATE BINARY, attempt.node_id COLLATE BINARY,
                 attempt.attempt_no`,
      [request.source_run_id],
    );
    for (const attempt of attempts) {
      if (
        !['dispatch_pending', 'running', 'evaluating'].includes(
          String(attempt.phase),
        ) ||
        (attempt.delegation_id === null &&
          attempt.external_execution_id === null)
      ) {
        continue;
      }
      const normalized = JSON.parse(
        String(attempt.normalized_node_json),
      ) as JsonObject;
      const binding = isObject(normalized.capability_binding)
        ? normalized.capability_binding
        : null;
      const cancellation =
        binding && isObject(binding.cancellation) ? binding.cancellation : null;
      const safe =
        (cancellation?.type === 'fence_only' &&
          cancellation.safe_to_abandon === true) ||
        (cancellation?.type === 'cooperative' &&
          cancellation.ack_required_before_close === false &&
          cancellation.safe_if_cancel_lost === true);
      if (!safe) {
        throw new RuntimeWorkspaceGatewayError(
          'active_attempt_unsafe',
          'Temporary Replan has an active external Attempt without safe cancellation authority',
        );
      }
    }
    const waits = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, scope_id, node_id, wait_type, status, deadline_at_ms,
              run_work_fence_epoch, scope_work_fence_epoch, row_version
         FROM workflow_graph_waits
        WHERE graph_run_id = ? AND status IN ('registering', 'armed')
        ORDER BY scope_id COLLATE BINARY, node_id COLLATE BINARY, id COLLATE BINARY`,
      [request.source_run_id],
    );
    const retrySchedules = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, scope_id, node_id, source_attempt_id, source_attempt_no,
              next_attempt_no, continuation_kind, retry_policy_hash,
              eligible_at_ms, status, row_version
         FROM workflow_graph_retry_schedules
        WHERE graph_run_id = ? AND status = 'scheduled'
        ORDER BY scope_id COLLATE BINARY, node_id COLLATE BINARY, id COLLATE BINARY`,
      [request.source_run_id],
    );
    const builds = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, owner_scope_id, owner_node_id, target_scope_id, invocation_key,
              scope_kind, compiler_snapshot_hash, run_work_fence_epoch,
              owner_scope_work_fence_epoch, status, compiled_plan_hash,
              scope_id, row_version
         FROM workflow_graph_scope_builds WHERE graph_run_id = ?
        ORDER BY id COLLATE BINARY`,
      [request.source_run_id],
    );
    const sourceFrontier: JsonObject = {
      format: 'icarus.workspace-temporary-replan-frontier/1',
      run: {
        lifecycle: source.run_lifecycle,
        control: source.run_control,
        work_fence_epoch: source.run_work_fence_epoch,
        event_seq: Math.max(0, source.next_event_seq - 1),
        manifest_seq: source.manifest_seq,
        manifest_head_hash: source.manifest_head_hash,
        ledger_seq: source.ledger_seq,
        ledger_head_hash: source.ledger_head_hash,
        row_version: source.run_row_version,
      },
      scopes: scopes as unknown as JsonValue,
      nodes: nodes as unknown as JsonValue,
      attempts: attempts.map(
        ({ normalized_node_json: _normalized, ...attempt }) => attempt,
      ) as unknown as JsonValue,
      waits: waits as unknown as JsonValue,
      retry_schedules: retrySchedules as unknown as JsonValue,
      builds: builds as unknown as JsonValue,
    };
    const frontierHash = domainSeparatedSha256(
      'icarus:task-workspace:temporary-replan-frontier:1\n',
      sourceFrontier,
    );

    const effects = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, scope_id, node_id, attempt_id, operation_key, execution_lane,
              effect_type, status, request_hash, receipt_hash,
              before_state_hash, after_state_hash,
              immutable_output_snapshot_hash, compensation_hash, row_version
         FROM workflow_graph_effect_operations WHERE graph_run_id = ?
        ORDER BY id COLLATE BINARY`,
      [request.source_run_id],
    );
    const blockers = this.store.queryAll<Record<string, unknown>>(
      `SELECT id, blocker_kind, severity, source_effect_operation_id,
              error_code, status, row_version
         FROM workflow_operational_blockers
        WHERE graph_run_id = ? AND status = 'open'
        ORDER BY id COLLATE BINARY`,
      [request.source_run_id],
    );
    const effectOutbox = this.store.queryAll<Record<string, unknown>>(
      `SELECT outbox.id, outbox.effect_key, outbox.attempt_id,
              outbox.wait_id, outbox.effect_operation_id,
              outbox.effect_type, outbox.delivery_lane,
              outbox.delivery_requirement, outbox.status,
              outbox.delivery_attempt_count, outbox.reconcile_attempt_count,
              outbox.last_result_kind, outbox.last_error_code,
              outbox.updated_at_ms
         FROM workflow_outbox outbox
    LEFT JOIN workflow_graph_effect_operations effect
           ON effect.id = outbox.effect_operation_id
    LEFT JOIN workflow_graph_node_attempts attempt
           ON attempt.id = outbox.attempt_id
    LEFT JOIN workflow_graph_waits wait
           ON wait.id = outbox.wait_id
        WHERE effect.graph_run_id = ? OR attempt.graph_run_id = ?
           OR wait.graph_run_id = ?
        ORDER BY outbox.id COLLATE BINARY`,
      [request.source_run_id, request.source_run_id, request.source_run_id],
    );
    if (
      blockers.some(
        (blocker) =>
          blocker.severity === 'quarantine' ||
          blocker.blocker_kind === 'integrity_quarantine',
      )
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'integrity_quarantine',
        'Temporary Replan is denied by an integrity quarantine blocker',
      );
    }
    if (blockers.length > 0) {
      throw new RuntimeWorkspaceGatewayError(
        'operational_blocked',
        'Temporary Replan is denied by an open Runtime blocker',
      );
    }
    if (
      effects.some((effect) =>
        [
          'dispatched',
          'succeeded',
          'compensation_pending',
          'action_required',
        ].includes(String(effect.status)),
      ) ||
      effectOutbox.some(
        (outbox) =>
          outbox.delivery_lane !== 'system_projection' &&
          outbox.status !== 'succeeded',
      )
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'effect_state_unsafe',
        'Temporary Replan is denied by an in-flight, unknown, or uncompensated effect',
      );
    }
    const effectSafety: JsonObject = {
      format: 'icarus.workspace-temporary-replan-effect-safety/1',
      effects: effects as unknown as JsonValue,
      runtime_outbox: effectOutbox as unknown as JsonValue,
      open_blockers: blockers as unknown as JsonValue,
    };
    const effectSafetyHash = domainSeparatedSha256(
      'icarus:task-workspace:temporary-replan-effect-safety:1\n',
      effectSafety,
    );
    const sourceAuthority: WorkspaceTemporaryReplanSourceAuthority = {
      workflow_id: request.source_workflow_id,
      workflow_row_version: source.workflow_row_version,
      workflow_revision: source.workflow_revision,
      activation_id: request.source_activation_id,
      activation_row_version: source.activation_row_version,
      run_id: request.source_run_id,
      run_row_version: source.run_row_version,
      run_work_fence_epoch: source.run_work_fence_epoch,
      manifest_seq: source.manifest_seq,
      manifest_head_hash: source.manifest_head_hash,
      ledger_seq: source.ledger_seq,
      ledger_head_hash: source.ledger_head_hash,
      root_scope_id: source.root_scope_id,
      root_scope_row_version: source.root_scope_row_version,
      root_scope_work_fence_epoch: source.root_scope_work_fence_epoch,
      event_seq: Math.max(0, source.next_event_seq - 1),
      state_config_value_id: source.state_config_value_id,
      state_config_hash: source.state_config_hash,
      registry_snapshot_id: source.registry_snapshot_id,
      registry_snapshot_hash: source.registry_snapshot_hash,
      closure_manifest_id: source.closure_manifest_id,
      closure_hash: source.closure_hash,
      runtime_safety_snapshot_value_id: source.runtime_safety_snapshot_value_id,
      runtime_safety_snapshot_hash: source.runtime_safety_snapshot_hash,
      input_snapshot_value_id: source.input_snapshot_value_id,
      input_snapshot_hash: source.input_snapshot_hash,
      compiler_snapshot_hash: source.compiler_snapshot_hash,
      context_snapshot_id: source.context_snapshot_id,
      context_snapshot_hash: source.context_snapshot_hash,
      root_plan_hash: source.root_plan_hash as Sha256Hash,
      frontier_hash: frontierHash,
      effect_safety_hash: effectSafetyHash,
    };
    const nodeMap = (plan: JsonObject) =>
      new Map(
        (Array.isArray(plan.nodes) ? plan.nodes : [])
          .filter(isObject)
          .map((node) => [String(node.id ?? node.node_key), node] as const),
      );
    const oldNodes = nodeMap(oldCompiled.plan);
    const newNodes = nodeMap(nextCompiled.plan);
    const oldIds = [...oldNodes.keys()].sort(compareAscii);
    const newIds = [...newNodes.keys()].sort(compareAscii);
    const diff: JsonObject = {
      format: 'icarus.workspace-temporary-replan-diff/1',
      old_plan_hash: oldCompiled.planHash,
      new_plan_hash: nextCompiled.planHash,
      added_node_ids: newIds.filter((id) => !oldNodes.has(id)),
      removed_node_ids: oldIds.filter((id) => !newNodes.has(id)),
      changed_node_ids: oldIds.filter(
        (id) =>
          newNodes.has(id) &&
          canonicalJson(oldNodes.get(id)!) !== canonicalJson(newNodes.get(id)!),
      ),
      old_control_edge_count: Array.isArray(oldCompiled.plan.control_edges)
        ? oldCompiled.plan.control_edges.length
        : 0,
      new_control_edge_count: Array.isArray(nextCompiled.plan.control_edges)
        ? nextCompiled.plan.control_edges.length
        : 0,
      old_data_edge_count: Array.isArray(oldCompiled.plan.data_edges)
        ? oldCompiled.plan.data_edges.length
        : 0,
      new_data_edge_count: Array.isArray(nextCompiled.plan.data_edges)
        ? nextCompiled.plan.data_edges.length
        : 0,
    };
    const newPlanNodes = Array.isArray(nextCompiled.plan.nodes)
      ? nextCompiled.plan.nodes.filter(isObject)
      : [];
    const riskSummary: JsonObject = {
      active_attempt_count: attempts.length,
      active_wait_count: waits.length,
      known_effect_count: effects.length,
      open_blocker_count: blockers.length,
      effect_impacts: [
        ...new Set(
          newPlanNodes
            .map((node) =>
              isObject(node.capability_binding)
                ? node.capability_binding.effect_impact
                : null,
            )
            .filter((value): value is string => typeof value === 'string'),
        ),
      ].sort(compareAscii),
      requested_limits: request.source_json.requested_limits ?? null,
    };
    const proposal = {
      format: 'icarus.workspace-temporary-replan-proposal/1',
      replan_creation_key: request.idempotency_key,
      source_authority: sourceAuthority,
      source_frontier_json: sourceFrontier,
      effect_safety_json: effectSafety,
      old_source_hash: oldCompiled.sourceHash,
      old_plan_hash: oldCompiled.planHash,
      new_source_json: request.source_json,
      new_source_hash: nextCompiled.sourceHash,
      new_plan_json: nextCompiled.plan,
      new_plan_hash: nextCompiled.planHash,
      diff_json: diff,
      risk_summary_json: riskSummary,
    } satisfies JsonObject;
    const proposalHash = domainSeparatedSha256(
      'icarus:task-workspace:temporary-replan-proposal:1\n',
      proposal,
    );
    const confirmationRef = stableRuntimeId(
      'workspace-temporary-replan-confirmation',
      {
        source_run_id: request.source_run_id,
        replan_creation_key: request.idempotency_key,
        proposal_hash: proposalHash,
      },
    );
    const confirmationHash = calculateWorkspaceTemporaryReplanConfirmationHash({
      principal_ref: request.principal_ref,
      source_workflow_id: request.source_workflow_id,
      source_activation_id: request.source_activation_id,
      source_run_id: request.source_run_id,
      replan_creation_key: request.idempotency_key,
      proposal_hash: proposalHash,
      confirmation_ref: confirmationRef,
    });
    return {
      format: 'icarus.workspace-temporary-replan-preparation/1',
      proposal_hash: proposalHash,
      replan_creation_key: request.idempotency_key,
      confirmation_ref: confirmationRef,
      confirmation_hash: confirmationHash,
      source_authority: sourceAuthority,
      source_frontier_json: sourceFrontier,
      effect_safety_json: effectSafety,
      old_source_hash: oldCompiled.sourceHash,
      old_plan_hash: oldCompiled.planHash,
      new_source_json: request.source_json,
      new_source_hash: nextCompiled.sourceHash,
      new_plan_json: nextCompiled.plan,
      new_plan_hash: nextCompiled.planHash,
      diff_json: diff,
      risk_summary_json: riskSummary,
    };
  }

  listRecipes(request: WorkspaceRecipeCatalogRequest): WorkspaceRecipeCatalog {
    assertPrincipal(request.principal_ref);
    if (!Number.isSafeInteger(request.now_ms) || request.now_ms < 0) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Catalog time is invalid',
      );
    }
    const expiresAt = request.now_ms + this.tokenTtlMs;
    const seen = new Set<string>();
    const items: WorkspaceRecipeCatalogItemV1[] = [];
    for (const row of this.recipeRows()) {
      if (seen.has(row.resource_id)) continue;
      const content = JSON.parse(row.inline_canonical_json) as JsonObject;
      const kind = recipeKind(row, content);
      if (
        kind === 'personal' &&
        row.owner_principal_ref !== request.principal_ref
      ) {
        continue;
      }
      const entryPoint = content.entry_point;
      const launchPolicy = content.launch_policy;
      if (
        typeof entryPoint !== 'string' ||
        !['auto', 'confirm', 'manual_only'].includes(String(launchPolicy))
      ) {
        continue;
      }
      const personalRelease =
        kind === 'personal'
          ? queryActivePersonalWorkflowReleases(
              this.store,
              request.principal_ref,
            ).find(
              (release) =>
                release.recipe_ref.id === row.resource_id &&
                release.recipe_ref.version === row.resource_version &&
                release.recipe_hash === row.content_hash,
            )
          : null;
      if (kind === 'personal' && !personalRelease) continue;
      const payload: SelectionTokenPayload = {
        format: 'icarus.workspace-recipe-selection/1',
        principal_ref: request.principal_ref,
        recipe_row_id: row.id,
        recipe_ref: { id: row.resource_id, version: row.resource_version },
        recipe_hash: row.content_hash,
        entry_point: entryPoint,
        launch_policy: launchPolicy as WorkspaceLaunchPolicy,
        personal_release_id: personalRelease?.release_id ?? null,
        personal_release_hash: personalRelease?.release_hash ?? null,
        personal_pointer_row_version:
          personalRelease?.pointer_row_version ?? null,
        personal_registry_snapshot_id:
          personalRelease?.registry_snapshot_id ?? null,
        personal_registry_snapshot_hash:
          personalRelease?.registry_snapshot_hash ?? null,
        personal_compiled_plan_hash:
          personalRelease?.compiled_plan_hash ?? null,
        issued_at_ms: request.now_ms,
        expires_at_ms: expiresAt,
      };
      try {
        this.assertActiveRecipe(payload);
      } catch (error) {
        if (
          error instanceof RuntimeWorkspaceGatewayError &&
          error.code === 'selection_stale'
        ) {
          continue;
        }
        throw error;
      }
      seen.add(row.resource_id);
      items.push({
        recipe_kind: kind,
        recipe_ref: payload.recipe_ref,
        recipe_hash: row.content_hash,
        display_name:
          typeof content.name === 'string'
            ? content.name
            : typeof content.display_name === 'string'
              ? content.display_name
              : row.resource_id,
        description:
          typeof content.description === 'string' ? content.description : null,
        launch_policy: payload.launch_policy,
        input_summary: isObject(content.input_summary)
          ? content.input_summary
          : {},
        selection_token: this.sign(payload),
      });
    }
    return {
      format: 'icarus.workspace-recipe-catalog/1',
      items,
      expires_at_ms: expiresAt,
    };
  }

  refreshRecipeSelection(
    request: WorkspaceRecipeSelectionRefreshRequest,
  ): WorkspaceRecipeCatalogItemV1 {
    assertPrincipal(request.principal_ref);
    if (
      !isObject(request.recipe_ref) ||
      typeof request.recipe_ref.id !== 'string' ||
      request.recipe_ref.id.length < 1 ||
      request.recipe_ref.id.length > 512 ||
      typeof request.recipe_ref.version !== 'string' ||
      request.recipe_ref.version.length < 1 ||
      request.recipe_ref.version.length > 255 ||
      !SHA256_PATTERN.test(request.recipe_hash) ||
      !Number.isSafeInteger(request.now_ms) ||
      request.now_ms < 0
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Persisted exact Recipe selection is invalid',
      );
    }
    const exact = this.listRecipes({
      principal_ref: request.principal_ref,
      now_ms: request.now_ms,
    }).items.find(
      (item) =>
        item.recipe_ref.id === request.recipe_ref.id &&
        item.recipe_ref.version === request.recipe_ref.version &&
        item.recipe_hash === request.recipe_hash,
    );
    if (!exact) {
      throw new RuntimeWorkspaceGatewayError(
        'selection_stale',
        'The persisted exact Recipe is no longer present in the active Catalog',
      );
    }
    return exact;
  }

  extractPersonalWorkflowDraft(
    request: WorkspacePersonalDraftExtractionRequest,
  ): WorkspacePersonalDraftExtraction {
    const authority = this.temporaryDynamicAuthority(
      request.principal_ref,
      request.workflow_id,
      request.run_id,
    );
    return {
      format: 'icarus.workspace-personal-draft-extraction/1',
      source_workflow_id: request.workflow_id,
      source_run_id: request.run_id,
      source_json: authority.source,
      source_hash: authority.sourceHash,
      compiled_plan_json: authority.plan,
      compiled_plan_hash: authority.planHash,
      compiler_version: WORKFLOW_COMPILER_VERSION,
    };
  }

  preparePersonalWorkflowDraft(
    request: WorkspacePersonalDraftPreparationRequest,
  ): WorkspaceTemporaryDraftCompilation {
    return this.compilePersonalSource(
      request.principal_ref,
      request.source_workflow_id,
      request.source_run_id,
      request.source_json,
    );
  }

  publishPersonalWorkflowRelease(
    request: WorkspacePersonalReleasePublishRequest,
  ): PersonalWorkflowReleasePublishResult {
    assertPrincipal(request.principal_ref);
    if (
      !request.personal_workflow_id ||
      !request.display_name.trim() ||
      request.display_name.length > 255 ||
      (request.description !== null && request.description.length > 2_000) ||
      !request.idempotency_key ||
      !Number.isSafeInteger(request.now_ms) ||
      request.now_ms < 0
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Personal Workflow publication fields are invalid',
      );
    }
    const compilation = this.compilePersonalSource(
      request.principal_ref,
      request.source_workflow_id,
      request.source_run_id,
      request.source_json,
    );
    if (
      compilation.source_hash !== request.expected_source_hash ||
      compilation.compiled_plan_hash !== request.expected_plan_hash
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Personal Workflow publication differs from its reviewed compile',
      );
    }
    const coreRow = this.recipeRows().find(
      (row) =>
        row.owner_core_ref !== null &&
        row.resource_id === 'ad_hoc_personal_task',
    );
    if (!coreRow) {
      throw new RuntimeWorkspaceGatewayError(
        'target_not_found',
        'Core Ad Hoc Recipe is unavailable',
      );
    }
    const coreRecipe = JSON.parse(coreRow.inline_canonical_json) as JsonObject;
    const owner = {
      kind: 'principal' as const,
      principal_ref: request.principal_ref,
    };
    const namespace = `personal.${domainSeparatedSha256(
      'icarus:personal-workflow-namespace:1\n',
      {
        principal_ref: request.principal_ref,
        personal_workflow_id: request.personal_workflow_id,
      },
    ).slice(7, 23)}.${request.personal_workflow_id}`;
    const version = request.release_ref.version;
    const schemaRef = { id: `${namespace}.schema`, version };
    const schemaBase = {
      format: 'icarus.workflow-registry-resource/1' as const,
      resource_type: 'schema' as const,
      ref: schemaRef,
      owner,
      schema_ref: schemaRef,
      schema_hash: '' as Sha256Hash,
      content: { type: 'object', additionalProperties: true },
      dependencies: [] as G3RegistryResourceDependency[],
    };
    const schema = {
      ...schemaBase,
      content_hash: calculateRegistryResourceContentHash(schemaBase),
    } as G3RegistryResourceRecord;
    (schema as { schema_hash: Sha256Hash }).schema_hash = schema.content_hash;
    const dependency = (
      resource: G3RegistryResourceRecord,
    ): G3RegistryResourceDependency => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
      dependency_kind: 'registry_exact',
    });
    const resource = (
      resourceType: 'graph_template' | 'recipe',
      ref: VersionedRef,
      content: JsonObject,
      dependencies: G3RegistryResourceDependency[],
    ): G3RegistryResourceRecord => {
      const base = {
        format: 'icarus.workflow-registry-resource/1' as const,
        resource_type: resourceType,
        ref,
        owner,
        schema_ref: schema.ref,
        schema_hash: schema.content_hash,
        content,
        dependencies: [...dependencies].sort((left, right) =>
          compareAscii(
            `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
            `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
          ),
        ),
      };
      return {
        ...base,
        content_hash: calculateRegistryResourceContentHash(base),
      } as G3RegistryResourceRecord;
    };
    const graphTemplate = resource(
      'graph_template',
      { id: `${namespace}.graph`, version },
      request.source_json,
      [dependency(schema)],
    );
    const recipe = resource(
      'recipe',
      { id: `${namespace}.recipe`, version },
      {
        ...coreRecipe,
        owner_principal_ref: request.principal_ref,
        personal_workflow_id: request.personal_workflow_id,
        graph_template_ref: graphTemplate.ref,
        graph_template_hash: graphTemplate.content_hash,
        name: request.display_name.trim(),
        description: request.description,
        launch_policy: 'manual_only',
      },
      [dependency(graphTemplate), dependency(schema)],
    );
    const resources = [schema, graphTemplate, recipe].sort((left, right) =>
      compareAscii(
        `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
        `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
      ),
    );
    const closure = buildDependencyClosure(
      resources,
      { resource_type: 'recipe', ref: recipe.ref },
      { id: `${namespace}.closure`, version },
      {
        id: schema.ref.id,
        version: schema.ref.version,
        hash: schema.content_hash,
      },
    );
    const snapshotBase = {
      format: 'icarus.workflow-registry-snapshot/1' as const,
      ref: { id: `${namespace}.snapshot`, version },
      closure_ref: closure.ref,
      closure_hash: closure.closure_hash,
      compiler_version: WORKFLOW_COMPILER_VERSION,
    } satisfies Omit<G3RegistrySnapshot, 'snapshot_hash'>;
    const snapshot: G3RegistrySnapshot = {
      format: snapshotBase.format,
      ref: snapshotBase.ref,
      closure_ref: snapshotBase.closure_ref,
      closure_hash: snapshotBase.closure_hash,
      compiler_version: snapshotBase.compiler_version,
      snapshot_hash: calculateRegistrySnapshotHash(snapshotBase),
    };
    const registryBatch: G3RegistryPersistenceBatch = {
      resources,
      closure,
      snapshot,
      created_at_ms: request.now_ms,
    };
    return publishPersonalWorkflowRelease(this.store, {
      format: 'icarus.personal-workflow-release-publish-request/1',
      idempotency_domain: 'task-workspace-personal-publish',
      idempotency_key: request.idempotency_key,
      owner_principal_ref: request.principal_ref,
      personal_workflow_id: request.personal_workflow_id,
      release_ref: request.release_ref,
      recipe: {
        resource_type: 'recipe',
        ref: recipe.ref,
        content_hash: recipe.content_hash,
      },
      graph_template: {
        resource_type: 'graph_template',
        ref: graphTemplate.ref,
        content_hash: graphTemplate.content_hash,
      },
      registry_batch: registryBatch,
      compiled_plan_hash: compilation.compiled_plan_hash,
      compiler_version: WORKFLOW_COMPILER_VERSION,
      policy_effect_envelope: {
        source_hash: compilation.source_hash,
        plan_hash: compilation.compiled_plan_hash,
        policy_ceiling_hash: compilation.policy_ceiling_hash,
        risk_summary: compilation.risk_summary_json,
      },
      requested_at_ms: request.now_ms,
    });
  }

  activatePersonalWorkflowRelease(
    request: WorkspacePersonalReleaseActivateRequest,
  ): PersonalWorkflowReleaseActivateResult {
    assertPrincipal(request.principal_ref);
    return activatePersonalWorkflowRelease(this.store, {
      format: 'icarus.personal-workflow-release-activate-request/1',
      idempotency_domain: 'task-workspace-personal-activate',
      idempotency_key: request.idempotency_key,
      owner_principal_ref: request.principal_ref,
      personal_workflow_id: request.personal_workflow_id,
      release_id: request.release_id,
      release_hash: request.release_hash,
      expected_pointer_row_version: request.expected_pointer_row_version,
      requested_at_ms: request.now_ms,
    });
  }

  listPersonalWorkflowReleases(
    principalRef: string,
  ): ActivePersonalWorkflowRelease[] {
    assertPrincipal(principalRef);
    return queryActivePersonalWorkflowReleases(this.store, principalRef);
  }

  prepareTemporaryDraft(
    request: WorkspaceTemporaryDraftRequest,
  ): WorkspaceTemporaryDraftCompilation {
    assertPrincipal(request.principal_ref);
    const selection = this.verify(
      request.selection_token,
      request.principal_ref,
      request.now_ms,
    );
    const recipeRow = this.assertActiveRecipe(selection);
    if (selection.recipe_ref.id !== 'ad_hoc_personal_task') {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        'Temporary drafts require the active Core Ad Hoc Recipe',
      );
    }
    const recipe = JSON.parse(recipeRow.inline_canonical_json) as JsonObject;
    const compilerInput = isObject(recipe.compiler_input_snapshot)
      ? recipe.compiler_input_snapshot
      : null;
    if (!compilerInput) {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        'Temporary Workflow compiler snapshot is unavailable',
      );
    }
    const definition = this.resourceContent(
      this.resourceByRef(
        'definition',
        recipe.workflow_definition_ref as VersionedRef,
      ),
    );
    const outerPlan = this.precompiledPlan(recipeRow.id, definition);
    const dynamicOwner = Array.isArray(outerPlan?.nodes)
      ? (outerPlan.nodes as JsonObject[]).find(
          (node) => node.type === 'expand' && isObject(node.child_policy),
        )
      : null;
    if (!dynamicOwner) {
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        'Temporary Workflow release has no controlled Dynamic Child owner',
      );
    }
    const outcome = compileWorkflow({
      caseId: `workspace-temporary:${request.principal_ref}`,
      sourceKind: 'graph_scope',
      rawSourceBytes: Buffer.from(canonicalJson(request.source_json), 'utf8'),
      inputSnapshot: dynamicChildCompilerInputSnapshot(
        compilerInput,
        dynamicOwner,
      ),
    });
    if (!outcome.ok) {
      const diagnostics = outcome.value.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        phase: diagnostic.phase,
        pointer: diagnostic.pointer,
      }));
      throw new RuntimeWorkspaceGatewayError(
        'unsupported_by_temporary_workflow',
        `Temporary Workflow source is outside the published envelope: ${canonicalJson(diagnostics)}`,
      );
    }
    const snapshot = this.snapshotForRecipe(recipeRow.id);
    const executionPolicy = this.resourceByRef(
      'execution_policy',
      recipe.workflow_execution_policy_ref as VersionedRef,
    );
    const executionPolicyContent = this.resourceContent(executionPolicy);
    const policyCeilingHash = domainSeparatedSha256(
      'icarus:workspace-temporary-policy-ceiling:1\n',
      {
        recipe_hash: selection.recipe_hash,
        execution_policy_hash: executionPolicy.hash,
        effect_ceiling: recipe.effect_ceiling ?? null,
        safety_snapshot_hash:
          typeof compilerInput.snapshot_hash === 'string'
            ? compilerInput.snapshot_hash
            : null,
        dynamic_policy_hash:
          (dynamicOwner.child_policy as JsonObject).effective_policy_hash ??
          null,
      },
    );
    const plan = outcome.value.plan as unknown as JsonObject;
    const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
    const waits = nodes.filter(
      (node) => isObject(node) && String(node.type).includes('wait'),
    );
    return {
      format: 'icarus.workspace-temporary-draft-compilation/1',
      source_hash: outcome.value.sourceHash,
      compiled_plan_json: plan,
      compiled_plan_hash: outcome.value.plan.plan_hash as Sha256Hash,
      compiler_version: WORKFLOW_COMPILER_VERSION,
      resource_closure_hash: snapshot.closure_hash,
      policy_ceiling_hash: policyCeilingHash,
      risk_summary_json: {
        effect_ceiling:
          typeof recipe.effect_ceiling === 'string'
            ? recipe.effect_ceiling
            : (executionPolicyContent.effect_ceiling ?? 'unspecified'),
        node_count: nodes.length,
        human_input_points: waits.map((node) =>
          isObject(node) && typeof node.node_key === 'string'
            ? node.node_key
            : null,
        ),
        requested_limits: request.source_json.requested_limits ?? null,
      },
    };
  }

  createPublished(
    request: WorkspacePublishedCreationRequest,
  ): T0CreationReceipt {
    assertPrincipal(request.principal_ref);
    if (request.creation.principalRef !== request.principal_ref) {
      throw new RuntimeWorkspaceGatewayError(
        'permission_denied',
        'Creation principal does not match the authenticated principal',
      );
    }
    const selection = this.verify(
      request.selection_token,
      request.principal_ref,
      request.now_ms,
    );
    const row = this.assertActiveRecipe(selection);
    const definitionRef = JSON.parse(row.inline_canonical_json)
      .workflow_definition_ref as JsonObject;
    if (
      !isObject(definitionRef) ||
      request.creation.definition.ref.id !== definitionRef.id ||
      request.creation.definition.ref.version !== definitionRef.version
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Creation Definition does not match the selected Recipe',
      );
    }
    const receipt = createWorkflowT0(this.store, {
      ...request.creation,
      source: 'task_workspace',
      actor: 'human',
      recipe: {
        rowId: row.id,
        resourceType: 'recipe',
        ref: selection.recipe_ref,
        hash: selection.recipe_hash,
      },
      entryPoint: selection.entry_point,
      launchPolicy: selection.launch_policy,
      launchAuthorization: {
        kind: 'human_explicit',
        principalRef: request.principal_ref,
        authorizationRef: request.authorization_ref,
      },
    });
    this.options.on_runtime_commit?.({
      workflow_id: receipt.workflowId,
      run_id: receipt.activation.graphRunId,
    });
    return receipt;
  }

  launchPublished(request: WorkspaceResolvedLaunchRequest): T0CreationReceipt {
    const resolved = this.resolveLaunch(request);
    return this.createPublished({
      principal_ref: request.principal_ref,
      selection_token: request.selection_token,
      authorization_ref: request.authorization_ref,
      creation: resolved,
      now_ms: request.now_ms,
    });
  }

  launchTemporary(
    request: WorkspaceResolvedTemporaryLaunchRequest,
  ): T0CreationReceipt {
    const resolved = this.resolveLaunch(request, {
      revision_id: request.confirmed_revision_id,
      source_json: request.confirmed_source_json,
      source_hash: request.confirmed_source_hash,
      plan_hash: request.confirmed_plan_hash,
      resource_closure_hash: request.resource_closure_hash,
      policy_ceiling_hash: request.policy_ceiling_hash,
    });
    return this.createTemporary({
      principal_ref: request.principal_ref,
      selection_token: request.selection_token,
      authorization_ref: request.authorization_ref,
      creation: resolved,
      now_ms: request.now_ms,
      confirmed_revision_id: request.confirmed_revision_id,
      confirmed_source_hash: request.confirmed_source_hash,
      confirmed_plan_hash: request.confirmed_plan_hash,
      resource_closure_hash: request.resource_closure_hash,
      policy_ceiling_hash: request.policy_ceiling_hash,
    });
  }

  createTemporary(
    request: WorkspaceTemporaryCreationRequest,
  ): T0CreationReceipt {
    if (
      !request.confirmed_revision_id ||
      !request.confirmed_source_hash ||
      !request.confirmed_plan_hash ||
      !request.resource_closure_hash ||
      !request.policy_ceiling_hash
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Temporary creation requires an exact confirmed revision and hashes',
      );
    }
    return this.createPublished(request);
  }

  private resolveLaunch(
    request: WorkspaceResolvedLaunchRequest,
    temporary?: {
      readonly revision_id: string;
      readonly source_json: JsonObject;
      readonly source_hash: Sha256Hash;
      readonly plan_hash: Sha256Hash;
      readonly resource_closure_hash: Sha256Hash;
      readonly policy_ceiling_hash: Sha256Hash;
    },
  ): WorkspacePublishedCreationInput {
    assertPrincipal(request.principal_ref);
    const selection = this.verify(
      request.selection_token,
      request.principal_ref,
      request.now_ms,
    );
    const recipeRow = this.assertActiveRecipe(selection);
    const recipe = JSON.parse(recipeRow.inline_canonical_json) as JsonObject;
    const personalRelease = recipeRow.owner_principal_ref
      ? this.activePersonalRelease(selection, recipeRow)
      : null;
    const exact = (field: string, resourceType: string): RuntimeRegistryRef => {
      const ref = recipe[field];
      if (!isObject(ref)) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          `Selected Recipe has no exact ${field}`,
        );
      }
      return this.resourceByRef(resourceType, ref as VersionedRef);
    };
    const definition = exact('workflow_definition_ref', 'definition');
    const executionPolicy = exact(
      'workflow_execution_policy_ref',
      'execution_policy',
    );
    const commandPolicy = exact(
      'workflow_command_policy_ref',
      'command_policy',
    );
    const inputSchema = exact('input_schema_ref', 'schema');
    const contextContract = exact('context_contract_ref', 'context_contract');
    const routingScope = isObject(recipe.routing_scope_ref)
      ? this.resourceByRef(
          'routing_scope',
          recipe.routing_scope_ref as VersionedRef,
        )
      : this.firstResource('routing_scope');
    const supportedLimits = this.firstResource('runtime_supported_limits');
    const sqliteProfile = this.firstResource('sqlite_execution_profile');
    if (!routingScope || !supportedLimits || !sqliteProfile) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Selected Recipe release lacks Runtime launch support resources',
      );
    }
    const definitionContent = this.resourceContent(definition);
    const states = isObject(definitionContent.states)
      ? definitionContent.states
      : null;
    const entry = isObject(definitionContent.entry_points)
      ? definitionContent.entry_points[selection.entry_point]
      : null;
    const stateKey =
      isObject(entry) && typeof entry.state_key === 'string'
        ? entry.state_key
        : typeof recipe.initial_state_key === 'string'
          ? recipe.initial_state_key
          : 'run';
    const state =
      states && isObject(states[stateKey]) ? states[stateKey] : null;
    if (!state) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Recipe entrypoint does not resolve an exact Definition state',
      );
    }
    const snapshot = personalRelease
      ? {
          id: personalRelease.registry_snapshot_id,
          hash: personalRelease.registry_snapshot_hash,
          closure_id: personalRelease.closure_id,
          closure_hash: personalRelease.closure_hash,
        }
      : this.snapshotForRecipe(recipeRow.id);
    const precompiled = this.precompiledPlan(recipeRow.id, definitionContent);
    const compilerInput = isObject(recipe.compiler_input_snapshot)
      ? recipe.compiler_input_snapshot
      : null;
    if (!precompiled && !compilerInput) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Published release has neither a reviewed Plan nor compiler snapshot',
      );
    }
    const safety =
      precompiled && isObject(precompiled.runtime_safety_snapshot)
        ? precompiled.runtime_safety_snapshot
        : compilerInput && isObject(compilerInput.safety_snapshot)
          ? compilerInput.safety_snapshot
          : {};
    const safetyHash =
      precompiled && typeof precompiled.runtime_safety_hash === 'string'
        ? (precompiled.runtime_safety_hash as Sha256Hash)
        : domainSeparatedSha256('icarus:workspace-runtime-safety:1\n', safety);
    const values = {
      input: this.persistLaunchValue(
        'input',
        request.launch.creation_key,
        request.launch.effective_input_json,
        request.launch.effective_input_hash,
        inputSchema,
        request.now_ms,
      ),
      attachments: this.persistLaunchValue(
        'attachments',
        request.launch.creation_key,
        request.launch.attachment_manifest_json,
        request.launch.attachment_manifest_hash,
        inputSchema,
        request.now_ms,
      ),
      context: this.persistLaunchValue(
        'context',
        request.launch.creation_key,
        {},
        domainSeparatedSha256('icarus:workspace-context:1\n', {}),
        inputSchema,
        request.now_ms,
      ),
      routing: this.persistLaunchValue(
        'routing',
        request.launch.creation_key,
        {
          reason_codes: ['explicit_workspace_selection'],
          recipe_ref: selection.recipe_ref,
          recipe_hash: selection.recipe_hash,
        },
        domainSeparatedSha256('icarus:workspace-routing-decision:1\n', {
          reason_codes: ['explicit_workspace_selection'],
          recipe_ref: selection.recipe_ref,
          recipe_hash: selection.recipe_hash,
        }),
        inputSchema,
        request.now_ms,
      ),
      state: null as ReturnType<
        RuntimeWorkspaceGateway['persistLaunchValue']
      > | null,
      safety: this.persistLaunchValue(
        'safety',
        request.launch.creation_key,
        safety,
        safetyHash,
        inputSchema,
        request.now_ms,
      ),
    };
    const stateConfig: JsonObject = {
      ...(precompiled ? { precompiled_plan: precompiled } : {}),
      ...(compilerInput ? { compiler_input_snapshot: compilerInput } : {}),
      manifest_schema: inputSchema as unknown as JsonObject,
      fence_manifest_schema: inputSchema as unknown as JsonObject,
      map_item_results_manifest_schema: inputSchema as unknown as JsonObject,
      ...(temporary
        ? {
            temporary_confirmation: {
              format: 'icarus.temporary-workflow-confirmation/1',
              ...temporary,
            },
          }
        : {}),
      ...(personalRelease
        ? {
            personal_release: {
              format: 'icarus.personal-workflow-launch-release/1',
              personal_workflow_id: personalRelease.personal_workflow_id,
              release_id: personalRelease.release_id,
              release_hash: personalRelease.release_hash,
              source_json: personalRelease.source_json,
              source_hash: personalRelease.source_hash,
              plan_hash: personalRelease.compiled_plan_hash,
              compiler_version: personalRelease.compiler_version,
              registry_snapshot_id: personalRelease.registry_snapshot_id,
              registry_snapshot_hash: personalRelease.registry_snapshot_hash,
            },
          }
        : {}),
    };
    values.state = this.persistLaunchValue(
      'state-config',
      request.launch.creation_key,
      stateConfig,
      domainSeparatedSha256('icarus:workspace-state-config:1\n', stateConfig),
      inputSchema,
      request.now_ms,
    );
    const ownershipHash = domainSeparatedSha256(
      'icarus:workspace-workflow-ownership:1\n',
      {
        principal_ref: request.principal_ref,
        recipe_ref: selection.recipe_ref,
      },
    );
    const recipeRef: RuntimeRegistryRef = {
      rowId: recipeRow.id,
      resourceType: 'recipe',
      ref: selection.recipe_ref,
      hash: selection.recipe_hash,
    };
    const creationIntentHash = calculateCreationIntentHash({
      creationDomain: request.launch.creation_domain,
      creationKey: request.launch.creation_key,
      principalRef: request.principal_ref,
      ownershipHash,
      routingScope,
      recipe: recipeRef,
      entryPoint: selection.entry_point,
      inputHash: values.input.hash,
      attachmentManifestHash: values.attachments.hash,
    });
    const graphSource = isObject(state.graph_source)
      ? state.graph_source
      : definitionContent;
    const sourceHash =
      precompiled && typeof precompiled.source_hash === 'string'
        ? (precompiled.source_hash as Sha256Hash)
        : domainSeparatedSha256(
            'icarus:workflow-graph-source:1\n',
            graphSource,
          );
    const compilerSnapshotHash =
      compilerInput && typeof compilerInput.snapshot_hash === 'string'
        ? (compilerInput.snapshot_hash as Sha256Hash)
        : domainSeparatedSha256('icarus:workspace-compiler-snapshot:1\n', {
            recipe_hash: selection.recipe_hash,
            plan_hash: precompiled?.plan_hash ?? null,
          });
    const runResourceLimits = {
      scopes_total: 128,
      nodes_total: 512,
      edges_total: 1_024,
      map_items_total: 128,
      builds_total: 128,
      build_attempts_total: 256,
      attempts_total: 512,
      waits_total: 128,
      effect_operations_total: 512,
      facts_total: 4_096,
      active_executions: 8,
      active_waits: 16,
    };
    return {
      requestId: request.launch.request_id,
      creationDomain: request.launch.creation_domain,
      creationKey: request.launch.creation_key,
      principalRef: request.principal_ref,
      definition,
      executionPolicy,
      commandPolicy,
      inputSchema,
      contextContract,
      routingScope,
      input: values.input,
      attachments: values.attachments,
      contextSnapshot: values.context,
      routingDecision: values.routing,
      routingDecisionJson: { reason_codes: ['explicit_workspace_selection'] },
      runtimeSafetyHash: safetyHash,
      ownershipHash,
      creationIntentHash,
      workflowDefinitionVersion: definition.ref.version,
      recipeVersion: selection.recipe_ref.version,
      deadlineAtMs: request.launch.deadline_at_ms,
      resourceLimits: {
        state_activations_total: 32,
        graph_runs_total: 32,
        descendant_workflows_total: 32,
      },
      domainClaims: [],
      ...(temporary
        ? {
            launchConfirmation: {
              actorRef: request.principal_ref,
              idempotencyKey: request.authorization_ref,
              expiresAtMs: request.now_ms + 15 * 60_000,
              evidence: stateConfig.temporary_confirmation as JsonObject,
            },
          }
        : {}),
      initialActivation: {
        stateKey,
        stateType: ['delegation', 'system', 'interrupt', 'graph'].includes(
          String(state.type),
        )
          ? (state.type as 'delegation' | 'system' | 'interrupt' | 'graph')
          : 'graph',
        definition,
        definitionVersion: definition.ref.version,
        stateConfig: values.state,
        registrySnapshotId: snapshot.id,
        registrySnapshotHash: snapshot.hash,
        closureManifestId: snapshot.closure_id,
        closureHash: snapshot.closure_hash,
        runtimeSafetySnapshot: values.safety,
        runtimeSupportedLimits: supportedLimits,
        sqliteExecutionProfile: sqliteProfile,
        sourceSeedHash: sourceHash,
        compilerSnapshotHash,
        inputSnapshot: values.input,
        runResourceLimits,
        checkpoint: {
          status: 'workspace_launch',
          recipe_ref: selection.recipe_ref,
        },
        nowMs: request.now_ms,
      },
      nowMs: request.now_ms,
    };
  }

  private resourceByRef(
    resourceType: string,
    ref: VersionedRef,
  ): RuntimeRegistryRef {
    const row = this.store.queryOne<{
      id: string;
      content_hash: Sha256Hash;
    }>(
      `SELECT id, content_hash FROM workflow_registry_resources
        WHERE resource_type = ? AND resource_id = ? AND resource_version = ?
          AND publication_state = 'published'`,
      [resourceType, ref.id, ref.version],
    );
    if (!row) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        `Published ${resourceType} ${ref.id}@${ref.version} is unavailable`,
      );
    }
    return { rowId: row.id, resourceType, ref, hash: row.content_hash };
  }

  private firstResource(resourceType: string): RuntimeRegistryRef | null {
    const row = this.store.queryOne<{
      id: string;
      resource_id: string;
      resource_version: string;
      content_hash: Sha256Hash;
    }>(
      `SELECT id, resource_id, resource_version, content_hash
         FROM workflow_registry_resources
        WHERE resource_type = ? AND publication_state = 'published'
        ORDER BY resource_id COLLATE BINARY, resource_version COLLATE BINARY
        LIMIT 1`,
      [resourceType],
    );
    return row
      ? {
          rowId: row.id,
          resourceType,
          ref: { id: row.resource_id, version: row.resource_version },
          hash: row.content_hash,
        }
      : null;
  }

  private resourceContent(ref: RuntimeRegistryRef): JsonObject {
    const row = this.store.queryOne<{ inline_canonical_json: string }>(
      `SELECT value.inline_canonical_json
         FROM workflow_registry_resources resource
         JOIN workflow_values value ON value.id = resource.canonical_value_id
        WHERE resource.id = ? AND resource.content_hash = ?
          AND value.payload_state = 'live'`,
      [ref.rowId, ref.hash],
    );
    if (!row) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Published resource content is unavailable',
      );
    }
    return JSON.parse(row.inline_canonical_json) as JsonObject;
  }

  private snapshotForRecipe(recipeRowId: string): {
    id: string;
    hash: Sha256Hash;
    closure_id: string;
    closure_hash: Sha256Hash;
  } {
    const row = this.store.queryOne<{
      id: string;
      snapshot_hash: Sha256Hash;
      closure_manifest_id: string;
      closure_hash: Sha256Hash;
    }>(
      `SELECT snapshot.id, snapshot.snapshot_hash,
              snapshot.closure_manifest_id, snapshot.closure_hash
         FROM workflow_registry_snapshots snapshot
         JOIN workflow_registry_closure_members member
           ON member.closure_manifest_id = snapshot.closure_manifest_id
        WHERE member.resource_id = ?
        ORDER BY snapshot.created_at_ms DESC, snapshot.id COLLATE BINARY LIMIT 1`,
      [recipeRowId],
    );
    if (!row) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Selected Recipe has no pinned Registry snapshot',
      );
    }
    return {
      id: row.id,
      hash: row.snapshot_hash,
      closure_id: row.closure_manifest_id,
      closure_hash: row.closure_hash,
    };
  }

  private precompiledPlan(
    recipeRowId: string,
    definition: JsonObject,
  ): JsonObject | null {
    if (isObject(definition.precompiled_plan))
      return definition.precompiled_plan;
    if (isObject(definition.compiled_plan)) return definition.compiled_plan;
    const row = this.store.queryOne<{ inline_canonical_json: string }>(
      `SELECT plan.inline_canonical_json
         FROM workflow_feature_release_resources release_resource
         JOIN workflow_publisher_commands command
           ON command.target_feature_release_id = release_resource.release_id
          AND command.lifecycle = 'applied'
         JOIN workflow_values plan ON plan.id = command.compiled_plan_value_id
        WHERE release_resource.resource_id = ?
        ORDER BY command.finalized_at_ms DESC LIMIT 1`,
      [recipeRowId],
    );
    return row ? (JSON.parse(row.inline_canonical_json) as JsonObject) : null;
  }

  private persistLaunchValue(
    kind: string,
    creationKey: string,
    content: JsonValue,
    hash: Sha256Hash,
    schema: RuntimeRegistryRef,
    nowMs: number,
  ): { id: string; hash: Sha256Hash } {
    const id = stableRuntimeId('value', {
      source: 'task_workspace',
      creation_key: creationKey,
      kind,
      content_hash: hash,
    });
    this.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id,
        content,
        contentHash: hash,
        schemaResourceId: schema.rowId,
        schemaResourceHash: schema.hash,
        provenanceRef: `task-workspace:${creationKey}:${kind}`,
        retentionClass: 'run_recovery',
        createdAtMs: nowMs,
      });
    });
    return { id, hash };
  }

  findCreation(request: WorkspaceCreationLookup): WorkspaceCreationResult {
    assertPrincipal(request.principal_ref);
    const row = this.store.queryOne<{
      workflow_id: string | null;
      intake_id: string;
      id: string;
      creation_intent_hash: Sha256Hash;
      status: string;
      owner_principal_ref: string | null;
    }>(
      `SELECT cr.workflow_id, cr.intake_id, cr.id, cr.creation_intent_hash,
              cr.status, w.owner_principal_ref
         FROM workflow_creation_requests cr
         LEFT JOIN workflows w ON w.id = cr.workflow_id
        WHERE cr.creation_domain = ? AND cr.creation_key = ?`,
      [request.creation_domain, request.creation_key],
    );
    if (!row) {
      return {
        found: false,
        workflow_id: null,
        intake_id: null,
        creation_request_id: null,
        creation_intent_hash: null,
        status: null,
      };
    }
    if (
      row.owner_principal_ref &&
      row.owner_principal_ref !== request.principal_ref
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'permission_denied',
        'Creation belongs to another principal',
      );
    }
    return {
      found: true,
      workflow_id: row.workflow_id,
      intake_id: row.intake_id,
      creation_request_id: row.id,
      creation_intent_hash: row.creation_intent_hash,
      status: row.status,
    };
  }

  getRuntimeDetail(
    request: WorkspaceRuntimeDetailRequest,
  ): WorkspaceRuntimeDetail {
    assertPrincipal(request.principal_ref);
    const workflows = request.workflow_ids.map((workflowId) => {
      const workflow = this.store.queryOne<Record<string, unknown>>(
        `SELECT w.id, w.status, w.operational_state, w.recipe_resource_id,
                w.recipe_resource_hash, w.recipe_version, w.owner_principal_ref,
                current_graph_run_id, final_outcome_kind, final_error_code,
                deadline_at_ms, w.row_version, w.created_at_ms, w.updated_at_ms,
                w.finished_at_ms, recipe.resource_id AS recipe_id,
                recipe.resource_version AS recipe_ref_version
           FROM workflows w
           JOIN workflow_registry_resources recipe ON recipe.id = w.recipe_resource_id
          WHERE w.id = ? AND w.owner_principal_ref = ?`,
        [workflowId, request.principal_ref],
      );
      if (!workflow) {
        return {
          workflow_id: workflowId,
          availability: 'unavailable',
        } as JsonObject;
      }
      const runs = this.store.queryAll<Record<string, unknown>>(
        `SELECT id, state_instance_id AS activation_id, state_key,
                lifecycle, control, operational_state,
                root_scope_id, outcome_kind, exit_name, error_code,
                next_event_seq, row_version, started_at_ms, finished_at_ms,
                updated_at_ms
           FROM workflow_graph_runs WHERE workflow_id = ?
          ORDER BY started_at_ms DESC, id COLLATE BINARY`,
        [workflowId],
      );
      const scopes = this.store.queryAll<Record<string, unknown>>(
        `SELECT s.id, s.graph_run_id, s.parent_scope_id, s.owner_node_id,
                s.scope_kind, s.depth, s.lifecycle, s.outcome_kind, s.exit_name,
                s.error_code, s.row_version
           FROM workflow_graph_scopes s
           JOIN workflow_graph_runs r ON r.id = s.graph_run_id
          WHERE r.workflow_id = ?
          ORDER BY s.depth, s.id COLLATE BINARY`,
        [workflowId],
      );
      const nodes = this.store.queryAll<Record<string, unknown>>(
        `SELECT n.id, n.graph_run_id, n.scope_id, n.node_key, n.node_type,
                n.phase, n.trigger_state, n.input_state, n.terminal_status,
                n.terminal_code, n.current_attempt_id, n.active_wait_id,
                n.row_version, n.ready_at_ms, n.terminal_at_ms
           FROM workflow_graph_nodes n
           JOIN workflow_graph_runs r ON r.id = n.graph_run_id
          WHERE r.workflow_id = ?
          ORDER BY n.graph_run_id, n.scope_id, n.node_key COLLATE BINARY`,
        [workflowId],
      );
      const edgeRows = this.store.queryAll<Record<string, unknown>>(
        `SELECT e.id, e.graph_run_id, e.scope_id, e.edge_key, e.edge_kind,
                e.compiled_edge_json, e.compiled_edge_hash,
                CASE e.edge_kind WHEN 'control' THEN control.state ELSE data.state END
                  AS resolution_state,
                control.decision_json, data.value_value_id, data.value_hash,
                data.schema_hash, data.source_attempt_id,
                CASE e.edge_kind WHEN 'control' THEN control.error_code ELSE data.error_code END
                  AS resolution_error_code,
                CASE e.edge_kind WHEN 'control' THEN control.resolution_seq ELSE data.resolution_seq END
                  AS resolution_seq,
                CASE e.edge_kind WHEN 'control' THEN control.resolved_at_ms ELSE data.resolved_at_ms END
                  AS resolved_at_ms
           FROM workflow_graph_edges e
           JOIN workflow_graph_runs r ON r.id = e.graph_run_id
      LEFT JOIN workflow_graph_control_edge_resolutions control
             ON control.edge_id = e.id AND e.edge_kind = 'control'
      LEFT JOIN workflow_graph_data_edge_resolutions data
             ON data.edge_id = e.id AND e.edge_kind = 'data'
          WHERE r.workflow_id = ?
          ORDER BY e.graph_run_id, e.scope_id, e.edge_key COLLATE BINARY`,
        [workflowId],
      );
      const edges = edgeRows.map((edge) => {
        const compiledValue = parseStoredJson(edge.compiled_edge_json);
        const compiled = isObject(compiledValue) ? compiledValue : null;
        const from = isObject(compiled?.from) ? compiled.from : null;
        const to = isObject(compiled?.to) ? compiled.to : null;
        const fromNodeId =
          stringField(compiled, 'from_node_id') ?? stringField(from, 'node_id');
        const toNodeId =
          stringField(compiled, 'to_node_id') ?? stringField(to, 'node_id');
        return {
          id: edge.id,
          graph_run_id: edge.graph_run_id,
          scope_id: edge.scope_id,
          edge_key: edge.edge_key,
          edge_kind: edge.edge_kind,
          compiled_edge_json: compiledValue,
          compiled_edge_hash: edge.compiled_edge_hash,
          from_node_id: fromNodeId,
          from_node_key: fromNodeId,
          to_node_id: toNodeId,
          to_node_key: toNodeId,
          resolution: {
            state: edge.resolution_state,
            decision_json: parseStoredJson(edge.decision_json),
            value_value_id: edge.value_value_id,
            value_hash: edge.value_hash,
            schema_hash: edge.schema_hash,
            source_attempt_id: edge.source_attempt_id,
            error_code: edge.resolution_error_code,
            resolution_seq: edge.resolution_seq,
            resolved_at_ms: edge.resolved_at_ms,
          },
        } as JsonObject;
      });
      const attemptRows = this.store.queryAll<Record<string, unknown>>(
        `SELECT attempt.id, attempt.graph_run_id, attempt.scope_id, attempt.node_id,
                attempt.attempt_no, attempt.continuation_kind,
                attempt.parent_attempt_id, attempt.parent_attempt_no, attempt.phase,
                attempt.execution_outcome, attempt.quality_decision,
                attempt.selected_edges_json, attempt.delegation_id,
                attempt.external_execution_id, attempt.action_name, attempt.query_id,
                attempt.dispatch_started_at_ms, attempt.dispatch_deadline_at_ms,
                attempt.execution_started_at_ms, attempt.execution_deadline_at_ms,
                attempt.artifact_refs_value_id, attempt.artifact_refs_hash,
                attempt.result_value_id, attempt.result_hash,
                attempt.retry_reason_code, attempt.error_code, attempt.acceptance_state,
                attempt.row_version, attempt.created_at_ms, attempt.updated_at_ms,
                attempt.finished_at_ms
           FROM workflow_graph_node_attempts attempt
           JOIN workflow_graph_runs r ON r.id = attempt.graph_run_id
          WHERE r.workflow_id = ?
          ORDER BY attempt.graph_run_id, attempt.scope_id, attempt.node_id,
                   attempt.attempt_no, attempt.id COLLATE BINARY`,
        [workflowId],
      );
      const attempts = attemptRows.map((attempt) => ({
        ...attempt,
        selected_edges_json: parseStoredJson(attempt.selected_edges_json) ?? [],
      })) as JsonObject[];
      const completionCuts = this.store.queryAll<Record<string, unknown>>(
        `SELECT cut.id, cut.graph_run_id, cut.scope_id, cut.close_request_id,
                cut.selected_rule_id, cut.candidate_id, cut.outcome_kind,
                cut.exit_name, cut.output_value_id, cut.output_hash,
                cut.completion_policy_hash, cut.cut_event_seq, cut.cut_hash,
                cut.created_at_ms
           FROM workflow_graph_completion_cuts cut
           JOIN workflow_graph_runs r ON r.id = cut.graph_run_id
          WHERE r.workflow_id = ?
          ORDER BY cut.graph_run_id, cut.created_at_ms, cut.id COLLATE BINARY`,
        [workflowId],
      );
      const artifactRows = this.store.queryAll<Record<string, unknown>>(
        `SELECT attempt.graph_run_id, attempt.scope_id, attempt.node_id,
                attempt.id AS attempt_id,
                value.id AS result_value_id, value.content_hash AS result_hash,
                value.storage_kind, value.inline_canonical_json,
                value.provenance_ref, value.retention_class,
                value.payload_state, value.created_at_ms
           FROM workflow_graph_node_attempts attempt
           JOIN workflow_graph_runs r ON r.id = attempt.graph_run_id
           JOIN workflow_values value
             ON value.id = attempt.result_value_id
            AND value.content_hash = attempt.result_hash
          WHERE r.workflow_id = ?
          ORDER BY attempt.graph_run_id, attempt.scope_id, attempt.node_id,
                   attempt.attempt_no, attempt.id COLLATE BINARY`,
        [workflowId],
      );
      const artifacts = artifactRows.flatMap((row) => {
        const resultValue = parseStoredJson(row.inline_canonical_json);
        const result = isObject(resultValue) ? resultValue : null;
        if (
          result?.format !== 'icarus.workflow-agent-result/1' ||
          !Array.isArray(result.artifacts)
        ) {
          return [];
        }
        return result.artifacts.flatMap((value, artifactIndex) => {
          const artifact = isObject(value) ? value : null;
          if (
            !artifact ||
            typeof artifact.name !== 'string' ||
            typeof artifact.path !== 'string'
          ) {
            return [];
          }
          const resultHash = row.result_hash as Sha256Hash;
          const artifactRef = `workflow-result:${String(row.result_value_id)}:artifact:${String(artifactIndex)}`;
          const artifactHash = workspaceArtifactHash({
            resultHash,
            artifactIndex,
            artifact,
          });
          const mediaType = stringField(artifact, 'content_type');
          const byteLength = Number(artifact.size);
          return [
            {
              graph_run_id: row.graph_run_id,
              scope_id: row.scope_id,
              node_id: row.node_id,
              attempt_id: row.attempt_id,
              artifact_ref: artifactRef,
              artifact_hash: artifactHash,
              result_value_id: row.result_value_id,
              result_hash: resultHash,
              artifact_index: artifactIndex,
              storage_kind: row.storage_kind,
              provenance_ref: row.provenance_ref,
              retention_class: row.retention_class,
              payload_state: row.payload_state,
              created_at_ms: row.created_at_ms,
              display_json: {
                artifact_ref: artifactRef,
                title: artifact.name,
                path: artifact.path,
                relative_path: stringField(artifact, 'relative_path'),
                download_url: stringField(artifact, 'download_url'),
                media_type: mediaType,
                byte_length: Number.isSafeInteger(byteLength)
                  ? byteLength
                  : null,
                payload_state: row.payload_state,
              },
            } as JsonObject,
          ];
        });
      });
      const waits = this.store.queryAll<Record<string, unknown>>(
        `SELECT wt.id, wt.graph_run_id, wt.scope_id, wt.node_id, wt.wait_type,
                wt.status, wt.deadline_at_ms, wt.row_version, wt.created_at_ms,
                wt.resolved_at_ms
           FROM workflow_graph_waits wt
           JOIN workflow_graph_runs r ON r.id = wt.graph_run_id
          WHERE r.workflow_id = ?
          ORDER BY wt.created_at_ms, wt.id COLLATE BINARY`,
        [workflowId],
      );
      const currentRun = runs.find(
        (run) => run.id === workflow.current_graph_run_id,
      );
      const commandActions =
        workflow.status === 'active' &&
        currentRun !== undefined &&
        currentRun.lifecycle !== 'closed' &&
        currentRun.operational_state === 'healthy'
          ? currentRun.control === 'running'
            ? (['pause', 'cancel'] as const)
            : currentRun.control === 'paused'
              ? (['resume', 'cancel'] as const)
              : []
          : [];
      return {
        ...workflow,
        availability: 'available',
        runs,
        scopes,
        nodes,
        edges,
        attempts,
        completion_cuts: completionCuts,
        artifacts,
        pending: waits.filter((wait) => wait.status === 'armed'),
        waits,
        command_hints: commandActions.map((action) => ({
          action,
          workflow_id: workflowId,
          run_id: String(currentRun!.id),
          expected_target_row_version: Number(currentRun!.row_version),
        })),
      } as JsonObject;
    });
    return {
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows,
    };
  }

  listRuntimeEvents(
    request: WorkspaceRuntimeEventRequest,
  ): WorkspaceRuntimeEventPage {
    assertPrincipal(request.principal_ref);
    const limit = request.limit ?? 200;
    if (
      !Number.isSafeInteger(request.after_event_seq) ||
      request.after_event_seq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'invalid_request',
        'Runtime event cursor or page size is invalid',
      );
    }
    const lineage = this.store.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM workflow_graph_runs r
        JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ? AND r.workflow_id = ? AND w.owner_principal_ref = ?`,
      [request.run_id, request.workflow_id, request.principal_ref],
    );
    if (!lineage) {
      throw new RuntimeWorkspaceGatewayError(
        'target_not_found',
        'Runtime execution lineage is unavailable',
      );
    }
    const rows = this.store.queryAll<Record<string, unknown>>(
      `SELECT seq, scope_id, node_id, attempt_id, event_type, idempotency_key,
              payload_json, payload_value_id, payload_hash, occurred_at_ms,
              created_at_ms
         FROM workflow_graph_events
        WHERE graph_run_id = ? AND seq > ?
        ORDER BY seq ASC LIMIT ?`,
      [request.run_id, request.after_event_seq, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => ({
      ...row,
      payload:
        typeof row.payload_json === 'string'
          ? (JSON.parse(row.payload_json) as JsonValue)
          : null,
    })) as JsonObject[];
    return {
      format: 'icarus.workspace-runtime-event-page/1',
      workflow_id: request.workflow_id,
      run_id: request.run_id,
      events: page,
      next_event_seq:
        page.length > 0
          ? Number(page[page.length - 1]!.seq)
          : request.after_event_seq,
      has_more: hasMore,
    };
  }

  submitInteraction(
    request: WorkspaceInteractionRequest,
  ): T6cWaitResolutionReceipt {
    assertWorkspaceInteractionRequest(request);
    const providerRef = 'task_workspace';
    const providerEventId = stableRuntimeId('workspace-interaction-event', {
      idempotency_key: request.idempotency_key,
    });
    const prepared = this.store.withImmediateTransaction((transaction) => {
      const wait = transaction.queryOne<{
        graph_run_id: string;
        scope_id: string;
        node_id: string;
        wait_type: string;
        status: string;
        deadline_at_ms: number | null;
        wait_row_version: number;
        wait_run_work_fence_epoch: number;
        wait_scope_work_fence_epoch: number;
        workflow_id: string;
        owner_principal_ref: string;
        run_control: string;
        run_operational_state: string;
        run_work_fence_epoch: number;
        scope_lifecycle: string;
        scope_work_fence_epoch: number;
        node_phase: string;
        active_wait_id: string | null;
      }>(
        `SELECT wt.graph_run_id, wt.scope_id, wt.node_id, wt.wait_type,
                wt.status, wt.deadline_at_ms,
                wt.row_version AS wait_row_version,
                wt.run_work_fence_epoch AS wait_run_work_fence_epoch,
                wt.scope_work_fence_epoch AS wait_scope_work_fence_epoch,
                r.workflow_id, w.owner_principal_ref,
                r.control AS run_control,
                r.operational_state AS run_operational_state,
                r.work_fence_epoch AS run_work_fence_epoch,
                s.lifecycle AS scope_lifecycle,
                s.work_fence_epoch AS scope_work_fence_epoch,
                n.phase AS node_phase, n.active_wait_id
           FROM workflow_graph_waits wt
           JOIN workflow_graph_runs r ON r.id = wt.graph_run_id
           JOIN workflows w ON w.id = r.workflow_id
           JOIN workflow_graph_scopes s
             ON s.id = wt.scope_id AND s.graph_run_id = wt.graph_run_id
           JOIN workflow_graph_nodes n
             ON n.id = wt.node_id AND n.scope_id = wt.scope_id
            AND n.graph_run_id = wt.graph_run_id
          WHERE wt.id = ?`,
        [request.wait_id],
      );
      if (!wait) {
        throw new RuntimeWorkspaceGatewayError(
          'target_not_found',
          'Workspace interaction Wait is unavailable',
        );
      }
      if (wait.owner_principal_ref !== request.principal_ref) {
        throw new RuntimeWorkspaceGatewayError(
          'permission_denied',
          'Workspace interaction Wait belongs to another principal',
        );
      }
      if (wait.wait_type !== 'signal' && wait.wait_type !== 'approval') {
        throw new RuntimeWorkspaceGatewayError(
          'invalid_request',
          'Only signal and approval Waits accept Workspace Human Input',
        );
      }
      const prior = transaction.queryOne<{ target_wait_id: string | null }>(
        `SELECT target_wait_id FROM workflow_graph_inbox_events
          WHERE provider_ref = ? AND provider_event_id = ?`,
        [providerRef, providerEventId],
      );
      if (
        !prior &&
        (wait.status !== 'armed' ||
          wait.node_phase !== 'waiting' ||
          wait.active_wait_id !== request.wait_id ||
          wait.run_control !== 'running' ||
          wait.run_operational_state !== 'healthy' ||
          wait.scope_lifecycle !== 'active' ||
          (wait.deadline_at_ms !== null &&
            request.now_ms > wait.deadline_at_ms))
      ) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          'Workspace interaction Wait is no longer armed on the active lineage',
        );
      }

      const authority = loadMaterializedNodeAuthority(
        transaction,
        wait.graph_run_id,
        wait.scope_id,
        wait.node_id,
      );
      if (
        authority.runWorkFenceEpoch !== wait.run_work_fence_epoch ||
        authority.scopeWorkFenceEpoch !== wait.scope_work_fence_epoch ||
        wait.wait_run_work_fence_epoch !== wait.run_work_fence_epoch ||
        wait.wait_scope_work_fence_epoch !== wait.scope_work_fence_epoch ||
        authority.node.type !== 'wait'
      ) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          'Workspace interaction Wait authority drifted from its sealed Plan',
        );
      }
      const waitBinding = requiredObjectField(
        authority.node,
        'wait_binding',
        'Workspace interaction Plan node',
      );
      if (waitBinding.type !== wait.wait_type) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          'Workspace interaction Wait type drifted from its sealed Plan',
        );
      }
      const outputPorts = requiredObjectField(
        authority.node,
        'output_ports',
        'Workspace interaction Plan node',
      );
      const outputPort = requiredObjectField(
        outputPorts,
        'resolution',
        'Workspace interaction Plan output ports',
      );
      if (Object.keys(outputPorts).length !== 1) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          'Workspace Wait must expose exactly the resolution output port',
        );
      }
      const compiledSchema = requiredObjectField(
        outputPort,
        'schema',
        'Workspace interaction resolution output',
      );
      const schemaRef = requiredObjectField(
        compiledSchema,
        'ref',
        'Workspace interaction resolution schema',
      );
      if (
        compiledSchema.type !== 'registry' ||
        typeof schemaRef.id !== 'string' ||
        typeof schemaRef.version !== 'string' ||
        typeof compiledSchema.schema_hash !== 'string'
      ) {
        throw new RuntimeWorkspaceGatewayError(
          'lineage_mismatch',
          'Workspace Wait resolution schema is not an exact Registry schema',
        );
      }
      const payloadSchema = transaction.queryOne<{
        id: string;
        content_hash: Sha256Hash;
      }>(
        `SELECT id, content_hash FROM workflow_registry_resources
          WHERE resource_type = 'schema' AND resource_id = ?
            AND resource_version = ? AND content_hash = ?
            AND publication_state = 'published'`,
        [schemaRef.id, schemaRef.version, compiledSchema.schema_hash],
      );
      const authorizationSchema = transaction.queryOne<{
        id: string;
        content_hash: Sha256Hash;
      }>(
        `SELECT id, content_hash FROM workflow_registry_resources
          WHERE resource_type = 'schema'
            AND resource_id = 'icarus.task-workspace.generic-json'
            AND resource_version = '1.0.0'
            AND publication_state = 'published'`,
        [],
      );
      if (!payloadSchema || !authorizationSchema) {
        throw new RuntimeWorkspaceGatewayError(
          'target_not_found',
          'Workspace interaction Value schema authority is unavailable',
        );
      }

      const bindingIdentity = {
        interaction_id: request.interaction_id,
        wait_id: request.wait_id,
        workflow_id: wait.workflow_id,
        graph_run_id: wait.graph_run_id,
        scope_id: wait.scope_id,
        node_id: wait.node_id,
        rendered_snapshot_hash: request.rendered_snapshot_hash,
        action_id: request.action_id,
        payload_hash: request.payload_hash,
        expected_target_row_version: request.expected_target_row_version,
        idempotency_key: request.idempotency_key,
      } satisfies JsonObject;
      const ingressContent = {
        format: 'icarus.workflow-wait-ingress-authorization/1',
        phase: 'ingress',
        source: 'task_workspace',
        principal_ref: request.principal_ref,
        ...bindingIdentity,
      } satisfies JsonObject;
      const bindingContent = {
        format: 'icarus.workflow-wait-binding-authorization/1',
        phase: 'binding',
        ...bindingIdentity,
        run_work_fence_epoch: wait.run_work_fence_epoch,
        scope_work_fence_epoch: wait.scope_work_fence_epoch,
        plan_hash: authority.planHash,
        output_schema_hash: payloadSchema.content_hash,
      } satisfies JsonObject;
      const payloadValue = {
        id: stableRuntimeId('workspace-wait-payload', {
          provider_event_id: providerEventId,
          payload_hash: request.payload_hash,
        }),
        hash: request.payload_hash,
      };
      const ingressAuthorization = {
        id: stableRuntimeId('workspace-wait-ingress-authorization', {
          provider_event_id: providerEventId,
          request: ingressContent,
        }),
        hash: runtimeObjectHash(
          'workspace-wait-ingress-authorization',
          ingressContent,
        ),
      };
      const bindingAuthorization = {
        id: stableRuntimeId('workspace-wait-binding-authorization', {
          provider_event_id: providerEventId,
          request: bindingContent,
        }),
        hash: runtimeObjectHash(
          'workspace-wait-binding-authorization',
          bindingContent,
        ),
      };
      const provenanceRef = `task-workspace-interaction:${providerEventId}`;
      insertInlineValue(transaction, {
        ...payloadValue,
        content: request.payload_json,
        contentHash: payloadValue.hash,
        schemaResourceId: payloadSchema.id,
        schemaResourceHash: payloadSchema.content_hash,
        provenanceRef,
        retentionClass: 'run_recovery',
        ownerGraphRunId: wait.graph_run_id,
        createdAtMs: request.now_ms,
      });
      insertInlineValue(transaction, {
        id: ingressAuthorization.id,
        content: ingressContent,
        contentHash: ingressAuthorization.hash,
        schemaResourceId: authorizationSchema.id,
        schemaResourceHash: authorizationSchema.content_hash,
        provenanceRef,
        retentionClass: 'workflow_audit',
        ownerGraphRunId: wait.graph_run_id,
        createdAtMs: request.now_ms,
      });
      insertInlineValue(transaction, {
        id: bindingAuthorization.id,
        content: bindingContent,
        contentHash: bindingAuthorization.hash,
        schemaResourceId: authorizationSchema.id,
        schemaResourceHash: authorizationSchema.content_hash,
        provenanceRef,
        retentionClass: 'workflow_audit',
        ownerGraphRunId: wait.graph_run_id,
        createdAtMs: request.now_ms,
      });
      return {
        wait,
        payloadValue,
        ingressAuthorization,
        bindingAuthorization,
      };
    });
    const receipt = resolveWaitT6c(this.store, {
      waitId: request.wait_id,
      providerRef,
      providerEventId,
      principalRef: request.principal_ref,
      workflowId: prepared.wait.workflow_id,
      resolution: 'signal',
      payload: prepared.payloadValue,
      payloadByteLength: Buffer.byteLength(
        canonicalJson(request.payload_json),
        'utf8',
      ),
      ingressAuthorization: prepared.ingressAuthorization,
      bindingAuthorization: prepared.bindingAuthorization,
      expectedWaitRowVersion: request.expected_target_row_version,
      expectedRunWorkFenceEpoch: prepared.wait.run_work_fence_epoch,
      expectedScopeWorkFenceEpoch: prepared.wait.scope_work_fence_epoch,
      receivedAtMs: request.now_ms,
      expiresAtMs: prepared.wait.deadline_at_ms ?? Number.MAX_SAFE_INTEGER,
    });
    this.options.on_runtime_commit?.({
      workflow_id: prepared.wait.workflow_id,
      run_id: prepared.wait.graph_run_id,
    });
    return receipt;
  }

  submitCommand(
    request: WorkspaceRuntimeCommandRequest,
  ): WorkspaceRuntimeCommandReceipt {
    assertWorkspaceCommandRequest(request);
    const target = this.store.queryOne<{
      workflow_id: string;
      owner_principal_ref: string;
      current_graph_run_id: string | null;
      run_id: string;
      run_row_version: number;
      state_config_json: string;
    }>(
      `SELECT w.id AS workflow_id, w.owner_principal_ref,
              w.current_graph_run_id, r.id AS run_id,
              r.row_version AS run_row_version,
              value.inline_canonical_json AS state_config_json
         FROM workflows w
         JOIN workflow_graph_runs r ON r.workflow_id = w.id
         JOIN workflow_values value ON value.id = r.state_config_value_id
        WHERE w.id = ? AND r.id = ?`,
      [request.workflow_id, request.run_id],
    );
    if (!target) {
      throw new RuntimeWorkspaceGatewayError(
        'target_not_found',
        'Workspace Runtime command target is unavailable',
      );
    }
    if (target.owner_principal_ref !== request.principal_ref) {
      throw new RuntimeWorkspaceGatewayError(
        'permission_denied',
        'Workspace Runtime command target belongs to another principal',
      );
    }
    if (target.current_graph_run_id !== request.run_id) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        'Workspace Runtime command requires the current Run',
      );
    }
    const stateConfig = JSON.parse(target.state_config_json) as JsonObject;
    const auditSchema = this.runtimeRefFromState(
      stateConfig.manifest_schema,
      'Workspace Runtime command audit schema',
    );
    const fenceManifestSchema = this.runtimeRefFromState(
      stateConfig.fence_manifest_schema,
      'Workspace Runtime command fence schema',
    );
    const capacity = this.capacityPublication();
    if (!capacity) {
      throw new RuntimeWorkspaceGatewayError(
        'target_not_found',
        'Workspace Runtime command Capacity authority is unavailable',
      );
    }
    const commandType = {
      pause: 'pause_run',
      resume: 'resume_run',
      cancel: 'cancel_run',
    }[request.action] as 'pause_run' | 'resume_run' | 'cancel_run';
    const command: WorkflowRuntimeCommandDocument = {
      command_id: stableRuntimeId('workspace-runtime-command', {
        operation_ref: request.operation_ref,
      }),
      idempotency_key: request.idempotency_key,
      expected_row_version: request.expected_target_row_version,
      reason_code: 'operator_requested',
      evidence_refs: [],
      command_type: commandType,
      target: { run_id: request.run_id },
    };
    const permissions = new Set<RuntimePermissionCode>([
      request.action === 'cancel' ? 'workflow.cancel.own' : 'workflow.operate',
    ]);
    const receipt = submitRuntimeCommand(this.store, {
      command,
      actor: {
        authenticated: true,
        actorRef: request.principal_ref,
        actorKind: 'human',
        authSessionRef: `task-workspace:${request.operation_ref}`,
        entrypoint: 'task_workspace',
        sourceFeatureId: null,
        delegationChainRef: null,
        permissions,
        featurePermissionCeiling: null,
      },
      auditSchema,
      fenceManifestSchema,
      capacityWatcher: { current: () => capacity },
      nowMs: request.now_ms,
    });
    this.options.on_runtime_commit?.({
      workflow_id: request.workflow_id,
      run_id: request.run_id,
    });
    return {
      format: 'icarus.workspace-runtime-command-receipt/1',
      execution_result: receipt.executionResult,
      denial_code: receipt.denialCode,
      ingress_invocation_id: receipt.ingressInvocationId,
      command_id: receipt.commandId,
      invocation_id: receipt.invocationId,
      canonical_result: receipt.canonicalResult,
    };
  }

  private runtimeRefFromState(
    value: JsonValue | undefined,
    label: string,
  ): RuntimeRegistryRef {
    if (
      !isObject(value) ||
      typeof value.rowId !== 'string' ||
      typeof value.resourceType !== 'string' ||
      !isObject(value.ref) ||
      typeof value.ref.id !== 'string' ||
      typeof value.ref.version !== 'string' ||
      typeof value.hash !== 'string'
    ) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        `${label} is missing from the sealed Run state`,
      );
    }
    const ref = {
      rowId: value.rowId,
      resourceType: value.resourceType,
      ref: { id: value.ref.id, version: value.ref.version },
      hash: value.hash as Sha256Hash,
    };
    const exact = this.store.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM workflow_registry_resources
        WHERE id = ? AND resource_type = ? AND resource_id = ?
          AND resource_version = ? AND content_hash = ?
          AND publication_state = 'published'`,
      [ref.rowId, ref.resourceType, ref.ref.id, ref.ref.version, ref.hash],
    );
    if (!exact) {
      throw new RuntimeWorkspaceGatewayError(
        'lineage_mismatch',
        `${label} is not an exact published Registry resource`,
      );
    }
    return ref;
  }

  private capacityPublication() {
    const row = this.store.queryOne<{
      current_capacity_revision: number;
      current_change_id: string;
      current_publication_hash: Sha256Hash;
      proposed_capacity_json: string;
      previous_config_hash: Sha256Hash | null;
    }>(
      `SELECT h.current_capacity_revision, h.current_change_id,
              h.current_publication_hash, command.proposed_capacity_json,
              previous.proposed_config_hash AS previous_config_hash
         FROM runtime_capacity_head h
         JOIN runtime_capacity_admin_commands command
           ON command.assigned_capacity_revision = h.current_capacity_revision
          AND command.assigned_change_id = h.current_change_id
    LEFT JOIN runtime_capacity_admin_commands previous
           ON previous.assigned_capacity_revision = h.current_capacity_revision - 1
        WHERE h.singleton_key = 1`,
      [],
    );
    if (!row) return null;
    const publication = buildDeploymentCapacityPublication(
      row.current_capacity_revision,
      row.current_change_id,
      row.previous_config_hash,
      JSON.parse(
        row.proposed_capacity_json,
      ) as DeploymentRuntimeCapacitySnapshot,
    );
    return publication.publication_hash === row.current_publication_hash
      ? publication
      : null;
  }

  private replanCommandIdentity(
    request: WorkspaceTemporaryReplanReconcileRequest,
  ): { readonly commandId: string; readonly idempotencyKey: string } {
    return {
      commandId: stableRuntimeId('workspace-temporary-replan-command', {
        source_workflow_id: request.source_workflow_id,
        source_activation_id: request.source_activation_id,
        source_run_id: request.source_run_id,
        replan_creation_key: request.replan_creation_key,
        proposal_hash: request.proposal_hash,
        confirmation_ref: request.confirmation_ref,
        confirmation_hash: request.confirmation_hash,
      }),
      idempotencyKey: stableRuntimeId(
        'workspace-temporary-replan-command-idempotency',
        {
          principal_ref: request.principal_ref,
          source_workflow_id: request.source_workflow_id,
          source_run_id: request.source_run_id,
          replan_creation_key: request.replan_creation_key,
        },
      ),
    };
  }

  private replanReceipt(
    request: WorkspaceTemporaryReplanReconcileRequest,
    disposition: WorkspaceReplanReceipt['disposition'],
    code: string,
    sourceFenceReceipt: JsonObject | null = null,
    targetActivationId: string | null = null,
    targetRunId: string | null = null,
  ): WorkspaceReplanReceipt {
    return {
      format: 'icarus.workspace-temporary-replan-receipt/1',
      disposition,
      code,
      source_workflow_id: request.source_workflow_id,
      source_activation_id: request.source_activation_id,
      source_run_id: request.source_run_id,
      proposal_hash: request.proposal_hash,
      replan_creation_key: request.replan_creation_key,
      confirmation_ref: request.confirmation_ref,
      confirmation_hash: request.confirmation_hash,
      source_fence_receipt: sourceFenceReceipt,
      target_activation_id: targetActivationId,
      target_run_id: targetRunId,
    };
  }

  private reconcileTemporaryReplanInternal(
    request: WorkspaceTemporaryReplanReconcileRequest,
  ): WorkspaceReplanReceipt {
    const expectedConfirmationHash =
      calculateWorkspaceTemporaryReplanConfirmationHash({
        principal_ref: request.principal_ref,
        source_workflow_id: request.source_workflow_id,
        source_activation_id: request.source_activation_id,
        source_run_id: request.source_run_id,
        replan_creation_key: request.replan_creation_key,
        proposal_hash: request.proposal_hash,
        confirmation_ref: request.confirmation_ref,
      });
    if (expectedConfirmationHash !== request.confirmation_hash) {
      return this.replanReceipt(request, 'denied', 'confirmation_mismatch');
    }
    const workflow = this.store.queryOne<{ owner_principal_ref: string }>(
      'SELECT owner_principal_ref FROM workflows WHERE id = ?',
      [request.source_workflow_id],
    );
    if (!workflow) {
      return this.replanReceipt(request, 'denied', 'target_not_found');
    }
    if (workflow.owner_principal_ref !== request.principal_ref) {
      return this.replanReceipt(request, 'denied', 'permission_denied');
    }
    const commandIdentity = this.replanCommandIdentity(request);
    const command = this.store.queryOne<{
      command_id: string;
      command_type: string;
      run_id: string | null;
      reason_code: string;
      evidence_manifest_value_id: string;
      evidence_manifest_hash: Sha256Hash;
      canonical_result_value_id: string | null;
      canonical_result_hash: Sha256Hash | null;
    }>(
      `SELECT command_id, command_type, run_id, reason_code,
              evidence_manifest_value_id, evidence_manifest_hash,
              canonical_result_value_id, canonical_result_hash
         FROM workflow_runtime_commands
        WHERE idempotency_domain = ? AND idempotency_key = ?`,
      [
        `human:${request.principal_ref}:task_workspace`,
        commandIdentity.idempotencyKey,
      ],
    );
    if (!command) {
      return this.replanReceipt(request, 'denied', 'replan_not_submitted');
    }
    if (
      command.command_id !== commandIdentity.commandId ||
      command.command_type !== 'cancel_run' ||
      command.run_id !== request.source_run_id ||
      command.reason_code !== 'superseded'
    ) {
      return this.replanReceipt(request, 'denied', 'idempotency_conflict');
    }
    const evidenceValue = this.store.queryOne<{
      inline_canonical_json: string | null;
      content_hash: Sha256Hash;
      payload_state: string;
    }>(
      `SELECT inline_canonical_json, content_hash, payload_state
         FROM workflow_values WHERE id = ? AND content_hash = ?`,
      [command.evidence_manifest_value_id, command.evidence_manifest_hash],
    );
    let evidence: JsonObject | null = null;
    try {
      const parsed = evidenceValue?.inline_canonical_json
        ? (JSON.parse(evidenceValue.inline_canonical_json) as JsonValue)
        : null;
      evidence = isObject(parsed) ? parsed : null;
    } catch {
      evidence = null;
    }
    const evidenceRefs = evidence?.evidence_refs;
    if (
      evidenceValue?.payload_state !== 'live' ||
      !evidence ||
      runtimeObjectHash('g7-command-evidence', evidence) !==
        command.evidence_manifest_hash ||
      !Array.isArray(evidenceRefs) ||
      evidenceRefs.length !== 2 ||
      typeof evidenceRefs[0] !== 'string' ||
      typeof evidenceRefs[1] !== 'string'
    ) {
      return this.replanReceipt(request, 'denied', 'evidence_mismatch');
    }
    const targetConfigValue = this.store.queryOne<{
      inline_canonical_json: string | null;
      content_hash: Sha256Hash;
      payload_state: string;
    }>(
      `SELECT inline_canonical_json, content_hash, payload_state
         FROM workflow_values WHERE id = ? AND content_hash = ?`,
      [evidenceRefs[0], evidenceRefs[1]],
    );
    let targetConfig: JsonObject | null = null;
    try {
      const parsed = targetConfigValue?.inline_canonical_json
        ? (JSON.parse(targetConfigValue.inline_canonical_json) as JsonValue)
        : null;
      targetConfig = isObject(parsed) ? parsed : null;
    } catch {
      targetConfig = null;
    }
    const marker =
      targetConfig && isObject(targetConfig.temporary_replan)
        ? targetConfig.temporary_replan
        : null;
    if (
      targetConfigValue?.payload_state !== 'live' ||
      !targetConfig ||
      !marker ||
      marker.format !== 'icarus.temporary-replan-target/1' ||
      marker.source_workflow_id !== request.source_workflow_id ||
      marker.source_activation_id !== request.source_activation_id ||
      marker.source_run_id !== request.source_run_id ||
      marker.creation_key !== request.replan_creation_key ||
      marker.proposal_hash !== request.proposal_hash ||
      marker.confirmation_ref !== request.confirmation_ref ||
      marker.confirmation_hash !== request.confirmation_hash
    ) {
      return this.replanReceipt(request, 'denied', 'target_config_mismatch');
    }
    const appliedInvocation = this.store.queryOne<{
      invocation_id: string;
      close_request_id: string;
      canonical_result_json: string | null;
    }>(
      `SELECT invocation.id AS invocation_id, invocation.close_request_id,
              result.inline_canonical_json AS canonical_result_json
         FROM workflow_runtime_command_invocations invocation
    LEFT JOIN workflow_values result
           ON result.id = ? AND result.content_hash = ?
        WHERE invocation.command_id = ?
          AND invocation.authorization_result = 'allowed'
          AND invocation.execution_result = 'applied'
          AND invocation.entrypoint = 'task_workspace'
          AND invocation.actor_kind = 'human'
          AND invocation.actor_ref = ?
          AND invocation.close_request_id IS NOT NULL
        ORDER BY invocation.invocation_no LIMIT 1`,
      [
        command.canonical_result_value_id,
        command.canonical_result_hash,
        command.command_id,
        request.principal_ref,
      ],
    );
    if (!appliedInvocation) {
      const latest = this.store.queryOne<{
        execution_result: string;
      }>(
        `SELECT execution_result FROM workflow_runtime_command_invocations
          WHERE command_id = ? ORDER BY invocation_no DESC LIMIT 1`,
        [command.command_id],
      );
      return this.replanReceipt(
        request,
        'denied',
        latest
          ? `runtime_command_${latest.execution_result}`
          : 'runtime_command_missing',
      );
    }
    let canonicalResult: JsonObject | null = null;
    try {
      const parsed = appliedInvocation.canonical_result_json
        ? (JSON.parse(appliedInvocation.canonical_result_json) as JsonValue)
        : null;
      canonicalResult = isObject(parsed) ? parsed : null;
    } catch {
      canonicalResult = null;
    }
    const sourceFenceReceipt: JsonObject = {
      format: 'icarus.workspace-temporary-replan-source-fence/1',
      command_id: command.command_id,
      invocation_id: appliedInvocation.invocation_id,
      execution_result: 'applied',
      close_request_id: appliedInvocation.close_request_id,
      target_state_config_value_id: evidenceRefs[0],
      target_state_config_hash: evidenceRefs[1],
      canonical_result: canonicalResult,
    };
    const target = this.store.queryOne<{
      transition_id: string;
      target_state_key: string | null;
      target_activation_id: string | null;
      target_run_id: string | null;
      activation_graph_run_id: string | null;
      activation_state_config_value_id: string;
      activation_state_config_hash: Sha256Hash;
      target_run_workflow_id: string | null;
    }>(
      `SELECT transition.id AS transition_id, transition.target_state_key,
              transition.target_state_instance_id AS target_activation_id,
              transition.target_run_id,
              activation.graph_run_id AS activation_graph_run_id,
              activation.state_config_value_id AS activation_state_config_value_id,
              activation.state_config_hash AS activation_state_config_hash,
              target_run.workflow_id AS target_run_workflow_id
         FROM workflow_graph_completion_cuts cut
         JOIN workflow_state_transition_history transition
           ON transition.completion_cut_id = cut.id
          AND transition.workflow_id = ?
          AND transition.source_state_instance_id = ?
          AND transition.source_run_id = ?
         JOIN workflow_state_activations activation
           ON activation.id = transition.target_state_instance_id
          AND activation.workflow_id = transition.workflow_id
          AND activation.entered_via_transition_id = transition.id
         JOIN workflow_graph_runs target_run
           ON target_run.id = transition.target_run_id
          AND target_run.workflow_id = transition.workflow_id
        WHERE cut.close_request_id = ? AND cut.graph_run_id = ?`,
      [
        request.source_workflow_id,
        request.source_activation_id,
        request.source_run_id,
        appliedInvocation.close_request_id,
        request.source_run_id,
      ],
    );
    if (!target) {
      return this.replanReceipt(
        request,
        'applying',
        'target_transition_pending',
        sourceFenceReceipt,
      );
    }
    if (
      target.target_state_key !== 'run' ||
      target.target_activation_id === null ||
      target.target_run_id === null ||
      target.activation_graph_run_id !== target.target_run_id ||
      target.target_run_workflow_id !== request.source_workflow_id ||
      target.activation_state_config_value_id !== evidenceRefs[0] ||
      target.activation_state_config_hash !== evidenceRefs[1]
    ) {
      return this.replanReceipt(request, 'denied', 'target_lineage_mismatch');
    }
    return this.replanReceipt(
      request,
      'applied',
      'target_transition_reconciled',
      sourceFenceReceipt,
      target.target_activation_id,
      target.target_run_id,
    );
  }

  reconcileTemporaryReplan(
    request: WorkspaceTemporaryReplanReconcileRequest,
  ): WorkspaceReplanReceipt {
    assertWorkspaceTemporaryReplanReconcileRequest(request);
    return this.reconcileTemporaryReplanInternal(request);
  }

  applyTemporaryReplan(
    request: WorkspaceTemporaryReplanApplyRequest,
  ): WorkspaceReplanReceipt {
    assertWorkspaceTemporaryReplanApplyRequest(request);
    const preparation = request.preparation;
    const identity: WorkspaceTemporaryReplanReconcileRequest = {
      principal_ref: request.principal_ref,
      source_workflow_id: preparation.source_authority.workflow_id,
      source_activation_id: preparation.source_authority.activation_id,
      source_run_id: preparation.source_authority.run_id,
      replan_creation_key: preparation.replan_creation_key,
      proposal_hash: preparation.proposal_hash,
      confirmation_ref: request.confirmation_ref,
      confirmation_hash: request.confirmation_hash,
    };
    if (
      request.confirmation_ref !== preparation.confirmation_ref ||
      request.confirmation_hash !== preparation.confirmation_hash
    ) {
      return this.replanReceipt(identity, 'denied', 'confirmation_mismatch');
    }
    const prior = this.reconcileTemporaryReplanInternal(identity);
    if (prior.code !== 'replan_not_submitted') {
      if (prior.disposition === 'applying' || prior.disposition === 'applied') {
        return {
          ...prior,
          disposition: 'duplicate',
          code:
            prior.disposition === 'applied'
              ? 'target_transition_duplicate'
              : 'source_fence_duplicate',
        };
      }
      return prior;
    }

    let observed: WorkspaceTemporaryReplanPreparation;
    try {
      observed = this.prepareTemporaryReplan({
        principal_ref: request.principal_ref,
        source_workflow_id: identity.source_workflow_id,
        source_activation_id: identity.source_activation_id,
        source_run_id: identity.source_run_id,
        source_json: preparation.new_source_json,
        idempotency_key: identity.replan_creation_key,
        now_ms: request.now_ms,
      });
    } catch (error) {
      return this.replanReceipt(
        identity,
        'denied',
        error instanceof RuntimeWorkspaceGatewayError
          ? error.code
          : 'prepare_failed',
      );
    }
    if (canonicalJson(observed) !== canonicalJson(preparation)) {
      return this.replanReceipt(identity, 'denied', 'stale_source_authority');
    }
    const sourceConfigValue = this.store.queryOne<{
      inline_canonical_json: string;
      payload_state: string;
    }>(
      `SELECT inline_canonical_json, payload_state FROM workflow_values
        WHERE id = ? AND content_hash = ?`,
      [
        preparation.source_authority.state_config_value_id,
        preparation.source_authority.state_config_hash,
      ],
    );
    if (!sourceConfigValue || sourceConfigValue.payload_state !== 'live') {
      return this.replanReceipt(identity, 'denied', 'stale_source_authority');
    }
    const sourceConfig = JSON.parse(
      sourceConfigValue.inline_canonical_json,
    ) as JsonObject;
    const oldConfirmation = isObject(sourceConfig.temporary_confirmation)
      ? sourceConfig.temporary_confirmation
      : null;
    if (!oldConfirmation) {
      return this.replanReceipt(
        identity,
        'denied',
        'unsupported_by_temporary_workflow',
      );
    }
    const targetConfig: JsonObject = {
      ...sourceConfig,
      temporary_confirmation: {
        ...oldConfirmation,
        format: 'icarus.temporary-workflow-confirmation/1',
        revision_id: `replan:${preparation.replan_creation_key}`,
        source_json: preparation.new_source_json,
        source_hash: preparation.new_source_hash,
        plan_hash: preparation.new_plan_hash,
        confirmation_ref: preparation.confirmation_ref,
        confirmation_hash: preparation.confirmation_hash,
      },
      temporary_replan: {
        format: 'icarus.temporary-replan-target/1',
        source_workflow_id: identity.source_workflow_id,
        source_activation_id: identity.source_activation_id,
        source_run_id: identity.source_run_id,
        source_state_config_hash:
          preparation.source_authority.state_config_hash,
        creation_key: preparation.replan_creation_key,
        proposal_hash: preparation.proposal_hash,
        confirmation_ref: preparation.confirmation_ref,
        confirmation_hash: preparation.confirmation_hash,
      },
    };
    const targetConfigHash = domainSeparatedSha256(
      'icarus:workspace-state-config:1\n',
      targetConfig,
    );
    const targetConfigId = stableRuntimeId(
      'workspace-temporary-replan-state-config',
      {
        source_run_id: identity.source_run_id,
        replan_creation_key: identity.replan_creation_key,
        proposal_hash: identity.proposal_hash,
        confirmation_hash: identity.confirmation_hash,
        content_hash: targetConfigHash,
      },
    );
    const valueSchema = this.runtimeRefFromState(
      sourceConfig.manifest_schema,
      'Temporary Replan state config schema',
    );
    this.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: targetConfigId,
        content: targetConfig,
        contentHash: targetConfigHash,
        schemaResourceId: valueSchema.rowId,
        schemaResourceHash: valueSchema.hash,
        provenanceRef: `task-workspace-replan:${identity.replan_creation_key}`,
        retentionClass: 'run_recovery',
        ownerWorkflowId: identity.source_workflow_id,
        createdAtMs: request.now_ms,
      });
    });
    const capacity = this.capacityPublication();
    if (!capacity) {
      return this.replanReceipt(
        identity,
        'denied',
        'capacity_authority_unavailable',
      );
    }
    const fenceManifestSchema = this.runtimeRefFromState(
      sourceConfig.fence_manifest_schema,
      'Temporary Replan fence schema',
    );
    const commandIdentity = this.replanCommandIdentity(identity);
    const receipt = submitRuntimeCommand(this.store, {
      command: {
        command_id: commandIdentity.commandId,
        command_type: 'cancel_run',
        target: { run_id: identity.source_run_id },
        idempotency_key: commandIdentity.idempotencyKey,
        expected_row_version: preparation.source_authority.run_row_version,
        reason_code: 'superseded',
        evidence_refs: [targetConfigId, targetConfigHash],
      },
      actor: {
        authenticated: true,
        actorRef: request.principal_ref,
        actorKind: 'human',
        authSessionRef: `task-workspace-replan:${identity.confirmation_ref}`,
        entrypoint: 'task_workspace',
        sourceFeatureId: null,
        delegationChainRef: null,
        permissions: new Set<RuntimePermissionCode>(['workflow.cancel.own']),
        featurePermissionCeiling: null,
      },
      auditSchema: valueSchema,
      fenceManifestSchema,
      capacityWatcher: { current: () => capacity },
      nowMs: request.now_ms,
    });
    if (
      receipt.executionResult !== 'applied' &&
      receipt.executionResult !== 'duplicate'
    ) {
      return this.replanReceipt(
        identity,
        'denied',
        receipt.denialCode ?? `runtime_command_${receipt.executionResult}`,
        {
          format: 'icarus.workspace-temporary-replan-source-fence/1',
          command_id: receipt.commandId,
          invocation_id: receipt.invocationId,
          execution_result: receipt.executionResult,
          close_request_id: null,
          canonical_result: receipt.canonicalResult,
        },
      );
    }
    this.options.on_runtime_commit?.({
      workflow_id: identity.source_workflow_id,
      run_id: identity.source_run_id,
    });
    const reconciled = this.reconcileTemporaryReplanInternal(identity);
    if (receipt.executionResult === 'duplicate') {
      return {
        ...reconciled,
        disposition: 'duplicate',
        code:
          reconciled.target_run_id === null
            ? 'source_fence_duplicate'
            : 'target_transition_duplicate',
      };
    }
    return reconciled;
  }
}
