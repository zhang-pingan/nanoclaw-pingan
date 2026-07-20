import {
  checkSemanticCorrectionDraft,
  generateSemanticCorrectionDraft,
} from './semantic-correction-draft.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: semantic-correction-working-bundle <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
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
