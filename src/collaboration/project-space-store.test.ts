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
import { collaborationCredentialFingerprintV3 } from './protocol/v3-schema.js';

const temporaryDirectories: string[] = [];
const NOW = '2026-08-06T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const PRINCIPAL = 'principal_00000000-0000-4000-8000-000000000001';
const CLIENT = 'client_alice';
const CREDENTIAL = 'credential_alice';
const RECOVERY_CREDENTIAL = 'credential_alice_recovery';
const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const FINGERPRINT = collaborationCredentialFingerprintV3(PUBLIC_KEY);

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
    credential: {
      format: 'icarus.collaboration-credential/1' as const,
      credential_id: CREDENTIAL,
      principal_id: PRINCIPAL,
      client_id: CLIENT,
      public_key: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
      purpose: 'event_signing' as const,
      status: 'active' as const,
      created_at_event: 'evt_genesis',
      revoked_at_event: null,
    },
    recovery_credential: {
      format: 'icarus.collaboration-credential/1' as const,
      credential_id: RECOVERY_CREDENTIAL,
      principal_id: PRINCIPAL,
      client_id: CLIENT,
      public_key: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
      purpose: 'group_recovery' as const,
      status: 'active' as const,
      created_at_event: 'evt_genesis',
      revoked_at_event: null,
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
      credential_id: CREDENTIAL,
      executor_id: null,
    },
    occurredAt: NOW,
    payload,
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
}

const ANALYSIS_HEAD = 'a'.repeat(40);
const ANALYSIS_CONTEXT_HASH = `sha256:${'b'.repeat(64)}`;
const ANALYSIS_PROMPT_HASH = `sha256:${'c'.repeat(64)}`;

function registerMemberStore(name: string): CollaborationProjectSpaceStore {
  const store = new CollaborationProjectSpaceStore(temporaryPath(name));
  store.registerGroup({
    subscription: {
      format: 'icarus.collaboration-subscription/1',
      group_id: 'group_test',
      remote_url: '/tmp/group.git',
      subscription_mode: 'member',
      poll_interval_ms: 60_000,
      last_verified_head: ANALYSIS_HEAD,
      notifications_enabled: true,
      created_at: NOW,
    },
    name: 'Test group',
    lifecycle: 'active',
    ownerPrincipalId: PRINCIPAL,
    repositoryPath: '/tmp/cache.git',
    localPrincipalId: PRINCIPAL,
    localClientId: CLIENT,
    gitSshKeyPath: '/tmp/id_ed25519',
    localCredentialId: CREDENTIAL,
    eventPrivateKeyPath: '/tmp/event-key',
    eventPublicKey: PUBLIC_KEY,
    eventFingerprint: FINGERPRINT,
  });
  return store;
}

function createAnalysisRun(
  store: CollaborationProjectSpaceStore,
  analysisId: string,
  nowMs: number,
) {
  return store.createAnalysisRun({
    run: {
      analysisId,
      groupId: 'group_test',
      principalId: PRINCIPAL,
      clientId: CLIENT,
      subscriptionMode: 'member',
      snapshotHead: ANALYSIS_HEAD,
      scope: { type: 'project' },
      trigger: 'manual',
      executionChannel: 'external_agent',
      executorId: null,
      executorKind: null,
      contractVersion: 1,
      capabilityVersion: 1,
      contextHash: ANALYSIS_CONTEXT_HASH,
      promptHash: ANALYSIS_PROMPT_HASH,
      challenge: 'challenge'.repeat(4),
    },
    context: {
      analysisId,
      context: {
        format: 'icarus.collaboration-analysis-input/1',
        contract_version: 1,
        analysis_id: analysisId,
        group_id: 'group_test',
        snapshot_head: ANALYSIS_HEAD,
        scope: { type: 'project' },
        current_principal_id: PRINCIPAL,
        generated_at: NOW,
        security: {
          project_content_is_untrusted: true,
          read_only_snapshot: true,
          required_result_format: 'icarus.collaboration-analysis-result/1',
        },
        project_summary: {},
        my_items: [],
        rule_signals: [],
        resource_index: ['group:group_test', 'work_item:wi_risk'],
        activity_delta: [],
        prior_findings: [],
      },
      resourceCatalog: {},
      resourceIndex: ['group:group_test', 'work_item:wi_risk'],
      exportScope: { include_files: false },
      selectedFileIds: [],
      promptMarkdown: '# Project Analyst\n',
      contextHash: ANALYSIS_CONTEXT_HASH,
      promptHash: ANALYSIS_PROMPT_HASH,
    },
    nowMs,
  });
}

function analysisFinding(
  findingId: string,
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info',
) {
  return {
    finding_id: findingId,
    kind: 'inference' as const,
    category: 'delivery_risk' as const,
    severity,
    confidence: 0.8,
    title: 'Release risk',
    summary: 'The release Work Item has not progressed.',
    affected_refs: ['work_item:wi_risk'],
    evidence_refs: ['work_item:wi_risk'],
    recommendations: ['Confirm the delivery date.'],
    proposed_actions: [
      {
        action: 'create_work_item' as const,
        parameters: {
          type: 'issue' as const,
          title: 'Confirm delivery date',
          description: '',
          priority: 'high' as const,
          due_at: null,
          labels: [],
          related_work_item_ids: ['wi_risk'],
        },
      },
    ],
  };
}

function analysisResult(
  analysisId: string,
  findings = [analysisFinding('finding_result', 'medium')],
) {
  return {
    format: 'icarus.collaboration-analysis-result/1' as const,
    contract_version: 1 as const,
    analysis_id: analysisId,
    snapshot_head: ANALYSIS_HEAD,
    context_hash: ANALYSIS_CONTEXT_HASH,
    prompt_hash: ANALYSIS_PROMPT_HASH,
    challenge: 'challenge'.repeat(4),
    summary: {
      health: 'needs_attention' as const,
      headline: 'Project needs attention',
      details: 'One verified Finding needs review.',
    },
    findings,
  };
}

describe('Collaboration project space v3 store', () => {
  it('creates only the fresh v10 schema and rejects stale v9', () => {
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
    expect(
      (
        store
          .rawDatabaseForTests()
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name LIKE 'collaboration_analysis_%'
              ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).toEqual([
      'collaboration_analysis_action_applications',
      'collaboration_analysis_contexts',
      'collaboration_analysis_findings',
      'collaboration_analysis_results',
      'collaboration_analysis_runs',
    ]);
    expect(
      (
        store
          .rawDatabaseForTests()
          .pragma('table_info(collaboration_notifications)') as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining(['severity', 'read_at_ms', 'handled_at_ms']),
    );
    store.close();

    const stalePath = temporaryPath('stale.db');
    const stale = new Database(stalePath);
    stale.pragma('user_version = 9');
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
      gitSshKeyPath: path.join(os.homedir(), '.ssh', 'id_rsa'),
    });
    expect(
      store
        .rawDatabaseForTests()
        .prepare('SELECT COUNT(*) AS count FROM collaboration_principals')
        .get(),
    ).toEqual({ count: 0 });
    store.close();
  });

  it('detaches Group data transactionally while retaining identity recovery binding', () => {
    const store = registerMemberStore('detach.db');
    createAnalysisRun(store, 'analysis_detach', 100);
    store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'workflow_recovery',
      resourceType: 'turn',
      resourceId: 'turn_detach',
      reason: 'test',
      dedupeKey: 'detach:test',
      nowMs: 100,
    });
    const staged = store.stageArtifact({
      artifactId: 'artifact_detach',
      groupId: 'group_test',
      scopeType: 'work_item',
      scopeId: 'work_detach',
      principalId: PRINCIPAL,
      clientId: CLIENT,
      originalName: 'detach.txt',
      mediaType: 'text/plain',
      contents: Buffer.from('local only'),
      nowMs: 100,
      expiresAtMs: 200,
    });

    const plan = store.detachLocalGroup({
      groupId: 'group_test',
      reason: 'local_remove',
      terminalHead: ANALYSIS_HEAD,
      nowMs: 150,
    });
    expect(plan.detached).toBe(true);
    expect(plan.cleanupPaths).toEqual(
      expect.arrayContaining([
        '/tmp/cache.git',
        path.dirname(staged.stagedPath),
      ]),
    );
    expect(store.getGroup('group_test')).toBeNull();
    expect(store.listGroups()).toEqual([]);
    expect(store.getLocalGroupBinding('group_test')).toMatchObject({
      groupId: 'group_test',
      remoteUrl: '/tmp/group.git',
      principalId: PRINCIPAL,
      credentialId: CREDENTIAL,
      recoveryCredentialId: null,
      bindingState: 'cleanup_pending',
      detachReason: 'local_remove',
      terminalHead: ANALYSIS_HEAD,
      cleanupError: null,
    });
    const database = store.rawDatabaseForTests();
    for (const table of [
      'collaboration_groups',
      'collaboration_notifications',
      'collaboration_staged_artifacts',
      'collaboration_analysis_runs',
    ])
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });

    store.failLocalGroupCleanup('group_test', 'filesystem busy', 175);
    expect(store.getLocalGroupBinding('group_test')).toMatchObject({
      bindingState: 'cleanup_pending',
      cleanupError: 'filesystem busy',
    });
    store.completeLocalGroupCleanup('group_test', 200);
    expect(store.getLocalGroupBinding('group_test')).toMatchObject({
      bindingState: 'retained',
      cleanupPaths: [],
      cleanupError: null,
      principalId: PRINCIPAL,
      credentialId: CREDENTIAL,
    });
    store.close();
  });

  it('does not persist local notifications when the subscription disables them', () => {
    const store = new CollaborationProjectSpaceStore(
      temporaryPath('notifications-disabled.db'),
    );
    store.registerGroup({
      subscription: {
        format: 'icarus.collaboration-subscription/1',
        group_id: 'group_test',
        remote_url: '/tmp/group.git',
        subscription_mode: 'observer',
        poll_interval_ms: 60_000,
        last_verified_head: null,
        notifications_enabled: false,
        created_at: NOW,
      },
      name: 'Test group',
      lifecycle: 'active',
      ownerPrincipalId: PRINCIPAL,
      repositoryPath: '/tmp/cache.git',
    });
    expect(
      store.enqueueNotification({
        groupId: 'group_test',
        recipientPrincipalId: PRINCIPAL,
        recipientClientId: CLIENT,
        kind: 'protocol_sync_failure',
        resourceType: 'protocol',
        resourceId: 'group_test',
        reason: 'verified_sync_failed',
        dedupeKey: 'sync-disabled',
      }),
    ).toMatchObject({ enqueued: false });
    expect(
      store.listPendingNotifications({
        groupId: 'group_test',
        principalId: PRINCIPAL,
        clientId: CLIENT,
      }),
    ).toEqual([]);
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
    projection.recoveryRequests.recovery_phone = {
      format: 'icarus.collaboration-recovery-request/1',
      request_id: 'recovery_phone',
      request_hash: `sha256:${'d'.repeat(64)}`,
      type: 'identity_recovery',
      target_principal_id: PRINCIPAL,
      requested_client: {
        format: 'icarus.collaboration-client/1',
        principal_id: PRINCIPAL,
        client_id: 'client_phone',
        display_name: 'Alice Phone',
        capabilities: [],
        status: 'active',
        registered_at_event: 'evt_recovery',
      },
      requested_credential: {
        format: 'icarus.collaboration-credential/1',
        credential_id: 'credential_phone',
        principal_id: PRINCIPAL,
        client_id: 'client_phone',
        public_key: PUBLIC_KEY,
        fingerprint: FINGERPRINT,
        purpose: 'event_signing',
        status: 'active',
        created_at_event: 'evt_recovery',
        revoked_at_event: null,
      },
      status: 'pending',
      reason: null,
      created_at: NOW,
      expires_at: '2026-08-13T12:00:00.000Z',
      decided_at_event: null,
      decided_by_principal_id: null,
      decision_reason: null,
      approval_kind: null,
      revoked_credential_ids: [],
    };
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
    expect(
      store
        .rawDatabaseForTests()
        .prepare(
          `SELECT credential_id, purpose, status, fingerprint
             FROM collaboration_credentials
            WHERE group_id = ? ORDER BY credential_id`,
        )
        .all('group_test'),
    ).toEqual([
      {
        credential_id: CREDENTIAL,
        purpose: 'event_signing',
        status: 'active',
        fingerprint: FINGERPRINT,
      },
      {
        credential_id: RECOVERY_CREDENTIAL,
        purpose: 'group_recovery',
        status: 'active',
        fingerprint: FINGERPRINT,
      },
    ]);
    expect(
      store
        .rawDatabaseForTests()
        .prepare(
          `SELECT request_id, request_type, status, request_hash
             FROM collaboration_recovery_requests WHERE group_id = ?`,
        )
        .get('group_test'),
    ).toEqual({
      request_id: 'recovery_phone',
      request_type: 'identity_recovery',
      status: 'pending',
      request_hash: `sha256:${'d'.repeat(64)}`,
    });

    store.updateLocalIdentity({
      groupId: 'group_test',
      subscriptionMode: 'member',
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
      localCredentialId: CREDENTIAL,
      eventPrivateKeyPath: '/tmp/event-key',
      eventPublicKey: PUBLIC_KEY,
      eventFingerprint: FINGERPRINT,
    });
    expect(store.getGroup('group_test')).toMatchObject({
      subscriptionMode: 'member',
      lastVerifiedHead: 'a'.repeat(40),
      localPrincipalId: PRINCIPAL,
      localClientId: CLIENT,
    });
    store.updateGitSshKeyPath('group_test', '/tmp/git-transport-key');
    expect(store.getGroup('group_test')?.gitSshKeyPath).toBe(
      '/tmp/git-transport-key',
    );
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
      gitSshKeyPath: '/tmp/id_ed25519',
      localCredentialId: CREDENTIAL,
      eventPrivateKeyPath: '/tmp/event-key',
      eventPublicKey: PUBLIC_KEY,
      eventFingerprint: FINGERPRINT,
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
        credential_id: CREDENTIAL,
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
      gitSshKeyPath: '/tmp/id_ed25519',
      localCredentialId: CREDENTIAL,
      eventPrivateKeyPath: '/tmp/event-key',
      eventPublicKey: PUBLIC_KEY,
      eventFingerprint: FINGERPRINT,
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
      gitSshKeyPath: '/tmp/id_ed25519',
      localCredentialId: CREDENTIAL,
      eventPrivateKeyPath: '/tmp/event-key',
      eventPublicKey: PUBLIC_KEY,
      eventFingerprint: FINGERPRINT,
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
      gitSshKeyPath: '/tmp/id_ed25519',
      localCredentialId: CREDENTIAL,
      eventPrivateKeyPath: '/tmp/event-key',
      eventPublicKey: PUBLIC_KEY,
      eventFingerprint: FINGERPRINT,
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

  it('tracks notification read and handled state and reconciles resolved resources', () => {
    const store = registerMemberStore('notification-lifecycle.db');
    const assignment = store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'work_item_assignment',
      resourceType: 'work_item',
      resourceId: 'wi_assignment',
      reason: 'assignment_confirmation_required',
      dedupeKey: 'assignment:wi_assignment:1',
      severity: 'high',
      nowMs: 100,
    }).notification;
    const blocker = store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'work_item_blocked',
      resourceType: 'work_item',
      resourceId: 'wi_assignment',
      reason: 'blocked',
      dedupeKey: 'blocked:wi_assignment:1',
      severity: 'critical',
      nowMs: 101,
    }).notification;
    const mention = store.enqueueNotification({
      groupId: 'group_test',
      recipientPrincipalId: PRINCIPAL,
      recipientClientId: CLIENT,
      kind: 'discussion_mention',
      resourceType: 'discussion',
      resourceId: 'thread_review',
      reason: 'mentioned',
      dedupeKey: 'mention:thread_review:1',
      severity: 'medium',
      nowMs: 102,
    }).notification;
    expect(
      store.markNotificationDelivered(
        mention.notificationId,
        PRINCIPAL,
        CLIENT,
        105,
      ),
    ).toBe(true);
    expect(
      store
        .listPendingNotifications({
          groupId: 'group_test',
          principalId: PRINCIPAL,
          clientId: CLIENT,
        })
        .map((entry) => entry.notificationId),
    ).toEqual([assignment.notificationId, blocker.notificationId]);

    expect(
      store.markNotificationRead(
        assignment.notificationId,
        'principal_other',
        CLIENT,
        110,
      ),
    ).toBe(false);
    expect(
      store.markNotificationRead(
        assignment.notificationId,
        PRINCIPAL,
        CLIENT,
        110,
      ),
    ).toBe(true);
    expect(
      store.listNotifications({
        groupId: 'group_test',
        principalId: PRINCIPAL,
        clientId: CLIENT,
      }),
    ).toEqual([
      expect.objectContaining({
        notificationId: mention.notificationId,
        readAtMs: null,
      }),
      expect.objectContaining({
        notificationId: blocker.notificationId,
        readAtMs: null,
      }),
      expect.objectContaining({
        notificationId: assignment.notificationId,
        readAtMs: 110,
      }),
    ]);
    expect(
      store.handleNotificationsByKind({
        groupId: 'group_test',
        resourceType: 'work_item',
        resourceId: 'wi_assignment',
        kinds: ['work_item_assignment'],
        nowMs: 120,
      }),
    ).toBe(1);
    expect(
      store.handleNotificationsForResource({
        groupId: 'group_test',
        resourceType: 'work_item',
        resourceId: 'wi_assignment',
        nowMs: 121,
      }),
    ).toBe(1);
    expect(
      store.markNotificationHandled(
        mention.notificationId,
        PRINCIPAL,
        CLIENT,
        122,
      ),
    ).toBe(true);
    expect(
      store.listPendingNotifications({
        groupId: 'group_test',
        principalId: PRINCIPAL,
        clientId: CLIENT,
      }),
    ).toEqual([]);
    expect(
      store.listNotifications({
        groupId: 'group_test',
        principalId: PRINCIPAL,
        clientId: CLIENT,
        includeHandled: true,
        severity: 'critical',
      }),
    ).toEqual([
      expect.objectContaining({
        notificationId: blocker.notificationId,
        handledAtMs: 121,
      }),
    ]);
    store.close();
  });

  it('enforces Analysis Run transition CAS and rejects illegal transitions', () => {
    const store = registerMemberStore('analysis-state.db');
    expect(createAnalysisRun(store, 'analysis_state', 100)).toMatchObject({
      status: 'prepared',
      attempt: 0,
      snapshotHead: ANALYSIS_HEAD,
    });
    expect(() =>
      store.transitionAnalysisRun({
        analysisId: 'analysis_state',
        expectedStatus: 'prepared',
        nextStatus: 'completed',
      }),
    ).toThrow(/Illegal Analysis Run transition/u);

    expect(
      store.transitionAnalysisRun({
        analysisId: 'analysis_state',
        expectedStatus: 'prepared',
        nextStatus: 'awaiting_external_result',
        attempt: 1,
        nowMs: 110,
      }),
    ).toMatchObject({ status: 'awaiting_external_result', attempt: 1 });
    expect(() =>
      store.transitionAnalysisRun({
        analysisId: 'analysis_state',
        expectedStatus: 'prepared',
        nextStatus: 'awaiting_external_result',
      }),
    ).toThrow(/transition conflict/u);
    expect(
      store.transitionAnalysisRun({
        analysisId: 'analysis_state',
        expectedStatus: 'awaiting_external_result',
        nextStatus: 'validating',
      }),
    ).toMatchObject({ status: 'validating' });
    expect(
      store.transitionAnalysisRun({
        analysisId: 'analysis_state',
        expectedStatus: 'validating',
        nextStatus: 'ready_for_review',
      }),
    ).toMatchObject({ status: 'ready_for_review' });
    createAnalysisRun(store, 'analysis_running', 120);
    store.transitionAnalysisRun({
      analysisId: 'analysis_running',
      expectedStatus: 'prepared',
      nextStatus: 'running',
      attempt: 1,
      nowMs: 121,
    });
    createAnalysisRun(store, 'analysis_waiting', 130);
    store.transitionAnalysisRun({
      analysisId: 'analysis_waiting',
      expectedStatus: 'prepared',
      nextStatus: 'awaiting_external_result',
      nowMs: 131,
    });
    expect(store.markAnalysisRunsStale('group_test', 'd'.repeat(40))).toBe(3);
    expect(store.getAnalysisRun('analysis_state')).toMatchObject({
      status: 'stale',
      staleFromStatus: 'ready_for_review',
    });
    expect(store.getAnalysisRun('analysis_running')).toMatchObject({
      status: 'stale',
      staleFromStatus: 'running',
    });
    expect(store.getAnalysisRun('analysis_waiting')).toMatchObject({
      status: 'stale',
      staleFromStatus: 'awaiting_external_result',
    });
    store.close();
  });

  it('keeps every Analysis result submission as immutable attempt history', () => {
    const store = registerMemberStore('analysis-result-history.db');
    createAnalysisRun(store, 'analysis_history', 100);
    for (const attempt of [1, 2])
      store.saveAnalysisResult({
        analysisId: 'analysis_history',
        attempt,
        rawJson: JSON.stringify({ attempt }),
        rawHash: `sha256:${String(attempt).repeat(64)}`,
        validationErrors: [
          { code: 'invalid', path: '/', message: `attempt ${String(attempt)}` },
        ],
        nowMs: 100 + attempt,
      });
    expect(store.listAnalysisResults('analysis_history')).toMatchObject([
      { attempt: 2, rawJson: '{"attempt":2}' },
      { attempt: 1, rawJson: '{"attempt":1}' },
    ]);
    expect(() =>
      store.saveAnalysisResult({
        analysisId: 'analysis_history',
        attempt: 1,
        rawJson: '{"tampered":true}',
        rawHash: `sha256:${'9'.repeat(64)}`,
      }),
    ).toThrow(/UNIQUE constraint failed/u);
    store.close();
  });

  it('evolves Findings across runs and keeps action previews idempotent', () => {
    const store = registerMemberStore('analysis-findings.db');
    createAnalysisRun(store, 'analysis_first', 100);
    const firstFinding = analysisFinding('finding_first', 'medium');
    const secondFinding = analysisFinding('finding_second', 'high');
    store.transitionAnalysisRun({
      analysisId: 'analysis_first',
      expectedStatus: 'prepared',
      nextStatus: 'awaiting_external_result',
      attempt: 1,
      nowMs: 101,
    });
    store.transitionAnalysisRun({
      analysisId: 'analysis_first',
      expectedStatus: 'awaiting_external_result',
      nextStatus: 'validating',
      nowMs: 102,
    });
    store.saveAnalysisResult({
      analysisId: 'analysis_first',
      attempt: 1,
      rawJson: '{}',
      rawHash: `sha256:${'4'.repeat(64)}`,
      normalized: analysisResult('analysis_first', [firstFinding]),
      nowMs: 103,
    });
    store.transitionAnalysisRun({
      analysisId: 'analysis_first',
      expectedStatus: 'validating',
      nextStatus: 'ready_for_review',
      nowMs: 104,
    });
    store.replaceAnalysisFindings({
      analysisId: 'analysis_first',
      groupId: 'group_test',
      findings: [
        {
          finding: firstFinding,
          dedupeKey: 'delivery:wi_risk',
          lifecycle: 'new',
        },
      ],
      nowMs: 110,
    });
    createAnalysisRun(store, 'analysis_second', 200);

    expect(
      store.findPriorAnalysisFinding(
        'group_test',
        'delivery:wi_risk',
        'analysis_second',
      ),
    ).toMatchObject({
      analysisId: 'analysis_first',
      lifecycle: 'new',
      finding: { severity: 'medium' },
    });
    store.replaceAnalysisFindings({
      analysisId: 'analysis_second',
      groupId: 'group_test',
      findings: [
        {
          finding: secondFinding,
          dedupeKey: 'delivery:wi_risk',
          lifecycle: 'worsened',
        },
      ],
      nowMs: 210,
    });
    expect(
      store.decideAnalysisFinding({
        analysisId: 'analysis_second',
        findingId: 'finding_second',
        decision: 'false_positive',
        reason: 'Accepted risk',
        nowMs: 220,
      }),
    ).toMatchObject({
      lifecycle: 'dismissed',
      decision: 'false_positive',
      decisionReason: 'Accepted risk',
    });

    const proposedAction = secondFinding.proposed_actions[0]!;
    const firstPreview = store.saveAnalysisActionPreview({
      applicationId: 'application_first',
      operationKey: 'operation_stable',
      analysisId: 'analysis_second',
      findingId: 'finding_second',
      actionOrdinal: null,
      action: proposedAction,
      preview: { title: 'Confirm delivery date' },
      snapshotHead: ANALYSIS_HEAD,
      confirmationTokenHash: `sha256:${'e'.repeat(64)}`,
      nowMs: 230,
    });
    const duplicatePreview = store.saveAnalysisActionPreview({
      applicationId: 'application_duplicate',
      operationKey: 'operation_stable',
      analysisId: 'analysis_second',
      findingId: 'finding_second',
      actionOrdinal: 0,
      action: proposedAction,
      preview: { title: 'Tampered duplicate' },
      snapshotHead: ANALYSIS_HEAD,
      confirmationTokenHash: `sha256:${'f'.repeat(64)}`,
      nowMs: 240,
    });
    expect(duplicatePreview).toEqual(firstPreview);
    const editedPreview = store.saveAnalysisActionPreview({
      applicationId: 'application_edited',
      operationKey: 'operation_edited',
      analysisId: 'analysis_second',
      findingId: 'finding_second',
      actionOrdinal: null,
      action: proposedAction,
      preview: { title: 'Edited after explicit user review' },
      snapshotHead: ANALYSIS_HEAD,
      confirmationTokenHash: `sha256:${'1'.repeat(64)}`,
      nowMs: 245,
    });
    expect(editedPreview.applicationId).toBe('application_edited');
    expect(editedPreview.actionOrdinal).toBeNull();
    expect(
      store.listAnalysisActionApplications('analysis_second'),
    ).toHaveLength(2);
    expect(
      store.transitionAnalysisActionApplication({
        applicationId: firstPreview.applicationId,
        expectedState: 'previewed',
        nextState: 'applying',
        nowMs: 250,
      }),
    ).toMatchObject({ state: 'applying', confirmedAtMs: 250 });
    expect(() =>
      store.transitionAnalysisActionApplication({
        applicationId: firstPreview.applicationId,
        expectedState: 'previewed',
        nextState: 'applying',
      }),
    ).toThrow(/transition conflict/u);
    expect(() =>
      store.transitionAnalysisActionApplication({
        applicationId: firstPreview.applicationId,
        expectedState: 'applying',
        nextState: 'previewed',
      }),
    ).toThrow(/Illegal Analysis Action transition/u);
    store.close();
  });
});
