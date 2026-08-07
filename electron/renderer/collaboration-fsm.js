import {
  createStateDraft,
  createTransitionDraft,
} from './collaboration-definition.js';

export const COLLABORATION_OUTCOME_PRESETS = [
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'cancelled', label: 'Cancelled' },
];

export function collaborationMachineEditable(group) {
  return Boolean(
    group &&
    group.localPrincipalId === group.creatorPrincipalId &&
    ['FORMING', 'PAUSED'].includes(group.lifecycle),
  );
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const ROLE_LANE_BASE_STRIDE = 190;
const ROLE_LANE_NODE_STRIDE = 112;

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

function positiveTimeout(value) {
  if (value === '' || value === null || value === undefined) return true;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0;
}

export function validateCollaborationFsmDraft(draft) {
  const issues = [];
  const roles = new Set();
  for (const role of draft.roles || []) {
    if (!role.id || !IDENTIFIER.test(role.id))
      issues.push(
        issue('error', 'INVALID_ROLE_ID', '角色 ID 不合法', {
          roleId: role.id,
        }),
      );
    if (roles.has(role.id))
      issues.push(
        issue('error', 'DUPLICATE_ROLE', `角色 ID 重复：${role.id}`, {
          roleId: role.id,
        }),
      );
    roles.add(role.id);
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
        issue('error', 'MISSING_STATE_LABEL', 'State 显示名称不能为空', {
          stateId: state.id,
        }),
      );
  }
  if (!draft.initialState || !states.has(draft.initialState))
    issues.push(
      issue('error', 'MISSING_INITIAL', '必须指定唯一存在的 initial State'),
    );

  for (const state of states.values()) {
    const transitions = state.transitions || [];
    const hasDeadline =
      state.startTimeoutMs !== '' || state.executionTimeoutMs !== '';
    if (state.terminal) {
      if (state.ownerRole)
        issues.push(
          issue('error', 'TERMINAL_OWNER', 'Terminal State 不能指定责任角色', {
            stateId: state.id,
          }),
        );
      if (transitions.length)
        issues.push(
          issue('error', 'TERMINAL_OUTGOING', 'Terminal State 不能有出边', {
            stateId: state.id,
          }),
        );
      if (
        hasDeadline ||
        (state.reminderIntervalMs !== '' &&
          state.reminderIntervalMs !== null &&
          state.reminderIntervalMs !== undefined)
      )
        issues.push(
          issue('error', 'TERMINAL_TIMEOUT', 'Terminal State 不能配置超时', {
            stateId: state.id,
          }),
        );
      continue;
    }
    if (!state.ownerRole)
      issues.push(
        issue('error', 'MISSING_OWNER', '非终态必须指定责任角色', {
          stateId: state.id,
        }),
      );
    else if (!roles.has(state.ownerRole))
      issues.push(
        issue('error', 'UNKNOWN_ROLE', `引用了未知角色：${state.ownerRole}`, {
          stateId: state.id,
        }),
      );
    if (!transitions.length)
      issues.push(
        issue('error', 'MISSING_OUTCOME', '非终态至少需要一个执行结果', {
          stateId: state.id,
        }),
      );
    for (const [field, value] of [
      ['开始超时', state.startTimeoutMs],
      ['执行超时', state.executionTimeoutMs],
      ['提醒间隔', state.reminderIntervalMs],
    ])
      if (!positiveTimeout(value))
        issues.push(
          issue('error', 'INVALID_TIMEOUT', `${field}必须是大于 0 的整数`, {
            stateId: state.id,
          }),
        );
    if (
      !hasDeadline &&
      state.reminderIntervalMs !== '' &&
      state.reminderIntervalMs != null
    )
      issues.push(
        issue(
          'error',
          'REMINDER_WITHOUT_TIMEOUT',
          '提醒间隔需要开始超时或执行超时',
          { stateId: state.id },
        ),
      );
    const outcomes = new Set();
    for (const transition of transitions) {
      const edgeId = collaborationEdgeId(state.id, transition.outcome);
      if (!transition.outcome || !IDENTIFIER.test(transition.outcome))
        issues.push(
          issue('error', 'INVALID_OUTCOME', '执行结果 ID 不合法', {
            stateId: state.id,
            edgeId,
          }),
        );
      if (outcomes.has(transition.outcome))
        issues.push(
          issue(
            'error',
            'DUPLICATE_OUTCOME',
            `执行结果 ID 重复：${transition.outcome}`,
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
    const terminalStates = [...states.values()].filter(
      (state) => state.terminal,
    );
    if (!terminalStates.some((state) => reachable.has(state.id)))
      issues.push(
        terminalStates.length
          ? issue(
              'error',
              'NO_REACHABLE_TERMINAL',
              '从 initial State 无法到达任何 terminal State',
              { stateId: draft.initialState },
            )
          : issue(
              'warning',
              'LOOP_WITHOUT_TERMINAL',
              '流程没有 terminal State；发布前需要显式确认纯循环设计',
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
  if (source.terminal) throw new Error('Terminal State 不能添加执行结果');
  const outcome = String(input.outcome || '').trim();
  if (!outcome) throw new Error('执行结果 ID 不能为空');
  if (source.transitions.some((transition) => transition.outcome === outcome))
    throw new Error(`执行结果 ID 重复：${outcome}`);

  let targetState = input.targetStateId || '';
  let createdStateId = null;
  if (input.destination === 'self') targetState = source.id;
  else if (input.destination === 'new' || input.destination === 'terminal') {
    const terminal = input.destination === 'terminal';
    const prefix = terminal ? 'terminal' : 'state';
    const id =
      input.newStateId || nextCollaborationDraftId(prefix, next.states);
    const created = createStateDraft(next.states.length + 1, {
      id,
      label: input.newStateLabel || (terminal ? 'Terminal' : 'New State'),
      roleId: terminal ? '' : input.newStateOwnerRole || source.ownerRole,
      terminal,
    });
    next.states.push(created);
    next.layout ||= {
      format: 'icarus.agent-group-machine-layout/1',
      view: 'free',
      nodes: {},
    };
    next.layout.nodes[id] = nextStatePosition(
      next,
      source.id,
      source.transitions.length,
    );
    targetState = id;
    createdStateId = id;
  }
  if (!next.states.some((state) => state.id === targetState))
    throw new Error('请选择存在的目标 State');
  source.transitions.push(
    createTransitionDraft({
      outcome,
      label: String(input.label || outcome).trim(),
      targetState,
    }),
  );
  return {
    draft: next,
    selectedStateId: createdStateId || source.id,
    createdStateId,
    edgeId: collaborationEdgeId(source.id, outcome),
  };
}

export function renameCollaborationState(draft, from, to) {
  if (!from || !to || from === to) return structuredClone(draft);
  const next = structuredClone(draft);
  const state = next.states.find((candidate) => candidate.id === from);
  if (!state) throw new Error(`State 不存在：${from}`);
  if (next.states.some((candidate) => candidate.id === to))
    throw new Error(`State ID 重复：${to}`);
  state.id = to;
  if (next.initialState === from) next.initialState = to;
  for (const candidate of next.states)
    for (const transition of candidate.transitions)
      if (transition.targetState === from) transition.targetState = to;
  if (next.layout?.nodes?.[from]) {
    next.layout.nodes[to] = next.layout.nodes[from];
    delete next.layout.nodes[from];
  }
  return next;
}

export function removeCollaborationState(draft, stateId) {
  const next = structuredClone(draft);
  const affectedEdges = [];
  for (const state of next.states)
    for (const transition of state.transitions)
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
  if (next.initialState === stateId)
    next.initialState = next.states[0]?.id || '';
  if (next.layout?.nodes) delete next.layout.nodes[stateId];
  const orphanedStateIds = next.states
    .filter(
      (state) =>
        state.id !== next.initialState &&
        !next.states.some((source) =>
          source.transitions.some(
            (transition) => transition.targetState === state.id,
          ),
        ),
    )
    .map((state) => state.id);
  return { draft: next, affectedEdges, orphanedStateIds };
}

function collaborationStateRanks(draft) {
  const states = new Map(draft.states.map((state) => [state.id, state]));
  const rank = new Map();
  if (states.has(draft.initialState)) {
    rank.set(draft.initialState, 0);
    const queue = [draft.initialState];
    while (queue.length) {
      const stateId = queue.shift();
      const currentRank = rank.get(stateId) || 0;
      for (const transition of states.get(stateId)?.transitions || [])
        if (
          states.has(transition.targetState) &&
          !rank.has(transition.targetState)
        ) {
          rank.set(transition.targetState, currentRank + 1);
          queue.push(transition.targetState);
        }
    }
  }
  let fallbackRank = Math.max(0, ...rank.values()) + 1;
  for (const state of draft.states)
    if (!rank.has(state.id)) rank.set(state.id, fallbackRank++);
  return rank;
}

function roleLaneStride(draft, rank) {
  const stacks = new Map();
  let maxStack = 1;
  for (const state of draft.states) {
    const lane = state.terminal ? '__terminal__' : state.ownerRole;
    const key = `${lane}:${rank.get(state.id)}`;
    const count = (stacks.get(key) || 0) + 1;
    stacks.set(key, count);
    maxStack = Math.max(maxStack, count);
  }
  return ROLE_LANE_BASE_STRIDE + (maxStack - 1) * ROLE_LANE_NODE_STRIDE;
}

export function collaborationRoleLaneStride(draft) {
  return roleLaneStride(draft, collaborationStateRanks(draft));
}

export function autoLayoutCollaborationFsm(draft, view = 'free') {
  const next = structuredClone(draft);
  const rank = collaborationStateRanks(next);
  const nodes = {};
  if (view === 'roles') {
    const lanes = [
      ...next.roles.map((role) => role.id),
      ...(next.states.some((state) => state.terminal) ? ['__terminal__'] : []),
    ];
    const laneCounts = new Map();
    const laneStride = roleLaneStride(next, rank);
    for (const state of next.states) {
      const lane = state.terminal ? '__terminal__' : state.ownerRole;
      const laneIndex = Math.max(0, lanes.indexOf(lane));
      const key = `${lane}:${rank.get(state.id)}`;
      const ordinal = laneCounts.get(key) || 0;
      laneCounts.set(key, ordinal + 1);
      nodes[state.id] = {
        x: 88 + (rank.get(state.id) || 0) * 280,
        y: 88 + laneIndex * laneStride + ordinal * ROLE_LANE_NODE_STRIDE,
      };
    }
  } else {
    const columns = new Map();
    for (const state of next.states) {
      const column = rank.get(state.id) || 0;
      const ordinal = columns.get(column) || 0;
      columns.set(column, ordinal + 1);
      nodes[state.id] = { x: 88 + column * 280, y: 96 + ordinal * 170 };
    }
  }
  next.layout = {
    format: 'icarus.agent-group-machine-layout/1',
    view,
    nodes,
  };
  return next;
}

export function collaborationRuntimeGraphHighlights(definition, projection) {
  const nodeIds = new Set();
  const edgeIds = new Set();
  for (const turn of Object.values(projection?.turns || {})) {
    nodeIds.add(turn.stateId);
    if (turn.outcome)
      edgeIds.add(collaborationEdgeId(turn.stateId, turn.outcome));
  }
  if (projection?.businessState) nodeIds.add(projection.businessState);
  return {
    visitedNodeIds: [...nodeIds],
    visitedEdgeIds: [...edgeIds],
    currentStateId:
      projection?.businessState || definition?.machine?.initial_state || '',
  };
}

export function createCollaborationDraftHistory(initialDraft) {
  let present = structuredClone(initialDraft);
  const past = [];
  const future = [];
  return {
    current: () => structuredClone(present),
    commit(next) {
      past.push(structuredClone(present));
      present = structuredClone(next);
      future.length = 0;
      return this.current();
    },
    undo() {
      if (!past.length) return this.current();
      future.push(structuredClone(present));
      present = past.pop();
      return this.current();
    },
    redo() {
      if (!future.length) return this.current();
      past.push(structuredClone(present));
      present = future.pop();
      return this.current();
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
