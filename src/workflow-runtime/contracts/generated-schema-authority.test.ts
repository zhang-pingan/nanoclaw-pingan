import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue, Sha256Hash } from './types.js';
import {
  assertGeneratedSchemaAuthority,
  assertPlanGeneratedSchemaBinding,
  buildGeneratedSchema,
  buildPlanGeneratedSchemaBinding,
  generatedSchemaContentHash,
  generatedSchemaParameterHash,
} from './generated-schema-authority.js';

function rawHash(value: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

describe('generated schema authority', () => {
  const parameters: JsonObject = {
    node_id: 'join',
    output_port: 'renamed',
    input_port: 'source',
    required: true,
  };
  const schemaJson: JsonObject = {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };

  it('builds one closed JCS content address and parameter-domain identity', () => {
    const authority = buildGeneratedSchema(
      'join_expose',
      parameters,
      schemaJson,
    );
    expect(() => assertGeneratedSchemaAuthority(authority)).not.toThrow();
    const canonicalBytes =
      '{"additionalProperties":false,"properties":{"ok":{"type":"boolean"}},"required":["ok"],"type":"object"}';
    const expectedRawHash = rawHash(canonicalBytes);
    expect(authority).toEqual({
      type: 'generated',
      generator: 'join_expose',
      canonicalizer: 'RFC8785-JCS',
      parameter_hash: generatedSchemaParameterHash('join_expose', parameters),
      schema_ref: `icarus-generated-schema:${expectedRawHash}`,
      schema_raw_hash: expectedRawHash,
      schema_hash: generatedSchemaContentHash(schemaJson),
      schema_byte_length: Buffer.byteLength(canonicalBytes, 'utf8'),
      schema_json: schemaJson,
    });
    expect(
      buildGeneratedSchema('join_expose', parameters, {
        properties: { ok: { type: 'boolean' } },
        type: 'object',
        required: ['ok'],
        additionalProperties: false,
      }),
    ).toEqual(authority);
  });

  it.each([
    ['missing schema_json', (value: JsonObject) => delete value.schema_json],
    ['missing schema_ref', (value: JsonObject) => delete value.schema_ref],
    ['unknown field', (value: JsonObject) => (value.latest = true)],
    [
      'unknown ref scheme',
      (value: JsonObject) =>
        (value.schema_ref = String(value.schema_ref).replace(
          'icarus-generated-schema:',
          'registry:',
        )),
    ],
    [
      'raw hash drift',
      (value: JsonObject) => (value.schema_raw_hash = rawHash('drift')),
    ],
    [
      'domain hash drift',
      (value: JsonObject) => (value.schema_hash = rawHash('drift')),
    ],
    [
      'canonical bytes drift',
      (value: JsonObject) => (value.schema_json = { type: 'string' }),
    ],
    [
      'byte length drift',
      (value: JsonObject) =>
        (value.schema_byte_length = Number(value.schema_byte_length) + 1),
    ],
    [
      'canonicalizer drift',
      (value: JsonObject) => (value.canonicalizer = 'JSON.stringify'),
    ],
    [
      'parameter hash malformed',
      (value: JsonObject) => (value.parameter_hash = 'latest'),
    ],
  ])('rejects %s without resolver or fallback', (_label, mutate) => {
    const authority = buildGeneratedSchema(
      'join_expose',
      parameters,
      schemaJson,
    );
    mutate(authority);
    expect(() => assertGeneratedSchemaAuthority(authority)).toThrow();
  });

  it('binds the exact generated tuple to one persisted Plan hash', () => {
    const authority = buildGeneratedSchema(
      'join_expose',
      parameters,
      schemaJson,
    );
    const binding = buildPlanGeneratedSchemaBinding(
      {
        plan_id: 'plan:join',
        graph_run_id: 'run:join',
        plan_hash: rawHash('plan'),
      },
      authority,
    );
    expect(() => assertPlanGeneratedSchemaBinding(binding)).not.toThrow();
    expect(binding).toMatchObject({
      schema_ref: authority.schema_ref,
      schema_hash: authority.schema_hash,
      generator: authority.generator,
      parameter_hash: authority.parameter_hash,
    });

    for (const field of [
      'plan_id',
      'graph_run_id',
      'plan_hash',
      'schema_ref',
      'schema_hash',
      'generator',
      'parameter_hash',
    ]) {
      const drift = clone(binding);
      drift[field] = field.endsWith('hash') ? rawHash(field) : `${field}:drift`;
      expect(() => assertPlanGeneratedSchemaBinding(drift), field).toThrow();
    }
    const unknown = clone(binding);
    unknown.resolver = 'latest';
    expect(() => assertPlanGeneratedSchemaBinding(unknown)).toThrow();
  });
});
