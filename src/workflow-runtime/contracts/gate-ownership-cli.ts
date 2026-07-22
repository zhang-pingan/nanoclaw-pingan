import {
  checkGateOwnershipContracts,
  generateGateOwnershipContracts,
} from './gate-ownership-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: gate-ownership <generate|check>');
  process.exit(64);
}

try {
  const authority =
    command === 'generate'
      ? generateGateOwnershipContracts()
      : checkGateOwnershipContracts();
  console.log(`gate_ownership=${command}:ok`);
  console.log(`authority_hash=${authority.hash}`);
  console.log(`status=${String(authority.payload.status)}`);
} catch (error) {
  console.error(
    `gate_ownership=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
