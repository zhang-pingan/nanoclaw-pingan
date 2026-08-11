import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { CollaborationAnalysisRunDetail } from './analysis-service.js';
import type {
  CollaborationActionExecutionV3,
  CollaborationExecutorBindingV3,
  CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import { CollaborationProjectSpaceGitConflictError } from './project-space-git.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';
import type { CollaborationRuntime } from './runtime.js';
import { CollaborationProtocolError } from './protocol/version.js';
import { CollaborationWebApi } from './web-api.js';

const hash = (value: string) => `sha256:${value.repeat(64)}`;

function projection(): CollaborationProjectionV3 {
  return {
    format: 'icarus.collaboration-projection/3',
    protocolVersion: 3,
    groupId: 'group_test',
    aggregateHeads: {},
    invites: {},
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
    members: {
      principal_alice: {
        principal_id: 'principal_alice',
        display_name: 'Alice',
        status: 'active',
      },
    },
    clients: {
      principal_alice: {
        client_alice: {
          client_id: 'client_alice',
          display_name: 'Alice MacBook',
          status: 'active',
        },
      },
    },
    credentials: {
      principal_alice: {
        credential_alice: {
          credential_id: 'credential_alice',
          principal_id: 'principal_alice',
          client_id: 'client_alice',
          public_key: 'ssh-ed25519 AAAA-public-verification-material',
          fingerprint: 'SHA256:publicFingerprint',
          purpose: 'event_signing',
          status: 'active',
        },
      },
    },
    recoveryRequests: {
      recovery_phone: {
        request_id: 'recovery_phone',
        request_hash: `sha256:${'1'.repeat(64)}`,
        type: 'identity_recovery',
        target_principal_id: 'principal_alice',
        status: 'pending',
      },
    },
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
    gitSshKeyPath: '/private/keys/id_ed25519',
    localCredentialId:
      subscriptionMode === 'member' ? 'credential_alice' : null,
    eventPrivateKeyPath:
      subscriptionMode === 'member' ? '/private/keys/event' : null,
    eventPublicKey: null,
    eventFingerprint: null,
    recoveryCredentialId: null,
    recoveryPrivateKeyPath: null,
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

function analysisDetail(): CollaborationAnalysisRunDetail {
  return {
    run: {
      analysisId: 'analysis_1',
      groupId: 'group_test',
      principalId: 'principal_alice',
      clientId: 'client_alice',
      subscriptionMode: 'member',
      snapshotHead: 'a'.repeat(40),
      scope: { type: 'project' },
      trigger: 'manual',
      executionChannel: 'external_agent',
      executorId: null,
      executorKind: null,
      contractVersion: 1,
      capabilityVersion: 1,
      contextHash: hash('c'),
      promptHash: hash('p'),
      challenge: 'challenge-must-not-leak-1234567890',
      status: 'ready_for_review',
      staleFromStatus: null,
      attempt: 1,
      operationKey: hash('o'),
      executionRef: 'provider:secret-execution-ref',
      providerMetadata: { api_token: 'run-provider-secret' },
      validationErrors: [],
      error:
        'fetch https://private-token@example.test/result?access_token=run-secret failed',
      createdAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 3,
      updatedAtMs: 4,
    },
    stale: false,
    result: {
      resultId: 'result_1',
      analysisId: 'analysis_1',
      attempt: 1,
      rawJson: '{"api_token":"raw-result-secret"}',
      rawHash: hash('r'),
      normalized: null,
      validationErrors: [],
      providerMetadata: { provider_secret: 'result-provider-secret' },
      receivedAtMs: 3,
    },
    results: [],
    findings: [
      {
        analysisId: 'analysis_1',
        findingId: 'finding_1',
        groupId: 'group_test',
        dedupeKey: hash('d'),
        lifecycle: 'new',
        finding: {
          finding_id: 'finding_1',
          kind: 'fact',
          category: 'delivery_risk',
          severity: 'high',
          confidence: 0.9,
          title: 'Delivery is blocked',
          summary: 'The current Work Item has an unresolved blocker.',
          affected_refs: ['work_item:work_1'],
          evidence_refs: ['work_item:work_1'],
          recommendations: ['Resolve the blocker.'],
          proposed_actions: [],
        },
        decision: null,
        decisionReason: null,
        decidedAtMs: null,
        createdAtMs: 3,
        updatedAtMs: 3,
      },
    ],
    applications: [
      {
        applicationId: 'application_1',
        operationKey: hash('k'),
        analysisId: 'analysis_1',
        findingId: 'finding_1',
        actionOrdinal: 0,
        action: {
          action: 'watch_work_item',
          parameters: { work_item_id: 'work_1' },
        },
        preview: { label: 'Watch Work Item' },
        state: 'previewed',
        snapshotHead: 'a'.repeat(40),
        confirmationTokenHash: hash('t'),
        confirmedAtMs: null,
        resultingEventIds: [],
        error: 'failed at /private/analysis/provider-secret',
        createdAtMs: 3,
        updatedAtMs: 3,
      },
    ],
    exportScope: { scope: { type: 'project' }, file_count: 0 },
    allowedActionTypes: [
      'create_work_item',
      'open_discussion',
      'post_progress',
      'watch_work_item',
      'request_information',
      'publish_analysis_report',
    ],
    repairPrompt: null,
  };
}

function runtime(
  input: {
    selectedGroup?: CollaborationProjectSpaceGroupRecord;
    groups?: Record<string, unknown>;
    store?: Record<string, unknown>;
    analysis?: Record<string, unknown>;
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
      listLocalExecutors: vi.fn(() => []),
      listActionExecutions: vi.fn(() => []),
      listPendingNotifications: vi.fn(() => []),
      ...input.store,
    },
    groups: { ...input.groups },
    analysis: { ...input.analysis },
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
      expect(
        (
          body.group as {
            gitRemoteAccess: { sshKeyPath: string };
          }
        ).gitRemoteAccess.sshKeyPath,
      ).toBe('/private/keys/id_ed25519');
      expect(serialized).not.toContain('/private/collaboration');
      expect(serialized).not.toContain('private-token');
      expect(serialized).not.toContain('query-secret');
      expect(serialized).not.toContain('provider-secret');
      expect(serialized).not.toContain('must-not-leak');
      expect(serialized).toContain('redacted');
      expect(body).not.toHaveProperty('repositoryPath');
      expect(body).toMatchObject({
        group: {
          icarusIdentity: {
            principalId: 'principal_alice',
            clientId: 'client_alice',
            credentialId: 'credential_alice',
            recoveryCredentialAvailable: false,
          },
        },
      });
    });
  });

  it('uses the Host default for create and the observed SSH key for join', async () => {
    const createGroup = vi.fn(async (_input: Record<string, unknown>) =>
      group(),
    );
    const joinGroup = vi.fn(async (_input: Record<string, unknown>) => group());
    const observeGroup = vi.fn(async (_input: Record<string, unknown>) =>
      group('observer'),
    );
    await withApiServer(
      new CollaborationWebApi(
        runtime({ groups: { createGroup, joinGroup, observeGroup } }),
      ),
      async (baseUrl) => {
        const headers = { 'content-type': 'application/json' };
        const created = await fetch(`${baseUrl}/api/collaboration/groups`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            remoteUrl: '/tmp/default-key.git',
            name: 'Default key project',
            displayName: 'Alice',
            clientDisplayName: 'Alice MacBook',
            membershipPolicy: 'approval',
            observerAccess: 'allowed',
          }),
        });
        expect(created.status).toBe(201);
        expect(createGroup.mock.calls[0]?.[0]).not.toHaveProperty(
          'signingKeyPath',
        );

        const joined = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/join-requests`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              displayName: 'Bob',
              clientDisplayName: 'Bob MacBook',
            }),
          },
        );
        expect(joined.status).toBe(201);
        expect(joinGroup).toHaveBeenCalledWith({
          remoteUrl: group().remoteUrl,
          gitSshKeyPath: '/private/keys/id_ed25519',
          displayName: 'Bob',
          clientDisplayName: 'Bob MacBook',
        });

        const observed = await fetch(
          `${baseUrl}/api/collaboration/subscriptions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              remoteUrl: '/tmp/observed.git',
              gitSshKeyPath: '~/keys/git-remote',
            }),
          },
        );
        expect(observed.status).toBe(201);
        expect(observeGroup).toHaveBeenCalledWith({
          remoteUrl: '/tmp/observed.git',
          gitSshKeyPath: '~/keys/git-remote',
        });
      },
    );
  });

  it('routes initialization without accepting caller-controlled replacement fields', async () => {
    const initializeGroup = vi.fn(async () => ({
      ...group(),
      groupId: 'group_initialized',
    }));
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { initializeGroup } })),
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/initialize`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          previousGroupId: 'group_test',
          group: { groupId: 'group_initialized' },
        });
        expect(initializeGroup).toHaveBeenCalledWith('group_test');

        const override = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/initialize`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: true, groupId: 'attacker' }),
          },
        );
        expect(override.status).toBe(400);
        expect(initializeGroup).toHaveBeenCalledTimes(1);
      },
    );
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

  it('routes lifecycle removals only with an exact Group confirmation', async () => {
    const dissolveGroup = vi.fn(async () => ({
      groupId: 'group_test',
      removed: true,
      cleanupPending: false,
      cleanupError: null,
    }));
    const leaveGroup = vi.fn(async () => ({
      groupId: 'group_test',
      removed: true,
      cleanupPending: true,
      cleanupError: 'filesystem busy',
    }));
    const removeLocalGroup = vi.fn(async () => ({
      groupId: 'group_test',
      removed: true,
      cleanupPending: false,
      cleanupError: null,
    }));
    const retryLocalCleanup = vi.fn(async () => ({
      groupId: 'group_test',
      removed: false,
      cleanupPending: false,
      cleanupError: null,
    }));
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            dissolveGroup,
            leaveGroup,
            removeLocalGroup,
            retryLocalCleanup,
          },
        }),
      ),
      async (baseUrl) => {
        const headers = { 'content-type': 'application/json' };
        const requests = [
          {
            path: '/groups/group_test/dissolve',
            method: 'POST',
            body: {
              expectedRevision: 3,
              reason: 'Project complete',
              confirmation: 'group_test',
            },
          },
          {
            path: '/groups/group_test/leave',
            method: 'POST',
            body: {
              expectedRevision: 4,
              reason: 'Leaving',
              confirmation: 'group_test',
            },
          },
          {
            path: '/subscriptions/group_test',
            method: 'DELETE',
            body: { confirmation: 'group_test' },
          },
          {
            path: '/local-bindings/group_test/cleanup/retry',
            method: 'POST',
            body: { confirmation: 'group_test' },
          },
        ] as const;
        for (const request of requests) {
          const mismatch = await fetch(
            `${baseUrl}/api/collaboration${request.path}`,
            {
              method: request.method,
              headers,
              body: JSON.stringify({
                ...request.body,
                confirmation: 'group_other',
              }),
            },
          );
          expect(mismatch.status, request.path).toBe(400);
        }
        expect(dissolveGroup).not.toHaveBeenCalled();
        expect(leaveGroup).not.toHaveBeenCalled();
        expect(removeLocalGroup).not.toHaveBeenCalled();
        expect(retryLocalCleanup).not.toHaveBeenCalled();

        for (const request of requests) {
          const response = await fetch(
            `${baseUrl}/api/collaboration${request.path}`,
            {
              method: request.method,
              headers,
              body: JSON.stringify(request.body),
            },
          );
          expect(response.status, request.path).toBe(200);
        }
        expect(dissolveGroup).toHaveBeenCalledWith(
          'group_test',
          'Project complete',
          3,
        );
        expect(leaveGroup).toHaveBeenCalledWith('group_test', 'Leaving', 4);
        expect(removeLocalGroup).toHaveBeenCalledWith('group_test');
        expect(retryLocalCleanup).toHaveBeenCalledWith('group_test');
      },
    );
  });

  it('routes unbound Invite issuance, revocation, and join references', async () => {
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
              expiresAt: '2026-08-08T12:00:00.000Z',
              expectedRevision: 0,
            }),
          },
        );
        expect(issued.status).toBe(201);
        expect(issueInvite).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'group_test',
          }),
        );

        const joined = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/join-requests`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              gitSshKeyPath: '/tmp/bob',
              displayName: 'Bob',
              clientDisplayName: 'Bob MacBook',
              inviteId: 'invite_bob',
            }),
          },
        );
        expect(joined.status).toBe(201);
        expect(joinGroup).toHaveBeenCalledWith(
          expect.objectContaining({
            gitSshKeyPath: '/tmp/bob',
            inviteId: 'invite_bob',
          }),
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

  it('routes recovery, Credential, Client, and local Git transport administration', async () => {
    const requestIdentityRecovery = vi.fn(async () => ({
      group: group('observer'),
      requestId: 'recovery_phone',
      requestHash: `sha256:${'1'.repeat(64)}`,
      verificationCode: '123456',
    }));
    const decideRecovery = vi.fn(async () => group());
    const cancelRecovery = vi.fn(async () => group('observer'));
    const rotateCredential = vi.fn(async () => group());
    const revokeCredential = vi.fn(async () => group());
    const revokeClient = vi.fn(async () => group());
    const updateGitSshKeyPath = vi.fn(() => '/default/id_rsa');
    const exportGroupRecoveryCredential = vi.fn(
      async () => '/backup/recovery.key',
    );
    const importGroupRecoveryCredential = vi.fn(async () => undefined);
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            requestIdentityRecovery,
            decideRecovery,
            cancelRecovery,
            rotateCredential,
            revokeCredential,
            revokeClient,
            updateGitSshKeyPath,
            exportGroupRecoveryCredential,
            importGroupRecoveryCredential,
          },
        }),
      ),
      async (baseUrl) => {
        const members = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/members`,
        );
        expect(members.status).toBe(200);
        expect(await members.json()).toMatchObject({
          credentials: {
            principal_alice: {
              credential_alice: {
                public_key: 'ssh-ed25519 AAAA-public-verification-material',
              },
            },
          },
          recoveryRequests: {
            recovery_phone: {
              verification_code: expect.stringMatching(/^\d{6}$/u),
            },
          },
        });

        const request = async (
          route: string,
          body: Record<string, unknown>,
          method = 'POST',
        ) =>
          fetch(`${baseUrl}/api/collaboration${route}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        expect(
          (
            await request('/groups/group_test/recovery-requests', {
              targetPrincipalId: 'principal_alice',
              type: 'owner_recovery',
              clientDisplayName: 'Alice replacement Mac',
              reason: 'All existing devices are unavailable',
              expiresInMs: 86_400_000,
            })
          ).status,
        ).toBe(201);
        expect(requestIdentityRecovery).toHaveBeenCalledWith({
          groupId: 'group_test',
          targetPrincipalId: 'principal_alice',
          type: 'owner_recovery',
          clientDisplayName: 'Alice replacement Mac',
          reason: 'All existing devices are unavailable',
          expiresInMs: 86_400_000,
        });

        expect(
          (
            await request(
              '/groups/group_test/recovery-requests/recovery_phone/approve',
              {
                expectedRevision: 1,
                reason: 'Offline identity verification complete',
                useOfflineOwnerCredential: true,
                revokeCredentialIds: ['credential_lost'],
              },
            )
          ).status,
        ).toBe(200);
        expect(decideRecovery).toHaveBeenCalledWith({
          groupId: 'group_test',
          requestId: 'recovery_phone',
          decision: 'approve',
          expectedRevision: 1,
          reason: 'Offline identity verification complete',
          useOfflineOwnerCredential: true,
          revokeCredentialIds: ['credential_lost'],
        });

        expect(
          (
            await request(
              '/groups/group_test/recovery-requests/recovery_phone/reject',
              { expectedRevision: 1, reason: 'Identity could not be verified' },
            )
          ).status,
        ).toBe(200);
        expect(decideRecovery).toHaveBeenLastCalledWith(
          expect.objectContaining({ decision: 'reject' }),
        );
        expect(
          (
            await request(
              '/groups/group_test/recovery-requests/recovery_phone/cancel',
              { expectedRevision: 1, reason: 'Replacement device recovered' },
            )
          ).status,
        ).toBe(200);
        expect(cancelRecovery).toHaveBeenCalledWith({
          groupId: 'group_test',
          requestId: 'recovery_phone',
          expectedRevision: 1,
          reason: 'Replacement device recovered',
        });

        expect(
          (
            await request('/groups/group_test/credentials/rotate', {
              expectedRevision: 4,
              revokeCurrent: true,
            })
          ).status,
        ).toBe(201);
        expect(rotateCredential).toHaveBeenCalledWith({
          groupId: 'group_test',
          expectedRevision: 4,
          revokeCurrent: true,
        });
        expect(
          (
            await request(
              '/groups/group_test/credentials/credential_lost/revoke',
              { expectedRevision: 5, reason: 'Device lost' },
            )
          ).status,
        ).toBe(200);
        expect(revokeCredential).toHaveBeenCalledWith({
          groupId: 'group_test',
          credentialId: 'credential_lost',
          expectedRevision: 5,
          reason: 'Device lost',
        });
        expect(
          (
            await request('/groups/group_test/clients/client_lost/revoke', {
              expectedRevision: 6,
              reason: 'Device lost',
            })
          ).status,
        ).toBe(200);
        expect(revokeClient).toHaveBeenCalledWith({
          groupId: 'group_test',
          clientId: 'client_lost',
          expectedRevision: 6,
          reason: 'Device lost',
        });

        const setting = await request(
          '/groups/group_test/settings/git-remote',
          { sshKeyPath: null },
          'PUT',
        );
        expect(setting.status).toBe(200);
        expect(await setting.json()).toEqual({ sshKeyPath: '/default/id_rsa' });
        expect(updateGitSshKeyPath).toHaveBeenCalledWith('group_test', null);

        expect(
          (
            await request('/groups/group_test/recovery-credential/export', {
              path: '/backup/recovery.key',
            })
          ).status,
        ).toBe(201);
        expect(exportGroupRecoveryCredential).toHaveBeenCalledWith(
          'group_test',
          '/backup/recovery.key',
        );
        expect(
          (
            await request('/groups/group_test/recovery-credential/import', {
              path: '/backup/recovery.key',
            })
          ).status,
        ).toBe(200);
        expect(importGroupRecoveryCredential).toHaveBeenCalledWith(
          'group_test',
          '/backup/recovery.key',
        );
      },
    );
  });

  it('routes membership decisions and continuous Workflow Turn commands', async () => {
    const approveMembership = vi.fn(async () => group());
    const rejectMembership = vi.fn(async () => group());
    const createTurn = vi.fn(async () => group());
    const startTurn = vi.fn(async () => group());
    const recoverTurn = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            approveMembership,
            rejectMembership,
            createTurn,
            startTurn,
            recoverTurn,
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
        expect(
          (
            await post(
              '/groups/group_test/workflow-instances/instance_1/turns/turn_1/recover',
              {
                expectedRevision: 5,
                previousAttempt: 1,
                assigneePrincipalId: 'principal_alice',
                reason: 'Reassign after member exit',
              },
            )
          ).status,
        ).toBe(200);
        expect(recoverTurn).toHaveBeenCalledWith({
          groupId: 'group_test',
          instanceId: 'instance_1',
          turnId: 'turn_1',
          expectedRevision: 5,
          previousAttempt: 1,
          assigneePrincipalId: 'principal_alice',
          reason: 'Reassign after member exit',
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

  it('validates member notifications and Discussion commands before dispatch', async () => {
    const sendMemberNotification = vi.fn(async () => group());
    const createDiscussion = vi.fn(async () => group());
    const createDiscussionWithMessage = vi.fn(async () => group());
    const proposeWorkflowDefinition = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            sendMemberNotification,
            createDiscussion,
            createDiscussionWithMessage,
            proposeWorkflowDefinition,
          },
        }),
      ),
      async (baseUrl) => {
        const notification = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/notifications`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              recipientPrincipalIds: [
                'principal_00000000-0000-4000-8000-000000000002',
                'principal_00000000-0000-4000-8000-000000000003',
              ],
              bodyMarkdown: '**Please review**',
              scope: { type: 'work_item', ref: 'work_1' },
              origin: 'human',
            }),
          },
        );
        expect(notification.status).toBe(201);
        expect(sendMemberNotification).toHaveBeenCalledWith({
          groupId: 'group_test',
          recipientPrincipalIds: [
            'principal_00000000-0000-4000-8000-000000000002',
            'principal_00000000-0000-4000-8000-000000000003',
          ],
          bodyMarkdown: '**Please review**',
          scope: { type: 'work_item', ref: 'work_1' },
          origin: 'human',
        });

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

        const discussionWithMessage = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/discussions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title: 'Release readiness',
              body: 'Please review the checklist.',
              mentions: ['principal_00000000-0000-4000-8000-000000000002'],
              scope: { type: 'group' },
            }),
          },
        );
        expect(discussionWithMessage.status).toBe(201);
        expect(createDiscussionWithMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            groupId: 'group_test',
            title: 'Release readiness',
            body: 'Please review the checklist.',
            mentions: ['principal_00000000-0000-4000-8000-000000000002'],
            scope: { type: 'group' },
          }),
        );

        for (const invalid of [
          {
            recipientPrincipalIds: [],
            bodyMarkdown: 'Empty recipients',
            scope: { type: 'group', ref: 'group_test' },
          },
          {
            recipientPrincipalIds: ['principal_not-a-uuid'],
            bodyMarkdown: 'Invalid Principal',
            scope: { type: 'group', ref: 'group_test' },
          },
          {
            recipientPrincipalIds: [
              'principal_00000000-0000-4000-8000-000000000002',
            ],
            bodyMarkdown: 'Invalid scope',
            scope: { type: 'credential', ref: 'credential_1' },
          },
        ]) {
          const invalidNotification = await fetch(
            `${baseUrl}/api/collaboration/groups/group_test/notifications`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(invalid),
            },
          );
          expect(invalidNotification.status).toBe(400);
        }
        expect(sendMemberNotification).toHaveBeenCalledTimes(1);

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
        'answerWorkItemAssignment',
        'archiveWorkItem',
        'setDiscussionResolved',
        'retireWorkflowDefinition',
        'reassignWorkflowStates',
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
              assignments: [
                {
                  stateId: 'implementation',
                  principalId: 'principal_bob',
                },
                { stateId: 'review', principalId: 'principal_alice' },
              ],
            },
          ],
          [
            '/groups/group_test/workflow-instances/instance_1/states/implementation/execution',
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
            method: route.endsWith('/execution') ? 'DELETE' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(response.status, route).toBeLessThan(300);
        }
        expect(groups.answerWorkItemAssignment).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ accepted: false, reason: 'capacity' }),
        );
        expect(groups.setDiscussionResolved).toHaveBeenCalledWith(
          expect.objectContaining({ resolved: false }),
        );
        expect(groups.reassignWorkflowStates).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedRevision: 2,
            assignments: [
              {
                stateId: 'implementation',
                principalId: 'principal_bob',
              },
              { stateId: 'review', principalId: 'principal_alice' },
            ],
          }),
        );
      },
    );
  });

  it('creates machine-owned Executor and Action identities and revises by resource path', async () => {
    const generatedExecutorId = 'executor_00000000-0000-4000-8000-000000000010';
    const generatedActionId = 'action_00000000-0000-4000-8000-000000000020';
    const registerExecutor = vi.fn(async () => ({
      group: group(),
      executor: {
        executor_id: generatedExecutorId,
        principal_id: 'principal_alice',
        display_name: 'Codex Desktop',
        kind: 'codex',
        status: 'active',
      },
      localExecutor: {
        groupId: 'group_test',
        principalId: 'principal_alice',
        clientId: 'client_alice',
        executorId: generatedExecutorId,
        displayName: 'Codex Desktop',
        executorKind: 'codex',
        workspacePath: '/workspace/project',
        filesystemAccess: 'workspace_write',
        approvalPolicy: 'on-request',
        config: { adapter: 'codex-task', token: 'secret' },
        enabled: true,
        updatedAtMs: 1,
      },
    }));
    const revokeExecutor = vi.fn(async () => group());
    const createAction = vi.fn(async (_input: Record<string, unknown>) => ({
      group: group(),
      action: {
        action_id: generatedActionId,
        name: 'Implement',
        version: 1,
      },
    }));
    const reviseAction = vi.fn(async (_input: Record<string, unknown>) => ({
      group: group(),
      action: {
        action_id: generatedActionId,
        name: 'Implement safely',
        version: 2,
      },
    }));
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          groups: {
            registerExecutor,
            revokeExecutor,
            createAction,
            reviseAction,
          },
        }),
      ),
      async (baseUrl) => {
        const prefix = `${baseUrl}/api/collaboration/groups/group_test`;
        const executor = await fetch(`${prefix}/executors`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 2,
            displayName: 'Codex Desktop',
            kind: 'codex',
            workspacePath: '/workspace/project',
            filesystemAccess: 'workspace_write',
            approvalPolicy: 'on-request',
          }),
        });
        expect(executor.status).toBe(201);
        expect(await executor.json()).toMatchObject({
          executor: { executor_id: generatedExecutorId },
          localExecutor: {
            executorId: generatedExecutorId,
            displayName: 'Codex Desktop',
            config: { adapter: 'codex-task', token: 'redacted' },
          },
        });
        expect(registerExecutor).toHaveBeenCalledWith({
          groupId: 'group_test',
          expectedRevision: 2,
          displayName: 'Codex Desktop',
          kind: 'codex',
          workspacePath: '/workspace/project',
          filesystemAccess: 'workspace_write',
          approvalPolicy: 'on-request',
        });

        const created = await fetch(`${prefix}/workspace/me/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 0,
            name: 'Implement',
            actionType: 'codex',
            prompt: 'Implement the current State.',
            filesystemAccess: 'workspace_write',
            resultFormat: 'collaboration_state_result',
          }),
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({
          action: { action_id: generatedActionId, version: 1 },
        });
        expect(createAction.mock.calls[0]?.[0]).not.toHaveProperty('actionId');
        expect(createAction.mock.calls[0]?.[0]).not.toHaveProperty('version');

        const revised = await fetch(
          `${prefix}/workspace/me/actions/${generatedActionId}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: 1,
              name: 'Implement safely',
              actionType: 'codex',
              prompt: 'Implement and verify the current State.',
              filesystemAccess: 'read_only',
              resultFormat: 'collaboration_state_result',
            }),
          },
        );
        expect(revised.status).toBe(200);
        expect(reviseAction).toHaveBeenCalledWith(
          expect.objectContaining({ actionId: generatedActionId }),
        );

        const revoked = await fetch(
          `${prefix}/executors/${generatedExecutorId}`,
          {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 3, reason: 'retired' }),
          },
        );
        expect(revoked.status).toBe(200);
        expect(revokeExecutor).toHaveBeenCalledWith({
          groupId: 'group_test',
          executorId: generatedExecutorId,
          expectedRevision: 3,
          reason: 'retired',
        });

        const rawIds = await fetch(`${prefix}/workspace/me/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 2,
            actionId: 'caller_selected',
            version: 99,
            name: 'Invalid',
            actionType: 'codex',
            prompt: 'Invalid request.',
            filesystemAccess: 'read_only',
          }),
        });
        expect(rawIds.status).toBe(400);
        expect(createAction).toHaveBeenCalledOnce();
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

  it('routes Project Insight, My Items, and local notification state', async () => {
    const projectInsight = vi.fn(() => ({
      insight: { snapshot_head: 'a'.repeat(40), health: 'needs_attention' },
    }));
    const myItems = vi.fn(() => ({
      items: [{ resource_type: 'work_item', resource_id: 'work_1' }],
    }));
    const listNotifications = vi.fn(() => [
      {
        notificationId: 'notification_1',
        resourceType: 'work_item',
        resourceId: 'work_1',
        severity: 'high',
      },
    ]);
    const markNotificationRead = vi.fn(() => true);
    const markNotificationHandled = vi.fn(() => false);
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          analysis: { projectInsight, myItems },
          store: {
            listNotifications,
            markNotificationRead,
            markNotificationHandled,
          },
        }),
      ),
      async (baseUrl) => {
        const insight = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/insights?mark_viewed=false`,
        );
        expect(insight.status).toBe(200);
        expect(await insight.json()).toMatchObject({
          insight: { health: 'needs_attention' },
        });
        expect(projectInsight).toHaveBeenCalledWith('group_test', false);

        const mine = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/my-items`,
        );
        expect(mine.status).toBe(200);
        expect(await mine.json()).toMatchObject({
          items: [{ resource_id: 'work_1' }],
        });
        expect(myItems).toHaveBeenCalledWith('group_test');

        const notifications = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/notifications?severity=high&include_handled=true&resource_type=work_item`,
        );
        expect(notifications.status).toBe(200);
        expect(await notifications.json()).toMatchObject({
          notifications: [{ notificationId: 'notification_1' }],
        });
        expect(listNotifications).toHaveBeenCalledWith({
          groupId: 'group_test',
          principalId: 'principal_alice',
          clientId: 'client_alice',
          includeHandled: true,
          severity: 'high',
          resourceType: 'work_item',
        });

        const read = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/notifications/notification_1/read`,
          { method: 'POST' },
        );
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual({ changed: true });
        expect(markNotificationRead).toHaveBeenCalledWith(
          'notification_1',
          'principal_alice',
          'client_alice',
        );

        const handled = await fetch(
          `${baseUrl}/api/collaboration/groups/group_test/notifications/notification_1/handled`,
          { method: 'POST' },
        );
        expect(handled.status).toBe(200);
        expect(await handled.json()).toEqual({ changed: false });
        expect(markNotificationHandled).toHaveBeenCalledWith(
          'notification_1',
          'principal_alice',
          'client_alice',
        );
      },
    );
  });

  it('routes managed and external Analysis Runs with explicit request shapes', async () => {
    const detail = analysisDetail();
    const listManagedExecutors = vi.fn(() => [
      {
        executorId: 'executor_codex',
        displayName: 'Icarus managed Codex',
        kind: 'run_once',
        approvalPolicy: 'never',
        cancellable: false,
      },
    ]);
    const list = vi.fn(() => [detail]);
    const getDetail = vi.fn(() => detail);
    const scopeOptions = vi.fn(() => ({
      currentSnapshotHead: 'c'.repeat(40),
      deltaBaseSnapshots: [{ snapshotHead: 'b'.repeat(40), commitOrder: 2 }],
    }));
    const createRun = vi.fn(async () => detail);
    const startManaged = vi.fn(async () => detail);
    const cancel = vi.fn(async () => detail);
    const retry = vi.fn(async () => detail);
    const completeReview = vi.fn(() => detail);
    const externalPackage = vi.fn(async () => ({
      format: 'icarus.collaboration-analysis-package/1',
      manifest: { analysis_id: 'analysis_1', challenge: 'handoff-challenge' },
      files: [],
    }));
    const externalPrompt = vi.fn(
      () => 'Analyze the frozen snapshot and return exactly one JSON object.',
    );
    const submitExternalResult = vi.fn(async () => detail);
    const decideFinding = vi.fn(() => detail.findings[0]);
    const previewActions = vi.fn(
      (input: { actions: Array<{ actionOrdinal?: number }> }) => {
        if (input.actions.some((entry) => (entry.actionOrdinal ?? 0) > 0))
          throw new Error(
            'Finding finding_1 has no proposed Action at ordinal 1',
          );
        return [
          {
            application: detail.applications[0],
            confirmationToken: 'confirmation-token-that-is-long-enough',
          },
        ];
      },
    );
    const applyActions = vi.fn(async () => detail);
    const analysis = {
      listManagedExecutors,
      list,
      detail: getDetail,
      scopeOptions,
      createRun,
      startManaged,
      cancel,
      retry,
      completeReview,
      externalPackage,
      externalPrompt,
      submitExternalResult,
      decideFinding,
      previewActions,
      applyActions,
    };
    await withApiServer(
      new CollaborationWebApi(runtime({ analysis })),
      async (baseUrl) => {
        const prefix = `${baseUrl}/api/collaboration/groups/group_test`;
        const executors = await fetch(`${prefix}/analysis-executors`);
        expect(executors.status).toBe(200);
        expect(await executors.json()).toEqual({
          executors: [
            {
              executorId: 'executor_codex',
              displayName: 'Icarus managed Codex',
              kind: 'run_once',
              approvalPolicy: 'never',
              cancellable: false,
            },
          ],
        });
        const options = await fetch(`${prefix}/analysis-scope-options`);
        expect(options.status).toBe(200);
        expect(await options.json()).toMatchObject({
          currentSnapshotHead: 'c'.repeat(40),
          deltaBaseSnapshots: [{ snapshotHead: 'b'.repeat(40) }],
        });

        const created = await fetch(`${prefix}/analysis-runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: { type: 'work_item', work_item_id: 'work_1' },
            executionChannel: 'external_agent',
            executorId: null,
            selectedFileIds: ['file_1'],
            includeSelectedFileContents: true,
          }),
        });
        expect(created.status).toBe(201);
        expect(createRun).toHaveBeenCalledWith('group_test', {
          scope: { type: 'work_item', work_item_id: 'work_1' },
          executionChannel: 'external_agent',
          executorId: null,
          selectedFileIds: ['file_1'],
          includeSelectedFileContents: true,
        });
        const delta = await fetch(`${prefix}/analysis-runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: {
              type: 'delta',
              since_snapshot_head: 'b'.repeat(40),
            },
            executionChannel: 'external_agent',
          }),
        });
        expect(delta.status).toBe(201);
        expect(createRun).toHaveBeenLastCalledWith('group_test', {
          scope: {
            type: 'delta',
            since_snapshot_head: 'b'.repeat(40),
          },
          executionChannel: 'external_agent',
        });

        const runs = await fetch(`${prefix}/analysis-runs`);
        expect(runs.status).toBe(200);
        expect(list).toHaveBeenCalledWith('group_test');
        const listedText = JSON.stringify(await runs.json());
        expect(listedText).not.toContain('challenge-must-not-leak');
        expect(listedText).not.toContain('secret-execution-ref');
        expect(listedText).not.toContain('run-provider-secret');
        expect(listedText).not.toContain('raw-result-secret');
        expect(listedText).not.toContain('result-provider-secret');
        expect(listedText).not.toContain(hash('t'));
        expect(listedText).not.toContain('/private/analysis');

        const fetched = await fetch(`${prefix}/analysis-runs/analysis_1`);
        expect(fetched.status).toBe(200);
        expect(getDetail).toHaveBeenCalledWith('group_test', 'analysis_1');

        for (const [operation, method] of [
          ['start', startManaged],
          ['cancel', cancel],
          ['retry', retry],
          ['complete', completeReview],
        ] as const) {
          const response = await fetch(
            `${prefix}/analysis-runs/analysis_1/${operation}`,
            { method: 'POST' },
          );
          expect(response.status, operation).toBe(200);
          expect(method).toHaveBeenCalledWith('group_test', 'analysis_1');
        }

        const packageResponse = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-package`,
        );
        expect(packageResponse.status).toBe(200);
        expect(await packageResponse.json()).toMatchObject({
          format: 'icarus.collaboration-analysis-package/1',
        });
        expect(externalPackage).toHaveBeenCalledWith(
          'group_test',
          'analysis_1',
        );

        const promptResponse = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-prompt`,
        );
        expect(promptResponse.status).toBe(200);
        expect(await promptResponse.json()).toEqual({
          prompt:
            'Analyze the frozen snapshot and return exactly one JSON object.',
        });
        expect(externalPrompt).toHaveBeenCalledWith('group_test', 'analysis_1');

        const resultJson = JSON.stringify({
          format: 'icarus.collaboration-analysis-result/1',
          analysis_id: 'analysis_1',
        });
        const resultResponse = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-result`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: resultJson,
          },
        );
        expect(resultResponse.status).toBe(200);
        expect(submitExternalResult).toHaveBeenCalledWith(
          'group_test',
          'analysis_1',
          resultJson,
        );

        const uploadedJson = JSON.stringify({
          format: 'icarus.collaboration-analysis-result/1',
          analysis_id: 'analysis_1',
          source: 'file',
        });
        const upload = new FormData();
        upload.append('file', new Blob([uploadedJson]), 'result.json');
        const uploadResponse = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-result`,
          { method: 'POST', body: upload },
        );
        expect(uploadResponse.status).toBe(200);
        expect(submitExternalResult).toHaveBeenLastCalledWith(
          'group_test',
          'analysis_1',
          uploadedJson,
        );

        const decision = await fetch(
          `${prefix}/analysis-runs/analysis_1/findings/finding_1/decision`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decision: 'deferred',
              reason: 'Needs owner review',
            }),
          },
        );
        expect(decision.status).toBe(200);
        expect(decideFinding).toHaveBeenCalledWith({
          groupId: 'group_test',
          analysisId: 'analysis_1',
          findingId: 'finding_1',
          decision: 'deferred',
          reason: 'Needs owner review',
        });

        const action = {
          action: 'watch_work_item' as const,
          parameters: { work_item_id: 'work_1' },
        };
        const preview = await fetch(
          `${prefix}/analysis-runs/analysis_1/actions/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              actions: [
                {
                  requestId: 'preview_request_1',
                  findingId: 'finding_1',
                  action,
                },
              ],
            }),
          },
        );
        expect(preview.status).toBe(200);
        expect(previewActions).toHaveBeenCalledWith({
          groupId: 'group_test',
          analysisId: 'analysis_1',
          actions: [
            {
              requestId: 'preview_request_1',
              findingId: 'finding_1',
              action,
            },
          ],
        });

        const editedAction = {
          action: 'create_work_item' as const,
          parameters: {
            type: 'task' as const,
            title: 'Use an edited action type',
            description: '',
            priority: 'normal' as const,
            due_at: null,
            labels: [],
            related_work_item_ids: ['work_1'],
          },
        };
        const edited = await fetch(
          `${prefix}/analysis-runs/analysis_1/actions/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              actions: [
                {
                  requestId: 'preview_edited_suggestion',
                  findingId: 'finding_1',
                  actionOrdinal: 0,
                  action: editedAction,
                },
              ],
            }),
          },
        );
        expect(edited.status).toBe(200);
        expect(previewActions).toHaveBeenLastCalledWith({
          groupId: 'group_test',
          analysisId: 'analysis_1',
          actions: [
            {
              requestId: 'preview_edited_suggestion',
              findingId: 'finding_1',
              actionOrdinal: 0,
              action: editedAction,
            },
          ],
        });

        const forgedOrdinal = await fetch(
          `${prefix}/analysis-runs/analysis_1/actions/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              actions: [
                {
                  requestId: 'preview_forged_ordinal',
                  findingId: 'finding_1',
                  actionOrdinal: 1,
                  action: editedAction,
                },
              ],
            }),
          },
        );
        expect(forgedOrdinal.status).toBe(400);
        expect(await forgedOrdinal.json()).toMatchObject({
          error: 'Finding finding_1 has no proposed Action at ordinal 1',
        });

        const confirmationToken = 'x'.repeat(40);
        const apply = await fetch(
          `${prefix}/analysis-runs/analysis_1/actions/apply`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              actions: [
                {
                  applicationId: 'application_1',
                  confirmationToken,
                  action,
                },
              ],
            }),
          },
        );
        expect(apply.status).toBe(200);
        expect(applyActions).toHaveBeenCalledWith({
          groupId: 'group_test',
          analysisId: 'analysis_1',
          actions: [
            {
              applicationId: 'application_1',
              confirmationToken,
              action,
            },
          ],
        });
      },
    );
  });

  it('rejects malformed external results and keeps Observer group writes read-only', async () => {
    const submitExternalResult = vi.fn();
    const createRun = vi.fn(async () => analysisDetail());
    const previewActions = vi.fn(() => {
      throw new Error('Observer subscription is read-only');
    });
    await withApiServer(
      new CollaborationWebApi(
        runtime({
          selectedGroup: group('observer'),
          analysis: { submitExternalResult, createRun, previewActions },
        }),
      ),
      async (baseUrl) => {
        const prefix = `${baseUrl}/api/collaboration/groups/group_test`;
        const naturalLanguage = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-result`,
          {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'The project looks healthy.',
          },
        );
        expect(naturalLanguage.status).toBe(400);

        const duplicate = await fetch(
          `${prefix}/analysis-runs/analysis_1/external-result`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"analysis_id":"first","analysis_id":"second"}',
          },
        );
        expect(duplicate.status).toBe(400);
        expect(submitExternalResult).not.toHaveBeenCalled();

        const observerWrite = await fetch(`${prefix}/analysis-runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: { type: 'project' },
            executionChannel: 'managed_executor',
            executorId: 'executor_codex',
          }),
        });
        expect(observerWrite.status).toBe(201);

        const preview = await fetch(
          `${prefix}/analysis-runs/analysis_1/actions/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              actions: [
                {
                  requestId: 'observer_preview_request',
                  findingId: 'finding_1',
                  actionOrdinal: 0,
                  action: {
                    action: 'watch_work_item',
                    parameters: { work_item_id: 'work_1' },
                  },
                },
              ],
            }),
          },
        );
        expect(preview.status).toBe(400);
        expect(await preview.json()).toMatchObject({
          error: 'Observer subscription is read-only',
        });
      },
    );
  });

  it('returns conflict for both stale Action preview and apply requests', async () => {
    const rejectStale = () => {
      throw new Error('Analysis Run verified snapshot is stale');
    };
    const previewActions = vi.fn(rejectStale);
    const applyActions = vi.fn(rejectStale);
    await withApiServer(
      new CollaborationWebApi(
        runtime({ analysis: { previewActions, applyActions } }),
      ),
      async (baseUrl) => {
        const prefix = `${baseUrl}/api/collaboration/groups/group_test/analysis-runs/analysis_1/actions`;
        const action = {
          action: 'watch_work_item',
          parameters: { work_item_id: 'work_1' },
        };
        const preview = await fetch(`${prefix}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actions: [
              {
                requestId: 'stale_preview',
                findingId: 'finding_1',
                action,
              },
            ],
          }),
        });
        expect(preview.status).toBe(409);

        const apply = await fetch(`${prefix}/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actions: [
              {
                applicationId: 'application_1',
                confirmationToken: 'x'.repeat(40),
                action,
              },
            ],
          }),
        });
        expect(apply.status).toBe(409);
        expect(previewActions).toHaveBeenCalledOnce();
        expect(applyActions).toHaveBeenCalledOnce();
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

  it('rejects unknown permission and template ids before command dispatch', async () => {
    const updatePermissions = vi.fn(async () => group());
    const updateGroupSettings = vi.fn(async () => group());
    await withApiServer(
      new CollaborationWebApi(
        runtime({ groups: { updatePermissions, updateGroupSettings } }),
      ),
      async (baseUrl) => {
        const prefix = `${baseUrl}/api/collaboration/groups/group_test`;
        const permission = await fetch(`${prefix}/permissions/principal_test`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            grants: ['permission:invented'],
          }),
        });
        const template = await fetch(`${prefix}/settings`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            defaultPermissionTemplateId: 'invented.v1',
          }),
        });
        expect(permission.status).toBe(400);
        expect(template.status).toBe(400);
        expect(await permission.json()).toMatchObject({
          code: 'INVALID_REQUEST',
        });
        expect(updatePermissions).not.toHaveBeenCalled();
        expect(updateGroupSettings).not.toHaveBeenCalled();
      },
    );
  });

  it('maps structured authorization, conflict, and validation failures', async () => {
    const updateWorkItemDetails = vi
      .fn()
      .mockRejectedValueOnce(
        new CollaborationProtocolError(
          'EVENT_UNAUTHORIZED',
          'Actor cannot update this Work Item',
        ),
      )
      .mockRejectedValueOnce(
        new CollaborationProtocolError(
          'EVENT_CONFLICT',
          'Work Item revision conflict',
        ),
      )
      .mockRejectedValueOnce(
        new CollaborationProjectSpaceGitConflictError(
          'lost the remote fast-forward race',
        ),
      );
    await withApiServer(
      new CollaborationWebApi(runtime({ groups: { updateWorkItemDetails } })),
      async (baseUrl) => {
        const endpoint = `${baseUrl}/api/collaboration/groups/group_test/work-items/work_1`;
        const request = (body: Record<string, unknown>) =>
          fetch(endpoint, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
        const unauthorized = await request({
          expectedRevision: 2,
          title: 'Denied',
        });
        expect(unauthorized.status).toBe(403);
        expect(await unauthorized.json()).toMatchObject({
          code: 'EVENT_UNAUTHORIZED',
        });

        const conflict = await request({
          expectedRevision: 2,
          title: 'Conflict',
        });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'EVENT_CONFLICT' });

        const gitConflict = await request({
          expectedRevision: 2,
          title: 'Git conflict',
        });
        expect(gitConflict.status).toBe(409);
        expect(await gitConflict.json()).toMatchObject({
          code: 'EVENT_CONFLICT',
        });

        const invalid = await request({ expectedRevision: -1, title: '' });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
        expect(updateWorkItemDetails).toHaveBeenCalledTimes(3);
      },
    );
  });
});
