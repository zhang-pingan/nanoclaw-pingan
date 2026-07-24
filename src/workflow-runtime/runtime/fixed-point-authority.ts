import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { G5RuntimeError } from './graph-store.js';

export type ThreeValuedTruth = 'true' | 'false' | 'unknown';
export type EdgeResolutionState =
  | 'unresolved'
  | 'taken'
  | 'not_taken'
  | 'error';

export interface TriggerEdgeObservation {
  readonly edgeId: string;
  readonly state: EdgeResolutionState;
  readonly resolutionSequence: number | null;
}

export interface TriggerEvaluation {
  readonly truth: ThreeValuedTruth;
  readonly referencedEdgeIds: string[];
  readonly witness: Array<{
    readonly edge_id: string;
    readonly state: 'taken' | 'not_taken';
    readonly resolution_seq: number;
  }>;
  readonly truthProgramHash: Sha256Hash;
}

export interface DataResolutionObservation {
  readonly edgeId: string;
  readonly edgeKey: string;
  readonly port: string;
  readonly state: 'unresolved' | 'available' | 'unavailable' | 'error';
  readonly valueId: string | null;
  readonly valueHash: Sha256Hash | null;
  readonly schemaHash: Sha256Hash | null;
  readonly resolutionSequence: number | null;
  readonly value: JsonValue | null;
  readonly byteLength: number | null;
}

export interface SealedInputPortValue {
  readonly port: string;
  readonly aggregation: string;
  readonly value: JsonValue;
  readonly schema: JsonObject;
  readonly existingValueId: string | null;
  readonly existingValueHash: Sha256Hash | null;
}

export interface InputSchemaAuthority {
  readonly resolveSchema: (
    compiledSchema: JsonObject,
    label: string,
  ) => JsonObject;
  readonly maxSingleValueBytes: number | null;
}

export interface InputSealEvaluation {
  readonly state: 'open' | 'sealed' | 'impossible' | 'error';
  readonly snapshot: JsonObject | null;
  readonly selectedEdgeIds: string[];
  readonly portValues: SealedInputPortValue[];
}

export interface CompletionNodeObservation {
  readonly nodeId: string;
  readonly nodeKey: string;
  readonly phase: string;
  readonly terminalStatus: string | null;
  readonly terminalCode: string | null;
}

export interface CompletionCandidateObservation {
  readonly id: string;
  readonly terminalNodeId: string;
  readonly terminalNodeKey: string;
  readonly exitName: string;
  readonly candidateSequence: number;
  readonly outputValueId: string;
  readonly outputHash: Sha256Hash;
}

export interface CompletionStateObservation {
  readonly nodes: readonly CompletionNodeObservation[];
  readonly candidates: readonly CompletionCandidateObservation[];
}

export interface ApplicableCompletionRule {
  readonly rule: JsonObject;
  readonly candidate: CompletionCandidateObservation;
}

const CONDITION_PROGRAM_DOMAIN = 'icarus:workflow-condition-program:2\n';
const TRIGGER_PROGRAM_DOMAIN = 'icarus:workflow-trigger-program:1\n';
const COMPLETION_FACT_PROGRAM_DOMAIN =
  'icarus:workflow-completion-fact-program:1\n';
const COMPLETION_SELECTOR_DOMAIN = 'icarus:workflow-completion-selector:1\n';
const COMPLETION_RULE_DOMAIN = 'icarus:workflow-completion-rule:1\n';
const COMPLETION_POLICY_DOMAIN = 'icarus:workflow-completion-policy:1\n';

const ABSENT = Symbol('absent');
type ConditionValue = JsonValue | typeof ABSENT;

function fail(message: string): never {
  throw new G5RuntimeError('integrity_violation', message);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is not an object`);
  return value as JsonObject;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    fail(`${label} is not a string array`);
  const output = value as string[];
  if (new Set(output).size !== output.length)
    fail(`${label} contains duplicate identities`);
  return output;
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) fail(`${label} is not a safe integer`);
  return value as number;
}

function verifyHash(
  domain: string,
  claimed: unknown,
  value: JsonValue,
  label: string,
): Sha256Hash {
  const observed = domainSeparatedSha256(domain, value);
  if (claimed !== observed) fail(`${label} hash drifted`);
  return observed;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ascii);
}

function collectExpressionEdgeIds(expression: JsonObject): string[] {
  if (expression.op === 'edge_is') {
    if (typeof expression.edge_id !== 'string')
      fail('Trigger edge_is identity is missing');
    return [expression.edge_id];
  }
  if (expression.op === 'not')
    return collectExpressionEdgeIds(
      object(expression.arg, 'Trigger expression not.arg'),
    );
  if (expression.op === 'and' || expression.op === 'or')
    return objectArray(expression.args, 'Trigger expression args').flatMap(
      collectExpressionEdgeIds,
    );
  fail(`Unsupported trigger expression operator: ${String(expression.op)}`);
}

function kleeneExpression(
  expression: JsonObject,
  edges: ReadonlyMap<string, TriggerEdgeObservation>,
): ThreeValuedTruth {
  if (expression.op === 'edge_is') {
    const edge = edges.get(String(expression.edge_id));
    if (!edge)
      fail(`Trigger references unknown edge: ${String(expression.edge_id)}`);
    if (edge.state === 'error') fail(`Trigger edge is errored: ${edge.edgeId}`);
    if (edge.state === 'unresolved') return 'unknown';
    if (expression.state !== 'taken' && expression.state !== 'not_taken')
      fail('Trigger edge_is state is invalid');
    return edge.state === expression.state ? 'true' : 'false';
  }
  if (expression.op === 'not') {
    const value = kleeneExpression(
      object(expression.arg, 'Trigger expression not.arg'),
      edges,
    );
    return value === 'unknown' ? value : value === 'true' ? 'false' : 'true';
  }
  if (expression.op === 'and' || expression.op === 'or') {
    const args = objectArray(expression.args, 'Trigger expression args');
    if (args.length === 0) fail('Trigger expression has no arguments');
    const values = args.map((arg) => kleeneExpression(arg, edges));
    if (expression.op === 'and') {
      if (values.includes('false')) return 'false';
      return values.includes('unknown') ? 'unknown' : 'true';
    }
    if (values.includes('true')) return 'true';
    return values.includes('unknown') ? 'unknown' : 'false';
  }
  fail(`Unsupported trigger expression operator: ${String(expression.op)}`);
}

export function evaluateTriggerProgram(
  programValue: unknown,
  observations: readonly TriggerEdgeObservation[],
): TriggerEvaluation {
  const program = object(programValue, 'Plan trigger_program');
  const expression = object(
    program.normalized_expression,
    'Plan trigger_program.normalized_expression',
  );
  const withoutHash: JsonObject = { ...program };
  delete withoutHash.truth_program_hash;
  const truthProgramHash = verifyHash(
    TRIGGER_PROGRAM_DOMAIN,
    program.truth_program_hash,
    withoutHash,
    'Trigger program',
  );
  const byId = new Map(observations.map((edge) => [edge.edgeId, edge]));
  let referencedEdgeIds: string[];
  let truth: ThreeValuedTruth;
  if (expression.type === 'root') {
    referencedEdgeIds = [];
    truth = observations.length === 0 ? 'true' : 'false';
  } else if (
    expression.type === 'all' ||
    expression.type === 'any' ||
    expression.type === 'quorum'
  ) {
    referencedEdgeIds = strings(expression.edge_ids, 'Trigger edge_ids');
    if (referencedEdgeIds.length === 0) fail('Trigger edge set is empty');
    const states = referencedEdgeIds.map((edgeId) => {
      const edge = byId.get(edgeId);
      if (!edge) fail(`Trigger references unknown edge: ${edgeId}`);
      if (edge.state === 'error') fail(`Trigger edge is errored: ${edgeId}`);
      return edge.state;
    });
    const taken = states.filter((state) => state === 'taken').length;
    const unresolved = states.filter((state) => state === 'unresolved').length;
    if (expression.type === 'all')
      truth = states.includes('not_taken')
        ? 'false'
        : unresolved > 0
          ? 'unknown'
          : 'true';
    else if (expression.type === 'any')
      truth = taken > 0 ? 'true' : unresolved > 0 ? 'unknown' : 'false';
    else {
      const minimum = safeInteger(expression.min_taken, 'Trigger quorum');
      if (minimum < 1 || minimum > referencedEdgeIds.length)
        fail('Trigger quorum is outside its edge set');
      truth =
        taken >= minimum
          ? 'true'
          : taken + unresolved < minimum
            ? 'false'
            : 'unknown';
    }
  } else if (expression.type === 'expression') {
    const nested = object(expression.expression, 'Trigger expression');
    referencedEdgeIds = uniqueSorted(collectExpressionEdgeIds(nested));
    if (referencedEdgeIds.length === 0)
      fail('Trigger expression edge set is empty');
    truth = kleeneExpression(nested, byId);
  } else fail(`Unsupported trigger type: ${String(expression.type)}`);

  const declared = strings(
    program.referenced_edge_ids,
    'Trigger referenced_edge_ids',
  );
  const compilerDeclared =
    expression.type === 'expression' ? [] : [...referencedEdgeIds].sort(ascii);
  if (canonicalJson(declared) !== canonicalJson(compilerDeclared))
    fail('Trigger referenced edge authority drifted');
  const resolvedWitness = referencedEdgeIds
    .map((edgeId) => byId.get(edgeId))
    .filter(
      (edge): edge is TriggerEdgeObservation =>
        edge !== undefined &&
        (edge.state === 'taken' || edge.state === 'not_taken') &&
        edge.resolutionSequence !== null,
    )
    .sort(
      (left, right) =>
        left.resolutionSequence! - right.resolutionSequence! ||
        ascii(left.edgeId, right.edgeId),
    );
  const provingWitness =
    truth === 'true' &&
    (expression.type === 'any' || expression.type === 'quorum')
      ? resolvedWitness.filter((edge) => edge.state === 'taken')
      : resolvedWitness;
  const witnessLimit =
    expression.type === 'any'
      ? 1
      : expression.type === 'quorum'
        ? Number(expression.min_taken)
        : resolvedWitness.length;
  return {
    truth,
    referencedEdgeIds,
    witness: provingWitness.slice(0, witnessLimit).map((edge) => ({
      edge_id: edge.edgeId,
      state: edge.state as 'taken' | 'not_taken',
      resolution_seq: edge.resolutionSequence!,
    })),
    truthProgramHash,
  };
}

function pointerValue(
  value: JsonValue,
  pointer: string | undefined,
): ConditionValue {
  if (pointer === undefined || pointer === '') return value;
  if (!pointer.startsWith('/')) fail('Condition JSON Pointer is not canonical');
  let current: JsonValue = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return ABSENT;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length)
        return ABSENT;
      current = current[index]!;
    } else if (current && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return ABSENT;
      current = current[token]!;
    } else return ABSENT;
  }
  return current;
}

function conditionOperand(
  operandValue: unknown,
  resolveReference: (reference: JsonObject) => JsonValue | undefined,
): ConditionValue {
  const operand = object(operandValue, 'Condition operand');
  if (Object.prototype.hasOwnProperty.call(operand, 'literal'))
    return operand.literal as JsonValue;
  const reference = object(operand.ref, 'Condition operand ref');
  const resolved = resolveReference(reference);
  if (resolved === undefined) return ABSENT;
  return pointerValue(
    resolved,
    typeof reference.pointer === 'string' ? reference.pointer : undefined,
  );
}

function comparableType(value: JsonValue): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function evaluateConditionExpression(
  expression: JsonObject,
  resolveReference: (reference: JsonObject) => JsonValue | undefined,
): boolean {
  if (expression.op === 'and' || expression.op === 'or') {
    const args = objectArray(expression.args, 'Condition args');
    if (args.length === 0) fail('Condition expression has no arguments');
    if (expression.op === 'and') {
      for (const arg of args)
        if (!evaluateConditionExpression(arg, resolveReference)) return false;
      return true;
    }
    for (const arg of args)
      if (evaluateConditionExpression(arg, resolveReference)) return true;
    return false;
  }
  if (expression.op === 'not')
    return !evaluateConditionExpression(
      object(expression.arg, 'Condition not.arg'),
      resolveReference,
    );
  if (expression.op === 'exists')
    return conditionOperand(expression.value, resolveReference) !== ABSENT;
  const left = conditionOperand(
    expression.op === 'in' ? expression.value : expression.left,
    resolveReference,
  );
  const right = conditionOperand(
    expression.op === 'in' ? expression.set : expression.right,
    resolveReference,
  );
  if (left === ABSENT || right === ABSENT) fail('Condition operand is absent');
  if (expression.op === 'in') {
    if (!Array.isArray(right)) fail('Condition in-set is not an array');
    return right.some((entry) => canonicalJson(entry) === canonicalJson(left));
  }
  if (comparableType(left) !== comparableType(right))
    fail('Condition operand types are incompatible');
  if (expression.op === 'eq' || expression.op === 'ne') {
    const equal = canonicalJson(left) === canonicalJson(right);
    return expression.op === 'eq' ? equal : !equal;
  }
  if (
    !(
      (typeof left === 'number' && typeof right === 'number') ||
      (typeof left === 'string' && typeof right === 'string')
    )
  )
    fail('Condition ordering operands are not scalar-compatible');
  if (
    typeof left === 'number' &&
    (!Number.isFinite(left) || !Number.isFinite(right))
  )
    fail('Condition number is not finite');
  if (expression.op === 'lt') return left < right;
  if (expression.op === 'lte') return left <= right;
  if (expression.op === 'gt') return left > right;
  if (expression.op === 'gte') return left >= right;
  fail(`Unsupported condition operator: ${String(expression.op)}`);
}

export function evaluateConditionProgram(
  programValue: unknown,
  resolveReference: (reference: JsonObject) => JsonValue | undefined,
): boolean {
  if (programValue === null || programValue === undefined) return true;
  const program = object(programValue, 'Plan condition_program');
  const withoutHash: JsonObject = { ...program };
  delete withoutHash.program_hash;
  verifyHash(
    CONDITION_PROGRAM_DOMAIN,
    program.program_hash,
    withoutHash,
    'Condition program',
  );
  return evaluateConditionExpression(
    object(program.normalized_ast, 'Condition normalized_ast'),
    resolveReference,
  );
}

function selectedValue(edge: DataResolutionObservation): JsonObject {
  if (
    edge.valueId === null ||
    edge.valueHash === null ||
    edge.schemaHash === null ||
    edge.resolutionSequence === null
  )
    fail(`Available input edge is incomplete: ${edge.edgeId}`);
  return {
    edge_id: edge.edgeId,
    edge_key: edge.edgeKey,
    resolution_seq: edge.resolutionSequence,
    value_id: edge.valueId,
    value_hash: edge.valueHash,
    schema_hash: edge.schemaHash,
  };
}

const inputSchemaAjv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const inputSchemaValidators = new Map<string, ReturnType<Ajv2020['compile']>>();

function valueBytes(value: JsonValue): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function validateCompiledInputValue(
  value: JsonValue,
  compiledSchema: JsonObject,
  maxBytes: unknown,
  authority: InputSchemaAuthority,
  label: string,
): 'schema_invalid' | 'value_too_large' | null {
  const byteLength = valueBytes(value);
  const limits = [maxBytes, authority.maxSingleValueBytes].filter(
    (limit): limit is number => limit !== null && limit !== undefined,
  );
  if (
    limits.some(
      (limit) =>
        !Number.isSafeInteger(limit) || limit < 0 || byteLength > limit,
    )
  )
    return 'value_too_large';
  const schema = authority.resolveSchema(compiledSchema, label);
  const key = canonicalJson(schema);
  let validate = inputSchemaValidators.get(key);
  if (!validate) {
    try {
      validate = inputSchemaAjv.compile(schema as AnySchema);
    } catch {
      return 'schema_invalid';
    }
    inputSchemaValidators.set(key, validate);
  }
  return validate(value) === true ? null : 'schema_invalid';
}

function observationValue(
  edge: DataResolutionObservation,
  label: string,
): JsonValue {
  if (edge.value === null || edge.byteLength === null)
    fail(`${label} Value authority is incomplete`);
  if (edge.byteLength !== valueBytes(edge.value))
    fail(`${label} Value byte authority drifted`);
  return edge.value;
}

function orderedAvailable(
  edges: readonly DataResolutionObservation[],
  order: 'edge_id' | 'resolution_seq',
): DataResolutionObservation[] {
  return edges
    .filter((edge) => edge.state === 'available')
    .sort((left, right) =>
      order === 'resolution_seq'
        ? left.resolutionSequence! - right.resolutionSequence! ||
          ascii(left.edgeKey, right.edgeKey)
        : ascii(left.edgeKey, right.edgeKey),
    );
}

export function evaluateInputSeal(
  nodeValue: JsonObject,
  observations: readonly DataResolutionObservation[],
  authority: InputSchemaAuthority,
): InputSealEvaluation {
  const ports = object(nodeValue.input_ports ?? {}, 'Plan node input_ports');
  const snapshots: Record<string, JsonValue> = {};
  const selectedEdgeIds: string[] = [];
  const portValues: SealedInputPortValue[] = [];
  let open = false;
  let impossible = false;
  for (const portName of Object.keys(ports).sort(ascii)) {
    const contract = object(ports[portName], `Plan input port ${portName}`);
    const aggregation = object(
      contract.aggregation,
      `Plan input port ${portName}.aggregation`,
    );
    const edges = observations.filter((edge) => edge.port === portName);
    if (edges.some((edge) => edge.state === 'error'))
      return {
        state: 'error',
        snapshot: null,
        selectedEdgeIds: [],
        portValues: [],
      };
    const allClosed = edges.every((edge) => edge.state !== 'unresolved');
    if (aggregation.type === 'single') {
      const select = String(aggregation.select);
      const available = orderedAvailable(
        edges,
        select === 'first_resolved' ? 'resolution_seq' : 'edge_id',
      );
      const maySelect =
        select === 'first_resolved'
          ? available.length > 0
          : allClosed && available.length > 0;
      if (maySelect) {
        const edge = available[0]!;
        const value = observationValue(edge, `Plan input port ${portName}`);
        if (
          validateCompiledInputValue(
            value,
            object(contract.schema, `Plan input port ${portName}.schema`),
            contract.max_bytes,
            authority,
            `Plan input port ${portName}`,
          ) !== null
        )
          return {
            state: 'error',
            snapshot: null,
            selectedEdgeIds: [],
            portValues: [],
          };
        snapshots[portName] = {
          state: 'present',
          aggregation: select,
          value: selectedValue(edge),
        };
        selectedEdgeIds.push(edge.edgeId);
        portValues.push({
          port: portName,
          aggregation: select,
          value,
          schema: object(contract.schema, `Plan input port ${portName}.schema`),
          existingValueId: edge.valueId,
          existingValueHash: edge.valueHash,
        });
      } else if (!allClosed) open = true;
      else if (Object.prototype.hasOwnProperty.call(aggregation, 'default')) {
        const value = aggregation.default as JsonValue;
        if (
          validateCompiledInputValue(
            value,
            object(contract.schema, `Plan input port ${portName}.schema`),
            contract.max_bytes,
            authority,
            `Plan input port ${portName} default`,
          ) !== null
        )
          return {
            state: 'error',
            snapshot: null,
            selectedEdgeIds: [],
            portValues: [],
          };
        snapshots[portName] = {
          state: 'present',
          aggregation: 'default',
          default_value: value,
          selected_edges: [],
        };
        portValues.push({
          port: portName,
          aggregation: 'default',
          value,
          schema: object(contract.schema, `Plan input port ${portName}.schema`),
          existingValueId: null,
          existingValueHash: null,
        });
      } else if (aggregation.required === false)
        snapshots[portName] = { state: 'absent', selected_edges: [] };
      else impossible = true;
      continue;
    }
    if (aggregation.type !== 'list')
      fail(`Unsupported input aggregation: ${String(aggregation.type)}`);
    const minimum = safeInteger(aggregation.min_items, 'List min_items');
    const seal = object(aggregation.seal, 'List seal');
    const requestedOrder = String(aggregation.order);
    if (requestedOrder !== 'edge_id' && requestedOrder !== 'resolution_seq')
      fail('List input order is invalid');
    const available = orderedAvailable(edges, requestedOrder);
    let chosen: DataResolutionObservation[] | null = null;
    if (seal.type === 'all_sources_resolved') {
      if (allClosed && available.length >= minimum) chosen = available;
      else if (allClosed) impossible = true;
      else open = true;
    } else if (seal.type === 'first_n_available') {
      const count = safeInteger(seal.count, 'List first_n_available count');
      const completionOrdered = orderedAvailable(edges, 'resolution_seq');
      if (completionOrdered.length >= count)
        chosen = completionOrdered.slice(0, count);
      else if (allClosed && completionOrdered.length >= minimum)
        chosen = completionOrdered;
      else if (allClosed) impossible = true;
      else open = true;
    } else fail(`Unsupported list seal: ${String(seal.type)}`);
    if (chosen) {
      const itemSchema = object(
        contract.item_schema,
        `Plan input port ${portName}.item_schema`,
      );
      const values = chosen.map((edge) =>
        observationValue(edge, `Plan input port ${portName} item`),
      );
      if (
        values.some(
          (value) =>
            validateCompiledInputValue(
              value,
              itemSchema,
              contract.item_max_bytes,
              authority,
              `Plan input port ${portName} item`,
            ) !== null,
        ) ||
        validateCompiledInputValue(
          values,
          object(contract.schema, `Plan input port ${portName}.schema`),
          contract.max_bytes,
          authority,
          `Plan input port ${portName} aggregate`,
        ) !== null
      )
        return {
          state: 'error',
          snapshot: null,
          selectedEdgeIds: [],
          portValues: [],
        };
      snapshots[portName] = {
        state: 'present',
        aggregation: 'list',
        values: chosen.map(selectedValue),
      };
      selectedEdgeIds.push(...chosen.map((edge) => edge.edgeId));
      portValues.push({
        port: portName,
        aggregation: 'list',
        value: values,
        schema: object(contract.schema, `Plan input port ${portName}.schema`),
        existingValueId: null,
        existingValueHash: null,
      });
    }
  }
  if (impossible)
    return {
      state: 'impossible',
      snapshot: null,
      selectedEdgeIds: [],
      portValues: [],
    };
  if (open)
    return {
      state: 'open',
      snapshot: null,
      selectedEdgeIds: [],
      portValues: [],
    };
  return {
    state: 'sealed',
    snapshot: { ports: snapshots },
    selectedEdgeIds: uniqueSorted(selectedEdgeIds),
    portValues,
  };
}

function compareCount(
  actual: number,
  comparison: unknown,
  expectedValue: unknown,
): boolean {
  const expected = safeInteger(expectedValue, 'Completion count target');
  if (comparison === 'eq') return actual === expected;
  if (comparison === 'gte') return actual >= expected;
  if (comparison === 'lte') return actual <= expected;
  fail(`Unsupported completion comparison: ${String(comparison)}`);
}

export function evaluateCompletionFactExpression(
  expressionValue: unknown,
  state: CompletionStateObservation,
): boolean {
  const expression = object(expressionValue, 'Completion fact expression');
  if (expression.op === 'and' || expression.op === 'or') {
    const args = objectArray(expression.args, 'Completion expression args');
    if (args.length === 0) fail('Completion expression has no arguments');
    return expression.op === 'and'
      ? args.every((arg) => evaluateCompletionFactExpression(arg, state))
      : args.some((arg) => evaluateCompletionFactExpression(arg, state));
  }
  if (expression.op === 'not')
    return !evaluateCompletionFactExpression(expression.arg, state);
  if (expression.fact === 'all_nodes_terminal')
    return state.nodes.every((node) => node.phase === 'terminal');
  if (expression.fact === 'candidate_count') {
    const exits = Array.isArray(expression.exits)
      ? strings(expression.exits, 'Completion candidate exits')
      : null;
    const nodeIds = Array.isArray(expression.terminal_node_ids)
      ? strings(expression.terminal_node_ids, 'Completion candidate node ids')
      : null;
    const count = state.candidates.filter(
      (candidate) =>
        (!exits || exits.includes(candidate.exitName)) &&
        (!nodeIds || nodeIds.includes(candidate.terminalNodeKey)),
    ).length;
    return compareCount(count, expression.cmp, expression.value);
  }
  if (expression.fact === 'node_count') {
    const nodeIds = Array.isArray(expression.node_ids)
      ? strings(expression.node_ids, 'Completion node ids')
      : null;
    const statuses = strings(expression.statuses, 'Completion node statuses');
    const codes = Array.isArray(expression.codes)
      ? strings(expression.codes, 'Completion node codes')
      : null;
    const count = state.nodes.filter(
      (node) =>
        (!nodeIds || nodeIds.includes(node.nodeKey)) &&
        node.terminalStatus !== null &&
        statuses.includes(node.terminalStatus) &&
        (!codes ||
          (node.terminalCode !== null && codes.includes(node.terminalCode))),
    ).length;
    return compareCount(count, expression.cmp, expression.value);
  }
  fail(`Unsupported completion fact: ${String(expression.fact)}`);
}

export function selectCompletionCandidate(
  selectorValue: unknown,
  candidates: readonly CompletionCandidateObservation[],
): CompletionCandidateObservation | null {
  const selector = object(selectorValue, 'Completion selector');
  const exits = Array.isArray(selector.exits)
    ? strings(selector.exits, 'Completion selector exits')
    : null;
  const nodeIds = Array.isArray(selector.terminal_node_ids)
    ? strings(selector.terminal_node_ids, 'Completion selector node ids')
    : null;
  const eligible = candidates.filter(
    (candidate) =>
      (!exits || exits.includes(candidate.exitName)) &&
      (!nodeIds || nodeIds.includes(candidate.terminalNodeKey)),
  );
  if (eligible.length === 0) return null;
  const pick = object(selector.pick, 'Completion selector pick');
  if (pick.type === 'first_reached')
    return [...eligible].sort(
      (left, right) =>
        left.candidateSequence - right.candidateSequence ||
        ascii(left.id, right.id),
    )[0]!;
  if (pick.type === 'lowest_terminal_node_id')
    return [...eligible].sort(
      (left, right) =>
        ascii(left.terminalNodeKey, right.terminalNodeKey) ||
        left.candidateSequence - right.candidateSequence,
    )[0]!;
  if (pick.type === 'exit_priority_then_first') {
    const priority = strings(pick.exit_priority, 'Completion exit priority');
    return [...eligible].sort((left, right) => {
      const leftPriority = priority.indexOf(left.exitName);
      const rightPriority = priority.indexOf(right.exitName);
      return (
        (leftPriority < 0 ? Number.MAX_SAFE_INTEGER : leftPriority) -
          (rightPriority < 0 ? Number.MAX_SAFE_INTEGER : rightPriority) ||
        left.candidateSequence - right.candidateSequence ||
        ascii(left.id, right.id)
      );
    })[0]!;
  }
  fail(`Unsupported completion pick: ${String(pick.type)}`);
}

export function verifyCompletionPolicyAuthority(
  policyValue: unknown,
): JsonObject {
  const policy = object(policyValue, 'Plan completion policy');
  const withoutHash: JsonObject = { ...policy };
  delete withoutHash.policy_hash;
  verifyHash(
    COMPLETION_POLICY_DOMAIN,
    policy.policy_hash,
    withoutHash,
    'Completion policy',
  );
  return policy;
}

function applicableRule(
  rule: JsonObject,
  state: CompletionStateObservation,
): ApplicableCompletionRule | null {
  const withoutRuleHash: JsonObject = { ...rule };
  delete withoutRuleHash.rule_hash;
  verifyHash(
    COMPLETION_RULE_DOMAIN,
    rule.rule_hash,
    withoutRuleHash,
    'Completion rule',
  );
  const expression = object(
    rule.normalized_fact_expression,
    'Completion normalized fact expression',
  );
  verifyHash(
    COMPLETION_FACT_PROGRAM_DOMAIN,
    rule.fact_program_hash,
    {
      normalized_fact_expression: expression,
      max_steps: rule.max_steps as JsonValue,
    },
    'Completion fact program',
  );
  const selector = object(rule.selector, 'Completion selector');
  verifyHash(
    COMPLETION_SELECTOR_DOMAIN,
    rule.selector_contract_hash,
    selector,
    'Completion selector',
  );
  if (!evaluateCompletionFactExpression(expression, state)) return null;
  const candidate = selectCompletionCandidate(selector, state.candidates);
  return candidate ? { rule, candidate } : null;
}

export function applicableCompletionRules(
  ruleValues: unknown,
  state: CompletionStateObservation,
): ApplicableCompletionRule[] {
  return objectArray(ruleValues, 'Completion rules')
    .map((rule) => applicableRule(rule, state))
    .filter((value): value is ApplicableCompletionRule => value !== null);
}
