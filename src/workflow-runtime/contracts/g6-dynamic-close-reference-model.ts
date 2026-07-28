import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type { JsonObject, Sha256Hash } from './types.js';

export type ReferenceMapOutcome =
  | 'completed'
  | 'errored'
  | 'cancelled'
  | 'fenced';

export interface ReferenceMapSlot {
  readonly itemIndex: number;
  readonly outcome: ReferenceMapOutcome;
  readonly completionSeq: number | null;
  readonly exitName: string | null;
}

export type ReferenceMapPolicy =
  | { readonly type: 'all_settled' }
  | {
      readonly type: 'all_accepted';
      readonly acceptedExits: readonly string[];
    }
  | {
      readonly type: 'quorum';
      readonly count: number;
      readonly acceptedExits: readonly string[];
    }
  | {
      readonly type: 'fail_fast';
      readonly acceptedExits: readonly string[];
    };

export interface ReferenceMapDecision extends JsonObject {
  readonly terminal: boolean;
  readonly succeeded: boolean;
  readonly selectedIndices: number[];
  readonly loserIndices: number[];
  readonly code: string | null;
  readonly decisionHash: Sha256Hash;
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function accepted(
  slot: ReferenceMapSlot,
  acceptedExits: ReadonlySet<string>,
): boolean {
  return (
    slot.outcome === 'completed' &&
    slot.exitName !== null &&
    acceptedExits.has(slot.exitName)
  );
}

function completionOrder(
  left: ReferenceMapSlot,
  right: ReferenceMapSlot,
): number {
  const leftSequence = left.completionSeq ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.completionSeq ?? Number.MAX_SAFE_INTEGER;
  return leftSequence === rightSequence
    ? left.itemIndex - right.itemIndex
    : leftSequence - rightSequence;
}

export function referenceMapDecision(
  slots: readonly ReferenceMapSlot[],
  policy: ReferenceMapPolicy,
): ReferenceMapDecision {
  const ordered = [...slots].sort(
    (left, right) => left.itemIndex - right.itemIndex,
  );
  if (
    ordered.some(
      (slot, index) =>
        slot.itemIndex !== index ||
        !Number.isSafeInteger(slot.itemIndex) ||
        slot.itemIndex < 0 ||
        (slot.completionSeq !== null &&
          (!Number.isSafeInteger(slot.completionSeq) ||
            slot.completionSeq < 0)),
    )
  )
    throw new Error('invalid_map_slot_order');
  let terminal = false;
  let succeeded = false;
  let selectedIndices: number[] = [];
  let loserIndices: number[] = [];
  let code: string | null = null;
  if (policy.type === 'all_settled') {
    terminal = true;
    succeeded = true;
    selectedIndices = ordered.map((slot) => slot.itemIndex);
  } else {
    const acceptedExits = new Set([...policy.acceptedExits].sort(ascii));
    const acceptedSlots = ordered.filter((slot) =>
      accepted(slot, acceptedExits),
    );
    if (policy.type === 'all_accepted') {
      terminal = true;
      succeeded = acceptedSlots.length === ordered.length;
      selectedIndices = succeeded
        ? acceptedSlots.map((slot) => slot.itemIndex)
        : [];
      code = succeeded ? null : 'map_child_not_accepted';
    } else if (policy.type === 'quorum') {
      if (!Number.isSafeInteger(policy.count) || policy.count <= 0)
        throw new Error('invalid_quorum');
      terminal =
        acceptedSlots.length >= policy.count || ordered.length < policy.count;
      succeeded = acceptedSlots.length >= policy.count;
      selectedIndices = succeeded
        ? acceptedSlots
            .sort(completionOrder)
            .slice(0, policy.count)
            .map((slot) => slot.itemIndex)
        : [];
      loserIndices = succeeded
        ? ordered
            .filter((slot) => !selectedIndices.includes(slot.itemIndex))
            .map((slot) => slot.itemIndex)
        : [];
      code = succeeded ? null : 'quorum_impossible';
    } else {
      const rejected = ordered.filter(
        (slot) => slot.outcome !== 'fenced' && !accepted(slot, acceptedExits),
      );
      terminal = rejected.length > 0 || acceptedSlots.length === ordered.length;
      succeeded = terminal && rejected.length === 0;
      selectedIndices = succeeded
        ? acceptedSlots.map((slot) => slot.itemIndex)
        : [];
      loserIndices =
        rejected.length > 0
          ? ordered
              .filter((slot) => slot.itemIndex !== rejected[0]!.itemIndex)
              .map((slot) => slot.itemIndex)
          : [];
      code = rejected.length > 0 ? 'map_fail_fast' : null;
    }
  }
  const payload = {
    terminal,
    succeeded,
    selectedIndices,
    loserIndices,
    code,
  };
  return {
    ...payload,
    decisionHash: domainSeparatedSha256(
      'icarus:workflow-g6-reference-map-decision:1\n',
      payload,
    ),
  };
}

export interface ReferenceScopeClose {
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly existingReason: string | null;
}

export function referenceHierarchicalClose(
  scopes: readonly ReferenceScopeClose[],
  targetScopeId: string,
  targetReason: string,
): JsonObject {
  const byId = new Map(scopes.map((scope) => [scope.scopeId, scope]));
  if (!byId.has(targetScopeId)) throw new Error('target_scope_missing');
  const descendants = scopes
    .filter((scope) => {
      let parent = scope.parentScopeId;
      while (parent !== null) {
        if (parent === targetScopeId) return true;
        parent = byId.get(parent)?.parentScopeId ?? null;
      }
      return false;
    })
    .sort((left, right) => ascii(left.scopeId, right.scopeId));
  const requests: JsonObject = {};
  const target = byId.get(targetScopeId)!;
  requests[targetScopeId] = target.existingReason ?? targetReason;
  for (const scope of descendants)
    requests[scope.scopeId] = scope.existingReason ?? 'parent_close';
  const payload = {
    target_scope_id: targetScopeId,
    requests,
    fenced_scope_ids: [
      targetScopeId,
      ...descendants.map((scope) => scope.scopeId),
    ],
  };
  return {
    ...payload,
    fence_hash: domainSeparatedSha256(
      'icarus:workflow-g6-reference-hierarchical-close:1\n',
      JSON.parse(canonicalJson(payload)),
    ),
  };
}
