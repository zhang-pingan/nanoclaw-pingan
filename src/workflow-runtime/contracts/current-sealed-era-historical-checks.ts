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
  'sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6';
const WORKING_GOLDEN_ROOT =
  'conformance/draft/resolved-g2-semantic-correction-v4';
const WORKING_GOLDEN_MANIFEST = `${WORKING_GOLDEN_ROOT}/golden-draft-manifest@4.json`;
const WORKING_GOLDEN_ROOT_HASH =
  'sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92';
const WORKING_INPUT_ROOT = 'conformance/draft/semantic-correction-v4';
const WORKING_INPUT_MANIFEST = `${WORKING_INPUT_ROOT}/semantic-correction-input-manifest@1.json`;
const WORKING_INPUT_ROOT_HASH =
  'sha256:83080db01627d5b42046ce0a2e229ee3f4099208a8bfa2b028fc9b6241272dc8';
const WORKING_COMPILER_CANDIDATE_ROOT =
  'conformance/candidate/g2-semantic-correction-v2';
const WORKING_COMPILER_CANDIDATE_MANIFEST = `${WORKING_COMPILER_CANDIDATE_ROOT}/contract-pack-g2-semantic-correction-candidate.json`;
const WORKING_COMPILER_CANDIDATE_ROOT_HASH =
  'sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a';
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
const LEGACY_GOLDEN_DRAFT_ROOT =
  'conformance/golden-draft/g2-semantic-correction';
const LEGACY_GOLDEN_DRAFT_REF = `${LEGACY_GOLDEN_DRAFT_ROOT}/golden-draft-manifest@1.json`;
const LEGACY_GOLDEN_DRAFT_ARTIFACT_HASH =
  'sha256:1be05809900b1cab2af1382cef861c190abdc425654fd8b4c71289fb42c4324c';
const LEGACY_GOLDEN_DRAFT_HASH =
  'sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd';
const LEGACY_GOLDEN_REVIEW_ROOT =
  'conformance/golden-review/g2-semantic-correction';
const LEGACY_GOLDEN_REVIEW_REF = `${LEGACY_GOLDEN_REVIEW_ROOT}/golden-review-report@1.json`;
const LEGACY_GOLDEN_REVIEW_ARTIFACT_HASH =
  'sha256:b4970615096e056e75d08fbde18a122bb48aeb0fbed35ecda8c478d5d0e0d999';
const LEGACY_GOLDEN_REVIEW_HASH =
  'sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91';
const LEGACY_SEMANTIC_REVIEW_ROOT =
  'conformance/golden-semantic-review/g2-semantic-correction';
const LEGACY_SEMANTIC_REVIEW_REF = `${LEGACY_SEMANTIC_REVIEW_ROOT}/golden-semantic-review@1.json`;
const LEGACY_SEMANTIC_REVIEW_ARTIFACT_HASH =
  'sha256:f50faa521d676397b04ad1dfaf9c5560be56714e38d7e33ba2a2e0eb39edd47b';
const LEGACY_SEMANTIC_REVIEW_HASH =
  'sha256:b12442ce6bdefba73a6b7377006f2aa841d30d78a3060416bbe21048d07abea4';
const LEGACY_SEALED_ROOT = 'conformance/sealed/g2-semantic-correction';
const LEGACY_SEALED_REF = `${LEGACY_SEALED_ROOT}/golden-conformance-bundle@1.json`;
const LEGACY_SEALED_ARTIFACT_HASH =
  'sha256:4d874857ba4c91505c57979d3954ba4bf5e18c806a77f389b37c9ca9162b8c5c';
const LEGACY_SEALED_BUNDLE_HASH =
  'sha256:d00dc96d90ccfadd6081a77d7c4a16024e188b9a77a123743bc601f971219555';

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

function checkRawInventoryTree(
  root: string,
  manifestPath: string,
  manifest: ContractArtifactEnvelope,
  label: string,
): void {
  const expected = [manifestPath];
  for (const identity of objects(
    manifest.payload.artifact_inventory,
    `${label} inventory`,
  )) {
    const relativePath = String(identity.path);
    if (!relativePath.startsWith(`${root}/`)) {
      throw new Error(`${label} inventory path escapes its root`);
    }
    if (
      rawHash(fs.readFileSync(absolute(relativePath))) !== identity.raw_sha256
    ) {
      throw new Error(`${label} artifact bytes drift: ${relativePath}`);
    }
    expected.push(relativePath);
  }
  if (
    JSON.stringify(listTree(absolute(root))) !== JSON.stringify(expected.sort())
  ) {
    throw new Error(`${label} artifact inventory drift`);
  }
}

function readExactArtifact(
  relativePath: string,
  expectedHash: string,
  label: string,
): ContractArtifactEnvelope {
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
  if (artifact.hash !== expectedHash) {
    throw new Error(`${label} artifact identity drift`);
  }
  return artifact;
}

function checkFrozenInventory(
  root: string,
  rootRef: string,
  rootArtifact: ContractArtifactEnvelope,
  label: string,
): void {
  const inventoryRef = String(rootArtifact.payload.inventory_ref);
  const inventory = readExactArtifact(
    inventoryRef,
    String(rootArtifact.payload.inventory_hash),
    `${label} inventory`,
  );
  const expected = [rootRef, inventoryRef];
  const entries = objects(inventory.payload.entries, `${label} entries`);
  if (entries.length !== inventory.payload.entry_count) {
    throw new Error(`${label} inventory count drift`);
  }
  for (const entry of entries) {
    const relativePath = String(entry.path);
    if (!relativePath.startsWith(`${root}/`)) {
      throw new Error(`${label} inventory path escapes its root`);
    }
    if (
      rawHash(fs.readFileSync(absolute(relativePath))) !== entry.raw_bytes_hash
    ) {
      throw new Error(`${label} artifact bytes drift: ${relativePath}`);
    }
    expected.push(relativePath);
  }
  if (
    JSON.stringify(listTree(absolute(root))) !== JSON.stringify(expected.sort())
  ) {
    throw new Error(`${label} artifact inventory drift`);
  }
}

function assertLegacyGoldenBoundary(): void {
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new Error('Legacy Golden check requires current G2 seal');
  }
}

export function checkCurrentSealedEraLegacyGoldenDraft(): ContractArtifactEnvelope {
  assertLegacyGoldenBoundary();
  const draft = readExactArtifact(
    LEGACY_GOLDEN_DRAFT_REF,
    LEGACY_GOLDEN_DRAFT_ARTIFACT_HASH,
    'Legacy G2 Golden Draft',
  );
  if (draft.payload.draft_manifest_hash !== LEGACY_GOLDEN_DRAFT_HASH) {
    throw new Error('Legacy G2 Golden Draft semantic identity drift');
  }
  checkFrozenInventory(
    LEGACY_GOLDEN_DRAFT_ROOT,
    LEGACY_GOLDEN_DRAFT_REF,
    draft,
    'Legacy G2 Golden Draft',
  );
  return draft;
}

export function checkCurrentSealedEraLegacyGoldenReview(): ContractArtifactEnvelope {
  const draft = checkCurrentSealedEraLegacyGoldenDraft();
  const review = readExactArtifact(
    LEGACY_GOLDEN_REVIEW_REF,
    LEGACY_GOLDEN_REVIEW_ARTIFACT_HASH,
    'Legacy G2 Golden Review',
  );
  if (
    review.payload.report_hash !== LEGACY_GOLDEN_REVIEW_HASH ||
    review.payload.draft_manifest_hash !== draft.payload.draft_manifest_hash
  ) {
    throw new Error('Legacy G2 Golden Review lineage drift');
  }
  if (listTree(absolute(LEGACY_GOLDEN_REVIEW_ROOT)).length !== 2) {
    throw new Error('Legacy G2 Golden Review inventory drift');
  }
  return review;
}

export function checkCurrentSealedEraLegacySemanticReview(): ContractArtifactEnvelope {
  const draft = checkCurrentSealedEraLegacyGoldenDraft();
  const report = checkCurrentSealedEraLegacyGoldenReview();
  const review = readExactArtifact(
    LEGACY_SEMANTIC_REVIEW_REF,
    LEGACY_SEMANTIC_REVIEW_ARTIFACT_HASH,
    'Legacy G2 Semantic Review',
  );
  if (
    review.payload.review_hash !== LEGACY_SEMANTIC_REVIEW_HASH ||
    review.payload.draft_manifest_hash !== draft.payload.draft_manifest_hash ||
    review.payload.draft_artifact_hash !== draft.hash ||
    review.payload.golden_review_report_hash !== report.payload.report_hash ||
    review.payload.golden_review_report_artifact_hash !== report.hash
  ) {
    throw new Error('Legacy G2 Semantic Review lineage drift');
  }
  if (listTree(absolute(LEGACY_SEMANTIC_REVIEW_ROOT)).length !== 2) {
    throw new Error('Legacy G2 Semantic Review inventory drift');
  }
  return review;
}

export function checkCurrentSealedEraLegacyGoldenSeal(): ContractArtifactEnvelope {
  const draft = checkCurrentSealedEraLegacyGoldenDraft();
  const report = checkCurrentSealedEraLegacyGoldenReview();
  const review = checkCurrentSealedEraLegacySemanticReview();
  const bundle = readExactArtifact(
    LEGACY_SEALED_REF,
    LEGACY_SEALED_ARTIFACT_HASH,
    'Legacy G2 Golden Seal',
  );
  if (
    bundle.payload.bundle_hash !== LEGACY_SEALED_BUNDLE_HASH ||
    bundle.payload.draft_artifact_hash !== draft.hash ||
    bundle.payload.golden_review_report_artifact_hash !== report.hash ||
    bundle.payload.golden_semantic_review_artifact_hash !== review.hash
  ) {
    throw new Error('Legacy G2 Golden Seal lineage drift');
  }
  checkFrozenInventory(
    LEGACY_SEALED_ROOT,
    LEGACY_SEALED_REF,
    bundle,
    'Legacy G2 Golden Seal',
  );
  return bundle;
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

export function checkCurrentSealedEraWorkingCompilerCandidate(): ContractArtifactEnvelope {
  const reviewCandidate = checkCurrentSealedEraReviewCandidate();
  const input = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(WORKING_INPUT_MANIFEST))),
  );
  const candidate = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(absolute(WORKING_COMPILER_CANDIDATE_MANIFEST)),
    ),
  );
  if (
    input.hash !== WORKING_INPUT_ROOT_HASH ||
    input.payload.construction_phase !== 'WORKING' ||
    input.payload.publishable !== false ||
    input.payload.production_reachable !== false
  ) {
    throw new Error('Current G2 historical Working input root identity drift');
  }
  if (
    candidate.hash !== WORKING_COMPILER_CANDIDATE_ROOT_HASH ||
    candidate.payload.construction_phase !== 'WORKING' ||
    candidate.payload.publishable !== false ||
    candidate.payload.production_reachable !== false
  ) {
    throw new Error(
      'Current G2 historical Working Compiler candidate root identity drift',
    );
  }
  const boundRoots = reviewCandidate.payload.bound_working_roots as JsonObject;
  const inputBinding = boundRoots.input as JsonObject;
  const candidateBinding = boundRoots.candidate as JsonObject;
  if (
    inputBinding.semantic_hash !== input.hash ||
    candidateBinding.semantic_hash !== candidate.hash
  ) {
    throw new Error('Current G2 historical Working lineage drift');
  }
  checkRawInventoryTree(
    WORKING_INPUT_ROOT,
    WORKING_INPUT_MANIFEST,
    input,
    'Current G2 historical Working input',
  );
  checkRawInventoryTree(
    WORKING_COMPILER_CANDIDATE_ROOT,
    WORKING_COMPILER_CANDIDATE_MANIFEST,
    candidate,
    'Current G2 historical Working Compiler candidate',
  );
  return candidate;
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
