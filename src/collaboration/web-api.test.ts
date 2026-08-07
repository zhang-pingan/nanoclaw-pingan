import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type {
  CollaborationActionExecutionV3,
  CollaborationExecutorBindingV3,
  CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';
import type { CollaborationRuntime } from './runtime.js';
import { CollaborationWebApi } from './web-api.js';

const hash = (value: string) => `sha256:${value.repeat(64)}`;

function projection(): CollaborationProjectionV3 {
  return {
    workItems: {
      work_1: { work_item_id: 'work_1', title: 'Ship v3', revision: 2 },
    },
    workItemUpdates: { work_1: [] },
    discussions: {},
    workflowDefinitions: {},
    latestWorkflowDefinitionVersions: {},
    workflowInstances: {},
    stateExecutions: {},
    turns: {},
    activity: [],
    members: {},
    clients: {},
    executors: {},
    permissionGrants: {},
  } as unknown as CollaborationProjectionV3;
}

function group(
  subscriptionMode: 'observer' | 'member' = 'member',
): CollaborationProjectSpaceGroupRecord {
  return {
    groupId: 'group_test',
    name: 'Test project',
    lifecycle: 'active',
    ownerPrincipalId: 'principal_alice',
    subscriptionMode,
    localPrincipalId: subscriptionMode === 'member' ? 'principal_alice' : null,
    localClientId: subscriptionMode === 'member' ? 'client_alice' : null,
    remoteUrl:
      'https://private-token@example.test/group.git?access_token=query-secret&ref=main',
    repositoryPath: '/private/collaboration/repository.git',
    signingKeyPath:
      subscriptionMode === 'member' ? '/private/keys/id_ed25519' : null,
    signingPublicKey: null,
    signingKeyRef: null,
    protocolStatus: 'verified',
    protocolError:
      'fetch https://private-token@example.test/group.git?access_token=query-secret failed',
    projection: projection(),
    pollIntervalMs: 60_000,
    nextSyncAtMs: 0,
    lastVerifiedHead: 'a'.repeat(40),
    lastSyncAtMs: 1,
    lastError: null,
    backoffAttempt: 0,
  };
}

function binding(): CollaborationExecutorBindingV3 {
  return {
    groupId: 'group_test',
    instanceId: 'instance_1',
    stateId: 'implementation',
    principalId: 'principal_alice',
    clientId: 'client_alice',
    actionHash: hash('a'),
    promptHash: hash('p'),
    executorId: 'executor_1',
    executorKind: 'external',
    workspacePath: '/private/workspace',
    filesystemAccess: 'workspace_write',
    approvalPolicy: 'on-request',
    config: {
      adapter: 'codex-task',
      api_token: 'provider-secret',
      nested: { harmless: 'visible' },
    },
    enabled: true,
    updatedAtMs: 1,
  };
}

function execution(): CollaborationActionExecutionV3 {
  return {
    executionId: 'execution_1',
    groupId: 'group_test',
    instanceId: 'instance_1',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    claimantClientId: 'client_alice',
    fencingToken: hash('f'),
    operationKey: hash('k'),
    executorId: 'executor_1',
    executorKind: 'external',
    state: 'running',
    executionRef: 'provider:secret-ref',
    providerMetadata: { provider_secret: 'must-not-leak' },
    receipt: { token: 'must-not-leak' },
    observation: null,
    recoveryRequiredReason: null,
    dispatchStartedAtMs: 1,
    receiptRecordedAtMs: 2,
    providerCompletedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function runtime(
  input: {
    selectedGroup?: CollaborationProjectSpaceGroupRecord;
    groups?: Record<string, unknown>;
    store?: Record<string, unknown>;
  } = {},
): CollaborationRuntime {
  const selectedGroup = input.selectedGroup ?? group();
  return {
    status: vi.fn(() => ({
      available: true,
      protocolVersion: 3,
      error: null,
      scheduler: { running: true },
    })),
    databasePath: '/private/collaboration.db',
    store: {
      getGroup: vi.fn(() => selectedGroup),
      listGroups: vi.fn(() => [selectedGroup]),
      listExecutorBindings: vi.fn(() => []),
      listActionExecutions: vi.fn(() => []),
      listPendingNotifications: vi.fn(() => []),
      ...input.store,
    },
    groups: { ...input.groups },
  } as unknown as CollaborationRuntime;
}

async function withApiServer(
  api: CollaborationWebApi,
  work: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    void api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try {
    await work(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('Collaboration project-space v3 Web API', () => {
  it('returns current-only status and redacts local/provider secrets', async () => {
    const selected = runtime({
      store: {
        listExecutorBindings: vi.fn(() => [binding()]),
        listActionExecutions: vi.fn(() => [execution()]),
      },
    });
    await withApiServer(new CollaborationWebApi(selected), async (baseUrl) => {
      const status = await fetch(`${baseUrl}/api/collaboration/status`);
      expect(await status.json()).toMatchObject({
        collaboration: { available: true, protocolVersion: 3 },
      });

      const response = await fetch(
        `${baseUrl}/api/collaboration/groups/group_test`,
      );
      const body = (await response.json()) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      expect(response.status).toBe(200);
      expect(serialized).not.toContain('/private/');
      expect(serialized).not.toContain('private-token');
      expect(serialized).not.toContain('query-secret');
      expect(serialized).not.toContain('provider-secret');
      expect(serialized).not.toContain('must-not-leak');
      expect(serialized).toContain('redacted');
      expect(body).not.toHaveProperty('repositoryPath');
    });
  });

  it('rejects Host-derived identity fields and duplicate JSON keys', async () => {
    const createGroup = vi.fn();
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { createGroup } })),
      async (baseUrl) => {
        const override = await fetch(`${baseUrl}/api/collaboration/groups`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actorPrincipalId: 'principal_attacker' }),
        });
        expect(override.status).toBe(400);
        expect(await override.json()).toMatchObject({
          error: expect.stringMatching(/Host-derived/),
        });

        const duplicate = await fetch(
          `${baseUrl}/api/collaboration/groups/inspect`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"remoteUrl":"first","remoteUrl":"second"}',
          },
        );
        expect(duplicate.status).toBe(400);
        expect(await duplicate.json()).toMatchObject({
          error: expect.stringMatching(/duplicate/i),
        });
        expect(createGroup).not.toHaveBeenCalled();
      },
    );
  });

  it('routes targeted Invite issuance, revocation, and join references', async () => {
    const joinGroup = vi.fn(async () => group());
    const issueInvite = vi.fn(async () => group());
    const revokeInvite = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({ groups: { joinGroup, issueInvite, revokeInvite } }),
      ),
      async (baseUrl) => {
        const headers = { 'content-type': 'application/json' };
        const issued = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/invites`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              principalId: 'principal_bob',
              expiresAt: '2026-08-08T12:00:00.000Z',
              expectedRevision: 0,
            }),
          },
        );
        expect(issued.status).toBe(201);
        expect(issueInvite).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'group_test',
            principalId: 'principal_bob',
          }),
        );

        const joined = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/join-requests`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              signingKeyPath: '/tmp/bob',
              displayName: 'Bob',
              clientDisplayName: 'Bob MacBook',
              inviteId: 'invite_bob',
            }),
          },
        );
        expect(joined.status).toBe(201);
        expect(joinGroup).toHaveBeenCalledWith(
          expect.objectContaining({ inviteId: 'invite_bob' }),
        );

        const revoked = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/invites/invite_bob/revoke`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ expectedRevision: 1, reason: 'Expired' }),
          },
        );
        expect(revoked.status).toBe(200);
        expect(revokeInvite).toHaveBeenCalledWith({
          groupId: 'group_test',
          inviteId: 'invite_bob',
          expectedRevision: 1,
          reason: 'Expired',
        });
      },
    );
  });

  it('routes membership decisions and continuous Workflow Turn commands', async () => {
    const approveMembership = vi.fn(async () => group());
    const rejectMembership = vi.fn(async () => group());
    const createTurn = vi.fn(async () => group());
    const startTurn = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            approveMembership,
            rejectMembership,
            createTurn,
            startTurn,
          },
        }),
      ),
      async (baseUrl) => {
        const post = (path: string, body: Record<string, unknown>) =>
          fetch(`${baseUrl}/api/collaboration${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        expect(
          (
            await post(
              '/groups/group_test/join-requests/principal_bob/approve',
              {
                expectedRevision: 1,
              },
            )
          ).status,
        ).toBe(200);
        expect(approveMembership).toHaveBeenCalledWith(
          'group_test',
          'principal_bob',
          1,
        );
        expect(
          (
            await post(
              '/groups/group_test/join-requests/principal_bob/reject',
              {
                expectedRevision: 2,
                reason: 'Identity not verified',
              },
            )
          ).status,
        ).toBe(200);
        expect(rejectMembership).toHaveBeenCalledWith(
          'group_test',
          'principal_bob',
          'Identity not verified',
          2,
        );

        expect(
          (
            await post(
              '/groups/group_test/workflow-instances/instance_1/commands',
              { expectedRevision: 3, command: 'create_turn' },
            )
          ).status,
        ).toBe(200);
        expect(createTurn).toHaveBeenCalledWith({
          groupId: 'group_test',
          instanceId: 'instance_1',
          expectedRevision: 3,
          turnId: undefined,
        });
        expect(
          (
            await post(
              '/groups/group_test/workflow-instances/instance_1/turns/turn_1/start',
              { expectedRevision: 4, executorId: 'executor_codex' },
            )
          ).status,
        ).toBe(200);
        expect(startTurn).toHaveBeenCalledWith({
          groupId: 'group_test',
          instanceId: 'instance_1',
          turnId: 'turn_1',
          expectedRevision: 4,
          executorId: 'executor_codex',
        });
      },
    );
  });

  it('keeps Observer reads available while mutation authorization fails closed', async () => {
    const createWorkItem = vi.fn(async () => {
      throw new Error('Observer subscription is read-only');
    });
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          selectedGroup: group('observer'),
          groups: { createWorkItem },
        }),
      ),
      async (baseUrl) => {
        const read = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/work-items`,
        );
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({
          workItems: [{ work_item_id: 'work_1' }],
        });

        const write = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/work-items`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'task', title: 'Unauthorized' }),
          },
        );
        expect(write.status).toBe(400);
        expect(await write.json()).toMatchObject({
          error: 'Observer subscription is read-only',
        });
      },
    );
  });

  it('accepts raw multipart business files with validated JSON metadata', async () => {
    const publishSharedFile = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { publishSharedFile } })),
      async (baseUrl) => {
        const form = new FormData();
        form.append(
          'metadata',
          new Blob([
            JSON.stringify({
              expectedRevision: 0,
              fileName: 'evidence.pdf',
              mediaType: 'application/pdf',
            }),
          ]),
        );
        form.append(
          'file',
          new Blob([Buffer.from('%PDF-1.7\nraw\n')], {
            type: 'application/pdf',
          }),
          'evidence.pdf',
        );
        const response = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/workspace/shared/files`,
          { method: 'POST', body: form },
        );
        expect(response.status).toBe(201);
        expect(publishSharedFile).toHaveBeenCalledWith({
          groupId: 'group_test',
          expectedRevision: 0,
          fileName: 'evidence.pdf',
          mediaType: 'application/pdf',
          contents: Buffer.from('%PDF-1.7\nraw\n'),
        });
      },
    );
  });

  it('maps per-Aggregate revision conflicts to 409', async () => {
    const updateWorkItemDetails = vi.fn(async () => {
      throw new Error('Work Item revision conflict: expected 1, current 2');
    });
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { updateWorkItemDetails } })),
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/work-items/work_1`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 1, title: 'Stale' }),
          },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: expect.stringMatching(/revision conflict/),
        });
      },
    );
  });

  it('validates Discussion and Outcome-first Workflow commands before dispatch', async () => {
    const createDiscussion = vi.fn(async () => group());
    const proposeWorkflowDefinition = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({ groups: { createDiscussion, proposeWorkflowDefinition } }),
      ),
      async (baseUrl) => {
        const discussion = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/discussions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title: 'Release decision',
              scope: { type: 'group' },
            }),
          },
        );
        expect(discussion.status).toBe(201);
        expect(createDiscussion).toHaveBeenCalledWith(
          expect.objectContaining({ groupId: 'group_test' }),
        );

        const workflow = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/workflow-definitions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              definitionId: 'delivery',
              expectedRevision: 0,
              version: 1,
              name: 'Delivery',
              machine: {
                format: 'icarus.collaboration-machine/3',
                initial_state: 'build',
                states: {
                  build: {
                    label: 'Build',
                    description: '',
                    assignee: { type: 'participant_slot', slot: 'builder' },
                    terminal: false,
                    timeout_policy: null,
                    transitions: [
                      {
                        outcome: 'done',
                        label: 'Done',
                        target_state: 'shipped',
                      },
                    ],
                  },
                  shipped: {
                    label: 'Shipped',
                    description: '',
                    terminal: true,
                    transitions: [],
                  },
                },
              },
              layout: {
                format: 'icarus.collaboration-workflow-layout/1',
                view: 'participants',
                nodes: { build: { x: 10, y: 20 }, shipped: { x: 300, y: 20 } },
                revision: 1,
              },
            }),
          },
        );
        expect(workflow.status).toBe(201);
        expect(proposeWorkflowDefinition).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'group_test',
            machine: expect.objectContaining({
              format: 'icarus.collaboration-machine/3',
            }),
          }),
        );
      },
    );
  });

  it('exposes the remaining explicit v3 lifecycle and ownership commands', async () => {
    const groups = Object.fromEntries(
      [
        'reopenGroup',
        'registerCurrentClient',
        'answerWorkItemAssignment',
        'archiveWorkItem',
        'setDiscussionResolved',
        'retireWorkflowDefinition',
        'reassignWorkflowState',
        'withdrawStateExecution',
        'cancelTurn',
      ].map((name) => [name, vi.fn(async () => group())]),
    );
    await withApiServer(
      new CollaborationWebApi(runtime({ groups })),
      async (baseUrl) => {
        const commands = [
          [
            '/groups/group_test/reopen',
            { expectedRevision: 2, reason: 'resume' },
          ],
          [
            '/groups/group_test/clients',
            {
              expectedRevision: 1,
              displayName: 'Alice MacBook',
              capabilities: ['desktop_notifications'],
            },
          ],
          [
            '/groups/group_test/work-items/work_1/assignment/acknowledge',
            { expectedRevision: 2 },
          ],
          [
            '/groups/group_test/work-items/work_1/assignment/decline',
            { expectedRevision: 3, reason: 'capacity' },
          ],
          [
            '/groups/group_test/work-items/work_1/archive',
            { expectedRevision: 4, reason: 'superseded' },
          ],
          [
            '/groups/group_test/discussions/thread_1/reopen',
            { expectedRevision: 2 },
          ],
          [
            '/groups/group_test/workflow-definitions/delivery/retire',
            { expectedRevision: 3, reason: 'replaced' },
          ],
          [
            '/groups/group_test/workflow-instances/instance_1/reassign',
            {
              expectedRevision: 2,
              stateId: 'implementation',
              principalId: 'principal_bob',
            },
          ],
          [
            '/groups/group_test/workflow-instances/instance_1/states/implementation/execution/withdraw',
            { expectedRevision: 3 },
          ],
          [
            '/groups/group_test/workflow-instances/instance_1/turns/turn_1/cancel',
            {
              expectedRevision: 4,
              attempt: 1,
              fencingToken: hash('f'),
              reason: 'cancelled by owner',
            },
          ],
        ] as const;
        for (const [route, body] of commands) {
          const response = await fetch(`${baseUrl}/api/collaboration${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(response.status, route).toBeLessThan(300);
        }
        expect(groups.registerCurrentClient).toHaveBeenCalledWith({
          groupId: 'group_test',
          expectedRevision: 1,
          displayName: 'Alice MacBook',
          capabilities: ['desktop_notifications'],
        });
        expect(groups.answerWorkItemAssignment).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ accepted: false, reason: 'capacity' }),
        );
        expect(groups.setDiscussionResolved).toHaveBeenCalledWith(
          expect.objectContaining({ resolved: false }),
        );
      },
    );
  });

  it('stages scoped Artifact bytes and forwards ids to progress and completion', async () => {
    const workArtifact = {
      metadata: { artifact_id: 'artifact_work' },
      artifactRef: 'artifacts/work-items/work_1/artifact_work/metadata.json',
    };
    const turnArtifact = {
      metadata: { artifact_id: 'artifact_turn' },
      artifactRef:
        'artifacts/workflows/instance_1/turn_1/artifact_turn/metadata.json',
    };
    const stageWorkItemArtifact = vi.fn(async () => workArtifact);
    const stageTurnArtifact = vi.fn(async () => turnArtifact);
    const postWorkItemProgress = vi.fn(async () => group());
    const completeTurn = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            stageWorkItemArtifact,
            stageTurnArtifact,
            postWorkItemProgress,
            completeTurn,
          },
        }),
      ),
      async (baseUrl) => {
        const workUpload = new FormData();
        workUpload.append(
          'metadata',
          new Blob([
            JSON.stringify({
              fileName: 'evidence.pdf',
              mediaType: 'application/pdf',
            }),
          ]),
        );
        workUpload.append('file', new Blob(['work-bytes']), 'evidence.pdf');
        const stagedWork = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/work-items/work_1/artifacts`,
          { method: 'POST', body: workUpload },
        );
        expect(stagedWork.status).toBe(201);
        expect(stageWorkItemArtifact).toHaveBeenCalledWith(
          expect.objectContaining({
            workItemId: 'work_1',
            contents: Buffer.from('work-bytes'),
          }),
        );

        const workProgress = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/work-items/work_1/progress`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: 2,
              summary: 'Evidence ready',
              artifactIds: ['artifact_work'],
            }),
          },
        );
        expect(workProgress.status).toBe(201);
        expect(postWorkItemProgress).toHaveBeenCalledWith(
          expect.objectContaining({ artifactIds: ['artifact_work'] }),
        );

        const turnUpload = new FormData();
        turnUpload.append(
          'metadata',
          new Blob([
            JSON.stringify({
              attempt: 1,
              fencingToken: hash('f'),
              fileName: 'result.txt',
              mediaType: 'text/plain',
            }),
          ]),
        );
        turnUpload.append('file', new Blob(['turn-bytes']), 'result.txt');
        const stagedTurn = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/workflow-instances/instance_1/turns/turn_1/artifacts`,
          { method: 'POST', body: turnUpload },
        );
        expect(stagedTurn.status).toBe(201);
        expect(stageTurnArtifact).toHaveBeenCalledWith(
          expect.objectContaining({
            turnId: 'turn_1',
            attempt: 1,
            fencingToken: hash('f'),
            contents: Buffer.from('turn-bytes'),
          }),
        );

        const completed = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/workflow-instances/instance_1/turns/turn_1/complete`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: 4,
              attempt: 1,
              fencingToken: hash('f'),
              outcome: 'done',
              summary: 'Completed',
              artifactIds: ['artifact_turn'],
            }),
          },
        );
        expect(completed.status).toBe(200);
        expect(completeTurn).toHaveBeenCalledWith(
          expect.objectContaining({ artifactIds: ['artifact_turn'] }),
        );
      },
    );
  });

  it('rejects a non-manual execution without Binding before publishing', async () => {
    const publishStateExecution = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { publishStateExecution } })),
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/workflow-instances/instance_1/states/implementation/execution`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: 2,
              mode: 'automatic',
              actionId: 'build',
            }),
          },
        );
        expect(response.status).toBe(400);
        expect(publishStateExecution).not.toHaveBeenCalled();
      },
    );
  });
});
