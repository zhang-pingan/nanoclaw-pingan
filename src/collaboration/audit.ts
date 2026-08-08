import type {
  CollaborationActionExecutionV3,
  CollaborationNotificationV3,
  CollaborationProjectSpaceEventRecord,
  CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import type { CollaborationProjectionV3 } from './protocol/v3-reducer.js';

export interface CollaborationAuditExportV3 {
  readonly format: 'icarus.collaboration-audit/3';
  readonly generated_at: string;
  readonly group: {
    readonly group_id: string;
    readonly lifecycle: string;
    readonly owner_principal_id: string;
    readonly subscription_mode: 'observer' | 'member';
    readonly last_verified_head: string | null;
    readonly protocol_status: string;
  };
  readonly aggregates: CollaborationProjectionV3['aggregateHeads'];
  readonly credentials: CollaborationProjectionV3['credentials'];
  readonly recovery_requests: CollaborationProjectionV3['recoveryRequests'];
  readonly events: readonly Record<string, unknown>[];
  readonly local_evidence: readonly Record<string, unknown>[];
}

function auditSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(auditSafe);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    if (/^(?:\/|[A-Za-z]:[\\/])/u.test(value)) return '[local-path-redacted]';
    return value.replace(
      /(https?:\/\/)[^/@\s]+(?::[^/@\s]*)?@/giu,
      '$1redacted@',
    );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|authorization|private.?key|api.?key/iu.test(key)
        ? '[redacted]'
        : auditSafe(item),
    ]),
  );
}

function publicExecution(
  execution: CollaborationActionExecutionV3,
  includeContent: boolean,
): Record<string, unknown> {
  return {
    execution_id: execution.executionId,
    instance_id: execution.instanceId,
    turn_id: execution.turnId,
    attempt: execution.attempt,
    claimant_client_id: execution.claimantClientId,
    fencing_token: execution.fencingToken,
    operation_key: execution.operationKey,
    executor_id: execution.executorId,
    executor_kind: execution.executorKind,
    state: execution.state,
    execution_ref: execution.executionRef,
    receipt_recorded_at_ms: execution.receiptRecordedAtMs,
    provider_completed_at_ms: execution.providerCompletedAtMs,
    recovery_required_reason: execution.recoveryRequiredReason,
    ...(includeContent
      ? {
          receipt: auditSafe(execution.receipt),
          observation: auditSafe(execution.observation),
        }
      : {}),
  };
}

function publicNotification(
  notification: CollaborationNotificationV3,
): Record<string, unknown> {
  return {
    notification_id: notification.notificationId,
    recipient_principal_id: notification.recipientPrincipalId,
    recipient_client_id: notification.recipientClientId,
    kind: notification.kind,
    resource_type: notification.resourceType,
    resource_id: notification.resourceId,
    reason: notification.reason,
    dedupe_key: notification.dedupeKey,
    severity: notification.severity,
    reminder_ordinal: notification.reminderOrdinal,
    due_at_ms: notification.dueAtMs,
    first_observed_at_ms: notification.firstObservedAtMs,
    delivered_at_ms: notification.deliveredAtMs,
    read_at_ms: notification.readAtMs,
    handled_at_ms: notification.handledAtMs,
    updated_at_ms: notification.updatedAtMs,
  };
}

export function buildCollaborationAuditV3(input: {
  readonly group: CollaborationProjectSpaceGroupRecord;
  readonly projection: CollaborationProjectionV3;
  readonly eventRecords: readonly CollaborationProjectSpaceEventRecord[];
  readonly executions: readonly CollaborationActionExecutionV3[];
  readonly notifications: readonly CollaborationNotificationV3[];
  readonly localEvidence: readonly Record<string, unknown>[];
  readonly includeContent?: boolean;
  readonly generatedAt?: Date;
}): CollaborationAuditExportV3 {
  const includeContent = input.includeContent ?? false;
  return {
    format: 'icarus.collaboration-audit/3',
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    group: {
      group_id: input.group.groupId,
      lifecycle: input.group.lifecycle,
      owner_principal_id: input.group.ownerPrincipalId,
      subscription_mode: input.group.subscriptionMode,
      last_verified_head: input.group.lastVerifiedHead,
      protocol_status: input.group.protocolStatus,
    },
    aggregates: input.projection.aggregateHeads,
    credentials: input.projection.credentials,
    recovery_requests: input.projection.recoveryRequests,
    events: input.eventRecords
      .slice()
      .sort((left, right) => left.commitOrder - right.commitOrder)
      .map(({ event, commitHash, commitOrder }) => ({
        event_id: event.event_id,
        commit_hash: commitHash,
        commit_order: commitOrder,
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        aggregate_revision: event.aggregate_revision,
        previous_event_hash: event.previous_event_hash,
        event_type: event.event_type,
        actor: event.actor,
        occurred_at: event.occurred_at,
        causation_id: event.causation_id,
        correlation_id: event.correlation_id,
        payload_hash: event.payload_hash,
        ...(includeContent ? { payload: auditSafe(event.payload) } : {}),
      })),
    local_evidence: [
      ...input.executions.map((execution) =>
        publicExecution(execution, includeContent),
      ),
      ...input.notifications.map(publicNotification),
      ...input.localEvidence.map(
        (evidence) => auditSafe(evidence) as Record<string, unknown>,
      ),
    ],
  };
}
