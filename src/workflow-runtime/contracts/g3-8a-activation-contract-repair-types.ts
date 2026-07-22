import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const G38A_FORMATS = {
  repair: 'icarus.workflow-feature-release-activation-contract-repair/1',
  scenario: 'icarus.workflow-feature-release-activation-repair-scenario/1',
  scenarioResult:
    'icarus.workflow-feature-release-activation-repair-scenario-result/1',
} as const;

export const G38A_STATUS = 'SCHEMA_REPAIR_REQUIRED' as const;

export const G38A_TERMINAL_DISPOSITIONS = [
  'applied',
  'failed',
  'conflict',
] as const;
export type G38ATerminalDisposition =
  (typeof G38A_TERMINAL_DISPOSITIONS)[number];

export const G38A_INVOCATION_DISPOSITIONS = [
  'applied',
  'duplicate',
  'failed',
  'conflict',
] as const;
export type G38AInvocationDisposition =
  (typeof G38A_INVOCATION_DISPOSITIONS)[number];

export const G38A_EVENT_TYPES = [
  'attempt_started',
  'phase_succeeded',
  'pre_transaction_failed',
  'activation_transaction_started',
  'activation_committed',
  'domain_request_conflicted',
  'pointer_cas_conflicted',
  'terminal_result_committed',
  'terminal_replayed',
  'recovery_started',
  'recovery_succeeded',
  'recovery_failed',
  'integrity_failed',
] as const;
export type G38AEventType = (typeof G38A_EVENT_TYPES)[number];

export const G38A_ERROR_PRECEDENCE = [
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
  'g3_6_preflight_rejected',
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
export type G38AErrorCode = (typeof G38A_ERROR_PRECEDENCE)[number];

export type G38AExistingCommandState =
  | 'absent'
  | 'pending_clean'
  | 'terminal_applied'
  | 'terminal_failed'
  | 'terminal_pointer_conflict';

export type G38AIntegrityState =
  | 'trusted'
  | 'tampered_command_result_binding'
  | 'tampered_receipt'
  | 'tampered_invocation_chain'
  | 'tampered_event_chain'
  | 'pending_with_transition_evidence';

export interface G38AActivationScenario extends JsonObject {
  format: typeof G38A_FORMATS.scenario;
  case_id: string;
  invocation_kind: 'submit' | 'recovery';
  existing_command_state: G38AExistingCommandState;
  submitted_domain_request: 'exact' | 'drift';
  requested_pointer_state: 'absent' | 'present';
  preflight_outcome: 'accepted' | 'failed' | 'not_run';
  pointer_cas_outcome: 'matched' | 'conflict' | 'not_run';
  integrity_state: G38AIntegrityState;
  fault_point: 'none' | 'before_commit' | 'after_commit_before_response';
}

export interface G38AScenarioResult extends JsonObject {
  format: typeof G38A_FORMATS.scenarioResult;
  outcome: 'committed' | 'rolled_back' | 'fail_closed';
  code: string;
  invocation_disposition: G38AInvocationDisposition | null;
  canonical_terminal_disposition: G38ATerminalDisposition | null;
  canonical_result_action: 'written' | 'referenced' | 'none';
  receipt: 'original_transition_receipt' | null;
  command_state_after: G38AExistingCommandState;
  pointer_transition_count: 0 | 1;
  invocation_append_count: 0 | 1;
  events: string[];
  preflight_reexecuted: boolean;
  terminal_fact_trusted: boolean;
}

export interface G38AScenarioFixture extends JsonObject {
  case_id: string;
  scenario: G38AActivationScenario;
  expected: G38AScenarioResult;
}

export interface G38ANegativeMutation extends JsonObject {
  case_id: string;
  target: 'repair' | 'scenario';
  operation: 'add' | 'remove' | 'replace' | 'rehash_replace';
  pointer: string;
  value: JsonValue;
  expected_code:
    | 'repair_removed_field'
    | 'repair_unknown_field'
    | 'repair_schema_invalid'
    | 'repair_hash_mismatch'
    | 'repair_semantic_mismatch'
    | 'scenario_schema_invalid';
}

export interface G38ARejectionFixture extends JsonObject {
  case_id: string;
  precedence_rank: number;
  outer_code: G38AErrorCode;
  nested_g3_6_code: string | null;
  phase:
    | 'admission'
    | 'idempotency'
    | 'integrity'
    | 'preflight'
    | 'activation_transaction'
    | 'persistence';
  classification: 'pre_admission' | 'failed' | 'conflict' | 'fail_closed';
  command_effect:
    | 'absent'
    | 'header_unchanged'
    | 'terminal_failed'
    | 'terminal_conflict'
    | 'transaction_rolled_back';
  receipt: null;
  pointer_transition_count: 0;
  invocation_append_count: 0 | 1;
  verified_fact_prefix: string[];
}

export interface G38ARepairPayload extends JsonObject {
  format: typeof G38A_FORMATS.repair;
  contract_version: 1;
  status: typeof G38A_STATUS;
  production_reachable: false;
  owns_schema_implementation: false;
  owns_activation_implementation: false;
  current_database_schema_version: 3;
  required_database_schema_version: 4;
  current_schema_identity: JsonObject;
  preserved_boundaries: string[];
  receipt_policy: JsonObject;
  terminal_semantics: JsonObject[];
  caller_claims_and_verified_facts: JsonObject;
  command_terminal_identity: JsonObject;
  constraint_timing: JsonObject;
  schema4_prerequisite: JsonObject;
  migration_boundary: JsonObject;
  recovery_algorithm: JsonObject[];
  error_precedence: string[];
  g3_6_nested_error_precedence: string[];
  fixture_coverage: JsonObject;
  forbidden_solutions: string[];
  implementation_handoff: JsonObject;
  contract_hash: Sha256Hash;
}
