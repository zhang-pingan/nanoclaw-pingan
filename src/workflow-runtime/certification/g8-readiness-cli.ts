import path from 'node:path';

import {
  G8_VALIDATION_OUTPUT_ROOT,
  checkG8ReadinessOutput,
  readinessMaxima,
} from './g8-readiness-artifacts.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const outputIndex = process.argv.indexOf('--output-root');
const outputRoot = path.resolve(
  outputIndex < 0
    ? path.join(projectRoot, G8_VALIDATION_OUTPUT_ROOT)
    : (process.argv[outputIndex + 1] ?? ''),
);
if (process.argv[2] !== 'check') {
  throw new Error('Usage: g8-readiness-cli.ts check [--output-root PATH]');
}
const result = checkG8ReadinessOutput(outputRoot);
const maxima = readinessMaxima(result.readinessReport);
console.log(`release_artifact_hash=${result.release.release_artifact_hash}`);
console.log(`core_build_hash=${result.release.core_build_hash}`);
console.log(`startup_smoke_report_hash=${result.startupReport.report_hash}`);
console.log(`g8_readiness_report_hash=${result.readinessReport.report_hash}`);
console.log(`supported_representative_max_ms=${JSON.stringify(maxima)}`);
