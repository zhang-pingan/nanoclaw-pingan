import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JsonObject } from './types.js';
import {
  buildSemanticCorrectionReviewCandidateArtifactsForTest,
  checkSemanticCorrectionCurrentLifecycleAtRootForTest,
  checkSemanticCorrectionReviewCandidateAtRootForTest,
  EXPECTED_G2_WORKING_ROOTS,
  prepareSemanticCorrectionReviewCandidateAtRootForTest,
  readSemanticCorrectionReviewCandidateWorkingIdentityForTest,
  SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH,
  SEMANTIC_CORRECTION_REVIEW_CANDIDATE_INVENTORY_PATH,
  SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH,
  validateSemanticCorrectionConformancePathBoundariesForTest,
  validateSemanticCorrectionReviewCandidateWorkingIdentityForTest,
} from './semantic-correction-review-candidate.js';

let temporaryRoot: string;
let workingIdentity: JsonObject;

function digestTree(root: string): string {
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

function cloneIdentity(): JsonObject {
  return structuredClone(workingIdentity);
}

function conformanceFixture(name: string): string {
  const root = path.join(temporaryRoot, name);
  const sealed = path.join(root, 'sealed');
  fs.mkdirSync(sealed, { recursive: true });
  fs.writeFileSync(path.join(sealed, '.gitkeep'), '');
  return root;
}

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-g2-review-candidate-'),
  );
  workingIdentity =
    readSemanticCorrectionReviewCandidateWorkingIdentityForTest();
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('G2 prepare-rc Review Candidate', () => {
  it('builds one deterministic four-artifact RC and checks the repository read-only', () => {
    const firstArtifacts =
      buildSemanticCorrectionReviewCandidateArtifactsForTest();
    const first = firstArtifacts.map(([artifactPath, value]) => [
      artifactPath,
      JSON.stringify(value),
    ]);
    const second = buildSemanticCorrectionReviewCandidateArtifactsForTest().map(
      ([artifactPath, value]) => [artifactPath, JSON.stringify(value)],
    );
    expect(second).toEqual(first);
    expect(first).toHaveLength(4);
    expect(first.map(([artifactPath]) => artifactPath)).toContain(
      SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH,
    );
    const inventory = firstArtifacts.find(
      ([artifactPath]) =>
        artifactPath === SEMANTIC_CORRECTION_REVIEW_CANDIDATE_INVENTORY_PATH,
    )![1].payload;
    expect(inventory.entry_count).toBe(2);
    for (const entry of inventory.entries as JsonObject[]) {
      expect(entry).toEqual(
        expect.objectContaining({
          path: expect.any(String),
          format: expect.any(String),
          ref: expect.any(Object),
          version: expect.any(Number),
          semantic_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          raw_bytes_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
      );
    }
    const root = firstArtifacts.find(
      ([artifactPath]) =>
        artifactPath === SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH,
    )![1];
    expect(root.payload).toMatchObject({
      construction_phase: 'RC_REVIEW',
      publishable: false,
      production_reachable: false,
      case_count: 40,
      generated_artifact_count: 4,
    });
  });

  it('prepares atomically and treats an exact repeated freeze as idempotent', () => {
    const target = path.join(
      temporaryRoot,
      'repeat-freeze',
      'g2-semantic-correction',
    );
    const first = prepareSemanticCorrectionReviewCandidateAtRootForTest(target);
    const firstDigest = digestTree(target);
    const second =
      prepareSemanticCorrectionReviewCandidateAtRootForTest(target);
    expect(second.hash).toBe(first.hash);
    expect(digestTree(target)).toBe(firstDigest);
    const beforeCheck = digestTree(target);
    expect(
      checkSemanticCorrectionReviewCandidateAtRootForTest(target).hash,
    ).toBe(first.hash);
    expect(digestTree(target)).toBe(beforeCheck);
    expect(
      checkSemanticCorrectionCurrentLifecycleAtRootForTest(target),
    ).toMatchObject({
      construction_phase: 'RC_REVIEW',
      review_candidate_root: first.hash,
    });
  });

  it('accepts a legal no-RC WORKING state while strict RC check still fails', () => {
    const target = path.join(
      temporaryRoot,
      'working-without-rc',
      'g2-semantic-correction',
    );
    expect(
      checkSemanticCorrectionCurrentLifecycleAtRootForTest(target),
    ).toMatchObject({
      construction_phase: 'WORKING',
      review_candidate_root: null,
    });
    expect(() =>
      checkSemanticCorrectionReviewCandidateAtRootForTest(target),
    ).toThrow(/has not been prepared/);
  });

  it('fails closed on an existing unregistered or tampered RC tree', () => {
    const target = path.join(
      temporaryRoot,
      'conflicting-freeze',
      'g2-semantic-correction',
    );
    prepareSemanticCorrectionReviewCandidateAtRootForTest(target);
    fs.writeFileSync(path.join(target, 'unregistered.json'), '{}\n');
    expect(() =>
      prepareSemanticCorrectionReviewCandidateAtRootForTest(target),
    ).toThrow(/inventory conflict/);
    expect(() =>
      checkSemanticCorrectionReviewCandidateAtRootForTest(target),
    ).toThrow(/inventory conflict/);
    expect(() =>
      checkSemanticCorrectionCurrentLifecycleAtRootForTest(target),
    ).toThrow(/inventory conflict/);
  });

  it('does not downgrade a conflicting RC parent to WORKING', () => {
    const parent = path.join(temporaryRoot, 'conflicting-parent');
    const target = path.join(parent, 'g2-semantic-correction');
    fs.mkdirSync(path.join(parent, 'second-review-candidate'), {
      recursive: true,
    });
    expect(() =>
      checkSemanticCorrectionCurrentLifecycleAtRootForTest(target),
    ).toThrow(/Multiple or conflicting Review Candidate paths/);
  });

  it('rejects exact identity tamper and Working root drift', () => {
    const identityTamper = cloneIdentity();
    const compiler = identityTamper.compiler_identity as JsonObject;
    compiler.compiler_build_hash = `sha256:${'0'.repeat(64)}`;
    expect(() =>
      validateSemanticCorrectionReviewCandidateWorkingIdentityForTest(
        identityTamper,
      ),
    ).toThrow(/identity binding drift/);

    const rootDrift = cloneIdentity();
    const roots = rootDrift.working_roots as JsonObject;
    const candidate = roots.candidate as JsonObject;
    candidate.semantic_hash = `sha256:${'f'.repeat(64)}`;
    expect(() =>
      validateSemanticCorrectionReviewCandidateWorkingIdentityForTest(
        rootDrift,
      ),
    ).toThrow(/candidate root drift/);
    expect(EXPECTED_G2_WORKING_ROOTS.candidate).not.toBe(
      candidate.semantic_hash,
    );
  });

  it('rejects an illegal Working lifecycle', () => {
    const invalid = cloneIdentity();
    const roots = invalid.working_roots as JsonObject;
    const review = roots.working_review as JsonObject;
    review.construction_phase = 'RC_REVIEW';
    expect(() =>
      validateSemanticCorrectionReviewCandidateWorkingIdentityForTest(invalid),
    ).toThrow(/lifecycle is not eligible/);
  });

  it('keeps expected, judgment, approval, signature, seal, and Production absent', () => {
    const root = buildSemanticCorrectionReviewCandidateArtifactsForTest().find(
      ([artifactPath]) =>
        artifactPath === SEMANTIC_CORRECTION_REVIEW_CANDIDATE_MANIFEST_PATH,
    )![1].payload;
    const expected = root.expected_golden_oracle as JsonObject;
    expect(
      Object.entries(expected).filter(([key]) => key !== 'status'),
    ).toSatisfy((entries: Array<[string, unknown]>) =>
      entries.every(([, value]) => value === null),
    );
    expect(root.human_review).toMatchObject({
      status: 'not_requested',
      judgment_coverage: 0,
      judgment_record_ref: null,
      judgment_record_hash: null,
    });
    expect(root.approval).toMatchObject({ status: 'absent', ref: null });
    expect(root.signature).toMatchObject({ status: 'absent', ref: null });
    expect(root.seal).toMatchObject({
      status: 'absent',
      sealed_artifact_count: 0,
      conformance_sealed_write_status: 'not_run',
    });
    expect(root.g3_through_g9_status).toBe('not_started');
    expect(root.production_reachable).toBe(false);

    const casesArtifact =
      buildSemanticCorrectionReviewCandidateArtifactsForTest().find(
        ([artifactPath]) =>
          artifactPath === SEMANTIC_CORRECTION_REVIEW_CANDIDATE_CASES_PATH,
      )![1];
    const cases = casesArtifact.payload.cases as JsonObject[];
    expect(cases).toHaveLength(40);
    for (const entry of cases) {
      const caseExpected = entry.expected_golden_oracle as JsonObject;
      expect(
        Object.entries(caseExpected).filter(([key]) => key !== 'status'),
      ).toSatisfy((entries: Array<[string, unknown]>) =>
        entries.every(([, value]) => value === null),
      );
      expect(entry.review_status).toBe('not_requested');
      expect(entry.human_judgment).toBeNull();
    }
  });

  it.each([
    'v5/file.json',
    'v6/file.json',
    'draft-v5/file.json',
    'draft-v6/file.json',
    'foo/v5/bar.json',
    'foo/v6/bar.json',
  ])('rejects forbidden v5/v6 path segments: %s', (relativePath) => {
    const root = conformanceFixture(
      `path-${relativePath.replaceAll('/', '-')}`,
    );
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}\n');
    expect(() =>
      validateSemanticCorrectionConformancePathBoundariesForTest(root),
    ).toThrow(/Draft v5\/v6 path is forbidden/);
  });

  it('allows non-v5/v6 path segments', () => {
    const root = conformanceFixture('path-control');
    const target = path.join(root, 'foo', 'draft-v4', 'file.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}\n');
    expect(() =>
      validateSemanticCorrectionConformancePathBoundariesForTest(root),
    ).not.toThrow();
  });
});
