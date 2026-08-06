import { describe, expect, it, vi } from 'vitest';

import {
  authorizeCollaborationEvent,
  collaborationCanonicalHash,
  collaborationDeadlineAt,
  collaborationDeadlineSnapshotHash,
  collaborationFencingToken,
  collaborationIdempotencyKey,
  deterministicProjectionJson,
  parseProtocolVersion,
  handoffEnvelopeSchema,
  reduceCollaborationEvent,
  reduceCollaborationEvents,
  validateRepositoryDefinition,
  type CollaborationEvent,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
} from './index.js';

const ALICE_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const BOB_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview';

function definition(): CollaborationRepositoryDefinition {
  return validateRepositoryDefinition({
    group: {
      format: 'icarus.agent-group/2',
      protocol_version: 2,
      group_id: 'ag_test',
      name: 'Protocol test',
      creator: {
        principal_id: 'alice',
        signing_key_ref: 'ssh-ed25519:SHA256:alice',
      },
      control_branch: 'refs/heads/icarus/control',
      machine_ref: 'machine.yaml',
      required_roles: [
        { role: 'developer', min_members: 1, max_members: 1 },
        { role: 'reviewer', min_members: 1, max_members: 1 },
      ],
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
          transitions: [
            { outcome: 'ready_for_review', target_state: 'review' },
            { outcome: 'blocked', target_state: 'development' },
          ],
          timeout_policy: {
            start_timeout_ms: 60_000,
            execution_timeout_ms: 120_000,
            reminder_interval_ms: 30_000,
            on_timeout: 'notify_only',
          },
        },
        review: {
          label: 'Review',
          owner_role: 'reviewer',
          terminal: false,
          transitions: [
            { outcome: 'approved', target_state: 'completed' },
            { outcome: 'changes_requested', target_state: 'development' },
          ],
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
        required_capabilities: ['coding_task'],
        owned_states: ['development'],
      },
      reviewer: {
        format: 'icarus.agent-group-role/2',
        role: 'reviewer',
        display_name: 'Reviewer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: ['review_task'],
        owned_states: ['review'],
      },
    },
    actions: {},
    implementations: {},
  });
}

function member(
  principalId: string,
  agentId: string,
  eventId: string,
  capability: string,
  key = ALICE_KEY,
) {
  return {
    format: 'icarus.agent-group-member/2' as const,
    principal_id: principalId,
    signing_key_ref: `ssh-ed25519:SHA256:${principalId}`,
    signing_public_key: key,
    agent_id: agentId,
    capabilities: [capability],
    registered_at_event: eventId,
  };
}

function event(input: {
  type: CollaborationEvent['event_type'];
  id: string;
  sequence: number;
  revision: number;
  epoch?: number;
  actor?: string;
  agent?: string;
  payload?: Record<string, unknown>;
}): CollaborationEvent {
  return {
    format: 'icarus.agent-group-event/2',
    protocol_version: 2,
    group_id: 'ag_test',
    event_id: input.id,
    epoch: input.epoch ?? 1,
    sequence: input.sequence,
    event_type: input.type,
    actor: {
      principal_id: input.actor ?? 'alice',
      agent_id: input.agent ?? 'agent_alice',
    },
    expected: { state_revision: input.revision },
    payload: input.payload ?? {},
    occurred_at: '2026-08-06T12:00:00.000Z',
  };
}

function genesis(): CollaborationEvent {
  return event({
    type: 'group_initialized',
    id: 'evt_genesis',
    sequence: 1,
    revision: 0,
    payload: {
      member: member('alice', 'agent_alice', 'evt_genesis', 'coding_task'),
      role_claim: {
        format: 'icarus.agent-group-role-claim/2',
        role: 'developer',
        principal_id: 'alice',
        agent_id: 'agent_alice',
        claimed_at_event: 'evt_genesis',
      },
    },
  });
}

function implementationPayload(
  role: 'developer' | 'reviewer',
  stateId: 'development' | 'review',
  principalId: 'alice' | 'bob',
  agentId: 'agent_alice' | 'agent_bob',
  eventId: string,
) {
  const implementation = {
    format: 'icarus.agent-group-state-implementation/2' as const,
    role,
    state_id: stateId,
    owner: { principal_id: principalId, agent_id: agentId },
    mode: 'manual' as const,
    action_ref: null,
    published_at_event: eventId,
  };
  return {
    implementation,
    implementation_ref: `groups/implementations/${role}/${stateId}.yaml`,
    implementation_hash: collaborationCanonicalHash(implementation),
    action: null,
    action_hash: null,
    prompt_hash: null,
  };
}

function assistedImplementationPayload(eventId: string) {
  const actionRef = 'actions/developer/development/execute-development.yaml';
  const implementation = {
    format: 'icarus.agent-group-state-implementation/2' as const,
    role: 'developer',
    state_id: 'development',
    owner: { principal_id: 'alice', agent_id: 'agent_alice' },
    mode: 'assisted' as const,
    action_ref: actionRef,
    published_at_event: eventId,
  };
  const action = {
    format: 'icarus.agent-group-action/2' as const,
    action_id: 'execute-development',
    role: 'developer',
    state_id: 'development',
    kind: 'run_once' as const,
    input: {
      prompt_ref: 'prompts/developer/development/execute-development.md',
    },
    requirements: { filesystem_access: 'read_only' as const },
    result_schema: {
      ref: 'collaboration-state-result@2',
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string' },
          source: { type: 'integer' },
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  };
  return {
    implementation,
    implementation_ref: 'groups/implementations/developer/development.yaml',
    implementation_hash: collaborationCanonicalHash(implementation),
    action,
    action_hash: collaborationCanonicalHash(action),
    prompt_hash: `sha256:${'a'.repeat(64)}`,
  };
}

function readyEvents(): CollaborationEvent[] {
  return [
    genesis(),
    event({
      type: 'member_registered',
      id: 'evt_bob',
      sequence: 2,
      revision: 1,
      actor: 'bob',
      agent: 'agent_bob',
      payload: {
        member: member('bob', 'agent_bob', 'evt_bob', 'review_task', BOB_KEY),
      },
    }),
    event({
      type: 'role_claimed',
      id: 'evt_claim_reviewer',
      sequence: 3,
      revision: 2,
      actor: 'bob',
      agent: 'agent_bob',
      payload: {
        role: 'reviewer',
        principal_id: 'bob',
        agent_id: 'agent_bob',
      },
    }),
    event({
      type: 'state_implementation_published',
      id: 'evt_impl_dev',
      sequence: 4,
      revision: 3,
      payload: implementationPayload(
        'developer',
        'development',
        'alice',
        'agent_alice',
        'evt_impl_dev',
      ),
    }),
    event({
      type: 'state_implementation_published',
      id: 'evt_impl_review',
      sequence: 5,
      revision: 4,
      actor: 'bob',
      agent: 'agent_bob',
      payload: implementationPayload(
        'reviewer',
        'review',
        'bob',
        'agent_bob',
        'evt_impl_review',
      ),
    }),
  ];
}

function apply(
  projection: CollaborationProjection,
  next: CollaborationEvent,
): CollaborationProjection {
  return reduceCollaborationEvent(projection, next, definition());
}

function createTurn(
  projection: CollaborationProjection,
  stateId: 'development' | 'review',
  id: string,
): CollaborationEvent {
  const active = projection.stateImplementations[stateId]!;
  const machineHash = collaborationCanonicalHash(definition().machine);
  const timeoutPolicy =
    definition().machine.states[stateId]?.timeout_policy ?? null;
  const occurredAt = '2026-08-06T12:00:00.000Z';
  const startDeadlineAt = collaborationDeadlineAt(
    occurredAt,
    timeoutPolicy?.start_timeout_ms,
  );
  const inputHash = collaborationCanonicalHash({
    epoch: projection.epoch,
    machine_hash: machineHash,
    state_id: stateId,
    role: active.implementation.role,
    mode: active.implementation.mode,
    implementation_hash: active.implementationHash,
    action_hash: active.actionHash,
    prompt_hash: active.promptHash,
    incoming_handoff_hash: projection.lastHandoffHash,
    timeout_policy_snapshot: timeoutPolicy,
    start_deadline_at: startDeadlineAt,
  });
  return event({
    type: 'turn_created',
    id: `evt_${id}`,
    sequence: projection.sequence + 1,
    revision: projection.revision,
    payload: {
      turn_id: id,
      state_id: stateId,
      role: active.implementation.role,
      mode: active.implementation.mode,
      implementation_ref: active.implementationRef,
      implementation_hash: active.implementationHash,
      action_ref: active.implementation.action_ref,
      action_hash: active.actionHash,
      prompt_hash: active.promptHash,
      incoming_handoff: projection.lastHandoff,
      incoming_handoff_hash: projection.lastHandoffHash,
      machine_hash: machineHash,
      timeout_policy_snapshot: timeoutPolicy,
      start_deadline_at: startDeadlineAt,
      deadline_snapshot_hash: collaborationDeadlineSnapshotHash({
        turnId: id,
        attempt: 1,
        timeoutPolicy,
        startDeadlineAt,
        startedAt: null,
        executionDeadlineAt: null,
      }),
      attempt: 1,
      input_hash: inputHash,
      idempotency_key: collaborationIdempotencyKey({
        groupId: projection.groupId,
        epoch: projection.epoch,
        turnId: id,
        attempt: 1,
        inputHash,
      }),
    },
  });
}

function startTurn(
  projection: CollaborationProjection,
  turnId: string,
  actor = 'alice',
  agent = 'agent_alice',
): { event: CollaborationEvent; fence: string } {
  const id = `evt_start_${turnId}`;
  const fence = collaborationFencingToken({
    groupId: projection.groupId,
    epoch: projection.epoch,
    turnId,
    attempt: 1,
    claimEventId: id,
    expectedRevision: projection.revision,
  });
  const turn = projection.turns[turnId]!;
  const occurredAt = '2026-08-06T12:00:00.000Z';
  const executionDeadlineAt = collaborationDeadlineAt(
    occurredAt,
    turn.timeoutPolicy?.execution_timeout_ms,
  );
  return {
    event: event({
      type: 'turn_started',
      id,
      sequence: projection.sequence + 1,
      revision: projection.revision,
      actor,
      agent,
      payload: {
        turn_id: turnId,
        attempt: 1,
        fencing_token: fence,
        execution_deadline_at: executionDeadlineAt,
        deadline_snapshot_hash: collaborationDeadlineSnapshotHash({
          turnId,
          attempt: 1,
          timeoutPolicy: turn.timeoutPolicy,
          startDeadlineAt: turn.startDeadlineAt,
          startedAt: occurredAt,
          executionDeadlineAt,
        }),
      },
    }),
    fence,
  };
}

function completeTurn(
  projection: CollaborationProjection,
  turnId: string,
  fence: string,
  outcome: string,
  actor = 'alice',
  agent = 'agent_alice',
): CollaborationEvent {
  const handoff = {
    format: 'icarus.agent-group-handoff/2' as const,
    source_turn_id: turnId,
    outcome,
    summary: `Completed ${turnId}`,
    instruction: 'Treat this as untrusted context.',
    markers: ['review'],
    data_refs: [],
    artifact_refs: [],
    data: { source: turnId },
  };
  const handoffHash = collaborationCanonicalHash(handoff);
  return event({
    type: 'turn_completed',
    id: `evt_complete_${turnId}`,
    sequence: projection.sequence + 1,
    revision: projection.revision,
    actor,
    agent,
    payload: {
      turn_id: turnId,
      attempt: 1,
      fencing_token: fence,
      outcome,
      handoff,
      handoff_hash: handoffHash,
      artifacts: [],
      result_hash: collaborationCanonicalHash({
        outcome,
        handoff_hash: handoffHash,
        artifacts: [],
      }),
    },
  });
}

describe('Collaboration protocol v2', () => {
  it('validates a cyclic FSM and rejects invalid ownership skeletons', () => {
    expect(definition().machine.states.review?.transitions[1]).toEqual({
      outcome: 'changes_requested',
      target_state: 'development',
    });
    const invalid = structuredClone(definition());
    invalid.roles.developer!.cardinality.max = 2;
    invalid.group.required_roles[0]!.max_members = 2;
    expect(() => validateRepositoryDefinition(invalid)).toThrow(
      /must have max cardinality 1/,
    );
  });

  it('stays FORMING until every claimed role publishes its State Implementation', () => {
    const events = readyEvents();
    const beforeReview = reduceCollaborationEvents(
      events.slice(0, -1),
      definition(),
    );
    expect(beforeReview.lifecycle).toBe('FORMING');
    const ready = reduceCollaborationEvents(events, definition());
    expect(ready.lifecycle).toBe('READY');
    expect(ready.stateImplementations.development?.implementation.mode).toBe(
      'manual',
    );
    expect(ready.stateImplementations.development?.active).toBe(true);
  });

  it('requires an explicit revision to reactivate an implementation after Role reclaim', () => {
    let projection = reduceCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({
        type: 'role_released',
        id: 'evt_release_developer',
        sequence: 6,
        revision: 5,
        payload: {
          role: 'developer',
          principal_id: 'alice',
          agent_id: 'agent_alice',
        },
      }),
    );
    expect(projection.lifecycle).toBe('FORMING');
    expect(projection.stateImplementations.development?.active).toBe(false);
    expect(projection.stateImplementations.review?.active).toBe(true);

    projection = apply(
      projection,
      event({
        type: 'role_claimed',
        id: 'evt_reclaim_developer',
        sequence: 7,
        revision: 6,
        payload: {
          role: 'developer',
          principal_id: 'alice',
          agent_id: 'agent_alice',
        },
      }),
    );
    expect(projection.lifecycle).toBe('FORMING');
    expect(projection.stateImplementations.development?.active).toBe(false);

    projection = apply(
      projection,
      event({
        type: 'state_implementation_revised',
        id: 'evt_readopt_developer',
        sequence: 8,
        revision: 7,
        payload: implementationPayload(
          'developer',
          'development',
          'alice',
          'agent_alice',
          'evt_readopt_developer',
        ),
      }),
    );
    expect(projection.lifecycle).toBe('READY');
    expect(projection.stateImplementations.development?.active).toBe(true);
  });

  it('routes only a legal Outcome and carries a hashed Handoff into a cycle', () => {
    let projection = reduceCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({
        type: 'group_started',
        id: 'evt_group_started',
        sequence: 6,
        revision: 5,
        payload: { initial_handoff: null, initial_handoff_hash: null },
      }),
    );
    projection = apply(
      projection,
      createTurn(projection, 'development', 'turn_dev'),
    );
    expect(projection.turns.turn_dev).toMatchObject({
      createdAt: '2026-08-06T12:00:00.000Z',
      machineHash: collaborationCanonicalHash(definition().machine),
    });
    const devStart = startTurn(projection, 'turn_dev');
    projection = apply(projection, devStart.event);
    const mismatchedArtifacts = completeTurn(
      projection,
      'turn_dev',
      devStart.fence,
      'ready_for_review',
    );
    const mismatchedHandoff = mismatchedArtifacts.payload.handoff as {
      artifact_refs: string[];
    };
    mismatchedHandoff.artifact_refs = [
      'artifacts/turn_dev/artifact_missing-report.txt',
    ];
    mismatchedArtifacts.payload.handoff_hash = collaborationCanonicalHash(
      mismatchedArtifacts.payload.handoff,
    );
    mismatchedArtifacts.payload.result_hash = collaborationCanonicalHash({
      outcome: mismatchedArtifacts.payload.outcome,
      handoff_hash: mismatchedArtifacts.payload.handoff_hash,
      artifacts: [],
    });
    expect(() => apply(projection, mismatchedArtifacts)).toThrow(
      /artifact refs do not match/,
    );
    expect(() =>
      apply(
        projection,
        completeTurn(projection, 'turn_dev', devStart.fence, 'approved'),
      ),
    ).toThrow(/Outcome is not allowed/);
    projection = apply(
      projection,
      completeTurn(projection, 'turn_dev', devStart.fence, 'ready_for_review'),
    );
    expect(projection.businessState).toBe('review');
    expect(projection.lastHandoff?.summary).toBe('Completed turn_dev');

    projection = apply(
      projection,
      createTurn(projection, 'review', 'turn_review'),
    );
    expect(projection.turns.turn_review?.incomingHandoffHash).toBe(
      projection.lastHandoffHash,
    );
    const reviewStart = startTurn(
      projection,
      'turn_review',
      'bob',
      'agent_bob',
    );
    projection = apply(projection, reviewStart.event);
    projection = apply(
      projection,
      completeTurn(
        projection,
        'turn_review',
        reviewStart.fence,
        'changes_requested',
        'bob',
        'agent_bob',
      ),
    );
    expect(projection.businessState).toBe('development');
    expect(projection.activeTurnId).toBeNull();
  });

  it('fixes the machine snapshot and validates initial and completed Handoff data', () => {
    const events = readyEvents();
    events[3] = event({
      type: 'state_implementation_published',
      id: 'evt_impl_dev',
      sequence: 4,
      revision: 3,
      payload: assistedImplementationPayload('evt_impl_dev'),
    });
    let projection = reduceCollaborationEvents(events, definition());
    const invalidInitialHandoff = {
      format: 'icarus.agent-group-handoff/2' as const,
      source_turn_id: 'turn_initial',
      outcome: 'initial',
      summary: 'Invalid initial data',
      instruction: '',
      markers: [],
      data_refs: [],
      artifact_refs: [],
      data: { source: 'not-an-integer' },
    };
    expect(() =>
      apply(
        projection,
        event({
          type: 'group_started',
          id: 'evt_invalid_start',
          sequence: 6,
          revision: 5,
          payload: {
            initial_handoff: invalidInitialHandoff,
            initial_handoff_hash: collaborationCanonicalHash(
              invalidInitialHandoff,
            ),
          },
        }),
      ),
    ).toThrow(/Handoff data does not satisfy/);

    projection = apply(
      projection,
      event({
        type: 'group_started',
        id: 'evt_group_started',
        sequence: 6,
        revision: 5,
        payload: { initial_handoff: null, initial_handoff_hash: null },
      }),
    );
    const turnCreated = createTurn(projection, 'development', 'turn_dev');
    const staleMachine = structuredClone(turnCreated);
    staleMachine.payload.machine_hash = `sha256:${'f'.repeat(64)}`;
    expect(() => apply(projection, staleMachine)).toThrow(
      /machine snapshot is stale/,
    );

    projection = apply(projection, turnCreated);
    const started = startTurn(projection, 'turn_dev');
    projection = apply(projection, started.event);
    projection = apply(
      projection,
      event({
        type: 'action_dispatched',
        id: 'evt_dispatch',
        sequence: projection.sequence + 1,
        revision: projection.revision,
        payload: {
          turn_id: 'turn_dev',
          attempt: 1,
          fencing_token: started.fence,
          execution_ref: 'execution_1',
        },
      }),
    );
    const result = {
      format: 'icarus.collaboration-action-result/2',
      outcome: 'ready_for_review',
      summary: 'Executor result',
      instruction: '',
      markers: [],
      data: { outcome: 'ready_for_review', source: 'not-an-integer' },
      artifacts: [],
      error: null,
    };
    projection = apply(
      projection,
      event({
        type: 'action_completed',
        id: 'evt_action_completed',
        sequence: projection.sequence + 1,
        revision: projection.revision,
        payload: {
          turn_id: 'turn_dev',
          attempt: 1,
          fencing_token: started.fence,
          result,
          result_hash: collaborationCanonicalHash(result),
        },
      }),
    );
    expect(() =>
      apply(
        projection,
        completeTurn(projection, 'turn_dev', started.fence, 'ready_for_review'),
      ),
    ).toThrow(/Handoff data does not satisfy/);
  });

  it('cancels an unstarted turn without a fence and requires the exact fence after start', () => {
    let pending = reduceCollaborationEvents(readyEvents(), definition());
    pending = apply(
      pending,
      event({
        type: 'group_started',
        id: 'evt_group_started',
        sequence: pending.sequence + 1,
        revision: pending.revision,
        payload: { initial_handoff: null, initial_handoff_hash: null },
      }),
    );
    pending = apply(
      pending,
      createTurn(pending, 'development', 'turn_pending'),
    );
    const pendingCancellation = event({
      type: 'turn_cancelled',
      id: 'evt_cancel_pending',
      sequence: pending.sequence + 1,
      revision: pending.revision,
      payload: {
        turn_id: 'turn_pending',
        attempt: 1,
        fencing_token: null,
        reason: 'Paused before work started',
      },
    });
    const cancelled = apply(pending, pendingCancellation);
    expect(cancelled.activeTurnId).toBeNull();
    expect(cancelled.turns.turn_pending).toMatchObject({
      state: 'CANCELLED',
      fencingToken: null,
      recoveryReason: 'Paused before work started',
    });

    const start = startTurn(pending, 'turn_pending');
    const started = apply(pending, start.event);
    const missingFence = event({
      type: 'turn_cancelled',
      id: 'evt_cancel_started',
      sequence: started.sequence + 1,
      revision: started.revision,
      payload: {
        turn_id: 'turn_pending',
        attempt: 1,
        fencing_token: null,
        reason: 'Cancellation requested after start',
      },
    });
    expect(() => apply(started, missingFence)).toThrow(
      /requires its fencing token/,
    );
    const staleFence = structuredClone(missingFence);
    staleFence.payload.fencing_token = `sha256:${'e'.repeat(64)}`;
    expect(() => apply(started, staleFence)).toThrow(/fencing token is stale/);
    const exactFence = structuredClone(missingFence);
    exactFence.payload.fencing_token = start.fence;
    expect(apply(started, exactFence).turns.turn_pending?.state).toBe(
      'CANCELLED',
    );
  });

  it('snapshots deadlines and treats sequence as authoritative despite clock skew', () => {
    let projection = reduceCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({
        type: 'group_started',
        id: 'evt_group_started',
        sequence: projection.sequence + 1,
        revision: projection.revision,
        payload: { initial_handoff: null, initial_handoff_hash: null },
      }),
    );
    projection = apply(
      projection,
      createTurn(projection, 'development', 'turn_timed'),
    );
    const pending = projection.turns.turn_timed!;
    expect(pending).toMatchObject({
      startDeadlineAt: '2026-08-06T12:01:00.000Z',
      executionDeadlineAt: null,
      timeoutPolicy: {
        start_timeout_ms: 60_000,
        execution_timeout_ms: 120_000,
        reminder_interval_ms: 30_000,
        on_timeout: 'notify_only',
      },
    });
    const startObservation = event({
      type: 'turn_timeout_observed',
      id: 'evt_start_timeout',
      sequence: projection.sequence + 1,
      revision: projection.revision,
      payload: {
        turn_id: pending.turnId,
        attempt: pending.attempt,
        deadline_kind: 'start',
        deadline_at: pending.startDeadlineAt,
        // Reducer intentionally does not compare wall clocks.
        observed_at: '2026-08-05T00:00:00.000Z',
        turn_snapshot_hash: pending.deadlineSnapshotHash,
      },
    });
    projection = apply(projection, startObservation);
    expect(projection.turns.turn_timed?.timeoutObservations).toHaveLength(1);
    const duplicate = event({
      type: 'turn_timeout_observed',
      id: 'evt_start_timeout_duplicate',
      sequence: projection.sequence + 1,
      revision: projection.revision,
      payload: startObservation.payload,
    });
    expect(() => apply(projection, duplicate)).toThrow(/already exists/);

    const startedEvent = startTurn(projection, 'turn_timed');
    projection = apply(projection, startedEvent.event);
    const started = projection.turns.turn_timed!;
    expect(started).toMatchObject({
      startedAt: '2026-08-06T12:00:00.000Z',
      executionDeadlineAt: '2026-08-06T12:02:00.000Z',
      state: 'IN_PROGRESS',
    });
    const staleStart = structuredClone(startObservation);
    staleStart.event_id = 'evt_stale_start_timeout';
    staleStart.sequence = projection.sequence + 1;
    staleStart.expected.state_revision = projection.revision;
    expect(() => apply(projection, staleStart)).toThrow(
      /Start timeout requires a pending turn|already exists/,
    );
    const executionObservation = event({
      type: 'turn_timeout_observed',
      id: 'evt_execution_timeout',
      sequence: projection.sequence + 1,
      revision: projection.revision,
      payload: {
        turn_id: started.turnId,
        attempt: started.attempt,
        deadline_kind: 'execution',
        deadline_at: started.executionDeadlineAt,
        observed_at: '2030-01-01T00:00:00.000Z',
        turn_snapshot_hash: started.deadlineSnapshotHash,
      },
    });
    projection = apply(projection, executionObservation);
    expect(projection.turns.turn_timed?.state).toBe('IN_PROGRESS');
    expect(projection.turns.turn_timed?.timeoutObservations).toHaveLength(2);
  });

  it('rejects a self-selected fence and stale principal, agent, attempt, or fence', () => {
    let projection = reduceCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({
        type: 'group_started',
        id: 'evt_group_started',
        sequence: 6,
        revision: 5,
        payload: { initial_handoff: null, initial_handoff_hash: null },
      }),
    );
    projection = apply(
      projection,
      createTurn(projection, 'development', 'turn_dev'),
    );
    const start = startTurn(projection, 'turn_dev');
    const forged = structuredClone(start.event);
    forged.payload.fencing_token = `sha256:${'f'.repeat(64)}`;
    expect(() => apply(projection, forged)).toThrow(/not derived/);
    projection = apply(projection, start.event);
    const completion = completeTurn(
      projection,
      'turn_dev',
      start.fence,
      'ready_for_review',
    );
    for (const mutate of [
      (candidate: CollaborationEvent) => {
        candidate.actor.principal_id = 'bob';
      },
      (candidate: CollaborationEvent) => {
        candidate.actor.agent_id = 'other_agent';
      },
      (candidate: CollaborationEvent) => {
        candidate.payload.attempt = 2;
      },
      (candidate: CollaborationEvent) => {
        candidate.payload.fencing_token = `sha256:${'e'.repeat(64)}`;
      },
    ]) {
      const candidate = structuredClone(completion);
      mutate(candidate);
      expect(() =>
        authorizeCollaborationEvent(candidate, projection, {
          principalId: candidate.actor.principal_id,
          signingKeyRef:
            candidate.actor.principal_id === 'bob'
              ? 'ssh-ed25519:SHA256:bob'
              : 'ssh-ed25519:SHA256:alice',
        }),
      ).toThrow(
        /registered collaboration member|current claimant and fenced attempt/,
      );
    }
  });

  it('separates creator and role-owner authorization', () => {
    const forming = reduceCollaborationEvents(
      readyEvents().slice(0, 3),
      definition(),
    );
    const reviewerImplementation = event({
      type: 'state_implementation_published',
      id: 'evt_wrong_owner',
      sequence: 4,
      revision: 3,
      payload: implementationPayload(
        'reviewer',
        'review',
        'alice',
        'agent_alice',
        'evt_wrong_owner',
      ),
    });
    expect(() =>
      authorizeCollaborationEvent(reviewerImplementation, forming, {
        principalId: 'alice',
        signingKeyRef: 'ssh-ed25519:SHA256:alice',
      }),
    ).toThrow(/current role owner/);

    const creatorCommand = event({
      type: 'group_started',
      id: 'evt_bob_start',
      sequence: 4,
      revision: 3,
      actor: 'bob',
      agent: 'agent_bob',
      payload: { initial_handoff: null, initial_handoff_hash: null },
    });
    expect(() =>
      authorizeCollaborationEvent(creatorCommand, forming, {
        principalId: 'bob',
        signingKeyRef: 'ssh-ed25519:SHA256:bob',
      }),
    ).toThrow(/restricted to the group creator/);
  });

  it('serializes deterministically without locale ordering', () => {
    const projection = reduceCollaborationEvents(readyEvents(), definition());
    const expected = deterministicProjectionJson(projection);
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => -1);
    try {
      expect(deterministicProjectionJson(projection)).toBe(expected);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('fails closed on unsupported protocol versions', () => {
    expect(parseProtocolVersion(2)).toBe(2);
    expect(() => parseProtocolVersion(1)).toThrow(/unsupported/i);
  });

  it('bounds structured Handoff data', () => {
    expect(() =>
      handoffEnvelopeSchema.parse({
        format: 'icarus.agent-group-handoff/2',
        source_turn_id: 'turn_large',
        outcome: 'completed',
        summary: 'Large result',
        instruction: '',
        markers: [],
        data_refs: [],
        artifact_refs: [],
        data: { value: 'x'.repeat(1024 * 1024) },
      }),
    ).toThrow(/exceeds the 1 MiB limit/);
  });
});
