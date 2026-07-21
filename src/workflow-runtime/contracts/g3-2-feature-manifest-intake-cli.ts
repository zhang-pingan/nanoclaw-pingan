import {
  checkG32FeatureManifestIntake,
  generateG32FeatureManifestIntake,
} from './g3-2-feature-manifest-intake.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-2-feature-manifest-intake <generate|check>');
  process.exit(64);
}

try {
  const pack =
    command === 'generate'
      ? generateG32FeatureManifestIntake()
      : checkG32FeatureManifestIntake();
  console.log(`g3_2_feature_manifest_intake=${command}:ok`);
  console.log(`pack_hash=${pack.hash}`);
  console.log(`g3_2_status=${String(pack.payload.status)}`);
  console.log(`reader_invoked=${String(pack.payload.reader_invoked)}`);
  console.log(`resolver_invoked=${String(pack.payload.resolver_invoked)}`);
  console.log(
    `registry_write_performed=${String(pack.payload.registry_write_performed)}`,
  );
} catch (error) {
  console.error(
    `g3_2_feature_manifest_intake=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
