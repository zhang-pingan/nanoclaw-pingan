import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import type {
  CompilerG2CaseInputBindingEntryV1,
  CompilerG2CaseInputBindingV1,
  WorkflowCompilerConformanceCaseResultV1,
} from '../contracts/compiler-contract-repair-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
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
import {
  compileWorkflow,
  STATIC_LOWERING_CONTRACT_HASH,
  STATIC_LOWERING_CONTRACT_REF,
} from './compiler.js';
import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from './identity.js';
import type {
  WorkflowCompilerIdentity,
  WorkflowCompilerSourceKind,
  WorkflowCompilerToolchainManifest,
} from './types.js';

const compilerRoot = import.meta.dirname;
const repoRoot = path.resolve(compilerRoot, '../../..');
const contractsRoot = path.join(repoRoot, 'src/workflow-runtime/contracts');

export const G2_CANDIDATE_ROOT = 'conformance/candidate/g2';
export const G2_TOOLCHAIN_PATH = `${G2_CANDIDATE_ROOT}/workflow-compiler-toolchain@2.json`;
export const G2_BINDING_PATH = `${G2_CANDIDATE_ROOT}/g2-case-input-binding@1.json`;
export const G2_RESULTS_MANIFEST_PATH = `${G2_CANDIDATE_ROOT}/candidate-results-manifest@1.json`;
export const G2_ROOT_MANIFEST_PATH = `${G2_CANDIDATE_ROOT}/contract-pack-g2-production-compiler.json`;

const HISTORICAL_MANIFEST_REF = 'contract-pack-golden-draft.json';
const HISTORICAL_MANIFEST_HASH =
  'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22' as const;
const HISTORICAL_CATALOG_REF = 'conformance/draft/golden-draft-cases@1.json';
const HISTORICAL_CATALOG_HASH =
  'sha256:20be39783a5c775c0d804ce16db683540b72bcc2aa1750f9f1b93c9b7c1c4aa3' as const;
const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';
const EFFECTIVE_INPUT_DOMAIN =
  'icarus:workflow-compiler-effective-case-input:1\n';
const BINDING_DOMAIN = 'icarus:workflow-compiler-g2-case-input-binding:1\n';

interface HistoricalCase extends JsonObject {
  case_id: string;
  source_kind: WorkflowCompilerSourceKind;
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  input_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
}

export interface G2CandidateResultsManifest extends JsonObject {
  format: 'icarus.workflow-compiler-candidate-results-manifest/1';
  candidate_version: string;
  disposition: 'actual_compiler_output_not_golden_oracle';
  compiler_toolchain_ref: string;
  compiler_toolchain_hash: Sha256Hash;
  case_input_binding_ref: string;
  case_input_binding_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
  case_results: Array<{
    case_id: string;
    outcome: 'compiled' | 'rejected';
    result_ref: string;
    result_hash: Sha256Hash;
    result_raw_bytes_hash: Sha256Hash;
  }>;
  compiled_count: number;
  rejected_count: number;
  manifest_hash: Sha256Hash;
}

function contractBytes(relativePath: string): Buffer {
  const absolutePath = path.resolve(contractsRoot, relativePath);
  if (!absolutePath.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `G2 conformance path escapes contracts root: ${relativePath}`,
    );
  }
  return fs.readFileSync(absolutePath);
}

function contractArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(contractBytes(relativePath)),
  );
}

function rawHash(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function historicalRawSourceHash(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto
    .createHash('sha256')
    .update('icarus:workflow-golden-draft-raw-source-bytes:1\n', 'ascii')
    .update(bytes)
    .digest('hex')}`;
}

export function renderCompilerJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function historicalCases(): HistoricalCase[] {
  const catalog = contractArtifact(HISTORICAL_CATALOG_REF);
  if (catalog.hash !== HISTORICAL_CATALOG_HASH) {
    throw new Error('Historical G0.8 case catalog identity drift');
  }
  if (!Array.isArray(catalog.payload.cases)) {
    throw new Error('Historical G0.8 cases are missing');
  }
  return catalog.payload.cases.map((value) => {
    assertJsonObject(value);
    return value as HistoricalCase;
  });
}

function calculateResultHash(
  value: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(RESULT_DOMAIN, value as unknown as JsonValue);
}

export function compileConformanceCase(
  candidate: HistoricalCase,
  identity: WorkflowCompilerIdentity,
): WorkflowCompilerConformanceCaseResultV1 {
  const rawSourceBytes = contractBytes(candidate.raw_source_bytes_ref);
  if (
    historicalRawSourceHash(rawSourceBytes) !== candidate.raw_source_bytes_hash
  ) {
    throw new Error(`Raw case input drift: ${candidate.case_id}`);
  }
  const snapshotArtifact = contractArtifact(candidate.input_snapshot_ref);
  if (snapshotArtifact.hash !== candidate.input_snapshot_hash) {
    throw new Error(`Historical snapshot drift: ${candidate.case_id}`);
  }
  const outcome = compileWorkflow({
    caseId: candidate.case_id,
    sourceKind: candidate.source_kind,
    rawSourceBytes,
    inputSnapshot: snapshotArtifact.payload,
    identity,
  });
  if (!outcome.ok) {
    const withoutHash = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: candidate.case_id,
      source_kind: candidate.source_kind,
      source_hash: outcome.value.sourceHash,
      outcome: 'rejected' as const,
      normalized_plan: null,
      static_lowering_contract_ref: null,
      static_lowering_contract_hash: null,
      diagnostics: outcome.value.diagnostics,
      proof_hashes: [] as Sha256Hash[],
      program_hashes: [] as Sha256Hash[],
    };
    return { ...withoutHash, result_hash: calculateResultHash(withoutHash) };
  }
  const withoutHash = {
    format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
    case_id: candidate.case_id,
    source_kind: candidate.source_kind,
    source_hash: outcome.value.sourceHash,
    outcome: 'compiled' as const,
    normalized_plan: outcome.value.plan,
    static_lowering_contract_ref: outcome.value.staticLowering
      ? STATIC_LOWERING_CONTRACT_REF
      : null,
    static_lowering_contract_hash: outcome.value.staticLowering
      ? STATIC_LOWERING_CONTRACT_HASH
      : null,
    diagnostics: [] as [],
    proof_hashes: outcome.value.proofHashes,
    program_hashes: outcome.value.programHashes,
  };
  return { ...withoutHash, result_hash: calculateResultHash(withoutHash) };
}

function effectiveInputHash(
  binding: Omit<CompilerG2CaseInputBindingV1, 'case_inputs' | 'binding_hash'>,
  entry: Omit<CompilerG2CaseInputBindingEntryV1, 'effective_case_input_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(EFFECTIVE_INPUT_DOMAIN, {
    case_id: entry.case_id,
    raw_source_bytes_ref: entry.raw_source_bytes_ref,
    raw_source_bytes_hash: entry.raw_source_bytes_hash,
    historical_input_snapshot_ref: entry.historical_input_snapshot_ref,
    historical_input_snapshot_hash: entry.historical_input_snapshot_hash,
    compiler_toolchain_manifest_ref: binding.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash: binding.compiler_toolchain_hash,
    compiler_version: binding.compiler_version,
    compiler_build_hash: binding.compiler_build_hash,
    canonical_normalizer_version: binding.canonical_normalizer_version,
    canonical_normalizer_hash: binding.canonical_normalizer_hash,
    proof_algorithm_version: binding.proof_algorithm_version,
    proof_algorithm_hash: binding.proof_algorithm_hash,
    error_catalog_ref: binding.error_catalog_ref,
    error_catalog_hash: binding.error_catalog_hash,
    compiled_ir_schema_ref: binding.compiled_ir_schema_ref,
    compiled_ir_schema_hash: binding.compiled_ir_schema_hash,
    conformance_result_schema_ref: binding.conformance_result_schema_ref,
    conformance_result_schema_hash: binding.conformance_result_schema_hash,
  });
}

export function buildResolvedCaseInputBinding(
  identity: WorkflowCompilerIdentity,
): CompilerG2CaseInputBindingV1 {
  const common = {
    format: 'icarus.workflow-compiler-g2-case-input-binding/1' as const,
    binding_version: '1.0.0-production-compiler',
    historical_g0_8_manifest_ref: HISTORICAL_MANIFEST_REF,
    historical_g0_8_manifest_hash: HISTORICAL_MANIFEST_HASH,
    historical_case_catalog_ref: HISTORICAL_CATALOG_REF,
    historical_case_catalog_hash: HISTORICAL_CATALOG_HASH,
    compiler_toolchain_manifest_ref: identity.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash: identity.compiler_toolchain_hash,
    compiler_version: identity.compiler_version,
    compiler_build_hash: identity.compiler_build_hash,
    canonical_normalizer_version: identity.canonical_normalizer_version,
    canonical_normalizer_hash: identity.canonical_normalizer_hash,
    proof_algorithm_version: identity.proof_algorithm_version,
    proof_algorithm_hash: identity.proof_algorithm_hash,
    error_catalog_ref: identity.error_catalog_ref,
    error_catalog_hash: identity.error_catalog_hash,
    compiled_ir_schema_ref: identity.compiled_ir_schema_ref,
    compiled_ir_schema_hash: identity.compiled_ir_schema_hash,
    conformance_result_schema_ref: identity.conformance_result_schema_ref,
    conformance_result_schema_hash: identity.conformance_result_schema_hash,
  };
  const caseInputs = historicalCases().map((candidate) => {
    const withoutHash = {
      case_id: candidate.case_id,
      raw_source_bytes_ref: candidate.raw_source_bytes_ref,
      raw_source_bytes_hash: candidate.raw_source_bytes_hash,
      historical_input_snapshot_ref: candidate.input_snapshot_ref,
      historical_input_snapshot_hash: candidate.input_snapshot_hash,
    };
    return {
      ...withoutHash,
      effective_case_input_hash: effectiveInputHash(common, withoutHash),
    };
  });
  const withoutHash = { ...common, case_inputs: caseInputs };
  return {
    ...withoutHash,
    binding_hash: domainSeparatedSha256(BINDING_DOMAIN, withoutHash),
  };
}

export interface BuiltG2Candidates {
  toolchain: WorkflowCompilerToolchainManifest;
  identity: WorkflowCompilerIdentity;
  binding: CompilerG2CaseInputBindingV1;
  results: WorkflowCompilerConformanceCaseResultV1[];
  resultsManifest: G2CandidateResultsManifest;
}

export function buildG2Candidates(): BuiltG2Candidates {
  const toolchain = buildWorkflowCompilerToolchainManifest();
  const identity = workflowCompilerIdentity(toolchain);
  const binding = buildResolvedCaseInputBinding(identity);
  const results = historicalCases().map((candidate) =>
    compileConformanceCase(candidate, identity),
  );
  const caseResults = results.map((result) => {
    const resultRef = `${G2_CANDIDATE_ROOT}/cases/${result.case_id}.result.json`;
    return {
      case_id: result.case_id,
      outcome: result.outcome,
      result_ref: resultRef,
      result_hash: result.result_hash,
      result_raw_bytes_hash: rawHash(
        Buffer.from(renderCompilerJson(result), 'utf8'),
      ),
    };
  });
  const withoutHash = {
    format: 'icarus.workflow-compiler-candidate-results-manifest/1' as const,
    candidate_version: '1.0.0-production-compiler',
    disposition: 'actual_compiler_output_not_golden_oracle' as const,
    compiler_toolchain_ref: G2_TOOLCHAIN_PATH,
    compiler_toolchain_hash: toolchain.toolchain_hash,
    case_input_binding_ref: G2_BINDING_PATH,
    case_input_binding_hash: binding.binding_hash,
    conformance_result_schema_ref: identity.conformance_result_schema_ref,
    conformance_result_schema_hash: identity.conformance_result_schema_hash,
    case_results: caseResults,
    compiled_count: results.filter((result) => result.outcome === 'compiled')
      .length,
    rejected_count: results.filter((result) => result.outcome === 'rejected')
      .length,
  };
  return {
    toolchain,
    identity,
    binding,
    results,
    resultsManifest: {
      ...withoutHash,
      manifest_hash: domainSeparatedSha256(
        'icarus:workflow-compiler-candidate-results-manifest:1\n',
        withoutHash,
      ),
    },
  };
}
