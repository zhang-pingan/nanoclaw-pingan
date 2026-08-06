import { describe, expect, it } from 'vitest';

import type {
  CollaborationExecutionRecord,
  CollaborationExecutorBinding,
  CollaborationGroupRecord,
} from './store.js';
import { collaborationWebApiTestables } from './web-api.js';

describe('Collaboration Web API redaction', () => {
  it('never serializes the signing key path or remote credentials', () => {
    const group = {
      groupId: 'ag_test',
      name: 'Test',
      creatorPrincipalId: 'alice',
      localPrincipalId: 'alice',
      localAgentId: 'agent_alice',
      lifecycle: 'READY',
      businessState: 'development',
      protocolStatus: 'OK',
      protocolError:
        'git fetch https://private-token@example.test/group.git failed',
      projection: null,
      remoteUrl:
        'https://private-token@example.test/group.git?accessToken=query-secret&ref=main',
      repositoryPath: '/private/cache/repository.git',
      signingKeyPath: '/private/keys/id_ed25519',
      signingPublicKey: 'ssh-ed25519 public',
      signingKeyRef: 'ssh-ed25519:SHA256:test',
      pollIntervalMs: 15_000,
      nextSyncAtMs: 1,
      backoffAttempt: 0,
      lastSyncAtMs: null,
      lastError:
        'https://private-token@example.test/group.git?accessToken=query-secret is unavailable',
      headCommit: null,
    } satisfies CollaborationGroupRecord;

    const serialized = collaborationWebApiTestables.publicGroup(group);
    expect(JSON.stringify(serialized)).not.toContain('/private/keys');
    expect(JSON.stringify(serialized)).not.toContain('/private/cache');
    expect(serialized.remoteUrl).toContain('redacted@');
    expect(serialized.remoteUrl).toContain('accessToken=redacted');
    expect(serialized.remoteUrl).toContain('ref=main');
    expect(serialized.remoteUrl).not.toContain('query-secret');
    expect(serialized.protocolError).not.toContain('private-token');
    expect(serialized.lastError).not.toContain('private-token');
    expect(serialized.lastError).not.toContain('query-secret');
  });

  it('allowlists provider fields and removes raw receipt/metadata', () => {
    const execution = {
      executionId: 'execution-1',
      groupId: 'ag_test',
      turnId: 'turn-1',
      epoch: 1,
      attempt: 1,
      fencingToken: `sha256:${'a'.repeat(64)}`,
      operationKey: `sha256:${'b'.repeat(64)}`,
      executorKind: 'external',
      adapter: 'codex-task',
      state: 'running',
      executionRef: 'collaboration-action:opaque',
      providerMetadata: {
        transport: 'app_server_stdio',
        thread_id: 'thread-local',
        turn_id: 'turn-local',
        cli_version: '0.146.0',
        provider_secret_id: 'must-not-leak',
      },
      receipt: { private_receipt: 'must-not-leak' },
      observation: {
        state: 'running',
        executionRef: 'collaboration-action:opaque',
        providerMetadata: { provider_secret_id: 'must-not-leak' },
        result: null,
        resultHash: null,
      },
      pendingResultEvent: null,
      recoveryRequiredReason: null,
      dispatchStartedAtMs: 1,
      receiptRecordedAtMs: 2,
      createdAtMs: 1,
      updatedAtMs: 2,
    } satisfies CollaborationExecutionRecord;

    const serialized = collaborationWebApiTestables.publicExecution(execution);
    expect(serialized.provider).toMatchObject({
      kind: 'codex-task',
      threadId: 'thread-local',
      turnId: 'turn-local',
    });
    expect(JSON.stringify(serialized)).not.toContain('must-not-leak');
    expect(serialized).not.toHaveProperty('receipt');
    expect(serialized).not.toHaveProperty('providerMetadata');
  });

  it('redacts secret-like executor config keys recursively', () => {
    const binding = {
      groupId: 'ag_test',
      role: 'developer',
      executorKind: 'external',
      adapter: 'codex-task',
      agentJid: null,
      workspacePath: '/workspace',
      promptOverride: null,
      filesystemAccessCap: 'workspace_write',
      approvalPolicy: 'on-request',
      config: {
        transport: 'app_server',
        nested: {
          access_token: 'secret-value',
          apiKey: 'api-secret',
          clientSecret: 'client-secret',
          harmless: 'visible',
        },
      },
      enabled: true,
      updatedAtMs: 1,
    } satisfies CollaborationExecutorBinding;
    expect(collaborationWebApiTestables.publicBinding(binding).config).toEqual({
      transport: 'app_server',
      nested: {
        access_token: '[redacted]',
        apiKey: '[redacted]',
        clientSecret: '[redacted]',
        harmless: 'visible',
      },
    });
  });

  it('redacts credentials from standalone diagnostic URLs', () => {
    const diagnostic = collaborationWebApiTestables.redactDiagnostic(
      'clone https://user:password@example.test/group.git failed',
    );
    expect(diagnostic).toContain('https://redacted@example.test/group.git');
    expect(diagnostic).not.toContain('password');
  });
});
