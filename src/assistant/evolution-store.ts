import { randomUUID } from 'crypto';

import { getDatabase } from '../db.js';
import {
  createOrUpdateAgentInboxItem,
  resolveActiveAgentInboxItemByDedupeKey,
} from './agent-inbox-store.js';

export type AssistantEvolutionRiskLevel = 'unknown' | 'low' | 'medium' | 'high';

export type AssistantEvolutionStatus =
  | 'discovering'
  | 'proposal_drafting'
  | 'proposal_evaluating'
  | 'proposal_refining'
  | 'waiting_user_approval'
  | 'branch_preparing'
  | 'implementing'
  | 'checking'
  | 'reviewing'
  | 'fixing'
  | 'ready_for_adoption'
  | 'adopting'
  | 'paused'
  | 'blocked_by_policy'
  | 'adoption_failed'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AssistantEvolutionItemRecord {
  id: string;
  status: AssistantEvolutionStatus;
  module_scope: string;
  direction: string;
  proposal: string | null;
  proposal_evaluation: string | null;
  implementation_summary: string | null;
  check_summary: string | null;
  review_summary: string | null;
  bug_report: string | null;
  risk_level: AssistantEvolutionRiskLevel;
  auto_implement: number;
  auto_adopt: number;
  review_round: number;
  max_review_rounds: number;
  base_branch: string;
  work_branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  merge_commit: string | null;
  adoption_status: string | null;
  adoption_error: string | null;
  resume_status: AssistantEvolutionStatus | null;
  locked_by: string | null;
  lease_until: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AssistantEvolutionEventRecord {
  id: string;
  item_id: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

export interface AssistantEvolutionArtifactRecord {
  id: string;
  item_id: string;
  artifact_type: string;
  title: string;
  path: string | null;
  content: string | null;
  payload_json: string | null;
  created_at: string;
}

export interface AssistantEvolutionItemView extends Omit<
  AssistantEvolutionItemRecord,
  'auto_implement' | 'auto_adopt'
> {
  auto_implement: boolean;
  auto_adopt: boolean;
  events?: AssistantEvolutionEventView[];
  artifacts?: AssistantEvolutionArtifactView[];
}

export interface AssistantEvolutionEventView extends Omit<
  AssistantEvolutionEventRecord,
  'payload_json'
> {
  payload: Record<string, unknown>;
}

export interface AssistantEvolutionArtifactView extends Omit<
  AssistantEvolutionArtifactRecord,
  'payload_json'
> {
  payload: Record<string, unknown>;
}

export interface AssistantEvolutionStateView {
  activeItem: AssistantEvolutionItemView | null;
  latestItems: AssistantEvolutionItemView[];
  latestEvents: AssistantEvolutionEventView[];
}

export const RUNNING_EVOLUTION_STATUSES: AssistantEvolutionStatus[] = [
  'discovering',
  'proposal_drafting',
  'proposal_evaluating',
  'proposal_refining',
  'branch_preparing',
  'implementing',
  'checking',
  'reviewing',
  'fixing',
  'adopting',
];

export const WAITING_EVOLUTION_STATUSES: AssistantEvolutionStatus[] = [
  'waiting_user_approval',
  'ready_for_adoption',
  'paused',
  'blocked_by_policy',
  'adoption_failed',
];

export const TERMINAL_EVOLUTION_STATUSES: AssistantEvolutionStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

const VALID_EVOLUTION_STATUSES = new Set<AssistantEvolutionStatus>([
  ...RUNNING_EVOLUTION_STATUSES,
  ...WAITING_EVOLUTION_STATUSES,
  ...TERMINAL_EVOLUTION_STATUSES,
]);

const VALID_RISK_LEVELS = new Set<AssistantEvolutionRiskLevel>([
  'unknown',
  'low',
  'medium',
  'high',
]);

export function nowTs(): string {
  return Date.now().toString();
}

function readJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeJson(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function assertStatus(status: AssistantEvolutionStatus): void {
  if (!VALID_EVOLUTION_STATUSES.has(status)) {
    throw new Error(`Invalid evolution status: ${status}`);
  }
}

function normalizeRiskLevel(value: unknown): AssistantEvolutionRiskLevel {
  return typeof value === 'string' && VALID_RISK_LEVELS.has(value as never)
    ? (value as AssistantEvolutionRiskLevel)
    : 'unknown';
}

function toItemView(
  record: AssistantEvolutionItemRecord,
): AssistantEvolutionItemView {
  return {
    ...record,
    auto_implement: record.auto_implement === 1,
    auto_adopt: record.auto_adopt === 1,
  };
}

function toEventView(
  record: AssistantEvolutionEventRecord,
): AssistantEvolutionEventView {
  const { payload_json, ...rest } = record;
  return { ...rest, payload: readJsonObject(payload_json) };
}

function toArtifactView(
  record: AssistantEvolutionArtifactRecord,
): AssistantEvolutionArtifactView {
  const { payload_json, ...rest } = record;
  return { ...rest, payload: readJsonObject(payload_json) };
}

function terminalPlaceholders(): string {
  return TERMINAL_EVOLUTION_STATUSES.map(() => '?').join(', ');
}

export function createEvolutionEvent(input: {
  itemId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): AssistantEvolutionEventView {
  const id = `assistant-evolution-event-${randomUUID()}`;
  const createdAt = nowTs();
  getDatabase()
    .prepare(
      `INSERT INTO assistant_evolution_events (
        id, item_id, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.itemId,
      input.eventType,
      writeJson(input.payload),
      createdAt,
    );
  const row = getDatabase()
    .prepare('SELECT * FROM assistant_evolution_events WHERE id = ?')
    .get(id) as AssistantEvolutionEventRecord;
  return toEventView(row);
}

export function createEvolutionArtifact(input: {
  itemId: string;
  artifactType: string;
  title: string;
  path?: string | null;
  content?: string | null;
  payload?: Record<string, unknown>;
}): AssistantEvolutionArtifactView {
  const id = `assistant-evolution-artifact-${randomUUID()}`;
  const createdAt = nowTs();
  getDatabase()
    .prepare(
      `INSERT INTO assistant_evolution_artifacts (
        id, item_id, artifact_type, title, path, content, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.itemId,
      input.artifactType,
      input.title,
      input.path ?? null,
      input.content ?? null,
      writeJson(input.payload),
      createdAt,
    );
  const row = getDatabase()
    .prepare('SELECT * FROM assistant_evolution_artifacts WHERE id = ?')
    .get(id) as AssistantEvolutionArtifactRecord;
  return toArtifactView(row);
}

export function createEvolutionItem(input: {
  status?: AssistantEvolutionStatus;
  moduleScope?: string;
  direction?: string;
  riskLevel?: AssistantEvolutionRiskLevel;
  autoImplement?: boolean;
  autoAdopt?: boolean;
  maxReviewRounds?: number;
  baseBranch?: string;
}): AssistantEvolutionItemView {
  const id = `evo-${randomUUID().slice(0, 8)}`;
  const createdAt = nowTs();
  const status = input.status || 'discovering';
  assertStatus(status);
  const riskLevel = normalizeRiskLevel(input.riskLevel);

  getDatabase()
    .prepare(
      `INSERT INTO assistant_evolution_items (
        id, status, module_scope, direction, risk_level, auto_implement,
        auto_adopt, review_round, max_review_rounds, base_branch,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      status,
      input.moduleScope || 'unknown',
      input.direction || '待发现',
      riskLevel,
      input.autoImplement ? 1 : 0,
      input.autoAdopt ? 1 : 0,
      Math.max(0, Math.trunc(input.maxReviewRounds ?? 2)),
      input.baseBranch || 'main',
      createdAt,
      createdAt,
    );

  createEvolutionEvent({
    itemId: id,
    eventType: 'item_created',
    payload: { status },
  });
  const item = getEvolutionItem(id);
  if (!item) throw new Error('Created evolution item not found');
  syncEvolutionInbox(item);
  return item;
}

export function getEvolutionItem(
  id: string,
  options: { includeDetails?: boolean } = {},
): AssistantEvolutionItemView | null {
  const row = getDatabase()
    .prepare('SELECT * FROM assistant_evolution_items WHERE id = ?')
    .get(id) as AssistantEvolutionItemRecord | undefined;
  if (!row) return null;
  const item = toItemView(row);
  if (options.includeDetails) {
    item.events = listEvolutionEvents(id);
    item.artifacts = listEvolutionArtifacts(id);
  }
  return item;
}

export function listEvolutionItems(
  input: {
    limit?: number;
  } = {},
): AssistantEvolutionItemView[] {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 500);
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM assistant_evolution_items
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as AssistantEvolutionItemRecord[];
  return rows.map(toItemView);
}

export function listEvolutionEvents(
  itemId: string,
): AssistantEvolutionEventView[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM assistant_evolution_events
       WHERE item_id = ?
       ORDER BY created_at ASC`,
    )
    .all(itemId) as AssistantEvolutionEventRecord[];
  return rows.map(toEventView);
}

export function listEvolutionArtifacts(
  itemId: string,
): AssistantEvolutionArtifactView[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM assistant_evolution_artifacts
       WHERE item_id = ?
       ORDER BY created_at ASC`,
    )
    .all(itemId) as AssistantEvolutionArtifactRecord[];
  return rows.map(toArtifactView);
}

export function getActiveEvolutionItem(): AssistantEvolutionItemView | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM assistant_evolution_items
       WHERE status NOT IN (${terminalPlaceholders()})
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(...TERMINAL_EVOLUTION_STATUSES) as
    | AssistantEvolutionItemRecord
    | undefined;
  return row ? toItemView(row) : null;
}

export function listLatestEvolutionEvents(
  limit: number = 30,
): AssistantEvolutionEventView[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM assistant_evolution_events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(
      Math.min(Math.max(Math.trunc(limit), 1), 200),
    ) as AssistantEvolutionEventRecord[];
  return rows.map(toEventView);
}

export function getEvolutionState(): AssistantEvolutionStateView {
  const activeItem = getActiveEvolutionItem();
  return {
    activeItem: activeItem
      ? getEvolutionItem(activeItem.id, { includeDetails: true })
      : null,
    latestItems: listEvolutionItems({ limit: 20 }),
    latestEvents: listLatestEvolutionEvents(30),
  };
}

export function updateEvolutionItem(
  id: string,
  patch: Partial<{
    status: AssistantEvolutionStatus;
    module_scope: string;
    direction: string;
    proposal: string | null;
    proposal_evaluation: string | null;
    implementation_summary: string | null;
    check_summary: string | null;
    review_summary: string | null;
    bug_report: string | null;
    risk_level: AssistantEvolutionRiskLevel;
    auto_implement: boolean;
    auto_adopt: boolean;
    review_round: number;
    max_review_rounds: number;
    base_branch: string;
    work_branch: string | null;
    base_commit: string | null;
    head_commit: string | null;
    merge_commit: string | null;
    adoption_status: string | null;
    adoption_error: string | null;
    resume_status: AssistantEvolutionStatus | null;
    locked_by: string | null;
    lease_until: string | null;
    blocked_reason: string | null;
    completed_at: string | null;
  }>,
  eventType: string = 'item_updated',
  eventPayload: Record<string, unknown> = {},
): AssistantEvolutionItemView {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'status') assertStatus(value as AssistantEvolutionStatus);
    if (key === 'risk_level') normalizeRiskLevel(value);
    if (key === 'auto_implement' || key === 'auto_adopt') {
      assignments.push(`${key} = ?`);
      values.push(value ? 1 : 0);
      continue;
    }
    assignments.push(`${key} = ?`);
    values.push(value);
  }

  assignments.push('updated_at = ?');
  values.push(nowTs());
  values.push(id);

  getDatabase()
    .prepare(
      `UPDATE assistant_evolution_items
       SET ${assignments.join(', ')}
       WHERE id = ?`,
    )
    .run(...values);

  createEvolutionEvent({
    itemId: id,
    eventType,
    payload: eventPayload,
  });

  const item = getEvolutionItem(id);
  if (!item) throw new Error('Evolution item not found');
  syncEvolutionInbox(item);
  return item;
}

export function transitionEvolutionItem(
  id: string,
  status: AssistantEvolutionStatus,
  payload: Record<string, unknown> = {},
): AssistantEvolutionItemView {
  const completedAt = TERMINAL_EVOLUTION_STATUSES.includes(status)
    ? nowTs()
    : null;
  return updateEvolutionItem(
    id,
    {
      status,
      ...(completedAt ? { completed_at: completedAt } : {}),
    },
    'status_changed',
    { status, ...payload },
  );
}

export function tryAcquireEvolutionLease(input: {
  lockOwner: string;
  leaseMs: number;
}): boolean {
  const now = nowTs();
  const leaseUntil = String(Date.now() + input.leaseMs);
  const tx = getDatabase().transaction(() => {
    const runtimeLock = getDatabase()
      .prepare(
        `SELECT locked_by FROM assistant_runtime_locks
         WHERE key = 'assistant_evolution'
           AND CAST(lease_until AS INTEGER) > CAST(? AS INTEGER)
         LIMIT 1`,
      )
      .get(now) as { locked_by: string } | undefined;
    if (runtimeLock) return false;

    getDatabase()
      .prepare(
        `INSERT INTO assistant_runtime_locks (key, locked_by, lease_until, updated_at)
         VALUES ('assistant_evolution', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           locked_by = excluded.locked_by,
           lease_until = excluded.lease_until,
           updated_at = excluded.updated_at`,
      )
      .run(input.lockOwner, leaseUntil, now);

    getDatabase()
      .prepare(
        `UPDATE assistant_evolution_items
         SET locked_by = ?, lease_until = ?, updated_at = ?
         WHERE status NOT IN (${terminalPlaceholders()})`,
      )
      .run(input.lockOwner, leaseUntil, now, ...TERMINAL_EVOLUTION_STATUSES);
    return true;
  });
  return tx();
}

export function renewEvolutionLease(input: {
  lockOwner: string;
  leaseMs: number;
}): boolean {
  const now = nowTs();
  const leaseUntil = String(Date.now() + input.leaseMs);
  const tx = getDatabase().transaction(() => {
    const updated = getDatabase()
      .prepare(
        `UPDATE assistant_runtime_locks
         SET lease_until = ?,
             updated_at = ?
         WHERE key = 'assistant_evolution'
           AND locked_by = ?`,
      )
      .run(leaseUntil, now, input.lockOwner);
    if (updated.changes === 0) return false;

    getDatabase()
      .prepare(
        `UPDATE assistant_evolution_items
         SET lease_until = ?,
             updated_at = ?
         WHERE locked_by = ?
           AND status NOT IN (${terminalPlaceholders()})`,
      )
      .run(leaseUntil, now, input.lockOwner, ...TERMINAL_EVOLUTION_STATUSES);
    return true;
  });
  return tx();
}

export function releaseEvolutionLease(lockOwner: string): void {
  getDatabase()
    .prepare(
      `DELETE FROM assistant_runtime_locks
       WHERE key = 'assistant_evolution'
         AND locked_by = ?`,
    )
    .run(lockOwner);
  getDatabase()
    .prepare(
      `UPDATE assistant_evolution_items
       SET locked_by = NULL,
           lease_until = NULL,
           updated_at = ?
       WHERE locked_by = ?`,
    )
    .run(nowTs(), lockOwner);
}

export function syncEvolutionInbox(item: AssistantEvolutionItemView): void {
  const dedupeKey = `assistant_evolution:${item.id}`;
  if (TERMINAL_EVOLUTION_STATUSES.includes(item.status)) {
    resolveActiveAgentInboxItemByDedupeKey(dedupeKey);
    return;
  }

  const title =
    item.status === 'ready_for_adoption'
      ? `自我进化待采纳：${item.direction}`
      : item.status === 'waiting_user_approval'
        ? `自我进化方案待确认：${item.direction}`
        : item.status === 'adoption_failed'
          ? `自我进化采纳失败：${item.direction}`
        : item.status === 'blocked_by_policy'
          ? `自我进化被策略阻断：${item.direction}`
          : `自我进化进行中：${item.direction}`;
  const body = [
    `状态：${item.status}`,
    `模块：${item.module_scope || 'unknown'}`,
    `风险：${item.risk_level || 'unknown'}`,
    item.blocked_reason ? `原因：${item.blocked_reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const primaryAction =
    item.status === 'waiting_user_approval'
      ? {
          kind: 'assistant_evolution_approve_implementation',
          label: '确认实现',
        }
      : item.status === 'ready_for_adoption'
        ? { kind: 'assistant_evolution_adopt', label: '采纳方案' }
        : item.status === 'adoption_failed' || item.status === 'paused'
          ? { kind: 'assistant_evolution_resume', label: '继续' }
          : !TERMINAL_EVOLUTION_STATUSES.includes(item.status) &&
              item.status !== 'blocked_by_policy'
            ? { kind: 'assistant_evolution_pause', label: '暂停' }
            : { kind: 'open_assistant_evolution', label: '查看详情' };

  createOrUpdateAgentInboxItem({
    dedupeKey,
    kind:
      item.status === 'blocked_by_policy' || item.status === 'adoption_failed'
        ? 'risk'
        : item.status === 'waiting_user_approval' ||
            item.status === 'ready_for_adoption'
          ? 'approval'
          : 'notification',
    priority:
      item.status === 'blocked_by_policy' || item.status === 'adoption_failed'
        ? 'high'
        : 'normal',
    title,
    body,
    sourceType: 'assistant_evolution',
    sourceRefId: item.id,
    actionKind: primaryAction.kind,
    actionLabel: primaryAction.label,
    actionUrl: `/api/assistant/evolution/items/${encodeURIComponent(item.id)}`,
    actionPayload: { evolutionItemId: item.id, actionKind: primaryAction.kind },
    extra: {
      evolutionStatus: item.status,
      riskLevel: item.risk_level,
      evolutionActions: {
        canApprove: item.status === 'waiting_user_approval',
        canAdopt: item.status === 'ready_for_adoption',
        canPause:
          !TERMINAL_EVOLUTION_STATUSES.includes(item.status) &&
          item.status !== 'paused',
        canResume: item.status === 'paused' || item.status === 'adoption_failed',
        canCancel: !TERMINAL_EVOLUTION_STATUSES.includes(item.status),
      },
      cardActions: [
        item.status === 'waiting_user_approval'
          ? {
              action: 'assistant_evolution_action',
              item_id: item.id,
              evolution_action: 'approve-implementation',
              label: '确认实现',
            }
          : null,
        item.status === 'ready_for_adoption'
          ? {
              action: 'assistant_evolution_action',
              item_id: item.id,
              evolution_action: 'adopt',
              label: '采纳方案',
            }
          : null,
        item.status === 'paused' || item.status === 'adoption_failed'
          ? {
              action: 'assistant_evolution_action',
              item_id: item.id,
              evolution_action: 'resume',
              label: '继续',
            }
          : null,
        !TERMINAL_EVOLUTION_STATUSES.includes(item.status) &&
        item.status !== 'paused'
          ? {
              action: 'assistant_evolution_action',
              item_id: item.id,
              evolution_action: 'pause',
              label: '暂停',
            }
          : null,
        !TERMINAL_EVOLUTION_STATUSES.includes(item.status)
          ? {
              action: 'assistant_evolution_action',
              item_id: item.id,
              evolution_action: 'cancel',
              label: '取消',
            }
          : null,
      ].filter(Boolean),
    },
  });
}
