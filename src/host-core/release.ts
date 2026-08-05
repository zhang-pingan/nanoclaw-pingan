import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
} from '../workflow-runtime/gateway/host-core.js';

export const HOST_CORE_SNAPSHOT_DIRECTORY = 'host-core-snapshots';
export const HOST_CORE_SNAPSHOT_FILENAME = 'snapshot.json';
export const HOST_CORE_ENTRY = 'dist/index.js';
export const HOST_CORE_SUPPORTED_NODE_MAJOR = 26;
export const HOST_CORE_VALIDATION_COMMANDS = [
  'test:current',
  'contracts:check',
  'typecheck',
  'format:check',
] as const;

export type HostCoreSnapshotValidation =
  | 'smoke_passed'
  | 'full_passed'
  | 'skipped_by_user';

export interface HostCoreSnapshotManifest {
  readonly format: 'icarus.host-core-snapshot/1';
  readonly snapshot_id: string;
  readonly label: string | null;
  readonly created_at: string;
  readonly git: {
    readonly commit: string;
    readonly dirty: boolean;
  };
  readonly entry_relative_path: typeof HOST_CORE_ENTRY;
  readonly entry_sha256: string;
  readonly workflow_schema: {
    readonly current_version: number;
    readonly minimum_supported_version: number;
  };
  readonly node: {
    readonly major: number;
    readonly modules_abi: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly validation: HostCoreSnapshotValidation;
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error(`${label}_keyset_invalid`);
}

function assertObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}_invalid`);
}

export function assertHostCoreSnapshotId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{8}T\d{6}Z-[0-9a-f]{7,12}-[0-9a-f]{8}$/.test(value)
  )
    throw new Error('host_core_snapshot_id_invalid');
  return value;
}

function assertLabel(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 80 ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(value)
  )
    throw new Error('host_core_snapshot_label_invalid');
  return value;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error(`${label}_invalid`);
  return Number(value);
}

function sha256(file: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}_invalid`);
}

function ensureDirectory(root: string, relative: string): string {
  let directory = root;
  for (const part of relative.split('/')) {
    directory = path.join(directory, part);
    const existing = lstatIfPresent(directory);
    if (!existing) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('host_core_snapshot_directory_invalid');
  }
  return directory;
}

function safeSnapshotRoot(runtimeHome: string, snapshotId: string): string {
  const snapshotsRoot = path.join(runtimeHome, HOST_CORE_SNAPSHOT_DIRECTORY);
  const root = path.join(snapshotsRoot, assertHostCoreSnapshotId(snapshotId));
  const relative = path.relative(snapshotsRoot, root);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new Error('host_core_snapshot_path_invalid');
  return root;
}

function copyTree(source: string, target: string): void {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error('host_core_snapshot_source_invalid');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink())
      throw new Error(`host_core_snapshot_symlink_rejected:${from}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
    else throw new Error(`host_core_snapshot_non_regular_file:${from}`);
  }
}

function copyRuntimeAssets(projectRoot: string, snapshotRoot: string): void {
  const workflowRoot = path.join(projectRoot, 'src', 'workflow-runtime');
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile() && /\.(?:json|sql)$/.test(entry.name)) {
        const relative = path.relative(workflowRoot, source);
        const target = path.join(
          snapshotRoot,
          'dist',
          'workflow-runtime',
          relative,
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
  };
  visit(workflowRoot);
  const configRoot = path.join(projectRoot, 'config');
  if (fs.existsSync(configRoot))
    copyTree(configRoot, path.join(snapshotRoot, 'config'));
}

function findPackageJson(entry: string): string {
  let directory = path.dirname(entry);
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`host_core_dependency_manifest_missing:${entry}`);
    directory = parent;
  }
}

function dependencyPackages(
  projectRoot: string,
  rootDependencies?: readonly string[],
): string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const queue = (
    rootDependencies ?? Object.keys(packageJson.dependencies ?? {})
  ).map((dependency) => ({
    importer: path.join(projectRoot, 'package.json'),
    dependency,
    required: true,
  }));
  const packages = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    let packageFile: string | null = null;
    try {
      const resolve = createRequire(current.importer).resolve;
      try {
        packageFile = resolve(`${current.dependency}/package.json`);
      } catch {
        packageFile = findPackageJson(resolve(current.dependency));
      }
    } catch {
      if (current.required)
        throw new Error(
          `host_core_required_dependency_missing:${current.dependency}`,
        );
    }
    if (!packageFile) continue;
    const packageRoot = fs.realpathSync(path.dirname(packageFile));
    const dependenciesRoot = fs.realpathSync(
      path.join(projectRoot, 'node_modules'),
    );
    const relative = path.relative(dependenciesRoot, packageRoot);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('host_core_dependency_outside_project');
    if (packages.has(packageRoot)) continue;
    packages.add(packageRoot);
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ importer: packageFile, dependency, required: true });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ importer: packageFile, dependency, required: false });
  }
  return [...packages].sort();
}

function nodeDescriptor(): HostCoreSnapshotManifest['node'] {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major) || major < 1 || !process.versions.modules)
    throw new Error('host_core_node_runtime_invalid');
  if (major !== HOST_CORE_SUPPORTED_NODE_MAJOR)
    throw new Error(
      `host_core_node_major_unsupported:supported=${HOST_CORE_SUPPORTED_NODE_MAJOR}:actual=${major}`,
    );
  return {
    major,
    modules_abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

function nativeModuleSmoke(snapshotRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      `const { createRequire } = require('node:module');
const path = require('node:path');
const snapshotRequire = createRequire(path.join(process.env.ICARUS_SNAPSHOT_ROOT, 'package.json'));
const Database = snapshotRequire('better-sqlite3');
const database = new Database(':memory:');
try {
  const row = database.prepare('SELECT 1 AS value').get();
  if (!row || row.value !== 1) process.exit(2);
} finally {
  database.close();
}`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ICARUS_SNAPSHOT_ROOT: snapshotRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0)
    throw new Error(
      'host_core_native_module_incompatible:better-sqlite3 missing or incompatible; recreate the snapshot after npm ci',
    );
}

function entrySmoke(entry: string): void {
  const result = spawnSync(process.execPath, ['--check', entry], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0)
    throw new Error(
      `host_core_snapshot_entry_smoke_failed:${result.stderr.trim()}`,
    );
  nativeModuleSmoke(path.dirname(path.dirname(entry)));
}

export function parseHostCoreSnapshotManifest(
  value: unknown,
): HostCoreSnapshotManifest {
  assertObject(value, 'host_core_snapshot_manifest');
  exactKeys(
    value,
    [
      'created_at',
      'entry_relative_path',
      'entry_sha256',
      'format',
      'git',
      'label',
      'node',
      'snapshot_id',
      'validation',
      'workflow_schema',
    ],
    'host_core_snapshot_manifest',
  );
  assertObject(value.git, 'host_core_snapshot_git');
  assertObject(value.node, 'host_core_snapshot_node');
  assertObject(value.workflow_schema, 'host_core_snapshot_schema');
  exactKeys(value.git, ['commit', 'dirty'], 'host_core_snapshot_git');
  exactKeys(
    value.node,
    ['arch', 'major', 'modules_abi', 'platform'],
    'host_core_snapshot_node',
  );
  exactKeys(
    value.workflow_schema,
    ['current_version', 'minimum_supported_version'],
    'host_core_snapshot_schema',
  );
  const createdAt = new Date(String(value.created_at));
  const validation = value.validation;
  if (
    value.format !== 'icarus.host-core-snapshot/1' ||
    Number.isNaN(createdAt.valueOf()) ||
    createdAt.toISOString() !== value.created_at ||
    typeof value.git.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.git.commit) ||
    typeof value.git.dirty !== 'boolean' ||
    value.entry_relative_path !== HOST_CORE_ENTRY ||
    typeof value.entry_sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.entry_sha256) ||
    typeof value.node.modules_abi !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.node.modules_abi) ||
    typeof value.node.platform !== 'string' ||
    typeof value.node.arch !== 'string' ||
    (validation !== 'smoke_passed' &&
      validation !== 'full_passed' &&
      validation !== 'skipped_by_user')
  )
    throw new Error('host_core_snapshot_manifest_invalid');
  const currentVersion = assertPositiveInteger(
    value.workflow_schema.current_version,
    'host_core_snapshot_schema_current_version',
  );
  const minimumVersion = assertPositiveInteger(
    value.workflow_schema.minimum_supported_version,
    'host_core_snapshot_schema_minimum_version',
  );
  if (minimumVersion > currentVersion)
    throw new Error('host_core_snapshot_schema_range_invalid');
  return {
    format: 'icarus.host-core-snapshot/1',
    snapshot_id: assertHostCoreSnapshotId(value.snapshot_id),
    label: assertLabel(value.label),
    created_at: createdAt.toISOString(),
    git: { commit: value.git.commit, dirty: value.git.dirty },
    entry_relative_path: HOST_CORE_ENTRY,
    entry_sha256: value.entry_sha256,
    workflow_schema: {
      current_version: currentVersion,
      minimum_supported_version: minimumVersion,
    },
    node: {
      major: assertPositiveInteger(
        value.node.major,
        'host_core_snapshot_node_major',
      ),
      modules_abi: value.node.modules_abi,
      platform: value.node.platform as NodeJS.Platform,
      arch: value.node.arch,
    },
    validation,
  };
}

export function verifyHostCoreSnapshot(
  runtimeHomeInput: string,
  snapshotIdInput: string,
): HostCoreSnapshotManifest {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const snapshotId = assertHostCoreSnapshotId(snapshotIdInput);
  const root = safeSnapshotRoot(runtimeHome, snapshotId);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_snapshot_directory_invalid');
  const manifestFile = path.join(root, HOST_CORE_SNAPSHOT_FILENAME);
  assertRegularFile(manifestFile, 'host_core_snapshot_manifest');
  const manifest = parseHostCoreSnapshotManifest(
    JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
  );
  if (manifest.snapshot_id !== snapshotId)
    throw new Error('host_core_snapshot_path_mismatch');
  const entry = path.join(root, manifest.entry_relative_path);
  assertRegularFile(entry, 'host_core_snapshot_entry');
  if (sha256(entry) !== manifest.entry_sha256)
    throw new Error('host_core_snapshot_entry_checksum_mismatch');
  if (
    manifest.workflow_schema.current_version !==
      CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION ||
    manifest.workflow_schema.minimum_supported_version !==
      MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION
  )
    throw new Error('host_core_snapshot_schema_incompatible');
  const currentNode = nodeDescriptor();
  if (
    manifest.node.major !== currentNode.major ||
    manifest.node.modules_abi !== currentNode.modules_abi ||
    manifest.node.platform !== currentNode.platform ||
    manifest.node.arch !== currentNode.arch
  )
    throw new Error('host_core_snapshot_node_incompatible');
  entrySmoke(entry);
  return manifest;
}

function gitState(projectRoot: string): { commit: string; dirty: boolean } {
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (
    commitResult.status !== 0 ||
    !/^[0-9a-f]{40}\n?$/.test(commitResult.stdout)
  )
    throw new Error('host_core_snapshot_git_commit_unavailable');
  const dirtyResult = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (dirtyResult.status !== 0)
    throw new Error('host_core_snapshot_git_status_unavailable');
  return {
    commit: commitResult.stdout.trim(),
    dirty: dirtyResult.stdout.length > 0,
  };
}

function snapshotId(createdAt: string, commit: string): string {
  const timestamp = `${createdAt.replaceAll('-', '').replaceAll(':', '').slice(0, 15)}Z`;
  return `${timestamp}-${commit.slice(0, 8)}-${crypto.randomBytes(4).toString('hex')}`;
}

function runNpmScripts(projectRoot: string): void {
  const npmCli = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  for (const script of HOST_CORE_VALIDATION_COMMANDS) {
    const result = spawnSync(process.execPath, [npmCli, 'run', script], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0)
      throw new Error(`host_core_snapshot_validation_failed:${script}`);
  }
}

export function buildHostCoreDist(
  projectRootInput: string,
  distRoot: string,
): void {
  const projectRoot = fs.realpathSync(projectRootInput);
  const tsc = path.join(projectRoot, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      '--project',
      path.join(projectRoot, 'tsconfig.json'),
      '--outDir',
      distRoot,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('host_core_snapshot_build_failed');
}

export interface InstallHostCoreSnapshotOptions {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly distRoot: string;
  readonly label?: string;
  readonly validation?: HostCoreSnapshotValidation;
  readonly commit?: string;
  readonly dirty?: boolean;
  readonly includeDependencies?: boolean;
  readonly includeRuntimeAssets?: boolean;
  readonly createdAt?: string;
}

export function installHostCoreSnapshotFromDist(
  options: InstallHostCoreSnapshotOptions,
): HostCoreSnapshotManifest {
  const projectRoot = fs.realpathSync(options.projectRoot);
  fs.mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const distRoot = fs.realpathSync(options.distRoot);
  const source =
    options.commit === undefined
      ? gitState(projectRoot)
      : {
          commit: options.commit,
          dirty: options.dirty ?? false,
        };
  if (!/^[0-9a-f]{40}$/.test(source.commit))
    throw new Error('host_core_snapshot_git_commit_invalid');
  const createdAt = options.createdAt ?? new Date().toISOString();
  const id = snapshotId(createdAt, source.commit);
  const snapshotsRoot = ensureDirectory(
    runtimeHome,
    HOST_CORE_SNAPSHOT_DIRECTORY,
  );
  const stage = fs.mkdtempSync(path.join(snapshotsRoot, '.snapshot-'));
  const destination = safeSnapshotRoot(runtimeHome, id);
  try {
    copyTree(distRoot, path.join(stage, 'dist'));
    if (options.includeRuntimeAssets !== false)
      copyRuntimeAssets(projectRoot, stage);
    const dependencyRoots =
      options.includeDependencies === false ? ['better-sqlite3'] : undefined;
    for (const packageRoot of dependencyPackages(
      projectRoot,
      dependencyRoots,
    )) {
      const relative = path.relative(projectRoot, packageRoot);
      copyTree(packageRoot, path.join(stage, relative));
    }
    fs.copyFileSync(
      path.join(projectRoot, 'package.json'),
      path.join(stage, 'package.json'),
    );
    const entry = path.join(stage, HOST_CORE_ENTRY);
    assertRegularFile(entry, 'host_core_snapshot_entry');
    entrySmoke(entry);
    const manifest: HostCoreSnapshotManifest = {
      format: 'icarus.host-core-snapshot/1',
      snapshot_id: id,
      label: assertLabel(options.label ?? null),
      created_at: new Date(createdAt).toISOString(),
      git: source,
      entry_relative_path: HOST_CORE_ENTRY,
      entry_sha256: sha256(entry),
      workflow_schema: {
        current_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
        minimum_supported_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      },
      node: nodeDescriptor(),
      validation: options.validation ?? 'smoke_passed',
    };
    fs.writeFileSync(
      path.join(stage, HOST_CORE_SNAPSHOT_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(stage, destination);
    return verifyHostCoreSnapshot(runtimeHome, id);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function createHostCoreSnapshot(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly label?: string;
  readonly fullCheck?: boolean;
  readonly skipValidation?: boolean;
}): HostCoreSnapshotManifest {
  const projectRoot = fs.realpathSync(options.projectRoot);
  const source = gitState(projectRoot);
  if (options.fullCheck) runNpmScripts(projectRoot);
  const buildRoot = fs.mkdtempSync('/private/tmp/icarus-host-core-snapshot-');
  try {
    const distRoot = path.join(buildRoot, 'dist');
    buildHostCoreDist(projectRoot, distRoot);
    return installHostCoreSnapshotFromDist({
      projectRoot,
      runtimeHome: options.runtimeHome,
      distRoot,
      label: options.label,
      validation: options.skipValidation
        ? 'skipped_by_user'
        : options.fullCheck
          ? 'full_passed'
          : 'smoke_passed',
      commit: source.commit,
      dirty: source.dirty,
    });
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

export function listHostCoreSnapshots(
  runtimeHomeInput: string,
): HostCoreSnapshotManifest[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const root = path.join(runtimeHome, HOST_CORE_SNAPSHOT_DIRECTORY);
  const stat = lstatIfPresent(root);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_snapshot_directory_invalid');
  return fs
    .readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .map((name) => verifyHostCoreSnapshot(runtimeHome, name))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function findHostCoreSnapshotByLabel(
  runtimeHome: string,
  label: string,
): HostCoreSnapshotManifest {
  const matches = listHostCoreSnapshots(runtimeHome).filter(
    (snapshot) => snapshot.label === label,
  );
  const snapshot = matches.at(-1);
  if (!snapshot) throw new Error('host_core_snapshot_label_not_found');
  return snapshot;
}

export function removeHostCoreSnapshot(
  runtimeHomeInput: string,
  snapshotIdInput: string,
): void {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const snapshotId = assertHostCoreSnapshotId(snapshotIdInput);
  const root = safeSnapshotRoot(runtimeHome, snapshotId);
  verifyHostCoreSnapshot(runtimeHome, snapshotId);
  const active = path.join(runtimeHome, 'active-core');
  const activeStat = lstatIfPresent(active);
  if (activeStat) {
    if (!activeStat.isSymbolicLink())
      throw new Error('active_core_pointer_invalid');
    const target = path.resolve(runtimeHome, fs.readlinkSync(active));
    if (target === root) throw new Error('host_core_snapshot_active');
  }
  fs.rmSync(root, { recursive: true });
}

// One-cycle compatibility alias. New callers should use createHostCoreSnapshot.
export function publishHostCoreRelease(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation: boolean;
}): HostCoreSnapshotManifest {
  return createHostCoreSnapshot({
    projectRoot: options.projectRoot,
    runtimeHome: options.runtimeHome,
    label: assertLabel(options.version) ?? undefined,
    skipValidation: options.skipValidation,
  });
}
