import {
  checkG2ProductionCompilerArtifacts,
  generateG2ProductionCompilerArtifacts,
} from './artifacts.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: workflow-compiler-artifacts <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateG2ProductionCompilerArtifacts()
      : checkG2ProductionCompilerArtifacts();
  console.log(`g2_production_compiler=${command}:ok`);
  console.log(`g2_production_compiler_root=${manifest.hash}`);
} catch (error) {
  console.error(
    `g2_production_compiler=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
