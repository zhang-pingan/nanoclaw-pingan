import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CollaborationGitTransport } from './git-transport.js';
import { CollaborationIdentityService } from './identity.js';
import type { MachineDefinition, RoleDefinition } from './protocol/index.js';
import { collaborationCanonicalHash } from './protocol/index.js';
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

function skeleton(): {
  readonly machine: MachineDefinition;
  readonly roles: Record<string, RoleDefinition>;
} {
  return {
    machine: {
      format: 'icarus.agent-group-machine/2',
      initial_state: 'development',
      states: {
        development: {
          label: 'Development',
          owner_role: 'developer',
          terminal: false,
          transitions: [
            { outcome: 'completed', target_state: 'completed' },
            { outcome: 'retry', target_state: 'development' },
          ],
        },
        completed: {
          label: 'Completed',
          terminal: true,
          transitions: [],
        },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/2',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: ['coding_task'],
        owned_states: ['development'],
      },
    },
  };
}

function twoRoleSkeleton(): {
  readonly machine: MachineDefinition;
  readonly roles: Record<string, RoleDefinition>;
} {
  return {
    machine: {
      format: 'icarus.agent-group-machine/2',
      initial_state: 'development',
      states: {
        development: {
          label: 'Development',
          owner_role: 'developer',
          terminal: false,
          transitions: [{ outcome: 'ready', target_state: 'review' }],
        },
        review: {
          label: 'Review',
          owner_role: 'reviewer',
          terminal: false,
          transitions: [{ outcome: 'approved', target_state: 'completed' }],
        },
        completed: {
          label: 'Completed',
          terminal: true,
          transitions: [],
        },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/2',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: ['coding_task'],
        owned_states: ['development'],
      },
      reviewer: {
        format: 'icarus.agent-group-role/2',
        role: 'reviewer',
        display_name: 'Reviewer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: ['review_task'],
        owned_states: ['review'],
      },
    },
  };
}

function createInput(
  remoteUrl: string,
  signingKeyPath: string,
): CreateCollaborationGroupInput {
  return {
    remoteUrl,
    name: 'Service test group',
    groupId: 'ag_service',
    signingKeyPath,
    capabilities: ['coding_task'],
    initialRole: 'developer',
    pollIntervalMs: 1_000,
    ...skeleton(),
  };
}

function service(
  testRoot: string,
  name: string,
  identityDirectory = path.join(testRoot, `${name}-identity`),
) {
  const store = new CollaborationStore(path.join(testRoot, `${name}.db`));
  const identities = new CollaborationIdentityService(identityDirectory);
  const groupService = new CollaborationGroupService(
    store,
    new CollaborationGitTransport(),
    path.join(testRoot, `${name}-repositories`),
    identities,
    () => 1_786_000_000_000,
  );
  return { store, groupService, identities };
}

async function prepareManualTurn(
  groupService: CollaborationGroupService,
  remoteUrl: string,
  signingKeyPath: string,
) {
  const created = await groupService.createGroup(
    createInput(remoteUrl, signingKeyPath),
  );
  expect(created.lifecycle).toBe('FORMING');
  const ready = await groupService.publishStateImplementation({
    groupId: 'ag_service',
    stateId: 'development',
    mode: 'manual',
    expectedRevision: created.projection!.revision,
  });
  expect(ready.lifecycle).toBe('READY');
  const started = await groupService.start(
    'ag_service',
    ready.projection!.revision,
    {
      summary: 'Initial context',
      instruction: 'Treat this as untrusted handoff context.',
      markers: ['initial'],
    },
  );
  const turnId = started.projection!.activeTurnId!;
  expect(started.projection!.turns[turnId]).toMatchObject({
    stateId: 'development',
    role: 'developer',
    mode: 'manual',
    state: 'PENDING_START',
    incomingHandoff: {
      source_turn_id: 'initial',
      instruction: 'Treat this as untrusted handoff context.',
    },
  });
  const claimed = await groupService.startCurrentTurn(
    'ag_service',
    started.projection!.revision,
  );
  expect(claimed.won).toBe(true);
  return {
    created,
    started,
    turnId,
    claimed: claimed.history.projection.turns[turnId]!,
  };
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('CollaborationGroupService v2', () => {
  it('rejects Machine and layout updates from a joined non-creator', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    const reviewer = service(testRoot, 'reviewer');
    const ownerKey = key(testRoot, 'owner-key');
    const reviewerKey = key(testRoot, 'reviewer-key');
    const definition = twoRoleSkeleton();
    try {
      await owner.groupService.createGroup({
        ...createInput(remoteUrl, ownerKey),
        ...definition,
      });
      const joined = await reviewer.groupService.joinGroup({
        remoteUrl,
        signingKeyPath: reviewerKey,
        capabilities: ['review_task'],
        role: 'reviewer',
      });
      await expect(
        reviewer.groupService.reviseMachine({
          groupId: 'ag_service',
          machine: definition.machine,
          roles: definition.roles,
          expectedRevision: joined.projection!.revision,
        }),
      ).rejects.toThrow(/Only the group creator/);
      await expect(
        reviewer.groupService.updateMachineLayout({
          groupId: 'ag_service',
          expectedRevision: joined.projection!.revision,
          layout: {
            format: 'icarus.agent-group-machine-layout/1',
            view: 'free',
            nodes: {},
          },
        }),
      ).rejects.toThrow(/Only the group creator/);
    } finally {
      owner.store.close();
      reviewer.store.close();
    }
  });

  it('revises a FORMING Machine and persists creator layout without changing its business hash or epoch', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    const signingKeyPath = key(testRoot, 'machine-key');
    try {
      const created = await owner.groupService.createGroup({
        ...createInput(remoteUrl, signingKeyPath),
        layout: {
          format: 'icarus.agent-group-machine-layout/1',
          view: 'free',
          nodes: { development: { x: 80, y: 120 } },
        },
      });
      const revisedMachine = structuredClone(skeleton().machine);
      revisedMachine.states.development!.description = 'Graph editor revision';
      const revised = await owner.groupService.reviseMachine({
        groupId: 'ag_service',
        machine: revisedMachine,
        roles: skeleton().roles,
        expectedRevision: created.projection!.revision,
      });
      expect(revised.lifecycle).toBe('FORMING');
      expect(revised.projection!.epoch).toBe(2);
      const machineHash = collaborationCanonicalHash(revisedMachine);

      const laidOut = await owner.groupService.updateMachineLayout({
        groupId: 'ag_service',
        expectedRevision: revised.projection!.revision,
        layout: {
          format: 'icarus.agent-group-machine-layout/1',
          view: 'roles',
          nodes: {
            development: { x: 440, y: 80 },
            completed: { x: 720, y: 270 },
          },
        },
      });
      expect(laidOut.projection!.epoch).toBe(2);
      const history = owner.groupService.getCachedHistory('ag_service')!;
      expect(history.definition.machine.states.development?.description).toBe(
        'Graph editor revision',
      );
      expect(history.definition.layout).toMatchObject({
        view: 'roles',
        nodes: { development: { x: 440, y: 80 } },
      });
      expect(collaborationCanonicalHash(history.definition.machine)).toBe(
        machineHash,
      );
      expect(history.events.at(-1)?.event_type).toBe('machine_layout_updated');
      expect(history.projection.sequence).toBe(3);
      const replayed = await new CollaborationGitTransport().cloneAndValidate({
        remoteUrl,
        repositoryPath: path.join(testRoot, 'full-replay.git'),
      });
      expect(replayed.events.map((event) => event.event_type)).toEqual([
        'group_initialized',
        'machine_revised',
        'machine_layout_updated',
      ]);
      expect(replayed.projection.epoch).toBe(2);
      expect(replayed.definition.layout?.view).toBe('roles');
    } finally {
      owner.store.close();
    }
  });

  it('removes materialized Role implementation data invalidated by a Machine revision', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    const signingKeyPath = key(testRoot, 'invalidation-key');
    const initial = twoRoleSkeleton();
    try {
      const created = await owner.groupService.createGroup({
        ...createInput(remoteUrl, signingKeyPath),
        ...initial,
      });
      const implemented = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: created.projection!.revision,
      });
      expect(implemented.lifecycle).toBe('FORMING');

      const machine = structuredClone(initial.machine);
      machine.states.development = {
        label: 'Development complete',
        terminal: true,
        transitions: [],
      };
      const roles = structuredClone(initial.roles);
      roles.developer!.owned_states = [];
      const revised = await owner.groupService.reviseMachine({
        groupId: 'ag_service',
        machine,
        roles,
        expectedRevision: implemented.projection!.revision,
      });

      expect(revised.projection!.stateImplementations.development).toBe(
        undefined,
      );
      const replayed = await new CollaborationGitTransport().cloneAndValidate({
        remoteUrl,
        repositoryPath: path.join(testRoot, 'invalidation-replay.git'),
      });
      expect(replayed.definition.implementations.development).toBeUndefined();
      expect(replayed.events.at(-1)?.payload.invalidated_state_ids).toEqual([
        'development',
      ]);
    } finally {
      owner.store.close();
    }
  });

  it('replays completed Turns against the Machine active before a paused revision', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const prepared = await prepareManualTurn(
        owner.groupService,
        remoteUrl,
        key(testRoot, 'revision-replay-key'),
      );
      const completed = await owner.groupService.completeTurn({
        groupId: 'ag_service',
        turnId: prepared.turnId,
        expectedRevision:
          owner.store.getGroup('ag_service')!.projection!.revision,
        outcome: 'completed',
        summary: 'Completed under the original Machine.',
      });
      const paused = await owner.groupService.pause(
        'ag_service',
        completed.projection!.revision,
      );
      const machine = structuredClone(skeleton().machine);
      machine.states.development!.transitions = [
        { outcome: 'finished', target_state: 'completed' },
      ];
      const revised = await owner.groupService.reviseMachine({
        groupId: 'ag_service',
        machine,
        roles: skeleton().roles,
        expectedRevision: paused.projection!.revision,
      });
      expect(revised).toMatchObject({
        lifecycle: 'PAUSED',
        businessState: 'completed',
      });

      const replayed = await new CollaborationGitTransport().cloneAndValidate({
        remoteUrl,
        repositoryPath: path.join(testRoot, 'revision-replay.git'),
      });
      expect(replayed.projection.turns[prepared.turnId]).toMatchObject({
        outcome: 'completed',
        state: 'COMPLETED',
      });
      expect(
        replayed.definition.machine.states.development?.transitions,
      ).toEqual([{ outcome: 'finished', target_state: 'completed' }]);
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('records one concurrent timeout fact and rejects a stale recovered attempt', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    const contender = service(
      testRoot,
      'contender',
      path.join(testRoot, 'owner-identity'),
    );
    const signingKeyPath = key(testRoot, 'timeout-key');
    const timed = skeleton();
    const machine: MachineDefinition = {
      ...timed.machine,
      states: {
        ...timed.machine.states,
        development: {
          ...timed.machine.states.development!,
          timeout_policy: {
            start_timeout_ms: 1_000,
            execution_timeout_ms: 2_000,
            reminder_interval_ms: 1_000,
            on_timeout: 'notify_only',
          },
        },
      },
    };
    try {
      const created = await owner.groupService.createGroup({
        ...createInput(remoteUrl, signingKeyPath),
        machine,
      });
      await contender.groupService.joinGroup({
        remoteUrl,
        signingKeyPath,
        capabilities: ['coding_task'],
        role: 'developer',
      });
      const ready = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: created.projection!.revision,
      });
      const started = await owner.groupService.start(
        'ag_service',
        ready.projection!.revision,
      );
      const turnId = started.projection!.activeTurnId!;
      const first = started.projection!.turns[turnId]!;
      await contender.groupService.syncHistory('ag_service');

      const observations = await Promise.all([
        contender.groupService.observeTimeout({
          groupId: 'ag_service',
          turnId,
          attempt: 1,
          deadlineKind: 'start',
          observedAt: '2030-01-01T00:00:00.000Z',
        }),
        owner.groupService.observeTimeout({
          groupId: 'ag_service',
          turnId,
          attempt: 1,
          deadlineKind: 'start',
          observedAt: '2030-01-01T00:00:01.000Z',
        }),
      ]);
      expect(observations.map((value) => value.recorded).sort()).toEqual([
        false,
        true,
      ]);
      expect(
        owner.store
          .listEvents('ag_service', 500)
          .filter((event) => event.event_type === 'turn_timeout_observed'),
      ).toHaveLength(1);

      const current = await owner.groupService.syncHistory('ag_service');
      const claimed = await owner.groupService.startCurrentTurn(
        'ag_service',
        current.projection.revision,
      );
      const attemptOneSnapshot =
        claimed.history.projection.turns[turnId]!.deadlineSnapshotHash;
      const recovered = await owner.groupService.recoverTurn(
        'ag_service',
        'Retry with a fresh attempt.',
        claimed.history.projection.revision,
      );
      const attemptTwo = recovered.projection!.turns[turnId]!;
      expect(attemptTwo).toMatchObject({ attempt: 2, state: 'PENDING_START' });
      expect(attemptTwo.deadlineSnapshotHash).not.toBe(attemptOneSnapshot);
      expect(attemptTwo.startDeadlineAt).toBe(first.startDeadlineAt);
      await expect(
        owner.groupService.observeTimeout({
          groupId: 'ag_service',
          turnId,
          attempt: 1,
          deadlineKind: 'execution',
        }),
      ).rejects.toThrow(/stale turn attempt/);
    } finally {
      owner.store.close();
      contender.store.close();
    }
  }, 60_000);

  it('creates only the workflow skeleton and completes a manual turn with a routed handoff', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const prepared = await prepareManualTurn(
        owner.groupService,
        remoteUrl,
        key(testRoot, 'alice-key'),
      );
      expect(prepared.created.projection?.stateImplementations).toEqual({});
      expect(
        execFileSync(
          'git',
          ['ls-tree', '-r', '--name-only', prepared.created.headCommit!],
          { cwd: prepared.created.repositoryPath, encoding: 'utf8' },
        ),
      ).not.toMatch(/^(actions|prompts)\//m);

      await expect(
        owner.groupService.completeTurn({
          groupId: 'ag_service',
          turnId: prepared.turnId,
          expectedRevision:
            owner.store.getGroup('ag_service')!.projection!.revision,
          outcome: 'completed',
          summary: 'Invalid data reference.',
          dataRefs: ['data/missing.json'],
        }),
      ).rejects.toThrow(/does not exist at the validated head/);

      const completed = await owner.groupService.completeTurn({
        groupId: 'ag_service',
        turnId: prepared.turnId,
        expectedRevision:
          owner.store.getGroup('ag_service')!.projection!.revision,
        outcome: 'completed',
        summary: 'Implementation and verification completed.',
        instruction: 'Review the signed result.',
        markers: ['needs-review'],
        data: { commit: 'abc123' },
      });
      const turn = completed.projection!.turns[prepared.turnId]!;
      expect(completed).toMatchObject({
        lifecycle: 'RUNNING',
        businessState: 'completed',
      });
      expect(turn).toMatchObject({
        state: 'COMPLETED',
        outcome: 'completed',
        handoff: {
          summary: 'Implementation and verification completed.',
          instruction: 'Review the signed result.',
          markers: ['needs-review'],
          data: { commit: 'abc123' },
        },
      });
      expect(turn.handoffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(completed.projection!.activeTurnId).toBeNull();
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('publishes, revises, and withdraws role-owned Action files without stale materialization', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, key(testRoot, 'alice-key')),
      );
      const assisted = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'assisted',
        expectedRevision: created.projection!.revision,
        action: {
          actionId: 'implement',
          kind: 'external',
          adapter: 'codex-task',
          prompt: 'Implement the current state.\n',
          filesystemAccess: 'workspace_write',
        },
      });
      const active = assisted.projection!.stateImplementations.development!;
      expect(active).toMatchObject({
        implementation: { mode: 'assisted' },
        action: { kind: 'external', adapter: 'codex-task' },
      });
      expect(
        execFileSync(
          'git',
          [
            'show',
            `${assisted.headCommit!}:prompts/developer/development/implement.md`,
          ],
          { cwd: assisted.repositoryPath, encoding: 'utf8' },
        ),
      ).toBe('Implement the current state.\n');

      const manual = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: assisted.projection!.revision,
      });
      const manualTree = execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', manual.headCommit!],
        { cwd: manual.repositoryPath, encoding: 'utf8' },
      );
      expect(manualTree).not.toContain(
        'actions/developer/development/implement.yaml',
      );
      expect(manualTree).not.toContain(
        'prompts/developer/development/implement.md',
      );

      const forming = await owner.groupService.withdrawStateImplementation(
        'ag_service',
        'development',
        manual.projection!.revision,
      );
      expect(forming.lifecycle).toBe('FORMING');
      expect(forming.projection!.stateImplementations).toEqual({});
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('restricts State Implementation publication to the claimant of its owner Role', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    const reviewer = service(testRoot, 'reviewer');
    try {
      const input: CreateCollaborationGroupInput = {
        remoteUrl,
        name: 'Two role group',
        groupId: 'ag_two_roles',
        signingKeyPath: key(testRoot, 'alice-key'),
        capabilities: ['coding_task'],
        initialRole: 'developer',
        ...twoRoleSkeleton(),
      };
      const created = await owner.groupService.createGroup(input);
      await expect(
        owner.groupService.publishStateImplementation({
          groupId: 'ag_two_roles',
          stateId: 'review',
          mode: 'manual',
          expectedRevision: created.projection!.revision,
        }),
      ).rejects.toThrow(/does not hold its role|current role owner/i);

      const joined = await reviewer.groupService.joinGroup({
        remoteUrl,
        signingKeyPath: key(testRoot, 'bob-key'),
        capabilities: ['review_task'],
        role: 'reviewer',
      });
      const reviewed = await reviewer.groupService.publishStateImplementation({
        groupId: 'ag_two_roles',
        stateId: 'review',
        mode: 'manual',
        expectedRevision: joined.projection!.revision,
      });
      expect(
        reviewed.projection!.stateImplementations.review?.implementation.owner,
      ).toMatchObject({
        principal_id: reviewed.localPrincipalId,
        agent_id: reviewed.localAgentId,
      });
    } finally {
      owner.store.close();
      reviewer.store.close();
    }
  }, 30_000);

  it.each([
    { command: 'pause' as const, lifecycle: 'PAUSED' },
    { command: 'close' as const, lifecycle: 'CLOSED' },
  ])(
    '$command cancels a PENDING_START turn and reaches $lifecycle',
    async ({ command, lifecycle }) => {
      const testRoot = root();
      const remoteUrl = remote(testRoot);
      const owner = service(testRoot, `owner-${command}`);
      try {
        const created = await owner.groupService.createGroup(
          createInput(remoteUrl, key(testRoot, `${command}-key`)),
        );
        const ready = await owner.groupService.publishStateImplementation({
          groupId: 'ag_service',
          stateId: 'development',
          mode: 'manual',
          expectedRevision: created.projection!.revision,
        });
        const started = await owner.groupService.start(
          'ag_service',
          ready.projection!.revision,
        );
        const turnId = started.projection!.activeTurnId!;
        const finished =
          command === 'pause'
            ? await owner.groupService.pause(
                'ag_service',
                started.projection!.revision,
              )
            : await owner.groupService.close(
                'ag_service',
                'Creator closed before work started',
                started.projection!.revision,
              );
        expect(finished.lifecycle).toBe(lifecycle);
        expect(finished.projection!.activeTurnId).toBeNull();
        expect(finished.projection!.turns[turnId]).toMatchObject({
          state: 'CANCELLED',
          fencingToken: null,
        });
      } finally {
        owner.store.close();
      }
    },
    30_000,
  );

  it('makes a released Role implementation inactive and returns to FORMING', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner-release');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, key(testRoot, 'release-key')),
      );
      const ready = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: created.projection!.revision,
      });
      expect(ready.lifecycle).toBe('READY');

      const released = await owner.groupService.releaseRole(
        'ag_service',
        'developer',
        ready.projection!.revision,
      );
      expect(released.lifecycle).toBe('FORMING');
      expect(released.projection!.roleClaims.developer).toEqual([]);
      expect(
        released.projection!.stateImplementations.development?.implementation
          .owner,
      ).toEqual({
        principal_id: released.localPrincipalId,
        agent_id: released.localAgentId,
      });
      expect(
        released.projection!.stateImplementations.development?.active,
      ).toBe(false);

      const reclaimed = await owner.groupService.claimRole(
        'ag_service',
        'developer',
      );
      expect(reclaimed.lifecycle).toBe('FORMING');
      expect(
        reclaimed.projection!.stateImplementations.development?.active,
      ).toBe(false);

      const readopted = await owner.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: reclaimed.projection!.revision,
      });
      expect(readopted.lifecycle).toBe('READY');
      expect(
        readopted.projection!.stateImplementations.development?.active,
      ).toBe(true);
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('materializes Artifact bytes atomically with completion and retains staged uploads after a stale revision', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const prepared = await prepareManualTurn(
        owner.groupService,
        remoteUrl,
        key(testRoot, 'alice-key'),
      );
      const uploadPath = path.join(testRoot, 'upload.txt');
      writeFileSync(uploadPath, 'signed artifact\n');
      const artifact = owner.groupService.stageArtifact({
        groupId: 'ag_service',
        turnId: prepared.turnId,
        originalName: '../unsafe name.txt',
        contentType: 'text/plain',
        stagedPath: uploadPath,
      });
      expect(artifact.repositoryPath).toMatch(
        new RegExp(`^artifacts/${prepared.turnId}/artifact_`),
      );
      await expect(
        owner.groupService.completeTurn({
          groupId: 'ag_service',
          turnId: prepared.turnId,
          expectedRevision: prepared.started.projection!.revision,
          outcome: 'completed',
          summary: 'Stale completion.',
          artifactIds: [artifact.artifactId],
        }),
      ).rejects.toThrow(/Expected revision/);
      expect(existsSync(uploadPath)).toBe(true);
      expect(owner.store.getStagedArtifact(artifact.artifactId)?.state).toBe(
        'staged',
      );

      const completed = await owner.groupService.completeTurn({
        groupId: 'ag_service',
        turnId: prepared.turnId,
        expectedRevision:
          owner.store.getGroup('ag_service')!.projection!.revision,
        outcome: 'completed',
        summary: 'Artifact committed.',
        artifactIds: [artifact.artifactId],
      });
      expect(existsSync(uploadPath)).toBe(false);
      expect(owner.store.getStagedArtifact(artifact.artifactId)).toMatchObject({
        state: 'committed',
      });
      expect(
        execFileSync(
          'git',
          ['show', `${completed.headCommit!}:${artifact.repositoryPath}`],
          { cwd: completed.repositoryPath, encoding: 'utf8' },
        ),
      ).toBe('signed artifact\n');
      expect(
        completed.projection!.turns[prepared.turnId]!.handoff?.artifact_refs,
      ).toEqual([artifact.repositoryPath]);
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('rejects artifacts staged by an obsolete claimant attempt', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const prepared = await prepareManualTurn(
        owner.groupService,
        remoteUrl,
        key(testRoot, 'alice-key'),
      );
      const uploadPath = path.join(testRoot, 'obsolete.txt');
      writeFileSync(uploadPath, 'obsolete\n');
      const artifact = owner.groupService.stageArtifact({
        groupId: 'ag_service',
        turnId: prepared.turnId,
        originalName: 'obsolete.txt',
        contentType: 'text/plain',
        stagedPath: uploadPath,
      });
      const recovered = await owner.groupService.recoverTurn(
        'ag_service',
        'Claimant restarted',
        owner.store.getGroup('ag_service')!.projection!.revision,
      );
      const restarted = await owner.groupService.startCurrentTurn(
        'ag_service',
        recovered.projection!.revision,
      );
      await expect(
        owner.groupService.completeTurn({
          groupId: 'ag_service',
          turnId: prepared.turnId,
          expectedRevision: restarted.history.projection.revision,
          outcome: 'completed',
          summary: 'Must reject obsolete upload.',
          artifactIds: [artifact.artifactId],
        }),
      ).rejects.toThrow(/current claimant attempt/);
      expect(existsSync(uploadPath)).toBe(true);
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('allows exactly one CAS winner when the same local identity starts concurrently', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const sharedIdentity = path.join(testRoot, 'shared-identity');
    const first = service(testRoot, 'first', sharedIdentity);
    const second = service(testRoot, 'second', sharedIdentity);
    const signingKeyPath = key(testRoot, 'alice-key');
    try {
      const created = await first.groupService.createGroup(
        createInput(remoteUrl, signingKeyPath),
      );
      const ready = await first.groupService.publishStateImplementation({
        groupId: 'ag_service',
        stateId: 'development',
        mode: 'manual',
        expectedRevision: created.projection!.revision,
      });
      const started = await first.groupService.start(
        'ag_service',
        ready.projection!.revision,
      );
      await second.groupService.joinGroup({
        remoteUrl,
        signingKeyPath,
        capabilities: ['coding_task'],
        role: 'developer',
      });
      const results = await Promise.all([
        first.groupService.startCurrentTurn(
          'ag_service',
          started.projection!.revision,
        ),
        second.groupService.startCurrentTurn(
          'ag_service',
          started.projection!.revision,
        ),
      ]);
      expect(results.filter((result) => result.won)).toHaveLength(1);
      expect(results.filter((result) => !result.won)).toHaveLength(1);
      const synchronized = await first.groupService.sync('ag_service');
      const turn =
        synchronized.projection!.turns[synchronized.projection!.activeTurnId!]!;
      expect(turn).toMatchObject({
        state: 'IN_PROGRESS',
        claimantPrincipalId: synchronized.localPrincipalId,
        claimantAgentId: synchronized.localAgentId,
        attempt: 1,
        fencingToken: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    } finally {
      first.store.close();
      second.store.close();
    }
  }, 40_000);

  it('rejects stale revisions and arbitrary outcomes without modifying shared state', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const prepared = await prepareManualTurn(
        owner.groupService,
        remoteUrl,
        key(testRoot, 'alice-key'),
      );
      const currentRevision =
        owner.store.getGroup('ag_service')!.projection!.revision;
      await expect(
        owner.groupService.completeTurn({
          groupId: 'ag_service',
          turnId: prepared.turnId,
          expectedRevision: currentRevision - 1,
          outcome: 'completed',
          summary: 'Stale.',
        }),
      ).rejects.toThrow(/Expected revision/);
      await expect(
        owner.groupService.completeTurn({
          groupId: 'ag_service',
          turnId: prepared.turnId,
          expectedRevision: currentRevision,
          outcome: 'arbitrary_target',
          summary: 'Illegal route.',
        }),
      ).rejects.toThrow(/Outcome is not allowed/);
      const synchronized = await owner.groupService.sync('ag_service');
      expect(synchronized.projection).toMatchObject({
        revision: currentRevision,
        businessState: 'development',
        activeTurnId: prepared.turnId,
      });
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('writes bounded shared data through a revision-fenced signed event', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, key(testRoot, 'alice-key')),
      );
      const result = await owner.groupService.updateData({
        groupId: 'ag_service',
        path: 'notes/status.txt',
        content: 'ready for review\n',
        mediaType: 'text/plain',
        expectedRevision: created.projection!.revision,
      });
      expect(result).toMatchObject({
        path: 'data/notes/status.txt',
        sizeBytes: 17,
        contentSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(
        execFileSync(
          'git',
          ['show', `${result.group.headCommit!}:data/notes/status.txt`],
          { cwd: result.group.repositoryPath, encoding: 'utf8' },
        ),
      ).toBe('ready for review\n');
      await expect(
        owner.groupService.updateData({
          groupId: 'ag_service',
          path: '../escape.txt',
          content: 'unsafe',
          expectedRevision: result.group.projection!.revision,
        }),
      ).rejects.toThrow(/data path|normalized|unsafe/i);
      await expect(
        owner.groupService.updateData({
          groupId: 'ag_service',
          path: 'too-large.txt',
          content: 'x'.repeat(1024 * 1024 + 1),
          expectedRevision: result.group.projection!.revision,
        }),
      ).rejects.toThrow(/exceeds the 1 MiB limit/i);
    } finally {
      owner.store.close();
    }
  }, 30_000);

  it('resumes incremental validation from the persisted projection after restart', async () => {
    const testRoot = root();
    const remoteUrl = remote(testRoot);
    const owner = service(testRoot, 'owner');
    try {
      const created = await owner.groupService.createGroup(
        createInput(remoteUrl, key(testRoot, 'alice-key')),
      );
      const restarted = new CollaborationGroupService(
        owner.store,
        new CollaborationGitTransport(),
        path.join(testRoot, 'owner-repositories'),
        owner.identities,
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
  }, 30_000);
});
