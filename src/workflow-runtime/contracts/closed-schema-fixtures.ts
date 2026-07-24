import type { JsonObject, JsonValue, VersionedRef } from './types.js';
import { buildGeneratedSchema } from './generated-schema-authority.js';

const HASH = `sha256:${'0'.repeat(64)}`;

function withoutKey(value: JsonObject, omittedKey: string): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== omittedKey),
  );
}

function versionedRef(id: string): VersionedRef {
  return { id, version: '1.0.0' };
}

const zeroAndNullLimits: JsonObject = {
  max_scopes: null,
  max_nodes: 0,
  max_nodes_per_scope: null,
  max_edges_per_scope: null,
  max_nesting_depth: null,
  max_map_items: null,
  max_concurrency: 0,
  max_total_attempts: null,
  max_total_waits: null,
  max_total_output_bytes: 0,
  max_scope_spec_bytes: null,
  max_condition_steps: null,
  max_wait_duration_ms: null,
  max_pending_signals: null,
  max_fixed_point_facts: null,
  max_frontier_bytes: null,
};

const zeroAndNullUsageBudget: JsonObject = {
  max_total_tool_calls: 0,
  max_total_input_tokens: null,
  max_total_output_tokens: null,
  max_total_cost_micros: null,
};

const graphPolicy: JsonObject = {
  allowed_node_types: [
    'delegation',
    'system',
    'wait',
    'join',
    'subgraph',
    'expand',
    'map',
    'terminal',
  ],
  allowed_capabilities: [versionedRef('example.capability')],
  allowed_templates: [],
  allowed_interface_refs: [versionedRef('example.interface')],
  allowed_wait_contracts: [],
  allowed_child_policy_refs: [],
  allowed_claim_ids: [],
  allow_early_close: false,
  allow_indefinite_waits: false,
  effect_policy: {
    allowed_recovery_kinds: ['pure'],
    max_impact: 'read_only',
  },
  build_retry: null,
  limits: zeroAndNullLimits,
  usage_budget: zeroAndNullUsageBudget,
};

const transition: JsonObject = { target: 'done' };

const workflowDefinition: JsonObject = {
  format: 'icarus.workflow-definition/1',
  ref: versionedRef('example.workflow'),
  owner_feature_id: 'example-feature',
  name: 'Example workflow',
  context_contract_ref: versionedRef('example.context'),
  entry_points: { default: { state_key: 'start' } },
  states: {
    start: {
      type: 'delegation',
      capability_ref: versionedRef('example.capability'),
      policy: graphPolicy,
      input_bindings: {},
      retry_request: null,
      timeout_ms: null,
      on_complete: { success: transition, failure: transition },
      on_error: transition,
      on_local_cancel: transition,
    },
    done: {
      type: 'terminal',
      terminal_kind: 'normal',
      output_binding: { source: 'constant', value: { status: 'done' } },
    },
  },
  definition_hash: HASH,
};

const workflowRecipe: JsonObject = {
  ref: versionedRef('example.recipe'),
  owner_feature_id: 'example-feature',
  recipe_family: 'example',
  task_kinds: ['example_task'],
  workflow_definition_ref: versionedRef('example.workflow'),
  entry_point: 'default',
  workflow_execution_policy_ref: versionedRef('example.execution-policy'),
  context_contract_ref: versionedRef('example.context'),
  workflow_command_policy_ref: versionedRef('example.command-policy'),
  input_schema_ref: versionedRef('example.input'),
  output_schema_ref: versionedRef('example.output'),
  launch_policy: 'confirm',
  effect_ceiling: 'read_only',
  derived_effect_summary: {
    max_impact: 'read_only',
    recovery_kinds: ['pure'],
    permission_refs: [],
    dependency_closure_hash: HASH,
  },
  required_permissions: [],
  allowed_child_recipe_refs: [],
  resource_claims: [],
  recipe_hash: HASH,
};

const runtimeCommand: JsonObject = {
  command_id: 'command-1',
  idempotency_key: 'operator-command-1',
  expected_row_version: 3,
  reason_code: 'operator_requested',
  evidence_refs: [],
  command_type: 'pause_run',
  target: { run_id: 'run-1' },
};

const featureManifest: JsonObject = {
  format: 'icarus.feature-manifest/2',
  feature_ref: versionedRef('example.feature'),
  namespace: 'example',
  owner_principal_ref: 'human:local-owner',
  dependencies: [],
  package_resources: {
    skills: [],
    agents: [],
    mcp: [],
    scripts: [],
    templates: [],
  },
  extension_surfaces: {
    api_entry: null,
    nav_entry: null,
    renderer_entry: null,
  },
  dynamic_workflow_resources: [
    {
      kind: 'definition',
      ref: versionedRef('example.workflow'),
      source_path: 'workflow-src/ab/example.workflow.json',
      expected_source_hash: HASH,
    },
  ],
  ownership: {
    feature_source_root: 'features/example',
    workflow_source_root: 'features/example/workflow-src',
    execution_bundle_owner: 'feature_release',
    registry_namespace: 'example',
  },
  lifecycle: {
    draining_policy_ref: versionedRef('example.draining'),
    retention_policy_ref: versionedRef('example.retention'),
    deletion_policy_ref: versionedRef('example.deletion'),
  },
  manifest_hash: HASH,
};

const cardPresentation: JsonObject = {
  format: 'icarus.card-presentation/1',
  ref: versionedRef('example.card'),
  owner_feature_id: 'example-feature',
  template_ref: versionedRef('example.card-template'),
  template_hash: HASH,
  variable_schema_ref: versionedRef('example.card-variables'),
  variable_schema_hash: HASH,
  supported_channel_adapters: [
    {
      adapter_ref: versionedRef('example.channel-adapter'),
      adapter_hash: HASH,
      render_profile_ref: versionedRef('example.render-profile'),
    },
  ],
  render_limits: {
    max_payload_bytes: 65536,
    max_text_bytes: 8192,
    max_actions: 4,
  },
  fallback_text_template_ref: versionedRef('example.fallback-template'),
  actions: [
    {
      action_id: 'pause',
      label: 'Pause',
      binding: {
        action_kind: 'runtime_command',
        command_type: 'pause_run',
        target_binding: 'run',
      },
      required_permission: 'workflow.operate',
      idempotency_domain: 'card_interaction',
      expires_after_ms: 300000,
    },
  ],
  snapshot_retention_policy_ref: versionedRef('example.card-retention'),
  deterministic_render_fixture_ref: 'fixture:example-card',
  deterministic_render_fixture_hash: HASH,
  contract_hash: HASH,
};

const graphScopeSource: JsonObject = {
  format: 'icarus.workflow-graph-scope/1',
  scope_key: 'minimal',
  interface_ref: versionedRef('example.interface'),
  nodes: [
    {
      id: 'done',
      type: 'terminal',
      trigger: { type: 'root' },
      exit: 'done',
    },
  ],
  control_edges: [],
  data_edges: [],
  completion: {
    settled_rules: [
      {
        id: 'select_done',
        when: { fact: 'all_nodes_terminal' },
        select: {
          exits: ['done'],
          pick: { type: 'lowest_terminal_node_id' },
        },
        phase: 'settled',
        priority: 100,
      },
    ],
    no_match: 'error',
    early_close: 'cancel_and_fence_remaining',
  },
  requested_limits: zeroAndNullLimits,
};

const safetyGroups: Record<string, readonly string[]> = {
  routing: [
    'max_task_input_bytes',
    'max_route_hops',
    'max_schema_bytes',
    'max_schema_nodes',
    'max_schema_ref_depth',
    'max_schema_union_variants',
    'max_schema_validation_steps',
  ],
  workflow: [
    'max_duration_ms',
    'max_state_activations',
    'max_graph_runs',
    'max_state_transitions',
    'max_child_workflows_per_workflow',
    'max_child_workflow_depth',
    'max_descendant_workflows_total',
    'max_required_child_creations_per_transition',
  ],
  run: [
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
  ],
  scope: [
    'max_nodes_per_scope',
    'max_edges_per_scope',
    'max_scope_spec_bytes',
    'max_nesting_depth',
    'max_frontier_bytes',
  ],
  map: ['max_items_per_map', 'max_child_concurrency_per_map'],
  registry: [
    'max_snapshot_entries',
    'max_dependency_depth',
    'max_execution_artifact_bytes',
    'max_total_pinned_execution_bytes_per_run',
  ],
  execution: [
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
  ],
  wait: [
    'max_finite_wait_duration_ms',
    'max_pending_signals_per_workflow',
    'max_pending_signals_per_run',
    'max_pending_signals_per_principal',
    'max_pending_signal_age_ms',
    'max_signal_payload_bytes',
    'max_correlation_key_bytes',
  ],
  reconciliation: [
    'max_condition_ast_nodes',
    'max_condition_steps_per_evaluation',
    'max_facts_per_transaction',
  ],
  value: [
    'max_single_value_bytes',
    'max_single_artifact_bytes',
    'max_artifact_files',
    'max_artifact_manifest_bytes',
  ],
};

const runtimeSafety = Object.fromEntries(
  Object.entries(safetyGroups).map(([group, keys]) => [
    group,
    Object.fromEntries(keys.map((key) => [key, 1])),
  ]),
) as JsonObject;

const compiledSystemNode: JsonObject = {
  id: 'work',
  type: 'system',
  source_config_hash: HASH,
  trigger_program: {
    normalized_expression: { type: 'root' },
    referenced_edge_ids: [],
    max_steps: 1,
    truth_program_hash: HASH,
  },
  input_ports: {
    request: {
      schema: buildGeneratedSchema(
        'join_expose',
        { node_id: 'work', input_port: 'request' },
        { type: 'string' },
      ),
      max_bytes: 0,
      aggregation: { type: 'single', required: false, select: 'only' },
    },
  },
  output_ports: {
    result: {
      schema: {
        type: 'registry',
        ref: versionedRef('example.output'),
        schema_hash: HASH,
      },
      max_bytes: null,
      required: true,
    },
  },
  effective_limits: { max_attempts: 0 },
  capability_binding: {
    ref: versionedRef('example.capability'),
    node_type: 'system',
    executor_ref: versionedRef('example.executor'),
    skill_refs: [],
    input_ports: {},
    output_ports: {},
    no_artifact_expected: true,
    no_evaluation_expected: true,
    quality_revision_policy: null,
    required_tools: [],
    required_mcp_methods: [],
    required_file_scopes: [],
    required_claims: [],
    allowed_groups: [],
    retry_policy: {
      max_attempts: null,
      retry_on: [],
      backoff: 'fixed',
    },
    timeout_ceiling_ms: null,
    effect_impact: 'read_only',
    effect: { type: 'pure' },
    cancellation: { type: 'fence_only', safe_to_abandon: true },
    dependency_closure_hash: HASH,
  },
  effective_retry_policy: {
    effective_node_max_attempts: 1,
    effective_retry_on: [],
    backoff: 'fixed',
    quality_revision: null,
    policy_hash: HASH,
  },
};

const compiledScopePlan: JsonObject = {
  format: 'icarus.workflow-graph-scope-plan/1',
  compiler_version: 'fixture-compiler-1',
  compiler_build_hash: HASH,
  compiler_toolchain_ref: versionedRef('example.compiler-toolchain'),
  compiler_toolchain_hash: HASH,
  compiler_error_catalog_hash: HASH,
  canonical_normalizer_version: '1',
  canonical_normalizer_hash: HASH,
  proof_algorithm_version: '1',
  proof_algorithm_hash: HASH,
  plan_hash: HASH,
  source_hash: HASH,
  interface_snapshot_hash: HASH,
  policy_snapshot_hash: HASH,
  effective_policy_snapshot: graphPolicy,
  capability_catalog_hash: HASH,
  wait_contract_catalog_hash: HASH,
  interface_snapshot: {
    ref: versionedRef('example.interface'),
    inputs: {},
    exits: { done: { output_ports: {} } },
  },
  nodes: [
    compiledSystemNode,
    {
      id: 'done',
      type: 'terminal',
      source_config_hash: HASH,
      trigger_program: {
        normalized_expression: { type: 'root' },
        referenced_edge_ids: [],
        max_steps: 1,
        truth_program_hash: HASH,
      },
      input_ports: {},
      output_ports: {},
      effective_limits: {},
      exit: 'done',
    },
  ],
  route_groups: [],
  control_edges: [],
  data_edges: [],
  completion: {
    early_rules: [],
    settled_rules: [
      {
        id: 'select_done',
        phase: 'settled',
        normalized_fact_expression: { fact: 'all_nodes_terminal' },
        fact_program_hash: HASH,
        max_steps: 1,
        selector: {
          exits: ['done'],
          pick: { type: 'lowest_terminal_node_id' },
        },
        selector_contract_hash: HASH,
        priority: 100,
        monotonicity_proof: null,
        cancellation_safety_proof: null,
        rule_hash: HASH,
      },
    ],
    no_match: 'error',
    early_close: 'cancel_and_fence_remaining',
    policy_hash: HASH,
  },
  complexity_summary: {
    node_count: 1,
    control_edge_count: 0,
    data_edge_count: 0,
    max_source_fan_out: 0,
    max_condition_steps: 0,
    max_trigger_steps: 1,
    max_completion_steps: 1,
    max_reconcile_facts_per_ingress: 1,
    max_frontier_bytes: 1,
    summary_hash: HASH,
  },
  static_child_plan_closure_hash: HASH,
  effective_limits: zeroAndNullLimits,
  effective_usage_budget: zeroAndNullUsageBudget,
  runtime_safety_snapshot: runtimeSafety,
  runtime_safety_hash: HASH,
};

export interface ClosedSchemaPositiveCase extends JsonObject {
  case_id: string;
  schema_format: string;
  instance: JsonValue;
}

export interface ClosedSchemaNegativeCase extends ClosedSchemaPositiveCase {
  expected_keyword: string;
  expected_instance_pointer: string;
  expected_additional_property: string | null;
}

export const CLOSED_SCHEMA_POSITIVE_CASES: ClosedSchemaPositiveCase[] = [
  {
    case_id: 'workflow_definition_closed_union',
    schema_format: 'icarus.workflow-definition-schema/1',
    instance: workflowDefinition,
  },
  {
    case_id: 'workflow_recipe_exact_refs',
    schema_format: 'icarus.workflow-recipe-schema/1',
    instance: workflowRecipe,
  },
  {
    case_id: 'runtime_command_typed_target',
    schema_format: 'icarus.workflow-runtime-command-schema/1',
    instance: runtimeCommand,
  },
  {
    case_id: 'trusted_transition_minimal',
    schema_format: 'icarus.workflow-transition-schema/1',
    instance: transition,
  },
  {
    case_id: 'feature_manifest_vnext',
    schema_format: 'icarus.workflow-feature-manifest-v2-schema/1',
    instance: featureManifest,
  },
  {
    case_id: 'card_presentation_runtime_action',
    schema_format: 'icarus.workflow-card-presentation-schema/1',
    instance: cardPresentation,
  },
  {
    case_id: 'graph_scope_source_terminal',
    schema_format: 'icarus.workflow-graph-scope-source-schema/1',
    instance: graphScopeSource,
  },
  {
    case_id: 'compiled_scope_plan_closed_bindings',
    schema_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    instance: compiledScopePlan,
  },
];

export const CLOSED_SCHEMA_NEGATIVE_CASES: ClosedSchemaNegativeCase[] = [
  {
    case_id: 'definition_rejects_legacy_role',
    schema_format: 'icarus.workflow-definition-schema/1',
    instance: {
      ...workflowDefinition,
      states: {
        ...(workflowDefinition.states as JsonObject),
        start: {
          ...((workflowDefinition.states as JsonObject).start as JsonObject),
          role: 'legacy-role',
        },
      },
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/states/start',
    expected_additional_property: 'role',
  },
  {
    case_id: 'definition_rejects_before_delegate',
    schema_format: 'icarus.workflow-definition-schema/1',
    instance: {
      ...workflowDefinition,
      states: {
        ...(workflowDefinition.states as JsonObject),
        start: {
          ...((workflowDefinition.states as JsonObject).start as JsonObject),
          before_delegate: [],
        },
      },
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/states/start',
    expected_additional_property: 'before_delegate',
  },
  {
    case_id: 'definition_rejects_system_run_steps',
    schema_format: 'icarus.workflow-definition-schema/1',
    instance: {
      ...workflowDefinition,
      states: {
        ...(workflowDefinition.states as JsonObject),
        start: {
          ...((workflowDefinition.states as JsonObject).start as JsonObject),
          type: 'system',
          run: { steps: [] },
        },
      },
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/states/start',
    expected_additional_property: 'run',
  },
  {
    case_id: 'transition_rejects_notification_delivery_requirement',
    schema_format: 'icarus.workflow-transition-schema/1',
    instance: {
      target: 'done',
      notify: {
        contract_ref: versionedRef('example.notification'),
        input_bindings: {},
        delivery_requirement: 'required',
      },
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/notify',
    expected_additional_property: 'delivery_requirement',
  },
  {
    case_id: 'transition_rejects_child_creation_key_template',
    schema_format: 'icarus.workflow-transition-schema/1',
    instance: {
      target: 'done',
      effects: {
        operations: [
          {
            id: 'child',
            type: 'start_child_workflow',
            recipe_ref: versionedRef('example.child-recipe'),
            routing_scope_ref: versionedRef('example.child-routing'),
            principal_binding: 'inherit_parent_principal',
            creation_domain: 'parent_workflow_lineage',
            creation_key_template: 'legacy-{workflow}',
            relation_kind: 'follow_up',
            input_bindings: {},
            delivery_requirement: 'required',
            finalization_policy_ref: versionedRef('example.finalization'),
          },
        ],
      },
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/effects/operations/0',
    expected_additional_property: 'creation_key_template',
  },
  {
    case_id: 'transition_rejects_both_child_delivery_policies',
    schema_format: 'icarus.workflow-transition-schema/1',
    instance: {
      target: 'done',
      effects: {
        operations: [
          {
            id: 'child',
            type: 'start_child_workflow',
            recipe_ref: versionedRef('example.child-recipe'),
            routing_scope_ref: versionedRef('example.child-routing'),
            principal_binding: 'inherit_parent_principal',
            creation_domain: 'parent_workflow_lineage',
            relation_kind: 'follow_up',
            input_bindings: {},
            delivery_requirement: 'required',
            finalization_policy_ref: versionedRef('example.finalization'),
            outbox_delivery_policy_ref: versionedRef('example.outbox'),
          },
        ],
      },
    },
    expected_keyword: 'oneOf',
    expected_instance_pointer: '/effects/operations/0',
    expected_additional_property: null,
  },
  {
    case_id: 'transition_rejects_legacy_delegate',
    schema_format: 'icarus.workflow-transition-schema/1',
    instance: { target: 'done', delegate: { role: 'legacy-role' } },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_additional_property: 'delegate',
  },
  {
    case_id: 'recipe_rejects_mutable_child_ref',
    schema_format: 'icarus.workflow-recipe-schema/1',
    instance: {
      ...workflowRecipe,
      allowed_child_recipe_refs: [{ id: 'example.child', version: 'latest' }],
    },
    expected_keyword: 'not',
    expected_instance_pointer: '/allowed_child_recipe_refs/0/version',
    expected_additional_property: null,
  },
  {
    case_id: 'recipe_rejects_unknown_definition_allowlist',
    schema_format: 'icarus.workflow-recipe-schema/1',
    instance: { ...workflowRecipe, allowed_definition_refs: [] },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_additional_property: 'allowed_definition_refs',
  },
  {
    case_id: 'command_rejects_open_target_ref',
    schema_format: 'icarus.workflow-runtime-command-schema/1',
    instance: { ...runtimeCommand, target: { target_ref: 'run-1' } },
    expected_keyword: 'required',
    expected_instance_pointer: '/target',
    expected_additional_property: null,
  },
  {
    case_id: 'command_rejects_client_actor',
    schema_format: 'icarus.workflow-runtime-command-schema/1',
    instance: { ...runtimeCommand, actor_ref: 'human:forged' },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_additional_property: 'actor_ref',
  },
  ...[
    'workflowDefinitions',
    'cards',
    'artifactContracts',
    'workflowEvaluators',
  ].map(
    (removedKey): ClosedSchemaNegativeCase => ({
      case_id: `feature_manifest_rejects_${removedKey}`,
      schema_format: 'icarus.workflow-feature-manifest-v2-schema/1',
      instance: { ...featureManifest, [removedKey]: [] },
      expected_keyword: 'additionalProperties',
      expected_instance_pointer: '',
      expected_additional_property: removedKey,
    }),
  ),
  {
    case_id: 'feature_manifest_rejects_parent_source_path',
    schema_format: 'icarus.workflow-feature-manifest-v2-schema/1',
    instance: {
      ...featureManifest,
      dynamic_workflow_resources: [
        {
          kind: 'definition',
          ref: versionedRef('example.workflow'),
          source_path: 'workflow-src/../example.workflow.json',
          expected_source_hash: HASH,
        },
      ],
    },
    expected_keyword: 'pattern',
    expected_instance_pointer: '/dynamic_workflow_resources/0/source_path',
    expected_additional_property: null,
  },
  {
    case_id: 'card_rejects_required_delivery',
    schema_format: 'icarus.workflow-card-presentation-schema/1',
    instance: { ...cardPresentation, delivery_requirement: 'required' },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_additional_property: 'delivery_requirement',
  },
  {
    case_id: 'source_rejects_loop_node',
    schema_format: 'icarus.workflow-graph-scope-source-schema/1',
    instance: {
      ...graphScopeSource,
      nodes: [{ id: 'loop', type: 'loop', trigger: { type: 'root' } }],
    },
    expected_keyword: 'oneOf',
    expected_instance_pointer: '/nodes/0',
    expected_additional_property: null,
  },
  {
    case_id: 'source_rejects_scheduler_priority',
    schema_format: 'icarus.workflow-graph-scope-source-schema/1',
    instance: {
      ...graphScopeSource,
      nodes: [
        {
          id: 'done',
          type: 'terminal',
          trigger: { type: 'root' },
          exit: 'done',
          scheduler_priority: 100,
        },
      ],
    },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '/nodes/0',
    expected_additional_property: 'scheduler_priority',
  },
  {
    case_id: 'compiled_plan_rejects_unknown_field',
    schema_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    instance: { ...compiledScopePlan, runtime_fallback: 'recompile' },
    expected_keyword: 'additionalProperties',
    expected_instance_pointer: '',
    expected_additional_property: 'runtime_fallback',
  },
  {
    case_id: 'compiled_plan_rejects_unknown_generated_schema_scheme',
    schema_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    instance: {
      ...compiledScopePlan,
      nodes: [
        {
          ...compiledSystemNode,
          input_ports: {
            request: {
              ...((compiledSystemNode.input_ports as JsonObject)
                .request as JsonObject),
              schema: {
                ...((
                  (compiledSystemNode.input_ports as JsonObject)
                    .request as JsonObject
                ).schema as JsonObject),
                schema_ref: `schema:${'0'.repeat(64)}`,
              },
            },
          },
        },
        ...(compiledScopePlan.nodes as JsonValue[]).slice(1),
      ],
    },
    expected_keyword: 'pattern',
    expected_instance_pointer: '/nodes/0/input_ports/request/schema/schema_ref',
    expected_additional_property: null,
  },
  {
    case_id: 'compiled_plan_rejects_missing_generated_schema_json',
    schema_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    instance: {
      ...compiledScopePlan,
      nodes: [
        {
          ...compiledSystemNode,
          input_ports: {
            request: {
              ...((compiledSystemNode.input_ports as JsonObject)
                .request as JsonObject),
              schema: withoutKey(
                (
                  (compiledSystemNode.input_ports as JsonObject)
                    .request as JsonObject
                ).schema as JsonObject,
                'schema_json',
              ),
            },
          },
        },
        ...(compiledScopePlan.nodes as JsonValue[]).slice(1),
      ],
    },
    expected_keyword: 'required',
    expected_instance_pointer: '/nodes/0/input_ports/request/schema',
    expected_additional_property: null,
  },
  {
    case_id: 'compiled_plan_rejects_both_artifact_contract_choices',
    schema_format: 'icarus.workflow-compiled-scope-plan-schema/1',
    instance: {
      ...compiledScopePlan,
      nodes: [
        {
          ...compiledSystemNode,
          capability_binding: {
            ...(compiledSystemNode.capability_binding as JsonObject),
            artifact_contract_ref: versionedRef('example.artifact-contract'),
          },
        },
        ...(compiledScopePlan.nodes as JsonValue[]).slice(1),
      ],
    },
    expected_keyword: 'oneOf',
    expected_instance_pointer: '/nodes/0/capability_binding',
    expected_additional_property: null,
  },
];
