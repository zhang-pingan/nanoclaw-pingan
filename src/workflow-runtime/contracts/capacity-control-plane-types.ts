import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
  LogicalForeignKeyMetadata,
  LogicalIndexMetadata,
  LogicalPrimaryKeyMetadata,
  LogicalQueryIntent,
  LogicalUniqueKeyMetadata,
} from './logical-schema-types.js';
import type { DeploymentRuntimeCapacity } from './safety-sqlite-types.js';
import type { Sha256Hash } from './types.js';

export const CAPACITY_CHANGE_REASON_CODES = [
  'initial_provisioning',
  'planned_tuning',
  'incident_mitigation',
  'host_resource_change',
  'storage_pressure',
  'rollback',
] as const;
export type CapacityChangeReasonCode =
  (typeof CAPACITY_CHANGE_REASON_CODES)[number];

export const CAPACITY_ADMIN_DENIAL_CODES = [
  'permission_denied',
  'actor_kind_denied',
  'capacity_already_initialized',
  'capacity_snapshot_invalid',
  'capacity_transition_invalid',
  'expected_capacity_revision_conflict',
  'expected_config_hash_conflict',
  'capacity_change_in_progress',
  'idempotency_conflict',
  'audit_unavailable',
  'publication_failed',
] as const;
export type CapacityAdminDenialCode =
  (typeof CAPACITY_ADMIN_DENIAL_CODES)[number];

export const CAPACITY_ADMIN_COMMAND_TYPES = [
  'initialize_deployment_capacity',
  'replace_deployment_capacity',
] as const;
export type CapacityAdminCommandType =
  (typeof CAPACITY_ADMIN_COMMAND_TYPES)[number];

export const CAPACITY_ADMIN_EXECUTION_RESULTS = [
  'prepared',
  'applied',
  'denied',
  'conflict',
  'duplicate',
  'failed',
] as const;
export type CapacityAdminExecutionResult =
  (typeof CAPACITY_ADMIN_EXECUTION_RESULTS)[number];

export interface CapacityAdminInvocationLifecycleCandidate {
  invocation_no: number;
  submitted_request_matches_command: boolean;
  command_result_state: 'pending' | 'finalized';
  authorization_result: 'allowed' | 'denied';
  execution_result: CapacityAdminExecutionResult;
  denial_code: CapacityAdminDenialCode | null;
  requested_at_ms: number;
  decided_at_ms: number;
  applied_at_ms: number | null;
}

export const CAPACITY_ADMIN_ACTOR_KINDS = [
  'human',
  'feature_service',
  'automation',
  'system',
] as const;
export type CapacityAdminActorKind =
  (typeof CAPACITY_ADMIN_ACTOR_KINDS)[number];

export const CAPACITY_ADMIN_PERMISSION_CODES = [
  'runtime.capacity.manage',
] as const;
export type CapacityAdminPermissionCode =
  (typeof CAPACITY_ADMIN_PERMISSION_CODES)[number];

export const CAPACITY_ADMIN_HUMAN_ENTRYPOINTS = [
  'runtime_center',
  'cli',
  'deployment_tool',
] as const;
export type CapacityAdminHumanEntrypoint =
  (typeof CAPACITY_ADMIN_HUMAN_ENTRYPOINTS)[number];

export type DeploymentRuntimeCapacitySnapshot = Omit<
  DeploymentRuntimeCapacity,
  'config_hash'
> & {
  config_hash: Sha256Hash;
};

export interface DeploymentRuntimeCapacityPublication {
  format: 'icarus.deployment-runtime-capacity-publication/1';
  deployment_profile: 'local_single_user';
  capacity_revision: number;
  capacity_change_id: string;
  previous_config_hash: Sha256Hash | null;
  capacity: DeploymentRuntimeCapacitySnapshot;
  publication_hash: Sha256Hash;
}

export interface InitializeDeploymentCapacityCommand {
  command_type: 'initialize_deployment_capacity';
  command_id: string;
  idempotency_key: string;
  proposed_capacity: DeploymentRuntimeCapacitySnapshot;
  reason_code: 'initial_provisioning';
  core_release_hash: Sha256Hash;
  evidence_refs: string[];
}

export interface ReplaceDeploymentCapacityCommand {
  command_type: 'replace_deployment_capacity';
  command_id: string;
  idempotency_key: string;
  expected_capacity_revision: number;
  expected_config_hash: Sha256Hash;
  proposed_capacity: DeploymentRuntimeCapacitySnapshot;
  reason_code: Exclude<CapacityChangeReasonCode, 'initial_provisioning'>;
  reason_text: string;
  evidence_refs: string[];
}

export type CapacityAdminCommand =
  | InitializeDeploymentCapacityCommand
  | ReplaceDeploymentCapacityCommand;

export interface CapacityLogicalTableDelta {
  ordinal: number;
  name:
    | 'runtime_capacity_head'
    | 'runtime_capacity_admin_commands'
    | 'runtime_capacity_admin_invocations'
    | 'runtime_capacity_change_events';
  source_section: 'Capacity management publication and audit';
  columns: LogicalColumnMetadata[];
  primary_key: LogicalPrimaryKeyMetadata;
  foreign_keys: LogicalForeignKeyMetadata[];
  unique_keys: LogicalUniqueKeyMetadata[];
  checks: LogicalCheckMetadata[];
  indexes: LogicalIndexMetadata[];
}

export interface CapacityLogicalExtendedTableDelta {
  name: 'workflow_graph_scheduler_admissions';
  base_table_hash: Sha256Hash;
  added_columns: LogicalColumnMetadata[];
  added_foreign_keys: LogicalForeignKeyMetadata[];
  added_unique_keys: LogicalUniqueKeyMetadata[];
  added_checks: LogicalCheckMetadata[];
  added_indexes: LogicalIndexMetadata[];
}

export interface CapacityLogicalSchemaDelta {
  format: 'icarus.workflow-capacity-control-plane-logical-schema-delta/1';
  schema_id: 'workflow-runtime-schema-v1';
  base_logical_schema_manifest_hash: Sha256Hash;
  delta_mode: 'additive_only';
  contract_stage: 'logical_metadata';
  executable_status: 'non_executable';
  ddl_generation_status: 'forbidden_in_g0_10';
  sqlite_open_status: 'forbidden_in_g0_10';
  added_tables: CapacityLogicalTableDelta[];
  extended_tables: CapacityLogicalExtendedTableDelta[];
  query_intents: LogicalQueryIntent[];
  invariants: string[];
  delta_hash: Sha256Hash;
}
