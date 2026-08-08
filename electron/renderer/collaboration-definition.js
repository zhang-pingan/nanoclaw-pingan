import { collaborationLabel } from './collaboration-labels.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function identifier(value, label) {
  const normalized = requiredString(value, label);
  if (normalized.length > 160 || !IDENTIFIER.test(normalized))
    throw new Error(`${label}不是合法 ID`);
  return normalized;
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null || String(value).trim() === '')
    return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1)
    throw new Error(`${label}必须是大于 0 的整数`);
  return normalized;
}

function uniqueIds(entries, kind) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`${kind} ID 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return ids;
}

export function createParticipantDraft(index = 1) {
  return { id: `participant_${index}`, label: `参与者 ${index}` };
}

export function createTransitionDraft(input = {}) {
  return {
    outcome: input.outcome || 'done',
    label: input.label || input.outcome || '完成',
    targetState: input.targetState || input.stateId || 'state_1',
  };
}

export function createStateDraft(index = 1, input = {}) {
  const id = input.id || `state_${index}`;
  return {
    id,
    label: input.label || `状态 ${index}`,
    description: input.description || '',
    assigneeType: input.terminal
      ? ''
      : input.assigneeType || 'participant_slot',
    assigneeId: input.terminal
      ? ''
      : input.assigneeId || input.participantId || 'builder',
    terminal: Boolean(input.terminal),
    startTimeoutMs: input.startTimeoutMs ?? '',
    executionTimeoutMs: input.executionTimeoutMs ?? '',
    reminderIntervalMs: input.reminderIntervalMs ?? '',
    transitions: input.terminal ? [] : [...(input.transitions || [])],
  };
}

export function defaultCollaborationWorkflowDraft() {
  return {
    definitionId: 'delivery',
    version: 1,
    name: '交付流程',
    description: '',
    initialState: 'build',
    participants: [
      { id: 'builder', label: '构建者' },
      { id: 'reviewer', label: '审核者' },
    ],
    states: [
      createStateDraft(1, {
        id: 'build',
        label: '构建',
        participantId: 'builder',
      }),
    ],
    layout: {
      format: 'icarus.collaboration-workflow-layout/1',
      view: 'participants',
      nodes: { build: { x: 96, y: 160 } },
      revision: 1,
    },
  };
}

export function buildCollaborationCreateRequest(input) {
  const gitSshKeyPath = String(input.gitSshKeyPath ?? '').trim();
  return {
    remoteUrl: requiredString(input.remoteUrl, 'Git 远程仓库'),
    name: requiredString(input.name, '群组名称'),
    ...(gitSshKeyPath ? { gitSshKeyPath } : {}),
    displayName: requiredString(input.displayName, '成员显示名'),
    clientDisplayName: requiredString(input.clientDisplayName, '客户端名称'),
    membershipPolicy: ['open', 'approval', 'invite_only'].includes(
      input.membershipPolicy,
    )
      ? input.membershipPolicy
      : 'approval',
    observerAccess:
      input.observerAccess === 'members_only' ? 'members_only' : 'allowed',
  };
}

export function buildCollaborationObserveRequest(input) {
  return {
    remoteUrl: requiredString(input.remoteUrl, 'Git 远程仓库'),
  };
}

export function buildCollaborationJoinRequest(input) {
  const explicitGitSshKeyPath = String(input.gitSshKeyPath ?? '').trim();
  const configuredGitSshKeyPath = String(
    input.configuredGitSshKeyPath ?? '',
  ).trim();
  const gitSshKeyPath = explicitGitSshKeyPath || configuredGitSshKeyPath;
  return {
    ...(gitSshKeyPath ? { gitSshKeyPath } : {}),
    displayName: requiredString(input.displayName, '成员显示名'),
    clientDisplayName: requiredString(input.clientDisplayName, '客户端名称'),
    ...(String(input.inviteId || '').trim()
      ? { inviteId: identifier(input.inviteId, '邀请 ID') }
      : {}),
  };
}

export function buildCollaborationWorkflowRequest(input) {
  const draft = input.draft;
  if (!draft || typeof draft !== 'object') throw new Error('工作流不能为空');
  const participants = (draft.participants || []).map((entry, index) => ({
    id: identifier(entry.id, `参与者 ${index + 1} ID`),
    label: requiredString(entry.label, `参与者 ${index + 1} 名称`),
  }));
  const participantIds = uniqueIds(participants, '参与者');
  const states = (draft.states || []).map((candidate, index) => ({
    id: identifier(candidate.id, `状态 ${index + 1} ID`),
    label: requiredString(candidate.label, `状态 ${index + 1} 名称`),
    description: String(candidate.description ?? '').trim(),
    assigneeType: String(candidate.assigneeType || '').trim(),
    assigneeId: String(candidate.assigneeId || '').trim(),
    terminal: Boolean(candidate.terminal),
    startTimeoutMs: optionalPositiveInteger(
      candidate.startTimeoutMs,
      `状态 ${candidate.id || index + 1} 开始超时`,
    ),
    executionTimeoutMs: optionalPositiveInteger(
      candidate.executionTimeoutMs,
      `状态 ${candidate.id || index + 1} 执行超时`,
    ),
    reminderIntervalMs: optionalPositiveInteger(
      candidate.reminderIntervalMs,
      `状态 ${candidate.id || index + 1} 提醒间隔`,
    ),
    transitions: candidate.transitions || [],
  }));
  if (!states.length) throw new Error('至少需要一个状态');
  const stateIds = uniqueIds(states, '状态');
  const initialState = identifier(draft.initialState, '初始状态');
  if (!stateIds.has(initialState))
    throw new Error(`初始状态不存在：${initialState}`);

  const machineStates = {};
  for (const state of states) {
    const hasDeadline =
      state.startTimeoutMs !== null || state.executionTimeoutMs !== null;
    const hasTimeout = hasDeadline || state.reminderIntervalMs !== null;
    if (state.terminal && (state.assigneeId || state.transitions.length))
      throw new Error(`终止状态 ${state.id} 不能指定负责人或执行结果`);
    if (state.terminal && hasTimeout)
      throw new Error(`终止状态 ${state.id} 不能配置超时策略`);
    if (!hasDeadline && state.reminderIntervalMs !== null)
      throw new Error(`状态 ${state.id} 必须先配置开始或执行超时`);
    if (!state.terminal && !state.transitions.length)
      throw new Error(`非终止状态 ${state.id} 至少需要一个执行结果`);
    let assignee;
    if (!state.terminal) {
      const assigneeId = identifier(
        state.assigneeId,
        `状态 ${state.id} 负责人`,
      );
      if (state.assigneeType === 'participant_slot') {
        if (!participantIds.has(assigneeId))
          throw new Error(`状态 ${state.id} 引用了未知参与者：${assigneeId}`);
        assignee = { type: 'participant_slot', slot: assigneeId };
      } else if (state.assigneeType === 'principal') {
        if (!assigneeId.startsWith('principal_'))
          throw new Error(`状态 ${state.id} 成员 ID 不合法`);
        assignee = { type: 'principal', principal_id: assigneeId };
      } else throw new Error(`状态 ${state.id} 的负责人类型不合法`);
    }
    const outcomes = new Set();
    machineStates[state.id] = {
      label: state.label,
      description: state.description,
      ...(assignee ? { assignee } : {}),
      terminal: state.terminal,
      ...(hasDeadline
        ? {
            timeout_policy: {
              start_timeout_ms: state.startTimeoutMs,
              execution_timeout_ms: state.executionTimeoutMs,
              reminder_interval_ms: state.reminderIntervalMs,
              on_timeout: 'notify_only',
            },
          }
        : {}),
      transitions: state.transitions.map((candidate, index) => {
        const outcome = identifier(
          candidate.outcome,
          `状态 ${state.id} 执行结果 ${index + 1}`,
        );
        if (outcomes.has(outcome))
          throw new Error(`状态 ${state.id} 的执行结果重复：${outcome}`);
        outcomes.add(outcome);
        const targetState = identifier(
          candidate.targetState,
          `执行结果 ${outcome} 的目标状态`,
        );
        if (!stateIds.has(targetState))
          throw new Error(`执行结果 ${outcome} 引用了未知状态：${targetState}`);
        return {
          outcome,
          label: requiredString(
            candidate.label || outcome,
            `执行结果 ${outcome}`,
          ),
          target_state: targetState,
        };
      }),
    };
  }

  return {
    definitionId: identifier(draft.definitionId, '定义 ID'),
    expectedRevision: Number(input.expectedRevision ?? 0),
    version: Number(draft.version || 1),
    name: requiredString(draft.name, '工作流名称'),
    description: String(draft.description || '').trim(),
    launchPolicy: input.launchPolicy || {
      group_admin: true,
      work_item_owner: true,
      principals: [],
    },
    machine: {
      format: 'icarus.collaboration-machine/3',
      initial_state: initialState,
      states: machineStates,
    },
    layout: {
      format: 'icarus.collaboration-workflow-layout/1',
      view: draft.layout?.view === 'free' ? 'free' : 'participants',
      nodes: Object.fromEntries(
        states.map((state, index) => {
          const position = draft.layout?.nodes?.[state.id];
          return [
            state.id,
            {
              x: Number.isFinite(Number(position?.x))
                ? Number(position.x)
                : 96 + (index % 3) * 260,
              y: Number.isFinite(Number(position?.y))
                ? Number(position.y)
                : 120 + Math.floor(index / 3) * 180,
            },
          ];
        }),
      ),
      revision: Number(draft.layout?.revision || 1),
    },
  };
}

export function collaborationDraftFromDefinition(definition) {
  const machine = definition?.machine || { initial_state: '', states: {} };
  const slots = new Set();
  for (const state of Object.values(machine.states || {}))
    if (state.assignee?.type === 'participant_slot')
      slots.add(state.assignee.slot);
  const states = Object.entries(machine.states || {}).map(([id, state]) => ({
    id,
    label: collaborationLabel(state.label || id, id),
    description: state.description || '',
    assigneeType: state.assignee?.type || '',
    assigneeId:
      state.assignee?.type === 'principal'
        ? state.assignee.principal_id
        : state.assignee?.slot || '',
    terminal: Boolean(state.terminal),
    startTimeoutMs: state.timeout_policy?.start_timeout_ms ?? '',
    executionTimeoutMs: state.timeout_policy?.execution_timeout_ms ?? '',
    reminderIntervalMs: state.timeout_policy?.reminder_interval_ms ?? '',
    transitions: (state.transitions || []).map((transition) => ({
      outcome: transition.outcome,
      label: collaborationLabel(
        transition.label || transition.outcome,
        transition.outcome,
      ),
      targetState: transition.target_state,
    })),
  }));
  return {
    definitionId: definition?.definition?.definition_id || 'workflow',
    version: definition?.definition?.version || 1,
    name: collaborationLabel(definition?.definition?.name || '工作流'),
    description: definition?.definition?.description || '',
    initialState: machine.initial_state || states[0]?.id || '',
    participants: [...slots].map((id) => ({
      id,
      label: collaborationLabel(id, id),
    })),
    states,
    layout: {
      format: 'icarus.collaboration-workflow-layout/1',
      view: definition?.layout?.view === 'free' ? 'free' : 'participants',
      nodes: structuredClone(definition?.layout?.nodes || {}),
      revision: definition?.layout?.revision || 1,
    },
  };
}
