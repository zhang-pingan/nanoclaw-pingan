import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  COMPILER_DIAGNOSTIC_PHASES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import { COMPILED_CONDITION_OPERAND_TYPES } from './compiler-contract-repair-types.js';
import { SHA256_HASH_PATTERN } from './hash.js';
import {
  assertJsonObject,
  strictParseJson,
  strictParseJsonBytes,
} from './strict-json.js';
import type { JsonObject } from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const STABLE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$';
const CLOSURE_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,510}$';
const POINTER_PATTERN = '^(?:/(?:[^~/]|~[01])*)*$';

type Schema = JsonObject;

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function string(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function enumString(values: readonly string[]): Schema {
  return { type: 'string', enum: [...values] };
}

function integer(minimum = 0): Schema {
  return { type: 'integer', minimum, maximum: SAFE_INTEGER_MAX };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

function object(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const optionalKeys = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optionalKeys.has(key)),
    properties,
  };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] };
}

const hashSchema = string({ pattern: SHA256_HASH_PATTERN });
const stableIdSchema = string({
  minLength: 1,
  maxLength: 255,
  pattern: STABLE_ID_PATTERN,
});
const versionedRefSchema = object({
  id: string({
    minLength: 1,
    maxLength: 255,
    pattern: VERSIONED_REF_ID_PATTERN,
  }),
  version: string({
    minLength: 1,
    maxLength: 64,
    pattern: VERSIONED_REF_VERSION_PATTERN,
  }),
});
const jsonValueSchema: Schema = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { type: 'array', items: ref('json_value') },
    { type: 'object', additionalProperties: ref('json_value') },
  ],
};

function readCompiledPlanSchema(): Schema {
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(
        path.join(contractsRoot, 'schemas/compiled-scope-plan-schema.json'),
      ),
    ),
  );
  return strictParseJson(JSON.stringify(artifact.payload)) as Schema;
}

function staticClosureMemberSchema(): Schema {
  return object({
    closure_key: string({ pattern: CLOSURE_KEY_PATTERN }),
    parent_closure_key: nullable(string({ pattern: CLOSURE_KEY_PATTERN })),
    scope_key: stableIdSchema,
    owner_node_path: array(stableIdSchema, { minItems: 1 }),
    factory_kind: enumString(['inline', 'template']),
    source_ref: nullable(versionedRefSchema),
    source_hash: hashSchema,
    plan_ref: string({ minLength: 1 }),
    plan_hash: hashSchema,
    interface_snapshot_hash: hashSchema,
    member_hash: hashSchema,
  });
}

function outboxReconciliationSchema(): Schema {
  return {
    oneOf: [
      object({ type: { const: 'not_required' } }),
      object({
        type: { const: 'by_effect_key' },
        reconcile_action_ref: versionedRefSchema,
      }),
    ],
  };
}

function outboxEffectContractSchema(): Schema {
  return object({
    effect_type: { const: 'capability_dispatch' },
    adapter_ref: versionedRefSchema,
    delivery_policy_ref: versionedRefSchema,
    delivery_lane: { const: 'normal_execution' },
    reconciliation: ref('outbox_reconciliation'),
    idempotency: enumString(['provider_key', 'external_lookup']),
    delivery_requirement: { const: 'required' },
  });
}

function outboxDeliveryPolicySchema(): Schema {
  return object({
    format: { const: 'icarus.workflow-outbox-delivery-policy/1' },
    ref: versionedRefSchema,
    max_delivery_attempts: integer(1),
    max_reconcile_attempts: integer(0),
    delivery_duration_ms: integer(1),
    attempt_timeout_ms: integer(1),
    initial_backoff_ms: integer(0),
    max_backoff_ms: integer(0),
    backoff: enumString(['fixed', 'exponential']),
    deterministic_jitter_micros: {
      type: 'integer',
      minimum: 0,
      maximum: 1_000_000,
    },
    honor_retry_after: { type: 'boolean' },
    retryable_error_codes: array(stableIdSchema, { uniqueItems: true }),
    permanent_error_codes: array(stableIdSchema, { uniqueItems: true }),
    policy_hash: hashSchema,
  });
}

function effectiveOutboxDeliveryPolicySchema(): Schema {
  return object({
    max_delivery_attempts: integer(1),
    max_reconcile_attempts: integer(0),
    delivery_duration_ms: integer(1),
    attempt_timeout_ms: integer(1),
    initial_backoff_ms: integer(0),
    max_backoff_ms: integer(0),
    backoff: enumString(['fixed', 'exponential']),
    deterministic_jitter_micros: {
      type: 'integer',
      minimum: 0,
      maximum: 1_000_000,
    },
    honor_retry_after: { type: 'boolean' },
    retryable_error_codes: array(stableIdSchema, { uniqueItems: true }),
    permanent_error_codes: array(stableIdSchema, { uniqueItems: true }),
  });
}

function compiledOutboxExecutionBindingSchema(): Schema {
  return object({
    effect_contract: ref('outbox_effect_contract'),
    adapter_identity: object({
      resource_type: { const: 'outbox_adapter' },
      ref: versionedRefSchema,
      content_hash: hashSchema,
    }),
    delivery_policy_identity: object({
      resource_type: { const: 'outbox_policy' },
      ref: versionedRefSchema,
      content_hash: hashSchema,
    }),
    effective_policy_snapshot: object({
      format: { const: 'icarus.workflow-outbox-effective-policy-snapshot/1' },
      source_policy_ref: versionedRefSchema,
      source_policy_content_hash: hashSchema,
      source_policy_hash: hashSchema,
      effective_policy: ref('effective_outbox_delivery_policy'),
      runtime_safety_hash: hashSchema,
      snapshot_hash: hashSchema,
    }),
    binding_hash: hashSchema,
  });
}

export function buildCompiledScopePlanV2Schema(): Schema {
  const schema = readCompiledPlanSchema();
  schema.$id = 'https://icarus.local/schemas/compiled-scope-plan-v2';
  schema.title = 'icarus.workflow-graph-scope-plan/2';
  assertJsonObject(schema.properties);
  schema.properties.format = {
    const: 'icarus.workflow-graph-scope-plan/2',
  };
  if (!Array.isArray(schema.required)) {
    throw new Error('Compiled IR required list is missing');
  }
  schema.required = schema.required.map((key) =>
    key === 'static_child_plan_closure_hash'
      ? 'static_child_plan_closure'
      : key,
  );
  delete schema.properties.static_child_plan_closure_hash;
  schema.properties.static_child_plan_closure = ref(
    'static_child_plan_closure',
  );

  assertJsonObject(schema.$defs);
  const definitions = schema.$defs;
  assertJsonObject(definitions.compiled_condition_program);
  const conditionProgram = definitions.compiled_condition_program;
  assertJsonObject(conditionProgram.properties);
  conditionProgram.required = [
    'normalized_ast',
    'operand_schema_hashes',
    'operand_types',
    'max_steps',
    'program_hash',
  ];
  conditionProgram.properties.operand_types = array(
    enumString(COMPILED_CONDITION_OPERAND_TYPES),
    { minItems: 1 },
  );

  assertJsonObject(definitions.compiled_node);
  const compiledNode = definitions.compiled_node;
  if (!Array.isArray(compiledNode.oneOf)) {
    throw new Error('Compiled-node union is missing');
  }
  const mapBranch = compiledNode.oneOf.find((candidate) => {
    assertJsonObject(candidate);
    assertJsonObject(candidate.properties);
    assertJsonObject(candidate.properties.type);
    return candidate.properties.type.const === 'map';
  });
  if (!mapBranch) throw new Error('CompiledMapNode is missing');
  assertJsonObject(mapBranch);
  assertJsonObject(mapBranch.properties);
  if (!Array.isArray(mapBranch.required)) {
    throw new Error('CompiledMapNode required list is missing');
  }
  if (!mapBranch.required.includes('result_order')) {
    mapBranch.required = [...mapBranch.required, 'result_order'];
  }
  mapBranch.properties.result_order = { const: 'item_index' };

  definitions.static_child_plan_closure_member = staticClosureMemberSchema();
  definitions.static_child_plan_closure = object({
    members: array(ref('static_child_plan_closure_member'), {
      uniqueItems: true,
    }),
    member_count: integer(),
    closure_hash: hashSchema,
  });
  return schema;
}

export function buildCompiledScopePlanV2ExecutionBindingSchema(): Schema {
  const schema = buildCompiledScopePlanV2Schema();
  schema.$id =
    'https://icarus.local/schemas/compiled-scope-plan-v2-execution-binding';
  schema.title = 'icarus.workflow-graph-scope-plan/2 execution binding';
  assertJsonObject(schema.$defs);
  const definitions = schema.$defs;
  definitions.outbox_reconciliation = outboxReconciliationSchema();
  definitions.outbox_effect_contract = outboxEffectContractSchema();
  definitions.outbox_delivery_policy = outboxDeliveryPolicySchema();
  definitions.effective_outbox_delivery_policy =
    effectiveOutboxDeliveryPolicySchema();
  definitions.compiled_outbox_execution_binding =
    compiledOutboxExecutionBindingSchema();

  assertJsonObject(definitions.workflow_capability);
  const capability = definitions.workflow_capability;
  assertJsonObject(capability.properties);
  if (!Array.isArray(capability.required)) {
    throw new Error('WorkflowGraphCapability required list is missing');
  }
  if (!capability.required.includes('outbox_effect')) {
    capability.required = [...capability.required, 'outbox_effect'];
  }
  capability.properties.outbox_effect = ref('outbox_effect_contract');

  assertJsonObject(definitions.compiled_node);
  if (!Array.isArray(definitions.compiled_node.oneOf)) {
    throw new Error('Compiled node union is missing');
  }
  for (const candidate of definitions.compiled_node.oneOf) {
    assertJsonObject(candidate);
    assertJsonObject(candidate.properties);
    assertJsonObject(candidate.properties.type);
    if (
      candidate.properties.type.const !== 'delegation' &&
      candidate.properties.type.const !== 'system'
    ) {
      continue;
    }
    if (!Array.isArray(candidate.required)) {
      throw new Error('CompiledCapabilityNode required list is missing');
    }
    if (!candidate.required.includes('outbox_execution_binding')) {
      candidate.required = [...candidate.required, 'outbox_execution_binding'];
    }
    candidate.properties.outbox_execution_binding = ref(
      'compiled_outbox_execution_binding',
    );
  }
  return schema;
}

const diagnosticSchema = object({
  code: enumString(WORKFLOW_COMPILER_ERROR_CODES),
  phase: enumString(COMPILER_DIAGNOSTIC_PHASES),
  instance_pointer: string({ pattern: POINTER_PATTERN }),
  schema_pointer: nullable(string({ pattern: '^#(?:/(?:[^~/]|~[01])*)*$' })),
  stable_object_id: nullable(string({ minLength: 1, maxLength: 255 })),
  detail_ref: nullable(string({ minLength: 1 })),
});

function buildCompilerConformanceCaseResultSchemaForPlan(
  planSchema: Schema,
  schemaId: string,
): Schema {
  assertJsonObject(planSchema.$defs);
  const {
    $schema: _planDialect,
    $id: _planId,
    title: _planTitle,
    $defs: _planDefinitions,
    ...planRoot
  } = planSchema;
  const common = {
    format: {
      const: 'icarus.workflow-compiler-conformance-case-result/1',
    },
    case_id: stableIdSchema,
    source_kind: enumString([
      'graph_scope',
      'workflow_definition',
      'workflow_schema',
    ]),
    proof_hashes: array(hashSchema, { uniqueItems: true }),
    program_hashes: array(hashSchema, { uniqueItems: true }),
    result_hash: hashSchema,
  };
  const compiled = (withStaticLowering: boolean): Schema =>
    object({
      ...common,
      source_hash: hashSchema,
      outcome: { const: 'compiled' },
      normalized_plan: ref('compiled_scope_plan_v2'),
      static_lowering_contract_ref: withStaticLowering
        ? versionedRefSchema
        : { type: 'null' },
      static_lowering_contract_hash: withStaticLowering
        ? hashSchema
        : { type: 'null' },
      diagnostics: array(diagnosticSchema, { maxItems: 0 }),
    });
  const rejected = object({
    ...common,
    source_hash: nullable(hashSchema),
    outcome: { const: 'rejected' },
    normalized_plan: { type: 'null' },
    static_lowering_contract_ref: { type: 'null' },
    static_lowering_contract_hash: { type: 'null' },
    diagnostics: array(diagnosticSchema, { minItems: 1 }),
  });
  return {
    $schema: DRAFT_2020_12,
    $id: schemaId,
    title: 'icarus.workflow-compiler-conformance-case-result/1',
    oneOf: [compiled(true), compiled(false), rejected],
    $defs: {
      ...planSchema.$defs,
      compiled_scope_plan_v2: planRoot,
      json_value: jsonValueSchema,
      versioned_ref: versionedRefSchema,
    },
  };
}

export function buildCompilerConformanceCaseResultSchema(): Schema {
  return buildCompilerConformanceCaseResultSchemaForPlan(
    buildCompiledScopePlanV2Schema(),
    'https://icarus.local/schemas/compiler-conformance-case-result-v1',
  );
}

export function buildCompilerConformanceCaseResultExecutionBindingSchema(): Schema {
  return buildCompilerConformanceCaseResultSchemaForPlan(
    buildCompiledScopePlanV2ExecutionBindingSchema(),
    'https://icarus.local/schemas/compiler-conformance-case-result-execution-binding-v1',
  );
}
