export function collaborationIdentityOwnsRole(group, role) {
  if (!group?.projection || !role) return false;
  return (group.projection.roleClaims?.[role] || []).some(
    (claim) =>
      claim.principal_id === group.localPrincipalId &&
      claim.agent_id === group.localAgentId,
  );
}

export function collaborationTurnAccess(group, turn) {
  const localRole = collaborationIdentityOwnsRole(group, turn?.role);
  const localClaimant = Boolean(
    turn &&
    turn.claimantPrincipalId === group?.localPrincipalId &&
    turn.claimantAgentId === group?.localAgentId,
  );
  return {
    localRole,
    localClaimant,
    canStart:
      localRole && turn?.state === 'PENDING_START' && turn.mode !== 'automatic',
    canComplete:
      localClaimant &&
      (turn?.state === 'IN_PROGRESS' ||
        turn?.state === 'AWAITING_CONFIRMATION'),
  };
}

export function collaborationOutcomeRoutes(definition, turn) {
  if (!turn) return [];
  const routes = definition?.machine?.states?.[turn.stateId]?.transitions;
  if (!Array.isArray(routes)) return [];
  return routes.filter(
    (route) =>
      route &&
      typeof route.outcome === 'string' &&
      typeof route.target_state === 'string',
  );
}

export function collaborationImplementationPrompt(detail, stateId) {
  const prompt = detail?.implementationPrompts?.[stateId];
  return typeof prompt === 'string' ? prompt : '';
}

export function collaborationTurnHistory(projection) {
  const activeTurnId = projection?.activeTurnId;
  return Object.values(projection?.turns || {})
    .filter((turn) => turn?.turnId && turn.turnId !== activeTurnId)
    .sort((left, right) => {
      const revisionDelta =
        Number(right.createdRevision || 0) - Number(left.createdRevision || 0);
      return (
        revisionDelta || String(right.turnId).localeCompare(String(left.turnId))
      );
    });
}

export function collaborationElapsed(createdAt, nowMs = Date.now()) {
  const createdMs = Date.parse(String(createdAt || ''));
  if (!Number.isFinite(createdMs)) return '-';
  const seconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export function collaborationDuration(durationMs) {
  if (durationMs === null || durationMs === undefined || durationMs === '')
    return '-';
  const normalized = Number(durationMs);
  if (!Number.isFinite(normalized)) return '-';
  const seconds = Math.max(0, Math.floor(normalized / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds
      ? `${minutes} 分 ${remainingSeconds} 秒`
      : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes
      ? `${hours} 小时 ${remainingMinutes} 分`
      : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

const ACTIVE_EXECUTION_STATES = new Set([
  'IN_PROGRESS',
  'DISPATCHING',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'AWAITING_CONFIRMATION',
]);

export function collaborationTurnDeadline(turn, nowMs = Date.now()) {
  if (!turn) return null;
  const deadlineKind =
    turn.state === 'PENDING_START'
      ? 'start'
      : ACTIVE_EXECUTION_STATES.has(turn.state)
        ? 'execution'
        : null;
  const deadlineAt =
    deadlineKind === 'start'
      ? turn.startDeadlineAt
      : deadlineKind === 'execution'
        ? turn.executionDeadlineAt
        : null;
  const deadlineMs = Date.parse(String(deadlineAt || ''));
  if (!deadlineKind || !Number.isFinite(deadlineMs)) return null;
  const remainingMs = deadlineMs - nowMs;
  return {
    deadlineKind,
    deadlineAt,
    deadlineMs,
    remainingMs,
    overdue: remainingMs <= 0,
  };
}

const TURN_LIFECYCLE_FIELDS = [
  ['createdAt', 'Turn 创建'],
  ['startedAt', '确认开始 / 自动 claim'],
  ['dispatchAcceptedAt', 'Dispatch accepted'],
  ['providerCompletedAt', 'Provider 完成'],
  ['awaitingConfirmationAt', '等待人工确认'],
  ['completedAt', '确认完成'],
  ['stateAdvancedAt', '状态推进'],
  ['cancelledAt', 'Turn 取消'],
];

export function collaborationTurnLifecycle(turn) {
  if (!turn) return [];
  const rows = [];
  let previousMs = null;
  const lifecycleFields = turn.recoveredAt
    ? [
        TURN_LIFECYCLE_FIELDS[0],
        ['recoveryRequestedAt', '请求恢复'],
        ['recoveredAt', '恢复完成'],
        ...TURN_LIFECYCLE_FIELDS.slice(1),
      ]
    : [
        ...TURN_LIFECYCLE_FIELDS.slice(0, -3),
        ['recoveryRequestedAt', '请求恢复'],
        ...TURN_LIFECYCLE_FIELDS.slice(-3),
      ];
  for (const [field, label] of lifecycleFields) {
    const occurredAt = turn[field];
    const occurredMs = Date.parse(String(occurredAt || ''));
    if (!Number.isFinite(occurredMs)) continue;
    const rawDurationMs = previousMs === null ? null : occurredMs - previousMs;
    rows.push({
      kind: field,
      label,
      occurredAt,
      durationMs: rawDurationMs === null ? null : Math.max(0, rawDurationMs),
      clockSkew: rawDurationMs !== null && rawDurationMs < 0,
    });
    previousMs = occurredMs;
  }
  return rows;
}

export function collaborationPendingNotifications(detail) {
  return Array.isArray(detail?.notifications)
    ? detail.notifications.filter(
        (notification) =>
          notification &&
          typeof notification.notificationId === 'string' &&
          typeof notification.turnId === 'string',
      )
    : [];
}

export function collaborationAuditEventTimeline(events) {
  return Array.isArray(events)
    ? events
        .filter(
          (event) =>
            event && Number.isSafeInteger(event.sequence) && event.sequence > 0,
        )
        .slice()
        .sort(
          (left, right) =>
            left.sequence - right.sequence ||
            String(left.eventId || '').localeCompare(
              String(right.eventId || ''),
            ),
        )
    : [];
}
