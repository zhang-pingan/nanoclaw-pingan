import { canonicalJson } from '../contracts/hash.js';
import {
  calculateRegistryResourceContentHash,
  compareAscii,
  registryResourceId,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryResourceDependency,
  G3RegistryResourceOwner,
  G3RegistryResourceRecord,
} from '../contracts/g3-registry-persistence-types.js';
import {
  G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS,
  type G3RegistryExactResourceQueryErrorCode,
  type G3RegistryExactResourceQueryInput,
  type G3RegistryExactResourceQueryRecord,
  type G3RegistryExactResourceQueryResult,
} from '../contracts/g3-registry-exact-resource-query-types.js';
import {
  G3RegistryExactResourceQueryContractError,
  validateRegistryExactResourceQueryInput,
} from '../contracts/g3-registry-exact-resource-query.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeReadConnection } from './runtime-store/index.js';

export type RegistryExactResourceReadConnection = Pick<
  WorkflowRuntimeReadConnection,
  'queryAll' | 'queryOne'
>;

interface ResourceRow extends Record<string, unknown> {
  id: string;
  resource_type: string;
  resource_id: string;
  resource_version: string;
  owner_core_ref: string | null;
  owner_feature_id: string | null;
  canonical_value_id: string;
  content_hash: string;
  publication_state: string;
}

interface ValueRow extends Record<string, unknown> {
  id: string;
  storage_kind: string;
  inline_canonical_json: string | null;
  blob_hash: string | null;
  immutable_external_locator: string | null;
  expected_hash: string | null;
  content_hash: string;
  byte_length: number;
  media_type: string;
  schema_resource_id: string;
  schema_resource_hash: string;
  provenance_ref: string;
  retention_class: string;
  payload_state: string;
  payload_pruned_at_ms: number | null;
  row_version: number;
}

interface DependencyRow extends Record<string, unknown> {
  resource_id: string;
  dependency_resource_id: string;
  dependency_kind: string;
  expected_content_hash: string;
}

type CanonicalValueRead =
  | { outcome: 'accepted'; content: JsonObject; row: ValueRow }
  | {
      outcome: 'rejected';
      code: 'resource_value_missing' | 'resource_value_mismatch';
    };

const REGISTRY_VALUE_PROVENANCE_REF = 'icarus.workflow-registry-persistence/1';

function queryResourceByExactRef(
  connection: RegistryExactResourceReadConnection,
  resourceType: string,
  resourceId: string,
  resourceVersion: string,
): ResourceRow | undefined {
  return connection.queryOne<ResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, owner_core_ref,
            owner_feature_id, canonical_value_id, content_hash, publication_state
       FROM workflow_registry_resources
      WHERE resource_type = ? AND resource_id = ? AND resource_version = ?`,
    [resourceType, resourceId, resourceVersion],
  );
}

function queryResourceById(
  connection: RegistryExactResourceReadConnection,
  resourceId: string,
): ResourceRow | undefined {
  return connection.queryOne<ResourceRow>(
    `SELECT id, resource_type, resource_id, resource_version, owner_core_ref,
            owner_feature_id, canonical_value_id, content_hash, publication_state
       FROM workflow_registry_resources WHERE id = ?`,
    [resourceId],
  );
}

function readCanonicalValue(
  connection: RegistryExactResourceReadConnection,
  resource: ResourceRow,
): CanonicalValueRead {
  const value = connection.queryOne<ValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, blob_hash,
            immutable_external_locator, expected_hash, content_hash, byte_length,
            media_type, schema_resource_id, schema_resource_hash, provenance_ref,
            retention_class, payload_state, payload_pruned_at_ms, row_version
       FROM workflow_values WHERE id = ?`,
    [resource.canonical_value_id],
  );
  if (!value) return { outcome: 'rejected', code: 'resource_value_missing' };
  if (
    value.id !== resource.canonical_value_id ||
    value.storage_kind !== 'inline' ||
    value.inline_canonical_json === null ||
    value.blob_hash !== null ||
    value.immutable_external_locator !== null ||
    value.expected_hash !== null ||
    value.content_hash !== resource.content_hash ||
    value.media_type !== 'application/json' ||
    value.provenance_ref !== REGISTRY_VALUE_PROVENANCE_REF ||
    value.retention_class !== 'pinned' ||
    value.payload_state !== 'live' ||
    value.payload_pruned_at_ms !== null ||
    value.row_version !== 1
  ) {
    return { outcome: 'rejected', code: 'resource_value_mismatch' };
  }
  try {
    const parsed = strictParseJsonBytes(
      Buffer.from(value.inline_canonical_json, 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { outcome: 'rejected', code: 'resource_value_mismatch' };
    }
    const content = parsed as JsonObject;
    const canonical = canonicalJson(content);
    if (
      canonical !== value.inline_canonical_json ||
      Buffer.byteLength(canonical, 'utf8') !== value.byte_length ||
      calculateRegistryResourceContentHash({
        format: 'icarus.workflow-registry-resource/1',
        resource_type:
          resource.resource_type as G3RegistryResourceRecord['resource_type'],
        ref: {
          id: resource.resource_id,
          version: resource.resource_version,
        },
        content,
      }) !== resource.content_hash
    ) {
      return { outcome: 'rejected', code: 'resource_value_mismatch' };
    }
    return { outcome: 'accepted', content, row: value };
  } catch {
    return { outcome: 'rejected', code: 'resource_value_mismatch' };
  }
}

function expectedOwnerColumns(owner: G3RegistryResourceOwner): {
  ownerCoreRef: string | null;
  ownerFeatureId: string | null;
} {
  return owner.kind === 'core'
    ? {
        ownerCoreRef: `${owner.ref.id}@${owner.ref.version}`,
        ownerFeatureId: null,
      }
    : { ownerCoreRef: null, ownerFeatureId: owner.feature_id };
}

function rejected(
  input: G3RegistryExactResourceQueryInput | null,
  code: G3RegistryExactResourceQueryErrorCode,
): G3RegistryExactResourceQueryResult {
  return {
    format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result,
    outcome: 'rejected',
    code,
    resource_type: input?.resource_type ?? null,
    ref: input?.ref ?? null,
    content_hash: input?.content_hash ?? null,
    resource: null,
    read_only: true,
  };
}

function queryDependencies(
  connection: RegistryExactResourceReadConnection,
  resource: ResourceRow,
): G3RegistryResourceDependency[] | null {
  const rows = connection.queryAll<DependencyRow>(
    `SELECT resource_id, dependency_resource_id, dependency_kind, expected_content_hash
       FROM workflow_registry_resource_dependencies
      WHERE resource_id = ?
      ORDER BY dependency_resource_id COLLATE BINARY, dependency_kind COLLATE BINARY`,
    [resource.id],
  );
  const dependencies: G3RegistryResourceDependency[] = [];
  for (const row of rows) {
    if (
      row.resource_id !== resource.id ||
      row.dependency_kind !== 'registry_exact'
    )
      return null;
    const target = queryResourceById(connection, row.dependency_resource_id);
    if (
      !target ||
      target.content_hash !== row.expected_content_hash ||
      target.id !==
        registryResourceId({
          resource_type:
            target.resource_type as G3RegistryResourceRecord['resource_type'],
          ref: {
            id: target.resource_id,
            version: target.resource_version,
          },
        })
    ) {
      return null;
    }
    dependencies.push({
      resource_type:
        target.resource_type as G3RegistryResourceDependency['resource_type'],
      ref: { id: target.resource_id, version: target.resource_version },
      content_hash: target.content_hash as Sha256Hash,
      dependency_kind: 'registry_exact',
    });
  }
  return dependencies.sort((left, right) =>
    compareAscii(
      `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
      `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
    ),
  );
}

export function queryExactRegistryResource(
  connection: RegistryExactResourceReadConnection,
  candidateInput: unknown,
): G3RegistryExactResourceQueryResult {
  let input: G3RegistryExactResourceQueryInput;
  try {
    validateRegistryExactResourceQueryInput(candidateInput);
    input = candidateInput;
  } catch (error) {
    if (error instanceof G3RegistryExactResourceQueryContractError)
      return rejected(null, 'query_input_invalid');
    throw error;
  }

  const resource = queryResourceByExactRef(
    connection,
    input.resource_type,
    input.ref.id,
    input.ref.version,
  );
  if (!resource) return rejected(input, 'resource_missing');
  if (
    resource.id !== registryResourceId(input) ||
    resource.content_hash !== input.content_hash
  ) {
    return rejected(input, 'resource_hash_mismatch');
  }

  const value = readCanonicalValue(connection, resource);
  if (value.outcome === 'rejected') return rejected(input, value.code);

  const expectedSchemaId = registryResourceId({
    resource_type: 'schema',
    ref: input.schema_ref,
  });
  const schema = queryResourceByExactRef(
    connection,
    'schema',
    input.schema_ref.id,
    input.schema_ref.version,
  );
  if (
    value.row.schema_resource_id !== expectedSchemaId ||
    value.row.schema_resource_hash !== input.schema_hash ||
    !schema ||
    schema.id !== expectedSchemaId ||
    schema.content_hash !== input.schema_hash ||
    readCanonicalValue(connection, schema).outcome !== 'accepted'
  ) {
    return rejected(input, 'resource_schema_binding_mismatch');
  }

  const expectedOwner = expectedOwnerColumns(input.owner);
  if (
    resource.owner_core_ref !== expectedOwner.ownerCoreRef ||
    resource.owner_feature_id !== expectedOwner.ownerFeatureId
  ) {
    return rejected(input, 'resource_owner_mismatch');
  }
  if (resource.publication_state !== input.publication_state)
    return rejected(input, 'resource_publication_state_mismatch');

  const dependencies = queryDependencies(connection, resource);
  if (
    !dependencies ||
    canonicalJson(dependencies) !== canonicalJson(input.dependencies)
  ) {
    return rejected(input, 'resource_dependency_mismatch');
  }

  const verified: G3RegistryExactResourceQueryRecord = {
    resource_type: input.resource_type,
    ref: input.ref,
    content_hash: input.content_hash,
    schema_ref: input.schema_ref,
    schema_hash: input.schema_hash,
    owner: input.owner,
    publication_state: input.publication_state,
    dependencies,
    content: value.content,
  };
  return {
    format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result,
    outcome: 'accepted',
    code: 'exact_resource_query_ok',
    resource_type: input.resource_type,
    ref: input.ref,
    content_hash: input.content_hash,
    resource: verified,
    read_only: true,
  };
}
