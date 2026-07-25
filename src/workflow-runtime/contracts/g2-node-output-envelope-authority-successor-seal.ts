import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA,
  G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA,
} from './g2-node-output-envelope-authority-successor-seal-schemas.js';
import {
  checkG2NodeOutputEnvelopeSemanticReview,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
  G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_REF,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_REF,
  G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF,
  G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF,
  G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT,
  G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF,
} from './g2-node-output-envelope-authority-successor-semantic-review.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import type {
  CurrentG2SealedCase,
  CurrentG2SealedContentIdentity,
  CurrentG2SealedInventoryEntry,
} from './current-g2-golden-seal-types.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const G2_NODE_OUTPUT_ENVELOPE_SEALED_BUNDLE_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/golden-conformance-bundle@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/artifact-inventory@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_SEALED_BUNDLE_SCHEMA_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/schemas/golden-conformance-bundle-schema@2.json`;
export const G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA_REF = `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/schemas/golden-conformance-inventory-schema@2.json`;

const DRAFT_ARTIFACT_HASH =
  'sha256:b43960ab002a49d918bddbce057e51e1055b65e2e7a1d10e44fed25c28ea66c4';
const REVIEW_REPORT_ARTIFACT_HASH =
  'sha256:4ebc90aa4028f68580fa2aaaaaf23ef7e27bd61c9e285a8f648a42278b0e9aa0';
const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const PLAN_DOMAIN = 'icarus:workflow-graph-plan:2\n';
const PROOF_BYTES_DOMAIN = 'icarus:workflow-current-g2-golden-proof-bytes:1\n';
const PROGRAM_BYTES_DOMAIN =
  'icarus:workflow-current-g2-golden-program-bytes:1\n';
const DRAFT_DOMAIN = 'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const REPORT_DOMAIN = 'icarus:workflow-current-g2-golden-review-report:1\n';
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

export interface G2NodeOutputEnvelopeSealBuild {
  files: Map<string, string>;
  inventory: ContractArtifactEnvelope;
  bundle: ContractArtifactEnvelope;
}

export class G2NodeOutputEnvelopeSealError extends Error {
  readonly code = 'g2_node_output_envelope_seal_error';

  constructor(message: string) {
    super(message);
    this.name = 'G2NodeOutputEnvelopeSealError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G2NodeOutputEnvelopeSealError(
      `Successor seal path escapes contracts root: ${relativePath}`,
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
    return value;
  } catch {
    throw new G2NodeOutputEnvelopeSealError(`Expected object: ${label}`);
  }
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new G2NodeOutputEnvelopeSealError(`Expected array: ${label}`);
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') {
    throw new G2NodeOutputEnvelopeSealError(`Expected string: ${label}`);
  }
  return value;
}

function strings(value: JsonValue, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new G2NodeOutputEnvelopeSealError(`Expected string array: ${label}`);
  }
  return value as string[];
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
    throw new G2NodeOutputEnvelopeSealError(`${label} internal hash drift`);
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

function sealedInputRef(caseId: string, kind: 'source' | 'snapshot'): string {
  return `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/inputs/${caseId}.${
    kind === 'snapshot' ? 'snapshot@2' : 'source'
  }.json`;
}

function sealedExpectedRef(originalRef: string): string {
  return `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/expected/${path.basename(originalRef)}`;
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
): string {
  const bytes = fs.readFileSync(absolute(originalRef), 'utf8');
  if (rawHash(bytes) !== identity.raw_bytes_hash) {
    throw new G2NodeOutputEnvelopeSealError(
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
      throw new G2NodeOutputEnvelopeSealError(
        `Expected result hash drift: ${originalRef}`,
      );
    }
  } else if (kind === 'plan') {
    const plan = object(value, 'expected plan');
    semanticHash = domainSeparatedSha256(
      PLAN_DOMAIN,
      withoutField(plan, 'plan_hash'),
    );
    if (plan.plan_hash !== semanticHash) {
      throw new G2NodeOutputEnvelopeSealError(
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
    throw new G2NodeOutputEnvelopeSealError(
      `Expected ${kind} semantic drift: ${originalRef}`,
    );
  }
  return bytes;
}

function inventoryEntry(
  artifactPath: string,
  kind: CurrentG2SealedInventoryEntry['kind'],
  caseId: string | null,
  originalRef: string | null,
  bytes: string | Uint8Array,
  semanticHash: Sha256Hash,
  domainSeparator: string,
): CurrentG2SealedInventoryEntry {
  return {
    path: artifactPath,
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
  report: ContractArtifactEnvelope;
  review: ContractArtifactEnvelope;
} {
  const draft = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF);
  const draftCases = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_CASES_REF);
  const draftInventory = readArtifact(G2_NODE_OUTPUT_ENVELOPE_DRAFT_INVENTORY_REF);
  const report = readArtifact(G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF);
  const review = readArtifact(G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF);
  const checkedReview = checkG2NodeOutputEnvelopeSemanticReview();
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
  requireInternalHash(
    review.payload,
    'review_hash',
    SEMANTIC_REVIEW_DOMAIN,
    String(review.payload.review_hash),
    'Successor GoldenSemanticReview',
  );
  const caseIds = strings(review.payload.case_ids, 'approved case ids');
  if (
    draft.hash !== DRAFT_ARTIFACT_HASH ||
    report.hash !== REVIEW_REPORT_ARTIFACT_HASH ||
    checkedReview.hash !== review.hash ||
    draft.payload.cases_hash !== draftCases.hash ||
    draft.payload.inventory_hash !== draftInventory.hash ||
    report.payload.draft_manifest_hash !==
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH ||
    review.payload.draft_manifest_hash !==
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH ||
    review.payload.golden_review_report_hash !==
      G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH ||
    review.payload.draft_artifact_hash !== draft.hash ||
    review.payload.golden_review_report_artifact_hash !== report.hash ||
    review.payload.reviewer_actor_ref !== 'human:local-owner' ||
    review.payload.decision !== 'approved' ||
    review.payload.case_count !== 40 ||
    caseIds.length !== 40 ||
    new Set(caseIds).size !== 40 ||
    review.payload.signature_policy !== 'not_required_local_single_user'
  ) {
    throw new G2NodeOutputEnvelopeSealError(
      'Successor seal requires the exact complete approved review chain',
    );
  }
  return { draft, draftCases, report, review };
}

export function buildG2NodeOutputEnvelopeSeal(): G2NodeOutputEnvelopeSealBuild {
  const { draft, draftCases, report, review } = validateApprovalChain();
  const files = new Map<string, string>();
  const entries: CurrentG2SealedInventoryEntry[] = [];
  const sealedCases: CurrentG2SealedCase[] = [];
  const reviewedCaseIds = strings(review.payload.case_ids, 'approved case ids');
  const cases = objects(draftCases.payload.cases, 'Draft cases')
    .slice()
    .sort((left, right) =>
      String(left.case_id).localeCompare(String(right.case_id)),
    );
  if (
    JSON.stringify(reviewedCaseIds) !==
    JSON.stringify(cases.map((entry) => String(entry.case_id)))
  ) {
    throw new G2NodeOutputEnvelopeSealError(
      'Successor seal review coverage is partial, stale, or reordered',
    );
  }

  let compiledCount = 0;
  let rejectedCount = 0;
  for (const draftCase of cases) {
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
      throw new G2NodeOutputEnvelopeSealError(`Raw source is not UTF-8: ${caseId}`);
    }
    const sourceSemanticHash = domainSeparatedSha256(
      RAW_SOURCE_DOMAIN,
      sourceText,
    );
    if (
      rawHash(sourceBytes) !== sourceBinding.raw_source_file_hash ||
      sourceSemanticHash !== sourceBinding.raw_source_bytes_hash
    ) {
      throw new G2NodeOutputEnvelopeSealError(`Raw source identity drift: ${caseId}`);
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
      throw new G2NodeOutputEnvelopeSealError(
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
    const resultBytes = validateExpectedContent(
      resultOriginalRef,
      resultIdentity,
      'result',
    );
    const sealedResultRef = sealedExpectedRef(resultOriginalRef);
    files.set(sealedResultRef, resultBytes);
    entries.push(
      inventoryEntry(
        sealedResultRef,
        'expected_result',
        caseId,
        resultOriginalRef,
        resultBytes,
        string(
          resultIdentity.semantic_hash,
          'result semantic hash',
        ) as Sha256Hash,
        RESULT_DOMAIN,
      ),
    );

    const outcome = string(draftCase.outcome, 'outcome') as
      | 'compiled'
      | 'rejected';
    let plan: CurrentG2SealedContentIdentity | null = null;
    let proofs: CurrentG2SealedContentIdentity | null = null;
    let programs: CurrentG2SealedContentIdentity | null = null;
    if (outcome === 'compiled') {
      compiledCount += 1;
      const identities = new Map<string, CurrentG2SealedContentIdentity>();
      for (const [field, kind, inventoryKind] of [
        ['expected_plan', 'plan', 'expected_plan'],
        ['expected_proofs', 'proofs', 'expected_proofs'],
        ['expected_programs', 'programs', 'expected_programs'],
      ] as const) {
        const identity = object(draftCase[field], `${field} identity`);
        const originalRef = string(identity.path, `${field} ref`);
        const bytes = validateExpectedContent(originalRef, identity, kind);
        const sealedRef = sealedExpectedRef(originalRef);
        files.set(sealedRef, bytes);
        entries.push(
          inventoryEntry(
            sealedRef,
            inventoryKind,
            caseId,
            originalRef,
            bytes,
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
          throw new G2NodeOutputEnvelopeSealError(
            `Rejected case contains compiled support: ${caseId}`,
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
      approved_review_ref: G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF,
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
    throw new G2NodeOutputEnvelopeSealError(
      'Successor seal expected coverage is incomplete',
    );
  }

  const bundleSchema = artifact(
    'icarus.workflow-compiler-conformance-bundle-schema/1',
    'icarus.workflow-compiler-conformance-bundle-schema.g2-generated-schema-join-authority-v6',
    BUNDLE_SCHEMA_DOMAIN,
    G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA,
  );
  const inventorySchema = artifact(
    'icarus.workflow-compiler-conformance-inventory-schema/1',
    'icarus.workflow-compiler-conformance-inventory-schema.g2-generated-schema-join-authority-v6',
    INVENTORY_SCHEMA_DOMAIN,
    G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA,
  );
  for (const [schemaRef, schemaArtifact] of [
    [G2_NODE_OUTPUT_ENVELOPE_SEALED_BUNDLE_SCHEMA_REF, bundleSchema],
    [G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA_REF, inventorySchema],
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

  const inventoryWithoutHash = {
    format: 'icarus.workflow-compiler-conformance-inventory/1',
    gate: 'G2',
    bundle_version: '2.0.0',
    inventory_scope: 'all_sealed_leaf_artifacts_excluding_inventory_and_bundle',
    entry_count: entries.length,
    entries,
  };
  const inventoryPayload = {
    ...inventoryWithoutHash,
    inventory_hash: domainSeparatedSha256(
      INVENTORY_DOMAIN,
      inventoryWithoutHash,
    ),
  };
  const validateInventory = new Ajv2020({
    strict: true,
    allErrors: true,
  }).compile(G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_SCHEMA as AnySchema);
  if (!validateInventory(inventoryPayload)) {
    throw new G2NodeOutputEnvelopeSealError(
      `Successor inventory failed closed schema: ${JSON.stringify(validateInventory.errors)}`,
    );
  }
  const inventory = artifact(
    'icarus.workflow-compiler-conformance-inventory/1',
    'icarus.workflow-compiler-conformance-inventory.g2-generated-schema-join-authority-v6',
    INVENTORY_ARTIFACT_DOMAIN,
    inventoryPayload,
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_REF, render(inventory));

  const exactIdentity = object(
    draft.payload.exact_compiler_identity,
    'exact compiler identity',
  );
  const bundleWithoutHash = {
    format: 'icarus.workflow-compiler-conformance/1',
    gate: 'G2',
    construction_phase: 'RC_REVIEW',
    bundle_version: '2.0.0',
    bundle_status: 'sealed_pending_ci_replay',
    publishable: false,
    production_reachable: false,
    toolchain_manifest_ref: clone(
      object(exactIdentity.compiler_toolchain_manifest_ref, 'toolchain ref'),
    ),
    toolchain_hash: string(
      exactIdentity.compiler_toolchain_hash,
      'toolchain hash',
    ),
    error_catalog_ref: clone(
      object(exactIdentity.error_catalog_ref, 'error catalog ref'),
    ),
    error_catalog_hash: string(
      exactIdentity.error_catalog_hash,
      'error catalog hash',
    ),
    exact_compiler_identity: clone(exactIdentity),
    draft_manifest_ref: G2_NODE_OUTPUT_ENVELOPE_DRAFT_MANIFEST_REF,
    draft_manifest_hash: G2_NODE_OUTPUT_ENVELOPE_APPROVED_DRAFT_MANIFEST_HASH,
    draft_artifact_hash: draft.hash,
    golden_review_report_ref: G2_NODE_OUTPUT_ENVELOPE_REVIEW_REPORT_REF,
    golden_review_report_hash: G2_NODE_OUTPUT_ENVELOPE_APPROVED_REVIEW_REPORT_HASH,
    golden_review_report_artifact_hash: report.hash,
    golden_semantic_review_ref: G2_NODE_OUTPUT_ENVELOPE_SEMANTIC_REVIEW_REF,
    golden_semantic_review_hash: string(
      review.payload.review_hash,
      'semantic review hash',
    ),
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
    inventory_ref: G2_NODE_OUTPUT_ENVELOPE_SEALED_INVENTORY_REF,
    inventory_hash: inventory.hash,
    sealed_artifact_count: files.size + 1,
    ci_replay_status: 'not_run_at_seal_time',
    g3_through_g9_status: 'not_started',
  };
  const bundlePayload = {
    ...bundleWithoutHash,
    bundle_hash: domainSeparatedSha256(BUNDLE_DOMAIN, bundleWithoutHash),
  };
  const validateBundle = new Ajv2020({
    strict: true,
    allErrors: true,
  }).compile(G2_NODE_OUTPUT_ENVELOPE_CONFORMANCE_BUNDLE_SCHEMA as AnySchema);
  if (!validateBundle(bundlePayload)) {
    throw new G2NodeOutputEnvelopeSealError(
      `Successor bundle failed closed schema: ${JSON.stringify(validateBundle.errors)}`,
    );
  }
  const bundle = artifact(
    'icarus.workflow-compiler-conformance/1',
    'icarus.workflow-compiler-conformance.g2-generated-schema-join-authority-v6',
    BUNDLE_ARTIFACT_DOMAIN,
    bundlePayload,
  );
  files.set(G2_NODE_OUTPUT_ENVELOPE_SEALED_BUNDLE_REF, render(bundle));
  if (files.size !== 157 || entries.length !== 155) {
    throw new G2NodeOutputEnvelopeSealError(
      `Successor seal artifact count drift: files=${files.size} leaves=${entries.length}`,
    );
  }
  return { files, inventory, bundle };
}

function relativeWithinSeal(repositoryPath: string): string {
  const prefix = `${G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT}/`;
  if (!repositoryPath.startsWith(prefix)) {
    throw new G2NodeOutputEnvelopeSealError(
      `Seal output escapes immutable root: ${repositoryPath}`,
    );
  }
  return repositoryPath.slice(prefix.length);
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        throw new G2NodeOutputEnvelopeSealError(
          'Successor sealed tree contains a symlink',
        );
      }
      if (stat.isDirectory()) visit(entry);
      else files.push(path.relative(root, entry).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function checkFiles(root: string, files: Map<string, string>): void {
  const expected = [...files.keys()].map(relativeWithinSeal).sort();
  if (JSON.stringify(listTree(root)) !== JSON.stringify(expected)) {
    throw new G2NodeOutputEnvelopeSealError(
      'Successor sealed immutable inventory conflict',
    );
  }
  for (const [repositoryPath, bytes] of files) {
    if (
      fs.readFileSync(
        path.join(root, relativeWithinSeal(repositoryPath)),
        'utf8',
      ) !== bytes
    ) {
      throw new G2NodeOutputEnvelopeSealError(
        `Successor sealed bytes drift: ${repositoryPath}`,
      );
    }
  }
}

export function generateG2NodeOutputEnvelopeSeal(): ContractArtifactEnvelope {
  const built = buildG2NodeOutputEnvelopeSeal();
  const root = absolute(G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT);
  if (fs.existsSync(root)) {
    checkFiles(root, built.files);
    return built.bundle;
  }
  if (
    assertCurrentG2SealedBoundary(absolute('conformance/sealed')) !==
    'current_g2'
  ) {
    throw new G2NodeOutputEnvelopeSealError(
      'Successor seal requires the immutable predecessor sealed boundary',
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
  assertCurrentG2SealedBoundary(absolute('conformance/sealed'));
  return built.bundle;
}

export function checkG2NodeOutputEnvelopeSeal(): ContractArtifactEnvelope {
  assertCurrentG2SealedBoundary(absolute('conformance/sealed'));
  const built = buildG2NodeOutputEnvelopeSeal();
  checkFiles(absolute(G2_NODE_OUTPUT_ENVELOPE_SEALED_ROOT), built.files);
  return built.bundle;
}
