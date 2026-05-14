import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createWorkflow,
  createWorkbenchTask,
} from '../db.js';
import {
  createOrContinueTodayPlan,
  createTodayPlanItemForPlan,
  patchTodayPlanItem,
} from '../today-plan.js';
import {
  collectTodayPlanCodingScanItems,
  scanTodayPlanCodingAnomalyRule,
} from './today-plan-coding-anomaly.js';
import type { AssistantAgentRunResult } from './assistant-auto-flow.js';
import type { AgentInboxItemView } from './types.js';
import { DEFAULT_ASSISTANT_SETTINGS } from './types.js';

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
}): { repoPath: string; commit: string } {
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
  return {
    repoPath,
    commit: git(repoPath, ['rev-parse', 'HEAD']),
  };
}

function createPlanWithService(input: {
  date: string;
  service: string;
  branch: string;
}): void {
  const plan = createOrContinueTodayPlan({ planDate: input.date });
  const item = createTodayPlanItemForPlan(plan.id);
  patchTodayPlanItem({
    itemId: item.id,
    title: '计划项',
    associations: {
      workbench_task_ids: [],
      chat_selections: [],
      services: [
        {
          service: input.service,
          branches: [input.branch],
        },
      ],
    },
  });
}

beforeEach(() => {
  _initTestDatabase();
  tempDir = mkdtempSync(path.join(tmpdir(), 'nanoclaw-coding-scan-'));
});

afterEach(() => {
  vi.useRealTimers();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('today plan coding anomaly scan', () => {
  it('collects revisions and maps nanoclaw to the main project mount', () => {
    const catstory = createRepoWithDatedCommit({
      service: 'catstory',
      branch: 'feature/cat',
      date: '2026-05-13',
    });
    createPlanWithService({
      date: '2026-05-13',
      service: 'catstory',
      branch: 'feature/cat',
    });

    const items = collectTodayPlanCodingScanItems({
      now: new Date(2026, 4, 14, 10, 0, 0),
      lookbackDays: 2,
      registry: {
        catstory: { repo_path: catstory.repoPath },
      },
    });

    expect(items).toEqual([
      {
        service: 'catstory',
        repoPath: `/workspace/repos/${catstory.repoPath}`,
        revisions: [catstory.commit],
      },
    ]);
  });

  it('tells the agent that nanoclaw is mounted at the main project path', async () => {
    const settings = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      triggerRules: {
        ...DEFAULT_ASSISTANT_SETTINGS.triggerRules,
        'today_plan.service_coding_anomaly': {
          enabled: true,
          investigationEnabled: false,
          autoEnabled: false,
          selectedServices: [],
          lookbackDays: 30,
        },
      },
    };
    const runner = vi.fn(
      async (_input: {
        prompt: string;
        purpose: 'coding_anomaly_scan';
        item: AgentInboxItemView;
      }): Promise<AssistantAgentRunResult> => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          summary: '未发现异常',
          anomalies: [],
        }),
      }),
    );
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    }).trim();
    const plan = createOrContinueTodayPlan({
      planDate: new Date().toISOString().slice(0, 10),
    });
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '主体项目',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [{ service: 'nanoclaw', branches: ['HEAD'] }],
      },
    });

    await scanTodayPlanCodingAnomalyRule({
      settings,
      now: new Date(),
      registry: { nanoclaw: { repo_path: 'ignored-for-special-case' } },
      agentRunner: runner,
    });

    const prompt = runner.mock.calls[0]?.[0].prompt || '';
    expect(prompt).toContain('/workspace/project');
    expect(prompt).toContain(currentHead);
  });

  it('uses workbench task service branches when collecting revisions', () => {
    const repo = createRepoWithDatedCommit({
      service: 'catstory',
      branch: 'feature/task',
      date: '2026-05-13',
    });
    createWorkflow({
      id: 'wf-1',
      name: 'Task 1',
      service: 'catstory',
      start_from: 'dev',
      context: { work_branch: 'feature/task' },
      status: 'dev',
      current_delegation_id: '',
      round: 0,
      source_jid: 'web:main',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '1',
      updated_at: '1',
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
      task_state: 'running',
      current_stage: 'dev',
      summary: null,
      created_at: '1',
      updated_at: '1',
      last_event_at: '1',
    });
    const plan = createOrContinueTodayPlan({ planDate: '2026-05-13' });
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '关联任务',
      associations: {
        workbench_task_ids: ['wb-wf-1'],
        chat_selections: [],
        services: [],
      },
    });

    const items = collectTodayPlanCodingScanItems({
      now: new Date(2026, 4, 14, 10, 0, 0),
      lookbackDays: 2,
      registry: { catstory: { repo_path: repo.repoPath } },
    });

    expect(items).toMatchObject([
      {
        service: 'catstory',
        revisions: [repo.commit],
      },
    ]);
  });

  it('only creates inbox candidates when the agent reports anomalies', async () => {
    const repo = createRepoWithDatedCommit({
      service: 'catstory',
      branch: 'feature/cat',
      date: '2026-05-13',
    });
    createPlanWithService({
      date: '2026-05-13',
      service: 'catstory',
      branch: 'feature/cat',
    });
    const baseSettings = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      triggerRules: {
        ...DEFAULT_ASSISTANT_SETTINGS.triggerRules,
        'today_plan.service_coding_anomaly': {
          enabled: true,
          investigationEnabled: false,
          autoEnabled: false,
          selectedServices: [],
          lookbackDays: 2,
        },
      },
    };
    const noAnomalyRunner = vi.fn(
      async (_input: {
        prompt: string;
        purpose: 'coding_anomaly_scan';
        item: AgentInboxItemView;
      }): Promise<AssistantAgentRunResult> => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          summary: '未发现异常',
          anomalies: [],
        }),
      }),
    );

    await expect(
      scanTodayPlanCodingAnomalyRule({
        settings: baseSettings,
        now: new Date(2026, 4, 14, 10, 0, 0),
        registry: { catstory: { repo_path: repo.repoPath } },
        agentRunner: noAnomalyRunner,
      }),
    ).resolves.toEqual([]);
    const scanCall = noAnomalyRunner.mock.calls[0]?.[0] as
      | {
          prompt: string;
          purpose: 'coding_anomaly_scan';
          item: AgentInboxItemView;
        }
      | undefined;
    expect(scanCall).toBeTruthy();
    expect(scanCall?.prompt).toContain(repo.commit);

    const anomalyRunner = vi.fn(
      async (_input: {
        prompt: string;
        purpose: 'coding_anomaly_scan';
        item: AgentInboxItemView;
      }): Promise<AssistantAgentRunResult> => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          summary: '发现 1 个异常需求',
          anomalies: [
            {
              service: 'catstory',
              requirement: '修复库存扣减',
              revisions: [repo.commit],
              summary: '并发扣减缺少保护',
              root_cause: '未加锁',
              repairable: true,
              repair_plan: '补充事务保护',
              risk_level: 'high',
              required_user_action: null,
              evidence: [{ label: 'commit', value: repo.commit }],
            },
          ],
        }),
      }),
    );

    const candidates = await scanTodayPlanCodingAnomalyRule({
      settings: baseSettings,
      now: new Date(2026, 4, 14, 10, 0, 0),
      registry: { catstory: { repo_path: repo.repoPath } },
      agentRunner: anomalyRunner,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceType: 'today_plan_coding_anomaly',
      triggerRuleKey: 'today_plan.service_coding_anomaly',
      title: '服务 coding 异常：1 个需求',
      extra: {
        autoFlowStatus: 'investigated',
      },
    });
    const investigation = candidates[0].extra?.investigation as {
      groups?: Array<{ service?: string; requirement?: string; revisions?: string[] }>;
    };
    expect(investigation.groups?.[0]).toMatchObject({
      service: 'catstory',
      requirement: '修复库存扣减',
      revisions: [repo.commit],
    });
  });
});
