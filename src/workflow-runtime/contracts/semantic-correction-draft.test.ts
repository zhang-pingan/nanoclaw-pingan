import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildSemanticCorrectionDraftExpectedArtifactsForTest,
  checkSemanticCorrectionDraft,
  SEMANTIC_CORRECTION_DRAFT_CASES_PATH,
  SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH,
  SEMANTIC_CORRECTION_DRAFT_ROOT,
} from './semantic-correction-draft.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;

function artifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function treeDigest(): string {
  const root = path.join(contractsRoot, SEMANTIC_CORRECTION_DRAFT_ROOT);
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

describe('G2 semantic correction working review bundle', () => {
  it('builds deterministic expected bytes without importing Production Compiler', () => {
    const first = buildSemanticCorrectionDraftExpectedArtifactsForTest().map(
      ([relativePath, value]) => [relativePath, JSON.stringify(value)],
    );
    const second = buildSemanticCorrectionDraftExpectedArtifactsForTest().map(
      ([relativePath, value]) => [relativePath, JSON.stringify(value)],
    );
    expect(second).toEqual(first);
    expect(first).toHaveLength(4);
  });

  it('checks the current working bundle without changing any byte', () => {
    const before = treeDigest();
    const first = checkSemanticCorrectionDraft();
    const middle = treeDigest();
    const second = checkSemanticCorrectionDraft();
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
    expect(middle).toBe(before);
    expect(treeDigest()).toBe(before);
  });

  it('keeps actual comparison input separate from the unrequested oracle', () => {
    const payload = artifact(SEMANTIC_CORRECTION_DRAFT_CASES_PATH).payload;
    const cases = payload.cases as JsonObject[];
    expect(cases).toHaveLength(40);
    expect(payload.positive_case_count).toBe(11);
    expect(payload.negative_case_count).toBe(29);
    expect(payload.human_judgment_coverage).toBe(0);
    for (const entry of cases) {
      const actual = entry.actual_compiler_candidate as JsonObject;
      const expected = entry.expected_golden_oracle as JsonObject;
      expect(actual.role).toBe('actual_compiler_output_not_golden_oracle');
      expect(expected.status).toBe('not_authored_working_not_review_candidate');
      expect(
        Object.entries(expected).filter(([key]) => key !== 'status'),
      ).toSatisfy((entries: Array<[string, unknown]>) =>
        entries.every(([, value]) => value === null),
      );
      expect(entry.review_status).toBe('not_requested_until_prepare_rc');
      expect(entry.human_judgment).toBeNull();
    }
  });

  it('records only the working G2 boundary', () => {
    const manifest = artifact(SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH).payload;
    expect(manifest.gate_status).toBe('IN_PROGRESS');
    expect(manifest.construction_phase).toBe('WORKING');
    expect(manifest.publishable).toBe(false);
    expect(manifest.production_reachable).toBe(false);
    expect(manifest.expected_full_case_result_bytes_authored).toBe(0);
    expect(manifest.human_judgment_coverage).toBe(0);
    expect(manifest.pending_case_count).toBe(0);
    expect(manifest.golden_semantic_review_status).toBe('not_run');
    expect(manifest.approval_status).toBe('not_run');
    expect(manifest.golden_seal_status).toBe('not_run');
    expect(manifest.conformance_sealed_write_status).toBe('not_run');
    expect(manifest.g3_through_g9_status).toBe('not_started');
    expect(manifest.r017_status).toBe('OPEN_BLOCKING_G2');
  });
});
