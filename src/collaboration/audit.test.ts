import { describe, expect, it } from 'vitest';

import { buildCollaborationAuditV3 } from './audit.js';
import type {
  CollaborationActionExecutionV3,
  CollaborationNotificationV3,
  CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import {
  buildCollaborationEventV3,
  reduceCollaborationEventV3,
} from './protocol/v3-reducer.js';

const NOW = '2026-08-06T12:00:00.000Z';
const PRINCIPAL = 'principal_sha256_alice';
const CLIENT = 'client_alice';

function history() {
  const event = buildCollaborationEventV3({
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
      executor_id: null,
    },
    occurredAt: NOW,
    payload: {
      group: {
        format: 'icarus.collaboration-group/3',
        protocol_version: 3,
        group_id: 'group_test',
        name: 'Test group',
        creator: {
          principal_id: PRINCIPAL,
          signing_key_ref: 'ssh-ed25519:SHA256:alice',
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
        format: 'icarus.collaboration-member/3',
        principal_id: PRINCIPAL,
        display_name: 'Alice',
        signing_key_ref: 'ssh-ed25519:SHA256:alice',
        signing_public_key:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice',
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
      owner_permissions: {
        format: 'icarus.collaboration-permission-grant/1',
        principal_id: PRINCIPAL,
        grants: [],
        revision: 1,
        updated_at_event: 'evt_genesis',
      },
    },
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
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
    signingKeyPath: '/tmp/id_ed25519',
    signingPublicKey: 'public',
    signingKeyRef: 'ssh-ed25519:SHA256:alice',
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

const execution: CollaborationActionExecutionV3 = {
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

const notification: CollaborationNotificationV3 = {
  notificationId: 'notification_1',
  groupId: 'group_test',
  recipientPrincipalId: PRINCIPAL,
  recipientClientId: CLIENT,
  kind: 'turn_timeout',
  resourceType: 'turn',
  resourceId: 'turn_1',
  reason: 'execution deadline passed',
  dedupeKey: 'timeout:turn_1:1',
  reminderOrdinal: 0,
  dueAtMs: 1,
  firstObservedAtMs: 2,
  deliveredAtMs: null,
  payload: { private: true },
};

describe('Collaboration project-space v3 audit', () => {
  it('exports ordered signed facts and local evidence without content by default', () => {
    const { event, projection } = history();
    const audit = buildCollaborationAuditV3({
      group: group(projection),
      projection,
      eventRecords: [{ event, commitHash: 'a'.repeat(40), commitOrder: 1 }],
      executions: [execution],
      notifications: [notification],
      localEvidence: [{ kind: 'verified-file', sha256: 'b'.repeat(64) }],
      generatedAt: new Date(NOW),
    });

    expect(audit).toMatchObject({
      format: 'icarus.collaboration-audit/3',
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
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  it('includes event and provider content only when explicitly requested', () => {
    const { event, projection } = history();
    const audit = buildCollaborationAuditV3({
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
