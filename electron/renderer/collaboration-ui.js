export function collaborationIsObserver(group) {
  return group?.subscriptionMode === 'observer';
}

export function collaborationLocalMembershipStatus(group) {
  if (collaborationIsObserver(group)) return 'observer';
  return (
    group?.projection?.members?.[group.localPrincipalId]?.status || 'unknown'
  );
}

export function collaborationCanMutate(group) {
  return Boolean(
    group?.subscriptionMode === 'member' &&
    group.localPrincipalId &&
    group.localClientId &&
    collaborationLocalMembershipStatus(group) === 'active' &&
    group.lifecycle !== 'archived',
  );
}

export function collaborationCanApproveMembers(group) {
  if (!collaborationCanMutate(group)) return false;
  if (group.localPrincipalId === group.ownerPrincipalId) return true;
  const grants =
    group.projection?.permissionGrants?.[group.localPrincipalId]?.grants || [];
  return grants.includes('member:approve') || grants.includes('group:admin');
}

export function collaborationCanCreateTurn(group, instance, definition) {
  if (
    !instance ||
    instance.lifecycle !== 'running' ||
    instance.active_turn_id
  )
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
            binding.promptHash === turn.prompt_hash,
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
  if (!selected) throw new Error('Assisted Turn requires an Executor');
  return { expectedRevision, executorId: selected };
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
  if (!Array.isArray(artifactIds))
    throw new Error('Artifact staging state is required');
  if (files.length > 20)
    throw new Error('At most 20 Artifacts may be attached');
  if (artifactIds.length > files.length)
    throw new Error('Artifact staging state does not match selected files');
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
      throw new Error('Artifact staging response is invalid');
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
  const execution = ['running', 'waiting_input', 'waiting_approval'].includes(
    turn.state,
  );
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
    ['created_at', 'Created'],
    ['started_at', 'Started'],
    ['completed_at', 'Completed'],
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
