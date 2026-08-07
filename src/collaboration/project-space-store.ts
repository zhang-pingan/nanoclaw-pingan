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

import {
  observerSubscriptionSchema,
  type CollaborationEventV3,
  type CollaborationTurnV3,
  type ObserverSubscription,
} from './protocol/v3-schema.js';
import type {
  CollaborationProjectionV3,
  CollaborationAggregateHeadV3,
} from './protocol/v3-reducer.js';

export const CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION = 5;
export const COLLABORATION_PROJECT_SPACE_STORE_FORMAT =
  'icarus.collaboration-local-store/5';

export class CollaborationProjectSpaceStoreError extends Error {
  constructor(
    readonly code:
      | 'SCHEMA_VERSION_UNSUPPORTED'
      | 'SCHEMA_STRUCTURE_INVALID'
      | 'STORE_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationProjectSpaceStoreError';
  }
}

const SCHEMA_V5 = `
CREATE TABLE collaboration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE collaboration_subscriptions (
  group_id TEXT PRIMARY KEY,
  remote_url TEXT NOT NULL,
  subscription_mode TEXT NOT NULL CHECK (subscription_mode IN ('observer', 'member')),
  poll_interval_ms INTEGER NOT NULL,
  next_sync_at_ms INTEGER NOT NULL,
  last_verified_head TEXT,
  notifications_enabled INTEGER NOT NULL CHECK (notifications_enabled IN (0, 1)),
  backoff_attempt INTEGER NOT NULL DEFAULT 0,
  last_sync_at_ms INTEGER,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE collaboration_groups (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_subscriptions(group_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  local_principal_id TEXT,
  local_client_id TEXT,
  repository_path TEXT NOT NULL,
  signing_key_path TEXT,
  signing_public_key TEXT,
  signing_key_ref TEXT,
  protocol_status TEXT NOT NULL,
  protocol_error TEXT,
  projection_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE collaboration_principals (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  display_name TEXT NOT NULL,
  member_json TEXT NOT NULL,
  PRIMARY KEY (group_id, principal_id)
);
CREATE TABLE collaboration_clients (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL,
  client_json TEXT NOT NULL,
  PRIMARY KEY (group_id, principal_id, client_id)
);
CREATE TABLE collaboration_permission_grants (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  grant_json TEXT NOT NULL,
  PRIMARY KEY (group_id, principal_id)
);
CREATE TABLE collaboration_aggregate_checkpoints (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  event_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  PRIMARY KEY (group_id, aggregate_type, aggregate_id)
);
CREATE TABLE collaboration_event_cache (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  commit_order INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (group_id, event_id),
  UNIQUE (group_id, aggregate_type, aggregate_id, aggregate_revision),
  UNIQUE (group_id, commit_order)
);
CREATE TABLE collaboration_file_index (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  virtual_path TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  owner_principal_id TEXT,
  metadata_json TEXT NOT NULL,
  verified_head TEXT NOT NULL,
  PRIMARY KEY (group_id, file_id),
  UNIQUE (group_id, repository_path)
);
CREATE TABLE collaboration_progress_updates (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  update_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  update_json TEXT NOT NULL,
  PRIMARY KEY (group_id, update_id)
);
CREATE TABLE collaboration_work_items (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  due_at TEXT,
  revision INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  PRIMARY KEY (group_id, work_item_id)
);
CREATE TABLE collaboration_work_item_updates (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  update_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  update_json TEXT NOT NULL,
  PRIMARY KEY (group_id, update_id)
);
CREATE TABLE collaboration_work_item_relations (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  target_work_item_id TEXT NOT NULL,
  PRIMARY KEY (group_id, work_item_id, relation_type, target_work_item_id)
);
CREATE TABLE collaboration_discussions (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  discussion_json TEXT NOT NULL,
  PRIMARY KEY (group_id, thread_id)
);
CREATE TABLE collaboration_messages (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL CHECK (tombstoned IN (0, 1)),
  message_json TEXT NOT NULL,
  PRIMARY KEY (group_id, message_id)
);
CREATE TABLE collaboration_workflow_definitions (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  machine_hash TEXT NOT NULL,
  layout_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  machine_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  PRIMARY KEY (group_id, definition_id, version)
);
CREATE TABLE collaboration_workflow_instances (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  business_state TEXT NOT NULL,
  active_turn_id TEXT,
  revision INTEGER NOT NULL,
  instance_json TEXT NOT NULL,
  PRIMARY KEY (group_id, instance_id)
);
CREATE TABLE collaboration_state_executions (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  PRIMARY KEY (group_id, instance_id, state_id)
);
CREATE TABLE collaboration_turns (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  assignee_principal_id TEXT NOT NULL,
  claimant_client_id TEXT,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  fencing_token TEXT,
  turn_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, turn_id)
);
CREATE TABLE collaboration_executor_bindings (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  filesystem_access TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, instance_id, state_id, principal_id, client_id, action_hash, prompt_hash)
);
CREATE TABLE collaboration_action_executions (
  execution_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE RESTRICT,
  instance_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  claimant_client_id TEXT NOT NULL,
  fencing_token TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  executor_id TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  execution_ref TEXT,
  provider_metadata_json TEXT,
  receipt_json TEXT,
  observation_json TEXT,
  recovery_required_reason TEXT,
  dispatch_started_at_ms INTEGER,
  receipt_recorded_at_ms INTEGER,
  provider_completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (group_id, turn_id, attempt)
);
CREATE TABLE collaboration_staged_artifacts (
  artifact_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  turn_id TEXT,
  attempt INTEGER,
  fencing_token TEXT,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  staged_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  committed_at_ms INTEGER
);
CREATE TABLE collaboration_notifications (
  notification_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  recipient_principal_id TEXT NOT NULL,
  recipient_client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  reminder_ordinal INTEGER NOT NULL,
  due_at_ms INTEGER,
  first_observed_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  payload_json TEXT NOT NULL
);
CREATE TABLE collaboration_timeout_schedules (
  schedule_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  deadline_kind TEXT NOT NULL CHECK (deadline_kind IN ('start', 'execution')),
  deadline_at_ms INTEGER NOT NULL,
  reminder_interval_ms INTEGER,
  next_reminder_at_ms INTEGER NOT NULL,
  reminder_ordinal INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  UNIQUE (group_id, turn_id, attempt, deadline_kind)
);
CREATE TABLE collaboration_sync_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  outcome TEXT NOT NULL,
  head_before TEXT,
  head_after TEXT,
  error TEXT,
  error_class TEXT
);
CREATE TABLE collaboration_integrity_incidents (
  incident_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  head_commit TEXT,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  UNIQUE (group_id, code, message, head_commit, resolved_at_ms)
);
CREATE TABLE collaboration_local_audit_evidence (
  evidence_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE TABLE collaboration_process_locks (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(group_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL
);
CREATE INDEX collaboration_event_activity_idx
  ON collaboration_event_cache(group_id, commit_order DESC);
CREATE INDEX collaboration_file_virtual_path_idx
  ON collaboration_file_index(group_id, virtual_path);
CREATE INDEX collaboration_work_item_status_idx
  ON collaboration_work_items(group_id, status, due_at);
CREATE INDEX collaboration_message_thread_idx
  ON collaboration_messages(group_id, thread_id);
CREATE INDEX collaboration_instance_status_idx
  ON collaboration_workflow_instances(group_id, lifecycle, business_state);
CREATE INDEX collaboration_turn_state_idx
  ON collaboration_turns(group_id, state, assignee_principal_id);
CREATE INDEX collaboration_notification_pending_idx
  ON collaboration_notifications(recipient_principal_id, recipient_client_id, delivered_at_ms, first_observed_at_ms);
CREATE INDEX collaboration_timeout_due_idx
  ON collaboration_timeout_schedules(active, next_reminder_at_ms);
CREATE INDEX collaboration_sync_group_idx
  ON collaboration_sync_attempts(group_id, started_at_ms DESC);
CREATE INDEX collaboration_incident_group_idx
  ON collaboration_integrity_incidents(group_id, created_at_ms DESC);
`;

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  collaboration_meta: ['key', 'value'],
  collaboration_subscriptions: [
    'group_id',
    'remote_url',
    'subscription_mode',
    'poll_interval_ms',
    'last_verified_head',
  ],
  collaboration_groups: [
    'group_id',
    'name',
    'local_principal_id',
    'local_client_id',
    'projection_json',
  ],
  collaboration_principals: ['group_id', 'principal_id', 'member_json'],
  collaboration_clients: ['group_id', 'principal_id', 'client_id'],
  collaboration_permission_grants: ['group_id', 'principal_id', 'grant_json'],
  collaboration_aggregate_checkpoints: [
    'group_id',
    'aggregate_type',
    'aggregate_id',
    'revision',
    'event_hash',
  ],
  collaboration_event_cache: [
    'group_id',
    'event_id',
    'aggregate_revision',
    'commit_order',
  ],
  collaboration_file_index: ['group_id', 'file_id', 'virtual_path'],
  collaboration_progress_updates: ['group_id', 'update_id', 'principal_id'],
  collaboration_work_items: ['group_id', 'work_item_id', 'status', 'revision'],
  collaboration_work_item_updates: ['group_id', 'work_item_id', 'update_id'],
  collaboration_work_item_relations: [
    'group_id',
    'work_item_id',
    'relation_type',
    'target_work_item_id',
  ],
  collaboration_discussions: ['group_id', 'thread_id', 'revision'],
  collaboration_messages: ['group_id', 'thread_id', 'message_id', 'revision'],
  collaboration_workflow_definitions: [
    'group_id',
    'definition_id',
    'version',
    'machine_hash',
  ],
  collaboration_workflow_instances: ['group_id', 'instance_id', 'revision'],
  collaboration_state_executions: ['group_id', 'instance_id', 'state_id'],
  collaboration_turns: ['group_id', 'instance_id', 'turn_id', 'attempt'],
  collaboration_executor_bindings: [
    'group_id',
    'instance_id',
    'state_id',
    'client_id',
  ],
  collaboration_action_executions: [
    'execution_id',
    'group_id',
    'turn_id',
    'operation_key',
  ],
  collaboration_staged_artifacts: ['artifact_id', 'group_id', 'scope_type'],
  collaboration_notifications: ['notification_id', 'group_id', 'dedupe_key'],
  collaboration_timeout_schedules: [
    'schedule_id',
    'group_id',
    'turn_id',
    'deadline_kind',
  ],
  collaboration_sync_attempts: ['id', 'group_id', 'outcome'],
  collaboration_integrity_incidents: ['incident_id', 'group_id', 'code'],
  collaboration_local_audit_evidence: ['evidence_id', 'group_id'],
  collaboration_process_locks: ['group_id', 'owner_id'],
};

function schemaVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(value))
    throw new CollaborationProjectSpaceStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Invalid collaboration schema version: ${String(value)}`,
    );
  return Number(value);
}

function hasUserTables(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
      )
      .get(),
  );
}

function initialize(database: Database.Database): void {
  const version = schemaVersion(database);
  if (
    version !== 0 &&
    version !== CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION
  )
    throw new CollaborationProjectSpaceStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      `Collaboration schema v${String(version)} is stale; reinitialize explicitly for current v${String(CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION)}`,
    );
  if (version === 0 && hasUserTables(database))
    throw new CollaborationProjectSpaceStoreError(
      'SCHEMA_VERSION_UNSUPPORTED',
      'Unversioned non-empty collaboration store cannot be adopted',
    );
  if (version === 0)
    database.transaction(() => {
      database.exec(SCHEMA_V5);
      database
        .prepare('INSERT INTO collaboration_meta (key, value) VALUES (?, ?)')
        .run('format', COLLABORATION_PROJECT_SPACE_STORE_FORMAT);
      database.pragma(
        `user_version = ${String(CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION)}`,
      );
    })();
}

function assertStructure(database: Database.Database): void {
  const format = database
    .prepare("SELECT value FROM collaboration_meta WHERE key = 'format'")
    .get() as { value?: unknown } | undefined;
  if (format?.value !== COLLABORATION_PROJECT_SPACE_STORE_FORMAT)
    throw new CollaborationProjectSpaceStoreError(
      'SCHEMA_STRUCTURE_INVALID',
      'Collaboration store format marker is missing or stale',
    );
  for (const [table, required] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const columns = new Set(
      (
        database.pragma(`table_info(${table})`) as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const column of required)
      if (!columns.has(column))
        throw new CollaborationProjectSpaceStoreError(
          'SCHEMA_STRUCTURE_INVALID',
          `Collaboration store is missing ${table}.${column}`,
        );
  }
}

function parseJson<T>(value: unknown): T | null {
  return typeof value === 'string' && value.length > 0
    ? (JSON.parse(value) as T)
    : null;
}

export interface CollaborationProjectSpaceGroupRecord {
  readonly groupId: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly ownerPrincipalId: string;
  readonly subscriptionMode: 'observer' | 'member';
  readonly localPrincipalId: string | null;
  readonly localClientId: string | null;
  readonly remoteUrl: string;
  readonly repositoryPath: string;
  readonly signingKeyPath: string | null;
  readonly signingPublicKey: string | null;
  readonly signingKeyRef: string | null;
  readonly protocolStatus: string;
  readonly protocolError: string | null;
  readonly projection: CollaborationProjectionV3 | null;
  readonly pollIntervalMs: number;
  readonly nextSyncAtMs: number;
  readonly lastVerifiedHead: string | null;
  readonly lastSyncAtMs: number | null;
  readonly lastError: string | null;
  readonly backoffAttempt: number;
}

export interface CollaborationProjectSpaceEventRecord {
  readonly event: CollaborationEventV3;
  readonly commitHash: string;
  readonly commitOrder: number;
}

export interface CollaborationExecutorBindingV3 {
  readonly groupId: string;
  readonly instanceId: string;
  readonly stateId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly actionHash: string;
  readonly promptHash: string;
  readonly executorId: string;
  readonly executorKind: 'run_once' | 'workflow' | 'external' | 'codex';
  readonly workspacePath: string;
  readonly filesystemAccess: 'read_only' | 'workspace_write';
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly updatedAtMs: number;
}

export interface CollaborationNotificationV3 {
  readonly notificationId: string;
  readonly groupId: string;
  readonly recipientPrincipalId: string;
  readonly recipientClientId: string;
  readonly kind: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly dedupeKey: string;
  readonly reminderOrdinal: number;
  readonly dueAtMs: number | null;
  readonly firstObservedAtMs: number;
  readonly deliveredAtMs: number | null;
  readonly payload: Record<string, unknown>;
}

export interface CollaborationActionExecutionV3 {
  readonly executionId: string;
  readonly groupId: string;
  readonly instanceId: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly attempt: number;
  readonly claimantClientId: string;
  readonly fencingToken: string;
  readonly operationKey: string;
  readonly executorId: string;
  readonly executorKind: string;
  readonly state: string;
  readonly executionRef: string | null;
  readonly providerMetadata: Record<string, unknown> | null;
  readonly receipt: Record<string, unknown> | null;
  readonly observation: Record<string, unknown> | null;
  readonly recoveryRequiredReason: string | null;
  readonly dispatchStartedAtMs: number | null;
  readonly receiptRecordedAtMs: number | null;
  readonly providerCompletedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CollaborationTimeoutScheduleV3 {
  readonly scheduleId: string;
  readonly groupId: string;
  readonly instanceId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly deadlineKind: 'start' | 'execution';
  readonly deadlineAtMs: number;
  readonly reminderIntervalMs: number | null;
  readonly nextReminderAtMs: number;
  readonly reminderOrdinal: number;
  readonly active: boolean;
}

export interface CollaborationSyncAttemptV3 {
  readonly id: number;
  readonly groupId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly outcome: string;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly error: string | null;
  readonly errorClass: string | null;
}

function groupFromRow(
  row: Record<string, unknown>,
): CollaborationProjectSpaceGroupRecord {
  return {
    groupId: String(row.group_id),
    name: String(row.name),
    lifecycle: String(row.lifecycle),
    ownerPrincipalId: String(row.owner_principal_id),
    subscriptionMode: String(row.subscription_mode) as 'observer' | 'member',
    localPrincipalId:
      row.local_principal_id == null ? null : String(row.local_principal_id),
    localClientId:
      row.local_client_id == null ? null : String(row.local_client_id),
    remoteUrl: String(row.remote_url),
    repositoryPath: String(row.repository_path),
    signingKeyPath:
      row.signing_key_path == null ? null : String(row.signing_key_path),
    signingPublicKey:
      row.signing_public_key == null ? null : String(row.signing_public_key),
    signingKeyRef:
      row.signing_key_ref == null ? null : String(row.signing_key_ref),
    protocolStatus: String(row.protocol_status),
    protocolError:
      row.protocol_error == null ? null : String(row.protocol_error),
    projection: parseJson<CollaborationProjectionV3>(row.projection_json),
    pollIntervalMs: Number(row.poll_interval_ms),
    nextSyncAtMs: Number(row.next_sync_at_ms),
    lastVerifiedHead:
      row.last_verified_head == null ? null : String(row.last_verified_head),
    lastSyncAtMs:
      row.last_sync_at_ms == null ? null : Number(row.last_sync_at_ms),
    lastError: row.last_error == null ? null : String(row.last_error),
    backoffAttempt: Number(row.backoff_attempt),
  };
}

export class CollaborationProjectSpaceStore {
  private readonly database: Database.Database;
  private closed = false;

  constructor(readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    try {
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('busy_timeout = 5000');
      initialize(this.database);
      assertStructure(this.database);
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
      throw new CollaborationProjectSpaceStoreError(
        'STORE_CLOSED',
        'Collaboration project space store is closed',
      );
  }

  registerGroup(input: {
    readonly subscription: ObserverSubscription;
    readonly name: string;
    readonly lifecycle: string;
    readonly ownerPrincipalId: string;
    readonly repositoryPath: string;
    readonly localPrincipalId?: string | null;
    readonly localClientId?: string | null;
    readonly signingKeyPath?: string | null;
    readonly signingPublicKey?: string | null;
    readonly signingKeyRef?: string | null;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const subscription = observerSubscriptionSchema.parse(input.subscription);
    const isMember = subscription.subscription_mode === 'member';
    if (
      isMember !== Boolean(input.localPrincipalId && input.localClientId) ||
      isMember !==
        Boolean(
          input.signingKeyPath && input.signingPublicKey && input.signingKeyRef,
        )
    )
      throw new Error(
        'Member subscription requires local Principal, Client, and signing identity; Observer requires none',
      );
    const nowMs = input.nowMs ?? Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO collaboration_subscriptions (
             group_id, remote_url, subscription_mode, poll_interval_ms,
             next_sync_at_ms, last_verified_head, notifications_enabled,
             backoff_attempt, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          subscription.group_id,
          subscription.remote_url,
          subscription.subscription_mode,
          subscription.poll_interval_ms,
          nowMs,
          subscription.last_verified_head,
          subscription.notifications_enabled ? 1 : 0,
          nowMs,
        );
      this.database
        .prepare(
          `INSERT INTO collaboration_groups (
             group_id, name, lifecycle, owner_principal_id,
             local_principal_id, local_client_id, repository_path,
             signing_key_path, signing_public_key, signing_key_ref,
             protocol_status, protocol_error, projection_json,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNC_PENDING', NULL, NULL, ?, ?)`,
        )
        .run(
          subscription.group_id,
          input.name,
          input.lifecycle,
          input.ownerPrincipalId,
          input.localPrincipalId ?? null,
          input.localClientId ?? null,
          input.repositoryPath,
          input.signingKeyPath ?? null,
          input.signingPublicKey ?? null,
          input.signingKeyRef ?? null,
          nowMs,
          nowMs,
        );
    })();
  }

  updateSubscriptionMode(input: {
    readonly groupId: string;
    readonly localPrincipalId: string;
    readonly localClientId: string;
    readonly signingKeyPath: string;
    readonly signingPublicKey: string;
    readonly signingKeyRef: string;
  }): void {
    this.assertOpen();
    this.database.transaction(() => {
      const subscription = this.database
        .prepare(
          'SELECT subscription_mode FROM collaboration_subscriptions WHERE group_id = ?',
        )
        .get(input.groupId) as { subscription_mode?: unknown } | undefined;
      if (subscription?.subscription_mode !== 'observer')
        throw new Error('Only an Observer subscription can upgrade to Member');
      this.database
        .prepare(
          `UPDATE collaboration_subscriptions SET subscription_mode = 'member'
            WHERE group_id = ?`,
        )
        .run(input.groupId);
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET local_principal_id = ?, local_client_id = ?, signing_key_path = ?,
                  signing_public_key = ?, signing_key_ref = ?, updated_at_ms = ?
            WHERE group_id = ?`,
        )
        .run(
          input.localPrincipalId,
          input.localClientId,
          input.signingKeyPath,
          input.signingPublicKey,
          input.signingKeyRef,
          Date.now(),
          input.groupId,
        );
    })();
  }

  deleteSubscription(groupId: string): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare('DELETE FROM collaboration_subscriptions WHERE group_id = ?')
        .run(groupId).changes === 1
    );
  }

  listGroups(): CollaborationProjectSpaceGroupRecord[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT g.*, s.* FROM collaboration_groups g
             JOIN collaboration_subscriptions s ON s.group_id = g.group_id
         ORDER BY g.updated_at_ms DESC, g.group_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(groupFromRow);
  }

  getGroup(groupId: string): CollaborationProjectSpaceGroupRecord | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT g.*, s.* FROM collaboration_groups g
           JOIN collaboration_subscriptions s ON s.group_id = g.group_id
          WHERE g.group_id = ?`,
      )
      .get(groupId) as Record<string, unknown> | undefined;
    return row ? groupFromRow(row) : null;
  }

  saveVerifiedProjection(input: {
    readonly groupId: string;
    readonly verifiedHead: string;
    readonly projection: CollaborationProjectionV3;
    readonly eventRecords: readonly CollaborationProjectSpaceEventRecord[];
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET name = ?, lifecycle = ?, owner_principal_id = ?,
                  protocol_status = 'OK', protocol_error = NULL,
                  projection_json = ?, updated_at_ms = ?
            WHERE group_id = ?`,
        )
        .run(
          input.projection.group.name,
          input.projection.group.lifecycle,
          input.projection.group.owner_principal_id,
          JSON.stringify(input.projection),
          nowMs,
          input.groupId,
        );
      this.database
        .prepare(
          `UPDATE collaboration_subscriptions
              SET last_verified_head = ?, last_sync_at_ms = ?, last_error = NULL,
                  backoff_attempt = 0
            WHERE group_id = ?`,
        )
        .run(input.verifiedHead, nowMs, input.groupId);

      const checkpoint = this.database.prepare(
        `INSERT INTO collaboration_aggregate_checkpoints (
           group_id, aggregate_type, aggregate_id, revision, event_hash,
           event_id, commit_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, aggregate_type, aggregate_id) DO UPDATE SET
           revision = excluded.revision,
           event_hash = excluded.event_hash,
           event_id = excluded.event_id,
           commit_hash = excluded.commit_hash`,
      );
      for (const head of Object.values(input.projection.aggregateHeads)) {
        const record = [...input.eventRecords]
          .reverse()
          .find((candidate) => candidate.event.event_id === head.eventId);
        checkpoint.run(
          input.groupId,
          head.aggregateType,
          head.aggregateId,
          head.revision,
          head.eventHash,
          head.eventId,
          record?.commitHash ?? input.verifiedHead,
        );
      }
      const eventStatement = this.database.prepare(
        `INSERT INTO collaboration_event_cache (
           group_id, event_id, aggregate_type, aggregate_id,
           aggregate_revision, commit_hash, commit_order, event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, event_id) DO UPDATE SET
           commit_hash = excluded.commit_hash,
           commit_order = excluded.commit_order,
           event_json = excluded.event_json`,
      );
      for (const record of input.eventRecords)
        eventStatement.run(
          input.groupId,
          record.event.event_id,
          record.event.aggregate_type,
          record.event.aggregate_id,
          record.event.aggregate_revision,
          record.commitHash,
          record.commitOrder,
          JSON.stringify(record.event),
        );

      this.replaceProjectionRows(
        input.groupId,
        input.projection,
        input.verifiedHead,
        nowMs,
      );
      this.database
        .prepare(
          `UPDATE collaboration_integrity_incidents SET resolved_at_ms = ?
            WHERE group_id = ? AND resolved_at_ms IS NULL`,
        )
        .run(nowMs, input.groupId);
    })();
  }

  private replaceProjectionRows(
    groupId: string,
    projection: CollaborationProjectionV3,
    verifiedHead: string,
    nowMs: number,
  ): void {
    const tables = [
      'collaboration_principals',
      'collaboration_clients',
      'collaboration_permission_grants',
      'collaboration_file_index',
      'collaboration_progress_updates',
      'collaboration_work_items',
      'collaboration_work_item_updates',
      'collaboration_work_item_relations',
      'collaboration_discussions',
      'collaboration_messages',
      'collaboration_workflow_definitions',
      'collaboration_workflow_instances',
      'collaboration_state_executions',
      'collaboration_turns',
    ] as const;
    for (const table of tables)
      this.database
        .prepare(`DELETE FROM ${table} WHERE group_id = ?`)
        .run(groupId);

    const memberStatement = this.database.prepare(
      `INSERT INTO collaboration_principals
       (group_id, principal_id, status, display_name, member_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const member of Object.values(projection.members))
      memberStatement.run(
        groupId,
        member.principal_id,
        member.status,
        member.display_name,
        JSON.stringify(member),
      );
    const clientStatement = this.database.prepare(
      `INSERT INTO collaboration_clients
       (group_id, principal_id, client_id, status, client_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [principalId, clients] of Object.entries(projection.clients))
      for (const client of Object.values(clients))
        clientStatement.run(
          groupId,
          principalId,
          client.client_id,
          client.status,
          JSON.stringify(client),
        );
    const grantStatement = this.database.prepare(
      `INSERT INTO collaboration_permission_grants
       (group_id, principal_id, revision, grant_json) VALUES (?, ?, ?, ?)`,
    );
    for (const grant of Object.values(projection.permissionGrants))
      grantStatement.run(
        groupId,
        grant.principal_id,
        grant.revision,
        JSON.stringify(grant),
      );
    const progressStatement = this.database.prepare(
      `INSERT INTO collaboration_progress_updates
       (group_id, update_id, principal_id, created_at, update_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const update of Object.values(projection.progressUpdates))
      progressStatement.run(
        groupId,
        update.update_id,
        update.principal_id,
        update.created_at,
        JSON.stringify(update),
      );
    const fileStatement = this.database.prepare(
      `INSERT INTO collaboration_file_index
       (group_id, file_id, virtual_path, repository_path, owner_principal_id,
        metadata_json, verified_head) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const metadata of Object.values(projection.files)) {
      const principal = metadata.uploader_principal_id;
      const display = projection.members[principal]?.display_name ?? principal;
      const suffix = principal.slice(-4);
      const location = projection.fileLocations[metadata.file_id];
      if (!location)
        throw new Error(
          `Verified file location is missing: ${metadata.file_id}`,
        );
      const virtualPath =
        location.scope === 'shared'
          ? `Shared space/${metadata.original_filename}`
          : `Member spaces/${display} · ${suffix}/Files/${metadata.original_filename}`;
      const repositoryPath = `${location.repositoryDirectory}/${metadata.content_ref ?? 'metadata.json'}`;
      fileStatement.run(
        groupId,
        metadata.file_id,
        virtualPath,
        repositoryPath,
        principal,
        JSON.stringify(metadata),
        verifiedHead,
      );
    }
    const itemStatement = this.database.prepare(
      `INSERT INTO collaboration_work_items
       (group_id, work_item_id, status, owner_principal_id, due_at,
        revision, item_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const relationStatement = this.database.prepare(
      `INSERT INTO collaboration_work_item_relations
       (group_id, work_item_id, relation_type, target_work_item_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const item of Object.values(projection.workItems)) {
      itemStatement.run(
        groupId,
        item.work_item_id,
        item.status,
        item.owner_principal_id,
        item.due_at,
        item.revision,
        JSON.stringify(item),
      );
      if (item.parent_id)
        relationStatement.run(
          groupId,
          item.work_item_id,
          'parent',
          item.parent_id,
        );
      for (const ref of item.blocked_by)
        relationStatement.run(groupId, item.work_item_id, 'blocked_by', ref);
      for (const ref of item.related_items)
        relationStatement.run(groupId, item.work_item_id, 'related', ref);
    }
    const itemUpdateStatement = this.database.prepare(
      `INSERT INTO collaboration_work_item_updates
       (group_id, work_item_id, update_id, created_at, update_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [workItemId, updates] of Object.entries(
      projection.workItemUpdates,
    ))
      for (const update of updates)
        itemUpdateStatement.run(
          groupId,
          workItemId,
          update.update_id,
          update.created_at,
          JSON.stringify(update),
        );
    const discussionStatement = this.database.prepare(
      `INSERT INTO collaboration_discussions
       (group_id, thread_id, status, revision, discussion_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const messageStatement = this.database.prepare(
      `INSERT INTO collaboration_messages
       (group_id, thread_id, message_id, author_principal_id, revision,
        tombstoned, message_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const thread of Object.values(projection.discussions)) {
      discussionStatement.run(
        groupId,
        thread.discussion.thread_id,
        thread.discussion.status,
        thread.discussion.revision,
        JSON.stringify(thread.discussion),
      );
      for (const message of Object.values(thread.messages))
        messageStatement.run(
          groupId,
          thread.discussion.thread_id,
          message.message_id,
          message.author_principal_id,
          message.revision,
          message.tombstoned ? 1 : 0,
          JSON.stringify(message),
        );
    }
    const definitionStatement = this.database.prepare(
      `INSERT INTO collaboration_workflow_definitions
       (group_id, definition_id, version, status, machine_hash, layout_hash,
        definition_json, machine_json, layout_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const value of Object.values(projection.workflowDefinitions))
      definitionStatement.run(
        groupId,
        value.definition.definition_id,
        value.definition.version,
        value.definition.status,
        value.definition.machine_hash,
        value.definition.layout_hash,
        JSON.stringify(value.definition),
        JSON.stringify(value.machine),
        JSON.stringify(value.layout),
      );
    const instanceStatement = this.database.prepare(
      `INSERT INTO collaboration_workflow_instances
       (group_id, instance_id, definition_id, lifecycle, business_state,
        active_turn_id, revision, instance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const instance of Object.values(projection.workflowInstances))
      instanceStatement.run(
        groupId,
        instance.instance_id,
        instance.definition_id,
        instance.lifecycle,
        instance.business_state,
        instance.active_turn_id,
        instance.revision,
        JSON.stringify(instance),
      );
    const executionStatement = this.database.prepare(
      `INSERT INTO collaboration_state_executions
       (group_id, instance_id, state_id, principal_id, mode, execution_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [instanceId, executions] of Object.entries(
      projection.stateExecutions,
    ))
      for (const execution of Object.values(executions))
        executionStatement.run(
          groupId,
          instanceId,
          execution.state_id,
          execution.principal_id,
          execution.mode,
          JSON.stringify(execution),
        );
    const turnStatement = this.database.prepare(
      `INSERT INTO collaboration_turns
       (group_id, instance_id, turn_id, state_id, assignee_principal_id,
        claimant_client_id, attempt, state, fencing_token, turn_json,
        updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const turn of Object.values(projection.turns))
      turnStatement.run(
        groupId,
        turn.workflow_instance_id,
        turn.turn_id,
        turn.state_id,
        turn.assignee_principal_id,
        turn.claimant_client_id,
        turn.attempt,
        turn.state,
        turn.fencing_token,
        JSON.stringify(turn),
        nowMs,
      );
  }

  getCheckpoint(
    groupId: string,
    aggregateType: string,
    aggregateId: string,
  ): (CollaborationAggregateHeadV3 & { readonly commitHash: string }) | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM collaboration_aggregate_checkpoints
          WHERE group_id = ? AND aggregate_type = ? AND aggregate_id = ?`,
      )
      .get(groupId, aggregateType, aggregateId) as
      | Record<string, unknown>
      | undefined;
    return row
      ? {
          aggregateType: String(
            row.aggregate_type,
          ) as CollaborationAggregateHeadV3['aggregateType'],
          aggregateId: String(row.aggregate_id),
          revision: Number(row.revision),
          eventHash: String(row.event_hash),
          eventId: String(row.event_id),
          commitHash: String(row.commit_hash),
        }
      : null;
  }

  listEventRecords(
    groupId: string,
    limit = 500,
  ): CollaborationProjectSpaceEventRecord[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT event_json, commit_hash, commit_order
             FROM collaboration_event_cache WHERE group_id = ?
         ORDER BY commit_order DESC LIMIT ?`,
        )
        .all(groupId, Math.min(5000, Math.max(1, limit))) as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      event: JSON.parse(String(row.event_json)) as CollaborationEventV3,
      commitHash: String(row.commit_hash),
      commitOrder: Number(row.commit_order),
    }));
  }

  listWorkItems(groupId: string): WorkItemRow[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT item_json FROM collaboration_work_items
            WHERE group_id = ? ORDER BY due_at IS NULL, due_at, work_item_id`,
        )
        .all(groupId) as Array<{ item_json: string }>
    ).map((row) => JSON.parse(row.item_json) as WorkItemRow);
  }

  listDiscussions(groupId: string): DiscussionRow[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT discussion_json FROM collaboration_discussions
            WHERE group_id = ? ORDER BY thread_id`,
        )
        .all(groupId) as Array<{ discussion_json: string }>
    ).map((row) => JSON.parse(row.discussion_json) as DiscussionRow);
  }

  listTurns(groupId: string): CollaborationTurnV3[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT turn_json FROM collaboration_turns
            WHERE group_id = ? ORDER BY updated_at_ms DESC`,
        )
        .all(groupId) as Array<{ turn_json: string }>
    ).map((row) => JSON.parse(row.turn_json) as CollaborationTurnV3);
  }

  listFileIndex(groupId: string): Array<{
    readonly fileId: string;
    readonly virtualPath: string;
    readonly repositoryPath: string;
    readonly ownerPrincipalId: string | null;
    readonly metadata: Record<string, unknown>;
    readonly verifiedHead: string;
  }> {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_file_index
            WHERE group_id = ? ORDER BY virtual_path, file_id`,
        )
        .all(groupId) as Record<string, unknown>[]
    ).map((row) => ({
      fileId: String(row.file_id),
      virtualPath: String(row.virtual_path),
      repositoryPath: String(row.repository_path),
      ownerPrincipalId:
        row.owner_principal_id == null ? null : String(row.owner_principal_id),
      metadata: JSON.parse(String(row.metadata_json)) as Record<
        string,
        unknown
      >,
      verifiedHead: String(row.verified_head),
    }));
  }

  listActionExecutions(groupId: string): CollaborationActionExecutionV3[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_action_executions
            WHERE group_id = ? ORDER BY updated_at_ms DESC, execution_id`,
        )
        .all(groupId) as Record<string, unknown>[]
    ).map((row) => this.actionExecutionFromRow(row));
  }

  listNotificationsForAudit(groupId: string): CollaborationNotificationV3[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_notifications
            WHERE group_id = ? ORDER BY first_observed_at_ms, notification_id`,
        )
        .all(groupId) as Record<string, unknown>[]
    ).map((row) => this.notificationFromRow(row));
  }

  saveExecutorBinding(
    input: Omit<CollaborationExecutorBindingV3, 'updatedAtMs'> & {
      readonly updatedAtMs?: number;
    },
  ): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT INTO collaboration_executor_bindings (
           group_id, instance_id, state_id, principal_id, client_id,
           action_hash, prompt_hash, executor_id, executor_kind,
           workspace_path, filesystem_access, approval_policy, config_json,
           enabled, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, instance_id, state_id, principal_id, client_id,
                     action_hash, prompt_hash) DO UPDATE SET
           executor_id = excluded.executor_id,
           executor_kind = excluded.executor_kind,
           workspace_path = excluded.workspace_path,
           filesystem_access = excluded.filesystem_access,
           approval_policy = excluded.approval_policy,
           config_json = excluded.config_json,
           enabled = excluded.enabled,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.groupId,
        input.instanceId,
        input.stateId,
        input.principalId,
        input.clientId,
        input.actionHash,
        input.promptHash,
        input.executorId,
        input.executorKind,
        input.workspacePath,
        input.filesystemAccess,
        input.approvalPolicy,
        JSON.stringify(input.config),
        input.enabled ? 1 : 0,
        input.updatedAtMs ?? Date.now(),
      );
  }

  getExecutorBinding(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly stateId: string;
    readonly principalId: string;
    readonly clientId: string;
    readonly actionHash: string;
    readonly promptHash: string;
  }): CollaborationExecutorBindingV3 | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM collaboration_executor_bindings
          WHERE group_id = ? AND instance_id = ? AND state_id = ?
            AND principal_id = ? AND client_id = ?
            AND action_hash = ? AND prompt_hash = ?`,
      )
      .get(
        input.groupId,
        input.instanceId,
        input.stateId,
        input.principalId,
        input.clientId,
        input.actionHash,
        input.promptHash,
      ) as Record<string, unknown> | undefined;
    return row ? this.bindingFromRow(row) : null;
  }

  listExecutorBindings(groupId: string): CollaborationExecutorBindingV3[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_executor_bindings
            WHERE group_id = ? ORDER BY instance_id, state_id, client_id`,
        )
        .all(groupId) as Record<string, unknown>[]
    ).map((row) => this.bindingFromRow(row));
  }

  private bindingFromRow(
    row: Record<string, unknown>,
  ): CollaborationExecutorBindingV3 {
    return {
      groupId: String(row.group_id),
      instanceId: String(row.instance_id),
      stateId: String(row.state_id),
      principalId: String(row.principal_id),
      clientId: String(row.client_id),
      actionHash: String(row.action_hash),
      promptHash: String(row.prompt_hash),
      executorId: String(row.executor_id),
      executorKind: String(
        row.executor_kind,
      ) as CollaborationExecutorBindingV3['executorKind'],
      workspacePath: String(row.workspace_path),
      filesystemAccess: String(
        row.filesystem_access,
      ) as CollaborationExecutorBindingV3['filesystemAccess'],
      approvalPolicy: String(
        row.approval_policy,
      ) as CollaborationExecutorBindingV3['approvalPolicy'],
      config: JSON.parse(String(row.config_json)) as Record<string, unknown>,
      enabled: Number(row.enabled) === 1,
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  claimActionExecution(input: {
    readonly groupId: string;
    readonly instanceId: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly attempt: number;
    readonly claimantClientId: string;
    readonly fencingToken: string;
    readonly operationKey: string;
    readonly executorId: string;
    readonly executorKind: string;
    readonly nowMs?: number;
  }): {
    readonly execution: CollaborationActionExecutionV3;
    readonly acquired: boolean;
  } {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    const executionId = `execution_${crypto.randomUUID()}`;
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO collaboration_action_executions (
           execution_id, group_id, instance_id, turn_id, epoch, attempt,
           claimant_client_id, fencing_token, operation_key, executor_id,
           executor_kind, state, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
      )
      .run(
        executionId,
        input.groupId,
        input.instanceId,
        input.turnId,
        input.epoch,
        input.attempt,
        input.claimantClientId,
        input.fencingToken,
        input.operationKey,
        input.executorId,
        input.executorKind,
        nowMs,
        nowMs,
      );
    const execution = this.getActionExecution({
      groupId: input.groupId,
      turnId: input.turnId,
      attempt: input.attempt,
    });
    if (!execution) throw new Error('Action execution claim was not persisted');
    return { execution, acquired: result.changes === 1 };
  }

  getActionExecution(input: {
    readonly groupId: string;
    readonly turnId: string;
    readonly attempt: number;
  }): CollaborationActionExecutionV3 | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT * FROM collaboration_action_executions
          WHERE group_id = ? AND turn_id = ? AND attempt = ?`,
      )
      .get(input.groupId, input.turnId, input.attempt) as
      | Record<string, unknown>
      | undefined;
    return row ? this.actionExecutionFromRow(row) : null;
  }

  markActionDispatchStarted(
    executionId: string,
    claimantClientId: string,
    fencingToken: string,
    nowMs = Date.now(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_action_executions
              SET dispatch_started_at_ms = COALESCE(dispatch_started_at_ms, ?),
                  updated_at_ms = ?
            WHERE execution_id = ? AND claimant_client_id = ?
              AND fencing_token = ? AND state = 'dispatching'`,
        )
        .run(nowMs, nowMs, executionId, claimantClientId, fencingToken)
        .changes === 1
    );
  }

  recordActionDispatchReceipt(input: {
    readonly executionId: string;
    readonly claimantClientId: string;
    readonly fencingToken: string;
    readonly executionRef: string;
    readonly providerMetadata: Record<string, unknown>;
    readonly receipt: Record<string, unknown>;
    readonly nowMs?: number;
  }): boolean {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_action_executions
              SET state = 'running', execution_ref = ?,
                  provider_metadata_json = ?, receipt_json = ?,
                  receipt_recorded_at_ms = ?, updated_at_ms = ?
            WHERE execution_id = ? AND claimant_client_id = ?
              AND fencing_token = ? AND receipt_json IS NULL`,
        )
        .run(
          input.executionRef,
          JSON.stringify(input.providerMetadata),
          JSON.stringify(input.receipt),
          nowMs,
          nowMs,
          input.executionId,
          input.claimantClientId,
          input.fencingToken,
        ).changes === 1
    );
  }

  recordActionObservation(input: {
    readonly executionId: string;
    readonly claimantClientId: string;
    readonly fencingToken: string;
    readonly state: string;
    readonly observation: Record<string, unknown>;
    readonly providerCompleted?: boolean;
    readonly recoveryRequiredReason?: string | null;
    readonly nowMs?: number;
  }): boolean {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_action_executions
              SET state = ?, observation_json = ?,
                  recovery_required_reason = ?,
                  provider_completed_at_ms = CASE WHEN ? THEN ?
                    ELSE provider_completed_at_ms END,
                  updated_at_ms = ?
            WHERE execution_id = ? AND claimant_client_id = ?
              AND fencing_token = ?`,
        )
        .run(
          input.state,
          JSON.stringify(input.observation),
          input.recoveryRequiredReason ?? null,
          input.providerCompleted ? 1 : 0,
          nowMs,
          nowMs,
          input.executionId,
          input.claimantClientId,
          input.fencingToken,
        ).changes === 1
    );
  }

  private actionExecutionFromRow(
    row: Record<string, unknown>,
  ): CollaborationActionExecutionV3 {
    const parseObject = (value: unknown): Record<string, unknown> | null =>
      value == null
        ? null
        : (JSON.parse(String(value)) as Record<string, unknown>);
    return {
      executionId: String(row.execution_id),
      groupId: String(row.group_id),
      instanceId: String(row.instance_id),
      turnId: String(row.turn_id),
      epoch: Number(row.epoch),
      attempt: Number(row.attempt),
      claimantClientId: String(row.claimant_client_id),
      fencingToken: String(row.fencing_token),
      operationKey: String(row.operation_key),
      executorId: String(row.executor_id),
      executorKind: String(row.executor_kind),
      state: String(row.state),
      executionRef:
        row.execution_ref == null ? null : String(row.execution_ref),
      providerMetadata: parseObject(row.provider_metadata_json),
      receipt: parseObject(row.receipt_json),
      observation: parseObject(row.observation_json),
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
      providerCompletedAtMs:
        row.provider_completed_at_ms == null
          ? null
          : Number(row.provider_completed_at_ms),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  syncTimeoutSchedules(
    groupId: string,
    turns: readonly CollaborationTurnV3[],
  ): void {
    this.assertOpen();
    const deactivate = this.database.prepare(
      `UPDATE collaboration_timeout_schedules SET active = 0
        WHERE group_id = ?`,
    );
    const upsert = this.database.prepare(
      `INSERT INTO collaboration_timeout_schedules (
         schedule_id, group_id, instance_id, turn_id, attempt, deadline_kind,
         deadline_at_ms, reminder_interval_ms, next_reminder_at_ms,
         reminder_ordinal, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
       ON CONFLICT(group_id, turn_id, attempt, deadline_kind) DO UPDATE SET
         instance_id = excluded.instance_id,
         deadline_at_ms = excluded.deadline_at_ms,
         reminder_interval_ms = excluded.reminder_interval_ms,
         next_reminder_at_ms = CASE
           WHEN collaboration_timeout_schedules.deadline_at_ms != excluded.deadline_at_ms
             THEN excluded.next_reminder_at_ms
           ELSE collaboration_timeout_schedules.next_reminder_at_ms END,
         reminder_ordinal = CASE
           WHEN collaboration_timeout_schedules.deadline_at_ms != excluded.deadline_at_ms
             THEN 0 ELSE collaboration_timeout_schedules.reminder_ordinal END,
         active = 1`,
    );
    this.database.transaction(() => {
      deactivate.run(groupId);
      for (const turn of turns) {
        const pending = turn.state === 'pending';
        const activeExecution = [
          'running',
          'waiting_input',
          'waiting_approval',
        ].includes(turn.state);
        const deadlineKind = pending
          ? ('start' as const)
          : activeExecution
            ? ('execution' as const)
            : null;
        const deadline = pending
          ? turn.start_deadline_at
          : activeExecution
            ? turn.execution_deadline_at
            : null;
        if (!deadlineKind || !deadline) continue;
        upsert.run(
          `timeout_${crypto.randomUUID()}`,
          groupId,
          turn.workflow_instance_id,
          turn.turn_id,
          turn.attempt,
          deadlineKind,
          Date.parse(deadline),
          turn.timeout_policy_snapshot?.reminder_interval_ms ?? null,
          Date.parse(deadline),
        );
      }
    })();
  }

  listDueTimeoutSchedules(
    nowMs: number,
    groupId?: string,
  ): CollaborationTimeoutScheduleV3[] {
    this.assertOpen();
    const rows = groupId
      ? this.database
          .prepare(
            `SELECT * FROM collaboration_timeout_schedules
              WHERE active = 1 AND next_reminder_at_ms <= ? AND group_id = ?
              ORDER BY next_reminder_at_ms, schedule_id`,
          )
          .all(nowMs, groupId)
      : this.database
          .prepare(
            `SELECT * FROM collaboration_timeout_schedules
              WHERE active = 1 AND next_reminder_at_ms <= ?
              ORDER BY next_reminder_at_ms, schedule_id`,
          )
          .all(nowMs);
    return (rows as Record<string, unknown>[]).map((row) => ({
      scheduleId: String(row.schedule_id),
      groupId: String(row.group_id),
      instanceId: String(row.instance_id),
      turnId: String(row.turn_id),
      attempt: Number(row.attempt),
      deadlineKind: String(row.deadline_kind) as 'start' | 'execution',
      deadlineAtMs: Number(row.deadline_at_ms),
      reminderIntervalMs:
        row.reminder_interval_ms == null
          ? null
          : Number(row.reminder_interval_ms),
      nextReminderAtMs: Number(row.next_reminder_at_ms),
      reminderOrdinal: Number(row.reminder_ordinal),
      active: Number(row.active) === 1,
    }));
  }

  advanceTimeoutSchedule(
    scheduleId: string,
    expectedOrdinal: number,
    nowMs = Date.now(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_timeout_schedules
              SET reminder_ordinal = reminder_ordinal + 1,
                  active = CASE WHEN reminder_interval_ms IS NULL THEN 0 ELSE 1 END,
                  next_reminder_at_ms = CASE
                    WHEN reminder_interval_ms IS NULL THEN next_reminder_at_ms
                    ELSE ? + reminder_interval_ms END
            WHERE schedule_id = ? AND active = 1 AND reminder_ordinal = ?`,
        )
        .run(nowMs, scheduleId, expectedOrdinal).changes === 1
    );
  }

  enqueueNotification(input: {
    readonly groupId: string;
    readonly recipientPrincipalId: string;
    readonly recipientClientId: string;
    readonly kind: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly reason: string;
    readonly dedupeKey: string;
    readonly reminderOrdinal?: number;
    readonly dueAtMs?: number | null;
    readonly payload?: Record<string, unknown>;
    readonly nowMs?: number;
  }): {
    readonly notification: CollaborationNotificationV3;
    readonly enqueued: boolean;
  } {
    this.assertOpen();
    const notificationId = `notification_${crypto.randomUUID()}`;
    const nowMs = input.nowMs ?? Date.now();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO collaboration_notifications (
           notification_id, group_id, recipient_principal_id,
           recipient_client_id, kind, resource_type, resource_id, reason,
           dedupe_key, reminder_ordinal, due_at_ms, first_observed_at_ms,
           payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        notificationId,
        input.groupId,
        input.recipientPrincipalId,
        input.recipientClientId,
        input.kind,
        input.resourceType,
        input.resourceId,
        input.reason,
        input.dedupeKey,
        input.reminderOrdinal ?? 0,
        input.dueAtMs ?? null,
        nowMs,
        JSON.stringify(input.payload ?? {}),
      );
    const row = this.database
      .prepare('SELECT * FROM collaboration_notifications WHERE dedupe_key = ?')
      .get(input.dedupeKey) as Record<string, unknown>;
    return {
      notification: this.notificationFromRow(row),
      enqueued: result.changes === 1,
    };
  }

  listPendingNotifications(input: {
    readonly principalId: string;
    readonly clientId: string;
    readonly groupId?: string;
  }): CollaborationNotificationV3[] {
    this.assertOpen();
    const rows = input.groupId
      ? this.database
          .prepare(
            `SELECT * FROM collaboration_notifications
              WHERE recipient_principal_id = ? AND recipient_client_id = ?
                AND group_id = ? AND delivered_at_ms IS NULL
           ORDER BY first_observed_at_ms`,
          )
          .all(input.principalId, input.clientId, input.groupId)
      : this.database
          .prepare(
            `SELECT * FROM collaboration_notifications
              WHERE recipient_principal_id = ? AND recipient_client_id = ?
                AND delivered_at_ms IS NULL
           ORDER BY first_observed_at_ms`,
          )
          .all(input.principalId, input.clientId);
    return (rows as Record<string, unknown>[]).map((row) =>
      this.notificationFromRow(row),
    );
  }

  markNotificationDelivered(
    notificationId: string,
    principalId: string,
    clientId: string,
    nowMs = Date.now(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_notifications SET delivered_at_ms = ?
            WHERE notification_id = ? AND recipient_principal_id = ?
              AND recipient_client_id = ? AND delivered_at_ms IS NULL`,
        )
        .run(nowMs, notificationId, principalId, clientId).changes === 1
    );
  }

  startSyncAttempt(
    groupId: string,
    headBefore: string | null,
    nowMs = Date.now(),
  ): number {
    this.assertOpen();
    const result = this.database
      .prepare(
        `INSERT INTO collaboration_sync_attempts
           (group_id, started_at_ms, outcome, head_before)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(groupId, nowMs, headBefore);
    return Number(result.lastInsertRowid);
  }

  finishSyncAttempt(input: {
    readonly id: number;
    readonly groupId: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly headAfter: string | null;
    readonly error?: string | null;
    readonly errorClass?: string | null;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const result = this.database
      .prepare(
        `UPDATE collaboration_sync_attempts
            SET completed_at_ms = ?, outcome = ?, head_after = ?, error = ?,
                error_class = ?
          WHERE id = ? AND group_id = ? AND completed_at_ms IS NULL`,
      )
      .run(
        input.nowMs ?? Date.now(),
        input.outcome,
        input.headAfter,
        input.error ?? null,
        input.errorClass ?? null,
        input.id,
        input.groupId,
      );
    if (result.changes !== 1)
      throw new Error(`Sync attempt cannot be completed: ${String(input.id)}`);
  }

  listSyncAttempts(groupId: string, limit = 50): CollaborationSyncAttemptV3[] {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT * FROM collaboration_sync_attempts
            WHERE group_id = ? ORDER BY started_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(groupId, Math.min(200, Math.max(1, limit))) as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      id: Number(row.id),
      groupId: String(row.group_id),
      startedAtMs: Number(row.started_at_ms),
      completedAtMs:
        row.completed_at_ms == null ? null : Number(row.completed_at_ms),
      outcome: String(row.outcome),
      headBefore: row.head_before == null ? null : String(row.head_before),
      headAfter: row.head_after == null ? null : String(row.head_after),
      error: row.error == null ? null : String(row.error),
      errorClass: row.error_class == null ? null : String(row.error_class),
    }));
  }

  acquireProcessLock(input: {
    readonly groupId: string;
    readonly ownerId: string;
    readonly nowMs?: number;
    readonly staleAfterMs?: number;
  }): boolean {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    const staleBefore = nowMs - (input.staleAfterMs ?? 120_000);
    return this.database.transaction(() => {
      this.database
        .prepare(
          `DELETE FROM collaboration_process_locks
            WHERE group_id = ? AND heartbeat_at_ms < ?`,
        )
        .run(input.groupId, staleBefore);
      return (
        this.database
          .prepare(
            `INSERT OR IGNORE INTO collaboration_process_locks
               (group_id, owner_id, acquired_at_ms, heartbeat_at_ms)
             VALUES (?, ?, ?, ?)`,
          )
          .run(input.groupId, input.ownerId, nowMs, nowMs).changes === 1
      );
    })();
  }

  heartbeatProcessLock(
    groupId: string,
    ownerId: string,
    nowMs = Date.now(),
  ): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `UPDATE collaboration_process_locks SET heartbeat_at_ms = ?
            WHERE group_id = ? AND owner_id = ?`,
        )
        .run(nowMs, groupId, ownerId).changes === 1
    );
  }

  releaseProcessLock(groupId: string, ownerId: string): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `DELETE FROM collaboration_process_locks
            WHERE group_id = ? AND owner_id = ?`,
        )
        .run(groupId, ownerId).changes === 1
    );
  }

  private notificationFromRow(
    row: Record<string, unknown>,
  ): CollaborationNotificationV3 {
    return {
      notificationId: String(row.notification_id),
      groupId: String(row.group_id),
      recipientPrincipalId: String(row.recipient_principal_id),
      recipientClientId: String(row.recipient_client_id),
      kind: String(row.kind),
      resourceType: String(row.resource_type),
      resourceId: String(row.resource_id),
      reason: String(row.reason),
      dedupeKey: String(row.dedupe_key),
      reminderOrdinal: Number(row.reminder_ordinal),
      dueAtMs: row.due_at_ms == null ? null : Number(row.due_at_ms),
      firstObservedAtMs: Number(row.first_observed_at_ms),
      deliveredAtMs:
        row.delivered_at_ms == null ? null : Number(row.delivered_at_ms),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    };
  }

  recordIntegrityIncident(input: {
    readonly groupId: string;
    readonly code: string;
    readonly message: string;
    readonly headCommit?: string | null;
    readonly nowMs?: number;
  }): void {
    this.assertOpen();
    const nowMs = input.nowMs ?? Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE collaboration_groups
              SET protocol_status = 'PROTOCOL_QUARANTINED',
                  protocol_error = ?, updated_at_ms = ? WHERE group_id = ?`,
        )
        .run(input.message, nowMs, input.groupId);
      const exists = this.database
        .prepare(
          `SELECT 1 FROM collaboration_integrity_incidents
            WHERE group_id = ? AND code = ? AND message = ?
              AND head_commit IS ? AND resolved_at_ms IS NULL`,
        )
        .get(
          input.groupId,
          input.code,
          input.message,
          input.headCommit ?? null,
        );
      if (!exists)
        this.database
          .prepare(
            `INSERT INTO collaboration_integrity_incidents
             (incident_id, group_id, code, message, head_commit, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `incident_${crypto.randomUUID()}`,
            input.groupId,
            input.code,
            input.message,
            input.headCommit ?? null,
            nowMs,
          );
    })();
  }

  listIntegrityIncidents(groupId: string): Array<Record<string, unknown>> {
    this.assertOpen();
    return this.database
      .prepare(
        `SELECT * FROM collaboration_integrity_incidents
          WHERE group_id = ? ORDER BY created_at_ms DESC`,
      )
      .all(groupId) as Array<Record<string, unknown>>;
  }

  addLocalAuditEvidence(input: {
    readonly groupId: string;
    readonly evidenceType: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly evidence: Record<string, unknown>;
    readonly observedAtMs?: number;
  }): string {
    this.assertOpen();
    const evidenceId = `evidence_${crypto.randomUUID()}`;
    this.database
      .prepare(
        `INSERT INTO collaboration_local_audit_evidence
         (evidence_id, group_id, evidence_type, resource_type, resource_id,
          observed_at_ms, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        input.groupId,
        input.evidenceType,
        input.resourceType,
        input.resourceId,
        input.observedAtMs ?? Date.now(),
        JSON.stringify(input.evidence),
      );
    return evidenceId;
  }

  listLocalAuditEvidence(groupId: string): Array<Record<string, unknown>> {
    this.assertOpen();
    return this.database
      .prepare(
        `SELECT * FROM collaboration_local_audit_evidence
          WHERE group_id = ? ORDER BY observed_at_ms, evidence_id`,
      )
      .all(groupId) as Array<Record<string, unknown>>;
  }

  rawDatabaseForTests(): Database.Database {
    this.assertOpen();
    return this.database;
  }
}

export interface CollaborationProjectSpaceBackupManifest {
  readonly format: 'icarus.collaboration-backup/3';
  readonly database_basename: string;
  readonly schema_version: number;
  readonly created_at: string;
  readonly file: {
    readonly size: number;
    readonly sha256: string;
  };
}

function safeDatabasePath(databasePath: string): string {
  const resolved = path.resolve(databasePath);
  if (
    resolved === path.parse(resolved).root ||
    path.extname(resolved) !== '.db'
  )
    throw new Error(`Unsafe collaboration database path: ${resolved}`);
  return resolved;
}

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function createCollaborationProjectSpaceBackup(input: {
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly createdAt?: Date;
}): CollaborationProjectSpaceBackupManifest {
  const databasePath = safeDatabasePath(input.databasePath);
  if (!existsSync(databasePath))
    throw new Error(`Collaboration database does not exist: ${databasePath}`);
  const backupDirectory = path.resolve(input.backupDirectory);
  if (existsSync(backupDirectory))
    throw new Error(`Backup directory already exists: ${backupDirectory}`);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const checkpoint = new Database(databasePath);
  try {
    checkpoint.pragma('wal_checkpoint(TRUNCATE)');
    if (
      schemaVersion(checkpoint) !==
      CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION
    )
      throw new Error('Only the current collaboration schema can be backed up');
  } finally {
    checkpoint.close();
  }
  const destination = path.join(backupDirectory, path.basename(databasePath));
  copyFileSync(databasePath, destination);
  const manifest: CollaborationProjectSpaceBackupManifest = {
    format: 'icarus.collaboration-backup/3',
    database_basename: path.basename(databasePath),
    schema_version: CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
    created_at: (input.createdAt ?? new Date()).toISOString(),
    file: {
      size: statSync(destination).size,
      sha256: fileSha256(destination),
    },
  };
  writeFileSync(
    path.join(backupDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function restoreCollaborationProjectSpaceBackup(input: {
  readonly databasePath: string;
  readonly backupDirectory: string;
}): { readonly rollbackDirectory: string | null } {
  const databasePath = safeDatabasePath(input.databasePath);
  const backupDirectory = path.resolve(input.backupDirectory);
  const manifest = JSON.parse(
    readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8'),
  ) as CollaborationProjectSpaceBackupManifest;
  if (
    manifest.format !== 'icarus.collaboration-backup/3' ||
    manifest.schema_version !==
      CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION ||
    manifest.database_basename !== path.basename(databasePath)
  )
    throw new Error('Collaboration backup is not the current v3 format');
  const source = path.join(backupDirectory, manifest.database_basename);
  if (
    !existsSync(source) ||
    statSync(source).size !== manifest.file.size ||
    fileSha256(source) !== manifest.file.sha256
  )
    throw new Error('Collaboration backup failed integrity verification');
  const staging = path.join(
    path.dirname(databasePath),
    `.collaboration-restore-${crypto.randomUUID()}.db`,
  );
  copyFileSync(source, staging);
  const verified = new CollaborationProjectSpaceStore(staging);
  verified.close();
  const rollbackDirectory = existsSync(databasePath)
    ? path.join(
        path.dirname(databasePath),
        `.collaboration-pre-restore-${crypto.randomUUID()}`,
      )
    : null;
  if (rollbackDirectory) {
    mkdirSync(rollbackDirectory, { mode: 0o700 });
    renameSync(
      databasePath,
      path.join(rollbackDirectory, path.basename(databasePath)),
    );
  }
  renameSync(staging, databasePath);
  for (const suffix of ['-wal', '-shm']) {
    const stale = `${databasePath}${suffix}`;
    if (existsSync(stale)) rmSync(stale);
  }
  return { rollbackDirectory };
}

export function rollbackCollaborationProjectSpaceRestore(input: {
  readonly databasePath: string;
  readonly rollbackDirectory: string;
}): void {
  const databasePath = safeDatabasePath(input.databasePath);
  const rollbackDirectory = path.resolve(input.rollbackDirectory);
  if (
    path.dirname(rollbackDirectory) !== path.dirname(databasePath) ||
    !path.basename(rollbackDirectory).startsWith('.collaboration-pre-restore-')
  )
    throw new Error('Unsafe collaboration rollback directory');
  const rollback = path.join(rollbackDirectory, path.basename(databasePath));
  if (!existsSync(rollback))
    throw new Error('Collaboration rollback database is missing');
  if (existsSync(databasePath)) rmSync(databasePath);
  renameSync(rollback, databasePath);
}

type WorkItemRow = CollaborationProjectionV3['workItems'][string];
type DiscussionRow =
  CollaborationProjectionV3['discussions'][string]['discussion'];
