import type {
  G8BenchmarkCaseObservation,
  G8BenchmarkProfile,
  G8BenchmarkTransaction,
  G8CoreReleaseManifest,
  G8MinimumMachineObservation,
} from '../contracts/g8-certification-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  G8_BENCHMARK_PROFILES,
  G8_BENCHMARK_SHAPES,
  G8_SUPPORTED_LIMITS,
} from '../contracts/g8-limits.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeIdentityEvidence } from '../store/runtime-store/identity.js';

export const g8FixtureHash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g8-certification-fixture:1\n', { label });

export function createG8ReleaseManifestFixture(): G8CoreReleaseManifest {
  const inventory: [] = [];
  const inventoryHash = domainSeparatedSha256(
    'icarus:core-release-inventory:1\n',
    inventory,
  );
  const coreBuildHash = domainSeparatedSha256(
    'icarus:core-release-build:1\n',
    inventory,
  );
  const payload = {
    format: 'icarus.core-release-manifest/1',
    ref: { id: 'icarus.core', version: '1.2.14' },
    release_scope: 'workflow_runtime_g8_certification',
    build_kind: 'release',
    platform: 'darwin',
    arch: 'arm64',
    run_protocol_majors: [1],
    executor_abi_majors: [1],
    database_schema_version: 11,
    database_schema_hash: g8FixtureHash('schema'),
    managed_node_distribution_ref: {
      id: 'nodejs.node-v26.5.0-darwin-arm64',
      version: '1.0.0',
    },
    managed_node_distribution_hash: g8FixtureHash('distribution'),
    runtime_launcher_hash: g8FixtureHash('launcher'),
    runtime_toolchain_hash: g8FixtureHash('toolchain'),
    core_entry_relative_path: 'dist/index.js',
    core_entry_sha256: g8FixtureHash('core-entry'),
    certification_entry_relative_path:
      'dist/workflow-runtime/certification/release-entry.js',
    certification_entry_sha256: g8FixtureHash('certification-entry'),
    core_build_hash: coreBuildHash,
    inventory,
    inventory_hash: inventoryHash,
  } as const;
  return {
    ...payload,
    release_artifact_hash: domainSeparatedSha256(
      'icarus:core-release-manifest:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

export function createG8IdentityEvidenceFixture(
  release: G8CoreReleaseManifest,
  releaseManifestHash: Sha256Hash = g8FixtureHash('release-manifest-raw'),
): WorkflowRuntimeIdentityEvidence {
  return {
    identity_mode: 'certification_observation',
    certification_status: 'certification_observation',
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    platform: 'darwin',
    arch: 'arm64',
    managed_node_version: 'v26.5.0',
    managed_node_exec_path: '/fixture/toolchains/node/26.5.0/bin/node',
    managed_node_executable_hash: g8FixtureHash('node-executable'),
    managed_distribution_ref: release.managed_node_distribution_ref,
    managed_distribution_hash: release.managed_node_distribution_hash,
    managed_installation_root: '/fixture/toolchains/node/26.5.0',
    better_sqlite3_version: '12.11.1',
    better_sqlite3_native_module_path: '/fixture/better_sqlite3.node',
    better_sqlite3_native_module_hash: g8FixtureHash('native-module'),
    sqlite_version: '3.51.2',
    sqlite_source_id: 'fixture sqlite source id',
    sqlite_compile_options_hash: g8FixtureHash('sqlite-options'),
    sqlite_compile_option_count: 42,
    runtime_launcher_path: '/fixture/bin/icarus-runtime',
    runtime_launcher_observed_hash: release.runtime_launcher_hash,
    runtime_launcher_profile_hash: release.runtime_launcher_hash,
    core_binding_kind: 'certified_release',
    core_binding_hash: g8FixtureHash('binding'),
    core_entry_hash: release.core_entry_sha256,
    certification_entry_hash: release.certification_entry_sha256,
    core_build_hash: release.core_build_hash,
    release_manifest_hash: releaseManifestHash,
    release_database_schema_hash: release.database_schema_hash,
    release_artifact_profile_hash: release.release_artifact_hash,
    release_identity_status: 'observed_for_certification',
  };
}

export function createG8MachineObservationFixture(): G8MinimumMachineObservation {
  const artifacts = loadG8FoundationArtifacts();
  const payload = {
    format: 'icarus.minimum-machine-observation/1',
    purpose: 'certification_reference',
    minimum_machine_class_ref: artifacts.minimumMachineClass.ref,
    minimum_machine_class_hash: artifacts.minimumMachineClass.hash,
    cpu_brand: 'Apple M2 Pro',
    cpu_generation: 2,
    memory_bytes: 17179869184,
    filesystem_type: 'apfs',
    filesystem_device: '/dev/disk-fixture',
    storage_class: 'internal_ssd',
    power_source: 'ac_power',
    benchmark_interference: 'none_operator_confirmed',
    reference_machine: 'apple_m2_pro_16_gib_internal_apfs_ssd',
  } as const;
  return {
    ...payload,
    observation_hash: domainSeparatedSha256(
      'icarus:minimum-machine-observation:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

function scale(profile: G8BenchmarkProfile): number {
  if (profile === 'smoke') return 1 / 32;
  if (profile === 'scaling_25') return 0.25;
  if (profile === 'scaling_50') return 0.5;
  return 1;
}

function scaled(maximum: number, profile: G8BenchmarkProfile): number {
  return Math.max(1, Math.ceil(maximum * scale(profile)));
}

function dimensions(
  transaction: G8BenchmarkTransaction,
  shape: string,
  profile: G8BenchmarkProfile,
): JsonObject {
  if (profile === 'beyond_limit') {
    return transaction === 't3'
      ? {
          max_facts_per_transaction:
            G8_SUPPORTED_LIMITS.max_facts_per_transaction + 1,
        }
      : transaction === 't7'
        ? {
            max_subtree_scopes_per_fence:
              G8_SUPPORTED_LIMITS.max_subtree_scopes_per_fence + 1,
          }
        : {
            max_required_child_creations_per_t8:
              G8_SUPPORTED_LIMITS.max_required_child_creations_per_t8 + 1,
          };
  }
  if (transaction === 't3') {
    return {
      max_scopes_total: 1,
      max_nodes_total: scaled(128, profile),
      max_edges_total: scaled(512, profile),
      max_facts_per_transaction: scaled(
        G8_SUPPORTED_LIMITS.max_facts_per_transaction,
        profile,
      ),
      max_frontier_bytes: scaled(
        G8_SUPPORTED_LIMITS.max_frontier_bytes,
        profile,
      ),
    };
  }
  if (transaction === 't7') {
    return {
      max_scopes_total: scaled(G8_SUPPORTED_LIMITS.max_scopes_total, profile),
      max_nodes_total: scaled(G8_SUPPORTED_LIMITS.max_nodes_total, profile),
      max_edges_total: scaled(G8_SUPPORTED_LIMITS.max_edges_total, profile),
      max_attempts_total: scaled(
        G8_SUPPORTED_LIMITS.max_attempts_total,
        profile,
      ),
      max_waits_total: scaled(G8_SUPPORTED_LIMITS.max_waits_total, profile),
      max_builds_total: scaled(G8_SUPPORTED_LIMITS.max_builds_total, profile),
      max_effect_operations_total: scaled(
        G8_SUPPORTED_LIMITS.max_effect_operations_total,
        profile,
      ),
      max_subtree_scopes_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_scopes_per_fence,
        profile,
      ),
      max_subtree_nodes_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_nodes_per_fence,
        profile,
      ),
      max_subtree_edges_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_edges_per_fence,
        profile,
      ),
      max_subtree_attempts_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_attempts_per_fence,
        profile,
      ),
      max_subtree_waits_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_waits_per_fence,
        profile,
      ),
      max_subtree_builds_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_builds_per_fence,
        profile,
      ),
      max_subtree_effects_per_fence: scaled(
        G8_SUPPORTED_LIMITS.max_subtree_effects_per_fence,
        profile,
      ),
      max_map_items_total:
        shape === 'large_nested_map'
          ? scaled(G8_SUPPORTED_LIMITS.max_map_items_total, profile)
          : 0,
      max_subtree_map_slots_per_fence:
        shape === 'large_nested_map'
          ? scaled(G8_SUPPORTED_LIMITS.max_subtree_map_slots_per_fence, profile)
          : 0,
      observed_max_nodes_per_scope: scaled(128, profile),
      observed_max_edges_per_scope: scaled(512, profile),
      observed_max_nesting_depth: scaled(8, profile),
      ...(shape === 'large_nested_map'
        ? { observed_max_items_per_map: scaled(128, profile) }
        : {}),
    };
  }
  return {
    max_required_child_creations_per_t8: scaled(
      G8_SUPPORTED_LIMITS.max_required_child_creations_per_t8,
      profile,
    ),
  };
}

export function createG8BenchmarkCasesFixture(): G8BenchmarkCaseObservation[] {
  const cases: G8BenchmarkCaseObservation[] = [];
  for (const transaction of ['t3', 't7', 't8'] as const) {
    for (const shape of G8_BENCHMARK_SHAPES[transaction]) {
      for (const profile of G8_BENCHMARK_PROFILES) {
        const databaseHash = g8FixtureHash(`${transaction}:${shape}:database`);
        cases.push({
          case_id: `g8:${transaction}:${shape}:${profile}`,
          transaction,
          shape,
          profile,
          scale_percent:
            profile === 'beyond_limit'
              ? null
              : profile === 'smoke'
                ? 3.125
                : profile === 'scaling_25'
                  ? 25
                  : profile === 'scaling_50'
                    ? 50
                    : 100,
          warmup_iterations: 10,
          measurement_iterations: 100,
          dimensions: dimensions(transaction, shape, profile),
          production_entry:
            transaction === 't3'
              ? 'reconcileFactT3a'
              : transaction === 't7'
                ? 'requestScopeCloseT7a'
                : 'commitRootT8',
          production_index_evidence:
            transaction === 't8' ? [] : ['fixture-index'],
          correctness_invariants: ['fixture correctness invariant'],
          statistics:
            profile === 'beyond_limit'
              ? null
              : {
                  p50_ms: 1,
                  p95_ms: 2,
                  p99_ms: 3,
                  max_ms: 4.25,
                  wal_bytes: 4096,
                  peak_rss_bytes: 17179869184,
                  affected_rows: 1,
                },
          beyond_limit_rejection:
            profile === 'beyond_limit'
              ? {
                  status: 'rejected_before_atomic_write',
                  error_code: 'runtime_supported_limit_exceeded',
                  attempted_dimensions: dimensions(transaction, shape, profile),
                  database_before_hash: databaseHash,
                  database_after_hash: databaseHash,
                  affected_rows: 0,
                }
              : null,
        });
      }
    }
  }
  return cases;
}

export function createG8StartupSmokeReportFixture(
  release: G8CoreReleaseManifest,
  evidence: WorkflowRuntimeIdentityEvidence,
): JsonObject {
  const artifacts = loadG8FoundationArtifacts();
  const payload = {
    format: 'icarus.startup-smoke-report/1',
    status: 'pass',
    startup_smoke_harness_ref: artifacts.startupSmokeHarness.ref,
    startup_smoke_harness_hash: artifacts.startupSmokeHarness.hash,
    startup_smoke_max_duration_ms: 5000,
    duration_ms: 10,
    database_schema_version: 11,
    database_schema_hash: release.database_schema_hash,
    sqlite_profile_candidate_hash: g8FixtureHash('candidate-profile'),
    production_pragmas_verified: true,
    integrity_check_verified: true,
    reopen_verified: true,
    database_bytes: 4096,
    wal_bytes: 0,
    transaction_affected_rows: 0,
    machine_observation: {
      ...createG8MachineObservationFixture(),
      purpose: 'startup_preflight',
      power_source: 'not_required',
      benchmark_interference: 'not_applicable',
    },
    identity_evidence: evidence as unknown as JsonObject,
  };
  return {
    ...payload,
    report_hash: domainSeparatedSha256(
      'icarus:startup-smoke-report:1\n',
      payload as unknown as JsonValue,
    ),
  };
}
