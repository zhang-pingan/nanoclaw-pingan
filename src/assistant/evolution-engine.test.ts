import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import {
  _resetEvolutionEngineForTests,
  adoptEvolutionItem,
  approveEvolutionImplementation,
  configureEvolutionEngine,
  pauseEvolutionItem,
  resumeEvolutionItem,
  runEvolutionTick,
} from './evolution-engine.js';
import type { EvolutionGitAdapter } from './evolution-git.js';
import type { AssistantSettings } from './types.js';
import {
  getActiveEvolutionItem,
  getEvolutionItem,
  updateEvolutionItem,
} from './evolution-store.js';

function settings(
  evolution: Partial<AssistantSettings['evolution']> = {},
): AssistantSettings {
  return {
    enabled: true,
    proactiveLevel: 'balanced',
    scanIntervalMinutes: 10,
    quietHours: { enabled: false, start: '22:30', end: '08:30' },
    triggerRules: {} as AssistantSettings['triggerRules'],
    desktopAssistant: {
      autostart: false,
      alwaysOnTop: true,
      allowMovement: true,
    },
    maxInboxItems: 200,
    evolution: {
      enabled: true,
      autoImplementEnabled: false,
      autoAdoptEnabled: false,
      scanIntervalMinutes: 60,
      maxConcurrentItems: 1,
      maxReviewRounds: 2,
      allowedRiskLevel: 'medium',
      ...evolution,
    },
  };
}

function gitAdapter(): EvolutionGitAdapter {
  let branch = 'main';
  let commit = 'commit-main';
  let dirty = false;
  return {
    currentBranch: async () => branch,
    currentCommit: async () => commit,
    hasDirtyWorktree: async () => dirty,
    worktreeChangedFiles: async () =>
      dirty ? ['src/assistant/example.ts'] : [],
    branchExists: async () => false,
    checkout: async (next) => {
      branch = next;
      return {
        ok: true,
        stdout: '',
        stderr: '',
        command: `git checkout ${next}`,
      };
    },
    createBranch: async (next) => {
      branch = next;
      commit = 'commit-work';
      return {
        ok: true,
        stdout: '',
        stderr: '',
        command: `git checkout -b ${next}`,
      };
    },
    addAll: async () => ({
      ok: true,
      stdout: '',
      stderr: '',
      command: 'git add -A',
    }),
    commit: async (message) => {
      dirty = false;
      commit = `commit-${message}`;
      return {
        ok: true,
        stdout: '',
        stderr: '',
        command: `git commit -m ${message}`,
      };
    },
    mergeNoFfNoCommit: async (next) => {
      dirty = true;
      return {
        ok: true,
        stdout: '',
        stderr: '',
        command: `git merge --no-ff --no-commit ${next}`,
      };
    },
    mergeAbort: async () => {
      dirty = false;
      return { ok: true, stdout: '', stderr: '', command: 'git merge --abort' };
    },
    changedFiles: async () => ['local/docs/example.md'],
  };
}

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
  _resetEvolutionEngineForTests();
});

describe('evolution engine', () => {
  it('does nothing when disabled', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings({ enabled: false }),
    });

    const result = await runEvolutionTick();

    expect(result.action).toBe('disabled');
    expect(getActiveEvolutionItem()).toBeNull();
  });

  it('creates an item on first enabled tick', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
    });

    const result = await runEvolutionTick();

    expect(result.action).toBe('item_created');
    expect(getActiveEvolutionItem()?.status).toBe('discovering');
  });

  it('advances proposal and waits for user approval when auto implement is off', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: gitAdapter(),
      agentRunner: async ({ phase }) => {
        if (phase === 'proposal') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              module_scope: 'assistant',
              direction: '补充测试',
              risk_level: 'low',
              proposal: '# Plan',
              requires_user_approval: false,
              blocked_by_policy: false,
              blocked_reason: null,
            }),
          };
        }
        return {
          ok: true,
          text: JSON.stringify({
            ok: true,
            approved_for_implementation: true,
            risk_level: 'low',
            evaluation: 'ok',
            required_changes: [],
            blocked_by_policy: false,
            blocked_reason: null,
          }),
        };
      },
    });

    await runEvolutionTick();
    await runEvolutionTick();
    const result = await runEvolutionTick();

    expect(result.status).toBe('waiting_user_approval');
    expect(getActiveEvolutionItem()?.proposal).toBe('# Plan');
  });

  it('approval moves waiting item to branch preparation', () => {
    configureEvolutionEngine({ settingsProvider: () => settings() });
    void runEvolutionTick();
    const item = getActiveEvolutionItem();
    if (!item) throw new Error('missing item');
    updateEvolutionItem(item.id, { status: 'waiting_user_approval' });

    const approved = approveEvolutionImplementation(item.id);

    expect(approved.item.status).toBe('branch_preparing');
  });

  it('blocks dirty worktree during branch preparation', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        hasDirtyWorktree: async () => true,
      },
    });
    await runEvolutionTick();
    const item = getActiveEvolutionItem();
    if (!item) throw new Error('missing item');
    updateEvolutionItem(item.id, { status: 'branch_preparing' });

    const result = await runEvolutionTick();

    expect(result.status).toBe('blocked_by_policy');
    expect(getEvolutionItem(item.id)?.blocked_reason).toContain('未提交改动');
  });

  it('commits dirty implementation output before checking', async () => {
    let dirty = false;
    let committed = false;
    let branch = 'evolution/test';
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        currentBranch: async () => branch,
        currentCommit: async () => (committed ? 'committed-work' : 'base-work'),
        hasDirtyWorktree: async () => dirty,
        worktreeChangedFiles: async () =>
          dirty ? ['src/assistant/example.ts'] : [],
        addAll: async () => ({
          ok: true,
          stdout: '',
          stderr: '',
          command: 'git add -A',
        }),
        commit: async () => {
          dirty = false;
          committed = true;
          return {
            ok: true,
            stdout: '',
            stderr: '',
            command: 'git commit -m test',
          };
        },
        changedFiles: async () => ['src/assistant/example.ts'],
      },
      agentRunner: async () => {
        dirty = true;
        return {
          ok: true,
          text: JSON.stringify({
            ok: true,
            implementation_summary: 'done',
            changed_files: ['src/assistant/example.ts'],
            requires_followup: false,
          }),
        };
      },
    });
    await runEvolutionTick();
    const item = getActiveEvolutionItem();
    if (!item) throw new Error('missing item');
    updateEvolutionItem(item.id, {
      status: 'implementing',
      work_branch: branch,
      base_commit: 'base-work',
    });

    const result = await runEvolutionTick();

    expect(result.status).toBe('checking');
    expect(committed).toBe(true);
    expect(getEvolutionItem(item.id)?.head_commit).toBe('committed-work');
  });

  it('aborts prepared adoption merge when checks fail', async () => {
    let mergeAborted = false;
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        mergeAbort: async () => {
          mergeAborted = true;
          return {
            ok: true,
            stdout: '',
            stderr: '',
            command: 'git merge --abort',
          };
        },
      },
      checkRunner: async () => ({
        ok: false,
        stdout: '',
        stderr: 'failed checks',
        command: 'npm test',
      }),
    });
    await runEvolutionTick();
    const item = getActiveEvolutionItem();
    if (!item) throw new Error('missing item');
    updateEvolutionItem(item.id, {
      status: 'ready_for_adoption',
      work_branch: 'evolution/test',
      base_branch: 'main',
    });

    const result = await adoptEvolutionItem(item.id);

    expect(result.ok).toBe(false);
    expect(result.item.status).toBe('adoption_failed');
    expect(mergeAborted).toBe(true);
  });

  it('resumes paused items to their original status', async () => {
    configureEvolutionEngine({ settingsProvider: () => settings() });
    await runEvolutionTick();
    const item = getActiveEvolutionItem();
    if (!item) throw new Error('missing item');
    updateEvolutionItem(item.id, { status: 'checking' });

    const paused = pauseEvolutionItem(item.id);
    const resumed = resumeEvolutionItem(item.id);

    expect(paused.item.status).toBe('paused');
    expect(resumed.item.status).toBe('checking');
  });
});
