import {
  checkGeneratedSchemaJoinAuthorityRepair,
  generateGeneratedSchemaJoinAuthorityRepair,
} from './generated-schema-join-authority-repair.js';

const command = process.argv[2];

if (command === 'generate') {
  generateGeneratedSchemaJoinAuthorityRepair();
  console.log(
    'Generated generated-schema/join-authority repair Contract Pack.',
  );
} else if (command === 'check') {
  const pack = checkGeneratedSchemaJoinAuthorityRepair();
  console.log(
    `Generated-schema/join-authority repair Contract Pack OK: ${pack.hash}`,
  );
} else {
  console.error(
    'Usage: generated-schema-join-authority-repair <generate|check>',
  );
  process.exitCode = 1;
}
