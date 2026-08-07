import {
  CARD_PRESENTATION_REQUIRED_KEYS,
  CARD_PRESENTATION_KEYS,
  COMPILED_SCOPE_PLAN_REQUIRED_KEYS,
  COMPILED_SCOPE_PLAN_KEYS,
  FEATURE_MANIFEST_REQUIRED_KEYS,
  FEATURE_MANIFEST_KEYS,
  FEATURE_WORKFLOW_RESOURCE_KINDS,
  GRAPH_NODE_TYPES,
  GRAPH_SCOPE_SOURCE_REQUIRED_KEYS,
  GRAPH_SCOPE_SOURCE_KEYS,
  WORKFLOW_COMMAND_REASON_CODES,
  WORKFLOW_COMMAND_TYPES,
  WORKFLOW_DEFINITION_REQUIRED_KEYS,
  WORKFLOW_GRAPH_INPUT_BINDING_SOURCES,
  WORKFLOW_RECIPE_REQUIRED_KEYS,
  WORKFLOW_RUNTIME_COMMAND_REQUIRED_KEYS,
  WORKFLOW_STATE_TYPES,
  WORKFLOW_TRANSITION_EFFECT_INPUT_SOURCES,
  WORKFLOW_TRANSITION_REQUIRED_KEYS,
  WORKFLOW_VALUE_BINDING_SOURCES,
  WORKFLOW_DEFINITION_KEYS,
  WORKFLOW_RECIPE_KEYS,
  WORKFLOW_RUNTIME_COMMAND_KEYS,
  WORKFLOW_TRANSITION_KEYS,
} from './closed-schema-types.js';
import { SHA256_HASH_PATTERN, calculateArtifactHash } from './hash.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';
import { assertJsonObject, strictParseJson } from './strict-json.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const STABLE_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$';
const PORT_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$';
const JSON_POINTER_PATTERN = '^(?:/(?:[^~/]|~[01])*)*$';

type Schema = JsonObject;

function ref(name: string): Schema {
  return { $ref: `#/$defs/${name}` };
}

function stringSchema(options: JsonObject = {}): Schema {
  return { type: 'string', ...options };
}

function enumSchema(values: readonly string[]): Schema {
  return { type: 'string', enum: [...values] };
}

function integerSchema(minimum = 0): Schema {
  return {
    type: 'integer',
    minimum,
    maximum: SAFE_INTEGER_MAX,
  };
}

function safeIntegerSchema(): Schema {
  return {
    type: 'integer',
    minimum: -SAFE_INTEGER_MAX,
    maximum: SAFE_INTEGER_MAX,
  };
}

function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: 'null' }] };
}

function array(items: Schema, options: JsonObject = {}): Schema {
  return { type: 'array', items, ...options };
}

function object(
  properties: Record<string, Schema>,
  optional: readonly string[] = [],
): Schema {
  const optionalSet = new Set(optional);
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optionalSet.has(key)),
    properties,
  };
}

function record(values: Schema, keyPattern = PORT_KEY_PATTERN): Schema {
  return {
    type: 'object',
    propertyNames: { type: 'string', pattern: keyPattern },
    additionalProperties: values,
  };
}

function strictRecord(values: Schema, keyPattern = PORT_KEY_PATTERN): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    patternProperties: { [keyPattern]: values },
  };
}

const versionedRefSchema = object({
  id: stringSchema({
    minLength: 1,
    maxLength: 255,
    pattern: VERSIONED_REF_ID_PATTERN,
  }),
  version: {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    pattern: VERSIONED_REF_VERSION_PATTERN,
    not: {
      anyOf: [
        {
          pattern:
            '^(?:[Cc][Uu][Rr][Rr][Ee][Nn][Tt]|[Hh][Ee][Aa][Dd]|[Ll][Aa][Tt][Ee][Ss][Tt]|[Mm][Aa][Ii][Nn]|[Mm][Aa][Ss][Tt][Ee][Rr]|[Nn][Ee][Xx][Tt]|[Ss][Nn][Aa][Pp][Ss][Hh][Oo][Tt])$',
        },
        { pattern: '(?:^|[._-])[xX](?:$|[._-])' },
      ],
    },
  },
});

const hashSchema = stringSchema({ pattern: SHA256_HASH_PATTERN });
const stableKeySchema = stringSchema({
  minLength: 1,
  maxLength: 255,
  pattern: STABLE_KEY_PATTERN,
});
const pointerSchema = stringSchema({ pattern: JSON_POINTER_PATTERN });
const positiveIntegerSchema = integerSchema(1);
const nullablePositiveIntegerSchema = nullable(positiveIntegerSchema);
const nullableNonnegativeIntegerSchema = nullable(integerSchema());

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

const valueBindingSchema: Schema = {
  oneOf: [
    object(
      {
        source: { const: 'workflow_input' },
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object(
      {
        source: { const: 'context_slot' },
        slot: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object(
      {
        source: { const: 'completed_output' },
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object(
      {
        source: { const: 'artifact' },
        ref: stringSchema({ minLength: 1 }),
        json_pointer: pointerSchema,
      },
      ['json_pointer'],
    ),
    object({ source: { const: 'constant' }, value: ref('json_value') }),
  ],
};

const graphInputBindingSchema: Schema = {
  oneOf: (valueBindingSchema.oneOf as JsonValue[]).filter((branch) => {
    const candidate = branch as JsonObject;
    const properties = candidate.properties as JsonObject;
    const source = properties.source as JsonObject;
    return source.const !== 'completed_output';
  }),
};

const nullableGraphLimitsSchema = object({
  max_scopes: nullableNonnegativeIntegerSchema,
  max_nodes: nullableNonnegativeIntegerSchema,
  max_nodes_per_scope: nullableNonnegativeIntegerSchema,
  max_edges_per_scope: nullableNonnegativeIntegerSchema,
  max_nesting_depth: nullableNonnegativeIntegerSchema,
  max_map_items: nullableNonnegativeIntegerSchema,
  max_concurrency: nullableNonnegativeIntegerSchema,
  max_total_attempts: nullableNonnegativeIntegerSchema,
  max_total_waits: nullableNonnegativeIntegerSchema,
  max_total_output_bytes: nullableNonnegativeIntegerSchema,
  max_scope_spec_bytes: nullableNonnegativeIntegerSchema,
  max_condition_steps: nullableNonnegativeIntegerSchema,
  max_wait_duration_ms: nullableNonnegativeIntegerSchema,
  max_pending_signals: nullableNonnegativeIntegerSchema,
  max_fixed_point_facts: nullableNonnegativeIntegerSchema,
  max_frontier_bytes: nullableNonnegativeIntegerSchema,
});

const nullableUsageBudgetSchema = object({
  max_total_tool_calls: nullableNonnegativeIntegerSchema,
  max_total_input_tokens: nullableNonnegativeIntegerSchema,
  max_total_output_tokens: nullableNonnegativeIntegerSchema,
  max_total_cost_micros: nullableNonnegativeIntegerSchema,
});

const effectRecoveryKinds = ['pure', 'idempotent', 'compensatable'] as const;
const effectImpacts = ['read_only', 'mutable_effects', 'irreversible'] as const;

const graphPolicySchema = object({
  allowed_node_types: array(enumSchema(GRAPH_NODE_TYPES), {
    uniqueItems: true,
  }),
  allowed_capabilities: array(ref('versioned_ref'), { uniqueItems: true }),
  allowed_templates: array(ref('versioned_ref'), { uniqueItems: true }),
  allowed_interface_refs: array(ref('versioned_ref'), { uniqueItems: true }),
  allowed_wait_contracts: array(ref('versioned_ref'), { uniqueItems: true }),
  allowed_child_policy_refs: array(ref('versioned_ref'), { uniqueItems: true }),
  allowed_claim_ids: array(stableKeySchema, { uniqueItems: true }),
  allow_early_close: { type: 'boolean' },
  allow_indefinite_waits: { type: 'boolean' },
  effect_policy: object({
    allowed_recovery_kinds: array(enumSchema(effectRecoveryKinds), {
      uniqueItems: true,
    }),
    max_impact: enumSchema(effectImpacts),
  }),
  build_retry: nullable(
    object({
      max_attempts: nullablePositiveIntegerSchema,
      initial_backoff_ms: positiveIntegerSchema,
      max_backoff_ms: nullablePositiveIntegerSchema,
      max_duration_ms: nullablePositiveIntegerSchema,
    }),
  ),
  limits: nullableGraphLimitsSchema,
  usage_budget: nullableUsageBudgetSchema,
});

const waitSourceSchema: Schema = {
  oneOf: [
    object(
      {
        type: { const: 'signal' },
        contract_ref: ref('versioned_ref'),
        correlation_input_port: stableKeySchema,
        timeout_ms: positiveIntegerSchema,
      },
      ['timeout_ms'],
    ),
    object({
      type: { const: 'timer' },
      contract_ref: ref('versioned_ref'),
      deadline_input_port: stableKeySchema,
    }),
    object(
      {
        type: { const: 'approval' },
        contract_ref: ref('versioned_ref'),
        correlation_input_port: stableKeySchema,
        timeout_ms: positiveIntegerSchema,
      },
      ['timeout_ms'],
    ),
  ],
};

const contextPatchSchema = object({
  set: strictRecord(ref('value_binding')),
  clear: array(stableKeySchema, { uniqueItems: true }),
});

const transitionEffectSchema: Schema = {
  oneOf: [
    object({
      id: stableKeySchema,
      type: { const: 'start_child_workflow' },
      recipe_ref: ref('versioned_ref'),
      routing_scope_ref: ref('versioned_ref'),
      principal_binding: { const: 'inherit_parent_principal' },
      creation_domain: { const: 'parent_workflow_lineage' },
      relation_kind: enumSchema([
        'follow_up',
        'background',
        'validation',
        'domain_defined',
      ]),
      input_bindings: strictRecord({
        oneOf: [
          object(
            {
              source: { const: 'context_slot' },
              slot: stableKeySchema,
              pointer: pointerSchema,
            },
            ['pointer'],
          ),
          object(
            {
              source: { const: 'completed_output' },
              port: stableKeySchema,
              pointer: pointerSchema,
            },
            ['pointer'],
          ),
          object({ source: { const: 'constant' }, value: ref('json_value') }),
        ],
      }),
      delivery_requirement: { const: 'required' },
      finalization_policy_ref: ref('versioned_ref'),
    }),
    object({
      id: stableKeySchema,
      type: { const: 'start_child_workflow' },
      recipe_ref: ref('versioned_ref'),
      routing_scope_ref: ref('versioned_ref'),
      principal_binding: { const: 'inherit_parent_principal' },
      creation_domain: { const: 'parent_workflow_lineage' },
      relation_kind: enumSchema([
        'follow_up',
        'background',
        'validation',
        'domain_defined',
      ]),
      input_bindings: strictRecord({
        oneOf: [
          object(
            {
              source: { const: 'context_slot' },
              slot: stableKeySchema,
              pointer: pointerSchema,
            },
            ['pointer'],
          ),
          object(
            {
              source: { const: 'completed_output' },
              port: stableKeySchema,
              pointer: pointerSchema,
            },
            ['pointer'],
          ),
          object({ source: { const: 'constant' }, value: ref('json_value') }),
        ],
      }),
      delivery_requirement: { const: 'best_effort' },
      outbox_delivery_policy_ref: ref('versioned_ref'),
    }),
  ],
};

const transitionSchema = object(
  {
    target: stableKeySchema,
    context_patch: ref('context_patch'),
    notify: object({
      contract_ref: ref('versioned_ref'),
      input_bindings: strictRecord(ref('value_binding')),
    }),
    card: object({ ref: ref('versioned_ref') }),
    effects: object({
      operations: array(ref('transition_effect'), {
        minItems: 1,
      }),
    }),
  },
  ['context_patch', 'notify', 'card', 'effects'],
);

function stateCommon(type: string): Record<string, Schema> {
  return {
    type: { const: type },
    label: stringSchema({ minLength: 1 }),
    description: stringSchema({ minLength: 1 }),
  };
}

function capabilityStateSchema(type: 'delegation' | 'system'): Schema {
  return object(
    {
      ...stateCommon(type),
      capability_ref: ref('versioned_ref'),
      policy: ref('graph_policy'),
      input_bindings: strictRecord(ref('graph_input_binding')),
      retry_request: nullable(
        object({
          max_attempts: nullablePositiveIntegerSchema,
          retry_on: nullable(array(stableKeySchema, { uniqueItems: true })),
        }),
      ),
      timeout_ms: nullablePositiveIntegerSchema,
      on_complete: object({
        success: ref('transition'),
        failure: ref('transition'),
      }),
      on_error: ref('transition'),
      on_local_cancel: ref('transition'),
    },
    ['label', 'description'],
  );
}

const workflowDefinitionSchema = object({
  format: { const: 'icarus.workflow-definition/1' },
  ref: ref('versioned_ref'),
  owner_feature_id: nullable(stableKeySchema),
  name: stringSchema({ minLength: 1, maxLength: 255 }),
  context_contract_ref: ref('versioned_ref'),
  entry_points: strictRecord(object({ state_key: stableKeySchema })),
  states: strictRecord({
    oneOf: [
      capabilityStateSchema('delegation'),
      capabilityStateSchema('system'),
      object(
        {
          ...stateCommon('interrupt'),
          wait: ref('wait_source'),
          policy: ref('graph_policy'),
          input_bindings: strictRecord(ref('graph_input_binding')),
          on_resume: strictRecord(ref('transition')),
          on_expire: nullable(ref('transition')),
          on_wait_cancelled: nullable(ref('transition')),
          on_error: ref('transition'),
          on_local_cancel: ref('transition'),
        },
        ['label', 'description'],
      ),
      object(
        {
          ...stateCommon('graph'),
          graph_source: {
            oneOf: [
              object({ type: { const: 'inline' }, scope: ref('graph_scope') }),
              object({
                type: { const: 'context_slot' },
                slot: stableKeySchema,
              }),
              object(
                {
                  type: { const: 'artifact' },
                  ref: stringSchema({ minLength: 1 }),
                  json_pointer: pointerSchema,
                },
                ['json_pointer'],
              ),
              object({
                type: { const: 'template' },
                template_ref: ref('versioned_ref'),
              }),
            ],
          },
          input_bindings: strictRecord(ref('graph_input_binding')),
          root_interface_ref: ref('versioned_ref'),
          policy: ref('graph_policy'),
          exit_routes: strictRecord(ref('transition')),
          on_error: ref('transition'),
          on_local_cancel: ref('transition'),
          on_temporary_replan: ref('transition'),
        },
        ['label', 'description', 'input_bindings', 'on_temporary_replan'],
      ),
      object(
        {
          ...stateCommon('terminal'),
          terminal_kind: { const: 'normal' },
          output_binding: ref('value_binding'),
        },
        ['label', 'description'],
      ),
      object(
        {
          ...stateCommon('terminal'),
          terminal_kind: { const: 'errored' },
          error_code: stableKeySchema,
          error_binding: nullable(ref('value_binding')),
        },
        ['label', 'description'],
      ),
    ],
  }),
  definition_hash: hashSchema,
});

const workflowRecipeSchema = object({
  ref: ref('versioned_ref'),
  owner_feature_id: nullable(stableKeySchema),
  recipe_family: stableKeySchema,
  task_kinds: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
  workflow_definition_ref: ref('versioned_ref'),
  entry_point: stableKeySchema,
  workflow_execution_policy_ref: ref('versioned_ref'),
  context_contract_ref: ref('versioned_ref'),
  workflow_command_policy_ref: ref('versioned_ref'),
  input_schema_ref: ref('versioned_ref'),
  output_schema_ref: ref('versioned_ref'),
  launch_policy: enumSchema(['auto', 'confirm', 'manual_only']),
  effect_ceiling: enumSchema(effectImpacts),
  derived_effect_summary: object({
    max_impact: enumSchema(effectImpacts),
    recovery_kinds: array(enumSchema(effectRecoveryKinds), {
      uniqueItems: true,
    }),
    permission_refs: array(stableKeySchema, { uniqueItems: true }),
    dependency_closure_hash: hashSchema,
  }),
  required_permissions: array(stableKeySchema, { uniqueItems: true }),
  allowed_child_recipe_refs: array(ref('versioned_ref'), { uniqueItems: true }),
  resource_claims: array(
    object({
      id: stableKeySchema,
      namespace: stableKeySchema,
      mode: enumSchema(['shared', 'exclusive']),
      key_json_pointers: array(pointerSchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      hold_until: { const: 'workflow_terminal' },
    }),
    { uniqueItems: true },
  ),
  recipe_hash: hashSchema,
});

const commandBaseProperties: Record<string, Schema> = {
  command_id: stableKeySchema,
  idempotency_key: stringSchema({ minLength: 1, maxLength: 512 }),
  expected_row_version: integerSchema(),
  reason_code: enumSchema(WORKFLOW_COMMAND_REASON_CODES),
  reason_text: stringSchema({ minLength: 1, maxLength: 4096 }),
  evidence_refs: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
};

function commandBranch(
  commandType: string,
  targetKey: string,
  extraProperties: Record<string, Schema> = {},
): Schema {
  return object(
    {
      ...commandBaseProperties,
      command_type: { const: commandType },
      target: object({ [targetKey]: stringSchema({ minLength: 1 }) }),
      ...extraProperties,
    },
    ['reason_text'],
  );
}

const commandTargets: ReadonlyArray<readonly [string, string]> = [
  ['pause_run', 'run_id'],
  ['resume_run', 'run_id'],
  ['cancel_run', 'run_id'],
  ['cancel_workflow', 'workflow_id'],
  ['skip_node', 'node_id'],
  ['advance_retry_schedule', 'retry_schedule_id'],
  ['reconcile_effect', 'effect_operation_id'],
  ['submit_effect_receipt', 'effect_operation_id'],
  ['verify_effect_not_applied', 'effect_operation_id'],
  ['remediate_operational_blocker', 'operational_blocker_id'],
  ['restore_integrity', 'operational_blocker_id'],
  ['request_administrative_abandon', 'workflow_id'],
];

const workflowRuntimeCommandSchema: Schema = {
  oneOf: [
    ...commandTargets.map(([type, target]) => commandBranch(type, target)),
    commandBranch('confirm_administrative_abandon', 'workflow_id', {
      confirmation_ref: stringSchema({ minLength: 1 }),
    }),
  ],
};

const featureManifestSchema = object({
  format: { const: 'icarus.feature-manifest/2' },
  feature_ref: ref('versioned_ref'),
  namespace: stableKeySchema,
  owner_principal_ref: stringSchema({ minLength: 1 }),
  dependencies: array(
    object({
      feature_release_ref: ref('versioned_ref'),
      feature_release_hash: hashSchema,
      required_resource_refs: array(ref('versioned_ref'), {
        uniqueItems: true,
      }),
    }),
  ),
  package_resources: object({
    skills: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    agents: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    mcp: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    scripts: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    templates: array(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  }),
  extension_surfaces: object({
    api_entry: nullable(stringSchema({ minLength: 1 })),
    nav_entry: nullable(stringSchema({ minLength: 1 })),
    renderer_entry: nullable(stringSchema({ minLength: 1 })),
  }),
  dynamic_workflow_resources: array(
    object({
      kind: enumSchema(FEATURE_WORKFLOW_RESOURCE_KINDS),
      ref: ref('versioned_ref'),
      source_path: stringSchema({
        minLength: 1,
        pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$',
      }),
      expected_source_hash: hashSchema,
    }),
  ),
  ownership: object({
    feature_source_root: stringSchema({ minLength: 1 }),
    workflow_source_root: stringSchema({ minLength: 1 }),
    execution_bundle_owner: { const: 'feature_release' },
    registry_namespace: stableKeySchema,
  }),
  lifecycle: object({
    draining_policy_ref: ref('versioned_ref'),
    retention_policy_ref: ref('versioned_ref'),
    deletion_policy_ref: ref('versioned_ref'),
  }),
  manifest_hash: hashSchema,
});

const cardActionBindingSchema: Schema = {
  oneOf: [
    object({
      action_kind: { const: 'wait_signal' },
      wait_contract_ref: ref('versioned_ref'),
      action_value: stringSchema({ minLength: 1 }),
      correlation_variable: stableKeySchema,
    }),
    object({
      action_kind: { const: 'business_command' },
      business_command_contract_ref: ref('versioned_ref'),
      command_input_variable: stableKeySchema,
    }),
    object({
      action_kind: { const: 'runtime_command' },
      command_type: enumSchema(WORKFLOW_COMMAND_TYPES),
      target_binding: enumSchema([
        'workflow',
        'run',
        'node',
        'retry_schedule',
        'effect_operation',
        'operational_blocker',
      ]),
    }),
  ],
};

const cardPresentationSchema = object({
  format: { const: 'icarus.card-presentation/1' },
  ref: ref('versioned_ref'),
  owner_feature_id: nullable(stableKeySchema),
  template_ref: ref('versioned_ref'),
  template_hash: hashSchema,
  variable_schema_ref: ref('versioned_ref'),
  variable_schema_hash: hashSchema,
  supported_channel_adapters: array(
    object({
      adapter_ref: ref('versioned_ref'),
      adapter_hash: hashSchema,
      render_profile_ref: ref('versioned_ref'),
    }),
    { minItems: 1 },
  ),
  render_limits: object({
    max_payload_bytes: positiveIntegerSchema,
    max_text_bytes: positiveIntegerSchema,
    max_actions: positiveIntegerSchema,
  }),
  fallback_text_template_ref: ref('versioned_ref'),
  actions: array(
    object({
      action_id: stableKeySchema,
      label: stringSchema({ minLength: 1, maxLength: 255 }),
      binding: ref('card_action_binding'),
      required_permission: stableKeySchema,
      idempotency_domain: { const: 'card_interaction' },
      expires_after_ms: positiveIntegerSchema,
    }),
  ),
  snapshot_retention_policy_ref: ref('versioned_ref'),
  deterministic_render_fixture_ref: stringSchema({ minLength: 1 }),
  deterministic_render_fixture_hash: hashSchema,
  contract_hash: hashSchema,
});

const conditionRefSchema: Schema = {
  oneOf: [
    object(
      {
        source: { const: 'scope_input' },
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object(
      {
        source: { const: 'edge_source_output' },
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object({
      source: { const: 'edge_source_fact' },
      field: enumSchema(['status', 'code', 'child_exit']),
    }),
  ],
};

const conditionOperandSchema: Schema = {
  oneOf: [
    object({ literal: ref('json_value') }),
    object({ ref: ref('condition_ref') }),
  ],
};

const conditionExpressionSchema: Schema = {
  oneOf: [
    object({
      op: enumSchema(['and', 'or']),
      args: array(ref('condition_expression'), { minItems: 1 }),
    }),
    object({ op: { const: 'not' }, arg: ref('condition_expression') }),
    object({ op: { const: 'exists' }, value: ref('condition_operand') }),
    object({
      op: enumSchema(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
      left: ref('condition_operand'),
      right: ref('condition_operand'),
    }),
    object({
      op: { const: 'in' },
      value: ref('condition_operand'),
      set: ref('condition_operand'),
    }),
  ],
};

const edgeTruthExpressionSchema: Schema = {
  oneOf: [
    object({
      op: { const: 'edge_is' },
      edge_id: stableKeySchema,
      state: enumSchema(['taken', 'not_taken']),
    }),
    object({
      op: enumSchema(['and', 'or']),
      args: array(ref('edge_truth_expression'), { minItems: 1 }),
    }),
    object({ op: { const: 'not' }, arg: ref('edge_truth_expression') }),
  ],
};

const nodeTriggerSchema: Schema = {
  oneOf: [
    object({ type: { const: 'root' } }),
    object({
      type: { const: 'all' },
      edge_ids: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
    }),
    object({
      type: { const: 'any' },
      edge_ids: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
    }),
    object({
      type: { const: 'quorum' },
      edge_ids: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
      min_taken: positiveIntegerSchema,
    }),
    object({
      type: { const: 'expression' },
      expression: ref('edge_truth_expression'),
    }),
  ],
};

const valuePortContractSchema = object({
  schema_ref: ref('versioned_ref'),
  max_bytes: nullableNonnegativeIntegerSchema,
});

const inputAggregationSchema: Schema = {
  oneOf: [
    object(
      {
        type: { const: 'single' },
        required: { type: 'boolean' },
        select: enumSchema(['only', 'first_resolved', 'lowest_edge_id']),
        default: ref('json_value'),
      },
      ['default'],
    ),
    object({
      type: { const: 'list' },
      min_items: integerSchema(),
      seal: {
        oneOf: [
          object({ type: { const: 'all_sources_resolved' } }),
          object({
            type: { const: 'first_n_available' },
            count: positiveIntegerSchema,
          }),
        ],
      },
      order: enumSchema(['edge_id', 'resolution_seq']),
    }),
  ],
};

const nodeInputPortSchema: Schema = {
  oneOf: [
    object({
      schema_ref: ref('versioned_ref'),
      max_bytes: nullableNonnegativeIntegerSchema,
      aggregation: {
        oneOf: [(inputAggregationSchema.oneOf as JsonValue[])[0]!],
      },
    }),
    object({
      schema_ref: ref('versioned_ref'),
      max_bytes: nullableNonnegativeIntegerSchema,
      aggregation: {
        oneOf: [(inputAggregationSchema.oneOf as JsonValue[])[1]!],
      },
      item_contract: ref('value_port_contract'),
    }),
  ],
};

const nodeOutputPortSchema = object({
  schema_ref: ref('versioned_ref'),
  max_bytes: nullableNonnegativeIntegerSchema,
  required: { type: 'boolean' },
});

function graphNodeCommon(type: string): Record<string, Schema> {
  return {
    id: stableKeySchema,
    type: { const: type },
    label: stringSchema({ minLength: 1 }),
    trigger: ref('node_trigger'),
    metadata: record(ref('json_value')),
  };
}

const staticScopeFactorySchema: Schema = {
  oneOf: [
    object({
      type: { const: 'template' },
      template_ref: ref('versioned_ref'),
    }),
    object({ type: { const: 'inline' }, scope: ref('graph_scope') }),
  ],
};

const portBindingSchema: Schema = {
  oneOf: [
    object(
      {
        source: { const: 'node_input' },
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object({ source: { const: 'literal' }, value: ref('json_value') }),
  ],
};

const childOutputExposeSchema = object({
  from_exit: stableKeySchema,
  child_port: stableKeySchema,
  required: { type: 'boolean' },
});

const mapCompletionSchema: Schema = {
  oneOf: [
    object({
      type: { const: 'all_settled' },
      child_error: enumSchema(['record', 'fail_node']),
    }),
    object({
      type: { const: 'all_accepted' },
      accepted_exits: array(stableKeySchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      on_rejected: enumSchema(['wait_then_fail', 'fail_fast']),
    }),
    object({
      type: { const: 'quorum' },
      accepted_exits: array(stableKeySchema, {
        minItems: 1,
        uniqueItems: true,
      }),
      min_accepted: positiveIntegerSchema,
      on_reached: { const: 'cancel_remaining' },
      on_impossible: { const: 'fail_node' },
    }),
  ],
};

const graphNodeSchema: Schema = {
  oneOf: [
    object(
      {
        ...graphNodeCommon('delegation'),
        capability_ref: ref('versioned_ref'),
        retry_request: object(
          {
            max_attempts: positiveIntegerSchema,
            retry_on: array(stableKeySchema, { uniqueItems: true }),
          },
          ['retry_on'],
        ),
        timeout_ms: positiveIntegerSchema,
        claim_bindings: strictRecord(stableKeySchema),
      },
      ['label', 'metadata', 'retry_request', 'timeout_ms', 'claim_bindings'],
    ),
    object(
      {
        ...graphNodeCommon('system'),
        capability_ref: ref('versioned_ref'),
        retry_request: object(
          {
            max_attempts: positiveIntegerSchema,
            retry_on: array(stableKeySchema, { uniqueItems: true }),
          },
          ['retry_on'],
        ),
        timeout_ms: positiveIntegerSchema,
        claim_bindings: strictRecord(stableKeySchema),
      },
      ['label', 'metadata', 'retry_request', 'timeout_ms', 'claim_bindings'],
    ),
    object(
      {
        ...graphNodeCommon('wait'),
        wait: ref('wait_source'),
      },
      ['label', 'metadata'],
    ),
    object(
      {
        ...graphNodeCommon('join'),
        input_ports: strictRecord(ref('node_input_port')),
        expose: strictRecord(object({ input_port: stableKeySchema })),
      },
      ['label', 'metadata'],
    ),
    object(
      {
        ...graphNodeCommon('subgraph'),
        scope: ref('static_scope_factory'),
        input_ports: strictRecord(ref('node_input_port')),
        child_input_bindings: strictRecord(ref('port_binding')),
        completion_output_port: stableKeySchema,
        expose: strictRecord(ref('child_output_expose')),
        child_policy_ref: ref('versioned_ref'),
      },
      ['label', 'metadata', 'expose', 'child_policy_ref'],
    ),
    object(
      {
        ...graphNodeCommon('expand'),
        child_interface_ref: ref('versioned_ref'),
        input_ports: strictRecord(ref('node_input_port')),
        graph_spec_input_port: stableKeySchema,
        child_input_bindings: strictRecord(ref('port_binding')),
        completion_output_port: stableKeySchema,
        expose: strictRecord(ref('child_output_expose')),
        child_policy_ref: ref('versioned_ref'),
      },
      ['label', 'metadata', 'expose', 'child_policy_ref'],
    ),
    object(
      {
        ...graphNodeCommon('map'),
        body: ref('static_scope_factory'),
        input_ports: strictRecord(ref('node_input_port')),
        items_input_port: stableKeySchema,
        item_child_input_port: stableKeySchema,
        shared_child_input_bindings: strictRecord(ref('port_binding')),
        result_output_port: stableKeySchema,
        item_key_pointer: pointerSchema,
        requested_max_items: nullableNonnegativeIntegerSchema,
        requested_child_concurrency: nullableNonnegativeIntegerSchema,
        completion: ref('map_completion'),
        child_policy_ref: ref('versioned_ref'),
      },
      [
        'label',
        'metadata',
        'shared_child_input_bindings',
        'item_key_pointer',
        'child_policy_ref',
      ],
    ),
    object(
      {
        ...graphNodeCommon('terminal'),
        exit: stableKeySchema,
      },
      ['label', 'metadata'],
    ),
  ],
};

const nodeOutcomeMatchSchema = object(
  {
    statuses: array(
      enumSchema(['succeeded', 'failed', 'skipped', 'cancelled']),
      { minItems: 1, uniqueItems: true },
    ),
    codes: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
    child_exits: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
  },
  ['codes', 'child_exits'],
);

const controlEdgeSchema: Schema = {
  oneOf: [
    object(
      {
        id: stableKeySchema,
        kind: { const: 'control' },
        from_node_id: stableKeySchema,
        to_node_id: stableKeySchema,
        on: ref('node_outcome_match'),
        when: ref('condition_expression'),
        route_group_id: stableKeySchema,
        priority: safeIntegerSchema(),
      },
      ['when', 'route_group_id', 'priority'],
    ),
    object({
      id: stableKeySchema,
      kind: { const: 'control' },
      from_node_id: stableKeySchema,
      to_node_id: stableKeySchema,
      route_group_id: stableKeySchema,
      default: { const: true },
    }),
  ],
};

const dataSourceEndpointSchema: Schema = {
  oneOf: [
    object(
      {
        type: { const: 'scope_input' },
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object(
      {
        type: { const: 'node_output' },
        node_id: stableKeySchema,
        port: stableKeySchema,
        pointer: pointerSchema,
      },
      ['pointer'],
    ),
    object({ type: { const: 'literal' }, value: ref('json_value') }),
  ],
};

const dataEdgeSchema = object(
  {
    id: stableKeySchema,
    kind: { const: 'data' },
    from: ref('data_source_endpoint'),
    to: object({ node_id: stableKeySchema, port: stableKeySchema }),
    guard_control_edge_id: stableKeySchema,
    on_missing: { const: 'unavailable' },
  },
  ['guard_control_edge_id', 'on_missing'],
);

const completionFactExpressionSchema: Schema = {
  oneOf: [
    object(
      {
        fact: { const: 'candidate_count' },
        exits: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
        terminal_node_ids: array(stableKeySchema, {
          minItems: 1,
          uniqueItems: true,
        }),
        cmp: enumSchema(['eq', 'gte', 'lte']),
        value: integerSchema(),
      },
      ['exits', 'terminal_node_ids'],
    ),
    object(
      {
        fact: { const: 'node_count' },
        node_ids: array(stableKeySchema, {
          minItems: 1,
          uniqueItems: true,
        }),
        statuses: array(
          enumSchema(['succeeded', 'failed', 'skipped', 'cancelled']),
          { minItems: 1, uniqueItems: true },
        ),
        codes: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
        cmp: enumSchema(['eq', 'gte', 'lte']),
        value: integerSchema(),
      },
      ['node_ids', 'codes'],
    ),
    object({ fact: { const: 'all_nodes_terminal' } }),
    object({
      op: enumSchema(['and', 'or']),
      args: array(ref('completion_fact_expression'), { minItems: 1 }),
    }),
    object({
      op: { const: 'not' },
      arg: ref('completion_fact_expression'),
    }),
  ],
};

const completionSelectorSchema = object(
  {
    exits: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
    terminal_node_ids: array(stableKeySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    pick: {
      oneOf: [
        object({ type: { const: 'first_reached' } }),
        object({
          type: { const: 'exit_priority_then_first' },
          exit_priority: array(stableKeySchema, {
            minItems: 1,
            uniqueItems: true,
          }),
        }),
        object({ type: { const: 'lowest_terminal_node_id' } }),
      ],
    },
  },
  ['exits', 'terminal_node_ids'],
);

const completionPolicySchema = object(
  {
    early_rules: array(
      object({
        id: stableKeySchema,
        when: ref('completion_fact_expression'),
        select: ref('completion_selector'),
        phase: { const: 'early' },
        arbitration: { const: 'first_eligible' },
        same_event_priority: safeIntegerSchema(),
      }),
    ),
    settled_rules: array(
      object({
        id: stableKeySchema,
        when: ref('completion_fact_expression'),
        select: ref('completion_selector'),
        phase: { const: 'settled' },
        priority: safeIntegerSchema(),
      }),
    ),
    no_match: { const: 'error' },
    early_close: { const: 'cancel_and_fence_remaining' },
  },
  ['early_rules'],
);

const graphScopeSchema = object(
  {
    format: { const: 'icarus.workflow-graph-scope/1' },
    scope_key: stableKeySchema,
    label: stringSchema({ minLength: 1 }),
    interface_ref: ref('versioned_ref'),
    nodes: array(ref('graph_node'), { minItems: 1 }),
    route_groups: array(
      object({
        id: stableKeySchema,
        from_node_id: stableKeySchema,
        mode: enumSchema(['all_matching', 'first_matching']),
        no_match: enumSchema(['allow', 'error']),
      }),
    ),
    control_edges: array(ref('control_edge')),
    data_edges: array(ref('data_edge')),
    completion: ref('completion_policy'),
    requested_limits: ref('nullable_graph_limits'),
    metadata: record(ref('json_value')),
  },
  ['label', 'route_groups', 'metadata'],
);

const compiledPortSchema: Schema = {
  oneOf: [
    object({
      type: { const: 'registry' },
      ref: ref('versioned_ref'),
      schema_hash: hashSchema,
    }),
    object({
      type: { const: 'generated' },
      generator: enumSchema(['join_expose', 'child_completion', 'map_result']),
      canonicalizer: { const: 'RFC8785-JCS' },
      parameter_hash: hashSchema,
      schema_ref: stringSchema({
        pattern: '^icarus-generated-schema:sha256:[0-9a-f]{64}$',
      }),
      schema_raw_hash: hashSchema,
      schema_hash: hashSchema,
      schema_byte_length: integerSchema(),
      schema_json: ref('json_value'),
    }),
  ],
};

const compiledInputPortSchema: Schema = {
  oneOf: [
    object({
      schema: ref('compiled_port_schema'),
      max_bytes: nullableNonnegativeIntegerSchema,
      aggregation: {
        oneOf: [(inputAggregationSchema.oneOf as JsonValue[])[0]!],
      },
    }),
    object({
      schema: ref('compiled_port_schema'),
      max_bytes: nullableNonnegativeIntegerSchema,
      aggregation: {
        oneOf: [(inputAggregationSchema.oneOf as JsonValue[])[1]!],
      },
      item_schema: ref('compiled_port_schema'),
      item_max_bytes: nullableNonnegativeIntegerSchema,
    }),
  ],
};

const compiledOutputPortSchema = object({
  schema: ref('compiled_port_schema'),
  max_bytes: nullableNonnegativeIntegerSchema,
  required: { type: 'boolean' },
});

const scopeInterfaceSchema = object({
  ref: ref('versioned_ref'),
  inputs: strictRecord(
    object(
      {
        schema_ref: ref('versioned_ref'),
        max_bytes: nullableNonnegativeIntegerSchema,
        required: { type: 'boolean' },
        default: ref('json_value'),
      },
      ['default'],
    ),
  ),
  exits: strictRecord(
    object({
      output_ports: strictRecord(
        object({
          schema_ref: ref('versioned_ref'),
          max_bytes: nullableNonnegativeIntegerSchema,
          required: { type: 'boolean' },
        }),
      ),
    }),
  ),
});

const capabilityEffectKeySchema: Schema = {
  oneOf: [
    object({ scope: { const: 'attempt' } }),
    object({ scope: { const: 'node' } }),
    object({ scope: { const: 'workflow' }, namespace: stableKeySchema }),
    object({
      scope: { const: 'business_input' },
      namespace: stableKeySchema,
      input_ports: array(stableKeySchema, { minItems: 1, uniqueItems: true }),
    }),
  ],
};

const capabilityEffectSchema: Schema = {
  oneOf: [
    object({ type: { const: 'pure' } }),
    object({
      type: { const: 'idempotent' },
      key: ref('capability_effect_key'),
    }),
    object({
      type: { const: 'compensatable' },
      operation_key: ref('capability_effect_key'),
      compensate_action_ref: ref('versioned_ref'),
    }),
  ],
};

const capabilityCancellationSchema: Schema = {
  oneOf: [
    object({ type: { const: 'fence_only' }, safe_to_abandon: { const: true } }),
    object({
      type: { const: 'cooperative' },
      cancel_action_ref: ref('versioned_ref'),
      ack_required_before_close: { const: false },
      safe_if_cancel_lost: { const: true },
    }),
    object({ type: { const: 'requires_compensation' } }),
  ],
};

const dependencyAccessSchema = object({
  ref: stringSchema({ minLength: 1 }),
  access: enumSchema(['read', 'write']),
  impact: enumSchema(effectImpacts),
});

const workflowCapabilitySchema = object(
  {
    ref: ref('versioned_ref'),
    node_type: enumSchema(['delegation', 'system']),
    executor_ref: ref('versioned_ref'),
    role_ref: ref('versioned_ref'),
    skill_refs: array(ref('versioned_ref'), { uniqueItems: true }),
    prompt_binding: object({
      prompt_family_ref: ref('versioned_ref'),
      prompt_contract_ref: ref('versioned_ref'),
      base_prompt_ref: ref('versioned_ref'),
      selection_policy_ref: ref('versioned_ref'),
    }),
    input_ports: strictRecord(ref('node_input_port')),
    output_ports: strictRecord(ref('node_output_port')),
    artifact_contract_ref: ref('versioned_ref'),
    no_artifact_expected: { const: true },
    evaluator_ref: ref('versioned_ref'),
    no_evaluation_expected: { const: true },
    quality_gate_ref: ref('versioned_ref'),
    quality_revision_policy: nullable(
      object({
        feedback_schema_ref: ref('versioned_ref'),
        max_feedback_bytes: nullablePositiveIntegerSchema,
        context_mode: { const: 'base_input_plus_latest_revision' },
      }),
    ),
    required_tools: array(ref('dependency_access')),
    required_mcp_methods: array(ref('dependency_access')),
    required_file_scopes: array(ref('dependency_access')),
    required_claims: array(
      object({
        slot: stableKeySchema,
        namespace: stableKeySchema,
        access: enumSchema(['read', 'write']),
      }),
    ),
    allowed_groups: array(stableKeySchema, { uniqueItems: true }),
    execution_group_ref: ref('versioned_ref'),
    retry_policy: object({
      max_attempts: nullablePositiveIntegerSchema,
      retry_on: array(stableKeySchema, { uniqueItems: true }),
      backoff: enumSchema(['fixed', 'linear', 'exponential']),
    }),
    timeout_ceiling_ms: nullablePositiveIntegerSchema,
    effect_impact: enumSchema(effectImpacts),
    effect: ref('capability_effect'),
    cancellation: ref('capability_cancellation'),
    dependency_closure_hash: hashSchema,
  },
  [
    'role_ref',
    'prompt_binding',
    'artifact_contract_ref',
    'no_artifact_expected',
    'evaluator_ref',
    'no_evaluation_expected',
    'quality_gate_ref',
    'execution_group_ref',
  ],
);
workflowCapabilitySchema.allOf = [
  {
    oneOf: [
      {
        required: ['artifact_contract_ref'],
        properties: { artifact_contract_ref: {} },
        not: {
          required: ['no_artifact_expected'],
          properties: { no_artifact_expected: {} },
        },
      },
      {
        required: ['no_artifact_expected'],
        properties: { no_artifact_expected: {} },
        not: {
          required: ['artifact_contract_ref'],
          properties: { artifact_contract_ref: {} },
        },
      },
    ],
  },
  {
    oneOf: [
      {
        required: ['evaluator_ref'],
        properties: { evaluator_ref: {} },
        not: {
          required: ['no_evaluation_expected'],
          properties: { no_evaluation_expected: {} },
        },
      },
      {
        required: ['no_evaluation_expected'],
        properties: { no_evaluation_expected: {} },
        not: {
          required: ['evaluator_ref'],
          properties: { evaluator_ref: {} },
        },
      },
    ],
  },
  {
    oneOf: [
      { properties: { quality_revision_policy: { type: 'null' } } },
      {
        properties: {
          quality_revision_policy: { not: { type: 'null' } },
          evaluator_ref: {},
          quality_gate_ref: {},
        },
        required: [
          'quality_revision_policy',
          'evaluator_ref',
          'quality_gate_ref',
        ],
      },
    ],
  },
];

const waitContractSchema = object({
  ref: ref('versioned_ref'),
  kind: enumSchema(['signal', 'timer', 'approval']),
  input_ports: strictRecord(ref('node_input_port')),
  output_ports: strictRecord(ref('node_output_port')),
  authorization_policy_ref: ref('versioned_ref'),
  allow_indefinite: { type: 'boolean' },
  prearm_ttl_ms: nullablePositiveIntegerSchema,
  contract_hash: hashSchema,
});

const compiledTriggerProgramSchema = object({
  normalized_expression: ref('node_trigger'),
  referenced_edge_ids: array(stableKeySchema, { uniqueItems: true }),
  max_steps: positiveIntegerSchema,
  truth_program_hash: hashSchema,
});

function compiledNodeCommon(type: string): Record<string, Schema> {
  return {
    id: stableKeySchema,
    type: { const: type },
    source_config_hash: hashSchema,
    trigger_program: ref('compiled_trigger_program'),
    input_ports: strictRecord(ref('compiled_input_port')),
    output_ports: strictRecord(ref('compiled_output_port')),
    effective_limits: strictRecord(nullableNonnegativeIntegerSchema),
  };
}

const childPolicyBindingSchema = object(
  {
    profile_ref: ref('versioned_ref'),
    effective_policy_snapshot: ref('graph_policy'),
    effective_policy_hash: hashSchema,
  },
  ['profile_ref'],
);

const staticFactoryBindingSchema = object(
  {
    kind: enumSchema(['template', 'inline']),
    source_ref: ref('versioned_ref'),
    source_snapshot_ref: stringSchema({ minLength: 1 }),
    source_hash: hashSchema,
    precompiled_plan_hash: hashSchema,
    interface_snapshot: ref('scope_interface'),
  },
  ['source_ref'],
);

const compiledNodeSchema: Schema = {
  oneOf: [
    object({
      ...compiledNodeCommon('delegation'),
      capability_binding: ref('workflow_capability'),
      effective_retry_policy: object({
        effective_node_max_attempts: positiveIntegerSchema,
        effective_retry_on: array(stableKeySchema, { uniqueItems: true }),
        backoff: enumSchema(['fixed', 'linear', 'exponential']),
        quality_revision: nullable(
          object({
            feedback_schema_ref: ref('versioned_ref'),
            feedback_schema_hash: hashSchema,
            effective_max_feedback_bytes: positiveIntegerSchema,
            context_mode: { const: 'base_input_plus_latest_revision' },
          }),
        ),
        policy_hash: hashSchema,
      }),
    }),
    object({
      ...compiledNodeCommon('system'),
      capability_binding: ref('workflow_capability'),
      effective_retry_policy: object({
        effective_node_max_attempts: positiveIntegerSchema,
        effective_retry_on: array(stableKeySchema, { uniqueItems: true }),
        backoff: enumSchema(['fixed', 'linear', 'exponential']),
        quality_revision: nullable(
          object({
            feedback_schema_ref: ref('versioned_ref'),
            feedback_schema_hash: hashSchema,
            effective_max_feedback_bytes: positiveIntegerSchema,
            context_mode: { const: 'base_input_plus_latest_revision' },
          }),
        ),
        policy_hash: hashSchema,
      }),
    }),
    object({
      ...compiledNodeCommon('wait'),
      wait_binding: {
        oneOf: (waitSourceSchema.oneOf as JsonValue[]).map((branch) => {
          const source = branch as JsonObject;
          const properties = source.properties as JsonObject;
          const required = new Set(
            ((source.required as JsonValue[]) ?? []).map(String),
          );
          return object(
            {
              ...(properties as Record<string, Schema>),
              contract_snapshot: ref('wait_contract'),
              effective_max_duration_ms: nullableNonnegativeIntegerSchema,
            },
            Object.keys(properties).filter((key) => !required.has(key)),
          );
        }),
      },
    }),
    object({
      ...compiledNodeCommon('join'),
      expose: strictRecord(object({ input_port: stableKeySchema })),
    }),
    object({
      ...compiledNodeCommon('subgraph'),
      factory_binding: ref('static_factory_binding'),
      child_input_bindings: strictRecord(ref('port_binding')),
      completion_output_port: stableKeySchema,
      expose: strictRecord(ref('child_output_expose')),
      child_policy: ref('child_policy_binding'),
    }),
    object({
      ...compiledNodeCommon('expand'),
      graph_spec_input_port: stableKeySchema,
      child_interface_snapshot: ref('scope_interface'),
      child_input_bindings: strictRecord(ref('port_binding')),
      completion_output_port: stableKeySchema,
      expose: strictRecord(ref('child_output_expose')),
      child_policy: ref('child_policy_binding'),
    }),
    object(
      {
        ...compiledNodeCommon('map'),
        body_binding: ref('static_factory_binding'),
        items_input_port: stableKeySchema,
        item_child_input_port: stableKeySchema,
        shared_child_input_bindings: strictRecord(ref('port_binding')),
        result_output_port: stableKeySchema,
        item_key_pointer: pointerSchema,
        effective_max_items: nullableNonnegativeIntegerSchema,
        effective_child_concurrency: nullableNonnegativeIntegerSchema,
        completion: ref('map_completion'),
        child_policy: ref('child_policy_binding'),
        result_order: { const: 'item_index' },
      },
      ['item_key_pointer'],
    ),
    object({
      ...compiledNodeCommon('terminal'),
      exit: stableKeySchema,
    }),
  ],
};

const compatibilityProofSchema = object({
  producer_schema_hash: hashSchema,
  canonical_pointer: nullable(pointerSchema),
  pointer_totality: enumSchema(['total', 'may_be_missing']),
  derived_schema_hash: hashSchema,
  consumer_schema_hash: hashSchema,
  proof_rule: enumSchema([
    'identical_schema',
    'const_subset',
    'enum_subset',
    'numeric_range_subset',
    'closed_object_subtype',
    'array_item_subtype',
    'discriminated_union_subtype',
  ]),
  proof_detail_ref: stringSchema({ minLength: 1 }),
  proof_detail_hash: hashSchema,
  proof_hash: hashSchema,
});

const compiledConditionProgramSchema = object({
  normalized_ast: ref('condition_expression'),
  operand_schema_hashes: strictRecord(hashSchema),
  operand_types: array(
    enumSchema(['null', 'boolean', 'number', 'string', 'array', 'object']),
    { minItems: 1 },
  ),
  max_steps: positiveIntegerSchema,
  program_hash: hashSchema,
});

const compiledRouteGroupSchema = object({
  id: stableKeySchema,
  from_node_id: stableKeySchema,
  mode: enumSchema(['all_matching', 'first_matching']),
  no_match: enumSchema(['allow', 'error']),
  ordered_edge_ids: array(stableKeySchema, { uniqueItems: true }),
  group_hash: hashSchema,
});

const compiledControlEdgeSchema = object({
  id: stableKeySchema,
  from_node_id: stableKeySchema,
  to_node_id: stableKeySchema,
  outcome_match: nullable(ref('node_outcome_match')),
  condition_program: nullable(ref('compiled_condition_program')),
  route_group_id: nullable(stableKeySchema),
  priority: nullable(safeIntegerSchema()),
  is_default: { type: 'boolean' },
  source_config_hash: hashSchema,
  compiled_edge_hash: hashSchema,
});

const compiledDataEdgeSchema = object({
  id: stableKeySchema,
  from: ref('data_source_endpoint'),
  to: object({ node_id: stableKeySchema, port: stableKeySchema }),
  guard_control_edge_id: nullable(stableKeySchema),
  canonical_pointer: nullable(pointerSchema),
  pointer_tokens: array(stringSchema()),
  on_missing: enumSchema(['error', 'unavailable']),
  producer_schema_hash: hashSchema,
  derived_schema: ref('compiled_port_schema'),
  consumer_schema_hash: hashSchema,
  compatibility_proof: ref('compatibility_proof'),
  source_config_hash: hashSchema,
  compiled_edge_hash: hashSchema,
});

const monotonicityProofSchema = object({
  algorithm_version: stringSchema({ minLength: 1 }),
  classification: { const: 'monotone' },
  proof_detail_ref: stringSchema({ minLength: 1 }),
  proof_detail_hash: hashSchema,
  proof_hash: hashSchema,
});

const cancellationSafetyProofSchema = object({
  algorithm_version: stringSchema({ minLength: 1 }),
  covered_node_contract_hashes: array(hashSchema, { uniqueItems: true }),
  proof_detail_ref: stringSchema({ minLength: 1 }),
  proof_detail_hash: hashSchema,
  proof_hash: hashSchema,
});

const compiledCompletionRuleSchema = object({
  id: stableKeySchema,
  phase: enumSchema(['early', 'settled']),
  normalized_fact_expression: ref('completion_fact_expression'),
  fact_program_hash: hashSchema,
  max_steps: positiveIntegerSchema,
  selector: ref('completion_selector'),
  selector_contract_hash: hashSchema,
  priority: safeIntegerSchema(),
  monotonicity_proof: nullable(ref('monotonicity_proof')),
  cancellation_safety_proof: nullable(ref('cancellation_safety_proof')),
  rule_hash: hashSchema,
});

const compiledCompletionPolicySchema = object({
  early_rules: array(ref('compiled_completion_rule')),
  settled_rules: array(ref('compiled_completion_rule')),
  no_match: { const: 'error' },
  early_close: { const: 'cancel_and_fence_remaining' },
  policy_hash: hashSchema,
});

const complexitySummarySchema = object({
  node_count: integerSchema(),
  control_edge_count: integerSchema(),
  data_edge_count: integerSchema(),
  max_source_fan_out: integerSchema(),
  max_condition_steps: integerSchema(),
  max_trigger_steps: integerSchema(),
  max_completion_steps: integerSchema(),
  max_reconcile_facts_per_ingress: integerSchema(),
  max_frontier_bytes: integerSchema(),
  summary_hash: hashSchema,
});

function positiveIntegerObject(keys: readonly string[]): Schema {
  return object(
    Object.fromEntries(
      keys.map((key) => [key, positiveIntegerSchema]),
    ) as Record<string, Schema>,
  );
}

const runtimeSafetySchema = object({
  routing: positiveIntegerObject([
    'max_task_input_bytes',
    'max_route_hops',
    'max_schema_bytes',
    'max_schema_nodes',
    'max_schema_ref_depth',
    'max_schema_union_variants',
    'max_schema_validation_steps',
  ]),
  workflow: positiveIntegerObject([
    'max_duration_ms',
    'max_state_activations',
    'max_graph_runs',
    'max_state_transitions',
    'max_child_workflows_per_workflow',
    'max_child_workflow_depth',
    'max_descendant_workflows_total',
    'max_required_child_creations_per_transition',
  ]),
  run: positiveIntegerObject([
    'max_scopes_total',
    'max_nodes_total',
    'max_edges_total',
    'max_map_items_total',
    'max_attempts_total',
    'max_waits_total',
    'max_builds_total',
    'max_build_attempts_total',
    'max_evaluator_attempts_total',
    'max_effect_operations_total',
    'max_logical_output_bytes_total',
    'max_stored_bytes_total',
    'max_facts_total',
  ]),
  scope: positiveIntegerObject([
    'max_nodes_per_scope',
    'max_edges_per_scope',
    'max_scope_spec_bytes',
    'max_nesting_depth',
    'max_frontier_bytes',
  ]),
  map: positiveIntegerObject([
    'max_items_per_map',
    'max_child_concurrency_per_map',
  ]),
  registry: positiveIntegerObject([
    'max_snapshot_entries',
    'max_dependency_depth',
    'max_execution_artifact_bytes',
    'max_total_pinned_execution_bytes_per_run',
  ]),
  execution: positiveIntegerObject([
    'max_attempts_per_node',
    'max_attempt_duration_ms',
    'max_dispatch_duration_ms',
    'max_retry_backoff_ms',
    'max_build_attempts_per_build',
    'max_build_duration_ms',
    'max_evaluator_attempts_per_evaluation',
    'max_evaluator_duration_ms',
    'max_outbox_attempts_per_message',
    'max_outbox_reconcile_attempts_per_message',
    'max_outbox_attempt_duration_ms',
    'max_outbox_delivery_duration_ms',
    'max_root_finalization_attempts_per_schedule',
    'max_root_finalization_duration_ms',
    'max_operational_remediation_attempts_per_blocker',
    'max_operational_remediation_duration_ms',
  ]),
  wait: positiveIntegerObject([
    'max_finite_wait_duration_ms',
    'max_pending_signals_per_workflow',
    'max_pending_signals_per_run',
    'max_pending_signals_per_principal',
    'max_pending_signal_age_ms',
    'max_signal_payload_bytes',
    'max_correlation_key_bytes',
  ]),
  reconciliation: positiveIntegerObject([
    'max_condition_ast_nodes',
    'max_condition_steps_per_evaluation',
    'max_facts_per_transaction',
  ]),
  value: positiveIntegerObject([
    'max_single_value_bytes',
    'max_single_artifact_bytes',
    'max_artifact_files',
    'max_artifact_manifest_bytes',
  ]),
});

const staticChildPlanClosureMemberSchema = object({
  closure_key: stringSchema({ minLength: 1 }),
  parent_closure_key: nullable(stringSchema({ minLength: 1 })),
  scope_key: stableKeySchema,
  owner_node_path: array(stableKeySchema, { minItems: 1 }),
  factory_kind: enumSchema(['inline', 'template']),
  source_ref: nullable(ref('versioned_ref')),
  source_hash: hashSchema,
  plan_ref: stringSchema({ minLength: 1 }),
  plan_hash: hashSchema,
  interface_snapshot_hash: hashSchema,
  member_hash: hashSchema,
});

const staticChildPlanClosureSchema = object({
  members: array(ref('static_child_plan_closure_member'), {
    uniqueItems: true,
  }),
  member_count: integerSchema(),
  closure_hash: hashSchema,
});

const compiledScopePlanSchema = object({
  format: { const: 'icarus.workflow-graph-scope-plan/2' },
  compiler_version: stringSchema({ minLength: 1 }),
  plan_hash: hashSchema,
  source_hash: hashSchema,
  interface_snapshot_hash: hashSchema,
  policy_snapshot_hash: hashSchema,
  effective_policy_snapshot: ref('graph_policy'),
  capability_catalog_hash: hashSchema,
  wait_contract_catalog_hash: hashSchema,
  interface_snapshot: ref('scope_interface'),
  nodes: array(ref('compiled_node'), { minItems: 1 }),
  route_groups: array(ref('compiled_route_group')),
  control_edges: array(ref('compiled_control_edge')),
  data_edges: array(ref('compiled_data_edge')),
  completion: ref('compiled_completion_policy'),
  complexity_summary: ref('complexity_summary'),
  static_child_plan_closure: ref('static_child_plan_closure'),
  effective_limits: ref('nullable_graph_limits'),
  effective_usage_budget: ref('nullable_usage_budget'),
  runtime_safety_snapshot: ref('runtime_safety'),
  runtime_safety_hash: hashSchema,
});

function schemaDocument(
  id: string,
  title: string,
  root: Schema,
  definitions: Record<string, Schema>,
): Schema {
  return {
    $schema: DRAFT_2020_12,
    $id: `https://icarus.local/schemas/${id}`,
    title,
    ...root,
    $defs: definitions,
  };
}

const commonDefinitions: Record<string, Schema> = {
  versioned_ref: versionedRefSchema,
  json_value: jsonValueSchema,
};

const transitionDefinitions: Record<string, Schema> = {
  ...commonDefinitions,
  value_binding: valueBindingSchema,
  context_patch: contextPatchSchema,
  transition_effect: transitionEffectSchema,
};

const sourceDefinitions: Record<string, Schema> = {
  ...commonDefinitions,
  nullable_graph_limits: nullableGraphLimitsSchema,
  wait_source: waitSourceSchema,
  condition_ref: conditionRefSchema,
  condition_operand: conditionOperandSchema,
  condition_expression: conditionExpressionSchema,
  edge_truth_expression: edgeTruthExpressionSchema,
  node_trigger: nodeTriggerSchema,
  value_port_contract: valuePortContractSchema,
  node_input_port: nodeInputPortSchema,
  node_output_port: nodeOutputPortSchema,
  static_scope_factory: staticScopeFactorySchema,
  port_binding: portBindingSchema,
  child_output_expose: childOutputExposeSchema,
  map_completion: mapCompletionSchema,
  graph_node: graphNodeSchema,
  node_outcome_match: nodeOutcomeMatchSchema,
  control_edge: controlEdgeSchema,
  data_source_endpoint: dataSourceEndpointSchema,
  data_edge: dataEdgeSchema,
  completion_fact_expression: completionFactExpressionSchema,
  completion_selector: completionSelectorSchema,
  completion_policy: completionPolicySchema,
  graph_scope: graphScopeSchema,
};

const definitionDefinitions: Record<string, Schema> = {
  ...sourceDefinitions,
  value_binding: valueBindingSchema,
  graph_input_binding: graphInputBindingSchema,
  nullable_usage_budget: nullableUsageBudgetSchema,
  graph_policy: graphPolicySchema,
  context_patch: contextPatchSchema,
  transition_effect: transitionEffectSchema,
  transition: transitionSchema,
};

const compiledDefinitions: Record<string, Schema> = {
  ...sourceDefinitions,
  nullable_usage_budget: nullableUsageBudgetSchema,
  graph_policy: graphPolicySchema,
  compiled_port_schema: compiledPortSchema,
  compiled_input_port: compiledInputPortSchema,
  compiled_output_port: compiledOutputPortSchema,
  scope_interface: scopeInterfaceSchema,
  capability_effect_key: capabilityEffectKeySchema,
  capability_effect: capabilityEffectSchema,
  capability_cancellation: capabilityCancellationSchema,
  dependency_access: dependencyAccessSchema,
  workflow_capability: workflowCapabilitySchema,
  wait_contract: waitContractSchema,
  compiled_trigger_program: compiledTriggerProgramSchema,
  child_policy_binding: childPolicyBindingSchema,
  static_factory_binding: staticFactoryBindingSchema,
  compiled_node: compiledNodeSchema,
  compatibility_proof: compatibilityProofSchema,
  compiled_condition_program: compiledConditionProgramSchema,
  compiled_route_group: compiledRouteGroupSchema,
  compiled_control_edge: compiledControlEdgeSchema,
  compiled_data_edge: compiledDataEdgeSchema,
  monotonicity_proof: monotonicityProofSchema,
  cancellation_safety_proof: cancellationSafetyProofSchema,
  compiled_completion_rule: compiledCompletionRuleSchema,
  compiled_completion_policy: compiledCompletionPolicySchema,
  complexity_summary: complexitySummarySchema,
  runtime_safety: runtimeSafetySchema,
  static_child_plan_closure_member: staticChildPlanClosureMemberSchema,
  static_child_plan_closure: staticChildPlanClosureSchema,
};

export interface ClosedSchemaDescriptor {
  artifact_path: string;
  artifact_format: string;
  artifact_ref_id: string;
  target_format: string;
  domain_separator: string;
  schema: Schema;
}

export const CLOSED_SCHEMA_DESCRIPTORS: readonly ClosedSchemaDescriptor[] = [
  {
    artifact_path: 'schemas/workflow-definition-schema.json',
    artifact_format: 'icarus.workflow-definition-schema/1',
    artifact_ref_id: 'icarus.workflow-definition-schema',
    target_format: 'icarus.workflow-definition/1',
    domain_separator: 'icarus:workflow-definition-schema:1\n',
    schema: schemaDocument(
      'workflow-definition/1',
      'WorkflowDefinitionV1',
      workflowDefinitionSchema,
      definitionDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/workflow-recipe-schema.json',
    artifact_format: 'icarus.workflow-recipe-schema/1',
    artifact_ref_id: 'icarus.workflow-recipe-schema',
    target_format: 'WorkflowRecipeDescriptor',
    domain_separator: 'icarus:workflow-recipe-schema:1\n',
    schema: schemaDocument(
      'workflow-recipe/1',
      'WorkflowRecipeDescriptor',
      workflowRecipeSchema,
      commonDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/workflow-runtime-command-schema.json',
    artifact_format: 'icarus.workflow-runtime-command-schema/1',
    artifact_ref_id: 'icarus.workflow-runtime-command-schema',
    target_format: 'WorkflowRuntimeCommand',
    domain_separator: 'icarus:workflow-runtime-command-schema:1\n',
    schema: schemaDocument(
      'workflow-runtime-command/1',
      'WorkflowRuntimeCommand',
      workflowRuntimeCommandSchema,
      commonDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/workflow-transition-schema.json',
    artifact_format: 'icarus.workflow-transition-schema/1',
    artifact_ref_id: 'icarus.workflow-transition-schema',
    target_format: 'WorkflowDefinitionTransition',
    domain_separator: 'icarus:workflow-transition-schema:1\n',
    schema: schemaDocument(
      'workflow-transition/1',
      'WorkflowDefinitionTransition',
      transitionSchema,
      transitionDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/feature-manifest-v2-schema.json',
    artifact_format: 'icarus.workflow-feature-manifest-v2-schema/1',
    artifact_ref_id: 'icarus.workflow-feature-manifest-v2-schema',
    target_format: 'icarus.feature-manifest/2',
    domain_separator: 'icarus:workflow-feature-manifest-v2-schema:1\n',
    schema: schemaDocument(
      'feature-manifest/2',
      'FeatureManifestVNext',
      featureManifestSchema,
      commonDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/card-presentation-schema.json',
    artifact_format: 'icarus.workflow-card-presentation-schema/1',
    artifact_ref_id: 'icarus.workflow-card-presentation-schema',
    target_format: 'icarus.card-presentation/1',
    domain_separator: 'icarus:workflow-card-presentation-schema:1\n',
    schema: schemaDocument(
      'card-presentation/1',
      'CardPresentationContract',
      cardPresentationSchema,
      { ...commonDefinitions, card_action_binding: cardActionBindingSchema },
    ),
  },
  {
    artifact_path: 'schemas/graph-scope-source-schema.json',
    artifact_format: 'icarus.workflow-graph-scope-source-schema/1',
    artifact_ref_id: 'icarus.workflow-graph-scope-source-schema',
    target_format: 'icarus.workflow-graph-scope/1',
    domain_separator: 'icarus:workflow-graph-scope-source-schema:1\n',
    schema: schemaDocument(
      'workflow-graph-scope/1',
      'GraphScopeSpec',
      graphScopeSchema,
      sourceDefinitions,
    ),
  },
  {
    artifact_path: 'schemas/compiled-scope-plan-schema.json',
    artifact_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    artifact_ref_id: 'icarus.workflow-compiled-scope-plan-schema',
    target_format: 'icarus.workflow-graph-scope-plan/2',
    domain_separator: 'icarus:workflow-compiled-scope-plan-schema:1\n',
    schema: schemaDocument(
      'workflow-graph-scope-plan/2',
      'CompiledScopePlan',
      compiledScopePlanSchema,
      compiledDefinitions,
    ),
  },
];

function artifactForSchema(
  descriptor: ClosedSchemaDescriptor,
): ContractArtifactEnvelope {
  const payload = strictParseJson(JSON.stringify(descriptor.schema));
  assertJsonObject(payload);
  const envelope: ContractArtifactEnvelope = {
    format: descriptor.artifact_format,
    ref: { id: descriptor.artifact_ref_id, version: '1.0.0' },
    version: 1,
    domain_separator: descriptor.domain_separator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  return { ...envelope, hash: calculateArtifactHash(envelope) };
}

export function buildClosedSchemaArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return CLOSED_SCHEMA_DESCRIPTORS.map((descriptor) => [
    descriptor.artifact_path,
    artifactForSchema(descriptor),
  ]);
}

export const CLOSED_SCHEMA_TOP_LEVEL_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  'icarus.workflow-definition-schema/1': WORKFLOW_DEFINITION_KEYS,
  'icarus.workflow-recipe-schema/1': WORKFLOW_RECIPE_KEYS,
  'icarus.workflow-transition-schema/1': WORKFLOW_TRANSITION_KEYS,
  'icarus.workflow-feature-manifest-v2-schema/1': FEATURE_MANIFEST_KEYS,
  'icarus.workflow-card-presentation-schema/1': CARD_PRESENTATION_KEYS,
  'icarus.workflow-graph-scope-source-schema/1': GRAPH_SCOPE_SOURCE_KEYS,
  'icarus.workflow-compiled-scope-plan-schema/1': COMPILED_SCOPE_PLAN_KEYS,
};

export const CLOSED_SCHEMA_TOP_LEVEL_REQUIRED_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  'icarus.workflow-definition-schema/1': WORKFLOW_DEFINITION_REQUIRED_KEYS,
  'icarus.workflow-recipe-schema/1': WORKFLOW_RECIPE_REQUIRED_KEYS,
  'icarus.workflow-runtime-command-schema/1':
    WORKFLOW_RUNTIME_COMMAND_REQUIRED_KEYS,
  'icarus.workflow-transition-schema/1': WORKFLOW_TRANSITION_REQUIRED_KEYS,
  'icarus.workflow-feature-manifest-v2-schema/1':
    FEATURE_MANIFEST_REQUIRED_KEYS,
  'icarus.workflow-card-presentation-schema/1': CARD_PRESENTATION_REQUIRED_KEYS,
  'icarus.workflow-graph-scope-source-schema/1':
    GRAPH_SCOPE_SOURCE_REQUIRED_KEYS,
  'icarus.workflow-compiled-scope-plan-schema/1':
    COMPILED_SCOPE_PLAN_REQUIRED_KEYS,
};

export const CLOSED_SCHEMA_UNIONS = {
  workflow_state_types: WORKFLOW_STATE_TYPES,
  graph_node_types: GRAPH_NODE_TYPES,
  command_types: WORKFLOW_COMMAND_TYPES,
  command_reason_codes: WORKFLOW_COMMAND_REASON_CODES,
  feature_resource_kinds: FEATURE_WORKFLOW_RESOURCE_KINDS,
  value_binding_sources: WORKFLOW_VALUE_BINDING_SOURCES,
  graph_input_binding_sources: WORKFLOW_GRAPH_INPUT_BINDING_SOURCES,
  transition_effect_input_sources: WORKFLOW_TRANSITION_EFFECT_INPUT_SOURCES,
} as const;

export const CLOSED_SCHEMA_COMMAND_KEYS = WORKFLOW_RUNTIME_COMMAND_KEYS;
