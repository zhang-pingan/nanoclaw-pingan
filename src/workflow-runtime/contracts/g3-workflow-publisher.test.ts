import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  G37_SCHEMA_RESOURCE_HASHES,
  evaluateG37PublishFoundation,
  g37SchemasForTest,
  validateG37WorkflowPublisherRequest,
} from './g3-workflow-publisher.js';
import { g37WorkflowPublisherStoreFixtureForTest } from './g3-workflow-publisher-fixtures.js';
import { checkG37WorkflowPublisherContracts } from './g3-workflow-publisher-contract.js';

describe('G3.7 WorkflowPublisher contracts', () => {
  it('builds one deterministic closed request across all exact identities', () => {
    const first = g37WorkflowPublisherStoreFixtureForTest();
    const second = g37WorkflowPublisherStoreFixtureForTest();
    expect(second).toEqual(first);
    expect(() =>
      validateG37WorkflowPublisherRequest(first.request),
    ).not.toThrow();
    expect(evaluateG37PublishFoundation(first.request)).toMatchObject({
      outcome: 'accepted',
      code: 'preflight_ok',
      side_effects: 'none_by_contract',
    });
    expect(first.request.release_resources).toHaveLength(
      first.request.target_release.resources.length,
    );
    expect(
      first.request.target_release.resources.filter(
        (entry) => entry.role === 'closure_root',
      ),
    ).toHaveLength(1);
    expect(G37_SCHEMA_RESOURCE_HASHES.request).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(checkG37WorkflowPublisherContracts().hash).toBe(
      'sha256:e80038f09ad841de630d961f137f15a2de14a487a74afb6b1d8b36edea689ba0',
    );
  });

  it('publishes closed request, receipt, and result schemas', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const schemas = g37SchemasForTest();
    const fixture = g37WorkflowPublisherStoreFixtureForTest();
    const validate = ajv.compile(schemas.request as AnySchema);
    expect(validate(fixture.request), JSON.stringify(validate.errors)).toBe(
      true,
    );
    const unknown = structuredClone(fixture.request) as Record<string, unknown>;
    unknown.active_release = 'forbidden';
    expect(validate(unknown)).toBe(false);
  });

  it('rejects request, review, release, and plan identity drift before Store use', () => {
    const fixture = g37WorkflowPublisherStoreFixtureForTest();
    const drifted = structuredClone(fixture.request);
    drifted.compiled_plan.content_hash =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    expect(() => validateG37WorkflowPublisherRequest(drifted)).toThrowError(
      expect.objectContaining({ code: 'publish_request_hash_mismatch' }),
    );
  });
});
