import {
  getAllTasks,
  getTodayPlanByDate,
  listAgentQueries,
  listTodayPlans,
  listWorkbenchActionItemsByTask,
  listWorkbenchTasks,
} from '../db.js';
import { logger } from '../logger.js';
import { getTodayPlanDateKey } from '../today-plan.js';
import type {
  AgentQueryRecord,
  ScheduledTask,
  TodayPlanRecord,
  WorkbenchActionItemRecord,
  WorkbenchTaskRecord,
} from '../types.js';
import { emitAssistantEvent } from './assistant-events.js';
import {
  createOrUpdateAgentInboxItem,
  deleteLegacyActiveAgentInboxItemsWithoutTriggerRule,
  getAssistantSettings,
  resolveActiveAgentInboxItemByDedupeKey,
  resolveActiveAgentInboxItemsByTriggerRule,
  resolveActiveAgentInboxItemsBySource,
} from './agent-inbox-store.js';
import {
  canAutoHandleWorkbenchActionItem,
  canInvestigateInboxItem,
  scheduleAutoProcessAgentInboxItem,
  shouldAutoProcessInboxItem,
} from './assistant-auto-flow.js';
import { scanOnlineErrorLogRule } from './online-error-log.js';
import { scanTodayPlanCodingAnomalyRule } from './today-plan-coding-anomaly.js';
import { resolveTodayPlanInboxItemsForDate } from './today-plan-inbox.js';
import type {
  AgentInboxPriority,
  AssistantScanScheduleState,
  AssistantSettings,
  AssistantTriggerRuleKey,
  UpsertAgentInboxItemInput,
} from './types.js';

const WORKSTATION_URL = 'http://localhost:3000/';
const DEFAULT_STALE_TASK_HOURS = 4;

let proactiveLoopStarted = false;
let proactiveLoopTimer: NodeJS.Timeout | null = null;
let proactiveNextScanAt: string | null = null;
let proactiveScanRunning = false;
let proactiveLastScanStartedAt: string | null = null;
let proactiveLastScanFinishedAt: string | null = null;
let proactiveLastScanCreatedOrUpdated: number | null = null;
let proactiveLastScanOk: boolean | null = null;
let proactiveLastScanError: string | null = null;

function proactiveScanDelayMs(settings: AssistantSettings): number {
  return Math.max(settings.scanIntervalMinutes, 1) * 60 * 1000;
}

function clearProactiveLoopTimer(): void {
  if (proactiveLoopTimer) {
    clearTimeout(proactiveLoopTimer);
    proactiveLoopTimer = null;
  }
  proactiveNextScanAt = null;
}

function scheduleNextProactiveScan(): void {
  const settings = getAssistantSettings();
  const delayMs = proactiveScanDelayMs(settings);
  proactiveNextScanAt = String(Date.now() + delayMs);
  proactiveLoopTimer = setTimeout(runProactiveLoop, delayMs);
}

async function runProactiveLoop(): Promise<void> {
  proactiveLoopTimer = null;
  proactiveNextScanAt = null;
  try {
    await runProactiveScan();
  } catch (err) {
    logger.error({ err }, 'Assistant proactive scan failed');
  } finally {
    scheduleNextProactiveScan();
  }
}

function workstationUrl(
  target: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(WORKSTATION_URL);
  url.searchParams.set('assistantTarget', target);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFailureStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '').toLowerCase();
  return ['failed', 'error', 'cancelled', 'canceled'].includes(normalized);
}

function isWorkbenchRiskState(taskState: string | null | undefined): boolean {
  return taskState === 'failed' || taskState === 'cancelled';
}

function isPendingActionItem(item: WorkbenchActionItemRecord): boolean {
  return ![
    'resolved',
    'done',
    'dismissed',
    'closed',
    'cancelled',
    'canceled',
  ].includes(String(item.status || '').toLowerCase());
}

function pushInbox(
  items: UpsertAgentInboxItemInput[],
  input: UpsertAgentInboxItemInput,
): void {
  items.push(input);
}

function isRuleEnabled(
  settings: AssistantSettings,
  ruleKey: AssistantTriggerRuleKey,
): boolean {
  return Boolean(settings.triggerRules[ruleKey]?.enabled);
}

function resolveDisabledRule(
  settings: AssistantSettings,
  ruleKey: AssistantTriggerRuleKey,
): boolean {
  if (isRuleEnabled(settings, ruleKey)) return false;
  resolveActiveAgentInboxItemsByTriggerRule(ruleKey);
  return true;
}

function scanTodayPlanRules(
  items: UpsertAgentInboxItemInput[],
  now: Date,
  settings: AssistantSettings,
): void {
  const todayKey = getTodayPlanDateKey(now);
  const todayPlan = getTodayPlanByDate(todayKey);
  if (!todayPlan) {
    if (resolveDisabledRule(settings, 'today_plan.missing_today_plan')) {
      resolveActiveAgentInboxItemByDedupeKey(`today-plan:missing:${todayKey}`);
    } else {
      pushInbox(items, {
        dedupeKey: `today-plan:missing:${todayKey}`,
        kind: 'suggestion',
        priority: 'high',
        title: '今天还没有计划',
        body: '可以打开今日计划页，再把工作台任务、群聊上下文和服务分支纳入当天工作面。',
        triggerRuleKey: 'today_plan.missing_today_plan',
        sourceType: 'today_plan',
        sourceRefId: todayKey,
        actionUrl: workstationUrl('today-plan'),
      });
    }
  } else {
    resolveTodayPlanInboxItemsForDate(todayKey);
  }

  const unfinishedPlan = listTodayPlans({
    before_date: todayKey,
    limit: 10,
  }).find((plan: TodayPlanRecord) => plan.status === 'active');
  if (unfinishedPlan && !todayPlan) {
    if (resolveDisabledRule(settings, 'today_plan.unfinished_previous_plan')) {
      resolveActiveAgentInboxItemByDedupeKey(
        `today-plan:continue:${todayKey}:${unfinishedPlan.id}`,
      );
      return;
    }
    pushInbox(items, {
      dedupeKey: `today-plan:continue:${todayKey}:${unfinishedPlan.id}`,
      kind: 'suggestion',
      priority: 'normal',
      title: '有未完成的往日计划',
      body: `${unfinishedPlan.plan_date} 的计划仍处于 active 状态，可以承接到今天继续处理。`,
      triggerRuleKey: 'today_plan.unfinished_previous_plan',
      sourceType: 'today_plan',
      sourceRefId: unfinishedPlan.id,
      actionKind: 'continue_today_plan',
      actionLabel: '承接到今天',
      actionUrl: workstationUrl('today-plan', {
        planId: unfinishedPlan.id,
      }),
      actionPayload: { continueFromPlanId: unfinishedPlan.id },
    });
  }
}

function scanWorkbenchActionItems(
  items: UpsertAgentInboxItemInput[],
  task: WorkbenchTaskRecord,
  settings: AssistantSettings,
): void {
  for (const actionItem of listWorkbenchActionItemsByTask(task.id)) {
    if (!isPendingActionItem(actionItem)) {
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'workbench_action_item',
        sourceRefId: actionItem.id,
      });
      continue;
    }
    if (resolveDisabledRule(settings, 'workbench.pending_action_item')) {
      resolveActiveAgentInboxItemByDedupeKey(
        `workbench:action-item:${actionItem.id}`,
      );
      continue;
    }
    pushInbox(items, {
      dedupeKey: `workbench:action-item:${actionItem.id}`,
      kind: actionItem.replyable ? 'approval' : 'notification',
      priority: actionItem.replyable ? 'high' : 'normal',
      title: actionItem.title || '工作台有待处理项',
      body:
        actionItem.body ||
        `${task.title} 的 ${actionItem.stage_key || task.current_stage} 阶段需要处理。`,
      triggerRuleKey: 'workbench.pending_action_item',
      sourceType: 'workbench_action_item',
      sourceRefId: actionItem.id,
      actionKind: 'open_workbench_action_item',
      actionLabel: '查看待处理',
      actionUrl: workstationUrl('workbench', {
        taskId: task.id,
        actionItemId: actionItem.id,
      }),
      extra: {
        taskId: task.id,
        workflowId: task.workflow_id,
        service: task.service,
        stageKey: actionItem.stage_key || task.current_stage,
      },
    });
  }
}

function scanWorkbenchRules(
  items: UpsertAgentInboxItemInput[],
  now: Date,
  settings: AssistantSettings,
): void {
  const nowMs = now.getTime();
  for (const task of listWorkbenchTasks()) {
    scanWorkbenchActionItems(items, task, settings);

    const staleDedupeKey = `workbench:task-stale:${task.id}`;

    if (isWorkbenchRiskState(task.task_state)) {
      const riskDedupeKey = `workbench:task-risk:${task.id}:${task.task_state}:${task.status}`;
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'workbench_task',
        sourceRefId: task.id,
        excludeDedupeKeys: [riskDedupeKey],
      });
      if (resolveDisabledRule(settings, 'workbench.task_failed_or_cancelled')) {
        resolveActiveAgentInboxItemByDedupeKey(riskDedupeKey);
        continue;
      }
      pushInbox(items, {
        dedupeKey: riskDedupeKey,
        kind: 'risk',
        priority: 'high',
        title: `工作台任务异常：${task.title}`,
        body: `当前任务态为 ${task.task_state}，流程状态为 ${task.status}，建议进入工作台查看失败阶段和日志。`,
        triggerRuleKey: 'workbench.task_failed_or_cancelled',
        sourceType: 'workbench_task',
        sourceRefId: task.id,
        actionKind: 'open_workbench_task',
        actionLabel: '打开工作台',
        actionUrl: workstationUrl('workbench', { taskId: task.id }),
        extra: {
          taskId: task.id,
          workflowId: task.workflow_id,
          service: task.service,
          taskState: task.task_state,
          workflowStatus: task.status,
        },
      });
      continue;
    }

    if (task.task_state !== 'running') {
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'workbench_task',
        sourceRefId: task.id,
      });
      continue;
    }

    const lastTouch = timestampMs(task.last_event_at || task.updated_at);
    if (!lastTouch) {
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'workbench_task',
        sourceRefId: task.id,
      });
      continue;
    }
    const ageHours = (nowMs - lastTouch) / (60 * 60 * 1000);
    if (ageHours < DEFAULT_STALE_TASK_HOURS) {
      resolveActiveAgentInboxItemByDedupeKey(staleDedupeKey);
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'workbench_task',
        sourceRefId: task.id,
        excludeDedupeKeys: [staleDedupeKey],
      });
      continue;
    }
    resolveActiveAgentInboxItemsBySource({
      sourceType: 'workbench_task',
      sourceRefId: task.id,
      excludeDedupeKeys: [staleDedupeKey],
    });
    if (resolveDisabledRule(settings, 'workbench.task_stale')) {
      resolveActiveAgentInboxItemByDedupeKey(staleDedupeKey);
      continue;
    }
    pushInbox(items, {
      dedupeKey: staleDedupeKey,
      kind: 'risk',
      priority: 'normal',
      title: `任务长时间没有进展：${task.title}`,
      body: `最近一次更新约 ${Math.floor(ageHours)} 小时前，可能需要检查当前 Agent 或阶段是否卡住。`,
      triggerRuleKey: 'workbench.task_stale',
      sourceType: 'workbench_task',
      sourceRefId: task.id,
      actionKind: 'open_workbench_task',
      actionLabel: '查看任务',
      actionUrl: workstationUrl('workbench', { taskId: task.id }),
      extra: {
        taskId: task.id,
        workflowId: task.workflow_id,
        service: task.service,
        staleHours: Math.floor(ageHours),
      },
    });
  }
}

function scanSchedulerRules(
  items: UpsertAgentInboxItemInput[],
  settings: AssistantSettings,
): void {
  for (const task of getAllTasks() as ScheduledTask[]) {
    if (!task.last_result || !/^error:/i.test(task.last_result.trim())) {
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'scheduled_task',
        sourceRefId: task.id,
      });
      continue;
    }
    const dedupeKey = `scheduler:failure:${task.id}:${task.last_run || task.last_result}`;
    if (resolveDisabledRule(settings, 'scheduler.task_failed')) {
      resolveActiveAgentInboxItemByDedupeKey(dedupeKey);
      continue;
    }
    pushInbox(items, {
      dedupeKey,
      kind: 'risk',
      priority: 'high',
      title: '定时任务执行失败',
      body: task.last_result.slice(0, 240),
      triggerRuleKey: 'scheduler.task_failed',
      sourceType: 'scheduled_task',
      sourceRefId: task.id,
      actionKind: 'open_scheduled_task',
      actionLabel: '查看定时任务',
      actionUrl: workstationUrl('schedulers', { taskId: task.id }),
      extra: {
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        lastRun: task.last_run,
      },
    });
  }
}

function scanAgentRunRules(
  items: UpsertAgentInboxItemInput[],
  settings: AssistantSettings,
): void {
  for (const query of listAgentQueries(30, 0) as AgentQueryRecord[]) {
    if (!isFailureStatus(query.status)) {
      resolveActiveAgentInboxItemsBySource({
        sourceType: 'agent_query',
        sourceRefId: query.query_id,
      });
      continue;
    }
    const dedupeKey = `agent-query:error:${query.query_id}`;
    if (resolveDisabledRule(settings, 'agent_runs.query_failed')) {
      resolveActiveAgentInboxItemByDedupeKey(dedupeKey);
      continue;
    }
    const priority: AgentInboxPriority =
      query.failure_retryable === 0 ? 'high' : 'normal';
    pushInbox(items, {
      dedupeKey,
      kind: 'risk',
      priority,
      title: 'Agent 执行异常',
      body:
        query.error_message ||
        query.output_preview ||
        `${query.source_type} 执行状态为 ${query.status}`,
      triggerRuleKey: 'agent_runs.query_failed',
      sourceType: 'agent_query',
      sourceRefId: query.query_id,
      actionKind: 'open_trace',
      actionLabel: '查看 Trace',
      actionUrl: workstationUrl('trace-monitor', { queryId: query.query_id }),
      extra: {
        runId: query.run_id,
        groupFolder: query.group_folder,
        workflowId: query.workflow_id,
        stageKey: query.stage_key,
      },
    });
  }
}

export async function runProactiveScan(input: { now?: Date } = {}): Promise<{
  createdOrUpdated: number;
  scannedAt: string;
}> {
  proactiveLastScanStartedAt = Date.now().toString();
  proactiveScanRunning = true;
  let result: { createdOrUpdated: number; scannedAt: string } | null = null;
  let scanError: string | null = null;

  try {
    const settings = getAssistantSettings();
    const scannedAt = Date.now().toString();
    if (!settings.enabled) {
      logger.info(
        { scannedAt, count: 0 },
        'Assistant proactive scan completed',
      );
      emitAssistantEvent({
        type: 'scan_completed',
        createdOrUpdated: 0,
        scannedAt,
      });
      result = { createdOrUpdated: 0, scannedAt };
      return result;
    }

    const candidates: UpsertAgentInboxItemInput[] = [];
    const now = input.now || new Date();

    deleteLegacyActiveAgentInboxItemsWithoutTriggerRule();
    scanTodayPlanRules(candidates, now, settings);
    scanWorkbenchRules(candidates, now, settings);
    scanSchedulerRules(candidates, settings);
    scanAgentRunRules(candidates, settings);
    if (!resolveDisabledRule(settings, 'online.error_logs')) {
      candidates.push(...scanOnlineErrorLogRule({ settings, now }));
    }
    if (!resolveDisabledRule(settings, 'today_plan.service_coding_anomaly')) {
      candidates.push(
        ...(await scanTodayPlanCodingAnomalyRule({ settings, now })),
      );
    }

    for (const item of candidates) {
      const inboxItem = createOrUpdateAgentInboxItem(item);
      const ruleKey =
        typeof inboxItem.extra.ruleKey === 'string'
          ? inboxItem.extra.ruleKey
          : '';
      if (
        ruleKey &&
        settings.triggerRules[ruleKey as AssistantTriggerRuleKey]
          ?.autoEnabled &&
        ((canInvestigateInboxItem(inboxItem) &&
          (ruleKey === 'today_plan.service_coding_anomaly' ||
            shouldAutoProcessInboxItem(inboxItem))) ||
          (canAutoHandleWorkbenchActionItem(inboxItem) &&
            shouldAutoProcessInboxItem(inboxItem)))
      ) {
        scheduleAutoProcessAgentInboxItem(inboxItem.id);
      }
    }

    logger.info(
      { scannedAt, count: candidates.length },
      'Assistant proactive scan completed',
    );
    emitAssistantEvent({
      type: 'scan_completed',
      createdOrUpdated: candidates.length,
      scannedAt,
    });
    result = { createdOrUpdated: candidates.length, scannedAt };
    return result;
  } catch (err) {
    scanError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    proactiveScanRunning = false;
    proactiveLastScanFinishedAt = Date.now().toString();
    proactiveLastScanCreatedOrUpdated = result?.createdOrUpdated ?? null;
    proactiveLastScanOk = result ? true : false;
    proactiveLastScanError = scanError;
  }
}

export function startProactiveEngine(): void {
  if (proactiveLoopStarted) {
    logger.debug('Assistant proactive engine already running');
    return;
  }
  proactiveLoopStarted = true;
  logger.info('Assistant proactive engine started');
  void runProactiveLoop();
}

export function rescheduleProactiveEngine(): void {
  if (!proactiveLoopStarted) return;
  clearProactiveLoopTimer();
  scheduleNextProactiveScan();
}

export function getProactiveScheduleState(): AssistantScanScheduleState {
  const settings = getAssistantSettings();
  return {
    loopStarted: proactiveLoopStarted,
    scanRunning: proactiveScanRunning,
    intervalMinutes: settings.scanIntervalMinutes,
    lastScanStartedAt: proactiveLastScanStartedAt,
    lastScanFinishedAt: proactiveLastScanFinishedAt,
    lastScanCreatedOrUpdated: proactiveLastScanCreatedOrUpdated,
    lastScanOk: proactiveLastScanOk,
    lastScanError: proactiveLastScanError,
    nextScanAt:
      proactiveLoopStarted && settings.enabled ? proactiveNextScanAt : null,
  };
}

/** @internal - for tests only. */
export function _resetProactiveEngineForTests(): void {
  clearProactiveLoopTimer();
  proactiveLoopStarted = false;
  proactiveScanRunning = false;
  proactiveLastScanStartedAt = null;
  proactiveLastScanFinishedAt = null;
  proactiveLastScanCreatedOrUpdated = null;
  proactiveLastScanOk = null;
  proactiveLastScanError = null;
}
