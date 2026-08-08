import { describe, expect, it } from 'vitest';

import {
  collaborationRoute,
  parseCollaborationRoute,
} from './collaboration-workspace.js';
import {
  collaborationArtifactName,
  collaborationAuditEventTimeline,
  collaborationCanApproveMembers,
  collaborationCanCreateTurn,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationEligibleTurnExecutors,
  collaborationIsObserver,
  collaborationLocalMembershipStatus,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationPrincipalName,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
  collaborationTurnDeadline,
  collaborationTurnHistory,
  buildCollaborationStartTurnRequest,
  buildCollaborationCompleteTurnRequest,
  collaborationTurnCompletionDraft,
  collaborationVerifiedFileTree,
  collaborationWorkItemColumns,
} from './collaboration-ui.js';

describe('Collaboration project-space v3 UI helpers', () => {
  it('round-trips encoded Project Space routes for cold navigation', () => {
    expect(collaborationRoute('', 'overview')).toBe('/groups');
    expect(collaborationRoute('group:release/one', 'work-items')).toBe(
      '/groups/group%3Arelease%2Fone/work-items',
    );
    expect(
      parseCollaborationRoute('/groups/group%3Arelease%2Fone/work-items'),
    ).toEqual({ groupId: 'group:release/one', tab: 'work-items' });
  });

  it('makes Observer mode explicit and read only', () => {
    expect(collaborationIsObserver({ subscriptionMode: 'observer' })).toBe(
      true,
    );
    expect(
      collaborationCanMutate({
        subscriptionMode: 'observer',
        lifecycle: 'active',
      }),
    ).toBe(false);
    expect(
      collaborationCanMutate({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_alice',
        localClientId: 'client_a',
        projection: {
          members: { principal_alice: { status: 'active' } },
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanMutate({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_alice',
        localClientId: 'client_a',
        projection: {
          members: { principal_alice: { status: 'requested' } },
        },
      }),
    ).toBe(false);
    expect(
      collaborationLocalMembershipStatus({
        subscriptionMode: 'member',
        localPrincipalId: 'principal_alice',
        projection: {
          members: { principal_alice: { status: 'requested' } },
        },
      }),
    ).toBe('requested');
  });

  it('uses human Principal and Artifact labels for operational views', () => {
    const projection = {
      members: {
        principal_alice: { display_name: 'Alice Chen' },
      },
      artifacts: {
        artifact_report: { original_filename: 'release-report.txt' },
      },
    };
    expect(collaborationPrincipalName(projection, 'principal_alice')).toBe(
      'Alice Chen',
    );
    expect(collaborationArtifactName(projection, 'artifact_report')).toBe(
      'release-report.txt',
    );
    expect(
      collaborationArtifactName(
        projection,
        'artifacts/work-items/work_1/artifact_report/metadata.json',
      ),
    ).toBe('release-report.txt');
  });

  it('scopes Turn actions to the assignee Principal and claimant Client', () => {
    const group = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_a',
      projection: {
        members: { principal_alice: { status: 'active' } },
      },
    };
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: null,
        state: 'pending',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({
      localPrincipal: true,
      canStart: true,
      canComplete: false,
    });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_a',
        state: 'awaiting_confirmation',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({ canComplete: true });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_a',
        state: 'running',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({ canComplete: false });
    expect(
      collaborationTurnAccess(group, {
        assignee_principal_id: 'principal_alice',
        claimant_client_id: 'client_b',
        state: 'running',
        execution_mode: 'assisted',
      }),
    ).toMatchObject({
      localPrincipal: true,
      localClient: false,
      canComplete: false,
    });
  });

  it('derives membership approval authority', () => {
    expect(
      collaborationCanApproveMembers({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_owner',
        localClientId: 'client_owner',
        ownerPrincipalId: 'principal_owner',
        projection: {
          members: { principal_owner: { status: 'active' } },
          permissionGrants: {},
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanApproveMembers({
        subscriptionMode: 'member',
        lifecycle: 'active',
        localPrincipalId: 'principal_admin',
        localClientId: 'client_admin',
        ownerPrincipalId: 'principal_owner',
        projection: {
          members: { principal_admin: { status: 'active' } },
          permissionGrants: {
            principal_admin: { grants: ['member:approve'] },
          },
        },
      }),
    ).toBe(true);
    expect(
      collaborationCanApproveMembers({ subscriptionMode: 'observer' }),
    ).toBe(false);
  });

  it('creates each next Workflow Turn and requires an assisted Executor', () => {
    const instance = {
      instance_id: 'instance_1',
      lifecycle: 'running',
      business_state: 'build',
      active_turn_id: null,
      created_by_principal_id: 'principal_alice',
      resolved_assignments: { build: 'principal_alice' },
    };
    const definition = {
      machine: {
        states: {
          build: { terminal: false },
          done: { terminal: true },
        },
      },
    };
    const authorityGroup = {
      localPrincipalId: 'principal_alice',
      projection: { permissionGrants: {} },
    };
    expect(
      collaborationCanCreateTurn(authorityGroup, instance, definition),
    ).toBe(true);
    expect(
      collaborationCanCreateTurn(
        { ...authorityGroup, localPrincipalId: 'principal_bob' },
        instance,
        definition,
      ),
    ).toBe(false);
    expect(
      collaborationCanCreateTurn(
        authorityGroup,
        { ...instance, business_state: 'done' },
        definition,
      ),
    ).toBe(false);
    expect(
      buildCollaborationStartTurnRequest(4, { execution_mode: 'manual' }),
    ).toEqual({ expectedRevision: 4, executorId: null });
    expect(() =>
      buildCollaborationStartTurnRequest(4, {
        execution_mode: 'assisted',
      }),
    ).toThrow(/Executor/u);

    const group = {
      groupId: 'group_1',
      localPrincipalId: 'principal_alice',
      localClientId: 'client_alice',
    };
    const turn = {
      workflow_instance_id: 'instance_1',
      state_id: 'build',
      assignee_principal_id: 'principal_alice',
      action_hash: 'sha256:action',
      prompt_hash: 'sha256:prompt',
      execution_mode: 'assisted',
    };
    const bindings = [
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_alice',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_codex',
        enabled: true,
      },
      {
        groupId: 'group_1',
        instanceId: 'instance_1',
        stateId: 'build',
        principalId: 'principal_alice',
        clientId: 'client_other',
        actionHash: 'sha256:action',
        promptHash: 'sha256:prompt',
        executorId: 'executor_wrong_client',
        enabled: true,
      },
    ];
    expect(collaborationEligibleTurnExecutors(group, turn, bindings)).toEqual([
      'executor_codex',
    ]);
    expect(
      buildCollaborationStartTurnRequest(4, turn, 'executor_codex'),
    ).toEqual({ expectedRevision: 4, executorId: 'executor_codex' });
  });

  it('finds per-Instance current/history Turns and legal Outcomes', () => {
    const projection = {
      workflowInstances: {
        instance_a: { active_turn_id: 'turn_2' },
      },
      turns: {
        turn_1: {
          turn_id: 'turn_1',
          workflow_instance_id: 'instance_a',
          created_at: '2026-08-06T12:00:00.000Z',
        },
        turn_2: {
          turn_id: 'turn_2',
          workflow_instance_id: 'instance_a',
          state_id: 'review',
          created_at: '2026-08-06T12:01:00.000Z',
        },
      },
    };
    expect(collaborationCurrentTurn(projection, 'instance_a')?.turn_id).toBe(
      'turn_2',
    );
    expect(
      collaborationTurnHistory(projection, 'instance_a').map(
        (turn) => turn.turn_id,
      ),
    ).toEqual(['turn_2', 'turn_1']);
    expect(
      collaborationOutcomeRoutes(
        {
          machine: {
            states: {
              review: {
                transitions: [
                  {
                    outcome: 'approved',
                    label: 'Approved',
                    target_state: 'done',
                  },
                ],
              },
            },
          },
        },
        projection.turns.turn_2,
      ),
    ).toEqual([
      { outcome: 'approved', label: 'Approved', target_state: 'done' },
    ]);
  });

  it('derives notify-only deadline presentation without changing state', () => {
    const now = Date.parse('2026-08-06T12:01:30.000Z');
    expect(
      collaborationTurnDeadline(
        {
          state: 'pending',
          start_deadline_at: '2026-08-06T12:02:00.000Z',
          execution_deadline_at: null,
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
          state: 'running',
          start_deadline_at: null,
          execution_deadline_at: '2026-08-06T12:01:00.000Z',
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
        {
          state: 'awaiting_confirmation',
          start_deadline_at: '2026-08-06T12:00:00.000Z',
          execution_deadline_at: '2026-08-06T12:03:00.000Z',
        },
        now,
      ),
    ).toEqual({
      deadlineKind: 'execution',
      deadlineAt: '2026-08-06T12:03:00.000Z',
      remainingMs: 90_000,
      overdue: false,
    });
    expect(collaborationDuration(3_600_000)).toBe('1 小时');
  });

  it('prefills Assisted completion markers and submits the edited identifiers', () => {
    const turn = {
      attempt: 2,
      fencing_token: 'fence_2',
      executor_result: {
        outcome: 'ready_for_test',
        summary: 'Executor summary',
        instruction: 'Review the evidence',
        markers: ['executor_suggested', 'needs_review'],
        data: { confidence: 0.8 },
      },
    };
    expect(
      collaborationTurnCompletionDraft(turn, [
        { outcome: 'retry' },
        { outcome: 'ready_for_test' },
      ]),
    ).toEqual({
      outcome: 'ready_for_test',
      summary: 'Executor summary',
      instruction: 'Review the evidence',
      markers: 'executor_suggested, needs_review',
      data: '{\n  "confidence": 0.8\n}',
    });

    expect(
      buildCollaborationCompleteTurnRequest({
        expectedRevision: 7,
        turn,
        outcome: 'ready_for_test',
        summary: 'Confirmed summary',
        instruction: 'Continue to validation',
        markers: 'confirmed, release_candidate\nconfirmed',
        data: { confidence: 1 },
        artifactIds: ['artifact_1'],
      }),
    ).toEqual({
      expectedRevision: 7,
      attempt: 2,
      fencingToken: 'fence_2',
      outcome: 'ready_for_test',
      summary: 'Confirmed summary',
      instruction: 'Continue to validation',
      markers: ['confirmed', 'release_candidate'],
      data: { confidence: 1 },
      artifactIds: ['artifact_1'],
    });
    expect(() =>
      buildCollaborationCompleteTurnRequest({
        expectedRevision: 7,
        turn,
        outcome: 'ready_for_test',
        summary: 'Confirmed summary',
        instruction: '',
        markers: 'valid, not valid',
        data: {},
        artifactIds: [],
      }),
    ).toThrow(/Marker must be an identifier/u);
  });

  it('builds verified virtual files and Work Item board columns', () => {
    const tree = collaborationVerifiedFileTree([
      { fileId: 'file_1', virtualPath: 'Shared/Documents/evidence.pdf' },
      { fileId: 'file_2', virtualPath: 'Alice/Files/notes.txt' },
    ]);
    expect(
      tree.directories.Shared.directories.Documents.files[0],
    ).toMatchObject({
      name: 'evidence.pdf',
    });
    expect(
      collaborationWorkItemColumns([
        {
          work_item_id: 'late',
          status: 'open',
          due_at: '2026-08-08T00:00:00Z',
        },
        {
          work_item_id: 'early',
          status: 'open',
          due_at: '2026-08-07T00:00:00Z',
        },
        { work_item_id: 'done', status: 'done', due_at: null },
      ]).open.map((item) => item.work_item_id),
    ).toEqual(['early', 'late']);
  });

  it('accepts durable notifications and orders audit by commit order', () => {
    expect(
      collaborationPendingNotifications({
        notifications: [
          {
            notificationId: 'note_1',
            resourceType: 'turn',
            resourceId: 'turn_1',
          },
          { notificationId: 'incomplete' },
        ],
      }),
    ).toHaveLength(1);
    expect(
      collaborationAuditEventTimeline([
        { event_id: 'event_2', commit_order: 2 },
        { event_id: 'event_1', commit_order: 1 },
      ]).map((event) => event.event_id),
    ).toEqual(['event_1', 'event_2']);
  });

  it('stages selected Artifact files once and reuses their ids on command retry', async () => {
    const files = [
      new File(['evidence'], 'evidence.txt', { type: 'text/plain' }),
      new File([new Uint8Array([0, 1, 255])], 'result.bin'),
    ];
    const requests = [];
    const request = async (endpoint, options) => {
      const metadata = JSON.parse(await options.body.get('metadata').text());
      requests.push({ endpoint, metadata });
      return {
        metadata: { artifact_id: `artifact_${requests.length}` },
      };
    };
    const artifactIds = [];
    await stageCollaborationArtifactFiles({
      files,
      artifactIds,
      request,
      endpoint: '/work-items/work_1/artifacts',
      metadata: (file) => ({
        fileName: file.name,
        mediaType: file.type || 'application/octet-stream',
      }),
    });
    await stageCollaborationArtifactFiles({
      files,
      artifactIds,
      request,
      endpoint: '/work-items/work_1/artifacts',
      metadata: () => ({}),
    });
    expect(artifactIds).toEqual(['artifact_1', 'artifact_2']);
    expect(requests).toEqual([
      {
        endpoint: '/work-items/work_1/artifacts',
        metadata: { fileName: 'evidence.txt', mediaType: 'text/plain' },
      },
      {
        endpoint: '/work-items/work_1/artifacts',
        metadata: {
          fileName: 'result.bin',
          mediaType: 'application/octet-stream',
        },
      },
    ]);
  });
});
