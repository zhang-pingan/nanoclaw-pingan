import {
  checkG6DynamicCloseContracts,
  generateG6DynamicCloseContracts,
} from './g6-dynamic-close-contract.js';

const command = process.argv[2];
if (command === 'generate') {
  generateG6DynamicCloseContracts();
  console.log('Generated current G6 Dynamic / Close Contract Pack.');
} else if (command === 'check') {
  const pack = checkG6DynamicCloseContracts();
  console.log(`Current G6 Dynamic / Close Contract Pack OK: ${pack.hash}`);
} else
  throw new Error('Usage: g6-dynamic-close-contract-cli.ts <generate|check>');
