import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';

/** Format a Date to local timezone string (e.g., "2026-03-26 12:05:00") */
function formatLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  AgentQueryEventRecord,
  AgentQueryRecord,
  AgentQuerySourceType,
  AgentQueryStepRecord,
  AskQuestionRecord,
  Delegation,
  MemoryRecord,
  MemorySearchResult,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  StoredChatMessageRecord,
  TodayPlanItemRecord,
  TodayPlanMailDraftRecord,
  TodayPlanRecord,
  WikiClaimEvidenceRecord,
  WikiClaimRecord,
  WikiDraftRecord,
  WikiJobRecord,
  WikiMaterialRecord,
  WikiPageRecord,
  WikiRelationRecord,
  WikiSearchResult,
  WorkbenchActionItemRecord,
  WorkbenchArtifactRecord,
  WorkbenchCommentRecord,
  WorkbenchContextAssetRecord,
  WorkbenchEventRecord,
  WorkbenchSubtaskRecord,
  WorkbenchTaskRecord,
  WorkflowStageEvaluationRecord,
  Workflow,
} from './types.js';
import {
  cloneWorkflowContext,
  mergeWorkflowContext,
  parseWorkflowContext,
  serializeWorkflowContext,
  WorkflowContext,
} from './workflow-context.js';

let db: Database.Database;

function buildWikiSearchAliases(slug: string, title: string): string {
  const aliases = new Set<string>();

  for (const value of [slug, title]) {
    const normalized = value.normalize('NFKC').toLowerCase().trim();
    const parts = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (parts.length < 2) continue;

    aliases.add(parts.join(' '));

    const compact = parts.join('');
    if (compact.length >= 3) {
      aliases.add(compact);
    }
  }

  return Array.from(aliases).join(' ');
}

function registerWikiSearchAliasFunction(database: Database.Database): void {
  database.function(
    'wiki_search_aliases',
    { deterministic: true },
    (slug: unknown, title: unknown) =>
      buildWikiSearchAliases(String(slug || ''), String(title || '')),
  );
}

function ensureWikiPageSearchAliases(database: Database.Database): void {
  const columns = database.pragma('table_info(wiki_pages)') as Array<{
    name: string;
  }>;
  const hasSearchAliases = columns.some(
    (column) => column.name === 'search_aliases',
  );

  if (!hasSearchAliases) {
    database.exec(
      `ALTER TABLE wiki_pages ADD COLUMN search_aliases TEXT NOT NULL DEFAULT ''`,
    );
  }

  database
    .prepare(
      `
        UPDATE wiki_pages
        SET search_aliases = wiki_search_aliases(slug, title)
        WHERE search_aliases != wiki_search_aliases(slug, title)
      `,
    )
    .run();
}

function recreateWikiFtsIfNeeded(database: Database.Database): void {
  const columns = database.pragma('table_info(wiki_pages_fts)') as Array<{
    name: string;
  }>;
  const hasExistingFts = columns.length > 0;
  const hasSearchAliases = columns.some(
    (column) => column.name === 'search_aliases',
  );

  if (!hasExistingFts || hasSearchAliases) return;

  database.exec(`
    DROP TRIGGER IF EXISTS wiki_pages_ai;
    DROP TRIGGER IF EXISTS wiki_pages_ad;
    DROP TRIGGER IF EXISTS wiki_pages_au;
    DROP TABLE IF EXISTS wiki_pages_fts;
  `);
  logger.info('Wiki page FTS schema rebuilt with search aliases');
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      model TEXT,
      model_reason TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      last_query_id TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS agent_queries (
      id TEXT PRIMARY KEY,
      query_id TEXT NOT NULL UNIQUE,
      run_id TEXT,
      source_type TEXT NOT NULL,
      source_ref_id TEXT,
      chat_jid TEXT,
      group_folder TEXT,
      workflow_id TEXT,
      stage_key TEXT,
      delegation_id TEXT,
      session_id TEXT,
      selected_model TEXT,
      selected_model_reason TEXT,
      actual_model TEXT,
      prompt_hash TEXT,
      memory_pack_hash TEXT,
      tools_hash TEXT,
      mounts_hash TEXT,
      status TEXT NOT NULL,
      current_step_id TEXT,
      current_phase TEXT,
      current_action TEXT,
      failure_type TEXT,
      failure_subtype TEXT,
      failure_origin TEXT,
      failure_retryable INTEGER,
      error_message TEXT,
      output_digest TEXT,
      output_preview TEXT,
      first_output_at TEXT,
      first_tool_at TEXT,
      last_event_at TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_queries_started_at
      ON agent_queries(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_queries_group_status
      ON agent_queries(group_folder, status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_queries_workflow
      ON agent_queries(workflow_id, stage_key, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_queries_failure
      ON agent_queries(failure_type, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_queries_source
      ON agent_queries(source_type, source_ref_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_queries_last_event_at
      ON agent_queries(last_event_at DESC);

    CREATE TABLE IF NOT EXISTS agent_query_steps (
      id TEXT PRIMARY KEY,
      query_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      step_name TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      payload_json TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_query_steps_query
      ON agent_query_steps(query_id, step_index);
    CREATE INDEX IF NOT EXISTS idx_agent_query_steps_type
      ON agent_query_steps(step_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_query_events (
      id TEXT PRIMARY KEY,
      query_id TEXT NOT NULL,
      step_id TEXT,
      event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_name TEXT NOT NULL,
      status TEXT,
      summary TEXT,
      payload_json TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_query_events_query
      ON agent_query_events(query_id, event_index);
    CREATE INDEX IF NOT EXISTS idx_agent_query_events_step
      ON agent_query_events(step_id, event_index);
    CREATE INDEX IF NOT EXISTS idx_agent_query_events_type
      ON agent_query_events(event_type, created_at DESC);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_query_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Scheduled task execution history now lives entirely in agent_queries.
  database.exec(`DROP TABLE IF EXISTS task_run_logs`);

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add model column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }

  // Add model_reason column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN model_reason TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add description column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN description TEXT`);
  } catch {
    /* column already exists */
  }

  // Add delegations table if it doesn't exist (migration for existing DBs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      source_jid TEXT NOT NULL,
      source_folder TEXT NOT NULL,
      target_jid TEXT NOT NULL,
      target_folder TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_source ON delegations(source_jid, status);
    CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_jid, status);
  `);

  // Add workflows table if it doesn't exist (migration for existing DBs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      start_from TEXT NOT NULL DEFAULT 'plan',
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'dev',
      current_delegation_id TEXT DEFAULT '',
      round INTEGER DEFAULT 0,
      source_jid TEXT NOT NULL,
      paused_from TEXT,
      workflow_type TEXT DEFAULT 'dev_test',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
    CREATE INDEX IF NOT EXISTS idx_workflows_delegation ON workflows(current_delegation_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workbench_tasks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL UNIQUE,
      source_jid TEXT NOT NULL,
      title TEXT NOT NULL,
      service TEXT NOT NULL,
      start_from TEXT NOT NULL DEFAULT 'plan',
      workflow_type TEXT NOT NULL,
      status TEXT NOT NULL,
      task_state TEXT NOT NULL DEFAULT 'running',
      current_stage TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_tasks_status ON workbench_tasks(status, updated_at);

    CREATE TABLE IF NOT EXISTS workbench_subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      delegation_id TEXT,
      stage_key TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      group_folder TEXT,
      status TEXT NOT NULL,
      input_summary TEXT,
      output_summary TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_subtasks_task ON workbench_subtasks(task_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workbench_subtasks_workflow_stage ON workbench_subtasks(workflow_id, stage_key);

    CREATE TABLE IF NOT EXISTS workbench_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      subtask_id TEXT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      raw_ref_type TEXT,
      raw_ref_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_events_task ON workbench_events(task_id, created_at);

    CREATE TABLE IF NOT EXISTS workbench_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      source_role TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_artifacts_task ON workbench_artifacts(task_id, created_at);

    CREATE TABLE IF NOT EXISTS workbench_action_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      subtask_id TEXT,
      stage_key TEXT,
      delegation_id TEXT,
      group_folder TEXT,
      item_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      source_type TEXT NOT NULL,
      source_ref_id TEXT,
      replyable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_action_items_task ON workbench_action_items(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workbench_action_items_stage ON workbench_action_items(workflow_id, stage_key, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workbench_action_items_source ON workbench_action_items(source_type, source_ref_id);

    CREATE TABLE IF NOT EXISTS workbench_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_comments_task ON workbench_comments(task_id, created_at);

    CREATE TABLE IF NOT EXISTS workbench_context_assets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      url TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workbench_assets_task ON workbench_context_assets(task_id, created_at);

    CREATE TABLE IF NOT EXISTS workflow_stage_evaluations (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      delegation_id TEXT,
      stage_key TEXT NOT NULL,
      evaluator_type TEXT NOT NULL,
      status TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      summary TEXT,
      findings_json TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_stage_evals_workflow_stage
      ON workflow_stage_evaluations(workflow_id, stage_key, updated_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS today_plans (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at TEXT,
      continued_from_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_today_plans_date
      ON today_plans(plan_date DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS today_plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      associations_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_today_plan_items_plan
      ON today_plan_items(plan_id, order_index ASC, created_at ASC);

    CREATE TABLE IF NOT EXISTS today_plan_mail_drafts (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_date TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      to_json TEXT,
      cc_json TEXT,
      bcc_json TEXT,
      attachments_json TEXT,
      status TEXT NOT NULL DEFAULT 'drafting',
      error_message TEXT,
      prepared_at TEXT,
      confirmed_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_today_plan_mail_drafts_plan
      ON today_plan_mail_drafts(plan_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_today_plan_mail_drafts_status
      ON today_plan_mail_drafts(status, updated_at DESC);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_inbox_items (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      priority TEXT NOT NULL DEFAULT 'normal',
      title TEXT NOT NULL,
      body TEXT,
      source_type TEXT NOT NULL,
      source_ref_id TEXT,
      action_kind TEXT,
      action_label TEXT,
      action_url TEXT,
      action_payload_json TEXT,
      created_by TEXT NOT NULL DEFAULT 'assistant',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      due_at TEXT,
      snoozed_until TEXT,
      read_at TEXT,
      resolved_at TEXT,
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_items_status
      ON agent_inbox_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_items_source
      ON agent_inbox_items(source_type, source_ref_id);
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_items_created
      ON agent_inbox_items(created_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_action_logs (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      body TEXT,
      source_type TEXT,
      source_ref_id TEXT,
      payload_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_action_logs_created
      ON assistant_action_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assistant_action_logs_item
      ON assistant_action_logs(item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_chat_messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      workflow_id TEXT,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_chat_messages_chat_time
      ON assistant_chat_messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS assistant_snoozes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      until TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_snoozes_scope
      ON assistant_snoozes(scope, scope_ref, until);
  `);
  database.exec(`
    INSERT OR IGNORE INTO assistant_chat_messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      workflow_id
    )
    SELECT
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      NULL
    FROM messages
    WHERE chat_jid LIKE 'assistant:%';
  `);
  database.exec(`
    DELETE FROM messages
    WHERE chat_jid LIKE 'assistant:%'
      AND is_bot_message = 1;
  `);

  // Add ask_questions table if it doesn't exist (human-in-the-loop questions)
  database.exec(`
    CREATE TABLE IF NOT EXISTS ask_questions (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      answers_json TEXT,
      current_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      answered_at TEXT,
      responder_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ask_questions_status_expires ON ask_questions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_ask_questions_group_status ON ask_questions(group_folder, status);
  `);

  // Add outcome column to delegations (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE delegations ADD COLUMN outcome TEXT`);
  } catch {
    /* column already exists */
  }

  // Add requester_jid column to delegations (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE delegations ADD COLUMN requester_jid TEXT`);
  } catch {
    /* column already exists */
  }

  // Add start_from column to workflows (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE workflows ADD COLUMN start_from TEXT DEFAULT 'plan'`,
    );
  } catch {
    /* column already exists */
  }

  // Add paused_from column to workflows before schema normalization.
  try {
    database.exec(`ALTER TABLE workflows ADD COLUMN paused_from TEXT`);
  } catch {
    /* column already exists */
  }

  // Add workflow_type column to workflows before schema normalization.
  try {
    database.exec(
      `ALTER TABLE workflows ADD COLUMN workflow_type TEXT DEFAULT 'dev_test'`,
    );
  } catch {
    /* column already exists */
  }

  normalizeWorkflowSchema(database);

  try {
    database.exec(
      `ALTER TABLE today_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE today_plans ADD COLUMN completed_at TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE today_plans ADD COLUMN continued_from_plan_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_today_plans_status
       ON today_plans(status, plan_date DESC, updated_at DESC)`,
    );
  } catch {
    /* ignore */
  }

  // Add start_from column to workbench_tasks (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE workbench_tasks ADD COLUMN start_from TEXT DEFAULT 'plan'`,
    );
  } catch {
    /* column already exists */
  }

  // Add persisted task_state to workbench_tasks (migration for existing DBs).
  try {
    database.exec(
      `ALTER TABLE workbench_tasks ADD COLUMN task_state TEXT NOT NULL DEFAULT 'running'`,
    );
  } catch {
    /* column already exists */
  }
  database.exec(`
    UPDATE workbench_tasks
    SET task_state = CASE
      WHEN LOWER(status) IN ('cancelled', 'canceled') THEN 'cancelled'
      WHEN LOWER(status) IN (
        'passed', 'completed', 'complete', 'done', 'success', 'succeeded',
        'closed', 'resolved'
      ) THEN 'success'
      WHEN LOWER(status) IN ('failed', 'error', 'ops_failed') THEN 'failed'
      WHEN LOWER(status) LIKE '%_passed'
        OR LOWER(status) LIKE '%_completed'
        OR LOWER(status) LIKE '%_done'
        OR LOWER(status) LIKE '%_success' THEN 'success'
      WHEN LOWER(status) LIKE '%_failed'
        OR LOWER(status) LIKE '%_error' THEN 'failed'
      ELSE task_state
    END
    WHERE task_state IS NULL
      OR task_state = 'running'
      OR task_state NOT IN ('running', 'success', 'failed', 'cancelled')
  `);

  // Add workflow_id column to delegations (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE delegations ADD COLUMN workflow_id TEXT`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_delegations_workflow ON delegations(workflow_id)`,
    );
  } catch {
    /* column already exists */
  }

  // Add workflow_id column to messages (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN workflow_id TEXT`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_workflow ON messages(workflow_id)`,
    );
  } catch {
    /* column already exists */
  }

  // Structured memory store (new memory system, independent from file-based memory).
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'canonical',
      memory_type TEXT NOT NULL DEFAULT 'preference',
      status TEXT NOT NULL DEFAULT 'active',
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(group_folder, layer, updated_at);
  `);

  try {
    database.exec(
      `ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE memories ADD COLUMN metadata TEXT`);
  } catch {
    /* column already exists */
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_metrics_scope_time ON memory_metrics(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_metrics_event_time ON memory_metrics(event, created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_extract_config (
      group_folder TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extract_config_group ON memory_extract_config(group_folder);
  `);

  // FTS5 full-text search index for messages
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);

  // Backfill FTS index if empty (one-time migration for existing data)
  const ftsCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM messages_fts`)
    .get() as { cnt: number };
  const msgCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM messages`)
    .get() as { cnt: number };
  if (ftsCount.cnt === 0 && msgCount.cnt > 0) {
    logger.info(
      { messageCount: msgCount.cnt },
      'Backfilling FTS index for existing messages',
    );
    database.exec(`
      INSERT INTO messages_fts(rowid, content)
      SELECT rowid, content FROM messages;
    `);
    logger.info('FTS backfill complete');
  }

  // FTS5 full-text index for structured memories
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  const memFtsCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM memories_fts`)
    .get() as { cnt: number };
  const memCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM memories`)
    .get() as { cnt: number };
  if (memFtsCount.cnt === 0 && memCount.cnt > 0) {
    database.exec(`
      INSERT INTO memories_fts(rowid, content)
      SELECT rowid, content FROM memories;
    `);
    logger.info({ memoryCount: memCount.cnt }, 'Memory FTS backfill complete');
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_materials (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      note TEXT,
      source_name TEXT,
      source_path TEXT,
      stored_path TEXT NOT NULL,
      extracted_text_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_materials_created_at
      ON wiki_materials(created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_drafts (
      id TEXT PRIMARY KEY,
      target_slug TEXT NOT NULL,
      title TEXT NOT NULL,
      page_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      instruction TEXT,
      content_markdown TEXT NOT NULL,
      summary TEXT,
      payload_json TEXT NOT NULL,
      material_ids_json TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_drafts_status_updated
      ON wiki_drafts(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_pages (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      page_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      summary TEXT,
      content_markdown TEXT NOT NULL,
      search_aliases TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_updated_at
      ON wiki_pages(updated_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_page_materials (
      page_slug TEXT NOT NULL,
      material_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (page_slug, material_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_page_materials_material
      ON wiki_page_materials(material_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_claims (
      id TEXT PRIMARY KEY,
      owner_page_slug TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      canonical_form TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_claims_page_status
      ON wiki_claims(owner_page_slug, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_claims_page_canonical_active
      ON wiki_claims(owner_page_slug, canonical_form)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS wiki_claim_evidence (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      material_id TEXT NOT NULL,
      excerpt_text TEXT NOT NULL,
      locator TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_claim_evidence_claim
      ON wiki_claim_evidence(claim_id, created_at);

    CREATE TABLE IF NOT EXISTS wiki_relations (
      id TEXT PRIMARY KEY,
      from_page_slug TEXT NOT NULL,
      to_page_slug TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      rationale TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_relations_from_page
      ON wiki_relations(from_page_slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wiki_relations_to_page
      ON wiki_relations(to_page_slug, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_jobs_status_updated
      ON wiki_jobs(status, updated_at DESC);
  `);

  registerWikiSearchAliasFunction(database);
  ensureWikiPageSearchAliases(database);
  recreateWikiFtsIfNeeded(database);

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
      slug,
      title,
      summary,
      content_markdown,
      search_aliases,
      content='wiki_pages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    DROP TRIGGER IF EXISTS wiki_pages_ai;
    DROP TRIGGER IF EXISTS wiki_pages_ad;
    DROP TRIGGER IF EXISTS wiki_pages_au;

    CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
      INSERT INTO wiki_pages_fts(rowid, slug, title, summary, content_markdown, search_aliases)
      VALUES (
        new.rowid,
        new.slug,
        new.title,
        COALESCE(new.summary, ''),
        new.content_markdown,
        wiki_search_aliases(new.slug, new.title)
      );
    END;

    CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
      INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, slug, title, summary, content_markdown, search_aliases)
      VALUES(
        'delete',
        old.rowid,
        old.slug,
        old.title,
        COALESCE(old.summary, ''),
        old.content_markdown,
        wiki_search_aliases(old.slug, old.title)
      );
    END;

    CREATE TRIGGER wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
      INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, slug, title, summary, content_markdown, search_aliases)
      VALUES(
        'delete',
        old.rowid,
        old.slug,
        old.title,
        COALESCE(old.summary, ''),
        old.content_markdown,
        wiki_search_aliases(old.slug, old.title)
      );
      INSERT INTO wiki_pages_fts(rowid, slug, title, summary, content_markdown, search_aliases)
      VALUES (
        new.rowid,
        new.slug,
        new.title,
        COALESCE(new.summary, ''),
        new.content_markdown,
        wiki_search_aliases(new.slug, new.title)
      );
    END;
  `);

  const wikiFtsCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM wiki_pages_fts`)
    .get() as { cnt: number };
  const wikiPageCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM wiki_pages`)
    .get() as { cnt: number };
  if (wikiFtsCount.cnt === 0 && wikiPageCount.cnt > 0) {
    database.exec(`
      INSERT INTO wiki_pages_fts(rowid, slug, title, summary, content_markdown, search_aliases)
      SELECT
        rowid,
        slug,
        title,
        COALESCE(summary, ''),
        content_markdown,
        wiki_search_aliases(slug, title)
      FROM wiki_pages;
    `);
    logger.info({ wikiPageCount }, 'Wiki page FTS backfill complete');
  }
}

function normalizeWorkflowSchema(database: Database.Database): void {
  const columns = database.pragma('table_info(workflows)') as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasLegacyContextColumns =
    columnNames.has('main_branch') ||
    columnNames.has('work_branch') ||
    columnNames.has('deliverable') ||
    columnNames.has('staging_base_branch') ||
    columnNames.has('staging_work_branch') ||
    columnNames.has('access_token');
  const needsContextColumn = !columnNames.has('context_json');

  if (!hasLegacyContextColumns && !needsContextColumn) {
    return;
  }

  database.exec(`
    BEGIN;
    CREATE TABLE workflows_next (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      start_from TEXT NOT NULL DEFAULT 'plan',
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'dev',
      current_delegation_id TEXT DEFAULT '',
      round INTEGER DEFAULT 0,
      source_jid TEXT NOT NULL,
      paused_from TEXT,
      workflow_type TEXT DEFAULT 'dev_test',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const selectRows = database.prepare(`
    SELECT
      id,
      name,
      service,
      start_from,
      status,
      current_delegation_id,
      round,
      source_jid,
      paused_from,
      workflow_type,
      created_at,
      updated_at,
      ${columnNames.has('context_json') ? 'context_json' : 'NULL AS context_json'},
      ${columnNames.has('main_branch') ? 'main_branch' : "'' AS main_branch"},
      ${columnNames.has('work_branch') ? 'work_branch' : "'' AS work_branch"},
      ${columnNames.has('deliverable') ? 'deliverable' : "'' AS deliverable"},
      ${columnNames.has('staging_base_branch') ? 'staging_base_branch' : "'' AS staging_base_branch"},
      ${columnNames.has('staging_work_branch') ? 'staging_work_branch' : "'' AS staging_work_branch"},
      ${columnNames.has('access_token') ? 'access_token' : "'' AS access_token"}
    FROM workflows
  `);

  const insertRow = database.prepare(`
    INSERT INTO workflows_next (
      id, name, service, start_from, context_json, status,
      current_delegation_id, round, source_jid, paused_from,
      workflow_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of selectRows.all() as Array<Record<string, unknown>>) {
    const context = mergeWorkflowContext(
      parseWorkflowContext(
        typeof row.context_json === 'string' ? row.context_json : undefined,
      ),
      {
        main_branch: row.main_branch,
        work_branch: row.work_branch,
        deliverable: row.deliverable,
        staging_base_branch: row.staging_base_branch,
        staging_work_branch: row.staging_work_branch,
        access_token: row.access_token,
      },
    );
    insertRow.run(
      row.id,
      row.name,
      row.service,
      row.start_from,
      serializeWorkflowContext(context),
      row.status,
      row.current_delegation_id,
      row.round,
      row.source_jid,
      row.paused_from ?? null,
      row.workflow_type ?? 'dev_test',
      row.created_at,
      row.updated_at,
    );
  }

  database.exec(`
    DROP TABLE workflows;
    ALTER TABLE workflows_next RENAME TO workflows;
    CREATE INDEX idx_workflows_status ON workflows(status);
    CREATE INDEX idx_workflows_delegation ON workflows(current_delegation_id);
    COMMIT;
  `);
}

function hydrateWorkflowRow(
  row: Record<string, unknown> | undefined,
): Workflow | undefined {
  if (!row) return undefined;
  const context = parseWorkflowContext(
    typeof row.context_json === 'string' ? row.context_json : undefined,
  );
  return {
    id: String(row.id),
    name: String(row.name),
    service: String(row.service),
    start_from: String(row.start_from),
    context,
    status: String(row.status),
    current_delegation_id: String(row.current_delegation_id || ''),
    round: Number(row.round || 0),
    source_jid: String(row.source_jid),
    paused_from:
      row.paused_from === null || row.paused_from === undefined
        ? null
        : String(row.paused_from),
    workflow_type: String(row.workflow_type || 'dev_test'),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database has not been initialized');
  }
  return db;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, Date.now().toString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = Date.now().toString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT INTO messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      model,
      model_reason,
      workflow_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      model = COALESCE(excluded.model, messages.model),
      model_reason = COALESCE(excluded.model_reason, messages.model_reason),
      workflow_id = COALESCE(excluded.workflow_id, messages.workflow_id)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.model ?? null,
    msg.model_reason ?? null,
    msg.workflow_id ?? null,
  );
}

/**
 * Backfill model for a set of user message IDs that were actually processed.
 * Returns number of updated rows.
 */
export function backfillMessageModel(
  chatJid: string,
  messageIds: string[],
  model: string,
  modelReason: string,
): number {
  if (!chatJid || !model || !modelReason || messageIds.length === 0) return 0;

  const dedupedIds = Array.from(new Set(messageIds.filter(Boolean)));
  if (dedupedIds.length === 0) return 0;

  const batchSize = 300; // Keep parameter count safely below SQLite limits.
  const updateBatch = db.transaction((ids: string[]) => {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(
      `UPDATE messages
       SET model = ?, model_reason = ?
       WHERE chat_jid = ?
         AND is_bot_message = 0
         AND id IN (${placeholders})`,
    );
    const result = stmt.run(model, modelReason, chatJid, ...ids);
    return result.changes;
  });

  let updated = 0;
  for (let i = 0; i < dedupedIds.length; i += batchSize) {
    updated += updateBatch(dedupedIds.slice(i, i + batchSize));
  }
  return updated;
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  model?: string | null;
  model_reason?: string | null;
  workflow_id?: string | null;
}): void {
  db.prepare(
    `INSERT INTO messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      model,
      model_reason,
      workflow_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      model = COALESCE(excluded.model, messages.model),
      model_reason = COALESCE(excluded.model_reason, messages.model_reason),
      workflow_id = COALESCE(excluded.workflow_id, messages.workflow_id)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.model ?? null,
    msg.model_reason ?? null,
    msg.workflow_id ?? null,
  );
}

export function storeAssistantChatMessage(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  workflow_id?: string | null;
}): void {
  db.prepare(
    `INSERT INTO assistant_chat_messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      workflow_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, id) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      workflow_id = COALESCE(excluded.workflow_id, assistant_chat_messages.workflow_id)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.workflow_id ?? null,
  );
}

export function listAssistantChatMessageRecords(
  chatJid: string,
  limit: number = 1000,
): StoredChatMessageRecord[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.trunc(limit))
    : 1000;
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             workflow_id
        FROM assistant_chat_messages
       WHERE chat_jid = ?
       ORDER BY timestamp DESC, rowid DESC
       LIMIT ?
    `,
    )
    .all(chatJid, normalizedLimit) as StoredChatMessageRecord[];
}

export function clearAssistantData(): {
  assistant_chat_messages: number;
  messages: number;
  agent_inbox_items: number;
  assistant_action_logs: number;
  assistant_snoozes: number;
  total: number;
} {
  const tx = db.transaction(() => {
    const assistantChatMessages = db
      .prepare(`DELETE FROM assistant_chat_messages`)
      .run().changes;
    const messages = db
      .prepare(`DELETE FROM messages WHERE chat_jid LIKE 'assistant:%'`)
      .run().changes;
    const actionLogs = db.prepare(`DELETE FROM assistant_action_logs`).run()
      .changes;
    const snoozes = db.prepare(`DELETE FROM assistant_snoozes`).run().changes;
    const inboxItems = db.prepare(`DELETE FROM agent_inbox_items`).run().changes;

    return {
      assistant_chat_messages: assistantChatMessages,
      messages,
      agent_inbox_items: inboxItems,
      assistant_action_logs: actionLogs,
      assistant_snoozes: snoozes,
      total: assistantChatMessages + messages + inboxItems + actionLogs + snoozes,
    };
  });

  return tx();
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function listStoredMessagesByChat(
  chatJid: string,
  limit: number = 1000,
): StoredChatMessageRecord[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.trunc(limit))
    : 1000;
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             workflow_id
        FROM messages
       WHERE chat_jid = ?
       ORDER BY rowid DESC
       LIMIT ?
    `,
    )
    .all(chatJid, normalizedLimit) as StoredChatMessageRecord[];
}

export function listStoredMessagesByWorkflow(
  chatJid: string,
  workflowId: string,
  limit: number = 1000,
): StoredChatMessageRecord[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.trunc(limit))
    : 1000;
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             workflow_id
        FROM messages
       WHERE chat_jid = ? AND workflow_id = ?
       ORDER BY rowid DESC
       LIMIT ?
    `,
    )
    .all(chatJid, workflowId, normalizedLimit) as StoredChatMessageRecord[];
}

export function listStoredMessagesByIds(
  chatJid: string,
  ids: string[],
): StoredChatMessageRecord[] {
  const normalizedIds = Array.from(
    new Set(
      ids.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  if (normalizedIds.length === 0) return [];
  const placeholders = normalizedIds.map(() => '?').join(', ');
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             workflow_id
        FROM messages
       WHERE chat_jid = ? AND id IN (${placeholders})
      `,
    )
    .all(chatJid, ...normalizedIds) as StoredChatMessageRecord[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'last_query_id'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  deleteAgentQueriesBySource('scheduled_task', id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = formatLocalTime(new Date());
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
  options: {
    lastQueryId?: string | null;
    status?: ScheduledTask['status'];
    runAt?: string;
  } = {},
): void {
  const now = options.runAt ?? formatLocalTime(new Date());
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?,
        last_run = ?,
        last_result = ?,
        last_query_id = ?,
        status = COALESCE(?, CASE WHEN ? IS NULL THEN 'completed' ELSE status END)
    WHERE id = ?
  `,
  ).run(
    nextRun,
    now,
    lastResult,
    options.lastQueryId ?? null,
    options.status ?? null,
    nextRun,
    id,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Clear / reset ---

export function clearMessages(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}

export function deleteMessagesByIds(
  chatJid: string,
  messageIds: string[],
): number {
  if (!chatJid || messageIds.length === 0) return 0;
  const del = db.prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?');
  const tx = db.transaction((ids: string[]) => {
    let deleted = 0;
    for (const id of ids) {
      const result = del.run(chatJid, id);
      deleted += result.changes;
    }
    return deleted;
  });
  return tx(messageIds);
}

export function clearSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        description: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    description: row.description || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.description || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    description: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      description: row.description || undefined,
    };
  }
  return result;
}

// --- Delegation accessors ---

export function createDelegation(delegation: Delegation): void {
  db.prepare(
    `INSERT INTO delegations (id, source_jid, source_folder, target_jid, target_folder, task, status, result, requester_jid, workflow_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    delegation.id,
    delegation.source_jid,
    delegation.source_folder,
    delegation.target_jid,
    delegation.target_folder,
    delegation.task,
    delegation.status,
    delegation.result,
    delegation.requester_jid,
    delegation.workflow_id ?? null,
    delegation.created_at,
    delegation.updated_at,
  );
}

export function getDelegation(id: string): Delegation | undefined {
  return db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as
    | Delegation
    | undefined;
}

export function updateDelegation(
  id: string,
  updates: Partial<Pick<Delegation, 'status' | 'result' | 'outcome'>>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now().toString()];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    fields.push('result = ?');
    values.push(updates.result);
  }
  if (updates.outcome !== undefined) {
    fields.push('outcome = ?');
    values.push(updates.outcome);
  }

  values.push(id);
  db.prepare(`UPDATE delegations SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getDelegationsBySource(sourceFolder: string): Delegation[] {
  return db
    .prepare(
      `SELECT * FROM delegations WHERE source_folder = ? ORDER BY created_at DESC`,
    )
    .all(sourceFolder) as Delegation[];
}

export function getDelegationsByTarget(targetFolder: string): Delegation[] {
  return db
    .prepare(
      `SELECT * FROM delegations WHERE target_folder = ? ORDER BY created_at DESC`,
    )
    .all(targetFolder) as Delegation[];
}

// --- Ask-user-question accessors ---

export function createAskQuestion(record: AskQuestionRecord): void {
  db.prepare(
    `INSERT INTO ask_questions (
      id, group_folder, chat_jid, status, payload_json, answers_json,
      current_index, created_at, expires_at, answered_at, responder_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.status,
    record.payload_json,
    record.answers_json,
    record.current_index,
    record.created_at,
    record.expires_at,
    record.answered_at,
    record.responder_user_id,
  );
}

export function getAskQuestion(id: string): AskQuestionRecord | undefined {
  return db.prepare('SELECT * FROM ask_questions WHERE id = ?').get(id) as
    | AskQuestionRecord
    | undefined;
}

export function updateAskQuestion(
  id: string,
  updates: Partial<
    Pick<
      AskQuestionRecord,
      | 'status'
      | 'answers_json'
      | 'current_index'
      | 'answered_at'
      | 'responder_user_id'
      | 'expires_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.answers_json !== undefined) {
    fields.push('answers_json = ?');
    values.push(updates.answers_json);
  }
  if (updates.current_index !== undefined) {
    fields.push('current_index = ?');
    values.push(updates.current_index);
  }
  if (updates.answered_at !== undefined) {
    fields.push('answered_at = ?');
    values.push(updates.answered_at);
  }
  if (updates.responder_user_id !== undefined) {
    fields.push('responder_user_id = ?');
    values.push(updates.responder_user_id);
  }
  if (updates.expires_at !== undefined) {
    fields.push('expires_at = ?');
    values.push(updates.expires_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE ask_questions SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getExpiredPendingAskQuestions(
  nowIso: string,
): AskQuestionRecord[] {
  return db
    .prepare(
      `SELECT * FROM ask_questions
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at ASC`,
    )
    .all(nowIso) as AskQuestionRecord[];
}

// --- Workflow accessors ---

export function createWorkflow(workflow: Workflow): void {
  db.prepare(
    `INSERT INTO workflows (id, name, service, start_from, context_json, status, current_delegation_id, round, source_jid, paused_from, workflow_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    workflow.name,
    workflow.service,
    workflow.start_from,
    serializeWorkflowContext(workflow.context),
    workflow.status,
    workflow.current_delegation_id,
    workflow.round,
    workflow.source_jid,
    workflow.paused_from || null,
    workflow.workflow_type,
    workflow.created_at,
    workflow.updated_at,
  );
}

export function getWorkflow(id: string): Workflow | undefined {
  return hydrateWorkflowRow(
    db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined,
  );
}

export function updateWorkflow(
  id: string,
  updates: Partial<
    Pick<
      Workflow,
      | 'status'
      | 'current_delegation_id'
      | 'round'
      | 'paused_from'
      | 'workflow_type'
    >
  > & {
    context?: WorkflowContext;
  },
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now().toString()];
  if (updates.context !== undefined) {
    const currentContext = getWorkflow(id)?.context || {};
    fields.push('context_json = ?');
    values.push(
      serializeWorkflowContext(
        mergeWorkflowContext(currentContext, updates.context),
      ),
    );
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.current_delegation_id !== undefined) {
    fields.push('current_delegation_id = ?');
    values.push(updates.current_delegation_id);
  }
  if (updates.round !== undefined) {
    fields.push('round = ?');
    values.push(updates.round);
  }
  if (updates.paused_from !== undefined) {
    fields.push('paused_from = ?');
    values.push(updates.paused_from);
  }
  if (updates.workflow_type !== undefined) {
    fields.push('workflow_type = ?');
    values.push(updates.workflow_type);
  }

  values.push(id);
  db.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getWorkflowByDelegation(
  delegationId: string,
): Workflow | undefined {
  // First try via delegation record's workflow_id (supports historical delegations)
  const delegation = getDelegation(delegationId);
  if (delegation?.workflow_id) {
    return getWorkflow(delegation.workflow_id);
  }
  // Fallback: old records without workflow_id — match via current_delegation_id
  return hydrateWorkflowRow(
    db
      .prepare('SELECT * FROM workflows WHERE current_delegation_id = ?')
      .get(delegationId) as Record<string, unknown> | undefined,
  );
}

export function getDelegationsByWorkflow(workflowId: string): Delegation[] {
  return db
    .prepare(
      'SELECT * FROM delegations WHERE workflow_id = ? ORDER BY created_at ASC',
    )
    .all(workflowId) as Delegation[];
}

export function createWorkflowStageEvaluation(
  record: WorkflowStageEvaluationRecord,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflow_stage_evaluations (
      id, workflow_id, delegation_id, stage_key, evaluator_type, status, score,
      summary, findings_json, evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.workflow_id,
    record.delegation_id,
    record.stage_key,
    record.evaluator_type,
    record.status,
    record.score,
    record.summary,
    record.findings_json,
    record.evidence_json,
    record.created_at,
    record.updated_at,
  );
}

export function getWorkflowStageEvaluation(
  id: string,
): WorkflowStageEvaluationRecord | undefined {
  return db
    .prepare('SELECT * FROM workflow_stage_evaluations WHERE id = ?')
    .get(id) as WorkflowStageEvaluationRecord | undefined;
}

export function getLatestWorkflowStageEvaluation(
  workflowId: string,
  stageKey: string,
): WorkflowStageEvaluationRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM workflow_stage_evaluations
       WHERE workflow_id = ? AND stage_key = ?
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(workflowId, stageKey) as WorkflowStageEvaluationRecord | undefined;
}

export function listWorkflowStageEvaluationsByWorkflow(
  workflowId: string,
): WorkflowStageEvaluationRecord[] {
  return db
    .prepare(
      `SELECT * FROM workflow_stage_evaluations
       WHERE workflow_id = ?
       ORDER BY updated_at DESC, rowid DESC`,
    )
    .all(workflowId) as WorkflowStageEvaluationRecord[];
}

export function getAllActiveWorkflows(): Workflow[] {
  return (
    db
      .prepare(
        `SELECT * FROM workflows WHERE status NOT IN ('passed', 'ops_failed', 'cancelled') ORDER BY created_at DESC`,
      )
      .all() as Record<string, unknown>[]
  )
    .map((row) => hydrateWorkflowRow(row))
    .filter((workflow): workflow is Workflow => Boolean(workflow));
}

export function getAllWorkflows(): Workflow[] {
  return (
    db
      .prepare(`SELECT * FROM workflows ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[]
  )
    .map((row) => hydrateWorkflowRow(row))
    .filter((workflow): workflow is Workflow => Boolean(workflow));
}

export function deleteAllWorkbenchTaskData(): {
  workflows: number;
  delegations: number;
  workflow_stage_evaluations: number;
  workbench_tasks: number;
  workbench_subtasks: number;
  workbench_events: number;
  workbench_artifacts: number;
  workbench_action_items: number;
  workbench_comments: number;
  workbench_context_assets: number;
} {
  const count = (sql: string) =>
    (db.prepare(sql).get() as { count: number }).count;

  const summary = {
    workflows: count('SELECT COUNT(*) AS count FROM workflows'),
    delegations: count(
      'SELECT COUNT(*) AS count FROM delegations WHERE workflow_id IS NOT NULL',
    ),
    workflow_stage_evaluations: count(
      'SELECT COUNT(*) AS count FROM workflow_stage_evaluations',
    ),
    workbench_tasks: count('SELECT COUNT(*) AS count FROM workbench_tasks'),
    workbench_subtasks: count(
      'SELECT COUNT(*) AS count FROM workbench_subtasks',
    ),
    workbench_events: count('SELECT COUNT(*) AS count FROM workbench_events'),
    workbench_artifacts: count(
      'SELECT COUNT(*) AS count FROM workbench_artifacts',
    ),
    workbench_action_items: count(
      'SELECT COUNT(*) AS count FROM workbench_action_items',
    ),
    workbench_comments: count(
      'SELECT COUNT(*) AS count FROM workbench_comments',
    ),
    workbench_context_assets: count(
      'SELECT COUNT(*) AS count FROM workbench_context_assets',
    ),
  };

  const clear = db.transaction(() => {
    db.prepare('DELETE FROM workbench_context_assets').run();
    db.prepare('DELETE FROM workbench_comments').run();
    db.prepare('DELETE FROM workbench_action_items').run();
    db.prepare('DELETE FROM workbench_artifacts').run();
    db.prepare('DELETE FROM workbench_events').run();
    db.prepare('DELETE FROM workbench_subtasks').run();
    db.prepare('DELETE FROM workbench_tasks').run();
    db.prepare('DELETE FROM workflow_stage_evaluations').run();
    db.prepare('DELETE FROM delegations WHERE workflow_id IS NOT NULL').run();
    db.prepare('DELETE FROM workflows').run();
  });

  clear();
  return summary;
}

export function deleteWorkbenchTaskData(taskId: string): {
  workflow_id: string;
  workflows: number;
  delegations: number;
  workflow_stage_evaluations: number;
  workbench_tasks: number;
  workbench_subtasks: number;
  workbench_events: number;
  workbench_artifacts: number;
  workbench_action_items: number;
  workbench_comments: number;
  workbench_context_assets: number;
} | null {
  const task = getWorkbenchTaskById(taskId);
  if (!task) return null;

  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { count: number }).count;

  const summary = {
    workflow_id: task.workflow_id,
    workflows: count(
      'SELECT COUNT(*) AS count FROM workflows WHERE id = ?',
      task.workflow_id,
    ),
    delegations: count(
      'SELECT COUNT(*) AS count FROM delegations WHERE workflow_id = ?',
      task.workflow_id,
    ),
    workflow_stage_evaluations: count(
      'SELECT COUNT(*) AS count FROM workflow_stage_evaluations WHERE workflow_id = ?',
      task.workflow_id,
    ),
    workbench_tasks: count(
      'SELECT COUNT(*) AS count FROM workbench_tasks WHERE id = ?',
      task.id,
    ),
    workbench_subtasks: count(
      'SELECT COUNT(*) AS count FROM workbench_subtasks WHERE task_id = ?',
      task.id,
    ),
    workbench_events: count(
      'SELECT COUNT(*) AS count FROM workbench_events WHERE task_id = ?',
      task.id,
    ),
    workbench_artifacts: count(
      'SELECT COUNT(*) AS count FROM workbench_artifacts WHERE task_id = ?',
      task.id,
    ),
    workbench_action_items: count(
      'SELECT COUNT(*) AS count FROM workbench_action_items WHERE task_id = ?',
      task.id,
    ),
    workbench_comments: count(
      'SELECT COUNT(*) AS count FROM workbench_comments WHERE task_id = ?',
      task.id,
    ),
    workbench_context_assets: count(
      'SELECT COUNT(*) AS count FROM workbench_context_assets WHERE task_id = ?',
      task.id,
    ),
  };

  const clear = db.transaction(() => {
    db.prepare('DELETE FROM workbench_context_assets WHERE task_id = ?').run(
      task.id,
    );
    db.prepare('DELETE FROM workbench_comments WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM workbench_action_items WHERE task_id = ?').run(
      task.id,
    );
    db.prepare('DELETE FROM workbench_artifacts WHERE task_id = ?').run(
      task.id,
    );
    db.prepare('DELETE FROM workbench_events WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM workbench_subtasks WHERE task_id = ?').run(task.id);
    db.prepare('DELETE FROM workbench_tasks WHERE id = ?').run(task.id);
    db.prepare(
      'DELETE FROM workflow_stage_evaluations WHERE workflow_id = ?',
    ).run(task.workflow_id);
    db.prepare('DELETE FROM delegations WHERE workflow_id = ?').run(
      task.workflow_id,
    );
    db.prepare('DELETE FROM workflows WHERE id = ?').run(task.workflow_id);
  });

  clear();
  return summary;
}

// --- Workbench accessors ---

export function createWorkbenchTask(record: WorkbenchTaskRecord): void {
  db.prepare(
    `INSERT INTO workbench_tasks (
      id, workflow_id, source_jid, title, service, start_from, workflow_type,
      status, task_state, current_stage, summary, created_at, updated_at,
      last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.workflow_id,
    record.source_jid,
    record.title,
    record.service,
    record.start_from,
    record.workflow_type,
    record.status,
    record.task_state,
    record.current_stage,
    record.summary,
    record.created_at,
    record.updated_at,
    record.last_event_at,
  );
}

export function getWorkbenchTaskById(
  id: string,
): WorkbenchTaskRecord | undefined {
  return db.prepare('SELECT * FROM workbench_tasks WHERE id = ?').get(id) as
    | WorkbenchTaskRecord
    | undefined;
}

export function getWorkbenchTaskByWorkflowId(
  workflowId: string,
): WorkbenchTaskRecord | undefined {
  return db
    .prepare('SELECT * FROM workbench_tasks WHERE workflow_id = ?')
    .get(workflowId) as WorkbenchTaskRecord | undefined;
}

export function listWorkbenchTasks(): WorkbenchTaskRecord[] {
  return db
    .prepare('SELECT * FROM workbench_tasks ORDER BY updated_at DESC, id DESC')
    .all() as WorkbenchTaskRecord[];
}

export function updateWorkbenchTask(
  id: string,
  updates: Partial<
    Pick<
      WorkbenchTaskRecord,
      | 'status'
      | 'task_state'
      | 'current_stage'
      | 'summary'
      | 'updated_at'
      | 'last_event_at'
      | 'title'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.task_state !== undefined) {
    fields.push('task_state = ?');
    values.push(updates.task_state);
  }
  if (updates.current_stage !== undefined) {
    fields.push('current_stage = ?');
    values.push(updates.current_stage);
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }
  if (updates.last_event_at !== undefined) {
    fields.push('last_event_at = ?');
    values.push(updates.last_event_at);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE workbench_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function createWorkbenchSubtask(record: WorkbenchSubtaskRecord): void {
  db.prepare(
    `INSERT INTO workbench_subtasks (
      id, task_id, workflow_id, delegation_id, stage_key, title, role, group_folder,
      status, input_summary, output_summary, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.workflow_id,
    record.delegation_id,
    record.stage_key,
    record.title,
    record.role,
    record.group_folder,
    record.status,
    record.input_summary,
    record.output_summary,
    record.started_at,
    record.finished_at,
    record.updated_at,
  );
}

export function getWorkbenchSubtaskByStage(
  taskId: string,
  stageKey: string,
): WorkbenchSubtaskRecord | undefined {
  return db
    .prepare(
      'SELECT * FROM workbench_subtasks WHERE task_id = ? AND stage_key = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(taskId, stageKey) as WorkbenchSubtaskRecord | undefined;
}

export function getWorkbenchSubtaskByDelegationId(
  taskId: string,
  delegationId: string,
): WorkbenchSubtaskRecord | undefined {
  return db
    .prepare(
      'SELECT * FROM workbench_subtasks WHERE task_id = ? AND delegation_id = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(taskId, delegationId) as WorkbenchSubtaskRecord | undefined;
}

export function listWorkbenchSubtasksByTask(
  taskId: string,
): WorkbenchSubtaskRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_subtasks WHERE task_id = ? ORDER BY rowid ASC',
    )
    .all(taskId) as WorkbenchSubtaskRecord[];
}

export function updateWorkbenchSubtask(
  id: string,
  updates: Partial<
    Pick<
      WorkbenchSubtaskRecord,
      | 'delegation_id'
      | 'group_folder'
      | 'status'
      | 'input_summary'
      | 'output_summary'
      | 'started_at'
      | 'finished_at'
      | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.delegation_id !== undefined) {
    fields.push('delegation_id = ?');
    values.push(updates.delegation_id);
  }
  if (updates.group_folder !== undefined) {
    fields.push('group_folder = ?');
    values.push(updates.group_folder);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.input_summary !== undefined) {
    fields.push('input_summary = ?');
    values.push(updates.input_summary);
  }
  if (updates.output_summary !== undefined) {
    fields.push('output_summary = ?');
    values.push(updates.output_summary);
  }
  if (updates.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(updates.started_at);
  }
  if (updates.finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(updates.finished_at);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE workbench_subtasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function createWorkbenchEvent(record: WorkbenchEventRecord): void {
  db.prepare(
    `INSERT OR IGNORE INTO workbench_events (
      id, task_id, subtask_id, event_type, title, body, raw_ref_type, raw_ref_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.subtask_id,
    record.event_type,
    record.title,
    record.body,
    record.raw_ref_type,
    record.raw_ref_id,
    record.created_at,
  );
}

export function listWorkbenchEventsByTask(
  taskId: string,
): WorkbenchEventRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_events WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as WorkbenchEventRecord[];
}

export function createWorkbenchArtifact(record: WorkbenchArtifactRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO workbench_artifacts (
      id, task_id, workflow_id, artifact_type, title, path, source_role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.workflow_id,
    record.artifact_type,
    record.title,
    record.path,
    record.source_role,
    record.created_at,
  );
}

export function listWorkbenchArtifactsByTask(
  taskId: string,
): WorkbenchArtifactRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_artifacts WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as WorkbenchArtifactRecord[];
}

export function createWorkbenchActionItem(
  record: WorkbenchActionItemRecord,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO workbench_action_items (
      id, task_id, workflow_id, subtask_id, stage_key, delegation_id, group_folder,
      item_type, status, title, body, source_type, source_ref_id, replyable,
      created_at, updated_at, resolved_at, extra_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.workflow_id,
    record.subtask_id,
    record.stage_key,
    record.delegation_id,
    record.group_folder,
    record.item_type,
    record.status,
    record.title,
    record.body,
    record.source_type,
    record.source_ref_id,
    record.replyable,
    record.created_at,
    record.updated_at,
    record.resolved_at,
    record.extra_json,
  );
}

export function getWorkbenchActionItem(
  id: string,
): WorkbenchActionItemRecord | undefined {
  return db
    .prepare('SELECT * FROM workbench_action_items WHERE id = ?')
    .get(id) as WorkbenchActionItemRecord | undefined;
}

export function listWorkbenchActionItemsByTask(
  taskId: string,
): WorkbenchActionItemRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_action_items WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as WorkbenchActionItemRecord[];
}

export function listWorkbenchActionItemsBySource(
  sourceType: string,
  sourceRefId: string,
): WorkbenchActionItemRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_action_items WHERE source_type = ? AND source_ref_id = ? ORDER BY created_at DESC',
    )
    .all(sourceType, sourceRefId) as WorkbenchActionItemRecord[];
}

export function updateWorkbenchActionItem(
  id: string,
  updates: Partial<
    Pick<
      WorkbenchActionItemRecord,
      | 'status'
      | 'title'
      | 'body'
      | 'replyable'
      | 'updated_at'
      | 'resolved_at'
      | 'extra_json'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.body !== undefined) {
    fields.push('body = ?');
    values.push(updates.body);
  }
  if (updates.replyable !== undefined) {
    fields.push('replyable = ?');
    values.push(updates.replyable ? 1 : 0);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }
  if (updates.resolved_at !== undefined) {
    fields.push('resolved_at = ?');
    values.push(updates.resolved_at);
  }
  if (updates.extra_json !== undefined) {
    fields.push('extra_json = ?');
    values.push(updates.extra_json);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE workbench_action_items SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function resolveWorkbenchActionItemsBySource(
  sourceType: string,
  sourceRefId: string,
  status: string,
  resolvedAt: string,
): void {
  db.prepare(
    `UPDATE workbench_action_items
     SET status = ?, updated_at = ?, resolved_at = ?
     WHERE source_type = ? AND source_ref_id = ? AND status = 'pending'`,
  ).run(status, resolvedAt, resolvedAt, sourceType, sourceRefId);
}

export function resolveWorkbenchActionItemsByStage(
  workflowId: string,
  stageKey: string,
  status: string,
  resolvedAt: string,
): void {
  db.prepare(
    `UPDATE workbench_action_items
     SET status = ?, updated_at = ?, resolved_at = ?
     WHERE workflow_id = ? AND stage_key = ? AND status IN ('pending', 'confirmed')`,
  ).run(status, resolvedAt, resolvedAt, workflowId, stageKey);
}

export function createWorkbenchComment(record: WorkbenchCommentRecord): void {
  db.prepare(
    `INSERT INTO workbench_comments (
      id, task_id, workflow_id, author, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.workflow_id,
    record.author,
    record.content,
    record.created_at,
  );
}

export function listWorkbenchCommentsByTask(
  taskId: string,
): WorkbenchCommentRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_comments WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as WorkbenchCommentRecord[];
}

export function createWorkbenchContextAsset(
  record: WorkbenchContextAssetRecord,
): void {
  db.prepare(
    `INSERT INTO workbench_context_assets (
      id, task_id, workflow_id, asset_type, title, path, url, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.task_id,
    record.workflow_id,
    record.asset_type,
    record.title,
    record.path,
    record.url,
    record.note,
    record.created_at,
  );
}

export function listWorkbenchContextAssetsByTask(
  taskId: string,
): WorkbenchContextAssetRecord[] {
  return db
    .prepare(
      'SELECT * FROM workbench_context_assets WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as WorkbenchContextAssetRecord[];
}

// --- Today plan accessors ---

export function createTodayPlan(input: {
  plan_date: string;
  title: string;
  status?: TodayPlanRecord['status'];
  completed_at?: string | null;
  continued_from_plan_id?: string | null;
}): TodayPlanRecord {
  const now = Date.now().toString();
  const id = `today-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO today_plans (
      id, plan_date, title, status, completed_at, continued_from_plan_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.plan_date,
    input.title.trim(),
    input.status || 'active',
    input.completed_at ?? null,
    input.continued_from_plan_id ?? null,
    now,
    now,
  );
  return db
    .prepare('SELECT * FROM today_plans WHERE id = ?')
    .get(id) as TodayPlanRecord;
}

export function getTodayPlanById(id: string): TodayPlanRecord | undefined {
  return db.prepare('SELECT * FROM today_plans WHERE id = ?').get(id) as
    | TodayPlanRecord
    | undefined;
}

export function getTodayPlanByDate(
  planDate: string,
): TodayPlanRecord | undefined {
  return db
    .prepare('SELECT * FROM today_plans WHERE plan_date = ?')
    .get(planDate) as TodayPlanRecord | undefined;
}

export function listTodayPlans(
  input: {
    before_date?: string;
    limit?: number;
  } = {},
): TodayPlanRecord[] {
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.trunc(input.limit as number))
    : 30;
  if (input.before_date) {
    return db
      .prepare(
        `SELECT * FROM today_plans
         WHERE plan_date < ?
         ORDER BY plan_date DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(input.before_date, limit) as TodayPlanRecord[];
  }
  return db
    .prepare(
      `SELECT * FROM today_plans
       ORDER BY plan_date DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as TodayPlanRecord[];
}

export function updateTodayPlan(
  id: string,
  updates: Partial<
    Pick<
      TodayPlanRecord,
      | 'title'
      | 'status'
      | 'completed_at'
      | 'continued_from_plan_id'
      | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title.trim());
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (updates.continued_from_plan_id !== undefined) {
    fields.push('continued_from_plan_id = ?');
    values.push(updates.continued_from_plan_id);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE today_plans SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function createTodayPlanItem(input: {
  plan_id: string;
  title: string;
  detail?: string | null;
  order_index?: number;
  associations_json?: string | null;
}): TodayPlanItemRecord {
  const now = Date.now().toString();
  const id = `today-plan-item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(order_index), -1) AS max_order FROM today_plan_items WHERE plan_id = ?',
    )
    .get(input.plan_id) as { max_order: number };
  const orderIndex =
    input.order_index !== undefined ? input.order_index : maxRow.max_order + 1;
  db.prepare(
    `INSERT INTO today_plan_items (
      id, plan_id, title, detail, order_index, associations_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.plan_id,
    input.title.trim(),
    input.detail ?? null,
    orderIndex,
    input.associations_json ?? null,
    now,
    now,
  );
  return db
    .prepare('SELECT * FROM today_plan_items WHERE id = ?')
    .get(id) as TodayPlanItemRecord;
}

export function getTodayPlanItemById(
  id: string,
): TodayPlanItemRecord | undefined {
  return db.prepare('SELECT * FROM today_plan_items WHERE id = ?').get(id) as
    | TodayPlanItemRecord
    | undefined;
}

export function listTodayPlanItems(planId: string): TodayPlanItemRecord[] {
  return db
    .prepare(
      `SELECT * FROM today_plan_items
       WHERE plan_id = ?
       ORDER BY order_index ASC, created_at ASC`,
    )
    .all(planId) as TodayPlanItemRecord[];
}

export function updateTodayPlanItem(
  id: string,
  updates: Partial<
    Pick<
      TodayPlanItemRecord,
      'title' | 'detail' | 'order_index' | 'associations_json' | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title.trim());
  }
  if (updates.detail !== undefined) {
    fields.push('detail = ?');
    values.push(updates.detail);
  }
  if (updates.order_index !== undefined) {
    fields.push('order_index = ?');
    values.push(updates.order_index);
  }
  if (updates.associations_json !== undefined) {
    fields.push('associations_json = ?');
    values.push(updates.associations_json);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE today_plan_items SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTodayPlanItem(id: string): number {
  return db.prepare('DELETE FROM today_plan_items WHERE id = ?').run(id)
    .changes;
}

export function createTodayPlanMailDraft(input: {
  plan_id: string;
  plan_date: string;
  sender_name: string;
  subject: string;
  body?: string | null;
  to_json?: string | null;
  cc_json?: string | null;
  bcc_json?: string | null;
  attachments_json?: string | null;
  status?: TodayPlanMailDraftRecord['status'];
  error_message?: string | null;
  prepared_at?: string | null;
  confirmed_at?: string | null;
  sent_at?: string | null;
}): TodayPlanMailDraftRecord {
  const now = Date.now().toString();
  const id = `today-plan-mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO today_plan_mail_drafts (
      id, plan_id, plan_date, sender_name, subject, body, to_json, cc_json, bcc_json,
      attachments_json, status, error_message, prepared_at, confirmed_at, sent_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.plan_id,
    input.plan_date,
    input.sender_name.trim(),
    input.subject.trim(),
    input.body ?? null,
    input.to_json ?? null,
    input.cc_json ?? null,
    input.bcc_json ?? null,
    input.attachments_json ?? null,
    input.status || 'drafting',
    input.error_message ?? null,
    input.prepared_at ?? null,
    input.confirmed_at ?? null,
    input.sent_at ?? null,
    now,
    now,
  );
  return db
    .prepare('SELECT * FROM today_plan_mail_drafts WHERE id = ?')
    .get(id) as TodayPlanMailDraftRecord;
}

export function getTodayPlanMailDraftById(
  id: string,
): TodayPlanMailDraftRecord | undefined {
  return db
    .prepare('SELECT * FROM today_plan_mail_drafts WHERE id = ?')
    .get(id) as TodayPlanMailDraftRecord | undefined;
}

export function listTodayPlanMailDraftsByPlan(
  planId: string,
): TodayPlanMailDraftRecord[] {
  return db
    .prepare(
      `SELECT * FROM today_plan_mail_drafts
       WHERE plan_id = ?
       ORDER BY created_at DESC`,
    )
    .all(planId) as TodayPlanMailDraftRecord[];
}

export function updateTodayPlanMailDraft(
  id: string,
  updates: Partial<
    Pick<
      TodayPlanMailDraftRecord,
      | 'sender_name'
      | 'subject'
      | 'body'
      | 'to_json'
      | 'cc_json'
      | 'bcc_json'
      | 'attachments_json'
      | 'status'
      | 'error_message'
      | 'prepared_at'
      | 'confirmed_at'
      | 'sent_at'
      | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.sender_name !== undefined) {
    fields.push('sender_name = ?');
    values.push(updates.sender_name.trim());
  }
  if (updates.subject !== undefined) {
    fields.push('subject = ?');
    values.push(updates.subject.trim());
  }
  if (updates.body !== undefined) {
    fields.push('body = ?');
    values.push(updates.body);
  }
  if (updates.to_json !== undefined) {
    fields.push('to_json = ?');
    values.push(updates.to_json);
  }
  if (updates.cc_json !== undefined) {
    fields.push('cc_json = ?');
    values.push(updates.cc_json);
  }
  if (updates.bcc_json !== undefined) {
    fields.push('bcc_json = ?');
    values.push(updates.bcc_json);
  }
  if (updates.attachments_json !== undefined) {
    fields.push('attachments_json = ?');
    values.push(updates.attachments_json);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.error_message !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.error_message);
  }
  if (updates.prepared_at !== undefined) {
    fields.push('prepared_at = ?');
    values.push(updates.prepared_at);
  }
  if (updates.confirmed_at !== undefined) {
    fields.push('confirmed_at = ?');
    values.push(updates.confirmed_at);
  }
  if (updates.sent_at !== undefined) {
    fields.push('sent_at = ?');
    values.push(updates.sent_at);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE today_plan_mail_drafts SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function cancelPendingTodayPlanMailDrafts(planId: string): number {
  return db
    .prepare(
      `DELETE FROM today_plan_mail_drafts
       WHERE plan_id = ?
         AND status IN ('drafting', 'pending_confirm', 'failed')`,
    )
    .run(planId).changes;
}

// --- Structured memory accessors ---

export function createMemory(input: {
  group_folder: string;
  layer: 'working' | 'episodic' | 'canonical';
  memory_type: 'preference' | 'rule' | 'fact' | 'summary';
  content: string;
  source?: string;
  metadata?: string;
}): MemoryRecord {
  const now = Date.now().toString();
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO memories (id, group_folder, layer, memory_type, status, content, source, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.group_folder,
    input.layer,
    input.memory_type,
    'active',
    input.content.trim(),
    input.source || 'manual',
    input.metadata || null,
    now,
    now,
  );
  reconcileMemoryStatuses(input.group_folder);
  return db
    .prepare(`SELECT * FROM memories WHERE id = ?`)
    .get(id) as MemoryRecord;
}

function searchMemoriesByStatus(
  groupFolder: string,
  query: string,
  limit: number,
  statusSql: string,
): MemorySearchResult[] {
  try {
    return db
      .prepare(
        `
      SELECT m.id, m.layer, m.memory_type, m.content, m.updated_at, bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.group_folder = ?
        AND ${statusSql}
      ORDER BY score ASC, m.updated_at DESC
      LIMIT ?
    `,
      )
      .all(query, groupFolder, limit) as MemorySearchResult[];
  } catch (err) {
    logger.error({ err, groupFolder, query }, 'Memory FTS search failed');
    return [];
  }
}

export function searchMemories(
  groupFolder: string,
  query: string,
  limit: number = 10,
): MemorySearchResult[] {
  return searchMemoriesByStatus(
    groupFolder,
    query,
    limit,
    `m.status != 'deprecated'`,
  );
}

export function searchMemoriesActive(
  groupFolder: string,
  query: string,
  limit: number = 10,
): MemorySearchResult[] {
  return searchMemoriesByStatus(
    groupFolder,
    query,
    limit,
    `m.status = 'active'`,
  );
}

export function listMemories(
  groupFolder: string,
  limit: number = 20,
): MemoryRecord[] {
  return db
    .prepare(
      `
      SELECT * FROM memories
      WHERE group_folder = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    )
    .all(groupFolder, limit) as MemoryRecord[];
}

export function getMemoryById(id: string): MemoryRecord | undefined {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | MemoryRecord
    | undefined;
}

export function updateMemory(
  id: string,
  updates: Partial<
    Pick<
      MemoryRecord,
      'content' | 'layer' | 'memory_type' | 'source' | 'status' | 'metadata'
    >
  >,
): void {
  const existing = getMemoryById(id);
  if (!existing) return;
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now().toString()];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content.trim());
  }
  if (updates.layer !== undefined) {
    fields.push('layer = ?');
    values.push(updates.layer);
  }
  if (updates.memory_type !== undefined) {
    fields.push('memory_type = ?');
    values.push(updates.memory_type);
  }
  if (updates.source !== undefined) {
    fields.push('source = ?');
    values.push(updates.source);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(updates.metadata);
  }

  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  if (updates.status === undefined || updates.status !== 'deprecated') {
    reconcileMemoryStatuses(existing.group_folder);
  }
}

export function deleteMemory(id: string): void {
  const existing = getMemoryById(id);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  if (existing) reconcileMemoryStatuses(existing.group_folder);
}

// --- Full-text search ---

export interface SearchResult {
  sender_name: string;
  content: string;
  timestamp: string;
  rank: number;
}

export interface MemoryDuplicateGroup {
  key: string;
  ids: string[];
}

export interface MemoryConflictGroup {
  key: string;
  positiveIds: string[];
  negativeIds: string[];
}

export interface MemoryDoctorReport {
  total: number;
  duplicateGroups: MemoryDuplicateGroup[];
  conflictGroups: MemoryConflictGroup[];
  staleWorkingIds: string[];
}

export interface MemoryGcResult {
  dryRun: boolean;
  duplicateDeletedIds: string[];
  staleDeletedIds: string[];
}

export interface MemoryMetricSummary {
  hours: number;
  total: number;
  byEvent: Array<{ event: string; count: number }>;
}

export interface MemoryExtractConfig {
  canonical_max: number;
  working_max: number;
  episodic_max: number;
  canonical_min_confidence: number;
  working_min_confidence: number;
  episodic_min_confidence: number;
}

const MEMORY_EXTRACT_DEFAULT_CONFIG: MemoryExtractConfig = {
  canonical_max: 3,
  working_max: 4,
  episodic_max: 1,
  canonical_min_confidence: 0.8,
  working_min_confidence: 0.55,
  episodic_min_confidence: 0.65,
};

function normalizeMemoryText(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[，。！？；：,.!?;:]/g, ' ')
    .trim();
}

function getPolarity(content: string): 1 | -1 | 0 {
  const c = content.toLowerCase();
  const hasNegative = /(never|don't|do not|不要|不能|不许|禁止)/.test(c);
  const hasPositive = /(always|must|请务必|必须|总是)/.test(c);
  if (hasNegative && !hasPositive) return -1;
  if (hasPositive && !hasNegative) return 1;
  return 0;
}

function polarityKey(content: string): string {
  return normalizeMemoryText(content)
    .replace(
      /\b(always|must|never|don't|do not)\b|不要|不能|不许|禁止|请务必|必须|总是/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function reconcileMemoryStatuses(groupFolder: string): void {
  // Reset non-deprecated rows to active first.
  db.prepare(
    `UPDATE memories
     SET status = 'active'
     WHERE group_folder = ? AND status != 'deprecated'`,
  ).run(groupFolder);

  const rows = db
    .prepare(
      `SELECT id, layer, memory_type, content, status
       FROM memories
       WHERE group_folder = ? AND status != 'deprecated'
       ORDER BY updated_at DESC`,
    )
    .all(groupFolder) as Array<{
    id: string;
    layer: string;
    memory_type: string;
    content: string;
    status: string;
  }>;

  const conflictMap = new Map<
    string,
    { positiveIds: string[]; negativeIds: string[] }
  >();
  for (const row of rows) {
    const polarity = getPolarity(row.content);
    if (polarity === 0) continue;
    const key = `${row.layer}|${row.memory_type}|${polarityKey(row.content)}`;
    if (!key || key.endsWith('|')) continue;
    const slot = conflictMap.get(key) || { positiveIds: [], negativeIds: [] };
    if (polarity > 0) slot.positiveIds.push(row.id);
    else slot.negativeIds.push(row.id);
    conflictMap.set(key, slot);
  }

  const markStmt = db.prepare(
    `UPDATE memories SET status = 'conflicted' WHERE id = ?`,
  );
  for (const slot of conflictMap.values()) {
    if (slot.positiveIds.length === 0 || slot.negativeIds.length === 0)
      continue;
    for (const id of [...slot.positiveIds, ...slot.negativeIds]) {
      markStmt.run(id);
    }
  }
}

export interface ResolveConflictKeepResult {
  kept: MemoryRecord;
  deprecated: MemoryRecord;
}

export interface ResolveConflictMergeResult {
  merged: MemoryRecord;
  deprecated: [MemoryRecord, MemoryRecord];
}

export function resolveConflict(
  mode: 'keep',
  opts: { keepId: string; deprecateId: string; groupFolder: string },
): ResolveConflictKeepResult;
export function resolveConflict(
  mode: 'merge',
  opts: {
    mergeIds: [string, string];
    mergedContent: string;
    groupFolder: string;
  },
): ResolveConflictMergeResult;
export function resolveConflict(
  mode: 'keep' | 'merge',
  opts: {
    keepId?: string;
    deprecateId?: string;
    mergeIds?: [string, string];
    mergedContent?: string;
    groupFolder: string;
  },
): ResolveConflictKeepResult | ResolveConflictMergeResult {
  const now = new Date().toISOString();

  if (mode === 'keep') {
    const { keepId, deprecateId, groupFolder } = opts;
    if (!keepId || !deprecateId)
      throw new Error('keep mode requires keepId and deprecateId');

    const keepMem = getMemoryById(keepId);
    const deprecateMem = getMemoryById(deprecateId);
    if (!keepMem) throw new Error(`Memory not found: ${keepId}`);
    if (!deprecateMem) throw new Error(`Memory not found: ${deprecateId}`);
    if (keepMem.group_folder !== groupFolder)
      throw new Error(
        `Memory ${keepId} does not belong to group ${groupFolder}`,
      );
    if (deprecateMem.group_folder !== groupFolder)
      throw new Error(
        `Memory ${deprecateId} does not belong to group ${groupFolder}`,
      );
    if (keepMem.status !== 'conflicted')
      throw new Error(
        `Memory ${keepId} is not conflicted (status: ${keepMem.status})`,
      );
    if (deprecateMem.status !== 'conflicted')
      throw new Error(
        `Memory ${deprecateId} is not conflicted (status: ${deprecateMem.status})`,
      );

    const txn = db.transaction(() => {
      updateMemory(deprecateId, {
        status: 'deprecated',
        metadata: JSON.stringify({
          deprecated_reason: 'conflict_resolution',
          resolved_by: 'keep',
          resolved_at: now,
          counterpart_id: keepId,
        }),
      });
      updateMemory(keepId, {
        status: 'active',
        metadata: JSON.stringify({
          resolved_conflict_with: deprecateId,
          resolved_at: now,
        }),
      });
    });
    txn();

    reconcileMemoryStatuses(groupFolder);

    return {
      kept: getMemoryById(keepId)!,
      deprecated: getMemoryById(deprecateId)!,
    };
  }

  // merge mode
  const { mergeIds, mergedContent, groupFolder } = opts;
  if (!mergeIds || mergeIds.length !== 2)
    throw new Error('merge mode requires exactly 2 mergeIds');
  if (!mergedContent) throw new Error('merge mode requires mergedContent');

  const memA = getMemoryById(mergeIds[0]);
  const memB = getMemoryById(mergeIds[1]);
  if (!memA) throw new Error(`Memory not found: ${mergeIds[0]}`);
  if (!memB) throw new Error(`Memory not found: ${mergeIds[1]}`);
  if (memA.group_folder !== groupFolder)
    throw new Error(
      `Memory ${mergeIds[0]} does not belong to group ${groupFolder}`,
    );
  if (memB.group_folder !== groupFolder)
    throw new Error(
      `Memory ${mergeIds[1]} does not belong to group ${groupFolder}`,
    );
  if (memA.status !== 'conflicted')
    throw new Error(
      `Memory ${mergeIds[0]} is not conflicted (status: ${memA.status})`,
    );
  if (memB.status !== 'conflicted')
    throw new Error(
      `Memory ${mergeIds[1]} is not conflicted (status: ${memB.status})`,
    );

  let newMem: MemoryRecord;

  const txn = db.transaction(() => {
    updateMemory(mergeIds[0], {
      status: 'deprecated',
      metadata: JSON.stringify({
        deprecated_reason: 'conflict_resolution',
        resolved_by: 'merge',
        resolved_at: now,
        counterpart_id: mergeIds[1],
      }),
    });
    updateMemory(mergeIds[1], {
      status: 'deprecated',
      metadata: JSON.stringify({
        deprecated_reason: 'conflict_resolution',
        resolved_by: 'merge',
        resolved_at: now,
        counterpart_id: mergeIds[0],
      }),
    });
    newMem = createMemory({
      group_folder: memA.group_folder,
      layer: memA.layer,
      memory_type: memA.memory_type,
      content: mergedContent,
      source: 'conflict_resolution',
      metadata: JSON.stringify({
        merged_from: [mergeIds[0], mergeIds[1]],
        resolved_at: now,
      }),
    });
  });
  txn();

  reconcileMemoryStatuses(groupFolder);

  return {
    merged: newMem!,
    deprecated: [getMemoryById(mergeIds[0])!, getMemoryById(mergeIds[1])!],
  };
}

export function doctorMemories(
  groupFolder: string,
  staleWorkingDays: number = 7,
): MemoryDoctorReport {
  const memories = listMemories(groupFolder, 2000);
  const duplicateMap = new Map<string, string[]>();
  for (const m of memories) {
    const key = `${m.layer}|${m.memory_type}|${normalizeMemoryText(m.content)}`;
    const arr = duplicateMap.get(key) || [];
    arr.push(m.id);
    duplicateMap.set(key, arr);
  }

  const duplicateGroups: MemoryDuplicateGroup[] = [];
  for (const [key, ids] of duplicateMap.entries()) {
    if (ids.length > 1) duplicateGroups.push({ key, ids });
  }

  const conflictMap = new Map<
    string,
    { positiveIds: string[]; negativeIds: string[] }
  >();
  for (const m of memories) {
    const polarity = getPolarity(m.content);
    if (polarity === 0) continue;
    const key = `${m.layer}|${m.memory_type}|${polarityKey(m.content)}`;
    if (!key || key.endsWith('|')) continue;
    const slot = conflictMap.get(key) || { positiveIds: [], negativeIds: [] };
    if (polarity > 0) slot.positiveIds.push(m.id);
    else slot.negativeIds.push(m.id);
    conflictMap.set(key, slot);
  }

  const conflictGroups: MemoryConflictGroup[] = [];
  for (const [key, slot] of conflictMap.entries()) {
    if (slot.positiveIds.length > 0 && slot.negativeIds.length > 0) {
      conflictGroups.push({
        key,
        positiveIds: slot.positiveIds,
        negativeIds: slot.negativeIds,
      });
    }
  }

  const staleCutoff = Date.now() - staleWorkingDays * 24 * 60 * 60 * 1000;
  const staleWorkingIds = memories
    .filter((m) => m.layer === 'working')
    .filter(
      (m) => Number(m.updated_at) > 0 && Number(m.updated_at) < staleCutoff,
    )
    .map((m) => m.id);

  return {
    total: memories.length,
    duplicateGroups,
    conflictGroups,
    staleWorkingIds,
  };
}

export function gcMemories(
  groupFolder: string,
  opts?: { dryRun?: boolean; staleWorkingDays?: number },
): MemoryGcResult {
  const dryRun = opts?.dryRun !== undefined ? opts.dryRun : true;
  const staleWorkingDays = opts?.staleWorkingDays ?? 14;
  const memories = listMemories(groupFolder, 4000);

  const dupGroups = new Map<string, MemoryRecord[]>();
  for (const m of memories) {
    const key = `${m.layer}|${m.memory_type}|${normalizeMemoryText(m.content)}`;
    const arr = dupGroups.get(key) || [];
    arr.push(m);
    dupGroups.set(key, arr);
  }

  const duplicateDeletedIds: string[] = [];
  for (const arr of dupGroups.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    for (const m of arr.slice(1)) duplicateDeletedIds.push(m.id);
  }

  const cutoff = Date.now() - staleWorkingDays * 24 * 60 * 60 * 1000;
  const staleDeletedIds = memories
    .filter((m) => m.layer === 'working')
    .filter((m) => Number(m.updated_at) > 0 && Number(m.updated_at) < cutoff)
    .map((m) => m.id);

  if (!dryRun) {
    const ids = Array.from(
      new Set([...duplicateDeletedIds, ...staleDeletedIds]),
    );
    const stmt = db.prepare(`DELETE FROM memories WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  return {
    dryRun,
    duplicateDeletedIds,
    staleDeletedIds,
  };
}

export function recordMemoryMetric(
  groupFolder: string,
  event: string,
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO memory_metrics (group_folder, event, detail, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(groupFolder, event, detail || null, Date.now().toString());
}

export function getMemoryMetricSummary(
  groupFolder: string,
  hours: number = 24,
): MemoryMetricSummary {
  const safeHours = Math.max(1, Math.min(hours, 24 * 30));
  const since = Date.now() - safeHours * 60 * 60 * 1000;
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM memory_metrics
       WHERE group_folder = ? AND CAST(created_at AS INTEGER) >= ?`,
    )
    .get(groupFolder, since) as { cnt: number };

  const byEvent = db
    .prepare(
      `SELECT event, COUNT(*) as count
       FROM memory_metrics
       WHERE group_folder = ? AND CAST(created_at AS INTEGER) >= ?
       GROUP BY event
       ORDER BY count DESC, event ASC`,
    )
    .all(groupFolder, since) as Array<{ event: string; count: number }>;

  return {
    hours: safeHours,
    total: totalRow.cnt || 0,
    byEvent,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  return Math.max(min, Math.min(max, n));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function getMemoryExtractConfig(
  groupFolder: string,
): MemoryExtractConfig {
  const rows = db
    .prepare(
      `SELECT group_folder, key, value
       FROM memory_extract_config
       WHERE group_folder IN ('*', ?)`,
    )
    .all(groupFolder) as Array<{
    group_folder: string;
    key: string;
    value: string;
  }>;

  const cfg: MemoryExtractConfig = { ...MEMORY_EXTRACT_DEFAULT_CONFIG };
  rows
    .sort(
      (a, b) =>
        (a.group_folder === '*' ? -1 : 1) - (b.group_folder === '*' ? -1 : 1),
    )
    .forEach((row) => {
      const raw = Number(row.value);
      switch (row.key) {
        case 'canonical_max':
          cfg.canonical_max = clampInt(raw, 0, 20);
          break;
        case 'working_max':
          cfg.working_max = clampInt(raw, 0, 50);
          break;
        case 'episodic_max':
          cfg.episodic_max = clampInt(raw, 0, 10);
          break;
        case 'canonical_min_confidence':
          cfg.canonical_min_confidence = clampFloat(raw, 0, 1);
          break;
        case 'working_min_confidence':
          cfg.working_min_confidence = clampFloat(raw, 0, 1);
          break;
        case 'episodic_min_confidence':
          cfg.episodic_min_confidence = clampFloat(raw, 0, 1);
          break;
        default:
          break;
      }
    });

  return cfg;
}

export function setMemoryExtractConfig(
  groupFolder: string,
  key: keyof MemoryExtractConfig,
  value: number,
): void {
  db.prepare(
    `INSERT INTO memory_extract_config (group_folder, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_folder, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(groupFolder, key, String(value), Date.now().toString());
}

/**
 * Search messages using FTS5 full-text search, scoped to a group's chat JIDs.
 */
export function searchMessages(
  groupFolder: string,
  query: string,
  limit: number = 10,
): SearchResult[] {
  // Find chat JIDs associated with this group folder
  const group = db
    .prepare(`SELECT jid FROM registered_groups WHERE folder = ?`)
    .get(groupFolder) as { jid: string } | undefined;

  if (!group) return [];

  const chatJid = group.jid;

  try {
    const results = db
      .prepare(
        `
      SELECT m.sender_name, m.content, m.timestamp, fts.rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
        AND m.chat_jid = ?
      ORDER BY fts.rank
      LIMIT ?
    `,
      )
      .all(query, chatJid, limit) as SearchResult[];
    return results;
  } catch (err) {
    logger.error({ err, groupFolder, query }, 'FTS search failed');
    return [];
  }
}

// --- Wiki accessors ---

export function createWikiMaterial(record: WikiMaterialRecord): void {
  db.prepare(
    `INSERT INTO wiki_materials (
      id, title, source_kind, note, source_name, source_path, stored_path,
      extracted_text_path, sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.title,
    record.source_kind,
    record.note,
    record.source_name,
    record.source_path,
    record.stored_path,
    record.extracted_text_path,
    record.sha256,
    record.created_at,
    record.updated_at,
  );
}

export function getWikiMaterial(
  id: string,
): WikiMaterialRecord | undefined {
  return db
    .prepare('SELECT * FROM wiki_materials WHERE id = ?')
    .get(id) as WikiMaterialRecord | undefined;
}

export function listWikiMaterials(limit: number = 200): WikiMaterialRecord[] {
  return db
    .prepare(
      'SELECT * FROM wiki_materials ORDER BY created_at DESC LIMIT ?',
    )
    .all(Math.max(1, limit)) as WikiMaterialRecord[];
}

export function deleteWikiMaterialRecord(id: string): void {
  db.prepare('DELETE FROM wiki_materials WHERE id = ?').run(id);
}

export function createWikiDraft(record: WikiDraftRecord): void {
  db.prepare(
    `INSERT INTO wiki_drafts (
      id, target_slug, title, page_kind, status, instruction, content_markdown,
      summary, payload_json, material_ids_json, file_path, created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.target_slug,
    record.title,
    record.page_kind,
    record.status,
    record.instruction,
    record.content_markdown,
    record.summary,
    record.payload_json,
    record.material_ids_json,
    record.file_path,
    record.created_at,
    record.updated_at,
    record.published_at,
  );
}

export function updateWikiDraft(
  id: string,
  patch: Partial<WikiDraftRecord>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updated_at ?? new Date().toISOString()];
  const assign = <K extends keyof WikiDraftRecord>(key: K) => {
    if (patch[key] !== undefined) {
      fields.push(`${String(key)} = ?`);
      values.push(patch[key]);
    }
  };

  assign('target_slug');
  assign('title');
  assign('page_kind');
  assign('status');
  assign('instruction');
  assign('content_markdown');
  assign('summary');
  assign('payload_json');
  assign('material_ids_json');
  assign('file_path');
  assign('created_at');
  assign('published_at');

  values.push(id);
  db.prepare(
    `UPDATE wiki_drafts SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getWikiDraft(id: string): WikiDraftRecord | undefined {
  return db
    .prepare('SELECT * FROM wiki_drafts WHERE id = ?')
    .get(id) as WikiDraftRecord | undefined;
}

export function listWikiDrafts(limit: number = 200): WikiDraftRecord[] {
  return db
    .prepare(
      'SELECT * FROM wiki_drafts ORDER BY updated_at DESC LIMIT ?',
    )
    .all(Math.max(1, limit)) as WikiDraftRecord[];
}

export function deleteWikiDraftRecord(id: string): void {
  db.prepare('DELETE FROM wiki_drafts WHERE id = ?').run(id);
}

const WIKI_PAGE_SELECT_COLUMNS = `
  slug,
  title,
  page_kind,
  status,
  summary,
  content_markdown,
  file_path,
  created_at,
  updated_at
`;

const WIKI_PAGE_SELECT_COLUMNS_P = `
  p.slug,
  p.title,
  p.page_kind,
  p.status,
  p.summary,
  p.content_markdown,
  p.file_path,
  p.created_at,
  p.updated_at
`;

export function upsertWikiPage(record: WikiPageRecord): void {
  const searchAliases = buildWikiSearchAliases(record.slug, record.title);
  db.prepare(
    `INSERT INTO wiki_pages (
      slug, title, page_kind, status, summary, content_markdown, search_aliases,
      file_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      page_kind = excluded.page_kind,
      status = excluded.status,
      summary = excluded.summary,
      content_markdown = excluded.content_markdown,
      search_aliases = excluded.search_aliases,
      file_path = excluded.file_path,
      updated_at = excluded.updated_at`,
  ).run(
    record.slug,
    record.title,
    record.page_kind,
    record.status,
    record.summary,
    record.content_markdown,
    searchAliases,
    record.file_path,
    record.created_at,
    record.updated_at,
  );
}

export function getWikiPage(slug: string): WikiPageRecord | undefined {
  return db
    .prepare(`SELECT ${WIKI_PAGE_SELECT_COLUMNS} FROM wiki_pages WHERE slug = ?`)
    .get(slug) as WikiPageRecord | undefined;
}

export function listWikiPages(limit: number = 200): WikiPageRecord[] {
  return db
    .prepare(
      `SELECT ${WIKI_PAGE_SELECT_COLUMNS}
       FROM wiki_pages
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, limit)) as WikiPageRecord[];
}

export function listWikiPagesReferencingMaterial(
  materialId: string,
): WikiPageRecord[] {
  return db
    .prepare(
      `
        SELECT DISTINCT
          ${WIKI_PAGE_SELECT_COLUMNS_P}
        FROM wiki_pages p
        LEFT JOIN wiki_page_materials pm
          ON pm.page_slug = p.slug
        LEFT JOIN wiki_claims c
          ON c.owner_page_slug = p.slug
         AND c.status = 'active'
        LEFT JOIN wiki_claim_evidence e
          ON e.claim_id = c.id
        WHERE pm.material_id = ? OR e.material_id = ?
        ORDER BY p.updated_at DESC
      `,
    )
    .all(materialId, materialId) as WikiPageRecord[];
}

export function deleteWikiPageRecord(slug: string): void {
  db.prepare('DELETE FROM wiki_pages WHERE slug = ?').run(slug);
}

export function replaceWikiPageMaterials(
  pageSlug: string,
  materialIds: string[],
): void {
  const deleteStmt = db.prepare(
    'DELETE FROM wiki_page_materials WHERE page_slug = ?',
  );
  const insertStmt = db.prepare(
    `INSERT INTO wiki_page_materials (page_slug, material_id, created_at)
     VALUES (?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const uniqueIds = [...new Set(materialIds.filter(Boolean))];
  const txn = db.transaction(() => {
    deleteStmt.run(pageSlug);
    for (const materialId of uniqueIds) {
      insertStmt.run(pageSlug, materialId, now);
    }
  });
  txn();
}

export function listWikiPageMaterials(pageSlug: string): WikiMaterialRecord[] {
  return db
    .prepare(
      `SELECT m.*
       FROM wiki_page_materials pm
       JOIN wiki_materials m ON m.id = pm.material_id
       WHERE pm.page_slug = ?
       ORDER BY pm.created_at ASC`,
    )
    .all(pageSlug) as WikiMaterialRecord[];
}

export function createWikiClaim(record: WikiClaimRecord): void {
  db.prepare(
    `INSERT INTO wiki_claims (
      id, owner_page_slug, claim_type, canonical_form, statement, status,
      confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.owner_page_slug,
    record.claim_type,
    record.canonical_form,
    record.statement,
    record.status,
    record.confidence,
    record.created_at,
    record.updated_at,
  );
}

export function updateWikiClaim(
  id: string,
  patch: Partial<WikiClaimRecord>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updated_at ?? new Date().toISOString()];
  const assign = <K extends keyof WikiClaimRecord>(key: K) => {
    if (patch[key] !== undefined) {
      fields.push(`${String(key)} = ?`);
      values.push(patch[key]);
    }
  };

  assign('owner_page_slug');
  assign('claim_type');
  assign('canonical_form');
  assign('statement');
  assign('status');
  assign('confidence');
  assign('created_at');

  values.push(id);
  db.prepare(
    `UPDATE wiki_claims SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function listWikiClaimsByPage(
  pageSlug: string,
  opts: { includeDeprecated?: boolean } = {},
): WikiClaimRecord[] {
  if (opts.includeDeprecated) {
    return db
      .prepare(
        `SELECT * FROM wiki_claims
         WHERE owner_page_slug = ?
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(pageSlug) as WikiClaimRecord[];
  }

  return db
    .prepare(
      `SELECT * FROM wiki_claims
       WHERE owner_page_slug = ? AND status = 'active'
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(pageSlug) as WikiClaimRecord[];
}

export function replaceWikiClaimEvidence(
  claimId: string,
  evidence: Array<{
    material_id: string;
    excerpt_text: string;
    locator?: string | null;
  }>,
): void {
  const deleteStmt = db.prepare(
    'DELETE FROM wiki_claim_evidence WHERE claim_id = ?',
  );
  const insertStmt = db.prepare(
    `INSERT INTO wiki_claim_evidence (
      id, claim_id, material_id, excerpt_text, locator, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    deleteStmt.run(claimId);
    for (const item of evidence) {
      insertStmt.run(
        `wiki-ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        claimId,
        item.material_id,
        item.excerpt_text,
        item.locator ?? null,
        now,
      );
    }
  });
  txn();
}

export function listWikiClaimEvidence(
  claimId: string,
): WikiClaimEvidenceRecord[] {
  return db
    .prepare(
      `SELECT * FROM wiki_claim_evidence
       WHERE claim_id = ?
       ORDER BY created_at ASC`,
    )
    .all(claimId) as WikiClaimEvidenceRecord[];
}

export function countWikiClaimEvidenceByMaterial(materialId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM wiki_claim_evidence
       WHERE material_id = ?`,
    )
    .get(materialId) as { cnt: number } | undefined;
  return row?.cnt || 0;
}

export function replaceWikiRelationsForPage(
  pageSlug: string,
  relations: Array<{
    to_page_slug: string;
    relation_type: string;
    rationale?: string | null;
  }>,
): void {
  const deleteStmt = db.prepare(
    'DELETE FROM wiki_relations WHERE from_page_slug = ?',
  );
  const insertStmt = db.prepare(
    `INSERT INTO wiki_relations (
      id, from_page_slug, to_page_slug, relation_type, rationale, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    deleteStmt.run(pageSlug);
    for (const relation of relations) {
      insertStmt.run(
        `wiki-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        pageSlug,
        relation.to_page_slug,
        relation.relation_type,
        relation.rationale ?? null,
        now,
      );
    }
  });
  txn();
}

export function listWikiRelationsForPage(
  pageSlug: string,
): WikiRelationRecord[] {
  return db
    .prepare(
      `SELECT * FROM wiki_relations
       WHERE from_page_slug = ?
       ORDER BY created_at ASC`,
    )
    .all(pageSlug) as WikiRelationRecord[];
}

export function listWikiRelationsToPage(
  pageSlug: string,
): WikiRelationRecord[] {
  return db
    .prepare(
      `SELECT * FROM wiki_relations
       WHERE to_page_slug = ?
       ORDER BY created_at ASC`,
    )
    .all(pageSlug) as WikiRelationRecord[];
}

export function deleteWikiPageGraph(pageSlug: string): void {
  const listClaimIdsStmt = db.prepare(
    'SELECT id FROM wiki_claims WHERE owner_page_slug = ?',
  );
  const deleteClaimEvidenceStmt = db.prepare(
    'DELETE FROM wiki_claim_evidence WHERE claim_id = ?',
  );
  const deleteClaimsStmt = db.prepare(
    'DELETE FROM wiki_claims WHERE owner_page_slug = ?',
  );
  const deletePageMaterialsStmt = db.prepare(
    'DELETE FROM wiki_page_materials WHERE page_slug = ?',
  );
  const deleteRelationsStmt = db.prepare(
    'DELETE FROM wiki_relations WHERE from_page_slug = ? OR to_page_slug = ?',
  );
  const deletePageStmt = db.prepare('DELETE FROM wiki_pages WHERE slug = ?');

  const txn = db.transaction(() => {
    const claimIds = listClaimIdsStmt.all(pageSlug) as Array<{ id: string }>;
    for (const claim of claimIds) {
      deleteClaimEvidenceStmt.run(claim.id);
    }
    deleteClaimsStmt.run(pageSlug);
    deletePageMaterialsStmt.run(pageSlug);
    deleteRelationsStmt.run(pageSlug, pageSlug);
    deletePageStmt.run(pageSlug);
  });
  txn();
}

export function clearAllWikiRecords(): {
  material_count: number;
  draft_count: number;
  page_count: number;
  claim_count: number;
  evidence_count: number;
  relation_count: number;
  job_count: number;
} {
  const countRow = (table: string): number => {
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
      .get() as { cnt: number } | undefined;
    return row?.cnt || 0;
  };

  const summary = {
    material_count: countRow('wiki_materials'),
    draft_count: countRow('wiki_drafts'),
    page_count: countRow('wiki_pages'),
    claim_count: countRow('wiki_claims'),
    evidence_count: countRow('wiki_claim_evidence'),
    relation_count: countRow('wiki_relations'),
    job_count: countRow('wiki_jobs'),
  };

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM wiki_claim_evidence').run();
    db.prepare('DELETE FROM wiki_claims').run();
    db.prepare('DELETE FROM wiki_page_materials').run();
    db.prepare('DELETE FROM wiki_relations').run();
    db.prepare('DELETE FROM wiki_pages').run();
    db.prepare('DELETE FROM wiki_drafts').run();
    db.prepare('DELETE FROM wiki_materials').run();
    db.prepare('DELETE FROM wiki_jobs').run();
  });
  txn();

  return summary;
}

export function createWikiJob(record: WikiJobRecord): void {
  db.prepare(
    `INSERT INTO wiki_jobs (
      id, job_type, status, payload_json, result_json, error_message,
      created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.job_type,
    record.status,
    record.payload_json,
    record.result_json,
    record.error_message,
    record.created_at,
    record.updated_at,
    record.started_at,
    record.finished_at,
  );
}

export function updateWikiJob(
  id: string,
  patch: Partial<WikiJobRecord>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updated_at ?? new Date().toISOString()];
  const assign = <K extends keyof WikiJobRecord>(key: K) => {
    if (patch[key] !== undefined) {
      fields.push(`${String(key)} = ?`);
      values.push(patch[key]);
    }
  };

  assign('job_type');
  assign('status');
  assign('payload_json');
  assign('result_json');
  assign('error_message');
  assign('created_at');
  assign('started_at');
  assign('finished_at');

  values.push(id);
  db.prepare(
    `UPDATE wiki_jobs SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getWikiJob(id: string): WikiJobRecord | undefined {
  return db
    .prepare('SELECT * FROM wiki_jobs WHERE id = ?')
    .get(id) as WikiJobRecord | undefined;
}

export function listWikiJobs(limit: number = 100): WikiJobRecord[] {
  return db
    .prepare(
      'SELECT * FROM wiki_jobs ORDER BY created_at DESC LIMIT ?',
    )
    .all(Math.max(1, limit)) as WikiJobRecord[];
}

export function deleteWikiJobRecord(id: string): void {
  db.prepare('DELETE FROM wiki_jobs WHERE id = ?').run(id);
}

export function listPendingWikiJobs(): WikiJobRecord[] {
  return db
    .prepare(
      `SELECT * FROM wiki_jobs
       WHERE status IN ('pending', 'running')
       ORDER BY created_at ASC`,
    )
    .all() as WikiJobRecord[];
}

export function searchWikiPages(
  query: string,
  limit: number = 10,
): WikiSearchResult[] {
  const safeLimit = Math.max(1, limit);
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    return db
      .prepare(
        `
          SELECT
            p.slug,
            p.title,
            p.page_kind,
            p.summary,
            p.content_markdown,
            bm25(wiki_pages_fts) AS score
          FROM wiki_pages_fts
          JOIN wiki_pages p ON p.rowid = wiki_pages_fts.rowid
          WHERE wiki_pages_fts MATCH ?
          ORDER BY score
          LIMIT ?
        `,
      )
      .all(trimmed, safeLimit) as WikiSearchResult[];
  } catch (err) {
    logger.warn({ err, query }, 'Wiki FTS search failed, falling back to LIKE');
    const like = `%${trimmed.replace(/[%_]/g, '')}%`;
    return db
      .prepare(
        `
          SELECT
            slug,
            title,
            page_kind,
            summary,
            content_markdown,
            0 AS score
          FROM wiki_pages
          WHERE
            slug LIKE ? OR
            title LIKE ? OR
            COALESCE(summary, '') LIKE ? OR
            content_markdown LIKE ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(like, like, like, like, safeLimit) as WikiSearchResult[];
  }
}

// --- Agent query accessors ---

export function createAgentQuery(record: AgentQueryRecord): void {
  db.prepare(
    `INSERT INTO agent_queries (
      id,
      query_id,
      run_id,
      source_type,
      source_ref_id,
      chat_jid,
      group_folder,
      workflow_id,
      stage_key,
      delegation_id,
      session_id,
      selected_model,
      selected_model_reason,
      actual_model,
      prompt_hash,
      memory_pack_hash,
      tools_hash,
      mounts_hash,
      status,
      current_step_id,
      current_phase,
      current_action,
      failure_type,
      failure_subtype,
      failure_origin,
      failure_retryable,
      error_message,
      output_digest,
      output_preview,
      first_output_at,
      first_tool_at,
      last_event_at,
      started_at,
      ended_at,
      latency_ms,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.query_id,
    record.run_id,
    record.source_type,
    record.source_ref_id,
    record.chat_jid,
    record.group_folder,
    record.workflow_id,
    record.stage_key,
    record.delegation_id,
    record.session_id,
    record.selected_model,
    record.selected_model_reason,
    record.actual_model,
    record.prompt_hash,
    record.memory_pack_hash,
    record.tools_hash,
    record.mounts_hash,
    record.status,
    record.current_step_id,
    record.current_phase,
    record.current_action,
    record.failure_type,
    record.failure_subtype,
    record.failure_origin,
    record.failure_retryable,
    record.error_message,
    record.output_digest,
    record.output_preview,
    record.first_output_at,
    record.first_tool_at,
    record.last_event_at,
    record.started_at,
    record.ended_at,
    record.latency_ms,
    record.created_at,
    record.updated_at,
  );
}

export function updateAgentQuery(
  queryId: string,
  patch: Partial<AgentQueryRecord>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updated_at ?? new Date().toISOString()];
  const assign = <K extends keyof AgentQueryRecord>(key: K) => {
    if (patch[key] !== undefined) {
      fields.push(`${String(key)} = ?`);
      values.push(patch[key]);
    }
  };

  assign('run_id');
  assign('source_type');
  assign('source_ref_id');
  assign('chat_jid');
  assign('group_folder');
  assign('workflow_id');
  assign('stage_key');
  assign('delegation_id');
  assign('session_id');
  assign('selected_model');
  assign('selected_model_reason');
  assign('actual_model');
  assign('prompt_hash');
  assign('memory_pack_hash');
  assign('tools_hash');
  assign('mounts_hash');
  assign('status');
  assign('current_step_id');
  assign('current_phase');
  assign('current_action');
  assign('failure_type');
  assign('failure_subtype');
  assign('failure_origin');
  assign('failure_retryable');
  assign('error_message');
  assign('output_digest');
  assign('output_preview');
  assign('first_output_at');
  assign('first_tool_at');
  assign('last_event_at');
  assign('started_at');
  assign('ended_at');
  assign('latency_ms');
  assign('created_at');

  values.push(queryId);
  db.prepare(
    `UPDATE agent_queries SET ${fields.join(', ')} WHERE query_id = ?`,
  ).run(...values);
}

export function getAgentQuery(queryId: string): AgentQueryRecord | undefined {
  return db
    .prepare('SELECT * FROM agent_queries WHERE query_id = ?')
    .get(queryId) as AgentQueryRecord | undefined;
}

export interface ListAgentQueriesOptions {
  sourceType?: AgentQuerySourceType;
  sourceRefId?: string;
}

export function listAgentQueries(
  limit: number = 50,
  offset: number = 0,
  options: ListAgentQueriesOptions = {},
): AgentQueryRecord[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.sourceType) {
    conditions.push('source_type = ?');
    values.push(options.sourceType);
  }
  if (options.sourceRefId !== undefined) {
    conditions.push('source_ref_id = ?');
    values.push(options.sourceRefId);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';
  return db
    .prepare(
      `SELECT * FROM agent_queries ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, Math.max(offset, 0)) as AgentQueryRecord[];
}

export function createAgentQueryStep(record: AgentQueryStepRecord): void {
  db.prepare(
    `INSERT INTO agent_query_steps (
      id,
      query_id,
      step_index,
      step_type,
      step_name,
      status,
      summary,
      payload_json,
      started_at,
      ended_at,
      latency_ms,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.query_id,
    record.step_index,
    record.step_type,
    record.step_name,
    record.status,
    record.summary,
    record.payload_json,
    record.started_at,
    record.ended_at,
    record.latency_ms,
    record.created_at,
    record.updated_at,
  );
}

export function updateAgentQueryStep(
  stepId: string,
  patch: Partial<AgentQueryStepRecord>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [patch.updated_at ?? new Date().toISOString()];
  const assign = <K extends keyof AgentQueryStepRecord>(key: K) => {
    if (patch[key] !== undefined) {
      fields.push(`${String(key)} = ?`);
      values.push(patch[key]);
    }
  };

  assign('query_id');
  assign('step_index');
  assign('step_type');
  assign('step_name');
  assign('status');
  assign('summary');
  assign('payload_json');
  assign('started_at');
  assign('ended_at');
  assign('latency_ms');
  assign('created_at');

  values.push(stepId);
  db.prepare(
    `UPDATE agent_query_steps SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function listAgentQuerySteps(runId: string): AgentQueryStepRecord[] {
  return db
    .prepare(
      'SELECT * FROM agent_query_steps WHERE query_id = ? ORDER BY step_index ASC',
    )
    .all(runId) as AgentQueryStepRecord[];
}

export function createAgentQueryEvent(record: AgentQueryEventRecord): void {
  db.prepare(
    `INSERT INTO agent_query_events (
      id,
      query_id,
      step_id,
      event_index,
      event_type,
      event_name,
      status,
      summary,
      payload_json,
      started_at,
      ended_at,
      latency_ms,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.query_id,
    record.step_id,
    record.event_index,
    record.event_type,
    record.event_name,
    record.status,
    record.summary,
    record.payload_json,
    record.started_at,
    record.ended_at,
    record.latency_ms,
    record.created_at,
  );
}

export function listAgentQueryEvents(queryId: string): AgentQueryEventRecord[] {
  return db
    .prepare(
      'SELECT * FROM agent_query_events WHERE query_id = ? ORDER BY event_index ASC',
    )
    .all(queryId) as AgentQueryEventRecord[];
}

export function deleteAgentQuery(queryId: string): void {
  db.prepare('DELETE FROM agent_query_events WHERE query_id = ?').run(queryId);
  db.prepare('DELETE FROM agent_query_steps WHERE query_id = ?').run(queryId);
  db.prepare('DELETE FROM agent_queries WHERE query_id = ?').run(queryId);
}

export function deleteAgentQueriesBySource(
  sourceType: AgentQuerySourceType,
  sourceRefId: string,
): number {
  const queryIds = db
    .prepare(
      'SELECT query_id FROM agent_queries WHERE source_type = ? AND source_ref_id = ?',
    )
    .all(sourceType, sourceRefId) as Array<{ query_id: string }>;

  if (queryIds.length === 0) return 0;

  const deleteMany = db.transaction((rows: Array<{ query_id: string }>) => {
    let deleted = 0;
    for (const row of rows) {
      deleteAgentQuery(row.query_id);
      deleted += 1;
    }
    return deleted;
  });

  return deleteMany(queryIds);
}

export function deleteHistoricalAgentQueries(
  activeQueryIds: string[] = [],
): number {
  const uniqueActiveIds = [...new Set(activeQueryIds.filter(Boolean))];
  const deleteEventsStmt = db.prepare(
    'DELETE FROM agent_query_events WHERE query_id = ?',
  );
  const deleteStepsStmt = db.prepare(
    'DELETE FROM agent_query_steps WHERE query_id = ?',
  );
  const deleteQueryStmt = db.prepare(
    'DELETE FROM agent_queries WHERE query_id = ?',
  );
  let deleted = 0;

  const queryIds = uniqueActiveIds.length
    ? db
        .prepare(
          `SELECT query_id FROM agent_queries WHERE query_id NOT IN (${uniqueActiveIds
            .map(() => '?')
            .join(', ')})`,
        )
        .all(...uniqueActiveIds)
    : db.prepare('SELECT query_id FROM agent_queries').all();

  const runDelete = db.transaction((rows: unknown[]) => {
    for (const row of rows) {
      const queryId = String((row as { query_id: string }).query_id);
      deleteEventsStmt.run(queryId);
      deleteStepsStmt.run(queryId);
      deleted += Number(deleteQueryStmt.run(queryId).changes || 0);
    }
  });

  runDelete(queryIds);
  return deleted;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
