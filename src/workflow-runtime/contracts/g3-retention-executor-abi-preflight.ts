import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import {
  G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA,
  validateRegistryExactResourceQueryInput,
} from './g3-registry-exact-resource-query.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import {
  buildDependencyClosure,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compareAscii,
  g3RegistryPersistenceFixturesForTest,
  registryResourceKey,
} from './g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import {
  G3_RETENTION_POLICY_HASH,
  G3_RETENTION_POLICY_REF,
  G3_REGISTRY_RESOURCE_TYPES,
} from './g3-registry-publish-types.js';
import {
  G3_RETENTION_EXECUTOR_ABI_FORMATS,
  type G3RetentionExecutorAbiErrorCode,
  type G3RetentionExecutorAbiPreflightInput,
  type G3RetentionExecutorAbiPreflightResult,
} from './g3-retention-executor-abi-preflight-types.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';
import {
  parseVersionedRef,
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };
const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1, pattern: VERSIONED_REF_ID_PATTERN },
    version: {
      type: 'string',
      minLength: 1,
      pattern: VERSIONED_REF_VERSION_PATTERN,
    },
  },
};
const identitySchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['resource_type', 'ref', 'content_hash'],
  properties: {
    resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    ref: { $ref: '#/$defs/versioned_ref' },
    content_hash: hashSchema,
  },
};
const exactQuerySchema = structuredClone(
  G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA,
) as JsonObject;
const exactQueryDefinitions = structuredClone(
  exactQuerySchema.$defs as JsonObject,
);
delete exactQuerySchema.$schema;
delete exactQuerySchema.$id;
delete exactQuerySchema.title;
delete exactQuerySchema.$defs;

export const G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-retention-executor-abi-preflight-input/1',
  title: 'WorkflowRetentionExecutorAbiPreflightInputV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'operation',
    'feature_release_ref',
    'feature_release_hash',
    'feature_release_execution_artifact',
    'snapshot',
    'closure',
    'execution_artifacts',
    'executor_implementations',
    'executor_abi_major',
    'retention',
    'requested_retention_handle_write',
    'requested_gc',
    'requested_delete',
    'requested_publication_state_update',
  ],
  properties: {
    format: { const: G3_RETENTION_EXECUTOR_ABI_FORMATS.input },
    operation: { const: 'validate_only' },
    feature_release_ref: { $ref: '#/$defs/versioned_ref' },
    feature_release_hash: hashSchema,
    feature_release_execution_artifact: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'hash'],
          properties: {
            ref: { $ref: '#/$defs/versioned_ref' },
            hash: hashSchema,
          },
        },
        { type: 'null' },
      ],
    },
    snapshot: {
      type: 'object',
      additionalProperties: false,
      required: ['snapshot_ref', 'snapshot_hash', 'expected_compiler_version'],
      properties: {
        snapshot_ref: { $ref: '#/$defs/versioned_ref' },
        snapshot_hash: hashSchema,
        expected_compiler_version: { type: 'string', minLength: 1 },
      },
    },
    closure: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'closure_hash', 'root', 'members', 'member_count'],
      properties: {
        ref: { $ref: '#/$defs/versioned_ref' },
        closure_hash: hashSchema,
        root: { $ref: '#/$defs/exact_query' },
        members: {
          type: 'array',
          maxItems: 4096,
          items: { $ref: '#/$defs/resource_identity' },
        },
        member_count: { type: 'integer', minimum: 0, maximum: 4096 },
      },
    },
    execution_artifacts: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/exact_query' },
    },
    executor_implementations: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/exact_query' },
    },
    executor_abi_major: { type: 'integer', minimum: 1 },
    retention: {
      type: 'object',
      additionalProperties: false,
      required: [
        'policy_ref',
        'policy_hash',
        'handle_kind',
        'root_kind',
        'feature_release_ref',
        'feature_release_hash',
        'members',
      ],
      properties: {
        policy_ref: { $ref: '#/$defs/versioned_ref' },
        policy_hash: hashSchema,
        handle_kind: { const: 'published' },
        root_kind: { const: 'feature_release' },
        feature_release_ref: { $ref: '#/$defs/versioned_ref' },
        feature_release_hash: hashSchema,
        members: {
          type: 'array',
          maxItems: 4097,
          items: { $ref: '#/$defs/resource_identity' },
        },
      },
    },
    requested_retention_handle_write: { type: 'boolean' },
    requested_gc: { type: 'boolean' },
    requested_delete: { type: 'boolean' },
    requested_publication_state_update: { type: 'boolean' },
  },
  $defs: {
    ...exactQueryDefinitions,
    versioned_ref: versionedRefSchema,
    resource_identity: identitySchema,
    exact_query: exactQuerySchema,
  },
};

export const G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-retention-executor-abi-preflight-result/1',
  title: 'WorkflowRetentionExecutorAbiPreflightResultV1',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'outcome', 'code', 'bindings', 'read_only'],
      properties: {
        format: { const: G3_RETENTION_EXECUTOR_ABI_FORMATS.result },
        outcome: { const: 'accepted' },
        code: { const: 'preflight_ok' },
        bindings: {
          type: 'object',
          additionalProperties: false,
          required: [
            'feature_release_ref',
            'feature_release_hash',
            'snapshot_ref',
            'snapshot_hash',
            'closure_ref',
            'closure_hash',
            'closure_member_count',
            'execution_artifact_count',
            'executor_implementation_count',
            'executor_abi_major',
            'retention_policy_ref',
            'retention_policy_hash',
            'retention_root_eligible',
          ],
          properties: {
            feature_release_ref: { $ref: '#/$defs/versioned_ref' },
            feature_release_hash: hashSchema,
            snapshot_ref: { $ref: '#/$defs/versioned_ref' },
            snapshot_hash: hashSchema,
            closure_ref: { $ref: '#/$defs/versioned_ref' },
            closure_hash: hashSchema,
            closure_member_count: { type: 'integer', minimum: 0 },
            execution_artifact_count: { type: 'integer', minimum: 0 },
            executor_implementation_count: { type: 'integer', minimum: 0 },
            executor_abi_major: { type: 'integer', minimum: 1 },
            retention_policy_ref: { $ref: '#/$defs/versioned_ref' },
            retention_policy_hash: hashSchema,
            retention_root_eligible: { const: true },
          },
        },
        read_only: { const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['format', 'outcome', 'code', 'bindings', 'read_only'],
      properties: {
        format: { const: G3_RETENTION_EXECUTOR_ABI_FORMATS.result },
        outcome: { const: 'rejected' },
        code: {
          enum: [
            'preflight_input_invalid',
            'preflight_side_effect_requested',
            'snapshot_missing',
            'snapshot_hash_mismatch',
            'snapshot_binding_mismatch',
            'closure_root_missing',
            'closure_root_hash_mismatch',
            'closure_mismatch',
            'execution_artifact_missing',
            'execution_artifact_hash_mismatch',
            'execution_artifact_mismatch',
            'executor_implementation_missing',
            'executor_implementation_hash_mismatch',
            'executor_implementation_mismatch',
            'artifact_binding_mismatch',
            'executor_abi_mismatch',
            'retention_policy_mismatch',
            'retention_eligibility_mismatch',
          ],
        },
        bindings: { type: 'null' },
        read_only: { const: true },
      },
    },
  ],
  $defs: { versioned_ref: versionedRefSchema },
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateInputSchema = ajv.compile(
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA as AnySchema,
);

export class G3RetentionExecutorAbiContractError extends Error {}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function identityKey(identity: G3RegistryResourceIdentity): string {
  return registryResourceKey(identity);
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

function assertOrderedUnique(
  identities: G3RegistryResourceIdentity[],
  label: string,
): void {
  const keys = identities.map(identityKey);
  if (
    new Set(keys).size !== keys.length ||
    canonicalJson(keys) !==
      canonicalJson([...keys].sort((left, right) => compareAscii(left, right)))
  ) {
    throw new G3RetentionExecutorAbiContractError(
      `${label} must be unique and unsigned-ASCII ordered`,
    );
  }
}

export function validateRetentionExecutorAbiPreflightInput(
  input: unknown,
): asserts input is G3RetentionExecutorAbiPreflightInput {
  if (!(validateInputSchema(input) as boolean)) {
    throw new G3RetentionExecutorAbiContractError(
      `Retention compatibility input invalid: ${ajv.errorsText(validateInputSchema.errors)}`,
    );
  }
  const exact = input as G3RetentionExecutorAbiPreflightInput;
  try {
    const refs = [
      exact.feature_release_ref,
      exact.snapshot.snapshot_ref,
      exact.closure.ref,
      exact.retention.policy_ref,
      exact.retention.feature_release_ref,
    ];
    if (exact.feature_release_execution_artifact)
      refs.push(exact.feature_release_execution_artifact.ref);
    refs.forEach(parseVersionedRef);
    validateRegistryExactResourceQueryInput(exact.closure.root);
    exact.execution_artifacts.forEach(validateRegistryExactResourceQueryInput);
    exact.executor_implementations.forEach(
      validateRegistryExactResourceQueryInput,
    );
    assertOrderedUnique(exact.closure.members, 'Closure members');
    assertOrderedUnique(
      exact.execution_artifacts.map(queryIdentity),
      'Execution Artifact queries',
    );
    assertOrderedUnique(
      exact.executor_implementations.map(queryIdentity),
      'Executor Implementation queries',
    );
    assertOrderedUnique(exact.retention.members, 'Retention members');
  } catch (error) {
    if (error instanceof G3RetentionExecutorAbiContractError) throw error;
    throw new G3RetentionExecutorAbiContractError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function requestedSideEffect(
  input: G3RetentionExecutorAbiPreflightInput,
): boolean {
  return (
    input.requested_retention_handle_write ||
    input.requested_gc ||
    input.requested_delete ||
    input.requested_publication_state_update
  );
}

export function verifyClosureExpectation(
  input: G3RetentionExecutorAbiPreflightInput,
): G3RetentionExecutorAbiErrorCode | null {
  if (input.closure.member_count !== input.closure.members.length)
    return 'closure_mismatch';
  const computed = domainSeparatedSha256(
    'icarus:workflow-registry-dependency-closure:1\n',
    {
      format: 'icarus.workflow-registry-dependency-closure/1',
      root_resource_type: input.closure.root.resource_type,
      root_ref: input.closure.root.ref,
      members: input.closure.members,
      member_count: input.closure.member_count,
    },
  );
  return computed === input.closure.closure_hash ? null : 'closure_mismatch';
}

export function verifyRetentionFacts(
  input: G3RetentionExecutorAbiPreflightInput,
): G3RetentionExecutorAbiErrorCode | null {
  if (
    !sameRef(input.retention.policy_ref, G3_RETENTION_POLICY_REF) ||
    input.retention.policy_hash !== G3_RETENTION_POLICY_HASH
  ) {
    return 'retention_policy_mismatch';
  }
  const expectedMembers = [
    queryIdentity(input.closure.root),
    ...input.closure.members,
  ].sort((left, right) => compareAscii(identityKey(left), identityKey(right)));
  if (
    !sameRef(input.retention.feature_release_ref, input.feature_release_ref) ||
    input.retention.feature_release_hash !== input.feature_release_hash ||
    canonicalJson(input.retention.members) !== canonicalJson(expectedMembers)
  ) {
    return 'retention_eligibility_mismatch';
  }
  return null;
}

export function buildAcceptedRetentionExecutorAbiResult(
  input: G3RetentionExecutorAbiPreflightInput,
): G3RetentionExecutorAbiPreflightResult {
  return {
    format: G3_RETENTION_EXECUTOR_ABI_FORMATS.result,
    outcome: 'accepted',
    code: 'preflight_ok',
    bindings: {
      feature_release_ref: input.feature_release_ref,
      feature_release_hash: input.feature_release_hash,
      snapshot_ref: input.snapshot.snapshot_ref,
      snapshot_hash: input.snapshot.snapshot_hash,
      closure_ref: input.closure.ref,
      closure_hash: input.closure.closure_hash,
      closure_member_count: input.closure.member_count,
      execution_artifact_count: input.execution_artifacts.length,
      executor_implementation_count: input.executor_implementations.length,
      executor_abi_major: input.executor_abi_major,
      retention_policy_ref: input.retention.policy_ref,
      retention_policy_hash: input.retention.policy_hash,
      retention_root_eligible: true,
    },
    read_only: true,
  };
}

export function buildRejectedRetentionExecutorAbiResult(
  code: G3RetentionExecutorAbiErrorCode,
): G3RetentionExecutorAbiPreflightResult {
  return {
    format: G3_RETENTION_EXECUTOR_ABI_FORMATS.result,
    outcome: 'rejected',
    code,
    bindings: null,
    read_only: true,
  };
}

function dependency(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceRecord['dependencies'][number] {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
    dependency_kind: 'registry_exact',
  };
}

function query(
  resource: G3RegistryResourceRecord,
): G3RegistryExactResourceQueryInput {
  return {
    format: 'icarus.workflow-registry-exact-resource-query/1',
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
    schema_ref: resource.schema_ref,
    schema_hash: resource.schema_hash,
    owner: resource.owner,
    publication_state: 'staged',
    dependencies: resource.dependencies,
  };
}

function resource(
  resourceType: G3RegistryResourceRecord['resource_type'],
  ref: VersionedRef,
  content: JsonObject,
  schema: G3RegistryResourceRecord,
  dependencies: G3RegistryResourceRecord[],
): G3RegistryResourceRecord {
  const record: G3RegistryResourceRecord = {
    format: 'icarus.workflow-registry-resource/1',
    resource_type: resourceType,
    ref,
    owner: { kind: 'feature', feature_id: 'fixture.feature' },
    schema_ref: schema.ref,
    schema_hash: schema.content_hash,
    content,
    content_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    dependencies: dependencies
      .map(dependency)
      .sort((left, right) =>
        compareAscii(registryResourceKey(left), registryResourceKey(right)),
      ),
  };
  record.content_hash = calculateRegistryResourceContentHash(record);
  return record;
}

export function g3RetentionExecutorAbiStoreFixtureForTest(): {
  batch: G3RegistryPersistenceBatch;
  input: G3RetentionExecutorAbiPreflightInput;
  expected_result: G3RetentionExecutorAbiPreflightResult;
} {
  const base = g3RegistryPersistenceFixturesForTest().positive[0].batch;
  const schema = structuredClone(
    base.resources.find((entry) => entry.resource_type === 'schema'),
  );
  if (!schema)
    throw new Error('Retention compatibility fixture schema missing');
  const featureReleaseRef = {
    id: 'fixture.feature-release',
    version: '1.0.0',
  };
  const featureReleaseHash =
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as Sha256Hash;
  const artifactRef = {
    id: 'fixture.execution-artifact',
    version: '1.0.0',
  };
  const artifact = resource(
    'feature_execution_artifact',
    artifactRef,
    {
      ref: artifactRef,
      feature_release_ref: featureReleaseRef,
      runtime_kind: 'node_bundle',
      artifact_ref: 'blob:fixture-node-bundle',
      artifact_hash:
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      entry_symbols: ['execute'],
      runtime_abi_major: 1,
      dependency_manifest_ref: 'fixture.node-bundle-dependencies@1.0.0',
      dependency_manifest_hash:
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    schema,
    [schema],
  );
  const executorRef = { id: 'fixture.executor', version: '1.0.0' };
  const executor = resource(
    'executor_implementation',
    executorRef,
    {
      ref: executorRef,
      provider_feature_ref: featureReleaseRef,
      execution_artifact_ref: artifactRef,
      execution_artifact_hash: artifact.content_hash,
      entry_symbol: 'execute',
      runtime_abi_major: 1,
      implementation_hash:
        'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    },
    schema,
    [artifact, schema],
  );
  const recipeRef = { id: 'fixture.recipe', version: '2.0.0' };
  const recipe = resource(
    'recipe',
    recipeRef,
    { name: 'fixture-retention-abi-root' },
    schema,
    [executor, schema],
  );
  const resources = [schema, artifact, executor, recipe].sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: recipe.resource_type, ref: recipe.ref },
    { id: 'fixture.retention-abi-closure', version: '1.0.0' },
    { ...schema.ref, hash: schema.content_hash },
  );
  const snapshotWithoutHash = {
    format: 'icarus.workflow-registry-snapshot/1' as const,
    ref: { id: 'fixture.retention-abi-snapshot', version: '1.0.0' },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: WORKFLOW_COMPILER_VERSION,
    core_build_hash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Hash,
    database_schema_hash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Sha256Hash,
  };
  const snapshot = {
    ...snapshotWithoutHash,
    snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
  };
  const batch: G3RegistryPersistenceBatch = {
    resources,
    closure,
    snapshot,
    created_at_ms: 1784604172000,
  };
  const rootQuery = query(recipe);
  const retentionMembers = [queryIdentity(rootQuery), ...closure.members].sort(
    (left, right) => compareAscii(identityKey(left), identityKey(right)),
  );
  const input: G3RetentionExecutorAbiPreflightInput = {
    format: G3_RETENTION_EXECUTOR_ABI_FORMATS.input,
    operation: 'validate_only',
    feature_release_ref: featureReleaseRef,
    feature_release_hash: featureReleaseHash,
    feature_release_execution_artifact: {
      ref: artifactRef,
      hash: artifact.content_hash,
    },
    snapshot: {
      snapshot_ref: snapshot.ref,
      snapshot_hash: snapshot.snapshot_hash,
      expected_compiler_version: snapshot.compiler_version,
    },
    closure: {
      ref: closure.ref,
      closure_hash: closure.closure_hash,
      root: rootQuery,
      members: closure.members,
      member_count: closure.member_count,
    },
    execution_artifacts: [query(artifact)],
    executor_implementations: [query(executor)],
    executor_abi_major: 1,
    retention: {
      policy_ref: G3_RETENTION_POLICY_REF,
      policy_hash: G3_RETENTION_POLICY_HASH,
      handle_kind: 'published',
      root_kind: 'feature_release',
      feature_release_ref: featureReleaseRef,
      feature_release_hash: featureReleaseHash,
      members: retentionMembers,
    },
    requested_retention_handle_write: false,
    requested_gc: false,
    requested_delete: false,
    requested_publication_state_update: false,
  };
  return {
    batch,
    input,
    expected_result: buildAcceptedRetentionExecutorAbiResult(input),
  };
}
