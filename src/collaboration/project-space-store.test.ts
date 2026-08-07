import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COLLABORATION_PROJECT_SPACE_STORE_FORMAT,
  CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
  CollaborationProjectSpaceStore,
  CollaborationProjectSpaceStoreError,
} from './project-space-store.js';
import {
  buildCollaborationEventV3,
  reduceCollaborationEventV3,
} from './protocol/v3-reducer.js';

const temporaryDirectories: string[] = [];
const NOW = '2026-08-06T12:00:00.000Z';
const PRINCIPAL = 'principal_sha256_alice';
const CLIENT = 'client_alice';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(name: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'icarus-v3-store-'));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

function genesis() {
  const payload = {
    group: {
      format: 'icarus.collaboration-group/3' as const,
      protocol_version: 3 as const,
      group_id: 'group_test',
      name: 'Test group',
      creator: {
        principal_id: PRINCIPAL,
        signing_key_ref: 'ssh-ed25519:SHA256:alice',
      },
      owner_principal_id: PRINCIPAL,
      control_branch: 'refs/heads/icarus/control' as const,
      lifecycle: 'active' as const,
      membership_policy: { join: 'open' as const },
      visibility_policy: { observer_access: 'allowed' as const },
      created_at: NOW,
      archived_at: null,
    },
    member: {
      format: 'icarus.collaboration-member/3' as const,
      principal_id: PRINCIPAL,
      display_name: 'Alice',
      signing_key_ref: 'ssh-ed25519:SHA256:alice',
      signing_public_key:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice',
      status: 'active' as const,
      joined_at_event: 'evt_genesis',
    },
    client: {
      format: 'icarus.collaboration-client/1' as const,
      principal_id: PRINCIPAL,
      client_id: CLIENT,
      display_name: 'Alice MacBook',
      capabilities: [],
      status: 'active' as const,
      registered_at_event: 'evt_genesis',
    },
    owner_permissions: {
      format: 'icarus.collaboration-permission-grant/1' as const,
      principal_id: PRINCIPAL,
      grants: [],
      revision: 1,
      updated_at_event: 'evt_genesis',
    },
  };
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
    payload,
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
}

describe('Collaboration project space v3 store', () => {
  it('creates only the fresh current schema and rejects stale v4', () => {
    const databasePath = temporaryPath('current.db');
    const store = new CollaborationProjectSpaceStore(databasePath);
    expect(
      store.rawDatabaseForTests().pragma('user_version', { simple: true }),
    ).toBe(CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION);
    expect(
      (
        store
          .rawDatabaseForTests()
          .prepare("SELECT value FROM collaboration_meta WHERE key = 'format'")
          .get() as { value: string }
      ).value,
    ).toBe(COLLABORATION_PROJECT_SPACE_STORE_FORMAT);
    store.close();

    const stalePath = temporaryPath('stale.db');
    const stale = new Database(stalePath);
    stale.pragma('user_version = 4');
    stale.close();
    expect(() => new CollaborationProjectSpaceStore(stalePath)).toThrow(
      expect.objectContaining<Partial<CollaborationProjectSpaceStoreError>>({
        code: 'SCHEMA_VERSION_UNSUPPORTED',
      }),
    );
  });

  it('stores an Observer without Principal/Client/signing state', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('observer.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'observer',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
    });
    expect(store.getGroup('group_test')).toMatchObject({
      subscriptionMode: 'observer',
      localPrincipalId: null,
      localClientId: null,
      signingKeyPath: null,
    });
    expect(
      store
        .rawDatabaseForTests()
        .prepare('SELECT COUNT(*) AS count FROM collaboration_principals')
        .get(),
    ).toEqual({ count: 0 });
    store.close();
  });

  it('atomically projects verified events and preserves the verified head on upgrade', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('projection.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'observer',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
    });
    const { event, projection } = genesis();
    store.saveVerifiedProjection({
      groupId: 'group_test',
      verifiedHead: 'a'.repeat(40),
      projection,
      eventRecords: [{ event, commitHash: 'a'.repeat(40), commitOrder: 1 }],
    });
    expect(
      store.getCheckpoint('group_test', 'group', 'group_test'),
    ).toMatchObject({
      revision: 1,
      eventId: 'evt_genesis',
    });
    expect(store.getGroup('group_test')?.lastVerifiedHead).toBe('a'.repeat(40));
    expect(store.listEventRecords('group_test')).toHaveLength(1);

    store.updateSubscriptionMode({
      groupId: 'group_test',
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      signingKeyPath: '/tmp/id_ed25519',
      signingPublicKey: 'public',
      signingKeyRef: 'ssh-ed25519:SHA256:alice',
    });
    expect(store.getGroup('group_test')).toMatchObject({
      subscriptionMode: 'member',
      lastVerifiedHead: 'a'.repeat(40),
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
    });
    store.close();
  });

  it('deduplicates notifications per Client and keeps reasons explicit', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('notify.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'observer',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
    });
    const first = store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'due_soon',
      resourceType: 'work_item',
      resourceId: 'wi_101',
      reason: 'owner',
      dedupeKey: 'due:wi_101:owner:0',
    });
    const duplicate = store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'due_soon',
      resourceType: 'work_item',
      resourceId: 'wi_101',
      reason: 'owner',
      dedupeKey: 'due:wi_101:owner:0',
    });
    expect(first.enqueued).toBe(true);
    expect(duplicate.enqueued).toBe(false);
    expect(duplicate.notification.notificationId).toBe(
      first.notification.notificationId,
    );
    expect(
      store.listPendingNotifications({
        principalId: PRINCIPAL,
        clientId: CLIENT,
      }),
    ).toHaveLength(1);
    store.close();
  });
});
