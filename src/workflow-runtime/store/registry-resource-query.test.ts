import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA,
  g3RegistryExactResourceQueryFixturesForTest,
} from '../contracts/g3-registry-exact-resource-query.js';
import type { G3RegistryExactResourceQueryInput } from '../contracts/g3-registry-exact-resource-query-types.js';
import {
  g3RegistryPersistenceFixturesForTest,
  registryResourceId,
} from '../contracts/g3-registry-persistence.js';
import { persistRegistryPersistenceBatch } from './registry-persistence.js';
import {
  queryExactRegistryResource,
  type RegistryExactResourceReadConnection,
} from './registry-resource-query.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from './runtime-store/index.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-g3-exact-resource-query-test-'),
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

function seed(): {
  store: WorkflowRuntimeStore;
  input: G3RegistryExactResourceQueryInput;
} {
  const store = openFresh();
  const batch = g3RegistryPersistenceFixturesForTest().positive[0].batch;
  persistRegistryPersistenceBatch(store, batch);
  return {
    store,
    input: structuredClone(
      g3RegistryExactResourceQueryFixturesForTest().positive[0].input,
    ),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.5 Registry exact resource query preflight', () => {
  it('returns a closed deterministic canonical resource without changing rows', () => {
    const { store, input } = seed();
    const countsBefore = store.queryOne<Record<string, number>>(
      `SELECT
        (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
        (SELECT COUNT(*) FROM workflow_values) AS values_count,
        (SELECT COUNT(*) FROM workflow_registry_resource_dependencies) AS dependencies,
        (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
        (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots`,
      [],
    );
    const first = queryExactRegistryResource(store, input);
    const second = queryExactRegistryResource(store, structuredClone(input));
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'accepted',
      code: 'exact_resource_query_ok',
      resource_type: input.resource_type,
      ref: input.ref,
      content_hash: input.content_hash,
      resource: {
        schema_ref: input.schema_ref,
        schema_hash: input.schema_hash,
        owner: input.owner,
        publication_state: 'staged',
        dependencies: input.dependencies,
        content: { name: 'fixture' },
      },
      read_only: true,
    });
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      G3_REGISTRY_EXACT_RESOURCE_QUERY_RESULT_SCHEMA as AnySchema,
    );
    expect(validate(first), JSON.stringify(validate.errors)).toBe(true);
    expect(
      store.queryOne(
        `SELECT
          (SELECT COUNT(*) FROM workflow_registry_resources) AS resources,
          (SELECT COUNT(*) FROM workflow_values) AS values_count,
          (SELECT COUNT(*) FROM workflow_registry_resource_dependencies) AS dependencies,
          (SELECT COUNT(*) FROM workflow_registry_closure_manifests) AS closures,
          (SELECT COUNT(*) FROM workflow_registry_snapshots) AS snapshots`,
        [],
      ),
    ).toEqual(countsBefore);
  });

  it('rejects invalid moving input before invoking the query connection', () => {
    const input = structuredClone(
      g3RegistryExactResourceQueryFixturesForTest().positive[0].input,
    );
    input.ref.version = 'latest';
    const connection: RegistryExactResourceReadConnection = {
      queryAll: () => {
        throw new Error('query must not run');
      },
      queryOne: () => {
        throw new Error('query must not run');
      },
    };
    expect(queryExactRegistryResource(connection, input)).toEqual({
      format: 'icarus.workflow-registry-exact-resource-query-result/1',
      outcome: 'rejected',
      code: 'query_input_invalid',
      resource_type: null,
      ref: null,
      content_hash: null,
      resource: null,
      read_only: true,
    });
  });

  it('distinguishes exact resource missing and content-hash drift', () => {
    const { store, input } = seed();
    const missing = structuredClone(input);
    missing.ref = { ...missing.ref, version: '1.0.1' };
    expect(queryExactRegistryResource(store, missing)).toMatchObject({
      outcome: 'rejected',
      code: 'resource_missing',
      read_only: true,
    });
    const hashDrift = structuredClone(input);
    hashDrift.content_hash =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(queryExactRegistryResource(store, hashDrift)).toMatchObject({
      outcome: 'rejected',
      code: 'resource_hash_mismatch',
      read_only: true,
    });
  });

  it('rejects missing and non-canonical Value rows before later drift', () => {
    const fixtureInput =
      g3RegistryExactResourceQueryFixturesForTest().positive[0].input;
    const resourceId = registryResourceId(fixtureInput);
    const missingValueConnection: RegistryExactResourceReadConnection = {
      queryAll: () => [],
      queryOne: <T extends Record<string, unknown>>(
        sql: string,
      ): T | undefined => {
        if (sql.includes('FROM workflow_registry_resources')) {
          return {
            id: resourceId,
            resource_type: fixtureInput.resource_type,
            resource_id: fixtureInput.ref.id,
            resource_version: fixtureInput.ref.version,
            owner_core_ref: null,
            owner_feature_id: 'fixture.feature',
            canonical_value_id: `registry-value:${resourceId}`,
            content_hash: fixtureInput.content_hash,
            publication_state: 'staged',
          } as unknown as T;
        }
        return undefined;
      },
    };
    expect(
      queryExactRegistryResource(missingValueConnection, fixtureInput),
    ).toMatchObject({ code: 'resource_value_missing' });

    const { store, input } = seed();
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_values SET inline_canonical_json = ?
          WHERE id = (SELECT canonical_value_id FROM workflow_registry_resources
                       WHERE resource_type = ? AND resource_id = ? AND resource_version = ?)`,
        [
          '{"name":"fixture" }',
          input.resource_type,
          input.ref.id,
          input.ref.version,
        ],
      );
    });
    const ownerDrift = structuredClone(input);
    ownerDrift.owner = { kind: 'feature', feature_id: 'other.feature' };
    expect(queryExactRegistryResource(store, ownerDrift)).toMatchObject({
      code: 'resource_value_mismatch',
    });
  });

  it('validates exact schema binding before owner and publication state', () => {
    const { store, input } = seed();
    const schemaDrift = structuredClone(input);
    schemaDrift.schema_hash =
      'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    schemaDrift.owner = { kind: 'feature', feature_id: 'other.feature' };
    schemaDrift.publication_state = 'published';
    expect(queryExactRegistryResource(store, schemaDrift)).toMatchObject({
      code: 'resource_schema_binding_mismatch',
    });

    const ownerDrift = structuredClone(input);
    ownerDrift.owner = { kind: 'feature', feature_id: 'other.feature' };
    ownerDrift.publication_state = 'published';
    expect(queryExactRegistryResource(store, ownerDrift)).toMatchObject({
      code: 'resource_owner_mismatch',
    });

    const stateDrift = structuredClone(input);
    stateDrift.publication_state = 'published';
    expect(queryExactRegistryResource(store, stateDrift)).toMatchObject({
      code: 'resource_publication_state_mismatch',
    });
  });

  it('rejects missing, extra, or hash-drifted exact dependency rows last', () => {
    const missing = seed();
    missing.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `DELETE FROM workflow_registry_resource_dependencies
          WHERE resource_id = ?`,
        [registryResourceId(missing.input)],
      );
    });
    expect(
      queryExactRegistryResource(missing.store, missing.input),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'resource_dependency_mismatch',
      read_only: true,
    });

    const hashDrift = seed();
    hashDrift.input.dependencies[0].content_hash =
      'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    expect(
      queryExactRegistryResource(hashDrift.store, hashDrift.input),
    ).toMatchObject({ code: 'resource_dependency_mismatch' });

    const extra = seed();
    extra.store.withImmediateTransaction((transaction) => {
      const resourceId = registryResourceId(extra.input);
      transaction.execute(
        `INSERT INTO workflow_registry_resource_dependencies (
          resource_id, dependency_resource_id, dependency_kind,
          expected_content_hash, created_at_ms
        ) VALUES (?, ?, 'registry_exact', ?, ?)`,
        [resourceId, resourceId, extra.input.content_hash, 1784604172000],
      );
    });
    expect(queryExactRegistryResource(extra.store, extra.input)).toMatchObject({
      code: 'resource_dependency_mismatch',
    });
  });

  it('uses only the read/query boundary and exposes no write or launch surface', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'registry-resource-query.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /withImmediateTransaction|\.execute\(|publication pointer|launchability|release|activation/i,
    );
  });
});
