import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDependencyClosure,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compareAscii,
  registryResourceId,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceDependency,
  G3RegistryResourceRecord,
  G3RegistrySnapshot,
} from '../contracts/g3-registry-persistence-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import { queryExactRegistryResource } from '../store/registry-resource-query.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import {
  activatePersonalWorkflowRelease,
  PersonalWorkflowRegistryError,
  publishPersonalWorkflowRelease,
  queryActivePersonalWorkflowReleases,
  type PersonalWorkflowReleasePublishRequest,
} from './personal-workflow-registry.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];
const principal = 'human:local-owner';

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.isOpen) store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function openStore(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-personal-registry-'),
  );
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
  });
  stores.push(store);
  return store;
}

function dependency(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceDependency {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
    dependency_kind: 'registry_exact',
  };
}

function resource(
  resourceType: G3RegistryResourceRecord['resource_type'],
  ref: VersionedRef,
  content: JsonObject,
  schemaRef: VersionedRef,
  schemaHash: Sha256Hash,
  dependencies: G3RegistryResourceDependency[] = [],
): G3RegistryResourceRecord {
  const base = {
    format: 'icarus.workflow-registry-resource/1' as const,
    resource_type: resourceType,
    ref,
    owner: { kind: 'principal' as const, principal_ref: principal },
    schema_ref: schemaRef,
    schema_hash: schemaHash,
    content,
    dependencies: [...dependencies].sort((left, right) =>
      compareAscii(
        `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
        `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
      ),
    ),
  };
  return { ...base, content_hash: calculateRegistryResourceContentHash(base) };
}

function batch(
  version: string,
  createdAtMs: number,
): G3RegistryPersistenceBatch {
  const schemaRef = { id: `personal.schema.${version}`, version: '1.0.0' };
  const schemaBase = {
    format: 'icarus.workflow-registry-resource/1' as const,
    resource_type: 'schema' as const,
    ref: schemaRef,
    owner: { kind: 'principal' as const, principal_ref: principal },
    schema_ref: schemaRef,
    schema_hash: '' as Sha256Hash,
    content: { type: 'object', additionalProperties: true },
    dependencies: [] as G3RegistryResourceDependency[],
  };
  const schema = {
    ...schemaBase,
    content_hash: calculateRegistryResourceContentHash(schemaBase),
  } as G3RegistryResourceRecord;
  schema.schema_hash = schema.content_hash;
  const graph = resource(
    'graph_template',
    { id: `personal.graph.${version}`, version: '1.0.0' },
    { format: 'fixture.graph', nodes: [] },
    schemaRef,
    schema.content_hash,
    [dependency(schema)],
  );
  const recipe = resource(
    'recipe',
    { id: `personal.recipe.${version}`, version: '1.0.0' },
    { format: 'fixture.recipe', graph_template_ref: graph.ref },
    schemaRef,
    schema.content_hash,
    [dependency(graph), dependency(schema)],
  );
  const resources = [schema, graph, recipe].sort((left, right) =>
    compareAscii(
      `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
      `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
    ),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: 'recipe', ref: recipe.ref },
    { id: `personal.closure.${version}`, version: '1.0.0' },
    {
      id: schema.ref.id,
      version: schema.ref.version,
      hash: schema.content_hash,
    },
  );
  const snapshotBase = {
    format: 'icarus.workflow-registry-snapshot/1' as const,
    ref: { id: `personal.snapshot.${version}`, version: '1.0.0' },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: 'workflow-compiler/1',
  } satisfies Omit<G3RegistrySnapshot, 'snapshot_hash'>;
  return {
    resources,
    closure,
    snapshot: {
      format: snapshotBase.format,
      ref: snapshotBase.ref,
      closure_ref: snapshotBase.closure_ref,
      closure_hash: snapshotBase.closure_hash,
      compiler_version: snapshotBase.compiler_version,
      snapshot_hash: calculateRegistrySnapshotHash(snapshotBase),
    },
    created_at_ms: createdAtMs,
  };
}

function publishRequest(
  version: string,
  idempotencyKey: string,
  requestedAtMs: number,
): PersonalWorkflowReleasePublishRequest {
  const registryBatch = batch(version, requestedAtMs);
  const recipe = registryBatch.resources.find(
    (candidate) => candidate.resource_type === 'recipe',
  )!;
  const graph = registryBatch.resources.find(
    (candidate) => candidate.resource_type === 'graph_template',
  )!;
  return {
    format: 'icarus.personal-workflow-release-publish-request/1',
    idempotency_domain: 'personal-workflow-test',
    idempotency_key: idempotencyKey,
    owner_principal_ref: principal,
    personal_workflow_id: 'daily-summary',
    release_ref: { id: 'daily-summary', version },
    recipe: {
      resource_type: 'recipe',
      ref: recipe.ref,
      content_hash: recipe.content_hash,
    },
    graph_template: {
      resource_type: 'graph_template',
      ref: graph.ref,
      content_hash: graph.content_hash,
    },
    registry_batch: registryBatch,
    compiled_plan_hash: domainSeparatedSha256(
      'icarus:personal-workflow-test-plan:1\n',
      { version },
    ),
    compiler_version: registryBatch.snapshot.compiler_version,
    policy_effect_envelope: {
      allowed_effects: ['capability_dispatch'],
      version,
    },
    requested_at_ms: requestedAtMs,
  };
}

describe('Personal Workflow Registry publisher authority', () => {
  it('atomically publishes an inactive principal-owned release and exact-replays its operation', () => {
    const store = openStore();
    const request = publishRequest('1.0.0', 'publish-v1', 100);
    const result = publishPersonalWorkflowRelease(store, request);
    expect(result).toMatchObject({
      disposition: 'applied',
      owner_principal_ref: principal,
      personal_workflow_id: 'daily-summary',
      active: false,
    });
    expect(publishPersonalWorkflowRelease(store, request)).toEqual({
      ...result,
      disposition: 'duplicate',
    });
    expect(
      store.queryOne<{ status: string }>(
        'SELECT status FROM workflow_personal_releases WHERE id = ?',
        [result.release_id],
      ),
    ).toEqual({ status: 'inactive' });
    expect(
      store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_registry_resources
          WHERE owner_principal_ref = ? AND publication_state = 'published'`,
        [principal],
      ),
    ).toEqual({ count: 3 });
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_personal_release_resources WHERE release_id = ?',
        [result.release_id],
      ),
    ).toEqual({ count: 3 });

    const drift = structuredClone(request);
    drift.policy_effect_envelope = { allowed_effects: [] };
    expect(() => publishPersonalWorkflowRelease(store, drift)).toThrowError(
      PersonalWorkflowRegistryError,
    );
    try {
      publishPersonalWorkflowRelease(store, drift);
    } catch (error) {
      expect((error as PersonalWorkflowRegistryError).code).toBe(
        'idempotency_conflict',
      );
    }
  });

  it('activates with a versioned pointer, swaps releases, and filters reads by principal', () => {
    const store = openStore();
    const first = publishPersonalWorkflowRelease(
      store,
      publishRequest('1.0.0', 'publish-v1', 100),
    );
    const activatedFirst = activatePersonalWorkflowRelease(store, {
      format: 'icarus.personal-workflow-release-activate-request/1',
      idempotency_domain: 'personal-workflow-test',
      idempotency_key: 'activate-v1',
      owner_principal_ref: principal,
      personal_workflow_id: 'daily-summary',
      release_id: first.release_id,
      release_hash: first.release_hash,
      expected_pointer_row_version: null,
      requested_at_ms: 110,
    });
    expect(activatedFirst.pointer_row_version).toBe(1);
    expect(queryActivePersonalWorkflowReleases(store, principal)).toMatchObject(
      [
        {
          release_id: first.release_id,
          recipe_ref: { id: 'personal.recipe.1.0.0', version: '1.0.0' },
          pointer_row_version: 1,
        },
      ],
    );
    expect(queryActivePersonalWorkflowReleases(store, 'human:other')).toEqual(
      [],
    );

    const second = publishPersonalWorkflowRelease(
      store,
      publishRequest('2.0.0', 'publish-v2', 120),
    );
    const activatedSecond = activatePersonalWorkflowRelease(store, {
      format: 'icarus.personal-workflow-release-activate-request/1',
      idempotency_domain: 'personal-workflow-test',
      idempotency_key: 'activate-v2',
      owner_principal_ref: principal,
      personal_workflow_id: 'daily-summary',
      release_id: second.release_id,
      release_hash: second.release_hash,
      expected_pointer_row_version: 1,
      requested_at_ms: 130,
    });
    expect(activatedSecond).toMatchObject({
      previous_release_id: first.release_id,
      pointer_row_version: 2,
    });
    expect(
      store.queryAll<{ id: string; status: string }>(
        'SELECT id, status FROM workflow_personal_releases ORDER BY published_at_ms',
        [],
      ),
    ).toEqual([
      { id: first.release_id, status: 'inactive' },
      { id: second.release_id, status: 'active' },
    ]);

    expect(() =>
      activatePersonalWorkflowRelease(store, {
        format: 'icarus.personal-workflow-release-activate-request/1',
        idempotency_domain: 'personal-workflow-test',
        idempotency_key: 'stale-activation',
        owner_principal_ref: principal,
        personal_workflow_id: 'daily-summary',
        release_id: first.release_id,
        release_hash: first.release_hash,
        expected_pointer_row_version: 1,
        requested_at_ms: 140,
      }),
    ).toThrow('expected 1, received 2');
  });

  it('supports principal ownership in the closed exact Registry query', () => {
    const store = openStore();
    const request = publishRequest('1.0.0', 'publish-v1', 100);
    publishPersonalWorkflowRelease(store, request);
    const recipe = request.registry_batch.resources.find(
      (candidate) => candidate.resource_type === 'recipe',
    )!;
    expect(
      queryExactRegistryResource(store, {
        format: 'icarus.workflow-registry-exact-resource-query/1',
        resource_type: recipe.resource_type,
        ref: recipe.ref,
        content_hash: recipe.content_hash,
        schema_ref: recipe.schema_ref,
        schema_hash: recipe.schema_hash,
        owner: { kind: 'principal', principal_ref: principal },
        publication_state: 'published',
        dependencies: recipe.dependencies,
      }),
    ).toMatchObject({
      outcome: 'accepted',
      resource: {
        owner: { kind: 'principal', principal_ref: principal },
      },
    });
    expect(
      queryExactRegistryResource(store, {
        format: 'icarus.workflow-registry-exact-resource-query/1',
        resource_type: recipe.resource_type,
        ref: recipe.ref,
        content_hash: recipe.content_hash,
        schema_ref: recipe.schema_ref,
        schema_hash: recipe.schema_hash,
        owner: { kind: 'principal', principal_ref: 'human:other' },
        publication_state: 'published',
        dependencies: recipe.dependencies,
      }),
    ).toMatchObject({ code: 'resource_owner_mismatch' });
    expect(registryResourceId(recipe)).toBeTruthy();
  });
});
