import {
  checkG9ProductionActivationContracts,
  generateG9ProductionActivationContracts,
} from './g9-production-activation-contract.js';

const command = process.argv[2];
const pack =
  command === 'generate'
    ? generateG9ProductionActivationContracts()
    : command === 'check'
      ? checkG9ProductionActivationContracts()
      : null;

if (!pack)
  throw new Error('Usage: g9-production-activation-cli.ts <generate|check>');

console.log(`g9_preactivation_contract=${command}:ok`);
console.log(`g9_preactivation_contract_hash=${pack.hash}`);
