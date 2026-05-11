import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { initAssistantEvents } from './assistant-events.js';
import {
  _resetEvolutionEngineForTests,
  adoptEvolutionItem,
  approveEvolutionImplementation,
  cancelEvolutionItem,
  configureEvolutionEngine,
  getEvolutionScheduleState,
  getEvolutionStateForApi,
  pauseEvolutionItem,
  resumeEvolutionItem,
  runEvolutionTick,
  startEvolutionEngine,
} from './evolution-engine.js';
import type { EvolutionGitAdapter } from './evolution-git.js';
import type { AssistantSettings } from './types.js';
import {
  createEvolutionItem,
  getActiveEvolutionItem,
  getEvolutionItem,
  listEvolutionItems,
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
    stashPush: async (message) => {
      dirty = false;
      return {
        ok: true,
        stdout: '',
        stderr: '',
        command: `git stash push -u -m ${message}`,
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
    diff: async () => 'diff --git a/local/docs/example.md b/local/docs/example.md',
  };
}

function proposalRunner(direction: string = '补充测试') {
  return async ({ phase }: { phase: string }) => {
    if (phase === 'proposal' || phase === 'proposal_refinement') {
      return {
        ok: true,
        text: JSON.stringify({
          ok: true,
          module_scope: 'assistant',
          direction,
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
  };
}

beforeEach(() => {
  _initTestDatabase();
  initAssistantEvents(() => {});
  _resetEvolutionEngineForTests();
});

afterEach(() => {
  _resetEvolutionEngineForTests();
  vi.useRealTimers();
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

  it('creates and advances an item to the configured decision point', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: gitAdapter(),
      agentRunner: proposalRunner(),
    });

    const result = await runEvolutionTick();

    expect(result.action).toBe('item_created_proposal_evaluation');
    expect(result.status).toBe('waiting_user_approval');
    expect(getActiveEvolutionItem()?.status).toBe('waiting_user_approval');
  });

  it('exposes last and next evolution trigger times', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T09:00:00.000Z'));
    configureEvolutionEngine({
      settingsProvider: () => settings({ scanIntervalMinutes: 30 }),
      git: gitAdapter(),
      agentRunner: proposalRunner(),
    });

    startEvolutionEngine();
    expect(getEvolutionScheduleState()).toMatchObject({
      loopStarted: true,
      nextTickAt: String(Date.parse('2026-05-11T09:00:10.000Z')),
      lastTickStartedAt: null,
    });

    await runEvolutionTick();

    const state = getEvolutionStateForApi();
    expect(state.schedule).toMatchObject({
      loopStarted: true,
      intervalMinutes: 30,
      lastTickStartedAt: String(Date.parse('2026-05-11T09:00:00.000Z')),
      lastTickFinishedAt: String(Date.parse('2026-05-11T09:00:00.000Z')),
      lastTickAction: 'item_created_proposal_evaluation',
      lastTickStatus: 'waiting_user_approval',
      lastTickOk: true,
      lastTickError: null,
      nextTickAt: String(Date.parse('2026-05-11T09:00:10.000Z')),
    });
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

    const result = await runEvolutionTick();

    expect(result.status).toBe('waiting_user_approval');
    expect(getActiveEvolutionItem()?.proposal).toBe('# Plan');
  });

  it('creates a new item when existing items are only waiting for manual adoption', async () => {
    let proposalIndex = 0;
    configureEvolutionEngine({
      settingsProvider: () => settings({ autoImplementEnabled: true }),
      git: gitAdapter(),
      agentRunner: async ({ phase }) => {
        if (phase === 'proposal') {
          proposalIndex += 1;
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              module_scope: 'docs',
              direction: `docs plan ${proposalIndex}`,
              risk_level: 'low',
              proposal: '# Plan',
              requires_user_approval: false,
              blocked_by_policy: false,
              blocked_reason: null,
            }),
          };
        }
        if (phase === 'proposal_evaluation') {
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
        }
        if (phase === 'implementation') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              implementation_summary: 'docs updated',
              changed_files: ['local/docs/example.md'],
              requires_followup: false,
              blocked_by_policy: false,
              blocked_reason: null,
            }),
          };
        }
        return {
          ok: true,
          text: JSON.stringify({
            ok: true,
            review_complete: true,
            implementation_coverage: 'covered',
            bug_report: null,
            required_fixes: [],
            risk_level: 'low',
          }),
        };
      },
    });

    const first = await runEvolutionTick();
    const second = await runEvolutionTick();
    const items = listEvolutionItems({ limit: 10 });

    expect(first.status).toBe('ready_for_adoption');
    expect(second.status).toBe('ready_for_adoption');
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === 'ready_for_adoption')).toBe(
      true,
    );
  });

  it('does not create a new item while low-risk adoption is auto-enabled', async () => {
    let adoptCount = 0;
    configureEvolutionEngine({
      settingsProvider: () =>
        settings({ autoImplementEnabled: true, autoAdoptEnabled: true }),
      git: gitAdapter(),
      checkRunner: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        command: 'check',
      }),
      agentRunner: async ({ phase }) => {
        if (phase === 'proposal') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              module_scope: 'docs',
              direction: 'auto adopt docs',
              risk_level: 'low',
              proposal: '# Plan',
              requires_user_approval: false,
              blocked_by_policy: false,
              blocked_reason: null,
            }),
          };
        }
        if (phase === 'proposal_evaluation') {
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
        }
        if (phase === 'implementation') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              implementation_summary: 'docs updated',
              changed_files: ['local/docs/example.md'],
              requires_followup: false,
              blocked_by_policy: false,
              blocked_reason: null,
            }),
          };
        }
        adoptCount += 1;
        return {
          ok: true,
          text: JSON.stringify({
            ok: true,
            review_complete: true,
            implementation_coverage: 'covered',
            bug_report: null,
            required_fixes: [],
            risk_level: 'low',
          }),
        };
      },
    });

    const result = await runEvolutionTick();
    const items = listEvolutionItems({ limit: 10 });

    expect(result.action).toBe('item_created_auto_adopted');
    expect(result.status).toBe('completed');
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(adoptCount).toBe(1);
  });

  it('approval moves waiting item to branch preparation', () => {
    configureEvolutionEngine({ settingsProvider: () => settings() });
    const item = createEvolutionItem({ status: 'waiting_user_approval' });

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
    const item = createEvolutionItem({ status: 'branch_preparing' });

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
        diff: async () =>
          'diff --git a/src/assistant/example.ts b/src/assistant/example.ts',
      },
      checkRunner: async () => ({
        ok: true,
        stdout: '',
        stderr: '',
        command: 'check',
      }),
      agentRunner: async () => {
        if (!dirty && committed) {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              review_complete: true,
              implementation_coverage: 'covered',
              bug_report: null,
              required_fixes: [],
              risk_level: 'low',
            }),
          };
        }
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
    const item = createEvolutionItem({
      status: 'implementing',
    });
    updateEvolutionItem(item.id, { work_branch: branch, base_commit: 'base-work' });

    const result = await runEvolutionTick();

    expect(result.status).toBe('ready_for_adoption');
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
    const item = createEvolutionItem({
      status: 'ready_for_adoption',
    });
    updateEvolutionItem(item.id, {
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
    const item = createEvolutionItem({ status: 'checking' });

    const paused = pauseEvolutionItem(item.id);
    const resumed = resumeEvolutionItem(item.id);

    expect(paused.item.status).toBe('paused');
    expect(resumed.item.status).toBe('checking');
  });

  it('does not auto-implement unknown risk proposals', async () => {
    configureEvolutionEngine({
      settingsProvider: () =>
        settings({ autoImplementEnabled: true, allowedRiskLevel: 'medium' }),
      git: gitAdapter(),
      agentRunner: async ({ phase }) => {
        if (phase === 'proposal') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              module_scope: 'assistant',
              direction: '风险不明方案',
              risk_level: 'unknown',
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
            risk_level: 'unknown',
            evaluation: 'risk unknown',
            required_changes: [],
            blocked_by_policy: false,
            blocked_reason: null,
          }),
        };
      },
    });

    const result = await runEvolutionTick();

    expect(result.status).toBe('waiting_user_approval');
    expect(getActiveEvolutionItem()?.auto_implement).toBe(false);
  });

  it('honors proposal requires_user_approval even when auto implement is enabled', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings({ autoImplementEnabled: true }),
      git: gitAdapter(),
      agentRunner: async ({ phase }) => {
        if (phase === 'proposal') {
          return {
            ok: true,
            text: JSON.stringify({
              ok: true,
              module_scope: 'assistant',
              direction: '需要人工确认',
              risk_level: 'low',
              proposal: '# Plan',
              requires_user_approval: true,
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

    const result = await runEvolutionTick();

    expect(result.status).toBe('waiting_user_approval');
    expect(getActiveEvolutionItem()?.auto_implement).toBe(false);
  });

  it('checks out the work branch before checking', async () => {
    let branch = 'main';
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        currentBranch: async () => branch,
        currentCommit: async () =>
          branch === 'evolution/test' ? 'base-work' : 'commit-main',
        checkout: async (next) => {
          branch = next;
          return {
            ok: true,
            stdout: '',
            stderr: '',
            command: `git checkout ${next}`,
          };
        },
      },
      agentRunner: async () => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          review_complete: true,
          implementation_coverage: 'covered',
          bug_report: null,
          required_fixes: [],
          risk_level: 'low',
        }),
      }),
    });
    const item = createEvolutionItem({
      status: 'checking',
    });
    updateEvolutionItem(item.id, {
      work_branch: 'evolution/test',
      base_commit: 'base-work',
    });

    const result = await runEvolutionTick();

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready_for_adoption');
    expect(branch).toBe('evolution/test');
  });

  it('resumes adoption_failed items into fixing', async () => {
    configureEvolutionEngine({ settingsProvider: () => settings() });
    const item = createEvolutionItem({
      status: 'adoption_failed',
    });
    updateEvolutionItem(item.id, {
      work_branch: 'evolution/test',
      adoption_status: 'failed',
      adoption_error: 'checks failed',
    });

    const resumed = resumeEvolutionItem(item.id);

    expect(resumed.item.status).toBe('fixing');
    expect(resumed.item.adoption_error).toBeNull();
  });

  it('does not overwrite a paused item when a long-running phase returns', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: gitAdapter(),
      agentRunner: async ({ item }) => {
        pauseEvolutionItem(item.id);
        return {
          ok: true,
          text: JSON.stringify({
            ok: true,
            module_scope: 'assistant',
            direction: 'late proposal',
            risk_level: 'low',
            proposal: '# Plan',
            requires_user_approval: false,
            blocked_by_policy: false,
            blocked_reason: null,
          }),
        };
      },
    });
    const item = createEvolutionItem({});

    const result = await runEvolutionTick();

    expect(result.action).toBe('interrupted');
    expect(getEvolutionItem(item.id)?.status).toBe('paused');
  });

  it('rejects pause and cancel for terminal and adopting items', async () => {
    configureEvolutionEngine({ settingsProvider: () => settings() });
    const item = createEvolutionItem({ status: 'completed' });

    expect(() => pauseEvolutionItem(item.id)).toThrow(/terminal/);
    expect(() => cancelEvolutionItem(item.id)).toThrow(/terminal/);

    updateEvolutionItem(item.id, { status: 'adopting' });
    expect(() => pauseEvolutionItem(item.id)).toThrow(/adoption/);
    expect(() => cancelEvolutionItem(item.id)).toThrow(/adopting/);
  });

  it('blocks unknown-risk reviews instead of marking them ready for adoption', async () => {
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        currentBranch: async () => 'evolution/test',
      },
      agentRunner: async () => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          review_complete: true,
          implementation_coverage: 'covered',
          bug_report: null,
          required_fixes: [],
          risk_level: 'unknown',
        }),
      }),
    });
    const item = createEvolutionItem({
      status: 'reviewing',
    });
    updateEvolutionItem(item.id, {
      work_branch: 'evolution/test',
      base_commit: 'base-work',
    });

    const result = await runEvolutionTick();

    expect(result.action).toBe('blocked_unknown_risk_review');
    expect(result.status).toBe('blocked_by_policy');
  });

  it('stores diff artifacts before policy-blocking forbidden paths', async () => {
    let dirty = true;
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        currentBranch: async () => 'evolution/test',
        hasDirtyWorktree: async () => dirty,
        changedFiles: async () => ['.env'],
        worktreeChangedFiles: async () => (dirty ? ['.env'] : []),
        stashPush: async () => {
          dirty = false;
          return {
            ok: true,
            stdout: 'Saved working directory',
            stderr: '',
            command: 'git stash push -u -m blocked',
          };
        },
        diff: async () => 'diff --git a/.env b/.env',
      },
      agentRunner: async () => ({
        ok: true,
        text: JSON.stringify({
          ok: true,
          implementation_summary: 'changed env',
          changed_files: ['.env'],
          requires_followup: false,
        }),
      }),
    });
    const item = createEvolutionItem({
      status: 'implementing',
    });
    updateEvolutionItem(item.id, {
      work_branch: 'evolution/test',
      base_commit: 'base-work',
    });

    const result = await runEvolutionTick();
    const updated = getEvolutionItem(item.id, { includeDetails: true });

    expect(result.action).toBe('blocked_forbidden_path');
    expect(updated?.status).toBe('blocked_by_policy');
    expect(updated?.artifacts?.some((artifact) => artifact.artifact_type === 'diff')).toBe(
      true,
    );
    expect(
      updated?.artifacts?.some(
        (artifact) => artifact.artifact_type === 'blocked_worktree_cleanup',
      ),
    ).toBe(true);
    expect(dirty).toBe(false);
  });

  it('cleans dirty worktree when implementation reports a policy block', async () => {
    let dirty = true;
    configureEvolutionEngine({
      settingsProvider: () => settings(),
      git: {
        ...gitAdapter(),
        currentBranch: async () => 'evolution/test',
        hasDirtyWorktree: async () => dirty,
        changedFiles: async () => ['src/assistant/example.ts'],
        worktreeChangedFiles: async () =>
          dirty ? ['src/assistant/example.ts'] : [],
        stashPush: async () => {
          dirty = false;
          return {
            ok: true,
            stdout: 'Saved working directory',
            stderr: '',
            command: 'git stash push -u -m blocked',
          };
        },
        diff: async () =>
          'diff --git a/src/assistant/example.ts b/src/assistant/example.ts',
      },
      agentRunner: async () => ({
        ok: true,
        text: JSON.stringify({
          ok: false,
          implementation_summary: 'blocked',
          changed_files: ['src/assistant/example.ts'],
          requires_followup: true,
          blocked_by_policy: true,
          blocked_reason: 'needs permission changes',
        }),
      }),
    });
    const item = createEvolutionItem({
      status: 'implementing',
    });
    updateEvolutionItem(item.id, {
      work_branch: 'evolution/test',
      base_commit: 'base-work',
    });

    const result = await runEvolutionTick();
    const updated = getEvolutionItem(item.id, { includeDetails: true });

    expect(result.action).toBe('blocked_by_policy');
    expect(updated?.status).toBe('blocked_by_policy');
    expect(
      updated?.artifacts?.some(
        (artifact) => artifact.artifact_type === 'blocked_worktree_cleanup',
      ),
    ).toBe(true);
    expect(dirty).toBe(false);
  });
});
