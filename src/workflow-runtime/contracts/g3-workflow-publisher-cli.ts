import {
  checkG37WorkflowPublisherContracts,
  generateG37WorkflowPublisherContracts,
} from './g3-workflow-publisher-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-workflow-publisher <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateG37WorkflowPublisherContracts()
      : checkG37WorkflowPublisherContracts();
  console.log(`g3_workflow_publisher=${command}:ok`);
  console.log(`manifest_hash=${manifest.hash}`);
  console.log(`slice=${String(manifest.payload.slice)}`);
} catch (error) {
  console.error(
    `g3_workflow_publisher=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
