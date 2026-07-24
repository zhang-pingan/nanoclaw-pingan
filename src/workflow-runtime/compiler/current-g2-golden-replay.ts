import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import {
  checkCurrentG2GoldenSeal,
  CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF,
} from '../contracts/current-g2-golden-seal.js';
import {
  checkG2ReplayRepairSeal,
  G2_REPLAY_REPAIR_SEALED_BUNDLE_REF,
} from '../contracts/g2-replay-repair-successor-seal.js';
import type { CurrentG2GoldenReplayResult } from '../contracts/current-g2-golden-seal-types.js';
import { canonicalJson } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';
import { buildSemanticCorrectionCandidate } from './semantic-correction.js';
import {
  compileG2ReplayRepairCase,
  G2_REPLAY_REPAIR_CANDIDATE_ROOT_PATH,
} from './g2-replay-repair-successor.js';
import { workflowCompilerIdentity } from './identity.js';

const contractsRoot = path.resolve(import.meta.dirname, '../contracts');
const GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_REF =
  'conformance/sealed/g2-generated-schema-join-authority-v4/golden-conformance-bundle@2.json';
const GENERATED_SCHEMA_JOIN_AUTHORITY_V4_CANDIDATE_ROOT_REF =
  'conformance/review-candidate/g2-generated-schema-join-authority-v4/working-candidate-root@2.json';
const GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_ARTIFACT_HASH =
  'sha256:591e2fdd083b2b3c4aea2e85edf9e052bad2e1c89908853d2eb6d912befaea76';
const GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_HASH =
  'sha256:b7d26b8622b1ceadff419430f443a9b0ceb377cbd47af20e9109ea878046abf9';

export class CurrentG2GoldenReplayError extends Error {
  readonly code = 'current_g2_golden_replay_mismatch';
  readonly result: CurrentG2GoldenReplayResult;

  constructor(result: CurrentG2GoldenReplayResult) {
    super(
      `Production Compiler replay matched ${result.exact_equal_count}/40 sealed results; mismatches: ${result.mismatched_case_ids.join(', ')}`,
    );
    this.name = 'CurrentG2GoldenReplayError';
    this.result = result;
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `Golden replay path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new Error(`Expected object: ${label}`);
  }
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${label}`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function evaluateReplay(
  bundleRef: string,
  checkedBundle: ContractArtifactEnvelope,
  actualResults: JsonObject[],
  actualCandidateRootHash: Sha256Hash,
): CurrentG2GoldenReplayResult {
  const bundle = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(bundleRef))),
  );
  if (bundle.hash !== checkedBundle.hash) {
    throw new Error('Checked sealed bundle identity drift');
  }
  const expectedByCase = new Map(
    objects(bundle.payload.cases, 'sealed cases').map((entry) => [
      String(entry.case_id),
      entry,
    ]),
  );
  const details: JsonValue[] = [];
  const mismatched: string[] = [];
  for (const result of actualResults) {
    const caseId = String(result.case_id);
    const sealedCase = expectedByCase.get(caseId);
    if (!sealedCase) throw new Error(`Sealed case missing: ${caseId}`);
    const expectedIdentity = object(
      sealedCase.expected_result,
      'sealed expected result identity',
    );
    const expected = strictParseJsonBytes(
      fs.readFileSync(absolute(String(expectedIdentity.path))),
    );
    const equal = canonicalJson(expected) === canonicalJson(result);
    if (!equal) mismatched.push(caseId);
    details.push({
      case_id: caseId,
      exact_equal: equal,
      expected_result_hash: expectedIdentity.semantic_hash,
      actual_result_hash: result.result_hash,
      expected_outcome: sealedCase.outcome,
      actual_outcome: result.outcome,
    });
  }
  mismatched.sort();
  if (actualResults.length !== 40 || expectedByCase.size !== 40) {
    throw new Error('Golden replay coverage is incomplete');
  }
  return {
    case_count: 40,
    exact_equal_count: 40 - mismatched.length,
    mismatch_count: mismatched.length,
    mismatched_case_ids: mismatched,
    passed: mismatched.length === 0,
    expected_bundle_hash: String(bundle.payload.bundle_hash) as Sha256Hash,
    actual_candidate_root_hash: actualCandidateRootHash,
    details,
  };
}

export function evaluatePredecessorG2GoldenReplay(): CurrentG2GoldenReplayResult {
  const checkedBundle = checkCurrentG2GoldenSeal();
  const actual = buildSemanticCorrectionCandidate();
  return evaluateReplay(
    CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF,
    checkedBundle,
    actual.results as unknown as JsonObject[],
    actual.root.hash,
  );
}

export function evaluateCurrentG2GoldenReplay(): CurrentG2GoldenReplayResult {
  const checkedBundle = checkG2ReplayRepairSeal();
  const bundle = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(absolute(G2_REPLAY_REPAIR_SEALED_BUNDLE_REF)),
    ),
  );
  const identity = workflowCompilerIdentity();
  if (
    canonicalJson(bundle.payload.exact_compiler_identity) !==
    canonicalJson(identity as unknown as JsonObject)
  ) {
    throw new Error('Current Production Compiler identity does not match seal');
  }
  const actualResults = objects(bundle.payload.cases, 'sealed cases').map(
    (sealedCase) => {
      const sourceBytes = fs.readFileSync(
        absolute(String(sealedCase.raw_source_bytes_ref)),
      );
      const snapshot = parseContractArtifactEnvelope(
        strictParseJsonBytes(
          fs.readFileSync(absolute(String(sealedCase.registry_snapshot_ref))),
        ),
      );
      return compileG2ReplayRepairCase(
        String(sealedCase.case_id),
        String(sealedCase.source_kind) as
          | 'graph_scope'
          | 'workflow_definition'
          | 'workflow_schema',
        sourceBytes,
        snapshot,
        identity,
      ) as unknown as JsonObject;
    },
  );
  const candidateRootBytes = fs.readFileSync(
    absolute(G2_REPLAY_REPAIR_CANDIDATE_ROOT_PATH),
  );
  const candidateRoot = parseContractArtifactEnvelope(
    strictParseJsonBytes(candidateRootBytes),
  );
  return evaluateReplay(
    G2_REPLAY_REPAIR_SEALED_BUNDLE_REF,
    checkedBundle,
    actualResults,
    candidateRoot.hash,
  );
}

export function evaluateHistoricalGeneratedSchemaJoinAuthorityV4Replay(): CurrentG2GoldenReplayResult {
  const bundle = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(absolute(GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_REF)),
    ),
  );
  if (
    bundle.hash !== GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_ARTIFACT_HASH ||
    bundle.payload.bundle_hash !==
      GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_HASH
  ) {
    throw new Error('Historical G2 v4 sealed bundle identity drift');
  }
  const identity = workflowCompilerIdentity();
  if (
    canonicalJson(bundle.payload.exact_compiler_identity) !==
    canonicalJson(identity as unknown as JsonObject)
  ) {
    throw new Error(
      'Current Production Compiler identity does not match G2 v4',
    );
  }
  const actualResults = objects(bundle.payload.cases, 'G2 v4 sealed cases').map(
    (sealedCase) => {
      const sourceBytes = fs.readFileSync(
        absolute(String(sealedCase.raw_source_bytes_ref)),
      );
      const snapshot = parseContractArtifactEnvelope(
        strictParseJsonBytes(
          fs.readFileSync(absolute(String(sealedCase.registry_snapshot_ref))),
        ),
      );
      return compileG2ReplayRepairCase(
        String(sealedCase.case_id),
        String(sealedCase.source_kind) as
          | 'graph_scope'
          | 'workflow_definition'
          | 'workflow_schema',
        sourceBytes,
        snapshot,
        identity,
      ) as unknown as JsonObject;
    },
  );
  const candidateRoot = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(
        absolute(GENERATED_SCHEMA_JOIN_AUTHORITY_V4_CANDIDATE_ROOT_REF),
      ),
    ),
  );
  return evaluateReplay(
    GENERATED_SCHEMA_JOIN_AUTHORITY_V4_BUNDLE_REF,
    bundle,
    actualResults,
    candidateRoot.hash,
  );
}

export function checkCurrentG2GoldenReplay(): CurrentG2GoldenReplayResult {
  const result = evaluateCurrentG2GoldenReplay();
  if (!result.passed) throw new CurrentG2GoldenReplayError(result);
  return result;
}
