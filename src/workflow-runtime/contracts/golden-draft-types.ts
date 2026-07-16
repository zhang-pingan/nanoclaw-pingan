import type {
  CompilerDiagnosticPhase,
  WorkflowCompilerErrorCode,
} from './catalog-protocol-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export type GoldenDraftSourceKind =
  | 'graph_scope'
  | 'workflow_definition'
  | 'workflow_schema';

export type GoldenDraftCasePolarity = 'positive' | 'negative';
export type GoldenDraftReviewStatus = 'pending_human_review';

export interface GoldenDraftDiagnostic extends JsonObject {
  code: WorkflowCompilerErrorCode;
  phase: CompilerDiagnosticPhase;
  instance_pointer: string;
  schema_pointer: string | null;
  stable_object_id: string | null;
  detail_ref: string | null;
}

export type GoldenDraftAssertionOperator =
  | 'equals'
  | 'set_equals'
  | 'ordered_equals'
  | 'contains'
  | 'present'
  | 'absent';

export interface GoldenDraftSemanticAssertion extends JsonObject {
  assertion_id: string;
  subject_pointer: string;
  operator: GoldenDraftAssertionOperator;
  expected: JsonValue;
  rationale: string;
}

export interface GoldenDraftCase extends JsonObject {
  case_id: string;
  polarity: GoldenDraftCasePolarity;
  source_kind: GoldenDraftSourceKind;
  coverage_tags: string[];
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  input_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
  expected_source_hash: Sha256Hash | null;
  expected_plan_bytes_ref: null;
  expected_plan_hash: null;
  expected_proof_hashes: null;
  expected_program_hashes: null;
  expected_diagnostics: GoldenDraftDiagnostic[];
  normalized_semantic_assertions: GoldenDraftSemanticAssertion[];
  review_status: GoldenDraftReviewStatus;
  authored_by: 'codex:draft-author';
}

export interface GoldenDraftCaseCatalog extends JsonObject {
  format: 'icarus.workflow-compiler-golden-draft-cases/1';
  bundle_version: '1.0.0-draft';
  cases: GoldenDraftCase[];
  positive_case_count: number;
  negative_case_count: number;
  catalog_hash: Sha256Hash;
}

export interface GoldenDraftCompilerInputSnapshot extends JsonObject {
  format: 'icarus.workflow-compiler-input-snapshot/1';
  snapshot_id: string;
  launchability: 'test_only';
  compiler_identity: JsonObject;
  registry_snapshot: JsonObject;
  interface_snapshot: JsonObject;
  policy_snapshot: JsonObject;
  safety_snapshot: JsonObject;
  snapshot_hash: Sha256Hash;
}

export interface GoldenDraftManifest extends JsonObject {
  format: 'icarus.workflow-compiler-golden-draft-manifest/1';
  bundle_version: '1.0.0-draft';
  draft_status: 'candidate_pending_human_review';
  draft_author_actor_ref: 'codex:draft-author';
  review_owner_actor_ref: 'human:local-owner';
  draft_generator_tool_hash: Sha256Hash;
  case_catalog_ref: string;
  case_catalog_hash: Sha256Hash;
  input_snapshots: Array<{ ref: string; hash: Sha256Hash }>;
  raw_source_count: number;
  raw_source_aggregate_hash: Sha256Hash;
  positive_case_count: number;
  negative_case_count: number;
  positive_coverage: string[];
  negative_error_code_coverage: WorkflowCompilerErrorCode[];
  additional_negative_coverage: string[];
  expected_plan_artifact_status: 'all_null_pending_review';
  expected_proof_program_status: 'all_null_pending_review';
  golden_semantic_review_status: 'absent';
  sealed_bundle_status: 'absent';
  manifest_hash: Sha256Hash;
}

export interface GoldenDraftReviewRequest extends JsonObject {
  format: 'icarus.workflow-golden-review-request/1';
  review_request_id: string;
  draft_manifest_ref: string;
  draft_manifest_hash: Sha256Hash;
  requested_reviewer_actor_ref: 'human:local-owner';
  checklist_version: 'golden-semantic-review-checklist@1';
  case_ids: string[];
  previous_bundle_ref: null;
  previous_bundle_hash: null;
  semantic_decision_status: 'pending';
  approval_record_status: 'absent';
  immutable_request_hash: Sha256Hash;
}

export interface GoldenDraftReviewReportInput extends JsonObject {
  format: 'icarus.workflow-golden-review-report-input/1';
  report_input_id: string;
  review_request_ref: string;
  review_request_hash: Sha256Hash;
  draft_manifest_ref: string;
  draft_manifest_hash: Sha256Hash;
  case_catalog_ref: string;
  case_catalog_hash: Sha256Hash;
  input_snapshots: Array<{ ref: string; hash: Sha256Hash }>;
  allowed_operations: string[];
  forbidden_module_classes: string[];
  report_generation_status: 'not_run';
  semantic_decision_status: 'pending';
  immutable_input_hash: Sha256Hash;
}

export type GoldenDraftFixtureMutation =
  | 'duplicate_case_id'
  | 'missing_positive_coverage'
  | 'missing_error_code_coverage'
  | 'raw_source_hash_drift'
  | 'snapshot_hash_drift'
  | 'positive_diagnostic_present'
  | 'negative_diagnostic_missing'
  | 'diagnostic_phase_drift'
  | 'diagnostic_order_drift'
  | 'expected_plan_ref_forged'
  | 'expected_plan_hash_forged'
  | 'expected_proof_hash_forged'
  | 'expected_program_hash_forged'
  | 'review_status_approved'
  | 'review_owner_ai'
  | 'approval_record_forged'
  | 'semantic_decision_forged'
  | 'sealed_status_forged'
  | 'sealed_directory_written'
  | 'raw_source_missing'
  | 'snapshot_incomplete'
  | 'snapshot_production_launchable'
  | 'sqlite_candidate_certified'
  | 'prior_manifest_drift'
  | 'production_compiler_import';

export interface GoldenDraftPositiveFixture extends JsonObject {
  fixture_id: string;
  expected_result: 'pass';
}

export interface GoldenDraftNegativeFixture extends JsonObject {
  fixture_id: string;
  mutation: GoldenDraftFixtureMutation;
  expected_error: string;
}

export const GOLDEN_DRAFT_DIAGNOSTIC_KEYS = [
  'code',
  'phase',
  'instance_pointer',
  'schema_pointer',
  'stable_object_id',
  'detail_ref',
] as const satisfies readonly (keyof GoldenDraftDiagnostic)[];

export const GOLDEN_DRAFT_ASSERTION_KEYS = [
  'assertion_id',
  'subject_pointer',
  'operator',
  'expected',
  'rationale',
] as const satisfies readonly (keyof GoldenDraftSemanticAssertion)[];

export const GOLDEN_DRAFT_CASE_KEYS = [
  'case_id',
  'polarity',
  'source_kind',
  'coverage_tags',
  'raw_source_bytes_ref',
  'raw_source_bytes_hash',
  'input_snapshot_ref',
  'input_snapshot_hash',
  'expected_source_hash',
  'expected_plan_bytes_ref',
  'expected_plan_hash',
  'expected_proof_hashes',
  'expected_program_hashes',
  'expected_diagnostics',
  'normalized_semantic_assertions',
  'review_status',
  'authored_by',
] as const satisfies readonly (keyof GoldenDraftCase)[];

export const GOLDEN_DRAFT_CASE_CATALOG_KEYS = [
  'format',
  'bundle_version',
  'cases',
  'positive_case_count',
  'negative_case_count',
  'catalog_hash',
] as const satisfies readonly (keyof GoldenDraftCaseCatalog)[];

export const GOLDEN_DRAFT_INPUT_SNAPSHOT_KEYS = [
  'format',
  'snapshot_id',
  'launchability',
  'compiler_identity',
  'registry_snapshot',
  'interface_snapshot',
  'policy_snapshot',
  'safety_snapshot',
  'snapshot_hash',
] as const satisfies readonly (keyof GoldenDraftCompilerInputSnapshot)[];

export const GOLDEN_DRAFT_MANIFEST_KEYS = [
  'format',
  'bundle_version',
  'draft_status',
  'draft_author_actor_ref',
  'review_owner_actor_ref',
  'draft_generator_tool_hash',
  'case_catalog_ref',
  'case_catalog_hash',
  'input_snapshots',
  'raw_source_count',
  'raw_source_aggregate_hash',
  'positive_case_count',
  'negative_case_count',
  'positive_coverage',
  'negative_error_code_coverage',
  'additional_negative_coverage',
  'expected_plan_artifact_status',
  'expected_proof_program_status',
  'golden_semantic_review_status',
  'sealed_bundle_status',
  'manifest_hash',
] as const satisfies readonly (keyof GoldenDraftManifest)[];

export const GOLDEN_DRAFT_REVIEW_REQUEST_KEYS = [
  'format',
  'review_request_id',
  'draft_manifest_ref',
  'draft_manifest_hash',
  'requested_reviewer_actor_ref',
  'checklist_version',
  'case_ids',
  'previous_bundle_ref',
  'previous_bundle_hash',
  'semantic_decision_status',
  'approval_record_status',
  'immutable_request_hash',
] as const satisfies readonly (keyof GoldenDraftReviewRequest)[];

export const GOLDEN_DRAFT_REVIEW_REPORT_INPUT_KEYS = [
  'format',
  'report_input_id',
  'review_request_ref',
  'review_request_hash',
  'draft_manifest_ref',
  'draft_manifest_hash',
  'case_catalog_ref',
  'case_catalog_hash',
  'input_snapshots',
  'allowed_operations',
  'forbidden_module_classes',
  'report_generation_status',
  'semantic_decision_status',
  'immutable_input_hash',
] as const satisfies readonly (keyof GoldenDraftReviewReportInput)[];
