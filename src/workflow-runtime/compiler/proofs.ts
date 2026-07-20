import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { domainSeparatedSha256 } from '../contracts/hash.js';
import { assertJsonObject } from '../contracts/strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  CONDITION_PROGRAM_DOMAIN_SEPARATOR,
  expressionSteps,
  pointerTokens,
  sortObjectKeys,
} from './normalizer.js';
import type { BoundCompilerSnapshot, SnapshotResource } from './snapshot.js';
import { refKey } from './snapshot.js';
import type { WorkflowCompilerIdentity } from './types.js';

export class CompilerProofError extends Error {
  constructor(
    readonly code:
      | 'condition_type_mismatch'
      | 'condition_complexity_exceeded'
      | 'json_pointer_non_total'
      | 'schema_not_assignable',
  ) {
    super(code);
    this.name = 'CompilerProofError';
  }
}

type OperandType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'array'
  | 'object';

function primitiveType(value: JsonValue): OperandType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as OperandType;
}

function schemaType(schema: JsonObject): OperandType {
  const type = schema.type;
  if (
    type === 'null' ||
    type === 'boolean' ||
    type === 'number' ||
    type === 'string' ||
    type === 'array' ||
    type === 'object'
  ) {
    return type;
  }
  if (type === 'integer') return 'number';
  return 'object';
}

function schemaAtPointer(
  root: JsonObject,
  pointer: string | undefined,
): { schema: JsonObject; total: boolean } {
  let current = root;
  let total = true;
  for (const token of pointerTokens(pointer ?? null)) {
    const properties = current.properties;
    const required = current.required;
    if (
      !properties ||
      Array.isArray(properties) ||
      typeof properties !== 'object'
    ) {
      return { schema: current, total: false };
    }
    const next = properties[token];
    if (!next || Array.isArray(next) || typeof next !== 'object') {
      return { schema: current, total: false };
    }
    if (!Array.isArray(required) || !required.includes(token)) total = false;
    current = next;
  }
  return { schema: current, total };
}

function capabilityForNode(
  snapshot: BoundCompilerSnapshot,
  node: JsonObject,
): SnapshotResource | null {
  const ref = node.capability_ref;
  if (!ref || Array.isArray(ref) || typeof ref !== 'object') return null;
  return snapshot.resourceByKey.get(refKey(ref)) ?? null;
}

function schemaResource(
  snapshot: BoundCompilerSnapshot,
  ref: JsonObject,
): SnapshotResource | null {
  const resource = snapshot.resourceByKey.get(refKey(ref)) ?? null;
  return resource?.resourceType === 'schema' ? resource : null;
}

function operandSchema(
  operand: JsonObject,
  edgeSourceNode: JsonObject,
  snapshot: BoundCompilerSnapshot,
  interfaceSnapshot: JsonObject,
): { type: OperandType; hash: Sha256Hash | null } {
  if ('literal' in operand) {
    return { type: primitiveType(operand.literal), hash: null };
  }
  assertJsonObject(operand.ref);
  const ref = operand.ref;
  let portContract: JsonObject | null = null;
  if (ref.source === 'edge_source_output') {
    const capability = capabilityForNode(snapshot, edgeSourceNode);
    if (capability) {
      assertJsonObject(capability.content.output_ports);
      const candidate = capability.content.output_ports[String(ref.port)];
      if (
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate)
      ) {
        portContract = candidate;
      }
    }
  } else if (ref.source === 'scope_input') {
    assertJsonObject(interfaceSnapshot.inputs);
    const candidate = interfaceSnapshot.inputs[String(ref.port)];
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate)
    ) {
      portContract = candidate;
    }
  } else if (ref.source === 'edge_source_fact') {
    return { type: 'string', hash: null };
  }
  if (!portContract) return { type: 'object', hash: null };
  assertJsonObject(portContract.schema_ref);
  const resource = schemaResource(snapshot, portContract.schema_ref);
  if (!resource) return { type: 'object', hash: null };
  const selected = schemaAtPointer(
    resource.content,
    typeof ref.pointer === 'string' ? ref.pointer : undefined,
  );
  const hash =
    typeof ref.pointer === 'string'
      ? domainSeparatedSha256(
          'icarus:workflow-derived-schema:2\n',
          selected.schema,
        )
      : resource.contentHash;
  return { type: schemaType(selected.schema), hash };
}

function collectConditionOperands(
  expression: JsonObject,
  edgeSourceNode: JsonObject,
  snapshot: BoundCompilerSnapshot,
  interfaceSnapshot: JsonObject,
  output: Array<{ type: OperandType; hash: Sha256Hash | null }>,
): void {
  if (Array.isArray(expression.args)) {
    for (const argument of expression.args) {
      assertJsonObject(argument);
      collectConditionOperands(
        argument,
        edgeSourceNode,
        snapshot,
        interfaceSnapshot,
        output,
      );
    }
    return;
  }
  if (expression.arg && typeof expression.arg === 'object') {
    assertJsonObject(expression.arg);
    collectConditionOperands(
      expression.arg,
      edgeSourceNode,
      snapshot,
      interfaceSnapshot,
      output,
    );
    return;
  }
  if (expression.value && typeof expression.value === 'object') {
    assertJsonObject(expression.value);
    output.push(
      operandSchema(
        expression.value,
        edgeSourceNode,
        snapshot,
        interfaceSnapshot,
      ),
    );
    return;
  }
  if (expression.left && typeof expression.left === 'object') {
    assertJsonObject(expression.left);
    output.push(
      operandSchema(
        expression.left,
        edgeSourceNode,
        snapshot,
        interfaceSnapshot,
      ),
    );
  }
  if (expression.right && typeof expression.right === 'object') {
    assertJsonObject(expression.right);
    output.push(
      operandSchema(
        expression.right,
        edgeSourceNode,
        snapshot,
        interfaceSnapshot,
      ),
    );
  }
}

function assertConditionTypes(
  expression: JsonObject,
  types: OperandType[],
): void {
  if (
    (expression.op === 'lt' ||
      expression.op === 'lte' ||
      expression.op === 'gt' ||
      expression.op === 'gte') &&
    (types.length !== 2 ||
      types[0] !== types[1] ||
      (types[0] !== 'number' && types[0] !== 'string'))
  ) {
    throw new CompilerProofError('condition_type_mismatch');
  }
  if (
    (expression.op === 'eq' || expression.op === 'neq') &&
    (types.length !== 2 || types[0] !== types[1])
  ) {
    throw new CompilerProofError('condition_type_mismatch');
  }
}

function assertConditionExpression(
  expression: JsonObject,
  edgeSourceNode: JsonObject,
  snapshot: BoundCompilerSnapshot,
  interfaceSnapshot: JsonObject,
): void {
  if (Array.isArray(expression.args)) {
    for (const value of expression.args) {
      assertJsonObject(value);
      assertConditionExpression(
        value,
        edgeSourceNode,
        snapshot,
        interfaceSnapshot,
      );
    }
    return;
  }
  if (expression.arg && typeof expression.arg === 'object') {
    assertJsonObject(expression.arg);
    assertConditionExpression(
      expression.arg,
      edgeSourceNode,
      snapshot,
      interfaceSnapshot,
    );
    return;
  }
  if (expression.value && typeof expression.value === 'object') return;
  const operands: OperandType[] = [];
  for (const field of ['left', 'right'] as const) {
    const operand = expression[field];
    if (!operand || typeof operand !== 'object' || Array.isArray(operand))
      continue;
    operands.push(
      operandSchema(operand, edgeSourceNode, snapshot, interfaceSnapshot).type,
    );
  }
  assertConditionTypes(expression, operands);
}

export function compileConditionProgram(
  expression: JsonObject,
  edgeSourceNode: JsonObject,
  snapshot: BoundCompilerSnapshot,
  interfaceSnapshot: JsonObject,
  maxAllowedSteps: number,
): JsonObject {
  const normalizedAst = sortObjectKeys(expression);
  const operands: Array<{ type: OperandType; hash: Sha256Hash | null }> = [];
  collectConditionOperands(
    normalizedAst,
    edgeSourceNode,
    snapshot,
    interfaceSnapshot,
    operands,
  );
  const maxSteps = expressionSteps(normalizedAst);
  if (maxSteps > maxAllowedSteps) {
    throw new CompilerProofError('condition_complexity_exceeded');
  }
  assertConditionExpression(
    normalizedAst,
    edgeSourceNode,
    snapshot,
    interfaceSnapshot,
  );
  const withoutHash = {
    normalized_ast: normalizedAst,
    operand_schema_hashes: Object.fromEntries(
      operands.flatMap((operand, index) =>
        operand.hash ? [[`operand.${index}`, operand.hash]] : [],
      ),
    ),
    operand_types: operands.map((operand) => operand.type),
    max_steps: maxSteps,
  };
  return {
    ...withoutHash,
    program_hash: domainSeparatedSha256(
      CONDITION_PROGRAM_DOMAIN_SEPARATOR,
      withoutHash,
    ),
  };
}

interface PortSchema {
  resource: SnapshotResource;
  selected: JsonObject;
  total: boolean;
}

function portSchema(
  snapshot: BoundCompilerSnapshot,
  contract: JsonObject,
  pointer?: string,
): PortSchema {
  assertJsonObject(contract.schema_ref);
  const resource = schemaResource(snapshot, contract.schema_ref);
  if (!resource) throw new CompilerProofError('schema_not_assignable');
  const selected = schemaAtPointer(resource.content, pointer);
  return { resource, selected: selected.schema, total: selected.total };
}

function nodePortContract(
  snapshot: BoundCompilerSnapshot,
  nodes: Map<string, JsonObject>,
  nodeId: string,
  direction: 'input_ports' | 'output_ports',
  port: string,
): JsonObject | null {
  const node = nodes.get(nodeId);
  if (!node) return null;
  const capability = capabilityForNode(snapshot, node);
  if (capability) {
    const ports = capability.content[direction];
    assertJsonObject(ports);
    const value = ports[port];
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value;
  }
  const wait = node.wait;
  if (wait && typeof wait === 'object' && !Array.isArray(wait)) {
    const contractRef = wait.contract_ref;
    if (
      contractRef &&
      typeof contractRef === 'object' &&
      !Array.isArray(contractRef)
    ) {
      const contract = snapshot.resourceByKey.get(refKey(contractRef));
      if (contract?.resourceType === 'wait_contract') {
        const ports = contract.content[direction];
        assertJsonObject(ports);
        const value = ports[port];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value;
        }
      }
    }
  }
  const ports = node[direction];
  if (ports && typeof ports === 'object' && !Array.isArray(ports)) {
    const value = ports[port];
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value;
  }
  return null;
}

function proofRule(producer: JsonObject, consumer: JsonObject): string | null {
  const producerType = schemaType(producer);
  const consumerType = schemaType(consumer);
  if (producerType !== consumerType) return null;
  if (schemaEqual(producer, consumer)) return 'identical_schema';
  if ('const' in producer) {
    return valueSatisfiesSchema(producer.const, consumer)
      ? 'const_subset'
      : null;
  }
  if (Array.isArray(producer.enum)) {
    return producer.enum.every((value) => valueSatisfiesSchema(value, consumer))
      ? 'enum_subset'
      : null;
  }
  if (producerType === 'number') {
    return numericRangeSubset(producer, consumer)
      ? 'numeric_range_subset'
      : null;
  }
  if (producerType === 'array') {
    const producerItems = objectSchema(producer.items);
    const consumerItems = objectSchema(consumer.items);
    if (!producerItems || !consumerItems) return null;
    const minSafe =
      Number(producer.minItems ?? 0) >= Number(consumer.minItems ?? 0);
    const producerMax = Number(producer.maxItems ?? Number.MAX_SAFE_INTEGER);
    const consumerMax = Number(consumer.maxItems ?? Number.MAX_SAFE_INTEGER);
    return minSafe &&
      producerMax <= consumerMax &&
      proofRule(producerItems, consumerItems)
      ? 'array_item_subtype'
      : null;
  }
  if (producerType === 'object') {
    return closedObjectSubtype(producer, consumer)
      ? 'closed_object_subtype'
      : null;
  }
  return null;
}

export function schemaAssignable(
  producer: JsonObject,
  consumer: JsonObject,
): boolean {
  return proofRule(producer, consumer) !== null;
}

function objectSchema(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function normalizedSchema(schema: JsonObject): JsonObject {
  const copy = { ...schema };
  delete copy.$id;
  delete copy.$schema;
  return sortObjectKeys(copy);
}

function schemaEqual(left: JsonObject, right: JsonObject): boolean {
  return (
    JSON.stringify(normalizedSchema(left)) ===
    JSON.stringify(normalizedSchema(right))
  );
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return (
    JSON.stringify(sortObjectKeys(left)) ===
    JSON.stringify(sortObjectKeys(right))
  );
}

function numericRangeSubset(
  producer: JsonObject,
  consumer: JsonObject,
): boolean {
  const producerMinimum = Number(
    producer.exclusiveMinimum ?? producer.minimum ?? Number.NEGATIVE_INFINITY,
  );
  const consumerMinimum = Number(
    consumer.exclusiveMinimum ?? consumer.minimum ?? Number.NEGATIVE_INFINITY,
  );
  const producerMaximum = Number(
    producer.exclusiveMaximum ?? producer.maximum ?? Number.POSITIVE_INFINITY,
  );
  const consumerMaximum = Number(
    consumer.exclusiveMaximum ?? consumer.maximum ?? Number.POSITIVE_INFINITY,
  );
  if (producerMinimum < consumerMinimum || producerMaximum > consumerMaximum)
    return false;
  if (
    producerMinimum === consumerMinimum &&
    'exclusiveMinimum' in consumer &&
    !('exclusiveMinimum' in producer)
  ) {
    return false;
  }
  if (
    producerMaximum === consumerMaximum &&
    'exclusiveMaximum' in consumer &&
    !('exclusiveMaximum' in producer)
  ) {
    return false;
  }
  return true;
}

function closedObjectSubtype(
  producer: JsonObject,
  consumer: JsonObject,
): boolean {
  if (
    producer.additionalProperties !== false ||
    consumer.additionalProperties !== false
  ) {
    return false;
  }
  const producerProperties = objectSchema(producer.properties) ?? {};
  const consumerProperties = objectSchema(consumer.properties) ?? {};
  const producerRequired = new Set(
    Array.isArray(producer.required) ? producer.required.map(String) : [],
  );
  const consumerRequired = new Set(
    Array.isArray(consumer.required) ? consumer.required.map(String) : [],
  );
  if ([...consumerRequired].some((name) => !producerRequired.has(name)))
    return false;
  for (const [name, producerProperty] of Object.entries(producerProperties)) {
    const consumerProperty = consumerProperties[name];
    const producerPropertySchema = objectSchema(producerProperty);
    const consumerPropertySchema = objectSchema(consumerProperty);
    if (
      !producerPropertySchema ||
      !consumerPropertySchema ||
      !proofRule(producerPropertySchema, consumerPropertySchema)
    ) {
      return false;
    }
  }
  return true;
}

function valueSatisfiesSchema(value: JsonValue, schema: JsonObject): boolean {
  if ('const' in schema && !jsonEqual(value, schema.const)) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEqual(value, candidate))
  ) {
    return false;
  }
  const type = schema.type;
  if (type === 'null' && value !== null) return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      return false;
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern, 'u').test(value)
    )
      return false;
  }
  if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      (type === 'integer' && !Number.isInteger(value))
    )
      return false;
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return false;
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    )
      return false;
    if (
      typeof schema.exclusiveMaximum === 'number' &&
      value >= schema.exclusiveMaximum
    )
      return false;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      return false;
    const items = objectSchema(schema.items);
    if (items && value.some((entry) => !valueSatisfiesSchema(entry, items)))
      return false;
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const properties = objectSchema(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.map(String)
      : [];
    if (required.some((name) => !(name in value))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((name) => !(name in properties))
    )
      return false;
    for (const [name, propertyValue] of Object.entries(value)) {
      const propertySchema = objectSchema(properties[name]);
      if (
        propertySchema &&
        !valueSatisfiesSchema(propertyValue, propertySchema)
      )
        return false;
    }
  }
  return true;
}

function literalSatisfiesSchema(value: JsonValue, schema: JsonObject): boolean {
  const validate = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  }).compile(schema as AnySchema);
  return validate(value) === true;
}

export function compileCompatibilityProof(
  edge: JsonObject,
  nodes: Map<string, JsonObject>,
  snapshot: BoundCompilerSnapshot,
  identity: WorkflowCompilerIdentity,
  interfaceSnapshot: JsonObject,
): { proof: JsonObject; derivedSchema: JsonObject } {
  assertJsonObject(edge.from);
  assertJsonObject(edge.to);
  const consumerContract = nodePortContract(
    snapshot,
    nodes,
    String(edge.to.node_id),
    'input_ports',
    String(edge.to.port),
  );
  if (!consumerContract) throw new CompilerProofError('schema_not_assignable');
  const consumer = portSchema(snapshot, consumerContract);
  let producer = consumer;
  const pointer =
    typeof edge.from.pointer === 'string' ? edge.from.pointer : undefined;
  if (edge.from.type === 'node_output') {
    const producerContract = nodePortContract(
      snapshot,
      nodes,
      String(edge.from.node_id),
      'output_ports',
      String(edge.from.port),
    );
    if (!producerContract)
      throw new CompilerProofError('schema_not_assignable');
    producer = portSchema(snapshot, producerContract, pointer);
  } else if (edge.from.type === 'scope_input') {
    assertJsonObject(interfaceSnapshot.inputs);
    const contract = interfaceSnapshot.inputs[String(edge.from.port)];
    if (!contract || Array.isArray(contract) || typeof contract !== 'object') {
      throw new CompilerProofError('schema_not_assignable');
    }
    producer = portSchema(snapshot, contract, pointer);
  }
  if (pointer && !producer.total) {
    throw new CompilerProofError('json_pointer_non_total');
  }
  if (
    edge.from.type === 'literal' &&
    !literalSatisfiesSchema(edge.from.value, consumer.resource.content)
  ) {
    throw new CompilerProofError('schema_not_assignable');
  }
  const rule = proofRule(producer.selected, consumer.selected);
  if (!rule) throw new CompilerProofError('schema_not_assignable');
  const canonicalPointer = pointer ?? null;
  const detail = {
    rule,
    producer_schema: producer.selected,
    consumer_schema: consumer.selected,
  };
  const proofDetailHash = domainSeparatedSha256(
    'icarus:workflow-schema-compatibility-proof-detail:2\n',
    detail,
  );
  const derivedSchemaHash = pointer
    ? domainSeparatedSha256(
        'icarus:workflow-derived-schema:2\n',
        producer.selected,
      )
    : producer.resource.contentHash;
  const withoutHash = {
    proof_algorithm_version: identity.proof_algorithm_version,
    proof_algorithm_hash: identity.proof_algorithm_hash,
    producer_schema_hash: producer.resource.contentHash,
    canonical_pointer: canonicalPointer,
    pointer_totality: 'total',
    derived_schema_hash: derivedSchemaHash,
    consumer_schema_hash: consumer.resource.contentHash,
    proof_rule: rule,
    proof_detail_ref: `embedded:${proofDetailHash}`,
    proof_detail_hash: proofDetailHash,
  };
  return {
    proof: {
      ...withoutHash,
      proof_hash: domainSeparatedSha256(
        'icarus:workflow-schema-compatibility-proof:2\n',
        withoutHash,
      ),
    },
    derivedSchema: {
      type: 'registry',
      ref: producer.resource.ref,
      schema_hash: producer.resource.contentHash,
    },
  };
}
