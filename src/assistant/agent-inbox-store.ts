import { randomUUID } from 'crypto';

import { getDatabase } from '../db.js';
import { emitAssistantEvent } from './assistant-events.js';
import {
  AgentInboxItemRecord,
  AgentInboxItemView,
  AgentInboxStatus,
  AssistantActionLogRecord,
  AssistantActionLogView,
  AssistantSettings,
  DEFAULT_ASSISTANT_SETTINGS,
  UpsertAgentInboxItemInput,
} from './types.js';

const SETTINGS_KEY = 'assistant';
const ACTIVE_INBOX_STATUSES: AgentInboxStatus[] = [
  'unread',
  'read',
  'snoozed',
];

function nowTs(): string {
  return Date.now().toString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function toInboxView(record: AgentInboxItemRecord): AgentInboxItemView {
  const { action_payload_json, extra_json, ...rest } = record;
  return {
    ...rest,
    action_payload: readJsonObject(action_payload_json),
    extra: readJsonObject(extra_json),
  };
}

function toActionLogView(record: AssistantActionLogRecord): AssistantActionLogView {
  const { payload_json, result_json, ...rest } = record;
  return {
    ...rest,
    payload: readJsonObject(payload_json),
    result: readJsonObject(result_json),
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function normalizeSettings(raw: unknown): AssistantSettings {
  const input = isObject(raw) ? raw : {};
  const quietHours = isObject(input.quietHours) ? input.quietHours : {};
  const dataSources = isObject(input.dataSources) ? input.dataSources : {};
  const desktopAssistant = isObject(input.desktopAssistant)
    ? input.desktopAssistant
    : {};

  const proactiveLevel =
    input.proactiveLevel === 'quiet' ||
    input.proactiveLevel === 'balanced' ||
    input.proactiveLevel === 'active'
      ? input.proactiveLevel
      : DEFAULT_ASSISTANT_SETTINGS.proactiveLevel;

  return {
    enabled:
      typeof input.enabled === 'boolean'
        ? input.enabled
        : DEFAULT_ASSISTANT_SETTINGS.enabled,
    proactiveLevel,
    scanIntervalMinutes: clampNumber(
      input.scanIntervalMinutes,
      DEFAULT_ASSISTANT_SETTINGS.scanIntervalMinutes,
      1,
      120,
    ),
    quietHours: {
      enabled:
        typeof quietHours.enabled === 'boolean'
          ? quietHours.enabled
          : DEFAULT_ASSISTANT_SETTINGS.quietHours.enabled,
      start: normalizeTime(
        quietHours.start,
        DEFAULT_ASSISTANT_SETTINGS.quietHours.start,
      ),
      end: normalizeTime(quietHours.end, DEFAULT_ASSISTANT_SETTINGS.quietHours.end),
    },
    dataSources: {
      todayPlan:
        typeof dataSources.todayPlan === 'boolean'
          ? dataSources.todayPlan
          : DEFAULT_ASSISTANT_SETTINGS.dataSources.todayPlan,
      workbench:
        typeof dataSources.workbench === 'boolean'
          ? dataSources.workbench
          : DEFAULT_ASSISTANT_SETTINGS.dataSources.workbench,
      scheduler:
        typeof dataSources.scheduler === 'boolean'
          ? dataSources.scheduler
          : DEFAULT_ASSISTANT_SETTINGS.dataSources.scheduler,
      agentRuns:
        typeof dataSources.agentRuns === 'boolean'
          ? dataSources.agentRuns
          : DEFAULT_ASSISTANT_SETTINGS.dataSources.agentRuns,
    },
    desktopAssistant: {
      autostart:
        typeof desktopAssistant.autostart === 'boolean'
          ? desktopAssistant.autostart
          : DEFAULT_ASSISTANT_SETTINGS.desktopAssistant.autostart,
      alwaysOnTop:
        typeof desktopAssistant.alwaysOnTop === 'boolean'
          ? desktopAssistant.alwaysOnTop
          : DEFAULT_ASSISTANT_SETTINGS.desktopAssistant.alwaysOnTop,
      allowMovement:
        typeof desktopAssistant.allowMovement === 'boolean'
          ? desktopAssistant.allowMovement
          : DEFAULT_ASSISTANT_SETTINGS.desktopAssistant.allowMovement,
    },
    maxInboxItems: clampNumber(
      input.maxInboxItems,
      DEFAULT_ASSISTANT_SETTINGS.maxInboxItems,
      20,
      1000,
    ),
  };
}

function mergeSettingsPatch(
  current: AssistantSettings,
  patch: Record<string, unknown>,
): AssistantSettings {
  return normalizeSettings({
    ...current,
    ...patch,
    quietHours: {
      ...current.quietHours,
      ...(isObject(patch.quietHours) ? patch.quietHours : {}),
    },
    dataSources: {
      ...current.dataSources,
      ...(isObject(patch.dataSources) ? patch.dataSources : {}),
    },
    desktopAssistant: {
      ...current.desktopAssistant,
      ...(isObject(patch.desktopAssistant) ? patch.desktopAssistant : {}),
    },
  });
}

export function getAssistantSettings(): AssistantSettings {
  const row = getDatabase()
    .prepare('SELECT value_json FROM assistant_settings WHERE key = ?')
    .get(SETTINGS_KEY) as { value_json: string } | undefined;
  if (!row) return DEFAULT_ASSISTANT_SETTINGS;
  return normalizeSettings(readJsonObject(row.value_json));
}

export function updateAssistantSettings(
  patch: Record<string, unknown>,
): AssistantSettings {
  const current = getAssistantSettings();
  const next = mergeSettingsPatch(current, patch);
  const updatedAt = nowTs();
  getDatabase()
    .prepare(
      `INSERT INTO assistant_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(SETTINGS_KEY, JSON.stringify(next), updatedAt);
  emitAssistantEvent({ type: 'settings_updated', settings: next });
  return next;
}

export function getAgentInboxItem(id: string): AgentInboxItemView | null {
  const row = getDatabase()
    .prepare('SELECT * FROM agent_inbox_items WHERE id = ?')
    .get(id) as AgentInboxItemRecord | undefined;
  return row ? toInboxView(row) : null;
}

export function getAgentInboxItemByDedupeKey(
  dedupeKey: string,
): AgentInboxItemView | null {
  const row = getDatabase()
    .prepare('SELECT * FROM agent_inbox_items WHERE dedupe_key = ?')
    .get(dedupeKey) as AgentInboxItemRecord | undefined;
  return row ? toInboxView(row) : null;
}

export function listAgentInboxItems(input: {
  status?: AgentInboxStatus | 'active' | 'all';
  limit?: number;
} = {}): AgentInboxItemView[] {
  const limit = clampNumber(input.limit, 100, 1, 1000);
  const values: unknown[] = [];
  let where = '';

  if (input.status && input.status !== 'all') {
    if (input.status === 'active') {
      where = `WHERE status IN (${ACTIVE_INBOX_STATUSES.map(() => '?').join(
        ', ',
      )})`;
      values.push(...ACTIVE_INBOX_STATUSES);
    } else {
      where = 'WHERE status = ?';
      values.push(input.status);
    }
  }

  const rows = getDatabase()
    .prepare(
      `SELECT * FROM agent_inbox_items
       ${where}
       ORDER BY
         CASE priority
           WHEN 'urgent' THEN 0
           WHEN 'high' THEN 1
           WHEN 'normal' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT ?`,
    )
    .all(...values, limit) as AgentInboxItemRecord[];
  return rows.map(toInboxView);
}

export function getAgentInboxCounts(): Record<AgentInboxStatus, number> {
  const counts: Record<AgentInboxStatus, number> = {
    unread: 0,
    read: 0,
    done: 0,
    dismissed: 0,
    snoozed: 0,
  };
  const rows = getDatabase()
    .prepare('SELECT status, COUNT(*) AS count FROM agent_inbox_items GROUP BY status')
    .all() as Array<{ status: AgentInboxStatus; count: number }>;
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.count;
  }
  return counts;
}

export function resolveActiveAgentInboxItemByDedupeKey(
  dedupeKey: string,
  status: 'done' | 'dismissed' = 'done',
): AgentInboxItemView | null {
  const existing = getAgentInboxItemByDedupeKey(dedupeKey);
  if (!existing || !ACTIVE_INBOX_STATUSES.includes(existing.status)) {
    return existing;
  }
  return updateAgentInboxItemStatus(existing.id, status);
}

export function resolveActiveAgentInboxItemsBySource(input: {
  sourceType: string;
  sourceRefId: string;
  status?: 'done' | 'dismissed';
  excludeDedupeKeys?: string[];
}): AgentInboxItemView[] {
  const activeStatusPlaceholders = ACTIVE_INBOX_STATUSES.map(() => '?').join(
    ', ',
  );
  const excludeKeys = Array.from(new Set(input.excludeDedupeKeys || [])).filter(
    Boolean,
  );
  const excludeClause =
    excludeKeys.length > 0
      ? `AND dedupe_key NOT IN (${excludeKeys.map(() => '?').join(', ')})`
      : '';
  const rows = getDatabase()
    .prepare(
      `SELECT id FROM agent_inbox_items
       WHERE source_type = ?
         AND source_ref_id = ?
         AND status IN (${activeStatusPlaceholders})
         ${excludeClause}`,
    )
    .all(
      input.sourceType,
      input.sourceRefId,
      ...ACTIVE_INBOX_STATUSES,
      ...excludeKeys,
    ) as Array<{ id: string }>;

  return rows.map((row) =>
    updateAgentInboxItemStatus(row.id, input.status || 'done'),
  );
}

export function createOrUpdateAgentInboxItem(
  input: UpsertAgentInboxItemInput,
): AgentInboxItemView {
  const existing = getAgentInboxItemByDedupeKey(input.dedupeKey);
  const now = nowTs();
  const basePayload = writeJson(input.actionPayload);
  const extraJson = writeJson(input.extra);

  if (existing) {
    if (existing.status === 'done' || existing.status === 'dismissed') {
      return existing;
    }

    const nextStatus =
      existing.status === 'snoozed' &&
      existing.snoozed_until &&
      Number(existing.snoozed_until) <= Number(now)
        ? 'unread'
        : existing.status;

    getDatabase()
      .prepare(
        `UPDATE agent_inbox_items SET
          kind = ?,
          status = ?,
          priority = ?,
          title = ?,
          body = ?,
          source_type = ?,
          source_ref_id = ?,
          action_kind = ?,
          action_label = ?,
          action_url = ?,
          action_payload_json = ?,
          due_at = ?,
          extra_json = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.kind,
        nextStatus,
        input.priority || existing.priority,
        input.title.trim(),
        input.body ?? null,
        input.sourceType,
        input.sourceRefId ?? null,
        input.actionKind ?? null,
        input.actionLabel ?? null,
        input.actionUrl ?? null,
        basePayload,
        input.dueAt ?? null,
        extraJson,
        now,
        existing.id,
      );
    const updated = getAgentInboxItem(existing.id);
    if (!updated) throw new Error('Updated inbox item not found');
    emitAssistantEvent({ type: 'inbox_updated', item: updated });
    return updated;
  }

  const id = `agent-inbox-${randomUUID()}`;
  getDatabase()
    .prepare(
      `INSERT INTO agent_inbox_items (
        id, dedupe_key, kind, status, priority, title, body, source_type,
        source_ref_id, action_kind, action_label, action_url,
        action_payload_json, created_by, created_at, updated_at, due_at,
        snoozed_until, read_at, resolved_at, extra_json
      ) VALUES (?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      id,
      input.dedupeKey,
      input.kind,
      input.priority || 'normal',
      input.title.trim(),
      input.body ?? null,
      input.sourceType,
      input.sourceRefId ?? null,
      input.actionKind ?? null,
      input.actionLabel ?? null,
      input.actionUrl ?? null,
      basePayload,
      input.createdBy || 'assistant',
      now,
      now,
      input.dueAt ?? null,
      extraJson,
    );
  const created = getAgentInboxItem(id);
  if (!created) throw new Error('Created inbox item not found');
  emitAssistantEvent({ type: 'inbox_updated', item: created });
  return created;
}

export function updateAgentInboxItemStatus(
  id: string,
  status: AgentInboxStatus,
  options: { snoozedUntil?: string | null } = {},
): AgentInboxItemView {
  const now = nowTs();
  const readAt = status === 'read' ? now : undefined;
  const resolvedAt =
    status === 'done' || status === 'dismissed' ? now : undefined;
  getDatabase()
    .prepare(
      `UPDATE agent_inbox_items SET
        status = ?,
        updated_at = ?,
        read_at = COALESCE(?, read_at),
        resolved_at = COALESCE(?, resolved_at),
        snoozed_until = ?
       WHERE id = ?`,
    )
    .run(
      status,
      now,
      readAt ?? null,
      resolvedAt ?? null,
      status === 'snoozed' ? options.snoozedUntil || now : null,
      id,
    );
  const updated = getAgentInboxItem(id);
  if (!updated) throw new Error('Agent inbox item not found');
  emitAssistantEvent({ type: 'inbox_updated', item: updated });
  return updated;
}

export function listAssistantActionLogs(limit: number = 50): AssistantActionLogView[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM assistant_action_logs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(clampNumber(limit, 50, 1, 500)) as AssistantActionLogRecord[];
  return rows.map(toActionLogView);
}

export function createAssistantActionLog(input: {
  itemId?: string | null;
  action: string;
  status: 'success' | 'error' | 'skipped';
  title?: string | null;
  body?: string | null;
  sourceType?: string | null;
  sourceRefId?: string | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): AssistantActionLogView {
  const id = `assistant-log-${randomUUID()}`;
  const now = nowTs();
  getDatabase()
    .prepare(
      `INSERT INTO assistant_action_logs (
        id, item_id, action, status, title, body, source_type, source_ref_id,
        payload_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.itemId ?? null,
      input.action,
      input.status,
      input.title ?? null,
      input.body ?? null,
      input.sourceType ?? null,
      input.sourceRefId ?? null,
      writeJson(input.payload),
      writeJson(input.result),
      now,
    );
  const row = getDatabase()
    .prepare('SELECT * FROM assistant_action_logs WHERE id = ?')
    .get(id) as AssistantActionLogRecord | undefined;
  if (!row) throw new Error('Created assistant action log not found');
  const log = toActionLogView(row);
  emitAssistantEvent({ type: 'action_logged', log });
  return log;
}

export function createAssistantSnooze(input: {
  scope: string;
  scopeRef: string;
  until: string;
  reason?: string | null;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO assistant_snoozes (id, scope, scope_ref, until, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `assistant-snooze-${randomUUID()}`,
      input.scope,
      input.scopeRef,
      input.until,
      input.reason ?? null,
      nowTs(),
    );
}
