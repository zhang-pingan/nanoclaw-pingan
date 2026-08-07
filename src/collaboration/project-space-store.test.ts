import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COLLABORATION_PROJECT_SPACE_STORE_FORMAT,
  CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
  CollaborationProjectSpaceStore,
  CollaborationProjectSpaceStoreError,
  createCollaborationProjectSpaceBackup,
  restoreCollaborationProjectSpaceBackup,
  rollbackCollaborationProjectSpaceRestore,
} from './project-space-store.js';
import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
  reduceCollaborationEventV3,
} from './protocol/v3-reducer.js';

const temporaryDirectories: string[] = [];
const NOW = '2026-08-06T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
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

  it('advances successful sync cadence and applies exponential failure backoff with recovery', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('sync-schedule.db'),
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
      nowMs: NOW_MS,
    });

    const firstFailure = store.startSyncAttempt('group_test', null, NOW_MS);
    store.finishSyncAttempt({
      id: firstFailure,
      groupId: 'group_test',
      outcome: 'failed',
      headAfter: null,
      error: 'offline',
      nowMs: NOW_MS,
    });
    const failedOnce = store.getGroup('group_test')!;
    expect(failedOnce.backoffAttempt).toBe(1);
    expect(failedOnce.nextSyncAtMs).toBeGreaterThan(NOW_MS + 60_000);
    expect(failedOnce.lastError).toBe('offline');

    const secondFailureAt = failedOnce.nextSyncAtMs;
    const secondFailure = store.startSyncAttempt(
      'group_test',
      null,
      secondFailureAt,
    );
    store.finishSyncAttempt({
      id: secondFailure,
      groupId: 'group_test',
      outcome: 'failed',
      headAfter: null,
      error: 'still offline',
      nowMs: secondFailureAt,
    });
    const failedTwice = store.getGroup('group_test')!;
    expect(failedTwice.backoffAttempt).toBe(2);
    expect(failedTwice.nextSyncAtMs).toBeGreaterThan(secondFailureAt + 120_000);

    const recoveredAt = failedTwice.nextSyncAtMs;
    const recovered = store.startSyncAttempt('group_test', null, recoveredAt);
    store.finishSyncAttempt({
      id: recovered,
      groupId: 'group_test',
      outcome: 'succeeded',
      headAfter: 'a'.repeat(40),
      nowMs: recoveredAt,
    });
    const healthy = store.getGroup('group_test')!;
    expect(healthy.backoffAttempt).toBe(0);
    expect(healthy.nextSyncAtMs).toBeGreaterThan(recoveredAt + 54_000);
    expect(healthy.nextSyncAtMs).toBeLessThanOrEqual(recoveredAt + 66_000);
    expect(healthy.lastError).toBeNull();
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

  it('finds an exact frozen Action and commit beyond the recent event window', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('action-snapshot.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'member',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      repositoryPath: '/tmp/cache.git',
      signingKeyPath: '/tmp/id_ed25519',
      signingPublicKey: 'ssh-ed25519 test',
      signingKeyRef: 'ssh-ed25519:SHA256:alice',
    });
    const initial = genesis();
    const action = {
      format: 'icarus.collaboration-action/1' as const,
      action_id: 'verify',
      name: 'Verify',
      owner_principal_id: PRINCIPAL,
      version: 1,
      kind: 'run_once' as const,
      adapter: null,
      workflow_ref: null,
      prompt_ref: `workspace/principals/${PRINCIPAL}/automations/prompts/verify.md`,
      prompt_hash: `sha256:${'b'.repeat(64)}`,
      executor_policy: 'principal_selected' as const,
      filesystem_access: 'read_only' as const,
      result_schema: { ref: 'result_v1', schema: null },
    };
    const actionEvent = buildCollaborationEventV3({
      groupId: 'group_test',
      eventId: 'evt_action_old',
      aggregateType: 'workspace',
      aggregateId: PRINCIPAL,
      aggregateRevision: 1,
      previousEventHash: null,
      eventType: 'action_published',
      actor: {
        principal_id: PRINCIPAL,
        client_id: CLIENT,
        executor_id: null,
      },
      occurredAt: NOW,
      payload: { action },
    });
    const actionCommit = 'b'.repeat(40);
    const records = [
      { event: initial.event, commitHash: 'a'.repeat(40), commitOrder: 1 },
      { event: actionEvent, commitHash: actionCommit, commitOrder: 2 },
      ...Array.from({ length: 5_001 }, (_, index) => ({
        event: {
          ...initial.event,
          event_id: `evt_noise_${String(index)}`,
          aggregate_type: 'workspace' as const,
          aggregate_id: `noise_${String(index)}`,
        },
        commitHash: (index + 3).toString(16).padStart(40, '0'),
        commitOrder: index + 3,
      })),
    ];
    store.saveVerifiedProjection({
      groupId: 'group_test',
      verifiedHead: records.at(-1)!.commitHash,
      projection: initial.projection,
      eventRecords: records,
    });

    expect(
      store
        .listEventRecords('group_test', 5_000)
        .some((record) => record.event.event_id === 'evt_action_old'),
    ).toBe(false);
    expect(
      store.findActionSnapshot({
        groupId: 'group_test',
        ownerPrincipalId: PRINCIPAL,
        actionId: 'verify',
        actionHash: collaborationCanonicalHashV3(action),
        promptHash: action.prompt_hash,
      }),
    ).toMatchObject({ action, commitHash: actionCommit, commitOrder: 2 });
    expect(
      store.findActionSnapshot({
        groupId: 'group_test',
        ownerPrincipalId: PRINCIPAL,
        actionId: 'verify',
        actionHash: `sha256:${'f'.repeat(64)}`,
        promptHash: action.prompt_hash,
      }),
    ).toBeNull();
    expect(store.hasVerifiedCommit('group_test', actionCommit)).toBe(true);
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

  it('keeps staged Artifact bytes local until commit and expires abandoned uploads', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('artifacts.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'member',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      signingKeyPath: '/tmp/id_ed25519',
      signingPublicKey: 'ssh-ed25519 test',
      signingKeyRef: 'ssh-ed25519:SHA256:alice',
    });
    const staged = store.stageArtifact({
      artifactId: 'artifact_committed',
      groupId: 'group_test',
      scopeType: 'work_item',
      scopeId: 'wi_1',
      principalId: PRINCIPAL,
      clientId: CLIENT,
      originalName: 'report.pdf',
      mediaType: 'application/pdf',
      contents: Buffer.from('%PDF artifact'),
      nowMs: 100,
      expiresAtMs: 200,
    });
    expect(store.readStagedArtifact(staged.artifactId, 150).contents).toEqual(
      Buffer.from('%PDF artifact'),
    );
    store.markStagedArtifactsCommitted([staged.artifactId], 175);
    expect(store.getStagedArtifact(staged.artifactId)).toMatchObject({
      state: 'committed',
      committedAtMs: 175,
    });
    expect(existsSync(staged.stagedPath)).toBe(false);

    const abandoned = store.stageArtifact({
      artifactId: 'artifact_abandoned',
      groupId: 'group_test',
      scopeType: 'workflow_turn',
      scopeId: 'wfi_1',
      turnId: 'turn_1',
      attempt: 1,
      fencingToken: `sha256:${'a'.repeat(64)}`,
      principalId: PRINCIPAL,
      clientId: CLIENT,
      originalName: 'trace.txt',
      mediaType: 'text/plain',
      contents: Buffer.from('trace'),
      nowMs: 100,
      expiresAtMs: 200,
    });
    expect(store.expireStagedArtifacts(200)).toBe(1);
    expect(store.getStagedArtifact(abandoned.artifactId)?.state).toBe(
      'expired',
    );
    expect(existsSync(abandoned.stagedPath)).toBe(false);
    store.close();
  });

  it('backs up, restores, and rolls back staged Artifact bytes with strict integrity', () => {
    const databasePath = temporaryPath('backup-artifacts.db');
    const backupDirectory = path.join(path.dirname(databasePath), 'backup');
    let store = new CollaborationProjectSpaceStore(databasePath);
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'member',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      signingKeyPath: '/tmp/id_ed25519',
      signingPublicKey: 'ssh-ed25519 test',
      signingKeyRef: 'ssh-ed25519:SHA256:alice',
    });
    const backedUp = store.stageArtifact({
      artifactId: 'artifact_backed_up',
      groupId: 'group_test',
      scopeType: 'work_item',
      scopeId: 'wi_1',
      principalId: PRINCIPAL,
      clientId: CLIENT,
      originalName: 'evidence.bin',
      mediaType: 'application/octet-stream',
      contents: Buffer.from([0, 1, 2, 255]),
    });
    store.close();

    const manifest = createCollaborationProjectSpaceBackup({
      databasePath,
      backupDirectory,
      createdAt: new Date(NOW),
    });
    expect(manifest).toMatchObject({
      format: 'icarus.collaboration-backup/3',
      file: { sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
      staged_artifacts: {
        directory_basename: 'collaboration-staged-artifacts',
        files: [
          {
            artifact_id: 'artifact_backed_up',
            relative_path: 'artifact_backed_up/evidence.bin',
            size: 4,
            sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          },
        ],
      },
    });

    store = new CollaborationProjectSpaceStore(databasePath);
    store.markStagedArtifactsCommitted([backedUp.artifactId]);
    const replacement = store.stageArtifact({
      artifactId: 'artifact_replacement',
      groupId: 'group_test',
      scopeType: 'work_item',
      scopeId: 'wi_1',
      principalId: PRINCIPAL,
      clientId: CLIENT,
      originalName: 'replacement.txt',
      mediaType: 'text/plain',
      contents: Buffer.from('replacement'),
    });
    store.close();

    const restored = restoreCollaborationProjectSpaceBackup({
      databasePath,
      backupDirectory,
    });
    expect(restored.rollbackDirectory).not.toBeNull();
    store = new CollaborationProjectSpaceStore(databasePath);
    expect(store.readStagedArtifact(backedUp.artifactId).contents).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(store.getStagedArtifact(replacement.artifactId)).toBeNull();
    store.close();

    rollbackCollaborationProjectSpaceRestore({
      databasePath,
      rollbackDirectory: restored.rollbackDirectory!,
    });
    store = new CollaborationProjectSpaceStore(databasePath);
    expect(store.getStagedArtifact(backedUp.artifactId)?.state).toBe(
      'committed',
    );
    expect(store.readStagedArtifact(replacement.artifactId).contents).toEqual(
      Buffer.from('replacement'),
    );
    store.close();

    writeFileSync(
      path.join(
        backupDirectory,
        'collaboration-staged-artifacts',
        'artifact_backed_up',
        'evidence.bin',
      ),
      Buffer.from('tampered'),
    );
    expect(() =>
      restoreCollaborationProjectSpaceBackup({
        databasePath,
        backupDirectory,
      }),
    ).toThrow(/Artifact integrity verification failed/u);
    store = new CollaborationProjectSpaceStore(databasePath);
    expect(store.readStagedArtifact(replacement.artifactId).contents).toEqual(
      Buffer.from('replacement'),
    );
    store.close();
  });

  it('persists the first fenced action claim and records one durable receipt', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('executions.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'member',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: true,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      signingKeyPath: '/tmp/id_ed25519',
      signingPublicKey: 'ssh-ed25519 test',
      signingKeyRef: 'ssh-ed25519:SHA256:alice',
    });
    const first = store.claimActionExecution({
      groupId: 'group_test',
      instanceId: 'wfi_1',
      turnId: 'turn_1',
      epoch: 1,
      attempt: 1,
      claimantClientId: CLIENT,
      fencingToken: `sha256:${'a'.repeat(64)}`,
      operationKey: `sha256:${'b'.repeat(64)}`,
      executorId: 'executor_codex',
      executorKind: 'codex',
      nowMs: 100,
    });
    const duplicate = store.claimActionExecution({
      groupId: 'group_test',
      instanceId: 'wfi_1',
      turnId: 'turn_1',
      epoch: 1,
      attempt: 1,
      claimantClientId: 'client_other',
      fencingToken: `sha256:${'c'.repeat(64)}`,
      operationKey: `sha256:${'d'.repeat(64)}`,
      executorId: 'executor_other',
      executorKind: 'external',
      nowMs: 101,
    });
    expect(first.acquired).toBe(true);
    expect(duplicate).toMatchObject({
      acquired: false,
      execution: {
        executionId: first.execution.executionId,
        claimantClientId: CLIENT,
      },
    });
    expect(
      store.recordActionDispatchReceipt({
        executionId: first.execution.executionId,
        claimantClientId: CLIENT,
        fencingToken: `sha256:${'c'.repeat(64)}`,
        executionRef: 'provider:1',
        providerMetadata: {},
        receipt: { accepted: true },
      }),
    ).toBe(false);
    expect(
      store.recordActionDispatchReceipt({
        executionId: first.execution.executionId,
        claimantClientId: CLIENT,
        fencingToken: first.execution.fencingToken,
        executionRef: 'provider:1',
        providerMetadata: { opaque: true },
        receipt: { accepted: true },
        nowMs: 102,
      }),
    ).toBe(true);
    expect(
      store.recordActionDispatchReceipt({
        executionId: first.execution.executionId,
        claimantClientId: CLIENT,
        fencingToken: first.execution.fencingToken,
        executionRef: 'provider:duplicate',
        providerMetadata: {},
        receipt: {},
      }),
    ).toBe(false);
    expect(
      store.getActionExecution({
        groupId: 'group_test',
        turnId: 'turn_1',
        attempt: 1,
      }),
    ).toMatchObject({
      state: 'running',
      executionRef: 'provider:1',
      receipt: { accepted: true },
    });
    store.close();
  });
});
