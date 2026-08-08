import { domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';

export const TASK_WORKSPACE_CORE_VERSION = '1.2.0';

export const TASK_WORKSPACE_TEMPORARY_REFS = {
  interface: {
    id: 'icarus.core.task-workspace.interface.child',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  capability: {
    id: 'icarus.core.capability.codex-task',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  adapter: {
    id: 'icarus.adapter.codex-task',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  executor: {
    id: 'icarus.core.executor.codex-task',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  outboxPolicy: {
    id: 'icarus.core.outbox-policy.codex-task',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  requestSchema: {
    id: 'icarus.workflow-agent-dispatch-request',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
  resultSchema: {
    id: 'icarus.workflow-agent-result',
    version: TASK_WORKSPACE_CORE_VERSION,
  },
} as const satisfies Record<string, VersionedRef>;

export const WORKFLOW_AGENT_DISPATCH_REQUEST_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-agent-dispatch-request/1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'task', 'result_schema'],
  properties: {
    format: { const: 'icarus.workflow-agent-dispatch-request/1' },
    task: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'prompt'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 240 },
        prompt: { type: 'string', minLength: 1 },
        system: { type: 'string', minLength: 1 },
        workspace_ref: { type: 'string', minLength: 1, maxLength: 255 },
        files: {
          type: 'array',
          maxItems: 128,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'agent_path'],
            properties: {
              name: { type: 'string', minLength: 1 },
              agent_path: {
                type: 'string',
                minLength: 1,
                pattern:
                  '^/workspace/(?:run-once|uploads|attachments|agent|desktop-captures|ai-images)/',
              },
              relative_path: { type: 'string', minLength: 1 },
              size: { type: 'integer', minimum: 0 },
              sha256: { type: 'string', minLength: 1 },
              content_type: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
    result_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'content_hash'],
      properties: {
        id: { const: TASK_WORKSPACE_TEMPORARY_REFS.resultSchema.id },
        version: {
          const: TASK_WORKSPACE_TEMPORARY_REFS.resultSchema.version,
        },
        content_hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      },
    },
    metadata: { type: 'object', additionalProperties: true },
  },
};

export const WORKFLOW_AGENT_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-agent-result/1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'outcome', 'summary', 'provider', 'artifacts', 'error'],
  properties: {
    format: { const: 'icarus.workflow-agent-result/1' },
    outcome: {
      type: 'string',
      enum: ['success', 'failure', 'cancelled', 'blocked'],
    },
    summary: { type: 'string' },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['adapter', 'execution_id', 'metadata'],
      properties: {
        adapter: { type: 'string', minLength: 1 },
        execution_id: { type: 'string', minLength: 1 },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path'],
        properties: {
          name: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
          sha256: { type: 'string', minLength: 1 },
          size: { type: 'integer', minimum: 0 },
          content_type: { type: 'string', minLength: 1 },
          relative_path: { type: 'string', minLength: 1 },
          download_url: { type: 'string', minLength: 1 },
        },
      },
    },
    error: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'message', 'retryable'],
          properties: {
            code: { type: 'string', minLength: 1 },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
          },
        },
      ],
    },
  },
};

function registryResourceContentHash(
  resourceType: string,
  ref: VersionedRef,
  content: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-registry-resource-content:1\n',
    {
      format: 'icarus.workflow-registry-resource/1',
      resource_type: resourceType,
      ref,
      content,
    },
  );
}

export const WORKFLOW_AGENT_RESULT_SCHEMA_HASH = registryResourceContentHash(
  'schema',
  TASK_WORKSPACE_TEMPORARY_REFS.resultSchema,
  WORKFLOW_AGENT_RESULT_SCHEMA,
);

const NULLABLE_LIMIT: JsonObject = {
  anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
};

const LIMIT_KEYS = [
  'max_scopes',
  'max_nodes',
  'max_nodes_per_scope',
  'max_edges_per_scope',
  'max_nesting_depth',
  'max_map_items',
  'max_concurrency',
  'max_total_attempts',
  'max_total_waits',
  'max_total_output_bytes',
  'max_scope_spec_bytes',
  'max_condition_steps',
  'max_wait_duration_ms',
  'max_pending_signals',
  'max_fixed_point_facts',
  'max_frontier_bytes',
] as const;

const REQUEST_SCHEMA_FOR_RESPONSE = JSON.parse(
  JSON.stringify(WORKFLOW_AGENT_DISPATCH_REQUEST_SCHEMA),
) as JsonObject;
delete REQUEST_SCHEMA_FOR_RESPONSE.$schema;
delete REQUEST_SCHEMA_FOR_RESPONSE.$id;
const resultSchemaProperty = (
  (REQUEST_SCHEMA_FOR_RESPONSE.properties as JsonObject)
    .result_schema as JsonObject
).properties as JsonObject;
resultSchemaProperty.content_hash = {
  const: WORKFLOW_AGENT_RESULT_SCHEMA_HASH,
};

export const TEMPORARY_WORKFLOW_COORDINATOR_RESPONSE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/temporary-workflow-coordinator-response/1',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'graph_scope', 'risk_summary'],
  properties: {
    format: { const: 'icarus.temporary-workflow-plan/1' },
    graph_scope: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: { source: { $ref: '#/$defs/graph_source' } },
    },
    risk_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['effect_ceiling', 'human_input_points', 'notes'],
      properties: {
        effect_ceiling: { const: 'read_only' },
        human_input_points: {
          type: 'array',
          items: { type: 'string' },
        },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  $defs: {
    trigger: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'root' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'edge_ids'],
          properties: {
            type: { const: 'all' },
            edge_ids: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
      ],
    },
    graph_source: {
      type: 'object',
      additionalProperties: false,
      required: [
        'format',
        'scope_key',
        'interface_ref',
        'nodes',
        'control_edges',
        'data_edges',
        'completion',
        'requested_limits',
      ],
      properties: {
        format: { const: 'icarus.workflow-graph-scope/1' },
        scope_key: { type: 'string', minLength: 1, maxLength: 255 },
        label: { type: 'string', minLength: 1 },
        interface_ref: {
          const: TASK_WORKSPACE_TEMPORARY_REFS.interface,
        },
        nodes: {
          type: 'array',
          minItems: 2,
          maxItems: 16,
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type', 'trigger', 'capability_ref'],
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 255 },
                  type: { const: 'delegation' },
                  trigger: { $ref: '#/$defs/trigger' },
                  capability_ref: {
                    const: TASK_WORKSPACE_TEMPORARY_REFS.capability,
                  },
                  timeout_ms: { type: 'integer', minimum: 1 },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type', 'trigger', 'exit'],
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 255 },
                  type: { const: 'terminal' },
                  trigger: { $ref: '#/$defs/trigger' },
                  exit: { const: 'done' },
                },
              },
            ],
          },
        },
        control_edges: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'from_node_id', 'to_node_id', 'on'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 255 },
              kind: { const: 'control' },
              from_node_id: { type: 'string', minLength: 1 },
              to_node_id: { type: 'string', minLength: 1 },
              on: {
                type: 'object',
                additionalProperties: false,
                required: ['statuses'],
                properties: {
                  statuses: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'string',
                      enum: ['succeeded', 'failed', 'cancelled'],
                    },
                  },
                },
              },
            },
          },
        },
        data_edges: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'from', 'to'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 255 },
              kind: { const: 'data' },
              from: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'value'],
                properties: {
                  type: { const: 'literal' },
                  value: REQUEST_SCHEMA_FOR_RESPONSE,
                },
              },
              to: {
                type: 'object',
                additionalProperties: false,
                required: ['node_id', 'port'],
                properties: {
                  node_id: { type: 'string', minLength: 1 },
                  port: { const: 'request' },
                },
              },
            },
          },
        },
        completion: {
          type: 'object',
          additionalProperties: false,
          required: ['settled_rules', 'no_match', 'early_close'],
          properties: {
            settled_rules: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'phase', 'priority', 'when', 'select'],
                properties: {
                  id: { type: 'string', minLength: 1 },
                  phase: { const: 'settled' },
                  priority: { type: 'integer' },
                  when: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['fact'],
                    properties: { fact: { const: 'all_nodes_terminal' } },
                  },
                  select: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['exits', 'pick'],
                    properties: {
                      exits: {
                        type: 'array',
                        minItems: 1,
                        items: { const: 'done' },
                      },
                      pick: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['type'],
                        properties: {
                          type: { const: 'lowest_terminal_node_id' },
                        },
                      },
                    },
                  },
                },
              },
            },
            no_match: { const: 'error' },
            early_close: { const: 'cancel_and_fence_remaining' },
          },
        },
        requested_limits: {
          type: 'object',
          additionalProperties: false,
          required: [...LIMIT_KEYS],
          properties: Object.fromEntries(
            LIMIT_KEYS.map((key) => [key, NULLABLE_LIMIT]),
          ) as JsonObject,
        },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
  },
};

const NULL_LIMITS = Object.fromEntries(
  LIMIT_KEYS.map((key) => [key, null]),
) as JsonObject;

export const TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE: JsonObject = {
  format: 'icarus.temporary-workflow-plan/1',
  graph_scope: {
    source: {
      format: 'icarus.workflow-graph-scope/1',
      scope_key: 'temporary_codex_task',
      interface_ref: TASK_WORKSPACE_TEMPORARY_REFS.interface,
      nodes: [
        {
          id: 'codex_task',
          type: 'delegation',
          trigger: { type: 'root' },
          capability_ref: TASK_WORKSPACE_TEMPORARY_REFS.capability,
        },
        {
          id: 'done',
          type: 'terminal',
          trigger: { type: 'all', edge_ids: ['codex_finished'] },
          exit: 'done',
        },
      ],
      control_edges: [
        {
          id: 'codex_finished',
          kind: 'control',
          from_node_id: 'codex_task',
          to_node_id: 'done',
          on: { statuses: ['succeeded', 'failed', 'cancelled'] },
        },
      ],
      data_edges: [
        {
          id: 'codex_request',
          kind: 'data',
          from: {
            type: 'literal',
            value: {
              format: 'icarus.workflow-agent-dispatch-request/1',
              task: {
                title: 'Complete the requested task',
                prompt: 'Complete the requested task and report the result.',
                files: [],
              },
              result_schema: {
                ...TASK_WORKSPACE_TEMPORARY_REFS.resultSchema,
                content_hash: WORKFLOW_AGENT_RESULT_SCHEMA_HASH,
              },
              metadata: { source: 'task_workspace_temporary_workflow' },
            },
          },
          to: { node_id: 'codex_task', port: 'request' },
        },
      ],
      completion: {
        settled_rules: [
          {
            id: 'select_done',
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
      requested_limits: NULL_LIMITS,
    },
  },
  risk_summary: {
    effect_ceiling: 'read_only',
    human_input_points: [],
    notes: ['Runs one Codex task through the published Core capability.'],
  },
};

export function temporaryWorkflowCoordinatorContract(): JsonObject {
  return {
    format: 'icarus.temporary-workflow-coordinator-contract/1',
    response_schema: TEMPORARY_WORKFLOW_COORDINATOR_RESPONSE_SCHEMA,
    capability_constraints: {
      allowed_node_types: ['delegation', 'terminal'],
      allowed_capabilities: [TASK_WORKSPACE_TEMPORARY_REFS.capability],
      required_interface_ref: TASK_WORKSPACE_TEMPORARY_REFS.interface,
      codex_request_input_port: 'request',
      codex_result_schema: {
        ...TASK_WORKSPACE_TEMPORARY_REFS.resultSchema,
        content_hash: WORKFLOW_AGENT_RESULT_SCHEMA_HASH,
      },
      effect_ceiling: 'read_only',
      max_nodes: 16,
    },
    example_response: TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE,
  };
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
