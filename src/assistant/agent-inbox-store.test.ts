import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createAgentQuery,
  createWorkbenchTask,
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
        },
      },
      desktopAssistant: { allowMovement: false },
    });

    expect(settings.enabled).toBe(false);
    expect(settings.triggerRules['workbench.task_stale'].enabled).toBe(false);
    expect(
      settings.triggerRules['workbench.task_stale'].investigationEnabled,
    ).toBe(false);
    expect(settings.triggerRules['today_plan.missing_today_plan'].enabled).toBe(
      true,
    );
    expect(settings.desktopAssistant.allowMovement).toBe(false);
    expect(settings.desktopAssistant.alwaysOnTop).toBe(true);
    expect(getAssistantSettings().enabled).toBe(false);
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

  it('creates a today-plan inbox item without direct create action', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const scan = runProactiveScan({ now });
    expect(scan.createdOrUpdated).toBeGreaterThanOrEqual(1);

    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.dedupe_key === 'today-plan:missing:2026-04-28',
    );
    expect(item).toBeTruthy();
    expect(item?.action_kind).toBeNull();
    expect(item?.action_label).toBeNull();
    expect(item?.action_payload).toEqual({});
  });

  it('deletes legacy active inbox items before creating rule-keyed replacements', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const legacy = createOrUpdateAgentInboxItem({
      dedupeKey: 'today-plan:missing:2026-04-28',
      kind: 'suggestion',
      priority: 'high',
      title: '旧提醒',
      sourceType: 'today_plan',
      sourceRefId: '2026-04-28',
    });

    runProactiveScan({ now });

    expect(getAgentInboxItem(legacy.id)).toBeNull();
    const replacement = listAgentInboxItems({ status: 'active' }).find(
      (item) => item.dedupe_key === 'today-plan:missing:2026-04-28',
    );
    expect(replacement).toBeTruthy();
    expect(replacement?.id).not.toBe(legacy.id);
    expect(replacement?.extra.ruleKey).toBe('today_plan.missing_today_plan');
  });

  it('does not create inbox items for disabled fine-grained trigger rules', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    updateAssistantSettings({
      triggerRules: {
        'today_plan.missing_today_plan': {
          enabled: false,
          investigationEnabled: false,
          autoEnabled: false,
        },
      },
    });

    runProactiveScan({ now });

    expect(
      listAgentInboxItems({ status: 'active' }).some(
        (item) => item.dedupe_key === 'today-plan:missing:2026-04-28',
      ),
    ).toBe(false);
  });

  it('resolves obsolete today-plan inbox items after today plan exists', () => {
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
    runProactiveScan({ now });

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

  it('does not stale-alert successful workbench tasks', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const updatedAt = String(now.getTime() - 6 * 60 * 60 * 1000);
    createStoredWorkbenchTask({
      id: 'wb-success-task',
      status: 'passed',
      taskState: 'success',
      updatedAt,
    });

    runProactiveScan({ now });

    expect(
      listAgentInboxItems({ status: 'active' }).some(
        (item) => item.dedupe_key === 'workbench:task-stale:wb-success-task',
      ),
    ).toBe(false);
  });

  it('resolves obsolete workbench stale inbox items after task success', () => {
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

    runProactiveScan({ now });

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
      }),
    }));
    initAssistantAutoFlow({ agentRunner: runner });
    updateAssistantSettings({
      triggerRules: {
        'workbench.task_stale': {
          enabled: true,
          investigationEnabled: true,
          autoEnabled: true,
        },
      },
    });
    createStoredWorkbenchTask({
      id: 'wb-auto-stale-task',
      status: 'running',
      taskState: 'running',
      updatedAt,
    });

    runProactiveScan({ now });
    await flushAsyncWork();

    expect(runner).toHaveBeenCalledTimes(1);
    runner.mockClear();

    runProactiveScan({ now });
    await flushAsyncWork();

    expect(runner).not.toHaveBeenCalled();
    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.dedupe_key === 'workbench:task-stale:wb-auto-stale-task',
    );
    expect(item?.extra.autoFlowStatus).toBe('investigated');
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
    });
  });

  it('resolves obsolete agent query inbox items after query succeeds', () => {
    createStoredAgentQuery({ queryId: 'query-recovered', status: 'error' });
    runProactiveScan();
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
    runProactiveScan();

    expect(getAgentInboxItem(item?.id || '')?.status).toBe('done');
  });
});
