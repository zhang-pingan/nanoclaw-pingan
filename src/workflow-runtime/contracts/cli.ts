import {
  checkContractPackFoundation,
  generateContractPackFoundation,
} from './contract-pack.js';

function usage(): never {
  console.error('Usage: contract-pack <generate|check>');
  process.exit(64);
}

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  usage();
}

try {
  const manifest =
    command === 'generate'
      ? generateContractPackFoundation()
      : checkContractPackFoundation();
  console.log(`contract_pack_foundation=${command}:ok`);
  console.log(`contract_pack_foundation_hash=${manifest.hash}`);
} catch (error) {
  console.error(
    `contract_pack_foundation=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
