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
});
