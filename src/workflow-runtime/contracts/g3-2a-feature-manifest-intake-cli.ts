import {
  checkG32AFeatureManifestIntake,
  generateG32AFeatureManifestIntake,
} from './g3-2a-feature-manifest-intake.js';

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== 'generate' && command !== 'check')) {
  console.error('Usage: g3-2a-feature-manifest-intake <generate|check>');
  process.exit(64);
}
try {
  const pack =
    command === 'generate'
      ? generateG32AFeatureManifestIntake()
      : checkG32AFeatureManifestIntake();
  console.log(`g3_2a_feature_manifest_intake=${command}:ok`);
  console.log(`pack_hash=${pack.hash}`);
  console.log(`g3_2a_status=${String(pack.payload.g32_status)}`);
  console.log(`positive_case_count=${String(pack.payload.positive_case_count)}`);
  console.log(`negative_case_count=${String(pack.payload.negative_case_count)}`);
  console.log(`reader_invoked=${String(pack.payload.reader_invoked)}`);
  console.log(`registry_write_performed=${String(pack.payload.registry_write_performed)}`);
} catch (error) {
  console.error(
    `g3_2a_feature_manifest_intake=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
