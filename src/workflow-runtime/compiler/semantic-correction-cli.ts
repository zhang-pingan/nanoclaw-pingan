import path from 'node:path';

import {
  checkSemanticCorrectionCandidate,
  generateSemanticCorrectionCandidate,
} from './semantic-correction.js';
import { assertCurrentG2SealedBoundary } from '../contracts/current-g2-sealed-boundary.js';
import { checkCurrentSealedEraWorkingCompilerCandidate } from '../contracts/current-sealed-era-historical-checks.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: workflow-compiler-working-set <generate|check>');
  process.exit(64);
}

try {
  const sealedState = assertCurrentG2SealedBoundary(
    path.join(import.meta.dirname, '../contracts/conformance/sealed'),
  );
  const root =
    sealedState === 'current_g2'
      ? checkCurrentSealedEraWorkingCompilerCandidate()
      : command === 'generate'
        ? generateSemanticCorrectionCandidate()
        : checkSemanticCorrectionCandidate();
  console.log(`g2_working_candidate=${command}:ok`);
  console.log(`g2_working_candidate_root=${root.hash}`);
} catch (error) {
  console.error(
    `g2_working_candidate=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
