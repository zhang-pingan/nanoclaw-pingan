import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { g3RegistryPersistenceFixturesForTest } from '../contracts/g3-registry-persistence.js';
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
    identityMode: 'candidate_development',
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.3 Registry persistence', () => {
  it('writes exact staged resources, closure members, and snapshot in one Store transaction', () => {
    const store = openFresh();
    const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
    const receipt = persistRegistryPersistenceBatch(store, batch);
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
        expected_compiler_version: '3.0.2',
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
