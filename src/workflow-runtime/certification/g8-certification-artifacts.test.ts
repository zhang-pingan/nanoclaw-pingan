import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from '../contracts/hash.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  G8_BENCHMARK_OBSERVATION_FILENAME,
  G8_CERTIFICATION_PACK_FILENAME,
  G8_CERTIFIED_SQLITE_PROFILE_FILENAME,
  G8_CORE_RELEASE_MANIFEST_FILENAME,
  G8_RUNTIME_SUPPORTED_LIMITS_FILENAME,
  G8_STARTUP_SMOKE_REPORT_FILENAME,
  assembleG8Certification,
  checkG8CertificationOutput,
  createG8BenchmarkObservation,
  createG8CertificationPack,
  createG8CertifiedSQLiteProfile,
  createG8RuntimeSupportedLimits,
  writeG8JsonAtomic,
} from './g8-certification-artifacts.js';
import {
  createG8BenchmarkCasesFixture,
  createG8IdentityEvidenceFixture,
  createG8MachineObservationFixture,
  createG8ReleaseManifestFixture,
  createG8StartupSmokeReportFixture,
  g8FixtureHash,
} from './g8-certification-fixtures.js';

const temporaryRoots: string[] = [];
const certifiedAtMs = 1785326400000;

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-g8-certification-'),
  );
  temporaryRoots.push(root);
  return root;
}

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function fixtureGraph(
  releaseManifestHash = g8FixtureHash('release-manifest-raw'),
) {
  const release = createG8ReleaseManifestFixture();
  const evidence = createG8IdentityEvidenceFixture(
    release,
    releaseManifestHash,
  );
  const profile = createG8CertifiedSQLiteProfile(evidence, release);
  const observation = createG8BenchmarkObservation({
    profile,
    release,
    releaseManifestHash,
    machineObservation: createG8MachineObservationFixture(),
    cases: createG8BenchmarkCasesFixture(),
  });
  const limits = createG8RuntimeSupportedLimits({
    profile,
    release,
    observation,
    certifiedAtMs,
  });
  const smoke = createG8StartupSmokeReportFixture(release, evidence);
  const pack = createG8CertificationPack({
    profile,
    release,
    releaseManifestHash,
    observation,
    limits,
    startupSmokeReport: smoke,
  });
  return { release, evidence, profile, observation, limits, smoke, pack };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G8 certification artifacts', () => {
  it('derives the certified SQLite Profile only from exact release observation evidence', () => {
    const first = fixtureGraph().profile;
    const second = fixtureGraph().profile;
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      release_artifact_hash:
        createG8ReleaseManifestFixture().release_artifact_hash,
      node_runtime_version: '26.5.0',
      better_sqlite3_version: '12.11.1',
    });
    expect(first.profile_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('requires every shape/profile with exact 10+100 counts and complete floor observations', () => {
    const observation = fixtureGraph().observation;
    expect(observation.cases).toHaveLength(90);
    expect(
      observation.cases.every(
        (entry) =>
          entry.warmup_iterations === 10 &&
          entry.measurement_iterations === 100,
      ),
    ).toBe(true);
    expect(
      observation.cases.filter((entry) => entry.profile === 'supported_limit'),
    ).toHaveLength(15);
    expect(
      observation.cases.filter((entry) => entry.profile === 'beyond_limit'),
    ).toHaveLength(15);
  });

  it('publishes the exact flat RuntimeSupportedLimits interface with measured maxima', () => {
    const limits = fixtureGraph().limits;
    expect(limits.max_scopes_total).toBe(128);
    expect(limits.max_nodes_total).toBe(1024);
    expect(limits.max_required_child_creations_per_t8).toBe(8);
    expect(limits.certification).toMatchObject({
      status: 'certified',
      t3_max_transaction_duration_ms: 4,
      t7_max_transaction_duration_ms: 4,
      t8_max_transaction_duration_ms: 4,
      certified_at_ms: certifiedAtMs,
    });
    expect('limits' in limits).toBe(false);
  });

  it('cross-binds the full release/native/Launcher/Core/SQLite certification key', () => {
    const { pack, profile, observation, limits } = fixtureGraph();
    expect(pack.security_sensitive_validation).toBe(
      'SECURITY_VALIDATION_NOT_RUN',
    );
    expect(pack.certification_key).toMatchObject({
      release_artifact_hash: profile.release_artifact_hash,
      node_executable_hash: profile.node_executable_hash,
      better_sqlite3_native_module_hash:
        profile.better_sqlite3_native_module_hash,
      sqlite_execution_profile_hash: profile.profile_hash,
      benchmark_observation_hash: observation.observation_hash,
      runtime_supported_limits_hash: limits.profile_hash,
    });
  });

  it('validates every published object against the closed G8 artifact schema', () => {
    const fixture = fixtureGraph();
    const schema = JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          '../contracts/certification/g8-certification-artifacts-schema.json',
        ),
        'utf8',
      ),
    ) as AnySchema;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      schema,
    );
    for (const artifact of [
      fixture.profile,
      fixture.observation,
      fixture.limits,
      fixture.pack,
    ])
      expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
  });

  it('assembles deterministic bytes and passes the read-only output checker', () => {
    const outputRoot = temporaryRoot();
    const initial = fixtureGraph();
    writeG8JsonAtomic(
      path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME),
      initial.release as unknown as JsonValue,
    );
    const releaseManifestHash = rawSha256(
      path.join(outputRoot, G8_CORE_RELEASE_MANIFEST_FILENAME),
    );
    const fixture = fixtureGraph(releaseManifestHash);
    writeG8JsonAtomic(
      path.join(outputRoot, G8_CERTIFIED_SQLITE_PROFILE_FILENAME),
      fixture.profile,
    );
    writeG8JsonAtomic(
      path.join(outputRoot, G8_BENCHMARK_OBSERVATION_FILENAME),
      fixture.observation,
    );
    writeG8JsonAtomic(
      path.join(outputRoot, G8_STARTUP_SMOKE_REPORT_FILENAME),
      fixture.smoke,
    );
    const first = assembleG8Certification({ outputRoot, certifiedAtMs });
    const firstLimits = fs.readFileSync(
      path.join(outputRoot, G8_RUNTIME_SUPPORTED_LIMITS_FILENAME),
    );
    const firstPack = fs.readFileSync(
      path.join(outputRoot, G8_CERTIFICATION_PACK_FILENAME),
    );
    const second = assembleG8Certification({ outputRoot, certifiedAtMs });
    expect(second).toEqual(first);
    expect(
      fs.readFileSync(
        path.join(outputRoot, G8_RUNTIME_SUPPORTED_LIMITS_FILENAME),
      ),
    ).toEqual(firstLimits);
    expect(
      fs.readFileSync(path.join(outputRoot, G8_CERTIFICATION_PACK_FILENAME)),
    ).toEqual(firstPack);
    expect(checkG8CertificationOutput(outputRoot).pack).toEqual(first.pack);
    expect(canonicalJson(first.pack as unknown as JsonValue)).toBe(
      canonicalJson(second.pack as unknown as JsonValue),
    );
  });
});
