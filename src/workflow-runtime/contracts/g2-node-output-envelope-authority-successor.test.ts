import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  buildG2NodeOutputEnvelopeSuccessor,
  assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest,
  G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH,
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
import {
  authorCurrentG2GoldenExpectedResult as authorV5ExpectedResult,
  extractCurrentG2GoldenProgramBytes as extractV5ProgramBytes,
  extractCurrentG2GoldenProofBytes as extractV5ProofBytes,
} from './generated-schema-join-authority-golden-authoring.js';
import {
  authorCurrentG2GoldenExpectedResult as authorV6ExpectedResult,
  extractCurrentG2GoldenProgramBytes as extractV6ProgramBytes,
  extractCurrentG2GoldenProofBytes as extractV6ProofBytes,
} from './node-output-envelope-golden-authoring.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function rawHash(bytes: Uint8Array | string): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

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
        Buffer.from(
          first.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH)!,
        ),
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
      .filter(
        ([path]) => path.includes('/expected/') && path.endsWith('.plan.json'),
      )
      .map(
        ([, bytes]) => strictParseJsonBytes(Buffer.from(bytes)) as JsonObject,
      );
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

  it('binds the declared authoring source to the invoked generator and rejects the v5 impersonator', () => {
    const built = buildG2NodeOutputEnvelopeSuccessor();
    const draftManifest = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(
          built.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_PATH)!,
        ),
      ),
    );
    expect(draftManifest.payload).toMatchObject({
      authoring_generator_ref: G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
      authoring_generator_hash:
        'sha256:a574091ca544a7b838936403d1bd55d3f1757468d453d5205aaa6f8a11f897ec',
    });
    expect(
      rawHash(
        fs.readFileSync(
          path.join(repoRoot, G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF),
        ),
      ),
    ).toBe(draftManifest.payload.authoring_generator_hash);

    const successorSource = fs.readFileSync(
      path.join(
        repoRoot,
        'src/workflow-runtime/compiler/g2-node-output-envelope-authority-successor.ts',
      ),
      'utf8',
    );
    expect(
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(),
    ).toEqual({
      ref: G2_NODE_OUTPUT_ENVELOPE_AUTHORING_GENERATOR_REF,
      rawHash: draftManifest.payload.authoring_generator_hash,
    });
    expect(() =>
      assertG2NodeOutputEnvelopeAuthoringGeneratorBindingForTest(
        successorSource.replace(
          '../contracts/node-output-envelope-golden-authoring.js',
          '../contracts/generated-schema-join-authority-golden-authoring.js',
        ),
      ),
    ).toThrow(
      'Declared authoring generator is not the generator actually imported and invoked',
    );

    const cases = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(built.files.get(G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_PATH)!),
      ),
    );
    const staticLowering = (cases.payload.cases as JsonObject[]).find(
      (entry) => entry.case_id === 'positive.static-lowering',
    )!;
    const sourceBinding = staticLowering.source_binding as JsonObject;
    const sourceText = fs.readFileSync(
      path.join(contractsRoot, String(sourceBinding.raw_source_bytes_ref)),
      'utf8',
    );
    const snapshot = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(
          path.join(contractsRoot, String(sourceBinding.input_snapshot_ref)),
        ),
      ),
    );
    const expectedResultBinding = staticLowering.expected_result as JsonObject;
    const expectedPlanBinding = staticLowering.expected_plan as JsonObject;
    const expectedProofsBinding = staticLowering.expected_proofs as JsonObject;
    const expectedProgramsBinding =
      staticLowering.expected_programs as JsonObject;
    const expectedResultBytes = built.files.get(
      String(expectedResultBinding.path),
    )!;
    const expectedPlanBytes = built.files.get(
      String(expectedPlanBinding.path),
    )!;
    const expectedProofsBytes = built.files.get(
      String(expectedProofsBinding.path),
    )!;
    const expectedProgramsBytes = built.files.get(
      String(expectedProgramsBinding.path),
    )!;
    const expectedResult = strictParseJsonBytes(
      Buffer.from(expectedResultBytes),
    ) as JsonObject;
    const input = {
      caseId: 'positive.static-lowering',
      sourceKind: 'workflow_definition' as const,
      rawSourceText: sourceText,
      expectedSourceHash: expectedResult.source_hash as `sha256:${string}`,
      inputSnapshot: snapshot.payload,
      expectedDiagnostics: [],
    };
    const v5 = authorV5ExpectedResult(input);
    const v6 = authorV6ExpectedResult(input);
    const v5Plan = v5.normalized_plan as unknown as JsonObject;
    const v6Plan = v6.normalized_plan as unknown as JsonObject;
    const descriptorCount = (plan: JsonObject) =>
      (plan.nodes as JsonObject[]).filter(
        (node) => node.output_envelope_schema !== undefined,
      ).length;

    expect(descriptorCount(v5Plan)).toBe(0);
    expect(descriptorCount(v6Plan)).toBe(3);
    expect(v5.result_hash).toBe(
      'sha256:707cc336c6b96732d9c3bf96e42ee21d46db4b636912e50598dffdcb974a4ea4',
    );
    expect(v6.result_hash).toBe(
      'sha256:a09b8c0ef277d3a71cd486ccb96fedb2afe32ac15f05a86d2cbf5e071c95d394',
    );
    expect(v6).toEqual(expectedResult);
    expect(v5).not.toEqual(expectedResult);
    expect(v5Plan).not.toEqual(v6Plan);
    expect(v6Plan).toEqual(
      strictParseJsonBytes(Buffer.from(expectedPlanBytes)),
    );
    expect(extractV6ProofBytes(v6Plan)).toEqual(
      strictParseJsonBytes(Buffer.from(expectedProofsBytes)),
    );
    expect(extractV6ProgramBytes(v6Plan)).toEqual(
      strictParseJsonBytes(Buffer.from(expectedProgramsBytes)),
    );
    expect(rawHash(expectedResultBytes)).toBe(
      expectedResultBinding.raw_bytes_hash,
    );
    expect(rawHash(expectedPlanBytes)).toBe(expectedPlanBinding.raw_bytes_hash);
    expect(rawHash(expectedProofsBytes)).toBe(
      expectedProofsBinding.raw_bytes_hash,
    );
    expect(rawHash(expectedProgramsBytes)).toBe(
      expectedProgramsBinding.raw_bytes_hash,
    );
    expect(v6.result_hash).toBe(expectedResultBinding.semantic_hash);
    expect(v6Plan.plan_hash).toBe(expectedPlanBinding.semantic_hash);
    expect(v6.proof_hashes).toEqual(staticLowering.expected_proof_hashes);
    expect(v6.program_hashes).toEqual(staticLowering.expected_program_hashes);
    expect(extractV5ProofBytes(v5Plan)).toEqual(extractV6ProofBytes(v6Plan));
    expect(extractV5ProgramBytes(v5Plan)).toEqual(
      extractV6ProgramBytes(v6Plan),
    );
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
      ajv.compile(
        G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA as AnySchema,
      )(seal.bundle.payload),
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
        'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7',
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
