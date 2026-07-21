import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  EXPECTED_G2_WORKING_ROOTS,
  readSemanticCorrectionReviewCandidateWorkingIdentityForTest,
  validateSemanticCorrectionConformancePathBoundariesForTest,
} from './semantic-correction-review-candidate.js';
import { checkCurrentSealedEraReviewCandidate } from './current-sealed-era-historical-checks.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const rcRoot = path.join(
  contractsRoot,
  'conformance/review-candidate/g2-semantic-correction',
);
let temporaryRoot: string;

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
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('sealed-era G2 Review Candidate verification', () => {
  it('checks the exact singleton RC read-only without rebuilding Working', () => {
    const before = digestTree(rcRoot);
    const first = checkCurrentSealedEraReviewCandidate();
    const second = checkCurrentSealedEraReviewCandidate();
    expect(first.hash).toBe(
      'sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577',
    );
    expect(second.hash).toBe(first.hash);
    expect(digestTree(rcRoot)).toBe(before);
    expect(first.payload).toMatchObject({
      construction_phase: 'RC_REVIEW',
      publishable: false,
      production_reachable: false,
      case_count: 40,
      generated_artifact_count: 4,
    });
  });

  it('retains all four exact Working roots in the immutable RC', () => {
    const root = checkCurrentSealedEraReviewCandidate();
    const bindings = root.payload.bound_working_roots as JsonObject;
    for (const key of ['contract', 'input', 'candidate', 'working_review']) {
      const identity = bindings[key] as JsonObject;
      expect(identity.semantic_hash).toBe(
        EXPECTED_G2_WORKING_ROOTS[
          key as keyof typeof EXPECTED_G2_WORKING_ROOTS
        ],
      );
      const artifact = parseContractArtifactEnvelope(
        strictParseJsonBytes(
          fs.readFileSync(path.join(contractsRoot, String(identity.path))),
        ),
      );
      expect(artifact.hash).toBe(identity.semantic_hash);
    }
  });

  it('keeps the historical RC pre-approval record frozen after external seal', () => {
    const root = checkCurrentSealedEraReviewCandidate().payload;
    expect(root.human_review).toMatchObject({
      status: 'not_requested',
      judgment_coverage: 0,
    });
    expect(root.approval).toMatchObject({ status: 'absent', ref: null });
    expect(root.signature).toMatchObject({ status: 'absent', ref: null });
    expect(root.seal).toMatchObject({
      status: 'absent',
      sealed_artifact_count: 0,
    });
    expect(root.g3_through_g9_status).toBe('not_started');
    expect(
      fs.existsSync(
        path.join(
          contractsRoot,
          'conformance/golden-semantic-review/g2-semantic-correction/golden-semantic-review@1.json',
        ),
      ),
    ).toBe(true);
  });

  it('fails closed when a pre-seal Working rebuild is attempted after seal', () => {
    expect(() =>
      readSemanticCorrectionReviewCandidateWorkingIdentityForTest(),
    ).toThrow(/crossed the sealed boundary/);
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

  it('allows non-v5/v6 path segments in a pre-seal fixture', () => {
    const root = conformanceFixture('path-control');
    const target = path.join(root, 'foo', 'draft-v4', 'file.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}\n');
    expect(() =>
      validateSemanticCorrectionConformancePathBoundariesForTest(root),
    ).not.toThrow();
  });
});
