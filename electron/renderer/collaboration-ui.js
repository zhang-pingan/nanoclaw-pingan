export function collaborationIsObserver(group) {
  return group?.subscriptionMode === 'observer';
}

export function collaborationLocalMembershipStatus(group) {
  if (collaborationIsObserver(group)) return 'observer';
  return (
    group?.projection?.members?.[group.localPrincipalId]?.status || 'unknown'
  );
}

export function collaborationShortId(value) {
  const text = String(value || '');
  const separator = text.indexOf('_');
  const prefix = separator >= 0 ? text.slice(0, separator) : '';
  const identifier = separator >= 0 ? text.slice(separator + 1) : text;
  return identifier.length > 12
    ? `${prefix ? `${prefix}_` : ''}${identifier.slice(0, 8)}...${identifier.slice(-4)}`
    : text;
}

export function collaborationLocalCredential(group) {
  const credentialId = group?.icarusIdentity?.credentialId;
  const principalId = group?.localPrincipalId;
  return credentialId && principalId
    ? group?.projection?.credentials?.[principalId]?.[credentialId] || null
    : null;
}

export function collaborationCanDecideRecovery(group, request) {
  if (!group || !request || request.status !== 'pending') return false;
  if (
    request.type === 'owner_recovery' &&
    group.localPrincipalId === group.ownerPrincipalId &&
    group.icarusIdentity?.recoveryCredentialAvailable
  )
    return true;
  if (!collaborationCanMutate(group)) return false;
  return request.type === 'identity_recovery'
    ? group.localPrincipalId === request.target_principal_id
    : group.localPrincipalId === group.ownerPrincipalId;
}

export function collaborationCanMutate(group) {
  const localCredential = collaborationLocalCredential(group);
  return Boolean(
    group?.subscriptionMode === 'member' &&
    group.localPrincipalId &&
    group.localClientId &&
    collaborationLocalMembershipStatus(group) === 'active' &&
    (!group?.icarusIdentity?.credentialId ||
      localCredential?.status === 'active') &&
    group.lifecycle === 'active',
  );
}

export function collaborationCanInitializeGroup(group) {
  return Boolean(
    collaborationHasActiveLocalIdentity(group) &&
    group.localPrincipalId &&
    group.localPrincipalId === group.ownerPrincipalId &&
    ['active', 'archived'].includes(group.lifecycle),
  );
}

function collaborationHasActiveLocalIdentity(group) {
  const localCredential = collaborationLocalCredential(group);
  return Boolean(
    group?.subscriptionMode === 'member' &&
    group.localPrincipalId &&
    group.localClientId &&
    collaborationLocalMembershipStatus(group) === 'active' &&
    (!group?.icarusIdentity?.credentialId ||
      localCredential?.status === 'active'),
  );
}

export function collaborationCanDissolve(group) {
  return Boolean(
    collaborationHasActiveLocalIdentity(group) &&
    group.localPrincipalId === group.ownerPrincipalId &&
    ['active', 'archived'].includes(group.lifecycle),
  );
}

export function collaborationCanLeave(group) {
  return Boolean(
    collaborationHasActiveLocalIdentity(group) &&
    group.localPrincipalId !== group.ownerPrincipalId &&
    ['active', 'archived'].includes(group.lifecycle),
  );
}

export function collaborationCanRemoveLocal(group) {
  return Boolean(group?.groupId);
}

export function buildCollaborationLifecycleRequest(input) {
  const operation = String(input?.operation || '');
  const groupId = String(input?.group?.groupId || '');
  const confirmation = String(input?.confirmation || '').trim();
  if (!groupId) throw new Error('群组 ID 缺失');
  if (confirmation !== groupId) throw new Error('输入的群组 ID 不匹配');
  if (operation === 'remove-local')
    return {
      endpoint: `/subscriptions/${encodeURIComponent(groupId)}`,
      method: 'DELETE',
      body: { confirmation },
    };
  if (!['dissolve', 'leave'].includes(operation))
    throw new Error('不支持的群组生命周期操作');
  const aggregateType = operation === 'leave' ? 'membership' : 'group';
  const aggregateId =
    operation === 'leave' ? input.group.localPrincipalId : groupId;
  const expectedRevision =
    input.group.projection?.aggregateHeads?.[`${aggregateType}:${aggregateId}`]
      ?.revision ?? 0;
  return {
    endpoint: `/groups/${encodeURIComponent(groupId)}/${
      operation === 'dissolve' ? 'dissolve' : 'leave'
    }`,
    method: 'POST',
    body: {
      confirmation,
      expectedRevision,
      reason:
        operation === 'dissolve' ? '群主确认解散群组' : '成员确认退出群组',
    },
  };
}

export function collaborationCanApproveMembers(group) {
  if (!collaborationCanMutate(group)) return false;
  if (group.localPrincipalId === group.ownerPrincipalId) return true;
  const grants =
    group.projection?.permissionGrants?.[group.localPrincipalId]?.grants || [];
  return grants.includes('member:approve') || grants.includes('group:admin');
}

export function collaborationCanAnswerWorkItemAssignment(group, item) {
  return Boolean(
    collaborationCanMutate(group) &&
    item?.assignment_status === 'pending' &&
    item.owner_principal_id === group.localPrincipalId,
  );
}

function collaborationExpectedRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0)
    throw new Error('expectedRevision 必须是非负整数');
  return revision;
}

function collaborationUniqueIdentifiers(values, maximum, label) {
  if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
  const identifiers = [
    ...new Set(
      values.map((value) => String(value || '').trim()).filter(Boolean),
    ),
  ];
  if (identifiers.length > maximum)
    throw new Error(`${label} 最多包含 ${maximum} 项`);
  if (identifiers.some((value) => value.length > 240))
    throw new Error(`${label} 包含过长标识符`);
  return identifiers;
}

export function buildCollaborationAssignmentDecisionRequest(input) {
  const accepted = Boolean(input.accepted);
  const reason = String(input.reason || '').trim();
  return {
    expectedRevision: collaborationExpectedRevision(input.expectedRevision),
    ...(!accepted && reason ? { reason } : {}),
  };
}

export function buildCollaborationDiscussionMessageRequest(input) {
  const body = String(input.body || '').trim();
  if (!body) throw new Error('消息内容不能为空');
  return {
    expectedRevision: collaborationExpectedRevision(input.expectedRevision),
    body,
    mentions: collaborationUniqueIdentifiers(
      input.mentions || [],
      100,
      '提及成员',
    ),
    ...(input.refs
      ? {
          refs: collaborationUniqueIdentifiers(input.refs, 100, '引用资源'),
        }
      : {}),
  };
}

export function buildCollaborationAnalysisRunRequest(input) {
  const scopeType = String(input.scopeType || input.scope?.type || '').trim();
  const resourceId = String(input.resourceId || '').trim();
  let scope;
  if (scopeType === 'project' || scopeType === 'mine')
    scope = { type: scopeType };
  else if (scopeType === 'work_item') {
    if (!resourceId) throw new Error('Work Item 分析必须选择工作项');
    scope = { type: scopeType, work_item_id: resourceId };
  } else if (scopeType === 'workflow_instance') {
    if (!resourceId) throw new Error('Workflow 分析必须选择工作流实例');
    scope = { type: scopeType, workflow_instance_id: resourceId };
  } else if (scopeType === 'delta') {
    const sinceSnapshotHead = String(
      input.sinceSnapshotHead || input.scope?.since_snapshot_head || '',
    ).trim();
    if (!sinceSnapshotHead)
      throw new Error('增量分析必须填写基准 verified head');
    if (!/^[a-f0-9]{40,64}$/u.test(sinceSnapshotHead))
      throw new Error('基准 verified head 必须是 40 至 64 位小写 Git hash');
    scope = { type: scopeType, since_snapshot_head: sinceSnapshotHead };
  } else throw new Error('不支持的分析范围');

  const executionChannel = String(input.executionChannel || '').trim();
  if (!['managed_executor', 'external_agent'].includes(executionChannel))
    throw new Error('不支持的分析执行渠道');
  const executorId = String(input.executorId || '').trim();
  if (executionChannel === 'managed_executor' && !executorId)
    throw new Error('托管分析必须选择本地 Executor');
  if (executionChannel === 'external_agent' && executorId)
    throw new Error('外部分析不能绑定本地 Executor');

  return {
    scope,
    executionChannel,
    executorId: executionChannel === 'managed_executor' ? executorId : null,
    selectedFileIds: collaborationUniqueIdentifiers(
      input.selectedFileIds || [],
      1000,
      '导出文件',
    ),
    includeSelectedFileContents: Boolean(input.includeSelectedFileContents),
  };
}

export function parseCollaborationExternalResult(value) {
  const raw = String(value || '');
  if (!raw.trim()) throw new Error('外部分析结果不能为空');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('外部分析结果必须是一个完整 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('外部分析结果必须是一个 JSON 对象');
  return parsed;
}

export function buildCollaborationExternalResultRequest(value) {
  parseCollaborationExternalResult(value);
  return String(value).trim();
}

export function buildCollaborationFindingDecisionRequest(input) {
  const decision = String(input.decision || '').trim();
  if (!['accepted', 'deferred', 'ignored', 'false_positive'].includes(decision))
    throw new Error('不支持的 Finding 决定');
  const reason = String(input.reason || '').trim();
  if (reason.length > 4000) throw new Error('决定原因最多 4000 个字符');
  return { decision, ...(reason ? { reason } : {}) };
}

export const collaborationFindingActionTypes = Object.freeze([
  'create_work_item',
  'open_discussion',
  'post_progress',
  'watch_work_item',
  'request_information',
  'publish_analysis_report',
]);

function collaborationFindingRefs(finding, type) {
  return [...(finding?.affected_refs || []), ...(finding?.evidence_refs || [])]
    .filter((ref) => String(ref).startsWith(`${type}:`))
    .map((ref) => String(ref).slice(type.length + 1));
}

export function collaborationFindingActionDraft(entry, actionType) {
  if (!collaborationFindingActionTypes.includes(actionType))
    throw new Error('不支持的 Finding 转化动作');
  const finding = entry?.finding || entry || {};
  const findingId = String(entry?.findingId || finding.finding_id || '').trim();
  const title = String(finding.title || 'Analysis Finding').slice(0, 240);
  const summary = String(finding.summary || title);
  const workItemIds = collaborationFindingRefs(finding, 'work_item');
  const workflowInstanceIds = collaborationFindingRefs(
    finding,
    'workflow_instance',
  );
  const firstScopedRef = [
    ['work_item', workItemIds[0]],
    ['workflow_instance', workflowInstanceIds[0]],
    ['turn', collaborationFindingRefs(finding, 'turn')[0]],
  ].find(([, ref]) => ref);

  if (actionType === 'create_work_item')
    return {
      action: actionType,
      parameters: {
        type: 'issue',
        title,
        description: summary,
        priority: ['critical', 'high'].includes(finding.severity)
          ? 'high'
          : 'normal',
        due_at: null,
        labels: finding.category ? [String(finding.category)] : [],
        related_work_item_ids: workItemIds,
      },
    };
  if (actionType === 'open_discussion')
    return {
      action: actionType,
      parameters: {
        title,
        body: summary,
        scope: firstScopedRef
          ? { type: firstScopedRef[0], ref: firstScopedRef[1] }
          : { type: 'group' },
        mentions: [],
      },
    };
  if (actionType === 'post_progress')
    return {
      action: actionType,
      parameters: {
        summary,
        completed: [],
        next_steps: [],
        blockers: [],
        work_item_refs: workItemIds,
        workflow_instance_refs: workflowInstanceIds,
      },
    };
  if (actionType === 'watch_work_item')
    return {
      action: actionType,
      parameters: { work_item_id: workItemIds[0] || '' },
    };
  if (actionType === 'request_information')
    return {
      action: actionType,
      parameters: {
        title,
        question: summary,
        affected_refs: [
          ...new Set([
            ...(finding.affected_refs || []),
            ...(finding.evidence_refs || []),
          ]),
        ],
        mentions: [],
      },
    };
  return {
    action: actionType,
    parameters: {
      title,
      include_finding_ids: findingId ? [findingId] : [],
      destination: 'principal_workspace',
    },
  };
}

export function buildCollaborationActionPreviewRequest(input) {
  const actions = (input.actions || []).map((entry) => {
    const requestId = String(entry.requestId || '').trim();
    const findingId = String(entry.findingId || '').trim();
    const hasActionOrdinal =
      entry.actionOrdinal !== undefined && entry.actionOrdinal !== null;
    const actionOrdinal = hasActionOrdinal
      ? Number(entry.actionOrdinal)
      : undefined;
    if (!requestId || !findingId)
      throw new Error('转化动作缺少 request ID 或 Finding');
    if (
      hasActionOrdinal &&
      (!Number.isInteger(actionOrdinal) || actionOrdinal < 0)
    )
      throw new Error('Agent 建议动作序号无效');
    if (
      !entry.action ||
      typeof entry.action !== 'object' ||
      Array.isArray(entry.action)
    )
      throw new Error('转化动作必须是对象');
    if (!collaborationFindingActionTypes.includes(entry.action.action))
      throw new Error('不支持的 Finding 转化动作');
    return {
      requestId,
      findingId,
      ...(hasActionOrdinal ? { actionOrdinal } : {}),
      action: entry.action,
    };
  });
  if (!actions.length) throw new Error('请明确选择至少一个转化动作');
  if (actions.length > 100) throw new Error('一次最多预览 100 个转化动作');
  return { actions };
}

export function buildCollaborationActionApplyRequest(input) {
  const actions = (input.actions || []).map((entry) => {
    const applicationId = String(entry.applicationId || '').trim();
    const confirmationToken = String(entry.confirmationToken || '').trim();
    if (!applicationId || confirmationToken.length < 32)
      throw new Error('动作确认信息无效，请重新预览');
    return {
      applicationId,
      confirmationToken,
      ...(entry.action ? { action: entry.action } : {}),
    };
  });
  if (!actions.length) throw new Error('请逐项确认至少一个预览动作');
  if (actions.length > 100) throw new Error('一次最多应用 100 个建议动作');
  return { actions };
}

export function collaborationAnalysisRunAccess(group, detail) {
  const status = detail?.run?.status;
  const stale = detail?.stale === true || status === 'stale';
  const external = detail?.run?.executionChannel === 'external_agent';
  const mutable = collaborationCanMutate(group);
  return {
    canStart: status === 'prepared',
    canRetry: ['invalid', 'failed'].includes(status),
    canCancel:
      status === 'prepared' ||
      (external && status === 'awaiting_external_result'),
    canCompleteReview: ['ready_for_review', 'partially_applied'].includes(
      status,
    ),
    canSubmitExternal:
      external && ['awaiting_external_result', 'invalid'].includes(status),
    canExportExternal: external && status === 'awaiting_external_result',
    canDecideFinding:
      !stale && ['ready_for_review', 'partially_applied'].includes(status),
    canPreviewActions:
      mutable &&
      !stale &&
      ['ready_for_review', 'partially_applied'].includes(status),
    canApplyActions:
      mutable &&
      !stale &&
      ['ready_for_review', 'partially_applied'].includes(status),
  };
}

export function collaborationCanCreateTurn(group, instance, definition) {
  if (!instance || instance.lifecycle !== 'running' || instance.active_turn_id)
    return false;
  const state = definition?.machine?.states?.[instance.business_state];
  if (!state || state.terminal) return false;
  const principalId = group?.localPrincipalId;
  const grants =
    group?.projection?.permissionGrants?.[principalId]?.grants || [];
  return Boolean(
    principalId &&
    (instance.created_by_principal_id === principalId ||
      instance.resolved_assignments?.[instance.business_state] ===
        principalId ||
      grants.includes('workflow_instance:manage_all') ||
      grants.includes('group:admin')),
  );
}

export function collaborationEligibleTurnExecutors(group, turn, bindings) {
  if (!group || !turn || turn.execution_mode === 'manual') return [];
  const principalExecutors =
    group.projection?.executors?.[group.localPrincipalId] || {};
  return [
    ...new Set(
      (bindings || [])
        .filter(
          (binding) =>
            binding.enabled &&
            binding.groupId === group.groupId &&
            binding.instanceId === turn.workflow_instance_id &&
            binding.stateId === turn.state_id &&
            binding.principalId === group.localPrincipalId &&
            binding.clientId === group.localClientId &&
            binding.actionHash === turn.action_hash &&
            binding.promptHash === turn.prompt_hash &&
            principalExecutors[binding.executorId]?.status === 'active',
        )
        .map((binding) => binding.executorId),
    ),
  ];
}

export function buildCollaborationStartTurnRequest(
  expectedRevision,
  turn,
  executorId = null,
) {
  if (turn?.execution_mode === 'manual')
    return { expectedRevision, executorId: null };
  const selected = String(executorId || '').trim();
  if (!selected) throw new Error('辅助执行轮次必须选择执行器');
  return { expectedRevision, executorId: selected };
}

export function buildCollaborationRecoverTurnRequest(input) {
  const previousAttempt = Number(input.previousAttempt);
  if (!Number.isInteger(previousAttempt) || previousAttempt < 1)
    throw new Error('恢复的 Turn attempt 必须是正整数');
  const reason = String(input.reason || '').trim();
  if (!reason) throw new Error('恢复原因不能为空');
  if (reason.length > 4000) throw new Error('恢复原因最多 4000 个字符');
  const assigneePrincipalId = String(input.assigneePrincipalId || '').trim();
  if (!assigneePrincipalId) throw new Error('必须选择新的负责人');
  return {
    expectedRevision: collaborationExpectedRevision(input.expectedRevision),
    previousAttempt,
    assigneePrincipalId,
    reason,
  };
}

export function collaborationActiveMemberOptions(group) {
  return Object.values(group?.projection?.members || {})
    .filter((member) => member?.status === 'active' && member.principal_id)
    .sort((left, right) =>
      String(left.display_name || left.principal_id).localeCompare(
        String(right.display_name || right.principal_id),
      ),
    )
    .map((member) => [
      member.principal_id,
      `${member.display_name || member.principal_id} · ${collaborationShortId(member.principal_id)}`,
    ]);
}

export function collaborationWorkflowInstanceCommand(instance) {
  if (['draft', 'ready'].includes(instance?.lifecycle))
    return { command: 'start', label: '启动' };
  if (instance?.lifecycle === 'running')
    return { command: 'pause', label: '暂停' };
  if (instance?.lifecycle === 'paused')
    return { command: 'resume', label: '恢复' };
  return null;
}

export function collaborationCanRecoverTurn(group, instance, turn) {
  if (
    !collaborationCanMutate(group) ||
    !instance ||
    !turn ||
    turn.state !== 'recovery_required' ||
    instance.active_turn_id !== turn.turn_id
  )
    return false;
  const principalId = group.localPrincipalId;
  const grants =
    group.projection?.permissionGrants?.[principalId]?.grants || [];
  return Boolean(
    instance.created_by_principal_id === principalId ||
    instance.resolved_assignments?.[instance.business_state] === principalId ||
    grants.includes('workflow_instance:manage_all') ||
    grants.includes('group:admin'),
  );
}

const collaborationMarkerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;

export function parseCollaborationMarkers(value) {
  const markers = [
    ...new Set(
      String(value || '')
        .split(/[,\r\n]+/u)
        .map((marker) => marker.trim())
        .filter(Boolean),
    ),
  ];
  if (markers.length > 100) throw new Error('最多可添加 100 个标记');
  for (const marker of markers) {
    if (marker.length > 160 || !collaborationMarkerPattern.test(marker))
      throw new Error(`标记必须是合法标识符：${marker}`);
  }
  return markers;
}

export function collaborationTurnCompletionDraft(turn, routes = []) {
  const suggestion = turn?.executor_result || null;
  return {
    outcome: suggestion?.outcome || routes[0]?.outcome || '',
    summary: suggestion?.summary || '',
    instruction: suggestion?.instruction || '',
    markers: (suggestion?.markers || []).join(', '),
    data: JSON.stringify(suggestion?.data || {}, null, 2),
  };
}

export function buildCollaborationCompleteTurnRequest(input) {
  return {
    expectedRevision: input.expectedRevision,
    attempt: input.turn.attempt,
    fencingToken: input.turn.fencing_token,
    outcome: String(input.outcome || ''),
    summary: String(input.summary || ''),
    instruction: String(input.instruction || ''),
    markers: parseCollaborationMarkers(input.markers),
    data: input.data,
    artifactIds: [...input.artifactIds],
  };
}

export function collaborationPrincipalName(projection, principalId) {
  return projection?.members?.[principalId]?.display_name || principalId || '-';
}

export function collaborationArtifactName(projection, ref) {
  const value = String(ref || '');
  const segments = value.split('/').filter(Boolean);
  const pathArtifactId = segments.length > 1 ? segments.at(-2) : value;
  const artifact =
    projection?.artifacts?.[value] || projection?.artifacts?.[pathArtifactId];
  return artifact?.original_filename || pathArtifactId || value;
}

export async function stageCollaborationArtifactFiles(input) {
  const files = [...(input.files || [])];
  const artifactIds = input.artifactIds;
  if (!Array.isArray(artifactIds)) throw new Error('缺少产出物暂存状态');
  if (files.length > 20) throw new Error('最多可添加 20 个产出物');
  if (artifactIds.length > files.length)
    throw new Error('产出物暂存状态与所选文件不匹配');
  for (let index = artifactIds.length; index < files.length; index += 1) {
    const file = files[index];
    const metadata = input.metadata(file);
    const upload = new FormData();
    upload.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    );
    upload.append('file', file, file.name);
    const staged = await input.request(input.endpoint, {
      method: 'POST',
      body: upload,
    });
    const artifactId = staged?.metadata?.artifact_id;
    if (!artifactId || typeof artifactId !== 'string')
      throw new Error('产出物暂存响应无效');
    artifactIds.push(artifactId);
  }
  return artifactIds;
}

export function collaborationTurnAccess(group, turn) {
  const localPrincipal = Boolean(
    collaborationCanMutate(group) &&
    group?.localPrincipalId &&
    turn?.assignee_principal_id === group.localPrincipalId,
  );
  const localClient = Boolean(
    localPrincipal &&
    turn?.claimant_client_id &&
    turn.claimant_client_id === group.localClientId,
  );
  return {
    localPrincipal,
    localClient,
    canStart:
      localPrincipal &&
      turn?.state === 'pending' &&
      turn.execution_mode !== 'automatic',
    canComplete:
      localClient &&
      (turn?.execution_mode === 'manual'
        ? ['running', 'waiting_input', 'waiting_approval'].includes(turn?.state)
        : turn?.execution_mode === 'assisted' &&
          turn?.state === 'awaiting_confirmation'),
  };
}

export function collaborationOutcomeRoutes(definition, turn) {
  if (!turn) return [];
  return (definition?.machine?.states?.[turn.state_id]?.transitions || []).map(
    (transition) => ({
      outcome: transition.outcome,
      label: transition.label || transition.outcome,
      target_state: transition.target_state,
    }),
  );
}

export function collaborationTurnHistory(projection, instanceId) {
  return Object.values(projection?.turns || {})
    .filter((turn) => !instanceId || turn.workflow_instance_id === instanceId)
    .sort((left, right) =>
      String(right.created_at || '').localeCompare(
        String(left.created_at || ''),
      ),
    );
}

export function collaborationCurrentTurn(projection, instanceId) {
  const instance = projection?.workflowInstances?.[instanceId];
  return instance?.active_turn_id
    ? projection.turns?.[instance.active_turn_id] || null
    : null;
}

export function collaborationTurnDeadline(turn, nowMs = Date.now()) {
  if (
    !turn ||
    ['completed', 'cancelled', 'recovery_required'].includes(turn.state)
  )
    return null;
  const execution = [
    'running',
    'waiting_input',
    'waiting_approval',
    'awaiting_confirmation',
  ].includes(turn.state);
  const deadlineAt = execution
    ? turn.execution_deadline_at
    : turn.start_deadline_at;
  if (!deadlineAt) return null;
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  const remainingMs = deadlineMs - nowMs;
  return {
    deadlineKind: execution ? 'execution' : 'start',
    deadlineAt,
    remainingMs,
    overdue: remainingMs <= 0,
  };
}

export function collaborationDuration(valueMs) {
  if (valueMs === null || valueMs === undefined || !Number.isFinite(valueMs))
    return '-';
  const absolute = Math.max(0, Number(valueMs));
  if (absolute < 1_000) return `${Math.round(absolute)} ms`;
  if (absolute < 60_000) return `${Math.round(absolute / 1_000)} 秒`;
  if (absolute < 3_600_000) return `${Math.round(absolute / 60_000)} 分钟`;
  if (absolute < 86_400_000) return `${Math.round(absolute / 3_600_000)} 小时`;
  return `${Math.round(absolute / 86_400_000)} 天`;
}

export function collaborationElapsed(value, nowMs = Date.now()) {
  const start = Date.parse(String(value || ''));
  return Number.isFinite(start)
    ? collaborationDuration(Math.max(0, nowMs - start))
    : '-';
}

export function collaborationTurnLifecycle(turn) {
  const entries = [
    ['created_at', '已创建'],
    ['started_at', '已开始'],
    ['completed_at', '已完成'],
  ];
  const rows = [];
  let previous = null;
  for (const [kind, label] of entries) {
    const value = turn?.[kind];
    if (!value) continue;
    const at = Date.parse(value);
    const clockSkew = previous !== null && at < previous;
    rows.push({
      kind,
      label,
      occurredAt: value,
      durationMs:
        previous === null || !Number.isFinite(at)
          ? null
          : Math.max(0, at - previous),
      clockSkew,
    });
    if (Number.isFinite(at)) previous = Math.max(previous ?? at, at);
  }
  return rows;
}

export function collaborationPendingNotifications(detail) {
  if (!Array.isArray(detail?.notifications)) return [];
  return detail.notifications.filter(
    (notification) =>
      notification &&
      notification.notificationId &&
      notification.resourceType &&
      notification.resourceId,
  );
}

export function collaborationResourceTarget(
  resourceType,
  resourceId,
  projection = null,
) {
  const type = String(resourceType || '').trim();
  const id = String(resourceId || '').trim();
  if (!type || !id)
    return { tab: 'overview', resourceType: type, resourceId: id };
  if (type === 'work_item')
    return {
      tab: 'work-items',
      resourceType: type,
      resourceId: id,
      selectedWorkItemId: id,
    };
  if (type === 'discussion')
    return {
      tab: 'discussions',
      resourceType: type,
      resourceId: id,
      selectedDiscussionId: id,
    };
  if (type === 'workflow_instance')
    return {
      tab: 'workflows',
      resourceType: type,
      resourceId: id,
      selectedInstanceId: id,
    };
  if (type === 'turn') {
    const turn = projection?.turns?.[id];
    return {
      tab: 'workflows',
      resourceType: type,
      resourceId: id,
      selectedInstanceId: turn?.workflow_instance_id || '',
    };
  }
  if (type === 'analysis_run')
    return {
      tab: 'analysis',
      resourceType: type,
      resourceId: id,
      selectedAnalysisId: id,
    };
  if (type === 'file')
    return { tab: 'files', resourceType: type, resourceId: id };
  if (type === 'event')
    return { tab: 'audit', resourceType: type, resourceId: id };
  if (type === 'message') {
    const thread = Object.values(projection?.discussions || {}).find((entry) =>
      Object.hasOwn(entry?.messages || {}, id),
    );
    return {
      tab: 'discussions',
      resourceType: type,
      resourceId: id,
      selectedDiscussionId: thread?.discussion?.thread_id || '',
    };
  }
  if (type === 'workflow_definition')
    return { tab: 'workflows', resourceType: type, resourceId: id };
  if (
    [
      'recovery',
      'recovery_request',
      'membership',
      'credential',
      'client',
    ].includes(type)
  )
    return { tab: 'members', resourceType: type, resourceId: id };
  if (type === 'principal')
    return { tab: 'members', resourceType: type, resourceId: id };
  if (['protocol', 'integrity', 'sync', 'group'].includes(type))
    return { tab: 'diagnostics', resourceType: type, resourceId: id };
  return { tab: 'overview', resourceType: type, resourceId: id };
}

export function collaborationNotificationTarget(
  notification,
  projection = null,
) {
  return collaborationResourceTarget(
    notification?.resourceType,
    notification?.resourceId,
    projection,
  );
}

export function collaborationAuditEventTimeline(events) {
  return [...(events || [])].sort(
    (left, right) =>
      Number(left.commit_order ?? left.commitOrder ?? 0) -
      Number(right.commit_order ?? right.commitOrder ?? 0),
  );
}

export function collaborationVerifiedFileTree(files) {
  const root = { name: '', path: '', directories: {}, files: [] };
  for (const file of files || []) {
    const segments = String(file.virtualPath || file.virtual_path || '')
      .split('/')
      .filter(Boolean);
    if (!segments.length) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      node.directories[segment] ||= {
        name: segment,
        path: node.path ? `${node.path}/${segment}` : segment,
        directories: {},
        files: [],
      };
      node = node.directories[segment];
    }
    node.files.push({ ...file, name: segments.at(-1) });
  }
  return root;
}

export function collaborationWorkItemColumns(items) {
  const columns = Object.fromEntries(
    ['proposed', 'open', 'in_progress', 'blocked', 'done', 'cancelled'].map(
      (status) => [status, []],
    ),
  );
  for (const item of items || []) (columns[item.status] ||= []).push(item);
  for (const values of Object.values(columns))
    values.sort((left, right) =>
      String(left.due_at || '9999').localeCompare(
        String(right.due_at || '9999'),
      ),
    );
  return columns;
}

export function collaborationResourceNavigation(resourceType, resourceId) {
  return collaborationResourceTarget(resourceType, resourceId);
}
