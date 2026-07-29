import fs from 'node:fs';
import path from 'node:path';

import { observeMinimumMachineClass } from './machine-class.js';
import { runG8ReleaseBenchmark } from './release-benchmark.js';
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
} else if (command === 'machine-observation') {
  console.log(
    JSON.stringify(
      observeMinimumMachineClass({
        targetPath: path.resolve(option('--target-path')),
        purpose: 'certification_reference',
        confirmNoConcurrentBenchmarkInterference: process.argv.includes(
          '--confirm-no-concurrent-interference',
        ),
      }),
    ),
  );
} else if (command === 'startup-smoke') {
  const report = runG8StartupSmoke({
    storeDir: path.resolve(option('--store-dir')),
    reportOutput: path.resolve(option('--report-output')),
  });
  console.log(`startup_smoke_status=${report.status}`);
  console.log(`startup_smoke_duration_ms=${report.duration_ms}`);
  console.log(`startup_smoke_report_hash=${report.report_hash}`);
} else if (command === 'benchmark') {
  const result = runG8ReleaseBenchmark({
    benchmarkRoot: path.resolve(option('--benchmark-root')),
    outputRoot: path.resolve(option('--output-root')),
    confirmNoConcurrentInterference: process.argv.includes(
      '--confirm-no-concurrent-interference',
    ),
    onCaseCompleted: (observation) => {
      if (observation.statistics) {
        console.log(
          `benchmark_case=${observation.case_id} p99_ms=${observation.statistics.p99_ms} max_ms=${observation.statistics.max_ms}`,
        );
      } else {
        console.log(
          `benchmark_case=${observation.case_id} status=rejected_before_atomic_write`,
        );
      }
    },
  });
  console.log(`sqlite_profile_hash=${result.profile.profile_hash}`);
  console.log(
    `benchmark_observation_hash=${result.observation.observation_hash}`,
  );
} else {
  throw new Error(
    'Usage: release-entry.js <identity|machine-observation|startup-smoke|benchmark>',
  );
}
