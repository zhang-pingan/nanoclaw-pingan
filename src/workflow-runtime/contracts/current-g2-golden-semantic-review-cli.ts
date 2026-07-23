import {
  checkCurrentG2GoldenSemanticReview,
  generateCurrentG2GoldenSemanticReview,
} from './current-g2-golden-semantic-review.js';
import path from 'node:path';

import { checkCurrentSealedEraLegacySemanticReview } from './current-sealed-era-historical-checks.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import type { CurrentG2GoldenDecision } from './current-g2-golden-seal-types.js';

const command = process.argv[2];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (command !== 'generate' && command !== 'check') {
  console.error(
    'Usage: current-g2-golden-semantic-review <generate OPTIONS|check>',
  );
  process.exit(64);
}

try {
  const review =
    command === 'generate'
      ? generateCurrentG2GoldenSemanticReview({
          authorizedBy: option('--authorized-by') ?? '',
          decision: (option('--decision') ?? '') as CurrentG2GoldenDecision,
          approvedDraftManifestHash: option('--draft-manifest-hash') ?? '',
          approvedReviewReportHash: option('--review-report-hash') ?? '',
          reviewedAtMs: Number(option('--reviewed-at-ms')),
        })
      : assertCurrentG2SealedBoundary(
            path.join(import.meta.dirname, 'conformance/sealed'),
          ) === 'current_g2'
        ? checkCurrentSealedEraLegacySemanticReview()
        : checkCurrentG2GoldenSemanticReview();
  console.log(`current_g2_golden_semantic_review=${command}:ok`);
  console.log(`decision=${String(review.payload.decision)}`);
  console.log(`review_hash=${String(review.payload.review_hash)}`);
  console.log(`review_artifact_hash=${review.hash}`);
} catch (error) {
  console.error(
    `current_g2_golden_semantic_review=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
