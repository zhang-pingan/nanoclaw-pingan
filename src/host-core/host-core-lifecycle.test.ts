import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { domainSeparatedSha256 } from '../workflow-runtime/contracts/hash.js';
import type {
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../workflow-runtime/gateway/host-core.js';
import {
  activateHostCoreRelease,
  inspectHostCoreActivation,
  verifyActiveHostCore,
} from './activation.js';
import { parseHostCoreReleaseArguments } from './host-core-release-cli.js';
import {
  WORKFLOW_STATE_DATABASE_RELATIVE,
  WORKFLOW_STATE_RELATIVE_PATHS,
  type WorkflowRuntimeSchemaCompatibility,
  buildPersistentStateResetPlan,
  currentWorkflowRuntimeSchemaCompatibility,
  decidePersistentStateCompatibility,
  discoverPersistentStateResetRecovery,
  quarantinePersistentState,
  readPersistentStateResetBackup,
} from './persistent-state.js';
import {
  HOST_CORE_MANIFEST_FILENAME,
  HOST_CORE_VALIDATION_COMMANDS,
  assertCleanGitCheckout,
  buildHostCoreDist,
  hostCoreVersionPath,
  installHostCoreReleaseFromDist,
  readHostCoreVersionRecord,
  resolveHostCoreVersion,
} from './release.js';
import {
  parseWorkflowStateArguments,
  runWorkflowStateCli,
} from './workflow-state-cli.js';
import {
  inspectWorkflowState,
  prepareWorkflowStateReset,
  resetWorkflowState,
} from './workflow-state.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

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
  migrationName:
    | 'workflow-runtime-schema-v10.sql'
    | 'workflow-runtime-schema-v11.sql',
): string {
  const databasePath = path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE);
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

function setDatabaseApplicationId(databasePath: string, value: number): void {
  const database = new Database(databasePath);
  try {
    database.pragma(`application_id = ${String(value)}`);
  } finally {
    database.close();
  }
}

function backupSnapshot(root: string): unknown {
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      return {
        name,
        byte_length: stat.size,
        mode: stat.mode & 0o777,
        raw_sha256: rawHash(file),
      };
    });
}

async function runConfirmedWorkflowReset(
  runtimeHome: string,
): Promise<string[]> {
  const output: string[] = [];
  const status = await runWorkflowStateCli(
    ['reset', '--mode', 'active', '--runtime-home', runtimeHome],
    {
      projectRoot,
      inputIsTTY: true,
      outputIsTTY: true,
      hostIsRunning: () => false,
      confirm: async () => true,
      output: (line) => output.push(line),
    },
  );
  expect(status).toBe(0);
  return output;
}

function publishFixture(
  runtimeHome: string,
  version: string,
  label: string,
  options: {
    validationStatus?: 'PASS' | 'SKIPPED_BY_USER';
    schemaVersion?: 10 | 11;
    schemaCompatibility?: WorkflowRuntimeSchemaCompatibility;
  } = {},
) {
  const schemaVersion = options.schemaVersion ?? 11;
  const schemaIdentity = {
    version: schemaVersion,
    schemaHash:
      schemaVersion === 11
        ? CURRENT_G1_SCHEMA_IDENTITIES.schema
        : (`sha256:${'5'.repeat(64)}` as Sha256Hash),
    sqliteSchemaHash:
      schemaVersion === 11
        ? CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema
        : CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
  };
  const schemaCompatibility =
    options.schemaCompatibility ??
    (schemaVersion === 11
      ? currentWorkflowRuntimeSchemaCompatibility()
      : {
          format: 'icarus.workflow-runtime-schema-compatibility/1' as const,
          target_identity: {
            database_schema_version: schemaIdentity.version,
            database_schema_hash: schemaIdentity.schemaHash,
            database_sqlite_schema_hash: schemaIdentity.sqliteSchemaHash,
          },
          recognized_sources: [
            {
              database_schema_version: 11,
              database_sqlite_schema_hash:
                CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
              migration: 'UNSUPPORTED' as const,
              precondition: 'NONE' as const,
            },
          ],
        });
  return installHostCoreReleaseFromDist({
    projectRoot,
    runtimeHome,
    distRoot: makeDist(label),
    version,
    validationStatus: options.validationStatus ?? 'PASS',
    commit: '1'.repeat(40),
    tree: '2'.repeat(40),
    includeDependencies: false,
    includeRuntimeAssets: false,
    databaseSchemaIdentity: schemaIdentity,
    workflowRuntimeSchemaCompatibility: schemaCompatibility,
  });
}

function makeRuntimeMismatchProject(): string {
  const root = temporaryRoot('icarus-host-mismatch-project-');
  writeJson(path.join(root, 'package.json'), { version: '0.0.0' });
  const contractRelative =
    'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json';
  fs.mkdirSync(path.dirname(path.join(root, contractRelative)), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(projectRoot, contractRelative),
    path.join(root, contractRelative),
  );
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts/runtime-launcher.sh'),
    '#!/bin/bash\necho mismatched-runtime\n',
  );
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/runtime-toolchain.sh'),
    path.join(root, 'scripts/runtime-toolchain.sh'),
  );
  return root;
}

function schema11Compatibility(
  recognizedSources: WorkflowRuntimeSchemaCompatibility['recognized_sources'],
): WorkflowRuntimeSchemaCompatibility {
  return {
    format: 'icarus.workflow-runtime-schema-compatibility/1',
    target_identity: {
      database_schema_version: 11,
      database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
    },
    recognized_sources: recognizedSources,
  };
}

function selectFixture(
  runtimeHome: string,
  version: string,
  skipValidation = true,
) {
  return activateHostCoreRelease({
    runtimeHome,
    version,
    skipValidation,
    confirm: () => true,
  });
}

function installLegacyActive(runtimeHome: string): Sha256Hash {
  const stage = path.join(runtimeHome, 'legacy-stage');
  const validationRelative =
    'dist/workflow-runtime/certification/release-entry.js';
  fs.mkdirSync(path.join(stage, path.dirname(validationRelative)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(stage, 'dist/index.js'),
    'console.log("legacy");\n',
  );
  fs.writeFileSync(
    path.join(stage, validationRelative),
    'console.log("legacy validation");\n',
  );
  const inventory = ['dist/index.js', validationRelative].map((relative) => {
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
    validation_entry_relative_path: validationRelative,
    validation_entry_sha256: rawHash(path.join(stage, validationRelative)),
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
  writeJson(path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME), {
    ...payload,
    release_artifact_hash: releaseHash,
  });
  const bindingPayload = {
    format: 'icarus.core-runtime-launch-binding/2',
    binding_kind: 'content_addressed_release',
    core_release_relative_path: releaseRelative,
    release_manifest_relative_path: HOST_CORE_MANIFEST_FILENAME,
    release_manifest_sha256: rawHash(
      path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME),
    ),
    release_artifact_hash: releaseHash,
    core_build_hash: payload.core_build_hash,
    core_entry_relative_path: 'dist/index.js',
    core_entry_sha256: payload.core_entry_sha256,
    validation_entry_relative_path: validationRelative,
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

function runHostCoreCli(runtimeHome: string, command: 'launch-active') {
  return spawnSync(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(projectRoot, 'src/host-core/host-core-release-cli.ts'),
      command,
      '--runtime-home',
      runtimeHome,
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );
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

describe('Host Core shell and CLI surface', () => {
  it('requires explicit startup modes and keeps current/active preparation separate', () => {
    const common = path.join(projectRoot, 'local/shell/common.sh');
    const parse = `source ${JSON.stringify(common)}; parse_host_mode "$@" || exit $?; printf '%s' "$HOST_MODE"`;
    expect(runBash(parse, ['--mode', 'current']).stdout).toBe('current');
    expect(runBash(parse, ['--mode', 'active']).stdout).toBe('active');
    expect(runBash(parse, ['--mode', 'other']).status).toBe(64);

    const root = temporaryRoot('icarus-host-shell-');
    const runtimeHome = path.join(root, 'runtime');
    fs.mkdirSync(runtimeHome);
    const historical = {
      activation: 'historical-activation\n',
      deployment: 'historical-deployment\n',
    };
    fs.writeFileSync(
      path.join(runtimeHome, 'activation-core'),
      historical.activation,
    );
    fs.writeFileSync(
      path.join(runtimeHome, 'active-deployment'),
      historical.deployment,
    );
    const toolchain = path.join(root, 'toolchain.sh');
    const log = path.join(root, 'commands.log');
    fs.writeFileSync(
      toolchain,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
    );
    fs.chmodSync(toolchain, 0o755);
    const invoke = (mode: 'current' | 'active') =>
      runBash(
        `source ${JSON.stringify(common)}; RUNTIME_TOOLCHAIN=${JSON.stringify(toolchain)}; RUNTIME_HOME=${JSON.stringify(runtimeHome)}; HOST_CORE_RELEASE_CLI=/checkout/host-core.ts; WORKFLOW_STATE_CLI=/checkout/workflow-state.ts; prepare_host_mode ${mode}`,
      );
    expect(invoke('current').status).toBe(0);
    let commands = fs.readFileSync(log, 'utf8');
    expect(commands).toContain('exec -- npm run build');
    expect(commands).toContain('inspect --mode current');
    fs.writeFileSync(log, '');
    expect(invoke('active').status).toBe(0);
    commands = fs.readFileSync(log, 'utf8');
    expect(commands).toContain('verify-active --runtime-home');
    expect(commands).toContain('inspect --mode active');
    expect(commands).not.toContain('npm run build');
    expect(
      fs.readFileSync(path.join(runtimeHome, 'activation-core'), 'utf8'),
    ).toBe(historical.activation);
    expect(
      fs.readFileSync(path.join(runtimeHome, 'active-deployment'), 'utf8'),
    ).toBe(historical.deployment);
    const launcher = fs.readFileSync(
      path.join(projectRoot, 'local/shell/launch-host.sh'),
      'utf8',
    );
    expect(launcher).toContain('inspect_workflow_state current');
    expect(launcher).toContain('node "$BACKEND_ENTRY"');
    expect(launcher).toContain('inspect_workflow_state active');
    expect(launcher).toContain('launch-active');
  });

  it('rejects removed reset flags and parses the independent state command', () => {
    expect(() =>
      parseHostCoreReleaseArguments([
        'activate',
        '--version',
        '2.0.0',
        '--runtime-home',
        '/private/tmp/runtime',
        '--reset-incompatible-state',
      ]),
    ).toThrow('Usage:');
    expect(
      parseHostCoreReleaseArguments([
        'publish',
        '--version',
        '2.0.0',
        '--runtime-home',
        '/private/tmp/runtime',
        '--skip-validation',
      ]).skipValidation,
    ).toBe(true);
    expect(
      parseWorkflowStateArguments([
        'reset',
        '--mode',
        'active',
        '--runtime-home',
        '/private/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'reset', mode: 'active' });
    const releaseShell = path.join(
      projectRoot,
      'local/shell/host-core-release.sh',
    );
    expect(
      spawnSync(
        releaseShell,
        ['activate', '--version', '2.0.0', '--reset-incompatible-state'],
        { encoding: 'utf8' },
      ).status,
    ).toBe(64);
  });
});

describe('immutable Host Core publishing', () => {
  it('builds the Host Core entry surface in isolated output', () => {
    const output = path.join(temporaryRoot('icarus-host-build-'), 'dist');
    buildHostCoreDist(projectRoot, output);
    expect(fs.existsSync(path.join(output, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'host-core/release-entry.js'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(output, 'host-core/workflow-state-cli.js')),
    ).toBe(true);
  }, 20_000);

  it('requires a clean exact Git commit and tree', () => {
    const checkout = temporaryRoot('icarus-host-git-');
    expect(spawnSync('git', ['init'], { cwd: checkout }).status).toBe(0);
    expect(
      spawnSync('git', ['config', 'user.name', 'Host Core Test'], {
        cwd: checkout,
      }).status,
    ).toBe(0);
    expect(
      spawnSync('git', ['config', 'user.email', 'host@example.invalid'], {
        cwd: checkout,
      }).status,
    ).toBe(0);
    fs.writeFileSync(path.join(checkout, 'tracked'), 'one\n');
    spawnSync('git', ['add', 'tracked'], { cwd: checkout });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: checkout });
    const identity = assertCleanGitCheckout(checkout);
    expect(identity.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.tree).toMatch(/^[0-9a-f]{40}$/);
    fs.writeFileSync(path.join(checkout, 'untracked'), 'dirty\n');
    expect(() => assertCleanGitCheckout(checkout)).toThrow(
      'host_core_publish_requires_clean_git',
    );
  });

  it('installs one immutable record per version and never activates', () => {
    const runtimeHome = prepareRuntimeHome();
    fs.mkdirSync(
      path.dirname(path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE)),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(
      path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE),
      'runtime-state-sentinel',
    );
    fs.writeFileSync(path.join(runtimeHome, 'active-deployment'), 'historical');
    const published = publishFixture(runtimeHome, '2.0.0', 'first', {
      validationStatus: 'SKIPPED_BY_USER',
    });
    const record = readHostCoreVersionRecord(runtimeHome, '2.0.0');
    expect(record).toEqual(published.versionRecord);
    expect(record.validation_status).toBe('SKIPPED_BY_USER');
    expect(published.manifest.validation_commands).toEqual([]);
    expect(HOST_CORE_VALIDATION_COMMANDS).toEqual([
      'test:current',
      'contracts:check',
      'typecheck',
      'format:check',
    ]);
    expect(
      fs.statSync(hostCoreVersionPath(runtimeHome, '2.0.0')).mode & 0o222,
    ).toBe(0);
    expect(fs.existsSync(path.join(runtimeHome, 'active-core'))).toBe(false);
    expect(
      fs.readFileSync(path.join(runtimeHome, 'active-deployment'), 'utf8'),
    ).toBe('historical');
    expect(
      fs.readFileSync(
        path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE),
        'utf8',
      ),
    ).toBe('runtime-state-sentinel');
    expect(resolveHostCoreVersion(runtimeHome, '2.0.0').manifest).toEqual(
      published.manifest,
    );
  });

  it('accepts exact repeat publication and rejects version rebinding', () => {
    const runtimeHome = prepareRuntimeHome();
    const dist = makeDist('repeat');
    const options = {
      projectRoot,
      runtimeHome,
      distRoot: dist,
      version: '2.1.0',
      validationStatus: 'PASS' as const,
      commit: '3'.repeat(40),
      tree: '4'.repeat(40),
      includeDependencies: false,
      includeRuntimeAssets: false,
    };
    const first = installHostCoreReleaseFromDist(options);
    expect(installHostCoreReleaseFromDist(options)).toEqual(first);
    expect(() => publishFixture(runtimeHome, '2.1.0', 'different')).toThrow(
      'host_core_version_rebind_rejected',
    );
    expect(readHostCoreVersionRecord(runtimeHome, '2.1.0')).toEqual(
      first.versionRecord,
    );
  });
});

describe('single active-core selection', () => {
  it('updates only active-core and never reads or mutates runtime state or old pointers', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '3.0.0', 'target');
    const sentinels = new Map([
      ['activation-core', 'old activation pointer'],
      ['active-deployment', 'old deployment pointer'],
      ['host-core-activation-journals/history', 'old journal'],
      ['host-core-activation-audits/history', 'old audit'],
      [WORKFLOW_STATE_DATABASE_RELATIVE, 'not a sqlite database'],
    ]);
    for (const [relative, bytes] of sentinels) {
      fs.mkdirSync(path.dirname(path.join(runtimeHome, relative)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(runtimeHome, relative), bytes);
    }
    const result = selectFixture(runtimeHome, '3.0.0');
    expect(result.readiness_status).toBe('SKIPPED_BY_USER');
    expect(fs.readlinkSync(path.join(runtimeHome, 'active-core'))).toMatch(
      /^core-bindings\/[0-9a-f]{64}$/,
    );
    for (const [relative, bytes] of sentinels)
      expect(fs.readFileSync(path.join(runtimeHome, relative), 'utf8')).toBe(
        bytes,
      );
    expect(verifyActiveHostCore(runtimeHome).formal).toBe(true);
    expect(
      inspectHostCoreActivation(runtimeHome, '3.0.0').target.ref.version,
    ).toBe('3.0.0');
  });

  it('runs readiness unless explicitly skipped and preserves selection on failure', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '3.1.0', 'good');
    selectFixture(runtimeHome, '3.1.0');
    const previous = fs.readlinkSync(path.join(runtimeHome, 'active-core'));
    const badDist = makeDist('bad');
    fs.writeFileSync(path.join(badDist, 'index.js'), 'this is invalid {\n');
    installHostCoreReleaseFromDist({
      projectRoot,
      runtimeHome,
      distRoot: badDist,
      version: '3.2.0',
      validationStatus: 'SKIPPED_BY_USER',
      commit: '6'.repeat(40),
      tree: '7'.repeat(40),
      includeDependencies: false,
      includeRuntimeAssets: false,
    });
    expect(() =>
      activateHostCoreRelease({
        runtimeHome,
        version: '3.2.0',
        skipValidation: false,
        confirm: () => true,
      }),
    ).toThrow();
    expect(fs.readlinkSync(path.join(runtimeHome, 'active-core'))).toBe(
      previous,
    );
  });

  it('rejects target runtime mismatch before switching and permits a later valid activation', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '3.3.0', 'existing');
    selectFixture(runtimeHome, '3.3.0');
    const pointer = path.join(runtimeHome, 'active-core');
    const previous = fs.readlinkSync(pointer);
    installHostCoreReleaseFromDist({
      projectRoot: makeRuntimeMismatchProject(),
      runtimeHome,
      distRoot: makeDist('runtime-mismatch'),
      version: '3.4.0',
      validationStatus: 'PASS',
      commit: '8'.repeat(40),
      tree: '9'.repeat(40),
      includeDependencies: false,
      includeRuntimeAssets: false,
      workflowRuntimeSchemaCompatibility:
        currentWorkflowRuntimeSchemaCompatibility(),
    });
    expect(() => selectFixture(runtimeHome, '3.4.0')).toThrow(
      'active_core_runtime_identity_mismatch',
    );
    expect(fs.readlinkSync(pointer)).toBe(previous);

    publishFixture(runtimeHome, '3.5.0', 'later-valid');
    expect(selectFixture(runtimeHome, '3.5.0').version).toBe('3.5.0');
    expect(fs.readlinkSync(pointer)).not.toBe(previous);
  });

  it('leaves active-core absent when a first activation has a runtime mismatch', () => {
    const runtimeHome = prepareRuntimeHome();
    installHostCoreReleaseFromDist({
      projectRoot: makeRuntimeMismatchProject(),
      runtimeHome,
      distRoot: makeDist('first-runtime-mismatch'),
      version: '3.6.0',
      validationStatus: 'SKIPPED_BY_USER',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      includeDependencies: false,
      includeRuntimeAssets: false,
      workflowRuntimeSchemaCompatibility:
        currentWorkflowRuntimeSchemaCompatibility(),
    });
    expect(() => selectFixture(runtimeHome, '3.6.0')).toThrow(
      'active_core_runtime_identity_mismatch',
    );
    expect(fs.existsSync(path.join(runtimeHome, 'active-core'))).toBe(false);
  });

  it('verifies formal and accepted legacy G8 active releases without deployment state', () => {
    const formalHome = prepareRuntimeHome();
    publishFixture(formalHome, '4.0.0', 'formal');
    selectFixture(formalHome, '4.0.0');
    expect(fs.existsSync(path.join(formalHome, 'active-deployment'))).toBe(
      false,
    );
    expect(verifyActiveHostCore(formalHome)).toMatchObject({
      version: '4.0.0',
      formal: true,
    });
    const formalLaunch = runHostCoreCli(formalHome, 'launch-active');
    expect(formalLaunch.status, formalLaunch.stderr).toBe(0);
    expect(formalLaunch.stdout).toContain('formal');

    const legacyHome = prepareRuntimeHome();
    const legacyHash = installLegacyActive(legacyHome);
    expect(verifyActiveHostCore(legacyHome)).toMatchObject({
      version: '1.2.14',
      release_artifact_hash: legacyHash,
      formal: false,
    });
    const legacyLaunch = runHostCoreCli(legacyHome, 'launch-active');
    expect(legacyLaunch.status, legacyLaunch.stderr).toBe(0);
    expect(legacyLaunch.stdout).toContain('legacy');
    expect(inspectWorkflowState(legacyHome, 'active').decision.decision).toBe(
      'NO_STATE',
    );
    createSchemaDatabase(legacyHome, 'workflow-runtime-schema-v10.sql');
    expect(inspectWorkflowState(legacyHome, 'active').decision).toMatchObject({
      decision: 'UNKNOWN_BLOCKED',
      reason: 'frozen_migration_authority_unavailable',
    });
  });
});

describe('Workflow Runtime state decision and maintenance', () => {
  const currentTarget = {
    database_schema_version: 11,
    database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
    database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
  };

  it('classifies no state, same schema, migration, reset-required, unknown, and broken links', () => {
    const noState = prepareRuntimeHome();
    expect(
      decidePersistentStateCompatibility(noState, currentTarget).decision,
    ).toBe('NO_STATE');

    const same = prepareRuntimeHome();
    createSchemaDatabase(same, 'workflow-runtime-schema-v11.sql');
    expect(
      decidePersistentStateCompatibility(same, currentTarget).decision,
    ).toBe('SAME_SCHEMA');

    const migration = prepareRuntimeHome();
    createSchemaDatabase(migration, 'workflow-runtime-schema-v10.sql');
    expect(
      decidePersistentStateCompatibility(migration, currentTarget).decision,
    ).toBe('MIGRATION_SUPPORTED');

    const reset = prepareRuntimeHome();
    createSchemaDatabase(reset, 'workflow-runtime-schema-v11.sql');
    const schema10Target = {
      database_schema_version: 10,
      database_schema_hash: `sha256:${'5'.repeat(64)}` as Sha256Hash,
      database_sqlite_schema_hash:
        CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
    };
    expect(
      decidePersistentStateCompatibility(reset, schema10Target, {
        format: 'icarus.workflow-runtime-schema-compatibility/1',
        target_identity: schema10Target,
        recognized_sources: [
          {
            database_schema_version: 11,
            database_sqlite_schema_hash:
              CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
            migration: 'UNSUPPORTED',
            precondition: 'NONE',
          },
        ],
      }).decision,
    ).toBe('RESET_REQUIRED');

    const unknown = prepareRuntimeHome();
    const unknownPath = createSchemaDatabase(
      unknown,
      'workflow-runtime-schema-v11.sql',
    );
    const database = new Database(unknownPath);
    database.exec('CREATE TABLE unknown_identity(value TEXT)');
    database.close();
    expect(
      decidePersistentStateCompatibility(unknown, currentTarget).decision,
    ).toBe('UNKNOWN_BLOCKED');

    const broken = prepareRuntimeHome();
    const brokenPath = path.join(broken, WORKFLOW_STATE_DATABASE_RELATIVE);
    fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
    fs.symlinkSync('missing.db', brokenPath);
    const brokenDecision = decidePersistentStateCompatibility(
      broken,
      currentTarget,
    );
    expect(brokenDecision.decision).toBe('UNKNOWN_BLOCKED');
    expect(brokenDecision.reason).toBe('persistent_state_path_invalid');
  });

  it('uses the selected frozen release migration authority in active mode', () => {
    const supportedHome = prepareRuntimeHome();
    createSchemaDatabase(supportedHome, 'workflow-runtime-schema-v10.sql');
    publishFixture(supportedHome, '5.1.0', 'frozen-supported', {
      schemaCompatibility: schema11Compatibility([
        {
          database_schema_version: 10,
          database_sqlite_schema_hash:
            CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
          migration: 'SUPPORTED',
          precondition: 'NONE',
        },
      ]),
    });
    selectFixture(supportedHome, '5.1.0');
    expect(
      inspectWorkflowState(supportedHome, 'active').decision,
    ).toMatchObject({
      decision: 'MIGRATION_SUPPORTED',
      reason: 'frozen_authoritative_migration_supported',
    });

    const unsupportedHome = prepareRuntimeHome();
    createSchemaDatabase(unsupportedHome, 'workflow-runtime-schema-v10.sql');
    expect(
      decidePersistentStateCompatibility(unsupportedHome, currentTarget)
        .decision,
    ).toBe('MIGRATION_SUPPORTED');
    publishFixture(unsupportedHome, '5.2.0', 'frozen-unsupported', {
      schemaCompatibility: schema11Compatibility([
        {
          database_schema_version: 10,
          database_sqlite_schema_hash:
            CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
          migration: 'UNSUPPORTED',
          precondition: 'NONE',
        },
      ]),
    });
    selectFixture(unsupportedHome, '5.2.0');
    expect(
      inspectWorkflowState(unsupportedHome, 'active').decision.decision,
    ).toBe('RESET_REQUIRED');

    const unknownHome = prepareRuntimeHome();
    const unknownDatabase = createSchemaDatabase(
      unknownHome,
      'workflow-runtime-schema-v10.sql',
    );
    const unknown = new Database(unknownDatabase);
    unknown.exec('CREATE TABLE release_unknown(value TEXT)');
    unknown.close();
    publishFixture(unknownHome, '5.3.0', 'frozen-unknown', {
      schemaCompatibility: schema11Compatibility([
        {
          database_schema_version: 10,
          database_sqlite_schema_hash:
            CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
          migration: 'SUPPORTED',
          precondition: 'NONE',
        },
      ]),
    });
    selectFixture(unknownHome, '5.3.0');
    expect(inspectWorkflowState(unknownHome, 'active').decision).toMatchObject({
      decision: 'UNKNOWN_BLOCKED',
      reason: 'database_schema_identity_unknown',
    });
  });

  it('refuses a running Host and requires confirmation before reset', () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '5.0.0', 'older-schema', {
      schemaVersion: 10,
    });
    selectFixture(runtimeHome, '5.0.0');
    const databasePath = createSchemaDatabase(
      runtimeHome,
      'workflow-runtime-schema-v11.sql',
    );
    expect(inspectWorkflowState(runtimeHome, 'active').decision.decision).toBe(
      'RESET_REQUIRED',
    );
    expect(() =>
      resetWorkflowState({
        projectRoot,
        runtimeHome,
        mode: 'active',
        confirmed: true,
        hostIsRunning: () => true,
      }),
    ).toThrow('workflow_state_host_running');
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(() =>
      resetWorkflowState({
        projectRoot,
        runtimeHome,
        mode: 'active',
        confirmed: false,
        hostIsRunning: () => false,
      }),
    ).toThrow('workflow_state_reset_cancelled');
    expect(fs.existsSync(databasePath)).toBe(true);
    let recoveryPath = '';
    const plan = resetWorkflowState({
      projectRoot,
      runtimeHome,
      mode: 'active',
      confirmed: true,
      hostIsRunning: () => false,
      onPlan: (candidate) => {
        recoveryPath = candidate.backup_relative_path;
      },
    });
    expect(plan.backup_relative_path).toBe(recoveryPath);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(
      readPersistentStateResetBackup(runtimeHome, recoveryPath).backup_identity,
    ).toBe(plan.backup_identity);
  });

  it('quarantines exactly DB/WAL/SHM, resumes idempotently, and preserves unrelated state', () => {
    const runtimeHome = prepareRuntimeHome();
    const members = WORKFLOW_STATE_RELATIVE_PATHS.map((relative, index) => {
      const file = path.join(runtimeHome, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `state-member-${String(index)}`);
      return {
        source_relative_path: relative,
        backup_name: path.basename(relative),
        byte_length: fs.statSync(file).size,
        raw_sha256: rawHash(file),
      };
    });
    const unrelated = [
      'credentials/token',
      'config/settings.json',
      'capacity/state',
      'registry/catalog',
      'container/state',
      'core-releases/keep/release',
    ];
    for (const relative of unrelated) {
      fs.mkdirSync(path.dirname(path.join(runtimeHome, relative)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(runtimeHome, relative), `keep:${relative}`);
    }
    const plan = buildPersistentStateResetPlan({
      decision: 'RESET_REQUIRED',
      old_identity: {
        database_schema_version: 11,
        database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
      },
      target_identity: {
        database_schema_version: 10,
        database_schema_hash: `sha256:${'5'.repeat(64)}`,
        database_sqlite_schema_hash:
          CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
      },
      affected_paths: members.map((member) =>
        path.join(runtimeHome, member.source_relative_path),
      ),
      members,
      reason: 'recognized_schema_without_supported_target_path',
    });
    const partialRoot = path.join(runtimeHome, plan.backup_relative_path);
    fs.mkdirSync(partialRoot, { recursive: true });
    writeJson(path.join(partialRoot, 'backup-manifest.json'), plan);
    fs.renameSync(
      path.join(runtimeHome, members[0]!.source_relative_path),
      path.join(partialRoot, members[0]!.backup_name),
    );
    quarantinePersistentState(runtimeHome, plan);
    quarantinePersistentState(runtimeHome, plan);
    const verified = readPersistentStateResetBackup(
      runtimeHome,
      plan.backup_relative_path,
    );
    expect(verified.backup_identity).toBe(plan.backup_identity);
    for (const member of members) {
      expect(
        fs.existsSync(path.join(runtimeHome, member.source_relative_path)),
      ).toBe(false);
      expect(
        fs.readFileSync(
          path.join(runtimeHome, plan.backup_relative_path, member.backup_name),
          'utf8',
        ),
      ).toBe(
        `state-member-${String(
          WORKFLOW_STATE_RELATIVE_PATHS.indexOf(member.source_relative_path),
        )}`,
      );
    }
    for (const relative of unrelated)
      expect(fs.readFileSync(path.join(runtimeHome, relative), 'utf8')).toBe(
        `keep:${relative}`,
      );
  });

  it('resumes an interrupted DB/WAL/SHM quarantine through the public CLI orchestration', async () => {
    const runtimeHome = prepareRuntimeHome();
    const members = WORKFLOW_STATE_RELATIVE_PATHS.map((relative, index) => {
      const file = path.join(runtimeHome, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `public-state-member-${String(index)}`);
      return {
        source_relative_path: relative,
        backup_name: path.basename(relative),
        byte_length: fs.statSync(file).size,
        raw_sha256: rawHash(file),
      };
    });
    const plan = buildPersistentStateResetPlan({
      decision: 'RESET_REQUIRED',
      old_identity: {
        database_schema_version: 11,
        database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
      },
      target_identity: {
        database_schema_version: 10,
        database_schema_hash: `sha256:${'5'.repeat(64)}`,
        database_sqlite_schema_hash:
          CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
      },
      affected_paths: members.map((member) =>
        path.join(runtimeHome, member.source_relative_path),
      ),
      members,
      reason: 'recognized_schema_without_supported_target_path',
    });
    const recoveryRoot = path.join(runtimeHome, plan.backup_relative_path);
    fs.mkdirSync(recoveryRoot, { recursive: true });
    writeJson(path.join(recoveryRoot, 'backup-manifest.json'), plan);
    fs.renameSync(
      path.join(runtimeHome, members[0]!.source_relative_path),
      path.join(recoveryRoot, members[0]!.backup_name),
    );
    const unrelated = path.join(runtimeHome, 'registry/unrelated-state');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, 'preserved');

    const output: string[] = [];
    let confirmedAfterEvidence = false;
    const status = await runWorkflowStateCli(
      ['reset', '--mode', 'active', '--runtime-home', runtimeHome],
      {
        projectRoot,
        inputIsTTY: true,
        outputIsTTY: true,
        hostIsRunning: () => false,
        output: (line) => output.push(line),
        confirm: async () => {
          confirmedAfterEvidence = output.some(
            (line) =>
              line ===
              `workflow_state_recovery_path=${path.join(runtimeHome, plan.backup_relative_path)}`,
          );
          return true;
        },
      },
    );
    expect(status).toBe(0);
    expect(confirmedAfterEvidence).toBe(true);
    expect(output).toContain('workflow_state_decision=RESET_RECOVERY');
    expect(output).toContain(
      `workflow_state_current_schema=11 ${CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema}`,
    );
    expect(
      readPersistentStateResetBackup(runtimeHome, plan.backup_relative_path),
    ).toMatchObject({ backup_identity: plan.backup_identity });
    for (const member of members) {
      expect(
        fs.existsSync(path.join(runtimeHome, member.source_relative_path)),
      ).toBe(false);
      expect(fs.existsSync(path.join(recoveryRoot, member.backup_name))).toBe(
        true,
      );
    }
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserved');
  });

  it('keeps a completed historical backup independent from a different new live generation', async () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '5.4.0', 'historical-generation', {
      schemaVersion: 10,
    });
    selectFixture(runtimeHome, '5.4.0');
    const databasePath = createSchemaDatabase(
      runtimeHome,
      'workflow-runtime-schema-v11.sql',
    );
    setDatabaseApplicationId(databasePath, 101);
    const unrelated = path.join(runtimeHome, 'registry/generation-sentinel');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, 'preserved');

    const first = prepareWorkflowStateReset(runtimeHome, 'active').plan;
    await runConfirmedWorkflowReset(runtimeHome);
    const firstRoot = path.join(runtimeHome, first.backup_relative_path);
    const firstSnapshot = backupSnapshot(firstRoot);

    createSchemaDatabase(runtimeHome, 'workflow-runtime-schema-v11.sql');
    setDatabaseApplicationId(databasePath, 202);
    expect(discoverPersistentStateResetRecovery(runtimeHome)).toBeNull();
    const second = prepareWorkflowStateReset(runtimeHome, 'active').plan;
    expect(second.backup_identity).not.toBe(first.backup_identity);
    await runConfirmedWorkflowReset(runtimeHome);

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(backupSnapshot(firstRoot)).toEqual(firstSnapshot);
    expect(
      readPersistentStateResetBackup(runtimeHome, second.backup_relative_path)
        .backup_identity,
    ).toBe(second.backup_identity);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserved');
  });

  it('deduplicates a byte-identical new live generation without mutating its completed backup', async () => {
    const runtimeHome = prepareRuntimeHome();
    publishFixture(runtimeHome, '5.5.0', 'identical-generation', {
      schemaVersion: 10,
    });
    selectFixture(runtimeHome, '5.5.0');
    const databasePath = createSchemaDatabase(
      runtimeHome,
      'workflow-runtime-schema-v11.sql',
    );
    setDatabaseApplicationId(databasePath, 303);
    const unrelated = path.join(runtimeHome, 'config/generation-sentinel');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, 'preserved');

    const first = prepareWorkflowStateReset(runtimeHome, 'active').plan;
    await runConfirmedWorkflowReset(runtimeHome);
    const firstRoot = path.join(runtimeHome, first.backup_relative_path);
    const firstSnapshot = backupSnapshot(firstRoot);
    fs.copyFileSync(
      path.join(firstRoot, first.members[0]!.backup_name),
      databasePath,
    );

    expect(discoverPersistentStateResetRecovery(runtimeHome)).toBeNull();
    const duplicate = prepareWorkflowStateReset(runtimeHome, 'active').plan;
    expect(duplicate.backup_identity).toBe(first.backup_identity);
    const output = await runConfirmedWorkflowReset(runtimeHome);

    expect(output).toContain(
      `workflow_state_backup_identity=${first.backup_identity}`,
    );
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(backupSnapshot(firstRoot)).toEqual(firstSnapshot);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserved');
  });

  it('refuses tampered and ambiguous public reset recovery evidence', async () => {
    const makePlan = (runtimeHome: string, targetHashCharacter: string) => {
      const file = path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'recovery-primary');
      const member = {
        source_relative_path: WORKFLOW_STATE_DATABASE_RELATIVE,
        backup_name: path.basename(WORKFLOW_STATE_DATABASE_RELATIVE),
        byte_length: fs.statSync(file).size,
        raw_sha256: rawHash(file),
      };
      return buildPersistentStateResetPlan({
        decision: 'RESET_REQUIRED',
        old_identity: {
          database_schema_version: 11,
          database_sqlite_schema_hash:
            CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
        },
        target_identity: {
          database_schema_version: 10,
          database_schema_hash:
            `sha256:${targetHashCharacter.repeat(64)}` as Sha256Hash,
          database_sqlite_schema_hash:
            CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema,
        },
        affected_paths: [file],
        members: [member],
        reason: 'recognized_schema_without_supported_target_path',
      });
    };
    const runReset = (runtimeHome: string, confirm: () => Promise<boolean>) =>
      runWorkflowStateCli(
        ['reset', '--mode', 'current', '--runtime-home', runtimeHome],
        {
          projectRoot,
          inputIsTTY: true,
          outputIsTTY: true,
          hostIsRunning: () => false,
          confirm,
          output: () => undefined,
        },
      );

    const tamperedHome = prepareRuntimeHome();
    const tamperedPlan = makePlan(tamperedHome, '6');
    const tamperedRoot = path.join(
      tamperedHome,
      tamperedPlan.backup_relative_path,
    );
    fs.mkdirSync(tamperedRoot, { recursive: true });
    writeJson(path.join(tamperedRoot, 'backup-manifest.json'), tamperedPlan);
    fs.renameSync(
      path.join(tamperedHome, WORKFLOW_STATE_DATABASE_RELATIVE),
      path.join(tamperedRoot, tamperedPlan.members[0]!.backup_name),
    );
    fs.appendFileSync(
      path.join(tamperedRoot, tamperedPlan.members[0]!.backup_name),
      'tampered',
    );
    let tamperedConfirmed = false;
    await expect(
      runReset(tamperedHome, async () => {
        tamperedConfirmed = true;
        return true;
      }),
    ).rejects.toThrow('host_core_state_backup_recovery_member_invalid');
    expect(tamperedConfirmed).toBe(false);

    const ambiguousHome = prepareRuntimeHome();
    const first = makePlan(ambiguousHome, '7');
    const second = makePlan(ambiguousHome, '8');
    const source = path.join(ambiguousHome, WORKFLOW_STATE_DATABASE_RELATIVE);
    for (const plan of [first, second]) {
      const root = path.join(ambiguousHome, plan.backup_relative_path);
      fs.mkdirSync(root, { recursive: true });
      writeJson(path.join(root, 'backup-manifest.json'), plan);
      fs.copyFileSync(source, path.join(root, plan.members[0]!.backup_name));
    }
    fs.unlinkSync(source);
    let ambiguousConfirmed = false;
    await expect(
      runReset(ambiguousHome, async () => {
        ambiguousConfirmed = true;
        return true;
      }),
    ).rejects.toThrow('host_core_state_backup_recovery_ambiguous');
    expect(ambiguousConfirmed).toBe(false);
  });

  it('keeps formal production identity independent of deployment pointers', () => {
    const source = fs.readFileSync(
      path.join(
        projectRoot,
        'src/workflow-runtime/store/runtime-store/identity.ts',
      ),
      'utf8',
    );
    const formal = source.slice(
      source.indexOf('export function verifyFormalHostCoreProductionIdentity'),
      source.indexOf('export function currentRuntimeHostObservation'),
    );
    expect(formal).toContain('verifyActiveHostCore(runtimeHome)');
    expect(formal).not.toContain('active-deployment');
    expect(formal).not.toContain('verifyActiveHostCoreDeployment');
  });
});
