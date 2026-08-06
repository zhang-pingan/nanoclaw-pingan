import { describe, expect, it } from 'vitest';

import {
  buildCollaborationAudit,
  type BuildCollaborationAuditInput,
} from './audit.js';
import type { ValidatedCollaborationHistory } from './protocol/git-chain.js';
import type {
  CollaborationEvent,
  CollaborationRepositoryDefinition,
  HandoffEnvelope,
} from './protocol/schema.js';
import type {
  CollaborationProjection,
  CollaborationTurn,
} from './protocol/reducer.js';
import type {
  CollaborationExecutionRecord,
  CollaborationGroupRecord,
  CollaborationNotificationRecord,
} from './store.js';

const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

function event(input: {
  readonly sequence: number;
  readonly type: CollaborationEvent['event_type'];
  readonly occurredAt: string;
  readonly payload?: Record<string, unknown>;
  readonly actor?: { readonly principalId: string; readonly agentId: string };
}): CollaborationEvent {
  return {
    format: 'icarus.agent-group-event/2',
    protocol_version: 2,
    group_id: 'ag_audit',
    event_id: `evt_${input.sequence}`,
    epoch: 1,
    sequence: input.sequence,
    event_type: input.type,
    actor: {
      principal_id: input.actor?.principalId ?? 'creator',
      agent_id: input.actor?.agentId ?? 'agent_creator',
    },
    expected: { state_revision: input.sequence - 1 },
    payload: input.payload ?? {},
    occurred_at: input.occurredAt,
  };
}

const incomingHandoff: HandoffEnvelope = {
  format: 'icarus.agent-group-handoff/2',
  source_turn_id: 'turn_previous',
  outcome: 'continue',
  summary: 'Use /Users/alice/private and api_key=summary-secret',
  instruction: 'PRIVATE INSTRUCTION MUST NOT BE EXPORTED',
  markers: ['reviewed'],
  data_refs: ['data/context.json'],
  artifact_refs: ['artifacts/turn_previous/context.txt'],
  data: { password: 'HANDOFF-DATA-SECRET' },
};

const outgoingHandoff: HandoffEnvelope = {
  format: 'icarus.agent-group-handoff/2',
  source_turn_id: 'turn_audit',
  outcome: 'done',
  summary: 'Completed with token=outgoing-secret',
  instruction: 'OUTGOING PRIVATE INSTRUCTION',
  markers: ['complete', 'verified'],
  data_refs: ['data/result.json'],
  artifact_refs: ['artifacts/turn_audit/report.json'],
  data: { credential: 'OUTGOING-DATA-SECRET' },
};

function turn(): CollaborationTurn {
  return {
    turnId: 'turn_audit',
    groupId: 'ag_audit',
    epoch: 1,
    createdRevision: 2,
    createdAt: '2026-08-06T10:01:00.000Z',
    timeoutPolicy: {
      start_timeout_ms: 60_000,
      execution_timeout_ms: 120_000,
      reminder_interval_ms: 30_000,
      on_timeout: 'notify_only',
    },
    startDeadlineAt: '2026-08-06T10:06:00.000Z',
    executionDeadlineAt: '2026-08-06T10:08:00.000Z',
    deadlineSnapshotHash: hash('d'),
    startedAt: '2026-08-06T10:06:00.000Z',
    dispatchAcceptedAt: '2026-08-06T10:06:10.000Z',
    providerCompletedAt: '2026-08-06T10:07:00.000Z',
    awaitingConfirmationAt: '2026-08-06T10:07:00.000Z',
    completedAt: '2026-08-06T10:09:00.000Z',
    stateAdvancedAt: '2026-08-06T10:09:00.000Z',
    cancelledAt: null,
    recoveryRequestedAt: '2026-08-06T10:04:00.000Z',
    recoveredAt: '2026-08-06T10:05:00.000Z',
    timeoutObservations: [
      {
        attempt: 2,
        deadlineKind: 'start',
        deadlineAt: '2026-08-06T10:06:00.000Z',
        observedAt: '2026-08-06T10:06:30.000Z',
        turnSnapshotHash: hash('c'),
        actorPrincipalId: 'creator',
        actorAgentId: 'agent_creator',
        eventId: 'evt_7',
        sequence: 7,
      },
    ],
    machineHash: hash('m'),
    stateId: 'development',
    role: 'developer',
    mode: 'assisted',
    implementationRef: 'implementations/development.yaml',
    implementationHash: hash('i'),
    actionRef: 'actions/development.yaml',
    actionHash: hash('a'),
    promptHash: hash('p'),
    incomingHandoff,
    incomingHandoffHash: hash('n'),
    inputHash: hash('h'),
    attempt: 2,
    idempotencyKey: hash('k'),
    state: 'COMPLETED',
    claimEventId: 'evt_8',
    claimantPrincipalId: 'worker',
    claimantAgentId: 'agent_worker',
    fencingToken: hash('f'),
    executionRef: 'execution-public',
    executorResultHash: hash('x'),
    executorResult: { private_provider_result: 'RESULT-SECRET' },
    completionResultHash: hash('r'),
    handoff: outgoingHandoff,
    handoffHash: hash('o'),
    artifacts: [
      {
        artifact_id: 'artifact_report',
        turn_id: 'turn_audit',
        original_name: 'private-customer-name.json',
        repository_path: 'artifacts/turn_audit/report.json',
        sha256: hash('z'),
        size: 42,
        content_type: 'application/json',
        uploaded_by_principal_id: 'worker',
        uploaded_by_agent_id: 'agent_worker',
        created_at: '2026-08-06T10:08:30.000Z',
      },
    ],
    outcome: 'done',
    recoveryReason: 'provider stalled at /tmp/private-provider-state',
  };
}

function definition(): CollaborationRepositoryDefinition {
  return {
    group: {
      format: 'icarus.agent-group/2',
      protocol_version: 2,
      group_id: 'ag_audit',
      name: 'Audit group',
      creator: {
        principal_id: 'creator',
        signing_key_ref: 'ssh-ed25519:SHA256:creator',
      },
      control_branch: 'refs/heads/icarus/control',
      machine_ref: 'machine.yaml',
      required_roles: [{ role: 'developer', min_members: 1, max_members: 1 }],
      lifecycle_policy: {
        active_turn_pause: 'drain',
        stalled_turn_recovery: 'creator_command',
      },
    },
    machine: {
      format: 'icarus.agent-group-machine/2',
      initial_state: 'development',
      states: {
        development: {
          label: 'Development',
          owner_role: 'developer',
          terminal: false,
          transitions: [{ outcome: 'done', target_state: 'completed' }],
          timeout_policy: {
            start_timeout_ms: 60_000,
            execution_timeout_ms: 120_000,
            reminder_interval_ms: 30_000,
            on_timeout: 'notify_only',
          },
        },
        completed: { label: 'Completed', terminal: true, transitions: [] },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/2',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: [],
        owned_states: ['development'],
      },
    },
    actions: {},
    implementations: {},
  };
}

function events(): CollaborationEvent[] {
  const base = [
    event({
      sequence: 1,
      type: 'group_initialized',
      occurredAt: '2026-08-06T10:00:00.000Z',
      payload: {
        member: {
          principal_id: 'creator',
          agent_id: 'agent_creator',
          signing_key_ref: 'ssh-ed25519:SHA256:creator',
          signing_public_key: 'PUBLIC-KEY-MATERIAL-MUST-NOT-BE-IN-AUDIT',
        },
        role_claim: { role: 'developer' },
      },
    }),
    event({
      sequence: 2,
      type: 'turn_created',
      occurredAt: '2026-08-06T10:01:00.000Z',
      payload: {
        turn_id: 'turn_audit',
        state_id: 'development',
        role: 'developer',
        mode: 'assisted',
        attempt: 1,
        machine_hash: hash('m'),
        implementation_hash: hash('i'),
        action_hash: hash('a'),
        prompt_hash: hash('p'),
        input_hash: hash('h'),
        incoming_handoff: incomingHandoff,
        incoming_handoff_hash: hash('n'),
        start_deadline_at: '2026-08-06T10:02:00.000Z',
        deadline_snapshot_hash: hash('b'),
      },
    }),
    event({
      sequence: 3,
      type: 'turn_started',
      occurredAt: '2026-08-06T09:59:00.000Z',
      actor: { principalId: 'worker', agentId: 'agent_worker' },
      payload: {
        turn_id: 'turn_audit',
        attempt: 1,
        execution_deadline_at: '2026-08-06T10:01:00.000Z',
        deadline_snapshot_hash: hash('q'),
      },
    }),
    event({
      sequence: 4,
      type: 'turn_recovery_requested',
      occurredAt: '2026-08-06T10:04:00.000Z',
      payload: {
        turn_id: 'turn_audit',
        attempt: 1,
        reason: 'password=RECOVERY-SECRET /Users/alice/private',
      },
    }),
    event({
      sequence: 5,
      type: 'turn_recovered',
      occurredAt: '2026-08-06T10:05:00.000Z',
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        reason: 'retry',
        start_deadline_at: '2026-08-06T10:06:00.000Z',
        deadline_snapshot_hash: hash('c'),
      },
    }),
    event({
      sequence: 6,
      type: 'turn_timeout_observed',
      occurredAt: '2026-08-06T10:06:31.000Z',
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        deadline_kind: 'start',
        deadline_at: '2026-08-06T10:06:00.000Z',
        observed_at: '2026-08-06T10:06:30.000Z',
        turn_snapshot_hash: hash('c'),
      },
    }),
    event({
      sequence: 7,
      type: 'turn_started',
      occurredAt: '2026-08-06T10:06:00.000Z',
      actor: { principalId: 'worker', agentId: 'agent_worker' },
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        execution_deadline_at: '2026-08-06T10:08:00.000Z',
        deadline_snapshot_hash: hash('d'),
      },
    }),
    event({
      sequence: 8,
      type: 'action_dispatched',
      occurredAt: '2026-08-06T10:06:10.000Z',
      actor: { principalId: 'worker', agentId: 'agent_worker' },
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        execution_ref: 'execution-public',
      },
    }),
    event({
      sequence: 9,
      type: 'action_completed',
      occurredAt: '2026-08-06T10:07:00.000Z',
      actor: { principalId: 'worker', agentId: 'agent_worker' },
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        result_hash: hash('x'),
        result: {
          api_key: 'EVENT-PROVIDER-SECRET',
          workspace_path: '/Users/alice/provider',
        },
      },
    }),
    event({
      sequence: 10,
      type: 'turn_timeout_observed',
      occurredAt: '2026-08-06T10:08:30.000Z',
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        deadline_kind: 'execution',
        deadline_at: '2026-08-06T10:08:00.000Z',
        observed_at: '2026-08-06T10:08:29.000Z',
        turn_snapshot_hash: hash('d'),
      },
    }),
    event({
      sequence: 11,
      type: 'turn_completed',
      occurredAt: '2026-08-06T10:09:00.000Z',
      actor: { principalId: 'worker', agentId: 'agent_worker' },
      payload: {
        turn_id: 'turn_audit',
        attempt: 2,
        outcome: 'done',
        result_hash: hash('r'),
        handoff: outgoingHandoff,
        handoff_hash: hash('o'),
        artifacts: [
          {
            repository_path: 'artifacts/turn_audit/report.json',
            sha256: hash('z'),
          },
        ],
      },
    }),
    event({
      sequence: 12,
      type: 'group_pause_requested',
      occurredAt: '2026-08-06T10:10:00.000Z',
    }),
    event({
      sequence: 13,
      type: 'group_paused',
      occurredAt: '2026-08-06T10:10:01.000Z',
    }),
  ];
  return [
    base[10]!,
    base[2]!,
    ...base.slice(0, 2),
    ...base.slice(3, 10),
    ...base.slice(11),
  ];
}

function projection(value: CollaborationTurn): CollaborationProjection {
  return {
    format: 'icarus.agent-group-projection/2',
    protocolVersion: 2,
    groupId: 'ag_audit',
    epoch: 1,
    sequence: 13,
    revision: 13,
    lifecycle: 'PAUSED',
    businessState: 'completed',
    creatorPrincipalId: 'creator',
    members: {
      creator: [
        {
          format: 'icarus.agent-group-member/2',
          principal_id: 'creator',
          signing_key_ref: 'ssh-ed25519:SHA256:creator',
          signing_public_key: 'ssh-ed25519 PUBLIC-CREATOR',
          agent_id: 'agent_creator',
          capabilities: [],
          registered_at_event: 'evt_1',
        },
      ],
      worker: [
        {
          format: 'icarus.agent-group-member/2',
          principal_id: 'worker',
          signing_key_ref: 'ssh-ed25519:SHA256:worker',
          signing_public_key: 'ssh-ed25519 PUBLIC-WORKER',
          agent_id: 'agent_worker',
          capabilities: [],
          registered_at_event: 'evt_worker',
        },
      ],
    },
    roleClaims: {},
    stateImplementations: {},
    turns: { turn_audit: value },
    activeTurnId: null,
    lastHandoff: outgoingHandoff,
    lastHandoffHash: hash('o'),
    seenEventIds: Array.from({ length: 13 }, (_, index) => `evt_${index + 1}`),
    lastEventId: 'evt_13',
    integrityStatus: 'OK',
    integrityMessage: null,
  };
}

function group(value: CollaborationProjection): CollaborationGroupRecord {
  return {
    groupId: 'ag_audit',
    name: 'Audit group',
    creatorPrincipalId: 'creator',
    localPrincipalId: 'worker',
    localAgentId: 'agent_worker',
    lifecycle: 'PAUSED',
    businessState: 'completed',
    protocolStatus: 'OK',
    protocolError: null,
    projection: value,
    remoteUrl: 'https://user:REMOTE-PASSWORD@example.invalid/private.git',
    repositoryPath: '/Users/alice/private/repository',
    signingKeyPath: '/Users/alice/.ssh/id_ed25519',
    signingPublicKey: 'SIGNING-PUBLIC-KEY-MUST-NOT-LEAK-FROM-GROUP',
    signingKeyRef: 'ssh-ed25519:SHA256:local',
    pollIntervalMs: 10_000,
    nextSyncAtMs: 0,
    backoffAttempt: 0,
    lastSyncAtMs: null,
    lastError: null,
    headCommit: 'commit-13',
  };
}

function execution(): CollaborationExecutionRecord {
  return {
    executionId: 'execution-local-2',
    groupId: 'ag_audit',
    turnId: 'turn_audit',
    epoch: 1,
    attempt: 2,
    fencingToken: hash('f'),
    operationKey: 'operation-public',
    executorKind: 'external',
    adapter: 'codex-task',
    state: 'succeeded',
    executionRef: 'execution-public',
    providerMetadata: {
      transport: 'desktop',
      thread_id: 'thread-public',
      turn_id: 'provider-turn-public',
      nested: { run_id: 'run-public' },
      workspace_path: '/Users/alice/provider-workspace',
      api_key: 'PROVIDER-METADATA-SECRET',
      private_metadata: { credential: 'PRIVATE-METADATA-SECRET' },
    },
    receipt: {
      accepted: true,
      graph_run_id: 'graph-public',
      operationKey: 'receipt-operation-public',
      password: 'RECEIPT-PASSWORD-SECRET',
      private_receipt: 'PRIVATE-RECEIPT-SECRET',
    },
    observation: {
      provider_private_state: 'OBSERVATION-SECRET',
      path: '/tmp/observation',
    },
    pendingResultEvent: null,
    recoveryRequiredReason: null,
    dispatchStartedAtMs: Date.parse('2026-08-06T10:06:01.000Z'),
    receiptRecordedAtMs: Date.parse('2026-08-06T10:06:09.000Z'),
    providerCompletedAtMs: Date.parse('2026-08-06T10:06:59.000Z'),
    createdAtMs: Date.parse('2026-08-06T10:06:00.500Z'),
    updatedAtMs: Date.parse('2026-08-06T10:07:00.500Z'),
  };
}

function notification(): CollaborationNotificationRecord {
  return {
    notificationId: 'notification-start-0',
    groupId: 'ag_audit',
    turnId: 'turn_audit',
    attempt: 2,
    kind: 'turn_timeout',
    deadlineKind: 'start',
    recipientPrincipalId: 'worker',
    recipientAgentId: 'agent_worker',
    reminderOrdinal: 0,
    deadlineAtMs: Date.parse('2026-08-06T10:06:00.000Z'),
    firstDiscoveredAtMs: Date.parse('2026-08-06T10:06:30.000Z'),
    localObservedAtMs: Date.parse('2026-08-06T10:06:31.000Z'),
    deliveredAtMs: Date.parse('2026-08-06T10:06:32.000Z'),
  };
}

function fixture(): BuildCollaborationAuditInput {
  const turnValue = turn();
  const projectionValue = projection(turnValue);
  const eventValues = events();
  const history: ValidatedCollaborationHistory = {
    head: 'commit-13',
    commits: eventValues.map((value) => `commit-${value.sequence}`),
    events: eventValues,
    definition: definition(),
    projection: projectionValue,
    validation: {
      mode: 'full',
      validatedCommitCount: eventValues.length,
      totalSequence: 13,
      checkpointHead: null,
    },
  };
  return {
    group: group(projectionValue),
    history,
    eventRecords: [...eventValues].reverse().map((value) => ({
      event: value,
      commitHash: `commit-${value.sequence}`,
    })),
    executions: [execution()],
    notifications: [notification()],
    generatedAt: '2026-08-06T11:00:00.000Z',
  };
}

describe('collaboration audit', () => {
  it('builds a complete Group/Epoch/Turn audit from shared and local evidence', () => {
    const audit = buildCollaborationAudit(fixture());

    expect(audit.format).toBe('icarus.agent-group-audit/2');
    expect(audit.scope).toEqual({ groupId: 'ag_audit', epoch: 1 });
    expect(audit.group).toMatchObject({
      groupId: 'ag_audit',
      creatorPrincipalId: 'creator',
      lifecycle: 'PAUSED',
      businessState: 'completed',
      initialState: 'development',
    });
    expect(audit.group.machineHash).toMatch(/^sha256:/u);
    expect(audit.sharedEvents.map((value) => value.sequence)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
    expect(audit.sharedEvents[7]).toMatchObject({
      eventId: 'evt_8',
      revision: 8,
      commitHash: 'commit-8',
      signer: {
        principalId: 'worker',
        agentId: 'agent_worker',
        signingKeyRef: 'ssh-ed25519:SHA256:worker',
      },
    });
    expect(audit.controlEvents.map((value) => value.eventType)).toEqual([
      'turn_recovery_requested',
      'turn_recovered',
      'group_pause_requested',
      'group_paused',
    ]);

    const turnAudit = audit.turns[0]!;
    expect(turnAudit).toMatchObject({
      turnId: 'turn_audit',
      stateId: 'development',
      role: 'developer',
      mode: 'assisted',
      attempt: 2,
      status: 'COMPLETED',
      hashes: {
        machine: hash('m'),
        implementation: hash('i'),
        action: hash('a'),
        prompt: hash('p'),
        input: hash('h'),
      },
      claimant: { principalId: 'worker', agentId: 'agent_worker' },
      outcome: { value: 'done', targetState: 'completed' },
      deadlines: {
        startAt: '2026-08-06T10:06:00.000Z',
        executionAt: '2026-08-06T10:08:00.000Z',
      },
    });
    expect(turnAudit.incomingHandoff).toMatchObject({
      hash: hash('n'),
      markers: ['reviewed'],
      repositoryRefs: {
        data: ['data/context.json'],
        artifacts: ['artifacts/turn_previous/context.txt'],
      },
    });
    expect(turnAudit.outgoingHandoff).toMatchObject({
      hash: hash('o'),
      markers: ['complete', 'verified'],
    });
    expect(turnAudit.outgoingHandoff).not.toHaveProperty('instruction');
    expect(turnAudit.outgoingHandoff).not.toHaveProperty('data');
    expect(turnAudit.artifacts).toEqual([
      expect.objectContaining({
        artifactId: 'artifact_report',
        repositoryPath: 'artifacts/turn_audit/report.json',
        sha256: hash('z'),
        size: 42,
        contentType: 'application/json',
      }),
    ]);
    expect(turnAudit.timeoutObservations).toHaveLength(2);
    expect(turnAudit.reminders[0]).toMatchObject({
      deadlineKind: 'start',
      reminderOrdinal: 0,
      recipient: { principalId: 'worker', agentId: 'agent_worker' },
      firstDiscoveredAt: '2026-08-06T10:06:30.000Z',
    });
    expect(turnAudit.attempts.map((value) => value.attempt)).toEqual([1, 2]);
    expect(turnAudit.attempts[1]?.executions[0]).toMatchObject({
      operationKey: 'operation-public',
      providerRefs: {
        transport: 'desktop',
        threadId: 'thread-public',
        turnId: 'provider-turn-public',
        runId: 'run-public',
      },
      receipt: {
        accepted: true,
        graphRunId: 'graph-public',
        operationKey: 'receipt-operation-public',
      },
      localTimestamps: {
        dispatchAcceptedAt: '2026-08-06T10:06:09.000Z',
        providerCompletedAt: '2026-08-06T10:06:59.000Z',
      },
    });
  });

  it('uses sequence as authority and reports negative signed-event elapsed time as clock skew', () => {
    const audit = buildCollaborationAudit(fixture());
    const firstAttempt = audit.turns[0]!.attempts[0]!;

    expect(firstAttempt.sharedEventRefs.map((value) => value.sequence)).toEqual(
      [2, 3, 4],
    );
    expect(firstAttempt.durations.waitingToStart).toEqual({
      valueMs: null,
      reliable: false,
      clockSkew: true,
      fromSequence: 2,
      toSequence: 3,
    });
    expect(audit.turns[0]!.attempts[1]!.durations.waitingToStart).toEqual({
      valueMs: 60_000,
      reliable: true,
      clockSkew: false,
      fromSequence: 5,
      toSequence: 7,
    });
  });

  it('rejects a paginated event cache instead of exporting an incomplete chain', () => {
    const input = fixture();

    expect(() =>
      buildCollaborationAudit({
        ...input,
        eventRecords: input.eventRecords.slice(1),
      }),
    ).toThrow('complete contiguous signed chain');
  });

  it('strictly redacts provider, receipt, handoff, credential, and local path data', () => {
    const audit = buildCollaborationAudit(fixture());
    const serialized = JSON.stringify(audit);

    expect(serialized).not.toContain('REMOTE-PASSWORD');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('/tmp/');
    expect(serialized).not.toContain('PROVIDER-METADATA-SECRET');
    expect(serialized).not.toContain('PRIVATE-METADATA-SECRET');
    expect(serialized).not.toContain('RECEIPT-PASSWORD-SECRET');
    expect(serialized).not.toContain('PRIVATE-RECEIPT-SECRET');
    expect(serialized).not.toContain('OBSERVATION-SECRET');
    expect(serialized).not.toContain('EVENT-PROVIDER-SECRET');
    expect(serialized).not.toContain('HANDOFF-DATA-SECRET');
    expect(serialized).not.toContain('OUTGOING-DATA-SECRET');
    expect(serialized).not.toContain('PRIVATE INSTRUCTION');
    expect(serialized).not.toContain('SIGNING-PUBLIC-KEY-MUST-NOT-LEAK');
    expect(serialized).not.toContain(
      'PUBLIC-KEY-MATERIAL-MUST-NOT-BE-IN-AUDIT',
    );
    expect(serialized).not.toContain('private-customer-name.json');
    expect(serialized).not.toContain('provider_private_state');
    expect(serialized).not.toContain('workspace_path');
    expect(serialized).not.toContain('private_metadata');
    expect(serialized).not.toContain('private_receipt');
    expect(serialized).toContain('thread-public');
    expect(serialized).toContain('graph-public');
    expect(serialized).toContain('artifacts/turn_audit/report.json');
    expect(serialized).toContain('[REDACTED]');
  });
});
