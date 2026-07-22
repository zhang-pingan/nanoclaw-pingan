import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE,
  G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS,
} from './g3-registry-exact-resource-query-types.js';
import {
  buildG3RegistryExactResourceQueryProfile,
  checkG3RegistryExactResourceQuery,
  g3RegistryExactResourceQueryFixturesForTest,
  g3RegistryExactResourceQuerySchemasForTest,
  validateRegistryExactResourceQueryInput,
} from './g3-registry-exact-resource-query.js';

describe('G3.5 Registry exact resource query contract', () => {
  it('freezes exact-only, closed, read-only semantics and error precedence', () => {
    const profile = buildG3RegistryExactResourceQueryProfile();
    expect(profile).toMatchObject({
      format: G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.profile,
      query_identity: 'resource_type_ref_content_hash',
      resolution_mode: 'exact_only',
      result_schema: 'closed',
      read_only: true,
      launchability_inference: false,
    });
    expect(profile.error_precedence).toEqual([
      ...G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE,
    ]);
  });

  it('accepts only immutable exact refs and rejects moving/range/alias/fallback inputs', () => {
    const fixtures = g3RegistryExactResourceQueryFixturesForTest();
    expect(() =>
      validateRegistryExactResourceQueryInput(fixtures.positive[0].input),
    ).not.toThrow();
    for (const fixture of fixtures.negative) {
      expect(() =>
        validateRegistryExactResourceQueryInput(fixture.input),
      ).toThrowError(expect.objectContaining({ code: fixture.expected_code }));
    }
  });

  it('keeps profile, input, result, and nested resource objects closed', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const schemas = g3RegistryExactResourceQuerySchemasForTest();
    const fixtures = g3RegistryExactResourceQueryFixturesForTest();
    const profile = buildG3RegistryExactResourceQueryProfile();
    expect(ajv.compile(schemas.profile as AnySchema)(profile)).toBe(true);
    expect(
      ajv.compile(schemas.input as AnySchema)(fixtures.positive[0].input),
    ).toBe(true);
    const validateResult = ajv.compile(schemas.result as AnySchema);
    expect(validateResult(fixtures.positive[0].expected_result)).toBe(true);
    const unknownTop = structuredClone(
      fixtures.positive[0].expected_result,
    ) as Record<string, unknown>;
    unknownTop.latest = true;
    expect(validateResult(unknownTop)).toBe(false);
    const unknownResource = structuredClone(
      fixtures.positive[0].expected_result,
    ) as Record<string, unknown>;
    (unknownResource.resource as Record<string, unknown>).launchable = true;
    expect(validateResult(unknownResource)).toBe(false);
  });

  it('keeps the isolated Contract Pack byte-stable', () => {
    const manifest = checkG3RegistryExactResourceQuery();
    expect(manifest.payload).toMatchObject({
      slice: 'G3.5',
      query_mode: 'exact_resource_type_ref_content_hash_only',
      read_only: true,
      latest_range_alias_fallback_allowed: false,
      launchability_inference_performed: false,
      registry_write_performed: false,
      publisher_implemented: false,
      publish_implemented: false,
      production_loader_implemented: false,
      activation_implemented: false,
      g4_through_g9_status: 'NOT_READY',
    });
  });
});
