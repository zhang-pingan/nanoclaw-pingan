import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalPrimaryKeyMetadata,
  LogicalQueryIntent,
  LogicalUniqueKeyMetadata,
} from './logical-schema-types.js';
import type { DeploymentRuntimeCapacity } from './safety-sqlite-types.js';
import type { JsonObject, Sha256Hash } from './types.js';

export const CAPACITY_CHANGE_REASON_CODES = [
  'initial_provisioning',
  'planned_tuning',
  'incident_mitigation',
  'host_resource_change',
  'storage_pressure',
  'rollback',
] as const;
export type CapacityChangeReasonCode =
  (typeof CAPACITY_CHANGE_REASON_CODES)[number];

export const CAPACITY_ADMIN_DENIAL_CODES = [
  'permission_denied',
  'actor_kind_denied',
  'capacity_already_initialized',
  'capacity_snapshot_invalid',
  'capacity_transition_invalid',
  'expected_capacity_revision_conflict',
  'expected_config_hash_conflict',
  'capacity_change_in_progress',
  'idempotency_conflict',
  'audit_unavailable',
  'publication_failed',
] as const;
export type CapacityAdminDenialCode =
  (typeof CAPACITY_ADMIN_DENIAL_CODES)[number];

export const CAPACITY_ADMIN_COMMAND_TYPES = [
  'initialize_deployment_capacity',
  'replace_deployment_capacity',
] as const;
export type CapacityAdminCommandType =
  (typeof CAPACITY_ADMIN_COMMAND_TYPES)[number];

export const CAPACITY_ADMIN_EXECUTION_RESULTS = [
  'prepared',
  'applied',
  'denied',
  'conflict',
  'duplicate',
  'failed',
] as const;
export type CapacityAdminExecutionResult =
  (typeof CAPACITY_ADMIN_EXECUTION_RESULTS)[number];

export interface CapacityAdminInvocationLifecycleCandidate {
  invocation_no: number;
  submitted_request_matches_command: boolean;
  command_result_state: 'pending' | 'finalized';
  authorization_result: 'allowed' | 'denied';
  execution_result: CapacityAdminExecutionResult;
  denial_code: CapacityAdminDenialCode | null;
  requested_at_ms: number;
  decided_at_ms: number;
  applied_at_ms: number | null;
}

export const CAPACITY_ADMIN_ACTOR_KINDS = [
  'human',
  'feature_service',
  'automation',
  'system',
] as const;
export type CapacityAdminActorKind =
  (typeof CAPACITY_ADMIN_ACTOR_KINDS)[number];

export const CAPACITY_ADMIN_PERMISSION_CODES = [
  'runtime.capacity.manage',
] as const;
export type CapacityAdminPermissionCode =
  (typeof CAPACITY_ADMIN_PERMISSION_CODES)[number];

export const CAPACITY_ADMIN_HUMAN_ENTRYPOINTS = [
  'runtime_center',
  'cli',
  'deployment_tool',
] as const;
export type CapacityAdminHumanEntrypoint =
  (typeof CAPACITY_ADMIN_HUMAN_ENTRYPOINTS)[number];

export type DeploymentRuntimeCapacitySnapshot = Omit<
  DeploymentRuntimeCapacity,
  'config_hash'
> & {
  config_hash: Sha256Hash;
};

export interface DeploymentRuntimeCapacityPublication {
  format: 'icarus.deployment-runtime-capacity-publication/1';
  deployment_profile: 'local_single_user';
  capacity_revision: number;
  capacity_change_id: string;
  previous_config_hash: Sha256Hash | null;
  capacity: DeploymentRuntimeCapacitySnapshot;
  publication_hash: Sha256Hash;
}

export interface InitializeDeploymentCapacityCommand {
  command_type: 'initialize_deployment_capacity';
  command_id: string;
  idempotency_key: string;
  proposed_capacity: DeploymentRuntimeCapacitySnapshot;
  reason_code: 'initial_provisioning';
  core_release_hash: Sha256Hash;
  evidence_refs: string[];
}

export interface ReplaceDeploymentCapacityCommand {
  command_type: 'replace_deployment_capacity';
  command_id: string;
  idempotency_key: string;
  expected_capacity_revision: number;
  expected_config_hash: Sha256Hash;
  proposed_capacity: DeploymentRuntimeCapacitySnapshot;
  reason_code: Exclude<CapacityChangeReasonCode, 'initial_provisioning'>;
  reason_text: string;
  evidence_refs: string[];
}

export type CapacityAdminCommand =
  | InitializeDeploymentCapacityCommand
  | ReplaceDeploymentCapacityCommand;

export interface CapacityPermissionCatalogEntry {
  permission: CapacityAdminPermissionCode;
  scope: 'deployment';
  allowed_actor_kinds: readonly ['human'];
  production_principal: 'human:local-owner';
  allowed_entrypoints: readonly CapacityAdminHumanEntrypoint[];
  delegation: 'forbidden';
  workflow_ownership_derivation: 'forbidden';
  feature_manifest_ceiling_derivation: 'forbidden';
}

export interface CapacityReasonCatalogEntry {
  reason_code: CapacityChangeReasonCode;
  allowed_command_types: readonly CapacityAdminCommandType[];
  reason_text_required: boolean;
  evidence_required: boolean;
  minimum_evidence_refs: number;
}

export interface CapacityDenialCatalogEntry {
  denial_code: CapacityAdminDenialCode;
  retryability:
    | 'never_same_request'
    | 'refresh_head_and_resubmit'
    | 'retry_same_request';
  head_mutation: 'forbidden';
  pending_change_creation: 'forbidden';
  invocation_audit: 'required_after_authentication';
}

export const CAPACITY_PROTOCOL_IDS = [
  'CAP0',
  'CAP1',
  'CAP2',
  'CAP3',
  'CAP4',
] as const;
export type CapacityProtocolId = (typeof CAPACITY_PROTOCOL_IDS)[number];

export interface CapacityProtocolStep {
  protocol_id: CapacityProtocolId;
  name:
    | 'authenticate_validate'
    | 'prepare'
    | 'install_file'
    | 'commit_head'
    | 'watcher_publish';
  transaction_mode: 'none' | 'begin_immediate' | 'short_begin_immediate';
  external_work: 'none' | 'filesystem_durability' | 'immutable_pointer_swap';
  preconditions: string[];
  atomic_writes: string[];
  success_outcome: string;
  failure_outcomes: string[];
  crash_recovery: string[];
  forbidden_actions: string[];
}

export interface CapacityCrashBoundary {
  boundary_id: string;
  protocol_id: CapacityProtocolId;
  injected_after: string;
  committed_head_visibility: 'old' | 'new';
  watcher_visibility: 'old' | 'new';
  recovery_action: string;
}

export interface CapacityProtocolCatalog {
  format: 'icarus.workflow-capacity-control-plane-protocol/1';
  protocol_ids: CapacityProtocolId[];
  steps: CapacityProtocolStep[];
  crash_boundaries: CapacityCrashBoundary[];
  protocol_hash: Sha256Hash;
}

export interface CapacityLogicalTableDelta {
  ordinal: number;
  name:
    | 'runtime_capacity_head'
    | 'runtime_capacity_admin_commands'
    | 'runtime_capacity_admin_invocations'
    | 'runtime_capacity_change_events';
  source_section: 'Capacity management publication and audit';
  columns: LogicalColumnMetadata[];
  primary_key: LogicalPrimaryKeyMetadata;
  foreign_keys: LogicalForeignKeyMetadata[];
  unique_keys: LogicalUniqueKeyMetadata[];
  checks: LogicalCheckMetadata[];
  indexes: LogicalIndexMetadata[];
}

export interface CapacityLogicalExtendedTableDelta {
  name: 'workflow_graph_scheduler_admissions';
  base_table_hash: Sha256Hash;
  added_columns: LogicalColumnMetadata[];
  added_foreign_keys: LogicalForeignKeyMetadata[];
  added_unique_keys: LogicalUniqueKeyMetadata[];
  added_checks: LogicalCheckMetadata[];
  added_indexes: LogicalIndexMetadata[];
}

export interface CapacityLogicalSchemaDelta {
  format: 'icarus.workflow-capacity-control-plane-logical-schema-delta/1';
  schema_id: 'workflow-runtime-schema-v1';
  base_logical_schema_manifest_hash: Sha256Hash;
  delta_mode: 'additive_only';
  contract_stage: 'logical_metadata';
  executable_status: 'non_executable';
  ddl_generation_status: 'forbidden_in_g0_10';
  sqlite_open_status: 'forbidden_in_g0_10';
  added_tables: CapacityLogicalTableDelta[];
  extended_tables: CapacityLogicalExtendedTableDelta[];
  query_intents: LogicalQueryIntent[];
  invariants: string[];
  delta_hash: Sha256Hash;
}

export const CAPACITY_MARKDOWN_DELTA_CATEGORIES = [
  'semantic_format',
  'command_type',
  'permission',
  'reason_code',
  'denial_code',
  'protocol_id',
  'logical_table',
  'admission_lineage_field',
] as const;
export type CapacityMarkdownDeltaCategory =
  (typeof CAPACITY_MARKDOWN_DELTA_CATEGORIES)[number];

export interface CapacityMarkdownDeltaCoverageEntry {
  coverage_id: string;
  category: CapacityMarkdownDeltaCategory;
  value: string;
  contract_path: string;
  contract_pointer: string;
  markdown_section: string;
  fixture_refs: string[];
  change_impact:
    | 'capacity_contract_version_required'
    | 'capacity_protocol_and_fixture_update_required'
    | 'g1_schema_manifest_and_ddl_update_required';
  entry_hash: Sha256Hash;
}

export interface CapacityMarkdownDeltaCoverage {
  format: 'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1';
  architecture_path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md';
  spec_binding_scope: 'capacity_contract_values_only';
  prior_g0_9_root_hash: Sha256Hash;
  extraction_policy: 'g0_10_delta_only_no_runtime_markdown_extraction';
  categories: CapacityMarkdownDeltaCategory[];
  entries: CapacityMarkdownDeltaCoverageEntry[];
  category_counts: Record<CapacityMarkdownDeltaCategory, number>;
  contract_value_count: number;
  markdown_value_count: number;
  contract_values_without_markdown: string[];
  markdown_values_without_contract: string[];
  coverage_hash: Sha256Hash;
}

export const CAPACITY_INVENTORY_CLASSES = [
  'historical_root',
  'schema',
  'catalog',
  'protocol',
  'logical_schema_delta',
  'coverage',
  'fixture',
] as const;
export type CapacityInventoryClass =
  (typeof CAPACITY_INVENTORY_CLASSES)[number];

export interface CapacityArtifactInventoryEntry {
  artifact_id: string;
  owning_slice: 'G0.9' | 'G0.10';
  artifact_class: CapacityInventoryClass;
  path: string;
  format: string;
  byte_length: number;
  raw_sha256: Sha256Hash;
  semantic_hash: Sha256Hash;
}

export interface CapacityArtifactInventory {
  format: 'icarus.workflow-capacity-control-plane-artifact-inventory/1';
  inventory_scope: 'g0_9_historical_root_and_g0_10_non_recursive_leaf_artifacts';
  closure_policy: 'inventory_gate_domain_and_root_owned_by_g0_10_manifest';
  entries: CapacityArtifactInventoryEntry[];
  entry_count: number;
  class_counts: Record<CapacityInventoryClass, number>;
  duplicate_paths: string[];
  missing_paths: string[];
  inventory_hash: Sha256Hash;
}

export interface CapacityGateReview {
  format: 'icarus.workflow-capacity-control-plane-gate-review/1';
  gate_id: 'G0.10';
  review_kind: 'capacity_control_plane_addendum';
  decision: 'pass';
  prior_g0_9_root_hash: Sha256Hash;
  historical_identity_hashes: Record<string, Sha256Hash>;
  exit_criteria: Array<{
    criterion_id: string;
    status: 'pass';
    evidence_hashes: Sha256Hash[];
  }>;
  markdown_delta_coverage_hash: Sha256Hash;
  artifact_inventory_hash: Sha256Hash;
  status_proof: {
    g0_status: 'DONE';
    i11_status: 'DONE';
    g1_status: 'READY';
    g2_status: 'READY';
    g3_through_g9_status: 'NOT_READY';
    r014_status: 'CLOSED';
    executable_ddl_status: 'absent';
    workflow_runtime_store_status: 'absent';
    capacity_gateway_status: 'absent';
    capacity_publisher_status: 'absent';
    capacity_watcher_status: 'absent';
    scheduler_status: 'absent';
    runtime_center_ui_status: 'absent';
    golden_semantic_review_status: 'absent';
    golden_seal_status: 'not_run';
    sealed_directory_entry: '.gitkeep';
  };
  review_hash: Sha256Hash;
}

export const CAPACITY_FIXTURE_AREAS = [
  'authorization',
  'cas',
  'idempotency',
  'transition',
  'genesis',
  'integrity',
  'publication_recovery',
  'upgrade',
  'admission_lineage',
] as const;
export type CapacityFixtureArea = (typeof CAPACITY_FIXTURE_AREAS)[number];

export interface CapacityConformanceCase {
  case_id: string;
  area: CapacityFixtureArea;
  scenario: string;
  expected_result: string;
  expected_head_effect: 'unchanged' | 'pending_prepared' | 'committed';
  assertion: string;
}

export interface CapacityConformanceCaseArtifact {
  format:
    | 'icarus.workflow-capacity-control-plane-positive-cases/1'
    | 'icarus.workflow-capacity-control-plane-negative-cases/1'
    | 'icarus.workflow-capacity-control-plane-fault-cases/1';
  cases: CapacityConformanceCase[];
  case_count: number;
}

export interface CapacityAdminModelHead {
  capacity_revision: number;
  capacity_change_id: string;
  config_hash: Sha256Hash;
  pending_change_id: string | null;
  row_version: number;
  minimum_free_disk_bytes: number;
}

export interface CapacityAdminModelInvocation {
  authenticated: boolean;
  actor_ref: string;
  actor_kind: CapacityAdminActorKind;
  auth_session_ref: string | null;
  session_actor_ref: string | null;
  permissions: CapacityAdminPermissionCode[];
  entrypoint: string;
  delegation_chain_ref: string | null;
  audit_available: boolean;
  genesis_grant: {
    core_release_hash: Sha256Hash;
    baseline_config_hash: Sha256Hash;
  } | null;
  active_core_release_hash: Sha256Hash;
  baseline_config_hash: Sha256Hash;
  idempotency_record: {
    request_hash: Sha256Hash;
    canonical_result: string;
  } | null;
  submitted_request_hash: Sha256Hash;
}

export type CapacityAdminModelResult =
  | 'authentication_rejected_no_invocation'
  | 'duplicate'
  | 'prepared'
  | CapacityAdminDenialCode;

export interface CapacityAdmissionLineage {
  capacity_revision: number;
  capacity_change_id: string;
  capacity_config_hash: Sha256Hash;
}

export interface CapacityControlPlaneManifestPayload extends JsonObject {
  gate: 'G0.10';
  status: 'capacity_control_plane_addendum';
}
