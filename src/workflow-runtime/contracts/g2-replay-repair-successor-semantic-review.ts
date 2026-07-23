import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import { G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA } from './g2-replay-repair-successor-seal-schemas.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH =
  'sha256:b8ca7c91839b88b5591daf19f17a30e70b85e441d9dd4905807ef57bc37f7591';
export const G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH =
  'sha256:5b3b5c721e6cda298da468566eb97da3423fcb86595de4f46dc66f79ebb55e99';
export const G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS = 1_784_707_200_000;

export const G2_REPLAY_REPAIR_DRAFT_MANIFEST_REF =
  'conformance/golden-draft/g2-capability-outbox-binding-v3/golden-draft-manifest@2.json';
export const G2_REPLAY_REPAIR_DRAFT_CASES_REF =
  'conformance/golden-draft/g2-capability-outbox-binding-v3/golden-draft-cases@2.json';
export const G2_REPLAY_REPAIR_DRAFT_INVENTORY_REF =
  'conformance/golden-draft/g2-capability-outbox-binding-v3/artifact-inventory@2.json';
export const G2_REPLAY_REPAIR_REVIEW_REPORT_REF =
  'conformance/golden-review/g2-capability-outbox-binding-v3/golden-review-report@2.json';
export const G2_REPLAY_REPAIR_RC_REF =
  'conformance/review-candidate/g2-capability-outbox-binding-v3/review-candidate@2.json';
export const G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT =
  'conformance/golden-semantic-review/g2-capability-outbox-binding-v3';
export const G2_REPLAY_REPAIR_SEMANTIC_REVIEW_REF = `${G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT}/golden-semantic-review@2.json`;
export const G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA_REF = `${G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT}/schemas/golden-semantic-review-schema@2.json`;
export const G2_REPLAY_REPAIR_SEALED_ROOT =
  'conformance/sealed/g2-capability-outbox-binding-v3';

const DRAFT_ARTIFACT_HASH =
  'sha256:f844a063c08612e2eafad6a117482a83d48b81291a849ffca094c120bb504ecd';
const REVIEW_REPORT_ARTIFACT_HASH =
  'sha256:c5a52ece88f2dae6c6b640020a1b03cb24a5c96ae3cf038e0139d90de86b0226';
const RC_ARTIFACT_HASH =
  'sha256:3401cc0230f7a4b81fe859a25832816b8db60cae6d29c5676d141f2151a186e6';
const PREDECESSOR_DRAFT_HASH =
  'sha256:29fdd70ea872f9d4e52d49fbd988fff306d95820989920f5f1ecf2bc87019d2b';
const PREDECESSOR_REVIEW_HASH =
  'sha256:2f9edba7af3715f4d5d64328a9fd1a601505bafd1129cee603e87aacf80d92d7';
const PREDECESSOR_SEMANTIC_REVIEW_HASH =
  'sha256:88c5412d1bd97d52a7f9bf41e17bd1db1e19b4a2e5466b3b25384fbdeb7cac0c';
const PREDECESSOR_BUNDLE_HASH =
  'sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145';
const DRAFT_DOMAIN = 'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const REPORT_DOMAIN = 'icarus:workflow-current-g2-golden-review-report:1\n';
const REVIEW_DOMAIN = 'icarus:workflow-compiler-golden-semantic-review:1\n';
const REVIEW_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-artifact:1\n';
const REVIEW_SCHEMA_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-schema:1\n';
const AUTHORIZED_ACTOR = 'human:local-owner';

export type G2ReplayRepairDecision = 'approved' | 'changes_requested';

export interface G2ReplayRepairSemanticReviewInput {
  authorizedBy: string;
  decision: G2ReplayRepairDecision;
  approvedDraftManifestHash: string;
  approvedReviewReportHash: string;
  reviewedAtMs: number;
}

export interface G2ReplayRepairSemanticReviewBuild {
  files: Map<string, string>;
  review: ContractArtifactEnvelope;
}

export class G2ReplayRepairSemanticReviewError extends Error {
  readonly code = 'g2_replay_repair_semantic_review_error';

  constructor(message: string) {
    super(message);
    this.name = 'G2ReplayRepairSemanticReviewError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G2ReplayRepairSemanticReviewError(
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
    throw new G2ReplayRepairSemanticReviewError(`Expected object: ${label}`);
  }
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new G2ReplayRepairSemanticReviewError(`Expected array: ${label}`);
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
    throw new G2ReplayRepairSemanticReviewError(`${label} identity drift`);
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

function validateInput(input: G2ReplayRepairSemanticReviewInput): void {
  if (input.authorizedBy !== AUTHORIZED_ACTOR) {
    throw new G2ReplayRepairSemanticReviewError(
      'Successor semantic review requires human:local-owner authorization',
    );
  }
  if (
    input.approvedDraftManifestHash !==
    G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH
  ) {
    throw new G2ReplayRepairSemanticReviewError(
      'Authorization does not match the exact successor Draft hash',
    );
  }
  if (
    input.approvedReviewReportHash !==
    G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH
  ) {
    throw new G2ReplayRepairSemanticReviewError(
      'Authorization does not match the exact successor review report hash',
    );
  }
  if (
    !Number.isSafeInteger(input.reviewedAtMs) ||
    input.reviewedAtMs !== G2_REPLAY_REPAIR_OWNER_APPROVAL_REVIEWED_AT_MS
  ) {
    throw new G2ReplayRepairSemanticReviewError(
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
    throw new G2ReplayRepairSemanticReviewError(
      'Successor predecessor lineage drift',
    );
  }
}

export function buildG2ReplayRepairSemanticReview(
  input: G2ReplayRepairSemanticReviewInput,
): G2ReplayRepairSemanticReviewBuild {
  validateInput(input);
  const draft = readArtifact(G2_REPLAY_REPAIR_DRAFT_MANIFEST_REF);
  const draftCases = readArtifact(G2_REPLAY_REPAIR_DRAFT_CASES_REF);
  const draftInventory = readArtifact(G2_REPLAY_REPAIR_DRAFT_INVENTORY_REF);
  const report = readArtifact(G2_REPLAY_REPAIR_REVIEW_REPORT_REF);
  const rc = readArtifact(G2_REPLAY_REPAIR_RC_REF);

  requireInternalHash(
    draft.payload,
    'draft_manifest_hash',
    DRAFT_DOMAIN,
    G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH,
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
    G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH,
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
      G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH ||
    report.payload.expected_coverage !== 40 ||
    report.payload.comparison_coverage !== 40 ||
    report.payload.byte_equal_count !== 40 ||
    report.payload.semantic_equal_count !== 40 ||
    report.payload.difference_count !== 0 ||
    report.payload.semantic_assertion_count !== 93 ||
    report.payload.semantic_assertion_failure_count !== 0
  ) {
    throw new G2ReplayRepairSemanticReviewError(
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
    throw new G2ReplayRepairSemanticReviewError(
      'Approved successor review coverage is partial or non-exact',
    );
  }

  const withoutHash = {
    format: 'icarus.workflow-compiler-golden-semantic-review/1',
    gate: 'G2',
    construction_phase: 'RC_REVIEW',
    review_id: 'g2-capability-outbox-binding-v3-b8ca7c91839b88b5',
    bundle_version: '2.0.0',
    case_ids: caseIds,
    case_count: 40,
    draft_manifest_ref: G2_REPLAY_REPAIR_DRAFT_MANIFEST_REF,
    draft_manifest_hash:
      G2_REPLAY_REPAIR_APPROVED_DRAFT_MANIFEST_HASH as Sha256Hash,
    draft_artifact_hash: draft.hash,
    golden_review_report_ref: G2_REPLAY_REPAIR_REVIEW_REPORT_REF,
    golden_review_report_hash:
      G2_REPLAY_REPAIR_APPROVED_REVIEW_REPORT_HASH as Sha256Hash,
    golden_review_report_artifact_hash: report.hash,
    reviewer_actor_ref: 'human:local-owner',
    decision: input.decision,
    checklist_version: 'g2-replay-repair-successor-semantic-review/2',
    checklist: [
      'exact_successor_draft_manifest_hash_verified',
      'exact_successor_review_report_hash_verified',
      'forty_case_expected_coverage_verified',
      'eleven_compiled_plan_proof_program_sets_reviewed',
      'twenty_nine_rejected_diagnostics_reviewed',
      'actual_comparison_40_of_40_acknowledged',
      'compiled_pointer_differences_0_verified',
      'predecessor_immutable_lineage_verified',
      'capability_outbox_execution_binding_semantics_reviewed',
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
      semantic_assertion_count: 93,
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
    G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA as AnySchema,
  );
  if (!validate(payload)) {
    throw new G2ReplayRepairSemanticReviewError(
      `Successor semantic review failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
  const review = artifact(
    'icarus.workflow-compiler-golden-semantic-review/1',
    'icarus.workflow-compiler-golden-semantic-review.g2-capability-outbox-binding-v3',
    REVIEW_ARTIFACT_DOMAIN,
    payload,
  );
  const schema = artifact(
    'icarus.workflow-compiler-golden-semantic-review-schema/1',
    'icarus.workflow-compiler-golden-semantic-review-schema.g2-capability-outbox-binding-v3',
    REVIEW_SCHEMA_DOMAIN,
    G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA,
  );
  return {
    files: new Map([
      [G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA_REF, render(schema)],
      [G2_REPLAY_REPAIR_SEMANTIC_REVIEW_REF, render(review)],
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
        throw new G2ReplayRepairSemanticReviewError(
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
  const prefix = `${G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new G2ReplayRepairSemanticReviewError(
      `Review output escapes immutable root: ${repositoryPath}`,
    );
  }
  return repositoryPath.slice(prefix.length);
}

function checkFiles(root: string, files: Map<string, string>): void {
  const expected = [...files.keys()].map(relativeWithinReview).sort();
  if (JSON.stringify(listTree(root)) !== JSON.stringify(expected)) {
    throw new G2ReplayRepairSemanticReviewError(
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
      throw new G2ReplayRepairSemanticReviewError(
        `Successor semantic review bytes drift: ${repositoryPath}`,
      );
    }
  }
}

export function generateG2ReplayRepairSemanticReview(
  input: G2ReplayRepairSemanticReviewInput,
): ContractArtifactEnvelope {
  const built = buildG2ReplayRepairSemanticReview(input);
  const root = absolute(G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT);
  if (fs.existsSync(root)) {
    checkFiles(root, built.files);
    return built.review;
  }
  if (fs.existsSync(absolute(G2_REPLAY_REPAIR_SEALED_ROOT))) {
    throw new G2ReplayRepairSemanticReviewError(
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

export function checkG2ReplayRepairSemanticReview(): ContractArtifactEnvelope {
  const root = absolute(G2_REPLAY_REPAIR_SEMANTIC_REVIEW_ROOT);
  const existing = readArtifact(G2_REPLAY_REPAIR_SEMANTIC_REVIEW_REF);
  const built = buildG2ReplayRepairSemanticReview({
    authorizedBy: String(existing.payload.reviewer_actor_ref),
    decision: String(existing.payload.decision) as G2ReplayRepairDecision,
    approvedDraftManifestHash: String(existing.payload.draft_manifest_hash),
    approvedReviewReportHash: String(
      existing.payload.golden_review_report_hash,
    ),
    reviewedAtMs: Number(existing.payload.reviewed_at_ms),
  });
  checkFiles(root, built.files);
  return built.review;
}
