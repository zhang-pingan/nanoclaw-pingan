import {
  checkG39PackReleaseActivationContracts,
  generateG39PackReleaseActivationContracts,
} from './g3-pack-release-activation-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-pack-release-activation <generate|check>');
  process.exit(64);
}

try {
  const pack =
    command === 'generate'
      ? generateG39PackReleaseActivationContracts()
      : checkG39PackReleaseActivationContracts();
  console.log(`g3_9_pack_release_activation=${command}:ok`);
  console.log(`pack_hash=${pack.hash}`);
  console.log(`status=${String(pack.payload.status)}`);
} catch (error) {
  console.error(
    `g3_9_pack_release_activation=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
