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

interface ContentAddressedCoreBinding {
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

export interface ActiveHostCoreIdentity {
  readonly version: string;
  readonly release_artifact_hash: Sha256Hash;
  readonly binding_hash: Sha256Hash;
  readonly formal: boolean;
  readonly database_schema_version: number;
  readonly database_schema_hash: Sha256Hash;
}

type ActivationReadinessStatus = 'PASS' | 'SKIPPED_BY_USER';
type JournalPhase =
  | 'prepared'
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
  readonly readiness_status: ActivationReadinessStatus;
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
const JOURNAL_PHASES: readonly JournalPhase[] = [
  'prepared',
  'activation_core_selected',
  'active_deployment_committed',
  'active_core_committed',
  'completed',
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
  if (
    value.format !== 'icarus.core-runtime-launch-binding/2' ||
    value.binding_kind !== 'content_addressed_release' ||
    value.release_manifest_relative_path !== HOST_CORE_MANIFEST_FILENAME
  )
    throw new Error('host_core_binding_identity_invalid');
  const binding: ContentAddressedCoreBinding = {
    format: value.format,
    binding_kind: value.binding_kind,
    core_release_relative_path: safeRelative(
      value.core_release_relative_path,
      'host_core_binding_release_path',
    ),
    release_manifest_relative_path: value.release_manifest_relative_path,
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
  const { binding_hash: _bindingHash, ...payload } = binding;
  if (
    binding.binding_hash !==
    domainSeparatedSha256(
      'icarus:core-runtime-launch-binding:2\n',
      payload as unknown as JsonValue,
    )
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
): ContentAddressedCoreBinding {
  const payload = {
    format: 'icarus.core-runtime-launch-binding/2' as const,
    binding_kind: 'content_addressed_release' as const,
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
      'icarus:core-runtime-launch-binding:2\n',
      payload as unknown as JsonValue,
    ),
  });
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
    database_schema_version: Number(schemaVersion),
    database_schema_hash: parseSha256Hash(manifestValue.database_schema_hash),
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
      database_schema_version: manifest.database_schema_version,
      database_schema_hash: manifest.database_schema_hash,
    };
  } else {
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
  events.forEach((event, index) => {
    if (
      event.sequence !== index + 1 ||
      event.phase !== JOURNAL_PHASES[index] ||
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

function assertPersistentCompatibility(
  runtimeHome: string,
  current: ActiveHostCoreIdentity | null,
  target: HostCoreReleaseManifest,
): void {
  const database = lstatIfPresent(
    path.join(runtimeHome, 'data/workflow-runtime/workflow-runtime.db'),
  );
  if (database) {
    if (!database.isFile() || database.isSymbolicLink())
      throw new Error('host_core_persistent_state_file_invalid');
    if (!current)
      throw new Error('host_core_persistent_state_identity_missing');
  }
  if (
    current &&
    (current.database_schema_version !== target.database_schema_version ||
      current.database_schema_hash !== target.database_schema_hash)
  )
    throw new Error('host_core_persistent_state_incompatible');
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
): void {
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
    'host-core-deployments',
  );
  assertRegularFile(
    path.join(deploymentDirectory, 'deployment.json'),
    'host_core_recovery_deployment_file',
  );
  const deployment = strictParseJsonBytes(
    fs.readFileSync(path.join(deploymentDirectory, 'deployment.json')),
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
      'readiness_status',
      'requested_at_ms',
      'rollback',
      'target_core_binding_hash',
      'target_release_artifact_hash',
      'validation_status',
      'version',
    ],
    'host_core_recovery_audit',
  );
  const { audit_hash: _auditHash, ...auditPayload } = audit;
  if (
    audit.format !== 'icarus.host-core-activation-audit/1' ||
    audit.activation_id !== first.activation_id ||
    audit.version !== first.version ||
    audit.target_release_artifact_hash !== first.target_release_artifact_hash ||
    audit.target_core_binding_hash !== binding.binding_hash ||
    auditHash !==
      domainSeparatedSha256(
        'icarus:host-core-activation-audit:1\n',
        auditPayload as JsonValue,
      )
  )
    throw new Error('host_core_recovery_audit_invalid');
}

function recoverJournal(
  runtimeHome: string,
  activationId: string,
): HostCoreActivationJournalEvent {
  let events = [...readHostCoreActivationJournal(runtimeHome, activationId)];
  if (events.length === 0) throw new Error('host_core_recovery_journal_empty');
  const first = events[0]!;
  verifyTransactionObjects(runtimeHome, first);
  const base = {
    activation_id: first.activation_id,
    version: first.version,
    target_release_artifact_hash: first.target_release_artifact_hash,
    target_core_binding_relative_path: first.target_core_binding_relative_path,
    target_deployment_relative_path: first.target_deployment_relative_path,
    occurred_at_ms: first.occurred_at_ms,
  };
  if (events.length === 1) {
    atomicPointer(
      runtimeHome,
      'activation-core',
      first.target_core_binding_relative_path,
    );
    events.push(
      appendJournal(runtimeHome, base, events, 'activation_core_selected'),
    );
  }
  if (events.length === 2) {
    atomicPointer(
      runtimeHome,
      'active-deployment',
      first.target_deployment_relative_path,
    );
    events.push(
      appendJournal(runtimeHome, base, events, 'active_deployment_committed'),
    );
  }
  if (events.length === 3) {
    atomicPointer(
      runtimeHome,
      'active-core',
      first.target_core_binding_relative_path,
    );
    events.push(
      appendJournal(runtimeHome, base, events, 'active_core_committed'),
    );
  }
  if (events.length === 4)
    events.push(appendJournal(runtimeHome, base, events, 'completed'));
  return events.at(-1)!;
}

export function recoverHostCoreActivations(
  runtimeHomeInput: string,
): readonly Sha256Hash[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
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

export interface ActivateHostCoreOptions {
  readonly runtimeHome: string;
  readonly version: string;
  readonly skipValidation: boolean;
  readonly confirm: (
    current: ActiveHostCoreIdentity | null,
    target: HostCoreReleaseManifest,
  ) => boolean;
  readonly now?: () => number;
  readonly activationId?: string;
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
  const lock = path.join(runtimeHome, '.host-core-activation.lock');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('host_core_activation_busy');
    throw error;
  }
  try {
    recoverHostCoreActivations(runtimeHome);
    const { entry, manifest } = resolveHostCoreVersion(
      runtimeHome,
      options.version,
    );
    let current: ActiveHostCoreIdentity | null = null;
    if (lstatIfPresent(path.join(runtimeHome, 'active-core')))
      current = verifyActiveHostCore(runtimeHome);
    assertPersistentCompatibility(runtimeHome, current, manifest);
    if (!options.confirm(current, manifest))
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
      readiness_status: options.skipValidation ? 'SKIPPED_BY_USER' : 'PASS',
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
    const deploymentRelative = `host-core-deployments/${deployment.deployment_hash.slice('sha256:'.length)}`;
    durableWriteExclusive(
      runtimeHome,
      path.join(runtimeHome, deploymentRelative, 'deployment.json'),
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
    const completed = recoverJournal(runtimeHome, prepared.activation_id);
    return {
      version: manifest.ref.version,
      release_artifact_hash: manifest.release_artifact_hash,
      core_binding_hash: binding.binding_hash,
      activation_audit_hash: audit.audit_hash,
      journal_head_hash: completed.event_hash,
      rollback,
    };
  } finally {
    fs.rmdirSync(lock);
  }
}
