import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createWorkbenchTask,
  createWorkflow,
  getTodayPlanById,
  storeChatMetadata,
} from './db.js';
import {
  buildTodayPlanCurrentProjectService,
  buildTodayPlanMailPrompt,
  completeTodayPlan,
  createOrContinueTodayPlan,
  createTodayPlanItemForPlan,
  ensureTodayPlan,
  getTodayPlanDetail,
  listTodayPlanChatMessages,
  mergeTodayPlanServiceRegistry,
  parseTodayPlanServiceBranchOptions,
  patchTodayPlanItem,
} from './today-plan.js';
import { _initTestWebDb, storeWebMessage } from './web-db.js';

describe('today-plan', () => {
  beforeEach(() => {
    _initTestDatabase();
    _initTestWebDb();
  });

  it('reuses the same today plan for the same date', () => {
    const first = ensureTodayPlan('2026-04-20');
    const second = ensureTodayPlan('2026-04-20');

    expect(first.id).toBe(second.id);
    expect(first.plan_date).toBe('2026-04-20');
    expect(first.status).toBe('active');
  });

  it('lists only the latest 200 messages from the plan date', () => {
    storeChatMetadata('web:main', String(Date.parse('2026-04-20T08:00:00.000Z')), 'Main Group', 'web', true);
    storeWebMessage({
      id: 'old-day',
      chat_jid: 'web:main',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'yesterday',
      timestamp: String(Date.parse('2026-04-19T12:00:00.000Z')),
      is_from_me: false,
    });

    const baseTimestamp = Date.parse('2026-04-20T08:00:00.000Z');
    for (let index = 0; index < 205; index += 1) {
      storeWebMessage({
        id: `msg-${index}`,
        chat_jid: 'web:main',
        sender: index % 2 === 0 ? 'alice' : 'bob',
        sender_name: index % 2 === 0 ? 'Alice' : 'Bob',
        content: `message ${index}`,
        timestamp: String(baseTimestamp + index * 60_000),
        is_from_me: false,
      });
    }

    const messages = listTodayPlanChatMessages('web:main', '2026-04-20');
    expect(messages).toHaveLength(200);
    expect(messages[0]?.id).toBe('msg-5');
    expect(messages[messages.length - 1]?.id).toBe('msg-204');
    expect(messages.some((message) => message.id === 'old-day')).toBe(false);
  });

  it('skips remote HEAD when building service branch options', () => {
    const branches = parseTodayPlanServiceBranchOptions({
      rows: [
        'refs/heads/master\tmaster\t*',
        'refs/remotes/origin/HEAD\torigin\t',
        'refs/remotes/origin/master\torigin/master\t',
        'refs/remotes/origin/erp\torigin/erp\t',
      ],
      config: {
        default_branch: 'master',
        staging: {
          branch: 'erp',
        },
      },
    });

    expect(branches).toHaveLength(2);
    expect(branches.map((branch) => branch.name)).toEqual(['master', 'erp']);
    expect(branches.find((branch) => branch.name === 'origin')).toBeUndefined();
    expect(branches[0]).toMatchObject({
      name: 'master',
      source: 'local',
      current: true,
      default_branch: true,
    });
    expect(branches[1]).toMatchObject({
      name: 'erp',
      source: 'remote',
      staging_branch: true,
    });
  });

  it('adds the current project as an implicit today plan service', () => {
    const currentProject = buildTodayPlanCurrentProjectService({
      projectRoot: '/Users/chelaile/IdeaProjects/nanoclaw',
      reposDir: '/Users/chelaile/IdeaProjects',
    });

    expect(currentProject).toEqual({
      service: 'nanoclaw',
      config: {
        repo_path: 'nanoclaw',
        default_branch: '',
      },
    });
  });

  it('does not override explicit service config when merging today plan services', () => {
    const registry = mergeTodayPlanServiceRegistry({
      registry: {
        nanoclaw: {
          repo_path: 'custom/nanoclaw',
          default_branch: 'release',
        },
      },
      projectRoot: '/Users/chelaile/IdeaProjects/nanoclaw',
      reposDir: '/Users/chelaile/IdeaProjects',
    });

    expect(registry).toEqual({
      nanoclaw: {
        repo_path: 'custom/nanoclaw',
        default_branch: 'release',
      },
    });
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

  it('keeps manually selected services even before a branch is chosen', () => {
    const plan = ensureTodayPlan('2026-04-20');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '先占位服务',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [
          {
            service: 'catstory',
            branches: [],
          },
        ],
      },
    });

    const detail = getTodayPlanDetail({
      planId: plan.id,
      groups: {},
    });

    expect(detail).toBeTruthy();
    if (!detail) {
      throw new Error('expected today plan detail to exist');
    }
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].associations.services).toEqual([
      {
        service: 'catstory',
        branches: [],
      },
    ]);
    expect(detail.items[0].related_services).toHaveLength(1);
    expect(detail.items[0].related_services[0].service).toBe('catstory');
    expect(detail.items[0].related_services[0].branches).toEqual([]);
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

  it('builds today plan mail prompt with a fixed content template', () => {
    const plan = ensureTodayPlan('2026-04-20');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      detail: '完成聚合页与发送链路梳理',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const payload = buildTodayPlanMailPrompt({
      planId: plan.id,
      groups: {},
      name: '张頔',
    });

    expect(payload).toBeTruthy();
    expect(payload?.subject).toBe('日报-张頔-2026-04-20');
    expect(payload?.prompt).toContain('# 邮件正文模板');
    expect(payload?.prompt).toContain('只输出邮件正文');
    expect(payload?.prompt).toContain('1. <计划标题 1>');
    expect(payload?.prompt).toContain('- 根据`关联任务`、`关联群聊`、`关联服务分支` 信息汇总实际执行项列表');
    expect(payload?.prompt).toContain('2. <计划标题 2>');
    expect(payload?.prompt).toContain('不要保留尖括号占位符');
    expect(payload?.prompt).not.toContain('wecom-mail');
    expect(payload?.prompt).toContain('## 计划 1: 推进今日开发');
    expect(payload?.prompt).toContain('计划内容：完成聚合页与发送链路梳理');
  });
});
