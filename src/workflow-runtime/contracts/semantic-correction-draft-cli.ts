import path from 'node:path';

import {
  checkSemanticCorrectionDraft,
  generateSemanticCorrectionDraft,
} from './semantic-correction-draft.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { checkCurrentSealedEraWorkingGolden } from './current-sealed-era-historical-checks.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: semantic-correction-working-bundle <generate|check>');
  process.exit(64);
}

try {
  const sealedState = assertCurrentG2SealedBoundary(
    path.join(import.meta.dirname, 'conformance/sealed'),
  );
  const manifest =
    sealedState === 'current_g2'
      ? checkCurrentSealedEraWorkingGolden()
      : command === 'generate'
        ? generateSemanticCorrectionDraft()
        : checkSemanticCorrectionDraft();
  console.log(`semantic_correction_working_bundle=${command}:ok`);
  console.log(`semantic_correction_working_bundle_root=${manifest.hash}`);
} catch (error) {
  console.error(
    `semantic_correction_working_bundle=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
