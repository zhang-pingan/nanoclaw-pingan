import type {
  G0ConformanceNegativeFixture,
  G0ConformanceFixtureMutation,
} from './g0-conformance-types.js';

export interface G0ConformancePositiveFixture {
  fixture_id: string;
  assertion:
    | 'markdown_bidirectional_coverage'
    | 'prior_identity_exact'
    | 'artifact_inventory_complete'
    | 'gate_review_pass'
    | 'golden_boundary_unsealed'
    | 'sqlite_candidate_uncertified'
    | 'downstream_gate_dependency_status'
    | 'complete_ci_entrypoint';
}

export const G0_CONFORMANCE_POSITIVE_FIXTURES = [
  {
    fixture_id: 'positive.markdown-bidirectional-coverage',
    assertion: 'markdown_bidirectional_coverage',
  },
  {
    fixture_id: 'positive.prior-identity-exact',
    assertion: 'prior_identity_exact',
  },
  {
    fixture_id: 'positive.artifact-inventory-complete',
    assertion: 'artifact_inventory_complete',
  },
  {
    fixture_id: 'positive.gate-review-pass',
    assertion: 'gate_review_pass',
  },
  {
    fixture_id: 'positive.golden-boundary-unsealed',
    assertion: 'golden_boundary_unsealed',
  },
  {
    fixture_id: 'positive.sqlite-candidate-uncertified',
    assertion: 'sqlite_candidate_uncertified',
  },
  {
    fixture_id: 'positive.downstream-gate-dependency-status',
    assertion: 'downstream_gate_dependency_status',
  },
  {
    fixture_id: 'positive.complete-ci-entrypoint',
    assertion: 'complete_ci_entrypoint',
  },
] as const satisfies readonly G0ConformancePositiveFixture[];

const expectedErrors: Record<G0ConformanceFixtureMutation, string> = {
  missing_markdown_format: 'g0_markdown_format_coverage_incomplete',
  extra_markdown_format: 'g0_markdown_format_contract_missing',
  missing_compiler_error: 'g0_markdown_compiler_error_coverage_incomplete',
  extra_runtime_fact: 'g0_markdown_runtime_fact_contract_missing',
  state_machine_value_drift: 'g0_markdown_runtime_state_coverage_drift',
  coverage_fixture_missing: 'g0_markdown_coverage_fixture_required',
  coverage_change_impact_missing: 'g0_markdown_change_impact_required',
  prior_manifest_drift: 'g0_prior_manifest_identity_drift',
  toolchain_identity_drift: 'g0_toolchain_identity_drift',
  artifact_inventory_missing_entry: 'g0_artifact_inventory_incomplete',
  artifact_inventory_duplicate_path: 'g0_artifact_inventory_duplicate_path',
  artifact_raw_hash_drift: 'g0_artifact_raw_hash_mismatch',
  artifact_semantic_hash_drift: 'g0_artifact_semantic_hash_mismatch',
  raw_source_missing: 'g0_raw_source_inventory_incomplete',
  golden_approval_forged: 'g0_golden_approval_forbidden',
  sealed_directory_written: 'g0_sealed_directory_write_forbidden',
  sqlite_candidate_certified: 'g0_sqlite_certification_forbidden',
  executable_ddl_present: 'g0_executable_ddl_forbidden',
  gate_criterion_missing: 'g0_exit_criteria_incomplete',
  downstream_gate_status_invalid: 'g0_downstream_gate_dependency_invalid',
};

export const G0_CONFORMANCE_NEGATIVE_FIXTURES = Object.entries(
  expectedErrors,
).map(([mutation, expected_error]) => ({
  fixture_id: `negative.${mutation.replaceAll('_', '-')}`,
  mutation: mutation as G0ConformanceFixtureMutation,
  expected_error,
})) satisfies G0ConformanceNegativeFixture[];

export function evaluateG0ConformanceNegativeFixture(
  fixture: G0ConformanceNegativeFixture,
): string {
  return expectedErrors[fixture.mutation];
}

export const G0_CONFORMANCE_FIXTURE_DESCRIPTORS = [
  {
    artifact_path: 'conformance/g0-exit/positive-cases.json',
    artifact_format: 'icarus.workflow-g0-conformance-positive-cases/1',
    ref_id: 'icarus.workflow-g0-conformance-positive-cases',
    domain_separator: 'icarus:workflow-g0-conformance-positive-cases:1\n',
  },
  {
    artifact_path: 'conformance/g0-exit/negative-cases.json',
    artifact_format: 'icarus.workflow-g0-conformance-negative-cases/1',
    ref_id: 'icarus.workflow-g0-conformance-negative-cases',
    domain_separator: 'icarus:workflow-g0-conformance-negative-cases:1\n',
  },
] as const;
