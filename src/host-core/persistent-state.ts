import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  SCHEMA_3_REQUIRED_EMPTY_RELATIONS,
  assertCurrentWorkflowRuntimeStructure,
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
  | 'MIGRATION_SUPPORTED'
  | 'RESET_REQUIRED'
  | 'UNKNOWN_BLOCKED';

interface StateFileCopy {
  readonly source_relative_path: string;
  readonly backup_name: string;
  readonly byte_length: number;
  readonly raw_sha256: string;
}

export interface PersistentStateDecision {
  readonly decision: PersistentStateDecisionKind;
  readonly observed_schema: WorkflowRuntimeStateSchema | null;
  readonly target_schema: HostCoreTargetSchema;
  readonly affected_paths: readonly string[];
  readonly members: readonly StateFileCopy[];
  readonly reason: string;
}

export interface PersistentStateResetPlan {
  readonly format: 'icarus.workflow-runtime-state-quarantine/2';
  readonly observed_schema_version: number;
  readonly target_schema_version: number;
  readonly members: readonly StateFileCopy[];
  readonly backup_id: string;
  readonly backup_relative_path: string;
}

export const WORKFLOW_STATE_DATABASE_RELATIVE =
  'data/workflow-runtime/workflow-runtime.db';
export const WORKFLOW_STATE_RELATIVE_PATHS = [
  WORKFLOW_STATE_DATABASE_RELATIVE,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-wal`,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-shm`,
] as const;

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

function canonicalHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
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

function stateMembers(runtimeHome: string): StateFileCopy[] {
  const members: StateFileCopy[] = [];
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
      raw_sha256: sha256(absolute),
    });
  }
  return members;
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
  schema3MigrationSafe: boolean;
} {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const version = Number(database.pragma('user_version', { simple: true }));
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('workflow_runtime_schema_version_invalid');
    if (version === CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION)
      assertCurrentWorkflowRuntimeStructure(database);
    let schema3MigrationSafe = true;
    if (version === 3) {
      schema3MigrationSafe = SCHEMA_3_REQUIRED_EMPTY_RELATIONS.every(
        (relation) => {
          const escaped = relation.replaceAll('"', '""');
          return (
            Number(
              database
                .prepare(`SELECT count(*) FROM "${escaped}"`)
                .pluck()
                .get(),
            ) === 0
          );
        },
      );
    }
    return {
      schema: { database_schema_version: version },
      schema3MigrationSafe,
    };
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

  let members: StateFileCopy[];
  try {
    members = stateMembers(runtimeHome);
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
  const affectedPaths = members.map((member) =>
    path.join(runtimeHome, member.source_relative_path),
  );
  if (!lstatIfPresent(databasePath)) {
    return members.length === 0
      ? {
          decision: 'NO_STATE',
          observed_schema: null,
          target_schema: target,
          affected_paths: [],
          members,
          reason: 'no_workflow_runtime_database',
        }
      : {
          decision: 'UNKNOWN_BLOCKED',
          observed_schema: null,
          target_schema: target,
          affected_paths: affectedPaths,
          members,
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
      members,
      reason:
        error instanceof Error && error.message.includes('missing required')
          ? 'database_required_structure_missing'
          : 'database_schema_unverifiable',
    };
  }
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
  if (version === 3 && !observed.schema3MigrationSafe)
    return {
      decision: 'RESET_REQUIRED',
      observed_schema: observed.schema,
      target_schema: target,
      affected_paths: affectedPaths,
      members,
      reason: 'schema_3_migration_requires_empty_relations',
    };
  return {
    decision: 'MIGRATION_SUPPORTED',
    observed_schema: observed.schema,
    target_schema: target,
    affected_paths: affectedPaths,
    members,
    reason: 'supported_schema_version_migration',
  };
}

export function buildPersistentStateResetPlan(
  decision: PersistentStateDecision,
): PersistentStateResetPlan {
  if (decision.decision !== 'RESET_REQUIRED' || !decision.observed_schema)
    throw new Error('host_core_persistent_state_reset_not_available');
  const payload = {
    format: 'icarus.workflow-runtime-state-quarantine/2' as const,
    observed_schema_version: decision.observed_schema.database_schema_version,
    target_schema_version: decision.target_schema.database_schema_version,
    members: decision.members,
  };
  const backupId = canonicalHash(payload);
  return {
    ...payload,
    backup_id: backupId,
    backup_relative_path: `workflow-runtime-state-backups/${backupId}`,
  };
}

export function parsePersistentStateResetPlan(
  value: unknown,
): PersistentStateResetPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('host_core_state_backup_invalid');
  const record = value as Record<string, unknown>;
  if (
    record.format !== 'icarus.workflow-runtime-state-quarantine/2' ||
    !Array.isArray(record.members) ||
    record.members.length < 1 ||
    !Number.isSafeInteger(record.observed_schema_version) ||
    Number(record.observed_schema_version) < 1 ||
    !Number.isSafeInteger(record.target_schema_version) ||
    Number(record.target_schema_version) < 1
  )
    throw new Error('host_core_state_backup_invalid');
  const members = record.members.map((member) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member))
      throw new Error('host_core_state_backup_member_invalid');
    const copy = member as Record<string, unknown>;
    if (
      !WORKFLOW_STATE_RELATIVE_PATHS.includes(
        copy.source_relative_path as (typeof WORKFLOW_STATE_RELATIVE_PATHS)[number],
      ) ||
      copy.backup_name !== path.basename(String(copy.source_relative_path)) ||
      !Number.isSafeInteger(copy.byte_length) ||
      Number(copy.byte_length) < 0 ||
      typeof copy.raw_sha256 !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(copy.raw_sha256)
    )
      throw new Error('host_core_state_backup_member_invalid');
    return {
      source_relative_path: String(copy.source_relative_path),
      backup_name: String(copy.backup_name),
      byte_length: Number(copy.byte_length),
      raw_sha256: copy.raw_sha256,
    };
  });
  if (members[0]!.source_relative_path !== WORKFLOW_STATE_DATABASE_RELATIVE)
    throw new Error('host_core_state_backup_primary_missing');
  const payload = {
    format: 'icarus.workflow-runtime-state-quarantine/2' as const,
    observed_schema_version: Number(record.observed_schema_version),
    target_schema_version: Number(record.target_schema_version),
    members,
  };
  const backupId = canonicalHash(payload);
  if (
    record.backup_id !== backupId ||
    record.backup_relative_path !== `workflow-runtime-state-backups/${backupId}`
  )
    throw new Error('host_core_state_backup_plan_invalid');
  return {
    ...payload,
    backup_id: backupId,
    backup_relative_path: record.backup_relative_path,
  };
}

function verifyMember(file: string, member: StateFileCopy): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== member.byte_length ||
    sha256(file) !== member.raw_sha256
  )
    throw new Error('host_core_state_backup_member_mismatch');
}

export function quarantinePersistentState(
  runtimeHomeInput: string,
  planInput: PersistentStateResetPlan,
): void {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const plan = parsePersistentStateResetPlan(planInput);
  const backupRoot = ensureDirectory(runtimeHome, plan.backup_relative_path);
  const manifestFile = path.join(backupRoot, 'backup-manifest.json');
  if (!fs.existsSync(manifestFile))
    fs.writeFileSync(manifestFile, `${JSON.stringify(plan, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  for (const member of plan.members) {
    const source = path.join(runtimeHome, member.source_relative_path);
    const destination = path.join(backupRoot, member.backup_name);
    const sourceExists = lstatIfPresent(source) !== null;
    const destinationExists = lstatIfPresent(destination) !== null;
    if (sourceExists && destinationExists) {
      verifyMember(source, member);
      verifyMember(destination, member);
      fs.unlinkSync(source);
    } else if (sourceExists) {
      verifyMember(source, member);
      fs.renameSync(source, destination);
    } else if (destinationExists) verifyMember(destination, member);
    else throw new Error('host_core_state_backup_member_missing');
    fsyncDirectory(path.dirname(source));
  }
  fsyncDirectory(backupRoot);
}

function readBackupAt(
  runtimeHome: string,
  root: string,
): PersistentStateResetPlan {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_state_backup_path_invalid');
  const manifest = fs.lstatSync(path.join(root, 'backup-manifest.json'));
  if (!manifest.isFile() || manifest.isSymbolicLink())
    throw new Error('host_core_state_backup_manifest_invalid');
  const plan = parsePersistentStateResetPlan(
    JSON.parse(
      fs.readFileSync(path.join(root, 'backup-manifest.json'), 'utf8'),
    ),
  );
  if (path.join(runtimeHome, plan.backup_relative_path) !== root)
    throw new Error('host_core_state_backup_path_invalid');
  for (const member of plan.members)
    verifyMember(path.join(root, member.backup_name), member);
  return plan;
}

export function discoverPersistentStateResetRecovery(
  runtimeHomeInput: string,
): PersistentStateResetPlan | null {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const backupsRoot = path.join(runtimeHome, 'workflow-runtime-state-backups');
  const stat = lstatIfPresent(backupsRoot);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('host_core_state_backup_path_invalid');
  const recoveries: PersistentStateResetPlan[] = [];
  for (const name of fs.readdirSync(backupsRoot).sort()) {
    if (!/^[0-9a-f]{64}$/.test(name))
      throw new Error('host_core_state_backup_path_invalid');
    const root = path.join(backupsRoot, name);
    const plan = readBackupAt(runtimeHome, root);
    const incomplete = plan.members.some(
      (member) =>
        lstatIfPresent(path.join(runtimeHome, member.source_relative_path)) !==
        null,
    );
    if (incomplete) recoveries.push(plan);
  }
  if (recoveries.length > 1)
    throw new Error('host_core_state_backup_recovery_ambiguous');
  return recoveries[0] ?? null;
}

export function readPersistentStateResetBackup(
  runtimeHomeInput: string,
  relative: string,
): PersistentStateResetPlan {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  if (!/^workflow-runtime-state-backups\/[0-9a-f]{64}$/.test(relative))
    throw new Error('host_core_state_backup_path_invalid');
  return readBackupAt(runtimeHome, path.join(runtimeHome, relative));
}
