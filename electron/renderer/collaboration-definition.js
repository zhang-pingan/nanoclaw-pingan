const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const INTERACTIONS = new Set(['headless', 'visible_session']);
const EXECUTOR_MODES = new Set(['run_once', 'workflow', 'codex-task']);
const FILESYSTEM_ACCESS = new Set(['read_only', 'workspace_write']);

export const COLLABORATION_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
];

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

function uniqueEntries(entries, kind) {
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`${kind} ID 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return ids;
}

function defaultOutcomes(stateId) {
  return Object.fromEntries(
    COLLABORATION_OUTCOMES.map((outcome) => [outcome, stateId]),
  );
}

export function createRoleDraft(index = 1) {
  return {
    id: `role_${index}`,
    displayName: `Role ${index}`,
    minMembers: 1,
    maxMembers: 1,
    capability: `capability_${index}`,
    interaction: 'visible_session',
  };
}

export function createActionDraft(index = 1) {
  return {
    id: `action_${index}`,
    executorMode: 'run_once',
    filesystemAccess: 'workspace_write',
    workflowRef: '',
    prompt: `Complete action ${index} and return a concise result.`,
  };
}

export function createTransitionDraft(input = {}) {
  const stateId = input.stateId || 'state_1';
  return {
    id: input.id || 'transition_1',
    roleId: input.roleId || 'role_1',
    actionId: input.actionId || 'action_1',
    outcomes: defaultOutcomes(stateId),
  };
}

export function createStateDraft(index = 1, input = {}) {
  const id = input.id || `state_${index}`;
  return {
    id,
    terminal: Boolean(input.terminal),
    transitions: input.terminal
      ? []
      : [
          createTransitionDraft({
            stateId: id,
            id: `transition_${index}`,
            roleId: input.roleId,
            actionId: input.actionId,
          }),
        ],
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
        capability: 'coding_task',
        interaction: 'visible_session',
      },
      {
        id: 'reviewer',
        displayName: 'Reviewer',
        minMembers: 1,
        maxMembers: 1,
        capability: 'review_task',
        interaction: 'visible_session',
      },
    ],
    actions: [
      {
        id: 'implement',
        executorMode: 'run_once',
        filesystemAccess: 'workspace_write',
        workflowRef: '',
        prompt: 'Implement the assigned change and return a concise result.',
      },
      {
        id: 'review',
        executorMode: 'run_once',
        filesystemAccess: 'read_only',
        workflowRef: '',
        prompt: 'Review the result and return a concise verdict.',
      },
    ],
    states: [
      {
        id: 'development',
        terminal: false,
        transitions: [
          {
            id: 'implement',
            roleId: 'developer',
            actionId: 'implement',
            outcomes: {
              succeeded: 'review',
              failed: 'development',
              cancelled: 'development',
              blocked: 'development',
            },
          },
        ],
      },
      {
        id: 'review',
        terminal: false,
        transitions: [
          {
            id: 'review',
            roleId: 'reviewer',
            actionId: 'review',
            outcomes: {
              succeeded: 'development',
              failed: 'development',
              cancelled: 'review',
              blocked: 'review',
            },
          },
        ],
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
  if (!capabilities.length) throw new Error('Capabilities不能为空');
  return {
    remoteUrl: requiredString(input.remoteUrl, 'Git remote'),
    signingKeyPath: requiredString(input.signingKeyPath, 'SSH signing key'),
    capabilities: [...new Set(capabilities)],
    role: identifier(input.role, '角色 ID'),
  };
}

export function buildCollaborationCreateRequest(input) {
  const remoteUrl = requiredString(input.remoteUrl, 'Git remote');
  const name = requiredString(input.name, '群组名称');
  const signingKeyPath = requiredString(
    input.signingKeyPath,
    'SSH signing key',
  );
  const draft = input.draft;
  if (!draft || typeof draft !== 'object') throw new Error('群组定义不能为空');

  const roles = (draft.roles || []).map((candidate, index) => {
    const id = identifier(candidate.id, `角色 ${index + 1} ID`);
    const min = positiveInteger(candidate.minMembers, `角色 ${id} 最小人数`);
    const max = positiveInteger(candidate.maxMembers, `角色 ${id} 最大人数`);
    if (max < min) throw new Error(`角色 ${id} 的最大人数不能小于最小人数`);
    const interaction = requiredString(
      candidate.interaction,
      `角色 ${id} interaction`,
    );
    if (!INTERACTIONS.has(interaction))
      throw new Error(`角色 ${id} 的 interaction 非法`);
    return {
      id,
      displayName: requiredString(candidate.displayName, `角色 ${id} 显示名`),
      min,
      max,
      capability: identifier(candidate.capability, `角色 ${id} capability`),
      interaction,
    };
  });
  if (!roles.length) throw new Error('至少需要一个角色');
  const roleIds = uniqueEntries(roles, '角色');

  const actions = (draft.actions || []).map((candidate, index) => {
    const id = identifier(candidate.id, `Action ${index + 1} ID`);
    const executorMode = requiredString(
      candidate.executorMode,
      `Action ${id} Executor`,
    );
    if (!EXECUTOR_MODES.has(executorMode))
      throw new Error(`Action ${id} 的 Executor 非法`);
    const filesystemAccess = requiredString(
      candidate.filesystemAccess,
      `Action ${id} 文件权限`,
    );
    if (!FILESYSTEM_ACCESS.has(filesystemAccess))
      throw new Error(`Action ${id} 的文件权限非法`);
    const workflowRef = String(candidate.workflowRef ?? '').trim();
    if (executorMode === 'workflow')
      identifier(workflowRef, `Action ${id} Workflow ref`);
    return {
      id,
      executorMode,
      filesystemAccess,
      workflowRef,
      prompt: requiredString(candidate.prompt, `Action ${id} Prompt`),
    };
  });
  if (!actions.length) throw new Error('至少需要一个 Action');
  const actionIds = uniqueEntries(actions, 'Action');

  const states = (draft.states || []).map((candidate, index) => ({
    id: identifier(candidate.id, `状态 ${index + 1} ID`),
    terminal: Boolean(candidate.terminal),
    transitions: candidate.transitions || [],
  }));
  if (!states.length) throw new Error('至少需要一个 FSM 状态');
  const stateIds = uniqueEntries(states, '状态');
  const initialRole = identifier(draft.initialRole, '创建者初始角色');
  if (!roleIds.has(initialRole))
    throw new Error(`创建者初始角色不存在：${initialRole}`);
  const initialState = identifier(draft.initialState, 'FSM 初始状态');
  if (!stateIds.has(initialState))
    throw new Error(`FSM 初始状态不存在：${initialState}`);

  const transitionIds = new Set();
  const transitionsByRole = new Map(roles.map((role) => [role.id, []]));
  const rolesByAction = new Map(
    actions.map((action) => [action.id, new Set()]),
  );
  const machineStates = {};
  for (const state of states) {
    if (state.terminal && state.transitions.length)
      throw new Error(`终态 ${state.id} 不能包含 transition`);
    if (!state.terminal && !state.transitions.length)
      throw new Error(`非终态 ${state.id} 至少需要一个 transition`);
    machineStates[state.id] = {
      terminal: state.terminal,
      transitions: state.transitions.map((candidate, index) => {
        const id = identifier(
          candidate.id,
          `状态 ${state.id} 的 Transition ${index + 1} ID`,
        );
        if (transitionIds.has(id)) throw new Error(`Transition ID 重复：${id}`);
        transitionIds.add(id);
        const roleId = identifier(candidate.roleId, `Transition ${id} 角色`);
        if (!roleIds.has(roleId))
          throw new Error(`Transition ${id} 引用了未知角色：${roleId}`);
        const actionId = identifier(
          candidate.actionId,
          `Transition ${id} Action`,
        );
        if (!actionIds.has(actionId))
          throw new Error(`Transition ${id} 引用了未知 Action：${actionId}`);
        if (
          !candidate.outcomes ||
          typeof candidate.outcomes !== 'object' ||
          Array.isArray(candidate.outcomes)
        )
          throw new Error(`Transition ${id} 的 outcome 非法`);
        const outcomeKeys = Object.keys(candidate.outcomes);
        const unknownOutcome = outcomeKeys.find(
          (outcome) => !COLLABORATION_OUTCOMES.includes(outcome),
        );
        if (unknownOutcome)
          throw new Error(
            `Transition ${id} 包含非法 outcome：${unknownOutcome}`,
          );
        const outcomes = {};
        for (const outcome of COLLABORATION_OUTCOMES) {
          const destination = identifier(
            candidate.outcomes[outcome],
            `Transition ${id} 的 ${outcome} outcome`,
          );
          if (!stateIds.has(destination))
            throw new Error(
              `Transition ${id} 的 ${outcome} outcome 引用了未知状态：${destination}`,
            );
          outcomes[outcome] = destination;
        }
        transitionsByRole.get(roleId).push(id);
        rolesByAction.get(actionId).add(roleId);
        return {
          id,
          actor_role: roleId,
          action_ref: `actions/${actionId}.yaml`,
          outcomes,
        };
      }),
    };
  }

  const roleDefinitions = {};
  for (const role of roles) {
    const allowedTransitions = transitionsByRole.get(role.id);
    if (!allowedTransitions.length)
      throw new Error(`角色 ${role.id} 至少需要负责一个 transition`);
    roleDefinitions[role.id] = {
      format: 'icarus.agent-group-role/1',
      role: role.id,
      display_name: role.displayName,
      cardinality: { min: role.min, max: role.max },
      allowed_transitions: allowedTransitions,
      executor_requirements: {
        capability: role.capability,
        interaction: role.interaction,
      },
    };
  }

  const actionDefinitions = {};
  const prompts = {};
  for (const action of actions) {
    const roleReferences = [...rolesByAction.get(action.id)];
    if (!roleReferences.length)
      throw new Error(`Action ${action.id} 至少需要被一个 transition 引用`);
    const requirements = roleReferences.map((roleId) =>
      roles.find((role) => role.id === roleId),
    );
    const first = requirements[0];
    if (
      requirements.some(
        (role) =>
          role.capability !== first.capability ||
          role.interaction !== first.interaction,
      )
    )
      throw new Error(`Action ${action.id} 不能跨越需求不同的角色`);
    const kind =
      action.executorMode === 'codex-task' ? 'external' : action.executorMode;
    const promptRef = `prompts/${action.id}.md`;
    actionDefinitions[action.id] = {
      format: 'icarus.agent-group-action/1',
      action_id: action.id,
      kind,
      ...(action.executorMode === 'codex-task'
        ? { adapter: 'codex-task' }
        : {}),
      input: {
        prompt_ref: promptRef,
        ...(kind === 'workflow' ? { workflow_ref: action.workflowRef } : {}),
      },
      requirements: {
        capability: first.capability,
        interaction: first.interaction,
        filesystem_access: action.filesystemAccess,
      },
      result_schema: { ref: 'collaboration-result@1' },
    };
    prompts[promptRef] = action.prompt;
  }

  const creatorRole = roles.find((role) => role.id === initialRole);
  return {
    remoteUrl,
    name,
    signingKeyPath,
    capabilities: [
      ...new Set([creatorRole.capability, creatorRole.interaction]),
    ],
    initialRole,
    machine: {
      format: 'icarus.agent-group-machine/1',
      initial_state: initialState,
      states: machineStates,
    },
    roles: roleDefinitions,
    actions: actionDefinitions,
    prompts,
  };
}
