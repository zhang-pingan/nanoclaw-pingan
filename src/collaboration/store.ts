import crypto from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type {
  CollaborationEvent,
  CollaborationProjection,
  CollaborationTurn,
  FilesystemAccess,
} from './protocol/index.js';

export const CURRENT_COLLABORATION_SCHEMA_VERSION = 2;
export const MINIMUM_COLLABORATION_SCHEMA_VERSION = 1;

export class CollaborationStoreError extends Error {
  constructor(
    readonly code:
      | 'SCHEMA_VERSION_UNSUPPORTED'
      | 'SCHEMA_STRUCTURE_INVALID'
      | 'BACKUP_INVALID'
      | 'STORE_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationStoreError';
  }
}

const SCHEMA_V1 = `
CREATE TABLE collaboration_groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_principal_id TEXT NOT NULL,
  local_principal_id TEXT NOT NULL,
  local_agent_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  business_state TEXT NOT NULL,
  protocol_status TEXT NOT NULL,
  protocol_error TEXT,
  projection_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE collaboration_remotes (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  remote_url TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  control_branch TEXT NOT NULL,
  signing_key_path TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  signing_key_ref TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  next_sync_at_ms INTEGER NOT NULL,
  backoff_attempt INTEGER NOT NULL DEFAULT 0,
  last_sync_at_ms INTEGER,
  last_error TEXT
);
CREATE TABLE collaboration_memberships (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  member_json TEXT NOT NULL,
  PRIMARY KEY (group_id, principal_id)
);
CREATE TABLE collaboration_role_bindings (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  claimed INTEGER NOT NULL CHECK (claimed IN (0, 1)),
  PRIMARY KEY (group_id, role, principal_id)
);
CREATE TABLE collaboration_projection_heads (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  head_commit TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  projection_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE collaboration_events_cache (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (group_id, event_id),
  UNIQUE (group_id, sequence)
);
CREATE TABLE collaboration_turns (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  fencing_token TEXT,
  turn_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, turn_id)
);
CREATE TABLE collaboration_action_executions (
  execution_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  fencing_token TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  executor_kind TEXT NOT NULL,
  adapter TEXT,
  state TEXT NOT NULL,
  execution_ref TEXT,
  provider_metadata_json TEXT,
  receipt_json TEXT,
  observation_json TEXT,
  pending_result_event_json TEXT,
  dispatch_started_at_ms INTEGER,
  receipt_recorded_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (group_id, turn_id, attempt)
);
CREATE TABLE collaboration_executor_bindings (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  adapter TEXT,
  agent_jid TEXT,
  workspace_path TEXT NOT NULL,
  prompt_override TEXT,
  filesystem_access_cap TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, role)
);
CREATE TABLE collaboration_sync_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  outcome TEXT,
  head_before TEXT,
  head_after TEXT,
  error TEXT
);
CREATE TABLE collaboration_integrity_incidents (
  incident_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  head_commit TEXT,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);
CREATE TABLE collaboration_process_locks (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
);
CREATE INDEX collaboration_groups_status_idx
  ON collaboration_groups(protocol_status, lifecycle);
CREATE INDEX collaboration_events_sequence_idx
  ON collaboration_events_cache(group_id, sequence);
CREATE INDEX collaboration_turns_state_idx
  ON collaboration_turns(group_id, state);
CREATE INDEX collaboration_executions_recovery_idx
  ON collaboration_action_executions(group_id, state, execution_ref);
CREATE INDEX collaboration_sync_attempts_group_idx
  ON collaboration_sync_attempts(group_id, started_at_ms DESC);
CREATE INDEX collaboration_incidents_group_idx
  ON collaboration_integrity_incidents(group_id, created_at_ms DESC);
`;

const MIGRATE_V1_TO_V2 = `
ALTER TABLE collaboration_action_executions
  ADD COLUMN recovery_required_reason TEXT;
ALTER TABLE collaboration_sync_attempts
  ADD COLUMN error_class TEXT;
`;

interface RequiredTable {
  readonly columns: readonly string[];
  readonly indexes?: readonly string[];
}

const REQUIRED_STRUCTURE: Readonly<Record<string, RequiredTable>> = {
  collaboration_groups: {
    columns: [
      'group_id',
      'name',
      'creator_principal_id',
      'local_principal_id',
      'local_agent_id',
      'lifecycle',
      'business_state',
      'protocol_status',
      'projection_json',
    ],
    indexes: ['collaboration_groups_status_idx'],
  },
  collaboration_remotes: {
    columns: [
      'group_id',
      'remote_url',
      'repository_path',
      'signing_key_path',
      'signing_public_key',
      'signing_key_ref',
      'poll_interval_ms',
    ],
  },
  collaboration_role_bindings: {
    columns: ['group_id', 'role', 'principal_id', 'agent_id', 'claimed'],
  },
  collaboration_projection_heads: {
    columns: ['group_id', 'head_commit', 'projection_json'],
  },
  collaboration_events_cache: {
    columns: ['group_id', 'event_id', 'sequence', 'commit_hash', 'event_json'],
    indexes: ['collaboration_events_sequence_idx'],
  },
  collaboration_turns: {
    columns: ['group_id', 'turn_id', 'attempt', 'state', 'turn_json'],
    indexes: ['collaboration_turns_state_idx'],
  },
  collaboration_action_executions: {
    columns: [
      'execution_id',
      'group_id',
      'turn_id',
      'attempt',
      'fencing_token',
      'operation_key',
      'state',
      'execution_ref',
      'provider_metadata_json',
      'receipt_json',
      'pending_result_event_json',
      'recovery_required_reason',
    ],
    indexes: ['collaboration_executions_recovery_idx'],
  },
  collaboration_executor_bindings: {
    columns: [
      'group_id',
      'role',
      'executor_kind',
      'workspace_path',
      'filesystem_access_cap',
      'approval_policy',
      'config_json',
    ],
  },
  collaboration_sync_attempts: {
    columns: ['group_id', 'started_at_ms', 'outcome', 'error', 'error_class'],
    indexes: ['collaboration_sync_attempts_group_idx'],
  },
  collaboration_integrity_incidents: {
    columns: ['incident_id', 'group_id', 'code', 'message', 'created_at_ms'],
    indexes: ['collaboration_incidents_group_idx'],
  },
};

function scalarPragma(database: Database.Database, name: string): unknown {
  return database.pragma(name, { simple: true }) as unknown;
}

function schemaVersion(database: Database.Database): number {
  const value = scalarPragma(database, 'user_version');
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new CollaborationStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Collaboration PRAGMA user_version is invalid: ${String(value)}`,
    );
  return Number(value);
}

function hasUserTables(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
           FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          LIMIT 1`,
      )
      .get(),
  );
}

function migrate(database: Database.Database): void {
  let version = schemaVersion(database);
  if (version > CURRENT_COLLABORATION_SCHEMA_VERSION)
    throw new CollaborationStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Collaboration schema ${String(version)} is newer than supported ${String(CURRENT_COLLABORATION_SCHEMA_VERSION)}`,
    );
  if (version === 0 && hasUserTables(database))
    throw new CollaborationStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      'Unversioned non-empty collaboration database is not safe to migrate',
    );
  if (version === 0) {
    database.transaction(() => {
      database.exec(SCHEMA_V1);
      database.pragma('user_version = 1');
    })();
    version = 1;
  }
  if (version === 1) {
    database.transaction(() => {
      database.exec(MIGRATE_V1_TO_V2);
      database.pragma('user_version = 2');
    })();
    version = 2;
  }
  if (version !== CURRENT_COLLABORATION_SCHEMA_VERSION)
    throw new CollaborationStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `No migration path for collaboration schema ${String(version)}`,
    );
}

export function assertCollaborationStoreStructure(
  database: Database.Database,
): void {
  if (schemaVersion(database) !== CURRENT_COLLABORATION_SCHEMA_VERSION)
    throw new CollaborationStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      'Collaboration database is not at the current schema version',
    );
  for (const [table, requirement] of Object.entries(REQUIRED_STRUCTURE)) {
    const columns = new Set(
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    for (const column of requirement.columns) {
      if (!columns.has(column))
        throw new CollaborationStoreError(
          'SCHEMA_STRUCTURE_INVALID',
          `Collaboration table ${table} is missing column ${column}`,
        );
    }
    const indexes = new Set(
      (
        database.prepare(`PRAGMA index_list(${table})`).all() as Array<{
          name: string;
        }>
      ).map((index) => index.name),
    );
    for (const index of requirement.indexes ?? []) {
      if (!indexes.has(index))
        throw new CollaborationStoreError(
          'SCHEMA_STRUCTURE_INVALID',
          `Collaboration table ${table} is missing index ${index}`,
        );
    }
  }
}

export interface CollaborationGroupRecord {
  readonly groupId: string;
  readonly name: string;
  readonly creatorPrincipalId: string;
  readonly localPrincipalId: string;
  readonly localAgentId: string;
  readonly lifecycle: string;
  readonly businessState: string;
  readonly protocolStatus: string;
  readonly protocolError: string | null;
  readonly projection: CollaborationProjection | null;
  readonly remoteUrl: string;
  readonly repositoryPath: string;
  readonly signingKeyPath: string;
  readonly signingPublicKey: string;
  readonly signingKeyRef: string;
  readonly pollIntervalMs: number;
  readonly nextSyncAtMs: number;
  readonly backoffAttempt: number;
  readonly lastSyncAtMs: number | null;
  readonly lastError: string | null;
  readonly headCommit: string | null;
}

export interface CollaborationExecutorBinding {
  readonly groupId: string;
  readonly role: string;
  readonly executorKind: 'run_once' | 'workflow' | 'external';
  readonly adapter: string | null;
  readonly agentJid: string | null;
  readonly workspacePath: string;
  readonly promptOverride: string | null;
  readonly filesystemAccessCap: FilesystemAccess;
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly updatedAtMs: number;
}

export type CollaborationExecutionState =
  | 'reserved'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';

export interface CollaborationExecutionRecord {
  readonly executionId: string;
  readonly groupId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly attempt: number;
  readonly fencingToken: string;
  readonly operationKey: string;
  readonly executorKind: string;
  readonly adapter: string | null;
  readonly state: CollaborationExecutionState;
  readonly executionRef: string | null;
  readonly providerMetadata: Record<string, unknown> | null;
  readonly receipt: Record<string, unknown> | null;
  readonly observation: Record<string, unknown> | null;
  readonly pendingResultEvent: CollaborationEvent | null;
  readonly recoveryRequiredReason: string | null;
  readonly dispatchStartedAtMs: number | null;
  readonly receiptRecordedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value === '') return null;
  return JSON.parse(value) as T;
}

function groupFromRow(row: Record<string, unknown>): CollaborationGroupRecord {
  return {
    groupId: String(row.group_id),
    name: String(row.name),
    creatorPrincipalId: String(row.creator_principal_id),
    localPrincipalId: String(row.local_principal_id),
    localAgentId: String(row.local_agent_id),
    lifecycle: String(row.lifecycle),
    businessState: String(row.business_state),
    protocolStatus: String(row.protocol_status),
    protocolError:
      row.protocol_error == null ? null : String(row.protocol_error),
    projection: parseJson<CollaborationProjection>(row.projection_json),
    remoteUrl: String(row.remote_url),
    repositoryPath: String(row.repository_path),
    signingKeyPath: String(row.signing_key_path),
    signingPublicKey: String(row.signing_public_key),
    signingKeyRef: String(row.signing_key_ref),
    pollIntervalMs: Number(row.poll_interval_ms),
    nextSyncAtMs: Number(row.next_sync_at_ms),
    backoffAttempt: Number(row.backoff_attempt),
    lastSyncAtMs:
      row.last_sync_at_ms == null ? null : Number(row.last_sync_at_ms),
    lastError: row.last_error == null ? null : String(row.last_error),
    headCommit: row.head_commit == null ? null : String(row.head_commit),
  };
}

function executionFromRow(
  row: Record<string, unknown>,
): CollaborationExecutionRecord {
  return {
    executionId: String(row.execution_id),
    groupId: String(row.group_id),
    turnId: String(row.turn_id),
    epoch: Number(row.epoch),
    attempt: Number(row.attempt),
    fencingToken: String(row.fencing_token),
    operationKey: String(row.operation_key),
    executorKind: String(row.executor_kind),
    adapter: row.adapter == null ? null : String(row.adapter),
    state: String(row.state) as CollaborationExecutionState,
    executionRef: row.execution_ref == null ? null : String(row.execution_ref),
    providerMetadata: parseJson<Record<string, unknown>>(
      row.provider_metadata_json,
    ),
    receipt: parseJson<Record<string, unknown>>(row.receipt_json),
    observation: parseJson<Record<string, unknown>>(row.observation_json),
    pendingResultEvent: parseJson<CollaborationEvent>(
      row.pending_result_event_json,
    ),
    recoveryRequiredReason:
      row.recovery_required_reason == null
        ? null
        : String(row.recovery_required_reason),
    dispatchStartedAtMs:
      row.dispatch_started_at_ms == null
        ? null
        : Number(row.dispatch_started_at_ms),
    receiptRecordedAtMs:
      row.receipt_recorded_at_ms == null
        ? null
        : Number(row.receipt_recorded_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class CollaborationStore {
  private readonly database: Database.Database;
  private closed = false;

  constructor(readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    try {
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('busy_timeout = 5000');
      migrate(this.database);
      assertCollaborationStoreStructure(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new CollaborationStoreError(
        'STORE_CLOSED',
        'Collaboration store is closed',
      );
  }

  registerGroup(input: {
    readonly groupId: string;
    readonly name: string;
    readonly creatorPrincipalId: string;
    readonly localPrincipalId: string;
    readonly localAgentId: string;
    readonly remoteUrl: string;
    readonly repositoryPath: string;
    readonly signingKeyPath: string;
    readonly signingPublicKey: string;
    readonly signingKeyRef: string;
    readonly pollIntervalMs: number;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO collaboration_groups (
             group_id, name, creator_principal_id, local_principal_id,
             local_agent_id, lifecycle, business_state, protocol_status,
             protocol_error, projection_json, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'FORMING', '', 'SYNC_PENDING', NULL, NULL, ?, ?)`,
        )
        .run(
          input.groupId,
          input.name,
          input.creatorPrincipalId,
          input.localPrincipalId,
          input.localAgentId,
          nowMs,
          nowMs,
        );
      this.database
        .prepare(
          `INSERT INTO collaboration_remotes (
             group_id, remote_url, repository_path, control_branch,
             signing_key_path, signing_public_key, signing_key_ref,
             poll_interval_ms, next_sync_at_ms, backoff_attempt
           ) VALUES (?, ?, ?, 'refs/heads/icarus/control', ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          input.groupId,
          input.remoteUrl,
          input.repositoryPath,
          input.signingKeyPath,
          input.signingPublicKey,
          input.signingKeyRef,
          input.pollIntervalMs,
          nowMs,
        );
    })();
  }

  listGroups(): CollaborationGroupRecord[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT g.*, r.*, h.head_commit
             FROM collaboration_groups g
             JOIN collaboration_remotes r ON r.group_id = g.group_id
        LEFT JOIN collaboration_projection_heads h ON h.group_id = g.group_id
         ORDER BY g.updated_at_ms DESC, g.group_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(groupFromRow);
  }

  getGroup(groupId: string): CollaborationGroupRecord | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT g.*, r.*, h.head_commit
           FROM collaboration_groups g
           JOIN collaboration_remotes r ON r.group_id = g.group_id
      LEFT JOIN collaboration_projection_heads h ON h.group_id = g.group_id
          WHERE g.group_id = ?`,
      )
      .get(groupId) as Record<string, unknown> | undefined;
    return row ? groupFromRow(row) : null;
  }

  saveProjection(input: {
    readonly groupId: string;
    readonly headCommit: string;
    readonly projection: CollaborationProjection;
    readonly events: readonly CollaborationEvent[];
    readonly commits?: readonly string[];
    readonly turns: readonly CollaborationTurn[];
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET lifecycle = ?, business_state = ?, protocol_status = 'OK',
                  protocol_error = NULL, projection_json = ?, updated_at_ms = ?
            WHERE group_id = ?`,
        )
        .run(
          input.projection.lifecycle,
          input.projection.businessState,
          JSON.stringify(input.projection),
          nowMs,
          input.groupId,
        );
      this.database
        .prepare(
          `INSERT INTO collaboration_projection_heads (
             group_id, head_commit, epoch, sequence, revision,
             projection_json, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET
             head_commit = excluded.head_commit,
             epoch = excluded.epoch,
             sequence = excluded.sequence,
             revision = excluded.revision,
             projection_json = excluded.projection_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.groupId,
          input.headCommit,
          input.projection.epoch,
          input.projection.sequence,
          input.projection.revision,
          JSON.stringify(input.projection),
          nowMs,
        );
      const eventStatement = this.database.prepare(
        `INSERT INTO collaboration_events_cache (
           group_id, event_id, sequence, commit_hash, event_json
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_id, event_id) DO UPDATE SET
           sequence = excluded.sequence,
           commit_hash = excluded.commit_hash,
           event_json = excluded.event_json`,
      );
      for (const [index, event] of input.events.entries())
        eventStatement.run(
          input.groupId,
          event.event_id,
          event.sequence,
          input.commits?.[index] ??
            (index === input.events.length - 1 ? input.headCommit : ''),
          JSON.stringify(event),
        );
      this.database
        .prepare('DELETE FROM collaboration_memberships WHERE group_id = ?')
        .run(input.groupId);
      const memberStatement = this.database.prepare(
        `INSERT INTO collaboration_memberships (
           group_id, principal_id, agent_id, member_json
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const member of Object.values(input.projection.members))
        memberStatement.run(
          input.groupId,
          member.principal_id,
          member.agent_id,
          JSON.stringify(member),
        );
      this.database
        .prepare('DELETE FROM collaboration_role_bindings WHERE group_id = ?')
        .run(input.groupId);
      const roleStatement = this.database.prepare(
        `INSERT INTO collaboration_role_bindings (
           group_id, role, principal_id, agent_id, claimed
         ) VALUES (?, ?, ?, ?, 1)`,
      );
      for (const [role, claims] of Object.entries(input.projection.roleClaims))
        for (const claim of claims)
          roleStatement.run(
            input.groupId,
            role,
            claim.principal_id,
            claim.agent_id,
          );
      const turnStatement = this.database.prepare(
        `INSERT INTO collaboration_turns (
           group_id, turn_id, epoch, attempt, state, fencing_token,
           turn_json, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, turn_id) DO UPDATE SET
           epoch = excluded.epoch,
           attempt = excluded.attempt,
           state = excluded.state,
           fencing_token = excluded.fencing_token,
           turn_json = excluded.turn_json,
           updated_at_ms = excluded.updated_at_ms`,
      );
      for (const turn of input.turns)
        turnStatement.run(
          input.groupId,
          turn.turnId,
          turn.epoch,
          turn.attempt,
          turn.state,
          turn.fencingToken,
          JSON.stringify(turn),
          nowMs,
        );
    })();
  }

  markProtocolBlocked(
    groupId: string,
    status:
      | 'PROTOCOL_QUARANTINED'
      | 'PROTOCOL_VERSION_UNSUPPORTED'
      | 'LOCAL_SCHEMA_UNSUPPORTED',
    message: string,
    headCommit?: string | null,
    nowMs = Date.now(),
  ): void {
    this.assertOpen();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET protocol_status = ?, protocol_error = ?, updated_at_ms = ?
            WHERE group_id = ?`,
        )
        .run(status, message, nowMs, groupId);
      this.database
        .prepare(
          `INSERT INTO collaboration_integrity_incidents (
             incident_id, group_id, code, message, head_commit, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          groupId,
          status,
          message,
          headCommit ?? null,
          nowMs,
        );
    })();
  }

  recordSyncSuccess(
    groupId: string,
    pollIntervalMs: number,
    nowMs = Date.now(),
  ): void {
    this.assertOpen();
    this.database
      .prepare(
        `UPDATE collaboration_remotes
            SET last_sync_at_ms = ?, last_error = NULL, backoff_attempt = 0,
                next_sync_at_ms = ?
          WHERE group_id = ?`,
      )
      .run(nowMs, nowMs + pollIntervalMs, groupId);
  }

  recordSyncFailure(
    groupId: string,
    error: string,
    baseDelayMs: number,
    nowMs = Date.now(),
  ): void {
    this.assertOpen();
    const group = this.getGroup(groupId);
    if (!group) return;
    const attempt = Math.min(group.backoffAttempt + 1, 8);
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 15 * 60_000);
    this.database
      .prepare(
        `UPDATE collaboration_remotes
            SET last_error = ?, backoff_attempt = ?, next_sync_at_ms = ?
          WHERE group_id = ?`,
      )
      .run(error, attempt, nowMs + delay, groupId);
  }

  listEvents(groupId: string, limit = 200): CollaborationEvent[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT event_json FROM collaboration_events_cache
            WHERE group_id = ? ORDER BY sequence DESC LIMIT ?`,
        )
        .all(groupId, limit) as Array<{ event_json: string }>
    ).map((row) => JSON.parse(row.event_json) as CollaborationEvent);
  }

  listIntegrityIncidents(groupId: string): Array<{
    readonly incidentId: string;
    readonly code: string;
    readonly message: string;
    readonly headCommit: string | null;
    readonly createdAtMs: number;
    readonly resolvedAtMs: number | null;
  }> {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_integrity_incidents
            WHERE group_id = ? ORDER BY created_at_ms DESC`,
        )
        .all(groupId) as Record<string, unknown>[]
    ).map((row) => ({
      incidentId: String(row.incident_id),
      code: String(row.code),
      message: String(row.message),
      headCommit: row.head_commit == null ? null : String(row.head_commit),
      createdAtMs: Number(row.created_at_ms),
      resolvedAtMs:
        row.resolved_at_ms == null ? null : Number(row.resolved_at_ms),
    }));
  }

  saveExecutorBinding(
    binding: Omit<CollaborationExecutorBinding, 'updatedAtMs'> & {
      readonly updatedAtMs?: number;
    },
  ): void {
    this.assertOpen();
    const nowMs = binding.updatedAtMs ?? Date.now();
    this.database
      .prepare(
        `INSERT INTO collaboration_executor_bindings (
           group_id, role, executor_kind, adapter, agent_jid, workspace_path,
           prompt_override, filesystem_access_cap, approval_policy, config_json,
           enabled, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, role) DO UPDATE SET
           executor_kind = excluded.executor_kind,
           adapter = excluded.adapter,
           agent_jid = excluded.agent_jid,
           workspace_path = excluded.workspace_path,
           prompt_override = excluded.prompt_override,
           filesystem_access_cap = excluded.filesystem_access_cap,
           approval_policy = excluded.approval_policy,
           config_json = excluded.config_json,
           enabled = excluded.enabled,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        binding.groupId,
        binding.role,
        binding.executorKind,
        binding.adapter,
        binding.agentJid,
        binding.workspacePath,
        binding.promptOverride,
        binding.filesystemAccessCap,
        binding.approvalPolicy,
        JSON.stringify(binding.config),
        binding.enabled ? 1 : 0,
        nowMs,
      );
  }

  getExecutorBinding(
    groupId: string,
    role: string,
  ): CollaborationExecutorBinding | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM collaboration_executor_bindings
          WHERE group_id = ? AND role = ?`,
      )
      .get(groupId, role) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      groupId: String(row.group_id),
      role: String(row.role),
      executorKind: String(
        row.executor_kind,
      ) as CollaborationExecutorBinding['executorKind'],
      adapter: row.adapter == null ? null : String(row.adapter),
      agentJid: row.agent_jid == null ? null : String(row.agent_jid),
      workspacePath: String(row.workspace_path),
      promptOverride:
        row.prompt_override == null ? null : String(row.prompt_override),
      filesystemAccessCap: String(
        row.filesystem_access_cap,
      ) as FilesystemAccess,
      approvalPolicy: String(
        row.approval_policy,
      ) as CollaborationExecutorBinding['approvalPolicy'],
      config: parseJson<Record<string, unknown>>(row.config_json) ?? {},
      enabled: Number(row.enabled) === 1,
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  listExecutorBindings(groupId: string): CollaborationExecutorBinding[] {
    this.assertOpen();
    const roles = this.database
      .prepare(
        'SELECT role FROM collaboration_executor_bindings WHERE group_id = ? ORDER BY role',
      )
      .all(groupId) as Array<{ role: string }>;
    return roles
      .map((row) => this.getExecutorBinding(groupId, row.role))
      .filter((binding): binding is CollaborationExecutorBinding =>
        Boolean(binding),
      );
  }

  reserveExecution(input: {
    readonly executionId?: string;
    readonly groupId: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly attempt: number;
    readonly fencingToken: string;
    readonly operationKey: string;
    readonly executorKind: string;
    readonly adapter?: string | null;
    readonly nowMs?: number;
  }): CollaborationExecutionRecord {
    this.assertOpen();
    const existing = this.getExecutionByOperationKey(input.operationKey);
    if (existing) return existing;
    const nowMs = input.nowMs ?? Date.now();
    const executionId =
      input.executionId ?? `collaboration:${crypto.randomUUID()}`;
    try {
      this.database
        .prepare(
          `INSERT INTO collaboration_action_executions (
             execution_id, group_id, turn_id, epoch, attempt, fencing_token,
             operation_key, executor_kind, adapter, state, created_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          executionId,
          input.groupId,
          input.turnId,
          input.epoch,
          input.attempt,
          input.fencingToken,
          input.operationKey,
          input.executorKind,
          input.adapter ?? null,
          nowMs,
          nowMs,
        );
    } catch (error) {
      const raced = this.getExecutionByOperationKey(input.operationKey);
      if (raced) return raced;
      throw error;
    }
    return this.getExecutionByOperationKey(input.operationKey)!;
  }

  markDispatchStarted(executionId: string, nowMs = Date.now()): void {
    this.assertOpen();
    this.database
      .prepare(
        `UPDATE collaboration_action_executions
            SET state = 'dispatching', dispatch_started_at_ms = ?, updated_at_ms = ?
          WHERE execution_id = ? AND state = 'reserved'`,
      )
      .run(nowMs, nowMs, executionId);
  }

  recordDispatchReceipt(input: {
    readonly executionId: string;
    readonly executionRef: string;
    readonly providerMetadata: Record<string, unknown>;
    readonly receipt: Record<string, unknown>;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    const result = this.database
      .prepare(
        `UPDATE collaboration_action_executions
            SET state = 'accepted', execution_ref = ?, provider_metadata_json = ?,
                receipt_json = ?, receipt_recorded_at_ms = ?, updated_at_ms = ?,
                recovery_required_reason = NULL
          WHERE execution_id = ? AND state IN ('dispatching', 'accepted')`,
      )
      .run(
        input.executionRef,
        JSON.stringify(input.providerMetadata),
        JSON.stringify(input.receipt),
        nowMs,
        nowMs,
        input.executionId,
      );
    if (result.changes !== 1)
      throw new Error(
        `Execution cannot accept a receipt: ${input.executionId}`,
      );
  }

  saveObservation(input: {
    readonly executionId: string;
    readonly state: CollaborationExecutionState;
    readonly observation: Record<string, unknown>;
    readonly pendingResultEvent?: CollaborationEvent | null;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    this.database
      .prepare(
        `UPDATE collaboration_action_executions
            SET state = ?, observation_json = ?, pending_result_event_json = ?,
                updated_at_ms = ?
          WHERE execution_id = ?`,
      )
      .run(
        input.state,
        JSON.stringify(input.observation),
        input.pendingResultEvent
          ? JSON.stringify(input.pendingResultEvent)
          : null,
        nowMs,
        input.executionId,
      );
  }

  requireRecovery(
    executionId: string,
    reason: string,
    nowMs = Date.now(),
  ): void {
    this.assertOpen();
    this.database
      .prepare(
        `UPDATE collaboration_action_executions
            SET state = 'recovery_required', recovery_required_reason = ?,
                updated_at_ms = ?
          WHERE execution_id = ?`,
      )
      .run(reason, nowMs, executionId);
  }

  getExecutionByOperationKey(
    operationKey: string,
  ): CollaborationExecutionRecord | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        'SELECT * FROM collaboration_action_executions WHERE operation_key = ?',
      )
      .get(operationKey) as Record<string, unknown> | undefined;
    return row ? executionFromRow(row) : null;
  }

  getExecutionForTurn(
    groupId: string,
    turnId: string,
    attempt: number,
  ): CollaborationExecutionRecord | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM collaboration_action_executions
          WHERE group_id = ? AND turn_id = ? AND attempt = ?`,
      )
      .get(groupId, turnId, attempt) as Record<string, unknown> | undefined;
    return row ? executionFromRow(row) : null;
  }

  markReceiptlessExecutionsForRecovery(
    reason = 'A claimed action has no durable dispatch receipt; automatic redispatch is forbidden',
    nowMs = Date.now(),
  ): CollaborationExecutionRecord[] {
    this.assertOpen();
    this.database
      .prepare(
        `UPDATE collaboration_action_executions
            SET state = 'recovery_required', recovery_required_reason = ?,
                updated_at_ms = ?
          WHERE state IN ('reserved', 'dispatching')
            AND receipt_json IS NULL`,
      )
      .run(reason, nowMs);
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_action_executions
            WHERE state = 'recovery_required'
              AND receipt_json IS NULL
         ORDER BY created_at_ms, execution_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(executionFromRow);
  }

  clearRebuildableState(groupId: string): void {
    this.assertOpen();
    this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM collaboration_events_cache WHERE group_id = ?')
        .run(groupId);
      this.database
        .prepare('DELETE FROM collaboration_turns WHERE group_id = ?')
        .run(groupId);
      this.database
        .prepare(
          'DELETE FROM collaboration_projection_heads WHERE group_id = ?',
        )
        .run(groupId);
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET projection_json = NULL, protocol_status = 'SYNC_PENDING',
                  protocol_error = NULL, updated_at_ms = ?
            WHERE group_id = ?`,
        )
        .run(Date.now(), groupId);
    })();
  }

  tryAcquireGroupLock(
    groupId: string,
    ownerId: string,
    staleBeforeMs: number,
    nowMs = Date.now(),
  ): boolean {
    this.assertOpen();
    return this.database.transaction(() => {
      this.database
        .prepare(
          'DELETE FROM collaboration_process_locks WHERE group_id = ? AND heartbeat_at_ms < ?',
        )
        .run(groupId, staleBeforeMs);
      const result = this.database
        .prepare(
          `INSERT INTO collaboration_process_locks (
             group_id, owner_id, acquired_at_ms, heartbeat_at_ms
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(group_id) DO NOTHING`,
        )
        .run(groupId, ownerId, nowMs, nowMs);
      return result.changes === 1;
    })();
  }

  releaseGroupLock(groupId: string, ownerId: string): void {
    this.assertOpen();
    this.database
      .prepare(
        'DELETE FROM collaboration_process_locks WHERE group_id = ? AND owner_id = ?',
      )
      .run(groupId, ownerId);
  }

  rawDatabaseForTests(): Database.Database {
    this.assertOpen();
    return this.database;
  }
}

interface BackupManifestFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CollaborationBackupManifest {
  readonly format: 'icarus.collaboration-backup/1';
  readonly database_basename: string;
  readonly schema_version: number;
  readonly created_at: string;
  readonly files: readonly BackupManifestFile[];
}

function fileHash(file: string): string {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assertScopedDatabasePath(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  if (
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(process.env.HOME ?? '/nonexistent') ||
    !path.basename(resolved).endsWith('.db')
  )
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Unsafe collaboration database path: ${resolved}`,
    );
  return resolved;
}

export function createCollaborationBackup(input: {
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly createdAt?: Date;
}): CollaborationBackupManifest {
  const databasePath = assertScopedDatabasePath(input.databasePath);
  if (!existsSync(databasePath))
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Collaboration database does not exist: ${databasePath}`,
    );
  const backupDirectory = path.resolve(input.backupDirectory);
  if (existsSync(backupDirectory))
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Backup directory already exists: ${backupDirectory}`,
    );
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const checkpoint = new Database(databasePath);
  let version: number;
  try {
    checkpoint.pragma('busy_timeout = 5000');
    checkpoint.pragma('wal_checkpoint(TRUNCATE)');
    version = schemaVersion(checkpoint);
  } finally {
    checkpoint.close();
  }
  const sourceFiles = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ].filter(existsSync);
  const files = sourceFiles.map((source) => {
    const name = path.basename(source);
    const destination = path.join(backupDirectory, name);
    copyFileSync(source, destination);
    return {
      name,
      size: statSync(destination).size,
      sha256: fileHash(destination),
    };
  });
  const manifest: CollaborationBackupManifest = {
    format: 'icarus.collaboration-backup/1',
    database_basename: path.basename(databasePath),
    schema_version: version,
    created_at: (input.createdAt ?? new Date()).toISOString(),
    files,
  };
  writeFileSync(
    path.join(backupDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function restoreCollaborationBackup(input: {
  readonly databasePath: string;
  readonly backupDirectory: string;
}): { readonly rollbackDirectory: string | null } {
  const databasePath = assertScopedDatabasePath(input.databasePath);
  const backupDirectory = path.resolve(input.backupDirectory);
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  let manifest: CollaborationBackupManifest;
  try {
    manifest = JSON.parse(
      readFileSync(manifestPath, 'utf8'),
    ) as CollaborationBackupManifest;
  } catch (error) {
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Collaboration backup manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    manifest.format !== 'icarus.collaboration-backup/1' ||
    manifest.database_basename !== path.basename(databasePath) ||
    manifest.schema_version > CURRENT_COLLABORATION_SCHEMA_VERSION ||
    !Array.isArray(manifest.files)
  )
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      'Collaboration backup manifest is incompatible with the restore target',
    );
  for (const file of manifest.files) {
    if (
      path.basename(file.name) !== file.name ||
      ![
        path.basename(databasePath),
        `${path.basename(databasePath)}-wal`,
        `${path.basename(databasePath)}-shm`,
      ].includes(file.name)
    )
      throw new CollaborationStoreError(
        'BACKUP_INVALID',
        `Collaboration backup contains an invalid file: ${file.name}`,
      );
    const source = path.join(backupDirectory, file.name);
    if (
      !existsSync(source) ||
      statSync(source).size !== file.size ||
      fileHash(source) !== file.sha256
    )
      throw new CollaborationStoreError(
        'BACKUP_INVALID',
        `Collaboration backup file failed verification: ${file.name}`,
      );
  }
  const targetDirectory = path.dirname(databasePath);
  mkdirSync(targetDirectory, { recursive: true });
  const stagingDirectory = path.join(
    targetDirectory,
    `.collaboration-restore-${crypto.randomUUID()}`,
  );
  mkdirSync(stagingDirectory, { mode: 0o700 });
  for (const file of manifest.files)
    copyFileSync(
      path.join(backupDirectory, file.name),
      path.join(stagingDirectory, file.name),
    );
  const stagedDatabase = path.join(
    stagingDirectory,
    path.basename(databasePath),
  );
  const restored = new Database(stagedDatabase, { readonly: true });
  try {
    assertCollaborationStoreStructure(restored);
  } catch (error) {
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Restored collaboration database failed structure validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    restored.close();
  }
  const liveFiles = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ].filter(existsSync);
  const rollbackDirectory =
    liveFiles.length > 0
      ? path.join(
          targetDirectory,
          `.collaboration-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        )
      : null;
  if (rollbackDirectory) mkdirSync(rollbackDirectory, { mode: 0o700 });
  try {
    for (const live of liveFiles)
      renameSync(live, path.join(rollbackDirectory!, path.basename(live)));
    for (const file of manifest.files)
      renameSync(
        path.join(stagingDirectory, file.name),
        path.join(targetDirectory, file.name),
      );
  } catch (error) {
    for (const live of liveFiles) {
      const rollback = path.join(rollbackDirectory!, path.basename(live));
      if (existsSync(rollback) && !existsSync(live)) renameSync(rollback, live);
    }
    throw new CollaborationStoreError(
      'BACKUP_INVALID',
      `Collaboration restore could not replace the live database: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
  return { rollbackDirectory };
}

export const collaborationSchemaV1ForTests = SCHEMA_V1;
