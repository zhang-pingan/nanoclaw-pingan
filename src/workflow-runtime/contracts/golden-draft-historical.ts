import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope } from './types.js';

export const G0_8_HISTORICAL_ROOT =
  'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22';

const contractsRoot = import.meta.dirname;
const manifestPath = 'contract-pack-golden-draft.json';

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

export function checkHistoricalGoldenDraft(): ContractArtifactEnvelope {
  const manifest = readArtifact(manifestPath);
  if (manifest.hash !== G0_8_HISTORICAL_ROOT) {
    throw new Error('Historical G0.8 root identity drift');
  }
  if (!Array.isArray(manifest.payload.artifacts)) {
    throw new Error('Historical G0.8 inventory is missing');
  }
  for (const descriptor of manifest.payload.artifacts) {
    assertJsonObject(descriptor);
    const artifactPath = String(descriptor.path);
    const artifact = readArtifact(artifactPath);
    if (
      artifact.hash !== descriptor.hash ||
      artifact.format !== descriptor.format ||
      artifact.domain_separator !== descriptor.domain_separator
    ) {
      throw new Error(`Historical G0.8 artifact drift: ${artifactPath}`);
    }
  }
  return manifest;
}
