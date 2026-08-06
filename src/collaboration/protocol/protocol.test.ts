import { describe, expect, it, vi } from 'vitest';

import {
  authorizeCollaborationEvent,
  collaborationFencingToken,
  collaborationIdempotencyKey,
  deterministicProjectionJson,
  reduceCollaborationEvent,
  replayCollaborationEvents,
  validateRepositoryDefinition,
  type CollaborationEvent,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
} from './index.js';

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice';
const REVIEWER_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview';

function definition(): CollaborationRepositoryDefinition {
  return validateRepositoryDefinition({
    group: {
      format: 'icarus.agent-group/1',
      protocol_version: 1,
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
      format: 'icarus.agent-group-machine/1',
      initial_state: 'development',
      states: {
        development: {
          terminal: false,
          transitions: [
            {
              id: 'implement',
              actor_role: 'developer',
              action_ref: 'actions/implement.yaml',
              outcomes: { succeeded: 'review', failed: 'development' },
            },
          ],
        },
        review: {
          terminal: false,
          transitions: [
            {
              id: 'review',
              actor_role: 'reviewer',
              action_ref: 'actions/review.yaml',
              outcomes: { approved: 'completed', revise: 'development' },
            },
          ],
        },
        completed: { terminal: true, transitions: [] },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/1',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        allowed_transitions: ['implement'],
        executor_requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
        },
      },
      reviewer: {
        format: 'icarus.agent-group-role/1',
        role: 'reviewer',
        display_name: 'Reviewer',
        cardinality: { min: 1, max: 1 },
        allowed_transitions: ['review'],
        executor_requirements: {
          capability: 'review_task',
          interaction: 'visible_session',
        },
      },
    },
    actions: {
      implement: {
        format: 'icarus.agent-group-action/1',
        action_id: 'implement',
        kind: 'external',
        adapter: 'codex-task',
        input: { prompt_ref: 'prompts/implement.md' },
        requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
          filesystem_access: 'workspace_write',
        },
        result_schema: { ref: 'code-change-result@1' },
      },
      review: {
        format: 'icarus.agent-group-action/1',
        action_id: 'review',
        kind: 'run_once',
        input: { prompt_ref: 'prompts/review.md' },
        requirements: {
          capability: 'review_task',
          interaction: 'visible_session',
          filesystem_access: 'read_only',
        },
        result_schema: { ref: 'review-result@1' },
      },
    },
  });
}

function member(
  principalId: string,
  agentId: string,
  eventId: string,
  capability: string,
  key = PUBLIC_KEY,
) {
  return {
    format: 'icarus.agent-group-member/1' as const,
    principal_id: principalId,
    signing_key_ref: `ssh-ed25519:SHA256:${principalId}`,
    signing_public_key: key,
    agent_id: agentId,
    capabilities: [capability, 'visible_session'],
    registered_at_event: eventId,
  };
}

function event(input: {
  type: CollaborationEvent['event_type'];
  id: string;
  sequence: number;
  revision: number;
  actor?: string;
  agent?: string;
  payload?: Record<string, unknown>;
}): CollaborationEvent {
  return {
    format: 'icarus.agent-group-event/1',
    protocol_version: 1,
    group_id: 'ag_test',
    event_id: input.id,
    epoch: 1,
    sequence: input.sequence,
    event_type: input.type,
    actor: {
      principal_id: input.actor ?? 'alice',
      agent_id: input.agent ?? 'agent_alice',
    },
    expected: { state_revision: input.revision },
    payload: input.payload ?? {},
    occurred_at: '2026-08-05T12:00:00.000Z',
  };
}

function genesis(): CollaborationEvent {
  return event({
    type: 'group_initialized',
    id: 'evt_1',
    sequence: 1,
    revision: 0,
    payload: {
      member: member('alice', 'agent_alice', 'evt_1', 'coding_task'),
      role_claim: {
        format: 'icarus.agent-group-role-claim/1',
        role: 'developer',
        principal_id: 'alice',
        agent_id: 'agent_alice',
        claimed_at_event: 'evt_1',
      },
    },
  });
}

function readyEvents(): CollaborationEvent[] {
  return [
    genesis(),
    event({
      type: 'member_registered',
      id: 'evt_2',
      sequence: 2,
      revision: 1,
      actor: 'bob',
      agent: 'agent_bob',
      payload: {
        member: member(
          'bob',
          'agent_bob',
          'evt_2',
          'review_task',
          REVIEWER_KEY,
        ),
      },
    }),
    event({
      type: 'role_claimed',
      id: 'evt_3',
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
  ];
}

function apply(
  projection: CollaborationProjection,
  next: CollaborationEvent,
): CollaborationProjection {
  return reduceCollaborationEvent(projection, next, definition());
}

describe('Collaboration protocol', () => {
  it('validates definitions while allowing a cyclic FSM', () => {
    const parsed = definition();
    expect(parsed.machine.states.review.transitions[0]?.outcomes.revise).toBe(
      'development',
    );
  });

  it('replays a fixed formation vector deterministically', () => {
    const projection = replayCollaborationEvents(readyEvents(), definition());
    expect(projection).toMatchObject({
      format: 'icarus.agent-group-projection/1',
      protocolVersion: 1,
      groupId: 'ag_test',
      epoch: 1,
      sequence: 3,
      revision: 3,
      lifecycle: 'READY',
      businessState: 'development',
      creatorPrincipalId: 'alice',
      activeTurnId: null,
      lastEventId: 'evt_3',
      integrityStatus: 'OK',
    });
    expect(deterministicProjectionJson(projection)).toBe(
      deterministicProjectionJson(
        replayCollaborationEvents(structuredClone(readyEvents()), definition()),
      ),
    );
  });

  it('registers and claims roles per agent for one signing principal', () => {
    let projection = reduceCollaborationEvent(null, genesis(), definition());
    projection = apply(
      projection,
      event({
        type: 'member_registered',
        id: 'evt_2',
        sequence: 2,
        revision: 1,
        agent: 'agent_alice_second',
        payload: {
          member: member('alice', 'agent_alice_second', 'evt_2', 'review_task'),
        },
      }),
    );
    projection = apply(
      projection,
      event({
        type: 'role_claimed',
        id: 'evt_3',
        sequence: 3,
        revision: 2,
        agent: 'agent_alice_second',
        payload: {
          role: 'reviewer',
          principal_id: 'alice',
          agent_id: 'agent_alice_second',
        },
      }),
    );

    expect(projection.members.alice).toHaveLength(2);
    expect(projection.roleClaims.reviewer).toEqual([
      expect.objectContaining({
        principal_id: 'alice',
        agent_id: 'agent_alice_second',
      }),
    ]);
  });

  it('uses Unicode code-unit key order regardless of the host locale', () => {
    const projection = replayCollaborationEvents(readyEvents(), definition());
    projection.members = Object.fromEntries(
      ['\uE000', '\u{10000}', '\u00E4', 'a', 'Z'].map((key) => [
        key,
        projection.members.alice!,
      ]),
    );
    const expectedOrder = ['Z', 'a', '\u00E4', '\u{10000}', '\uE000'];

    expect(
      Object.keys(JSON.parse(deterministicProjectionJson(projection)).members),
    ).toEqual(expectedOrder);

    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => -1);
    try {
      expect(
        Object.keys(
          JSON.parse(deterministicProjectionJson(projection)).members,
        ),
      ).toEqual(expectedOrder);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('supports development -> review -> development with unique turns', () => {
    let projection = replayCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({ type: 'group_started', id: 'evt_4', sequence: 4, revision: 3 }),
    );
    const implementInputHash = `sha256:${'1'.repeat(64)}`;
    projection = apply(
      projection,
      event({
        type: 'turn_created',
        id: 'evt_5',
        sequence: 5,
        revision: 4,
        payload: {
          turn_id: 'turn_implement_1',
          transition_id: 'implement',
          action_id: 'implement',
          role: 'developer',
          attempt: 1,
          input_hash: implementInputHash,
          idempotency_key: collaborationIdempotencyKey({
            groupId: 'ag_test',
            epoch: 1,
            turnId: 'turn_implement_1',
            attempt: 1,
            inputHash: implementInputHash,
          }),
        },
      }),
    );
    const implementFence = collaborationFencingToken({
      groupId: 'ag_test',
      epoch: 1,
      turnId: 'turn_implement_1',
      attempt: 1,
      claimEventId: 'evt_6',
      expectedRevision: 5,
    });
    projection = apply(
      projection,
      event({
        type: 'turn_claimed',
        id: 'evt_6',
        sequence: 6,
        revision: 5,
        payload: {
          turn_id: 'turn_implement_1',
          attempt: 1,
          fencing_token: implementFence,
        },
      }),
    );
    expect(projection.turns.turn_implement_1).toMatchObject({
      claimantPrincipalId: 'alice',
      claimantAgentId: 'agent_alice',
    });
    projection = apply(
      projection,
      event({
        type: 'action_dispatched',
        id: 'evt_7',
        sequence: 7,
        revision: 6,
        payload: {
          turn_id: 'turn_implement_1',
          attempt: 1,
          fencing_token: implementFence,
          execution_ref: 'external:implement',
        },
      }),
    );
    projection = apply(
      projection,
      event({
        type: 'action_succeeded',
        id: 'evt_8',
        sequence: 8,
        revision: 7,
        payload: {
          turn_id: 'turn_implement_1',
          attempt: 1,
          fencing_token: implementFence,
          result_hash: `sha256:${'2'.repeat(64)}`,
          artifact_refs: [],
        },
      }),
    );
    projection = apply(
      projection,
      event({
        type: 'state_transitioned',
        id: 'evt_9',
        sequence: 9,
        revision: 8,
        payload: {
          turn_id: 'turn_implement_1',
          attempt: 1,
          fencing_token: implementFence,
          outcome: 'succeeded',
          from_state: 'development',
          to_state: 'review',
        },
      }),
    );
    expect(projection.businessState).toBe('review');

    const reviewInputHash = `sha256:${'3'.repeat(64)}`;
    projection = apply(
      projection,
      event({
        type: 'turn_created',
        id: 'evt_10',
        sequence: 10,
        revision: 9,
        payload: {
          turn_id: 'turn_review_1',
          transition_id: 'review',
          action_id: 'review',
          role: 'reviewer',
          attempt: 1,
          input_hash: reviewInputHash,
          idempotency_key: collaborationIdempotencyKey({
            groupId: 'ag_test',
            epoch: 1,
            turnId: 'turn_review_1',
            attempt: 1,
            inputHash: reviewInputHash,
          }),
        },
      }),
    );
    const reviewFence = collaborationFencingToken({
      groupId: 'ag_test',
      epoch: 1,
      turnId: 'turn_review_1',
      attempt: 1,
      claimEventId: 'evt_11',
      expectedRevision: 10,
    });
    for (const next of [
      event({
        type: 'turn_claimed',
        id: 'evt_11',
        sequence: 11,
        revision: 10,
        actor: 'bob',
        agent: 'agent_bob',
        payload: {
          turn_id: 'turn_review_1',
          attempt: 1,
          fencing_token: reviewFence,
        },
      }),
      event({
        type: 'action_dispatched',
        id: 'evt_12',
        sequence: 12,
        revision: 11,
        actor: 'bob',
        agent: 'agent_bob',
        payload: {
          turn_id: 'turn_review_1',
          attempt: 1,
          fencing_token: reviewFence,
          execution_ref: 'run-once:review',
        },
      }),
      event({
        type: 'action_succeeded',
        id: 'evt_13',
        sequence: 13,
        revision: 12,
        actor: 'bob',
        agent: 'agent_bob',
        payload: {
          turn_id: 'turn_review_1',
          attempt: 1,
          fencing_token: reviewFence,
          result_hash: `sha256:${'4'.repeat(64)}`,
          artifact_refs: [],
        },
      }),
      event({
        type: 'state_transitioned',
        id: 'evt_14',
        sequence: 14,
        revision: 13,
        actor: 'bob',
        agent: 'agent_bob',
        payload: {
          turn_id: 'turn_review_1',
          attempt: 1,
          fencing_token: reviewFence,
          outcome: 'revise',
          from_state: 'review',
          to_state: 'development',
        },
      }),
    ])
      projection = apply(projection, next);

    expect(projection.businessState).toBe('development');
    expect(Object.keys(projection.turns)).toEqual([
      'turn_implement_1',
      'turn_review_1',
    ]);
  });

  it('rejects stale revisions and stale fencing tokens after recovery', () => {
    let projection = replayCollaborationEvents(readyEvents(), definition());
    projection = apply(
      projection,
      event({ type: 'group_started', id: 'evt_4', sequence: 4, revision: 3 }),
    );
    const inputHash = `sha256:${'a'.repeat(64)}`;
    projection = apply(
      projection,
      event({
        type: 'turn_created',
        id: 'evt_5',
        sequence: 5,
        revision: 4,
        payload: {
          turn_id: 'turn_recover',
          transition_id: 'implement',
          action_id: 'implement',
          role: 'developer',
          attempt: 1,
          input_hash: inputHash,
          idempotency_key: collaborationIdempotencyKey({
            groupId: 'ag_test',
            epoch: 1,
            turnId: 'turn_recover',
            attempt: 1,
            inputHash,
          }),
        },
      }),
    );
    const firstFence = collaborationFencingToken({
      groupId: 'ag_test',
      epoch: 1,
      turnId: 'turn_recover',
      attempt: 1,
      claimEventId: 'evt_6',
      expectedRevision: 5,
    });
    projection = apply(
      projection,
      event({
        type: 'turn_claimed',
        id: 'evt_6',
        sequence: 6,
        revision: 5,
        payload: {
          turn_id: 'turn_recover',
          attempt: 1,
          fencing_token: firstFence,
        },
      }),
    );
    const fencedData = event({
      type: 'data_updated',
      id: 'evt_data_fenced',
      sequence: 7,
      revision: 6,
      payload: {
        path: 'data/turn/status.txt',
        encoding: 'utf-8',
        content_sha256: `sha256:${'d'.repeat(64)}`,
        size_bytes: 0,
        turn_id: 'turn_recover',
        attempt: 1,
        fencing_token: firstFence,
      },
    });
    expect(() =>
      authorizeCollaborationEvent(fencedData, projection, {
        principalId: 'alice',
        signingKeyRef: 'ssh-ed25519:SHA256:alice',
      }),
    ).not.toThrow();
    expect(() =>
      authorizeCollaborationEvent(
        {
          ...fencedData,
          event_id: 'evt_data_hijack',
          actor: { principal_id: 'bob', agent_id: 'agent_bob' },
        },
        projection,
        {
          principalId: 'bob',
          signingKeyRef: 'ssh-ed25519:SHA256:bob',
        },
      ),
    ).toThrow(/winning claimant/);
    const samePrincipalProjection = {
      ...projection,
      members: {
        ...projection.members,
        alice: [
          ...(projection.members.alice ?? []),
          member(
            'alice',
            'agent_alice_second',
            'evt_agent_second',
            'coding_task',
          ),
        ],
      },
    };
    expect(() =>
      authorizeCollaborationEvent(
        {
          ...fencedData,
          event_id: 'evt_data_agent_hijack',
          actor: {
            principal_id: 'alice',
            agent_id: 'agent_alice_second',
          },
        },
        samePrincipalProjection,
        {
          principalId: 'alice',
          signingKeyRef: 'ssh-ed25519:SHA256:alice',
        },
      ),
    ).toThrow(/winning claimant/);
    expect(apply(projection, fencedData).revision).toBe(7);
    projection = apply(
      projection,
      event({
        type: 'stalled_turn_recovery_requested',
        id: 'evt_7',
        sequence: 7,
        revision: 6,
        payload: {
          turn_id: 'turn_recover',
          attempt: 1,
          fencing_token: firstFence,
          reason: 'receipt is uncertain',
        },
      }),
    );
    projection = apply(
      projection,
      event({
        type: 'turn_recovered',
        id: 'evt_8',
        sequence: 8,
        revision: 7,
        payload: {
          turn_id: 'turn_recover',
          attempt: 2,
          fencing_token: firstFence,
        },
      }),
    );
    expect(projection.turns.turn_recover?.state).toBe('WAITING');
    expect(() =>
      apply(
        projection,
        event({
          type: 'action_succeeded',
          id: 'evt_9',
          sequence: 9,
          revision: 8,
          payload: {
            turn_id: 'turn_recover',
            attempt: 1,
            fencing_token: firstFence,
            result_hash: `sha256:${'b'.repeat(64)}`,
            artifact_refs: [],
          },
        }),
      ),
    ).toThrow(/attempt is stale/);
    expect(() =>
      apply(
        projection,
        event({
          type: 'data_updated',
          id: 'evt_data_stale_fence',
          sequence: 9,
          revision: 8,
          payload: {
            path: 'data/turn/status.txt',
            encoding: 'utf-8',
            content_sha256: `sha256:${'d'.repeat(64)}`,
            size_bytes: 0,
            turn_id: 'turn_recover',
            attempt: 1,
            fencing_token: firstFence,
          },
        }),
      ),
    ).toThrow(/attempt is stale/);
    expect(() =>
      apply(
        projection,
        event({
          type: 'role_claimed',
          id: 'evt_bad_revision',
          sequence: 9,
          revision: 7,
          payload: {
            role: 'developer',
            principal_id: 'alice',
            agent_id: 'agent_alice',
          },
        }),
      ),
    ).toThrow(/Expected revision/);
  });

  it('enforces signer identity and creator-only lifecycle commands', () => {
    const projection = replayCollaborationEvents(readyEvents(), definition());
    const start = event({
      type: 'group_started',
      id: 'evt_4',
      sequence: 4,
      revision: 3,
      actor: 'bob',
      agent: 'agent_bob',
    });
    expect(() =>
      authorizeCollaborationEvent(start, projection, {
        principalId: 'bob',
        signingKeyRef: 'ssh-ed25519:SHA256:bob',
      }),
    ).toThrow(/restricted to the group creator/);
    expect(() =>
      authorizeCollaborationEvent(
        event({
          type: 'role_claimed',
          id: 'evt_4',
          sequence: 4,
          revision: 3,
          actor: 'bob',
          agent: 'agent_bob',
          payload: {
            role: 'reviewer',
            principal_id: 'bob',
            agent_id: 'agent_bob',
          },
        }),
        projection,
        {
          principalId: 'mallory',
          signingKeyRef: 'ssh-ed25519:SHA256:bob',
        },
      ),
    ).toThrow(/does not match event actor/);
  });

  it('fails closed on unsupported protocol versions', () => {
    const invalid = { ...genesis(), protocol_version: 2 };
    expect(() => replayCollaborationEvents([invalid], definition())).toThrow(
      /unsupported protocol version/,
    );
  });
});
