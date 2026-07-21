import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import { CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA } from './current-g2-golden-seal-schemas.js';
import type {
  CurrentG2GoldenDecision,
  CurrentG2GoldenSemanticReviewPayload,
} from './current-g2-golden-seal-types.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF =
  'conformance/golden-draft/g2-semantic-correction/golden-draft-manifest@1.json';
export const CURRENT_G2_GOLDEN_DRAFT_CASES_REF =
  'conformance/golden-draft/g2-semantic-correction/golden-draft-cases@1.json';
export const CURRENT_G2_GOLDEN_REVIEW_REPORT_REF =
  'conformance/golden-review/g2-semantic-correction/golden-review-report@1.json';
export const CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT =
  'conformance/golden-semantic-review/g2-semantic-correction';
export const CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF = `${CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT}/golden-semantic-review@1.json`;
export const CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA_REF = `${CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT}/schemas/golden-semantic-review-schema@1.json`;

export const CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH =
  'sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd';
export const CURRENT_G2_APPROVED_REVIEW_REPORT_HASH =
  'sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91';
export const CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS = 1_784_604_172_000;

const REVIEW_DOMAIN = 'icarus:workflow-compiler-golden-semantic-review:1\n';
const REVIEW_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-artifact:1\n';
const REVIEW_SCHEMA_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review-schema:1\n';
const AUTHORIZED_ACTOR = 'human:local-owner';

export interface CurrentG2GoldenSemanticReviewInput {
  authorizedBy: string;
  decision: CurrentG2GoldenDecision;
  approvedDraftManifestHash: string;
  approvedReviewReportHash: string;
  reviewedAtMs: number;
}

export interface CurrentG2GoldenSemanticReviewBuild {
  files: Map<string, string>;
  review: ContractArtifactEnvelope;
}

export class CurrentG2GoldenSemanticReviewError extends Error {
  readonly code = 'current_g2_golden_semantic_review_error';

  constructor(message: string) {
    super(message);
    this.name = 'CurrentG2GoldenSemanticReviewError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new CurrentG2GoldenSemanticReviewError(
      `Golden semantic review path escapes root: ${relativePath}`,
    );
  }
  return resolved;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new CurrentG2GoldenSemanticReviewError(`Expected array: ${label}`);
  }
  return value.map((entry, index) => {
    try {
      assertJsonObject(entry);
    } catch {
      throw new CurrentG2GoldenSemanticReviewError(
        `Expected object: ${label}[${index}]`,
      );
    }
    return entry;
  });
}

function artifact(
  format: string,
  id: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '1.0.0' },
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

function validateInput(input: CurrentG2GoldenSemanticReviewInput): void {
  if (input.authorizedBy !== AUTHORIZED_ACTOR) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review requires human:local-owner authorization',
    );
  }
  if (
    input.approvedDraftManifestHash !== CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review authorization does not match the exact Draft hash',
    );
  }
  if (
    input.approvedReviewReportHash !== CURRENT_G2_APPROVED_REVIEW_REPORT_HASH
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review authorization does not match the exact review report hash',
    );
  }
  if (
    !Number.isSafeInteger(input.reviewedAtMs) ||
    input.reviewedAtMs !== CURRENT_G2_OWNER_APPROVAL_REVIEWED_AT_MS
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review timestamp does not match the owner approval event',
    );
  }
}

export function buildCurrentG2GoldenSemanticReviewArtifactsForTest(
  input: CurrentG2GoldenSemanticReviewInput,
): CurrentG2GoldenSemanticReviewBuild {
  validateInput(input);
  const draft = readArtifact(CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF);
  const draftCases = readArtifact(CURRENT_G2_GOLDEN_DRAFT_CASES_REF);
  const report = readArtifact(CURRENT_G2_GOLDEN_REVIEW_REPORT_REF);
  if (
    draft.payload.draft_manifest_hash !== input.approvedDraftManifestHash ||
    draft.payload.draft_status !== 'frozen_pending_human_approval' ||
    draft.payload.case_count !== 40 ||
    draft.payload.expected_result_coverage !== 40
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Exact frozen Draft is absent, incomplete, or drifted',
    );
  }
  if (
    report.payload.report_hash !== input.approvedReviewReportHash ||
    report.payload.draft_manifest_hash !== input.approvedDraftManifestHash ||
    report.payload.expected_coverage !== 40 ||
    report.payload.comparison_coverage !== 40 ||
    report.payload.byte_equal_count !== 29 ||
    report.payload.semantic_equal_count !== 29 ||
    report.payload.difference_count !== 622 ||
    report.payload.semantic_assertion_count !== 85 ||
    report.payload.semantic_assertion_failure_count !== 0
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden review report does not match the owner-acknowledged comparison',
    );
  }
  const draftCaseValues = objects(draftCases.payload.cases, 'Draft cases');
  const reportCaseValues = objects(report.payload.cases, 'review report cases');
  const caseIds = draftCaseValues.map((entry) => String(entry.case_id)).sort();
  const reportCaseIds = reportCaseValues
    .map((entry) => String(entry.case_id))
    .sort();
  if (
    caseIds.length !== 40 ||
    new Set(caseIds).size !== 40 ||
    JSON.stringify(caseIds) !== JSON.stringify(reportCaseIds)
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review coverage is partial or duplicated',
    );
  }
  const differenceCases = reportCaseValues.filter(
    (entry) => entry.semantic_equal === false,
  );
  if (
    differenceCases.length !== 11 ||
    differenceCases.some((entry) => entry.outcome !== 'compiled')
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Owner-acknowledged compiled comparison set drifted',
    );
  }

  const withoutHash: Omit<CurrentG2GoldenSemanticReviewPayload, 'review_hash'> =
    {
      format: 'icarus.workflow-compiler-golden-semantic-review/1',
      gate: 'G2',
      construction_phase: 'RC_REVIEW',
      review_id: 'g2-semantic-correction-fb94f5e65425b482',
      bundle_version: '1.0.0',
      case_ids: caseIds,
      case_count: 40,
      draft_manifest_ref: CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF,
      draft_manifest_hash: input.approvedDraftManifestHash as Sha256Hash,
      draft_artifact_hash: draft.hash,
      golden_review_report_ref: CURRENT_G2_GOLDEN_REVIEW_REPORT_REF,
      golden_review_report_hash: input.approvedReviewReportHash as Sha256Hash,
      golden_review_report_artifact_hash: report.hash,
      reviewer_actor_ref: 'human:local-owner',
      decision: input.decision,
      checklist_version: 'current-g2-golden-semantic-review/1',
      checklist: [
        'exact_draft_manifest_hash_verified',
        'exact_golden_review_report_hash_verified',
        'forty_case_expected_coverage_verified',
        'eleven_compiled_plan_proof_program_sets_reviewed',
        'twenty_nine_rejected_diagnostics_reviewed',
        'actual_comparison_29_of_40_acknowledged',
        'compiled_pointer_differences_622_acknowledged',
        'expected_semantics_approved_as_authoritative',
        'draft_working_rc_identity_mutation_not_authorized',
        'g3_through_g9_not_authorized',
      ],
      comparison_acknowledgement: {
        role: 'actual_compiler_output_not_golden_oracle',
        expected_coverage: 40,
        comparison_coverage: 40,
        byte_equal_count: 29,
        semantic_equal_count: 29,
        compiled_difference_case_count: 11,
        pointer_difference_count: 622,
        semantic_assertion_count: 85,
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
    review_hash: domainSeparatedSha256(
      REVIEW_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  } as unknown as CurrentG2GoldenSemanticReviewPayload;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA as AnySchema,
  );
  if (!validate(payload)) {
    throw new CurrentG2GoldenSemanticReviewError(
      `Golden semantic review failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
  const review = artifact(
    'icarus.workflow-compiler-golden-semantic-review/1',
    'icarus.workflow-compiler-golden-semantic-review.g2-semantic-correction',
    REVIEW_ARTIFACT_DOMAIN,
    payload,
  );
  const schema = artifact(
    'icarus.workflow-compiler-golden-semantic-review-schema/1',
    'icarus.workflow-compiler-golden-semantic-review-schema',
    REVIEW_SCHEMA_DOMAIN,
    CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA,
  );
  return {
    files: new Map([
      [CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA_REF, render(schema)],
      [CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF, render(review)],
    ]),
    review,
  };
}

function localPath(root: string, repositoryPath: string): string {
  const prefix = `${CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new CurrentG2GoldenSemanticReviewError(
      `Review output escapes immutable root: ${repositoryPath}`,
    );
  }
  return path.join(root, repositoryPath.slice(prefix.length));
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new CurrentG2GoldenSemanticReviewError(
          'Golden semantic review tree contains a symlink',
        );
      }
      if (stat.isDirectory()) visit(candidate);
      else files.push(path.relative(root, candidate).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files;
}

function checkFiles(root: string, expected: Map<string, string>): void {
  const local = new Map(
    [...expected].map(([repositoryPath, bytes]) => [
      path
        .relative(root, localPath(root, repositoryPath))
        .split(path.sep)
        .join('/'),
      bytes,
    ]),
  );
  if (
    JSON.stringify(listTree(root)) !== JSON.stringify([...local.keys()].sort())
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Golden semantic review immutable inventory conflict',
    );
  }
  for (const [relativePath, bytes] of local) {
    if (fs.readFileSync(path.join(root, relativePath), 'utf8') !== bytes) {
      throw new CurrentG2GoldenSemanticReviewError(
        `Golden semantic review bytes drift: ${relativePath}`,
      );
    }
  }
}

export function generateCurrentG2GoldenSemanticReviewAtRootForTest(
  root: string,
  input: CurrentG2GoldenSemanticReviewInput,
): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenSemanticReviewArtifactsForTest(input);
  if (fs.existsSync(root)) {
    checkFiles(root, built.files);
    return built.review;
  }
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) ===
    'current_g2'
  ) {
    throw new CurrentG2GoldenSemanticReviewError(
      'Cannot create a missing review after the sealed boundary exists',
    );
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = fs.mkdtempSync(`${root}.tmp-`);
  try {
    for (const [repositoryPath, bytes] of built.files) {
      const target = path.join(
        temporary,
        path.relative(root, localPath(root, repositoryPath)),
      );
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

export function checkCurrentG2GoldenSemanticReviewAtRootForTest(
  root: string,
): ContractArtifactEnvelope {
  const existing = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(root, 'golden-semantic-review@1.json')),
    ),
  );
  const input: CurrentG2GoldenSemanticReviewInput = {
    authorizedBy: String(existing.payload.reviewer_actor_ref),
    decision: String(existing.payload.decision) as CurrentG2GoldenDecision,
    approvedDraftManifestHash: String(existing.payload.draft_manifest_hash),
    approvedReviewReportHash: String(
      existing.payload.golden_review_report_hash,
    ),
    reviewedAtMs: Number(existing.payload.reviewed_at_ms),
  };
  const built = buildCurrentG2GoldenSemanticReviewArtifactsForTest(input);
  checkFiles(root, built.files);
  return built.review;
}

export function generateCurrentG2GoldenSemanticReview(
  input: CurrentG2GoldenSemanticReviewInput,
): ContractArtifactEnvelope {
  return generateCurrentG2GoldenSemanticReviewAtRootForTest(
    absolute(CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT),
    input,
  );
}

export function checkCurrentG2GoldenSemanticReview(): ContractArtifactEnvelope {
  return checkCurrentG2GoldenSemanticReviewAtRootForTest(
    absolute(CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_ROOT),
  );
}
