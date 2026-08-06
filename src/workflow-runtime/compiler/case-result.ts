import type { WorkflowCompilerConformanceCaseResultV1 } from '../contracts/compiler-contract-repair-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  compileWorkflow,
  STATIC_LOWERING_CONTRACT_HASH,
  STATIC_LOWERING_CONTRACT_REF,
} from './compiler.js';
import type { WorkflowCompilerSourceKind } from './types.js';

const RESULT_DOMAIN = 'icarus:workflow-compiler-conformance-case-result:1\n';

function resultHash(
  result: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(RESULT_DOMAIN, result as unknown as JsonValue);
}

export function compileWorkflowCase(
  caseId: string,
  sourceKind: WorkflowCompilerSourceKind,
  sourceBytes: Uint8Array,
  snapshot: JsonValue,
): WorkflowCompilerConformanceCaseResultV1 {
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    throw new Error(`Golden snapshot must be an object: ${caseId}`);
  }
  const outcome = compileWorkflow({
    caseId,
    sourceKind,
    rawSourceBytes: sourceBytes,
    inputSnapshot: snapshot,
  });
  if (!outcome.ok) {
    const withoutHash = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: caseId,
      source_kind: sourceKind,
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
    case_id: caseId,
    source_kind: sourceKind,
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
  return { ...withoutHash, result_hash: resultHash(withoutHash) };
}
