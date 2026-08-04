import type { Sha256Hash } from './types.js';

export const G0_COVERAGE_CATEGORIES = [
  'semantic_format',
  'compiler_error_code',
  'runtime_fact_kind',
  'runtime_event_type',
  'runtime_state_value',
] as const;
export type G0CoverageCategory = (typeof G0_COVERAGE_CATEGORIES)[number];

export const G0_CHANGE_IMPACTS = [
  'new_format_or_major_contract_version_required',
  'compiler_contract_version_and_golden_review_required',
  'run_protocol_version_and_fixture_update_required',
] as const;
export type G0ChangeImpact = (typeof G0_CHANGE_IMPACTS)[number];

export interface G0MarkdownCoverageEntry {
  coverage_id: string;
  category: G0CoverageCategory;
  value: string;
  contract_path: string;
  contract_pointer: string;
  markdown_section: string;
  markdown_anchor: string;
  change_impact: G0ChangeImpact;
  fixture_refs: string[];
  entry_hash: Sha256Hash;
}

export interface G0MarkdownContractCoverage {
  format: 'icarus.workflow-markdown-contract-coverage/1';
  architecture_path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md';
  architecture_sha256: Sha256Hash;
  extraction_policy: 'conformance_only_no_runtime_markdown_extraction';
  categories: G0CoverageCategory[];
  entries: G0MarkdownCoverageEntry[];
  category_counts: Record<G0CoverageCategory, number>;
  contract_value_count: number;
  markdown_value_count: number;
  contract_values_without_markdown: string[];
  markdown_values_without_contract: string[];
  coverage_hash: Sha256Hash;
}

export const G0_INVENTORY_CLASSES = [
  'toolchain_identity',
  'contract_manifest',
  'contract_artifact',
  'raw_source_bytes',
  'capacity_config',
] as const;
export type G0InventoryClass = (typeof G0_INVENTORY_CLASSES)[number];

export const G0_SEMANTIC_HASH_KINDS = [
  'artifact_envelope',
  'manifest_identity',
  'managed_distribution_manifest',
  'locked_toolchain_inputs',
  'raw_source_domain',
  'capacity_config',
  'file_sha256',
] as const;
export type G0SemanticHashKind = (typeof G0_SEMANTIC_HASH_KINDS)[number];

export interface G0ArtifactHashInventoryEntry {
  artifact_id: string;
  owning_slice: `G0.${number}`;
  artifact_class: G0InventoryClass;
  path: string;
  format: string | null;
  byte_length: number;
  raw_sha256: Sha256Hash;
  semantic_hash_kind: G0SemanticHashKind;
  semantic_hash: Sha256Hash;
}

export interface G0ArtifactHashInventory {
  format: 'icarus.workflow-g0-artifact-hash-inventory/1';
  inventory_scope: 'all_g0_1_g0_8_exit_artifacts_and_raw_sources';
  g0_9_closure_policy: 'g0_9_leaf_artifacts_owned_by_root_manifest';
  entries: G0ArtifactHashInventoryEntry[];
  entry_count: number;
  class_counts: Record<G0InventoryClass, number>;
  slice_counts: Record<`G0.${number}`, number>;
  duplicate_paths: string[];
  missing_paths: string[];
  inventory_hash: Sha256Hash;
}

export interface G0SliceIdentityPin {
  slice_id: `G0.${number}`;
  identity_kind: 'toolchain_manifest' | 'contract_pack_manifest';
  primary_identity_hash: Sha256Hash;
  supporting_identity_hashes: Sha256Hash[];
}

export interface G0ExitCriterion {
  criterion_id: string;
  status: 'pass';
  evidence_hashes: Sha256Hash[];
}

export interface G0GateStatusRecord {
  gate_id: `G${number}`;
  status: 'DONE' | 'READY' | 'NOT_READY';
}

export interface G0GateReview {
  format: 'icarus.workflow-g0-gate-review/1';
  gate_id: 'G0';
  review_kind: 'machine_conformance_exit_review';
  decision: 'pass';
  slice_identities: G0SliceIdentityPin[];
  exit_criteria: G0ExitCriterion[];
  markdown_coverage_hash: Sha256Hash;
  artifact_inventory_hash: Sha256Hash;
  absence_proof: {
    workflow_runtime_absence_hash: Sha256Hash;
    product_surface_coverage_hash: Sha256Hash;
    migration_candidate_boundary_hash: Sha256Hash;
    production_source_hits: 0;
    removed_api_hits: 0;
    removed_ui_hits: 0;
    legacy_schema_hits: 0;
    legacy_filesystem_hits: 0;
    active_resource_hits: 0;
    candidate_reachability_hits: 0;
  };
  status_proof: {
    golden_review_request_status: 'pending';
    golden_review_report_status: 'not_run';
    golden_semantic_review_status: 'absent';
    golden_seal_status: 'not_run';
    sealed_bundle_status: 'absent';
    sealed_directory_entry: '.gitkeep';
    expected_plan_bytes_status: 'all_null';
    expected_plan_hash_status: 'all_null';
    expected_proof_program_hash_status: 'all_null';
    sqlite_profile_status: 'candidate';
    sqlite_certification_status: 'not_certified';
    executable_ddl_status: 'absent';
    schema_manifest_status: 'absent';
    workflow_runtime_store_status: 'absent';
    production_compiler_status: 'absent';
    golden_bundle_status: 'absent';
    registry_runtime_status: 'absent';
    runtime_center_ui_status: 'absent';
  };
  gate_statuses: G0GateStatusRecord[];
  conformance_entrypoint: 'npm run test:g0';
  review_hash: Sha256Hash;
}

export const G0_MARKDOWN_COVERAGE_KEYS = [
  'format',
  'architecture_path',
  'architecture_sha256',
  'extraction_policy',
  'categories',
  'entries',
  'category_counts',
  'contract_value_count',
  'markdown_value_count',
  'contract_values_without_markdown',
  'markdown_values_without_contract',
  'coverage_hash',
] as const satisfies readonly (keyof G0MarkdownContractCoverage)[];

export const G0_MARKDOWN_COVERAGE_ENTRY_KEYS = [
  'coverage_id',
  'category',
  'value',
  'contract_path',
  'contract_pointer',
  'markdown_section',
  'markdown_anchor',
  'change_impact',
  'fixture_refs',
  'entry_hash',
] as const satisfies readonly (keyof G0MarkdownCoverageEntry)[];

export const G0_ARTIFACT_INVENTORY_KEYS = [
  'format',
  'inventory_scope',
  'g0_9_closure_policy',
  'entries',
  'entry_count',
  'class_counts',
  'slice_counts',
  'duplicate_paths',
  'missing_paths',
  'inventory_hash',
] as const satisfies readonly (keyof G0ArtifactHashInventory)[];

export const G0_ARTIFACT_INVENTORY_ENTRY_KEYS = [
  'artifact_id',
  'owning_slice',
  'artifact_class',
  'path',
  'format',
  'byte_length',
  'raw_sha256',
  'semantic_hash_kind',
  'semantic_hash',
] as const satisfies readonly (keyof G0ArtifactHashInventoryEntry)[];

export const G0_GATE_REVIEW_KEYS = [
  'format',
  'gate_id',
  'review_kind',
  'decision',
  'slice_identities',
  'exit_criteria',
  'markdown_coverage_hash',
  'artifact_inventory_hash',
  'absence_proof',
  'status_proof',
  'gate_statuses',
  'conformance_entrypoint',
  'review_hash',
] as const satisfies readonly (keyof G0GateReview)[];

export const G0_CONFORMANCE_FIXTURE_MUTATIONS = [
  'missing_markdown_format',
  'extra_markdown_format',
  'missing_compiler_error',
  'extra_runtime_fact',
  'state_machine_value_drift',
  'coverage_fixture_missing',
  'coverage_change_impact_missing',
  'prior_manifest_drift',
  'toolchain_identity_drift',
  'artifact_inventory_missing_entry',
  'artifact_inventory_duplicate_path',
  'artifact_raw_hash_drift',
  'artifact_semantic_hash_drift',
  'raw_source_missing',
  'golden_approval_forged',
  'sealed_directory_written',
  'sqlite_candidate_certified',
  'executable_ddl_present',
  'gate_criterion_missing',
  'downstream_gate_status_invalid',
] as const;
export type G0ConformanceFixtureMutation =
  (typeof G0_CONFORMANCE_FIXTURE_MUTATIONS)[number];

export interface G0ConformanceNegativeFixture {
  fixture_id: string;
  mutation: G0ConformanceFixtureMutation;
  expected_error: string;
}
