import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export type CurrentG2GoldenDecision = 'approved' | 'changes_requested';

export interface CurrentG2GoldenSemanticReviewPayload extends JsonObject {
  format: 'icarus.workflow-compiler-golden-semantic-review/1';
  gate: 'G2';
  construction_phase: 'RC_REVIEW';
  review_id: string;
  bundle_version: '1.0.0';
  case_ids: string[];
  case_count: 40;
  draft_manifest_ref: string;
  draft_manifest_hash: Sha256Hash;
  draft_artifact_hash: Sha256Hash;
  golden_review_report_ref: string;
  golden_review_report_hash: Sha256Hash;
  golden_review_report_artifact_hash: Sha256Hash;
  reviewer_actor_ref: 'human:local-owner';
  decision: CurrentG2GoldenDecision;
  checklist_version: 'current-g2-golden-semantic-review/1';
  checklist: string[];
  comparison_acknowledgement: JsonObject;
  authorization_scope: JsonObject;
  signature_policy: 'not_required_local_single_user';
  notes_ref: null;
  notes_hash: null;
  reviewed_at_ms: number;
  review_hash: Sha256Hash;
}

export interface CurrentG2SealedContentIdentity extends JsonObject {
  path: string;
  original_ref: string;
  media_type: 'application/json';
  canonicalization: 'rfc8785_jcs';
  raw_bytes_hash: Sha256Hash;
  semantic_hash: Sha256Hash;
  domain_separator: string;
}

export interface CurrentG2SealedCase extends JsonObject {
  case_id: string;
  source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  outcome: 'compiled' | 'rejected';
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  raw_source_file_hash: Sha256Hash;
  registry_snapshot_ref: string;
  interface_policy_safety_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
  input_snapshot_file_hash: Sha256Hash;
  effective_case_input_hash: Sha256Hash;
  expected_source_hash: Sha256Hash;
  expected_result: CurrentG2SealedContentIdentity;
  expected_plan: CurrentG2SealedContentIdentity | null;
  expected_proofs: CurrentG2SealedContentIdentity | null;
  expected_programs: CurrentG2SealedContentIdentity | null;
  expected_plan_bytes_ref: string | null;
  expected_plan_hash: Sha256Hash | null;
  expected_proof_program_hashes: Sha256Hash[];
  expected_diagnostics: JsonObject[];
  approved_review_ref: string;
  approved_review_hash: Sha256Hash;
}

export interface CurrentG2SealedInventoryEntry extends JsonObject {
  path: string;
  kind:
    | 'schema'
    | 'raw_source'
    | 'input_snapshot'
    | 'expected_result'
    | 'expected_plan'
    | 'expected_proofs'
    | 'expected_programs';
  case_id: string | null;
  original_ref: string | null;
  raw_bytes_hash: Sha256Hash;
  semantic_hash: Sha256Hash;
  domain_separator: string;
}

export interface CurrentG2SealedInventoryPayload extends JsonObject {
  format: 'icarus.workflow-compiler-conformance-inventory/1';
  gate: 'G2';
  bundle_version: '1.0.0';
  inventory_scope: 'all_sealed_leaf_artifacts_excluding_inventory_and_bundle';
  entry_count: number;
  entries: CurrentG2SealedInventoryEntry[];
  inventory_hash: Sha256Hash;
}

export interface CurrentG2GoldenConformanceBundlePayload extends JsonObject {
  format: 'icarus.workflow-compiler-conformance/1';
  gate: 'G2';
  construction_phase: 'RC_REVIEW';
  bundle_version: '1.0.0';
  bundle_status: 'sealed_pending_ci_replay';
  publishable: false;
  production_reachable: false;
  toolchain_manifest_ref: VersionedRef;
  toolchain_hash: Sha256Hash;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  exact_compiler_identity: JsonObject;
  draft_manifest_ref: string;
  draft_manifest_hash: Sha256Hash;
  draft_artifact_hash: Sha256Hash;
  golden_review_report_ref: string;
  golden_review_report_hash: Sha256Hash;
  golden_review_report_artifact_hash: Sha256Hash;
  golden_semantic_review_ref: string;
  golden_semantic_review_hash: Sha256Hash;
  golden_semantic_review_artifact_hash: Sha256Hash;
  approval_status: 'approved';
  signature_policy: 'not_required_local_single_user';
  review_assignment: 'exactly_one_approved_review_per_case';
  case_count: 40;
  compiled_count: 11;
  rejected_count: 29;
  expected_result_coverage: 40;
  expected_plan_coverage: 11;
  expected_proof_bytes_coverage: 11;
  expected_program_bytes_coverage: 11;
  sealed_raw_source_coverage: 40;
  sealed_input_snapshot_coverage: 40;
  cases: CurrentG2SealedCase[];
  inventory_ref: string;
  inventory_hash: Sha256Hash;
  sealed_artifact_count: number;
  ci_replay_status: 'not_run_at_seal_time';
  g3_through_g9_status: 'not_started';
  bundle_hash: Sha256Hash;
}

export interface CurrentG2GoldenSealBuild {
  files: Map<string, string>;
  inventory: JsonObject;
  bundle: JsonObject;
}

export interface CurrentG2GoldenReplayResult {
  case_count: 40;
  exact_equal_count: number;
  mismatch_count: number;
  mismatched_case_ids: string[];
  passed: boolean;
  expected_bundle_hash: Sha256Hash;
  actual_candidate_root_hash: Sha256Hash;
  details: JsonValue[];
}
