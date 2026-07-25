import {
  checkG2NodeOutputEnvelopeSeal,
  generateG2NodeOutputEnvelopeSeal,
} from './g2-node-output-envelope-authority-successor-seal.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g2-node-output-envelope-authority-successor-seal <generate|check>');
  process.exit(64);
}

try {
  const bundle =
    command === 'generate'
      ? generateG2NodeOutputEnvelopeSeal()
      : checkG2NodeOutputEnvelopeSeal();
  console.log(`g2_node_output_envelope_seal=${command}:ok`);
  console.log(`bundle_hash=${String(bundle.payload.bundle_hash)}`);
  console.log(`bundle_artifact_hash=${bundle.hash}`);
  console.log(
    `sealed_artifact_count=${String(bundle.payload.sealed_artifact_count)}`,
  );
  console.log(`ci_replay_status=${String(bundle.payload.ci_replay_status)}`);
} catch (error) {
  console.error(
    `g2_node_output_envelope_seal=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
