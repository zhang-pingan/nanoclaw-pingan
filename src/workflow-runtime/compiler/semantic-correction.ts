import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import {
  type BuiltSemanticCorrectionInputs,
  SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
  SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH,
  SEMANTIC_CORRECTION_INPUT_ROOT,
  buildSemanticCorrectionInputs,
  type SemanticCorrectionCaseInput,
  type SemanticCorrectionCompilerIdentity,
} from '../contracts/compiler-semantic-correction-inputs.js';
import {
  checkCompilerSemanticCorrectionContract,
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
} from '../contracts/compiler-semantic-correction-contract.js';
import {
  calculateArtifactHash,
  domainSeparatedSha256,
} from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';
import { checkG2ProductionCompilerArtifacts } from './artifacts.js';
import { compileWorkflow } from './compiler.js';
import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from './identity.js';
import type { WorkflowCompilerConformanceCaseResultV1 } from '../contracts/compiler-contract-repair-types.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');

export const G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT =
  'conformance/candidate/g2-semantic-correction-v2';
export const G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH = `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/workflow-compiler-toolchain@3.json`;
export const G2_SEMANTIC_CORRECTION_BINDING_PATH = `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/g2-case-input-binding@2.json`;
export const G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH = `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/candidate-results-manifest@2.json`;
export const G2_SEMANTIC_CORRECTION_ROOT_MANIFEST_PATH = `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/contract-pack-g2-semantic-correction-candidate.json`;

const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const EFFECTIVE_INPUT_DOMAIN =
  'icarus:workflow-compiler-effective-case-input:2\n';
const BINDING_DOMAIN = 'icarus:workflow-compiler-g2-case-input-binding:2\n';
const RESULTS_MANIFEST_DOMAIN =
  'icarus:workflow-compiler-candidate-results-manifest:2\n';
const ROOT_DOMAIN =
  'icarus:workflow-contract-pack-g2-semantic-correction-candidate:1\n';

function absolutePath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `G2 semantic correction path escapes root: ${relativePath}`,
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
  version: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const revision = Number(format.slice(format.lastIndexOf('/') + 1));
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version },
    version: revision,
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function resultHash(
  result: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(RESULT_DOMAIN, result as JsonValue);
}

function compileCase(
  input: SemanticCorrectionCaseInput,
  inputs: BuiltSemanticCorrectionInputs,
  identity: SemanticCorrectionCompilerIdentity,
): WorkflowCompilerConformanceCaseResultV1 {
  const sourceText = inputs.files.get(input.raw_source_bytes_ref);
  const snapshotText = inputs.files.get(input.input_snapshot_ref);
  if (!sourceText || !snapshotText) {
    throw new Error(`Missing working case input: ${input.case_id}`);
  }
  const snapshotArtifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(Buffer.from(snapshotText, 'utf8')),
  );
  const outcome = compileWorkflow({
    caseId: input.case_id,
    sourceKind: input.source_kind,
    rawSourceBytes: Buffer.from(sourceText, 'utf8'),
    inputSnapshot: snapshotArtifact.payload,
    identity,
  });
  if (!outcome.ok) {
    const withoutHash = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: input.case_id,
      source_kind: input.source_kind,
      source_hash: outcome.value.sourceHash,
      outcome: 'rejected' as const,
      normalized_plan: null,
      static_lowering_contract_ref: null,
      static_lowering_contract_hash: null,
      diagnostics: outcome.value.diagnostics,
      proof_hashes: [] as Sha256Hash[],
      program_hashes: [] as Sha256Hash[],
    };
    return { ...withoutHash, result_hash: resultHash(withoutHash) };
  }
  const withoutHash = {
    format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
    case_id: input.case_id,
    source_kind: input.source_kind,
    source_hash: outcome.value.sourceHash,
    outcome: 'compiled' as const,
    normalized_plan: outcome.value.plan,
    static_lowering_contract_ref: outcome.value.staticLowering
      ? {
          id: 'icarus.workflow-definition-static-lowering-contract',
          version: '1.0.0',
        }
      : null,
    static_lowering_contract_hash: outcome.value.staticLowering
      ? ('sha256:905b433c6909d6e61663a65d532850f60b0e62a9c6c5f039a1280e3dad44b430' as const)
      : null,
    diagnostics: [] as [],
    proof_hashes: outcome.value.proofHashes,
    program_hashes: outcome.value.programHashes,
  };
  return { ...withoutHash, result_hash: resultHash(withoutHash) };
}

function buildBinding(
  identity: SemanticCorrectionCompilerIdentity,
  inputs: BuiltSemanticCorrectionInputs,
): JsonObject {
  const common: JsonObject = {
    format: 'icarus.workflow-compiler-g2-case-input-binding/2',
    binding_version: 'working-g2',
    semantic_correction_contract_ref:
      COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
    semantic_correction_input_manifest_ref:
      SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH,
    semantic_correction_input_manifest_hash: inputs.manifest.hash,
    case_catalog_ref: SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
    case_catalog_hash: inputs.catalog.hash,
    ...identity,
  };
  const caseInputs = inputs.cases.map((entry) => {
    const withoutHash = {
      case_id: entry.case_id,
      raw_source_bytes_ref: entry.raw_source_bytes_ref,
      raw_source_bytes_hash: entry.raw_source_bytes_hash,
      input_snapshot_ref: entry.input_snapshot_ref,
      input_snapshot_hash: entry.input_snapshot_hash,
    };
    return {
      ...withoutHash,
      effective_case_input_hash: domainSeparatedSha256(EFFECTIVE_INPUT_DOMAIN, {
        ...withoutHash,
        identity,
      }),
    };
  });
  const withoutHash = { ...common, case_inputs: caseInputs };
  return {
    ...withoutHash,
    binding_hash: domainSeparatedSha256(BINDING_DOMAIN, withoutHash),
  };
}

export interface BuiltSemanticCorrectionCandidate {
  files: Map<string, string>;
  inputs: BuiltSemanticCorrectionInputs;
  results: WorkflowCompilerConformanceCaseResultV1[];
  toolchainHash: Sha256Hash;
  bindingHash: Sha256Hash;
  resultsManifestHash: Sha256Hash;
  root: ContractArtifactEnvelope;
}

export function buildSemanticCorrectionCandidate(): BuiltSemanticCorrectionCandidate {
  checkCompilerSemanticCorrectionContract();
  checkG2ProductionCompilerArtifacts();
  const toolchain = buildWorkflowCompilerToolchainManifest();
  const identity = workflowCompilerIdentity(
    toolchain,
  ) as SemanticCorrectionCompilerIdentity;
  const inputs = buildSemanticCorrectionInputs(identity);
  const binding = buildBinding(identity, inputs);
  const results = inputs.cases.map((entry) =>
    compileCase(entry, inputs, identity),
  );
  const candidateFiles = new Map<string, string>();
  candidateFiles.set(G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH, render(toolchain));
  candidateFiles.set(G2_SEMANTIC_CORRECTION_BINDING_PATH, render(binding));
  for (const result of results) {
    candidateFiles.set(
      `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/cases/${result.case_id}.result.json`,
      render(result),
    );
  }
  const resultEntries = results.map((result) => {
    const resultRef = `${G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT}/cases/${result.case_id}.result.json`;
    return {
      case_id: result.case_id,
      outcome: result.outcome,
      result_ref: resultRef,
      result_hash: result.result_hash,
      result_raw_bytes_hash: rawHash(
        Buffer.from(candidateFiles.get(resultRef) ?? '', 'utf8'),
      ),
    };
  });
  const manifestWithoutHash = {
    format: 'icarus.workflow-compiler-candidate-results-manifest/2',
    candidate_version: 'working-g2',
    disposition: 'actual_compiler_output_not_golden_oracle',
    compiler_toolchain_ref: G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH,
    compiler_toolchain_hash: toolchain.toolchain_hash,
    case_input_binding_ref: G2_SEMANTIC_CORRECTION_BINDING_PATH,
    case_input_binding_hash: binding.binding_hash,
    case_results: resultEntries,
    compiled_count: results.filter((result) => result.outcome === 'compiled')
      .length,
    rejected_count: results.filter((result) => result.outcome === 'rejected')
      .length,
    expected_oracle_status: 'absent_working_not_review_candidate',
  };
  const resultsManifest = {
    ...manifestWithoutHash,
    manifest_hash: domainSeparatedSha256(
      RESULTS_MANIFEST_DOMAIN,
      manifestWithoutHash,
    ),
  };
  candidateFiles.set(
    G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH,
    render(resultsManifest),
  );
  const inventory = [...candidateFiles.entries()]
    .map(([artifactPath, contents]) => ({
      path: artifactPath,
      raw_sha256: rawHash(Buffer.from(contents, 'utf8')),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const root = artifact(
    'icarus.workflow-contract-pack-g2-semantic-correction-candidate/1',
    'icarus.workflow-contract-pack-g2-semantic-correction-candidate',
    '1.0.0',
    ROOT_DOMAIN,
    {
      gate: 'G2',
      status: 'WORKING_COMPILER_COMPARISON',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      semantic_correction_contract_ref:
        COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
      semantic_correction_input_manifest_ref:
        SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH,
      semantic_correction_input_manifest_hash: inputs.manifest.hash,
      compiler_toolchain_ref: G2_SEMANTIC_CORRECTION_TOOLCHAIN_PATH,
      compiler_toolchain_hash: toolchain.toolchain_hash,
      compiler_build_hash: identity.compiler_build_hash,
      case_input_binding_ref: G2_SEMANTIC_CORRECTION_BINDING_PATH,
      case_input_binding_hash: binding.binding_hash,
      candidate_results_manifest_ref:
        G2_SEMANTIC_CORRECTION_RESULTS_MANIFEST_PATH,
      candidate_results_manifest_hash: resultsManifest.manifest_hash,
      candidate_disposition: 'actual_compiler_output_not_golden_oracle',
      case_count: 40,
      compiled_count: resultsManifest.compiled_count,
      rejected_count: resultsManifest.rejected_count,
      construction_seed_g2_root:
        'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77',
      construction_seed_candidate_manifest:
        'sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2',
      artifact_inventory: inventory,
      human_review_status: 'not_requested_until_prepare_rc',
      golden_semantic_review_status: 'not_run',
      approval_status: 'not_run',
      golden_seal_status: 'not_run',
      sealed_write_status: 'not_run',
      g3_through_g9_status: 'not_started',
    },
  );
  candidateFiles.set(G2_SEMANTIC_CORRECTION_ROOT_MANIFEST_PATH, render(root));
  const files = new Map([...inputs.files, ...candidateFiles]);
  return {
    files,
    inputs,
    results,
    toolchainHash: toolchain.toolchain_hash,
    bindingHash: binding.binding_hash as Sha256Hash,
    resultsManifestHash: resultsManifest.manifest_hash,
    root,
  };
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolutePath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function listTree(relativeRoot: string): string[] {
  const root = absolutePath(relativeRoot);
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`Generated tree symlink: ${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else
        output.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
    }
  };
  visit(root);
  return output.sort();
}

function validateFileSets(files: Map<string, string>): void {
  for (const root of [
    SEMANTIC_CORRECTION_INPUT_ROOT,
    G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT,
  ]) {
    const expected = [...files.keys()]
      .filter((file) => file.startsWith(`${root}/`))
      .sort();
    if (JSON.stringify(listTree(root)) !== JSON.stringify(expected)) {
      throw new Error(`G2 semantic correction inventory drift: ${root}`);
    }
  }
}

function validateBoundaries(): void {
  const sealed = fs.readdirSync(absolutePath('conformance/sealed'));
  if (sealed.length !== 1 || sealed[0] !== '.gitkeep') {
    throw new Error('G2 semantic correction crossed sealed boundary');
  }
}

export function generateSemanticCorrectionCandidate(): ContractArtifactEnvelope {
  validateBoundaries();
  const built = buildSemanticCorrectionCandidate();
  for (const [relativePath, contents] of built.files)
    writeAtomic(relativePath, contents);
  validateFileSets(built.files);
  return built.root;
}

export function checkSemanticCorrectionCandidate(): ContractArtifactEnvelope {
  validateBoundaries();
  const built = buildSemanticCorrectionCandidate();
  validateFileSets(built.files);
  for (const [relativePath, contents] of built.files) {
    if (fs.readFileSync(absolutePath(relativePath), 'utf8') !== contents) {
      throw new Error(`G2 semantic correction bytes drift: ${relativePath}`);
    }
  }
  return built.root;
}

export function readSemanticCorrectionResult(
  relativePath: string,
): WorkflowCompilerConformanceCaseResultV1 {
  const value = strictParseJsonBytes(
    fs.readFileSync(absolutePath(relativePath)),
  );
  assertJsonObject(value);
  return value as unknown as WorkflowCompilerConformanceCaseResultV1;
}
