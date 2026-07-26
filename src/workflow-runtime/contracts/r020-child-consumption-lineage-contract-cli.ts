import {
  checkR020ChildConsumptionLineageContract,
  generateR020ChildConsumptionLineageContract,
} from './r020-child-consumption-lineage-contract.js';

const command = process.argv[2];

if (command === 'generate') {
  generateR020ChildConsumptionLineageContract();
  console.log('Generated R-020 child consumption lineage Contract Pack.');
} else if (command === 'check') {
  const pack = checkR020ChildConsumptionLineageContract();
  console.log(`R-020 child consumption lineage Contract Pack OK: ${pack.hash}`);
} else {
  console.error(
    'Usage: r020-child-consumption-lineage-contract <generate|check>',
  );
  process.exitCode = 1;
}
