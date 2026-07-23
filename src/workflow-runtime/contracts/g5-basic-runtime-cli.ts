import {
  checkG5BasicRuntimeContracts,
  generateG5BasicRuntimeContracts,
} from './g5-basic-runtime-contract.js';

const command = process.argv[2];
if (command === 'generate') {
  generateG5BasicRuntimeContracts();
  console.log('Generated G5 Basic Runtime Contract Pack.');
} else if (command === 'check') {
  const pack = checkG5BasicRuntimeContracts();
  console.log(`G5 Basic Runtime Contract Pack OK: ${pack.hash}`);
} else {
  throw new Error('Usage: g5-basic-runtime-cli.ts <generate|check>');
}
