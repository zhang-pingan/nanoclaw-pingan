import { describe, expect, it } from 'vitest';

import {
  buildCollaborationCreateRequest,
  buildCollaborationJoinRequest,
  buildCollaborationWorkflowRequest,
  collaborationDraftFromDefinition,
  createStateDraft,
  defaultCollaborationWorkflowDraft,
} from './collaboration-definition.js';

function completeDraft() {
  const draft = defaultCollaborationWorkflowDraft();
  draft.states[0]!.transitions = [
    { outcome: 'ready', label: 'Ready', targetState: 'review' },
  ];
  draft.states.push(
    createStateDraft(2, {
      id: 'review',
      label: 'Review',
      participantId: 'reviewer',
      transitions: [
        { outcome: 'approved', label: 'Approved', targetState: 'shipped' },
      ],
    }),
    createStateDraft(3, { id: 'shipped', label: 'Shipped', terminal: true }),
  );
  return draft;
}

describe('Collaboration project-space request builders', () => {
  it('creates only Group identity and policy facts, not a Workflow', () => {
    const request = buildCollaborationCreateRequest({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: '/tmp/id_ed25519',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'allowed',
      draft: completeDraft(),
      principalId: 'caller-selected',
    });
    expect(request).toEqual({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: '/tmp/id_ed25519',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'allowed',
    });
    expect(request).not.toHaveProperty('machine');
    expect(request).not.toHaveProperty('principalId');
  });

  it('omits the SSH signing key when create and join use the Host default', () => {
    expect(
      buildCollaborationCreateRequest({
        remoteUrl: '/tmp/project.git',
        name: 'Project',
        signingKeyPath: '  ',
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'approval',
        observerAccess: 'allowed',
      }),
    ).not.toHaveProperty('signingKeyPath');
    expect(
      buildCollaborationJoinRequest({
        displayName: 'Alice',
        clientDisplayName: 'Alice laptop',
      }),
    ).not.toHaveProperty('signingKeyPath');
  });

  it('builds Principal/Client join input without caller identity overrides', () => {
    expect(
      buildCollaborationJoinRequest({
        signingKeyPath: '/tmp/id_ed25519',
        displayName: 'Alice',
        clientDisplayName: 'Alice laptop',
        principalId: 'principal_attacker',
        clientId: 'client_attacker',
      }),
    ).toEqual({
      signingKeyPath: '/tmp/id_ed25519',
      displayName: 'Alice',
      clientDisplayName: 'Alice laptop',
    });
    expect(
      buildCollaborationJoinRequest({
        signingKeyPath: '/tmp/id_ed25519',
        displayName: 'Bob',
        clientDisplayName: 'Bob laptop',
        inviteId: 'invite_bob',
      }),
    ).toMatchObject({ inviteId: 'invite_bob' });
  });

  it('builds a validated v3 Machine and participant layout', () => {
    const request = buildCollaborationWorkflowRequest({
      expectedRevision: 0,
      draft: completeDraft(),
    });
    expect(request.machine).toMatchObject({
      format: 'icarus.collaboration-machine/3',
      initial_state: 'build',
      states: {
        build: {
          assignee: { type: 'participant_slot', slot: 'builder' },
          transitions: [{ outcome: 'ready', target_state: 'review' }],
        },
        shipped: { terminal: true, transitions: [] },
      },
    });
    expect(request.layout).toMatchObject({
      format: 'icarus.collaboration-workflow-layout/1',
      view: 'participants',
      revision: 1,
    });
  });

  it('uses Chinese display labels for a new project workflow definition', () => {
    const draft = defaultCollaborationWorkflowDraft();
    expect(draft.name).toBe('交付流程');
    expect(draft.participants.map((entry) => entry.label)).toEqual([
      '构建者',
      '审核者',
    ]);
    expect(draft.states[0]!.label).toBe('构建');
    expect(createStateDraft(2).label).toBe('状态 2');
  });

  it('supports a State assigned directly to a Principal', () => {
    const draft = completeDraft();
    draft.states[1]!.assigneeType = 'principal';
    draft.states[1]!.assigneeId = 'principal_reviewer';
    expect(
      buildCollaborationWorkflowRequest({ expectedRevision: 0, draft }).machine
        .states.review.assignee,
    ).toEqual({ type: 'principal', principal_id: 'principal_reviewer' });
  });

  it('rejects unknown participant slots, invalid terminal fields, and duplicate Outcomes', () => {
    const unknown = completeDraft();
    unknown.states[0]!.assigneeId = 'missing';
    expect(() =>
      buildCollaborationWorkflowRequest({
        expectedRevision: 0,
        draft: unknown,
      }),
    ).toThrow(/未知参与者/);

    const terminal = completeDraft();
    terminal.states[2]!.startTimeoutMs = 1000;
    expect(() =>
      buildCollaborationWorkflowRequest({
        expectedRevision: 0,
        draft: terminal,
      }),
    ).toThrow(/终止状态.*超时/);

    const duplicate = completeDraft();
    duplicate.states[0]!.transitions.push({
      outcome: 'ready',
      label: 'Again',
      targetState: 'review',
    });
    expect(() =>
      buildCollaborationWorkflowRequest({
        expectedRevision: 0,
        draft: duplicate,
      }),
    ).toThrow(/执行结果重复/);
  });

  it('round-trips Definition projection into an editable draft', () => {
    const request = buildCollaborationWorkflowRequest({
      expectedRevision: 0,
      draft: completeDraft(),
    });
    const roundTrip = collaborationDraftFromDefinition({
      definition: {
        definition_id: request.definitionId,
        version: request.version,
        name: request.name,
        description: request.description,
      },
      machine: request.machine,
      layout: request.layout,
    });
    expect(roundTrip.participants.map((entry) => entry.id)).toEqual([
      'builder',
      'reviewer',
    ]);
    expect(roundTrip.states[1]).toMatchObject({
      assigneeType: 'participant_slot',
      assigneeId: 'reviewer',
    });
  });
});
