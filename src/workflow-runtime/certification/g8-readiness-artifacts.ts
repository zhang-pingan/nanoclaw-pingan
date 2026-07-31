import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  G8_OBVIOUS_REGRESSION_MAX_MS,
  G8_READINESS_BEYOND_LIMIT_DIMENSIONS,
  G8_READINESS_MEASUREMENT_ITERATIONS,
  G8_READINESS_REPRESENTATIVES,
  G8_READINESS_WARMUP_ITERATIONS,
  G8_SUPPORTED_LIMITS,
  assertG8DimensionsWithinSupportedLimits,
} from '../contracts/g8-limits.js';
import type {
  G8BenchmarkCaseObservation,
  G8BenchmarkTransaction,
  G8ReadinessReport,
  G8StartupSmokeReport,
} from '../contracts/g8-validation-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeIdentityEvidence } from '../store/runtime-store/identity.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import {
  parseRevalidatableCoreReleaseManifest,
  type RevalidatableCoreReleaseManifest,
} from './release-manifest.js';

export const G8_VALIDATION_OUTPUT_ROOT =
  'src/workflow-runtime/contracts/certification/generated';
export const G8_CORE_RELEASE_MANIFEST_FILENAME = 'core-release-manifest@1.json';
export const G8_STARTUP_SMOKE_REPORT_FILENAME = 'startup-smoke-report@1.json';
export const G8_READINESS_REPORT_FILENAME = 'g8-readiness-report@1.json';

const REPORT_REF = {
  id: 'icarus.workflow-runtime-g8-readiness',
  version: '1.0.0',
} as const;

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

function assertReadinessCases(
  cases: readonly G8BenchmarkCaseObservation[],
): void {
  if (cases.length !== 6) throw new Error('G8 readiness requires six cases');
  for (const transaction of ['t3', 't7', 't8'] as const) {
    const expectedShape = G8_READINESS_REPRESENTATIVES[transaction][0];
    const expectedEntry =
      transaction === 't3'
        ? 'reconcileFactT3a'
        : transaction === 't7'
          ? 'requestScopeCloseT7a'
          : 'commitRootT8';
    const family = cases.filter((entry) => entry.transaction === transaction);
    if (
      family.length !== 2 ||
      family.some(
        (entry) =>
          entry.shape !== expectedShape ||
          entry.case_id !==
            `g8:${transaction}:${expectedShape}:${entry.profile}` ||
          entry.production_entry !== expectedEntry ||
          entry.warmup_iterations !== G8_READINESS_WARMUP_ITERATIONS ||
          entry.measurement_iterations !== G8_READINESS_MEASUREMENT_ITERATIONS,
      )
    ) {
      throw new Error(`G8 ${transaction} representative coverage drifted`);
    }
    const supported = family.find(
      (entry) => entry.profile === 'supported_limit',
    );
    const beyond = family.find((entry) => entry.profile === 'beyond_limit');
    if (
      !supported?.statistics ||
      supported.beyond_limit_rejection !== null ||
      supported.statistics.affected_rows <= 0 ||
      supported.statistics.max_ms > G8_OBVIOUS_REGRESSION_MAX_MS[transaction]
    ) {
      throw new Error(`G8 ${transaction} supported representative failed`);
    }
    assertG8DimensionsWithinSupportedLimits(supported.limit_dimensions);
    const beyondRejection = beyond?.beyond_limit_rejection;
    if (
      beyond?.statistics !== null ||
      !beyondRejection ||
      beyondRejection.affected_rows !== 0 ||
      beyondRejection.database_before_hash !==
        beyondRejection.database_after_hash
    ) {
      throw new Error(`G8 ${transaction} Beyond Limit invariant failed`);
    }
    const expectedObservations = [
      ...Array.from(
        { length: G8_READINESS_WARMUP_ITERATIONS },
        (_, index) => ({ phase: 'warmup', iteration: index + 1 }) as const,
      ),
      ...Array.from(
        { length: G8_READINESS_MEASUREMENT_ITERATIONS },
        (_, index) => ({ phase: 'measurement', iteration: index + 1 }) as const,
      ),
    ];
    if (
      beyondRejection.observations.length !== expectedObservations.length ||
      beyondRejection.observations.some((observation, index) => {
        const expected = expectedObservations[index]!;
        return (
          observation.phase !== expected.phase ||
          observation.iteration !== expected.iteration ||
          observation.status !== 'rejected_before_atomic_write' ||
          observation.error_code !== 'runtime_supported_limit_exceeded' ||
          observation.affected_rows !== 0 ||
          observation.database_before_hash !==
            observation.database_after_hash ||
          observation.database_before_hash !==
            beyondRejection.database_before_hash
        );
      })
    ) {
      throw new Error(
        `G8 ${transaction} Beyond Limit observation count drifted`,
      );
    }
    if (
      JSON.stringify(beyond.limit_dimensions) !==
        JSON.stringify(G8_READINESS_BEYOND_LIMIT_DIMENSIONS[transaction]) ||
      JSON.stringify(beyondRejection.attempted_dimensions) !==
        JSON.stringify(G8_READINESS_BEYOND_LIMIT_DIMENSIONS[transaction])
    ) {
      throw new Error(`G8 ${transaction} Beyond Limit dimensions drifted`);
    }
  }
}

export interface CreateG8ReadinessReportOptions {
  readonly release: RevalidatableCoreReleaseManifest;
  readonly releaseManifestHash: Sha256Hash;
  readonly startupReport: G8StartupSmokeReport;
  readonly evidence: WorkflowRuntimeIdentityEvidence;
  readonly sqliteProfileCandidateHash: Sha256Hash;
  readonly cases: G8BenchmarkCaseObservation[];
}

export function createG8ReadinessReport(
  options: CreateG8ReadinessReportOptions,
): G8ReadinessReport {
  const release = parseRevalidatableCoreReleaseManifest(options.release);
  const artifacts = loadG8FoundationArtifacts();
  if (
    JSON.stringify(artifacts.readinessHarness.payload.supported_limits) !==
      JSON.stringify(G8_SUPPORTED_LIMITS) ||
    JSON.stringify(
      artifacts.readinessHarness.payload.beyond_limit_dimensions,
    ) !== JSON.stringify(G8_READINESS_BEYOND_LIMIT_DIMENSIONS)
  ) {
    throw new Error('G8 readiness Supported Limit authority drifted');
  }
  assertReadinessCases(options.cases);
  const evidence = options.evidence;
  const startupReport = options.startupReport;
  const startupEvidence = startupReport.identity_evidence;
  const { report_hash: startupReportHash, ...startupReportPayload } =
    startupReport;
  if (
    startupReportHash !==
      domainSeparatedSha256(
        'icarus:startup-smoke-report:1\n',
        startupReportPayload as unknown as JsonValue,
      ) ||
    JSON.stringify(startupReport.startup_smoke_harness_ref) !==
      JSON.stringify(artifacts.startupSmokeHarness.ref) ||
    startupReport.startup_smoke_harness_hash !==
      artifacts.startupSmokeHarness.hash ||
    startupReport.database_schema_hash !== release.database_schema_hash ||
    startupReport.sqlite_profile_candidate_hash !==
      options.sqliteProfileCandidateHash ||
    startupEvidence.release_manifest_hash !== options.releaseManifestHash ||
    startupEvidence.release_artifact_profile_hash !==
      release.release_artifact_hash ||
    startupEvidence.core_build_hash !== release.core_build_hash ||
    startupEvidence.runtime_launcher_observed_hash !==
      release.runtime_launcher_hash ||
    startupEvidence.managed_distribution_hash !==
      release.managed_node_distribution_hash ||
    startupEvidence.managed_node_executable_hash !==
      evidence.managed_node_executable_hash ||
    startupEvidence.better_sqlite3_native_module_hash !==
      evidence.better_sqlite3_native_module_hash ||
    startupEvidence.sqlite_version !== evidence.sqlite_version ||
    startupEvidence.sqlite_source_id !== evidence.sqlite_source_id ||
    startupEvidence.sqlite_compile_options_hash !==
      evidence.sqlite_compile_options_hash ||
    evidence.identity_mode !== 'release_validation' ||
    evidence.validation_status !== 'release_validation' ||
    evidence.release_identity_status !== 'observed_for_validation' ||
    ![
      'content_addressed_release',
      'content_addressed_production_release',
    ].includes(evidence.core_binding_kind) ||
    evidence.release_artifact_profile_hash !== release.release_artifact_hash ||
    evidence.release_database_schema_hash !== release.database_schema_hash ||
    evidence.core_build_hash !== release.core_build_hash ||
    evidence.runtime_launcher_observed_hash !== release.runtime_launcher_hash ||
    evidence.managed_distribution_hash !==
      release.managed_node_distribution_hash ||
    evidence.managed_node_version !== 'v26.5.0' ||
    evidence.better_sqlite3_version !== '12.11.1'
  ) {
    throw new Error('G8 release validation identity evidence is incomplete');
  }
  const casesHash = domainSeparatedSha256(
    'icarus:g8-readiness-cases:1\n',
    options.cases as unknown as JsonValue,
  );
  const payload = {
    format: 'icarus.workflow-runtime-g8-readiness-report/1',
    ref: REPORT_REF,
    status: 'pass',
    certification_status: 'not_certified',
    release_manifest_hash: options.releaseManifestHash,
    release_artifact_hash: release.release_artifact_hash,
    core_build_hash: release.core_build_hash,
    database_schema_hash: release.database_schema_hash,
    runtime_launcher_hash: release.runtime_launcher_hash,
    runtime_toolchain_hash: release.runtime_toolchain_hash,
    managed_node_distribution_ref: release.managed_node_distribution_ref,
    managed_node_distribution_hash: release.managed_node_distribution_hash,
    node_runtime_version: '26.5.0',
    node_executable_hash: evidence.managed_node_executable_hash,
    better_sqlite3_version: '12.11.1',
    better_sqlite3_native_module_hash:
      evidence.better_sqlite3_native_module_hash,
    sqlite_version: evidence.sqlite_version,
    sqlite_source_id: evidence.sqlite_source_id,
    sqlite_compile_options_hash: evidence.sqlite_compile_options_hash,
    sqlite_profile_candidate_hash: options.sqliteProfileCandidateHash,
    startup_smoke_harness_ref: startupReport.startup_smoke_harness_ref,
    startup_smoke_harness_hash: startupReport.startup_smoke_harness_hash,
    startup_smoke_report_hash: startupReport.report_hash,
    readiness_harness_ref: artifacts.readinessHarness.ref,
    readiness_harness_hash: artifacts.readinessHarness.hash,
    warmup_iterations: G8_READINESS_WARMUP_ITERATIONS,
    measurement_iterations: G8_READINESS_MEASUREMENT_ITERATIONS,
    cases: options.cases,
    cases_hash: casesHash,
    security_sensitive_validation: 'SECURITY_VALIDATION_NOT_RUN',
    security_validation_basis:
      'static_source_existing_tests_and_invariant_mapping_only',
  } as const;
  return {
    ...payload,
    report_hash: domainSeparatedSha256(
      'icarus:g8-readiness-report:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

function validationSchema(): ReturnType<Ajv2020['compile']> {
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../contracts/certification/g8-validation-reports-schema.json',
      ),
      'utf8',
    ),
  ) as AnySchema;
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

function parseValidatedArtifact(filePath: string): JsonObject {
  const value = strictParseJsonBytes(fs.readFileSync(filePath));
  assertJsonObject(value);
  const validate = validationSchema();
  if (!validate(value)) {
    throw new Error(
      `G8 validation artifact schema failed: ${JSON.stringify(validate.errors)}`,
    );
  }
  return value;
}

export function readG8StartupSmokeReport(
  filePath: string,
): G8StartupSmokeReport {
  const value = parseValidatedArtifact(filePath);
  if (value.format !== 'icarus.startup-smoke-report/1')
    throw new Error('G8 startup-smoke artifact kind drifted');
  const report = value as unknown as G8StartupSmokeReport;
  const { report_hash: reportHash, ...payload } = report;
  if (
    reportHash !==
    domainSeparatedSha256(
      'icarus:startup-smoke-report:1\n',
      payload as unknown as JsonValue,
    )
  ) {
    throw new Error('G8 startup-smoke artifact hash drifted');
  }
  return report;
}

export function checkG8ReadinessOutput(outputRootInput: string): {
  release: RevalidatableCoreReleaseManifest;
  startupReport: JsonObject;
  readinessReport: G8ReadinessReport;
} {
  const outputRoot = fs.realpathSync(outputRootInput);
  const releasePath = path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME);
  const release = parseRevalidatableCoreReleaseManifest(
    strictParseJsonBytes(fs.readFileSync(releasePath)),
  );
  const startupReport = readG8StartupSmokeReport(
    path.join(outputRoot, G8_STARTUP_SMOKE_REPORT_FILENAME),
  );
  const readinessValue = parseValidatedArtifact(
    path.join(outputRoot, G8_READINESS_REPORT_FILENAME),
  );
  if (
    startupReport.format !== 'icarus.startup-smoke-report/1' ||
    readinessValue.format !== 'icarus.workflow-runtime-g8-readiness-report/1'
  ) {
    throw new Error('G8 validation artifact kind drifted');
  }
  const readinessReport = readinessValue as unknown as G8ReadinessReport;
  const { report_hash: readinessHash, ...readinessPayload } = readinessReport;
  const { report_hash: startupHash, ...startupPayload } = startupReport;
  const startupEvidence = startupReport.identity_evidence as JsonObject;
  const artifacts = loadG8FoundationArtifacts();
  if (
    readinessHash !==
      domainSeparatedSha256(
        'icarus:g8-readiness-report:1\n',
        readinessPayload as unknown as JsonValue,
      ) ||
    startupHash !==
      domainSeparatedSha256(
        'icarus:startup-smoke-report:1\n',
        startupPayload as unknown as JsonValue,
      ) ||
    readinessReport.cases_hash !==
      domainSeparatedSha256(
        'icarus:g8-readiness-cases:1\n',
        readinessReport.cases as unknown as JsonValue,
      ) ||
    readinessReport.release_manifest_hash !== rawSha256(releasePath) ||
    readinessReport.release_artifact_hash !== release.release_artifact_hash ||
    readinessReport.core_build_hash !== release.core_build_hash ||
    readinessReport.database_schema_hash !== release.database_schema_hash ||
    readinessReport.runtime_launcher_hash !== release.runtime_launcher_hash ||
    readinessReport.runtime_toolchain_hash !== release.runtime_toolchain_hash ||
    readinessReport.startup_smoke_report_hash !== startupHash ||
    readinessReport.startup_smoke_harness_hash !==
      artifacts.startupSmokeHarness.hash ||
    readinessReport.startup_smoke_harness_hash !==
      startupReport.startup_smoke_harness_hash ||
    JSON.stringify(readinessReport.startup_smoke_harness_ref) !==
      JSON.stringify(artifacts.startupSmokeHarness.ref) ||
    JSON.stringify(readinessReport.startup_smoke_harness_ref) !==
      JSON.stringify(startupReport.startup_smoke_harness_ref) ||
    JSON.stringify(readinessReport.managed_node_distribution_ref) !==
      JSON.stringify(release.managed_node_distribution_ref) ||
    readinessReport.managed_node_distribution_hash !==
      release.managed_node_distribution_hash ||
    readinessReport.readiness_harness_hash !==
      artifacts.readinessHarness.hash ||
    JSON.stringify(readinessReport.readiness_harness_ref) !==
      JSON.stringify(artifacts.readinessHarness.ref) ||
    startupReport.database_schema_hash !== release.database_schema_hash ||
    startupReport.startup_smoke_harness_hash !==
      artifacts.startupSmokeHarness.hash ||
    JSON.stringify(startupReport.startup_smoke_harness_ref) !==
      JSON.stringify(artifacts.startupSmokeHarness.ref) ||
    startupEvidence.release_artifact_profile_hash !==
      release.release_artifact_hash ||
    startupEvidence.release_manifest_hash !==
      readinessReport.release_manifest_hash ||
    startupEvidence.core_build_hash !== release.core_build_hash ||
    startupEvidence.release_database_schema_hash !==
      release.database_schema_hash ||
    startupEvidence.runtime_launcher_observed_hash !==
      release.runtime_launcher_hash ||
    startupEvidence.managed_distribution_hash !==
      release.managed_node_distribution_hash ||
    startupEvidence.managed_node_executable_hash !==
      readinessReport.node_executable_hash ||
    startupEvidence.better_sqlite3_native_module_hash !==
      readinessReport.better_sqlite3_native_module_hash ||
    startupEvidence.sqlite_version !== readinessReport.sqlite_version ||
    startupEvidence.sqlite_source_id !== readinessReport.sqlite_source_id ||
    startupEvidence.sqlite_compile_options_hash !==
      readinessReport.sqlite_compile_options_hash ||
    startupReport.sqlite_profile_candidate_hash !==
      readinessReport.sqlite_profile_candidate_hash
  ) {
    throw new Error('G8 validation artifact identity drifted');
  }
  assertReadinessCases(readinessReport.cases);
  return { release, startupReport, readinessReport };
}

export function readinessMaxima(
  report: G8ReadinessReport,
): Record<G8BenchmarkTransaction, number> {
  return Object.fromEntries(
    (['t3', 't7', 't8'] as const).map((transaction) => [
      transaction,
      report.cases.find(
        (entry) =>
          entry.transaction === transaction &&
          entry.profile === 'supported_limit',
      )!.statistics!.max_ms,
    ]),
  ) as Record<G8BenchmarkTransaction, number>;
}
