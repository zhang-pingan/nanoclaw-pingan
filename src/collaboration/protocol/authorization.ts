import {
  dataUpdatePayloadSchema,
  memberDefinitionSchema,
  stateImplementationSchema,
  type CollaborationEvent,
} from './schema.js';
import {
  findCollaborationMember,
  hasRoleClaim,
  type CollaborationProjection,
} from './reducer.js';
import { CollaborationProtocolError } from './version.js';

export interface VerifiedCommitSigner {
  readonly principalId: string;
  readonly signingKeyRef: string;
}

const creatorOnly = new Set<CollaborationEvent['event_type']>([
  'machine_revised',
  'machine_layout_updated',
  'group_started',
  'group_pause_requested',
  'group_paused',
  'group_resumed',
  'group_close_requested',
  'group_closed',
  'turn_created',
  'turn_cancelled',
  'turn_recovered',
  'protocol_recovery',
]);
const claimantOnly = new Set<CollaborationEvent['event_type']>([
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_completed',
  'turn_completed',
]);

function unauthorized(message: string): never {
  throw new CollaborationProtocolError('EVENT_UNAUTHORIZED', message);
}

export function authorizeCollaborationEvent(
  event: CollaborationEvent,
  projection: CollaborationProjection | null,
  signer: VerifiedCommitSigner,
): void {
  if (signer.principalId !== event.actor.principal_id)
    unauthorized('Git signer principal does not match event actor');
  if (!projection) {
    if (event.event_type !== 'group_initialized')
      unauthorized('Only group_initialized may create a collaboration history');
    const member = memberDefinitionSchema.parse(event.payload.member);
    if (
      member.principal_id !== signer.principalId ||
      member.signing_key_ref !== signer.signingKeyRef
    )
      unauthorized('Genesis signer does not match the creator member');
    return;
  }
  if (event.event_type === 'member_registered') {
    const member = memberDefinitionSchema.parse(event.payload.member);
    if (
      member.principal_id !== signer.principalId ||
      member.signing_key_ref !== signer.signingKeyRef
    )
      unauthorized(
        'Member registration must be self-signed by the declared key',
      );
    return;
  }
  const member = findCollaborationMember(
    projection,
    event.actor.principal_id,
    event.actor.agent_id,
  );
  if (!member || member.signing_key_ref !== signer.signingKeyRef)
    unauthorized('Git signer is not a registered collaboration member');
  if (creatorOnly.has(event.event_type)) {
    if (event.actor.principal_id !== projection.creatorPrincipalId)
      unauthorized(`${event.event_type} is restricted to the group creator`);
    return;
  }
  if (event.event_type === 'role_claimed') return;
  if (event.event_type === 'role_released') {
    if (
      event.payload.principal_id !== event.actor.principal_id ||
      event.payload.agent_id !== event.actor.agent_id
    )
      unauthorized('Members may only release their own role claim');
    return;
  }
  if (
    event.event_type === 'state_implementation_published' ||
    event.event_type === 'state_implementation_revised'
  ) {
    const implementation = stateImplementationSchema.parse(
      event.payload.implementation,
    );
    if (
      implementation.owner.principal_id !== event.actor.principal_id ||
      implementation.owner.agent_id !== event.actor.agent_id ||
      !hasRoleClaim(
        projection,
        implementation.role,
        event.actor.principal_id,
        event.actor.agent_id,
      )
    )
      unauthorized(
        'Only the current role owner may publish its state implementation',
      );
    return;
  }
  if (event.event_type === 'state_implementation_withdrawn') {
    const role = event.payload.role;
    if (
      typeof role !== 'string' ||
      !hasRoleClaim(
        projection,
        role,
        event.actor.principal_id,
        event.actor.agent_id,
      )
    )
      unauthorized(
        'Only the current role owner may withdraw its state implementation',
      );
    return;
  }
  if (event.event_type === 'turn_started') {
    const turnId = event.payload.turn_id;
    const turn = typeof turnId === 'string' ? projection.turns[turnId] : null;
    if (
      !turn ||
      !hasRoleClaim(
        projection,
        turn.role,
        event.actor.principal_id,
        event.actor.agent_id,
      )
    )
      unauthorized('Actor does not hold the turn role');
    return;
  }
  if (event.event_type === 'turn_recovery_requested') {
    const turnId = event.payload.turn_id;
    const turn = typeof turnId === 'string' ? projection.turns[turnId] : null;
    const creator = event.actor.principal_id === projection.creatorPrincipalId;
    const claimant =
      turn?.claimantPrincipalId === event.actor.principal_id &&
      turn.claimantAgentId === event.actor.agent_id &&
      event.payload.attempt === turn.attempt &&
      event.payload.fencing_token === turn.fencingToken;
    if (!turn || (!creator && !claimant))
      unauthorized(
        'Only the group creator or current fenced claimant may request turn recovery',
      );
    return;
  }
  if (event.event_type === 'turn_timeout_observed') {
    const turnId = event.payload.turn_id;
    const turn = typeof turnId === 'string' ? projection.turns[turnId] : null;
    const kind = event.payload.deadline_kind;
    const creator = event.actor.principal_id === projection.creatorPrincipalId;
    const roleOwner = Boolean(
      turn &&
      hasRoleClaim(
        projection,
        turn.role,
        event.actor.principal_id,
        event.actor.agent_id,
      ),
    );
    const claimant = Boolean(
      turn &&
      turn.claimantPrincipalId === event.actor.principal_id &&
      turn.claimantAgentId === event.actor.agent_id,
    );
    if (
      !turn ||
      (kind !== 'start' && kind !== 'execution') ||
      (!creator && (kind === 'start' ? !roleOwner : !claimant))
    )
      unauthorized(
        'Timeout observation requires the creator, pending Role Owner, or current claimant',
      );
    return;
  }
  if (claimantOnly.has(event.event_type)) {
    const turnId = event.payload.turn_id;
    const turn = typeof turnId === 'string' ? projection.turns[turnId] : null;
    if (
      !turn ||
      turn.claimantPrincipalId !== event.actor.principal_id ||
      turn.claimantAgentId !== event.actor.agent_id ||
      event.payload.attempt !== turn.attempt ||
      event.payload.fencing_token !== turn.fencingToken
    )
      unauthorized(
        'Only the current claimant and fenced attempt may update the turn',
      );
    return;
  }
  if (event.event_type === 'data_updated') {
    const payload = dataUpdatePayloadSchema.parse(event.payload);
    if (payload.turn_id) {
      const turn = projection.turns[payload.turn_id];
      if (
        !turn ||
        turn.claimantPrincipalId !== event.actor.principal_id ||
        turn.claimantAgentId !== event.actor.agent_id ||
        payload.attempt !== turn.attempt ||
        payload.fencing_token !== turn.fencingToken
      )
        unauthorized('Only the current claimant may update turn-scoped data');
    }
    return;
  }
  unauthorized(`No authorization rule exists for ${event.event_type}`);
}
