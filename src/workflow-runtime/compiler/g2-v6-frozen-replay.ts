import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import type { WorkflowCompilerConformanceCaseResultV1 } from '../contracts/compiler-contract-repair-types.js';
import { canonicalJson } from '../contracts/hash.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import type { JsonObject } from '../contracts/types.js';
import { compileG2NodeOutputEnvelopeCase } from './g2-node-output-envelope-authority-successor.js';
import type {
  WorkflowCompilerIdentity,
  WorkflowCompilerSourceKind,
} from './types.js';

const contractsRoot = path.resolve(import.meta.dirname, '../contracts');
const sealPath =
  'conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json';
const sealHash =
  'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11';
const bundleHash =
  'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7';

interface SealedCase extends JsonObject {
  case_id: string;
  source_kind: WorkflowCompilerSourceKind;
  raw_source_bytes_ref: string;
  registry_snapshot_ref: string;
  expected_result: { path: string };
}

function read(relativePath: string): Buffer {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `G2 v6 replay path escapes contracts root: ${relativePath}`,
    );
  }
  return fs.readFileSync(absolute);
}

export function checkG2V6FrozenReplay(): {
  readonly exactCount: number;
  readonly bundleHash: string;
} {
  const seal = parseContractArtifactEnvelope(
    strictParseJsonBytes(read(sealPath)),
  );
  if (seal.hash !== sealHash || seal.payload.bundle_hash !== bundleHash) {
    throw new Error('G2 v6 frozen seal identity drifted');
  }
  const cases = seal.payload.cases as unknown as SealedCase[];
  if (!Array.isArray(cases) || cases.length !== 40) {
    throw new Error('G2 v6 frozen replay requires exactly 40 cases');
  }
  const identity = seal.payload
    .exact_compiler_identity as unknown as WorkflowCompilerIdentity;
  let exactCount = 0;
  for (const entry of cases) {
    const snapshot = parseContractArtifactEnvelope(
      strictParseJsonBytes(read(entry.registry_snapshot_ref)),
    );
    const actual = compileG2NodeOutputEnvelopeCase(
      entry.case_id,
      entry.source_kind,
      read(entry.raw_source_bytes_ref),
      snapshot,
      identity,
    );
    const expected = strictParseJsonBytes(
      read(entry.expected_result.path),
    ) as WorkflowCompilerConformanceCaseResultV1;
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`G2 v6 frozen replay drift: ${entry.case_id}`);
    }
    exactCount += 1;
  }
  return { exactCount, bundleHash };
}
