import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  checkCompilerSemanticCorrectionContract,
  COMPILER_EXACT_IDENTITY_FIELDS_V2,
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
} from './compiler-semantic-correction-contract.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const SEMANTIC_CORRECTION_DRAFT_ROOT =
  'conformance/draft/resolved-g2-semantic-correction-v4';
export const SEMANTIC_CORRECTION_DRAFT_CASES_PATH = `${SEMANTIC_CORRECTION_DRAFT_ROOT}/golden-draft-cases@4.json`;
export const SEMANTIC_CORRECTION_DRAFT_HANDOFF_PATH = `${SEMANTIC_CORRECTION_DRAFT_ROOT}/semantic-review-handoff@2.json`;
export const SEMANTIC_CORRECTION_DRAFT_INVENTORY_PATH = `${SEMANTIC_CORRECTION_DRAFT_ROOT}/artifact-inventory@2.json`;
export const SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH = `${SEMANTIC_CORRECTION_DRAFT_ROOT}/golden-draft-manifest@4.json`;

const INPUT_CATALOG_PATH =
  'conformance/draft/semantic-correction-v4/semantic-review-input-cases@4.json';
const INPUT_MANIFEST_PATH =
  'conformance/draft/semantic-correction-v4/semantic-correction-input-manifest@1.json';
const CANDIDATE_ROOT = 'conformance/candidate/g2-semantic-correction-v2';
const CANDIDATE_ROOT_PATH = `${CANDIDATE_ROOT}/contract-pack-g2-semantic-correction-candidate.json`;
const TOOLCHAIN_PATH = `${CANDIDATE_ROOT}/workflow-compiler-toolchain@3.json`;
const BINDING_PATH = `${CANDIDATE_ROOT}/g2-case-input-binding@2.json`;
const RESULTS_MANIFEST_PATH = `${CANDIDATE_ROOT}/candidate-results-manifest@2.json`;
const HISTORICAL_DRAFT_V3_PATH =
  'conformance/draft/resolved-g2/golden-draft-manifest@3.json';
const HISTORICAL_DRAFT_V3_HASH =
  'sha256:659caf9b4add7027116bf780c83b2b85dc95ca0baae9cb8b9840d760a785132b';

const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const RAW_SOURCE_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const TOOLCHAIN_DOMAIN = 'icarus:workflow-compiler-toolchain-manifest:1\n';
const BINDING_DOMAIN = 'icarus:workflow-compiler-g2-case-input-binding:2\n';
const RESULTS_MANIFEST_DOMAIN =
  'icarus:workflow-compiler-candidate-results-manifest:2\n';
const CASES_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-golden-draft-cases:4\n';
const HANDOFF_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-review-handoff:2\n';
const INVENTORY_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-draft-inventory:2\n';
const MANIFEST_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-golden-draft-manifest:4\n';

export class SemanticCorrectionDraftError extends Error {
  readonly code = 'semantic_correction_draft_contract_drift';

  constructor(message: string) {
    super(message);
    this.name = 'SemanticCorrectionDraftError';
  }
}

function absolutePath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new SemanticCorrectionDraftError(
      `Semantic correction Draft path escapes root: ${relativePath}`,
    );
  }
  return absolute;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rawHash(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(
  format: string,
  id: string,
  refVersion: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const revision = Number(format.slice(format.lastIndexOf('/') + 1));
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: refVersion },
    version: revision,
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolutePath(relativePath))),
  );
}

function readObject(relativePath: string): JsonObject {
  const value = strictParseJsonBytes(
    fs.readFileSync(absolutePath(relativePath)),
  );
  assertJsonObject(value);
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new SemanticCorrectionDraftError(`${label} must be an array`);
  }
  return value.map((entry) => {
    try {
      assertJsonObject(entry);
      return entry;
    } catch {
      throw new SemanticCorrectionDraftError(
        `${label} entry must be an object`,
      );
    }
  });
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') {
    throw new SemanticCorrectionDraftError(`${label} must be a string`);
  }
  return value;
}

function hashWithoutField(
  value: JsonObject,
  field: string,
  domain: string,
): Sha256Hash {
  const { [field]: _ignored, ...withoutHash } = value;
  return domainSeparatedSha256(domain, withoutHash);
}

interface LoadedDraftInputs {
  contract: ContractArtifactEnvelope;
  inputCatalog: ContractArtifactEnvelope;
  inputManifest: ContractArtifactEnvelope;
  candidateRoot: ContractArtifactEnvelope;
  binding: JsonObject;
  resultsManifest: JsonObject;
  toolchain: JsonObject;
  exactIdentity: JsonObject;
  cases: JsonObject[];
  bindingByCase: Map<string, JsonObject>;
  resultByCase: Map<string, JsonObject>;
}

function loadInputs(): LoadedDraftInputs {
  const contract = checkCompilerSemanticCorrectionContract();
  const historicalDraft = readArtifact(HISTORICAL_DRAFT_V3_PATH);
  if (historicalDraft.hash !== HISTORICAL_DRAFT_V3_HASH) {
    throw new SemanticCorrectionDraftError('Historical Draft v3 drift');
  }
  const inputCatalog = readArtifact(INPUT_CATALOG_PATH);
  const inputManifest = readArtifact(INPUT_MANIFEST_PATH);
  const candidateRoot = readArtifact(CANDIDATE_ROOT_PATH);
  const binding = readObject(BINDING_PATH);
  const resultsManifest = readObject(RESULTS_MANIFEST_PATH);
  const toolchain = readObject(TOOLCHAIN_PATH);
  if (
    inputManifest.payload.case_catalog_ref !== INPUT_CATALOG_PATH ||
    inputManifest.payload.case_catalog_hash !== inputCatalog.hash ||
    inputManifest.payload.case_count !== 40 ||
    inputManifest.payload.per_case_snapshot_count !== 40
  ) {
    throw new SemanticCorrectionDraftError('Additive input manifest drift');
  }
  if (
    candidateRoot.payload.semantic_correction_input_manifest_ref !==
      INPUT_MANIFEST_PATH ||
    candidateRoot.payload.semantic_correction_input_manifest_hash !==
      inputManifest.hash ||
    candidateRoot.payload.compiler_toolchain_ref !== TOOLCHAIN_PATH ||
    candidateRoot.payload.compiler_toolchain_hash !==
      toolchain.toolchain_hash ||
    candidateRoot.payload.case_input_binding_ref !== BINDING_PATH ||
    candidateRoot.payload.case_input_binding_hash !== binding.binding_hash ||
    candidateRoot.payload.candidate_results_manifest_ref !==
      RESULTS_MANIFEST_PATH ||
    candidateRoot.payload.candidate_results_manifest_hash !==
      resultsManifest.manifest_hash ||
    candidateRoot.payload.candidate_disposition !==
      'actual_compiler_output_not_golden_oracle'
  ) {
    throw new SemanticCorrectionDraftError('Additive candidate root drift');
  }
  if (
    hashWithoutField(toolchain, 'toolchain_hash', TOOLCHAIN_DOMAIN) !==
      toolchain.toolchain_hash ||
    hashWithoutField(binding, 'binding_hash', BINDING_DOMAIN) !==
      binding.binding_hash ||
    hashWithoutField(
      resultsManifest,
      'manifest_hash',
      RESULTS_MANIFEST_DOMAIN,
    ) !== resultsManifest.manifest_hash
  ) {
    throw new SemanticCorrectionDraftError('Additive candidate hash drift');
  }
  const exactIdentity: JsonObject = Object.fromEntries(
    COMPILER_EXACT_IDENTITY_FIELDS_V2.map((field) => {
      const value = binding[field];
      if (value === undefined) {
        throw new SemanticCorrectionDraftError(
          `Missing exact Compiler identity field: ${field}`,
        );
      }
      return [field, value];
    }),
  );
  const cases = objects(inputCatalog.payload.cases, 'Draft input cases');
  const bindingCases = objects(binding.case_inputs, 'Draft case bindings');
  const resultEntries = objects(
    resultsManifest.case_results,
    'Draft candidate results',
  );
  if (
    cases.length !== 40 ||
    bindingCases.length !== 40 ||
    resultEntries.length !== 40
  ) {
    throw new SemanticCorrectionDraftError('Draft case coverage drift');
  }
  const bindingByCase = new Map(
    bindingCases.map((entry) => [
      string(entry.case_id, 'binding case id'),
      entry,
    ]),
  );
  const resultByCase = new Map(
    resultEntries.map((entry) => [
      string(entry.case_id, 'result case id'),
      entry,
    ]),
  );
  if (bindingByCase.size !== 40 || resultByCase.size !== 40) {
    throw new SemanticCorrectionDraftError('Draft case identity is not unique');
  }
  for (const inputCase of cases) {
    const caseId = string(inputCase.case_id, 'input case id');
    const caseBinding = bindingByCase.get(caseId);
    const resultEntry = resultByCase.get(caseId);
    if (!caseBinding || !resultEntry) {
      throw new SemanticCorrectionDraftError(`Missing Draft input: ${caseId}`);
    }
    for (const field of [
      'raw_source_bytes_ref',
      'raw_source_bytes_hash',
      'input_snapshot_ref',
      'input_snapshot_hash',
    ]) {
      if (inputCase[field] !== caseBinding[field]) {
        throw new SemanticCorrectionDraftError(
          `Case input identity drift: ${caseId}/${field}`,
        );
      }
    }
    const sourceRef = string(inputCase.raw_source_bytes_ref, 'source ref');
    const sourceText = fs.readFileSync(absolutePath(sourceRef), 'utf8');
    if (
      domainSeparatedSha256(RAW_SOURCE_DOMAIN, sourceText) !==
      inputCase.raw_source_bytes_hash
    ) {
      throw new SemanticCorrectionDraftError(`Source bytes drift: ${caseId}`);
    }
    const snapshot = readArtifact(
      string(inputCase.input_snapshot_ref, 'snapshot ref'),
    );
    if (snapshot.hash !== inputCase.input_snapshot_hash) {
      throw new SemanticCorrectionDraftError(`Snapshot drift: ${caseId}`);
    }
    const resultRef = string(resultEntry.result_ref, 'result ref');
    const resultBytes = fs.readFileSync(absolutePath(resultRef));
    const result = readObject(resultRef);
    if (
      rawHash(resultBytes) !== resultEntry.result_raw_bytes_hash ||
      result.case_id !== caseId ||
      result.outcome !== resultEntry.outcome ||
      result.result_hash !== resultEntry.result_hash ||
      hashWithoutField(result, 'result_hash', RESULT_DOMAIN) !==
        resultEntry.result_hash
    ) {
      throw new SemanticCorrectionDraftError(
        `Candidate result drift: ${caseId}`,
      );
    }
  }
  return {
    contract,
    inputCatalog,
    inputManifest,
    candidateRoot,
    binding,
    resultsManifest,
    toolchain,
    exactIdentity,
    cases,
    bindingByCase,
    resultByCase,
  };
}

function buildCasesArtifact(
  inputs: LoadedDraftInputs,
): ContractArtifactEnvelope {
  const cases = inputs.cases.map((inputCase) => {
    const caseId = string(inputCase.case_id, 'input case id');
    const binding = inputs.bindingByCase.get(caseId)!;
    const result = inputs.resultByCase.get(caseId)!;
    return {
      case_id: caseId,
      polarity: inputCase.polarity,
      source_kind: inputCase.source_kind,
      coverage_tags: inputCase.coverage_tags,
      raw_source_bytes_ref: inputCase.raw_source_bytes_ref,
      raw_source_bytes_hash: inputCase.raw_source_bytes_hash,
      input_snapshot_ref: inputCase.input_snapshot_ref,
      input_snapshot_hash: inputCase.input_snapshot_hash,
      case_input_binding_ref: BINDING_PATH,
      case_input_binding_hash: inputs.binding.binding_hash,
      effective_case_input_hash: binding.effective_case_input_hash,
      review_input: inputCase.review_input,
      actual_compiler_candidate: {
        role: 'actual_compiler_output_not_golden_oracle',
        outcome: result.outcome,
        result_ref: result.result_ref,
        result_hash: result.result_hash,
        result_raw_bytes_hash: result.result_raw_bytes_hash,
      },
      expected_golden_oracle: {
        status: 'pending_fresh_independent_human_semantic_review',
        expected_case_result_bytes_ref: null,
        expected_case_result_hash: null,
        expected_source_hash: null,
        expected_plan_hash: null,
        expected_proof_hashes: null,
        expected_program_hashes: null,
        expected_diagnostics: null,
      },
      review_owner: 'human:local-owner',
      review_status: 'pending_fresh_independent_human_semantic_review',
      human_judgment: null,
    };
  });
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-golden-draft-cases/4',
    bundle_version: '4.0.0-additive-semantic-correction',
    draft_status: 'published_pending_fresh_independent_human_review',
    historical_resolved_draft_v3_ref: HISTORICAL_DRAFT_V3_PATH,
    historical_resolved_draft_v3_hash: HISTORICAL_DRAFT_V3_HASH,
    semantic_correction_contract_ref:
      COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
    semantic_correction_contract_hash: inputs.contract.hash,
    semantic_correction_input_manifest_ref: INPUT_MANIFEST_PATH,
    semantic_correction_input_manifest_hash: inputs.inputManifest.hash,
    candidate_root_ref: CANDIDATE_ROOT_PATH,
    candidate_root_hash: inputs.candidateRoot.hash,
    exact_compiler_identity: inputs.exactIdentity,
    candidate_output_disposition: 'actual_compiler_output_not_golden_oracle',
    review_input_disposition: 'hand_authored_semantic_review_input',
    expected_oracle_disposition:
      'all_null_pending_fresh_independent_human_semantic_review',
    case_count: 40,
    positive_case_count: 11,
    negative_case_count: 29,
    human_judgment_coverage: 0,
    fresh_review_status: 'pending_40_of_40',
    cases,
  };
  return artifact(
    'icarus.workflow-compiler-golden-draft-cases/4',
    'icarus.workflow-compiler-golden-draft-cases',
    '4.0.0',
    CASES_DOMAIN,
    {
      ...withoutHash,
      catalog_hash: domainSeparatedSha256(CASES_DOMAIN, withoutHash),
    },
  );
}

function buildHandoffArtifact(
  casesArtifact: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const cases = objects(casesArtifact.payload.cases, 'Draft v4 cases');
  const caseHandoffs = cases.map((entry, index) => {
    assertJsonObject(entry.actual_compiler_candidate);
    return {
      case_id: entry.case_id,
      review_input_pointer: `/cases/${index}/review_input`,
      actual_candidate_result_ref: entry.actual_compiler_candidate.result_ref,
      actual_candidate_result_hash: entry.actual_compiler_candidate.result_hash,
      expected_golden_oracle_pointer: `/cases/${index}/expected_golden_oracle`,
      review_owner: 'human:local-owner',
      review_status: 'pending_fresh_independent_human_semantic_review',
      human_judgment: null,
    };
  });
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-semantic-review-handoff/2',
    handoff_version: '2.0.0-additive-semantic-correction',
    cases_ref: SEMANTIC_CORRECTION_DRAFT_CASES_PATH,
    cases_hash: casesArtifact.hash,
    review_owner: 'human:local-owner',
    review_scope: 'fresh_independent_review_of_all_40_cases',
    review_decision_status: 'pending_not_recorded',
    human_judgment_coverage: 0,
    pending_case_count: 40,
    golden_semantic_review_record_ref: null,
    approval_status: 'not_run',
    golden_seal_status: 'not_run',
    sealed_write_status: 'not_run',
    g3_through_g9_status: 'not_started',
    case_handoffs: caseHandoffs,
  };
  return artifact(
    'icarus.workflow-compiler-semantic-review-handoff/2',
    'icarus.workflow-compiler-semantic-review-handoff',
    '2.0.0',
    HANDOFF_DOMAIN,
    {
      ...withoutHash,
      handoff_hash: domainSeparatedSha256(HANDOFF_DOMAIN, withoutHash),
    },
  );
}

function inventoryEntry(
  artifactPath: string,
  value: ContractArtifactEnvelope,
): JsonObject {
  return {
    path: artifactPath,
    format: value.format,
    ref: value.ref,
    artifact_hash: value.hash,
    raw_bytes_hash: rawHash(Buffer.from(render(value), 'utf8')),
  };
}

function buildInventoryArtifact(
  leafArtifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const entries = leafArtifacts
    .map(([artifactPath, value]) => inventoryEntry(artifactPath, value))
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-semantic-correction-draft-inventory/2',
    inventory_version: '2.0.0-additive-semantic-correction',
    entry_count: entries.length,
    entries,
  };
  return artifact(
    'icarus.workflow-compiler-semantic-correction-draft-inventory/2',
    'icarus.workflow-compiler-semantic-correction-draft-inventory',
    '2.0.0',
    INVENTORY_DOMAIN,
    {
      ...withoutHash,
      inventory_hash: domainSeparatedSha256(INVENTORY_DOMAIN, withoutHash),
    },
  );
}

function buildManifestArtifact(
  inputs: LoadedDraftInputs,
  cases: ContractArtifactEnvelope,
  handoff: ContractArtifactEnvelope,
  inventory: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-compiler-golden-draft-manifest/4',
    bundle_version: '4.0.0-additive-semantic-correction',
    gate: 'G2',
    gate_status: 'IN_PROGRESS',
    draft_status: 'published_pending_fresh_independent_human_review',
    cases_ref: SEMANTIC_CORRECTION_DRAFT_CASES_PATH,
    cases_hash: cases.hash,
    semantic_review_handoff_ref: SEMANTIC_CORRECTION_DRAFT_HANDOFF_PATH,
    semantic_review_handoff_hash: handoff.hash,
    artifact_inventory_ref: SEMANTIC_CORRECTION_DRAFT_INVENTORY_PATH,
    artifact_inventory_hash: inventory.hash,
    semantic_correction_contract_ref:
      COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
    semantic_correction_contract_hash: inputs.contract.hash,
    semantic_correction_input_manifest_ref: INPUT_MANIFEST_PATH,
    semantic_correction_input_manifest_hash: inputs.inputManifest.hash,
    candidate_root_ref: CANDIDATE_ROOT_PATH,
    candidate_root_hash: inputs.candidateRoot.hash,
    candidate_results_manifest_ref: RESULTS_MANIFEST_PATH,
    candidate_results_manifest_hash: inputs.resultsManifest.manifest_hash,
    exact_compiler_identity: inputs.exactIdentity,
    historical_resolved_draft_v3_ref: HISTORICAL_DRAFT_V3_PATH,
    historical_resolved_draft_v3_hash: HISTORICAL_DRAFT_V3_HASH,
    actual_candidate_output_status: 'bound_review_comparison_only',
    review_input_status: 'published_pending_fresh_human_review',
    expected_golden_oracle_status: 'all_null',
    expected_full_case_result_bytes_authored: 0,
    human_judgment_coverage: 0,
    pending_case_count: 40,
    golden_semantic_review_status: 'not_run',
    approval_status: 'not_run',
    golden_seal_status: 'not_run',
    conformance_sealed_write_status: 'not_run',
    g3_through_g9_status: 'not_started',
    r017_status: 'OPEN_BLOCKING_G2',
    case_count: 40,
    positive_case_count: 11,
    negative_case_count: 29,
    generated_artifact_count: 4,
    generator_source_raw_hash: rawHash(
      fs.readFileSync(path.join(contractsRoot, 'semantic-correction-draft.ts')),
    ),
  };
  return artifact(
    'icarus.workflow-compiler-golden-draft-manifest/4',
    'icarus.workflow-compiler-golden-draft-manifest',
    '4.0.0',
    MANIFEST_DOMAIN,
    {
      ...withoutHash,
      manifest_hash: domainSeparatedSha256(MANIFEST_DOMAIN, withoutHash),
    },
  );
}

export function buildSemanticCorrectionDraftExpectedArtifactsForTest(): Array<
  [string, ContractArtifactEnvelope]
> {
  const inputs = loadInputs();
  const cases = buildCasesArtifact(inputs);
  const handoff = buildHandoffArtifact(cases);
  const leafArtifacts: Array<[string, ContractArtifactEnvelope]> = [
    [SEMANTIC_CORRECTION_DRAFT_CASES_PATH, cases],
    [SEMANTIC_CORRECTION_DRAFT_HANDOFF_PATH, handoff],
  ];
  const inventory = buildInventoryArtifact(leafArtifacts);
  const manifest = buildManifestArtifact(inputs, cases, handoff, inventory);
  const artifacts: Array<[string, ContractArtifactEnvelope]> = [
    ...leafArtifacts,
    [SEMANTIC_CORRECTION_DRAFT_INVENTORY_PATH, inventory],
    [SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH, manifest],
  ];
  return artifacts.sort(([left], [right]) => left.localeCompare(right));
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolutePath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function listTree(): string[] {
  const root = absolutePath(SEMANTIC_CORRECTION_DRAFT_ROOT);
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new SemanticCorrectionDraftError('Draft tree contains a symlink');
      }
      if (stat.isDirectory()) visit(absolute);
      else {
        files.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
      }
    }
  };
  visit(root);
  return files.sort();
}

function validateBoundaries(): void {
  const sealed = fs.readdirSync(absolutePath('conformance/sealed'));
  if (sealed.length !== 1 || sealed[0] !== '.gitkeep') {
    throw new SemanticCorrectionDraftError(
      'Semantic correction Draft crossed sealed boundary',
    );
  }
}

export function generateSemanticCorrectionDraft(): ContractArtifactEnvelope {
  validateBoundaries();
  const artifacts = buildSemanticCorrectionDraftExpectedArtifactsForTest();
  for (const [relativePath, value] of artifacts) {
    writeAtomic(relativePath, render(value));
  }
  if (
    JSON.stringify(listTree()) !==
    JSON.stringify(artifacts.map(([relativePath]) => relativePath).sort())
  ) {
    throw new SemanticCorrectionDraftError('Generated Draft file set drift');
  }
  return artifacts.find(
    ([relativePath]) =>
      relativePath === SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH,
  )![1];
}

export function checkSemanticCorrectionDraft(): ContractArtifactEnvelope {
  validateBoundaries();
  const artifacts = buildSemanticCorrectionDraftExpectedArtifactsForTest();
  const expectedPaths = artifacts.map(([relativePath]) => relativePath).sort();
  if (JSON.stringify(listTree()) !== JSON.stringify(expectedPaths)) {
    throw new SemanticCorrectionDraftError('Published Draft file set drift');
  }
  for (const [relativePath, value] of artifacts) {
    if (fs.readFileSync(absolutePath(relativePath), 'utf8') !== render(value)) {
      throw new SemanticCorrectionDraftError(
        `Published Draft bytes drift: ${relativePath}`,
      );
    }
  }
  return artifacts.find(
    ([relativePath]) =>
      relativePath === SEMANTIC_CORRECTION_DRAFT_MANIFEST_PATH,
  )![1];
}
