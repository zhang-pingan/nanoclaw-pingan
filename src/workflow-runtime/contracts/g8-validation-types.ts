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
  readonly release_scope: 'workflow_runtime_g8_validation';
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
  readonly validation_entry_relative_path: 'dist/workflow-runtime/certification/release-entry.js';
  readonly validation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: readonly G8ReleaseInventoryEntry[];
  readonly inventory_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
}

export interface G8ContentAddressedReleaseBinding {
  readonly format: 'icarus.core-runtime-launch-binding/2';
  readonly binding_kind: 'content_addressed_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: 'core-release-manifest.json';
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: string;
  readonly validation_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

export interface G8StartupSmokeHarnessPayload extends JsonObject {
  readonly harness_id: 'local_single_user_startup_smoke@1';
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly identity_mode: 'release_validation';
  readonly database_schema_version: 11;
  readonly database_kind: 'isolated_temporary_real_file';
  readonly database_filename: 'workflow-runtime.db';
  readonly connection_profile: 'production_pragmas';
  readonly transaction_kind: 'begin_immediate';
  readonly transaction_probe: 'zero_row_parameterized_dml';
  readonly reopen_required: true;
  readonly integrity_check_required: true;
  readonly foreign_key_check_required: true;
  readonly startup_smoke_max_duration_ms: 5000;
  readonly implementation_source_tree_hash: Sha256Hash;
}

export interface G8StartupSmokeReport extends JsonObject {
  readonly format: 'icarus.startup-smoke-report/1';
  readonly status: 'pass';
  readonly startup_smoke_harness_ref: VersionedRef;
  readonly startup_smoke_harness_hash: Sha256Hash;
  readonly startup_smoke_max_duration_ms: 5000;
  readonly duration_ms: number;
  readonly database_schema_version: 11;
  readonly database_schema_hash: Sha256Hash;
  readonly sqlite_profile_candidate_hash: Sha256Hash;
  readonly production_pragmas_verified: true;
  readonly integrity_check_verified: true;
  readonly foreign_key_check_verified: true;
  readonly reopen_verified: true;
  readonly database_bytes: number;
  readonly wal_bytes: number;
  readonly transaction_affected_rows: 0;
  readonly identity_evidence: JsonObject;
  readonly report_hash: Sha256Hash;
}

export type G8BenchmarkTransaction = 't3' | 't7' | 't8';
export type G8BenchmarkProfile =
  | 'smoke'
  | 'scaling_25'
  | 'scaling_50'
  | 'scaling_100'
  | 'supported_limit'
  | 'beyond_limit';

export interface G8ReadinessHarnessPayload extends JsonObject {
  readonly harness_id: 'local_single_user_g8_readiness@1';
  readonly harness_version: '1.0.0';
  readonly deployment_profile: 'local_single_user';
  readonly runtime_surface: 'node_service';
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly build_kind: 'release';
  readonly identity_mode: 'release_validation';
  readonly database_kind: 'isolated_temporary_real_file';
  readonly connection_profile: 'production_pragmas';
  readonly transaction_kind: 'begin_immediate';
  readonly warmup_iterations: 1;
  readonly measurement_iterations: 5;
  readonly profiles: ['supported_limit', 'beyond_limit'];
  readonly supported_limits: G8SupportedLimitValues;
  readonly beyond_limit_dimensions: Readonly<
    Record<G8BenchmarkTransaction, Partial<G8SupportedLimitValues>>
  >;
  readonly representatives: Record<G8BenchmarkTransaction, string[]>;
  readonly obvious_regression_max_ms: Readonly<
    Record<G8BenchmarkTransaction, number>
  >;
  readonly metrics: [
    'p50_ms',
    'p95_ms',
    'p99_ms',
    'max_ms',
    'wal_bytes',
    'peak_rss_bytes',
    'affected_rows',
  ];
  readonly beyond_limit_rejection: 'before_business_transaction_and_write';
  readonly production_entries: Readonly<Record<G8BenchmarkTransaction, string>>;
  readonly implementation_source_tree_hash: Sha256Hash;
}

export interface G8FoundationContractArtifact<
  TPayload extends JsonObject = JsonObject,
> extends JsonObject {
  readonly format:
    | 'icarus.startup-smoke-harness/1'
    | 'icarus.workflow-runtime-g8-readiness-harness/1';
  readonly ref: VersionedRef;
  readonly version: 1;
  readonly domain_separator: string;
  readonly hash: Sha256Hash;
  readonly payload: TPayload;
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

export interface G8BenchmarkStatistics extends JsonObject {
  readonly p50_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
  readonly wal_bytes: number;
  readonly peak_rss_bytes: number;
  readonly affected_rows: number;
}

export interface G8BeyondLimitRejectionObservation extends JsonObject {
  readonly phase: 'warmup' | 'measurement';
  readonly iteration: number;
  readonly status: 'rejected_before_atomic_write';
  readonly error_code: 'runtime_supported_limit_exceeded';
  readonly database_before_hash: Sha256Hash;
  readonly database_after_hash: Sha256Hash;
  readonly affected_rows: 0;
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
  readonly limit_dimensions: JsonObject;
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
    readonly observations: G8BeyondLimitRejectionObservation[];
  } | null;
}

export interface G8ReadinessReport extends JsonObject {
  readonly format: 'icarus.workflow-runtime-g8-readiness-report/1';
  readonly ref: VersionedRef;
  readonly status: 'pass';
  readonly certification_status: 'not_certified';
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
  readonly sqlite_profile_candidate_hash: Sha256Hash;
  readonly startup_smoke_harness_ref: VersionedRef;
  readonly startup_smoke_harness_hash: Sha256Hash;
  readonly startup_smoke_report_hash: Sha256Hash;
  readonly readiness_harness_ref: VersionedRef;
  readonly readiness_harness_hash: Sha256Hash;
  readonly warmup_iterations: 1;
  readonly measurement_iterations: 5;
  readonly cases: G8BenchmarkCaseObservation[];
  readonly cases_hash: Sha256Hash;
  readonly security_sensitive_validation: 'SECURITY_VALIDATION_NOT_RUN';
  readonly security_validation_basis: 'static_source_existing_tests_and_invariant_mapping_only';
  readonly report_hash: Sha256Hash;
}
