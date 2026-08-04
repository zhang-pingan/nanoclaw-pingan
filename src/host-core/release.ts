import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  domainSeparatedSha256,
  parseSha256Hash,
} from '../workflow-runtime/contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../workflow-runtime/contracts/strict-json.js';
import type {
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../workflow-runtime/store/runtime-store/profile.js';

export const HOST_CORE_MANIFEST_FILENAME = 'core-release-manifest.json';
export const HOST_CORE_ENTRY = 'dist/index.js';
export const HOST_CORE_VALIDATION_ENTRY = 'dist/host-core/release-entry.js';
export const HOST_CORE_VALIDATION_COMMANDS = [
  'test:current',
  'typecheck',
  'format:check',
] as const;

export type HostCoreValidationStatus = 'PASS' | 'SKIPPED_BY_USER';

export interface HostCoreInventoryEntry {
  readonly path: string;
  readonly byte_length: number;
  readonly executable: boolean;
  readonly raw_sha256: Sha256Hash;
}

export interface HostCoreReleaseManifest {
  readonly format: 'icarus.core-release-manifest/1';
  readonly lifecycle: 'formal_host_core_release';
  readonly ref: { readonly id: 'icarus.host-core'; readonly version: string };
  readonly release_scope: 'workflow_runtime_g8_validation';
  readonly build_kind: 'release';
  readonly validation_status: HostCoreValidationStatus;
  readonly validation_commands: readonly string[];
  readonly published_from_commit: string;
  readonly published_from_tree: string;
  readonly platform: 'darwin';
  readonly arch: 'arm64';
  readonly database_schema_version: number;
  readonly database_schema_hash: Sha256Hash;
  readonly managed_node_distribution_ref: {
    readonly id: string;
    readonly version: string;
  };
  readonly managed_node_distribution_hash: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly runtime_toolchain_hash: Sha256Hash;
  readonly core_entry_relative_path: typeof HOST_CORE_ENTRY;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: typeof HOST_CORE_VALIDATION_ENTRY;
  readonly validation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly inventory: readonly HostCoreInventoryEntry[];
  readonly inventory_hash: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
}

export interface HostCoreRegistryEntry {
  readonly registration_sequence: number;
  readonly registered_at_ms: number;
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly release_relative_path: string;
  readonly release_manifest_sha256: Sha256Hash;
  readonly validation_status: HostCoreValidationStatus;
  readonly published_from_commit: string;
  readonly published_from_tree: string;
}

export interface HostCoreReleaseRegistry {
  readonly format: 'icarus.host-core-release-registry/1';
  readonly entries: readonly HostCoreRegistryEntry[];
  readonly registry_hash: Sha256Hash;
}

const MANIFEST_KEYS = [
  'arch',
  'build_kind',
  'core_build_hash',
  'core_entry_relative_path',
  'core_entry_sha256',
  'database_schema_hash',
  'database_schema_version',
  'format',
  'inventory',
  'inventory_hash',
  'lifecycle',
  'managed_node_distribution_hash',
  'managed_node_distribution_ref',
  'platform',
  'published_from_commit',
  'published_from_tree',
  'ref',
  'release_artifact_hash',
  'release_scope',
  'runtime_launcher_hash',
  'runtime_toolchain_hash',
  'validation_commands',
  'validation_entry_relative_path',
  'validation_entry_sha256',
  'validation_status',
] as const;
const INVENTORY_KEYS = [
  'byte_length',
  'executable',
  'path',
  'raw_sha256',
] as const;
const REGISTRY_ENTRY_KEYS = [
  'published_from_commit',
  'published_from_tree',
  'registered_at_ms',
  'registration_sequence',
  'release_artifact_hash',
  'release_manifest_sha256',
  'release_relative_path',
  'validation_status',
  'version',
] as const;

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

export function assertHostCoreVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  )
    throw new Error('host_core_version_invalid');
  return value;
}

function assertGitObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error(`${label}_invalid`);
  return value;
}

function assertReleaseRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`${label}_invalid`);
  return value;
}

function rawSha256(file: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensureOwnedDirectory(root: string, relative: string): string {
  let directory = root;
  for (const part of relative.split('/')) {
    directory = path.join(directory, part);
    const existing = lstatIfPresent(directory);
    if (!existing) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('host_core_state_directory_invalid');
  }
  return directory;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`host_core_release_symlink_rejected:${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(absolute);
      else throw new Error(`host_core_release_non_regular_file:${absolute}`);
    }
  };
  visit(root);
  return files;
}

function inventory(root: string): HostCoreInventoryEntry[] {
  return walkFiles(root)
    .filter(
      (absolute) =>
        path.relative(root, absolute) !== HOST_CORE_MANIFEST_FILENAME,
    )
    .map((absolute) => {
      const stat = fs.statSync(absolute);
      return {
        path: path.relative(root, absolute).split(path.sep).join('/'),
        byte_length: stat.size,
        executable: (stat.mode & 0o111) !== 0,
        raw_sha256: rawSha256(absolute),
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

function parseInventory(value: unknown): HostCoreInventoryEntry[] {
  if (!Array.isArray(value)) throw new Error('host_core_inventory_invalid');
  const result = value.map((entry, index) => {
    assertJsonObject(entry);
    exactKeys(entry, INVENTORY_KEYS, `host_core_inventory_${index}`);
    if (
      !Number.isSafeInteger(entry.byte_length) ||
      Number(entry.byte_length) < 0 ||
      typeof entry.executable !== 'boolean'
    )
      throw new Error(`host_core_inventory_metadata_invalid:${index}`);
    return {
      path: assertReleaseRelativePath(
        entry.path,
        `host_core_inventory_path_${index}`,
      ),
      byte_length: Number(entry.byte_length),
      executable: entry.executable,
      raw_sha256: parseSha256Hash(entry.raw_sha256),
    };
  });
  result.forEach((entry, index) => {
    if (
      entry.path === HOST_CORE_MANIFEST_FILENAME ||
      (index > 0 && result[index - 1]!.path >= entry.path)
    )
      throw new Error('host_core_inventory_order_invalid');
  });
  return result;
}

export function parseHostCoreReleaseManifest(
  value: unknown,
): HostCoreReleaseManifest {
  assertJsonObject(value);
  exactKeys(value, MANIFEST_KEYS, 'host_core_manifest');
  assertJsonObject(value.ref);
  exactKeys(value.ref, ['id', 'version'], 'host_core_manifest_ref');
  assertJsonObject(value.managed_node_distribution_ref);
  exactKeys(
    value.managed_node_distribution_ref,
    ['id', 'version'],
    'host_core_managed_node_ref',
  );
  const version = assertHostCoreVersion(value.ref.version);
  const inventoryEntries = parseInventory(value.inventory);
  const validationStatus = value.validation_status;
  if (
    value.format !== 'icarus.core-release-manifest/1' ||
    value.lifecycle !== 'formal_host_core_release' ||
    value.ref.id !== 'icarus.host-core' ||
    value.release_scope !== 'workflow_runtime_g8_validation' ||
    value.build_kind !== 'release' ||
    (validationStatus !== 'PASS' && validationStatus !== 'SKIPPED_BY_USER') ||
    !Array.isArray(value.validation_commands) ||
    !value.validation_commands.every((entry) => typeof entry === 'string') ||
    JSON.stringify(value.validation_commands) !==
      JSON.stringify(
        validationStatus === 'PASS' ? HOST_CORE_VALIDATION_COMMANDS : [],
      ) ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    !Number.isSafeInteger(value.database_schema_version) ||
    Number(value.database_schema_version) < 1 ||
    typeof value.managed_node_distribution_ref.id !== 'string' ||
    typeof value.managed_node_distribution_ref.version !== 'string' ||
    value.core_entry_relative_path !== HOST_CORE_ENTRY ||
    value.validation_entry_relative_path !== HOST_CORE_VALIDATION_ENTRY
  )
    throw new Error('host_core_manifest_identity_invalid');

  const manifest: HostCoreReleaseManifest = {
    format: value.format,
    lifecycle: value.lifecycle,
    ref: { id: 'icarus.host-core', version },
    release_scope: value.release_scope,
    build_kind: value.build_kind,
    validation_status: validationStatus,
    validation_commands: [...value.validation_commands],
    published_from_commit: assertGitObjectId(
      value.published_from_commit,
      'published_commit',
    ),
    published_from_tree: assertGitObjectId(
      value.published_from_tree,
      'published_tree',
    ),
    platform: value.platform,
    arch: value.arch,
    database_schema_version: Number(value.database_schema_version),
    database_schema_hash: parseSha256Hash(value.database_schema_hash),
    managed_node_distribution_ref: {
      id: value.managed_node_distribution_ref.id,
      version: value.managed_node_distribution_ref.version,
    },
    managed_node_distribution_hash: parseSha256Hash(
      value.managed_node_distribution_hash,
    ),
    runtime_launcher_hash: parseSha256Hash(value.runtime_launcher_hash),
    runtime_toolchain_hash: parseSha256Hash(value.runtime_toolchain_hash),
    core_entry_relative_path: HOST_CORE_ENTRY,
    core_entry_sha256: parseSha256Hash(value.core_entry_sha256),
    validation_entry_relative_path: HOST_CORE_VALIDATION_ENTRY,
    validation_entry_sha256: parseSha256Hash(value.validation_entry_sha256),
    core_build_hash: parseSha256Hash(value.core_build_hash),
    inventory: inventoryEntries,
    inventory_hash: parseSha256Hash(value.inventory_hash),
    release_artifact_hash: parseSha256Hash(value.release_artifact_hash),
  };
  const { release_artifact_hash: _releaseHash, ...payload } = manifest;
  if (
    domainSeparatedSha256(
      'icarus:host-core-release-inventory:1\n',
      inventoryEntries as unknown as JsonValue,
    ) !== manifest.inventory_hash ||
    domainSeparatedSha256(
      'icarus:host-core-release-build:1\n',
      inventoryEntries.filter((entry) =>
        entry.path.startsWith('dist/'),
      ) as unknown as JsonValue,
    ) !== manifest.core_build_hash ||
    domainSeparatedSha256(
      'icarus:host-core-release-manifest:1\n',
      payload as unknown as JsonValue,
    ) !== manifest.release_artifact_hash
  )
    throw new Error('host_core_manifest_content_identity_invalid');
  return manifest;
}

export function verifyInstalledHostCoreRelease(
  releaseRootInput: string,
  expectedHash?: Sha256Hash,
): HostCoreReleaseManifest {
  const releaseStat = fs.lstatSync(releaseRootInput);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink())
    throw new Error('host_core_release_directory_invalid');
  const releaseRoot = fs.realpathSync(releaseRootInput);
  const manifestPath = path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME);
  const manifest = parseHostCoreReleaseManifest(
    strictParseJsonBytes(fs.readFileSync(manifestPath)),
  );
  if (expectedHash && manifest.release_artifact_hash !== expectedHash)
    throw new Error('host_core_release_hash_mismatch');
  if (
    path.basename(releaseRoot) !==
    manifest.release_artifact_hash.slice('sha256:'.length)
  )
    throw new Error('host_core_release_path_mismatch');
  const observed = inventory(releaseRoot);
  if (JSON.stringify(observed) !== JSON.stringify(manifest.inventory))
    throw new Error('host_core_release_inventory_mismatch');
  if (
    rawSha256(path.join(releaseRoot, HOST_CORE_ENTRY)) !==
      manifest.core_entry_sha256 ||
    rawSha256(path.join(releaseRoot, HOST_CORE_VALIDATION_ENTRY)) !==
      manifest.validation_entry_sha256
  )
    throw new Error('host_core_release_entry_mismatch');
  return manifest;
}

function parseRegistryEntry(value: unknown): HostCoreRegistryEntry {
  assertJsonObject(value);
  exactKeys(value, REGISTRY_ENTRY_KEYS, 'host_core_registry_entry');
  const version = assertHostCoreVersion(value.version);
  const releaseHash = parseSha256Hash(value.release_artifact_hash);
  const relative = assertReleaseRelativePath(
    value.release_relative_path,
    'host_core_registry_release_path',
  );
  if (
    relative !== `core-releases/${releaseHash.slice('sha256:'.length)}` ||
    !Number.isSafeInteger(value.registration_sequence) ||
    Number(value.registration_sequence) < 1 ||
    !Number.isSafeInteger(value.registered_at_ms) ||
    Number(value.registered_at_ms) < 0 ||
    (value.validation_status !== 'PASS' &&
      value.validation_status !== 'SKIPPED_BY_USER')
  )
    throw new Error('host_core_registry_entry_invalid');
  return {
    registration_sequence: Number(value.registration_sequence),
    registered_at_ms: Number(value.registered_at_ms),
    version,
    release_artifact_hash: releaseHash,
    release_relative_path: relative,
    release_manifest_sha256: parseSha256Hash(value.release_manifest_sha256),
    validation_status: value.validation_status,
    published_from_commit: assertGitObjectId(
      value.published_from_commit,
      'registry_published_commit',
    ),
    published_from_tree: assertGitObjectId(
      value.published_from_tree,
      'registry_published_tree',
    ),
  };
}

export function parseHostCoreReleaseRegistry(
  value: unknown,
): HostCoreReleaseRegistry {
  assertJsonObject(value);
  exactKeys(
    value,
    ['format', 'entries', 'registry_hash'],
    'host_core_registry',
  );
  if (
    value.format !== 'icarus.host-core-release-registry/1' ||
    !Array.isArray(value.entries)
  )
    throw new Error('host_core_registry_invalid');
  const entries = value.entries.map(parseRegistryEntry);
  entries.forEach((entry, index) => {
    if (entry.registration_sequence !== index + 1)
      throw new Error('host_core_registry_order_invalid');
  });
  if (new Set(entries.map((entry) => entry.version)).size !== entries.length)
    throw new Error('host_core_registry_version_ambiguity');
  if (
    new Set(entries.map((entry) => entry.release_artifact_hash)).size !==
    entries.length
  )
    throw new Error('host_core_registry_release_ambiguity');
  const registryHash = parseSha256Hash(value.registry_hash);
  if (
    registryHash !==
    domainSeparatedSha256('icarus:host-core-release-registry:1\n', {
      format: 'icarus.host-core-release-registry/1',
      entries,
    } as unknown as JsonValue)
  )
    throw new Error('host_core_registry_hash_invalid');
  return {
    format: 'icarus.host-core-release-registry/1',
    entries,
    registry_hash: registryHash,
  };
}

export function hostCoreRegistryPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'registry', 'host-core-releases.json');
}

export function readHostCoreReleaseRegistry(
  runtimeHome: string,
): HostCoreReleaseRegistry {
  const file = hostCoreRegistryPath(runtimeHome);
  const registryDirectory = lstatIfPresent(path.dirname(file));
  if (
    registryDirectory &&
    (!registryDirectory.isDirectory() || registryDirectory.isSymbolicLink())
  )
    throw new Error('host_core_registry_directory_invalid');
  const stat = lstatIfPresent(file);
  if (!stat) {
    const payload = {
      format: 'icarus.host-core-release-registry/1' as const,
      entries: [] as readonly HostCoreRegistryEntry[],
    };
    return {
      ...payload,
      registry_hash: domainSeparatedSha256(
        'icarus:host-core-release-registry:1\n',
        payload as unknown as JsonValue,
      ),
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('host_core_registry_file_invalid');
  return parseHostCoreReleaseRegistry(
    strictParseJsonBytes(fs.readFileSync(file)),
  );
}

export function resolveHostCoreVersion(
  runtimeHome: string,
  versionInput: string,
): {
  readonly entry: HostCoreRegistryEntry;
  readonly manifest: HostCoreReleaseManifest;
} {
  const version = assertHostCoreVersion(versionInput);
  const matches = readHostCoreReleaseRegistry(runtimeHome).entries.filter(
    (entry) => entry.version === version,
  );
  if (matches.length !== 1) throw new Error('host_core_version_not_registered');
  const entry = matches[0]!;
  const releaseRoot = path.join(runtimeHome, entry.release_relative_path);
  const releasesDirectory = fs.lstatSync(
    path.join(runtimeHome, 'core-releases'),
  );
  const releaseDirectory = fs.lstatSync(releaseRoot);
  if (
    !releasesDirectory.isDirectory() ||
    releasesDirectory.isSymbolicLink() ||
    !releaseDirectory.isDirectory() ||
    releaseDirectory.isSymbolicLink()
  )
    throw new Error('host_core_registry_release_directory_invalid');
  const releasesReal = fs.realpathSync(path.join(runtimeHome, 'core-releases'));
  const releaseReal = fs.realpathSync(releaseRoot);
  if (path.dirname(releaseReal) !== releasesReal)
    throw new Error('host_core_registry_release_path_invalid');
  const manifestPath = path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME);
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('host_core_registry_manifest_file_invalid');
  if (rawSha256(manifestPath) !== entry.release_manifest_sha256)
    throw new Error('host_core_registry_manifest_hash_mismatch');
  const manifest = verifyInstalledHostCoreRelease(
    releaseRoot,
    entry.release_artifact_hash,
  );
  if (
    manifest.ref.version !== entry.version ||
    manifest.validation_status !== entry.validation_status ||
    manifest.published_from_commit !== entry.published_from_commit ||
    manifest.published_from_tree !== entry.published_from_tree
  )
    throw new Error('host_core_registry_manifest_identity_mismatch');
  return { entry, manifest };
}

function copyTree(source: string, destination: string): void {
  for (const absolute of walkFiles(source)) {
    const relative = path.relative(source, absolute);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolute, target);
    fs.chmodSync(target, fs.statSync(absolute).mode & 0o777);
  }
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

function productionDependencyPackages(projectRoot: string): string[] {
  const rootPackage = path.join(projectRoot, 'package.json');
  const root = JSON.parse(fs.readFileSync(rootPackage, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const queue = Object.keys(root.dependencies ?? {}).map((dependency) => ({
    importer: rootPackage,
    dependency,
    required: true,
  }));
  const packages = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    const resolve = createRequire(next.importer).resolve;
    let packageJson: string | null = null;
    try {
      packageJson = resolve(`${next.dependency}/package.json`);
    } catch {
      try {
        packageJson = findPackageJson(resolve(next.dependency));
      } catch {
        if (next.required)
          throw new Error(
            `host_core_required_dependency_missing:${next.dependency}`,
          );
      }
    }
    if (!packageJson) continue;
    const packageRoot = fs.realpathSync(path.dirname(packageJson));
    const dependencyRoot = fs.realpathSync(
      path.join(projectRoot, 'node_modules'),
    );
    const relative = path.relative(dependencyRoot, packageRoot);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('host_core_dependency_outside_project');
    if (packages.has(packageRoot)) continue;
    packages.add(packageRoot);
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ importer: packageJson, dependency, required: true });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ importer: packageJson, dependency, required: false });
  }
  return [...packages].sort();
}

function copyRuntimeAssets(projectRoot: string, stageRoot: string): void {
  const workflowRoot = path.join(projectRoot, 'src', 'workflow-runtime');
  for (const absolute of walkFiles(workflowRoot)) {
    if (!/\.(?:json|sql)$/.test(absolute)) continue;
    const relative = path.relative(workflowRoot, absolute);
    const target = path.join(stageRoot, 'dist', 'workflow-runtime', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolute, target);
    fs.chmodSync(target, 0o444);
  }
  const configRoot = path.join(projectRoot, 'config');
  if (fs.existsSync(configRoot))
    copyTree(configRoot, path.join(stageRoot, 'config'));
}

function checkedInDistribution(projectRoot: string): {
  ref: { id: string; version: string };
  manifest_hash: Sha256Hash;
} {
  const file = path.join(
    projectRoot,
    'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
  );
  const value = strictParseJsonBytes(fs.readFileSync(file));
  assertJsonObject(value);
  assertJsonObject(value.ref);
  if (typeof value.ref.id !== 'string' || typeof value.ref.version !== 'string')
    throw new Error('host_core_managed_distribution_invalid');
  return {
    ref: { id: value.ref.id, version: value.ref.version },
    manifest_hash: parseSha256Hash(value.manifest_hash),
  };
}

function atomicWrite(file: string, bytes: string, mode = 0o600): void {
  const parentStat = fs.lstatSync(path.dirname(file));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error('host_core_atomic_write_directory_invalid');
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.tmp`,
  );
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function freezeTree(root: string): void {
  for (const absolute of walkFiles(root)) {
    const executable = (fs.statSync(absolute).mode & 0o111) !== 0;
    fs.chmodSync(absolute, executable ? 0o555 : 0o444);
  }
  const directories: string[] = [root];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const child = path.join(directory, entry.name);
        directories.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  directories.sort((left, right) => right.length - left.length);
  directories.forEach((directory) => fs.chmodSync(directory, 0o555));
}

function removeFrozenTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const visit = (directory: string): void => {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else fs.chmodSync(absolute, 0o644);
    }
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export interface InstallHostCoreReleaseOptions {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly distRoot: string;
  readonly version: string;
  readonly validationStatus: HostCoreValidationStatus;
  readonly commit: string;
  readonly tree: string;
  readonly registeredAtMs: number;
  readonly includeDependencies?: boolean;
  readonly includeRuntimeAssets?: boolean;
}

export function installHostCoreReleaseFromDist(
  options: InstallHostCoreReleaseOptions,
): {
  readonly manifest: HostCoreReleaseManifest;
  readonly registry: HostCoreReleaseRegistry;
} {
  const projectRoot = fs.realpathSync(options.projectRoot);
  fs.mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const distRoot = fs.realpathSync(options.distRoot);
  const version = assertHostCoreVersion(options.version);
  const commit = assertGitObjectId(options.commit, 'published_commit');
  const tree = assertGitObjectId(options.tree, 'published_tree');
  if (
    !Number.isSafeInteger(options.registeredAtMs) ||
    options.registeredAtMs < 0
  )
    throw new Error('host_core_registration_time_invalid');
  for (const required of [HOST_CORE_ENTRY, HOST_CORE_VALIDATION_ENTRY]) {
    const relative = required.slice('dist/'.length);
    if (!fs.existsSync(path.join(distRoot, relative)))
      throw new Error(`host_core_release_build_missing:${required}`);
  }

  const releasesRoot = ensureOwnedDirectory(runtimeHome, 'core-releases');
  const stageRoot = fs.mkdtempSync(
    path.join(releasesRoot, '.host-core-release-'),
  );
  const lock = path.join(runtimeHome, '.host-core-release-registry.lock');
  try {
    copyTree(distRoot, path.join(stageRoot, 'dist'));
    if (options.includeRuntimeAssets !== false)
      copyRuntimeAssets(projectRoot, stageRoot);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    packageJson.version = version;
    fs.writeFileSync(
      path.join(stageRoot, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      { mode: 0o444 },
    );
    if (options.includeDependencies !== false) {
      for (const packageRoot of productionDependencyPackages(projectRoot)) {
        const relative = path.relative(projectRoot, packageRoot);
        copyTree(packageRoot, path.join(stageRoot, relative));
      }
    }
    const entries = inventory(stageRoot);
    const distribution = checkedInDistribution(projectRoot);
    const payload = {
      format: 'icarus.core-release-manifest/1' as const,
      lifecycle: 'formal_host_core_release' as const,
      ref: { id: 'icarus.host-core' as const, version },
      release_scope: 'workflow_runtime_g8_validation' as const,
      build_kind: 'release' as const,
      validation_status: options.validationStatus,
      validation_commands:
        options.validationStatus === 'PASS'
          ? HOST_CORE_VALIDATION_COMMANDS
          : [],
      published_from_commit: commit,
      published_from_tree: tree,
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      database_schema_version: 11,
      database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      managed_node_distribution_ref: distribution.ref,
      managed_node_distribution_hash: distribution.manifest_hash,
      runtime_launcher_hash: rawSha256(
        path.join(projectRoot, 'scripts/runtime-launcher.sh'),
      ),
      runtime_toolchain_hash: rawSha256(
        path.join(projectRoot, 'scripts/runtime-toolchain.sh'),
      ),
      core_entry_relative_path: HOST_CORE_ENTRY,
      core_entry_sha256: rawSha256(path.join(stageRoot, HOST_CORE_ENTRY)),
      validation_entry_relative_path: HOST_CORE_VALIDATION_ENTRY,
      validation_entry_sha256: rawSha256(
        path.join(stageRoot, HOST_CORE_VALIDATION_ENTRY),
      ),
      core_build_hash: domainSeparatedSha256(
        'icarus:host-core-release-build:1\n',
        entries.filter((entry) =>
          entry.path.startsWith('dist/'),
        ) as unknown as JsonValue,
      ),
      inventory: entries,
      inventory_hash: domainSeparatedSha256(
        'icarus:host-core-release-inventory:1\n',
        entries as unknown as JsonValue,
      ),
    };
    const manifest = parseHostCoreReleaseManifest({
      ...payload,
      release_artifact_hash: domainSeparatedSha256(
        'icarus:host-core-release-manifest:1\n',
        payload as unknown as JsonValue,
      ),
    });
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(
      path.join(stageRoot, HOST_CORE_MANIFEST_FILENAME),
      manifestBytes,
      { mode: 0o444 },
    );
    freezeTree(stageRoot);

    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('host_core_registry_busy');
      throw error;
    }
    ensureOwnedDirectory(runtimeHome, 'registry');
    const currentRegistry = readHostCoreReleaseRegistry(runtimeHome);
    const existingVersion = currentRegistry.entries.find(
      (entry) => entry.version === version,
    );
    if (
      existingVersion &&
      existingVersion.release_artifact_hash !== manifest.release_artifact_hash
    )
      throw new Error('host_core_version_rebind_rejected');
    const releaseRoot = path.join(
      releasesRoot,
      manifest.release_artifact_hash.slice('sha256:'.length),
    );
    const existingRelease = lstatIfPresent(releaseRoot);
    if (existingRelease) {
      if (!existingRelease.isDirectory() || existingRelease.isSymbolicLink())
        throw new Error('host_core_release_collision');
      const installed = verifyInstalledHostCoreRelease(
        releaseRoot,
        manifest.release_artifact_hash,
      );
      if (JSON.stringify(installed) !== JSON.stringify(manifest))
        throw new Error('host_core_release_collision');
      removeFrozenTree(stageRoot);
    } else fs.renameSync(stageRoot, releaseRoot);

    if (existingVersion) return { manifest, registry: currentRegistry };
    const entry: HostCoreRegistryEntry = {
      registration_sequence: currentRegistry.entries.length + 1,
      registered_at_ms: options.registeredAtMs,
      version,
      release_artifact_hash: manifest.release_artifact_hash,
      release_relative_path: `core-releases/${manifest.release_artifact_hash.slice('sha256:'.length)}`,
      release_manifest_sha256: rawSha256(
        path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME),
      ),
      validation_status: manifest.validation_status,
      published_from_commit: commit,
      published_from_tree: tree,
    };
    const registryEntries = [...currentRegistry.entries, entry];
    const registryPayload = {
      format: 'icarus.host-core-release-registry/1' as const,
      entries: registryEntries,
    };
    const registry = parseHostCoreReleaseRegistry({
      ...registryPayload,
      registry_hash: domainSeparatedSha256(
        'icarus:host-core-release-registry:1\n',
        registryPayload as unknown as JsonValue,
      ),
    });
    atomicWrite(
      hostCoreRegistryPath(runtimeHome),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    return { manifest, registry };
  } finally {
    if (fs.existsSync(lock)) fs.rmdirSync(lock);
    removeFrozenTree(stageRoot);
  }
}

function gitOutput(projectRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0)
    throw new Error(`host_core_git_command_failed:${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function assertCleanGitCheckout(projectRoot: string): {
  readonly commit: string;
  readonly tree: string;
} {
  if (
    gitOutput(projectRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]) !== ''
  )
    throw new Error('host_core_publish_requires_clean_git');
  return {
    commit: assertGitObjectId(
      gitOutput(projectRoot, ['rev-parse', 'HEAD']),
      'published_commit',
    ),
    tree: assertGitObjectId(
      gitOutput(projectRoot, ['rev-parse', 'HEAD^{tree}']),
      'published_tree',
    ),
  };
}

function runNode(args: readonly string[], cwd: string): void {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    stdio: 'inherit',
  });
  if (result.status !== 0)
    throw new Error(`host_core_command_failed:${args.join(' ')}`);
}

function assertManagedRuntime(runtimeHome: string): void {
  const activeNode = fs.realpathSync(
    path.join(runtimeHome, 'toolchains/node/active-node/bin/node'),
  );
  if (
    fs.realpathSync(process.execPath) !== activeNode ||
    process.version !== 'v26.5.0' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64'
  )
    throw new Error('host_core_publish_managed_runtime_invalid');
}

function runReleaseValidation(projectRoot: string): void {
  const npmCli = path.resolve(
    path.dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  for (const script of HOST_CORE_VALIDATION_COMMANDS)
    runNode([npmCli, 'run', script], projectRoot);
}

export function buildHostCoreDist(
  projectRootInput: string,
  distRoot: string,
): void {
  const projectRoot = fs.realpathSync(projectRootInput);
  const tsc = path.join(projectRoot, 'node_modules/typescript/bin/tsc');
  runNode(
    [
      tsc,
      '--project',
      path.join(projectRoot, 'tsconfig.json'),
      '--outDir',
      distRoot,
    ],
    projectRoot,
  );
}

export function publishHostCoreRelease(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation: boolean;
  readonly now?: () => number;
}): {
  readonly manifest: HostCoreReleaseManifest;
  readonly registry: HostCoreReleaseRegistry;
} {
  const projectRoot = fs.realpathSync(options.projectRoot);
  fs.mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  assertManagedRuntime(runtimeHome);
  const source = assertCleanGitCheckout(projectRoot);
  if (!options.skipValidation) runReleaseValidation(projectRoot);
  const buildRoot = fs.mkdtempSync('/private/tmp/icarus-host-core-publish-');
  try {
    const distRoot = path.join(buildRoot, 'dist');
    buildHostCoreDist(projectRoot, distRoot);
    const afterBuild = assertCleanGitCheckout(projectRoot);
    if (afterBuild.commit !== source.commit || afterBuild.tree !== source.tree)
      throw new Error('host_core_publish_source_changed');
    return installHostCoreReleaseFromDist({
      projectRoot,
      runtimeHome,
      distRoot,
      version: options.version,
      validationStatus: options.skipValidation ? 'SKIPPED_BY_USER' : 'PASS',
      commit: source.commit,
      tree: source.tree,
      registeredAtMs: (options.now ?? Date.now)(),
    });
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}
