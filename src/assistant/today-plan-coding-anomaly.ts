import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT } from '../config.js';
import { getTodayPlanByDate, listTodayPlanItems } from '../db.js';
import { logger } from '../logger.js';
import {
  getTodayPlanDateKey,
  type TodayPlanAssociations,
} from '../today-plan.js';
import { getWorkbenchTaskDetail } from '../workbench.js';
import { WORKFLOW_CONTEXT_KEYS } from '../workflow-context.js';
import type {
  AgentInboxItemView,
  AssistantSettings,
  UpsertAgentInboxItemInput,
} from './types.js';
import type { AssistantAgentRunResult } from './assistant-auto-flow.js';
import { runAssistantAgent } from './assistant-auto-flow.js';

const RULE_KEY = 'today_plan.service_coding_anomaly';
const SOURCE_TYPE = 'today_plan_coding_anomaly';
const MAX_REVISIONS_PER_SERVICE = 100;
const MAX_ANOMALIES = 50;

type JsonRecord = Record<string, unknown>;

const DEFAULT_REPOS_ROOT = path.dirname(PROJECT_ROOT);

export interface TodayPlanCodingScanItem {
  service: string;
  repoPath: string;
  revisions: string[];
}

interface CodingAnomaly {
  service: string;
  requirement: string;
  revisions: string[];
  summary: string;
  root_cause: string | null;
  repairable: boolean;
  repair_plan: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'unknown';
  required_user_action: string | null;
  evidence: Array<{ label: string; value: string }>;
}

interface CodingAnomalyScanResult {
  ok: boolean;
  summary: string;
  anomalies: CodingAnomaly[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringValue(value: unknown, fallback: string): string {
  return stringOrNull(value) || fallback;
}

function parseJsonObject(value: string): JsonRecord {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  const json =
    firstBrace >= 0 && lastBrace > firstBrace
      ? candidate.slice(firstBrace, lastBrace + 1)
      : candidate;
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) throw new Error('Agent output is not a JSON object');
  return parsed;
}

function parseStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

function parseEvidence(
  value: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      return {
        label: stringValue(item.label, '证据'),
        value: stringValue(item.value, ''),
      };
    })
    .filter((item): item is { label: string; value: string } =>
      Boolean(item && item.value),
    )
    .slice(0, 8);
}

function parseRiskLevel(value: unknown): CodingAnomaly['risk_level'] {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeAssociations(
  value: string | null | undefined,
): TodayPlanAssociations {
  if (!value) {
    return {
      workbench_task_ids: [],
      chat_selections: [],
      services: [],
    };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) throw new Error('associations is not object');
    return {
      workbench_task_ids: parseStringArray(parsed.workbench_task_ids, 200),
      chat_selections: [],
      services: Array.isArray(parsed.services)
        ? parsed.services
            .filter(isRecord)
            .map((item) => ({
              service: stringValue(item.service, ''),
              branches: parseStringArray(item.branches, 100),
            }))
            .filter((item) => item.service && item.branches.length > 0)
        : [],
    };
  } catch {
    return {
      workbench_task_ids: [],
      chat_selections: [],
      services: [],
    };
  }
}

function readServiceRegistry(): Record<string, JsonRecord> {
  const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
  if (!fs.existsSync(servicesPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(servicesPath, 'utf-8')) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, config]) => isRecord(config)),
    ) as Record<string, JsonRecord>;
  } catch (err) {
    logger.warn(
      { err, servicesPath },
      'Failed to parse services.json for today plan coding scan',
    );
    return {};
  }
}

function containerRepoPathForService(
  service: string,
  registry: Record<string, JsonRecord>,
): string {
  if (service === 'icarus' || path.basename(PROJECT_ROOT) === service) {
    return '/workspace/project';
  }
  const repoPath = stringOrNull(registry[service]?.repo_path) || service;
  return `/workspace/repos/${repoPath}`;
}

function hostRepoPathForService(
  service: string,
  registry: Record<string, JsonRecord>,
): string | null {
  if (service === 'icarus' || path.basename(PROJECT_ROOT) === service) {
    return PROJECT_ROOT;
  }
  const repoPath = stringOrNull(registry[service]?.repo_path);
  if (!repoPath) return null;
  return path.isAbsolute(repoPath)
    ? repoPath
    : path.join(DEFAULT_REPOS_ROOT, repoPath);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function safeRunGit(repoPath: string, args: string[]): string {
  try {
    return runGit(repoPath, args);
  } catch {
    return '';
  }
}

function resolveBranchRef(repoPath: string, branch: string): string | null {
  for (const candidate of [branch, `origin/${branch}`]) {
    const output = safeRunGit(repoPath, ['rev-parse', '--verify', candidate]);
    if (output) return candidate;
  }
  return null;
}

function listServiceBranchRevisions(input: {
  service: string;
  branches: string[];
  planDate: string;
  registry: Record<string, JsonRecord>;
}): string[] {
  const repoPath = hostRepoPathForService(input.service, input.registry);
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const revisions = new Set<string>();
  for (const branch of input.branches) {
    const ref = resolveBranchRef(repoPath, branch);
    if (!ref) continue;
    const output = safeRunGit(repoPath, [
      'log',
      ref,
      `--since=${input.planDate} 00:00:00`,
      `--until=${input.planDate} 23:59:59`,
      '--pretty=format:%H',
      '--no-merges',
      '-n',
      '100',
    ]);
    for (const hash of output.split('\n').map((line) => line.trim())) {
      if (hash) revisions.add(hash);
    }
  }
  return Array.from(revisions);
}

function dateKeyFromOffset(now: Date, offsetDays: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() - offsetDays);
  return getTodayPlanDateKey(date);
}

function getPlanDates(input: { now: Date; lookbackDays: number }): string[] {
  const dates = new Set<string>();
  for (let offset = 0; offset < input.lookbackDays; offset += 1) {
    dates.add(dateKeyFromOffset(input.now, offset));
  }
  return Array.from(dates).sort();
}

function getTaskWorkBranch(taskId: string): {
  service: string;
  branch: string;
} | null {
  const detail = getWorkbenchTaskDetail(taskId);
  if (!detail) return null;
  const branch =
    typeof detail.task.context?.[WORKFLOW_CONTEXT_KEYS.workBranch] === 'string'
      ? String(detail.task.context[WORKFLOW_CONTEXT_KEYS.workBranch]).trim()
      : '';
  if (!detail.task.service || !branch) return null;
  return {
    service: detail.task.service,
    branch,
  };
}

function collectServiceBranches(
  associations: TodayPlanAssociations,
): Array<{ service: string; branches: string[] }> {
  const branchesByService = new Map<string, Set<string>>();
  const add = (service: string, branches: string[]) => {
    const normalizedService = service.trim();
    if (!normalizedService) return;
    const target = branchesByService.get(normalizedService) || new Set<string>();
    for (const branch of branches) {
      const normalizedBranch = branch.trim();
      if (normalizedBranch) target.add(normalizedBranch);
    }
    if (target.size > 0) branchesByService.set(normalizedService, target);
  };

  for (const selection of associations.services) {
    add(selection.service, selection.branches);
  }
  for (const taskId of associations.workbench_task_ids) {
    const taskBranch = getTaskWorkBranch(taskId);
    if (taskBranch) add(taskBranch.service, [taskBranch.branch]);
  }

  return Array.from(branchesByService.entries()).map(([service, branches]) => ({
    service,
    branches: Array.from(branches).sort(),
  }));
}

export function collectTodayPlanCodingScanItems(input: {
  now?: Date;
  lookbackDays: number;
  registry?: Record<string, JsonRecord>;
}): TodayPlanCodingScanItem[] {
  const now = input.now || new Date();
  const registry = input.registry || readServiceRegistry();
  const revisionsByService = new Map<string, Set<string>>();

  for (const planDate of getPlanDates({
    now,
    lookbackDays: Math.max(1, Math.min(Math.round(input.lookbackDays), 30)),
  })) {
    const plan = getTodayPlanByDate(planDate);
    if (!plan) continue;
    for (const item of listTodayPlanItems(plan.id)) {
      const associations = normalizeAssociations(item.associations_json);
      for (const selection of collectServiceBranches(associations)) {
        const service = selection.service.trim();
        if (!service) continue;
        const commits = listServiceBranchRevisions({
          service,
          branches: selection.branches,
          planDate,
          registry,
        });
        const revisions = revisionsByService.get(service) || new Set<string>();
        for (const commit of commits) revisions.add(commit);
        if (revisions.size > 0) {
          revisionsByService.set(service, revisions);
        }
      }
    }
  }

  return Array.from(revisionsByService.entries())
    .map(([service, revisions]) => ({
      service,
      repoPath: containerRepoPathForService(service, registry),
      revisions: Array.from(revisions).sort().slice(0, MAX_REVISIONS_PER_SERVICE),
    }))
    .filter((item) => item.revisions.length > 0)
    .sort((a, b) => a.service.localeCompare(b.service, 'zh-CN'));
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function candidateHash(items: TodayPlanCodingScanItem[]): string {
  return hashText(
    JSON.stringify(
      items.map((item) => ({
        service: item.service,
        revisions: [...item.revisions].sort(),
      })),
    ),
  );
}

function slugifyGroupId(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || `requirement-${index + 1}`}-${hashText(value).slice(0, 8)}`;
}

function parseCodingAnomalyScanResult(text: string): CodingAnomalyScanResult {
  const parsed = parseJsonObject(text);
  const rawAnomalies = Array.isArray(parsed.anomalies) ? parsed.anomalies : [];
  const anomalies = rawAnomalies
    .filter(isRecord)
    .map((item) => {
      const service = stringValue(item.service, '');
      const requirement = stringValue(item.requirement, '');
      const revisions = parseStringArray(item.revisions, 100);
      if (!service || !requirement || revisions.length === 0) return null;
      return {
        service,
        requirement,
        revisions,
        summary: stringValue(item.summary, requirement),
        root_cause: stringOrNull(item.root_cause),
        repairable: item.repairable === true,
        repair_plan: stringOrNull(item.repair_plan),
        risk_level: parseRiskLevel(item.risk_level),
        required_user_action: stringOrNull(item.required_user_action),
        evidence: parseEvidence(item.evidence),
      };
    })
    .filter((item): item is CodingAnomaly => Boolean(item))
    .slice(0, MAX_ANOMALIES);
  return {
    ok: parsed.ok !== false,
    summary: stringValue(parsed.summary, `发现 ${anomalies.length} 个异常需求`),
    anomalies,
  };
}

function priorityFromAnomalies(
  anomalies: CodingAnomaly[],
): UpsertAgentInboxItemInput['priority'] {
  if (anomalies.some((item) => item.risk_level === 'high')) return 'urgent';
  if (anomalies.some((item) => item.risk_level === 'medium')) return 'high';
  return 'normal';
}

function toInvestigation(result: CodingAnomalyScanResult): JsonRecord {
  const repairable =
    result.anomalies.length > 0 &&
    result.anomalies.every((item) => item.repairable);
  return {
    ok: true,
    summary: result.summary,
    root_cause: null,
    repairable,
    repair_plan: null,
    risk_level: result.anomalies.some((item) => item.risk_level === 'high')
      ? 'high'
      : result.anomalies.some((item) => item.risk_level === 'medium')
        ? 'medium'
        : result.anomalies.some((item) => item.risk_level === 'low')
          ? 'low'
          : 'unknown',
    required_user_action: null,
    evidence: [],
    groups: result.anomalies.map((item, index) => ({
      id: slugifyGroupId(`${item.service}:${item.requirement}:${item.revisions.join(',')}`, index),
      title: `${item.service} · ${item.requirement}`,
      service: item.service,
      requirement: item.requirement,
      revisions: item.revisions,
      summary: item.summary,
      log_indexes: [],
      count: item.revisions.length,
      root_cause: item.root_cause,
      repairable: item.repairable,
      repair_plan: item.repair_plan,
      risk_level: item.risk_level,
      required_user_action: item.required_user_action,
      evidence: item.evidence,
    })),
  };
}

function buildPrompt(items: TodayPlanCodingScanItem[]): string {
  return `你是 Icarus 主群个人助手的服务 coding 异常排查 Agent。请根据输入的服务和修订号集合，判断这些修订引入的实现 bug 或风险点。

只返回 JSON，不要返回 Markdown 或额外解释。JSON 格式必须是：
{
  "ok": true,
  "summary": "一句话总结；没有异常时说明未发现异常",
  "anomalies": [
    {
      "service": "服务名",
      "requirement": "你根据修订对应代码修改自行归纳出的需求名",
      "revisions": ["该需求覆盖的修订号集合"],
      "summary": "异常摘要",
      "root_cause": "根因，无法判断时为 null",
      "repairable": true,
      "repair_plan": "可安全修复时的方案，否则为 null",
      "risk_level": "low|medium|high|unknown",
      "required_user_action": "需要用户处理的动作，没有则为 null",
      "evidence": [{"label":"证据名","value":"证据内容"}]
    }
  ]
}

约束：
- 输入只包含 service、repo_path 和 revisions。不要要求额外需求文本。
- service 对应仓库目录以 repo_path 为准；icarus 的 repo_path 是 /workspace/project，其他服务通常是 /workspace/repos/{repo_path}。
- 必须进入对应仓库，自行读取 revisions 的 commit、diff、相关源码和必要测试。
- 先根据 revisions 对应代码修改自行归纳需求；一个服务的多个修订可以拆成多个需求。
- 只返回存在实现 bug 或风险点的需求；没有异常时 anomalies 必须是空数组。
- 每个异常必须带 service、requirement，以及该需求对应的 revisions 集合。
- 不确定是否安全修复时 repairable 必须为 false。
- 涉及审批、产品判断、权限变更、外部系统破坏性操作时 repairable 必须为 false。
- evidence 必须包含具体证据来源，例如 commit、文件路径、函数/测试名或命令结果摘要。

输入：
${JSON.stringify({ items }, null, 2)}
`;
}

function buildVirtualInboxItem(hash: string): AgentInboxItemView {
  return {
    id: `today-plan-coding-scan-${hash}`,
    dedupe_key: `today-plan-coding-scan:${hash}`,
    kind: 'risk',
    status: 'unread',
    priority: 'normal',
    title: '服务 coding 异常排查',
    body: null,
    source_type: SOURCE_TYPE,
    source_ref_id: hash,
    action_kind: null,
    action_label: null,
    action_url: null,
    created_by: 'assistant',
    created_at: Date.now().toString(),
    updated_at: Date.now().toString(),
    due_at: null,
    snoozed_until: null,
    read_at: null,
    resolved_at: null,
    action_payload: {},
    extra: {
      ruleKey: RULE_KEY,
    },
  };
}

export async function scanTodayPlanCodingAnomalyRule(input: {
  settings: AssistantSettings;
  now?: Date;
  registry?: Record<string, JsonRecord>;
  agentRunner?: (args: {
    prompt: string;
    purpose: 'coding_anomaly_scan';
    item: AgentInboxItemView;
  }) => Promise<AssistantAgentRunResult>;
}): Promise<UpsertAgentInboxItemInput[]> {
  const ruleSettings = input.settings.triggerRules[RULE_KEY];
  if (!ruleSettings?.enabled) return [];

  const now = input.now || new Date();
  const lookbackDays = Math.max(
    1,
    Math.min(Math.round(Number(ruleSettings.lookbackDays) || 3), 30),
  );
  const items = collectTodayPlanCodingScanItems({
    now,
    lookbackDays,
    registry: input.registry,
  });
  if (items.length === 0) return [];

  const scanHash = candidateHash(items);
  const virtualItem = buildVirtualInboxItem(scanHash);
  const output = input.agentRunner
    ? await input.agentRunner({
        prompt: buildPrompt(items),
        purpose: 'coding_anomaly_scan',
        item: virtualItem,
      })
    : await runAssistantAgent({
        prompt: buildPrompt(items),
        purpose: 'coding_anomaly_scan',
        item: virtualItem,
      });
  if (!output.ok) {
    throw new Error(output.error || output.text || 'Coding anomaly scan failed');
  }

  const result = parseCodingAnomalyScanResult(output.text);
  if (!result.ok) {
    throw new Error(result.summary || 'Coding anomaly scan failed');
  }
  if (result.anomalies.length === 0) return [];

  return [
    {
      dedupeKey: `today-plan-coding-anomaly:${scanHash}`,
      kind: 'risk',
      priority: priorityFromAnomalies(result.anomalies),
      title: `服务 coding 异常：${result.anomalies.length} 个需求`,
      body: result.summary,
      triggerRuleKey: RULE_KEY,
      sourceType: SOURCE_TYPE,
      sourceRefId: scanHash,
      actionKind: null,
      actionLabel: null,
      extra: {
        autoFlowStatus: 'investigated',
        investigation: toInvestigation(result),
        todayPlanCoding: {
          scannedAt: now.toISOString(),
          lookbackDays,
          items,
          anomalyCount: result.anomalies.length,
        },
      },
    },
  ];
}
