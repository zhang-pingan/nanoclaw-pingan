import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  type HostCoreRegistryEntry,
  assertHostCoreVersion,
  resolveHostCoreVersion,
  verifyInstalledHostCoreRelease,
} from './release.js';
import { acquireHostCoreLock } from './lock.js';
import {
  type HostCoreTargetSchemaIdentity,
  type PersistentStateDecision,
  type PersistentStateResetPlan,
  type WorkflowRuntimeStateIdentity,
  buildPersistentStateResetPlan,
  decidePersistentStateCompatibility,
  parsePersistentStateResetPlan,
  quarantinePersistentState,
  readPersistentStateResetBackup,
} from './persistent-state.js';

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
  readonly release_root: string;
  readonly core_entry_path: string;
  readonly core_entry_sha256: Sha256Hash;
  readonly validation_entry_sha256: Sha256Hash;
  readonly core_build_hash: Sha256Hash;
  readonly release_manifest_sha256: Sha256Hash;
  readonly runtime_launcher_hash: Sha256Hash;
  readonly managed_node_distribution_hash: Sha256Hash;
}

type ActivationReadinessStatus = 'PASS' | 'SKIPPED_BY_USER';
type JournalPhase =
  | 'prepared'
  | 'persistent_state_quarantined'
  | 'activation_core_selected'
  | 'active_deployment_committed'
  | 'active_core_committed'
  | 'completed';

interface HostCoreActivationAudit {
  readonly format: 'icarus.host-core-activation-audit/1';
  readonly activation_id: string;
  readonly requested_at_ms: number;
  readonly version: string;
  readonly target_release_artifact_hash: Sha256Hash;
  readonly target_core_binding_hash: Sha256Hash;
  readonly previous_version: string | null;
  readonly previous_release_artifact_hash: Sha256Hash | null;
  readonly previous_core_binding_hash: Sha256Hash | null;
  readonly validation_status: HostCoreReleaseManifest['validation_status'];
  readonly validation_commands: readonly string[];
  readonly readiness_status: ActivationReadinessStatus;
  readonly persistent_state_action:
    | 'NO_STATE'
    | 'UNCHANGED'
    | 'MIGRATION_ON_START'
    | 'RESET_BY_USER';
  readonly old_persistent_state_identity: WorkflowRuntimeStateIdentity | null;
  readonly target_persistent_state_identity: HostCoreTargetSchemaIdentity;
  readonly persistent_state_backup_identity: Sha256Hash | null;
  readonly persistent_state_backup_relative_path: string | null;
  readonly persistent_state_reset_plan: PersistentStateResetPlan | null;
  readonly persistent_state_rollback:
    | 'CODE_ROLLBACK_STATE_COMPATIBILITY_REQUIRED'
    | 'CODE_ROLLBACK_DOES_NOT_RESTORE_QUARANTINED_STATE';
  readonly rollback: boolean;
  readonly audit_hash: Sha256Hash;
}

interface HostCoreDeployment {
  readonly format: 'icarus.host-core-deployment/1';
  readonly activation_id: string;
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_binding_hash: Sha256Hash;
  readonly previous_deployment_relative_path: string | null;
  readonly activation_audit_hash: Sha256Hash;
  readonly deployment_hash: Sha256Hash;
}

export interface HostCoreActivationJournalEvent {
  readonly format: 'icarus.host-core-activation-journal-event/1';
  readonly activation_id: string;
  readonly sequence: number;
  readonly phase: JournalPhase;
  readonly version: string;
  readonly target_release_artifact_hash: Sha256Hash;
  readonly target_core_binding_relative_path: string;
  readonly target_deployment_relative_path: string;
  readonly previous_event_hash: Sha256Hash | null;
  readonly occurred_at_ms: number;
  readonly event_hash: Sha256Hash;
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
const NORMAL_JOURNAL_PHASES: readonly JournalPhase[] = [
  'prepared',
  'activation_core_selected',
  'active_deployment_committed',
  'active_core_committed',
  'completed',
];
const RESET_JOURNAL_PHASES: readonly JournalPhase[] = [
  'prepared',
  'persistent_state_quarantined',
  'activation_core_selected',
  'active_deployment_committed',
  'active_core_committed',
  'completed',
];
const JOURNAL_PHASES: readonly JournalPhase[] = [
  ...new Set([...NORMAL_JOURNAL_PHASES, ...RESET_JOURNAL_PHASES]),
];

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

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value))
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
  const binding = (
    legacy
      ? {
          ...common,
          format: 'icarus.core-runtime-launch-binding/2' as const,
          binding_kind: 'content_addressed_release' as const,
        }
      : {
          ...common,
          format: 'icarus.host-core-runtime-launch-binding/1' as const,
          binding_kind: 'content_addressed_host_core_release' as const,
        }
  ) satisfies ContentAddressedCoreBinding;
  const { binding_hash: _bindingHash, ...payload } = binding;
  const domain = legacy
    ? 'icarus:core-runtime-launch-binding:2\n'
    : 'icarus:host-core-runtime-launch-binding:1\n';
  if (
    binding.binding_hash !==
    domainSeparatedSha256(domain, payload as unknown as JsonValue)
  )
    throw new Error('host_core_binding_hash_invalid');
  if (
    binding.core_release_relative_path !==
    `core-releases/${binding.release_artifact_hash.slice('sha256:'.length)}`
  )
    throw new Error('host_core_binding_release_identity_invalid');
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

function inventoryFiles(
  root: string,
  manifestName: string,
): Array<{
  path: string;
  byte_length: number;
  executable: boolean;
  raw_sha256: Sha256Hash;
}> {
  const result: Array<{
    path: string;
    byte_length: number;
    executable: boolean;
    raw_sha256: Sha256Hash;
  }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('active_core_release_symlink');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join('/');
        if (relative !== manifestName)
          result.push({
            path: relative,
            byte_length: stat.size,
            executable: (stat.mode & 0o111) !== 0,
            raw_sha256: rawSha256(absolute),
          });
      } else throw new Error('active_core_release_non_regular_file');
    }
  };
  visit(root);
  return result.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function verifyLegacyRelease(
  releaseRoot: string,
  manifestValue: Record<string, unknown>,
  expectedHash: Sha256Hash,
): ActiveHostCoreIdentity {
  assertJsonObject(manifestValue.ref);
  const version = safeId(manifestValue.ref.version, 'legacy_core_version');
  const artifactHash = parseSha256Hash(manifestValue.release_artifact_hash);
  const inventory = manifestValue.inventory;
  if (!Array.isArray(inventory))
    throw new Error('legacy_core_inventory_invalid');
  const observed = inventoryFiles(releaseRoot, HOST_CORE_MANIFEST_FILENAME);
  if (JSON.stringify(observed) !== JSON.stringify(inventory))
    throw new Error('legacy_core_inventory_mismatch');
  const inventoryHash = parseSha256Hash(manifestValue.inventory_hash);
  const coreBuildHash = parseSha256Hash(manifestValue.core_build_hash);
  const { release_artifact_hash: _releaseHash, ...payload } = manifestValue;
  if (
    manifestValue.format !== 'icarus.core-release-manifest/1' ||
    manifestValue.release_scope !== 'workflow_runtime_g8_validation' ||
    manifestValue.build_kind !== 'release' ||
    artifactHash !== expectedHash ||
    inventoryHash !==
      domainSeparatedSha256(
        'icarus:core-release-inventory:1\n',
        inventory as JsonValue,
      ) ||
    coreBuildHash !==
      domainSeparatedSha256(
        'icarus:core-release-build:1\n',
        inventory.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as Record<string, unknown>).path === 'string' &&
            ((entry as Record<string, unknown>).path as string).startsWith(
              'dist/',
            ),
        ) as JsonValue,
      ) ||
    artifactHash !==
      domainSeparatedSha256(
        'icarus:core-release-manifest:1\n',
        payload as JsonValue,
      )
  )
    throw new Error('legacy_core_identity_invalid');
  const schemaVersion = manifestValue.database_schema_version;
  if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1)
    throw new Error('legacy_core_schema_version_invalid');
  return {
    version,
    release_artifact_hash: artifactHash,
    binding_hash: `sha256:${'0'.repeat(64)}`,
    formal: false,
    binding_kind: 'content_addressed_release',
    database_schema_version: Number(schemaVersion),
    database_schema_hash: parseSha256Hash(manifestValue.database_schema_hash),
    database_sqlite_schema_hash: null,
    release_root: releaseRoot,
    core_entry_path: path.join(
      releaseRoot,
      safeRelative(manifestValue.core_entry_relative_path, 'legacy_core_entry'),
    ),
    core_entry_sha256: parseSha256Hash(manifestValue.core_entry_sha256),
    validation_entry_sha256: parseSha256Hash(
      manifestValue.validation_entry_sha256,
    ),
    core_build_hash: coreBuildHash,
    release_manifest_sha256: rawSha256(
      path.join(releaseRoot, HOST_CORE_MANIFEST_FILENAME),
    ),
    runtime_launcher_hash: parseSha256Hash(manifestValue.runtime_launcher_hash),
    managed_node_distribution_hash: parseSha256Hash(
      manifestValue.managed_node_distribution_hash,
    ),
  };
}

function readActiveBinding(runtimeHome: string): {
  binding: ContentAddressedCoreBinding;
  directory: string;
} {
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
  assertRegularFile(
    path.join(directory, 'binding.json'),
    'active_core_binding_file',
  );
  const binding = parseBinding(
    strictParseJsonBytes(fs.readFileSync(path.join(directory, 'binding.json'))),
  );
  if (path.basename(directory) !== binding.binding_hash.slice('sha256:'.length))
    throw new Error('active_core_binding_path_invalid');
  return { binding, directory };
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
  const { binding } = readActiveBinding(runtimeHome);
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
  const value = strictParseJsonBytes(fs.readFileSync(manifestPath));
  assertJsonObject(value);
  let identity: ActiveHostCoreIdentity;
  if (value.lifecycle === 'formal_host_core_release') {
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
    const legacy = verifyLegacyRelease(
      releaseRoot,
      value,
      binding.release_artifact_hash,
    );
    verifyRuntimeIdentity(runtimeHome, {
      managed_node_distribution_hash: parseSha256Hash(
        value.managed_node_distribution_hash,
      ),
      runtime_launcher_hash: parseSha256Hash(value.runtime_launcher_hash),
      runtime_toolchain_hash: parseSha256Hash(value.runtime_toolchain_hash),
    });
    identity = { ...legacy, binding_hash: binding.binding_hash };
  }
  if (
    binding.core_build_hash !== parseSha256Hash(value.core_build_hash) ||
    binding.core_entry_sha256 !== parseSha256Hash(value.core_entry_sha256) ||
    binding.validation_entry_sha256 !==
      parseSha256Hash(value.validation_entry_sha256) ||
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
    throw new Error('host_core_activation_path_invalid');
  let directory = runtimeHome;
  for (const part of path.dirname(relative).split(path.sep)) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('host_core_activation_directory_invalid');
  }
}

function durableWriteExclusive(
  runtimeHome: string,
  file: string,
  value: JsonValue,
  mode = 0o400,
): void {
  ensureSafeDirectories(runtimeHome, file);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.readFileSync(file, 'utf8') !== bytes
    )
      throw new Error('host_core_content_addressed_collision');
    return;
  }
  const descriptor = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
}

function atomicPointer(
  runtimeHome: string,
  name: 'activation-core' | 'active-core' | 'active-deployment',
  relative: string,
): void {
  safeRelative(relative, 'host_core_pointer_target');
  const pointer = path.join(runtimeHome, name);
  const existing = lstatIfPresent(pointer);
  if (existing && !existing.isSymbolicLink())
    throw new Error(`host_core_${name}_pointer_invalid`);
  const temporary = path.join(runtimeHome, `.${name}.${process.pid}.tmp`);
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(relative, temporary);
  fs.renameSync(temporary, pointer);
  fsyncDirectory(runtimeHome);
}

function installBinding(
  runtimeHome: string,
  binding: ContentAddressedCoreBinding,
): string {
  const relative = `core-bindings/${binding.binding_hash.slice('sha256:'.length)}`;
  const file = path.join(runtimeHome, relative, 'binding.json');
  durableWriteExclusive(
    runtimeHome,
    file,
    binding as unknown as JsonValue,
    0o444,
  );
  return relative;
}

function activeDeploymentRelative(runtimeHome: string): string | null {
  const pointer = path.join(runtimeHome, 'active-deployment');
  if (!lstatIfPresent(pointer)) return null;
  if (!fs.lstatSync(pointer).isSymbolicLink())
    throw new Error('active_deployment_pointer_invalid');
  return safeRelative(fs.readlinkSync(pointer), 'active_deployment_pointer');
}

export function verifyActiveHostCoreDeployment(
  runtimeHomeInput: string,
  activeInput?: ActiveHostCoreIdentity,
): {
  readonly deployment_hash: Sha256Hash;
  readonly activation_audit_hash: Sha256Hash;
} {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const active = activeInput ?? verifyActiveHostCore(runtimeHome);
  if (!active.formal)
    throw new Error('host_core_deployment_requires_formal_active_core');
  const pointer = activeDeploymentRelative(runtimeHome);
  if (!pointer || !/^deployment-bindings\/[0-9a-f]{64}$/.test(pointer))
    throw new Error('host_core_active_deployment_pointer_invalid');
  const directory = resolveRelativeDirectory(
    runtimeHome,
    pointer,
    'deployment-bindings',
  );
  const file = path.join(directory, 'host-core-deployment.json');
  assertRegularFile(file, 'host_core_active_deployment_file');
  const deployment = strictParseJsonBytes(fs.readFileSync(file));
  assertJsonObject(deployment);
  exactKeys(
    deployment,
    [
      'activation_audit_hash',
      'activation_id',
      'core_binding_hash',
      'deployment_hash',
      'format',
      'previous_deployment_relative_path',
      'release_artifact_hash',
      'version',
    ],
    'host_core_active_deployment',
  );
  if (deployment.previous_deployment_relative_path !== null)
    safeRelative(
      deployment.previous_deployment_relative_path,
      'host_core_previous_deployment',
    );
  const deploymentHash = parseSha256Hash(deployment.deployment_hash);
  const auditHash = parseSha256Hash(deployment.activation_audit_hash);
  const { deployment_hash: _deploymentHash, ...payload } = deployment;
  if (
    deployment.format !== 'icarus.host-core-deployment/1' ||
    deployment.version !== active.version ||
    deployment.release_artifact_hash !== active.release_artifact_hash ||
    deployment.core_binding_hash !== active.binding_hash ||
    deploymentHash !== `sha256:${path.basename(directory)}` ||
    deploymentHash !==
      domainSeparatedSha256(
        'icarus:host-core-deployment:1\n',
        payload as JsonValue,
      )
  )
    throw new Error('host_core_active_deployment_identity_invalid');
  return {
    deployment_hash: deploymentHash,
    activation_audit_hash: auditHash,
  };
}

function buildAudit(
  input: Omit<HostCoreActivationAudit, 'format' | 'audit_hash'>,
): HostCoreActivationAudit {
  const payload = {
    format: 'icarus.host-core-activation-audit/1' as const,
    ...input,
  };
  return {
    ...payload,
    audit_hash: domainSeparatedSha256(
      'icarus:host-core-activation-audit:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

function buildDeployment(
  input: Omit<HostCoreDeployment, 'format' | 'deployment_hash'>,
): HostCoreDeployment {
  const payload = {
    format: 'icarus.host-core-deployment/1' as const,
    ...input,
  };
  return {
    ...payload,
    deployment_hash: domainSeparatedSha256(
      'icarus:host-core-deployment:1\n',
      payload as unknown as JsonValue,
    ),
  };
}

function parseJournalEvent(value: unknown): HostCoreActivationJournalEvent {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'activation_id',
      'event_hash',
      'format',
      'occurred_at_ms',
      'phase',
      'previous_event_hash',
      'sequence',
      'target_core_binding_relative_path',
      'target_deployment_relative_path',
      'target_release_artifact_hash',
      'version',
    ],
    'host_core_activation_journal_event',
  );
  if (
    value.format !== 'icarus.host-core-activation-journal-event/1' ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !Number.isSafeInteger(value.occurred_at_ms) ||
    Number(value.occurred_at_ms) < 0 ||
    !JOURNAL_PHASES.includes(value.phase as JournalPhase)
  )
    throw new Error('host_core_activation_journal_event_invalid');
  const event: HostCoreActivationJournalEvent = {
    format: value.format,
    activation_id: safeId(value.activation_id, 'host_core_activation_id'),
    sequence: Number(value.sequence),
    phase: value.phase as JournalPhase,
    version: assertHostCoreVersion(value.version),
    target_release_artifact_hash: parseSha256Hash(
      value.target_release_artifact_hash,
    ),
    target_core_binding_relative_path: safeRelative(
      value.target_core_binding_relative_path,
      'host_core_activation_binding_path',
    ),
    target_deployment_relative_path: safeRelative(
      value.target_deployment_relative_path,
      'host_core_activation_deployment_path',
    ),
    previous_event_hash:
      value.previous_event_hash === null
        ? null
        : parseSha256Hash(value.previous_event_hash),
    occurred_at_ms: Number(value.occurred_at_ms),
    event_hash: parseSha256Hash(value.event_hash),
  };
  const { event_hash: _eventHash, ...payload } = event;
  if (
    event.event_hash !==
    domainSeparatedSha256(
      'icarus:host-core-activation-journal-event:1\n',
      payload as unknown as JsonValue,
    )
  )
    throw new Error('host_core_activation_journal_hash_invalid');
  return event;
}

function journalDirectory(runtimeHome: string, activationId: string): string {
  return path.join(runtimeHome, 'host-core-activation-journals', activationId);
}

export function readHostCoreActivationJournal(
  runtimeHomeInput: string,
  activationId: string,
): readonly HostCoreActivationJournalEvent[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  safeId(activationId, 'host_core_activation_id');
  const directory = journalDirectory(runtimeHome, activationId);
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_activation_journal_directory_invalid');
  const files = fs.readdirSync(directory).sort();
  if (files.some((file) => !/^\d{6}-[0-9a-f]{64}\.json$/.test(file)))
    throw new Error('host_core_activation_journal_file_invalid');
  const events = files.map((file) =>
    parseJournalEvent(
      strictParseJsonBytes(fs.readFileSync(path.join(directory, file))),
    ),
  );
  const phases = events.map((event) => event.phase);
  const matchesNormal = phases.every(
    (phase, index) => phase === NORMAL_JOURNAL_PHASES[index],
  );
  const matchesReset = phases.every(
    (phase, index) => phase === RESET_JOURNAL_PHASES[index],
  );
  if (!matchesNormal && !matchesReset)
    throw new Error('host_core_activation_journal_phase_invalid');
  events.forEach((event, index) => {
    if (
      event.sequence !== index + 1 ||
      event.previous_event_hash !== (events[index - 1]?.event_hash ?? null) ||
      !files[index]!.includes(event.event_hash.slice('sha256:'.length))
    )
      throw new Error('host_core_activation_journal_sequence_invalid');
  });
  return events;
}

function appendJournal(
  runtimeHome: string,
  base: Omit<
    HostCoreActivationJournalEvent,
    'format' | 'sequence' | 'phase' | 'previous_event_hash' | 'event_hash'
  >,
  events: readonly HostCoreActivationJournalEvent[],
  phase: JournalPhase,
): HostCoreActivationJournalEvent {
  const payload = {
    format: 'icarus.host-core-activation-journal-event/1' as const,
    activation_id: base.activation_id,
    sequence: events.length + 1,
    phase,
    version: base.version,
    target_release_artifact_hash: base.target_release_artifact_hash,
    target_core_binding_relative_path: base.target_core_binding_relative_path,
    target_deployment_relative_path: base.target_deployment_relative_path,
    previous_event_hash: events.at(-1)?.event_hash ?? null,
    occurred_at_ms: base.occurred_at_ms + events.length,
  };
  const event = parseJournalEvent({
    ...payload,
    event_hash: domainSeparatedSha256(
      'icarus:host-core-activation-journal-event:1\n',
      payload as unknown as JsonValue,
    ),
  });
  durableWriteExclusive(
    runtimeHome,
    path.join(
      journalDirectory(runtimeHome, base.activation_id),
      `${String(event.sequence).padStart(6, '0')}-${event.event_hash.slice('sha256:'.length)}.json`,
    ),
    event as unknown as JsonValue,
  );
  return event;
}

function targetSchemaIdentity(
  target: HostCoreReleaseManifest,
): HostCoreTargetSchemaIdentity {
  return {
    database_schema_version: target.database_schema_version,
    database_schema_hash: target.database_schema_hash,
    database_sqlite_schema_hash: target.database_sqlite_schema_hash,
  };
}

function assertLightweightReadiness(
  runtimeHome: string,
  entry: HostCoreRegistryEntry,
): void {
  const core = path.join(
    runtimeHome,
    entry.release_relative_path,
    HOST_CORE_ENTRY,
  );
  const result = spawnSync(process.execPath, ['--check', core], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  if (result.status !== 0)
    throw new Error(`host_core_activation_readiness_failed:${result.stderr}`);
}

function verifyTransactionObjects(
  runtimeHome: string,
  first: HostCoreActivationJournalEvent,
): {
  readonly persistentStateAction: HostCoreActivationAudit['persistent_state_action'];
  readonly resetPlan: PersistentStateResetPlan | null;
} {
  const bindingDirectory = resolveRelativeDirectory(
    runtimeHome,
    first.target_core_binding_relative_path,
    'core-bindings',
  );
  assertRegularFile(
    path.join(bindingDirectory, 'binding.json'),
    'host_core_recovery_binding_file',
  );
  const binding = parseBinding(
    strictParseJsonBytes(
      fs.readFileSync(path.join(bindingDirectory, 'binding.json')),
    ),
  );
  if (
    binding.binding_hash.slice('sha256:'.length) !==
      path.basename(bindingDirectory) ||
    binding.release_artifact_hash !== first.target_release_artifact_hash
  )
    throw new Error('host_core_recovery_binding_invalid');
  const resolved = resolveHostCoreVersion(runtimeHome, first.version);
  if (
    resolved.entry.release_artifact_hash !== first.target_release_artifact_hash
  )
    throw new Error('host_core_recovery_registry_invalid');
  const deploymentDirectory = resolveRelativeDirectory(
    runtimeHome,
    first.target_deployment_relative_path,
    'deployment-bindings',
  );
  assertRegularFile(
    path.join(deploymentDirectory, 'host-core-deployment.json'),
    'host_core_recovery_deployment_file',
  );
  const deployment = strictParseJsonBytes(
    fs.readFileSync(
      path.join(deploymentDirectory, 'host-core-deployment.json'),
    ),
  );
  assertJsonObject(deployment);
  exactKeys(
    deployment,
    [
      'activation_audit_hash',
      'activation_id',
      'core_binding_hash',
      'deployment_hash',
      'format',
      'previous_deployment_relative_path',
      'release_artifact_hash',
      'version',
    ],
    'host_core_recovery_deployment',
  );
  const deploymentHash = parseSha256Hash(deployment.deployment_hash);
  const auditHash = parseSha256Hash(deployment.activation_audit_hash);
  if (
    deployment.format !== 'icarus.host-core-deployment/1' ||
    deployment.activation_id !== first.activation_id ||
    deployment.release_artifact_hash !== first.target_release_artifact_hash ||
    deployment.core_binding_hash !== binding.binding_hash ||
    deploymentHash !== `sha256:${path.basename(deploymentDirectory)}`
  )
    throw new Error('host_core_recovery_deployment_invalid');
  const { deployment_hash: _deploymentHash, ...payload } = deployment;
  if (
    deploymentHash !==
    domainSeparatedSha256(
      'icarus:host-core-deployment:1\n',
      payload as JsonValue,
    )
  )
    throw new Error('host_core_recovery_deployment_hash_invalid');
  const auditFile = path.join(
    runtimeHome,
    'host-core-activation-audits',
    auditHash.slice('sha256:'.length),
    'activation-audit.json',
  );
  assertRegularFile(auditFile, 'host_core_recovery_audit_file');
  const audit = strictParseJsonBytes(fs.readFileSync(auditFile));
  assertJsonObject(audit);
  exactKeys(
    audit,
    [
      'activation_id',
      'audit_hash',
      'format',
      'previous_core_binding_hash',
      'previous_release_artifact_hash',
      'previous_version',
      'old_persistent_state_identity',
      'persistent_state_action',
      'persistent_state_backup_identity',
      'persistent_state_backup_relative_path',
      'persistent_state_reset_plan',
      'persistent_state_rollback',
      'readiness_status',
      'requested_at_ms',
      'rollback',
      'target_core_binding_hash',
      'target_persistent_state_identity',
      'target_release_artifact_hash',
      'validation_status',
      'validation_commands',
      'version',
    ],
    'host_core_recovery_audit',
  );
  const { audit_hash: _auditHash, ...auditPayload } = audit;
  const persistentStateAction = audit.persistent_state_action;
  if (
    persistentStateAction !== 'NO_STATE' &&
    persistentStateAction !== 'UNCHANGED' &&
    persistentStateAction !== 'MIGRATION_ON_START' &&
    persistentStateAction !== 'RESET_BY_USER'
  )
    throw new Error('host_core_recovery_persistent_state_action_invalid');
  if (
    JSON.stringify(audit.target_persistent_state_identity) !==
      JSON.stringify(targetSchemaIdentity(resolved.manifest)) ||
    (audit.readiness_status !== 'PASS' &&
      audit.readiness_status !== 'SKIPPED_BY_USER') ||
    (audit.persistent_state_rollback !==
      'CODE_ROLLBACK_STATE_COMPATIBILITY_REQUIRED' &&
      audit.persistent_state_rollback !==
        'CODE_ROLLBACK_DOES_NOT_RESTORE_QUARANTINED_STATE')
  )
    throw new Error('host_core_recovery_persistent_state_identity_invalid');
  const resetPlan =
    persistentStateAction === 'RESET_BY_USER'
      ? parsePersistentStateResetPlan(audit.persistent_state_reset_plan)
      : null;
  if (
    (resetPlan === null &&
      (audit.persistent_state_reset_plan !== null ||
        audit.persistent_state_backup_identity !== null ||
        audit.persistent_state_backup_relative_path !== null ||
        audit.persistent_state_rollback !==
          'CODE_ROLLBACK_STATE_COMPATIBILITY_REQUIRED')) ||
    (resetPlan !== null &&
      (audit.persistent_state_backup_identity !== resetPlan.backup_identity ||
        audit.persistent_state_backup_relative_path !==
          resetPlan.backup_relative_path ||
        audit.persistent_state_rollback !==
          'CODE_ROLLBACK_DOES_NOT_RESTORE_QUARANTINED_STATE'))
  )
    throw new Error('host_core_recovery_persistent_state_backup_invalid');
  if (
    audit.format !== 'icarus.host-core-activation-audit/1' ||
    audit.activation_id !== first.activation_id ||
    audit.version !== first.version ||
    audit.target_release_artifact_hash !== first.target_release_artifact_hash ||
    audit.target_core_binding_hash !== binding.binding_hash ||
    JSON.stringify(audit.validation_commands) !==
      JSON.stringify(resolved.manifest.validation_commands) ||
    audit.validation_status !== resolved.manifest.validation_status ||
    auditHash !==
      domainSeparatedSha256(
        'icarus:host-core-activation-audit:1\n',
        auditPayload as JsonValue,
      )
  )
    throw new Error('host_core_recovery_audit_invalid');
  return { persistentStateAction, resetPlan };
}

function recoverJournal(
  runtimeHome: string,
  activationId: string,
): HostCoreActivationJournalEvent {
  let events = [...readHostCoreActivationJournal(runtimeHome, activationId)];
  if (events.length === 0) throw new Error('host_core_recovery_journal_empty');
  const first = events[0]!;
  const transaction = verifyTransactionObjects(runtimeHome, first);
  const base = {
    activation_id: first.activation_id,
    version: first.version,
    target_release_artifact_hash: first.target_release_artifact_hash,
    target_core_binding_relative_path: first.target_core_binding_relative_path,
    target_deployment_relative_path: first.target_deployment_relative_path,
    occurred_at_ms: first.occurred_at_ms,
  };
  const expected = transaction.resetPlan
    ? RESET_JOURNAL_PHASES
    : NORMAL_JOURNAL_PHASES;
  if (
    transaction.resetPlan &&
    events.some((event) => event.phase === 'persistent_state_quarantined')
  )
    readPersistentStateResetBackup(
      runtimeHome,
      transaction.resetPlan.backup_relative_path,
    );
  while (events.length < expected.length) {
    const phase = expected[events.length]!;
    if (phase === 'persistent_state_quarantined') {
      quarantinePersistentState(runtimeHome, transaction.resetPlan!);
    } else if (phase === 'activation_core_selected') {
      atomicPointer(
        runtimeHome,
        'activation-core',
        first.target_core_binding_relative_path,
      );
    } else if (phase === 'active_deployment_committed') {
      atomicPointer(
        runtimeHome,
        'active-deployment',
        first.target_deployment_relative_path,
      );
    } else if (phase === 'active_core_committed') {
      atomicPointer(
        runtimeHome,
        'active-core',
        first.target_core_binding_relative_path,
      );
    }
    events.push(appendJournal(runtimeHome, base, events, phase));
  }
  return events.at(-1)!;
}

function recoverHostCoreActivationsUnlocked(
  runtimeHome: string,
): readonly Sha256Hash[] {
  const root = path.join(runtimeHome, 'host-core-activation-journals');
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory()))
    throw new Error('host_core_activation_journal_root_invalid');
  const recovered: Sha256Hash[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const events = readHostCoreActivationJournal(runtimeHome, entry.name);
    const head = events.at(-1);
    if (!head || head.phase === 'completed') continue;
    recovered.push(recoverJournal(runtimeHome, entry.name).event_hash);
  }
  return recovered;
}

export function recoverHostCoreActivations(
  runtimeHomeInput: string,
): readonly Sha256Hash[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const lock = acquireHostCoreLock({
    runtimeHome,
    name: '.host-core-activation.lock',
    busyError: 'host_core_activation_busy',
  });
  try {
    return recoverHostCoreActivationsUnlocked(runtimeHome);
  } finally {
    lock.release();
  }
}

export interface HostCoreActivationPreflight {
  readonly current: ActiveHostCoreIdentity | null;
  readonly target: HostCoreReleaseManifest;
  readonly persistent_state: PersistentStateDecision;
}

export function inspectHostCoreActivation(
  runtimeHomeInput: string,
  version: string,
): HostCoreActivationPreflight {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const target = resolveHostCoreVersion(runtimeHome, version).manifest;
  const current = lstatIfPresent(path.join(runtimeHome, 'active-core'))
    ? verifyActiveHostCore(runtimeHome)
    : null;
  return {
    current,
    target,
    persistent_state: decidePersistentStateCompatibility(
      runtimeHome,
      targetSchemaIdentity(target),
    ),
  };
}

export interface ActivateHostCoreOptions {
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation: boolean;
  readonly resetIncompatibleState?: boolean;
  readonly confirm: (
    current: ActiveHostCoreIdentity | null,
    target: HostCoreReleaseManifest,
    persistentState: PersistentStateDecision,
  ) => boolean;
  readonly now?: () => number;
  readonly activationId?: string;
}

export interface PreparedHostCoreActivation {
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_binding_hash: Sha256Hash;
  readonly activation_audit_hash: Sha256Hash;
  readonly activation_id: string;
  readonly prepared_journal_hash: Sha256Hash;
  readonly rollback: boolean;
}

function persistentStateAction(
  decision: PersistentStateDecision,
  reset: boolean,
): HostCoreActivationAudit['persistent_state_action'] {
  if (reset) return 'RESET_BY_USER';
  if (decision.decision === 'NO_STATE') return 'NO_STATE';
  if (decision.decision === 'SAME_SCHEMA') return 'UNCHANGED';
  return 'MIGRATION_ON_START';
}

function prepareHostCoreActivationUnlocked(
  options: ActivateHostCoreOptions,
  runtimeHome: string,
): PreparedHostCoreActivation {
  const { entry, manifest } = resolveHostCoreVersion(
    runtimeHome,
    options.version,
  );
  let current: ActiveHostCoreIdentity | null = null;
  if (lstatIfPresent(path.join(runtimeHome, 'active-core')))
    current = verifyActiveHostCore(runtimeHome);
  const persistentState = decidePersistentStateCompatibility(
    runtimeHome,
    targetSchemaIdentity(manifest),
  );
  if (persistentState.decision === 'UNKNOWN_BLOCKED')
    throw new Error(
      `host_core_persistent_state_unknown:${persistentState.reason}`,
    );
  const reset = persistentState.decision === 'RESET_REQUIRED';
  if (reset && !options.resetIncompatibleState)
    throw new Error(
      `host_core_persistent_state_RESET_REQUIRED:${persistentState.reason}`,
    );
  if (!reset && options.resetIncompatibleState)
    throw new Error('host_core_persistent_state_reset_not_required');
  if (!options.confirm(current, manifest, persistentState))
    throw new Error('host_core_activation_cancelled');
  if (!options.skipValidation) assertLightweightReadiness(runtimeHome, entry);

  const manifestPath = path.join(
    runtimeHome,
    entry.release_relative_path,
    HOST_CORE_MANIFEST_FILENAME,
  );
  const binding = buildBinding(manifest, rawSha256(manifestPath));
  const bindingRelative = installBinding(runtimeHome, binding);
  const requestedAt = (options.now ?? Date.now)();
  const activationId = safeId(
    options.activationId ??
      `host-core-${requestedAt}-${crypto.randomBytes(6).toString('hex')}`,
    'host_core_activation_id',
  );
  const targetRegistrySequence = entry.registration_sequence;
  const currentRegistrySequence = current?.formal
    ? resolveHostCoreVersion(runtimeHome, current.version).entry
        .registration_sequence
    : null;
  const rollback =
    currentRegistrySequence !== null &&
    targetRegistrySequence < currentRegistrySequence;
  const resetPlan = reset
    ? buildPersistentStateResetPlan(persistentState)
    : null;
  const stateAction = persistentStateAction(persistentState, reset);
  const audit = buildAudit({
    activation_id: activationId,
    requested_at_ms: requestedAt,
    version: manifest.ref.version,
    target_release_artifact_hash: manifest.release_artifact_hash,
    target_core_binding_hash: binding.binding_hash,
    previous_version: current?.version ?? null,
    previous_release_artifact_hash: current?.release_artifact_hash ?? null,
    previous_core_binding_hash: current?.binding_hash ?? null,
    validation_status: manifest.validation_status,
    validation_commands: manifest.validation_commands,
    readiness_status: options.skipValidation ? 'SKIPPED_BY_USER' : 'PASS',
    persistent_state_action: stateAction,
    old_persistent_state_identity: persistentState.old_identity,
    target_persistent_state_identity: persistentState.target_identity,
    persistent_state_backup_identity: resetPlan?.backup_identity ?? null,
    persistent_state_backup_relative_path:
      resetPlan?.backup_relative_path ?? null,
    persistent_state_reset_plan: resetPlan,
    persistent_state_rollback: reset
      ? 'CODE_ROLLBACK_DOES_NOT_RESTORE_QUARANTINED_STATE'
      : 'CODE_ROLLBACK_STATE_COMPATIBILITY_REQUIRED',
    rollback,
  });
  const deployment = buildDeployment({
    activation_id: activationId,
    version: manifest.ref.version,
    release_artifact_hash: manifest.release_artifact_hash,
    core_binding_hash: binding.binding_hash,
    previous_deployment_relative_path: activeDeploymentRelative(runtimeHome),
    activation_audit_hash: audit.audit_hash,
  });
  const deploymentRelative = `deployment-bindings/${deployment.deployment_hash.slice('sha256:'.length)}`;
  durableWriteExclusive(
    runtimeHome,
    path.join(runtimeHome, deploymentRelative, 'host-core-deployment.json'),
    deployment as unknown as JsonValue,
  );
  durableWriteExclusive(
    runtimeHome,
    path.join(
      runtimeHome,
      'host-core-activation-audits',
      audit.audit_hash.slice('sha256:'.length),
      'activation-audit.json',
    ),
    audit as unknown as JsonValue,
  );
  const base = {
    activation_id: activationId,
    version: manifest.ref.version,
    target_release_artifact_hash: manifest.release_artifact_hash,
    target_core_binding_relative_path: bindingRelative,
    target_deployment_relative_path: deploymentRelative,
    occurred_at_ms: requestedAt,
  };
  const prepared = appendJournal(runtimeHome, base, [], 'prepared');
  return {
    version: manifest.ref.version,
    release_artifact_hash: manifest.release_artifact_hash,
    core_binding_hash: binding.binding_hash,
    activation_audit_hash: audit.audit_hash,
    activation_id: activationId,
    prepared_journal_hash: prepared.event_hash,
    rollback,
  };
}

export function prepareHostCoreActivation(
  options: ActivateHostCoreOptions,
): PreparedHostCoreActivation {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const lock = acquireHostCoreLock({
    runtimeHome,
    name: '.host-core-activation.lock',
    busyError: 'host_core_activation_busy',
  });
  try {
    recoverHostCoreActivationsUnlocked(runtimeHome);
    return prepareHostCoreActivationUnlocked(options, runtimeHome);
  } finally {
    lock.release();
  }
}

export function activateHostCoreRelease(options: ActivateHostCoreOptions): {
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly core_binding_hash: Sha256Hash;
  readonly activation_audit_hash: Sha256Hash;
  readonly journal_head_hash: Sha256Hash;
  readonly rollback: boolean;
} {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const lock = acquireHostCoreLock({
    runtimeHome,
    name: '.host-core-activation.lock',
    busyError: 'host_core_activation_busy',
  });
  try {
    recoverHostCoreActivationsUnlocked(runtimeHome);
    const prepared = prepareHostCoreActivationUnlocked(options, runtimeHome);
    const completed = recoverJournal(runtimeHome, prepared.activation_id);
    if (completed.phase !== 'completed')
      throw new Error('host_core_activation_recovery_incomplete');
    return {
      version: prepared.version,
      release_artifact_hash: prepared.release_artifact_hash,
      core_binding_hash: prepared.core_binding_hash,
      activation_audit_hash: prepared.activation_audit_hash,
      journal_head_hash: completed.event_hash,
      rollback: prepared.rollback,
    };
  } finally {
    lock.release();
  }
}
