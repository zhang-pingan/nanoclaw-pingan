import { describe, expect, it } from 'vitest';

import {
  checkG39PackReleaseActivationContracts,
  g39ContractCountsForTest,
} from './g3-pack-release-activation-contract.js';
import {
  g39PackReleaseActivationStoreFixtureForTest,
  rehashG39ActivationRequest,
} from './g3-pack-release-activation-fixtures.js';
import {
  calculateG39RequestHash,
  g39SchemasForTest,
} from './g3-pack-release-activation.js';
import {
  G39_ACTIVATION_ERROR_PRECEDENCE,
  type G39ActivationErrorCode,
} from './g3-pack-release-activation-types.js';
import { canonicalJson } from './hash.js';
import {
  PackReleaseActivationError,
  parseG39ActivationRequestBytes,
} from '../authoring/pack-release-activation.js';

function expectCode(run: () => unknown, code: G39ActivationErrorCode): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<PackReleaseActivationError>>({ code }),
  );
}

describe('G3.9 Pack Release Activation contracts', () => {
  it('checks the current pack and fixture counts', () => {
    const pack = checkG39PackReleaseActivationContracts();
    const counts = g39ContractCountsForTest();
    expect(pack.payload).toMatchObject({
      gate: 'G3',
      slice: 'G3.9',
      status: 'DONE',
      positive_case_count: counts.positive,
      negative_case_count: counts.negative,
      fault_case_count: counts.fault,
    });
    expect(counts.positive).toBeGreaterThan(0);
    expect(counts.negative).toBeGreaterThan(0);
    expect(counts.fault).toBeGreaterThan(0);
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

    const fixture = g39PackReleaseActivationStoreFixtureForTest();
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

    const fixture = g39PackReleaseActivationStoreFixtureForTest();
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
    delete (invalid as Partial<typeof invalid>).pack_id;
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
