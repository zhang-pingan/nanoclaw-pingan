import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createWorkbenchTask,
  createWorkflow,
  getTodayPlanById,
} from './db.js';
import {
  completeTodayPlan,
  createOrContinueTodayPlan,
  createTodayPlanItemForPlan,
  ensureTodayPlan,
  getTodayPlanDetail,
  patchTodayPlanItem,
  summarizeTodayPlanConversations,
} from './today-plan.js';

describe('today-plan', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('reuses the same today plan for the same date', () => {
    const first = ensureTodayPlan('2026-04-20');
    const second = ensureTodayPlan('2026-04-20');

    expect(first.id).toBe(second.id);
    expect(first.plan_date).toBe('2026-04-20');
    expect(first.status).toBe('active');
  });

  it('groups workflow messages and idle windows into conversations', () => {
    const summaries = summarizeTodayPlanConversations([
      {
        id: 'm1',
        chat_jid: 'web:main',
        sender: 'system',
        sender_name: 'System',
        content: 'workflow start',
        timestamp: '1713571200000',
        is_from_me: 1,
        is_bot_message: 0,
        workflow_id: 'wf-1',
      },
      {
        id: 'm2',
        chat_jid: 'web:main',
        sender: 'system',
        sender_name: 'System',
        content: 'workflow end',
        timestamp: '1713571500000',
        is_from_me: 1,
        is_bot_message: 0,
        workflow_id: 'wf-1',
      },
      {
        id: 'm3',
        chat_jid: 'web:main',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'sync later',
        timestamp: '1713571800000',
        is_from_me: 0,
        is_bot_message: 0,
        workflow_id: null,
      },
      {
        id: 'm4',
        chat_jid: 'web:main',
        sender: 'bob',
        sender_name: 'Bob',
        content: 'ok',
        timestamp: '1713572100000',
        is_from_me: 0,
        is_bot_message: 0,
        workflow_id: null,
      },
      {
        id: 'm5',
        chat_jid: 'web:main',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'new topic',
        timestamp: '1713576000000',
        is_from_me: 0,
        is_bot_message: 0,
        workflow_id: null,
      },
    ]);

    expect(summaries).toHaveLength(3);
    expect(summaries.find((item) => item.workflow_id === 'wf-1')).toBeTruthy();
    expect(
      summaries.filter((item) => item.workflow_id === null).map((item) => item.message_count),
    ).toEqual([1, 2]);
  });

  it('auto-associates workbench task service and work branch into today plan detail', () => {
    createWorkflow({
      id: 'wf-1',
      name: 'Task 1',
      service: 'catstory',
      start_from: 'dev',
      context: {
        work_branch: 'feature/today-plan',
        requirement_description: '补充今日计划聚合页',
      },
      status: 'dev',
      current_delegation_id: '',
      round: 0,
      source_jid: 'web:main',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-20T00:00:00.000Z',
      updated_at: '2026-04-20T00:00:00.000Z',
    });
    createWorkbenchTask({
      id: 'wb-wf-1',
      workflow_id: 'wf-1',
      source_jid: 'web:main',
      title: 'Task 1',
      service: 'catstory',
      start_from: 'dev',
      workflow_type: 'dev_test',
      status: 'dev',
      current_stage: 'dev',
      summary: 'summary',
      created_at: '2026-04-20T00:00:00.000Z',
      updated_at: '2026-04-20T00:00:00.000Z',
      last_event_at: '2026-04-20T00:00:00.000Z',
    });

    const plan = ensureTodayPlan('2026-04-20');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      associations: {
        workbench_task_ids: ['wb-wf-1'],
        chat_selections: [],
        services: [],
      },
    });

    const detail = getTodayPlanDetail({
      planId: plan.id,
      groups: {
        'web:main': {
          name: 'Main Group',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2026-04-20T00:00:00.000Z',
          isMain: true,
        },
      },
    });

    expect(detail).toBeTruthy();
    if (!detail) {
      throw new Error('expected today plan detail to exist');
    }
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].related_tasks).toHaveLength(1);
    expect(detail.items[0].related_tasks[0].description).toContain('今日计划');
    expect(detail.items[0].related_services).toHaveLength(1);
    expect(detail.items[0].related_services[0].service).toBe('catstory');
    expect(detail.items[0].related_services[0].branches[0].name).toBe(
      'feature/today-plan',
    );
    expect(detail.items[0].related_services[0].branches[0].source).toBe(
      'workbench',
    );
  });

  it('continues unfinished past plan into today plan detail', () => {
    const oldPlan = ensureTodayPlan('2026-04-19');
    const oldItem = createTodayPlanItemForPlan(oldPlan.id);
    patchTodayPlanItem({
      itemId: oldItem.id,
      title: '昨天未完成的计划',
      detail: '继续推进剩余部分',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const todayPlan = createOrContinueTodayPlan({
      planDate: '2026-04-20',
      continueFromPlanId: oldPlan.id,
    });
    const detail = getTodayPlanDetail({
      planId: todayPlan.id,
      groups: {},
    });

    expect(detail).toBeTruthy();
    if (!detail) {
      throw new Error('expected continued today plan detail to exist');
    }
    expect(detail.plan.continued_from_plan_id).toBe(oldPlan.id);
    expect(detail.continued_from).toBeTruthy();
    expect(detail.continued_from?.plan.id).toBe(oldPlan.id);
    expect(detail.continued_from?.items).toHaveLength(1);
    expect(detail.continued_from?.items[0].title).toBe('昨天未完成的计划');
    expect(detail.items).toHaveLength(0);
    expect(getTodayPlanById(oldPlan.id)?.status).toBe('continued');
  });

  it('marks today plan completed', () => {
    const plan = ensureTodayPlan('2026-04-20');
    const completed = completeTodayPlan(plan.id);

    expect(completed).toBeTruthy();
    expect(completed?.status).toBe('completed');
    expect(completed?.completed_at).toBeTruthy();
  });
});
