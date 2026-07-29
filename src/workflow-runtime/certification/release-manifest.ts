import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { domainSeparatedSha256, parseSha256Hash } from '../contracts/hash.js';
import type {
  G8CoreReleaseManifest,
  G8ReleaseInventoryEntry,
} from '../contracts/g8-certification-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { parseVersionedRef } from '../contracts/versioned-ref.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../store/runtime-store/profile.js';

const CORE_ENTRY = 'dist/index.js' as const;
const CERTIFICATION_ENTRY =
  'dist/workflow-runtime/certification/release-entry.js' as const;
const RELEASE_MANIFEST = 'core-release-manifest.json';
const RELEASE_MANIFEST_KEYS = [
  'arch',
  'build_kind',
  'certification_entry_relative_path',
  'certification_entry_sha256',
  'core_build_hash',
  'core_entry_relative_path',
  'core_entry_sha256',
  'database_schema_hash',
  'database_schema_version',
  'executor_abi_majors',
  'format',
  'inventory',
  'inventory_hash',
  'managed_node_distribution_hash',
  'managed_node_distribution_ref',
  'platform',
  'ref',
  'release_artifact_hash',
  'release_scope',
  'run_protocol_majors',
  'runtime_launcher_hash',
  'runtime_toolchain_hash',
] as const;
const RELEASE_INVENTORY_KEYS = [
  'byte_length',
  'executable',
  'path',
  'raw_sha256',
] as const;

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
    return;
  throw new Error(`${label} escapes ${root}: ${candidate}`);
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(
          `Core Release input contains a symbolic link: ${absolute}`,
        );
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(absolute);
      else
        throw new Error(
          `Core Release input is not a regular file: ${absolute}`,
        );
    }
  };
  visit(root);
  return files;
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

function findPackageJson(resolvedEntry: string): string {
  let directory = path.dirname(resolvedEntry);
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot locate package.json for ${resolvedEntry}`);
    directory = parent;
  }
}

function resolveDependencyPackageJson(
  importerPackageJson: string,
  dependency: string,
): string | null {
  const resolve = createRequire(importerPackageJson).resolve;
  try {
    return resolve(`${dependency}/package.json`);
  } catch {
    try {
      return findPackageJson(resolve(dependency));
    } catch {
      return null;
    }
  }
}

function productionDependencyPackages(projectRoot: string): string[] {
  const rootPackageJson = path.join(projectRoot, 'package.json');
  const root = JSON.parse(fs.readFileSync(rootPackageJson, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const queue = Object.keys(root.dependencies ?? {}).map((dependency) => ({
    importer: rootPackageJson,
    dependency,
    required: true,
  }));
  const packages = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    const packageJson = resolveDependencyPackageJson(
      next.importer,
      next.dependency,
    );
    if (!packageJson) {
      if (next.required)
        throw new Error(
          `Required production dependency is not installed: ${next.dependency}`,
        );
      continue;
    }
    const packageRoot = fs.realpathSync(path.dirname(packageJson));
    assertInside(
      path.join(projectRoot, 'node_modules'),
      packageRoot,
      'Dependency',
    );
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

function copyWorkflowRuntimeAssets(
  projectRoot: string,
  stageRoot: string,
): void {
  const sourceRoot = path.join(projectRoot, 'src/workflow-runtime');
  for (const absolute of walkFiles(sourceRoot)) {
    if (!/\.(?:json|sql)$/.test(absolute)) continue;
    const relative = path.relative(projectRoot, absolute);
    if (
      relative.startsWith(
        `src${path.sep}workflow-runtime${path.sep}contracts${path.sep}certification${path.sep}`,
      ) ||
      relative ===
        `src${path.sep}workflow-runtime${path.sep}contracts${path.sep}sqlite${path.sep}local_single_user_sqlite@1.json`
    )
      continue;
    const target = path.join(stageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolute, target);
    fs.chmodSync(target, 0o644);
  }
}

function inventory(root: string): G8ReleaseInventoryEntry[] {
  return walkFiles(root)
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
  ) {
    throw new Error(`${label} has an unknown, duplicate, or missing field`);
  }
}

function assertReleaseRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} is not a safe release-relative path`);
  }
  return value;
}

function parseInventory(value: unknown): G8ReleaseInventoryEntry[] {
  if (!Array.isArray(value))
    throw new Error('Core Release inventory is not an array');
  const parsed = value.map((entry, index) => {
    assertJsonObject(entry);
    exactKeys(
      entry,
      RELEASE_INVENTORY_KEYS,
      `Core Release inventory[${index}]`,
    );
    const entryPath = assertReleaseRelativePath(
      entry.path,
      `Core Release inventory[${index}].path`,
    );
    if (
      !Number.isSafeInteger(entry.byte_length) ||
      Number(entry.byte_length) < 0 ||
      typeof entry.executable !== 'boolean'
    ) {
      throw new Error(`Core Release inventory[${index}] metadata is invalid`);
    }
    return {
      path: entryPath,
      byte_length: Number(entry.byte_length),
      executable: entry.executable,
      raw_sha256: parseSha256Hash(entry.raw_sha256),
    };
  });
  for (let index = 0; index < parsed.length; index += 1) {
    if (
      parsed[index]!.path === RELEASE_MANIFEST ||
      (index > 0 && parsed[index - 1]!.path >= parsed[index]!.path)
    ) {
      throw new Error('Core Release inventory paths are not unique and sorted');
    }
  }
  return parsed;
}

export function parseG8CoreReleaseManifest(
  value: unknown,
): G8CoreReleaseManifest {
  assertJsonObject(value);
  exactKeys(value, RELEASE_MANIFEST_KEYS, 'Core Release Manifest');
  const ref = parseVersionedRef(value.ref);
  const managedRef = parseVersionedRef(value.managed_node_distribution_ref);
  const inventoryEntries = parseInventory(value.inventory);
  const hashes = {
    database_schema_hash: parseSha256Hash(value.database_schema_hash),
    managed_node_distribution_hash: parseSha256Hash(
      value.managed_node_distribution_hash,
    ),
    runtime_launcher_hash: parseSha256Hash(value.runtime_launcher_hash),
    runtime_toolchain_hash: parseSha256Hash(value.runtime_toolchain_hash),
    core_entry_sha256: parseSha256Hash(value.core_entry_sha256),
    certification_entry_sha256: parseSha256Hash(
      value.certification_entry_sha256,
    ),
    core_build_hash: parseSha256Hash(value.core_build_hash),
    inventory_hash: parseSha256Hash(value.inventory_hash),
    release_artifact_hash: parseSha256Hash(value.release_artifact_hash),
  };
  if (
    value.format !== 'icarus.core-release-manifest/1' ||
    ref.id !== 'icarus.core' ||
    ref.version !== '1.2.14' ||
    value.release_scope !== 'workflow_runtime_g8_certification' ||
    value.build_kind !== 'release' ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    JSON.stringify(value.run_protocol_majors) !== '[1]' ||
    JSON.stringify(value.executor_abi_majors) !== '[1]' ||
    value.database_schema_version !== 11 ||
    value.core_entry_relative_path !== CORE_ENTRY ||
    value.certification_entry_relative_path !== CERTIFICATION_ENTRY
  ) {
    throw new Error('Core Release Manifest fixed identity drifted');
  }
  const manifest: G8CoreReleaseManifest = {
    format: value.format,
    ref,
    release_scope: value.release_scope,
    build_kind: value.build_kind,
    platform: value.platform,
    arch: value.arch,
    run_protocol_majors: [1],
    executor_abi_majors: [1],
    database_schema_version: 11,
    database_schema_hash: hashes.database_schema_hash,
    managed_node_distribution_ref: managedRef,
    managed_node_distribution_hash: hashes.managed_node_distribution_hash,
    runtime_launcher_hash: hashes.runtime_launcher_hash,
    runtime_toolchain_hash: hashes.runtime_toolchain_hash,
    core_entry_relative_path: CORE_ENTRY,
    core_entry_sha256: hashes.core_entry_sha256,
    certification_entry_relative_path: CERTIFICATION_ENTRY,
    certification_entry_sha256: hashes.certification_entry_sha256,
    core_build_hash: hashes.core_build_hash,
    inventory: inventoryEntries,
    inventory_hash: hashes.inventory_hash,
    release_artifact_hash: hashes.release_artifact_hash,
  };
  const { release_artifact_hash: _artifactHash, ...payload } = manifest;
  if (
    domainSeparatedSha256(
      'icarus:core-release-inventory:1\n',
      inventoryEntries as unknown as JsonValue,
    ) !== manifest.inventory_hash ||
    domainSeparatedSha256(
      'icarus:core-release-build:1\n',
      inventoryEntries.filter((entry) =>
        entry.path.startsWith('dist/'),
      ) as unknown as JsonValue,
    ) !== manifest.core_build_hash ||
    domainSeparatedSha256(
      'icarus:core-release-manifest:1\n',
      payload as unknown as JsonValue,
    ) !== manifest.release_artifact_hash
  ) {
    throw new Error('Core Release Manifest content identity drifted');
  }
  return manifest;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, filePath);
}

interface ReleaseManagedDistributionIdentity {
  readonly ref: { readonly id: string; readonly version: string };
  readonly manifest_hash: Sha256Hash;
}

function checkedInDistribution(
  projectRoot: string,
): ReleaseManagedDistributionIdentity {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(
        projectRoot,
        'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
      ),
      'utf8',
    ),
  ) as JsonObject;
  if (
    typeof value.ref !== 'object' ||
    value.ref === null ||
    Array.isArray(value.ref) ||
    typeof value.ref.id !== 'string' ||
    typeof value.ref.version !== 'string' ||
    typeof value.manifest_hash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.manifest_hash)
  ) {
    throw new Error('Managed Node Distribution identity is malformed');
  }
  return {
    ref: { id: value.ref.id, version: value.ref.version },
    manifest_hash: value.manifest_hash as Sha256Hash,
  };
}

export interface InstallG8CoreReleaseOptions {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly manifestOutput: string;
}

export function installG8CoreRelease(
  options: InstallG8CoreReleaseOptions,
): G8CoreReleaseManifest {
  const projectRoot = fs.realpathSync(options.projectRoot);
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const activeNode = fs.realpathSync(
    path.join(runtimeHome, 'toolchains/node/active-node/bin/node'),
  );
  if (fs.realpathSync(process.execPath) !== activeNode)
    throw new Error('Core Release must be built by the active managed Node');
  if (
    process.version !== 'v26.5.0' ||
    process.platform !== 'darwin' ||
    process.arch !== 'arm64'
  )
    throw new Error('Core Release managed runtime identity drifted');

  const distRoot = path.join(projectRoot, 'dist');
  if (!fs.existsSync(path.join(projectRoot, CORE_ENTRY)))
    throw new Error(`Release build is missing ${CORE_ENTRY}`);
  if (!fs.existsSync(path.join(projectRoot, CERTIFICATION_ENTRY)))
    throw new Error(`Release build is missing ${CERTIFICATION_ENTRY}`);

  const releasesRoot = path.join(runtimeHome, 'core-releases');
  fs.mkdirSync(releasesRoot, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(releasesRoot, '.g8-release-'));
  try {
    copyTree(distRoot, path.join(stageRoot, 'dist'));
    copyWorkflowRuntimeAssets(projectRoot, stageRoot);
    fs.copyFileSync(
      path.join(projectRoot, 'package.json'),
      path.join(stageRoot, 'package.json'),
    );
    for (const packageRoot of productionDependencyPackages(projectRoot)) {
      const relative = path.relative(projectRoot, packageRoot);
      copyTree(packageRoot, path.join(stageRoot, relative));
    }

    const entries = inventory(stageRoot);
    const coreEntries = entries.filter((entry) =>
      entry.path.startsWith('dist/'),
    );
    const coreBuildHash = domainSeparatedSha256(
      'icarus:core-release-build:1\n',
      coreEntries as unknown as JsonValue,
    );
    const inventoryHash = domainSeparatedSha256(
      'icarus:core-release-inventory:1\n',
      entries as unknown as JsonValue,
    );
    const distribution = checkedInDistribution(projectRoot);
    const payload = {
      format: 'icarus.core-release-manifest/1',
      ref: { id: 'icarus.core', version: '1.2.14' },
      release_scope: 'workflow_runtime_g8_certification',
      build_kind: 'release',
      platform: 'darwin',
      arch: 'arm64',
      run_protocol_majors: [1],
      executor_abi_majors: [1],
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
      core_entry_relative_path: CORE_ENTRY,
      core_entry_sha256: rawSha256(path.join(stageRoot, CORE_ENTRY)),
      certification_entry_relative_path: CERTIFICATION_ENTRY,
      certification_entry_sha256: rawSha256(
        path.join(stageRoot, CERTIFICATION_ENTRY),
      ),
      core_build_hash: coreBuildHash,
      inventory: entries,
      inventory_hash: inventoryHash,
    } as const;
    const releaseArtifactHash = domainSeparatedSha256(
      'icarus:core-release-manifest:1\n',
      payload as unknown as JsonValue,
    );
    const manifest: G8CoreReleaseManifest = {
      ...payload,
      release_artifact_hash: releaseArtifactHash,
    };
    parseG8CoreReleaseManifest(manifest);
    writeJsonAtomic(path.join(stageRoot, RELEASE_MANIFEST), manifest);
    const releaseRoot = path.join(
      releasesRoot,
      releaseArtifactHash.slice('sha256:'.length),
    );
    if (fs.existsSync(releaseRoot)) {
      const existing = fs.readFileSync(
        path.join(releaseRoot, RELEASE_MANIFEST),
        'utf8',
      );
      const expected = `${JSON.stringify(manifest, null, 2)}\n`;
      if (existing !== expected)
        throw new Error(`Core Release identity collision: ${releaseRoot}`);
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } else {
      fs.renameSync(stageRoot, releaseRoot);
    }
    writeJsonAtomic(options.manifestOutput, manifest);
    return manifest;
  } catch (error) {
    if (fs.existsSync(stageRoot))
      fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export function checkInstalledG8CoreRelease(
  runtimeHome: string,
  manifest: G8CoreReleaseManifest,
): void {
  const parsed = parseG8CoreReleaseManifest(manifest);
  const releaseRoot = path.join(
    fs.realpathSync(runtimeHome),
    'core-releases',
    parsed.release_artifact_hash.slice('sha256:'.length),
  );
  const manifestPath = path.join(releaseRoot, RELEASE_MANIFEST);
  const installedManifest = parseG8CoreReleaseManifest(
    strictParseJsonBytes(fs.readFileSync(manifestPath)),
  );
  if (
    fs.readFileSync(manifestPath, 'utf8') !==
      `${JSON.stringify(installedManifest, null, 2)}\n` ||
    JSON.stringify(installedManifest) !== JSON.stringify(parsed)
  ) {
    throw new Error('Installed Core Release Manifest bytes drifted');
  }
  const observed = inventory(releaseRoot).filter(
    (entry) => entry.path !== RELEASE_MANIFEST,
  );
  if (
    domainSeparatedSha256(
      'icarus:core-release-inventory:1\n',
      observed as unknown as JsonValue,
    ) !== parsed.inventory_hash ||
    JSON.stringify(observed) !== JSON.stringify(parsed.inventory) ||
    rawSha256(path.join(releaseRoot, CORE_ENTRY)) !==
      parsed.core_entry_sha256 ||
    rawSha256(path.join(releaseRoot, CERTIFICATION_ENTRY)) !==
      parsed.certification_entry_sha256
  )
    throw new Error('Installed Core Release inventory drifted');
}

export function readInstalledG8CoreReleaseManifest(
  runtimeHome: string,
  releaseArtifactHash: Sha256Hash,
): G8CoreReleaseManifest {
  const parsedHash = parseSha256Hash(releaseArtifactHash);
  const runtimeRoot = fs.realpathSync(runtimeHome);
  const releaseRoot = fs.realpathSync(
    path.join(runtimeRoot, 'core-releases', parsedHash.slice('sha256:'.length)),
  );
  assertInside(
    path.join(runtimeRoot, 'core-releases'),
    releaseRoot,
    'Core Release',
  );
  const manifest = parseG8CoreReleaseManifest(
    strictParseJsonBytes(
      fs.readFileSync(path.join(releaseRoot, RELEASE_MANIFEST)),
    ),
  );
  if (manifest.release_artifact_hash !== parsedHash) {
    throw new Error('Installed Core Release path and manifest disagree');
  }
  checkInstalledG8CoreRelease(runtimeRoot, manifest);
  return manifest;
}
