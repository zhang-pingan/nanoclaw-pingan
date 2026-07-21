import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  generateCurrentG2GoldenDraftAtRootForTest,
} from './current-g2-golden-draft.js';
import {
  buildCurrentG2GoldenReviewArtifactsForTest,
  checkCurrentG2GoldenReviewAtRootsForTest,
  generateCurrentG2GoldenReviewAtRootsForTest,
} from './current-g2-golden-review.js';
import { CURRENT_G2_GOLDEN_REVIEW_SCHEMA } from './current-g2-golden-schemas.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type { JsonObject } from './types.js';

let temporaryRoot: string;
let draftRoot: string;

function expectedLoader(caseId: string): Uint8Array {
  return fs.readFileSync(path.join(draftRoot, 'expected', `${caseId}.result.json`));
}

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-current-g2-review-'));
  draftRoot = path.join(temporaryRoot, 'draft', 'g2-semantic-correction');
  generateCurrentG2GoldenDraftAtRootForTest(draftRoot, 'human:local-owner');
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('isolated current G2 golden-review', () => {
  it('is deterministic with 40/40 comparison and complete normalized audit content', () => {
    const first = buildCurrentG2GoldenReviewArtifactsForTest(
      draftRoot,
      expectedLoader,
      false,
    );
    const second = buildCurrentG2GoldenReviewArtifactsForTest(
      draftRoot,
      expectedLoader,
      false,
    );
    expect([...second.files]).toEqual([...first.files]);
    expect(second.report.hash).toBe(first.report.hash);
    expect(first.report.payload).toMatchObject({
      construction_phase: 'RC_REVIEW',
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      expected_coverage: 40,
      comparison_coverage: 40,
      byte_equal_count: 40,
      semantic_equal_count: 40,
      semantic_assertion_count: 85,
      semantic_assertion_failure_count: 0,
      difference_count: 0,
      approval_status: 'absent',
      signature_status: 'absent',
      seal_status: 'absent',
      golden_semantic_review_status: 'not_run',
      g3_through_g9_status: 'not_started',
    });
    const cases = first.report.payload.cases as JsonObject[];
    expect(cases.filter((entry) => entry.normalized_plan !== null)).toHaveLength(11);
    expect(cases.flatMap((entry) => entry.diagnostic_pointers as string[])).toHaveLength(29);
  });

  it('generates idempotently and checks read-only', () => {
    const reviewRoot = path.join(temporaryRoot, 'review', 'g2-semantic-correction');
    const first = generateCurrentG2GoldenReviewAtRootsForTest(
      draftRoot,
      reviewRoot,
      expectedLoader,
      false,
    );
    const second = generateCurrentG2GoldenReviewAtRootsForTest(
      draftRoot,
      reviewRoot,
      expectedLoader,
      false,
    );
    expect(second.hash).toBe(first.hash);
    expect(
      checkCurrentG2GoldenReviewAtRootsForTest(
        draftRoot,
        reviewRoot,
        expectedLoader,
        false,
      ).hash,
    ).toBe(first.hash);
  });

  it('reports semantic differences without changing expected bytes', () => {
    const before = expectedLoader('positive.compiler-integrity-match-control');
    const loader = (caseId: string): Uint8Array => {
      if (caseId !== 'positive.compiler-integrity-match-control') {
        return expectedLoader(caseId);
      }
      const actual = JSON.parse(Buffer.from(before).toString('utf8')) as JsonObject;
      const plan = actual.normalized_plan as JsonObject;
      const summary = plan.complexity_summary as JsonObject;
      summary.max_source_fan_out = Number(summary.max_source_fan_out) + 1;
      delete actual.result_hash;
      actual.result_hash = domainSeparatedSha256(
        'icarus:workflow-compiler-conformance-case-result:1\n',
        actual,
      );
      return Buffer.from(canonicalJson(actual), 'utf8');
    };
    const report = buildCurrentG2GoldenReviewArtifactsForTest(
      draftRoot,
      loader,
      false,
    ).report.payload;
    expect(report.semantic_equal_count).toBe(39);
    expect(report.difference_count).toBeGreaterThan(0);
    expect(expectedLoader('positive.compiler-integrity-match-control')).toEqual(before);
  });

  it('rejects malformed actual input and unknown report fields', () => {
    expect(() =>
      buildCurrentG2GoldenReviewArtifactsForTest(
        draftRoot,
        () => Buffer.from('{}', 'utf8'),
        false,
      ),
    ).toThrow(/result hash/);

    const valid = buildCurrentG2GoldenReviewArtifactsForTest(
      draftRoot,
      expectedLoader,
      false,
    ).report.payload;
    const unknown = structuredClone(valid);
    unknown.approve = true;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      CURRENT_G2_GOLDEN_REVIEW_SCHEMA as AnySchema,
    );
    expect(validate(unknown)).toBe(false);
  });

  it('does not import Production Compiler or expose acceptance/sealing commands', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'current-g2-golden-review.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*\/compiler\//);
    expect(source).not.toMatch(
      /from ['"][^'"]*(?:normalizer|lowerer|assignability|proofs?)(?:\.[jt]s)?['"]|--accept|golden-seal/,
    );
  });
});
