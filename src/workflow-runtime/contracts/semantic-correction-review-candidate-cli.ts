import path from 'node:path';

import {
  checkSemanticCorrectionCurrentLifecycle,
  checkSemanticCorrectionReviewCandidate,
  prepareSemanticCorrectionReviewCandidate,
} from './semantic-correction-review-candidate.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { checkCurrentSealedEraReviewCandidate } from './current-sealed-era-historical-checks.js';

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
  const sealedState = assertCurrentG2SealedBoundary(
    path.join(import.meta.dirname, 'conformance/sealed'),
  );
  if (sealedState === 'current_g2') {
    const root = checkCurrentSealedEraReviewCandidate();
    if (command === 'check-current') {
      console.log('g2_review_candidate=check-current:ok');
      console.log('g2_construction_phase=RC_REVIEW');
      console.log(`g2_review_candidate_root=${root.hash}`);
    } else {
      console.log(`g2_review_candidate=${command}:ok`);
      console.log(`g2_review_candidate_root=${root.hash}`);
    }
    process.exit(0);
  }
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
