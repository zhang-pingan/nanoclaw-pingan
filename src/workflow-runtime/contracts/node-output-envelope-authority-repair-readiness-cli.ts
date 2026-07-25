import {
  checkNodeOutputEnvelopeRepairReadiness,
  generateNodeOutputEnvelopeRepairReadiness,
} from './node-output-envelope-authority-repair-readiness.js';

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== 'generate' && command !== 'check')) {
  console.error('Usage: node-output-envelope-authority-repair-readiness <generate|check>');
  process.exit(64);
}

try {
  const artifact =
    command === 'generate'
      ? generateNodeOutputEnvelopeRepairReadiness()
      : checkNodeOutputEnvelopeRepairReadiness();
  console.log(`node_output_envelope_repair_readiness=${command}:ok`);
  console.log(`authority_hash=${artifact.hash}`);
  console.log(`status=${String(artifact.payload.status)}`);
} catch (error) {
  console.error(
    `node_output_envelope_repair_readiness=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
