import {
  checkSemanticCorrectionCurrentLifecycle,
  checkSemanticCorrectionReviewCandidate,
  prepareSemanticCorrectionReviewCandidate,
} from './semantic-correction-review-candidate.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'prepare-rc' &&
    command !== 'check' &&
    command !== 'check-current')
) {
  console.error('Usage: g2-review-candidate <prepare-rc|check|check-current>');
  process.exit(64);
}

try {
  if (command === 'check-current') {
    const result = checkSemanticCorrectionCurrentLifecycle();
    console.log('g2_review_candidate=check-current:ok');
    console.log(`g2_construction_phase=${result.construction_phase}`);
    console.log(
      `g2_review_candidate_root=${result.review_candidate_root ?? 'absent'}`,
    );
    process.exit(0);
  }
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
