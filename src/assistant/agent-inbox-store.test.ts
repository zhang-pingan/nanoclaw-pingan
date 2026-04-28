import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createWorkbenchTask,
  getTodayPlanByDate,
} from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import { runAgentInboxAction } from './assistant-actions.js';
import {
  createOrUpdateAgentInboxItem,
  getAgentInboxItem,
  getAssistantSettings,
  listAgentInboxItems,
  updateAssistantSettings,
} from './agent-inbox-store.js';
import { runProactiveScan } from './proactive-engine.js';

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
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

describe('agent inbox store', () => {
  it('merges assistant settings without dropping nested defaults', () => {
    const settings = updateAssistantSettings({
      enabled: false,
      dataSources: { workbench: false },
      desktopAssistant: { allowMovement: false },
    });

    expect(settings.enabled).toBe(false);
    expect(settings.dataSources.workbench).toBe(false);
    expect(settings.dataSources.todayPlan).toBe(true);
    expect(settings.desktopAssistant.allowMovement).toBe(false);
    expect(settings.desktopAssistant.alwaysOnTop).toBe(true);
    expect(getAssistantSettings().enabled).toBe(false);
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

  it('creates a today-plan inbox item and can execute it', () => {
    const now = new Date(2026, 3, 28, 9, 0, 0);
    const scan = runProactiveScan({ now });
    expect(scan.createdOrUpdated).toBeGreaterThanOrEqual(1);

    const item = listAgentInboxItems({ status: 'active' }).find(
      (entry) => entry.action_kind === 'create_today_plan',
    );
    expect(item).toBeTruthy();

    const result = runAgentInboxAction({
      itemId: item!.id,
      action: 'execute',
    });

    expect(result.item.status).toBe('done');
    expect(result.result.planDate).toBe('2026-04-28');
    expect(getTodayPlanByDate('2026-04-28')).toBeTruthy();
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
});
