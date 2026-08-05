import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { canonicalize } from 'json-canonicalize';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const toolchain = path.join(projectRoot, 'scripts', 'runtime-toolchain.sh');
const launcherSource = path.join(projectRoot, 'scripts', 'runtime-launcher.sh');
const temporaryRoots: string[] = [];

interface FixtureOptions {
  npmVersion?: string;
  nodeHash?: string;
  unsafeSymlink?: boolean;
  unsafeTraversal?: boolean;
}

interface ToolchainFixture {
  root: string;
  archive: string;
  manifest: string;
  archiveHash: string;
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function hashBytes(bytes: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function createFixture(options: FixtureOptions = {}): ToolchainFixture {
  const root = temporaryRoot('icarus-toolchain-fixture-');
  const source = path.join(root, 'source');
  const distributionName = 'node-v26.5.0-darwin-arm64';
  const distribution = path.join(source, distributionName);
  const bin = path.join(distribution, 'bin');
  fs.mkdirSync(bin, { recursive: true });

  const nodePath = path.join(bin, 'node');
  writeExecutable(
    nodePath,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "v26.5.0"
  exit 0
fi
printf 'managed-node=%s\\n' "$0"
printf 'core-entry=%s\\n' "\${1:-}"
shift || true
for argument in "$@"; do
  printf 'core-argument=%s\\n' "$argument"
done
`,
  );
  writeExecutable(
    path.join(bin, 'npm'),
    `#!/bin/sh
echo "${options.npmVersion ?? '11.17.0'}"
`,
  );

  if (options.unsafeSymlink) {
    fs.symlinkSync('../../../../tmp', path.join(distribution, 'escape'));
  }

  const archive = path.join(root, `${distributionName}.tar.gz`);
  if (options.unsafeTraversal) {
    const sibling = path.join(source, 'outside');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'entry'), 'unsafe\n');
  }
  const archiveEntry = options.unsafeTraversal
    ? `${distributionName}/../outside`
    : distributionName;
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, archiveEntry], {
    encoding: 'utf8',
  });
  expect(tar.status, tar.stderr).toBe(0);

  const archiveHash = hashBytes(fs.readFileSync(archive));
  const payload = {
    format: 'icarus.managed-node-runtime-distribution/1',
    ref: {
      id: 'nodejs.node-v26.5.0-darwin-arm64',
      version: '1.0.0',
    },
    node_runtime_version: '26.5.0',
    npm_version: '11.17.0',
    platform: 'darwin',
    arch: 'arm64',
    distribution_origin: 'nodejs_official',
    archive_filename: `${distributionName}.tar.gz`,
    archive_url: `https://nodejs.org/dist/v26.5.0/${distributionName}.tar.gz`,
    archive_sha256: `sha256:${archiveHash}`,
    node_executable_relative_path: 'bin/node',
    node_executable_sha256: `sha256:${options.nodeHash ?? hashBytes(fs.readFileSync(nodePath))}`,
  };
  const manifest = path.join(root, 'manifest.json');
  const manifestValue = {
    ...payload,
    manifest_hash: `sha256:${hashBytes(
      `icarus:managed-node-runtime-distribution:1\n${canonicalize(payload)}`,
    )}`,
  };
  fs.writeFileSync(manifest, `${JSON.stringify(manifestValue, null, 2)}\n`);
  return { root, archive, manifest, archiveHash };
}

function runToolchain(
  fixture: ToolchainFixture,
  runtimeHome: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    toolchain,
    ['--runtime-home', runtimeHome, '--manifest', fixture.manifest, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

function expectFailure(result: ReturnType<typeof runToolchain>, code: string) {
  expect(result.status).toBe(78);
  expect(result.stderr).toContain(`icarus-toolchain:${code}`);
}

function domainHash(domain: string, value: unknown): string {
  return `sha256:${hashBytes(`${domain}${canonicalize(value)}`)}`;
}

function createContentAddressedReleaseFixture(
  fixture: ToolchainFixture,
  runtimeHome: string,
): { releaseArtifactHash: string; validationEntry: string } {
  const validationEntry =
    'dist/workflow-runtime/certification/release-entry.js';
  const coreEntry = 'dist/index.js';
  const stage = temporaryRoot('icarus-core-release-stage-');
  fs.mkdirSync(path.join(stage, path.dirname(validationEntry)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(stage, coreEntry), 'console.log("core");\n');
  fs.writeFileSync(
    path.join(stage, validationEntry),
    'console.log("validation");\n',
  );
  const inventory = [coreEntry, validationEntry].sort().map((entry) => {
    const bytes = fs.readFileSync(path.join(stage, entry));
    return {
      path: entry,
      byte_length: bytes.byteLength,
      executable: false,
      raw_sha256: `sha256:${hashBytes(bytes)}`,
    };
  });
  const distribution = JSON.parse(
    fs.readFileSync(fixture.manifest, 'utf8'),
  ) as {
    ref: { id: string; version: string };
    manifest_hash: string;
  };
  const coreInventory = inventory.filter((entry) =>
    entry.path.startsWith('dist/'),
  );
  const payload = {
    format: 'icarus.core-release-manifest/1',
    ref: { id: 'icarus.core', version: '1.2.14' },
    release_scope: 'workflow_runtime_g8_validation',
    build_kind: 'release',
    platform: 'darwin',
    arch: 'arm64',
    run_protocol_majors: [1],
    executor_abi_majors: [1],
    database_schema_version: 11,
    database_schema_hash: `sha256:${'1'.repeat(64)}`,
    managed_node_distribution_ref: distribution.ref,
    managed_node_distribution_hash: distribution.manifest_hash,
    runtime_launcher_hash: `sha256:${hashBytes(fs.readFileSync(launcherSource))}`,
    runtime_toolchain_hash: `sha256:${hashBytes(fs.readFileSync(toolchain))}`,
    core_entry_relative_path: coreEntry,
    core_entry_sha256: inventory.find((entry) => entry.path === coreEntry)!
      .raw_sha256,
    validation_entry_relative_path: validationEntry,
    validation_entry_sha256: inventory.find(
      (entry) => entry.path === validationEntry,
    )!.raw_sha256,
    core_build_hash: domainHash('icarus:core-release-build:1\n', coreInventory),
    inventory,
    inventory_hash: domainHash('icarus:core-release-inventory:1\n', inventory),
  };
  const releaseArtifactHash = domainHash(
    'icarus:core-release-manifest:1\n',
    payload,
  );
  const releaseRoot = path.join(
    runtimeHome,
    'core-releases',
    releaseArtifactHash.slice('sha256:'.length),
  );
  fs.mkdirSync(path.dirname(releaseRoot), { recursive: true });
  fs.renameSync(stage, releaseRoot);
  fs.writeFileSync(
    path.join(releaseRoot, 'core-release-manifest.json'),
    `${JSON.stringify({ ...payload, release_artifact_hash: releaseArtifactHash }, null, 2)}\n`,
  );
  return { releaseArtifactHash, validationEntry };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('managed runtime bootstrap', () => {
  it('installs side-by-side idempotently without changing system identity', () => {
    const fixture = createFixture();
    const runtimeHome = temporaryRoot('icarus-runtime-home-');
    const nodeBefore = spawnSync(
      'sh',
      ['-c', 'command -v node; node --version'],
      {
        encoding: 'utf8',
      },
    ).stdout;
    const npmBefore = spawnSync('sh', ['-c', 'command -v npm; npm --version'], {
      encoding: 'utf8',
    }).stdout;

    const first = runToolchain(fixture, runtimeHome, [
      'install',
      '--archive',
      fixture.archive,
    ]);
    expect(first.status, first.stderr).toBe(0);
    const second = runToolchain(fixture, runtimeHome, [
      'install',
      '--archive',
      fixture.archive,
    ]);
    expect(second.status, second.stderr).toBe(0);
    const verify = runToolchain(fixture, runtimeHome, ['verify']);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('managed_node_version=v26.5.0');
    expect(
      spawnSync('sh', ['-c', 'command -v node; node --version'], {
        encoding: 'utf8',
      }).stdout,
    ).toBe(nodeBefore);
    expect(
      spawnSync('sh', ['-c', 'command -v npm; npm --version'], {
        encoding: 'utf8',
      }).stdout,
    ).toBe(npmBefore);
  });

  it('rejects archive, executable, npm, traversal, and unsafe-link mismatches', () => {
    const archiveFixture = createFixture();
    const corruptArchive = path.join(archiveFixture.root, 'corrupt.tar.gz');
    fs.copyFileSync(archiveFixture.archive, corruptArchive);
    fs.appendFileSync(corruptArchive, 'corrupt');
    expectFailure(
      runToolchain(archiveFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        corruptArchive,
      ]),
      'archive_hash_mismatch',
    );

    const executableFixture = createFixture({ nodeHash: '0'.repeat(64) });
    expectFailure(
      runToolchain(executableFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        executableFixture.archive,
      ]),
      'node_executable_hash_mismatch',
    );

    const npmFixture = createFixture({ npmVersion: '0.0.0' });
    expectFailure(
      runToolchain(npmFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        npmFixture.archive,
      ]),
      'npm_version_mismatch',
    );

    const unsafeFixture = createFixture({ unsafeSymlink: true });
    expectFailure(
      runToolchain(unsafeFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        unsafeFixture.archive,
      ]),
      'archive_unsafe_link',
    );

    const traversalFixture = createFixture({ unsafeTraversal: true });
    expectFailure(
      runToolchain(traversalFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        traversalFixture.archive,
      ]),
      'archive_unsafe_entry',
    );
  });

  it('rejects malformed manifest bytes and an install path redirected outside its root', () => {
    const malformedFixture = createFixture();
    fs.appendFileSync(malformedFixture.manifest, 'trailing-garbage\n');
    expectFailure(
      runToolchain(malformedFixture, temporaryRoot('icarus-runtime-home-'), [
        'install',
        '--archive',
        malformedFixture.archive,
      ]),
      'manifest_invalid',
    );

    const redirectedFixture = createFixture();
    const runtimeHome = temporaryRoot('icarus-runtime-home-');
    const install = runToolchain(redirectedFixture, runtimeHome, [
      'install',
      '--archive',
      redirectedFixture.archive,
    ]);
    expect(install.status, install.stderr).toBe(0);
    const installPath = path.join(
      runtimeHome,
      'toolchains',
      'node',
      '26.5.0',
      'darwin-arm64',
      redirectedFixture.archiveHash,
    );
    const redirectedPath = path.join(
      temporaryRoot('icarus-outside-install-'),
      'distribution',
    );
    fs.cpSync(installPath, redirectedPath, { recursive: true });
    fs.rmSync(installPath, { recursive: true });
    fs.symlinkSync(redirectedPath, installPath);
    expectFailure(
      runToolchain(redirectedFixture, runtimeHome, [
        'install',
        '--archive',
        redirectedFixture.archive,
      ]),
      'installation_outside_root',
    );
  });

  it('fails closed for a partial install and an invalid active pointer', () => {
    const fixture = createFixture();
    const partialHome = temporaryRoot('icarus-runtime-home-');
    const partialPath = path.join(
      partialHome,
      'toolchains',
      'node',
      '26.5.0',
      'darwin-arm64',
      fixture.archiveHash,
    );
    fs.mkdirSync(partialPath, { recursive: true });
    expectFailure(
      runToolchain(fixture, partialHome, [
        'install',
        '--archive',
        fixture.archive,
      ]),
      'installation_incomplete',
    );

    const pointerHome = temporaryRoot('icarus-runtime-home-');
    const install = runToolchain(fixture, pointerHome, [
      'install',
      '--archive',
      fixture.archive,
    ]);
    expect(install.status, install.stderr).toBe(0);
    const pointer = path.join(pointerHome, 'toolchains', 'node', 'active-node');
    fs.unlinkSync(pointer);
    fs.symlinkSync('../../outside', pointer);
    expectFailure(
      runToolchain(fixture, pointerHome, ['verify']),
      'active_pointer_outside_root',
    );
  });
});

describe('stable runtime launcher', () => {
  it('binds a content-addressed Core Release and forwards validation arguments', () => {
    const fixture = createFixture();
    const runtimeHome = temporaryRoot('icarus-runtime-home-');
    const install = runToolchain(fixture, runtimeHome, [
      'install',
      '--archive',
      fixture.archive,
    ]);
    expect(install.status, install.stderr).toBe(0);
    const release = createContentAddressedReleaseFixture(fixture, runtimeHome);
    const relative = `core-releases/${release.releaseArtifactHash.slice('sha256:'.length)}`;
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(runtimeHome, relative, 'core-release-manifest.json'),
        'utf8',
      ),
    ) as { core_build_hash: string };
    const bind = runToolchain(fixture, runtimeHome, [
      'bind-release',
      '--release-relative',
      relative,
      '--release-artifact-hash',
      release.releaseArtifactHash,
      '--core-build-hash',
      manifest.core_build_hash,
    ]);
    expect(bind.status, bind.stderr).toBe(0);
    expect(bind.stdout).toContain(
      'core_binding_kind=content_addressed_release',
    );
    const binding = JSON.parse(
      fs.readFileSync(
        path.join(
          fs.realpathSync(path.join(runtimeHome, 'active-core')),
          'binding.json',
        ),
        'utf8',
      ),
    );
    const bindingSchema = JSON.parse(
      fs.readFileSync(
        path.join(
          projectRoot,
          'src/workflow-runtime/contracts/certification/core-runtime-launch-binding-v2-schema.json',
        ),
        'utf8',
      ),
    ) as AnySchema;
    expect(
      new Ajv2020({ strict: true, allErrors: true }).compile(bindingSchema)(
        binding,
      ),
    ).toBe(true);

    const launcher = path.join(runtimeHome, 'bin', 'icarus-runtime');
    const launched = spawnSync(launcher, ['identity', '--sample'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--require /not/present' },
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain(
      `core-entry=${path.join(fs.realpathSync(runtimeHome), relative, release.validationEntry)}`,
    );
    expect(launched.stdout).toContain('core-argument=identity');
    expect(launched.stdout).toContain('core-argument=--sample');
  });

  it('derives its root from realpath and never falls back to inherited PATH', () => {
    const fixture = createFixture();
    const runtimeHome = temporaryRoot('icarus-runtime-home-');
    const install = runToolchain(fixture, runtimeHome, [
      'install',
      '--archive',
      fixture.archive,
    ]);
    expect(install.status, install.stderr).toBe(0);

    const coreProject = temporaryRoot('icarus-core-project-');
    fs.mkdirSync(path.join(coreProject, 'dist'), { recursive: true });
    const coreEntry = path.join(coreProject, 'dist', 'index.js');
    fs.writeFileSync(coreEntry, 'console.log("core fixture");\n');
    const bind = runToolchain(fixture, runtimeHome, [
      'bind-core',
      '--project-root',
      coreProject,
      '--entry',
      'dist/index.js',
    ]);
    expect(bind.status, bind.stderr).toBe(0);

    const activeCore = path.join(runtimeHome, 'active-core');
    const firstBindingDirectory = fs.realpathSync(activeCore);
    const firstBindingFile = path.join(firstBindingDirectory, 'binding.json');
    const firstBindingBytes = fs.readFileSync(firstBindingFile);
    fs.writeFileSync(coreEntry, 'console.log("core fixture v2");\n');
    const rebind = runToolchain(fixture, runtimeHome, [
      'bind-core',
      '--project-root',
      coreProject,
      '--entry',
      'dist/index.js',
    ]);
    expect(rebind.status, rebind.stderr).toBe(0);
    const secondBindingDirectory = fs.realpathSync(activeCore);
    expect(secondBindingDirectory).not.toBe(firstBindingDirectory);
    expect(fs.readFileSync(firstBindingFile)).toEqual(firstBindingBytes);
    expect(fs.readdirSync(firstBindingDirectory)).toEqual(['binding.json']);
    const secondBinding = JSON.parse(
      fs.readFileSync(
        path.join(secondBindingDirectory, 'binding.json'),
        'utf8',
      ),
    ) as { core_entry_sha256: string };
    expect(secondBinding.core_entry_sha256).toBe(
      `sha256:${hashBytes(fs.readFileSync(coreEntry))}`,
    );

    const launcher = path.join(runtimeHome, 'bin', 'icarus-runtime');
    expect(fs.readFileSync(launcher)).toEqual(fs.readFileSync(launcherSource));
    const launcherLink = path.join(
      temporaryRoot('icarus-launcher-link-'),
      'run',
    );
    fs.symlinkSync(launcher, launcherLink);
    const maliciousBin = temporaryRoot('icarus-malicious-path-');
    const marker = path.join(maliciousBin, 'fallback-used');
    writeExecutable(
      path.join(maliciousBin, 'node'),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
    );

    const launched = spawnSync(launcherLink, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${maliciousBin}:/usr/bin:/bin`,
        ICARUS_RUNTIME_HOME: temporaryRoot('icarus-evil-runtime-'),
        NODE_OPTIONS: '--require /definitely/not/present',
      },
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain(
      path.join(fs.realpathSync(runtimeHome), 'toolchains', 'node', '26.5.0'),
    );
    expect(launched.stdout).toContain(
      `core-entry=${fs.realpathSync(coreEntry)}`,
    );
    expect(fs.existsSync(marker)).toBe(false);

    const bindingFile = path.join(
      fs.realpathSync(path.join(runtimeHome, 'active-core')),
      'binding.json',
    );
    const bindingBytes = fs.readFileSync(bindingFile);
    fs.appendFileSync(bindingFile, 'trailing-garbage\n');
    const malformedBinding = spawnSync(launcher, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${maliciousBin}:/usr/bin:/bin` },
    });
    expect(malformedBinding.status).toBe(78);
    expect(malformedBinding.stderr).toContain('core_binding_invalid');
    fs.writeFileSync(bindingFile, bindingBytes);

    fs.appendFileSync(coreEntry, '// changed\n');
    const tampered = spawnSync(launcher, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${maliciousBin}:/usr/bin:/bin` },
    });
    expect(tampered.status).toBe(78);
    expect(tampered.stderr).toContain('core_entry_hash_mismatch');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
