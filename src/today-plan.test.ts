import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  _initTestDatabase,
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
  getRecentTodayPlanDetails,
  getTodayPlanDetail,
  listTodayPlanChatMessages,
  mergeTodayPlanServiceRegistry,
  parseTodayPlanServiceBranchOptions,
  patchTodayPlanItem,
} from './today-plan.js';
import { _initTestWebDb, storeWebMessage } from './web-db.js';

describe('today-plan', () => {
  let tempDir = '';

  function git(repoPath: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test User',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test User',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim();
  }

  function createRepoWithDatedCommit(input: {
    service: string;
    branch: string;
    date: string;
  }): { repoPath: string; commit: string; shortCommit: string } {
    const repoPath = path.join(tempDir, input.service);
    execFileSync('git', ['init', repoPath], { encoding: 'utf-8' });
    git(repoPath, ['checkout', '-b', input.branch]);
    writeFileSync(path.join(repoPath, 'file.txt'), `${input.service}\n`);
    execFileSync('git', ['add', 'file.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', `${input.service} change`], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test User',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test User',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_AUTHOR_DATE: `${input.date}T10:00:00+08:00`,
        GIT_COMMITTER_DATE: `${input.date}T10:00:00+08:00`,
      },
    });
    const commit = git(repoPath, ['rev-parse', 'HEAD']);
    return {
      repoPath,
      commit,
      shortCommit: commit.slice(0, 7),
    };
  }

  beforeEach(() => {
    _initTestDatabase();
    _initTestWebDb();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(path.join(tmpdir(), 'icarus-today-plan-'));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('reuses the same today plan for the same date', () => {
    const first = ensureTodayPlan('2026-04-20');
    const second = ensureTodayPlan('2026-04-20');

    expect(first.id).toBe(second.id);
    expect(first.plan_date).toBe('2026-04-20');
    expect(first.status).toBe('active');
  });

  it('lists only the latest 200 messages from the plan date', () => {
    storeChatMetadata(
      'web:main',
      String(Date.parse('2026-04-20T08:00:00.000Z')),
      'Main Group',
      'web',
      true,
    );
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
      projectRoot: '/Users/chelaile/IdeaProjects/icarus',
      reposDir: '/Users/chelaile/IdeaProjects',
    });

    expect(currentProject).toEqual({
      service: 'icarus',
      config: {
        repo_path: 'icarus',
        default_branch: '',
      },
    });
  });

  it('does not override explicit service config when merging today plan services', () => {
    const registry = mergeTodayPlanServiceRegistry({
      registry: {
        icarus: {
          repo_path: 'custom/icarus',
          default_branch: 'release',
        },
      },
      projectRoot: '/Users/chelaile/IdeaProjects/icarus',
      reposDir: '/Users/chelaile/IdeaProjects',
    });

    expect(registry).toEqual({
      icarus: {
        repo_path: 'custom/icarus',
        default_branch: 'release',
      },
    });
  });

  it('summarizes recent today plans by deduped manually selected service branches', () => {
    const repo = createRepoWithDatedCommit({
      service: 'catstory',
      branch: 'feature/recent',
      date: '2026-05-13',
    });
    const firstPlan = ensureTodayPlan('2026-05-13');
    const firstItem = createTodayPlanItemForPlan(firstPlan.id);
    patchTodayPlanItem({
      itemId: firstItem.id,
      title: '实现查询工具',
      detail: '给 agent 补充最近上下文',
      associations: {
        chat_selections: [],
        services: [
          {
            service: 'catstory',
            branches: ['feature/recent'],
          },
        ],
      },
    });
    const secondItem = createTodayPlanItemForPlan(firstPlan.id);
    patchTodayPlanItem({
      itemId: secondItem.id,
      title: '重复关联服务',
      associations: {
        chat_selections: [],
        services: [
          {
            service: 'catstory',
            branches: ['feature/recent'],
          },
        ],
      },
    });
    const secondPlan = ensureTodayPlan('2026-05-12');
    const oldItem = createTodayPlanItemForPlan(secondPlan.id);
    patchTodayPlanItem({
      itemId: oldItem.id,
      title: '另一个服务',
      associations: {
        chat_selections: [],
        services: [
          {
            service: 'dogstory',
            branches: [],
          },
        ],
      },
    });

    const summary = getRecentTodayPlanDetails({
      now: new Date(2026, 4, 14, 10, 0, 0),
      days: 3,
      registry: {
        catstory: {
          repo_path: repo.repoPath,
        },
      },
    });

    expect(summary.query.dates).toEqual([
      '2026-05-14',
      '2026-05-13',
      '2026-05-12',
    ]);
    expect(summary.query.mode).toBe('recent');
    expect(summary.plans.map((plan) => plan.plan_date)).toEqual([
      '2026-05-13',
      '2026-05-12',
    ]);
    const catstory = summary.services.find(
      (service) => service.service === 'catstory',
    );
    expect(catstory).toBeTruthy();
    expect(catstory?.repo_path).toBe(repo.repoPath);
    expect(catstory?.plan_items.map((item) => item.title)).toEqual([
      '实现查询工具',
      '重复关联服务',
    ]);
    expect(catstory?.branches).toHaveLength(1);
    expect(catstory?.branches[0]).toMatchObject({
      name: 'feature/recent',
      sources: ['manual'],
    });
    expect(catstory?.branches[0].commits[0]).toMatchObject({
      hash: repo.commit,
      short_hash: repo.shortCommit,
      subject: 'catstory change',
    });
  });

  it('supports querying today plan details by exact date and date range', () => {
    for (const date of ['2026-05-10', '2026-05-11', '2026-05-12']) {
      const plan = ensureTodayPlan(date);
      const item = createTodayPlanItemForPlan(plan.id);
      patchTodayPlanItem({
        itemId: item.id,
        title: `${date} 计划`,
        associations: {
          chat_selections: [],
          services: [],
        },
      });
    }

    const exact = getRecentTodayPlanDetails({
      now: new Date(2026, 4, 14, 10, 0, 0),
      date: '2026-05-11',
      days: 3,
    });
    expect(exact.query).toMatchObject({
      mode: 'date',
      days: 1,
      dates: ['2026-05-11'],
      from_date: '2026-05-11',
      to_date: '2026-05-11',
      date: '2026-05-11',
    });
    expect(exact.plans.map((plan) => plan.plan_date)).toEqual(['2026-05-11']);

    const range = getRecentTodayPlanDetails({
      startDate: '2026-05-10',
      endDate: '2026-05-12',
    });
    expect(range.query).toMatchObject({
      mode: 'range',
      days: 3,
      dates: ['2026-05-12', '2026-05-11', '2026-05-10'],
      from_date: '2026-05-10',
      to_date: '2026-05-12',
      start_date: '2026-05-10',
      end_date: '2026-05-12',
    });
    expect(range.plans.map((plan) => plan.plan_date)).toEqual([
      '2026-05-12',
      '2026-05-11',
      '2026-05-10',
    ]);
  });

  it('keeps manually selected services even before a branch is chosen', () => {
    const plan = ensureTodayPlan('2026-04-20');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '先占位服务',
      associations: {
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
    expect(payload?.prompt).toContain(
      '- 根据`关联群聊`、`关联服务分支` 信息汇总实际执行项列表',
    );
    expect(payload?.prompt).toContain('2. <计划标题 2>');
    expect(payload?.prompt).toContain('不要保留尖括号占位符');
    expect(payload?.prompt).not.toContain('wecom-mail');
    expect(payload?.prompt).toContain('## 计划 1: 推进今日开发');
    expect(payload?.prompt).toContain('计划内容：完成聚合页与发送链路梳理');
  });
});
