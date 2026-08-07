import { describe, expect, it } from 'vitest';

import { defaultCollaborationWorkflowDraft } from './collaboration-definition.js';
import {
  addCollaborationOutcomeFirst,
  autoLayoutCollaborationFsm,
  collaborationEdgeId,
  collaborationRuntimeGraphHighlights,
  collaborationWorkflowEditable,
  collaborationWorkflowPublishable,
  createCollaborationDraftHistory,
  removeCollaborationState,
  validateCollaborationFsmDraft,
} from './collaboration-fsm.js';
import { calculateCollaborationFsmFitZoom } from './collaboration-fsm-editor.js';

describe('Outcome-first v3 Workflow model', () => {
  it('fits the stage against both canvas dimensions', () => {
    expect(calculateCollaborationFsmFitZoom(1000, 500, 880, 760)).toBeCloseTo(
      472 / 760,
    );
    expect(calculateCollaborationFsmFitZoom(400, 900, 880, 520)).toBe(0.45);
  });

  it('allows Members with direct workflow permission and rejects Observers', () => {
    const group = {
      subscriptionMode: 'member',
      lifecycle: 'active',
      localPrincipalId: 'principal_designer',
      ownerPrincipalId: 'principal_owner',
      projection: {
        permissionGrants: {
          principal_designer: {
            grants: [
              'workflow_definition:propose',
              'workflow_definition:publish',
            ],
          },
        },
      },
    };
    expect(collaborationWorkflowEditable(group, null)).toBe(true);
    expect(
      collaborationWorkflowEditable(
        { ...group, subscriptionMode: 'observer' },
        null,
      ),
    ).toBe(false);
    expect(
      collaborationWorkflowEditable(group, {
        definition: { status: 'retired' },
      }),
    ).toBe(false);
    expect(
      collaborationWorkflowPublishable(group, {
        definition: { status: 'proposed' },
      }),
    ).toBe(true);
    expect(
      collaborationWorkflowPublishable(group, {
        definition: { status: 'published' },
      }),
    ).toBe(false);
  });

  it('creates Outcome before destination State with participant assignment', () => {
    const initial = defaultCollaborationWorkflowDraft();
    const result = addCollaborationOutcomeFirst(initial, {
      sourceStateId: 'build',
      outcome: 'ready',
      label: 'Ready',
      destination: 'new',
      newStateId: 'review',
      newStateLabel: 'Review',
      newStateAssigneeType: 'participant_slot',
      newStateAssigneeId: 'reviewer',
    });
    expect(result.createdStateId).toBe('review');
    expect(result.draft.states[0]!.transitions).toEqual([
      { outcome: 'ready', label: 'Ready', targetState: 'review' },
    ]);
    expect(result.draft.states[1]).toMatchObject({
      assigneeType: 'participant_slot',
      assigneeId: 'reviewer',
    });
  });

  it('supports self loops, merges, multiple terminals, and participant lanes', () => {
    let draft = defaultCollaborationWorkflowDraft();
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'build',
      outcome: 'retry',
      destination: 'self',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'build',
      outcome: 'left',
      destination: 'new',
      newStateId: 'review_left',
      newStateAssigneeId: 'reviewer',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'build',
      outcome: 'right',
      destination: 'new',
      newStateId: 'review_right',
      newStateAssigneeId: 'reviewer',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review_left',
      outcome: 'approved',
      destination: 'terminal',
      newStateId: 'shipped',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review_right',
      outcome: 'approved',
      destination: 'existing',
      targetStateId: 'shipped',
    }).draft;
    const laidOut = autoLayoutCollaborationFsm(draft, 'participants');
    expect(
      Math.abs(
        laidOut.layout.nodes.review_left.y -
          laidOut.layout.nodes.review_right.y,
      ),
    ).toBeGreaterThan(94);
    expect(validateCollaborationFsmDraft(laidOut)).toEqual([]);
  });

  it('reports assignee, timeout, Outcome, target and reachability errors', () => {
    const draft = defaultCollaborationWorkflowDraft();
    draft.states[0]!.assigneeId = 'missing';
    draft.states[0]!.reminderIntervalMs = 1000;
    draft.states[0]!.transitions = [
      { outcome: 'same', label: 'One', targetState: 'missing' },
      { outcome: 'same', label: 'Two', targetState: 'missing' },
    ];
    draft.states.push({
      ...structuredClone(draft.states[0]!),
      id: 'orphan',
      assigneeId: '',
      terminal: true,
      reminderIntervalMs: '',
      transitions: [],
    });
    const issues = validateCollaborationFsmDraft(draft);
    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'UNKNOWN_PARTICIPANT',
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
      edgeId: collaborationEdgeId('build', 'same'),
    });
  });

  it('keeps layout out of Machine semantics and supports undo/redo', () => {
    const draft = defaultCollaborationWorkflowDraft();
    draft.states[0]!.transitions = [
      { outcome: 'again', label: 'Again', targetState: 'build' },
    ];
    const history = createCollaborationDraftHistory(draft);
    const laidOut = autoLayoutCollaborationFsm(draft, 'free');
    laidOut.layout.nodes.build.x += 400;
    history.commit(laidOut);
    expect(history.canUndo()).toBe(true);
    expect(history.undo().layout.nodes.build.x).toBe(
      draft.layout.nodes.build.x,
    );
    expect(history.redo().layout.view).toBe('free');
  });

  it('reports affected edges and highlights one of several Instances', () => {
    let draft = defaultCollaborationWorkflowDraft();
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'build',
      outcome: 'next',
      destination: 'new',
      newStateId: 'review',
      newStateAssigneeId: 'reviewer',
    }).draft;
    draft = addCollaborationOutcomeFirst(draft, {
      sourceStateId: 'review',
      outcome: 'done',
      destination: 'terminal',
      newStateId: 'shipped',
    }).draft;
    expect(
      removeCollaborationState(draft, 'review').affectedEdges,
    ).toHaveLength(2);
    expect(
      collaborationRuntimeGraphHighlights(
        {
          workflowInstances: {
            instance_a: {
              business_state: 'review',
              active_turn_id: 'turn_2',
            },
            instance_b: { business_state: 'build', active_turn_id: null },
          },
          turns: {
            turn_1: {
              workflow_instance_id: 'instance_a',
              state_id: 'build',
              outcome: 'next',
              created_at: '2026-08-06T12:00:00.000Z',
            },
            turn_2: {
              workflow_instance_id: 'instance_a',
              state_id: 'review',
              outcome: null,
              created_at: '2026-08-06T12:01:00.000Z',
            },
          },
        },
        'instance_a',
      ),
    ).toMatchObject({
      currentStateId: 'review',
      visitedStateIds: ['build', 'review'],
      visitedEdgeIds: ['build::next'],
    });
  });
});
