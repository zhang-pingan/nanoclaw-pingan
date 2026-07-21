import type {
  CompilerConformanceDiagnosticV1,
  WorkflowCompilerConformanceCaseResultV1,
} from './compiler-contract-repair-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export type CurrentG2GoldenOutcome = 'compiled' | 'rejected';

export interface CurrentG2GoldenContentIdentity extends JsonObject {
  path: string;
  media_type: 'application/json';
  canonicalization: 'rfc8785_jcs';
  raw_bytes_hash: Sha256Hash;
  semantic_hash: Sha256Hash;
  domain_separator: string;
}

export interface CurrentG2GoldenOptionalContentIdentity extends JsonObject {
  path: string | null;
  media_type: 'application/json' | null;
  canonicalization: 'rfc8785_jcs' | null;
  raw_bytes_hash: Sha256Hash | null;
  semantic_hash: Sha256Hash | null;
  domain_separator: string | null;
}

export interface CurrentG2GoldenSourceBinding extends JsonObject {
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  raw_source_file_hash: Sha256Hash;
  input_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
  input_snapshot_file_hash: Sha256Hash;
  effective_case_input_hash: Sha256Hash;
}

export interface CurrentG2GoldenCase extends JsonObject {
  case_id: string;
  polarity: 'positive' | 'negative';
  source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  coverage_tags: JsonValue[];
  source_binding: CurrentG2GoldenSourceBinding;
  outcome: CurrentG2GoldenOutcome;
  expected_result: CurrentG2GoldenContentIdentity;
  expected_plan: CurrentG2GoldenOptionalContentIdentity;
  expected_proofs: CurrentG2GoldenOptionalContentIdentity;
  expected_programs: CurrentG2GoldenOptionalContentIdentity;
  expected_plan_hash: Sha256Hash | null;
  expected_proof_hashes: Sha256Hash[];
  expected_program_hashes: Sha256Hash[];
  expected_diagnostics: CompilerConformanceDiagnosticV1[];
  semantic_assertions: JsonObject[];
  authored_from: 'current_spec_machine_contract_source_snapshot';
  human_judgment: null;
}

export interface CurrentG2GoldenCaseCatalogPayload extends JsonObject {
  format: 'icarus.workflow-compiler-current-g2-golden-draft-cases/1';
  construction_phase: 'RC_REVIEW';
  draft_status: 'frozen_pending_human_approval';
  publishable: false;
  production_reachable: false;
  review_candidate_ref: string;
  review_candidate_hash: Sha256Hash;
  source_set_hash: Sha256Hash;
  bound_working_roots: JsonObject;
  case_count: 40;
  compiled_count: 11;
  rejected_count: 29;
  expected_result_coverage: 40;
  human_judgment_coverage: 0;
  cases: CurrentG2GoldenCase[];
  cases_hash: Sha256Hash;
}

export interface CurrentG2GoldenInventoryEntry extends JsonObject {
  path: string;
  kind:
    | 'schema'
    | 'case_catalog'
    | 'expected_result'
    | 'expected_plan'
    | 'expected_proofs'
    | 'expected_programs';
  case_id: string | null;
  raw_bytes_hash: Sha256Hash;
  semantic_hash: Sha256Hash;
  domain_separator: string;
}

export interface CurrentG2GoldenInventoryPayload extends JsonObject {
  format: 'icarus.workflow-compiler-current-g2-golden-draft-inventory/1';
  construction_phase: 'RC_REVIEW';
  inventory_scope: 'all_draft_leaf_artifacts_excluding_manifest';
  entry_count: number;
  entries: CurrentG2GoldenInventoryEntry[];
  inventory_hash: Sha256Hash;
}

export interface CurrentG2GoldenExactIdentity extends JsonObject {
  compiler_toolchain_manifest_ref: VersionedRef;
  compiler_toolchain_hash: Sha256Hash;
  compiler_version: string;
  compiler_build_hash: Sha256Hash;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: Sha256Hash;
  proof_algorithm_version: string;
  proof_algorithm_hash: Sha256Hash;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
}

export interface CurrentG2GoldenDraftManifestPayload extends JsonObject {
  format: 'icarus.workflow-compiler-current-g2-golden-draft-manifest/1';
  gate: 'G2';
  construction_phase: 'RC_REVIEW';
  draft_status: 'frozen_pending_human_approval';
  publishable: false;
  production_reachable: false;
  review_candidate_ref: string;
  review_candidate_hash: Sha256Hash;
  source_set_hash: Sha256Hash;
  bound_working_roots: JsonObject;
  semantic_correction_contract_ref: string;
  semantic_correction_contract_hash: Sha256Hash;
  semantic_correction_input_manifest_ref: string;
  semantic_correction_input_manifest_hash: Sha256Hash;
  source_case_catalog_ref: string;
  source_case_catalog_hash: Sha256Hash;
  case_input_binding_ref: string;
  case_input_binding_hash: Sha256Hash;
  toolchain_file_ref: string;
  toolchain_file_hash: Sha256Hash;
  authoring_generator_ref: string;
  authoring_generator_hash: Sha256Hash;
  exact_compiler_identity: CurrentG2GoldenExactIdentity;
  cases_ref: string;
  cases_hash: Sha256Hash;
  inventory_ref: string;
  inventory_hash: Sha256Hash;
  case_count: 40;
  compiled_count: 11;
  rejected_count: 29;
  expected_result_coverage: 40;
  expected_plan_coverage: 11;
  expected_proof_bytes_coverage: 11;
  expected_program_bytes_coverage: 11;
  human_review: {
    status: 'not_requested';
    reviewer_actor_ref: 'human:local-owner';
    judgment_coverage: 0;
    judgment_record_ref: null;
    judgment_record_hash: null;
  };
  approval: { status: 'absent'; ref: null; hash: null };
  signature: { status: 'absent'; ref: null; hash: null };
  seal: {
    status: 'absent';
    ref: null;
    hash: null;
    sealed_artifact_count: 0;
    conformance_sealed_write_status: 'not_run';
  };
  golden_semantic_review_status: 'not_run';
  golden_review_report_status: 'generated_after_draft_freeze';
  g3_through_g9_status: 'not_started';
  draft_manifest_hash: Sha256Hash;
}

export interface CurrentG2GoldenDraftBuild {
  files: Map<string, string>;
  manifest: ContractArtifactEnvelope;
  expectedResults: Map<string, WorkflowCompilerConformanceCaseResultV1>;
}

export interface CurrentG2GoldenReviewDifference extends JsonObject {
  pointer: string;
  kind: 'missing_expected' | 'missing_actual' | 'value_mismatch';
  expected: JsonValue | null;
  actual: JsonValue | null;
}

export interface CurrentG2GoldenReviewCase extends JsonObject {
  case_id: string;
  source_ref: string;
  snapshot_ref: string;
  expected_result_ref: string;
  expected_result_hash: Sha256Hash;
  actual_result_ref: string;
  actual_result_hash: Sha256Hash;
  outcome: CurrentG2GoldenOutcome;
  byte_equal: boolean;
  semantic_equal: boolean;
  normalized_plan: JsonObject | null;
  diagnostic_pointers: string[];
  semantic_assertion_count: number;
  semantic_assertion_failures: JsonObject[];
  difference_count: number;
  differences: CurrentG2GoldenReviewDifference[];
}

export interface CurrentG2GoldenReviewPayload extends JsonObject {
  format: 'icarus.workflow-compiler-current-g2-golden-review-report/1';
  construction_phase: 'RC_REVIEW';
  report_kind: 'read_only_draft_candidate_comparison';
  publishable: false;
  production_reachable: false;
  draft_manifest_ref: string;
  draft_manifest_hash: Sha256Hash;
  review_candidate_ref: string;
  review_candidate_hash: Sha256Hash;
  candidate_root_ref: string;
  candidate_root_hash: Sha256Hash;
  actual_results_manifest_ref: string;
  actual_results_manifest_hash: Sha256Hash;
  actual_comparison_role: 'actual_compiler_output_not_golden_oracle';
  case_count: 40;
  compiled_count: 11;
  rejected_count: 29;
  expected_coverage: 40;
  comparison_coverage: 40;
  byte_equal_count: number;
  semantic_equal_count: number;
  semantic_assertion_count: number;
  semantic_assertion_failure_count: number;
  difference_count: number;
  cases: CurrentG2GoldenReviewCase[];
  human_review: {
    status: 'not_requested';
    reviewer_actor_ref: 'human:local-owner';
    judgment_coverage: 0;
  };
  approval_status: 'absent';
  signature_status: 'absent';
  seal_status: 'absent';
  golden_semantic_review_status: 'not_run';
  g3_through_g9_status: 'not_started';
  report_hash: Sha256Hash;
}
