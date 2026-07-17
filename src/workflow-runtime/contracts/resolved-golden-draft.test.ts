import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G2_CANDIDATE_RESULTS_MANIFEST_HASH,
  G2_CASE_INPUT_BINDING_HASH,
  G2_COMPILER_BUILD_HASH,
  G2_NORMALIZER_HASH,
  G2_PRODUCTION_COMPILER_ROOT_HASH,
  G2_PROOF_ALGORITHM_HASH,
  G2_TOOLCHAIN_HASH,
  RESOLVED_GOLDEN_DRAFT_CASES_PATH,
  RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH,
  RESOLVED_GOLDEN_DRAFT_MANIFEST_PATH,
  RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS,
  RESOLVED_GOLDEN_DRAFT_ROOT,
  RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH,
  buildResolvedGoldenDraftExpectedArtifactsForTest,
  checkResolvedGoldenDraftArtifacts,
  runResolvedGoldenDraftNegativeVerificationForTest,
} from './resolved-golden-draft.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function treeDigest(): string {
  const root = path.join(contractsRoot, RESOLVED_GOLDEN_DRAFT_ROOT);
  const hash = crypto.createHash('sha256');
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else {
        hash.update(path.relative(root, absolute), 'utf8');
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

describe('G2 resolved Golden Draft publication', () => {
  it('rebuilds deterministic expected bytes without importing the Compiler', () => {
    const first = buildResolvedGoldenDraftExpectedArtifactsForTest().map(
      ([relativePath, artifact]) => [relativePath, JSON.stringify(artifact)],
    );
    const second = buildResolvedGoldenDraftExpectedArtifactsForTest().map(
      ([relativePath, artifact]) => [relativePath, JSON.stringify(artifact)],
    );
    expect(second).toEqual(first);
    expect(first.map(([relativePath]) => relativePath)).toContain(
      RESOLVED_GOLDEN_DRAFT_MANIFEST_PATH,
    );
  });

  it('checks the published tree without changing any byte', () => {
    const before = treeDigest();
    const first = checkResolvedGoldenDraftArtifacts();
    const middle = treeDigest();
    const second = checkResolvedGoldenDraftArtifacts();
    expect(second.hash).toBe(first.hash);
    expect(middle).toBe(before);
    expect(treeDigest()).toBe(before);
  });

  it('binds every exact G2 identity and all 40 actual candidates', () => {
    const cases = readArtifact(RESOLVED_GOLDEN_DRAFT_CASES_PATH).payload;
    const identity = cases.exact_g2_identity as JsonObject;
    expect(identity.production_compiler_root_hash).toBe(
      G2_PRODUCTION_COMPILER_ROOT_HASH,
    );
    expect(identity.compiler_toolchain_hash).toBe(G2_TOOLCHAIN_HASH);
    expect(identity.compiler_build_hash).toBe(G2_COMPILER_BUILD_HASH);
    expect(identity.canonical_normalizer_hash).toBe(G2_NORMALIZER_HASH);
    expect(identity.proof_algorithm_hash).toBe(G2_PROOF_ALGORITHM_HASH);
    expect(identity.case_input_binding_hash).toBe(G2_CASE_INPUT_BINDING_HASH);
    expect(identity.candidate_results_manifest_hash).toBe(
      G2_CANDIDATE_RESULTS_MANIFEST_HASH,
    );
    expect(cases.cases).toHaveLength(40);
    expect(cases.positive_case_count).toBe(10);
    expect(cases.negative_case_count).toBe(30);
  });

  it('keeps actual output, review input, and expected oracle separate', () => {
    const cases = readArtifact(RESOLVED_GOLDEN_DRAFT_CASES_PATH).payload
      .cases as JsonObject[];
    for (const entry of cases) {
      const actual = entry.actual_compiler_candidate as JsonObject;
      const review = entry.review_input as JsonObject;
      const expected = entry.expected_golden_oracle as JsonObject;
      expect(actual.role).toBe('actual_compiler_output_not_golden_oracle');
      expect(review.role).toBe(
        'hand_authored_review_input_not_expected_oracle',
      );
      expect(expected.status).toBe('pending_independent_human_semantic_review');
      expect(
        Object.entries(expected).filter(([key]) => key !== 'status'),
      ).toSatisfy((entries: Array<[string, unknown]>) =>
        entries.every(([, value]) => value === null),
      );
      expect(entry.review_owner).toBe('human:local-owner');
      expect(entry.review_status).toBe('pending_human_semantic_review');
    }
  });

  it('publishes only a pending semantic-review handoff', () => {
    const handoff = readArtifact(RESOLVED_GOLDEN_REVIEW_HANDOFF_PATH).payload;
    const manifest = readArtifact(RESOLVED_GOLDEN_DRAFT_MANIFEST_PATH).payload;
    expect(handoff.case_handoffs).toHaveLength(40);
    expect(handoff.review_decision_status).toBe('pending_not_recorded');
    expect(handoff.golden_semantic_review_record_ref).toBeNull();
    expect(handoff.approval_status).toBe('not_run');
    expect(handoff.golden_seal_status).toBe('not_run');
    expect(manifest.expected_golden_oracle_status).toBe('absent');
    expect(manifest.golden_semantic_review_status).toBe('pending_not_run');
    expect(manifest.conformance_sealed_write_status).toBe('not_run');
    expect(manifest.g3_through_g9_status).toBe('not_started');
  });

  it('covers the complete leaf inventory and rejects every forbidden mutation', () => {
    const inventory = readArtifact(
      RESOLVED_GOLDEN_DRAFT_INVENTORY_PATH,
    ).payload;
    const expected = buildResolvedGoldenDraftExpectedArtifactsForTest();
    expect(inventory.entry_count).toBe(expected.length - 2);
    expect(inventory.entries).toHaveLength(expected.length - 2);
    expect(runResolvedGoldenDraftNegativeVerificationForTest()).toBe(
      RESOLVED_GOLDEN_DRAFT_NEGATIVE_MUTATIONS.length,
    );
  });
});
