import {
  RUNTIME_COMMAND_DENIAL_CODES,
  type CommandActorKind,
  type RuntimeCommandDenialCode,
  type RuntimePermissionCode,
  type WorkflowCommandReasonCode,
  type WorkflowCommandType,
} from './catalog-protocol-types.js';

export const RUNTIME_COMMAND_TARGET_KINDS = [
  'workflow',
  'run',
  'node',
  'retry_schedule',
  'effect_operation',
  'operational_blocker',
] as const;
export type RuntimeCommandTargetKind =
  (typeof RUNTIME_COMMAND_TARGET_KINDS)[number];

export interface StateMachineValue {
  value: string;
  terminal: boolean;
}

export interface StateMachineTransition {
  from: string;
  to: string;
  protocols: readonly string[];
  guard: string;
}

export interface RuntimeStateMachine {
  machine_id: string;
  field: string;
  initial_values: readonly string[];
  values: readonly StateMachineValue[];
  transitions: readonly StateMachineTransition[];
}

function values(
  states: readonly string[],
  terminalStates: readonly string[],
): StateMachineValue[] {
  const terminal = new Set(terminalStates);
  return states.map((value) => ({ value, terminal: terminal.has(value) }));
}

export const RUNTIME_STATE_MACHINES = [
  {
    machine_id: 'workflow_status',
    field: 'workflows.status',
    initial_values: ['active'],
    values: values(
      [
        'active',
        'completed',
        'errored',
        'cancelled',
        'administratively_abandoned',
      ],
      ['completed', 'errored', 'cancelled', 'administratively_abandoned'],
    ),
    transitions: [
      {
        from: 'active',
        to: 'completed',
        protocols: ['T8'],
        guard: 'terminal_normal_transition_committed',
      },
      {
        from: 'active',
        to: 'errored',
        protocols: ['T8'],
        guard: 'terminal_error_transition_committed',
      },
      {
        from: 'active',
        to: 'cancelled',
        protocols: ['T8'],
        guard: 'global_workflow_cancel_committed',
      },
      {
        from: 'active',
        to: 'administratively_abandoned',
        protocols: ['COMMAND'],
        guard: 'confirmed_administrative_abandon',
      },
    ],
  },
  {
    machine_id: 'state_activation_status',
    field: 'workflow_state_activations.status',
    initial_values: ['active', 'completed'],
    values: values(
      ['active', 'completed', 'abandoned'],
      ['completed', 'abandoned'],
    ),
    transitions: [
      {
        from: 'active',
        to: 'completed',
        protocols: ['T8'],
        guard: 'source_activation_consumed_or_terminal_activation_created',
      },
      {
        from: 'active',
        to: 'abandoned',
        protocols: ['COMMAND'],
        guard: 'non_terminal_activation_administratively_abandoned',
      },
    ],
  },
  {
    machine_id: 'run_lifecycle',
    field: 'workflow_graph_runs.lifecycle',
    initial_values: ['initializing'],
    values: values(
      ['initializing', 'executing', 'closing', 'closed'],
      ['closed'],
    ),
    transitions: [
      {
        from: 'initializing',
        to: 'executing',
        protocols: ['T2b'],
        guard: 'root_scope_materialized',
      },
      {
        from: 'initializing',
        to: 'closing',
        protocols: ['T7a'],
        guard: 'root_setup_error_or_cancel_wins',
      },
      {
        from: 'executing',
        to: 'closing',
        protocols: ['T7a'],
        guard: 'root_close_request_wins',
      },
      {
        from: 'closing',
        to: 'closed',
        protocols: ['T8'],
        guard: 'root_cut_and_outer_transition_commit',
      },
    ],
  },
  {
    machine_id: 'run_control',
    field: 'workflow_graph_runs.control',
    initial_values: ['running'],
    values: values(
      ['running', 'paused', 'resuming', 'cancelling'],
      ['cancelling'],
    ),
    transitions: [
      {
        from: 'running',
        to: 'paused',
        protocols: ['COMMAND'],
        guard: 'pause_command_applied',
      },
      {
        from: 'paused',
        to: 'resuming',
        protocols: ['COMMAND'],
        guard: 'resume_command_applied',
      },
      {
        from: 'resuming',
        to: 'running',
        protocols: ['RECOVERY'],
        guard: 'resume_drain_reaches_fixed_point',
      },
      {
        from: 'running',
        to: 'cancelling',
        protocols: ['T7c'],
        guard: 'cancel_close_request_wins',
      },
      {
        from: 'paused',
        to: 'cancelling',
        protocols: ['T7c'],
        guard: 'cancel_close_request_wins',
      },
      {
        from: 'resuming',
        to: 'cancelling',
        protocols: ['T7c'],
        guard: 'cancel_close_request_wins',
      },
    ],
  },
  {
    machine_id: 'run_operational_state',
    field: 'workflow_graph_runs.operational_state',
    initial_values: ['healthy'],
    values: values(
      [
        'healthy',
        'action_required',
        'quarantined',
        'administratively_abandoned',
      ],
      ['administratively_abandoned'],
    ),
    transitions: [
      {
        from: 'healthy',
        to: 'action_required',
        protocols: ['BLOCKER_TRIGGER'],
        guard: 'highest_open_blocker_severity_action_required',
      },
      {
        from: 'healthy',
        to: 'quarantined',
        protocols: ['BLOCKER_TRIGGER'],
        guard: 'highest_open_blocker_severity_quarantine',
      },
      {
        from: 'action_required',
        to: 'quarantined',
        protocols: ['BLOCKER_TRIGGER'],
        guard: 'quarantine_blocker_opened',
      },
      {
        from: 'action_required',
        to: 'healthy',
        protocols: ['T6e'],
        guard: 'last_open_blocker_resolved',
      },
      {
        from: 'quarantined',
        to: 'action_required',
        protocols: ['T6e'],
        guard: 'integrity_restored_and_action_required_blocker_remains',
      },
      {
        from: 'quarantined',
        to: 'healthy',
        protocols: ['T6e'],
        guard: 'integrity_restored_and_no_open_blocker_remains',
      },
      {
        from: 'healthy',
        to: 'administratively_abandoned',
        protocols: ['COMMAND'],
        guard: 'confirmed_administrative_abandon',
      },
      {
        from: 'action_required',
        to: 'administratively_abandoned',
        protocols: ['COMMAND'],
        guard: 'confirmed_administrative_abandon',
      },
      {
        from: 'quarantined',
        to: 'administratively_abandoned',
        protocols: ['COMMAND'],
        guard: 'confirmed_administrative_abandon',
      },
    ],
  },
  {
    machine_id: 'scope_lifecycle',
    field: 'workflow_graph_scopes.lifecycle',
    initial_values: ['materializing'],
    values: values(
      ['materializing', 'active', 'closing', 'closed'],
      ['closed'],
    ),
    transitions: [
      {
        from: 'materializing',
        to: 'active',
        protocols: ['T2b'],
        guard: 'scope_materialization_committed',
      },
      {
        from: 'materializing',
        to: 'closing',
        protocols: ['T7a'],
        guard: 'root_setup_error_or_cancel_wins',
      },
      {
        from: 'active',
        to: 'closing',
        protocols: ['T7a'],
        guard: 'scope_close_request_wins',
      },
      {
        from: 'closing',
        to: 'closed',
        protocols: ['T7b', 'T8'],
        guard: 'completion_cut_committed_after_cleanup_barrier',
      },
    ],
  },
  {
    machine_id: 'node_phase',
    field: 'workflow_graph_nodes.phase',
    initial_values: ['pending'],
    values: values(
      ['pending', 'ready', 'active', 'waiting', 'retry_wait', 'terminal'],
      ['terminal'],
    ),
    transitions: [
      {
        from: 'pending',
        to: 'ready',
        protocols: ['T3a'],
        guard: 'trigger_true_and_inputs_sealed',
      },
      {
        from: 'pending',
        to: 'terminal',
        protocols: ['T3a', 'T7a'],
        guard: 'trigger_or_input_impossible_or_fenced',
      },
      {
        from: 'ready',
        to: 'active',
        protocols: ['T4'],
        guard: 'kind_activation_committed',
      },
      {
        from: 'ready',
        to: 'terminal',
        protocols: ['COMMAND', 'T7a'],
        guard: 'manual_skip_or_fence',
      },
      {
        from: 'active',
        to: 'waiting',
        protocols: ['T4'],
        guard: 'wait_armed',
      },
      {
        from: 'active',
        to: 'retry_wait',
        protocols: ['T6a'],
        guard: 'continuation_schedule_created',
      },
      {
        from: 'active',
        to: 'terminal',
        protocols: ['T4', 'T6a', 'T7a', 'T7b'],
        guard: 'node_outcome_or_fence_committed',
      },
      {
        from: 'waiting',
        to: 'terminal',
        protocols: ['T6c', 'T7a'],
        guard: 'wait_resolution_or_fence_wins',
      },
      {
        from: 'retry_wait',
        to: 'active',
        protocols: ['T6d'],
        guard: 'retry_schedule_consumed',
      },
      {
        from: 'retry_wait',
        to: 'terminal',
        protocols: ['T7a'],
        guard: 'scope_fence_wins',
      },
    ],
  },
  {
    machine_id: 'node_trigger_state',
    field: 'workflow_graph_nodes.trigger_state',
    initial_values: ['unknown'],
    values: values(
      ['unknown', 'true', 'false', 'error'],
      ['true', 'false', 'error'],
    ),
    transitions: ['true', 'false', 'error'].map((to) => ({
      from: 'unknown',
      to,
      protocols: ['T3a'],
      guard: 'trigger_program_decided',
    })),
  },
  {
    machine_id: 'node_input_state',
    field: 'workflow_graph_nodes.input_state',
    initial_values: ['open'],
    values: values(
      ['open', 'sealed', 'impossible', 'error'],
      ['sealed', 'impossible', 'error'],
    ),
    transitions: ['sealed', 'impossible', 'error'].map((to) => ({
      from: 'open',
      to,
      protocols: ['T3a'],
      guard: 'input_aggregation_decided',
    })),
  },
  {
    machine_id: 'attempt_phase',
    field: 'workflow_graph_node_attempts.phase',
    initial_values: ['preparing'],
    values: values(
      ['preparing', 'dispatch_pending', 'running', 'evaluating', 'terminal'],
      ['terminal'],
    ),
    transitions: [
      {
        from: 'preparing',
        to: 'dispatch_pending',
        protocols: ['T5'],
        guard: 'external_dispatch_intent_committed',
      },
      {
        from: 'preparing',
        to: 'running',
        protocols: ['T5'],
        guard: 'internal_execution_started',
      },
      {
        from: 'preparing',
        to: 'terminal',
        protocols: ['T7a'],
        guard: 'scope_fence_wins',
      },
      {
        from: 'dispatch_pending',
        to: 'running',
        protocols: ['T6b'],
        guard: 'provider_acceptance_committed',
      },
      {
        from: 'dispatch_pending',
        to: 'terminal',
        protocols: ['T6a', 'T6d', 'T7a'],
        guard: 'dispatch_failure_timeout_or_fence',
      },
      {
        from: 'running',
        to: 'evaluating',
        protocols: ['T6a'],
        guard: 'execution_succeeded_and_evaluator_required',
      },
      {
        from: 'running',
        to: 'terminal',
        protocols: ['T6a', 'T6d', 'T7a'],
        guard: 'execution_terminal_timeout_or_fence',
      },
      {
        from: 'evaluating',
        to: 'terminal',
        protocols: ['T6a', 'T7a'],
        guard: 'quality_decision_or_fence_committed',
      },
    ],
  },
  {
    machine_id: 'retry_schedule_status',
    field: 'workflow_graph_retry_schedules.status',
    initial_values: ['scheduled'],
    values: values(
      ['scheduled', 'consumed', 'cancelled'],
      ['consumed', 'cancelled'],
    ),
    transitions: [
      {
        from: 'scheduled',
        to: 'consumed',
        protocols: ['T6d'],
        guard: 'eligible_timer_or_authorized_advance_wins',
      },
      {
        from: 'scheduled',
        to: 'cancelled',
        protocols: ['T7a'],
        guard: 'scope_fence_wins',
      },
    ],
  },
  {
    machine_id: 'wait_status',
    field: 'workflow_graph_waits.status',
    initial_values: ['registering'],
    values: values(
      ['registering', 'armed', 'resolved', 'timed_out', 'cancelled'],
      ['resolved', 'timed_out', 'cancelled'],
    ),
    transitions: [
      {
        from: 'registering',
        to: 'armed',
        protocols: ['T4'],
        guard: 'wait_registration_committed',
      },
      {
        from: 'registering',
        to: 'cancelled',
        protocols: ['T7a'],
        guard: 'scope_fence_wins',
      },
      {
        from: 'armed',
        to: 'resolved',
        protocols: ['T6c'],
        guard: 'signal_or_timer_success_wins',
      },
      {
        from: 'armed',
        to: 'timed_out',
        protocols: ['T6c'],
        guard: 'timeout_wins',
      },
      {
        from: 'armed',
        to: 'cancelled',
        protocols: ['T6c', 'T7a'],
        guard: 'wait_cancel_or_scope_fence_wins',
      },
    ],
  },
  {
    machine_id: 'scope_build_status',
    field: 'workflow_graph_scope_builds.status',
    initial_values: ['pending_snapshot'],
    values: values(
      [
        'pending_snapshot',
        'ready_to_compile',
        'compiling',
        'compiled',
        'materialized',
        'failed',
        'fenced',
      ],
      ['materialized', 'failed', 'fenced'],
    ),
    transitions: [
      {
        from: 'pending_snapshot',
        to: 'ready_to_compile',
        protocols: ['T2a'],
        guard: 'source_snapshot_frozen',
      },
      {
        from: 'ready_to_compile',
        to: 'compiling',
        protocols: ['T2a'],
        guard: 'compile_lease_acquired',
      },
      {
        from: 'compiling',
        to: 'compiled',
        protocols: ['T2a'],
        guard: 'compiled_plan_persisted',
      },
      {
        from: 'compiled',
        to: 'materialized',
        protocols: ['T2b'],
        guard: 'scope_materialization_committed',
      },
      ...['pending_snapshot', 'ready_to_compile', 'compiling'].map((from) => ({
        from,
        to: 'failed',
        protocols: ['T2a'],
        guard: 'non_retryable_build_failure_or_retry_exhausted',
      })),
      ...['pending_snapshot', 'ready_to_compile', 'compiling', 'compiled'].map(
        (from) => ({
          from,
          to: 'fenced',
          protocols: ['T7a'],
          guard: 'scope_fence_wins',
        }),
      ),
    ],
  },
  {
    machine_id: 'control_edge_resolution',
    field: 'workflow_graph_control_edge_resolutions.state',
    initial_values: ['unresolved'],
    values: values(
      ['unresolved', 'taken', 'not_taken', 'error'],
      ['taken', 'not_taken', 'error'],
    ),
    transitions: ['taken', 'not_taken', 'error'].map((to) => ({
      from: 'unresolved',
      to,
      protocols: ['T3a'],
      guard: 'route_group_resolution_committed',
    })),
  },
  {
    machine_id: 'data_edge_resolution',
    field: 'workflow_graph_data_edge_resolutions.state',
    initial_values: ['unresolved'],
    values: values(
      ['unresolved', 'available', 'unavailable', 'error'],
      ['available', 'unavailable', 'error'],
    ),
    transitions: ['available', 'unavailable', 'error'].map((to) => ({
      from: 'unresolved',
      to,
      protocols: ['T3a'],
      guard: 'data_source_resolution_committed',
    })),
  },
  {
    machine_id: 'map_item_outcome_state',
    field: 'workflow_graph_map_item_results.outcome_state',
    initial_values: ['open'],
    values: values(
      ['open', 'completed', 'errored', 'cancelled', 'fenced'],
      ['completed', 'errored', 'cancelled', 'fenced'],
    ),
    transitions: [
      {
        from: 'open',
        to: 'completed',
        protocols: ['T7b'],
        guard: 'accepting_child_cut_consumed',
      },
      {
        from: 'open',
        to: 'errored',
        protocols: ['T2a', 'T7b'],
        guard: 'build_failure_or_child_error_consumed',
      },
      {
        from: 'open',
        to: 'cancelled',
        protocols: ['T7b'],
        guard: 'child_cancel_consumed',
      },
      {
        from: 'open',
        to: 'fenced',
        protocols: ['T7a', 'T7b'],
        guard: 'parent_close_or_controller_decision_fence',
      },
    ],
  },
  {
    machine_id: 'controller_state',
    field: 'workflow_graph_nodes.controller_state',
    initial_values: ['sealing'],
    values: values(
      ['sealing', 'running', 'closing_remaining', 'settled'],
      ['settled'],
    ),
    transitions: [
      {
        from: 'sealing',
        to: 'running',
        protocols: ['T4'],
        guard: 'expansion_manifest_sealed',
      },
      {
        from: 'sealing',
        to: 'settled',
        protocols: ['T4', 'T7a'],
        guard: 'empty_or_fenced_controller',
      },
      {
        from: 'running',
        to: 'closing_remaining',
        protocols: ['T7b'],
        guard: 'quorum_or_fail_fast_decision_frozen',
      },
      {
        from: 'running',
        to: 'settled',
        protocols: ['T7b'],
        guard: 'all_items_settled',
      },
      {
        from: 'closing_remaining',
        to: 'settled',
        protocols: ['T7b'],
        guard: 'all_loser_cleanup_barriers_settled',
      },
    ],
  },
  {
    machine_id: 'effect_operation_status',
    field: 'workflow_graph_effect_operations.status',
    initial_values: ['intended'],
    values: values(
      [
        'intended',
        'dispatched',
        'succeeded',
        'failed',
        'compensation_pending',
        'compensated',
        'compensation_not_required',
        'action_required',
      ],
      ['failed', 'compensated', 'compensation_not_required'],
    ),
    transitions: [
      {
        from: 'intended',
        to: 'dispatched',
        protocols: ['T5'],
        guard: 'outbox_delivery_started',
      },
      {
        from: 'intended',
        to: 'compensation_not_required',
        protocols: ['T7a'],
        guard: 'not_applied_proof_committed',
      },
      ...['succeeded', 'failed', 'action_required'].map((to) => ({
        from: 'dispatched',
        to,
        protocols: ['T6a', 'T6d', 'T6e'],
        guard: 'effect_result_or_reconciliation_committed',
      })),
      {
        from: 'succeeded',
        to: 'compensation_pending',
        protocols: ['T7a'],
        guard: 'required_compensation_intent_committed',
      },
      ...['compensated', 'action_required'].map((to) => ({
        from: 'compensation_pending',
        to,
        protocols: ['T6e', 'T7b'],
        guard: 'compensation_result_committed',
      })),
      {
        from: 'action_required',
        to: 'succeeded',
        protocols: ['T6e'],
        guard: 'verified_receipt_or_after_snapshot_restored',
      },
      {
        from: 'action_required',
        to: 'compensated',
        protocols: ['T6e'],
        guard: 'same_effect_key_compensation_verified',
      },
      {
        from: 'action_required',
        to: 'compensation_not_required',
        protocols: ['T6e'],
        guard: 'not_applied_proof_committed',
      },
    ],
  },
  {
    machine_id: 'outbox_status',
    field: 'workflow_outbox.status',
    initial_values: ['pending'],
    values: values(
      [
        'pending',
        'processing',
        'reconciling',
        'succeeded',
        'dead_letter',
        'action_required',
      ],
      ['succeeded', 'dead_letter'],
    ),
    transitions: [
      {
        from: 'pending',
        to: 'processing',
        protocols: ['OUTBOX'],
        guard: 'delivery_lease_acquired',
      },
      {
        from: 'processing',
        to: 'pending',
        protocols: ['OUTBOX'],
        guard: 'retryable_failure_scheduled',
      },
      {
        from: 'processing',
        to: 'reconciling',
        protocols: ['OUTBOX'],
        guard: 'unknown_outcome_recorded',
      },
      ...['succeeded', 'dead_letter', 'action_required'].map((to) => ({
        from: 'processing',
        to,
        protocols: ['OUTBOX'],
        guard: 'delivery_terminal_result_committed',
      })),
      {
        from: 'reconciling',
        to: 'reconciling',
        protocols: ['OUTBOX'],
        guard: 'reconcile_retry_scheduled',
      },
      ...['succeeded', 'dead_letter', 'action_required'].map((to) => ({
        from: 'reconciling',
        to,
        protocols: ['OUTBOX', 'T6e'],
        guard: 'reconcile_terminal_result_committed',
      })),
      {
        from: 'action_required',
        to: 'succeeded',
        protocols: ['T6e'],
        guard: 'source_specific_verification_committed',
      },
    ],
  },
  {
    machine_id: 'operational_blocker_status',
    field: 'workflow_operational_blockers.status',
    initial_values: ['open'],
    values: values(
      ['open', 'resolved', 'abandoned'],
      ['resolved', 'abandoned'],
    ),
    transitions: [
      {
        from: 'open',
        to: 'resolved',
        protocols: ['T6e'],
        guard: 'source_specific_verification_succeeded',
      },
      {
        from: 'open',
        to: 'abandoned',
        protocols: ['COMMAND'],
        guard: 'confirmed_administrative_abandon',
      },
    ],
  },
  {
    machine_id: 'root_finalization_status',
    field: 'workflow_root_finalization_schedules.status',
    initial_values: ['pending'],
    values: values(
      ['pending', 'retry_wait', 'ready', 'succeeded', 'exhausted', 'cancelled'],
      ['succeeded', 'cancelled'],
    ),
    transitions: [
      ...['retry_wait', 'ready', 'exhausted'].map((to) => ({
        from: 'pending',
        to,
        protocols: ['ROOT_FINALIZER'],
        guard: 'finalization_attempt_result_committed',
      })),
      {
        from: 'pending',
        to: 'cancelled',
        protocols: ['COMMAND'],
        guard: 'parent_administratively_abandoned',
      },
      ...['retry_wait', 'ready', 'exhausted'].map((to) => ({
        from: 'retry_wait',
        to,
        protocols: ['ROOT_FINALIZER'],
        guard: 'eligible_finalization_attempt_result_committed',
      })),
      {
        from: 'retry_wait',
        to: 'cancelled',
        protocols: ['COMMAND'],
        guard: 'parent_administratively_abandoned',
      },
      ...['succeeded', 'retry_wait', 'exhausted'].map((to) => ({
        from: 'ready',
        to,
        protocols: ['T8'],
        guard: 'atomic_root_commit_or_conflict_result_committed',
      })),
      {
        from: 'ready',
        to: 'cancelled',
        protocols: ['COMMAND'],
        guard: 'parent_administratively_abandoned',
      },
      {
        from: 'exhausted',
        to: 'ready',
        protocols: ['T6e'],
        guard: 'remediation_preflight_ready_before_same_tx_t8',
      },
      {
        from: 'exhausted',
        to: 'succeeded',
        protocols: ['T6e', 'T8'],
        guard: 'same_transaction_remediation_and_root_commit',
      },
    ],
  },
  {
    machine_id: 'command_confirmation_status',
    field: 'workflow_runtime_command_confirmations.status',
    initial_values: ['pending'],
    values: values(['pending', 'consumed', 'expired'], ['consumed', 'expired']),
    transitions: [
      {
        from: 'pending',
        to: 'consumed',
        protocols: ['COMMAND'],
        guard: 'same_human_session_confirmation_applied_within_ttl',
      },
      {
        from: 'pending',
        to: 'expired',
        protocols: ['COMMAND'],
        guard: 'confirmation_ttl_elapsed',
      },
    ],
  },
] as const satisfies readonly RuntimeStateMachine[];

export interface RuntimeCommandProtocolEntry {
  command_type: WorkflowCommandType;
  target_kind: RuntimeCommandTargetKind;
  permission_rule:
    | { kind: 'single'; permission: RuntimePermissionCode }
    | {
        kind: 'ownership_or_fallback';
        own_permission: 'workflow.cancel.own';
        fallback_permission: 'workflow.cancel.any';
      };
  allowed_reason_codes: readonly WorkflowCommandReasonCode[];
  allowed_actor_kinds: readonly CommandActorKind[];
  system_grant?: {
    actor_kind: 'system';
    reason_codes: readonly ('deadline_enforced' | 'safety_enforced')[];
    predicate: 'due_target';
    authority_scope: 'cancel_workflow_only';
    idempotency_domain: 'system:deadline-watchdog';
    idempotency_key_template: 'workflow-deadline:<workflow_id>:<deadline_at_ms>';
    invocation_audit: 'required';
  };
  primitive_handoff?: {
    authorization_owner: 'G7_runtime_command_gateway';
    audit_owner: 'G7_runtime_command_gateway';
    primitive_owner: 'G5';
    primitive_transaction_protocol: 'T6d';
    invocation_mode: 'authorized_manual_retry';
    unauthorized_direct_invocation: 'forbidden';
  };
  minimum_evidence_refs: number;
  confirmation_ref_required: boolean;
  policy_guard: string;
  state_guard: string;
  transaction_protocol: string;
  denial_codes: readonly RuntimeCommandDenialCode[];
}

const commonDenials = RUNTIME_COMMAND_DENIAL_CODES;
const cancelReasons = [
  'operator_requested',
  'superseded',
  'invalid_input',
  'no_longer_needed',
  'deadline_enforced',
  'safety_enforced',
  'unrecoverable_state',
  'external_effect_unverifiable',
] as const;
const localGraphCancelReasons = [
  'operator_requested',
  'superseded',
  'invalid_input',
  'no_longer_needed',
  'unrecoverable_state',
  'external_effect_unverifiable',
] as const;
const effectRemediationReasons = [
  'investigation',
  'dependency_recovered',
  'credential_restored',
  'receipt_recovered',
  'provider_reconciled',
  'not_applied_verified',
] as const;
const abandonReasons = [
  'unrecoverable_state',
  'external_effect_unverifiable',
  'data_loss_accepted',
] as const;

export const RUNTIME_COMMAND_PROTOCOL_ENTRIES = [
  {
    command_type: 'pause_run',
    target_kind: 'run',
    permission_rule: { kind: 'single', permission: 'workflow.operate' },
    allowed_reason_codes: ['operator_requested', 'investigation'],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allow_pause',
    state_guard: 'run_running_nonclosed_healthy',
    transaction_protocol: 'COMMAND',
    denial_codes: commonDenials,
  },
  {
    command_type: 'resume_run',
    target_kind: 'run',
    permission_rule: { kind: 'single', permission: 'workflow.operate' },
    allowed_reason_codes: ['operator_requested', 'investigation'],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allow_resume',
    state_guard: 'run_paused_nonclosed_healthy',
    transaction_protocol: 'COMMAND',
    denial_codes: commonDenials,
  },
  {
    command_type: 'cancel_run',
    target_kind: 'run',
    permission_rule: {
      kind: 'ownership_or_fallback',
      own_permission: 'workflow.cancel.own',
      fallback_permission: 'workflow.cancel.any',
    },
    allowed_reason_codes: localGraphCancelReasons,
    allowed_actor_kinds: ['human', 'feature_service', 'automation'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allows_local_graph_cancel',
    state_guard: 'current_run_nonclosed_healthy',
    transaction_protocol: 'T7c',
    denial_codes: commonDenials,
  },
  {
    command_type: 'cancel_workflow',
    target_kind: 'workflow',
    permission_rule: {
      kind: 'ownership_or_fallback',
      own_permission: 'workflow.cancel.own',
      fallback_permission: 'workflow.cancel.any',
    },
    allowed_reason_codes: cancelReasons,
    allowed_actor_kinds: ['human', 'feature_service', 'automation', 'system'],
    system_grant: {
      actor_kind: 'system',
      reason_codes: ['deadline_enforced', 'safety_enforced'],
      predicate: 'due_target',
      authority_scope: 'cancel_workflow_only',
      idempotency_domain: 'system:deadline-watchdog',
      idempotency_key_template:
        'workflow-deadline:<workflow_id>:<deadline_at_ms>',
      invocation_audit: 'required',
    },
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allows_workflow_cancel_or_system_grant',
    state_guard: 'workflow_active_current_run_nonclosed_healthy',
    transaction_protocol: 'T7c',
    denial_codes: commonDenials,
  },
  {
    command_type: 'skip_node',
    target_kind: 'node',
    permission_rule: { kind: 'single', permission: 'workflow.node.skip' },
    allowed_reason_codes: [
      'operator_requested',
      'invalid_input',
      'no_longer_needed',
    ],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allow_manual_skip',
    state_guard: 'run_paused_node_nonterminal_no_unknown_effect',
    transaction_protocol: 'COMMAND',
    denial_codes: commonDenials,
  },
  {
    command_type: 'advance_retry_schedule',
    target_kind: 'retry_schedule',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.retry.advance',
    },
    allowed_reason_codes: [
      'operator_requested',
      'dependency_recovered',
      'credential_restored',
    ],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_allow_retry_wait_advance',
    state_guard: 'run_paused_schedule_scheduled_node_retry_wait_healthy',
    transaction_protocol: 'T6d',
    primitive_handoff: {
      authorization_owner: 'G7_runtime_command_gateway',
      audit_owner: 'G7_runtime_command_gateway',
      primitive_owner: 'G5',
      primitive_transaction_protocol: 'T6d',
      invocation_mode: 'authorized_manual_retry',
      unauthorized_direct_invocation: 'forbidden',
    },
    denial_codes: commonDenials,
  },
  {
    command_type: 'reconcile_effect',
    target_kind: 'effect_operation',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.effect.remediate',
    },
    allowed_reason_codes: effectRemediationReasons,
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 0,
    confirmation_ref_required: false,
    policy_guard: 'receipt_remediation_contract_allows_reconcile',
    state_guard: 'effect_open_or_action_required_same_effect_key',
    transaction_protocol: 'T6e',
    denial_codes: commonDenials,
  },
  {
    command_type: 'submit_effect_receipt',
    target_kind: 'effect_operation',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.effect.remediate',
    },
    allowed_reason_codes: ['receipt_recovered', 'provider_reconciled'],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: false,
    policy_guard: 'receipt_remediation_contract_allows_verified_receipt',
    state_guard: 'effect_open_or_action_required_same_effect_key',
    transaction_protocol: 'T6e',
    denial_codes: commonDenials,
  },
  {
    command_type: 'verify_effect_not_applied',
    target_kind: 'effect_operation',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.effect.remediate',
    },
    allowed_reason_codes: ['not_applied_verified', 'provider_reconciled'],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: false,
    policy_guard: 'receipt_remediation_contract_allows_not_applied_proof',
    state_guard: 'effect_open_or_action_required_same_effect_key',
    transaction_protocol: 'T6e',
    denial_codes: commonDenials,
  },
  {
    command_type: 'remediate_operational_blocker',
    target_kind: 'operational_blocker',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.blocker.remediate',
    },
    allowed_reason_codes: effectRemediationReasons,
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: false,
    policy_guard: 'operational_remediation_policy_allows_blocker_kind',
    state_guard: 'blocker_open_action_required_source_verifiable',
    transaction_protocol: 'T6e',
    denial_codes: commonDenials,
  },
  {
    command_type: 'restore_integrity',
    target_kind: 'operational_blocker',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.integrity.restore',
    },
    allowed_reason_codes: ['backup_restored', 'hash_revalidated'],
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: false,
    policy_guard: 'trusted_integrity_restore_evidence_required',
    state_guard: 'integrity_quarantine_blocker_open',
    transaction_protocol: 'T6e',
    denial_codes: commonDenials,
  },
  {
    command_type: 'request_administrative_abandon',
    target_kind: 'workflow',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.administrative_abandon',
    },
    allowed_reason_codes: abandonReasons,
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: false,
    policy_guard: 'command_policy_administrative_abandon_allowed',
    state_guard: 'workflow_active_current_nonterminal_activation',
    transaction_protocol: 'COMMAND',
    denial_codes: commonDenials,
  },
  {
    command_type: 'confirm_administrative_abandon',
    target_kind: 'workflow',
    permission_rule: {
      kind: 'single',
      permission: 'workflow.administrative_abandon',
    },
    allowed_reason_codes: abandonReasons,
    allowed_actor_kinds: ['human'],
    minimum_evidence_refs: 1,
    confirmation_ref_required: true,
    policy_guard: 'command_policy_administrative_abandon_allowed',
    state_guard:
      'matching_pending_confirmation_same_human_session_request_evidence_version_within_300000ms',
    transaction_protocol: 'COMMAND',
    denial_codes: commonDenials,
  },
] as const satisfies readonly RuntimeCommandProtocolEntry[];

export const RUN_TRANSACTION_PROTOCOL_IDS = [
  'T0',
  'T0p',
  'T1',
  'T2a',
  'T2b',
  'T3a',
  'T3b',
  'T4',
  'T5',
  'T6a',
  'T6b',
  'T6c',
  'T6d',
  'T6e',
  'T7a',
  'T7b',
  'T7c',
  'T8',
] as const;
export type RunTransactionProtocolId =
  (typeof RUN_TRANSACTION_PROTOCOL_IDS)[number];

export interface RunTransactionProtocolEntry {
  transaction_id: RunTransactionProtocolId;
  name: string;
  transaction_mode: 'begin_immediate';
  external_work_boundary: 'none' | 'before_transaction' | 'after_transaction';
  preconditions: readonly string[];
  cas_guards: readonly string[];
  atomic_writes: readonly string[];
  idempotency_constraints: readonly string[];
  failure_or_late_outcomes: readonly string[];
  forbidden: readonly string[];
  invocation_contract?: {
    automatic_timer: {
      owner_gate: 'G5';
      ingress: 'due_attempt_watchdog_or_retry_schedule_timer';
      gateway_authorization: 'not_applicable';
    };
    authorized_manual_retry: {
      owner_gate: 'G7';
      ingress: 'advance_retry_schedule';
      authorization_boundary: 'runtime_command_gateway_before_t6d';
      command_invocation_audit: 'required_before_primitive';
      g5_primitive: 'consume_existing_retry_schedule';
    };
  };
}

export const RUN_TRANSACTION_PROTOCOL_ENTRIES = [
  {
    transaction_id: 'T0',
    name: 'task_intake_routing_and_idempotent_creation',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'trusted_creation_domain',
      'strict_task_envelope',
      'exact_recipe_definition_policy_schema_refs',
      'nonterminal_entrypoint',
      'authorized_principal',
    ],
    cas_guards: [
      'creation_domain_creation_key_intent',
      'launch_confirmation_exact_intent',
      'domain_claim_head_versions',
    ],
    atomic_writes: [
      'intake_revision_routing_creation_provenance',
      'workflow_control_ownership_snapshot',
      'workflow_active_healthy_revision_zero',
      'workflow_deadline_and_lifetime_accounts',
      'recipe_domain_claims',
      't1_core_setup',
    ],
    idempotency_constraints: [
      'same_key_same_intent_returns_existing',
      'same_key_different_intent_conflicts',
      'unique_creation_domain_creation_key',
    ],
    failure_or_late_outcomes: [
      'resource_busy_blocked_retryable',
      'idempotency_conflict',
      'permanent_creation_rejection',
    ],
    forbidden: [
      'terminal_entrypoint',
      'partial_claim_acquisition',
      'runtime_or_registry_latest_fallback',
      'external_await_inside_transaction',
    ],
  },
  {
    transaction_id: 'T0p',
    name: 'required_child_provenance_and_preflight_shell',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'trusted_required_transition_effect',
      'winning_root_close_request',
    ],
    cas_guards: [
      'stable_transition_provenance_ids',
      'unique_close_request_transition_effect',
    ],
    atomic_writes: [
      'transition_intake_revision_zero',
      'deterministic_routing_attempt',
      'required_finalization_creation_request',
      'root_finalization_schedule_real_foreign_keys',
    ],
    idempotency_constraints: [
      'stable_intake_routing_creation_schedule_ids',
      'unique_transition_intake',
      'unique_creation_request',
    ],
    failure_or_late_outcomes: ['existing_exact_provenance_returned'],
    forbidden: [
      'child_workflow_creation_before_t8',
      'relation_creation_before_t8',
      'claim_acquire_or_handoff_before_t8',
    ],
  },
  {
    transaction_id: 'T1',
    name: 'standalone_activation_ingress',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      't0_workflow_or_trusted_internal_transition',
      'workflow_operational_state_healthy',
      'nonterminal_target_state',
    ],
    cas_guards: [
      'workflow_status_current_binding_row_version',
      'workflow_lifetime_account_versions',
    ],
    atomic_writes: [
      'active_state_activation',
      'initializing_root_run',
      'registry_definition_source_safety_snapshots',
      'run_ledger_accounts',
      'materializing_root_scope_shell',
      'root_scope_build',
      'workflow_current_bindings',
      'initial_checkpoint',
    ],
    idempotency_constraints: [
      'unique_workflow_state_activation_number',
      'unique_workflow_state_instance_run',
      'unique_root_scope_and_build',
    ],
    failure_or_late_outcomes: ['cas_conflict_no_partial_activation'],
    forbidden: [
      'terminal_activation_core_setup',
      'workflow_revision_increment',
      'external_await_inside_transaction',
    ],
  },
  {
    transaction_id: 'T2a',
    name: 'compile_result_persistence',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'frozen_source_input_compiler_snapshot',
      'pinned_pure_compiler_result',
    ],
    cas_guards: ['build_status_lease_token_hashes_saved_epochs_row_version'],
    atomic_writes: [
      'immutable_parent_and_static_child_plan_closure',
      'build_compiled_or_failed',
      'nonretryable_build_failure_fact',
    ],
    idempotency_constraints: [
      'unique_graph_run_plan_hash',
      'same_build_hashes_same_result',
    ],
    failure_or_late_outcomes: [
      'stale_compile_result_rejected',
      'build_failed_fact',
    ],
    forbidden: [
      'scope_or_node_quota_consumption',
      'partial_plan_closure',
      'source_rewrite_or_model_repair',
    ],
  },
  {
    transaction_id: 'T2b',
    name: 'scope_materialization',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'run_control_running',
      'run_operational_state_healthy',
      'matching_work_epochs',
      'compiled_build',
      'root_materializing_or_active_child_owner',
    ],
    cas_guards: [
      'build_compiled_row_version',
      'run_control_work_epoch_manifest_row_version',
      'root_shell_or_owner_node_versions',
      'ledger_account_versions',
    ],
    atomic_writes: [
      'scope_node_edge_quota_commit',
      'root_shell_update_or_unique_child_scope_insert',
      'nodes_and_edges',
      'run_manifest_entry_and_head',
      'build_materialized_scope_binding',
      'root_run_executing_or_child_owner_continuation',
    ],
    idempotency_constraints: [
      'unique_build_scope_binding',
      'unique_owner_node_child_key',
      'unique_run_manifest_sequence',
    ],
    failure_or_late_outcomes: [
      'quota_failure_no_partial_materialization',
      'paused_or_stale_epoch_conflict',
    ],
    forbidden: [
      'materialize_while_paused_or_resuming',
      'partial_nodes_edges_or_manifest',
    ],
  },
  {
    transaction_id: 'T3a',
    name: 'fact_and_fixed_point_reconcile',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'one_durable_ingress_fact',
      'facts_transaction_capacity_preflight',
    ],
    cas_guards: [
      'run_next_event_seq_row_version',
      'unresolved_edge_versions',
      'open_trigger_and_input_states',
      'unique_fact_key',
      'unique_scope_rule_eligibility',
      'unique_scope_close_request',
    ],
    atomic_writes: [
      'fact_and_same_sequence_event',
      'node_output_envelope_when_applicable',
      'deterministic_fixed_point_derived_facts',
      'route_and_data_resolutions',
      'trigger_cut_and_input_snapshot',
      'ready_skipped_orchestration_error_facts',
      'first_early_eligibilities',
      'running_healthy_close_arbitration',
    ],
    idempotency_constraints: [
      'unique_graph_run_fact_key',
      'unique_graph_run_event_sequence',
      'unique_scope_rule_eligibility',
      'unique_scope_close_request',
    ],
    failure_or_late_outcomes: [
      'duplicate_fact_returns_existing',
      'engine_error_precedes_normal_eligibility',
      'paused_eligibility_persisted_without_request',
    ],
    forbidden: [
      'split_fact_and_event_commit',
      'async_eligibility_repair',
      'partial_fixed_point_wave',
      'provider_timestamp_ordering',
    ],
  },
  {
    transaction_id: 'T3b',
    name: 'settled_close',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'run_control_running',
      'run_operational_state_healthy',
      'scope_active',
      'scope_quiescent_fixed_point',
    ],
    cas_guards: [
      'run_event_sequence_row_version',
      'scope_active_row_version',
      'unique_scope_close_request',
    ],
    atomic_writes: [
      'complete_quiescent_fact_frontier',
      'settled_rule_eligibility',
      'selected_close_request_or_no_exit_engine_error',
    ],
    idempotency_constraints: [
      'unique_scope_rule',
      'unique_scope_close_request',
    ],
    failure_or_late_outcomes: ['no_exit_selected_engine_error'],
    forbidden: [
      'settled_arbitration_while_paused_or_resuming',
      'partial_frontier',
      'implicit_candidate_aggregation',
    ],
  },
  {
    transaction_id: 'T4',
    name: 'activate_by_node_kind',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'run_control_running',
      'run_operational_state_healthy',
      'scope_active',
      'node_ready',
      'matching_work_epochs',
    ],
    cas_guards: [
      'node_ready_row_version',
      'run_and_scope_work_epochs',
      'ledger_account_versions',
    ],
    atomic_writes: [
      'kind_specific_node_activation',
      'attempt_and_active_execution_reservation',
      'wait_and_active_wait_reservation',
      'structural_output_or_candidate',
      'sealed_expansion_manifest_map_slots_child_builds',
    ],
    idempotency_constraints: [
      'unique_node_attempt_number',
      'unique_node_wait',
      'unique_owner_expansion_manifest',
    ],
    failure_or_late_outcomes: ['capacity_backpressure_keeps_node_ready'],
    forbidden: [
      'ordinary_attempt_for_join_terminal_or_child_owner',
      'activation_while_paused_resuming_or_unhealthy',
    ],
  },
  {
    transaction_id: 'T5',
    name: 'dispatch_capability',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'after_transaction',
    preconditions: [
      'run_control_running',
      'run_operational_state_healthy',
      'attempt_preparing_or_dispatch_pending',
      'frozen_context_and_input',
    ],
    cas_guards: [
      'attempt_phase_saved_epochs_row_version',
      'all_required_claim_slots_held_current',
    ],
    atomic_writes: [
      'frozen_context_pack_binding',
      'delegation_outbox_or_effect_intent',
      'effect_operation_claim_rows',
      'attempt_dispatch_pending',
    ],
    idempotency_constraints: ['stable_attempt_or_effect_operation_key'],
    failure_or_late_outcomes: ['paused_after_claim_keeps_dispatch_pending'],
    forbidden: [
      'external_execution_inside_transaction',
      'dispatch_without_all_claim_slots',
      'new_operation_key_on_redelivery',
    ],
  },
  {
    transaction_id: 'T6a',
    name: 'internal_worker_and_quality_result',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'attempt_acceptance_open',
      'matching_worker_or_evaluator_lease',
      'matching_saved_work_epochs',
      'pinned_artifact_and_evaluation_contracts',
    ],
    cas_guards: [
      'attempt_phase_lease_token_saved_epochs_row_version',
      'node_phase_current_attempt_row_version',
      'unique_parent_attempt_successor',
      'unique_source_attempt_schedule',
      'ledger_account_versions',
    ],
    atomic_writes: [
      'attempt_execution_and_quality_result',
      'pass_output_and_node_terminal',
      'quality_rejection_terminal',
      'validated_feedback_envelope',
      'quality_revision_schedule_and_next_attempt_reservation',
      'quality_or_budget_exhaustion_detail',
      'node_terminal_fact',
    ],
    idempotency_constraints: [
      'one_actual_successor_per_attempt',
      'one_schedule_per_source_attempt',
      'logical_node_output_published_once',
    ],
    failure_or_late_outcomes: [
      'quality_rejected',
      'quality_revision_exhausted',
      'evaluation_contract_violation',
      'attempt_budget_exhausted',
      'duplicate_same_result',
      'integrity_violation_on_result_drift',
    ],
    forbidden: [
      'publish_candidate_on_needs_revision_or_fail',
      'split_feedback_schedule_reservation_commit',
      'retry_evaluator_fail',
      'reset_attempt_budget_by_continuation_kind',
    ],
  },
  {
    transaction_id: 'T6b',
    name: 'delegation_callback',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'delegation_and_external_execution_identity_match',
      'attempt_acceptance_open',
      'matching_saved_work_epochs',
    ],
    cas_guards: ['delegation_external_id_acceptance_saved_epochs_row_version'],
    atomic_writes: ['provider_callback_result_or_late_result_audit'],
    idempotency_constraints: [
      'unique_delegation_id',
      'provider_event_identity',
    ],
    failure_or_late_outcomes: ['duplicate', 'late', 'conflict'],
    forbidden: [
      'require_worker_lease_for_external_callback',
      'publish_after_acceptance_fenced',
    ],
  },
  {
    transaction_id: 'T6c',
    name: 'wait_resolution',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'wait_armed',
      'matching_saved_work_epochs',
      'authorized_signal_timeout_or_cancel',
    ],
    cas_guards: ['wait_armed_saved_epochs_row_version'],
    atomic_writes: [
      'single_wait_terminal_outcome',
      'inbox_disposition',
      'wait_resolution_fact_and_event',
      'node_terminal_and_output_when_successful',
      'active_wait_reservation_release',
    ],
    idempotency_constraints: [
      'unique_provider_event',
      'single_wait_winner',
      'unique_run_contract_correlation',
    ],
    failure_or_late_outcomes: ['duplicate', 'conflict', 'late'],
    forbidden: [
      'registration_lease_as_signal_credential',
      'provider_timestamp_arbitration',
      'second_wait_winner',
    ],
  },
  {
    transaction_id: 'T6d',
    name: 'attempt_watchdog_and_retry_timers',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'after_transaction',
    preconditions: [
      'automatic_due_frozen_attempt_deadline_or_retry_eligible_time',
      'manual_retry_only_after_gateway_authorization',
    ],
    cas_guards: [
      'attempt_acceptance_open_for_watchdog',
      'retry_schedule_scheduled_row_version',
    ],
    atomic_writes: [
      'attempt_timeout_fence_and_fact',
      'cancel_reconcile_or_compensation_effects',
      'schedule_consumed_and_exact_next_attempt',
      'node_retry_wait_to_active',
    ],
    idempotency_constraints: [
      'unique_attempt_timeout_event',
      'unique_schedule_source_and_next_attempt',
    ],
    failure_or_late_outcomes: ['duplicate_timer'],
    forbidden: [
      'recompute_backoff_or_deadline',
      'reseal_node_input',
      'external_cancel_or_reconcile_inside_transaction',
      'workflow_deadline_command_creation',
      'runtime_command_or_invocation_audit_write',
      'manual_retry_without_gateway_authorization',
    ],
    invocation_contract: {
      automatic_timer: {
        owner_gate: 'G5',
        ingress: 'due_attempt_watchdog_or_retry_schedule_timer',
        gateway_authorization: 'not_applicable',
      },
      authorized_manual_retry: {
        owner_gate: 'G7',
        ingress: 'advance_retry_schedule',
        authorization_boundary: 'runtime_command_gateway_before_t6d',
        command_invocation_audit: 'required_before_primitive',
        g5_primitive: 'consume_existing_retry_schedule',
      },
    },
  },
  {
    transaction_id: 'T6e',
    name: 'operational_remediation_and_integrity_restoration',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'before_transaction',
    preconditions: [
      'authorized_runtime_command',
      'expected_blocker_run_workflow_versions',
      'source_specific_verification_succeeded',
    ],
    cas_guards: [
      'blocker_open_row_version',
      'run_and_workflow_row_versions',
      'same_effect_schedule_claim_or_integrity_identity',
    ],
    atomic_writes: [
      'append_only_remediation_attempt_and_evidence',
      'source_effect_schedule_claim_or_integrity_result',
      'exactly_one_blocker_resolved',
      'remaining_blocker_severity_recompute',
      'run_and_workflow_operational_cache_update',
      'command_invocation_and_runtime_event',
      'same_transaction_t8_for_root_finalization_exhausted',
    ],
    idempotency_constraints: [
      'blocker_id_remediation_attempt_key',
      'single_open_to_resolved_transition',
      'same_effect_key_or_source_schedule',
    ],
    failure_or_late_outcomes: [
      'verification_failure_keeps_blocker_open',
      'attempt_exhaustion_keeps_blocker_open',
      'remaining_blocker_preserves_effective_operational_state',
    ],
    forbidden: [
      'close_blocker_before_source_verification',
      'reset_lifecycle_control_fence_ledger_deadline_or_attempts',
      'ordinary_remediation_of_integrity_quarantine',
      'root_finalization_resolution_without_same_transaction_t8',
    ],
  },
  {
    transaction_id: 'T7a',
    name: 'scope_close_primitive',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'after_transaction',
    preconditions: [
      'normal_error_or_cancel_close_cause',
      'scope_open_or_materializing_root_setup_failure',
    ],
    cas_guards: [
      'unique_scope_close_request',
      'scope_and_descendant_row_versions',
      'run_row_version_for_root_close',
    ],
    atomic_writes: [
      'winning_target_close_request',
      'parent_close_requests_for_open_descendants',
      'subtree_lifecycle_closing',
      'all_subtree_work_epoch_increments',
      'attempt_wait_build_controller_fences',
      'map_slot_fences_and_reservation_releases',
      'root_run_closing_and_work_epoch_increment',
      'subtree_fence_manifest',
      'deterministic_close_cleanup_effects',
    ],
    idempotency_constraints: [
      'unique_scope_close_request',
      'unique_source_close_subtree_fence_manifest',
      'cleanup_effect_key_by_close_request',
    ],
    failure_or_late_outcomes: ['losing_close_cause_audited_late'],
    forbidden: [
      'overwrite_existing_descendant_close_request',
      'split_descendant_fence_transactions',
      'await_external_cancel_ack_inside_transaction',
      'partial_fence_manifest_or_cleanup_set',
    ],
  },
  {
    transaction_id: 'T7b',
    name: 'child_database_finalizer_and_consumer',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'child_logically_fenced',
      'required_compensation_successfully_terminal',
    ],
    cas_guards: [
      'unique_child_completion_cut',
      'owner_or_controller_state_row_version',
      'map_slot_open_or_fenced_row_version',
      'matching_owner_work_epochs',
    ],
    atomic_writes: [
      'child_completion_cut',
      'unique_parent_consumption_disposition',
      'owner_output_or_map_slot_result_when_accepting',
      'nonpublish_disposition_when_parent_fenced',
      'map_decision_and_loser_t7a_fences',
      'map_remaining_barrier_and_owner_terminal',
    ],
    idempotency_constraints: [
      'unique_child_scope_cut',
      'unique_child_scope_consumption',
      'single_map_slot_terminal_outcome',
    ],
    failure_or_late_outcomes: [
      'action_required_compensation_blocks_cut',
      'late_child_outcome_nonpublish',
    ],
    forbidden: [
      'overwrite_fenced_map_slot',
      'publish_to_fenced_parent_or_owner',
      'cut_before_required_compensation_success',
    ],
  },
  {
    transaction_id: 'T7c',
    name: 'cancel_ingress',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'authorized_cancel_command',
      'workflow_current_run_root_scope_match',
    ],
    cas_guards: [
      'workflow_current_run_row_version',
      'run_control_root_cancel_scope_row_version',
      'unique_root_scope_close_request',
    ],
    atomic_writes: [
      'winning_cancel_close_request_via_t7a',
      'run_control_cancelling',
      'frozen_root_cancel_scope',
      'command_invocation_audit',
    ],
    idempotency_constraints: [
      'unique_root_scope_close_request',
      'canonical_command_header_result',
      'stable_system_deadline_key_workflow-deadline:<workflow_id>:<deadline_at_ms>',
    ],
    failure_or_late_outcomes: [
      'loser_records_late_command_only',
      'duplicate_returns_canonical_result_with_invocation_audit',
    ],
    forbidden: [
      'overwrite_winning_route_or_cancel_scope',
      'require_pause_before_cancel',
    ],
  },
  {
    transaction_id: 'T8',
    name: 'root_commit_and_outer_transition',
    transaction_mode: 'begin_immediate',
    external_work_boundary: 'none',
    preconditions: [
      'workflow_and_run_operational_state_healthy',
      'root_and_run_closing',
      'matching_winning_close_request',
      'subtree_compensation_successfully_settled',
      'all_required_child_schedules_ready',
    ],
    cas_guards: [
      'unique_root_completion_cut',
      'workflow_revision_current_binding_row_version',
      'source_activation_active_row_version',
      'required_child_schedule_and_claim_versions',
      'lineage_and_lifetime_account_versions',
    ],
    atomic_writes: [
      'root_completion_cut',
      'root_scope_and_run_closed',
      'source_activation_completed',
      'workflow_revision_increment',
      'trusted_context_patch_and_transition_history',
      'checkpoint_with_completed_and_current_watermarks',
      'notification_and_best_effort_child_outbox',
      'target_nonterminal_t1_core_setup_or_terminal_activation',
      'final_workflow_status_and_output_or_error_or_cancel',
      'all_required_child_workflows_relations_claim_handoffs',
      'required_transition_intakes_creation_requests_created',
      'root_finalization_schedules_succeeded',
    ],
    idempotency_constraints: [
      'unique_source_activation_transition',
      'unique_root_completion_cut',
      'unique_transition_checkpoint',
      'stable_required_child_creation_key',
      'unique_child_relation',
    ],
    failure_or_late_outcomes: [
      'required_child_conflict_rolls_back_entire_business_commit',
      'finite_finalization_retry_or_exhaustion_blocker',
      'duplicate_returns_existing_cut_history_checkpoint',
    ],
    forbidden: [
      'partial_required_child_creation',
      'cut_while_action_required_compensation_exists',
      'standalone_t1_checkpoint_during_reused_core_setup',
      'route_kind_fallback',
      'external_await_inside_transaction',
    ],
  },
] as const satisfies readonly RunTransactionProtocolEntry[];

export const PROTOCOL_TABLE_CLOSED_UNIONS = {
  command_target_kinds: RUNTIME_COMMAND_TARGET_KINDS,
  transaction_protocol_ids: RUN_TRANSACTION_PROTOCOL_IDS,
} as const;
