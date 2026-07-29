import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkInstalledG8CoreRelease,
  installG8CoreRelease,
  readInstalledG8CoreReleaseManifest,
} from './release-manifest.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function releaseProjectFixture(): string {
  const root = temporaryRoot('icarus-g8-release-project-');
  const certificationEntry = path.join(
    root,
    'dist/workflow-runtime/certification/release-entry.js',
  );
  fs.mkdirSync(path.dirname(certificationEntry), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/index.js'), 'export {};\n');
  fs.writeFileSync(certificationEntry, 'console.log("certification");\n');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts/runtime-launcher.sh'),
    path.join(root, 'scripts/runtime-launcher.sh'),
  );
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts/runtime-toolchain.sh'),
    path.join(root, 'scripts/runtime-toolchain.sh'),
  );
  const contractRoot = path.join(root, 'src/workflow-runtime/contracts');
  fs.mkdirSync(path.join(contractRoot, 'toolchain'), { recursive: true });
  fs.copyFileSync(
    path.join(
      repositoryRoot,
      'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
    ),
    path.join(contractRoot, 'toolchain/node-v26.5.0-darwin-arm64.json'),
  );
  fs.mkdirSync(path.join(contractRoot, 'sqlite'), { recursive: true });
  fs.writeFileSync(
    path.join(contractRoot, 'sqlite/local_single_user_sqlite@1.json'),
    '{"excluded":"certification output"}\n',
  );
  fs.mkdirSync(path.join(contractRoot, 'certification'), { recursive: true });
  fs.writeFileSync(
    path.join(contractRoot, 'certification/generated.json'),
    '{"excluded":"certification output"}\n',
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"g8-release-fixture","dependencies":{}}\n',
  );
  return root;
}

function runtimeHomeFixture(): string {
  const runtimeHome = temporaryRoot('icarus-g8-release-home-');
  const nodeRoot = path.join(runtimeHome, 'toolchains/node');
  fs.mkdirSync(nodeRoot, { recursive: true });
  fs.symlinkSync(
    path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    path.join(nodeRoot, 'active-node'),
  );
  return runtimeHome;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G8 Core Release manifest', () => {
  it('installs a deterministic release without certification self-reference', () => {
    const projectRoot = releaseProjectFixture();
    const runtimeHome = runtimeHomeFixture();
    const firstOutput = path.join(
      temporaryRoot('icarus-g8-output-'),
      'first.json',
    );
    const secondOutput = path.join(
      temporaryRoot('icarus-g8-output-'),
      'second.json',
    );
    const first = installG8CoreRelease({
      projectRoot,
      runtimeHome,
      manifestOutput: firstOutput,
    });
    const second = installG8CoreRelease({
      projectRoot,
      runtimeHome,
      manifestOutput: secondOutput,
    });

    expect(second).toEqual(first);
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(
          repositoryRoot,
          'src/workflow-runtime/contracts/certification/core-release-manifest-schema.json',
        ),
        'utf8',
      ),
    ) as AnySchema;
    expect(
      new Ajv2020({ strict: true, allErrors: true }).compile(schema)(first),
    ).toBe(true);
    expect(fs.readFileSync(secondOutput)).toEqual(fs.readFileSync(firstOutput));
    expect(first.inventory.map((entry) => entry.path)).not.toContain(
      'dist/workflow-runtime/contracts/sqlite/local_single_user_sqlite@1.json',
    );
    expect(
      first.inventory.some((entry) =>
        entry.path.startsWith(
          'dist/workflow-runtime/contracts/certification/generated/',
        ),
      ),
    ).toBe(false);
    expect(first.inventory.map((entry) => entry.path)).toContain(
      'certification-inputs/sqlite/local_single_user_sqlite-candidate@1.json',
    );
    checkInstalledG8CoreRelease(runtimeHome, first);
    expect(
      readInstalledG8CoreReleaseManifest(
        runtimeHome,
        first.release_artifact_hash,
      ),
    ).toEqual(first);
  });
});
