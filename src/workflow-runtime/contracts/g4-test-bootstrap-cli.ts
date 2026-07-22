import {
  checkG4TestBootstrapContracts,
  generateG4TestBootstrapContracts,
} from './g4-test-bootstrap-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g4-test-bootstrap <generate|check>');
  process.exit(64);
}

try {
  const contracts =
    command === 'generate'
      ? generateG4TestBootstrapContracts()
      : checkG4TestBootstrapContracts();
  console.log(`g4_test_bootstrap=${command}:ok`);
  console.log(`pack_hash=${contracts.pack.hash}`);
  console.log(`profile_hash=${contracts.profile.hash}`);
  console.log(
    `bootstrap_implementation_hash=${String(contracts.implementation.payload.implementation_hash)}`,
  );
} catch (error) {
  console.error(
    `g4_test_bootstrap=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
