import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  assertGeneratedSchemaAuthority,
  assertPlanGeneratedSchemaBinding,
  buildNodeOutputEnvelopeSchema,
  buildPlanGeneratedSchemaBinding,
  NODE_OUTPUT_ENVELOPE_DOMAIN,
  nodeOutputPortContractHash,
} from '../contracts/generated-schema-authority.js';
import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../contracts/types.js';
import { PLAN_DOMAIN_SEPARATOR } from '../compiler/normalizer.js';
import type {
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from './runtime-store/index.js';

export const NODE_OUTPUT_ENVELOPE_PROVENANCE_DOMAIN =
  'icarus:workflow-node-output-envelope-provenance:1\n';
export const NODE_OUTPUT_MEMBER_PROVENANCE_DOMAIN =
  'icarus:workflow-node-output-member-provenance:1\n';

export type NodeOutputEnvelopeFaultStage =
  | 'after_content'
  | 'after_binding'
  | 'after_value'
  | 'after_ownership';

export interface NodeOutputEnvelopeWriteInput {
  readonly planId: string;
  readonly graphRunId: string;
  readonly planHash: Sha256Hash;
  readonly nodeId: string;
  readonly valueId: string;
  readonly ports: JsonObject;
  readonly createdAtMs: number;
  readonly faultAt?: NodeOutputEnvelopeFaultStage;
}

export interface NodeOutputEnvelopeValue {
  readonly valueId: string;
  readonly planId: string;
  readonly graphRunId: string;
  readonly planHash: Sha256Hash;
  readonly nodeId: string;
  readonly schemaRef: string;
  readonly schemaHash: Sha256Hash;
  readonly parameterHash: Sha256Hash;
  readonly portContractHash: Sha256Hash;
  readonly envelopeHash: Sha256Hash;
  readonly byteLength: number;
  readonly provenanceRef: string;
  readonly content: JsonObject;
}

interface PlanRow extends Record<string, unknown> {
  id: string;
  graph_run_id: string;
  plan_hash: string;
  format: string;
  compiler_version: string;
  compiled_plan_json: string | null;
}

interface StoredValueRow extends Record<string, unknown> {
  id: string;
  storage_kind: string;
  inline_canonical_json: string | null;
  content_hash: string;
  byte_length: number;
  media_type: string;
  provenance_ref: string;
  retention_class: string;
  payload_state: string;
  payload_pruned_at_ms: number | null;
  row_version: number;
  schema_authority_kind: string;
  schema_resource_hash: string | null;
  schema_plan_id: string | null;
  schema_plan_hash: string | null;
  generated_schema_ref: string | null;
  generated_schema_hash: string | null;
  generated_schema_generator: string | null;
  generated_schema_parameter_hash: string | null;
}

interface GeneratedContentRow extends Record<string, unknown> {
  schema_ref: string;
  schema_raw_hash: string;
  schema_hash: string;
  canonical_schema_json: string;
  canonicalizer: string;
  byte_length: number;
}

interface BindingRow extends Record<string, unknown> {
  plan_id: string;
  graph_run_id: string;
  plan_hash: string;
  schema_ref: string;
  schema_hash: string;
  generator: string;
  parameter_hash: string;
  binding_hash: string;
}

interface OwnershipRow extends Record<string, unknown> {
  value_id: string;
  owner_workflow_id: string | null;
  owner_graph_run_id: string | null;
  owner_registry_resource_id: string | null;
  owner_feature_release_id: string | null;
  system_owner_ref: string | null;
}

type QueryAuthority = Pick<
  WorkflowRuntimeStore | WorkflowRuntimeWriteTransaction,
  'queryOne' | 'queryAll'
>;

export class NodeOutputEnvelopeAuthorityError extends Error {
  constructor(
    readonly code:
      | 'plan_authority_invalid'
      | 'node_authority_invalid'
      | 'generated_schema_invalid'
      | 'binding_invalid'
      | 'envelope_invalid'
      | 'member_value_invalid'
      | 'stored_value_invalid'
      | 'ownership_invalid'
      | 'replay_conflict'
      | 'fault_injected',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'NodeOutputEnvelopeAuthorityError';
  }
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
    return value;
  } catch (error) {
    throw new NodeOutputEnvelopeAuthorityError(
      'envelope_invalid',
      `${label} must be a JSON object`,
      { cause: error },
    );
  }
}

function exactJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseCanonicalValue(bytes: string, label: string): JsonValue {
  const parsed = strictParseJsonBytes(Buffer.from(bytes, 'utf8'));
  if (canonicalJson(parsed) !== bytes) {
    throw new NodeOutputEnvelopeAuthorityError(
      'stored_value_invalid',
      `${label} is not exact RFC8785 canonical JSON`,
    );
  }
  return parsed;
}

function parseCanonicalObject(bytes: string, label: string): JsonObject {
  const parsed = parseCanonicalValue(bytes, label);
  assertJsonObject(parsed);
  return parsed;
}

function withoutPlanHash(plan: JsonObject): JsonObject {
  const result = structuredClone(plan);
  delete result.plan_hash;
  return result;
}

function findExactNode(plan: JsonObject, nodeId: string): JsonObject {
  if (!Array.isArray(plan.nodes)) {
    throw new NodeOutputEnvelopeAuthorityError(
      'plan_authority_invalid',
      'Sealed Plan nodes are missing',
    );
  }
  const matches = plan.nodes.filter((entry) => {
    assertJsonObject(entry);
    return entry.id === nodeId;
  });
  if (matches.length !== 1) {
    throw new NodeOutputEnvelopeAuthorityError(
      'node_authority_invalid',
      `Sealed Plan must contain exactly one node ${nodeId}`,
    );
  }
  return matches[0] as JsonObject;
}

function envelopeHash(portContractHash: Sha256Hash, ports: JsonObject): Sha256Hash {
  return domainSeparatedSha256(NODE_OUTPUT_ENVELOPE_DOMAIN, {
    port_contract_hash: portContractHash,
    ports,
  });
}

export function nodeOutputEnvelopeProvenanceRef(input: {
  planId: string;
  graphRunId: string;
  planHash: Sha256Hash;
  nodeId: string;
  schemaRef: string;
  schemaHash: Sha256Hash;
  parameterHash: Sha256Hash;
  portContractHash: Sha256Hash;
  envelopeHash: Sha256Hash;
}): string {
  return `icarus-node-output-envelope-provenance:${domainSeparatedSha256(
    NODE_OUTPUT_ENVELOPE_PROVENANCE_DOMAIN,
    {
      plan_id: input.planId,
      graph_run_id: input.graphRunId,
      plan_hash: input.planHash,
      node_id: input.nodeId,
      schema_ref: input.schemaRef,
      schema_hash: input.schemaHash,
      parameter_hash: input.parameterHash,
      port_contract_hash: input.portContractHash,
      envelope_hash: input.envelopeHash,
    },
  )}`;
}

export function nodeOutputMemberProvenanceRef(input: {
  planId: string;
  graphRunId: string;
  planHash: Sha256Hash;
  nodeId: string;
  portName: string;
  valueRef: string;
  valueHash: Sha256Hash;
  schemaHash: Sha256Hash;
  byteLength: number;
}): string {
  return `icarus-node-output-member-provenance:${domainSeparatedSha256(
    NODE_OUTPUT_MEMBER_PROVENANCE_DOMAIN,
    {
      plan_id: input.planId,
      graph_run_id: input.graphRunId,
      plan_hash: input.planHash,
      node_id: input.nodeId,
      port_name: input.portName,
      value_ref: input.valueRef,
      value_hash: input.valueHash,
      schema_hash: input.schemaHash,
      byte_length: input.byteLength,
    },
  )}`;
}

function readPlan(
  authority: QueryAuthority,
  input: Pick<NodeOutputEnvelopeWriteInput, 'planId' | 'graphRunId' | 'planHash'>,
): { row: PlanRow; plan: JsonObject } {
  const row = authority.queryOne<PlanRow>(
    `SELECT id, graph_run_id, plan_hash, format, compiler_version,
            compiled_plan_json
       FROM workflow_graph_scope_plans
      WHERE id = ?`,
    [input.planId],
  );
  if (
    !row ||
    row.graph_run_id !== input.graphRunId ||
    row.plan_hash !== input.planHash ||
    row.format !== 'icarus.workflow-graph-scope-plan/2' ||
    row.compiler_version !== '3.0.4' ||
    row.compiled_plan_json === null
  ) {
    throw new NodeOutputEnvelopeAuthorityError(
      'plan_authority_invalid',
      'Exact current sealed Plan row is missing or drifted',
    );
  }
  const plan = parseCanonicalObject(row.compiled_plan_json, 'Compiled Plan');
  if (
    plan.plan_hash !== input.planHash ||
    domainSeparatedSha256(PLAN_DOMAIN_SEPARATOR, withoutPlanHash(plan)) !==
      input.planHash
  ) {
    throw new NodeOutputEnvelopeAuthorityError(
      'plan_authority_invalid',
      'Compiled Plan canonical bytes do not reproduce plan_hash',
    );
  }
  return { row, plan };
}

function exactDescriptor(plan: JsonObject, nodeId: string): {
  node: JsonObject;
  outputPorts: JsonObject;
  descriptor: JsonObject;
} {
  const node = findExactNode(plan, nodeId);
  assertJsonObject(node.output_ports);
  const outputPorts = node.output_ports;
  const expected = buildNodeOutputEnvelopeSchema(nodeId, outputPorts);
  const descriptor = object(
    node.output_envelope_schema as JsonValue,
    'Node output envelope descriptor',
  );
  try {
    assertGeneratedSchemaAuthority(descriptor);
  } catch (error) {
    throw new NodeOutputEnvelopeAuthorityError(
      'generated_schema_invalid',
      'Node output envelope descriptor is incomplete or hash-invalid',
      { cause: error },
    );
  }
  if (!exactJson(descriptor, expected)) {
    throw new NodeOutputEnvelopeAuthorityError(
      'node_authority_invalid',
      'Node output envelope descriptor does not bind exact node output ports',
    );
  }
  return { node, outputPorts, descriptor };
}

function expectedEnvelope(
  outputPorts: JsonObject,
  ports: JsonObject,
): { content: JsonObject; portContractHash: Sha256Hash; hash: Sha256Hash } {
  const portContractHash = nodeOutputPortContractHash(outputPorts);
  const hash = envelopeHash(portContractHash, ports);
  return {
    portContractHash,
    hash,
    content: { port_contract_hash: portContractHash, ports, envelope_hash: hash },
  };
}

function validateDraft202012(schema: JsonValue, content: JsonObject): void {
  let validate: ReturnType<Ajv2020['compile']>;
  try {
    validate = new Ajv2020({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    }).compile(schema as AnySchema);
  } catch (error) {
    throw new NodeOutputEnvelopeAuthorityError(
      'generated_schema_invalid',
      'Node output envelope schema is not valid strict Draft 2020-12',
      { cause: error },
    );
  }
  if (!validate(content)) {
    throw new NodeOutputEnvelopeAuthorityError(
      'envelope_invalid',
      `Node output envelope fails Draft 2020-12: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function validateMemberValues(
  authority: QueryAuthority,
  context: {
    planId: string;
    graphRunId: string;
    planHash: Sha256Hash;
    nodeId: string;
    outputPorts: JsonObject;
    ports: JsonObject;
  },
): void {
  for (const [portName, portValue] of Object.entries(context.ports)) {
    assertJsonObject(portValue);
    if (portValue.state !== 'present') continue;
    const contract = object(
      context.outputPorts[portName] as JsonValue,
      `Compiled output port ${portName}`,
    );
    const schema = object(
      contract.schema as JsonValue,
      `Compiled output port ${portName} schema`,
    );
    const valueRef = String(portValue.value_ref);
    const valueHash = parseSha256Hash(portValue.value_hash);
    const schemaHash = parseSha256Hash(portValue.schema_hash);
    const byteLength = Number(portValue.byte_length);
    const row = authority.queryOne<StoredValueRow>(
      `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
              media_type, provenance_ref, retention_class, payload_state,
              payload_pruned_at_ms, row_version, schema_authority_kind,
              schema_resource_hash, schema_plan_id, schema_plan_hash,
              generated_schema_ref, generated_schema_hash,
              generated_schema_generator, generated_schema_parameter_hash
         FROM workflow_values WHERE id = ?`,
      [valueRef],
    );
    const ownership = authority.queryAll<OwnershipRow>(
      `SELECT value_id, owner_workflow_id, owner_graph_run_id,
              owner_registry_resource_id, owner_feature_release_id,
              system_owner_ref
         FROM workflow_value_ownerships WHERE value_id = ?`,
      [valueRef],
    );
    const expectedProvenance = nodeOutputMemberProvenanceRef({
      planId: context.planId,
      graphRunId: context.graphRunId,
      planHash: context.planHash,
      nodeId: context.nodeId,
      portName,
      valueRef,
      valueHash,
      schemaHash,
      byteLength,
    });
    if (
      !row ||
      row.storage_kind !== 'inline' ||
      row.content_hash !== valueHash ||
      row.byte_length !== byteLength ||
      row.inline_canonical_json === null ||
      Buffer.byteLength(row.inline_canonical_json, 'utf8') !== byteLength ||
      row.payload_state !== 'live' ||
      row.payload_pruned_at_ms !== null ||
      row.row_version !== 0 ||
      row.media_type !== 'application/json' ||
      (row.generated_schema_hash ?? row.schema_resource_hash) !== schemaHash ||
      schema.schema_hash !== schemaHash ||
      row.provenance_ref !== expectedProvenance ||
      ownership.length !== 1 ||
      ownership[0]!.owner_graph_run_id !== context.graphRunId ||
      ownership[0]!.owner_workflow_id !== null ||
      ownership[0]!.owner_registry_resource_id !== null ||
      ownership[0]!.owner_feature_release_id !== null ||
      ownership[0]!.system_owner_ref !== null
    ) {
      throw new NodeOutputEnvelopeAuthorityError(
        'member_value_invalid',
        `Present member Value ${portName} authority drifted`,
      );
    }
    parseCanonicalValue(row.inline_canonical_json, `Member Value ${portName}`);
  }
}

function verifyContentAndBinding(
  authority: QueryAuthority,
  input: NodeOutputEnvelopeWriteInput,
  descriptor: JsonObject,
): void {
  const content = authority.queryOne<GeneratedContentRow>(
    `SELECT schema_ref, schema_raw_hash, schema_hash, canonical_schema_json,
            canonicalizer, byte_length
       FROM workflow_generated_schema_contents WHERE schema_ref = ?`,
    [String(descriptor.schema_ref)],
  );
  const schemaBytes = canonicalJson(descriptor.schema_json);
  if (
    !content ||
    content.schema_raw_hash !== descriptor.schema_raw_hash ||
    content.schema_hash !== descriptor.schema_hash ||
    content.canonical_schema_json !== schemaBytes ||
    content.canonicalizer !== descriptor.canonicalizer ||
    content.byte_length !== descriptor.schema_byte_length
  ) {
    throw new NodeOutputEnvelopeAuthorityError(
      'generated_schema_invalid',
      'Persisted generated schema content drifted',
    );
  }
  const binding = buildPlanGeneratedSchemaBinding(
    {
      plan_id: input.planId,
      graph_run_id: input.graphRunId,
      plan_hash: input.planHash,
    },
    descriptor,
  );
  assertPlanGeneratedSchemaBinding(binding);
  const row = authority.queryOne<BindingRow>(
    `SELECT plan_id, graph_run_id, plan_hash, schema_ref, schema_hash,
            generator, parameter_hash, binding_hash
       FROM workflow_plan_generated_schemas
      WHERE plan_id = ? AND schema_ref = ? AND generator = ?
        AND parameter_hash = ?`,
    [
      input.planId,
      String(descriptor.schema_ref),
      'node_output_envelope',
      String(descriptor.parameter_hash),
    ],
  );
  if (!row || !exactJson(row as unknown as JsonObject, binding)) {
    throw new NodeOutputEnvelopeAuthorityError(
      'binding_invalid',
      'Exact Plan generated schema binding drifted',
    );
  }
}

function verifyStoredEnvelope(
  authority: QueryAuthority,
  input: NodeOutputEnvelopeWriteInput,
  row: StoredValueRow,
): NodeOutputEnvelopeValue {
  const { plan } = readPlan(authority, input);
  const { outputPorts, descriptor } = exactDescriptor(plan, input.nodeId);
  verifyContentAndBinding(authority, input, descriptor);
  if (row.inline_canonical_json === null) {
    throw new NodeOutputEnvelopeAuthorityError(
      'stored_value_invalid',
      'Node output envelope payload is not inline',
    );
  }
  const content = parseCanonicalObject(
    row.inline_canonical_json,
    'Node output envelope Value',
  );
  const ports = object(content.ports as JsonValue, 'Node output envelope ports');
  const expected = expectedEnvelope(outputPorts, ports);
  validateDraft202012(descriptor.schema_json, content);
  const provenanceRef = nodeOutputEnvelopeProvenanceRef({
    planId: input.planId,
    graphRunId: input.graphRunId,
    planHash: input.planHash,
    nodeId: input.nodeId,
    schemaRef: String(descriptor.schema_ref),
    schemaHash: parseSha256Hash(descriptor.schema_hash),
    parameterHash: parseSha256Hash(descriptor.parameter_hash),
    portContractHash: expected.portContractHash,
    envelopeHash: expected.hash,
  });
  if (
    !exactJson(content, expected.content) ||
    row.storage_kind !== 'inline' ||
    row.content_hash !== expected.hash ||
    row.byte_length !== Buffer.byteLength(row.inline_canonical_json, 'utf8') ||
    row.media_type !== 'application/json' ||
    row.provenance_ref !== provenanceRef ||
    row.retention_class !== 'run_recovery' ||
    row.payload_state !== 'live' ||
    row.payload_pruned_at_ms !== null ||
    row.row_version !== 0 ||
    row.schema_authority_kind !== 'plan_generated' ||
    row.schema_plan_id !== input.planId ||
    row.schema_plan_hash !== input.planHash ||
    row.generated_schema_ref !== descriptor.schema_ref ||
    row.generated_schema_hash !== descriptor.schema_hash ||
    row.generated_schema_generator !== 'node_output_envelope' ||
    row.generated_schema_parameter_hash !== descriptor.parameter_hash
  ) {
    throw new NodeOutputEnvelopeAuthorityError(
      'stored_value_invalid',
      'Node output envelope Stored Value authority drifted',
    );
  }
  const ownership = authority.queryAll<OwnershipRow>(
    `SELECT value_id, owner_workflow_id, owner_graph_run_id,
            owner_registry_resource_id, owner_feature_release_id,
            system_owner_ref
       FROM workflow_value_ownerships WHERE value_id = ?`,
    [row.id],
  );
  if (
    ownership.length !== 1 ||
    ownership[0]!.owner_graph_run_id !== input.graphRunId ||
    ownership[0]!.owner_workflow_id !== null ||
    ownership[0]!.owner_registry_resource_id !== null ||
    ownership[0]!.owner_feature_release_id !== null ||
    ownership[0]!.system_owner_ref !== null
  ) {
    throw new NodeOutputEnvelopeAuthorityError(
      'ownership_invalid',
      'Node output envelope ownership must be exact graph-run ownership',
    );
  }
  validateMemberValues(authority, {
    ...input,
    outputPorts,
    ports,
  });
  return {
    valueId: row.id,
    planId: input.planId,
    graphRunId: input.graphRunId,
    planHash: input.planHash,
    nodeId: input.nodeId,
    schemaRef: String(descriptor.schema_ref),
    schemaHash: parseSha256Hash(descriptor.schema_hash),
    parameterHash: parseSha256Hash(descriptor.parameter_hash),
    portContractHash: expected.portContractHash,
    envelopeHash: expected.hash,
    byteLength: row.byte_length,
    provenanceRef,
    content,
  };
}

function readStoredValue(
  authority: QueryAuthority,
  valueId: string,
): StoredValueRow | undefined {
  return authority.queryOne<StoredValueRow>(
    `SELECT id, storage_kind, inline_canonical_json, content_hash, byte_length,
            media_type, provenance_ref, retention_class, payload_state,
            payload_pruned_at_ms, row_version, schema_authority_kind,
            schema_resource_hash, schema_plan_id, schema_plan_hash,
            generated_schema_ref, generated_schema_hash,
            generated_schema_generator, generated_schema_parameter_hash
       FROM workflow_values WHERE id = ?`,
    [valueId],
  );
}

function fault(input: NodeOutputEnvelopeWriteInput, stage: NodeOutputEnvelopeFaultStage): void {
  if (input.faultAt === stage) {
    throw new NodeOutputEnvelopeAuthorityError(
      'fault_injected',
      `Node output envelope fault injected ${stage}`,
    );
  }
}

export class NodeOutputEnvelopeValueStore {
  constructor(private readonly store: WorkflowRuntimeStore) {}

  write(input: NodeOutputEnvelopeWriteInput): NodeOutputEnvelopeValue {
    return this.store.withImmediateTransaction((transaction) => {
      const { plan } = readPlan(transaction, input);
      const { outputPorts, descriptor } = exactDescriptor(plan, input.nodeId);
      const expected = expectedEnvelope(outputPorts, input.ports);
      validateDraft202012(descriptor.schema_json, expected.content);
      validateMemberValues(transaction, {
        ...input,
        outputPorts,
        ports: input.ports,
      });
      const schemaBytes = canonicalJson(descriptor.schema_json);
      transaction.execute(
        `INSERT OR IGNORE INTO workflow_generated_schema_contents (
           schema_ref, schema_raw_hash, schema_hash, canonical_schema_json,
           canonicalizer, byte_length, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(descriptor.schema_ref),
          String(descriptor.schema_raw_hash),
          String(descriptor.schema_hash),
          schemaBytes,
          String(descriptor.canonicalizer),
          Number(descriptor.schema_byte_length),
          input.createdAtMs,
        ],
      );
      fault(input, 'after_content');
      const binding = buildPlanGeneratedSchemaBinding(
        {
          plan_id: input.planId,
          graph_run_id: input.graphRunId,
          plan_hash: input.planHash,
        },
        descriptor,
      );
      transaction.execute(
        `INSERT OR IGNORE INTO workflow_plan_generated_schemas (
           plan_id, graph_run_id, plan_hash, schema_ref, schema_hash,
           generator, parameter_hash, binding_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.planId,
          input.graphRunId,
          input.planHash,
          String(descriptor.schema_ref),
          String(descriptor.schema_hash),
          'node_output_envelope',
          String(descriptor.parameter_hash),
          String(binding.binding_hash),
          input.createdAtMs,
        ],
      );
      fault(input, 'after_binding');
      const canonicalBytes = canonicalJson(expected.content);
      const provenanceRef = nodeOutputEnvelopeProvenanceRef({
        planId: input.planId,
        graphRunId: input.graphRunId,
        planHash: input.planHash,
        nodeId: input.nodeId,
        schemaRef: String(descriptor.schema_ref),
        schemaHash: parseSha256Hash(descriptor.schema_hash),
        parameterHash: parseSha256Hash(descriptor.parameter_hash),
        portContractHash: expected.portContractHash,
        envelopeHash: expected.hash,
      });
      transaction.execute(
        `INSERT OR IGNORE INTO workflow_values (
           id, storage_kind, inline_canonical_json, blob_hash,
           immutable_external_locator, expected_hash, content_hash,
           byte_length, media_type, schema_resource_id, schema_resource_hash,
           provenance_ref, retention_class, payload_state,
           payload_pruned_at_ms, created_at_ms, row_version,
           schema_authority_kind, schema_plan_id, schema_plan_hash,
           generated_schema_ref, generated_schema_hash,
           generated_schema_generator, generated_schema_parameter_hash
         ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
                   NULL, NULL, ?, 'run_recovery', 'live', NULL, ?, 0,
                   'plan_generated', ?, ?, ?, ?, 'node_output_envelope', ?)`,
        [
          input.valueId,
          canonicalBytes,
          expected.hash,
          Buffer.byteLength(canonicalBytes, 'utf8'),
          provenanceRef,
          input.createdAtMs,
          input.planId,
          input.planHash,
          String(descriptor.schema_ref),
          String(descriptor.schema_hash),
          String(descriptor.parameter_hash),
        ],
      );
      fault(input, 'after_value');
      transaction.execute(
        `INSERT OR IGNORE INTO workflow_value_ownerships (
           value_id, owner_workflow_id, owner_graph_run_id,
           owner_registry_resource_id, owner_feature_release_id,
           system_owner_ref, created_at_ms
         ) VALUES (?, NULL, ?, NULL, NULL, NULL, ?)`,
        [input.valueId, input.graphRunId, input.createdAtMs],
      );
      fault(input, 'after_ownership');
      const row = readStoredValue(transaction, input.valueId);
      if (!row) {
        throw new NodeOutputEnvelopeAuthorityError(
          'replay_conflict',
          'Node output envelope write did not produce an exact Value',
        );
      }
      return verifyStoredEnvelope(transaction, input, row);
    });
  }

  read(input: Omit<NodeOutputEnvelopeWriteInput, 'ports' | 'createdAtMs' | 'faultAt'>): NodeOutputEnvelopeValue {
    const row = readStoredValue(this.store, input.valueId);
    if (!row) {
      throw new NodeOutputEnvelopeAuthorityError(
        'stored_value_invalid',
        `Node output envelope Value ${input.valueId} is missing`,
      );
    }
    return verifyStoredEnvelope(
      this.store,
      { ...input, ports: {}, createdAtMs: 0 },
      row,
    );
  }

  verifyReopenAndRecovery(): readonly NodeOutputEnvelopeValue[] {
    const rows = this.store.queryAll<
      StoredValueRow & { node_id: string; graph_run_id: string }
    >(
      `SELECT v.id, v.storage_kind, v.inline_canonical_json, v.content_hash,
              v.byte_length, v.media_type, v.provenance_ref,
              v.retention_class, v.payload_state, v.payload_pruned_at_ms,
              v.row_version, v.schema_authority_kind,
              v.schema_resource_hash, v.schema_plan_id, v.schema_plan_hash,
              v.generated_schema_ref, v.generated_schema_hash,
              v.generated_schema_generator,
              v.generated_schema_parameter_hash, p.graph_run_id,
              json_extract(p.compiled_plan_json, '$.nodes[' ||
                (SELECT key FROM json_each(p.compiled_plan_json, '$.nodes')
                  WHERE json_extract(value, '$.output_envelope_schema.schema_ref') =
                        v.generated_schema_ref
                    AND json_extract(value, '$.output_envelope_schema.parameter_hash') =
                        v.generated_schema_parameter_hash LIMIT 1) || '].id') AS node_id
         FROM workflow_values v
         JOIN workflow_graph_scope_plans p ON p.id = v.schema_plan_id
        WHERE v.generated_schema_generator = 'node_output_envelope'
        ORDER BY v.id`,
      [],
    );
    return rows.map((row) => {
      if (typeof row.node_id !== 'string' || row.node_id.length === 0) {
        throw new NodeOutputEnvelopeAuthorityError(
          'node_authority_invalid',
          `Recovery cannot resolve envelope node for ${row.id}`,
        );
      }
      return verifyStoredEnvelope(
        this.store,
        {
          planId: String(row.schema_plan_id),
          graphRunId: row.graph_run_id,
          planHash: parseSha256Hash(row.schema_plan_hash),
          nodeId: row.node_id,
          valueId: row.id,
          ports: {},
          createdAtMs: 0,
        },
        row,
      );
    });
  }
}
