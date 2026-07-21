import path from 'node:path';

import {
  checkResolvedGoldenDraftArtifacts,
  generateResolvedGoldenDraftArtifacts,
} from './resolved-golden-draft.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { checkCurrentSealedEraResolvedGoldenDraft } from './current-sealed-era-historical-checks.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: resolved-golden-draft <generate|check>');
  process.exit(64);
}

try {
  const sealedState = assertCurrentG2SealedBoundary(
    path.join(import.meta.dirname, 'conformance/sealed'),
  );
  const manifest =
    sealedState === 'current_g2'
      ? checkCurrentSealedEraResolvedGoldenDraft()
      : command === 'generate'
        ? generateResolvedGoldenDraftArtifacts()
        : checkResolvedGoldenDraftArtifacts();
  console.log(`resolved_golden_draft=${command}:ok`);
  console.log(`resolved_golden_draft_root=${manifest.hash}`);
} catch (error) {
  console.error(
    `resolved_golden_draft=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
