import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  G37_SCHEMA_RESOURCE_HASHES,
  calculateG37ApprovedReviewHash,
  calculateG37DomainRequestHash,
  calculateG37RequestHash,
  evaluateG37PublishFoundation,
  g37SchemasForTest,
  validateG37WorkflowPublisherRequest,
} from './g3-workflow-publisher.js';
import {
  calculateG3PublishPreflightHash,
  calculateG3RegistryResourceHash,
} from './g3-registry-publish-foundation.js';
import { buildGeneratedSchema } from './generated-schema-authority.js';
import { domainSeparatedSha256 } from './hash.js';
import { assertJsonObject } from './strict-json.js';
import type { G3WorkflowPublisherRequest } from './g3-workflow-publisher-types.js';
import type { JsonObject } from './types.js';
import { g37WorkflowPublisherStoreFixtureForTest } from './g3-workflow-publisher-fixtures.js';
import { checkG37WorkflowPublisherContracts } from './g3-workflow-publisher-contract.js';

function rehashGeneratedPlanRequest(request: G3WorkflowPublisherRequest): void {
  const plan = request.compiled_plan.content;
  const { plan_hash: _planHash, ...planWithoutHash } = plan;
  const planHash = domainSeparatedSha256(
    'icarus:workflow-graph-plan:2\n',
    planWithoutHash,
  );
  plan.plan_hash = planHash;
  request.compiled_plan.content_hash = planHash;
  request.approved_review.compiled_plan_hash = planHash;
  request.approved_review.review_hash = calculateG37ApprovedReviewHash(
    request.approved_review,
  );
  for (const resource of request.publish_preflight.resources) {
    if (resource.compiled_plan_pin !== null) {
      resource.compiled_plan_pin.plan_hash = planHash;
    }
    resource.resource_hash = calculateG3RegistryResourceHash(resource);
  }
  request.publish_preflight.preflight_hash = calculateG3PublishPreflightHash(
    request.publish_preflight,
  );
  request.domain_request_hash = calculateG37DomainRequestHash(request);
  request.request_hash = calculateG37RequestHash(request);
}

function generatedOutputAuthority(
  request: G3WorkflowPublisherRequest,
): JsonObject {
  const nodes = request.compiled_plan.content.nodes as JsonObject[];
  const node = nodes.find((candidate) => candidate.id === 'capability');
  assertJsonObject(node);
  assertJsonObject(node.output_ports);
  assertJsonObject(node.output_ports.result);
  const port = node.output_ports.result;
  port.schema = buildGeneratedSchema(
    'join_expose',
    {
      node_id: node.id,
      output_port: 'result',
      input_port: 'fixture',
      required: true,
    },
    { type: 'string' },
  );
  rehashGeneratedPlanRequest(request);
  assertJsonObject(port.schema);
  return port.schema;
}

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
      'sha256:5d023a5323aec482781b0e992197571db9a09481a394eaf955d4598c249e4ec1',
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

  it.each([
    ['missing schema_ref', (value: JsonObject) => delete value.schema_ref],
    [
      'unknown schema_ref scheme',
      (value: JsonObject) =>
        (value.schema_ref = String(value.schema_ref).replace(
          'icarus-generated-schema:',
          'latest:',
        )),
    ],
    [
      'schema raw hash drift',
      (value: JsonObject) =>
        (value.schema_raw_hash =
          'sha256:1111111111111111111111111111111111111111111111111111111111111111'),
    ],
    [
      'schema domain hash drift',
      (value: JsonObject) =>
        (value.schema_hash =
          'sha256:2222222222222222222222222222222222222222222222222222222222222222'),
    ],
  ])(
    'rejects generated Plan authority %s before Store use',
    (_label, mutate) => {
      const control = g37WorkflowPublisherStoreFixtureForTest().request;
      generatedOutputAuthority(control);
      expect(() => validateG37WorkflowPublisherRequest(control)).not.toThrow();

      const drift = structuredClone(control);
      const nodes = drift.compiled_plan.content.nodes as JsonObject[];
      const node = nodes.find((candidate) => candidate.id === 'capability');
      assertJsonObject(node);
      assertJsonObject(node.output_ports);
      assertJsonObject(node.output_ports.result);
      assertJsonObject(node.output_ports.result.schema);
      mutate(node.output_ports.result.schema);
      rehashGeneratedPlanRequest(drift);
      expect(() => validateG37WorkflowPublisherRequest(drift)).toThrowError(
        expect.objectContaining({ code: 'publish_identity_mismatch' }),
      );
    },
  );
});
