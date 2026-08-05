import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import type {
  G3RegistryResourceIdentity,
  G3RegistrySnapshotPreflightInput,
} from './g3-registry-persistence-types.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export const G3_RETENTION_EXECUTOR_ABI_FORMATS = {
  input: 'icarus.workflow-retention-executor-abi-preflight/1',
  result: 'icarus.workflow-retention-executor-abi-preflight-result/1',
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
  snapshot: G3RegistrySnapshotPreflightInput;
  closure: G3RetentionExecutorAbiClosure;
  execution_artifacts: G3RegistryExactResourceQueryInput[];
  executor_implementations: G3RegistryExactResourceQueryInput[];
  executor_abi_major: number;
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
  executor_abi_major: number;
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
