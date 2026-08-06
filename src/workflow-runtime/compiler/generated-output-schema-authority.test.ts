import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { assertGeneratedSchemaAuthority } from '../contracts/generated-schema-authority.js';
import { assertJsonObject } from '../contracts/strict-json.js';
import type { JsonObject, JsonValue } from '../contracts/types.js';
import { readGoldenCorpus } from './golden.js';

const hash = `sha256:${'a'.repeat(64)}`;
const goldenCases = readGoldenCorpus().cases.cases;

function object(value: JsonValue | undefined, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new Error(`Expected object: ${label}`);
  }
  return value;
}

function generatedSchema(caseId: string, nodeType: string): JsonObject {
  const result = goldenCases.find(
    (entry) => entry.case_id === caseId,
  )?.expected_result;
  if (!result || result.outcome !== 'compiled') {
    throw new Error(`Expected compiled case: ${caseId}`);
  }
  const node = (result.normalized_plan.nodes as JsonObject[]).find(
    (entry) => entry.type === nodeType,
  );
  const ports = object(node?.output_ports, `${caseId} output ports`);
  const port = object(Object.values(ports)[0], `${caseId} owner port`);
  return object(port.schema, `${caseId} generated schema`);
}

function checkedValidator(schema: JsonObject) {
  return new Ajv2020({ strict: true, allErrors: true }).compile(
    schema as AnySchema,
  );
}

function omit(value: JsonObject, key: string): JsonObject {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

describe('G2 generated-output schema authority', () => {
  const childPayload: JsonObject = {
    scope_id: 'scope:child:1',
    exit: 'done',
    output_envelope_ref: 'value:child-output:1',
    output_envelope_hash: hash,
    plan_hash: hash,
    cut_event_seq: 1,
  };
  const mapPayload: JsonObject = {
    expansion_manifest_ref: 'value:expansion-manifest:1',
    expansion_manifest_hash: hash,
    completion_policy_hash: hash,
    selected_indices: [0, 2],
    item_results_manifest_ref: 'value:item-results-manifest:1',
    item_results_manifest_hash: hash,
    item_count: 3,
  };

  it('strict-Ajv compiles closed architecture child and Map schemas', () => {
    const subgraph = generatedSchema('positive.subgraph', 'subgraph');
    const expand = generatedSchema('positive.expand', 'expand');
    const map = generatedSchema('positive.map', 'map');
    for (const descriptor of [subgraph, expand, map]) {
      expect(() => assertGeneratedSchemaAuthority(descriptor)).not.toThrow();
    }
    expect(subgraph.schema_json).toEqual(expand.schema_json);
    expect(
      checkedValidator(object(subgraph.schema_json, 'child schema'))(
        childPayload,
      ),
    ).toBe(true);
    expect(
      checkedValidator(object(map.schema_json, 'Map schema'))(mapPayload),
    ).toBe(true);
  });

  it.each([
    ['scope_id', (value: JsonObject) => (value.scope_id = '')],
    ['scope_id type', (value: JsonObject) => (value.scope_id = 1)],
    ['exit', (value: JsonObject) => (value.exit = 'unknown')],
    ['output ref', (value: JsonObject) => (value.output_envelope_ref = '')],
    ['output ref type', (value: JsonObject) => (value.output_envelope_ref = 1)],
    [
      'output hash',
      (value: JsonObject) => (value.output_envelope_hash = 'sha256:BAD'),
    ],
    ['plan hash', (value: JsonObject) => (value.plan_hash = 'latest')],
    ['cut zero', (value: JsonObject) => (value.cut_event_seq = 0)],
    ['cut fraction', (value: JsonObject) => (value.cut_event_seq = 1.5)],
    [
      'cut unsafe',
      (value: JsonObject) =>
        (value.cut_event_seq = Number.MAX_SAFE_INTEGER + 1),
    ],
  ])('rejects wrong child %s shape', (_label, mutate) => {
    const schema = object(
      generatedSchema('positive.subgraph', 'subgraph').schema_json,
      'child schema',
    );
    const value = structuredClone(childPayload);
    mutate(value);
    expect(checkedValidator(schema)(value)).toBe(false);
  });

  it('rejects missing, extra, and legacy child output_ports payloads', () => {
    const validate = checkedValidator(
      object(
        generatedSchema('positive.subgraph', 'subgraph').schema_json,
        'child schema',
      ),
    );
    for (const key of Object.keys(childPayload)) {
      expect(validate(omit(childPayload, key)), key).toBe(false);
    }
    expect(validate({ ...childPayload, extra: true })).toBe(false);
    expect(validate({ exit: 'done', output_ports: {} })).toBe(false);
  });

  it.each([
    [
      'expansion ref',
      (value: JsonObject) => (value.expansion_manifest_ref = ''),
    ],
    [
      'expansion ref type',
      (value: JsonObject) => (value.expansion_manifest_ref = 1),
    ],
    [
      'expansion hash',
      (value: JsonObject) => (value.expansion_manifest_hash = 'sha256:BAD'),
    ],
    [
      'policy hash',
      (value: JsonObject) => (value.completion_policy_hash = 'latest'),
    ],
    ['index type', (value: JsonObject) => (value.selected_indices = [0, '1'])],
    ['index negative', (value: JsonObject) => (value.selected_indices = [-1])],
    ['index fraction', (value: JsonObject) => (value.selected_indices = [0.5])],
    [
      'index unsafe',
      (value: JsonObject) =>
        (value.selected_indices = [Number.MAX_SAFE_INTEGER + 1]),
    ],
    [
      'results ref',
      (value: JsonObject) => (value.item_results_manifest_ref = ''),
    ],
    [
      'results hash',
      (value: JsonObject) =>
        (value.item_results_manifest_hash = hash.toUpperCase()),
    ],
    ['item count negative', (value: JsonObject) => (value.item_count = -1)],
    ['item count fraction', (value: JsonObject) => (value.item_count = 1.5)],
    [
      'item count unsafe',
      (value: JsonObject) => (value.item_count = Number.MAX_SAFE_INTEGER + 1),
    ],
  ])('rejects wrong Map %s shape', (_label, mutate) => {
    const schema = object(
      generatedSchema('positive.map', 'map').schema_json,
      'Map schema',
    );
    const value = structuredClone(mapPayload);
    mutate(value);
    expect(checkedValidator(schema)(value)).toBe(false);
  });

  it('rejects missing, extra, and legacy bare-array Map payloads', () => {
    const validate = checkedValidator(
      object(generatedSchema('positive.map', 'map').schema_json, 'Map schema'),
    );
    for (const key of Object.keys(mapPayload)) {
      expect(validate(omit(mapPayload, key)), key).toBe(false);
    }
    expect(validate({ ...mapPayload, extra: true })).toBe(false);
    expect(validate([{ item_index: 0, outcome: 'completed' }])).toBe(false);
  });

  it('rejects descriptor content-address tamper', () => {
    const currentChild = generatedSchema('positive.subgraph', 'subgraph');
    for (const [field, replacement] of [
      ['schema_ref', 'icarus-generated-schema:sha256:bad'],
      ['schema_raw_hash', hash],
      ['schema_hash', hash],
      ['schema_byte_length', Number(currentChild.schema_byte_length) + 1],
      ['schema_json', { type: 'null' }],
    ] as const) {
      const tampered = structuredClone(currentChild);
      tampered[field] = replacement;
      expect(() => assertGeneratedSchemaAuthority(tampered), field).toThrow();
    }
  });
});
