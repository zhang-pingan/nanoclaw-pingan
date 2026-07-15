import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
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
  tempDir = mkdtempSync(path.join(tmpdir(), 'icarus-coding-scan-'));
});

afterEach(() => {
  vi.useRealTimers();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('today plan coding anomaly scan', () => {
  it('collects revisions and maps icarus to the main project mount', () => {
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

  it('tells the agent that icarus is mounted at the main project path', async () => {
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
    const currentHeadDate = execFileSync(
      'git',
      ['show', '-s', '--format=%cs', 'HEAD'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    ).trim();
    const plan = createOrContinueTodayPlan({
      planDate: currentHeadDate,
    });
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '主体项目',
      associations: {
        chat_selections: [],
        services: [{ service: 'icarus', branches: ['HEAD'] }],
      },
    });

    await scanTodayPlanCodingAnomalyRule({
      settings,
      now: new Date(`${currentHeadDate}T12:00:00`),
      registry: { icarus: { repo_path: 'ignored-for-special-case' } },
      agentRunner: runner,
    });

    const prompt = runner.mock.calls[0]?.[0].prompt || '';
    expect(prompt).toContain('/workspace/project');
    expect(prompt).toContain(currentHead);
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
      groups?: Array<{
        service?: string;
        requirement?: string;
        revisions?: string[];
      }>;
    };
    expect(investigation.groups?.[0]).toMatchObject({
      service: 'catstory',
      requirement: '修复库存扣减',
      revisions: [repo.commit],
    });
  });
});
