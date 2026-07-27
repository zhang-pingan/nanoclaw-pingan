import {
  checkR022DomainClaimHandoffContract,
  generateR022DomainClaimHandoffContract,
} from './r022-domain-claim-handoff-contract.js';

const command = process.argv[2];

if (command === 'generate') {
  generateR022DomainClaimHandoffContract();
  console.log('Generated R-022 Domain Claim handoff Contract Pack.');
} else if (command === 'check') {
  const pack = checkR022DomainClaimHandoffContract();
  console.log(`R-022 Domain Claim handoff Contract Pack OK: ${pack.hash}`);
} else {
  console.error('Usage: r022-domain-claim-handoff-contract <generate|check>');
  process.exitCode = 1;
}
