import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActionExecutorRegistry,
  prepareWithLocalPolicy,
  terminalObservation,
  type ActionExecutor,
  type ActionObservation,
  type ActionRequest,
  type PreparedAction,
} from './executors/index.js';
import { CollaborationGitTransport } from './git-transport.js';
import type {
  ActionDefinition,
  MachineDefinition,
  RoleDefinition,
} from './protocol/index.js';
import {
  CollaborationScheduler,
  deterministicCollaborationPollDelay,
} from './scheduler.js';
import {
  CollaborationGroupService,
  type CreateCollaborationGroupInput,
} from './service.js';
import { CollaborationStore } from './store.js';

const roots: string[] = [];
const nowMs = 1_786_000_000_000;

function root(): string {
  const value = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-scheduler-'),
  );
  roots.push(value);
  return value;
}

function key(testRoot: string): string {
  const target = path.join(testRoot, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', target]);
  return target;
}

function remote(testRoot: string): string {
  const target = path.join(testRoot, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', target]);
  return target;
}

function definition(): {
  readonly machine: MachineDefinition;
  readonly roles: Record<string, RoleDefinition>;
  readonly actions: Record<string, ActionDefinition>;
  readonly prompts: Record<string, string>;
} {
  return {
    machine: {
      format: 'icarus.agent-group-machine/1',
      initial_state: 'development',
      states: {
        development: {
          terminal: false,
          transitions: [
            {
              id: 'implement',
              actor_role: 'developer',
              action_ref: 'actions/implement.yaml',
              outcomes: {
                succeeded: 'completed',
                failed: 'development',
                cancelled: 'development',
              },
            },
          ],
        },
        completed: { terminal: true, transitions: [] },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/1',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        allowed_transitions: ['implement'],
        executor_requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
        },
      },
    },
    actions: {
      implement: {
        format: 'icarus.agent-group-action/1',
        action_id: 'implement',
        kind: 'run_once',
        input: { prompt_ref: 'prompts/implement.md' },
        requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
          filesystem_access: 'workspace_write',
        },
        result_schema: { ref: 'code-change-result@1' },
      },
    },
    prompts: { 'prompts/implement.md': 'Implement this bounded task.\n' },
  };
}

class FakeExecutor implements ActionExecutor {
  readonly kind = 'run_once' as const;
  dispatchCount = 0;
  throwAfterSideEffect = false;
  observation: ActionObservation = {
    state: 'running',
    executionRef: 'collaboration-action:opaque-test',
    providerMetadata: { provider_secret_id: 'provider-only-1' },
    result: null,
    resultHash: null,
  };

  async prepare(request: ActionRequest): Promise<PreparedAction> {
    return prepareWithLocalPolicy(request);
  }

  async dispatch(_action: PreparedAction) {
    this.dispatchCount += 1;
    if (this.throwAfterSideEffect)
      throw new Error('dispatch response was lost');
    return {
      executionRef: 'collaboration-action:opaque-test',
      providerMetadata: { provider_secret_id: 'provider-only-1' },
      receipt: { accepted: true, private_receipt: 'receipt-only-1' },
    };
  }

  async observe(): Promise<ActionObservation> {
    return this.observation;
  }

  async cancel() {
    return { cancelled: false, observation: this.observation };
  }

  async recover(): Promise<ActionObservation> {
    return this.observation;
  }

  succeed(action: ActionDefinition): void {
    this.observation = terminalObservation(
      'succeeded',
      'collaboration-action:opaque-test',
      { provider_secret_id: 'provider-only-1' },
      action,
      {
        format: 'icarus.collaboration-action-result/1',
        outcome: 'success',
        summary: 'Implemented',
        data: { changed: true },
        artifacts: [],
        error: null,
      },
    );
  }
}

async function fixture(testRoot: string, withBinding = true) {
  const store = new CollaborationStore(path.join(testRoot, 'collaboration.db'));
  const groups = new CollaborationGroupService(
    store,
    new CollaborationGitTransport(),
    path.join(testRoot, 'repositories'),
    () => nowMs,
  );
  const selected = definition();
  const input: CreateCollaborationGroupInput = {
    remoteUrl: remote(testRoot),
    name: 'Scheduler test group',
    groupId: 'ag_scheduler',
    principalId: 'alice',
    agentId: 'agent_alice',
    signingKeyPath: key(testRoot),
    capabilities: ['coding_task', 'visible_session'],
    initialRole: 'developer',
    pollIntervalMs: 1_000,
    ...selected,
  };
  await groups.createGroup(input);
  if (withBinding)
    store.saveExecutorBinding({
      groupId: 'ag_scheduler',
      role: 'developer',
      executorKind: 'run_once',
      adapter: null,
      agentJid: 'web:main',
      workspacePath: testRoot,
      promptOverride: null,
      filesystemAccessCap: 'workspace_write',
      approvalPolicy: 'on-request',
      config: {},
      enabled: true,
    });
  const executor = new FakeExecutor();
  const registry = new ActionExecutorRegistry();
  registry.register(executor);
  const scheduler = new CollaborationScheduler(store, groups, registry, {
    ownerId: 'scheduler-test',
    now: () => nowMs,
  });
  await groups.start('ag_scheduler');
  return {
    store,
    groups,
    scheduler,
    executor,
    action: selected.actions.implement,
  };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('CollaborationScheduler', () => {
  it('uses stable jitter and does not claim without a valid local binding', async () => {
    expect(deterministicCollaborationPollDelay('ag_a', 10_000)).toBe(
      deterministicCollaborationPollDelay('ag_a', 10_000),
    );
    const selected = await fixture(root(), false);
    try {
      await expect(selected.scheduler.syncNow('ag_scheduler')).rejects.toThrow(
        /No local executor binding/,
      );
      const group = selected.store.getGroup('ag_scheduler')!;
      const turn = group.projection!.turns[group.projection!.activeTurnId!];
      expect(turn.state).toBe('WAITING');
      expect(selected.executor.dispatchCount).toBe(0);
    } finally {
      selected.store.close();
    }
  }, 20_000);

  it('completes an action through signed Git without publishing provider metadata', async () => {
    const selected = await fixture(root());
    try {
      selected.executor.succeed(selected.action);
      await selected.scheduler.syncNow('ag_scheduler');
      const group = selected.store.getGroup('ag_scheduler')!;
      expect(group.businessState).toBe('completed');
      expect(group.projection?.activeTurnId).toBeNull();
      expect(selected.executor.dispatchCount).toBe(1);
      expect(selected.store.listExecutions('ag_scheduler')[0]).toMatchObject({
        state: 'succeeded',
        executionRef: 'collaboration-action:opaque-test',
        providerMetadata: { provider_secret_id: 'provider-only-1' },
      });
      const sharedEvents = JSON.stringify(
        selected.store.listEvents('ag_scheduler'),
      );
      expect(sharedEvents).not.toContain('provider-only-1');
      expect(sharedEvents).not.toContain('receipt-only-1');
    } finally {
      selected.store.close();
    }
  }, 20_000);

  it('never redispatches when a provider side effect has no durable receipt', async () => {
    const selected = await fixture(root());
    try {
      selected.executor.throwAfterSideEffect = true;
      await selected.scheduler.syncNow('ag_scheduler');
      expect(selected.store.listExecutions('ag_scheduler')[0]).toMatchObject({
        state: 'recovery_required',
        receipt: null,
        recoveryRequiredReason: expect.stringMatching(/durable receipt/),
      });
      await selected.scheduler.syncNow('ag_scheduler');
      expect(selected.executor.dispatchCount).toBe(1);
    } finally {
      selected.store.close();
    }
  }, 20_000);

  it('retries a Git result after a crash boundary without redispatching', async () => {
    const selected = await fixture(root());
    try {
      selected.executor.succeed(selected.action);
      const original = selected.groups.appendActionEvent.bind(selected.groups);
      let failResultOnce = true;
      vi.spyOn(selected.groups, 'appendActionEvent').mockImplementation(
        async (input) => {
          if (input.type === 'action_succeeded' && failResultOnce) {
            failResultOnce = false;
            throw new Error('simulated crash before Git result push');
          }
          return original(input);
        },
      );
      await expect(selected.scheduler.syncNow('ag_scheduler')).rejects.toThrow(
        /simulated crash/,
      );
      expect(selected.store.listExecutions('ag_scheduler')[0].state).toBe(
        'succeeded',
      );
      await selected.scheduler.syncNow('ag_scheduler');
      expect(selected.executor.dispatchCount).toBe(1);
      expect(selected.store.getGroup('ag_scheduler')?.businessState).toBe(
        'completed',
      );
    } finally {
      selected.store.close();
    }
  }, 30_000);

  it('drains an active execution before completing pause', async () => {
    const selected = await fixture(root());
    try {
      await selected.scheduler.syncNow('ag_scheduler');
      expect(
        selected.store.getGroup('ag_scheduler')?.projection?.lifecycle,
      ).toBe('RUNNING');
      await selected.groups.pause('ag_scheduler');
      selected.executor.succeed(selected.action);
      await selected.scheduler.syncNow('ag_scheduler');
      expect(selected.store.getGroup('ag_scheduler')).toMatchObject({
        lifecycle: 'PAUSED',
        businessState: 'completed',
      });
    } finally {
      selected.store.close();
    }
  }, 30_000);

  it('recovers a claim-before-dispatch crash and drains close on the new fence', async () => {
    const selected = await fixture(root());
    try {
      const claim = await selected.groups.claimCurrentTurn('ag_scheduler');
      expect(claim.won).toBe(true);
      const turn =
        claim.history.projection.turns[claim.history.projection.activeTurnId!];
      selected.store.reserveExecution({
        executionId: 'collaboration:lost-before-dispatch',
        groupId: 'ag_scheduler',
        turnId: turn.turnId,
        epoch: turn.epoch,
        attempt: turn.attempt,
        fencingToken: turn.fencingToken!,
        operationKey: turn.idempotencyKey,
        executorKind: 'run_once',
        nowMs,
      });
      selected.scheduler.start();
      selected.scheduler.stop();
      expect(
        selected.store.getExecutionForTurn('ag_scheduler', turn.turnId, 1),
      ).toMatchObject({
        state: 'recovery_required',
        receipt: null,
      });

      await selected.groups.recoverTurn(
        'ag_scheduler',
        'Confirmed no durable provider receipt exists',
      );
      await selected.scheduler.syncNow('ag_scheduler');
      await selected.groups.close('ag_scheduler', 'Test close with drain');
      selected.executor.succeed(selected.action);
      await selected.scheduler.syncNow('ag_scheduler');

      expect(selected.store.getGroup('ag_scheduler')).toMatchObject({
        lifecycle: 'CLOSED',
        businessState: 'completed',
      });
      expect(selected.executor.dispatchCount).toBe(1);
      expect(selected.store.listExecutions('ag_scheduler')).toHaveLength(2);
    } finally {
      selected.store.close();
    }
  }, 40_000);
});
