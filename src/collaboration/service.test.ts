import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationGitTransport } from './git-transport.js';
import type {
  ActionDefinition,
  MachineDefinition,
  RoleDefinition,
} from './protocol/index.js';
import {
  CollaborationGroupService,
  type CreateCollaborationGroupInput,
} from './service.js';
import { CollaborationStore } from './store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-service-'),
  );
  roots.push(value);
  return value;
}

function key(testRoot: string, name: string): string {
  const target = path.join(testRoot, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', target]);
  return target;
}

function remote(testRoot: string): string {
  const target = path.join(testRoot, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', target]);
  return target;
}

function definition(maxDevelopers = 1): {
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
              outcomes: { succeeded: 'completed', failed: 'development' },
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
        cardinality: { min: 1, max: maxDevelopers },
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
    prompts: {
      'prompts/implement.md': 'Implement the current collaboration task.\n',
    },
  };
}

function cyclicDefinition(): {
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
                succeeded: 'review',
                failed: 'development',
                cancelled: 'development',
                blocked: 'development',
              },
            },
          ],
        },
        review: {
          terminal: false,
          transitions: [
            {
              id: 'review',
              actor_role: 'reviewer',
              action_ref: 'actions/review.yaml',
              outcomes: {
                succeeded: 'development',
                failed: 'development',
                cancelled: 'review',
                blocked: 'review',
              },
            },
          ],
        },
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
      reviewer: {
        format: 'icarus.agent-group-role/1',
        role: 'reviewer',
        display_name: 'Reviewer',
        cardinality: { min: 1, max: 1 },
        allowed_transitions: ['review'],
        executor_requirements: {
          capability: 'review_task',
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
        result_schema: { ref: 'collaboration-result@1' },
      },
      review: {
        format: 'icarus.agent-group-action/1',
        action_id: 'review',
        kind: 'run_once',
        input: { prompt_ref: 'prompts/review.md' },
        requirements: {
          capability: 'review_task',
          interaction: 'visible_session',
          filesystem_access: 'read_only',
        },
        result_schema: { ref: 'collaboration-result@1' },
      },
    },
    prompts: {
      'prompts/implement.md': 'Implement this turn.\n',
      'prompts/review.md': 'Review this turn.\n',
    },
  };
}

function createInput(
  remoteUrl: string,
  signingKeyPath: string,
  maxDevelopers = 1,
): CreateCollaborationGroupInput {
  return {
    remoteUrl,
    name: 'Service test group',
    groupId: 'ag_service',
    principalId: 'alice',
    agentId: 'agent_alice',
    signingKeyPath,
    capabilities: ['coding_task', 'visible_session'],
    initialRole: 'developer',
    pollIntervalMs: 1000,
    ...definition(maxDevelopers),
  };
}

function cyclicCreateInput(
  remoteUrl: string,
  signingKeyPath: string,
): CreateCollaborationGroupInput {
  return {
    remoteUrl,
    name: 'Cyclic multi-role group',
    groupId: 'ag_cyclic_service',
    principalId: 'alice',
    agentId: 'agent_alice',
    signingKeyPath,
    capabilities: ['coding_task', 'visible_session'],
    initialRole: 'developer',
    pollIntervalMs: 1000,
    ...cyclicDefinition(),
  };
}

async function completeCurrentTurn(
  groupService: CollaborationGroupService,
  groupId: string,
  toState: string,
  suffix: string,
) {
  let history = (await groupService.claimCurrentTurn(groupId)).history;
  const turn = history.projection.turns[history.projection.activeTurnId!];
  history = await groupService.appendActionEvent({
    groupId,
    type: 'action_dispatched',
    payload: {
      turn_id: turn.turnId,
      attempt: turn.attempt,
      fencing_token: turn.fencingToken,
      execution_ref: `run-once:${suffix}`,
    },
  });
  history = await groupService.appendActionEvent({
    groupId,
    type: 'action_succeeded',
    payload: {
      turn_id: turn.turnId,
      attempt: turn.attempt,
      fencing_token: turn.fencingToken,
      result_hash: `sha256:${suffix.repeat(64).slice(0, 64)}`,
      artifact_refs: [],
    },
  });
  return groupService.appendActionEvent({
    groupId,
    type: 'state_transitioned',
    payload: {
      turn_id: turn.turnId,
      attempt: turn.attempt,
      fencing_token: turn.fencingToken,
      outcome: 'succeeded',
      from_state: history.projection.businessState,
      to_state: toState,
    },
  });
}

function service(testRoot: string, name: string) {
  const store = new CollaborationStore(path.join(testRoot, `${name}.db`));
  const groupService = new CollaborationGroupService(
    store,
    new CollaborationGitTransport(),
    path.join(testRoot, `${name}-repositories`),
    () => 1_786_000_000_000,
  );
  return { store, groupService };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('CollaborationGroupService', () => {
  it('creates, inspects, starts, creates a turn, and drains pause through signed Git', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const owner = service(testRoot, 'owner');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, aliceKey),
      );
      expect(created).toMatchObject({
        groupId: 'ag_service',
        lifecycle: 'READY',
        businessState: 'development',
        protocolStatus: 'OK',
      });
      const summary = await owner.groupService.inspectRemote(remoteUrl);
      expect(summary).toMatchObject({
        groupId: 'ag_service',
        lifecycle: 'READY',
        roles: [{ role: 'developer', claimed: 1, min: 1, max: 1 }],
      });
      const started = await owner.groupService.start('ag_service');
      expect(started.lifecycle).toBe('RUNNING');
      expect(started.projection?.activeTurnId).toBeTruthy();
      const turn = started.projection?.turns[started.projection.activeTurnId!];
      expect(turn).toMatchObject({
        role: 'developer',
        actionId: 'implement',
        state: 'WAITING',
        attempt: 1,
      });
      const pausing = await owner.groupService.pause('ag_service');
      expect(pausing.lifecycle).toBe('PAUSING');
      expect(
        owner.store.listEvents('ag_service').map((event) => event.event_type),
      ).toContain('group_pause_requested');
    } finally {
      owner.store.close();
    }
  }, 20_000);

  it('joins by known URL, registers a member, and claims a role', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const bobKey = key(testRoot, 'bob-key');
    const owner = service(testRoot, 'owner');
    const participant = service(testRoot, 'participant');
    try {
      await owner.groupService.createGroup(createInput(remoteUrl, aliceKey, 2));
      const joined = await participant.groupService.joinGroup({
        remoteUrl,
        principalId: 'bob',
        agentId: 'agent_bob',
        signingKeyPath: bobKey,
        capabilities: ['coding_task', 'visible_session'],
        role: 'developer',
      });
      expect(joined.projection?.members.bob).toMatchObject({
        principal_id: 'bob',
        agent_id: 'agent_bob',
      });
      expect(joined.projection?.roleClaims.developer).toHaveLength(2);
      await expect(
        participant.groupService.start('ag_service'),
      ).rejects.toThrow(/Only the group creator/);
    } finally {
      owner.store.close();
      participant.store.close();
    }
  }, 20_000);

  it('waits for every required role and executes a multi-user cycle', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const bobKey = key(testRoot, 'bob-key');
    const owner = service(testRoot, 'owner');
    const participant = service(testRoot, 'participant');
    try {
      const created = await owner.groupService.createGroup(
        cyclicCreateInput(remoteUrl, aliceKey),
      );
      expect(created).toMatchObject({ lifecycle: 'FORMING' });
      expect(created.projection?.roleClaims).toMatchObject({
        developer: [expect.objectContaining({ principal_id: 'alice' })],
      });
      expect(created.projection?.roleClaims.reviewer ?? []).toHaveLength(0);
      await expect(
        owner.groupService.start('ag_cyclic_service'),
      ).rejects.toThrow(/lifecycle is FORMING/);

      const joined = await participant.groupService.joinGroup({
        remoteUrl,
        principalId: 'bob',
        agentId: 'agent_bob',
        signingKeyPath: bobKey,
        capabilities: ['review_task', 'visible_session'],
        role: 'reviewer',
      });
      expect(joined).toMatchObject({ lifecycle: 'READY' });
      expect(joined.projection?.roleClaims.reviewer).toEqual([
        expect.objectContaining({ principal_id: 'bob' }),
      ]);

      await owner.groupService.sync('ag_cyclic_service');
      await owner.groupService.start('ag_cyclic_service');
      let history = await completeCurrentTurn(
        owner.groupService,
        'ag_cyclic_service',
        'review',
        'a',
      );
      expect(history.projection.businessState).toBe('review');
      await owner.groupService.ensureTurn('ag_cyclic_service');

      await participant.groupService.sync('ag_cyclic_service');
      history = await completeCurrentTurn(
        participant.groupService,
        'ag_cyclic_service',
        'development',
        'b',
      );
      expect(history.projection.businessState).toBe('development');

      await owner.groupService.sync('ag_cyclic_service');
      history = (await owner.groupService.ensureTurn('ag_cyclic_service'))!;
      const turns = Object.values(history.projection.turns);
      expect(turns).toHaveLength(3);
      expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(3);
      expect(
        history.projection.turns[history.projection.activeTurnId!],
      ).toMatchObject({ role: 'developer', state: 'WAITING' });
    } finally {
      owner.store.close();
      participant.store.close();
    }
  }, 60_000);

  it('allows only one fast-forward winner when two role holders claim the same turn', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const bobKey = key(testRoot, 'bob-key');
    const owner = service(testRoot, 'owner');
    const participant = service(testRoot, 'participant');
    try {
      await owner.groupService.createGroup(createInput(remoteUrl, aliceKey, 2));
      await participant.groupService.joinGroup({
        remoteUrl,
        principalId: 'bob',
        agentId: 'agent_bob',
        signingKeyPath: bobKey,
        capabilities: ['coding_task', 'visible_session'],
        role: 'developer',
      });
      await owner.groupService.start('ag_service');
      await participant.groupService.sync('ag_service');
      const results = await Promise.all([
        owner.groupService.claimCurrentTurn('ag_service'),
        participant.groupService.claimCurrentTurn('ag_service'),
      ]);
      expect(results.filter((result) => result.won)).toHaveLength(1);
      expect(results.filter((result) => !result.won)).toHaveLength(1);
      const synchronized = await owner.groupService.sync('ag_service');
      const turn =
        synchronized.projection?.turns[synchronized.projection.activeTurnId!];
      expect(turn?.state).toBe('CLAIMED');
      expect(['alice', 'bob']).toContain(turn?.claimantPrincipalId);
    } finally {
      owner.store.close();
      participant.store.close();
    }
  }, 30_000);

  it('rejects a command whose revision became stale before the authoritative append', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const bobKey = key(testRoot, 'bob-key');
    const owner = service(testRoot, 'owner');
    const participant = service(testRoot, 'participant');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, aliceKey, 2),
      );
      const requestRevision = created.projection!.revision;

      await participant.groupService.joinGroup({
        remoteUrl,
        principalId: 'bob',
        agentId: 'agent_bob',
        signingKeyPath: bobKey,
        capabilities: ['coding_task', 'visible_session'],
        role: 'developer',
      });

      await expect(
        owner.groupService.start('ag_service', requestRevision),
      ).rejects.toThrow(
        `Expected revision ${String(requestRevision)} does not match 3`,
      );
      const synchronized = await participant.groupService.sync('ag_service');
      expect(synchronized.projection?.lifecycle).toBe('READY');
      expect(synchronized.projection?.sequence).toBe(3);
    } finally {
      owner.store.close();
      participant.store.close();
    }
  }, 30_000);

  it('resumes incremental validation from the persisted projection after restart', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const owner = service(testRoot, 'owner');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, aliceKey),
      );
      const restarted = new CollaborationGroupService(
        owner.store,
        new CollaborationGitTransport(),
        path.join(testRoot, 'owner-repositories'),
        () => 1_786_000_000_000,
      );

      const history = await restarted.syncHistory('ag_service');
      expect(history.validation).toMatchObject({
        mode: 'incremental',
        validatedCommitCount: 0,
        totalSequence: created.projection!.sequence,
        checkpointHead: created.headCommit,
      });
      expect(history.projection).toEqual(created.projection);
    } finally {
      owner.store.close();
    }
  }, 20_000);

  it('rejects prompt paths that could overwrite protocol files', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const aliceKey = key(testRoot, 'alice-key');
    const owner = service(testRoot, 'owner');
    try {
      const input = createInput(remoteUrl, aliceKey);
      await expect(
        owner.groupService.createGroup({
          ...input,
          prompts: {
            ...input.prompts,
            'group.yaml': 'forged',
          },
        }),
      ).rejects.toThrow(/below prompts/);
    } finally {
      owner.store.close();
    }
  });
});
