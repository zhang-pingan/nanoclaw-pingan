import {
  checkCapabilityOutboxBindingContract,
  generateCapabilityOutboxBindingContract,
} from './capability-outbox-binding-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: capability-outbox-binding <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateCapabilityOutboxBindingContract()
      : checkCapabilityOutboxBindingContract();
  console.log(`capability_outbox_binding=${command}:ok`);
  console.log(`capability_outbox_binding_root=${manifest.hash}`);
} catch (error) {
  console.error(
    `capability_outbox_binding=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
