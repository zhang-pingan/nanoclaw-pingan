import crypto from 'node:crypto';

import { z } from 'zod';

import { canonicalJsonStringify } from './canonical-json.js';
import {
  actionDefinitionV3Schema,
  clientDefinitionSchema,
  collaborationEventV3Schema,
  collaborationIdentifierSchema,
  collaborationSha256Schema,
  collaborationTurnV3Schema,
  discussionMessageSchema,
  discussionSchema,
  executorDescriptorSchema,
  fileMetadataSchema,
  groupDefinitionV3Schema,
  handoffEnvelopeV3Schema,
  machineDefinitionV3Schema,
  memberDefinitionV3Schema,
  permissionGrantSchema,
  progressUpdateSchema,
  stateExecutionSchema,
  workflowDefinitionSchema,
  workflowInstanceSchema,
  workflowLayoutSchema,
  workItemProgressSchema,
  workItemSchema,
  workItemStatusSchema,
  type ActionDefinitionV3,
  type ClientDefinition,
  type CollaborationAggregateType,
  type CollaborationEventTypeV3,
  type CollaborationEventV3,
  type CollaborationTurnV3,
  type Discussion,
  type DiscussionMessage,
  type ExecutorDescriptor,
  type FileMetadata,
  type GroupDefinitionV3,
  type HandoffEnvelopeV3,
  type MachineDefinitionV3,
  type MemberDefinitionV3,
  type PermissionGrant,
  type ProgressUpdate,
  type StateExecution,
  type WorkflowDefinition,
  type WorkflowInstance,
  type WorkflowLayout,
  type WorkItem,
  type WorkItemProgress,
} from './v3-schema.js';
import { CollaborationProtocolError } from './version.js';

const sha256 = collaborationSha256Schema;
const id = collaborationIdentifierSchema;
const emptyPayloadSchema = z.object({}).strict();
const reasonPayloadSchema = z
  .object({ reason: z.string().min(1).max(4000) })
  .strict();
const memberPayloadSchema = z
  .object({ member: memberDefinitionV3Schema })
  .strict();
const clientPayloadSchema = z
  .object({ client: clientDefinitionSchema })
  .strict();
const executorPayloadSchema = z
  .object({ executor: executorDescriptorSchema })
  .strict();
const grantPayloadSchema = z.object({ grant: permissionGrantSchema }).strict();
const principalPayloadSchema = z
  .object({ principal_id: id, reason: z.string().max(4000).default('') })
  .strict();
const clientIdPayloadSchema = z
  .object({ client_id: id, reason: z.string().max(4000).default('') })
  .strict();
const executorIdPayloadSchema = z
  .object({ executor_id: id, reason: z.string().max(4000).default('') })
  .strict();
const genesisPayloadSchema = z
  .object({
    group: groupDefinitionV3Schema,
    member: memberDefinitionV3Schema,
    client: clientDefinitionSchema,
    owner_permissions: permissionGrantSchema,
  })
  .strict();
const groupSettingsPayloadSchema = z
  .object({
    name: z.string().min(1).max(240).optional(),
    membership_policy:
      groupDefinitionV3Schema.shape.membership_policy.optional(),
    visibility_policy:
      groupDefinitionV3Schema.shape.visibility_policy.optional(),
  })
  .strict();
const progressPayloadSchema = z
  .object({ update: progressUpdateSchema })
  .strict();
const filePayloadSchema = z.object({ metadata: fileMetadataSchema }).strict();
const actionPayloadSchema = z
  .object({ action: actionDefinitionV3Schema })
  .strict();
const workItemPayloadSchema = z.object({ item: workItemSchema }).strict();
const workItemProgressPayloadSchema = z
  .object({ update: workItemProgressSchema })
  .strict();
const workItemStatusPayloadSchema = z
  .object({
    status: workItemStatusSchema,
    closed_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
const workItemAssignmentPayloadSchema = z
  .object({
    owner_principal_id: id,
    preferred_executor_id: id.nullable(),
    assignment_status: z.enum(['accepted', 'pending', 'declined']),
  })
  .strict();
const workItemRelationPayloadSchema = z
  .object({
    parent_id: id.nullable(),
    blocked_by: z.array(id).max(100),
    related_items: z.array(id).max(100),
  })
  .strict();
const discussionPayloadSchema = z
  .object({ discussion: discussionSchema })
  .strict();
const messagePayloadSchema = z
  .object({ message: discussionMessageSchema })
  .strict();
const messageIdPayloadSchema = z
  .object({ message_id: id, reason: z.string().max(4000).default('') })
  .strict();
const workflowDefinitionPayloadSchema = z
  .object({
    definition: workflowDefinitionSchema,
    machine: machineDefinitionV3Schema,
    layout: workflowLayoutSchema,
  })
  .strict();
const workflowLayoutPayloadSchema = z
  .object({
    definition_id: id,
    version: z.number().int().positive(),
    layout: workflowLayoutSchema,
    layout_hash: sha256,
  })
  .strict();
const workflowInstancePayloadSchema = z
  .object({ instance: workflowInstanceSchema })
  .strict();
const assigneePayloadSchema = z
  .object({ state_id: id, principal_id: id })
  .strict();
const stateExecutionPayloadSchema = z
  .object({ execution: stateExecutionSchema })
  .strict();
const stateExecutionWithdrawalPayloadSchema = z
  .object({ state_id: id })
  .strict();
const turnPayloadSchema = z
  .object({ turn: collaborationTurnV3Schema })
  .strict();
const turnFencePayloadSchema = z
  .object({
    turn_id: id,
    attempt: z.number().int().positive(),
    fencing_token: sha256,
  })
  .strict();
const turnStartedPayloadSchema = turnFencePayloadSchema
  .extend({
    executor_id: id.nullable(),
    execution_deadline_at: z.iso.datetime({ offset: true }).nullable(),
    deadline_snapshot_hash: sha256,
  })
  .strict();
const actionDispatchedPayloadSchema = turnFencePayloadSchema
  .extend({ execution_ref: id })
  .strict();
const actionCompletedPayloadSchema = turnFencePayloadSchema
  .extend({ result_hash: sha256 })
  .strict();
const timeoutObservedPayloadSchema = z
  .object({
    turn_id: id,
    attempt: z.number().int().positive(),
    deadline_kind: z.enum(['start', 'execution']),
    deadline_at: z.iso.datetime({ offset: true }),
    observed_at: z.iso.datetime({ offset: true }),
    turn_snapshot_hash: sha256,
  })
  .strict();
const turnCompletedPayloadSchema = turnFencePayloadSchema
  .extend({
    outcome: id,
    result_hash: sha256,
    handoff: handoffEnvelopeV3Schema,
    handoff_hash: sha256,
    artifact_refs: z.array(z.string()).max(100),
  })
  .strict();
const turnCancelledPayloadSchema = z
  .object({
    turn_id: id,
    attempt: z.number().int().positive(),
    fencing_token: sha256.nullable(),
    reason: z.string().min(1).max(4000),
  })
  .strict();
const recoveryPayloadSchema = z
  .object({
    turn_id: id,
    attempt: z.number().int().positive(),
    fencing_token: sha256.nullable(),
    reason: z.string().min(1).max(4000),
  })
  .strict();
const turnRecoveredPayloadSchema = z
  .object({
    turn_id: id,
    previous_attempt: z.number().int().positive(),
    next_attempt: z.number().int().positive(),
    reason: z.string().min(1).max(4000),
    start_deadline_at: z.iso.datetime({ offset: true }).nullable(),
    deadline_snapshot_hash: sha256,
  })
  .strict();

const payloadSchemas: Record<CollaborationEventTypeV3, z.ZodType> = {
  group_initialized: genesisPayloadSchema,
  group_settings_updated: groupSettingsPayloadSchema,
  group_archived: reasonPayloadSchema,
  group_reopened: reasonPayloadSchema,
  membership_requested: memberPayloadSchema,
  membership_rejected: principalPayloadSchema,
  member_registered: memberPayloadSchema,
  member_suspended: principalPayloadSchema,
  member_reactivated: principalPayloadSchema,
  member_removed: principalPayloadSchema,
  client_registered: clientPayloadSchema,
  client_revoked: clientIdPayloadSchema,
  executor_registered: executorPayloadSchema,
  executor_revoked: executorIdPayloadSchema,
  permission_granted: grantPayloadSchema,
  permission_revoked: grantPayloadSchema,
  progress_update_posted: progressPayloadSchema,
  shared_file_published: filePayloadSchema,
  shared_file_revised: filePayloadSchema,
  principal_file_published: filePayloadSchema,
  action_published: actionPayloadSchema,
  action_revised: actionPayloadSchema,
  work_item_created: workItemPayloadSchema,
  work_item_details_updated: workItemPayloadSchema,
  work_item_assignment_changed: workItemAssignmentPayloadSchema,
  work_item_assignment_acknowledged: emptyPayloadSchema,
  work_item_assignment_declined: reasonPayloadSchema,
  work_item_status_changed: workItemStatusPayloadSchema,
  work_item_progress_posted: workItemProgressPayloadSchema,
  work_item_relation_changed: workItemRelationPayloadSchema,
  work_item_archived: reasonPayloadSchema,
  discussion_created: discussionPayloadSchema,
  message_posted: messagePayloadSchema,
  message_revised: messagePayloadSchema,
  message_tombstoned: messageIdPayloadSchema,
  discussion_resolved: emptyPayloadSchema,
  discussion_reopened: emptyPayloadSchema,
  workflow_definition_proposed: workflowDefinitionPayloadSchema,
  workflow_definition_published: workflowDefinitionPayloadSchema,
  workflow_definition_retired: reasonPayloadSchema,
  workflow_layout_updated: workflowLayoutPayloadSchema,
  workflow_instance_created: workflowInstancePayloadSchema,
  workflow_instance_started: emptyPayloadSchema,
  workflow_instance_paused: reasonPayloadSchema,
  workflow_instance_resumed: emptyPayloadSchema,
  workflow_instance_closed: reasonPayloadSchema,
  workflow_state_assignee_changed: assigneePayloadSchema,
  state_execution_published: stateExecutionPayloadSchema,
  state_execution_revised: stateExecutionPayloadSchema,
  state_execution_withdrawn: stateExecutionWithdrawalPayloadSchema,
  turn_created: turnPayloadSchema,
  turn_started: turnStartedPayloadSchema,
  action_dispatched: actionDispatchedPayloadSchema,
  action_waiting_input: turnFencePayloadSchema,
  action_waiting_approval: turnFencePayloadSchema,
  action_completed: actionCompletedPayloadSchema,
  turn_timeout_observed: timeoutObservedPayloadSchema,
  turn_completed: turnCompletedPayloadSchema,
  turn_cancelled: turnCancelledPayloadSchema,
  turn_recovery_requested: recoveryPayloadSchema,
  turn_recovered: turnRecoveredPayloadSchema,
};

export interface CollaborationAggregateHeadV3 {
  readonly aggregateType: CollaborationAggregateType;
  readonly aggregateId: string;
  readonly revision: number;
  readonly eventHash: string;
  readonly eventId: string;
}

export interface WorkflowDefinitionProjectionV3 {
  definition: WorkflowDefinition;
  machine: MachineDefinitionV3;
  layout: WorkflowLayout;
}

export interface DiscussionProjectionV3 {
  discussion: Discussion;
  messages: Record<string, DiscussionMessage>;
}

export interface CollaborationProjectionV3 {
  readonly format: 'icarus.collaboration-projection/3';
  readonly protocolVersion: 3;
  readonly groupId: string;
  group: GroupDefinitionV3;
  aggregateHeads: Record<string, CollaborationAggregateHeadV3>;
  members: Record<string, MemberDefinitionV3>;
  clients: Record<string, Record<string, ClientDefinition>>;
  executors: Record<string, Record<string, ExecutorDescriptor>>;
  permissionGrants: Record<string, PermissionGrant>;
  progressUpdates: Record<string, ProgressUpdate>;
  files: Record<string, FileMetadata>;
  fileLocations: Record<
    string,
    {
      readonly scope: 'shared' | 'principal';
      readonly principalId: string | null;
      readonly repositoryDirectory: string;
    }
  >;
  actions: Record<string, ActionDefinitionV3>;
  workItems: Record<string, WorkItem>;
  workItemUpdates: Record<string, WorkItemProgress[]>;
  discussions: Record<string, DiscussionProjectionV3>;
  workflowDefinitions: Record<string, WorkflowDefinitionProjectionV3>;
  latestWorkflowDefinitionVersions: Record<string, number>;
  workflowInstances: Record<string, WorkflowInstance>;
  stateExecutions: Record<string, Record<string, StateExecution>>;
  turns: Record<string, CollaborationTurnV3>;
  timeoutObservations: Record<
    string,
    Array<{
      readonly attempt: number;
      readonly deadlineKind: 'start' | 'execution';
      readonly deadlineAt: string;
      readonly observedAt: string;
      readonly eventId: string;
    }>
  >;
  seenEventIds: string[];
  activity: Array<{
    readonly eventId: string;
    readonly aggregateType: CollaborationAggregateType;
    readonly aggregateId: string;
    readonly aggregateRevision: number;
    readonly eventType: CollaborationEventTypeV3;
    readonly actorPrincipalId: string;
    readonly actorClientId: string;
    readonly occurredAt: string;
  }>;
  integrityStatus: 'OK' | 'PROTOCOL_QUARANTINED';
  integrityMessage: string | null;
}

function conflict(message: string): never {
  throw new CollaborationProtocolError('EVENT_CONFLICT', message);
}

function projectionKey(
  type: CollaborationAggregateType,
  idValue: string,
): string {
  return `${type}:${idValue}`;
}

export function collaborationCanonicalHashV3(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJsonStringify(value), 'utf8')
    .digest('hex')}`;
}

export function collaborationEventHashV3(event: CollaborationEventV3): string {
  return collaborationCanonicalHashV3(event);
}

export function collaborationDeadlineAtV3(
  occurredAt: string,
  durationMs: number | null | undefined,
): string | null {
  return durationMs == null
    ? null
    : new Date(Date.parse(occurredAt) + durationMs).toISOString();
}

export function collaborationDeadlineSnapshotHashV3(input: {
  readonly turnId: string;
  readonly attempt: number;
  readonly timeoutPolicy: CollaborationTurnV3['timeout_policy_snapshot'];
  readonly startDeadlineAt: string | null;
  readonly startedAt: string | null;
  readonly executionDeadlineAt: string | null;
}): string {
  return collaborationCanonicalHashV3({
    turn_id: input.turnId,
    attempt: input.attempt,
    timeout_policy_snapshot: input.timeoutPolicy,
    start_deadline_at: input.startDeadlineAt,
    started_at: input.startedAt,
    execution_deadline_at: input.executionDeadlineAt,
  });
}

function hashParts(parts: readonly (string | number)[]): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(parts.join('\0'), 'utf8')
    .digest('hex')}`;
}

export function collaborationIdempotencyKeyV3(input: {
  readonly groupId: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly attempt: number;
  readonly inputHash: string;
}): string {
  return hashParts([
    'icarus-collaboration-action-v3',
    input.groupId,
    input.instanceId,
    input.epoch,
    input.turnId,
    input.attempt,
    input.inputHash,
  ]);
}

export function collaborationFencingTokenV3(input: {
  readonly groupId: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly attempt: number;
  readonly claimantClientId: string;
  readonly claimEventId: string;
  readonly expectedRevision: number;
}): string {
  return hashParts([
    'icarus-collaboration-fence-v3',
    input.groupId,
    input.instanceId,
    input.epoch,
    input.turnId,
    input.attempt,
    input.claimantClientId,
    input.claimEventId,
    input.expectedRevision,
  ]);
}

export function workflowDefinitionVersionKey(
  definitionId: string,
  version: number,
): string {
  return `${definitionId}@${String(version)}`;
}

export function activeCollaborationMemberV3(
  projection: CollaborationProjectionV3,
  principalId: string,
): MemberDefinitionV3 | null {
  const member = projection.members[principalId];
  return member?.status === 'active' ? member : null;
}

export function hasCollaborationPermissionV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  permission: PermissionGrant['grants'][number],
): boolean {
  return (
    principalId === projection.group.owner_principal_id ||
    projection.permissionGrants[principalId]?.grants.includes(permission) ===
      true ||
    (permission !== 'group:admin' &&
      projection.permissionGrants[principalId]?.grants.includes(
        'group:admin',
      ) === true)
  );
}

export function parseCollaborationEventPayloadV3(
  event: CollaborationEventV3,
): Record<string, unknown> {
  return payloadSchemas[event.event_type].parse(event.payload) as Record<
    string,
    unknown
  >;
}

export function validateCollaborationEventV3(
  input: unknown,
): CollaborationEventV3 {
  const event = collaborationEventV3Schema.parse(input);
  parseCollaborationEventPayloadV3(event);
  const expected = collaborationCanonicalHashV3(event.payload);
  if (expected !== event.payload_hash)
    conflict(
      `Event payload hash mismatch: expected ${expected}, received ${event.payload_hash}`,
    );
  return event;
}

function assertAggregateChain(
  projection: CollaborationProjectionV3 | null,
  event: CollaborationEventV3,
): void {
  const head =
    projection?.aggregateHeads[
      projectionKey(event.aggregate_type, event.aggregate_id)
    ];
  if (!head) {
    if (event.aggregate_revision !== 1 || event.previous_event_hash !== null)
      conflict(
        'A new Aggregate must start at revision 1 with no previous hash',
      );
    return;
  }
  if (event.aggregate_revision !== head.revision + 1)
    conflict(
      `Aggregate revision conflict for ${event.aggregate_type}:${event.aggregate_id}; expected ${String(head.revision + 1)}, received ${String(event.aggregate_revision)}`,
    );
  if (event.previous_event_hash !== head.eventHash)
    conflict(
      `Aggregate previous hash conflict for ${event.aggregate_type}:${event.aggregate_id}`,
    );
}

function assertMemberAndClient(
  projection: CollaborationProjectionV3,
  event: CollaborationEventV3,
): void {
  if (!activeCollaborationMemberV3(projection, event.actor.principal_id))
    conflict('Event actor is not an active Group member');
  const client =
    projection.clients[event.actor.principal_id]?.[event.actor.client_id];
  if (!client || client.status !== 'active')
    conflict('Event actor Client is not active');
  if (
    event.actor.executor_id &&
    !projection.executors[event.actor.principal_id]?.[event.actor.executor_id]
  )
    conflict('Event actor Executor is not registered to its Principal');
}

function assertActivePrincipals(
  projection: CollaborationProjectionV3,
  principalIds: readonly string[],
): void {
  for (const principalId of principalIds)
    if (!activeCollaborationMemberV3(projection, principalId))
      conflict(`Principal is not an active Group member: ${principalId}`);
}

function canManageWorkItem(
  projection: CollaborationProjectionV3,
  principalId: string,
  item: WorkItem,
): boolean {
  return (
    item.owner_principal_id === principalId ||
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'work_item:manage_all',
    )
  );
}

function canContributeToWorkItem(
  projection: CollaborationProjectionV3,
  principalId: string,
  item: WorkItem,
): boolean {
  return (
    canManageWorkItem(projection, principalId, item) ||
    item.contributors.includes(principalId)
  );
}

const WORK_ITEM_TRANSITIONS: Record<string, readonly string[]> = {
  proposed: ['open', 'cancelled'],
  open: ['in_progress', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  done: ['open'],
  cancelled: [],
};

function activeDefinition(
  projection: CollaborationProjectionV3,
  instance: WorkflowInstance,
): WorkflowDefinitionProjectionV3 {
  const definition =
    projection.workflowDefinitions[
      workflowDefinitionVersionKey(
        instance.definition_id,
        instance.definition_version,
      )
    ];
  if (!definition || definition.definition.status !== 'published')
    conflict('Workflow Instance references a missing published Definition');
  if (
    collaborationCanonicalHashV3({
      definition: definition.definition,
      machine: definition.machine,
    }) !== instance.definition_hash
  )
    conflict('Workflow Instance Definition hash does not match');
  return definition;
}

function resolveWorkflowAssignments(
  projection: CollaborationProjectionV3,
  instance: WorkflowInstance,
  machine: MachineDefinitionV3,
): void {
  for (const [stateId, state] of Object.entries(machine.states)) {
    if (state.terminal) continue;
    const resolved = instance.resolved_assignments[stateId];
    if (!resolved || !activeCollaborationMemberV3(projection, resolved))
      conflict(
        `Workflow State ${stateId} is not resolved to an active Principal`,
      );
    if (state.assignee?.type === 'principal') {
      if (state.assignee.principal_id !== resolved)
        conflict(
          `Workflow State ${stateId} direct Principal changed at launch`,
        );
    } else if (
      !state.assignee ||
      instance.participant_bindings[state.assignee.slot] !== resolved
    ) {
      conflict(`Workflow State ${stateId} participant slot is unresolved`);
    }
  }
}

function assertTurnFence(
  turn: CollaborationTurnV3,
  payload: { turn_id: string; attempt: number; fencing_token: string },
  event: CollaborationEventV3,
): void {
  if (
    turn.turn_id !== payload.turn_id ||
    turn.attempt !== payload.attempt ||
    turn.fencing_token !== payload.fencing_token
  )
    conflict('Turn attempt or fencing token is stale');
  if (
    turn.claimant_principal_id !== event.actor.principal_id ||
    turn.claimant_client_id !== event.actor.client_id
  )
    conflict('Turn event actor is not the fenced claimant Client');
}

function reduceGenesis(event: CollaborationEventV3): CollaborationProjectionV3 {
  if (
    event.event_type !== 'group_initialized' ||
    event.aggregate_type !== 'group' ||
    event.aggregate_id !== event.group_id
  )
    conflict('The first v3 event must initialize the Group Aggregate');
  const payload = genesisPayloadSchema.parse(event.payload);
  if (
    payload.group.group_id !== event.group_id ||
    payload.member.principal_id !== payload.group.owner_principal_id ||
    payload.client.principal_id !== payload.member.principal_id ||
    payload.owner_permissions.principal_id !== payload.member.principal_id ||
    payload.member.status !== 'active' ||
    payload.member.joined_at_event !== event.event_id ||
    payload.client.registered_at_event !== event.event_id ||
    event.actor.principal_id !== payload.member.principal_id ||
    event.actor.client_id !== payload.client.client_id
  )
    conflict('Genesis Group, Principal, Client, and actor must agree');
  const eventHash = collaborationEventHashV3(event);
  return {
    format: 'icarus.collaboration-projection/3',
    protocolVersion: 3,
    groupId: event.group_id,
    group: payload.group,
    aggregateHeads: {
      [projectionKey('group', event.group_id)]: {
        aggregateType: 'group',
        aggregateId: event.group_id,
        revision: 1,
        eventHash,
        eventId: event.event_id,
      },
    },
    members: { [payload.member.principal_id]: payload.member },
    clients: {
      [payload.member.principal_id]: {
        [payload.client.client_id]: payload.client,
      },
    },
    executors: {},
    permissionGrants: {
      [payload.member.principal_id]: payload.owner_permissions,
    },
    progressUpdates: {},
    files: {},
    fileLocations: {},
    actions: {},
    workItems: {},
    workItemUpdates: {},
    discussions: {},
    workflowDefinitions: {},
    latestWorkflowDefinitionVersions: {},
    workflowInstances: {},
    stateExecutions: {},
    turns: {},
    timeoutObservations: {},
    seenEventIds: [event.event_id],
    activity: [
      {
        eventId: event.event_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        aggregateRevision: event.aggregate_revision,
        eventType: event.event_type,
        actorPrincipalId: event.actor.principal_id,
        actorClientId: event.actor.client_id,
        occurredAt: event.occurred_at,
      },
    ],
    integrityStatus: 'OK',
    integrityMessage: null,
  };
}

export function reduceCollaborationEventV3(
  current: CollaborationProjectionV3 | null,
  input: unknown,
): CollaborationProjectionV3 {
  const event = validateCollaborationEventV3(input);
  assertAggregateChain(current, event);
  if (!current) return reduceGenesis(event);
  if (current.integrityStatus !== 'OK')
    conflict('Quarantined projections cannot accept events');
  if (event.group_id !== current.groupId) conflict('Event Group id changed');
  if (current.seenEventIds.includes(event.event_id))
    conflict(`Duplicate event id: ${event.event_id}`);
  if (
    current.group.lifecycle === 'archived' &&
    event.event_type !== 'group_reopened'
  )
    conflict('Archived Groups reject business writes');
  if (
    event.event_type !== 'membership_requested' &&
    event.event_type !== 'member_registered' &&
    event.event_type !== 'client_registered'
  )
    assertMemberAndClient(current, event);

  const next = structuredClone(current);
  const payload = parseCollaborationEventPayloadV3(event);

  switch (event.event_type) {
    case 'group_initialized':
      conflict('Group is already initialized');
    case 'group_settings_updated': {
      if (
        event.actor.principal_id !== next.group.owner_principal_id &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'group:admin',
        )
      )
        conflict('Only Owner/Admin may update Group settings');
      const parsed = groupSettingsPayloadSchema.parse(payload);
      next.group = groupDefinitionV3Schema.parse({
        ...next.group,
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.membership_policy
          ? { membership_policy: parsed.membership_policy }
          : {}),
        ...(parsed.visibility_policy
          ? { visibility_policy: parsed.visibility_policy }
          : {}),
      });
      break;
    }
    case 'group_archived':
    case 'group_reopened': {
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'group:archive',
        )
      )
        conflict('Actor cannot change Group lifecycle');
      const archive = event.event_type === 'group_archived';
      if ((next.group.lifecycle === 'archived') === archive)
        conflict('Group lifecycle transition is redundant');
      next.group = groupDefinitionV3Schema.parse({
        ...next.group,
        lifecycle: archive ? 'archived' : 'active',
        archived_at: archive ? event.occurred_at : null,
      });
      break;
    }
    case 'membership_requested': {
      const { member } = memberPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'membership' ||
        event.aggregate_id !== member.principal_id
      )
        conflict('Membership event Aggregate does not match Principal');
      if (
        member.principal_id !== event.actor.principal_id ||
        member.status !== 'requested' ||
        member.joined_at_event !== null
      )
        conflict('Membership request must be self-signed and pending');
      if (next.group.membership_policy.join === 'open')
        conflict('Open Groups register members directly');
      next.members[member.principal_id] = member;
      break;
    }
    case 'membership_rejected': {
      const { principal_id: principalId } =
        principalPayloadSchema.parse(payload);
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'member:approve',
        )
      )
        conflict('Actor cannot reject membership requests');
      const member = next.members[principalId];
      if (!member || member.status !== 'requested')
        conflict('Membership request is not pending');
      member.status = 'rejected';
      break;
    }
    case 'member_registered': {
      const { member } = memberPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'membership' ||
        event.aggregate_id !== member.principal_id
      )
        conflict('Member Aggregate does not match Principal');
      const selfOpen =
        next.group.membership_policy.join === 'open' &&
        event.actor.principal_id === member.principal_id;
      const approved = hasCollaborationPermissionV3(
        next,
        event.actor.principal_id,
        'member:approve',
      );
      if (!selfOpen && !approved)
        conflict('Membership policy requires an authorized approval');
      if (
        member.status !== 'active' ||
        member.joined_at_event !== event.event_id
      )
        conflict('Registered member must be active and reference this event');
      next.members[member.principal_id] = member;
      break;
    }
    case 'member_suspended':
    case 'member_reactivated':
    case 'member_removed': {
      const { principal_id: principalId } =
        principalPayloadSchema.parse(payload);
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'group:admin',
        )
      )
        conflict('Actor cannot change Membership status');
      if (principalId === next.group.owner_principal_id)
        conflict('The Group Owner Membership cannot be disabled');
      const member = next.members[principalId];
      if (!member) conflict('Member does not exist');
      member.status =
        event.event_type === 'member_suspended'
          ? 'suspended'
          : event.event_type === 'member_removed'
            ? 'removed'
            : 'active';
      break;
    }
    case 'client_registered': {
      const { client } = clientPayloadSchema.parse(payload);
      if (
        client.principal_id !== event.actor.principal_id ||
        event.aggregate_type !== 'membership' ||
        event.aggregate_id !== client.principal_id
      )
        conflict('A Principal may only register its own Client');
      (next.clients[client.principal_id] ??= {})[client.client_id] = client;
      break;
    }
    case 'client_revoked': {
      const { client_id: clientId } = clientIdPayloadSchema.parse(payload);
      const client = next.clients[event.actor.principal_id]?.[clientId];
      if (!client) conflict('Client does not exist for actor Principal');
      client.status = 'revoked';
      break;
    }
    case 'executor_registered': {
      const { executor } = executorPayloadSchema.parse(payload);
      if (executor.principal_id !== event.actor.principal_id)
        conflict('A Principal may only register its own Executor descriptor');
      (next.executors[executor.principal_id] ??= {})[executor.executor_id] =
        executor;
      break;
    }
    case 'executor_revoked': {
      const { executor_id: executorId } =
        executorIdPayloadSchema.parse(payload);
      if (!next.executors[event.actor.principal_id]?.[executorId])
        conflict('Executor does not exist for actor Principal');
      delete next.executors[event.actor.principal_id]![executorId];
      break;
    }
    case 'permission_granted':
    case 'permission_revoked': {
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'permission:grant',
        )
      )
        conflict('Actor cannot change direct permission grants');
      const { grant } = grantPayloadSchema.parse(payload);
      if (grant.principal_id === next.group.owner_principal_id)
        conflict(
          'Owner authority is intrinsic and cannot be rewritten as grants',
        );
      if (
        grant.principal_id === event.actor.principal_id &&
        grant.grants.some((value) =>
          ['group:admin', 'permission:grant'].includes(value),
        )
      )
        conflict('Grant authority cannot self-elevate');
      next.permissionGrants[grant.principal_id] = grant;
      break;
    }
    case 'progress_update_posted': {
      const { update } = progressPayloadSchema.parse(payload);
      if (
        update.principal_id !== event.actor.principal_id ||
        update.actor_client_id !== event.actor.client_id ||
        event.aggregate_type !== 'workspace' ||
        event.aggregate_id !== update.principal_id
      )
        conflict(
          'Progress update must be published in the actor Principal space',
        );
      next.progressUpdates[update.update_id] = update;
      break;
    }
    case 'shared_file_published':
    case 'shared_file_revised':
    case 'principal_file_published': {
      const { metadata } = filePayloadSchema.parse(payload);
      if (
        metadata.uploader_principal_id !== event.actor.principal_id ||
        metadata.uploader_client_id !== event.actor.client_id
      )
        conflict('File uploader identity does not match event actor');
      if (
        event.event_type.startsWith('shared_') &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workspace:write_shared',
        )
      )
        conflict('Actor cannot write the shared Workspace');
      if (
        event.event_type === 'principal_file_published' &&
        event.aggregate_id !== event.actor.principal_id
      )
        conflict('Principal file must use the actor Workspace Aggregate');
      if (
        event.event_type.startsWith('shared_') &&
        event.aggregate_id !== 'shared'
      )
        conflict('Shared file must use the shared Workspace Aggregate');
      const previous = next.files[metadata.file_id];
      if (event.event_type === 'shared_file_revised') {
        if (!previous || metadata.revision !== previous.revision + 1)
          conflict('Shared file revision is stale or missing');
      } else if (previous) {
        conflict('Published file id already exists');
      }
      next.files[metadata.file_id] = metadata;
      const shared = event.event_type.startsWith('shared_');
      next.fileLocations[metadata.file_id] = {
        scope: shared ? 'shared' : 'principal',
        principalId: shared ? null : event.actor.principal_id,
        repositoryDirectory: shared
          ? `workspace/shared/documents/${metadata.file_id}`
          : `workspace/principals/${event.actor.principal_id}/files/${metadata.file_id}`,
      };
      break;
    }
    case 'action_published':
    case 'action_revised': {
      const { action } = actionPayloadSchema.parse(payload);
      if (
        action.owner_principal_id !== event.actor.principal_id ||
        !action.prompt_ref.startsWith(
          `workspace/principals/${event.actor.principal_id}/automations/prompts/`,
        )
      )
        conflict('Principal Automation must remain in the actor-owned library');
      next.actions[`${action.owner_principal_id}:${action.action_id}`] = action;
      break;
    }
    case 'work_item_created':
    case 'work_item_details_updated': {
      const { item } = workItemPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'work_item' ||
        event.aggregate_id !== item.work_item_id
      )
        conflict('Work Item event Aggregate does not match item id');
      if (item.revision !== event.aggregate_revision)
        conflict('Work Item revision must match Aggregate revision');
      if (event.event_type === 'work_item_created') {
        if (next.workItems[item.work_item_id])
          conflict('Work Item already exists');
        if (
          item.creator_principal_id !== event.actor.principal_id ||
          !hasCollaborationPermissionV3(
            next,
            event.actor.principal_id,
            'work_item:create',
          )
        )
          conflict('Actor cannot create this Work Item');
        if (event.actor.executor_id && item.status !== 'proposed')
          conflict('Agent-created Work Items default to proposed');
        if (
          !event.actor.executor_id &&
          !['proposed', 'open'].includes(item.status)
        )
          conflict('A new human Work Item must start proposed or open');
        for (const ref of [
          ...(item.parent_id ? [item.parent_id] : []),
          ...item.blocked_by,
          ...item.related_items,
        ])
          if (!next.workItems[ref])
            conflict(`Related Work Item does not exist: ${ref}`);
      } else {
        const previous = next.workItems[item.work_item_id];
        if (!previous) conflict('Work Item does not exist');
        if (!canManageWorkItem(next, event.actor.principal_id, previous))
          conflict('Actor cannot update this Work Item');
        if (
          item.creator_principal_id !== previous.creator_principal_id ||
          item.created_at !== previous.created_at ||
          item.owner_principal_id !== previous.owner_principal_id ||
          item.status !== previous.status ||
          item.assignment_status !== previous.assignment_status ||
          item.primary_workflow_instance_id !==
            previous.primary_workflow_instance_id ||
          item.closed_at !== previous.closed_at ||
          item.archived !== previous.archived
        )
          conflict('Work Item details cannot rewrite lifecycle or ownership');
      }
      assertActivePrincipals(next, [
        item.owner_principal_id,
        ...item.contributors,
        ...item.watchers,
      ]);
      next.workItems[item.work_item_id] = item;
      break;
    }
    case 'work_item_assignment_changed': {
      const item = next.workItems[event.aggregate_id];
      if (!item) conflict('Work Item does not exist');
      if (!canManageWorkItem(next, event.actor.principal_id, item))
        conflict('Actor cannot reassign this Work Item');
      const parsed = workItemAssignmentPayloadSchema.parse(payload);
      assertActivePrincipals(next, [parsed.owner_principal_id]);
      item.owner_principal_id = parsed.owner_principal_id;
      item.preferred_executor_id = parsed.preferred_executor_id;
      item.assignment_status = parsed.assignment_status;
      item.revision = event.aggregate_revision;
      item.updated_at = event.occurred_at;
      break;
    }
    case 'work_item_assignment_acknowledged':
    case 'work_item_assignment_declined': {
      const item = next.workItems[event.aggregate_id];
      if (!item || item.owner_principal_id !== event.actor.principal_id)
        conflict('Only the current Work Item owner may answer assignment');
      item.assignment_status =
        event.event_type === 'work_item_assignment_acknowledged'
          ? 'accepted'
          : 'declined';
      item.revision = event.aggregate_revision;
      item.updated_at = event.occurred_at;
      break;
    }
    case 'work_item_status_changed': {
      const item = next.workItems[event.aggregate_id];
      if (!item) conflict('Work Item does not exist');
      if (!canManageWorkItem(next, event.actor.principal_id, item))
        conflict('Actor cannot change this Work Item status');
      const { status, closed_at: closedAt } =
        workItemStatusPayloadSchema.parse(payload);
      if (!WORK_ITEM_TRANSITIONS[item.status]?.includes(status))
        conflict(`Invalid Work Item transition: ${item.status} -> ${status}`);
      const primaryInstance = item.primary_workflow_instance_id
        ? next.workflowInstances[item.primary_workflow_instance_id]
        : null;
      if (
        status === 'done' &&
        primaryInstance &&
        primaryInstance.lifecycle !== 'closed'
      )
        conflict('An active primary Workflow owns Work Item completion');
      item.status = status;
      item.closed_at = closedAt;
      item.updated_at = event.occurred_at;
      item.revision = event.aggregate_revision;
      break;
    }
    case 'work_item_progress_posted': {
      const { update } = workItemProgressPayloadSchema.parse(payload);
      const item = next.workItems[event.aggregate_id];
      if (update.work_item_id !== event.aggregate_id || !item)
        conflict('Work Item progress references a missing or different item');
      if (
        update.actor_principal_id !== event.actor.principal_id ||
        update.actor_client_id !== event.actor.client_id ||
        !canContributeToWorkItem(next, event.actor.principal_id, item)
      )
        conflict('Actor cannot post progress to this Work Item');
      (next.workItemUpdates[event.aggregate_id] ??= []).push(update);
      item.revision = event.aggregate_revision;
      item.updated_at = event.occurred_at;
      break;
    }
    case 'work_item_relation_changed': {
      const item = next.workItems[event.aggregate_id];
      if (!item) conflict('Work Item does not exist');
      if (!canManageWorkItem(next, event.actor.principal_id, item))
        conflict('Actor cannot change this Work Item relations');
      const relations = workItemRelationPayloadSchema.parse(payload);
      for (const ref of [
        ...(relations.parent_id ? [relations.parent_id] : []),
        ...relations.blocked_by,
        ...relations.related_items,
      ])
        if (!next.workItems[ref])
          conflict(`Related Work Item does not exist: ${ref}`);
      item.parent_id = relations.parent_id;
      item.blocked_by = relations.blocked_by;
      item.related_items = relations.related_items;
      item.revision = event.aggregate_revision;
      item.updated_at = event.occurred_at;
      break;
    }
    case 'work_item_archived': {
      const item = next.workItems[event.aggregate_id];
      if (!item) conflict('Work Item does not exist');
      if (!canManageWorkItem(next, event.actor.principal_id, item))
        conflict('Actor cannot archive this Work Item');
      item.archived = true;
      item.revision = event.aggregate_revision;
      item.updated_at = event.occurred_at;
      break;
    }
    case 'discussion_created': {
      const { discussion } = discussionPayloadSchema.parse(payload);
      if (
        discussion.thread_id !== event.aggregate_id ||
        discussion.revision !== 1 ||
        next.discussions[discussion.thread_id]
      )
        conflict('Discussion genesis is invalid');
      if (
        discussion.created_by !== event.actor.principal_id ||
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'discussion:create',
        )
      )
        conflict('Actor cannot create this Discussion');
      if (
        (discussion.scope.type === 'work_item' &&
          !next.workItems[discussion.scope.ref]) ||
        (discussion.scope.type === 'workflow_instance' &&
          !next.workflowInstances[discussion.scope.ref]) ||
        (discussion.scope.type === 'turn' && !next.turns[discussion.scope.ref])
      )
        conflict('Discussion scope does not exist');
      next.discussions[discussion.thread_id] = { discussion, messages: {} };
      break;
    }
    case 'message_posted':
    case 'message_revised': {
      const thread = next.discussions[event.aggregate_id];
      const { message } = messagePayloadSchema.parse(payload);
      if (!thread || message.thread_id !== event.aggregate_id)
        conflict('Message Discussion does not exist');
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'discussion:post',
        )
      )
        conflict('Actor cannot post to Discussions');
      if (thread.discussion.status !== 'open')
        conflict('Resolved Discussions do not accept messages');
      if (
        message.author_principal_id !== event.actor.principal_id ||
        message.actor_client_id !== event.actor.client_id
      )
        conflict('Message author does not match actor');
      const previous = thread.messages[message.message_id];
      if (event.event_type === 'message_posted' && previous)
        conflict('Message already exists');
      if (
        event.event_type === 'message_revised' &&
        (!previous || message.revision !== previous.revision + 1)
      )
        conflict('Message revision is stale');
      if (
        event.event_type === 'message_revised' &&
        previous?.author_principal_id !== event.actor.principal_id
      )
        conflict('Only the message author may revise it');
      assertActivePrincipals(next, message.mentions);
      thread.messages[message.message_id] = message;
      thread.discussion.revision = event.aggregate_revision;
      break;
    }
    case 'message_tombstoned': {
      const thread = next.discussions[event.aggregate_id];
      const { message_id: messageId } = messageIdPayloadSchema.parse(payload);
      const message = thread?.messages[messageId];
      if (!thread || !message) conflict('Message does not exist');
      if (
        message.author_principal_id !== event.actor.principal_id &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'discussion:moderate',
        )
      )
        conflict('Only the author or a moderator may tombstone a message');
      message.tombstoned = true;
      message.body = '';
      message.revision += 1;
      message.updated_at = event.occurred_at;
      thread.discussion.revision = event.aggregate_revision;
      break;
    }
    case 'discussion_resolved':
    case 'discussion_reopened': {
      const thread = next.discussions[event.aggregate_id];
      if (!thread) conflict('Discussion does not exist');
      if (
        thread.discussion.created_by !== event.actor.principal_id &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'discussion:moderate',
        )
      )
        conflict('Actor cannot resolve or reopen this Discussion');
      thread.discussion.status =
        event.event_type === 'discussion_resolved' ? 'resolved' : 'open';
      thread.discussion.resolved_at =
        event.event_type === 'discussion_resolved' ? event.occurred_at : null;
      thread.discussion.revision = event.aggregate_revision;
      break;
    }
    case 'workflow_definition_proposed':
    case 'workflow_definition_published': {
      const parsed = workflowDefinitionPayloadSchema.parse(payload);
      const { definition, machine, layout } = parsed;
      if (
        definition.definition_id !== event.aggregate_id ||
        definition.revision !== event.aggregate_revision ||
        definition.machine_hash !== collaborationCanonicalHashV3(machine) ||
        definition.layout_hash !== collaborationCanonicalHashV3(layout)
      )
        conflict('Workflow Definition hashes or revision do not match');
      const expectedStatus =
        event.event_type === 'workflow_definition_published'
          ? 'published'
          : 'proposed';
      if (definition.status !== expectedStatus)
        conflict(`Workflow Definition must be ${expectedStatus}`);
      if (
        expectedStatus === 'published' &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workflow_definition:publish',
        )
      )
        conflict('Actor cannot publish Workflow Definitions');
      const key = workflowDefinitionVersionKey(
        definition.definition_id,
        definition.version,
      );
      if (next.workflowDefinitions[key]?.definition.status === 'published')
        conflict('Published Workflow Definition versions are immutable');
      next.workflowDefinitions[key] = { definition, machine, layout };
      next.latestWorkflowDefinitionVersions[definition.definition_id] =
        Math.max(
          definition.version,
          next.latestWorkflowDefinitionVersions[definition.definition_id] ?? 0,
        );
      break;
    }
    case 'workflow_definition_retired': {
      const version = next.latestWorkflowDefinitionVersions[event.aggregate_id];
      const definition = version
        ? next.workflowDefinitions[
            workflowDefinitionVersionKey(event.aggregate_id, version)
          ]
        : null;
      if (!definition || definition.definition.status !== 'published')
        conflict('Published Workflow Definition does not exist');
      definition.definition.status = 'retired';
      definition.definition.revision = event.aggregate_revision;
      definition.definition.updated_at = event.occurred_at;
      break;
    }
    case 'workflow_layout_updated': {
      const parsed = workflowLayoutPayloadSchema.parse(payload);
      const definition =
        next.workflowDefinitions[
          workflowDefinitionVersionKey(parsed.definition_id, parsed.version)
        ];
      if (!definition || parsed.definition_id !== event.aggregate_id)
        conflict('Workflow Definition does not exist');
      if (parsed.layout_hash !== collaborationCanonicalHashV3(parsed.layout))
        conflict('Workflow layout hash does not match');
      definition.layout = parsed.layout;
      definition.definition.layout_hash = parsed.layout_hash;
      definition.definition.revision = event.aggregate_revision;
      definition.definition.updated_at = event.occurred_at;
      break;
    }
    case 'workflow_instance_created': {
      const { instance } = workflowInstancePayloadSchema.parse(payload);
      if (
        instance.instance_id !== event.aggregate_id ||
        instance.revision !== 1 ||
        next.workflowInstances[instance.instance_id]
      )
        conflict('Workflow Instance genesis is invalid');
      const definition = activeDefinition(next, instance);
      if (instance.business_state !== definition.machine.initial_state)
        conflict(
          'Workflow Instance must start at the Definition initial State',
        );
      resolveWorkflowAssignments(next, instance, definition.machine);
      if (
        instance.scope.type === 'work_item' &&
        !next.workItems[instance.scope.work_item_id]
      )
        conflict('Workflow Instance Work Item scope does not exist');
      next.workflowInstances[instance.instance_id] = instance;
      break;
    }
    case 'workflow_instance_started':
    case 'workflow_instance_paused':
    case 'workflow_instance_resumed':
    case 'workflow_instance_closed': {
      const instance = next.workflowInstances[event.aggregate_id];
      if (!instance) conflict('Workflow Instance does not exist');
      const transitions: Record<string, readonly string[]> = {
        workflow_instance_started: ['ready'],
        workflow_instance_paused: ['running', 'pausing'],
        workflow_instance_resumed: ['paused'],
        workflow_instance_closed: ['running', 'paused', 'closing'],
      };
      if (!transitions[event.event_type]!.includes(instance.lifecycle))
        conflict(`Invalid Workflow Instance lifecycle transition`);
      instance.lifecycle =
        event.event_type === 'workflow_instance_started'
          ? 'running'
          : event.event_type === 'workflow_instance_paused'
            ? 'paused'
            : event.event_type === 'workflow_instance_resumed'
              ? 'running'
              : 'closed';
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'workflow_state_assignee_changed': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = assigneePayloadSchema.parse(payload);
      if (!instance || !activeCollaborationMemberV3(next, parsed.principal_id))
        conflict('Workflow Instance or assignee does not exist');
      if (
        instance.business_state === parsed.state_id &&
        instance.active_turn_id !== null
      )
        conflict(
          'Current State must cancel/recover its Turn before reassignment',
        );
      instance.resolved_assignments[parsed.state_id] = parsed.principal_id;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'state_execution_published':
    case 'state_execution_revised': {
      const instance = next.workflowInstances[event.aggregate_id];
      const { execution } = stateExecutionPayloadSchema.parse(payload);
      if (
        !instance ||
        execution.instance_id !== instance.instance_id ||
        execution.principal_id !== event.actor.principal_id ||
        instance.resolved_assignments[execution.state_id] !==
          event.actor.principal_id
      )
        conflict('Only the resolved Principal may configure State Execution');
      if (execution.action_ref) {
        const action =
          next.actions[
            `${event.actor.principal_id}:${
              execution.action_ref
                .split('/')
                .at(-1)
                ?.replace(/\.json$/u, '') ?? ''
            }`
          ];
        const exact = Object.values(next.actions).find(
          (candidate) =>
            candidate.owner_principal_id === event.actor.principal_id &&
            execution.action_ref?.endsWith(`/${candidate.action_id}.json`),
        );
        if (!action && !exact)
          conflict('State Execution Action is not Principal-owned');
      }
      (next.stateExecutions[instance.instance_id] ??= {})[execution.state_id] =
        execution;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'state_execution_withdrawn': {
      const instance = next.workflowInstances[event.aggregate_id];
      const { state_id: stateId } =
        stateExecutionWithdrawalPayloadSchema.parse(payload);
      if (
        !instance ||
        instance.resolved_assignments[stateId] !== event.actor.principal_id
      )
        conflict('Only the resolved Principal may withdraw State Execution');
      delete next.stateExecutions[instance.instance_id]?.[stateId];
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'turn_created': {
      const instance = next.workflowInstances[event.aggregate_id];
      const { turn } = turnPayloadSchema.parse(payload);
      if (
        !instance ||
        turn.workflow_instance_id !== instance.instance_id ||
        turn.state_id !== instance.business_state ||
        turn.assignee_principal_id !==
          instance.resolved_assignments[instance.business_state] ||
        instance.active_turn_id ||
        next.turns[turn.turn_id]
      )
        conflict('Turn does not match the active Workflow Instance State');
      const execution =
        next.stateExecutions[instance.instance_id]?.[instance.business_state];
      if (!execution && turn.execution_mode !== 'manual')
        conflict('Missing State Execution must create a manual Turn');
      if (
        execution &&
        (turn.execution_mode !== execution.mode ||
          turn.action_hash !== execution.action_hash ||
          turn.prompt_hash !== execution.prompt_hash)
      )
        conflict('Turn does not snapshot current Principal State Execution');
      next.turns[turn.turn_id] = turn;
      instance.active_turn_id = turn.turn_id;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'turn_started': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = turnStartedPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (
        !instance ||
        instance.active_turn_id !== parsed.turn_id ||
        !turn ||
        turn.state !== 'pending' ||
        turn.assignee_principal_id !== event.actor.principal_id
      )
        conflict('Turn is not claimable by this Principal');
      const expectedFence = collaborationFencingTokenV3({
        groupId: next.groupId,
        instanceId: instance.instance_id,
        epoch: instance.epoch,
        turnId: turn.turn_id,
        attempt: turn.attempt,
        claimantClientId: event.actor.client_id,
        claimEventId: event.event_id,
        expectedRevision: event.aggregate_revision - 1,
      });
      if (parsed.fencing_token !== expectedFence)
        conflict('Turn fencing token is invalid');
      turn.claimant_principal_id = event.actor.principal_id;
      turn.claimant_client_id = event.actor.client_id;
      turn.executor_id = parsed.executor_id;
      turn.fencing_token = parsed.fencing_token;
      turn.execution_deadline_at = parsed.execution_deadline_at;
      turn.deadline_snapshot_hash = parsed.deadline_snapshot_hash;
      turn.started_at = event.occurred_at;
      turn.state = 'running';
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'action_dispatched':
    case 'action_waiting_input':
    case 'action_waiting_approval':
    case 'action_completed': {
      const parsed = (
        event.event_type === 'action_dispatched'
          ? actionDispatchedPayloadSchema
          : event.event_type === 'action_completed'
            ? actionCompletedPayloadSchema
            : turnFencePayloadSchema
      ).parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!turn) conflict('Turn does not exist');
      assertTurnFence(turn, parsed, event);
      turn.state =
        event.event_type === 'action_waiting_input'
          ? 'waiting_input'
          : event.event_type === 'action_waiting_approval'
            ? 'waiting_approval'
            : 'running';
      next.workflowInstances[event.aggregate_id]!.revision =
        event.aggregate_revision;
      next.workflowInstances[event.aggregate_id]!.updated_at =
        event.occurred_at;
      break;
    }
    case 'turn_timeout_observed': {
      const parsed = timeoutObservedPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!turn || turn.attempt !== parsed.attempt)
        conflict('Timeout observation references a stale Turn attempt');
      if (
        (parsed.deadline_kind === 'start'
          ? turn.start_deadline_at
          : turn.execution_deadline_at) !== parsed.deadline_at
      )
        conflict('Timeout observation deadline does not match Turn snapshot');
      (next.timeoutObservations[turn.turn_id] ??= []).push({
        attempt: parsed.attempt,
        deadlineKind: parsed.deadline_kind,
        deadlineAt: parsed.deadline_at,
        observedAt: parsed.observed_at,
        eventId: event.event_id,
      });
      next.workflowInstances[event.aggregate_id]!.revision =
        event.aggregate_revision;
      next.workflowInstances[event.aggregate_id]!.updated_at =
        event.occurred_at;
      break;
    }
    case 'turn_completed': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = turnCompletedPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!instance || !turn) conflict('Turn does not exist');
      assertTurnFence(turn, parsed, event);
      const definition = activeDefinition(next, instance);
      const transition = definition.machine.states[
        turn.state_id
      ]?.transitions.find((candidate) => candidate.outcome === parsed.outcome);
      if (!transition)
        conflict('Turn Outcome is not allowed by the Workflow State');
      if (
        parsed.handoff.source_turn_id !== turn.turn_id ||
        parsed.handoff.outcome !== parsed.outcome ||
        parsed.handoff_hash !== collaborationCanonicalHashV3(parsed.handoff)
      )
        conflict('Turn Handoff does not match its Outcome or hash');
      turn.state = 'completed';
      turn.completed_at = event.occurred_at;
      turn.outcome = parsed.outcome;
      turn.handoff = parsed.handoff;
      turn.handoff_hash = parsed.handoff_hash;
      instance.business_state = transition.target_state;
      instance.active_turn_id = null;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      if (definition.machine.states[transition.target_state]?.terminal)
        instance.lifecycle = 'closed';
      break;
    }
    case 'turn_cancelled': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = turnCancelledPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!instance || !turn || turn.attempt !== parsed.attempt)
        conflict('Turn cancellation references a stale attempt');
      if (
        turn.fencing_token &&
        (turn.fencing_token !== parsed.fencing_token ||
          turn.claimant_principal_id !== event.actor.principal_id ||
          turn.claimant_client_id !== event.actor.client_id) &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workflow_instance:manage_all',
        )
      )
        conflict('Only claimant or Instance authority may cancel a Turn');
      turn.state = 'cancelled';
      turn.completed_at = event.occurred_at;
      turn.recovery_reason = parsed.reason;
      instance.active_turn_id = null;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'turn_recovery_requested': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = recoveryPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!instance || !turn || turn.attempt !== parsed.attempt)
        conflict('Turn recovery references a stale attempt');
      turn.state = 'recovery_required';
      turn.recovery_reason = parsed.reason;
      instance.lifecycle = 'recovery_required';
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'turn_recovered': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = turnRecoveredPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (
        !instance ||
        !turn ||
        turn.state !== 'recovery_required' ||
        parsed.previous_attempt !== turn.attempt ||
        parsed.next_attempt !== turn.attempt + 1
      )
        conflict('Turn recovery attempt is invalid');
      turn.attempt = parsed.next_attempt;
      turn.state = 'pending';
      turn.claimant_principal_id = null;
      turn.claimant_client_id = null;
      turn.executor_id = null;
      turn.fencing_token = null;
      turn.start_deadline_at = parsed.start_deadline_at;
      turn.execution_deadline_at = null;
      turn.deadline_snapshot_hash = parsed.deadline_snapshot_hash;
      turn.started_at = null;
      turn.completed_at = null;
      turn.recovery_reason = null;
      instance.lifecycle = 'running';
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
  }

  const eventHash = collaborationEventHashV3(event);
  next.aggregateHeads[projectionKey(event.aggregate_type, event.aggregate_id)] =
    {
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      revision: event.aggregate_revision,
      eventHash,
      eventId: event.event_id,
    };
  next.seenEventIds.push(event.event_id);
  next.activity.push({
    eventId: event.event_id,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    aggregateRevision: event.aggregate_revision,
    eventType: event.event_type,
    actorPrincipalId: event.actor.principal_id,
    actorClientId: event.actor.client_id,
    occurredAt: event.occurred_at,
  });
  return next;
}

export function reduceCollaborationEventsV3(
  events: readonly unknown[],
): CollaborationProjectionV3 {
  if (events.length === 0) conflict('Collaboration history is empty');
  let projection: CollaborationProjectionV3 | null = null;
  for (const event of events)
    projection = reduceCollaborationEventV3(projection, event);
  return projection!;
}

export function deterministicProjectionJsonV3(
  projection: CollaborationProjectionV3,
): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

export function buildCollaborationEventV3(input: {
  readonly groupId: string;
  readonly eventId: string;
  readonly aggregateType: CollaborationAggregateType;
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  readonly previousEventHash: string | null;
  readonly eventType: CollaborationEventTypeV3;
  readonly actor: CollaborationEventV3['actor'];
  readonly occurredAt: string;
  readonly causationId?: string | null;
  readonly correlationId?: string;
  readonly payload: Record<string, unknown>;
}): CollaborationEventV3 {
  return validateCollaborationEventV3({
    format: 'icarus.collaboration-event/3',
    protocol_version: 3,
    group_id: input.groupId,
    event_id: input.eventId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    aggregate_revision: input.aggregateRevision,
    previous_event_hash: input.previousEventHash,
    event_type: input.eventType,
    actor: input.actor,
    occurred_at: input.occurredAt,
    causation_id: input.causationId ?? null,
    correlation_id: input.correlationId ?? input.aggregateId,
    payload_hash: collaborationCanonicalHashV3(input.payload),
    payload: input.payload,
  });
}
