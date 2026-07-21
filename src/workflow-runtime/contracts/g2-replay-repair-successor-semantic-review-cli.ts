import {
  checkG2ReplayRepairSemanticReview,
  generateG2ReplayRepairSemanticReview,
  type G2ReplayRepairDecision,
} from './g2-replay-repair-successor-semantic-review.js';

const command = process.argv[2];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (command !== 'generate' && command !== 'check') {
  console.error(
    'Usage: g2-replay-repair-successor-semantic-review <generate OPTIONS|check>',
  );
  process.exit(64);
}

try {
  const review =
    command === 'generate'
      ? generateG2ReplayRepairSemanticReview({
          authorizedBy: option('--authorized-by') ?? '',
          decision: (option('--decision') ?? '') as G2ReplayRepairDecision,
          approvedDraftManifestHash: option('--draft-manifest-hash') ?? '',
          approvedReviewReportHash: option('--review-report-hash') ?? '',
          reviewedAtMs: Number(option('--reviewed-at-ms')),
        })
      : checkG2ReplayRepairSemanticReview();
  console.log(`g2_replay_repair_semantic_review=${command}:ok`);
  console.log(`decision=${String(review.payload.decision)}`);
  console.log(`review_hash=${String(review.payload.review_hash)}`);
  console.log(`review_artifact_hash=${review.hash}`);
} catch (error) {
  console.error(
    `g2_replay_repair_semantic_review=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
