import { buildSafetyEnforcementRecords } from './safety-sqlite-artifacts.js';
import type { JsonValue } from './types.js';

export type SafetySqliteFixtureTarget =
  | 'icarus.workflow-runtime-safety-profile/1'
  | 'icarus.deployment-runtime-capacity/1'
  | 'icarus.workflow-runtime-product-floor/1'
  | 'icarus.workflow-runtime-retention-policy/1'
  | 'icarus.workflow-safety-enforcement-matrix/1'
  | 'icarus.sqlite-execution-profile/1';

export interface SafetySqlitePositiveCase {
  case_id: string;
  target_format: SafetySqliteFixtureTarget;
  assertion:
    | 'valid_exact_contract'
    | 'complete_per_field_enforcement'
    | 'candidate_identity_unbound';
}

export type SafetySqliteMutation =
  | { operation: 'add'; pointer: string; value: JsonValue }
  | { operation: 'remove'; pointer: string }
  | { operation: 'replace'; pointer: string; value: JsonValue };

export interface SafetySqliteNegativeCase {
  case_id: string;
  target_format: SafetySqliteFixtureTarget;
  mutation: SafetySqliteMutation;
  expected_stage: 'schema' | 'semantic';
  expected_keyword: string | null;
  expected_instance_pointer: string | null;
  expected_code: 'safety_sqlite_contract_drift';
}

export const SAFETY_SQLITE_POSITIVE_CASES = [
  {
    case_id: 'safety_profile_exact',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    assertion: 'valid_exact_contract',
  },
  {
    case_id: 'deployment_capacity_exact',
    target_format: 'icarus.deployment-runtime-capacity/1',
    assertion: 'valid_exact_contract',
  },
  {
    case_id: 'product_floor_exact',
    target_format: 'icarus.workflow-runtime-product-floor/1',
    assertion: 'valid_exact_contract',
  },
  {
    case_id: 'retention_policy_exact',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
    assertion: 'valid_exact_contract',
  },
  {
    case_id: 'enforcement_matrix_complete',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    assertion: 'complete_per_field_enforcement',
  },
  {
    case_id: 'sqlite_profile_candidate_exact',
    target_format: 'icarus.sqlite-execution-profile/1',
    assertion: 'valid_exact_contract',
  },
  {
    case_id: 'sqlite_candidate_release_identity_unbound',
    target_format: 'icarus.sqlite-execution-profile/1',
    assertion: 'candidate_identity_unbound',
  },
] as const satisfies readonly SafetySqlitePositiveCase[];

const records = buildSafetyEnforcementRecords();
const firstSafetyIndex = records.findIndex((record) =>
  record.limit_path.startsWith('execution.'),
);
const secondSafetyIndex = firstSafetyIndex + 1;
const capacityIndex = records.findIndex((record) =>
  record.limit_path.startsWith('capacity.'),
);

if (firstSafetyIndex < 0 || capacityIndex < 0) {
  throw new Error('G0.5 fixture record anchors are missing');
}

export const SAFETY_SQLITE_NEGATIVE_CASES = [
  {
    case_id: 'safety_rejects_missing_leaf',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    mutation: {
      operation: 'remove',
      pointer: '/ceilings/run/max_nodes_total',
    },
    expected_stage: 'schema',
    expected_keyword: 'required',
    expected_instance_pointer: '/ceilings/run',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'safety_rejects_unknown_leaf',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    mutation: {
      operation: 'add',
      pointer: '/ceilings/run/max_hidden_work_total',
      value: 1,
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/ceilings/run',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'safety_rejects_zero_ceiling',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/ceilings/execution/max_attempts_per_node',
      value: 0,
    },
    expected_stage: 'schema',
    expected_keyword: 'minimum',
    expected_instance_pointer: '/ceilings/execution/max_attempts_per_node',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'safety_rejects_baseline_value_drift',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/ceilings/run/max_nodes_total',
      value: 1023,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'safety_rejects_graph_run_terminal_reserve_loss',
    target_format: 'icarus.workflow-runtime-safety-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/ceilings/workflow/max_graph_runs',
      value: 128,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'capacity_rejects_unknown_field',
    target_format: 'icarus.deployment-runtime-capacity/1',
    mutation: {
      operation: 'add',
      pointer: '/max_scheduler_priority',
      value: 5,
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'capacity_rejects_zero_live_slot',
    target_format: 'icarus.deployment-runtime-capacity/1',
    mutation: {
      operation: 'replace',
      pointer: '/max_active_executions',
      value: 0,
    },
    expected_stage: 'schema',
    expected_keyword: 'minimum',
    expected_instance_pointer: '/max_active_executions',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'capacity_rejects_soft_water_above_hard_limit',
    target_format: 'icarus.deployment-runtime-capacity/1',
    mutation: {
      operation: 'replace',
      pointer: '/soft_blob_high_water_bytes',
      value: 21474836481,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'capacity_rejects_hash_mismatch',
    target_format: 'icarus.deployment-runtime-capacity/1',
    mutation: {
      operation: 'replace',
      pointer: '/config_hash',
      value: `sha256:${'0'.repeat(64)}`,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'product_floor_rejects_missing_dimension',
    target_format: 'icarus.workflow-runtime-product-floor/1',
    mutation: {
      operation: 'remove',
      pointer: '/limits/max_facts_per_transaction',
    },
    expected_stage: 'schema',
    expected_keyword: 'required',
    expected_instance_pointer: '/limits',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'product_floor_rejects_below_floor_value',
    target_format: 'icarus.workflow-runtime-product-floor/1',
    mutation: {
      operation: 'replace',
      pointer: '/limits/max_nodes_total',
      value: 1023,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'product_floor_rejects_short_benchmark_sample',
    target_format: 'icarus.workflow-runtime-product-floor/1',
    mutation: {
      operation: 'replace',
      pointer: '/benchmark_requirements/measurement_iterations',
      value: 99,
    },
    expected_stage: 'schema',
    expected_keyword: 'minimum',
    expected_instance_pointer: '/benchmark_requirements/measurement_iterations',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'product_floor_rejects_concurrent_benchmark_interference',
    target_format: 'icarus.workflow-runtime-product-floor/1',
    mutation: {
      operation: 'replace',
      pointer: '/benchmark_requirements/concurrent_benchmark_interference',
      value: 'allowed',
    },
    expected_stage: 'schema',
    expected_keyword: 'const',
    expected_instance_pointer:
      '/benchmark_requirements/concurrent_benchmark_interference',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'retention_rejects_unknown_duration',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
    mutation: {
      operation: 'add',
      pointer: '/durations_ms/forever_ms',
      value: 31536000000,
    },
    expected_stage: 'schema',
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/durations_ms',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'retention_rejects_zero_duration',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
    mutation: {
      operation: 'replace',
      pointer: '/durations_ms/transient_payload_retention_ms',
      value: 0,
    },
    expected_stage: 'schema',
    expected_keyword: 'minimum',
    expected_instance_pointer: '/durations_ms/transient_payload_retention_ms',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'retention_rejects_shortened_audit_metadata',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
    mutation: {
      operation: 'replace',
      pointer: '/durations_ms/workflow_audit_metadata_retention_ms',
      value: 31535999999,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'retention_rejects_missing_quarantine_strong_state',
    target_format: 'icarus.workflow-runtime-retention-policy/1',
    mutation: {
      operation: 'remove',
      pointer: '/rules/run_recovery_strong_states/3',
    },
    expected_stage: 'schema',
    expected_keyword: 'minItems',
    expected_instance_pointer: '/rules/run_recovery_strong_states',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_certified_claim',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/certification_status',
      value: 'certified',
    },
    expected_stage: 'schema',
    expected_keyword: 'const',
    expected_instance_pointer: '/certification_status',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_development_sqlite_identity',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/sqlite_version',
      value: '3.50.4',
    },
    expected_stage: 'schema',
    expected_keyword: 'type',
    expected_instance_pointer: '/sqlite_version',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_negative_mmap',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/mmap_size_bytes',
      value: -1,
    },
    expected_stage: 'schema',
    expected_keyword: 'const',
    expected_instance_pointer: '/mmap_size_bytes',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_query_only_disabled',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/read_only_query_only',
      value: false,
    },
    expected_stage: 'schema',
    expected_keyword: 'const',
    expected_instance_pointer: '/read_only_query_only',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_distribution_hash_drift',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/managed_node_distribution_hash',
      value: `sha256:${'0'.repeat(64)}`,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'sqlite_rejects_mutable_distribution_ref',
    target_format: 'icarus.sqlite-execution-profile/1',
    mutation: {
      operation: 'replace',
      pointer: '/managed_node_distribution_ref/version',
      value: 'latest',
    },
    expected_stage: 'schema',
    expected_keyword: 'not',
    expected_instance_pointer: '/managed_node_distribution_ref/version',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_missing_record',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'remove',
      pointer: `/records/${firstSafetyIndex}`,
    },
    expected_stage: 'schema',
    expected_keyword: 'minItems',
    expected_instance_pointer: '/records',
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_duplicate_limit_owner',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${secondSafetyIndex}/limit_path`,
      value: records[firstSafetyIndex]!.limit_path,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_wildcard_limit',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${firstSafetyIndex}/limit_path`,
      value: 'execution.*',
    },
    expected_stage: 'schema',
    expected_keyword: 'pattern',
    expected_instance_pointer: `/records/${firstSafetyIndex}/limit_path`,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_missing_check_point',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${firstSafetyIndex}/reservation_point`,
      value: null,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_safety_not_in_plan_hash',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${firstSafetyIndex}/included_in_plan_hash`,
      value: false,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_capacity_in_plan_hash',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${capacityIndex}/included_in_plan_hash`,
      value: true,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
  {
    case_id: 'matrix_rejects_record_hash_drift',
    target_format: 'icarus.workflow-safety-enforcement-matrix/1',
    mutation: {
      operation: 'replace',
      pointer: `/records/${firstSafetyIndex}/record_hash`,
      value: `sha256:${'0'.repeat(64)}`,
    },
    expected_stage: 'semantic',
    expected_keyword: null,
    expected_instance_pointer: null,
    expected_code: 'safety_sqlite_contract_drift',
  },
] as const satisfies readonly SafetySqliteNegativeCase[];
