import type { JsonObject } from './types.js';

const HASH = '^sha256:[0-9a-f]{64}$';
const POINTER = '^(?:/(?:[^~/]|~[01])*)*$';
const PATH = '^[A-Za-z0-9][A-Za-z0-9.@_/-]*$';

type Schema = JsonObject;

function closed(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const omitted = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !omitted.has(key)),
    properties,
  };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

const hash: Schema = { type: 'string', pattern: HASH };
const path: Schema = { type: 'string', pattern: PATH };
const nullValue: Schema = { type: 'null' };
const nullableHash: Schema = { anyOf: [hash, nullValue] };
const nullablePath: Schema = { anyOf: [path, nullValue] };
const jsonValue: Schema = {
  anyOf: [
    nullValue,
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    array({ $ref: '#/$defs/json_value' }),
    { type: 'object', additionalProperties: { $ref: '#/$defs/json_value' } },
  ],
};
const versionedRef = closed({
  id: { type: 'string', minLength: 1 },
  version: { type: 'string', minLength: 1 },
});

const diagnostic = closed({
  code: { type: 'string', minLength: 1 },
  phase: {
    type: 'string',
    enum: ['parse', 'schema', 'bind', 'prove', 'normalize', 'hash'],
  },
  instance_pointer: { type: 'string', pattern: POINTER },
  schema_pointer: { anyOf: [{ type: 'string', minLength: 1 }, nullValue] },
  stable_object_id: { anyOf: [{ type: 'string', minLength: 1 }, nullValue] },
  detail_ref: { anyOf: [{ type: 'string', minLength: 1 }, nullValue] },
});

const assertion = closed({
  assertion_id: { type: 'string', minLength: 1 },
  subject_pointer: { type: 'string', pattern: POINTER },
  operator: {
    type: 'string',
    enum: ['equals', 'set_equals', 'ordered_equals', 'contains', 'present', 'absent'],
  },
  expected: { $ref: '#/$defs/json_value' },
  rationale: { type: 'string', minLength: 1 },
});

const contentIdentity = closed({
  path,
  media_type: { const: 'application/json' },
  canonicalization: { const: 'rfc8785_jcs' },
  raw_bytes_hash: hash,
  semantic_hash: hash,
  domain_separator: { type: 'string', pattern: '^icarus:[ -~]+\\n$' },
});

const optionalContentIdentity = closed({
  path: nullablePath,
  media_type: { enum: ['application/json', null] },
  canonicalization: { enum: ['rfc8785_jcs', null] },
  raw_bytes_hash: nullableHash,
  semantic_hash: nullableHash,
  domain_separator: {
    anyOf: [{ type: 'string', pattern: '^icarus:[ -~]+\\n$' }, nullValue],
  },
});

const sourceBinding = closed({
  raw_source_bytes_ref: path,
  raw_source_bytes_hash: hash,
  raw_source_file_hash: hash,
  input_snapshot_ref: path,
  input_snapshot_hash: hash,
  input_snapshot_file_hash: hash,
  effective_case_input_hash: hash,
});

const draftCase = closed({
  case_id: { type: 'string', minLength: 1 },
  polarity: { enum: ['positive', 'negative'] },
  source_kind: { enum: ['graph_scope', 'workflow_definition', 'workflow_schema'] },
  coverage_tags: array({ type: 'string', minLength: 1 }, { minItems: 1, uniqueItems: true }),
  source_binding: sourceBinding,
  outcome: { enum: ['compiled', 'rejected'] },
  expected_result: contentIdentity,
  expected_plan: optionalContentIdentity,
  expected_proofs: optionalContentIdentity,
  expected_programs: optionalContentIdentity,
  expected_plan_hash: nullableHash,
  expected_proof_hashes: array(hash, { uniqueItems: true }),
  expected_program_hashes: array(hash, { uniqueItems: true }),
  expected_diagnostics: array(diagnostic),
  semantic_assertions: array(assertion),
  authored_from: { const: 'current_spec_machine_contract_source_snapshot' },
  human_judgment: nullValue,
});

const exactIdentity = closed({
  compiler_toolchain_manifest_ref: versionedRef,
  compiler_toolchain_hash: hash,
  compiler_version: { type: 'string', minLength: 1 },
  compiler_build_hash: hash,
  canonical_normalizer_version: { type: 'string', minLength: 1 },
  canonical_normalizer_hash: hash,
  proof_algorithm_version: { type: 'string', minLength: 1 },
  proof_algorithm_hash: hash,
  error_catalog_ref: versionedRef,
  error_catalog_hash: hash,
  compiled_ir_schema_ref: path,
  compiled_ir_schema_hash: hash,
  conformance_result_schema_ref: path,
  conformance_result_schema_hash: hash,
});

const boundRoot = closed({
  path,
  semantic_hash: hash,
  raw_bytes_hash: hash,
});

export const CURRENT_G2_GOLDEN_CASES_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-draft-cases-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-current-g2-golden-draft-cases/1' },
    construction_phase: { const: 'RC_REVIEW' },
    draft_status: { const: 'frozen_pending_human_approval' },
    publishable: { const: false },
    production_reachable: { const: false },
    review_candidate_ref: path,
    review_candidate_hash: hash,
    source_set_hash: hash,
    bound_working_roots: closed({
      contract: boundRoot,
      input: boundRoot,
      candidate: boundRoot,
      working_review: boundRoot,
    }),
    case_count: { const: 40 },
    compiled_count: { const: 11 },
    rejected_count: { const: 29 },
    expected_result_coverage: { const: 40 },
    human_judgment_coverage: { const: 0 },
    cases: array(draftCase, { minItems: 40, maxItems: 40 }),
    cases_hash: hash,
  }),
  $defs: { json_value: jsonValue },
};

const inventoryEntry = closed({
  path,
  kind: {
    enum: [
      'schema',
      'case_catalog',
      'expected_result',
      'expected_plan',
      'expected_proofs',
      'expected_programs',
    ],
  },
  case_id: { anyOf: [{ type: 'string', minLength: 1 }, nullValue] },
  raw_bytes_hash: hash,
  semantic_hash: hash,
  domain_separator: { type: 'string', pattern: '^icarus:[ -~]+\\n$' },
});

export const CURRENT_G2_GOLDEN_INVENTORY_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-draft-inventory-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-current-g2-golden-draft-inventory/1' },
    construction_phase: { const: 'RC_REVIEW' },
    inventory_scope: { const: 'all_draft_leaf_artifacts_excluding_manifest' },
    entry_count: { type: 'integer', minimum: 1 },
    entries: array(inventoryEntry, { minItems: 1 }),
    inventory_hash: hash,
  }),
};

export const CURRENT_G2_GOLDEN_MANIFEST_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-draft-manifest-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-current-g2-golden-draft-manifest/1' },
    gate: { const: 'G2' },
    construction_phase: { const: 'RC_REVIEW' },
    draft_status: { const: 'frozen_pending_human_approval' },
    publishable: { const: false },
    production_reachable: { const: false },
    review_candidate_ref: path,
    review_candidate_hash: hash,
    source_set_hash: hash,
    bound_working_roots: closed({
      contract: boundRoot,
      input: boundRoot,
      candidate: boundRoot,
      working_review: boundRoot,
    }),
    semantic_correction_contract_ref: path,
    semantic_correction_contract_hash: hash,
    semantic_correction_input_manifest_ref: path,
    semantic_correction_input_manifest_hash: hash,
    source_case_catalog_ref: path,
    source_case_catalog_hash: hash,
    case_input_binding_ref: path,
    case_input_binding_hash: hash,
    toolchain_file_ref: path,
    toolchain_file_hash: hash,
    authoring_generator_ref: path,
    authoring_generator_hash: hash,
    exact_compiler_identity: exactIdentity,
    cases_ref: path,
    cases_hash: hash,
    inventory_ref: path,
    inventory_hash: hash,
    case_count: { const: 40 },
    compiled_count: { const: 11 },
    rejected_count: { const: 29 },
    expected_result_coverage: { const: 40 },
    expected_plan_coverage: { const: 11 },
    expected_proof_bytes_coverage: { const: 11 },
    expected_program_bytes_coverage: { const: 11 },
    human_review: closed({
      status: { const: 'not_requested' },
      reviewer_actor_ref: { const: 'human:local-owner' },
      judgment_coverage: { const: 0 },
      judgment_record_ref: nullValue,
      judgment_record_hash: nullValue,
    }),
    approval: closed({ status: { const: 'absent' }, ref: nullValue, hash: nullValue }),
    signature: closed({ status: { const: 'absent' }, ref: nullValue, hash: nullValue }),
    seal: closed({
      status: { const: 'absent' },
      ref: nullValue,
      hash: nullValue,
      sealed_artifact_count: { const: 0 },
      conformance_sealed_write_status: { const: 'not_run' },
    }),
    golden_semantic_review_status: { const: 'not_run' },
    golden_review_report_status: { const: 'generated_after_draft_freeze' },
    g3_through_g9_status: { const: 'not_started' },
    draft_manifest_hash: hash,
  }),
};

const difference = closed({
  pointer: { type: 'string', pattern: POINTER },
  kind: { enum: ['missing_expected', 'missing_actual', 'value_mismatch'] },
  expected: { $ref: '#/$defs/json_value' },
  actual: { $ref: '#/$defs/json_value' },
});

const reviewCase = closed({
  case_id: { type: 'string', minLength: 1 },
  source_ref: path,
  snapshot_ref: path,
  expected_result_ref: path,
  expected_result_hash: hash,
  actual_result_ref: path,
  actual_result_hash: hash,
  outcome: { enum: ['compiled', 'rejected'] },
  byte_equal: { type: 'boolean' },
  semantic_equal: { type: 'boolean' },
  normalized_plan: { anyOf: [{ type: 'object' }, nullValue] },
  diagnostic_pointers: array({ type: 'string', pattern: POINTER }),
  semantic_assertion_count: { type: 'integer', minimum: 0 },
  semantic_assertion_failures: array({ type: 'object' }),
  difference_count: { type: 'integer', minimum: 0 },
  differences: array(difference),
});

export const CURRENT_G2_GOLDEN_REVIEW_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-review-report-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-current-g2-golden-review-report/1' },
    construction_phase: { const: 'RC_REVIEW' },
    report_kind: { const: 'read_only_draft_candidate_comparison' },
    publishable: { const: false },
    production_reachable: { const: false },
    draft_manifest_ref: path,
    draft_manifest_hash: hash,
    review_candidate_ref: path,
    review_candidate_hash: hash,
    candidate_root_ref: path,
    candidate_root_hash: hash,
    actual_results_manifest_ref: path,
    actual_results_manifest_hash: hash,
    actual_comparison_role: { const: 'actual_compiler_output_not_golden_oracle' },
    case_count: { const: 40 },
    compiled_count: { const: 11 },
    rejected_count: { const: 29 },
    expected_coverage: { const: 40 },
    comparison_coverage: { const: 40 },
    byte_equal_count: { type: 'integer', minimum: 0, maximum: 40 },
    semantic_equal_count: { type: 'integer', minimum: 0, maximum: 40 },
    semantic_assertion_count: { type: 'integer', minimum: 0 },
    semantic_assertion_failure_count: { type: 'integer', minimum: 0 },
    difference_count: { type: 'integer', minimum: 0 },
    cases: array(reviewCase, { minItems: 40, maxItems: 40 }),
    human_review: closed({
      status: { const: 'not_requested' },
      reviewer_actor_ref: { const: 'human:local-owner' },
      judgment_coverage: { const: 0 },
    }),
    approval_status: { const: 'absent' },
    signature_status: { const: 'absent' },
    seal_status: { const: 'absent' },
    golden_semantic_review_status: { const: 'not_run' },
    g3_through_g9_status: { const: 'not_started' },
    report_hash: hash,
  }),
  $defs: { json_value: jsonValue },
};
