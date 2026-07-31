import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { runtimeObjectHash, stableRuntimeId } from '../runtime/graph-store.js';

export interface RoutingCandidate {
  readonly recipeResourceId: string;
  readonly recipeHash: Sha256Hash;
  readonly priority: number;
  readonly confidenceMicros: number;
  readonly reasonCodes: readonly string[];
}

export interface RoutingResolution {
  readonly id: string;
  readonly disposition: 'routed';
  readonly decision: JsonObject;
  readonly decisionHash: Sha256Hash;
  readonly selected: RoutingCandidate;
}

export interface NoRouteAvailableResolution {
  readonly id: string;
  readonly disposition: 'no_route_available';
  readonly decision: JsonObject;
  readonly decisionHash: Sha256Hash;
  readonly selected: null;
}

export function resolveDeterministicRoute(
  intakeId: string,
  revisionHash: Sha256Hash,
  candidates: readonly RoutingCandidate[],
): RoutingResolution | NoRouteAvailableResolution {
  if (candidates.length === 0) {
    const decision: JsonObject = {
      format: 'icarus.workflow-g5-routing-decision/1',
      intake_id: intakeId,
      revision_hash: revisionHash,
      disposition: 'no_route_available',
      selected_recipe_resource_id: null,
      selected_recipe_hash: null,
      priority: null,
      confidence_micros: null,
      reason_codes: ['no_eligible_published_recipe'],
    };
    return {
      id: stableRuntimeId('routing', {
        intake_id: intakeId,
        revision_hash: revisionHash,
      }),
      disposition: 'no_route_available',
      decision: JSON.parse(canonicalJson(decision)) as JsonObject,
      decisionHash: runtimeObjectHash('routing-decision', decision),
      selected: null,
    };
  }
  const sorted = [...candidates].sort((left, right) =>
    left.priority !== right.priority
      ? left.priority - right.priority
      : left.recipeResourceId < right.recipeResourceId
        ? -1
        : left.recipeResourceId > right.recipeResourceId
          ? 1
          : 0,
  );
  if (
    sorted.length > 1 &&
    sorted[0].priority === sorted[1].priority &&
    sorted[0].confidenceMicros === sorted[1].confidenceMicros
  ) {
    throw new Error(
      'Ambiguous routing candidates at the same priority and confidence',
    );
  }
  const selected = sorted[0];
  const decision: JsonObject = {
    format: 'icarus.workflow-g5-routing-decision/1',
    intake_id: intakeId,
    revision_hash: revisionHash,
    selected_recipe_resource_id: selected.recipeResourceId,
    selected_recipe_hash: selected.recipeHash,
    priority: selected.priority,
    confidence_micros: selected.confidenceMicros,
    reason_codes: [...selected.reasonCodes],
  };
  const decisionHash = runtimeObjectHash('routing-decision', decision);
  return {
    id: stableRuntimeId('routing', {
      intake_id: intakeId,
      revision_hash: revisionHash,
    }),
    disposition: 'routed',
    decision: JSON.parse(canonicalJson(decision)) as JsonObject,
    decisionHash,
    selected,
  };
}
