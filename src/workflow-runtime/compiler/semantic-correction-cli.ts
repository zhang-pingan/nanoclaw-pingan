import {
  checkSemanticCorrectionCandidate,
  generateSemanticCorrectionCandidate,
} from './semantic-correction.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error(
    'Usage: workflow-compiler-semantic-correction <generate|check>',
  );
  process.exit(64);
}

try {
  const root =
    command === 'generate'
      ? generateSemanticCorrectionCandidate()
      : checkSemanticCorrectionCandidate();
  console.log(`g2_semantic_correction_candidate=${command}:ok`);
  console.log(`g2_semantic_correction_candidate_root=${root.hash}`);
} catch (error) {
  console.error(
    `g2_semantic_correction_candidate=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
