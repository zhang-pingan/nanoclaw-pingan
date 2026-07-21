import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import {
  checkCurrentG2GoldenSeal,
  CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF,
} from '../contracts/current-g2-golden-seal.js';
import type { CurrentG2GoldenReplayResult } from '../contracts/current-g2-golden-seal-types.js';
import { canonicalJson } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { buildSemanticCorrectionCandidate } from './semantic-correction.js';

const contractsRoot = path.resolve(import.meta.dirname, '../contracts');

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

export function evaluateCurrentG2GoldenReplay(): CurrentG2GoldenReplayResult {
  const checkedBundle = checkCurrentG2GoldenSeal();
  const bundle = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(absolute(CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF)),
    ),
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
  const actual = buildSemanticCorrectionCandidate();
  const details: JsonValue[] = [];
  const mismatched: string[] = [];
  for (const result of actual.results) {
    const sealedCase = expectedByCase.get(result.case_id);
    if (!sealedCase) throw new Error(`Sealed case missing: ${result.case_id}`);
    const expectedIdentity = object(
      sealedCase.expected_result,
      'sealed expected result identity',
    );
    const expected = strictParseJsonBytes(
      fs.readFileSync(absolute(String(expectedIdentity.path))),
    );
    const equal = canonicalJson(expected) === canonicalJson(result);
    if (!equal) mismatched.push(result.case_id);
    details.push({
      case_id: result.case_id,
      exact_equal: equal,
      expected_result_hash: expectedIdentity.semantic_hash,
      actual_result_hash: result.result_hash,
      expected_outcome: sealedCase.outcome,
      actual_outcome: result.outcome,
    });
  }
  mismatched.sort();
  return {
    case_count: 40,
    exact_equal_count: 40 - mismatched.length,
    mismatch_count: mismatched.length,
    mismatched_case_ids: mismatched,
    passed: mismatched.length === 0,
    expected_bundle_hash: String(bundle.payload.bundle_hash) as Sha256Hash,
    actual_candidate_root_hash: actual.root.hash,
    details,
  };
}

export function checkCurrentG2GoldenReplay(): CurrentG2GoldenReplayResult {
  const result = evaluateCurrentG2GoldenReplay();
  if (!result.passed) throw new CurrentG2GoldenReplayError(result);
  return result;
}
