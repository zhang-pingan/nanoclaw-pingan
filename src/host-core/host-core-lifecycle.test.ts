import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { domainSeparatedSha256 } from '../workflow-runtime/contracts/hash.js';
import type {
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../workflow-runtime/store/runtime-store/profile.js';
import {
  activateHostCoreRelease,
  inspectHostCoreActivation,
  prepareHostCoreActivation,
  readHostCoreActivationJournal,
  recoverHostCoreActivations,
  verifyActiveHostCore,
  verifyActiveHostCoreDeployment,
} from './activation.js';
import { parseHostCoreReleaseArguments } from './host-core-release-cli.js';
import { acquireHostCoreLock } from './lock.js';
import {
  buildPersistentStateResetPlan,
  decidePersistentStateCompatibility,
  quarantinePersistentState,
  readPersistentStateResetBackup,
} from './persistent-state.js';
import {
  HOST_CORE_MANIFEST_FILENAME,
  HOST_CORE_VALIDATION_COMMANDS,
  assertCleanGitCheckout,
  buildHostCoreDist,
  installHostCoreReleaseFromDist,
  readHostCoreReleaseRegistry,
  resolveHostCoreVersion,
} from './release.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];
const workflowDatabaseRelative = [
  'data',
  'workflow-runtime',
  'workflow-runtime.db',
].join('/');

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(`/private/tmp/${label}`);
  temporaryRoots.push(root);
  return root;
}

function rawHash(file: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeDist(label: string): string {
  const dist = path.join(temporaryRoot(`icarus-host-dist-${label}-`), 'dist');
  fs.mkdirSync(path.join(dist, 'host-core'), { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'index.js'),
    `console.log(${JSON.stringify(label)});\n`,
  );
  fs.writeFileSync(
    path.join(dist, 'host-core/release-entry.js'),
    'console.log("verified");\n',
  );
  return dist;
}

function prepareRuntimeHome(): string {
  const runtimeHome = temporaryRoot('icarus-host-runtime-');
  fs.mkdirSync(path.join(runtimeHome, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'libexec'), { recursive: true });
  fs.copyFileSync(
    path.join(
      projectRoot,
      'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
    ),
    path.join(runtimeHome, 'contracts/managed-node-runtime-distribution.json'),
  );
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/runtime-launcher.sh'),
    path.join(runtimeHome, 'bin/icarus-runtime'),
  );
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/runtime-toolchain.sh'),
    path.join(runtimeHome, 'libexec/icarus-runtime-toolchain'),
  );
  return runtimeHome;
}

function createSchemaDatabase(
  runtimeHome: string,
  migrationName: string,
): string {
  const databasePath = path.join(runtimeHome, workflowDatabaseRelative);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  try {
    database.exec(
      fs.readFileSync(
        path.join(
          projectRoot,
          'src/workflow-runtime/store/schema/migration',
          migrationName,
        ),
        'utf8',
      ),
    );
  } finally {
    database.close();
  }
  return databasePath;
}

function writeStaleActivationLock(runtimeHome: string): void {
  const exited = spawnSync('/usr/bin/true');
  const payload = {
    format: 'icarus.host-core-lock-owner/1',
    token: 'a'.repeat(32),
    pid: exited.pid,
    acquired_at_ms: 1_800_000_000_000,
    process_start_marker: null,
  };
  writeJson(path.join(runtimeHome, '.host-core-activation.lock'), {
    ...payload,
    owner_hash: domainSeparatedSha256(
      'icarus:host-core-lock-owner:1\n',
      payload as unknown as JsonValue,
    ),
  });
}

function publishFixture(
  runtimeHome: string,
  version: string,
  label: string,
  validationStatus: 'PASS' | 'SKIPPED_BY_USER' = 'PASS',
) {
  return installHostCoreReleaseFromDist({
    projectRoot,
    runtimeHome,
    distRoot: makeDist(label),
    version,
    validationStatus,
    commit: '1'.repeat(40),
    tree: '2'.repeat(40),
    registeredAtMs: 1_800_000_000_000,
    includeDependencies: false,
    includeRuntimeAssets: false,
  });
}

function installLegacyActive(runtimeHome: string): Sha256Hash {
  const stage = path.join(runtimeHome, 'legacy-stage');
  fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'dist/index.js'),
    'console.log("legacy");\n',
  );
  fs.writeFileSync(
    path.join(stage, 'dist/validation.js'),
    'console.log("legacy validation");\n',
  );
  const inventory = ['dist/index.js', 'dist/validation.js'].map((relative) => {
    const file = path.join(stage, relative);
    return {
      path: relative,
      byte_length: fs.statSync(file).size,
      executable: false,
      raw_sha256: rawHash(file),
    };
  });
  const distribution = JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'contracts/managed-node-runtime-distribution.json',
      ),
      'utf8',
    ),
  ) as { ref: { id: string; version: string }; manifest_hash: Sha256Hash };
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
    database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
    managed_node_distribution_ref: distribution.ref,
    managed_node_distribution_hash: distribution.manifest_hash,
    runtime_launcher_hash: rawHash(
      path.join(runtimeHome, 'bin/icarus-runtime'),
    ),
    runtime_toolchain_hash: rawHash(
      path.join(runtimeHome, 'libexec/icarus-runtime-toolchain'),
    ),
    core_entry_relative_path: 'dist/index.js',
    core_entry_sha256: rawHash(path.join(stage, 'dist/index.js')),
    validation_entry_relative_path: 'dist/validation.js',
    validation_entry_sha256: rawHash(path.join(stage, 'dist/validation.js')),
    core_build_hash: domainSeparatedSha256(
      'icarus:core-release-build:1\n',
      inventory as unknown as JsonValue,
    ),
    inventory,
    inventory_hash: domainSeparatedSha256(
      'icarus:core-release-inventory:1\n',
      inventory as unknown as JsonValue,
    ),
  };
  const releaseHash = domainSeparatedSha256(
    'icarus:core-release-manifest:1\n',
    payload as unknown as JsonValue,
  );
  const releaseRelative = `core-releases/${releaseHash.slice('sha256:'.length)}`;
  const releaseRoot = path.join(runtimeHome, releaseRelative);
  fs.mkdirSync(path.dirname(releaseRoot), { recursive: true });
  fs.renameSync(stage, releaseRoot);
  const manifest = { ...payload, release_artifact_hash: releaseHash };
  writeJson(path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME), manifest);
  const manifestHash = rawHash(
    path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME),
  );
  const bindingPayload = {
    format: 'icarus.core-runtime-launch-binding/2',
    binding_kind: 'content_addressed_release',
    core_release_relative_path: releaseRelative,
    release_manifest_relative_path: HOST_CORE_MANIFEST_FILENAME,
    release_manifest_sha256: manifestHash,
    release_artifact_hash: releaseHash,
    core_build_hash: payload.core_build_hash,
    core_entry_relative_path: 'dist/index.js',
    core_entry_sha256: payload.core_entry_sha256,
    validation_entry_relative_path: 'dist/validation.js',
    validation_entry_sha256: payload.validation_entry_sha256,
    managed_node_manifest_hash: distribution.manifest_hash,
  };
  const bindingHash = domainSeparatedSha256(
    'icarus:core-runtime-launch-binding:2\n',
    bindingPayload as unknown as JsonValue,
  );
  const bindingRelative = `core-bindings/${bindingHash.slice('sha256:'.length)}`;
  writeJson(path.join(runtimeHome, bindingRelative, 'binding.json'), {
    ...bindingPayload,
    binding_hash: bindingHash,
  });
  fs.symlinkSync(bindingRelative, path.join(runtimeHome, 'active-core'));
  return releaseHash;
}

function runBash(script: string, args: readonly string[] = []) {
  return spawnSync('/bin/bash', ['-c', script, 'host-test', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (!fs.existsSync(root)) continue;
    const makeWritable = (directory: string): void => {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) makeWritable(absolute);
        else if (!entry.isSymbolicLink()) fs.chmodSync(absolute, 0o644);
      }
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Host startup modes', () => {
  it('requires exactly one explicit current or active mode', () => {
    const common = path.join(projectRoot, 'local/shell/common.sh');
    const command = `source ${JSON.stringify(common)}; parse_host_mode "$@" || exit $?; printf '%s' "$HOST_MODE"`;
    expect(runBash(command, ['--mode', 'current']).stdout).toBe('current');
    expect(runBash(command, ['--mode', 'active']).stdout).toBe('active');
    for (const args of [
      [],
      ['current'],
      ['--mode', 'other'],
      ['--mode', 'current', 'extra'],
    ])
      expect(runBash(command, args).status).toBe(64);
  });

  it('prepares current without pointers and active without build or pointer mutation', () => {
    const root = temporaryRoot('icarus-host-shell-');
    const runtimeHome = path.join(root, 'runtime');
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.symlinkSync(
      'core-bindings/current',
      path.join(runtimeHome, 'active-core'),
    );
    fs.symlinkSync(
      'core-bindings/candidate',
      path.join(runtimeHome, 'activation-core'),
    );
    fs.symlinkSync(
      'deployment-bindings/current',
      path.join(runtimeHome, 'active-deployment'),
    );
    fs.mkdirSync(path.join(runtimeHome, 'registry'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimeHome, 'registry/host-core-releases.json'),
      'registry-snapshot\n',
    );
    const pointerSnapshot = () => ({
      active: fs.readlinkSync(path.join(runtimeHome, 'active-core')),
      activation: fs.readlinkSync(path.join(runtimeHome, 'activation-core')),
      deployment: fs.readlinkSync(path.join(runtimeHome, 'active-deployment')),
      registry: fs.readFileSync(
        path.join(runtimeHome, 'registry/host-core-releases.json'),
        'utf8',
      ),
    });
    const before = pointerSnapshot();
    const toolchain = path.join(root, 'toolchain.sh');
    const log = path.join(root, 'commands.log');
    fs.writeFileSync(
      toolchain,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
    );
    fs.chmodSync(toolchain, 0o755);
    const common = path.join(projectRoot, 'local/shell/common.sh');
    const invoke = (mode: 'current' | 'active') =>
      runBash(
        `source ${JSON.stringify(common)}; RUNTIME_TOOLCHAIN=${JSON.stringify(toolchain)}; RUNTIME_HOME=${JSON.stringify(runtimeHome)}; HOST_CORE_RELEASE_CLI=/checkout/host-core-release-cli.ts; prepare_host_mode ${mode}`,
      );
    expect(invoke('current').status).toBe(0);
    expect(pointerSnapshot()).toEqual(before);
    const currentLog = fs.readFileSync(log, 'utf8');
    expect(currentLog).toContain('install');
    expect(currentLog).toContain('verify');
    expect(currentLog).toContain('exec -- npm run build');
    fs.writeFileSync(log, '');
    expect(invoke('active').status).toBe(0);
    const activeLog = fs.readFileSync(log, 'utf8');
    expect(activeLog).toContain('verify');
    expect(activeLog).toContain('verify-active --runtime-home');
    expect(activeLog).not.toContain('npm run build');
    expect(pointerSnapshot()).toEqual(before);
    const launchHost = fs.readFileSync(
      path.join(projectRoot, 'local/shell/launch-host.sh'),
      'utf8',
    );
    expect(launchHost).toContain('launch-active');
    expect(launchHost).not.toContain('"$RUNTIME_LAUNCHER" core');
  });

  it('rejects malformed startup and publish shell arguments before side effects', () => {
    for (const script of ['start.sh', 'restart.sh', 'restart-no-cache.sh']) {
      const result = spawnSync(
        path.join(projectRoot, 'local/shell', script),
        [],
        { cwd: projectRoot, encoding: 'utf8' },
      );
      expect(result.status).toBe(64);
    }
    const release = path.join(projectRoot, 'local/shell/host-core-release.sh');
    expect(spawnSync(release, [], { encoding: 'utf8' }).status).toBe(64);
    expect(spawnSync(release, ['unknown'], { encoding: 'utf8' }).status).toBe(
      64,
    );
    expect(
      spawnSync(
        release,
        ['publish', '--version', '2.0.0', '--reset-incompatible-state'],
        { encoding: 'utf8' },
      ).status,
    ).toBe(64);
  });
});

describe('Host Core release lifecycle', () => {
  it('strictly parses publish and activate arguments', () => {
    expect(
      parseHostCoreReleaseArguments([
        'publish',
        '--version',
        '2.0.0',
        '--runtime-home',
        '/private/tmp/runtime',
      ]).command,
    ).toBe('publish');
    expect(() =>
      parseHostCoreReleaseArguments([
        'activate',
        '--runtime-home',
        '/private/tmp/runtime',
        '--version',
        '2.0.0',
      ]),
    ).toThrow(/Usage/);
    expect(() =>
      parseHostCoreReleaseArguments([
        'publish',
        '--version',
        'latest',
        '--runtime-home',
        '/private/tmp/runtime',
      ]),
    ).toThrow('host_core_version_invalid');
    const reset = parseHostCoreReleaseArguments([
      'activate',
      '--version',
      '2.0.0',
      '--runtime-home',
      '/private/tmp/runtime',
      '--skip-validation',
      '--reset-incompatible-state',
    ]);
    expect(reset.skipValidation).toBe(true);
    expect(reset.resetIncompatibleState).toBe(true);
    expect(() =>
      parseHostCoreReleaseArguments([
        'publish',
        '--version',
        '2.0.0',
        '--runtime-home',
        '/private/tmp/runtime',
        '--reset-incompatible-state',
      ]),
    ).toThrow(/Usage/);
  });

  it('requires one exact clean Git commit and tree', () => {
    const checkout = temporaryRoot('icarus-host-clean-git-');
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'one\n');
    for (const args of [
      ['init'],
      ['config', 'user.name', 'Host Core Test'],
      ['config', 'user.email', 'host-core@example.invalid'],
      ['add', 'tracked.txt'],
      ['commit', '-m', 'fixture'],
    ]) {
      const result = spawnSync('git', args, {
        cwd: checkout,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(assertCleanGitCheckout(checkout)).toMatchObject({
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      tree: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'two\n');
    expect(() => assertCleanGitCheckout(checkout)).toThrow(
      'host_core_publish_requires_clean_git',
    );
  });

  it('builds in isolated output and retains production identity after formal activation', () => {
    const output = path.join(
      temporaryRoot('icarus-host-isolated-build-'),
      'dist',
    );
    const checkoutEntry = path.join(projectRoot, 'dist/index.js');
    const before = fs.existsSync(checkoutEntry) ? rawHash(checkoutEntry) : null;
    buildHostCoreDist(projectRoot, output);
    expect(fs.existsSync(path.join(output, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'host-core/release-entry.js'))).toBe(
      true,
    );
    expect(fs.existsSync(checkoutEntry) ? rawHash(checkoutEntry) : null).toBe(
      before,
    );
    const runtimeHome = prepareRuntimeHome();
    const installed = installHostCoreReleaseFromDist({
      projectRoot,
      runtimeHome,
      distRoot: output,
      version: '2.0.0',
      validationStatus: 'PASS',
      commit: '3'.repeat(40),
      tree: '4'.repeat(40),
      registeredAtMs: 1_800_000_000_000,
      includeDependencies: true,
      includeRuntimeAssets: false,
    });
    activateHostCoreRelease({
      runtimeHome,
      version: '2.0.0',
      skipValidation: true,
      confirm: () => true,
      activationId: 'compiled-formal-host',
    });
    const releaseRoot = path.join(
      runtimeHome,
      installed.registry.entries[0]!.release_relative_path,
    );
    const identityCheck = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const [moduleUrl, runtimeHome, expectedHash] = process.argv.slice(1);
         const identity = await import(moduleUrl);
         identity.verifyFormalHostCoreProductionIdentity(runtimeHome, expectedHash);
         console.log('formal-production-identity=ok');`,
        pathToFileURL(
          path.join(
            releaseRoot,
            'dist/workflow-runtime/store/runtime-store/identity.js',
          ),
        ).href,
        runtimeHome,
        installed.manifest.managed_node_distribution_hash,
      ],
      { encoding: 'utf8' },
    );
    expect(identityCheck.status, identityCheck.stderr).toBe(0);
    expect(identityCheck.stdout).toContain('formal-production-identity=ok');
  }, 30_000);

  it('publishes immutable unique versions without activating and records skips', () => {
    const runtimeHome = prepareRuntimeHome();
    const first = publishFixture(
      runtimeHome,
      '2.0.0',
      'first',
      'SKIPPED_BY_USER',
    );
    expect(first.manifest.validation_status).toBe('SKIPPED_BY_USER');
    expect(first.manifest.validation_commands).toEqual([]);
    expect(first.manifest.format).toBe('icarus.host-core-release-manifest/1');
    expect(first.manifest.release_scope).toBe('icarus_host_core');
    expect(fs.existsSync(path.join(runtimeHome, 'active-core'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeHome, 'active-deployment'))).toBe(
      false,
    );
    expect(resolveHostCoreVersion(runtimeHome, '2.0.0').manifest).toEqual(
      first.manifest,
    );
    expect(() => publishFixture(runtimeHome, '2.0.0', 'different')).toThrow(
      'host_core_version_rebind_rejected',
    );
    expect(readHostCoreReleaseRegistry(runtimeHome).entries).toHaveLength(1);
    const passed = publishFixture(runtimeHome, '2.0.1', 'passed');
    expect(passed.manifest.validation_commands).toEqual(
      HOST_CORE_VALIDATION_COMMANDS,
    );
    expect(HOST_CORE_VALIDATION_COMMANDS).toContain('contracts:check');
  });

  it('does not remove a Registry lock owned by another live operation', () => {
    const runtimeHome = prepareRuntimeHome();
    const lock = acquireHostCoreLock({
      runtimeHome,
      name: '.host-core-release-registry.lock',
      busyError: 'host_core_registry_busy',
    });
    expect(() => publishFixture(runtimeHome, '2.0.0', 'busy')).toThrow(
      'host_core_registry_busy',
    );
    expect(fs.existsSync(lock.path)).toBe(true);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
    const activationLock = acquireHostCoreLock({
      runtimeHome,
      name: '.host-core-activation.lock',
      busyError: 'host_core_activation_busy',
    });
    expect(() => recoverHostCoreActivations(runtimeHome)).toThrow(
      'host_core_activation_busy',
    );
    expect(fs.existsSync(activationLock.path)).toBe(true);
    activationLock.release();
  });

  it('resolves a frozen legacy v1.2.14 active release', () => {
    const runtimeHome = prepareRuntimeHome();
    const releaseHash = installLegacyActive(runtimeHome);
    expect(verifyActiveHostCore(runtimeHome)).toMatchObject({
      version: '1.2.14',
      release_artifact_hash: releaseHash,
      formal: false,
      binding_kind: 'content_addressed_release',
    });
    const launched = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(projectRoot, 'src/host-core/host-core-release-cli.ts'),
        'launch-active',
        '--runtime-home',
        runtimeHome,
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain('legacy');
    expect(launched.stdout).not.toContain('legacy validation');
  });

  it('launches a formal core entry instead of its validation entry', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '2.0.0', 'formal core launched');
    activateHostCoreRelease({
      runtimeHome,
      version: '2.0.0',
      skipValidation: true,
      confirm: () => true,
      activationId: 'formal-launch',
    });
    const active = verifyActiveHostCore(runtimeHome);
    expect(active.binding_kind).toBe('content_addressed_host_core_release');
    const binding = JSON.parse(
      fs.readFileSync(
        path.join(
          fs.realpathSync(path.join(runtimeHome, 'active-core')),
          'binding.json',
        ),
        'utf8',
      ),
    ) as { format: string };
    expect(binding.format).toBe('icarus.host-core-runtime-launch-binding/1');
    const launched = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(projectRoot, 'src/host-core/host-core-release-cli.ts'),
        'launch-active',
        '--runtime-home',
        runtimeHome,
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(launched.status, launched.stderr).toBe(0);
    expect(launched.stdout).toContain('formal core launched');
    expect(launched.stdout).not.toContain('verified');
  });

  it('activates atomically, writes a durable audit, and exactly replays recovery', () => {
    const runtimeHome = prepareRuntimeHome();
    installLegacyActive(runtimeHome);
    const published = publishFixture(runtimeHome, '2.0.0', 'target');
    const outcome = activateHostCoreRelease({
      runtimeHome,
      version: '2.0.0',
      skipValidation: true,
      confirm: () => true,
      now: () => 1_800_000_000_100,
      activationId: 'host-core-test-activation',
    });
    expect(outcome.release_artifact_hash).toBe(
      published.manifest.release_artifact_hash,
    );
    expect(verifyActiveHostCore(runtimeHome)).toMatchObject({
      version: '2.0.0',
      formal: true,
    });
    expect(fs.readlinkSync(path.join(runtimeHome, 'activation-core'))).toBe(
      fs.readlinkSync(path.join(runtimeHome, 'active-core')),
    );
    expect(
      fs.readlinkSync(path.join(runtimeHome, 'active-deployment')),
    ).toMatch(/^deployment-bindings\/[0-9a-f]{64}$/);
    expect(() => verifyActiveHostCoreDeployment(runtimeHome)).not.toThrow();
    expect(
      fs.existsSync(
        path.join(
          runtimeHome,
          'host-core-activation-audits',
          outcome.activation_audit_hash.slice('sha256:'.length),
          'activation-audit.json',
        ),
      ),
    ).toBe(true);
    const audit = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeHome,
          'host-core-activation-audits',
          outcome.activation_audit_hash.slice('sha256:'.length),
          'activation-audit.json',
        ),
        'utf8',
      ),
    ) as {
      readiness_status: string;
      validation_status: string;
      validation_commands: readonly string[];
      persistent_state_action: string;
    };
    expect(audit.readiness_status).toBe('SKIPPED_BY_USER');
    expect(audit.validation_status).toBe('PASS');
    expect(audit.validation_commands).toEqual(HOST_CORE_VALIDATION_COMMANDS);
    expect(audit.persistent_state_action).toBe('NO_STATE');
    expect(
      readHostCoreActivationJournal(
        runtimeHome,
        'host-core-test-activation',
      ).map((event) => event.phase),
    ).toEqual([
      'prepared',
      'activation_core_selected',
      'active_deployment_committed',
      'active_core_committed',
      'completed',
    ]);
    expect(recoverHostCoreActivations(runtimeHome)).toEqual([]);
  });

  it('decides no-state, same-schema, migration, reset, and unknown schema cases', () => {
    const target = {
      database_schema_version: 11,
      database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
    } as const;
    const empty = prepareRuntimeHome();
    expect(decidePersistentStateCompatibility(empty, target).decision).toBe(
      'NO_STATE',
    );

    const same = prepareRuntimeHome();
    createSchemaDatabase(same, 'workflow-runtime-schema-v11.sql');
    expect(decidePersistentStateCompatibility(same, target).decision).toBe(
      'SAME_SCHEMA',
    );

    const migratable = prepareRuntimeHome();
    createSchemaDatabase(migratable, 'workflow-runtime-schema-v10.sql');
    expect(
      decidePersistentStateCompatibility(migratable, target).decision,
    ).toBe('MIGRATION_SUPPORTED');

    expect(
      decidePersistentStateCompatibility(same, {
        database_schema_version: 10,
        database_schema_hash: `sha256:${'5'.repeat(64)}`,
        database_sqlite_schema_hash:
          CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
      }).decision,
    ).toBe('RESET_REQUIRED');

    const unknown = prepareRuntimeHome();
    const unknownPath = createSchemaDatabase(
      unknown,
      'workflow-runtime-schema-v10.sql',
    );
    const database = new Database(unknownPath);
    try {
      database.exec(
        'CREATE TABLE host_core_unknown_schema (id TEXT PRIMARY KEY)',
      );
    } finally {
      database.close();
    }
    expect(decidePersistentStateCompatibility(unknown, target).decision).toBe(
      'UNKNOWN_BLOCKED',
    );
  });

  it('quarantines the database and WAL/SHM companions as one identified unit', () => {
    const runtimeHome = prepareRuntimeHome();
    const members = [
      workflowDatabaseRelative,
      `${workflowDatabaseRelative}-wal`,
      `${workflowDatabaseRelative}-shm`,
    ].map((relative, index) => {
      const absolute = path.join(runtimeHome, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `state-${index}\n`);
      return {
        source_relative_path: relative,
        backup_name: path.basename(relative),
        byte_length: fs.statSync(absolute).size,
        raw_sha256: rawHash(absolute),
      };
    });
    const plan = buildPersistentStateResetPlan({
      decision: 'RESET_REQUIRED',
      old_identity: {
        database_schema_version: 10,
        database_sqlite_schema_hash:
          CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
      },
      target_identity: {
        database_schema_version: 11,
        database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
        database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
      },
      affected_paths: members.map((member) =>
        path.join(runtimeHome, member.source_relative_path),
      ),
      members,
      reason: 'fixture_reset',
    });
    quarantinePersistentState(runtimeHome, plan);
    expect(
      readPersistentStateResetBackup(runtimeHome, plan.backup_relative_path),
    ).toEqual(plan);
    for (const member of members) {
      expect(
        fs.existsSync(path.join(runtimeHome, member.source_relative_path)),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(runtimeHome, plan.backup_relative_path, member.backup_name),
        ),
      ).toBe(true);
    }
  });

  it('recovers a prepared reset behind a stale owned lock and records the audit', () => {
    const runtimeHome = prepareRuntimeHome();
    fs.mkdirSync(path.join(runtimeHome, 'credentials'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimeHome, 'credentials/keep'),
      'credential\n',
    );
    fs.mkdirSync(path.join(runtimeHome, 'capacity'), { recursive: true });
    fs.writeFileSync(path.join(runtimeHome, 'capacity/keep'), 'capacity\n');
    const databasePath = createSchemaDatabase(
      runtimeHome,
      'workflow-runtime-schema-v11.sql',
    );
    installHostCoreReleaseFromDist({
      projectRoot,
      runtimeHome,
      distRoot: makeDist('reset target'),
      version: '2.0.0',
      validationStatus: 'PASS',
      commit: '7'.repeat(40),
      tree: '8'.repeat(40),
      registeredAtMs: 1_800_000_000_000,
      includeDependencies: false,
      includeRuntimeAssets: false,
      databaseSchemaIdentity: {
        version: 10,
        schemaHash: `sha256:${'9'.repeat(64)}`,
        sqliteSchemaHash:
          CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
      },
    });
    const preflight = inspectHostCoreActivation(runtimeHome, '2.0.0');
    expect(preflight.persistent_state.decision).toBe('RESET_REQUIRED');
    expect(() =>
      activateHostCoreRelease({
        runtimeHome,
        version: '2.0.0',
        skipValidation: true,
        confirm: () => true,
      }),
    ).toThrow('host_core_persistent_state_RESET_REQUIRED');
    const prepared = prepareHostCoreActivation({
      runtimeHome,
      version: '2.0.0',
      skipValidation: true,
      resetIncompatibleState: true,
      confirm: () => true,
      now: () => 1_800_000_000_200,
      activationId: 'recover-reset',
    });
    expect(fs.existsSync(databasePath)).toBe(true);
    writeStaleActivationLock(runtimeHome);
    expect(recoverHostCoreActivations(runtimeHome)).toHaveLength(1);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(
      fs.existsSync(path.join(runtimeHome, '.host-core-activation.lock')),
    ).toBe(false);
    const events = readHostCoreActivationJournal(
      runtimeHome,
      prepared.activation_id,
    );
    expect(events.map((event) => event.phase)).toEqual([
      'prepared',
      'persistent_state_quarantined',
      'activation_core_selected',
      'active_deployment_committed',
      'active_core_committed',
      'completed',
    ]);
    const auditPath = path.join(
      runtimeHome,
      'host-core-activation-audits',
      prepared.activation_audit_hash.slice('sha256:'.length),
      'activation-audit.json',
    );
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')) as {
      persistent_state_action: string;
      old_persistent_state_identity: { database_schema_version: number };
      target_persistent_state_identity: { database_schema_version: number };
      persistent_state_backup_identity: Sha256Hash;
      persistent_state_backup_relative_path: string;
      persistent_state_rollback: string;
    };
    expect(audit.persistent_state_action).toBe('RESET_BY_USER');
    expect(audit.old_persistent_state_identity.database_schema_version).toBe(
      11,
    );
    expect(audit.target_persistent_state_identity.database_schema_version).toBe(
      10,
    );
    expect(audit.persistent_state_backup_identity).toMatch(/^sha256:/);
    expect(
      readPersistentStateResetBackup(
        runtimeHome,
        audit.persistent_state_backup_relative_path,
      ).backup_identity,
    ).toBe(audit.persistent_state_backup_identity);
    expect(audit.persistent_state_rollback).toBe(
      'CODE_ROLLBACK_DOES_NOT_RESTORE_QUARANTINED_STATE',
    );
    expect(
      fs.readFileSync(path.join(runtimeHome, 'credentials/keep'), 'utf8'),
    ).toBe('credential\n');
    expect(
      fs.readFileSync(path.join(runtimeHome, 'capacity/keep'), 'utf8'),
    ).toBe('capacity\n');
    expect(readHostCoreReleaseRegistry(runtimeHome).entries).toHaveLength(1);
  });

  it('never lets skip-validation bypass unknown persistent state', () => {
    const runtimeHome = prepareRuntimeHome();
    const databasePath = createSchemaDatabase(
      runtimeHome,
      'workflow-runtime-schema-v10.sql',
    );
    const database = new Database(databasePath);
    try {
      database.exec('CREATE TABLE unknown_state (id INTEGER PRIMARY KEY)');
    } finally {
      database.close();
    }
    publishFixture(runtimeHome, '2.0.0', 'unknown target');
    expect(() =>
      activateHostCoreRelease({
        runtimeHome,
        version: '2.0.0',
        skipValidation: true,
        resetIncompatibleState: true,
        confirm: () => true,
      }),
    ).toThrow('host_core_persistent_state_unknown');
  });

  it('requires confirmation and never invokes release validation suites at activation', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '2.0.0', 'target');
    expect(() =>
      activateHostCoreRelease({
        runtimeHome,
        version: '2.0.0',
        skipValidation: false,
        confirm: () => false,
      }),
    ).toThrow('host_core_activation_cancelled');
    expect(fs.existsSync(path.join(runtimeHome, 'active-core'))).toBe(false);
    const source = fs.readFileSync(
      path.join(projectRoot, 'src/host-core/activation.ts'),
      'utf8',
    );
    expect(source).not.toContain("'test:current'");
    expect(source).not.toContain("'contracts:check'");
  });
});
