import {
  getAgentQuery,
  getAllTasks,
  listAgentQueryEvents,
  listAgentQuerySteps,
} from '../db.js';
import {
  createAssistantActionLog,
  getAgentInboxItem,
  updateAgentInboxItemExtra,
  updateAgentInboxItemStatus,
} from './agent-inbox-store.js';
import type { AgentInboxItemView, AssistantTriggerRuleKey } from './types.js';
import { logger } from '../logger.js';

export interface AssistantAgentRunResult {
  ok: boolean;
  text: string;
  error?: string;
}

export type AssistantAgentPurpose =
  | 'investigation'
  | 'repair'
  | 'coding_anomaly_scan';

export type AssistantAgentRunner = (input: {
  prompt: string;
  purpose: AssistantAgentPurpose;
  item: AgentInboxItemView;
}) => Promise<AssistantAgentRunResult>;

interface InvestigationResult {
  ok: boolean;
  summary: string;
  root_cause: string | null;
  repairable: boolean;
  repair_plan: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'unknown';
  required_user_action: string | null;
  evidence: Array<{ label: string; value: string }>;
  groups: InvestigationGroup[];
}

interface InvestigationGroup {
  id: string;
  title: string;
  log_indexes: number[];
  service?: string;
  requirement?: string;
  revisions?: string[];
  summary?: string | null;
  count: number;
  root_cause: string | null;
  repairable: boolean;
  repair_plan: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'unknown';
  required_user_action: string | null;
  evidence: Array<{ label: string; value: string }>;
}

interface RepairResult {
  ok: boolean;
  fixed: boolean;
  summary: string;
  result: string;
  next_action: string | null;
}

let agentRunner: AssistantAgentRunner | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toRuleKey(value: unknown): AssistantTriggerRuleKey | null {
  return typeof value === 'string' ? (value as AssistantTriggerRuleKey) : null;
}

function readJsonObject(value: string): Record<string, unknown> {
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
  if (!isObject(parsed)) throw new Error('Agent output is not a JSON object');
  return parsed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringValue(value: unknown, fallback: string): string {
  return stringOrNull(value) || fallback;
}

function parseEvidence(
  value: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isObject(item)) return null;
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

function parseRiskLevel(value: unknown): InvestigationResult['risk_level'] {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'unknown'
    ? value
    : 'unknown';
}

function parseLogIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const indexes = value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
  return Array.from(new Set(indexes)).slice(0, 50);
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

function slugifyGroupId(value: string, index: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `group-${index + 1}`;
}

function parseInvestigationGroups(value: unknown): InvestigationGroup[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Agent output groups is required');
  }
  return value
    .map((item, index): InvestigationGroup | null => {
      if (!isObject(item)) return null;
      const title = stringValue(item.title, `异常分类 ${index + 1}`);
      const logIndexes = parseLogIndexes(item.log_indexes);
      return {
        id: stringValue(item.id, slugifyGroupId(title, index)),
        title,
        log_indexes: logIndexes,
        service: stringOrNull(item.service) || undefined,
        requirement: stringOrNull(item.requirement) || undefined,
        revisions: parseStringArray(item.revisions, 100),
        summary: stringOrNull(item.summary),
        count: Math.max(
          1,
          Number.isFinite(Number(item.count))
            ? Math.round(Number(item.count))
            : logIndexes.length || 1,
        ),
        root_cause: stringOrNull(item.root_cause),
        repairable: item.repairable === true,
        repair_plan: stringOrNull(item.repair_plan),
        risk_level: parseRiskLevel(item.risk_level),
        required_user_action: stringOrNull(item.required_user_action),
        evidence: parseEvidence(item.evidence),
      };
    })
    .filter((item): item is InvestigationGroup => Boolean(item));
}

function parseInvestigationResult(text: string): InvestigationResult {
  const parsed = readJsonObject(text);
  const groups = parseInvestigationGroups(parsed.groups).slice(0, 20);
  return {
    ok: parsed.ok !== false,
    summary: stringValue(parsed.summary, '排查完成，但未返回摘要。'),
    root_cause: stringOrNull(parsed.root_cause),
    repairable:
      parsed.repairable === true ||
      (groups.length > 0 && groups.every((group) => group.repairable)),
    repair_plan: stringOrNull(parsed.repair_plan),
    risk_level: parseRiskLevel(parsed.risk_level),
    required_user_action: stringOrNull(parsed.required_user_action),
    evidence: parseEvidence(parsed.evidence),
    groups,
  };
}

function parseRepairResult(text: string): RepairResult {
  const parsed = readJsonObject(text);
  return {
    ok: parsed.ok !== false,
    fixed: parsed.fixed === true,
    summary: stringValue(parsed.summary, '修复流程完成。'),
    result: stringValue(parsed.result, ''),
    next_action: stringOrNull(parsed.next_action),
  };
}

function stringifyContext(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 20000);
}

function buildInvestigationWorkflowInstructions(
  item: AgentInboxItemView,
): string {
  const ruleKey = toRuleKey(item.extra.ruleKey);

  if (ruleKey === 'agent_runs.query_failed') {
    return `调查流程：
- 你运行在容器 agent 中，可以使用 Bash/Read/Grep/Glob 等工具；最终回复只返回 JSON，但在最终回复前必须先用工具主动取证。
- 先从上下文中的 agentQuery.query / steps / events 提取 query_id、runId、session_id、时间点、failure_type、failure_subtype、error_message、lastAssistantUuid 等线索。
- 使用这些线索搜索并读取相关日志：优先查 /workspace/project/logs/icarus.log 和 /workspace/group/logs；如果日志里出现 logFile 或容器日志路径，继续读取对应文件。宿主项目路径可按 /workspace/project 映射，当前群目录可按 /workspace/group 映射。
- 根据失败类型阅读相关源码。容器退出、137、stdin/close、idle/timeout、trace 更新等问题至少检查 /workspace/project/src/container-runner.ts、/workspace/project/container/agent-runner/src/index.ts，以及必要时的 /workspace/project/src/index.ts、/workspace/project/src/agent-query-trace.ts、/workspace/project/src/assistant/proactive-engine.ts。
- 对 code 137 不能只写 OOM/SIGKILL/外部回收。必须结合日志和源码判断它发生在 query 过程中、结果投递前、结果投递后、关闭哨兵后，还是 trace 已结束后；没有证据时 root_cause 必须为 null。
- evidence 必须包含具体证据来源，例如日志路径和行号、源码路径和行号、agent_query_events 的 event_index、关键 stdout/stderr 片段或无法读取某证据的错误。
- 如果工具取证失败或证据不足，summary 要说明“证据不足”，root_cause 为 null，repairable 为 false，并把还缺哪些日志/权限/上下文写入 required_user_action。`;
  }

  if (ruleKey === 'scheduler.task_failed') {
    return `调查流程：
- 你运行在容器 agent 中，可以使用 Bash/Read/Grep/Glob 等工具；最终回复只返回 JSON，但在最终回复前应先用工具验证关键事实。
- 结合上下文中的任务、事件和状态，必要时读取 /workspace/project/logs、/workspace/group/logs 以及相关源码，确认失败阶段、最近动作和可恢复性。
- evidence 必须写清楚证据来源；如果无法查到足够证据，root_cause 必须为 null，repairable 为 false。`;
  }

  if (ruleKey === 'online.error_logs') {
    return `调查流程：
- 先基于 onlineErrorLog.logs 对日志分组；必要时使用工具查看 /workspace/project 中对应服务配置、源码或辅助文档。
- evidence 必须引用日志下标、关键异常类/traceId/业务字段；没有足够证据时 root_cause 必须为 null，repairable 为 false。`;
  }

  return `调查流程：
- 先核实上下文中的关键事实；必要时使用工具查日志和源码。
- evidence 必须写清楚证据来源；没有足够证据时 root_cause 必须为 null，repairable 为 false。`;
}

function normalizeOnlineErrorLogContext(
  value: unknown,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const rawLogs = Array.isArray(value.logs) ? value.logs : [];
  const logs = rawLogs
    .filter(isObject)
    .map((log) => ({
      host: typeof log.host === 'string' ? log.host : '',
      logPath: typeof log.logPath === 'string' ? log.logPath : '',
      time: typeof log.time === 'string' ? log.time : '',
      level: typeof log.level === 'string' ? log.level : null,
      rawLog: typeof log.rawLog === 'string' ? log.rawLog : '',
    }))
    .filter((log) => log.rawLog);
  return {
    service: value.service || null,
    hosts: Array.isArray(value.hosts) ? value.hosts : [],
    logPath: value.logPath || null,
    window: isObject(value.window) ? value.window : null,
    totalErrorCount: value.totalErrorCount || logs.length,
    scanErrors: Array.isArray(value.scanErrors) ? value.scanErrors : [],
    logs,
  };
}

function buildContext(item: AgentInboxItemView): Record<string, unknown> {
  const ruleKey = toRuleKey(item.extra.ruleKey);
  const inboxExtra =
    ruleKey === 'online.error_logs'
      ? Object.fromEntries(
          Object.entries(item.extra).filter(
            ([key]) => key !== 'onlineErrorLog',
          ),
        )
      : item.extra;
  const context: Record<string, unknown> = {
    inbox: {
      id: item.id,
      title: item.title,
      body: item.body,
      source_type: item.source_type,
      source_ref_id: item.source_ref_id,
      action_kind: item.action_kind,
      extra: inboxExtra,
    },
  };

  if (ruleKey === 'scheduler.task_failed') {
    const task = getAllTasks().find((entry) => entry.id === item.source_ref_id);
    context.scheduler = {
      task: task || null,
    };
  }

  if (ruleKey === 'agent_runs.query_failed') {
    const queryId = item.source_ref_id || '';
    context.agentQuery = {
      query: queryId ? getAgentQuery(queryId) || null : null,
      steps: queryId ? listAgentQuerySteps(queryId) : [],
      events: queryId ? listAgentQueryEvents(queryId).slice(-40) : [],
    };
  }

  if (ruleKey === 'online.error_logs') {
    context.onlineErrorLog = normalizeOnlineErrorLogContext(
      item.extra.onlineErrorLog,
    );
  }

  if (ruleKey === 'today_plan.service_coding_anomaly') {
    context.todayPlanCoding = isObject(item.extra.todayPlanCoding)
      ? item.extra.todayPlanCoding
      : null;
  }

  return context;
}

function buildInvestigationPrompt(
  item: AgentInboxItemView,
  context: Record<string, unknown>,
): string {
  return `你是 Icarus 主群个人助手的异常排查 Agent。请基于上下文判断触发项原因，以及是否可以自动修复。

只返回 JSON，不要返回 Markdown 或额外解释。JSON 格式必须是：
{
  "ok": true,
  "summary": "一句话排查结论",
  "root_cause": "根因，无法判断时为 null",
  "repairable": true,
  "repair_plan": "可修复时的修复方案，否则为 null",
  "risk_level": "low|medium|high|unknown",
  "required_user_action": "需要用户处理的动作，没有则为 null",
  "evidence": [{"label":"证据名","value":"证据内容"}],
  "groups": [
    {
      "id": "稳定短 id，只能包含字母数字中划线或下划线",
      "title": "问题分类标题",
      "log_indexes": [0],
      "service": "服务名，可选",
      "requirement": "需求名，可选",
      "revisions": ["相关修订号，可选"],
      "count": 1,
      "root_cause": "该分类根因，无法判断时为 null",
      "repairable": false,
      "repair_plan": "该分类可修复时的修复方案，否则为 null",
      "risk_level": "low|medium|high|unknown",
      "required_user_action": "该分类需要用户处理的动作，没有则为 null",
      "evidence": [{"label":"证据名","value":"证据内容"}]
    }
  ]
}

约束：
- 不确定是否安全修复时，repairable 必须为 false。
- 涉及审批、产品判断、权限变更、外部系统破坏性操作时，repairable 必须为 false。
- 只能根据上下文和你实际使用工具查到的证据判断；不要凭常见经验补根因。
- 最终回复只返回 JSON；工具调查过程不要向用户发送说明性自然语言。
- 如果上下文包含 onlineErrorLog.logs，多条日志可能属于不同问题，必须由你按语义自行归并分类后返回 groups。
- groups[].log_indexes 必须引用 onlineErrorLog.logs 的 0-based 下标；不要在结果里复制完整 rawLog。
- 如果上下文包含 todayPlanCoding.anomalies，groups 必须对应这些异常项，并保留每个异常项的 service、requirement、revisions。
- 顶层 repairable 只有在所有分类都可自动修复且修复方案不冲突时才为 true；任一分类需人工处理时为 false。

${buildInvestigationWorkflowInstructions(item)}

触发项：${item.title}
上下文：
${stringifyContext(context)}
`;
}

function buildRepairPrompt(
  item: AgentInboxItemView,
  context: Record<string, unknown>,
  investigation: InvestigationResult,
  group?: InvestigationGroup | null,
): string {
  return `你是 Icarus 主群个人助手的异常修复 Agent。请按排查结论尝试修复；如果无法安全修复，说明原因。

只返回 JSON，不要返回 Markdown 或额外解释。JSON 格式必须是：
{
  "ok": true,
  "fixed": true,
  "summary": "一句话修复结论",
  "result": "具体执行结果",
  "next_action": "仍需用户处理的动作，没有则为 null"
}

约束：
- 只能执行${group ? '目标分类' : '排查结论'}中 repair_plan 描述的修复。
- 不确定、风险升高或缺少权限时，fixed 必须为 false，并说明 next_action。

触发项：${item.title}
${group ? `目标分类：\n${stringifyContext(group)}\n` : ''}
排查结论：
${stringifyContext(investigation)}
上下文：
${stringifyContext(context)}
`;
}

export function initAssistantAutoFlow(input: {
  agentRunner?: AssistantAgentRunner | null;
}): void {
  agentRunner = input.agentRunner || null;
}

export async function runAssistantAgent(input: {
  prompt: string;
  purpose: AssistantAgentPurpose;
  item: AgentInboxItemView;
}): Promise<AssistantAgentRunResult> {
  if (!agentRunner) {
    throw new Error('Assistant action agent runner is not initialized');
  }
  return agentRunner(input);
}

export function canInvestigateInboxItem(item: AgentInboxItemView): boolean {
  const ruleKey = toRuleKey(item.extra.ruleKey);
  return (
    ruleKey === 'scheduler.task_failed' ||
    ruleKey === 'agent_runs.query_failed' ||
    ruleKey === 'online.error_logs' ||
    ruleKey === 'today_plan.service_coding_anomaly'
  );
}

export function canRepairInboxItem(item: AgentInboxItemView): boolean {
  const investigation = item.extra.investigation;
  return (
    canInvestigateInboxItem(item) &&
    isObject(investigation) &&
    (investigation.repairable === true ||
      (Array.isArray(investigation.groups) &&
        investigation.groups.some(
          (group) => isObject(group) && group.repairable === true,
        )))
  );
}

export function shouldAutoProcessInboxItem(item: AgentInboxItemView): boolean {
  if (!canInvestigateInboxItem(item)) {
    return false;
  }
  const status = item.extra.autoFlowStatus;
  return (
    status !== 'investigating' &&
    status !== 'investigated' &&
    status !== 'repairing' &&
    status !== 'processing' &&
    status !== 'handled' &&
    status !== 'deferred' &&
    status !== 'fixed' &&
    status !== 'repair_failed' &&
    status !== 'failed' &&
    !isObject(item.extra.investigation) &&
    !isObject(item.extra.repair)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveInvestigationOutput(
  output: AssistantAgentRunResult,
): InvestigationResult {
  let result: InvestigationResult | null = null;
  let parseError: unknown = null;
  try {
    result = parseInvestigationResult(output.text);
  } catch (err) {
    parseError = err;
  }

  if (!result) {
    if (!output.ok) {
      throw new Error(
        output.error ||
          output.text ||
          errorMessage(parseError) ||
          'Investigation failed',
      );
    }
    throw parseError;
  }

  if (!result.ok) {
    throw new Error(
      result.summary || output.error || output.text || 'Investigation failed',
    );
  }

  return result;
}

export async function investigateAgentInboxItem(
  itemId: string,
): Promise<{ item: AgentInboxItemView; result: InvestigationResult }> {
  const item = getAgentInboxItem(itemId);
  if (!item) throw new Error('Agent inbox item not found');
  if (!canInvestigateInboxItem(item)) {
    throw new Error('This inbox item does not support investigation');
  }
  if (!agentRunner) {
    throw new Error('Assistant investigation agent runner is not initialized');
  }

  const context = buildContext(item);
  updateAgentInboxItemExtra(item.id, {
    autoFlowStatus: 'investigating',
    lastInvestigationError: null,
  });
  createAssistantActionLog({
    itemId: item.id,
    action: 'investigate',
    status: 'success',
    title: item.title,
    sourceType: item.source_type,
    sourceRefId: item.source_ref_id,
    payload: { ruleKey: item.extra.ruleKey },
  });

  try {
    const output = await runAssistantAgent({
      purpose: 'investigation',
      item,
      prompt: buildInvestigationPrompt(item, context),
    });

    const result = resolveInvestigationOutput(output);
    const updated = updateAgentInboxItemExtra(item.id, {
      autoFlowStatus: 'investigated',
      investigation: result as unknown as Record<string, unknown>,
      lastInvestigationError: null,
    });
    createAssistantActionLog({
      itemId: item.id,
      action: 'investigate_result',
      status: 'success',
      title: item.title,
      sourceType: item.source_type,
      sourceRefId: item.source_ref_id,
      result: result as unknown as Record<string, unknown>,
    });
    return { item: updated, result };
  } catch (err) {
    const message = errorMessage(err);
    updateAgentInboxItemExtra(item.id, {
      autoFlowStatus: 'failed',
      lastInvestigationError: message,
    });
    throw err;
  }
}

export async function repairAgentInboxItem(
  itemId: string,
  input: { groupId: string },
): Promise<{ item: AgentInboxItemView; result: RepairResult }> {
  const item = getAgentInboxItem(itemId);
  if (!item) throw new Error('Agent inbox item not found');
  if (!canRepairInboxItem(item)) {
    throw new Error('This inbox item is not marked as repairable');
  }
  if (!agentRunner) {
    throw new Error('Assistant repair agent runner is not initialized');
  }

  const investigation = item.extra
    .investigation as unknown as InvestigationResult;
  const groupId = stringOrNull(input.groupId);
  if (!groupId) {
    throw new Error('group_id required');
  }
  const group = Array.isArray(investigation.groups)
    ? investigation.groups.find((entry) => entry.id === groupId)
    : null;
  if (!group) {
    throw new Error('Investigation group not found');
  }
  if (group.repairable !== true) {
    throw new Error('This investigation group is not marked as repairable');
  }
  const context = buildContext(item);
  updateAgentInboxItemExtra(item.id, {
    autoFlowStatus: 'repairing',
    lastRepairError: null,
  });

  try {
    const output = await runAssistantAgent({
      purpose: 'repair',
      item,
      prompt: buildRepairPrompt(item, context, investigation, group),
    });
    if (!output.ok) {
      throw new Error(output.error || output.text || 'Repair failed');
    }

    const result = parseRepairResult(output.text);
    const updated = updateAgentInboxItemExtra(item.id, {
      autoFlowStatus: result.fixed ? 'fixed' : 'repair_failed',
      repair: result as unknown as Record<string, unknown>,
      lastRepairGroupId: group?.id || null,
      lastRepairError: result.fixed
        ? null
        : result.next_action || result.result,
    });
    if (result.fixed) {
      updateAgentInboxItemStatus(item.id, 'done');
    }
    createAssistantActionLog({
      itemId: item.id,
      action: 'repair_result',
      status: result.fixed ? 'success' : 'skipped',
      title: item.title,
      sourceType: item.source_type,
      sourceRefId: item.source_ref_id,
      payload: { groupId: group.id, groupTitle: group.title },
      result: result as unknown as Record<string, unknown>,
    });
    return {
      item: getAgentInboxItem(updated.id) || updated,
      result,
    };
  } catch (err) {
    const message = errorMessage(err);
    updateAgentInboxItemExtra(item.id, {
      autoFlowStatus: 'repair_failed',
      lastRepairError: message,
    });
    throw err;
  }
}

export async function autoProcessAgentInboxItem(itemId: string): Promise<{
  item: AgentInboxItemView;
  investigation?: InvestigationResult;
  repairs?: RepairResult[];
}> {
  const existing = getAgentInboxItem(itemId);
  if (!existing) throw new Error('Agent inbox item not found');
  const existingInvestigation = isObject(existing.extra.investigation)
    ? (existing.extra.investigation as unknown as InvestigationResult)
    : null;
  const investigated = existingInvestigation
    ? { item: existing, result: existingInvestigation }
    : await investigateAgentInboxItem(itemId);
  const repairableGroups = Array.isArray(investigated.result.groups)
    ? investigated.result.groups.filter((group) => group.repairable)
    : [];
  if (repairableGroups.length === 0) {
    return {
      item: investigated.item,
      investigation: investigated.result,
    };
  }
  const repairs: RepairResult[] = [];
  let item = investigated.item;
  for (const group of repairableGroups) {
    const repaired = await repairAgentInboxItem(itemId, { groupId: group.id });
    item = repaired.item;
    repairs.push(repaired.result);
  }
  return {
    item,
    investigation: investigated.result,
    repairs,
  };
}

export function scheduleAutoProcessAgentInboxItem(itemId: string): void {
  void autoProcessAgentInboxItem(itemId).catch((err) => {
    const message = errorMessage(err);
    logger.warn({ err, itemId }, 'Assistant auto flow failed');
    try {
      const item = updateAgentInboxItemExtra(itemId, {
        autoFlowStatus: 'failed',
        lastAutoFlowError: message,
      });
      createAssistantActionLog({
        itemId,
        action: 'auto_flow',
        status: 'error',
        title: item.title,
        sourceType: item.source_type,
        sourceRefId: item.source_ref_id,
        result: { error: message },
      });
    } catch (logErr) {
      logger.warn({ err: logErr, itemId }, 'Failed to persist auto flow error');
    }
  });
}
