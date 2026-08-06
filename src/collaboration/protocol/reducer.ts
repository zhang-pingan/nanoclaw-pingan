import crypto from 'node:crypto';

import { z } from 'zod';

import {
  collaborationEventSchema,
  memberDefinitionSchema,
  roleClaimSchema,
  sha256,
  type CollaborationEvent,
  type CollaborationRepositoryDefinition,
  type MemberDefinition,
  type RoleClaim,
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
  | 'WAITING'
  | 'CLAIMED'
  | 'DISPATCHING'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'WAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export interface CollaborationTurn {
  readonly turnId: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly createdRevision: number;
  readonly transitionId: string;
  readonly actionId: string;
  readonly role: string;
  attempt: number;
  idempotencyKey: string;
  readonly inputHash: string;
  state: CollaborationTurnState;
  claimEventId: string | null;
  claimantPrincipalId: string | null;
  claimantAgentId: string | null;
  fencingToken: string | null;
  executionRef: string | null;
  resultHash: string | null;
  artifactRefs: string[];
  recoveryReason: string | null;
}

export interface CollaborationProjection {
  readonly format: 'icarus.agent-group-projection/1';
  readonly protocolVersion: 1;
  readonly groupId: string;
  epoch: number;
  sequence: number;
  revision: number;
  lifecycle: CollaborationLifecycle;
  businessState: string;
  readonly creatorPrincipalId: string;
  members: Record<string, MemberDefinition[]>;
  roleClaims: Record<string, RoleClaim[]>;
  turns: Record<string, CollaborationTurn>;
  activeTurnId: string | null;
  seenEventIds: string[];
  lastEventId: string;
  integrityStatus: 'OK' | 'PROTOCOL_QUARANTINED';
  integrityMessage: string | null;
}

const genesisPayloadSchema = z
  .object({
    member: memberDefinitionSchema,
    role_claim: roleClaimSchema,
  })
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
const turnCreatedPayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    transition_id: z.string().min(1),
    action_id: z.string().min(1),
    role: z.string().min(1),
    attempt: z.number().int().positive(),
    idempotency_key: sha256,
    input_hash: sha256,
  })
  .strict();
const turnFencePayloadSchema = z
  .object({
    turn_id: z.string().min(1),
    attempt: z.number().int().positive(),
    fencing_token: sha256,
  })
  .strict();
const dispatchPayloadSchema = turnFencePayloadSchema
  .extend({ execution_ref: z.string().min(1).max(255) })
  .strict();
const terminalPayloadSchema = turnFencePayloadSchema
  .extend({
    result_hash: sha256,
    artifact_refs: z.array(z.string().min(1).max(512)).default([]),
  })
  .strict();
const transitionPayloadSchema = turnFencePayloadSchema
  .extend({
    outcome: z.string().min(1),
    from_state: z.string().min(1),
    to_state: z.string().min(1),
  })
  .strict();
const reasonPayloadSchema = z
  .object({ reason: z.string().min(1).max(4000) })
  .strict();
const recoveryPayloadSchema = turnFencePayloadSchema
  .extend({ reason: z.string().min(1).max(4000) })
  .strict();

function conflict(message: string): never {
  throw new CollaborationProtocolError('EVENT_CONFLICT', message);
}

function hash(parts: readonly (string | number)[]): string {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

export function collaborationIdempotencyKey(input: {
  readonly groupId: string;
  readonly epoch: number;
  readonly turnId: string;
  readonly attempt: number;
  readonly inputHash: string;
}): string {
  return hash([
    'icarus-collaboration-action-v1',
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
  return hash([
    'icarus-collaboration-fence-v1',
    input.groupId,
    input.epoch,
    input.turnId,
    input.attempt,
    input.claimEventId,
    input.expectedRevision,
  ]);
}

function cloneProjection(
  projection: CollaborationProjection,
): CollaborationProjection {
  return structuredClone(projection);
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

function requiredRolesSatisfied(
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
): boolean {
  return definition.group.required_roles.every((requirement) => {
    const claims = projection.roleClaims[requirement.role] ?? [];
    return claims.length >= requirement.min_members;
  });
}

function recomputeFormation(
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
): void {
  if (projection.lifecycle !== 'FORMING' && projection.lifecycle !== 'READY')
    return;
  projection.lifecycle = requiredRolesSatisfied(projection, definition)
    ? 'READY'
    : 'FORMING';
}

function findTransition(
  projection: CollaborationProjection,
  definition: CollaborationRepositoryDefinition,
  transitionId: string,
) {
  return definition.machine.states[projection.businessState]?.transitions.find(
    (transition) => transition.id === transitionId,
  );
}

function activeTurn(
  projection: CollaborationProjection,
  turnId: string,
): CollaborationTurn {
  const turn = projection.turns[turnId];
  if (!turn) conflict(`Turn does not exist: ${turnId}`);
  if (projection.activeTurnId !== turnId)
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

function terminalTurnState(state: CollaborationTurnState): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
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
  const role = definition.roles[payload.role_claim.role];
  if (!role)
    conflict(`Genesis role is not defined: ${payload.role_claim.role}`);
  const projection: CollaborationProjection = {
    format: 'icarus.agent-group-projection/1',
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    groupId: event.group_id,
    epoch: event.epoch,
    sequence: event.sequence,
    revision: 1,
    lifecycle: 'FORMING',
    businessState: definition.machine.initial_state,
    creatorPrincipalId: definition.group.creator.principal_id,
    members: { [payload.member.principal_id]: [payload.member] },
    roleClaims: { [payload.role_claim.role]: [payload.role_claim] },
    turns: {},
    activeTurnId: null,
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
  if (event.epoch !== current.epoch)
    conflict('Event epoch changed unexpectedly');
  if (event.sequence !== current.sequence + 1)
    conflict(`Event sequence is not contiguous: ${String(event.sequence)}`);
  if (event.expected.state_revision !== current.revision)
    conflict(
      `Expected revision ${String(event.expected.state_revision)} does not match ${String(current.revision)}`,
    );
  if (current.seenEventIds.includes(event.event_id))
    conflict(`Duplicate event id: ${event.event_id}`);
  if (
    current.lifecycle === 'CLOSED' &&
    event.event_type !== 'protocol_recovery'
  )
    conflict('Closed groups are immutable');

  const next = cloneProjection(current);
  switch (event.event_type) {
    case 'group_initialized':
      conflict('group_initialized may only be the genesis event');
    case 'member_registered': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const { member } = memberPayloadSchema.parse(event.payload);
      if (member.registered_at_event !== event.event_id)
        conflict('Member registration must reference its event');
      if (
        member.principal_id !== event.actor.principal_id ||
        member.agent_id !== event.actor.agent_id
      )
        conflict('Members may only register themselves');
      const principalMembers = next.members[member.principal_id] ?? [];
      if (
        principalMembers.some(
          (candidate) => candidate.agent_id === member.agent_id,
        )
      )
        conflict(
          `Member already exists: ${member.principal_id}/${member.agent_id}`,
        );
      if (
        principalMembers.some(
          (candidate) =>
            candidate.signing_key_ref !== member.signing_key_ref ||
            candidate.signing_public_key !== member.signing_public_key,
        )
      )
        conflict('Agents for one principal must use the same signing key');
      principalMembers.push(member);
      next.members[member.principal_id] = principalMembers;
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
        conflict('Members may only claim a role for their own agent');
      if (!member.capabilities.includes(role.executor_requirements.capability))
        conflict(`Member lacks capability for role ${payload.role}`);
      const claims = next.roleClaims[payload.role] ?? [];
      if (
        claims.some(
          (claim) =>
            claim.principal_id === payload.principal_id &&
            claim.agent_id === payload.agent_id,
        )
      )
        conflict(
          `Role is already claimed by ${payload.principal_id}/${payload.agent_id}`,
        );
      if (claims.length >= role.cardinality.max)
        conflict(`Role cardinality is full: ${payload.role}`);
      claims.push(
        roleClaimSchema.parse({
          format: 'icarus.agent-group-role-claim/1',
          role: payload.role,
          principal_id: payload.principal_id,
          agent_id: payload.agent_id,
          claimed_at_event: event.event_id,
        }),
      );
      next.roleClaims[payload.role] = claims;
      recomputeFormation(next, definition);
      break;
    }
    case 'role_released': {
      assertLifecycle(next, ['FORMING', 'READY', 'PAUSED'], event);
      const payload = rolePayloadSchema.parse(event.payload);
      if (
        (payload.principal_id !== event.actor.principal_id ||
          payload.agent_id !== event.actor.agent_id) &&
        event.actor.principal_id !== next.creatorPrincipalId
      )
        conflict('Only the claimant or creator can release a role');
      const claims = next.roleClaims[payload.role] ?? [];
      const filtered = claims.filter(
        (claim) =>
          claim.principal_id !== payload.principal_id ||
          claim.agent_id !== payload.agent_id,
      );
      if (filtered.length === claims.length)
        conflict('Role claim does not exist');
      next.roleClaims[payload.role] = filtered;
      recomputeFormation(next, definition);
      break;
    }
    case 'group_ready':
      assertLifecycle(next, ['READY'], event);
      if (!requiredRolesSatisfied(next, definition))
        conflict('Required roles are not satisfied');
      break;
    case 'group_started':
      assertLifecycle(next, ['READY'], event);
      if (!requiredRolesSatisfied(next, definition))
        conflict('Required roles are not satisfied');
      next.lifecycle = 'RUNNING';
      break;
    case 'group_pause_requested':
      assertLifecycle(next, ['RUNNING'], event);
      next.lifecycle = 'PAUSING';
      break;
    case 'group_paused':
      assertLifecycle(next, ['PAUSING'], event);
      if (
        next.activeTurnId &&
        !terminalTurnState(next.turns[next.activeTurnId]?.state)
      )
        conflict('Cannot finish pause while an active turn is not terminal');
      next.lifecycle = 'PAUSED';
      break;
    case 'group_resumed':
      assertLifecycle(next, ['PAUSED'], event);
      next.lifecycle = 'RUNNING';
      break;
    case 'group_close_requested':
      assertLifecycle(next, ['READY', 'RUNNING', 'PAUSED'], event);
      reasonPayloadSchema.parse(event.payload);
      next.lifecycle = 'CLOSING';
      break;
    case 'group_closed':
      assertLifecycle(next, ['CLOSING'], event);
      reasonPayloadSchema.parse(event.payload);
      if (
        next.activeTurnId &&
        !terminalTurnState(next.turns[next.activeTurnId]?.state)
      )
        conflict('Cannot close while an active turn is not terminal');
      next.lifecycle = 'CLOSED';
      break;
    case 'turn_created': {
      assertLifecycle(next, ['RUNNING'], event);
      if (next.activeTurnId) conflict('Only one active turn is allowed');
      const payload = turnCreatedPayloadSchema.parse(event.payload);
      if (next.turns[payload.turn_id])
        conflict(`Turn already exists: ${payload.turn_id}`);
      const transition = findTransition(
        next,
        definition,
        payload.transition_id,
      );
      if (!transition)
        conflict('Transition is not available from the current state');
      const actionId = transition.action_ref
        .replace(/^actions\//, '')
        .replace(/\.yaml$/, '');
      if (
        payload.role !== transition.actor_role ||
        payload.action_id !== actionId ||
        payload.attempt !== 1
      )
        conflict('Turn does not match the selected transition');
      const expectedKey = collaborationIdempotencyKey({
        groupId: next.groupId,
        epoch: next.epoch,
        turnId: payload.turn_id,
        attempt: payload.attempt,
        inputHash: payload.input_hash,
      });
      if (expectedKey !== payload.idempotency_key)
        conflict('Turn idempotency key is not deterministic');
      next.turns[payload.turn_id] = {
        turnId: payload.turn_id,
        groupId: next.groupId,
        epoch: next.epoch,
        createdRevision: next.revision,
        transitionId: payload.transition_id,
        actionId: payload.action_id,
        role: payload.role,
        attempt: payload.attempt,
        idempotencyKey: payload.idempotency_key,
        inputHash: payload.input_hash,
        state: 'WAITING',
        claimEventId: null,
        claimantPrincipalId: null,
        claimantAgentId: null,
        fencingToken: null,
        executionRef: null,
        resultHash: null,
        artifactRefs: [],
        recoveryReason: null,
      };
      next.activeTurnId = payload.turn_id;
      break;
    }
    case 'turn_claimed': {
      assertLifecycle(next, ['RUNNING'], event);
      const payload = turnFencePayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (turn.state !== 'WAITING') conflict('Turn is not waiting for a claim');
      if (turn.attempt !== payload.attempt) conflict('Turn attempt is stale');
      const claim = (next.roleClaims[turn.role] ?? []).find(
        (candidate) =>
          candidate.principal_id === event.actor.principal_id &&
          candidate.agent_id === event.actor.agent_id,
      );
      if (!claim) conflict('Actor does not hold the required role');
      const expectedFence = collaborationFencingToken({
        groupId: next.groupId,
        epoch: next.epoch,
        turnId: turn.turnId,
        attempt: turn.attempt,
        claimEventId: event.event_id,
        expectedRevision: event.expected.state_revision,
      });
      if (expectedFence !== payload.fencing_token)
        conflict('Turn fencing token is not deterministic');
      turn.state = 'CLAIMED';
      turn.claimEventId = event.event_id;
      turn.claimantPrincipalId = event.actor.principal_id;
      turn.claimantAgentId = event.actor.agent_id;
      turn.fencingToken = payload.fencing_token;
      break;
    }
    case 'action_dispatched': {
      const payload = dispatchPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      if (turn.state !== 'CLAIMED')
        conflict('Only a claimed turn can be dispatched');
      turn.state = 'RUNNING';
      turn.executionRef = payload.execution_ref;
      break;
    }
    case 'action_waiting_input':
    case 'action_waiting_approval': {
      const payload = turnFencePayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      if (
        !['RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(turn.state)
      )
        conflict('Turn cannot enter a waiting state');
      turn.state =
        event.event_type === 'action_waiting_input'
          ? 'WAITING_INPUT'
          : 'WAITING_APPROVAL';
      break;
    }
    case 'action_succeeded':
    case 'action_failed':
    case 'action_cancelled': {
      const payload = terminalPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      if (
        !['RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(turn.state)
      )
        conflict('Turn is not executing');
      turn.state =
        event.event_type === 'action_succeeded'
          ? 'SUCCEEDED'
          : event.event_type === 'action_failed'
            ? 'FAILED'
            : 'CANCELLED';
      turn.resultHash = payload.result_hash;
      turn.artifactRefs = [...payload.artifact_refs];
      break;
    }
    case 'state_transitioned': {
      const payload = transitionPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      if (!terminalTurnState(turn.state))
        conflict('Only a terminal action can transition business state');
      if (payload.from_state !== next.businessState)
        conflict('Transition source state is stale');
      const transition = findTransition(next, definition, turn.transitionId);
      const expectedDestination = transition?.outcomes[payload.outcome];
      if (!expectedDestination || expectedDestination !== payload.to_state)
        conflict('Outcome does not map to the requested destination');
      next.businessState = payload.to_state;
      next.activeTurnId = null;
      break;
    }
    case 'stalled_turn_recovery_requested': {
      const payload = recoveryPayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      assertFence(turn, payload);
      if (terminalTurnState(turn.state))
        conflict('Terminal turns do not need recovery');
      turn.state = 'RECOVERY_REQUIRED';
      turn.recoveryReason = payload.reason;
      break;
    }
    case 'turn_recovered': {
      const payload = turnFencePayloadSchema.parse(event.payload);
      const turn = activeTurn(next, payload.turn_id);
      if (turn.state !== 'RECOVERY_REQUIRED')
        conflict('Turn is not awaiting recovery');
      if (payload.attempt !== turn.attempt + 1)
        conflict('Recovered turn must increment attempt exactly once');
      turn.attempt = payload.attempt;
      turn.idempotencyKey = collaborationIdempotencyKey({
        groupId: next.groupId,
        epoch: next.epoch,
        turnId: turn.turnId,
        attempt: turn.attempt,
        inputHash: turn.inputHash,
      });
      turn.state = 'WAITING';
      turn.claimEventId = null;
      turn.claimantPrincipalId = null;
      turn.claimantAgentId = null;
      turn.fencingToken = null;
      turn.executionRef = null;
      turn.resultHash = null;
      turn.artifactRefs = [];
      turn.recoveryReason = null;
      break;
    }
    case 'data_updated':
    case 'artifact_published':
      break;
    case 'protocol_recovery': {
      const payload = z
        .object({
          last_valid_event_id: z.string().min(1),
          disposition: z.enum(['resume', 'close']),
          reason: z.string().min(1),
        })
        .strict()
        .parse(event.payload);
      if (payload.last_valid_event_id !== current.lastEventId)
        conflict('Protocol recovery did not name the last valid event');
      if (payload.disposition === 'close') next.lifecycle = 'CLOSED';
      next.integrityStatus = 'OK';
      next.integrityMessage = null;
      break;
    }
  }

  next.sequence = event.sequence;
  next.revision += 1;
  next.seenEventIds.push(event.event_id);
  next.lastEventId = event.event_id;
  return next;
}

export function replayCollaborationEvents(
  events: readonly CollaborationEvent[],
  definition: CollaborationRepositoryDefinition,
): CollaborationProjection {
  let projection: CollaborationProjection | null = null;
  for (const event of events)
    projection = reduceCollaborationEvent(projection, event, definition);
  if (!projection) conflict('Collaboration history is empty');
  return projection;
}

export function deterministicProjectionJson(
  projection: CollaborationProjection,
): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    return value;
  };
  return `${JSON.stringify(sort(projection), null, 2)}\n`;
}
