import {
  checkG3RegistryPublishFoundation,
  generateG3RegistryPublishFoundation,
} from './g3-registry-publish-foundation.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-registry-publish-foundation <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateG3RegistryPublishFoundation()
      : checkG3RegistryPublishFoundation();
  console.log(`g3_registry_publish_foundation=${command}:ok`);
  console.log(`manifest_hash=${manifest.hash}`);
  console.log(`g3_status=${String(manifest.payload.g3_status)}`);
  console.log(
    `positive_case_count=${String(manifest.payload.positive_case_count)}`,
  );
  console.log(
    `negative_case_count=${String(manifest.payload.negative_case_count)}`,
  );
  console.log(
    `production_registry_write_performed=${String(
      manifest.payload.production_registry_write_performed,
    )}`,
  );
  console.log(
    `production_activation_performed=${String(
      manifest.payload.production_activation_performed,
    )}`,
  );
} catch (error) {
  console.error(
    `g3_registry_publish_foundation=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
