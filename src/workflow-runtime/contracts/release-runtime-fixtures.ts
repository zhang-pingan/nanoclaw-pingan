import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
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
  G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

function dependency(resource: G3RegistryResourceRecord) {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
    dependency_kind: 'registry_exact' as const,
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

export interface ReleaseRuntimeFixture {
  batch: G3RegistryPersistenceBatch;
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  execution_artifact: { ref: VersionedRef; hash: Sha256Hash };
}

export function releaseRuntimeFixtureForTest(): ReleaseRuntimeFixture {
  const base = g3RegistryPersistenceFixturesForTest().positive[0].batch;
  const schema = structuredClone(
    base.resources.find((entry) => entry.resource_type === 'schema'),
  );
  if (!schema) throw new Error('Release runtime fixture schema missing');

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
    { name: 'fixture-release-runtime-root' },
    schema,
    [executor, schema],
  );
  const resources = [schema, artifact, executor, recipe].sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: recipe.resource_type, ref: recipe.ref },
    { id: 'fixture.release-runtime-closure', version: '1.0.0' },
    { ...schema.ref, hash: schema.content_hash },
  );
  const snapshotWithoutHash = {
    format: 'icarus.workflow-registry-snapshot/1' as const,
    ref: { id: 'fixture.release-runtime-snapshot', version: '1.0.0' },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: WORKFLOW_COMPILER_VERSION,
  };
  const snapshot = {
    ...snapshotWithoutHash,
    snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
  };

  return {
    batch: {
      resources,
      closure,
      snapshot,
      created_at_ms: 1784604172000,
    },
    feature_release_ref: featureReleaseRef,
    feature_release_hash: featureReleaseHash,
    execution_artifact: {
      ref: artifactRef,
      hash: artifact.content_hash,
    },
  };
}

export function releaseRuntimeQueries(
  fixture: ReleaseRuntimeFixture,
): G3RegistryExactResourceQueryInput[] {
  return fixture.batch.resources.map(query);
}
