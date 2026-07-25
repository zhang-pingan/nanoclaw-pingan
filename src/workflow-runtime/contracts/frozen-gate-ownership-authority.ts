import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, Sha256Hash } from './types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

const FROZEN_FILES = [
  {
    path: 'src/workflow-runtime/contracts/gate-ownership-contract.ts',
    raw_sha256:
      'sha256:ab6b54a9f76d9fbcbc78dff3edea230f679e6e6adb68b443b29e26aa70537947',
    artifact_hash: null,
  },
  {
    path: 'src/workflow-runtime/contracts/governance/workflow-runtime-gate-ownership@1.json',
    raw_sha256:
      'sha256:291455af99b5225d63a50d978eecfedd541680d9957c5bba786294d1dd734f36',
    artifact_hash:
      'sha256:712a7440e83f087e4bbb1e465a1a677a16708429f46766029baa0f90734e5017',
  },
  {
    path: 'src/workflow-runtime/contracts/conformance/gate-ownership/positive-cases.json',
    raw_sha256:
      'sha256:3662ed98d6558909dd4324915ee509fd0999cbd0021ffd98dcc269a4ad1979bb',
    artifact_hash:
      'sha256:bf524f00778d1c2ea1299f3dd135f87cf8a5e57c057fb43d662d958b312cd40c',
  },
  {
    path: 'src/workflow-runtime/contracts/conformance/gate-ownership/negative-cases.json',
    raw_sha256:
      'sha256:9c556a4d347660b6565f49cbb310a8fc84248619403f9b615a6d59e9c3478251',
    artifact_hash:
      'sha256:eff355a591d065fa4c42b59c7d8d60c347c8c36c65a3dbbff5ab9bb29380c3db',
  },
] as const;

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function checkFrozenGateOwnershipAuthority(): ContractArtifactEnvelope {
  let authority: ContractArtifactEnvelope | null = null;
  for (const entry of FROZEN_FILES) {
    const bytes = fs.readFileSync(path.join(repoRoot, entry.path));
    if (rawSha256(bytes) !== entry.raw_sha256) {
      throw new Error(`Frozen gate ownership raw bytes drifted: ${entry.path}`);
    }
    if (entry.artifact_hash !== null) {
      const artifact = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
      if (artifact.hash !== entry.artifact_hash) {
        throw new Error(`Frozen gate ownership identity drifted: ${entry.path}`);
      }
      if (entry.path.includes('/governance/')) authority = artifact;
    }
  }
  if (authority === null) {
    throw new Error('Frozen gate ownership authority is missing');
  }
  return authority;
}
