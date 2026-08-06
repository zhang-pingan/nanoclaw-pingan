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
  'static_child_plan_closure'
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
