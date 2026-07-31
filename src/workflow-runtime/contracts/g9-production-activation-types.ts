import type {
  G8ReleaseInventoryEntry,
  G8StartupSmokeReport,
  G8ReadinessReport,
} from './g8-validation-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const G9_PRODUCTION_RELEASE_MANIFEST_FORMAT =
  'icarus.core-production-release-manifest/1' as const;
export const G9_PRODUCTION_RELEASE_REF = {
  id: 'icarus.core',
  version: '1.2.14-g9.1',
} as const;
export const G9_PRODUCTION_RELEASE_MANIFEST_FILENAME =
  'core-production-release-manifest.json' as const;
export const G9_PRODUCTION_RELEASE_MANIFEST_OUTPUT =
  'src/workflow-runtime/contracts/certification/production-candidate/generated/core-production-release-manifest@1.json' as const;
export const G9_PRODUCTION_CORE_BINDING_OUTPUT =
  'src/workflow-runtime/contracts/certification/production-candidate/generated/core-runtime-launch-binding-v3@1.json' as const;
export const G9_PRODUCTION_ACTIVATION_ENTRY =
  'dist/workflow-runtime/registry/production-activation-entry.js' as const;

export interface G9ProductionCoreReleaseManifest {
  readonly format: typeof G9_PRODUCTION_RELEASE_MANIFEST_FORMAT;
  readonly ref: VersionedRef;
  readonly release_scope: 'workflow_runtime_g9_production_candidate';
  readonly build_kind: 'release';
  readonly activation_status: 'pending_fresh_independent_g8_boundary';
  readonly historical_g8_release_artifact_hash: Sha256Hash;
  readonly g9_activation_contract_hash: Sha256Hash;
  readonly static_source_core_build_hash: Sha256Hash;
  readonly workflow_runtime_absence_baseline_hash: Sha256Hash;
  readonly product_surface_coverage_manifest_hash: Sha256Hash;
  readonly migration_candidate_boundary_manifest_hash: Sha256Hash;
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly run_protocol_majors: readonly [1];
  readonly executor_abi_majors: readonly [1];
  readonly database_schema_version: 11;
  readonly database_schema_hash: Sha256Hash;
  readonly managed_node_distribution_ref: VersionedRef;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly core_entry_relative_path: 'dist/index.js';
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: 'dist/workflow-runtime/certification/release-entry.js';
  readonly validation_entry_sha256: Sha256Hash;
  readonly activation_entry_relative_path: typeof G9_PRODUCTION_ACTIVATION_ENTRY;
  readonly activation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: readonly G8ReleaseInventoryEntry[];
  readonly inventory_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
}

export interface G9ContentAddressedCoreBinding {
  readonly format: 'icarus.core-runtime-launch-binding/3';
  readonly binding_kind: 'content_addressed_production_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: typeof G9_PRODUCTION_RELEASE_MANIFEST_FILENAME;
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: G9ProductionCoreReleaseManifest['core_entry_relative_path'];
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: G9ProductionCoreReleaseManifest['validation_entry_relative_path'];
  readonly validation_entry_sha256: Sha256Hash;
  readonly activation_entry_relative_path: typeof G9_PRODUCTION_ACTIVATION_ENTRY;
  readonly activation_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

export interface G9ApplicableG8Evidence {
  readonly status: 'fresh_independent_boundary_pass';
  readonly release_artifact_hash: Sha256Hash;
  readonly startup_report_hash: Sha256Hash;
  readonly readiness_report_hash: Sha256Hash;
  readonly startup_harness_hash: Sha256Hash;
  readonly readiness_harness_hash: Sha256Hash;
  readonly sqlite_profile_candidate_hash: Sha256Hash;
  readonly node_executable_hash: Sha256Hash;
  readonly native_module_hash: Sha256Hash;
}

export interface G9StaticActivationAuthority {
  readonly source_core_build_hash: Sha256Hash;
  readonly absence_baseline_hash: Sha256Hash;
  readonly product_surface_manifest_hash: Sha256Hash;
  readonly migration_candidate_boundary_hash: Sha256Hash;
}

export interface G9FeatureRegistryPointerTarget {
  readonly feature_id: string;
  readonly release_id: string;
  readonly release_hash: Sha256Hash;
}

export interface G9FeatureRegistryPointerBinding {
  readonly state: 'empty' | 'present';
  readonly active_release_count: number;
  readonly pointers: readonly G9FeatureRegistryPointerTarget[];
  readonly pointer_aggregate_hash: Sha256Hash;
}

export interface G9ProjectionGenerationBinding {
  readonly view: 'workflows' | 'agent_executions' | 'pending' | 'trace';
  readonly generation_id: string;
  readonly source_head_seq: number;
  readonly rows_hash: Sha256Hash;
}

export interface G9RuntimeCenterProjectionBinding {
  readonly projection_version: 'g7.1';
  readonly generations: readonly G9ProjectionGenerationBinding[];
  readonly generation_aggregate_hash: Sha256Hash;
}

export type G9CapacityAuthorityBinding =
  | {
      readonly mode: 'fresh_genesis';
      readonly expected_head_state: 'absent';
      readonly baseline_config_hash: Sha256Hash;
      readonly expected_capacity_revision: 1;
      readonly expected_change_id: string;
      readonly expected_publication_hash: Sha256Hash;
      readonly expected_audit_head_hash: Sha256Hash;
      readonly genesis_core_release_hash: Sha256Hash;
      readonly genesis_command_id: string;
      readonly genesis_idempotency_key: string;
      readonly genesis_auth_session_ref: string;
      readonly genesis_evidence_manifest_id: string;
      readonly genesis_evidence_manifest_hash: Sha256Hash;
      readonly genesis_result_schema_row_id: string;
      readonly genesis_result_schema_resource_type: 'schema';
      readonly genesis_result_schema_ref: VersionedRef;
      readonly genesis_result_schema_hash: Sha256Hash;
    }
  | {
      readonly mode: 'existing_preserved';
      readonly capacity_revision: number;
      readonly change_id: string;
      readonly config_hash: Sha256Hash;
      readonly publication_hash: Sha256Hash;
      readonly publication_file_raw_hash: Sha256Hash;
      readonly audit_head_hash: Sha256Hash;
    };

export interface G9ActivationAudit {
  readonly format: 'icarus.production-activation-audit/1';
  readonly activation_id: string;
  readonly actor_ref: 'system:production-activation';
  readonly requested_at_ms: number;
  readonly request_hash: Sha256Hash;
  readonly target_release_artifact_hash: Sha256Hash;
  readonly previous_deployment_binding_hash: Sha256Hash | null;
  readonly capacity_mode: G9CapacityAuthorityBinding['mode'];
  readonly audit_hash: Sha256Hash;
}

export interface G9DeploymentActivationBinding {
  readonly format: 'icarus.deployment-activation-binding/1';
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly release_manifest_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_binding_hash: Sha256Hash;
  readonly applicable_g8_evidence: G9ApplicableG8Evidence;
  readonly static_authority: G9StaticActivationAuthority;
  readonly feature_registry_pointer: G9FeatureRegistryPointerBinding;
  readonly runtime_center_projection: G9RuntimeCenterProjectionBinding;
  readonly capacity_authority: G9CapacityAuthorityBinding;
  readonly activation_audit_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

export const G9_DEPLOYMENT_JOURNAL_PHASES = [
  'prepared',
  'participant_prepared',
  'precommit_rolled_back',
  'precommit_rollback_completed',
  'active_deployment_committed',
  'participant_rolled_forward',
  'completed',
] as const;
export type G9DeploymentJournalPhase =
  (typeof G9_DEPLOYMENT_JOURNAL_PHASES)[number];

export const G9_DEPLOYMENT_PARTICIPANTS = [
  'core_binding',
  'feature_registry',
  'runtime_center_projection',
  'capacity',
  'deployment_pointer',
] as const;
export type G9DeploymentParticipant =
  (typeof G9_DEPLOYMENT_PARTICIPANTS)[number];

export interface G9DeploymentActivationJournalEvent {
  readonly format: 'icarus.deployment-activation-journal-event/1';
  readonly activation_id: string;
  readonly sequence: number;
  readonly phase: G9DeploymentJournalPhase;
  readonly participant: G9DeploymentParticipant | null;
  readonly previous_event_hash: Sha256Hash | null;
  readonly previous_binding_hash: Sha256Hash | null;
  readonly target_binding_hash: Sha256Hash;
  readonly operation_key: string;
  readonly occurred_at_ms: number;
  readonly event_hash: Sha256Hash;
}

export interface G9ProductionActivationRequest {
  readonly format: 'icarus.production-activation-request/1';
  readonly operation: 'activate';
  readonly activation_id: string;
  readonly operation_key: string;
  readonly requested_at_ms: number;
  readonly audit: G9ActivationAudit;
  readonly deployment_binding: G9DeploymentActivationBinding;
}

export interface G9ProductionActivationContractPack extends ContractArtifactEnvelope {
  readonly format: 'icarus.workflow-runtime-g9-production-activation-contract/1';
}

export interface G9ProductionReleaseEvidenceFiles {
  readonly startupReport: G8StartupSmokeReport;
  readonly readinessReport: G8ReadinessReport;
}
