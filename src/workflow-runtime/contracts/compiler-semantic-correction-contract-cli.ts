import {
  checkCompilerSemanticCorrectionContract,
  generateCompilerSemanticCorrectionContract,
} from './compiler-semantic-correction-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: compiler-working-contract <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateCompilerSemanticCorrectionContract()
      : checkCompilerSemanticCorrectionContract();
  console.log(`compiler_working_contract=${command}:ok`);
  console.log(`compiler_working_contract_root=${manifest.hash}`);
} catch (error) {
  console.error(
    `compiler_working_contract=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
