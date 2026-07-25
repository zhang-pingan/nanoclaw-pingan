import {
  checkG4NodeOutputEnvelopeAuthoritySuccessor,
  generateG4NodeOutputEnvelopeAuthoritySuccessor,
} from './g4-node-output-envelope-authority-successor.js';

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== 'generate' && command !== 'check')) {
  console.error('Usage: g4-node-output-envelope-authority-successor <generate|check>');
  process.exit(64);
}

try {
  const artifact =
    command === 'generate'
      ? generateG4NodeOutputEnvelopeAuthoritySuccessor()
      : checkG4NodeOutputEnvelopeAuthoritySuccessor();
  console.log(`g4_node_output_envelope_authority_successor=${command}:ok`);
  console.log(`authority_hash=${artifact.hash}`);
} catch (error) {
  console.error(
    `g4_node_output_envelope_authority_successor=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
