import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import {
  G3_REGISTRY_PERSISTENCE_FORMATS,
  G3_REGISTRY_DEPENDENCY_KIND,
  G3_REGISTRY_RESOURCE_TYPES,
  type G3RegistryDependencyClosureManifest,
  type G3RegistryPersistenceBatch,
  type G3RegistryResourceDependency,
  type G3RegistryResourceIdentity,
  type G3RegistryResourceRecord,
  type G3RegistrySnapshot,
  type G3RegistrySnapshotPreflightInput,
  type G3RegistrySnapshotPreflightResult,
} from './g3-registry-persistence-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from './types.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

export const G3_REGISTRY_PERSISTENCE_ROOT =
  'conformance/g3-registry-persistence';
export const G3_REGISTRY_RESOURCE_SCHEMA_PATH =
  'registry/workflow-registry-resource-schema@1.json';
export const G3_REGISTRY_CLOSURE_SCHEMA_PATH =
  'registry/workflow-registry-dependency-closure-manifest-schema@1.json';
export const G3_REGISTRY_SNAPSHOT_SCHEMA_PATH =
  'registry/workflow-registry-snapshot-schema@1.json';
export const G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA_PATH =
  'registry/workflow-registry-snapshot-preflight-input-schema@1.json';
export const G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA_PATH =
  'registry/workflow-registry-snapshot-preflight-result-schema@1.json';
export const G3_REGISTRY_PERSISTENCE_POSITIVE_CASES_PATH = `${G3_REGISTRY_PERSISTENCE_ROOT}/positive-cases.json`;
export const G3_REGISTRY_PERSISTENCE_NEGATIVE_CASES_PATH = `${G3_REGISTRY_PERSISTENCE_ROOT}/negative-cases.json`;
export const G3_REGISTRY_PERSISTENCE_DOMAIN_CATALOG_PATH =
  'registry/workflow-registry-persistence-domain-separators@1.json';
export const G3_REGISTRY_PERSISTENCE_MANIFEST_PATH =
  'contract-pack-g3-registry-persistence.json';

export const G3_REGISTRY_RESOURCE_CONTENT_DOMAIN =
  'icarus:workflow-registry-resource-content:1\n';
export const G3_REGISTRY_CLOSURE_DOMAIN =
  'icarus:workflow-registry-dependency-closure:1\n';
export const G3_REGISTRY_CLOSURE_MANIFEST_DOMAIN =
  'icarus:workflow-registry-closure-manifest:1\n';
export const G3_REGISTRY_SNAPSHOT_DOMAIN =
  'icarus:workflow-registry-snapshot:1\n';
export const G3_REGISTRY_PREFLIGHT_DOMAIN =
  'icarus:workflow-registry-snapshot-preflight:1\n';

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
    },
  },
};
const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };

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

export const G3_REGISTRY_RESOURCE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-resource/1',
  title: 'WorkflowRegistryResourceV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'resource_type',
    'ref',
    'owner',
    'schema_ref',
    'schema_hash',
    'content',
    'content_hash',
    'dependencies',
  ],
  properties: {
    format: { const: G3_REGISTRY_PERSISTENCE_FORMATS.resource },
    resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    ref: { $ref: '#/$defs/versioned_ref' },
    owner: {
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
              pattern: REF_ID_PATTERN,
            },
          },
        },
      ],
    },
    schema_ref: { $ref: '#/$defs/versioned_ref' },
    schema_hash: hashSchema,
    content: { type: 'object' },
    content_hash: hashSchema,
    dependencies: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/dependency' },
    },
  },
  $defs: {
    versioned_ref: versionedRefSchema,
    dependency: {
      type: 'object',
      additionalProperties: false,
      required: ['resource_type', 'ref', 'content_hash', 'dependency_kind'],
      properties: {
        resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
        ref: { $ref: '#/$defs/versioned_ref' },
        content_hash: hashSchema,
        dependency_kind: { const: G3_REGISTRY_DEPENDENCY_KIND },
      },
    },
  },
};

export const G3_REGISTRY_CLOSURE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-dependency-closure-manifest/1',
  title: 'WorkflowRegistryDependencyClosureManifestV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'ref',
    'schema_ref',
    'schema_hash',
    'root_resource_type',
    'root_ref',
    'members',
    'member_count',
    'closure_hash',
    'manifest_hash',
  ],
  properties: {
    format: { const: G3_REGISTRY_PERSISTENCE_FORMATS.closure },
    ref: { $ref: '#/$defs/versioned_ref' },
    schema_ref: { $ref: '#/$defs/versioned_ref' },
    schema_hash: hashSchema,
    root_resource_type: { enum: [...G3_REGISTRY_RESOURCE_TYPES] },
    root_ref: { $ref: '#/$defs/versioned_ref' },
    members: {
      type: 'array',
      maxItems: 4096,
      items: { $ref: '#/$defs/identity' },
    },
    member_count: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    closure_hash: hashSchema,
    manifest_hash: hashSchema,
  },
  $defs: { versioned_ref: versionedRefSchema, identity: identitySchema },
};

export const G3_REGISTRY_SNAPSHOT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-snapshot/1',
  title: 'WorkflowRegistrySnapshotV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'ref',
    'closure_ref',
    'closure_hash',
    'compiler_version',
    'core_build_hash',
    'database_schema_hash',
    'snapshot_hash',
  ],
  properties: {
    format: { const: G3_REGISTRY_PERSISTENCE_FORMATS.snapshot },
    ref: { $ref: '#/$defs/versioned_ref' },
    closure_ref: { $ref: '#/$defs/versioned_ref' },
    closure_hash: hashSchema,
    compiler_version: { type: 'string', minLength: 1, maxLength: 255 },
    core_build_hash: hashSchema,
    database_schema_hash: hashSchema,
    snapshot_hash: hashSchema,
  },
  $defs: { versioned_ref: versionedRefSchema },
};

export const G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-snapshot-preflight-input/1',
  title: 'WorkflowRegistrySnapshotPreflightInputV1',
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
    expected_compiler_version: { type: 'string', minLength: 1, maxLength: 255 },
    expected_core_build_hash: hashSchema,
    expected_database_schema_hash: hashSchema,
  },
  $defs: { versioned_ref: versionedRefSchema },
};

export const G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-registry-snapshot-preflight-result/1',
  title: 'WorkflowRegistrySnapshotPreflightResultV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'outcome',
    'code',
    'snapshot_ref',
    'snapshot_hash',
    'closure_hash',
    'member_count',
    'read_only',
  ],
  properties: {
    format: { const: G3_REGISTRY_PERSISTENCE_FORMATS.preflightResult },
    outcome: { enum: ['accepted', 'rejected'] },
    code: {
      enum: [
        'preflight_ok',
        'snapshot_missing',
        'snapshot_identity_mismatch',
        'snapshot_hash_mismatch',
        'snapshot_binding_mismatch',
        'closure_missing',
        'closure_identity_mismatch',
        'closure_hash_mismatch',
        'closure_manifest_hash_mismatch',
        'closure_member_mismatch',
        'resource_missing',
        'resource_identity_mismatch',
        'resource_hash_mismatch',
        'dependency_missing',
        'dependency_hash_mismatch',
        'dependency_cycle',
        'snapshot_schema_invalid',
      ],
    },
    snapshot_ref: {
      anyOf: [{ $ref: '#/$defs/versioned_ref' }, { type: 'null' }],
    },
    snapshot_hash: { anyOf: [hashSchema, { type: 'null' }] },
    closure_hash: { anyOf: [hashSchema, { type: 'null' }] },
    member_count: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    read_only: { const: true },
  },
  allOf: [
    {
      if: { properties: { outcome: { const: 'accepted' } } },
      then: { properties: { code: { const: 'preflight_ok' } } },
      else: { properties: { code: { not: { const: 'preflight_ok' } } } },
    },
  ],
  $defs: { versioned_ref: versionedRefSchema },
};

const validators = new Ajv2020({ strict: true, allErrors: true });
const validateResourceSchema = validators.compile(
  G3_REGISTRY_RESOURCE_SCHEMA as AnySchema,
);
const validateClosureSchema = validators.compile(
  G3_REGISTRY_CLOSURE_SCHEMA as AnySchema,
);
const validateSnapshotSchema = validators.compile(
  G3_REGISTRY_SNAPSHOT_SCHEMA as AnySchema,
);

export class G3RegistryPersistenceContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'G3RegistryPersistenceContractError';
  }
}

function assertSchema(ok: boolean, label: string, errors: unknown): void {
  if (!ok)
    throw new G3RegistryPersistenceContractError(
      'schema_invalid',
      `${label}: ${JSON.stringify(errors)}`,
    );
}

function assertAscii(value: string, label: string): void {
  if ([...value].some((character) => character.codePointAt(0)! > 0x7f)) {
    throw new G3RegistryPersistenceContractError(
      'non_ascii_identity',
      `${label} must be ASCII`,
    );
  }
}

export function compareAscii(left: string, right: string): number {
  assertAscii(left, 'left identity');
  assertAscii(right, 'right identity');
  return Buffer.from(left, 'ascii').compare(Buffer.from(right, 'ascii'));
}

export function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

export function registryResourceKey(
  resource: Pick<G3RegistryResourceRecord, 'resource_type' | 'ref'>,
): string {
  return `${resource.resource_type}\0${refKey(resource.ref)}`;
}

export function registryResourceId(
  identity: Pick<G3RegistryResourceIdentity, 'resource_type' | 'ref'>,
): string {
  return `registry-resource:${identity.resource_type}:${refKey(identity.ref)}`;
}

export function registryValueId(
  identity: Pick<G3RegistryResourceIdentity, 'resource_type' | 'ref'>,
): string {
  return `registry-value:${identity.resource_type}:${refKey(identity.ref)}`;
}

export function registryClosureId(ref: VersionedRef): string {
  return `registry-closure:${refKey(ref)}`;
}

export function registryClosureValueId(ref: VersionedRef): string {
  return `registry-closure-value:${refKey(ref)}`;
}

export function registrySnapshotId(ref: VersionedRef): string {
  return `registry-snapshot:${refKey(ref)}`;
}

export function calculateRegistryResourceContentHash(
  resource: Pick<
    G3RegistryResourceRecord,
    'format' | 'resource_type' | 'ref' | 'content'
  >,
): Sha256Hash {
  return domainSeparatedSha256(G3_REGISTRY_RESOURCE_CONTENT_DOMAIN, {
    format: resource.format,
    resource_type: resource.resource_type,
    ref: resource.ref,
    content: resource.content,
  });
}

function identity(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceIdentity {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
  };
}

function identityKey(resource: G3RegistryResourceIdentity): string {
  return registryResourceKey(resource);
}

function dependencyKey(dependency: G3RegistryResourceDependency): string {
  return `${dependency.resource_type}\0${refKey(dependency.ref)}`;
}

function closurePayload(
  closure: Pick<
    G3RegistryDependencyClosureManifest,
    'root_resource_type' | 'root_ref' | 'members' | 'member_count'
  >,
): JsonObject {
  return {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: closure.root_resource_type,
    root_ref: closure.root_ref,
    members: closure.members,
    member_count: closure.member_count,
  };
}

export function calculateDependencyClosureHash(
  closure: Pick<
    G3RegistryDependencyClosureManifest,
    'root_resource_type' | 'root_ref' | 'members' | 'member_count'
  >,
): Sha256Hash {
  return domainSeparatedSha256(
    G3_REGISTRY_CLOSURE_DOMAIN,
    closurePayload(closure),
  );
}

export function calculateClosureManifestHash(
  closure: Pick<
    G3RegistryDependencyClosureManifest,
    | 'format'
    | 'ref'
    | 'schema_ref'
    | 'schema_hash'
    | 'root_resource_type'
    | 'root_ref'
    | 'members'
    | 'member_count'
    | 'closure_hash'
  >,
): Sha256Hash {
  return domainSeparatedSha256(G3_REGISTRY_CLOSURE_MANIFEST_DOMAIN, {
    format: closure.format,
    ref: closure.ref,
    schema_ref: closure.schema_ref,
    schema_hash: closure.schema_hash,
    root_resource_type: closure.root_resource_type,
    root_ref: closure.root_ref,
    members: closure.members,
    member_count: closure.member_count,
    closure_hash: closure.closure_hash,
  });
}

export function calculateRegistrySnapshotHash(
  snapshot: Omit<G3RegistrySnapshot, 'snapshot_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(G3_REGISTRY_SNAPSHOT_DOMAIN, snapshot);
}

function sortIdentities(
  values: G3RegistryResourceIdentity[],
): G3RegistryResourceIdentity[] {
  return [...values].sort((left, right) =>
    compareAscii(identityKey(left), identityKey(right)),
  );
}

function detectCycle(resources: G3RegistryResourceRecord[]): boolean {
  const byKey = new Map(
    resources.map((resource) => [registryResourceKey(resource), resource]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (resource: G3RegistryResourceRecord): boolean => {
    const key = registryResourceKey(resource);
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of resource.dependencies) {
      const target = byKey.get(dependencyKey(dependency));
      if (target && visit(target)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return resources.some(visit);
}

export function buildDependencyClosure(
  resources: G3RegistryResourceRecord[],
  root: Pick<G3RegistryResourceIdentity, 'resource_type' | 'ref'>,
  ref: VersionedRef,
  schema: { id: string; version: string; hash: Sha256Hash },
): G3RegistryDependencyClosureManifest {
  const byKey = new Map(
    resources.map((resource) => [registryResourceKey(resource), resource]),
  );
  const rootResource = byKey.get(`${root.resource_type}\0${refKey(root.ref)}`);
  if (!rootResource) {
    throw new G3RegistryPersistenceContractError(
      'resource_missing',
      `Closure root is not present: ${root.resource_type}\0${refKey(root.ref)}`,
    );
  }
  const members = new Map<string, G3RegistryResourceIdentity>();
  const visiting = new Set<string>();
  const visit = (resource: G3RegistryResourceRecord): void => {
    const key = registryResourceKey(resource);
    if (visiting.has(key))
      throw new G3RegistryPersistenceContractError(
        'dependency_cycle',
        `Dependency cycle at ${key}`,
      );
    visiting.add(key);
    for (const dependency of resource.dependencies) {
      const target = byKey.get(dependencyKey(dependency));
      if (!target)
        throw new G3RegistryPersistenceContractError(
          'dependency_missing',
          `Missing dependency: ${dependencyKey(dependency)}`,
        );
      if (target.content_hash !== dependency.content_hash) {
        throw new G3RegistryPersistenceContractError(
          'dependency_hash_mismatch',
          `Dependency hash mismatch: ${dependencyKey(dependency)}`,
        );
      }
      const targetKey = registryResourceKey(target);
      if (!members.has(targetKey)) {
        members.set(targetKey, identity(target));
        visit(target);
      }
    }
    visiting.delete(key);
  };
  visit(rootResource);
  const sorted = sortIdentities([...members.values()]);
  const withoutHashes = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.closure,
    ref,
    schema_ref: { id: schema.id, version: schema.version },
    schema_hash: schema.hash,
    root_resource_type: rootResource.resource_type,
    root_ref: rootResource.ref,
    members: sorted,
    member_count: sorted.length,
  };
  const closureHash = calculateDependencyClosureHash(withoutHashes);
  const manifestWithoutHash = { ...withoutHashes, closure_hash: closureHash };
  return {
    ...manifestWithoutHash,
    manifest_hash: calculateClosureManifestHash(manifestWithoutHash),
  };
}

export function validateRegistryPersistenceBatch(
  batch: G3RegistryPersistenceBatch,
): void {
  assertSchema(
    validateResourceSchema(batch.resources[0] ?? {}) as boolean,
    'resource',
    validateResourceSchema.errors,
  );
  for (const resource of batch.resources) {
    assertSchema(
      validateResourceSchema(resource) as boolean,
      'resource',
      validateResourceSchema.errors,
    );
    if (
      calculateRegistryResourceContentHash(resource) !== resource.content_hash
    ) {
      throw new G3RegistryPersistenceContractError(
        'resource_hash_mismatch',
        registryResourceKey(resource),
      );
    }
    if (
      resource.schema_ref.id === resource.ref.id &&
      resource.schema_ref.version === resource.ref.version &&
      resource.resource_type !== 'schema'
    ) {
      throw new G3RegistryPersistenceContractError(
        'schema_identity_mismatch',
        `${registryResourceKey(resource)} cannot use itself as schema`,
      );
    }
  }
  assertSchema(
    validateClosureSchema(batch.closure) as boolean,
    'closure',
    validateClosureSchema.errors,
  );
  assertSchema(
    validateSnapshotSchema(batch.snapshot) as boolean,
    'snapshot',
    validateSnapshotSchema.errors,
  );
  const keys = batch.resources.map(registryResourceKey);
  if (new Set(keys).size !== keys.length)
    throw new G3RegistryPersistenceContractError(
      'resource_identity_duplicate',
      'Duplicate resource identity',
    );
  if (
    JSON.stringify(keys) !==
    JSON.stringify([...keys].sort((left, right) => compareAscii(left, right)))
  ) {
    throw new G3RegistryPersistenceContractError(
      'resource_order_invalid',
      'Resources must be in unsigned ASCII tuple order',
    );
  }
  const byKey = new Map(
    batch.resources.map((resource) => [
      registryResourceKey(resource),
      resource,
    ]),
  );
  const closureSchema = byKey.get(
    `schema\0${refKey(batch.closure.schema_ref)}`,
  );
  if (
    !closureSchema ||
    closureSchema.content_hash !== batch.closure.schema_hash
  ) {
    throw new G3RegistryPersistenceContractError(
      'schema_missing',
      'Closure manifest schema binding is missing',
    );
  }
  for (const resource of batch.resources) {
    const schema = byKey.get(`${'schema'}\0${refKey(resource.schema_ref)}`);
    if (!schema || schema.content_hash !== resource.schema_hash) {
      throw new G3RegistryPersistenceContractError(
        'schema_missing',
        `Schema binding missing for ${registryResourceKey(resource)}`,
      );
    }
    const dependencyKeys = resource.dependencies.map(dependencyKey);
    if (
      new Set(dependencyKeys).size !== dependencyKeys.length ||
      JSON.stringify(dependencyKeys) !==
        JSON.stringify(
          [...dependencyKeys].sort((left, right) => compareAscii(left, right)),
        )
    ) {
      throw new G3RegistryPersistenceContractError(
        'dependency_order_invalid',
        `Dependencies are not deterministic for ${registryResourceKey(resource)}`,
      );
    }
    for (const dependency of resource.dependencies) {
      const target = byKey.get(dependencyKey(dependency));
      if (!target)
        throw new G3RegistryPersistenceContractError(
          'dependency_missing',
          dependencyKey(dependency),
        );
      if (target.content_hash !== dependency.content_hash)
        throw new G3RegistryPersistenceContractError(
          'dependency_hash_mismatch',
          dependencyKey(dependency),
        );
    }
  }
  if (detectCycle(batch.resources))
    throw new G3RegistryPersistenceContractError(
      'dependency_cycle',
      'Registry resource dependency cycle',
    );
  const expectedClosure = buildDependencyClosure(
    batch.resources,
    {
      resource_type: batch.closure.root_resource_type,
      ref: batch.closure.root_ref,
    },
    batch.closure.ref,
    {
      ...batch.closure.schema_ref,
      hash: batch.closure.schema_hash,
    },
  );
  if (
    canonicalJson(batch.closure.members) !==
      canonicalJson(expectedClosure.members) ||
    batch.closure.member_count !== expectedClosure.member_count
  ) {
    throw new G3RegistryPersistenceContractError(
      'closure_member_mismatch',
      'Closure members are not the exact transitive set',
    );
  }
  if (batch.closure.closure_hash !== expectedClosure.closure_hash)
    throw new G3RegistryPersistenceContractError(
      'closure_hash_mismatch',
      'Closure hash mismatch',
    );
  if (batch.closure.manifest_hash !== expectedClosure.manifest_hash)
    throw new G3RegistryPersistenceContractError(
      'closure_manifest_hash_mismatch',
      'Closure manifest hash mismatch',
    );
  if (
    batch.snapshot.closure_ref.id !== batch.closure.ref.id ||
    batch.snapshot.closure_ref.version !== batch.closure.ref.version ||
    batch.snapshot.closure_hash !== batch.closure.closure_hash
  ) {
    throw new G3RegistryPersistenceContractError(
      'snapshot_closure_mismatch',
      'Snapshot closure ref/hash mismatch',
    );
  }
  const { snapshot_hash: ignored, ...snapshotWithoutHash } = batch.snapshot;
  if (
    calculateRegistrySnapshotHash(snapshotWithoutHash) !==
    batch.snapshot.snapshot_hash
  )
    throw new G3RegistryPersistenceContractError(
      'snapshot_hash_mismatch',
      'Snapshot hash mismatch',
    );
  if (!Number.isSafeInteger(batch.created_at_ms) || batch.created_at_ms < 0)
    throw new G3RegistryPersistenceContractError(
      'created_at_invalid',
      'created_at_ms must be a non-negative safe integer',
    );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const FIXTURE_SCHEMA_REF: VersionedRef = {
  id: 'fixture.registry.schema',
  version: '1.0.0',
};
const FIXTURE_CLOSURE_REF: VersionedRef = {
  id: 'fixture.registry.closure',
  version: '1.0.0',
};
const FIXTURE_SNAPSHOT_REF: VersionedRef = {
  id: 'fixture.registry.snapshot',
  version: '1.0.0',
};

function fixtureResource(
  resourceType: G3RegistryResourceRecord['resource_type'],
  ref: VersionedRef,
  content: JsonObject,
  schemaRef: VersionedRef,
  schemaHash: Sha256Hash,
  dependencies: G3RegistryResourceDependency[] = [],
): G3RegistryResourceRecord {
  const base = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.resource,
    resource_type: resourceType,
    ref,
    owner: { kind: 'feature' as const, feature_id: 'fixture.feature' },
    schema_ref: schemaRef,
    schema_hash: schemaHash,
    content,
    dependencies,
  };
  return { ...base, content_hash: calculateRegistryResourceContentHash(base) };
}

export function g3RegistryPersistenceFixturesForTest(): {
  positive: Array<{
    case_id: string;
    batch: G3RegistryPersistenceBatch;
    preflight_input: G3RegistrySnapshotPreflightInput;
    expected_preflight_result: G3RegistrySnapshotPreflightResult;
  }>;
  negative: Array<{
    case_id: string;
    batch: G3RegistryPersistenceBatch;
    expected_code: string;
  }>;
} {
  const schemaContent: JsonObject = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  };
  const schemaBase = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.resource,
    resource_type: 'schema' as const,
    ref: FIXTURE_SCHEMA_REF,
    owner: { kind: 'feature' as const, feature_id: 'fixture.feature' },
    schema_ref: FIXTURE_SCHEMA_REF,
    schema_hash: '' as Sha256Hash,
    content: schemaContent,
    dependencies: [] as G3RegistryResourceDependency[],
  };
  const schema = {
    ...schemaBase,
    content_hash: calculateRegistryResourceContentHash(schemaBase),
  } as G3RegistryResourceRecord;
  schema.schema_hash = schema.content_hash;
  const app = fixtureResource(
    'recipe',
    { id: 'fixture.recipe', version: '1.0.0' },
    { name: 'fixture' },
    FIXTURE_SCHEMA_REF,
    schema.content_hash,
    [
      {
        resource_type: 'schema',
        ref: FIXTURE_SCHEMA_REF,
        content_hash: schema.content_hash,
        dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
      },
    ],
  );
  const resources = [schema, app].sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: app.resource_type, ref: app.ref },
    FIXTURE_CLOSURE_REF,
    {
      ...FIXTURE_SCHEMA_REF,
      hash: schema.content_hash,
    },
  );
  const snapshotWithoutHash = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.snapshot,
    ref: FIXTURE_SNAPSHOT_REF,
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: '3.0.4',
    core_build_hash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Hash,
    database_schema_hash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Sha256Hash,
  };
  const snapshot: G3RegistrySnapshot = {
    ...snapshotWithoutHash,
    snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
  };
  const batch: G3RegistryPersistenceBatch = {
    resources,
    closure,
    snapshot,
    created_at_ms: 1784604172000,
  };
  const preflightInput: G3RegistrySnapshotPreflightInput = {
    snapshot_ref: snapshot.ref,
    snapshot_hash: snapshot.snapshot_hash,
    expected_compiler_version: snapshot.compiler_version,
    expected_core_build_hash: snapshot.core_build_hash,
    expected_database_schema_hash: snapshot.database_schema_hash,
  };
  const expectedPreflightResult: G3RegistrySnapshotPreflightResult = {
    format: G3_REGISTRY_PERSISTENCE_FORMATS.preflightResult,
    outcome: 'accepted',
    code: 'preflight_ok',
    snapshot_ref: snapshot.ref,
    snapshot_hash: snapshot.snapshot_hash,
    closure_hash: closure.closure_hash,
    member_count: closure.member_count,
    read_only: true,
  };
  const negative = [
    {
      case_id: 'negative.resource-hash',
      expected_code: 'resource_hash_mismatch',
      batch: clone(batch),
    },
    {
      case_id: 'negative.closure-member-extra',
      expected_code: 'closure_member_mismatch',
      batch: clone(batch),
    },
    {
      case_id: 'negative.dependency-hash',
      expected_code: 'dependency_hash_mismatch',
      batch: clone(batch),
    },
    {
      case_id: 'negative.snapshot-hash',
      expected_code: 'snapshot_hash_mismatch',
      batch: clone(batch),
    },
  ];
  negative[0].batch.resources.find(
    (resource) => resource.resource_type === 'recipe',
  )!.content_hash =
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  negative[1].batch.closure.members.push({
    resource_type: 'capability',
    ref: { id: 'fixture.extra', version: '1.0.0' },
    content_hash: schema.content_hash,
  });
  negative[1].batch.closure.member_count += 1;
  negative[2].batch.resources.find(
    (resource) => resource.resource_type === 'recipe',
  )!.dependencies[0].content_hash =
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  negative[3].batch.snapshot.snapshot_hash =
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  return {
    positive: [
      {
        case_id: 'positive.exact-closure-snapshot',
        batch,
        preflight_input: preflightInput,
        expected_preflight_result: expectedPreflightResult,
      },
    ],
    negative,
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

function render(value: JsonValueLike): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
type JsonValueLike = JsonObject | ContractArtifactEnvelope;

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`))
    throw new Error(`Contract path escapes root: ${relativePath}`);
  return resolved;
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

function validateUpstreamIdentities(): void {
  const exactArtifacts: Array<[string, Sha256Hash]> = [
    [
      'contract-pack-g3-registry-publish-foundation.json',
      'sha256:a25e99fce7485ce433f96291ddea64a90f15fa839296c8496eded4c168c7b70b',
    ],
    [
      'contract-pack-g3.2a-feature-manifest-intake.json',
      'sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9',
    ],
    [
      'contract-pack-g3.2-feature-manifest-intake.json',
      'sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b',
    ],
  ];
  for (const [file, expected] of exactArtifacts) {
    if (readArtifact(file).hash !== expected)
      throw new Error(`G3 Registry upstream identity drift: ${file}`);
  }
  const sealed = readArtifact(
    'conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json',
  );
  if (
    sealed.hash !==
      'sha256:0e5ea012864bce2dae7d0435e700b78b6d3299703f896c737677d24f46d8f78f' ||
    sealed.payload.bundle_hash !==
      'sha256:4110072a90b441f154f580a647a30bd24a9aa3f052635c22e8e7d3dbe0a31967'
  ) {
    throw new Error('G3 Registry upstream G2 sealed identity drift');
  }
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const schemaEntries: Array<[string, string, string, JsonObject]> = [
    [
      G3_REGISTRY_RESOURCE_SCHEMA_PATH,
      'icarus.workflow-registry-resource-schema',
      'icarus:workflow-registry-resource-schema:1\n',
      G3_REGISTRY_RESOURCE_SCHEMA,
    ],
    [
      G3_REGISTRY_CLOSURE_SCHEMA_PATH,
      'icarus.workflow-registry-dependency-closure-manifest-schema',
      'icarus:workflow-registry-dependency-closure-manifest-schema:1\n',
      G3_REGISTRY_CLOSURE_SCHEMA,
    ],
    [
      G3_REGISTRY_SNAPSHOT_SCHEMA_PATH,
      'icarus.workflow-registry-snapshot-schema',
      'icarus:workflow-registry-snapshot-schema:1\n',
      G3_REGISTRY_SNAPSHOT_SCHEMA,
    ],
    [
      G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA_PATH,
      'icarus.workflow-registry-snapshot-preflight-input-schema',
      'icarus:workflow-registry-snapshot-preflight-input-schema:1\n',
      G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA,
    ],
    [
      G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA_PATH,
      'icarus.workflow-registry-snapshot-preflight-result-schema',
      'icarus:workflow-registry-snapshot-preflight-result-schema:1\n',
      G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA,
    ],
  ];
  const schemas = schemaEntries.map(
    ([file, ref, domain, payload]) =>
      [file, artifact(`icarus.${ref}/1`, ref, domain, payload)] as [
        string,
        ContractArtifactEnvelope,
      ],
  );
  const fixtures = g3RegistryPersistenceFixturesForTest();
  const positive = artifact(
    'icarus.workflow-g3-registry-persistence-positive-cases/1',
    'icarus.workflow-g3-registry-persistence-positive-cases',
    'icarus:workflow-g3-registry-persistence-positive-cases:1\n',
    { fixture_scope: 'test_only', cases: fixtures.positive },
  );
  const negative = artifact(
    'icarus.workflow-g3-registry-persistence-negative-cases/1',
    'icarus.workflow-g3-registry-persistence-negative-cases',
    'icarus:workflow-g3-registry-persistence-negative-cases:1\n',
    { fixture_scope: 'test_only', cases: fixtures.negative },
  );
  const prior = [
    ...schemas,
    [G3_REGISTRY_PERSISTENCE_POSITIVE_CASES_PATH, positive] as [
      string,
      ContractArtifactEnvelope,
    ],
    [G3_REGISTRY_PERSISTENCE_NEGATIVE_CASES_PATH, negative] as [
      string,
      ContractArtifactEnvelope,
    ],
  ];
  const domains = artifact(
    'icarus.workflow-g3-registry-persistence-domain-separators/1',
    'icarus.workflow-g3-registry-persistence-domain-separators',
    'icarus:workflow-g3-registry-persistence-domain-separators:1\n',
    {
      entries: [
        ...prior.map(([, entry]) => ({
          format: entry.format,
          domain_separator: entry.domain_separator,
        })),
        {
          format: 'icarus.workflow-registry-resource-content/1',
          domain_separator: G3_REGISTRY_RESOURCE_CONTENT_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-dependency-closure/1',
          domain_separator: G3_REGISTRY_CLOSURE_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-closure-manifest/1',
          domain_separator: G3_REGISTRY_CLOSURE_MANIFEST_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-snapshot/1',
          domain_separator: G3_REGISTRY_SNAPSHOT_DOMAIN,
        },
        {
          format: 'icarus.workflow-registry-snapshot-preflight/1',
          domain_separator: G3_REGISTRY_PREFLIGHT_DOMAIN,
        },
      ].sort((left, right) => compareAscii(left.format, right.format)),
    },
  );
  return [...prior, [G3_REGISTRY_PERSISTENCE_DOMAIN_CATALOG_PATH, domains]];
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g3-registry-persistence/1',
    'icarus.workflow-contract-pack-g3-registry-persistence',
    'icarus:workflow-contract-pack-g3-registry-persistence:1\n',
    {
      gate: 'G3',
      slice: 'G3.3',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      upstream_g3_2a_pack_hash:
        'sha256:c9c273b6d294d512a3578203d91d4bdce7863a3ccb561fdd7da08d072b3d8cd9',
      upstream_g3_1_pack_hash:
        'sha256:a25e99fce7485ce433f96291ddea64a90f15fa839296c8496eded4c168c7b70b',
      upstream_g3_2_pack_hash:
        'sha256:1eb0b81f488f4a37fa4503ddfef0dfa8a56d40fdeb535c9758d9d21fd39bb92b',
      upstream_g2_sealed_bundle_hash:
        'sha256:4110072a90b441f154f580a647a30bd24a9aa3f052635c22e8e7d3dbe0a31967',
      upstream_g1_schema_root_hash:
        'sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306',
      upstream_g1_schema_hash:
        'sha256:27a212831d2abd8898eb8becbfd714d96b1bfb15d818d471cfc58fdc36196e65',
      upstream_g1_migration_sha256:
        'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
      production_registry_write_performed: false,
      production_activation_performed: false,
      publisher_implemented: false,
      production_loader_implemented: false,
      artifacts: artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
      positive_case_count:
        g3RegistryPersistenceFixturesForTest().positive.length,
      negative_case_count:
        g3RegistryPersistenceFixturesForTest().negative.length,
      g4_through_g9_status: 'NOT_READY',
    },
  );
}

function validateArtifacts(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  validateUpstreamIdentities();
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const schema of [
    G3_REGISTRY_RESOURCE_SCHEMA,
    G3_REGISTRY_CLOSURE_SCHEMA,
    G3_REGISTRY_SNAPSHOT_SCHEMA,
    G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA,
    G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA,
  ]) {
    ajv.compile(schema as AnySchema);
  }
  const fixtures = g3RegistryPersistenceFixturesForTest();
  for (const fixture of fixtures.positive)
    validateRegistryPersistenceBatch(fixture.batch);
  for (const fixture of fixtures.negative) {
    try {
      validateRegistryPersistenceBatch(fixture.batch);
      throw new Error(
        `G3 Registry negative fixture accepted: ${fixture.case_id}`,
      );
    } catch (error) {
      if (
        !(error instanceof G3RegistryPersistenceContractError) ||
        error.code !== fixture.expected_code
      ) {
        throw new Error(
          `G3 Registry negative fixture drift: ${fixture.case_id}`,
        );
      }
    }
  }
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest))
    throw new Error(
      'G3 Registry persistence Contract Pack manifest is not deterministic',
    );
}

export function generateG3RegistryPersistence(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) writeAtomic(file, render(entry));
  writeAtomic(G3_REGISTRY_PERSISTENCE_MANIFEST_PATH, render(manifest));
  return manifest;
}

export function checkG3RegistryPersistence(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateArtifacts(artifacts, manifest);
  for (const [file, entry] of artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(`G3 Registry persistence artifact bytes drift: ${file}`);
  }
  if (
    fs.readFileSync(absolute(G3_REGISTRY_PERSISTENCE_MANIFEST_PATH), 'utf8') !==
    render(manifest)
  )
    throw new Error('G3 Registry persistence manifest bytes drift');
  return manifest;
}

export function g3RegistryPersistenceSchemasForTest(): {
  resource: JsonObject;
  closure: JsonObject;
  snapshot: JsonObject;
  preflightInput: JsonObject;
  preflightResult: JsonObject;
} {
  return {
    resource: clone(G3_REGISTRY_RESOURCE_SCHEMA),
    closure: clone(G3_REGISTRY_CLOSURE_SCHEMA),
    snapshot: clone(G3_REGISTRY_SNAPSHOT_SCHEMA),
    preflightInput: clone(G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA),
    preflightResult: clone(G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA),
  };
}
