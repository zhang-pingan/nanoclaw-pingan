import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  evaluateCurrentG2GoldenReplay,
  evaluateHistoricalGeneratedSchemaJoinAuthorityV4Replay,
  evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay,
  evaluatePredecessorG2GoldenReplay,
} from '../compiler/current-g2-golden-replay.js';
import { checkCurrentG2GoldenSeal } from './current-g2-golden-seal.js';
import {
  G2_REPLAY_REPAIR_CONFORMANCE_BUNDLE_SCHEMA,
  G2_REPLAY_REPAIR_SEALED_INVENTORY_SCHEMA,
  G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA,
} from './g2-replay-repair-successor-seal-schemas.js';
import {
  buildG2ReplayRepairSeal,
  checkG2ReplayRepairSeal,
} from './g2-replay-repair-successor-seal.js';
import {
  buildG2ReplayRepairSemanticReview,
  checkG2ReplayRepairSemanticReview,
  G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH,
  G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH,
  G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS,
} from './g2-replay-repair-successor-semantic-review.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';

const contractsRoot = import.meta.dirname;

function approvedInput() {
  return {
    authorizedBy: 'human:local-owner',
    decision: 'approved' as const,
    approvedDraftManifestHash: G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH,
    approvedReviewReportHash: G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH,
    reviewedAtMs: G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS,
  };
}

describe('G2 replay-repair successor immutable review and seal', () => {
  it('binds the exact owner approval and 40/40 comparison deterministically', () => {
    const first = buildG2ReplayRepairSemanticReview(approvedInput());
    const second = buildG2ReplayRepairSemanticReview(approvedInput());
    expect([...second.files]).toEqual([...first.files]);
    expect(second.review.hash).toBe(first.review.hash);
    expect(first.review.payload).toMatchObject({
      bundle_version: '2.0.0',
      decision: 'approved',
      reviewer_actor_ref: 'human:local-owner',
      draft_manifest_hash: G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH,
      golden_review_report_hash: G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH,
      reviewed_at_ms: G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS,
      comparison_acknowledgement: {
        byte_equal_count: 40,
        semantic_equal_count: 40,
        compiled_difference_case_count: 0,
        pointer_difference_count: 0,
      },
    });
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA as AnySchema,
    );
    expect(
      validate(first.review.payload),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(checkG2ReplayRepairSemanticReview().hash).toBe(first.review.hash);
  });

  it('rejects forged owner, stale hashes, and an unbound approval time', () => {
    expect(() =>
      buildG2ReplayRepairSemanticReview({
        ...approvedInput(),
        authorizedBy: 'codex:self',
      }),
    ).toThrow(/human:local-owner/);
    expect(() =>
      buildG2ReplayRepairSemanticReview({
        ...approvedInput(),
        approvedDraftManifestHash: `sha256:${'f'.repeat(64)}`,
      }),
    ).toThrow(/exact successor Draft hash/);
    expect(() =>
      buildG2ReplayRepairSemanticReview({
        ...approvedInput(),
        reviewedAtMs: G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS + 1,
      }),
    ).toThrow(/approval event/);
  });

  it('packages a deterministic standalone versioned 40-case seal', () => {
    const first = buildG2ReplayRepairSeal();
    const second = buildG2ReplayRepairSeal();
    expect([...second.files]).toEqual([...first.files]);
    expect(second.bundle).toEqual(first.bundle);
    expect(first.files).toHaveLength(157);
    expect(first.inventory.payload.entry_count).toBe(155);
    expect(first.bundle.payload).toMatchObject({
      bundle_version: '2.0.0',
      bundle_status: 'sealed_pending_ci_replay',
      approval_status: 'approved',
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      sealed_artifact_count: 157,
      ci_replay_status: 'not_run_at_seal_time',
      g3_through_g9_status: 'not_started',
    });
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validateBundle = ajv.compile(
      G2_REPLAY_REPAIR_CONFORMANCE_BUNDLE_SCHEMA as AnySchema,
    );
    const validateInventory = ajv.compile(
      G2_REPLAY_REPAIR_SEALED_INVENTORY_SCHEMA as AnySchema,
    );
    expect(
      validateBundle(first.bundle.payload),
      JSON.stringify(validateBundle.errors),
    ).toBe(true);
    expect(
      validateInventory(first.inventory.payload),
      JSON.stringify(validateInventory.errors),
    ).toBe(true);
    expect(checkG2ReplayRepairSeal().hash).toBe(first.bundle.hash);
  });

  it('preserves the predecessor seal and passes the current independent replay', () => {
    expect(checkCurrentG2GoldenSeal().payload.bundle_hash).toBe(
      'sha256:d00dc96d90ccfadd6081a77d7c4a16024e188b9a77a123743bc601f971219555',
    );
    expect(evaluatePredecessorG2GoldenReplay()).toMatchObject({
      exact_equal_count: 29,
      mismatch_count: 11,
      passed: false,
    });
    expect(evaluateCurrentG2GoldenReplay()).toMatchObject({
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
    expect(
      evaluateHistoricalGeneratedSchemaJoinAuthorityV5Replay(),
    ).toMatchObject({
      expected_bundle_hash:
        'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05',
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
    expect(
      evaluateHistoricalGeneratedSchemaJoinAuthorityV4Replay(),
    ).toMatchObject({
      expected_bundle_hash:
        'sha256:b7d26b8622b1ceadff419430f443a9b0ceb377cbd47af20e9109ea878046abf9',
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
  }, 30_000);

  it('allows only the six exact G2 sealed lineages and keeps seal code isolated', () => {
    expect(
      assertCurrentG2SealedBoundary(
        path.join(contractsRoot, 'conformance/sealed'),
      ),
    ).toBe('current_g2');
    for (const file of [
      'g2-replay-repair-successor-seal.ts',
      'g2-replay-repair-successor-seal-cli.ts',
    ]) {
      const source = fs.readFileSync(path.join(contractsRoot, file), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/compiler\//);
      expect(source).not.toMatch(/--accept|publisher|registry\/authoring/i);
    }
  });
});
