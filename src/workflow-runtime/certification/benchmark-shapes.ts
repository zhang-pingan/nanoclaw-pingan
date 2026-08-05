import type { JsonObject } from '../contracts/types.js';
import { canonicalJson } from '../contracts/hash.js';
import type { G6CompiledFixture } from '../runtime/g6-test-support.js';
import { compileWorkflow } from '../compiler/compiler.js';
import { readGoldenCorpus } from '../compiler/golden.js';
import type { WorkflowCompilerIdentity } from '../compiler/types.js';

export type G8T3Shape =
  | 'long_chain'
  | 'wide_fan_out_fan_in'
  | 'diamond'
  | 'route_group'
  | 'completion_heavy'
  | 'condition_heavy';

const requestedLimits = {
  max_concurrency: null,
  max_condition_steps: null,
  max_edges_per_scope: null,
  max_fixed_point_facts: null,
  max_frontier_bytes: null,
  max_map_items: null,
  max_nesting_depth: null,
  max_nodes: null,
  max_nodes_per_scope: null,
  max_pending_signals: null,
  max_scope_spec_bytes: null,
  max_scopes: null,
  max_total_attempts: null,
  max_total_output_bytes: null,
  max_total_waits: null,
  max_wait_duration_ms: null,
};

function systemNode(id: string, edgeIds: readonly string[]): JsonObject {
  return {
    id,
    type: 'system',
    capability_ref: {
      id: 'fixture.capability.route',
      version: '1.0.0',
    },
    trigger:
      edgeIds.length === 0
        ? { type: 'root' }
        : { type: 'all', edge_ids: [...edgeIds] },
  };
}

function terminalNode(id: string, edgeIds: readonly string[]): JsonObject {
  return {
    id,
    type: 'terminal',
    exit: 'done',
    trigger: { type: 'all', edge_ids: [...edgeIds] },
  };
}

function controlEdge(
  id: string,
  from: string,
  to: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    id,
    kind: 'control',
    from_node_id: from,
    to_node_id: to,
    on: { statuses: ['succeeded'] },
    ...extra,
  };
}

function nestedCondition(depth: number): JsonObject {
  let expression: JsonObject = { op: 'exists', value: { literal: true } };
  for (let index = 0; index < depth; index += 1) {
    expression = { op: 'not', arg: expression };
  }
  return expression;
}

export function createG8T3Source(
  shape: G8T3Shape,
  requestedNodeCount: number,
): JsonObject {
  const nodeCount = Math.max(4, Math.min(128, requestedNodeCount));
  const nodes: JsonObject[] = [];
  const edges: JsonObject[] = [];
  const incoming = new Map<string, string[]>();
  const addEdge = (edge: JsonObject): void => {
    edges.push(edge);
    const target = String(edge.to_node_id);
    incoming.set(target, [...(incoming.get(target) ?? []), String(edge.id)]);
  };
  const sourceId = 'node-0000';
  const terminalId = `node-${String(nodeCount - 1).padStart(4, '0')}`;

  if (shape === 'long_chain') {
    for (let index = 0; index < nodeCount - 1; index += 1) {
      addEdge(
        controlEdge(
          `edge-${String(index).padStart(4, '0')}`,
          `node-${String(index).padStart(4, '0')}`,
          `node-${String(index + 1).padStart(4, '0')}`,
        ),
      );
    }
  } else if (shape === 'wide_fan_out_fan_in' || shape === 'completion_heavy') {
    for (let index = 1; index < nodeCount - 1; index += 1) {
      const middle = `node-${String(index).padStart(4, '0')}`;
      addEdge(controlEdge(`edge-out-${index}`, sourceId, middle));
      if (shape === 'wide_fan_out_fan_in')
        addEdge(controlEdge(`edge-in-${index}`, middle, terminalId));
    }
    if (shape === 'completion_heavy')
      addEdge(controlEdge('edge-final', sourceId, terminalId));
  } else if (shape === 'diamond') {
    let cursor = sourceId;
    let edgeIndex = 0;
    for (let index = 1; index + 2 < nodeCount; index += 3) {
      const left = `node-${String(index).padStart(4, '0')}`;
      const right = `node-${String(index + 1).padStart(4, '0')}`;
      const join = `node-${String(index + 2).padStart(4, '0')}`;
      addEdge(controlEdge(`edge-${edgeIndex++}`, cursor, left));
      addEdge(controlEdge(`edge-${edgeIndex++}`, cursor, right));
      addEdge(controlEdge(`edge-${edgeIndex++}`, left, join));
      addEdge(controlEdge(`edge-${edgeIndex++}`, right, join));
      cursor = join;
    }
    if (cursor !== terminalId)
      addEdge(controlEdge(`edge-${edgeIndex}`, cursor, terminalId));
  } else {
    for (let index = 1; index < nodeCount - 1; index += 1) {
      const target = `node-${String(index).padStart(4, '0')}`;
      addEdge(
        controlEdge(`edge-${index}`, sourceId, target, {
          ...(shape === 'route_group'
            ? {
                route_group_id: 'route-main',
                priority: nodeCount - index,
              }
            : { when: nestedCondition(4) }),
        }),
      );
    }
    addEdge(controlEdge('edge-final', sourceId, terminalId));
  }

  for (let index = 0; index < nodeCount; index += 1) {
    const id = `node-${String(index).padStart(4, '0')}`;
    if (index === nodeCount - 1 || (shape === 'completion_heavy' && index > 0))
      nodes.push(terminalNode(id, incoming.get(id) ?? []));
    else nodes.push(systemNode(id, incoming.get(id) ?? []));
  }

  return {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: `g8_${shape}_${nodeCount}`,
    interface_ref: {
      id: 'fixture.interface.root',
      version: '1.0.0',
    },
    metadata: { certification_shape: shape },
    nodes,
    control_edges: edges,
    data_edges: [],
    route_groups:
      shape === 'route_group'
        ? [
            {
              id: 'route-main',
              from_node_id: sourceId,
              mode: 'first_matching',
              no_match: 'error',
            },
          ]
        : [],
    completion: {
      early_close: 'cancel_and_fence_remaining',
      no_match: 'error',
      settled_rules: [
        {
          id: 'select_result',
          phase: 'settled',
          priority: 100,
          select: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
          when: { fact: 'all_nodes_terminal' },
        },
      ],
    },
    requested_limits: requestedLimits,
  };
}

export function compileG8T3Fixture(
  shape: G8T3Shape,
  nodeCount: number,
): G6CompiledFixture {
  const snapshot = readGoldenCorpus().cases.cases.find(
    (entry) => entry.case_id === 'positive.condition-route',
  )?.registry_snapshot;
  if (!snapshot) throw new Error('Golden condition-route snapshot is missing');
  const source = createG8T3Source(shape, nodeCount);
  const outcome = compileWorkflow({
    caseId: `g8-benchmark-${shape}-${nodeCount}`,
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    inputSnapshot: snapshot,
    identity: snapshot.compiler_identity as unknown as WorkflowCompilerIdentity,
  });
  if (!outcome.ok) {
    throw new Error(
      `G8 ${shape} source did not compile: ${canonicalJson(outcome.value.diagnostics)}`,
    );
  }
  return {
    source,
    snapshot,
    plan: outcome.value.plan,
    staticChildPlanBundle: outcome.value.staticChildPlanBundle,
    childSource: source,
    childPlan: outcome.value.plan,
  };
}

export function g8T3ShapeDimensions(fixture: G6CompiledFixture): JsonObject {
  return {
    max_nodes_total: (fixture.plan.nodes as JsonObject[]).length,
    max_edges_total:
      (fixture.plan.control_edges as JsonObject[]).length +
      (fixture.plan.data_edges as JsonObject[]).length,
    max_facts_per_transaction: Number(
      (fixture.plan.complexity_summary as JsonObject)
        .max_reconcile_facts_per_ingress,
    ),
    max_frontier_bytes: Number(
      (fixture.plan.complexity_summary as JsonObject).max_frontier_bytes,
    ),
  };
}
