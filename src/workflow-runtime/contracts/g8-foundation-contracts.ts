import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseContractArtifactEnvelope } from './artifact.js';
import { domainSeparatedSha256, parseSha256Hash } from './hash.js';
import {
  G8_OBVIOUS_REGRESSION_MAX_MS,
  G8_READINESS_BEYOND_LIMIT_DIMENSIONS,
  G8_READINESS_MEASUREMENT_ITERATIONS,
  G8_READINESS_PROFILES,
  G8_READINESS_REPRESENTATIVES,
  G8_READINESS_WARMUP_ITERATIONS,
  G8_SUPPORTED_LIMITS,
} from './g8-limits.js';
import type {
  G8FoundationContractArtifact,
  G8ReadinessHarnessPayload,
  G8StartupSmokeHarnessPayload,
} from './g8-validation-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const G8_STARTUP_SMOKE_HARNESS_PATH =
  'src/workflow-runtime/contracts/certification/startup-smoke-harness@1.json';
export const G8_READINESS_HARNESS_PATH =
  'src/workflow-runtime/contracts/certification/g8-readiness-harness@1.json';

const startupSmokeSources = [
  'src/workflow-runtime/certification/release-entry.ts',
  'src/workflow-runtime/certification/startup-smoke.ts',
  'src/workflow-runtime/contracts/g8-foundation-contracts.ts',
  'src/workflow-runtime/store/runtime-store/identity.ts',
  'src/workflow-runtime/store/runtime-store/index.ts',
  'src/workflow-runtime/store/runtime-store/profile.ts',
] as const;

const readinessSources = [
  'src/workflow-runtime/certification/benchmark-runner.ts',
  'src/workflow-runtime/certification/benchmark-shapes.ts',
  'src/workflow-runtime/certification/g8-readiness-artifacts.ts',
  'src/workflow-runtime/certification/release-validation.ts',
  'src/workflow-runtime/contracts/certification/g8-validation-reports-schema.json',
  'src/workflow-runtime/contracts/g8-foundation-contracts.ts',
  'src/workflow-runtime/contracts/g8-limits.ts',
  'src/workflow-runtime/contracts/g8-validation-types.ts',
  'src/workflow-runtime/runtime/graph-runtime.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
  'src/workflow-runtime/runtime/root-finalizer.ts',
] as const;

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function sourceTreeHash(
  projectRoot: string,
  domain: string,
  sourcePaths: readonly string[],
): Sha256Hash {
  const entries = [...sourcePaths].sort().map((sourcePath) => ({
    path: sourcePath,
    raw_sha256: rawSha256(path.join(projectRoot, sourcePath)),
  }));
  return domainSeparatedSha256(domain, entries);
}

function artifact<TPayload extends JsonObject>(
  format: G8FoundationContractArtifact['format'],
  ref: { id: string; version: string },
  domainSeparator: string,
  payload: TPayload,
): G8FoundationContractArtifact<TPayload> {
  const withoutHash = {
    format,
    ref,
    version: 1,
    domain_separator: domainSeparator,
    payload,
  } as const;
  return {
    ...withoutHash,
    hash: domainSeparatedSha256(
      domainSeparator,
      withoutHash as unknown as JsonValue,
    ),
  };
}

export interface G8FoundationArtifacts {
  readonly startupSmokeHarness: G8FoundationContractArtifact<G8StartupSmokeHarnessPayload>;
  readonly readinessHarness: G8FoundationContractArtifact<G8ReadinessHarnessPayload>;
}

export function createG8FoundationArtifacts(
  projectRoot: string,
): G8FoundationArtifacts {
  const startupSmokePayload: G8StartupSmokeHarnessPayload = {
    harness_id: 'local_single_user_startup_smoke@1',
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    identity_mode: 'release_validation',
    database_schema_version: 11,
    database_kind: 'isolated_temporary_real_file',
    database_filename: 'workflow-runtime.db',
    connection_profile: 'production_pragmas',
    transaction_kind: 'begin_immediate',
    transaction_probe: 'zero_row_parameterized_dml',
    reopen_required: true,
    integrity_check_required: true,
    foreign_key_check_required: true,
    startup_smoke_max_duration_ms: 5000,
    implementation_source_tree_hash: sourceTreeHash(
      projectRoot,
      'icarus:startup-smoke-implementation-source-tree:1\n',
      startupSmokeSources,
    ),
  };
  const startupSmokeHarness = artifact(
    'icarus.startup-smoke-harness/1',
    { id: 'local_single_user_startup_smoke', version: '1.0.0' },
    'icarus:startup-smoke-harness:1\n',
    startupSmokePayload,
  );
  const readinessPayload: G8ReadinessHarnessPayload = {
    harness_id: 'local_single_user_g8_readiness@1',
    harness_version: '1.0.0',
    deployment_profile: 'local_single_user',
    runtime_surface: 'node_service',
    platform: 'darwin',
    arch: 'arm64',
    build_kind: 'release',
    identity_mode: 'release_validation',
    database_kind: 'isolated_temporary_real_file',
    connection_profile: 'production_pragmas',
    transaction_kind: 'begin_immediate',
    warmup_iterations: G8_READINESS_WARMUP_ITERATIONS,
    measurement_iterations: G8_READINESS_MEASUREMENT_ITERATIONS,
    profiles: [...G8_READINESS_PROFILES],
    supported_limits: G8_SUPPORTED_LIMITS,
    beyond_limit_dimensions: G8_READINESS_BEYOND_LIMIT_DIMENSIONS,
    representatives: {
      t3: [...G8_READINESS_REPRESENTATIVES.t3],
      t7: [...G8_READINESS_REPRESENTATIVES.t7],
      t8: [...G8_READINESS_REPRESENTATIVES.t8],
    },
    obvious_regression_max_ms: G8_OBVIOUS_REGRESSION_MAX_MS,
    metrics: [
      'p50_ms',
      'p95_ms',
      'p99_ms',
      'max_ms',
      'wal_bytes',
      'peak_rss_bytes',
      'affected_rows',
    ],
    beyond_limit_rejection: 'before_business_transaction_and_write',
    production_entries: {
      t3: 'reconcileFactT3a',
      t7: 'requestScopeCloseT7a',
      t8: 'commitRootT8',
    },
    implementation_source_tree_hash: sourceTreeHash(
      projectRoot,
      'icarus:g8-readiness-implementation-source-tree:1\n',
      readinessSources,
    ),
  };
  const readinessHarness = artifact(
    'icarus.workflow-runtime-g8-readiness-harness/1',
    { id: 'local_single_user_g8_readiness', version: '1.0.0' },
    'icarus:workflow-runtime-g8-readiness-harness:1\n',
    readinessPayload,
  );
  return { startupSmokeHarness, readinessHarness };
}

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

function readArtifact<TPayload extends JsonObject>(
  filePath: string,
  expectedFormat: G8FoundationContractArtifact['format'],
  expectedRef: { id: string; version: string },
  expectedDomain: string,
  payloadKeys: readonly string[],
): G8FoundationContractArtifact<TPayload> {
  const value = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(filePath)),
  );
  exactKeys(value.payload, payloadKeys, expectedFormat);
  if (
    value.format !== expectedFormat ||
    value.ref.id !== expectedRef.id ||
    value.ref.version !== expectedRef.version ||
    value.version !== 1 ||
    value.domain_separator !== expectedDomain
  ) {
    throw new Error(`${expectedFormat} fixed identity drifted`);
  }
  parseSha256Hash(value.hash);
  return value as unknown as G8FoundationContractArtifact<TPayload>;
}

export function loadG8FoundationArtifacts(
  contractsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'certification',
  ),
): G8FoundationArtifacts {
  const startupSmokeHarness = readArtifact<G8StartupSmokeHarnessPayload>(
    path.join(contractsRoot, 'startup-smoke-harness@1.json'),
    'icarus.startup-smoke-harness/1',
    { id: 'local_single_user_startup_smoke', version: '1.0.0' },
    'icarus:startup-smoke-harness:1\n',
    [
      'harness_id',
      'deployment_profile',
      'runtime_surface',
      'identity_mode',
      'database_schema_version',
      'database_kind',
      'database_filename',
      'connection_profile',
      'transaction_kind',
      'transaction_probe',
      'reopen_required',
      'integrity_check_required',
      'foreign_key_check_required',
      'startup_smoke_max_duration_ms',
      'implementation_source_tree_hash',
    ],
  );
  const readinessHarness = readArtifact<G8ReadinessHarnessPayload>(
    path.join(contractsRoot, 'g8-readiness-harness@1.json'),
    'icarus.workflow-runtime-g8-readiness-harness/1',
    { id: 'local_single_user_g8_readiness', version: '1.0.0' },
    'icarus:workflow-runtime-g8-readiness-harness:1\n',
    [
      'harness_id',
      'harness_version',
      'deployment_profile',
      'runtime_surface',
      'platform',
      'arch',
      'build_kind',
      'identity_mode',
      'database_kind',
      'connection_profile',
      'transaction_kind',
      'warmup_iterations',
      'measurement_iterations',
      'profiles',
      'supported_limits',
      'beyond_limit_dimensions',
      'representatives',
      'obvious_regression_max_ms',
      'metrics',
      'beyond_limit_rejection',
      'production_entries',
      'implementation_source_tree_hash',
    ],
  );
  return { startupSmokeHarness, readinessHarness };
}
