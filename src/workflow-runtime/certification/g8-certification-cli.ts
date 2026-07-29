import path from 'node:path';

import {
  G8_CERTIFICATION_OUTPUT_ROOT,
  assembleG8Certification,
  checkG8CertificationOutput,
} from './g8-certification-artifacts.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function outputRoot(): string {
  return path.resolve(
    option('--output-root') ??
      path.join(projectRoot, G8_CERTIFICATION_OUTPUT_ROOT),
  );
}

const command = process.argv[2];
if (command === 'assemble') {
  const timestamp = Number(option('--certified-at-ms'));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw new Error(
      'assemble requires --certified-at-ms as a positive safe integer',
    );
  const result = assembleG8Certification({
    outputRoot: outputRoot(),
    certifiedAtMs: timestamp,
  });
  console.log(`runtime_supported_limits_hash=${result.limits.profile_hash}`);
  console.log(`certification_key_hash=${result.pack.certification_key_hash}`);
  console.log(`certification_pack_hash=${result.pack.pack_hash}`);
} else if (command === 'check') {
  const result = checkG8CertificationOutput(outputRoot());
  console.log(`sqlite_profile_hash=${result.profile.profile_hash}`);
  console.log(
    `benchmark_observation_hash=${result.observation.observation_hash}`,
  );
  console.log(`runtime_supported_limits_hash=${result.limits.profile_hash}`);
  console.log(`certification_key_hash=${result.pack.certification_key_hash}`);
  console.log(`certification_pack_hash=${result.pack.pack_hash}`);
} else {
  throw new Error(
    'Usage: g8-certification-cli.ts <assemble|check> [--output-root PATH] [--certified-at-ms INTEGER]',
  );
}
