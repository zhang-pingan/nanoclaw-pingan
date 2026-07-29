import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type {
  G8BenchmarkCaseObservation,
  G8BenchmarkObservation,
  G8BenchmarkProfile,
  G8BenchmarkTransaction,
  G8CertificationKey,
  G8CertificationPack,
  G8CertifiedSQLiteProfile,
  G8CoreReleaseManifest,
  G8MinimumMachineObservation,
  G8RuntimeSupportedLimits,
} from '../contracts/g8-certification-types.js';
import { G8_SUPPORTED_LIMIT_KEYS } from '../contracts/g8-certification-types.js';
import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../contracts/hash.js';
import {
  G8_BENCHMARK_PROFILES,
  G8_BENCHMARK_SHAPES,
  G8_PRODUCT_FLOOR_COVERAGE,
  G8_SUPPORTED_LIMITS,
} from '../contracts/g8-limits.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import { parseVersionedRef } from '../contracts/versioned-ref.js';
import type { WorkflowRuntimeIdentityEvidence } from '../store/runtime-store/identity.js';
import { parseG8CoreReleaseManifest } from './release-manifest.js';

export const G8_CERTIFICATION_OUTPUT_ROOT =
  'src/workflow-runtime/contracts/certification/generated';
export const G8_CERTIFIED_SQLITE_PROFILE_FILENAME =
  'local_single_user_sqlite@1.json';
export const G8_BENCHMARK_OBSERVATION_FILENAME = 'benchmark-observation@1.json';
export const G8_RUNTIME_SUPPORTED_LIMITS_FILENAME =
  'runtime-supported-limits@1.json';
export const G8_CERTIFICATION_PACK_FILENAME = 'certification-pack@1.json';
export const G8_STARTUP_SMOKE_REPORT_FILENAME = 'startup-smoke-report@1.json';
export const G8_CORE_RELEASE_MANIFEST_FILENAME = 'core-release-manifest@1.json';

const SQLITE_PROFILE_REF = {
  id: 'icarus.local-single-user-sqlite',
  version: '1.0.0',
} as const;
const BENCHMARK_OBSERVATION_REF = {
  id: 'icarus.local-single-user-benchmark-observation',
  version: '1.0.0',
} as const;
const SUPPORTED_LIMITS_REF = {
  id: 'icarus.local-single-user-runtime-supported-limits',
  version: '1.0.0',
} as const;
const CERTIFICATION_PACK_REF = {
  id: 'icarus.local-single-user-runtime-certification',
  version: '1.0.0',
} as const;

const PROFILE_KEYS = [
  'arch',
  'auto_vacuum',
  'better_sqlite3_native_module_hash',
  'better_sqlite3_version',
  'busy_timeout_ms',
  'cache_size_kib',
  'deployment_profile',
  'foreign_keys',
  'journal_mode',
  'journal_size_limit_bytes',
  'locking_mode',
  'managed_node_distribution_hash',
  'managed_node_distribution_ref',
  'mmap_size_bytes',
  'node_executable_hash',
  'node_runtime_version',
  'page_size',
  'platform',
  'profile_hash',
  'read_only_query_only',
  'read_uncommitted',
  'recursive_triggers',
  'ref',
  'release_artifact_hash',
  'runtime_launcher_hash',
  'runtime_surface',
  'sqlite_compile_options_hash',
  'sqlite_source_id',
  'sqlite_version',
  'synchronous',
  'temp_store',
  'trusted_schema',
  'wal_autocheckpoint_pages',
] as const;

const BENCHMARK_OBSERVATION_KEYS = [
  'benchmark_harness_hash',
  'benchmark_harness_ref',
  'benchmark_harness_version',
  'build_kind',
  'cases',
  'cases_hash',
  'core_build_hash',
  'database_kind',
  'database_schema_hash',
  'format',
  'machine_observation',
  'managed_node_distribution_hash',
  'measurement_iterations',
  'observation_hash',
  'ref',
  'release_artifact_hash',
  'release_manifest_hash',
  'runtime_launcher_hash',
  'runtime_toolchain_hash',
  'sqlite_profile_hash',
  'sqlite_profile_ref',
  'warmup_iterations',
] as const;

const BENCHMARK_CASE_KEYS = [
  'beyond_limit_rejection',
  'case_id',
  'correctness_invariants',
  'dimensions',
  'measurement_iterations',
  'production_entry',
  'production_index_evidence',
  'profile',
  'scale_percent',
  'shape',
  'statistics',
  'transaction',
  'warmup_iterations',
] as const;

const MACHINE_OBSERVATION_KEYS = [
  'benchmark_interference',
  'cpu_brand',
  'cpu_generation',
  'filesystem_device',
  'filesystem_type',
  'format',
  'memory_bytes',
  'minimum_machine_class_hash',
  'minimum_machine_class_ref',
  'observation_hash',
  'power_source',
  'purpose',
  'reference_machine',
  'storage_class',
] as const;

const LIMIT_CERTIFICATION_KEYS = [
  'arch',
  'benchmark_harness_hash',
  'benchmark_harness_version',
  'certified_at_ms',
  'core_build_hash',
  'database_schema_hash',
  'deployment_profile',
  'filesystem_type',
  'limit_derivation_hash',
  'managed_node_distribution_hash',
  'managed_node_distribution_ref',
  'minimum_machine_class_hash',
  'minimum_machine_class_ref',
  'platform',
  'reference_machine',
  'release_artifact_hash',
  'runtime_launcher_hash',
  'runtime_surface',
  'sqlite_execution_profile_hash',
  'sqlite_execution_profile_ref',
  'startup_smoke_harness_hash',
  'startup_smoke_max_duration_ms',
  'status',
  'storage_class',
  't3_max_transaction_duration_ms',
  't7_max_transaction_duration_ms',
  't8_max_transaction_duration_ms',
] as const;

const CERTIFICATION_PACK_KEYS = [
  'certification_key',
  'certification_key_hash',
  'certified_at_ms',
  'format',
  'pack_hash',
  'ref',
  'security_sensitive_validation',
  'security_validation_basis',
  'status',
  'version',
] as const;

const STARTUP_SMOKE_REPORT_KEYS = [
  'database_bytes',
  'database_schema_hash',
  'database_schema_version',
  'duration_ms',
  'format',
  'identity_evidence',
  'integrity_check_verified',
  'machine_observation',
  'production_pragmas_verified',
  'reopen_verified',
  'report_hash',
  'sqlite_profile_candidate_hash',
  'startup_smoke_harness_hash',
  'startup_smoke_harness_ref',
  'startup_smoke_max_duration_ms',
  'status',
  'transaction_affected_rows',
  'wal_bytes',
] as const;

const CERTIFICATION_KEY_KEYS = [
  'arch',
  'benchmark_harness_hash',
  'benchmark_harness_ref',
  'benchmark_harness_version',
  'benchmark_observation_hash',
  'better_sqlite3_native_module_hash',
  'better_sqlite3_version',
  'core_build_hash',
  'database_schema_hash',
  'deployment_profile',
  'limit_derivation_hash',
  'limit_derivation_ref',
  'managed_node_distribution_hash',
  'managed_node_distribution_ref',
  'minimum_machine_class_hash',
  'minimum_machine_class_ref',
  'minimum_machine_observation_hash',
  'node_executable_hash',
  'node_runtime_version',
  'platform',
  'product_floor_hash',
  'product_floor_ref',
  'release_artifact_hash',
  'release_manifest_hash',
  'runtime_launcher_hash',
  'runtime_surface',
  'runtime_supported_limits_hash',
  'runtime_supported_limits_ref',
  'runtime_toolchain_hash',
  'sqlite_compile_options_hash',
  'sqlite_execution_profile_hash',
  'sqlite_execution_profile_ref',
  'sqlite_source_id',
  'sqlite_version',
  'startup_smoke_harness_hash',
  'startup_smoke_harness_ref',
  'startup_smoke_report_hash',
] as const;

function exactKeys(value: object, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error(`${label} has an unknown, duplicate, or missing field`);
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function exactRef(
  value: unknown,
  expected: VersionedRef,
  label: string,
): VersionedRef {
  const parsed = parseVersionedRef(value);
  if (parsed.id !== expected.id || parsed.version !== expected.version)
    throw new Error(`${label} identity drifted`);
  return parsed;
}

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

export function writeG8JsonAtomic(filePath: string, value: JsonValue): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.renameSync(temporary, filePath);
}

export function createG8CertifiedSQLiteProfile(
  evidence: WorkflowRuntimeIdentityEvidence,
  release: G8CoreReleaseManifest,
): G8CertifiedSQLiteProfile {
  if (
    evidence.identity_mode !== 'certification_observation' ||
    evidence.certification_status !== 'certification_observation' ||
    evidence.release_identity_status !== 'observed_for_certification' ||
    evidence.core_binding_kind !== 'certified_release' ||
    evidence.runtime_launcher_observed_hash !== release.runtime_launcher_hash ||
    evidence.runtime_launcher_profile_hash !== release.runtime_launcher_hash ||
    evidence.release_artifact_profile_hash !== release.release_artifact_hash ||
    evidence.release_database_schema_hash !== release.database_schema_hash ||
    evidence.core_build_hash !== release.core_build_hash ||
    evidence.managed_distribution_hash !==
      release.managed_node_distribution_hash ||
    evidence.managed_distribution_ref.id !==
      release.managed_node_distribution_ref.id ||
    evidence.managed_distribution_ref.version !==
      release.managed_node_distribution_ref.version ||
    evidence.better_sqlite3_version !== '12.11.1' ||
    evidence.managed_node_version !== 'v26.5.0'
  ) {
    throw new Error('Release SQLite certification evidence is incomplete');
  }
  const payload = {
    ref: SQLITE_PROFILE_REF,
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
    sqlite_version: evidence.sqlite_version,
    sqlite_source_id: evidence.sqlite_source_id,
    sqlite_compile_options_hash: evidence.sqlite_compile_options_hash,
    better_sqlite3_version: '12.11.1',
    better_sqlite3_native_module_hash:
      evidence.better_sqlite3_native_module_hash,
    managed_node_distribution_ref: release.managed_node_distribution_ref,
    managed_node_distribution_hash: release.managed_node_distribution_hash,
    node_runtime_version: '26.5.0',
    node_executable_hash: evidence.managed_node_executable_hash,
    release_artifact_hash: release.release_artifact_hash,
    runtime_launcher_hash: release.runtime_launcher_hash,
  } as const;
  return parseG8CertifiedSQLiteProfile({
    ...payload,
    profile_hash: domainSeparatedSha256(
      'icarus:sqlite-execution-profile:1\n',
      payload as unknown as JsonValue,
    ),
  });
}

export function parseG8CertifiedSQLiteProfile(
  value: unknown,
): G8CertifiedSQLiteProfile {
  assertJsonObject(value);
  exactKeys(value, PROFILE_KEYS, 'Certified SQLite Profile');
  const ref = exactRef(
    value.ref,
    SQLITE_PROFILE_REF,
    'Certified SQLite Profile',
  );
  const fixed = {
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    platform: 'darwin',
    arch: 'arm64',
    journal_mode: 'wal',
    synchronous: 'full',
    foreign_keys: true,
    auto_vacuum: 'incremental',
    temp_store: 'memory',
    trusted_schema: false,
    recursive_triggers: false,
    read_uncommitted: false,
    locking_mode: 'normal',
    read_only_query_only: true,
    better_sqlite3_version: '12.11.1',
    node_runtime_version: '26.5.0',
  } as const;
  for (const [key, expected] of Object.entries(fixed)) {
    if (value[key] !== expected)
      throw new Error(`Certified SQLite Profile ${key} drifted`);
  }
  for (const key of [
    'busy_timeout_ms',
    'page_size',
    'wal_autocheckpoint_pages',
    'journal_size_limit_bytes',
    'cache_size_kib',
  ])
    positiveSafeInteger(value[key], `Certified SQLite Profile ${key}`);
  if (value.mmap_size_bytes !== 0)
    throw new Error('Certified SQLite Profile mmap_size_bytes drifted');
  for (const key of ['sqlite_version', 'sqlite_source_id'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0)
      throw new Error(`Certified SQLite Profile ${key} is empty`);
  }
  const distributionRef = parseVersionedRef(
    value.managed_node_distribution_ref,
  );
  for (const key of [
    'sqlite_compile_options_hash',
    'better_sqlite3_native_module_hash',
    'managed_node_distribution_hash',
    'node_executable_hash',
    'release_artifact_hash',
    'runtime_launcher_hash',
  ] as const)
    parseSha256Hash(value[key]);
  const profileHash = parseSha256Hash(value.profile_hash);
  const { profile_hash: _profileHash, ...payload } = value;
  if (
    domainSeparatedSha256(
      'icarus:sqlite-execution-profile:1\n',
      payload as JsonValue,
    ) !== profileHash
  )
    throw new Error('Certified SQLite Profile content identity drifted');
  return {
    ...(value as unknown as G8CertifiedSQLiteProfile),
    ref,
    managed_node_distribution_ref: distributionRef,
    profile_hash: profileHash,
  };
}

function parseMachineObservation(value: unknown): G8MinimumMachineObservation {
  assertJsonObject(value);
  exactKeys(value, MACHINE_OBSERVATION_KEYS, 'Minimum-machine observation');
  const artifacts = loadG8FoundationArtifacts();
  const ref = exactRef(
    value.minimum_machine_class_ref,
    artifacts.minimumMachineClass.ref,
    'Minimum-machine observation',
  );
  const hash = parseSha256Hash(value.observation_hash);
  const { observation_hash: _hash, ...payload } = value;
  if (
    value.format !== 'icarus.minimum-machine-observation/1' ||
    value.purpose !== 'certification_reference' ||
    value.minimum_machine_class_hash !== artifacts.minimumMachineClass.hash ||
    value.filesystem_type !== 'apfs' ||
    value.storage_class !== 'internal_ssd' ||
    value.power_source !== 'ac_power' ||
    value.benchmark_interference !== 'none_operator_confirmed' ||
    typeof value.cpu_brand !== 'string' ||
    typeof value.filesystem_device !== 'string' ||
    typeof value.reference_machine !== 'string' ||
    positiveSafeInteger(value.cpu_generation, 'CPU generation') < 2 ||
    positiveSafeInteger(value.memory_bytes, 'Memory bytes') < 17179869184 ||
    domainSeparatedSha256(
      'icarus:minimum-machine-observation:1\n',
      payload as JsonValue,
    ) !== hash
  ) {
    throw new Error('Minimum-machine certification observation drifted');
  }
  return {
    ...(value as unknown as G8MinimumMachineObservation),
    minimum_machine_class_ref: ref,
    observation_hash: hash,
  };
}

function parseBenchmarkStatistics(value: unknown, label: string): void {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'affected_rows',
      'max_ms',
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'peak_rss_bytes',
      'wal_bytes',
    ],
    label,
  );
  const p50 = nonNegativeFinite(value.p50_ms, `${label} p50`);
  const p95 = nonNegativeFinite(value.p95_ms, `${label} p95`);
  const p99 = nonNegativeFinite(value.p99_ms, `${label} p99`);
  const maximum = nonNegativeFinite(value.max_ms, `${label} max`);
  if (p50 > p95 || p95 > p99 || p99 > maximum)
    throw new Error(`${label} percentile ordering drifted`);
  positiveSafeInteger(value.peak_rss_bytes, `${label} peak RSS`);
  positiveSafeInteger(value.affected_rows, `${label} affected rows`);
  if (!Number.isSafeInteger(value.wal_bytes) || Number(value.wal_bytes) < 0)
    throw new Error(`${label} WAL bytes are invalid`);
}

function expectedCaseIds(): string[] {
  const ids: string[] = [];
  for (const transaction of ['t3', 't7', 't8'] as const)
    for (const shape of G8_BENCHMARK_SHAPES[transaction])
      for (const profile of G8_BENCHMARK_PROFILES)
        ids.push(`g8:${transaction}:${shape}:${profile}`);
  return ids;
}

function assertScalingDimensions(cases: readonly G8BenchmarkCaseObservation[]) {
  const profiles = ['scaling_25', 'scaling_50', 'scaling_100'] as const;
  for (const transaction of ['t3', 't7', 't8'] as const) {
    for (const shape of G8_BENCHMARK_SHAPES[transaction]) {
      const rows = profiles.map((profile) =>
        cases.find(
          (entry) =>
            entry.transaction === transaction &&
            entry.shape === shape &&
            entry.profile === profile,
        ),
      );
      if (rows.some((row) => !row))
        throw new Error(
          `Benchmark scaling series is incomplete: ${transaction}/${shape}`,
        );
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1]!.dimensions;
        const current = rows[index]!.dimensions;
        for (const key of Object.keys(previous)) {
          if (
            typeof previous[key] === 'number' &&
            typeof current[key] === 'number' &&
            current[key] < previous[key]
          ) {
            throw new Error(
              `Benchmark scaling dimension regressed: ${transaction}/${shape}/${key}`,
            );
          }
        }
      }
    }
  }
}

function assertProductFloorObservations(
  cases: readonly G8BenchmarkCaseObservation[],
): void {
  const supported = cases.filter(
    (entry) => entry.profile === 'supported_limit',
  );
  const maximum = (key: string) =>
    Math.max(
      0,
      ...supported.map((entry) =>
        typeof entry.dimensions[key] === 'number'
          ? Number(entry.dimensions[key])
          : 0,
      ),
    );
  const observed = {
    max_scopes_total: maximum('max_scopes_total'),
    max_nodes_total: maximum('max_nodes_total'),
    max_nodes_per_scope: maximum('observed_max_nodes_per_scope'),
    max_edges_total: maximum('max_edges_total'),
    max_edges_per_scope: maximum('observed_max_edges_per_scope'),
    max_map_items_total: maximum('max_map_items_total'),
    max_items_per_map: maximum('observed_max_items_per_map'),
    max_attempts_total: maximum('max_attempts_total'),
    max_waits_total: maximum('max_waits_total'),
    max_builds_total: maximum('max_builds_total'),
    max_effect_operations_total: maximum('max_effect_operations_total'),
    max_nesting_depth: maximum('observed_max_nesting_depth'),
    max_required_child_creations_per_t8: maximum(
      'max_required_child_creations_per_t8',
    ),
  } as const;
  for (const [key, expected] of Object.entries(observed)) {
    if (expected < G8_PRODUCT_FLOOR_COVERAGE[key as keyof typeof observed])
      throw new Error(`Benchmark Product Floor observation is low: ${key}`);
  }
}

export function assertG8BenchmarkCases(
  value: unknown,
): G8BenchmarkCaseObservation[] {
  if (!Array.isArray(value))
    throw new Error('Benchmark cases are not an array');
  const cases = value.map((entry, index) => {
    assertJsonObject(entry);
    exactKeys(entry, BENCHMARK_CASE_KEYS, `Benchmark case[${index}]`);
    if (
      !(['t3', 't7', 't8'] as const).includes(
        entry.transaction as G8BenchmarkTransaction,
      ) ||
      !(G8_BENCHMARK_PROFILES as readonly unknown[]).includes(entry.profile) ||
      typeof entry.shape !== 'string' ||
      entry.case_id !==
        `g8:${String(entry.transaction)}:${entry.shape}:${String(entry.profile)}` ||
      entry.warmup_iterations !== 10 ||
      entry.measurement_iterations !== 100 ||
      typeof entry.production_entry !== 'string' ||
      !Array.isArray(entry.production_index_evidence) ||
      !Array.isArray(entry.correctness_invariants)
    ) {
      throw new Error(`Benchmark case[${index}] fixed identity drifted`);
    }
    assertJsonObject(entry.dimensions);
    const profile = entry.profile as G8BenchmarkProfile;
    if (profile === 'beyond_limit') {
      if (entry.statistics !== null || entry.scale_percent !== null)
        throw new Error(`Benchmark case[${index}] Beyond Limit shape drifted`);
      assertJsonObject(entry.beyond_limit_rejection);
      const rejection = entry.beyond_limit_rejection;
      if (
        rejection.status !== 'rejected_before_atomic_write' ||
        rejection.error_code !== 'runtime_supported_limit_exceeded' ||
        rejection.affected_rows !== 0 ||
        rejection.database_before_hash !== rejection.database_after_hash
      )
        throw new Error(`Benchmark case[${index}] Beyond Limit proof failed`);
      parseSha256Hash(rejection.database_before_hash);
      assertJsonObject(rejection.attempted_dimensions);
    } else {
      if (entry.beyond_limit_rejection !== null)
        throw new Error(`Benchmark case[${index}] normal rejection drifted`);
      parseBenchmarkStatistics(entry.statistics, `Benchmark case[${index}]`);
      nonNegativeFinite(entry.scale_percent, `Benchmark case[${index}] scale`);
    }
    return entry as unknown as G8BenchmarkCaseObservation;
  });
  const ids = cases.map((entry) => entry.case_id);
  if (canonicalJson(ids) !== canonicalJson(expectedCaseIds()))
    throw new Error('Benchmark case order or completeness drifted');
  assertScalingDimensions(cases);
  assertProductFloorObservations(cases);
  const budgets = { t3: 250, t7: 1000, t8: 500 } as const;
  for (const entry of cases.filter(
    (candidate) => candidate.profile === 'supported_limit',
  )) {
    const statistics = entry.statistics!;
    if (
      statistics.p99_ms > budgets[entry.transaction] ||
      statistics.max_ms > budgets[entry.transaction] * 2
    )
      throw new Error(`Benchmark transaction budget failed: ${entry.case_id}`);
  }
  return cases;
}

export interface CreateG8BenchmarkObservationOptions {
  readonly profile: G8CertifiedSQLiteProfile;
  readonly release: G8CoreReleaseManifest;
  readonly releaseManifestHash: Sha256Hash;
  readonly machineObservation: G8MinimumMachineObservation;
  readonly cases: G8BenchmarkCaseObservation[];
}

export function createG8BenchmarkObservation(
  options: CreateG8BenchmarkObservationOptions,
): G8BenchmarkObservation {
  const artifacts = loadG8FoundationArtifacts();
  const profile = parseG8CertifiedSQLiteProfile(options.profile);
  const machine = parseMachineObservation(options.machineObservation);
  const cases = assertG8BenchmarkCases(options.cases);
  const casesHash = domainSeparatedSha256(
    'icarus:workflow-runtime-benchmark-cases:1\n',
    cases as unknown as JsonValue,
  );
  const payload = {
    format: 'icarus.workflow-runtime-benchmark-observation/1',
    ref: BENCHMARK_OBSERVATION_REF,
    benchmark_harness_ref: artifacts.benchmarkHarness.ref,
    benchmark_harness_hash: artifacts.benchmarkHarness.hash,
    benchmark_harness_version: '1.0.0',
    build_kind: 'release',
    database_kind: 'isolated_temporary_real_file',
    sqlite_profile_ref: profile.ref,
    sqlite_profile_hash: profile.profile_hash,
    release_manifest_hash: parseSha256Hash(options.releaseManifestHash),
    release_artifact_hash: options.release.release_artifact_hash,
    core_build_hash: options.release.core_build_hash,
    database_schema_hash: options.release.database_schema_hash,
    runtime_launcher_hash: options.release.runtime_launcher_hash,
    runtime_toolchain_hash: options.release.runtime_toolchain_hash,
    managed_node_distribution_hash:
      options.release.managed_node_distribution_hash,
    machine_observation: machine,
    warmup_iterations: 10,
    measurement_iterations: 100,
    cases,
    cases_hash: casesHash,
  } as const;
  return parseG8BenchmarkObservation({
    ...payload,
    observation_hash: domainSeparatedSha256(
      'icarus:workflow-runtime-benchmark-observation:1\n',
      payload as unknown as JsonValue,
    ),
  });
}

export function parseG8BenchmarkObservation(
  value: unknown,
): G8BenchmarkObservation {
  assertJsonObject(value);
  exactKeys(value, BENCHMARK_OBSERVATION_KEYS, 'Benchmark observation');
  const artifacts = loadG8FoundationArtifacts();
  const ref = exactRef(
    value.ref,
    BENCHMARK_OBSERVATION_REF,
    'Benchmark observation',
  );
  const harnessRef = exactRef(
    value.benchmark_harness_ref,
    artifacts.benchmarkHarness.ref,
    'Benchmark harness',
  );
  const profileRef = exactRef(
    value.sqlite_profile_ref,
    SQLITE_PROFILE_REF,
    'Benchmark SQLite Profile',
  );
  const cases = assertG8BenchmarkCases(value.cases);
  const casesHash = parseSha256Hash(value.cases_hash);
  for (const key of [
    'benchmark_harness_hash',
    'sqlite_profile_hash',
    'release_manifest_hash',
    'release_artifact_hash',
    'core_build_hash',
    'database_schema_hash',
    'runtime_launcher_hash',
    'runtime_toolchain_hash',
    'managed_node_distribution_hash',
  ] as const)
    parseSha256Hash(value[key]);
  const observationHash = parseSha256Hash(value.observation_hash);
  const { observation_hash: _observationHash, ...payload } = value;
  if (
    value.format !== 'icarus.workflow-runtime-benchmark-observation/1' ||
    value.benchmark_harness_hash !== artifacts.benchmarkHarness.hash ||
    value.benchmark_harness_version !== '1.0.0' ||
    value.build_kind !== 'release' ||
    value.database_kind !== 'isolated_temporary_real_file' ||
    value.warmup_iterations !== 10 ||
    value.measurement_iterations !== 100 ||
    domainSeparatedSha256(
      'icarus:workflow-runtime-benchmark-cases:1\n',
      cases as unknown as JsonValue,
    ) !== casesHash ||
    domainSeparatedSha256(
      'icarus:workflow-runtime-benchmark-observation:1\n',
      payload as JsonValue,
    ) !== observationHash
  )
    throw new Error('Benchmark observation content identity drifted');
  return {
    ...(value as unknown as G8BenchmarkObservation),
    ref,
    benchmark_harness_ref: harnessRef,
    sqlite_profile_ref: profileRef,
    machine_observation: parseMachineObservation(value.machine_observation),
    cases,
    cases_hash: casesHash,
    observation_hash: observationHash,
  };
}

function observedTransactionMaximum(
  observation: G8BenchmarkObservation,
  transaction: G8BenchmarkTransaction,
): number {
  const maxima = observation.cases
    .filter(
      (entry) =>
        entry.transaction === transaction &&
        entry.profile === 'supported_limit',
    )
    .map((entry) => entry.statistics!.max_ms);
  if (maxima.length !== G8_BENCHMARK_SHAPES[transaction].length)
    throw new Error(`Supported Limit ${transaction} benchmark is incomplete`);
  return Math.max(...maxima);
}

export interface CreateG8RuntimeSupportedLimitsOptions {
  readonly profile: G8CertifiedSQLiteProfile;
  readonly release: G8CoreReleaseManifest;
  readonly observation: G8BenchmarkObservation;
  readonly certifiedAtMs: number;
}

export function createG8RuntimeSupportedLimits(
  options: CreateG8RuntimeSupportedLimitsOptions,
): G8RuntimeSupportedLimits {
  const artifacts = loadG8FoundationArtifacts();
  const profile = parseG8CertifiedSQLiteProfile(options.profile);
  const observation = parseG8BenchmarkObservation(options.observation);
  const certifiedAtMs = positiveSafeInteger(
    options.certifiedAtMs,
    'Certification timestamp',
  );
  if (
    observation.sqlite_profile_hash !== profile.profile_hash ||
    observation.release_artifact_hash !==
      options.release.release_artifact_hash ||
    observation.core_build_hash !== options.release.core_build_hash ||
    observation.database_schema_hash !== options.release.database_schema_hash ||
    observation.runtime_launcher_hash !==
      options.release.runtime_launcher_hash ||
    observation.runtime_toolchain_hash !==
      options.release.runtime_toolchain_hash ||
    profile.release_artifact_hash !== options.release.release_artifact_hash ||
    profile.runtime_launcher_hash !== options.release.runtime_launcher_hash ||
    profile.managed_node_distribution_hash !==
      options.release.managed_node_distribution_hash ||
    profile.managed_node_distribution_ref.id !==
      options.release.managed_node_distribution_ref.id ||
    profile.managed_node_distribution_ref.version !==
      options.release.managed_node_distribution_ref.version ||
    observation.managed_node_distribution_hash !==
      options.release.managed_node_distribution_hash
  )
    throw new Error('Supported Limits certification key inputs disagree');
  const machine = observation.machine_observation;
  const payload = {
    ref: SUPPORTED_LIMITS_REF,
    ...G8_SUPPORTED_LIMITS,
    certification: {
      status: 'certified',
      deployment_profile: 'local_single_user',
      runtime_surface: 'node_service',
      platform: 'darwin',
      arch: 'arm64',
      release_artifact_hash: options.release.release_artifact_hash,
      database_schema_hash: options.release.database_schema_hash,
      core_build_hash: options.release.core_build_hash,
      runtime_launcher_hash: options.release.runtime_launcher_hash,
      managed_node_distribution_ref:
        options.release.managed_node_distribution_ref,
      managed_node_distribution_hash:
        options.release.managed_node_distribution_hash,
      sqlite_execution_profile_ref: profile.ref,
      sqlite_execution_profile_hash: profile.profile_hash,
      benchmark_harness_version: '1.0.0',
      benchmark_harness_hash: artifacts.benchmarkHarness.hash,
      limit_derivation_hash: artifacts.limitDerivation.hash,
      reference_machine: machine.reference_machine,
      minimum_machine_class_ref: artifacts.minimumMachineClass.ref,
      minimum_machine_class_hash: artifacts.minimumMachineClass.hash,
      startup_smoke_harness_hash: artifacts.startupSmokeHarness.hash,
      startup_smoke_max_duration_ms:
        artifacts.startupSmokeHarness.payload.startup_smoke_max_duration_ms,
      filesystem_type: 'apfs',
      storage_class: 'internal_ssd',
      t3_max_transaction_duration_ms: observedTransactionMaximum(
        observation,
        't3',
      ),
      t7_max_transaction_duration_ms: observedTransactionMaximum(
        observation,
        't7',
      ),
      t8_max_transaction_duration_ms: observedTransactionMaximum(
        observation,
        't8',
      ),
      certified_at_ms: certifiedAtMs,
    },
  } as const;
  return parseG8RuntimeSupportedLimits({
    ...payload,
    profile_hash: domainSeparatedSha256(
      'icarus:runtime-supported-limits:1\n',
      payload as unknown as JsonValue,
    ),
  });
}

export function parseG8RuntimeSupportedLimits(
  value: unknown,
): G8RuntimeSupportedLimits {
  assertJsonObject(value);
  exactKeys(
    value,
    ['certification', 'profile_hash', 'ref', ...G8_SUPPORTED_LIMIT_KEYS],
    'RuntimeSupportedLimits',
  );
  const ref = exactRef(
    value.ref,
    SUPPORTED_LIMITS_REF,
    'RuntimeSupportedLimits',
  );
  for (const key of G8_SUPPORTED_LIMIT_KEYS) {
    if (value[key] !== G8_SUPPORTED_LIMITS[key])
      throw new Error(`RuntimeSupportedLimits ${key} drifted`);
  }
  assertJsonObject(value.certification);
  exactKeys(
    value.certification,
    LIMIT_CERTIFICATION_KEYS,
    'RuntimeSupportedLimits certification',
  );
  const certification = value.certification;
  if (
    certification.status !== 'certified' ||
    certification.deployment_profile !== 'local_single_user' ||
    certification.runtime_surface !== 'node_service' ||
    certification.platform !== 'darwin' ||
    certification.arch !== 'arm64' ||
    certification.benchmark_harness_version !== '1.0.0' ||
    certification.filesystem_type !== 'apfs' ||
    certification.storage_class !== 'internal_ssd'
  )
    throw new Error('RuntimeSupportedLimits certification identity drifted');
  parseVersionedRef(certification.managed_node_distribution_ref);
  parseVersionedRef(certification.sqlite_execution_profile_ref);
  parseVersionedRef(certification.minimum_machine_class_ref);
  for (const key of [
    'release_artifact_hash',
    'database_schema_hash',
    'core_build_hash',
    'runtime_launcher_hash',
    'managed_node_distribution_hash',
    'sqlite_execution_profile_hash',
    'benchmark_harness_hash',
    'limit_derivation_hash',
    'minimum_machine_class_hash',
    'startup_smoke_harness_hash',
  ] as const)
    parseSha256Hash(certification[key]);
  for (const key of [
    'startup_smoke_max_duration_ms',
    't3_max_transaction_duration_ms',
    't7_max_transaction_duration_ms',
    't8_max_transaction_duration_ms',
    'certified_at_ms',
  ] as const)
    positiveSafeInteger(certification[key], `RuntimeSupportedLimits ${key}`);
  if (typeof certification.reference_machine !== 'string')
    throw new Error('RuntimeSupportedLimits reference machine is invalid');
  const profileHash = parseSha256Hash(value.profile_hash);
  const { profile_hash: _hash, ...payload } = value;
  if (
    domainSeparatedSha256(
      'icarus:runtime-supported-limits:1\n',
      payload as JsonValue,
    ) !== profileHash
  )
    throw new Error('RuntimeSupportedLimits content identity drifted');
  return {
    ...(value as unknown as G8RuntimeSupportedLimits),
    ref,
    profile_hash: profileHash,
  };
}

function parseStartupSmokeReport(value: unknown): JsonObject {
  assertJsonObject(value);
  exactKeys(value, STARTUP_SMOKE_REPORT_KEYS, 'Startup-smoke report');
  const artifacts = loadG8FoundationArtifacts();
  const hash = parseSha256Hash(value.report_hash);
  const { report_hash: _hash, ...payload } = value;
  if (
    value.format !== 'icarus.startup-smoke-report/1' ||
    value.status !== 'pass' ||
    value.startup_smoke_harness_hash !== artifacts.startupSmokeHarness.hash ||
    value.startup_smoke_max_duration_ms !== 5000 ||
    value.database_schema_version !== 11 ||
    value.transaction_affected_rows !== 0 ||
    typeof value.duration_ms !== 'number' ||
    !Number.isFinite(value.duration_ms) ||
    value.duration_ms < 0 ||
    value.duration_ms > Number(value.startup_smoke_max_duration_ms) ||
    value.production_pragmas_verified !== true ||
    value.integrity_check_verified !== true ||
    value.reopen_verified !== true ||
    domainSeparatedSha256(
      'icarus:startup-smoke-report:1\n',
      payload as JsonValue,
    ) !== hash
  )
    throw new Error('Startup-smoke report is invalid');
  exactRef(
    value.startup_smoke_harness_ref,
    artifacts.startupSmokeHarness.ref,
    'Startup-smoke harness',
  );
  parseSha256Hash(value.sqlite_profile_candidate_hash);
  assertJsonObject(value.identity_evidence);
  assertJsonObject(value.machine_observation);
  return value;
}

export interface CreateG8CertificationPackOptions {
  readonly profile: G8CertifiedSQLiteProfile;
  readonly release: G8CoreReleaseManifest;
  readonly releaseManifestHash: Sha256Hash;
  readonly observation: G8BenchmarkObservation;
  readonly limits: G8RuntimeSupportedLimits;
  readonly startupSmokeReport: JsonObject;
}

export function createG8CertificationPack(
  options: CreateG8CertificationPackOptions,
): G8CertificationPack {
  const artifacts = loadG8FoundationArtifacts();
  const profile = parseG8CertifiedSQLiteProfile(options.profile);
  const observation = parseG8BenchmarkObservation(options.observation);
  const limits = parseG8RuntimeSupportedLimits(options.limits);
  const smoke = parseStartupSmokeReport(options.startupSmokeReport);
  const releaseManifestHash = parseSha256Hash(options.releaseManifestHash);
  const evidence = smoke.identity_evidence as JsonObject;
  if (
    observation.release_manifest_hash !== releaseManifestHash ||
    observation.release_artifact_hash !==
      options.release.release_artifact_hash ||
    limits.certification.release_artifact_hash !==
      options.release.release_artifact_hash ||
    limits.certification.sqlite_execution_profile_hash !==
      profile.profile_hash ||
    limits.certification.certified_at_ms !==
      positiveSafeInteger(
        limits.certification.certified_at_ms,
        'Certification timestamp',
      ) ||
    smoke.startup_smoke_harness_hash !== artifacts.startupSmokeHarness.hash ||
    smoke.database_schema_hash !== options.release.database_schema_hash ||
    evidence.release_artifact_profile_hash !==
      options.release.release_artifact_hash ||
    evidence.release_manifest_hash !== releaseManifestHash ||
    evidence.core_build_hash !== options.release.core_build_hash ||
    evidence.release_database_schema_hash !==
      options.release.database_schema_hash ||
    evidence.managed_distribution_hash !==
      profile.managed_node_distribution_hash ||
    evidence.managed_node_version !== 'v26.5.0' ||
    evidence.runtime_launcher_observed_hash !== profile.runtime_launcher_hash ||
    evidence.managed_node_executable_hash !== profile.node_executable_hash ||
    evidence.better_sqlite3_native_module_hash !==
      profile.better_sqlite3_native_module_hash ||
    evidence.sqlite_compile_options_hash !==
      profile.sqlite_compile_options_hash ||
    evidence.sqlite_version !== profile.sqlite_version ||
    evidence.sqlite_source_id !== profile.sqlite_source_id
  )
    throw new Error('Certification pack input cross-binding failed');
  const machine = observation.machine_observation;
  const key: G8CertificationKey = {
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    platform: 'darwin',
    arch: 'arm64',
    release_manifest_hash: releaseManifestHash,
    release_artifact_hash: options.release.release_artifact_hash,
    core_build_hash: options.release.core_build_hash,
    database_schema_hash: options.release.database_schema_hash,
    runtime_launcher_hash: options.release.runtime_launcher_hash,
    runtime_toolchain_hash: options.release.runtime_toolchain_hash,
    managed_node_distribution_ref:
      options.release.managed_node_distribution_ref,
    managed_node_distribution_hash:
      options.release.managed_node_distribution_hash,
    node_runtime_version: '26.5.0',
    node_executable_hash: profile.node_executable_hash,
    better_sqlite3_version: '12.11.1',
    better_sqlite3_native_module_hash:
      profile.better_sqlite3_native_module_hash,
    sqlite_version: profile.sqlite_version,
    sqlite_source_id: profile.sqlite_source_id,
    sqlite_compile_options_hash: profile.sqlite_compile_options_hash,
    sqlite_execution_profile_ref: profile.ref,
    sqlite_execution_profile_hash: profile.profile_hash,
    benchmark_harness_ref: artifacts.benchmarkHarness.ref,
    benchmark_harness_version: '1.0.0',
    benchmark_harness_hash: artifacts.benchmarkHarness.hash,
    benchmark_observation_hash: observation.observation_hash,
    limit_derivation_ref: artifacts.limitDerivation.ref,
    limit_derivation_hash: artifacts.limitDerivation.hash,
    runtime_supported_limits_ref: limits.ref,
    runtime_supported_limits_hash: limits.profile_hash,
    product_floor_ref: artifacts.limitDerivation.payload.product_floor_ref,
    product_floor_hash: artifacts.limitDerivation.payload.product_floor_hash,
    minimum_machine_class_ref: artifacts.minimumMachineClass.ref,
    minimum_machine_class_hash: artifacts.minimumMachineClass.hash,
    minimum_machine_observation_hash: machine.observation_hash,
    startup_smoke_harness_ref: artifacts.startupSmokeHarness.ref,
    startup_smoke_harness_hash: artifacts.startupSmokeHarness.hash,
    startup_smoke_report_hash: parseSha256Hash(smoke.report_hash),
  };
  const certificationKeyHash = domainSeparatedSha256(
    'icarus:workflow-runtime-certification-key:1\n',
    key as unknown as JsonValue,
  );
  const payload = {
    format: 'icarus.workflow-runtime-certification-pack/1',
    ref: CERTIFICATION_PACK_REF,
    version: 1,
    status: 'certified',
    certification_key: key,
    certification_key_hash: certificationKeyHash,
    certified_at_ms: limits.certification.certified_at_ms,
    security_sensitive_validation: 'SECURITY_VALIDATION_NOT_RUN',
    security_validation_basis:
      'static_source_existing_tests_and_invariant_mapping_only',
  } as const;
  return parseG8CertificationPack({
    ...payload,
    pack_hash: domainSeparatedSha256(
      'icarus:workflow-runtime-certification-pack:1\n',
      payload as unknown as JsonValue,
    ),
  });
}

export function parseG8CertificationPack(value: unknown): G8CertificationPack {
  assertJsonObject(value);
  exactKeys(value, CERTIFICATION_PACK_KEYS, 'G8 Certification Pack');
  const ref = exactRef(
    value.ref,
    CERTIFICATION_PACK_REF,
    'G8 Certification Pack',
  );
  assertJsonObject(value.certification_key);
  exactKeys(
    value.certification_key,
    CERTIFICATION_KEY_KEYS,
    'G8 Certification Key',
  );
  const key = value.certification_key;
  for (const field of Object.keys(key).filter((name) => name.endsWith('_hash')))
    parseSha256Hash(key[field]);
  for (const field of Object.keys(key).filter((name) => name.endsWith('_ref')))
    parseVersionedRef(key[field]);
  const keyHash = parseSha256Hash(value.certification_key_hash);
  const packHash = parseSha256Hash(value.pack_hash);
  const { pack_hash: _packHash, ...payload } = value;
  if (
    value.format !== 'icarus.workflow-runtime-certification-pack/1' ||
    value.version !== 1 ||
    value.status !== 'certified' ||
    value.security_sensitive_validation !== 'SECURITY_VALIDATION_NOT_RUN' ||
    value.security_validation_basis !==
      'static_source_existing_tests_and_invariant_mapping_only' ||
    positiveSafeInteger(value.certified_at_ms, 'Certification timestamp') !==
      value.certified_at_ms ||
    domainSeparatedSha256(
      'icarus:workflow-runtime-certification-key:1\n',
      key as JsonValue,
    ) !== keyHash ||
    domainSeparatedSha256(
      'icarus:workflow-runtime-certification-pack:1\n',
      payload as JsonValue,
    ) !== packHash
  )
    throw new Error('G8 Certification Pack content identity drifted');
  return {
    ...(value as unknown as G8CertificationPack),
    ref,
    certification_key: key as unknown as G8CertificationKey,
    certification_key_hash: keyHash,
    pack_hash: packHash,
  };
}

export interface AssembleG8CertificationOptions {
  readonly outputRoot: string;
  readonly certifiedAtMs: number;
}

function readJson(filePath: string): JsonValue {
  return strictParseJsonBytes(fs.readFileSync(filePath));
}

export function assembleG8Certification(
  options: AssembleG8CertificationOptions,
): { limits: G8RuntimeSupportedLimits; pack: G8CertificationPack } {
  const outputRoot = fs.realpathSync(options.outputRoot);
  const releasePath = path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME);
  const profilePath = path.join(
    outputRoot,
    G8_CERTIFIED_SQLITE_PROFILE_FILENAME,
  );
  const observationPath = path.join(
    outputRoot,
    G8_BENCHMARK_OBSERVATION_FILENAME,
  );
  const smokePath = path.join(outputRoot, G8_STARTUP_SMOKE_REPORT_FILENAME);
  const release = parseG8CoreReleaseManifest(readJson(releasePath));
  const releaseManifestHash = rawSha256(releasePath);
  const profile = parseG8CertifiedSQLiteProfile(readJson(profilePath));
  const observation = parseG8BenchmarkObservation(readJson(observationPath));
  const smoke = readJson(smokePath);
  assertJsonObject(smoke);
  const limits = createG8RuntimeSupportedLimits({
    profile,
    release,
    observation,
    certifiedAtMs: options.certifiedAtMs,
  });
  const pack = createG8CertificationPack({
    profile,
    release,
    releaseManifestHash,
    observation,
    limits,
    startupSmokeReport: smoke,
  });
  writeG8JsonAtomic(
    path.join(outputRoot, G8_RUNTIME_SUPPORTED_LIMITS_FILENAME),
    limits,
  );
  writeG8JsonAtomic(
    path.join(outputRoot, G8_CERTIFICATION_PACK_FILENAME),
    pack,
  );
  return { limits, pack };
}

export function checkG8CertificationOutput(outputRootInput: string): {
  profile: G8CertifiedSQLiteProfile;
  observation: G8BenchmarkObservation;
  limits: G8RuntimeSupportedLimits;
  pack: G8CertificationPack;
} {
  const outputRoot = fs.realpathSync(outputRootInput);
  const releasePath = path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME);
  const release = parseG8CoreReleaseManifest(readJson(releasePath));
  const releaseManifestHash = rawSha256(releasePath);
  const profile = parseG8CertifiedSQLiteProfile(
    readJson(path.join(outputRoot, G8_CERTIFIED_SQLITE_PROFILE_FILENAME)),
  );
  const observation = parseG8BenchmarkObservation(
    readJson(path.join(outputRoot, G8_BENCHMARK_OBSERVATION_FILENAME)),
  );
  const limits = parseG8RuntimeSupportedLimits(
    readJson(path.join(outputRoot, G8_RUNTIME_SUPPORTED_LIMITS_FILENAME)),
  );
  const pack = parseG8CertificationPack(
    readJson(path.join(outputRoot, G8_CERTIFICATION_PACK_FILENAME)),
  );
  const smoke = readJson(
    path.join(outputRoot, G8_STARTUP_SMOKE_REPORT_FILENAME),
  );
  assertJsonObject(smoke);
  const expectedLimits = createG8RuntimeSupportedLimits({
    profile,
    release,
    observation,
    certifiedAtMs: limits.certification.certified_at_ms,
  });
  const expectedPack = createG8CertificationPack({
    profile,
    release,
    releaseManifestHash,
    observation,
    limits,
    startupSmokeReport: smoke,
  });
  if (
    canonicalJson(limits as unknown as JsonValue) !==
      canonicalJson(expectedLimits as unknown as JsonValue) ||
    canonicalJson(pack as unknown as JsonValue) !==
      canonicalJson(expectedPack as unknown as JsonValue)
  )
    throw new Error('G8 Certification derived artifact drifted');
  return { profile, observation, limits, pack };
}
