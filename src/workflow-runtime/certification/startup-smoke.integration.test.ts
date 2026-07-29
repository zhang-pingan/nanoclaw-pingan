import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const toolchain = path.join(projectRoot, 'scripts/runtime-toolchain.sh');
const distributionManifestPath = path.join(
  projectRoot,
  'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
);
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function run(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(executable, [...args], {
    cwd: options.cwd ?? projectRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });
}

function prepareRuntimeHome(): { runtimeHome: string; managedNode: string } {
  const runtimeHome = temporaryRoot('icarus-g8-runtime-home-');
  const distribution = JSON.parse(
    fs.readFileSync(distributionManifestPath, 'utf8'),
  ) as {
    node_runtime_version: string;
    platform: string;
    arch: string;
    archive_sha256: string;
  };
  const activeInstallation = path.dirname(
    path.dirname(fs.realpathSync(process.execPath)),
  );
  const installationRelative = path.join(
    distribution.node_runtime_version,
    `${distribution.platform}-${distribution.arch}`,
    distribution.archive_sha256.slice('sha256:'.length),
  );
  const nodeRoot = path.join(runtimeHome, 'toolchains/node');
  const installation = path.join(nodeRoot, installationRelative);
  fs.mkdirSync(path.dirname(installation), { recursive: true });
  fs.cpSync(activeInstallation, installation, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  fs.symlinkSync(installationRelative, path.join(nodeRoot, 'active-node'));
  fs.mkdirSync(path.join(runtimeHome, 'contracts'), { recursive: true });
  fs.copyFileSync(
    distributionManifestPath,
    path.join(runtimeHome, 'contracts/managed-node-runtime-distribution.json'),
  );
  return {
    runtimeHome,
    managedNode: path.join(installation, 'bin/node'),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G8 release startup smoke', () => {
  it('observes the complete release identity through the stable Launcher and cleans its isolated Store', () => {
    expect(
      fs.existsSync(
        path.join(
          projectRoot,
          'dist/workflow-runtime/certification/release-entry.js',
        ),
      ),
      'run the managed release build before this integration test',
    ).toBe(true);
    const { runtimeHome, managedNode } = prepareRuntimeHome();
    const outputRoot = temporaryRoot('icarus-g8-release-output-');
    const releaseManifestOutput = path.join(
      outputRoot,
      'core-release-manifest.json',
    );
    const installRelease = run(managedNode, [
      '--import',
      'tsx',
      'src/workflow-runtime/certification/release-cli.ts',
      'install',
      '--project-root',
      projectRoot,
      '--runtime-home',
      runtimeHome,
      '--manifest-output',
      releaseManifestOutput,
    ]);
    expect(installRelease.status, installRelease.stderr).toBe(0);
    const releaseManifest = JSON.parse(
      fs.readFileSync(releaseManifestOutput, 'utf8'),
    ) as {
      release_artifact_hash: string;
      core_build_hash: string;
      database_schema_hash: string;
    };
    const releaseRelative = `core-releases/${releaseManifest.release_artifact_hash.slice('sha256:'.length)}`;
    const bind = run(toolchain, [
      '--runtime-home',
      runtimeHome,
      'bind-release',
      '--release-relative',
      releaseRelative,
      '--release-artifact-hash',
      releaseManifest.release_artifact_hash,
      '--core-build-hash',
      releaseManifest.core_build_hash,
    ]);
    expect(bind.status, bind.stderr).toBe(0);

    const storeDir = temporaryRoot('icarus-g8-startup-store-');
    const reportOutput = path.join(outputRoot, 'startup-smoke-report.json');
    const smoke = run(
      path.join(runtimeHome, 'bin/icarus-runtime'),
      [
        'startup-smoke',
        '--store-dir',
        storeDir,
        '--report-output',
        reportOutput,
      ],
      { env: { NODE_OPTIONS: '--require /not/present' } },
    );
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(smoke.stdout).toContain('startup_smoke_status=pass');
    const report = JSON.parse(fs.readFileSync(reportOutput, 'utf8')) as {
      status: string;
      duration_ms: number;
      startup_smoke_max_duration_ms: number;
      database_schema_hash: string;
      production_pragmas_verified: boolean;
      integrity_check_verified: boolean;
      reopen_verified: boolean;
      identity_evidence: {
        certification_status: string;
        release_identity_status: string;
        release_artifact_profile_hash: string;
        release_database_schema_hash: string;
        better_sqlite3_version: string;
        managed_node_exec_path: string;
      };
    };
    expect(report.status).toBe('pass');
    expect(report.duration_ms).toBeLessThanOrEqual(
      report.startup_smoke_max_duration_ms,
    );
    expect(report.database_schema_hash).toBe(
      releaseManifest.database_schema_hash,
    );
    expect(report.production_pragmas_verified).toBe(true);
    expect(report.integrity_check_verified).toBe(true);
    expect(report.reopen_verified).toBe(true);
    expect(report.identity_evidence).toMatchObject({
      certification_status: 'certification_observation',
      release_identity_status: 'observed_for_certification',
      release_artifact_profile_hash: releaseManifest.release_artifact_hash,
      release_database_schema_hash: releaseManifest.database_schema_hash,
      better_sqlite3_version: '12.11.1',
    });
    expect(report.identity_evidence.managed_node_exec_path).toContain(
      fs.realpathSync(runtimeHome),
    );
    expect(fs.readdirSync(storeDir)).toEqual([]);
  }, 120_000);
});
