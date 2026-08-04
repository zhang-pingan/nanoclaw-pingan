import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

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
import { calculateDatabaseSqliteSchemaIdentity } from '../workflow-runtime/store/schema/database-identity.js';
import {
  CURRENT_G1_SCHEMA_IDENTITIES,
  loadFrozenWorkflowRuntimeStoreInputs,
} from '../workflow-runtime/store/runtime-store/profile.js';

export interface HostCoreTargetSchemaIdentity {
  readonly database_schema_version: number;
  readonly database_schema_hash: Sha256Hash;
  readonly database_sqlite_schema_hash: Sha256Hash;
}

export type WorkflowRuntimeMigrationPrecondition =
  | 'NONE'
  | 'SCHEMA_3_REQUIRED_RELATIONS_EMPTY';

export interface WorkflowRuntimeSchemaSourceCompatibility {
  readonly database_schema_version: number;
  readonly database_sqlite_schema_hash: Sha256Hash;
  readonly migration: 'SUPPORTED' | 'UNSUPPORTED';
  readonly precondition: WorkflowRuntimeMigrationPrecondition;
}

export interface WorkflowRuntimeSchemaCompatibility {
  readonly format: 'icarus.workflow-runtime-schema-compatibility/1';
  readonly target_identity: HostCoreTargetSchemaIdentity;
  readonly recognized_sources: readonly WorkflowRuntimeSchemaSourceCompatibility[];
}

export interface WorkflowRuntimeStateIdentity {
  readonly database_schema_version: number;
  readonly database_sqlite_schema_hash: Sha256Hash;
}

export type PersistentStateDecisionKind =
  | 'NO_STATE'
  | 'SAME_SCHEMA'
  | 'MIGRATION_SUPPORTED'
  | 'RESET_REQUIRED'
  | 'UNKNOWN_BLOCKED';

interface StateFileIdentity {
  readonly source_relative_path: string;
  readonly backup_name: string;
  readonly byte_length: number;
  readonly raw_sha256: Sha256Hash;
}

export interface PersistentStateDecision {
  readonly decision: PersistentStateDecisionKind;
  readonly old_identity: WorkflowRuntimeStateIdentity | null;
  readonly target_identity: HostCoreTargetSchemaIdentity;
  readonly affected_paths: readonly string[];
  readonly members: readonly StateFileIdentity[];
  readonly reason: string;
}

export interface PersistentStateResetPlan {
  readonly format: 'icarus.workflow-runtime-state-backup/1';
  readonly old_identity: WorkflowRuntimeStateIdentity;
  readonly target_identity: HostCoreTargetSchemaIdentity;
  readonly members: readonly StateFileIdentity[];
  readonly backup_identity: Sha256Hash;
  readonly backup_relative_path: string;
}

export const WORKFLOW_STATE_DATABASE_RELATIVE =
  'data/workflow-runtime/workflow-runtime.db';
const require = createRequire(import.meta.url);
export const WORKFLOW_STATE_RELATIVE_PATHS = [
  WORKFLOW_STATE_DATABASE_RELATIVE,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-wal`,
  `${WORKFLOW_STATE_DATABASE_RELATIVE}-shm`,
] as const;

const KNOWN_SQLITE_IDENTITIES = new Map<number, Sha256Hash>([
  [3, CURRENT_G1_SCHEMA_IDENTITIES.schema3SourceSqliteSchema],
  [4, CURRENT_G1_SCHEMA_IDENTITIES.schema4SourceSqliteSchema],
  [5, CURRENT_G1_SCHEMA_IDENTITIES.schema5SourceSqliteSchema],
  [6, CURRENT_G1_SCHEMA_IDENTITIES.schema6SourceSqliteSchema],
  [7, CURRENT_G1_SCHEMA_IDENTITIES.schema7SourceSqliteSchema],
  [8, CURRENT_G1_SCHEMA_IDENTITIES.schema8SourceSqliteSchema],
  [9, CURRENT_G1_SCHEMA_IDENTITIES.schema9SourceSqliteSchema],
  [10, CURRENT_G1_SCHEMA_IDENTITIES.schema10SourceSqliteSchema],
  [11, CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema],
]);

export function currentWorkflowRuntimeSchemaCompatibility(): WorkflowRuntimeSchemaCompatibility {
  return {
    format: 'icarus.workflow-runtime-schema-compatibility/1',
    target_identity: {
      database_schema_version: 11,
      database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
    },
    recognized_sources: [...KNOWN_SQLITE_IDENTITIES.entries()]
      .filter(([version]) => version < 11)
      .map(([version, sqliteSchemaHash]) => ({
        database_schema_version: version,
        database_sqlite_schema_hash: sqliteSchemaHash,
        migration: 'SUPPORTED' as const,
        precondition:
          version === 3
            ? ('SCHEMA_3_REQUIRED_RELATIONS_EMPTY' as const)
            : ('NONE' as const),
      })),
  };
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

function stateMembers(runtimeHome: string): StateFileIdentity[] {
  const members: StateFileIdentity[] = [];
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
      raw_sha256: rawSha256(absolute),
    });
  }
  return members;
}

function presentStatePaths(runtimeHome: string): string[] {
  return WORKFLOW_STATE_RELATIVE_PATHS.map((relative) =>
    path.join(runtimeHome, relative),
  ).filter((absolute) => lstatIfPresent(absolute) !== null);
}

function targetFrom(
  input: HostCoreTargetSchemaIdentity,
): HostCoreTargetSchemaIdentity {
  if (
    !Number.isSafeInteger(input.database_schema_version) ||
    input.database_schema_version < 1
  )
    throw new Error('host_core_target_schema_version_invalid');
  return {
    database_schema_version: input.database_schema_version,
    database_schema_hash: parseSha256Hash(input.database_schema_hash),
    database_sqlite_schema_hash: parseSha256Hash(
      input.database_sqlite_schema_hash,
    ),
  };
}

function inspectDatabase(databasePath: string): {
  identity: WorkflowRuntimeStateIdentity;
  schema3MigrationSafe: boolean;
} {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const version = Number(database.pragma('user_version', { simple: true }));
    const identity = {
      database_schema_version: version,
      database_sqlite_schema_hash:
        calculateDatabaseSqliteSchemaIdentity(database),
    };
    let schema3MigrationSafe = true;
    if (version === 3) {
      const relations =
        loadFrozenWorkflowRuntimeStoreInputs().schema3RequiredEmptyRelations;
      schema3MigrationSafe = relations.every((relation) => {
        const escaped = relation.replaceAll('"', '""');
        return (
          Number(
            database.prepare(`SELECT count(*) FROM "${escaped}"`).pluck().get(),
          ) === 0
        );
      });
    }
    return { identity, schema3MigrationSafe };
  } finally {
    database.close();
  }
}

export function decidePersistentStateCompatibility(
  runtimeHomeInput: string,
  targetInput: HostCoreTargetSchemaIdentity,
  compatibilityInput: WorkflowRuntimeSchemaCompatibility | null = currentWorkflowRuntimeSchemaCompatibility(),
): PersistentStateDecision {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const target = targetFrom(targetInput);
  const compatibility = compatibilityInput
    ? parseWorkflowRuntimeSchemaCompatibility(compatibilityInput)
    : null;
  if (
    compatibility &&
    JSON.stringify(compatibility.target_identity) !== JSON.stringify(target)
  )
    throw new Error('host_core_schema_compatibility_target_mismatch');
  let members: StateFileIdentity[];
  try {
    members = stateMembers(runtimeHome);
  } catch {
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: null,
      target_identity: target,
      affected_paths: presentStatePaths(runtimeHome),
      members: [],
      reason: 'persistent_state_path_invalid',
    };
  }
  let affectedPaths = members.map((member) =>
    path.join(runtimeHome, member.source_relative_path),
  );
  const initialMembers = members;
  const database = path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE);
  if (!lstatIfPresent(database)) {
    if (members.length === 0)
      return {
        decision: 'NO_STATE',
        old_identity: null,
        target_identity: target,
        affected_paths: [],
        members,
        reason: 'no_workflow_runtime_database',
      };
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: null,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_companion_without_primary',
    };
  }

  let observed: ReturnType<typeof inspectDatabase>;
  try {
    observed = inspectDatabase(database);
  } catch {
    try {
      members = stateMembers(runtimeHome);
      affectedPaths = members.map((member) =>
        path.join(runtimeHome, member.source_relative_path),
      );
    } catch {
      affectedPaths = presentStatePaths(runtimeHome);
      members = [];
    }
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: null,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_identity_unverifiable',
    };
  }
  try {
    members = stateMembers(runtimeHome);
  } catch {
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: observed.identity,
      target_identity: target,
      affected_paths: presentStatePaths(runtimeHome),
      members: [],
      reason: 'persistent_state_changed_during_inspection',
    };
  }
  if (JSON.stringify(members) !== JSON.stringify(initialMembers))
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: observed.identity,
      target_identity: target,
      affected_paths: presentStatePaths(runtimeHome),
      members: [],
      reason: 'persistent_state_changed_during_inspection',
    };
  affectedPaths = members.map((member) =>
    path.join(runtimeHome, member.source_relative_path),
  );
  const old = observed.identity;
  if (
    old.database_schema_version === target.database_schema_version &&
    old.database_sqlite_schema_hash === target.database_sqlite_schema_hash
  )
    return {
      decision: 'SAME_SCHEMA',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'same_schema_identity',
    };

  if (!compatibility)
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'frozen_migration_authority_unavailable',
    };

  const source = compatibility.recognized_sources.find(
    (candidate) =>
      candidate.database_schema_version === old.database_schema_version &&
      candidate.database_sqlite_schema_hash === old.database_sqlite_schema_hash,
  );
  if (!source)
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_schema_identity_unknown',
    };

  if (
    source.migration === 'SUPPORTED' &&
    (source.precondition !== 'SCHEMA_3_REQUIRED_RELATIONS_EMPTY' ||
      observed.schema3MigrationSafe)
  )
    return {
      decision: 'MIGRATION_SUPPORTED',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'frozen_authoritative_migration_supported',
    };

  return {
    decision: 'RESET_REQUIRED',
    old_identity: old,
    target_identity: target,
    affected_paths: affectedPaths,
    members,
    reason:
      source.precondition === 'SCHEMA_3_REQUIRED_RELATIONS_EMPTY' &&
      !observed.schema3MigrationSafe
        ? 'schema_3_migration_requires_empty_relations'
        : 'recognized_schema_without_supported_target_path',
  };
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

export function parseWorkflowRuntimeSchemaCompatibility(
  value: unknown,
): WorkflowRuntimeSchemaCompatibility {
  assertJsonObject(value);
  exactKeys(
    value,
    ['format', 'recognized_sources', 'target_identity'],
    'host_core_schema_compatibility',
  );
  if (
    value.format !== 'icarus.workflow-runtime-schema-compatibility/1' ||
    !Array.isArray(value.recognized_sources)
  )
    throw new Error('host_core_schema_compatibility_invalid');
  assertJsonObject(value.target_identity);
  const targetIdentity = targetFrom({
    database_schema_version: Number(
      value.target_identity.database_schema_version,
    ),
    database_schema_hash: parseSha256Hash(
      value.target_identity.database_schema_hash,
    ),
    database_sqlite_schema_hash: parseSha256Hash(
      value.target_identity.database_sqlite_schema_hash,
    ),
  });
  const recognizedSources = value.recognized_sources.map((source, index) => {
    assertJsonObject(source);
    exactKeys(
      source,
      [
        'database_schema_version',
        'database_sqlite_schema_hash',
        'migration',
        'precondition',
      ],
      `host_core_schema_compatibility_source_${index}`,
    );
    if (
      !Number.isSafeInteger(source.database_schema_version) ||
      Number(source.database_schema_version) < 1 ||
      (source.migration !== 'SUPPORTED' &&
        source.migration !== 'UNSUPPORTED') ||
      (source.precondition !== 'NONE' &&
        source.precondition !== 'SCHEMA_3_REQUIRED_RELATIONS_EMPTY') ||
      (source.migration === 'UNSUPPORTED' && source.precondition !== 'NONE') ||
      (source.precondition === 'SCHEMA_3_REQUIRED_RELATIONS_EMPTY' &&
        source.database_schema_version !== 3)
    )
      throw new Error('host_core_schema_compatibility_source_invalid');
    return {
      database_schema_version: Number(source.database_schema_version),
      database_sqlite_schema_hash: parseSha256Hash(
        source.database_sqlite_schema_hash,
      ),
      migration: source.migration,
      precondition: source.precondition,
    } as WorkflowRuntimeSchemaSourceCompatibility;
  });
  recognizedSources.forEach((source, index) => {
    const previous = recognizedSources[index - 1];
    if (
      source.database_schema_version ===
        targetIdentity.database_schema_version ||
      (previous &&
        previous.database_schema_version >= source.database_schema_version)
    )
      throw new Error('host_core_schema_compatibility_source_order_invalid');
  });
  return {
    format: 'icarus.workflow-runtime-schema-compatibility/1',
    target_identity: targetIdentity,
    recognized_sources: recognizedSources,
  };
}

export function buildPersistentStateResetPlan(
  decision: PersistentStateDecision,
): PersistentStateResetPlan {
  if (decision.decision !== 'RESET_REQUIRED' || !decision.old_identity)
    throw new Error('host_core_persistent_state_reset_not_available');
  const payload = {
    format: 'icarus.workflow-runtime-state-backup/1' as const,
    old_identity: decision.old_identity,
    target_identity: decision.target_identity,
    members: decision.members,
  };
  const backupIdentity = domainSeparatedSha256(
    'icarus:workflow-runtime-state-backup:1\n',
    payload as unknown as JsonValue,
  );
  return {
    ...payload,
    backup_identity: backupIdentity,
    backup_relative_path: `workflow-runtime-state-backups/${backupIdentity.slice('sha256:'.length)}`,
  };
}

export function parsePersistentStateResetPlan(
  value: unknown,
): PersistentStateResetPlan {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'backup_identity',
      'backup_relative_path',
      'format',
      'members',
      'old_identity',
      'target_identity',
    ],
    'host_core_state_backup',
  );
  assertJsonObject(value.old_identity);
  assertJsonObject(value.target_identity);
  exactKeys(
    value.old_identity,
    ['database_schema_version', 'database_sqlite_schema_hash'],
    'host_core_state_backup_old_identity',
  );
  exactKeys(
    value.target_identity,
    [
      'database_schema_hash',
      'database_schema_version',
      'database_sqlite_schema_hash',
    ],
    'host_core_state_backup_target_identity',
  );
  if (!Array.isArray(value.members) || value.members.length < 1)
    throw new Error('host_core_state_backup_members_invalid');
  const members = value.members.map((member) => {
    assertJsonObject(member);
    exactKeys(
      member,
      ['backup_name', 'byte_length', 'raw_sha256', 'source_relative_path'],
      'host_core_state_backup_member',
    );
    if (
      !WORKFLOW_STATE_RELATIVE_PATHS.includes(
        member.source_relative_path as (typeof WORKFLOW_STATE_RELATIVE_PATHS)[number],
      ) ||
      member.backup_name !==
        path.basename(String(member.source_relative_path)) ||
      !Number.isSafeInteger(member.byte_length) ||
      Number(member.byte_length) < 0
    )
      throw new Error('host_core_state_backup_member_invalid');
    return {
      source_relative_path: String(member.source_relative_path),
      backup_name: String(member.backup_name),
      byte_length: Number(member.byte_length),
      raw_sha256: parseSha256Hash(member.raw_sha256),
    };
  });
  let previousMemberIndex = -1;
  for (const member of members) {
    const memberIndex = WORKFLOW_STATE_RELATIVE_PATHS.indexOf(
      member.source_relative_path as (typeof WORKFLOW_STATE_RELATIVE_PATHS)[number],
    );
    if (memberIndex <= previousMemberIndex)
      throw new Error('host_core_state_backup_member_order_invalid');
    previousMemberIndex = memberIndex;
  }
  if (members[0]!.source_relative_path !== WORKFLOW_STATE_DATABASE_RELATIVE)
    throw new Error('host_core_state_backup_primary_missing');
  if (
    !Number.isSafeInteger(value.old_identity.database_schema_version) ||
    Number(value.old_identity.database_schema_version) < 1
  )
    throw new Error('host_core_state_backup_old_identity_invalid');
  const oldIdentity = {
    database_schema_version: Number(value.old_identity.database_schema_version),
    database_sqlite_schema_hash: parseSha256Hash(
      value.old_identity.database_sqlite_schema_hash,
    ),
  };
  const targetIdentity = targetFrom({
    database_schema_version: Number(
      value.target_identity.database_schema_version,
    ),
    database_schema_hash: parseSha256Hash(
      value.target_identity.database_schema_hash,
    ),
    database_sqlite_schema_hash: parseSha256Hash(
      value.target_identity.database_sqlite_schema_hash,
    ),
  });
  const payload = {
    format: 'icarus.workflow-runtime-state-backup/1' as const,
    old_identity: oldIdentity,
    target_identity: targetIdentity,
    members,
  };
  const backupIdentity = domainSeparatedSha256(
    'icarus:workflow-runtime-state-backup:1\n',
    payload as unknown as JsonValue,
  );
  if (
    parseSha256Hash(value.backup_identity) !== backupIdentity ||
    value.backup_relative_path !==
      `workflow-runtime-state-backups/${backupIdentity.slice('sha256:'.length)}`
  )
    throw new Error('host_core_state_backup_identity_invalid');
  return {
    ...payload,
    backup_identity: backupIdentity,
    backup_relative_path: value.backup_relative_path,
  };
}

function writeBackupManifest(
  file: string,
  plan: PersistentStateResetPlan,
): void {
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.readFileSync(file, 'utf8') !== bytes
    )
      throw new Error('host_core_state_backup_collision');
    return;
  }
  const descriptor = fs.openSync(file, 'wx', 0o400);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
}

function verifyMember(file: string, member: StateFileIdentity): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== member.byte_length ||
    rawSha256(file) !== member.raw_sha256
  )
    throw new Error('host_core_state_backup_member_identity_mismatch');
}

export function quarantinePersistentState(
  runtimeHomeInput: string,
  planInput: PersistentStateResetPlan,
): void {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const plan = parsePersistentStateResetPlan(planInput);
  const backupPath = path.join(runtimeHome, plan.backup_relative_path);
  const backupExisted = lstatIfPresent(backupPath) !== null;
  const backupRoot = ensureDirectory(runtimeHome, plan.backup_relative_path);
  writeBackupManifest(path.join(backupRoot, 'backup-manifest.json'), plan);
  if (
    backupExisted &&
    inspectResetRecoveryDirectory(runtimeHome, backupRoot) === null
  ) {
    deduplicateCompletedPersistentState(runtimeHome, plan);
    return;
  }
  for (const member of plan.members) {
    const source = path.join(runtimeHome, member.source_relative_path);
    const backup = path.join(backupRoot, member.backup_name);
    const sourceExists = lstatIfPresent(source) !== null;
    const backupExists = lstatIfPresent(backup) !== null;
    if (sourceExists === backupExists)
      throw new Error('host_core_state_backup_transition_invalid');
    if (sourceExists) {
      verifyMember(source, member);
      fs.renameSync(source, backup);
      fsyncDirectory(path.dirname(source));
      fsyncDirectory(backupRoot);
    } else verifyMember(backup, member);
  }
  for (const member of plan.members)
    fs.chmodSync(path.join(backupRoot, member.backup_name), 0o400);
  fs.chmodSync(path.join(backupRoot, 'backup-manifest.json'), 0o400);
  fs.chmodSync(backupRoot, 0o500);
  fsyncDirectory(path.dirname(backupRoot));
}

function deduplicateCompletedPersistentState(
  runtimeHome: string,
  plan: PersistentStateResetPlan,
): void {
  const presentSources = plan.members.filter(
    (member) =>
      lstatIfPresent(path.join(runtimeHome, member.source_relative_path)) !==
      null,
  );
  if (presentSources.length === 0) return;
  if (presentSources.length !== plan.members.length)
    throw new Error('host_core_state_backup_deduplication_unit_incomplete');
  const sourceDirectory = path.dirname(
    path.join(runtimeHome, WORKFLOW_STATE_DATABASE_RELATIVE),
  );
  if (fs.realpathSync(sourceDirectory) !== sourceDirectory)
    throw new Error('host_core_state_backup_deduplication_path_invalid');
  for (const member of plan.members)
    verifyMember(path.join(runtimeHome, member.source_relative_path), member);

  const primary = plan.members[0]!;
  for (const member of [...plan.members.slice(1), primary]) {
    fs.unlinkSync(path.join(runtimeHome, member.source_relative_path));
    fsyncDirectory(sourceDirectory);
  }
}

function backupIsFullyHardened(
  root: string,
  plan: PersistentStateResetPlan,
): boolean {
  if ((fs.lstatSync(root).mode & 0o777) !== 0o500) return false;
  for (const file of [
    path.join(root, 'backup-manifest.json'),
    ...plan.members.map((member) => path.join(root, member.backup_name)),
  ]) {
    if ((fs.lstatSync(file).mode & 0o777) !== 0o400) return false;
  }
  return true;
}

function inspectResetRecoveryDirectory(
  runtimeHome: string,
  root: string,
): PersistentStateResetPlan | null {
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error(`host_core_state_backup_recovery_path_invalid:${root}`);
  if (
    fs.realpathSync(root) !== root ||
    path.dirname(root) !==
      path.join(runtimeHome, 'workflow-runtime-state-backups')
  )
    throw new Error(`host_core_state_backup_recovery_path_invalid:${root}`);
  const manifestFile = path.join(root, 'backup-manifest.json');
  const manifestStat = lstatIfPresent(manifestFile);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error(
      `host_core_state_backup_recovery_manifest_invalid:${manifestFile}`,
    );
  let plan: PersistentStateResetPlan;
  try {
    plan = parsePersistentStateResetPlan(
      strictParseJsonBytes(fs.readFileSync(manifestFile)),
    );
  } catch (error) {
    throw new Error(
      `host_core_state_backup_recovery_manifest_invalid:${manifestFile}`,
      { cause: error },
    );
  }
  if (
    path.basename(root) !== plan.backup_identity.slice('sha256:'.length) ||
    path.join(runtimeHome, plan.backup_relative_path) !== root
  )
    throw new Error(`host_core_state_backup_recovery_path_invalid:${root}`);

  const allowedEntries = new Set([
    'backup-manifest.json',
    ...plan.members.map((member) => member.backup_name),
  ]);
  const observedEntries = fs.readdirSync(root).sort();
  if (
    !observedEntries.includes('backup-manifest.json') ||
    observedEntries.some((entry) => !allowedEntries.has(entry))
  )
    throw new Error(`host_core_state_backup_recovery_entries_invalid:${root}`);

  const allBackupMembersPresent = plan.members.every(
    (member) => lstatIfPresent(path.join(root, member.backup_name)) !== null,
  );
  if (allBackupMembersPresent) {
    try {
      for (const member of plan.members)
        verifyMember(path.join(root, member.backup_name), member);
    } catch (error) {
      throw new Error('host_core_state_backup_recovery_member_invalid', {
        cause: error,
      });
    }
    if (backupIsFullyHardened(root, plan)) return null;
  }

  let allMembersMoved = true;
  for (const member of plan.members) {
    const source = path.join(runtimeHome, member.source_relative_path);
    const backup = path.join(root, member.backup_name);
    const sourceExists = lstatIfPresent(source) !== null;
    const backupExists = lstatIfPresent(backup) !== null;
    if (sourceExists === backupExists)
      throw new Error(
        `host_core_state_backup_recovery_location_invalid:${member.source_relative_path}`,
      );
    try {
      if (sourceExists) {
        if (fs.realpathSync(path.dirname(source)) !== path.dirname(source))
          throw new Error('source_directory_invalid');
        verifyMember(source, member);
        allMembersMoved = false;
      } else {
        verifyMember(backup, member);
      }
    } catch (error) {
      throw new Error(
        `host_core_state_backup_recovery_member_invalid:${member.source_relative_path}`,
        { cause: error },
      );
    }
  }
  return allMembersMoved && backupIsFullyHardened(root, plan) ? null : plan;
}

export function discoverPersistentStateResetRecovery(
  runtimeHomeInput: string,
): PersistentStateResetPlan | null {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const backupsRoot = path.join(runtimeHome, 'workflow-runtime-state-backups');
  const backupsStat = lstatIfPresent(backupsRoot);
  if (!backupsStat) return null;
  if (!backupsStat.isDirectory() || backupsStat.isSymbolicLink())
    throw new Error(
      `host_core_state_backup_recovery_root_invalid:${backupsRoot}`,
    );
  if (fs.realpathSync(backupsRoot) !== backupsRoot)
    throw new Error(
      `host_core_state_backup_recovery_root_invalid:${backupsRoot}`,
    );

  const recoveries: PersistentStateResetPlan[] = [];
  for (const name of fs.readdirSync(backupsRoot).sort()) {
    if (!/^[0-9a-f]{64}$/.test(name))
      throw new Error(`host_core_state_backup_recovery_entry_invalid:${name}`);
    const recovery = inspectResetRecoveryDirectory(
      runtimeHome,
      path.join(backupsRoot, name),
    );
    if (recovery) recoveries.push(recovery);
  }
  if (recoveries.length > 1)
    throw new Error(
      `host_core_state_backup_recovery_ambiguous:${recoveries
        .map((plan) => plan.backup_relative_path)
        .join(',')}`,
    );
  return recoveries[0] ?? null;
}

export function readPersistentStateResetBackup(
  runtimeHomeInput: string,
  relative: string,
): PersistentStateResetPlan {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  if (!/^workflow-runtime-state-backups\/[0-9a-f]{64}$/.test(relative))
    throw new Error('host_core_state_backup_path_invalid');
  const root = fs.realpathSync(path.join(runtimeHome, relative));
  if (
    path.dirname(root) !==
    path.join(runtimeHome, 'workflow-runtime-state-backups')
  )
    throw new Error('host_core_state_backup_path_invalid');
  const plan = parsePersistentStateResetPlan(
    strictParseJsonBytes(
      fs.readFileSync(path.join(root, 'backup-manifest.json')),
    ),
  );
  if (plan.backup_relative_path !== relative)
    throw new Error('host_core_state_backup_path_invalid');
  for (const member of plan.members)
    verifyMember(path.join(root, member.backup_name), member);
  return plan;
}
