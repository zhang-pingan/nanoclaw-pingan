import { describe, expect, it } from 'vitest';

import {
  G8_READINESS_REPRESENTATIVES,
  G8_SUPPORTED_LIMITS,
  G8SupportedLimitError,
  assertG8DimensionsWithinSupportedLimits,
  deriveWorstCaseT7Facts,
  deriveWorstCaseT7ManifestBytes,
  percentile,
} from '../contracts/g8-limits.js';
import {
  compileG8T3Fixture,
  g8T3ShapeDimensions,
  type G8T3Shape,
} from './benchmark-shapes.js';

describe('G8 readiness model', () => {
  it('compiles the fixed T3 representative at its supported dimensions', () => {
    const shape = G8_READINESS_REPRESENTATIVES.t3[0] as G8T3Shape;
    const fixture = compileG8T3Fixture(shape, 128);
    const dimensions = g8T3ShapeDimensions(fixture);
    expect(fixture.plan.nodes).toHaveLength(128);
    expect(Number(dimensions.max_edges_total)).toBeLessThanOrEqual(512);
    expect(Number(dimensions.max_facts_per_transaction)).toBeLessThanOrEqual(
      G8_SUPPORTED_LIMITS.max_facts_per_transaction,
    );
  });

  it('keeps one-shot T7 termination within the fixed supported boundary', () => {
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

  it('uses nearest-rank percentiles over finite non-negative samples', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 99)).toBe(5);
    expect(() => percentile([], 99)).toThrow();
  });
});
