import {
  WORKFLOW_COMMAND_REASON_CODES,
  WORKFLOW_COMMAND_TYPES,
  type WorkflowCommandReasonCode,
  type WorkflowCommandType,
} from './closed-schema-types.js';

export const COMPILER_DIAGNOSTIC_PHASES = [
  'parse',
  'schema',
  'bind',
  'prove',
  'normalize',
  'hash',
] as const;
export type CompilerDiagnosticPhase =
  (typeof COMPILER_DIAGNOSTIC_PHASES)[number];

export const COMPILER_ERROR_RETRYABILITIES = [
  'source_revision_required',
  'registry_revision_required',
  'never',
] as const;
export type CompilerErrorRetryability =
  (typeof COMPILER_ERROR_RETRYABILITIES)[number];

export const WORKFLOW_COMPILER_ERROR_CODES = [
  'json_syntax_invalid',
  'json_duplicate_key',
  'schema_unknown_field',
  'schema_profile_keyword_unsupported',
  'registry_ref_unpinned',
  'registry_ref_not_found',
  'graph_id_duplicate',
  'graph_endpoint_not_found',
  'graph_cross_scope_edge',
  'graph_dependency_cycle',
  'condition_type_mismatch',
  'condition_complexity_exceeded',
  'json_pointer_non_total',
  'schema_not_assignable',
  'route_group_ambiguous',
  'trigger_contract_invalid',
  'completion_contract_invalid',
  'early_completion_non_monotone',
  'early_completion_cancellation_unsafe',
  'capability_not_allowed',
  'policy_escalation',
  'quality_revision_contract_invalid',
  'quality_revision_effect_key_incompatible',
  'child_recipe_set_mismatch',
  'child_recipe_dependency_cycle',
  'runtime_safety_limit_exceeded',
  'compiler_integrity_mismatch',
] as const;
export type WorkflowCompilerErrorCode =
  (typeof WORKFLOW_COMPILER_ERROR_CODES)[number];

export interface CompilerErrorCatalogEntry {
  code: WorkflowCompilerErrorCode;
  retryability: CompilerErrorRetryability;
  default_phase: CompilerDiagnosticPhase;
}

export const COMPILER_ERROR_CATALOG_ENTRIES = [
  {
    code: 'json_syntax_invalid',
    retryability: 'source_revision_required',
    default_phase: 'parse',
  },
  {
    code: 'json_duplicate_key',
    retryability: 'source_revision_required',
    default_phase: 'parse',
  },
  {
    code: 'schema_unknown_field',
    retryability: 'source_revision_required',
    default_phase: 'schema',
  },
  {
    code: 'schema_profile_keyword_unsupported',
    retryability: 'source_revision_required',
    default_phase: 'schema',
  },
  {
    code: 'registry_ref_unpinned',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'registry_ref_not_found',
    retryability: 'registry_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'graph_id_duplicate',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'graph_endpoint_not_found',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'graph_cross_scope_edge',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'graph_dependency_cycle',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'condition_type_mismatch',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'condition_complexity_exceeded',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'json_pointer_non_total',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'schema_not_assignable',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'route_group_ambiguous',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'trigger_contract_invalid',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'completion_contract_invalid',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'early_completion_non_monotone',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'early_completion_cancellation_unsafe',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'capability_not_allowed',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'policy_escalation',
    retryability: 'source_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'quality_revision_contract_invalid',
    retryability: 'registry_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'quality_revision_effect_key_incompatible',
    retryability: 'registry_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'child_recipe_set_mismatch',
    retryability: 'registry_revision_required',
    default_phase: 'bind',
  },
  {
    code: 'child_recipe_dependency_cycle',
    retryability: 'registry_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'runtime_safety_limit_exceeded',
    retryability: 'source_revision_required',
    default_phase: 'prove',
  },
  {
    code: 'compiler_integrity_mismatch',
    retryability: 'never',
    default_phase: 'hash',
  },
] as const satisfies readonly CompilerErrorCatalogEntry[];

export const RUNTIME_FACT_KINDS = [
  'node_terminal',
  'node_output_published',
  'wait_resolved',
  'build_failed',
  'control_edge_resolved',
  'data_edge_resolved',
  'trigger_decided',
  'input_sealed',
  'node_ready',
  'node_skipped',
  'terminal_candidate',
  'completion_eligibility',
  'orchestration_error',
] as const;
export type RuntimeFactKind = (typeof RUNTIME_FACT_KINDS)[number];

export interface RuntimeFactCatalogEntry {
  fact_kind: RuntimeFactKind;
  fact_kind_rank: number;
  stable_object_kind: string;
  producer_protocols: readonly string[];
  ingress: boolean;
}

export const RUNTIME_FACT_CATALOG_ENTRIES = [
  {
    fact_kind: 'orchestration_error',
    fact_kind_rank: 0,
    stable_object_kind: 'orchestration_error',
    producer_protocols: ['T2a', 'T3a', 'T3b', 'T7a'],
    ingress: true,
  },
  {
    fact_kind: 'node_output_published',
    fact_kind_rank: 10,
    stable_object_kind: 'node',
    producer_protocols: ['T3a', 'T6a', 'T7b'],
    ingress: true,
  },
  {
    fact_kind: 'node_terminal',
    fact_kind_rank: 20,
    stable_object_kind: 'node',
    producer_protocols: ['T3a', 'T4', 'T6a', 'T6c', 'T7a', 'T7b'],
    ingress: true,
  },
  {
    fact_kind: 'wait_resolved',
    fact_kind_rank: 30,
    stable_object_kind: 'wait',
    producer_protocols: ['T6c'],
    ingress: true,
  },
  {
    fact_kind: 'build_failed',
    fact_kind_rank: 40,
    stable_object_kind: 'scope_build',
    producer_protocols: ['T2a'],
    ingress: true,
  },
  {
    fact_kind: 'control_edge_resolved',
    fact_kind_rank: 50,
    stable_object_kind: 'control_edge',
    producer_protocols: ['T3a'],
    ingress: false,
  },
  {
    fact_kind: 'data_edge_resolved',
    fact_kind_rank: 60,
    stable_object_kind: 'data_edge',
    producer_protocols: ['T3a'],
    ingress: false,
  },
  {
    fact_kind: 'trigger_decided',
    fact_kind_rank: 70,
    stable_object_kind: 'node',
    producer_protocols: ['T3a'],
    ingress: false,
  },
  {
    fact_kind: 'input_sealed',
    fact_kind_rank: 80,
    stable_object_kind: 'node',
    producer_protocols: ['T3a'],
    ingress: false,
  },
  {
    fact_kind: 'node_ready',
    fact_kind_rank: 90,
    stable_object_kind: 'node',
    producer_protocols: ['T3a'],
    ingress: false,
  },
  {
    fact_kind: 'node_skipped',
    fact_kind_rank: 100,
    stable_object_kind: 'node',
    producer_protocols: ['T3a', 'T7a'],
    ingress: false,
  },
  {
    fact_kind: 'terminal_candidate',
    fact_kind_rank: 110,
    stable_object_kind: 'terminal_candidate',
    producer_protocols: ['T3a', 'T4'],
    ingress: false,
  },
  {
    fact_kind: 'completion_eligibility',
    fact_kind_rank: 120,
    stable_object_kind: 'completion_eligibility',
    producer_protocols: ['T3a', 'T3b'],
    ingress: false,
  },
] as const satisfies readonly RuntimeFactCatalogEntry[];

export const RUNTIME_AUDIT_EVENT_TYPES = [
  'workflow_created',
  'state_activation_created',
  'run_created',
  'scope_materialized',
  'expansion_sealed',
  'scheduler_admitted',
  'attempt_created',
  'attempt_phase_changed',
  'retry_schedule_created',
  'retry_schedule_consumed',
  'wait_armed',
  'scope_close_requested',
  'subtree_fenced',
  'effect_operation_changed',
  'compensation_changed',
  'completion_cut_committed',
  'child_completion_consumed',
  'run_control_changed',
  'operational_blocker_changed',
  'runtime_command_decided',
  'workflow_transition_committed',
  'workflow_terminal_committed',
  'root_finalization_changed',
  'domain_claim_changed',
  'ledger_posting_committed',
  'recovery_decision_recorded',
] as const;
export type RuntimeAuditEventType = (typeof RUNTIME_AUDIT_EVENT_TYPES)[number];
export type RuntimeEventType = RuntimeFactKind | RuntimeAuditEventType;

export interface RuntimeEventCatalogEntry {
  event_type: RuntimeEventType;
  event_class: 'fact_backed' | 'audit_only';
  fact_kind: RuntimeFactKind | null;
  producer_protocols: readonly string[];
}

const auditEventProducerProtocols: Record<
  RuntimeAuditEventType,
  readonly string[]
> = {
  workflow_created: ['T0', 'T8'],
  state_activation_created: ['T0', 'T1', 'T8'],
  run_created: ['T0', 'T1', 'T8'],
  scope_materialized: ['T2b'],
  expansion_sealed: ['T4'],
  scheduler_admitted: ['T4'],
  attempt_created: ['T4', 'T6d'],
  attempt_phase_changed: ['T5', 'T6a', 'T6b', 'T6d', 'T7a'],
  retry_schedule_created: ['T6a'],
  retry_schedule_consumed: ['T6d'],
  wait_armed: ['T4'],
  scope_close_requested: ['T3a', 'T3b', 'T7a', 'T7c'],
  subtree_fenced: ['T7a'],
  effect_operation_changed: ['T5', 'T6d', 'T6e', 'T7a'],
  compensation_changed: ['T6e', 'T7a', 'T7b'],
  completion_cut_committed: ['T7b', 'T8'],
  child_completion_consumed: ['T7b'],
  run_control_changed: ['COMMAND', 'RECOVERY', 'T7c'],
  operational_blocker_changed: ['OUTBOX', 'RECOVERY', 'T6d', 'T6e', 'T7a'],
  runtime_command_decided: ['COMMAND', 'T6e', 'T7c'],
  workflow_transition_committed: ['T8'],
  workflow_terminal_committed: ['COMMAND', 'T8'],
  root_finalization_changed: ['T0p', 'T6e', 'T8'],
  domain_claim_changed: ['OUTBOX', 'T0', 'T6e', 'T8'],
  ledger_posting_committed: ['T0', 'T1', 'T2b', 'T3a', 'T4', 'T6a', 'T8'],
  recovery_decision_recorded: ['RECOVERY'],
};

export const RUNTIME_EVENT_CATALOG_ENTRIES: readonly RuntimeEventCatalogEntry[] =
  [
    ...RUNTIME_FACT_KINDS.map((factKind) => ({
      event_type: factKind,
      event_class: 'fact_backed' as const,
      fact_kind: factKind,
      producer_protocols: RUNTIME_FACT_CATALOG_ENTRIES.find(
        (entry) => entry.fact_kind === factKind,
      )!.producer_protocols,
    })),
    ...RUNTIME_AUDIT_EVENT_TYPES.map((eventType) => ({
      event_type: eventType,
      event_class: 'audit_only' as const,
      fact_kind: null,
      producer_protocols: auditEventProducerProtocols[eventType],
    })),
  ];

export const RUNTIME_PERMISSION_CODES = [
  'workflow.operate',
  'workflow.cancel.own',
  'workflow.cancel.any',
  'workflow.node.skip',
  'workflow.retry.advance',
  'workflow.effect.remediate',
  'workflow.blocker.remediate',
  'workflow.integrity.restore',
  'workflow.administrative_abandon',
] as const;
export type RuntimePermissionCode = (typeof RUNTIME_PERMISSION_CODES)[number];

export interface RuntimePermissionCatalogEntry {
  permission: RuntimePermissionCode;
  human_local_owner: boolean;
  feature_human_ceiling_allowed: boolean;
  feature_service_or_automation_grantable: boolean;
  ownership_required: boolean;
}

export const RUNTIME_PERMISSION_CATALOG_ENTRIES = [
  {
    permission: 'workflow.operate',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.cancel.own',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: true,
    ownership_required: true,
  },
  {
    permission: 'workflow.cancel.any',
    human_local_owner: true,
    feature_human_ceiling_allowed: false,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.node.skip',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.retry.advance',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.effect.remediate',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.blocker.remediate',
    human_local_owner: true,
    feature_human_ceiling_allowed: true,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.integrity.restore',
    human_local_owner: true,
    feature_human_ceiling_allowed: false,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
  {
    permission: 'workflow.administrative_abandon',
    human_local_owner: true,
    feature_human_ceiling_allowed: false,
    feature_service_or_automation_grantable: false,
    ownership_required: false,
  },
] as const satisfies readonly RuntimePermissionCatalogEntry[];

export const RUNTIME_COMMAND_DENIAL_CODES = [
  'permission_denied',
  'feature_ceiling_denied',
  'command_policy_denied',
  'state_guard_failed',
  'target_not_found',
  'target_kind_invalid',
  'row_version_conflict',
  'evidence_invalid',
  'confirmation_required',
  'idempotency_conflict',
  'late_command',
] as const;
export type RuntimeCommandDenialCode =
  (typeof RUNTIME_COMMAND_DENIAL_CODES)[number];

export const COMMAND_ACTOR_KINDS = [
  'human',
  'feature_service',
  'automation',
  'system',
] as const;
export type CommandActorKind = (typeof COMMAND_ACTOR_KINDS)[number];

export interface RuntimeCommandReasonCatalogEntry {
  reason_code: WorkflowCommandReasonCode;
  reason_class:
    | 'operator'
    | 'business'
    | 'remediation'
    | 'integrity'
    | 'system_enforcement'
    | 'administrative_abandon';
  allowed_actor_kinds: readonly CommandActorKind[];
  evidence_required: boolean;
}

export const RUNTIME_COMMAND_REASON_CATALOG_ENTRIES = [
  {
    reason_code: 'operator_requested',
    reason_class: 'operator',
    allowed_actor_kinds: ['human'],
    evidence_required: false,
  },
  {
    reason_code: 'investigation',
    reason_class: 'operator',
    allowed_actor_kinds: ['human'],
    evidence_required: false,
  },
  {
    reason_code: 'superseded',
    reason_class: 'business',
    allowed_actor_kinds: ['human', 'feature_service', 'automation'],
    evidence_required: false,
  },
  {
    reason_code: 'invalid_input',
    reason_class: 'business',
    allowed_actor_kinds: ['human', 'feature_service', 'automation'],
    evidence_required: false,
  },
  {
    reason_code: 'no_longer_needed',
    reason_class: 'business',
    allowed_actor_kinds: ['human', 'feature_service', 'automation'],
    evidence_required: false,
  },
  {
    reason_code: 'dependency_recovered',
    reason_class: 'remediation',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'credential_restored',
    reason_class: 'remediation',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'receipt_recovered',
    reason_class: 'remediation',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'provider_reconciled',
    reason_class: 'remediation',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'not_applied_verified',
    reason_class: 'remediation',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'backup_restored',
    reason_class: 'integrity',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'hash_revalidated',
    reason_class: 'integrity',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'deadline_enforced',
    reason_class: 'system_enforcement',
    allowed_actor_kinds: ['system'],
    evidence_required: true,
  },
  {
    reason_code: 'safety_enforced',
    reason_class: 'system_enforcement',
    allowed_actor_kinds: ['system'],
    evidence_required: true,
  },
  {
    reason_code: 'unrecoverable_state',
    reason_class: 'administrative_abandon',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'external_effect_unverifiable',
    reason_class: 'administrative_abandon',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
  {
    reason_code: 'data_loss_accepted',
    reason_class: 'administrative_abandon',
    allowed_actor_kinds: ['human'],
    evidence_required: true,
  },
] as const satisfies readonly RuntimeCommandReasonCatalogEntry[];

export interface RuntimeCommandDenialCatalogEntry {
  denial_code: RuntimeCommandDenialCode;
  execution_result: 'denied' | 'conflict' | 'late';
  retry_disposition:
    | 'request_revision'
    | 'state_refresh'
    | 'authorization_change'
    | 'confirmation_flow'
    | 'new_idempotency_key'
    | 'never';
  target_mutated: false;
}

export const RUNTIME_COMMAND_DENIAL_CATALOG_ENTRIES = [
  {
    denial_code: 'permission_denied',
    execution_result: 'denied',
    retry_disposition: 'authorization_change',
    target_mutated: false,
  },
  {
    denial_code: 'feature_ceiling_denied',
    execution_result: 'denied',
    retry_disposition: 'authorization_change',
    target_mutated: false,
  },
  {
    denial_code: 'command_policy_denied',
    execution_result: 'denied',
    retry_disposition: 'authorization_change',
    target_mutated: false,
  },
  {
    denial_code: 'state_guard_failed',
    execution_result: 'denied',
    retry_disposition: 'state_refresh',
    target_mutated: false,
  },
  {
    denial_code: 'target_not_found',
    execution_result: 'denied',
    retry_disposition: 'never',
    target_mutated: false,
  },
  {
    denial_code: 'target_kind_invalid',
    execution_result: 'denied',
    retry_disposition: 'request_revision',
    target_mutated: false,
  },
  {
    denial_code: 'row_version_conflict',
    execution_result: 'conflict',
    retry_disposition: 'state_refresh',
    target_mutated: false,
  },
  {
    denial_code: 'evidence_invalid',
    execution_result: 'denied',
    retry_disposition: 'request_revision',
    target_mutated: false,
  },
  {
    denial_code: 'confirmation_required',
    execution_result: 'denied',
    retry_disposition: 'confirmation_flow',
    target_mutated: false,
  },
  {
    denial_code: 'idempotency_conflict',
    execution_result: 'conflict',
    retry_disposition: 'new_idempotency_key',
    target_mutated: false,
  },
  {
    denial_code: 'late_command',
    execution_result: 'late',
    retry_disposition: 'never',
    target_mutated: false,
  },
] as const satisfies readonly RuntimeCommandDenialCatalogEntry[];

export const CATALOG_PROTOCOL_CLOSED_UNIONS = {
  compiler_diagnostic_phases: COMPILER_DIAGNOSTIC_PHASES,
  compiler_error_retryabilities: COMPILER_ERROR_RETRYABILITIES,
  compiler_error_codes: WORKFLOW_COMPILER_ERROR_CODES,
  fact_kinds: RUNTIME_FACT_KINDS,
  audit_event_types: RUNTIME_AUDIT_EVENT_TYPES,
  permission_codes: RUNTIME_PERMISSION_CODES,
  command_types: WORKFLOW_COMMAND_TYPES,
  command_reason_codes: WORKFLOW_COMMAND_REASON_CODES,
  command_denial_codes: RUNTIME_COMMAND_DENIAL_CODES,
  command_actor_kinds: COMMAND_ACTOR_KINDS,
} as const;

export type { WorkflowCommandReasonCode, WorkflowCommandType };
