import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  evaluateCurrentG2GoldenReplay,
  checkCurrentG2GoldenReplay,
} from '../compiler/current-g2-golden-replay.js';
import {
  CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA,
  CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA,
  CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA,
} from './current-g2-golden-seal-schemas.js';
import {
  buildCurrentG2GoldenSealArtifactsForTest,
  checkCurrentG2GoldenSeal,
  checkCurrentG2GoldenSealAtRootForTest,
  CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF,
  CURRENT_G2_GOLDEN_SEALED_INVENTORY_REF,
  CURRENT_G2_GOLDEN_SEALED_ROOT,
  validateCurrentG2GoldenSealReviewForTest,
} from './current-g2-golden-seal.js';
import {
  buildCurrentG2GoldenSemanticReviewArtifactsForTest,
  checkCurrentG2GoldenSemanticReview,
  CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH,
  CURRENT_G2_APPROVED_REVIEW_REPORT_HASH,
  CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF,
  CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS,
} from './current-g2-golden-semantic-review.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
let temporaryRoot: string;

function approvedInput() {
  return {
    authorizedBy: 'human:local-owner',
    decision: 'approved' as const,
    approvedDraftManifestHash: CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH,
    approvedReviewReportHash: CURRENT_G2_APPROVED_REVIEW_REPORT_HASH,
    reviewedAtMs: CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS,
  };
}

function artifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g2-seal-'));
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('current G2 immutable semantic review and golden-seal', () => {
  it('binds the exact owner-approved Draft and acknowledged comparison deterministically', () => {
    const first =
      buildCurrentG2GoldenSemanticReviewArtifactsForTest(approvedInput());
    const second =
      buildCurrentG2GoldenSemanticReviewArtifactsForTest(approvedInput());
    expect([...second.files]).toEqual([...first.files]);
    expect(second.review.hash).toBe(first.review.hash);
    expect(first.review.payload).toMatchObject({
      decision: 'approved',
      reviewer_actor_ref: 'human:local-owner',
      draft_manifest_hash: CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH,
      golden_review_report_hash: CURRENT_G2_APPROVED_REVIEW_REPORT_HASH,
      case_count: 40,
      signature_policy: 'not_required_local_single_user',
      reviewed_at_ms: CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS,
      comparison_acknowledgement: {
        byte_equal_count: 29,
        semantic_equal_count: 29,
        compiled_difference_case_count: 11,
        pointer_difference_count: 622,
      },
    });
    expect(checkCurrentG2GoldenSemanticReview().hash).toBe(first.review.hash);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA as AnySchema,
    );
    expect(
      validate(first.review.payload),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('rejects forged owner, stale hash, and unbound approval time', () => {
    expect(() =>
      buildCurrentG2GoldenSemanticReviewArtifactsForTest({
        ...approvedInput(),
        authorizedBy: 'codex:self',
      }),
    ).toThrow(/human:local-owner/);
    expect(() =>
      buildCurrentG2GoldenSemanticReviewArtifactsForTest({
        ...approvedInput(),
        approvedDraftManifestHash: `sha256:${'f'.repeat(64)}`,
      }),
    ).toThrow(/exact Draft hash/);
    expect(() =>
      buildCurrentG2GoldenSemanticReviewArtifactsForTest({
        ...approvedInput(),
        reviewedAtMs: CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS + 1,
      }),
    ).toThrow(/approval event/);
  });

  it('packages a deterministic, standalone 40-case sealed bundle and validates both schemas', () => {
    const first = buildCurrentG2GoldenSealArtifactsForTest();
    const second = buildCurrentG2GoldenSealArtifactsForTest();
    expect([...second.files]).toEqual([...first.files]);
    expect(second.bundle).toEqual(first.bundle);
    expect(first.files).toHaveLength(157);
    const bundle = first.bundle as ContractArtifactEnvelope;
    const inventory = first.inventory as ContractArtifactEnvelope;
    expect(bundle.payload).toMatchObject({
      bundle_status: 'sealed_pending_ci_replay',
      approval_status: 'approved',
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      sealed_raw_source_coverage: 40,
      sealed_input_snapshot_coverage: 40,
      sealed_artifact_count: 157,
      ci_replay_status: 'not_run_at_seal_time',
      g3_through_g9_status: 'not_started',
    });
    expect(inventory.payload.entry_count).toBe(155);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validateBundle = ajv.compile(
      CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA as AnySchema,
    );
    const validateInventory = ajv.compile(
      CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA as AnySchema,
    );
    expect(
      validateBundle(bundle.payload),
      JSON.stringify(validateBundle.errors),
    ).toBe(true);
    expect(
      validateInventory(inventory.payload),
      JSON.stringify(validateInventory.errors),
    ).toBe(true);
    expect(checkCurrentG2GoldenSeal().hash).toBe(bundle.hash);
  });

  it('rejects changes-requested, partial, duplicate, stale, and forged review state', () => {
    const review = artifact(CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF);
    const bundle = artifact(CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF);
    const draftArtifactHash = String(
      bundle.payload.draft_artifact_hash,
    ) as `sha256:${string}`;
    const reportArtifactHash = String(
      bundle.payload.golden_review_report_artifact_hash,
    ) as `sha256:${string}`;
    const mutations = [
      (payload: JsonObject) => {
        payload.decision = 'changes_requested';
      },
      (payload: JsonObject) => {
        (payload.case_ids as string[]).pop();
      },
      (payload: JsonObject) => {
        const ids = payload.case_ids as string[];
        ids[1] = ids[0]!;
      },
      (payload: JsonObject) => {
        payload.draft_manifest_hash = `sha256:${'f'.repeat(64)}`;
      },
      (payload: JsonObject) => {
        payload.reviewer_actor_ref = 'codex:self';
      },
    ];
    for (const mutate of mutations) {
      const payload = structuredClone(review.payload);
      mutate(payload);
      expect(() =>
        validateCurrentG2GoldenSealReviewForTest(
          payload,
          draftArtifactHash,
          reportArtifactHash,
        ),
      ).toThrow(/rejects/);
    }
  });

  it('fails read-only validation on sealed byte drift and unknown boundary entries', () => {
    const copy = path.join(temporaryRoot, 'sealed-copy');
    fs.cpSync(path.join(contractsRoot, CURRENT_G2_GOLDEN_SEALED_ROOT), copy, {
      recursive: true,
    });
    fs.appendFileSync(
      path.join(copy, 'golden-conformance-bundle@1.json'),
      '\n',
    );
    expect(() => checkCurrentG2GoldenSealAtRootForTest(copy)).toThrow(
      /bytes drift/,
    );

    const boundary = path.join(temporaryRoot, 'boundary');
    fs.mkdirSync(boundary);
    fs.writeFileSync(path.join(boundary, '.gitkeep'), '');
    fs.writeFileSync(path.join(boundary, 'unknown'), '');
    expect(() => assertCurrentG2SealedBoundary(boundary)).toThrow(
      /unknown entry/,
    );
  });

  it('keeps seal generation isolated and reports the independent Production replay gate failure', () => {
    for (const file of [
      'current-g2-golden-seal.ts',
      'current-g2-golden-seal-cli.ts',
    ]) {
      const source = fs.readFileSync(path.join(contractsRoot, file), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/compiler\//);
      expect(source).not.toMatch(
        /from ['"][^'"]*(?:normalizer|lowerer|assignability|proofs?)(?:\.[jt]s)?['"]|--accept/,
      );
    }
    const replay = evaluateCurrentG2GoldenReplay();
    expect(replay).toMatchObject({
      case_count: 40,
      exact_equal_count: 29,
      mismatch_count: 11,
      passed: false,
    });
    expect(() => checkCurrentG2GoldenReplay()).toThrow(/matched 29\/40/);
  }, 30_000);

  it('keeps the checked immutable artifact refs present and distinct from Draft refs', () => {
    const bundle = artifact(CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF);
    const inventory = artifact(CURRENT_G2_GOLDEN_SEALED_INVENTORY_REF);
    expect(bundle.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inventory.hash).toBe(bundle.payload.inventory_hash);
    const cases = bundle.payload.cases as JsonObject[];
    expect(new Set(cases.map((entry) => entry.approved_review_ref))).toEqual(
      new Set([CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF]),
    );
    expect(
      cases.every((entry) =>
        String(entry.raw_source_bytes_ref).startsWith(
          `${CURRENT_G2_GOLDEN_SEALED_ROOT}/`,
        ),
      ),
    ).toBe(true);
  });
});
