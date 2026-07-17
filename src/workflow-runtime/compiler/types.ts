import type {
  CompilerConformanceDiagnosticV1,
  CompiledScopePlanV2Document,
  WorkflowCompilerConformanceCaseResultV1,
} from '../contracts/compiler-contract-repair-types.js';
import type {
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';

export type WorkflowCompilerSourceKind =
  | 'graph_scope'
  | 'workflow_definition'
  | 'workflow_schema';

export interface WorkflowCompilerIdentity {
  compiler_toolchain_manifest_ref: VersionedRef;
  compiler_toolchain_hash: Sha256Hash;
  compiler_version: string;
  compiler_build_hash: Sha256Hash;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: Sha256Hash;
  proof_algorithm_version: string;
  proof_algorithm_hash: Sha256Hash;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
}

export interface WorkflowCompilerToolchainManifest extends JsonObject {
  format: 'icarus.workflow-compiler-toolchain-manifest/1';
  ref: VersionedRef;
  compiler_version: string;
  runtime: {
    node_version: string;
    npm_version: string;
    managed_runtime_manifest_ref: string;
    managed_runtime_manifest_hash: Sha256Hash;
  };
  package_lock_hash: Sha256Hash;
  locked_packages: Array<{
    name: string;
    version: string;
    integrity: string;
  }>;
  strict_parser: {
    package: string;
    version: string;
    wrapper_ref: string;
    wrapper_hash: Sha256Hash;
  };
  schema_profile: {
    version: string;
    graph_schema_ref: string;
    graph_schema_hash: Sha256Hash;
    definition_schema_ref: string;
    definition_schema_hash: Sha256Hash;
    profile_hash: Sha256Hash;
  };
  canonical_normalizer: {
    version: string;
    implementation_refs: string[];
    implementation_hash: Sha256Hash;
  };
  proof_algorithm: {
    version: string;
    implementation_refs: string[];
    implementation_hash: Sha256Hash;
  };
  compiler_build: {
    implementation_refs: string[];
    implementation_hash: Sha256Hash;
  };
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
  toolchain_hash: Sha256Hash;
}

export interface WorkflowCompilerRequest {
  caseId: string;
  sourceKind: WorkflowCompilerSourceKind;
  rawSourceBytes: Uint8Array;
  inputSnapshot: JsonObject;
  identity: WorkflowCompilerIdentity;
}

export interface WorkflowCompilerSuccess {
  sourceHash: Sha256Hash;
  plan: CompiledScopePlanV2Document;
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
