import crypto from 'node:crypto';

import type { CollaborationProjectSpaceGroupRecord } from './project-space-store.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';
import type { CollaborationTurnV3, WorkItem } from './protocol/v3-schema.js';

export type ProjectSignalCategory =
  | 'delivery_risk'
  | 'schedule_risk'
  | 'dependency_risk'
  | 'workflow_stall'
  | 'assignment_gap'
  | 'quality_gap'
  | 'missing_evidence'
  | 'capacity_risk'
  | 'identity_risk'
  | 'protocol_risk'
  | 'collaboration_gap';

export type ProjectSignalSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info';

export interface ProjectInsightSignal {
  readonly signal_id: string;
  readonly rule_id: string;
  readonly category: ProjectSignalCategory;
  readonly severity: ProjectSignalSeverity;
  readonly title: string;
  readonly summary: string;
  readonly affected_refs: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly observed_at: string;
}

export type MyItemGroup =
  | 'needs_action'
  | 'at_risk'
  | 'waiting_on_others'
  | 'watching'
  | 'recently_resolved';

export interface CollaborationMyItem {
  readonly item_id: string;
  readonly group: MyItemGroup;
  readonly priority_rank: number;
  readonly resource_type:
    | 'work_item'
    | 'workflow_instance'
    | 'turn'
    | 'discussion'
    | 'recovery'
    | 'membership'
    | 'credential'
    | 'protocol';
  readonly resource_id: string;
  readonly title: string;
  readonly reason: string;
  readonly severity: ProjectSignalSeverity;
  readonly due_at: string | null;
  readonly navigation: {
    readonly tab: string;
    readonly resource_id: string;
  };
}

export interface CollaborationProjectInsight {
  readonly format: 'icarus.collaboration-project-insight/1';
  readonly group_id: string;
  readonly snapshot_head: string;
  readonly generated_at: string;
  readonly health: 'healthy' | 'needs_attention' | 'at_risk' | 'critical';
  readonly counts: {
    readonly active_members: number;
    readonly open_work_items: number;
    readonly overdue_work_items: number;
    readonly blocked_work_items: number;
    readonly pending_assignments: number;
    readonly workflow_running: number;
    readonly workflow_paused: number;
    readonly workflow_waiting: number;
    readonly workflow_timed_out: number;
    readonly unresolved_discussions: number;
  };
  readonly sync: {
    readonly verified_head: string;
    readonly last_verified_sync_at: string | null;
    readonly protocol_status: string;
    readonly integrity_status: string;
    readonly healthy: boolean;
    readonly error: string | null;
  };
  readonly signals: readonly ProjectInsightSignal[];
  readonly recent_activity: CollaborationProjectionV3['activity'];
  readonly activity_delta: CollaborationProjectionV3['activity'];
}

const terminalWorkItemStatuses = new Set(['done', 'cancelled']);
const terminalTurnStates = new Set([
  'completed',
  'cancelled',
  'recovery_required',
]);
const severityRank: Readonly<Record<ProjectSignalSeverity, number>> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
const priorityRank = { low: 1, normal: 2, high: 3, urgent: 4 } as const;

function signalId(ruleId: string, refs: readonly string[]): string {
  return `signal_${crypto
    .createHash('sha256')
    .update(`${ruleId}\0${[...refs].sort().join('\0')}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function signal(input: Omit<ProjectInsightSignal, 'signal_id'>) {
  return {
    ...input,
    signal_id: signalId(input.rule_id, input.affected_refs),
  } satisfies ProjectInsightSignal;
}

function isActive(item: WorkItem): boolean {
  return !item.archived && !terminalWorkItemStatuses.has(item.status);
}

function activeBlockers(
  projection: CollaborationProjectionV3,
  item: WorkItem,
): WorkItem[] {
  return item.blocked_by
    .map((id) => projection.workItems[id])
    .filter((candidate): candidate is WorkItem => Boolean(candidate))
    .filter(isActive);
}

function turnDeadline(turn: CollaborationTurnV3): number | null {
  if (terminalTurnStates.has(turn.state)) return null;
  const timestamp = [
    'running',
    'waiting_input',
    'waiting_approval',
    'awaiting_confirmation',
  ].includes(turn.state)
    ? turn.execution_deadline_at
    : turn.start_deadline_at;
  const value = Date.parse(timestamp ?? '');
  return Number.isFinite(value) ? value : null;
}

function dependencyCycles(
  projection: CollaborationProjectionV3,
): readonly string[][] {
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  const visit = (id: string): void => {
    if (state.get(id) === 'visited') return;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const normalized = cycle.slice(0, -1).sort().join(':');
      cycles.set(normalized, cycle);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of projection.workItems[id]?.blocked_by ?? [])
      if (projection.workItems[dependency]) visit(dependency);
    stack.pop();
    state.set(id, 'visited');
  };
  for (const id of Object.keys(projection.workItems).sort()) visit(id);
  return [...cycles.values()];
}

export function buildProjectSignals(input: {
  readonly projection: CollaborationProjectionV3;
  readonly nowMs: number;
}): ProjectInsightSignal[] {
  const { projection, nowMs } = input;
  const observedAt = new Date(nowMs).toISOString();
  const signals: ProjectInsightSignal[] = [];
  const items = Object.values(projection.workItems);
  for (const item of items) {
    const itemRef = `work_item:${item.work_item_id}`;
    if (isActive(item) && item.due_at && Date.parse(item.due_at) <= nowMs)
      signals.push(
        signal({
          rule_id: 'work_item_overdue',
          category: 'schedule_risk',
          severity: item.priority === 'urgent' ? 'critical' : 'high',
          title: `Work Item overdue: ${item.title}`,
          summary: `The due date ${item.due_at} has passed while the item remains ${item.status}.`,
          affected_refs: [itemRef],
          evidence_refs: [itemRef],
          observed_at: observedAt,
        }),
      );
    const blockers = activeBlockers(projection, item);
    if (isActive(item) && blockers.length)
      signals.push(
        signal({
          rule_id: 'work_item_blocked',
          category: 'dependency_risk',
          severity: ['high', 'urgent'].includes(item.priority)
            ? 'high'
            : 'medium',
          title: `Work Item blocked: ${item.title}`,
          summary: `The item is blocked by ${blockers.length} unfinished Work Item(s).`,
          affected_refs: [itemRef],
          evidence_refs: [
            itemRef,
            ...blockers.map((blocker) => `work_item:${blocker.work_item_id}`),
          ],
          observed_at: observedAt,
        }),
      );
    if (isActive(item) && item.assignment_status === 'pending')
      signals.push(
        signal({
          rule_id: 'assignment_pending',
          category: 'assignment_gap',
          severity: item.priority === 'urgent' ? 'high' : 'medium',
          title: `Assignment awaiting confirmation: ${item.title}`,
          summary: `The assigned owner ${item.owner_principal_id} has not accepted the Work Item.`,
          affected_refs: [itemRef, `principal:${item.owner_principal_id}`],
          evidence_refs: [itemRef],
          observed_at: observedAt,
        }),
      );
    if (
      isActive(item) &&
      projection.members[item.owner_principal_id]?.status !== 'active'
    )
      signals.push(
        signal({
          rule_id: 'owner_unavailable',
          category: 'assignment_gap',
          severity: 'high',
          title: `Owner unavailable: ${item.title}`,
          summary: 'The current Work Item owner is not an active Group member.',
          affected_refs: [itemRef, `principal:${item.owner_principal_id}`],
          evidence_refs: [itemRef, `principal:${item.owner_principal_id}`],
          observed_at: observedAt,
        }),
      );
    if (item.status === 'done') {
      const updates = projection.workItemUpdates[item.work_item_id] ?? [];
      const hasArtifact = updates.some(
        (update) => update.artifact_refs.length > 0,
      );
      if (item.acceptance_criteria.length > 0 && !hasArtifact)
        signals.push(
          signal({
            rule_id: 'completed_without_evidence',
            category: 'missing_evidence',
            severity: 'medium',
            title: `Completed item lacks evidence: ${item.title}`,
            summary:
              'The item has acceptance criteria but no progress update references an artifact.',
            affected_refs: [itemRef],
            evidence_refs: [itemRef],
            observed_at: observedAt,
          }),
        );
    }
    for (const blockerId of item.blocked_by) {
      const blocker = projection.workItems[blockerId];
      if (!blocker || blocker.status !== 'done') continue;
      signals.push(
        signal({
          rule_id: 'completed_blocker_retained',
          category: 'dependency_risk',
          severity: 'low',
          title: `Completed blocker is still linked: ${item.title}`,
          summary: `${blocker.title} is complete but remains in blocked_by.`,
          affected_refs: [itemRef],
          evidence_refs: [itemRef, `work_item:${blockerId}`],
          observed_at: observedAt,
        }),
      );
    }
  }

  for (const cycle of dependencyCycles(projection))
    signals.push(
      signal({
        rule_id: 'dependency_cycle',
        category: 'dependency_risk',
        severity: 'critical',
        title: 'Circular Work Item dependency',
        summary: `Dependency cycle: ${cycle.join(' -> ')}`,
        affected_refs: cycle.slice(0, -1).map((id) => `work_item:${id}`),
        evidence_refs: cycle.slice(0, -1).map((id) => `work_item:${id}`),
        observed_at: observedAt,
      }),
    );

  const byOwner = new Map<string, WorkItem[]>();
  for (const item of items) {
    if (!isActive(item) || !item.due_at || priorityRank[item.priority] < 3)
      continue;
    const values = byOwner.get(item.owner_principal_id) ?? [];
    values.push(item);
    byOwner.set(item.owner_principal_id, values);
  }
  for (const [principalId, owned] of byOwner) {
    const sorted = owned.sort((left, right) =>
      String(left.due_at).localeCompare(String(right.due_at)),
    );
    const conflicting = sorted.filter((item, index) => {
      const next = sorted[index + 1];
      return Boolean(
        next &&
        Math.abs(Date.parse(next.due_at!) - Date.parse(item.due_at!)) <=
          48 * 60 * 60 * 1000,
      );
    });
    if (!conflicting.length) continue;
    const refs = sorted.map((item) => `work_item:${item.work_item_id}`);
    signals.push(
      signal({
        rule_id: 'deadline_capacity_conflict',
        category: 'capacity_risk',
        severity: 'high',
        title: 'High-priority deadlines are concentrated on one owner',
        summary: `${principalId} owns ${sorted.length} high-priority items with overlapping deadlines.`,
        affected_refs: [`principal:${principalId}`, ...refs],
        evidence_refs: refs,
        observed_at: observedAt,
      }),
    );
  }

  for (const turn of Object.values(projection.turns)) {
    const deadline = turnDeadline(turn);
    const turnRef = `turn:${turn.turn_id}`;
    if (deadline !== null && deadline <= nowMs)
      signals.push(
        signal({
          rule_id: 'workflow_turn_timeout',
          category: 'workflow_stall',
          severity: 'high',
          title: `Workflow Turn timed out: ${turn.state_id}`,
          summary: `The Turn remains ${turn.state} after its frozen deadline.`,
          affected_refs: [
            turnRef,
            `workflow_instance:${turn.workflow_instance_id}`,
          ],
          evidence_refs: [turnRef],
          observed_at: observedAt,
        }),
      );
    if (turn.state === 'recovery_required')
      signals.push(
        signal({
          rule_id: 'workflow_turn_recovery',
          category: 'workflow_stall',
          severity: 'critical',
          title: `Workflow Turn requires recovery: ${turn.state_id}`,
          summary:
            turn.recovery_reason ||
            'The Turn cannot progress without recovery.',
          affected_refs: [turnRef],
          evidence_refs: [turnRef],
          observed_at: observedAt,
        }),
      );
  }

  for (const instance of Object.values(projection.workflowInstances))
    if (instance.lifecycle === 'recovery_required')
      signals.push(
        signal({
          rule_id: 'workflow_instance_recovery',
          category: 'workflow_stall',
          severity: 'critical',
          title: `Workflow Instance requires recovery: ${instance.definition_id}`,
          summary: 'The Workflow Instance cannot progress without recovery.',
          affected_refs: [`workflow_instance:${instance.instance_id}`],
          evidence_refs: [`workflow_instance:${instance.instance_id}`],
          observed_at: observedAt,
        }),
      );

  for (const request of Object.values(projection.recoveryRequests))
    if (request.status === 'pending')
      signals.push(
        signal({
          rule_id: 'identity_recovery_pending',
          category: 'identity_risk',
          severity: request.type === 'owner_recovery' ? 'critical' : 'high',
          title: 'Identity recovery is awaiting a decision',
          summary: `Recovery request ${request.request_id} remains pending.`,
          affected_refs: [`recovery:${request.request_id}`],
          evidence_refs: [`recovery:${request.request_id}`],
          observed_at: observedAt,
        }),
      );

  if (projection.integrityStatus !== 'OK')
    signals.push(
      signal({
        rule_id: 'protocol_quarantined',
        category: 'protocol_risk',
        severity: 'critical',
        title: 'Collaboration protocol is quarantined',
        summary:
          'Verified replay reported an integrity failure. Continue using only the last verified snapshot and review Host diagnostics.',
        affected_refs: [`group:${projection.groupId}`],
        evidence_refs: [`group:${projection.groupId}`],
        observed_at: observedAt,
      }),
    );

  return signals.sort(
    (left, right) =>
      severityRank[right.severity] - severityRank[left.severity] ||
      left.rule_id.localeCompare(right.rule_id) ||
      left.signal_id.localeCompare(right.signal_id),
  );
}

function myItem(input: Omit<CollaborationMyItem, 'item_id'>) {
  return {
    ...input,
    item_id: `my_${crypto
      .createHash('sha256')
      .update(
        `${input.group}:${input.resource_type}:${input.resource_id}:${input.reason}`,
      )
      .digest('hex')
      .slice(0, 24)}`,
  } satisfies CollaborationMyItem;
}

export function buildMyItems(input: {
  readonly group: Pick<
    CollaborationProjectSpaceGroupRecord,
    | 'localPrincipalId'
    | 'localClientId'
    | 'localCredentialId'
    | 'protocolStatus'
    | 'protocolError'
    | 'ownerPrincipalId'
    | 'subscriptionMode'
  >;
  readonly projection: CollaborationProjectionV3;
  readonly nowMs: number;
}): CollaborationMyItem[] {
  const { group, projection, nowMs } = input;
  const principalId = group.localPrincipalId;
  if (!principalId) return [];
  const values: CollaborationMyItem[] = [];
  const add = (item: Omit<CollaborationMyItem, 'item_id'>) =>
    values.push(myItem(item));
  for (const item of Object.values(projection.workItems)) {
    const owned = item.owner_principal_id === principalId;
    const contributing = item.contributors.includes(principalId);
    const watching = item.watchers.includes(principalId);
    const blockers = activeBlockers(projection, item);
    const overdue = Boolean(item.due_at && Date.parse(item.due_at) <= nowMs);
    const resolvedRecently = Boolean(
      terminalWorkItemStatuses.has(item.status) &&
      item.closed_at &&
      nowMs - Date.parse(item.closed_at) <= 7 * 86_400_000,
    );
    if (resolvedRecently && (owned || contributing || watching))
      add({
        group: 'recently_resolved',
        priority_rank: 90,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason: 'recently_resolved',
        severity: 'info',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });
    if (!isActive(item)) continue;
    if (owned && item.assignment_status === 'pending')
      add({
        group: 'needs_action',
        priority_rank: 400,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason: 'assignment_confirmation_required',
        severity: 'high',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });
    else if (owned && blockers.length)
      add({
        group: 'waiting_on_others',
        priority_rank: overdue ? 470 : 280,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason: 'waiting_for_blockers',
        severity: overdue ? 'high' : 'medium',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });
    else if (owned || contributing)
      add({
        group:
          overdue || item.status === 'blocked' ? 'at_risk' : 'needs_action',
        priority_rank: overdue ? 480 : item.status === 'blocked' ? 440 : 240,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason: overdue
          ? 'overdue'
          : item.status === 'blocked'
            ? 'blocked'
            : 'active_assignment',
        severity: overdue ? 'high' : item.status === 'blocked' ? 'high' : 'low',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });
    else if (watching)
      add({
        group: 'watching',
        priority_rank: overdue ? 320 : 100,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason:
          overdue || item.status === 'blocked' ? 'watched_risk' : 'watching',
        severity: overdue || item.status === 'blocked' ? 'medium' : 'info',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });

    const blockingHighPriority = Object.values(projection.workItems).some(
      (dependent) =>
        isActive(dependent) &&
        ['high', 'urgent'].includes(dependent.priority) &&
        dependent.blocked_by.includes(item.work_item_id),
    );
    if (owned && blockingHighPriority)
      add({
        group: 'at_risk',
        priority_rank: 460,
        resource_type: 'work_item',
        resource_id: item.work_item_id,
        title: item.title,
        reason: 'blocking_high_priority_work',
        severity: 'high',
        due_at: item.due_at,
        navigation: { tab: 'work-items', resource_id: item.work_item_id },
      });
  }

  for (const turn of Object.values(projection.turns)) {
    if (
      turn.assignee_principal_id !== principalId ||
      terminalTurnStates.has(turn.state)
    )
      continue;
    const deadline = turnDeadline(turn);
    const overdue = deadline !== null && deadline <= nowMs;
    add({
      group: overdue ? 'at_risk' : 'needs_action',
      priority_rank: overdue ? 500 : 380,
      resource_type: 'turn',
      resource_id: turn.turn_id,
      title: `Workflow Turn: ${turn.state_id}`,
      reason: overdue ? 'turn_timeout' : `turn_${turn.state}`,
      severity: overdue ? 'high' : 'medium',
      due_at: deadline === null ? null : new Date(deadline).toISOString(),
      navigation: {
        tab: 'workflows',
        resource_id: turn.workflow_instance_id,
      },
    });
  }

  for (const instance of Object.values(projection.workflowInstances)) {
    if (
      instance.lifecycle === 'running' &&
      !instance.active_turn_id &&
      instance.resolved_assignments[instance.business_state] === principalId
    )
      add({
        group: 'needs_action',
        priority_rank: 370,
        resource_type: 'workflow_instance',
        resource_id: instance.instance_id,
        title: `Workflow State: ${instance.business_state}`,
        reason: 'workflow_state_assignment_ready',
        severity: 'medium',
        due_at: null,
        navigation: {
          tab: 'workflows',
          resource_id: instance.instance_id,
        },
      });
    if (
      instance.created_by_principal_id === principalId &&
      ['paused', 'recovery_required'].includes(instance.lifecycle)
    )
      add({
        group: 'at_risk',
        priority_rank: instance.lifecycle === 'recovery_required' ? 520 : 350,
        resource_type: 'workflow_instance',
        resource_id: instance.instance_id,
        title: `Workflow: ${instance.definition_id}`,
        reason: `workflow_${instance.lifecycle}`,
        severity:
          instance.lifecycle === 'recovery_required' ? 'critical' : 'medium',
        due_at: null,
        navigation: { tab: 'workflows', resource_id: instance.instance_id },
      });
  }

  for (const thread of Object.values(projection.discussions)) {
    if (thread.discussion.status === 'resolved') continue;
    const mentioned = Object.values(thread.messages).some(
      (message) =>
        !message.tombstoned && message.mentions.includes(principalId),
    );
    if (mentioned)
      add({
        group: 'needs_action',
        priority_rank: 330,
        resource_type: 'discussion',
        resource_id: thread.discussion.thread_id,
        title: thread.discussion.title,
        reason: 'discussion_mention',
        severity: 'medium',
        due_at: null,
        navigation: {
          tab: 'discussions',
          resource_id: thread.discussion.thread_id,
        },
      });
  }

  for (const request of Object.values(projection.recoveryRequests)) {
    if (request.status !== 'pending') continue;
    const canDecide =
      request.type === 'identity_recovery'
        ? request.target_principal_id === principalId
        : group.ownerPrincipalId === principalId;
    if (!canDecide) continue;
    add({
      group: 'needs_action',
      priority_rank: 600,
      resource_type: 'recovery',
      resource_id: request.request_id,
      title: 'Identity recovery request',
      reason: 'recovery_decision_required',
      severity: request.type === 'owner_recovery' ? 'critical' : 'high',
      due_at: request.expires_at,
      navigation: { tab: 'members', resource_id: request.request_id },
    });
  }

  const member = projection.members[principalId];
  if (!member || member.status !== 'active')
    add({
      group: 'needs_action',
      priority_rank: 580,
      resource_type: 'membership',
      resource_id: principalId,
      title: 'Membership requires attention',
      reason: member ? `membership_${member.status}` : 'membership_unverified',
      severity: 'high',
      due_at: null,
      navigation: { tab: 'members', resource_id: principalId },
    });

  const credential = group.localCredentialId
    ? projection.credentials[principalId]?.[group.localCredentialId]
    : null;
  if (
    group.subscriptionMode === 'member' &&
    (!credential || credential.status !== 'active')
  )
    add({
      group: 'needs_action',
      priority_rank: 590,
      resource_type: 'credential',
      resource_id: group.localCredentialId ?? principalId,
      title: 'Local Credential is unavailable',
      reason: credential
        ? `credential_${credential.status}`
        : 'credential_missing',
      severity: 'critical',
      due_at: null,
      navigation: { tab: 'members', resource_id: principalId },
    });

  if (group.protocolStatus !== 'OK' || projection.integrityStatus !== 'OK')
    add({
      group: 'needs_action',
      priority_rank: 610,
      resource_type: 'protocol',
      resource_id: projection.groupId,
      title: 'Collaboration integrity requires attention',
      reason: 'protocol_or_sync_verification_failed',
      severity: 'critical',
      due_at: null,
      navigation: { tab: 'diagnostics', resource_id: projection.groupId },
    });

  const distinct = new Map<string, CollaborationMyItem>();
  for (const item of values) {
    const key = `${item.group}:${item.resource_type}:${item.resource_id}:${item.reason}`;
    distinct.set(key, item);
  }
  return [...distinct.values()].sort(
    (left, right) =>
      right.priority_rank - left.priority_rank ||
      String(left.due_at ?? '9999').localeCompare(
        String(right.due_at ?? '9999'),
      ) ||
      left.resource_type.localeCompare(right.resource_type) ||
      left.resource_id.localeCompare(right.resource_id),
  );
}

export function buildCollaborationProjectInsight(input: {
  readonly group: CollaborationProjectSpaceGroupRecord;
  readonly projection: CollaborationProjectionV3;
  readonly snapshotHead: string;
  readonly nowMs?: number;
  readonly lastViewedActivityEventId?: string | null;
}): CollaborationProjectInsight {
  const nowMs = input.nowMs ?? Date.now();
  const { group, projection } = input;
  const signals = buildProjectSignals({ projection, nowMs });
  if (group.protocolStatus !== 'OK' || group.lastError)
    signals.push(
      signal({
        rule_id: 'sync_or_protocol_failure',
        category: 'protocol_risk',
        severity:
          group.protocolStatus === 'PROTOCOL_QUARANTINED' ? 'critical' : 'high',
        title: 'Collaboration verification requires attention',
        summary:
          'The latest sync or protocol verification did not complete successfully. The dashboard remains bound to the last verified snapshot.',
        affected_refs: [`group:${projection.groupId}`],
        evidence_refs: [`group:${projection.groupId}`],
        observed_at: new Date(nowMs).toISOString(),
      }),
    );
  signals.sort(
    (left, right) =>
      severityRank[right.severity] - severityRank[left.severity] ||
      left.rule_id.localeCompare(right.rule_id) ||
      left.signal_id.localeCompare(right.signal_id),
  );
  const workItems = Object.values(projection.workItems);
  const turns = Object.values(projection.turns);
  const instances = Object.values(projection.workflowInstances);
  const overdue = workItems.filter(
    (item) =>
      isActive(item) &&
      Boolean(item.due_at && Date.parse(item.due_at) <= nowMs),
  ).length;
  const timedOut = turns.filter((turn) => {
    const deadline = turnDeadline(turn);
    return deadline !== null && deadline <= nowMs;
  }).length;
  const deltaStart = input.lastViewedActivityEventId
    ? projection.activity.findIndex(
        (entry) => entry.eventId === input.lastViewedActivityEventId,
      ) + 1
    : projection.activity.length;
  const maxSeverity = signals.reduce<ProjectSignalSeverity>(
    (current, candidate) =>
      severityRank[candidate.severity] > severityRank[current]
        ? candidate.severity
        : current,
    'info',
  );
  const health =
    maxSeverity === 'critical'
      ? 'critical'
      : maxSeverity === 'high'
        ? 'at_risk'
        : signals.length
          ? 'needs_attention'
          : 'healthy';
  return {
    format: 'icarus.collaboration-project-insight/1',
    group_id: projection.groupId,
    snapshot_head: input.snapshotHead,
    generated_at: new Date(nowMs).toISOString(),
    health,
    counts: {
      active_members: Object.values(projection.members).filter(
        (member) => member.status === 'active',
      ).length,
      open_work_items: workItems.filter(isActive).length,
      overdue_work_items: overdue,
      blocked_work_items: workItems.filter(
        (item) =>
          isActive(item) &&
          (item.status === 'blocked' ||
            activeBlockers(projection, item).length > 0),
      ).length,
      pending_assignments: workItems.filter(
        (item) => isActive(item) && item.assignment_status === 'pending',
      ).length,
      workflow_running: instances.filter(
        (entry) => entry.lifecycle === 'running',
      ).length,
      workflow_paused: instances.filter((entry) => entry.lifecycle === 'paused')
        .length,
      workflow_waiting: turns.filter(
        (turn) =>
          !terminalTurnStates.has(turn.state) &&
          [
            'pending',
            'waiting_input',
            'waiting_approval',
            'awaiting_confirmation',
          ].includes(turn.state),
      ).length,
      workflow_timed_out: timedOut,
      unresolved_discussions: Object.values(projection.discussions).filter(
        (entry) => entry.discussion.status === 'open',
      ).length,
    },
    sync: {
      verified_head: input.snapshotHead,
      last_verified_sync_at:
        group.lastSyncAtMs === null
          ? null
          : new Date(group.lastSyncAtMs).toISOString(),
      protocol_status: group.protocolStatus,
      integrity_status: projection.integrityStatus,
      healthy:
        group.protocolStatus === 'OK' &&
        projection.integrityStatus === 'OK' &&
        !group.lastError,
      error:
        group.protocolStatus !== 'OK' || group.lastError
          ? 'sync_or_protocol_verification_failed'
          : null,
    },
    signals,
    recent_activity: projection.activity.slice(-20).reverse(),
    activity_delta:
      deltaStart > 0 ? projection.activity.slice(deltaStart).reverse() : [],
  };
}

export function collaborationAnalysisResourceIndex(
  projection: CollaborationProjectionV3,
): string[] {
  return [
    `group:${projection.groupId}`,
    ...Object.keys(projection.members).map((id) => `principal:${id}`),
    ...Object.keys(projection.recoveryRequests).map((id) => `recovery:${id}`),
    ...Object.keys(projection.workItems).map((id) => `work_item:${id}`),
    ...Object.values(projection.discussions).flatMap((entry) => [
      `discussion:${entry.discussion.thread_id}`,
      ...Object.keys(entry.messages).map((id) => `message:${id}`),
    ]),
    ...Object.keys(projection.workflowInstances).map(
      (id) => `workflow_instance:${id}`,
    ),
    ...Object.keys(projection.turns).map((id) => `turn:${id}`),
    ...Object.keys(projection.files).map((id) => `file:${id}`),
    ...projection.activity.map((entry) => `event:${entry.eventId}`),
  ].sort();
}
