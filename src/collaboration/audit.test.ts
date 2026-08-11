import { describe, expect, it } from 'vitest';

import { buildCollaborationAuditV4 } from './audit.js';
import { buildCollaborationGenesisSelfDescription } from './group-self-description.js';
import type {
  CollaborationActionExecutionV4,
  CollaborationNotificationV4,
  CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import {
  buildCollaborationEventV4,
  reduceCollaborationEventV4,
} from './protocol/v4-reducer.js';
import { collaborationCredentialFingerprintV4 } from './protocol/v4-schema.js';

const NOW = '2026-08-06T12:00:00.000Z';
const PRINCIPAL = 'principal_00000000-0000-4000-8000-000000000001';
const CLIENT = 'client_alice';
const CREDENTIAL = 'credential_alice';
const RECOVERY_CREDENTIAL = 'credential_alice_recovery';
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const FINGERPRINT = collaborationCredentialFingerprintV4(PUBLIC_KEY);

function history() {
  const selfDescription = buildCollaborationGenesisSelfDescription({
    groupId: 'group_test',
  });
  const event = buildCollaborationEventV4({
    groupId: 'group_test',
    eventId: 'evt_genesis',
    aggregateType: 'group',
    aggregateId: 'group_test',
    aggregateRevision: 1,
    previousEventHash: null,
    eventType: 'group_initialized',
    actor: {
      principal_id: PRINCIPAL,
      client_id: CLIENT,
      credential_id: CREDENTIAL,
      executor_id: null,
    },
    occurredAt: NOW,
    payload: {
      group: {
        format: 'icarus.collaboration-group/4',
        protocol_version: 4,
        group_id: 'group_test',
        name: 'Test group',
        creator: {
          principal_id: PRINCIPAL,
        },
        owner_principal_id: PRINCIPAL,
        control_branch: 'refs/heads/icarus/control',
        lifecycle: 'active',
        membership_policy: { join: 'open' },
        visibility_policy: { observer_access: 'allowed' },
        created_at: NOW,
        archived_at: null,
      },
      member: {
        format: 'icarus.collaboration-member/4',
        principal_id: PRINCIPAL,
        display_name: 'Alice',
        status: 'active',
        joined_at_event: 'evt_genesis',
      },
      client: {
        format: 'icarus.collaboration-client/1',
        principal_id: PRINCIPAL,
        client_id: CLIENT,
        display_name: 'Alice MacBook',
        capabilities: [],
        status: 'active',
        registered_at_event: 'evt_genesis',
      },
      credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: CREDENTIAL,
        principal_id: PRINCIPAL,
        client_id: CLIENT,
        public_key: PUBLIC_KEY,
        fingerprint: FINGERPRINT,
        purpose: 'event_signing',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      recovery_credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: RECOVERY_CREDENTIAL,
        principal_id: PRINCIPAL,
        client_id: CLIENT,
        public_key: PUBLIC_KEY,
        fingerprint: FINGERPRINT,
        purpose: 'group_recovery',
        status: 'active',
        created_at_event: 'evt_genesis',
        revoked_at_event: null,
      },
      owner_permissions: {
        format: 'icarus.collaboration-permission-grant/1',
        principal_id: PRINCIPAL,
        grants: [],
        revision: 1,
        updated_at_event: 'evt_genesis',
      },
      self_description: selfDescription.manifest,
    },
  });
  return { event, projection: reduceCollaborationEventV4(null, event) };
}

function group(
  projection: ReturnType<typeof history>['projection'],
): CollaborationProjectSpaceGroupRecord {
  return {
    groupId: 'group_test',
    name: 'Test group',
    lifecycle: 'active',
    ownerPrincipalId: PRINCIPAL,
    subscriptionMode: 'member',
    localPrincipalId: PRINCIPAL,
    localClientId: CLIENT,
    remoteUrl: '/tmp/group.git',
    repositoryPath: '/tmp/cache.git',
    gitSshKeyPath: '/tmp/id_ed25519',
    localCredentialId: CREDENTIAL,
    eventPrivateKeyPath: '/tmp/event-key',
    eventPublicKey: PUBLIC_KEY,
    eventFingerprint: FINGERPRINT,
    recoveryCredentialId: RECOVERY_CREDENTIAL,
    recoveryPrivateKeyPath: '/tmp/recovery-key',
    protocolStatus: 'verified',
    protocolError: null,
    projection,
    pollIntervalMs: 60_000,
    nextSyncAtMs: 0,
    lastVerifiedHead: 'a'.repeat(40),
    lastSyncAtMs: 1,
    lastError: null,
    backoffAttempt: 0,
  };
}

const execution: CollaborationActionExecutionV4 = {
  executionId: 'execution_1',
  groupId: 'group_test',
  instanceId: 'instance_1',
  turnId: 'turn_1',
  epoch: 1,
  attempt: 1,
  claimantClientId: CLIENT,
  fencingToken: `sha256:${'f'.repeat(64)}`,
  operationKey: `sha256:${'e'.repeat(64)}`,
  executorId: 'executor_1',
  executorKind: 'run_once',
  state: 'succeeded',
  executionRef: 'provider:1',
  providerMetadata: { provider: 'test' },
  receipt: { secret: 'receipt' },
  observation: { secret: 'observation' },
  recoveryRequiredReason: null,
  dispatchStartedAtMs: 1,
  receiptRecordedAtMs: 2,
  providerCompletedAtMs: 3,
  createdAtMs: 1,
  updatedAtMs: 3,
};

const notification: CollaborationNotificationV4 = {
  notificationId: 'notification_1',
  groupId: 'group_test',
  recipientPrincipalId: PRINCIPAL,
  recipientClientId: CLIENT,
  kind: 'turn_timeout',
  resourceType: 'turn',
  resourceId: 'turn_1',
  reason: 'execution deadline passed',
  severity: 'high',
  dedupeKey: 'timeout:turn_1:1',
  reminderOrdinal: 0,
  dueAtMs: 1,
  firstObservedAtMs: 2,
  deliveredAtMs: null,
  readAtMs: null,
  handledAtMs: null,
  updatedAtMs: 2,
  payload: { private: true },
};

describe('Collaboration project-space v4 audit', () => {
  it('exports ordered signed facts and local evidence without content by default', () => {
    const { event, projection } = history();
    const audit = buildCollaborationAuditV4({
      group: group(projection),
      projection,
      eventRecords: [{ event, commitHash: 'a'.repeat(40), commitOrder: 1 }],
      executions: [execution],
      notifications: [notification],
      localEvidence: [
        {
          kind: 'verified-file',
          sha256: 'b'.repeat(64),
          localPath: '/private/provider/workspace',
          privateKey: 'private-key-material',
          apiToken: 'provider-token',
        },
      ],
      generatedAt: new Date(NOW),
    });

    expect(audit).toMatchObject({
      format: 'icarus.collaboration-audit/4',
      generated_at: NOW,
      group: {
        group_id: 'group_test',
        subscription_mode: 'member',
        protocol_status: 'verified',
      },
      aggregates: {
        'group:group_test': { revision: 1, eventId: 'evt_genesis' },
      },
    });
    expect(audit.events[0]).toMatchObject({
      event_id: 'evt_genesis',
      commit_order: 1,
      payload_hash: expect.stringMatching(/^sha256:/),
    });
    expect(audit.events[0]).not.toHaveProperty('payload');
    expect(audit.local_evidence[0]).not.toHaveProperty('receipt');
    expect(audit.local_evidence[0]).not.toHaveProperty('observation');
    expect(audit.credentials[PRINCIPAL]?.[CREDENTIAL]).toMatchObject({
      credential_id: CREDENTIAL,
      public_key: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
      purpose: 'event_signing',
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).toContain(PUBLIC_KEY);
    expect(serialized).not.toContain('/private/provider');
    expect(serialized).not.toContain('/tmp/id_ed25519');
    expect(serialized).not.toContain('/tmp/event-key');
    expect(serialized).not.toContain('/tmp/recovery-key');
    expect(serialized).not.toContain('private-key-material');
    expect(serialized).not.toContain('provider-token');
    expect(serialized).not.toContain('secret');
  });

  it('includes event and provider content only when explicitly requested', () => {
    const { event, projection } = history();
    const audit = buildCollaborationAuditV4({
      group: group(projection),
      projection,
      eventRecords: [{ event, commitHash: 'a'.repeat(40), commitOrder: 1 }],
      executions: [execution],
      notifications: [],
      localEvidence: [],
      includeContent: true,
      generatedAt: new Date(NOW),
    });

    expect(audit.events[0]).toHaveProperty('payload');
    expect(audit.local_evidence[0]).toMatchObject({
      receipt: { secret: '[redacted]' },
      observation: { secret: '[redacted]' },
    });
  });
});
