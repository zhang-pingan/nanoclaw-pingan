import { describe, expect, it } from 'vitest';

import {
  collaborationRoute,
  parseCollaborationRoute,
} from './collaboration-workspace.js';
import {
  collaborationArtifactName,
  collaborationAuditEventTimeline,
  collaborationCanMutate,
  collaborationCurrentTurn,
  collaborationDuration,
  collaborationIsObserver,
  collaborationOutcomeRoutes,
  collaborationPendingNotifications,
  collaborationPrincipalName,
  stageCollaborationArtifactFiles,
  collaborationTurnAccess,
  collaborationTurnDeadline,
  collaborationTurnHistory,
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
      }),
    ).toBe(true);
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
      localPrincipalId: 'principal_alice',
      localClientId: 'client_a',
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
    expect(collaborationDuration(3_600_000)).toBe('1 小时');
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
