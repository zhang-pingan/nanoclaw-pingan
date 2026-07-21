import {
  checkCurrentG2GoldenDraft,
  generateCurrentG2GoldenDraft,
} from './current-g2-golden-draft.js';

const command = process.argv[2];
const generate = command === 'generate';
const check = command === 'check';
const authorizedBy =
  process.argv[3] === '--authorized-by' ? process.argv[4] : undefined;

if (
  (!generate && !check) ||
  (generate && (process.argv.length !== 5 || authorizedBy === undefined)) ||
  (check && process.argv.length !== 3)
) {
  console.error(
    'Usage: current-g2-golden-draft <generate --authorized-by ACTOR|check>',
  );
  process.exit(64);
}

try {
  const manifest = generate
    ? generateCurrentG2GoldenDraft(authorizedBy!)
    : checkCurrentG2GoldenDraft();
  console.log(`current_g2_golden_draft=${command}:ok`);
  console.log(
    `draft_manifest_hash=${String(manifest.payload.draft_manifest_hash)}`,
  );
  console.log(`draft_artifact_hash=${manifest.hash}`);
} catch (error) {
  console.error(
    `current_g2_golden_draft=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
