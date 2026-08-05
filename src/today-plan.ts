import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { AGENTS_DIR, PROJECT_ROOT, REPOS_DIR } from './config.js';
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
  type RegisteredAgent,
  type StoredChatMessageRecord,
  type TodayPlanItemRecord,
  type TodayPlanRecord,
} from './types.js';
import {
  listWebMessagesByChat,
  listWebMessagesByIds,
  type WebMessage,
} from './web-db.js';

export interface ServiceConfig {
  repo_path?: string;
  default_branch?: string;
  staging?: {
    branch?: string;
  };
}

export interface TodayPlanChatSelection {
  agent_jid: string;
  message_ids: string[];
}

export interface TodayPlanServiceSelection {
  service: string;
  branches: string[];
}

export interface TodayPlanAssociations {
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
  reply_to_id?: string | null;
  reply_preview?: string | null;
}

export interface TodayPlanChatAgentDetail {
  agent_jid: string;
  agent_name: string;
  message_count: number;
  messages: TodayPlanConversationMessage[];
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
  source: 'manual';
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
  related_chats: TodayPlanChatAgentDetail[];
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

export interface RecentTodayPlanItemRef {
  plan_date: string;
  item_id: string;
  title: string;
}

export interface RecentTodayPlanServiceBranchSummary {
  name: string;
  sources: Array<'manual'>;
  plan_dates: string[];
  plan_items: RecentTodayPlanItemRef[];
  ref: string | null;
  commits: TodayPlanServiceCommit[];
  errors: string[];
}

export interface RecentTodayPlanServiceSummary {
  service: string;
  repo_path: string | null;
  repo_exists: boolean;
  plan_dates: string[];
  plan_items: RecentTodayPlanItemRef[];
  branches: RecentTodayPlanServiceBranchSummary[];
}

export interface RecentTodayPlanPlanSummary {
  id: string;
  plan_date: string;
  title: string;
  status: TodayPlanRecord['status'];
  completed_at: string | null;
  item_count: number;
  items: Array<{
    id: string;
    title: string;
    detail: string;
    order_index: number;
    services: TodayPlanServiceSelection[];
  }>;
}

export interface RecentTodayPlanDetails {
  query: {
    mode: 'recent' | 'date' | 'range';
    days: number;
    dates: string[];
    from_date: string;
    to_date: string;
    date?: string;
    start_date?: string;
    end_date?: string;
  };
  plans: RecentTodayPlanPlanSummary[];
  services: RecentTodayPlanServiceSummary[];
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

function getPlanStatus(
  plan: TodayPlanRecord | null | undefined,
): TodayPlanRecord['status'] {
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
    const timeDiff =
      toMessageTimestamp(a.timestamp) - toMessageTimestamp(b.timestamp);
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
  message:
    | Pick<StoredChatMessageRecord, 'timestamp'>
    | Pick<WebMessage, 'timestamp'>,
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
      chat_selections: [],
      services: [],
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TodayPlanAssociations>;
    const chatSelections = Array.isArray(parsed.chat_selections)
      ? parsed.chat_selections
          .filter(
            (item): item is TodayPlanChatSelection =>
              Boolean(item) &&
              typeof item.agent_jid === 'string' &&
              Array.isArray(item.message_ids),
          )
          .map((item) => ({
            agent_jid: item.agent_jid,
            message_ids: Array.from(
              new Set(
                (Array.isArray(item.message_ids)
                  ? item.message_ids
                  : []
                ).filter(
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
      : [];

    return {
      chat_selections: chatSelections,
      services,
    };
  } catch {
    return {
      chat_selections: [],
      services: [],
    };
  }
}

function serializeAssociations(input: TodayPlanAssociations): string {
  return JSON.stringify({
    chat_selections: input.chat_selections.map((item) => ({
      agent_jid: item.agent_jid,
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

export function createOrContinueTodayPlan(
  input: {
    planDate?: string;
    continueFromPlanId?: string;
  } = {},
): TodayPlanRecord {
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

function resolveRepoPathFromConfig(
  config: ServiceConfig | null | undefined,
): string | null {
  const repoPath =
    typeof config?.repo_path === 'string' ? config.repo_path.trim() : '';
  if (!repoPath) return null;
  return path.isAbsolute(repoPath) ? repoPath : path.join(REPOS_DIR, repoPath);
}

export function buildTodayPlanCurrentProjectService(input: {
  projectRoot: string;
  reposDir: string;
  serviceName?: string;
  defaultBranch?: string;
}): {
  service: string;
  config: ServiceConfig;
} | null {
  const projectRoot =
    typeof input.projectRoot === 'string' ? input.projectRoot.trim() : '';
  const reposDir =
    typeof input.reposDir === 'string' ? input.reposDir.trim() : '';
  if (!projectRoot || !reposDir) return null;

  const service = (input.serviceName || path.basename(projectRoot)).trim();
  if (!service) return null;

  const relativeRepoPath = path.relative(reposDir, projectRoot);
  const repoPath =
    relativeRepoPath &&
    !relativeRepoPath.startsWith('..') &&
    !path.isAbsolute(relativeRepoPath)
      ? relativeRepoPath
      : projectRoot;

  return {
    service,
    config: {
      repo_path: repoPath,
      default_branch: (input.defaultBranch || '').trim(),
    },
  };
}

export function mergeTodayPlanServiceRegistry(input: {
  registry: Record<string, ServiceConfig>;
  projectRoot: string;
  reposDir: string;
  serviceName?: string;
  defaultBranch?: string;
}): Record<string, ServiceConfig> {
  const merged = { ...input.registry };
  const currentProject = buildTodayPlanCurrentProjectService({
    projectRoot: input.projectRoot,
    reposDir: input.reposDir,
    serviceName: input.serviceName,
    defaultBranch: input.defaultBranch,
  });
  if (currentProject && !merged[currentProject.service]) {
    merged[currentProject.service] = currentProject.config;
  }
  return merged;
}

function getServiceRegistry(): Record<string, ServiceConfig> {
  const servicesPath = path.join(AGENTS_DIR, 'global', 'services.json');
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

function getTodayPlanServiceRegistry(): Record<string, ServiceConfig> {
  return mergeTodayPlanServiceRegistry({
    registry: getServiceRegistry(),
    projectRoot: PROJECT_ROOT,
    reposDir: REPOS_DIR,
  });
}

function resolveRepoPath(
  service: string,
  registry?: Record<string, ServiceConfig>,
): string | null {
  const registryToUse = registry || getTodayPlanServiceRegistry();
  const config = registryToUse[service];
  return resolveRepoPathFromConfig(config);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeRunGit(
  repoPath: string,
  args: string[],
): {
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
  const registry = getTodayPlanServiceRegistry();
  return Object.keys(registry)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((service) => {
      const config = registry[service];
      const repoPath = resolveRepoPathFromConfig(config);
      return {
        service,
        repo_path: config.repo_path || null,
        default_branch: config.default_branch || '',
        staging_branch: config.staging?.branch || '',
        repo_exists: Boolean(repoPath && fs.existsSync(repoPath)),
      };
    });
}

export function parseTodayPlanServiceBranchOptions(input: {
  rows: string[];
  config: ServiceConfig;
}): TodayPlanServiceBranchOption[] {
  const branchMap = new Map<string, TodayPlanServiceBranchOption>();

  for (const row of input.rows) {
    const [fullRefName, shortRefName, headMark] = row.split('\t');
    if (!fullRefName || !shortRefName) continue;
    if (fullRefName === 'refs/remotes/origin/HEAD') continue;

    const isRemote = fullRefName.startsWith('refs/remotes/origin/');
    const branchName = isRemote
      ? shortRefName.slice('origin/'.length)
      : shortRefName;
    if (!branchName) continue;

    const existing = branchMap.get(branchName);
    if (existing && existing.source === 'local') continue;

    branchMap.set(branchName, {
      name: branchName,
      source: isRemote ? 'remote' : 'local',
      current: headMark === '*',
      default_branch: branchName === (input.config.default_branch || ''),
      staging_branch: branchName === (input.config.staging?.branch || ''),
    });
  }

  return Array.from(branchMap.values()).sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.default_branch !== b.default_branch) return a.default_branch ? -1 : 1;
    if (a.staging_branch !== b.staging_branch) return a.staging_branch ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function listTodayPlanServiceBranches(
  service: string,
): TodayPlanServiceBranchOption[] {
  const registry = getTodayPlanServiceRegistry();
  const config = registry[service];
  const repoPath = resolveRepoPath(service);
  if (!config || !repoPath || !fs.existsSync(repoPath)) return [];

  const result = safeRunGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)\t%(refname:short)\t%(HEAD)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  if (!result.ok || !result.output) return [];

  return parseTodayPlanServiceBranchOptions({
    rows: result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    config,
  });
}

export function listTodayPlanServiceCommits(input: {
  service: string;
  branches: string[];
  planDate: string;
  registry?: Record<string, ServiceConfig>;
}): TodayPlanServiceDetail {
  const repoPath = resolveRepoPath(input.service, input.registry);
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
        const [hash, shortHash, author, committedAt, subject] =
          line.split('\t');
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
      .sort(
        (a, b) =>
          toMessageTimestamp(b.timestamp) - toMessageTimestamp(a.timestamp),
      )
      .slice(0, 200);
    return dedupeAndSortChatMessages(toWebConversationMessages(messages));
  }

  const messages = listStoredMessagesByChat(chatJid, 2000)
    .filter((message) => isMessageOnPlanDate(message, planDate))
    .sort(
      (a, b) =>
        toMessageTimestamp(b.timestamp) - toMessageTimestamp(a.timestamp),
    )
    .slice(0, 200)
    .map(toConversationMessage);
  return dedupeAndSortChatMessages(messages);
}

function getTodayPlanChatMessagesBySelection(
  selection: TodayPlanChatSelection,
): TodayPlanConversationMessage[] {
  if (isWebChatJid(selection.agent_jid)) {
    const directMessages = listWebMessagesByIds(
      selection.agent_jid,
      selection.message_ids,
    );
    const replySourceIds = Array.from(
      new Set(
        directMessages
          .map((message) => message.reply_to_id || '')
          .filter(
            (id): id is string =>
              typeof id === 'string' && id.trim().length > 0,
          ),
      ),
    );
    const replySourceMessages =
      replySourceIds.length > 0
        ? listWebMessagesByIds(selection.agent_jid, replySourceIds)
        : [];
    return dedupeAndSortChatMessages(
      toWebConversationMessages(directMessages, replySourceMessages),
    );
  }

  const directMessages =
    Array.isArray(selection.message_ids) && selection.message_ids.length > 0
      ? listStoredMessagesByIds(selection.agent_jid, selection.message_ids).map(
          toConversationMessage,
        )
      : [];
  return dedupeAndSortChatMessages(directMessages);
}

function mergeServiceSelections(input: {
  manual: TodayPlanServiceSelection[];
  planDate: string;
}): TodayPlanServiceDetail[] {
  const serviceBranches = new Map<string, Map<string, 'manual'>>();

  for (const selection of input.manual) {
    const branches = serviceBranches.get(selection.service) || new Map();
    for (const branch of selection.branches) {
      branches.set(branch, 'manual');
    }
    serviceBranches.set(selection.service, branches);
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
  agents: Record<string, RegisteredAgent>;
}): TodayPlanItemDetail {
  const associations = normalizeAssociations(input.item.associations_json);
  const relatedChats = associations.chat_selections
    .map((selection) => {
      const messages = getTodayPlanChatMessagesBySelection(selection);
      if (messages.length === 0) return null;
      return {
        agent_jid: selection.agent_jid,
        agent_name:
          input.agents[selection.agent_jid]?.name || selection.agent_jid,
        message_count: messages.length,
        messages,
      };
    })
    .filter((item): item is TodayPlanChatAgentDetail => Boolean(item));
  const relatedServices = mergeServiceSelections({
    manual: associations.services,
    planDate: input.planDate,
  });

  return {
    id: input.item.id,
    title: input.item.title,
    detail: input.item.detail || '',
    order_index: input.item.order_index,
    associations,
    related_chats: relatedChats,
    related_services: relatedServices,
    created_at: input.item.created_at,
    updated_at: input.item.updated_at,
  };
}

function buildTodayPlanItems(input: {
  planId: string;
  planDate: string;
  agents: Record<string, RegisteredAgent>;
}): TodayPlanItemDetail[] {
  return listTodayPlanItems(input.planId).map((item) =>
    buildTodayPlanItemDetail({
      item,
      planDate: input.planDate,
      agents: input.agents,
    }),
  );
}

export function getTodayPlanDetail(input: {
  planId?: string;
  planDate?: string;
  agents: Record<string, RegisteredAgent>;
}): TodayPlanDetail | null {
  const plan = getTodayPlanRecord(input);
  if (!plan) return null;
  const items = buildTodayPlanItems({
    planId: plan.id,
    planDate: plan.plan_date,
    agents: input.agents,
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
            agents: input.agents,
          }),
        }
      : null,
  };
}

function dateKeyFromOffset(now: Date, offsetDays: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() - offsetDays);
  return getTodayPlanDateKey(date);
}

function getRecentPlanDates(input: { now: Date; days: number }): string[] {
  const days = Math.max(1, Math.min(Math.round(input.days), 30));
  const dates: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    dates.push(dateKeyFromOffset(input.now, offset));
  }
  return dates;
}

function normalizePlanDateInput(value: string | undefined): string | null {
  const normalized = (value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function addDaysToPlanDate(planDate: string, offsetDays: number): string {
  const date = new Date(`${planDate}T00:00:00`);
  date.setDate(date.getDate() + offsetDays);
  return getTodayPlanDateKey(date);
}

function getDateRangePlanDates(input: {
  startDate: string;
  endDate: string;
}): string[] {
  const dates: string[] = [];
  let current =
    input.startDate <= input.endDate ? input.endDate : input.startDate;
  const minDate =
    input.startDate <= input.endDate ? input.startDate : input.endDate;
  for (let index = 0; current >= minDate && index < 30; index += 1) {
    dates.push(current);
    current = addDaysToPlanDate(current, -1);
  }
  return dates;
}

function resolveTodayPlanQuery(input: {
  days?: number;
  now: Date;
  date?: string;
  startDate?: string;
  endDate?: string;
}): RecentTodayPlanDetails['query'] {
  const date = normalizePlanDateInput(input.date);
  if (date) {
    return {
      mode: 'date',
      days: 1,
      dates: [date],
      from_date: date,
      to_date: date,
      date,
    };
  }

  const startDate = normalizePlanDateInput(input.startDate);
  const endDate = normalizePlanDateInput(input.endDate);
  if (startDate && endDate) {
    const dates = getDateRangePlanDates({ startDate, endDate });
    return {
      mode: 'range',
      days: dates.length,
      dates,
      from_date: dates[dates.length - 1] || startDate,
      to_date: dates[0] || endDate,
      start_date: startDate <= endDate ? startDate : endDate,
      end_date: startDate <= endDate ? endDate : startDate,
    };
  }

  const days = Math.max(1, Math.min(Math.round(Number(input.days) || 3), 30));
  const dates = getRecentPlanDates({ now: input.now, days });
  return {
    mode: 'recent',
    days,
    dates,
    from_date: dates[dates.length - 1] || getTodayPlanDateKey(input.now),
    to_date: dates[0] || getTodayPlanDateKey(input.now),
  };
}

function addUniqueString(target: string[], value: string): void {
  if (!value || target.includes(value)) return;
  target.push(value);
}

function addPlanItemRef(
  target: RecentTodayPlanItemRef[],
  ref: RecentTodayPlanItemRef,
): void {
  if (
    target.some(
      (item) =>
        item.plan_date === ref.plan_date && item.item_id === ref.item_id,
    )
  ) {
    return;
  }
  target.push(ref);
}

type MutableRecentTodayPlanServiceSummary = Omit<
  RecentTodayPlanServiceSummary,
  'branches'
> & {
  branches: Map<string, MutableRecentTodayPlanServiceBranchSummary>;
};

type MutableRecentTodayPlanServiceBranchSummary = Omit<
  RecentTodayPlanServiceBranchSummary,
  'sources' | 'commits'
> & {
  sources: Set<'manual'>;
  commits: Map<string, TodayPlanServiceCommit>;
};

function ensureRecentServiceSummary(
  services: Map<string, MutableRecentTodayPlanServiceSummary>,
  service: string,
  registry?: Record<string, ServiceConfig>,
): MutableRecentTodayPlanServiceSummary {
  const existing = services.get(service);
  if (existing) return existing;
  const repoPath = resolveRepoPath(service, registry);
  const created: MutableRecentTodayPlanServiceSummary = {
    service,
    repo_path: repoPath,
    repo_exists: Boolean(repoPath && fs.existsSync(repoPath)),
    plan_dates: [],
    plan_items: [],
    branches: new Map(),
  };
  services.set(service, created);
  return created;
}

function ensureRecentServiceBranchSummary(
  service: MutableRecentTodayPlanServiceSummary,
  branch: string,
): MutableRecentTodayPlanServiceBranchSummary {
  const existing = service.branches.get(branch);
  if (existing) return existing;
  const created: MutableRecentTodayPlanServiceBranchSummary = {
    name: branch,
    sources: new Set(),
    plan_dates: [],
    plan_items: [],
    ref: null,
    commits: new Map(),
    errors: [],
  };
  service.branches.set(branch, created);
  return created;
}

function attachRecentServicePlanRef(input: {
  services: Map<string, MutableRecentTodayPlanServiceSummary>;
  registry?: Record<string, ServiceConfig>;
  service: string;
  planDate: string;
  itemRef: RecentTodayPlanItemRef;
  branch?: string;
  source?: 'manual';
}): void {
  const serviceName = input.service.trim();
  if (!serviceName) return;
  const service = ensureRecentServiceSummary(
    input.services,
    serviceName,
    input.registry,
  );
  addUniqueString(service.plan_dates, input.planDate);
  addPlanItemRef(service.plan_items, input.itemRef);

  const branchName = input.branch?.trim();
  if (!branchName) return;
  const branch = ensureRecentServiceBranchSummary(service, branchName);
  if (input.source) branch.sources.add(input.source);
  addUniqueString(branch.plan_dates, input.planDate);
  addPlanItemRef(branch.plan_items, input.itemRef);
}

function sortDateKeysDescending(values: string[]): string[] {
  return [...values].sort((a, b) => b.localeCompare(a));
}

function sortPlanItemRefs(values: RecentTodayPlanItemRef[]) {
  return [...values].sort((a, b) => {
    const dateDiff = b.plan_date.localeCompare(a.plan_date);
    if (dateDiff !== 0) return dateDiff;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

function populateRecentServiceCommits(
  service: MutableRecentTodayPlanServiceSummary,
  registry?: Record<string, ServiceConfig>,
): void {
  for (const branch of service.branches.values()) {
    for (const planDate of branch.plan_dates) {
      const detail = listTodayPlanServiceCommits({
        service: service.service,
        branches: [branch.name],
        planDate,
        registry,
      });
      service.repo_path = detail.repo_path;
      service.repo_exists = detail.repo_exists;
      const branchDetail = detail.branches.find(
        (item) => item.name === branch.name,
      );
      if (!branchDetail) continue;
      if (branchDetail.ref && !branch.ref) {
        branch.ref = branchDetail.ref;
      }
      if (branchDetail.error) {
        addUniqueString(branch.errors, `${planDate}: ${branchDetail.error}`);
      }
      for (const commit of branchDetail.commits) {
        if (!commit.hash || branch.commits.has(commit.hash)) continue;
        branch.commits.set(commit.hash, commit);
      }
    }
  }
}

function finalizeRecentServiceSummary(
  service: MutableRecentTodayPlanServiceSummary,
  registry?: Record<string, ServiceConfig>,
): RecentTodayPlanServiceSummary {
  populateRecentServiceCommits(service, registry);
  return {
    service: service.service,
    repo_path: service.repo_path,
    repo_exists: service.repo_exists,
    plan_dates: sortDateKeysDescending(service.plan_dates),
    plan_items: sortPlanItemRefs(service.plan_items),
    branches: Array.from(service.branches.values())
      .map((branch) => ({
        name: branch.name,
        sources: Array.from(branch.sources).sort(),
        plan_dates: sortDateKeysDescending(branch.plan_dates),
        plan_items: sortPlanItemRefs(branch.plan_items),
        ref: branch.ref,
        commits: Array.from(branch.commits.values())
          .sort((a, b) => b.committed_at.localeCompare(a.committed_at))
          .slice(0, 100),
        errors: [...branch.errors],
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  };
}

export function getRecentTodayPlanDetails(
  input: {
    days?: number;
    date?: string;
    startDate?: string;
    endDate?: string;
    now?: Date;
    registry?: Record<string, ServiceConfig>;
  } = {},
): RecentTodayPlanDetails {
  const now = input.now || new Date();
  const query = resolveTodayPlanQuery({
    days: input.days,
    now,
    date: input.date,
    startDate: input.startDate,
    endDate: input.endDate,
  });
  const dates = query.dates;
  const services = new Map<string, MutableRecentTodayPlanServiceSummary>();
  const plans: RecentTodayPlanPlanSummary[] = [];

  for (const planDate of dates) {
    const plan = getTodayPlanByDate(planDate);
    if (!plan) continue;
    const items = listTodayPlanItems(plan.id);
    const planSummary: RecentTodayPlanPlanSummary = {
      id: plan.id,
      plan_date: plan.plan_date,
      title: plan.title,
      status: getPlanStatus(plan),
      completed_at: plan.completed_at || null,
      item_count: items.length,
      items: [],
    };

    for (const item of items) {
      const associations = normalizeAssociations(item.associations_json);
      const itemRef: RecentTodayPlanItemRef = {
        plan_date: plan.plan_date,
        item_id: item.id,
        title: item.title || '未命名计划项',
      };
      planSummary.items.push({
        id: item.id,
        title: item.title || '',
        detail: item.detail || '',
        order_index: item.order_index,
        services: associations.services,
      });

      for (const selection of associations.services) {
        attachRecentServicePlanRef({
          services,
          registry: input.registry,
          service: selection.service,
          planDate: plan.plan_date,
          itemRef,
        });
        for (const branch of selection.branches) {
          attachRecentServicePlanRef({
            services,
            registry: input.registry,
            service: selection.service,
            branch,
            source: 'manual',
            planDate: plan.plan_date,
            itemRef,
          });
        }
      }
    }

    plans.push(planSummary);
  }

  return {
    query,
    plans,
    services: Array.from(services.values())
      .map((service) => finalizeRecentServiceSummary(service, input.registry))
      .sort((a, b) => a.service.localeCompare(b.service, 'zh-CN')),
  };
}

export function createTodayPlanItemForPlan(
  planId: string,
): TodayPlanItemRecord {
  const plan = getTodayPlanById(planId);
  if (!isPlanEditable(plan)) {
    throw new Error('当前计划不可编辑');
  }
  const created = createTodayPlanItem({
    plan_id: planId,
    title: '',
    detail: '',
    associations_json: serializeAssociations({
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

function formatChatAgentForMail(agent: TodayPlanChatAgentDetail): string {
  const lines = agent.messages.slice(0, 120).map((message) => {
    const sender = message.sender_name || message.sender || '未知';
    const content = truncateText(
      message.content.replace(/\s+/g, ' ').trim(),
      240,
    );
    return `- [${message.timestamp}] ${sender}: ${content}`;
  });
  const suffix =
    agent.messages.length > 120
      ? `\n- ... 其余 ${agent.messages.length - 120} 条消息已省略`
      : '';
  return (
    [
      `群聊：${agent.agent_name}`,
      `消息数：${agent.message_count}`,
      ...lines,
    ].join('\n') + suffix
  );
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
    '- 根据`关联群聊`、`关联服务分支` 信息汇总实际执行项列表',
    '',
    '2. <计划标题 2>',
    '- 按实际计划数量继续展开；如果只有一条计划，则不要保留这一条示例。',
  ].join('\n');
}

export function buildTodayPlanMailPrompt(input: {
  planId: string;
  agents: Record<string, RegisteredAgent>;
  name: string;
}): { plan: TodayPlanDetail; prompt: string; subject: string } | null {
  const detail = getTodayPlanDetail({
    planId: input.planId,
    agents: input.agents,
  });
  if (!detail) return null;

  const blocks = detail.items.length
    ? detail.items.map((item, index) => {
        const sections: string[] = [
          `## 计划 ${index + 1}: ${item.title || `未命名计划 ${index + 1}`}`,
          `计划内容：${item.detail || '无'}`,
        ];

        if (item.related_chats.length > 0) {
          sections.push('### 关联群聊消息');
          for (const agent of item.related_chats) {
            sections.push(formatChatAgentForMail(agent));
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
    '要求：',
    '1. 仅依据下面提供的信息进行总结，不要自行编造。',
    '2. 你只输出邮件正文，不要输出主题、收件人、抄送、解释、前后缀说明。',
    '3. 邮件正文按模板逐条输出计划项，每条只保留实际执行项列表。',
    '4. 每条计划的执行项只能根据对应的关联群聊、关联服务分支信息提炼。',
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
