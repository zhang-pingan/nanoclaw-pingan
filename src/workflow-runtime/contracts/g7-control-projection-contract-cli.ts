import {
  checkG7ControlProjectionContracts,
  generateG7ControlProjectionContracts,
} from './g7-control-projection-contract.js';

const command = process.argv[2];
if (command === 'generate') {
  generateG7ControlProjectionContracts();
  console.log(
    'Generated current G7 Control / Card / Projection / Recovery Contract Pack.',
  );
} else if (command === 'check') {
  const pack = checkG7ControlProjectionContracts();
  console.log(
    `Current G7 Control / Card / Projection / Recovery Contract Pack OK: ${pack.hash}`,
  );
} else
  throw new Error(
    'Usage: g7-control-projection-contract-cli.ts <generate|check>',
  );
