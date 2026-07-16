import { domainSeparatedSha256 } from './hash.js';
import type {
  GoldenDraftDiagnostic,
  GoldenDraftSemanticAssertion,
  GoldenDraftSourceKind,
} from './golden-draft-types.js';
import type { JsonObject, JsonValue, VersionedRef } from './types.js';

const HASH = `sha256:${'0'.repeat(64)}`;

function ref(id: string, version = '1.0.0'): VersionedRef {
  return { id, version };
}

export const GOLDEN_DRAFT_POSITIVE_COVERAGE = [
  'static_lowering',
  'condition_route',
  'wait',
  'subgraph',
  'expand',
  'map',
  'policy_intersection',
  'quality_revision_capability_binding',
  'sound_subtype_different_hash',
  'static_child_closure',
] as const;

export const GOLDEN_DRAFT_ADDITIONAL_NEGATIVE_COVERAGE = [
  'quality_revision_missing_feedback_schema',
  'quality_revision_missing_quality_gate',
  'definition_notification_delivery_requirement_removed',
  'definition_child_creation_key_template_removed',
] as const;

const requestedLimits: JsonObject = {
  max_scopes: null,
  max_nodes: null,
  max_nodes_per_scope: null,
  max_edges_per_scope: null,
  max_nesting_depth: null,
  max_map_items: null,
  max_concurrency: null,
  max_total_attempts: null,
  max_total_waits: null,
  max_total_output_bytes: null,
  max_scope_spec_bytes: null,
  max_condition_steps: null,
  max_wait_duration_ms: null,
  max_pending_signals: null,
  max_fixed_point_facts: null,
  max_frontier_bytes: null,
};

const usageBudget: JsonObject = {
  max_total_tool_calls: null,
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
  allowed_capabilities: [
    ref('fixture.capability.static'),
    ref('fixture.capability.route'),
    ref('fixture.capability.quality'),
    ref('fixture.capability.producer-string'),
    ref('fixture.capability.consumer-string'),
    ref('fixture.capability.consumer-number'),
    ref('fixture.capability.unsafe-cancel'),
    ref('fixture.capability.missing-feedback-schema'),
    ref('fixture.capability.missing-quality-gate'),
    ref('fixture.capability.incompatible-effect-key'),
  ],
  allowed_templates: [ref('fixture.template.child')],
  allowed_interface_refs: [
    ref('fixture.interface.root'),
    ref('fixture.interface.child'),
  ],
  allowed_wait_contracts: [ref('fixture.wait.approval')],
  allowed_child_policy_refs: [ref('fixture.policy.child-tight')],
  allowed_claim_ids: [],
  allow_early_close: true,
  allow_indefinite_waits: false,
  effect_policy: {
    allowed_recovery_kinds: ['pure', 'idempotent', 'compensatable'],
    max_impact: 'mutable_effects',
  },
  build_retry: null,
  limits: requestedLimits,
  usage_budget: usageBudget,
};

function completion(exit = 'done'): JsonObject {
  return {
    settled_rules: [
      {
        id: `select_${exit}`,
        phase: 'settled',
        priority: 100,
        when: { fact: 'all_nodes_terminal' },
        select: {
          exits: [exit],
          pick: { type: 'lowest_terminal_node_id' },
        },
      },
    ],
    no_match: 'error',
    early_close: 'cancel_and_fence_remaining',
  };
}

function terminal(id: string, trigger: JsonObject, exit = 'done'): JsonObject {
  return { id, type: 'terminal', trigger, exit };
}

function controlEdge(
  id: string,
  from: string,
  to: string,
  extras: JsonObject = {},
): JsonObject {
  return {
    id,
    kind: 'control',
    from_node_id: from,
    to_node_id: to,
    on: { statuses: ['succeeded'] },
    ...extras,
  };
}

function graph(
  scopeKey: string,
  nodes: JsonValue[],
  controlEdges: JsonValue[] = [],
  dataEdges: JsonValue[] = [],
  overrides: JsonObject = {},
): JsonObject {
  return {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: scopeKey,
    interface_ref: ref('fixture.interface.root'),
    nodes,
    control_edges: controlEdges,
    data_edges: dataEdges,
    completion: completion(),
    requested_limits: requestedLimits,
    ...overrides,
  };
}

function systemNode(
  id: string,
  capability: string,
  trigger: JsonObject,
): JsonObject {
  return {
    id,
    type: 'system',
    trigger,
    capability_ref: ref(capability),
  };
}

function childScope(scopeKey: string): JsonObject {
  return graph(scopeKey, [terminal('child_done', { type: 'root' })]);
}

function subgraphNode(
  id: string,
  trigger: JsonObject,
  scope: JsonObject,
): JsonObject {
  return {
    id,
    type: 'subgraph',
    trigger,
    scope: { type: 'inline', scope },
    input_ports: {},
    child_input_bindings: {},
    completion_output_port: 'completion',
    expose: {},
    child_policy_ref: ref('fixture.policy.child-tight'),
  };
}

function normalTerminalDefinition(): JsonObject {
  return {
    type: 'terminal',
    terminal_kind: 'normal',
    output_binding: { source: 'constant', value: { status: 'done' } },
  };
}

function workflowDefinition(startState: JsonObject): JsonObject {
  return {
    format: 'icarus.workflow-definition/1',
    ref: ref('fixture.definition.main'),
    owner_feature_id: 'fixture-feature',
    name: 'Golden draft fixture',
    context_contract_ref: ref('fixture.context'),
    entry_points: { default: { state_key: 'start' } },
    states: { start: startState, done: normalTerminalDefinition() },
    definition_hash: HASH,
  };
}

function delegationState(
  transition: JsonObject = { target: 'done' },
): JsonObject {
  return {
    type: 'delegation',
    capability_ref: ref('fixture.capability.static'),
    policy: graphPolicy,
    input_bindings: {},
    retry_request: null,
    timeout_ms: null,
    on_complete: { success: transition, failure: { target: 'done' } },
    on_error: { target: 'done' },
    on_local_cancel: { target: 'done' },
  };
}

function rawJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function diagnostic(
  code: GoldenDraftDiagnostic['code'],
  phase: GoldenDraftDiagnostic['phase'],
  instancePointer: string,
  stableObjectId: string | null = null,
  schemaPointer: string | null = null,
): GoldenDraftDiagnostic {
  return {
    code,
    phase,
    instance_pointer: instancePointer,
    schema_pointer: schemaPointer,
    stable_object_id: stableObjectId,
    detail_ref: null,
  };
}

function assertion(
  assertionId: string,
  subjectPointer: string,
  operator: GoldenDraftSemanticAssertion['operator'],
  expected: JsonValue,
  rationale: string,
): GoldenDraftSemanticAssertion {
  return {
    assertion_id: assertionId,
    subject_pointer: subjectPointer,
    operator,
    expected,
    rationale,
  };
}

export interface GoldenDraftCaseSeed {
  case_id: string;
  polarity: 'positive' | 'negative';
  source_kind: GoldenDraftSourceKind;
  coverage_tags: string[];
  raw_source_text: string;
  input_snapshot_id: 'complete-base' | 'compiler-integrity-mismatch';
  expected_diagnostics: GoldenDraftDiagnostic[];
  assertions: GoldenDraftSemanticAssertion[];
}

const conditionRouteSource = graph(
  'condition_route',
  [
    systemNode('classify', 'fixture.capability.route', { type: 'root' }),
    terminal('accepted', { type: 'all', edge_ids: ['edge.accepted'] }),
    terminal('rejected', { type: 'all', edge_ids: ['edge.rejected'] }),
  ],
  [
    controlEdge('edge.accepted', 'classify', 'accepted', {
      route_group_id: 'route.classify',
      priority: 100,
      when: {
        op: 'eq',
        left: {
          ref: { source: 'edge_source_output', port: 'result', pointer: '/ok' },
        },
        right: { literal: true },
      },
    }),
    {
      id: 'edge.rejected',
      kind: 'control',
      from_node_id: 'classify',
      to_node_id: 'rejected',
      route_group_id: 'route.classify',
      default: true,
    },
  ],
  [],
  {
    route_groups: [
      {
        id: 'route.classify',
        from_node_id: 'classify',
        mode: 'first_matching',
        no_match: 'error',
      },
    ],
    completion: {
      settled_rules: [
        {
          id: 'select_result',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
  },
);

const waitSource = graph(
  'wait',
  [
    {
      id: 'approval',
      type: 'wait',
      trigger: { type: 'root' },
      wait: {
        type: 'approval',
        contract_ref: ref('fixture.wait.approval'),
        correlation_input_port: 'correlation_key',
        timeout_ms: 60000,
      },
    },
    terminal('done', { type: 'all', edge_ids: ['edge.approved'] }),
  ],
  [controlEdge('edge.approved', 'approval', 'done')],
);

const subgraphSource = graph(
  'subgraph',
  [
    subgraphNode('child', { type: 'root' }, childScope('child_static')),
    terminal('done', { type: 'all', edge_ids: ['edge.child'] }),
  ],
  [controlEdge('edge.child', 'child', 'done')],
);

const expandSource = graph(
  'expand',
  [
    {
      id: 'expand_child',
      type: 'expand',
      trigger: { type: 'root' },
      child_interface_ref: ref('fixture.interface.child'),
      input_ports: {
        graph_spec: {
          schema_ref: ref('fixture.schema.graph-scope'),
          max_bytes: 1048576,
          aggregation: { type: 'single', required: true, select: 'only' },
        },
      },
      graph_spec_input_port: 'graph_spec',
      child_input_bindings: {},
      completion_output_port: 'completion',
      expose: {},
      child_policy_ref: ref('fixture.policy.child-tight'),
    },
    terminal('done', { type: 'all', edge_ids: ['edge.expanded'] }),
  ],
  [controlEdge('edge.expanded', 'expand_child', 'done')],
  [
    {
      id: 'data.graph-spec',
      kind: 'data',
      from: { type: 'literal', value: childScope('dynamic_child') },
      to: { node_id: 'expand_child', port: 'graph_spec' },
    },
  ],
);

const mapSource = graph(
  'map',
  [
    {
      id: 'map_items',
      type: 'map',
      trigger: { type: 'root' },
      body: { type: 'inline', scope: childScope('map_body') },
      input_ports: {
        items: {
          schema_ref: ref('fixture.schema.string-array'),
          max_bytes: 65536,
          aggregation: { type: 'single', required: true, select: 'only' },
        },
      },
      items_input_port: 'items',
      item_child_input_port: 'item',
      shared_child_input_bindings: {},
      result_output_port: 'results',
      requested_max_items: 4,
      requested_child_concurrency: 2,
      completion: { type: 'all_settled', child_error: 'record' },
      child_policy_ref: ref('fixture.policy.child-tight'),
    },
    terminal('done', { type: 'all', edge_ids: ['edge.mapped'] }),
  ],
  [controlEdge('edge.mapped', 'map_items', 'done')],
  [
    {
      id: 'data.items',
      kind: 'data',
      from: { type: 'literal', value: ['a', 'b'] },
      to: { node_id: 'map_items', port: 'items' },
    },
  ],
);

const subtypeSource = graph(
  'subtype',
  [
    systemNode('producer', 'fixture.capability.producer-string', {
      type: 'root',
    }),
    systemNode('consumer', 'fixture.capability.consumer-string', {
      type: 'all',
      edge_ids: ['edge.producer'],
    }),
    terminal('done', { type: 'all', edge_ids: ['edge.consumer'] }),
  ],
  [
    controlEdge('edge.producer', 'producer', 'consumer'),
    controlEdge('edge.consumer', 'consumer', 'done'),
  ],
  [
    {
      id: 'data.value',
      kind: 'data',
      from: { type: 'node_output', node_id: 'producer', port: 'value' },
      to: { node_id: 'consumer', port: 'value' },
    },
  ],
);

const nestedChild = childScope('leaf_child');
const nestedScope = graph(
  'nested_child',
  [
    subgraphNode('leaf', { type: 'root' }, nestedChild),
    terminal('done', { type: 'all', edge_ids: ['edge.leaf'] }),
  ],
  [controlEdge('edge.leaf', 'leaf', 'done')],
);
const staticClosureSource = graph(
  'static_child_closure',
  [
    subgraphNode('nested', { type: 'root' }, nestedScope),
    terminal('done', { type: 'all', edge_ids: ['edge.nested'] }),
  ],
  [controlEdge('edge.nested', 'nested', 'done')],
);

function negativeGraph(
  caseId: string,
  mutate: (source: JsonObject) => JsonObject,
): string {
  return rawJson(mutate(graph(caseId, [terminal('done', { type: 'root' })])));
}

const childEffect: JsonObject = {
  id: 'child.follow-up',
  type: 'start_child_workflow',
  recipe_ref: ref('fixture.recipe.child'),
  routing_scope_ref: ref('fixture.routing.child'),
  principal_binding: 'inherit_parent_principal',
  creation_domain: 'parent_workflow_lineage',
  relation_kind: 'follow_up',
  input_bindings: {},
  delivery_requirement: 'required',
  finalization_policy_ref: ref('fixture.finalization'),
};

const positiveCases: GoldenDraftCaseSeed[] = [
  {
    case_id: 'positive.static-lowering',
    polarity: 'positive',
    source_kind: 'workflow_definition',
    coverage_tags: ['static_lowering'],
    raw_source_text: rawJson(workflowDefinition(delegationState())),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'lowered-root-node',
        '/normalized/nodes/0/type',
        'equals',
        'delegation',
        'The trusted delegation state lowers to one delegation node.',
      ),
      assertion(
        'lowered-terminal-exits',
        '/normalized/interface/exits',
        'set_equals',
        ['success', 'failure', 'error', 'local_cancel'],
        'Static lowering preserves the four trusted result routes.',
      ),
    ],
  },
  {
    case_id: 'positive.condition-route',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['condition_route'],
    raw_source_text: rawJson(conditionRouteSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'route-order',
        '/normalized/route_groups/0/ordered_edge_ids',
        'ordered_equals',
        ['edge.accepted', 'edge.rejected'],
        'Priority edge precedes the default edge.',
      ),
      assertion(
        'condition-typed',
        '/normalized/control_edges/0/condition_program/operand_types',
        'equals',
        ['boolean', 'boolean'],
        'The equality condition compares compatible boolean operands.',
      ),
    ],
  },
  {
    case_id: 'positive.wait',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['wait'],
    raw_source_text: rawJson(waitSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'wait-binding',
        '/normalized/nodes/approval/wait_binding/contract_ref',
        'equals',
        ref('fixture.wait.approval'),
        'Wait binding is pinned to the exact approval contract.',
      ),
    ],
  },
  {
    case_id: 'positive.subgraph',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['subgraph'],
    raw_source_text: rawJson(subgraphSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'subgraph-precompiled',
        '/normalized/nodes/child/factory_binding/precompiled_plan_hash',
        'present',
        true,
        'Static subgraph binding requires a precompiled child plan candidate.',
      ),
    ],
  },
  {
    case_id: 'positive.expand',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['expand'],
    raw_source_text: rawJson(expandSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'expand-graph-spec-port',
        '/normalized/nodes/expand_child/graph_spec_input_port',
        'equals',
        'graph_spec',
        'Expand consumes the required single GraphScopeSpec port.',
      ),
    ],
  },
  {
    case_id: 'positive.map',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['map'],
    raw_source_text: rawJson(mapSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'map-result-order',
        '/normalized/nodes/map_items/result_order',
        'equals',
        'item_index',
        'Map results remain ordered by frozen item index.',
      ),
    ],
  },
  {
    case_id: 'positive.policy-intersection',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['policy_intersection'],
    raw_source_text: rawJson(
      graph(
        'policy_intersection',
        [terminal('done', { type: 'root' })],
        [],
        [],
        {
          requested_limits: {
            ...requestedLimits,
            max_nodes: 8,
            max_concurrency: 2,
          },
        },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'policy-minimum',
        '/normalized/effective_limits/max_nodes',
        'equals',
        8,
        'Requested limit tightens the parent and safety ceilings.',
      ),
    ],
  },
  {
    case_id: 'positive.quality-revision-binding',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['quality_revision_capability_binding'],
    raw_source_text: rawJson(
      graph(
        'quality_revision',
        [
          systemNode('quality', 'fixture.capability.quality', { type: 'root' }),
          terminal('done', { type: 'all', edge_ids: ['edge.quality'] }),
        ],
        [controlEdge('edge.quality', 'quality', 'done')],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'quality-feedback-schema',
        '/normalized/nodes/quality/effective_retry_policy/quality_revision/feedback_schema_ref',
        'equals',
        ref('fixture.schema.feedback'),
        'Quality revision binding freezes its feedback schema.',
      ),
    ],
  },
  {
    case_id: 'positive.sound-subtype-different-hash',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['sound_subtype_different_hash'],
    raw_source_text: rawJson(subtypeSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'subtype-rule',
        '/normalized/data_edges/data.value/compatibility_proof/proof_rule',
        'equals',
        'enum_subset',
        'Producer enum is a sound subset of the consumer string enum despite different hashes.',
      ),
    ],
  },
  {
    case_id: 'positive.static-child-closure',
    polarity: 'positive',
    source_kind: 'graph_scope',
    coverage_tags: ['static_child_closure'],
    raw_source_text: rawJson(staticClosureSource),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [],
    assertions: [
      assertion(
        'nested-static-closure',
        '/normalized/static_child_plan_closure/members',
        'contains',
        ['nested_child', 'leaf_child'],
        'Nested inline factories are included in the static child closure.',
      ),
    ],
  },
];

const negativeCases: GoldenDraftCaseSeed[] = [
  {
    case_id: 'negative.json-syntax-invalid',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['json_syntax_invalid'],
    raw_source_text: '{"format":"icarus.workflow-graph-scope/1",\n',
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [diagnostic('json_syntax_invalid', 'parse', '')],
    assertions: [],
  },
  {
    case_id: 'negative.json-duplicate-key',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['json_duplicate_key'],
    raw_source_text:
      '{"format":"icarus.workflow-graph-scope/1","scope_key":"first","scope_key":"second"}\n',
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic('json_duplicate_key', 'parse', '/scope_key'),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.schema-unknown-field',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['schema_unknown_field'],
    raw_source_text: negativeGraph('unknown_field', (source) => ({
      ...source,
      compiler_hint: 'forbidden',
    })),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'schema_unknown_field',
        'schema',
        '/compiler_hint',
        null,
        '#/additionalProperties',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.schema-profile-keyword-unsupported',
    polarity: 'negative',
    source_kind: 'workflow_schema',
    coverage_tags: ['schema_profile_keyword_unsupported'],
    raw_source_text: rawJson({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    }),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'schema_profile_keyword_unsupported',
        'schema',
        '/anyOf',
        null,
        '#/profile/forbiddenKeywords',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.registry-ref-unpinned',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['registry_ref_unpinned'],
    raw_source_text: negativeGraph('unpinned', (source) => ({
      ...source,
      interface_ref: ref('fixture.interface.root', 'latest'),
    })),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'registry_ref_unpinned',
        'bind',
        '/interface_ref/version',
        'fixture.interface.root',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.registry-ref-not-found',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['registry_ref_not_found'],
    raw_source_text: negativeGraph('missing_ref', (source) => ({
      ...source,
      interface_ref: ref('fixture.interface.missing'),
    })),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'registry_ref_not_found',
        'bind',
        '/interface_ref',
        'fixture.interface.missing',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.graph-id-duplicate',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['graph_id_duplicate'],
    raw_source_text: rawJson(
      graph('duplicate_id', [
        terminal('same', { type: 'root' }),
        terminal('same', { type: 'root' }),
      ]),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic('graph_id_duplicate', 'bind', '/nodes/1/id', 'same'),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.graph-endpoint-not-found',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['graph_endpoint_not_found'],
    raw_source_text: rawJson(
      graph(
        'missing_endpoint',
        [systemNode('source', 'fixture.capability.static', { type: 'root' })],
        [controlEdge('edge.missing', 'source', 'missing')],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'graph_endpoint_not_found',
        'bind',
        '/control_edges/0/to_node_id',
        'edge.missing',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.graph-cross-scope-edge',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['graph_cross_scope_edge'],
    raw_source_text: rawJson(
      graph(
        'cross_scope',
        [
          subgraphNode(
            'child',
            { type: 'root' },
            childScope('cross_scope_child'),
          ),
          terminal('done', { type: 'all', edge_ids: ['edge.cross'] }),
        ],
        [controlEdge('edge.cross', 'child::child_done', 'done')],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'graph_cross_scope_edge',
        'bind',
        '/control_edges/0/from_node_id',
        'edge.cross',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.graph-dependency-cycle',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['graph_dependency_cycle'],
    raw_source_text: rawJson(
      graph(
        'cycle',
        [
          systemNode('a', 'fixture.capability.static', {
            type: 'all',
            edge_ids: ['edge.ba'],
          }),
          systemNode('b', 'fixture.capability.static', {
            type: 'all',
            edge_ids: ['edge.ab'],
          }),
        ],
        [controlEdge('edge.ab', 'a', 'b'), controlEdge('edge.ba', 'b', 'a')],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'graph_dependency_cycle',
        'prove',
        '/control_edges',
        'edge.ab',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.condition-type-mismatch',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['condition_type_mismatch'],
    raw_source_text: rawJson(
      graph(
        'condition_types',
        [
          systemNode('source', 'fixture.capability.route', { type: 'root' }),
          terminal('done', { type: 'all', edge_ids: ['edge.condition'] }),
        ],
        [
          controlEdge('edge.condition', 'source', 'done', {
            when: {
              op: 'lt',
              left: { literal: 'text' },
              right: { literal: 2 },
            },
          }),
        ],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'condition_type_mismatch',
        'prove',
        '/control_edges/0/when',
        'edge.condition',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.condition-complexity-exceeded',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['condition_complexity_exceeded'],
    raw_source_text: rawJson(
      graph(
        'condition_complexity',
        [
          systemNode('source', 'fixture.capability.route', { type: 'root' }),
          terminal('done', { type: 'all', edge_ids: ['edge.condition'] }),
        ],
        [
          controlEdge('edge.condition', 'source', 'done', {
            when: {
              op: 'not',
              arg: {
                op: 'not',
                arg: { op: 'exists', value: { literal: true } },
              },
            },
          }),
        ],
        [],
        { requested_limits: { ...requestedLimits, max_condition_steps: 1 } },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'condition_complexity_exceeded',
        'prove',
        '/control_edges/0/when',
        'edge.condition',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.json-pointer-non-total',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['json_pointer_non_total'],
    raw_source_text: rawJson(
      graph(
        'pointer_non_total',
        [
          systemNode('producer', 'fixture.capability.producer-string', {
            type: 'root',
          }),
          systemNode('consumer', 'fixture.capability.consumer-string', {
            type: 'all',
            edge_ids: ['edge.producer'],
          }),
        ],
        [controlEdge('edge.producer', 'producer', 'consumer')],
        [
          {
            id: 'data.pointer',
            kind: 'data',
            from: {
              type: 'node_output',
              node_id: 'producer',
              port: 'value',
              pointer: '/optional',
            },
            to: { node_id: 'consumer', port: 'value' },
          },
        ],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'json_pointer_non_total',
        'prove',
        '/data_edges/0/from/pointer',
        'data.pointer',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.schema-not-assignable',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['schema_not_assignable'],
    raw_source_text: rawJson(
      graph(
        'not_assignable',
        [
          systemNode('producer', 'fixture.capability.producer-string', {
            type: 'root',
          }),
          systemNode('consumer', 'fixture.capability.consumer-number', {
            type: 'all',
            edge_ids: ['edge.producer'],
          }),
        ],
        [controlEdge('edge.producer', 'producer', 'consumer')],
        [
          {
            id: 'data.value',
            kind: 'data',
            from: { type: 'node_output', node_id: 'producer', port: 'value' },
            to: { node_id: 'consumer', port: 'value' },
          },
        ],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'schema_not_assignable',
        'prove',
        '/data_edges/0',
        'data.value',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.route-group-ambiguous',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['route_group_ambiguous'],
    raw_source_text: rawJson(
      graph(
        'ambiguous_route',
        [
          systemNode('source', 'fixture.capability.route', { type: 'root' }),
          terminal('a', { type: 'all', edge_ids: ['edge.a'] }),
          terminal('b', { type: 'all', edge_ids: ['edge.b'] }),
        ],
        [
          controlEdge('edge.a', 'source', 'a', {
            route_group_id: 'route.source',
            priority: 10,
          }),
          controlEdge('edge.b', 'source', 'b', {
            route_group_id: 'route.source',
            priority: 10,
          }),
        ],
        [],
        {
          route_groups: [
            {
              id: 'route.source',
              from_node_id: 'source',
              mode: 'first_matching',
              no_match: 'error',
            },
          ],
        },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'route_group_ambiguous',
        'prove',
        '/route_groups/0',
        'route.source',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.trigger-contract-invalid',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['trigger_contract_invalid'],
    raw_source_text: rawJson(
      graph(
        'trigger_invalid',
        [
          systemNode('source', 'fixture.capability.static', { type: 'root' }),
          terminal('done', { type: 'root' }),
        ],
        [controlEdge('edge.source', 'source', 'done')],
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'trigger_contract_invalid',
        'prove',
        '/nodes/1/trigger',
        'done',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.completion-contract-invalid',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['completion_contract_invalid'],
    raw_source_text: rawJson(
      graph(
        'completion_invalid',
        [terminal('done', { type: 'root' })],
        [],
        [],
        { completion: completion('missing_exit') },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'completion_contract_invalid',
        'prove',
        '/completion/settled_rules/0/select/exits/0',
        'select_missing_exit',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.early-completion-non-monotone',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['early_completion_non_monotone'],
    raw_source_text: rawJson(
      graph(
        'early_non_monotone',
        [terminal('done', { type: 'root' })],
        [],
        [],
        {
          completion: {
            early_rules: [
              {
                id: 'early_eq',
                phase: 'early',
                arbitration: 'first_eligible',
                same_event_priority: 10,
                when: { fact: 'candidate_count', cmp: 'eq', value: 1 },
                select: { exits: ['done'], pick: { type: 'first_reached' } },
              },
            ],
            settled_rules: [],
            no_match: 'error',
            early_close: 'cancel_and_fence_remaining',
          },
        },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'early_completion_non_monotone',
        'prove',
        '/completion/early_rules/0/when',
        'early_eq',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.early-completion-cancellation-unsafe',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['early_completion_cancellation_unsafe'],
    raw_source_text: rawJson(
      graph(
        'early_unsafe',
        [
          systemNode('unsafe', 'fixture.capability.unsafe-cancel', {
            type: 'root',
          }),
          terminal('done', { type: 'root' }),
        ],
        [],
        [],
        {
          completion: {
            early_rules: [
              {
                id: 'early_done',
                phase: 'early',
                arbitration: 'first_eligible',
                same_event_priority: 10,
                when: { fact: 'candidate_count', cmp: 'gte', value: 1 },
                select: { exits: ['done'], pick: { type: 'first_reached' } },
              },
            ],
            settled_rules: [],
            no_match: 'error',
            early_close: 'cancel_and_fence_remaining',
          },
        },
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'early_completion_cancellation_unsafe',
        'prove',
        '/completion/early_rules/0',
        'early_done',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.capability-not-allowed',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['capability_not_allowed'],
    raw_source_text: rawJson(
      graph('capability_denied', [
        systemNode('forbidden', 'fixture.capability.forbidden', {
          type: 'root',
        }),
      ]),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'capability_not_allowed',
        'bind',
        '/nodes/0/capability_ref',
        'forbidden',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.policy-escalation',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['policy_escalation'],
    raw_source_text: rawJson(
      graph(
        'policy_escalation',
        [
          subgraphNode('child', { type: 'root' }, childScope('policy_child')),
        ].map((node) => ({
          ...node,
          child_policy_ref: ref('fixture.policy.child-escalating'),
        })),
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'policy_escalation',
        'bind',
        '/nodes/0/child_policy_ref',
        'child',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.quality-revision-missing-feedback-schema',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: [
      'quality_revision_contract_invalid',
      'quality_revision_missing_feedback_schema',
    ],
    raw_source_text: rawJson(
      graph('missing_feedback_schema', [
        systemNode('quality', 'fixture.capability.missing-feedback-schema', {
          type: 'root',
        }),
      ]),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'quality_revision_contract_invalid',
        'bind',
        '/nodes/0/capability_ref',
        'quality',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.quality-revision-effect-key-incompatible',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['quality_revision_effect_key_incompatible'],
    raw_source_text: rawJson(
      graph('incompatible_effect_key', [
        systemNode('quality', 'fixture.capability.incompatible-effect-key', {
          type: 'root',
        }),
      ]),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'quality_revision_effect_key_incompatible',
        'bind',
        '/nodes/0/capability_ref',
        'quality',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.child-recipe-set-mismatch',
    polarity: 'negative',
    source_kind: 'workflow_definition',
    coverage_tags: ['child_recipe_set_mismatch'],
    raw_source_text: rawJson(
      workflowDefinition(
        delegationState({
          target: 'done',
          effects: { operations: [childEffect] },
        }),
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'child_recipe_set_mismatch',
        'bind',
        '/states/start/on_complete/success/effects/operations/0/recipe_ref',
        'fixture.recipe.parent',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.child-recipe-dependency-cycle',
    polarity: 'negative',
    source_kind: 'workflow_definition',
    coverage_tags: ['child_recipe_dependency_cycle'],
    raw_source_text: rawJson({
      ...workflowDefinition(delegationState()),
      ref: ref('fixture.definition.child-cycle'),
    }),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'child_recipe_dependency_cycle',
        'prove',
        '/ref',
        'fixture.recipe.cycle-a',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.runtime-safety-limit-exceeded',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['runtime_safety_limit_exceeded'],
    raw_source_text: rawJson(
      graph(
        'safety_nodes',
        Array.from({ length: 129 }, (_, index) =>
          terminal(`terminal_${String(index).padStart(3, '0')}`, {
            type: 'root',
          }),
        ),
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'runtime_safety_limit_exceeded',
        'prove',
        '/nodes',
        'safety_nodes',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.compiler-integrity-mismatch',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: ['compiler_integrity_mismatch'],
    raw_source_text: negativeGraph('integrity_mismatch', (source) => source),
    input_snapshot_id: 'compiler-integrity-mismatch',
    expected_diagnostics: [
      diagnostic('compiler_integrity_mismatch', 'hash', '', null),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.quality-revision-missing-quality-gate',
    polarity: 'negative',
    source_kind: 'graph_scope',
    coverage_tags: [
      'quality_revision_contract_invalid',
      'quality_revision_missing_quality_gate',
    ],
    raw_source_text: rawJson(
      graph('missing_quality_gate', [
        systemNode('quality', 'fixture.capability.missing-quality-gate', {
          type: 'root',
        }),
      ]),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'quality_revision_contract_invalid',
        'bind',
        '/nodes/0/capability_ref',
        'quality',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.definition-notification-delivery-requirement',
    polarity: 'negative',
    source_kind: 'workflow_definition',
    coverage_tags: [
      'schema_unknown_field',
      'definition_notification_delivery_requirement_removed',
    ],
    raw_source_text: rawJson(
      workflowDefinition(
        delegationState({
          target: 'done',
          notify: {
            contract_ref: ref('fixture.notification'),
            input_bindings: {},
            delivery_requirement: 'required',
          },
        }),
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'schema_unknown_field',
        'schema',
        '/states/start/on_complete/success/notify/delivery_requirement',
        null,
        '#/$defs/transition/properties/notify/additionalProperties',
      ),
    ],
    assertions: [],
  },
  {
    case_id: 'negative.definition-child-creation-key-template',
    polarity: 'negative',
    source_kind: 'workflow_definition',
    coverage_tags: [
      'schema_unknown_field',
      'definition_child_creation_key_template_removed',
    ],
    raw_source_text: rawJson(
      workflowDefinition(
        delegationState({
          target: 'done',
          effects: {
            operations: [
              {
                ...childEffect,
                creation_key_template: 'forbidden-{workflow_id}',
              },
            ],
          },
        }),
      ),
    ),
    input_snapshot_id: 'complete-base',
    expected_diagnostics: [
      diagnostic(
        'schema_unknown_field',
        'schema',
        '/states/start/on_complete/success/effects/operations/0/creation_key_template',
        'child.follow-up',
        '#/$defs/transition_effect/additionalProperties',
      ),
    ],
    assertions: [],
  },
];

for (const seed of negativeCases) {
  seed.assertions = [
    assertion(
      `${seed.case_id}.diagnostic`,
      '/diagnostics/0/code',
      'equals',
      seed.expected_diagnostics[0]!.code,
      'The hand-authored diagnostic is the stable oracle candidate for independent review.',
    ),
    assertion(
      `${seed.case_id}.no-plan`,
      '/expected_plan_bytes_ref',
      'equals',
      null,
      'Rejected source cannot have candidate expected Plan bytes.',
    ),
  ];
}

export const GOLDEN_DRAFT_CASE_SEEDS: readonly GoldenDraftCaseSeed[] = [
  ...positiveCases,
  ...negativeCases,
];

function schema(id: string, body: JsonObject): JsonObject {
  return {
    resource_type: 'schema',
    ref: ref(id),
    content: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://icarus.local/${id}/1`,
      ...body,
    },
  };
}

function capability(
  id: string,
  inputSchema: string | null,
  outputSchema: string | null,
  overrides: JsonObject = {},
): JsonObject {
  const content: JsonObject = {
    ref: ref(id),
    node_type: 'system',
    executor_ref: ref('fixture.executor'),
    skill_refs: [],
    input_ports: inputSchema
      ? {
          value: {
            schema_ref: ref(inputSchema),
            max_bytes: 4096,
            aggregation: { type: 'single', required: true, select: 'only' },
          },
        }
      : {},
    output_ports: outputSchema
      ? {
          value: {
            schema_ref: ref(outputSchema),
            max_bytes: 4096,
            required: true,
          },
        }
      : {
          result: {
            schema_ref: ref('fixture.schema.route-result'),
            max_bytes: 4096,
            required: true,
          },
        },
    no_artifact_expected: true,
    no_evaluation_expected: true,
    quality_revision_policy: null,
    required_tools: [],
    required_mcp_methods: [],
    required_file_scopes: [],
    required_claims: [],
    allowed_groups: [],
    retry_policy: { max_attempts: 1, retry_on: [], backoff: 'fixed' },
    timeout_ceiling_ms: 60000,
    effect_impact: 'read_only',
    effect: { type: 'pure' },
    cancellation: { type: 'fence_only', safe_to_abandon: true },
    dependency_closure_hash: HASH,
    ...overrides,
  };
  if (content.evaluator_ref !== undefined)
    delete content.no_evaluation_expected;
  for (const optionalKey of [
    'artifact_contract_ref',
    'evaluator_ref',
    'quality_gate_ref',
    'execution_group_ref',
  ]) {
    if (content[optionalKey] === null) delete content[optionalKey];
  }
  return {
    resource_type: 'capability',
    ref: ref(id),
    content,
  };
}

function withResourceHash(resource: JsonObject): JsonObject {
  return {
    ...resource,
    content_hash: domainSeparatedSha256(
      'icarus:workflow-golden-draft-registry-resource:1\n',
      resource.content as JsonValue,
    ),
  };
}

export function buildGoldenDraftRegistryResources(
  graphScopeSchema: JsonObject,
): JsonObject[] {
  const resources: JsonObject[] = [
    schema('fixture.schema.string-narrow', {
      type: 'string',
      enum: ['accepted'],
    }),
    schema('fixture.schema.string-wide', {
      type: 'string',
      enum: ['accepted', 'rejected'],
    }),
    schema('fixture.schema.number', {
      type: 'number',
      minimum: 0,
      maximum: 100,
    }),
    schema('fixture.schema.route-result', {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    }),
    schema('fixture.schema.feedback', {
      type: 'object',
      additionalProperties: false,
      required: ['instruction'],
      properties: { instruction: { type: 'string', minLength: 1 } },
    }),
    schema('fixture.schema.string-array', {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4,
    }),
    {
      resource_type: 'schema',
      ref: ref('fixture.schema.graph-scope'),
      content: graphScopeSchema,
    },
    capability('fixture.capability.static', null, null),
    capability('fixture.capability.route', null, null),
    capability(
      'fixture.capability.producer-string',
      null,
      'fixture.schema.string-narrow',
    ),
    capability(
      'fixture.capability.consumer-string',
      'fixture.schema.string-wide',
      null,
    ),
    capability(
      'fixture.capability.consumer-number',
      'fixture.schema.number',
      null,
    ),
    capability('fixture.capability.forbidden', null, null),
    capability('fixture.capability.unsafe-cancel', null, null, {
      effect_impact: 'mutable_effects',
      effect: { type: 'idempotent', key: { scope: 'attempt' } },
      cancellation: { type: 'requires_compensation' },
    }),
    capability('fixture.capability.quality', null, null, {
      evaluator_ref: ref('fixture.evaluator'),
      no_evaluation_expected: null,
      quality_gate_ref: ref('fixture.quality-gate'),
      quality_revision_policy: {
        feedback_schema_ref: ref('fixture.schema.feedback'),
        max_feedback_bytes: 4096,
        context_mode: 'base_input_plus_latest_revision',
      },
      retry_policy: { max_attempts: 3, retry_on: [], backoff: 'fixed' },
    }),
    capability('fixture.capability.missing-feedback-schema', null, null, {
      evaluator_ref: ref('fixture.evaluator'),
      no_evaluation_expected: null,
      quality_gate_ref: ref('fixture.quality-gate'),
      quality_revision_policy: {
        feedback_schema_ref: null,
        max_feedback_bytes: 4096,
        context_mode: 'base_input_plus_latest_revision',
      },
    }),
    capability('fixture.capability.missing-quality-gate', null, null, {
      evaluator_ref: ref('fixture.evaluator'),
      no_evaluation_expected: null,
      quality_gate_ref: null,
      quality_revision_policy: {
        feedback_schema_ref: ref('fixture.schema.feedback'),
        max_feedback_bytes: 4096,
        context_mode: 'base_input_plus_latest_revision',
      },
    }),
    capability('fixture.capability.incompatible-effect-key', null, null, {
      evaluator_ref: ref('fixture.evaluator'),
      no_evaluation_expected: null,
      quality_gate_ref: ref('fixture.quality-gate'),
      quality_revision_policy: {
        feedback_schema_ref: ref('fixture.schema.feedback'),
        max_feedback_bytes: 4096,
        context_mode: 'base_input_plus_latest_revision',
      },
      effect_impact: 'mutable_effects',
      effect: { type: 'idempotent', key: { scope: 'node' } },
    }),
    {
      resource_type: 'wait_contract',
      ref: ref('fixture.wait.approval'),
      content: {
        ref: ref('fixture.wait.approval'),
        kind: 'approval',
        input_ports: {
          correlation_key: {
            schema_ref: ref('fixture.schema.string-wide'),
            max_bytes: 512,
            aggregation: { type: 'single', required: true, select: 'only' },
          },
        },
        output_ports: {
          resolution: {
            schema_ref: ref('fixture.schema.route-result'),
            max_bytes: 4096,
            required: true,
          },
        },
        authorization_policy_ref: ref('fixture.authorization'),
        allow_indefinite: false,
        prearm_ttl_ms: 60000,
        contract_hash: HASH,
      },
    },
    {
      resource_type: 'template',
      ref: ref('fixture.template.child'),
      content: childScope('template_child'),
    },
    {
      resource_type: 'recipe',
      ref: ref('fixture.recipe.parent'),
      content: {
        ref: ref('fixture.recipe.parent'),
        definition_ref: ref('fixture.definition.main'),
        allowed_child_recipe_refs: [],
      },
    },
    {
      resource_type: 'recipe',
      ref: ref('fixture.recipe.cycle-a'),
      content: {
        ref: ref('fixture.recipe.cycle-a'),
        allowed_child_recipe_refs: [ref('fixture.recipe.cycle-b')],
      },
    },
    {
      resource_type: 'recipe',
      ref: ref('fixture.recipe.cycle-b'),
      content: {
        ref: ref('fixture.recipe.cycle-b'),
        allowed_child_recipe_refs: [ref('fixture.recipe.cycle-a')],
      },
    },
  ];
  return resources.map(withResourceHash);
}

export function buildGoldenDraftInterfaces(): JsonObject[] {
  return [
    {
      ref: ref('fixture.interface.root'),
      inputs: {},
      exits: { done: { output_ports: {} } },
      interface_hash: domainSeparatedSha256(
        'icarus:workflow-golden-draft-interface:1\n',
        { id: 'fixture.interface.root', inputs: {}, exits: ['done'] },
      ),
    },
    {
      ref: ref('fixture.interface.child'),
      inputs: {
        item: {
          schema_ref: ref('fixture.schema.string-wide'),
          max_bytes: 4096,
          required: false,
        },
      },
      exits: { done: { output_ports: {} } },
      interface_hash: domainSeparatedSha256(
        'icarus:workflow-golden-draft-interface:1\n',
        { id: 'fixture.interface.child', inputs: ['item'], exits: ['done'] },
      ),
    },
  ];
}

export function buildGoldenDraftPolicySnapshot(): JsonObject {
  return {
    root_policy_ref: ref('fixture.policy.root'),
    root_policy: graphPolicy,
    child_profiles: [
      {
        ref: ref('fixture.policy.child-tight'),
        request: {
          allowed_node_types: ['system', 'terminal'],
          allowed_capabilities: [ref('fixture.capability.static')],
          allowed_templates: [],
          allowed_interface_refs: [ref('fixture.interface.child')],
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
          limits: {
            ...requestedLimits,
            max_nodes: 16,
            max_edges_per_scope: 32,
          },
          usage_budget: usageBudget,
        },
      },
      {
        ref: ref('fixture.policy.child-escalating'),
        request: {
          allowed_node_types: ['delegation', 'system', 'terminal'],
          allowed_capabilities: [ref('fixture.capability.forbidden')],
          allow_early_close: true,
          effect_policy: {
            allowed_recovery_kinds: ['pure', 'idempotent'],
            max_impact: 'irreversible',
          },
          limits: requestedLimits,
          usage_budget: usageBudget,
        },
      },
    ],
    intersection_order: [
      'global',
      'workflow',
      'state',
      'parent',
      'child_request',
      'runtime_safety',
    ],
    policy_hash: domainSeparatedSha256(
      'icarus:workflow-golden-draft-policy-snapshot:1\n',
      graphPolicy,
    ),
  };
}
