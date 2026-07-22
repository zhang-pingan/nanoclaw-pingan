import {
  checkG39FeatureReleaseActivationContracts,
  generateG39FeatureReleaseActivationContracts,
} from './g3-feature-release-activation-contract.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-feature-release-activation <generate|check>');
  process.exit(64);
}

try {
  const pack =
    command === 'generate'
      ? generateG39FeatureReleaseActivationContracts()
      : checkG39FeatureReleaseActivationContracts();
  console.log(`g3_9_feature_release_activation=${command}:ok`);
  console.log(`pack_hash=${pack.hash}`);
  console.log(`status=${String(pack.payload.status)}`);
} catch (error) {
  console.error(
    `g3_9_feature_release_activation=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
