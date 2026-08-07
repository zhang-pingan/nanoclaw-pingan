import { describe, expect, it } from 'vitest';

import {
  buildCollaborationCreateRequest,
  defaultCollaborationCreateDraft,
} from './collaboration-definition.js';
import {
  addCollaborationOutcomeFirst,
  autoLayoutCollaborationFsm,
  collaborationMachineEditable,
  collaborationEdgeId,
  createCollaborationDraftHistory,
  removeCollaborationState,
  validateCollaborationFsmDraft,
} from './collaboration-fsm.js';
import { calculateCollaborationFsmFitZoom } from './collaboration-fsm-editor.js';

function request(draft: ReturnType<typeof defaultCollaborationCreateDraft>) {
  return buildCollaborationCreateRequest({
    remoteUrl: '/tmp/fsm.git',
    name: 'FSM',
    signingKeyPath: '/tmp/key',
    draft,
  });
}

describe('collaboration graphical FSM model', () => {
  it('fits the stage against both canvas dimensions', () => {
    expect(calculateCollaborationFsmFitZoom(1000, 500, 880, 760)).toBeCloseTo(
      472 / 760,
    );
    expect(calculateCollaborationFsmFitZoom(400, 900, 880, 520)).toBeCloseTo(
      0.45,
    );
    expect(calculateCollaborationFsmFitZoom(1400, 900, 880, 520)).toBe(1);
  });

  it.each([
    ['FORMING', true],
    ['PAUSED', true],
    ['READY', false],
    ['RUNNING', false],
    ['CLOSING', false],
    ['CLOSED', false],
  ])(
    'exposes %s with the expected creator edit mode',
    (lifecycle, editable) => {
      expect(
        collaborationMachineEditable({
          lifecycle,
          localPrincipalId: 'alice',
          creatorPrincipalId: 'alice',
        }),
      ).toBe(editable);
      expect(
        collaborationMachineEditable({
          lifecycle,
          localPrincipalId: 'bob',
          creatorPrincipalId: 'alice',
        }),
      ).toBe(false);
    },
  );

  it('starts with one configurable initial State and adds an Outcome before its next State', () => {
    const initial = defaultCollaborationCreateDraft();
    expect(initial.states).toHaveLength(1);
    expect(initial.initialState).toBe(initial.states[0]?.id);
    expect(initial.states[0]?.transitions).toEqual([]);

    const added = addCollaborationOutcomeFirst(initial, {
      sourceStateId: 'development',
      outcome: 'succeeded',
      label: 'Succeeded',
      destination: 'new',
      newStateId: 'review',
      newStateLabel: 'Review',
      newStateOwnerRole: 'reviewer',
    });
    expect(added.createdStateId).toBe('review');
    expect(added.selectedStateId).toBe('review');
    expect(added.draft.states[0]?.transitions).toEqual([
      { outcome: 'succeeded', label: 'Succeeded', targetState: 'review' },
    ]);
    expect(added.draft.layout.nodes.review.x).toBeGreaterThan(
      added.draft.layout.nodes.development.x,
    );
  });

  it('supports self-loops, custom outcomes, merges and multiple terminals', () => {
    let draft = defaultCollaborationCreateDraft();
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'failed',
      label: 'Retry after failure',
      destination: 'self',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'needs_review',
      label: 'Needs review',
      destination: 'new',
      newStateId: 'review',
      newStateOwnerRole: 'reviewer',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review',
      outcome: 'approved',
      label: 'Approved',
      destination: 'terminal',
      newStateId: 'completed',
      newStateLabel: 'Completed',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review',
      outcome: 'cancelled',
      label: 'Cancelled',
      destination: 'terminal',
      newStateId: 'cancelled',
      newStateLabel: 'Cancelled',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'fast_track',
      label: 'Fast track',
      destination: 'existing',
      targetStateId: 'completed',
    }).draft;

    expect(validateCollaborationFsmDraft(draft)).toEqual([]);
    expect(request(draft).machine.states.development.transitions).toEqual([
      {
        outcome: 'failed',
        label: 'Retry after failure',
        target_state: 'development',
      },
      {
        outcome: 'needs_review',
        label: 'Needs review',
        target_state: 'review',
      },
      {
        outcome: 'fast_track',
        label: 'Fast track',
        target_state: 'completed',
      },
    ]);
  });

  it('keeps same-role nodes at the same rank from overlapping in role lanes', () => {
    let draft = defaultCollaborationCreateDraft();
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'left',
      destination: 'new',
      newStateId: 'review_left',
      newStateOwnerRole: 'reviewer',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'right',
      destination: 'new',
      newStateId: 'review_right',
      newStateOwnerRole: 'reviewer',
    }).draft;

    const laidOut = autoLayoutCollaborationFsm(draft, 'roles');
    expect(
      Math.abs(
        laidOut.layout.nodes.review_left.y -
          laidOut.layout.nodes.review_right.y,
      ),
    ).toBeGreaterThan(94);
  });

  it('locates duplicate outcomes, unknown roles/targets, unreachable States and timeout errors', () => {
    const draft = defaultCollaborationCreateDraft();
    draft.states[0]!.ownerRole = 'missing';
    draft.states[0]!.reminderIntervalMs = '1000';
    draft.states[0]!.transitions = [
      { outcome: 'same', label: 'One', targetState: 'missing' },
      { outcome: 'same', label: 'Two', targetState: 'missing' },
    ];
    draft.states.push({
      ...structuredClone(draft.states[0]!),
      id: 'orphan',
      ownerRole: 'developer',
      reminderIntervalMs: '',
      terminal: true,
      transitions: [],
    });

    const issues = validateCollaborationFsmDraft(draft);
    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'UNKNOWN_ROLE',
        'REMINDER_WITHOUT_TIMEOUT',
        'UNKNOWN_TARGET',
        'DUPLICATE_OUTCOME',
        'UNREACHABLE_STATE',
        'NO_REACHABLE_TERMINAL',
      ]),
    );
    expect(
      issues.find((entry) => entry.code === 'DUPLICATE_OUTCOME'),
    ).toMatchObject({
      stateId: 'development',
      edgeId: collaborationEdgeId('development', 'same'),
    });
  });

  it('allows an explicit warning confirmation for a reachable pure loop', () => {
    const draft = defaultCollaborationCreateDraft();
    draft.states[0]!.transitions = [
      { outcome: 'again', label: 'Again', targetState: 'development' },
    ];
    expect(validateCollaborationFsmDraft(draft)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'LOOP_WITHOUT_TERMINAL',
        confirmRequired: true,
      }),
    );
  });

  it('keeps layout changes outside the Machine payload and supports undo/redo', () => {
    let draft = defaultCollaborationCreateDraft();
    draft.states[0]!.transitions = [
      { outcome: 'again', label: 'Again', targetState: 'development' },
    ];
    const before = request(draft);
    const history = createCollaborationDraftHistory(draft);
    const laidOut = autoLayoutCollaborationFsm(draft, 'roles');
    laidOut.layout.nodes.development.x += 415;
    history.commit(laidOut);
    const after = request(history.current());

    expect(after.machine).toEqual(before.machine);
    expect(after.roles).toEqual(before.roles);
    expect(after.layout).not.toEqual(before.layout);
    expect(history.canUndo()).toBe(true);
    expect(history.undo().layout).toEqual(before.layout);
    expect(history.redo().layout.view).toBe('roles');
  });

  it('reports affected edges and orphaned nodes before State deletion', () => {
    let draft = defaultCollaborationCreateDraft();
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'development',
      outcome: 'next',
      destination: 'new',
      newStateId: 'review',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review',
      outcome: 'finish',
      destination: 'terminal',
      newStateId: 'done',
    }).draft;
    const removed = removeCollaborationState(draft, 'review');

    expect(removed.affectedEdges).toHaveLength(2);
    expect(removed.orphanedStateIds).toEqual(['done']);
  });
});
