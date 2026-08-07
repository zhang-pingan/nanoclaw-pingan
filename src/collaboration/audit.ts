import type { CollaborationEvent, HandoffEnvelope } from './protocol/schema.js';
import {
  collaborationCanonicalHash,
  type CollaborationTurn,
} from './protocol/reducer.js';
import type { ValidatedCollaborationHistory } from './protocol/git-chain.js';
import type {
  CollaborationExecutionRecord,
  CollaborationGroupRecord,
  CollaborationNotificationRecord,
} from './store.js';

export interface CollaborationAuditEventRecord {
  readonly event: CollaborationEvent;
  readonly commitHash: string;
}

export interface BuildCollaborationAuditInput {
  readonly group: CollaborationGroupRecord;
  readonly history: ValidatedCollaborationHistory;
  readonly eventRecords: readonly CollaborationAuditEventRecord[];
  readonly executions: readonly CollaborationExecutionRecord[];
  readonly notifications: readonly CollaborationNotificationRecord[];
  readonly generatedAt: string;
}

export interface CollaborationAuditDuration {
  readonly valueMs: number | null;
  readonly reliable: boolean;
  readonly clockSkew: boolean;
  readonly fromSequence: number | null;
  readonly toSequence: number | null;
}

export interface CollaborationAuditEventReference {
  readonly eventId: string;
  readonly eventType: CollaborationEvent['event_type'];
  readonly sequence: number;
  readonly revision: number;
  readonly occurredAt: string;
}

export interface CollaborationAuditSharedEvent extends CollaborationAuditEventReference {
  readonly epoch: number;
  readonly payloadHash: string;
  readonly commitHash: string;
  readonly signer: {
    readonly principalId: string;
    readonly agentId: string;
    readonly signingKeyRef: string | null;
  };
  readonly summary: Readonly<Record<string, unknown>>;
}

interface EventPoint {
  readonly occurredAt: string;
  readonly sequence: number;
}

interface TurnEventSet {
  readonly all: readonly CollaborationEvent[];
  readonly byAttempt: ReadonlyMap<number, readonly CollaborationEvent[]>;
}

const TURN_EVENT_TYPES = new Set<CollaborationEvent['event_type']>([
  'turn_created',
  'turn_started',
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_completed',
  'turn_completed',
  'turn_cancelled',
  'turn_recovery_requested',
  'turn_recovered',
  'turn_timeout_observed',
]);

const CONTROL_EVENT_TYPES = new Set<CollaborationEvent['event_type']>([
  'group_pause_requested',
  'group_paused',
  'group_resumed',
  'group_close_requested',
  'group_closed',
  'turn_cancelled',
  'turn_recovery_requested',
  'turn_recovered',
  'protocol_recovery',
]);

const SENSITIVE_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
    '[REDACTED PRIVATE KEY]',
  ],
  [
    /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|secret|credential)\b\s*[:=]\s*)[^\s,;]+/giu,
    '$1[REDACTED]',
  ],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED TOKEN]'],
  [/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu, '$1[REDACTED]@'],
  [
    /(^|[\s"'`(])\/(?:Users|home|var|tmp|private|opt|etc)\/[^\s"'`),;]*/gu,
    '$1[REDACTED PATH]',
  ],
  [/\b[A-Za-z]:\\(?:[^\s"'`),;]+\\)*[^\s"'`),;]*/gu, '[REDACTED PATH]'],
];

function redactText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

function isoFromMs(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

function stringValue(
  value: unknown,
  options: { readonly redact?: boolean } = {},
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return options.redact ? redactText(value) : value;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payload(event: CollaborationEvent): Record<string, unknown> {
  return event.payload;
}

function eventAttempt(event: CollaborationEvent): number | null {
  return numberValue(payload(event).attempt);
}

function eventTurnId(event: CollaborationEvent): string | null {
  return stringValue(payload(event).turn_id);
}

function eventReference(
  event: CollaborationEvent,
): CollaborationAuditEventReference {
  return {
    eventId: event.event_id,
    eventType: event.event_type,
    sequence: event.sequence,
    revision: event.expected.state_revision + 1,
    occurredAt: event.occurred_at,
  };
}

function eventPoint(event: CollaborationEvent | undefined): EventPoint | null {
  return event
    ? { occurredAt: event.occurred_at, sequence: event.sequence }
    : null;
}

function duration(
  from: EventPoint | null,
  to: EventPoint | null,
): CollaborationAuditDuration {
  if (!from || !to)
    return {
      valueMs: null,
      reliable: false,
      clockSkew: false,
      fromSequence: from?.sequence ?? null,
      toSequence: to?.sequence ?? null,
    };
  const elapsed = Date.parse(to.occurredAt) - Date.parse(from.occurredAt);
  const invalidOrder = to.sequence <= from.sequence;
  const clockSkew = !Number.isFinite(elapsed) || elapsed < 0;
  return {
    valueMs: invalidOrder || clockSkew ? null : elapsed,
    reliable: !invalidOrder && !clockSkew,
    clockSkew,
    fromSequence: from.sequence,
    toSequence: to.sequence,
  };
}

function firstEvent(
  events: readonly CollaborationEvent[],
  type: CollaborationEvent['event_type'],
): CollaborationEvent | undefined {
  return events.find((event) => event.event_type === type);
}

function lastEvent(
  events: readonly CollaborationEvent[],
  types: ReadonlySet<CollaborationEvent['event_type']>,
): CollaborationEvent | undefined {
  return [...events].reverse().find((event) => types.has(event.event_type));
}

function publicHandoff(handoff: HandoffEnvelope | null, hash: string | null) {
  if (!handoff && !hash) return null;
  return {
    hash,
    sourceTurnId: handoff?.source_turn_id ?? null,
    outcome: handoff?.outcome ?? null,
    summary: handoff ? redactText(handoff.summary) : null,
    markers: handoff ? [...handoff.markers] : [],
    repositoryRefs: handoff
      ? {
          data: [...handoff.data_refs],
          artifacts: [...handoff.artifact_refs],
        }
      : { data: [], artifacts: [] },
  };
}

function eventSummary(event: CollaborationEvent): Record<string, unknown> {
  const value = payload(event);
  switch (event.event_type) {
    case 'group_initialized': {
      const member = value.member as Record<string, unknown> | undefined;
      const claim = value.role_claim as Record<string, unknown> | undefined;
      return {
        member: member
          ? {
              principalId: stringValue(member.principal_id),
              agentId: stringValue(member.agent_id),
              signingKeyRef: stringValue(member.signing_key_ref),
            }
          : null,
        role: claim ? stringValue(claim.role) : null,
      };
    }
    case 'machine_revised':
      return {
        machineHash: stringValue(value.machine_hash),
        definitionHash: stringValue(value.definition_hash),
        stateCount: Object.keys(
          ((value.machine as Record<string, unknown> | undefined)?.states as
            | Record<string, unknown>
            | undefined) ?? {},
        ).length,
        roleCount: Object.keys(
          (value.roles as Record<string, unknown> | undefined) ?? {},
        ).length,
        invalidatedStateIds: Array.isArray(value.invalidated_state_ids)
          ? value.invalidated_state_ids.map(String)
          : [],
      };
    case 'machine_layout_updated':
      return { layoutHash: stringValue(value.layout_hash) };
    case 'member_registered': {
      const member = value.member as Record<string, unknown> | undefined;
      return {
        principalId: member ? stringValue(member.principal_id) : null,
        agentId: member ? stringValue(member.agent_id) : null,
        signingKeyRef: member ? stringValue(member.signing_key_ref) : null,
      };
    }
    case 'role_claimed':
    case 'role_released':
      return {
        role: stringValue(value.role),
        principalId: stringValue(value.principal_id),
        agentId: stringValue(value.agent_id),
      };
    case 'state_implementation_published':
    case 'state_implementation_revised': {
      const implementation = value.implementation as
        | Record<string, unknown>
        | undefined;
      return {
        stateId: implementation ? stringValue(implementation.state_id) : null,
        role: implementation ? stringValue(implementation.role) : null,
        mode: implementation ? stringValue(implementation.mode) : null,
        implementationRef: stringValue(value.implementation_ref),
        implementationHash: stringValue(value.implementation_hash),
        actionHash: stringValue(value.action_hash),
        promptHash: stringValue(value.prompt_hash),
      };
    }
    case 'state_implementation_withdrawn':
      return {
        stateId: stringValue(value.state_id),
        role: stringValue(value.role),
      };
    case 'group_started':
      return {
        initialHandoffHash: stringValue(value.initial_handoff_hash),
      };
    case 'group_pause_requested':
    case 'group_paused':
    case 'group_resumed':
      return {};
    case 'group_close_requested':
    case 'group_closed':
    case 'protocol_recovery':
      return { reason: stringValue(value.reason, { redact: true }) };
    case 'turn_created':
      return {
        turnId: stringValue(value.turn_id),
        stateId: stringValue(value.state_id),
        role: stringValue(value.role),
        mode: stringValue(value.mode),
        attempt: numberValue(value.attempt),
        machineHash: stringValue(value.machine_hash),
        implementationHash: stringValue(value.implementation_hash),
        actionHash: stringValue(value.action_hash),
        promptHash: stringValue(value.prompt_hash),
        inputHash: stringValue(value.input_hash),
        incomingHandoffHash: stringValue(value.incoming_handoff_hash),
        startDeadlineAt: stringValue(value.start_deadline_at),
        deadlineSnapshotHash: stringValue(value.deadline_snapshot_hash),
      };
    case 'turn_started':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        executionDeadlineAt: stringValue(value.execution_deadline_at),
        deadlineSnapshotHash: stringValue(value.deadline_snapshot_hash),
      };
    case 'action_dispatched':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        executionRef: stringValue(value.execution_ref, { redact: true }),
      };
    case 'action_waiting_input':
    case 'action_waiting_approval':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
      };
    case 'action_completed':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        resultHash: stringValue(value.result_hash),
      };
    case 'turn_completed': {
      const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        outcome: stringValue(value.outcome),
        resultHash: stringValue(value.result_hash),
        handoffHash: stringValue(value.handoff_hash),
        artifactHashes: artifacts.map((artifact) =>
          stringValue((artifact as Record<string, unknown>).sha256),
        ),
      };
    }
    case 'turn_cancelled':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        reason: stringValue(value.reason, { redact: true }),
      };
    case 'turn_recovery_requested':
    case 'turn_recovered':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        reason: stringValue(value.reason, { redact: true }),
        startDeadlineAt: stringValue(value.start_deadline_at),
        deadlineSnapshotHash: stringValue(value.deadline_snapshot_hash),
      };
    case 'turn_timeout_observed':
      return {
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
        deadlineKind: stringValue(value.deadline_kind),
        deadlineAt: stringValue(value.deadline_at),
        observedAt: stringValue(value.observed_at),
        turnSnapshotHash: stringValue(value.turn_snapshot_hash),
      };
    case 'data_updated':
      return {
        repositoryPath: stringValue(value.path),
        contentHash: stringValue(value.content_sha256),
        sizeBytes: numberValue(value.size_bytes),
        mediaType: stringValue(value.media_type),
        turnId: stringValue(value.turn_id),
        attempt: numberValue(value.attempt),
      };
  }
}

const PUBLIC_REFERENCE_NAMES = new Map<string, string>([
  ['accepted', 'accepted'],
  ['operation_key', 'operationKey'],
  ['operationKey', 'operationKey'],
  ['run_id', 'runId'],
  ['runId', 'runId'],
  ['query_id', 'queryId'],
  ['queryId', 'queryId'],
  ['workflow_id', 'workflowId'],
  ['workflowId', 'workflowId'],
  ['graph_run_id', 'graphRunId'],
  ['graphRunId', 'graphRunId'],
  ['thread_id', 'threadId'],
  ['threadId', 'threadId'],
  ['turn_id', 'turnId'],
  ['turnId', 'turnId'],
  ['transport_id', 'transportId'],
  ['transportId', 'transportId'],
  ['transport', 'transport'],
  ['execution_ref', 'executionRef'],
  ['executionRef', 'executionRef'],
]);

function collectPublicReferences(
  input: unknown,
  result: Record<string, string | number | boolean> = {},
  visited = new Set<object>(),
): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || visited.has(input)) return result;
  visited.add(input);
  if (Array.isArray(input)) {
    for (const item of input) collectPublicReferences(item, result, visited);
    return result;
  }
  for (const [key, value] of Object.entries(input)) {
    const publicName = PUBLIC_REFERENCE_NAMES.get(key);
    if (
      publicName &&
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean')
    ) {
      result[publicName] =
        typeof value === 'string' ? redactText(value) : value;
      continue;
    }
    if (typeof value === 'object')
      collectPublicReferences(value, result, visited);
  }
  return result;
}

function publicReceipt(receipt: Record<string, unknown> | null) {
  if (!receipt) return null;
  const refs = collectPublicReferences(receipt);
  return {
    ...refs,
    accepted:
      typeof refs.accepted === 'boolean'
        ? refs.accepted
        : typeof receipt.accepted === 'boolean'
          ? receipt.accepted
          : null,
  };
}

function publicExecution(execution: CollaborationExecutionRecord) {
  const providerRefs = collectPublicReferences(execution.providerMetadata);
  return {
    executionId: execution.executionId,
    attempt: execution.attempt,
    state: execution.state,
    executorKind: execution.executorKind,
    adapter: execution.adapter,
    operationKey: execution.operationKey,
    executionRef: execution.executionRef
      ? redactText(execution.executionRef)
      : null,
    providerRefs,
    receipt: publicReceipt(execution.receipt),
    localTimestamps: {
      createdAt: isoFromMs(execution.createdAtMs),
      dispatchStartedAt: isoFromMs(execution.dispatchStartedAtMs),
      dispatchAcceptedAt: isoFromMs(execution.receiptRecordedAtMs),
      providerCompletedAt: isoFromMs(execution.providerCompletedAtMs),
      updatedAt: isoFromMs(execution.updatedAtMs),
    },
  };
}

function publicNotification(notification: CollaborationNotificationRecord) {
  return {
    notificationId: notification.notificationId,
    kind: notification.kind,
    attempt: notification.attempt,
    deadlineKind: notification.deadlineKind,
    deadlineAt: isoFromMs(notification.deadlineAtMs),
    recipient: {
      principalId: notification.recipientPrincipalId,
      agentId: notification.recipientAgentId,
    },
    reminderOrdinal: notification.reminderOrdinal,
    firstDiscoveredAt: isoFromMs(notification.firstDiscoveredAtMs),
    localObservedAt: isoFromMs(notification.localObservedAtMs),
    deliveredAt: isoFromMs(notification.deliveredAtMs),
  };
}

function signerKeyRefs(
  history: ValidatedCollaborationHistory,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [principalId, members] of Object.entries(
    history.projection.members,
  ))
    for (const member of members)
      result.set(`${principalId}\0${member.agent_id}`, member.signing_key_ref);
  return result;
}

function collectTurnEvents(
  turnId: string,
  events: readonly CollaborationEvent[],
): TurnEventSet {
  const all = events.filter(
    (event) =>
      TURN_EVENT_TYPES.has(event.event_type) && eventTurnId(event) === turnId,
  );
  const byAttempt = new Map<number, CollaborationEvent[]>();
  for (const event of all) {
    const attempt = eventAttempt(event);
    if (attempt === null) continue;
    const existing = byAttempt.get(attempt) ?? [];
    existing.push(event);
    byAttempt.set(attempt, existing);
  }
  return { all, byAttempt };
}

function targetState(
  history: ValidatedCollaborationHistory,
  turn: CollaborationTurn,
): string | null {
  if (!turn.outcome) return null;
  return (
    history.definition.machine.states[turn.stateId]?.transitions.find(
      (transition) => transition.outcome === turn.outcome,
    )?.target_state ?? null
  );
}

function timeoutObservations(events: readonly CollaborationEvent[]) {
  return events
    .filter((event) => event.event_type === 'turn_timeout_observed')
    .map((event) => ({
      attempt: eventAttempt(event),
      deadlineKind: stringValue(payload(event).deadline_kind),
      deadlineAt: stringValue(payload(event).deadline_at),
      observedAt: stringValue(payload(event).observed_at),
      recordedAt: event.occurred_at,
      turnSnapshotHash: stringValue(payload(event).turn_snapshot_hash),
      actor: {
        principalId: event.actor.principal_id,
        agentId: event.actor.agent_id,
      },
      event: eventReference(event),
    }));
}

function buildAttempt(input: {
  readonly attempt: number;
  readonly events: readonly CollaborationEvent[];
  readonly executions: readonly CollaborationExecutionRecord[];
  readonly notifications: readonly CollaborationNotificationRecord[];
}) {
  const created = firstEvent(input.events, 'turn_created');
  const recovered = firstEvent(input.events, 'turn_recovered');
  const start = firstEvent(input.events, 'turn_started');
  const dispatch = firstEvent(input.events, 'action_dispatched');
  const provider = firstEvent(input.events, 'action_completed');
  const completed = firstEvent(input.events, 'turn_completed');
  const cancelled = firstEvent(input.events, 'turn_cancelled');
  const recoveryRequested = firstEvent(input.events, 'turn_recovery_requested');
  const terminal = lastEvent(
    input.events,
    new Set(['turn_completed', 'turn_cancelled', 'turn_recovery_requested']),
  );
  const snapshotEvent = recovered ?? created;
  const startDeadlineAt = snapshotEvent
    ? stringValue(payload(snapshotEvent).start_deadline_at)
    : null;
  const startEvent = start ? payload(start) : null;
  const localExecutions = input.executions
    .filter((execution) => execution.attempt === input.attempt)
    .sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs ||
        left.executionId.localeCompare(right.executionId),
    );
  const reminders = input.notifications
    .filter((notification) => notification.attempt === input.attempt)
    .sort(
      (left, right) =>
        left.firstDiscoveredAtMs - right.firstDiscoveredAtMs ||
        left.notificationId.localeCompare(right.notificationId),
    );
  const firstDiscovery = reminders.reduce<number | null>(
    (current, reminder) =>
      current === null
        ? reminder.firstDiscoveredAtMs
        : Math.min(current, reminder.firstDiscoveredAtMs),
    null,
  );
  return {
    attempt: input.attempt,
    claimant: start
      ? {
          principalId: start.actor.principal_id,
          agentId: start.actor.agent_id,
        }
      : null,
    lifecycle: {
      createdAt: created?.occurred_at ?? null,
      recoveredAt: recovered?.occurred_at ?? null,
      firstLocalDiscoveryAt: isoFromMs(firstDiscovery),
      startedAt: start?.occurred_at ?? null,
      dispatchAcceptedAt: dispatch?.occurred_at ?? null,
      providerCompletedAt: provider?.occurred_at ?? null,
      awaitingConfirmationAt: provider?.occurred_at ?? null,
      completedAt: completed?.occurred_at ?? null,
      stateAdvancedAt: completed?.occurred_at ?? null,
      cancelledAt: cancelled?.occurred_at ?? null,
      recoveryRequestedAt: recoveryRequested?.occurred_at ?? null,
    },
    deadlines: {
      startAt: startDeadlineAt,
      executionAt: startEvent
        ? stringValue(startEvent.execution_deadline_at)
        : null,
      snapshotHash: stringValue(
        startEvent?.deadline_snapshot_hash ??
          (snapshotEvent
            ? payload(snapshotEvent).deadline_snapshot_hash
            : null),
      ),
    },
    durations: {
      waitingToStart: duration(eventPoint(snapshotEvent), eventPoint(start)),
      startToDispatchAccepted: duration(
        eventPoint(start),
        eventPoint(dispatch),
      ),
      dispatchToProviderCompleted: duration(
        eventPoint(dispatch),
        eventPoint(provider),
      ),
      providerToConfirmedCompletion: duration(
        eventPoint(provider),
        eventPoint(completed),
      ),
      executionToTerminal: duration(eventPoint(start), eventPoint(terminal)),
      attemptTotal: duration(eventPoint(snapshotEvent), eventPoint(terminal)),
    },
    timeoutObservations: timeoutObservations(input.events),
    reminders: reminders.map(publicNotification),
    executions: localExecutions.map(publicExecution),
    sharedEventRefs: input.events.map(eventReference),
  };
}

function buildTurn(input: {
  readonly turn: CollaborationTurn;
  readonly nextTurnCreatedSequence: number | null;
  readonly history: ValidatedCollaborationHistory;
  readonly events: readonly CollaborationEvent[];
  readonly executions: readonly CollaborationExecutionRecord[];
  readonly notifications: readonly CollaborationNotificationRecord[];
}) {
  const eventSet = collectTurnEvents(input.turn.turnId, input.events);
  const localExecutions = input.executions.filter(
    (record) =>
      record.groupId === input.turn.groupId &&
      record.turnId === input.turn.turnId &&
      record.epoch === input.turn.epoch,
  );
  const localNotifications = input.notifications.filter(
    (record) =>
      record.groupId === input.turn.groupId &&
      record.turnId === input.turn.turnId,
  );
  const attempts = new Set<number>([
    input.turn.attempt,
    ...eventSet.byAttempt.keys(),
    ...localExecutions.map((record) => record.attempt),
    ...localNotifications.map((record) => record.attempt),
  ]);
  const created = firstEvent(eventSet.all, 'turn_created');
  const completed = lastEvent(eventSet.all, new Set(['turn_completed']));
  const cancelled = lastEvent(eventSet.all, new Set(['turn_cancelled']));
  const terminal = lastEvent(
    eventSet.all,
    new Set(['turn_completed', 'turn_cancelled']),
  );
  const controlEventRefs = input.events
    .filter(
      (event) =>
        CONTROL_EVENT_TYPES.has(event.event_type) &&
        event.sequence >= (created?.sequence ?? Number.MAX_SAFE_INTEGER) &&
        (input.nextTurnCreatedSequence === null ||
          event.sequence < input.nextTurnCreatedSequence),
    )
    .map(eventReference);
  return {
    turnId: input.turn.turnId,
    epoch: input.turn.epoch,
    createdRevision: input.turn.createdRevision,
    createdSequence: created?.sequence ?? null,
    stateId: input.turn.stateId,
    role: input.turn.role,
    mode: input.turn.mode,
    attempt: input.turn.attempt,
    status: input.turn.state,
    hashes: {
      machine: input.turn.machineHash,
      implementation: input.turn.implementationHash,
      action: input.turn.actionHash,
      prompt: input.turn.promptHash,
      input: input.turn.inputHash,
      deadlineSnapshot: input.turn.deadlineSnapshotHash,
      incomingHandoff: input.turn.incomingHandoffHash,
      executorResult: input.turn.executorResultHash,
      completionResult: input.turn.completionResultHash,
      outgoingHandoff: input.turn.handoffHash,
    },
    implementationRef: input.turn.implementationRef,
    actionRef: input.turn.actionRef,
    claimant:
      input.turn.claimantPrincipalId && input.turn.claimantAgentId
        ? {
            principalId: input.turn.claimantPrincipalId,
            agentId: input.turn.claimantAgentId,
          }
        : null,
    executor: {
      executionRef: input.turn.executionRef
        ? redactText(input.turn.executionRef)
        : null,
      records: localExecutions.map(publicExecution),
    },
    incomingHandoff: publicHandoff(
      input.turn.incomingHandoff,
      input.turn.incomingHandoffHash,
    ),
    outgoingHandoff: publicHandoff(input.turn.handoff, input.turn.handoffHash),
    outcome: input.turn.outcome
      ? {
          value: input.turn.outcome,
          targetState: targetState(input.history, input.turn),
        }
      : null,
    artifacts: input.turn.artifacts.map((artifact) => ({
      artifactId: artifact.artifact_id,
      repositoryPath: artifact.repository_path,
      sha256: artifact.sha256,
      size: artifact.size,
      contentType: artifact.content_type,
      createdAt: artifact.created_at,
      uploadedBy: {
        principalId: artifact.uploaded_by_principal_id,
        agentId: artifact.uploaded_by_agent_id,
      },
    })),
    lifecycle: {
      createdAt: created?.occurred_at ?? input.turn.createdAt,
      startedAt: input.turn.startedAt,
      dispatchAcceptedAt: input.turn.dispatchAcceptedAt,
      providerCompletedAt: input.turn.providerCompletedAt,
      awaitingConfirmationAt: input.turn.awaitingConfirmationAt,
      completedAt: completed?.occurred_at ?? input.turn.completedAt,
      stateAdvancedAt: completed?.occurred_at ?? input.turn.stateAdvancedAt,
      cancelledAt: cancelled?.occurred_at ?? input.turn.cancelledAt,
      recoveryRequestedAt: input.turn.recoveryRequestedAt,
      recoveredAt: input.turn.recoveredAt,
    },
    deadlines: {
      policy: input.turn.timeoutPolicy,
      startAt: input.turn.startDeadlineAt,
      executionAt: input.turn.executionDeadlineAt,
      snapshotHash: input.turn.deadlineSnapshotHash,
    },
    timeoutObservations: timeoutObservations(eventSet.all),
    reminders: [...localNotifications]
      .sort(
        (left, right) =>
          left.firstDiscoveredAtMs - right.firstDiscoveredAtMs ||
          left.notificationId.localeCompare(right.notificationId),
      )
      .map(publicNotification),
    attempts: [...attempts]
      .sort((left, right) => left - right)
      .map((attempt) =>
        buildAttempt({
          attempt,
          events: eventSet.byAttempt.get(attempt) ?? [],
          executions: localExecutions,
          notifications: localNotifications,
        }),
      ),
    durations: {
      createdToFirstStart: duration(
        eventPoint(created),
        eventPoint(firstEvent(eventSet.all, 'turn_started')),
      ),
      createdToTerminal: duration(eventPoint(created), eventPoint(terminal)),
    },
    sharedEventRefs: eventSet.all.map(eventReference),
    controlEventRefs,
  };
}

export function buildCollaborationAudit(input: BuildCollaborationAuditInput) {
  if (input.group.groupId !== input.history.projection.groupId)
    throw new Error('Audit group and validated history do not match');
  const records = [...input.eventRecords].sort(
    (left, right) => left.event.sequence - right.event.sequence,
  );
  const events = records.map((record) => record.event);
  if (
    events.length !== input.history.projection.sequence ||
    events.some(
      (event, index) =>
        event.group_id !== input.group.groupId || event.sequence !== index + 1,
    )
  )
    throw new Error(
      'Audit event records must contain the complete contiguous signed chain',
    );
  const seenEventIds = new Set(input.history.projection.seenEventIds);
  if (events.some((event) => !seenEventIds.has(event.event_id)))
    throw new Error(
      'Audit event records do not match the validated projection',
    );
  const keyRefs = signerKeyRefs(input.history);
  const sharedEvents: CollaborationAuditSharedEvent[] = records.map(
    (record) => ({
      ...eventReference(record.event),
      epoch: record.event.epoch,
      payloadHash: collaborationCanonicalHash(record.event.payload),
      commitHash: record.commitHash,
      signer: {
        principalId: record.event.actor.principal_id,
        agentId: record.event.actor.agent_id,
        signingKeyRef:
          keyRefs.get(
            `${record.event.actor.principal_id}\0${record.event.actor.agent_id}`,
          ) ?? null,
      },
      summary: eventSummary(record.event),
    }),
  );
  const turns = Object.values(input.history.projection.turns).sort(
    (left, right) =>
      left.createdRevision - right.createdRevision ||
      left.turnId.localeCompare(right.turnId),
  );
  const turnCreatedSequences = new Map(
    events
      .filter((event) => event.event_type === 'turn_created')
      .map((event) => [eventTurnId(event), event.sequence]),
  );
  return {
    format: 'icarus.agent-group-audit/2' as const,
    generatedAt: input.generatedAt,
    ordering: {
      authority: 'signed_event_sequence' as const,
      timestampsMayReflectClockSkew: true,
    },
    scope: {
      groupId: input.group.groupId,
      epoch: input.history.projection.epoch,
    },
    group: {
      groupId: input.group.groupId,
      name: redactText(input.group.name),
      creatorPrincipalId: input.group.creatorPrincipalId,
      lifecycle: input.history.projection.lifecycle,
      businessState: input.history.projection.businessState,
      protocolStatus: input.group.protocolStatus,
      headCommit: input.history.head,
      machineHash: collaborationCanonicalHash(input.history.definition.machine),
      initialState: input.history.definition.machine.initial_state,
    },
    sharedEvents,
    controlEvents: sharedEvents.filter((event) =>
      CONTROL_EVENT_TYPES.has(event.eventType),
    ),
    turns: turns.map((turn, index) =>
      buildTurn({
        turn,
        nextTurnCreatedSequence:
          index + 1 < turns.length
            ? (turnCreatedSequences.get(turns[index + 1]!.turnId) ?? null)
            : null,
        history: input.history,
        events,
        executions: input.executions,
        notifications: input.notifications,
      }),
    ),
  };
}

export type CollaborationAudit = ReturnType<typeof buildCollaborationAudit>;
