import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, REPOS_DIR } from './config.js';
import {
  createTodayPlan,
  createTodayPlanItem,
  deleteTodayPlanItem,
  getTodayPlanByDate,
  getTodayPlanById,
  getTodayPlanItemById,
  listStoredMessagesByChat,
  listStoredMessagesByIds,
  listTodayPlanItems,
  listTodayPlans,
  updateTodayPlan,
  updateTodayPlanItem,
} from './db.js';
import { logger } from './logger.js';
import {
  type RegisteredGroup,
  type StoredChatMessageRecord,
  type TodayPlanItemRecord,
  type TodayPlanRecord,
} from './types.js';
import {
  listWebMessagesByChat,
  listWebMessagesByIds,
  type WebMessage,
} from './web-db.js';
import { getWorkbenchTaskDetail, type WorkbenchTaskDetail } from './workbench.js';
import { WORKFLOW_CONTEXT_KEYS } from './workflow-context.js';

interface ServiceConfig {
  repo_path?: string;
  default_branch?: string;
  staging?: {
    branch?: string;
  };
}

export interface TodayPlanChatSelection {
  group_jid: string;
  message_ids: string[];
}

export interface TodayPlanServiceSelection {
  service: string;
  branches: string[];
}

export interface TodayPlanAssociations {
  workbench_task_ids: string[];
  chat_selections: TodayPlanChatSelection[];
  services: TodayPlanServiceSelection[];
}

export interface TodayPlanConversationMessage {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  workflow_id: string | null;
  reply_to_id?: string | null;
  reply_preview?: string | null;
}

export interface TodayPlanChatGroupDetail {
  group_jid: string;
  group_name: string;
  message_count: number;
  messages: TodayPlanConversationMessage[];
}

export interface TodayPlanTaskAssociationDetail {
  task_id: string;
  title: string;
  description: string;
  service: string;
  workflow_stage_label: string;
  workflow_status_label: string;
  task_state: string;
  task: WorkbenchTaskDetail['task'];
  action_items: WorkbenchTaskDetail['action_items'];
}

export interface TodayPlanServiceCommit {
  hash: string;
  short_hash: string;
  author: string;
  committed_at: string;
  subject: string;
}

export interface TodayPlanServiceBranchDetail {
  name: string;
  source: 'manual' | 'workbench';
  ref: string | null;
  commits: TodayPlanServiceCommit[];
  error?: string;
}

export interface TodayPlanServiceDetail {
  service: string;
  repo_path: string | null;
  repo_exists: boolean;
  branches: TodayPlanServiceBranchDetail[];
}

export interface TodayPlanItemDetail {
  id: string;
  title: string;
  detail: string;
  order_index: number;
  associations: TodayPlanAssociations;
  related_tasks: TodayPlanTaskAssociationDetail[];
  related_chats: TodayPlanChatGroupDetail[];
  related_services: TodayPlanServiceDetail[];
  created_at: string;
  updated_at: string;
}

export interface TodayPlanDetail {
  plan: TodayPlanRecord;
  items: TodayPlanItemDetail[];
  continued_from: {
    plan: TodayPlanRecord;
    items: TodayPlanItemDetail[];
  } | null;
}

export interface TodayPlanServiceOption {
  service: string;
  repo_path: string | null;
  default_branch: string;
  staging_branch: string;
  repo_exists: boolean;
}

export interface TodayPlanServiceBranchOption {
  name: string;
  source: 'local' | 'remote';
  current: boolean;
  default_branch: boolean;
  staging_branch: boolean;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizePlanTitle(planDate: string): string {
  return `${planDate} 今日计划`;
}

function getPlanStatus(plan: TodayPlanRecord | null | undefined): TodayPlanRecord['status'] {
  if (plan?.status === 'completed' || plan?.status === 'continued') {
    return plan.status;
  }
  return 'active';
}

function isPlanContinuable(plan: TodayPlanRecord, planDate: string): boolean {
  return (
    getPlanStatus(plan) === 'active' &&
    typeof plan.plan_date === 'string' &&
    plan.plan_date < planDate
  );
}

function isPlanEditable(plan: TodayPlanRecord | null | undefined): boolean {
  return Boolean(plan && getPlanStatus(plan) === 'active');
}

export function getTodayPlanDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toMessageTimestamp(value: string): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMessagesChronologically<T extends { timestamp: string }>(
  messages: T[],
): T[] {
  return [...messages].sort((a, b) => {
    const timeDiff = toMessageTimestamp(a.timestamp) - toMessageTimestamp(b.timestamp);
    if (timeDiff !== 0) return timeDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

function toConversationMessage(
  message: StoredChatMessageRecord,
): TodayPlanConversationMessage {
  return {
    id: message.id,
    sender: message.sender,
    sender_name: message.sender_name,
    content: message.content,
    timestamp: message.timestamp,
    is_from_me: message.is_from_me === 1,
    is_bot_message: message.is_bot_message === 1,
    workflow_id: message.workflow_id || null,
  };
}

function buildWebReplyPreviewMap(messages: WebMessage[]): Map<string, string> {
  const previewById = new Map<string, string>();
  for (const message of messages) {
    if (!message?.id) continue;
    const normalized = (message.content || '').replace(/\s+/g, ' ').trim();
    previewById.set(message.id, truncateText(normalized || '无内容', 80));
  }
  return previewById;
}

function toWebConversationMessages(
  messages: WebMessage[],
  replySourceMessages: WebMessage[] = [],
): TodayPlanConversationMessage[] {
  const replyPreviewById = buildWebReplyPreviewMap([
    ...replySourceMessages,
    ...messages,
  ]);
  return messages.map((message) => ({
    id: message.id,
    sender: message.sender,
    sender_name: message.sender_name,
    content: message.content,
    timestamp: message.timestamp,
    is_from_me: Boolean(message.is_from_me),
    is_bot_message: Boolean(message.is_bot_message),
    workflow_id: message.workflow_id || null,
    reply_to_id: message.reply_to_id || null,
    reply_preview: message.reply_to_id
      ? replyPreviewById.get(message.reply_to_id) || null
      : null,
  }));
}

function isWebChatJid(chatJid: string): boolean {
  return typeof chatJid === 'string' && chatJid.startsWith('web:');
}

function isMessageOnPlanDate(
  message: Pick<StoredChatMessageRecord, 'timestamp'> | Pick<WebMessage, 'timestamp'>,
  planDate: string,
): boolean {
  const timestamp = toMessageTimestamp(message.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  return getTodayPlanDateKey(new Date(timestamp)) === planDate;
}

function dedupeAndSortChatMessages(
  messages: TodayPlanConversationMessage[],
): TodayPlanConversationMessage[] {
  const byId = new Map<string, TodayPlanConversationMessage>();
  for (const message of messages) {
    if (!message?.id) continue;
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort(
    (a, b) => toMessageTimestamp(a.timestamp) - toMessageTimestamp(b.timestamp),
  );
}

function normalizeAssociations(
  raw: string | null | undefined,
): TodayPlanAssociations {
  if (!raw) {
    return {
      workbench_task_ids: [],
      chat_selections: [],
      services: [],
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TodayPlanAssociations>;
    const workbenchTaskIds = Array.isArray(parsed.workbench_task_ids)
      ? Array.from(
          new Set(
            parsed.workbench_task_ids.filter(
              (item): item is string =>
                typeof item === 'string' && item.trim().length > 0,
            ),
          ),
        )
      : [];
    const chatSelections = Array.isArray(parsed.chat_selections)
      ? parsed.chat_selections
          .filter(
            (item): item is TodayPlanChatSelection =>
              Boolean(item) &&
              typeof item.group_jid === 'string' &&
              Array.isArray(item.message_ids),
          )
          .map((item) => ({
            group_jid: item.group_jid,
            message_ids: Array.from(
              new Set(
                (Array.isArray(item.message_ids) ? item.message_ids : []).filter(
                  (entry): entry is string =>
                    typeof entry === 'string' && entry.trim().length > 0,
                ),
              ),
            ),
          }))
          .filter((item) => item.message_ids.length > 0)
      : [];
    const services = Array.isArray(parsed.services)
      ? parsed.services
          .filter(
            (item): item is TodayPlanServiceSelection =>
              Boolean(item) &&
              typeof item.service === 'string' &&
              Array.isArray(item.branches),
          )
          .map((item) => ({
            service: item.service,
            branches: Array.from(
              new Set(
                item.branches.filter(
                  (entry): entry is string =>
                    typeof entry === 'string' && entry.trim().length > 0,
                ),
              ),
            ),
          }))
          .filter((item) => item.branches.length > 0)
      : [];

    return {
      workbench_task_ids: workbenchTaskIds,
      chat_selections: chatSelections,
      services,
    };
  } catch {
    return {
      workbench_task_ids: [],
      chat_selections: [],
      services: [],
    };
  }
}

function serializeAssociations(input: TodayPlanAssociations): string {
  return JSON.stringify({
    workbench_task_ids: Array.from(new Set(input.workbench_task_ids)),
    chat_selections: input.chat_selections.map((item) => ({
      group_jid: item.group_jid,
      message_ids: Array.from(new Set(item.message_ids || [])),
    })),
    services: input.services.map((item) => ({
      service: item.service,
      branches: Array.from(new Set(item.branches)),
    })),
  });
}

export function getTodayPlanOverview(planDate: string = getTodayPlanDateKey()) {
  return {
    today: getTodayPlanByDate(planDate) || null,
    history: listTodayPlans({ before_date: planDate, limit: 20 }),
  };
}

export function ensureTodayPlan(planDate: string = getTodayPlanDateKey()) {
  return (
    getTodayPlanByDate(planDate) ||
    createTodayPlan({
      plan_date: planDate,
      title: normalizePlanTitle(planDate),
      status: 'active',
    })
  );
}

export function createOrContinueTodayPlan(input: {
  planDate?: string;
  continueFromPlanId?: string;
} = {}): TodayPlanRecord {
  const planDate = input.planDate || getTodayPlanDateKey();
  const existing = getTodayPlanByDate(planDate);
  if (existing) {
    if (
      input.continueFromPlanId &&
      existing.continued_from_plan_id !== input.continueFromPlanId
    ) {
      throw new Error('今日计划已存在，无法继续其他往日计划');
    }
    return existing;
  }

  if (input.continueFromPlanId) {
    const sourcePlan = getTodayPlanById(input.continueFromPlanId);
    if (!sourcePlan) {
      throw new Error('要继续的往日计划不存在');
    }
    if (!isPlanContinuable(sourcePlan, planDate)) {
      throw new Error('仅支持继续未完成的往日计划');
    }
    const now = Date.now().toString();
    const created = createTodayPlan({
      plan_date: planDate,
      title: normalizePlanTitle(planDate),
      status: 'active',
      continued_from_plan_id: sourcePlan.id,
    });
    updateTodayPlan(sourcePlan.id, {
      status: 'continued',
      updated_at: now,
    });
    return created;
  }

  return createTodayPlan({
    plan_date: planDate,
    title: normalizePlanTitle(planDate),
    status: 'active',
  });
}

export function completeTodayPlan(planId: string): TodayPlanRecord | null {
  const existing = getTodayPlanById(planId);
  if (!existing) return null;
  if (existing.status === 'completed') return existing;
  const now = Date.now().toString();
  updateTodayPlan(planId, {
    status: 'completed',
    completed_at: now,
    updated_at: now,
  });
  return getTodayPlanById(planId) || null;
}

function getTodayPlanRecord(input: {
  planId?: string;
  planDate?: string;
}): TodayPlanRecord | null {
  if (input.planId) return getTodayPlanById(input.planId) || null;
  if (input.planDate) return getTodayPlanByDate(input.planDate) || null;
  return null;
}

function getTaskDescription(detail: WorkbenchTaskDetail): string {
  const description =
    typeof detail.task.context?.[WORKFLOW_CONTEXT_KEYS.requirementDescription] ===
    'string'
      ? String(detail.task.context[WORKFLOW_CONTEXT_KEYS.requirementDescription])
      : '';
  return description.trim();
}

function getTaskWorkBranch(detail: WorkbenchTaskDetail): string {
  const branch =
    typeof detail.task.context?.[WORKFLOW_CONTEXT_KEYS.workBranch] === 'string'
      ? String(detail.task.context[WORKFLOW_CONTEXT_KEYS.workBranch])
      : '';
  return branch.trim();
}

function getServiceRegistry(): Record<string, ServiceConfig> {
  const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
  if (!fs.existsSync(servicesPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(servicesPath, 'utf-8')) as Record<
      string,
      ServiceConfig
    >;
  } catch (err) {
    logger.warn({ err, servicesPath }, 'Failed to parse services.json');
    return {};
  }
}

function resolveRepoPath(service: string): string | null {
  const registry = getServiceRegistry();
  const config = registry[service];
  if (!config?.repo_path) return null;
  return path.join(REPOS_DIR, config.repo_path);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeRunGit(repoPath: string, args: string[]): {
  ok: boolean;
  output?: string;
  error?: string;
} {
  try {
    return {
      ok: true,
      output: runGit(repoPath, args).trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
    };
  }
}

function resolveBranchRef(repoPath: string, branch: string): string | null {
  const candidates = [branch, `origin/${branch}`];
  for (const candidate of candidates) {
    const result = safeRunGit(repoPath, ['rev-parse', '--verify', candidate]);
    if (result.ok) return candidate;
  }
  return null;
}

function isMeaningfulCommitSubject(subject: string): boolean {
  return Array.from((subject || '').trim()).length >= 3;
}

export function listTodayPlanServices(): TodayPlanServiceOption[] {
  const registry = getServiceRegistry();
  return Object.keys(registry)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((service) => {
      const config = registry[service];
      const repoPath = config.repo_path ? path.join(REPOS_DIR, config.repo_path) : null;
      return {
        service,
        repo_path: config.repo_path || null,
        default_branch: config.default_branch || '',
        staging_branch: config.staging?.branch || '',
        repo_exists: Boolean(repoPath && fs.existsSync(repoPath)),
      };
    });
}

export function listTodayPlanServiceBranches(
  service: string,
): TodayPlanServiceBranchOption[] {
  const registry = getServiceRegistry();
  const config = registry[service];
  const repoPath = resolveRepoPath(service);
  if (!config || !repoPath || !fs.existsSync(repoPath)) return [];

  const result = safeRunGit(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)\t%(HEAD)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  if (!result.ok || !result.output) return [];

  const rows = result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const branchMap = new Map<string, TodayPlanServiceBranchOption>();

  for (const row of rows) {
    const [refName, headMark] = row.split('\t');
    if (!refName || refName === 'origin/HEAD') continue;
    const isRemote = refName.startsWith('origin/');
    const branchName = isRemote ? refName.slice('origin/'.length) : refName;
    const existing = branchMap.get(branchName);
    if (existing && existing.source === 'local') continue;
    branchMap.set(branchName, {
      name: branchName,
      source: isRemote ? 'remote' : 'local',
      current: headMark === '*',
      default_branch: branchName === (config.default_branch || ''),
      staging_branch: branchName === (config.staging?.branch || ''),
    });
  }

  return Array.from(branchMap.values()).sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.default_branch !== b.default_branch) return a.default_branch ? -1 : 1;
    if (a.staging_branch !== b.staging_branch) return a.staging_branch ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function listTodayPlanServiceCommits(input: {
  service: string;
  branches: string[];
  planDate: string;
}): TodayPlanServiceDetail {
  const repoPath = resolveRepoPath(input.service);
  const repoExists = Boolean(repoPath && fs.existsSync(repoPath));
  const branchDetails: TodayPlanServiceBranchDetail[] = [];

  for (const branch of Array.from(new Set(input.branches))) {
    const detail: TodayPlanServiceBranchDetail = {
      name: branch,
      source: 'manual',
      ref: null,
      commits: [],
    };

    if (!repoExists || !repoPath) {
      detail.error = '服务仓库不存在';
      branchDetails.push(detail);
      continue;
    }

    const resolvedRef = resolveBranchRef(repoPath, branch);
    detail.ref = resolvedRef;
    if (!resolvedRef) {
      detail.error = '分支不存在';
      branchDetails.push(detail);
      continue;
    }

    const result = safeRunGit(repoPath, [
      'log',
      resolvedRef,
      `--since=${input.planDate} 00:00:00`,
      `--until=${input.planDate} 23:59:59`,
      '--date=iso-strict',
      '--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s',
      '--no-merges',
      '-n',
      '50',
    ]);

    if (!result.ok) {
      detail.error = result.error || '获取提交记录失败';
      branchDetails.push(detail);
      continue;
    }

    detail.commits = (result.output || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, committedAt, subject] = line.split('\t');
        return {
          hash,
          short_hash: shortHash,
          author,
          committed_at: committedAt,
          subject,
        };
      })
      .filter((commit) => isMeaningfulCommitSubject(commit.subject));
    branchDetails.push(detail);
  }

  return {
    service: input.service,
    repo_path: repoPath,
    repo_exists: repoExists,
    branches: branchDetails,
  };
}

export function getTodayPlanServiceCommitDiff(input: {
  service: string;
  commit: string;
}) {
  const repoPath = resolveRepoPath(input.service);
  if (!repoPath || !fs.existsSync(repoPath)) {
    return {
      service: input.service,
      repo_path: repoPath,
      repo_exists: false,
      error: '服务仓库不存在',
    };
  }

  try {
    const raw = runGit(repoPath, [
      'show',
      '--date=iso-strict',
      '--format=%H%x00%an%x00%ad%x00%s%x00%b%x00',
      '--patch',
      '--stat=160,120',
      '--no-color',
      input.commit,
    ]);
    const parts = raw.split('\0');
    const [hash, author, committedAt, subject, body, diff = ''] = parts;
    return {
      service: input.service,
      repo_path: repoPath,
      repo_exists: true,
      commit: {
        hash,
        author,
        committed_at: committedAt,
        subject,
        body: (body || '').trim(),
      },
      diff: diff.trim(),
    };
  } catch (err) {
    return {
      service: input.service,
      repo_path: repoPath,
      repo_exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function listTodayPlanChatMessages(
  chatJid: string,
  planDate: string = getTodayPlanDateKey(),
): TodayPlanConversationMessage[] {
  if (isWebChatJid(chatJid)) {
    const messages = listWebMessagesByChat(chatJid, 2000)
      .filter((message) => isMessageOnPlanDate(message, planDate))
      .sort((a, b) => toMessageTimestamp(b.timestamp) - toMessageTimestamp(a.timestamp))
      .slice(0, 200);
    return dedupeAndSortChatMessages(toWebConversationMessages(messages));
  }

  const messages = listStoredMessagesByChat(chatJid, 2000)
    .filter((message) => isMessageOnPlanDate(message, planDate))
    .sort((a, b) => toMessageTimestamp(b.timestamp) - toMessageTimestamp(a.timestamp))
    .slice(0, 200)
    .map(toConversationMessage);
  return dedupeAndSortChatMessages(messages);
}

function getTodayPlanChatMessagesBySelection(
  selection: TodayPlanChatSelection,
): TodayPlanConversationMessage[] {
  if (isWebChatJid(selection.group_jid)) {
    const directMessages = listWebMessagesByIds(
      selection.group_jid,
      selection.message_ids,
    );
    const replySourceIds = Array.from(
      new Set(
        directMessages
          .map((message) => message.reply_to_id || '')
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const replySourceMessages =
      replySourceIds.length > 0
        ? listWebMessagesByIds(selection.group_jid, replySourceIds)
        : [];
    return dedupeAndSortChatMessages(
      toWebConversationMessages(directMessages, replySourceMessages),
    );
  }

  const directMessages =
    Array.isArray(selection.message_ids) && selection.message_ids.length > 0
      ? listStoredMessagesByIds(selection.group_jid, selection.message_ids).map(
          toConversationMessage,
        )
      : [];
  return dedupeAndSortChatMessages(directMessages);
}

function mergeServiceSelections(input: {
  manual: TodayPlanServiceSelection[];
  tasks: WorkbenchTaskDetail[];
  planDate: string;
}): TodayPlanServiceDetail[] {
  const serviceBranches = new Map<
    string,
    Map<string, 'manual' | 'workbench'>
  >();

  for (const selection of input.manual) {
    const branches = serviceBranches.get(selection.service) || new Map();
    for (const branch of selection.branches) {
      branches.set(branch, 'manual');
    }
    serviceBranches.set(selection.service, branches);
  }

  for (const taskDetail of input.tasks) {
    const service = taskDetail.task.service;
    const branch = getTaskWorkBranch(taskDetail);
    if (!service || !branch) continue;
    const branches = serviceBranches.get(service) || new Map();
    if (!branches.has(branch)) {
      branches.set(branch, 'workbench');
    }
    serviceBranches.set(service, branches);
  }

  return Array.from(serviceBranches.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(([service, branches]) => {
      const detail = listTodayPlanServiceCommits({
        service,
        branches: Array.from(branches.keys()),
        planDate: input.planDate,
      });
      detail.branches = detail.branches.map((branchDetail) => ({
        ...branchDetail,
        source: branches.get(branchDetail.name) || 'manual',
      }));
      return detail;
    });
}

function buildTodayPlanItemDetail(input: {
  item: TodayPlanItemRecord;
  planDate: string;
  groups: Record<string, RegisteredGroup>;
}): TodayPlanItemDetail {
  const associations = normalizeAssociations(input.item.associations_json);
  const taskDetails = associations.workbench_task_ids
    .map((taskId) => getWorkbenchTaskDetail(taskId))
    .filter((item): item is WorkbenchTaskDetail => Boolean(item));
  const relatedTasks: TodayPlanTaskAssociationDetail[] = taskDetails.map(
    (detail) => ({
      task_id: detail.task.id,
      title: detail.task.title,
      description: getTaskDescription(detail),
      service: detail.task.service,
      workflow_stage_label: detail.task.workflow_stage_label,
      workflow_status_label: detail.task.workflow_status_label,
      task_state: detail.task.task_state,
      task: detail.task,
      action_items: detail.action_items,
    }),
  );
  const relatedChats = associations.chat_selections
    .map((selection) => {
      const messages = getTodayPlanChatMessagesBySelection(selection);
      if (messages.length === 0) return null;
      return {
        group_jid: selection.group_jid,
        group_name:
          input.groups[selection.group_jid]?.name || selection.group_jid,
        message_count: messages.length,
        messages,
      };
    })
    .filter((item): item is TodayPlanChatGroupDetail => Boolean(item));
  const relatedServices = mergeServiceSelections({
    manual: associations.services,
    tasks: taskDetails,
    planDate: input.planDate,
  });

  return {
    id: input.item.id,
    title: input.item.title,
    detail: input.item.detail || '',
    order_index: input.item.order_index,
    associations,
    related_tasks: relatedTasks,
    related_chats: relatedChats,
    related_services: relatedServices,
    created_at: input.item.created_at,
    updated_at: input.item.updated_at,
  };
}

function buildTodayPlanItems(input: {
  planId: string;
  planDate: string;
  groups: Record<string, RegisteredGroup>;
}): TodayPlanItemDetail[] {
  return listTodayPlanItems(input.planId).map((item) =>
    buildTodayPlanItemDetail({
      item,
      planDate: input.planDate,
      groups: input.groups,
    }),
  );
}

export function getTodayPlanDetail(input: {
  planId?: string;
  planDate?: string;
  groups: Record<string, RegisteredGroup>;
}): TodayPlanDetail | null {
  const plan = getTodayPlanRecord(input);
  if (!plan) return null;
  const items = buildTodayPlanItems({
    planId: plan.id,
    planDate: plan.plan_date,
    groups: input.groups,
  });
  const continuedFromPlan =
    typeof plan.continued_from_plan_id === 'string' &&
    plan.continued_from_plan_id.trim().length > 0
      ? getTodayPlanById(plan.continued_from_plan_id) || null
      : null;
  return {
    plan,
    items,
    continued_from: continuedFromPlan
      ? {
          plan: continuedFromPlan,
          items: buildTodayPlanItems({
            planId: continuedFromPlan.id,
            planDate: continuedFromPlan.plan_date,
            groups: input.groups,
          }),
        }
      : null,
  };
}

export function createTodayPlanItemForPlan(planId: string): TodayPlanItemRecord {
  const plan = getTodayPlanById(planId);
  if (!isPlanEditable(plan)) {
    throw new Error('当前计划不可编辑');
  }
  const created = createTodayPlanItem({
    plan_id: planId,
    title: '',
    detail: '',
    associations_json: serializeAssociations({
      workbench_task_ids: [],
      chat_selections: [],
      services: [],
    }),
  });
  return created;
}

export function patchTodayPlanItem(input: {
  itemId: string;
  title?: string;
  detail?: string;
  order_index?: number;
  associations?: TodayPlanAssociations;
}): TodayPlanItemRecord | null {
  const existing = getTodayPlanItemById(input.itemId);
  if (!existing) return null;
  const plan = getTodayPlanById(existing.plan_id);
  if (!isPlanEditable(plan)) {
    throw new Error('当前计划不可编辑');
  }
  updateTodayPlanItem(input.itemId, {
    title: input.title,
    detail: input.detail,
    order_index: input.order_index,
    associations_json:
      input.associations !== undefined
        ? serializeAssociations(input.associations)
        : undefined,
    updated_at: Date.now().toString(),
  });
  return getTodayPlanItemById(input.itemId) || null;
}

export function removeTodayPlanItem(itemId: string): number {
  const existing = getTodayPlanItemById(itemId);
  if (!existing) return 0;
  const plan = getTodayPlanById(existing.plan_id);
  if (!isPlanEditable(plan)) {
    throw new Error('当前计划不可编辑');
  }
  return deleteTodayPlanItem(itemId);
}

function formatChatGroupForMail(group: TodayPlanChatGroupDetail): string {
  const lines = group.messages.slice(0, 120).map((message) => {
    const sender = message.sender_name || message.sender || '未知';
    const content = truncateText(message.content.replace(/\s+/g, ' ').trim(), 240);
    return `- [${message.timestamp}] ${sender}: ${content}`;
  });
  const suffix =
    group.messages.length > 120
      ? `\n- ... 其余 ${group.messages.length - 120} 条消息已省略`
      : '';
  return [
    `群聊：${group.group_name}`,
    `消息数：${group.message_count}`,
    ...lines,
  ].join('\n') + suffix;
}

function formatTaskForMail(task: TodayPlanTaskAssociationDetail): string {
  const actionLines =
    task.action_items.length > 0
      ? task.action_items.map(
          (item) =>
            `- [${item.status}] ${item.title}${item.body ? `：${truncateText(item.body, 180)}` : ''}`,
        )
      : ['- 无待处理项'];
  return [
    `任务：${task.title}`,
    `服务：${task.service || '未设置'}`,
    `当前节点：${task.workflow_stage_label || task.workflow_status_label}`,
    `任务态：${task.task_state}`,
    `描述：${task.description || '无'}`,
    '待处理项：',
    ...actionLines,
  ].join('\n');
}

function formatServiceForMail(service: TodayPlanServiceDetail): string {
  const branchLines =
    service.branches.length > 0
      ? service.branches.map((branch) => {
          const commitLines =
            branch.commits.length > 0
              ? branch.commits.map(
                  (commit) =>
                    `  - ${commit.short_hash} ${commit.subject} (${commit.author} ${commit.committed_at})`,
                )
              : [branch.error ? `  - 错误：${branch.error}` : '  - 今日无提交'];
          return [
            `- 分支：${branch.name}（来源：${branch.source}）`,
            ...commitLines,
          ].join('\n');
        })
      : ['- 未关联分支'];
  return [
    `服务：${service.service}`,
    `仓库：${service.repo_path || '未配置'}`,
    ...branchLines,
  ].join('\n');
}

function buildTodayPlanMailTemplate(): string {
  return [
    '1. <计划标题 1>',
    '- 根据`关联任务`、`关联群聊`、`关联服务分支` 信息汇总实际执行项列表',
    '',
    '2. <计划标题 2>',
    '- 按实际计划数量继续展开；如果只有一条计划，则不要保留这一条示例。',
  ].join('\n');
}

export function buildTodayPlanMailPrompt(input: {
  planId: string;
  groups: Record<string, RegisteredGroup>;
  name: string;
}): { plan: TodayPlanDetail; prompt: string; subject: string } | null {
  const detail = getTodayPlanDetail({
    planId: input.planId,
    groups: input.groups,
  });
  if (!detail) return null;

  const blocks = detail.items.length
    ? detail.items.map((item, index) => {
        const sections: string[] = [
          `## 计划 ${index + 1}: ${item.title || `未命名计划 ${index + 1}`}`,
          `计划内容：${item.detail || '无'}`,
        ];

        if (item.related_tasks.length > 0) {
          sections.push(
            '### 关联工作台任务',
            item.related_tasks.map(formatTaskForMail).join('\n\n'),
          );
        }

        if (item.related_chats.length > 0) {
          sections.push('### 关联群聊消息');
          for (const group of item.related_chats) {
            sections.push(formatChatGroupForMail(group));
          }
        }

        if (item.related_services.length > 0) {
          sections.push(
            '### 关联服务分支',
            item.related_services.map(formatServiceForMail).join('\n\n'),
          );
        }

        return sections.join('\n\n');
      })
    : ['## 今日计划为空\n请在邮件中明确说明当前没有具体计划项。'];

  const subject = `日报-${input.name}-${detail.plan.plan_date}`;
  const mailTemplate = buildTodayPlanMailTemplate();
  const prompt = [
    `请基于下面这份由程序聚合的结构化信息，为 ${detail.plan.plan_date} 生成一封纯文本计划邮件正文。`,
    `邮件主题固定为：${subject}。这行仅供参考，不要在输出里重复主题。`,
    '要求：',
    '1. 仅依据下面提供的信息进行总结，不要自行编造。',
    '2. 你只输出邮件正文，不要输出主题、收件人、抄送、解释、前后缀说明。',
    '3. 邮件正文按模板逐条输出计划项，每条只保留实际执行项列表。',
    '4. 每条计划的执行项只能根据对应的关联任务、关联群聊、关联服务分支信息提炼。',
    '5. 邮件正文请严格使用下面的纯文本模板输出，不要保留尖括号占位符，不要输出代码块。',
    '6. 如果没有任何计划项，请输出：',
    '1. 今日计划为空',
    '- 当前暂无明确的实际执行项',
    '',
    '# 邮件正文模板',
    mailTemplate,
    '',
    '# 结构化信息',
    ...blocks,
  ].join('\n');

  return {
    plan: detail,
    prompt,
    subject,
  };
}
