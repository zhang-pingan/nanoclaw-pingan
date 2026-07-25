import { describe, expect, it } from 'vitest';

import { evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay } from '../compiler/current-g2-golden-replay.js';
import { checkG2ReplayRepairSeal } from './g2-replay-repair-successor-seal.js';
import { checkG2ReplayRepairSemanticReview } from './g2-replay-repair-successor-semantic-review.js';

describe('historical G2 v5 generated-schema authority', () => {
  it('preserves the exact immutable semantic review and seal', () => {
    expect(checkG2ReplayRepairSemanticReview()).toMatchObject({
      hash: 'sha256:f5c07ae45d93124cda1247aeca1cdb4df8d2cc7398e2129cd7d90f4ab529526b',
      payload: {
        decision: 'approved',
        review_hash:
          'sha256:4481515b905ca062e3d028e17bb13ed2d4080059e844efa6c609ef292967e0de',
      },
    });
    expect(checkG2ReplayRepairSeal()).toMatchObject({
      hash: 'sha256:f59040be6f71d8655afcb11ab4527a6683125a7a4e683f1e734b44448f7bb72e',
      payload: {
        bundle_hash:
          'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05',
        case_count: 40,
        sealed_artifact_count: 157,
      },
    });
  });

  it('replays the frozen Plan shape with its exact Compiler 3.0.3 identity', () => {
    expect(evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay()).toMatchObject({
      expected_bundle_hash:
        'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05',
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
  }, 30_000);
});
