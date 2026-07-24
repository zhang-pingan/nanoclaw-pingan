import { describe, expect, it } from 'vitest';

import {
  buildG2ReplayRepairSuccessor,
  G2_REPLAY_REPAIR_DRAFT_MANIFEST_PATH,
  G2_REPLAY_REPAIR_RC_MANIFEST_PATH,
  G2_REPLAY_REPAIR_REVIEW_REPORT_PATH,
  generateG2ReplayRepairSuccessor,
} from '../compiler/g2-replay-repair-successor.js';
import {
  checkCurrentSealedEraLegacyGoldenDraft,
  checkCurrentSealedEraLegacyGoldenReview,
  checkCurrentSealedEraLegacyGoldenSeal,
  checkCurrentSealedEraWorkingCompilerCandidate,
} from './current-sealed-era-historical-checks.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';

function artifact(bytes: string): ContractArtifactEnvelope {
  return JSON.parse(bytes) as ContractArtifactEnvelope;
}

describe('G2 Production Compiler replay-repair successor', () => {
  it('builds a deterministic complete Draft and read-only 40/40 comparison', () => {
    const first = buildG2ReplayRepairSuccessor();
    const second = buildG2ReplayRepairSuccessor();
    expect([...second.files]).toEqual([...first.files]);
    expect(first.files).toHaveLength(172);
    expect(first.exactEqualCount).toBe(40);
    expect(first.pointerDifferenceCount).toBe(0);
    expect(first.rc.hash).toBe(
      'sha256:b0a8d7599073b9f4ae222fac799a9923b14c0762aa70a88746adfc2953809996',
    );
    expect(first.draft.payload.draft_manifest_hash).toBe(
      'sha256:5f8eb14f6566379bc0047b72b991f76030f12c116f3cb09d1d0649ef9e18ae3e',
    );
    expect(first.review.payload.report_hash).toBe(
      'sha256:304e029a42f720d3994ff1f6147678c5c9fba0d96c71c4e645d19ea4386ea967',
    );
    expect(first.review.payload).toMatchObject({
      construction_phase: 'RC_REVIEW',
      byte_equal_count: 40,
      semantic_equal_count: 40,
      semantic_assertion_count: 95,
      semantic_assertion_failure_count: 0,
      difference_count: 0,
      approval_status: 'absent',
      seal_status: 'absent',
      golden_semantic_review_status: 'not_run',
      g3_through_g9_status: 'not_started',
    });
  }, 30_000);

  it('requires exact human authority before writing the additive trees', () => {
    expect(() => generateG2ReplayRepairSuccessor('codex:self')).toThrow(
      /not authorized/,
    );
  });

  it('preserves predecessor immutable lineage and exact identities', () => {
    expect(checkCurrentSealedEraWorkingCompilerCandidate().hash).toBe(
      'sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a',
    );
    expect(
      checkCurrentSealedEraLegacyGoldenDraft().payload.draft_manifest_hash,
    ).toBe(
      'sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd',
    );
    expect(checkCurrentSealedEraLegacyGoldenReview().payload.report_hash).toBe(
      'sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91',
    );
    expect(checkCurrentSealedEraLegacyGoldenSeal().payload.bundle_hash).toBe(
      'sha256:d00dc96d90ccfadd6081a77d7c4a16024e188b9a77a123743bc601f971219555',
    );
    const built = buildG2ReplayRepairSuccessor();
    const rc = artifact(
      built.files.get(G2_REPLAY_REPAIR_RC_MANIFEST_PATH)!,
    ).payload;
    const lineage = rc.predecessor_lineage as JsonObject;
    expect(lineage).toMatchObject({
      predecessor_review_candidate_root:
        'sha256:3401cc0230f7a4b81fe859a25832816b8db60cae6d29c5676d141f2151a186e6',
      predecessor_draft_manifest_hash:
        'sha256:b8ca7c91839b88b5591daf19f17a30e70b85e441d9dd4905807ef57bc37f7591',
      predecessor_golden_semantic_review_hash:
        'sha256:ceddcefcab8ff41a5e9b5d2ceb89dabcd3f9199639bb247d132a7c79c33dc15b',
      predecessor_sealed_bundle_hash:
        'sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb',
      approved_expected_semantics: 'changed_by_current_review',
    });
  }, 30_000);

  it('contains no approval, GoldenSemanticReview, seal, Publisher, or G3+ output', () => {
    const built = buildG2ReplayRepairSuccessor();
    const paths = [...built.files.keys()];
    expect(paths).toContain(G2_REPLAY_REPAIR_DRAFT_MANIFEST_PATH);
    expect(paths).toContain(G2_REPLAY_REPAIR_REVIEW_REPORT_PATH);
    for (const path of paths) {
      expect(path).not.toMatch(
        /golden-semantic-review|conformance\/sealed|publisher|registry\/authoring|\/g[3-9](?:\/|\.|-)/i,
      );
    }
    expect(built.draft.payload).toMatchObject({
      draft_status: 'frozen_pending_human_approval',
      approval: { status: 'absent', ref: null, hash: null },
      golden_semantic_review_status: 'not_run',
      g3_through_g9_status: 'not_started',
    });
  }, 30_000);
});
