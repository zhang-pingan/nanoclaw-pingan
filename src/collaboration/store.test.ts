import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CollaborationProjection,
  CollaborationTurn,
} from './protocol/index.js';
import {
  CollaborationStore,
  CURRENT_COLLABORATION_SCHEMA_VERSION,
  createCollaborationBackup,
  restoreCollaborationBackup,
} from './store.js';

const roots: string[] = [];

const executionColumns = [
  'execution_id',
  'group_id',
  'turn_id',
  'epoch',
  'attempt',
  'fencing_token',
  'operation_key',
  'executor_kind',
  'adapter',
  'state',
  'execution_ref',
  'provider_metadata_json',
  'receipt_json',
  'observation_json',
  'pending_result_event_json',
  'dispatch_started_at_ms',
  'receipt_recorded_at_ms',
  'provider_completed_at_ms',
  'created_at_ms',
  'updated_at_ms',
  'recovery_required_reason',
] as const;

function temporaryPath(name = 'collaboration.db'): {
  readonly root: string;
  readonly databasePath: string;
} {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'icarus-collaboration-store-'),
  );
  roots.push(root);
  return { root, databasePath: path.join(root, name) };
}

function rewriteExecutionTable(
  databasePath: string,
  rewrite: (schema: string) => string,
  rewriteRecoveryIndex: (schema: string) => string = (schema) => schema,
): void {
  const database = new Database(databasePath);
  try {
    const table = database
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'collaboration_action_executions'`,
      )
      .get() as { sql: string };
    const recoveryIndex = database
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'index' AND name = 'collaboration_executions_recovery_idx'`,
      )
      .get() as { sql: string };
    database.pragma('foreign_keys = OFF');
    database.exec('DROP INDEX collaboration_executions_recovery_idx');
    database.exec('DROP TABLE collaboration_action_executions');
    database.exec(rewrite(table.sql));
    database.exec(rewriteRecoveryIndex(recoveryIndex.sql));
  } finally {
    database.close();
  }
}

function executionTableInfo(store: CollaborationStore) {
  return store
    .rawDatabaseForTests()
    .prepare('PRAGMA table_info(collaboration_action_executions)')
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
}

function notificationTableInfo(store: CollaborationStore) {
  return store
    .rawDatabaseForTests()
    .prepare('PRAGMA table_info(collaboration_notification_deliveries)')
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
}

function register(store: CollaborationStore): void {
  store.registerGroup({
    groupId: 'ag_store',
    name: 'Store test',
    creatorPrincipalId: 'alice',
    localPrincipalId: 'alice',
    localAgentId: 'agent_alice',
    remoteUrl: '/tmp/remote.git',
    repositoryPath: '/tmp/local-clone',
    signingKeyPath: '/tmp/signing-key',
    signingPublicKey: 'ssh-ed25519 TEST',
    signingKeyRef: 'ssh-ed25519:SHA256:test',
    pollIntervalMs: 10_000,
    nowMs: 100,
  });
}

function saveBinding(store: CollaborationStore): void {
  store.saveExecutorBinding({
    groupId: 'ag_store',
    stateId: 'development',
    implementationHash: `sha256:${'d'.repeat(64)}`,
    actionHash: `sha256:${'e'.repeat(64)}`,
    executorKind: 'external',
    adapter: 'codex-task',
    agentJid: null,
    workspacePath: '/tmp/workspace',
    filesystemAccessCap: 'workspace_write',
    approvalPolicy: 'on-request',
    config: { binary: '/tmp/codex', desktop_visibility_confirmed: true },
    enabled: true,
    updatedAtMs: 200,
  });
}

function reserve(store: CollaborationStore) {
  const execution = store.reserveExecution({
    executionId: 'collaboration:execution-1',
    groupId: 'ag_store',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    fencingToken: `sha256:${'a'.repeat(64)}`,
    operationKey: `sha256:${'b'.repeat(64)}`,
    executorKind: 'external',
    adapter: 'codex-task',
    nowMs: 300,
  });
  return execution;
}

function projection(): {
  readonly projection: CollaborationProjection;
  readonly turn: CollaborationTurn;
} {
  const turn: CollaborationTurn = {
    turnId: 'turn_1',
    groupId: 'ag_store',
    epoch: 1,
    createdRevision: 1,
    createdAt: '2026-08-06T12:00:00.000Z',
    timeoutPolicy: null,
    startDeadlineAt: null,
    executionDeadlineAt: null,
    deadlineSnapshotHash: `sha256:${'f'.repeat(64)}`,
    startedAt: '2026-08-06T12:01:00.000Z',
    dispatchAcceptedAt: null,
    providerCompletedAt: null,
    awaitingConfirmationAt: null,
    completedAt: null,
    stateAdvancedAt: null,
    cancelledAt: null,
    recoveryRequestedAt: null,
    recoveredAt: null,
    timeoutObservations: [],
    machineHash: `sha256:${'e'.repeat(64)}`,
    stateId: 'development',
    role: 'developer',
    mode: 'manual',
    implementationRef: 'groups/implementations/developer/development.yaml',
    implementationHash: `sha256:${'d'.repeat(64)}`,
    actionRef: null,
    actionHash: null,
    promptHash: null,
    incomingHandoff: null,
    incomingHandoffHash: null,
    attempt: 1,
    idempotencyKey: `sha256:${'b'.repeat(64)}`,
    inputHash: `sha256:${'c'.repeat(64)}`,
    state: 'IN_PROGRESS',
    claimEventId: 'evt_claim',
    claimantPrincipalId: 'alice',
    claimantAgentId: 'agent_alice',
    fencingToken: `sha256:${'a'.repeat(64)}`,
    executionRef: null,
    executorResultHash: null,
    executorResult: null,
    completionResultHash: null,
    handoff: null,
    handoffHash: null,
    artifacts: [],
    outcome: null,
    recoveryReason: null,
  };
  return {
    turn,
    projection: {
      format: 'icarus.agent-group-projection/2',
      protocolVersion: 2,
      groupId: 'ag_store',
      epoch: 1,
      sequence: 2,
      revision: 2,
      lifecycle: 'RUNNING',
      businessState: 'development',
      creatorPrincipalId: 'alice',
      members: {},
      roleClaims: {},
      stateImplementations: {},
      turns: { turn_1: turn },
      activeTurnId: 'turn_1',
      lastHandoff: null,
      lastHandoffHash: null,
      seenEventIds: ['evt_genesis', 'evt_claim'],
      lastEventId: 'evt_claim',
      integrityStatus: 'OK',
      integrityMessage: null,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('CollaborationStore', () => {
  it('initializes a fresh database with an integer schema version and smoke structure', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      expect(
        store.rawDatabaseForTests().pragma('user_version', { simple: true }),
      ).toBe(CURRENT_COLLABORATION_SCHEMA_VERSION);
      expect(
        store
          .rawDatabaseForTests()
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
              WHERE type = 'table' AND name LIKE 'collaboration_%'`,
          )
          .get(),
      ).toMatchObject({ count: 15 });
      expect(executionTableInfo(store).map((column) => column.name)).toEqual(
        executionColumns,
      );
      expect(
        executionTableInfo(store).find((column) => column.name === 'epoch'),
      ).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 0 });
      expect(notificationTableInfo(store).map((column) => column.name)).toEqual(
        [
          'notification_id',
          'group_id',
          'turn_id',
          'attempt',
          'kind',
          'deadline_kind',
          'recipient_principal_id',
          'recipient_agent_id',
          'reminder_ordinal',
          'deadline_at_ms',
          'first_discovered_at_ms',
          'local_observed_at_ms',
          'delivered_at_ms',
        ],
      );
    } finally {
      store.close();
    }
  });

  it('rejects an obsolete schema without modifying it', () => {
    const test = temporaryPath();
    const legacy = new Database(test.databasePath);
    legacy.exec('CREATE TABLE legacy_data (id TEXT PRIMARY KEY)');
    legacy.pragma('user_version = 1');
    legacy.close();
    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /schema 1 is unsupported/,
    );
    const unchanged = new Database(test.databasePath, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(1);
      expect(
        unchanged
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_data'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      unchanged.close();
    }
  });

  it('fails closed without rewriting an unknown newer schema', () => {
    const test = temporaryPath();
    const future = new Database(test.databasePath);
    future.exec('CREATE TABLE future_data (id TEXT PRIMARY KEY)');
    future.pragma('user_version = 99');
    future.close();
    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /schema 99 is unsupported/,
    );
    const unchanged = new Database(test.databasePath, { readonly: true });
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(99);
      expect(
        unchanged
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_data'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      unchanged.close();
    }
  });

  it('blocks a current-version database with a missing required index', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    store
      .rawDatabaseForTests()
      .exec('DROP INDEX collaboration_executions_recovery_idx');
    store.close();
    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /missing index collaboration_executions_recovery_idx/,
    );
  });

  it.each([
    [
      'missing epoch',
      (schema: string) => schema.replace('\n  epoch INTEGER NOT NULL,', ''),
    ],
    [
      'TEXT epoch',
      (schema: string) =>
        schema.replace('epoch INTEGER NOT NULL', 'epoch TEXT NOT NULL'),
    ],
    [
      'nullable epoch',
      (schema: string) =>
        schema.replace('epoch INTEGER NOT NULL', 'epoch INTEGER'),
    ],
    [
      'an extra legacy column',
      (schema: string) =>
        schema.replace(
          'recovery_required_reason TEXT',
          'recovery_required_reason TEXT, legacy_epoch TEXT',
        ),
    ],
  ])('fails closed when executions has %s', (_label, rewrite) => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    store.close();
    rewriteExecutionTable(test.databasePath, rewrite);

    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /collaboration_action_executions.*(epoch|column|constraint)/i,
    );
  });

  it('fails closed when the executions recovery index has the wrong columns', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    store.close();
    rewriteExecutionTable(
      test.databasePath,
      (schema) => schema,
      (schema) =>
        schema.replace('(group_id, state, execution_ref)', '(group_id, state)'),
    );

    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /collaboration_executions_recovery_idx.*columns/i,
    );
  });

  it.each([
    [
      'operation key uniqueness',
      (schema: string) =>
        schema.replace(
          'operation_key TEXT NOT NULL UNIQUE',
          'operation_key TEXT NOT NULL',
        ),
    ],
    [
      'group deletion restriction',
      (schema: string) =>
        schema.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'),
    ],
  ])('fails closed without the executions %s constraint', (_label, rewrite) => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    store.close();
    rewriteExecutionTable(test.databasePath, rewrite);

    expect(() => new CollaborationStore(test.databasePath)).toThrow(
      /collaboration_action_executions.*constraint/i,
    );
  });

  it.each(['collaboration_memberships', 'collaboration_process_locks'])(
    'blocks a current-version database missing required table %s',
    (table) => {
      const test = temporaryPath();
      const store = new CollaborationStore(test.databasePath);
      store.rawDatabaseForTests().exec(`DROP TABLE ${table}`);
      store.close();
      expect(() => new CollaborationStore(test.databasePath)).toThrow(
        new RegExp(`table ${table} is missing column`),
      );
    },
  );

  it('keeps bindings and receipts when rebuildable projection/cache is cleared', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      saveBinding(store);
      const execution = reserve(store);
      store.markDispatchStarted(execution.executionId, 301);
      store.recordDispatchReceipt({
        executionId: execution.executionId,
        executionRef: 'external:1',
        providerMetadata: { thread_id: 'thread-1', turn_id: 'turn-1' },
        receipt: { accepted: true },
        nowMs: 302,
      });
      const value = projection();
      store.saveProjection({
        groupId: 'ag_store',
        headCommit: 'abc123',
        projection: value.projection,
        events: [],
        turns: [value.turn],
        nowMs: 400,
      });
      store.clearRebuildableState('ag_store');
      expect(store.getGroup('ag_store')?.headCommit).toBeNull();
      expect(
        store.getExecutorBinding(
          'ag_store',
          'development',
          `sha256:${'d'.repeat(64)}`,
          `sha256:${'e'.repeat(64)}`,
        ),
      ).toMatchObject({
        stateId: 'development',
        workspacePath: '/tmp/workspace',
      });
      expect(store.getExecutionForTurn('ag_store', 'turn_1', 1)).toMatchObject({
        executionRef: 'external:1',
        receipt: { accepted: true },
        providerMetadata: { thread_id: 'thread-1', turn_id: 'turn-1' },
      });
    } finally {
      store.close();
    }
  });

  it('persists inactive State Implementations in the projection cache', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const value = projection();
      const implementation = {
        format: 'icarus.agent-group-state-implementation/2' as const,
        role: 'developer',
        state_id: 'development',
        owner: { principal_id: 'alice', agent_id: 'agent_alice' },
        mode: 'manual' as const,
        action_ref: null,
        published_at_event: 'evt_impl',
      };
      value.projection.stateImplementations.development = {
        active: false,
        implementation,
        implementationRef: 'groups/implementations/developer/development.yaml',
        implementationHash: `sha256:${'d'.repeat(64)}`,
        action: null,
        actionHash: null,
        promptHash: null,
        publishedEventId: 'evt_impl',
      };
      store.saveProjection({
        groupId: 'ag_store',
        headCommit: 'abc123',
        projection: value.projection,
        events: [],
        turns: [value.turn],
        nowMs: 400,
      });

      const row = store
        .rawDatabaseForTests()
        .prepare(
          `SELECT active, implementation_json
             FROM collaboration_state_implementations
            WHERE group_id = ? AND state_id = ?`,
        )
        .get('ag_store', 'development') as {
        active: number;
        implementation_json: string;
      };
      expect(row.active).toBe(0);
      expect(JSON.parse(row.implementation_json)).toMatchObject({
        active: false,
        implementation: { state_id: 'development' },
      });
    } finally {
      store.close();
    }
  });

  it('marks receiptless reservations RECOVERY_REQUIRED instead of redispatching', () => {
    const test = temporaryPath();
    let store = new CollaborationStore(test.databasePath);
    register(store);
    const execution = reserve(store);
    store.markDispatchStarted(execution.executionId, 301);
    store.close();
    store = new CollaborationStore(test.databasePath);
    try {
      const recovered = store.markReceiptlessExecutionsForRecovery();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        executionId: execution.executionId,
        state: 'recovery_required',
      });
      expect(recovered[0]?.recoveryRequiredReason).toMatch(
        /redispatch is forbidden/,
      );
    } finally {
      store.close();
    }
  });

  it('records bounded sync history and clears it with rebuildable state', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const succeeded = store.startSyncAttempt('ag_store', 'head-before', 500);
      store.finishSyncAttempt({
        id: succeeded,
        groupId: 'ag_store',
        outcome: 'succeeded',
        headAfter: 'head-after',
        nowMs: 510,
      });
      const failed = store.startSyncAttempt('ag_store', 'head-after', 520);
      store.finishSyncAttempt({
        id: failed,
        groupId: 'ag_store',
        outcome: 'failed',
        headAfter: 'head-after',
        error: 'fetch failed',
        errorClass: 'runtime',
        nowMs: 530,
      });

      expect(store.listSyncAttempts('ag_store', 1)).toEqual([
        expect.objectContaining({
          id: failed,
          outcome: 'failed',
          error: 'fetch failed',
          completedAtMs: 530,
        }),
      ]);
      store.clearRebuildableState('ag_store');
      expect(store.listSyncAttempts('ag_store')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('reserves one execution for a stable operation key', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const first = reserve(store);
      const duplicate = store.reserveExecution({
        executionId: 'collaboration:should-not-win',
        groupId: 'ag_store',
        turnId: 'turn_1',
        epoch: 1,
        attempt: 1,
        fencingToken: `sha256:${'a'.repeat(64)}`,
        operationKey: `sha256:${'b'.repeat(64)}`,
        executorKind: 'external',
        adapter: 'codex-task',
      });
      expect(duplicate.executionId).toBe(first.executionId);
    } finally {
      store.close();
    }
  });

  it('keys local Bindings by State Implementation and Action without Prompt overrides', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      saveBinding(store);
      store.saveExecutorBinding({
        groupId: 'ag_store',
        stateId: 'review',
        implementationHash: `sha256:${'f'.repeat(64)}`,
        actionHash: `sha256:${'1'.repeat(64)}`,
        executorKind: 'workflow',
        adapter: null,
        agentJid: null,
        workspacePath: '/tmp/review-workspace',
        filesystemAccessCap: 'read_only',
        approvalPolicy: 'never',
        config: { workflow_ref: 'review-v1' },
        enabled: true,
        updatedAtMs: 201,
      });
      expect(store.listExecutorBindings('ag_store')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stateId: 'development',
            workspacePath: '/tmp/workspace',
          }),
          expect.objectContaining({
            stateId: 'review',
            workspacePath: '/tmp/review-workspace',
          }),
        ]),
      );
      const columns = store
        .rawDatabaseForTests()
        .prepare('PRAGMA table_info(collaboration_executor_bindings)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain(
        'prompt_override',
      );
    } finally {
      store.close();
    }
  });

  it('commits staged Artifacts transactionally and cleans only expired exact paths', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const first = store.stageArtifact({
        artifactId: 'artifact_first',
        groupId: 'ag_store',
        turnId: 'turn_1',
        attempt: 1,
        principalId: 'alice',
        agentId: 'agent_alice',
        originalName: 'first.txt',
        repositoryPath: 'artifacts/turn_1/artifact_first-first.txt',
        stagedPath: path.join(test.root, 'first.upload'),
        sha256: `sha256:${'a'.repeat(64)}`,
        size: 1,
        contentType: 'text/plain',
        nowMs: 100,
        ttlMs: 100,
      });
      const second = store.stageArtifact({
        artifactId: 'artifact_second',
        groupId: 'ag_store',
        turnId: 'turn_1',
        attempt: 1,
        principalId: 'alice',
        agentId: 'agent_alice',
        originalName: 'second.txt',
        repositoryPath: 'artifacts/turn_1/artifact_second-second.txt',
        stagedPath: path.join(test.root, 'second.upload'),
        sha256: `sha256:${'b'.repeat(64)}`,
        size: 1,
        contentType: 'text/plain',
        nowMs: 100,
        ttlMs: 1_000,
      });
      expect(() =>
        store.commitStagedArtifacts(
          [first.artifactId, 'artifact_missing'],
          150,
        ),
      ).toThrow(/cannot be committed/);
      expect(store.getStagedArtifact(first.artifactId)?.state).toBe('staged');
      expect(store.cleanupExpiredStagedArtifacts(200)).toEqual([
        first.stagedPath,
      ]);
      expect(store.getStagedArtifact(first.artifactId)).toBeNull();
      store.commitStagedArtifacts([second.artifactId], 250);
      expect(store.getStagedArtifact(second.artifactId)).toMatchObject({
        state: 'committed',
        committedAtMs: 250,
      });
      expect(store.cleanupExpiredStagedArtifacts(5_000)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('persists pending reminders with durable recipient and window deduplication', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const input = {
        notificationId: 'notification_first',
        groupId: 'ag_store',
        turnId: 'turn_1',
        attempt: 1,
        kind: 'timeout:role_owner',
        deadlineKind: 'start',
        recipientPrincipalId: 'alice',
        recipientAgentId: 'agent_alice',
        reminderOrdinal: 0,
        deadlineAtMs: 1_000,
        nowMs: 100,
      } as const;
      expect(store.enqueueNotification(input)).toEqual({
        enqueued: true,
        notification: expect.objectContaining({
          notificationId: 'notification_first',
          attempt: 1,
          deadlineKind: 'start',
          firstDiscoveredAtMs: 100,
          localObservedAtMs: 100,
          deliveredAtMs: null,
        }),
      });
      expect(
        store.enqueueNotification({
          ...input,
          notificationId: 'notification_loser',
          kind: 'timeout:creator+role_owner',
          nowMs: 125,
        }),
      ).toEqual({
        enqueued: false,
        notification: expect.objectContaining({
          notificationId: 'notification_first',
          firstDiscoveredAtMs: 100,
          localObservedAtMs: 125,
        }),
      });
      expect(
        store.enqueueNotification({
          ...input,
          notificationId: 'notification_stale_observer',
          nowMs: 110,
        }).notification.localObservedAtMs,
      ).toBe(125);
      expect(() =>
        store.enqueueNotification({
          ...input,
          deadlineAtMs: 1_001,
          nowMs: 130,
        }),
      ).toThrow(/deadline does not match/);

      const repeat = store.enqueueNotification({
        ...input,
        notificationId: 'notification_repeat',
        reminderOrdinal: 1,
        nowMs: 200,
      });
      const creator = store.enqueueNotification({
        ...input,
        notificationId: 'notification_creator',
        recipientPrincipalId: 'creator',
        recipientAgentId: 'agent_creator',
        nowMs: 200,
      });
      expect(repeat.enqueued).toBe(true);
      expect(creator.enqueued).toBe(true);
      expect(
        store.listPendingNotifications({
          recipientPrincipalId: 'alice',
          recipientAgentId: 'agent_alice',
          groupId: 'ag_store',
        }),
      ).toEqual([
        expect.objectContaining({
          notificationId: 'notification_first',
          reminderOrdinal: 0,
        }),
        expect.objectContaining({
          notificationId: 'notification_repeat',
          reminderOrdinal: 1,
        }),
      ]);
      expect(
        store.markNotificationDelivered({
          notificationId: 'notification_first',
          recipientPrincipalId: 'creator',
          recipientAgentId: 'agent_creator',
          nowMs: 250,
        }),
      ).toBe(false);
      expect(
        store.markNotificationDelivered({
          notificationId: 'notification_first',
          recipientPrincipalId: 'alice',
          recipientAgentId: 'agent_alice',
          nowMs: 250,
        }),
      ).toBe(true);
      expect(
        store.markNotificationDelivered({
          notificationId: 'notification_first',
          recipientPrincipalId: 'alice',
          recipientAgentId: 'agent_alice',
          nowMs: 251,
        }),
      ).toBe(false);
      expect(store.listNotificationsForAudit('ag_store', 'turn_1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            notificationId: 'notification_first',
            deliveredAtMs: 250,
          }),
          expect.objectContaining({
            notificationId: 'notification_creator',
            recipientPrincipalId: 'creator',
          }),
        ]),
      );
    } finally {
      store.close();
    }
  });

  it('records Provider completion once at the first terminal observation', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      const execution = reserve(store);
      store.saveObservation({
        executionId: execution.executionId,
        state: 'running',
        observation: { state: 'running' },
        nowMs: 310,
      });
      expect(
        store.getExecutionForTurn('ag_store', 'turn_1', 1)
          ?.providerCompletedAtMs,
      ).toBeNull();
      store.saveObservation({
        executionId: execution.executionId,
        state: 'succeeded',
        observation: { state: 'succeeded', result: { outcome: 'done' } },
        nowMs: 320,
      });
      store.saveObservation({
        executionId: execution.executionId,
        state: 'succeeded',
        observation: { state: 'succeeded', result: { outcome: 'done' } },
        nowMs: 330,
      });
      expect(store.getExecutionForTurn('ag_store', 'turn_1', 1)).toMatchObject({
        state: 'succeeded',
        providerCompletedAtMs: 320,
        updatedAtMs: 330,
      });
    } finally {
      store.close();
    }
  });

  it('backs up and explicitly restores receipts and local bindings', () => {
    const source = temporaryPath();
    const backupDirectory = path.join(source.root, 'backup');
    let store = new CollaborationStore(source.databasePath);
    register(store);
    saveBinding(store);
    const execution = reserve(store);
    store.markDispatchStarted(execution.executionId, 301);
    store.recordDispatchReceipt({
      executionId: execution.executionId,
      executionRef: 'external:backup',
      providerMetadata: { thread_id: 'thread-backup' },
      receipt: { durable: true },
      nowMs: 302,
    });
    createCollaborationBackup({
      databasePath: source.databasePath,
      backupDirectory,
      createdAt: new Date('2026-08-05T12:00:00.000Z'),
    });
    store.close();

    const destination = temporaryPath();
    restoreCollaborationBackup({
      databasePath: destination.databasePath,
      backupDirectory,
    });
    store = new CollaborationStore(destination.databasePath);
    try {
      expect(
        store.getExecutorBinding(
          'ag_store',
          'development',
          `sha256:${'d'.repeat(64)}`,
          `sha256:${'e'.repeat(64)}`,
        ),
      ).toMatchObject({
        stateId: 'development',
        workspacePath: '/tmp/workspace',
      });
      expect(store.getExecutionForTurn('ag_store', 'turn_1', 1)).toMatchObject({
        executionRef: 'external:backup',
        providerMetadata: { thread_id: 'thread-backup' },
        receipt: { durable: true },
      });
    } finally {
      store.close();
    }
  });

  it('refuses a backup after its database content is tampered', () => {
    const test = temporaryPath();
    const backupDirectory = path.join(test.root, 'backup');
    const store = new CollaborationStore(test.databasePath);
    register(store);
    createCollaborationBackup({
      databasePath: test.databasePath,
      backupDirectory,
    });
    store.close();
    const manifest = JSON.parse(
      readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8'),
    ) as { files: Array<{ name: string }> };
    writeFileSync(
      path.join(backupDirectory, manifest.files[0]!.name),
      'tampered',
    );
    const destination = temporaryPath();
    expect(() =>
      restoreCollaborationBackup({
        databasePath: destination.databasePath,
        backupDirectory,
      }),
    ).toThrow(/failed verification/);
  });

  it('refuses a manifest that omits or duplicates the database file', () => {
    const test = temporaryPath();
    const backupDirectory = path.join(test.root, 'backup');
    const store = new CollaborationStore(test.databasePath);
    register(store);
    createCollaborationBackup({
      databasePath: test.databasePath,
      backupDirectory,
    });
    store.close();
    const manifestPath = path.join(backupDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ name: string; size: number; sha256: string }>;
    };
    manifest.files = [manifest.files[0]!, manifest.files[0]!];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const destination = temporaryPath();
    expect(() =>
      restoreCollaborationBackup({
        databasePath: destination.databasePath,
        backupDirectory,
      }),
    ).toThrow(/one unique database file/);
  });

  it('provides a single-process lock per group', () => {
    const test = temporaryPath();
    const store = new CollaborationStore(test.databasePath);
    try {
      register(store);
      expect(store.tryAcquireGroupLock('ag_store', 'owner-a', 0, 100)).toBe(
        true,
      );
      expect(store.tryAcquireGroupLock('ag_store', 'owner-b', 0, 101)).toBe(
        false,
      );
      store.releaseGroupLock('ag_store', 'owner-a');
      expect(store.tryAcquireGroupLock('ag_store', 'owner-b', 0, 102)).toBe(
        true,
      );
    } finally {
      store.close();
    }
  });
});
