import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  assertCurrentWorkflowRuntimeStructure,
  inspectWorkflowRuntimeSchema,
} from '../workflow-runtime/gateway/host-core.js';

export interface HostCoreTargetSchema {
  readonly database_schema_version: number;
  readonly minimum_supported_schema_version: number;
}

export interface WorkflowRuntimeSchemaCompatibility {
  readonly format: 'icarus.workflow-runtime-schema-compatibility/2';
  readonly current_version: number;
  readonly minimum_supported_version: number;
}

export interface WorkflowRuntimeStateSchema {
  readonly database_schema_version: number;
}

export type PersistentStateDecisionKind =
  | 'NO_STATE'
  | 'SAME_SCHEMA'
  | 'RESET_REQUIRED'
  | 'UNKNOWN_BLOCKED';

export interface StateBackupMember {
  readonly source_relative_path: string;
  readonly backup_name: string;
  readonly byte_length: number;
  readonly checksum: string;
}

export interface PersistentStateDecision {
  readonly decision: PersistentStateDecisionKind;
  readonly observed_schema: WorkflowRuntimeStateSchema | null;
  readonly target_schema: HostCoreTargetSchema;
  readonly affected_paths: readonly string[];
  readonly members: readonly StateBackupMember[];
  readonly reason: string;
}

export type PersistentStateBackupOperation = 'backup' | 'reset';
export type PersistentStateBackupStatus = 'in_progress' | 'complete';

export interface PersistentStateBackupManifest {
  readonly format: 'icarus.workflow-runtime-state-backup/3';
  readonly backup_id: string;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly operation: PersistentStateBackupOperation;
  readonly status: PersistentStateBackupStatus;
  readonly source_relative_paths: readonly string[];
  readonly observed_schema_version: number;
  readonly target_schema_version: number;
  readonly members: readonly StateBackupMember[];
}

interface LegacyPersistentStateBackup {
  readonly format: 'icarus.workflow-runtime-state-quarantine/2';
  readonly backup_id: string;
  readonly backup_relative_path: string;
  readonly observed_schema_version: number;
  readonly target_schema_version: number;
  readonly members: readonly StateBackupMember[];
}

export interface PersistentStateBackupSummary {
  readonly backup_id: string;
  readonly created_at: string | null;
  readonly operation: PersistentStateBackupOperation | 'legacy_reset';
  readonly status: PersistentStateBackupStatus | 'legacy_complete';
  readonly observed_schema_version: number;
  readonly target_schema_version: number;
  readonly legacy: boolean;
}

export type PersistentStateFaultStage =
  | 'before_copy'
  | 'during_copy'
  | 'after_manifest_write'
  | 'before_live_deletion'
  | 'during_restore';

export interface PersistentStateOperationHooks {
  readonly fault?: (
    stage: PersistentStateFaultStage,
    member?: StateBackupMember,
  ) => void;
  readonly completedAt?: () => Date;
}

export const WORKFLOW_STATE_DATABASE_RELATIVE =
  'data/workflow-runtime/workflow-runtime.db';
export const WORKFLOW_STATE_BACKUP_DIRECTORY = 'workflow-runtime-state-backups';
export const WORKFLOW_STATE_BACKUP_MANIFEST = 'backup.json';
export const WORKFLOW_STATE_INCOMPLETE_MARKER = '.incomplete';
export const WORKFLOW_STATE_RELATIVE_PATHS = [
  WORKFLOW_STATE_DATABASE_RELATIVE,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-wal`,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-shm`,
] as const;

const NEW_BACKUP_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
const LEGACY_BACKUP_ID = /^[0-9a-f]{64}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const require = createRequire(import.meta.url);

export function currentWorkflowRuntimeSchemaCompatibility(): WorkflowRuntimeSchemaCompatibility {
  return {
    format: 'icarus.workflow-runtime-schema-compatibility/2',
    current_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    minimum_supported_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  };
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(file: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureDirectory(root: string, relative: string): string {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('host_core_state_backup_directory_invalid');
  }
  return current;
}

function assertBackupId(backupId: string): string {
  if (!NEW_BACKUP_ID.test(backupId) && !LEGACY_BACKUP_ID.test(backupId))
    throw new Error('host_core_state_backup_id_invalid');
  return backupId;
}

function backupRoot(runtimeHome: string, backupId: string): string {
  return path.join(
    runtimeHome,
    WORKFLOW_STATE_BACKUP_DIRECTORY,
    assertBackupId(backupId),
  );
}

function formatBackupId(now: Date, randomSuffix: string): string {
  if (Number.isNaN(now.getTime()) || !/^[0-9a-f]{8}$/.test(randomSuffix))
    throw new Error('host_core_state_backup_id_invalid');
  const timestamp = now
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.', '');
  return `${timestamp}-${randomSuffix}`;
}

function stateMembers(runtimeHome: string): StateBackupMember[] {
  const members: StateBackupMember[] = [];
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS) {
    const absolute = path.join(runtimeHome, relative);
    const stat = lstatIfPresent(absolute);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('host_core_persistent_state_file_invalid');
    if (fs.realpathSync(path.dirname(absolute)) !== path.dirname(absolute))
      throw new Error('host_core_persistent_state_directory_invalid');
    members.push({
      source_relative_path: relative,
      backup_name: path.basename(relative),
      byte_length: stat.size,
      checksum: sha256(absolute),
    });
  }
  return members;
}

function assertStatePaths(runtimeHome: string): void {
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS) {
    const absolute = path.join(runtimeHome, relative);
    const stat = lstatIfPresent(absolute);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('host_core_persistent_state_file_invalid');
    if (fs.realpathSync(path.dirname(absolute)) !== path.dirname(absolute))
      throw new Error('host_core_persistent_state_directory_invalid');
  }
}

function presentStatePaths(runtimeHome: string): string[] {
  return WORKFLOW_STATE_RELATIVE_PATHS.map((relative) =>
    path.join(runtimeHome, relative),
  ).filter((absolute) => lstatIfPresent(absolute) !== null);
}

function assertTarget(input: HostCoreTargetSchema): HostCoreTargetSchema {
  if (
    !Number.isSafeInteger(input.database_schema_version) ||
    input.database_schema_version < 1 ||
    !Number.isSafeInteger(input.minimum_supported_schema_version) ||
    input.minimum_supported_schema_version < 1 ||
    input.minimum_supported_schema_version > input.database_schema_version
  )
    throw new Error('host_core_target_schema_version_invalid');
  return { ...input };
}

function inspectDatabase(databasePath: string): {
  schema: WorkflowRuntimeStateSchema;
} {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const inspection = inspectWorkflowRuntimeSchema(database);
    if (inspection.schemaVersion < 1)
      throw new Error('workflow_runtime_schema_version_invalid');
    if (inspection.current) assertCurrentWorkflowRuntimeStructure(database);
    return {
      schema: { database_schema_version: inspection.schemaVersion },
    };
  } finally {
    database.close();
  }
}

function verifyRestoredDatabase(
  databasePath: string,
  expectedSchemaVersion: number,
): void {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const inspection = inspectWorkflowRuntimeSchema(database);
    if (inspection.schemaVersion !== expectedSchemaVersion)
      throw new Error('host_core_state_restore_schema_version_mismatch');
    if (inspection.current) assertCurrentWorkflowRuntimeStructure(database);
    const integrity = database.pragma('integrity_check', {
      simple: true,
    }) as unknown;
    if (integrity !== 'ok')
      throw new Error('host_core_state_restore_integrity_check_failed');
  } finally {
    database.close();
  }
}

export function parseWorkflowRuntimeSchemaCompatibility(
  value: unknown,
): WorkflowRuntimeSchemaCompatibility {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('host_core_schema_compatibility_invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify([
        'current_version',
        'format',
        'minimum_supported_version',
      ]) ||
    record.format !== 'icarus.workflow-runtime-schema-compatibility/2'
  )
    throw new Error('host_core_schema_compatibility_invalid');
  return {
    format: 'icarus.workflow-runtime-schema-compatibility/2',
    current_version: assertTarget({
      database_schema_version: Number(record.current_version),
      minimum_supported_schema_version: Number(
        record.minimum_supported_version,
      ),
    }).database_schema_version,
    minimum_supported_version: Number(record.minimum_supported_version),
  };
}

export function decidePersistentStateCompatibility(
  runtimeHomeInput: string,
  targetInput: HostCoreTargetSchema,
  compatibilityInput: WorkflowRuntimeSchemaCompatibility | null = currentWorkflowRuntimeSchemaCompatibility(),
): PersistentStateDecision {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const target = assertTarget(targetInput);
  const compatibility = compatibilityInput
    ? parseWorkflowRuntimeSchemaCompatibility(compatibilityInput)
    : null;
  if (
    compatibility &&
    (compatibility.current_version !== target.database_schema_version ||
      compatibility.minimum_supported_version !==
        target.minimum_supported_schema_version)
  )
    throw new Error('host_core_schema_compatibility_target_mismatch');

  try {
    assertStatePaths(runtimeHome);
  } catch {
    return {
      decision: 'UNKNOWN_BLOCKED',
      observed_schema: null,
      target_schema: target,
      affected_paths: presentStatePaths(runtimeHome),
      members: [],
      reason: 'persistent_state_path_invalid',
    };
  }
  const databasePath = path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE);
  const affectedPaths = presentStatePaths(runtimeHome);
  if (!lstatIfPresent(databasePath)) {
    return affectedPaths.length === 0
      ? {
          decision: 'NO_STATE',
          observed_schema: null,
          target_schema: target,
          affected_paths: [],
          members: [],
          reason: 'no_workflow_runtime_database',
        }
      : {
          decision: 'UNKNOWN_BLOCKED',
          observed_schema: null,
          target_schema: target,
          affected_paths: affectedPaths,
          members: [],
          reason: 'database_companion_without_primary',
        };
  }

  let observed: ReturnType<typeof inspectDatabase>;
  try {
    observed = inspectDatabase(databasePath);
  } catch (error) {
    return {
      decision: 'UNKNOWN_BLOCKED',
      observed_schema: null,
      target_schema: target,
      affected_paths: affectedPaths,
      members: [],
      reason:
        error instanceof Error && error.message.includes('missing required')
          ? 'database_required_structure_missing'
          : 'database_schema_unverifiable',
    };
  }
  const members = stateMembers(runtimeHome);
  const version = observed.schema.database_schema_version;
  if (version === target.database_schema_version)
    return {
      decision: 'SAME_SCHEMA',
      observed_schema: observed.schema,
      target_schema: target,
      affected_paths: affectedPaths,
      members,
      reason: 'same_schema_version_and_required_structure',
    };
  if (!compatibility)
    return {
      decision: 'UNKNOWN_BLOCKED',
      observed_schema: observed.schema,
      target_schema: target,
      affected_paths: affectedPaths,
      members,
      reason: 'schema_compatibility_unavailable',
    };
  if (version > target.database_schema_version)
    return {
      decision: 'UNKNOWN_BLOCKED',
      observed_schema: observed.schema,
      target_schema: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_schema_newer_than_target',
    };
  if (version < target.minimum_supported_schema_version)
    return {
      decision: 'RESET_REQUIRED',
      observed_schema: observed.schema,
      target_schema: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_schema_older_than_supported_range',
    };
  return {
    decision: 'RESET_REQUIRED',
    observed_schema: observed.schema,
    target_schema: target,
    affected_paths: affectedPaths,
    members,
    reason: 'database_schema_requires_latest_only_reset',
  };
}

export function buildPersistentStateBackupManifest(
  decision: PersistentStateDecision,
  options: {
    readonly operation: PersistentStateBackupOperation;
    readonly now?: Date;
    readonly randomSuffix?: string;
  },
): PersistentStateBackupManifest {
  if (!decision.observed_schema || decision.members.length < 1)
    throw new Error('host_core_persistent_state_backup_not_available');
  if (decision.decision === 'UNKNOWN_BLOCKED')
    throw new Error('host_core_persistent_state_backup_unverifiable');
  if (options.operation === 'reset' && decision.decision !== 'RESET_REQUIRED')
    throw new Error('host_core_persistent_state_reset_not_available');
  const createdAt = (options.now ?? new Date()).toISOString();
  const backupId = formatBackupId(
    new Date(createdAt),
    options.randomSuffix ?? crypto.randomBytes(4).toString('hex'),
  );
  return {
    format: 'icarus.workflow-runtime-state-backup/3',
    backup_id: backupId,
    created_at: createdAt,
    completed_at: null,
    operation: options.operation,
    status: 'in_progress',
    source_relative_paths: decision.members.map(
      (member) => member.source_relative_path,
    ),
    observed_schema_version: decision.observed_schema.database_schema_version,
    target_schema_version: decision.target_schema.database_schema_version,
    members: decision.members,
  };
}

function parseMember(value: unknown): StateBackupMember {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('host_core_state_backup_member_invalid');
  const member = value as Record<string, unknown>;
  if (
    !WORKFLOW_STATE_RELATIVE_PATHS.includes(
      member.source_relative_path as (typeof WORKFLOW_STATE_RELATIVE_PATHS)[number],
    ) ||
    member.backup_name !== path.basename(String(member.source_relative_path)) ||
    !Number.isSafeInteger(member.byte_length) ||
    Number(member.byte_length) < 0 ||
    typeof member.checksum !== 'string' ||
    !CHECKSUM.test(member.checksum)
  )
    throw new Error('host_core_state_backup_member_invalid');
  return {
    source_relative_path: String(member.source_relative_path),
    backup_name: String(member.backup_name),
    byte_length: Number(member.byte_length),
    checksum: member.checksum,
  };
}

export function parsePersistentStateBackupManifest(
  value: unknown,
): PersistentStateBackupManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('host_core_state_backup_invalid');
  const record = value as Record<string, unknown>;
  if (
    record.format !== 'icarus.workflow-runtime-state-backup/3' ||
    typeof record.backup_id !== 'string' ||
    !NEW_BACKUP_ID.test(record.backup_id) ||
    typeof record.created_at !== 'string' ||
    Number.isNaN(Date.parse(record.created_at)) ||
    (record.completed_at !== null &&
      (typeof record.completed_at !== 'string' ||
        Number.isNaN(Date.parse(record.completed_at)))) ||
    (record.operation !== 'backup' && record.operation !== 'reset') ||
    (record.status !== 'in_progress' && record.status !== 'complete') ||
    (record.status === 'in_progress' && record.completed_at !== null) ||
    (record.status === 'complete' && record.completed_at === null) ||
    !Array.isArray(record.members) ||
    record.members.length < 1 ||
    !Array.isArray(record.source_relative_paths) ||
    !Number.isSafeInteger(record.observed_schema_version) ||
    Number(record.observed_schema_version) < 1 ||
    !Number.isSafeInteger(record.target_schema_version) ||
    Number(record.target_schema_version) < 1
  )
    throw new Error('host_core_state_backup_invalid');
  const members = record.members.map(parseMember);
  if (members[0]!.source_relative_path !== WORKFLOW_STATE_DATABASE_RELATIVE)
    throw new Error('host_core_state_backup_primary_missing');
  const sourceRelativePaths = record.source_relative_paths.map(String);
  if (
    JSON.stringify(sourceRelativePaths) !==
    JSON.stringify(members.map((member) => member.source_relative_path))
  )
    throw new Error('host_core_state_backup_sources_invalid');
  return {
    format: 'icarus.workflow-runtime-state-backup/3',
    backup_id: record.backup_id,
    created_at: record.created_at,
    completed_at: record.completed_at as string | null,
    operation: record.operation,
    status: record.status,
    source_relative_paths: sourceRelativePaths,
    observed_schema_version: Number(record.observed_schema_version),
    target_schema_version: Number(record.target_schema_version),
    members,
  };
}

function parseLegacyPersistentStateBackup(
  value: unknown,
): LegacyPersistentStateBackup {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('host_core_state_backup_invalid');
  const record = value as Record<string, unknown>;
  if (
    record.format !== 'icarus.workflow-runtime-state-quarantine/2' ||
    typeof record.backup_id !== 'string' ||
    !LEGACY_BACKUP_ID.test(record.backup_id) ||
    record.backup_relative_path !==
      `${WORKFLOW_STATE_BACKUP_DIRECTORY}/${record.backup_id}` ||
    !Array.isArray(record.members) ||
    record.members.length < 1 ||
    !Number.isSafeInteger(record.observed_schema_version) ||
    Number(record.observed_schema_version) < 1 ||
    !Number.isSafeInteger(record.target_schema_version) ||
    Number(record.target_schema_version) < 1
  )
    throw new Error('host_core_state_backup_invalid');
  const members = record.members.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('host_core_state_backup_member_invalid');
    const legacy = value as Record<string, unknown>;
    return parseMember({
      source_relative_path: legacy.source_relative_path,
      backup_name: legacy.backup_name,
      byte_length: legacy.byte_length,
      checksum: legacy.raw_sha256,
    });
  });
  if (members[0]!.source_relative_path !== WORKFLOW_STATE_DATABASE_RELATIVE)
    throw new Error('host_core_state_backup_primary_missing');
  return {
    format: 'icarus.workflow-runtime-state-quarantine/2',
    backup_id: record.backup_id,
    backup_relative_path: record.backup_relative_path,
    observed_schema_version: Number(record.observed_schema_version),
    target_schema_version: Number(record.target_schema_version),
    members,
  };
}

function verifyMember(file: string, member: StateBackupMember): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== member.byte_length ||
    sha256(file) !== member.checksum
  )
    throw new Error(
      `host_core_state_backup_member_mismatch:${member.backup_name}`,
    );
}

function writeManifest(
  root: string,
  manifest: PersistentStateBackupManifest,
): void {
  const temporary = path.join(
    root,
    `${WORKFLOW_STATE_BACKUP_MANIFEST}.tmp-${String(process.pid)}-${crypto
      .randomBytes(4)
      .toString('hex')}`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  const descriptor = fs.openSync(temporary, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, path.join(root, WORKFLOW_STATE_BACKUP_MANIFEST));
  fsyncDirectory(root);
}

function copyMember(
  runtimeHome: string,
  root: string,
  member: StateBackupMember,
  hooks: PersistentStateOperationHooks,
): void {
  const source = path.join(runtimeHome, member.source_relative_path);
  const destination = path.join(root, member.backup_name);
  verifyMember(source, member);
  const destinationStat = lstatIfPresent(destination);
  if (destinationStat) {
    verifyMember(destination, member);
    return;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  hooks.fault?.('during_copy', member);
  verifyMember(destination, member);
  fsyncDirectory(root);
}

function deleteLiveMembers(
  runtimeHome: string,
  members: readonly StateBackupMember[],
): void {
  for (const member of members) {
    const source = path.join(runtimeHome, member.source_relative_path);
    if (!lstatIfPresent(source)) continue;
    verifyMember(source, member);
    fs.unlinkSync(source);
    fsyncDirectory(path.dirname(source));
  }
}

function completedManifest(
  manifest: PersistentStateBackupManifest,
  hooks: PersistentStateOperationHooks,
): PersistentStateBackupManifest {
  return {
    ...manifest,
    status: 'complete',
    completed_at: (hooks.completedAt?.() ?? new Date()).toISOString(),
  };
}

export function createPersistentStateBackup(
  runtimeHomeInput: string,
  manifestInput: PersistentStateBackupManifest,
  hooks: PersistentStateOperationHooks = {},
): PersistentStateBackupManifest {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const manifest = parsePersistentStateBackupManifest(manifestInput);
  if (manifest.status !== 'in_progress')
    throw new Error('host_core_state_backup_already_complete');
  const backupsRoot = ensureDirectory(
    runtimeHome,
    WORKFLOW_STATE_BACKUP_DIRECTORY,
  );
  const root = path.join(backupsRoot, manifest.backup_id);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER), '', {
    mode: 0o600,
    flag: 'wx',
  });
  writeManifest(root, manifest);
  hooks.fault?.('before_copy');
  for (const member of manifest.members)
    copyMember(runtimeHome, root, member, hooks);
  const completed = completedManifest(manifest, hooks);
  writeManifest(root, completed);
  hooks.fault?.('after_manifest_write');
  fs.unlinkSync(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER));
  fsyncDirectory(root);
  if (manifest.operation === 'reset') {
    hooks.fault?.('before_live_deletion');
    deleteLiveMembers(runtimeHome, manifest.members);
  }
  return completed;
}

function readNewBackupAt(
  root: string,
  allowIncomplete: boolean,
): PersistentStateBackupManifest {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_state_backup_path_invalid');
  const manifestPath = path.join(root, WORKFLOW_STATE_BACKUP_MANIFEST);
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('host_core_state_backup_manifest_invalid');
  const manifest = parsePersistentStateBackupManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  if (path.basename(root) !== manifest.backup_id)
    throw new Error('host_core_state_backup_path_invalid');
  const incomplete =
    lstatIfPresent(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER)) !== null;
  if (incomplete !== (manifest.status === 'in_progress') && !allowIncomplete)
    throw new Error('host_core_state_backup_status_invalid');
  if (incomplete && !allowIncomplete)
    throw new Error('host_core_state_backup_incomplete');
  if (!incomplete || manifest.status === 'complete') {
    for (const member of manifest.members)
      verifyMember(path.join(root, member.backup_name), member);
  }
  return manifest;
}

function readLegacyBackupAt(root: string): LegacyPersistentStateBackup {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_state_backup_path_invalid');
  const manifestPath = path.join(root, 'backup-manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('host_core_state_backup_manifest_invalid');
  const manifest = parseLegacyPersistentStateBackup(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  if (path.basename(root) !== manifest.backup_id)
    throw new Error('host_core_state_backup_path_invalid');
  for (const member of manifest.members)
    verifyMember(path.join(root, member.backup_name), member);
  return manifest;
}

function readBackup(
  runtimeHome: string,
  backupId: string,
  allowIncomplete = false,
): PersistentStateBackupManifest | LegacyPersistentStateBackup {
  const root = backupRoot(runtimeHome, backupId);
  if (NEW_BACKUP_ID.test(backupId))
    return readNewBackupAt(root, allowIncomplete);
  return readLegacyBackupAt(root);
}

export function readPersistentStateBackup(
  runtimeHomeInput: string,
  backupId: string,
): PersistentStateBackupManifest | LegacyPersistentStateBackup {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  return readBackup(runtimeHome, backupId);
}

export function listPersistentStateBackups(
  runtimeHomeInput: string,
): PersistentStateBackupSummary[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const root = path.join(runtimeHome, WORKFLOW_STATE_BACKUP_DIRECTORY);
  const stat = lstatIfPresent(root);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_state_backup_path_invalid');
  const summaries: PersistentStateBackupSummary[] = [];
  for (const backupId of fs.readdirSync(root).sort()) {
    assertBackupId(backupId);
    const backup = readBackup(runtimeHome, backupId, true);
    if (backup.format === 'icarus.workflow-runtime-state-backup/3') {
      const incomplete =
        lstatIfPresent(
          path.join(root, backupId, WORKFLOW_STATE_INCOMPLETE_MARKER),
        ) !== null;
      summaries.push({
        backup_id: backup.backup_id,
        created_at: backup.created_at,
        operation: backup.operation,
        status: incomplete ? 'in_progress' : backup.status,
        observed_schema_version: backup.observed_schema_version,
        target_schema_version: backup.target_schema_version,
        legacy: false,
      });
    } else {
      summaries.push({
        backup_id: backup.backup_id,
        created_at: null,
        operation: 'legacy_reset',
        status: 'legacy_complete',
        observed_schema_version: backup.observed_schema_version,
        target_schema_version: backup.target_schema_version,
        legacy: true,
      });
    }
  }
  return summaries.sort((left, right) =>
    left.backup_id.localeCompare(right.backup_id),
  );
}

export function resumePersistentStateBackup(
  runtimeHomeInput: string,
  backupId: string,
  hooks: PersistentStateOperationHooks = {},
): PersistentStateBackupManifest {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  if (!NEW_BACKUP_ID.test(backupId))
    throw new Error('host_core_state_backup_not_resumable');
  const root = backupRoot(runtimeHome, backupId);
  const marker = path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER);
  if (!lstatIfPresent(marker))
    throw new Error('host_core_state_backup_not_incomplete');
  const manifest = readNewBackupAt(root, true);
  for (const member of manifest.members)
    copyMember(runtimeHome, root, member, hooks);
  const completed =
    manifest.status === 'complete'
      ? manifest
      : completedManifest(manifest, hooks);
  if (manifest.status !== 'complete') writeManifest(root, completed);
  fs.unlinkSync(marker);
  fsyncDirectory(root);
  if (completed.operation === 'reset') {
    hooks.fault?.('before_live_deletion');
    deleteLiveMembers(runtimeHome, completed.members);
  }
  return completed;
}

export function discardIncompletePersistentStateBackup(
  runtimeHomeInput: string,
  backupId: string,
): void {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  if (!NEW_BACKUP_ID.test(backupId))
    throw new Error('host_core_state_backup_not_discardable');
  const root = backupRoot(runtimeHome, backupId);
  readNewBackupAt(root, true);
  if (!lstatIfPresent(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER)))
    throw new Error('host_core_state_backup_not_incomplete');
  fs.rmSync(root, { recursive: true });
  fsyncDirectory(path.dirname(root));
}

export function restorePersistentStateBackup(
  runtimeHomeInput: string,
  backupId: string,
  hooks: PersistentStateOperationHooks = {},
): void {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const backup = readBackup(runtimeHome, backupId, true);
  const root = backupRoot(runtimeHome, backupId);
  for (const member of backup.members)
    verifyMember(path.join(root, member.backup_name), member);

  const memberBySource = new Map(
    backup.members.map((member) => [member.source_relative_path, member]),
  );
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS) {
    const destination = path.join(runtimeHome, relative);
    if (!lstatIfPresent(destination)) continue;
    const member = memberBySource.get(relative);
    if (!member) throw new Error('host_core_state_restore_destination_exists');
    try {
      verifyMember(destination, member);
    } catch {
      throw new Error('host_core_state_restore_destination_exists');
    }
  }

  ensureDirectory(runtimeHome, path.dirname(WORKFLOW_STATE_DATABASE_RELATIVE));
  const created: string[] = [];
  const temporaryFiles: string[] = [];
  try {
    for (const member of backup.members) {
      const destination = path.join(runtimeHome, member.source_relative_path);
      if (lstatIfPresent(destination)) continue;
      const temporary = `${destination}.restore-${backupId}`;
      if (lstatIfPresent(temporary))
        throw new Error('host_core_state_restore_temporary_exists');
      temporaryFiles.push(temporary);
      fs.copyFileSync(
        path.join(root, member.backup_name),
        temporary,
        fs.constants.COPYFILE_EXCL,
      );
      hooks.fault?.('during_restore', member);
      verifyMember(temporary, member);
      fs.renameSync(temporary, destination);
      temporaryFiles.pop();
      created.push(destination);
      fsyncDirectory(path.dirname(destination));
    }
    verifyRestoredDatabase(
      path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE),
      backup.observed_schema_version,
    );
  } catch (error) {
    for (const temporary of temporaryFiles.reverse()) {
      if (lstatIfPresent(temporary)) fs.unlinkSync(temporary);
    }
    for (const destination of created.reverse()) fs.unlinkSync(destination);
    throw error;
  }
}

export function gcPersistentStateBackups(
  runtimeHomeInput: string,
  keep: number,
): string[] {
  if (!Number.isSafeInteger(keep) || keep < 0)
    throw new Error('host_core_state_backup_keep_invalid');
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const summaries = listPersistentStateBackups(runtimeHome);
  if (summaries.some((summary) => summary.status === 'in_progress'))
    throw new Error('host_core_state_backup_incomplete_present');
  const remove = summaries.slice(0, Math.max(0, summaries.length - keep));
  for (const summary of remove) {
    const root = backupRoot(runtimeHome, summary.backup_id);
    readBackup(runtimeHome, summary.backup_id);
    fs.rmSync(root, { recursive: true });
    fsyncDirectory(path.dirname(root));
  }
  return remove.map((summary) => summary.backup_id);
}
