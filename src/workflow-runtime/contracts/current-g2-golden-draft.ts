import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  authorCurrentG2GoldenExpectedResult,
  extractCurrentG2GoldenProgramBytes,
  extractCurrentG2GoldenProofBytes,
} from './current-g2-golden-authoring.js';
import {
  CURRENT_G2_GOLDEN_CASES_SCHEMA,
  CURRENT_G2_GOLDEN_INVENTORY_SCHEMA,
  CURRENT_G2_GOLDEN_MANIFEST_SCHEMA,
} from './current-g2-golden-schemas.js';
import type {
  CurrentG2GoldenCase,
  CurrentG2GoldenCaseCatalogPayload,
  CurrentG2GoldenContentIdentity,
  CurrentG2GoldenDraftBuild,
  CurrentG2GoldenDraftManifestPayload,
  CurrentG2GoldenInventoryEntry,
  CurrentG2GoldenInventoryPayload,
  CurrentG2GoldenOptionalContentIdentity,
} from './current-g2-golden-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';

const contractsRoot = import.meta.dirname;

export const CURRENT_G2_GOLDEN_DRAFT_ROOT =
  'conformance/golden-draft/g2-semantic-correction';
export const CURRENT_G2_GOLDEN_DRAFT_CASES_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/golden-draft-cases@1.json`;
export const CURRENT_G2_GOLDEN_DRAFT_INVENTORY_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/artifact-inventory@1.json`;
export const CURRENT_G2_GOLDEN_DRAFT_MANIFEST_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/golden-draft-manifest@1.json`;
export const CURRENT_G2_GOLDEN_CASES_SCHEMA_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/schemas/golden-draft-cases-schema@1.json`;
export const CURRENT_G2_GOLDEN_INVENTORY_SCHEMA_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/schemas/golden-draft-inventory-schema@1.json`;
export const CURRENT_G2_GOLDEN_MANIFEST_SCHEMA_PATH =
  `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/schemas/golden-draft-manifest-schema@1.json`;

const RC_ROOT = 'conformance/review-candidate/g2-semantic-correction';
const RC_MANIFEST_PATH = `${RC_ROOT}/review-candidate.json`;
const RC_CASES_PATH = `${RC_ROOT}/review-candidate-cases@1.json`;
const RC_HANDOFF_PATH = `${RC_ROOT}/fresh-review-handoff@1.json`;
const RC_INVENTORY_PATH = `${RC_ROOT}/artifact-inventory@1.json`;
const EXPECTED_RC_ROOT =
  'sha256:beb8669a054c95e0796ddf998c87c0ddc2e90556f95192a8baad6dd247f3e577';
const SOURCE_CATALOG_PATH =
  'conformance/draft/semantic-correction-v4/semantic-review-input-cases@4.json';
const INPUT_MANIFEST_PATH =
  'conformance/draft/semantic-correction-v4/semantic-correction-input-manifest@1.json';
const BINDING_PATH =
  'conformance/candidate/g2-semantic-correction-v2/g2-case-input-binding@2.json';
const TOOLCHAIN_PATH =
  'conformance/candidate/g2-semantic-correction-v2/workflow-compiler-toolchain@3.json';
const SEMANTIC_CONTRACT_PATH =
  'conformance/compiler-semantic-correction/contract-pack-compiler-semantic-correction.json';
const AUTHORING_GENERATOR_PATH =
  'src/workflow-runtime/contracts/current-g2-golden-authoring.ts';

const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const PLAN_DOMAIN = 'icarus:workflow-graph-plan:2\n';
const PROOF_BYTES_DOMAIN = 'icarus:workflow-current-g2-golden-proof-bytes:1\n';
const PROGRAM_BYTES_DOMAIN = 'icarus:workflow-current-g2-golden-program-bytes:1\n';
const CASES_DOMAIN = 'icarus:workflow-current-g2-golden-draft-cases:1\n';
const INVENTORY_DOMAIN = 'icarus:workflow-current-g2-golden-draft-inventory:1\n';
const MANIFEST_DOMAIN = 'icarus:workflow-current-g2-golden-draft-manifest:1\n';
const CASES_ARTIFACT_DOMAIN =
  'icarus:workflow-current-g2-golden-draft-cases-artifact:1\n';
const INVENTORY_ARTIFACT_DOMAIN =
  'icarus:workflow-current-g2-golden-draft-inventory-artifact:1\n';
const MANIFEST_ARTIFACT_DOMAIN =
  'icarus:workflow-current-g2-golden-draft-manifest-artifact:1\n';
const SCHEMA_DOMAINS = {
  cases: 'icarus:workflow-current-g2-golden-draft-cases-schema:1\n',
  inventory: 'icarus:workflow-current-g2-golden-draft-inventory-schema:1\n',
  manifest: 'icarus:workflow-current-g2-golden-draft-manifest-schema:1\n',
} as const;

const AUTHORIZED_ACTOR = 'human:local-owner';

export class CurrentG2GoldenDraftError extends Error {
  readonly code = 'current_g2_golden_draft_error';

  constructor(message: string) {
    super(message);
    this.name = 'CurrentG2GoldenDraftError';
  }
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new CurrentG2GoldenDraftError(`Draft path escapes contracts root: ${relativePath}`);
  }
  return resolved;
}

function rawHash(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readBytes(relativePath: string): Buffer {
  return fs.readFileSync(absolute(relativePath));
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(strictParseJsonBytes(readBytes(relativePath)));
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new CurrentG2GoldenDraftError(`Expected object: ${label}`);
  }
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new CurrentG2GoldenDraftError(`Expected array: ${label}`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') throw new CurrentG2GoldenDraftError(`Expected string: ${label}`);
  return value;
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
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '1.0.0-draft' },
    version: 1,
    domain_separator: domain,
    hash: rawHash('unreachable'),
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function renderArtifact(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function schemaArtifact(
  kind: keyof typeof SCHEMA_DOMAINS,
  payload: JsonObject,
): ContractArtifactEnvelope {
  return artifact(
    `icarus.workflow-current-g2-golden-draft-${kind}-schema/1`,
    `icarus.workflow-current-g2-golden-draft-${kind}-schema`,
    SCHEMA_DOMAINS[kind],
    payload,
  );
}

function validateRcBoundary(): ContractArtifactEnvelope {
  const names = fs.readdirSync(absolute(RC_ROOT)).sort();
  const expected = [
    path.basename(RC_INVENTORY_PATH),
    path.basename(RC_HANDOFF_PATH),
    path.basename(RC_CASES_PATH),
    path.basename(RC_MANIFEST_PATH),
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new CurrentG2GoldenDraftError('Unique RC directory no longer contains exactly four artifacts');
  }
  const artifacts = [
    readArtifact(RC_MANIFEST_PATH),
    readArtifact(RC_CASES_PATH),
    readArtifact(RC_HANDOFF_PATH),
    readArtifact(RC_INVENTORY_PATH),
  ];
  const root = artifacts[0]!;
  if (root.hash !== EXPECTED_RC_ROOT || root.payload.construction_phase !== 'RC_REVIEW') {
    throw new CurrentG2GoldenDraftError('Review Candidate root or lifecycle drift');
  }
  if (
    root.payload.publishable !== false ||
    root.payload.production_reachable !== false ||
    root.payload.case_count !== 40
  ) {
    throw new CurrentG2GoldenDraftError('Review Candidate boundary is not eligible for Draft authoring');
  }
  try {
    assertCurrentG2SealedBoundary(absolute('conformance/sealed'));
  } catch {
    throw new CurrentG2GoldenDraftError('Draft authoring crossed the sealed boundary');
  }
  return root;
}

function identityForPath(relativePath: string, semanticHash: Sha256Hash): JsonObject {
  return {
    path: relativePath,
    semantic_hash: semanticHash,
    raw_bytes_hash: rawHash(readBytes(relativePath)),
  };
}

function contentIdentity(
  relativePath: string,
  bytes: string,
  semanticHash: Sha256Hash,
  domain: string,
): CurrentG2GoldenContentIdentity {
  return {
    path: relativePath,
    media_type: 'application/json',
    canonicalization: 'rfc8785_jcs',
    raw_bytes_hash: rawHash(bytes),
    semantic_hash: semanticHash,
    domain_separator: domain,
  };
}

function absentContent(): CurrentG2GoldenOptionalContentIdentity {
  return {
    path: null,
    media_type: null,
    canonicalization: null,
    raw_bytes_hash: null,
    semantic_hash: null,
    domain_separator: null,
  };
}

function inventoryEntry(
  identity: CurrentG2GoldenContentIdentity,
  kind: CurrentG2GoldenInventoryEntry['kind'],
  caseId: string | null,
): CurrentG2GoldenInventoryEntry {
  return {
    path: identity.path,
    kind,
    case_id: caseId,
    raw_bytes_hash: identity.raw_bytes_hash,
    semantic_hash: identity.semantic_hash,
    domain_separator: identity.domain_separator,
  };
}

function validator(schema: JsonObject): ValidateFunction {
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema as AnySchema);
}

function assertValid(validate: ValidateFunction, value: JsonValue, label: string): void {
  if (!validate(value)) {
    throw new CurrentG2GoldenDraftError(
      `${label} failed closed schema: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function generatedBytes(files: Map<string, string>, relativePath: string): string {
  const bytes = files.get(relativePath);
  if (bytes === undefined) {
    throw new CurrentG2GoldenDraftError(`Generated file is missing: ${relativePath}`);
  }
  return bytes;
}

function validateGenerated(
  files: Map<string, string>,
  casesArtifact: ContractArtifactEnvelope,
  inventoryArtifact: ContractArtifactEnvelope,
  manifestArtifact: ContractArtifactEnvelope,
): void {
  validateCurrentG2GoldenDraftCaseCatalogForTest(casesArtifact.payload);
  assertValid(
    validator(CURRENT_G2_GOLDEN_INVENTORY_SCHEMA),
    inventoryArtifact.payload,
    'Draft inventory',
  );
  assertValid(
    validator(CURRENT_G2_GOLDEN_MANIFEST_SCHEMA),
    manifestArtifact.payload,
    'Draft manifest',
  );
  const resultSchema = readArtifact(
    'conformance/compiler-contract-repair/schemas/compiler-conformance-case-result-schema.json',
  ).payload;
  const planSchema = readArtifact(
    'conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json',
  ).payload;
  const validateResult = validator(resultSchema);
  const validatePlan = validator(planSchema);
  for (const caseValue of objects(casesArtifact.payload.cases, 'Draft cases')) {
    const resultIdentity = object(caseValue.expected_result, 'result identity');
    const resultPath = string(resultIdentity.path, 'result path');
    const result = strictParseJsonBytes(
      Buffer.from(generatedBytes(files, resultPath), 'utf8'),
    );
    assertValid(validateResult, result, `Expected result ${String(caseValue.case_id)}`);
    if (caseValue.outcome === 'compiled') {
      const planIdentity = object(caseValue.expected_plan, 'plan identity');
      const planPath = string(planIdentity.path, 'plan path');
      const plan = strictParseJsonBytes(
        Buffer.from(generatedBytes(files, planPath), 'utf8'),
      );
      assertValid(validatePlan, plan, `Expected plan ${String(caseValue.case_id)}`);
    }
  }
}

export function validateCurrentG2GoldenDraftCaseCatalogForTest(payload: JsonObject): void {
  assertValid(validator(CURRENT_G2_GOLDEN_CASES_SCHEMA), payload, 'Draft cases');
  const cases = objects(payload.cases, 'Draft case catalog cases');
  const ids = cases.map((entry) => string(entry.case_id, 'Draft case id'));
  if (new Set(ids).size !== 40) {
    throw new CurrentG2GoldenDraftError('Draft contains a missing or duplicate case_id');
  }
  const resultPaths = cases.map((entry) =>
    string(object(entry.expected_result, 'expected result').path, 'expected result path'),
  );
  if (new Set(resultPaths).size !== 40) {
    throw new CurrentG2GoldenDraftError('Draft expected result coverage is not unique');
  }
  const compiled = cases.filter((entry) => entry.outcome === 'compiled');
  const rejected = cases.filter((entry) => entry.outcome === 'rejected');
  if (compiled.length !== 11 || rejected.length !== 29) {
    throw new CurrentG2GoldenDraftError('Draft outcome coverage is partial or drifted');
  }
  for (const entry of compiled) {
    for (const key of ['expected_plan', 'expected_proofs', 'expected_programs']) {
      if (object(entry[key], key).path === null) {
        throw new CurrentG2GoldenDraftError(`Compiled Draft case has partial coverage: ${entry.case_id}`);
      }
    }
  }
  for (const entry of rejected) {
    for (const key of ['expected_plan', 'expected_proofs', 'expected_programs']) {
      if (object(entry[key], key).path !== null) {
        throw new CurrentG2GoldenDraftError(`Rejected Draft case has illegal compiled bytes: ${entry.case_id}`);
      }
    }
  }
}

export function buildCurrentG2GoldenDraftArtifactsForTest(): CurrentG2GoldenDraftBuild {
  const rc = validateRcBoundary();
  const rcCases = readArtifact(RC_CASES_PATH);
  const sourceCatalog = readArtifact(SOURCE_CATALOG_PATH);
  const inputManifest = readArtifact(INPUT_MANIFEST_PATH);
  const contract = readArtifact(SEMANTIC_CONTRACT_PATH);
  const toolchain = object(strictParseJsonBytes(readBytes(TOOLCHAIN_PATH)), 'toolchain manifest');
  const toolchainHash = string(toolchain.toolchain_hash, 'toolchain hash') as Sha256Hash;
  if (
    domainSeparatedSha256(
      'icarus:workflow-compiler-toolchain-manifest:1\n',
      Object.fromEntries(
        Object.entries(toolchain).filter(([key]) => key !== 'toolchain_hash'),
      ),
    ) !== toolchainHash
  ) {
    throw new CurrentG2GoldenDraftError('Toolchain manifest hash drift');
  }
  const binding = object(strictParseJsonBytes(readBytes(BINDING_PATH)), 'case input binding');
  const bindingHash = string(binding.binding_hash, 'case input binding hash') as Sha256Hash;
  if (
    domainSeparatedSha256(
      'icarus:workflow-compiler-g2-case-input-binding:2\n',
      Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'binding_hash')),
    ) !== bindingHash
  ) {
    throw new CurrentG2GoldenDraftError('Case input binding hash drift');
  }
  const rcPayload = rc.payload;
  const boundRoots = object(rcPayload.bound_working_roots, 'RC bound Working roots');
  for (const key of ['contract', 'input', 'candidate', 'working_review']) {
    const identity = object(boundRoots[key], `Working root ${key}`);
    const current = readArtifact(string(identity.path, `Working root ${key} path`));
    if (
      current.hash !== identity.semantic_hash ||
      rawHash(readBytes(string(identity.path, `Working root ${key} path`))) !==
        identity.raw_bytes_hash
    ) {
      throw new CurrentG2GoldenDraftError(`Bound Working root drift: ${key}`);
    }
  }
  const sourceCases = objects(sourceCatalog.payload.cases, 'source cases');
  const rcCaseValues = objects(rcCases.payload.cases, 'RC cases');
  const bindingCases = objects(binding.case_inputs, 'binding cases');
  if (sourceCases.length !== 40 || rcCaseValues.length !== 40 || bindingCases.length !== 40) {
    throw new CurrentG2GoldenDraftError('Draft source coverage is not exactly 40 cases');
  }
  const sourceById = new Map(sourceCases.map((entry) => [String(entry.case_id), entry]));
  const bindingById = new Map(bindingCases.map((entry) => [String(entry.case_id), entry]));
  if (sourceById.size !== 40 || bindingById.size !== 40) {
    throw new CurrentG2GoldenDraftError('Missing or duplicate source/binding case identity');
  }

  const files = new Map<string, string>();
  const inventoryEntries: CurrentG2GoldenInventoryEntry[] = [];
  const expectedResults = new Map<string, ReturnType<typeof authorCurrentG2GoldenExpectedResult>>();
  const schemaDefinitions = [
    ['cases', CURRENT_G2_GOLDEN_CASES_SCHEMA_PATH, CURRENT_G2_GOLDEN_CASES_SCHEMA],
    ['inventory', CURRENT_G2_GOLDEN_INVENTORY_SCHEMA_PATH, CURRENT_G2_GOLDEN_INVENTORY_SCHEMA],
    ['manifest', CURRENT_G2_GOLDEN_MANIFEST_SCHEMA_PATH, CURRENT_G2_GOLDEN_MANIFEST_SCHEMA],
  ] as const;
  for (const [kind, schemaPath, schema] of schemaDefinitions) {
    const value = schemaArtifact(kind, schema);
    const bytes = renderArtifact(value);
    files.set(schemaPath, bytes);
    inventoryEntries.push({
      path: schemaPath,
      kind: 'schema',
      case_id: null,
      raw_bytes_hash: rawHash(bytes),
      semantic_hash: value.hash,
      domain_separator: value.domain_separator,
    });
  }

  const cases: CurrentG2GoldenCase[] = [];
  let compiledCount = 0;
  let rejectedCount = 0;
  for (const rcCase of rcCaseValues) {
    const caseId = string(rcCase.case_id, 'RC case id');
    const sourceCase = sourceById.get(caseId);
    const bindingCase = bindingById.get(caseId);
    if (!sourceCase || !bindingCase) {
      throw new CurrentG2GoldenDraftError(`Missing source or binding case: ${caseId}`);
    }
    const sourceIdentity = object(rcCase.source_identity, 'RC source identity');
    const snapshotIdentity = object(rcCase.input_snapshot_identity, 'RC snapshot identity');
    const sourcePath = string(sourceIdentity.path, 'source path');
    const snapshotPath = string(snapshotIdentity.path, 'snapshot path');
    const sourceBytes = readBytes(sourcePath);
    const sourceText = sourceBytes.toString('utf8');
    const snapshotBytes = readBytes(snapshotPath);
    const snapshot = readArtifact(snapshotPath);
    if (
      rawHash(sourceBytes) !== sourceIdentity.raw_bytes_hash ||
      domainSeparatedSha256(RAW_SOURCE_DOMAIN, sourceText) !== sourceIdentity.semantic_hash ||
      rawHash(snapshotBytes) !== snapshotIdentity.raw_bytes_hash ||
      snapshot.hash !== snapshotIdentity.semantic_hash ||
      bindingCase.raw_source_bytes_ref !== sourcePath ||
      bindingCase.raw_source_bytes_hash !== sourceIdentity.semantic_hash ||
      bindingCase.input_snapshot_ref !== snapshotPath ||
      bindingCase.input_snapshot_hash !== snapshot.hash
    ) {
      throw new CurrentG2GoldenDraftError(`RC/source/snapshot/binding drift: ${caseId}`);
    }
    const reviewInput = object(rcCase.review_input, 'RC review input');
    const diagnostics = objects(reviewInput.expected_diagnostics, 'expected diagnostics') as never;
    const result = authorCurrentG2GoldenExpectedResult({
      caseId,
      sourceKind: string(rcCase.source_kind, 'source kind') as never,
      rawSourceText: sourceText,
      expectedSourceHash: sourceCase.expected_source_hash as Sha256Hash | null,
      inputSnapshot: snapshot.payload,
      expectedDiagnostics: diagnostics,
    });
    expectedResults.set(caseId, result);
    const resultPath = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/expected/${caseId}.result.json`;
    const resultBytes = canonicalJson(result);
    files.set(resultPath, resultBytes);
    const resultIdentity = contentIdentity(resultPath, resultBytes, result.result_hash, RESULT_DOMAIN);
    inventoryEntries.push(inventoryEntry(resultIdentity, 'expected_result', caseId));

    let planIdentity: CurrentG2GoldenOptionalContentIdentity = absentContent();
    let proofsIdentity: CurrentG2GoldenOptionalContentIdentity = absentContent();
    let programsIdentity: CurrentG2GoldenOptionalContentIdentity = absentContent();
    if (result.outcome === 'compiled') {
      compiledCount += 1;
      const planPath = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/expected/${caseId}.plan.json`;
      const proofsPath = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/expected/${caseId}.proofs.json`;
      const programsPath = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/expected/${caseId}.programs.json`;
      const planBytes = canonicalJson(result.normalized_plan);
      const proofs = extractCurrentG2GoldenProofBytes(result.normalized_plan);
      const programs = extractCurrentG2GoldenProgramBytes(result.normalized_plan);
      const proofsBytes = canonicalJson(proofs);
      const programsBytes = canonicalJson(programs);
      files.set(planPath, planBytes);
      files.set(proofsPath, proofsBytes);
      files.set(programsPath, programsBytes);
      planIdentity = contentIdentity(
        planPath,
        planBytes,
        result.normalized_plan.plan_hash as Sha256Hash,
        PLAN_DOMAIN,
      );
      proofsIdentity = contentIdentity(
        proofsPath,
        proofsBytes,
        domainSeparatedSha256(PROOF_BYTES_DOMAIN, proofs),
        PROOF_BYTES_DOMAIN,
      );
      programsIdentity = contentIdentity(
        programsPath,
        programsBytes,
        domainSeparatedSha256(PROGRAM_BYTES_DOMAIN, programs),
        PROGRAM_BYTES_DOMAIN,
      );
      inventoryEntries.push(inventoryEntry(planIdentity as CurrentG2GoldenContentIdentity, 'expected_plan', caseId));
      inventoryEntries.push(
        inventoryEntry(proofsIdentity as CurrentG2GoldenContentIdentity, 'expected_proofs', caseId),
      );
      inventoryEntries.push(
        inventoryEntry(programsIdentity as CurrentG2GoldenContentIdentity, 'expected_programs', caseId),
      );
    } else {
      rejectedCount += 1;
    }
    cases.push({
      case_id: caseId,
      polarity: string(rcCase.polarity, 'polarity') as never,
      source_kind: string(rcCase.source_kind, 'source kind') as never,
      coverage_tags: clone(rcCase.coverage_tags as JsonValue[]) as JsonValue[],
      source_binding: {
        raw_source_bytes_ref: sourcePath,
        raw_source_bytes_hash: string(sourceIdentity.semantic_hash, 'source semantic hash') as Sha256Hash,
        raw_source_file_hash: string(sourceIdentity.raw_bytes_hash, 'source raw hash') as Sha256Hash,
        input_snapshot_ref: snapshotPath,
        input_snapshot_hash: snapshot.hash,
        input_snapshot_file_hash: string(snapshotIdentity.raw_bytes_hash, 'snapshot raw hash') as Sha256Hash,
        effective_case_input_hash: string(
          bindingCase.effective_case_input_hash,
          'effective case input hash',
        ) as Sha256Hash,
      },
      outcome: result.outcome,
      expected_result: resultIdentity,
      expected_plan: planIdentity,
      expected_proofs: proofsIdentity,
      expected_programs: programsIdentity,
      expected_plan_hash:
        result.outcome === 'compiled'
          ? (result.normalized_plan.plan_hash as Sha256Hash)
          : null,
      expected_proof_hashes: clone(result.proof_hashes),
      expected_program_hashes: clone(result.program_hashes),
      expected_diagnostics: clone(result.diagnostics),
      semantic_assertions: clone(reviewInput.semantic_assertions as JsonObject[]),
      authored_from: 'current_spec_machine_contract_source_snapshot',
      human_judgment: null,
    });
  }
  if (compiledCount !== 11 || rejectedCount !== 29 || cases.length !== 40) {
    throw new CurrentG2GoldenDraftError('Expected outcome coverage drift');
  }

  const rootSourceIdentity = object(rc.payload.source_identity, 'RC source identity');
  const sourceSetHash = string(rootSourceIdentity.source_set_hash, 'source set hash') as Sha256Hash;
  const reducedRoots = Object.fromEntries(
    ['contract', 'input', 'candidate', 'working_review'].map((key) => {
      const value = object(boundRoots[key], `bound root ${key}`);
      return [
        key,
        {
          path: value.path,
          semantic_hash: value.semantic_hash,
          raw_bytes_hash: value.raw_bytes_hash,
        },
      ];
    }),
  );
  const casesWithoutHash: Omit<CurrentG2GoldenCaseCatalogPayload, 'cases_hash'> = {
    format: 'icarus.workflow-compiler-current-g2-golden-draft-cases/1',
    construction_phase: 'RC_REVIEW',
    draft_status: 'frozen_pending_human_approval',
    publishable: false,
    production_reachable: false,
    review_candidate_ref: RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    source_set_hash: sourceSetHash,
    bound_working_roots: reducedRoots,
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    expected_result_coverage: 40,
    human_judgment_coverage: 0,
    cases,
  };
  const casesPayload = {
    ...(casesWithoutHash as JsonObject),
    cases_hash: domainSeparatedSha256(
      CASES_DOMAIN,
      casesWithoutHash as unknown as JsonValue,
    ),
  } as CurrentG2GoldenCaseCatalogPayload;
  const casesArtifact = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-cases/1',
    'icarus.workflow-compiler-current-g2-golden-draft-cases',
    CASES_ARTIFACT_DOMAIN,
    casesPayload,
  );
  const casesBytes = renderArtifact(casesArtifact);
  files.set(CURRENT_G2_GOLDEN_DRAFT_CASES_PATH, casesBytes);
  inventoryEntries.push({
    path: CURRENT_G2_GOLDEN_DRAFT_CASES_PATH,
    kind: 'case_catalog',
    case_id: null,
    raw_bytes_hash: rawHash(casesBytes),
    semantic_hash: casesArtifact.hash,
    domain_separator: casesArtifact.domain_separator,
  });
  inventoryEntries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const inventoryWithoutHash: Omit<CurrentG2GoldenInventoryPayload, 'inventory_hash'> = {
    format: 'icarus.workflow-compiler-current-g2-golden-draft-inventory/1',
    construction_phase: 'RC_REVIEW',
    inventory_scope: 'all_draft_leaf_artifacts_excluding_manifest',
    entry_count: inventoryEntries.length,
    entries: inventoryEntries,
  };
  const inventoryPayload = {
    ...(inventoryWithoutHash as JsonObject),
    inventory_hash: domainSeparatedSha256(
      INVENTORY_DOMAIN,
      inventoryWithoutHash as unknown as JsonValue,
    ),
  } as CurrentG2GoldenInventoryPayload;
  const inventoryArtifact = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-inventory/1',
    'icarus.workflow-compiler-current-g2-golden-draft-inventory',
    INVENTORY_ARTIFACT_DOMAIN,
    inventoryPayload,
  );
  files.set(CURRENT_G2_GOLDEN_DRAFT_INVENTORY_PATH, renderArtifact(inventoryArtifact));

  const exactIdentity = clone(
    object(object(rc.payload.compiler_identity, 'RC compiler identity').exact_identity, 'exact identity'),
  );
  const generatorBytes = fs.readFileSync(path.resolve(contractsRoot, '../../..', AUTHORING_GENERATOR_PATH));
  const manifestWithoutHash: Omit<CurrentG2GoldenDraftManifestPayload, 'draft_manifest_hash'> = {
    format: 'icarus.workflow-compiler-current-g2-golden-draft-manifest/1',
    gate: 'G2',
    construction_phase: 'RC_REVIEW',
    draft_status: 'frozen_pending_human_approval',
    publishable: false,
    production_reachable: false,
    review_candidate_ref: RC_MANIFEST_PATH,
    review_candidate_hash: rc.hash,
    source_set_hash: sourceSetHash,
    bound_working_roots: reducedRoots,
    semantic_correction_contract_ref: SEMANTIC_CONTRACT_PATH,
    semantic_correction_contract_hash: contract.hash,
    semantic_correction_input_manifest_ref: INPUT_MANIFEST_PATH,
    semantic_correction_input_manifest_hash: inputManifest.hash,
    source_case_catalog_ref: SOURCE_CATALOG_PATH,
    source_case_catalog_hash: sourceCatalog.hash,
    case_input_binding_ref: BINDING_PATH,
    case_input_binding_hash: bindingHash,
    toolchain_file_ref: TOOLCHAIN_PATH,
    toolchain_file_hash: toolchainHash,
    authoring_generator_ref: AUTHORING_GENERATOR_PATH,
    authoring_generator_hash: rawHash(generatorBytes),
    exact_compiler_identity: exactIdentity as never,
    cases_ref: CURRENT_G2_GOLDEN_DRAFT_CASES_PATH,
    cases_hash: casesArtifact.hash,
    inventory_ref: CURRENT_G2_GOLDEN_DRAFT_INVENTORY_PATH,
    inventory_hash: inventoryArtifact.hash,
    case_count: 40,
    compiled_count: 11,
    rejected_count: 29,
    expected_result_coverage: 40,
    expected_plan_coverage: 11,
    expected_proof_bytes_coverage: 11,
    expected_program_bytes_coverage: 11,
    human_review: {
      status: 'not_requested',
      reviewer_actor_ref: 'human:local-owner',
      judgment_coverage: 0,
      judgment_record_ref: null,
      judgment_record_hash: null,
    },
    approval: { status: 'absent', ref: null, hash: null },
    signature: { status: 'absent', ref: null, hash: null },
    seal: {
      status: 'absent',
      ref: null,
      hash: null,
      sealed_artifact_count: 0,
      conformance_sealed_write_status: 'not_run',
    },
    golden_semantic_review_status: 'not_run',
    golden_review_report_status: 'generated_after_draft_freeze',
    g3_through_g9_status: 'not_started',
  };
  const manifestPayload = {
    ...(manifestWithoutHash as JsonObject),
    draft_manifest_hash: domainSeparatedSha256(
      MANIFEST_DOMAIN,
      manifestWithoutHash as unknown as JsonValue,
    ),
  } as CurrentG2GoldenDraftManifestPayload;
  const manifestArtifact = artifact(
    'icarus.workflow-compiler-current-g2-golden-draft-manifest/1',
    'icarus.workflow-compiler-current-g2-golden-draft-manifest',
    MANIFEST_ARTIFACT_DOMAIN,
    manifestPayload,
  );
  files.set(CURRENT_G2_GOLDEN_DRAFT_MANIFEST_PATH, renderArtifact(manifestArtifact));
  validateGenerated(files, casesArtifact, inventoryArtifact, manifestArtifact);
  return { files, manifest: manifestArtifact, expectedResults };
}

function relativeWithinDraft(relativePath: string): string {
  const prefix = `${CURRENT_G2_GOLDEN_DRAFT_ROOT}/`;
  if (!relativePath.startsWith(prefix)) {
    throw new CurrentG2GoldenDraftError(`Unexpected Draft output path: ${relativePath}`);
  }
  return relativePath.slice(prefix.length);
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) throw new CurrentG2GoldenDraftError('Draft tree contains a symlink');
      if (stat.isDirectory()) visit(entry);
      else output.push(path.relative(root, entry).split(path.sep).join('/'));
    }
  };
  visit(root);
  return output;
}

function checkFilesAtRoot(root: string, expected: Map<string, string>): void {
  const expectedByLocal = new Map(
    [...expected].map(([relativePath, bytes]) => [relativeWithinDraft(relativePath), bytes]),
  );
  const actualPaths = listTree(root);
  const expectedPaths = [...expectedByLocal.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new CurrentG2GoldenDraftError('Draft inventory conflict, missing, or unregistered file');
  }
  for (const [localPath, bytes] of expectedByLocal) {
    if (fs.readFileSync(path.join(root, localPath), 'utf8') !== bytes) {
      throw new CurrentG2GoldenDraftError(`Draft bytes drift: ${localPath}`);
    }
  }
}

export function generateCurrentG2GoldenDraftAtRootForTest(
  root: string,
  authorizedBy: string,
): ContractArtifactEnvelope {
  if (authorizedBy !== AUTHORIZED_ACTOR) {
    throw new CurrentG2GoldenDraftError('Golden Draft generation is not authorized');
  }
  const built = buildCurrentG2GoldenDraftArtifactsForTest();
  if (fs.existsSync(root)) {
    checkFilesAtRoot(root, built.files);
    return built.manifest;
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = fs.mkdtempSync(`${root}.tmp-`);
  try {
    for (const [relativePath, bytes] of built.files) {
      const target = path.join(temporary, relativeWithinDraft(relativePath));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    fs.renameSync(temporary, root);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return built.manifest;
}

export function checkCurrentG2GoldenDraftAtRootForTest(root: string): ContractArtifactEnvelope {
  const built = buildCurrentG2GoldenDraftArtifactsForTest();
  checkFilesAtRoot(root, built.files);
  return built.manifest;
}

export function generateCurrentG2GoldenDraft(authorizedBy: string): ContractArtifactEnvelope {
  return generateCurrentG2GoldenDraftAtRootForTest(
    absolute(CURRENT_G2_GOLDEN_DRAFT_ROOT),
    authorizedBy,
  );
}

export function checkCurrentG2GoldenDraft(): ContractArtifactEnvelope {
  return checkCurrentG2GoldenDraftAtRootForTest(absolute(CURRENT_G2_GOLDEN_DRAFT_ROOT));
}
