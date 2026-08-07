import {
  createStateDraft,
  createTransitionDraft,
} from './collaboration-definition.js';

export const COLLABORATION_OUTCOME_PRESETS = [
  { id: 'done', label: 'Done' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'cancelled', label: 'Cancelled' },
];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const LANE_BASE_STRIDE = 190;
const LANE_NODE_STRIDE = 112;

export function collaborationWorkflowEditable(group, definition) {
  if (!group || group.subscriptionMode !== 'member') return false;
  if (definition?.definition?.status === 'retired') return false;
  const principalId = group.localPrincipalId;
  if (!principalId) return false;
  if (principalId === group.ownerPrincipalId) return true;
  const grants =
    group.projection?.permissionGrants?.[principalId]?.grants || [];
  return (
    grants.includes('workflow_definition:propose') ||
    grants.includes('group:admin')
  );
}

export function collaborationWorkflowPublishable(group, definition) {
  if (
    !collaborationWorkflowEditable(group, definition) ||
    definition?.definition?.status !== 'proposed'
  )
    return false;
  if (group.localPrincipalId === group.ownerPrincipalId) return true;
  const grants =
    group.projection?.permissionGrants?.[group.localPrincipalId]?.grants || [];
  return (
    grants.includes('workflow_definition:publish') ||
    grants.includes('group:admin')
  );
}

export function collaborationEdgeId(sourceStateId, outcomeId) {
  return `${sourceStateId}::${outcomeId}`;
}

export function nextCollaborationDraftId(prefix, entries) {
  const ids = new Set(entries.map((entry) => entry.id));
  let index = entries.length + 1;
  while (ids.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function issue(severity, code, message, locator = {}) {
  return { severity, code, message, ...locator };
}

function validTimeout(value) {
  if (value === '' || value === null || value === undefined) return true;
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

export function validateCollaborationFsmDraft(draft) {
  const issues = [];
  const participants = new Set();
  for (const participant of draft.participants || []) {
    if (!participant.id || !IDENTIFIER.test(participant.id))
      issues.push(
        issue('error', 'INVALID_PARTICIPANT_ID', 'Participant ID 不合法', {
          participantId: participant.id,
        }),
      );
    if (participants.has(participant.id))
      issues.push(
        issue(
          'error',
          'DUPLICATE_PARTICIPANT',
          `Participant ID 重复：${participant.id}`,
          { participantId: participant.id },
        ),
      );
    participants.add(participant.id);
  }

  const states = new Map();
  for (const state of draft.states || []) {
    if (!state.id || !IDENTIFIER.test(state.id))
      issues.push(
        issue('error', 'INVALID_STATE_ID', 'State ID 不合法', {
          stateId: state.id,
        }),
      );
    if (states.has(state.id))
      issues.push(
        issue('error', 'DUPLICATE_STATE', `State ID 重复：${state.id}`, {
          stateId: state.id,
        }),
      );
    states.set(state.id, state);
    if (!String(state.label || '').trim())
      issues.push(
        issue('error', 'MISSING_STATE_LABEL', 'State 名称不能为空', {
          stateId: state.id,
        }),
      );
  }
  if (!draft.initialState || !states.has(draft.initialState))
    issues.push(
      issue('error', 'MISSING_INITIAL', '必须指定存在的 initial State'),
    );

  for (const state of states.values()) {
    const transitions = state.transitions || [];
    const hasDeadline =
      state.startTimeoutMs !== '' || state.executionTimeoutMs !== '';
    if (state.terminal) {
      if (state.assigneeId)
        issues.push(
          issue(
            'error',
            'TERMINAL_ASSIGNEE',
            'Terminal State 不能指定 assignee',
            {
              stateId: state.id,
            },
          ),
        );
      if (transitions.length)
        issues.push(
          issue('error', 'TERMINAL_OUTGOING', 'Terminal State 不能有出边', {
            stateId: state.id,
          }),
        );
      if (hasDeadline || state.reminderIntervalMs)
        issues.push(
          issue('error', 'TERMINAL_TIMEOUT', 'Terminal State 不能配置超时', {
            stateId: state.id,
          }),
        );
      continue;
    }
    if (!['participant_slot', 'principal'].includes(state.assigneeType))
      issues.push(
        issue('error', 'MISSING_ASSIGNEE', '非终态必须指定 assignee', {
          stateId: state.id,
        }),
      );
    else if (
      state.assigneeType === 'participant_slot' &&
      !participants.has(state.assigneeId)
    )
      issues.push(
        issue(
          'error',
          'UNKNOWN_PARTICIPANT',
          `引用了未知 Participant：${state.assigneeId}`,
          { stateId: state.id },
        ),
      );
    else if (
      state.assigneeType === 'principal' &&
      !String(state.assigneeId).startsWith('principal_')
    )
      issues.push(
        issue(
          'error',
          'INVALID_PRINCIPAL',
          'Principal ID 必须以 principal_ 开头',
          {
            stateId: state.id,
          },
        ),
      );
    if (!transitions.length)
      issues.push(
        issue('error', 'MISSING_OUTCOME', '非终态至少需要一个 Outcome', {
          stateId: state.id,
        }),
      );
    for (const [label, value] of [
      ['开始超时', state.startTimeoutMs],
      ['执行超时', state.executionTimeoutMs],
      ['提醒间隔', state.reminderIntervalMs],
    ])
      if (!validTimeout(value))
        issues.push(
          issue('error', 'INVALID_TIMEOUT', `${label}必须是正整数`, {
            stateId: state.id,
          }),
        );
    if (!hasDeadline && state.reminderIntervalMs)
      issues.push(
        issue(
          'error',
          'REMINDER_WITHOUT_TIMEOUT',
          '提醒间隔需要开始或执行超时',
          { stateId: state.id },
        ),
      );
    const outcomes = new Set();
    for (const transition of transitions) {
      const edgeId = collaborationEdgeId(state.id, transition.outcome);
      if (!transition.outcome || !IDENTIFIER.test(transition.outcome))
        issues.push(
          issue('error', 'INVALID_OUTCOME', 'Outcome ID 不合法', {
            stateId: state.id,
            edgeId,
          }),
        );
      if (outcomes.has(transition.outcome))
        issues.push(
          issue(
            'error',
            'DUPLICATE_OUTCOME',
            `Outcome ID 重复：${transition.outcome}`,
            { stateId: state.id, edgeId },
          ),
        );
      outcomes.add(transition.outcome);
      if (!states.has(transition.targetState))
        issues.push(
          issue(
            'error',
            'UNKNOWN_TARGET',
            `引用了未知目标 State：${transition.targetState}`,
            { stateId: state.id, edgeId },
          ),
        );
    }
  }

  if (states.has(draft.initialState)) {
    const reachable = new Set([draft.initialState]);
    const queue = [draft.initialState];
    while (queue.length) {
      const current = states.get(queue.shift());
      for (const transition of current?.transitions || [])
        if (
          states.has(transition.targetState) &&
          !reachable.has(transition.targetState)
        ) {
          reachable.add(transition.targetState);
          queue.push(transition.targetState);
        }
    }
    for (const stateId of states.keys())
      if (!reachable.has(stateId))
        issues.push(
          issue(
            'error',
            'UNREACHABLE_STATE',
            'State 无法从 initial State 到达',
            {
              stateId,
            },
          ),
        );
    const terminals = [...states.values()].filter((state) => state.terminal);
    if (!terminals.some((state) => reachable.has(state.id)))
      issues.push(
        terminals.length
          ? issue(
              'error',
              'NO_REACHABLE_TERMINAL',
              '从 initial State 无法到达 terminal State',
              { stateId: draft.initialState },
            )
          : issue(
              'warning',
              'LOOP_WITHOUT_TERMINAL',
              'Workflow 没有 terminal State',
              { stateId: draft.initialState, confirmRequired: true },
            ),
      );
  }
  return issues;
}

function nextStatePosition(draft, sourceStateId, ordinal = 0) {
  const source = draft.layout?.nodes?.[sourceStateId] || { x: 80, y: 120 };
  return { x: source.x + 280, y: source.y + ordinal * 160 };
}

export function addCollaborationOutcomeFirst(draft, input) {
  const next = structuredClone(draft);
  const source = next.states.find((state) => state.id === input.sourceStateId);
  if (!source) throw new Error(`State 不存在：${input.sourceStateId}`);
  if (source.terminal) throw new Error('Terminal State 不能添加 Outcome');
  const outcome = String(input.outcome || '').trim();
  if (!outcome) throw new Error('Outcome ID 不能为空');
  if (source.transitions.some((transition) => transition.outcome === outcome))
    throw new Error(`Outcome ID 重复：${outcome}`);

  let targetState = input.targetStateId || '';
  let createdStateId = null;
  if (input.destination === 'self') targetState = source.id;
  else if (input.destination === 'new' || input.destination === 'terminal') {
    const terminal = input.destination === 'terminal';
    const id =
      input.newStateId ||
      nextCollaborationDraftId(terminal ? 'terminal' : 'state', next.states);
    if (next.states.some((state) => state.id === id))
      throw new Error(`State ID 重复：${id}`);
    const created = createStateDraft(next.states.length + 1, {
      id,
      label: input.newStateLabel || id,
      terminal,
      assigneeType: input.newStateAssigneeType || 'participant_slot',
      assigneeId:
        input.newStateAssigneeId ||
        source.assigneeId ||
        next.participants[0]?.id,
      transitions: terminal ? [] : [],
    });
    next.states.push(created);
    next.layout.nodes[id] = nextStatePosition(
      next,
      source.id,
      source.transitions.length,
    );
    targetState = id;
    createdStateId = id;
  }
  if (!next.states.some((state) => state.id === targetState))
    throw new Error(`目标 State 不存在：${targetState}`);
  source.transitions.push(
    createTransitionDraft({
      outcome,
      label: input.label || outcome,
      targetState,
    }),
  );
  return {
    draft: next,
    createdStateId,
    selectedStateId: createdStateId || source.id,
    selectedEdgeId: collaborationEdgeId(source.id, outcome),
  };
}

export function removeCollaborationOutcome(draft, sourceStateId, outcome) {
  const next = structuredClone(draft);
  const source = next.states.find((state) => state.id === sourceStateId);
  if (!source) return next;
  source.transitions = source.transitions.filter(
    (transition) => transition.outcome !== outcome,
  );
  return next;
}

export function removeCollaborationState(draft, stateId) {
  const next = structuredClone(draft);
  const affectedEdges = [];
  for (const state of next.states)
    for (const transition of state.transitions || [])
      if (state.id === stateId || transition.targetState === stateId)
        affectedEdges.push({
          sourceStateId: state.id,
          outcome: transition.outcome,
          targetStateId: transition.targetState,
        });
  next.states = next.states.filter((state) => state.id !== stateId);
  for (const state of next.states)
    state.transitions = state.transitions.filter(
      (transition) => transition.targetState !== stateId,
    );
  delete next.layout.nodes[stateId];
  if (next.initialState === stateId)
    next.initialState = next.states[0]?.id || '';
  const issues = validateCollaborationFsmDraft(next);
  return {
    draft: next,
    affectedEdges,
    orphanedStateIds: issues
      .filter((entry) => entry.code === 'UNREACHABLE_STATE')
      .map((entry) => entry.stateId),
  };
}

export function moveCollaborationState(draft, stateId, position) {
  const next = structuredClone(draft);
  next.layout.nodes[stateId] = {
    x: Math.round(Number(position.x) || 0),
    y: Math.round(Number(position.y) || 0),
  };
  return next;
}

function assigneeLane(state) {
  if (state.terminal) return '__terminal__';
  return `${state.assigneeType}:${state.assigneeId}`;
}

export function collaborationParticipantLaneStride(draft) {
  const counts = new Map();
  for (const state of draft.states || []) {
    const lane = assigneeLane(state);
    counts.set(lane, (counts.get(lane) || 0) + 1);
  }
  return Math.max(
    LANE_BASE_STRIDE,
    ...[...counts.values()].map(
      (count) => LANE_BASE_STRIDE + Math.max(0, count - 1) * LANE_NODE_STRIDE,
    ),
  );
}

export function autoLayoutCollaborationFsm(draft, view = 'free') {
  const next = structuredClone(draft);
  const stateById = new Map(next.states.map((state) => [state.id, state]));
  const ranks = new Map([[next.initialState, 0]]);
  const queue = [next.initialState];
  while (queue.length) {
    const id = queue.shift();
    const rank = ranks.get(id) || 0;
    for (const transition of stateById.get(id)?.transitions || [])
      if (!ranks.has(transition.targetState)) {
        ranks.set(transition.targetState, rank + 1);
        queue.push(transition.targetState);
      }
  }
  let fallbackRank = Math.max(0, ...ranks.values()) + 1;
  for (const state of next.states)
    if (!ranks.has(state.id)) ranks.set(state.id, fallbackRank++);

  const laneKeys = [...new Set(next.states.map(assigneeLane))];
  const laneStride = collaborationParticipantLaneStride(next);
  const laneOccupancy = new Map();
  next.layout.view = view === 'participants' ? 'participants' : 'free';
  for (const state of next.states) {
    const rank = ranks.get(state.id) || 0;
    if (next.layout.view === 'participants') {
      const lane = laneKeys.indexOf(assigneeLane(state));
      const key = `${lane}:${rank}`;
      const ordinal = laneOccupancy.get(key) || 0;
      laneOccupancy.set(key, ordinal + 1);
      next.layout.nodes[state.id] = {
        x: 100 + rank * 280,
        y: 92 + lane * laneStride + ordinal * LANE_NODE_STRIDE,
      };
    } else {
      const ordinal = [...ranks.entries()].filter(
        ([id, value]) => value === rank && id < state.id,
      ).length;
      next.layout.nodes[state.id] = {
        x: 100 + rank * 280,
        y: 100 + ordinal * 170,
      };
    }
  }
  return next;
}

export function collaborationRuntimeGraphHighlights(projection, instanceId) {
  const instance = projection?.workflowInstances?.[instanceId];
  if (!instance)
    return {
      currentStateId: null,
      visitedStateIds: [],
      visitedEdgeIds: [],
    };
  const turns = Object.values(projection.turns || {})
    .filter((turn) => turn.workflow_instance_id === instanceId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  return {
    currentStateId: instance.business_state,
    visitedStateIds: [...new Set(turns.map((turn) => turn.state_id))],
    visitedEdgeIds: turns
      .filter((turn) => turn.outcome)
      .map((turn) => collaborationEdgeId(turn.state_id, turn.outcome)),
  };
}

export function createCollaborationDraftHistory(initialDraft, limit = 50) {
  const undoStack = [];
  const redoStack = [];
  let current = structuredClone(initialDraft);
  return {
    current: () => structuredClone(current),
    commit(next) {
      undoStack.push(structuredClone(current));
      if (undoStack.length > limit) undoStack.shift();
      current = structuredClone(next);
      redoStack.length = 0;
      return this.current();
    },
    undo() {
      if (!undoStack.length) return this.current();
      redoStack.push(structuredClone(current));
      current = undoStack.pop();
      return this.current();
    },
    redo() {
      if (!redoStack.length) return this.current();
      undoStack.push(structuredClone(current));
      current = redoStack.pop();
      return this.current();
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}
