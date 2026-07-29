import fs from 'node:fs';
import path from 'node:path';

import {
  createG8FoundationArtifacts,
  G8_MINIMUM_MACHINE_CLASS_PATH,
  G8_STARTUP_SMOKE_HARNESS_PATH,
} from './g8-foundation-contracts.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const mode = process.argv[2];
if (mode !== 'generate' && mode !== 'check') {
  throw new Error('Usage: g8-foundation-cli.ts <generate|check>');
}

const artifacts = createG8FoundationArtifacts(projectRoot);
const outputs = [
  {
    relativePath: G8_MINIMUM_MACHINE_CLASS_PATH,
    artifact: artifacts.minimumMachineClass,
  },
  {
    relativePath: G8_STARTUP_SMOKE_HARNESS_PATH,
    artifact: artifacts.startupSmokeHarness,
  },
];
for (const { relativePath, artifact } of outputs) {
  const filePath = path.join(projectRoot, relativePath);
  const expected = `${JSON.stringify(artifact, null, 2)}\n`;
  if (mode === 'generate') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, expected);
  } else if (
    !fs.existsSync(filePath) ||
    fs.readFileSync(filePath, 'utf8') !== expected
  ) {
    throw new Error(`G8 foundation artifact drifted: ${relativePath}`);
  }
  console.log(`${relativePath}=${artifact.hash}`);
}
