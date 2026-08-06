import { describe, expect, it } from 'vitest';

import {
  collaborationAuditEventTimeline,
  collaborationDuration,
  collaborationElapsed,
  collaborationIdentityOwnsRole,
  collaborationImplementationPrompt,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationTurnAccess,
  collaborationTurnDeadline,
  collaborationTurnHistory,
  collaborationTurnLifecycle,
} from './collaboration-ui.js';

function group(agentId = 'agent_local') {
  return {
    localPrincipalId: 'principal_alice',
    localAgentId: agentId,
    projection: {
      activeTurnId: 'turn_active',
      roleClaims: {
        developer: [
          {
            principal_id: 'principal_alice',
            agent_id: 'agent_local',
          },
        ],
      },
      turns: {
        turn_old: {
          turnId: 'turn_old',
          createdRevision: 2,
          state: 'COMPLETED',
        },
        turn_newer: {
          turnId: 'turn_newer',
          createdRevision: 5,
          state: 'COMPLETED',
        },
        turn_active: {
          turnId: 'turn_active',
          createdRevision: 8,
          state: 'PENDING_START',
        },
      },
    },
  };
}

describe('Collaboration runtime UI policy', () => {
  it('requires both principal and agent identity for Role and claimant actions', () => {
    const turn = {
      role: 'developer',
      state: 'PENDING_START',
      mode: 'manual',
      claimantPrincipalId: null,
      claimantAgentId: null,
    };
    expect(collaborationIdentityOwnsRole(group(), 'developer')).toBe(true);
    expect(collaborationTurnAccess(group(), turn)).toMatchObject({
      localRole: true,
      canStart: true,
      canComplete: false,
    });
    expect(
      collaborationIdentityOwnsRole(group('agent_other'), 'developer'),
    ).toBe(false);
    expect(collaborationTurnAccess(group('agent_other'), turn).canStart).toBe(
      false,
    );

    const claimed = {
      ...turn,
      state: 'IN_PROGRESS',
      claimantPrincipalId: 'principal_alice',
      claimantAgentId: 'agent_local',
    };
    expect(collaborationTurnAccess(group(), claimed).canComplete).toBe(true);
    expect(
      collaborationTurnAccess(group('agent_other'), claimed).canComplete,
    ).toBe(false);
  });

  it('derives completion options only from the current State routes', () => {
    const definition = {
      machine: {
        states: {
          development: {
            transitions: [
              { outcome: 'ready', target_state: 'review' },
              { outcome: 'blocked', target_state: 'development' },
            ],
          },
        },
      },
    };
    expect(
      collaborationOutcomeRoutes(definition, { stateId: 'development' }),
    ).toEqual([
      { outcome: 'ready', target_state: 'review' },
      { outcome: 'blocked', target_state: 'development' },
    ]);
    expect(
      collaborationOutcomeRoutes(definition, { stateId: 'missing' }),
    ).toEqual([]);
  });

  it('prefills active shared Prompts and presents stable Turn history', () => {
    expect(
      collaborationImplementationPrompt(
        { implementationPrompts: { development: 'Review carefully.' } },
        'development',
      ),
    ).toBe('Review carefully.');
    expect(
      collaborationTurnHistory(group().projection).map((turn) => turn.turnId),
    ).toEqual(['turn_newer', 'turn_old']);
    expect(
      collaborationElapsed(
        '2026-08-06T12:00:00.000Z',
        Date.parse('2026-08-06T14:30:00.000Z'),
      ),
    ).toBe('2 小时');
  });

  it('derives the active deadline without treating wall clock as FSM input', () => {
    const now = Date.parse('2026-08-06T12:01:30.000Z');
    expect(
      collaborationTurnDeadline(
        {
          state: 'PENDING_START',
          startDeadlineAt: '2026-08-06T12:02:00.000Z',
          executionDeadlineAt: null,
        },
        now,
      ),
    ).toMatchObject({
      deadlineKind: 'start',
      remainingMs: 30_000,
      overdue: false,
    });
    expect(
      collaborationTurnDeadline(
        {
          state: 'AWAITING_CONFIRMATION',
          startDeadlineAt: '2026-08-06T12:02:00.000Z',
          executionDeadlineAt: '2026-08-06T12:01:00.000Z',
        },
        now,
      ),
    ).toMatchObject({
      deadlineKind: 'execution',
      remainingMs: -30_000,
      overdue: true,
    });
    expect(
      collaborationTurnDeadline(
        { state: 'COMPLETED', executionDeadlineAt: '2026-08-06T12:01:00.000Z' },
        now,
      ),
    ).toBeNull();
  });

  it('keeps lifecycle semantic order and marks negative clock-skew durations', () => {
    const rows = collaborationTurnLifecycle({
      createdAt: '2026-08-06T12:00:02.000Z',
      startedAt: '2026-08-06T12:00:01.000Z',
      dispatchAcceptedAt: '2026-08-06T12:00:04.000Z',
      providerCompletedAt: '2026-08-06T12:01:04.000Z',
    });
    expect(rows.map((row) => row.kind)).toEqual([
      'createdAt',
      'startedAt',
      'dispatchAcceptedAt',
      'providerCompletedAt',
    ]);
    expect(rows[1]).toMatchObject({ durationMs: 0, clockSkew: true });
    expect(rows[2]).toMatchObject({ durationMs: 3_000, clockSkew: false });
    expect(collaborationDuration(rows[3]!.durationMs)).toBe('1 分钟');
    expect(collaborationDuration(null)).toBe('-');
  });

  it('accepts only durable notification array entries', () => {
    expect(
      collaborationPendingNotifications({
        notification: { turnId: 'legacy' },
        notifications: [
          { notificationId: 'note_1', turnId: 'turn_1' },
          { notificationId: 'note_2' },
          null,
        ],
      }),
    ).toEqual([{ notificationId: 'note_1', turnId: 'turn_1' }]);
  });

  it('orders audit events by signed sequence despite clock skew', () => {
    expect(
      collaborationAuditEventTimeline([
        {
          eventId: 'event_2',
          sequence: 2,
          occurredAt: '2026-08-06T11:59:00.000Z',
        },
        {
          eventId: 'event_1',
          sequence: 1,
          occurredAt: '2026-08-06T12:00:00.000Z',
        },
      ]).map((event) => event.eventId),
    ).toEqual(['event_1', 'event_2']);
  });
});
