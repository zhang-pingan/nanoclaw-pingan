import {
  getAgentQuery,
  getAllTasks,
  getWorkbenchTaskById,
  listAgentQueryEvents,
  listAgentQuerySteps,
  listWorkbenchActionItemsByTask,
  listWorkbenchEventsByTask,
  listWorkbenchSubtasksByTask,
} from '../db.js';
import { getWorkbenchTaskDetail } from '../workbench.js';
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

export type AssistantAgentRunner = (input: {
  prompt: string;
  purpose: 'investigation' | 'repair';
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

function parseInvestigationResult(text: string): InvestigationResult {
  const parsed = readJsonObject(text);
  const risk =
    parsed.risk_level === 'low' ||
    parsed.risk_level === 'medium' ||
    parsed.risk_level === 'high'
      ? parsed.risk_level
      : 'unknown';
  return {
    ok: parsed.ok !== false,
    summary: stringValue(parsed.summary, '排查完成，但未返回摘要。'),
    root_cause: stringOrNull(parsed.root_cause),
    repairable: parsed.repairable === true,
    repair_plan: stringOrNull(parsed.repair_plan),
    risk_level: risk,
    required_user_action: stringOrNull(parsed.required_user_action),
    evidence: parseEvidence(parsed.evidence),
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

function buildContext(item: AgentInboxItemView): Record<string, unknown> {
  const ruleKey = toRuleKey(item.extra.ruleKey);
  const context: Record<string, unknown> = {
    inbox: {
      id: item.id,
      title: item.title,
      body: item.body,
      source_type: item.source_type,
      source_ref_id: item.source_ref_id,
      action_kind: item.action_kind,
      extra: item.extra,
    },
  };

  if (
    ruleKey === 'workbench.task_failed_or_cancelled' ||
    ruleKey === 'workbench.task_stale'
  ) {
    const taskId =
      typeof item.extra.taskId === 'string'
        ? item.extra.taskId
        : item.source_ref_id || '';
    context.workbench = {
      taskRecord: taskId ? getWorkbenchTaskById(taskId) || null : null,
      detail: taskId ? getWorkbenchTaskDetail(taskId) : null,
      actionItems: taskId ? listWorkbenchActionItemsByTask(taskId) : [],
      subtasks: taskId ? listWorkbenchSubtasksByTask(taskId) : [],
      events: taskId ? listWorkbenchEventsByTask(taskId).slice(-30) : [],
    };
  }

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

  return context;
}

function buildInvestigationPrompt(
  item: AgentInboxItemView,
  context: Record<string, unknown>,
): string {
  return `你是 NanoClaw 主群个人助手的异常排查 Agent。请基于上下文判断触发项原因，以及是否可以自动修复。

只返回 JSON，不要返回 Markdown 或额外解释。JSON 格式必须是：
{
  "ok": true,
  "summary": "一句话排查结论",
  "root_cause": "根因，无法判断时为 null",
  "repairable": true,
  "repair_plan": "可修复时的修复方案，否则为 null",
  "risk_level": "low|medium|high|unknown",
  "required_user_action": "需要用户处理的动作，没有则为 null",
  "evidence": [{"label":"证据名","value":"证据内容"}]
}

约束：
- 不确定是否安全修复时，repairable 必须为 false。
- 涉及审批、产品判断、权限变更、外部系统破坏性操作时，repairable 必须为 false。
- 只根据给定上下文判断。

触发项：${item.title}
上下文：
${stringifyContext(context)}
`;
}

function buildRepairPrompt(
  item: AgentInboxItemView,
  context: Record<string, unknown>,
  investigation: InvestigationResult,
): string {
  return `你是 NanoClaw 主群个人助手的异常修复 Agent。请按排查结论尝试修复；如果无法安全修复，说明原因。

只返回 JSON，不要返回 Markdown 或额外解释。JSON 格式必须是：
{
  "ok": true,
  "fixed": true,
  "summary": "一句话修复结论",
  "result": "具体执行结果",
  "next_action": "仍需用户处理的动作，没有则为 null"
}

约束：
- 只能执行排查结论中 repair_plan 描述的修复。
- 不确定、风险升高或缺少权限时，fixed 必须为 false，并说明 next_action。

触发项：${item.title}
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

export function canInvestigateInboxItem(item: AgentInboxItemView): boolean {
  const ruleKey = toRuleKey(item.extra.ruleKey);
  return (
    ruleKey === 'workbench.task_failed_or_cancelled' ||
    ruleKey === 'workbench.task_stale' ||
    ruleKey === 'scheduler.task_failed' ||
    ruleKey === 'agent_runs.query_failed'
  );
}

export function canRepairInboxItem(item: AgentInboxItemView): boolean {
  const investigation = item.extra.investigation;
  return (
    canInvestigateInboxItem(item) &&
    isObject(investigation) &&
    investigation.repairable === true
  );
}

export function shouldAutoProcessInboxItem(item: AgentInboxItemView): boolean {
  if (!canInvestigateInboxItem(item)) return false;
  const status = item.extra.autoFlowStatus;
  return (
    status !== 'investigating' &&
    status !== 'investigated' &&
    status !== 'repairing' &&
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
    const output = await agentRunner({
      purpose: 'investigation',
      item,
      prompt: buildInvestigationPrompt(item, context),
    });
    if (!output.ok) {
      throw new Error(output.error || output.text || 'Investigation failed');
    }

    const result = parseInvestigationResult(output.text);
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
  const context = buildContext(item);
  updateAgentInboxItemExtra(item.id, {
    autoFlowStatus: 'repairing',
    lastRepairError: null,
  });

  try {
    const output = await agentRunner({
      purpose: 'repair',
      item,
      prompt: buildRepairPrompt(item, context, investigation),
    });
    if (!output.ok) {
      throw new Error(output.error || output.text || 'Repair failed');
    }

    const result = parseRepairResult(output.text);
    const updated = updateAgentInboxItemExtra(item.id, {
      autoFlowStatus: result.fixed ? 'fixed' : 'repair_failed',
      repair: result as unknown as Record<string, unknown>,
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
  investigation: InvestigationResult;
  repair?: RepairResult;
}> {
  const investigated = await investigateAgentInboxItem(itemId);
  if (!investigated.result.repairable) {
    return {
      item: investigated.item,
      investigation: investigated.result,
    };
  }
  const repaired = await repairAgentInboxItem(itemId);
  return {
    item: repaired.item,
    investigation: investigated.result,
    repair: repaired.result,
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
