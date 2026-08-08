import crypto from 'node:crypto';

import { z } from 'zod';

import { canonicalJsonStringify } from './canonical-json.js';
import {
  actionDefinitionV3Schema,
  artifactMetadataV3Schema,
  clientDefinitionSchema,
  collaborationActionResultV3Schema,
  credentialDefinitionSchema,
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
  inviteDefinitionV3Schema,
  machineDefinitionV3Schema,
  memberDefinitionV3Schema,
  permissionGrantSchema,
  progressUpdateSchema,
  recoveryRequestSchema,
  stateExecutionSchema,
  workflowDefinitionSchema,
  workflowInstanceSchema,
  workflowLayoutSchema,
  workItemProgressSchema,
  workItemSchema,
  workItemStatusSchema,
  type ActionDefinitionV3,
  type ArtifactMetadataV3,
  type CollaborationActionResultV3,
  type ClientDefinition,
  type CredentialDefinition,
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
  type InviteDefinitionV3,
  type MachineDefinitionV3,
  type MemberDefinitionV3,
  type PermissionGrant,
  type ProgressUpdate,
  type RecoveryRequest,
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
  .object({
    member: memberDefinitionV3Schema,
    client: clientDefinitionSchema.optional(),
    credential: credentialDefinitionSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if ((payload.client === undefined) !== (payload.credential === undefined))
      context.addIssue({
        code: 'custom',
        message: 'Member registration Client and Credential are atomic',
      });
  });
const membershipRequestPayloadSchema = z
  .object({
    member: memberDefinitionV3Schema,
    client: clientDefinitionSchema,
    credential: credentialDefinitionSchema,
    invite_id: collaborationIdentifierSchema.nullable(),
  })
  .strict();
const invitePayloadSchema = z
  .object({ invite: inviteDefinitionV3Schema })
  .strict();
const credentialRotationPayloadSchema = z
  .object({
    credential: credentialDefinitionSchema,
    revoke_credential_id: credentialDefinitionSchema.shape.credential_id
      .nullable()
      .default(null),
  })
  .strict();
const credentialIdPayloadSchema = z
  .object({
    credential_id: credentialDefinitionSchema.shape.credential_id,
    reason: z.string().min(1).max(4000),
  })
  .strict();
const recoveryRequestPayloadSchema = z
  .object({ request: recoveryRequestSchema })
  .strict();
const recoveryDecisionPayloadSchema = z
  .object({
    request_hash: collaborationSha256Schema,
    reason: z.string().min(1).max(4000),
    revoke_previous_credentials: z.boolean().default(false),
    revoke_credential_ids: z
      .array(credentialDefinitionSchema.shape.credential_id)
      .max(1000)
      .default([]),
  })
  .strict()
  .refine(
    (decision) =>
      new Set(decision.revoke_credential_ids).size ===
      decision.revoke_credential_ids.length,
    'Credential revocation scope must be unique',
  );
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
    credential: credentialDefinitionSchema,
    recovery_credential: credentialDefinitionSchema,
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
  .object({
    update: workItemProgressSchema,
    artifacts: z.array(artifactMetadataV3Schema).max(20),
  })
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
  .extend({ result: collaborationActionResultV3Schema, result_hash: sha256 })
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
    result_hash: sha256.nullable(),
    completion_hash: sha256,
    handoff: handoffEnvelopeV3Schema,
    handoff_hash: sha256,
    artifact_refs: z.array(z.string()).max(100),
    artifacts: z.array(artifactMetadataV3Schema).max(20),
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
    epoch: z.number().int().positive(),
    attempt: z.number().int().positive(),
    fencing_token: sha256,
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
  invite_issued: invitePayloadSchema,
  invite_revoked: reasonPayloadSchema,
  membership_requested: membershipRequestPayloadSchema,
  membership_rejected: principalPayloadSchema,
  member_registered: memberPayloadSchema,
  member_suspended: principalPayloadSchema,
  member_reactivated: principalPayloadSchema,
  member_removed: principalPayloadSchema,
  client_revoked: clientIdPayloadSchema,
  credential_rotated: credentialRotationPayloadSchema,
  credential_revoked: credentialIdPayloadSchema,
  identity_recovery_requested: recoveryRequestPayloadSchema,
  owner_recovery_requested: recoveryRequestPayloadSchema,
  recovery_approved: recoveryDecisionPayloadSchema,
  recovery_rejected: recoveryDecisionPayloadSchema,
  recovery_expired: recoveryDecisionPayloadSchema,
  recovery_cancelled: recoveryDecisionPayloadSchema,
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
  invites: Record<string, InviteDefinitionV3>;
  members: Record<string, MemberDefinitionV3>;
  clients: Record<string, Record<string, ClientDefinition>>;
  credentials: Record<string, Record<string, CredentialDefinition>>;
  recoveryRequests: Record<string, RecoveryRequest>;
  executors: Record<string, Record<string, ExecutorDescriptor>>;
  permissionGrants: Record<string, PermissionGrant>;
  progressUpdates: Record<string, ProgressUpdate>;
  files: Record<string, FileMetadata>;
  artifacts: Record<string, ArtifactMetadataV3>;
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

export function collaborationRecoveryRequestHashV3(
  request: Omit<
    RecoveryRequest,
    | 'request_hash'
    | 'status'
    | 'decided_at_event'
    | 'decided_by_principal_id'
    | 'decision_reason'
    | 'approval_kind'
    | 'revoked_credential_ids'
  >,
): string {
  return collaborationCanonicalHashV3({
    format: request.format,
    request_id: request.request_id,
    type: request.type,
    target_principal_id: request.target_principal_id,
    requested_client: request.requested_client,
    requested_credential: request.requested_credential,
    reason: request.reason,
    created_at: request.created_at,
    expires_at: request.expires_at,
    ...(request.extensions ? { extensions: request.extensions } : {}),
  });
}

export function collaborationRecoveryVerificationCodeV3(
  requestHash: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`icarus-recovery-code\0${requestHash}`, 'utf8')
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function collaborationTurnCompletionHashV3(input: {
  readonly turnId: string;
  readonly attempt: number;
  readonly outcome: string;
  readonly resultHash: string | null;
  readonly handoffHash: string;
  readonly artifactRefs: readonly string[];
}): string {
  return collaborationCanonicalHashV3({
    turn_id: input.turnId,
    attempt: input.attempt,
    outcome: input.outcome,
    result_hash: input.resultHash,
    handoff_hash: input.handoffHash,
    artifact_refs: [...input.artifactRefs],
  });
}

export function collaborationAutomaticCompletionFactsV3(
  input: CollaborationActionResultV3,
): {
  readonly outcome: string;
  readonly summary: string;
  readonly instruction: string;
  readonly markers: readonly string[];
  readonly dataRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
} {
  const result = collaborationActionResultV3Schema.parse(input);
  return {
    outcome: result.outcome,
    summary: result.summary,
    instruction: result.instruction,
    markers: [...result.markers],
    dataRefs: [],
    artifactRefs: result.artifacts.map((artifact) => artifact.ref),
    data: { ...result.data },
  };
}

export function collaborationEventHashV3(event: CollaborationEventV3): string {
  return collaborationCanonicalHashV3(event);
}

export function collaborationWorkflowDefinitionHashV3(
  definition: WorkflowDefinition,
  machine: MachineDefinitionV3,
): string {
  return collaborationCanonicalHashV3({
    format: definition.format,
    definition_id: definition.definition_id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    created_by_principal_id: definition.created_by_principal_id,
    published_by_principal_id: definition.published_by_principal_id,
    launch_policy: definition.launch_policy,
    machine_ref: definition.machine_ref,
    machine_hash: definition.machine_hash,
    created_at: definition.created_at,
    machine,
  });
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

export function collaborationTurnInputHashV3(input: {
  readonly groupId: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly stateId: string;
  readonly assigneePrincipalId: string;
  readonly execution: StateExecution | null;
  readonly incomingHandoffHash: string | null;
  readonly workItem: WorkItem | null;
}): string {
  return collaborationCanonicalHashV3({
    group_id: input.groupId,
    instance_id: input.instanceId,
    epoch: input.epoch,
    state_id: input.stateId,
    assignee_principal_id: input.assigneePrincipalId,
    execution: input.execution,
    incoming_handoff_hash: input.incomingHandoffHash,
    work_item: input.workItem,
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
  const credential =
    projection.credentials[event.actor.principal_id]?.[
      event.actor.credential_id
    ];
  if (
    !credential ||
    credential.status !== 'active' ||
    credential.principal_id !== event.actor.principal_id ||
    credential.client_id !== event.actor.client_id
  )
    conflict(
      'Event actor Credential is not active for its Principal and Client',
    );
  if (
    credential.purpose === 'group_recovery' &&
    event.event_type === 'recovery_approved' &&
    event.actor.principal_id === projection.group.owner_principal_id
  )
    return;
  if (credential.purpose !== 'event_signing')
    conflict('This operation requires an event-signing Credential');
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

function assertWorkItemRelations(
  projection: CollaborationProjectionV3,
  workItemId: string,
  relations: Pick<WorkItem, 'parent_id' | 'blocked_by' | 'related_items'>,
): void {
  if (
    relations.parent_id === workItemId ||
    relations.blocked_by.includes(workItemId) ||
    relations.related_items.includes(workItemId)
  )
    conflict('A Work Item relation cannot reference itself');
  for (const [name, refs] of [
    ['blocked_by', relations.blocked_by],
    ['related_items', relations.related_items],
  ] as const)
    if (new Set(refs).size !== refs.length)
      conflict(`Work Item ${name} references must be unique`);
  for (const ref of [
    ...(relations.parent_id ? [relations.parent_id] : []),
    ...relations.blocked_by,
    ...relations.related_items,
  ])
    if (!projection.workItems[ref])
      conflict(`Related Work Item does not exist: ${ref}`);
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
  if (
    !definition ||
    !['published', 'retired'].includes(definition.definition.status)
  )
    conflict('Workflow Instance references a missing published Definition');
  if (
    collaborationWorkflowDefinitionHashV3(
      definition.definition,
      definition.machine,
    ) !== instance.definition_hash
  )
    conflict('Workflow Instance Definition hash does not match');
  return definition;
}

function validateWorkflowAssignments(
  projection: CollaborationProjectionV3,
  instance: WorkflowInstance,
  machine: MachineDefinitionV3,
  requireComplete: boolean,
): boolean {
  let complete = true;
  for (const [stateId, state] of Object.entries(machine.states)) {
    if (state.terminal) continue;
    const resolved = instance.resolved_assignments[stateId];
    if (!resolved) {
      complete = false;
      if (!requireComplete) continue;
      conflict(
        `Workflow State ${stateId} is not resolved to an active Principal`,
      );
    }
    if (!activeCollaborationMemberV3(projection, resolved))
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
      (instance.participant_bindings[state.assignee.slot] !== undefined &&
        instance.participant_bindings[state.assignee.slot] !== resolved)
    ) {
      conflict(`Workflow State ${stateId} participant slot is unresolved`);
    }
  }
  return complete;
}

function canLaunchWorkflow(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: WorkflowInstance,
  definition: WorkflowDefinition,
): boolean {
  if (
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'workflow_instance:start_allowed',
    ) ||
    definition.launch_policy.principals.includes(principalId)
  )
    return true;
  if (
    definition.launch_policy.group_admin &&
    hasCollaborationPermissionV3(projection, principalId, 'group:admin')
  )
    return true;
  if (
    definition.launch_policy.work_item_owner &&
    instance.scope.type === 'work_item'
  )
    return (
      projection.workItems[instance.scope.work_item_id]?.owner_principal_id ===
      principalId
    );
  return false;
}

function canManageWorkflowInstance(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: WorkflowInstance,
): boolean {
  return (
    instance.created_by_principal_id === principalId ||
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'workflow_instance:manage_all',
    ) ||
    instance.resolved_assignments[instance.business_state] === principalId
  );
}

export function canCreateWorkflowTurnV3(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: WorkflowInstance,
): boolean {
  return canManageWorkflowInstance(projection, principalId, instance);
}

function hasWorkflowInstanceAuthority(
  projection: CollaborationProjectionV3,
  principalId: string,
  instance: WorkflowInstance,
): boolean {
  return (
    instance.created_by_principal_id === principalId ||
    hasCollaborationPermissionV3(
      projection,
      principalId,
      'workflow_instance:manage_all',
    )
  );
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
    payload.credential.principal_id !== payload.member.principal_id ||
    payload.credential.client_id !== payload.client.client_id ||
    payload.credential.credential_id !== event.actor.credential_id ||
    payload.credential.purpose !== 'event_signing' ||
    payload.recovery_credential.principal_id !== payload.member.principal_id ||
    payload.recovery_credential.client_id !== payload.client.client_id ||
    payload.recovery_credential.purpose !== 'group_recovery' ||
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
    invites: {},
    members: { [payload.member.principal_id]: payload.member },
    clients: {
      [payload.member.principal_id]: {
        [payload.client.client_id]: payload.client,
      },
    },
    credentials: {
      [payload.member.principal_id]: {
        [payload.credential.credential_id]: payload.credential,
        [payload.recovery_credential.credential_id]:
          payload.recovery_credential,
      },
    },
    recoveryRequests: {},
    executors: {},
    permissionGrants: {
      [payload.member.principal_id]: payload.owner_permissions,
    },
    progressUpdates: {},
    files: {},
    artifacts: {},
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
    event.event_type !== 'identity_recovery_requested' &&
    event.event_type !== 'owner_recovery_requested' &&
    event.event_type !== 'recovery_cancelled' &&
    !(
      event.event_type === 'member_registered' &&
      event.actor.principal_id ===
        (event.payload.member as { principal_id?: unknown }).principal_id &&
      !current.members[event.actor.principal_id]
    )
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
    case 'invite_issued': {
      const { invite } = invitePayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'invite' ||
        event.aggregate_id !== invite.invite_id
      )
        conflict('Invite event Aggregate does not match Invite id');
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'member:approve',
        )
      )
        conflict('Actor is not authorized to issue Invites');
      if (
        invite.issued_by_principal_id !== event.actor.principal_id ||
        invite.issued_at !== event.occurred_at ||
        invite.status !== 'active' ||
        invite.used_at_event !== null ||
        invite.revoked_at_event !== null
      )
        conflict('Invite issuance provenance or lifecycle is invalid');
      if (next.invites[invite.invite_id]) conflict('Invite already exists');
      next.invites[invite.invite_id] = invite;
      break;
    }
    case 'invite_revoked': {
      reasonPayloadSchema.parse(payload);
      if (event.aggregate_type !== 'invite')
        conflict('Invite revocation must use the Invite Aggregate');
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'member:approve',
        )
      )
        conflict('Actor is not authorized to revoke Invites');
      const invite = next.invites[event.aggregate_id];
      if (!invite) conflict('Invite does not exist');
      if (invite.status !== 'active')
        conflict('Only an active Invite may be revoked');
      next.invites[event.aggregate_id] = inviteDefinitionV3Schema.parse({
        ...invite,
        status: 'revoked',
        revoked_at_event: event.event_id,
      });
      break;
    }
    case 'membership_requested': {
      const {
        member,
        client,
        credential,
        invite_id: inviteId,
      } = membershipRequestPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'membership' ||
        event.aggregate_id !== member.principal_id
      )
        conflict('Membership event Aggregate does not match Principal');
      if (
        member.principal_id !== event.actor.principal_id ||
        client.principal_id !== member.principal_id ||
        credential.principal_id !== member.principal_id ||
        credential.client_id !== client.client_id ||
        credential.credential_id !== event.actor.credential_id ||
        event.actor.client_id !== client.client_id ||
        credential.purpose !== 'event_signing' ||
        credential.status !== 'active' ||
        credential.created_at_event !== event.event_id ||
        client.registered_at_event !== event.event_id ||
        member.status !== 'requested' ||
        member.joined_at_event !== null
      )
        conflict('Membership request must be self-signed and pending');
      if (next.group.membership_policy.join === 'open')
        conflict('Open Groups register members directly');
      if (next.group.membership_policy.join === 'approval') {
        if (inviteId !== null)
          conflict('Approval membership requests cannot reference an Invite');
      } else {
        if (inviteId === null)
          conflict('Invite-only membership requires an Invite');
        const invite = next.invites[inviteId];
        if (!invite) conflict('Invite does not exist');
        if (invite.status !== 'active')
          conflict('Invite is not active and cannot be reused');
        if (
          invite.expires_at !== null &&
          Date.parse(invite.expires_at) <= Date.parse(event.occurred_at)
        )
          conflict('Invite has expired');
        next.invites[inviteId] = inviteDefinitionV3Schema.parse({
          ...invite,
          status: 'used',
          used_at_event: event.event_id,
        });
      }
      const existingMember = next.members[member.principal_id];
      if (existingMember && existingMember.status !== 'rejected')
        conflict('Principal already has an existing Membership');
      next.members[member.principal_id] = member;
      (next.clients[member.principal_id] ??= {})[client.client_id] = client;
      (next.credentials[member.principal_id] ??= {})[credential.credential_id] =
        credential;
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
      const { member, client, credential } = memberPayloadSchema.parse(payload);
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
      if (selfOpen) {
        if (
          !client ||
          !credential ||
          client.principal_id !== member.principal_id ||
          credential.principal_id !== member.principal_id ||
          credential.client_id !== client.client_id ||
          event.actor.client_id !== client.client_id ||
          event.actor.credential_id !== credential.credential_id ||
          client.registered_at_event !== event.event_id ||
          credential.created_at_event !== event.event_id ||
          credential.purpose !== 'event_signing' ||
          credential.status !== 'active'
        )
          conflict(
            'Open membership registration must atomically bind its Client and Credential',
          );
        (next.clients[member.principal_id] ??= {})[client.client_id] = client;
        (next.credentials[member.principal_id] ??= {})[
          credential.credential_id
        ] = credential;
      } else if (client || credential) {
        conflict(
          'Approved Membership must use its requested Client and Credential',
        );
      }
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
    case 'client_revoked': {
      const { client_id: clientId } = clientIdPayloadSchema.parse(payload);
      const client = next.clients[event.actor.principal_id]?.[clientId];
      if (!client) conflict('Client does not exist for actor Principal');
      client.status = 'revoked';
      for (const credential of Object.values(
        next.credentials[event.actor.principal_id] ?? {},
      ))
        if (
          credential.client_id === clientId &&
          credential.status === 'active' &&
          credential.purpose === 'event_signing'
        ) {
          credential.status = 'revoked';
          credential.revoked_at_event = event.event_id;
        }
      break;
    }
    case 'credential_rotated': {
      const { credential, revoke_credential_id: revokeCredentialId } =
        credentialRotationPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'membership' ||
        event.aggregate_id !== event.actor.principal_id ||
        credential.principal_id !== event.actor.principal_id ||
        credential.client_id !== event.actor.client_id ||
        credential.purpose !== 'event_signing' ||
        credential.status !== 'active' ||
        credential.created_at_event !== event.event_id
      )
        conflict(
          'Credential rotation may only add an event Credential for this Client',
        );
      const credentials = (next.credentials[event.actor.principal_id] ??= {});
      if (credentials[credential.credential_id])
        conflict('Credential already exists');
      credentials[credential.credential_id] = credential;
      if (revokeCredentialId) {
        const previous = credentials[revokeCredentialId];
        if (
          !previous ||
          previous.status !== 'active' ||
          previous.purpose !== 'event_signing' ||
          previous.client_id !== event.actor.client_id ||
          previous.credential_id === credential.credential_id
        )
          conflict(
            'Credential selected for rotation is not active on this Client',
          );
        previous.status = 'revoked';
        previous.revoked_at_event = event.event_id;
      }
      break;
    }
    case 'credential_revoked': {
      const { credential_id: credentialId } =
        credentialIdPayloadSchema.parse(payload);
      const credential =
        next.credentials[event.actor.principal_id]?.[credentialId];
      if (!credential || credential.status !== 'active')
        conflict('Credential is not active for actor Principal');
      if (credential.purpose === 'group_recovery')
        conflict('Group recovery Credential cannot be revoked online');
      const remaining = Object.values(
        next.credentials[event.actor.principal_id] ?? {},
      ).filter(
        (candidate) =>
          candidate.status === 'active' &&
          candidate.purpose === 'event_signing' &&
          candidate.credential_id !== credentialId,
      );
      if (remaining.length === 0)
        conflict('Cannot revoke the Principal last event-signing Credential');
      credential.status = 'revoked';
      credential.revoked_at_event = event.event_id;
      break;
    }
    case 'identity_recovery_requested':
    case 'owner_recovery_requested': {
      const { request } = recoveryRequestPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'recovery' ||
        event.aggregate_id !== request.request_id ||
        request.target_principal_id !== event.actor.principal_id ||
        request.requested_client.client_id !== event.actor.client_id ||
        request.requested_credential.credential_id !==
          event.actor.credential_id ||
        request.created_at !== event.occurred_at ||
        request.status !== 'pending' ||
        request.type !==
          (event.event_type === 'identity_recovery_requested'
            ? 'identity_recovery'
            : 'owner_recovery')
      )
        conflict(
          'Recovery request identity, type, Aggregate, and actor must agree',
        );
      const target = next.members[request.target_principal_id];
      if (!target || target.status !== 'active')
        conflict('Recovery target must be an active Principal');
      const expectedHash = collaborationRecoveryRequestHashV3(request);
      if (request.request_hash !== expectedHash)
        conflict('Recovery request hash does not match its immutable identity');
      if (Date.parse(request.expires_at) <= Date.parse(event.occurred_at))
        conflict('Recovery request is already expired');
      if (next.recoveryRequests[request.request_id])
        conflict('Recovery request already exists');
      next.recoveryRequests[request.request_id] = request;
      break;
    }
    case 'recovery_approved':
    case 'recovery_rejected':
    case 'recovery_expired':
    case 'recovery_cancelled': {
      const decision = recoveryDecisionPayloadSchema.parse(payload);
      if (
        event.aggregate_type !== 'recovery' ||
        event.aggregate_id === next.groupId
      )
        conflict('Recovery decision must use its request Aggregate');
      const request = next.recoveryRequests[event.aggregate_id];
      if (!request || request.status !== 'pending')
        conflict('Recovery request is not pending');
      if (decision.request_hash !== request.request_hash)
        conflict('Recovery request hash changed before decision');
      const expired =
        Date.parse(request.expires_at) <= Date.parse(event.occurred_at);
      if (event.event_type === 'recovery_cancelled') {
        if (
          event.actor.principal_id !== request.target_principal_id ||
          event.actor.client_id !== request.requested_client.client_id ||
          event.actor.credential_id !==
            request.requested_credential.credential_id
        )
          conflict('Only the requesting Client may cancel recovery');
      } else if (event.event_type === 'recovery_expired') {
        if (!expired) conflict('Recovery request has not expired');
      } else {
        if (expired) conflict('Expired recovery request cannot be decided');
        if (request.type === 'identity_recovery') {
          if (event.actor.principal_id !== request.target_principal_id)
            conflict('Identity recovery requires the same Principal approval');
        } else if (event.actor.principal_id !== next.group.owner_principal_id)
          conflict('Owner recovery requires the Group Owner approval');
      }
      if (
        request.type === 'owner_recovery' &&
        ['recovery_approved', 'recovery_rejected'].includes(event.event_type) &&
        decision.reason.trim().length === 0
      )
        conflict('Owner recovery decisions require a reason');

      request.status =
        event.event_type === 'recovery_approved'
          ? 'approved'
          : event.event_type === 'recovery_rejected'
            ? 'rejected'
            : event.event_type === 'recovery_expired'
              ? 'expired'
              : 'cancelled';
      request.decided_at_event = event.event_id;
      request.decided_by_principal_id = event.actor.principal_id;
      request.decision_reason = decision.reason;
      request.approval_kind =
        event.event_type !== 'recovery_approved'
          ? null
          : request.type === 'identity_recovery'
            ? 'self_device'
            : next.credentials[event.actor.principal_id]?.[
                  event.actor.credential_id
                ]?.purpose === 'group_recovery'
              ? 'offline_owner'
              : 'owner';
      if (event.event_type === 'recovery_approved') {
        const principalId = request.target_principal_id;
        (next.clients[principalId] ??= {})[request.requested_client.client_id] =
          request.requested_client;
        (next.credentials[principalId] ??= {})[
          request.requested_credential.credential_id
        ] = request.requested_credential;
        if (request.type === 'owner_recovery') {
          const credentials = Object.values(
            next.credentials[principalId] ?? {},
          );
          const selectedIds = decision.revoke_previous_credentials
            ? credentials
                .filter(
                  (credential) =>
                    credential.credential_id !==
                      request.requested_credential.credential_id &&
                    credential.purpose === 'event_signing',
                )
                .map((credential) => credential.credential_id)
            : decision.revoke_credential_ids;
          for (const credentialId of selectedIds) {
            const credential = next.credentials[principalId]?.[credentialId];
            if (
              !credential ||
              credential.credential_id ===
                request.requested_credential.credential_id ||
              credential.purpose !== 'event_signing'
            )
              conflict(
                'Owner recovery revocation scope must contain old target Principal event Credentials',
              );
            if (credential.status === 'active') {
              credential.status = 'revoked';
              credential.revoked_at_event = event.event_id;
              request.revoked_credential_ids.push(credential.credential_id);
            }
          }
        } else if (
          decision.revoke_previous_credentials ||
          decision.revoke_credential_ids.length > 0
        ) {
          conflict('Self device recovery cannot revoke other Credentials');
        }
      }
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
        event.aggregate_type !== 'workspace' ||
        event.aggregate_id !== action.owner_principal_id ||
        action.owner_principal_id !== event.actor.principal_id ||
        !action.prompt_ref.startsWith(
          `workspace/principals/${event.actor.principal_id}/automations/prompts/`,
        )
      )
        conflict('Principal Automation must remain in the actor-owned library');
      const key = `${action.owner_principal_id}:${action.action_id}`;
      const previous = next.actions[key];
      if (event.event_type === 'action_published') {
        if (previous) conflict('Published Action already exists');
        if (action.version !== 1)
          conflict('A new Action must publish at version 1');
      } else {
        if (!previous) conflict('Action revise requires an existing Action');
        if (action.version !== previous.version + 1)
          conflict('Action revisions must use a sequential version');
      }
      next.actions[key] = action;
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
        if (
          item.parent_id !== previous.parent_id ||
          canonicalJsonStringify(item.blocked_by) !==
            canonicalJsonStringify(previous.blocked_by) ||
          canonicalJsonStringify(item.related_items) !==
            canonicalJsonStringify(previous.related_items)
        )
          conflict('Work Item details cannot rewrite relation fields');
      }
      assertWorkItemRelations(next, item.work_item_id, item);
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
      const { update, artifacts } =
        workItemProgressPayloadSchema.parse(payload);
      const item = next.workItems[event.aggregate_id];
      if (update.work_item_id !== event.aggregate_id || !item)
        conflict('Work Item progress references a missing or different item');
      if (
        update.actor_principal_id !== event.actor.principal_id ||
        update.actor_client_id !== event.actor.client_id ||
        !canContributeToWorkItem(next, event.actor.principal_id, item)
      )
        conflict('Actor cannot post progress to this Work Item');
      for (const artifact of artifacts) {
        const artifactRef = `artifacts/work-items/${event.aggregate_id}/${artifact.artifact_id}/metadata.json`;
        if (
          artifact.scope.type !== 'work_item' ||
          artifact.scope.work_item_id !== event.aggregate_id ||
          artifact.uploader_principal_id !== event.actor.principal_id ||
          artifact.uploader_client_id !== event.actor.client_id ||
          artifact.executor_id !== event.actor.executor_id ||
          !update.artifact_refs.includes(artifactRef) ||
          next.artifacts[artifact.artifact_id]
        )
          conflict('Work Item Artifact metadata does not match its event');
        next.artifacts[artifact.artifact_id] = artifact;
      }
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
      assertWorkItemRelations(next, item.work_item_id, relations);
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
        definition.created_by_principal_id !== event.actor.principal_id &&
        !next.workflowDefinitions[
          workflowDefinitionVersionKey(
            definition.definition_id,
            definition.version,
          )
        ]
      )
        conflict('Workflow Definition creator cannot be rewritten');
      if (
        expectedStatus === 'proposed' &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workflow_definition:propose',
        )
      )
        conflict('Actor cannot propose Workflow Definitions');
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
      const previousVersion = next.workflowDefinitions[key];
      if (previousVersion?.definition.status === 'published')
        conflict('Published Workflow Definition versions are immutable');
      if (
        previousVersion &&
        (definition.created_by_principal_id !==
          previousVersion.definition.created_by_principal_id ||
          definition.created_at !== previousVersion.definition.created_at)
      )
        conflict('Workflow Definition version provenance cannot change');
      const latest =
        next.latestWorkflowDefinitionVersions[definition.definition_id];
      if (!previousVersion && definition.version !== (latest ?? 0) + 1)
        conflict('Workflow Definition versions must be sequential');
      if (
        expectedStatus === 'published' &&
        definition.published_by_principal_id !== event.actor.principal_id
      )
        conflict('Workflow Definition publisher does not match actor');
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
      if (
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workflow_definition:publish',
        )
      )
        conflict('Actor cannot retire Workflow Definitions');
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
      if (
        definition.definition.created_by_principal_id !==
          event.actor.principal_id &&
        !hasCollaborationPermissionV3(
          next,
          event.actor.principal_id,
          'workflow_definition:publish',
        )
      )
        conflict('Actor cannot update this Workflow layout');
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
      if (!['draft', 'ready'].includes(instance.lifecycle))
        conflict('A new Workflow Instance must be draft or ready');
      if (
        instance.active_turn_id !== null ||
        instance.last_completed_turn_id !== null ||
        instance.last_handoff_hash !== null
      )
        conflict('A new Workflow Instance cannot contain Turn history');
      assertActivePrincipals(next, [
        instance.created_by_principal_id,
        ...Object.values(instance.participant_bindings),
        ...Object.values(instance.resolved_assignments),
      ]);
      const assignmentsComplete = validateWorkflowAssignments(
        next,
        instance,
        definition.machine,
        instance.lifecycle === 'ready',
      );
      if (instance.lifecycle === 'draft' && assignmentsComplete)
        conflict('A fully resolved Workflow Instance must be ready');
      if (
        instance.scope.type === 'work_item' &&
        !next.workItems[instance.scope.work_item_id]
      )
        conflict('Workflow Instance Work Item scope does not exist');
      for (const ref of instance.related_work_item_refs)
        if (!next.workItems[ref])
          conflict(`Related Work Item does not exist: ${ref}`);
      const terminalStateIds = Object.entries(definition.machine.states)
        .filter(([, state]) => state.terminal)
        .map(([stateId]) => stateId)
        .sort();
      const mappedStateIds = Object.keys(
        instance.work_item_status_mapping,
      ).sort();
      if (instance.scope.type === 'group' && mappedStateIds.length > 0)
        conflict('Group-scoped Workflow cannot map Work Item status');
      if (
        instance.scope.type === 'work_item' &&
        (mappedStateIds.length !== terminalStateIds.length ||
          mappedStateIds.some(
            (stateId, index) => stateId !== terminalStateIds[index],
          ))
      )
        conflict('Work Item Workflow must map every terminal State');
      if (
        !canLaunchWorkflow(
          next,
          event.actor.principal_id,
          instance,
          definition.definition,
        )
      )
        conflict('Actor cannot create an Instance from this Definition');
      if (instance.scope.type === 'work_item') {
        const item = next.workItems[instance.scope.work_item_id]!;
        const activePrimary = item.primary_workflow_instance_id
          ? next.workflowInstances[item.primary_workflow_instance_id]
          : null;
        if (activePrimary && activePrimary.lifecycle !== 'closed')
          conflict('Work Item already has an active primary Workflow Instance');
        item.primary_workflow_instance_id = instance.instance_id;
        item.updated_at = event.occurred_at;
      }
      next.workflowInstances[instance.instance_id] = instance;
      break;
    }
    case 'workflow_instance_started':
    case 'workflow_instance_paused':
    case 'workflow_instance_resumed':
    case 'workflow_instance_closed': {
      const instance = next.workflowInstances[event.aggregate_id];
      if (!instance) conflict('Workflow Instance does not exist');
      const definition = activeDefinition(next, instance);
      if (
        event.event_type === 'workflow_instance_started'
          ? !canLaunchWorkflow(
              next,
              event.actor.principal_id,
              instance,
              definition.definition,
            )
          : !canManageWorkflowInstance(next, event.actor.principal_id, instance)
      )
        conflict('Actor cannot change Workflow Instance lifecycle');
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
      if (
        event.event_type === 'workflow_instance_started' &&
        instance.scope.type === 'work_item'
      ) {
        const item = next.workItems[instance.scope.work_item_id]!;
        if (!['open', 'in_progress', 'blocked'].includes(item.status))
          conflict('Work Item is not launchable');
        item.status = 'in_progress';
        item.closed_at = null;
        item.updated_at = event.occurred_at;
      }
      if (
        event.event_type === 'workflow_instance_closed' &&
        instance.scope.type === 'work_item'
      )
        next.workItems[
          instance.scope.work_item_id
        ]!.primary_workflow_instance_id = null;
      break;
    }
    case 'workflow_state_assignee_changed': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = assigneePayloadSchema.parse(payload);
      if (!instance || !activeCollaborationMemberV3(next, parsed.principal_id))
        conflict('Workflow Instance or assignee does not exist');
      if (!canManageWorkflowInstance(next, event.actor.principal_id, instance))
        conflict('Actor cannot reassign this Workflow Instance');
      const definition = activeDefinition(next, instance);
      const definitionState = definition.machine.states[parsed.state_id];
      if (!definitionState || definitionState.terminal)
        conflict(
          'Workflow reassignment must reference an executable Definition State',
        );
      if (
        instance.business_state === parsed.state_id &&
        instance.active_turn_id !== null
      )
        conflict(
          'Current State must cancel/recover its Turn before reassignment',
        );
      const previousPrincipal = instance.resolved_assignments[parsed.state_id];
      instance.resolved_assignments[parsed.state_id] = parsed.principal_id;
      if (previousPrincipal !== parsed.principal_id)
        delete next.stateExecutions[instance.instance_id]?.[parsed.state_id];
      if (
        instance.lifecycle === 'draft' &&
        validateWorkflowAssignments(next, instance, definition.machine, false)
      )
        instance.lifecycle = 'ready';
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
      const definition = activeDefinition(next, instance);
      const definitionState = definition.machine.states[execution.state_id];
      if (!definitionState || definitionState.terminal)
        conflict(
          'State Execution must reference an executable Definition State',
        );
      const current =
        next.stateExecutions[instance.instance_id]?.[execution.state_id];
      if (event.event_type === 'state_execution_published') {
        if (current) conflict('Published State Execution already exists');
        if (execution.revision !== 1)
          conflict('A new State Execution must publish at revision 1');
      } else {
        if (!current)
          conflict('State Execution revise requires an existing object');
        if (
          execution.revision !== current.revision + 1 ||
          execution.instance_id !== current.instance_id ||
          execution.state_id !== current.state_id ||
          execution.principal_id !== current.principal_id
        )
          conflict('State Execution revisions must be sequential and stable');
      }
      if (execution.published_at_event !== event.event_id)
        conflict('State Execution event provenance does not match');
      if (execution.action_ref) {
        const actionId =
          execution.action_ref
            .split('/')
            .at(-1)
            ?.replace(/\.json$/u, '') ?? '';
        const action = next.actions[`${event.actor.principal_id}:${actionId}`];
        const expectedActionRef = action
          ? `workspace/principals/${event.actor.principal_id}/automations/actions/${action.action_id}.json`
          : null;
        if (!action || execution.action_ref !== expectedActionRef)
          conflict('State Execution Action is not Principal-owned');
        if (
          execution.action_hash !== collaborationCanonicalHashV3(action) ||
          execution.prompt_hash !== action.prompt_hash
        )
          conflict('State Execution Action or Prompt hash does not match');
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
        instance.lifecycle !== 'running' ||
        turn.workflow_instance_id !== instance.instance_id ||
        turn.state_id !== instance.business_state ||
        turn.assignee_principal_id !==
          instance.resolved_assignments[instance.business_state] ||
        instance.active_turn_id ||
        next.turns[turn.turn_id]
      )
        conflict('Turn does not match the active Workflow Instance State');
      if (!canCreateWorkflowTurnV3(next, event.actor.principal_id, instance))
        conflict('Actor cannot create a Turn for this Workflow Instance');
      const execution =
        next.stateExecutions[instance.instance_id]?.[instance.business_state];
      if (!execution && turn.execution_mode !== 'manual')
        conflict('Missing State Execution must create a manual Turn');
      if (
        execution &&
        (turn.execution_mode !== execution.mode ||
          turn.action_ref !== execution.action_ref ||
          turn.action_hash !== execution.action_hash ||
          turn.prompt_hash !== execution.prompt_hash)
      )
        conflict('Turn does not snapshot current Principal State Execution');
      const previousTurn = instance.last_completed_turn_id
        ? next.turns[instance.last_completed_turn_id]
        : null;
      if (!previousTurn) {
        if (
          instance.last_completed_turn_id !== null ||
          instance.last_handoff_hash !== null ||
          turn.incoming_handoff !== null ||
          turn.incoming_handoff_hash !== null
        )
          conflict('The first Turn cannot contain an incoming Handoff');
      } else if (
        previousTurn.workflow_instance_id !== instance.instance_id ||
        previousTurn.state !== 'completed' ||
        !previousTurn.handoff ||
        !previousTurn.handoff_hash ||
        instance.last_handoff_hash !== previousTurn.handoff_hash ||
        turn.incoming_handoff_hash !== previousTurn.handoff_hash ||
        collaborationCanonicalHashV3(turn.incoming_handoff) !==
          previousTurn.handoff_hash
      ) {
        conflict(
          'Turn incoming Handoff must match the previous completed Instance Turn',
        );
      }
      if (
        turn.input_hash !==
        collaborationTurnInputHashV3({
          groupId: next.groupId,
          instanceId: instance.instance_id,
          epoch: instance.epoch,
          stateId: instance.business_state,
          assigneePrincipalId:
            instance.resolved_assignments[instance.business_state]!,
          execution: execution ?? null,
          incomingHandoffHash: turn.incoming_handoff_hash,
          workItem:
            instance.scope.type === 'work_item'
              ? (next.workItems[instance.scope.work_item_id] ?? null)
              : null,
        })
      )
        conflict('Turn input hash does not match its canonical inputs');
      if (
        turn.state !== 'pending' ||
        turn.claimant_principal_id !== null ||
        turn.claimant_client_id !== null ||
        turn.executor_id !== null ||
        turn.fencing_token !== null ||
        turn.executor_result !== null ||
        turn.executor_result_hash !== null ||
        turn.completion_hash !== null
      )
        conflict('A new Turn must start pending without execution results');
      if (
        turn.idempotency_key !==
        collaborationIdempotencyKeyV3({
          groupId: next.groupId,
          instanceId: instance.instance_id,
          epoch: instance.epoch,
          turnId: turn.turn_id,
          attempt: turn.attempt,
          inputHash: turn.input_hash,
        })
      )
        conflict('Turn idempotency key is invalid');
      if (
        turn.deadline_snapshot_hash !==
        collaborationDeadlineSnapshotHashV3({
          turnId: turn.turn_id,
          attempt: turn.attempt,
          timeoutPolicy: turn.timeout_policy_snapshot,
          startDeadlineAt: turn.start_deadline_at,
          startedAt: null,
          executionDeadlineAt: null,
        })
      )
        conflict('Turn deadline snapshot hash is invalid');
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
      if (
        (turn.execution_mode === 'manual' && parsed.executor_id !== null) ||
        (turn.execution_mode !== 'manual' && parsed.executor_id === null) ||
        parsed.executor_id !== event.actor.executor_id
      )
        conflict('Turn Executor does not match its execution mode or actor');
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
      if (
        parsed.deadline_snapshot_hash !==
        collaborationDeadlineSnapshotHashV3({
          turnId: turn.turn_id,
          attempt: turn.attempt,
          timeoutPolicy: turn.timeout_policy_snapshot,
          startDeadlineAt: turn.start_deadline_at,
          startedAt: event.occurred_at,
          executionDeadlineAt: parsed.execution_deadline_at,
        })
      )
        conflict('Turn execution deadline snapshot is invalid');
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
      const instance = next.workflowInstances[event.aggregate_id];
      if (
        !instance ||
        instance.active_turn_id !== turn.turn_id ||
        !['running', 'waiting_input', 'waiting_approval'].includes(turn.state)
      )
        conflict('Action callback cannot change a terminal or inactive Turn');
      if (event.actor.executor_id !== turn.executor_id)
        conflict('Action callback Executor does not match the fenced Turn');
      if (turn.execution_mode === 'manual')
        conflict('Manual Turns cannot receive Action callbacks');
      if (event.event_type === 'action_completed') {
        const completion = actionCompletedPayloadSchema.parse(payload);
        if (turn.executor_result_hash !== null)
          conflict('Action completion is already recorded for this Turn');
        if (
          completion.result_hash !==
          collaborationCanonicalHashV3(completion.result)
        )
          conflict('Action result hash does not match its canonical result');
        const definition = activeDefinition(next, instance);
        if (
          !definition.machine.states[turn.state_id]?.transitions.some(
            (transition) => transition.outcome === completion.result.outcome,
          )
        )
          conflict(
            'Action result Outcome is not allowed by the Workflow State',
          );
        turn.executor_result = completion.result;
        turn.executor_result_hash = completion.result_hash;
      }
      turn.state =
        event.event_type === 'action_waiting_input'
          ? 'waiting_input'
          : event.event_type === 'action_waiting_approval'
            ? 'waiting_approval'
            : event.event_type === 'action_completed' &&
                turn.execution_mode === 'assisted'
              ? 'awaiting_confirmation'
              : 'running';
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      break;
    }
    case 'turn_timeout_observed': {
      const parsed = timeoutObservedPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (!turn || turn.attempt !== parsed.attempt)
        conflict('Timeout observation references a stale Turn attempt');
      if (
        parsed.turn_snapshot_hash !== turn.deadline_snapshot_hash ||
        Date.parse(parsed.observed_at) < Date.parse(parsed.deadline_at)
      )
        conflict('Timeout observation does not match the due Turn snapshot');
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
      if (instance.active_turn_id !== turn.turn_id)
        conflict('Turn is not active for this Workflow Instance');
      const completable =
        turn.execution_mode === 'assisted'
          ? turn.state === 'awaiting_confirmation'
          : ['running', 'waiting_input', 'waiting_approval'].includes(
              turn.state,
            );
      if (!completable) conflict('Turn is not completable');
      if (
        turn.execution_mode === 'automatic'
          ? event.actor.executor_id !== turn.executor_id
          : event.actor.executor_id !== null
      )
        conflict('Turn completion actor does not match its execution mode');
      if (turn.execution_mode === 'manual') {
        if (
          parsed.result_hash !== null ||
          turn.executor_result !== null ||
          turn.executor_result_hash !== null
        )
          conflict('Manual Turn completion cannot claim an Action result');
      } else if (
        !turn.executor_result ||
        !turn.executor_result_hash ||
        parsed.result_hash !== turn.executor_result_hash
      ) {
        conflict(
          'Turn completion must reference its recorded Action result hash',
        );
      }
      if (turn.execution_mode === 'automatic') {
        const expected = collaborationAutomaticCompletionFactsV3(
          turn.executor_result!,
        );
        const actual = {
          outcome: parsed.outcome,
          summary: parsed.handoff.summary,
          instruction: parsed.handoff.instruction,
          markers: parsed.handoff.markers,
          dataRefs: parsed.handoff.data_refs,
          artifactRefs: parsed.handoff.artifact_refs,
          data: parsed.handoff.data,
        };
        if (
          collaborationCanonicalHashV3(actual) !==
            collaborationCanonicalHashV3(expected) ||
          collaborationCanonicalHashV3(parsed.artifact_refs) !==
            collaborationCanonicalHashV3(expected.artifactRefs)
        )
          conflict(
            'Automatic Turn completion must exactly match its recorded Executor Result',
          );
      }
      for (const artifact of parsed.artifacts) {
        const artifactRef = `artifacts/workflows/${event.aggregate_id}/${turn.turn_id}/${artifact.artifact_id}/metadata.json`;
        if (
          artifact.scope.type !== 'workflow_turn' ||
          artifact.scope.workflow_instance_id !== event.aggregate_id ||
          artifact.scope.turn_id !== turn.turn_id ||
          artifact.scope.attempt !== turn.attempt ||
          artifact.scope.fencing_token !== turn.fencing_token ||
          artifact.uploader_principal_id !== event.actor.principal_id ||
          artifact.uploader_client_id !== event.actor.client_id ||
          artifact.executor_id !== event.actor.executor_id ||
          !parsed.artifact_refs.includes(artifactRef) ||
          !parsed.handoff.artifact_refs.includes(artifactRef) ||
          next.artifacts[artifact.artifact_id]
        )
          conflict('Turn Artifact metadata does not match its fenced event');
        next.artifacts[artifact.artifact_id] = artifact;
      }
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
      if (
        parsed.completion_hash !==
        collaborationTurnCompletionHashV3({
          turnId: turn.turn_id,
          attempt: turn.attempt,
          outcome: parsed.outcome,
          resultHash: parsed.result_hash,
          handoffHash: parsed.handoff_hash,
          artifactRefs: parsed.artifact_refs,
        })
      )
        conflict('Turn completion hash does not match its canonical facts');
      turn.state = 'completed';
      turn.completed_at = event.occurred_at;
      turn.outcome = parsed.outcome;
      turn.handoff = parsed.handoff;
      turn.handoff_hash = parsed.handoff_hash;
      turn.completion_hash = parsed.completion_hash;
      instance.business_state = transition.target_state;
      instance.active_turn_id = null;
      instance.last_completed_turn_id = turn.turn_id;
      instance.last_handoff_hash = turn.handoff_hash;
      instance.revision = event.aggregate_revision;
      instance.updated_at = event.occurred_at;
      if (definition.machine.states[transition.target_state]?.terminal)
        instance.lifecycle = 'closed';
      if (
        instance.lifecycle === 'closed' &&
        instance.scope.type === 'work_item'
      ) {
        const item = next.workItems[instance.scope.work_item_id]!;
        const status =
          instance.work_item_status_mapping[transition.target_state];
        if (!status) conflict('Terminal State has no Work Item status mapping');
        item.status = status;
        item.closed_at = ['done', 'cancelled'].includes(status)
          ? event.occurred_at
          : null;
        item.primary_workflow_instance_id = null;
        item.updated_at = event.occurred_at;
      }
      break;
    }
    case 'turn_cancelled': {
      const instance = next.workflowInstances[event.aggregate_id];
      const parsed = turnCancelledPayloadSchema.parse(payload);
      const turn = next.turns[parsed.turn_id];
      if (
        !instance ||
        !turn ||
        instance.active_turn_id !== turn.turn_id ||
        turn.attempt !== parsed.attempt ||
        ['completed', 'cancelled'].includes(turn.state)
      )
        conflict('Turn cancellation references a stale attempt');
      const authority = hasWorkflowInstanceAuthority(
        next,
        event.actor.principal_id,
        instance,
      );
      if (!turn.fencing_token) {
        if (parsed.fencing_token !== null || !authority)
          conflict('Only Instance authority may cancel an unclaimed Turn');
      } else if (
        parsed.fencing_token !== turn.fencing_token ||
        (!authority &&
          (turn.claimant_principal_id !== event.actor.principal_id ||
            turn.claimant_client_id !== event.actor.client_id))
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
      if (
        !instance ||
        !turn ||
        instance.active_turn_id !== turn.turn_id ||
        parsed.epoch !== instance.epoch ||
        ![
          'running',
          'waiting_input',
          'waiting_approval',
          'awaiting_confirmation',
        ].includes(turn.state)
      )
        conflict('Turn recovery references a stale Workflow epoch or state');
      if (turn.attempt !== parsed.attempt)
        conflict('Turn recovery references a stale attempt');
      assertTurnFence(turn, parsed, event);
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
      if (!canManageWorkflowInstance(next, event.actor.principal_id, instance))
        conflict('Actor cannot recover this Workflow Instance');
      if (
        parsed.deadline_snapshot_hash !==
        collaborationDeadlineSnapshotHashV3({
          turnId: turn.turn_id,
          attempt: parsed.next_attempt,
          timeoutPolicy: turn.timeout_policy_snapshot,
          startDeadlineAt: parsed.start_deadline_at,
          startedAt: null,
          executionDeadlineAt: null,
        })
      )
        conflict('Recovered Turn deadline snapshot is invalid');
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
      turn.outcome = null;
      turn.handoff = null;
      turn.handoff_hash = null;
      turn.executor_result = null;
      turn.executor_result_hash = null;
      turn.completion_hash = null;
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
