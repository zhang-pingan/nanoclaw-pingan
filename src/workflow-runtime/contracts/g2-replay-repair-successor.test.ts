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
    expect(first.files).toHaveLength(170);
    expect(first.exactEqualCount).toBe(40);
    expect(first.pointerDifferenceCount).toBe(0);
    expect(first.rc.hash).toBe(
      'sha256:3401cc0230f7a4b81fe859a25832816b8db60cae6d29c5676d141f2151a186e6',
    );
    expect(first.draft.payload.draft_manifest_hash).toBe(
      'sha256:b8ca7c91839b88b5591daf19f17a30e70b85e441d9dd4905807ef57bc37f7591',
    );
    expect(first.review.payload.report_hash).toBe(
      'sha256:5b3b5c721e6cda298da468566eb97da3423fcb86595de4f46dc66f79ebb55e99',
    );
    expect(first.review.payload).toMatchObject({
      construction_phase: 'RC_REVIEW',
      byte_equal_count: 40,
      semantic_equal_count: 40,
      semantic_assertion_count: 93,
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
        'sha256:85572b113f80e9552aa7f129def39f03ae8d94bc1dab9bbcc2bb78067dddda94',
      predecessor_draft_manifest_hash:
        'sha256:29fdd70ea872f9d4e52d49fbd988fff306d95820989920f5f1ecf2bc87019d2b',
      predecessor_golden_semantic_review_hash:
        'sha256:88c5412d1bd97d52a7f9bf41e17bd1db1e19b4a2e5466b3b25384fbdeb7cac0c',
      predecessor_sealed_bundle_hash:
        'sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145',
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
