import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import {
  assertGeneratedSchemaAuthority,
  buildPlanGeneratedSchemaBinding,
  generatedSchemaParameterHash,
  type GeneratedSchemaGenerator,
} from '../contracts/generated-schema-authority.js';
import {
  G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN,
  G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN,
} from '../contracts/g5-basic-runtime-repair-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeWriteTransaction } from '../store/runtime-store/index.js';
import { validateCompiledInputValue } from './fixed-point-authority.js';
import {
  G5RuntimeError,
  insertInlineValue,
  runtimeObjectHash,
  stableRuntimeId,
  type InlineValueSchemaAuthority,
} from './graph-store.js';

export interface PersistedPlanIdentity {
  readonly planId: string;
  readonly graphRunId: string;
  readonly planHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
}

export interface PlanGeneratedValueAuthority {
  readonly kind: 'plan_generated';
  readonly planId: string;
  readonly planHash: Sha256Hash;
  readonly schemaRef: string;
  readonly schemaHash: Sha256Hash;
  readonly generator: GeneratedSchemaGenerator;
  readonly parameterHash: Sha256Hash;
}

export type PublishedNodeOutputPort =
  | {
      readonly state: 'present';
      readonly value_ref: string;
      readonly value_hash: Sha256Hash;
      readonly schema_hash: Sha256Hash;
      readonly byte_length: number;
    }
  | {
      readonly state: 'absent';
      readonly schema_hash: Sha256Hash;
    };

export interface PersistedNodeOutputEnvelope {
  readonly id: string;
  readonly hash: Sha256Hash;
  readonly portContractHash: Sha256Hash;
  readonly envelope: JsonObject;
}

function fail(message: string): never {
  throw new G5RuntimeError('integrity_violation', message);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is not an object`);
  return value as JsonObject;
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameKeys(left: JsonObject, right: JsonObject): boolean {
  const leftKeys = Object.keys(left).sort(ascii);
  const rightKeys = Object.keys(right).sort(ascii);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function assertGenerated(value: JsonObject, label: string): void {
  try {
    assertGeneratedSchemaAuthority(value);
  } catch (error) {
    throw new G5RuntimeError(
      'integrity_violation',
      `${label} generated schema authority is invalid`,
      { cause: error },
    );
  }
}

function compiledSchemas(plan: CompiledScopePlanV2Document): JsonObject[] {
  const schemas: JsonObject[] = [];
  for (const node of plan.nodes as JsonObject[]) {
    for (const contractValue of Object.values(
      object(
        node.input_ports ?? {},
        `Plan node ${String(node.id)} input_ports`,
      ),
    )) {
      const contract = object(contractValue, 'Plan input port contract');
      schemas.push(object(contract.schema, 'Plan input port schema'));
      if (contract.item_schema !== undefined)
        schemas.push(object(contract.item_schema, 'Plan list item schema'));
    }
    for (const contractValue of Object.values(
      object(
        node.output_ports ?? {},
        `Plan node ${String(node.id)} output_ports`,
      ),
    )) {
      const contract = object(contractValue, 'Plan output port contract');
      schemas.push(object(contract.schema, 'Plan output port schema'));
    }
  }
  for (const edge of plan.data_edges as JsonObject[])
    schemas.push(object(edge.derived_schema, 'Plan data edge derived_schema'));
  return schemas;
}

function generatedKey(schema: JsonObject): string {
  return canonicalJson({
    schema_ref: schema.schema_ref as JsonValue,
    schema_hash: schema.schema_hash as JsonValue,
    generator: schema.generator as JsonValue,
    parameter_hash: schema.parameter_hash as JsonValue,
  });
}

function generatedContentKey(schema: JsonObject): string {
  return canonicalJson({
    schema_ref: schema.schema_ref as JsonValue,
    schema_raw_hash: schema.schema_raw_hash as JsonValue,
    schema_hash: schema.schema_hash as JsonValue,
    canonicalizer: schema.canonicalizer as JsonValue,
    schema_byte_length: schema.schema_byte_length as JsonValue,
    schema_json: schema.schema_json as JsonValue,
  });
}

export function collectPlanGeneratedSchemas(
  plan: CompiledScopePlanV2Document,
): JsonObject[] {
  const byBinding = new Map<string, JsonObject>();
  const byRef = new Map<string, JsonObject>();
  for (const schema of compiledSchemas(plan)) {
    if (schema.type === 'registry') continue;
    if (schema.type !== 'generated')
      fail(`Compiled schema type is unsupported: ${String(schema.type)}`);
    assertGenerated(schema, 'Plan');
    const ref = String(schema.schema_ref);
    const priorRef = byRef.get(ref);
    if (
      priorRef &&
      generatedContentKey(priorRef) !== generatedContentKey(schema)
    )
      fail(`Generated schema ref has moving content: ${ref}`);
    byRef.set(ref, schema);
    const key = generatedKey(schema);
    const prior = byBinding.get(key);
    if (prior && canonicalJson(prior) !== canonicalJson(schema))
      fail(`Generated schema binding tuple drifted: ${ref}`);
    byBinding.set(key, schema);
  }
  return [...byBinding.values()].sort((left, right) =>
    ascii(generatedKey(left), generatedKey(right)),
  );
}

function validateJoinAuthority(
  plan: CompiledScopePlanV2Document,
  node: JsonObject,
  resolveRegistrySchema?: (
    compiledSchema: JsonObject,
    label: string,
  ) => JsonObject,
): void {
  const expose = object(node.expose ?? {}, `Join ${String(node.id)} expose`);
  const outputs = object(
    node.output_ports ?? {},
    `Join ${String(node.id)} output_ports`,
  );
  if (!sameKeys(expose, outputs))
    fail(`Join ${String(node.id)} expose/output port shape mismatch`);
  const inputs = object(
    node.input_ports ?? {},
    `Join ${String(node.id)} input_ports`,
  );
  for (const outputName of Object.keys(expose).sort(ascii)) {
    const exposure = object(expose[outputName], `Join expose ${outputName}`);
    const inputName = String(exposure.input_port);
    const input = object(inputs[inputName], `Join input ${inputName}`);
    const output = object(outputs[outputName], `Join output ${outputName}`);
    const inputSchema = object(input.schema, `Join input ${inputName} schema`);
    const aggregation = object(
      input.aggregation,
      `Join input ${inputName} aggregation`,
    );
    const outputSchema = object(
      output.schema,
      `Join output ${outputName} schema`,
    );
    assertGenerated(outputSchema, `Join output ${outputName}`);
    if (outputSchema.generator !== 'join_expose')
      fail(`Join output ${outputName} has the wrong generator`);
    const required =
      aggregation.type === 'list' ||
      aggregation.required === true ||
      Object.prototype.hasOwnProperty.call(aggregation, 'default');
    const parameters: JsonObject = {
      node_id: node.id as JsonValue,
      output_port: outputName,
      input_port: inputName,
      input_schema: inputSchema,
      aggregation,
      max_bytes: input.max_bytes as JsonValue,
      required,
      ...(aggregation.type === 'list'
        ? {
            item_schema: object(
              input.item_schema,
              `Join input ${inputName} item_schema`,
            ),
            item_max_bytes: input.item_max_bytes as JsonValue,
          }
        : {}),
    };
    if (
      output.max_bytes !== input.max_bytes ||
      output.required !== required ||
      outputSchema.parameter_hash !==
        generatedSchemaParameterHash('join_expose', parameters)
    )
      fail(`Join output ${outputName} contract or parameter binding drifted`);
    if (resolveRegistrySchema) {
      const inputSchemaJson = resolveRegistrySchema(
        inputSchema,
        `Join input ${inputName}`,
      );
      if (
        canonicalJson(inputSchemaJson) !==
        canonicalJson(outputSchema.schema_json)
      )
        fail(`Join output ${outputName} schema authority mismatches its input`);
    }
    for (const edge of plan.data_edges as JsonObject[]) {
      const from = object(edge.from, `Plan data edge ${String(edge.id)} from`);
      if (
        from.type !== 'node_output' ||
        from.node_id !== node.id ||
        from.port !== outputName
      )
        continue;
      const proof = object(
        edge.compatibility_proof,
        `Plan data edge ${String(edge.id)} compatibility_proof`,
      );
      if (
        edge.producer_schema_hash !== outputSchema.schema_hash ||
        proof.producer_schema_hash !== outputSchema.schema_hash ||
        typeof proof.proof_hash !== 'string'
      )
        fail(`Join downstream edge ${String(edge.id)} proof binding drifted`);
      const direct =
        (from.pointer === undefined ||
          from.pointer === null ||
          from.pointer === '') &&
        (edge.canonical_pointer === undefined ||
          edge.canonical_pointer === null);
      if (
        direct &&
        canonicalJson(
          object(edge.derived_schema, 'Join edge derived schema'),
        ) !== canonicalJson(outputSchema)
      )
        fail(`Join downstream edge ${String(edge.id)} direct schema drifted`);
    }
  }
}

export function assertCurrentPlanGeneratedSchemaAuthority(
  plan: CompiledScopePlanV2Document,
  resolveRegistrySchema?: (
    compiledSchema: JsonObject,
    label: string,
  ) => JsonObject,
): JsonObject[] {
  const schemas = collectPlanGeneratedSchemas(plan);
  for (const node of plan.nodes as JsonObject[])
    if (node.type === 'join')
      validateJoinAuthority(plan, node, resolveRegistrySchema);
  return schemas;
}

function expectedBinding(
  identity: PersistedPlanIdentity,
  schema: JsonObject,
): JsonObject {
  return buildPlanGeneratedSchemaBinding(
    {
      plan_id: identity.planId,
      graph_run_id: identity.graphRunId,
      plan_hash: identity.planHash,
    },
    schema,
  );
}

function assertPlanRow(
  transaction: WorkflowRuntimeWriteTransaction,
  identity: PersistedPlanIdentity,
): void {
  const row = transaction.queryOne<{
    graph_run_id: string;
    plan_hash: string;
    compiled_plan_json: string | null;
  }>(
    'SELECT graph_run_id, plan_hash, compiled_plan_json FROM workflow_graph_scope_plans WHERE id = ?',
    [identity.planId],
  );
  if (
    !row ||
    row.graph_run_id !== identity.graphRunId ||
    row.plan_hash !== identity.planHash ||
    row.compiled_plan_json !== canonicalJson(identity.plan)
  )
    fail('Persisted sealed Plan bytes/hash binding drifted');
}

export function persistPlanGeneratedSchemaAuthorities(
  transaction: WorkflowRuntimeWriteTransaction,
  identity: PersistedPlanIdentity,
  nowMs: number,
  resolveRegistrySchema: (
    compiledSchema: JsonObject,
    label: string,
  ) => JsonObject,
): void {
  assertPlanRow(transaction, identity);
  const schemas = assertCurrentPlanGeneratedSchemaAuthority(
    identity.plan,
    resolveRegistrySchema,
  );
  for (const schema of schemas) {
    const canonicalSchema = canonicalJson(schema.schema_json as JsonValue);
    const content = transaction.queryOne<{
      schema_raw_hash: string;
      schema_hash: string;
      canonical_schema_json: string;
      canonicalizer: string;
      byte_length: number;
    }>(
      'SELECT schema_raw_hash, schema_hash, canonical_schema_json, canonicalizer, byte_length FROM workflow_generated_schema_contents WHERE schema_ref = ?',
      [String(schema.schema_ref)],
    );
    if (content) {
      if (
        content.schema_raw_hash !== schema.schema_raw_hash ||
        content.schema_hash !== schema.schema_hash ||
        content.canonical_schema_json !== canonicalSchema ||
        content.canonicalizer !== schema.canonicalizer ||
        content.byte_length !== schema.schema_byte_length
      )
        fail(
          `Persisted generated schema content drifted: ${String(schema.schema_ref)}`,
        );
    } else {
      transaction.execute(
        `INSERT INTO workflow_generated_schema_contents (
           schema_ref, schema_raw_hash, schema_hash, canonical_schema_json,
           canonicalizer, byte_length, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(schema.schema_ref),
          String(schema.schema_raw_hash),
          String(schema.schema_hash),
          canonicalSchema,
          String(schema.canonicalizer),
          Number(schema.schema_byte_length),
          nowMs,
        ],
      );
    }
    const binding = expectedBinding(identity, schema);
    const existing = transaction.queryOne<{
      graph_run_id: string;
      plan_hash: string;
      schema_hash: string;
      binding_hash: string;
    }>(
      `SELECT graph_run_id, plan_hash, schema_hash, binding_hash
         FROM workflow_plan_generated_schemas
        WHERE plan_id = ? AND schema_ref = ? AND generator = ? AND parameter_hash = ?`,
      [
        identity.planId,
        String(schema.schema_ref),
        String(schema.generator),
        String(schema.parameter_hash),
      ],
    );
    if (existing) {
      if (
        existing.graph_run_id !== identity.graphRunId ||
        existing.plan_hash !== identity.planHash ||
        existing.schema_hash !== schema.schema_hash ||
        existing.binding_hash !== binding.binding_hash
      )
        fail(
          `Persisted Plan generated schema binding drifted: ${String(schema.schema_ref)}`,
        );
    } else {
      transaction.execute(
        `INSERT INTO workflow_plan_generated_schemas (
           plan_id, graph_run_id, plan_hash, schema_ref, schema_hash,
           generator, parameter_hash, binding_hash, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          identity.planId,
          identity.graphRunId,
          identity.planHash,
          String(schema.schema_ref),
          String(schema.schema_hash),
          String(schema.generator),
          String(schema.parameter_hash),
          String(binding.binding_hash),
          nowMs,
        ],
      );
    }
  }
  verifyPersistedPlanGeneratedSchemaAuthorities(transaction, identity);
}

export function verifyPersistedPlanGeneratedSchemaAuthorities(
  transaction: WorkflowRuntimeWriteTransaction,
  identity: PersistedPlanIdentity,
): void {
  assertPlanRow(transaction, identity);
  const schemas = assertCurrentPlanGeneratedSchemaAuthority(identity.plan);
  const expected = schemas.map((schema) => expectedBinding(identity, schema));
  const observed = transaction.queryAll<{
    schema_ref: string;
    schema_hash: string;
    generator: string;
    parameter_hash: string;
    binding_hash: string;
  }>(
    `SELECT schema_ref, schema_hash, generator, parameter_hash, binding_hash
       FROM workflow_plan_generated_schemas
      WHERE plan_id = ?
      ORDER BY schema_ref COLLATE BINARY, generator COLLATE BINARY,
               parameter_hash COLLATE BINARY`,
    [identity.planId],
  );
  const expectedRows = expected
    .map((binding) => ({
      schema_ref: String(binding.schema_ref),
      schema_hash: String(binding.schema_hash),
      generator: String(binding.generator),
      parameter_hash: String(binding.parameter_hash),
      binding_hash: String(binding.binding_hash),
    }))
    .sort((left, right) =>
      ascii(
        `${left.schema_ref}\0${left.generator}\0${left.parameter_hash}`,
        `${right.schema_ref}\0${right.generator}\0${right.parameter_hash}`,
      ),
    );
  if (canonicalJson(observed) !== canonicalJson(expectedRows))
    fail('Persisted Plan generated schema binding set drifted');
  for (const schema of schemas) {
    const row = transaction.queryOne<{
      schema_raw_hash: string;
      schema_hash: string;
      canonical_schema_json: string;
      canonicalizer: string;
      byte_length: number;
    }>(
      'SELECT schema_raw_hash, schema_hash, canonical_schema_json, canonicalizer, byte_length FROM workflow_generated_schema_contents WHERE schema_ref = ?',
      [String(schema.schema_ref)],
    );
    if (
      !row ||
      row.schema_raw_hash !== schema.schema_raw_hash ||
      row.schema_hash !== schema.schema_hash ||
      row.canonical_schema_json !==
        canonicalJson(schema.schema_json as JsonValue) ||
      row.canonicalizer !== schema.canonicalizer ||
      row.byte_length !== schema.schema_byte_length
    )
      fail(
        `Persisted generated schema bytes/hash drifted: ${String(schema.schema_ref)}`,
      );
  }
}

export function loadPersistedPlanGeneratedSchemaAuthority(
  transaction: WorkflowRuntimeWriteTransaction,
  identity: PersistedPlanIdentity,
  compiledSchema: JsonObject,
  label: string,
): {
  readonly schema: JsonObject;
  readonly authority: PlanGeneratedValueAuthority;
} {
  assertGenerated(compiledSchema, label);
  verifyPersistedPlanGeneratedSchemaAuthorities(transaction, identity);
  const match = collectPlanGeneratedSchemas(identity.plan).find(
    (candidate) => canonicalJson(candidate) === canonicalJson(compiledSchema),
  );
  if (!match) fail(`${label} is not embedded in the exact persisted Plan`);
  const row = transaction.queryOne<{
    canonical_schema_json: string;
    schema_hash: string;
    binding_hash: string;
  }>(
    `SELECT c.canonical_schema_json, c.schema_hash, b.binding_hash
       FROM workflow_plan_generated_schemas b
       JOIN workflow_generated_schema_contents c
         ON c.schema_ref = b.schema_ref AND c.schema_hash = b.schema_hash
      WHERE b.plan_id = ? AND b.plan_hash = ? AND b.schema_ref = ?
        AND b.schema_hash = ? AND b.generator = ? AND b.parameter_hash = ?`,
    [
      identity.planId,
      identity.planHash,
      String(compiledSchema.schema_ref),
      String(compiledSchema.schema_hash),
      String(compiledSchema.generator),
      String(compiledSchema.parameter_hash),
    ],
  );
  const binding = expectedBinding(identity, compiledSchema);
  if (
    !row ||
    row.binding_hash !== binding.binding_hash ||
    row.schema_hash !== compiledSchema.schema_hash ||
    row.canonical_schema_json !==
      canonicalJson(compiledSchema.schema_json as JsonValue)
  )
    fail(`${label} persisted Plan/generated schema pair is missing or drifted`);
  return {
    schema: object(
      JSON.parse(row.canonical_schema_json),
      `${label} persisted generated schema`,
    ),
    authority: {
      kind: 'plan_generated',
      planId: identity.planId,
      planHash: identity.planHash,
      schemaRef: String(compiledSchema.schema_ref),
      schemaHash: String(compiledSchema.schema_hash) as Sha256Hash,
      generator: String(compiledSchema.generator) as GeneratedSchemaGenerator,
      parameterHash: String(compiledSchema.parameter_hash) as Sha256Hash,
    },
  };
}

export function nodeOutputPortContractHash(
  outputPorts: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(
    G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN,
    outputPorts,
  );
}

export function buildCanonicalNodeOutputEnvelope(
  outputPorts: JsonObject,
  publishedPorts: Readonly<Record<string, PublishedNodeOutputPort>>,
): JsonObject {
  const actualPorts = publishedPorts as unknown as JsonObject;
  if (!sameKeys(outputPorts, actualPorts))
    fail('Node output envelope does not cover the exact compiled port set');
  for (const portName of Object.keys(outputPorts).sort(ascii)) {
    const contract = object(outputPorts[portName], `Output port ${portName}`);
    const schema = object(contract.schema, `Output port ${portName} schema`);
    const published = object(
      actualPorts[portName],
      `Published port ${portName}`,
    );
    if (
      published.schema_hash !== schema.schema_hash ||
      (contract.required === true && published.state !== 'present') ||
      !['present', 'absent'].includes(String(published.state))
    )
      fail(`Published output port ${portName} violates its compiled contract`);
  }
  const withoutHash: JsonObject = {
    port_contract_hash: nodeOutputPortContractHash(outputPorts),
    ports: actualPorts,
  };
  return {
    ...withoutHash,
    envelope_hash: domainSeparatedSha256(
      G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN,
      withoutHash,
    ),
  };
}

interface ExactInlineValue {
  readonly content: JsonValue;
  readonly byteLength: number;
  readonly schemaHash: Sha256Hash;
  readonly authority: InlineValueSchemaAuthority;
}

function exactInlineValue(
  transaction: WorkflowRuntimeWriteTransaction,
  valueId: string,
  valueHash: Sha256Hash,
  label: string,
): ExactInlineValue {
  const row = transaction.queryOne<{
    storage_kind: string;
    inline_canonical_json: string | null;
    content_hash: string;
    byte_length: number;
    payload_state: string;
    schema_authority_kind: string;
    schema_resource_id: string | null;
    schema_resource_hash: string | null;
    schema_plan_id: string | null;
    schema_plan_hash: string | null;
    generated_schema_ref: string | null;
    generated_schema_hash: string | null;
    generated_schema_generator: string | null;
    generated_schema_parameter_hash: string | null;
  }>(
    `SELECT storage_kind, inline_canonical_json, content_hash, byte_length,
            payload_state, schema_authority_kind, schema_resource_id,
            schema_resource_hash, schema_plan_id, schema_plan_hash,
            generated_schema_ref, generated_schema_hash,
            generated_schema_generator, generated_schema_parameter_hash
       FROM workflow_values WHERE id = ? AND content_hash = ?`,
    [valueId, valueHash],
  );
  if (
    !row ||
    row.storage_kind !== 'inline' ||
    row.inline_canonical_json === null ||
    row.payload_state !== 'live'
  )
    fail(`${label} exact inline Value is missing`);
  let content: JsonValue;
  try {
    content = JSON.parse(row.inline_canonical_json) as JsonValue;
  } catch {
    fail(`${label} inline Value is not canonical JSON`);
  }
  if (
    canonicalJson(content) !== row.inline_canonical_json ||
    Buffer.byteLength(row.inline_canonical_json, 'utf8') !== row.byte_length
  )
    fail(`${label} inline Value bytes drifted`);
  if (
    row.schema_authority_kind === 'registry' &&
    row.schema_resource_id !== null &&
    row.schema_resource_hash !== null &&
    row.schema_plan_id === null &&
    row.schema_plan_hash === null &&
    row.generated_schema_ref === null &&
    row.generated_schema_hash === null &&
    row.generated_schema_generator === null &&
    row.generated_schema_parameter_hash === null
  )
    return {
      content,
      byteLength: row.byte_length,
      schemaHash: row.schema_resource_hash as Sha256Hash,
      authority: {
        kind: 'registry',
        resourceId: row.schema_resource_id,
        resourceHash: row.schema_resource_hash as Sha256Hash,
      },
    };
  if (
    row.schema_authority_kind === 'plan_generated' &&
    row.schema_resource_id === null &&
    row.schema_resource_hash === null &&
    row.schema_plan_id !== null &&
    row.schema_plan_hash !== null &&
    row.generated_schema_ref !== null &&
    row.generated_schema_hash !== null &&
    ['join_expose', 'child_completion', 'map_result'].includes(
      String(row.generated_schema_generator),
    ) &&
    row.generated_schema_parameter_hash !== null
  )
    return {
      content,
      byteLength: row.byte_length,
      schemaHash: row.generated_schema_hash as Sha256Hash,
      authority: {
        kind: 'plan_generated',
        planId: row.schema_plan_id,
        planHash: row.schema_plan_hash as Sha256Hash,
        schemaRef: row.generated_schema_ref,
        schemaHash: row.generated_schema_hash as Sha256Hash,
        generator: row.generated_schema_generator as GeneratedSchemaGenerator,
        parameterHash: row.generated_schema_parameter_hash as Sha256Hash,
      },
    };
  fail(`${label} schema authority shape drifted`);
}

function runtimeValueLimit(plan: CompiledScopePlanV2Document): number | null {
  const safety = object(
    (plan as unknown as JsonObject).runtime_safety_snapshot,
    'Plan runtime_safety_snapshot',
  );
  const value = object(safety.value, 'Plan runtime_safety_snapshot.value');
  const maximum = value.max_single_value_bytes;
  if (maximum === null || maximum === undefined) return null;
  if (!Number.isSafeInteger(maximum) || Number(maximum) < 0)
    fail('Plan max_single_value_bytes is invalid');
  return Number(maximum);
}

export function persistStructuralNodeOutputEnvelope(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly identity: PersistedPlanIdentity;
    readonly node: JsonObject;
    readonly inputSnapshotJson: string;
    readonly carrierValueId: string;
    readonly carrierValueHash: Sha256Hash;
    readonly nowMs: number;
  },
): PersistedNodeOutputEnvelope {
  verifyPersistedPlanGeneratedSchemaAuthorities(transaction, input.identity);
  const nodeId = String(input.node.id);
  let snapshot: JsonObject;
  try {
    snapshot = object(
      JSON.parse(input.inputSnapshotJson),
      `Node ${nodeId} input snapshot`,
    );
  } catch (error) {
    if (error instanceof G5RuntimeError) throw error;
    fail(`Node ${nodeId} input snapshot is not JSON`);
  }
  if (canonicalJson(snapshot) !== input.inputSnapshotJson)
    fail(`Node ${nodeId} input snapshot bytes drifted`);
  const snapshotPorts = object(
    snapshot.ports,
    `Node ${nodeId} input snapshot ports`,
  );
  const outputPorts = object(
    input.node.output_ports ?? {},
    `Node ${nodeId} output_ports`,
  );
  const expose = object(input.node.expose ?? {}, `Node ${nodeId} expose`);
  if (input.node.type === 'join' && !sameKeys(expose, outputPorts))
    fail(`Join ${nodeId} expose/output port shape mismatch`);
  if (input.node.type !== 'join' && Object.keys(outputPorts).length !== 0)
    fail(`Structural node ${nodeId} has unsupported output ports`);

  const published: Record<string, PublishedNodeOutputPort> = {};
  let carrierAuthority: InlineValueSchemaAuthority | null = null;
  for (const outputName of Object.keys(outputPorts).sort(ascii)) {
    const output = object(
      outputPorts[outputName],
      `Node ${nodeId} output ${outputName}`,
    );
    const outputSchema = object(
      output.schema,
      `Node ${nodeId} output ${outputName} schema`,
    );
    const persistedSchema = loadPersistedPlanGeneratedSchemaAuthority(
      transaction,
      input.identity,
      outputSchema,
      `Node ${nodeId} output ${outputName}`,
    );
    carrierAuthority ??= persistedSchema.authority;
    const exposure = object(
      expose[outputName],
      `Join ${nodeId} expose ${outputName}`,
    );
    const inputName = String(exposure.input_port);
    const snapshotPort = object(
      snapshotPorts[inputName],
      `Join ${nodeId} input snapshot ${inputName}`,
    );
    if (snapshotPort.state === 'absent') {
      published[outputName] = {
        state: 'absent',
        schema_hash: String(outputSchema.schema_hash) as Sha256Hash,
      };
      continue;
    }
    if (snapshotPort.state !== 'present')
      fail(`Join ${nodeId} input snapshot ${inputName} state is invalid`);
    const logical = object(
      snapshotPort.logical_value,
      `Join ${nodeId} input snapshot ${inputName} logical_value`,
    );
    if (
      typeof logical.value_id !== 'string' ||
      typeof logical.value_hash !== 'string' ||
      typeof logical.schema_hash !== 'string' ||
      !Number.isSafeInteger(logical.byte_length)
    )
      fail(
        `Join ${nodeId} input snapshot ${inputName} logical Value is incomplete`,
      );
    const source = exactInlineValue(
      transaction,
      logical.value_id,
      logical.value_hash as Sha256Hash,
      `Join ${nodeId} input ${inputName}`,
    );
    if (
      source.schemaHash !== logical.schema_hash ||
      source.byteLength !== logical.byte_length
    )
      fail(`Join ${nodeId} input ${inputName} Value authority drifted`);
    const validation = validateCompiledInputValue(
      source.content,
      outputSchema,
      output.max_bytes,
      {
        resolveSchema: () => persistedSchema.schema,
        maxSingleValueBytes: runtimeValueLimit(input.identity.plan),
      },
      `Join ${nodeId} output ${outputName}`,
    );
    if (validation !== null)
      fail(`Join ${nodeId} output ${outputName} ${validation}`);
    const valueIdentity: JsonObject = {
      plan_hash: input.identity.planHash,
      node_id: nodeId,
      output_port: outputName,
      input_port: inputName,
      source_value_id: logical.value_id,
      source_value_hash: logical.value_hash,
      value: source.content,
    };
    const valueId = stableRuntimeId('join-output-port-value', valueIdentity);
    const valueHash = runtimeObjectHash(
      'join-output-port-value',
      valueIdentity,
    );
    insertInlineValue(transaction, {
      id: valueId,
      content: source.content,
      contentHash: valueHash,
      schemaAuthority: persistedSchema.authority,
      provenanceRef: `join-output:${input.identity.planHash}:${nodeId}:${outputName}`,
      retentionClass: 'run_recovery',
      createdAtMs: input.nowMs,
    });
    published[outputName] = {
      state: 'present',
      value_ref: valueId,
      value_hash: valueHash,
      schema_hash: String(outputSchema.schema_hash) as Sha256Hash,
      byte_length: source.byteLength,
    };
  }

  if (carrierAuthority === null)
    carrierAuthority = exactInlineValue(
      transaction,
      input.carrierValueId,
      input.carrierValueHash,
      `Node ${nodeId} envelope carrier`,
    ).authority;
  const envelope = buildCanonicalNodeOutputEnvelope(outputPorts, published);
  const hash = String(envelope.envelope_hash) as Sha256Hash;
  const id = stableRuntimeId('node-output-envelope', {
    plan_hash: input.identity.planHash,
    node_id: nodeId,
    envelope_hash: hash,
  });
  insertInlineValue(transaction, {
    id,
    content: envelope,
    contentHash: hash,
    schemaAuthority: carrierAuthority,
    provenanceRef: `node-output-envelope:${input.identity.planHash}:${nodeId}`,
    retentionClass: 'run_recovery',
    createdAtMs: input.nowMs,
  });
  return {
    id,
    hash,
    portContractHash: String(envelope.port_contract_hash) as Sha256Hash,
    envelope,
  };
}
