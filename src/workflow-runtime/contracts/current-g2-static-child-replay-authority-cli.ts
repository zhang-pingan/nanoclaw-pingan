import {
  checkCurrentG2StaticChildReplayAuthority,
  generateCurrentG2StaticChildReplayAuthority,
} from './current-g2-static-child-replay-authority.js';

const mode = process.argv[2];

try {
  const built =
    mode === 'generate'
      ? generateCurrentG2StaticChildReplayAuthority()
      : mode === 'check'
        ? checkCurrentG2StaticChildReplayAuthority()
        : null;
  if (!built) {
    console.error(
      'Usage: current-g2-static-child-replay-authority <generate|check>',
    );
    process.exitCode = 2;
  } else {
    console.log(`current_g2_replay_authority=${built.authority.hash}`);
    console.log(
      `current_g2_replay_bundle=${built.authority.payload.bundle_hash}`,
    );
    console.log(`independent_expected_results=${built.authoredExactCount}/40`);
  }
} catch (error) {
  console.error(
    `current_g2_replay_authority=${mode}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
