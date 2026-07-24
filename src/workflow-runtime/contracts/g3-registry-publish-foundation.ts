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
  G3_CURRENT_UPSTREAM_IDENTITY,
  G3_PUBLISH_PREFLIGHT_ERROR_CODES,
  G3_REGISTRY_RESOURCE_TYPES,
  G3_RETENTION_POLICY_HASH,
  G3_RETENTION_POLICY_REF,
  type G3PublishPreflightErrorCode,
  type G3RegistryPublishPreflightInput,
  type G3RegistryPublishPreflightResult,
  type G3RegistryResourceCandidate,
  type G3RegistryResourceDependency,
} from './g3-registry-publish-types.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const G3_REGISTRY_PUBLISH_ROOT =
  'conformance/g3-registry-publish-foundation';
export const G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA_PATH =
  'registry/workflow-registry-publish-preflight-schema@1.json';
export const G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA_PATH =
  'registry/workflow-registry-publish-preflight-result-schema@1.json';
export const G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA_PATH =
  'registry/workflow-registry-publish-foundation-schema@1.json';
export const G3_REGISTRY_PUBLISH_FOUNDATION_PATH =
  'registry/workflow-registry-publish-foundation@1.json';
export const G3_REGISTRY_PUBLISH_POSITIVE_CASES_PATH = `${G3_REGISTRY_PUBLISH_ROOT}/positive-cases.json`;
export const G3_REGISTRY_PUBLISH_NEGATIVE_CASES_PATH = `${G3_REGISTRY_PUBLISH_ROOT}/negative-cases.json`;
export const G3_REGISTRY_PUBLISH_DOMAIN_CATALOG_PATH =
  'registry/workflow-registry-publish-domain-separators@1.json';
export const G3_REGISTRY_PUBLISH_MANIFEST_PATH =
  'contract-pack-g3-registry-publish-foundation.json';

export const G3_PREFLIGHT_DOMAIN =
  'icarus:workflow-registry-publish-preflight:1\n';
export const G3_RESOURCE_CANDIDATE_DOMAIN =
  'icarus:workflow-registry-resource-candidate:1\n';
export const G3_DEPENDENCY_CLOSURE_DOMAIN =
  'icarus:workflow-registry-dependency-closure:1\n';

const PREFLIGHT_SCHEMA_DOMAIN =
  'icarus:workflow-registry-publish-preflight-schema:1\n';
const PREFLIGHT_RESULT_SCHEMA_DOMAIN =
  'icarus:workflow-registry-publish-preflight-result-schema:1\n';
const FOUNDATION_SCHEMA_DOMAIN =
  'icarus:workflow-registry-publish-foundation-schema:1\n';
const FOUNDATION_DOMAIN = 'icarus:workflow-registry-publish-foundation:1\n';
const POSITIVE_CASES_DOMAIN =
  'icarus:workflow-g3-registry-publish-positive-cases:1\n';
const NEGATIVE_CASES_DOMAIN =
  'icarus:workflow-g3-registry-publish-negative-cases:1\n';
const DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-g3-registry-publish-domain-separators:1\n';
const MANIFEST_DOMAIN =
  'icarus:workflow-contract-pack-g3-registry-publish-foundation:1\n';

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const REF_ID_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,253}[A-Za-z0-9])?$';
const REF_VERSION_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$';

const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: REF_ID_PATTERN,
    },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: REF_VERSION_PATTERN,
      not: {
        anyOf: [
          {
            pattern:
              '^(?:[Cc][Uu][Rr][Rr][Ee][Nn][Tt]|[Hh][Ee][Aa][Dd]|[Ll][Aa][Tt][Ee][Ss][Tt]|[Mm][Aa][Ii][Nn]|[Mm][Aa][Ss][Tt][Ee][Rr]|[Nn][Ee][Xx][Tt]|[Ss][Nn][Aa][Pp][Ss][Hh][Oo][Tt])$',
          },
          { pattern: '(?:^|[._-])[xX](?:$|[._-])' },
        ],
      },
    },
  },
};

const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };
const nullableHashSchema: JsonObject = {
  anyOf: [hashSchema, { type: 'null' }],
};
const nullableRefSchema: JsonObject = {
  anyOf: [{ $ref: '#/$defs/versioned_ref' }, { type: 'null' }],
};

export const G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-publish-preflight/1',
  title: 'WorkflowRegistryPublishPreflightV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'operation',
    'target_registry',
    'fixture_scope',
    'feature_manifest_ref',
    'feature_manifest_hash',
    'feature_release_ref',
    'feature_release_hash',
    'resources',
    'upstream_identity',
    'expected_oracle',
    'production_compiler_actual_role',
    'retention_policy_ref',
    'retention_policy_hash',
    'compatibility',
    'requested_registry_write',
    'requested_activation',
    'preflight_hash',
  ],
  properties: {
    format: { const: 'icarus.workflow-registry-publish-preflight/1' },
    operation: { const: 'validate_only' },
    target_registry: { enum: ['production', 'test_only'] },
    fixture_scope: { enum: ['none', 'test_only'] },
    feature_manifest_ref: nullableRefSchema,
    feature_manifest_hash: nullableHashSchema,
    feature_release_ref: nullableRefSchema,
    feature_release_hash: nullableHashSchema,
    resources: {
      type: 'array',
      items: { $ref: '#/$defs/resource_candidate' },
      maxItems: 4096,
    },
    upstream_identity: { $ref: '#/$defs/upstream_identity' },
    expected_oracle: { const: 'sealed_g2_independent_expected' },
    production_compiler_actual_role: {
      enum: ['comparison_only', 'expected_oracle'],
    },
    retention_policy_ref: { $ref: '#/$defs/versioned_ref' },
    retention_policy_hash: hashSchema,
    compatibility: {
      type: 'object',
      additionalProperties: false,
      required: [
        'run_protocol_major',
        'executor_abi_major',
        'registry_schema_version',
      ],
      properties: {
        run_protocol_major: { type: 'integer', minimum: 1 },
        executor_abi_major: { type: 'integer', minimum: 1 },
        registry_schema_version: { type: 'integer', minimum: 1 },
      },
    },
    requested_registry_write: { type: 'boolean' },
    requested_activation: { type: 'boolean' },
    preflight_hash: hashSchema,
  },
  $defs: {
    versioned_ref: versionedRefSchema,
    dependency: {
      type: 'object',
      additionalProperties: false,
      required: ['resource_type', 'ref', 'content_hash'],
      properties: {
        resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
        ref: { $ref: '#/$defs/versioned_ref' },
        content_hash: hashSchema,
      },
    },
    capability_outbox_binding: {
      type: 'object',
      additionalProperties: false,
      required: [
        'effect_type',
        'adapter',
        'delivery_policy',
        'policy_snapshot_source_hash',
        'delivery_lane',
        'reconciliation',
        'idempotency',
        'delivery_requirement',
      ],
      properties: {
        effect_type: { const: 'capability_dispatch' },
        adapter: {
          type: 'object',
          additionalProperties: false,
          required: ['resource_type', 'ref', 'content_hash'],
          properties: {
            resource_type: { const: 'outbox_adapter' },
            ref: { $ref: '#/$defs/versioned_ref' },
            content_hash: hashSchema,
          },
        },
        delivery_policy: {
          type: 'object',
          additionalProperties: false,
          required: ['resource_type', 'ref', 'content_hash'],
          properties: {
            resource_type: { const: 'outbox_policy' },
            ref: { $ref: '#/$defs/versioned_ref' },
            content_hash: hashSchema,
          },
        },
        policy_snapshot_source_hash: hashSchema,
        delivery_lane: { const: 'normal_execution' },
        reconciliation: { enum: ['not_required', 'by_effect_key'] },
        idempotency: { enum: ['provider_key', 'external_lookup'] },
        delivery_requirement: { const: 'required' },
      },
    },
    compiled_plan_pin: {
      type: 'object',
      additionalProperties: false,
      required: [
        'plan_ref',
        'plan_hash',
        'plan_format',
        'compiler_toolchain_hash',
        'compiler_build_hash',
        'provenance',
      ],
      properties: {
        plan_ref: { type: 'string', minLength: 1 },
        plan_hash: hashSchema,
        plan_format: { const: 'icarus.workflow-graph-scope-plan/2' },
        compiler_toolchain_hash: hashSchema,
        compiler_build_hash: hashSchema,
        provenance: { const: 'sealed_g2_expected' },
      },
    },
    execution_artifact_pin: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'artifact_hash', 'runtime_kind', 'runtime_abi_major'],
      properties: {
        ref: { $ref: '#/$defs/versioned_ref' },
        artifact_hash: hashSchema,
        runtime_kind: { const: 'node_bundle' },
        runtime_abi_major: { type: 'integer', minimum: 1 },
      },
    },
    resource_candidate: {
      type: 'object',
      additionalProperties: false,
      required: [
        'resource_type',
        'ref',
        'launchability',
        'content_hash',
        'dependencies',
        'compiled_plan_pin',
        'execution_artifact_pin',
        'capability_outbox_binding',
        'resource_hash',
      ],
      properties: {
        resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
        ref: { $ref: '#/$defs/versioned_ref' },
        launchability: { enum: ['production', 'test_only'] },
        content_hash: hashSchema,
        dependencies: {
          type: 'array',
          items: { $ref: '#/$defs/dependency' },
          uniqueItems: true,
          maxItems: 4096,
        },
        compiled_plan_pin: {
          anyOf: [{ $ref: '#/$defs/compiled_plan_pin' }, { type: 'null' }],
        },
        execution_artifact_pin: {
          anyOf: [{ $ref: '#/$defs/execution_artifact_pin' }, { type: 'null' }],
        },
        capability_outbox_binding: {
          anyOf: [
            { $ref: '#/$defs/capability_outbox_binding' },
            { type: 'null' },
          ],
        },
        resource_hash: hashSchema,
      },
    },
    compiler_identity: {
      type: 'object',
      additionalProperties: false,
      required: [
        'compiler_toolchain_manifest_ref',
        'compiler_toolchain_hash',
        'compiler_version',
        'compiler_build_hash',
        'compiled_ir_schema_ref',
        'compiled_ir_schema_hash',
        'conformance_result_schema_ref',
        'conformance_result_schema_hash',
      ],
      properties: {
        compiler_toolchain_manifest_ref: { $ref: '#/$defs/versioned_ref' },
        compiler_toolchain_hash: hashSchema,
        compiler_version: { type: 'string', minLength: 1 },
        compiler_build_hash: hashSchema,
        compiled_ir_schema_ref: { type: 'string', minLength: 1 },
        compiled_ir_schema_hash: hashSchema,
        conformance_result_schema_ref: { type: 'string', minLength: 1 },
        conformance_result_schema_hash: hashSchema,
      },
    },
    upstream_identity: {
      type: 'object',
      additionalProperties: false,
      required: [
        'g1_schema_root_hash',
        'g1_schema_dependency_manifest_hash',
        'g1_physical_schema_identity',
        'g1_schema_hash',
        'g1_migration_sha256',
        'g2_sealed_bundle_ref',
        'g2_sealed_bundle_artifact_hash',
        'g2_sealed_bundle_hash',
        'compiler',
      ],
      properties: {
        g1_schema_root_hash: hashSchema,
        g1_schema_dependency_manifest_hash: hashSchema,
        g1_physical_schema_identity: hashSchema,
        g1_schema_hash: hashSchema,
        g1_migration_sha256: hashSchema,
        g2_sealed_bundle_ref: { type: 'string', minLength: 1 },
        g2_sealed_bundle_artifact_hash: hashSchema,
        g2_sealed_bundle_hash: hashSchema,
        compiler: { $ref: '#/$defs/compiler_identity' },
      },
    },
  },
};

function preflightResultBranch(outcome: 'accepted' | 'rejected'): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'outcome',
      'code',
      'target_registry',
      'resource_count',
      'recipe_count',
      'dependency_closure_hash',
      'side_effects',
    ],
    properties: {
      format: {
        const: 'icarus.workflow-registry-publish-preflight-result/1',
      },
      outcome: { const: outcome },
      code:
        outcome === 'accepted'
          ? { const: 'preflight_ok' }
          : { enum: [...G3_PUBLISH_PREFLIGHT_ERROR_CODES] },
      target_registry:
        outcome === 'accepted'
          ? { enum: ['production', 'test_only'] }
          : {
              anyOf: [{ enum: ['production', 'test_only'] }, { type: 'null' }],
            },
      resource_count: { type: 'integer', minimum: 0, maximum: 4096 },
      recipe_count: { type: 'integer', minimum: 0, maximum: 4096 },
      dependency_closure_hash:
        outcome === 'accepted' ? hashSchema : { type: 'null' },
      side_effects: { const: 'none_by_contract' },
    },
  };
}

export const G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-publish-preflight-result/1',
  title: 'WorkflowRegistryPublishPreflightResultV1',
  oneOf: [preflightResultBranch('accepted'), preflightResultBranch('rejected')],
};

export const G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-publish-foundation/1',
  title: 'WorkflowRegistryPublishFoundationV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'gate',
    'slice',
    'slice_status',
    'g3_status',
    'implemented_surface',
    'upstream_identity',
    'feature_manifest_schema',
    'recipe_schema',
    'retention_policy',
    'compatibility',
    'production_registry_baseline',
    'test_only_boundary',
    'authoring_publish_stages',
    'publisher_oracle_policy',
    'preflight_error_codes',
    'g4_through_g9_status',
    'foundation_hash',
  ],
  properties: {
    format: { const: 'icarus.workflow-registry-publish-foundation/1' },
    gate: { const: 'G3' },
    slice: { const: 'G3.1' },
    slice_status: { const: 'DONE' },
    g3_status: { const: 'IN_PROGRESS' },
    implemented_surface: {
      const: 'read_only_registry_publish_preflight_contract',
    },
    upstream_identity: G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA.$defs
      ? {
          $ref: 'workflow-registry-publish-preflight-schema@1.json#/$defs/upstream_identity',
        }
      : {},
    feature_manifest_schema: { $ref: '#/$defs/exact_artifact' },
    recipe_schema: { $ref: '#/$defs/exact_artifact' },
    retention_policy: { $ref: '#/$defs/exact_artifact' },
    compatibility: {
      type: 'object',
      additionalProperties: false,
      required: [
        'run_protocol_major',
        'executor_abi_major',
        'registry_schema_version',
        'core_release_preflight_status',
      ],
      properties: {
        run_protocol_major: { const: 1 },
        executor_abi_major: { const: 1 },
        registry_schema_version: { const: 1 },
        core_release_preflight_status: {
          const: 'not_implemented_in_g3_1',
        },
      },
    },
    production_registry_baseline: {
      type: 'object',
      additionalProperties: false,
      required: [
        'published_recipe_count',
        'checked_in_published_resource_count',
        'active_feature_release_count',
        'synthetic_resource_count',
        'zero_recipe_allowed',
        'production_database_observation',
        'registry_write_performed',
        'activation_performed',
      ],
      properties: {
        published_recipe_count: { const: 0 },
        checked_in_published_resource_count: { const: 0 },
        active_feature_release_count: { const: 0 },
        synthetic_resource_count: { const: 0 },
        zero_recipe_allowed: { const: true },
        production_database_observation: { const: 'not_performed' },
        registry_write_performed: { const: false },
        activation_performed: { const: false },
      },
    },
    test_only_boundary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'fixture_root',
        'required_launchability',
        'production_promotion',
        'production_loader_policy',
      ],
      properties: {
        fixture_root: { const: G3_REGISTRY_PUBLISH_ROOT },
        required_launchability: { const: 'test_only' },
        production_promotion: { const: 'forbidden' },
        production_loader_policy: { const: 'fail_closed' },
      },
    },
    authoring_publish_stages: {
      type: 'object',
      additionalProperties: false,
      required: [
        'scaffold',
        'validate',
        'compile',
        'dry_run',
        'review',
        'publish',
        'activate',
      ],
      properties: Object.fromEntries(
        [
          'scaffold',
          'validate',
          'compile',
          'dry_run',
          'review',
          'publish',
          'activate',
        ].map((stage) => [stage, { const: 'not_implemented' }]),
      ),
    },
    publisher_oracle_policy: {
      type: 'object',
      additionalProperties: false,
      required: ['expected_source', 'production_compiler_actual_role'],
      properties: {
        expected_source: { const: 'current_g2_sealed_bundle_only' },
        production_compiler_actual_role: { const: 'comparison_only' },
      },
    },
    preflight_error_codes: {
      type: 'array',
      prefixItems: G3_PUBLISH_PREFLIGHT_ERROR_CODES.map((code) => ({
        const: code,
      })),
      items: false,
      minItems: G3_PUBLISH_PREFLIGHT_ERROR_CODES.length,
      maxItems: G3_PUBLISH_PREFLIGHT_ERROR_CODES.length,
    },
    g4_through_g9_status: {
      type: 'object',
      additionalProperties: false,
      required: ['G4', 'G5', 'G6', 'G7', 'G8', 'G9'],
      properties: Object.fromEntries(
        ['G4', 'G5', 'G6', 'G7', 'G8', 'G9'].map((gate) => [
          gate,
          { const: 'NOT_READY' },
        ]),
      ),
    },
    foundation_hash: hashSchema,
  },
  $defs: {
    exact_artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'ref', 'hash'],
      properties: {
        path: { type: 'string', minLength: 1 },
        ref: versionedRefSchema,
        hash: hashSchema,
      },
    },
  },
};

// Ajv cannot resolve the sibling schema path while validating an in-memory
// artifact, so the foundation schema receives the exact closed definition.
(
  G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA.properties as JsonObject
).upstream_identity = structuredClone(
  (G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA.$defs as JsonObject).upstream_identity,
) as JsonObject;
(G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA.$defs as JsonObject).compiler_identity =
  structuredClone(
    (G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA.$defs as JsonObject)
      .compiler_identity,
  ) as JsonObject;
(G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA.$defs as JsonObject).versioned_ref =
  structuredClone(versionedRefSchema) as JsonObject;

export class G3RegistryPublishPreflightError extends Error {
  readonly code = 'g3_registry_publish_preflight_error';

  constructor(message: string) {
    super(message);
    this.name = 'G3RegistryPublishPreflightError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function withoutField(value: JsonObject, field: string): JsonObject {
  const output = clone(value);
  delete output[field];
  return output;
}

function artifact(
  format: string,
  id: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G3RegistryPublishPreflightError(
      `G3 Contract path escapes root: ${relativePath}`,
    );
  }
  return resolved;
}

function resourceKey(
  resource: Pick<G3RegistryResourceCandidate, 'resource_type' | 'ref'>,
): string {
  return `${resource.resource_type}\0${resource.ref.id}@${resource.ref.version}`;
}

function dependencyKey(dependency: G3RegistryResourceDependency): string {
  return `${dependency.resource_type}\0${dependency.ref.id}@${dependency.ref.version}`;
}

export function calculateG3RegistryResourceHash(
  resource: G3RegistryResourceCandidate,
): Sha256Hash {
  return domainSeparatedSha256(
    G3_RESOURCE_CANDIDATE_DOMAIN,
    withoutField(resource, 'resource_hash'),
  );
}

export function calculateG3PublishPreflightHash(
  input: G3RegistryPublishPreflightInput,
): Sha256Hash {
  return domainSeparatedSha256(
    G3_PREFLIGHT_DOMAIN,
    withoutField(input, 'preflight_hash'),
  );
}

function dependencyClosureHash(
  resources: G3RegistryResourceCandidate[],
): Sha256Hash {
  return domainSeparatedSha256(G3_DEPENDENCY_CLOSURE_DOMAIN, {
    members: resources.map((resource) => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
      resource_hash: resource.resource_hash,
      dependencies: resource.dependencies,
    })),
  });
}

function rejected(
  code: G3PublishPreflightErrorCode,
  input: JsonObject | null,
): G3RegistryPublishPreflightResult {
  const resources = Array.isArray(input?.resources) ? input.resources : [];
  return {
    format: 'icarus.workflow-registry-publish-preflight-result/1',
    outcome: 'rejected',
    code,
    target_registry:
      input?.target_registry === 'production' ||
      input?.target_registry === 'test_only'
        ? input.target_registry
        : null,
    resource_count: resources.length,
    recipe_count: resources.filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        entry.resource_type === 'recipe',
    ).length,
    dependency_closure_hash: null,
    side_effects: 'none_by_contract',
  };
}

function hasDependencyCycle(resources: G3RegistryResourceCandidate[]): boolean {
  const byKey = new Map(
    resources.map((resource) => [resourceKey(resource), resource]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) {
      const child = dependencyKey(dependency);
      if (byKey.has(child) && visit(child)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return [...byKey.keys()].some(visit);
}

const validatePreflight = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
}).compile(G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA as AnySchema);

export function evaluateG3RegistryPublishPreflight(
  value: JsonValue,
): G3RegistryPublishPreflightResult {
  if (!validatePreflight(value)) return rejected('schema_invalid', null);
  assertJsonObject(value);
  const input = value as unknown as G3RegistryPublishPreflightInput;
  if (calculateG3PublishPreflightHash(input) !== input.preflight_hash) {
    return rejected('preflight_hash_mismatch', value);
  }
  if (
    canonicalJson(input.upstream_identity) !==
    canonicalJson(G3_CURRENT_UPSTREAM_IDENTITY)
  ) {
    return rejected('g2_identity_mismatch', value);
  }
  if (input.production_compiler_actual_role !== 'comparison_only') {
    return rejected('production_compiler_actual_oracle_forbidden', value);
  }
  if (input.requested_registry_write || input.requested_activation) {
    return rejected('publisher_side_effect_requested', value);
  }
  if (
    canonicalJson(input.retention_policy_ref) !==
      canonicalJson(G3_RETENTION_POLICY_REF) ||
    input.retention_policy_hash !== G3_RETENTION_POLICY_HASH
  ) {
    return rejected('retention_identity_mismatch', value);
  }
  if (
    (input.feature_manifest_ref === null) !==
      (input.feature_manifest_hash === null) ||
    (input.feature_release_ref === null) !==
      (input.feature_release_hash === null)
  ) {
    return rejected('feature_identity_pair_mismatch', value);
  }
  if (
    input.compatibility.run_protocol_major !== 1 ||
    input.compatibility.executor_abi_major !== 1 ||
    input.compatibility.registry_schema_version !== 1 ||
    input.resources.some(
      (resource) =>
        resource.execution_artifact_pin !== null &&
        resource.execution_artifact_pin.runtime_abi_major !== 1,
    )
  ) {
    return rejected('execution_artifact_abi_mismatch', value);
  }
  const resources = input.resources;
  const keys = resources.map(resourceKey);
  if (new Set(keys).size !== keys.length) {
    return rejected('registry_resource_identity_duplicate', value);
  }
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    return rejected('registry_resource_order_invalid', value);
  }
  for (const resource of resources) {
    if (calculateG3RegistryResourceHash(resource) !== resource.resource_hash) {
      return rejected('registry_resource_hash_mismatch', value);
    }
    if (
      resource.compiled_plan_pin !== null &&
      (resource.compiled_plan_pin.compiler_toolchain_hash !==
        G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_toolchain_hash ||
        resource.compiled_plan_pin.compiler_build_hash !==
          G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_build_hash)
    ) {
      return rejected('g2_identity_mismatch', value);
    }
  }
  for (const resource of resources) {
    const binding = resource.capability_outbox_binding;
    if (resource.resource_type === 'capability' && binding === null) {
      return rejected('capability_outbox_binding_required', value);
    }
    if (resource.resource_type !== 'capability' && binding !== null) {
      return rejected('capability_outbox_binding_mismatch', value);
    }
    if (binding === null) continue;
    const dependencyKeys = new Set(resource.dependencies.map(dependencyKey));
    const adapterKey = dependencyKey(binding.adapter);
    const policyKey = dependencyKey(binding.delivery_policy);
    const adapter = resources.find(
      (candidate) => resourceKey(candidate) === adapterKey,
    );
    const policy = resources.find(
      (candidate) => resourceKey(candidate) === policyKey,
    );
    if (
      !dependencyKeys.has(adapterKey) ||
      !dependencyKeys.has(policyKey) ||
      adapter?.content_hash !== binding.adapter.content_hash ||
      policy?.content_hash !== binding.delivery_policy.content_hash ||
      binding.policy_snapshot_source_hash !==
        binding.delivery_policy.content_hash ||
      adapter?.launchability !== resource.launchability ||
      policy?.launchability !== resource.launchability
    ) {
      return rejected('capability_outbox_binding_mismatch', value);
    }
  }
  if (
    input.target_registry === 'production' &&
    resources.some((resource) => resource.launchability === 'test_only')
  ) {
    return rejected('test_only_promotion_forbidden', value);
  }
  if (
    (input.target_registry === 'production' &&
      input.fixture_scope !== 'none') ||
    (input.target_registry === 'test_only' &&
      input.fixture_scope !== 'test_only') ||
    (resources.some((resource) => resource.launchability === 'test_only') &&
      input.fixture_scope !== 'test_only')
  ) {
    return rejected('test_only_scope_mismatch', value);
  }
  if (
    resources.some(
      (resource) =>
        (resource.resource_type === 'definition' ||
          resource.resource_type === 'graph_template') &&
        resource.compiled_plan_pin === null,
    )
  ) {
    return rejected('compiled_plan_pin_required', value);
  }
  if (
    resources.some(
      (resource) =>
        (resource.resource_type === 'executor_implementation' ||
          resource.resource_type === 'feature_execution_artifact') &&
        resource.execution_artifact_pin === null,
    )
  ) {
    return rejected('execution_artifact_pin_required', value);
  }
  const byKey = new Map(
    resources.map((resource) => [resourceKey(resource), resource]),
  );
  for (const resource of resources) {
    const dependencyKeys = resource.dependencies.map(dependencyKey);
    if (
      new Set(dependencyKeys).size !== dependencyKeys.length ||
      JSON.stringify(dependencyKeys) !==
        JSON.stringify([...dependencyKeys].sort()) ||
      resource.dependencies.some((dependency) => {
        const target = byKey.get(dependencyKey(dependency));
        return !target || target.content_hash !== dependency.content_hash;
      })
    ) {
      return rejected('registry_resource_dependency_missing', value);
    }
  }
  if (hasDependencyCycle(resources)) {
    return rejected('registry_resource_dependency_cycle', value);
  }
  return {
    format: 'icarus.workflow-registry-publish-preflight-result/1',
    outcome: 'accepted',
    code: 'preflight_ok',
    target_registry: input.target_registry,
    resource_count: resources.length,
    recipe_count: resources.filter(
      (resource) => resource.resource_type === 'recipe',
    ).length,
    dependency_closure_hash: dependencyClosureHash(resources),
    side_effects: 'none_by_contract',
  };
}

export function parseAndEvaluateG3RegistryPublishPreflight(
  bytes: Uint8Array,
): G3RegistryPublishPreflightResult {
  return evaluateG3RegistryPublishPreflight(strictParseJsonBytes(bytes));
}

type G3RegistryResourceCandidateWithoutHash = Pick<
  G3RegistryResourceCandidate,
  | 'resource_type'
  | 'ref'
  | 'launchability'
  | 'content_hash'
  | 'dependencies'
  | 'compiled_plan_pin'
  | 'execution_artifact_pin'
> & {
  capability_outbox_binding?: Exclude<
    G3RegistryResourceCandidate['capability_outbox_binding'],
    null
  >;
};

type G3RegistryPublishPreflightWithoutHash = Pick<
  G3RegistryPublishPreflightInput,
  | 'format'
  | 'operation'
  | 'target_registry'
  | 'fixture_scope'
  | 'feature_manifest_ref'
  | 'feature_manifest_hash'
  | 'feature_release_ref'
  | 'feature_release_hash'
  | 'resources'
  | 'upstream_identity'
  | 'expected_oracle'
  | 'production_compiler_actual_role'
  | 'retention_policy_ref'
  | 'retention_policy_hash'
  | 'compatibility'
  | 'requested_registry_write'
  | 'requested_activation'
>;

function withResourceHash(
  resource: G3RegistryResourceCandidateWithoutHash,
): G3RegistryResourceCandidate {
  const complete: G3RegistryResourceCandidate = {
    resource_type: resource.resource_type,
    ref: resource.ref,
    launchability: resource.launchability,
    content_hash: resource.content_hash,
    dependencies: resource.dependencies,
    compiled_plan_pin: resource.compiled_plan_pin,
    execution_artifact_pin: resource.execution_artifact_pin,
    capability_outbox_binding: resource.capability_outbox_binding ?? null,
    resource_hash: `sha256:${'0'.repeat(64)}` as Sha256Hash,
  };
  complete.resource_hash = calculateG3RegistryResourceHash(complete);
  return complete;
}

function withPreflightHash(
  input: G3RegistryPublishPreflightWithoutHash,
): G3RegistryPublishPreflightInput {
  const complete: G3RegistryPublishPreflightInput = {
    format: input.format,
    operation: input.operation,
    target_registry: input.target_registry,
    fixture_scope: input.fixture_scope,
    feature_manifest_ref: input.feature_manifest_ref,
    feature_manifest_hash: input.feature_manifest_hash,
    feature_release_ref: input.feature_release_ref,
    feature_release_hash: input.feature_release_hash,
    resources: input.resources,
    upstream_identity: input.upstream_identity,
    expected_oracle: input.expected_oracle,
    production_compiler_actual_role: input.production_compiler_actual_role,
    retention_policy_ref: input.retention_policy_ref,
    retention_policy_hash: input.retention_policy_hash,
    compatibility: input.compatibility,
    requested_registry_write: input.requested_registry_write,
    requested_activation: input.requested_activation,
    preflight_hash: `sha256:${'0'.repeat(64)}` as Sha256Hash,
  };
  complete.preflight_hash = calculateG3PublishPreflightHash(complete);
  return complete;
}

function basePreflight(
  overrides: Partial<G3RegistryPublishPreflightInput> = {},
): G3RegistryPublishPreflightInput {
  return withPreflightHash({
    format: 'icarus.workflow-registry-publish-preflight/1',
    operation: 'validate_only',
    target_registry: 'production',
    fixture_scope: 'none',
    feature_manifest_ref: null,
    feature_manifest_hash: null,
    feature_release_ref: null,
    feature_release_hash: null,
    resources: [],
    upstream_identity: clone(G3_CURRENT_UPSTREAM_IDENTITY),
    expected_oracle: 'sealed_g2_independent_expected',
    production_compiler_actual_role: 'comparison_only',
    retention_policy_ref: clone(G3_RETENTION_POLICY_REF),
    retention_policy_hash: G3_RETENTION_POLICY_HASH,
    compatibility: {
      run_protocol_major: 1,
      executor_abi_major: 1,
      registry_schema_version: 1,
    },
    requested_registry_write: false,
    requested_activation: false,
    ...overrides,
  });
}

const testOnlyDefinition = withResourceHash({
  resource_type: 'definition',
  ref: { id: 'test-only.fixture.definition', version: '1.0.0' },
  launchability: 'test_only',
  content_hash:
    'sha256:ede8625861f47dcd9eebd48b232c36dd04f72bc8c702928070ea186643863937',
  dependencies: [],
  compiled_plan_pin: {
    plan_ref:
      'conformance/sealed/g2-generated-schema-join-authority-v5/expected/positive.static-lowering.plan.json',
    plan_hash:
      'sha256:266fd7bb686a454e8615c6147e963661a340e30e279e92e0d02f135f9e459bac',
    plan_format: 'icarus.workflow-graph-scope-plan/2',
    compiler_toolchain_hash:
      G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_toolchain_hash,
    compiler_build_hash:
      G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_build_hash,
    provenance: 'sealed_g2_expected',
  },
  execution_artifact_pin: null,
});

const testOnlyExecutor = withResourceHash({
  resource_type: 'executor_implementation',
  ref: { id: 'test-only.fixture.executor', version: '1.0.0' },
  launchability: 'test_only',
  content_hash:
    'sha256:548f92e87081021be5eb1009b0c7d224f06a70f5789f77d81a84999a64bca4fa',
  dependencies: [],
  compiled_plan_pin: null,
  execution_artifact_pin: {
    ref: { id: 'test-only.fixture.node-bundle', version: '1.0.0' },
    artifact_hash:
      'sha256:22ba4459e49921fc825061c930dff3926a77200b50267461937731a3d24b74cf',
    runtime_kind: 'node_bundle',
    runtime_abi_major: 1,
  },
});

const EMPTY_PRODUCTION_PREFLIGHT = basePreflight();
const TEST_ONLY_PREFLIGHT = basePreflight({
  target_registry: 'test_only',
  fixture_scope: 'test_only',
  feature_manifest_ref: {
    id: 'test-only.fixture.feature-manifest',
    version: '2.0.0',
  },
  feature_manifest_hash:
    'sha256:39f2af1a1ce0d9c02a07da3dbcc286406211d1f1f29c54ac01d457dd71b93f06',
  feature_release_ref: {
    id: 'test-only.fixture.feature-release',
    version: '1.0.0',
  },
  feature_release_hash:
    'sha256:053c39cbd9ee956b0235e858047aac0154d92ace618cb18aa20b619e70609e2f',
  resources: [testOnlyDefinition, testOnlyExecutor],
});

const testOnlyAdapter = withResourceHash({
  resource_type: 'outbox_adapter',
  ref: { id: 'test-only.fixture.adapter', version: '1.0.0' },
  launchability: 'test_only',
  content_hash:
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  dependencies: [],
  compiled_plan_pin: null,
  execution_artifact_pin: null,
});
const testOnlyPolicy = withResourceHash({
  resource_type: 'outbox_policy',
  ref: { id: 'test-only.fixture.outbox-policy', version: '1.0.0' },
  launchability: 'test_only',
  content_hash:
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  dependencies: [],
  compiled_plan_pin: null,
  execution_artifact_pin: null,
});
const testOnlyCapability = withResourceHash({
  resource_type: 'capability',
  ref: { id: 'test-only.fixture.capability', version: '1.0.0' },
  launchability: 'test_only',
  content_hash:
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  dependencies: [
    {
      resource_type: 'outbox_adapter',
      ref: testOnlyAdapter.ref,
      content_hash: testOnlyAdapter.content_hash,
    },
    {
      resource_type: 'outbox_policy',
      ref: testOnlyPolicy.ref,
      content_hash: testOnlyPolicy.content_hash,
    },
  ],
  compiled_plan_pin: null,
  execution_artifact_pin: null,
  capability_outbox_binding: {
    effect_type: 'capability_dispatch',
    adapter: {
      resource_type: 'outbox_adapter',
      ref: testOnlyAdapter.ref,
      content_hash: testOnlyAdapter.content_hash,
    },
    delivery_policy: {
      resource_type: 'outbox_policy',
      ref: testOnlyPolicy.ref,
      content_hash: testOnlyPolicy.content_hash,
    },
    policy_snapshot_source_hash: testOnlyPolicy.content_hash,
    delivery_lane: 'normal_execution',
    reconciliation: 'not_required',
    idempotency: 'provider_key',
    delivery_requirement: 'required',
  },
});
const TEST_ONLY_CAPABILITY_PREFLIGHT = basePreflight({
  target_registry: 'test_only',
  fixture_scope: 'test_only',
  feature_manifest_ref: {
    id: 'test-only.fixture.feature-manifest',
    version: '2.0.0',
  },
  feature_manifest_hash:
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  feature_release_ref: {
    id: 'test-only.fixture.feature-release',
    version: '1.0.0',
  },
  feature_release_hash:
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  resources: [testOnlyCapability, testOnlyAdapter, testOnlyPolicy],
});

interface PositiveCase extends JsonObject {
  case_id: string;
  fixture_scope: 'test_only';
  input: G3RegistryPublishPreflightInput;
  expected_result: G3RegistryPublishPreflightResult;
}

interface Mutation extends JsonObject {
  operation: 'set' | 'delete' | 'append_resource' | 'reverse_resources';
  pointer: string;
  value: JsonValue;
}

interface NegativeCase extends JsonObject {
  case_id: string;
  fixture_scope: 'test_only';
  base_case_id: string;
  mutations: Mutation[];
  rehash_resource_hashes: boolean;
  rehash_preflight_hash: boolean;
  expected_code: G3PublishPreflightErrorCode;
}

const POSITIVE_CASES: PositiveCase[] = [
  {
    case_id: 'positive.production-empty-registry',
    fixture_scope: 'test_only',
    input: EMPTY_PRODUCTION_PREFLIGHT,
    expected_result: evaluateG3RegistryPublishPreflight(
      EMPTY_PRODUCTION_PREFLIGHT,
    ),
  },
  {
    case_id: 'positive.test-only-definition-and-executor',
    fixture_scope: 'test_only',
    input: TEST_ONLY_PREFLIGHT,
    expected_result: evaluateG3RegistryPublishPreflight(TEST_ONLY_PREFLIGHT),
  },
  {
    case_id: 'positive.test-only-capability-outbox-binding',
    fixture_scope: 'test_only',
    input: TEST_ONLY_CAPABILITY_PREFLIGHT,
    expected_result: evaluateG3RegistryPublishPreflight(
      TEST_ONLY_CAPABILITY_PREFLIGHT,
    ),
  },
];

const NEGATIVE_CASES: NegativeCase[] = [
  {
    case_id: 'negative.capability-outbox-binding-missing',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-capability-outbox-binding',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/capability_outbox_binding',
        value: null,
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'capability_outbox_binding_required',
  },
  {
    case_id: 'negative.capability-outbox-policy-hash-mismatch',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-capability-outbox-binding',
    mutations: [
      {
        operation: 'set',
        pointer:
          '/resources/0/capability_outbox_binding/policy_snapshot_source_hash',
        value:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'capability_outbox_binding_mismatch',
  },
  {
    case_id: 'negative.capability-outbox-latest-adapter',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-capability-outbox-binding',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/capability_outbox_binding/adapter/ref/version',
        value: 'latest',
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'schema_invalid',
  },
  {
    case_id: 'negative.capability-outbox-test-only-production',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-capability-outbox-binding',
    mutations: [
      { operation: 'set', pointer: '/target_registry', value: 'production' },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'test_only_promotion_forbidden',
  },
  {
    case_id: 'negative.unknown-field',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [{ operation: 'set', pointer: '/unknown_field', value: true }],
    rehash_resource_hashes: false,
    rehash_preflight_hash: false,
    expected_code: 'schema_invalid',
  },
  {
    case_id: 'negative.moving-ref',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/ref/version',
        value: 'latest',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: false,
    expected_code: 'schema_invalid',
  },
  {
    case_id: 'negative.preflight-hash',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/preflight_hash',
        value:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: false,
    expected_code: 'preflight_hash_mismatch',
  },
  {
    case_id: 'negative.g2-sealed-identity',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/upstream_identity/g2_sealed_bundle_hash',
        value:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'g2_identity_mismatch',
  },
  {
    case_id: 'negative.production-compiler-actual-as-oracle',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/production_compiler_actual_role',
        value: 'expected_oracle',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'production_compiler_actual_oracle_forbidden',
  },
  {
    case_id: 'negative.registry-write-requested',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/requested_registry_write',
        value: true,
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'publisher_side_effect_requested',
  },
  {
    case_id: 'negative.activation-requested',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/requested_activation',
        value: true,
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'publisher_side_effect_requested',
  },
  {
    case_id: 'negative.test-only-production-promotion',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      { operation: 'set', pointer: '/target_registry', value: 'production' },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'test_only_promotion_forbidden',
  },
  {
    case_id: 'negative.test-only-scope-on-production-baseline',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      { operation: 'set', pointer: '/fixture_scope', value: 'test_only' },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'test_only_scope_mismatch',
  },
  {
    case_id: 'negative.feature-manifest-ref-without-hash',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      { operation: 'set', pointer: '/feature_manifest_hash', value: null },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'feature_identity_pair_mismatch',
  },
  {
    case_id: 'negative.compiled-plan-pin-missing',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/compiled_plan_pin',
        value: null,
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'compiled_plan_pin_required',
  },
  {
    case_id: 'negative.execution-artifact-abi',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/1/execution_artifact_pin/runtime_abi_major',
        value: 2,
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'execution_artifact_abi_mismatch',
  },
  {
    case_id: 'negative.execution-artifact-pin-missing',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/1/execution_artifact_pin',
        value: null,
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'execution_artifact_pin_required',
  },
  {
    case_id: 'negative.retention-identity',
    fixture_scope: 'test_only',
    base_case_id: 'positive.production-empty-registry',
    mutations: [
      {
        operation: 'set',
        pointer: '/retention_policy_hash',
        value:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'retention_identity_mismatch',
  },
  {
    case_id: 'negative.resource-hash',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/resource_hash',
        value:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'registry_resource_hash_mismatch',
  },
  {
    case_id: 'negative.resource-duplicate',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'append_resource',
        pointer: '/resources',
        value: clone(testOnlyDefinition),
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'registry_resource_identity_duplicate',
  },
  {
    case_id: 'negative.resource-order',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'reverse_resources',
        pointer: '/resources',
        value: null,
      },
    ],
    rehash_resource_hashes: false,
    rehash_preflight_hash: true,
    expected_code: 'registry_resource_order_invalid',
  },
  {
    case_id: 'negative.dependency-missing',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/dependencies',
        value: [
          {
            resource_type: 'schema',
            ref: { id: 'test-only.fixture.missing', version: '1.0.0' },
            content_hash:
              'sha256:de7d3b4af901f43bfa1e767f30b5b9bb008ab0c079b665068613361afe994a95',
          },
        ],
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'registry_resource_dependency_missing',
  },
  {
    case_id: 'negative.dependency-cycle',
    fixture_scope: 'test_only',
    base_case_id: 'positive.test-only-definition-and-executor',
    mutations: [
      {
        operation: 'set',
        pointer: '/resources/0/dependencies',
        value: [
          {
            resource_type: 'executor_implementation',
            ref: clone(testOnlyExecutor.ref),
            content_hash: testOnlyExecutor.content_hash,
          },
        ],
      },
      {
        operation: 'set',
        pointer: '/resources/1/dependencies',
        value: [
          {
            resource_type: 'definition',
            ref: clone(testOnlyDefinition.ref),
            content_hash: testOnlyDefinition.content_hash,
          },
        ],
      },
    ],
    rehash_resource_hashes: true,
    rehash_preflight_hash: true,
    expected_code: 'registry_resource_dependency_cycle',
  },
];

function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function applyMutation(target: JsonObject, mutation: Mutation): void {
  const tokens = pointerTokens(mutation.pointer);
  let parent: JsonValue = target;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(token)];
    else {
      assertJsonObject(parent);
      parent = parent[token];
    }
  }
  const key = tokens.at(-1)!;
  if (mutation.operation === 'reverse_resources') {
    assertJsonObject(parent);
    const resources = parent[key];
    if (!Array.isArray(resources)) throw new Error('Expected resource array');
    parent[key] = [...resources].reverse();
  } else if (mutation.operation === 'append_resource') {
    assertJsonObject(parent);
    const resources = parent[key];
    if (!Array.isArray(resources)) throw new Error('Expected resource array');
    resources.push(clone(mutation.value));
  } else if (mutation.operation === 'delete') {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else {
      assertJsonObject(parent);
      delete parent[key];
    }
  } else if (Array.isArray(parent)) {
    parent[Number(key)] = clone(mutation.value);
  } else {
    assertJsonObject(parent);
    parent[key] = clone(mutation.value);
  }
}

function mutatedNegativeInput(testCase: NegativeCase): JsonObject {
  const positive = POSITIVE_CASES.find(
    (entry) => entry.case_id === testCase.base_case_id,
  );
  if (!positive)
    throw new Error(`Unknown positive fixture: ${testCase.base_case_id}`);
  const input = clone(positive.input) as unknown as JsonObject;
  for (const mutation of testCase.mutations) applyMutation(input, mutation);
  if (testCase.rehash_resource_hashes) {
    for (const resource of input.resources as JsonObject[]) {
      resource.resource_hash = calculateG3RegistryResourceHash(
        resource as unknown as G3RegistryResourceCandidate,
      );
    }
  }
  if (testCase.rehash_preflight_hash) {
    input.preflight_hash = calculateG3PublishPreflightHash(
      input as unknown as G3RegistryPublishPreflightInput,
    );
  }
  return input;
}

function foundationPayload(): JsonObject {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-registry-publish-foundation/1',
    gate: 'G3',
    slice: 'G3.1',
    slice_status: 'DONE',
    g3_status: 'IN_PROGRESS',
    implemented_surface: 'read_only_registry_publish_preflight_contract',
    upstream_identity: clone(G3_CURRENT_UPSTREAM_IDENTITY),
    feature_manifest_schema: {
      path: 'schemas/feature-manifest-v2-schema.json',
      ref: {
        id: 'icarus.workflow-feature-manifest-v2-schema',
        version: '1.0.0',
      },
      hash: 'sha256:e47344ea2f4bebde3688f76b3450d5143adfd99ab4cc30eb6fc48a9d5a398e2d',
    },
    recipe_schema: {
      path: 'schemas/workflow-recipe-schema.json',
      ref: { id: 'icarus.workflow-recipe-schema', version: '1.0.0' },
      hash: 'sha256:c2768894c7fe6aab492f11d2948a4c92ccefbadc44cb094e103df4a8cdca9bb2',
    },
    retention_policy: {
      path: 'safety/local_single_user_retention@1.json',
      ref: clone(G3_RETENTION_POLICY_REF),
      hash: G3_RETENTION_POLICY_HASH,
    },
    compatibility: {
      run_protocol_major: 1,
      executor_abi_major: 1,
      registry_schema_version: 1,
      core_release_preflight_status: 'not_implemented_in_g3_1',
    },
    production_registry_baseline: {
      published_recipe_count: 0,
      checked_in_published_resource_count: 0,
      active_feature_release_count: 0,
      synthetic_resource_count: 0,
      zero_recipe_allowed: true,
      production_database_observation: 'not_performed',
      registry_write_performed: false,
      activation_performed: false,
    },
    test_only_boundary: {
      fixture_root: G3_REGISTRY_PUBLISH_ROOT,
      required_launchability: 'test_only',
      production_promotion: 'forbidden',
      production_loader_policy: 'fail_closed',
    },
    authoring_publish_stages: {
      scaffold: 'not_implemented',
      validate: 'not_implemented',
      compile: 'not_implemented',
      dry_run: 'not_implemented',
      review: 'not_implemented',
      publish: 'not_implemented',
      activate: 'not_implemented',
    },
    publisher_oracle_policy: {
      expected_source: 'current_g2_sealed_bundle_only',
      production_compiler_actual_role: 'comparison_only',
    },
    preflight_error_codes: [...G3_PUBLISH_PREFLIGHT_ERROR_CODES],
    g4_through_g9_status: {
      G4: 'NOT_READY',
      G5: 'NOT_READY',
      G6: 'NOT_READY',
      G7: 'NOT_READY',
      G8: 'NOT_READY',
      G9: 'NOT_READY',
    },
  };
  return {
    ...withoutHash,
    foundation_hash: domainSeparatedSha256(FOUNDATION_DOMAIN, withoutHash),
  };
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const preflightSchema = artifact(
    'icarus.workflow-registry-publish-preflight-schema/1',
    'icarus.workflow-registry-publish-preflight-schema',
    PREFLIGHT_SCHEMA_DOMAIN,
    G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA,
  );
  const foundationSchema = artifact(
    'icarus.workflow-registry-publish-foundation-schema/1',
    'icarus.workflow-registry-publish-foundation-schema',
    FOUNDATION_SCHEMA_DOMAIN,
    G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA,
  );
  const preflightResultSchema = artifact(
    'icarus.workflow-registry-publish-preflight-result-schema/1',
    'icarus.workflow-registry-publish-preflight-result-schema',
    PREFLIGHT_RESULT_SCHEMA_DOMAIN,
    G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA,
  );
  const foundation = artifact(
    'icarus.workflow-registry-publish-foundation/1',
    'icarus.workflow-registry-publish-foundation',
    FOUNDATION_DOMAIN,
    foundationPayload(),
  );
  const positives = artifact(
    'icarus.workflow-g3-registry-publish-positive-cases/1',
    'icarus.workflow-g3-registry-publish-positive-cases',
    POSITIVE_CASES_DOMAIN,
    { fixture_scope: 'test_only', cases: clone(POSITIVE_CASES) },
  );
  const negatives = artifact(
    'icarus.workflow-g3-registry-publish-negative-cases/1',
    'icarus.workflow-g3-registry-publish-negative-cases',
    NEGATIVE_CASES_DOMAIN,
    { fixture_scope: 'test_only', cases: clone(NEGATIVE_CASES) },
  );
  const prior = [
    [G3_REGISTRY_PUBLISH_PREFLIGHT_SCHEMA_PATH, preflightSchema],
    [G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA_PATH, preflightResultSchema],
    [G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA_PATH, foundationSchema],
    [G3_REGISTRY_PUBLISH_FOUNDATION_PATH, foundation],
    [G3_REGISTRY_PUBLISH_POSITIVE_CASES_PATH, positives],
    [G3_REGISTRY_PUBLISH_NEGATIVE_CASES_PATH, negatives],
  ] as Array<[string, ContractArtifactEnvelope]>;
  const domains = artifact(
    'icarus.workflow-g3-registry-publish-domain-separators/1',
    'icarus.workflow-g3-registry-publish-domain-separators',
    DOMAIN_CATALOG_DOMAIN,
    {
      entries: [
        ...prior.map(([, entry]) => ({
          format: entry.format,
          domain_separator: entry.domain_separator,
        })),
        {
          format:
            'icarus.workflow-contract-pack-g3-registry-publish-foundation/1',
          domain_separator: MANIFEST_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-resource-candidate/1',
          domain_separator: G3_RESOURCE_CANDIDATE_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-dependency-closure/1',
          domain_separator: G3_DEPENDENCY_CLOSURE_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-publish-preflight-input/1',
          domain_separator: G3_PREFLIGHT_DOMAIN,
        },
      ].sort((left, right) =>
        String(left.format).localeCompare(String(right.format)),
      ),
    },
  );
  return [...prior, [G3_REGISTRY_PUBLISH_DOMAIN_CATALOG_PATH, domains]];
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g3-registry-publish-foundation/1',
    'icarus.workflow-contract-pack-g3-registry-publish-foundation',
    MANIFEST_DOMAIN,
    {
      gate: 'G3',
      slice: 'G3.1',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      upstream_g1_root_hash: G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_root_hash,
      upstream_g2_sealed_bundle_hash:
        G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_hash,
      upstream_compiler_toolchain_hash:
        G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_toolchain_hash,
      upstream_compiler_build_hash:
        G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_build_hash,
      production_registry_write_performed: false,
      production_activation_performed: false,
      published_recipe_count: 0,
      positive_case_count: POSITIVE_CASES.length,
      negative_case_count: NEGATIVE_CASES.length,
      artifacts: artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
      g4_through_g9_status: 'NOT_READY',
    },
  );
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function assertExactArtifact(
  relativePath: string,
  expectedHash: Sha256Hash,
): void {
  const observed = readArtifact(relativePath);
  if (observed.hash !== expectedHash) {
    throw new G3RegistryPublishPreflightError(
      `G3 exact dependency drift: ${relativePath}`,
    );
  }
}

function validateCurrentUpstream(): void {
  assertExactArtifact(
    G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_ref,
    G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_artifact_hash,
  );
  const sealed = readArtifact(
    G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_ref,
  );
  if (
    sealed.payload.bundle_hash !==
      G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_hash ||
    canonicalJson(sealed.payload.exact_compiler_identity) !==
      canonicalJson({
        ...G3_CURRENT_UPSTREAM_IDENTITY.compiler,
        canonical_normalizer_version: '2.0.1',
        canonical_normalizer_hash:
          'sha256:e32946d0d20cc92344a72d04e488951cc4a64be82d36384db26dfbf420e469ff',
        proof_algorithm_version: '2.0.2',
        proof_algorithm_hash:
          'sha256:b6fda13a0acddf052cae5ed6f1bc89f2b9cfa91affbfcbb80aa44365f78c35d9',
        error_catalog_ref: {
          id: 'icarus.workflow-compiler-error-catalog',
          version: '2.0.0',
        },
        error_catalog_hash:
          'sha256:8fc7139b29cdddf3c1e13e0f9d8bc6b19a1d32c02c1e7f4b7e33023fcece91ef',
      })
  ) {
    throw new G3RegistryPublishPreflightError(
      'G3 current G2 sealed/compiler identity drift',
    );
  }
  assertExactArtifact(
    'schemas/feature-manifest-v2-schema.json',
    'sha256:e47344ea2f4bebde3688f76b3450d5143adfd99ab4cc30eb6fc48a9d5a398e2d',
  );
  assertExactArtifact(
    'schemas/workflow-recipe-schema.json',
    'sha256:c2768894c7fe6aab492f11d2948a4c92ccefbadc44cb094e103df4a8cdca9bb2',
  );
  assertExactArtifact(
    'safety/local_single_user_retention@1.json',
    G3_RETENTION_POLICY_HASH,
  );
}

function validateFixtureContracts(): void {
  const validateResult = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  }).compile(G3_REGISTRY_PUBLISH_PREFLIGHT_RESULT_SCHEMA as AnySchema);
  for (const testCase of POSITIVE_CASES) {
    const observed = evaluateG3RegistryPublishPreflight(testCase.input);
    if (
      !validateResult(observed) ||
      canonicalJson(observed) !== canonicalJson(testCase.expected_result)
    ) {
      throw new G3RegistryPublishPreflightError(
        `G3 positive fixture drift: ${testCase.case_id}; ${JSON.stringify(validateResult.errors)}`,
      );
    }
  }
  for (const testCase of NEGATIVE_CASES) {
    const observed = evaluateG3RegistryPublishPreflight(
      mutatedNegativeInput(testCase),
    );
    if (
      !validateResult(observed) ||
      observed.outcome !== 'rejected' ||
      observed.code !== testCase.expected_code
    ) {
      throw new G3RegistryPublishPreflightError(
        `G3 negative fixture drift: ${testCase.case_id}; received ${observed.code}; ${JSON.stringify(validateResult.errors)}`,
      );
    }
  }
  const empty = evaluateG3RegistryPublishPreflight(EMPTY_PRODUCTION_PREFLIGHT);
  if (
    empty.outcome !== 'accepted' ||
    empty.target_registry !== 'production' ||
    empty.recipe_count !== 0 ||
    empty.resource_count !== 0
  ) {
    throw new G3RegistryPublishPreflightError(
      'Production Registry zero-Recipe baseline is not accepted',
    );
  }
}

function validateArtifacts(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  validateCurrentUpstream();
  validateFixtureContracts();
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validateFoundation = ajv.compile(
    G3_REGISTRY_PUBLISH_FOUNDATION_SCHEMA as AnySchema,
  );
  const foundation = artifacts.find(
    ([artifactPath]) => artifactPath === G3_REGISTRY_PUBLISH_FOUNDATION_PATH,
  )?.[1];
  if (!foundation || !validateFoundation(foundation.payload)) {
    throw new G3RegistryPublishPreflightError(
      `G3 foundation failed closed schema: ${JSON.stringify(validateFoundation.errors)}`,
    );
  }
  if (
    foundation.payload.foundation_hash !==
    domainSeparatedSha256(
      FOUNDATION_DOMAIN,
      withoutField(foundation.payload, 'foundation_hash'),
    )
  ) {
    throw new G3RegistryPublishPreflightError(
      'G3 foundation internal hash drift',
    );
  }
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (
    manifest.payload.artifacts === undefined ||
    canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest)
  ) {
    throw new G3RegistryPublishPreflightError(
      'G3 Contract Pack manifest is not deterministic',
    );
  }
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function assertExpectedBytes(
  relativePath: string,
  expected: ContractArtifactEnvelope,
): void {
  if (fs.readFileSync(absolute(relativePath), 'utf8') !== render(expected)) {
    throw new G3RegistryPublishPreflightError(
      `G3 artifact bytes drift: ${relativePath}`,
    );
  }
}

export function generateG3RegistryPublishFoundation(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [relativePath, entry] of artifacts) {
    writeAtomic(relativePath, render(entry));
  }
  writeAtomic(G3_REGISTRY_PUBLISH_MANIFEST_PATH, render(manifest));
  return manifest;
}

export function checkG3RegistryPublishFoundation(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [relativePath, entry] of artifacts) {
    assertExpectedBytes(relativePath, entry);
  }
  assertExpectedBytes(G3_REGISTRY_PUBLISH_MANIFEST_PATH, manifest);
  return manifest;
}

export function g3RegistryPublishFixturesForTest(): {
  positive: PositiveCase[];
  negative: Array<NegativeCase & { input: JsonObject }>;
} {
  return {
    positive: clone(POSITIVE_CASES),
    negative: NEGATIVE_CASES.map((testCase) => ({
      ...clone(testCase),
      input: mutatedNegativeInput(testCase),
    })),
  };
}
