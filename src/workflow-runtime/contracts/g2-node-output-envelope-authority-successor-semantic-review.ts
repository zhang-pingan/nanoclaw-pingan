import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import { G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA } from './g2-node-output-envelope-authority-successor-seal-schemas.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH =
  'sha256:e2b42ce214a96dfb00ceba4f4bb49c8ee9e25fdbf34a25aa376e7c336a7a4cf8';
export const G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH =
  'sha256:68b492f3261ad1b91d1596485be6d8cda00ddf4517cc957759d9cb08d5f1031c';
export const G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS = 1_784_966_400_000;

export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF =
  'conformance/golden-draft/g2-generated-schema-join-authority-v6/golden-draft-manifest@2.json';
export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_REF =
  'conformance/golden-draft/g2-generated-schema-join-authority-v6/golden-draft-cases@2.json';
export const G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_REF =
  'conformance/golden-draft/g2-generated-schema-join-authority-v6/artifact-inventory@2.json';
export const G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF =
  'conformance/golden-review/g2-generated-schema-join-authority-v6/golden-review-report@2.json';
export const G2_NODE_OUTPUT_ENVELOPE_RC_REF =
  'conformance/review-candidate/g2-generated-schema-join-authority-v6/review-candidate@2.json';
export const G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT =
  'conformance/golden-semantic-review/g2-generated-schema-join-authority-v6';
export const G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT}/golden-semantic-review@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT}/schemas/golden-semantic-review-schema@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT =
  'conformance/sealed/g2-generated-schema-join-authority-v6';

const DRAFT_ARTIFACT_HASH =
  'sha256:081ccddd26499f672bd0dac93996ae0b7b5a23347f59b4c1c8ae84b5d68ccb2e';
const REVIEW_REPORT_ARTIFACT_HASH =
  'sha256:f20e55f79fa6636d70cff3a46cacaf9b39fc49794b4a69977b381ba7b599a6c0';
const RC_ARTIFACT_HASH =
  'sha256:64fec8c48d3c6685f83bce980b8f85c03ce0d989aaa944e85e6a0d61c40297f1';
const PREDECESSOR_DRAFT_HASH =
  'sha256:965b1af2c4688c827a9d63f6b939a130271ab0e8b0fcf85a614cdd2620cb757e';
const PREDECESSOR_REVIEW_HASH =
  'sha256:96f6d0feee0e4a7d77349e0d8210875dc518a40ada167785c0859193a0246180';
const PREDECESSOR_SEMANTIC_REVIEW_HASH =
  'sha256:4481515b905ca062e3d028e17bb13ed2d4080059e844efa6c609ef292967e0de';
const PREDECESSOR_BUNDLE_HASH =
  'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05';
const DRAFT_DOMAIN = 'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const REPORT_DOMAIN = 'icarus:workflow-current-g2-golden-review-report:1\n';
const REVIEW_DOMAIN = 'icarus:workflow-compiler-golden-semantic-review:1\n';
const REVIEW_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-artifact:1\n';
const REVIEW_SCHEMA_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-schema:1\n';
const AUTHORIZED_ACTOR = 'human:local-owner';

export type G2NodeOutputEnvelopeDecision = 'approved' | 'changes_requested';

export interface G2NodeOutputEnvelopeSemanticReviewInput {
  authorizedBy: string;
  decision: G2NodeOutputEnvelopeDecision;
  approvedDraftManifestHash: string;
  approvedReviewReportHash: string;
  reviewedAtMs: number;
}

export interface G2NodeOutputEnvelopeSemanticReviewBuild {
  files: Map<string, string>;
  review: ContractArtifactEnvelope;
}

export class G2NodeOutputEnvelopeSemanticReviewError extends Error {
  readonly code = 'g2_node_output_envelope_semantic_review_error';

  constructor(message: string) {
    super(message);
    this.name = 'G2NodeOutputEnvelopeSemanticReviewError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      `Semantic review path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
    return value;
  } catch {
    throw new G2NodeOutputEnvelopeSemanticReviewError(`Expected object: ${label}`);
  }
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(`Expected array: ${label}`);
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function withoutField(value: JsonObject, field: string): JsonObject {
  const output = clone(value);
  delete output[field];
  return output;
}

function requireInternalHash(
  payload: JsonObject,
  field: string,
  domain: string,
  expected: string,
  label: string,
): void {
  if (
    payload[field] !== expected ||
    domainSeparatedSha256(domain, withoutField(payload, field)) !== expected
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(`${label} identity drift`);
  }
}

function artifact(
  format: string,
  id: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '2.0.0' },
    version: 1,
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateInput(input: G2NodeOutputEnvelopeSemanticReviewInput): void {
  if (input.authorizedBy !== AUTHORIZED_ACTOR) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Successor semantic review requires human:local-owner authorization',
    );
  }
  if (
    input.approvedDraftManifestHash !==
    G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Authorization does not match the exact successor Draft hash',
    );
  }
  if (
    input.approvedReviewReportHash !==
    G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Authorization does not match the exact successor review report hash',
    );
  }
  if (
    !Number.isSafeInteger(input.reviewedAtMs) ||
    input.reviewedAtMs !== G2_NODE_OUTPUT_ENVELOPE_OWNER_APPROVAL_REVIEWED_AT_MS
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Timestamp does not match the recorded owner approval event',
    );
  }
}

function validatePredecessorLineage(rc: ContractArtifactEnvelope): void {
  const lineage = object(rc.payload.predecessor_lineage, 'predecessor lineage');
  if (
    rc.hash !== RC_ARTIFACT_HASH ||
    lineage.predecessor_draft_manifest_hash !== PREDECESSOR_DRAFT_HASH ||
    lineage.predecessor_golden_review_report_hash !== PREDECESSOR_REVIEW_HASH ||
    lineage.predecessor_golden_semantic_review_hash !==
      PREDECESSOR_SEMANTIC_REVIEW_HASH ||
    lineage.predecessor_sealed_bundle_hash !== PREDECESSOR_BUNDLE_HASH ||
    lineage.approved_expected_semantics !== 'changed_by_current_review'
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Successor predecessor lineage drift',
    );
  }
}

export function buildG2NodeOutputEnvelopeSemanticReview(
  input: G2NodeOutputEnvelopeSemanticReviewInput,
): G2NodeOutputEnvelopeSemanticReviewBuild {
  validateInput(input);
  const draft = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF);
  const draftCases = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_REF);
  const draftInventory = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_REF);
  const report = readArtifact(G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF);
  const rc = readArtifact(G2_NODE_OUTPUT_ENVELOPE_RC_REF);

  requireInternalHash(
    draft.payload,
    'draft_manifest_hash',
    DRAFT_DOMAIN,
    G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    'Successor Draft manifest',
  );
  requireInternalHash(
    draftCases.payload,
    'cases_hash',
    CASES_DOMAIN,
    String(draftCases.payload.cases_hash),
    'Successor Draft cases',
  );
  requireInternalHash(
    report.payload,
    'report_hash',
    REPORT_DOMAIN,
    G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    'Successor review report',
  );
  if (
    draft.hash !== DRAFT_ARTIFACT_HASH ||
    report.hash !== REVIEW_REPORT_ARTIFACT_HASH ||
    draft.payload.cases_hash !== draftCases.hash ||
    draft.payload.inventory_hash !== draftInventory.hash ||
    draft.payload.draft_status !== 'frozen_pending_human_approval' ||
    draft.payload.case_count !== 40 ||
    draft.payload.expected_result_coverage !== 40 ||
    report.payload.draft_manifest_hash !==
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH ||
    report.payload.expected_coverage !== 40 ||
    report.payload.comparison_coverage !== 40 ||
    report.payload.byte_equal_count !== 40 ||
    report.payload.semantic_equal_count !== 40 ||
    report.payload.difference_count !== 0 ||
    report.payload.semantic_assertion_count !== 95 ||
    report.payload.semantic_assertion_failure_count !== 0
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Approved successor Draft or review evidence is incomplete or drifted',
    );
  }
  validatePredecessorLineage(rc);

  const caseIds = objects(draftCases.payload.cases, 'Draft cases')
    .map((entry) => String(entry.case_id))
    .sort();
  const reportCases = objects(report.payload.cases, 'review cases');
  const reportCaseIds = reportCases
    .map((entry) => String(entry.case_id))
    .sort();
  if (
    caseIds.length !== 40 ||
    new Set(caseIds).size !== 40 ||
    JSON.stringify(caseIds) !== JSON.stringify(reportCaseIds) ||
    reportCases.some(
      (entry) =>
        entry.byte_equal !== true ||
        entry.semantic_equal !== true ||
        entry.difference_count !== 0,
    )
  ) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Approved successor review coverage is partial or non-exact',
    );
  }

  const withoutHash = {
    format: 'icarus.workflow-compiler-golden-semantic-review/1',
    gate: 'G2',
    construction_phase: 'RC_REVIEW',
    review_id: 'g2-generated-schema-join-authority-v6-e2b42ce214a96dfb',
    bundle_version: '2.0.0',
    case_ids: caseIds,
    case_count: 40,
    draft_manifest_ref: G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF,
    draft_manifest_hash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH as Sha256Hash,
    draft_artifact_hash: draft.hash,
    golden_review_report_ref: G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF,
    golden_review_report_hash:
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH as Sha256Hash,
    golden_review_report_artifact_hash: report.hash,
    reviewer_actor_ref: 'human:local-owner',
    decision: input.decision,
    checklist_version: 'g2-node-output-envelope-authority-successor-semantic-review/2',
    checklist: [
      'exact_successor_draft_manifest_hash_verified',
      'exact_successor_review_report_hash_verified',
      'forty_case_expected_coverage_verified',
      'eleven_compiled_plan_proof_program_sets_reviewed',
      'twenty_nine_rejected_diagnostics_reviewed',
      'actual_comparison_40_of_40_acknowledged',
      'compiled_pointer_differences_0_verified',
      'predecessor_immutable_lineage_verified',
      'generated_schema_join_authority_semantics_reviewed',
      'draft_working_rc_identity_mutation_not_authorized',
      'g3_through_g9_not_authorized',
    ],
    comparison_acknowledgement: {
      role: 'actual_compiler_output_not_golden_oracle',
      expected_coverage: 40,
      comparison_coverage: 40,
      byte_equal_count: 40,
      semantic_equal_count: 40,
      compiled_difference_case_count: 0,
      pointer_difference_count: 0,
      semantic_assertion_count: 95,
      semantic_assertion_failure_count: 0,
    },
    authorization_scope: {
      exact_draft_only: true,
      expected_semantics_authoritative: true,
      immutable_review_and_golden_seal_authorized: true,
      draft_working_rc_identity_mutation_authorized: false,
      g3_through_g9_authorized: false,
    },
    signature_policy: 'not_required_local_single_user',
    notes_ref: null,
    notes_hash: null,
    reviewed_at_ms: input.reviewedAtMs,
  };
  const payload = {
    ...withoutHash,
    review_hash: domainSeparatedSha256(REVIEW_DOMAIN, withoutHash),
  };
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA as AnySchema,
  );
  if (!validate(payload)) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      `Successor semantic review failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
  const review = artifact(
    'icarus.workflow-compiler-golden-semantic-review/1',
    'icarus.workflow-compiler-golden-semantic-review.g2-generated-schema-join-authority-v6',
    REVIEW_ARTIFACT_DOMAIN,
    payload,
  );
  const schema = artifact(
    'icarus.workflow-compiler-golden-semantic-review-schema/1',
    'icarus.workflow-compiler-golden-semantic-review-schema.g2-generated-schema-join-authority-v6',
    REVIEW_SCHEMA_DOMAIN,
    G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA,
  );
  return {
    files: new Map([
      [G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_SCHEMA_REF, render(schema)],
      [G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF, render(review)],
    ]),
    review,
  };
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        throw new G2NodeOutputEnvelopeSemanticReviewError(
          'Successor semantic review tree contains a symlink',
        );
      }
      if (stat.isDirectory()) visit(entry);
      else files.push(path.relative(root, entry).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function relativeWithinReview(repositoryPath: string): string {
  const prefix = `${G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      `Review output escapes immutable root: ${repositoryPath}`,
    );
  }
  return repositoryPath.slice(prefix.length);
}

function checkFiles(root: string, files: Map<string, string>): void {
  const expected = [...files.keys()].map(relativeWithinReview).sort();
  if (JSON.stringify(listTree(root)) !== JSON.stringify(expected)) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Successor semantic review immutable inventory conflict',
    );
  }
  for (const [repositoryPath, bytes] of files) {
    if (
      fs.readFileSync(
        path.join(root, relativeWithinReview(repositoryPath)),
        'utf8',
      ) !== bytes
    ) {
      throw new G2NodeOutputEnvelopeSemanticReviewError(
        `Successor semantic review bytes drift: ${repositoryPath}`,
      );
    }
  }
}

export function generateG2NodeOutputEnvelopeSemanticReview(
  input: G2NodeOutputEnvelopeSemanticReviewInput,
): ContractArtifactEnvelope {
  const built = buildG2NodeOutputEnvelopeSemanticReview(input);
  const root = absolute(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT);
  if (fs.existsSync(root)) {
    checkFiles(root, built.files);
    return built.review;
  }
  if (fs.existsSync(absolute(G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT))) {
    throw new G2NodeOutputEnvelopeSemanticReviewError(
      'Cannot create a missing successor review after its sealed bundle exists',
    );
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = fs.mkdtempSync(`${root}.tmp-`);
  try {
    for (const [repositoryPath, bytes] of built.files) {
      const target = path.join(temporary, relativeWithinReview(repositoryPath));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    fs.renameSync(temporary, root);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return built.review;
}

export function checkG2NodeOutputEnvelopeSemanticReview(): ContractArtifactEnvelope {
  const root = absolute(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_ROOT);
  const existing = readArtifact(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF);
  const built = buildG2NodeOutputEnvelopeSemanticReview({
    authorizedBy: String(existing.payload.reviewer_actor_ref),
    decision: String(existing.payload.decision) as G2NodeOutputEnvelopeDecision,
    approvedDraftManifestHash: String(existing.payload.draft_manifest_hash),
    approvedReviewReportHash: String(
      existing.payload.golden_review_report_hash,
    ),
    reviewedAtMs: Number(existing.payload.reviewed_at_ms),
  });
  checkFiles(root, built.files);
  return built.review;
}
