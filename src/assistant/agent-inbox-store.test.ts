import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createAgentQuery,
  createWorkbenchActionItem,
  createWorkbenchTask,
  getWorkbenchActionItem,
  getDatabase,
  updateAgentQuery,
} from '../db.js';
import { initAssistantAutoFlow } from './assistant-auto-flow.js';
import { createOrContinueTodayPlan } from '../today-plan.js';
import { initAssistantEvents } from './assistant-events.js';
import { runAgentInboxAction } from './assistant-actions.js';
import {
  createOrUpdateAgentInboxItem,
  getAgentInboxItem,
  getAssistantSettings,
  listAgentInboxItems,
  updateAssistantSettings,
} from './agent-inbox-store.js';
import { getAssistantState } from './assistant-api.js';
import { createEvolutionItem, updateEvolutionItem } from './evolution-store.js';
import { runProactiveScan } from './proactive-engine.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
  initAssistantAutoFlow({ agentRunner: null });
});

afterEach(() => {
  vi.useRealTimers();
});

function createStoredWorkbenchTask(input: {
  id: string;
  status: string;
  taskState: 'running' | 'success' | 'failed' | 'cancelled';
  updatedAt: string;
}): void {
  createWorkbenchTask({
    id: input.id,
    workflow_id: input.id.replace(/^wb-/, ''),
    source_jid: 'main@g.us',
    title: '工作台测试任务',
    service: 'catstory',
    start_from: 'dev',
    workflow_type: 'dev_test',
    status: input.status,
    task_state: input.taskState,
    current_stage: input.status,
    summary: null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    last_event_at: input.updatedAt,
  });
}

function createStoredWorkbenchActionItem(input: {
  id: string;
  taskId: string;
  workflowId: string;
  stageKey: string;
  sourceType?: string;
  title?: string;
  body?: string;
  extra?: Record<string, unknown>;
}): void {
  createWorkbenchActionItem({
    id: input.id,
    task_id: input.taskId,
    workflow_id: input.workflowId,
    subtask_id: null,
    stage_key: input.stageKey,
    delegation_id: null,
    group_folder: null,
    item_type: 'interactive',
    status: 'pending',
    title: input.title || '自动处理测试待办',
    body: input.body || '这是一条工作台待处理项',
    source_type: input.sourceType || 'send_message',
    source_ref_id: `source-${input.id}`,
    replyable: 0,
    created_at: Date.now().toString(),
    updated_at: Date.now().toString(),
    resolved_at: null,
    extra_json: input.extra ? JSON.stringify(input.extra) : null,
  });
}

function createStoredAgentQuery(input: {
  queryId: string;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'timeout';
}): void {
  const now = String(Date.now());
  createAgentQuery({
    id: `agent-query-record-${input.queryId}`,
    query_id: input.queryId,
    run_id: `run-${input.queryId}`,
    source_type: 'message',
    source_ref_id: `message-${input.queryId}`,
    chat_jid: 'main@g.us',
    group_folder: 'main',
    workflow_id: null,
    stage_key: null,
    delegation_id: null,
    session_id: null,
    selected_model: null,
    selected_model_reason: null,
    actual_model: null,
    prompt_hash: null,
    memory_pack_hash: null,
    tools_hash: null,
    mounts_hash: null,
    status: input.status,
    current_step_id: null,
    current_phase: null,
    current_action: null,
    failure_type: input.status === 'error' ? 'container_runtime_error' : null,
    failure_subtype: input.status === 'error' ? 'agent_execution_failed' : null,
    failure_origin: input.status === 'error' ? 'container' : null,
    failure_retryable: input.status === 'error' ? 1 : null,
    error_message: input.status === 'error' ? 'Agent failed' : null,
    output_digest: null,
    output_preview: null,
    first_output_at: null,
    first_tool_at: null,
    last_event_at: now,
    started_at: now,
    ended_at: input.status === 'running' ? null : now,
    latency_ms: input.status === 'running' ? null : 1,
    created_at: now,
    updated_at: now,
  });
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('agent inbox store', () => {
  it('merges assistant settings without dropping nested defaults', () => {
    const settings = updateAssistantSettings({
      enabled: false,
      triggerRules: {
        'workbench.task_stale': {
          enabled: false,
          investigationEnabled: true,
          autoEnabled: true,
          selectedServices: [],
          lookbackDays: 3,
        },
      },
      desktopAssistant: { allowMovement: false },
    });

    expect(settings.enabled).toBe(false);
    expect(settings.triggerRules['workbench.task_stale'].enabled).toBe(false);
    expect(
      settings.triggerRules['workbench.task_stale'].investigationEnabled,
    ).toBe(true);
    expect(settings.triggerRules['workbench.task_stale'].autoEnabled).toBe(
      true,
    );
    expect(settings.triggerRules['today_plan.missing_today_plan'].enabled).toBe(
      true,
    );
    expect(settings.desktopAssistant.allowMovement).toBe(false);
    expect(settings.desktopAssistant.alwaysOnTop).toBe(true);
    expect(getAssistantSettings().enabled).toBe(false);
  });

  it('allows workbench pending action items to enable auto handling', () => {
    const settings = updateAssistantSettings({
      triggerRules: {
        'workbench.pending_action_item': {
          enabled: true,
          investigationEnabled: false,
          autoEnabled: true,
          selectedServices: [],
          lookbackDays: 3,
        },
      },
    });

    expect(
      settings.triggerRules['workbench.pending_action_item'].autoEnabled,
    ).toBe(true);
    expect(
      settings.triggerRules['workbench.pending_action_item']
        .investigationEnabled,
    ).toBe(false);
  });

  it('merges assistant evolution settings without enabling automation by default', () => {
    const settings = updateAssistantSettings({
      evolution: {
        enabled: true,
        autoImplementEnabled: true,
        scanIntervalMinutes: 30,
      },
    });

    expect(settings.evolution.enabled).toBe(true);
    expect(settings.evolution.autoImplementEnabled).toBe(true);
    expect(settings.evolution.autoAdoptEnabled).toBe(false);
    expect(settings.evolution.scanIntervalMinutes).toBe(30);
    expect(settings.evolution.maxConcurrentItems).toBe(1);
    expect(settings.evolution.maxReviewRounds).toBe(2);
    expect(settings.evolution.allowedRiskLevel).toBe('medium');
  });

  it('normalizes old assistant data source settings into trigger rules', () => {
    getDatabase()
      .prepare(
        `INSERT INTO assistant_settings (key, value_json, updated_at)
         VALUES ('assistant', ?, ?)`,
      )
      .run(
        JSON.stringify({
          enabled: true,
          dataSources: {
            todayPlan: false,
            workbench: true,
            scheduler: true,
            agentRuns: true,
          },
        }),
        '1',
      );

    const settings = getAssistantSettings();
    const row = getDatabase()
      .prepare(
        "SELECT value_json FROM assistant_settings WHERE key = 'assistant'",
      )
      .get() as { value_json: string };
    const stored = JSON.parse(row.value_json) as Record<string, unknown>;

    expect(settings.triggerRules['today_plan.missing_today_plan'].enabled).toBe(
      true,
    );
    expect(stored.dataSources).toBeUndefined();
    expect(stored.triggerRules).toBeTruthy();
  });

  it('upserts active inbox items by dedupe key', () => {
    const first = createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item',
      kind: 'notification',
      title: 'Old title',
      sourceType: 'test',
      sourceRefId: '1',
    });
    const second = createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item',
      kind: 'risk',
      priority: 'high',
      title: 'New title',
      sourceType: 'test',
      sourceRefId: '1',
      actionPayload: { next: true },
    });

    expect(second.id).toBe(first.id);
    expect(second.kind).toBe('risk');
    expect(second.priority).toBe('high');
    expect(second.title).toBe('New title');
    expect(second.action_payload).toEqual({ next: true });
    expect(listAgentInboxItems({ status: 'active' })).toHaveLength(1);
  });

  it('preserves investigation metadata when refreshing existing inbox items', () => {
    createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item-with-flow',
      kind: 'risk',
      title: 'Old title',
      triggerRuleKey: 'workbench.task_stale',
      sourceType: 'workbench_task',
      sourceRefId: 'task-1',
      extra: {
        investigation: { repairable: true, summary: '已排查' },
        autoFlowStatus: 'investigated',
      },
    });

    const updated = createOrUpdateAgentInboxItem({
      dedupeKey: 'test:item-with-flow',
      kind: 'risk',
      title: 'New title',
      triggerRuleKey: 'workbench.task_stale',
      sourceType: 'workbench_task',
      sourceRefId: 'task-1',
      extra: { staleHours: 6 },
    });

    expect(updated.title).toBe('New title');
    expect(updated.extra.staleHours).toBe(6);
    expect(updated.extra.autoFlowStatus).toBe('investigated');
    expect(updated.extra.investigation).toEqual({
      repairable: true,
      summary: '已排查',
    });
  });

  it('creates a today-plan inbox item without direct create action', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const scan = await runProactiveScan({ now });
    expect(scan.createdOrUpdated).toBeGreaterThanOrEqual(1);

    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.dedupe_key === 'today-plan:missing:2026-04-28',
    );
    expect(item).toBeTruthy();
    expect(item?.action_kind).toBeNull();
    expect(item?.action_label).toBeNull();
    expect(item?.action_payload).toEqual({});
  });

  it('deletes legacy active inbox items before creating rule-keyed replacements', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const legacy = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan:missing:2026-04-28',
      kind: 'suggestion',
      priority: 'high',
      title: '旧提醒',
      sourceType: 'today_plan',
      sourceRefId: '2026-04-28',
    });

    await runProactiveScan({ now });

    expect(getAgentInboxItem(legacy.id)).toBeNull();
    const replacement = listAgentInboxItems({ status: 'active' }).find(
      (item) => item.dedupe_key === 'today-plan:missing:2026-04-28',
    );
    expect(replacement).toBeTruthy();
    expect(replacement?.id).not.toBe(legacy.id);
    expect(replacement?.extra.ruleKey).toBe('today_plan.missing_today_plan');
  });

  it('does not create inbox items for disabled fine-grained trigger rules', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    updateAssistantSettings({
      triggerRules: {
        'today_plan.missing_today_plan': {
          enabled: false,
          investigationEnabled: false,
          autoEnabled: false,
          selectedServices: [],
          lookbackDays: 3,
        },
      },
    });

    await runProactiveScan({ now });

    expect(
      listAgentInboxItems({ status: 'active' }).some(
        (item) => item.dedupe_key === 'today-plan:missing:2026-04-28',
      ),
    ).toBe(false);
  });

  it('resolves obsolete today-plan inbox items after today plan exists', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const missing = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan:missing:2026-04-28',
      kind: 'suggestion',
      priority: 'high',
      title: '今天还没有计划',
      triggerRuleKey: 'today_plan.missing_today_plan',
      sourceType: 'today_plan',
      sourceRefId: '2026-04-28',
    });
    const continuation = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan:continue:2026-04-28:old-plan',
      kind: 'suggestion',
      priority: 'normal',
      title: '有未完成的往日计划',
      triggerRuleKey: 'today_plan.unfinished_previous_plan',
      sourceType: 'today_plan',
      sourceRefId: 'old-plan',
    });

    createOrContinueTodayPlan({ planDate: '2026-04-28' });
    await runProactiveScan({ now });

    expect(getAgentInboxItem(missing.id)?.status).toBe('done');
    expect(getAgentInboxItem(continuation.id)?.status).toBe('done');
    expect(
      listAgentInboxItems({ status: 'active' }).some((item) =>
        item.dedupe_key.startsWith('today-plan:'),
      ),
    ).toBe(false);
  });

  it('resolves obsolete today-plan inbox items when refreshing assistant state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 28, 9, 0, 0));
    const missing = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan:missing:2026-04-28',
      kind: 'suggestion',
      priority: 'high',
      title: '今天还没有计划',
      sourceType: 'today_plan',
      sourceRefId: '2026-04-28',
    });

    createOrContinueTodayPlan({ planDate: '2026-04-28' });

    const state = getAssistantState();

    expect(getAgentInboxItem(missing.id)?.status).toBe('done');
    expect(
      state.latestInboxItems.some(
        (item) => item.dedupe_key === 'today-plan:missing:2026-04-28',
      ),
    ).toBe(false);
  });

  it('does not stale-alert successful workbench tasks', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const updatedAt = String(now.getTime() - 6 * 60 * 60 * 1000);
    createStoredWorkbenchTask({
      id: 'wb-success-task',
      status: 'passed',
      taskState: 'success',
      updatedAt,
    });

    await runProactiveScan({ now });

    expect(
      listAgentInboxItems({ status: 'active' }).some(
        (item) => item.dedupe_key === 'workbench:task-stale:wb-success-task',
      ),
    ).toBe(false);
  });

  it('resolves obsolete workbench stale inbox items after task success', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const updatedAt = String(now.getTime() - 6 * 60 * 60 * 1000);
    const stale = createOrUpdateAgentInboxItem({
      dedupeKey: 'workbench:task-stale:wb-resolved-success-task',
      kind: 'risk',
      priority: 'normal',
      title: '任务长时间没有进展：工作台测试任务',
      triggerRuleKey: 'workbench.task_stale',
      sourceType: 'workbench_task',
      sourceRefId: 'wb-resolved-success-task',
    });
    createStoredWorkbenchTask({
      id: 'wb-resolved-success-task',
      status: 'passed',
      taskState: 'success',
      updatedAt,
    });

    await runProactiveScan({ now });

    expect(getAgentInboxItem(stale.id)?.status).toBe('done');
  });

  it('does not repeatedly auto-process an inbox item after investigation exists', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const updatedAt = String(now.getTime() - 6 * 60 * 60 * 1000);
    const runner = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        ok: true,
        summary: '排查完成',
        root_cause: '任务无进展',
        repairable: false,
        repair_plan: null,
        risk_level: 'medium',
        required_user_action: '需要人工确认',
        evidence: [],
        groups: [
          {
            id: 'stale-task',
            title: '任务无进展',
            log_indexes: [],
            count: 1,
            root_cause: '任务无进展',
            repairable: false,
            repair_plan: null,
            risk_level: 'medium',
            required_user_action: '需要人工确认',
            evidence: [],
          },
        ],
      }),
    }));
    initAssistantAutoFlow({ agentRunner: runner });
    updateAssistantSettings({
      triggerRules: {
        'workbench.task_stale': {
          enabled: true,
          investigationEnabled: true,
          autoEnabled: true,
          selectedServices: [],
          lookbackDays: 3,
        },
      },
    });
    createStoredWorkbenchTask({
      id: 'wb-auto-stale-task',
      status: 'running',
      taskState: 'running',
      updatedAt,
    });

    await runProactiveScan({ now });
    await flushAsyncWork();

    expect(runner).toHaveBeenCalledTimes(1);
    runner.mockClear();

    await runProactiveScan({ now });
    await flushAsyncWork();

    expect(runner).not.toHaveBeenCalled();
    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.dedupe_key === 'workbench:task-stale:wb-auto-stale-task',
    );
    expect(item?.extra.autoFlowStatus).toBe('investigated');
  });

  it('auto-handles workbench pending action items through a workbench action agent', async () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const updatedAt = String(now.getTime());
    const workflowId = 'auto-action-workflow';
    const taskId = 'wb-auto-action-workflow';
    const actionItemId = 'wb-action-auto-message';
    createStoredWorkbenchTask({
      id: taskId,
      status: 'review',
      taskState: 'running',
      updatedAt,
    });
    createStoredWorkbenchActionItem({
      id: actionItemId,
      taskId,
      workflowId,
      stageKey: 'review',
      title: '阅读执行通知',
      body: '执行通知已送达，确认后可关闭待办。',
    });
    let capturedPrompt = '';
    const purposes: string[] = [];
    const runner = vi.fn(async ({ purpose, prompt }) => {
      purposes.push(purpose);
      capturedPrompt = prompt;
      return {
        ok: true,
        text: JSON.stringify({
          ok: true,
          decision: 'resolve',
          confidence: 'high',
          reason: '该待办是 send_message 通知，标记已读即可关闭。',
          payload: {},
          evidence: [{ label: '待办类型', value: 'send_message' }],
          unresolved_gaps: [],
        }),
      };
    });
    initAssistantAutoFlow({ agentRunner: runner });
    updateAssistantSettings({
      triggerRules: {
        'workbench.pending_action_item': {
          enabled: true,
          investigationEnabled: false,
          autoEnabled: true,
          selectedServices: [],
          lookbackDays: 3,
        },
      },
    });

    await runProactiveScan({ now });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(purposes).toEqual(['workbench_action']);
    expect(capturedPrompt).toContain('必须主动获取相关信息');
    expect(capturedPrompt).toContain(actionItemId);
    expect(getWorkbenchActionItem(actionItemId)?.status).toBe('resolved');
    const inbox = listAgentInboxItems({ status: 'all' }).find(
      (entry) => entry.dedupe_key === `workbench:action-item:${actionItemId}`,
    );
    expect(inbox?.status).toBe('done');
    expect(inbox?.extra.autoFlowStatus).toBe('handled');
    expect(inbox?.extra.workbenchActionDecision).toMatchObject({
      decision: 'resolve',
    });
  });

  it('stores a parseable investigation result even when the runner reports an error status', async () => {
    const runner = vi.fn(async () => ({
      ok: false,
      error: 'agent exited non-zero after final answer',
      text: JSON.stringify({
        ok: true,
        summary: '用户信息缺失导致查询失败，不建议自动修复。',
        root_cause: 'UserService.getUserInfo 未找到用户信息',
        repairable: false,
        repair_plan: null,
        risk_level: 'medium',
        required_user_action: '需要人工确认用户数据',
        evidence: [{ label: '异常信息', value: 'BusinessException' }],
        groups: [
          {
            id: 'user-info-missing',
            title: '用户信息缺失',
            log_indexes: [0],
            count: 1,
            root_cause: 'UserService.getUserInfo 未找到用户信息',
            repairable: false,
            repair_plan: null,
            risk_level: 'medium',
            required_user_action: '需要人工确认用户数据',
            evidence: [{ label: '异常信息', value: 'BusinessException' }],
          },
        ],
      }),
    }));
    initAssistantAutoFlow({ agentRunner: runner });
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'online-error-logs:catstory:test',
      kind: 'risk',
      priority: 'high',
      title: '线上 error 日志：catstory',
      triggerRuleKey: 'online.error_logs',
      sourceType: 'online_error_log',
      sourceRefId: 'catstory',
      extra: {
        onlineErrorLog: {
          service: 'catstory',
          logs: [{ rawLog: 'BusinessException: 用户信息未找到' }],
        },
      },
    });

    const result = await runAgentInboxAction({
      itemId: item.id,
      action: 'investigate',
    });

    expect(result.item.extra.autoFlowStatus).toBe('investigated');
    expect(result.item.extra.lastInvestigationError).toBeNull();
    expect(result.item.extra.investigation).toMatchObject({
      summary: '用户信息缺失导致查询失败，不建议自动修复。',
      repairable: false,
      required_user_action: '需要人工确认用户数据',
      groups: [
        {
          id: 'user-info-missing',
          log_indexes: [0],
          repairable: false,
        },
      ],
    });
  });

  it('asks agent run investigation to gather logs, trace, and source evidence', async () => {
    createStoredAgentQuery({ queryId: 'query-container-137', status: 'error' });
    let capturedPrompt = '';
    const runner = vi.fn(async ({ prompt }) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        text: JSON.stringify({
          ok: true,
          summary: '证据不足，无法确认根因。',
          root_cause: null,
          repairable: false,
          repair_plan: null,
          risk_level: 'unknown',
          required_user_action: '需要进一步日志',
          evidence: [{ label: 'query_id', value: 'query-container-137' }],
          groups: [
            {
              id: 'container-137',
              title: '容器 137 退出',
              log_indexes: [],
              count: 1,
              root_cause: null,
              repairable: false,
              repair_plan: null,
              risk_level: 'unknown',
              required_user_action: '需要进一步日志',
              evidence: [{ label: 'query_id', value: 'query-container-137' }],
            },
          ],
        }),
      };
    });
    initAssistantAutoFlow({ agentRunner: runner });

    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'agent-query:error:query-container-137',
      kind: 'risk',
      title: 'Agent 执行异常',
      body: 'Container exited with code 137',
      triggerRuleKey: 'agent_runs.query_failed',
      sourceType: 'agent_query',
      sourceRefId: 'query-container-137',
      extra: {
        runId: 'run-query-container-137',
        groupFolder: 'assistant_main',
      },
    });

    await runAgentInboxAction({ itemId: item.id, action: 'investigate' });

    expect(capturedPrompt).toContain('必须先用工具主动取证');
    expect(capturedPrompt).toContain('/workspace/project/logs/icarus.log');
    expect(capturedPrompt).toContain('/workspace/group/logs');
    expect(capturedPrompt).toContain('logFile');
    expect(capturedPrompt).toContain(
      '/workspace/project/src/container-runner.ts',
    );
    expect(capturedPrompt).toContain(
      '/workspace/project/container/agent-runner/src/index.ts',
    );
    expect(capturedPrompt).toContain('agent_query_events 的 event_index');
    expect(capturedPrompt).toContain('没有证据时 root_cause 必须为 null');
    expect(capturedPrompt).toContain('不要凭常见经验补根因');
  });

  it('requires a repair group id for grouped investigation repair', async () => {
    const runner = vi.fn(async ({ purpose }) => ({
      ok: true,
      text:
        purpose === 'investigation'
          ? JSON.stringify({
              ok: true,
              summary: '发现一类可修复配置问题',
              root_cause: '配置缺失',
              repairable: true,
              repair_plan: '补齐配置',
              risk_level: 'medium',
              required_user_action: null,
              evidence: [],
              groups: [
                {
                  id: 'missing-config',
                  title: '配置缺失',
                  log_indexes: [0],
                  count: 1,
                  root_cause: '配置缺失',
                  repairable: true,
                  repair_plan: '补齐配置',
                  risk_level: 'medium',
                  required_user_action: null,
                  evidence: [],
                },
              ],
            })
          : JSON.stringify({
              ok: true,
              fixed: true,
              summary: '已补齐配置',
              result: 'done',
              next_action: null,
            }),
    }));
    initAssistantAutoFlow({ agentRunner: runner });
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'online-error-logs:repairable:test',
      kind: 'risk',
      priority: 'high',
      title: '线上 error 日志：repairable',
      triggerRuleKey: 'online.error_logs',
      sourceType: 'online_error_log',
      sourceRefId: 'repairable',
      extra: {
        onlineErrorLog: {
          service: 'repairable',
          logs: [{ rawLog: 'MissingConfigException' }],
        },
      },
    });

    await runAgentInboxAction({ itemId: item.id, action: 'investigate' });

    await expect(
      runAgentInboxAction({ itemId: item.id, action: 'repair' }),
    ).rejects.toThrow('group_id required');

    const repaired = await runAgentInboxAction({
      itemId: item.id,
      action: 'repair',
      payload: { group_id: 'missing-config' },
    });

    expect(repaired.item.extra.lastRepairGroupId).toBe('missing-config');
    expect(repaired.item.extra.repair).toMatchObject({
      fixed: true,
      summary: '已补齐配置',
    });
  });

  it('auto-repairs pre-investigated coding anomaly groups without re-investigating', async () => {
    const purposes: string[] = [];
    const runner = vi.fn(async ({ purpose }) => {
      purposes.push(purpose);
      return {
        ok: true,
        text:
          purpose === 'repair'
            ? JSON.stringify({
                ok: true,
                fixed: true,
                summary: '已修复异常需求',
                result: '补齐边界判断',
                next_action: null,
              })
            : JSON.stringify({
                ok: true,
                summary: '不应触发重新排查',
                root_cause: null,
                repairable: false,
                repair_plan: null,
                risk_level: 'unknown',
                required_user_action: null,
                evidence: [],
                groups: [],
              }),
      };
    });
    initAssistantAutoFlow({ agentRunner: runner });
    const item = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan-coding-anomaly:test',
      kind: 'risk',
      priority: 'high',
      title: '服务 coding 异常：1 个需求',
      triggerRuleKey: 'today_plan.service_coding_anomaly',
      sourceType: 'today_plan_coding_anomaly',
      sourceRefId: 'test',
      extra: {
        autoFlowStatus: 'investigated',
        investigation: {
          ok: true,
          summary: '发现异常',
          root_cause: null,
          repairable: true,
          repair_plan: null,
          risk_level: 'high',
          required_user_action: null,
          evidence: [],
          groups: [
            {
              id: 'catstory-risk',
              title: 'catstory · 修复库存扣减',
              service: 'catstory',
              requirement: '修复库存扣减',
              revisions: ['abc123'],
              log_indexes: [],
              count: 1,
              root_cause: '未加锁',
              repairable: true,
              repair_plan: '补齐事务保护',
              risk_level: 'high',
              required_user_action: null,
              evidence: [],
            },
          ],
        },
      },
    });

    const result = await runAgentInboxAction({
      itemId: item.id,
      action: 'auto',
    });

    expect(purposes).toEqual(['repair']);
    expect(result.item.status).toBe('done');
    expect(result.item.extra.lastRepairGroupId).toBe('catstory-risk');
  });

  it('resolves obsolete agent query inbox items after query succeeds', async () => {
    createStoredAgentQuery({ queryId: 'query-recovered', status: 'error' });
    await runProactiveScan();
    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.dedupe_key === 'agent-query:error:query-recovered',
    );
    expect(item).toBeTruthy();

    updateAgentQuery('query-recovered', {
      status: 'success',
      error_message: null,
      failure_type: null,
      failure_retryable: null,
      updated_at: String(Date.now()),
    });
    await runProactiveScan();

    expect(getAgentInboxItem(item?.id || '')?.status).toBe('done');
  });

  it('executes assistant evolution inbox actions', async () => {
    const evolution = createEvolutionItem({
      direction: '待确认方案',
      riskLevel: 'low',
    });
    updateEvolutionItem(evolution.id, {
      status: 'waiting_user_approval',
    });
    const inbox = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.source_type === 'assistant_evolution',
    );

    expect(inbox?.action_kind).toBe(
      'assistant_evolution_approve_implementation',
    );

    const result = await runAgentInboxAction({
      itemId: inbox?.id || '',
      action: 'execute',
    });

    expect(result.result.evolution).toMatchObject({
      id: evolution.id,
      status: 'branch_preparing',
    });
  });
});
