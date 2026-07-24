import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
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
  G3_REGISTRY_SNAPSHOT_DOMAIN,
  g3RegistryPersistenceFixturesForTest,
  registryResourceKey,
} from './g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import {
  G3_CURRENT_UPSTREAM_IDENTITY,
  G3_REGISTRY_RESOURCE_TYPES,
  G3_RETENTION_POLICY_HASH,
  G3_RETENTION_POLICY_REF,
} from './g3-registry-publish-types.js';
import {
  G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE,
  G3_RETENTION_EXECUTOR_ABI_FORMATS,
  type G3CoreCompatibilitySnapshot,
  type G3RetentionExecutorAbiErrorCode,
  type G3RetentionExecutorAbiPreflightInput,
  type G3RetentionExecutorAbiPreflightProfile,
  type G3RetentionExecutorAbiPreflightResult,
} from './g3-retention-executor-abi-preflight-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';
import {
  parseVersionedRef,
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;

export const G3_RETENTION_EXECUTOR_ABI_ROOT =
  'conformance/g3-retention-executor-abi-preflight';
export const G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA_PATH =
  'registry/workflow-retention-executor-abi-preflight-profile-schema@1.json';
export const G3_RETENTION_EXECUTOR_ABI_PROFILE_PATH =
  'registry/workflow-retention-executor-abi-preflight-profile@1.json';
export const G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA_PATH =
  'registry/workflow-retention-executor-abi-preflight-input-schema@1.json';
export const G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA_PATH =
  'registry/workflow-retention-executor-abi-preflight-result-schema@1.json';
export const G3_RETENTION_EXECUTOR_ABI_POSITIVE_CASES_PATH = `${G3_RETENTION_EXECUTOR_ABI_ROOT}/positive-cases.json`;
export const G3_RETENTION_EXECUTOR_ABI_NEGATIVE_CASES_PATH = `${G3_RETENTION_EXECUTOR_ABI_ROOT}/negative-cases.json`;
export const G3_RETENTION_EXECUTOR_ABI_DOMAIN_CATALOG_PATH =
  'registry/workflow-retention-executor-abi-preflight-domain-separators@1.json';
export const G3_RETENTION_EXECUTOR_ABI_MANIFEST_PATH =
  'contract-pack-g3-retention-executor-abi-preflight.json';

export const G3_CORE_COMPATIBILITY_DOMAIN =
  'icarus:workflow-core-compatibility:1\n';
export const G3_EXECUTOR_ABI_IDENTITY_DOMAIN =
  'icarus:workflow-executor-abi-identity:1\n';
export const G3_RUN_PROTOCOL_REF = {
  id: 'icarus.workflow-contract-pack-catalog-protocols',
  version: '1.0.0',
} as const;
export const G3_RUN_PROTOCOL_HASH =
  'sha256:a648dc9326255b109690cb47d58032775825ae065caf8f7cbb0ef73efcf984f7' as const;
export const G3_EXECUTOR_ABI_REF = {
  id: 'icarus.workflow-executor-abi',
  version: '1.0.0',
} as const;
export const G3_EXECUTOR_ABI_HASH = domainSeparatedSha256(
  G3_EXECUTOR_ABI_IDENTITY_DOMAIN,
  {
    major: 1,
    framing: 'length_prefixed_canonical_json',
    invocation_fields: [
      'attempt_id',
      'broker_grant_hash',
      'broker_grant_ref',
      'capability_hash',
      'capability_ref',
      'context_pack_hash',
      'context_pack_ref',
      'effect_key',
      'execution_deadline_at_ms',
      'executor_abi_major',
      'input_snapshot_hash',
      'input_snapshot_ref',
      'invocation_id',
      'trace_correlation_ref',
    ],
    result_kinds: ['accepted', 'cancelled', 'failed', 'heartbeat', 'succeeded'],
  },
);
const PROFILE_DOMAIN =
  'icarus:workflow-retention-executor-abi-preflight-profile:1\n';
const DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-retention-executor-abi-preflight-domain-separators:1\n';
const PACK_DOMAIN =
  'icarus:workflow-contract-pack-g3-retention-executor-abi-preflight:1\n';

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };
const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: VERSIONED_REF_ID_PATTERN,
    },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
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
const querySchema = structuredClone(
  G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA,
) as JsonObject;
const queryDefinitions = structuredClone(querySchema.$defs as JsonObject);
delete querySchema.$schema;
delete querySchema.$id;
delete querySchema.title;
delete querySchema.$defs;

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
    'core_compatibility',
    'run_protocol',
    'executor_abi',
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
      required: [
        'snapshot_ref',
        'snapshot_hash',
        'expected_compiler_version',
        'expected_core_build_hash',
        'expected_database_schema_hash',
      ],
      properties: {
        snapshot_ref: { $ref: '#/$defs/versioned_ref' },
        snapshot_hash: hashSchema,
        expected_compiler_version: { type: 'string', minLength: 1 },
        expected_core_build_hash: hashSchema,
        expected_database_schema_hash: hashSchema,
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
    core_compatibility: {
      type: 'object',
      additionalProperties: false,
      required: [
        'ref',
        'core_release_ref',
        'core_release_hash',
        'core_build_hash',
        'supported_run_protocol_majors',
        'supported_executor_abi_majors',
        'registry_schema_version',
        'database_schema_version',
        'database_schema_hash',
        'compatibility_hash',
      ],
      properties: {
        ref: { $ref: '#/$defs/versioned_ref' },
        core_release_ref: { $ref: '#/$defs/versioned_ref' },
        core_release_hash: hashSchema,
        core_build_hash: hashSchema,
        supported_run_protocol_majors: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'integer', minimum: 1 },
        },
        supported_executor_abi_majors: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'integer', minimum: 1 },
        },
        registry_schema_version: { type: 'integer', minimum: 1 },
        database_schema_version: { type: 'integer', minimum: 1 },
        database_schema_hash: hashSchema,
        compatibility_hash: hashSchema,
      },
    },
    run_protocol: { $ref: '#/$defs/protocol_binding' },
    executor_abi: { $ref: '#/$defs/protocol_binding' },
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
          minItems: 1,
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
    ...queryDefinitions,
    versioned_ref: versionedRefSchema,
    resource_identity: identitySchema,
    exact_query: querySchema,
    protocol_binding: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'hash', 'major'],
      properties: {
        ref: { $ref: '#/$defs/versioned_ref' },
        hash: hashSchema,
        major: { type: 'integer', minimum: 1 },
      },
    },
  },
};

const bindingsSchema: JsonObject = {
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
    'core_compatibility_ref',
    'core_compatibility_hash',
    'core_release_ref',
    'core_release_hash',
    'core_build_hash',
    'database_schema_version',
    'database_schema_hash',
    'run_protocol_ref',
    'run_protocol_hash',
    'run_protocol_major',
    'executor_abi_ref',
    'executor_abi_hash',
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
    core_compatibility_ref: { $ref: '#/$defs/versioned_ref' },
    core_compatibility_hash: hashSchema,
    core_release_ref: { $ref: '#/$defs/versioned_ref' },
    core_release_hash: hashSchema,
    core_build_hash: hashSchema,
    database_schema_version: { const: 6 },
    database_schema_hash: hashSchema,
    run_protocol_ref: { $ref: '#/$defs/versioned_ref' },
    run_protocol_hash: hashSchema,
    run_protocol_major: { const: 1 },
    executor_abi_ref: { $ref: '#/$defs/versioned_ref' },
    executor_abi_hash: hashSchema,
    executor_abi_major: { const: 1 },
    retention_policy_ref: { $ref: '#/$defs/versioned_ref' },
    retention_policy_hash: hashSchema,
    retention_root_eligible: { const: true },
  },
};

export const G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-retention-executor-abi-preflight-result/1',
  title: 'WorkflowRetentionExecutorAbiPreflightResultV1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'outcome', 'code', 'bindings', 'read_only'],
  properties: {
    format: { const: G3_RETENTION_EXECUTOR_ABI_FORMATS.result },
    outcome: { enum: ['accepted', 'rejected'] },
    code: {
      enum: ['preflight_ok', ...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE],
    },
    bindings: {
      anyOf: [{ $ref: '#/$defs/verified_bindings' }, { type: 'null' }],
    },
    read_only: { const: true },
  },
  allOf: [
    {
      if: { properties: { outcome: { const: 'accepted' } } },
      then: {
        properties: {
          code: { const: 'preflight_ok' },
          bindings: { $ref: '#/$defs/verified_bindings' },
        },
      },
      else: {
        properties: {
          code: { enum: [...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE] },
          bindings: { type: 'null' },
        },
      },
    },
  ],
  $defs: {
    versioned_ref: versionedRefSchema,
    verified_bindings: bindingsSchema,
  },
};

export const G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-retention-executor-abi-preflight-profile/1',
  title: 'WorkflowRetentionExecutorAbiPreflightProfileV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'ref',
    'resolution_mode',
    'registry_snapshot_verifier',
    'registry_resource_verifier',
    'compatibility_rules',
    'retention_policy_ref',
    'retention_policy_hash',
    'run_protocol_ref',
    'run_protocol_hash',
    'executor_abi_ref',
    'executor_abi_hash',
    'retention_handle_kind',
    'retention_root_kind',
    'error_precedence',
    'result_schema',
    'deterministic',
    'read_only',
  ],
  properties: {
    format: { const: G3_RETENTION_EXECUTOR_ABI_FORMATS.profile },
    ref: { $ref: '#/$defs/versioned_ref' },
    resolution_mode: { const: 'immutable_exact_only' },
    registry_snapshot_verifier: {
      const: 'g3_3_snapshot_closure_preflight',
    },
    registry_resource_verifier: { const: 'g3_5_exact_resource_query' },
    compatibility_rules: {
      type: 'object',
      additionalProperties: false,
      required: [
        'run_protocol_major',
        'executor_abi_major',
        'registry_schema_version',
        'database_schema_version',
      ],
      properties: {
        run_protocol_major: { const: 1 },
        executor_abi_major: { const: 1 },
        registry_schema_version: { const: 1 },
        database_schema_version: { const: 6 },
      },
    },
    retention_policy_ref: { $ref: '#/$defs/versioned_ref' },
    retention_policy_hash: hashSchema,
    run_protocol_ref: { $ref: '#/$defs/versioned_ref' },
    run_protocol_hash: hashSchema,
    executor_abi_ref: { $ref: '#/$defs/versioned_ref' },
    executor_abi_hash: hashSchema,
    retention_handle_kind: { const: 'published' },
    retention_root_kind: { const: 'feature_release' },
    error_precedence: {
      type: 'array',
      minItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.length,
      maxItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.length,
      prefixItems: G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE.map((code) => ({
        const: code,
      })),
      items: false,
    },
    result_schema: { const: 'closed' },
    deterministic: { const: true },
    read_only: { const: true },
  },
  $defs: { versioned_ref: versionedRefSchema },
};

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateInputSchema = ajv.compile(
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA as AnySchema,
);
const validateResultSchema = ajv.compile(
  G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA as AnySchema,
);
const validateProfileSchema = ajv.compile(
  G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA as AnySchema,
);

export class G3RetentionExecutorAbiContractError extends Error {
  readonly code = 'preflight_input_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'G3RetentionExecutorAbiContractError';
  }
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function identityKey(identity: G3RegistryResourceIdentity): string {
  return `${identity.resource_type}\0${refKey(identity.ref)}`;
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
    JSON.stringify(keys) !==
      JSON.stringify([...keys].sort((left, right) => compareAscii(left, right)))
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
      `G3.6 preflight input invalid: ${ajv.errorsText(validateInputSchema.errors)}`,
    );
  }
  const exact = input as G3RetentionExecutorAbiPreflightInput;
  try {
    const refs: VersionedRef[] = [
      exact.feature_release_ref,
      exact.snapshot.snapshot_ref,
      exact.closure.ref,
      exact.core_compatibility.ref,
      exact.core_compatibility.core_release_ref,
      exact.run_protocol.ref,
      exact.executor_abi.ref,
      exact.retention.policy_ref,
      exact.retention.feature_release_ref,
    ];
    if (exact.feature_release_execution_artifact)
      refs.push(exact.feature_release_execution_artifact.ref);
    for (const ref of refs) parseVersionedRef(ref);
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

export function calculateCoreCompatibilityHash(
  compatibility: Omit<G3CoreCompatibilitySnapshot, 'compatibility_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(G3_CORE_COMPATIBILITY_DOMAIN, compatibility);
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
  const computed = buildDependencyClosureHash(input);
  if (computed !== input.closure.closure_hash) return 'closure_mismatch';
  const expectedSnapshotHash = calculateRegistrySnapshotHash({
    format: 'icarus.workflow-registry-snapshot/1',
    ref: input.snapshot.snapshot_ref,
    closure_ref: input.closure.ref,
    closure_hash: input.closure.closure_hash,
    compiler_version: input.snapshot.expected_compiler_version,
    core_build_hash: input.snapshot.expected_core_build_hash,
    database_schema_hash: input.snapshot.expected_database_schema_hash,
  });
  if (expectedSnapshotHash !== input.snapshot.snapshot_hash)
    return 'snapshot_hash_mismatch';
  return null;
}

function buildDependencyClosureHash(
  input: G3RetentionExecutorAbiPreflightInput,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-registry-dependency-closure:1\n',
    {
      format: 'icarus.workflow-registry-dependency-closure/1',
      root_resource_type: input.closure.root.resource_type,
      root_ref: input.closure.root.ref,
      members: input.closure.members,
      member_count: input.closure.member_count,
    },
  );
}

export function verifyCoreProtocolFacts(
  input: G3RetentionExecutorAbiPreflightInput,
): G3RetentionExecutorAbiErrorCode | null {
  const { compatibility_hash: ignored, ...withoutHash } =
    input.core_compatibility;
  if (
    calculateCoreCompatibilityHash(withoutHash) !==
      input.core_compatibility.compatibility_hash ||
    input.core_compatibility.registry_schema_version !== 1 ||
    input.core_compatibility.database_schema_version !== 6 ||
    input.core_compatibility.database_schema_hash !==
      G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_hash ||
    input.snapshot.expected_core_build_hash !==
      input.core_compatibility.core_build_hash ||
    input.snapshot.expected_database_schema_hash !==
      input.core_compatibility.database_schema_hash
  ) {
    return 'core_compatibility_mismatch';
  }
  if (
    !sameRef(input.run_protocol.ref, G3_RUN_PROTOCOL_REF) ||
    input.run_protocol.hash !== G3_RUN_PROTOCOL_HASH ||
    input.run_protocol.major !== 1 ||
    canonicalJson(input.core_compatibility.supported_run_protocol_majors) !==
      canonicalJson([1])
  ) {
    return 'run_protocol_mismatch';
  }
  if (
    !sameRef(input.executor_abi.ref, G3_EXECUTOR_ABI_REF) ||
    input.executor_abi.hash !== G3_EXECUTOR_ABI_HASH ||
    input.executor_abi.major !== 1 ||
    canonicalJson(input.core_compatibility.supported_executor_abi_majors) !==
      canonicalJson([1])
  ) {
    return 'executor_abi_mismatch';
  }
  return null;
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
      core_compatibility_ref: input.core_compatibility.ref,
      core_compatibility_hash: input.core_compatibility.compatibility_hash,
      core_release_ref: input.core_compatibility.core_release_ref,
      core_release_hash: input.core_compatibility.core_release_hash,
      core_build_hash: input.core_compatibility.core_build_hash,
      database_schema_version: 6,
      database_schema_hash: input.core_compatibility.database_schema_hash,
      run_protocol_ref: input.run_protocol.ref,
      run_protocol_hash: input.run_protocol.hash,
      run_protocol_major: 1,
      executor_abi_ref: input.executor_abi.ref,
      executor_abi_hash: input.executor_abi.hash,
      executor_abi_major: 1,
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

export function buildG3RetentionExecutorAbiProfile(): G3RetentionExecutorAbiPreflightProfile {
  return {
    format: G3_RETENTION_EXECUTOR_ABI_FORMATS.profile,
    ref: {
      id: 'icarus.workflow-retention-executor-abi-preflight-profile',
      version: '1.0.0',
    },
    resolution_mode: 'immutable_exact_only',
    registry_snapshot_verifier: 'g3_3_snapshot_closure_preflight',
    registry_resource_verifier: 'g3_5_exact_resource_query',
    compatibility_rules: {
      run_protocol_major: 1,
      executor_abi_major: 1,
      registry_schema_version: 1,
      database_schema_version: 6,
    },
    retention_policy_ref: G3_RETENTION_POLICY_REF,
    retention_policy_hash: G3_RETENTION_POLICY_HASH,
    run_protocol_ref: G3_RUN_PROTOCOL_REF,
    run_protocol_hash: G3_RUN_PROTOCOL_HASH,
    executor_abi_ref: G3_EXECUTOR_ABI_REF,
    executor_abi_hash: G3_EXECUTOR_ABI_HASH,
    retention_handle_kind: 'published',
    retention_root_kind: 'feature_release',
    error_precedence: [...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE],
    result_schema: 'closed',
    deterministic: true,
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
  if (!schema) throw new Error('G3.6 fixture schema is missing');
  const featureReleaseRef = {
    id: 'fixture.feature-release',
    version: '1.0.0',
  };
  const featureReleaseHash =
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
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
  const executorRef = {
    id: 'fixture.executor',
    version: '1.0.0',
  };
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
  const coreBuildHash =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const snapshotWithoutHash = {
    format: 'icarus.workflow-registry-snapshot/1' as const,
    ref: { id: 'fixture.retention-abi-snapshot', version: '1.0.0' },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: '3.0.3',
    core_build_hash: coreBuildHash as Sha256Hash,
    database_schema_hash: G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_hash,
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
  const coreWithoutHash = {
    ref: { id: 'fixture.core-compatibility', version: '1.0.0' },
    core_release_ref: { id: 'icarus.core-release', version: '1.0.0' },
    core_release_hash:
      'sha256:1212121212121212121212121212121212121212121212121212121212121212' as Sha256Hash,
    core_build_hash: coreBuildHash as Sha256Hash,
    supported_run_protocol_majors: [1],
    supported_executor_abi_majors: [1],
    registry_schema_version: 1 as const,
    database_schema_version: 6 as const,
    database_schema_hash: G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_hash,
  };
  const coreCompatibility: G3CoreCompatibilitySnapshot = {
    ...coreWithoutHash,
    compatibility_hash: calculateCoreCompatibilityHash(coreWithoutHash),
  };
  const rootQuery = query(recipe);
  const artifactQueries = [query(artifact)];
  const executorQueries = [query(executor)];
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
      expected_core_build_hash: snapshot.core_build_hash,
      expected_database_schema_hash: snapshot.database_schema_hash,
    },
    closure: {
      ref: closure.ref,
      closure_hash: closure.closure_hash,
      root: rootQuery,
      members: closure.members,
      member_count: closure.member_count,
    },
    execution_artifacts: artifactQueries,
    executor_implementations: executorQueries,
    core_compatibility: coreCompatibility,
    run_protocol: {
      ref: G3_RUN_PROTOCOL_REF,
      hash: G3_RUN_PROTOCOL_HASH,
      major: 1,
    },
    executor_abi: {
      ref: G3_EXECUTOR_ABI_REF,
      hash: G3_EXECUTOR_ABI_HASH,
      major: 1,
    },
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

export function g3RetentionExecutorAbiFixturesForTest(): {
  positive: Array<{
    case_id: string;
    input: G3RetentionExecutorAbiPreflightInput;
    expected_result: G3RetentionExecutorAbiPreflightResult;
  }>;
  negative: Array<{
    case_id: string;
    input: JsonObject;
    expected_code: G3RetentionExecutorAbiErrorCode;
  }>;
} {
  const fixture = g3RetentionExecutorAbiStoreFixtureForTest();
  const latest = structuredClone(fixture.input) as unknown as JsonObject;
  ((latest.snapshot as JsonObject).snapshot_ref as JsonObject).version =
    'latest';
  const alias = structuredClone(fixture.input) as unknown as JsonObject;
  alias.active_release = 'fixture.feature-release@1.0.0';
  const sideEffect = structuredClone(
    fixture.input,
  ) as unknown as G3RetentionExecutorAbiPreflightInput;
  sideEffect.requested_gc = true;
  const abiDrift = structuredClone(
    fixture.input,
  ) as unknown as G3RetentionExecutorAbiPreflightInput;
  abiDrift.executor_abi.major = 2;
  const retentionDrift = structuredClone(
    fixture.input,
  ) as unknown as G3RetentionExecutorAbiPreflightInput;
  retentionDrift.retention.policy_hash =
    'sha256:7878787878787878787878787878787878787878787878787878787878787878';
  return {
    positive: [
      {
        case_id: 'positive.exact-retention-executor-abi-preflight',
        input: fixture.input,
        expected_result: fixture.expected_result,
      },
    ],
    negative: [
      {
        case_id: 'negative.latest-snapshot',
        input: latest,
        expected_code: 'preflight_input_invalid',
      },
      {
        case_id: 'negative.active-release-alias',
        input: alias,
        expected_code: 'preflight_input_invalid',
      },
      {
        case_id: 'negative.side-effect-request',
        input: sideEffect,
        expected_code: 'preflight_side_effect_requested',
      },
      {
        case_id: 'negative.executor-abi-drift',
        input: abiDrift,
        expected_code: 'executor_abi_mismatch',
      },
      {
        case_id: 'negative.retention-policy-drift',
        input: retentionDrift,
        expected_code: 'retention_policy_mismatch',
      },
    ],
  };
}

function artifact<T extends JsonObject>(
  format: string,
  ref: string,
  domain: string,
  payload: T,
): ContractArtifactEnvelope<T> {
  const version = Number(format.slice(format.lastIndexOf('/') + 1));
  const withoutHash = {
    format,
    ref: { id: ref, version: '1.0.0' },
    version,
    domain_separator: domain,
    payload,
  };
  return {
    ...withoutHash,
    hash: calculateArtifactHash(withoutHash as ContractArtifactEnvelope<T>),
  };
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`))
    throw new Error(`Contract path escapes root: ${relativePath}`);
  return resolved;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, target);
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function validateUpstreamIdentity(): void {
  const registry = readArtifact('contract-pack-g3-registry-persistence.json');
  const queryPack = readArtifact(
    'contract-pack-g3-registry-exact-resource-query.json',
  );
  if (
    registry.hash !==
    'sha256:635fd7ac9c15212f50df1845a8267c5cad576aa34d475164e060946cb42987e5'
  ) {
    throw new Error('G3.3 Registry persistence identity drift');
  }
  if (
    queryPack.hash !==
    'sha256:f8b66d05bd59a0ca845f678078c72104d15ef9400e87196b505bb5bf46b91d8c'
  ) {
    throw new Error('G3.5 exact resource query identity drift');
  }
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const profile = buildG3RetentionExecutorAbiProfile();
  const fixtures = g3RetentionExecutorAbiFixturesForTest();
  const entries: Array<[string, ContractArtifactEnvelope]> = [
    [
      G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA_PATH,
      artifact(
        'icarus.workflow-retention-executor-abi-preflight-profile-schema/1',
        'icarus.workflow-retention-executor-abi-preflight-profile-schema',
        'icarus:workflow-retention-executor-abi-preflight-profile-schema:1\n',
        G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA,
      ),
    ],
    [
      G3_RETENTION_EXECUTOR_ABI_PROFILE_PATH,
      artifact(
        G3_RETENTION_EXECUTOR_ABI_FORMATS.profile,
        'icarus.workflow-retention-executor-abi-preflight-profile',
        PROFILE_DOMAIN,
        profile,
      ),
    ],
    [
      G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-retention-executor-abi-preflight-input-schema/1',
        'icarus.workflow-retention-executor-abi-preflight-input-schema',
        'icarus:workflow-retention-executor-abi-preflight-input-schema:1\n',
        G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
      ),
    ],
    [
      G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-retention-executor-abi-preflight-result-schema/1',
        'icarus.workflow-retention-executor-abi-preflight-result-schema',
        'icarus:workflow-retention-executor-abi-preflight-result-schema:1\n',
        G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
      ),
    ],
    [
      G3_RETENTION_EXECUTOR_ABI_POSITIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-retention-executor-abi-positive-cases/1',
        'icarus.workflow-g3-retention-executor-abi-positive-cases',
        'icarus:workflow-g3-retention-executor-abi-positive-cases:1\n',
        { fixture_scope: 'test_only', cases: fixtures.positive },
      ),
    ],
    [
      G3_RETENTION_EXECUTOR_ABI_NEGATIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-retention-executor-abi-negative-cases/1',
        'icarus.workflow-g3-retention-executor-abi-negative-cases',
        'icarus:workflow-g3-retention-executor-abi-negative-cases:1\n',
        { fixture_scope: 'test_only', cases: fixtures.negative },
      ),
    ],
  ];
  const domains = artifact(
    'icarus.workflow-retention-executor-abi-preflight-domain-separators/1',
    'icarus.workflow-retention-executor-abi-preflight-domain-separators',
    DOMAIN_CATALOG_DOMAIN,
    {
      entries: entries
        .map(([, entry]) => ({
          format: entry.format,
          domain_separator: entry.domain_separator,
        }))
        .concat([
          {
            format:
              'icarus.workflow-retention-executor-abi-preflight-domain-separators/1',
            domain_separator: DOMAIN_CATALOG_DOMAIN,
          },
          {
            format:
              'icarus.workflow-contract-pack-g3-retention-executor-abi-preflight/1',
            domain_separator: PACK_DOMAIN,
          },
        ])
        .sort((left, right) => compareAscii(left.format, right.format)),
    },
  );
  return [...entries, [G3_RETENTION_EXECUTOR_ABI_DOMAIN_CATALOG_PATH, domains]];
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const fixtures = g3RetentionExecutorAbiFixturesForTest();
  return artifact(
    'icarus.workflow-contract-pack-g3-retention-executor-abi-preflight/1',
    'icarus.workflow-contract-pack-g3-retention-executor-abi-preflight',
    PACK_DOMAIN,
    {
      gate: 'G3',
      slice: 'G3.6',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      upstream_g3_3_pack_hash:
        'sha256:635fd7ac9c15212f50df1845a8267c5cad576aa34d475164e060946cb42987e5',
      upstream_g3_5_pack_hash:
        'sha256:bbc4e2cb402c8058a6412da0ebd5a284c2c7af831453cafaa84738a391c15718',
      upstream_g1_schema_root_hash:
        G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_root_hash,
      publisher_persistence_readiness: 'PUBLISHER_SCHEMA_PREREQUISITE_READY',
      publisher_schema_gap: null,
      resolution_mode: 'immutable_exact_only',
      snapshot_verifier_reused: 'G3.3',
      exact_resource_query_reused: 'G3.5',
      result_schema: 'closed',
      deterministic: true,
      read_only: true,
      retention_handle_created: false,
      gc_or_delete_performed: false,
      publication_state_updated: false,
      publisher_write_transaction_implemented: false,
      artifacts: artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
      positive_case_count: fixtures.positive.length,
      negative_case_count: fixtures.negative.length,
      g4_through_g9_status: 'NOT_READY',
    },
  );
}

function validateArtifacts(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  validateUpstreamIdentity();
  const profile = buildG3RetentionExecutorAbiProfile();
  if (!(validateProfileSchema(profile) as boolean))
    throw new Error(
      `G3.6 profile invalid: ${ajv.errorsText(validateProfileSchema.errors)}`,
    );
  const fixtures = g3RetentionExecutorAbiFixturesForTest();
  for (const fixture of fixtures.positive) {
    validateRetentionExecutorAbiPreflightInput(fixture.input);
    if (!(validateResultSchema(fixture.expected_result) as boolean))
      throw new Error(
        `G3.6 positive result invalid: ${fixture.case_id}: ${ajv.errorsText(validateResultSchema.errors)}`,
      );
  }
  for (const fixture of fixtures.negative.slice(0, 2)) {
    try {
      validateRetentionExecutorAbiPreflightInput(fixture.input);
      throw new Error(`G3.6 negative fixture accepted: ${fixture.case_id}`);
    } catch (error) {
      if (!(error instanceof G3RetentionExecutorAbiContractError)) throw error;
    }
  }
  for (const fixture of fixtures.negative.slice(2))
    validateRetentionExecutorAbiPreflightInput(fixture.input);
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest))
    throw new Error('G3.6 Contract Pack manifest is not deterministic');
}

export function generateG3RetentionExecutorAbiPreflight(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) writeAtomic(file, render(entry));
  writeAtomic(G3_RETENTION_EXECUTOR_ABI_MANIFEST_PATH, render(manifest));
  return manifest;
}

export function checkG3RetentionExecutorAbiPreflight(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(`G3.6 artifact bytes drift: ${file}`);
  }
  if (
    fs.readFileSync(
      absolute(G3_RETENTION_EXECUTOR_ABI_MANIFEST_PATH),
      'utf8',
    ) !== render(manifest)
  ) {
    throw new Error('G3.6 Contract Pack manifest bytes drift');
  }
  return manifest;
}

export function g3RetentionExecutorAbiSchemasForTest(): {
  profile: JsonObject;
  input: JsonObject;
  result: JsonObject;
} {
  return {
    profile: structuredClone(G3_RETENTION_EXECUTOR_ABI_PROFILE_SCHEMA),
    input: structuredClone(G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA),
    result: structuredClone(G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA),
  };
}
