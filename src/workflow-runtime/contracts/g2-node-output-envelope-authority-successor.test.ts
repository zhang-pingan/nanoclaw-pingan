import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  buildG2NodeOutputEnvelopeSuccessor,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH,
} from '../compiler/g2-node-output-envelope-authority-successor.js';
import { evaluateCurrentG2GoldenReplay } from '../compiler/current-g2-golden-replay.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA,
  G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA,
  G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA,
} from './g2-node-output-envelope-authority-successor-seal-schemas.js';
import {
  buildG2NodeOutputEnvelopeSeal,
  checkG2NodeOutputEnvelopeSeal,
} from './g2-node-output-envelope-authority-successor-seal.js';
import {
  buildG2NodeOutputEnvelopeSemanticReview,
  checkG2NodeOutputEnvelopeSemanticReview,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
  G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS,
} from './g2-node-output-envelope-authority-successor-semantic-review.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

function approvedInput() {
  return {
    authorizedBy: 'human:local-owner',
    decision: 'approved' as const,
    approvedDraftManifestHash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    approvedReviewReportHash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    reviewedAtMs: G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS,
  };
}

describe('G2 v6 NodeOutputEnvelope authority successor', () => {
  it('builds a deterministic 40/40 Compiler 3.0.4 Draft', () => {
    const first = buildG2NodeOutputEnvelopeSuccessor();
    const second = buildG2NodeOutputEnvelopeSuccessor();
    expect([...second.files]).toEqual([...first.files]);
    expect(first.files).toHaveLength(172);
    expect(first.exactEqualCount).toBe(40);
    expect(first.pointerDifferenceCount).toBe(0);
    expect(first.rc.hash).toBe(
      'sha256:64fec8c48d3c6685f83bce980b8f85c03ce0d989aaa944e85e6a0d61c40297f1',
    );
    expect(first.draft.payload.draft_manifest_hash).toBe(
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    );
    expect(first.review.payload.report_hash).toBe(
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    );
    const draft = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(first.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH)!),
      ),
    );
    expect(draft.payload).toMatchObject({
      case_count: 40,
      expected_result_coverage: 40,
      draft_status: 'frozen_pending_human_approval',
    });
  }, 30_000);

  it('puts one exact envelope descriptor on every compiled Plan node', () => {
    const built = buildG2NodeOutputEnvelopeSuccessor();
    const plans = [...built.files]
      .filter(([path]) => path.includes('/expected/') && path.endsWith('.plan.json'))
      .map(([, bytes]) => strictParseJsonBytes(Buffer.from(bytes)) as JsonObject);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(Array.isArray(plan.nodes)).toBe(true);
      for (const node of plan.nodes as JsonObject[]) {
        expect(node.output_envelope_schema).toMatchObject({
          type: 'generated',
          generator: 'node_output_envelope',
          canonicalizer: 'RFC8785-JCS',
        });
      }
    }
  }, 30_000);

  it('builds closed deterministic semantic-review and seal artifacts', () => {
    const review = buildG2NodeOutputEnvelopeSemanticReview(approvedInput());
    const seal = buildG2NodeOutputEnvelopeSeal();
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(
      ajv.compile(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA as AnySchema)(
        review.review.payload,
      ),
    ).toBe(true);
    expect(
      ajv.compile(G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA as AnySchema)(
        seal.bundle.payload,
      ),
    ).toBe(true);
    expect(
      ajv.compile(G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA as AnySchema)(
        seal.inventory.payload,
      ),
    ).toBe(true);
    expect(checkG2NodeOutputEnvelopeSemanticReview().hash).toBe(
      review.review.hash,
    );
    expect(checkG2NodeOutputEnvelopeSeal().hash).toBe(seal.bundle.hash);
    expect(seal.bundle.payload).toMatchObject({
      case_count: 40,
      sealed_artifact_count: 157,
      bundle_hash:
        'sha256:4110072a90b441f154f580a647a30bd24a9aa3f052635c22e8e7d3dbe0a31967',
    });
  }, 30_000);

  it('passes exact current sealed replay', () => {
    expect(evaluateCurrentG2GoldenReplay()).toMatchObject({
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
    });
  }, 30_000);
});
