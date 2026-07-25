import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export interface ReferenceSealedPort {
  readonly state: 'present' | 'absent';
  readonly value?: JsonValue;
}

export interface ReferenceJoinOutputContract {
  readonly inputPort: string;
  readonly schemaHash: Sha256Hash;
  readonly required: boolean;
  readonly maxBytes: number | null;
}

export interface ReferencePublishedPort {
  readonly state: 'present' | 'absent';
  readonly schema_hash: Sha256Hash;
  readonly value_ref?: string;
  readonly value_hash?: Sha256Hash;
  readonly byte_length?: number;
}

const PORT_CONTRACT_DOMAIN = 'icarus:workflow-node-output-port-contract:1\n';
const ENVELOPE_DOMAIN = 'icarus:workflow-node-output-envelope:1\n';
const VALUE_DOMAIN = 'icarus:workflow-g5-repair-reference-port-value:1\n';

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function valueBytes(value: JsonValue): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function referenceJoinPublication(input: {
  readonly planHash: Sha256Hash;
  readonly nodeId: string;
  readonly outputs: Readonly<Record<string, ReferenceJoinOutputContract>>;
  readonly sealedPorts: Readonly<Record<string, ReferenceSealedPort>>;
}): JsonObject {
  const outputNames = Object.keys(input.outputs).sort(ascii);
  const compiledContracts: JsonObject = {};
  const published: JsonObject = {};
  for (const outputName of outputNames) {
    const contract = input.outputs[outputName]!;
    const source = input.sealedPorts[contract.inputPort];
    if (!source) throw new Error(`missing_input_port:${contract.inputPort}`);
    compiledContracts[outputName] = {
      input_port: contract.inputPort,
      schema_hash: contract.schemaHash,
      required: contract.required,
      max_bytes: contract.maxBytes,
    };
    if (source.state === 'absent') {
      if (contract.required)
        throw new Error(`required_output_absent:${outputName}`);
      published[outputName] = {
        state: 'absent',
        schema_hash: contract.schemaHash,
      };
      continue;
    }
    if (source.value === undefined)
      throw new Error(`missing_value:${contract.inputPort}`);
    const byteLength = valueBytes(source.value);
    if (contract.maxBytes !== null && byteLength > contract.maxBytes)
      throw new Error(`output_too_large:${outputName}`);
    const valueHash = domainSeparatedSha256(VALUE_DOMAIN, {
      plan_hash: input.planHash,
      node_id: input.nodeId,
      output_port: outputName,
      input_port: contract.inputPort,
      value: source.value,
    });
    published[outputName] = {
      state: 'present',
      value_ref: `reference:${valueHash}`,
      value_hash: valueHash,
      schema_hash: contract.schemaHash,
      byte_length: byteLength,
    };
  }
  const withoutHash: JsonObject = {
    port_contract_hash: domainSeparatedSha256(
      PORT_CONTRACT_DOMAIN,
      compiledContracts,
    ),
    ports: published,
  };
  return {
    ...withoutHash,
    envelope_hash: domainSeparatedSha256(ENVELOPE_DOMAIN, withoutHash),
  };
}
