import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import type Database from 'better-sqlite3';

import { readInstalledG8CoreReleaseManifest } from '../../certification/release-manifest.js';
import type {
  G8CertifiedReleaseBinding,
  G8CoreReleaseManifest,
} from '../../contracts/g8-certification-types.js';
import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../../contracts/hash.js';
import type { SQLiteExecutionProfileCandidate } from '../../contracts/safety-sqlite-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';
import { parseVersionedRef } from '../../contracts/versioned-ref.js';

export type WorkflowRuntimeIdentityMode =
  | 'candidate_development'
  | 'certification_observation'
  | 'production';

export interface RuntimeHostObservation {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  executablePath: string;
  executableHash: Sha256Hash;
}

export interface WorkflowRuntimeIdentityEvidence {
  identity_mode: WorkflowRuntimeIdentityMode;
  certification_status: 'candidate_not_certified' | 'certification_observation';
  deployment_profile: 'local_single_user';
  runtime_surface: 'node_service';
  platform: 'darwin';
  arch: 'arm64';
  managed_node_version: string;
  managed_node_exec_path: string;
  managed_node_executable_hash: Sha256Hash;
  managed_distribution_ref: { id: string; version: string };
  managed_distribution_hash: Sha256Hash;
  managed_installation_root: string;
  better_sqlite3_version: string;
  better_sqlite3_native_module_path: string;
  better_sqlite3_native_module_hash: Sha256Hash;
  sqlite_version: string;
  sqlite_source_id: string;
  sqlite_compile_options_hash: Sha256Hash;
  sqlite_compile_option_count: number;
  runtime_launcher_path: string;
  runtime_launcher_observed_hash: Sha256Hash;
  runtime_launcher_profile_hash: Sha256Hash | null;
  core_binding_kind: 'development_checkout' | 'certified_release';
  core_binding_hash: Sha256Hash;
  core_entry_hash: Sha256Hash;
  certification_entry_hash: Sha256Hash | null;
  core_build_hash: Sha256Hash | null;
  release_manifest_hash: Sha256Hash | null;
  release_database_schema_hash: Sha256Hash | null;
  release_artifact_profile_hash: Sha256Hash | null;
  release_identity_status: 'missing_until_g8' | 'observed_for_certification';
}

interface ManagedDistributionManifest extends JsonObject {
  format: 'icarus.managed-node-runtime-distribution/1';
  ref: { id: string; version: string } & JsonObject;
  node_runtime_version: string;
  npm_version: string;
  platform: 'darwin';
  arch: 'arm64';
  distribution_origin: 'nodejs_official';
  archive_filename: string;
  archive_url: string;
  archive_sha256: Sha256Hash;
  node_executable_relative_path: 'bin/node';
  node_executable_sha256: Sha256Hash;
  manifest_hash: Sha256Hash;
}

interface DevelopmentCoreBinding extends JsonObject {
  format: 'icarus.core-runtime-launch-binding/1';
  binding_kind: 'development_checkout';
  project_root: string;
  core_entry_relative_path: string;
  core_entry_sha256: Sha256Hash;
  managed_node_manifest_hash: Sha256Hash;
  binding_hash: Sha256Hash;
}

const require = createRequire(import.meta.url);

function rawSha256(filePath: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
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

function assertInside(parent: string, child: string, label: string): void {
  const relative = path.relative(parent, child);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`${label} escapes its trusted root: ${child}`);
}

function readJsonObject(filePath: string): JsonObject {
  const value = strictParseJsonBytes(fs.readFileSync(filePath));
  assertJsonObject(value);
  return value;
}

function parseDistribution(value: JsonObject): ManagedDistributionManifest {
  exactKeys(
    value,
    [
      'format',
      'ref',
      'node_runtime_version',
      'npm_version',
      'platform',
      'arch',
      'distribution_origin',
      'archive_filename',
      'archive_url',
      'archive_sha256',
      'node_executable_relative_path',
      'node_executable_sha256',
      'manifest_hash',
    ],
    'Managed Node Distribution Manifest',
  );
  const ref = parseVersionedRef(value.ref);
  const manifestHash = parseSha256Hash(value.manifest_hash);
  parseSha256Hash(value.archive_sha256);
  parseSha256Hash(value.node_executable_sha256);
  const { manifest_hash: _manifestHash, ...payload } = value;
  const calculated = domainSeparatedSha256(
    'icarus:managed-node-runtime-distribution:1\n',
    payload as JsonValue,
  );
  if (
    value.format !== 'icarus.managed-node-runtime-distribution/1' ||
    value.node_runtime_version !== '26.5.0' ||
    value.platform !== 'darwin' ||
    value.arch !== 'arm64' ||
    value.node_executable_relative_path !== 'bin/node' ||
    manifestHash !== calculated
  ) {
    throw new Error('Managed Node Distribution Manifest identity drifted');
  }
  return {
    ...(value as unknown as ManagedDistributionManifest),
    ref,
    manifest_hash: manifestHash,
  };
}

function checkedInDistribution(): ManagedDistributionManifest {
  return parseDistribution(
    readJsonObject(
      path.resolve(
        import.meta.dirname,
        '../../contracts/toolchain/node-v26.5.0-darwin-arm64.json',
      ),
    ),
  );
}

interface CertifiedReleaseIdentity {
  readonly binding: G8CertifiedReleaseBinding;
  readonly manifest: G8CoreReleaseManifest;
  readonly releaseManifestHash: Sha256Hash;
}

function assertRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} is not a safe relative path`);
  }
  return value;
}

function verifyCertifiedReleaseBinding(
  runtimeHome: string,
  expectedManifestHash: Sha256Hash,
): CertifiedReleaseIdentity {
  const bindingDirectory = fs.realpathSync(
    path.join(runtimeHome, 'active-core'),
  );
  assertInside(
    path.join(runtimeHome, 'core-bindings'),
    bindingDirectory,
    'Certified Core binding',
  );
  const bindingPath = path.join(bindingDirectory, 'binding.json');
  const value = readJsonObject(bindingPath);
  exactKeys(
    value,
    [
      'format',
      'binding_kind',
      'core_release_relative_path',
      'release_manifest_relative_path',
      'release_manifest_sha256',
      'release_artifact_hash',
      'core_build_hash',
      'core_entry_relative_path',
      'core_entry_sha256',
      'certification_entry_relative_path',
      'certification_entry_sha256',
      'managed_node_manifest_hash',
      'binding_hash',
    ],
    'Certified Core Runtime binding',
  );
  const releaseRelative = assertRelativePath(
    value.core_release_relative_path,
    'Core Release path',
  );
  const manifestRelative = assertRelativePath(
    value.release_manifest_relative_path,
    'Core Release Manifest path',
  );
  const coreEntryRelative = assertRelativePath(
    value.core_entry_relative_path,
    'Core entry path',
  );
  const certificationEntryRelative = assertRelativePath(
    value.certification_entry_relative_path,
    'Certification entry path',
  );
  const bindingHash = parseSha256Hash(value.binding_hash);
  const releaseManifestHash = parseSha256Hash(value.release_manifest_sha256);
  const releaseArtifactHash = parseSha256Hash(value.release_artifact_hash);
  const coreBuildHash = parseSha256Hash(value.core_build_hash);
  const coreEntryHash = parseSha256Hash(value.core_entry_sha256);
  const certificationEntryHash = parseSha256Hash(
    value.certification_entry_sha256,
  );
  const managedManifestHash = parseSha256Hash(value.managed_node_manifest_hash);
  const { binding_hash: _bindingHash, ...payload } = value;
  if (
    value.format !== 'icarus.core-runtime-launch-binding/2' ||
    value.binding_kind !== 'certified_release' ||
    releaseRelative !==
      `core-releases/${releaseArtifactHash.slice('sha256:'.length)}` ||
    manifestRelative !== 'core-release-manifest.json' ||
    coreEntryRelative !== 'dist/index.js' ||
    certificationEntryRelative !==
      'dist/workflow-runtime/certification/release-entry.js' ||
    managedManifestHash !== expectedManifestHash ||
    domainSeparatedSha256(
      'icarus:core-runtime-launch-binding:2\n',
      payload as JsonValue,
    ) !== bindingHash ||
    path.basename(bindingDirectory) !== bindingHash.slice('sha256:'.length)
  ) {
    throw new Error('Certified Core Runtime binding identity drifted');
  }
  const releaseRoot = fs.realpathSync(path.join(runtimeHome, releaseRelative));
  assertInside(
    path.join(runtimeHome, 'core-releases'),
    releaseRoot,
    'Core Release',
  );
  const activeModuleReleaseRoot = path.resolve(
    import.meta.dirname,
    '../../../..',
  );
  if (fs.realpathSync(activeModuleReleaseRoot) !== releaseRoot) {
    throw new Error(
      'Certification Store module is not loaded from the active Core Release',
    );
  }
  const manifestPath = fs.realpathSync(
    path.join(releaseRoot, manifestRelative),
  );
  assertInside(releaseRoot, manifestPath, 'Core Release Manifest');
  if (rawSha256(manifestPath) !== releaseManifestHash) {
    throw new Error('Core Release Manifest raw hash mismatch');
  }
  const manifest = readInstalledG8CoreReleaseManifest(
    runtimeHome,
    releaseArtifactHash,
  );
  if (
    manifest.release_artifact_hash !== releaseArtifactHash ||
    manifest.core_build_hash !== coreBuildHash ||
    manifest.core_entry_relative_path !== coreEntryRelative ||
    manifest.core_entry_sha256 !== coreEntryHash ||
    manifest.certification_entry_relative_path !== certificationEntryRelative ||
    manifest.certification_entry_sha256 !== certificationEntryHash ||
    manifest.managed_node_distribution_hash !== managedManifestHash
  ) {
    throw new Error('Certified Core binding and Release Manifest disagree');
  }
  return {
    binding: value as unknown as G8CertifiedReleaseBinding,
    manifest,
    releaseManifestHash,
  };
}

export function currentRuntimeHostObservation(): RuntimeHostObservation {
  const executablePath = fs.realpathSync(process.execPath);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    executablePath,
    executableHash: rawSha256(executablePath),
  };
}

export function assertRuntimeHostIdentity(
  profile: Readonly<SQLiteExecutionProfileCandidate>,
  mode: WorkflowRuntimeIdentityMode,
  observation: RuntimeHostObservation = currentRuntimeHostObservation(),
): void {
  if (mode === 'production') {
    throw new Error(
      'Production Workflow Runtime identity is unavailable: local_single_user_sqlite@1 is candidate/not-certified and release/launcher certification fields are null until G8',
    );
  }
  if (
    profile.certification_status !== 'candidate' ||
    profile.release_artifact_hash !== null ||
    profile.runtime_launcher_hash !== null
  ) {
    throw new Error('Candidate SQLite Profile certification boundary drifted');
  }
  if (
    observation.platform !== profile.platform ||
    observation.arch !== profile.arch
  ) {
    throw new Error(
      `Runtime platform identity mismatch: expected ${profile.platform}/${profile.arch}, received ${observation.platform}/${observation.arch}`,
    );
  }
  if (
    observation.nodeVersion !== `v${profile.node_runtime_version}` ||
    observation.executableHash !== profile.node_executable_hash
  ) {
    throw new Error('Managed Node executable version/hash identity mismatch');
  }
  const marker = `${path.sep}toolchains${path.sep}node${path.sep}`;
  if (!observation.executablePath.includes(marker)) {
    throw new Error(
      `Node executable is outside the managed Icarus distribution: ${observation.executablePath}`,
    );
  }
}

function runtimeLayout(executablePath: string): {
  runtimeHome: string;
  installationRoot: string;
} {
  const marker = `${path.sep}toolchains${path.sep}node${path.sep}`;
  const markerIndex = executablePath.indexOf(marker);
  if (markerIndex <= 0) {
    throw new Error('Managed Node runtime layout is not recognizable');
  }
  return {
    runtimeHome: executablePath.slice(0, markerIndex),
    installationRoot: path.dirname(path.dirname(executablePath)),
  };
}

function verifyDevelopmentCoreBinding(
  runtimeHome: string,
  expectedManifestHash: Sha256Hash,
): DevelopmentCoreBinding {
  const activeCore = path.join(runtimeHome, 'active-core');
  const bindingDirectory = fs.realpathSync(activeCore);
  assertInside(
    path.join(runtimeHome, 'core-bindings'),
    bindingDirectory,
    'Core binding',
  );
  const value = readJsonObject(path.join(bindingDirectory, 'binding.json'));
  exactKeys(
    value,
    [
      'format',
      'binding_kind',
      'project_root',
      'core_entry_relative_path',
      'core_entry_sha256',
      'managed_node_manifest_hash',
      'binding_hash',
    ],
    'Core Runtime binding',
  );
  const bindingHash = parseSha256Hash(value.binding_hash);
  const coreEntryHash = parseSha256Hash(value.core_entry_sha256);
  const manifestHash = parseSha256Hash(value.managed_node_manifest_hash);
  const { binding_hash: _bindingHash, ...payload } = value;
  const calculated = domainSeparatedSha256(
    'icarus:core-runtime-launch-binding:1\n',
    payload as JsonValue,
  );
  if (
    value.format !== 'icarus.core-runtime-launch-binding/1' ||
    value.binding_kind !== 'development_checkout' ||
    bindingHash !== calculated ||
    path.basename(bindingDirectory) !== bindingHash.slice('sha256:'.length) ||
    manifestHash !== expectedManifestHash ||
    typeof value.project_root !== 'string' ||
    typeof value.core_entry_relative_path !== 'string' ||
    path.isAbsolute(value.core_entry_relative_path)
  ) {
    throw new Error('Development Core binding identity mismatch');
  }
  const bindingProjectRoot = fs.realpathSync(value.project_root);
  const entryPath = fs.realpathSync(
    path.join(bindingProjectRoot, value.core_entry_relative_path),
  );
  assertInside(bindingProjectRoot, entryPath, 'Core entry');
  if (rawSha256(entryPath) !== coreEntryHash) {
    throw new Error('Development Core entry hash mismatch');
  }
  return value as unknown as DevelopmentCoreBinding;
}

export function collectWorkflowRuntimeIdentityEvidence(
  database: Database.Database,
  profile: Readonly<SQLiteExecutionProfileCandidate>,
  mode: WorkflowRuntimeIdentityMode,
): WorkflowRuntimeIdentityEvidence {
  const observation = currentRuntimeHostObservation();
  assertRuntimeHostIdentity(profile, mode, observation);
  const distribution = checkedInDistribution();
  const profileDistributionRef = profile.managed_node_distribution_ref;
  if (
    distribution.ref.id !== profileDistributionRef.id ||
    distribution.ref.version !== profileDistributionRef.version ||
    distribution.manifest_hash !== profile.managed_node_distribution_hash ||
    distribution.node_executable_sha256 !== profile.node_executable_hash
  ) {
    throw new Error('SQLite Profile and Managed Node Manifest disagree');
  }

  const { runtimeHome, installationRoot } = runtimeLayout(
    observation.executablePath,
  );
  const activeInstallation = fs.realpathSync(
    path.join(runtimeHome, 'toolchains/node/active-node'),
  );
  if (activeInstallation !== installationRoot) {
    throw new Error(
      'process.execPath is not from the active managed Node pointer',
    );
  }
  const installedDistributionPath = path.join(
    runtimeHome,
    'contracts/managed-node-runtime-distribution.json',
  );
  const installedDistribution = parseDistribution(
    readJsonObject(installedDistributionPath),
  );
  if (
    canonicalJson(installedDistribution) !== canonicalJson(distribution) ||
    installedDistribution.manifest_hash !==
      profile.managed_node_distribution_hash
  ) {
    throw new Error(
      'Installed Managed Node Manifest differs from the checked-in identity',
    );
  }

  const packageJsonPath = require.resolve('better-sqlite3/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = readJsonObject(packageJsonPath);
  if (packageJson.version !== profile.better_sqlite3_version) {
    throw new Error('better-sqlite3 package version identity mismatch');
  }
  const nativeModulePath = fs.realpathSync(
    path.join(packageRoot, 'build/Release/better_sqlite3.node'),
  );
  assertInside(packageRoot, nativeModulePath, 'better-sqlite3 native module');
  const nativeModuleHash = rawSha256(nativeModulePath);

  const identity = database
    .prepare(
      'SELECT sqlite_version() AS sqlite_version, sqlite_source_id() AS sqlite_source_id',
    )
    .get() as { sqlite_version: string; sqlite_source_id: string };
  if (!identity.sqlite_version || !identity.sqlite_source_id) {
    throw new Error('SQLite version/source identity is unavailable');
  }
  const compileOptions = (
    database.pragma('compile_options') as Array<{ compile_options: string }>
  )
    .map((row) => row.compile_options)
    .sort();
  if (
    compileOptions.length === 0 ||
    compileOptions.some((option, index) =>
      index > 0 ? option === compileOptions[index - 1] : false,
    )
  ) {
    throw new Error('SQLite compile-options identity is empty or ambiguous');
  }
  const compileOptionsHash = domainSeparatedSha256(
    'icarus:sqlite-compile-options:1\n',
    compileOptions,
  );

  const launcherPath = fs.realpathSync(
    path.join(runtimeHome, 'bin/icarus-runtime'),
  );
  assertInside(runtimeHome, launcherPath, 'Runtime Launcher');
  const launcherHash = rawSha256(launcherPath);
  const common = {
    identity_mode: mode,
    deployment_profile: profile.deployment_profile,
    runtime_surface: profile.runtime_surface,
    platform: profile.platform,
    arch: profile.arch,
    managed_node_version: observation.nodeVersion,
    managed_node_exec_path: observation.executablePath,
    managed_node_executable_hash: observation.executableHash,
    managed_distribution_ref: { ...distribution.ref },
    managed_distribution_hash: distribution.manifest_hash,
    managed_installation_root: installationRoot,
    better_sqlite3_version: String(packageJson.version),
    better_sqlite3_native_module_path: nativeModulePath,
    better_sqlite3_native_module_hash: nativeModuleHash,
    sqlite_version: identity.sqlite_version,
    sqlite_source_id: identity.sqlite_source_id,
    sqlite_compile_options_hash: compileOptionsHash,
    sqlite_compile_option_count: compileOptions.length,
    runtime_launcher_path: launcherPath,
    runtime_launcher_observed_hash: launcherHash,
  } as const;
  if (mode === 'certification_observation') {
    const release = verifyCertifiedReleaseBinding(
      runtimeHome,
      distribution.manifest_hash,
    );
    if (launcherHash !== release.manifest.runtime_launcher_hash) {
      throw new Error('Runtime Launcher and Core Release Manifest disagree');
    }
    return Object.freeze({
      ...common,
      certification_status: 'certification_observation',
      runtime_launcher_profile_hash: release.manifest.runtime_launcher_hash,
      core_binding_kind: release.binding.binding_kind,
      core_binding_hash: release.binding.binding_hash,
      core_entry_hash: release.binding.core_entry_sha256,
      certification_entry_hash: release.binding.certification_entry_sha256,
      core_build_hash: release.manifest.core_build_hash,
      release_manifest_hash: release.releaseManifestHash,
      release_database_schema_hash: release.manifest.database_schema_hash,
      release_artifact_profile_hash: release.manifest.release_artifact_hash,
      release_identity_status: 'observed_for_certification',
    });
  }
  const coreBinding = verifyDevelopmentCoreBinding(
    runtimeHome,
    distribution.manifest_hash,
  );
  const checkedInLauncherHash = rawSha256(
    path.join(coreBinding.project_root, 'scripts/runtime-launcher.sh'),
  );
  if (launcherHash !== checkedInLauncherHash) {
    throw new Error(
      'Installed Runtime Launcher differs from the checked-in source',
    );
  }
  return Object.freeze({
    ...common,
    certification_status: 'candidate_not_certified',
    runtime_launcher_profile_hash: null,
    core_binding_kind: coreBinding.binding_kind,
    core_binding_hash: parseSha256Hash(coreBinding.binding_hash),
    core_entry_hash: parseSha256Hash(coreBinding.core_entry_sha256),
    certification_entry_hash: null,
    core_build_hash: null,
    release_manifest_hash: null,
    release_database_schema_hash: null,
    release_artifact_profile_hash: null,
    release_identity_status: 'missing_until_g8',
  });
}
