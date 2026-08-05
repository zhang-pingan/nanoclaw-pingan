import path from 'node:path';

import { verifyHostCoreSnapshot } from './release.js';

function usage(): never {
  throw new Error(
    'Usage: release-entry.js verify --runtime-home <path> --id <snapshot-id>',
  );
}

const args = process.argv.slice(2);
if (
  args.length !== 5 ||
  args[0] !== 'verify' ||
  args[1] !== '--runtime-home' ||
  !args[2] ||
  args[3] !== '--id' ||
  !args[4]
)
  usage();
const snapshot = verifyHostCoreSnapshot(path.resolve(args[2]), args[4]);
console.log(`host_core_snapshot_verified=${snapshot.snapshot_id}`);
