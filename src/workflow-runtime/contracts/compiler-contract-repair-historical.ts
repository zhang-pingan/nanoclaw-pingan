import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope } from './types.js';

export const R016_HISTORICAL_ROOT =
  'sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324';

const contractsRoot = import.meta.dirname;
const repairRoot = 'conformance/compiler-contract-repair';
const manifestPath = `${repairRoot}/contract-pack-compiler-contract-repair.json`;

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

export function checkHistoricalCompilerContractRepair(): ContractArtifactEnvelope {
  const manifest = readArtifact(manifestPath);
  if (manifest.hash !== R016_HISTORICAL_ROOT) {
    throw new Error('Historical R-016 root identity drift');
  }
  if (!Array.isArray(manifest.payload.artifacts)) {
    throw new Error('Historical R-016 inventory is missing');
  }
  const expectedPaths = new Set<string>([manifestPath]);
  for (const descriptor of manifest.payload.artifacts) {
    assertJsonObject(descriptor);
    const artifactPath = String(descriptor.path);
    expectedPaths.add(artifactPath);
    const artifact = readArtifact(artifactPath);
    if (
      artifact.hash !== descriptor.hash ||
      artifact.format !== descriptor.format ||
      artifact.domain_separator !== descriptor.domain_separator
    ) {
      throw new Error(`Historical R-016 artifact drift: ${artifactPath}`);
    }
  }
  const actualPaths: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Historical R-016 tree contains a symlink: ${absolutePath}`,
        );
      }
      if (stat.isDirectory()) visit(absolutePath);
      else if (stat.isFile()) {
        actualPaths.push(
          path.relative(contractsRoot, absolutePath).split(path.sep).join('/'),
        );
      }
    }
  };
  visit(path.join(contractsRoot, repairRoot));
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((candidate) => !expectedPaths.has(candidate))
  ) {
    throw new Error('Historical R-016 frozen tree inventory drift');
  }
  return manifest;
}
