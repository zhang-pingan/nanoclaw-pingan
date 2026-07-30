import { domainSeparatedSha256 } from './hash.js';
import {
  G8_SUPPORTED_LIMIT_KEYS,
  type G8BenchmarkCaseObservation,
  type G8BenchmarkTransaction,
  type G8SupportedLimitKey,
  type G8SupportedLimitValues,
} from './g8-validation-types.js';
import type { JsonValue, Sha256Hash } from './types.js';

export const G8_SUPPORTED_LIMITS: G8SupportedLimitValues = Object.freeze({
  max_scopes_total: 128,
  max_nodes_total: 1024,
  max_edges_total: 4096,
  max_attempts_total: 4096,
  max_waits_total: 512,
  max_builds_total: 512,
  max_effect_operations_total: 2048,
  max_facts_per_transaction: 16384,
  max_frontier_bytes: 16777216,
  max_subtree_scopes_per_fence: 128,
  max_subtree_nodes_per_fence: 1024,
  max_subtree_edges_per_fence: 4096,
  max_subtree_attempts_per_fence: 4096,
  max_subtree_waits_per_fence: 512,
  max_subtree_builds_per_fence: 512,
  max_subtree_map_slots_per_fence: 256,
  max_subtree_effects_per_fence: 2048,
  max_t7_derived_facts_per_fence: 16384,
  max_subtree_fence_manifest_bytes: 16777216,
  max_map_items_total: 256,
  max_required_child_creations_per_t8: 8,
});

export const G8_READINESS_PROFILES = [
  'supported_limit',
  'beyond_limit',
] as const;

export const G8_READINESS_REPRESENTATIVES = Object.freeze({
  t3: ['route_group'],
  t7: ['mixed_lifecycle'],
  t8: ['maximum_required_child'],
} as const satisfies Readonly<
  Record<G8BenchmarkTransaction, readonly [string]>
>);

export const G8_READINESS_BEYOND_LIMIT_DIMENSIONS = Object.freeze({
  t3: {
    max_facts_per_transaction:
      G8_SUPPORTED_LIMITS.max_facts_per_transaction + 1,
  },
  t7: {
    max_subtree_scopes_per_fence:
      G8_SUPPORTED_LIMITS.max_subtree_scopes_per_fence + 1,
  },
  t8: {
    max_required_child_creations_per_t8:
      G8_SUPPORTED_LIMITS.max_required_child_creations_per_t8 + 1,
  },
} as const satisfies Readonly<
  Record<G8BenchmarkTransaction, Partial<G8SupportedLimitValues>>
>);

export const G8_READINESS_WARMUP_ITERATIONS = 1 as const;
export const G8_READINESS_MEASUREMENT_ITERATIONS = 5 as const;

export const G8_OBVIOUS_REGRESSION_MAX_MS = Object.freeze({
  t3: 1000,
  t7: 2000,
  t8: 1000,
} as const satisfies Readonly<Record<G8BenchmarkTransaction, number>>);

export const G8_BENCHMARK_DIMENSION_LIMITS = Object.freeze({
  max_nodes_per_scope: 128,
  max_edges_per_scope: 512,
  max_items_per_map: 128,
});

export function deriveWorstCaseT7Facts(
  limits: G8SupportedLimitValues = G8_SUPPORTED_LIMITS,
): number {
  return (
    limits.max_subtree_scopes_per_fence * 2 +
    limits.max_subtree_nodes_per_fence +
    limits.max_subtree_edges_per_fence +
    limits.max_subtree_attempts_per_fence +
    limits.max_subtree_waits_per_fence +
    limits.max_subtree_builds_per_fence +
    limits.max_subtree_map_slots_per_fence +
    limits.max_subtree_effects_per_fence +
    1
  );
}

export function deriveWorstCaseT7ManifestBytes(
  limits: G8SupportedLimitValues = G8_SUPPORTED_LIMITS,
): number {
  const identifierAndHashBytes = 160;
  const recordEnvelopeBytes = 96;
  const records =
    limits.max_subtree_scopes_per_fence * 2 +
    limits.max_subtree_attempts_per_fence +
    limits.max_subtree_waits_per_fence +
    limits.max_subtree_builds_per_fence +
    limits.max_subtree_map_slots_per_fence +
    limits.max_subtree_effects_per_fence;
  return 4096 + records * (identifierAndHashBytes + recordEnvelopeBytes);
}

export class G8SupportedLimitError extends Error {
  readonly code = 'runtime_supported_limit_exceeded';
}

export function assertG8DimensionsWithinSupportedLimits(
  dimensions: Readonly<Partial<Record<G8SupportedLimitKey, number>>>,
): void {
  const keys = Object.keys(dimensions).sort();
  if (
    keys.some(
      (key) =>
        !G8_SUPPORTED_LIMIT_KEYS.includes(key as G8SupportedLimitKey) ||
        !Number.isSafeInteger(dimensions[key as G8SupportedLimitKey]) ||
        (dimensions[key as G8SupportedLimitKey] ?? 0) < 0,
    )
  ) {
    throw new G8SupportedLimitError('Supported Limit dimensions are invalid');
  }
  for (const key of keys as G8SupportedLimitKey[]) {
    if ((dimensions[key] ?? 0) > G8_SUPPORTED_LIMITS[key]) {
      throw new G8SupportedLimitError(`${key} exceeds its supported limit`);
    }
  }
}

export function invokeWithinG8SupportedLimits<T>(
  dimensions: Readonly<Partial<Record<G8SupportedLimitKey, number>>>,
  productionTransaction: () => T,
): T {
  assertG8DimensionsWithinSupportedLimits(dimensions);
  return productionTransaction();
}

export function percentile(
  samples: readonly number[],
  percentileValue: 50 | 95 | 99,
): number {
  if (
    samples.length === 0 ||
    samples.some((sample) => !Number.isFinite(sample) || sample < 0)
  ) {
    throw new Error('Benchmark samples must be finite non-negative numbers');
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * ordered.length) - 1,
  );
  return ordered[index]!;
}

export function benchmarkCaseHash(
  observation: G8BenchmarkCaseObservation,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-runtime-benchmark-case:1\n',
    observation as JsonValue,
  );
}
