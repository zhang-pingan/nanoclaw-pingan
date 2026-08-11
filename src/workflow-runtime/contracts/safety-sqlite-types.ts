export const SAFETY_CEILING_GROUP_KEYS = {
  routing: [
    'max_task_input_bytes',
    'max_route_hops',
    'max_schema_bytes',
    'max_schema_nodes',
    'max_schema_ref_depth',
    'max_schema_union_variants',
    'max_schema_validation_steps',
  ],
  workflow: [
    'max_duration_ms',
    'max_state_activations',
    'max_graph_runs',
    'max_state_transitions',
    'max_child_workflows_per_workflow',
    'max_child_workflow_depth',
    'max_descendant_workflows_total',
    'max_required_child_creations_per_transition',
  ],
  run: [
    'max_scopes_total',
    'max_nodes_total',
    'max_edges_total',
    'max_map_items_total',
    'max_attempts_total',
    'max_waits_total',
    'max_builds_total',
    'max_build_attempts_total',
    'max_evaluator_attempts_total',
    'max_effect_operations_total',
    'max_logical_output_bytes_total',
    'max_stored_bytes_total',
    'max_facts_total',
  ],
  scope: [
    'max_nodes_per_scope',
    'max_edges_per_scope',
    'max_scope_spec_bytes',
    'max_nesting_depth',
    'max_frontier_bytes',
  ],
  map: ['max_items_per_map', 'max_child_concurrency_per_map'],
  registry: [
    'max_snapshot_entries',
    'max_dependency_depth',
    'max_execution_artifact_bytes',
    'max_total_pinned_execution_bytes_per_run',
  ],
  execution: [
    'max_attempts_per_node',
    'max_attempt_duration_ms',
    'max_dispatch_duration_ms',
    'max_retry_backoff_ms',
    'max_build_attempts_per_build',
    'max_build_duration_ms',
    'max_evaluator_attempts_per_evaluation',
    'max_evaluator_duration_ms',
    'max_outbox_attempts_per_message',
    'max_outbox_reconcile_attempts_per_message',
    'max_outbox_attempt_duration_ms',
    'max_outbox_delivery_duration_ms',
    'max_root_finalization_attempts_per_schedule',
    'max_root_finalization_duration_ms',
    'max_operational_remediation_attempts_per_blocker',
    'max_operational_remediation_duration_ms',
  ],
  wait: [
    'max_finite_wait_duration_ms',
    'max_pending_signals_per_workflow',
    'max_pending_signals_per_run',
    'max_pending_signals_per_principal',
    'max_pending_signal_age_ms',
    'max_signal_payload_bytes',
    'max_correlation_key_bytes',
  ],
  reconciliation: [
    'max_condition_ast_nodes',
    'max_condition_steps_per_evaluation',
    'max_facts_per_transaction',
  ],
  value: [
    'max_single_value_bytes',
    'max_single_artifact_bytes',
    'max_artifact_files',
    'max_artifact_manifest_bytes',
  ],
} as const;

export const SAFETY_CEILING_GROUPS = Object.keys(
  SAFETY_CEILING_GROUP_KEYS,
) as Array<keyof typeof SAFETY_CEILING_GROUP_KEYS>;

export const SAFETY_LIMIT_PATHS = SAFETY_CEILING_GROUPS.flatMap((group) =>
  SAFETY_CEILING_GROUP_KEYS[group].map((field) => `${group}.${field}`),
).sort();

export const DEPLOYMENT_CAPACITY_KEYS = [
  'max_active_executions',
  'max_active_waits',
  'max_pending_signals',
  'max_outbox_inflight',
  'max_physical_blob_bytes',
  'soft_blob_high_water_bytes',
  'minimum_free_disk_bytes',
  'config_hash',
] as const;

export const CAPACITY_LIMIT_PATHS = DEPLOYMENT_CAPACITY_KEYS.filter(
  (field) => field !== 'config_hash',
)
  .map((field) => `capacity.${field}`)
  .sort();

export type WorkflowRuntimeSafetyCeilings = {
  [Group in keyof typeof SAFETY_CEILING_GROUP_KEYS]: {
    [Field in (typeof SAFETY_CEILING_GROUP_KEYS)[Group][number]]: number;
  };
};

export interface WorkflowRuntimeSafetyProfile {
  profile_id: 'local_single_user_safety@1';
  deployment_profile: 'local_single_user';
  mutability: 'immutable_versioned';
  pinning_scope: 'workflow_and_run_creation';
  ceilings: WorkflowRuntimeSafetyCeilings;
}

export const LOCAL_SINGLE_USER_SAFETY_PROFILE = {
  profile_id: 'local_single_user_safety@1',
  deployment_profile: 'local_single_user',
  mutability: 'immutable_versioned',
  pinning_scope: 'workflow_and_run_creation',
  ceilings: {
    routing: {
      max_task_input_bytes: 1048576,
      max_route_hops: 8,
      max_schema_bytes: 262144,
      max_schema_nodes: 4096,
      max_schema_ref_depth: 32,
      max_schema_union_variants: 64,
      max_schema_validation_steps: 100000,
    },
    workflow: {
      max_duration_ms: 2592000000,
      max_state_activations: 128,
      max_graph_runs: 127,
      max_state_transitions: 127,
      max_child_workflows_per_workflow: 32,
      max_child_workflow_depth: 4,
      max_descendant_workflows_total: 128,
      max_required_child_creations_per_transition: 8,
    },
    run: {
      max_scopes_total: 128,
      max_nodes_total: 1024,
      max_edges_total: 4096,
      max_map_items_total: 256,
      max_attempts_total: 4096,
      max_waits_total: 512,
      max_builds_total: 512,
      max_build_attempts_total: 1536,
      max_evaluator_attempts_total: 8192,
      max_effect_operations_total: 2048,
      max_logical_output_bytes_total: 1073741824,
      max_stored_bytes_total: 2147483648,
      max_facts_total: 262144,
    },
    scope: {
      max_nodes_per_scope: 128,
      max_edges_per_scope: 512,
      max_scope_spec_bytes: 2097152,
      max_nesting_depth: 8,
      max_frontier_bytes: 16777216,
    },
    map: {
      max_items_per_map: 128,
      max_child_concurrency_per_map: 16,
    },
    registry: {
      max_snapshot_entries: 4096,
      max_dependency_depth: 32,
      max_execution_artifact_bytes: 268435456,
      max_total_pinned_execution_bytes_per_run: 1073741824,
    },
    execution: {
      max_attempts_per_node: 4,
      max_attempt_duration_ms: 1800000,
      max_dispatch_duration_ms: 120000,
      max_retry_backoff_ms: 3600000,
      max_build_attempts_per_build: 3,
      max_build_duration_ms: 600000,
      max_evaluator_attempts_per_evaluation: 3,
      max_evaluator_duration_ms: 600000,
      max_outbox_attempts_per_message: 32,
      max_outbox_reconcile_attempts_per_message: 16,
      max_outbox_attempt_duration_ms: 300000,
      max_outbox_delivery_duration_ms: 259200000,
      max_root_finalization_attempts_per_schedule: 8,
      max_root_finalization_duration_ms: 900000,
      max_operational_remediation_attempts_per_blocker: 16,
      max_operational_remediation_duration_ms: 259200000,
    },
    wait: {
      max_finite_wait_duration_ms: 2592000000,
      max_pending_signals_per_workflow: 256,
      max_pending_signals_per_run: 128,
      max_pending_signals_per_principal: 1024,
      max_pending_signal_age_ms: 604800000,
      max_signal_payload_bytes: 1048576,
      max_correlation_key_bytes: 512,
    },
    reconciliation: {
      max_condition_ast_nodes: 256,
      max_condition_steps_per_evaluation: 4096,
      max_facts_per_transaction: 16384,
    },
    value: {
      max_single_value_bytes: 16777216,
      max_single_artifact_bytes: 268435456,
      max_artifact_files: 4096,
      max_artifact_manifest_bytes: 4194304,
    },
  },
} as const satisfies WorkflowRuntimeSafetyProfile;

export interface DeploymentRuntimeCapacity {
  max_active_executions: number;
  max_active_waits: number;
  max_pending_signals: number;
  max_outbox_inflight: number;
  max_physical_blob_bytes: number;
  soft_blob_high_water_bytes: number;
  minimum_free_disk_bytes: number;
  config_hash: string;
}

export const DEPLOYMENT_RUNTIME_CAPACITY_BASELINE_WITHOUT_HASH = {
  max_active_executions: 5,
  max_active_waits: 256,
  max_pending_signals: 2048,
  max_outbox_inflight: 16,
  max_physical_blob_bytes: 21474836480,
  soft_blob_high_water_bytes: 17179869184,
  minimum_free_disk_bytes: 5368709120,
} as const satisfies Omit<DeploymentRuntimeCapacity, 'config_hash'>;

export const DEPLOYMENT_CAPACITY_RELOAD_CONTRACT = {
  update_mode: 'atomic_complete_validated_snapshot',
  semantic_role: 'admission_only_not_plan_semantics',
  lowering_existing_admissions: 'never_cancel_existing_work',
  hard_blob_below_current_allocation:
    'enter_over_capacity_block_new_allocation_and_trigger_gc',
  minimum_free_disk_update: 'increase_only',
  safety_quota_effect: 'cannot_relax_pinned_safety',
} as const;

export const PRODUCT_FLOOR_LIMIT_KEYS = [
  'max_scopes_total',
  'max_nodes_total',
  'max_nodes_per_scope',
  'max_edges_total',
  'max_edges_per_scope',
  'max_map_items_total',
  'max_items_per_map',
  'max_attempts_total',
  'max_waits_total',
  'max_builds_total',
  'max_effect_operations_total',
  'max_facts_per_transaction',
  'max_frontier_bytes',
  'max_nesting_depth',
  'max_required_child_creations_per_t8',
] as const;

export const PRODUCT_FLOOR_BENCHMARK_KEYS = [
  'reference_machine_minimum',
  'minimum_memory_gib',
  'filesystem_type',
  'storage_class',
  'power_source',
  'build_kind',
  'concurrent_benchmark_interference',
  'warmup_iterations',
  'measurement_iterations',
  'scaling_profiles_percent',
  'required_report_metrics',
  'beyond_limit_rejection',
  't3_p99_budget_ms',
  't7_root_fence_p99_budget_ms',
  't8_required_child_p99_budget_ms',
  'max_to_p99_budget_multiplier',
] as const;

export interface LocalSingleUserProductFloor {
  profile_id: 'local_single_user_product_floor@1';
  deployment_profile: 'local_single_user';
  runtime_surface: 'node_service';
  platform: 'darwin';
  arch: 'arm64';
  semantics: 'minimum_certified_values';
  limits: { [Key in (typeof PRODUCT_FLOOR_LIMIT_KEYS)[number]]: number };
  benchmark_requirements: {
    reference_machine_minimum: 'apple_silicon_m2';
    minimum_memory_gib: number;
    filesystem_type: 'apfs';
    storage_class: 'internal_ssd';
    power_source: 'ac_power';
    build_kind: 'release';
    concurrent_benchmark_interference: 'forbidden';
    warmup_iterations: number;
    measurement_iterations: number;
    scaling_profiles_percent: readonly [25, 50, 100];
    required_report_metrics: readonly [
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'max_ms',
      'wal_bytes',
      'peak_rss_bytes',
      'affected_rows',
    ];
    beyond_limit_rejection: 'before_atomic_write';
    t3_p99_budget_ms: number;
    t7_root_fence_p99_budget_ms: number;
    t8_required_child_p99_budget_ms: number;
    max_to_p99_budget_multiplier: number;
  };
}

export const LOCAL_SINGLE_USER_PRODUCT_FLOOR = {
  profile_id: 'local_single_user_product_floor@1',
  deployment_profile: 'local_single_user',
  runtime_surface: 'node_service',
  platform: 'darwin',
  arch: 'arm64',
  semantics: 'minimum_certified_values',
  limits: {
    max_scopes_total: 128,
    max_nodes_total: 1024,
    max_nodes_per_scope: 128,
    max_edges_total: 4096,
    max_edges_per_scope: 512,
    max_map_items_total: 256,
    max_items_per_map: 128,
    max_attempts_total: 4096,
    max_waits_total: 512,
    max_builds_total: 512,
    max_effect_operations_total: 2048,
    max_facts_per_transaction: 16384,
    max_frontier_bytes: 16777216,
    max_nesting_depth: 8,
    max_required_child_creations_per_t8: 8,
  },
  benchmark_requirements: {
    reference_machine_minimum: 'apple_silicon_m2',
    minimum_memory_gib: 16,
    filesystem_type: 'apfs',
    storage_class: 'internal_ssd',
    power_source: 'ac_power',
    build_kind: 'release',
    concurrent_benchmark_interference: 'forbidden',
    warmup_iterations: 10,
    measurement_iterations: 100,
    scaling_profiles_percent: [25, 50, 100],
    required_report_metrics: [
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'max_ms',
      'wal_bytes',
      'peak_rss_bytes',
      'affected_rows',
    ],
    beyond_limit_rejection: 'before_atomic_write',
    t3_p99_budget_ms: 250,
    t7_root_fence_p99_budget_ms: 1000,
    t8_required_child_p99_budget_ms: 500,
    max_to_p99_budget_multiplier: 2,
  },
} as const satisfies LocalSingleUserProductFloor;

export const RETENTION_DURATION_KEYS = [
  'transient_payload_retention_ms',
  'run_recovery_closed_retention_ms',
  'workflow_audit_payload_retention_ms',
  'workflow_audit_metadata_retention_ms',
  'user_artifact_default_retention_ms',
  'retired_execution_registry_replay_retention_ms',
  'blob_temp_file_grace_ms',
  'blob_expired_write_intent_grace_ms',
  'blob_final_orphan_grace_ms',
  'inbox_rejected_late_unmatched_payload_retention_ms',
  'inbox_rejected_late_unmatched_audit_retention_ms',
  'closed_workflow_command_runtime_event_audit_retention_ms',
  'backup_default_expiry_ms',
  'pending_signal_safety_ttl_ms',
] as const;

export const RETENTION_RULE_KEYS = [
  'duration_origin',
  'run_recovery_strong_states',
  'user_artifact_not_before_workflow_closed',
  'pack_policy_may_only_extend_user_artifact',
  'manual_pin_may_extend_backup',
  'existing_objects_pin_policy_ref_and_hash',
] as const;

export interface LocalSingleUserRetentionPolicy {
  profile_id: 'local_single_user_retention@1';
  deployment_profile: 'local_single_user';
  mutability: 'immutable_versioned';
  durations_ms: { [Key in (typeof RETENTION_DURATION_KEYS)[number]]: number };
  rules: {
    duration_origin: 'entered_eligible_state_at_ms';
    run_recovery_strong_states: readonly [
      'active',
      'closing',
      'action_required',
      'quarantined',
    ];
    user_artifact_not_before_workflow_closed: true;
    pack_policy_may_only_extend_user_artifact: true;
    manual_pin_may_extend_backup: true;
    existing_objects_pin_policy_ref_and_hash: true;
  };
}

export const LOCAL_SINGLE_USER_RETENTION_POLICY = {
  profile_id: 'local_single_user_retention@1',
  deployment_profile: 'local_single_user',
  mutability: 'immutable_versioned',
  durations_ms: {
    transient_payload_retention_ms: 86400000,
    run_recovery_closed_retention_ms: 2592000000,
    workflow_audit_payload_retention_ms: 7776000000,
    workflow_audit_metadata_retention_ms: 31536000000,
    user_artifact_default_retention_ms: 31536000000,
    retired_execution_registry_replay_retention_ms: 7776000000,
    blob_temp_file_grace_ms: 86400000,
    blob_expired_write_intent_grace_ms: 86400000,
    blob_final_orphan_grace_ms: 86400000,
    inbox_rejected_late_unmatched_payload_retention_ms: 604800000,
    inbox_rejected_late_unmatched_audit_retention_ms: 2592000000,
    closed_workflow_command_runtime_event_audit_retention_ms: 31536000000,
    backup_default_expiry_ms: 2592000000,
    pending_signal_safety_ttl_ms: 604800000,
  },
  rules: {
    duration_origin: 'entered_eligible_state_at_ms',
    run_recovery_strong_states: [
      'active',
      'closing',
      'action_required',
      'quarantined',
    ],
    user_artifact_not_before_workflow_closed: true,
    pack_policy_may_only_extend_user_artifact: true,
    manual_pin_may_extend_backup: true,
    existing_objects_pin_policy_ref_and_hash: true,
  },
} as const satisfies LocalSingleUserRetentionPolicy;

export const SQLITE_PROFILE_KEYS = [
  'profile_id',
  'deployment_profile',
  'runtime_surface',
  'platform',
  'arch',
  'journal_mode',
  'synchronous',
  'foreign_keys',
  'busy_timeout_ms',
  'page_size',
  'auto_vacuum',
  'temp_store',
  'wal_autocheckpoint_pages',
  'journal_size_limit_bytes',
  'cache_size_kib',
  'mmap_size_bytes',
  'trusted_schema',
  'recursive_triggers',
  'read_uncommitted',
  'locking_mode',
  'read_only_query_only',
] as const;

export interface SQLiteExecutionProfile {
  profile_id: 'local_single_user_sqlite@1';
  deployment_profile: 'local_single_user';
  runtime_surface: 'node_service';
  platform: 'darwin';
  arch: 'arm64';
  journal_mode: 'wal';
  synchronous: 'full';
  foreign_keys: true;
  busy_timeout_ms: number;
  page_size: number;
  auto_vacuum: 'incremental';
  temp_store: 'memory';
  wal_autocheckpoint_pages: number;
  journal_size_limit_bytes: number;
  cache_size_kib: number;
  mmap_size_bytes: 0;
  trusted_schema: false;
  recursive_triggers: false;
  read_uncommitted: false;
  locking_mode: 'normal';
  read_only_query_only: true;
}

export const LOCAL_SINGLE_USER_SQLITE_PROFILE = {
  profile_id: 'local_single_user_sqlite@1',
  deployment_profile: 'local_single_user',
  runtime_surface: 'node_service',
  platform: 'darwin',
  arch: 'arm64',
  journal_mode: 'wal',
  synchronous: 'full',
  foreign_keys: true,
  busy_timeout_ms: 5000,
  page_size: 4096,
  auto_vacuum: 'incremental',
  temp_store: 'memory',
  wal_autocheckpoint_pages: 4096,
  journal_size_limit_bytes: 67108864,
  cache_size_kib: 32768,
  mmap_size_bytes: 0,
  trusted_schema: false,
  recursive_triggers: false,
  read_uncommitted: false,
  locking_mode: 'normal',
  read_only_query_only: true,
} as const satisfies SQLiteExecutionProfile;

export const ENFORCEMENT_RECORD_KEYS = [
  'limit_path',
  'business_limit_path',
  'resource_type',
  'account_scope',
  'consumer_kind',
  'enforcement_component',
  'reservation_point',
  'settlement_mode',
  'failure_code',
  'failure_outcome',
  'included_in_plan_hash',
  'supported_limit_path',
  't7_fence_dimension',
  'record_hash',
] as const;

export type EnforcementSettlementMode =
  | 'consume_on_create'
  | 'hold_then_release'
  | 'incremental'
  | null;

export interface WorkflowSafetyEnforcementRecordSeed {
  limit_path: string;
  business_limit_path: string | null;
  resource_type: string | null;
  account_scope: string | null;
  consumer_kind: string | null;
  enforcement_component: string;
  reservation_point: string | null;
  settlement_mode: EnforcementSettlementMode;
  failure_code: string;
  failure_outcome: string;
  included_in_plan_hash: boolean;
  supported_limit_path: string | null;
  t7_fence_dimension: string | null;
}

export interface WorkflowSafetyEnforcementRecord extends WorkflowSafetyEnforcementRecordSeed {
  record_hash: string;
}

const BUSINESS_LIMIT_PATHS: Record<string, string> = {
  'workflow.max_duration_ms': 'workflow_execution_policy.max_duration_ms',
  'workflow.max_state_activations':
    'workflow_execution_policy.max_state_activations',
  'workflow.max_graph_runs': 'workflow_execution_policy.max_graph_runs',
  'workflow.max_state_transitions':
    'workflow_execution_policy.max_state_transitions',
  'workflow.max_child_workflows_per_workflow':
    'workflow_execution_policy.max_child_workflows_per_workflow',
  'workflow.max_child_workflow_depth':
    'workflow_execution_policy.max_child_workflow_depth',
  'workflow.max_descendant_workflows_total':
    'workflow_execution_policy.max_descendant_workflows_total',
  'run.max_scopes_total': 'graph_policy.limits.max_scopes',
  'run.max_nodes_total': 'graph_policy.limits.max_nodes',
  'run.max_map_items_total': 'graph_policy.limits.max_map_items',
  'run.max_attempts_total': 'graph_policy.limits.max_total_attempts',
  'run.max_waits_total': 'graph_policy.limits.max_total_waits',
  'run.max_logical_output_bytes_total':
    'graph_policy.limits.max_total_output_bytes',
  'scope.max_nodes_per_scope': 'graph_policy.limits.max_nodes_per_scope',
  'scope.max_edges_per_scope': 'graph_policy.limits.max_edges_per_scope',
  'scope.max_scope_spec_bytes': 'graph_policy.limits.max_scope_spec_bytes',
  'scope.max_nesting_depth': 'graph_policy.limits.max_nesting_depth',
  'scope.max_frontier_bytes': 'graph_policy.limits.max_frontier_bytes',
  'map.max_items_per_map': 'map_node.requested_max_items',
  'map.max_child_concurrency_per_map': 'map_node.requested_child_concurrency',
  'execution.max_attempts_per_node': 'capability_retry_policy.max_attempts',
  'execution.max_attempt_duration_ms': 'node.timeout_ms',
  'execution.max_build_attempts_per_build':
    'graph_policy.build_retry.max_attempts',
  'execution.max_build_duration_ms': 'graph_policy.build_retry.max_duration_ms',
  'execution.max_outbox_attempts_per_message':
    'outbox_delivery_policy.max_delivery_attempts',
  'execution.max_outbox_reconcile_attempts_per_message':
    'outbox_delivery_policy.max_reconcile_attempts',
  'execution.max_outbox_attempt_duration_ms':
    'outbox_delivery_policy.attempt_timeout_ms',
  'execution.max_outbox_delivery_duration_ms':
    'outbox_delivery_policy.delivery_duration_ms',
  'execution.max_root_finalization_attempts_per_schedule':
    'root_finalization_policy.max_attempts',
  'execution.max_root_finalization_duration_ms':
    'root_finalization_policy.max_duration_ms',
  'execution.max_operational_remediation_attempts_per_blocker':
    'operational_remediation_policy.max_attempts',
  'execution.max_operational_remediation_duration_ms':
    'operational_remediation_policy.max_duration_ms',
  'wait.max_finite_wait_duration_ms':
    'graph_policy.limits.max_wait_duration_ms',
  'wait.max_pending_signals_per_run': 'graph_policy.limits.max_pending_signals',
  'reconciliation.max_condition_steps_per_evaluation':
    'graph_policy.limits.max_condition_steps',
  'reconciliation.max_facts_per_transaction':
    'graph_policy.limits.max_fixed_point_facts',
};

const SUPPORTED_LIMIT_PATHS: Record<string, string> = {
  'run.max_scopes_total': 'supported.max_scopes_total',
  'run.max_nodes_total': 'supported.max_nodes_total',
  'run.max_edges_total': 'supported.max_edges_total',
  'run.max_map_items_total': 'supported.max_map_items_total',
  'run.max_attempts_total': 'supported.max_attempts_total',
  'run.max_waits_total': 'supported.max_waits_total',
  'run.max_builds_total': 'supported.max_builds_total',
  'run.max_effect_operations_total': 'supported.max_effect_operations_total',
  'scope.max_nodes_per_scope': 'supported.max_nodes_total',
  'scope.max_edges_per_scope': 'supported.max_edges_total',
  'scope.max_frontier_bytes': 'supported.max_frontier_bytes',
  'reconciliation.max_facts_per_transaction':
    'supported.max_facts_per_transaction',
  'workflow.max_required_child_creations_per_transition':
    'supported.max_required_child_creations_per_t8',
};

const T7_FENCE_DIMENSIONS: Record<string, string> = {
  'run.max_scopes_total': 'supported.max_subtree_scopes_per_fence',
  'run.max_nodes_total': 'supported.max_subtree_nodes_per_fence',
  'run.max_edges_total': 'supported.max_subtree_edges_per_fence',
  'run.max_attempts_total': 'supported.max_subtree_attempts_per_fence',
  'run.max_waits_total': 'supported.max_subtree_waits_per_fence',
  'run.max_builds_total': 'supported.max_subtree_builds_per_fence',
  'run.max_map_items_total': 'supported.max_subtree_map_slots_per_fence',
  'run.max_effect_operations_total': 'supported.max_subtree_effects_per_fence',
};

function baseSeed(
  limitPath: string,
  values: Omit<
    WorkflowSafetyEnforcementRecordSeed,
    | 'limit_path'
    | 'business_limit_path'
    | 'included_in_plan_hash'
    | 'supported_limit_path'
    | 't7_fence_dimension'
  >,
): WorkflowSafetyEnforcementRecordSeed {
  return {
    limit_path: limitPath,
    business_limit_path: BUSINESS_LIMIT_PATHS[limitPath] ?? null,
    resource_type: values.resource_type,
    account_scope: values.account_scope,
    consumer_kind: values.consumer_kind,
    enforcement_component: values.enforcement_component,
    reservation_point: values.reservation_point,
    settlement_mode: values.settlement_mode,
    failure_code: values.failure_code,
    failure_outcome: values.failure_outcome,
    included_in_plan_hash: true,
    supported_limit_path: SUPPORTED_LIMIT_PATHS[limitPath] ?? null,
    t7_fence_dimension: T7_FENCE_DIMENSIONS[limitPath] ?? null,
  };
}

function runSeed(limitPath: string): WorkflowSafetyEnforcementRecordSeed {
  const field = limitPath.slice('run.'.length);
  const resourceType = field.replace(/^max_/, '');
  const isBytes = field.includes('bytes');
  const isOutput = field === 'max_logical_output_bytes_total';
  return baseSeed(limitPath, {
    resource_type: resourceType,
    account_scope: 'graph_run',
    consumer_kind: isBytes ? 'stored_value_or_output' : 'runtime_object',
    enforcement_component: isBytes
      ? 'value_store_coordinator'
      : 'resource_ledger',
    reservation_point: isBytes
      ? 'value_intent_before_publish'
      : 'object_creation_before_insert',
    settlement_mode: isBytes ? 'incremental' : 'consume_on_create',
    failure_code: isOutput
      ? 'output_value_contract_failure'
      : 'resource_limit_exceeded',
    failure_outcome: isOutput
      ? 'output_or_value_contract_failure'
      : 'root_engine_error_or_child_owner_failure',
  });
}

function executionSeed(limitPath: string): WorkflowSafetyEnforcementRecordSeed {
  const field = limitPath.slice('execution.'.length);
  const isDuration =
    field.includes('duration') ||
    field.includes('backoff') ||
    field.includes('timeout');
  const isAttemptCount = field.includes('attempts');
  const family = field.includes('root_finalization')
    ? 'root_finalization'
    : field.includes('operational_remediation')
      ? 'operational_remediation'
      : field.includes('outbox')
        ? 'outbox'
        : field.includes('evaluator')
          ? 'evaluator'
          : field.includes('build')
            ? 'scope_build'
            : 'node_attempt';
  const attemptAccount = {
    node_attempt: {
      resource_type: 'attempts_total',
      account_scope: 'graph_node',
      consumer_kind: 'node_attempt',
    },
    scope_build: {
      resource_type: 'build_attempts_total',
      account_scope: 'scope_build',
      consumer_kind: 'scope_build_attempt',
    },
    evaluator: {
      resource_type: 'evaluator_attempts_total',
      account_scope: 'evaluation',
      consumer_kind: 'evaluator_attempt',
    },
    outbox: {
      resource_type: field.includes('reconcile')
        ? 'reconcile_attempts'
        : 'delivery_attempts',
      account_scope: 'outbox_message',
      consumer_kind: 'outbox_attempt',
    },
    root_finalization: {
      resource_type: 'root_finalization_attempts',
      account_scope: 'root_finalization_schedule',
      consumer_kind: 'root_finalization_attempt',
    },
    operational_remediation: {
      resource_type: 'operational_remediation_attempts',
      account_scope: 'operational_blocker',
      consumer_kind: 'operational_remediation_attempt',
    },
  }[family];
  const attemptPoint = {
    node_attempt: 'T4_before_attempt_create',
    scope_build: 'scope_build_attempt_before_start',
    evaluator: 'before_evaluator_invocation',
    outbox: 'before_outbox_delivery_or_reconcile_attempt',
    root_finalization: 'before_root_finalization_attempt',
    operational_remediation: 'T6e_before_remediation_attempt',
  }[family];
  const deadlinePoint = {
    node_attempt: 'attempt_deadline_or_backoff_freeze',
    scope_build: 'scope_build_deadline_freeze',
    evaluator: 'evaluation_deadline_freeze',
    outbox: 'outbox_deadline_or_timeout_freeze',
    root_finalization: 'root_finalization_deadline_freeze',
    operational_remediation: 'remediation_deadline_freeze',
  }[family];
  return baseSeed(limitPath, {
    resource_type: isAttemptCount ? attemptAccount.resource_type : null,
    account_scope: isAttemptCount ? attemptAccount.account_scope : null,
    consumer_kind: isAttemptCount ? attemptAccount.consumer_kind : null,
    enforcement_component: `${family}_coordinator`,
    reservation_point: isDuration ? deadlinePoint : attemptPoint,
    settlement_mode: isAttemptCount ? 'consume_on_create' : null,
    failure_code: `${family}_safety_limit_exceeded`,
    failure_outcome:
      family === 'outbox'
        ? 'dead_letter_or_action_required'
        : family === 'root_finalization'
          ? 'schedule_exhausted_action_required'
          : family === 'operational_remediation'
            ? 'blocker_remains_open'
            : 'retry_stopped_or_execution_failed',
  });
}

function safetySeed(limitPath: string): WorkflowSafetyEnforcementRecordSeed {
  const [group, field] = limitPath.split('.') as [string, string];
  if (group === 'run') return runSeed(limitPath);
  if (group === 'execution') return executionSeed(limitPath);
  if (group === 'routing') {
    const routeHop = field === 'max_route_hops';
    const taskBytes = field === 'max_task_input_bytes';
    return baseSeed(limitPath, {
      resource_type: null,
      account_scope: null,
      consumer_kind: null,
      enforcement_component: taskBytes
        ? 'task_intake_resolver'
        : routeHop
          ? 'routing_resolver'
          : 'schema_registry_validator',
      reservation_point: taskBytes
        ? 'T0_ingress_before_freeze'
        : routeHop
          ? 'T0_before_each_route_hop'
          : 'registry_publish_and_validation_preflight',
      settlement_mode: null,
      failure_code: taskBytes
        ? 'routing_task_input_limit_exceeded'
        : routeHop
          ? 'routing_hop_limit_exceeded'
          : 'routing_schema_limit_exceeded',
      failure_outcome:
        taskBytes || routeHop
          ? 'request_rejected'
          : 'registry_publication_or_request_rejected',
    });
  }
  if (group === 'workflow') {
    if (field === 'max_duration_ms') {
      return baseSeed(limitPath, {
        resource_type: null,
        account_scope: null,
        consumer_kind: null,
        enforcement_component: 'g7_workflow_deadline_watchdog',
        reservation_point: 'T0_deadline_freeze_and_G7_gateway_T7c_enforcement',
        settlement_mode: null,
        failure_code: 'workflow_duration_limit_exceeded',
        failure_outcome: 'global_workflow_cancel',
      });
    }
    if (field === 'max_required_child_creations_per_transition') {
      return baseSeed(limitPath, {
        resource_type: null,
        account_scope: null,
        consumer_kind: null,
        enforcement_component: 'root_finalization_coordinator',
        reservation_point:
          'definition_publish_schedule_create_and_T8_preflight',
        settlement_mode: null,
        failure_code: 'required_child_creation_limit_exceeded',
        failure_outcome: 'definition_rejected_or_root_action_required',
      });
    }
    if (field === 'max_child_workflow_depth') {
      return baseSeed(limitPath, {
        resource_type: null,
        account_scope: null,
        consumer_kind: null,
        enforcement_component: 'workflow_lineage_creation_preflight',
        reservation_point: 'T0_or_T8_before_child_workflow_create',
        settlement_mode: null,
        failure_code: 'child_workflow_depth_limit_exceeded',
        failure_outcome: 'child_workflow_creation_rejected',
      });
    }
    const resourceTypeByField: Record<string, string> = {
      max_state_activations: 'state_activations_total',
      max_graph_runs: 'graph_runs_total',
      max_state_transitions: 'state_transitions_total',
      max_child_workflows_per_workflow: 'child_workflows_total',
      max_descendant_workflows_total: 'descendant_workflows_total',
    };
    const resourceType = resourceTypeByField[field];
    if (!resourceType) {
      throw new Error(`Unhandled workflow ledger limit: ${limitPath}`);
    }
    return baseSeed(limitPath, {
      resource_type: resourceType,
      account_scope: field.includes('descendant')
        ? 'root_workflow_lineage'
        : 'workflow_lifetime',
      consumer_kind: 'workflow_activation_transition_or_child',
      enforcement_component: 'workflow_creation_and_transition_coordinator',
      reservation_point: 'T0_T1_or_T8_before_create',
      settlement_mode: 'consume_on_create',
      failure_code: 'resource_limit_exceeded',
      failure_outcome: 'creation_or_transition_rejected',
    });
  }
  if (group === 'scope') {
    const ledgerManaged =
      field === 'max_nodes_per_scope' || field === 'max_edges_per_scope';
    return baseSeed(limitPath, {
      resource_type: ledgerManaged
        ? field.replace(/^max_/, '').replace('_per_scope', '_total')
        : null,
      account_scope: ledgerManaged ? 'graph_scope' : null,
      consumer_kind: ledgerManaged ? 'scope_materialization' : null,
      enforcement_component: ledgerManaged
        ? 'resource_ledger'
        : 'graph_compiler_and_materializer',
      reservation_point: ledgerManaged
        ? 'T2b_before_scope_materialization'
        : 'compile_and_T2b_or_T7_preflight',
      settlement_mode: ledgerManaged ? 'consume_on_create' : null,
      failure_code: 'runtime_safety_limit_exceeded',
      failure_outcome: 'compile_or_materialization_rejected',
    });
  }
  if (group === 'map') {
    const concurrency = field === 'max_child_concurrency_per_map';
    return baseSeed(limitPath, {
      resource_type: concurrency ? 'active_executions' : 'map_items_total',
      account_scope: 'map_node',
      consumer_kind: concurrency ? 'map_child_attempt' : 'map_item_slot',
      enforcement_component: concurrency
        ? 'scheduler_admission'
        : 'map_manifest_coordinator',
      reservation_point: concurrency
        ? 'scheduler_before_map_child_admission'
        : 'T4_before_expansion_manifest_seal',
      settlement_mode: concurrency ? 'hold_then_release' : 'consume_on_create',
      failure_code: concurrency
        ? 'map_child_concurrency_backpressure'
        : 'map_item_limit_exceeded',
      failure_outcome: concurrency ? 'ready_backpressure' : 'map_node_failed',
    });
  }
  if (group === 'registry') {
    return baseSeed(limitPath, {
      resource_type: null,
      account_scope: null,
      consumer_kind: null,
      enforcement_component: 'registry_publisher_and_snapshot_builder',
      reservation_point: 'publish_or_run_snapshot_preflight',
      settlement_mode: null,
      failure_code: 'registry_safety_limit_exceeded',
      failure_outcome: 'publication_or_workflow_creation_rejected',
    });
  }
  if (group === 'wait') {
    if (field.startsWith('max_pending_signals_per_')) {
      const scope = field.slice('max_pending_signals_per_'.length);
      return baseSeed(limitPath, {
        resource_type: 'pending_signals',
        account_scope: `pending_signal_${scope}`,
        consumer_kind: 'inbox_event',
        enforcement_component: 'wait_inbox_ingress',
        reservation_point: 'inbox_ingress_before_pending_insert',
        settlement_mode: 'hold_then_release',
        failure_code: 'pending_signal_limit_exceeded',
        failure_outcome: 'inbox_ingress_rejected',
      });
    }
    const age = field === 'max_pending_signal_age_ms';
    return baseSeed(limitPath, {
      resource_type: null,
      account_scope: null,
      consumer_kind: null,
      enforcement_component: age
        ? 'pending_signal_sweeper'
        : 'wait_contract_validator_and_ingress',
      reservation_point: age
        ? 'ingress_expiry_freeze_and_sweeper'
        : 'compile_ingress_or_wait_arm_preflight',
      settlement_mode: null,
      failure_code: age
        ? 'pending_signal_age_exceeded'
        : 'wait_contract_limit_exceeded',
      failure_outcome: age
        ? 'unmatched_expired'
        : 'compile_arm_or_ingress_rejected',
    });
  }
  if (group === 'reconciliation') {
    return baseSeed(limitPath, {
      resource_type: null,
      account_scope: null,
      consumer_kind: null,
      enforcement_component: 'graph_compiler_and_reconciler',
      reservation_point: 'compile_complexity_proof_and_T3_preflight',
      settlement_mode: null,
      failure_code: 'runtime_safety_limit_exceeded',
      failure_outcome:
        field === 'max_condition_steps_per_evaluation'
          ? 'compile_rejected_or_condition_error'
          : 'compile_or_materialization_rejected',
    });
  }
  if (group === 'value') {
    return baseSeed(limitPath, {
      resource_type: null,
      account_scope: null,
      consumer_kind: null,
      enforcement_component: 'value_and_artifact_store',
      reservation_point: 'snapshot_or_publish_before_value_intent',
      settlement_mode: null,
      failure_code: field.includes('artifact')
        ? 'artifact_contract_failure'
        : 'value_contract_failure',
      failure_outcome: 'value_or_artifact_contract_failure',
    });
  }
  throw new Error(`Unhandled safety limit path: ${limitPath}`);
}

function capacitySeed(limitPath: string): WorkflowSafetyEnforcementRecordSeed {
  const field = limitPath.slice('capacity.'.length);
  const liveSlot = [
    'max_active_executions',
    'max_active_waits',
    'max_pending_signals',
    'max_outbox_inflight',
  ].includes(field);
  const hardBlob = field === 'max_physical_blob_bytes';
  return {
    limit_path: limitPath,
    business_limit_path: null,
    resource_type: liveSlot
      ? field.replace(/^max_/, '')
      : hardBlob
        ? 'physical_blob_bytes'
        : null,
    account_scope: liveSlot || hardBlob ? 'deployment_capacity' : null,
    consumer_kind: liveSlot
      ? 'live_admission'
      : hardBlob
        ? 'blob_write_intent'
        : null,
    enforcement_component:
      hardBlob || field.includes('blob') || field.includes('disk')
        ? 'blob_store_coordinator'
        : 'scheduler_or_ingress_admission',
    reservation_point: liveSlot
      ? 'live_admission_before_claim_or_arm'
      : 'blob_allocation_preflight_and_gc',
    settlement_mode: liveSlot || hardBlob ? 'hold_then_release' : null,
    failure_code: hardBlob
      ? 'physical_blob_capacity_exceeded'
      : liveSlot
        ? 'deployment_capacity_backpressure'
        : 'blob_watermark_or_free_disk_limit_reached',
    failure_outcome: hardBlob
      ? 'blob_allocation_backpressure_or_action_required'
      : liveSlot
        ? 'ready_or_pending_backpressure'
        : 'gc_throttle_or_new_allocation_rejected',
    included_in_plan_hash: false,
    supported_limit_path: null,
    t7_fence_dimension: null,
  };
}

export const SAFETY_ENFORCEMENT_RECORD_SEEDS = [
  ...SAFETY_LIMIT_PATHS.map(safetySeed),
  ...CAPACITY_LIMIT_PATHS.map(capacitySeed),
].sort((left, right) =>
  left.limit_path < right.limit_path
    ? -1
    : left.limit_path > right.limit_path
      ? 1
      : 0,
);
