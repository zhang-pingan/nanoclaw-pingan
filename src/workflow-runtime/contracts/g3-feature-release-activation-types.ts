import type { G3RegistryResourceIdentity } from './g3-registry-persistence-types.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export const G39_FEATURE_RELEASE_ACTIVATION_FORMATS = {
  request: 'icarus.workflow-feature-release-activation-request/1',
  receipt: 'icarus.workflow-feature-release-activation-receipt/1',
  result: 'icarus.workflow-feature-release-activation-result/1',
} as const;

export const G39_ACTIVATION_DISPOSITIONS = [
  'applied',
  'duplicate',
  'conflict',
  'failed',
] as const;
export type G39ActivationDisposition =
  (typeof G39_ACTIVATION_DISPOSITIONS)[number];

export const G39_TERMINAL_DISPOSITIONS = [
  'applied',
  'failed',
  'conflict',
] as const;
export type G39TerminalDisposition = (typeof G39_TERMINAL_DISPOSITIONS)[number];

export const G39_ACTIVATION_ERROR_PRECEDENCE = [
  'activation_request_strict_parse_invalid',
  'activation_request_removed_field',
  'activation_request_unknown_field',
  'activation_request_schema_invalid',
  'activation_request_hash_mismatch',
  'activation_authentication_mismatch',
  'idempotency_conflict',
  'terminal_integrity_mismatch',
  'target_release_missing',
  'target_release_identity_mismatch',
  'target_release_owner_mismatch',
  'target_release_resource_set_mismatch',
  'runtime_abi_incompatible',
  'target_release_lifecycle_invalid',
  'previous_release_missing',
  'previous_release_identity_mismatch',
  'previous_release_owner_mismatch',
  'previous_release_lifecycle_invalid',
  'target_retention_missing',
  'target_retention_identity_mismatch',
  'target_retention_status_mismatch',
  'target_retention_row_version_mismatch',
  'previous_retention_missing',
  'previous_retention_identity_mismatch',
  'previous_retention_status_mismatch',
  'previous_retention_row_version_mismatch',
  'pointer_cas_conflict',
  'activation_persistence_identity_collision',
] as const;
export type G39ActivationErrorCode =
  (typeof G39_ACTIVATION_ERROR_PRECEDENCE)[number];

export interface G39ActivationInvocation extends JsonObject {
  invocation_kind: 'submit' | 'recovery';
  actor_ref: string;
  auth_session_ref: string;
  requested_at_ms: number;
}

export interface G39FeatureReleaseClaim extends JsonObject {
  release_id: string;
  ref: VersionedRef;
  hash: Sha256Hash;
  expected_lifecycle: 'staged' | 'active';
}

export interface G39FeatureReleaseIdentity extends JsonObject {
  release_id: string;
  ref: VersionedRef;
  hash: Sha256Hash;
}

export interface G39TargetFeatureReleaseClaim extends G39FeatureReleaseClaim {
  expected_lifecycle: 'staged';
  resources: Array<
    G3RegistryResourceIdentity & {
      role: 'closure_root' | 'closure_member';
    }
  >;
}

export interface G39RetentionClaim extends JsonObject {
  handle_id: string;
  handle_kind: 'published';
  feature_release_id: string;
  closure_ref: VersionedRef;
  closure_hash: Sha256Hash;
  expected_status: 'held';
  expected_row_version: number;
}

export type G39ExpectedPointer =
  | { state: 'absent'; row_version: null; release: null }
  | {
      state: 'present';
      row_version: number;
      release: G39FeatureReleaseIdentity;
    };

export interface G39ActivationContractSchemas extends JsonObject {
  request: G3RegistryExactResourceQueryInput;
  receipt: G3RegistryExactResourceQueryInput;
  result: G3RegistryExactResourceQueryInput;
}

export interface G39FeatureReleaseActivationRequest extends JsonObject {
  format: typeof G39_FEATURE_RELEASE_ACTIVATION_FORMATS.request;
  command_type: 'activate_feature_release';
  idempotency_domain: string;
  idempotency_key: string;
  actor_ref: string;
  auth_session_ref: string;
  requested_at_ms: number;
  feature_id: string;
  target_release: G39TargetFeatureReleaseClaim;
  previous_release: G39FeatureReleaseClaim | null;
  expected_pointer: G39ExpectedPointer;
  target_retention: G39RetentionClaim;
  previous_retention: G39RetentionClaim | null;
  contract_schemas: G39ActivationContractSchemas;
  domain_request_hash: Sha256Hash;
  request_hash: Sha256Hash;
}

export interface G39AppliedPointerFact extends JsonObject {
  previous_state: 'absent' | 'present';
  previous_row_version: number | null;
  applied_row_version: number;
}

export interface G39FeatureReleaseActivationReceipt extends JsonObject {
  format: typeof G39_FEATURE_RELEASE_ACTIVATION_FORMATS.receipt;
  command_id: string;
  domain_request_hash: Sha256Hash;
  feature_id: string;
  target_release: G39FeatureReleaseIdentity;
  previous_release: G39FeatureReleaseIdentity | null;
  pointer: G39AppliedPointerFact;
  target_lifecycle: 'active';
  previous_lifecycle: 'draining' | null;
  target_retention: G39RetentionClaim;
  previous_retention: G39RetentionClaim | null;
  activated_at_ms: number;
  active_pointer_changed: true;
  receipt_hash: Sha256Hash;
}

export interface G39TerminalResultReference extends JsonObject {
  value_id: string;
  hash: Sha256Hash;
  schema_resource_id: string;
  schema_hash: Sha256Hash;
}

export interface G39ActivationFailure extends JsonObject {
  phase:
    | 'admission'
    | 'idempotency'
    | 'integrity'
    | 'preflight'
    | 'activation_transaction'
    | 'persistence';
  code: G39ActivationErrorCode;
}

export type G39ObservedPointer =
  | { state: 'absent'; row_version: null; release: null }
  | {
      state: 'present';
      row_version: number;
      release: G39FeatureReleaseIdentity;
    };

export interface G39FeatureReleaseActivationResult extends JsonObject {
  format: typeof G39_FEATURE_RELEASE_ACTIVATION_FORMATS.result;
  disposition: G39ActivationDisposition;
  code:
    | 'feature_release_activation_applied'
    | 'feature_release_activation_duplicate'
    | G39ActivationErrorCode;
  command_id: string;
  invocation_no: number;
  submitted_domain_request_hash: Sha256Hash;
  bound_domain_request_hash: Sha256Hash;
  terminal_disposition: G39TerminalDisposition | null;
  referenced_terminal_result: G39TerminalResultReference | null;
  receipt: G39FeatureReleaseActivationReceipt | null;
  expected_pointer: G39ExpectedPointer;
  observed_pointer: G39ObservedPointer | null;
  failure: G39ActivationFailure | null;
  result_hash: Sha256Hash;
}

export interface G39ActivationContractCase extends JsonObject {
  case_id: string;
  invocation_kind: 'submit' | 'recovery';
  existing_command:
    | 'absent'
    | 'pending_clean'
    | 'terminal_applied'
    | 'terminal_failed'
    | 'terminal_pointer_conflict';
  submitted_domain: 'exact' | 'drift';
  expected_disposition: G39ActivationDisposition;
  expected_receipt: 'original' | null;
  expected_pointer_transition_count: 0 | 1;
}

export interface G39ActivationFaultCase extends JsonObject {
  case_id: string;
  fault_class: 'pre_commit' | 'post_commit_recovery' | 'tamper';
  fault_point: string;
  expected_outcome:
    | 'rollback'
    | 'duplicate_without_pointer_dml'
    | 'fail_closed';
}
