import { memberDefinitionSchema, type CollaborationEvent } from './schema.js';
import type { CollaborationProjection } from './reducer.js';
import { CollaborationProtocolError } from './version.js';

export interface VerifiedCommitSigner {
  readonly principalId: string;
  readonly signingKeyRef: string;
}

const creatorOnly = new Set<CollaborationEvent['event_type']>([
  'group_ready',
  'group_started',
  'group_pause_requested',
  'group_paused',
  'group_resumed',
  'group_close_requested',
  'group_closed',
  'turn_created',
  'stalled_turn_recovery_requested',
  'turn_recovered',
  'protocol_recovery',
]);
const claimantOnly = new Set<CollaborationEvent['event_type']>([
  'action_dispatched',
  'action_waiting_input',
  'action_waiting_approval',
  'action_succeeded',
  'action_failed',
  'action_cancelled',
  'state_transitioned',
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
    const payload = event.payload.member;
    const member = memberDefinitionSchema.parse(payload);
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

  const member = projection.members[event.actor.principal_id];
  if (!member || member.signing_key_ref !== signer.signingKeyRef)
    unauthorized('Git signer is not a registered collaboration member');

  if (creatorOnly.has(event.event_type)) {
    if (event.actor.principal_id !== projection.creatorPrincipalId)
      unauthorized(`${event.event_type} is restricted to the group creator`);
    return;
  }

  if (event.event_type === 'role_claimed') return;
  if (event.event_type === 'role_released') {
    const principalId = event.payload.principal_id;
    if (
      principalId !== event.actor.principal_id &&
      event.actor.principal_id !== projection.creatorPrincipalId
    )
      unauthorized('Only the claimant or creator can release a role');
    return;
  }

  if (event.event_type === 'turn_claimed') {
    const turnId = event.payload.turn_id;
    if (typeof turnId !== 'string') unauthorized('Turn claim has no turn id');
    const turn = projection.turns[turnId];
    if (!turn) unauthorized('Turn claim references an unknown turn');
    const claim = (projection.roleClaims[turn.role] ?? []).find(
      (candidate) => candidate.principal_id === event.actor.principal_id,
    );
    if (!claim || claim.agent_id !== event.actor.agent_id)
      unauthorized('Actor does not hold the required role');
    return;
  }

  if (claimantOnly.has(event.event_type)) {
    const turnId = event.payload.turn_id;
    if (typeof turnId !== 'string') unauthorized('Action event has no turn id');
    const turn = projection.turns[turnId];
    if (!turn || turn.claimantPrincipalId !== event.actor.principal_id)
      unauthorized('Only the winning claimant may report action state');
    return;
  }

  if (
    event.event_type === 'data_updated' ||
    event.event_type === 'artifact_published'
  )
    return;

  unauthorized(`No authorization rule exists for ${event.event_type}`);
}
