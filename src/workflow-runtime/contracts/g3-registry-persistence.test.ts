import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { domainSeparatedSha256 } from './hash.js';

import {
  G3_REGISTRY_CLOSURE_SCHEMA,
  G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA,
  G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA,
  G3_REGISTRY_RESOURCE_SCHEMA,
  G3_REGISTRY_SNAPSHOT_SCHEMA,
  checkG3RegistryPersistence,
  g3RegistryPersistenceFixturesForTest,
  validateRegistryPersistenceBatch,
} from './g3-registry-persistence.js';

describe('G3.3 Registry persistence contracts', () => {
  it('builds a deterministic exact transitive closure and snapshot batch', () => {
    const first = g3RegistryPersistenceFixturesForTest();
    const second = g3RegistryPersistenceFixturesForTest();
    expect(second).toEqual(first);
    validateRegistryPersistenceBatch(first.positive[0].batch);
    expect(first.positive[0].batch.closure.members).toHaveLength(1);
    expect(first.positive[0].batch.closure.closure_hash).toBe(
      domainSeparatedSha256('icarus:workflow-registry-dependency-closure:1\n', {
        format: 'icarus.workflow-registry-dependency-closure/1',
        root_resource_type: first.positive[0].batch.closure.root_resource_type,
        root_ref: first.positive[0].batch.closure.root_ref,
        members: first.positive[0].batch.closure.members,
        member_count: first.positive[0].batch.closure.member_count,
      }),
    );
    expect(first.positive[0].batch.snapshot.snapshot_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('rejects each exact identity, dependency, closure, and snapshot negative', () => {
    const fixtures = g3RegistryPersistenceFixturesForTest();
    for (const fixture of fixtures.negative) {
      expect(() =>
        validateRegistryPersistenceBatch(fixture.batch),
      ).toThrowError(expect.objectContaining({ code: fixture.expected_code }));
    }
  });

  it('keeps all published schemas closed and the Contract Pack byte-stable', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const fixtures = g3RegistryPersistenceFixturesForTest();
    const batch = fixtures.positive[0].batch;
    for (const [schema, value] of [
      [G3_REGISTRY_RESOURCE_SCHEMA, batch.resources[0]],
      [G3_REGISTRY_RESOURCE_SCHEMA, batch.resources[1]],
      [G3_REGISTRY_CLOSURE_SCHEMA, batch.closure],
      [G3_REGISTRY_SNAPSHOT_SCHEMA, batch.snapshot],
    ] as Array<[unknown, unknown]>) {
      const validate = ajv.compile(schema as AnySchema);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    const preflightValidate = ajv.compile(
      G3_REGISTRY_PREFLIGHT_INPUT_SCHEMA as AnySchema,
    );
    expect(
      preflightValidate({
        snapshot_ref: batch.snapshot.ref,
        snapshot_hash: batch.snapshot.snapshot_hash,
        expected_compiler_version: batch.snapshot.compiler_version,
        expected_core_build_hash: batch.snapshot.core_build_hash,
        expected_database_schema_hash: batch.snapshot.database_schema_hash,
      }),
    ).toBe(true);
    const resultValidate = ajv.compile(
      G3_REGISTRY_PREFLIGHT_RESULT_SCHEMA as AnySchema,
    );
    expect(
      resultValidate({
        format: 'icarus.workflow-registry-snapshot-preflight-result/1',
        outcome: 'accepted',
        code: 'preflight_ok',
        snapshot_ref: batch.snapshot.ref,
        snapshot_hash: batch.snapshot.snapshot_hash,
        closure_hash: batch.closure.closure_hash,
        member_count: batch.closure.member_count,
        read_only: true,
      }),
    ).toBe(true);
    const unknown = structuredClone(batch.resources[0]) as Record<
      string,
      unknown
    >;
    unknown.implicit_default = true;
    expect(ajv.compile(G3_REGISTRY_RESOURCE_SCHEMA as AnySchema)(unknown)).toBe(
      false,
    );
    expect(checkG3RegistryPersistence().payload.slice).toBe('G3.3');
  });

  it('does not read legacy source or expose production/publisher surfaces', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'g3-registry-persistence.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /source_path|--accept|snapshot update|release-publisher|production loader/i,
    );
  });
});
