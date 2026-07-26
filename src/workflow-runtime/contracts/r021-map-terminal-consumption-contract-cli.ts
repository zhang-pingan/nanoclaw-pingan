import {
  checkR021MapTerminalConsumptionContract,
  generateR021MapTerminalConsumptionContract,
} from './r021-map-terminal-consumption-contract.js';

const command = process.argv[2];

if (command === 'generate') {
  generateR021MapTerminalConsumptionContract();
  console.log('Generated R-021 map terminal consumption Contract Pack.');
} else if (command === 'check') {
  const pack = checkR021MapTerminalConsumptionContract();
  console.log(`R-021 map terminal consumption Contract Pack OK: ${pack.hash}`);
} else {
  console.error(
    'Usage: r021-map-terminal-consumption-contract <generate|check>',
  );
  process.exitCode = 1;
}
