import crypto from 'node:crypto';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import { canonicalJsonStringify } from './canonical-json.js';
import {
  actionDefinitionSchema,
  artifactMetadataSchema,
  collaborationEventSchema,
  dataUpdatePayloadSchema,
  handoffEnvelopeSchema,
  memberDefinitionSchema,
  roleClaimSchema,
  sha256,
  stateImplementationSchema,
  timeoutPolicySchema,
  type ActionDefinition,
  type ArtifactMetadata,
  type CollaborationEvent,
  type CollaborationRepositoryDefinition,
  type HandoffEnvelope,
  type MemberDefinition,
  type RoleClaim,
  type StateExecutionMode,
  type StateImplementation,
  type TimeoutPolicy,
} from './schema.js';
import {
  COLLABORATION_PROTOCOL_VERSION,
  CollaborationProtocolError,
} from './version.js';

export type CollaborationLifecycle =
  | 'FORMING'
  | 'READY'
  | 'RUNNING'
  | 'PAUSING'
  | 'PAUSED'
  | 'CLOSING'
  | 'CLOSED';

export type CollaborationTurnState =
  | 'PENDING_START'
  | 'IN_PROGRESS'
  | 'DISPATCHING'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'WAITING_APPROVAL'
  | 'AWAITING_CONFIRMATION'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export interface ActiveStateImplementation {
  readonly active: boolean;
  readonly implementation: StateImplementation;
  readonly implementationRef: string;
  readonly implementationHash: string;
  readonly action: ActionDefinition | null;
  readonly actionHash: string | null;
  readonly promptHash: string | null;
  readonly publishedEventId: string;
}

export type CollaborationDeadlineKind = 'start' | 'execution';

export interface CollaborationTimeoutObservation {
  readonly attempt: number;
  readonly deadlineKind: CollaborationDeadlineKind;
  readonly deadlineAt: string;
  readonly observedAt: string;
  readonly turnSnapshotHash: string;
  readonly actorPrincipalId: string;
  readonly actorAgentId: string;
  readonly eventId: string;
  readonly sequence: number;
}

export interface CollaborationTurn {
  readonly turnId: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly createdRevision: number;
  readonly createdAt: string;
  readonly timeoutPolicy: TimeoutPolicy | null;
  startDeadlineAt: string | null;
  executionDeadlineAt: string | null;
  deadlineSnapshotHash: string;
  startedAt: string | null;
  dispatchAcceptedAt: string | null;
  providerCompletedAt: string | null;
  awaitingConfirmationAt: string | null;
  completedAt: string | null;
  stateAdvancedAt: string | null;
  cancelledAt: string | null;
  recoveryRequestedAt: string | null;
  recoveredAt: string | null;
  readonly timeoutObservations: CollaborationTimeoutObservation[];
  readonly machineHash: string;
  readonly stateId: string;
  readonly role: string;
  readonly mode: StateExecutionMode;
  readonly implementationRef: string;
  readonly implementationHash: string;
  readonly actionRef: string | null;
  readonly actionHash: string | null;
  readonly promptHash: string | null;
  readonly incomingHandoff: HandoffEnvelope | null;
  readonly incomingHandoffHash: string | null;
  readonly inputHash: string;
  attempt: number;
  idempotencyKey: string;
  state: CollaborationTurnState;
  claimEventId: string | null;
  claimantPrincipalId: string | null;
  claimantAgentId: string | null;
  fencingToken: string | null;
  executionRef: string | null;
  executorResultHash: string | null;
  executorResult: Record<string, unknown> | null;
  completionResultHash: string | null;
  handoff: HandoffEnvelope | null;
  handoffHash: string | null;
  artifacts: ArtifactMetadata[];
  outcome: string | null;
  recoveryReason: string | null;
}

export interface CollaborationProjection {
  readonly format: 'icarus.agent-group-projection/2';
  readonly protocolVersion: 2;
  readonly groupId: string;
  epoch: number;
  sequence: number;
  revision: number;
  lifecycle: CollaborationLifecycle;
  businessState: string;
  readonly creatorPrincipalId: string;
  members: Record<string, MemberDefinition[]>;
  roleClaims: Record<string, RoleClaim[]>;
  stateImplementations: Record<string, ActiveStateImplementation>;
  turns: Record<string, CollaborationTurn>;
  activeTurnId: string | null;
  lastHandoff: HandoffEnvelope | null;
  lastHandoffHash: string | null;
  seenEventIds: string[];
  lastEventId: string;
  integrityStatus: 'OK' | 'PROTOCOL_QUARANTINED';
  integrityMessage: string | null;
}

const genesisPayloadSchema = z
  .object({ member: memberDefinitionSchema, role_claim: roleClaimSchema })
  .strict();
const memberPayloadSchema = z
  .object({ member: memberDefinitionSchema })
  .strict();
const rolePayloadSchema = z
  .object({
    role: z.string().min(1),
    principal_id: z.string().min(1),
    agent_id: z.string().min(1),
  })
  .strict();
const implementationPayloadSchema = z
  .object({
    implementation: stateImplementationSchema,
    implementation_ref: z.string().min(1).max(512),
    implementation_hash: sha256,
    action: actionDefinitionSchema.nullable(),
    action_hash: sha256.nullable(),
    prompt_hash: sha256.nullable(),
  })
  .strict();
const implementationWithdrawalSchema = z
  .object({ state_id: z.string().min(1), role: z.string().min(1) })
  .strict();
const startGroupPayloadSchema = z
  .object({
    initial_handoff: handoffEnvelopeSchema.nullable().default(null),
    initial_handoff_hash: sha256.nullable().default(null),
  })
  .strict();
const turnCreatedPayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    state_id: z.string().min(1),
    role: z.string().min(1),
    mode: z.enum(['manual', 'assisted', 'automatic']),
    implementation_ref: z.string().min(1),
    implementation_hash: sha256,
    action_ref: z.string().min(1).nullable(),
    action_hash: sha256.nullable(),
    prompt_hash: sha256.nullable(),
    incoming_handoff: handoffEnvelopeSchema.nullable(),
    incoming_handoff_hash: sha256.nullable(),
    machine_hash: sha256,
    timeout_policy_snapshot: timeoutPolicySchema.nullable(),
    start_deadline_at: z.iso.datetime({ offset: true }).nullable(),
    deadline_snapshot_hash: sha256,
    attempt: z.number().int().positive(),
    input_hash: sha256,
    idempotency_key: sha256,
  })
  .strict();
const turnFencePayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    attempt: z.number().int().positive(),
    fencing_token: sha256,
  })
  .strict();
const turnStartedPayloadSchema = turnFencePayloadSchema
  .extend({
    execution_deadline_at: z.iso.datetime({ offset: true }).nullable(),
    deadline_snapshot_hash: sha256,
  })
  .strict();
const dispatchPayloadSchema = turnFencePayloadSchema
  .extend({ execution_ref: z.string().min(1).max(255) })
  .strict();
const actionCompletedPayloadSchema = turnFencePayloadSchema
  .extend({ result_hash: sha256, result: z.record(z.string(), z.unknown()) })
  .strict();
const turnCompletedPayloadSchema = turnFencePayloadSchema
  .extend({
    outcome: z.string().min(1),
    result_hash: sha256,
    handoff: handoffEnvelopeSchema,
    handoff_hash: sha256,
    artifacts: z.array(artifactMetadataSchema).max(20),
  })
  .strict();
const reasonPayloadSchema = z
  .object({ reason: z.string().min(1).max(4000) })
  .strict();
const recoveryPayloadSchema = turnFencePayloadSchema
  .extend({ reason: z.string().min(1).max(4000) })
  .strict();
const turnRecoveredPayloadSchema = recoveryPayloadSchema
  .extend({
    start_deadline_at: z.iso.datetime({ offset: true }).nullable(),
    deadline_snapshot_hash: sha256,
  })
  .strict();
const timeoutObservedPayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    attempt: z.number().int().positive(),
    deadline_kind: z.enum(['start', 'execution']),
    deadline_at: z.iso.datetime({ offset: true }),
    observed_at: z.iso.datetime({ offset: true }),
    turn_snapshot_hash: sha256,
  })
  .strict();
const turnCancelledPayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    attempt: z.number().int().positive(),
    fencing_token: sha256.nullable(),
    reason: z.string().min(1).max(4000),
  })
  .strict();

function conflict(message: string): never {
  throw new CollaborationProtocolError('EVENT_CONFLICT', message);
}

function assertHandoffDataMatchesResultSchema(
  action: ActionDefinition | null,
  handoff: HandoffEnvelope,
): void {
  const schema = action?.result_schema.schema;
  if (!schema) return;
  try {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(schema);
    if (!validate(handoff.data))
      conflict(
        `Handoff data does not satisfy ${action.result_schema.ref}: ${ajv.errorsText(validate.errors)}`,
      );
  } catch (error) {
    if (error instanceof CollaborationProtocolError) throw error;
    conflict(
      `Action result schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function collaborationCanonicalHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

export function collaborationDeadlineAt(
  occurredAt: string,
  durationMs: number | null | undefined,
): string | null {
  if (durationMs == null) return null;
  return new Date(Date.parse(occurredAt) + durationMs).toISOString();
}

export function collaborationDeadlineSnapshotHash(input: {
  readonly turnId: string;
  readonly attempt: number;
  readonly timeoutPolicy: TimeoutPolicy | null;
  readonly startDeadlineAt: string | null;
  readonly startedAt: string | null;
  readonly executionDeadlineAt: string | null;
}): string {
  return collaborationCanonicalHash({
    turn_id: input.turnId,
    attempt: input.attempt,
    timeout_policy_snapshot: input.timeoutPolicy,
    start_deadline_at: input.startDeadlineAt,
    started_at: input.startedAt,
    execution_deadline_at: input.executionDeadlineAt,
  });
}

function hashParts(parts: readonly (string | number)[]): string {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

export function collaborationIdempotencyKey(input: {
  readonly groupId: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly attempt: number;
  readonly inputHash: string;
}): string {
  return hashParts([
    'icarus-collaboration-action-v2',
    input.groupId,
    input.epoch,
    input.turnId,
    input.attempt,
    input.inputHash,
  ]);
}

export function collaborationFencingToken(input: {
  readonly groupId: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly attempt: number;
  readonly claimEventId: string;
  readonly expectedRevision: number;
}): string {
  return hashParts([
    'icarus-collaboration-fence-v2',
    input.groupId,
    input.epoch,
    input.turnId,
    input.attempt,
    input.claimEventId,
    input.expectedRevision,
  ]);
}

export function findCollaborationMember(
  projection: CollaborationProjection,
  principalId: string,
  agentId: string,
): MemberDefinition | null {
  return (
    projection.members[principalId]?.find(
      (member) => member.agent_id === agentId,
    ) ?? null
  );
}

export function hasRoleClaim(
  projection: CollaborationProjection,
  role: string,
  principalId: string,
  agentId: string,
): boolean {
  return (projection.roleClaims[role] ?? []).some(
    (claim) => claim.principal_id === principalId && claim.agent_id === agentId,
  );
}

function implementationIsActive(
  projection: CollaborationProjection,
  stateId: string,
): boolean {
  const active = projection.stateImplementations[stateId];
  return Boolean(
    active &&
    active.active &&
    hasRoleClaim(
      projection,
      active.implementation.role,
      active.implementation.owner.principal_id,
      active.implementation.owner.agent_id,
    ),
  );
}

export function collaborationReady(
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
): boolean {
  const rolesReady = definition.group.required_roles.every(
    (requirement) =>
      (projection.roleClaims[requirement.role] ?? []).length >=
      requirement.min_members,
  );
  if (!rolesReady) return false;
  return Object.entries(definition.machine.states).every(
    ([stateId, state]) =>
      state.terminal || implementationIsActive(projection, stateId),
  );
}

function recomputeFormation(
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
): void {
  if (projection.lifecycle !== 'FORMING' && projection.lifecycle !== 'READY')
    return;
  projection.lifecycle = collaborationReady(projection, definition)
    ? 'READY'
    : 'FORMING';
}

function activeTurn(
  projection: CollaborationProjection,
  turnId: string,
): CollaborationTurn {
  const turn = projection.turns[turnId];
  if (!turn || projection.activeTurnId !== turnId)
    conflict(`Turn is not active: ${turnId}`);
  return turn;
}

function assertFence(
  turn: CollaborationTurn,
  payload: z.infer<typeof turnFencePayloadSchema>,
): void {
  if (turn.attempt !== payload.attempt)
    conflict(`Turn attempt is stale: ${payload.turn_id}`);
  if (!turn.fencingToken || turn.fencingToken !== payload.fencing_token)
    conflict(`Turn fencing token is stale: ${payload.turn_id}`);
}

function assertClaimant(
  turn: CollaborationTurn,
  event: CollaborationEvent,
): void {
  if (
    turn.claimantPrincipalId !== event.actor.principal_id ||
    turn.claimantAgentId !== event.actor.agent_id
  )
    conflict(`Event actor is not the current turn claimant: ${turn.turnId}`);
}

function assertLifecycle(
  projection: CollaborationProjection,
  allowed: readonly CollaborationLifecycle[],
  event: CollaborationEvent,
): void {
  if (!allowed.includes(projection.lifecycle))
    conflict(
      `${event.event_type} is invalid while lifecycle is ${projection.lifecycle}`,
    );
}

function reduceGenesis(
  event: CollaborationEvent,
  definition: CollaborationRepositoryDefinition,
): CollaborationProjection {
  if (event.event_type !== 'group_initialized')
    conflict('The first event must be group_initialized');
  if (
    event.sequence !== 1 ||
    event.expected.state_revision !== 0 ||
    event.epoch !== 1
  )
    conflict('group_initialized must start epoch 1, sequence 1, revision 0');
  if (event.group_id !== definition.group.group_id)
    conflict('Genesis group id disagrees with group.yaml');
  const payload = genesisPayloadSchema.parse(event.payload);
  if (
    payload.member.principal_id !== definition.group.creator.principal_id ||
    payload.member.signing_key_ref !==
      definition.group.creator.signing_key_ref ||
    payload.member.principal_id !== event.actor.principal_id ||
    payload.member.agent_id !== event.actor.agent_id
  )
    conflict('Genesis actor and creator member must match');
  if (
    payload.member.registered_at_event !== event.event_id ||
    payload.role_claim.claimed_at_event !== event.event_id ||
    payload.role_claim.principal_id !== payload.member.principal_id ||
    payload.role_claim.agent_id !== payload.member.agent_id
  )
    conflict('Genesis member and role claim must reference the genesis event');
  if (!definition.roles[payload.role_claim.role])
    conflict('Genesis role is not defined');
  const projection: CollaborationProjection = {
    format: 'icarus.agent-group-projection/2',
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    groupId: event.group_id,
    epoch: 1,
    sequence: 1,
    revision: 1,
    lifecycle: 'FORMING',
    businessState: definition.machine.initial_state,
    creatorPrincipalId: definition.group.creator.principal_id,
    members: { [payload.member.principal_id]: [payload.member] },
    roleClaims: { [payload.role_claim.role]: [payload.role_claim] },
    stateImplementations: {},
    turns: {},
    activeTurnId: null,
    lastHandoff: null,
    lastHandoffHash: null,
    seenEventIds: [event.event_id],
    lastEventId: event.event_id,
    integrityStatus: 'OK',
    integrityMessage: null,
  };
  recomputeFormation(projection, definition);
  return projection;
}

export function reduceCollaborationEvent(
  current: CollaborationProjection | null,
  input: CollaborationEvent,
  definition: CollaborationRepositoryDefinition,
): CollaborationProjection {
  const event = collaborationEventSchema.parse(input);
  if (!current) return reduceGenesis(event, definition);
  if (current.integrityStatus !== 'OK')
    conflict('Quarantined projections cannot accept normal events');
  if (event.group_id !== current.groupId) conflict('Event group id changed');
  const resumeEpoch =
    event.event_type === 'group_resumed' ? current.epoch + 1 : current.epoch;
  if (event.epoch !== resumeEpoch) conflict('Event epoch is invalid');
  if (event.sequence !== current.sequence + 1)
    conflict('Event sequence is not contiguous');
  if (event.expected.state_revision !== current.revision)
    conflict('Expected revision is stale');
  if (current.seenEventIds.includes(event.event_id))
    conflict(`Duplicate event id: ${event.event_id}`);
  if (
    current.lifecycle === 'CLOSED' &&
    event.event_type !== 'protocol_recovery'
  )
    conflict('Closed groups are immutable');

  const next = structuredClone(current);
  switch (event.event_type) {
    case 'group_initialized':
      conflict('group_initialized may only be the genesis event');
    case 'member_registered': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const { member } = memberPayloadSchema.parse(event.payload);
      if (member.registered_at_event !== event.event_id)
        conflict('Member must reference its registration event');
      if (
        member.principal_id !== event.actor.principal_id ||
        member.agent_id !== event.actor.agent_id
      )
        conflict('Members may only register themselves');
      const members = next.members[member.principal_id] ?? [];
      if (members.some((candidate) => candidate.agent_id === member.agent_id))
        conflict('Member already exists');
      if (
        members.some(
          (candidate) =>
            candidate.signing_key_ref !== member.signing_key_ref ||
            candidate.signing_public_key !== member.signing_public_key,
        )
      )
        conflict('One principal must use one signing key');
      next.members[member.principal_id] = [...members, member];
      break;
    }
    case 'role_claimed': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const payload = rolePayloadSchema.parse(event.payload);
      const member = findCollaborationMember(
        next,
        payload.principal_id,
        payload.agent_id,
      );
      const role = definition.roles[payload.role];
      if (!member || !role)
        conflict('Role claim references an unknown member or role');
      if (
        payload.principal_id !== event.actor.principal_id ||
        payload.agent_id !== event.actor.agent_id
      )
        conflict('Members may only claim roles for their local identity');
      if (
        !role.required_capabilities.every((capability) =>
          member.capabilities.includes(capability),
        )
      )
        conflict(`Member lacks capabilities for role ${payload.role}`);
      const claims = next.roleClaims[payload.role] ?? [];
      if (claims.length >= role.cardinality.max)
        conflict(`Role claim exceeds max cardinality: ${payload.role}`);
      if (
        claims.some(
          (claim) =>
            claim.principal_id === payload.principal_id &&
            claim.agent_id === payload.agent_id,
        )
      )
        conflict('Role is already claimed by this identity');
      next.roleClaims[payload.role] = [
        ...claims,
        {
          format: 'icarus.agent-group-role-claim/2',
          ...payload,
          claimed_at_event: event.event_id,
        },
      ];
      break;
    }
    case 'role_released': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const payload = rolePayloadSchema.parse(event.payload);
      if (
        payload.principal_id !== event.actor.principal_id ||
        payload.agent_id !== event.actor.agent_id
      )
        conflict('Members may only release their own role');
      const claims = next.roleClaims[payload.role] ?? [];
      const remaining = claims.filter(
        (claim) =>
          claim.principal_id !== payload.principal_id ||
          claim.agent_id !== payload.agent_id,
      );
      if (remaining.length === claims.length)
        conflict('Role claim does not exist');
      next.roleClaims[payload.role] = remaining;
      for (const [stateId, stateImplementation] of Object.entries(
        next.stateImplementations,
      )) {
        if (
          stateImplementation.implementation.role === payload.role &&
          stateImplementation.implementation.owner.principal_id ===
            payload.principal_id &&
          stateImplementation.implementation.owner.agent_id === payload.agent_id
        )
          next.stateImplementations[stateId] = {
            ...stateImplementation,
            active: false,
          };
      }
      break;
    }
    case 'state_implementation_published':
    case 'state_implementation_revised': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const payload = implementationPayloadSchema.parse(event.payload);
      const implementation = payload.implementation;
      const state = definition.machine.states[implementation.state_id];
      if (!state || state.terminal || state.owner_role !== implementation.role)
        conflict(
          'State implementation ownership does not match the workflow skeleton',
        );
      if (
        implementation.owner.principal_id !== event.actor.principal_id ||
        implementation.owner.agent_id !== event.actor.agent_id ||
        implementation.published_at_event !== event.event_id
      )
        conflict('State implementation owner must match the event actor');
      if (
        !hasRoleClaim(
          next,
          implementation.role,
          event.actor.principal_id,
          event.actor.agent_id,
        )
      )
        conflict('State implementation actor does not hold its role');
      const exists = Boolean(
        next.stateImplementations[implementation.state_id],
      );
      if (event.event_type === 'state_implementation_published' && exists)
        conflict('State implementation already exists');
      if (event.event_type === 'state_implementation_revised' && !exists)
        conflict('State implementation does not exist');
      if (
        collaborationCanonicalHash(implementation) !==
        payload.implementation_hash
      )
        conflict('State implementation hash is invalid');
      if (implementation.mode === 'manual') {
        if (payload.action || payload.action_hash || payload.prompt_hash)
          conflict('Manual implementation cannot publish an action');
      } else {
        if (!payload.action || !payload.action_hash || !payload.prompt_hash)
          conflict('Executable implementation is incomplete');
        if (
          payload.action.role !== implementation.role ||
          payload.action.state_id !== implementation.state_id
        )
          conflict('Action ownership does not match implementation');
        if (implementation.action_ref !== payload.implementation.action_ref)
          conflict('Implementation action reference changed unexpectedly');
        if (collaborationCanonicalHash(payload.action) !== payload.action_hash)
          conflict('Action hash is invalid');
      }
      next.stateImplementations[implementation.state_id] = {
        active: true,
        implementation,
        implementationRef: payload.implementation_ref,
        implementationHash: payload.implementation_hash,
        action: payload.action,
        actionHash: payload.action_hash,
        promptHash: payload.prompt_hash,
        publishedEventId: event.event_id,
      };
      break;
    }
    case 'state_implementation_withdrawn': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const payload = implementationWithdrawalSchema.parse(event.payload);
      const active = next.stateImplementations[payload.state_id];
      if (!active || active.implementation.role !== payload.role)
        conflict('State implementation does not exist');
      if (
        !hasRoleClaim(
          next,
          payload.role,
          event.actor.principal_id,
          event.actor.agent_id,
        )
      )
        conflict('Only the current role owner can withdraw an implementation');
      delete next.stateImplementations[payload.state_id];
      break;
    }
    case 'group_started': {
      assertLifecycle(next, ['READY'], event);
      if (!collaborationReady(next, definition)) conflict('Group is not ready');
      const payload = startGroupPayloadSchema.parse(event.payload);
      if (
        payload.initial_handoff &&
        collaborationCanonicalHash(payload.initial_handoff) !==
          payload.initial_handoff_hash
      )
        conflict('Initial handoff hash is invalid');
      if (!payload.initial_handoff && payload.initial_handoff_hash)
        conflict('Initial handoff hash has no envelope');
      if (payload.initial_handoff) {
        const initialImplementation =
          next.stateImplementations[definition.machine.initial_state];
        assertHandoffDataMatchesResultSchema(
          initialImplementation?.action ?? null,
          payload.initial_handoff,
        );
      }
      next.lastHandoff = payload.initial_handoff;
      next.lastHandoffHash = payload.initial_handoff_hash;
      next.lifecycle = 'RUNNING';
      break;
    }
    case 'group_pause_requested':
      assertLifecycle(next, ['RUNNING'], event);
      next.lifecycle = 'PAUSING';
      break;
    case 'group_paused':
      assertLifecycle(next, ['PAUSING'], event);
      if (next.activeTurnId) {
        const turn = next.turns[next.activeTurnId];
        if (turn && !['COMPLETED', 'CANCELLED'].includes(turn.state))
          conflict('Cannot pause while a turn is active');
      }
      next.lifecycle = 'PAUSED';
      break;
    case 'group_resumed':
      assertLifecycle(next, ['PAUSED'], event);
      if (!collaborationReady(next, definition))
        conflict('Group is not ready to resume');
      next.epoch = event.epoch;
      next.lifecycle = 'RUNNING';
      break;
    case 'group_close_requested':
      assertLifecycle(next, ['RUNNING', 'PAUSED', 'FORMING', 'READY'], event);
      reasonPayloadSchema.parse(event.payload);
      next.lifecycle = 'CLOSING';
      break;
    case 'group_closed':
      assertLifecycle(next, ['CLOSING'], event);
      reasonPayloadSchema.parse(event.payload);
      if (next.activeTurnId) {
        const turn = next.turns[next.activeTurnId];
        if (turn && !['COMPLETED', 'CANCELLED'].includes(turn.state))
          conflict('Cannot close while a turn is active');
      }
      next.lifecycle = 'CLOSED';
      break;
    case 'turn_created': {
      assertLifecycle(next, ['RUNNING'], event);
      if (next.activeTurnId) conflict('Only one active turn is allowed');
      const payload = turnCreatedPayloadSchema.parse(event.payload);
      if (payload.state_id !== next.businessState)
        conflict('Turn state does not match current business state');
      const state = definition.machine.states[payload.state_id];
      const active = next.stateImplementations[payload.state_id];
      if (!state || state.terminal || !active?.active)
        conflict('Turn state has no active implementation');
      if (
        payload.role !== state.owner_role ||
        payload.role !== active.implementation.role ||
        payload.mode !== active.implementation.mode ||
        payload.implementation_ref !== active.implementationRef ||
        payload.implementation_hash !== active.implementationHash ||
        payload.action_ref !== active.implementation.action_ref ||
        payload.action_hash !== active.actionHash ||
        payload.prompt_hash !== active.promptHash
      )
        conflict('Turn implementation snapshot is stale');
      if (
        payload.incoming_handoff_hash !== next.lastHandoffHash ||
        JSON.stringify(payload.incoming_handoff) !==
          JSON.stringify(next.lastHandoff)
      )
        conflict('Turn incoming handoff snapshot is stale');
      const expectedMachineHash = collaborationCanonicalHash(
        definition.machine,
      );
      if (payload.machine_hash !== expectedMachineHash)
        conflict('Turn machine snapshot is stale');
      const expectedInputHash = collaborationCanonicalHash({
        epoch: next.epoch,
        machine_hash: payload.machine_hash,
        state_id: payload.state_id,
        role: payload.role,
        mode: payload.mode,
        implementation_hash: payload.implementation_hash,
        action_hash: payload.action_hash,
        prompt_hash: payload.prompt_hash,
        incoming_handoff_hash: payload.incoming_handoff_hash,
        timeout_policy_snapshot: payload.timeout_policy_snapshot,
        start_deadline_at: payload.start_deadline_at,
      });
      if (payload.input_hash !== expectedInputHash)
        conflict('Turn input hash is invalid');
      if (
        payload.idempotency_key !==
        collaborationIdempotencyKey({
          groupId: next.groupId,
          epoch: next.epoch,
          turnId: payload.turn_id,
          attempt: payload.attempt,
          inputHash: payload.input_hash,
        })
      )
        conflict('Turn idempotency key is invalid');
      if (next.turns[payload.turn_id]) conflict('Turn id already exists');
      const expectedPolicy = state.timeout_policy ?? null;
      if (
        canonicalJsonStringify(payload.timeout_policy_snapshot) !==
        canonicalJsonStringify(expectedPolicy)
      )
        conflict('Turn timeout policy snapshot is stale');
      const expectedStartDeadline = collaborationDeadlineAt(
        event.occurred_at,
        expectedPolicy?.start_timeout_ms,
      );
      if (payload.start_deadline_at !== expectedStartDeadline)
        conflict('Turn start deadline is invalid');
      const expectedDeadlineHash = collaborationDeadlineSnapshotHash({
        turnId: payload.turn_id,
        attempt: payload.attempt,
        timeoutPolicy: payload.timeout_policy_snapshot,
        startDeadlineAt: payload.start_deadline_at,
        startedAt: null,
        executionDeadlineAt: null,
      });
      if (payload.deadline_snapshot_hash !== expectedDeadlineHash)
        conflict('Turn deadline snapshot hash is invalid');
      next.turns[payload.turn_id] = {
        turnId: payload.turn_id,
        groupId: next.groupId,
        epoch: next.epoch,
        createdRevision: next.revision,
        createdAt: event.occurred_at,
        timeoutPolicy: payload.timeout_policy_snapshot,
        startDeadlineAt: payload.start_deadline_at,
        executionDeadlineAt: null,
        deadlineSnapshotHash: payload.deadline_snapshot_hash,
        startedAt: null,
        dispatchAcceptedAt: null,
        providerCompletedAt: null,
        awaitingConfirmationAt: null,
        completedAt: null,
        stateAdvancedAt: null,
        cancelledAt: null,
        recoveryRequestedAt: null,
        recoveredAt: null,
        timeoutObservations: [],
        machineHash: payload.machine_hash,
        stateId: payload.state_id,
        role: payload.role,
        mode: payload.mode,
        implementationRef: payload.implementation_ref,
        implementationHash: payload.implementation_hash,
        actionRef: payload.action_ref,
        actionHash: payload.action_hash,
        promptHash: payload.prompt_hash,
        incomingHandoff: payload.incoming_handoff,
        incomingHandoffHash: payload.incoming_handoff_hash,
        inputHash: payload.input_hash,
        attempt: payload.attempt,
        idempotencyKey: payload.idempotency_key,
        state: 'PENDING_START',
        claimEventId: null,
        claimantPrincipalId: null,
        claimantAgentId: null,
        fencingToken: null,
        executionRef: null,
        executorResultHash: null,
        executorResult: null,
        completionResultHash: null,
        handoff: null,
        handoffHash: null,
        artifacts: [],
        outcome: null,
        recoveryReason: null,
      };
      next.activeTurnId = payload.turn_id;
      break;
    }
    case 'turn_started': {
      assertLifecycle(next, ['RUNNING'], event);
      const payload = turnStartedPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (turn.state !== 'PENDING_START') conflict('Turn is not pending start');
      if (
        !hasRoleClaim(
          next,
          turn.role,
          event.actor.principal_id,
          event.actor.agent_id,
        )
      )
        conflict('Actor does not hold the turn role');
      const expectedFence = collaborationFencingToken({
        groupId: next.groupId,
        epoch: next.epoch,
        turnId: turn.turnId,
        attempt: turn.attempt,
        claimEventId: event.event_id,
        expectedRevision: event.expected.state_revision,
      });
      if (payload.fencing_token !== expectedFence)
        conflict(
          'Turn fencing token is not derived from the winning start event',
        );
      const expectedExecutionDeadline = collaborationDeadlineAt(
        event.occurred_at,
        turn.timeoutPolicy?.execution_timeout_ms,
      );
      if (payload.execution_deadline_at !== expectedExecutionDeadline)
        conflict('Turn execution deadline is invalid');
      const expectedDeadlineHash = collaborationDeadlineSnapshotHash({
        turnId: turn.turnId,
        attempt: turn.attempt,
        timeoutPolicy: turn.timeoutPolicy,
        startDeadlineAt: turn.startDeadlineAt,
        startedAt: event.occurred_at,
        executionDeadlineAt: payload.execution_deadline_at,
      });
      if (payload.deadline_snapshot_hash !== expectedDeadlineHash)
        conflict('Turn deadline snapshot hash is invalid');
      turn.claimEventId = event.event_id;
      turn.claimantPrincipalId = event.actor.principal_id;
      turn.claimantAgentId = event.actor.agent_id;
      turn.fencingToken = payload.fencing_token;
      turn.startedAt = event.occurred_at;
      turn.executionDeadlineAt = payload.execution_deadline_at;
      turn.deadlineSnapshotHash = payload.deadline_snapshot_hash;
      assertFence(turn, payload);
      turn.state = turn.mode === 'manual' ? 'IN_PROGRESS' : 'DISPATCHING';
      break;
    }
    case 'action_dispatched': {
      const payload = dispatchPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      assertClaimant(turn, event);
      if (turn.mode === 'manual' || turn.state !== 'DISPATCHING')
        conflict('Turn cannot dispatch an action');
      turn.executionRef = payload.execution_ref;
      turn.dispatchAcceptedAt = event.occurred_at;
      turn.state = 'RUNNING';
      break;
    }
    case 'action_waiting_input':
    case 'action_waiting_approval': {
      const payload = turnFencePayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      assertClaimant(turn, event);
      if (turn.mode === 'manual' || !turn.executionRef)
        conflict('Manual or undispatched turn cannot wait on an executor');
      turn.state =
        event.event_type === 'action_waiting_input'
          ? 'WAITING_INPUT'
          : 'WAITING_APPROVAL';
      break;
    }
    case 'action_completed': {
      const payload = actionCompletedPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      assertClaimant(turn, event);
      if (turn.mode === 'manual' || !turn.executionRef)
        conflict('Turn has no executor action');
      if (collaborationCanonicalHash(payload.result) !== payload.result_hash)
        conflict('Executor result hash is invalid');
      turn.executorResult = payload.result;
      turn.executorResultHash = payload.result_hash;
      turn.providerCompletedAt = event.occurred_at;
      turn.awaitingConfirmationAt = event.occurred_at;
      const suggestedOutcome =
        typeof payload.result.data === 'object' &&
        payload.result.data !== null &&
        typeof (payload.result.data as Record<string, unknown>).outcome ===
          'string'
          ? String((payload.result.data as Record<string, unknown>).outcome)
          : typeof payload.result.outcome === 'string'
            ? payload.result.outcome
            : '';
      const legal = definition.machine.states[turn.stateId]?.transitions.some(
        (route) => route.outcome === suggestedOutcome,
      );
      turn.state =
        turn.mode === 'automatic' && !legal
          ? 'RECOVERY_REQUIRED'
          : 'AWAITING_CONFIRMATION';
      if (turn.state === 'RECOVERY_REQUIRED')
        turn.recoveryReason = `Automatic executor returned illegal outcome: ${suggestedOutcome}`;
      break;
    }
    case 'turn_completed': {
      const payload = turnCompletedPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      assertClaimant(turn, event);
      const allowedStates =
        turn.mode === 'manual' ? ['IN_PROGRESS'] : ['AWAITING_CONFIRMATION'];
      if (!allowedStates.includes(turn.state))
        conflict('Turn is not ready for completion');
      if (
        payload.handoff.source_turn_id !== turn.turnId ||
        payload.handoff.outcome !== payload.outcome
      )
        conflict('Handoff source and outcome are runtime-owned');
      if (collaborationCanonicalHash(payload.handoff) !== payload.handoff_hash)
        conflict('Handoff hash is invalid');
      const activeImplementation = next.stateImplementations[turn.stateId];
      if (
        !activeImplementation ||
        !activeImplementation.active ||
        activeImplementation.actionHash !== turn.actionHash
      )
        conflict('Turn implementation is no longer active');
      assertHandoffDataMatchesResultSchema(
        activeImplementation.action,
        payload.handoff,
      );
      const handoffArtifactRefs = [...payload.handoff.artifact_refs].sort();
      const materializedArtifactRefs = payload.artifacts
        .map((artifact) => artifact.repository_path)
        .sort();
      if (
        JSON.stringify(handoffArtifactRefs) !==
        JSON.stringify(materializedArtifactRefs)
      )
        conflict('Handoff artifact refs do not match completion artifacts');
      for (const artifact of payload.artifacts) {
        if (
          artifact.turn_id !== turn.turnId ||
          artifact.uploaded_by_principal_id !== event.actor.principal_id ||
          artifact.uploaded_by_agent_id !== event.actor.agent_id ||
          !artifact.repository_path.startsWith(`artifacts/${turn.turnId}/`)
        )
          conflict('Artifact ownership is invalid');
      }
      const result = {
        outcome: payload.outcome,
        handoff_hash: payload.handoff_hash,
        artifacts: payload.artifacts,
      };
      if (collaborationCanonicalHash(result) !== payload.result_hash)
        conflict('Completion result hash is invalid');
      const route = definition.machine.states[turn.stateId]?.transitions.find(
        (candidate) => candidate.outcome === payload.outcome,
      );
      if (!route)
        conflict(
          `Outcome is not allowed for state ${turn.stateId}: ${payload.outcome}`,
        );
      turn.state = 'COMPLETED';
      turn.completedAt = event.occurred_at;
      turn.stateAdvancedAt = event.occurred_at;
      turn.outcome = payload.outcome;
      turn.completionResultHash = payload.result_hash;
      turn.handoff = payload.handoff;
      turn.handoffHash = payload.handoff_hash;
      turn.artifacts = payload.artifacts;
      next.businessState = route.target_state;
      next.lastHandoff = payload.handoff;
      next.lastHandoffHash = payload.handoff_hash;
      next.activeTurnId = null;
      break;
    }
    case 'turn_cancelled': {
      const payload = turnCancelledPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (turn.attempt !== payload.attempt)
        conflict(`Turn attempt is stale: ${payload.turn_id}`);
      if (turn.state === 'PENDING_START') {
        if (payload.fencing_token !== null)
          conflict(
            'An unstarted turn must be cancelled without a fencing token',
          );
      } else {
        if (payload.fencing_token === null)
          conflict('A started turn cancellation requires its fencing token');
        assertFence(turn, {
          ...payload,
          fencing_token: payload.fencing_token,
        });
      }
      turn.state = 'CANCELLED';
      turn.cancelledAt = event.occurred_at;
      turn.recoveryReason = payload.reason;
      next.activeTurnId = null;
      break;
    }
    case 'turn_recovery_requested': {
      const payload = recoveryPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      turn.state = 'RECOVERY_REQUIRED';
      turn.recoveryReason = payload.reason;
      turn.recoveryRequestedAt = event.occurred_at;
      break;
    }
    case 'turn_recovered': {
      const payload = turnRecoveredPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (
        turn.state !== 'RECOVERY_REQUIRED' ||
        payload.attempt !== turn.attempt + 1 ||
        payload.fencing_token !== turn.fencingToken
      )
        conflict('Turn recovery attempt or prior fence is invalid');
      const expectedStartDeadline = collaborationDeadlineAt(
        event.occurred_at,
        turn.timeoutPolicy?.start_timeout_ms,
      );
      if (payload.start_deadline_at !== expectedStartDeadline)
        conflict('Recovered turn start deadline is invalid');
      const expectedDeadlineHash = collaborationDeadlineSnapshotHash({
        turnId: turn.turnId,
        attempt: payload.attempt,
        timeoutPolicy: turn.timeoutPolicy,
        startDeadlineAt: payload.start_deadline_at,
        startedAt: null,
        executionDeadlineAt: null,
      });
      if (payload.deadline_snapshot_hash !== expectedDeadlineHash)
        conflict('Recovered turn deadline snapshot hash is invalid');
      turn.attempt = payload.attempt;
      turn.idempotencyKey = collaborationIdempotencyKey({
        groupId: next.groupId,
        epoch: next.epoch,
        turnId: turn.turnId,
        attempt: turn.attempt,
        inputHash: turn.inputHash,
      });
      turn.state = 'PENDING_START';
      turn.startDeadlineAt = payload.start_deadline_at;
      turn.executionDeadlineAt = null;
      turn.deadlineSnapshotHash = payload.deadline_snapshot_hash;
      turn.startedAt = null;
      turn.dispatchAcceptedAt = null;
      turn.providerCompletedAt = null;
      turn.awaitingConfirmationAt = null;
      turn.completedAt = null;
      turn.stateAdvancedAt = null;
      turn.cancelledAt = null;
      turn.recoveredAt = event.occurred_at;
      turn.claimEventId = null;
      turn.claimantPrincipalId = null;
      turn.claimantAgentId = null;
      turn.fencingToken = null;
      turn.executionRef = null;
      turn.executorResult = null;
      turn.executorResultHash = null;
      turn.recoveryReason = payload.reason;
      break;
    }
    case 'turn_timeout_observed': {
      const payload = timeoutObservedPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (turn.attempt !== payload.attempt)
        conflict(`Turn attempt is stale: ${payload.turn_id}`);
      if (['COMPLETED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(turn.state))
        conflict(
          'A terminal or recovery-required turn cannot observe a timeout',
        );
      const deadline =
        payload.deadline_kind === 'start'
          ? turn.startDeadlineAt
          : turn.executionDeadlineAt;
      if (!deadline || deadline !== payload.deadline_at)
        conflict('Timeout deadline does not match the turn snapshot');
      if (payload.deadline_kind === 'start' && turn.state !== 'PENDING_START')
        conflict('Start timeout requires a pending turn');
      if (
        payload.deadline_kind === 'execution' &&
        turn.state === 'PENDING_START'
      )
        conflict('Execution timeout requires a started turn');
      if (payload.turn_snapshot_hash !== turn.deadlineSnapshotHash)
        conflict('Timeout observation uses a stale turn snapshot');
      if (
        turn.timeoutObservations.some(
          (observation) =>
            observation.attempt === payload.attempt &&
            observation.deadlineKind === payload.deadline_kind,
        )
      )
        conflict('Timeout observation already exists');
      turn.timeoutObservations.push({
        attempt: payload.attempt,
        deadlineKind: payload.deadline_kind,
        deadlineAt: payload.deadline_at,
        observedAt: payload.observed_at,
        turnSnapshotHash: payload.turn_snapshot_hash,
        actorPrincipalId: event.actor.principal_id,
        actorAgentId: event.actor.agent_id,
        eventId: event.event_id,
        sequence: event.sequence,
      });
      break;
    }
    case 'data_updated': {
      const payload = dataUpdatePayloadSchema.parse(event.payload);
      if (payload.turn_id) {
        const turn = activeTurn(next, payload.turn_id);
        assertFence(turn, payload as z.infer<typeof turnFencePayloadSchema>);
        assertClaimant(turn, event);
      }
      break;
    }
    case 'protocol_recovery':
      reasonPayloadSchema.parse(event.payload);
      break;
  }
  recomputeFormation(next, definition);
  next.epoch = event.epoch;
  next.sequence = event.sequence;
  next.revision += 1;
  next.lastEventId = event.event_id;
  next.seenEventIds.push(event.event_id);
  return next;
}

export function reduceCollaborationEvents(
  events: readonly CollaborationEvent[],
  definition: CollaborationRepositoryDefinition,
): CollaborationProjection {
  return events.reduce<CollaborationProjection | null>(
    (projection, event) =>
      reduceCollaborationEvent(projection, event, definition),
    null,
  )!;
}

export function deterministicProjectionJson(
  projection: CollaborationProjection,
): string {
  return `${canonicalJsonStringify(projection)}\n`;
}
