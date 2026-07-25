import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './hash.js';
import { referenceJoinPublication } from './g5-basic-runtime-repair-reference-model.js';
import type { JsonValue, Sha256Hash } from './types.js';

const planHash = `sha256:${'1'.repeat(64)}` as Sha256Hash;
const stringHash = `sha256:${'2'.repeat(64)}` as Sha256Hash;
const arrayHash = `sha256:${'3'.repeat(64)}` as Sha256Hash;

describe('G5 Basic Runtime repair independent reference model', () => {
  it('models rename, optional absent, default single, and list publication', () => {
    const result = referenceJoinPublication({
      planHash,
      nodeId: 'join',
      outputs: {
        renamed: {
          inputPort: 'source',
          schemaHash: stringHash,
          required: true,
          maxBytes: 128,
        },
        optional: {
          inputPort: 'optional',
          schemaHash: stringHash,
          required: false,
          maxBytes: 128,
        },
        defaulted: {
          inputPort: 'defaulted',
          schemaHash: stringHash,
          required: true,
          maxBytes: 128,
        },
        collected: {
          inputPort: 'collected',
          schemaHash: arrayHash,
          required: true,
          maxBytes: 256,
        },
      },
      sealedPorts: {
        source: { state: 'present', value: 'value' },
        optional: { state: 'absent' },
        defaulted: { state: 'present', value: 'fallback' },
        collected: { state: 'present', value: ['a', 'b'] },
      },
    });
    expect(result).toMatchObject({
      ports: {
        renamed: { state: 'present', schema_hash: stringHash },
        optional: { state: 'absent', schema_hash: stringHash },
        defaulted: { state: 'present', schema_hash: stringHash },
        collected: { state: 'present', schema_hash: arrayHash },
      },
      envelope_hash: expect.stringMatching(/^sha256:/),
    });
  });

  it('is deterministic for arbitrary values and caller key order', () => {
    const jsonValue = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.string()),
    );
    fc.assert(
      fc.property(
        jsonValue.map((value) => value as JsonValue),
        jsonValue.map((value) => value as JsonValue),
        (left, right) => {
          const outputs = {
            z: {
              inputPort: 'right',
              schemaHash: stringHash,
              required: true,
              maxBytes: null,
            },
            a: {
              inputPort: 'left',
              schemaHash: stringHash,
              required: true,
              maxBytes: null,
            },
          } as const;
          const first = referenceJoinPublication({
            planHash,
            nodeId: 'property-join',
            outputs,
            sealedPorts: {
              left: { state: 'present', value: left },
              right: { state: 'present', value: right },
            },
          });
          const second = referenceJoinPublication({
            planHash,
            nodeId: 'property-join',
            outputs: { a: outputs.a, z: outputs.z },
            sealedPorts: {
              right: { state: 'present', value: right },
              left: { state: 'present', value: left },
            },
          });
          expect(canonicalJson(first)).toBe(canonicalJson(second));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('fails closed for required absence and max-byte overflow', () => {
    expect(() =>
      referenceJoinPublication({
        planHash,
        nodeId: 'join',
        outputs: {
          required: {
            inputPort: 'source',
            schemaHash: stringHash,
            required: true,
            maxBytes: 1,
          },
        },
        sealedPorts: { source: { state: 'absent' } },
      }),
    ).toThrow('required_output_absent');
    expect(() =>
      referenceJoinPublication({
        planHash,
        nodeId: 'join',
        outputs: {
          limited: {
            inputPort: 'source',
            schemaHash: stringHash,
            required: true,
            maxBytes: 2,
          },
        },
        sealedPorts: { source: { state: 'present', value: 'too-large' } },
      }),
    ).toThrow('output_too_large');
  });
});
