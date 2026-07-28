import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type { JsonObject, Sha256Hash } from './types.js';

export type G7ModelExecutionResult =
  | 'applied'
  | 'denied'
  | 'conflict'
  | 'duplicate'
  | 'late';

export interface G7ModelCommandRequest extends JsonObject {
  readonly command_id: string;
  readonly idempotency_domain: string;
  readonly idempotency_key: string;
  readonly target_version: number;
  readonly expected_version: number;
  readonly authorized: boolean;
  readonly target_open: boolean;
  readonly payload: JsonObject;
}

export interface G7ModelCommandHeader {
  readonly commandId: string;
  readonly requestHash: Sha256Hash;
  readonly canonicalResult: G7ModelExecutionResult;
  readonly invocationCount: number;
  readonly targetVersion: number;
}

export function g7ModelRequestHash(request: G7ModelCommandRequest): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:g7-reference-command-request:1\n',
    request,
  );
}

export function applyG7ModelCommand(
  prior: G7ModelCommandHeader | null,
  request: G7ModelCommandRequest,
): G7ModelCommandHeader {
  const requestHash = g7ModelRequestHash(request);
  if (prior) {
    return {
      ...prior,
      canonicalResult:
        prior.requestHash === requestHash ? 'duplicate' : 'conflict',
      invocationCount: prior.invocationCount + 1,
    };
  }
  const result: G7ModelExecutionResult = !request.authorized
    ? 'denied'
    : request.expected_version !== request.target_version
      ? 'conflict'
      : !request.target_open
        ? 'late'
        : 'applied';
  return {
    commandId: request.command_id,
    requestHash,
    canonicalResult: result,
    invocationCount: 1,
    targetVersion:
      result === 'applied'
        ? request.target_version + 1
        : request.target_version,
  };
}

export type G7ModelBlockerSeverity = 'action_required' | 'quarantine';

export interface G7ModelBlocker {
  readonly id: string;
  readonly severity: G7ModelBlockerSeverity;
  readonly open: boolean;
}

export function g7ModelOperationalState(
  blockers: readonly G7ModelBlocker[],
): 'healthy' | 'action_required' | 'quarantined' {
  const open = blockers.filter((blocker) => blocker.open);
  return open.some((blocker) => blocker.severity === 'quarantine')
    ? 'quarantined'
    : open.length > 0
      ? 'action_required'
      : 'healthy';
}

export function resolveG7ModelBlocker(
  blockers: readonly G7ModelBlocker[],
  blockerId: string,
): readonly G7ModelBlocker[] {
  if (!blockers.some((blocker) => blocker.id === blockerId && blocker.open))
    throw new Error('blocker_not_open');
  return blockers.map((blocker) =>
    blocker.id === blockerId ? { ...blocker, open: false } : blocker,
  );
}

export interface G7ModelProjectionHead {
  readonly sequence: number;
  readonly hash: Sha256Hash | null;
  readonly state: 'ready' | 'degraded';
}

export interface G7ModelProjectionEvent extends JsonObject {
  readonly sequence: number;
  readonly previous_hash: Sha256Hash | null;
  readonly payload: JsonObject;
  readonly hash: Sha256Hash;
}

export function g7ModelProjectionEvent(
  sequence: number,
  previousHash: Sha256Hash | null,
  payload: JsonObject,
): G7ModelProjectionEvent {
  const body = {
    sequence,
    previous_hash: previousHash,
    payload,
  };
  return {
    ...body,
    hash: domainSeparatedSha256(
      'icarus:g7-reference-projection-event:1\n',
      body,
    ),
  };
}

export function consumeG7ModelProjectionEvent(
  head: G7ModelProjectionHead,
  event: G7ModelProjectionEvent,
): G7ModelProjectionHead {
  const expected = g7ModelProjectionEvent(
    event.sequence,
    event.previous_hash,
    event.payload,
  ).hash;
  if (
    head.state !== 'ready' ||
    event.sequence !== head.sequence + 1 ||
    event.previous_hash !== head.hash ||
    event.hash !== expected
  )
    return { ...head, state: 'degraded' };
  return { sequence: event.sequence, hash: event.hash, state: 'ready' };
}

export function g7ModelCardAction(input: {
  readonly expectedSnapshotHash: Sha256Hash;
  readonly observedSnapshot: JsonObject;
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly permitted: boolean;
}): 'applied' | 'expired' | 'denied' | 'tampered' {
  const observedHash = domainSeparatedSha256(
    'icarus:g7-reference-card-snapshot:1\n',
    input.observedSnapshot,
  );
  if (observedHash !== input.expectedSnapshotHash) return 'tampered';
  if (!input.permitted) return 'denied';
  return input.nowMs > input.expiresAtMs ? 'expired' : 'applied';
}

export function canonicalG7ModelState(value: JsonObject): string {
  return canonicalJson(value);
}
