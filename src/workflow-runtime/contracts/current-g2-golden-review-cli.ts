import {
  checkCurrentG2GoldenReview,
  generateCurrentG2GoldenReview,
} from './current-g2-golden-review.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: current-g2-golden-review <generate|check>');
  process.exit(64);
}

try {
  const report =
    command === 'generate'
      ? generateCurrentG2GoldenReview()
      : checkCurrentG2GoldenReview();
  console.log(`current_g2_golden_review=${command}:ok`);
  console.log(`golden_review_report_hash=${String(report.payload.report_hash)}`);
  console.log(`golden_review_artifact_hash=${report.hash}`);
  console.log(
    `golden_review_comparison=${String(report.payload.semantic_equal_count)}/40`,
  );
} catch (error) {
  console.error(
    `current_g2_golden_review=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
