import {
  checkG5BasicRuntimeRepairContracts,
  generateG5BasicRuntimeRepairContracts,
} from './g5-basic-runtime-repair-contract.js';

const command = process.argv[2];
if (command === 'generate') {
  generateG5BasicRuntimeRepairContracts();
  console.log('Generated current G5 Basic Runtime repair Contract Pack.');
} else if (command === 'check') {
  const pack = checkG5BasicRuntimeRepairContracts();
  console.log(`Current G5 Basic Runtime repair Contract Pack OK: ${pack.hash}`);
} else
  throw new Error('Usage: g5-basic-runtime-repair-cli.ts <generate|check>');
