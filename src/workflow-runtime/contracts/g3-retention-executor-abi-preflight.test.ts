import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  buildG3RetentionExecutorAbiProfile,
  checkG3RetentionExecutorAbiPreflight,
  g3RetentionExecutorAbiFixturesForTest,
  g3RetentionExecutorAbiSchemasForTest,
  validateRetentionExecutorAbiPreflightInput,
} from './g3-retention-executor-abi-preflight.js';
import { G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE } from './g3-retention-executor-abi-preflight-types.js';

describe('G3.6 Retention / Executor ABI compatibility contract', () => {
  it('freezes exact-only composition, v1 compatibility, and error precedence', () => {
    const profile = buildG3RetentionExecutorAbiProfile();
    expect(profile).toMatchObject({
      resolution_mode: 'immutable_exact_only',
      registry_snapshot_verifier: 'g3_3_snapshot_closure_preflight',
      registry_resource_verifier: 'g3_5_exact_resource_query',
      compatibility_rules: {
        run_protocol_major: 1,
        executor_abi_major: 1,
        registry_schema_version: 1,
        database_schema_version: 8,
      },
      result_schema: 'closed',
      deterministic: true,
      read_only: true,
    });
    expect(profile.error_precedence).toEqual([
      ...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE,
    ]);
  });

  it('accepts immutable refs and rejects latest or alias inputs', () => {
    const fixtures = g3RetentionExecutorAbiFixturesForTest();
    expect(() =>
      validateRetentionExecutorAbiPreflightInput(fixtures.positive[0].input),
    ).not.toThrow();
    for (const fixture of fixtures.negative.slice(0, 2)) {
      expect(() =>
        validateRetentionExecutorAbiPreflightInput(fixture.input),
      ).toThrowError(
        expect.objectContaining({ code: 'preflight_input_invalid' }),
      );
    }
  });

  it('keeps input, result, bindings, and profile closed', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const schemas = g3RetentionExecutorAbiSchemasForTest();
    const fixture = g3RetentionExecutorAbiFixturesForTest().positive[0];
    expect(
      ajv.compile(schemas.profile as AnySchema)(
        buildG3RetentionExecutorAbiProfile(),
      ),
    ).toBe(true);
    expect(ajv.compile(schemas.input as AnySchema)(fixture.input)).toBe(true);
    const validateResult = ajv.compile(schemas.result as AnySchema);
    expect(validateResult(fixture.expected_result)).toBe(true);
    const unknown = structuredClone(fixture.expected_result) as Record<
      string,
      unknown
    >;
    (unknown.bindings as Record<string, unknown>).active_pointer = 'latest';
    expect(validateResult(unknown)).toBe(false);
  });

  it('keeps the isolated Contract Pack byte-stable', () => {
    const manifest = checkG3RetentionExecutorAbiPreflight();
    expect(manifest.payload).toMatchObject({
      slice: 'G3.6',
      publisher_persistence_readiness: 'PUBLISHER_SCHEMA_PREREQUISITE_READY',
      resolution_mode: 'immutable_exact_only',
      snapshot_verifier_reused: 'G3.3',
      exact_resource_query_reused: 'G3.5',
      read_only: true,
      retention_handle_created: false,
      gc_or_delete_performed: false,
      publication_state_updated: false,
    });
  });
});
