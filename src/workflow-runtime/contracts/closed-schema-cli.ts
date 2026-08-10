import {
  checkContractPackClosedSchemas,
  generateContractPackClosedSchemas,
} from './closed-schema-pack.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: closed-schema <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateContractPackClosedSchemas()
      : checkContractPackClosedSchemas();
  console.log(`closed_schema=${command}:ok`);
  console.log(`manifest_hash=${manifest.hash}`);
} catch (error) {
  console.error(
    `closed_schema=${command}:failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
