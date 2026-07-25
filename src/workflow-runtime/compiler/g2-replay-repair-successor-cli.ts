import {
  G2ReplayRepairSuccessorError,
  generateG2ReplayRepairSuccessor,
} from './g2-replay-repair-successor.js';
import { evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay } from './current-g2-golden-replay.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g2-replay-repair-successor <generate|check>');
  process.exit(64);
}

try {
  if (command === 'generate') {
    const built = generateG2ReplayRepairSuccessor('human:local-owner');
    console.log('g2_replay_repair_successor=generate:ok');
    console.log(`successor_rc_hash=${built.rc.hash}`);
    console.log(
      `successor_draft_manifest_hash=${built.draft.payload.draft_manifest_hash}`,
    );
    console.log(
      `successor_review_report_hash=${built.review.payload.report_hash}`,
    );
    console.log(`successor_exact_equal=${built.exactEqualCount}/40`);
  } else {
    const replay = evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay();
    if (!replay.passed) {
      throw new Error(
        `Historical G2 v5 replay matched ${replay.exact_equal_count}/40`,
      );
    }
    console.log('g2_replay_repair_successor=check:ok');
    console.log(`historical_exact_equal=${replay.exact_equal_count}/40`);
    console.log(`historical_bundle_hash=${replay.expected_bundle_hash}`);
  }
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
    if (error instanceof Error && error.stack) console.error(error.stack);
  }
  process.exitCode = 1;
}
