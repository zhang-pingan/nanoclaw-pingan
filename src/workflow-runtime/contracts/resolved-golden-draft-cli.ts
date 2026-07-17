import {
  checkResolvedGoldenDraftArtifacts,
  generateResolvedGoldenDraftArtifacts,
} from './resolved-golden-draft.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: resolved-golden-draft <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
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
