import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  canonicalJson,
  domainSeparatedSha256,
} from '../workflow-runtime/contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import type {
  CoordinatorTurnV1,
  TaskAttentionState,
  TaskConversationMessageV1,
  TaskExecutionLinkV1,
  TaskLaunchIntentV1,
  TaskLaunchMode,
  TaskLaunchStatus,
  TaskMessageRole,
  TaskPendingInteractionV1,
  TaskRuntimeCommandAction,
  TaskRuntimeCommandProposalV1,
  TaskRunSelection,
  TaskSessionStatus,
  TaskSessionV1,
  TaskTimelineEntryKind,
  TaskTimelineEntryV1,
  TemporaryWorkflowDraftRevisionV1,
} from './contracts.js';

function attentionForLaunchStatus(
  status: TaskLaunchStatus,
): TaskAttentionState {
  if (status === 'awaiting_confirmation') return 'waiting_user';
  if (status === 'failed' || status === 'unsupported') return 'failed';
  return 'none';
}

export const CURRENT_TASK_WORKSPACE_SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_workspace_sessions (
  session_id TEXT PRIMARY KEY,
  owner_principal_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','completed','cancelled','archived')),
  attention_state TEXT NOT NULL CHECK (attention_state IN ('none','waiting_user','action_required','failed')),
  primary_thread_id TEXT NOT NULL UNIQUE,
  coordinator_agent_session_id TEXT,
  current_run_selection_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('task_workspace','global_assistant','runtime_deep_link','api')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workspace_threads (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES task_workspace_sessions(session_id),
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workspace_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  thread_id TEXT NOT NULL REFERENCES task_workspace_threads(thread_id),
  message_seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('human','coordinator','system')),
  body_json TEXT,
  body_text TEXT,
  body_hash TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES task_workspace_messages(message_id),
  causation_ref TEXT,
  query_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, message_seq),
  CHECK ((body_json IS NOT NULL) + (body_text IS NOT NULL) = 1)
);
CREATE TABLE IF NOT EXISTS task_workspace_message_attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES task_workspace_messages(message_id),
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (message_id, relative_path)
);
CREATE TABLE IF NOT EXISTS task_workspace_coordinator_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  source_message_id TEXT NOT NULL REFERENCES task_workspace_messages(message_id),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','interrupted')),
  attempt_no INTEGER NOT NULL,
  query_id TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  row_version INTEGER NOT NULL,
  UNIQUE (source_message_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_workspace_one_running_turn
  ON task_workspace_coordinator_turns(session_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS task_workspace_launch_intents (
  launch_intent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  source_message_id TEXT NOT NULL REFERENCES task_workspace_messages(message_id),
  mode TEXT NOT NULL CHECK (mode IN ('published_recipe','temporary_workflow')),
  selected_recipe_ref_json TEXT,
  selected_recipe_hash TEXT,
  selection_token TEXT,
  effective_input_json TEXT NOT NULL,
  effective_input_hash TEXT NOT NULL,
  attachment_manifest_hash TEXT NOT NULL,
  confirmed_draft_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('drafting','awaiting_confirmation','creating','linked','unsupported','failed','cancelled')),
  creation_domain TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error_code TEXT,
  row_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (creation_domain, creation_key)
);
CREATE TABLE IF NOT EXISTS task_workspace_launch_input_revisions (
  revision_id TEXT PRIMARY KEY,
  launch_intent_id TEXT NOT NULL REFERENCES task_workspace_launch_intents(launch_intent_id),
  revision_no INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (launch_intent_id, revision_no)
);
CREATE TABLE IF NOT EXISTS task_workspace_temporary_drafts (
  draft_id TEXT PRIMARY KEY,
  launch_intent_id TEXT NOT NULL UNIQUE REFERENCES task_workspace_launch_intents(launch_intent_id),
  current_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('drafting','awaiting_confirmation','confirmed','discarded','failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workspace_temporary_draft_revisions (
  revision_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES task_workspace_temporary_drafts(draft_id),
  revision_no INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES task_workspace_temporary_draft_revisions(revision_id),
  source_message_id TEXT NOT NULL REFERENCES task_workspace_messages(message_id),
  source_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  compiled_plan_json TEXT NOT NULL,
  compiled_plan_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  resource_closure_hash TEXT NOT NULL,
  policy_ceiling_hash TEXT NOT NULL,
  risk_summary_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (draft_id, revision_no)
);
CREATE TABLE IF NOT EXISTS task_workspace_execution_links (
  link_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  workflow_id TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  creation_request_id TEXT NOT NULL,
  launch_intent_id TEXT NOT NULL UNIQUE REFERENCES task_workspace_launch_intents(launch_intent_id),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, workflow_id)
);
CREATE TABLE IF NOT EXISTS task_workspace_artifact_links (
  artifact_link_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  workflow_id TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  display_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, workflow_id, artifact_ref, artifact_hash)
);
CREATE TABLE IF NOT EXISTS task_workspace_pending_interaction_links (
  interaction_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  workflow_id TEXT,
  run_id TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  rendered_snapshot_json TEXT NOT NULL,
  rendered_snapshot_hash TEXT NOT NULL,
  target_row_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','duplicate','conflict','expired','denied')),
  canonical_result_json TEXT,
  row_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS task_workspace_runtime_command_proposals (
  proposal_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  workflow_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','cancelled','failed')),
  receipt_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workspace_replan_requests (
  replan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  source_workflow_id TEXT NOT NULL,
  source_activation_id TEXT,
  source_run_id TEXT NOT NULL,
  source_frontier_json TEXT NOT NULL,
  source_frontier_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('drafting','awaiting_confirmation','applying','applied','cancelled','failed')),
  confirmation_ref TEXT,
  confirmation_hash TEXT,
  source_fence_receipt_json TEXT,
  target_activation_id TEXT,
  target_run_id TEXT,
  canonical_receipt_json TEXT,
  last_error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workspace_personal_workflow_drafts (
  draft_id TEXT PRIMARY KEY,
  personal_workflow_id TEXT NOT NULL,
  owner_principal_ref TEXT NOT NULL,
  source_session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  source_workflow_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  current_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','validated','dry_run_passed','reviewed','publishing','published','activating','active','failed')),
  review_json TEXT,
  release_id TEXT,
  release_hash TEXT,
  pointer_row_version INTEGER,
  pending_operation_key TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL,
  UNIQUE (owner_principal_ref, personal_workflow_id),
  FOREIGN KEY (current_revision_id) REFERENCES task_workspace_personal_workflow_draft_revisions(revision_id)
);
CREATE TABLE IF NOT EXISTS task_workspace_personal_workflow_draft_revisions (
  revision_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES task_workspace_personal_workflow_drafts(draft_id),
  revision_no INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES task_workspace_personal_workflow_draft_revisions(revision_id),
  source_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  compiled_plan_json TEXT NOT NULL,
  compiled_plan_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  resource_closure_hash TEXT NOT NULL,
  policy_ceiling_hash TEXT NOT NULL,
  risk_summary_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (draft_id, revision_no)
);
CREATE TABLE IF NOT EXISTS task_workspace_timeline_entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  session_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace','runtime')),
  source_id TEXT NOT NULL,
  source_event_seq INTEGER,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, session_seq),
  UNIQUE (session_id, source_kind, source_id, source_event_seq)
);
CREATE TABLE IF NOT EXISTS task_workspace_runtime_cursors (
  session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  source_state TEXT NOT NULL CHECK (source_state IN ('ready','catching_up','degraded')),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, workflow_id, run_id)
);
CREATE TABLE IF NOT EXISTS task_workspace_idempotency_records (
  domain TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (domain, idempotency_key)
);
CREATE TABLE IF NOT EXISTS task_workspace_audit_events (
  audit_id TEXT PRIMARY KEY,
  session_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  target_ref TEXT,
  detail_json TEXT NOT NULL,
  detail_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
`;

export class TaskWorkspaceStoreError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'conflict'
      | 'integrity_error',
    message: string,
  ) {
    super(message);
    this.name = 'TaskWorkspaceStoreError';
  }
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function hash(domain: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(`icarus:task-workspace:${domain}:1\n`, value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function assertText(value: string, label: string, max = 100_000): void {
  if (!value.trim() || value.length > max) {
    throw new TaskWorkspaceStoreError(
      'invalid_input',
      `${label} must be non-empty and no longer than ${max} characters`,
    );
  }
}

const PERSONAL_INSTANCE_KEYS = new Set([
  'task_session_id',
  'session_id',
  'workflow_id',
  'run_id',
  'node_id',
  'attempt_id',
  'wait_id',
  'scope_id',
  'artifact_value',
  'artifact_value_id',
  'external_object_id',
  'external_object_identity',
  'wait_response',
  'deadline_at_ms',
  'absolute_path',
]);
const PERSONAL_SECRET_KEY =
  /(?:credential|secret|password|session[_-]?token|access[_-]?token|api[_-]?key|authorization)/i;
const ABSOLUTE_PATH = /^(?:\/|file:\/\/|[A-Za-z]:[\\/])/;

export function sanitizePersonalWorkflowSource(source: JsonObject): JsonObject {
  const sanitize = (value: JsonValue): JsonValue | undefined => {
    if (typeof value === 'string' && ABSOLUTE_PATH.test(value))
      return undefined;
    if (Array.isArray(value)) {
      return value
        .map(sanitize)
        .filter((entry): entry is JsonValue => entry !== undefined);
    }
    if (!value || typeof value !== 'object') return value;
    const sanitized: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PERSONAL_INSTANCE_KEYS.has(key) || PERSONAL_SECRET_KEY.test(key))
        continue;
      const next = sanitize(entry);
      if (next !== undefined) sanitized[key] = next;
    }
    return sanitized;
  };
  return sanitize(source) as JsonObject;
}

function schemaVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true }) as unknown;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TaskWorkspaceStoreError(
      'integrity_error',
      `Task Workspace PRAGMA user_version is invalid: ${String(value)}`,
    );
  }
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

function createFreshSchema(database: Database.Database): void {
  database.transaction(() => {
    database.exec(SCHEMA);
    database.pragma(`user_version = ${CURRENT_TASK_WORKSPACE_SCHEMA_VERSION}`);
  })();
}

function migrateSchemaV1ToV2(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE task_workspace_replan_requests_v2 (
        replan_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
        source_workflow_id TEXT NOT NULL,
        source_activation_id TEXT,
        source_run_id TEXT NOT NULL,
        source_frontier_json TEXT NOT NULL,
        source_frontier_hash TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('drafting','awaiting_confirmation','applying','applied','cancelled','failed')),
        confirmation_ref TEXT,
        confirmation_hash TEXT,
        source_fence_receipt_json TEXT,
        target_activation_id TEXT,
        target_run_id TEXT,
        canonical_receipt_json TEXT,
        last_error_code TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        row_version INTEGER NOT NULL
      )
    `);
    const legacyRows = database
      .prepare(
        `SELECT replan_id, session_id, source_workflow_id, source_run_id,
                source_frontier_json, proposal_json, proposal_hash, status,
                idempotency_key, created_at_ms, updated_at_ms, row_version
           FROM task_workspace_replan_requests
          ORDER BY replan_id COLLATE BINARY`,
      )
      .all() as Record<string, unknown>[];
    const insert = database.prepare(
      `INSERT INTO task_workspace_replan_requests_v2 (
         replan_id, session_id, source_workflow_id, source_activation_id,
         source_run_id, source_frontier_json, source_frontier_hash,
         proposal_json, proposal_hash, status, confirmation_ref,
         confirmation_hash, source_fence_receipt_json, target_activation_id,
         target_run_id, canonical_receipt_json,
         last_error_code, idempotency_key, created_at_ms, updated_at_ms,
         row_version
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, ?, ?, ?, ?)`,
    );
    for (const row of legacyRows) {
      const sourceFrontierJson = String(row.source_frontier_json);
      let sourceFrontier: JsonValue;
      try {
        sourceFrontier = parseJson<JsonValue>(sourceFrontierJson);
      } catch {
        throw new TaskWorkspaceStoreError(
          'integrity_error',
          `Replan ${String(row.replan_id)} has invalid source frontier JSON`,
        );
      }
      insert.run(
        String(row.replan_id),
        String(row.session_id),
        String(row.source_workflow_id),
        String(row.source_run_id),
        sourceFrontierJson,
        hash('replan-source-frontier', sourceFrontier),
        String(row.proposal_json),
        String(row.proposal_hash),
        String(row.status),
        String(row.idempotency_key),
        Number(row.created_at_ms),
        Number(row.updated_at_ms),
        Number(row.row_version),
      );
    }
    database.exec(`
      DROP TABLE task_workspace_replan_requests;
      ALTER TABLE task_workspace_replan_requests_v2
        RENAME TO task_workspace_replan_requests;
    `);
    database.pragma('user_version = 2');
  })();
}

function migrateSchemaV2ToV3(database: Database.Database): void {
  database.transaction(() => {
    const personalColumns = database
      .prepare('PRAGMA table_info(task_workspace_personal_workflow_drafts)')
      .all() as Array<{ name: string }>;
    if (
      personalColumns.some((column) => column.name === 'current_revision_id')
    ) {
      database.pragma('user_version = 3');
      return;
    }
    database.exec(`
      ALTER TABLE task_workspace_personal_workflow_drafts
        RENAME TO task_workspace_personal_workflow_drafts_v2;
      CREATE TABLE task_workspace_personal_workflow_drafts (
        draft_id TEXT PRIMARY KEY,
        personal_workflow_id TEXT NOT NULL,
        owner_principal_ref TEXT NOT NULL,
        source_session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
        source_workflow_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        current_revision_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft','validated','dry_run_passed','reviewed','publishing','published','activating','active','failed')),
        review_json TEXT,
        release_id TEXT,
        release_hash TEXT,
        pointer_row_version INTEGER,
        pending_operation_key TEXT,
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        row_version INTEGER NOT NULL,
        UNIQUE (owner_principal_ref, personal_workflow_id),
        FOREIGN KEY (current_revision_id) REFERENCES task_workspace_personal_workflow_draft_revisions(revision_id)
      );
      CREATE TABLE task_workspace_personal_workflow_draft_revisions (
        revision_id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES task_workspace_personal_workflow_drafts(draft_id),
        revision_no INTEGER NOT NULL,
        parent_revision_id TEXT REFERENCES task_workspace_personal_workflow_draft_revisions(revision_id),
        source_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        compiled_plan_json TEXT NOT NULL,
        compiled_plan_hash TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        resource_closure_hash TEXT NOT NULL,
        policy_ceiling_hash TEXT NOT NULL,
        risk_summary_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (draft_id, revision_no)
      );
    `);
    const legacyRows = database
      .prepare(
        `SELECT * FROM task_workspace_personal_workflow_drafts_v2
          ORDER BY draft_id COLLATE BINARY`,
      )
      .all() as Record<string, unknown>[];
    const insertDraft = database.prepare(
      `INSERT INTO task_workspace_personal_workflow_drafts
        (draft_id, personal_workflow_id, owner_principal_ref, source_session_id,
         source_workflow_id, source_run_id, current_revision_id, status,
         review_json, release_id, release_hash, pointer_row_version,
         pending_operation_key, last_error_code, created_at_ms, updated_at_ms,
         row_version)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    );
    const insertRevision = database.prepare(
      `INSERT INTO task_workspace_personal_workflow_draft_revisions
        (revision_id, draft_id, revision_no, parent_revision_id, source_json,
         source_hash, compiled_plan_json, compiled_plan_hash, compiler_version,
         resource_closure_hash, policy_ceiling_hash, risk_summary_json,
         created_at_ms)
       VALUES (?, ?, 1, NULL, ?, ?, ?, ?, 'legacy-uncompiled', ?, ?, ?, ?)`,
    );
    const updateCurrent = database.prepare(
      `UPDATE task_workspace_personal_workflow_drafts
          SET current_revision_id = ? WHERE draft_id = ?`,
    );
    for (const row of legacyRows) {
      const draftId = String(row.draft_id);
      const revisionId = `personal-revision:${domainSeparatedSha256(
        'icarus:task-workspace:personal-legacy-revision:1\n',
        { draft_id: draftId, source_hash: String(row.source_hash) },
      ).slice(7)}`;
      insertDraft.run(
        draftId,
        draftId,
        String(row.owner_principal_ref),
        String(row.source_session_id),
        String(row.source_workflow_id),
        String(row.source_run_id),
        String(row.status),
        row.review_json,
        row.release_id,
        Number(row.created_at_ms),
        Number(row.updated_at_ms),
        Number(row.row_version),
      );
      const emptyPlan: JsonObject = {};
      insertRevision.run(
        revisionId,
        draftId,
        String(row.source_json),
        String(row.source_hash),
        canonicalJson(emptyPlan),
        hash('personal-legacy-plan', emptyPlan),
        hash('personal-legacy-closure', { draft_id: draftId }),
        hash('personal-legacy-policy', { draft_id: draftId }),
        canonicalJson({ migrated_from_schema: 2 }),
        Number(row.created_at_ms),
      );
      updateCurrent.run(revisionId, draftId);
    }
    database.exec(`DROP TABLE task_workspace_personal_workflow_drafts_v2;`);
    database.pragma('user_version = 3');
  })();
}

function migrateSchema(database: Database.Database): void {
  let version = schemaVersion(database);
  if (version > CURRENT_TASK_WORKSPACE_SCHEMA_VERSION) {
    throw new TaskWorkspaceStoreError(
      'integrity_error',
      `Task Workspace schema ${String(version)} is newer than supported ${String(CURRENT_TASK_WORKSPACE_SCHEMA_VERSION)}`,
    );
  }
  if (version === 0 && hasUserTables(database)) {
    throw new TaskWorkspaceStoreError(
      'integrity_error',
      'Unversioned non-empty Task Workspace database is not safe to migrate',
    );
  }
  if (version === 0) {
    createFreshSchema(database);
    version = CURRENT_TASK_WORKSPACE_SCHEMA_VERSION;
  }
  if (version === 1) {
    migrateSchemaV1ToV2(database);
    version = 2;
  }
  if (version === 2) {
    migrateSchemaV2ToV3(database);
    version = 3;
  }
  if (version !== CURRENT_TASK_WORKSPACE_SCHEMA_VERSION) {
    throw new TaskWorkspaceStoreError(
      'integrity_error',
      `No migration path for Task Workspace schema ${String(version)}`,
    );
  }
}

export interface CreateSessionInput {
  readonly ownerPrincipalRef: string;
  readonly title: string;
  readonly source?: TaskSessionV1['source'];
  readonly nowMs?: number;
}

export interface AppendMessageInput {
  readonly sessionId: string;
  readonly role: TaskMessageRole;
  readonly bodyText?: string;
  readonly bodyJson?: JsonValue;
  readonly replyToMessageId?: string | null;
  readonly causationRef?: string | null;
  readonly queryId?: string | null;
  readonly createCoordinatorTurn?: boolean;
  readonly nowMs?: number;
}

export interface CreateRunLaunchIntentInput {
  readonly sessionId: string;
  readonly messageText: string;
  readonly mode: TaskLaunchMode;
  readonly selectionToken?: string | null;
  readonly selectedRecipeRef?: JsonObject | null;
  readonly selectedRecipeHash?: Sha256Hash | null;
  readonly effectiveInput: JsonValue;
  readonly attachmentManifestHash: Sha256Hash;
  readonly idempotencyKey: string;
  readonly nowMs?: number;
}

export interface CreateRunLaunchIntentResult {
  readonly launch: TaskLaunchIntentV1;
  readonly message: TaskConversationMessageV1;
  readonly timeline: TaskTimelineEntryV1;
  readonly created: boolean;
}

export interface TaskArtifactLinkV1 {
  readonly artifact_link_id: string;
  readonly session_id: string;
  readonly workflow_id: string;
  readonly artifact_ref: string;
  readonly artifact_hash: Sha256Hash;
  readonly display_json: JsonObject;
  readonly created_at_ms: number;
}

function runtimeTimelineKind(eventType: string): TaskTimelineEntryKind {
  switch (eventType) {
    case 'runtime_command_decided':
      return 'command_result';
    case 'workflow_terminal_committed':
      return 'workflow_completed';
    case 'wait_armed':
      return 'pending_interaction';
    case 'node_output_published':
      return 'artifact_published';
    case 'attempt_created':
    case 'attempt_phase_changed':
    case 'control_edge_resolved':
    case 'data_edge_resolved':
    case 'input_sealed':
    case 'node_ready':
    case 'node_skipped':
    case 'node_terminal':
    case 'orchestration_error':
    case 'retry_schedule_created':
    case 'retry_schedule_consumed':
    case 'scheduler_admitted':
    case 'terminal_candidate':
    case 'trigger_decided':
    case 'wait_resolved':
      return 'node_progress';
    case 'build_failed':
    case 'child_completion_consumed':
    case 'completion_eligibility':
    case 'completion_cut_committed':
    case 'compensation_changed':
    case 'domain_claim_changed':
    case 'effect_operation_changed':
    case 'expansion_sealed':
    case 'ledger_posting_committed':
    case 'operational_blocker_changed':
    case 'recovery_decision_recorded':
    case 'root_finalization_changed':
    case 'run_control_changed':
    case 'run_created':
    case 'scope_close_requested':
    case 'scope_materialized':
    case 'state_activation_created':
    case 'subtree_fenced':
    case 'workflow_created':
    case 'workflow_transition_committed':
    default:
      return 'workflow_progress';
  }
}

export class TaskWorkspaceStore {
  private readonly database: Database.Database;

  constructor(readonly databasePath: string) {
    const absolute = path.resolve(databasePath);
    if (path.basename(absolute) !== 'task-workspace.db') {
      throw new TaskWorkspaceStoreError(
        'invalid_input',
        'Task Workspace database must be named task-workspace.db',
      );
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    this.database = new Database(absolute);
    try {
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = FULL');
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('busy_timeout = 5000');
      migrateSchema(this.database);
      this.database
        .prepare(
          `UPDATE task_workspace_coordinator_turns
              SET status = 'interrupted', error_code = 'host_restarted',
                  finished_at_ms = ?, row_version = row_version + 1
            WHERE status = 'running'`,
        )
        .run(Date.now());
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  private nextMessageSeq(sessionId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(message_seq), 0) + 1 AS next FROM task_workspace_messages WHERE session_id = ?',
      )
      .get(sessionId) as { next: number };
    return row.next;
  }

  private nextTimelineSeq(sessionId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(session_seq), 0) + 1 AS next FROM task_workspace_timeline_entries WHERE session_id = ?',
      )
      .get(sessionId) as { next: number };
    return row.next;
  }

  private insertTimeline(input: {
    sessionId: string;
    kind: TaskTimelineEntryKind;
    sourceKind: 'workspace' | 'runtime';
    sourceId: string;
    sourceEventSeq: number | null;
    payload: JsonObject;
    occurredAtMs: number;
    createdAtMs: number;
  }): TaskTimelineEntryV1 {
    const payloadJson = canonicalJson(input.payload);
    const payloadHash = hash('timeline-payload', input.payload);
    const entry: TaskTimelineEntryV1 = {
      entry_id: id('timeline'),
      session_id: input.sessionId,
      session_seq: this.nextTimelineSeq(input.sessionId),
      kind: input.kind,
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      source_event_seq: input.sourceEventSeq,
      payload_json: input.payload,
      payload_hash: payloadHash,
      occurred_at_ms: input.occurredAtMs,
      created_at_ms: input.createdAtMs,
    };
    this.database
      .prepare(
        `INSERT INTO task_workspace_timeline_entries (
          entry_id, session_id, session_seq, kind, source_kind, source_id,
          source_event_seq, payload_json, payload_hash, occurred_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.entry_id,
        entry.session_id,
        entry.session_seq,
        entry.kind,
        entry.source_kind,
        entry.source_id,
        entry.source_event_seq,
        payloadJson,
        payloadHash,
        entry.occurred_at_ms,
        entry.created_at_ms,
      );
    return entry;
  }

  private mapTimelineEntry(row: Record<string, unknown>): TaskTimelineEntryV1 {
    return {
      entry_id: String(row.entry_id),
      session_id: String(row.session_id),
      session_seq: Number(row.session_seq),
      kind: row.kind as TaskTimelineEntryKind,
      source_kind: row.source_kind as 'workspace' | 'runtime',
      source_id: String(row.source_id),
      source_event_seq:
        row.source_event_seq === null ? null : Number(row.source_event_seq),
      payload_json: parseJson(String(row.payload_json)),
      payload_hash: row.payload_hash as Sha256Hash,
      occurred_at_ms: Number(row.occurred_at_ms),
      created_at_ms: Number(row.created_at_ms),
    };
  }

  private getTimelineEntry(entryId: string): TaskTimelineEntryV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_timeline_entries WHERE entry_id = ?',
      )
      .get(entryId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'integrity_error',
        'Run idempotency response references a missing Timeline entry',
      );
    }
    return this.mapTimelineEntry(row);
  }

  createSession(input: CreateSessionInput): TaskSessionV1 {
    assertText(input.ownerPrincipalRef, 'owner principal', 512);
    assertText(input.title, 'session title', 500);
    const nowMs = input.nowMs ?? Date.now();
    const sessionId = id('task');
    const threadId = id('thread');
    const selection: TaskRunSelection = { kind: 'temporary_workflow' };
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_workspace_sessions (
            session_id, owner_principal_ref, title, status, attention_state,
            primary_thread_id, coordinator_agent_session_id,
            current_run_selection_json, source, created_at_ms, updated_at_ms,
            row_version
          ) VALUES (?, ?, ?, 'open', 'none', ?, NULL, ?, ?, ?, ?, 1)`,
        )
        .run(
          sessionId,
          input.ownerPrincipalRef,
          input.title.trim(),
          threadId,
          canonicalJson(selection),
          input.source ?? 'task_workspace',
          nowMs,
          nowMs,
        );
      this.database
        .prepare(
          'INSERT INTO task_workspace_threads (thread_id, session_id, created_at_ms) VALUES (?, ?, ?)',
        )
        .run(threadId, sessionId, nowMs);
      this.audit({
        sessionId,
        actorKind: 'human',
        actorRef: input.ownerPrincipalRef,
        action: 'session_created',
        targetRef: sessionId,
        detail: { title: input.title.trim() },
        nowMs,
      });
    });
    return this.getSession(sessionId, input.ownerPrincipalRef);
  }

  getSession(sessionId: string, principalRef?: string): TaskSessionV1 {
    const row = this.database
      .prepare('SELECT * FROM task_workspace_sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row || (principalRef && row.owner_principal_ref !== principalRef)) {
      throw new TaskWorkspaceStoreError('not_found', 'TaskSession not found');
    }
    return {
      format: 'icarus.task-session/1',
      session_id: String(row.session_id),
      owner_principal_ref: String(row.owner_principal_ref),
      title: String(row.title),
      status: row.status as TaskSessionStatus,
      attention_state: row.attention_state as TaskAttentionState,
      primary_thread_id: String(row.primary_thread_id),
      coordinator_agent_session_id:
        row.coordinator_agent_session_id === null
          ? null
          : String(row.coordinator_agent_session_id),
      current_run_selection: parseJson<TaskRunSelection>(
        String(row.current_run_selection_json),
      ),
      source: row.source as TaskSessionV1['source'],
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      row_version: Number(row.row_version),
    };
  }

  listSessions(principalRef: string): TaskSessionV1[] {
    assertText(principalRef, 'owner principal', 512);
    return (
      this.database
        .prepare(
          `SELECT session_id FROM task_workspace_sessions
            WHERE owner_principal_ref = ?
            ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'completed' THEN 1
                         WHEN 'cancelled' THEN 2 ELSE 3 END,
                     updated_at_ms DESC, session_id COLLATE BINARY`,
        )
        .all(principalRef) as Array<{ session_id: string }>
    ).map((row) => this.getSession(row.session_id, principalRef));
  }

  deleteSession(input: { sessionId: string; principalRef: string }): void {
    this.transaction(() => {
      this.getSession(input.sessionId, input.principalRef);
      const runningTurn = this.database
        .prepare(
          `SELECT 1 FROM task_workspace_coordinator_turns
            WHERE session_id = ? AND status = 'running' LIMIT 1`,
        )
        .get(input.sessionId);
      if (runningTurn) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Task is currently processing a Coordinator response',
        );
      }

      this.database
        .prepare(
          `DELETE FROM task_workspace_idempotency_records
            WHERE domain IN (
              SELECT 'interaction:' || interaction_id
                FROM task_workspace_pending_interaction_links
                WHERE session_id = ?
            )`,
        )
        .run(input.sessionId);
      this.database
        .prepare(
          `DELETE FROM task_workspace_idempotency_records
            WHERE domain = 'task-workspace-run'
              AND idempotency_key IN (
                SELECT idempotency_key FROM task_workspace_launch_intents
                  WHERE session_id = ?
              )`,
        )
        .run(input.sessionId);

      // Personal drafts have a deliberate draft/revision cycle.
      this.database
        .prepare(
          `UPDATE task_workspace_personal_workflow_drafts
              SET current_revision_id = NULL WHERE source_session_id = ?`,
        )
        .run(input.sessionId);
      this.database
        .prepare(
          `DELETE FROM task_workspace_personal_workflow_draft_revisions
            WHERE draft_id IN (
              SELECT draft_id FROM task_workspace_personal_workflow_drafts
                WHERE source_session_id = ?
            )`,
        )
        .run(input.sessionId);
      this.database
        .prepare(
          'DELETE FROM task_workspace_personal_workflow_drafts WHERE source_session_id = ?',
        )
        .run(input.sessionId);

      this.database
        .prepare(
          `DELETE FROM task_workspace_temporary_draft_revisions
            WHERE draft_id IN (
              SELECT draft_id FROM task_workspace_temporary_drafts
                WHERE launch_intent_id IN (
                  SELECT launch_intent_id FROM task_workspace_launch_intents
                    WHERE session_id = ?
                )
            )`,
        )
        .run(input.sessionId);
      this.database
        .prepare(
          `DELETE FROM task_workspace_temporary_drafts
            WHERE launch_intent_id IN (
              SELECT launch_intent_id FROM task_workspace_launch_intents
                WHERE session_id = ?
            )`,
        )
        .run(input.sessionId);
      this.database
        .prepare(
          `DELETE FROM task_workspace_launch_input_revisions
            WHERE launch_intent_id IN (
              SELECT launch_intent_id FROM task_workspace_launch_intents
                WHERE session_id = ?
            )`,
        )
        .run(input.sessionId);

      for (const table of [
        'task_workspace_execution_links',
        'task_workspace_artifact_links',
        'task_workspace_pending_interaction_links',
        'task_workspace_runtime_command_proposals',
        'task_workspace_replan_requests',
        'task_workspace_timeline_entries',
        'task_workspace_runtime_cursors',
      ]) {
        this.database
          .prepare(`DELETE FROM ${table} WHERE session_id = ?`)
          .run(input.sessionId);
      }

      this.database
        .prepare(
          'DELETE FROM task_workspace_launch_intents WHERE session_id = ?',
        )
        .run(input.sessionId);
      this.database
        .prepare(
          'DELETE FROM task_workspace_coordinator_turns WHERE session_id = ?',
        )
        .run(input.sessionId);
      this.database
        .prepare(
          `DELETE FROM task_workspace_message_attachments
            WHERE message_id IN (
              SELECT message_id FROM task_workspace_messages
                WHERE session_id = ?
            )`,
        )
        .run(input.sessionId);
      this.database
        .prepare('DELETE FROM task_workspace_messages WHERE session_id = ?')
        .run(input.sessionId);
      this.database
        .prepare('DELETE FROM task_workspace_threads WHERE session_id = ?')
        .run(input.sessionId);
      this.database
        .prepare('DELETE FROM task_workspace_audit_events WHERE session_id = ?')
        .run(input.sessionId);
      const deleted = this.database
        .prepare('DELETE FROM task_workspace_sessions WHERE session_id = ?')
        .run(input.sessionId).changes;
      if (deleted !== 1) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'TaskSession deletion failed',
        );
      }
    });
  }

  updateSessionStatus(input: {
    sessionId: string;
    principalRef: string;
    status: TaskSessionStatus;
    expectedRowVersion: number;
    nowMs?: number;
  }): TaskSessionV1 {
    const current = this.getSession(input.sessionId, input.principalRef);
    const allowed: Record<TaskSessionStatus, readonly TaskSessionStatus[]> = {
      open: ['completed', 'cancelled', 'archived'],
      completed: ['open', 'archived'],
      cancelled: ['open', 'archived'],
      archived: ['open'],
    };
    if (
      current.row_version !== input.expectedRowVersion ||
      !allowed[current.status].includes(input.status)
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'TaskSession status transition is stale or invalid',
      );
    }
    const nowMs = input.nowMs ?? Date.now();
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_sessions SET status = ?, updated_at_ms = ?,
          row_version = row_version + 1 WHERE session_id = ? AND row_version = ?`,
      )
      .run(
        input.status,
        nowMs,
        input.sessionId,
        input.expectedRowVersion,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError('conflict', 'TaskSession CAS failed');
    }
    return this.getSession(input.sessionId, input.principalRef);
  }

  projectRuntimeOutcome(input: {
    sessionId: string;
    outcome: 'normal' | 'errored' | 'cancelled';
    errorCode?: string | null;
    nowMs?: number;
  }): TaskSessionV1 {
    const current = this.getSession(input.sessionId);
    if (current.status === 'archived') return current;
    const cancelled =
      input.outcome === 'cancelled' ||
      input.errorCode === 'ad_hoc_workflow_cancelled';
    const status: TaskSessionStatus =
      input.outcome === 'normal'
        ? 'completed'
        : cancelled
          ? 'cancelled'
          : 'open';
    const attention: TaskAttentionState =
      input.outcome === 'errored' && !cancelled ? 'failed' : 'none';
    if (current.status === status && current.attention_state === attention)
      return current;
    const nowMs = input.nowMs ?? Date.now();
    this.database
      .prepare(
        `UPDATE task_workspace_sessions
            SET status = ?, attention_state = ?, updated_at_ms = ?,
                row_version = row_version + 1
          WHERE session_id = ? AND row_version = ?`,
      )
      .run(status, attention, nowMs, input.sessionId, current.row_version);
    return this.getSession(input.sessionId);
  }

  setRunSelection(input: {
    sessionId: string;
    principalRef: string;
    selection: TaskRunSelection;
    expectedRowVersion: number;
    nowMs?: number;
  }): TaskSessionV1 {
    const session = this.getSession(input.sessionId, input.principalRef);
    if (
      session.status !== 'open' ||
      session.row_version !== input.expectedRowVersion
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'TaskSession selection update is stale or Session is not open',
      );
    }
    const nowMs = input.nowMs ?? Date.now();
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_sessions
            SET current_run_selection_json = ?, updated_at_ms = ?,
                row_version = row_version + 1
          WHERE session_id = ? AND row_version = ?`,
      )
      .run(
        canonicalJson(input.selection),
        nowMs,
        input.sessionId,
        input.expectedRowVersion,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError('conflict', 'TaskSession CAS failed');
    }
    return this.getSession(input.sessionId, input.principalRef);
  }

  appendMessage(input: AppendMessageInput): {
    message: TaskConversationMessageV1;
    timeline: TaskTimelineEntryV1;
    turn: CoordinatorTurnV1 | null;
  } {
    const session = this.getSession(input.sessionId);
    if (session.status !== 'open') {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Messages can only be appended to an open TaskSession',
      );
    }
    const hasText = input.bodyText !== undefined;
    const hasJson = input.bodyJson !== undefined;
    if (hasText === hasJson) {
      throw new TaskWorkspaceStoreError(
        'invalid_input',
        'Message requires exactly one body representation',
      );
    }
    if (hasText) assertText(input.bodyText!, 'message body');
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      const messageSeq = this.nextMessageSeq(input.sessionId);
      const messageId = id('message');
      const bodyValue = hasText ? input.bodyText! : input.bodyJson!;
      const bodyHash = hash('message-body', bodyValue);
      const message: TaskConversationMessageV1 = {
        format: 'icarus.task-conversation-message/1',
        message_id: messageId,
        session_id: input.sessionId,
        thread_id: session.primary_thread_id,
        message_seq: messageSeq,
        role: input.role,
        body_json: hasJson ? input.bodyJson! : null,
        body_text: hasText ? input.bodyText! : null,
        body_hash: bodyHash,
        reply_to_message_id: input.replyToMessageId ?? null,
        causation_ref: input.causationRef ?? null,
        query_id: input.queryId ?? null,
        created_at_ms: nowMs,
      };
      this.database
        .prepare(
          `INSERT INTO task_workspace_messages (
            message_id, session_id, thread_id, message_seq, role, body_json,
            body_text, body_hash, reply_to_message_id, causation_ref, query_id,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          input.sessionId,
          session.primary_thread_id,
          messageSeq,
          input.role,
          hasJson ? canonicalJson(input.bodyJson!) : null,
          hasText ? input.bodyText! : null,
          bodyHash,
          input.replyToMessageId ?? null,
          input.causationRef ?? null,
          input.queryId ?? null,
          nowMs,
        );
      const timeline = this.insertTimeline({
        sessionId: input.sessionId,
        kind:
          input.role === 'human'
            ? 'human_message'
            : input.role === 'coordinator'
              ? 'coordinator_message'
              : 'system_notice',
        sourceKind: 'workspace',
        sourceId: messageId,
        sourceEventSeq: null,
        payload: {
          message_id: messageId,
          role: input.role,
          body: bodyValue,
          query_id: input.queryId ?? null,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
      let turn: CoordinatorTurnV1 | null = null;
      if (input.createCoordinatorTurn) {
        const turnId = id('turn');
        this.database
          .prepare(
            `INSERT INTO task_workspace_coordinator_turns (
              turn_id, session_id, source_message_id, status, attempt_no,
              query_id, error_code, created_at_ms, started_at_ms, finished_at_ms,
              row_version
            ) VALUES (?, ?, ?, 'pending', 1, NULL, NULL, ?, NULL, NULL, 1)`,
          )
          .run(turnId, input.sessionId, messageId, nowMs);
        turn = this.getCoordinatorTurn(turnId);
      }
      this.database
        .prepare(
          `UPDATE task_workspace_sessions SET updated_at_ms = ?,
            row_version = row_version + 1 WHERE session_id = ?`,
        )
        .run(nowMs, input.sessionId);
      return { message, timeline, turn };
    });
  }

  listMessages(sessionId: string): TaskConversationMessageV1[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM task_workspace_messages WHERE session_id = ? ORDER BY message_seq',
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((row) => ({
      format: 'icarus.task-conversation-message/1',
      message_id: String(row.message_id),
      session_id: String(row.session_id),
      thread_id: String(row.thread_id),
      message_seq: Number(row.message_seq),
      role: row.role as TaskMessageRole,
      body_json:
        row.body_json === null
          ? null
          : parseJson<JsonValue>(String(row.body_json)),
      body_text: row.body_text === null ? null : String(row.body_text),
      body_hash: row.body_hash as Sha256Hash,
      reply_to_message_id:
        row.reply_to_message_id === null
          ? null
          : String(row.reply_to_message_id),
      causation_ref:
        row.causation_ref === null ? null : String(row.causation_ref),
      query_id: row.query_id === null ? null : String(row.query_id),
      created_at_ms: Number(row.created_at_ms),
    }));
  }

  getMessage(messageId: string): TaskConversationMessageV1 {
    const row = this.database
      .prepare(
        'SELECT session_id FROM task_workspace_messages WHERE message_id = ?',
      )
      .get(messageId) as { session_id: string } | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError('not_found', 'Message not found');
    }
    const message = this.listMessages(row.session_id).find(
      (candidate) => candidate.message_id === messageId,
    );
    if (!message) {
      throw new TaskWorkspaceStoreError(
        'integrity_error',
        'Message index is inconsistent',
      );
    }
    return message;
  }

  getCoordinatorTurn(turnId: string): CoordinatorTurnV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_coordinator_turns WHERE turn_id = ?',
      )
      .get(turnId) as Record<string, unknown> | undefined;
    if (!row) throw new TaskWorkspaceStoreError('not_found', 'Turn not found');
    return {
      turn_id: String(row.turn_id),
      session_id: String(row.session_id),
      source_message_id: String(row.source_message_id),
      status: row.status as CoordinatorTurnV1['status'],
      attempt_no: Number(row.attempt_no),
      query_id: row.query_id === null ? null : String(row.query_id),
      error_code: row.error_code === null ? null : String(row.error_code),
      created_at_ms: Number(row.created_at_ms),
      started_at_ms:
        row.started_at_ms === null ? null : Number(row.started_at_ms),
      finished_at_ms:
        row.finished_at_ms === null ? null : Number(row.finished_at_ms),
      row_version: Number(row.row_version),
    };
  }

  claimNextCoordinatorTurn(
    sessionId: string,
    nowMs = Date.now(),
  ): CoordinatorTurnV1 | null {
    return this.transaction(() => {
      const running = this.database
        .prepare(
          "SELECT turn_id FROM task_workspace_coordinator_turns WHERE session_id = ? AND status = 'running'",
        )
        .get(sessionId);
      if (running) return null;
      const next = this.database
        .prepare(
          `SELECT turn_id, row_version FROM task_workspace_coordinator_turns
            WHERE session_id = ? AND status = 'pending'
            ORDER BY created_at_ms, turn_id COLLATE BINARY LIMIT 1`,
        )
        .get(sessionId) as { turn_id: string; row_version: number } | undefined;
      if (!next) return null;
      const changed = this.database
        .prepare(
          `UPDATE task_workspace_coordinator_turns
              SET status = 'running', started_at_ms = ?, row_version = row_version + 1
            WHERE turn_id = ? AND row_version = ? AND status = 'pending'`,
        )
        .run(nowMs, next.turn_id, next.row_version).changes;
      return changed === 1 ? this.getCoordinatorTurn(next.turn_id) : null;
    });
  }

  ensureCoordinatorTurn(input: {
    sessionId: string;
    sourceMessageId: string;
    nowMs?: number;
  }): CoordinatorTurnV1 {
    const source = this.getMessage(input.sourceMessageId);
    if (source.session_id !== input.sessionId || source.role !== 'human') {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Coordinator turn source must be a Human message in the same TaskSession',
      );
    }
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT turn_id FROM task_workspace_coordinator_turns
            WHERE source_message_id = ?
            ORDER BY attempt_no DESC LIMIT 1`,
        )
        .get(input.sourceMessageId) as { turn_id: string } | undefined;
      if (existing) return this.getCoordinatorTurn(existing.turn_id);
      const turnId = id('turn');
      this.database
        .prepare(
          `INSERT INTO task_workspace_coordinator_turns (
            turn_id, session_id, source_message_id, status, attempt_no, query_id,
            error_code, created_at_ms, started_at_ms, finished_at_ms, row_version
          ) VALUES (?, ?, ?, 'pending', 1, NULL, NULL, ?, NULL, NULL, 1)`,
        )
        .run(
          turnId,
          input.sessionId,
          input.sourceMessageId,
          input.nowMs ?? Date.now(),
        );
      return this.getCoordinatorTurn(turnId);
    });
  }

  claimCoordinatorTurn(
    turnId: string,
    nowMs = Date.now(),
  ): CoordinatorTurnV1 | null {
    return this.transaction(() => {
      const turn = this.getCoordinatorTurn(turnId);
      if (turn.status !== 'pending') return null;
      const running = this.database
        .prepare(
          `SELECT turn_id FROM task_workspace_coordinator_turns
            WHERE session_id = ? AND status = 'running' AND turn_id <> ?`,
        )
        .get(turn.session_id, turnId);
      if (running) return null;
      const changed = this.database
        .prepare(
          `UPDATE task_workspace_coordinator_turns
              SET status = 'running', started_at_ms = ?, row_version = row_version + 1
            WHERE turn_id = ? AND row_version = ? AND status = 'pending'`,
        )
        .run(nowMs, turn.turn_id, turn.row_version).changes;
      return changed === 1 ? this.getCoordinatorTurn(turnId) : null;
    });
  }

  replaceCoordinatorAgentSession(input: {
    sessionId: string;
    expectedAgentSessionId: string | null;
    agentSessionId: string | null;
    nowMs?: number;
  }): TaskSessionV1 {
    const nowMs = input.nowMs ?? Date.now();
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_sessions
            SET coordinator_agent_session_id = ?, updated_at_ms = ?,
                row_version = row_version + 1
          WHERE session_id = ?
            AND coordinator_agent_session_id IS ?`,
      )
      .run(
        input.agentSessionId,
        nowMs,
        input.sessionId,
        input.expectedAgentSessionId,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Coordinator Agent session changed concurrently',
      );
    }
    return this.getSession(input.sessionId);
  }

  finishCoordinatorTurn(input: {
    turnId: string;
    status: 'completed' | 'failed';
    queryId: string | null;
    errorCode?: string | null;
    agentSessionId?: string | null;
    nowMs?: number;
  }): CoordinatorTurnV1 {
    const nowMs = input.nowMs ?? Date.now();
    const turn = this.getCoordinatorTurn(input.turnId);
    if (turn.status !== 'running') {
      throw new TaskWorkspaceStoreError('conflict', 'Turn is not running');
    }
    return this.transaction(() => {
      this.database
        .prepare(
          `UPDATE task_workspace_coordinator_turns
              SET status = ?, query_id = ?, error_code = ?, finished_at_ms = ?,
                  row_version = row_version + 1
            WHERE turn_id = ? AND status = 'running'`,
        )
        .run(
          input.status,
          input.queryId,
          input.errorCode ?? null,
          nowMs,
          input.turnId,
        );
      if (input.agentSessionId) {
        this.database
          .prepare(
            `UPDATE task_workspace_sessions
                SET coordinator_agent_session_id = ?, updated_at_ms = ?,
                    row_version = row_version + 1
              WHERE session_id = ?`,
          )
          .run(input.agentSessionId, nowMs, turn.session_id);
      }
      return this.getCoordinatorTurn(input.turnId);
    });
  }

  retryCoordinatorTurn(turnId: string, nowMs = Date.now()): CoordinatorTurnV1 {
    const prior = this.getCoordinatorTurn(turnId);
    if (!['failed', 'interrupted'].includes(prior.status)) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Only failed or interrupted turns can be retried',
      );
    }
    const newId = id('turn');
    this.database
      .prepare(
        `INSERT INTO task_workspace_coordinator_turns (
          turn_id, session_id, source_message_id, status, attempt_no, query_id,
          error_code, created_at_ms, started_at_ms, finished_at_ms, row_version
        ) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, 1)`,
      )
      .run(
        newId,
        prior.session_id,
        prior.source_message_id,
        prior.attempt_no + 1,
        nowMs,
      );
    return this.getCoordinatorTurn(newId);
  }

  createRunLaunchIntent(
    input: CreateRunLaunchIntentInput,
  ): CreateRunLaunchIntentResult {
    assertText(input.messageText, 'message body');
    assertText(input.idempotencyKey, 'idempotency key', 512);
    this.getSession(input.sessionId);
    const effectiveInputHash = hash('launch-input', input.effectiveInput);
    const messageBodyHash = hash('message-body', input.messageText);
    const requestHash = hash('run-request', {
      session_id: input.sessionId,
      mode: input.mode,
      selected_recipe_ref: input.selectedRecipeRef ?? null,
      selected_recipe_hash: input.selectedRecipeHash ?? null,
      message_body_hash: messageBodyHash,
      effective_input_json: input.effectiveInput,
      effective_input_hash: effectiveInputHash,
      attachment_manifest_hash: input.attachmentManifestHash,
    });
    const domain = 'task-workspace-run';
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      const prior = this.database
        .prepare(
          `SELECT request_hash, response_json
             FROM task_workspace_idempotency_records
            WHERE domain = ? AND idempotency_key = ?`,
        )
        .get(domain, input.idempotencyKey) as
        | { request_hash: Sha256Hash; response_json: string }
        | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new TaskWorkspaceStoreError(
            'conflict',
            'Run idempotency key binds a different Session, selection, input, or attachment manifest',
          );
        }
        const response = parseJson<{
          launch_intent_id: string;
          source_message_id: string;
          timeline_entry_id: string;
        }>(prior.response_json);
        const launch = this.getLaunchIntent(response.launch_intent_id);
        const message = this.getMessage(response.source_message_id);
        if (
          launch.session_id !== input.sessionId ||
          launch.source_message_id !== message.message_id
        ) {
          throw new TaskWorkspaceStoreError(
            'integrity_error',
            'Run idempotency response identity is inconsistent',
          );
        }
        return {
          launch,
          message,
          timeline: this.getTimelineEntry(response.timeline_entry_id),
          created: false,
        };
      }

      const session = this.getSession(input.sessionId);
      if (session.status !== 'open') {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Run requires an open TaskSession',
        );
      }
      if (input.mode === 'published_recipe') {
        if (
          session.current_run_selection.kind !== 'published_recipe' ||
          !input.selectedRecipeRef ||
          !input.selectedRecipeHash ||
          canonicalJson(session.current_run_selection.recipe_ref) !==
            canonicalJson(input.selectedRecipeRef) ||
          session.current_run_selection.recipe_hash !== input.selectedRecipeHash
        ) {
          throw new TaskWorkspaceStoreError(
            'conflict',
            'Run Recipe does not match the TaskSession exact selection',
          );
        }
      } else if (session.current_run_selection.kind !== 'temporary_workflow') {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Temporary Run does not match the TaskSession selection',
        );
      }

      const messageId = id('message');
      const messageSeq = this.nextMessageSeq(input.sessionId);
      const message: TaskConversationMessageV1 = {
        format: 'icarus.task-conversation-message/1',
        message_id: messageId,
        session_id: input.sessionId,
        thread_id: session.primary_thread_id,
        message_seq: messageSeq,
        role: 'human',
        body_json: null,
        body_text: input.messageText,
        body_hash: messageBodyHash,
        reply_to_message_id: null,
        causation_ref: null,
        query_id: null,
        created_at_ms: nowMs,
      };
      this.database
        .prepare(
          `INSERT INTO task_workspace_messages (
            message_id, session_id, thread_id, message_seq, role, body_json,
            body_text, body_hash, reply_to_message_id, causation_ref, query_id,
            created_at_ms
          ) VALUES (?, ?, ?, ?, 'human', NULL, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(
          message.message_id,
          message.session_id,
          message.thread_id,
          message.message_seq,
          message.body_text,
          message.body_hash,
          message.created_at_ms,
        );
      const timeline = this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'human_message',
        sourceKind: 'workspace',
        sourceId: messageId,
        sourceEventSeq: null,
        payload: {
          message_id: messageId,
          role: 'human',
          body: input.messageText,
          query_id: null,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });

      const launchIntentId = id('launch');
      const creationDomain = `task_workspace:${input.sessionId}`;
      const creationKey = hash('creation-key', {
        session_id: input.sessionId,
        idempotency_key: input.idempotencyKey,
      });
      const status: TaskLaunchStatus =
        input.mode === 'published_recipe' ? 'creating' : 'drafting';
      this.database
        .prepare(
          `INSERT INTO task_workspace_launch_intents (
            launch_intent_id, session_id, source_message_id, mode,
            selected_recipe_ref_json, selected_recipe_hash, selection_token,
            effective_input_json, effective_input_hash, attachment_manifest_hash,
            confirmed_draft_revision_id, status, creation_domain, creation_key,
            idempotency_key, last_error_code, row_version, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          launchIntentId,
          input.sessionId,
          messageId,
          input.mode,
          input.selectedRecipeRef
            ? canonicalJson(input.selectedRecipeRef)
            : null,
          input.selectedRecipeHash ?? null,
          input.selectionToken ?? null,
          canonicalJson(input.effectiveInput),
          effectiveInputHash,
          input.attachmentManifestHash,
          status,
          creationDomain,
          creationKey,
          input.idempotencyKey,
          nowMs,
          nowMs,
        );
      this.database
        .prepare(
          `INSERT INTO task_workspace_launch_input_revisions
            (revision_id, launch_intent_id, revision_no, input_json, input_hash, created_at_ms)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(
          id('launch-input'),
          launchIntentId,
          canonicalJson(input.effectiveInput),
          effectiveInputHash,
          nowMs,
        );
      this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'launch_status',
        sourceKind: 'workspace',
        sourceId: launchIntentId,
        sourceEventSeq: null,
        payload: { launch_intent_id: launchIntentId, mode: input.mode, status },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
      this.database
        .prepare(
          `UPDATE task_workspace_sessions SET attention_state = 'none', updated_at_ms = ?,
            row_version = row_version + 1 WHERE session_id = ?`,
        )
        .run(nowMs, input.sessionId);
      this.database
        .prepare(
          `INSERT INTO task_workspace_idempotency_records
            (domain, idempotency_key, request_hash, response_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          domain,
          input.idempotencyKey,
          requestHash,
          canonicalJson({
            launch_intent_id: launchIntentId,
            source_message_id: messageId,
            timeline_entry_id: timeline.entry_id,
          }),
          nowMs,
        );
      return {
        launch: this.getLaunchIntent(launchIntentId),
        message,
        timeline,
        created: true,
      };
    });
  }

  findLaunchIntentByIdempotencyKey(
    idempotencyKey: string,
  ): TaskLaunchIntentV1 | null {
    assertText(idempotencyKey, 'idempotency key', 512);
    const row = this.database
      .prepare(
        'SELECT launch_intent_id FROM task_workspace_launch_intents WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as { launch_intent_id: string } | undefined;
    return row ? this.getLaunchIntent(row.launch_intent_id) : null;
  }

  createLaunchIntent(input: {
    sessionId: string;
    sourceMessageId: string;
    mode: TaskLaunchMode;
    selectionToken?: string | null;
    selectedRecipeRef?: JsonObject | null;
    selectedRecipeHash?: Sha256Hash | null;
    effectiveInput: JsonValue;
    attachmentManifestHash: Sha256Hash;
    idempotencyKey: string;
    nowMs?: number;
  }): TaskLaunchIntentV1 {
    assertText(input.idempotencyKey, 'idempotency key', 512);
    const nowMs = input.nowMs ?? Date.now();
    const existing = this.database
      .prepare(
        'SELECT launch_intent_id, effective_input_hash FROM task_workspace_launch_intents WHERE idempotency_key = ?',
      )
      .get(input.idempotencyKey) as
      | { launch_intent_id: string; effective_input_hash: Sha256Hash }
      | undefined;
    const effectiveInputHash = hash('launch-input', input.effectiveInput);
    if (existing) {
      if (existing.effective_input_hash !== effectiveInputHash) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Launch idempotency key binds a different effective input',
        );
      }
      return this.getLaunchIntent(existing.launch_intent_id);
    }
    const launchIntentId = id('launch');
    const creationDomain = `task_workspace:${input.sessionId}`;
    const creationKey = hash('creation-key', {
      session_id: input.sessionId,
      idempotency_key: input.idempotencyKey,
    });
    const status: TaskLaunchStatus =
      input.mode === 'published_recipe' ? 'creating' : 'drafting';
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_workspace_launch_intents (
            launch_intent_id, session_id, source_message_id, mode,
            selected_recipe_ref_json, selected_recipe_hash, selection_token,
            effective_input_json, effective_input_hash, attachment_manifest_hash,
            confirmed_draft_revision_id, status, creation_domain, creation_key,
            idempotency_key, last_error_code, row_version, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          launchIntentId,
          input.sessionId,
          input.sourceMessageId,
          input.mode,
          input.selectedRecipeRef
            ? canonicalJson(input.selectedRecipeRef)
            : null,
          input.selectedRecipeHash ?? null,
          input.selectionToken ?? null,
          canonicalJson(input.effectiveInput),
          effectiveInputHash,
          input.attachmentManifestHash,
          status,
          creationDomain,
          creationKey,
          input.idempotencyKey,
          nowMs,
          nowMs,
        );
      this.database
        .prepare(
          `INSERT INTO task_workspace_launch_input_revisions
            (revision_id, launch_intent_id, revision_no, input_json, input_hash, created_at_ms)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(
          id('launch-input'),
          launchIntentId,
          canonicalJson(input.effectiveInput),
          effectiveInputHash,
          nowMs,
        );
      this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'launch_status',
        sourceKind: 'workspace',
        sourceId: launchIntentId,
        sourceEventSeq: null,
        payload: { launch_intent_id: launchIntentId, mode: input.mode, status },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
    });
    return this.getLaunchIntent(launchIntentId);
  }

  getLaunchIntent(launchIntentId: string): TaskLaunchIntentV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_launch_intents WHERE launch_intent_id = ?',
      )
      .get(launchIntentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError('not_found', 'LaunchIntent not found');
    }
    return {
      launch_intent_id: String(row.launch_intent_id),
      session_id: String(row.session_id),
      source_message_id: String(row.source_message_id),
      mode: row.mode as TaskLaunchMode,
      selected_recipe_ref:
        row.selected_recipe_ref_json === null
          ? null
          : parseJson(String(row.selected_recipe_ref_json)),
      selected_recipe_hash:
        row.selected_recipe_hash === null
          ? null
          : (String(row.selected_recipe_hash) as Sha256Hash),
      selection_token:
        row.selection_token === null ? null : String(row.selection_token),
      effective_input_json: parseJson(String(row.effective_input_json)),
      effective_input_hash: row.effective_input_hash as Sha256Hash,
      attachment_manifest_hash: row.attachment_manifest_hash as Sha256Hash,
      confirmed_draft_revision_id:
        row.confirmed_draft_revision_id === null
          ? null
          : String(row.confirmed_draft_revision_id),
      status: row.status as TaskLaunchStatus,
      creation_domain: String(row.creation_domain),
      creation_key: String(row.creation_key),
      idempotency_key: String(row.idempotency_key),
      last_error_code:
        row.last_error_code === null ? null : String(row.last_error_code),
      row_version: Number(row.row_version),
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
    };
  }

  listCreatingLaunchIntents(): TaskLaunchIntentV1[] {
    return (
      this.database
        .prepare(
          "SELECT launch_intent_id FROM task_workspace_launch_intents WHERE status = 'creating' ORDER BY created_at_ms",
        )
        .all() as Array<{ launch_intent_id: string }>
    ).map((row) => this.getLaunchIntent(row.launch_intent_id));
  }

  listDraftingTemporaryLaunchIntents(): TaskLaunchIntentV1[] {
    return (
      this.database
        .prepare(
          `SELECT launch_intent_id FROM task_workspace_launch_intents
            WHERE mode = 'temporary_workflow' AND status = 'drafting'
            ORDER BY created_at_ms, launch_intent_id COLLATE BINARY`,
        )
        .all() as Array<{ launch_intent_id: string }>
    ).map((row) => this.getLaunchIntent(row.launch_intent_id));
  }

  updateLaunchStatus(input: {
    launchIntentId: string;
    expectedRowVersion: number;
    status: TaskLaunchStatus;
    errorCode?: string | null;
    confirmedRevisionId?: string | null;
    nowMs?: number;
  }): TaskLaunchIntentV1 {
    const nowMs = input.nowMs ?? Date.now();
    const current = this.getLaunchIntent(input.launchIntentId);
    const changed = this.transaction(() => {
      const count = this.database
        .prepare(
          `UPDATE task_workspace_launch_intents SET status = ?,
              last_error_code = ?, confirmed_draft_revision_id = COALESCE(?, confirmed_draft_revision_id),
              updated_at_ms = ?, row_version = row_version + 1
            WHERE launch_intent_id = ? AND row_version = ?`,
        )
        .run(
          input.status,
          input.errorCode ?? null,
          input.confirmedRevisionId ?? null,
          nowMs,
          input.launchIntentId,
          input.expectedRowVersion,
        ).changes;
      if (count === 1) {
        this.database
          .prepare(
            `UPDATE task_workspace_sessions
                SET attention_state = ?, updated_at_ms = ?,
                    row_version = row_version + 1
              WHERE session_id = ?`,
          )
          .run(
            attentionForLaunchStatus(input.status),
            nowMs,
            current.session_id,
          );
        this.insertTimeline({
          sessionId: current.session_id,
          kind: 'launch_status',
          sourceKind: 'workspace',
          sourceId: `${input.launchIntentId}:${input.status}:${input.expectedRowVersion + 1}`,
          sourceEventSeq: null,
          payload: {
            launch_intent_id: input.launchIntentId,
            status: input.status,
            error_code: input.errorCode ?? null,
          },
          occurredAtMs: nowMs,
          createdAtMs: nowMs,
        });
      }
      return count;
    });
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError('conflict', 'LaunchIntent CAS failed');
    }
    return this.getLaunchIntent(input.launchIntentId);
  }

  confirmCurrentTemporaryRevision(input: {
    launchIntentId: string;
    revisionId: string;
    expectedRowVersion: number;
    nowMs?: number;
  }): {
    launch: TaskLaunchIntentV1;
    revision: TemporaryWorkflowDraftRevisionV1;
  } {
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      const launch = this.getLaunchIntent(input.launchIntentId);
      if (
        launch.mode !== 'temporary_workflow' ||
        launch.status !== 'awaiting_confirmation' ||
        launch.row_version !== input.expectedRowVersion
      ) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Temporary confirmation is stale',
        );
      }
      const authority = this.database
        .prepare(
          `SELECT draft.draft_id, draft.current_revision_id, draft.status
             FROM task_workspace_temporary_drafts AS draft
             JOIN task_workspace_temporary_draft_revisions AS revision
               ON revision.draft_id = draft.draft_id
            WHERE draft.launch_intent_id = ? AND revision.revision_id = ?`,
        )
        .get(input.launchIntentId, input.revisionId) as
        | {
            draft_id: string;
            current_revision_id: string | null;
            status: string;
          }
        | undefined;
      if (
        !authority ||
        authority.current_revision_id !== input.revisionId ||
        authority.status !== 'awaiting_confirmation'
      ) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Temporary revision is not the current revision of this LaunchIntent Draft',
        );
      }
      const launchChanged = this.database
        .prepare(
          `UPDATE task_workspace_launch_intents
              SET status = 'creating', confirmed_draft_revision_id = ?,
                  last_error_code = NULL, updated_at_ms = ?,
                  row_version = row_version + 1
            WHERE launch_intent_id = ? AND row_version = ?
              AND status = 'awaiting_confirmation'`,
        )
        .run(
          input.revisionId,
          nowMs,
          input.launchIntentId,
          input.expectedRowVersion,
        ).changes;
      const draftChanged = this.database
        .prepare(
          `UPDATE task_workspace_temporary_drafts
              SET status = 'confirmed', updated_at_ms = ?,
                  row_version = row_version + 1
            WHERE draft_id = ? AND current_revision_id = ?
              AND status = 'awaiting_confirmation'`,
        )
        .run(nowMs, authority.draft_id, input.revisionId).changes;
      if (launchChanged !== 1 || draftChanged !== 1) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Temporary confirmation CAS failed',
        );
      }
      this.database
        .prepare(
          `UPDATE task_workspace_sessions
              SET attention_state = 'none', updated_at_ms = ?,
                  row_version = row_version + 1
            WHERE session_id = ?`,
        )
        .run(nowMs, launch.session_id);
      this.insertTimeline({
        sessionId: launch.session_id,
        kind: 'launch_status',
        sourceKind: 'workspace',
        sourceId: `${input.launchIntentId}:creating:${input.expectedRowVersion + 1}`,
        sourceEventSeq: null,
        payload: {
          launch_intent_id: input.launchIntentId,
          status: 'creating',
          confirmed_draft_revision_id: input.revisionId,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
      return {
        launch: this.getLaunchIntent(input.launchIntentId),
        revision: this.getTemporaryRevision(input.revisionId),
      };
    });
  }

  createTemporaryRevision(input: {
    launchIntentId: string;
    sourceMessageId: string;
    source: JsonObject;
    sourceHash: Sha256Hash;
    compiledPlan: JsonObject;
    compiledPlanHash: Sha256Hash;
    compilerVersion: string;
    resourceClosureHash: Sha256Hash;
    policyCeilingHash: Sha256Hash;
    riskSummary: JsonObject;
    nowMs?: number;
  }): TemporaryWorkflowDraftRevisionV1 {
    const launch = this.getLaunchIntent(input.launchIntentId);
    if (
      launch.mode !== 'temporary_workflow' ||
      !['drafting', 'awaiting_confirmation', 'failed'].includes(launch.status)
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Temporary Draft revision is not allowed in the current LaunchIntent state',
      );
    }
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      let draft = this.database
        .prepare(
          'SELECT draft_id, current_revision_id FROM task_workspace_temporary_drafts WHERE launch_intent_id = ?',
        )
        .get(input.launchIntentId) as
        | { draft_id: string; current_revision_id: string | null }
        | undefined;
      if (!draft) {
        draft = { draft_id: id('temporary-draft'), current_revision_id: null };
        this.database
          .prepare(
            `INSERT INTO task_workspace_temporary_drafts
              (draft_id, launch_intent_id, current_revision_id, status,
               created_at_ms, updated_at_ms, row_version)
             VALUES (?, ?, NULL, 'drafting', ?, ?, 1)`,
          )
          .run(draft.draft_id, input.launchIntentId, nowMs, nowMs);
      }
      const next = this.database
        .prepare(
          `SELECT COALESCE(MAX(revision_no), 0) + 1 AS next
             FROM task_workspace_temporary_draft_revisions WHERE draft_id = ?`,
        )
        .get(draft.draft_id) as { next: number };
      const revision: TemporaryWorkflowDraftRevisionV1 = {
        format: 'icarus.temporary-workflow-draft-revision/1',
        revision_id: id('temporary-revision'),
        draft_id: draft.draft_id,
        revision_no: next.next,
        parent_revision_id: draft.current_revision_id,
        source_message_id: input.sourceMessageId,
        source_json: input.source,
        source_hash: input.sourceHash,
        compiled_plan_json: input.compiledPlan,
        compiled_plan_hash: input.compiledPlanHash,
        compiler_version: input.compilerVersion,
        resource_closure_hash: input.resourceClosureHash,
        policy_ceiling_hash: input.policyCeilingHash,
        risk_summary_json: input.riskSummary,
        created_at_ms: nowMs,
      };
      this.database
        .prepare(
          `INSERT INTO task_workspace_temporary_draft_revisions (
            revision_id, draft_id, revision_no, parent_revision_id,
            source_message_id, source_json, source_hash, compiled_plan_json,
            compiled_plan_hash, compiler_version, resource_closure_hash,
            policy_ceiling_hash, risk_summary_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.revision_id,
          revision.draft_id,
          revision.revision_no,
          revision.parent_revision_id,
          revision.source_message_id,
          canonicalJson(revision.source_json),
          revision.source_hash,
          canonicalJson(revision.compiled_plan_json),
          revision.compiled_plan_hash,
          revision.compiler_version,
          revision.resource_closure_hash,
          revision.policy_ceiling_hash,
          canonicalJson(revision.risk_summary_json),
          nowMs,
        );
      this.database
        .prepare(
          `UPDATE task_workspace_temporary_drafts
              SET current_revision_id = ?, status = 'awaiting_confirmation',
                  updated_at_ms = ?, row_version = row_version + 1
            WHERE draft_id = ?`,
        )
        .run(revision.revision_id, nowMs, draft.draft_id);
      this.database
        .prepare(
          `UPDATE task_workspace_launch_intents
              SET status = 'awaiting_confirmation', last_error_code = NULL,
                  updated_at_ms = ?,
                  row_version = row_version + 1 WHERE launch_intent_id = ?`,
        )
        .run(nowMs, input.launchIntentId);
      this.database
        .prepare(
          `UPDATE task_workspace_sessions
              SET attention_state = 'waiting_user', updated_at_ms = ?,
                  row_version = row_version + 1
            WHERE session_id = ?`,
        )
        .run(nowMs, launch.session_id);
      this.insertTimeline({
        sessionId: launch.session_id,
        kind: 'launch_status',
        sourceKind: 'workspace',
        sourceId: revision.revision_id,
        sourceEventSeq: null,
        payload: {
          interaction_kind: 'temporary_confirmation',
          launch_intent_id: input.launchIntentId,
          revision: JSON.parse(
            canonicalJson(revision as unknown as JsonObject),
          ) as JsonObject,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
      return revision;
    });
  }

  getTemporaryRevision(revisionId: string): TemporaryWorkflowDraftRevisionV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_temporary_draft_revisions WHERE revision_id = ?',
      )
      .get(revisionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Temporary Draft revision not found',
      );
    }
    return {
      format: 'icarus.temporary-workflow-draft-revision/1',
      revision_id: String(row.revision_id),
      draft_id: String(row.draft_id),
      revision_no: Number(row.revision_no),
      parent_revision_id:
        row.parent_revision_id === null ? null : String(row.parent_revision_id),
      source_message_id: String(row.source_message_id),
      source_json: parseJson(String(row.source_json)),
      source_hash: row.source_hash as Sha256Hash,
      compiled_plan_json: parseJson(String(row.compiled_plan_json)),
      compiled_plan_hash: row.compiled_plan_hash as Sha256Hash,
      compiler_version: String(row.compiler_version),
      resource_closure_hash: row.resource_closure_hash as Sha256Hash,
      policy_ceiling_hash: row.policy_ceiling_hash as Sha256Hash,
      risk_summary_json: parseJson(String(row.risk_summary_json)),
      created_at_ms: Number(row.created_at_ms),
    };
  }

  addExecutionLink(
    input: Omit<TaskExecutionLinkV1, 'link_id'>,
  ): TaskExecutionLinkV1 {
    const existing = this.database
      .prepare(
        'SELECT * FROM task_workspace_execution_links WHERE launch_intent_id = ?',
      )
      .get(input.launch_intent_id) as Record<string, unknown> | undefined;
    if (existing) return this.mapExecutionLink(existing);
    const link: TaskExecutionLinkV1 = {
      link_id: id('execution-link'),
      ...input,
    };
    this.database
      .prepare(
        `INSERT INTO task_workspace_execution_links (
          link_id, session_id, workflow_id, intake_id, creation_request_id,
          launch_intent_id, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        link.link_id,
        link.session_id,
        link.workflow_id,
        link.intake_id,
        link.creation_request_id,
        link.launch_intent_id,
        link.created_at_ms,
      );
    return link;
  }

  private mapExecutionLink(row: Record<string, unknown>): TaskExecutionLinkV1 {
    return {
      link_id: String(row.link_id),
      session_id: String(row.session_id),
      workflow_id: String(row.workflow_id),
      intake_id: String(row.intake_id),
      creation_request_id: String(row.creation_request_id),
      launch_intent_id: String(row.launch_intent_id),
      created_at_ms: Number(row.created_at_ms),
    };
  }

  listExecutionLinks(sessionId: string): TaskExecutionLinkV1[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM task_workspace_execution_links WHERE session_id = ? ORDER BY created_at_ms, link_id',
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((row) => this.mapExecutionLink(row));
  }

  findExecutionLinkByWorkflow(
    workflowId: string,
    principalRef: string,
  ): TaskExecutionLinkV1 | null {
    const row = this.database
      .prepare(
        `SELECT link.*
           FROM task_workspace_execution_links AS link
           JOIN task_workspace_sessions AS session
             ON session.session_id = link.session_id
          WHERE link.workflow_id = ?
            AND session.owner_principal_ref = ?
          ORDER BY session.updated_at_ms DESC, link.created_at_ms DESC, link.link_id
          LIMIT 1`,
      )
      .get(workflowId, principalRef) as Record<string, unknown> | undefined;
    return row ? this.mapExecutionLink(row) : null;
  }

  upsertArtifactLink(input: {
    sessionId: string;
    workflowId: string;
    artifactRef: string;
    artifactHash: Sha256Hash;
    display: JsonObject;
    nowMs?: number;
  }): TaskArtifactLinkV1 {
    assertText(input.artifactRef, 'artifact ref', 2_000);
    const linked = this.database
      .prepare(
        `SELECT 1 FROM task_workspace_execution_links
          WHERE session_id = ? AND workflow_id = ?`,
      )
      .get(input.sessionId, input.workflowId);
    if (!linked) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Artifact Workflow is not linked to this TaskSession',
      );
    }
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM task_workspace_artifact_links
            WHERE session_id = ? AND workflow_id = ?
              AND artifact_ref = ? AND artifact_hash = ?`,
        )
        .get(
          input.sessionId,
          input.workflowId,
          input.artifactRef,
          input.artifactHash,
        ) as Record<string, unknown> | undefined;
      if (existing) {
        const currentDisplay = parseJson<JsonObject>(
          String(existing.display_json),
        );
        if (canonicalJson(currentDisplay) !== canonicalJson(input.display)) {
          this.database
            .prepare(
              `UPDATE task_workspace_artifact_links SET display_json = ?
                WHERE artifact_link_id = ?`,
            )
            .run(
              canonicalJson(input.display),
              String(existing.artifact_link_id),
            );
        }
        return this.getArtifactLink(String(existing.artifact_link_id));
      }
      const artifactLinkId = id('artifact-link');
      this.database
        .prepare(
          `INSERT INTO task_workspace_artifact_links (
            artifact_link_id, session_id, workflow_id, artifact_ref,
            artifact_hash, display_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactLinkId,
          input.sessionId,
          input.workflowId,
          input.artifactRef,
          input.artifactHash,
          canonicalJson(input.display),
          nowMs,
        );
      this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'artifact_published',
        sourceKind: 'workspace',
        sourceId: artifactLinkId,
        sourceEventSeq: null,
        payload: {
          artifact_link_id: artifactLinkId,
          workflow_id: input.workflowId,
          artifact_ref: input.artifactRef,
          artifact_hash: input.artifactHash,
          display: input.display,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
      return this.getArtifactLink(artifactLinkId);
    });
  }

  getArtifactLink(artifactLinkId: string): TaskArtifactLinkV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_artifact_links WHERE artifact_link_id = ?',
      )
      .get(artifactLinkId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError('not_found', 'Artifact link not found');
    }
    return {
      artifact_link_id: String(row.artifact_link_id),
      session_id: String(row.session_id),
      workflow_id: String(row.workflow_id),
      artifact_ref: String(row.artifact_ref),
      artifact_hash: row.artifact_hash as Sha256Hash,
      display_json: parseJson(String(row.display_json)),
      created_at_ms: Number(row.created_at_ms),
    };
  }

  listArtifactLinks(
    sessionId: string,
    workflowId?: string,
  ): TaskArtifactLinkV1[] {
    const rows = workflowId
      ? this.database
          .prepare(
            `SELECT artifact_link_id FROM task_workspace_artifact_links
              WHERE session_id = ? AND workflow_id = ?
              ORDER BY created_at_ms, artifact_link_id COLLATE BINARY`,
          )
          .all(sessionId, workflowId)
      : this.database
          .prepare(
            `SELECT artifact_link_id FROM task_workspace_artifact_links
              WHERE session_id = ?
              ORDER BY created_at_ms, artifact_link_id COLLATE BINARY`,
          )
          .all(sessionId);
    return (rows as Array<{ artifact_link_id: string }>).map((row) =>
      this.getArtifactLink(row.artifact_link_id),
    );
  }

  getRuntimeCursor(
    sessionId: string,
    workflowId: string,
    runId: string,
  ): number {
    const row = this.database
      .prepare(
        `SELECT event_seq FROM task_workspace_runtime_cursors
          WHERE session_id = ? AND workflow_id = ? AND run_id = ?`,
      )
      .get(sessionId, workflowId, runId) as { event_seq: number } | undefined;
    return row?.event_seq ?? 0;
  }

  appendRuntimeEvents(input: {
    sessionId: string;
    workflowId: string;
    runId: string;
    expectedAfterEventSeq: number;
    events: readonly JsonObject[];
    nextEventSeq: number;
    sourceState?: 'ready' | 'catching_up' | 'degraded';
    nowMs?: number;
  }): TaskTimelineEntryV1[] {
    const nowMs = input.nowMs ?? Date.now();
    return this.transaction(() => {
      const current = this.getRuntimeCursor(
        input.sessionId,
        input.workflowId,
        input.runId,
      );
      if (current !== input.expectedAfterEventSeq) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Runtime cursor changed during catch-up',
        );
      }
      const appended: TaskTimelineEntryV1[] = [];
      for (const event of input.events) {
        const sequence = Number(event.seq);
        const existing = this.database
          .prepare(
            `SELECT entry_id FROM task_workspace_timeline_entries
              WHERE session_id = ? AND source_kind = 'runtime'
                AND source_id = ? AND source_event_seq = ?`,
          )
          .get(input.sessionId, input.runId, sequence);
        if (existing) continue;
        const eventType = String(event.event_type);
        const kind = runtimeTimelineKind(eventType);
        appended.push(
          this.insertTimeline({
            sessionId: input.sessionId,
            kind,
            sourceKind: 'runtime',
            sourceId: input.runId,
            sourceEventSeq: sequence,
            payload: {
              workflow_id: input.workflowId,
              run_id: input.runId,
              ...event,
            },
            occurredAtMs: Number(event.occurred_at_ms ?? nowMs),
            createdAtMs: nowMs,
          }),
        );
      }
      this.database
        .prepare(
          `INSERT INTO task_workspace_runtime_cursors
            (session_id, workflow_id, run_id, event_seq, source_state, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, workflow_id, run_id) DO UPDATE SET
             event_seq = excluded.event_seq,
             source_state = excluded.source_state,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.sessionId,
          input.workflowId,
          input.runId,
          input.nextEventSeq,
          input.sourceState ?? 'ready',
          nowMs,
        );
      return appended;
    });
  }

  listTimeline(
    sessionId: string,
    afterSessionSeq = 0,
    limit = 500,
  ): TaskTimelineEntryV1[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM task_workspace_timeline_entries
            WHERE session_id = ? AND session_seq > ?
            ORDER BY session_seq LIMIT ?`,
        )
        .all(sessionId, afterSessionSeq, limit) as Record<string, unknown>[]
    ).map((row) => this.mapTimelineEntry(row));
  }

  rebuildRuntimeTimeline(sessionId: string): void {
    this.transaction(() => {
      this.database
        .prepare(
          "DELETE FROM task_workspace_timeline_entries WHERE session_id = ? AND source_kind = 'runtime'",
        )
        .run(sessionId);
      this.database
        .prepare(
          `UPDATE task_workspace_runtime_cursors
              SET event_seq = 0, source_state = 'catching_up', updated_at_ms = ?
            WHERE session_id = ?`,
        )
        .run(Date.now(), sessionId);
    });
  }

  upsertPendingInteraction(input: {
    interactionId: string;
    sessionId: string;
    workflowId: string;
    runId: string;
    waitId: string;
    renderedSnapshot: JsonObject;
    renderedSnapshotHash: Sha256Hash;
    targetRowVersion: number;
    nowMs?: number;
  }): TaskPendingInteractionV1 {
    const existing = this.database
      .prepare(
        'SELECT * FROM task_workspace_pending_interaction_links WHERE interaction_id = ?',
      )
      .get(input.interactionId) as Record<string, unknown> | undefined;
    if (existing) {
      const mapped = this.mapPendingInteraction(existing);
      if (
        mapped.session_id !== input.sessionId ||
        mapped.workflow_id !== input.workflowId ||
        mapped.run_id !== input.runId ||
        mapped.target_id !== input.waitId ||
        mapped.rendered_snapshot_hash !== input.renderedSnapshotHash ||
        mapped.target_row_version !== input.targetRowVersion
      ) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Pending interaction identity drifted',
        );
      }
      return mapped;
    }
    const nowMs = input.nowMs ?? Date.now();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_workspace_pending_interaction_links (
             interaction_id, session_id, workflow_id, run_id, target_kind,
             target_id, rendered_snapshot_json, rendered_snapshot_hash,
             target_row_version, status, canonical_result_json, row_version,
             created_at_ms, resolved_at_ms
           ) VALUES (?, ?, ?, ?, 'runtime_wait', ?, ?, ?, ?, 'pending', NULL,
                     1, ?, NULL)`,
        )
        .run(
          input.interactionId,
          input.sessionId,
          input.workflowId,
          input.runId,
          input.waitId,
          canonicalJson(input.renderedSnapshot),
          input.renderedSnapshotHash,
          input.targetRowVersion,
          nowMs,
        );
      this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'pending_interaction',
        sourceKind: 'workspace',
        sourceId: input.interactionId,
        sourceEventSeq: null,
        payload: {
          interaction_id: input.interactionId,
          status: 'pending',
          snapshot: input.renderedSnapshot,
          rendered_snapshot_hash: input.renderedSnapshotHash,
          expected_target_row_version: input.targetRowVersion,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
    });
    return this.getPendingInteraction(input.interactionId);
  }

  getPendingInteraction(interactionId: string): TaskPendingInteractionV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_pending_interaction_links WHERE interaction_id = ?',
      )
      .get(interactionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Task interaction not found',
      );
    }
    return this.mapPendingInteraction(row);
  }

  listPendingInteractions(sessionId: string): TaskPendingInteractionV1[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM task_workspace_pending_interaction_links
            WHERE session_id = ? ORDER BY created_at_ms, interaction_id`,
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((row) => this.mapPendingInteraction(row));
  }

  expireMissingPendingInteractions(input: {
    sessionId: string;
    workflowId: string;
    authoritativeWaitIds: ReadonlySet<string>;
    nowMs?: number;
  }): TaskPendingInteractionV1[] {
    const missing = this.listPendingInteractions(input.sessionId).filter(
      (interaction) =>
        interaction.workflow_id === input.workflowId &&
        interaction.status === 'pending' &&
        !input.authoritativeWaitIds.has(interaction.target_id),
    );
    return missing.map((interaction) =>
      this.resolvePendingInteraction({
        interactionId: interaction.interaction_id,
        status: 'expired',
        canonicalResult: {
          format: 'icarus.task-interaction-result/1',
          disposition: 'expired',
          reason: 'runtime_wait_no_longer_pending',
        },
        actorKind: 'system',
        actorRef: 'workflow-runtime',
        nowMs: input.nowMs,
      }),
    );
  }

  private mapPendingInteraction(
    row: Record<string, unknown>,
  ): TaskPendingInteractionV1 {
    return {
      format: 'icarus.task-pending-interaction/1',
      interaction_id: String(row.interaction_id),
      session_id: String(row.session_id),
      workflow_id: row.workflow_id === null ? null : String(row.workflow_id),
      run_id: row.run_id === null ? null : String(row.run_id),
      target_kind: 'runtime_wait',
      target_id: String(row.target_id),
      rendered_snapshot_json: parseJson(String(row.rendered_snapshot_json)),
      rendered_snapshot_hash: row.rendered_snapshot_hash as Sha256Hash,
      target_row_version: Number(row.target_row_version),
      status: row.status as TaskPendingInteractionV1['status'],
      canonical_result_json:
        row.canonical_result_json === null
          ? null
          : parseJson(String(row.canonical_result_json)),
      row_version: Number(row.row_version),
      created_at_ms: Number(row.created_at_ms),
      resolved_at_ms:
        row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
    };
  }

  resolvePendingInteraction(input: {
    interactionId: string;
    status: Exclude<TaskPendingInteractionV1['status'], 'pending'>;
    canonicalResult: JsonObject;
    actorKind?: 'human' | 'system' | 'automation' | 'feature_service';
    actorRef: string;
    nowMs?: number;
  }): TaskPendingInteractionV1 {
    const current = this.getPendingInteraction(input.interactionId);
    if (current.status !== 'pending') return current;
    const nowMs = input.nowMs ?? Date.now();
    const changed = this.transaction(() => {
      const count = this.database
        .prepare(
          `UPDATE task_workspace_pending_interaction_links
              SET status = ?, canonical_result_json = ?, resolved_at_ms = ?,
                  row_version = row_version + 1
            WHERE interaction_id = ? AND status = 'pending'
              AND row_version = ?`,
        )
        .run(
          input.status,
          canonicalJson(input.canonicalResult),
          nowMs,
          input.interactionId,
          current.row_version,
        ).changes;
      if (count === 1) {
        this.insertTimeline({
          sessionId: current.session_id,
          kind: 'pending_interaction',
          sourceKind: 'workspace',
          sourceId: `${current.interaction_id}:resolved`,
          sourceEventSeq: null,
          payload: {
            interaction_id: current.interaction_id,
            status: input.status,
            canonical_result: input.canonicalResult,
          },
          occurredAtMs: nowMs,
          createdAtMs: nowMs,
        });
        this.audit({
          sessionId: current.session_id,
          actorKind: input.actorKind ?? 'human',
          actorRef: input.actorRef,
          action: 'interaction_resolved',
          targetRef: current.interaction_id,
          detail: {
            status: input.status,
            target_kind: current.target_kind,
            target_id: current.target_id,
          },
          nowMs,
        });
      }
      return count;
    });
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Task interaction resolution CAS failed',
      );
    }
    return this.getPendingInteraction(input.interactionId);
  }

  findIdempotency(input: {
    domain: string;
    key: string;
    requestHash: Sha256Hash;
  }): JsonObject | null {
    const existing = this.database
      .prepare(
        `SELECT request_hash, response_json FROM task_workspace_idempotency_records
          WHERE domain = ? AND idempotency_key = ?`,
      )
      .get(input.domain, input.key) as
      | { request_hash: Sha256Hash; response_json: string }
      | undefined;
    if (!existing) return null;
    if (existing.request_hash !== input.requestHash) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Idempotency key binds a different request',
      );
    }
    return parseJson(existing.response_json);
  }

  createCommandProposal(input: {
    sessionId: string;
    workflowId: string;
    runId: string;
    action: TaskRuntimeCommandAction;
    expectedTargetRowVersion: number;
    idempotencyKey: string;
    nowMs?: number;
  }): TaskRuntimeCommandProposalV1 {
    if (
      !['pause', 'resume', 'cancel'].includes(input.action) ||
      !Number.isSafeInteger(input.expectedTargetRowVersion) ||
      input.expectedTargetRowVersion < 1
    ) {
      throw new TaskWorkspaceStoreError(
        'invalid_input',
        'Runtime command proposal is invalid',
      );
    }
    assertText(input.runId, 'Runtime command Run ID', 512);
    assertText(input.idempotencyKey, 'idempotency key', 512);
    const command: JsonObject = {
      format: 'icarus.task-runtime-command-intent/1',
      run_id: input.runId,
      action: input.action,
      expected_target_row_version: input.expectedTargetRowVersion,
    };
    const commandHash = hash('command-proposal', {
      session_id: input.sessionId,
      workflow_id: input.workflowId,
      command,
    });
    const existing = this.database
      .prepare(
        'SELECT * FROM task_workspace_runtime_command_proposals WHERE idempotency_key = ?',
      )
      .get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (
        existing.session_id !== input.sessionId ||
        existing.workflow_id !== input.workflowId ||
        existing.command_hash !== commandHash
      ) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Runtime command idempotency key binds a different proposal',
        );
      }
      return this.commandProposal(existing);
    }
    const nowMs = input.nowMs ?? Date.now();
    const proposalId = id('command-proposal');
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_workspace_runtime_command_proposals
            (proposal_id, session_id, workflow_id, command_json, command_hash,
             status, receipt_json, idempotency_key, created_at_ms, updated_at_ms,
             row_version)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, 1)`,
        )
        .run(
          proposalId,
          input.sessionId,
          input.workflowId,
          canonicalJson(command),
          commandHash,
          input.idempotencyKey,
          nowMs,
          nowMs,
        );
      this.insertTimeline({
        sessionId: input.sessionId,
        kind: 'pending_interaction',
        sourceKind: 'workspace',
        sourceId: proposalId,
        sourceEventSeq: null,
        payload: {
          interaction_kind: 'runtime_command_confirmation',
          proposal_id: proposalId,
          workflow_id: input.workflowId,
          run_id: input.runId,
          action: input.action,
          expected_target_row_version: input.expectedTargetRowVersion,
          proposal_hash: commandHash,
        },
        occurredAtMs: nowMs,
        createdAtMs: nowMs,
      });
    });
    return this.getCommandProposal(proposalId);
  }

  getCommandProposal(proposalId: string): TaskRuntimeCommandProposalV1 {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_runtime_command_proposals WHERE proposal_id = ?',
      )
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Command proposal not found',
      );
    }
    return this.commandProposal(row);
  }

  private commandProposal(
    row: Record<string, unknown>,
  ): TaskRuntimeCommandProposalV1 {
    const command = parseJson<JsonObject>(String(row.command_json));
    return {
      format: 'icarus.task-runtime-command-proposal/1',
      proposal_id: String(row.proposal_id),
      session_id: String(row.session_id),
      workflow_id: String(row.workflow_id),
      run_id: String(command.run_id),
      action: command.action as TaskRuntimeCommandAction,
      expected_target_row_version: Number(command.expected_target_row_version),
      proposal_hash: row.command_hash as Sha256Hash,
      status: row.status as TaskRuntimeCommandProposalV1['status'],
      canonical_receipt:
        row.receipt_json === null ? null : parseJson(String(row.receipt_json)),
      idempotency_key: String(row.idempotency_key),
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      row_version: Number(row.row_version),
    };
  }

  beginCommandApplication(input: {
    proposalId: string;
    expectedRowVersion: number;
    expectedProposalHash: Sha256Hash;
    nowMs?: number;
  }): TaskRuntimeCommandProposalV1 {
    const current = this.getCommandProposal(input.proposalId);
    if (
      current.proposal_hash !== input.expectedProposalHash ||
      current.status !== 'pending' ||
      current.canonical_receipt !== null
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Runtime command confirmation is stale or already claimed',
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_runtime_command_proposals
            SET receipt_json = ?, updated_at_ms = ?, row_version = row_version + 1
          WHERE proposal_id = ? AND status = 'pending' AND receipt_json IS NULL
            AND row_version = ? AND command_hash = ?`,
      )
      .run(
        canonicalJson({
          format: 'icarus.task-runtime-command-application/1',
          phase: 'applying',
          proposal_hash: input.expectedProposalHash,
        }),
        input.nowMs ?? Date.now(),
        input.proposalId,
        input.expectedRowVersion,
        input.expectedProposalHash,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Runtime command confirmation CAS failed',
      );
    }
    return this.getCommandProposal(input.proposalId);
  }

  listApplyingCommandProposals(): TaskRuntimeCommandProposalV1[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM task_workspace_runtime_command_proposals
            WHERE status = 'pending'
              AND json_extract(receipt_json, '$.phase') = 'applying'
            ORDER BY updated_at_ms, proposal_id COLLATE BINARY`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => this.commandProposal(row));
  }

  resolveCommandProposal(input: {
    proposalId: string;
    expectedRowVersion: number;
    status: 'applied' | 'failed' | 'cancelled';
    receipt: JsonObject | null;
    nowMs?: number;
    actorRef?: string;
  }): TaskRuntimeCommandProposalV1 {
    const current = this.getCommandProposal(input.proposalId);
    const nowMs = input.nowMs ?? Date.now();
    const changed = this.transaction(() => {
      const count = this.database
        .prepare(
          `UPDATE task_workspace_runtime_command_proposals
              SET status = ?, receipt_json = ?, updated_at_ms = ?,
                  row_version = row_version + 1
            WHERE proposal_id = ? AND status = 'pending' AND row_version = ?`,
        )
        .run(
          input.status,
          input.receipt ? canonicalJson(input.receipt) : null,
          nowMs,
          input.proposalId,
          input.expectedRowVersion,
        ).changes;
      if (count === 1) {
        this.insertTimeline({
          sessionId: current.session_id,
          kind: 'command_result',
          sourceKind: 'workspace',
          sourceId: current.proposal_id,
          sourceEventSeq: null,
          payload: {
            proposal_id: current.proposal_id,
            workflow_id: current.workflow_id,
            run_id: current.run_id,
            action: current.action,
            status: input.status,
            receipt: input.receipt,
          },
          occurredAtMs: nowMs,
          createdAtMs: nowMs,
        });
        this.audit({
          sessionId: current.session_id,
          actorKind: 'human',
          actorRef: input.actorRef ?? 'human:local-owner',
          action: 'runtime_command_resolved',
          targetRef: current.proposal_id,
          detail: {
            workflow_id: current.workflow_id,
            run_id: current.run_id,
            command_action: current.action,
            status: input.status,
          },
          nowMs,
        });
      }
      return count;
    });
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Command proposal CAS failed',
      );
    }
    return this.getCommandProposal(input.proposalId);
  }

  createReplanRequest(input: {
    sessionId: string;
    sourceWorkflowId: string;
    sourceActivationId?: string | null;
    sourceRunId: string;
    sourceFrontier: JsonObject;
    sourceFrontierHash?: Sha256Hash;
    proposal: JsonObject;
    proposalHash?: Sha256Hash;
    idempotencyKey: string;
    nowMs?: number;
  }): JsonObject {
    assertText(input.sessionId, 'sessionId');
    assertText(input.sourceWorkflowId, 'sourceWorkflowId');
    if (
      input.sourceActivationId !== null &&
      input.sourceActivationId !== undefined
    ) {
      assertText(input.sourceActivationId, 'sourceActivationId');
    }
    assertText(input.sourceRunId, 'sourceRunId');
    assertText(input.idempotencyKey, 'idempotencyKey');
    const nowMs = input.nowMs ?? Date.now();
    const replanId = id('replan');
    const sourceFrontierHash =
      input.sourceFrontierHash ??
      hash('replan-source-frontier', input.sourceFrontier);
    const proposalHash =
      input.proposalHash ?? hash('replan-proposal', input.proposal);
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          'SELECT replan_id FROM task_workspace_replan_requests WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey) as { replan_id: string } | undefined;
      if (existing) {
        const prior = this.getReplanRequest(existing.replan_id);
        if (
          prior.session_id !== input.sessionId ||
          prior.source_workflow_id !== input.sourceWorkflowId ||
          prior.source_activation_id !== (input.sourceActivationId ?? null) ||
          prior.source_run_id !== input.sourceRunId ||
          prior.source_frontier_hash !== sourceFrontierHash ||
          prior.proposal_hash !== proposalHash ||
          canonicalJson(prior.source_frontier) !==
            canonicalJson(input.sourceFrontier) ||
          canonicalJson(prior.proposal) !== canonicalJson(input.proposal)
        ) {
          throw new TaskWorkspaceStoreError(
            'conflict',
            'Replan idempotency key is already bound to a different proposal or source frontier',
          );
        }
        return prior;
      }
      this.database
        .prepare(
          `INSERT INTO task_workspace_replan_requests
            (replan_id, session_id, source_workflow_id, source_activation_id,
             source_run_id, source_frontier_json, source_frontier_hash,
             proposal_json, proposal_hash, status, confirmation_ref,
             confirmation_hash, source_fence_receipt_json,
             target_activation_id, target_run_id, canonical_receipt_json,
             last_error_code, idempotency_key, created_at_ms, updated_at_ms,
             row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 1)`,
        )
        .run(
          replanId,
          input.sessionId,
          input.sourceWorkflowId,
          input.sourceActivationId ?? null,
          input.sourceRunId,
          canonicalJson(input.sourceFrontier),
          sourceFrontierHash,
          canonicalJson(input.proposal),
          proposalHash,
          input.idempotencyKey,
          nowMs,
          nowMs,
        );
      return this.getReplanRequest(replanId);
    });
  }

  getReplanRequest(replanId: string): JsonObject {
    const row = this.database
      .prepare(
        'SELECT * FROM task_workspace_replan_requests WHERE replan_id = ?',
      )
      .get(replanId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Replan request not found',
      );
    }
    return {
      replan_id: String(row.replan_id),
      session_id: String(row.session_id),
      source_workflow_id: String(row.source_workflow_id),
      source_activation_id:
        row.source_activation_id === null
          ? null
          : String(row.source_activation_id),
      source_run_id: String(row.source_run_id),
      source_frontier: parseJson(String(row.source_frontier_json)),
      source_frontier_hash: String(row.source_frontier_hash),
      proposal: parseJson(String(row.proposal_json)),
      proposal_hash: String(row.proposal_hash),
      status: String(row.status),
      confirmation_ref:
        row.confirmation_ref === null ? null : String(row.confirmation_ref),
      confirmation_hash:
        row.confirmation_hash === null ? null : String(row.confirmation_hash),
      source_fence_receipt:
        row.source_fence_receipt_json === null
          ? null
          : parseJson(String(row.source_fence_receipt_json)),
      target_activation_id:
        row.target_activation_id === null
          ? null
          : String(row.target_activation_id),
      target_run_id:
        row.target_run_id === null ? null : String(row.target_run_id),
      canonical_receipt:
        row.canonical_receipt_json === null
          ? null
          : parseJson(String(row.canonical_receipt_json)),
      last_error_code:
        row.last_error_code === null ? null : String(row.last_error_code),
      idempotency_key: String(row.idempotency_key),
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      row_version: Number(row.row_version),
    };
  }

  listReplanRequests(sessionId: string): JsonObject[] {
    return (
      this.database
        .prepare(
          `SELECT replan_id FROM task_workspace_replan_requests
            WHERE session_id = ?
            ORDER BY updated_at_ms DESC, replan_id COLLATE BINARY`,
        )
        .all(sessionId) as Array<{ replan_id: string }>
    ).map((row) => this.getReplanRequest(row.replan_id));
  }

  findReplanRequestByIdempotencyKey(idempotencyKey: string): JsonObject | null {
    const row = this.database
      .prepare(
        'SELECT replan_id FROM task_workspace_replan_requests WHERE idempotency_key = ?',
      )
      .get(idempotencyKey) as { replan_id: string } | undefined;
    return row ? this.getReplanRequest(row.replan_id) : null;
  }

  beginReplanApplication(input: {
    replanId: string;
    expectedRowVersion: number;
    expectedProposalHash: Sha256Hash;
    confirmationRef: string;
    confirmationHash: Sha256Hash;
    nowMs?: number;
  }): JsonObject {
    const current = this.getReplanRequest(input.replanId);
    if (current.proposal_hash !== input.expectedProposalHash) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan proposal hash does not match the persisted proposal',
      );
    }
    assertText(input.confirmationRef, 'confirmationRef');
    if (
      current.confirmation_hash !== null ||
      current.confirmation_ref !== null
    ) {
      if (
        current.confirmation_ref === input.confirmationRef &&
        current.confirmation_hash === input.confirmationHash &&
        ['applying', 'applied', 'failed'].includes(String(current.status))
      ) {
        return current;
      }
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan request is already bound to a different confirmation',
      );
    }
    const nowMs = input.nowMs ?? Date.now();
    const canonicalReceipt: JsonObject = {
      phase: 'applying',
      source_workflow_id: current.source_workflow_id ?? null,
      source_run_id: current.source_run_id ?? null,
      proposal_hash: input.expectedProposalHash,
      confirmation_ref: input.confirmationRef,
      confirmation_hash: input.confirmationHash,
    };
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_replan_requests
            SET status = 'applying', confirmation_ref = ?, confirmation_hash = ?,
                canonical_receipt_json = ?, last_error_code = NULL,
                updated_at_ms = ?,
                row_version = row_version + 1
          WHERE replan_id = ? AND status = 'awaiting_confirmation'
            AND row_version = ? AND proposal_hash = ?
            AND confirmation_ref IS NULL AND confirmation_hash IS NULL`,
      )
      .run(
        input.confirmationRef,
        input.confirmationHash,
        canonicalJson(canonicalReceipt),
        nowMs,
        input.replanId,
        input.expectedRowVersion,
        input.expectedProposalHash,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan application confirmation CAS failed',
      );
    }
    return this.getReplanRequest(input.replanId);
  }

  listApplyingReplans(): JsonObject[] {
    return (
      this.database
        .prepare(
          `SELECT replan_id
             FROM task_workspace_replan_requests
            WHERE status = 'applying'
            ORDER BY updated_at_ms, replan_id COLLATE BINARY`,
        )
        .all() as Array<{ replan_id: string }>
    ).map((row) => this.getReplanRequest(row.replan_id));
  }

  updateReplanApplication(input: {
    replanId: string;
    expectedRowVersion: number;
    expectedProposalHash: Sha256Hash;
    expectedConfirmationRef: string;
    expectedConfirmationHash: Sha256Hash;
    sourceActivationId?: string | null;
    sourceFenceReceipt?: JsonObject | null;
    targetActivationId?: string | null;
    targetRunId?: string | null;
    canonicalReceipt: JsonObject;
    lastErrorCode?: string | null;
    nowMs?: number;
  }): JsonObject {
    const current = this.getReplanRequest(input.replanId);
    if (
      current.proposal_hash !== input.expectedProposalHash ||
      current.confirmation_ref !== input.expectedConfirmationRef ||
      current.confirmation_hash !== input.expectedConfirmationHash
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan application identity does not match its proposal and confirmation',
      );
    }
    const sourceActivationId =
      input.sourceActivationId === undefined
        ? (current.source_activation_id as string | null)
        : input.sourceActivationId;
    const targetActivationId =
      input.targetActivationId === undefined
        ? (current.target_activation_id as string | null)
        : input.targetActivationId;
    const targetRunId =
      input.targetRunId === undefined
        ? (current.target_run_id as string | null)
        : input.targetRunId;
    const sourceFenceReceipt =
      input.sourceFenceReceipt === undefined
        ? (current.source_fence_receipt as JsonObject | null)
        : input.sourceFenceReceipt;
    const lastErrorCode =
      input.lastErrorCode === undefined
        ? (current.last_error_code as string | null)
        : input.lastErrorCode;
    if (
      current.source_fence_receipt !== null &&
      (sourceFenceReceipt === null ||
        canonicalJson(current.source_fence_receipt) !==
          canonicalJson(sourceFenceReceipt))
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan source fence receipt cannot be replaced once recorded',
      );
    }
    for (const [label, prior, next] of [
      ['source Activation', current.source_activation_id, sourceActivationId],
      ['target Activation', current.target_activation_id, targetActivationId],
      ['target Run', current.target_run_id, targetRunId],
    ] as const) {
      if (prior !== null && prior !== next) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          `Replan ${label} lineage cannot be replaced once recorded`,
        );
      }
    }
    if (targetRunId !== null && targetActivationId === null) {
      throw new TaskWorkspaceStoreError(
        'invalid_input',
        'A target Run requires its target Activation lineage',
      );
    }
    const receiptJson = canonicalJson(input.canonicalReceipt);
    if (
      current.status === 'applying' &&
      current.source_activation_id === sourceActivationId &&
      current.target_activation_id === targetActivationId &&
      current.target_run_id === targetRunId &&
      ((current.source_fence_receipt === null && sourceFenceReceipt === null) ||
        (current.source_fence_receipt !== null &&
          sourceFenceReceipt !== null &&
          canonicalJson(current.source_fence_receipt) ===
            canonicalJson(sourceFenceReceipt))) &&
      current.last_error_code === lastErrorCode &&
      current.canonical_receipt !== null &&
      canonicalJson(current.canonical_receipt) === receiptJson
    ) {
      return current;
    }
    if (current.status !== 'applying') {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Only an applying replan can record application progress',
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_replan_requests
            SET source_activation_id = ?, source_fence_receipt_json = ?,
                target_activation_id = ?, target_run_id = ?,
                canonical_receipt_json = ?,
                last_error_code = ?, updated_at_ms = ?,
                row_version = row_version + 1
          WHERE replan_id = ? AND status = 'applying' AND row_version = ?
            AND proposal_hash = ? AND confirmation_ref = ?
            AND confirmation_hash = ?`,
      )
      .run(
        sourceActivationId,
        sourceFenceReceipt === null ? null : canonicalJson(sourceFenceReceipt),
        targetActivationId,
        targetRunId,
        receiptJson,
        lastErrorCode,
        input.nowMs ?? Date.now(),
        input.replanId,
        input.expectedRowVersion,
        input.expectedProposalHash,
        input.expectedConfirmationRef,
        input.expectedConfirmationHash,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan application progress CAS failed',
      );
    }
    return this.getReplanRequest(input.replanId);
  }

  resolveReplanApplication(input: {
    replanId: string;
    expectedRowVersion: number;
    expectedProposalHash: Sha256Hash;
    expectedConfirmationRef: string;
    expectedConfirmationHash: Sha256Hash;
    status: 'applied' | 'failed';
    canonicalReceipt: JsonObject;
    lastErrorCode?: string | null;
    nowMs?: number;
  }): JsonObject {
    const current = this.getReplanRequest(input.replanId);
    if (
      current.proposal_hash !== input.expectedProposalHash ||
      current.confirmation_ref !== input.expectedConfirmationRef ||
      current.confirmation_hash !== input.expectedConfirmationHash
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan terminal result does not match its proposal and confirmation',
      );
    }
    const lastErrorCode = input.lastErrorCode ?? null;
    if (
      input.status === 'applied' &&
      (current.target_activation_id === null || current.target_run_id === null)
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'A replan cannot resolve as applied before its target Activation and Run are recorded',
      );
    }
    if (input.status === 'failed' && lastErrorCode === null) {
      throw new TaskWorkspaceStoreError(
        'invalid_input',
        'A failed replan requires a lastErrorCode',
      );
    }
    const receiptJson = canonicalJson(input.canonicalReceipt);
    if (
      current.status === input.status &&
      current.last_error_code === lastErrorCode &&
      current.canonical_receipt !== null &&
      canonicalJson(current.canonical_receipt) === receiptJson
    ) {
      return current;
    }
    if (current.status !== 'applying') {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Only an applying replan can resolve its application result',
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_replan_requests
            SET status = ?, canonical_receipt_json = ?, last_error_code = ?,
                updated_at_ms = ?, row_version = row_version + 1
          WHERE replan_id = ? AND status = 'applying' AND row_version = ?
            AND proposal_hash = ? AND confirmation_ref = ?
            AND confirmation_hash = ?`,
      )
      .run(
        input.status,
        receiptJson,
        lastErrorCode,
        input.nowMs ?? Date.now(),
        input.replanId,
        input.expectedRowVersion,
        input.expectedProposalHash,
        input.expectedConfirmationRef,
        input.expectedConfirmationHash,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan application resolution CAS failed',
      );
    }
    return this.getReplanRequest(input.replanId);
  }

  cancelReplanRequest(input: {
    replanId: string;
    expectedRowVersion: number;
    expectedProposalHash: Sha256Hash;
    nowMs?: number;
  }): JsonObject {
    const current = this.getReplanRequest(input.replanId);
    if (current.proposal_hash !== input.expectedProposalHash) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan cancellation does not match the persisted proposal',
      );
    }
    if (current.status === 'cancelled') return current;
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_replan_requests
            SET status = 'cancelled', updated_at_ms = ?,
                row_version = row_version + 1
          WHERE replan_id = ? AND status = 'awaiting_confirmation'
            AND row_version = ? AND proposal_hash = ?
            AND confirmation_ref IS NULL AND confirmation_hash IS NULL`,
      )
      .run(
        input.nowMs ?? Date.now(),
        input.replanId,
        input.expectedRowVersion,
        input.expectedProposalHash,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Replan cancellation CAS failed',
      );
    }
    return this.getReplanRequest(input.replanId);
  }

  createPersonalWorkflowDraft(input: {
    ownerPrincipalRef: string;
    sourceSessionId: string;
    sourceWorkflowId: string;
    sourceRunId: string;
    personalWorkflowId?: string;
    source: JsonObject;
    sourceHash: Sha256Hash;
    compiledPlan: JsonObject;
    compiledPlanHash: Sha256Hash;
    compilerVersion: string;
    resourceClosureHash: Sha256Hash;
    policyCeilingHash: Sha256Hash;
    riskSummary: JsonObject;
    nowMs?: number;
  }): JsonObject {
    const nowMs = input.nowMs ?? Date.now();
    const draftId = id('personal-workflow-draft');
    const personalWorkflowId = input.personalWorkflowId ?? draftId;
    const revisionId = id('personal-workflow-revision');
    const sanitized = sanitizePersonalWorkflowSource(input.source);
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_workspace_personal_workflow_drafts
            (draft_id, personal_workflow_id, owner_principal_ref,
             source_session_id, source_workflow_id, source_run_id,
             current_revision_id, status, review_json, release_id,
             release_hash, pointer_row_version, pending_operation_key,
             last_error_code, created_at_ms, updated_at_ms, row_version)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'draft', NULL, NULL, NULL, NULL,
                   NULL, NULL, ?, ?, 1)`,
        )
        .run(
          draftId,
          personalWorkflowId,
          input.ownerPrincipalRef,
          input.sourceSessionId,
          input.sourceWorkflowId,
          input.sourceRunId,
          nowMs,
          nowMs,
        );
      this.insertPersonalWorkflowRevision({
        revisionId,
        draftId,
        revisionNo: 1,
        parentRevisionId: null,
        source: sanitized,
        sourceHash: input.sourceHash,
        compiledPlan: input.compiledPlan,
        compiledPlanHash: input.compiledPlanHash,
        compilerVersion: input.compilerVersion,
        resourceClosureHash: input.resourceClosureHash,
        policyCeilingHash: input.policyCeilingHash,
        riskSummary: input.riskSummary,
        nowMs,
      });
      this.database
        .prepare(
          `UPDATE task_workspace_personal_workflow_drafts
              SET current_revision_id = ? WHERE draft_id = ?`,
        )
        .run(revisionId, draftId);
    });
    return this.getPersonalWorkflowDraft(draftId, input.ownerPrincipalRef);
  }

  private insertPersonalWorkflowRevision(input: {
    revisionId: string;
    draftId: string;
    revisionNo: number;
    parentRevisionId: string | null;
    source: JsonObject;
    sourceHash: Sha256Hash;
    compiledPlan: JsonObject;
    compiledPlanHash: Sha256Hash;
    compilerVersion: string;
    resourceClosureHash: Sha256Hash;
    policyCeilingHash: Sha256Hash;
    riskSummary: JsonObject;
    nowMs: number;
  }): void {
    this.database
      .prepare(
        `INSERT INTO task_workspace_personal_workflow_draft_revisions
          (revision_id, draft_id, revision_no, parent_revision_id, source_json,
           source_hash, compiled_plan_json, compiled_plan_hash,
           compiler_version, resource_closure_hash, policy_ceiling_hash,
           risk_summary_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.revisionId,
        input.draftId,
        input.revisionNo,
        input.parentRevisionId,
        canonicalJson(input.source),
        input.sourceHash,
        canonicalJson(input.compiledPlan),
        input.compiledPlanHash,
        input.compilerVersion,
        input.resourceClosureHash,
        input.policyCeilingHash,
        canonicalJson(input.riskSummary),
        input.nowMs,
      );
  }

  getPersonalWorkflowRevision(revisionId: string): JsonObject {
    const row = this.database
      .prepare(
        `SELECT * FROM task_workspace_personal_workflow_draft_revisions
          WHERE revision_id = ?`,
      )
      .get(revisionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Personal Workflow draft revision not found',
      );
    }
    return {
      format: 'icarus.personal-workflow-draft-revision/1',
      revision_id: String(row.revision_id),
      draft_id: String(row.draft_id),
      revision_no: Number(row.revision_no),
      parent_revision_id:
        row.parent_revision_id === null ? null : String(row.parent_revision_id),
      source: parseJson(String(row.source_json)),
      source_hash: String(row.source_hash),
      compiled_plan: parseJson(String(row.compiled_plan_json)),
      compiled_plan_hash: String(row.compiled_plan_hash),
      compiler_version: String(row.compiler_version),
      resource_closure_hash: String(row.resource_closure_hash),
      policy_ceiling_hash: String(row.policy_ceiling_hash),
      risk_summary: parseJson(String(row.risk_summary_json)),
      created_at_ms: Number(row.created_at_ms),
    };
  }

  getPersonalWorkflowDraft(draftId: string, principalRef: string): JsonObject {
    const row = this.database
      .prepare(
        `SELECT * FROM task_workspace_personal_workflow_drafts
          WHERE draft_id = ? AND owner_principal_ref = ?`,
      )
      .get(draftId, principalRef) as Record<string, unknown> | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Personal Workflow draft not found',
      );
    }
    const revision = this.getPersonalWorkflowRevision(
      String(row.current_revision_id),
    );
    return {
      draft_id: String(row.draft_id),
      personal_workflow_id: String(row.personal_workflow_id),
      owner_principal_ref: String(row.owner_principal_ref),
      source_session_id: String(row.source_session_id),
      source_workflow_id: String(row.source_workflow_id),
      source_run_id: String(row.source_run_id),
      current_revision_id: String(row.current_revision_id),
      revision,
      source: revision.source as JsonObject,
      source_hash: String(revision.source_hash),
      compiled_plan: revision.compiled_plan as JsonObject,
      compiled_plan_hash: String(revision.compiled_plan_hash),
      compiler_version: String(revision.compiler_version),
      resource_closure_hash: String(revision.resource_closure_hash),
      policy_ceiling_hash: String(revision.policy_ceiling_hash),
      risk_summary: revision.risk_summary as JsonObject,
      status: String(row.status),
      review:
        row.review_json === null ? null : parseJson(String(row.review_json)),
      release_id: row.release_id === null ? null : String(row.release_id),
      release_hash: row.release_hash === null ? null : String(row.release_hash),
      pointer_row_version:
        row.pointer_row_version === null
          ? null
          : Number(row.pointer_row_version),
      pending_operation_key:
        row.pending_operation_key === null
          ? null
          : String(row.pending_operation_key),
      last_error_code:
        row.last_error_code === null ? null : String(row.last_error_code),
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
      row_version: Number(row.row_version),
    };
  }

  revisePersonalWorkflowDraft(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    source: JsonObject;
    sourceHash: Sha256Hash;
    compiledPlan: JsonObject;
    compiledPlanHash: Sha256Hash;
    compilerVersion: string;
    resourceClosureHash: Sha256Hash;
    policyCeilingHash: Sha256Hash;
    riskSummary: JsonObject;
    nowMs?: number;
  }): JsonObject {
    const current = this.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    if (
      Number(current.row_version) !== input.expectedRowVersion ||
      ['publishing', 'activating'].includes(String(current.status))
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Personal Workflow draft revision is stale or an operation is in flight',
      );
    }
    const source = sanitizePersonalWorkflowSource(input.source);
    const nowMs = input.nowMs ?? Date.now();
    const revisionId = id('personal-workflow-revision');
    const revisionNo = Number((current.revision as JsonObject).revision_no) + 1;
    this.transaction(() => {
      this.insertPersonalWorkflowRevision({
        revisionId,
        draftId: input.draftId,
        revisionNo,
        parentRevisionId: String(current.current_revision_id),
        source,
        sourceHash: input.sourceHash,
        compiledPlan: input.compiledPlan,
        compiledPlanHash: input.compiledPlanHash,
        compilerVersion: input.compilerVersion,
        resourceClosureHash: input.resourceClosureHash,
        policyCeilingHash: input.policyCeilingHash,
        riskSummary: input.riskSummary,
        nowMs,
      });
      const changed = this.database
        .prepare(
          `UPDATE task_workspace_personal_workflow_drafts
              SET current_revision_id = ?, status = 'draft', review_json = NULL,
                  pending_operation_key = NULL, last_error_code = NULL,
                  updated_at_ms = ?, row_version = row_version + 1
            WHERE draft_id = ? AND owner_principal_ref = ? AND row_version = ?`,
        )
        .run(
          revisionId,
          nowMs,
          input.draftId,
          input.principalRef,
          input.expectedRowVersion,
        ).changes;
      if (changed !== 1) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Personal Workflow draft revision CAS failed',
        );
      }
    });
    return this.getPersonalWorkflowDraft(input.draftId, input.principalRef);
  }

  listPersonalWorkflowDrafts(principalRef: string): JsonObject[] {
    return (
      this.database
        .prepare(
          `SELECT draft_id FROM task_workspace_personal_workflow_drafts
            WHERE owner_principal_ref = ? ORDER BY updated_at_ms DESC`,
        )
        .all(principalRef) as Array<{ draft_id: string }>
    ).map((row) => this.getPersonalWorkflowDraft(row.draft_id, principalRef));
  }

  advancePersonalWorkflowDraft(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    status:
      | 'validated'
      | 'dry_run_passed'
      | 'reviewed'
      | 'publishing'
      | 'published'
      | 'activating'
      | 'active'
      | 'failed';
    review?: JsonObject | null;
    releaseId?: string | null;
    nowMs?: number;
  }): JsonObject {
    const current = this.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    const expected: Record<string, string[]> = {
      draft: ['validated', 'failed'],
      validated: ['dry_run_passed', 'failed'],
      dry_run_passed: ['reviewed', 'failed'],
      reviewed: ['publishing', 'failed'],
      publishing: ['published', 'failed'],
      published: ['activating', 'failed'],
      activating: ['active', 'failed'],
      active: [],
      failed: ['validated'],
    };
    if (
      Number(current.row_version) !== input.expectedRowVersion ||
      !expected[String(current.status)]?.includes(input.status)
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Personal Workflow draft transition is stale or invalid',
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_personal_workflow_drafts
            SET status = ?, review_json = COALESCE(?, review_json),
                release_id = COALESCE(?, release_id), updated_at_ms = ?,
                row_version = row_version + 1
          WHERE draft_id = ? AND owner_principal_ref = ? AND row_version = ?`,
      )
      .run(
        input.status,
        input.review ? canonicalJson(input.review) : null,
        input.releaseId ?? null,
        input.nowMs ?? Date.now(),
        input.draftId,
        input.principalRef,
        input.expectedRowVersion,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Personal Workflow draft CAS failed',
      );
    }
    return this.getPersonalWorkflowDraft(input.draftId, input.principalRef);
  }

  beginPersonalWorkflowOperation(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    operation: 'publish' | 'activate';
    idempotencyKey: string;
    nowMs?: number;
  }): JsonObject {
    assertText(input.idempotencyKey, 'idempotencyKey');
    const current = this.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    const fromStatus = input.operation === 'publish' ? 'reviewed' : 'published';
    const applyingStatus =
      input.operation === 'publish' ? 'publishing' : 'activating';
    if (
      current.status === applyingStatus &&
      current.pending_operation_key === input.idempotencyKey
    ) {
      return current;
    }
    if (
      current.status !== fromStatus ||
      Number(current.row_version) !== input.expectedRowVersion
    ) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        `Personal Workflow ${input.operation} is stale or invalid`,
      );
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_personal_workflow_drafts
            SET status = ?, pending_operation_key = ?, last_error_code = NULL,
                updated_at_ms = ?, row_version = row_version + 1
          WHERE draft_id = ? AND owner_principal_ref = ? AND status = ?
            AND row_version = ? AND pending_operation_key IS NULL`,
      )
      .run(
        applyingStatus,
        input.idempotencyKey,
        input.nowMs ?? Date.now(),
        input.draftId,
        input.principalRef,
        fromStatus,
        input.expectedRowVersion,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        `Personal Workflow ${input.operation} CAS failed`,
      );
    }
    return this.getPersonalWorkflowDraft(input.draftId, input.principalRef);
  }

  listPendingPersonalWorkflowOperations(): JsonObject[] {
    return (
      this.database
        .prepare(
          `SELECT draft_id, owner_principal_ref
             FROM task_workspace_personal_workflow_drafts
            WHERE status IN ('publishing','activating')
            ORDER BY updated_at_ms, draft_id COLLATE BINARY`,
        )
        .all() as Array<{ draft_id: string; owner_principal_ref: string }>
    ).map((row) =>
      this.getPersonalWorkflowDraft(row.draft_id, row.owner_principal_ref),
    );
  }

  resolvePersonalWorkflowPublication(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    expectedOperationKey: string;
    releaseId: string;
    releaseHash: Sha256Hash;
    nowMs?: number;
  }): JsonObject {
    const current = this.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    if (
      current.status === 'published' &&
      current.release_id === input.releaseId &&
      current.release_hash === input.releaseHash
    ) {
      return current;
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_personal_workflow_drafts
            SET status = 'published', release_id = ?, release_hash = ?,
                pending_operation_key = NULL, last_error_code = NULL,
                updated_at_ms = ?, row_version = row_version + 1
          WHERE draft_id = ? AND owner_principal_ref = ?
            AND status = 'publishing' AND row_version = ?
            AND pending_operation_key = ?`,
      )
      .run(
        input.releaseId,
        input.releaseHash,
        input.nowMs ?? Date.now(),
        input.draftId,
        input.principalRef,
        input.expectedRowVersion,
        input.expectedOperationKey,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Personal Workflow publication result CAS failed',
      );
    }
    return this.getPersonalWorkflowDraft(input.draftId, input.principalRef);
  }

  resolvePersonalWorkflowActivation(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    expectedOperationKey: string;
    pointerRowVersion: number;
    nowMs?: number;
  }): JsonObject {
    const current = this.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    if (
      current.status === 'active' &&
      current.pointer_row_version === input.pointerRowVersion
    ) {
      return current;
    }
    const changed = this.database
      .prepare(
        `UPDATE task_workspace_personal_workflow_drafts
            SET status = 'active', pointer_row_version = ?,
                pending_operation_key = NULL, last_error_code = NULL,
                updated_at_ms = ?, row_version = row_version + 1
          WHERE draft_id = ? AND owner_principal_ref = ?
            AND status = 'activating' AND row_version = ?
            AND pending_operation_key = ?`,
      )
      .run(
        input.pointerRowVersion,
        input.nowMs ?? Date.now(),
        input.draftId,
        input.principalRef,
        input.expectedRowVersion,
        input.expectedOperationKey,
      ).changes;
    if (changed !== 1) {
      throw new TaskWorkspaceStoreError(
        'conflict',
        'Personal Workflow activation result CAS failed',
      );
    }
    return this.getPersonalWorkflowDraft(input.draftId, input.principalRef);
  }

  getPersonalWorkflowDraftByRelease(
    releaseId: string,
    principalRef: string,
  ): JsonObject {
    const row = this.database
      .prepare(
        `SELECT draft_id FROM task_workspace_personal_workflow_drafts
          WHERE release_id = ? AND owner_principal_ref = ?`,
      )
      .get(releaseId, principalRef) as { draft_id: string } | undefined;
    if (!row) {
      throw new TaskWorkspaceStoreError(
        'not_found',
        'Personal Workflow release draft not found',
      );
    }
    return this.getPersonalWorkflowDraft(row.draft_id, principalRef);
  }

  putIdempotency(input: {
    domain: string;
    key: string;
    requestHash: Sha256Hash;
    response: JsonObject;
    nowMs?: number;
  }): JsonObject {
    const existing = this.database
      .prepare(
        `SELECT request_hash, response_json FROM task_workspace_idempotency_records
          WHERE domain = ? AND idempotency_key = ?`,
      )
      .get(input.domain, input.key) as
      | { request_hash: Sha256Hash; response_json: string }
      | undefined;
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw new TaskWorkspaceStoreError(
          'conflict',
          'Idempotency key binds a different request',
        );
      }
      return parseJson(existing.response_json);
    }
    this.database
      .prepare(
        `INSERT INTO task_workspace_idempotency_records
          (domain, idempotency_key, request_hash, response_json, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.domain,
        input.key,
        input.requestHash,
        canonicalJson(input.response),
        input.nowMs ?? Date.now(),
      );
    return input.response;
  }

  audit(input: {
    sessionId: string | null;
    actorKind: 'human' | 'system' | 'automation' | 'feature_service';
    actorRef: string;
    action: string;
    targetRef: string | null;
    detail: JsonObject;
    nowMs?: number;
  }): void {
    const detailHash = hash('audit-detail', input.detail);
    this.database
      .prepare(
        `INSERT INTO task_workspace_audit_events
          (audit_id, session_id, actor_kind, actor_ref, action, target_ref,
           detail_json, detail_hash, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('audit'),
        input.sessionId,
        input.actorKind,
        input.actorRef,
        input.action,
        input.targetRef,
        canonicalJson(input.detail),
        detailHash,
        input.nowMs ?? Date.now(),
      );
  }

  integrityCheck(): void {
    const integrity = this.database.pragma('integrity_check', {
      simple: true,
    });
    const foreignKeys = this.database.pragma('foreign_key_check') as unknown[];
    if (integrity !== 'ok' || foreignKeys.length > 0) {
      throw new TaskWorkspaceStoreError(
        'integrity_error',
        'Task Workspace SQLite integrity check failed',
      );
    }
  }
}
