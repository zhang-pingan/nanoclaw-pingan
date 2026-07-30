import fs from 'node:fs';
import path from 'node:path';

import { runG8ReleaseValidation } from './release-validation.js';
import { runG8StartupSmoke } from './startup-smoke.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing required option ${name}`);
  return process.argv[index + 1]!;
}

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
} else if (command === 'startup-smoke') {
  const report = runG8StartupSmoke({
    storeDir: path.resolve(option('--store-dir')),
    reportOutput: path.resolve(option('--report-output')),
  });
  console.log(`startup_smoke_status=${report.status}`);
  console.log(`startup_smoke_duration_ms=${report.duration_ms}`);
  console.log(`startup_smoke_report_hash=${report.report_hash}`);
} else if (command === 'readiness-validation') {
  const result = runG8ReleaseValidation({
    validationRoot: path.resolve(option('--validation-root')),
    outputRoot: path.resolve(option('--output-root')),
    onCaseCompleted: (observation) => {
      if (observation.statistics) {
        console.log(
          `validation_case=${observation.case_id} max_ms=${observation.statistics.max_ms}`,
        );
      } else {
        console.log(
          `validation_case=${observation.case_id} status=rejected_before_atomic_write`,
        );
      }
    },
  });
  console.log(`g8_readiness_status=${result.report.status}`);
  console.log(`g8_readiness_report_hash=${result.report.report_hash}`);
} else {
  throw new Error(
    'Usage: release-entry.js <identity|startup-smoke|readiness-validation>',
  );
}
