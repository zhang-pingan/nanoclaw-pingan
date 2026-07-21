import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseContractArtifactEnvelope } from './artifact.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const contractsRoot = import.meta.dirname;
const CAPACITY_ROOT = 'conformance/capacity-control-plane-addendum';
const CAPACITY_MANIFEST = `${CAPACITY_ROOT}/contract-pack-capacity-control-plane-addendum.json`;
const CAPACITY_ROOT_HASH =
  'sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec';
const WORKING_GOLDEN_ROOT =
  'conformance/draft/resolved-g2-semantic-correction-v4';
const WORKING_GOLDEN_MANIFEST = `${WORKING_GOLDEN_ROOT}/golden-draft-manifest@4.json`;
const WORKING_GOLDEN_ROOT_HASH =
  'sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92';
const REVIEW_CANDIDATE_ROOT =
  'conformance/review-candidate/g2-semantic-correction';
const REVIEW_CANDIDATE_MANIFEST = `${REVIEW_CANDIDATE_ROOT}/review-candidate.json`;
const REVIEW_CANDIDATE_ROOT_HASH =
  'sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577';
const RESOLVED_GOLDEN_ROOT = 'conformance/draft/resolved-g2';
const RESOLVED_GOLDEN_MANIFEST = `${RESOLVED_GOLDEN_ROOT}/golden-draft-manifest@3.json`;
const RESOLVED_GOLDEN_ROOT_HASH =
  'sha256:659caf9b4add7027116bf780c83b2b85dc95ca0baae9cb8b9840d760a785132b';
const RESOLVED_GOLDEN_FILES = [
  `${RESOLVED_GOLDEN_ROOT}/artifact-inventory@1.json`,
  `${RESOLVED_GOLDEN_ROOT}/contract-fixtures/negative-cases.json`,
  `${RESOLVED_GOLDEN_ROOT}/contract-fixtures/positive-cases.json`,
  `${RESOLVED_GOLDEN_ROOT}/golden-draft-cases@3.json`,
  RESOLVED_GOLDEN_MANIFEST,
  `${RESOLVED_GOLDEN_ROOT}/golden-semantic-review-handoff@1.json`,
  `${RESOLVED_GOLDEN_ROOT}/schemas/golden-semantic-review-handoff-schema.json`,
  `${RESOLVED_GOLDEN_ROOT}/schemas/resolved-golden-draft-cases-schema.json`,
  `${RESOLVED_GOLDEN_ROOT}/schemas/resolved-golden-draft-fixtures-schema.json`,
  `${RESOLVED_GOLDEN_ROOT}/schemas/resolved-golden-draft-inventory-schema.json`,
  `${RESOLVED_GOLDEN_ROOT}/schemas/resolved-golden-draft-manifest-schema.json`,
] as const;

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`Historical artifact path escapes root: ${relativePath}`);
  }
  return resolved;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${label}`);
  return value.map((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`Expected object entry: ${label}`);
    }
    return entry;
  });
}

function rawHash(bytes: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function listTree(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink())
        throw new Error('Historical tree contains a symlink');
      if (stat.isDirectory()) visit(candidate);
      else
        output.push(
          path.relative(contractsRoot, candidate).split(path.sep).join('/'),
        );
    }
  };
  visit(root);
  return output.sort();
}

export function checkCurrentSealedEraCapacityControlPlane(): ContractArtifactEnvelope {
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new Error('Sealed-era historical check requires current G2 seal');
  }
  const manifest = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(CAPACITY_MANIFEST))),
  );
  if (manifest.hash !== CAPACITY_ROOT_HASH) {
    throw new Error('Historical G0.10 root identity drift');
  }
  const expected = [CAPACITY_MANIFEST];
  for (const identity of objects(
    manifest.payload.artifacts,
    'G0.10 artifacts',
  )) {
    const relativePath = String(identity.path);
    const artifact = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
    );
    if (
      artifact.hash !== identity.hash ||
      artifact.format !== identity.format ||
      artifact.version !== identity.version
    ) {
      throw new Error(
        `Historical G0.10 artifact identity drift: ${relativePath}`,
      );
    }
    expected.push(relativePath);
  }
  if (
    JSON.stringify(listTree(absolute(CAPACITY_ROOT))) !==
    JSON.stringify(expected.sort())
  ) {
    throw new Error('Historical G0.10 artifact inventory drift');
  }
  return manifest;
}

export function checkCurrentSealedEraWorkingGolden(): ContractArtifactEnvelope {
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new Error('Sealed-era Working check requires current G2 seal');
  }
  const manifest = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(WORKING_GOLDEN_MANIFEST))),
  );
  if (
    manifest.hash !== WORKING_GOLDEN_ROOT_HASH ||
    manifest.payload.construction_phase !== 'WORKING' ||
    manifest.payload.publishable !== false ||
    manifest.payload.production_reachable !== false
  ) {
    throw new Error('Current G2 Working Golden root identity drift');
  }
  const bindings = [
    ['cases_ref', 'cases_hash'],
    ['semantic_review_handoff_ref', 'semantic_review_handoff_hash'],
    ['artifact_inventory_ref', 'artifact_inventory_hash'],
  ] as const;
  const expected = [WORKING_GOLDEN_MANIFEST];
  for (const [refField, hashField] of bindings) {
    const relativePath = String(manifest.payload[refField]);
    const artifact = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
    );
    if (artifact.hash !== manifest.payload[hashField]) {
      throw new Error(
        `Current G2 Working Golden binding drift: ${relativePath}`,
      );
    }
    expected.push(relativePath);
  }
  if (
    JSON.stringify(listTree(absolute(WORKING_GOLDEN_ROOT))) !==
    JSON.stringify(expected.sort())
  ) {
    throw new Error('Current G2 Working Golden inventory drift');
  }
  return manifest;
}

export function checkCurrentSealedEraReviewCandidate(): ContractArtifactEnvelope {
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new Error('Sealed-era RC check requires current G2 seal');
  }
  const root = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(REVIEW_CANDIDATE_MANIFEST))),
  );
  if (
    root.hash !== REVIEW_CANDIDATE_ROOT_HASH ||
    root.payload.construction_phase !== 'RC_REVIEW' ||
    root.payload.case_count !== 40 ||
    root.payload.publishable !== false ||
    root.payload.production_reachable !== false
  ) {
    throw new Error('Current G2 Review Candidate root identity drift');
  }
  const boundRoots = root.payload.bound_working_roots;
  if (
    !boundRoots ||
    Array.isArray(boundRoots) ||
    typeof boundRoots !== 'object'
  ) {
    throw new Error('Current G2 Review Candidate Working bindings missing');
  }
  for (const key of ['contract', 'input', 'candidate', 'working_review']) {
    const identity = boundRoots[key];
    if (!identity || Array.isArray(identity) || typeof identity !== 'object') {
      throw new Error(`Current G2 bound Working root missing: ${key}`);
    }
    const relativePath = String(identity.path);
    const bytes = fs.readFileSync(absolute(relativePath));
    const artifact = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
    if (
      artifact.hash !== identity.semantic_hash ||
      rawHash(bytes) !== identity.raw_bytes_hash ||
      artifact.format !== identity.format
    ) {
      throw new Error(`Current G2 bound Working root drift: ${key}`);
    }
  }
  const expected = [REVIEW_CANDIDATE_MANIFEST];
  for (const field of [
    'review_candidate_cases',
    'fresh_review_handoff',
    'artifact_inventory',
  ]) {
    const identity = root.payload[field];
    if (!identity || Array.isArray(identity) || typeof identity !== 'object') {
      throw new Error(`Current G2 RC identity missing: ${field}`);
    }
    const relativePath = String(identity.path);
    const bytes = fs.readFileSync(absolute(relativePath));
    const artifact = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
    if (
      artifact.hash !== identity.semantic_hash ||
      rawHash(bytes) !== identity.raw_bytes_hash
    ) {
      throw new Error(`Current G2 RC artifact drift: ${field}`);
    }
    expected.push(relativePath);
  }
  if (
    JSON.stringify(listTree(absolute(REVIEW_CANDIDATE_ROOT))) !==
    JSON.stringify(expected.sort())
  ) {
    throw new Error('Current G2 RC singleton inventory drift');
  }
  return root;
}

export function checkCurrentSealedEraResolvedGoldenDraft(): ContractArtifactEnvelope {
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new Error('Sealed-era resolved Draft check requires current G2 seal');
  }
  if (
    JSON.stringify(listTree(absolute(RESOLVED_GOLDEN_ROOT))) !==
    JSON.stringify([...RESOLVED_GOLDEN_FILES].sort())
  ) {
    throw new Error('Historical resolved Golden Draft inventory drift');
  }
  let manifest: ContractArtifactEnvelope | null = null;
  for (const relativePath of RESOLVED_GOLDEN_FILES) {
    const artifact = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
    );
    if (relativePath === RESOLVED_GOLDEN_MANIFEST) manifest = artifact;
  }
  if (
    !manifest ||
    manifest.hash !== RESOLVED_GOLDEN_ROOT_HASH ||
    manifest.payload.draft_status !== 'published_pending_human_semantic_review'
  ) {
    throw new Error('Historical resolved Golden Draft root identity drift');
  }
  return manifest;
}
