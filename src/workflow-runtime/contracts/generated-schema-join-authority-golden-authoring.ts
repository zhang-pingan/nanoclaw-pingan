import crypto from 'node:crypto';

import { domainSeparatedSha256 } from './hash.js';
import { buildGeneratedSchema } from './generated-schema-authority.js';
import { assertJsonObject } from './strict-json.js';
import type {
  CompilerConformanceDiagnosticV1,
  WorkflowCompilerConformanceCaseResultV1,
} from './compiler-contract-repair-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

const GRAPH_SOURCE_DOMAIN = 'icarus:workflow-graph-source:1\n';
const DEFINITION_SOURCE_DOMAIN = 'icarus:workflow-definition:1\n';
const SCHEMA_SOURCE_DOMAIN = 'icarus:workflow-schema-source:1\n';
const COMPILED_PLAN_V2_DOMAIN_SEPARATOR = 'icarus:workflow-graph-plan:2\n';
const COMPILER_CASE_RESULT_DOMAIN_SEPARATOR =
  'icarus:workflow-compiler-conformance-case-result:1\n';
const CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR =
  'icarus:workflow-condition-program:2\n';
const STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure-member:1\n';
const STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure:1\n';
const NODE_SOURCE_DOMAIN = 'icarus:workflow-graph-node-source:1\n';
const TRIGGER_PROGRAM_DOMAIN = 'icarus:workflow-trigger-program:1\n';
const RETRY_POLICY_DOMAIN = 'icarus:workflow-capability-retry-policy:1\n';
const ROUTE_GROUP_DOMAIN = 'icarus:workflow-route-group:1\n';
const CONTROL_EDGE_SOURCE_DOMAIN = 'icarus:workflow-control-edge-source:1\n';
const CONTROL_EDGE_DOMAIN = 'icarus:workflow-compiled-control-edge:1\n';
const DATA_EDGE_SOURCE_DOMAIN = 'icarus:workflow-data-edge-source:1\n';
const DATA_EDGE_DOMAIN = 'icarus:workflow-compiled-data-edge:1\n';
const LITERAL_SCHEMA_DOMAIN = 'icarus:workflow-literal-schema:1\n';
const PROOF_DETAIL_DOMAIN =
  'icarus:workflow-data-edge-compatibility-proof-detail:1\n';
const PROOF_DOMAIN = 'icarus:workflow-data-edge-compatibility-proof:1\n';
const COMPLETION_FACT_PROGRAM_DOMAIN =
  'icarus:workflow-completion-fact-program:1\n';
const COMPLETION_SELECTOR_DOMAIN = 'icarus:workflow-completion-selector:1\n';
const COMPLETION_RULE_DOMAIN = 'icarus:workflow-completion-rule:1\n';
const COMPLETION_POLICY_DOMAIN = 'icarus:workflow-completion-policy:1\n';
const COMPLEXITY_SUMMARY_DOMAIN =
  'icarus:workflow-compiled-complexity-summary:1\n';
const CAPABILITY_CATALOG_DOMAIN =
  'icarus:workflow-capability-catalog-snapshot:1\n';
const WAIT_CATALOG_DOMAIN = 'icarus:workflow-wait-catalog-snapshot:1\n';
const CHILD_POLICY_DOMAIN = 'icarus:workflow-child-policy-binding:1\n';
const OUTBOX_POLICY_SNAPSHOT_DOMAIN =
  'icarus:workflow-outbox-effective-policy-snapshot:1\n';
const CAPABILITY_OUTBOX_BINDING_DOMAIN =
  'icarus:workflow-capability-outbox-execution-binding:1\n';

export interface CurrentG2AuthoringCase {
  caseId: string;
  sourceKind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  rawSourceText: string;
  expectedSourceHash: Sha256Hash | null;
  inputSnapshot: JsonObject;
  expectedDiagnostics: CompilerConformanceDiagnosticV1[];
}

interface CompileContext {
  identity: JsonObject;
  snapshot: JsonObject;
  resources: JsonObject[];
  interfaces: JsonObject[];
  rootPolicy: JsonObject;
  childProfiles: JsonObject[];
  safety: JsonObject;
  proofHashes: Sha256Hash[];
  programHashes: Sha256Hash[];
  closureMembers: JsonObject[];
}

interface CompiledGraph {
  plan: JsonObject;
  sourceHash: Sha256Hash;
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function object(value: JsonValue, label: string): JsonObject {
  try {
    assertJsonObject(value);
  } catch {
    throw new Error(`Current G2 Golden authoring expected object: ${label}`);
  }
  return value;
}

function objects(value: JsonValue, label: string): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`Current G2 Golden authoring expected array: ${label}`);
  }
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function string(value: JsonValue, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Current G2 Golden authoring expected string: ${label}`);
  }
  return value;
}

function nullableNumber(value: JsonValue, label: string): number | null {
  if (value !== null && typeof value !== 'number') {
    throw new Error(`Current G2 Golden authoring expected number: ${label}`);
  }
  return value;
}

function without(objectValue: JsonObject, ...keys: string[]): JsonObject {
  const copy = clone(objectValue);
  for (const key of keys) delete copy[key];
  return copy;
}

function hash(domain: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(domain, value);
}

function rawHash(text: string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function refKey(value: JsonObject): string {
  return `${string(value.id, 'ref.id')}@${string(value.version, 'ref.version')}`;
}

function resourceKey(value: JsonObject): string {
  return `${string(value.resource_type, 'resource type')}:${refKey(
    object(value.ref, 'resource ref'),
  )}`;
}

function findResource(
  context: CompileContext,
  type: string,
  ref: JsonObject,
): JsonObject {
  const key = `${type}:${refKey(ref)}`;
  const found = context.resources.find((entry) => resourceKey(entry) === key);
  if (!found) throw new Error(`Golden authoring resource missing: ${key}`);
  return found;
}

function findInterface(context: CompileContext, ref: JsonObject): JsonObject {
  const key = refKey(ref);
  const found = context.interfaces.find(
    (entry) => refKey(object(entry.ref, 'interface ref')) === key,
  );
  if (!found) throw new Error(`Golden authoring interface missing: ${key}`);
  return found;
}

function schemaBinding(context: CompileContext, ref: JsonObject): JsonObject {
  const resource = findResource(context, 'schema', ref);
  return {
    type: 'registry',
    ref: clone(ref),
    schema_hash: string(resource.content_hash, 'schema content hash'),
  };
}

function sortedObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => ascii(left, right))
      .map(([key, nested]) => [key, clone(nested)]),
  );
}

function sortRefs(value: JsonValue): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return [...value].sort((left, right) => {
    const leftRef = object(left, 'left ref');
    const rightRef = object(right, 'right ref');
    return ascii(refKey(leftRef), refKey(rightRef));
  });
}

function normalizePolicy(policy: JsonObject): JsonObject {
  const normalized = clone(policy);
  for (const key of [
    'allowed_capabilities',
    'allowed_templates',
    'allowed_interface_refs',
    'allowed_wait_contracts',
    'allowed_child_policy_refs',
  ]) {
    normalized[key] = sortRefs(normalized[key]);
  }
  for (const key of ['allowed_node_types', 'allowed_claim_ids']) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = [...normalized[key]].sort((left, right) =>
        ascii(String(left), String(right)),
      );
    }
  }
  const effectPolicy = object(normalized.effect_policy, 'effect policy');
  if (Array.isArray(effectPolicy.allowed_recovery_kinds)) {
    effectPolicy.allowed_recovery_kinds = [
      ...effectPolicy.allowed_recovery_kinds,
    ].sort((left, right) => ascii(String(left), String(right)));
  }
  normalized.limits = sortedObject(object(normalized.limits, 'policy limits'));
  normalized.usage_budget = sortedObject(
    object(normalized.usage_budget, 'policy usage budget'),
  );
  return normalized;
}

function intersectLimits(
  inherited: JsonObject,
  requested: JsonObject,
): JsonObject {
  return Object.fromEntries(
    Object.keys(inherited)
      .sort(ascii)
      .map((key) => {
        const parent = nullableNumber(inherited[key], `limit ${key}`);
        const child = nullableNumber(requested[key], `requested limit ${key}`);
        return [
          key,
          parent === null
            ? child
            : child === null
              ? parent
              : Math.min(parent, child),
        ];
      }),
  );
}

function effectivePolicy(
  inherited: JsonObject,
  requestedLimits: JsonObject,
): JsonObject {
  const policy = normalizePolicy(inherited);
  policy.limits = intersectLimits(
    object(policy.limits, 'inherited limits'),
    requestedLimits,
  );
  return policy;
}

function childPolicy(context: CompileContext, refValue: JsonValue): JsonObject {
  const parent = normalizePolicy(context.rootPolicy);
  if (refValue === undefined) {
    return {
      effective_policy_snapshot: parent,
      effective_policy_hash: hash(CHILD_POLICY_DOMAIN, parent),
    };
  }
  const ref = object(refValue, 'child policy ref');
  const profile = context.childProfiles.find(
    (candidate) =>
      refKey(object(candidate.ref, 'child profile ref')) === refKey(ref),
  );
  if (!profile)
    throw new Error(`Golden authoring child policy missing: ${refKey(ref)}`);
  const request = normalizePolicy(
    object(profile.request, 'child policy request'),
  );
  const intersected = clone(request);
  intersected.allowed_node_types = (
    request.allowed_node_types as JsonValue[]
  ).filter((entry) =>
    (parent.allowed_node_types as JsonValue[]).includes(entry),
  );
  for (const key of [
    'allowed_capabilities',
    'allowed_templates',
    'allowed_interface_refs',
    'allowed_wait_contracts',
    'allowed_child_policy_refs',
  ]) {
    const parentKeys = new Set(
      sortRefs(parent[key]).map((entry) =>
        refKey(object(entry, `parent ${key}`)),
      ),
    );
    intersected[key] = sortRefs(request[key]).filter((entry) =>
      parentKeys.has(refKey(object(entry, `child ${key}`))),
    );
  }
  intersected.allowed_claim_ids = (
    request.allowed_claim_ids as JsonValue[]
  ).filter((entry) =>
    (parent.allowed_claim_ids as JsonValue[]).includes(entry),
  );
  intersected.allow_early_close =
    parent.allow_early_close === true && request.allow_early_close === true;
  intersected.allow_indefinite_waits =
    parent.allow_indefinite_waits === true &&
    request.allow_indefinite_waits === true;
  intersected.limits = intersectLimits(
    object(parent.limits, 'parent limits'),
    object(request.limits, 'child limits'),
  );
  const output: JsonObject = {
    profile_ref: clone(ref),
    effective_policy_snapshot: intersected,
    effective_policy_hash: hash(CHILD_POLICY_DOMAIN, intersected),
  };
  return output;
}

function schemaForLiteral(value: JsonValue): JsonObject {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const itemSchemas = value.map(schemaForLiteral);
    const unique = new Map(
      itemSchemas.map((schema) => [JSON.stringify(schema), schema] as const),
    );
    return {
      type: 'array',
      items:
        unique.size === 1
          ? clone([...unique.values()][0]!)
          : { enum: clone(value) },
      minItems: value.length,
      maxItems: value.length,
    };
  }
  if (typeof value === 'object') {
    const properties = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => ascii(left, right))
        .map(([key, nested]) => [key, schemaForLiteral(nested)]),
    );
    return {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    };
  }
  return { type: typeof value, const: value };
}

function generatedSchema(
  generator: 'child_completion' | 'map_result',
  childInterface: JsonObject,
): JsonObject {
  const exits = Object.keys(object(childInterface.exits, 'child exits')).sort(
    ascii,
  );
  const parameter: JsonObject = {
    generator,
    child_interface_ref: clone(
      object(childInterface.ref, 'child interface ref'),
    ),
    exits,
  };
  const schemaJson: JsonObject =
    generator === 'child_completion'
      ? {
          type: 'object',
          additionalProperties: false,
          required: ['exit', 'output_ports'],
          properties: {
            exit: { type: 'string', enum: exits },
            output_ports: { type: 'object' },
          },
        }
      : {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['item_index', 'outcome'],
            properties: {
              item_index: { type: 'integer', minimum: 0 },
              outcome: {
                type: 'string',
                enum: ['completed', 'errored', 'cancelled'],
              },
            },
          },
        };
  return buildGeneratedSchema(generator, parameter, schemaJson);
}

function compileInputPorts(
  context: CompileContext,
  sourcePorts: JsonValue,
): JsonObject {
  if (sourcePorts === undefined) return {};
  const ports = object(sourcePorts, 'input ports');
  return Object.fromEntries(
    Object.entries(ports)
      .sort(([left], [right]) => ascii(left, right))
      .map(([name, value]) => {
        const port = object(value, `input port ${name}`);
        const compiled: JsonObject = {
          schema: schemaBinding(
            context,
            object(port.schema_ref, 'input schema ref'),
          ),
          max_bytes: port.max_bytes,
          aggregation: clone(object(port.aggregation, 'input aggregation')),
        };
        if (
          compiled.aggregation &&
          object(compiled.aggregation, 'aggregation').type === 'list'
        ) {
          const item = object(port.item_contract, 'input item contract');
          compiled.item_schema = schemaBinding(
            context,
            object(item.schema_ref, 'item schema ref'),
          );
          compiled.item_max_bytes = item.max_bytes;
        }
        return [name, compiled];
      }),
  );
}

function compileOutputPorts(
  context: CompileContext,
  sourcePorts: JsonValue,
): JsonObject {
  if (sourcePorts === undefined) return {};
  const ports = object(sourcePorts, 'output ports');
  return Object.fromEntries(
    Object.entries(ports)
      .sort(([left], [right]) => ascii(left, right))
      .map(([name, value]) => {
        const port = object(value, `output port ${name}`);
        return [
          name,
          {
            schema: schemaBinding(
              context,
              object(port.schema_ref, 'output schema ref'),
            ),
            max_bytes: port.max_bytes,
            required: port.required,
          },
        ];
      }),
  );
}

function triggerSteps(trigger: JsonObject): number {
  if (trigger.type === 'expression')
    return expressionSteps(object(trigger.expression, 'trigger expression'));
  return 1;
}

function expressionSteps(value: JsonObject): number {
  if (Array.isArray(value.args)) {
    return (
      1 +
      value.args.reduce<number>(
        (sum, entry) => sum + expressionSteps(object(entry, 'expression arg')),
        0,
      )
    );
  }
  if (value.arg)
    return 1 + expressionSteps(object(value.arg, 'expression arg'));
  return 1;
}

function triggerProgram(
  context: CompileContext,
  triggerValue: JsonValue,
): JsonObject {
  const trigger = clone(object(triggerValue, 'node trigger'));
  const referenced = Array.isArray(trigger.edge_ids)
    ? [...trigger.edge_ids].map(String).sort(ascii)
    : [];
  const programWithoutHash: JsonObject = {
    normalized_expression: trigger,
    referenced_edge_ids: referenced,
    max_steps: triggerSteps(trigger),
  };
  const truthProgramHash = hash(TRIGGER_PROGRAM_DOMAIN, programWithoutHash);
  context.programHashes.push(truthProgramHash);
  return { ...programWithoutHash, truth_program_hash: truthProgramHash };
}

function capabilityNode(context: CompileContext, node: JsonObject): JsonObject {
  const capability = findResource(
    context,
    'capability',
    object(node.capability_ref, 'capability ref'),
  );
  const binding = clone(object(capability.content, 'capability content'));
  const retry = object(binding.retry_policy, 'capability retry policy');
  const requested = node.retry_request
    ? object(node.retry_request, 'retry request')
    : null;
  const maximum = Math.min(
    Number(retry.max_attempts),
    requested ? Number(requested.max_attempts) : Number(retry.max_attempts),
    Number(
      object(context.safety.execution, 'execution safety')
        .max_attempts_per_node,
    ),
  );
  let qualityRevision: JsonValue = null;
  if (binding.quality_revision_policy !== null) {
    const policy = object(
      binding.quality_revision_policy,
      'quality revision policy',
    );
    const schema = findResource(
      context,
      'schema',
      object(policy.feedback_schema_ref, 'feedback schema ref'),
    );
    qualityRevision = {
      feedback_schema_ref: clone(
        object(policy.feedback_schema_ref, 'feedback schema ref'),
      ),
      feedback_schema_hash: schema.content_hash,
      effective_max_feedback_bytes: Math.min(
        Number(policy.max_feedback_bytes),
        Number(
          object(context.safety.value, 'value safety').max_single_value_bytes,
        ),
      ),
      context_mode: policy.context_mode,
    };
  }
  const retryWithoutHash: JsonObject = {
    effective_node_max_attempts: maximum,
    effective_retry_on: clone(
      (requested?.retry_on ?? retry.retry_on) as JsonValue,
    ),
    backoff: retry.backoff,
    quality_revision: qualityRevision,
  };
  const inputPorts = compileInputPorts(context, binding.input_ports);
  const outputPorts = compileOutputPorts(context, binding.output_ports);
  let outboxExecutionBinding: JsonObject | null = null;
  if (binding.outbox_effect !== undefined) {
    const effectContract = object(
      binding.outbox_effect,
      'capability outbox effect',
    );
    const adapter = findResource(
      context,
      'outbox_adapter',
      object(effectContract.adapter_ref, 'capability adapter ref'),
    );
    const deliveryPolicy = findResource(
      context,
      'outbox_policy',
      object(
        effectContract.delivery_policy_ref,
        'capability delivery policy ref',
      ),
    );
    const policy = object(deliveryPolicy.content, 'outbox delivery policy');
    const executionSafety = object(
      context.safety.execution,
      'execution safety',
    );
    const effectiveDeliveryDurationMs = Math.min(
      Number(policy.delivery_duration_ms),
      Number(executionSafety.max_outbox_delivery_duration_ms),
    );
    const effectiveMaxBackoffMs = Math.min(
      Number(policy.max_backoff_ms),
      Number(executionSafety.max_retry_backoff_ms),
    );
    const effectivePolicy: JsonObject = {
      max_delivery_attempts: Math.min(
        Number(policy.max_delivery_attempts),
        Number(executionSafety.max_outbox_attempts_per_message),
      ),
      max_reconcile_attempts: Math.min(
        Number(policy.max_reconcile_attempts),
        Number(executionSafety.max_outbox_reconcile_attempts_per_message),
      ),
      delivery_duration_ms: effectiveDeliveryDurationMs,
      attempt_timeout_ms: Math.min(
        Number(policy.attempt_timeout_ms),
        Number(executionSafety.max_outbox_attempt_duration_ms),
        effectiveDeliveryDurationMs,
      ),
      initial_backoff_ms: Math.min(
        Number(policy.initial_backoff_ms),
        effectiveMaxBackoffMs,
      ),
      max_backoff_ms: effectiveMaxBackoffMs,
      backoff: policy.backoff,
      deterministic_jitter_micros: policy.deterministic_jitter_micros,
      honor_retry_after: policy.honor_retry_after,
      retryable_error_codes: clone(policy.retryable_error_codes),
      permanent_error_codes: clone(policy.permanent_error_codes),
    };
    const snapshotWithoutHash: JsonObject = {
      format: 'icarus.workflow-outbox-effective-policy-snapshot/1',
      source_policy_ref: clone(deliveryPolicy.ref),
      source_policy_content_hash: deliveryPolicy.content_hash,
      source_policy_hash: policy.policy_hash,
      effective_policy: effectivePolicy,
      runtime_safety_hash: object(
        context.snapshot.safety_snapshot,
        'safety snapshot',
      ).source_artifact_hash,
    };
    const effectivePolicySnapshot: JsonObject = {
      ...snapshotWithoutHash,
      snapshot_hash: hash(OUTBOX_POLICY_SNAPSHOT_DOMAIN, snapshotWithoutHash),
    };
    const outboxBindingWithoutHash: JsonObject = {
      effect_contract: clone(effectContract),
      adapter_identity: {
        resource_type: 'outbox_adapter',
        ref: clone(adapter.ref),
        content_hash: adapter.content_hash,
      },
      delivery_policy_identity: {
        resource_type: 'outbox_policy',
        ref: clone(deliveryPolicy.ref),
        content_hash: deliveryPolicy.content_hash,
      },
      effective_policy_snapshot: effectivePolicySnapshot,
    };
    outboxExecutionBinding = {
      ...outboxBindingWithoutHash,
      binding_hash: hash(
        CAPABILITY_OUTBOX_BINDING_DOMAIN,
        outboxBindingWithoutHash,
      ),
    };
  }
  return {
    id: node.id,
    type: node.type,
    source_config_hash: hash(NODE_SOURCE_DOMAIN, node),
    trigger_program: triggerProgram(context, node.trigger),
    input_ports: inputPorts,
    output_ports: outputPorts,
    effective_limits: {
      max_attempts: maximum,
      timeout_ms: Math.min(
        node.timeout_ms
          ? Number(node.timeout_ms)
          : Number(binding.timeout_ceiling_ms),
        Number(
          object(context.safety.execution, 'execution safety')
            .max_attempt_duration_ms,
        ),
      ),
    },
    capability_binding: binding,
    ...(outboxExecutionBinding
      ? { outbox_execution_binding: outboxExecutionBinding }
      : {}),
    effective_retry_policy: {
      ...retryWithoutHash,
      policy_hash: hash(RETRY_POLICY_DOMAIN, retryWithoutHash),
    },
  };
}

function cleanInterface(value: JsonObject): JsonObject {
  return without(value, 'interface_hash');
}

function terminalNode(context: CompileContext, node: JsonObject): JsonObject {
  return {
    id: node.id,
    type: 'terminal',
    source_config_hash: hash(NODE_SOURCE_DOMAIN, node),
    trigger_program: triggerProgram(context, node.trigger),
    input_ports: {},
    output_ports: {},
    effective_limits: {},
    exit: node.exit,
  };
}

function waitNode(context: CompileContext, node: JsonObject): JsonObject {
  const wait = object(node.wait, 'wait source');
  const resource = findResource(
    context,
    'wait_contract',
    object(wait.contract_ref, 'wait contract ref'),
  );
  const contract = clone(object(resource.content, 'wait contract'));
  const maxDuration = Math.min(
    wait.timeout_ms === undefined
      ? Number(
          object(context.safety.wait, 'wait safety')
            .max_finite_wait_duration_ms,
        )
      : Number(wait.timeout_ms),
    Number(
      object(context.safety.wait, 'wait safety').max_finite_wait_duration_ms,
    ),
  );
  const binding: JsonObject = {
    ...clone(wait),
    contract_snapshot: contract,
    effective_max_duration_ms: maxDuration,
  };
  return {
    id: node.id,
    type: 'wait',
    source_config_hash: hash(NODE_SOURCE_DOMAIN, node),
    trigger_program: triggerProgram(context, node.trigger),
    input_ports: compileInputPorts(context, contract.input_ports),
    output_ports: compileOutputPorts(context, contract.output_ports),
    effective_limits: { max_wait_duration_ms: maxDuration },
    wait_binding: binding,
  };
}

function childContext(
  parent: CompileContext,
  effectiveChildPolicy: JsonObject,
): CompileContext {
  return {
    ...parent,
    rootPolicy: effectiveChildPolicy,
    proofHashes: [],
    programHashes: [],
    closureMembers: [],
  };
}

function compileStaticFactory(
  context: CompileContext,
  factoryValue: JsonValue,
  ownerNodePath: string[],
  policyBinding: JsonObject,
): { binding: JsonObject; childPlan: JsonObject } {
  const factory = object(factoryValue, 'static factory');
  if (factory.type !== 'inline') {
    throw new Error(
      'Current G2 Golden authoring supports only frozen inline factories',
    );
  }
  const childSource = object(factory.scope, 'inline child scope');
  const child = compileGraph(
    childContext(
      context,
      object(policyBinding.effective_policy_snapshot, 'child effective policy'),
    ),
    childSource,
    ownerNodePath,
  );
  const childInterface = cleanInterface(
    findInterface(
      context,
      object(childSource.interface_ref, 'child interface ref'),
    ),
  );
  const sourceHash = hash(GRAPH_SOURCE_DOMAIN, childSource);
  const closureKey = ownerNodePath.join('/');
  const parentClosureKey =
    ownerNodePath.length > 1 ? ownerNodePath.slice(0, -1).join('/') : null;
  const memberWithoutHash: JsonObject = {
    closure_key: closureKey,
    parent_closure_key: parentClosureKey,
    scope_key: childSource.scope_key,
    owner_node_path: ownerNodePath,
    factory_kind: 'inline',
    source_ref: null,
    source_hash: sourceHash,
    plan_ref: `content-addressed:workflow-plan/${string(child.plan.plan_hash, 'child plan hash').slice(7)}`,
    plan_hash: child.plan.plan_hash,
    interface_snapshot_hash: hash(
      'icarus:workflow-scope-interface:1\n',
      childInterface,
    ),
  };
  const member: JsonObject = {
    ...memberWithoutHash,
    member_hash: hash(
      STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
      memberWithoutHash,
    ),
  };
  context.closureMembers.push(member, ...child.closureMembers);
  return {
    binding: {
      kind: 'inline',
      source_snapshot_ref: `inline:${sourceHash}`,
      source_hash: sourceHash,
      precompiled_plan_hash: child.plan.plan_hash,
      interface_snapshot: childInterface,
    },
    childPlan: child.plan,
  };
}

function loweringGraph(
  definition: JsonObject,
  context: CompileContext,
): { graph: JsonObject; interfaceValue: JsonObject; policy: JsonObject } {
  const entryPoints = object(
    definition.entry_points,
    'definition entry points',
  );
  const entry = object(entryPoints.default, 'definition default entry');
  const states = object(definition.states, 'definition states');
  const state = object(
    states[string(entry.state_key, 'entry state')],
    'entry state',
  );
  const definitionRef = object(definition.ref, 'definition ref');
  const interfaceValue: JsonObject = {
    ref: {
      id: `${string(definitionRef.id, 'definition id')}.lowered.${string(entry.state_key, 'entry state key')}`,
      version: string(definitionRef.version, 'definition version'),
    },
    inputs: {},
    exits: {
      failure: { output_ports: {} },
      success: { output_ports: {} },
    },
  };
  context.interfaces.push(interfaceValue);
  const graph: JsonObject = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: `definition.${string(entry.state_key, 'entry state key')}`,
    interface_ref: clone(object(interfaceValue.ref, 'lowered interface ref')),
    nodes: [
      {
        id: 'capability',
        type: state.type,
        trigger: { type: 'root' },
        capability_ref: clone(
          object(state.capability_ref, 'state capability ref'),
        ),
        ...(state.retry_request
          ? { retry_request: clone(state.retry_request) }
          : {}),
        ...(state.timeout_ms ? { timeout_ms: state.timeout_ms } : {}),
      },
      {
        id: 'failure',
        type: 'terminal',
        trigger: { type: 'all', edge_ids: ['failed_to_failure'] },
        exit: 'failure',
      },
      {
        id: 'success',
        type: 'terminal',
        trigger: { type: 'all', edge_ids: ['succeeded_to_success'] },
        exit: 'success',
      },
    ],
    control_edges: [
      {
        id: 'failed_to_failure',
        kind: 'control',
        from_node_id: 'capability',
        to_node_id: 'failure',
        on: { statuses: ['failed'] },
      },
      {
        id: 'succeeded_to_success',
        kind: 'control',
        from_node_id: 'capability',
        to_node_id: 'success',
        on: { statuses: ['succeeded'] },
      },
    ],
    data_edges: [],
    completion: {
      settled_rules: [
        {
          id: 'select_named_exit',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['failure', 'success'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
    requested_limits: clone(object(state.policy, 'state policy').limits),
  };
  return {
    graph,
    interfaceValue,
    policy: object(state.policy, 'state policy'),
  };
}

function buildContext(snapshot: JsonObject): CompileContext {
  const registry = object(snapshot.registry_snapshot, 'registry snapshot');
  const interfaces = object(snapshot.interface_snapshot, 'interface snapshot');
  const policy = object(snapshot.policy_snapshot, 'policy snapshot');
  const completePolicy = object(policy.complete_policy, 'complete policy');
  const safety = object(snapshot.safety_snapshot, 'safety snapshot');
  return {
    identity: object(snapshot.compiler_identity, 'compiler identity'),
    snapshot,
    resources: objects(registry.resources, 'registry resources'),
    interfaces: objects(interfaces.interfaces, 'interfaces').map(
      cleanInterface,
    ),
    rootPolicy: object(completePolicy.root_policy, 'root policy'),
    childProfiles: objects(completePolicy.child_profiles, 'child profiles'),
    safety: object(safety.ceilings, 'safety ceilings'),
    proofHashes: [],
    programHashes: [],
    closureMembers: [],
  };
}

function collectObjectsByHashField(
  value: JsonValue,
  fields: Set<string>,
  output: JsonObject[] = [],
): JsonObject[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectsByHashField(entry, fields, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (Object.keys(value).some((key) => fields.has(key)))
    output.push(clone(value));
  for (const nested of Object.values(value)) {
    collectObjectsByHashField(nested, fields, output);
  }
  return output;
}

export function extractCurrentG2GoldenProofBytes(
  plan: JsonObject,
): JsonObject[] {
  return collectObjectsByHashField(plan, new Set(['proof_hash'])).sort(
    (left, right) => ascii(String(left.proof_hash), String(right.proof_hash)),
  );
}

export function extractCurrentG2GoldenProgramBytes(
  plan: JsonObject,
): JsonObject[] {
  return collectObjectsByHashField(
    plan,
    new Set(['program_hash', 'truth_program_hash', 'fact_program_hash']),
  ).sort((left, right) => {
    const leftHash = String(
      left.program_hash ?? left.truth_program_hash ?? left.fact_program_hash,
    );
    const rightHash = String(
      right.program_hash ?? right.truth_program_hash ?? right.fact_program_hash,
    );
    return ascii(leftHash, rightHash);
  });
}

function resultHash(
  value: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return hash(
    COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
    value as unknown as JsonValue,
  );
}

function diagnosticOrder(
  left: CompilerConformanceDiagnosticV1,
  right: CompilerConformanceDiagnosticV1,
): number {
  for (const [leftValue, rightValue] of [
    [left.instance_pointer, right.instance_pointer],
    [left.code, right.code],
    [left.stable_object_id ?? '', right.stable_object_id ?? ''],
    [left.schema_pointer ?? '', right.schema_pointer ?? ''],
  ]) {
    const compared = ascii(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function authorCurrentG2GoldenExpectedResult(
  input: CurrentG2AuthoringCase,
): WorkflowCompilerConformanceCaseResultV1 {
  if (input.expectedDiagnostics.length > 0) {
    const withoutHashValue = {
      format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
      case_id: input.caseId,
      source_kind: input.sourceKind,
      source_hash: input.expectedSourceHash,
      outcome: 'rejected' as const,
      normalized_plan: null,
      static_lowering_contract_ref: null,
      static_lowering_contract_hash: null,
      diagnostics: [...input.expectedDiagnostics].sort(diagnosticOrder),
      proof_hashes: [] as Sha256Hash[],
      program_hashes: [] as Sha256Hash[],
    };
    return {
      ...withoutHashValue,
      result_hash: resultHash(withoutHashValue),
    };
  }
  const parsed = JSON.parse(input.rawSourceText) as JsonValue;
  const source = object(parsed, 'positive source');
  const context = buildContext(input.inputSnapshot);
  let compiled: ReturnType<typeof compileGraph>;
  let staticLowering = false;
  if (input.sourceKind === 'workflow_definition') {
    staticLowering = true;
    const lowered = loweringGraph(source, context);
    context.rootPolicy = lowered.policy;
    compiled = compileGraph(context, lowered.graph);
    const expectedSourceHash =
      input.expectedSourceHash ??
      hash(DEFINITION_SOURCE_DOMAIN, without(source, 'definition_hash'));
    compiled.plan.source_hash = expectedSourceHash;
    const planWithoutHash = without(compiled.plan, 'plan_hash');
    compiled.plan.plan_hash = hash(
      COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
      planWithoutHash,
    );
    compiled.sourceHash = expectedSourceHash;
  } else {
    compiled = compileGraph(context, source);
  }
  const proofs = extractCurrentG2GoldenProofBytes(compiled.plan);
  const programs = extractCurrentG2GoldenProgramBytes(compiled.plan);
  const proofHashes = proofs.map((proof) =>
    string(proof.proof_hash, 'proof hash'),
  ) as Sha256Hash[];
  const programHashes = programs.map((program) =>
    string(
      program.program_hash ??
        program.truth_program_hash ??
        program.fact_program_hash,
      'program hash',
    ),
  ) as Sha256Hash[];
  const withoutHashValue = {
    format: 'icarus.workflow-compiler-conformance-case-result/1' as const,
    case_id: input.caseId,
    source_kind: input.sourceKind,
    source_hash: compiled.sourceHash,
    outcome: 'compiled' as const,
    normalized_plan: compiled.plan as never,
    static_lowering_contract_ref: staticLowering
      ? {
          id: 'icarus.workflow-definition-static-lowering-contract',
          version: '1.0.0',
        }
      : null,
    static_lowering_contract_hash: staticLowering
      ? ('sha256:905b433c6909d6e61663a65d532850f60b0e62a9c6c5f039a1280e3dad44b430' as Sha256Hash)
      : null,
    diagnostics: [] as [],
    proof_hashes: proofHashes,
    program_hashes: programHashes,
  };
  return {
    ...withoutHashValue,
    result_hash: resultHash(withoutHashValue),
  } as WorkflowCompilerConformanceCaseResultV1;
}

export const CURRENT_G2_GOLDEN_AUTHORING_DOMAINS = Object.freeze({
  graph_source: GRAPH_SOURCE_DOMAIN,
  definition_source: DEFINITION_SOURCE_DOMAIN,
  schema_source: SCHEMA_SOURCE_DOMAIN,
  plan: COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
  result: COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
  condition_program: CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR,
  closure_member: STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
  closure: STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
});

export function currentG2GoldenRawBytesHashForTest(text: string): Sha256Hash {
  return rawHash(text);
}

function structuralNode(
  context: CompileContext,
  node: JsonObject,
  ownerPath: string[],
): JsonObject {
  const base: JsonObject = {
    id: node.id,
    type: node.type,
    source_config_hash: hash(NODE_SOURCE_DOMAIN, node),
    trigger_program: triggerProgram(context, node.trigger),
    input_ports: compileInputPorts(context, node.input_ports),
    output_ports: {},
    effective_limits: {},
  };
  if (node.type === 'expand') {
    const childInterface = cleanInterface(
      findInterface(
        context,
        object(node.child_interface_ref, 'expand child interface ref'),
      ),
    );
    const policy = childPolicy(context, node.child_policy_ref);
    const completionPort = string(
      node.completion_output_port,
      'expand completion output port',
    );
    base.output_ports = {
      [completionPort]: {
        schema: generatedSchema('child_completion', childInterface),
        max_bytes: Number(
          object(context.safety.value, 'value safety').max_single_value_bytes,
        ),
        required: true,
      },
    };
    base.effective_limits = {
      max_nesting_depth: Number(
        object(context.safety.scope, 'scope safety').max_nesting_depth,
      ),
      max_scope_spec_bytes: Number(
        object(context.safety.scope, 'scope safety').max_scope_spec_bytes,
      ),
    };
    base.graph_spec_input_port = node.graph_spec_input_port;
    base.child_interface_snapshot = childInterface;
    base.child_input_bindings = sortedObject(
      object(node.child_input_bindings, 'expand child input bindings'),
    );
    base.completion_output_port = completionPort;
    base.expose = sortedObject(object(node.expose ?? {}, 'expand expose'));
    base.child_policy = policy;
    return base;
  }
  const policy = childPolicy(context, node.child_policy_ref);
  const factory = compileStaticFactory(
    context,
    node.type === 'map' ? node.body : node.scope,
    [...ownerPath, string(node.id, 'owner node id')],
    policy,
  );
  const childInterface = cleanInterface(
    object(factory.binding.interface_snapshot, 'factory child interface'),
  );
  if (node.type === 'subgraph') {
    const completionPort = string(
      node.completion_output_port,
      'subgraph completion output port',
    );
    base.output_ports = {
      [completionPort]: {
        schema: generatedSchema('child_completion', childInterface),
        max_bytes: Number(
          object(context.safety.value, 'value safety').max_single_value_bytes,
        ),
        required: true,
      },
    };
    base.effective_limits = {
      max_nesting_depth: Number(
        object(context.safety.scope, 'scope safety').max_nesting_depth,
      ),
    };
    base.factory_binding = factory.binding;
    base.child_input_bindings = sortedObject(
      object(node.child_input_bindings, 'subgraph child input bindings'),
    );
    base.completion_output_port = completionPort;
    base.expose = sortedObject(object(node.expose ?? {}, 'subgraph expose'));
    base.child_policy = policy;
    return base;
  }
  const resultsPort = string(node.result_output_port, 'map result output port');
  const requestedItems = nullableNumber(
    node.requested_max_items,
    'map max items',
  );
  const requestedConcurrency = nullableNumber(
    node.requested_child_concurrency,
    'map concurrency',
  );
  const safetyMap = object(context.safety.map, 'map safety');
  const maxItems =
    requestedItems === null
      ? Number(safetyMap.max_items_per_map)
      : Math.min(requestedItems, Number(safetyMap.max_items_per_map));
  const concurrency =
    requestedConcurrency === null
      ? Number(safetyMap.max_child_concurrency_per_map)
      : Math.min(
          requestedConcurrency,
          Number(safetyMap.max_child_concurrency_per_map),
        );
  base.output_ports = {
    [resultsPort]: {
      schema: generatedSchema('map_result', childInterface),
      max_bytes: Number(
        object(context.safety.value, 'value safety').max_single_value_bytes,
      ),
      required: true,
    },
  };
  base.effective_limits = {
    max_items: maxItems,
    child_concurrency: concurrency,
    max_nesting_depth: Number(
      object(context.safety.scope, 'scope safety').max_nesting_depth,
    ),
  };
  base.body_binding = factory.binding;
  base.items_input_port = node.items_input_port;
  base.item_child_input_port = node.item_child_input_port;
  base.shared_child_input_bindings = sortedObject(
    object(node.shared_child_input_bindings, 'map shared bindings'),
  );
  base.result_output_port = resultsPort;
  if (node.item_key_pointer !== undefined)
    base.item_key_pointer = node.item_key_pointer;
  base.effective_max_items = maxItems;
  base.effective_child_concurrency = concurrency;
  base.completion = clone(object(node.completion, 'map completion'));
  base.child_policy = policy;
  base.result_order = 'item_index';
  return base;
}

function schemaJsonForBinding(
  context: CompileContext,
  binding: JsonObject,
): JsonObject {
  if (binding.type !== 'registry') {
    return object(binding.schema_json, 'generated schema json');
  }
  const resource = findResource(
    context,
    'schema',
    object(binding.ref, 'compiled schema ref'),
  );
  return object(resource.content, 'compiled schema content');
}

function joinNode(context: CompileContext, node: JsonObject): JsonObject {
  const inputPorts = compileInputPorts(context, node.input_ports);
  const expose = object(node.expose, 'join expose');
  const outputPorts = Object.fromEntries(
    Object.entries(expose)
      .sort(([left], [right]) => ascii(left, right))
      .map(([outputName, value]) => {
        const binding = object(value, `join expose ${outputName}`);
        const inputName = string(binding.input_port, 'join expose input');
        const input = object(inputPorts[inputName], 'join compiled input');
        const aggregation = object(input.aggregation, 'join aggregation');
        const required =
          aggregation.type === 'list' ||
          aggregation.required === true ||
          Object.hasOwn(aggregation, 'default');
        const parameters: JsonObject = {
          node_id: node.id,
          output_port: outputName,
          input_port: inputName,
          input_schema: clone(object(input.schema, 'join input schema')),
          aggregation: clone(aggregation),
          max_bytes: input.max_bytes,
          required,
          ...(aggregation.type === 'list'
            ? {
                item_schema: clone(
                  object(input.item_schema, 'join item schema'),
                ),
                item_max_bytes: input.item_max_bytes,
              }
            : {}),
        };
        return [
          outputName,
          {
            schema: buildGeneratedSchema(
              'join_expose',
              parameters,
              schemaJsonForBinding(
                context,
                object(input.schema, 'join input schema'),
              ),
            ),
            max_bytes: input.max_bytes,
            required,
          },
        ];
      }),
  );
  return {
    id: node.id,
    type: node.type,
    source_config_hash: hash(NODE_SOURCE_DOMAIN, node),
    trigger_program: triggerProgram(context, node.trigger),
    input_ports: inputPorts,
    output_ports: outputPorts,
    effective_limits: {},
    expose: sortedObject(expose),
  };
}

function conditionOperands(
  value: JsonObject,
  output: JsonObject[] = [],
): JsonObject[] {
  if (value.left) output.push(object(value.left, 'condition left'));
  if (value.right) output.push(object(value.right, 'condition right'));
  if (value.value) output.push(object(value.value, 'condition value'));
  if (value.set) output.push(object(value.set, 'condition set'));
  if (Array.isArray(value.args)) {
    for (const entry of value.args)
      conditionOperands(object(entry, 'condition arg'), output);
  }
  if (value.arg) conditionOperands(object(value.arg, 'condition arg'), output);
  return output;
}

function jsonType(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function conditionProgram(
  context: CompileContext,
  conditionValue: JsonValue,
  sourceNode: JsonObject,
): JsonObject {
  const condition = clone(object(conditionValue, 'condition'));
  const operands = conditionOperands(condition);
  const operandSchemaHashes: JsonObject = {};
  const operandTypes: JsonValue[] = [];
  operands.forEach((operand, index) => {
    if (operand.literal !== undefined) {
      const schema = schemaForLiteral(operand.literal);
      operandSchemaHashes[`operand_${index}`] = hash(
        LITERAL_SCHEMA_DOMAIN,
        schema,
      );
      operandTypes.push(jsonType(operand.literal));
      return;
    }
    const reference = object(operand.ref, 'condition operand ref');
    const port = string(reference.port, 'condition operand port');
    const outputPorts = object(sourceNode.output_ports, 'source output ports');
    const outputPort = object(outputPorts[port], `source output port ${port}`);
    const schema = object(outputPort.schema, 'source output schema');
    let schemaHash = string(
      schema.schema_hash,
      'condition operand schema hash',
    );
    let type = 'object';
    if (reference.pointer === '/ok') {
      const booleanSchema: JsonObject = { type: 'boolean' };
      schemaHash = hash(LITERAL_SCHEMA_DOMAIN, booleanSchema);
      type = 'boolean';
    }
    operandSchemaHashes[`operand_${index}`] = schemaHash;
    operandTypes.push(type);
  });
  const withoutHashValue: JsonObject = {
    normalized_ast: condition,
    operand_schema_hashes: operandSchemaHashes,
    operand_types: operandTypes,
    max_steps: expressionSteps(condition),
  };
  const programHash = hash(
    CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR,
    withoutHashValue,
  );
  context.programHashes.push(programHash);
  return { ...withoutHashValue, program_hash: programHash };
}

function compileControlEdges(
  context: CompileContext,
  sourceEdges: JsonObject[],
  nodesById: Map<string, JsonObject>,
): JsonObject[] {
  return [...sourceEdges]
    .sort((left, right) => ascii(String(left.id), String(right.id)))
    .map((edge) => {
      const sourceNode = nodesById.get(
        string(edge.from_node_id, 'edge source id'),
      );
      if (!sourceNode)
        throw new Error(`Missing compiled edge source: ${String(edge.id)}`);
      const withoutHashValue: JsonObject = {
        id: edge.id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        outcome_match: edge.on ? clone(object(edge.on, 'edge outcome')) : null,
        condition_program: edge.when
          ? conditionProgram(context, edge.when, sourceNode)
          : null,
        route_group_id: edge.route_group_id ?? null,
        priority: edge.priority ?? null,
        is_default: edge.default === true,
        source_config_hash: hash(CONTROL_EDGE_SOURCE_DOMAIN, edge),
      };
      return {
        ...withoutHashValue,
        compiled_edge_hash: hash(CONTROL_EDGE_DOMAIN, withoutHashValue),
      };
    });
}

function compileRouteGroups(
  sourceGroups: JsonObject[],
  controlEdges: JsonObject[],
): JsonObject[] {
  return [...sourceGroups]
    .sort((left, right) => ascii(String(left.id), String(right.id)))
    .map((group) => {
      const edges = controlEdges
        .filter((edge) => edge.route_group_id === group.id)
        .sort((left, right) => {
          const leftDefault = left.is_default === true;
          const rightDefault = right.is_default === true;
          if (leftDefault !== rightDefault) return leftDefault ? 1 : -1;
          const priority =
            Number(right.priority ?? 0) - Number(left.priority ?? 0);
          return priority || ascii(String(left.id), String(right.id));
        });
      const withoutHashValue: JsonObject = {
        id: group.id,
        from_node_id: group.from_node_id,
        mode: group.mode,
        no_match: group.no_match,
        ordered_edge_ids: edges.map((edge) => edge.id),
      };
      return {
        ...withoutHashValue,
        group_hash: hash(ROUTE_GROUP_DOMAIN, withoutHashValue),
      };
    });
}

function compiledPort(
  nodesById: Map<string, JsonObject>,
  nodeId: string,
  portName: string,
  direction: 'input_ports' | 'output_ports',
): JsonObject {
  const node = nodesById.get(nodeId);
  if (!node) throw new Error(`Golden authoring node missing: ${nodeId}`);
  const ports = object(node[direction], `${nodeId} ${direction}`);
  return object(ports[portName], `${nodeId}.${portName}`);
}

function sourceSchema(
  context: CompileContext,
  edge: JsonObject,
  nodesById: Map<string, JsonObject>,
  rootInterface: JsonObject,
  consumerSchema: JsonObject,
): { binding: JsonObject; schemaJson: JsonObject | null } {
  const from = object(edge.from, 'data source');
  if (from.type === 'literal') {
    return {
      binding: clone(consumerSchema),
      schemaJson: schemaForLiteral(from.value),
    };
  }
  if (from.type === 'scope_input') {
    const inputs = object(rootInterface.inputs, 'scope interface inputs');
    const input = object(
      inputs[string(from.port, 'scope input port')],
      'scope input',
    );
    return {
      binding: schemaBinding(
        context,
        object(input.schema_ref, 'scope input schema ref'),
      ),
      schemaJson: null,
    };
  }
  const output = compiledPort(
    nodesById,
    string(from.node_id, 'data source node'),
    string(from.port, 'data source port'),
    'output_ports',
  );
  return {
    binding: clone(object(output.schema, 'producer schema')),
    schemaJson: null,
  };
}

function proofRule(
  producer: JsonObject,
  consumer: JsonObject,
  schemaJson: JsonObject | null,
): string {
  if (producer.schema_hash === consumer.schema_hash) return 'identical_schema';
  if (schemaJson?.type === 'array') return 'array_item_subtype';
  if (schemaJson?.type === 'object') return 'closed_object_subtype';
  return 'enum_subset';
}

function compileDataEdges(
  context: CompileContext,
  sourceEdges: JsonObject[],
  nodesById: Map<string, JsonObject>,
  rootInterface: JsonObject,
): JsonObject[] {
  return [...sourceEdges]
    .sort((left, right) => ascii(String(left.id), String(right.id)))
    .map((edge) => {
      const to = object(edge.to, 'data destination');
      const consumerPort = compiledPort(
        nodesById,
        string(to.node_id, 'data destination node'),
        string(to.port, 'data destination port'),
        'input_ports',
      );
      const consumerSchema = object(consumerPort.schema, 'consumer schema');
      const producer = sourceSchema(
        context,
        edge,
        nodesById,
        rootInterface,
        consumerSchema,
      );
      const producerHash = string(
        producer.binding.schema_hash,
        'producer schema hash',
      );
      const consumerHash = string(
        consumerSchema.schema_hash,
        'consumer schema hash',
      );
      const from = object(edge.from, 'data source');
      const pointer = typeof from.pointer === 'string' ? from.pointer : null;
      const pointerTokens =
        pointer === null || pointer === ''
          ? []
          : pointer
              .slice(1)
              .split('/')
              .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
      const detail: JsonObject = {
        case: 'current_g2_golden_authoring',
        edge_id: edge.id,
        producer_schema_hash: producerHash,
        consumer_schema_hash: consumerHash,
        pointer,
        rule: proofRule(producer.binding, consumerSchema, producer.schemaJson),
      };
      const proofDetailHash = hash(PROOF_DETAIL_DOMAIN, detail);
      const proofWithoutHash: JsonObject = {
        proof_algorithm_version: context.identity.proof_algorithm_version,
        proof_algorithm_hash: context.identity.proof_algorithm_hash,
        producer_schema_hash: producerHash,
        canonical_pointer: pointer,
        pointer_totality: 'total',
        derived_schema_hash: producerHash,
        consumer_schema_hash: consumerHash,
        proof_rule: detail.rule,
        proof_detail_ref: `inline:current-g2-golden/${String(edge.id)}`,
        proof_detail_hash: proofDetailHash,
      };
      const proofHash = hash(PROOF_DOMAIN, proofWithoutHash);
      context.proofHashes.push(proofHash);
      const proof: JsonObject = { ...proofWithoutHash, proof_hash: proofHash };
      const withoutHashValue: JsonObject = {
        id: edge.id,
        from: clone(from),
        to: clone(to),
        guard_control_edge_id: edge.guard_control_edge_id ?? null,
        canonical_pointer: pointer,
        pointer_tokens: pointerTokens,
        on_missing: edge.on_missing ?? 'error',
        producer_schema_hash: producerHash,
        derived_schema: clone(producer.binding),
        consumer_schema_hash: consumerHash,
        compatibility_proof: proof,
        source_config_hash: hash(DATA_EDGE_SOURCE_DOMAIN, edge),
      };
      return {
        ...withoutHashValue,
        compiled_edge_hash: hash(DATA_EDGE_DOMAIN, withoutHashValue),
      };
    });
}

function compileCompletionRule(
  context: CompileContext,
  sourceRule: JsonObject,
): JsonObject {
  const fact = clone(object(sourceRule.when, 'completion fact'));
  const selector = clone(object(sourceRule.select, 'completion selector'));
  const factProgramWithoutHash: JsonObject = {
    normalized_fact_expression: fact,
    max_steps: expressionSteps(fact),
  };
  const factProgramHash = hash(
    COMPLETION_FACT_PROGRAM_DOMAIN,
    factProgramWithoutHash,
  );
  context.programHashes.push(factProgramHash);
  const withoutHashValue: JsonObject = {
    id: sourceRule.id,
    phase: sourceRule.phase,
    normalized_fact_expression: fact,
    fact_program_hash: factProgramHash,
    max_steps: expressionSteps(fact),
    selector,
    selector_contract_hash: hash(COMPLETION_SELECTOR_DOMAIN, selector),
    priority:
      sourceRule.phase === 'early'
        ? sourceRule.same_event_priority
        : sourceRule.priority,
    monotonicity_proof: null,
    cancellation_safety_proof: null,
  };
  return {
    ...withoutHashValue,
    rule_hash: hash(COMPLETION_RULE_DOMAIN, withoutHashValue),
  };
}

function compileCompletion(
  context: CompileContext,
  sourceValue: JsonValue,
): JsonObject {
  const source = object(sourceValue, 'completion policy');
  const early = objects(source.early_rules ?? [], 'early completion rules')
    .sort((left, right) => ascii(String(left.id), String(right.id)))
    .map((rule) => compileCompletionRule(context, rule));
  const settled = objects(source.settled_rules, 'settled completion rules')
    .sort((left, right) => {
      const priority = Number(right.priority) - Number(left.priority);
      return priority || ascii(String(left.id), String(right.id));
    })
    .map((rule) => compileCompletionRule(context, rule));
  const withoutHashValue: JsonObject = {
    early_rules: early,
    settled_rules: settled,
    no_match: source.no_match,
    early_close: source.early_close,
  };
  return {
    ...withoutHashValue,
    policy_hash: hash(COMPLETION_POLICY_DOMAIN, withoutHashValue),
  };
}

function complexitySummary(
  context: CompileContext,
  nodes: JsonObject[],
  controlEdges: JsonObject[],
  dataEdges: JsonObject[],
  completion: JsonObject,
): JsonObject {
  const fanOut = new Map<string, number>();
  for (const edge of [...controlEdges, ...dataEdges]) {
    const from =
      edge.from_node_id ?? object(edge.from ?? {}, 'data source').node_id;
    if (typeof from === 'string') fanOut.set(from, (fanOut.get(from) ?? 0) + 1);
  }
  const maxCondition = Math.max(
    0,
    ...controlEdges.map((edge) =>
      edge.condition_program
        ? Number(object(edge.condition_program, 'condition program').max_steps)
        : 0,
    ),
  );
  const maxTrigger = Math.max(
    0,
    ...nodes.map((node) =>
      Number(object(node.trigger_program, 'trigger program').max_steps),
    ),
  );
  const rules = [
    ...objects(completion.early_rules, 'compiled early rules'),
    ...objects(completion.settled_rules, 'compiled settled rules'),
  ];
  const maxCompletion = Math.max(
    0,
    ...rules.map((rule) => Number(rule.max_steps)),
  );
  const withoutHashValue: JsonObject = {
    node_count: nodes.length,
    control_edge_count: controlEdges.length,
    data_edge_count: dataEdges.length,
    max_source_fan_out: Math.max(0, ...fanOut.values()),
    max_condition_steps: maxCondition,
    max_trigger_steps: maxTrigger,
    max_completion_steps: maxCompletion,
    max_reconcile_facts_per_ingress:
      nodes.length + controlEdges.length + dataEdges.length,
    max_frontier_bytes: Number(
      object(context.safety.scope, 'scope safety').max_frontier_bytes,
    ),
  };
  return {
    ...withoutHashValue,
    summary_hash: hash(COMPLEXITY_SUMMARY_DOMAIN, withoutHashValue),
  };
}

function catalogHash(
  context: CompileContext,
  type: string,
  domain: string,
): Sha256Hash {
  const entries = context.resources
    .filter((entry) => entry.resource_type === type)
    .map((entry) => ({
      ref: clone(object(entry.ref, 'catalog ref')),
      hash: entry.content_hash,
    }))
    .sort((left, right) =>
      ascii(
        refKey(object(left.ref, 'left catalog ref')),
        refKey(object(right.ref, 'right catalog ref')),
      ),
    );
  return hash(domain, entries);
}

function compileGraph(
  context: CompileContext,
  source: JsonObject,
  ownerPath: string[] = [],
): CompiledGraph & {
  proofHashes: Sha256Hash[];
  programHashes: Sha256Hash[];
  closureMembers: JsonObject[];
} {
  const sourceHash = hash(GRAPH_SOURCE_DOMAIN, source);
  const rootInterface = cleanInterface(
    findInterface(context, object(source.interface_ref, 'scope interface ref')),
  );
  const rootPolicy = effectivePolicy(
    context.rootPolicy,
    object(source.requested_limits, 'scope requested limits'),
  );
  const sourceNodes = objects(source.nodes, 'source nodes');
  const nodes = [...sourceNodes]
    .sort((left, right) => ascii(String(left.id), String(right.id)))
    .map((node) => {
      if (node.type === 'delegation' || node.type === 'system') {
        return capabilityNode(context, node);
      }
      if (node.type === 'wait') return waitNode(context, node);
      if (node.type === 'terminal') return terminalNode(context, node);
      if (node.type === 'join') return joinNode(context, node);
      if (
        node.type === 'subgraph' ||
        node.type === 'expand' ||
        node.type === 'map'
      ) {
        return structuralNode(context, node, ownerPath);
      }
      throw new Error(`Unsupported current G2 node type: ${String(node.type)}`);
    });
  const nodesById = new Map(
    nodes.map((node) => [string(node.id, 'compiled node id'), node]),
  );
  const controlEdges = compileControlEdges(
    context,
    objects(source.control_edges, 'source control edges'),
    nodesById,
  );
  const routeGroups = compileRouteGroups(
    objects(source.route_groups ?? [], 'source route groups'),
    controlEdges,
  );
  const dataEdges = compileDataEdges(
    context,
    objects(source.data_edges, 'source data edges'),
    nodesById,
    rootInterface,
  );
  const completion = compileCompletion(context, source.completion);
  const closureWithoutHash: JsonObject = {
    members: context.closureMembers,
    member_count: context.closureMembers.length,
  };
  const identity = context.identity;
  const planWithoutHash: JsonObject = {
    format: 'icarus.workflow-graph-scope-plan/2',
    compiler_version: identity.compiler_version,
    compiler_build_hash: identity.compiler_build_hash,
    compiler_toolchain_ref: clone(
      object(
        identity.compiler_toolchain_manifest_ref,
        'compiler toolchain ref',
      ),
    ),
    compiler_toolchain_hash: identity.compiler_toolchain_hash,
    compiler_error_catalog_hash: identity.error_catalog_hash,
    canonical_normalizer_version: identity.canonical_normalizer_version,
    canonical_normalizer_hash: identity.canonical_normalizer_hash,
    proof_algorithm_version: identity.proof_algorithm_version,
    proof_algorithm_hash: identity.proof_algorithm_hash,
    source_hash: sourceHash,
    interface_snapshot_hash: hash(
      'icarus:workflow-scope-interface:1\n',
      rootInterface,
    ),
    policy_snapshot_hash: hash(
      'icarus:workflow-effective-policy:1\n',
      rootPolicy,
    ),
    effective_policy_snapshot: rootPolicy,
    capability_catalog_hash: catalogHash(
      context,
      'capability',
      CAPABILITY_CATALOG_DOMAIN,
    ),
    wait_contract_catalog_hash: catalogHash(
      context,
      'wait_contract',
      WAIT_CATALOG_DOMAIN,
    ),
    interface_snapshot: rootInterface,
    nodes,
    route_groups: routeGroups,
    control_edges: controlEdges,
    data_edges: dataEdges,
    completion,
    complexity_summary: complexitySummary(
      context,
      nodes,
      controlEdges,
      dataEdges,
      completion,
    ),
    static_child_plan_closure: {
      ...closureWithoutHash,
      closure_hash: hash(
        STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
        closureWithoutHash,
      ),
    },
    effective_limits: clone(object(rootPolicy.limits, 'effective limits')),
    effective_usage_budget: clone(
      object(rootPolicy.usage_budget, 'effective usage budget'),
    ),
    runtime_safety_snapshot: clone(context.safety),
    runtime_safety_hash: string(
      object(context.snapshot.safety_snapshot, 'safety snapshot')
        .source_artifact_hash,
      'runtime safety hash',
    ),
  };
  const plan: JsonObject = {
    ...planWithoutHash,
    plan_hash: hash(COMPILED_PLAN_V2_DOMAIN_SEPARATOR, planWithoutHash),
  };
  return {
    plan,
    sourceHash,
    proofHashes: [...context.proofHashes],
    programHashes: [...context.programHashes],
    closureMembers: [...context.closureMembers],
  };
}
