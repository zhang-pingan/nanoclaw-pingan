import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import type { G3RegistryResourceIdentity } from './g3-registry-persistence-types.js';

export const G3_RETENTION_EXECUTOR_ABI_FORMATS = {
  input: 'icarus.workflow-retention-executor-abi-preflight/1',
  result: 'icarus.workflow-retention-executor-abi-preflight-result/1',
  profile: 'icarus.workflow-retention-executor-abi-preflight-profile/1',
} as const;

export const G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE = [
  'preflight_input_invalid',
  'preflight_side_effect_requested',
  'snapshot_missing',
  'snapshot_hash_mismatch',
  'snapshot_binding_mismatch',
  'closure_root_missing',
  'closure_root_hash_mismatch',
  'closure_mismatch',
  'execution_artifact_missing',
  'execution_artifact_hash_mismatch',
  'execution_artifact_mismatch',
  'executor_implementation_missing',
  'executor_implementation_hash_mismatch',
  'executor_implementation_mismatch',
  'artifact_binding_mismatch',
  'core_compatibility_mismatch',
  'run_protocol_mismatch',
  'executor_abi_mismatch',
  'retention_policy_mismatch',
  'retention_eligibility_mismatch',
] as const;

export type G3RetentionExecutorAbiErrorCode =
  (typeof G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE)[number];

export interface G3RetentionExecutorAbiClosure extends JsonObject {
  ref: VersionedRef;
  closure_hash: Sha256Hash;
  root: G3RegistryExactResourceQueryInput;
  members: G3RegistryResourceIdentity[];
  member_count: number;
}

export interface G3CoreCompatibilitySnapshot extends JsonObject {
  ref: VersionedRef;
  core_release_ref: VersionedRef;
  core_release_hash: Sha256Hash;
  core_build_hash: Sha256Hash;
  supported_run_protocol_majors: number[];
  supported_executor_abi_majors: number[];
  registry_schema_version: 1;
  database_schema_version: 2;
  database_schema_hash: Sha256Hash;
  compatibility_hash: Sha256Hash;
}

export interface G3ProtocolBinding extends JsonObject {
  ref: VersionedRef;
  hash: Sha256Hash;
  major: number;
}

export interface G3FeatureReleaseExecutionArtifactBinding extends JsonObject {
  ref: VersionedRef;
  hash: Sha256Hash;
}

export interface G3RetentionEligibilityInput extends JsonObject {
  policy_ref: VersionedRef;
  policy_hash: Sha256Hash;
  handle_kind: 'published';
  root_kind: 'feature_release';
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  members: G3RegistryResourceIdentity[];
}

export interface G3RetentionExecutorAbiPreflightInput extends JsonObject {
  format: typeof G3_RETENTION_EXECUTOR_ABI_FORMATS.input;
  operation: 'validate_only';
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  feature_release_execution_artifact: G3FeatureReleaseExecutionArtifactBinding | null;
  snapshot: {
    snapshot_ref: VersionedRef;
    snapshot_hash: Sha256Hash;
    expected_compiler_version: string;
    expected_core_build_hash: Sha256Hash;
    expected_database_schema_hash: Sha256Hash;
  };
  closure: G3RetentionExecutorAbiClosure;
  execution_artifacts: G3RegistryExactResourceQueryInput[];
  executor_implementations: G3RegistryExactResourceQueryInput[];
  core_compatibility: G3CoreCompatibilitySnapshot;
  run_protocol: G3ProtocolBinding;
  executor_abi: G3ProtocolBinding;
  retention: G3RetentionEligibilityInput;
  requested_retention_handle_write: boolean;
  requested_gc: boolean;
  requested_delete: boolean;
  requested_publication_state_update: boolean;
}

export interface G3RetentionExecutorAbiVerifiedBindings extends JsonObject {
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  snapshot_ref: VersionedRef;
  snapshot_hash: Sha256Hash;
  closure_ref: VersionedRef;
  closure_hash: Sha256Hash;
  closure_member_count: number;
  execution_artifact_count: number;
  executor_implementation_count: number;
  core_compatibility_ref: VersionedRef;
  core_compatibility_hash: Sha256Hash;
  core_release_ref: VersionedRef;
  core_release_hash: Sha256Hash;
  core_build_hash: Sha256Hash;
  database_schema_version: 2;
  database_schema_hash: Sha256Hash;
  run_protocol_ref: VersionedRef;
  run_protocol_hash: Sha256Hash;
  run_protocol_major: 1;
  executor_abi_ref: VersionedRef;
  executor_abi_hash: Sha256Hash;
  executor_abi_major: 1;
  retention_policy_ref: VersionedRef;
  retention_policy_hash: Sha256Hash;
  retention_root_eligible: true;
}

export type G3RetentionExecutorAbiPreflightResult =
  | {
      format: typeof G3_RETENTION_EXECUTOR_ABI_FORMATS.result;
      outcome: 'accepted';
      code: 'preflight_ok';
      bindings: G3RetentionExecutorAbiVerifiedBindings;
      read_only: true;
    }
  | {
      format: typeof G3_RETENTION_EXECUTOR_ABI_FORMATS.result;
      outcome: 'rejected';
      code: G3RetentionExecutorAbiErrorCode;
      bindings: null;
      read_only: true;
    };

export interface G3RetentionExecutorAbiPreflightProfile extends JsonObject {
  format: typeof G3_RETENTION_EXECUTOR_ABI_FORMATS.profile;
  ref: VersionedRef;
  resolution_mode: 'immutable_exact_only';
  registry_snapshot_verifier: 'g3_3_snapshot_closure_preflight';
  registry_resource_verifier: 'g3_5_exact_resource_query';
  compatibility_rules: {
    run_protocol_major: 1;
    executor_abi_major: 1;
    registry_schema_version: 1;
    database_schema_version: 2;
  };
  retention_policy_ref: VersionedRef;
  retention_policy_hash: Sha256Hash;
  run_protocol_ref: VersionedRef;
  run_protocol_hash: Sha256Hash;
  executor_abi_ref: VersionedRef;
  executor_abi_hash: Sha256Hash;
  retention_handle_kind: 'published';
  retention_root_kind: 'feature_release';
  error_precedence: G3RetentionExecutorAbiErrorCode[];
  result_schema: 'closed';
  deterministic: true;
  read_only: true;
}
