import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  checkSemanticCorrectionCandidate,
  G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH,
  G2_SEMANTIC_CORRECTION_ROOT_MANIFEST_PATH,
  G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH,
} from '../compiler/semantic-correction.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
  checkCompilerSemanticCorrectionContract,
} from './compiler-semantic-correction-contract.js';
import {
  SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
  SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH,
} from './compiler-semantic-correction-inputs.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import {
  SEMANTIC_CORRECTION_DRAFT_CASES_PATH,
  SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH,
  checkSemanticCorrectionDraft,
} from './semantic-correction-draft.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');

export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_PARENT =
  'conformance/review-candidate';
export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_PARENT}/g2-semantic-correction`;
export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT}/review-candidate-cases@1.json`;
export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_HANDOFF_PATH = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT}/fresh-review-handoff@1.json`;
export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_INVENTORY_PATH = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT}/artifact-inventory@1.json`;
export const SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT}/review-candidate.json`;

export const EXPECTED_G2_WORKING_ROOTS = {
  contract:
    'sha256:a2d8bcab971d1db75aad17d152c7c616371a4ceeb8d52f408674d744cf7866b8',
  input:
    'sha256:83080db01627d5b42046ce0a2e229ee3f4099208a8bfa2b028fc9b6241272dc8',
  candidate:
    'sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a',
  working_review:
    'sha256:a254eec500006f1c7210835607cf0c20c9c6cc0647ae06a43ef2943d169d5c92',
} as const;

const CASES_DOMAIN = 'icarus:workflow-compiler-g2-review-candidate-cases:1\n';
const HANDOFF_DOMAIN = 'icarus:workflow-compiler-g2-fresh-review-handoff:1\n';
const INVENTORY_DOMAIN =
  'icarus:workflow-compiler-g2-review-candidate-inventory:1\n';
const ROOT_DOMAIN = 'icarus:workflow-compiler-g2-review-candidate:1\n';
const SOURCE_SET_DOMAIN =
  'icarus:workflow-compiler-g2-review-candidate-source-set:1\n';
const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const TOOLCHAIN_DOMAIN = 'icarus:workflow-compiler-toolchain-manifest:1\n';
const COMPILER_BUILD_DOMAIN = 'icarus:workflow-production-compiler-build:2\n';

export class SemanticCorrectionReviewCandidateError extends Error {
  readonly code = 'semantic_correction_review_candidate_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticCorrectionReviewCandidateError';
  }
}

interface LoadedWorkingSet {
  contract: ContractArtifactEnvelope;
  input: ContractArtifactEnvelope;
  candidate: ContractArtifactEnvelope;
  workingReview: ContractArtifactEnvelope;
  caseCatalog: ContractArtifactEnvelope;
  workingCases: ContractArtifactEnvelope;
  toolchain: JsonObject;
  resultsManifest: JsonObject;
  sourceEntries: JsonObject[];
  compilerSourceEntries: JsonObject[];
  summary: JsonObject;
}

function absoluteContractPath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new SemanticCorrectionReviewCandidateError(
      `Review Candidate path escapes Contract root: ${relativePath}`,
    );
  }
  return absolute;
}

function projectBytes(relativePath: string): Buffer {
  const absolute = path.resolve(projectRoot, relativePath);
  if (!absolute.startsWith(`${projectRoot}${path.sep}`)) {
    throw new SemanticCorrectionReviewCandidateError(
      `Review Candidate source path escapes project root: ${relativePath}`,
    );
  }
  return fs.readFileSync(absolute);
}

function rawHash(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  id: string,
  refVersion: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: refVersion },
    version: Number(format.slice(format.lastIndexOf('/') + 1)),
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absoluteContractPath(relativePath))),
  );
}

function readObject(relativePath: string): JsonObject {
  const value = strictParseJsonBytes(
    fs.readFileSync(absoluteContractPath(relativePath)),
  );
  assertJsonObject(value);
  return value;
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  try {
    assertJsonObject(value);
    return value;
  } catch {
    throw new SemanticCorrectionReviewCandidateError(
      `${label} must be an object`,
    );
  }
}

function objects(value: JsonValue | undefined, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new SemanticCorrectionReviewCandidateError(
      `${label} must be an array`,
    );
  }
  return value.map((entry) => object(entry, `${label} entry`));
}

function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new SemanticCorrectionReviewCandidateError(
      `${label} must be a string`,
    );
  }
  return value;
}

function hashWithoutField(
  value: JsonObject,
  field: string,
  domain: string,
): Sha256Hash {
  const { [field]: _ignored, ...withoutHash } = value;
  return domainSeparatedSha256(domain, withoutHash);
}

function artifactIdentity(
  relativePath: string,
  value: ContractArtifactEnvelope,
  bytes = Buffer.from(render(value), 'utf8'),
): JsonObject {
  return {
    path: relativePath,
    format: value.format,
    ref: value.ref,
    version: value.version,
    semantic_hash: value.hash,
    raw_bytes_hash: rawHash(bytes),
  };
}

function diskArtifactIdentity(
  relativePath: string,
  value: ContractArtifactEnvelope,
): JsonObject {
  return artifactIdentity(
    relativePath,
    value,
    fs.readFileSync(absoluteContractPath(relativePath)),
  );
}

function validateSealedAndVersionBoundariesAt(conformanceRoot: string): void {
  const sealed = fs.readdirSync(path.join(conformanceRoot, 'sealed'));
  if (sealed.length !== 1 || sealed[0] !== '.gitkeep') {
    throw new SemanticCorrectionReviewCandidateError(
      'prepare-rc crossed the sealed boundary',
    );
  }
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path
        .relative(conformanceRoot, absolute)
        .split(path.sep)
        .join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new SemanticCorrectionReviewCandidateError(
          `Conformance tree contains a symlink: ${relative}`,
        );
      }
      const hasForbiddenVersionSegment = relative
        .split('/')
        .some((segment) => /(^|[-_@])v[56]($|[-_.@])/.test(segment));
      if (hasForbiddenVersionSegment) {
        throw new SemanticCorrectionReviewCandidateError(
          `Draft v5/v6 path is forbidden: ${relative}`,
        );
      }
      if (stat.isDirectory()) visit(absolute);
    }
  };
  visit(conformanceRoot);
}

function validateSealedAndVersionBoundaries(): void {
  validateSealedAndVersionBoundariesAt(absoluteContractPath('conformance'));
}

function buildSourceEntries(
  caseCatalog: ContractArtifactEnvelope,
  workingCases: ContractArtifactEnvelope,
): JsonObject[] {
  const catalogCases = objects(
    caseCatalog.payload.cases,
    'Working case catalog',
  );
  const reviewCases = objects(
    workingCases.payload.cases,
    'Working review cases',
  );
  if (catalogCases.length !== 40 || reviewCases.length !== 40) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working source coverage must remain exactly 40 cases',
    );
  }
  const reviewByCase = new Map(
    reviewCases.map((entry) => [
      string(entry.case_id, 'review case id'),
      entry,
    ]),
  );
  if (reviewByCase.size !== 40) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working review case identity is not unique',
    );
  }
  return catalogCases.map((entry) => {
    const caseId = string(entry.case_id, 'case id');
    const reviewCase = reviewByCase.get(caseId);
    if (!reviewCase) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working review case is missing: ${caseId}`,
      );
    }
    const sourcePath = string(entry.raw_source_bytes_ref, 'source path');
    const sourceBytes = fs.readFileSync(absoluteContractPath(sourcePath));
    const sourceSemanticHash = string(
      entry.raw_source_bytes_hash,
      'source semantic hash',
    );
    if (
      domainSeparatedSha256(RAW_SOURCE_DOMAIN, sourceBytes.toString('utf8')) !==
        sourceSemanticHash ||
      reviewCase.raw_source_bytes_ref !== sourcePath ||
      reviewCase.raw_source_bytes_hash !== sourceSemanticHash
    ) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working source identity drift: ${caseId}`,
      );
    }
    const snapshotPath = string(entry.input_snapshot_ref, 'snapshot path');
    const snapshot = readArtifact(snapshotPath);
    if (
      snapshot.hash !== entry.input_snapshot_hash ||
      reviewCase.input_snapshot_ref !== snapshotPath ||
      reviewCase.input_snapshot_hash !== snapshot.hash
    ) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working snapshot identity drift: ${caseId}`,
      );
    }
    return {
      case_id: caseId,
      polarity: entry.polarity,
      source_kind: entry.source_kind,
      coverage_tags: entry.coverage_tags,
      source: {
        path: sourcePath,
        format: 'raw_workflow_source_bytes',
        ref: { id: caseId, version: 'working-frozen' },
        version: 1,
        semantic_hash: sourceSemanticHash,
        raw_bytes_hash: rawHash(sourceBytes),
      },
      input_snapshot: diskArtifactIdentity(snapshotPath, snapshot),
      review_input: reviewCase.review_input,
      actual_compiler_comparison: reviewCase.actual_compiler_candidate,
    };
  });
}

function buildCompilerSourceEntries(toolchain: JsonObject): JsonObject[] {
  const compilerBuild = object(toolchain.compiler_build, 'Compiler build');
  const references = compilerBuild.implementation_refs;
  if (!Array.isArray(references) || references.length === 0) {
    throw new SemanticCorrectionReviewCandidateError(
      'Compiler implementation inventory is missing',
    );
  }
  const entries = references.map((reference) => {
    const sourcePath = string(reference, 'Compiler source path');
    return {
      path: sourcePath,
      format: 'typescript_source',
      ref: {
        id: sourcePath,
        version: string(toolchain.compiler_version, 'Compiler version'),
      },
      version: 1,
      raw_bytes_hash: rawHash(projectBytes(sourcePath)),
    };
  });
  const calculated = domainSeparatedSha256(COMPILER_BUILD_DOMAIN, {
    files: entries.map((entry) => ({
      ref: entry.path,
      raw_sha256: entry.raw_bytes_hash,
    })),
  });
  if (calculated !== compilerBuild.implementation_hash) {
    throw new SemanticCorrectionReviewCandidateError(
      'Compiler implementation identity drift',
    );
  }
  return entries;
}

function expectedNullOracle(): JsonObject {
  return {
    status: 'not_authored_review_candidate',
    expected_full_result_bytes_ref: null,
    expected_full_result_bytes_hash: null,
    expected_full_result_semantic_hash: null,
    expected_plan_bytes_ref: null,
    expected_plan_bytes_hash: null,
    expected_plan_semantic_hash: null,
    expected_proof_bytes_ref: null,
    expected_proof_bytes_hash: null,
    expected_proof_hashes: null,
    expected_program_bytes_ref: null,
    expected_program_bytes_hash: null,
    expected_program_hashes: null,
  };
}

function validateWorkingSummary(summary: JsonObject): void {
  const roots = object(summary.working_roots, 'Working roots');
  for (const [role, expectedHash] of Object.entries(
    EXPECTED_G2_WORKING_ROOTS,
  )) {
    const identity = object(roots[role], `Working ${role} root`);
    if (identity.semantic_hash !== expectedHash) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working ${role} root drift: expected ${expectedHash}, received ${String(identity.semantic_hash)}`,
      );
    }
    if (
      identity.construction_phase !== 'WORKING' ||
      identity.publishable !== false ||
      identity.production_reachable !== false
    ) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working ${role} lifecycle is not eligible for prepare-rc`,
      );
    }
  }
  const toolchain = object(summary.toolchain_identity, 'Toolchain identity');
  const compiler = object(summary.compiler_identity, 'Compiler identity');
  if (
    toolchain.semantic_hash !== compiler.compiler_toolchain_hash ||
    toolchain.version !== compiler.compiler_version ||
    compiler.compiler_build_hash !== summary.compiler_build_hash
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Toolchain or Compiler identity binding drift',
    );
  }
  const source = object(summary.source_identity, 'Source identity');
  if (source.case_count !== 40 || typeof source.source_set_hash !== 'string') {
    throw new SemanticCorrectionReviewCandidateError(
      'Source identity coverage drift',
    );
  }
  const comparison = object(summary.actual_comparison, 'Actual comparison');
  if (
    comparison.case_count !== 40 ||
    comparison.compiled_count !== 11 ||
    comparison.rejected_count !== 29 ||
    comparison.role !== 'actual_compiler_output_not_golden_oracle'
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working actual comparison drift',
    );
  }
  const boundary = object(summary.boundary_status, 'Working boundary status');
  if (
    boundary.expected_full_result_plan_proof_program !== 'all_null' ||
    boundary.human_judgment_coverage !== 0 ||
    boundary.human_review_status !== 'not_requested' ||
    boundary.approval !== 'absent' ||
    boundary.signature !== 'absent' ||
    boundary.seal !== 'absent' ||
    boundary.sealed_artifact_count !== 0 ||
    boundary.production_reachable !== false
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working review or production boundary drift',
    );
  }
}

function loadWorkingSet(): LoadedWorkingSet {
  validateSealedAndVersionBoundaries();
  const contract = checkCompilerSemanticCorrectionContract();
  const candidate = checkSemanticCorrectionCandidate();
  const workingReview = checkSemanticCorrectionDraft();
  const input = readArtifact(SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH);
  const caseCatalog = readArtifact(SEMANTIC_CORRECTION_CASE_CATALOG_PATH);
  const workingCases = readArtifact(SEMANTIC_CORRECTION_DRAFT_CASES_PATH);
  const toolchain = readObject(G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH);
  const resultsManifest = readObject(
    G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH,
  );
  if (
    hashWithoutField(toolchain, 'toolchain_hash', TOOLCHAIN_DOMAIN) !==
    toolchain.toolchain_hash
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working toolchain semantic hash drift',
    );
  }
  const sourceEntries = buildSourceEntries(caseCatalog, workingCases);
  const compilerSourceEntries = buildCompilerSourceEntries(toolchain);
  const exactCompilerIdentity = object(
    workingReview.payload.exact_compiler_identity,
    'Exact Compiler identity',
  );
  const workingRoots: JsonObject = Object.fromEntries(
    [
      ['contract', COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH, contract],
      ['input', SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH, input],
      ['candidate', G2_SEMANTIC_CORRECTION_ROOT_MANIFEST_PATH, candidate],
      [
        'working_review',
        SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH,
        workingReview,
      ],
    ].map(([role, artifactPath, value]) => {
      const envelope = value as ContractArtifactEnvelope;
      return [
        role as string,
        {
          ...diskArtifactIdentity(artifactPath as string, envelope),
          construction_phase: envelope.payload.construction_phase,
          publishable: envelope.payload.publishable,
          production_reachable: envelope.payload.production_reachable,
        },
      ];
    }),
  );
  const sourceSetHash = domainSeparatedSha256(SOURCE_SET_DOMAIN, {
    sources: sourceEntries.map((entry) => ({
      case_id: entry.case_id,
      source: entry.source,
      input_snapshot: entry.input_snapshot,
    })),
  });
  const toolchainIdentity: JsonObject = {
    path: G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH,
    format: toolchain.format,
    ref: toolchain.ref,
    version: toolchain.compiler_version,
    semantic_hash: toolchain.toolchain_hash,
    raw_bytes_hash: rawHash(
      fs.readFileSync(
        absoluteContractPath(G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH),
      ),
    ),
  };
  const summary: JsonObject = {
    working_roots: workingRoots,
    source_identity: {
      case_catalog: diskArtifactIdentity(
        SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
        caseCatalog,
      ),
      case_count: 40,
      source_set_hash: sourceSetHash,
    },
    toolchain_identity: toolchainIdentity,
    compiler_identity: exactCompilerIdentity,
    compiler_build_hash: object(toolchain.compiler_build, 'Compiler build')
      .implementation_hash,
    actual_comparison: {
      role: 'actual_compiler_output_not_golden_oracle',
      case_count: candidate.payload.case_count,
      compiled_count: candidate.payload.compiled_count,
      rejected_count: candidate.payload.rejected_count,
      results_manifest_ref: G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH,
      results_manifest_hash: resultsManifest.manifest_hash,
      results_manifest_raw_bytes_hash: rawHash(
        fs.readFileSync(
          absoluteContractPath(G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH),
        ),
      ),
    },
    boundary_status: {
      expected_full_result_plan_proof_program: 'all_null',
      human_review_status: 'not_requested',
      human_judgment_coverage: 0,
      approval: 'absent',
      signature: 'absent',
      seal: 'absent',
      sealed_artifact_count: 0,
      production_reachable: false,
    },
  };
  validateWorkingSummary(summary);
  const reviewCases = objects(
    workingCases.payload.cases,
    'Working review cases',
  );
  for (const entry of reviewCases) {
    const expected = object(
      entry.expected_golden_oracle,
      'Working expected oracle',
    );
    if (
      entry.human_judgment !== null ||
      entry.review_status !== 'not_requested_until_prepare_rc' ||
      Object.entries(expected).some(
        ([key, value]) => key !== 'status' && value !== null,
      )
    ) {
      throw new SemanticCorrectionReviewCandidateError(
        `Working expected or human judgment drift: ${String(entry.case_id)}`,
      );
    }
  }
  if (
    workingReview.payload.expected_full_case_result_bytes_authored !== 0 ||
    workingReview.payload.human_judgment_coverage !== 0 ||
    workingReview.payload.approval_status !== 'not_run' ||
    workingReview.payload.golden_seal_status !== 'not_run' ||
    workingReview.payload.conformance_sealed_write_status !== 'not_run'
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Working review boundary is not eligible for prepare-rc',
    );
  }
  return {
    contract,
    input,
    candidate,
    workingReview,
    caseCatalog,
    workingCases,
    toolchain,
    resultsManifest,
    sourceEntries,
    compilerSourceEntries,
    summary,
  };
}

function buildCasesArtifact(
  working: LoadedWorkingSet,
): ContractArtifactEnvelope {
  const workingReviewByCase = new Map(
    objects(working.workingCases.payload.cases, 'Working review cases').map(
      (entry) => [string(entry.case_id, 'Working review case id'), entry],
    ),
  );
  const cases = working.sourceEntries.map((entry) => {
    const caseId = string(entry.case_id, 'RC case id');
    const reviewCase = workingReviewByCase.get(caseId)!;
    return {
      case_id: caseId,
      polarity: entry.polarity,
      source_kind: entry.source_kind,
      coverage_tags: entry.coverage_tags,
      source_identity: entry.source,
      input_snapshot_identity: entry.input_snapshot,
      review_input: entry.review_input,
      actual_compiler_comparison: entry.actual_compiler_comparison,
      expected_golden_oracle: expectedNullOracle(),
      review_owner: 'human:local-owner',
      review_status: 'not_requested',
      human_judgment: null,
      working_case_ref: `${SEMANTIC_CORRECTION_DRAFT_CASES_PATH}#/payload/cases/${objects(working.workingCases.payload.cases, 'Working cases').indexOf(reviewCase)}`,
    };
  });
  const withoutCatalogHash: JsonObject = {
    candidate_id: 'g2-semantic-correction',
    construction_phase: 'RC_REVIEW',
    publishable: false,
    production_reachable: false,
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    actual_compiler_role: 'comparison_input_only',
    expected_oracle_status: 'all_null',
    human_review_status: 'not_requested',
    human_judgment_coverage: 0,
    cases,
  };
  return artifact(
    'icarus.workflow-compiler-g2-review-candidate-cases/1',
    'icarus.workflow-compiler-g2-review-candidate-cases',
    '1.0.0-rc-review',
    CASES_DOMAIN,
    {
      ...withoutCatalogHash,
      catalog_hash: domainSeparatedSha256(CASES_DOMAIN, withoutCatalogHash),
    },
  );
}

function buildHandoffArtifact(
  cases: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const caseHandoffs = objects(cases.payload.cases, 'RC cases').map(
    (entry, index) => {
      const actual = object(
        entry.actual_compiler_comparison,
        'RC actual comparison',
      );
      return {
        case_id: entry.case_id,
        review_input_pointer: `/payload/cases/${index}/review_input`,
        source_identity_pointer: `/payload/cases/${index}/source_identity`,
        actual_candidate_result_ref: actual.result_ref,
        actual_candidate_result_hash: actual.result_hash,
        expected_oracle_pointer: `/payload/cases/${index}/expected_golden_oracle`,
        review_status: 'not_requested',
        human_judgment: null,
      };
    },
  );
  const withoutHandoffHash: JsonObject = {
    candidate_id: 'g2-semantic-correction',
    construction_phase: 'RC_REVIEW',
    publishable: false,
    production_reachable: false,
    cases_ref: SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH,
    cases_hash: cases.hash,
    review_owner: 'human:local-owner',
    review_requirement: 'fresh_independent_review_next_session',
    review_status: 'not_requested',
    human_judgment_coverage: 0,
    golden_semantic_review_ref: null,
    approval_ref: null,
    signature_ref: null,
    seal_ref: null,
    sealed_artifact_count: 0,
    case_handoffs: caseHandoffs,
  };
  return artifact(
    'icarus.workflow-compiler-g2-fresh-review-handoff/1',
    'icarus.workflow-compiler-g2-fresh-review-handoff',
    '1.0.0-rc-review',
    HANDOFF_DOMAIN,
    {
      ...withoutHandoffHash,
      handoff_hash: domainSeparatedSha256(HANDOFF_DOMAIN, withoutHandoffHash),
    },
  );
}

function buildInventoryArtifact(
  leaves: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const entries = leaves
    .map(([artifactPath, value]) => artifactIdentity(artifactPath, value))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const withoutInventoryHash: JsonObject = {
    candidate_id: 'g2-semantic-correction',
    construction_phase: 'RC_REVIEW',
    inventory_scope: 'all_review_candidate_leaf_artifacts',
    entry_count: entries.length,
    entries,
  };
  return artifact(
    'icarus.workflow-compiler-g2-review-candidate-inventory/1',
    'icarus.workflow-compiler-g2-review-candidate-inventory',
    '1.0.0-rc-review',
    INVENTORY_DOMAIN,
    {
      ...withoutInventoryHash,
      inventory_hash: domainSeparatedSha256(
        INVENTORY_DOMAIN,
        withoutInventoryHash,
      ),
    },
  );
}

function buildRootArtifact(
  working: LoadedWorkingSet,
  cases: ContractArtifactEnvelope,
  handoff: ContractArtifactEnvelope,
  inventory: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const roots = object(working.summary.working_roots, 'Working roots');
  const sourceIdentity = object(
    working.summary.source_identity,
    'Source identity',
  );
  const withoutRootHash: JsonObject = {
    candidate_id: 'g2-semantic-correction',
    gate: 'G2',
    status: 'REVIEW_CANDIDATE_FROZEN',
    construction_phase: 'RC_REVIEW',
    publishable: false,
    production_reachable: false,
    singleton_policy: 'one_current_review_candidate_no_version_chain',
    invalidation_policy: 'any_bound_identity_drift_invalidates_rc',
    bound_working_roots: roots,
    source_identity: sourceIdentity,
    toolchain_identity: working.summary.toolchain_identity,
    compiler_identity: {
      exact_identity: working.summary.compiler_identity,
      compiler_build_hash: working.summary.compiler_build_hash,
      implementation_count: working.compilerSourceEntries.length,
      implementation_inventory: working.compilerSourceEntries,
    },
    review_candidate_cases: artifactIdentity(
      SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH,
      cases,
    ),
    fresh_review_handoff: artifactIdentity(
      SEMANTIC_CORRECTION_REVIEW_CANDIDATE_HANDOFF_PATH,
      handoff,
    ),
    artifact_inventory: artifactIdentity(
      SEMANTIC_CORRECTION_REVIEW_CANDIDATE_INVENTORY_PATH,
      inventory,
    ),
    generated_artifact_count: 4,
    inventory_entry_count: inventory.payload.entry_count,
    case_count: 40,
    actual_comparison: working.summary.actual_comparison,
    expected_golden_oracle: expectedNullOracle(),
    human_review: {
      status: 'not_requested',
      judgment_coverage: 0,
      judgment_record_ref: null,
      judgment_record_hash: null,
    },
    approval: { status: 'absent', ref: null, hash: null },
    signature: { status: 'absent', ref: null, hash: null },
    seal: {
      status: 'absent',
      ref: null,
      hash: null,
      sealed_artifact_count: 0,
      conformance_sealed_write_status: 'not_run',
    },
    g3_through_g9_status: 'not_started',
    production_boundary: {
      registry_release_modified: false,
      schema_modified: false,
      store_modified: false,
      production_compiler_modified: false,
      production_reachable: false,
    },
    generator_source: {
      path: 'src/workflow-runtime/contracts/semantic-correction-review-candidate.ts',
      raw_bytes_hash: rawHash(
        projectBytes(
          'src/workflow-runtime/contracts/semantic-correction-review-candidate.ts',
        ),
      ),
    },
  };
  return artifact(
    'icarus.workflow-compiler-g2-review-candidate/1',
    'icarus.workflow-compiler-g2-review-candidate',
    '1.0.0-rc-review',
    ROOT_DOMAIN,
    {
      ...withoutRootHash,
      review_candidate_hash: domainSeparatedSha256(
        ROOT_DOMAIN,
        withoutRootHash,
      ),
    },
  );
}

export function buildSemanticCorrectionReviewCandidateArtifactsForTest(): Array<
  [string, ContractArtifactEnvelope]
> {
  const working = loadWorkingSet();
  const cases = buildCasesArtifact(working);
  const handoff = buildHandoffArtifact(cases);
  const leaves: Array<[string, ContractArtifactEnvelope]> = [
    [SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH, cases],
    [SEMANTIC_CORRECTION_REVIEW_CANDIDATE_HANDOFF_PATH, handoff],
  ];
  const inventory = buildInventoryArtifact(leaves);
  const root = buildRootArtifact(working, cases, handoff, inventory);
  const artifacts: Array<[string, ContractArtifactEnvelope]> = [
    ...leaves,
    [SEMANTIC_CORRECTION_REVIEW_CANDIDATE_INVENTORY_PATH, inventory],
    [SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH, root],
  ];
  return artifacts.sort(([left], [right]) => left.localeCompare(right));
}

export function readSemanticCorrectionReviewCandidateWorkingIdentityForTest(): JsonObject {
  return structuredClone(loadWorkingSet().summary);
}

export function validateSemanticCorrectionReviewCandidateWorkingIdentityForTest(
  summary: JsonObject,
): void {
  validateWorkingSummary(summary);
}

function relativeArtifactName(relativePath: string): string {
  const prefix = `${SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT}/`;
  if (!relativePath.startsWith(prefix)) {
    throw new SemanticCorrectionReviewCandidateError(
      `Unexpected Review Candidate artifact path: ${relativePath}`,
    );
  }
  return relativePath.slice(prefix.length);
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  if (!fs.lstatSync(root).isDirectory()) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate path is not a directory',
    );
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new SemanticCorrectionReviewCandidateError(
          'Review Candidate tree contains a symlink',
        );
      }
      if (stat.isDirectory()) visit(absolute);
      else files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function assertTree(
  targetRoot: string,
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): void {
  const expectedNames = artifacts
    .map(([relativePath]) => relativeArtifactName(relativePath))
    .sort();
  const actualNames = listTree(targetRoot);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate artifact inventory conflict',
    );
  }
  for (const [relativePath, value] of artifacts) {
    const target = path.join(targetRoot, relativeArtifactName(relativePath));
    if (fs.readFileSync(target, 'utf8') !== render(value)) {
      throw new SemanticCorrectionReviewCandidateError(
        `Review Candidate bytes conflict: ${relativePath}`,
      );
    }
  }
}

function defaultTargetRoot(): string {
  return absoluteContractPath(SEMANTIC_CORRECTION_REVIEW_CANDIDATE_ROOT);
}

function validateSingletonParent(targetRoot: string): void {
  if (targetRoot !== defaultTargetRoot()) return;
  const parent = absoluteContractPath(
    SEMANTIC_CORRECTION_REVIEW_CANDIDATE_PARENT,
  );
  if (!fs.existsSync(parent)) return;
  if (!fs.lstatSync(parent).isDirectory()) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate parent is not a directory',
    );
  }
  const entries = fs.readdirSync(parent).sort();
  if (
    entries.length > 1 ||
    (entries.length === 1 && entries[0] !== 'g2-semantic-correction')
  ) {
    throw new SemanticCorrectionReviewCandidateError(
      'Multiple or conflicting Review Candidate paths are forbidden',
    );
  }
}

function rootArtifact(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const root = artifacts.find(
    ([relativePath]) =>
      relativePath === SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH,
  );
  if (!root) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate root artifact is missing',
    );
  }
  return root[1];
}

function prepareAt(targetRoot: string): ContractArtifactEnvelope {
  validateSingletonParent(targetRoot);
  const artifacts = buildSemanticCorrectionReviewCandidateArtifactsForTest();
  if (fs.existsSync(targetRoot)) {
    assertTree(targetRoot, artifacts);
    return rootArtifact(artifacts);
  }
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  const temporary = `${targetRoot}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.mkdirSync(temporary, { recursive: false, mode: 0o755 });
    for (const [relativePath, value] of artifacts) {
      const target = path.join(temporary, relativeArtifactName(relativePath));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, render(value), {
        encoding: 'utf8',
        mode: 0o644,
      });
    }
    assertTree(temporary, artifacts);
    fs.renameSync(temporary, targetRoot);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
    if (fs.existsSync(targetRoot)) {
      assertTree(targetRoot, artifacts);
      return rootArtifact(artifacts);
    }
    throw error;
  }
  validateSingletonParent(targetRoot);
  assertTree(targetRoot, artifacts);
  return rootArtifact(artifacts);
}

function checkAt(targetRoot: string): ContractArtifactEnvelope {
  validateSingletonParent(targetRoot);
  if (!fs.existsSync(targetRoot)) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate has not been prepared',
    );
  }
  const artifacts = buildSemanticCorrectionReviewCandidateArtifactsForTest();
  assertTree(targetRoot, artifacts);
  return rootArtifact(artifacts);
}

function hasCurrentReviewCandidate(targetRoot: string): boolean {
  const parent = path.dirname(targetRoot);
  if (!fs.existsSync(parent)) return false;
  if (!fs.lstatSync(parent).isDirectory()) {
    throw new SemanticCorrectionReviewCandidateError(
      'Review Candidate parent is not a directory',
    );
  }
  const expectedName = path.basename(targetRoot);
  const entries = fs.readdirSync(parent).sort();
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0] !== expectedName) {
    throw new SemanticCorrectionReviewCandidateError(
      'Multiple or conflicting Review Candidate paths are forbidden',
    );
  }
  return true;
}

export interface SemanticCorrectionCurrentLifecycleCheck {
  construction_phase: 'WORKING' | 'RC_REVIEW';
  review_candidate_root: Sha256Hash | null;
  working_roots: JsonObject;
}

function checkCurrentAt(
  targetRoot: string,
): SemanticCorrectionCurrentLifecycleCheck {
  if (!hasCurrentReviewCandidate(targetRoot)) {
    const working = loadWorkingSet();
    return {
      construction_phase: 'WORKING',
      review_candidate_root: null,
      working_roots: object(working.summary.working_roots, 'Working roots'),
    };
  }
  const root = checkAt(targetRoot);
  return {
    construction_phase: 'RC_REVIEW',
    review_candidate_root: root.hash,
    working_roots: object(root.payload.bound_working_roots, 'Working roots'),
  };
}

export function prepareSemanticCorrectionReviewCandidate(): ContractArtifactEnvelope {
  return prepareAt(defaultTargetRoot());
}

export function checkSemanticCorrectionReviewCandidate(): ContractArtifactEnvelope {
  return checkAt(defaultTargetRoot());
}

export function checkSemanticCorrectionCurrentLifecycle(): SemanticCorrectionCurrentLifecycleCheck {
  return checkCurrentAt(defaultTargetRoot());
}

export function prepareSemanticCorrectionReviewCandidateAtRootForTest(
  targetRoot: string,
): ContractArtifactEnvelope {
  return prepareAt(path.resolve(targetRoot));
}

export function checkSemanticCorrectionReviewCandidateAtRootForTest(
  targetRoot: string,
): ContractArtifactEnvelope {
  return checkAt(path.resolve(targetRoot));
}

export function checkSemanticCorrectionCurrentLifecycleAtRootForTest(
  targetRoot: string,
): SemanticCorrectionCurrentLifecycleCheck {
  return checkCurrentAt(path.resolve(targetRoot));
}

export function validateSemanticCorrectionConformancePathBoundariesForTest(
  conformanceRoot: string,
): void {
  validateSealedAndVersionBoundariesAt(path.resolve(conformanceRoot));
}
