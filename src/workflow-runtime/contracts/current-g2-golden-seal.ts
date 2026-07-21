import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA,
  CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA,
} from './current-g2-golden-seal-schemas.js';
import type {
  CurrentG2GoldenConformanceBundlePayload,
  CurrentG2GoldenSealBuild,
  CurrentG2SealedCase,
  CurrentG2SealedContentIdentity,
  CurrentG2SealedInventoryEntry,
  CurrentG2SealedInventoryPayload,
} from './current-g2-golden-seal-types.js';
import {
  assertCurrentG2SealedBoundary,
  CURRENT_G2_SEALED_DIRECTORY,
} from './current-g2-sealed-boundary.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

const CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF =
  'conformance/golden-draft/g2-semantic-correction/golden-draft-manifest@1.json';
const CURRENT_G2_GOLDEN_DRAFT_CASES_REF =
  'conformance/golden-draft/g2-semantic-correction/golden-draft-cases@1.json';
const CURRENT_G2_GOLDEN_REVIEW_REPORT_REF =
  'conformance/golden-review/g2-semantic-correction/golden-review-report@1.json';
const CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF =
  'conformance/golden-semantic-review/g2-semantic-correction/golden-semantic-review@1.json';
const CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH =
  'sha256:fb94f5e65425b482eee369bb115e46e884b249978e0f408832574d5be41dccbd' as const;
const CURRENT_G2_APPROVED_REVIEW_REPORT_HASH =
  'sha256:d8b2164b0d8e8b6ab7a3fe50559327e7f944312194251bc72a4330845969ad91' as const;

export const CURRENT_G2_GOLDEN_SEALED_ROOT = `conformance/sealed/${CURRENT_G2_SEALED_DIRECTORY}`;
export const CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF = `${CURRENT_G2_GOLDEN_SEALED_ROOT}/golden-conformance-bundle@1.json`;
export const CURRENT_G2_GOLDEN_SEALED_INVENTORY_REF = `${CURRENT_G2_GOLDEN_SEALED_ROOT}/artifact-inventory@1.json`;
export const CURRENT_G2_GOLDEN_SEALED_BUNDLE_SCHEMA_REF = `${CURRENT_G2_GOLDEN_SEALED_ROOT}/schemas/golden-conformance-bundle-schema@1.json`;
export const CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA_REF = `${CURRENT_G2_GOLDEN_SEALED_ROOT}/schemas/golden-conformance-inventory-schema@1.json`;

const DRAFT_INVENTORY_REF =
  'conformance/golden-draft/g2-semantic-correction/artifact-inventory@1.json';
const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const PLAN_DOMAIN = 'icarus:workflow-graph-plan:2\n';
const PROOF_BYTES_DOMAIN = 'icarus:workflow-current-g2-golden-proof-bytes:1\n';
const PROGRAM_BYTES_DOMAIN =
  'icarus:workflow-current-g2-golden-program-bytes:1\n';
const DRAFT_MANIFEST_DOMAIN =
  'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const DRAFT_CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const REVIEW_REPORT_DOMAIN =
  'icarus:workflow-current-g2-golden-review-report:1\n';
const SEMANTIC_REVIEW_DOMAIN =
  'icarus:workflow-compiler-golden-semantic-review:1\n';
const INVENTORY_DOMAIN = 'icarus:workflow-compiler-conformance-inventory:1\n';
const BUNDLE_DOMAIN = 'icarus:workflow-compiler-conformance:1\n';
const INVENTORY_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-conformance-inventory-artifact:1\n';
const BUNDLE_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-conformance-artifact:1\n';
const INVENTORY_SCHEMA_DOMAIN =
  'icarus:workflow-compiler-conformance-inventory-schema:1\n';
const BUNDLE_SCHEMA_DOMAIN =
  'icarus:workflow-compiler-conformance-bundle-schema:1\n';

export class CurrentG2GoldenSealError extends Error {
  readonly code = 'current_g2_golden_seal_error';

  constructor(message: string) {
    super(message);
    this.name = 'CurrentG2GoldenSealError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new CurrentG2GoldenSealError(
      `Golden seal path escapes contracts root: ${relativePath}`,
    );
  }
  return resolved;
}

function rawHash(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new CurrentG2GoldenSealError(`Expected object: ${label}`);
  }
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new CurrentG2GoldenSealError(`Expected array: ${label}`);
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') {
    throw new CurrentG2GoldenSealError(`Expected string: ${label}`);
  }
  return value;
}

function strings(value: JsonValue, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new CurrentG2GoldenSealError(`Expected string array: ${label}`);
  }
  return value as string[];
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    throw new CurrentG2GoldenSealError(`${label} internal hash drift`);
  }
}

function sealedInputRef(caseId: string, kind: 'source' | 'snapshot'): string {
  return `${CURRENT_G2_GOLDEN_SEALED_ROOT}/inputs/${caseId}.${kind}.json`;
}

function sealedExpectedRef(originalRef: string): string {
  return `${CURRENT_G2_GOLDEN_SEALED_ROOT}/expected/${path.basename(originalRef)}`;
}

function contentIdentity(
  sealedRef: string,
  originalRef: string,
  identity: JsonObject,
): CurrentG2SealedContentIdentity {
  return {
    path: sealedRef,
    original_ref: originalRef,
    media_type: 'application/json',
    canonicalization: 'rfc8785_jcs',
    raw_bytes_hash: string(
      identity.raw_bytes_hash,
      'content raw hash',
    ) as Sha256Hash,
    semantic_hash: string(
      identity.semantic_hash,
      'content semantic hash',
    ) as Sha256Hash,
    domain_separator: string(
      identity.domain_separator,
      'content domain separator',
    ),
  };
}

function validateExpectedContent(
  originalRef: string,
  identity: JsonObject,
  kind: 'result' | 'plan' | 'proofs' | 'programs',
): { bytes: string; value: JsonValue } {
  const bytes = fs.readFileSync(absolute(originalRef), 'utf8');
  if (rawHash(bytes) !== identity.raw_bytes_hash) {
    throw new CurrentG2GoldenSealError(
      `Expected ${kind} raw bytes drift: ${originalRef}`,
    );
  }
  const value = strictParseJsonBytes(Buffer.from(bytes, 'utf8'));
  let semanticHash: Sha256Hash;
  if (kind === 'result') {
    const result = object(value, 'expected result');
    semanticHash = domainSeparatedSha256(
      RESULT_DOMAIN,
      withoutField(result, 'result_hash'),
    );
    if (result.result_hash !== semanticHash) {
      throw new CurrentG2GoldenSealError(
        `Expected result hash drift: ${originalRef}`,
      );
    }
  } else if (kind === 'plan') {
    const planValue = object(value, 'expected plan');
    semanticHash = domainSeparatedSha256(
      PLAN_DOMAIN,
      withoutField(planValue, 'plan_hash'),
    );
    if (planValue.plan_hash !== semanticHash) {
      throw new CurrentG2GoldenSealError(
        `Expected Plan hash drift: ${originalRef}`,
      );
    }
  } else {
    semanticHash = domainSeparatedSha256(
      kind === 'proofs' ? PROOF_BYTES_DOMAIN : PROGRAM_BYTES_DOMAIN,
      value,
    );
  }
  if (semanticHash !== identity.semantic_hash) {
    throw new CurrentG2GoldenSealError(
      `Expected ${kind} semantic drift: ${originalRef}`,
    );
  }
  return { bytes, value };
}

function inventoryEntry(
  pathRef: string,
  kind: CurrentG2SealedInventoryEntry['kind'],
  caseId: string | null,
  originalRef: string | null,
  bytes: string | Uint8Array,
  semanticHash: Sha256Hash,
  domainSeparator: string,
): CurrentG2SealedInventoryEntry {
  return {
    path: pathRef,
    kind,
    case_id: caseId,
    original_ref: originalRef,
    raw_bytes_hash: rawHash(bytes),
    semantic_hash: semanticHash,
    domain_separator: domainSeparator,
  };
}

function validateApprovalChain(): {
  draft: ContractArtifactEnvelope;
  draftCases: ContractArtifactEnvelope;
  draftInventory: ContractArtifactEnvelope;
  report: ContractArtifactEnvelope;
  review: ContractArtifactEnvelope;
} {
  const draft = readArtifact(CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF);
  const draftCases = readArtifact(CURRENT_G2_GOLDEN_DRAFT_CASES_REF);
  const draftInventory = readArtifact(DRAFT_INVENTORY_REF);
  const report = readArtifact(CURRENT_G2_GOLDEN_REVIEW_REPORT_REF);
  const review = readArtifact(CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF);
  requireInternalHash(
    draft.payload,
    'draft_manifest_hash',
    DRAFT_MANIFEST_DOMAIN,
    CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH,
    'Draft manifest',
  );
  requireInternalHash(
    draftCases.payload,
    'cases_hash',
    DRAFT_CASES_DOMAIN,
    string(draftCases.payload.cases_hash, 'Draft cases hash'),
    'Draft cases',
  );
  requireInternalHash(
    report.payload,
    'report_hash',
    REVIEW_REPORT_DOMAIN,
    CURRENT_G2_APPROVED_REVIEW_REPORT_HASH,
    'Golden review report',
  );
  requireInternalHash(
    review.payload,
    'review_hash',
    SEMANTIC_REVIEW_DOMAIN,
    string(review.payload.review_hash, 'Golden semantic review hash'),
    'Golden semantic review',
  );
  validateCurrentG2GoldenSealReviewForTest(
    review.payload,
    draft.hash,
    report.hash,
  );
  if (
    draft.payload.cases_hash !== draftCases.hash ||
    draft.payload.inventory_hash !== draftInventory.hash ||
    report.payload.draft_manifest_hash !==
      CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH ||
    review.payload.draft_manifest_hash !==
      CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH ||
    review.payload.golden_review_report_hash !==
      CURRENT_G2_APPROVED_REVIEW_REPORT_HASH
  ) {
    throw new CurrentG2GoldenSealError(
      'Golden seal requires the exact complete approved review chain',
    );
  }
  return { draft, draftCases, draftInventory, report, review };
}

export function validateCurrentG2GoldenSealReviewForTest(
  review: JsonObject,
  draftArtifactHash: Sha256Hash,
  reportArtifactHash: Sha256Hash,
): void {
  const caseIds = strings(review.case_ids, 'approved review case ids');
  if (
    review.draft_manifest_hash !== CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH ||
    review.draft_artifact_hash !== draftArtifactHash ||
    review.golden_review_report_hash !==
      CURRENT_G2_APPROVED_REVIEW_REPORT_HASH ||
    review.golden_review_report_artifact_hash !== reportArtifactHash ||
    review.reviewer_actor_ref !== 'human:local-owner' ||
    review.decision !== 'approved' ||
    review.case_count !== 40 ||
    caseIds.length !== 40 ||
    new Set(caseIds).size !== 40 ||
    review.signature_policy !== 'not_required_local_single_user'
  ) {
    throw new CurrentG2GoldenSealError(
      'Golden seal rejects changes-requested, stale, partial, or forged review state',
    );
  }
}

export function buildCurrentG2GoldenSealArtifactsForTest(): CurrentG2GoldenSealBuild {
  const { draft, draftCases, report, review } = validateApprovalChain();
  const files = new Map<string, string>();
  const entries: CurrentG2SealedInventoryEntry[] = [];
  const sealedCases: CurrentG2SealedCase[] = [];
  const reviewedCaseIds = strings(
    review.payload.case_ids,
    'approved review case ids',
  );
  const draftCaseValues = objects(draftCases.payload.cases, 'Draft cases')
    .slice()
    .sort((left, right) =>
      String(left.case_id).localeCompare(String(right.case_id)),
    );
  if (
    reviewedCaseIds.length !== 40 ||
    new Set(reviewedCaseIds).size !== 40 ||
    JSON.stringify(reviewedCaseIds) !==
      JSON.stringify(draftCaseValues.map((entry) => String(entry.case_id)))
  ) {
    throw new CurrentG2GoldenSealError(
      'Golden seal review coverage is partial, stale, or duplicated',
    );
  }

  let compiledCount = 0;
  let rejectedCount = 0;
  for (const draftCase of draftCaseValues) {
    const caseId = string(draftCase.case_id, 'case id');
    const sourceBinding = object(draftCase.source_binding, 'source binding');
    const sourceOriginalRef = string(
      sourceBinding.raw_source_bytes_ref,
      'raw source ref',
    );
    const sourceBytes = fs.readFileSync(absolute(sourceOriginalRef));
    let sourceText: string;
    try {
      sourceText = new TextDecoder('utf-8', { fatal: true }).decode(
        sourceBytes,
      );
    } catch {
      throw new CurrentG2GoldenSealError(`Raw source is not UTF-8: ${caseId}`);
    }
    const sourceSemanticHash = domainSeparatedSha256(
      RAW_SOURCE_DOMAIN,
      sourceText,
    );
    if (
      rawHash(sourceBytes) !== sourceBinding.raw_source_file_hash ||
      sourceSemanticHash !== sourceBinding.raw_source_bytes_hash
    ) {
      throw new CurrentG2GoldenSealError(
        `Raw source identity drift: ${caseId}`,
      );
    }
    const sealedSourceRef = sealedInputRef(caseId, 'source');
    files.set(sealedSourceRef, sourceText);
    entries.push(
      inventoryEntry(
        sealedSourceRef,
        'raw_source',
        caseId,
        sourceOriginalRef,
        sourceBytes,
        sourceSemanticHash,
        RAW_SOURCE_DOMAIN,
      ),
    );

    const snapshotOriginalRef = string(
      sourceBinding.input_snapshot_ref,
      'input snapshot ref',
    );
    const snapshotBytes = fs.readFileSync(absolute(snapshotOriginalRef));
    const snapshot = parseContractArtifactEnvelope(
      strictParseJsonBytes(snapshotBytes),
    );
    if (
      rawHash(snapshotBytes) !== sourceBinding.input_snapshot_file_hash ||
      snapshot.hash !== sourceBinding.input_snapshot_hash
    ) {
      throw new CurrentG2GoldenSealError(
        `Input snapshot identity drift: ${caseId}`,
      );
    }
    const sealedSnapshotRef = sealedInputRef(caseId, 'snapshot');
    files.set(sealedSnapshotRef, snapshotBytes.toString('utf8'));
    entries.push(
      inventoryEntry(
        sealedSnapshotRef,
        'input_snapshot',
        caseId,
        snapshotOriginalRef,
        snapshotBytes,
        snapshot.hash,
        snapshot.domain_separator,
      ),
    );

    const resultIdentity = object(
      draftCase.expected_result,
      'expected result identity',
    );
    const resultOriginalRef = string(
      resultIdentity.path,
      'expected result ref',
    );
    const result = validateExpectedContent(
      resultOriginalRef,
      resultIdentity,
      'result',
    );
    const sealedResultRef = sealedExpectedRef(resultOriginalRef);
    files.set(sealedResultRef, result.bytes);
    entries.push(
      inventoryEntry(
        sealedResultRef,
        'expected_result',
        caseId,
        resultOriginalRef,
        result.bytes,
        string(
          resultIdentity.semantic_hash,
          'result semantic hash',
        ) as Sha256Hash,
        RESULT_DOMAIN,
      ),
    );

    const outcome = string(draftCase.outcome, 'expected outcome') as
      | 'compiled'
      | 'rejected';
    let plan: CurrentG2SealedContentIdentity | null = null;
    let proofs: CurrentG2SealedContentIdentity | null = null;
    let programs: CurrentG2SealedContentIdentity | null = null;
    if (outcome === 'compiled') {
      compiledCount += 1;
      const support = [
        ['expected_plan', 'plan', 'expected_plan'] as const,
        ['expected_proofs', 'proofs', 'expected_proofs'] as const,
        ['expected_programs', 'programs', 'expected_programs'] as const,
      ];
      const identities = new Map<string, CurrentG2SealedContentIdentity>();
      for (const [field, kind, inventoryKind] of support) {
        const identity = object(draftCase[field], `${field} identity`);
        const originalRef = string(identity.path, `${field} ref`);
        const validated = validateExpectedContent(originalRef, identity, kind);
        const sealedRef = sealedExpectedRef(originalRef);
        files.set(sealedRef, validated.bytes);
        entries.push(
          inventoryEntry(
            sealedRef,
            inventoryKind,
            caseId,
            originalRef,
            validated.bytes,
            string(
              identity.semantic_hash,
              `${field} semantic hash`,
            ) as Sha256Hash,
            string(identity.domain_separator, `${field} domain`),
          ),
        );
        identities.set(
          field,
          contentIdentity(sealedRef, originalRef, identity),
        );
      }
      plan = identities.get('expected_plan')!;
      proofs = identities.get('expected_proofs')!;
      programs = identities.get('expected_programs')!;
    } else {
      rejectedCount += 1;
      for (const field of [
        'expected_plan',
        'expected_proofs',
        'expected_programs',
      ]) {
        const identity = object(draftCase[field], `${field} absent identity`);
        if (identity.path !== null || identity.semantic_hash !== null) {
          throw new CurrentG2GoldenSealError(
            `Rejected case contains partial compiled support: ${caseId}`,
          );
        }
      }
    }

    const proofProgramHashes = [
      ...strings(draftCase.expected_proof_hashes, 'expected proof hashes'),
      ...strings(draftCase.expected_program_hashes, 'expected program hashes'),
    ].sort() as Sha256Hash[];
    sealedCases.push({
      case_id: caseId,
      source_kind: string(
        draftCase.source_kind,
        'source kind',
      ) as CurrentG2SealedCase['source_kind'],
      outcome,
      raw_source_bytes_ref: sealedSourceRef,
      raw_source_bytes_hash: sourceSemanticHash,
      raw_source_file_hash: rawHash(sourceBytes),
      registry_snapshot_ref: sealedSnapshotRef,
      interface_policy_safety_snapshot_ref: sealedSnapshotRef,
      input_snapshot_hash: snapshot.hash,
      input_snapshot_file_hash: rawHash(snapshotBytes),
      effective_case_input_hash: string(
        sourceBinding.effective_case_input_hash,
        'effective case input hash',
      ) as Sha256Hash,
      expected_source_hash: sourceSemanticHash,
      expected_result: contentIdentity(
        sealedResultRef,
        resultOriginalRef,
        resultIdentity,
      ),
      expected_plan: plan,
      expected_proofs: proofs,
      expected_programs: programs,
      expected_plan_bytes_ref: plan?.path ?? null,
      expected_plan_hash:
        draftCase.expected_plan_hash === null
          ? null
          : (string(
              draftCase.expected_plan_hash,
              'expected Plan hash',
            ) as Sha256Hash),
      expected_proof_program_hashes: proofProgramHashes,
      expected_diagnostics: clone(
        objects(draftCase.expected_diagnostics, 'expected diagnostics'),
      ),
      approved_review_ref: CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF,
      approved_review_hash: string(
        review.payload.review_hash,
        'approved review hash',
      ) as Sha256Hash,
    });
  }
  if (
    sealedCases.length !== 40 ||
    compiledCount !== 11 ||
    rejectedCount !== 29
  ) {
    throw new CurrentG2GoldenSealError(
      'Golden seal expected coverage is incomplete',
    );
  }

  const bundleSchema = artifact(
    'icarus.workflow-compiler-conformance-bundle-schema/1',
    'icarus.workflow-compiler-conformance-bundle-schema',
    BUNDLE_SCHEMA_DOMAIN,
    CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA,
  );
  const inventorySchema = artifact(
    'icarus.workflow-compiler-conformance-inventory-schema/1',
    'icarus.workflow-compiler-conformance-inventory-schema',
    INVENTORY_SCHEMA_DOMAIN,
    CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA,
  );
  for (const [schemaRef, schemaArtifact] of [
    [CURRENT_G2_GOLDEN_SEALED_BUNDLE_SCHEMA_REF, bundleSchema],
    [CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA_REF, inventorySchema],
  ] as const) {
    const bytes = render(schemaArtifact);
    files.set(schemaRef, bytes);
    entries.push(
      inventoryEntry(
        schemaRef,
        'schema',
        null,
        null,
        bytes,
        schemaArtifact.hash,
        schemaArtifact.domain_separator,
      ),
    );
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const inventoryWithoutHash: Omit<
    CurrentG2SealedInventoryPayload,
    'inventory_hash'
  > = {
    format: 'icarus.workflow-compiler-conformance-inventory/1',
    gate: 'G2',
    bundle_version: '1.0.0',
    inventory_scope: 'all_sealed_leaf_artifacts_excluding_inventory_and_bundle',
    entry_count: entries.length,
    entries,
  };
  const inventoryPayload = {
    ...inventoryWithoutHash,
    inventory_hash: domainSeparatedSha256(
      INVENTORY_DOMAIN,
      inventoryWithoutHash as unknown as JsonValue,
    ),
  } as unknown as CurrentG2SealedInventoryPayload;
  const inventory = artifact(
    'icarus.workflow-compiler-conformance-inventory/1',
    'icarus.workflow-compiler-conformance-inventory.g2-semantic-correction',
    INVENTORY_ARTIFACT_DOMAIN,
    inventoryPayload,
  );
  files.set(CURRENT_G2_GOLDEN_SEALED_INVENTORY_REF, render(inventory));

  const exactIdentity = object(
    draft.payload.exact_compiler_identity,
    'exact compiler identity',
  );
  const bundleWithoutHash: Omit<
    CurrentG2GoldenConformanceBundlePayload,
    'bundle_hash'
  > = {
    format: 'icarus.workflow-compiler-conformance/1',
    gate: 'G2',
    construction_phase: 'RC_REVIEW',
    bundle_version: '1.0.0',
    bundle_status: 'sealed_pending_ci_replay',
    publishable: false,
    production_reachable: false,
    toolchain_manifest_ref: clone(
      object(exactIdentity.compiler_toolchain_manifest_ref, 'toolchain ref'),
    ) as never,
    toolchain_hash: string(
      exactIdentity.compiler_toolchain_hash,
      'toolchain hash',
    ) as Sha256Hash,
    error_catalog_ref: clone(
      object(exactIdentity.error_catalog_ref, 'error catalog ref'),
    ) as never,
    error_catalog_hash: string(
      exactIdentity.error_catalog_hash,
      'error catalog hash',
    ) as Sha256Hash,
    exact_compiler_identity: clone(exactIdentity),
    draft_manifest_ref: CURRENT_G2_GOLDEN_DRAFT_MANIFEST_REF,
    draft_manifest_hash: CURRENT_G2_APPROVED_DRAFT_MANIFEST_HASH,
    draft_artifact_hash: draft.hash,
    golden_review_report_ref: CURRENT_G2_GOLDEN_REVIEW_REPORT_REF,
    golden_review_report_hash: CURRENT_G2_APPROVED_REVIEW_REPORT_HASH,
    golden_review_report_artifact_hash: report.hash,
    golden_semantic_review_ref: CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_REF,
    golden_semantic_review_hash: string(
      review.payload.review_hash,
      'semantic review hash',
    ) as Sha256Hash,
    golden_semantic_review_artifact_hash: review.hash,
    approval_status: 'approved',
    signature_policy: 'not_required_local_single_user',
    review_assignment: 'exactly_one_approved_review_per_case',
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    expected_result_coverage: 40,
    expected_plan_coverage: 11,
    expected_proof_bytes_coverage: 11,
    expected_program_bytes_coverage: 11,
    sealed_raw_source_coverage: 40,
    sealed_input_snapshot_coverage: 40,
    cases: sealedCases,
    inventory_ref: CURRENT_G2_GOLDEN_SEALED_INVENTORY_REF,
    inventory_hash: inventory.hash,
    sealed_artifact_count: files.size + 1,
    ci_replay_status: 'not_run_at_seal_time',
    g3_through_g9_status: 'not_started',
  };
  const bundlePayload = {
    ...bundleWithoutHash,
    bundle_hash: domainSeparatedSha256(
      BUNDLE_DOMAIN,
      bundleWithoutHash as unknown as JsonValue,
    ),
  } as unknown as CurrentG2GoldenConformanceBundlePayload;
  const bundle = artifact(
    'icarus.workflow-compiler-conformance/1',
    'icarus.workflow-compiler-conformance.g2-semantic-correction',
    BUNDLE_ARTIFACT_DOMAIN,
    bundlePayload,
  );
  files.set(CURRENT_G2_GOLDEN_SEALED_BUNDLE_REF, render(bundle));
  if (bundlePayload.sealed_artifact_count !== files.size) {
    throw new CurrentG2GoldenSealError('Golden seal artifact count drift');
  }
  return { files, inventory, bundle };
}

function relativeWithinSeal(repositoryPath: string): string {
  const prefix = `${CURRENT_G2_GOLDEN_SEALED_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new CurrentG2GoldenSealError(
      `Golden seal output escapes immutable root: ${repositoryPath}`,
    );
  }
  return repositoryPath.slice(prefix.length);
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new CurrentG2GoldenSealError(
          'Golden sealed tree contains a symlink',
        );
      }
      if (stat.isDirectory()) visit(candidate);
      else files.push(path.relative(root, candidate).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function checkFiles(root: string, expected: Map<string, string>): void {
  const expectedFiles = [...expected.keys()].map(relativeWithinSeal).sort();
  if (JSON.stringify(listTree(root)) !== JSON.stringify(expectedFiles)) {
    throw new CurrentG2GoldenSealError(
      'Golden sealed immutable inventory conflict',
    );
  }
  for (const [repositoryPath, bytes] of expected) {
    const local = path.join(root, relativeWithinSeal(repositoryPath));
    if (fs.readFileSync(local, 'utf8') !== bytes) {
      throw new CurrentG2GoldenSealError(
        `Golden sealed bytes drift: ${repositoryPath}`,
      );
    }
  }
}

export function generateCurrentG2GoldenSealAtRootForTest(
  root: string,
): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenSealArtifactsForTest();
  if (fs.existsSync(root)) {
    checkFiles(root, built.files);
    return built.bundle as ContractArtifactEnvelope;
  }
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !== 'empty'
  ) {
    throw new CurrentG2GoldenSealError(
      'A conflicting sealed bundle already occupies the current G2 boundary',
    );
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = fs.mkdtempSync(`${root}.tmp-`);
  try {
    for (const [repositoryPath, bytes] of built.files) {
      const target = path.join(temporary, relativeWithinSeal(repositoryPath));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    fs.renameSync(temporary, root);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return built.bundle as ContractArtifactEnvelope;
}

export function checkCurrentG2GoldenSealAtRootForTest(
  root: string,
): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenSealArtifactsForTest();
  checkFiles(root, built.files);
  return built.bundle as ContractArtifactEnvelope;
}

export function generateCurrentG2GoldenSeal(): ContractArtifactEnvelope {
  return generateCurrentG2GoldenSealAtRootForTest(
    absolute(CURRENT_G2_GOLDEN_SEALED_ROOT),
  );
}

export function checkCurrentG2GoldenSeal(): ContractArtifactEnvelope {
  assertCurrentG2SealedBoundary(absolute('conformance/sealed'));
  return checkCurrentG2GoldenSealAtRootForTest(
    absolute(CURRENT_G2_GOLDEN_SEALED_ROOT),
  );
}
