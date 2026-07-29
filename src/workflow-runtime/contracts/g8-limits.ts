import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { domainSeparatedSha256, parseSha256Hash } from './hash.js';
import {
  G8_SUPPORTED_LIMIT_KEYS,
  type G8BenchmarkCaseObservation,
  type G8BenchmarkTransaction,
  type G8LimitDerivationPayload,
  type G8SupportedLimitKey,
  type G8SupportedLimitValues,
} from './g8-certification-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const G8_PRODUCT_FLOOR_HASH =
  'sha256:370e01e401d98a25ca89088560edbb88d1a5cdb19d3409a877f9be5f39004521';

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

export const G8_BENCHMARK_SHAPES = Object.freeze({
  t3: [
    'long_chain',
    'wide_fan_out_fan_in',
    'diamond',
    'route_group',
    'completion_heavy',
    'condition_heavy',
  ],
  t7: [
    'deep_tree',
    'wide_tree',
    'large_nested_map',
    'mixed_lifecycle',
    'effect_heavy_subtree',
  ],
  t8: [
    'maximum_required_child',
    'claim_handoff_competition',
    'retry_exhaustion',
    'all_or_nothing',
  ],
} as const satisfies Readonly<
  Record<G8BenchmarkTransaction, readonly string[]>
>);

export const G8_BENCHMARK_PROFILES = [
  'smoke',
  'scaling_25',
  'scaling_50',
  'scaling_100',
  'supported_limit',
  'beyond_limit',
] as const;

export const G8_PRODUCT_FLOOR_COVERAGE = Object.freeze({
  max_scopes_total: 128,
  max_nodes_total: 1024,
  max_nodes_per_scope: 128,
  max_edges_total: 4096,
  max_edges_per_scope: 512,
  max_map_items_total: 256,
  max_items_per_map: 128,
  max_attempts_total: 4096,
  max_waits_total: 512,
  max_builds_total: 512,
  max_effect_operations_total: 2048,
  max_facts_per_transaction: 16384,
  max_frontier_bytes: 16777216,
  max_nesting_depth: 8,
  max_required_child_creations_per_t8: 8,
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

function loadProductFloor(projectRoot: string) {
  const filePath = path.join(
    projectRoot,
    'src/workflow-runtime/contracts/safety/local_single_user_product_floor@1.json',
  );
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(filePath)),
  );
  if (
    artifact.format !== 'icarus.workflow-runtime-product-floor/1' ||
    artifact.hash !== G8_PRODUCT_FLOOR_HASH
  ) {
    throw new Error('G8 Product Floor identity drifted');
  }
  return artifact;
}

export function createG8LimitDerivation(
  projectRoot: string,
  implementationSourceTreeHash: Sha256Hash,
): G8LimitDerivationPayload {
  parseSha256Hash(implementationSourceTreeHash);
  const floor = loadProductFloor(projectRoot);
  const limits = (floor.payload as JsonObject).limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('G8 Product Floor limits are malformed');
  }
  const expectedFloor = G8_PRODUCT_FLOOR_COVERAGE as Record<string, number>;
  for (const [key, expected] of Object.entries(expectedFloor)) {
    if ((limits as JsonObject)[key] !== expected) {
      throw new Error(`G8 Product Floor ${key} drifted`);
    }
  }
  const worstCaseFacts = deriveWorstCaseT7Facts();
  const worstCaseManifestBytes = deriveWorstCaseT7ManifestBytes();
  if (
    worstCaseFacts > G8_SUPPORTED_LIMITS.max_t7_derived_facts_per_fence ||
    worstCaseFacts > G8_SUPPORTED_LIMITS.max_facts_per_transaction ||
    worstCaseManifestBytes >
      G8_SUPPORTED_LIMITS.max_subtree_fence_manifest_bytes
  ) {
    throw new Error('G8 T7 termination derivation exceeds Supported Limits');
  }
  return {
    derivation_id: 'local_single_user_limit_derivation@1',
    algorithm_version: '1.0.0',
    supported_limits: G8_SUPPORTED_LIMITS,
    product_floor_ref: floor.ref,
    product_floor_hash: floor.hash,
    product_floor_coverage: G8_PRODUCT_FLOOR_COVERAGE,
    worst_case_t7_facts: worstCaseFacts,
    worst_case_t7_manifest_bytes: worstCaseManifestBytes,
    benchmark_shape_requirements: {
      t3: [...G8_BENCHMARK_SHAPES.t3],
      t7: [...G8_BENCHMARK_SHAPES.t7],
      t8: [...G8_BENCHMARK_SHAPES.t8],
    },
    implementation_source_tree_hash: implementationSourceTreeHash,
  };
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
      throw new G8SupportedLimitError(`${key} exceeds its certified limit`);
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
