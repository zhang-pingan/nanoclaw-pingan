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

const DATABASE_RELATIVE = 'data/workflow-runtime/workflow-runtime.db';
const require = createRequire(import.meta.url);
const STATE_RELATIVES = [
  DATABASE_RELATIVE,
  `${DATABASE_RELATIVE}-wal`,
  `${DATABASE_RELATIVE}-shm`,
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

function rawSha256(file: string): Sha256Hash {
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

function stateMembers(runtimeHome: string): StateFileIdentity[] {
  const members: StateFileIdentity[] = [];
  for (const relative of STATE_RELATIVES) {
    const absolute = path.join(runtimeHome, relative);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
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
): PersistentStateDecision {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const target = targetFrom(targetInput);
  let members = stateMembers(runtimeHome);
  let affectedPaths = members.map((member) =>
    path.join(runtimeHome, member.source_relative_path),
  );
  const database = path.join(runtimeHome, DATABASE_RELATIVE);
  if (!fs.existsSync(database)) {
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
    members = stateMembers(runtimeHome);
    affectedPaths = members.map((member) =>
      path.join(runtimeHome, member.source_relative_path),
    );
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: null,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_identity_unverifiable',
    };
  }
  members = stateMembers(runtimeHome);
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

  const expectedOld = KNOWN_SQLITE_IDENTITIES.get(old.database_schema_version);
  if (!expectedOld || expectedOld !== old.database_sqlite_schema_hash)
    return {
      decision: 'UNKNOWN_BLOCKED',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'database_schema_identity_unknown',
    };

  const currentTarget =
    target.database_schema_version === 11 &&
    target.database_schema_hash === CURRENT_G1_SCHEMA_IDENTITIES.schema &&
    target.database_sqlite_schema_hash ===
      CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema;
  if (
    currentTarget &&
    old.database_schema_version >= 3 &&
    old.database_schema_version < 11 &&
    observed.schema3MigrationSafe
  )
    return {
      decision: 'MIGRATION_SUPPORTED',
      old_identity: old,
      target_identity: target,
      affected_paths: affectedPaths,
      members,
      reason: 'authoritative_migration_to_schema_11',
    };

  return {
    decision: 'RESET_REQUIRED',
    old_identity: old,
    target_identity: target,
    affected_paths: affectedPaths,
    members,
    reason:
      old.database_schema_version === 3 && !observed.schema3MigrationSafe
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
      !STATE_RELATIVES.includes(
        member.source_relative_path as (typeof STATE_RELATIVES)[number],
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
    const memberIndex = STATE_RELATIVES.indexOf(
      member.source_relative_path as (typeof STATE_RELATIVES)[number],
    );
    if (memberIndex <= previousMemberIndex)
      throw new Error('host_core_state_backup_member_order_invalid');
    previousMemberIndex = memberIndex;
  }
  if (members[0]!.source_relative_path !== DATABASE_RELATIVE)
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
  const backupRoot = ensureDirectory(runtimeHome, plan.backup_relative_path);
  writeBackupManifest(path.join(backupRoot, 'backup-manifest.json'), plan);
  for (const member of plan.members) {
    const source = path.join(runtimeHome, member.source_relative_path);
    const backup = path.join(backupRoot, member.backup_name);
    const sourceExists = fs.existsSync(source);
    const backupExists = fs.existsSync(backup);
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
