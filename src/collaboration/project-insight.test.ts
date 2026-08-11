import { describe, expect, it } from 'vitest';

import {
  buildCollaborationProjectInsight,
  buildMyItems,
  buildProjectSignals,
  collaborationAnalysisResourceIndex,
} from './project-insight.js';
import type { CollaborationProjectionV4 } from './protocol/v4-reducer.js';
import type { CollaborationTurnV4, WorkItem } from './protocol/v4-schema.js';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const ALICE = 'principal_alice';
const BOB = 'principal_bob';
const CLIENT = 'client_alice';
const CREDENTIAL = 'credential_alice';

function workItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    format: 'icarus.collaboration-work-item/1',
    work_item_id: id,
    type: 'task',
    title: id,
    description: '',
    status: 'open',
    priority: 'normal',
    creator_principal_id: ALICE,
    owner_principal_id: ALICE,
    preferred_executor_id: null,
    contributors: [],
    watchers: [],
    acceptance_criteria: [],
    labels: [],
    due_at: null,
    parent_id: null,
    blocked_by: [],
    related_items: [],
    primary_workflow_instance_id: null,
    assignment_status: 'accepted',
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    closed_at: null,
    revision: 1,
    archived: false,
    extensions: {},
    ...overrides,
  };
}

function turn(overrides: Partial<CollaborationTurnV4> = {}) {
  return {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_due',
    workflow_instance_id: 'workflow_paused',
    state_id: 'review',
    assignee_principal_id: ALICE,
    claimant_principal_id: null,
    claimant_client_id: null,
    executor_id: null,
    attempt: 1,
    fencing_token: null,
    execution_mode: 'manual',
    state: 'pending',
    action_ref: null,
    action_hash: null,
    prompt_hash: null,
    input_hash: `sha256:${'1'.repeat(64)}`,
    idempotency_key: `sha256:${'2'.repeat(64)}`,
    incoming_handoff: null,
    incoming_handoff_hash: null,
    timeout_policy_snapshot: null,
    start_deadline_at: '2026-08-08T11:00:00.000Z',
    execution_deadline_at: null,
    deadline_snapshot_hash: `sha256:${'3'.repeat(64)}`,
    created_at: '2026-08-08T10:00:00.000Z',
    started_at: null,
    completed_at: null,
    outcome: null,
    handoff: null,
    handoff_hash: null,
    executor_result: null,
    executor_result_hash: null,
    completion_hash: null,
    recovery_reason: null,
    ...overrides,
  } satisfies CollaborationTurnV4;
}

function projection(): CollaborationProjectionV4 {
  const workItems = {
    wi_overdue: workItem('wi_overdue', {
      priority: 'high',
      due_at: '2026-08-07T12:00:00.000Z',
    }),
    wi_waiting: workItem('wi_waiting', {
      blocked_by: ['wi_blocker'],
      due_at: '2026-08-12T12:00:00.000Z',
    }),
    wi_blocker: workItem('wi_blocker', {
      owner_principal_id: BOB,
    }),
    wi_active: workItem('wi_active'),
    wi_watched: workItem('wi_watched', {
      owner_principal_id: BOB,
      watchers: [ALICE],
    }),
    wi_resolved: workItem('wi_resolved', {
      status: 'done',
      closed_at: '2026-08-06T12:00:00.000Z',
    }),
    wi_pending: workItem('wi_pending', {
      assignment_status: 'pending',
    }),
    wi_blocking: workItem('wi_blocking'),
    wi_dependent: workItem('wi_dependent', {
      owner_principal_id: BOB,
      priority: 'urgent',
      blocked_by: ['wi_blocking'],
    }),
    wi_cycle_a: workItem('wi_cycle_a', {
      owner_principal_id: BOB,
      blocked_by: ['wi_cycle_b'],
    }),
    wi_cycle_b: workItem('wi_cycle_b', {
      owner_principal_id: BOB,
      blocked_by: ['wi_cycle_a'],
    }),
  };
  return {
    format: 'icarus.collaboration-projection/4',
    protocolVersion: 4,
    groupId: 'group_test',
    group: {
      group_id: 'group_test',
      owner_principal_id: ALICE,
    },
    aggregateHeads: {},
    invites: {},
    members: {
      [ALICE]: { principal_id: ALICE, display_name: 'Alice', status: 'active' },
      [BOB]: { principal_id: BOB, display_name: 'Bob', status: 'active' },
    },
    clients: { [ALICE]: { [CLIENT]: { status: 'active' } } },
    credentials: {
      [ALICE]: { [CREDENTIAL]: { status: 'active' } },
    },
    recoveryRequests: {
      recovery_alice: {
        request_id: 'recovery_alice',
        type: 'identity_recovery',
        target_principal_id: ALICE,
        status: 'pending',
        expires_at: '2026-08-09T12:00:00.000Z',
      },
    },
    executors: {},
    permissionGrants: {},
    progressUpdates: {},
    files: { file_report: {} },
    links: {},
    artifacts: {},
    fileLocations: {},
    linkLocations: {},
    removedLinkIds: [],
    actions: {},
    workItems,
    workItemUpdates: {},
    discussions: {
      discussion_review: {
        discussion: {
          thread_id: 'discussion_review',
          title: 'Review request',
          status: 'open',
        },
        messages: {
          message_review: {
            message_id: 'message_review',
            mentions: [ALICE],
            tombstoned: false,
          },
        },
      },
    },
    workflowDefinitions: {},
    latestWorkflowDefinitionVersions: {},
    workflowInstances: {
      workflow_paused: {
        instance_id: 'workflow_paused',
        definition_id: 'delivery',
        lifecycle: 'paused',
        created_by_principal_id: ALICE,
      },
      workflow_assigned: {
        instance_id: 'workflow_assigned',
        definition_id: 'delivery',
        lifecycle: 'running',
        business_state: 'review',
        active_turn_id: null,
        resolved_assignments: { review: ALICE },
        created_by_principal_id: BOB,
      },
      workflow_recovery: {
        instance_id: 'workflow_recovery',
        definition_id: 'delivery',
        lifecycle: 'recovery_required',
        business_state: 'review',
        active_turn_id: 'turn_recovery',
        resolved_assignments: { review: ALICE },
        created_by_principal_id: BOB,
      },
    },
    stateExecutions: {},
    turns: {
      turn_due: turn(),
      turn_recovery: turn({
        turn_id: 'turn_recovery',
        workflow_instance_id: 'workflow_recovery',
        state: 'recovery_required',
        start_deadline_at: null,
        recovery_reason: 'Managed executor lost its process',
      }),
    },
    timeoutObservations: {},
    seenEventIds: ['event_old', 'event_new'],
    activity: [
      {
        eventId: 'event_old',
        aggregateType: 'group',
        aggregateId: 'group_test',
        aggregateRevision: 1,
        eventType: 'group_initialized',
        actorPrincipalId: ALICE,
        actorClientId: CLIENT,
        occurredAt: '2026-08-01T12:00:00.000Z',
      },
      {
        eventId: 'event_new',
        aggregateType: 'work_item',
        aggregateId: 'wi_overdue',
        aggregateRevision: 1,
        eventType: 'work_item_created',
        actorPrincipalId: ALICE,
        actorClientId: CLIENT,
        occurredAt: '2026-08-07T12:00:00.000Z',
      },
    ],
    integrityStatus: 'OK',
    integrityMessage: null,
  } as unknown as CollaborationProjectionV4;
}

const localGroup = {
  localPrincipalId: ALICE,
  localClientId: CLIENT,
  localCredentialId: CREDENTIAL,
  protocolStatus: 'OK',
  protocolError: null,
  ownerPrincipalId: ALICE,
  subscriptionMode: 'member' as const,
};

describe('deterministic Collaboration Project Insight', () => {
  it('produces stable, severity-ordered signals for a frozen clock', () => {
    const first = buildProjectSignals({ projection: projection(), nowMs: NOW });
    const second = buildProjectSignals({
      projection: projection(),
      nowMs: NOW,
    });

    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      rule_id: 'dependency_cycle',
      severity: 'critical',
      observed_at: '2026-08-08T12:00:00.000Z',
    });
    expect(first.map((entry) => entry.rule_id)).toEqual(
      expect.arrayContaining([
        'work_item_overdue',
        'work_item_blocked',
        'assignment_pending',
        'dependency_cycle',
        'workflow_turn_timeout',
        'identity_recovery_pending',
      ]),
    );
    expect(first.every((entry) => entry.signal_id.startsWith('signal_'))).toBe(
      true,
    );
  });

  it('classifies all My Items groups and sorts by action priority', () => {
    const items = buildMyItems({
      group: localGroup,
      projection: projection(),
      nowMs: NOW,
    });

    expect(new Set(items.map((item) => item.group))).toEqual(
      new Set([
        'needs_action',
        'at_risk',
        'waiting_on_others',
        'watching',
        'recently_resolved',
      ]),
    );
    expect(items.map((item) => item.priority_rank)).toEqual(
      [...items.map((item) => item.priority_rank)].sort(
        (left, right) => right - left,
      ),
    );
    expect(items[0]).toMatchObject({
      resource_type: 'recovery',
      reason: 'recovery_decision_required',
      priority_rank: 600,
    });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: 'at_risk',
          resource_id: 'turn_due',
          reason: 'turn_timeout',
        }),
        expect.objectContaining({
          group: 'waiting_on_others',
          resource_id: 'wi_waiting',
        }),
        expect.objectContaining({
          group: 'watching',
          resource_id: 'wi_watched',
        }),
        expect.objectContaining({
          group: 'recently_resolved',
          resource_id: 'wi_resolved',
        }),
        expect.objectContaining({
          group: 'needs_action',
          resource_id: 'workflow_assigned',
          reason: 'workflow_state_assignment_ready',
        }),
        expect.objectContaining({
          group: 'needs_action',
          resource_type: 'turn',
          resource_id: 'turn_recovery',
          reason: 'turn_recovery_required',
          severity: 'critical',
        }),
      ]),
    );
    expect(
      buildMyItems({
        group: { ...localGroup, localPrincipalId: null },
        projection: projection(),
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it('binds counts and activity delta to the requested snapshot', () => {
    const value = buildCollaborationProjectInsight({
      group: {
        ...localGroup,
        lastSyncAtMs: NOW - 1_000,
        lastError: null,
      } as never,
      projection: projection(),
      snapshotHead: HEAD,
      nowMs: NOW,
      lastViewedActivityEventId: 'event_old',
    });

    expect(value).toMatchObject({
      snapshot_head: HEAD,
      generated_at: '2026-08-08T12:00:00.000Z',
      health: 'critical',
      counts: {
        active_members: 2,
        overdue_work_items: 1,
        pending_assignments: 1,
        workflow_paused: 1,
        workflow_timed_out: 1,
        unresolved_discussions: 1,
      },
      activity_delta: [{ eventId: 'event_new' }],
    });
    expect(collaborationAnalysisResourceIndex(projection())).toEqual(
      [...collaborationAnalysisResourceIndex(projection())].sort(),
    );
    expect(collaborationAnalysisResourceIndex(projection())).toContain(
      'event:event_new',
    );
  });
});
