import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  COMPILER_ERROR_CATALOG_ENTRIES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import {
  artifactDescriptor,
  buildGoldenDraftArtifact,
  buildGoldenDraftSchemaArtifacts,
  GOLDEN_DRAFT_SCHEMA_DESCRIPTORS,
  GOLDEN_DRAFT_SCHEMA_FORMAT_BY_TARGET,
} from './golden-draft-artifacts.js';
import {
  GOLDEN_DRAFT_NEGATIVE_FIXTURES,
  GOLDEN_DRAFT_POSITIVE_FIXTURES,
} from './golden-draft-fixtures.js';
import {
  buildGoldenDraftInterfaces,
  buildGoldenDraftPolicySnapshot,
  buildGoldenDraftRegistryResources,
  GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE,
  GOLDEN_DRAFT_CASE_SEEDS,
  GOLDEN_DRAFT_POSITIVE_COVERAGE,
  type GoldenDraftCaseSeed,
} from './golden-draft-source.js';
import {
  GOLDEN_DRAFT_ASSERTION_KEYS,
  GOLDEN_DRAFT_CASE_CATALOG_KEYS,
  GOLDEN_DRAFT_CASE_KEYS,
  GOLDEN_DRAFT_DIAGNOSTIC_KEYS,
  GOLDEN_DRAFT_INPUT_SNAPSHOT_KEYS,
  GOLDEN_DRAFT_MANIFEST_KEYS,
  GOLDEN_DRAFT_REVIEW_REPORT_INPUT_KEYS,
  GOLDEN_DRAFT_REVIEW_REQUEST_KEYS,
  type GoldenDraftCase,
  type GoldenDraftCaseCatalog,
  type GoldenDraftCompilerInputSnapshot,
  type GoldenDraftFixtureMutation,
  type GoldenDraftManifest,
  type GoldenDraftNegativeFixture,
  type GoldenDraftReviewReportInput,
  type GoldenDraftReviewRequest,
} from './golden-draft-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { LOCAL_SINGLE_USER_SAFETY_PROFILE } from './safety-sqlite-types.js';
import {
  assertJsonObject,
  strictParseJson,
  strictParseJsonBytes,
} from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');
const priorManifestHashes = {
  foundation_manifest_hash:
    'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
  closed_schema_manifest_hash:
    'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
  catalog_protocol_manifest_hash:
    'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
  safety_sqlite_manifest_hash:
    'sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428',
  logical_schema_manifest_hash:
    'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520',
  static_absence_manifest_hash:
    'sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2',
} as const;

const priorManifestPaths = {
  foundation_manifest_hash: 'contract-pack-foundation.json',
  closed_schema_manifest_hash: 'contract-pack-closed-schemas.json',
  catalog_protocol_manifest_hash: 'contract-pack-catalog-protocols.json',
  safety_sqlite_manifest_hash: 'contract-pack-safety-sqlite.json',
  logical_schema_manifest_hash: 'contract-pack-logical-schema.json',
  static_absence_manifest_hash: 'contract-pack-static-absence.json',
} as const;

const manifestPath = 'contract-pack-golden-draft.json';
const caseCatalogPath = 'conformance/draft/golden-draft-cases@1.json';
const draftManifestPath = 'conformance/draft/golden-draft-manifest@1.json';
const reviewRequestPath = 'conformance/draft/golden-review-request@1.json';
const reviewReportInputPath =
  'conformance/draft/golden-review-report-input@1.json';
const baseSnapshotPath = 'conformance/draft/snapshots/complete-base@1.json';
const integritySnapshotPath =
  'conformance/draft/snapshots/compiler-integrity-mismatch@1.json';
const positiveFixturesPath =
  'conformance/draft/contract-fixtures/positive-cases.json';
const negativeFixturesPath =
  'conformance/draft/contract-fixtures/negative-cases.json';
const domainCatalogPath = 'catalogs/golden-draft-domain-separators.json';
const toolchainInputsPath = 'toolchain/compiler-toolchain-inputs.json';
const errorCatalogPath = 'catalogs/workflow-compiler-error-catalog.json';
const safetyProfilePath = 'safety/local_single_user_safety@1.json';

const allowedReviewOperations = [
  'domain_hash',
  'generic_jcs',
  'render_diagnostics',
  'render_semantic_assertions',
  'strict_parse',
] as const;
const forbiddenModuleClasses = [
  'assignability_proof',
  'definition_lowerer',
  'plan_normalizer',
  'production_compiler',
] as const;
const goldenDraftToolSourceFiles = [
  'golden-draft-artifacts.ts',
  'golden-draft-fixtures.ts',
  'golden-draft-pack.ts',
  'golden-draft-source.ts',
  'golden-draft-types.ts',
] as const;

export class GoldenDraftContractError extends Error {
  readonly code = 'golden_draft_contract_drift';

  constructor(message: string) {
    super(message);
    this.name = 'GoldenDraftContractError';
  }
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function absoluteContractPath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new GoldenDraftContractError(
      `Contract path escapes root: ${relativePath}`,
    );
  }
  return absolute;
}

function renderJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, contents: string): void {
  const absolute = absoluteContractPath(relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, absolute);
}

function assertExpectedBytes(relativePath: string, expected: string): void {
  const actual = fs.readFileSync(absoluteContractPath(relativePath), 'utf8');
  if (actual !== expected) {
    throw new GoldenDraftContractError(
      `${relativePath} is not generated byte-for-byte; run npm run contracts:generate`,
    );
  }
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absoluteContractPath(relativePath))),
  );
}

function readJsonObject(relativePath: string): JsonObject {
  const value = strictParseJsonBytes(
    fs.readFileSync(absoluteContractPath(relativePath)),
  );
  assertJsonObject(value);
  return value;
}

function rawBytesHash(source: string): Sha256Hash {
  return `sha256:${crypto
    .createHash('sha256')
    .update('icarus:workflow-golden-draft-raw-source-bytes:1\n', 'ascii')
    .update(source, 'utf8')
    .digest('hex')}`;
}

function draftGeneratorToolHash(): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-golden-draft-generator-tool:1\n',
    goldenDraftToolSourceFiles.map((relativePath) => ({
      path: relativePath,
      source_hash: rawBytesHash(
        fs.readFileSync(absoluteContractPath(relativePath), 'utf8'),
      ),
    })),
  );
}

function sourceHash(seed: GoldenDraftCaseSeed): Sha256Hash | null {
  try {
    const parsed = strictParseJson(seed.raw_source_text);
    const domains = {
      graph_scope: 'icarus:workflow-graph-source:1\n',
      workflow_definition: 'icarus:workflow-definition-source:1\n',
      workflow_schema: 'icarus:workflow-schema-source:1\n',
    } as const;
    return domainSeparatedSha256(domains[seed.source_kind], parsed);
  } catch {
    return null;
  }
}

function rawSourcePath(caseId: string): string {
  return `conformance/draft/cases/${caseId}/source.json`;
}

function withHash(
  domain: string,
  payload: JsonObject,
  hashField: string,
): JsonObject {
  const withoutHash = { ...payload };
  delete withoutHash[hashField];
  return {
    ...withoutHash,
    [hashField]: domainSeparatedSha256(domain, withoutHash),
  };
}

function buildSnapshotPayload(
  snapshotId: 'complete-base' | 'compiler-integrity-mismatch',
): GoldenDraftCompilerInputSnapshot {
  const toolchainInputs = readJsonObject(toolchainInputsPath);
  const errorCatalog = readArtifact(errorCatalogPath);
  const safetyArtifact = readArtifact(safetyProfilePath);
  const graphScopeSchema = readArtifact(
    'schemas/graph-scope-source-schema.json',
  );
  const resources = buildGoldenDraftRegistryResources(graphScopeSchema.payload);
  const interfaces = buildGoldenDraftInterfaces();
  const completePolicy = buildGoldenDraftPolicySnapshot();
  const registryHash = domainSeparatedSha256(
    'icarus:workflow-golden-draft-registry-snapshot:1\n',
    resources,
  );
  const interfaceHash = domainSeparatedSha256(
    'icarus:workflow-golden-draft-interface-snapshot:1\n',
    interfaces,
  );
  const policyHash = domainSeparatedSha256(
    'icarus:workflow-golden-draft-complete-policy-snapshot:1\n',
    completePolicy,
  );
  const strictParserSource = fs.readFileSync(
    absoluteContractPath('strict-json.ts'),
    'utf8',
  );
  const payload: JsonObject = {
    format: 'icarus.workflow-compiler-input-snapshot/1',
    snapshot_id: snapshotId,
    launchability: 'test_only',
    compiler_identity: {
      toolchain_inputs_ref: toolchainInputsPath,
      toolchain_inputs_hash: String(toolchainInputs.identity_hash),
      error_catalog_ref: errorCatalog.ref,
      error_catalog_hash: errorCatalog.hash,
      strict_parser_wrapper_hash: rawBytesHash(strictParserSource),
      production_compiler_status: 'absent',
      canonical_normalizer_status: 'absent',
      proof_algorithm_status: 'absent',
      identity_match: snapshotId === 'complete-base',
    },
    registry_snapshot: {
      snapshot_ref: `test-only:registry:${snapshotId}@1`,
      snapshot_hash: registryHash,
      resource_count: resources.length,
      resources,
    },
    interface_snapshot: {
      snapshot_ref: `test-only:interfaces:${snapshotId}@1`,
      snapshot_hash: interfaceHash,
      interfaces,
    },
    policy_snapshot: {
      snapshot_ref: `test-only:policy:${snapshotId}@1`,
      snapshot_hash: policyHash,
      complete_policy: completePolicy,
    },
    safety_snapshot: {
      ...LOCAL_SINGLE_USER_SAFETY_PROFILE,
      source_artifact_ref: safetyProfilePath,
      source_artifact_hash: safetyArtifact.hash,
    },
    snapshot_hash: `sha256:${'0'.repeat(64)}`,
  };
  return withHash(
    'icarus:workflow-compiler-input-snapshot-payload:1\n',
    payload,
    'snapshot_hash',
  ) as GoldenDraftCompilerInputSnapshot;
}

function buildSnapshotArtifacts(): Array<
  [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
> {
  const snapshots: Array<[string, GoldenDraftCompilerInputSnapshot]> = [
    [baseSnapshotPath, buildSnapshotPayload('complete-base')],
    [
      integritySnapshotPath,
      buildSnapshotPayload('compiler-integrity-mismatch'),
    ],
  ];
  return snapshots.map(([relativePath, payload]) => [
    relativePath,
    buildGoldenDraftArtifact(
      'icarus.workflow-compiler-input-snapshot/1',
      `icarus.workflow-compiler-input-snapshot.${payload.snapshot_id}`,
      'icarus:workflow-compiler-input-snapshot-artifact:1\n',
      payload,
    ) as ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>,
  ]);
}

function buildCases(
  snapshots: Array<
    [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
  >,
): GoldenDraftCase[] {
  const snapshotById = new Map(
    snapshots.map(([relativePath, artifact]) => [
      artifact.payload.snapshot_id,
      { relativePath, hash: artifact.hash },
    ]),
  );
  return GOLDEN_DRAFT_CASE_SEEDS.map((seed) => {
    const snapshot = snapshotById.get(seed.input_snapshot_id);
    if (!snapshot) {
      throw new GoldenDraftContractError(
        `Missing input snapshot for ${seed.case_id}`,
      );
    }
    return {
      case_id: seed.case_id,
      polarity: seed.polarity,
      source_kind: seed.source_kind,
      coverage_tags: [...seed.coverage_tags].sort(asciiCompare),
      raw_source_bytes_ref: rawSourcePath(seed.case_id),
      raw_source_bytes_hash: rawBytesHash(seed.raw_source_text),
      input_snapshot_ref: snapshot.relativePath,
      input_snapshot_hash: snapshot.hash,
      expected_source_hash: sourceHash(seed),
      expected_plan_bytes_ref: null,
      expected_plan_hash: null,
      expected_proof_hashes: null,
      expected_program_hashes: null,
      expected_diagnostics: seed.expected_diagnostics,
      normalized_semantic_assertions: seed.assertions,
      review_status: 'pending_human_review',
      authored_by: 'codex:draft-author',
    };
  });
}

function buildCaseCatalogArtifact(
  snapshots: Array<
    [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
  >,
): ContractArtifactEnvelope<GoldenDraftCaseCatalog> {
  const cases = buildCases(snapshots);
  const payload = withHash(
    'icarus:workflow-compiler-golden-draft-cases-payload:1\n',
    {
      format: 'icarus.workflow-compiler-golden-draft-cases/1',
      bundle_version: '1.0.0-draft',
      cases,
      positive_case_count: cases.filter(
        (candidate) => candidate.polarity === 'positive',
      ).length,
      negative_case_count: cases.filter(
        (candidate) => candidate.polarity === 'negative',
      ).length,
      catalog_hash: `sha256:${'0'.repeat(64)}`,
    },
    'catalog_hash',
  ) as GoldenDraftCaseCatalog;
  return buildGoldenDraftArtifact(
    payload.format,
    'icarus.workflow-compiler-golden-draft-cases',
    'icarus:workflow-compiler-golden-draft-cases-artifact:1\n',
    payload,
  ) as ContractArtifactEnvelope<GoldenDraftCaseCatalog>;
}

function rawAggregateHash(cases: GoldenDraftCase[]): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-golden-draft-raw-source-aggregate:1\n',
    cases.map((candidate) => ({
      case_id: candidate.case_id,
      raw_source_bytes_ref: candidate.raw_source_bytes_ref,
      raw_source_bytes_hash: candidate.raw_source_bytes_hash,
    })),
  );
}

function snapshotDescriptors(
  snapshots: Array<
    [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
  >,
): Array<{ ref: string; hash: Sha256Hash }> {
  return snapshots.map(([relativePath, artifact]) => ({
    ref: relativePath,
    hash: artifact.hash,
  }));
}

function buildDraftManifestArtifact(
  caseCatalog: ContractArtifactEnvelope<GoldenDraftCaseCatalog>,
  snapshots: Array<
    [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
  >,
): ContractArtifactEnvelope<GoldenDraftManifest> {
  const cases = caseCatalog.payload.cases;
  const payload = withHash(
    'icarus:workflow-compiler-golden-draft-manifest-payload:1\n',
    {
      format: 'icarus.workflow-compiler-golden-draft-manifest/1',
      bundle_version: '1.0.0-draft',
      draft_status: 'candidate_pending_human_review',
      draft_author_actor_ref: 'codex:draft-author',
      review_owner_actor_ref: 'human:local-owner',
      draft_generator_tool_hash: draftGeneratorToolHash(),
      case_catalog_ref: caseCatalogPath,
      case_catalog_hash: caseCatalog.hash,
      input_snapshots: snapshotDescriptors(snapshots),
      raw_source_count: cases.length,
      raw_source_aggregate_hash: rawAggregateHash(cases),
      positive_case_count: caseCatalog.payload.positive_case_count,
      negative_case_count: caseCatalog.payload.negative_case_count,
      positive_coverage: [...GOLDEN_DRAFT_POSITIVE_COVERAGE],
      negative_error_code_coverage: [...WORKFLOW_COMPILER_ERROR_CODES],
      additional_negative_coverage: [
        ...GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE,
      ],
      expected_plan_artifact_status: 'all_null_pending_review',
      expected_proof_program_status: 'all_null_pending_review',
      golden_semantic_review_status: 'absent',
      sealed_bundle_status: 'absent',
      manifest_hash: `sha256:${'0'.repeat(64)}`,
    },
    'manifest_hash',
  ) as GoldenDraftManifest;
  return buildGoldenDraftArtifact(
    payload.format,
    'icarus.workflow-compiler-golden-draft-manifest',
    'icarus:workflow-compiler-golden-draft-manifest-artifact:1\n',
    payload,
  ) as ContractArtifactEnvelope<GoldenDraftManifest>;
}

function buildReviewRequestArtifact(
  draftManifest: ContractArtifactEnvelope<GoldenDraftManifest>,
  caseCatalog: ContractArtifactEnvelope<GoldenDraftCaseCatalog>,
): ContractArtifactEnvelope<GoldenDraftReviewRequest> {
  const payload = withHash(
    'icarus:workflow-golden-review-request-payload:1\n',
    {
      format: 'icarus.workflow-golden-review-request/1',
      review_request_id: 'golden-review-request.g0.8.v1',
      draft_manifest_ref: draftManifestPath,
      draft_manifest_hash: draftManifest.hash,
      requested_reviewer_actor_ref: 'human:local-owner',
      checklist_version: 'golden-semantic-review-checklist@1',
      case_ids: caseCatalog.payload.cases.map((candidate) => candidate.case_id),
      previous_bundle_ref: null,
      previous_bundle_hash: null,
      semantic_decision_status: 'pending',
      approval_record_status: 'absent',
      immutable_request_hash: `sha256:${'0'.repeat(64)}`,
    },
    'immutable_request_hash',
  ) as GoldenDraftReviewRequest;
  return buildGoldenDraftArtifact(
    payload.format,
    'icarus.workflow-golden-review-request.g0.8',
    'icarus:workflow-golden-review-request-artifact:1\n',
    payload,
  ) as ContractArtifactEnvelope<GoldenDraftReviewRequest>;
}

function buildReviewReportInputArtifact(
  reviewRequest: ContractArtifactEnvelope<GoldenDraftReviewRequest>,
  draftManifest: ContractArtifactEnvelope<GoldenDraftManifest>,
  caseCatalog: ContractArtifactEnvelope<GoldenDraftCaseCatalog>,
  snapshots: Array<
    [string, ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>]
  >,
): ContractArtifactEnvelope<GoldenDraftReviewReportInput> {
  const payload = withHash(
    'icarus:workflow-golden-review-report-input-payload:1\n',
    {
      format: 'icarus.workflow-golden-review-report-input/1',
      report_input_id: 'golden-review-report-input.g0.8.v1',
      review_request_ref: reviewRequestPath,
      review_request_hash: reviewRequest.hash,
      draft_manifest_ref: draftManifestPath,
      draft_manifest_hash: draftManifest.hash,
      case_catalog_ref: caseCatalogPath,
      case_catalog_hash: caseCatalog.hash,
      input_snapshots: snapshotDescriptors(snapshots),
      allowed_operations: [...allowedReviewOperations],
      forbidden_module_classes: [...forbiddenModuleClasses],
      report_generation_status: 'not_run',
      semantic_decision_status: 'pending',
      immutable_input_hash: `sha256:${'0'.repeat(64)}`,
    },
    'immutable_input_hash',
  ) as GoldenDraftReviewReportInput;
  return buildGoldenDraftArtifact(
    payload.format,
    'icarus.workflow-golden-review-report-input.g0.8',
    'icarus:workflow-golden-review-report-input-artifact:1\n',
    payload,
  ) as ContractArtifactEnvelope<GoldenDraftReviewReportInput>;
}

function buildFixtureArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  return [
    [
      positiveFixturesPath,
      buildGoldenDraftArtifact(
        'icarus.workflow-golden-draft-positive-fixtures/1',
        'icarus.workflow-golden-draft-positive-fixtures',
        'icarus:workflow-golden-draft-positive-fixtures:1\n',
        { fixtures: [...GOLDEN_DRAFT_POSITIVE_FIXTURES] },
      ),
    ],
    [
      negativeFixturesPath,
      buildGoldenDraftArtifact(
        'icarus.workflow-golden-draft-negative-fixtures/1',
        'icarus.workflow-golden-draft-negative-fixtures',
        'icarus:workflow-golden-draft-negative-fixtures:1\n',
        { fixtures: [...GOLDEN_DRAFT_NEGATIVE_FIXTURES] },
      ),
    ],
  ];
}

function buildDomainCatalog(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const entries = [
    ...new Map(
      artifacts.map(([, artifact]) => [
        artifact.format,
        {
          format: artifact.format,
          domain_separator: artifact.domain_separator,
        },
      ]),
    ).values(),
    {
      format: 'icarus.workflow-golden-draft-domain-separators/1',
      domain_separator: 'icarus:workflow-golden-draft-domain-separators:1\n',
    },
    {
      format: 'icarus.workflow-contract-pack-golden-draft/1',
      domain_separator: 'icarus:workflow-contract-pack-golden-draft:1\n',
    },
  ].sort((left, right) => asciiCompare(left.format, right.format));
  return buildGoldenDraftArtifact(
    'icarus.workflow-golden-draft-domain-separators/1',
    'icarus.workflow-golden-draft-domain-separators',
    'icarus:workflow-golden-draft-domain-separators:1\n',
    { entries },
  );
}

function expectedArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const schemas = buildGoldenDraftSchemaArtifacts();
  const snapshots = buildSnapshotArtifacts();
  const caseCatalog = buildCaseCatalogArtifact(snapshots);
  const draftManifest = buildDraftManifestArtifact(caseCatalog, snapshots);
  const reviewRequest = buildReviewRequestArtifact(draftManifest, caseCatalog);
  const reportInput = buildReviewReportInputArtifact(
    reviewRequest,
    draftManifest,
    caseCatalog,
    snapshots,
  );
  const fixtureArtifacts = buildFixtureArtifacts();
  const artifacts: Array<[string, ContractArtifactEnvelope]> = [
    ...schemas,
    ...snapshots,
    [caseCatalogPath, caseCatalog],
    [draftManifestPath, draftManifest],
    [reviewRequestPath, reviewRequest],
    [reviewReportInputPath, reportInput],
    ...fixtureArtifacts,
  ];
  return [...artifacts, [domainCatalogPath, buildDomainCatalog(artifacts)]];
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const caseCatalog = artifacts.find(
    ([relativePath]) => relativePath === caseCatalogPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftCaseCatalog> | undefined;
  const draftManifest = artifacts.find(
    ([relativePath]) => relativePath === draftManifestPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftManifest> | undefined;
  if (!caseCatalog || !draftManifest) {
    throw new GoldenDraftContractError('Missing G0.8 case or draft manifest');
  }
  return buildGoldenDraftArtifact(
    'icarus.workflow-contract-pack-golden-draft/1',
    'icarus.workflow-contract-pack-golden-draft',
    'icarus:workflow-contract-pack-golden-draft:1\n',
    {
      gate: 'G0.8',
      status: 'golden_draft_and_review_input',
      ...priorManifestHashes,
      generated_by_tool_hash: draftGeneratorToolHash(),
      draft_manifest_hash: draftManifest.hash,
      positive_case_count: caseCatalog.payload.positive_case_count,
      negative_case_count: caseCatalog.payload.negative_case_count,
      compiler_error_code_count: WORKFLOW_COMPILER_ERROR_CODES.length,
      closed_schema_count: GOLDEN_DRAFT_SCHEMA_DESCRIPTORS.length,
      input_snapshot_count: 2,
      review_owner_actor_ref: 'human:local-owner',
      review_request_status: 'pending',
      review_report_status: 'not_generated',
      golden_semantic_review_status: 'absent',
      golden_seal_status: 'not_run',
      sealed_bundle_status: 'absent',
      expected_plan_bytes_status: 'all_null',
      expected_plan_hash_status: 'all_null',
      expected_proof_program_hash_status: 'all_null',
      production_compiler_status: 'absent',
      canonical_normalizer_status: 'absent',
      definition_lowerer_status: 'absent',
      proof_algorithm_status: 'absent',
      executable_ddl_status: 'absent',
      workflow_runtime_store_status: 'absent',
      registry_runtime_status: 'absent',
      runtime_center_ui_status: 'absent',
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      artifacts: artifacts
        .map(([relativePath, artifact]) =>
          artifactDescriptor(relativePath, artifact),
        )
        .sort((left, right) =>
          asciiCompare(String(left.path), String(right.path)),
        ),
    },
  );
}

function assertKeyset(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const left = [...actual].sort(asciiCompare);
  const right = [...expected].sort(asciiCompare);
  if (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  ) {
    throw new GoldenDraftContractError(`${label} keyset drift`);
  }
}

function compileSchemas(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): Map<string, ReturnType<Ajv2020['compile']>> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const validators = new Map<string, ReturnType<Ajv2020['compile']>>();
  for (const descriptor of GOLDEN_DRAFT_SCHEMA_DESCRIPTORS) {
    const artifact = artifacts.find(
      ([relativePath]) => relativePath === descriptor.artifact_path,
    )?.[1];
    if (!artifact) {
      throw new GoldenDraftContractError(
        `Missing G0.8 schema: ${descriptor.artifact_format}`,
      );
    }
    validators.set(
      descriptor.target_format,
      ajv.compile(artifact.payload as AnySchema),
    );
  }
  return validators;
}

function validateTypeScriptSchemaConformance(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): void {
  const expectedByTarget: Record<string, readonly string[]> = {
    'icarus.workflow-compiler-input-snapshot/1':
      GOLDEN_DRAFT_INPUT_SNAPSHOT_KEYS,
    'icarus.workflow-compiler-golden-draft-cases/1':
      GOLDEN_DRAFT_CASE_CATALOG_KEYS,
    'icarus.workflow-compiler-golden-draft-manifest/1':
      GOLDEN_DRAFT_MANIFEST_KEYS,
    'icarus.workflow-golden-review-request/1': GOLDEN_DRAFT_REVIEW_REQUEST_KEYS,
    'icarus.workflow-golden-review-report-input/1':
      GOLDEN_DRAFT_REVIEW_REPORT_INPUT_KEYS,
  };
  for (const descriptor of GOLDEN_DRAFT_SCHEMA_DESCRIPTORS) {
    const artifact = artifacts.find(
      ([relativePath]) => relativePath === descriptor.artifact_path,
    )?.[1];
    const properties = artifact?.payload.properties;
    if (!artifact || !properties || typeof properties !== 'object') {
      throw new GoldenDraftContractError(
        `Schema properties missing for ${descriptor.target_format}`,
      );
    }
    assertKeyset(
      Object.keys(properties),
      expectedByTarget[descriptor.target_format] ?? [],
      descriptor.target_format,
    );
    assertKeyset(
      artifact.payload.required as string[],
      expectedByTarget[descriptor.target_format] ?? [],
      `${descriptor.target_format} required`,
    );
  }
}

function validatePriorIdentity(): void {
  for (const [key, expectedHash] of Object.entries(priorManifestHashes)) {
    const relativePath =
      priorManifestPaths[key as keyof typeof priorManifestPaths];
    if (readArtifact(relativePath).hash !== expectedHash) {
      throw new GoldenDraftContractError(
        `Prior Contract Pack identity drift: ${relativePath}`,
      );
    }
  }
}

function diagnosticCompare(
  left: GoldenDraftCase['expected_diagnostics'][number],
  right: GoldenDraftCase['expected_diagnostics'][number],
): number {
  const values = [
    [left.instance_pointer, right.instance_pointer],
    [left.code, right.code],
    [left.stable_object_id ?? '', right.stable_object_id ?? ''],
    [left.schema_pointer ?? '', right.schema_pointer ?? ''],
  ];
  for (const [a, b] of values) {
    const compared = asciiCompare(a, b);
    if (compared !== 0) return compared;
  }
  return 0;
}

function validateCases(
  caseCatalog: ContractArtifactEnvelope<GoldenDraftCaseCatalog>,
  snapshots: Map<string, ContractArtifactEnvelope>,
): void {
  const { cases } = caseCatalog.payload;
  if (
    cases.length !== 40 ||
    caseCatalog.payload.positive_case_count !== 10 ||
    caseCatalog.payload.negative_case_count !== 30
  ) {
    throw new GoldenDraftContractError('G0.8 case count drift');
  }
  if (
    new Set(cases.map((candidate) => candidate.case_id)).size !== cases.length
  ) {
    throw new GoldenDraftContractError('Duplicate G0.8 case id');
  }
  const phases = new Map(
    COMPILER_ERROR_CATALOG_ENTRIES.map((entry) => [
      entry.code,
      entry.default_phase,
    ]),
  );
  for (const candidate of cases) {
    assertKeyset(
      Object.keys(candidate),
      GOLDEN_DRAFT_CASE_KEYS,
      candidate.case_id,
    );
    for (const diagnostic of candidate.expected_diagnostics) {
      assertKeyset(
        Object.keys(diagnostic),
        GOLDEN_DRAFT_DIAGNOSTIC_KEYS,
        `${candidate.case_id} diagnostic`,
      );
      if (phases.get(diagnostic.code) !== diagnostic.phase) {
        throw new GoldenDraftContractError(
          `Diagnostic phase drift: ${candidate.case_id}`,
        );
      }
    }
    for (const semanticAssertion of candidate.normalized_semantic_assertions) {
      assertKeyset(
        Object.keys(semanticAssertion),
        GOLDEN_DRAFT_ASSERTION_KEYS,
        `${candidate.case_id} assertion`,
      );
    }
    if (
      candidate.expected_plan_bytes_ref !== null ||
      candidate.expected_plan_hash !== null ||
      candidate.expected_proof_hashes !== null ||
      candidate.expected_program_hashes !== null ||
      candidate.review_status !== 'pending_human_review'
    ) {
      throw new GoldenDraftContractError(
        `Reviewed expected artifact or approval forged: ${candidate.case_id}`,
      );
    }
    if (
      (candidate.polarity === 'positive' &&
        candidate.expected_diagnostics.length !== 0) ||
      (candidate.polarity === 'negative' &&
        candidate.expected_diagnostics.length === 0)
    ) {
      throw new GoldenDraftContractError(
        `Diagnostic polarity drift: ${candidate.case_id}`,
      );
    }
    const sortedDiagnostics = [...candidate.expected_diagnostics].sort(
      diagnosticCompare,
    );
    if (
      canonicalJson(sortedDiagnostics) !==
      canonicalJson(candidate.expected_diagnostics)
    ) {
      throw new GoldenDraftContractError(
        `Diagnostic order drift: ${candidate.case_id}`,
      );
    }
    const seed = GOLDEN_DRAFT_CASE_SEEDS.find(
      (entry) => entry.case_id === candidate.case_id,
    );
    if (
      !seed ||
      candidate.raw_source_bytes_hash !== rawBytesHash(seed.raw_source_text) ||
      candidate.expected_source_hash !== sourceHash(seed)
    ) {
      throw new GoldenDraftContractError(
        `Raw source hash drift: ${candidate.case_id}`,
      );
    }
    const snapshot = snapshots.get(candidate.input_snapshot_ref);
    if (!snapshot || snapshot.hash !== candidate.input_snapshot_hash) {
      throw new GoldenDraftContractError(
        `Input snapshot drift: ${candidate.case_id}`,
      );
    }
  }
  const positiveCoverage = new Set(
    cases
      .filter((candidate) => candidate.polarity === 'positive')
      .flatMap((candidate) => candidate.coverage_tags),
  );
  for (const required of GOLDEN_DRAFT_POSITIVE_COVERAGE) {
    if (!positiveCoverage.has(required)) {
      throw new GoldenDraftContractError(
        `Missing positive coverage: ${required}`,
      );
    }
  }
  const negativeCodes = new Set(
    cases
      .filter((candidate) => candidate.polarity === 'negative')
      .flatMap((candidate) =>
        candidate.expected_diagnostics.map((diagnostic) => diagnostic.code),
      ),
  );
  for (const required of WORKFLOW_COMPILER_ERROR_CODES) {
    if (!negativeCodes.has(required)) {
      throw new GoldenDraftContractError(`Missing error coverage: ${required}`);
    }
  }
  const allTags = new Set(
    cases.flatMap((candidate) => candidate.coverage_tags),
  );
  for (const required of GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE) {
    if (!allTags.has(required)) {
      throw new GoldenDraftContractError(
        `Missing additional negative coverage: ${required}`,
      );
    }
  }
}

function validateRawAuthoringSchemas(
  caseCatalog: ContractArtifactEnvelope<GoldenDraftCaseCatalog>,
): void {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const graph = ajv.compile(
    readArtifact('schemas/graph-scope-source-schema.json').payload as AnySchema,
  );
  const definition = ajv.compile(
    readArtifact('schemas/workflow-definition-schema.json')
      .payload as AnySchema,
  );
  for (const candidate of caseCatalog.payload.cases) {
    if (candidate.source_kind === 'workflow_schema') continue;
    const seed = GOLDEN_DRAFT_CASE_SEEDS.find(
      (entry) => entry.case_id === candidate.case_id,
    );
    if (!seed) {
      throw new GoldenDraftContractError(
        `Missing raw source seed: ${candidate.case_id}`,
      );
    }
    let parsed: JsonValue;
    try {
      parsed = strictParseJson(seed.raw_source_text);
    } catch {
      if (candidate.expected_diagnostics[0]?.phase !== 'parse') {
        throw new GoldenDraftContractError(
          `Unexpected parse failure: ${candidate.case_id}`,
        );
      }
      continue;
    }
    const validate =
      candidate.source_kind === 'workflow_definition' ? definition : graph;
    const valid = validate(parsed);
    const primary = candidate.expected_diagnostics[0];
    if (candidate.polarity === 'positive' && !valid) {
      throw new GoldenDraftContractError(
        `Positive raw source failed its closed schema: ${candidate.case_id}`,
      );
    }
    if (
      candidate.polarity === 'negative' &&
      primary?.code === 'schema_unknown_field' &&
      valid
    ) {
      throw new GoldenDraftContractError(
        `Unknown-field negative unexpectedly passed schema: ${candidate.case_id}`,
      );
    }
    if (
      candidate.polarity === 'negative' &&
      primary &&
      !['parse', 'schema'].includes(primary.phase) &&
      primary.code !== 'registry_ref_unpinned' &&
      !valid
    ) {
      throw new GoldenDraftContractError(
        `Semantic negative failed before ${primary.phase}: ${candidate.case_id}`,
      );
    }
  }
}

function validateSnapshotPayload(
  artifact: ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>,
): void {
  const payload = artifact.payload;
  assertKeyset(
    Object.keys(payload),
    GOLDEN_DRAFT_INPUT_SNAPSHOT_KEYS,
    payload.snapshot_id,
  );
  const resources = payload.registry_snapshot.resources;
  const interfaces = payload.interface_snapshot.interfaces;
  const policy = payload.policy_snapshot.complete_policy;
  const safety = payload.safety_snapshot;
  if (
    payload.launchability !== 'test_only' ||
    !Array.isArray(resources) ||
    resources.length < 20 ||
    !Array.isArray(interfaces) ||
    interfaces.length !== 2 ||
    !policy ||
    !safety ||
    safety.profile_id !== 'local_single_user_safety@1' ||
    payload.compiler_identity.production_compiler_status !== 'absent' ||
    payload.compiler_identity.canonical_normalizer_status !== 'absent' ||
    payload.compiler_identity.proof_algorithm_status !== 'absent'
  ) {
    throw new GoldenDraftContractError(
      `Incomplete G0.8 input snapshot: ${payload.snapshot_id}`,
    );
  }
}

function validateSemanticArtifacts(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): void {
  const caseCatalog = artifacts.find(
    ([relativePath]) => relativePath === caseCatalogPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftCaseCatalog> | undefined;
  const draftManifest = artifacts.find(
    ([relativePath]) => relativePath === draftManifestPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftManifest> | undefined;
  const reviewRequest = artifacts.find(
    ([relativePath]) => relativePath === reviewRequestPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftReviewRequest> | undefined;
  const reportInput = artifacts.find(
    ([relativePath]) => relativePath === reviewReportInputPath,
  )?.[1] as ContractArtifactEnvelope<GoldenDraftReviewReportInput> | undefined;
  const snapshots = new Map(
    artifacts.filter(([relativePath]) =>
      [baseSnapshotPath, integritySnapshotPath].includes(relativePath),
    ),
  );
  if (!caseCatalog || !draftManifest || !reviewRequest || !reportInput) {
    throw new GoldenDraftContractError('Missing G0.8 Draft/Review artifact');
  }
  assertKeyset(
    Object.keys(caseCatalog.payload),
    GOLDEN_DRAFT_CASE_CATALOG_KEYS,
    'case catalog',
  );
  validateCases(caseCatalog, snapshots);
  validateRawAuthoringSchemas(caseCatalog);
  for (const snapshot of snapshots.values()) {
    validateSnapshotPayload(
      snapshot as ContractArtifactEnvelope<GoldenDraftCompilerInputSnapshot>,
    );
  }
  assertKeyset(
    Object.keys(draftManifest.payload),
    GOLDEN_DRAFT_MANIFEST_KEYS,
    'draft manifest',
  );
  assertKeyset(
    Object.keys(reviewRequest.payload),
    GOLDEN_DRAFT_REVIEW_REQUEST_KEYS,
    'review request',
  );
  assertKeyset(
    Object.keys(reportInput.payload),
    GOLDEN_DRAFT_REVIEW_REPORT_INPUT_KEYS,
    'review report input',
  );
  if (
    draftManifest.payload.review_owner_actor_ref !== 'human:local-owner' ||
    draftManifest.payload.golden_semantic_review_status !== 'absent' ||
    draftManifest.payload.sealed_bundle_status !== 'absent' ||
    reviewRequest.payload.draft_manifest_hash !== draftManifest.hash ||
    reviewRequest.payload.semantic_decision_status !== 'pending' ||
    reviewRequest.payload.approval_record_status !== 'absent' ||
    reportInput.payload.review_request_hash !== reviewRequest.hash ||
    reportInput.payload.draft_manifest_hash !== draftManifest.hash ||
    reportInput.payload.report_generation_status !== 'not_run' ||
    reportInput.payload.semantic_decision_status !== 'pending' ||
    canonicalJson(reportInput.payload.allowed_operations) !==
      canonicalJson([...allowedReviewOperations]) ||
    canonicalJson(reportInput.payload.forbidden_module_classes) !==
      canonicalJson([...forbiddenModuleClasses])
  ) {
    throw new GoldenDraftContractError('G0.8 review boundary drift');
  }
}

function validateSchemas(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): void {
  const validators = compileSchemas(artifacts);
  for (const [relativePath, artifact] of artifacts) {
    const validator = validators.get(artifact.format);
    if (validator && !validator(artifact.payload)) {
      throw new GoldenDraftContractError(
        `${relativePath} failed closed schema: ${JSON.stringify(validator.errors)}`,
      );
    }
  }
  validateTypeScriptSchemaConformance(artifacts);
}

function validateDomainCatalog(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  const domain = artifacts.find(
    ([relativePath]) => relativePath === domainCatalogPath,
  )?.[1];
  if (!domain || !Array.isArray(domain.payload.entries)) {
    throw new GoldenDraftContractError('Missing G0.8 domain catalog');
  }
  const expectedFormats = new Set([
    ...artifacts.map(([, artifact]) => artifact.format),
    manifest.format,
  ]);
  const actualFormats = new Set(
    domain.payload.entries.map((entry) => {
      assertJsonObject(entry);
      return String(entry.format);
    }),
  );
  if (
    expectedFormats.size !== actualFormats.size ||
    [...expectedFormats].some((format) => !actualFormats.has(format))
  ) {
    throw new GoldenDraftContractError('G0.8 domain coverage drift');
  }
}

function expectedDraftFiles(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): string[] {
  return [
    ...artifacts
      .map(([relativePath]) => relativePath)
      .filter((relativePath) => relativePath.startsWith('conformance/draft/')),
    ...GOLDEN_DRAFT_CASE_SEEDS.map((seed) => rawSourcePath(seed.case_id)),
  ].sort(asciiCompare);
}

function listDraftFiles(): string[] {
  const root = absoluteContractPath('conformance/draft');
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort(asciiCompare)) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new GoldenDraftContractError(
          `Draft tree contains symlink: ${absolute}`,
        );
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile())
        files.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
      else
        throw new GoldenDraftContractError(
          `Draft tree contains unsupported entry: ${absolute}`,
        );
    }
  };
  visit(root);
  return files.sort(asciiCompare);
}

function validateBoundaries(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  checkTree: boolean,
): void {
  if (checkTree) {
    const expected = expectedDraftFiles(artifacts);
    const actual = listDraftFiles();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new GoldenDraftContractError('G0.8 Draft tree drift');
    }
  }
  const sealedEntries = fs.readdirSync(
    absoluteContractPath('conformance/sealed'),
  );
  const forbiddenOracleImport =
    /(?:from\s+|import\s*\()["'][^"']*(?:\/compiler\/|graph-compiler|normalizer|lowerer|proof)[^"']*["']/;
  for (const relativePath of goldenDraftToolSourceFiles) {
    const source = fs.readFileSync(absoluteContractPath(relativePath), 'utf8');
    if (forbiddenOracleImport.test(source)) {
      throw new GoldenDraftContractError(
        `G0.8 oracle isolation violation: ${relativePath}`,
      );
    }
  }
  if (
    sealedEntries.length !== 1 ||
    sealedEntries[0] !== '.gitkeep' ||
    fs.existsSync(
      path.join(workflowRuntimeRoot, 'compiler/graph-compiler.ts'),
    ) ||
    fs.existsSync(
      path.join(workflowRuntimeRoot, 'compiler/definition-lowering.ts'),
    ) ||
    fs.existsSync(path.join(workflowRuntimeRoot, 'compiler/conformance.ts')) ||
    fs.existsSync(path.join(workflowRuntimeRoot, 'store/runtime-store.ts'))
  ) {
    throw new GoldenDraftContractError('G0.8 forbidden boundary crossed');
  }
  const sqliteCandidate = readArtifact(
    'sqlite/local_single_user_sqlite@1.json',
  );
  if (
    sqliteCandidate.payload.certification_status !== 'candidate' ||
    sqliteCandidate.payload.sqlite_version !== null ||
    sqliteCandidate.payload.release_artifact_hash !== null
  ) {
    throw new GoldenDraftContractError(
      'SQLite candidate was falsely certified',
    );
  }
}

function validateFixtures(): void {
  if (
    new Set(GOLDEN_DRAFT_POSITIVE_FIXTURES.map((fixture) => fixture.fixture_id))
      .size !== GOLDEN_DRAFT_POSITIVE_FIXTURES.length ||
    new Set(GOLDEN_DRAFT_NEGATIVE_FIXTURES.map((fixture) => fixture.fixture_id))
      .size !== GOLDEN_DRAFT_NEGATIVE_FIXTURES.length
  ) {
    throw new GoldenDraftContractError('Duplicate G0.8 fixture id');
  }
  for (const fixture of GOLDEN_DRAFT_NEGATIVE_FIXTURES) {
    if (
      evaluateGoldenDraftNegativeFixture(fixture) !== fixture.expected_error
    ) {
      throw new GoldenDraftContractError(
        `G0.8 negative fixture oracle drift: ${fixture.fixture_id}`,
      );
    }
  }
}

function validatePack(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
  checkTree: boolean,
): void {
  validatePriorIdentity();
  validateSchemas(artifacts);
  validateSemanticArtifacts(artifacts);
  validateFixtures();
  validateDomainCatalog(artifacts, manifest);
  validateBoundaries(artifacts, checkTree);
  const regenerated = buildManifest(artifacts);
  if (
    canonicalJson(regenerated as unknown as JsonValue) !==
    canonicalJson(manifest as unknown as JsonValue)
  ) {
    throw new GoldenDraftContractError('G0.8 manifest is not deterministic');
  }
}

export function evaluateGoldenDraftNegativeFixture(
  fixture: GoldenDraftNegativeFixture,
): string {
  const errors: Record<GoldenDraftFixtureMutation, string> = {
    duplicate_case_id: 'golden_draft_case_id_duplicate',
    missing_positive_coverage: 'golden_draft_positive_coverage_incomplete',
    missing_error_code_coverage: 'golden_draft_error_coverage_incomplete',
    raw_source_hash_drift: 'golden_draft_raw_source_hash_mismatch',
    snapshot_hash_drift: 'golden_draft_snapshot_hash_mismatch',
    positive_diagnostic_present: 'golden_draft_positive_diagnostic_forbidden',
    negative_diagnostic_missing: 'golden_draft_negative_diagnostic_required',
    diagnostic_phase_drift: 'golden_draft_diagnostic_phase_mismatch',
    diagnostic_order_drift: 'golden_draft_diagnostic_order_invalid',
    expected_plan_ref_forged:
      'golden_draft_reviewed_expected_artifact_forbidden',
    expected_plan_hash_forged:
      'golden_draft_reviewed_expected_artifact_forbidden',
    expected_proof_hash_forged:
      'golden_draft_reviewed_expected_artifact_forbidden',
    expected_program_hash_forged:
      'golden_draft_reviewed_expected_artifact_forbidden',
    review_status_approved: 'golden_draft_review_approval_forbidden',
    review_owner_ai: 'golden_draft_review_owner_invalid',
    approval_record_forged: 'golden_draft_review_approval_forbidden',
    semantic_decision_forged: 'golden_draft_review_approval_forbidden',
    sealed_status_forged: 'golden_draft_sealed_artifact_forbidden',
    sealed_directory_written: 'golden_draft_sealed_artifact_forbidden',
    raw_source_missing: 'golden_draft_raw_source_missing',
    snapshot_incomplete: 'golden_draft_snapshot_incomplete',
    snapshot_production_launchable: 'golden_draft_test_only_boundary_required',
    sqlite_candidate_certified: 'golden_draft_sqlite_certification_forbidden',
    prior_manifest_drift: 'golden_draft_prior_identity_drift',
    production_compiler_import: 'golden_draft_oracle_isolation_violation',
  };
  return errors[fixture.mutation];
}

export function generateContractPackGoldenDraft(): ContractArtifactEnvelope {
  const artifacts = expectedArtifacts();
  const manifest = buildManifest(artifacts);
  validatePack(artifacts, manifest, false);
  const draftGitkeep = absoluteContractPath('conformance/draft/.gitkeep');
  if (fs.existsSync(draftGitkeep)) fs.rmSync(draftGitkeep);
  for (const seed of GOLDEN_DRAFT_CASE_SEEDS)
    writeAtomic(rawSourcePath(seed.case_id), seed.raw_source_text);
  for (const [relativePath, artifact] of artifacts)
    writeAtomic(relativePath, renderJson(artifact));
  writeAtomic(manifestPath, renderJson(manifest));
  validateBoundaries(artifacts, true);
  return manifest;
}

export function checkContractPackGoldenDraft(): ContractArtifactEnvelope {
  const artifacts = expectedArtifacts();
  const manifest = buildManifest(artifacts);
  validatePack(artifacts, manifest, true);
  for (const seed of GOLDEN_DRAFT_CASE_SEEDS)
    assertExpectedBytes(rawSourcePath(seed.case_id), seed.raw_source_text);
  for (const [relativePath, artifact] of artifacts)
    assertExpectedBytes(relativePath, renderJson(artifact));
  assertExpectedBytes(manifestPath, renderJson(manifest));
  return manifest;
}

export function buildGoldenDraftExpectedArtifactsForTest(): Array<
  [string, ContractArtifactEnvelope]
> {
  return expectedArtifacts();
}
