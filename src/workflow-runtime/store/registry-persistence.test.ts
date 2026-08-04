import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  g3RegistryPersistenceFixturesForTest,
} from '../contracts/g3-registry-persistence.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from './runtime-store/index.js';
import {
  persistRegistryPersistenceBatch,
  preflightRegistrySnapshot,
} from './registry-persistence.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-g3-registry-test-'),
  );
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
    identityMode: 'isolated_test',
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.3/G3.4 Registry persistence', () => {
  it('writes exact staged resources, closure members, and snapshot in one Store transaction', () => {
    const store = openFresh();
    const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    const receipt = persistRegistryPersistenceBatch(store, batch);
    expect(receipt.disposition).toBe('inserted');
    expect(receipt.resource_count).toBe(2);
    expect(receipt.member_count).toBe(1);
    expect(
      store.queryOne<{ publication_state: string }>(
        'SELECT publication_state FROM workflow_registry_resources WHERE id = ?',
        [receipt.resource_ids[0]],
      )?.publication_state,
    ).toBe('staged');
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_snapshots',
        [],
      )?.count,
    ).toBe(1);
  });

  it('returns the original receipt for an exact replay without adding rows', () => {
    const store = openFresh();
    const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    const first = persistRegistryPersistenceBatch(store, batch);
    const countsBefore = store.queryOne<{
      resources: number;
      value_count: number;
      dependencies: number;
      closures: number;
      members: number;
      snapshots: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
        (SELECT COUNT(*) FROM workflow_values) AS value_count,
        (SELECT COUNT(*) FROM workflow_registry_resource_dependencies) AS dependencies,
        (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
        (SELECT COUNT(*) FROM workflow_registry_closure_members) AS members,
        (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots`,
      [],
    );
    const replay = persistRegistryPersistenceBatch(
      store,
      structuredClone(batch),
    );
    expect(replay).toEqual({ ...first, disposition: 'exact_replay' });
    expect(
      store.queryOne(
        `SELECT
          (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
          (SELECT COUNT(*) FROM workflow_values) AS value_count,
          (SELECT COUNT(*) FROM workflow_registry_resource_dependencies) AS dependencies,
          (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
          (SELECT COUNT(*) FROM workflow_registry_closure_members) AS members,
          (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots`,
        [],
      ),
    ).toEqual(countsBefore);
  });

  it('reuses exact resources and closure while inserting a new exact snapshot', () => {
    const store = openFresh();
    const original = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    persistRegistryPersistenceBatch(store, original);
    const next = structuredClone(original);
    next.snapshot.ref = { ...next.snapshot.ref, version: '1.0.1' };
    const { snapshot_hash: ignored, ...snapshotWithoutHash } = next.snapshot;
    next.snapshot.snapshot_hash =
      calculateRegistrySnapshotHash(snapshotWithoutHash);

    expect(persistRegistryPersistenceBatch(store, next).disposition).toBe(
      'inserted',
    );
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_resources',
        [],
      )?.count,
    ).toBe(original.resources.length);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_closure_manifests',
        [],
      )?.count,
    ).toBe(1);
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_snapshots',
        [],
      )?.count,
    ).toBe(2);
  });

  it('rejects a valid same-ref different-hash batch without changing Registry rows', () => {
    const store = openFresh();
    const original = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    persistRegistryPersistenceBatch(store, original);
    const collision = structuredClone(original);
    const root = collision.resources.find(
      (resource) =>
        resource.resource_type === collision.closure.root_resource_type,
    );
    expect(root).toBeDefined();
    root!.content = { name: 'different immutable content' };
    root!.content_hash = calculateRegistryResourceContentHash(root!);

    expect(() =>
      persistRegistryPersistenceBatch(store, collision),
    ).toThrowError(
      expect.objectContaining({ code: 'registry_resource_identity_collision' }),
    );
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_resources',
        [],
      )?.count,
    ).toBe(original.resources.length);
    expect(
      store.queryOne<{ content_hash: string }>(
        `SELECT content_hash FROM workflow_registry_resources
          WHERE resource_type = ? AND resource_id = ? AND resource_version = ?`,
        [root!.resource_type, root!.ref.id, root!.ref.version],
      )?.content_hash,
    ).not.toBe(root!.content_hash);
  });

  it('accepts an exact read-only snapshot preflight and rejects changed bindings', () => {
    const store = openFresh();
    const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    persistRegistryPersistenceBatch(store, batch);
    const input = {
      snapshot_ref: batch.snapshot.ref,
      snapshot_hash: batch.snapshot.snapshot_hash,
      expected_compiler_version: batch.snapshot.compiler_version,
      expected_core_build_hash: batch.snapshot.core_build_hash,
      expected_database_schema_hash: batch.snapshot.database_schema_hash,
    };
    expect(preflightRegistrySnapshot(store, input)).toMatchObject({
      outcome: 'accepted',
      code: 'preflight_ok',
      read_only: true,
    });
    expect(
      preflightRegistrySnapshot(store, {
        ...input,
        expected_compiler_version: '3.0.5',
      }),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'snapshot_binding_mismatch',
      read_only: true,
    });
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_resources',
        [],
      )?.count,
    ).toBe(2);
  });

  it('fails closed before opening a transaction when immutable identity is wrong', () => {
    const store = openFresh();
    const batch = structuredClone(
      g3RegistryPersistenceFixturesForTest().positive[0].batch,
    );
    batch.snapshot.snapshot_hash =
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    expect(() => persistRegistryPersistenceBatch(store, batch)).toThrowError(
      expect.objectContaining({ code: 'snapshot_hash_mismatch' }),
    );
    expect(
      store.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_registry_resources',
        [],
      )?.count,
    ).toBe(0);
  });
});
