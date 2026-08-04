import path from 'node:path';

import { verifyInstalledHostCoreRelease } from './release.js';

function usage(): never {
  throw new Error('Usage: release-entry.js verify --release-root <path>');
}

const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  args[0] !== 'verify' ||
  args[1] !== '--release-root' ||
  !args[2]
)
  usage();
const manifest = verifyInstalledHostCoreRelease(path.resolve(args[2]));
console.log(
  `host_core_release_artifact_hash=${manifest.release_artifact_hash}`,
);
console.log(`host_core_version=${manifest.ref.version}`);
console.log(`host_core_validation_status=${manifest.validation_status}`);
