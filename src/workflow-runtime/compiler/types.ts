import type {
  CompilerConformanceDiagnosticV1,
  CompiledScopePlanV2Document,
  WorkflowCompilerConformanceCaseResultV1,
} from '../contracts/compiler-contract-repair-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowCompilerStaticChildPlanBundle } from '../contracts/static-child-plan-bundle-types.js';

export type WorkflowCompilerSourceKind =
  | 'graph_scope'
  | 'workflow_definition'
  | 'workflow_schema';

export interface WorkflowCompilerRequest {
  caseId: string;
  sourceKind: WorkflowCompilerSourceKind;
  rawSourceBytes: Uint8Array;
  inputSnapshot: JsonObject;
}

export interface WorkflowCompilerSuccess {
  sourceHash: Sha256Hash;
  plan: CompiledScopePlanV2Document;
  staticChildPlanBundle: WorkflowCompilerStaticChildPlanBundle;
  proofHashes: Sha256Hash[];
  programHashes: Sha256Hash[];
  staticLowering: boolean;
}

export interface WorkflowCompilerFailure {
  sourceHash: Sha256Hash | null;
  diagnostics: CompilerConformanceDiagnosticV1[];
}

export type WorkflowCompilerOutcome =
  | { ok: true; value: WorkflowCompilerSuccess }
  | { ok: false; value: WorkflowCompilerFailure };

export type WorkflowCompilerCaseResult =
  WorkflowCompilerConformanceCaseResultV1;
