import {
  checkG2NodeOutputEnvelopeSemanticReview,
  generateG2NodeOutputEnvelopeSemanticReview,
  type G2NodeOutputEnvelopeDecision,
} from './g2-node-output-envelope-authority-successor-semantic-review.js';

const command = process.argv[2];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (command !== 'generate' && command !== 'check') {
  console.error(
    'Usage: g2-node-output-envelope-authority-successor-semantic-review <generate OPTIONS|check>',
  );
  process.exit(64);
}

try {
  const review =
    command === 'generate'
      ? generateG2NodeOutputEnvelopeSemanticReview({
          authorizedBy: option('--authorized-by') ?? '',
          decision: (option('--decision') ?? '') as G2NodeOutputEnvelopeDecision,
          approvedDraftManifestHash: option('--draft-manifest-hash') ?? '',
          approvedReviewReportHash: option('--review-report-hash') ?? '',
          reviewedAtMs: Number(option('--reviewed-at-ms')),
        })
      : checkG2NodeOutputEnvelopeSemanticReview();
  console.log(`g2_node_output_envelope_semantic_review=${command}:ok`);
  console.log(`decision=${String(review.payload.decision)}`);
  console.log(`review_hash=${String(review.payload.review_hash)}`);
  console.log(`review_artifact_hash=${review.hash}`);
} catch (error) {
  console.error(
    `g2_node_output_envelope_semantic_review=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
