import {
  checkG2ReplayRepairSuccessor,
  G2ReplayRepairSuccessorError,
  generateG2ReplayRepairSuccessor,
} from './g2-replay-repair-successor.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g2-replay-repair-successor <generate|check>');
  process.exit(64);
}

try {
  const built =
    command === 'generate'
      ? generateG2ReplayRepairSuccessor('human:local-owner')
      : checkG2ReplayRepairSuccessor();
  console.log(`g2_replay_repair_successor=${command}:ok`);
  console.log(`successor_rc_hash=${built.rc.hash}`);
  console.log(
    `successor_draft_manifest_hash=${built.draft.payload.draft_manifest_hash}`,
  );
  console.log(
    `successor_review_report_hash=${built.review.payload.report_hash}`,
  );
  console.log(`successor_exact_equal=${built.exactEqualCount}/40`);
} catch (error) {
  if (error instanceof G2ReplayRepairSuccessorError) {
    console.error('g2_replay_repair_successor=failed');
    console.error(error.message);
  } else {
    console.error(
      `g2_replay_repair_successor=failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  process.exitCode = 1;
}
