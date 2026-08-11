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
  G3RegistryResourceOwner,
  G3RegistryResourceRecord,
  G3RegistrySnapshot,
} from '../contracts/g3-registry-persistence-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { persistRegistryPersistenceBatch } from '../store/registry-persistence.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import {
  publishWorkflowBundle,
  WorkflowBundlePublisherError,
} from './workflow-bundle-publisher.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

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
    path.join(os.tmpdir(), 'icarus-bundle-publisher-'),
  );
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
  });
  stores.push(store);
  return store;
}

function ownerKey(owner: G3RegistryResourceOwner): string {
  switch (owner.kind) {
    case 'core':
      return `core-${owner.ref.id}`;
    case 'pack':
      return `pack-${owner.pack_id}`;
    case 'principal':
      return `principal-${owner.principal_ref}`;
  }
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

function fixture(
  owner: G3RegistryResourceOwner,
  content: JsonObject = { name: 'fixture' },
): G3RegistryPersistenceBatch {
  const key = ownerKey(owner).replace(/[^A-Za-z0-9._:-]/g, '-');
  const schemaRef = { id: `bundle.${key}.schema`, version: '1.0.0' };
  const schemaBase = {
    format: 'icarus.workflow-registry-resource/1' as const,
    resource_type: 'schema' as const,
    ref: schemaRef,
    owner,
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
  const recipeBase = {
    format: 'icarus.workflow-registry-resource/1' as const,
    resource_type: 'recipe' as const,
    ref: { id: `bundle.${key}.recipe`, version: '1.0.0' },
    owner,
    schema_ref: schema.ref,
    schema_hash: schema.content_hash,
    content,
    dependencies: [dependency(schema)],
  };
  const recipe: G3RegistryResourceRecord = {
    ...recipeBase,
    content_hash: calculateRegistryResourceContentHash(recipeBase),
  };
  const resources = [schema, recipe].sort((left, right) =>
    compareAscii(
      `${left.resource_type}\0${left.ref.id}@${left.ref.version}`,
      `${right.resource_type}\0${right.ref.id}@${right.ref.version}`,
    ),
  );
  const closure = buildDependencyClosure(
    resources,
    { resource_type: 'recipe', ref: recipe.ref },
    { id: `bundle.${key}.closure`, version: '1.0.0' },
    { ...schema.ref, hash: schema.content_hash },
  );
  const snapshotBase = {
    format: 'icarus.workflow-registry-snapshot/1' as const,
    ref: { id: `bundle.${key}.snapshot`, version: '1.0.0' },
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    compiler_version: 'workflow-compiler/1',
  } satisfies Omit<G3RegistrySnapshot, 'snapshot_hash'>;
  return {
    resources,
    closure,
    snapshot: {
      ...snapshotBase,
      snapshot_hash: calculateRegistrySnapshotHash(snapshotBase),
    },
    created_at_ms: 100,
  };
}

const OWNER_CASES: Array<{ name: string; owner: G3RegistryResourceOwner }> = [
  {
    name: 'Core',
    owner: {
      kind: 'core',
      ref: { id: 'icarus.core', version: '1.0.0' },
    },
  },
  {
    name: 'Pack',
    owner: { kind: 'pack', pack_id: 'example-pack' },
  },
  {
    name: 'Principal',
    owner: {
      kind: 'principal',
      principal_ref: 'human:local-owner',
    },
  },
];

describe('WorkflowBundlePublisher', () => {
  it.each(OWNER_CASES)(
    'publishes and exactly replays a closed $name bundle',
    ({ owner }) => {
      const store = openStore();
      const batch = fixture(owner);
      const request = {
        owner,
        resources: batch.resources,
        registry_batch: batch,
        published_at_ms: 200,
        publication_ref: `test:${ownerKey(owner)}`,
      };
      const first = publishWorkflowBundle(store, request);
      const replay = publishWorkflowBundle(store, request);
      expect(first).toMatchObject({
        disposition: 'published',
        persistence_disposition: 'inserted',
        owner,
      });
      expect(replay).toMatchObject({
        disposition: 'exact_replay',
        persistence_disposition: 'exact_replay',
        owner,
        resource_ids: first.resource_ids,
        closure_hash: first.closure_hash,
        snapshot_hash: first.snapshot_hash,
      });
      expect(
        store.queryOne<{ published: number }>(
          `SELECT count(*) AS published
           FROM workflow_registry_resources
          WHERE publication_state = 'published'
            AND id IN (${batch.resources.map(() => '?').join(',')})`,
          batch.resources.map(registryResourceId),
        ),
      ).toEqual({ published: batch.resources.length });
    },
  );

  it('rejects owner drift before persisting any Registry facts', () => {
    const store = openStore();
    const before = store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_registry_resources',
      [],
    );
    const batch = fixture({ kind: 'pack', pack_id: 'example-pack' });
    expect(() =>
      publishWorkflowBundle(store, {
        owner: { kind: 'pack', pack_id: 'other-pack' },
        resources: batch.resources,
        registry_batch: batch,
        published_at_ms: 200,
        publication_ref: 'test:owner-drift',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowBundlePublisherError>>({
        code: 'bundle_owner_mismatch',
      }),
    );
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_registry_resources',
        [],
      ),
    ).toEqual(before);
  });

  it('rejects immutable resource identity collisions', () => {
    const store = openStore();
    const owner = { kind: 'pack' as const, pack_id: 'example-pack' };
    const first = fixture(owner, { name: 'first' });
    publishWorkflowBundle(store, {
      owner,
      resources: first.resources,
      registry_batch: first,
      published_at_ms: 200,
      publication_ref: 'test:first',
    });
    const collision = fixture(owner, { name: 'different' });
    expect(() =>
      publishWorkflowBundle(store, {
        owner,
        resources: collision.resources,
        registry_batch: collision,
        published_at_ms: 201,
        publication_ref: 'test:collision',
      }),
    ).toThrow(/identity collision/i);
  });

  it('rolls back a mixed staged and published membership', () => {
    const store = openStore();
    const owner = { kind: 'pack' as const, pack_id: 'example-pack' };
    const batch = fixture(owner);
    persistRegistryPersistenceBatch(store, batch);
    const publishedId = registryResourceId(batch.resources[0]);
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_registry_resources
            SET publication_state = 'published', published_at_ms = 150,
                row_version = row_version + 1
          WHERE id = ?`,
        [publishedId],
      );
    });
    expect(() =>
      publishWorkflowBundle(store, {
        owner,
        resources: batch.resources,
        published_at_ms: 200,
        publication_ref: 'test:mixed',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkflowBundlePublisherError>>({
        code: 'bundle_publication_collision',
      }),
    );
    expect(
      store.queryAll<{ id: string; publication_state: string }>(
        `SELECT id, publication_state FROM workflow_registry_resources
          WHERE owner_pack_id = 'example-pack'
          ORDER BY id COLLATE BINARY`,
        [],
      ),
    ).toEqual(
      batch.resources
        .map((resource) => ({
          id: registryResourceId(resource),
          publication_state:
            registryResourceId(resource) === publishedId
              ? 'published'
              : 'staged',
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  });
});
