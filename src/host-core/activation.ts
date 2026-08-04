import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readInstalledG8CoreReleaseManifest } from '../workflow-runtime/certification/release-manifest.js';
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
import {
  HOST_CORE_ENTRY,
  HOST_CORE_MANIFEST_FILENAME,
  HOST_CORE_VALIDATION_ENTRY,
  type HostCoreReleaseManifest,
  resolveHostCoreVersion,
  verifyInstalledHostCoreRelease,
} from './release.js';
import type { WorkflowRuntimeSchemaCompatibility } from './persistent-state.js';

interface LegacyContentAddressedCoreBinding {
  readonly format: 'icarus.core-runtime-launch-binding/2';
  readonly binding_kind: 'content_addressed_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: typeof HOST_CORE_MANIFEST_FILENAME;
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: string;
  readonly validation_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

export interface FormalHostCoreBinding {
  readonly format: 'icarus.host-core-runtime-launch-binding/1';
  readonly binding_kind: 'content_addressed_host_core_release';
  readonly core_release_relative_path: string;
  readonly release_manifest_relative_path: typeof HOST_CORE_MANIFEST_FILENAME;
  readonly release_manifest_sha256: Sha256Hash;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly core_entry_relative_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_relative_path: string;
  readonly validation_entry_sha256: Sha256Hash;
  readonly managed_node_manifest_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
}

type ContentAddressedCoreBinding =
  | LegacyContentAddressedCoreBinding
  | FormalHostCoreBinding;

export interface ActiveHostCoreIdentity {
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
  readonly formal: boolean;
  readonly binding_kind:
    | 'content_addressed_release'
    | 'content_addressed_host_core_release';
  readonly database_schema_version: number;
  readonly database_schema_hash: Sha256Hash;
  readonly database_sqlite_schema_hash: Sha256Hash | null;
  readonly workflow_runtime_schema_compatibility: WorkflowRuntimeSchemaCompatibility | null;
  readonly release_root: string;
  readonly core_entry_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly release_manifest_sha256: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly managed_node_distribution_hash: Sha256Hash;
}

const BINDING_KEYS = [
  'binding_hash',
  'binding_kind',
  'core_build_hash',
  'core_entry_relative_path',
  'core_entry_sha256',
  'core_release_relative_path',
  'format',
  'managed_node_manifest_hash',
  'release_artifact_hash',
  'release_manifest_relative_path',
  'release_manifest_sha256',
  'validation_entry_relative_path',
  'validation_entry_sha256',
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

function assertRegularFile(file: string, label: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}_invalid`);
}

function safeRelative(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`${label}_invalid`);
  return value;
}

function resolveRelativeDirectory(
  runtimeHome: string,
  relative: string,
  requiredPrefix: string,
): string {
  safeRelative(relative, 'host_core_relative_path');
  if (!relative.startsWith(`${requiredPrefix}/`))
    throw new Error('host_core_relative_prefix_invalid');
  const candidate = path.join(runtimeHome, relative);
  const candidateStat = fs.lstatSync(candidate);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink())
    throw new Error('host_core_relative_directory_invalid');
  const resolved = fs.realpathSync(candidate);
  const root = fs.realpathSync(path.join(runtimeHome, requiredPrefix));
  const fromRoot = path.relative(root, resolved);
  if (
    !fromRoot ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRoot)
  )
    throw new Error('host_core_relative_path_outside_root');
  return resolved;
}

function parseBinding(value: unknown): ContentAddressedCoreBinding {
  assertJsonObject(value);
  exactKeys(value, BINDING_KEYS, 'host_core_binding');
  const legacy =
    value.format === 'icarus.core-runtime-launch-binding/2' &&
    value.binding_kind === 'content_addressed_release';
  const formal =
    value.format === 'icarus.host-core-runtime-launch-binding/1' &&
    value.binding_kind === 'content_addressed_host_core_release';
  if (
    (!legacy && !formal) ||
    value.release_manifest_relative_path !== HOST_CORE_MANIFEST_FILENAME
  )
    throw new Error('host_core_binding_identity_invalid');
  const common = {
    core_release_relative_path: safeRelative(
      value.core_release_relative_path,
      'host_core_binding_release_path',
    ),
    release_manifest_relative_path:
      HOST_CORE_MANIFEST_FILENAME as typeof HOST_CORE_MANIFEST_FILENAME,
    release_manifest_sha256: parseSha256Hash(value.release_manifest_sha256),
    release_artifact_hash: parseSha256Hash(value.release_artifact_hash),
    core_build_hash: parseSha256Hash(value.core_build_hash),
    core_entry_relative_path: safeRelative(
      value.core_entry_relative_path,
      'host_core_binding_core_entry',
    ),
    core_entry_sha256: parseSha256Hash(value.core_entry_sha256),
    validation_entry_relative_path: safeRelative(
      value.validation_entry_relative_path,
      'host_core_binding_validation_entry',
    ),
    validation_entry_sha256: parseSha256Hash(value.validation_entry_sha256),
    managed_node_manifest_hash: parseSha256Hash(
      value.managed_node_manifest_hash,
    ),
    binding_hash: parseSha256Hash(value.binding_hash),
  };
  const binding = legacy
    ? {
        ...common,
        format: 'icarus.core-runtime-launch-binding/2' as const,
        binding_kind: 'content_addressed_release' as const,
      }
    : {
        ...common,
        format: 'icarus.host-core-runtime-launch-binding/1' as const,
        binding_kind: 'content_addressed_host_core_release' as const,
      };
  const { binding_hash: _bindingHash, ...payload } = binding;
  const domain = legacy
    ? 'icarus:core-runtime-launch-binding:2\n'
    : 'icarus:host-core-runtime-launch-binding:1\n';
  if (
    binding.binding_hash !==
      domainSeparatedSha256(domain, payload as unknown as JsonValue) ||
    binding.core_release_relative_path !==
      `core-releases/${binding.release_artifact_hash.slice('sha256:'.length)}`
  )
    throw new Error('host_core_binding_hash_invalid');
  return binding;
}

function buildBinding(
  manifest: HostCoreReleaseManifest,
  manifestHash: Sha256Hash,
): FormalHostCoreBinding {
  const payload = {
    format: 'icarus.host-core-runtime-launch-binding/1' as const,
    binding_kind: 'content_addressed_host_core_release' as const,
    core_release_relative_path: `core-releases/${manifest.release_artifact_hash.slice('sha256:'.length)}`,
    release_manifest_relative_path: HOST_CORE_MANIFEST_FILENAME,
    release_manifest_sha256: manifestHash,
    release_artifact_hash: manifest.release_artifact_hash,
    core_build_hash: manifest.core_build_hash,
    core_entry_relative_path: HOST_CORE_ENTRY,
    core_entry_sha256: manifest.core_entry_sha256,
    validation_entry_relative_path: HOST_CORE_VALIDATION_ENTRY,
    validation_entry_sha256: manifest.validation_entry_sha256,
    managed_node_manifest_hash: manifest.managed_node_distribution_hash,
  };
  return parseBinding({
    ...payload,
    binding_hash: domainSeparatedSha256(
      'icarus:host-core-runtime-launch-binding:1\n',
      payload as unknown as JsonValue,
    ),
  }) as FormalHostCoreBinding;
}

function readActiveBinding(runtimeHome: string): ContentAddressedCoreBinding {
  const pointer = path.join(runtimeHome, 'active-core');
  const stat = fs.lstatSync(pointer);
  if (!stat.isSymbolicLink()) throw new Error('active_core_pointer_invalid');
  const relative = safeRelative(
    fs.readlinkSync(pointer),
    'active_core_pointer',
  );
  if (!/^core-bindings\/[0-9a-f]{64}$/.test(relative))
    throw new Error('active_core_pointer_invalid');
  const directory = resolveRelativeDirectory(
    runtimeHome,
    relative,
    'core-bindings',
  );
  const bindingFile = path.join(directory, 'binding.json');
  assertRegularFile(bindingFile, 'active_core_binding_file');
  const binding = parseBinding(
    strictParseJsonBytes(fs.readFileSync(bindingFile)),
  );
  if (path.basename(directory) !== binding.binding_hash.slice('sha256:'.length))
    throw new Error('active_core_binding_path_invalid');
  return binding;
}

function verifyRuntimeIdentity(
  runtimeHome: string,
  manifest: {
    managed_node_distribution_hash: Sha256Hash;
    runtime_launcher_hash: Sha256Hash;
    runtime_toolchain_hash: Sha256Hash;
  },
): void {
  for (const file of [
    path.join(runtimeHome, 'contracts/managed-node-runtime-distribution.json'),
    path.join(runtimeHome, 'bin/icarus-runtime'),
    path.join(runtimeHome, 'libexec/icarus-runtime-toolchain'),
  ])
    assertRegularFile(file, 'active_core_runtime_file');
  const managedManifest = strictParseJsonBytes(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'contracts/managed-node-runtime-distribution.json',
      ),
    ),
  );
  assertJsonObject(managedManifest);
  if (
    parseSha256Hash(managedManifest.manifest_hash) !==
      manifest.managed_node_distribution_hash ||
    rawSha256(path.join(runtimeHome, 'bin/icarus-runtime')) !==
      manifest.runtime_launcher_hash ||
    rawSha256(path.join(runtimeHome, 'libexec/icarus-runtime-toolchain')) !==
      manifest.runtime_toolchain_hash
  )
    throw new Error('active_core_runtime_identity_mismatch');
}

export function verifyActiveHostCore(
  runtimeHomeInput: string,
): ActiveHostCoreIdentity {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const binding = readActiveBinding(runtimeHome);
  const releaseRoot = resolveRelativeDirectory(
    runtimeHome,
    binding.core_release_relative_path,
    'core-releases',
  );
  const manifestPath = path.join(
    releaseRoot,
    binding.release_manifest_relative_path,
  );
  assertRegularFile(manifestPath, 'active_core_manifest_file');
  if (rawSha256(manifestPath) !== binding.release_manifest_sha256)
    throw new Error('active_core_manifest_hash_mismatch');
  const manifestValue = strictParseJsonBytes(fs.readFileSync(manifestPath));
  assertJsonObject(manifestValue);

  let identity: ActiveHostCoreIdentity;
  if (manifestValue.lifecycle === 'formal_host_core_release') {
    if (binding.binding_kind !== 'content_addressed_host_core_release')
      throw new Error('active_core_formal_binding_kind_invalid');
    const manifest = verifyInstalledHostCoreRelease(
      releaseRoot,
      binding.release_artifact_hash,
    );
    verifyRuntimeIdentity(runtimeHome, manifest);
    identity = {
      version: manifest.ref.version,
      release_artifact_hash: manifest.release_artifact_hash,
      binding_hash: binding.binding_hash,
      formal: true,
      binding_kind: binding.binding_kind,
      database_schema_version: manifest.database_schema_version,
      database_schema_hash: manifest.database_schema_hash,
      database_sqlite_schema_hash: manifest.database_sqlite_schema_hash,
      workflow_runtime_schema_compatibility:
        manifest.workflow_runtime_schema_compatibility,
      release_root: releaseRoot,
      core_entry_path: path.join(releaseRoot, HOST_CORE_ENTRY),
      core_entry_sha256: manifest.core_entry_sha256,
      validation_entry_sha256: manifest.validation_entry_sha256,
      core_build_hash: manifest.core_build_hash,
      release_manifest_sha256: rawSha256(manifestPath),
      runtime_launcher_hash: manifest.runtime_launcher_hash,
      managed_node_distribution_hash: manifest.managed_node_distribution_hash,
    };
  } else {
    if (binding.binding_kind !== 'content_addressed_release')
      throw new Error('active_core_legacy_binding_kind_invalid');
    const manifest = readInstalledG8CoreReleaseManifest(
      runtimeHome,
      binding.release_artifact_hash,
    );
    verifyRuntimeIdentity(runtimeHome, manifest);
    identity = {
      version: manifest.ref.version,
      release_artifact_hash: manifest.release_artifact_hash,
      binding_hash: binding.binding_hash,
      formal: false,
      binding_kind: binding.binding_kind,
      database_schema_version: manifest.database_schema_version,
      database_schema_hash: manifest.database_schema_hash,
      database_sqlite_schema_hash: null,
      workflow_runtime_schema_compatibility: null,
      release_root: releaseRoot,
      core_entry_path: path.join(
        releaseRoot,
        manifest.core_entry_relative_path,
      ),
      core_entry_sha256: manifest.core_entry_sha256,
      validation_entry_sha256: manifest.validation_entry_sha256,
      core_build_hash: manifest.core_build_hash,
      release_manifest_sha256: rawSha256(manifestPath),
      runtime_launcher_hash: manifest.runtime_launcher_hash,
      managed_node_distribution_hash: manifest.managed_node_distribution_hash,
    };
  }
  if (
    binding.core_build_hash !== identity.core_build_hash ||
    binding.core_entry_sha256 !== identity.core_entry_sha256 ||
    binding.validation_entry_sha256 !== identity.validation_entry_sha256 ||
    rawSha256(path.join(releaseRoot, binding.core_entry_relative_path)) !==
      binding.core_entry_sha256 ||
    rawSha256(
      path.join(releaseRoot, binding.validation_entry_relative_path),
    ) !== binding.validation_entry_sha256
  )
    throw new Error('active_core_binding_release_mismatch');
  return identity;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureSafeDirectories(runtimeHome: string, file: string): void {
  const relative = path.relative(runtimeHome, file);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('host_core_selection_path_invalid');
  let directory = runtimeHome;
  for (const part of path.dirname(relative).split(path.sep)) {
    directory = path.join(directory, part);
    const existing = lstatIfPresent(directory);
    if (!existing) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('host_core_selection_directory_invalid');
  }
}

function installBinding(
  runtimeHome: string,
  binding: FormalHostCoreBinding,
): string {
  const relative = `core-bindings/${binding.binding_hash.slice('sha256:'.length)}`;
  const file = path.join(runtimeHome, relative, 'binding.json');
  ensureSafeDirectories(runtimeHome, file);
  const bytes = `${JSON.stringify(binding, null, 2)}\n`;
  const existing = lstatIfPresent(file);
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      fs.readFileSync(file, 'utf8') !== bytes
    )
      throw new Error('host_core_binding_collision');
    return relative;
  }
  const descriptor = fs.openSync(file, 'wx', 0o444);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
  return relative;
}

function atomicActiveCore(runtimeHome: string, relative: string): void {
  safeRelative(relative, 'active_core_target');
  const pointer = path.join(runtimeHome, 'active-core');
  const existing = lstatIfPresent(pointer);
  if (existing && !existing.isSymbolicLink())
    throw new Error('active_core_pointer_invalid');
  const temporary = path.join(
    runtimeHome,
    `.active-core.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  fs.symlinkSync(relative, temporary);
  try {
    fs.renameSync(temporary, pointer);
    fsyncDirectory(runtimeHome);
  } finally {
    if (lstatIfPresent(temporary)) fs.unlinkSync(temporary);
  }
}

function restoreActiveCore(
  runtimeHome: string,
  installedRelative: string,
  previousRelative: string | null,
): void {
  const pointer = path.join(runtimeHome, 'active-core');
  const current = lstatIfPresent(pointer);
  if (
    !current ||
    !current.isSymbolicLink() ||
    fs.readlinkSync(pointer) !== installedRelative
  )
    throw new Error('host_core_activation_rollback_selection_changed');
  if (previousRelative) atomicActiveCore(runtimeHome, previousRelative);
  else {
    fs.unlinkSync(pointer);
    fsyncDirectory(runtimeHome);
  }
}

function activeIdentityIfPresent(
  runtimeHome: string,
): ActiveHostCoreIdentity | null {
  return lstatIfPresent(path.join(runtimeHome, 'active-core'))
    ? verifyActiveHostCore(runtimeHome)
    : null;
}

function sameActiveIdentity(
  left: ActiveHostCoreIdentity | null,
  right: ActiveHostCoreIdentity | null,
): boolean {
  return (
    left?.release_artifact_hash === right?.release_artifact_hash &&
    left?.binding_hash === right?.binding_hash
  );
}

function assertLightweightReadiness(
  runtimeHome: string,
  releaseRelativePath: string,
): void {
  const core = path.join(runtimeHome, releaseRelativePath, HOST_CORE_ENTRY);
  const result = spawnSync(process.execPath, ['--check', core], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  if (result.status !== 0)
    throw new Error(`host_core_activation_readiness_failed:${result.stderr}`);
}

export interface HostCoreActivationPreflight {
  readonly current: ActiveHostCoreIdentity | null;
  readonly target: HostCoreReleaseManifest;
}

export function inspectHostCoreActivation(
  runtimeHomeInput: string,
  version: string,
): HostCoreActivationPreflight {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  return {
    current: activeIdentityIfPresent(runtimeHome),
    target: resolveHostCoreVersion(runtimeHome, version).manifest,
  };
}

export interface ActivateHostCoreOptions {
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation: boolean;
  readonly confirm: (
    current: ActiveHostCoreIdentity | null,
    target: HostCoreReleaseManifest,
  ) => boolean;
}

export function activateHostCoreRelease(options: ActivateHostCoreOptions): {
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_binding_hash: Sha256Hash;
  readonly readiness_status: 'PASS' | 'SKIPPED_BY_USER';
} {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const initial = inspectHostCoreActivation(runtimeHome, options.version);
  if (!options.confirm(initial.current, initial.target))
    throw new Error('host_core_activation_cancelled');
  if (!options.skipValidation) {
    const resolved = resolveHostCoreVersion(runtimeHome, options.version);
    assertLightweightReadiness(
      runtimeHome,
      resolved.record.release_relative_path,
    );
  }
  const resolved = resolveHostCoreVersion(runtimeHome, options.version);
  const currentBeforeSwitch = activeIdentityIfPresent(runtimeHome);
  if (
    resolved.manifest.release_artifact_hash !==
      initial.target.release_artifact_hash ||
    !sameActiveIdentity(initial.current, currentBeforeSwitch)
  )
    throw new Error('host_core_activation_selection_changed');
  verifyRuntimeIdentity(runtimeHome, resolved.manifest);
  const manifestPath = path.join(
    runtimeHome,
    resolved.record.release_relative_path,
    HOST_CORE_MANIFEST_FILENAME,
  );
  const binding = buildBinding(resolved.manifest, rawSha256(manifestPath));
  const previousRelative = currentBeforeSwitch
    ? fs.readlinkSync(path.join(runtimeHome, 'active-core'))
    : null;
  const bindingRelative = installBinding(runtimeHome, binding);
  atomicActiveCore(runtimeHome, bindingRelative);
  let active: ActiveHostCoreIdentity;
  try {
    active = verifyActiveHostCore(runtimeHome);
    if (
      active.release_artifact_hash !==
        resolved.manifest.release_artifact_hash ||
      active.binding_hash !== binding.binding_hash
    )
      throw new Error('host_core_activation_verification_failed');
  } catch (error) {
    try {
      restoreActiveCore(runtimeHome, bindingRelative, previousRelative);
    } catch (rollbackError) {
      throw new Error('host_core_activation_rollback_failed', {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
  return {
    version: active.version,
    release_artifact_hash: active.release_artifact_hash,
    core_binding_hash: active.binding_hash,
    readiness_status: options.skipValidation ? 'SKIPPED_BY_USER' : 'PASS',
  };
}
