import fs from 'node:fs';
import path from 'node:path';

const command = process.argv[2];

if (command === 'identity') {
  const releaseRoot = path.resolve(import.meta.dirname, '../../..');
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(releaseRoot, 'core-release-manifest.json'),
      'utf8',
    ),
  ) as { release_artifact_hash: string; core_build_hash: string };
  console.log(
    JSON.stringify({
      command: 'identity',
      release_artifact_hash: manifest.release_artifact_hash,
      core_build_hash: manifest.core_build_hash,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
} else {
  throw new Error('Usage: release-entry.js <identity|startup-smoke|benchmark>');
}
