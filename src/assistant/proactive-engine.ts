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
  getAssistantSettings,
} from './agent-inbox-store.js';
import type { AgentInboxPriority, UpsertAgentInboxItemInput } from './types.js';

const WORKSTATION_URL = 'http://localhost:3000/';
const DEFAULT_STALE_TASK_HOURS = 4;

let proactiveLoopStarted = false;
let proactiveLoopTimer: NodeJS.Timeout | null = null;

function workstationUrl(target: string, params: Record<string, string> = {}): string {
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

function isTerminalStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '').toLowerCase();
  return [
    'completed',
    'complete',
    'done',
    'success',
    'succeeded',
    'closed',
    'resolved',
    'cancelled',
    'canceled',
    'failed',
    'error',
  ].includes(normalized);
}

function isFailureStatus(status: string | null | undefined): boolean {
  const normalized = String(status || '').toLowerCase();
  return ['failed', 'error', 'cancelled', 'canceled'].includes(normalized);
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

function scanTodayPlanRules(
  items: UpsertAgentInboxItemInput[],
  now: Date,
): void {
  const todayKey = getTodayPlanDateKey(now);
  const todayPlan = getTodayPlanByDate(todayKey);
  if (!todayPlan) {
    pushInbox(items, {
      dedupeKey: `today-plan:missing:${todayKey}`,
      kind: 'suggestion',
      priority: 'high',
      title: '今天还没有计划',
      body: '可以先创建今日计划，再把工作台任务、群聊上下文和服务分支纳入当天工作面。',
      sourceType: 'today_plan',
      sourceRefId: todayKey,
      actionKind: 'create_today_plan',
      actionLabel: '创建今日计划',
      actionUrl: workstationUrl('today-plan'),
      actionPayload: { planDate: todayKey },
    });
  }

  const unfinishedPlan = listTodayPlans({ before_date: todayKey, limit: 10 }).find(
    (plan: TodayPlanRecord) => plan.status === 'active',
  );
  if (unfinishedPlan && !todayPlan) {
    pushInbox(items, {
      dedupeKey: `today-plan:continue:${todayKey}:${unfinishedPlan.id}`,
      kind: 'suggestion',
      priority: 'normal',
      title: '有未完成的往日计划',
      body: `${unfinishedPlan.plan_date} 的计划仍处于 active 状态，可以承接到今天继续处理。`,
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
): void {
  for (const actionItem of listWorkbenchActionItemsByTask(task.id)) {
    if (!isPendingActionItem(actionItem)) continue;
    pushInbox(items, {
      dedupeKey: `workbench:action-item:${actionItem.id}`,
      kind: actionItem.replyable ? 'approval' : 'notification',
      priority: actionItem.replyable ? 'high' : 'normal',
      title: actionItem.title || '工作台有待处理项',
      body:
        actionItem.body ||
        `${task.title} 的 ${actionItem.stage_key || task.current_stage} 阶段需要处理。`,
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
): void {
  const nowMs = now.getTime();
  for (const task of listWorkbenchTasks()) {
    scanWorkbenchActionItems(items, task);

    if (isFailureStatus(task.status)) {
      pushInbox(items, {
        dedupeKey: `workbench:task-risk:${task.id}:${task.status}`,
        kind: 'risk',
        priority: 'high',
        title: `工作台任务异常：${task.title}`,
        body: `当前状态为 ${task.status}，建议进入工作台查看失败阶段和日志。`,
        sourceType: 'workbench_task',
        sourceRefId: task.id,
        actionKind: 'open_workbench_task',
        actionLabel: '打开工作台',
        actionUrl: workstationUrl('workbench', { taskId: task.id }),
        extra: {
          taskId: task.id,
          workflowId: task.workflow_id,
          service: task.service,
        },
      });
    }

    if (isTerminalStatus(task.status)) continue;
    const lastTouch = timestampMs(task.last_event_at || task.updated_at);
    if (!lastTouch) continue;
    const ageHours = (nowMs - lastTouch) / (60 * 60 * 1000);
    if (ageHours < DEFAULT_STALE_TASK_HOURS) continue;
    pushInbox(items, {
      dedupeKey: `workbench:task-stale:${task.id}`,
      kind: 'risk',
      priority: 'normal',
      title: `任务长时间没有进展：${task.title}`,
      body: `最近一次更新约 ${Math.floor(ageHours)} 小时前，可能需要检查当前 Agent 或阶段是否卡住。`,
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

function scanSchedulerRules(items: UpsertAgentInboxItemInput[]): void {
  for (const task of getAllTasks() as ScheduledTask[]) {
    if (!task.last_result || !/^error:/i.test(task.last_result.trim())) continue;
    pushInbox(items, {
      dedupeKey: `scheduler:failure:${task.id}:${task.last_run || task.last_result}`,
      kind: 'risk',
      priority: 'high',
      title: '定时任务执行失败',
      body: task.last_result.slice(0, 240),
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

function scanAgentRunRules(items: UpsertAgentInboxItemInput[]): void {
  for (const query of listAgentQueries(30, 0) as AgentQueryRecord[]) {
    if (!isFailureStatus(query.status)) continue;
    const priority: AgentInboxPriority =
      query.failure_retryable === 0 ? 'high' : 'normal';
    pushInbox(items, {
      dedupeKey: `agent-query:error:${query.query_id}`,
      kind: 'risk',
      priority,
      title: 'Agent 执行异常',
      body:
        query.error_message ||
        query.output_preview ||
        `${query.source_type} 执行状态为 ${query.status}`,
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

export function runProactiveScan(input: { now?: Date } = {}): {
  createdOrUpdated: number;
  scannedAt: string;
} {
  const settings = getAssistantSettings();
  const scannedAt = Date.now().toString();
  if (!settings.enabled) {
    emitAssistantEvent({
      type: 'scan_completed',
      createdOrUpdated: 0,
      scannedAt,
    });
    return { createdOrUpdated: 0, scannedAt };
  }

  const candidates: UpsertAgentInboxItemInput[] = [];
  const now = input.now || new Date();

  if (settings.dataSources.todayPlan) scanTodayPlanRules(candidates, now);
  if (settings.dataSources.workbench) scanWorkbenchRules(candidates, now);
  if (settings.dataSources.scheduler) scanSchedulerRules(candidates);
  if (settings.dataSources.agentRuns) scanAgentRunRules(candidates);

  for (const item of candidates) {
    createOrUpdateAgentInboxItem(item);
  }

  emitAssistantEvent({
    type: 'scan_completed',
    createdOrUpdated: candidates.length,
    scannedAt,
  });
  return { createdOrUpdated: candidates.length, scannedAt };
}

export function startProactiveEngine(): void {
  if (proactiveLoopStarted) {
    logger.debug('Assistant proactive engine already running');
    return;
  }
  proactiveLoopStarted = true;
  logger.info('Assistant proactive engine started');

  const loop = () => {
    try {
      runProactiveScan();
    } catch (err) {
      logger.error({ err }, 'Assistant proactive scan failed');
    }

    const settings = getAssistantSettings();
    proactiveLoopTimer = setTimeout(
      loop,
      Math.max(settings.scanIntervalMinutes, 1) * 60 * 1000,
    );
  };

  loop();
}

/** @internal - for tests only. */
export function _resetProactiveEngineForTests(): void {
  if (proactiveLoopTimer) clearTimeout(proactiveLoopTimer);
  proactiveLoopTimer = null;
  proactiveLoopStarted = false;
}
