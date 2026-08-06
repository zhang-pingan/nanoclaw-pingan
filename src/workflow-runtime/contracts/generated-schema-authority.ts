import crypto from 'node:crypto';

import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from './hash.js';
import { assertJsonObject } from './strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const GENERATED_SCHEMA_PARAMETER_DOMAIN =
  'icarus:workflow-generated-schema-parameter:2\n';
export const GENERATED_SCHEMA_DOMAIN = 'icarus:workflow-generated-schema:2\n';
export const GENERATED_SCHEMA_PLAN_BINDING_DOMAIN =
  'icarus:workflow-plan-generated-schema-binding:1\n';
export const NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
export const GENERATED_SCHEMA_CANONICALIZER = 'RFC8785-JCS';
export const GENERATED_SCHEMA_REF_PATTERN =
  '^icarus-generated-schema:sha256:[0-9a-f]{64}$';

const generatedSchemaRefPattern = new RegExp(GENERATED_SCHEMA_REF_PATTERN);

export type GeneratedSchemaGenerator =
  | 'join_expose'
  | 'child_completion'
  | 'map_result';
export type PlanGeneratedSchemaGenerator =
  | GeneratedSchemaGenerator
  | 'node_output_envelope';

export class GeneratedSchemaAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedSchemaAuthorityError';
  }
}

function rawSha256(bytes: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

export function generatedSchemaRef(rawHash: Sha256Hash): string {
  return `icarus-generated-schema:${rawHash}`;
}

export function generatedSchemaParameterHash(
  generator: PlanGeneratedSchemaGenerator,
  parameters: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(GENERATED_SCHEMA_PARAMETER_DOMAIN, {
    generator,
    ...parameters,
  });
}

export function generatedSchemaContentHash(schemaJson: JsonValue): Sha256Hash {
  return domainSeparatedSha256(GENERATED_SCHEMA_DOMAIN, schemaJson);
}

function hashSchema(): JsonObject {
  return { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
}

function publishedPortSchema(
  schemaHash: Sha256Hash,
  maxBytes: number | null,
  required: boolean,
): JsonObject {
  const present: JsonObject = {
    type: 'object',
    additionalProperties: false,
    required: [
      'state',
      'value_ref',
      'value_hash',
      'schema_hash',
      'byte_length',
    ],
    properties: {
      state: { const: 'present' },
      value_ref: { type: 'string', minLength: 1 },
      value_hash: hashSchema(),
      schema_hash: { const: schemaHash },
      byte_length: {
        type: 'integer',
        minimum: 0,
        maximum: maxBytes ?? Number.MAX_SAFE_INTEGER,
      },
    },
  };
  if (required) return present;
  return {
    oneOf: [
      present,
      {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'schema_hash'],
        properties: {
          state: { const: 'absent' },
          schema_hash: { const: schemaHash },
        },
      },
    ],
  };
}

export function nodeOutputPortContractHash(
  outputPorts: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(NODE_OUTPUT_PORT_CONTRACT_DOMAIN, outputPorts);
}

export function buildNodeOutputEnvelopeSchema(
  nodeId: string,
  outputPorts: JsonObject,
): JsonObject {
  if (nodeId.length === 0) {
    throw new GeneratedSchemaAuthorityError(
      'Node output envelope node id is empty',
    );
  }
  const portNames = Object.keys(outputPorts).sort();
  const portProperties: JsonObject = {};
  for (const portName of portNames) {
    const contract = outputPorts[portName];
    assertJsonObject(contract);
    assertJsonObject(contract.schema);
    const schemaHash = parseSha256Hash(contract.schema.schema_hash);
    const maxBytes = contract.max_bytes;
    if (
      maxBytes !== null &&
      (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 0)
    ) {
      throw new GeneratedSchemaAuthorityError(
        `Node output port ${portName} has an invalid max_bytes`,
      );
    }
    if (typeof contract.required !== 'boolean') {
      throw new GeneratedSchemaAuthorityError(
        `Node output port ${portName} has an invalid required flag`,
      );
    }
    portProperties[portName] = publishedPortSchema(
      schemaHash,
      maxBytes === null ? null : Number(maxBytes),
      contract.required,
    );
  }
  const portContractHash = nodeOutputPortContractHash(outputPorts);
  const schemaJson: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['port_contract_hash', 'ports', 'envelope_hash'],
    properties: {
      port_contract_hash: { const: portContractHash },
      ports: {
        type: 'object',
        additionalProperties: false,
        properties: portProperties,
        ...(portNames.length > 0 ? { required: portNames } : {}),
      },
      envelope_hash: hashSchema(),
    },
  };
  return buildGeneratedSchema(
    'node_output_envelope',
    {
      node_id: nodeId,
      port_contract_hash: portContractHash,
      output_ports: outputPorts,
    },
    schemaJson,
  );
}

export function buildGeneratedSchema(
  generator: PlanGeneratedSchemaGenerator,
  parameters: JsonObject,
  schemaJson: JsonValue,
): JsonObject {
  const canonicalBytes = canonicalJson(schemaJson);
  const schemaRawHash = rawSha256(canonicalBytes);
  return {
    type: 'generated',
    generator,
    canonicalizer: GENERATED_SCHEMA_CANONICALIZER,
    parameter_hash: generatedSchemaParameterHash(generator, parameters),
    schema_ref: generatedSchemaRef(schemaRawHash),
    schema_raw_hash: schemaRawHash,
    schema_hash: generatedSchemaContentHash(schemaJson),
    schema_byte_length: Buffer.byteLength(canonicalBytes, 'utf8'),
    schema_json: schemaJson,
  };
}

export function assertGeneratedSchemaAuthority(
  value: JsonValue,
): asserts value is JsonObject {
  assertJsonObject(value);
  if (
    !exactKeys(value, [
      'type',
      'generator',
      'canonicalizer',
      'parameter_hash',
      'schema_ref',
      'schema_raw_hash',
      'schema_hash',
      'schema_byte_length',
      'schema_json',
    ]) ||
    value.type !== 'generated' ||
    ![
      'join_expose',
      'child_completion',
      'map_result',
      'node_output_envelope',
    ].includes(String(value.generator)) ||
    value.canonicalizer !== GENERATED_SCHEMA_CANONICALIZER ||
    typeof value.schema_ref !== 'string' ||
    !generatedSchemaRefPattern.test(value.schema_ref) ||
    typeof value.schema_byte_length !== 'number' ||
    !Number.isSafeInteger(value.schema_byte_length) ||
    value.schema_byte_length < 0
  ) {
    throw new GeneratedSchemaAuthorityError(
      'Generated schema authority has an unknown, missing, or invalid field',
    );
  }
  const parameterHash = parseSha256Hash(value.parameter_hash);
  const schemaRawHash = parseSha256Hash(value.schema_raw_hash);
  const schemaHash = parseSha256Hash(value.schema_hash);
  const canonicalBytes = canonicalJson(value.schema_json);
  if (
    parameterHash !== value.parameter_hash ||
    rawSha256(canonicalBytes) !== schemaRawHash ||
    generatedSchemaRef(schemaRawHash) !== value.schema_ref ||
    generatedSchemaContentHash(value.schema_json) !== schemaHash ||
    Buffer.byteLength(canonicalBytes, 'utf8') !== value.schema_byte_length
  ) {
    throw new GeneratedSchemaAuthorityError(
      'Generated schema ref, canonical bytes, or hash binding drifted',
    );
  }
}

export function buildPlanGeneratedSchemaBinding(
  plan: {
    plan_id: string;
    graph_run_id: string;
    plan_hash: Sha256Hash;
  },
  authority: JsonValue,
): JsonObject {
  assertGeneratedSchemaAuthority(authority);
  const withoutHash: JsonObject = {
    plan_id: plan.plan_id,
    graph_run_id: plan.graph_run_id,
    plan_hash: plan.plan_hash,
    schema_ref: authority.schema_ref,
    schema_hash: authority.schema_hash,
    generator: authority.generator,
    parameter_hash: authority.parameter_hash,
  };
  const binding = {
    ...withoutHash,
    binding_hash: domainSeparatedSha256(
      GENERATED_SCHEMA_PLAN_BINDING_DOMAIN,
      withoutHash,
    ),
  };
  assertPlanGeneratedSchemaBinding(binding);
  return binding;
}

export function assertPlanGeneratedSchemaBinding(
  value: JsonValue,
): asserts value is JsonObject {
  assertJsonObject(value);
  if (
    !exactKeys(value, [
      'plan_id',
      'graph_run_id',
      'plan_hash',
      'schema_ref',
      'schema_hash',
      'generator',
      'parameter_hash',
      'binding_hash',
    ]) ||
    typeof value.plan_id !== 'string' ||
    value.plan_id.length === 0 ||
    typeof value.graph_run_id !== 'string' ||
    value.graph_run_id.length === 0 ||
    typeof value.schema_ref !== 'string' ||
    !generatedSchemaRefPattern.test(value.schema_ref) ||
    ![
      'join_expose',
      'child_completion',
      'map_result',
      'node_output_envelope',
    ].includes(String(value.generator))
  ) {
    throw new GeneratedSchemaAuthorityError(
      'Plan generated schema binding has an unknown, missing, or invalid field',
    );
  }
  const planHash = parseSha256Hash(value.plan_hash);
  const schemaHash = parseSha256Hash(value.schema_hash);
  const parameterHash = parseSha256Hash(value.parameter_hash);
  const bindingHash = parseSha256Hash(value.binding_hash);
  const withoutHash: JsonObject = {
    plan_id: value.plan_id,
    graph_run_id: value.graph_run_id,
    plan_hash: planHash,
    schema_ref: value.schema_ref,
    schema_hash: schemaHash,
    generator: value.generator,
    parameter_hash: parameterHash,
  };
  if (
    domainSeparatedSha256(GENERATED_SCHEMA_PLAN_BINDING_DOMAIN, withoutHash) !==
    bindingHash
  ) {
    throw new GeneratedSchemaAuthorityError(
      'Plan generated schema binding hash drifted',
    );
  }
}
