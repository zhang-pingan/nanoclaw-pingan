import path from 'node:path';

import { installG8CoreRelease } from './release-manifest.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing required option ${name}`);
  return process.argv[index + 1]!;
}

if (process.argv[2] !== 'install')
  throw new Error(
    'Usage: release-cli.ts install --project-root PATH --runtime-home PATH --manifest-output PATH',
  );

const manifest = installG8CoreRelease({
  projectRoot: path.resolve(option('--project-root')),
  runtimeHome: path.resolve(option('--runtime-home')),
  manifestOutput: path.resolve(option('--manifest-output')),
});
console.log(`release_artifact_hash=${manifest.release_artifact_hash}`);
console.log(`core_build_hash=${manifest.core_build_hash}`);
console.log(`core_entry_sha256=${manifest.core_entry_sha256}`);
console.log(
  `certification_entry_sha256=${manifest.certification_entry_sha256}`,
);
