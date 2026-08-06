import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export const G32A_FEATURE_MANIFEST_FORMAT =
  'icarus.feature-manifest/2' as const;
export const G32A_SOURCE_MANIFEST_HASH_DOMAIN =
  'icarus:feature-manifest-source:2\n' as const;
export const G32A_ROOT_IDENTITY_DOMAIN =
  'icarus:feature-source-root-identity:1\n' as const;
export const G32A_PATH_IDENTITY_DOMAIN =
  'icarus:feature-source-path-identity:1\n' as const;

export const G32A_FEATURE_MANIFEST_PROFILE_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-profile/1' as const;
export const G32A_FEATURE_MANIFEST_RESULT_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-result/1' as const;
export const G32A_FEATURE_MANIFEST_PROFILE_SCHEMA_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-profile-schema/1' as const;
export const G32A_FEATURE_MANIFEST_RESULT_SCHEMA_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-result-schema/1' as const;

export const G32A_ERROR_CODES = [
  'feature_manifest_intake_ok',
  'feature_manifest_json_syntax_invalid',
  'feature_manifest_json_duplicate_key',
  'feature_manifest_json_unsafe_integer',
  'feature_manifest_json_invalid_unicode',
  'feature_manifest_json_non_finite_number',
  'feature_manifest_removed_resource_key',
  'feature_manifest_unknown_field',
  'feature_manifest_schema_invalid',
  'feature_manifest_hash_mismatch',
  'feature_manifest_ownership_invalid',
  'feature_manifest_dependency_identity_duplicate',
  'feature_manifest_dependency_order_invalid',
  'feature_manifest_required_resource_identity_duplicate',
  'feature_manifest_required_resource_order_invalid',
  'feature_manifest_dynamic_resource_identity_duplicate',
  'feature_manifest_dynamic_resource_order_invalid',
  'feature_manifest_path_invalid',
  'feature_manifest_source_root_moved',
  'feature_manifest_source_root_symlink',
  'feature_manifest_source_path_symlink',
  'feature_manifest_source_hard_link',
  'feature_manifest_source_path_drift',
  'feature_manifest_source_hash_mismatch',
  'feature_manifest_dependency_unresolved',
] as const;
export type G32AErrorCode = (typeof G32A_ERROR_CODES)[number];

export const G32A_PHASES = [
  'strict_bytes_parse',
  'removed_unknown_structural_intake',
  'full_closed_schema',
  'manifest_hash',
  'ownership_order_path_lexical_validation',
  'root_snapshot_path_read',
  'source_hash',
  'dependency_resolution',
] as const;
export type G32APhase = (typeof G32A_PHASES)[number];

export const G32A_REMOVED_RESOURCE_KEYS = [
  'workflowDefinitions',
  'cards',
  'artifactContracts',
  'workflowEvaluators',
] as const;

export const G32A_DYNAMIC_RESOURCE_KINDS = [
  'recipe',
  'routing_scope',
  'routing_capability',
  'clarification_contract',
  'execution_policy',
  'definition',
  'command_policy',
  'operational_remediation_policy',
  'context_contract',
  'schema',
  'scope_interface',
  'graph_template',
  'graph_policy',
  'capability',
  'executor_implementation',
  'prompt',
  'tool_binding',
  'wait_contract',
  'notification_contract',
  'card_presentation',
  'artifact_contract',
  'evaluator',
  'root_finalization_policy',
  'outbox_policy',
] as const;

export type G32AFeatureManifest = JsonObject & {
  format: typeof G32A_FEATURE_MANIFEST_FORMAT;
  feature_ref: VersionedRef;
  namespace: string;
  owner_principal_ref: string;
  dependencies: G32ADependency[];
  package_resources: JsonObject;
  extension_surfaces: JsonObject;
  dynamic_workflow_resources: G32AResourceEntry[];
  ownership: G32AOwnership;
  lifecycle: JsonObject;
  manifest_hash: Sha256Hash;
};

export interface G32ADependency extends JsonObject {
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  required_resource_refs: VersionedRef[];
}

export interface G32AResourceEntry extends JsonObject {
  kind: (typeof G32A_DYNAMIC_RESOURCE_KINDS)[number];
  ref: VersionedRef;
  source_path: string;
  expected_source_hash: Sha256Hash;
}

export interface G32AOwnership extends JsonObject {
  feature_source_root: string;
  workflow_source_root: string;
  execution_bundle_owner: 'feature_release';
  registry_namespace: string;
}

export interface G32AFileIdentity extends JsonObject {
  device: string;
  inode: string;
}

export interface G32ASnapshotEntry extends JsonObject {
  source_path: string;
  identity: G32AFileIdentity;
  kind: 'regular_file';
  symlink: boolean;
  content_hash: Sha256Hash;
}

export interface G32ARootSnapshot extends JsonObject {
  canonical_root_path: string;
  root_identity_before: Sha256Hash;
  root_identity_after: Sha256Hash;
  kind: 'directory';
  symlink: boolean;
  entries: G32ASnapshotEntry[];
}

export interface G32AIntakeObservations extends JsonObject {
  root_snapshot: G32ARootSnapshot | null;
  dependency_resolution: 'not_attempted' | 'resolved' | 'unresolved';
}

export interface G32ADiagnostic extends JsonObject {
  code: G32AErrorCode;
  phase: G32APhase;
  pointer: string;
  detail: string;
}

export interface G32AIntakeResult extends JsonObject {
  format: typeof G32A_FEATURE_MANIFEST_RESULT_FORMAT;
  outcome: 'accepted' | 'rejected';
  code: G32AErrorCode;
  phase: G32APhase;
  diagnostics: G32ADiagnostic[];
  feature_id: string | null;
  manifest_hash: Sha256Hash | null;
  reader_invoked: false;
  resolver_invoked: false;
  root_snapshot_status: 'not_invoked' | 'supplied_snapshot_verified';
  source_hash_status: 'not_invoked' | 'verified';
  dependency_resolution_status: 'not_attempted' | 'resolved';
}

export interface G32AFixtureCase extends JsonObject {
  case_id: string;
  input_text: string;
  observations: G32AIntakeObservations;
  expected: G32AIntakeResult;
}

export interface G32AProfilePayload extends JsonObject {
  format: typeof G32A_FEATURE_MANIFEST_PROFILE_FORMAT;
  source_manifest_format: typeof G32A_FEATURE_MANIFEST_FORMAT;
  source_manifest_schema_hash: Sha256Hash;
  source_manifest_hash_domain: typeof G32A_SOURCE_MANIFEST_HASH_DOMAIN;
  feature_id_derivation: string;
  ownership_predicate: string;
  source_root_contract: string;
  snapshot_contract: string;
  ordering_contract: string;
  error_precedence: string[];
  reader_activation_phase: 'root_snapshot_path_read';
  resolver_activation_phase: 'dependency_resolution';
  manifest_hash_excludes: ['manifest_hash'];
  arrays_preserve_business_order: true;
}
