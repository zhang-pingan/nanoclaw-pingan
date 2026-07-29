import { describe, expect, it } from 'vitest';

import {
  G8_BENCHMARK_SHAPES,
  G8_PRODUCT_FLOOR_COVERAGE,
  G8_SUPPORTED_LIMITS,
  G8SupportedLimitError,
  assertG8DimensionsWithinSupportedLimits,
  createG8LimitDerivation,
  deriveWorstCaseT7Facts,
  deriveWorstCaseT7ManifestBytes,
  percentile,
} from '../contracts/g8-limits.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  compileG8T3Fixture,
  g8T3ShapeDimensions,
  type G8T3Shape,
} from './benchmark-shapes.js';

const projectRoot = new URL('../../../', import.meta.url).pathname;

describe('G8 benchmark and Supported Limit model', () => {
  it('compiles every required T3 shape at the per-scope Product Floor', () => {
    for (const shape of G8_BENCHMARK_SHAPES.t3) {
      const fixture = compileG8T3Fixture(shape as G8T3Shape, 128);
      const dimensions = g8T3ShapeDimensions(fixture);
      expect(fixture.plan.nodes).toHaveLength(128);
      expect(Number(dimensions.max_edges_total)).toBeLessThanOrEqual(512);
      expect(Number(dimensions.max_facts_per_transaction)).toBeLessThanOrEqual(
        G8_SUPPORTED_LIMITS.max_facts_per_transaction,
      );
    }
  });

  it('covers every Product Floor dimension and proves one-shot T7 termination', () => {
    const sourceHash = domainSeparatedSha256('icarus:g8-test-source:1\n', {
      source: 'benchmark-model',
    });
    const derivation = createG8LimitDerivation(projectRoot, sourceHash);
    expect(derivation.product_floor_coverage).toEqual(
      G8_PRODUCT_FLOOR_COVERAGE,
    );
    expect(deriveWorstCaseT7Facts()).toBeLessThanOrEqual(
      G8_SUPPORTED_LIMITS.max_t7_derived_facts_per_fence,
    );
    expect(deriveWorstCaseT7ManifestBytes()).toBeLessThanOrEqual(
      G8_SUPPORTED_LIMITS.max_subtree_fence_manifest_bytes,
    );
  });

  it('rejects beyond-limit dimensions before invoking any write callback', () => {
    let writes = 0;
    const guarded = () => {
      assertG8DimensionsWithinSupportedLimits({
        max_nodes_total: G8_SUPPORTED_LIMITS.max_nodes_total + 1,
      });
      writes += 1;
    };
    expect(guarded).toThrowError(G8SupportedLimitError);
    expect(writes).toBe(0);
  });

  it('uses nearest-rank p50/p95/p99 over finite non-negative samples', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 99)).toBe(99);
    expect(() => percentile([], 99)).toThrow();
  });
});
