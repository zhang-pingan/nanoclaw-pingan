import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, canonicalJson } from './hash.js';
import {
  compareAscii,
  g3RegistryPersistenceFixturesForTest,
  registryResourceKey,
} from './g3-registry-persistence.js';
import {
  G3_REGISTRY_RESOURCE_TYPES,
  type G3RegistryResourceDependency,
  type G3RegistryResourceOwner,
} from './g3-registry-persistence-types.js';
import {
  G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE,
  G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS,
  G3_REGISTRY_PUBLICATION_STATES,
  type G3RegistryExactResourceQueryInput,
  type G3RegistryExactResourceQueryProfile,
  type G3RegistryExactResourceQueryResult,
} from './g3-registry-exact-resource-query-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  VersionedRef,
} from './types.js';
import {
  parseVersionedRef,
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_ROOT =
  'conformance/g3-registry-exact-resource-query';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA_PATH =
  'registry/workflow-registry-exact-resource-query-profile-schema@1.json';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_PATH =
  'registry/workflow-registry-exact-resource-query-profile@1.json';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA_PATH =
  'registry/workflow-registry-exact-resource-query-input-schema@1.json';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA_PATH =
  'registry/workflow-registry-exact-resource-query-result-schema@1.json';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_POSITIVE_CASES_PATH = `${G3_REGISTRY_EXACT_RESOURCE_QUERY_ROOT}/positive-cases.json`;
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_NEGATIVE_CASES_PATH = `${G3_REGISTRY_EXACT_RESOURCE_QUERY_ROOT}/negative-cases.json`;
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_DOMAIN_CATALOG_PATH =
  'registry/workflow-registry-exact-resource-query-domain-separators@1.json';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_MANIFEST_PATH =
  'contract-pack-g3-registry-exact-resource-query.json';

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_DOMAIN =
  'icarus:workflow-registry-exact-resource-query-profile:1\n';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-registry-exact-resource-query-domain-separators:1\n';
export const G3_REGISTRY_EXACT_RESOURCE_QUERY_PACK_DOMAIN =
  'icarus:workflow-contract-pack-g3-registry-exact-resource-query:1\n';

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
const ownerSchema: JsonObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'ref'],
      properties: {
        kind: { const: 'core' },
        ref: { $ref: '#/$defs/versioned_ref' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'feature_id'],
      properties: {
        kind: { const: 'feature' },
        feature_id: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          pattern: VERSIONED_REF_ID_PATTERN,
        },
      },
    },
  ],
};
const dependencySchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['resource_type', 'ref', 'content_hash', 'dependency_kind'],
  properties: {
    resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    ref: { $ref: '#/$defs/versioned_ref' },
    content_hash: hashSchema,
    dependency_kind: { const: 'registry_exact' },
  },
};
const commonDefinitions: JsonObject = {
  versioned_ref: versionedRefSchema,
  owner: ownerSchema,
  dependency: dependencySchema,
};

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-exact-resource-query-profile/1',
  title: 'WorkflowRegistryExactResourceQueryProfileV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'ref',
    'query_identity',
    'resolution_mode',
    'value_validation',
    'schema_validation',
    'owner_validation',
    'publication_validation',
    'dependency_validation',
    'error_precedence',
    'result_schema',
    'read_only',
    'launchability_inference',
  ],
  properties: {
    format: { const: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.profile },
    ref: { $ref: '#/$defs/versioned_ref' },
    query_identity: { const: 'resource_type_ref_content_hash' },
    resolution_mode: { const: 'exact_only' },
    value_validation: { const: 'canonical_inline_value_and_content_hash' },
    schema_validation: { const: 'exact_resource_and_value_binding' },
    owner_validation: { const: 'exact_owner' },
    publication_validation: { const: 'exact_state' },
    dependency_validation: {
      const: 'exact_ordered_rows_and_target_hashes',
    },
    error_precedence: {
      type: 'array',
      minItems: G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE.length,
      maxItems: G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE.length,
      prefixItems: G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE.map(
        (code) => ({ const: code }),
      ),
      items: false,
    },
    result_schema: { const: 'closed' },
    read_only: { const: true },
    launchability_inference: { const: false },
  },
  $defs: { versioned_ref: versionedRefSchema },
};

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-exact-resource-query-input/1',
  title: 'WorkflowRegistryExactResourceQueryInputV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'resource_type',
    'ref',
    'content_hash',
    'schema_ref',
    'schema_hash',
    'owner',
    'publication_state',
    'dependencies',
  ],
  properties: {
    format: { const: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.input },
    resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    ref: { $ref: '#/$defs/versioned_ref' },
    content_hash: hashSchema,
    schema_ref: { $ref: '#/$defs/versioned_ref' },
    schema_hash: hashSchema,
    owner: { $ref: '#/$defs/owner' },
    publication_state: { enum: [...G3_REGISTRY_PUBLICATION_STATES] },
    dependencies: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/dependency' },
    },
  },
  $defs: commonDefinitions,
};

const verifiedResourceSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'resource_type',
    'ref',
    'content_hash',
    'schema_ref',
    'schema_hash',
    'owner',
    'publication_state',
    'dependencies',
    'content',
  ],
  properties: {
    resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    ref: { $ref: '#/$defs/versioned_ref' },
    content_hash: hashSchema,
    schema_ref: { $ref: '#/$defs/versioned_ref' },
    schema_hash: hashSchema,
    owner: { $ref: '#/$defs/owner' },
    publication_state: { enum: [...G3_REGISTRY_PUBLICATION_STATES] },
    dependencies: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/dependency' },
    },
    content: { type: 'object' },
  },
};

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-exact-resource-query-result/1',
  title: 'WorkflowRegistryExactResourceQueryResultV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'outcome',
    'code',
    'resource_type',
    'ref',
    'content_hash',
    'resource',
    'read_only',
  ],
  properties: {
    format: { const: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result },
    outcome: { enum: ['accepted', 'rejected'] },
    code: {
      enum: [
        'exact_resource_query_ok',
        ...G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE,
      ],
    },
    resource_type: {
      anyOf: [{ enum: [...G3_REGISTRY_RESOURCE_TYPES] }, { type: 'null' }],
    },
    ref: { anyOf: [{ $ref: '#/$defs/versioned_ref' }, { type: 'null' }] },
    content_hash: { anyOf: [hashSchema, { type: 'null' }] },
    resource: {
      anyOf: [{ $ref: '#/$defs/verified_resource' }, { type: 'null' }],
    },
    read_only: { const: true },
  },
  allOf: [
    {
      if: { properties: { outcome: { const: 'accepted' } } },
      then: {
        properties: {
          code: { const: 'exact_resource_query_ok' },
          resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
          ref: { $ref: '#/$defs/versioned_ref' },
          content_hash: hashSchema,
          resource: { $ref: '#/$defs/verified_resource' },
        },
      },
      else: {
        properties: {
          code: {
            enum: [...G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE],
          },
          resource: { type: 'null' },
        },
      },
    },
  ],
  $defs: { ...commonDefinitions, verified_resource: verifiedResourceSchema },
};

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateInputSchema = ajv.compile(
  G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA as AnySchema,
);
const validateProfileSchema = ajv.compile(
  G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA as AnySchema,
);
const validateResultSchema = ajv.compile(
  G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA as AnySchema,
);

export class G3RegistryExactResourceQueryContractError extends Error {
  readonly code = 'query_input_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'G3RegistryExactResourceQueryContractError';
  }
}

function dependencyKey(dependency: G3RegistryResourceDependency): string {
  return registryResourceKey(dependency);
}

function validateExactRef(ref: VersionedRef): void {
  try {
    parseVersionedRef(ref);
  } catch (error) {
    throw new G3RegistryExactResourceQueryContractError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function validateRegistryExactResourceQueryInput(
  input: unknown,
): asserts input is G3RegistryExactResourceQueryInput {
  if (!(validateInputSchema(input) as boolean)) {
    throw new G3RegistryExactResourceQueryContractError(
      `Exact Registry resource query schema invalid: ${ajv.errorsText(validateInputSchema.errors)}`,
    );
  }
  const exact = input as G3RegistryExactResourceQueryInput;
  validateExactRef(exact.ref);
  validateExactRef(exact.schema_ref);
  if (exact.owner.kind === 'core') validateExactRef(exact.owner.ref);
  exact.dependencies.forEach((dependency) => validateExactRef(dependency.ref));
  const keys = exact.dependencies.map(dependencyKey);
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify(keys) !==
      JSON.stringify([...keys].sort((left, right) => compareAscii(left, right)))
  ) {
    throw new G3RegistryExactResourceQueryContractError(
      'Exact Registry dependency expectations must be unique and ASCII ordered',
    );
  }
}

export function buildG3RegistryExactResourceQueryProfile(): G3RegistryExactResourceQueryProfile {
  return {
    format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.profile,
    ref: {
      id: 'icarus.workflow-registry-exact-resource-query-profile',
      version: '1.0.0',
    },
    query_identity: 'resource_type_ref_content_hash' as const,
    resolution_mode: 'exact_only' as const,
    value_validation: 'canonical_inline_value_and_content_hash' as const,
    schema_validation: 'exact_resource_and_value_binding' as const,
    owner_validation: 'exact_owner' as const,
    publication_validation: 'exact_state' as const,
    dependency_validation: 'exact_ordered_rows_and_target_hashes' as const,
    error_precedence: [...G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE],
    result_schema: 'closed' as const,
    read_only: true as const,
    launchability_inference: false as const,
  };
}

function ownerForFixture(
  owner: G3RegistryResourceOwner,
): G3RegistryResourceOwner {
  return structuredClone(owner);
}

export function g3RegistryExactResourceQueryFixturesForTest(): {
  positive: Array<{
    case_id: string;
    input: G3RegistryExactResourceQueryInput;
    expected_result: G3RegistryExactResourceQueryResult;
  }>;
  negative: Array<{
    case_id: string;
    input: JsonObject;
    expected_code: 'query_input_invalid';
  }>;
} {
  const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
  const stored = batch.resources.find(
    (resource) => resource.resource_type === batch.closure.root_resource_type,
  );
  if (!stored) throw new Error('G3 exact query fixture root resource missing');
  const input: G3RegistryExactResourceQueryInput = {
    format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.input,
    resource_type: stored.resource_type,
    ref: structuredClone(stored.ref),
    content_hash: stored.content_hash,
    schema_ref: structuredClone(stored.schema_ref),
    schema_hash: stored.schema_hash,
    owner: ownerForFixture(stored.owner),
    publication_state: 'staged',
    dependencies: structuredClone(stored.dependencies),
  };
  const expected: G3RegistryExactResourceQueryResult = {
    format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result,
    outcome: 'accepted',
    code: 'exact_resource_query_ok',
    resource_type: input.resource_type,
    ref: input.ref,
    content_hash: input.content_hash,
    resource: {
      resource_type: input.resource_type,
      ref: input.ref,
      content_hash: input.content_hash,
      schema_ref: input.schema_ref,
      schema_hash: input.schema_hash,
      owner: input.owner,
      publication_state: input.publication_state,
      dependencies: input.dependencies,
      content: structuredClone(stored.content),
    },
    read_only: true,
  };
  const latest = structuredClone(input) as unknown as JsonObject;
  (latest.ref as JsonObject).version = 'latest';
  const range = structuredClone(input) as unknown as JsonObject;
  (range.ref as JsonObject).version = '^1.0.0';
  const alias = structuredClone(input) as unknown as JsonObject;
  alias.alias = 'fixture.recipe';
  const fallback = structuredClone(input) as unknown as JsonObject;
  fallback.fallback = 'latest';
  const unordered = structuredClone(input) as unknown as JsonObject;
  const duplicate = structuredClone(input.dependencies[0]) as JsonObject;
  unordered.dependencies = [duplicate, structuredClone(duplicate)] as JsonValue;
  return {
    positive: [
      {
        case_id: 'positive.exact-staged-feature-resource',
        input,
        expected_result: expected,
      },
    ],
    negative: [
      {
        case_id: 'negative.latest',
        input: latest,
        expected_code: 'query_input_invalid',
      },
      {
        case_id: 'negative.range',
        input: range,
        expected_code: 'query_input_invalid',
      },
      {
        case_id: 'negative.alias',
        input: alias,
        expected_code: 'query_input_invalid',
      },
      {
        case_id: 'negative.fallback',
        input: fallback,
        expected_code: 'query_input_invalid',
      },
      {
        case_id: 'negative.dependency-duplicate',
        input: unordered,
        expected_code: 'query_input_invalid',
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
  const upstream = readArtifact('contract-pack-g3-registry-persistence.json');
  if (
    upstream.hash !==
    'sha256:f14adf777d92cbaf00275e5ad77b04746c1c9a42848d29cad0786d33a54cf52c'
  ) {
    throw new Error('G3.3 Registry persistence identity drift');
  }
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const profile = buildG3RegistryExactResourceQueryProfile();
  const fixtures = g3RegistryExactResourceQueryFixturesForTest();
  const entries: Array<[string, ContractArtifactEnvelope]> = [
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA_PATH,
      artifact(
        'icarus.workflow-registry-exact-resource-query-profile-schema/1',
        'icarus.workflow-registry-exact-resource-query-profile-schema',
        'icarus:workflow-registry-exact-resource-query-profile-schema:1\n',
        G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA,
      ),
    ],
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_PATH,
      artifact(
        G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.profile,
        'icarus.workflow-registry-exact-resource-query-profile',
        G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_DOMAIN,
        profile,
      ),
    ],
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-registry-exact-resource-query-input-schema/1',
        'icarus.workflow-registry-exact-resource-query-input-schema',
        'icarus:workflow-registry-exact-resource-query-input-schema:1\n',
        G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA,
      ),
    ],
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-registry-exact-resource-query-result-schema/1',
        'icarus.workflow-registry-exact-resource-query-result-schema',
        'icarus:workflow-registry-exact-resource-query-result-schema:1\n',
        G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA,
      ),
    ],
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_POSITIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-registry-exact-resource-query-positive-cases/1',
        'icarus.workflow-g3-registry-exact-resource-query-positive-cases',
        'icarus:workflow-g3-registry-exact-resource-query-positive-cases:1\n',
        { fixture_scope: 'test_only', cases: fixtures.positive },
      ),
    ],
    [
      G3_REGISTRY_EXACT_RESOURCE_QUERY_NEGATIVE_CASES_PATH,
      artifact(
        'icarus.workflow-g3-registry-exact-resource-query-negative-cases/1',
        'icarus.workflow-g3-registry-exact-resource-query-negative-cases',
        'icarus:workflow-g3-registry-exact-resource-query-negative-cases:1\n',
        { fixture_scope: 'test_only', cases: fixtures.negative },
      ),
    ],
  ];
  const domains = artifact(
    'icarus.workflow-registry-exact-resource-query-domain-separators/1',
    'icarus.workflow-registry-exact-resource-query-domain-separators',
    G3_REGISTRY_EXACT_RESOURCE_QUERY_DOMAIN_CATALOG_DOMAIN,
    {
      entries: entries
        .map(([, entry]) => ({
          format: entry.format,
          domain_separator: entry.domain_separator,
        }))
        .concat([
          {
            format:
              'icarus.workflow-registry-exact-resource-query-domain-separators/1',
            domain_separator:
              G3_REGISTRY_EXACT_RESOURCE_QUERY_DOMAIN_CATALOG_DOMAIN,
          },
          {
            format:
              'icarus.workflow-contract-pack-g3-registry-exact-resource-query/1',
            domain_separator: G3_REGISTRY_EXACT_RESOURCE_QUERY_PACK_DOMAIN,
          },
        ])
        .sort((left, right) => compareAscii(left.format, right.format)),
    },
  );
  return [
    ...entries,
    [G3_REGISTRY_EXACT_RESOURCE_QUERY_DOMAIN_CATALOG_PATH, domains],
  ];
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const fixtures = g3RegistryExactResourceQueryFixturesForTest();
  return artifact(
    'icarus.workflow-contract-pack-g3-registry-exact-resource-query/1',
    'icarus.workflow-contract-pack-g3-registry-exact-resource-query',
    G3_REGISTRY_EXACT_RESOURCE_QUERY_PACK_DOMAIN,
    {
      gate: 'G3',
      slice: 'G3.5',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      upstream_g3_3_pack_hash:
        'sha256:f14adf777d92cbaf00275e5ad77b04746c1c9a42848d29cad0786d33a54cf52c',
      upstream_g1_schema_root_hash:
        'sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9',
      query_mode: 'exact_resource_type_ref_content_hash_only',
      result_schema: 'closed',
      read_only: true,
      latest_range_alias_fallback_allowed: false,
      launchability_inference_performed: false,
      registry_write_performed: false,
      publisher_implemented: false,
      publish_implemented: false,
      production_loader_implemented: false,
      activation_implemented: false,
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
  const profile = buildG3RegistryExactResourceQueryProfile();
  if (!(validateProfileSchema(profile) as boolean))
    throw new Error(
      `G3.5 profile invalid: ${ajv.errorsText(validateProfileSchema.errors)}`,
    );
  const fixtures = g3RegistryExactResourceQueryFixturesForTest();
  for (const fixture of fixtures.positive) {
    validateRegistryExactResourceQueryInput(fixture.input);
    if (!(validateResultSchema(fixture.expected_result) as boolean))
      throw new Error(
        `G3.5 positive result invalid: ${fixture.case_id}: ${ajv.errorsText(validateResultSchema.errors)}`,
      );
  }
  for (const fixture of fixtures.negative) {
    try {
      validateRegistryExactResourceQueryInput(fixture.input);
      throw new Error(`G3.5 negative fixture accepted: ${fixture.case_id}`);
    } catch (error) {
      if (!(error instanceof G3RegistryExactResourceQueryContractError))
        throw error;
    }
  }
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest))
    throw new Error('G3.5 exact resource query manifest is not deterministic');
}

export function generateG3RegistryExactResourceQuery(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) writeAtomic(file, render(entry));
  writeAtomic(G3_REGISTRY_EXACT_RESOURCE_QUERY_MANIFEST_PATH, render(manifest));
  return manifest;
}

export function checkG3RegistryExactResourceQuery(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(
        `G3.5 exact resource query artifact bytes drift: ${file}`,
      );
  }
  if (
    fs.readFileSync(
      absolute(G3_REGISTRY_EXACT_RESOURCE_QUERY_MANIFEST_PATH),
      'utf8',
    ) !== render(manifest)
  ) {
    throw new Error('G3.5 exact resource query manifest bytes drift');
  }
  return manifest;
}

export function g3RegistryExactResourceQuerySchemasForTest(): {
  profile: JsonObject;
  input: JsonObject;
  result: JsonObject;
} {
  return {
    profile: structuredClone(G3_REGISTRY_EXACT_RESOURCE_QUERY_PROFILE_SCHEMA),
    input: structuredClone(G3_REGISTRY_EXACT_RESOURCE_QUERY_INPUT_SCHEMA),
    result: structuredClone(G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA),
  };
}
