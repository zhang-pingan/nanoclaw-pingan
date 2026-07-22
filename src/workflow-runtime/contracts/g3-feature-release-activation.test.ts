import { describe, expect, it } from 'vitest';

import {
  checkG39FeatureReleaseActivationContracts,
  g39ContractCountsForTest,
} from './g3-feature-release-activation-contract.js';
import {
  g39FeatureReleaseActivationStoreFixtureForTest,
  rehashG39ActivationRequest,
} from './g3-feature-release-activation-fixtures.js';
import {
  G39_UPSTREAM_IDENTITIES,
  calculateG39RequestHash,
  g39SchemasForTest,
} from './g3-feature-release-activation.js';
import {
  G39_ACTIVATION_ERROR_PRECEDENCE,
  type G39ActivationErrorCode,
} from './g3-feature-release-activation-types.js';
import { canonicalJson } from './hash.js';
import {
  FeatureReleaseActivationError,
  parseG39ActivationRequestBytes,
} from '../authoring/feature-release-activation.js';

function expectCode(run: () => unknown, code: G39ActivationErrorCode): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<FeatureReleaseActivationError>>({ code }),
  );
}

describe('G3.9 Feature Release Activation contracts', () => {
  it('checks the independent pack, frozen upstream identities, and fixture counts', () => {
    const pack = checkG39FeatureReleaseActivationContracts();
    expect(pack.payload).toMatchObject({
      gate: 'G3',
      slice: 'G3.9',
      status: 'DONE',
      upstream: G39_UPSTREAM_IDENTITIES,
      positive_case_count: 9,
      negative_case_count: 53,
      fault_case_count: 17,
    });
    expect(g39ContractCountsForTest()).toEqual({
      positive: 9,
      negative: 53,
      fault: 17,
    });
    expect(pack.payload.error_precedence).toEqual(
      G39_ACTIVATION_ERROR_PRECEDENCE,
    );
  });

  it('keeps request, receipt, and result schemas closed and deterministic', () => {
    const first = g39SchemasForTest();
    const second = g39SchemasForTest();
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    for (const schema of Object.values(first))
      expect(schema.additionalProperties).toBe(false);

    const fixture = g39FeatureReleaseActivationStoreFixtureForTest();
    expect(fixture.activation_request_bytes.toString('utf8')).toBe(
      canonicalJson(fixture.activation_request),
    );
    expect(calculateG39RequestHash(fixture.activation_request)).toBe(
      fixture.activation_request.request_hash,
    );
  });

  it('enforces strict-bytes, removed, unknown, schema, then hash precedence', () => {
    expectCode(
      () => parseG39ActivationRequestBytes(Buffer.from([0xff])),
      'activation_request_strict_parse_invalid',
    );
    expectCode(
      () =>
        parseG39ActivationRequestBytes(
          Buffer.from('{"format":"x","format":"y"}', 'utf8'),
        ),
      'activation_request_strict_parse_invalid',
    );

    const fixture = g39FeatureReleaseActivationStoreFixtureForTest();
    const removed = {
      ...fixture.activation_request,
      current_release: null,
    };
    expectCode(
      () => parseG39ActivationRequestBytes(Buffer.from(canonicalJson(removed))),
      'activation_request_removed_field',
    );

    const unknown = {
      ...fixture.activation_request,
      unexpected_activation_field: null,
    };
    expectCode(
      () => parseG39ActivationRequestBytes(Buffer.from(canonicalJson(unknown))),
      'activation_request_unknown_field',
    );

    const invalid = structuredClone(fixture.activation_request);
    delete (invalid as Partial<typeof invalid>).feature_id;
    expectCode(
      () => parseG39ActivationRequestBytes(Buffer.from(canonicalJson(invalid))),
      'activation_request_schema_invalid',
    );

    const drift = structuredClone(fixture.activation_request);
    drift.auth_session_ref = 'auth-session:hash-drift';
    expectCode(
      () => parseG39ActivationRequestBytes(Buffer.from(canonicalJson(drift))),
      'activation_request_hash_mismatch',
    );

    rehashG39ActivationRequest(drift);
    expect(
      parseG39ActivationRequestBytes(Buffer.from(canonicalJson(drift))),
    ).toEqual(drift);
  });
});
