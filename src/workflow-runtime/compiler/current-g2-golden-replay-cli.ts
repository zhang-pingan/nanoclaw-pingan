import {
  checkCurrentG2GoldenReplay,
  CurrentG2GoldenReplayError,
} from './current-g2-golden-replay.js';

if (process.argv.length !== 3 || process.argv[2] !== 'check') {
  console.error('Usage: current-g2-golden-replay check');
  process.exit(64);
}

try {
  const result = checkCurrentG2GoldenReplay();
  console.log('current_g2_golden_replay=check:ok');
  console.log(`exact_equal=${result.exact_equal_count}/40`);
  console.log(`bundle_hash=${result.expected_bundle_hash}`);
} catch (error) {
  if (error instanceof CurrentG2GoldenReplayError) {
    console.error('current_g2_golden_replay=check:failed');
    console.error(`exact_equal=${error.result.exact_equal_count}/40`);
    console.error(`mismatch_count=${error.result.mismatch_count}`);
    console.error(
      `mismatched_case_ids=${error.result.mismatched_case_ids.join(',')}`,
    );
  } else {
    console.error(
      `current_g2_golden_replay=check:failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  process.exitCode = 1;
}
