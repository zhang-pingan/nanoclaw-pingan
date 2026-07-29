import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { G8BenchmarkCaseObservation } from '../contracts/g8-certification-types.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import { openG5IsolatedBootstrap } from '../runtime/g5-test-bootstrap.js';
import {
  G8_BENCHMARK_OBSERVATION_FILENAME,
  G8_CERTIFIED_SQLITE_PROFILE_FILENAME,
  G8_CORE_RELEASE_MANIFEST_FILENAME,
  createG8BenchmarkObservation,
  createG8CertifiedSQLiteProfile,
  writeG8JsonAtomic,
} from './g8-certification-artifacts.js';
import { runG8BenchmarkCases } from './benchmark-runner.js';
import { observeMinimumMachineClass } from './machine-class.js';
import {
  parseG8CoreReleaseManifest,
  readInstalledG8CoreReleaseManifest,
} from './release-manifest.js';

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function assertEmptyDirectory(directory: string, label: string): string {
  const canonical = fs.realpathSync(directory);
  if (
    !fs.statSync(canonical).isDirectory() ||
    fs.readdirSync(canonical).length !== 0
  )
    throw new Error(`${label} must be an existing empty directory`);
  return canonical;
}

export interface RunG8ReleaseBenchmarkOptions {
  readonly benchmarkRoot: string;
  readonly outputRoot: string;
  readonly confirmNoConcurrentInterference: boolean;
  readonly onCaseCompleted?: (observation: G8BenchmarkCaseObservation) => void;
}

export function runG8ReleaseBenchmark(options: RunG8ReleaseBenchmarkOptions) {
  if (!options.confirmNoConcurrentInterference)
    throw new Error(
      'G8 release benchmark requires no-interference confirmation',
    );
  const benchmarkRoot = assertEmptyDirectory(
    options.benchmarkRoot,
    'G8 benchmark root',
  );
  const outputRoot = fs.realpathSync(options.outputRoot);
  if (!fs.statSync(outputRoot).isDirectory())
    throw new Error('G8 certification output root is not a directory');

  const releaseRoot = path.resolve(import.meta.dirname, '../../..');
  const releaseManifestPath = path.join(
    releaseRoot,
    'core-release-manifest.json',
  );
  const release = parseG8CoreReleaseManifest(
    JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8')),
  );
  const executablePath = fs.realpathSync(process.execPath);
  const runtimeMarker = `${path.sep}toolchains${path.sep}node${path.sep}`;
  const markerIndex = executablePath.indexOf(runtimeMarker);
  if (markerIndex <= 0)
    throw new Error('G8 release benchmark is not using managed Node');
  const runtimeHome = executablePath.slice(0, markerIndex);
  const installed = readInstalledG8CoreReleaseManifest(
    runtimeHome,
    release.release_artifact_hash,
  );
  if (JSON.stringify(installed) !== JSON.stringify(release))
    throw new Error('Active installed Core Release Manifest drifted');

  const identityRoot = path.join(benchmarkRoot, 'identity-observation');
  fs.mkdirSync(identityRoot);
  const identityInstance = openG5IsolatedBootstrap(
    identityRoot,
    'certification_observation',
  );
  const evidence = identityInstance.store.identityEvidence;
  identityInstance.closeStore();
  const profile = createG8CertifiedSQLiteProfile(evidence, release);
  const machineObservation = observeMinimumMachineClass({
    targetPath: benchmarkRoot,
    purpose: 'certification_reference',
    confirmNoConcurrentBenchmarkInterference: true,
  });

  const casesRoot = path.join(benchmarkRoot, 'cases');
  fs.mkdirSync(casesRoot);
  const cases = runG8BenchmarkCases({
    rootDir: casesRoot,
    identityMode: 'certification_observation',
    warmupIterations: 10,
    measurementIterations: 100,
    onCaseCompleted: options.onCaseCompleted,
  });
  const observation = createG8BenchmarkObservation({
    profile,
    release,
    releaseManifestHash: rawSha256(releaseManifestPath),
    machineObservation,
    cases,
  });

  writeG8JsonAtomic(
    path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME),
    release as unknown as JsonValue,
  );
  writeG8JsonAtomic(
    path.join(outputRoot, G8_CERTIFIED_SQLITE_PROFILE_FILENAME),
    profile,
  );
  writeG8JsonAtomic(
    path.join(outputRoot, G8_BENCHMARK_OBSERVATION_FILENAME),
    observation,
  );
  return { release, profile, observation };
}
