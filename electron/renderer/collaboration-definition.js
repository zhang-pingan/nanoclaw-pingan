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

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1)
    throw new Error(`${label}必须是大于 0 的整数`);
  return normalized;
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null || String(value).trim() === '')
    return null;
  return positiveInteger(value, label);
}

function uniqueIds(entries, kind) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`${kind} ID 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return ids;
}

export function createRoleDraft(index = 1) {
  return {
    id: `role_${index}`,
    displayName: `Role ${index}`,
    minMembers: 1,
    maxMembers: 1,
    capabilities: `capability_${index}`,
  };
}

export function createTransitionDraft(input = {}) {
  return {
    outcome: input.outcome || 'completed',
    targetState: input.targetState || input.stateId || 'state_1',
  };
}

export function createStateDraft(index = 1, input = {}) {
  const id = input.id || `state_${index}`;
  return {
    id,
    label: input.label || `State ${index}`,
    ownerRole: input.roleId || 'role_1',
    terminal: Boolean(input.terminal),
    startTimeoutMs: input.startTimeoutMs ?? '',
    executionTimeoutMs: input.executionTimeoutMs ?? '',
    reminderIntervalMs: input.reminderIntervalMs ?? '',
    transitions: input.terminal
      ? []
      : [createTransitionDraft({ outcome: 'completed', targetState: id })],
  };
}

export function defaultCollaborationCreateDraft() {
  return {
    initialRole: 'developer',
    initialState: 'development',
    roles: [
      {
        id: 'developer',
        displayName: 'Developer',
        minMembers: 1,
        maxMembers: 1,
        capabilities: 'coding_task',
      },
      {
        id: 'reviewer',
        displayName: 'Reviewer',
        minMembers: 1,
        maxMembers: 1,
        capabilities: 'review_task',
      },
    ],
    states: [
      {
        id: 'development',
        label: 'Development',
        ownerRole: 'developer',
        terminal: false,
        transitions: [
          { outcome: 'ready_for_review', targetState: 'review' },
          { outcome: 'blocked', targetState: 'development' },
        ],
      },
      {
        id: 'review',
        label: 'Review',
        ownerRole: 'reviewer',
        terminal: false,
        transitions: [
          { outcome: 'approved', targetState: 'completed' },
          { outcome: 'changes_requested', targetState: 'development' },
        ],
      },
      {
        id: 'completed',
        label: 'Completed',
        ownerRole: '',
        terminal: true,
        transitions: [],
      },
    ],
  };
}

export function buildCollaborationJoinRequest(input) {
  const capabilities = String(input.capabilities ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((capability) => identifier(capability, 'Capability'));
  return {
    remoteUrl: requiredString(input.remoteUrl, 'Git remote'),
    signingKeyPath: requiredString(input.signingKeyPath, 'SSH signing key'),
    capabilities: [...new Set(capabilities)],
    role: identifier(input.role, '角色 ID'),
  };
}

export function buildCollaborationCreateRequest(input) {
  const draft = input.draft;
  if (!draft || typeof draft !== 'object') throw new Error('群组定义不能为空');
  const roles = (draft.roles || []).map((candidate, index) => {
    const id = identifier(candidate.id, `角色 ${index + 1} ID`);
    const min = positiveInteger(candidate.minMembers, `角色 ${id} 最小人数`);
    const max = positiveInteger(candidate.maxMembers, `角色 ${id} 最大人数`);
    if (max < min) throw new Error(`角色 ${id} 的最大人数不能小于最小人数`);
    const capabilities = String(candidate.capabilities ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => identifier(value, `角色 ${id} Capability`));
    return {
      id,
      displayName: requiredString(candidate.displayName, `角色 ${id} 显示名`),
      min,
      max,
      capabilities: [...new Set(capabilities)],
    };
  });
  if (!roles.length) throw new Error('至少需要一个角色');
  const roleIds = uniqueIds(roles, '角色');
  const states = (draft.states || []).map((candidate, index) => ({
    id: identifier(candidate.id, `状态 ${index + 1} ID`),
    label: requiredString(candidate.label, `状态 ${index + 1} 名称`),
    ownerRole: String(candidate.ownerRole ?? '').trim(),
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
  if (!states.length) throw new Error('至少需要一个 FSM 状态');
  const stateIds = uniqueIds(states, '状态');
  const initialRole = identifier(draft.initialRole, '创建者初始角色');
  if (!roleIds.has(initialRole))
    throw new Error(`创建者初始角色不存在：${initialRole}`);
  const initialState = identifier(draft.initialState, 'FSM 初始状态');
  if (!stateIds.has(initialState))
    throw new Error(`FSM 初始状态不存在：${initialState}`);

  const ownedStates = new Map(roles.map((role) => [role.id, []]));
  const machineStates = {};
  for (const state of states) {
    const hasDeadline =
      state.startTimeoutMs !== null || state.executionTimeoutMs !== null;
    const hasTimeoutConfiguration =
      hasDeadline || state.reminderIntervalMs !== null;
    if (state.terminal && (state.ownerRole || state.transitions.length))
      throw new Error(`终态 ${state.id} 不能指定责任角色或 Outcome`);
    if (state.terminal && hasTimeoutConfiguration)
      throw new Error(`终态 ${state.id} 不能配置超时策略`);
    if (!hasDeadline && state.reminderIntervalMs !== null)
      throw new Error(`状态 ${state.id} 必须先配置开始或执行超时`);
    if (!state.terminal && !state.transitions.length)
      throw new Error(`非终态 ${state.id} 至少需要一个 Outcome`);
    let ownerRole;
    if (!state.terminal) {
      ownerRole = identifier(state.ownerRole, `状态 ${state.id} 责任角色`);
      if (!roleIds.has(ownerRole))
        throw new Error(`状态 ${state.id} 引用了未知角色：${ownerRole}`);
      ownedStates.get(ownerRole).push(state.id);
    }
    const outcomes = new Set();
    machineStates[state.id] = {
      label: state.label,
      ...(ownerRole ? { owner_role: ownerRole } : {}),
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
          `状态 ${state.id} Outcome ${index + 1}`,
        );
        if (outcomes.has(outcome))
          throw new Error(`状态 ${state.id} Outcome 重复：${outcome}`);
        outcomes.add(outcome);
        const targetState = identifier(
          candidate.targetState,
          `Outcome ${outcome} 目标状态`,
        );
        if (!stateIds.has(targetState))
          throw new Error(`Outcome ${outcome} 引用了未知状态：${targetState}`);
        return { outcome, target_state: targetState };
      }),
    };
  }

  const roleDefinitions = {};
  for (const role of roles) {
    if (ownedStates.get(role.id).length && role.max !== 1)
      throw new Error(`拥有 State 的角色 ${role.id} 最大人数必须为 1`);
    roleDefinitions[role.id] = {
      format: 'icarus.agent-group-role/2',
      role: role.id,
      display_name: role.displayName,
      cardinality: { min: role.min, max: role.max },
      required_capabilities: role.capabilities,
      owned_states: ownedStates.get(role.id),
    };
  }
  const creatorRole = roles.find((role) => role.id === initialRole);
  return {
    remoteUrl: requiredString(input.remoteUrl, 'Git remote'),
    name: requiredString(input.name, '群组名称'),
    signingKeyPath: requiredString(input.signingKeyPath, 'SSH signing key'),
    capabilities: creatorRole.capabilities,
    initialRole,
    machine: {
      format: 'icarus.agent-group-machine/2',
      initial_state: initialState,
      states: machineStates,
    },
    roles: roleDefinitions,
  };
}
