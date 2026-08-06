import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const toolchain = path.join(projectRoot, 'scripts', 'runtime-toolchain.sh');
const setupScript = path.join(projectRoot, 'setup.sh');
const hostLauncher = path.join(projectRoot, 'local', 'shell', 'launch-host.sh');
const temporaryRoots: string[] = [];

interface FakeNodeOptions {
  major?: number;
  abi?: string;
  platform?: string;
  arch?: string;
  version?: string;
  nativeSmoke?: boolean;
  label?: string;
}

function temporaryRoot(prefix = 'icarus-node-compat-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writeExecutable(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fakeNode(options: FakeNodeOptions = {}): string {
  const root = temporaryRoot('icarus-fake-node-');
  const node = path.join(root, 'bin', 'node');
  const major = options.major ?? 26;
  const abi = options.abi ?? process.versions.modules;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = options.version ?? `${String(major)}.1.0`;
  const label = options.label ?? version;
  writeExecutable(
    node,
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "--eval" ]; then
  if [[ "\${2:-}" == *"better-sqlite3"* ]]; then
    exit ${options.nativeSmoke === false ? '9' : '0'}
  fi
  printf '${String(major)}|${abi}|${platform}|${arch}'
  exit 0
fi
if [ "\${1:-}" = "--version" ]; then
  printf 'v${version}\\n'
  exit 0
fi
printf 'configured-node=${label}'
for argument in "$@"; do printf '|%s' "$argument"; done
printf '\\n'
`,
  );
  for (const command of ['npm', 'npx'])
    writeExecutable(
      path.join(root, 'bin', command),
      `#!/bin/bash
printf 'configured-${command}=${label}'
for argument in "$@"; do printf '|%s' "$argument"; done
printf '\\n'
`,
    );
  return node;
}

function runToolchain(
  runtimeHome: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(toolchain, ['--runtime-home', runtimeHome, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function expectFailure(
  result: ReturnType<typeof runToolchain>,
  code: string,
): void {
  expect(result.status, result.stderr).toBe(78);
  expect(result.stderr).toContain(`icarus-toolchain:${code}`);
}

function sha256(file: string): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function createInstallerArchive(
  options: {
    unsafeSymlink?: boolean;
    unsafeTraversal?: boolean;
  } = {},
): string {
  const root = temporaryRoot('icarus-node-installer-');
  const source = path.join(root, 'source');
  const distributionName = 'node-v26.5.0-darwin-arm64';
  const distribution = path.join(source, distributionName);
  const fixtureNode = fakeNode({ version: '26.5.0', label: 'installer' });
  fs.mkdirSync(path.join(distribution, 'bin'), { recursive: true });
  for (const command of ['node', 'npm', 'npx'])
    fs.copyFileSync(
      path.join(path.dirname(fixtureNode), command),
      path.join(distribution, 'bin', command),
      fs.constants.COPYFILE_FICLONE,
    );
  for (const command of ['node', 'npm', 'npx'])
    fs.chmodSync(path.join(distribution, 'bin', command), 0o755);
  if (options.unsafeSymlink)
    fs.symlinkSync('../../../../tmp', path.join(distribution, 'escape'));
  if (options.unsafeTraversal) {
    const outside = path.join(source, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'entry'), 'unsafe\n');
  }
  const archive = path.join(root, `${distributionName}.tar.gz`);
  const entry = options.unsafeTraversal
    ? `${distributionName}/../outside`
    : distributionName;
  const result = spawnSync('tar', ['-czf', archive, '-C', source, entry], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return archive;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Node runtime compatibility resolver', () => {
  it('accepts different patches in supported major and refreshes the configured path', () => {
    const runtimeHome = temporaryRoot();
    const first = fakeNode({ version: '26.1.0', label: 'first' });
    const second = fakeNode({ version: '26.9.9', label: 'second' });
    expect(
      runToolchain(runtimeHome, ['configure', '--node', first]).status,
    ).toBe(0);
    expect(
      runToolchain(runtimeHome, ['configure', '--node', second]).status,
    ).toBe(0);
    const verify = runToolchain(runtimeHome, ['verify']);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain(`node_path=${fs.realpathSync(second)}`);

    const config = JSON.parse(
      fs.readFileSync(
        path.join(runtimeHome, 'toolchains', 'node', 'runtime.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual([
      'arch',
      'format',
      'modules_abi',
      'node_major',
      'node_path',
      'platform',
    ]);
    expect(JSON.stringify(config)).not.toMatch(/hash|distribution|active-node/);
    expect(
      fs.existsSync(
        path.join(runtimeHome, 'toolchains', 'node', 'active-node'),
      ),
    ).toBe(false);
  });

  it('rejects an unsupported major, platform, and architecture', () => {
    for (const [node, code] of [
      [fakeNode({ major: 25 }), 'node_major_unsupported'],
      [fakeNode({ platform: 'linux' }), 'node_platform_incompatible'],
      [fakeNode({ arch: 'x64' }), 'node_arch_incompatible'],
    ] as const)
      expectFailure(
        runToolchain(temporaryRoot(), ['configure', '--node', node]),
        code,
      );
  });

  it('rejects ABI drift and reports native module rebuild guidance', () => {
    const abiHome = temporaryRoot();
    const compatible = fakeNode();
    expect(
      runToolchain(abiHome, ['configure', '--node', compatible]).status,
    ).toBe(0);
    const configPath = path.join(abiHome, 'toolchains', 'node', 'runtime.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.modules_abi = '999';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expectFailure(
      runToolchain(abiHome, ['verify']),
      'configured_node_abi_mismatch',
    );

    const smokeHome = temporaryRoot();
    const brokenNative = fakeNode({ nativeSmoke: false });
    expect(
      runToolchain(smokeHome, ['configure', '--node', brokenNative]).status,
    ).toBe(0);
    const smoke = runToolchain(smokeHome, ['verify']);
    expectFailure(smoke, 'native_module_incompatible');
    expect(smoke.stderr).toContain('npm rebuild better-sqlite3 or npm ci');
  });

  it('reports a removed configured Node parent as a compatibility failure', () => {
    const runtimeHome = temporaryRoot();
    const configured = fakeNode();
    expect(
      runToolchain(runtimeHome, ['configure', '--node', configured]).status,
    ).toBe(0);

    fs.rmSync(path.dirname(path.dirname(configured)), {
      recursive: true,
      force: true,
    });
    expectFailure(
      runToolchain(runtimeHome, ['verify']),
      'node_executable_missing',
    );
  });

  it('runs npm ci before checkout native-module verification is possible', () => {
    const runtimeHome = temporaryRoot();
    const configured = fakeNode({ nativeSmoke: false, label: 'fresh' });
    expect(
      runToolchain(runtimeHome, ['configure', '--node', configured]).status,
    ).toBe(0);

    const install = runToolchain(runtimeHome, ['npm-ci']);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain('configured-npm=fresh|ci');
    expectFailure(
      runToolchain(runtimeHome, ['verify']),
      'native_module_incompatible',
    );
  });

  it('uses only the configured absolute path for node, npm, and npx', () => {
    const runtimeHome = temporaryRoot();
    const configured = fakeNode({ label: 'trusted' });
    const maliciousRoot = temporaryRoot('icarus-malicious-path-');
    for (const command of ['node', 'npm', 'npx'])
      writeExecutable(
        path.join(maliciousRoot, command),
        '#!/bin/bash\nprintf "malicious\\n"\n',
      );
    expect(
      runToolchain(runtimeHome, ['configure', '--node', configured]).status,
    ).toBe(0);
    for (const command of ['node', 'npm', 'npx']) {
      const result = runToolchain(
        runtimeHome,
        ['exec', '--', command, 'probe'],
        { PATH: `${maliciousRoot}:${process.env.PATH ?? ''}` },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`configured-${command}=trusted|probe`);
      expect(result.stdout).not.toContain('malicious');
    }
  });

  it('rejects toolchain directory symlinks outside the runtime home', () => {
    const runtimeHome = temporaryRoot();
    const outside = temporaryRoot('icarus-toolchain-outside-');
    fs.symlinkSync(outside, path.join(runtimeHome, 'toolchains'));

    expectFailure(
      runToolchain(runtimeHome, [
        'configure',
        '--node',
        fakeNode({ label: 'compatible' }),
      ]),
      'runtime_path_unsafe',
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('runs a real better-sqlite3 query under the configured current Node', () => {
    const runtimeHome = temporaryRoot();
    const configure = runToolchain(runtimeHome, [
      'configure',
      '--node',
      process.execPath,
    ]);
    expect(configure.status, configure.stderr).toBe(0);
    const verify = runToolchain(runtimeHome, ['verify']);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain(
      `node_modules_abi=${process.versions.modules}`,
    );
  });

  it('keeps installer checksum, traversal, and unsafe-link checks without distribution identity', () => {
    const valid = createInstallerArchive();
    const validHome = temporaryRoot();
    const installed = runToolchain(validHome, [
      'install',
      '--archive',
      valid,
      '--checksum',
      sha256(valid),
    ]);
    expect(installed.status, installed.stderr).toBe(0);
    expect(
      fs.existsSync(path.join(validHome, 'toolchains', 'node', 'runtime.json')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          validHome,
          'toolchains',
          'node',
          'managed',
          'v26.5.0-darwin-arm64.install-lock',
        ),
      ),
    ).toBe(false);

    expectFailure(
      runToolchain(temporaryRoot(), [
        'install',
        '--archive',
        valid,
        '--checksum',
        `sha256:${'0'.repeat(64)}`,
      ]),
      'archive_checksum_mismatch',
    );
    for (const [archive, code] of [
      [createInstallerArchive({ unsafeSymlink: true }), 'archive_unsafe_link'],
      [
        createInstallerArchive({ unsafeTraversal: true }),
        'archive_unsafe_entry',
      ],
    ] as const)
      expectFailure(
        runToolchain(temporaryRoot(), [
          'install',
          '--archive',
          archive,
          '--checksum',
          sha256(archive),
        ]),
        code,
      );
  });

  it('does not remove an installer lock owned by another process', () => {
    const runtimeHome = temporaryRoot();
    const archive = createInstallerArchive();
    const lock = path.join(
      runtimeHome,
      'toolchains',
      'node',
      'managed',
      'v26.5.0-darwin-arm64.install-lock',
    );
    fs.mkdirSync(lock, { recursive: true });

    expectFailure(
      runToolchain(runtimeHome, [
        'install',
        '--archive',
        archive,
        '--checksum',
        sha256(archive),
      ]),
      'install_lock_busy',
    );
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  it('boots an active snapshot without checkout dependencies or TypeScript tooling', () => {
    const checkout = temporaryRoot('icarus-active-checkout-');
    const runtimeHome = temporaryRoot('icarus-active-runtime-');
    const copiedToolchain = path.join(
      checkout,
      'scripts',
      'runtime-toolchain.sh',
    );
    const copiedLauncher = path.join(
      checkout,
      'local',
      'shell',
      'launch-host.sh',
    );
    fs.mkdirSync(path.dirname(copiedToolchain), { recursive: true });
    fs.mkdirSync(path.dirname(copiedLauncher), { recursive: true });
    fs.copyFileSync(toolchain, copiedToolchain);
    fs.copyFileSync(
      path.join(projectRoot, 'local', 'shell', 'common.sh'),
      path.join(checkout, 'local', 'shell', 'common.sh'),
    );
    fs.copyFileSync(hostLauncher, copiedLauncher);
    fs.chmodSync(copiedToolchain, 0o755);
    fs.chmodSync(copiedLauncher, 0o755);

    const configure = spawnSync(
      copiedToolchain,
      ['--runtime-home', runtimeHome, 'configure', '--node', process.execPath],
      { cwd: checkout, encoding: 'utf8' },
    );
    expect(configure.status, configure.stderr).toBe(0);

    const snapshotId = '20260805T120000Z-abcdef12-1234abcd';
    const snapshotRoot = path.join(
      runtimeHome,
      'host-core-snapshots',
      snapshotId,
    );
    const entry = path.join(snapshotRoot, 'dist', 'index.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "console.log('active-snapshot-started');\n");
    fs.writeFileSync(
      path.join(snapshotRoot, 'package.json'),
      '{"type":"module"}\n',
    );
    const sqlitePackage = path.join(
      snapshotRoot,
      'node_modules',
      'better-sqlite3',
    );
    fs.mkdirSync(sqlitePackage, { recursive: true });
    fs.writeFileSync(
      path.join(sqlitePackage, 'package.json'),
      '{"main":"index.cjs"}\n',
    );
    fs.writeFileSync(
      path.join(sqlitePackage, 'index.cjs'),
      `module.exports = class Database {
  prepare() { return { get() { return { value: 1 }; } }; }
  close() {}
};
`,
    );
    fs.writeFileSync(
      path.join(snapshotRoot, 'snapshot.json'),
      `${JSON.stringify(
        {
          format: 'icarus.host-core-snapshot/1',
          snapshot_id: snapshotId,
          label: 'test',
          created_at: '2026-08-05T12:00:00.000Z',
          git: { commit: 'a'.repeat(40), dirty: true },
          entry_relative_path: 'dist/index.js',
          entry_sha256: sha256(entry),
          workflow_schema: {
            current_version: 13,
            minimum_supported_version: 10,
          },
          node: {
            major: Number(process.versions.node.split('.')[0]),
            modules_abi: process.versions.modules,
            platform: process.platform,
            arch: process.arch,
          },
          validation: 'smoke_passed',
        },
        null,
        2,
      )}\n`,
    );
    fs.symlinkSync(
      `host-core-snapshots/${snapshotId}`,
      path.join(runtimeHome, 'active-core'),
    );

    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false);
    const verify = spawnSync(
      copiedToolchain,
      ['--runtime-home', runtimeHome, 'verify-active'],
      {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...process.env, ICARUS_RUNTIME_HOME: runtimeHome },
      },
    );
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toBe('');

    const launch = spawnSync(copiedLauncher, ['--mode', 'active'], {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, ICARUS_RUNTIME_HOME: runtimeHome },
    });
    expect(launch.status, launch.stderr).toBe(0);
    expect(launch.stdout).toContain('active-snapshot-started');

    const checkoutSqlite = path.join(
      checkout,
      'node_modules',
      'better-sqlite3',
    );
    fs.mkdirSync(checkoutSqlite, { recursive: true });
    fs.writeFileSync(
      path.join(checkoutSqlite, 'package.json'),
      '{"main":"index.cjs"}\n',
    );
    fs.writeFileSync(
      path.join(checkoutSqlite, 'index.cjs'),
      "throw new Error('checkout better-sqlite3 must not load');\n",
    );
    writeExecutable(
      path.join(checkout, 'node_modules', '.bin', 'tsx'),
      '#!/bin/bash\nexit 99\n',
    );
    const launchWithBrokenCheckout = spawnSync(
      copiedLauncher,
      ['--mode', 'active'],
      {
        cwd: checkout,
        encoding: 'utf8',
        env: { ...process.env, ICARUS_RUNTIME_HOME: runtimeHome },
      },
    );
    expect(
      launchWithBrokenCheckout.status,
      launchWithBrokenCheckout.stderr,
    ).toBe(0);
    expect(launchWithBrokenCheckout.stdout).toContain(
      'active-snapshot-started',
    );
    const launcherSource = fs.readFileSync(copiedLauncher, 'utf8');
    expect(launcherSource).not.toMatch(/\bnpx\b|\btsx\b/);
    const commonSource = fs.readFileSync(
      path.join(checkout, 'local', 'shell', 'common.sh'),
      'utf8',
    );
    expect(commonSource).toContain('verify-active');
    expect(commonSource).not.toMatch(/verify-active[\s\S]{0,80}\bnpx\b/);
  });

  it('runs fresh setup in configure, npm-ci, verify order without identity checks', () => {
    const checkout = temporaryRoot('icarus-fresh-setup-');
    const copiedSetup = path.join(checkout, 'setup.sh');
    const fakeToolchain = path.join(
      checkout,
      'scripts',
      'runtime-toolchain.sh',
    );
    const calls = path.join(checkout, 'toolchain-calls.log');
    fs.copyFileSync(setupScript, copiedSetup);
    fs.chmodSync(copiedSetup, 0o755);
    writeExecutable(
      fakeToolchain,
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ICARUS_SETUP_TEST_CALLS"
case "\${1:-}" in
  configure) printf 'node_path=/fixture/node\\n' ;;
  npm-ci) ;;
  verify)
    printf '%s\\n' \\
      'node_path=/fixture/node' \\
      'node_major=26' \\
      'node_modules_abi=${process.versions.modules}' \\
      'node_platform=${process.platform}' \\
      'node_arch=${process.arch}'
    ;;
  exec)
    case "\${3:-}" in
      node) printf 'v26.5.0\\n' ;;
      npm) printf '11.17.0\\n' ;;
    esac
    ;;
  *) exit 64 ;;
esac
`,
    );

    const setup = spawnSync(copiedSetup, [], {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, ICARUS_SETUP_TEST_CALLS: calls },
    });
    expect(setup.status, setup.stderr).toBe(0);
    expect(setup.stdout).toContain('STATUS: success');
    expect(setup.stdout).not.toContain('SYSTEM_IDENTITY');
    expect(fs.existsSync(path.join(checkout, 'node_modules'))).toBe(false);
    const commands = fs.readFileSync(calls, 'utf8').trim().split('\n');
    expect(commands[0]).toMatch(/^configure --node \/.+/);
    expect(commands.slice(1)).toEqual([
      'npm-ci',
      'verify',
      'exec -- node --version',
      'exec -- npm --version',
    ]);
    const source = fs.readFileSync(copiedSetup, 'utf8');
    expect(source).not.toContain('active-path');
    expect(source).not.toMatch(/SYSTEM_.*IDENTITY|identity unchanged/i);
  });
});
