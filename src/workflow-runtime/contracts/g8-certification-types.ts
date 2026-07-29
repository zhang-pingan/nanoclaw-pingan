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
    | 'icarus.startup-smoke-harness/1'
    | 'icarus.workflow-runtime-benchmark-harness/1'
    | 'icarus.workflow-runtime-limit-derivation/1';
  readonly ref: VersionedRef;
  readonly version: 1;
  readonly domain_separator: string;
  readonly hash: Sha256Hash;
  readonly payload: TPayload;
}

export interface G8BenchmarkHarnessPayload extends JsonObject {
  readonly harness_id: 'local_single_user_benchmark_harness@1';
  readonly benchmark_harness_version: '1.0.0';
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly build_kind: 'release';
  readonly identity_mode: 'certification_observation';
  readonly database_kind: 'isolated_temporary_real_file';
  readonly connection_profile: 'production_pragmas';
  readonly transaction_kind: 'begin_immediate';
  readonly warmup_iterations: 10;
  readonly measurement_iterations: 100;
  readonly profiles: G8BenchmarkProfile[];
  readonly shapes: Record<G8BenchmarkTransaction, string[]>;
  readonly metrics: [
    'p50_ms',
    'p95_ms',
    'p99_ms',
    'max_ms',
    'wal_bytes',
    'peak_rss_bytes',
    'affected_rows',
  ];
  readonly p99_budgets_ms: Readonly<Record<G8BenchmarkTransaction, number>>;
  readonly max_to_p99_budget_multiplier: 2;
  readonly beyond_limit_rejection: 'before_atomic_write';
  readonly production_entries: Readonly<Record<G8BenchmarkTransaction, string>>;
  readonly implementation_source_tree_hash: Sha256Hash;
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

export const G8_SUPPORTED_LIMIT_KEYS = [
  'max_scopes_total',
  'max_nodes_total',
  'max_edges_total',
  'max_attempts_total',
  'max_waits_total',
  'max_builds_total',
  'max_effect_operations_total',
  'max_facts_per_transaction',
  'max_frontier_bytes',
  'max_subtree_scopes_per_fence',
  'max_subtree_nodes_per_fence',
  'max_subtree_edges_per_fence',
  'max_subtree_attempts_per_fence',
  'max_subtree_waits_per_fence',
  'max_subtree_builds_per_fence',
  'max_subtree_map_slots_per_fence',
  'max_subtree_effects_per_fence',
  'max_t7_derived_facts_per_fence',
  'max_subtree_fence_manifest_bytes',
  'max_map_items_total',
  'max_required_child_creations_per_t8',
] as const;

export type G8SupportedLimitKey = (typeof G8_SUPPORTED_LIMIT_KEYS)[number];

export type G8SupportedLimitValues = Readonly<
  Record<G8SupportedLimitKey, number>
>;

export type G8BenchmarkTransaction = 't3' | 't7' | 't8';
export type G8BenchmarkProfile =
  | 'smoke'
  | 'scaling_25'
  | 'scaling_50'
  | 'scaling_100'
  | 'supported_limit'
  | 'beyond_limit';

export interface G8BenchmarkStatistics extends JsonObject {
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
  readonly wal_bytes: number;
  readonly peak_rss_bytes: number;
  readonly affected_rows: number;
}

export interface G8BenchmarkCaseObservation extends JsonObject {
  readonly case_id: string;
  readonly transaction: G8BenchmarkTransaction;
  readonly shape: string;
  readonly profile: G8BenchmarkProfile;
  readonly scale_percent: number | null;
  readonly warmup_iterations: number;
  readonly measurement_iterations: number;
  readonly dimensions: JsonObject;
  readonly production_entry: string;
  readonly production_index_evidence: string[];
  readonly correctness_invariants: string[];
  readonly statistics: G8BenchmarkStatistics | null;
  readonly beyond_limit_rejection: {
    readonly status: 'rejected_before_atomic_write';
    readonly error_code: 'runtime_supported_limit_exceeded';
    readonly attempted_dimensions: JsonObject;
    readonly database_before_hash: Sha256Hash;
    readonly database_after_hash: Sha256Hash;
    readonly affected_rows: 0;
  } | null;
}

export interface G8BenchmarkObservation extends JsonObject {
  readonly format: 'icarus.workflow-runtime-benchmark-observation/1';
  readonly ref: VersionedRef;
  readonly benchmark_harness_ref: VersionedRef;
  readonly benchmark_harness_hash: Sha256Hash;
  readonly benchmark_harness_version: '1.0.0';
  readonly build_kind: 'release';
  readonly database_kind: 'isolated_temporary_real_file';
  readonly sqlite_profile_ref: VersionedRef;
  readonly sqlite_profile_hash: Sha256Hash;
  readonly release_manifest_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly database_schema_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly machine_observation: G8MinimumMachineObservation;
  readonly warmup_iterations: 10;
  readonly measurement_iterations: 100;
  readonly cases: G8BenchmarkCaseObservation[];
  readonly cases_hash: Sha256Hash;
  readonly observation_hash: Sha256Hash;
}

export interface G8LimitDerivationPayload extends JsonObject {
  readonly derivation_id: 'local_single_user_limit_derivation@1';
  readonly algorithm_version: '1.0.0';
  readonly supported_limits: G8SupportedLimitValues;
  readonly product_floor_ref: VersionedRef;
  readonly product_floor_hash: Sha256Hash;
  readonly product_floor_coverage: Readonly<Record<string, number>>;
  readonly worst_case_t7_facts: number;
  readonly worst_case_t7_manifest_bytes: number;
  readonly benchmark_shape_requirements: Record<
    G8BenchmarkTransaction,
    string[]
  >;
  readonly implementation_source_tree_hash: Sha256Hash;
}

export interface G8RuntimeSupportedLimits extends JsonObject {
  readonly ref: VersionedRef;
  readonly max_scopes_total: number;
  readonly max_nodes_total: number;
  readonly max_edges_total: number;
  readonly max_attempts_total: number;
  readonly max_waits_total: number;
  readonly max_builds_total: number;
  readonly max_effect_operations_total: number;
  readonly max_facts_per_transaction: number;
  readonly max_frontier_bytes: number;
  readonly max_subtree_scopes_per_fence: number;
  readonly max_subtree_nodes_per_fence: number;
  readonly max_subtree_edges_per_fence: number;
  readonly max_subtree_attempts_per_fence: number;
  readonly max_subtree_waits_per_fence: number;
  readonly max_subtree_builds_per_fence: number;
  readonly max_subtree_map_slots_per_fence: number;
  readonly max_subtree_effects_per_fence: number;
  readonly max_t7_derived_facts_per_fence: number;
  readonly max_subtree_fence_manifest_bytes: number;
  readonly max_map_items_total: number;
  readonly max_required_child_creations_per_t8: number;
  readonly certification: JsonObject & {
    readonly status: 'certified';
    readonly deployment_profile: 'local_single_user';
    readonly runtime_surface: 'node_service';
    readonly platform: 'darwin';
    readonly arch: 'arm64';
    readonly release_artifact_hash: Sha256Hash;
    readonly database_schema_hash: Sha256Hash;
    readonly core_build_hash: Sha256Hash;
    readonly runtime_launcher_hash: Sha256Hash;
    readonly managed_node_distribution_ref: VersionedRef;
    readonly managed_node_distribution_hash: Sha256Hash;
    readonly sqlite_execution_profile_ref: VersionedRef;
    readonly sqlite_execution_profile_hash: Sha256Hash;
    readonly benchmark_harness_version: string;
    readonly benchmark_harness_hash: Sha256Hash;
    readonly limit_derivation_hash: Sha256Hash;
    readonly reference_machine: string;
    readonly minimum_machine_class_ref: VersionedRef;
    readonly minimum_machine_class_hash: Sha256Hash;
    readonly startup_smoke_harness_hash: Sha256Hash;
    readonly startup_smoke_max_duration_ms: number;
    readonly filesystem_type: 'apfs';
    readonly storage_class: 'internal_ssd';
    readonly t3_max_transaction_duration_ms: number;
    readonly t7_max_transaction_duration_ms: number;
    readonly t8_max_transaction_duration_ms: number;
    readonly certified_at_ms: number;
  };
  readonly profile_hash: Sha256Hash;
}

export interface G8CertifiedSQLiteProfile extends JsonObject {
  readonly ref: VersionedRef;
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly journal_mode: 'wal';
  readonly synchronous: 'full';
  readonly foreign_keys: true;
  readonly busy_timeout_ms: 5000;
  readonly page_size: 4096;
  readonly auto_vacuum: 'incremental';
  readonly temp_store: 'memory';
  readonly wal_autocheckpoint_pages: 4096;
  readonly journal_size_limit_bytes: 67108864;
  readonly cache_size_kib: 32768;
  readonly mmap_size_bytes: 0;
  readonly trusted_schema: false;
  readonly recursive_triggers: false;
  readonly read_uncommitted: false;
  readonly locking_mode: 'normal';
  readonly read_only_query_only: true;
  readonly sqlite_version: string;
  readonly sqlite_source_id: string;
  readonly sqlite_compile_options_hash: Sha256Hash;
  readonly better_sqlite3_version: '12.11.1';
  readonly better_sqlite3_native_module_hash: Sha256Hash;
  readonly managed_node_distribution_ref: VersionedRef;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly node_runtime_version: '26.5.0';
  readonly node_executable_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly profile_hash: Sha256Hash;
}

export interface G8CertificationKey extends JsonObject {
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly release_manifest_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly database_schema_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly managed_node_distribution_ref: VersionedRef;
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly node_runtime_version: '26.5.0';
  readonly node_executable_hash: Sha256Hash;
  readonly better_sqlite3_version: '12.11.1';
  readonly better_sqlite3_native_module_hash: Sha256Hash;
  readonly sqlite_version: string;
  readonly sqlite_source_id: string;
  readonly sqlite_compile_options_hash: Sha256Hash;
  readonly sqlite_execution_profile_ref: VersionedRef;
  readonly sqlite_execution_profile_hash: Sha256Hash;
  readonly benchmark_harness_ref: VersionedRef;
  readonly benchmark_harness_version: '1.0.0';
  readonly benchmark_harness_hash: Sha256Hash;
  readonly benchmark_observation_hash: Sha256Hash;
  readonly limit_derivation_ref: VersionedRef;
  readonly limit_derivation_hash: Sha256Hash;
  readonly runtime_supported_limits_ref: VersionedRef;
  readonly runtime_supported_limits_hash: Sha256Hash;
  readonly product_floor_ref: VersionedRef;
  readonly product_floor_hash: Sha256Hash;
  readonly minimum_machine_class_ref: VersionedRef;
  readonly minimum_machine_class_hash: Sha256Hash;
  readonly minimum_machine_observation_hash: Sha256Hash;
  readonly startup_smoke_harness_ref: VersionedRef;
  readonly startup_smoke_harness_hash: Sha256Hash;
  readonly startup_smoke_report_hash: Sha256Hash;
}

export interface G8CertificationPack extends JsonObject {
  readonly format: 'icarus.workflow-runtime-certification-pack/1';
  readonly ref: VersionedRef;
  readonly version: 1;
  readonly status: 'certified';
  readonly certification_key: G8CertificationKey;
  readonly certification_key_hash: Sha256Hash;
  readonly certified_at_ms: number;
  readonly security_sensitive_validation: 'SECURITY_VALIDATION_NOT_RUN';
  readonly security_validation_basis: 'static_source_existing_tests_and_invariant_mapping_only';
  readonly pack_hash: Sha256Hash;
}
