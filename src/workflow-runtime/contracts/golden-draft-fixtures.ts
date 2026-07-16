import type {
  GoldenDraftNegativeFixture,
  GoldenDraftPositiveFixture,
} from './golden-draft-types.js';

export const GOLDEN_DRAFT_POSITIVE_FIXTURES = [
  { fixture_id: 'complete-case-catalog', expected_result: 'pass' },
  { fixture_id: 'complete-input-snapshots', expected_result: 'pass' },
  { fixture_id: 'all-raw-bytes-hash-bound', expected_result: 'pass' },
  { fixture_id: 'all-error-codes-covered', expected_result: 'pass' },
  { fixture_id: 'all-positive-topics-covered', expected_result: 'pass' },
  { fixture_id: 'expected-plan-proof-program-null', expected_result: 'pass' },
  { fixture_id: 'review-owner-local-owner', expected_result: 'pass' },
  { fixture_id: 'review-and-seal-absent', expected_result: 'pass' },
] as const satisfies readonly GoldenDraftPositiveFixture[];

export const GOLDEN_DRAFT_NEGATIVE_FIXTURES = [
  {
    fixture_id: 'duplicate-case-id',
    mutation: 'duplicate_case_id',
    expected_error: 'golden_draft_case_id_duplicate',
  },
  {
    fixture_id: 'missing-positive-coverage',
    mutation: 'missing_positive_coverage',
    expected_error: 'golden_draft_positive_coverage_incomplete',
  },
  {
    fixture_id: 'missing-error-code-coverage',
    mutation: 'missing_error_code_coverage',
    expected_error: 'golden_draft_error_coverage_incomplete',
  },
  {
    fixture_id: 'raw-source-hash-drift',
    mutation: 'raw_source_hash_drift',
    expected_error: 'golden_draft_raw_source_hash_mismatch',
  },
  {
    fixture_id: 'snapshot-hash-drift',
    mutation: 'snapshot_hash_drift',
    expected_error: 'golden_draft_snapshot_hash_mismatch',
  },
  {
    fixture_id: 'positive-diagnostic-present',
    mutation: 'positive_diagnostic_present',
    expected_error: 'golden_draft_positive_diagnostic_forbidden',
  },
  {
    fixture_id: 'negative-diagnostic-missing',
    mutation: 'negative_diagnostic_missing',
    expected_error: 'golden_draft_negative_diagnostic_required',
  },
  {
    fixture_id: 'diagnostic-phase-drift',
    mutation: 'diagnostic_phase_drift',
    expected_error: 'golden_draft_diagnostic_phase_mismatch',
  },
  {
    fixture_id: 'diagnostic-order-drift',
    mutation: 'diagnostic_order_drift',
    expected_error: 'golden_draft_diagnostic_order_invalid',
  },
  {
    fixture_id: 'expected-plan-ref-forged',
    mutation: 'expected_plan_ref_forged',
    expected_error: 'golden_draft_reviewed_expected_artifact_forbidden',
  },
  {
    fixture_id: 'expected-plan-hash-forged',
    mutation: 'expected_plan_hash_forged',
    expected_error: 'golden_draft_reviewed_expected_artifact_forbidden',
  },
  {
    fixture_id: 'expected-proof-hash-forged',
    mutation: 'expected_proof_hash_forged',
    expected_error: 'golden_draft_reviewed_expected_artifact_forbidden',
  },
  {
    fixture_id: 'expected-program-hash-forged',
    mutation: 'expected_program_hash_forged',
    expected_error: 'golden_draft_reviewed_expected_artifact_forbidden',
  },
  {
    fixture_id: 'review-status-approved',
    mutation: 'review_status_approved',
    expected_error: 'golden_draft_review_approval_forbidden',
  },
  {
    fixture_id: 'review-owner-ai',
    mutation: 'review_owner_ai',
    expected_error: 'golden_draft_review_owner_invalid',
  },
  {
    fixture_id: 'approval-record-forged',
    mutation: 'approval_record_forged',
    expected_error: 'golden_draft_review_approval_forbidden',
  },
  {
    fixture_id: 'semantic-decision-forged',
    mutation: 'semantic_decision_forged',
    expected_error: 'golden_draft_review_approval_forbidden',
  },
  {
    fixture_id: 'sealed-status-forged',
    mutation: 'sealed_status_forged',
    expected_error: 'golden_draft_sealed_artifact_forbidden',
  },
  {
    fixture_id: 'sealed-directory-written',
    mutation: 'sealed_directory_written',
    expected_error: 'golden_draft_sealed_artifact_forbidden',
  },
  {
    fixture_id: 'raw-source-missing',
    mutation: 'raw_source_missing',
    expected_error: 'golden_draft_raw_source_missing',
  },
  {
    fixture_id: 'snapshot-incomplete',
    mutation: 'snapshot_incomplete',
    expected_error: 'golden_draft_snapshot_incomplete',
  },
  {
    fixture_id: 'snapshot-production-launchable',
    mutation: 'snapshot_production_launchable',
    expected_error: 'golden_draft_test_only_boundary_required',
  },
  {
    fixture_id: 'sqlite-candidate-certified',
    mutation: 'sqlite_candidate_certified',
    expected_error: 'golden_draft_sqlite_certification_forbidden',
  },
  {
    fixture_id: 'prior-manifest-drift',
    mutation: 'prior_manifest_drift',
    expected_error: 'golden_draft_prior_identity_drift',
  },
  {
    fixture_id: 'production-compiler-import',
    mutation: 'production_compiler_import',
    expected_error: 'golden_draft_oracle_isolation_violation',
  },
] as const satisfies readonly GoldenDraftNegativeFixture[];
