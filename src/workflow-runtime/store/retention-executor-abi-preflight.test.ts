import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
  g3RetentionExecutorAbiStoreFixtureForTest,
} from '../contracts/g3-retention-executor-abi-preflight.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from './runtime-store/index.js';
import { persistRegistryPersistenceBatch } from './registry-persistence.js';
import {
  preflightRetentionExecutorAbiCompatibility,
  type RetentionExecutorAbiReadConnection,
} from './retention-executor-abi-preflight.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g3-6-test-'));
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
    identityMode: 'isolated_test',
  });
  stores.push(store);
  return store;
}

function seed(): {
  store: WorkflowRuntimeStore;
  input: ReturnType<typeof g3RetentionExecutorAbiStoreFixtureForTest>['input'];
} {
  const store = openFresh();
  const fixture = g3RetentionExecutorAbiStoreFixtureForTest();
  persistRegistryPersistenceBatch(store, fixture.batch);
  return { store, input: structuredClone(fixture.input) };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.6 Retention / Executor ABI Store preflight', () => {
  it('returns deterministic exact bindings without changing durable rows', () => {
    const { store, input } = seed();
    const before = store.queryOne<Record<string, number>>(
      `SELECT
        (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
        (SELECT COUNT(*) FROM workflow_values) AS values_count,
        (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
        (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM workflow_registry_retention_handles) AS handles,
        (SELECT COUNT(*) FROM workflow_feature_releases) AS releases`,
      [],
    );
    const first = preflightRetentionExecutorAbiCompatibility(store, input);
    const second = preflightRetentionExecutorAbiCompatibility(
      store,
      structuredClone(input),
    );
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'accepted',
      code: 'preflight_ok',
      bindings: {
        feature_release_ref: input.feature_release_ref,
        snapshot_hash: input.snapshot.snapshot_hash,
        closure_hash: input.closure.closure_hash,
        execution_artifact_count: 1,
        executor_implementation_count: 1,
        run_protocol_major: 1,
        executor_abi_major: 1,
        retention_root_eligible: true,
      },
      read_only: true,
    });
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA as AnySchema,
    );
    expect(validate(first), JSON.stringify(validate.errors)).toBe(true);
    expect(
      store.queryOne(
        `SELECT
          (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
          (SELECT COUNT(*) FROM workflow_values) AS values_count,
          (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
          (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots,
          (SELECT COUNT(*) FROM workflow_registry_retention_handles) AS handles,
          (SELECT COUNT(*) FROM workflow_feature_releases) AS releases`,
        [],
      ),
    ).toEqual(before);
  });

  it('rejects invalid or side-effect requests before any Registry read', () => {
    const fixture = g3RetentionExecutorAbiStoreFixtureForTest();
    const connection: RetentionExecutorAbiReadConnection = {
      queryAll: () => {
        throw new Error('query must not run');
      },
      queryOne: () => {
        throw new Error('query must not run');
      },
    };
    const latest = structuredClone(fixture.input);
    latest.snapshot.snapshot_ref.version = 'latest';
    expect(
      preflightRetentionExecutorAbiCompatibility(connection, latest),
    ).toMatchObject({ code: 'preflight_input_invalid', read_only: true });
    const sideEffect = structuredClone(fixture.input);
    sideEffect.requested_retention_handle_write = true;
    expect(
      preflightRetentionExecutorAbiCompatibility(connection, sideEffect),
    ).toMatchObject({
      code: 'preflight_side_effect_requested',
      read_only: true,
    });
  });

  it('uses fixed missing/hash/closure precedence from G3.3 and G3.5', () => {
    const missing = seed();
    missing.input.snapshot.snapshot_ref.version = '1.0.1';
    expect(
      preflightRetentionExecutorAbiCompatibility(missing.store, missing.input),
    ).toMatchObject({ code: 'snapshot_missing' });

    const hash = seed();
    hash.input.snapshot.snapshot_hash =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(
      preflightRetentionExecutorAbiCompatibility(hash.store, hash.input),
    ).toMatchObject({ code: 'snapshot_hash_mismatch' });

    const closure = seed();
    closure.input.closure.member_count += 1;
    expect(
      preflightRetentionExecutorAbiCompatibility(closure.store, closure.input),
    ).toMatchObject({ code: 'closure_mismatch' });

    const artifact = seed();
    artifact.input.execution_artifacts[0].content_hash =
      'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    expect(
      preflightRetentionExecutorAbiCompatibility(
        artifact.store,
        artifact.input,
      ),
    ).toMatchObject({ code: 'execution_artifact_hash_mismatch' });
  });

  it('rejects artifact binding, ABI, and retention drift in precedence order', () => {
    const binding = seed();
    binding.input.feature_release_execution_artifact!.hash =
      'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    expect(
      preflightRetentionExecutorAbiCompatibility(binding.store, binding.input),
    ).toMatchObject({ code: 'artifact_binding_mismatch' });

    const abi = seed();
    abi.input.executor_abi.major = 2;
    abi.input.retention.policy_hash =
      'sha256:4444444444444444444444444444444444444444444444444444444444444444';
    expect(
      preflightRetentionExecutorAbiCompatibility(abi.store, abi.input),
    ).toMatchObject({ code: 'executor_abi_mismatch' });

    const retention = seed();
    retention.input.retention.policy_hash =
      'sha256:5555555555555555555555555555555555555555555555555555555555555555';
    expect(
      preflightRetentionExecutorAbiCompatibility(
        retention.store,
        retention.input,
      ),
    ).toMatchObject({ code: 'retention_policy_mismatch' });
  });

  it('contains no write, GC, publication, or Retention Handle mutation surface', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'retention-executor-abi-preflight.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /withImmediateTransaction|\.execute\(|INSERT\s|UPDATE\s|DELETE\s|active pointer/i,
    );
  });
});
