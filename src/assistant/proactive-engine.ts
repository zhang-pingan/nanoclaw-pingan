import {
  getAllTasks,
  getTodayPlanByDate,
  listAgentQueries,
  listTodayPlans,
} from '../db.js';
import { logger } from '../logger.js';
import { getTodayPlanDateKey } from '../today-plan.js';
import type {
  AgentQueryRecord,
  ScheduledTask,
  TodayPlanRecord,
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
        body: '可以打开今日计划页，再把群聊上下文和服务分支纳入当天工作面。',
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
        canInvestigateInboxItem(inboxItem) &&
        (ruleKey === 'today_plan.service_coding_anomaly' ||
          shouldAutoProcessInboxItem(inboxItem))
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
