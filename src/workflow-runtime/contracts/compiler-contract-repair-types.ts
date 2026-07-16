import type { WorkflowCompilerErrorCode } from './catalog-protocol-types.js';
import type { CompiledScopePlanDocument } from './closed-schema-types.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const COMPILED_CONDITION_OPERAND_TYPES = [
  'null',
  'boolean',
  'number',
  'string',
  'array',
  'object',
] as const;
export type CompiledConditionOperandType =
  (typeof COMPILED_CONDITION_OPERAND_TYPES)[number];

export interface CompiledStaticChildPlanClosureMemberV1 extends JsonObject {
  closure_key: string;
  parent_closure_key: string | null;
  scope_key: string;
  owner_node_path: string[];
  factory_kind: 'inline' | 'template';
  source_ref: VersionedRef | null;
  source_hash: Sha256Hash;
  plan_ref: string;
  plan_hash: Sha256Hash;
  interface_snapshot_hash: Sha256Hash;
  member_hash: Sha256Hash;
}

export interface CompiledStaticChildPlanClosureV1 extends JsonObject {
  members: CompiledStaticChildPlanClosureMemberV1[];
  member_count: number;
  closure_hash: Sha256Hash;
}

export interface CompiledScopePlanV2Document extends Omit<
  CompiledScopePlanDocument,
  'format' | 'static_child_plan_closure_hash'
> {
  [key: string]: JsonValue;
  format: 'icarus.workflow-graph-scope-plan/2';
  static_child_plan_closure: CompiledStaticChildPlanClosureV1;
}

export interface DefinitionStaticLoweringContractV1 extends JsonObject {
  format: 'icarus.workflow-definition-static-lowering-contract/1';
  applies_to_state_types: Array<'delegation' | 'system'>;
  normal_named_exits: Array<'success' | 'failure'>;
  capability_terminal_routes: Array<{
    terminal_status: 'succeeded' | 'failed';
    named_exit: 'success' | 'failure';
    transition_slot: 'on_complete.success' | 'on_complete.failure';
  }>;
  engine_error: {
    scope_outcome_kind: 'errored';
    named_exit: null;
    transition_slot: 'on_error';
  };
  local_graph_cancel: {
    scope_outcome_kind: 'cancelled';
    reason: 'local_graph';
    named_exit: null;
    transition_slot: 'on_local_cancel';
  };
  global_workflow_cancel: {
    scope_outcome_kind: 'cancelled';
    reason: 'workflow';
    named_exit: null;
    transition_slot: null;
    disposition: 'terminate_workflow_without_state_transition';
  };
  contract_hash: Sha256Hash;
}

export interface CompilerConformanceDiagnosticV1 extends JsonObject {
  code: WorkflowCompilerErrorCode;
  phase: 'parse' | 'schema' | 'bind' | 'prove' | 'normalize' | 'hash';
  instance_pointer: string;
  schema_pointer: string | null;
  stable_object_id: string | null;
  detail_ref: string | null;
}

export type WorkflowCompilerConformanceCaseResultV1 =
  | (JsonObject & {
      format: 'icarus.workflow-compiler-conformance-case-result/1';
      case_id: string;
      source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
      source_hash: Sha256Hash;
      outcome: 'compiled';
      normalized_plan: CompiledScopePlanV2Document;
      static_lowering_contract_ref: VersionedRef | null;
      static_lowering_contract_hash: Sha256Hash | null;
      diagnostics: [];
      proof_hashes: Sha256Hash[];
      program_hashes: Sha256Hash[];
      result_hash: Sha256Hash;
    })
  | (JsonObject & {
      format: 'icarus.workflow-compiler-conformance-case-result/1';
      case_id: string;
      source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
      source_hash: Sha256Hash | null;
      outcome: 'rejected';
      normalized_plan: null;
      static_lowering_contract_ref: null;
      static_lowering_contract_hash: null;
      diagnostics: CompilerConformanceDiagnosticV1[];
      proof_hashes: Sha256Hash[];
      program_hashes: Sha256Hash[];
      result_hash: Sha256Hash;
    });

export interface CompilerG2CaseInputBindingEntryV1 extends JsonObject {
  case_id: string;
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  historical_input_snapshot_ref: string;
  historical_input_snapshot_hash: Sha256Hash;
  effective_case_input_hash: Sha256Hash;
}

export interface CompilerG2CaseInputBindingV1 extends JsonObject {
  format: 'icarus.workflow-compiler-g2-case-input-binding/1';
  binding_version: string;
  historical_g0_8_manifest_ref: string;
  historical_g0_8_manifest_hash: Sha256Hash;
  historical_case_catalog_ref: string;
  historical_case_catalog_hash: Sha256Hash;
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
  case_inputs: CompilerG2CaseInputBindingEntryV1[];
  binding_hash: Sha256Hash;
}

export interface CompilerG2CaseInputBindingRequirementV1 extends JsonObject {
  format: 'icarus.workflow-compiler-g2-case-input-binding-requirement/1';
  historical_g0_8_manifest_ref: string;
  historical_g0_8_manifest_hash: Sha256Hash;
  historical_case_catalog_ref: string;
  historical_case_catalog_hash: Sha256Hash;
  historical_input_snapshot_semantics: 'frozen_g0_stage_absence_not_g2_identity';
  resolved_binding_format: 'icarus.workflow-compiler-g2-case-input-binding/1';
  resolved_binding_schema_ref: string;
  resolved_binding_schema_hash: Sha256Hash;
  effective_case_input_domain_separator: string;
  binding_domain_separator: string;
  required_exact_identity_fields: string[];
  case_requirements: Array<{
    case_id: string;
    raw_source_bytes_ref: string;
    raw_source_bytes_hash: Sha256Hash;
    historical_input_snapshot_ref: string;
    historical_input_snapshot_hash: Sha256Hash;
    resolved_binding_ref: null;
    resolved_binding_hash: null;
    effective_case_input_hash: null;
    status: 'pending_exact_g2_identity';
  }>;
  resolution_status: 'pending_g2_compiler_implementation';
  review_barrier: 'blocked_until_resolved_binding_is_published';
  mutation_policy: 'publish_new_version_never_rewrite';
  requirement_hash: Sha256Hash;
}

export type CompilerSemanticAssertionOperator =
  | 'equals'
  | 'set_equals'
  | 'ordered_equals'
  | 'contains'
  | 'present'
  | 'absent';

export interface CompilerSemanticAssertionV2 extends JsonObject {
  assertion_id: string;
  subject_pointer: string;
  operator: CompilerSemanticAssertionOperator;
  expected: JsonValue;
  rationale: string;
}

export interface CompilerSemanticAssertionTargetV1 extends JsonObject {
  artifact_format: 'icarus.workflow-compiler-conformance-case-result/1';
  schema_ref: string;
  schema_hash: Sha256Hash;
  pointer_root: '';
  canonicalization: 'rfc8785_jcs';
  encoding: 'utf-8';
  canonical_bytes: 'jcs_full_result_including_result_hash';
  hash_field: 'result_hash';
  hash_preimage: 'jcs_result_without_result_hash';
  hash_domain_separator: string;
}

export interface GoldenDraftCaseV2 extends JsonObject {
  case_id: string;
  polarity: 'positive' | 'negative';
  source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  coverage_tags: string[];
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  historical_input_snapshot_ref: string;
  historical_input_snapshot_hash: Sha256Hash;
  expected_source_hash: Sha256Hash | null;
  g2_case_input_binding_ref: null;
  g2_case_input_binding_hash: null;
  expected_case_result_bytes_ref: null;
  expected_case_result_hash: null;
  expected_plan_hash: null;
  expected_proof_hashes: null;
  expected_program_hashes: null;
  expected_diagnostics: CompilerConformanceDiagnosticV1[];
  semantic_assertions: CompilerSemanticAssertionV2[];
  review_status: 'blocked_pending_exact_g2_identity';
  authored_by: 'codex:contract-repair-author';
}

export interface GoldenDraftCaseCatalogV2 extends JsonObject {
  format: 'icarus.workflow-compiler-golden-draft-cases/2';
  bundle_version: '2.0.0-contract-repair';
  historical_case_catalog_ref: string;
  historical_case_catalog_hash: Sha256Hash;
  assertion_target: CompilerSemanticAssertionTargetV1;
  cases: GoldenDraftCaseV2[];
  positive_case_count: number;
  negative_case_count: number;
  catalog_hash: Sha256Hash;
}

export interface GoldenDraftManifestV2 extends JsonObject {
  format: 'icarus.workflow-compiler-golden-draft-manifest/2';
  bundle_version: '2.0.0-contract-repair';
  draft_status: 'blocked_pending_exact_g2_identity';
  historical_g0_8_manifest_ref: string;
  historical_g0_8_manifest_hash: Sha256Hash;
  case_catalog_ref: string;
  case_catalog_hash: Sha256Hash;
  case_input_binding_requirement_ref: string;
  case_input_binding_requirement_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
  static_lowering_contract_ref: string;
  static_lowering_contract_hash: Sha256Hash;
  positive_case_count: number;
  negative_case_count: number;
  exact_g2_identity_status: 'absent_pending_implementation';
  expected_case_result_status: 'all_null';
  golden_semantic_review_status: 'absent';
  sealed_bundle_status: 'absent';
  next_required_draft_version: 'new_version_with_resolved_exact_g2_identity';
  manifest_hash: Sha256Hash;
}

export const COMPILER_G2_EXACT_IDENTITY_FIELDS = [
  'compiler_toolchain_manifest_ref',
  'compiler_toolchain_hash',
  'compiler_version',
  'compiler_build_hash',
  'canonical_normalizer_version',
  'canonical_normalizer_hash',
  'proof_algorithm_version',
  'proof_algorithm_hash',
  'error_catalog_ref',
  'error_catalog_hash',
  'compiled_ir_schema_ref',
  'compiled_ir_schema_hash',
  'conformance_result_schema_ref',
  'conformance_result_schema_hash',
] as const satisfies readonly (keyof CompilerG2CaseInputBindingV1)[];
