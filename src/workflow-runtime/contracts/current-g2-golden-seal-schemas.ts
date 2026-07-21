import type { JsonObject } from './types.js';

type Schema = JsonObject;

const HASH = '^sha256:[0-9a-f]{64}$';
const PATH = '^[A-Za-z0-9][A-Za-z0-9.@_/-]*$';

function closed(properties: Record<string, Schema>): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

const hash: Schema = { type: 'string', pattern: HASH };
const path: Schema = { type: 'string', pattern: PATH };
const nullValue: Schema = { type: 'null' };
const versionedRef = closed({
  id: { type: 'string', minLength: 1 },
  version: { type: 'string', minLength: 1 },
});
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

export const CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-semantic-review-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-golden-semantic-review/1' },
    gate: { const: 'G2' },
    construction_phase: { const: 'RC_REVIEW' },
    review_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]+$' },
    bundle_version: { const: '1.0.0' },
    case_ids: array(
      { type: 'string', minLength: 1 },
      {
        minItems: 40,
        maxItems: 40,
        uniqueItems: true,
      },
    ),
    case_count: { const: 40 },
    draft_manifest_ref: path,
    draft_manifest_hash: hash,
    draft_artifact_hash: hash,
    golden_review_report_ref: path,
    golden_review_report_hash: hash,
    golden_review_report_artifact_hash: hash,
    reviewer_actor_ref: { const: 'human:local-owner' },
    decision: { enum: ['approved', 'changes_requested'] },
    checklist_version: { const: 'current-g2-golden-semantic-review/1' },
    checklist: array(
      { type: 'string', minLength: 1 },
      { minItems: 8, uniqueItems: true },
    ),
    comparison_acknowledgement: closed({
      role: { const: 'actual_compiler_output_not_golden_oracle' },
      expected_coverage: { const: 40 },
      comparison_coverage: { const: 40 },
      byte_equal_count: { const: 29 },
      semantic_equal_count: { const: 29 },
      compiled_difference_case_count: { const: 11 },
      pointer_difference_count: { const: 622 },
      semantic_assertion_count: { const: 85 },
      semantic_assertion_failure_count: { const: 0 },
    }),
    authorization_scope: closed({
      exact_draft_only: { const: true },
      expected_semantics_authoritative: { const: true },
      immutable_review_and_golden_seal_authorized: { const: true },
      draft_working_rc_identity_mutation_authorized: { const: false },
      g3_through_g9_authorized: { const: false },
    }),
    signature_policy: { const: 'not_required_local_single_user' },
    notes_ref: nullValue,
    notes_hash: nullValue,
    reviewed_at_ms: { type: 'integer', minimum: 1 },
    review_hash: hash,
  }),
};

const contentIdentity = closed({
  path,
  original_ref: path,
  media_type: { const: 'application/json' },
  canonicalization: { const: 'rfc8785_jcs' },
  raw_bytes_hash: hash,
  semantic_hash: hash,
  domain_separator: { type: 'string', pattern: '^icarus:[ -~]+\\n$' },
});

const nullableContentIdentity: Schema = { anyOf: [contentIdentity, nullValue] };
const nullableHash: Schema = { anyOf: [hash, nullValue] };
const nullablePath: Schema = { anyOf: [path, nullValue] };
const diagnostic: Schema = closed({
  code: { type: 'string', minLength: 1 },
  phase: { enum: ['parse', 'schema', 'bind', 'prove', 'normalize', 'hash'] },
  instance_pointer: { type: 'string' },
  schema_pointer: { anyOf: [{ type: 'string' }, nullValue] },
  stable_object_id: { anyOf: [{ type: 'string' }, nullValue] },
  detail_ref: { anyOf: [{ type: 'string' }, nullValue] },
});

const sealedCase = closed({
  case_id: { type: 'string', minLength: 1 },
  source_kind: {
    enum: ['graph_scope', 'workflow_definition', 'workflow_schema'],
  },
  outcome: { enum: ['compiled', 'rejected'] },
  raw_source_bytes_ref: path,
  raw_source_bytes_hash: hash,
  raw_source_file_hash: hash,
  registry_snapshot_ref: path,
  interface_policy_safety_snapshot_ref: path,
  input_snapshot_hash: hash,
  input_snapshot_file_hash: hash,
  effective_case_input_hash: hash,
  expected_source_hash: hash,
  expected_result: contentIdentity,
  expected_plan: nullableContentIdentity,
  expected_proofs: nullableContentIdentity,
  expected_programs: nullableContentIdentity,
  expected_plan_bytes_ref: nullablePath,
  expected_plan_hash: nullableHash,
  expected_proof_program_hashes: array(hash, { uniqueItems: true }),
  expected_diagnostics: array(diagnostic),
  approved_review_ref: path,
  approved_review_hash: hash,
});

const inventoryEntry = closed({
  path,
  kind: {
    enum: [
      'schema',
      'raw_source',
      'input_snapshot',
      'expected_result',
      'expected_plan',
      'expected_proofs',
      'expected_programs',
    ],
  },
  case_id: { anyOf: [{ type: 'string', minLength: 1 }, nullValue] },
  original_ref: { anyOf: [path, nullValue] },
  raw_bytes_hash: hash,
  semantic_hash: hash,
  domain_separator: { type: 'string', pattern: '^icarus:[ -~]+\\n$' },
});

export const CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-conformance-inventory-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-conformance-inventory/1' },
    gate: { const: 'G2' },
    bundle_version: { const: '1.0.0' },
    inventory_scope: {
      const: 'all_sealed_leaf_artifacts_excluding_inventory_and_bundle',
    },
    entry_count: { type: 'integer', minimum: 1 },
    entries: array(inventoryEntry, { minItems: 1 }),
    inventory_hash: hash,
  }),
};

export const CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/current-g2-golden-conformance-bundle-v1',
  ...closed({
    format: { const: 'icarus.workflow-compiler-conformance/1' },
    gate: { const: 'G2' },
    construction_phase: { const: 'RC_REVIEW' },
    bundle_version: { const: '1.0.0' },
    bundle_status: { const: 'sealed_pending_ci_replay' },
    publishable: { const: false },
    production_reachable: { const: false },
    toolchain_manifest_ref: versionedRef,
    toolchain_hash: hash,
    error_catalog_ref: versionedRef,
    error_catalog_hash: hash,
    exact_compiler_identity: { type: 'object' },
    draft_manifest_ref: path,
    draft_manifest_hash: hash,
    draft_artifact_hash: hash,
    golden_review_report_ref: path,
    golden_review_report_hash: hash,
    golden_review_report_artifact_hash: hash,
    golden_semantic_review_ref: path,
    golden_semantic_review_hash: hash,
    golden_semantic_review_artifact_hash: hash,
    approval_status: { const: 'approved' },
    signature_policy: { const: 'not_required_local_single_user' },
    review_assignment: { const: 'exactly_one_approved_review_per_case' },
    case_count: { const: 40 },
    compiled_count: { const: 11 },
    rejected_count: { const: 29 },
    expected_result_coverage: { const: 40 },
    expected_plan_coverage: { const: 11 },
    expected_proof_bytes_coverage: { const: 11 },
    expected_program_bytes_coverage: { const: 11 },
    sealed_raw_source_coverage: { const: 40 },
    sealed_input_snapshot_coverage: { const: 40 },
    cases: array(sealedCase, { minItems: 40, maxItems: 40 }),
    inventory_ref: path,
    inventory_hash: hash,
    sealed_artifact_count: { type: 'integer', minimum: 1 },
    ci_replay_status: { const: 'not_run_at_seal_time' },
    g3_through_g9_status: { const: 'not_started' },
    bundle_hash: hash,
  }),
  $defs: { json_value: jsonValue },
};
