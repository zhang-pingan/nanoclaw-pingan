import {
  checkSemanticCorrectionReviewCandidate,
  prepareSemanticCorrectionReviewCandidate,
} from './semantic-correction-review-candidate.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'prepare-rc' && command !== 'check')
) {
  console.error('Usage: g2-review-candidate <prepare-rc|check>');
  process.exit(64);
}

try {
  const root =
    command === 'prepare-rc'
      ? prepareSemanticCorrectionReviewCandidate()
      : checkSemanticCorrectionReviewCandidate();
  console.log(`g2_review_candidate=${command}:ok`);
  console.log(`g2_review_candidate_root=${root.hash}`);
} catch (error) {
  console.error(
    `g2_review_candidate=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
