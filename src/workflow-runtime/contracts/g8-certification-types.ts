import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export interface G8ReleaseInventoryEntry {
  readonly path: string;
  readonly byte_length: number;
  readonly executable: boolean;
  readonly raw_sha256: Sha256Hash;
}

export interface G8CoreReleaseManifest {
  readonly format: 'icarus.core-release-manifest/1';
  readonly ref: VersionedRef;
  readonly release_scope: 'workflow_runtime_g8_certification';
  readonly build_kind: 'release';
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
  readonly certification_entry_relative_path: 'dist/workflow-runtime/certification/release-entry.js';
  readonly certification_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: readonly G8ReleaseInventoryEntry[];
  readonly inventory_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
}

export interface G8CertifiedReleaseBinding {
  readonly format: 'icarus.core-runtime-launch-binding/2';
  readonly binding_kind: 'certified_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: 'core-release-manifest.json';
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly certification_entry_relative_path: string;
  readonly certification_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

export interface G8MinimumMachineClassPayload extends JsonObject {
  readonly class_id: 'local_single_user_minimum_machine@1';
  readonly deployment_profile: 'local_single_user';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly cpu_family: 'apple_silicon';
  readonly minimum_cpu_generation: 2;
  readonly minimum_memory_bytes: 17179869184;
  readonly filesystem_type: 'apfs';
  readonly storage_class: 'internal_ssd';
  readonly startup_power_source: 'any';
  readonly certification_power_source: 'ac_power';
  readonly certification_interference: 'none_operator_confirmed';
  readonly observation_source_tree_hash: Sha256Hash;
}

export interface G8StartupSmokeHarnessPayload extends JsonObject {
  readonly harness_id: 'local_single_user_startup_smoke@1';
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly identity_mode: 'certification_observation';
  readonly database_schema_version: 11;
  readonly database_kind: 'isolated_temporary_real_file';
  readonly database_filename: 'workflow-runtime.db';
  readonly connection_profile: 'production_pragmas';
  readonly transaction_kind: 'begin_immediate';
  readonly transaction_probe: 'zero_row_parameterized_dml';
  readonly reopen_required: true;
  readonly integrity_check_required: true;
  readonly startup_smoke_max_duration_ms: 5000;
  readonly implementation_source_tree_hash: Sha256Hash;
}

export interface G8FoundationContractArtifact<
  TPayload extends JsonObject = JsonObject,
> extends JsonObject {
  readonly format:
    | 'icarus.minimum-machine-class/1'
    | 'icarus.startup-smoke-harness/1';
  readonly ref: VersionedRef;
  readonly version: 1;
  readonly domain_separator: string;
  readonly hash: Sha256Hash;
  readonly payload: TPayload;
}

export interface G8MinimumMachineObservation extends JsonObject {
  readonly format: 'icarus.minimum-machine-observation/1';
  readonly purpose: 'certification_reference' | 'startup_preflight';
  readonly minimum_machine_class_ref: VersionedRef;
  readonly minimum_machine_class_hash: Sha256Hash;
  readonly cpu_brand: string;
  readonly cpu_generation: number;
  readonly memory_bytes: number;
  readonly filesystem_type: 'apfs';
  readonly filesystem_device: string;
  readonly storage_class: 'internal_ssd';
  readonly power_source: 'ac_power' | 'battery' | 'not_required';
  readonly benchmark_interference: 'none_operator_confirmed' | 'not_applicable';
  readonly reference_machine: string;
  readonly observation_hash: Sha256Hash;
}
