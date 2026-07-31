import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { G8BenchmarkCaseObservation } from '../contracts/g8-validation-types.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import { openG5IsolatedBootstrap } from '../runtime/g5-test-bootstrap.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import { runG8BenchmarkCases } from './benchmark-runner.js';
import {
  G8_CORE_RELEASE_MANIFEST_FILENAME,
  G8_READINESS_REPORT_FILENAME,
  G8_STARTUP_SMOKE_REPORT_FILENAME,
  createG8ReadinessReport,
  readG8StartupSmokeReport,
  writeG8JsonAtomic,
} from './g8-readiness-artifacts.js';
import {
  parseRevalidatableCoreReleaseManifest,
  readInstalledRevalidatableCoreReleaseManifest,
} from './release-manifest.js';
import { G9_PRODUCTION_RELEASE_MANIFEST_FILENAME } from '../contracts/g9-production-activation-types.js';

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function assertEmptyDirectory(directory: string, label: string): string {
  const canonical = fs.realpathSync(directory);
  if (
    !fs.statSync(canonical).isDirectory() ||
    fs.readdirSync(canonical).length !== 0
  ) {
    throw new Error(`${label} must be an existing empty directory`);
  }
  return canonical;
}

export interface RunG8ReleaseValidationOptions {
  readonly validationRoot: string;
  readonly outputRoot: string;
  readonly onCaseCompleted?: (observation: G8BenchmarkCaseObservation) => void;
}

export function runG8ReleaseValidation(options: RunG8ReleaseValidationOptions) {
  const validationRoot = assertEmptyDirectory(
    options.validationRoot,
    'G8 validation root',
  );
  const outputRoot = fs.realpathSync(options.outputRoot);
  const releaseRoot = path.resolve(import.meta.dirname, '../../..');
  const productionManifestPath = path.join(
    releaseRoot,
    G9_PRODUCTION_RELEASE_MANIFEST_FILENAME,
  );
  const releaseManifestPath = fs.existsSync(productionManifestPath)
    ? productionManifestPath
    : path.join(releaseRoot, 'core-release-manifest.json');
  const release = parseRevalidatableCoreReleaseManifest(
    JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8')),
  );
  const executablePath = fs.realpathSync(process.execPath);
  const marker = `${path.sep}toolchains${path.sep}node${path.sep}`;
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex <= 0)
    throw new Error('G8 release validation is not using managed Node');
  const runtimeHome = executablePath.slice(0, markerIndex);
  if (
    JSON.stringify(
      readInstalledRevalidatableCoreReleaseManifest(
        runtimeHome,
        release.release_artifact_hash,
      ),
    ) !== JSON.stringify(release)
  ) {
    throw new Error('Active installed Core Release Manifest drifted');
  }

  const identityRoot = path.join(validationRoot, 'identity-observation');
  fs.mkdirSync(identityRoot);
  const identityInstance = openG5IsolatedBootstrap(
    identityRoot,
    'release_validation',
  );
  const evidence = identityInstance.store.identityEvidence;
  const sqliteProfileCandidateHash =
    identityInstance.store.frozenInputs.profileArtifactHash;
  identityInstance.closeStore();

  const harness = loadG8FoundationArtifacts().readinessHarness.payload;
  const startupReport = readG8StartupSmokeReport(
    path.join(outputRoot, G8_STARTUP_SMOKE_REPORT_FILENAME),
  );
  const casesRoot = path.join(validationRoot, 'cases');
  fs.mkdirSync(casesRoot);
  const cases = runG8BenchmarkCases({
    rootDir: casesRoot,
    identityMode: 'release_validation',
    warmupIterations: harness.warmup_iterations,
    measurementIterations: harness.measurement_iterations,
    profiles: harness.profiles,
    transactions: ['t3', 't7', 't8'],
    shapes: harness.representatives,
    onCaseCompleted: options.onCaseCompleted,
  });
  const report = createG8ReadinessReport({
    release,
    releaseManifestHash: rawSha256(releaseManifestPath),
    startupReport,
    evidence,
    sqliteProfileCandidateHash,
    cases,
  });
  writeG8JsonAtomic(
    path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME),
    release as unknown as JsonValue,
  );
  writeG8JsonAtomic(
    path.join(outputRoot, G8_READINESS_REPORT_FILENAME),
    report,
  );
  return { release, report };
}
