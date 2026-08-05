import { canonicalJson } from '../contracts/hash.js';
import type { G3RegistryExactResourceQueryInput } from '../contracts/g3-registry-exact-resource-query-types.js';
import type {
  G3RegistryResourceIdentity,
  G3RegistrySnapshotPreflightCode,
} from '../contracts/g3-registry-persistence-types.js';
import { compareAscii } from '../contracts/g3-registry-persistence.js';
import {
  buildAcceptedRetentionExecutorAbiResult,
  buildRejectedRetentionExecutorAbiResult,
  requestedSideEffect,
  validateRetentionExecutorAbiPreflightInput,
  verifyClosureExpectation,
  verifyRetentionFacts,
  G3RetentionExecutorAbiContractError,
} from '../contracts/g3-retention-executor-abi-preflight.js';
import type {
  G3RetentionExecutorAbiErrorCode,
  G3RetentionExecutorAbiPreflightInput,
  G3RetentionExecutorAbiPreflightResult,
} from '../contracts/g3-retention-executor-abi-preflight-types.js';
import type { JsonObject, VersionedRef } from '../contracts/types.js';
import { parseVersionedRef } from '../contracts/versioned-ref.js';
import type { WorkflowRuntimeReadConnection } from './runtime-store/index.js';
import { preflightRegistrySnapshot } from './registry-persistence.js';
import { queryExactRegistryResource } from './registry-resource-query.js';

export type RetentionExecutorAbiReadConnection = Pick<
  WorkflowRuntimeReadConnection,
  'queryAll' | 'queryOne'
>;

interface FeatureExecutionArtifactContent extends JsonObject {
  ref: VersionedRef;
  feature_release_ref: VersionedRef;
  runtime_kind: 'node_bundle';
  artifact_ref: string;
  artifact_hash: string;
  entry_symbols: string[];
  runtime_abi_major: number;
  dependency_manifest_ref: string;
  dependency_manifest_hash: string;
}

interface ExecutorImplementationContent extends JsonObject {
  ref: VersionedRef;
  provider_feature_ref: VersionedRef;
  execution_artifact_ref: VersionedRef;
  execution_artifact_hash: string;
  entry_symbol: string;
  runtime_abi_major: number;
  implementation_hash: string;
}

interface VerifiedArtifact {
  query: G3RegistryExactResourceQueryInput;
  content: FeatureExecutionArtifactContent;
}

interface VerifiedExecutor {
  query: G3RegistryExactResourceQueryInput;
  content: ExecutorImplementationContent;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_KEYS = [
  'artifact_hash',
  'artifact_ref',
  'dependency_manifest_hash',
  'dependency_manifest_ref',
  'entry_symbols',
  'feature_release_ref',
  'ref',
  'runtime_abi_major',
  'runtime_kind',
];
const EXECUTOR_KEYS = [
  'entry_symbol',
  'execution_artifact_hash',
  'execution_artifact_ref',
  'implementation_hash',
  'provider_feature_ref',
  'ref',
  'runtime_abi_major',
];

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function isExactObject(value: unknown, keys: string[]): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson(keys)
  );
}

function isVersionedRef(value: unknown): value is VersionedRef {
  if (!isExactObject(value, ['id', 'version'])) return false;
  try {
    parseVersionedRef(value);
    return true;
  } catch {
    return false;
  }
}

function parseArtifactContent(
  content: JsonObject,
  query: G3RegistryExactResourceQueryInput,
): FeatureExecutionArtifactContent | null {
  if (
    !isExactObject(content, ARTIFACT_KEYS) ||
    !isVersionedRef(content.ref) ||
    !sameRef(content.ref, query.ref) ||
    !isVersionedRef(content.feature_release_ref) ||
    content.runtime_kind !== 'node_bundle' ||
    typeof content.artifact_ref !== 'string' ||
    content.artifact_ref.length === 0 ||
    typeof content.artifact_hash !== 'string' ||
    !HASH_PATTERN.test(content.artifact_hash) ||
    !Array.isArray(content.entry_symbols) ||
    content.entry_symbols.length === 0 ||
    content.entry_symbols.some(
      (entry) => typeof entry !== 'string' || entry.length === 0,
    ) ||
    new Set(content.entry_symbols).size !== content.entry_symbols.length ||
    !Number.isSafeInteger(content.runtime_abi_major) ||
    Number(content.runtime_abi_major) < 1 ||
    typeof content.dependency_manifest_ref !== 'string' ||
    content.dependency_manifest_ref.length === 0 ||
    typeof content.dependency_manifest_hash !== 'string' ||
    !HASH_PATTERN.test(content.dependency_manifest_hash)
  ) {
    return null;
  }
  return content as FeatureExecutionArtifactContent;
}

function parseExecutorContent(
  content: JsonObject,
  query: G3RegistryExactResourceQueryInput,
): ExecutorImplementationContent | null {
  if (
    !isExactObject(content, EXECUTOR_KEYS) ||
    !isVersionedRef(content.ref) ||
    !sameRef(content.ref, query.ref) ||
    !isVersionedRef(content.provider_feature_ref) ||
    !isVersionedRef(content.execution_artifact_ref) ||
    typeof content.execution_artifact_hash !== 'string' ||
    !HASH_PATTERN.test(content.execution_artifact_hash) ||
    typeof content.entry_symbol !== 'string' ||
    content.entry_symbol.length === 0 ||
    !Number.isSafeInteger(content.runtime_abi_major) ||
    Number(content.runtime_abi_major) < 1 ||
    typeof content.implementation_hash !== 'string' ||
    !HASH_PATTERN.test(content.implementation_hash)
  ) {
    return null;
  }
  return content as ExecutorImplementationContent;
}

function identityKey(identity: G3RegistryResourceIdentity): string {
  return `${identity.resource_type}\0${identity.ref.id}@${identity.ref.version}`;
}

function queryIdentity(
  query: G3RegistryExactResourceQueryInput,
): G3RegistryResourceIdentity {
  return {
    resource_type: query.resource_type,
    ref: query.ref,
    content_hash: query.content_hash,
  };
}

function mapSnapshotCode(
  code: G3RegistrySnapshotPreflightCode,
): G3RetentionExecutorAbiErrorCode {
  if (code === 'snapshot_missing') return 'snapshot_missing';
  if (
    code === 'snapshot_identity_mismatch' ||
    code === 'snapshot_hash_mismatch'
  )
    return 'snapshot_hash_mismatch';
  if (code === 'snapshot_binding_mismatch') return 'snapshot_binding_mismatch';
  return 'closure_mismatch';
}

function mapQueryCode(
  code: string,
  kind: 'root' | 'artifact' | 'executor',
): G3RetentionExecutorAbiErrorCode {
  if (kind === 'root') {
    if (code === 'resource_missing') return 'closure_root_missing';
    if (code === 'resource_hash_mismatch') return 'closure_root_hash_mismatch';
    return 'closure_mismatch';
  }
  if (kind === 'artifact') {
    if (code === 'resource_missing') return 'execution_artifact_missing';
    if (code === 'resource_hash_mismatch')
      return 'execution_artifact_hash_mismatch';
    return 'execution_artifact_mismatch';
  }
  if (code === 'resource_missing') return 'executor_implementation_missing';
  if (code === 'resource_hash_mismatch')
    return 'executor_implementation_hash_mismatch';
  return 'executor_implementation_mismatch';
}

function expectedTypedMembers(
  input: G3RetentionExecutorAbiPreflightInput,
  resourceType: 'feature_execution_artifact' | 'executor_implementation',
): G3RegistryResourceIdentity[] {
  return [queryIdentity(input.closure.root), ...input.closure.members]
    .filter((identity) => identity.resource_type === resourceType)
    .sort((left, right) => compareAscii(identityKey(left), identityKey(right)));
}

function verifyArtifactBindings(
  input: G3RetentionExecutorAbiPreflightInput,
  artifacts: VerifiedArtifact[],
  executors: VerifiedExecutor[],
): G3RetentionExecutorAbiErrorCode | null {
  const artifactIdentities = artifacts
    .map((entry) => queryIdentity(entry.query))
    .sort((left, right) => compareAscii(identityKey(left), identityKey(right)));
  const executorIdentities = executors
    .map((entry) => queryIdentity(entry.query))
    .sort((left, right) => compareAscii(identityKey(left), identityKey(right)));
  if (
    canonicalJson(artifactIdentities) !==
      canonicalJson(
        expectedTypedMembers(input, 'feature_execution_artifact'),
      ) ||
    canonicalJson(executorIdentities) !==
      canonicalJson(expectedTypedMembers(input, 'executor_implementation'))
  ) {
    return 'closure_mismatch';
  }

  const primary = input.feature_release_execution_artifact;
  const matchingPrimary = primary
    ? artifacts.filter(
        (entry) =>
          sameRef(entry.query.ref, primary.ref) &&
          entry.query.content_hash === primary.hash &&
          sameRef(entry.content.feature_release_ref, input.feature_release_ref),
      )
    : artifacts.filter((entry) =>
        sameRef(entry.content.feature_release_ref, input.feature_release_ref),
      );
  if (
    (primary !== null && matchingPrimary.length !== 1) ||
    (primary === null && matchingPrimary.length !== 0)
  ) {
    return 'artifact_binding_mismatch';
  }

  for (const executor of executors) {
    const artifact = artifacts.find(
      (candidate) =>
        sameRef(candidate.query.ref, executor.content.execution_artifact_ref) &&
        candidate.query.content_hash ===
          executor.content.execution_artifact_hash,
    );
    if (
      !artifact ||
      !artifact.content.entry_symbols.includes(executor.content.entry_symbol) ||
      !sameRef(
        executor.content.provider_feature_ref,
        artifact.content.feature_release_ref,
      )
    ) {
      return 'artifact_binding_mismatch';
    }
  }
  return null;
}

export function preflightRetentionExecutorAbiCompatibility(
  connection: RetentionExecutorAbiReadConnection,
  candidateInput: unknown,
): G3RetentionExecutorAbiPreflightResult {
  let input: G3RetentionExecutorAbiPreflightInput;
  try {
    validateRetentionExecutorAbiPreflightInput(candidateInput);
    input = candidateInput;
  } catch (error) {
    if (error instanceof G3RetentionExecutorAbiContractError)
      return buildRejectedRetentionExecutorAbiResult('preflight_input_invalid');
    throw error;
  }

  if (requestedSideEffect(input))
    return buildRejectedRetentionExecutorAbiResult(
      'preflight_side_effect_requested',
    );

  const snapshot = preflightRegistrySnapshot(connection, input.snapshot);
  if (snapshot.outcome === 'rejected')
    return buildRejectedRetentionExecutorAbiResult(
      mapSnapshotCode(snapshot.code),
    );

  const closureError = verifyClosureExpectation(input);
  if (closureError)
    return buildRejectedRetentionExecutorAbiResult(closureError);
  if (
    snapshot.closure_hash !== input.closure.closure_hash ||
    snapshot.member_count !== input.closure.member_count
  ) {
    return buildRejectedRetentionExecutorAbiResult('closure_mismatch');
  }

  const root = queryExactRegistryResource(connection, input.closure.root);
  if (root.outcome === 'rejected')
    return buildRejectedRetentionExecutorAbiResult(
      mapQueryCode(root.code, 'root'),
    );

  const artifacts: VerifiedArtifact[] = [];
  for (const artifactQuery of input.execution_artifacts) {
    const result = queryExactRegistryResource(connection, artifactQuery);
    if (result.outcome === 'rejected')
      return buildRejectedRetentionExecutorAbiResult(
        mapQueryCode(result.code, 'artifact'),
      );
    const content = parseArtifactContent(
      result.resource.content,
      artifactQuery,
    );
    if (!content)
      return buildRejectedRetentionExecutorAbiResult(
        'execution_artifact_mismatch',
      );
    artifacts.push({ query: artifactQuery, content });
  }

  const executors: VerifiedExecutor[] = [];
  for (const executorQuery of input.executor_implementations) {
    const result = queryExactRegistryResource(connection, executorQuery);
    if (result.outcome === 'rejected')
      return buildRejectedRetentionExecutorAbiResult(
        mapQueryCode(result.code, 'executor'),
      );
    const content = parseExecutorContent(
      result.resource.content,
      executorQuery,
    );
    if (!content)
      return buildRejectedRetentionExecutorAbiResult(
        'executor_implementation_mismatch',
      );
    executors.push({ query: executorQuery, content });
  }

  const artifactError = verifyArtifactBindings(input, artifacts, executors);
  if (artifactError)
    return buildRejectedRetentionExecutorAbiResult(artifactError);

  if (input.executor_abi_major !== 1)
    return buildRejectedRetentionExecutorAbiResult('executor_abi_mismatch');
  if (
    artifacts.some(
      (artifact) =>
        artifact.content.runtime_abi_major !== input.executor_abi_major,
    ) ||
    executors.some(
      (executor) =>
        executor.content.runtime_abi_major !== input.executor_abi_major,
    )
  ) {
    return buildRejectedRetentionExecutorAbiResult('executor_abi_mismatch');
  }

  const retentionError = verifyRetentionFacts(input);
  if (retentionError)
    return buildRejectedRetentionExecutorAbiResult(retentionError);

  return buildAcceptedRetentionExecutorAbiResult(input);
}
