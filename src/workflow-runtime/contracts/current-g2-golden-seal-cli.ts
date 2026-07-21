import {
  checkCurrentG2GoldenSeal,
  generateCurrentG2GoldenSeal,
} from './current-g2-golden-seal.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: current-g2-golden-seal <generate|check>');
  process.exit(64);
}

try {
  const bundle =
    command === 'generate'
      ? generateCurrentG2GoldenSeal()
      : checkCurrentG2GoldenSeal();
  console.log(`current_g2_golden_seal=${command}:ok`);
  console.log(`bundle_hash=${String(bundle.payload.bundle_hash)}`);
  console.log(`bundle_artifact_hash=${bundle.hash}`);
  console.log(
    `sealed_artifact_count=${String(bundle.payload.sealed_artifact_count)}`,
  );
  console.log(`ci_replay_status=${String(bundle.payload.ci_replay_status)}`);
} catch (error) {
  console.error(
    `current_g2_golden_seal=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
