import type { JsonValue } from './types.js';

export interface CatalogProtocolPositiveCase {
  case_id: string;
  artifact_format: string;
  assertion: 'valid_exact_artifact';
}

export type CatalogProtocolMutation =
  | { operation: 'remove'; pointer: string }
  | { operation: 'replace'; pointer: string; value: JsonValue }
  | { operation: 'append'; pointer: string; value: JsonValue };

export interface CatalogProtocolNegativeCase {
  case_id: string;
  artifact_format: string;
  mutation: CatalogProtocolMutation;
  expected_code: 'catalog_protocol_contract_drift';
}

export const CATALOG_PROTOCOL_POSITIVE_CASES = [
  {
    case_id: 'compiler_error_catalog_exact',
    artifact_format: 'icarus.workflow-compiler-error-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_fact_catalog_exact',
    artifact_format: 'icarus.workflow-runtime-fact-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_event_catalog_exact',
    artifact_format: 'icarus.workflow-runtime-event-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_permission_catalog_exact',
    artifact_format: 'icarus.workflow-runtime-permission-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_command_reason_catalog_exact',
    artifact_format: 'icarus.workflow-runtime-command-reason-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_command_denial_catalog_exact',
    artifact_format: 'icarus.workflow-runtime-command-denial-catalog/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_state_transition_tables_exact',
    artifact_format: 'icarus.workflow-runtime-state-transition-tables/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'runtime_command_protocol_table_exact',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    assertion: 'valid_exact_artifact',
  },
  {
    case_id: 'run_transaction_protocol_table_exact',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    assertion: 'valid_exact_artifact',
  },
] as const satisfies readonly CatalogProtocolPositiveCase[];

export const CATALOG_PROTOCOL_NEGATIVE_CASES = [
  {
    case_id: 'error_catalog_rejects_missing_code',
    artifact_format: 'icarus.workflow-compiler-error-catalog/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/json_syntax_invalid',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'error_catalog_rejects_wrong_phase',
    artifact_format: 'icarus.workflow-compiler-error-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/compiler_integrity_mismatch/default_phase',
      value: 'parse',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'fact_catalog_rejects_unknown_kind',
    artifact_format: 'icarus.workflow-runtime-fact-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/fact_kind',
      value: 'unknown_fact',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'fact_catalog_rejects_rank_drift',
    artifact_format: 'icarus.workflow-runtime-fact-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/1/fact_kind_rank',
      value: 0,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'event_catalog_rejects_fact_mapping_drift',
    artifact_format: 'icarus.workflow-runtime-event-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/fact_kind',
      value: null,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'event_catalog_rejects_audit_event_as_fact',
    artifact_format: 'icarus.workflow-runtime-event-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/13/event_class',
      value: 'fact_backed',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'permission_catalog_rejects_unknown_permission',
    artifact_format: 'icarus.workflow-runtime-permission-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/permission',
      value: 'workflow.admin',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'permission_catalog_rejects_feature_integrity_restore',
    artifact_format: 'icarus.workflow-runtime-permission-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/7/feature_human_ceiling_allowed',
      value: true,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'reason_catalog_rejects_open_reason',
    artifact_format: 'icarus.workflow-runtime-command-reason-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/reason_code',
      value: 'because_operator_said_so',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'reason_catalog_rejects_system_deadline_as_human',
    artifact_format: 'icarus.workflow-runtime-command-reason-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/12/allowed_actor_kinds/0',
      value: 'human',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'denial_catalog_rejects_target_mutation',
    artifact_format: 'icarus.workflow-runtime-command-denial-catalog/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/target_mutated',
      value: true,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'state_table_rejects_reverse_run_lifecycle',
    artifact_format: 'icarus.workflow-runtime-state-transition-tables/1',
    mutation: {
      operation: 'append',
      pointer: '/machines/2/transitions',
      value: {
        from: 'closed',
        to: 'executing',
        protocols: ['T8'],
        guard: 'reopen',
      },
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'state_table_rejects_terminal_node_reopen',
    artifact_format: 'icarus.workflow-runtime-state-transition-tables/1',
    mutation: {
      operation: 'append',
      pointer: '/machines/6/transitions',
      value: {
        from: 'terminal',
        to: 'ready',
        protocols: ['COMMAND'],
        guard: 'manual_retry',
      },
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_target_kind_drift',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/0/target_kind',
      value: 'workflow',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_open_reason',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'append',
      pointer: '/entries/0/allowed_reason_codes',
      value: 'free_text_reason',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_abandon_without_evidence',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/11/minimum_evidence_refs',
      value: 0,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_confirmation_ref_optional',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/12/confirmation_ref_required',
      value: false,
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_deadline_key_template_removal',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/3/system_grant/idempotency_key_template',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_deadline_invocation_audit_removal',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/3/system_grant/invocation_audit',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'command_table_rejects_manual_retry_handoff_removal',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/5/primitive_handoff',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'transaction_table_rejects_missing_t6e',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/13',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'transaction_table_rejects_t5_external_work_inside',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    mutation: {
      operation: 'replace',
      pointer: '/entries/8/external_work_boundary',
      value: 'none',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'transaction_table_rejects_t8_partial_child_creation',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/17/forbidden/0',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'transaction_table_rejects_t6d_deadline_command_reintroduction',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    mutation: {
      operation: 'append',
      pointer: '/entries/12/atomic_writes',
      value: 'stable_workflow_deadline_t7c_command',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
  {
    case_id: 'transaction_table_rejects_t7c_deadline_key_removal',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    mutation: {
      operation: 'remove',
      pointer: '/entries/16/idempotency_constraints/2',
    },
    expected_code: 'catalog_protocol_contract_drift',
  },
] as const satisfies readonly CatalogProtocolNegativeCase[];
