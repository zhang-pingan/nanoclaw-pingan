import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowExecutionAdapterRegistry } from '../../workflow-execution/adapter-registry.js';
import { WorkflowAdapterExecutionStore } from '../../workflow-execution/execution-store.js';
import type { WorkflowExecutionAdapter } from '../../workflow-execution/types.js';
import { WorkflowExecutionWorker } from '../../workflow-execution/worker.js';
import { ensureTaskWorkspaceCore } from '../bootstrap/task-workspace-core.js';
import {
  cloneJson,
  TASK_WORKSPACE_CORE_VERSION,
  TASK_WORKSPACE_TEMPORARY_REFS,
  TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE,
} from '../bootstrap/task-workspace-temporary-contract.js';
import { buildDeploymentCapacityPublication } from '../contracts/capacity-control-plane-source.js';
import type { DeploymentRuntimeCapacitySnapshot } from '../contracts/capacity-control-plane-types.js';
import { buildDeploymentRuntimeCapacityBaseline } from '../contracts/safety-sqlite-artifacts.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { compileWorkflow } from '../compiler/compiler.js';
import { readGoldenCorpus } from '../compiler/golden.js';
import { scheduleReadyNodeT4 } from '../runtime/basic-scheduler.js';
import {
  createG6MapFixture,
  type G6MapFixture,
} from '../runtime/g6-test-support.js';
import { insertInlineValue } from '../runtime/graph-store.js';
import { initializeScopeFixedPointT3a } from '../runtime/reconciler.js';
import { prepareCapabilityDispatchT5 } from '../runtime/outbox.js';
import {
  WorkflowRuntimeService,
  WorkflowRuntimeTransactionAuthority,
} from '../service.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import {
  calculateWorkspaceInteractionPayloadHash,
  RuntimeWorkspaceGateway,
} from './workspace.js';

const roots: string[] = [];
const stores: WorkflowRuntimeStore[] = [];
const runtimeFixtures: G6MapFixture[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-workspace-gateway-'),
  );
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
  });
  stores.push(store);
  return store;
}

function hash(kind: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(
    `icarus:workspace-gateway-test:${kind}:1\n`,
    value,
  );
}

function terminalChildSource(nodeId = 'child_done'): JsonObject {
  return {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: `dynamic_child_${nodeId}`,
    interface_ref: TASK_WORKSPACE_TEMPORARY_REFS.interface,
    nodes: [
      {
        id: nodeId,
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
    requested_limits: {
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
    },
  };
}

function advanceWorkflowToCompletion(
  store: WorkflowRuntimeStore,
  workflowId: string,
  startAtMs: number,
): void {
  const authority = new WorkflowRuntimeTransactionAuthority(store);
  let nowMs = startAtMs;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let processed = 0;
    for (const phase of [
      'compile',
      'materialize',
      'reconcile',
      'schedule',
      'recover',
      'close',
    ] as const) {
      processed += authority.advance(phase, 32, nowMs).processed;
      nowMs += 1;
    }
    const workflow = store.queryOne<{ status: string }>(
      'SELECT status FROM workflows WHERE id = ?',
      [workflowId],
    );
    if (workflow?.status !== 'active') return;
    if (processed === 0) break;
  }
  const diagnostic = store.queryOne<Record<string, unknown>>(
    'SELECT id, status, current_graph_run_id, row_version FROM workflows WHERE id = ?',
    [workflowId],
  );
  throw new Error(`Runtime stalled: ${JSON.stringify(diagnostic)}`);
}

function launchedTemporary(key: string): {
  store: WorkflowRuntimeStore;
  gateway: RuntimeWorkspaceGateway;
  workflowId: string;
  runId: string;
} {
  const store = openFresh();
  ensureTaskWorkspaceCore(store, 1_000);
  const gateway = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 7));
  const recipe = gateway
    .listRecipes({
      principal_ref: 'human:local-owner',
      now_ms: 2_000,
    })
    .items.find((item) => item.recipe_ref.id === 'ad_hoc_personal_task')!;
  const source = terminalChildSource();
  const compilation = gateway.prepareTemporaryDraft({
    principal_ref: 'human:local-owner',
    selection_token: recipe.selection_token,
    source_json: source,
    now_ms: 2_001,
  });
  const effectiveInput: JsonObject = { text: key };
  const attachments: JsonValue = [];
  const receipt = gateway.launchTemporary({
    principal_ref: 'human:local-owner',
    selection_token: recipe.selection_token,
    authorization_ref: `temporary-confirmation:${key}`,
    launch: {
      request_id: `launch:${key}`,
      creation_domain: 'task-workspace-test',
      creation_key: key,
      effective_input_json: effectiveInput,
      effective_input_hash: hash('input', effectiveInput),
      attachment_manifest_json: attachments,
      attachment_manifest_hash: hash('attachments', attachments),
      deadline_at_ms: null,
    },
    now_ms: 2_002,
    confirmed_revision_id: `revision:${key}`,
    confirmed_source_json: source,
    confirmed_source_hash: compilation.source_hash,
    confirmed_plan_hash: compilation.compiled_plan_hash,
    resource_closure_hash: compilation.resource_closure_hash,
    policy_ceiling_hash: compilation.policy_ceiling_hash,
  });
  return {
    store,
    gateway,
    workflowId: receipt.workflowId,
    runId: receipt.activation.graphRunId,
  };
}

function advanceUntilTemporaryExpansion(
  store: WorkflowRuntimeStore,
  runId: string,
  startAtMs: number,
): void {
  const authority = new WorkflowRuntimeTransactionAuthority(store);
  let nowMs = startAtMs;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    for (const phase of [
      'compile',
      'materialize',
      'reconcile',
      'schedule',
      'recover',
    ] as const) {
      authority.advance(phase, 32, nowMs);
      nowMs += 1;
    }
    const expansion = store.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM workflow_graph_scope_builds
        WHERE graph_run_id = ? AND scope_kind = 'expansion'
          AND status = 'materialized'`,
      [runId],
    );
    if (expansion) return;
  }
  throw new Error('Temporary Dynamic Child did not materialize');
}

function runtimeWriteCounts(
  store: WorkflowRuntimeStore,
): Record<string, number> {
  return Object.fromEntries(
    [
      'workflow_values',
      'workflow_runtime_commands',
      'workflow_runtime_command_invocations',
      'workflow_graph_events',
      'workflow_state_transition_history',
    ].map((table) => [
      table,
      store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM ${table}`,
        [],
      )?.count ?? -1,
    ]),
  );
}

function seedUnsafeEffect(
  store: WorkflowRuntimeStore,
  runId: string,
  key: string,
  nowMs: number,
): void {
  const authority = store.queryOne<{
    workflow_id: string;
    scope_id: string;
    scope_work_fence_epoch: number;
    node_id: string;
    run_work_fence_epoch: number;
    input_value_id: string;
    input_hash: Sha256Hash;
  }>(
    `SELECT run.workflow_id, node.scope_id,
            scope.work_fence_epoch AS scope_work_fence_epoch,
            node.id AS node_id, run.work_fence_epoch AS run_work_fence_epoch,
            run_input.id AS input_value_id, run_input.content_hash AS input_hash
       FROM workflow_graph_runs run
       JOIN workflows workflow ON workflow.id = run.workflow_id
       JOIN workflow_values run_input
         ON run_input.id = workflow.workflow_input_value_id
        AND run_input.content_hash = workflow.workflow_input_hash
       JOIN workflow_graph_nodes node ON node.graph_run_id = run.id
       JOIN workflow_graph_scopes scope
         ON scope.graph_run_id = run.id AND scope.id = node.scope_id
      WHERE run.id = ?
      ORDER BY node.id COLLATE BINARY LIMIT 1`,
    [runId],
  )!;
  const attemptId = `attempt:workspace-replan:${key}`;
  const effectId = `effect:workspace-replan:${key}`;
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_graph_node_attempts (
         id, graph_run_id, scope_id, node_id, attempt_no, continuation_kind,
         parent_attempt_id, parent_attempt_no, phase, execution_outcome,
         quality_decision, input_snapshot_json, input_snapshot_value_id,
         input_snapshot_hash, selected_edges_json, context_pack_value_id,
         context_pack_hash, delegation_id, external_execution_id, action_name,
         query_id, dispatch_started_at_ms, dispatch_deadline_at_ms,
         execution_started_at_ms, execution_deadline_at_ms, timeout_event_id,
         artifact_refs_value_id, artifact_refs_hash, result_value_id, result_hash,
         evaluation_value_id, evaluation_hash, quality_revision_feedback_value_id,
         quality_revision_feedback_hash, retry_reason_code, error_code,
         error_detail_value_id, error_detail_hash, usage_summary_value_id,
         usage_summary_hash, acceptance_state, run_work_fence_epoch,
         scope_work_fence_epoch, resource_reservation_group_id, lease_owner,
         lease_token, lease_expires_at_ms, heartbeat_at_ms,
         evaluation_lease_owner, evaluation_lease_token,
         evaluation_lease_expires_at_ms, evaluation_attempt_count,
         evaluation_next_attempt_at_ms, evaluation_deadline_at_ms, row_version,
         created_at_ms, updated_at_ms, finished_at_ms
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'terminal', 'failed',
         NULL, '{}', NULL, NULL, '[]', ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, 'effect_unknown', 'effect_unknown', NULL, NULL, NULL, NULL,
         'fenced', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
         NULL, NULL, 1, ?, ?, ?)`,
      [
        attemptId,
        runId,
        authority.scope_id,
        authority.node_id,
        authority.input_value_id,
        authority.input_hash,
        authority.run_work_fence_epoch,
        authority.scope_work_fence_epoch,
        `reservation-group:workspace-replan:${key}`,
        nowMs,
        nowMs,
        nowMs,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_effect_operations (
         id, graph_run_id, scope_id, node_id, attempt_id, operation_key,
         key_strategy_json, key_strategy_hash, execution_lane, close_request_id,
         effect_type, status, request_value_id, request_hash, receipt_value_id,
         receipt_hash, before_state_value_id, before_state_hash,
         after_state_value_id, after_state_hash, immutable_output_snapshot_value_id,
         immutable_output_snapshot_hash, compensation_value_id, compensation_hash,
         lease_owner, lease_token, lease_expires_at_ms, row_version, created_at_ms,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', NULL, 'workspace_test',
         'action_required', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
      [
        effectId,
        runId,
        authority.scope_id,
        authority.node_id,
        attemptId,
        `operation:workspace-replan:${key}`,
        canonicalJson({ type: 'workspace_test' }),
        hash('effect-key-strategy', { key }),
        authority.input_value_id,
        authority.input_hash,
        nowMs,
        nowMs,
      ],
    );
  });
}

function fixedCapacity() {
  return buildDeploymentCapacityPublication(
    1,
    'capacity-defaults-change:1',
    null,
    buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot,
  );
}

function armedApprovalWait(key: string): {
  fixture: G6MapFixture;
  gateway: RuntimeWorkspaceGateway;
  waitId: string;
  waitRowVersion: number;
} {
  const golden = readGoldenCorpus().cases.cases.find(
    (entry) => entry.case_id === 'positive.wait',
  );
  if (!golden) throw new Error('Positive Wait compiler fixture is unavailable');
  const source = JSON.parse(
    Buffer.from(golden.raw_source_base64, 'base64').toString('utf8'),
  ) as JsonObject;
  const correlationEdge = (source.data_edges as JsonObject[])[0]!;
  correlationEdge.from = {
    type: 'literal',
    value: 'accepted',
  };
  const compiled = compileWorkflow({
    caseId: `workspace-gateway-wait-${key}`,
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    inputSnapshot: golden.registry_snapshot,
  });
  if (!compiled.ok) {
    throw new Error(
      `Wait fixture failed to compile: ${JSON.stringify(compiled.value)}`,
    );
  }
  const fixture = createG6MapFixture(`workspace-wait-${key}`, {
    compiledFixture: {
      source,
      snapshot: golden.registry_snapshot,
      plan: compiled.value.plan,
      staticChildPlanBundle: compiled.value.staticChildPlanBundle,
      childSource: source,
      childPlan: compiled.value.plan,
    },
  });
  runtimeFixtures.push(fixture);
  const waitNode = (compiled.value.plan.nodes as JsonObject[]).find(
    (node) => node.id === 'approval',
  )!;
  const waitContractHash = (
    (waitNode.wait_binding as JsonObject).contract_snapshot as JsonObject
  ).contract_hash as Sha256Hash;
  fixture.instance.store.withImmediateTransaction((transaction) => {
    const resource = transaction.queryOne<{
      id: string;
      canonical_value_id: string;
    }>(
      `SELECT id, canonical_value_id FROM workflow_registry_resources
        WHERE resource_type = 'wait_contract'
          AND resource_id = 'fixture.wait.approval'
          AND resource_version = '1.0.0'`,
      [],
    )!;
    transaction.execute(
      'UPDATE workflow_values SET content_hash = ? WHERE id = ?',
      [waitContractHash, resource.canonical_value_id],
    );
    transaction.execute(
      'UPDATE workflow_registry_resources SET content_hash = ? WHERE id = ?',
      [waitContractHash, resource.id],
    );
    transaction.execute(
      `UPDATE workflow_registry_closure_members SET content_hash = ?
        WHERE resource_id = ?`,
      [waitContractHash, resource.id],
    );
  });
  ensureTaskWorkspaceCore(fixture.instance.store, 20);
  const run = fixture.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [fixture.graphRunId],
  )!;
  initializeScopeFixedPointT3a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion: run.row_version,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs: 30,
  });
  const node = fixture.instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    `SELECT id, row_version, activation_event_seq
       FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND node_key = 'approval'`,
    [fixture.graphRunId],
  )!;
  const admission = scheduleReadyNodeT4(
    fixture.instance.store,
    { current: () => fixedCapacity() },
    {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      nodeId: node.id,
      expectedNodeRowVersion: node.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: node.activation_event_seq,
      activation: { kind: 'wait' },
      nowMs: 40,
    },
  );
  const wait = fixture.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_waits WHERE id = ?',
    [admission.waitId],
  )!;
  return {
    fixture,
    gateway: new RuntimeWorkspaceGateway(
      fixture.instance.store,
      Buffer.alloc(32, 9),
    ),
    waitId: admission.waitId!,
    waitRowVersion: wait.row_version,
  };
}

afterEach(() => {
  for (const fixture of runtimeFixtures.splice(0)) fixture.instance.cleanup();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe('RuntimeWorkspaceGateway', () => {
  it('refreshes a persisted exact Recipe selection after token expiry or Host secret rotation', () => {
    const store = openFresh();
    ensureTaskWorkspaceCore(store, 1_000);
    const original = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 7), {
      token_ttl_ms: 100,
    });
    const selected = original
      .listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 2_000,
      })
      .items.find((item) => item.recipe_ref.id === 'ad_hoc_personal_task')!;
    const source = terminalChildSource();

    expect(() =>
      original.prepareTemporaryDraft({
        principal_ref: 'human:local-owner',
        selection_token: selected.selection_token,
        source_json: source,
        now_ms: 2_101,
      }),
    ).toThrow(/stale/);

    const restarted = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 8), {
      token_ttl_ms: 100,
    });
    expect(() =>
      restarted.prepareTemporaryDraft({
        principal_ref: 'human:local-owner',
        selection_token: selected.selection_token,
        source_json: source,
        now_ms: 2_050,
      }),
    ).toThrow(/signature is invalid/);

    const refreshed = restarted.refreshRecipeSelection({
      principal_ref: 'human:local-owner',
      recipe_ref: selected.recipe_ref,
      recipe_hash: selected.recipe_hash,
      now_ms: 2_200,
    });
    expect(refreshed).toMatchObject({
      recipe_ref: selected.recipe_ref,
      recipe_hash: selected.recipe_hash,
    });
    expect(
      restarted.prepareTemporaryDraft({
        principal_ref: 'human:local-owner',
        selection_token: refreshed.selection_token,
        source_json: source,
        now_ms: 2_201,
      }).source_hash,
    ).toMatch(/^sha256:/);
    expect(() =>
      restarted.refreshRecipeSelection({
        principal_ref: 'human:local-owner',
        recipe_ref: selected.recipe_ref,
        recipe_hash: hash('stale-recipe', {}),
        now_ms: 2_202,
      }),
    ).toThrow(/no longer present in the active Catalog/);
  }, 30_000);

  it('returns task-scoped edges, attempts, and completion cuts', () => {
    const target = launchedTemporary('runtime-detail');
    advanceWorkflowToCompletion(target.store, target.workflowId, 3_000);
    seedUnsafeEffect(target.store, target.runId, 'runtime-detail', 4_000);

    const workflow = target.gateway.getRuntimeDetail({
      principal_ref: 'human:local-owner',
      workflow_ids: [target.workflowId],
    }).workflows[0]!;
    expect((workflow.edges as JsonObject[]).length).toBeGreaterThan(0);
    expect(workflow.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_run_id: target.runId,
          compiled_edge_json: expect.any(Object),
          resolution: expect.objectContaining({ state: expect.any(String) }),
        }),
      ]),
    );
    expect(workflow.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_run_id: target.runId,
          phase: 'terminal',
          selected_edges_json: [],
        }),
      ]),
    );
    expect((workflow.completion_cuts as JsonObject[]).length).toBeGreaterThan(
      0,
    );
    expect(workflow.completion_cuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          graph_run_id: target.runId,
          cut_hash: expect.stringMatching(/^sha256:/),
        }),
      ]),
    );
    expect(workflow.artifacts).toEqual([]);
  });

  it('expands Artifact links from a real Worker result Value', async () => {
    const golden = readGoldenCorpus().cases.cases.find(
      (entry) => entry.case_id === 'positive.quality-revision-binding',
    );
    const delegationGolden = readGoldenCorpus().cases.cases.find(
      (entry) => entry.case_id === 'positive.static-lowering',
    );
    if (!golden || !delegationGolden) {
      throw new Error('Delegation compiler fixture is unavailable');
    }
    const source = JSON.parse(
      Buffer.from(golden.raw_source_base64, 'base64').toString('utf8'),
    ) as JsonObject;
    const sourceNode = (source.nodes as JsonObject[]).find(
      (node) => node.id === 'quality',
    )!;
    sourceNode.type = 'delegation';
    sourceNode.capability_ref = {
      id: 'fixture.capability.static',
      version: '1.0.0',
    };
    const snapshot = structuredClone(golden.registry_snapshot);
    const registrySnapshot = snapshot.registry_snapshot as JsonObject;
    const delegationRegistry = delegationGolden.registry_snapshot
      .registry_snapshot as JsonObject;
    registrySnapshot.resources = [
      ...(registrySnapshot.resources as JsonObject[]).filter(
        (resource) => resource.resource_type !== 'capability',
      ),
      ...(delegationRegistry.resources as JsonObject[]).filter(
        (resource) => resource.resource_type === 'capability',
      ),
    ];
    registrySnapshot.dependency_closures = (
      delegationRegistry.dependency_closures as JsonObject[]
    ).filter((closure) => closure.root_resource_type === 'capability');
    const completePolicy = (snapshot.policy_snapshot as JsonObject)
      .complete_policy as JsonObject;
    const rootPolicy = completePolicy.root_policy as JsonObject;
    rootPolicy.allowed_capabilities = [sourceNode.capability_ref];
    const compiled = compileWorkflow({
      caseId: 'workspace-gateway-worker-artifact',
      sourceKind: 'graph_scope',
      rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
      inputSnapshot: snapshot,
    });
    if (!compiled.ok) {
      throw new Error(
        `Delegation Artifact fixture failed to compile: ${JSON.stringify(compiled.value)}`,
      );
    }
    const fixture = createG6MapFixture('workspace-worker-artifact', {
      compiledFixture: {
        source,
        snapshot,
        plan: compiled.value.plan,
        staticChildPlanBundle: compiled.value.staticChildPlanBundle,
        childSource: source,
        childPlan: compiled.value.plan,
      },
    });
    runtimeFixtures.push(fixture);
    const initialRun = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
      [fixture.graphRunId],
    )!;
    initializeScopeFixedPointT3a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: initialRun.row_version,
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 3_000,
    });
    const node = fixture.instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      `SELECT id, row_version, activation_event_seq
         FROM workflow_graph_nodes
        WHERE graph_run_id = ? AND node_type = 'delegation'`,
      [fixture.graphRunId],
    )!;
    const admission = scheduleReadyNodeT4(
      fixture.instance.store,
      { current: () => fixedCapacity() },
      {
        graphRunId: fixture.graphRunId,
        scopeId: fixture.rootScopeId,
        nodeId: node.id,
        expectedNodeRowVersion: node.row_version,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        eligibleEventSeq: node.activation_event_seq,
        activation: { kind: 'execution' },
        nowMs: 3_001,
      },
    );
    const request: JsonObject = {
      format: 'icarus.workflow-agent-dispatch-request/1',
      task: {
        title: 'Produce report',
        prompt: 'Produce the requested report',
        files: [],
      },
      result_schema: {
        id: fixture.seed.refs.schema!.ref.id,
        version: fixture.seed.refs.schema!.ref.version,
        content_hash: fixture.seed.refs.schema!.hash,
      },
      metadata: { source: 'gateway-regression' },
    };
    const requestRef = {
      id: 'value:workspace-worker-artifact-request',
      hash: hash('worker-artifact-request', request),
    };
    fixture.instance.store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id: requestRef.id,
        content: request,
        contentHash: requestRef.hash,
        schemaResourceId: fixture.seed.refs.schema!.rowId,
        schemaResourceHash: fixture.seed.refs.schema!.hash,
        provenanceRef: 'workspace-gateway-worker-artifact-test',
        retentionClass: 'run_recovery',
        ownerGraphRunId: fixture.graphRunId,
        createdAtMs: 3_002,
      });
    });
    const dispatch = prepareCapabilityDispatchT5(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      nodeId: node.id,
      attemptId: admission.attemptId!,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: requestRef,
      policySnapshotSchema: fixture.seed.refs.schema!,
      operationKey: 'operation:workspace-worker-artifact',
      requiredClaims: [],
      dispatchDeadlineAtMs: 4_000,
      outboxDeadlineAtMs: 5_000,
      nowMs: 3_003,
    });
    const adapterRefId = fixture.instance.store.queryOne<{
      resource_id: string;
    }>(
      `SELECT resource.resource_id
         FROM workflow_outbox outbox
         JOIN workflow_registry_resources resource
           ON resource.id = outbox.adapter_resource_id
          AND resource.content_hash = outbox.adapter_resource_hash
        WHERE outbox.id = ?`,
      [dispatch.outboxId],
    )!.resource_id;
    const executionStore = new WorkflowAdapterExecutionStore(
      path.join(fixture.instance.dataRoot, 'workflow-adapter-executions.db'),
    );
    const registry = new WorkflowExecutionAdapterRegistry();
    registry.register({
      refId: adapterRefId,
      preflight: async () => undefined,
      start: async (context) => ({
        providerMetadata: { source: 'test-adapter' },
        completion: Promise.resolve({
          state: 'succeeded' as const,
          result: {
            format: 'icarus.workflow-agent-result/1' as const,
            outcome: 'success' as const,
            summary: 'Report produced',
            provider: {
              adapter: adapterRefId,
              execution_id: context.executionId,
              metadata: { source: 'test-adapter' },
            },
            artifacts: [
              {
                name: 'report.json',
                path: '/workspace/run-once/output/report.json',
                relative_path: 'output/report.json',
                download_url:
                  '/api/internal-agent/runs/run-worker/files/output/report.json',
                sha256: 'd'.repeat(64),
                size: 42,
                content_type: 'application/json',
              },
            ],
            error: null,
          },
        }),
        cancel: async () => undefined,
      }),
      recover: async () => {
        throw new Error('Recovery is not expected');
      },
    } satisfies WorkflowExecutionAdapter);
    const worker = new WorkflowExecutionWorker({
      runtimeStore: fixture.instance.store,
      executionStore,
      registry,
      pollIntervalMs: 100,
      leaseOwner: 'worker:gateway-artifact-test',
      now: () => 3_100,
    });

    try {
      await worker.tick();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const accepted = fixture.instance.store.queryOne<{
          result_value_id: string | null;
        }>(
          'SELECT result_value_id FROM workflow_graph_node_attempts WHERE id = ?',
          [admission.attemptId!],
        );
        if (accepted?.result_value_id) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(
        fixture.instance.store.queryOne<{ result_value_id: string | null }>(
          'SELECT result_value_id FROM workflow_graph_node_attempts WHERE id = ?',
          [admission.attemptId!],
        )?.result_value_id,
      ).toMatch(/^g5:workflow-adapter-result:/);

      const workflow = new RuntimeWorkspaceGateway(
        fixture.instance.store,
        Buffer.alloc(32, 9),
      ).getRuntimeDetail({
        principal_ref: 'human:local-owner',
        workflow_ids: [fixture.workflowId],
      }).workflows[0]!;
      expect(workflow.artifacts).toEqual([
        expect.objectContaining({
          graph_run_id: fixture.graphRunId,
          node_id: node.id,
          attempt_id: admission.attemptId,
          result_value_id: expect.stringMatching(
            /^g5:workflow-adapter-result:/,
          ),
          artifact_hash: `sha256:${'d'.repeat(64)}`,
          display_json: expect.objectContaining({
            title: 'report.json',
            path: '/workspace/run-once/output/report.json',
            relative_path: 'output/report.json',
            download_url:
              '/api/internal-agent/runs/run-worker/files/output/report.json',
            media_type: 'application/json',
            byte_length: 42,
          }),
        }),
      ]);
      expect((workflow.artifacts as JsonObject[])[0]).not.toHaveProperty(
        'inline_value_json',
      );
    } finally {
      await worker.stop();
      executionStore.close();
    }
  }, 30_000);

  it('publishes, activates, pins, and executes versioned Personal Workflows', () => {
    const temporary = launchedTemporary('personal-source');
    advanceWorkflowToCompletion(temporary.store, temporary.workflowId, 3_000);
    expect(
      temporary.store.queryOne<{
        status: string;
        final_outcome_kind: string | null;
      }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
        temporary.workflowId,
      ]),
    ).toEqual({ status: 'completed', final_outcome_kind: 'normal' });

    const extracted = temporary.gateway.extractPersonalWorkflowDraft({
      principal_ref: 'human:local-owner',
      workflow_id: temporary.workflowId,
      run_id: temporary.runId,
    });
    expect(extracted.source_json).toEqual(terminalChildSource());
    const authoritativeBuild = temporary.store.queryOne<{
      source_snapshot_hash: Sha256Hash;
      compiled_plan_hash: Sha256Hash;
    }>(
      `SELECT source_snapshot_hash, compiled_plan_hash
         FROM workflow_graph_scope_builds
        WHERE graph_run_id = ? AND scope_kind = 'expansion'
        ORDER BY created_at_ms, id COLLATE BINARY LIMIT 1`,
      [temporary.runId],
    )!;
    expect(extracted).toMatchObject({
      source_hash: authoritativeBuild.source_snapshot_hash,
      compiled_plan_hash: authoritativeBuild.compiled_plan_hash,
    });
    const preparedV1 = temporary.gateway.preparePersonalWorkflowDraft({
      principal_ref: 'human:local-owner',
      source_workflow_id: temporary.workflowId,
      source_run_id: temporary.runId,
      source_json: extracted.source_json,
    });
    expect(preparedV1).toMatchObject({
      source_hash: extracted.source_hash,
      compiled_plan_hash: extracted.compiled_plan_hash,
    });

    const v1 = temporary.gateway.publishPersonalWorkflowRelease({
      principal_ref: 'human:local-owner',
      personal_workflow_id: 'daily-summary',
      release_ref: { id: 'daily-summary', version: '1.0.0' },
      display_name: 'Daily summary',
      description: 'A principal-owned summary workflow',
      source_workflow_id: temporary.workflowId,
      source_run_id: temporary.runId,
      source_json: extracted.source_json,
      expected_source_hash: preparedV1.source_hash,
      expected_plan_hash: preparedV1.compiled_plan_hash,
      idempotency_key: 'personal-publish-v1',
      now_ms: 4_000,
    });
    expect(v1.active).toBe(false);
    expect(
      temporary.gateway
        .listRecipes({
          principal_ref: 'human:local-owner',
          now_ms: 4_001,
        })
        .items.filter((item) => item.recipe_kind === 'personal'),
    ).toEqual([]);

    const activeV1 = temporary.gateway.activatePersonalWorkflowRelease({
      principal_ref: 'human:local-owner',
      personal_workflow_id: 'daily-summary',
      release_id: v1.release_id,
      release_hash: v1.release_hash,
      expected_pointer_row_version: null,
      idempotency_key: 'personal-activate-v1',
      now_ms: 4_002,
    });
    expect(activeV1.pointer_row_version).toBe(1);
    const ownerCatalogV1 = temporary.gateway.listRecipes({
      principal_ref: 'human:local-owner',
      now_ms: 4_003,
    });
    const personalV1 = ownerCatalogV1.items.find(
      (item) => item.recipe_kind === 'personal',
    )!;
    expect(personalV1.recipe_ref.version).toBe('1.0.0');
    expect(
      temporary.gateway
        .listRecipes({ principal_ref: 'human:other', now_ms: 4_003 })
        .items.some((item) => item.recipe_kind === 'personal'),
    ).toBe(false);

    const launch = (selectionToken: string, key: string, nowMs: number) => {
      const input: JsonObject = { task: key };
      const attachments: JsonValue = [];
      return temporary.gateway.launchPublished({
        principal_ref: 'human:local-owner',
        selection_token: selectionToken,
        authorization_ref: `personal-authorization:${key}`,
        launch: {
          request_id: `personal-launch:${key}`,
          creation_domain: 'task-workspace-personal-test',
          creation_key: key,
          effective_input_json: input,
          effective_input_hash: hash('input', input),
          attachment_manifest_json: attachments,
          attachment_manifest_hash: hash('attachments', attachments),
          deadline_at_ms: null,
        },
        now_ms: nowMs,
      });
    };
    const launchedV1 = launch(personalV1.selection_token, 'personal-v1', 4_004);
    const stateV1 = temporary.store.queryOne<{
      inline_canonical_json: string;
    }>(
      `SELECT value.inline_canonical_json
         FROM workflow_graph_runs run
         JOIN workflow_values value ON value.id = run.state_config_value_id
        WHERE run.id = ? AND value.content_hash = run.state_config_hash`,
      [launchedV1.activation.graphRunId],
    )!;
    expect(
      (JSON.parse(stateV1.inline_canonical_json) as JsonObject)
        .personal_release,
    ).toMatchObject({
      release_id: v1.release_id,
      release_hash: v1.release_hash,
      source_hash: preparedV1.source_hash,
      plan_hash: preparedV1.compiled_plan_hash,
    });

    const sourceV2 = terminalChildSource('child_done_v2');
    const preparedV2 = temporary.gateway.preparePersonalWorkflowDraft({
      principal_ref: 'human:local-owner',
      source_workflow_id: temporary.workflowId,
      source_run_id: temporary.runId,
      source_json: sourceV2,
    });
    const v2 = temporary.gateway.publishPersonalWorkflowRelease({
      principal_ref: 'human:local-owner',
      personal_workflow_id: 'daily-summary',
      release_ref: { id: 'daily-summary', version: '2.0.0' },
      display_name: 'Daily summary',
      description: 'Second reviewed release',
      source_workflow_id: temporary.workflowId,
      source_run_id: temporary.runId,
      source_json: sourceV2,
      expected_source_hash: preparedV2.source_hash,
      expected_plan_hash: preparedV2.compiled_plan_hash,
      idempotency_key: 'personal-publish-v2',
      now_ms: 4_005,
    });
    expect(v2.active).toBe(false);
    expect(
      temporary.gateway
        .listRecipes({
          principal_ref: 'human:local-owner',
          now_ms: 4_006,
        })
        .items.find((item) => item.recipe_kind === 'personal')?.recipe_ref
        .version,
    ).toBe('1.0.0');
    temporary.gateway.activatePersonalWorkflowRelease({
      principal_ref: 'human:local-owner',
      personal_workflow_id: 'daily-summary',
      release_id: v2.release_id,
      release_hash: v2.release_hash,
      expected_pointer_row_version: 1,
      idempotency_key: 'personal-activate-v2',
      now_ms: 4_007,
    });
    expect(() =>
      launch(personalV1.selection_token, 'stale-personal-v1', 4_008),
    ).toThrow(/no longer active/);

    advanceWorkflowToCompletion(temporary.store, launchedV1.workflowId, 5_000);
    expect(
      temporary.store.queryOne<{
        status: string;
        final_outcome_kind: string | null;
      }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
        launchedV1.workflowId,
      ]),
    ).toEqual({ status: 'completed', final_outcome_kind: 'normal' });
    expect(
      temporary.store.queryOne<{
        source_snapshot_hash: Sha256Hash;
        compiled_plan_hash: Sha256Hash;
      }>(
        `SELECT source_snapshot_hash, compiled_plan_hash
           FROM workflow_graph_scope_builds
          WHERE graph_run_id = ? AND scope_kind = 'expansion'
          ORDER BY created_at_ms, id COLLATE BINARY LIMIT 1`,
        [launchedV1.activation.graphRunId],
      ),
    ).toMatchObject({
      source_snapshot_hash: preparedV1.source_hash,
      compiled_plan_hash: preparedV1.compiled_plan_hash,
    });

    const personalV2 = temporary.gateway
      .listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 5_100,
      })
      .items.find((item) => item.recipe_kind === 'personal')!;
    expect(personalV2.recipe_ref.version).toBe('2.0.0');
    const launchedV2 = launch(personalV2.selection_token, 'personal-v2', 5_101);
    advanceWorkflowToCompletion(temporary.store, launchedV2.workflowId, 5_200);
    expect(
      temporary.store.queryOne<{
        status: string;
        final_outcome_kind: string | null;
      }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
        launchedV2.workflowId,
      ]),
    ).toEqual({ status: 'completed', final_outcome_kind: 'normal' });
    expect(
      temporary.store.queryOne<{
        source_snapshot_hash: Sha256Hash;
        compiled_plan_hash: Sha256Hash;
      }>(
        `SELECT source_snapshot_hash, compiled_plan_hash
           FROM workflow_graph_scope_builds
          WHERE graph_run_id = ? AND scope_kind = 'expansion'
          ORDER BY created_at_ms, id COLLATE BINARY LIMIT 1`,
        [launchedV2.activation.graphRunId],
      ),
    ).toMatchObject({
      source_snapshot_hash: preparedV2.source_hash,
      compiled_plan_hash: preparedV2.compiled_plan_hash,
    });
  }, 20_000);

  it('publishes a self-contained Core release without fixture dependencies', () => {
    const store = openFresh();
    expect(ensureTaskWorkspaceCore(store, 1_000)).toBe('initialized');

    const members = store.queryAll<{
      resource_id: string;
      resource_version: string;
      owner_core_ref: string | null;
    }>(
      `SELECT resource.resource_id, resource.resource_version,
              resource.owner_core_ref
         FROM workflow_registry_closure_members member
         JOIN workflow_registry_resources resource
           ON resource.id = member.resource_id
        WHERE member.closure_manifest_id = ?
        ORDER BY member.member_index`,
      [
        `registry-closure:icarus.task-workspace-core@${TASK_WORKSPACE_CORE_VERSION}`,
      ],
    );
    expect(members.length).toBeGreaterThan(0);
    expect(
      members.every(
        (member) =>
          member.resource_version === TASK_WORKSPACE_CORE_VERSION &&
          member.owner_core_ref ===
            `icarus.core.task-workspace@${TASK_WORKSPACE_CORE_VERSION}` &&
          !member.resource_id.startsWith('fixture.'),
      ),
    ).toBe(true);

    const releaseDocuments = store.queryAll<{ content: string }>(
      `SELECT value.inline_canonical_json AS content
         FROM workflow_registry_resources resource
         JOIN workflow_values value ON value.id = resource.canonical_value_id
        WHERE resource.owner_core_ref = ?`,
      [`icarus.core.task-workspace@${TASK_WORKSPACE_CORE_VERSION}`],
    );
    expect(releaseDocuments.length).toBe(members.length);
    for (const document of releaseDocuments) {
      expect(document.content).not.toContain('fixture.');
      expect(document.content).not.toContain('test-only:');
    }
    expect(
      members.some(
        (member) =>
          member.resource_id === TASK_WORKSPACE_TEMPORARY_REFS.interface.id,
      ),
    ).toBe(true);
  });

  it('launches and advances the fixed Temporary Workflow through its Dynamic Child', async () => {
    const store = openFresh();
    expect(ensureTaskWorkspaceCore(store, 1_000)).toBe('initialized');
    const gateway = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 7));
    const catalog = gateway.listRecipes({
      principal_ref: 'human:local-owner',
      now_ms: 2_000,
    });
    const recipe = catalog.items.find(
      (item) => item.recipe_ref.id === 'ad_hoc_personal_task',
    );
    expect(recipe?.recipe_kind).toBe('core');

    const source = terminalChildSource();
    const before = store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflows',
      [],
    );
    const compilation = gateway.prepareTemporaryDraft({
      principal_ref: 'human:local-owner',
      selection_token: recipe!.selection_token,
      source_json: source,
      now_ms: 2_001,
    });
    expect(before).toEqual({ count: 0 });
    expect(
      store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflows',
        [],
      ),
    ).toEqual({ count: 0 });
    expect(compilation.compiled_plan_json.plan_hash).toBe(
      compilation.compiled_plan_hash,
    );
    const definitionRow = store.queryOne<{ inline_canonical_json: string }>(
      `SELECT value.inline_canonical_json
         FROM workflow_registry_resources resource
         JOIN workflow_values value ON value.id = resource.canonical_value_id
        WHERE resource.resource_type = 'definition'
          AND resource.resource_id = 'icarus.core.ad-hoc-personal-task'`,
      [],
    )!;
    const definition = JSON.parse(
      definitionRow.inline_canonical_json,
    ) as JsonObject;
    const outerPlan = definition.precompiled_plan as JsonObject;
    const owner = (outerPlan.nodes as JsonObject[]).find(
      (node) => node.id === 'expand_child',
    )!;
    expect(compilation.compiled_plan_json.interface_snapshot).toEqual(
      owner.child_interface_snapshot,
    );
    expect(compilation.compiled_plan_json.effective_policy_snapshot).toEqual(
      (owner.child_policy as JsonObject).effective_policy_snapshot,
    );

    const effectiveInput: JsonObject = { text: 'finish the child' };
    const attachmentManifest: JsonValue = [];
    const receipt = gateway.launchTemporary({
      principal_ref: 'human:local-owner',
      selection_token: recipe!.selection_token,
      authorization_ref: 'temporary-confirmation:revision-1',
      launch: {
        request_id: 'launch-1',
        creation_domain: 'task-workspace',
        creation_key: 'launch-1',
        effective_input_json: effectiveInput,
        effective_input_hash: hash('input', effectiveInput),
        attachment_manifest_json: attachmentManifest,
        attachment_manifest_hash: hash('attachments', attachmentManifest),
        deadline_at_ms: null,
      },
      now_ms: 2_002,
      confirmed_revision_id: 'revision-1',
      confirmed_source_json: source,
      confirmed_source_hash: compilation.source_hash,
      confirmed_plan_hash: compilation.compiled_plan_hash,
      resource_closure_hash: compilation.resource_closure_hash,
      policy_ceiling_hash: compilation.policy_ceiling_hash,
    });

    const authority = new WorkflowRuntimeTransactionAuthority(store);
    let nowMs = 3_000;
    for (let iteration = 0; iteration < 80; iteration += 1) {
      let processed = 0;
      for (const phase of [
        'compile',
        'materialize',
        'reconcile',
        'schedule',
        'recover',
        'close',
      ] as const) {
        try {
          processed += authority.advance(phase, 32, nowMs).processed;
        } catch (error) {
          const scopes = store.queryAll<Record<string, unknown>>(
            'SELECT id, parent_scope_id, owner_node_id, lifecycle, candidate_node_id, close_request_id, completion_cut_id FROM workflow_graph_scopes WHERE graph_run_id = ?',
            [receipt.activation.graphRunId],
          );
          const candidates = store.queryAll<Record<string, unknown>>(
            'SELECT id, scope_id, terminal_node_id, exit_name FROM workflow_graph_terminal_candidates WHERE graph_run_id = ?',
            [receipt.activation.graphRunId],
          );
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ scopes, candidates })}`,
          );
        }
        nowMs += 1;
      }
      const workflow = store.queryOne<{ status: string }>(
        'SELECT status FROM workflows WHERE id = ?',
        [receipt.workflowId],
      );
      if (workflow?.status !== 'active') break;
      if (processed === 0) break;
    }

    const workflow = store.queryOne<{
      status: string;
      final_outcome_kind: string | null;
    }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
      receipt.workflowId,
    ]);
    if (workflow?.status === 'active') {
      const diagnostic = {
        runs: store.queryAll<Record<string, unknown>>(
          'SELECT id, lifecycle, control, operational_state, root_scope_id, root_close_request_id, completion_cut_id, row_version FROM workflow_graph_runs WHERE workflow_id = ?',
          [receipt.workflowId],
        ),
        scopes: store.queryAll<Record<string, unknown>>(
          'SELECT id, parent_scope_id, owner_node_id, scope_kind, lifecycle, close_request_id, completion_cut_id, row_version FROM workflow_graph_scopes WHERE graph_run_id = ?',
          [receipt.activation.graphRunId],
        ),
        builds: store.queryAll<Record<string, unknown>>(
          'SELECT id, scope_kind, status, owner_scope_id, owner_node_id, source_snapshot_hash, compiled_plan_hash, row_version FROM workflow_graph_scope_builds WHERE graph_run_id = ?',
          [receipt.activation.graphRunId],
        ),
        nodes: store.queryAll<Record<string, unknown>>(
          'SELECT id, scope_id, node_key, node_type, phase, trigger_state, terminal_status, row_version FROM workflow_graph_nodes WHERE graph_run_id = ?',
          [receipt.activation.graphRunId],
        ),
        facts: store.queryAll<Record<string, unknown>>(
          'SELECT scope_id, fact_kind, fact_key, causal_wave FROM workflow_graph_facts WHERE graph_run_id = ?',
          [receipt.activation.graphRunId],
        ),
      };
      throw new Error(`Runtime stalled: ${JSON.stringify(diagnostic)}`);
    }
    expect(workflow).toEqual({
      status: 'completed',
      final_outcome_kind: 'normal',
    });
    const childBuild = store.queryOne<{
      source_snapshot_hash: Sha256Hash;
      compiled_plan_hash: Sha256Hash;
      scope_kind: string;
    }>(
      `SELECT source_snapshot_hash, compiled_plan_hash, scope_kind
         FROM workflow_graph_scope_builds
        WHERE graph_run_id = ? AND scope_kind <> 'root'`,
      [receipt.activation.graphRunId],
    );
    expect(childBuild).toMatchObject({
      source_snapshot_hash: compilation.source_hash,
      compiled_plan_hash: compilation.compiled_plan_hash,
      scope_kind: 'expansion',
    });
  });

  it('executes a Temporary Codex capability through T5, Worker callback, and T6a close', async () => {
    const store = openFresh();
    ensureTaskWorkspaceCore(store, 1_000);
    const gateway = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 7));
    const recipe = gateway
      .listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 2_000,
      })
      .items.find((item) => item.recipe_ref.id === 'ad_hoc_personal_task')!;
    expect(recipe.recipe_ref.version).toBe(TASK_WORKSPACE_CORE_VERSION);
    const response = cloneJson(TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE);
    const source = (response.graph_scope as JsonObject).source as JsonObject;
    const compilation = gateway.prepareTemporaryDraft({
      principal_ref: 'human:local-owner',
      selection_token: recipe.selection_token,
      source_json: source,
      now_ms: 2_001,
    });
    const capabilityNode = (
      compilation.compiled_plan_json.nodes as JsonObject[]
    ).find((node) => node.type === 'delegation')!;
    expect(capabilityNode.outbox_execution_binding).toMatchObject({
      adapter_identity: {
        ref: TASK_WORKSPACE_TEMPORARY_REFS.adapter,
      },
    });
    const effectiveInput: JsonObject = { text: 'Complete the Codex task' };
    const attachmentManifest: JsonValue = [];
    const receipt = gateway.launchTemporary({
      principal_ref: 'human:local-owner',
      selection_token: recipe.selection_token,
      authorization_ref: 'temporary-confirmation:codex-e2e',
      launch: {
        request_id: 'launch:codex-e2e',
        creation_domain: 'task-workspace-test',
        creation_key: 'codex-e2e',
        effective_input_json: effectiveInput,
        effective_input_hash: hash('input', effectiveInput),
        attachment_manifest_json: attachmentManifest,
        attachment_manifest_hash: hash('attachments', attachmentManifest),
        deadline_at_ms: null,
      },
      now_ms: 2_002,
      confirmed_revision_id: 'revision:codex-e2e',
      confirmed_source_json: source,
      confirmed_source_hash: compilation.source_hash,
      confirmed_plan_hash: compilation.compiled_plan_hash,
      resource_closure_hash: compilation.resource_closure_hash,
      policy_ceiling_hash: compilation.policy_ceiling_hash,
    });

    const executionRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-workspace-codex-e2e-'),
    );
    roots.push(executionRoot);
    const executionStore = new WorkflowAdapterExecutionStore(
      path.join(executionRoot, 'workflow-adapter-executions.db'),
    );
    const registry = new WorkflowExecutionAdapterRegistry();
    let adapterStarts = 0;
    registry.register({
      refId: TASK_WORKSPACE_TEMPORARY_REFS.adapter.id,
      preflight: async () => undefined,
      start: async (context, request) => {
        adapterStarts += 1;
        expect(request.result_schema).toMatchObject(
          TASK_WORKSPACE_TEMPORARY_REFS.resultSchema,
        );
        return {
          providerMetadata: { source: 'temporary-codex-e2e' },
          completion: Promise.resolve({
            state: 'succeeded' as const,
            result: {
              format: 'icarus.workflow-agent-result/1' as const,
              outcome: 'success' as const,
              summary: 'Codex task completed',
              provider: {
                adapter: TASK_WORKSPACE_TEMPORARY_REFS.adapter.id,
                execution_id: context.executionId,
                metadata: { source: 'temporary-codex-e2e' },
              },
              artifacts: [],
              error: null,
            },
          }),
          cancel: async () => undefined,
        };
      },
      recover: async () => {
        throw new Error('Recovery is not expected');
      },
    } satisfies WorkflowExecutionAdapter);
    let workerNow = 3_000;
    const worker = new WorkflowExecutionWorker({
      runtimeStore: store,
      executionStore,
      registry,
      pollIntervalMs: 100,
      leaseOwner: 'worker:temporary-codex-e2e',
      now: () => workerNow,
    });
    const authority = new WorkflowRuntimeTransactionAuthority(store);

    try {
      for (let iteration = 0; iteration < 120; iteration += 1) {
        for (const phase of [
          'compile',
          'materialize',
          'reconcile',
          'schedule',
          'recover',
          'close',
        ] as const) {
          authority.advance(phase, 32, workerNow);
          workerNow += 1;
        }
        await worker.tick();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const workflow = store.queryOne<{ status: string }>(
          'SELECT status FROM workflows WHERE id = ?',
          [receipt.workflowId],
        );
        if (workflow?.status !== 'active') break;
      }

      expect(adapterStarts).toBe(1);
      expect(
        store.queryOne<{ count: number }>(
          `SELECT count(*) AS count FROM workflow_outbox
            WHERE adapter_resource_id = ? AND status = 'succeeded'`,
          [
            `registry-resource:outbox_adapter:${TASK_WORKSPACE_TEMPORARY_REFS.adapter.id}@${TASK_WORKSPACE_TEMPORARY_REFS.adapter.version}`,
          ],
        ),
      ).toEqual({ count: 1 });
      expect(
        store.queryOne<{
          phase: string;
          execution_outcome: string | null;
          acceptance_state: string;
        }>(
          `SELECT attempt.phase, attempt.execution_outcome,
                  attempt.acceptance_state
             FROM workflow_graph_node_attempts attempt
             JOIN workflow_graph_nodes node ON node.id = attempt.node_id
            WHERE attempt.graph_run_id = ? AND node.node_key = 'codex_task'`,
          [receipt.activation.graphRunId],
        ),
      ).toEqual({
        phase: 'terminal',
        execution_outcome: 'succeeded',
        acceptance_state: 'fenced',
      });
      expect(
        store.queryOne<{
          status: string;
          final_outcome_kind: string | null;
        }>('SELECT status, final_outcome_kind FROM workflows WHERE id = ?', [
          receipt.workflowId,
        ]),
      ).toEqual({ status: 'completed', final_outcome_kind: 'normal' });
    } finally {
      await worker.stop();
      executionStore.close();
    }
  }, 30_000);

  it('resolves a closed Workspace approval interaction with canonical replay', () => {
    const target = armedApprovalWait('accepted-duplicate-conflict');
    const payload: JsonObject = { ok: true };
    const request = {
      principal_ref: 'human:local-owner',
      interaction_id: 'interaction:approval:1',
      wait_id: target.waitId,
      rendered_snapshot_hash: hash('rendered-snapshot', { card: 'approval' }),
      action_id: 'approve',
      payload_json: payload,
      payload_hash: calculateWorkspaceInteractionPayloadHash(payload),
      expected_target_row_version: target.waitRowVersion,
      idempotency_key: 'workspace-interaction:approval:1',
      now_ms: 50,
    } as const;

    expect(() =>
      target.gateway.submitInteraction({
        ...request,
        expectedRunWorkFenceEpoch: 0,
      } as never),
    ).toThrow(/not a closed document/);
    expect(
      target.fixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_inbox_events',
        [],
      )!.count,
    ).toBe(0);

    expect(target.gateway.submitInteraction(request).disposition).toBe(
      'accepted',
    );
    expect(
      target.gateway.submitInteraction({ ...request, now_ms: 51 }).disposition,
    ).toBe('duplicate');
    const conflictingPayload: JsonObject = { ok: false };
    expect(
      target.gateway.submitInteraction({
        ...request,
        payload_json: conflictingPayload,
        payload_hash:
          calculateWorkspaceInteractionPayloadHash(conflictingPayload),
        now_ms: 52,
      }).disposition,
    ).toBe('conflict');

    const inbox = target.fixture.instance.store.queryOne<{
      payload_value_id: string;
      ingress_authorization_value_id: string;
      binding_authorization_value_id: string;
    }>(
      `SELECT payload_value_id, ingress_authorization_value_id,
              binding_authorization_value_id
         FROM workflow_graph_inbox_events`,
      [],
    )!;
    const values = target.fixture.instance.store.queryAll<{
      id: string;
      inline_canonical_json: string;
      owner_graph_run_id: string;
    }>(
      `SELECT v.id, v.inline_canonical_json, o.owner_graph_run_id
         FROM workflow_values v
         JOIN workflow_value_ownerships o ON o.value_id = v.id
        WHERE v.id IN (?, ?, ?)
        ORDER BY v.id`,
      [
        inbox.payload_value_id,
        inbox.ingress_authorization_value_id,
        inbox.binding_authorization_value_id,
      ],
    );
    expect(values).toHaveLength(3);
    expect(
      values.every(
        (value) => value.owner_graph_run_id === target.fixture.graphRunId,
      ),
    ).toBe(true);
    expect(
      values
        .map((value) => JSON.parse(value.inline_canonical_json) as JsonValue)
        .filter(
          (value) =>
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof value.format === 'string',
        )
        .map((value) => (value as JsonObject).format)
        .sort(),
    ).toEqual([
      'icarus.workflow-wait-binding-authorization/1',
      'icarus.workflow-wait-ingress-authorization/1',
    ]);
  }, 20_000);

  it('rejects a foreign principal and unavailable Wait lineage', () => {
    const target = armedApprovalWait('principal-lineage');
    const payload: JsonObject = { ok: true };
    const request = {
      principal_ref: 'human:other',
      interaction_id: 'interaction:approval:foreign',
      wait_id: target.waitId,
      rendered_snapshot_hash: hash('rendered-snapshot', { card: 'foreign' }),
      action_id: 'approve',
      payload_json: payload,
      payload_hash: calculateWorkspaceInteractionPayloadHash(payload),
      expected_target_row_version: target.waitRowVersion,
      idempotency_key: 'workspace-interaction:approval:foreign',
      now_ms: 50,
    } as const;
    expect(() => target.gateway.submitInteraction(request)).toThrow(
      /belongs to another principal/,
    );
    expect(() =>
      target.gateway.submitInteraction({
        ...request,
        principal_ref: 'human:local-owner',
        wait_id: 'wait:missing',
      }),
    ).toThrow(/Wait is unavailable/);
    expect(
      target.fixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_inbox_events',
        [],
      )!.count,
    ).toBe(0);
  }, 20_000);

  it('prepares without writes and reconciles an idempotent Temporary Replan through T8', () => {
    const target = launchedTemporary('temporary-replan');
    advanceUntilTemporaryExpansion(target.store, target.runId, 3_000);
    const activation = target.store.queryOne<{ state_instance_id: string }>(
      'SELECT state_instance_id FROM workflow_graph_runs WHERE id = ?',
      [target.runId],
    )!;
    const oldPlan = target.store.queryOne<{
      compiled_plan_json: string | null;
      compiled_plan_value_json: string | null;
      plan_hash: Sha256Hash;
    }>(
      `SELECT plan.compiled_plan_json, value.inline_canonical_json AS compiled_plan_value_json,
              plan.plan_hash
         FROM workflow_graph_scope_builds build
         JOIN workflow_graph_scope_plans plan ON plan.id = build.compiled_plan_id
    LEFT JOIN workflow_values value ON value.id = plan.compiled_plan_value_id
        WHERE build.graph_run_id = ? AND build.scope_kind = 'expansion'
        ORDER BY build.created_at_ms, build.id COLLATE BINARY LIMIT 1`,
      [target.runId],
    )!;
    const oldPlanBytes =
      oldPlan.compiled_plan_json ?? oldPlan.compiled_plan_value_json;
    const beforePrepare = runtimeWriteCounts(target.store);
    const preparation = target.gateway.prepareTemporaryReplan({
      principal_ref: 'human:local-owner',
      source_workflow_id: target.workflowId,
      source_activation_id: activation.state_instance_id,
      source_run_id: target.runId,
      source_json: terminalChildSource('child_done_replanned'),
      idempotency_key: 'temporary-replan:confirmed-change',
      now_ms: 4_000,
    });
    expect(runtimeWriteCounts(target.store)).toEqual(beforePrepare);
    expect(preparation).toMatchObject({
      format: 'icarus.workspace-temporary-replan-preparation/1',
      old_plan_hash: oldPlan.plan_hash,
      source_authority: {
        workflow_id: target.workflowId,
        activation_id: activation.state_instance_id,
        run_id: target.runId,
      },
    });
    expect(preparation.new_plan_hash).not.toBe(preparation.old_plan_hash);

    const applyRequest = {
      principal_ref: 'human:local-owner',
      preparation,
      confirmation_ref: preparation.confirmation_ref,
      confirmation_hash: preparation.confirmation_hash,
      now_ms: 4_001,
    } as const;
    const applying = target.gateway.applyTemporaryReplan(applyRequest);
    expect(applying).toMatchObject({
      disposition: 'applying',
      code: 'target_transition_pending',
      source_workflow_id: target.workflowId,
      source_run_id: target.runId,
      target_activation_id: null,
      target_run_id: null,
    });
    expect(applying.source_fence_receipt).not.toBeNull();
    expect(
      target.store.queryOne<{ control: string }>(
        'SELECT control FROM workflow_graph_runs WHERE id = ?',
        [target.runId],
      ),
    ).toEqual({ control: 'cancelling' });
    expect(
      target.gateway.applyTemporaryReplan({ ...applyRequest, now_ms: 4_002 }),
    ).toMatchObject({
      disposition: 'duplicate',
      code: 'source_fence_duplicate',
      target_run_id: null,
    });

    const reconcileRequest = {
      principal_ref: 'human:local-owner',
      source_workflow_id: target.workflowId,
      source_activation_id: activation.state_instance_id,
      source_run_id: target.runId,
      replan_creation_key: preparation.replan_creation_key,
      proposal_hash: preparation.proposal_hash,
      confirmation_ref: preparation.confirmation_ref,
      confirmation_hash: preparation.confirmation_hash,
    } as const;
    expect(
      target.gateway.reconcileTemporaryReplan(reconcileRequest),
    ).toMatchObject({
      disposition: 'applying',
      code: 'target_transition_pending',
    });
    const authority = new WorkflowRuntimeTransactionAuthority(target.store);
    for (let iteration = 0; iteration < 50; iteration += 1) {
      authority.advance('close', 32, 4_100 + iteration);
      if (
        target.store.queryOne<{ found: number }>(
          'SELECT 1 AS found FROM workflow_state_transition_history WHERE source_run_id = ?',
          [target.runId],
        )
      ) {
        break;
      }
    }
    const applied = target.gateway.reconcileTemporaryReplan(reconcileRequest);
    expect(applied.disposition).toBe('applied');
    expect(applied.target_activation_id).not.toBeNull();
    expect(applied.target_run_id).not.toBeNull();
    expect(applied.target_run_id).not.toBe(target.runId);
    expect(
      target.store.queryOne<{ outcome_kind: string | null }>(
        'SELECT outcome_kind FROM workflow_graph_runs WHERE id = ?',
        [target.runId],
      ),
    ).toEqual({ outcome_kind: 'cancelled' });
    expect(
      target.store.queryOne<{
        compiled_plan_json: string | null;
        compiled_plan_value_json: string | null;
      }>(
        `SELECT plan.compiled_plan_json,
                value.inline_canonical_json AS compiled_plan_value_json
           FROM workflow_graph_scope_builds build
           JOIN workflow_graph_scope_plans plan ON plan.id = build.compiled_plan_id
      LEFT JOIN workflow_values value ON value.id = plan.compiled_plan_value_id
          WHERE build.graph_run_id = ? AND build.scope_kind = 'expansion'
          ORDER BY build.created_at_ms, build.id COLLATE BINARY LIMIT 1`,
        [target.runId],
      ),
    ).toMatchObject({
      compiled_plan_json: oldPlan.compiled_plan_json,
      compiled_plan_value_json: oldPlan.compiled_plan_value_json,
    });
    expect(oldPlanBytes).not.toBeNull();
  });

  it('denies stale frontier, quarantine, and non-closed Replan apply documents', () => {
    const target = launchedTemporary('temporary-replan-denials');
    advanceUntilTemporaryExpansion(target.store, target.runId, 3_000);
    const activation = target.store.queryOne<{ state_instance_id: string }>(
      'SELECT state_instance_id FROM workflow_graph_runs WHERE id = ?',
      [target.runId],
    )!;
    const prepareRequest = {
      principal_ref: 'human:local-owner',
      source_workflow_id: target.workflowId,
      source_activation_id: activation.state_instance_id,
      source_run_id: target.runId,
      source_json: terminalChildSource('child_done_stale'),
      idempotency_key: 'temporary-replan:stale',
      now_ms: 4_000,
    } as const;
    const preparation = target.gateway.prepareTemporaryReplan(prepareRequest);
    target.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_runs
            SET row_version = row_version + 1, updated_at_ms = ? WHERE id = ?`,
        [4_001, target.runId],
      );
    });
    expect(
      target.gateway.applyTemporaryReplan({
        principal_ref: 'human:local-owner',
        preparation,
        confirmation_ref: preparation.confirmation_ref,
        confirmation_hash: preparation.confirmation_hash,
        now_ms: 4_002,
      }),
    ).toMatchObject({
      disposition: 'denied',
      code: 'stale_source_authority',
    });
    expect(() =>
      target.gateway.applyTemporaryReplan({
        principal_ref: 'human:local-owner',
        preparation,
        confirmation_ref: preparation.confirmation_ref,
        confirmation_hash: preparation.confirmation_hash,
        now_ms: 4_003,
        actor: {},
      } as never),
    ).toThrow(/not a closed document/);
    target.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_runs
            SET operational_state = 'quarantined', row_version = row_version + 1,
                updated_at_ms = ? WHERE id = ?`,
        [4_004, target.runId],
      );
    });
    expect(() =>
      target.gateway.prepareTemporaryReplan({
        ...prepareRequest,
        idempotency_key: 'temporary-replan:quarantined',
        now_ms: 4_005,
      }),
    ).toThrow(/integrity is quarantined/);
  });

  it('denies Temporary Replan for unsafe effects and blocked Runtime state', () => {
    const effectTarget = launchedTemporary('temporary-replan-effect-denial');
    advanceUntilTemporaryExpansion(
      effectTarget.store,
      effectTarget.runId,
      3_000,
    );
    const activation = effectTarget.store.queryOne<{
      state_instance_id: string;
    }>('SELECT state_instance_id FROM workflow_graph_runs WHERE id = ?', [
      effectTarget.runId,
    ])!;
    seedUnsafeEffect(effectTarget.store, effectTarget.runId, 'unsafe', 4_000);
    expect(() =>
      effectTarget.gateway.prepareTemporaryReplan({
        principal_ref: 'human:local-owner',
        source_workflow_id: effectTarget.workflowId,
        source_activation_id: activation.state_instance_id,
        source_run_id: effectTarget.runId,
        source_json: terminalChildSource('child_done_effect_denied'),
        idempotency_key: 'temporary-replan:unsafe-effect',
        now_ms: 4_001,
      }),
    ).toThrow(/in-flight, unknown, or uncompensated effect/);

    const blockedTarget = launchedTemporary('temporary-replan-blocked-denial');
    advanceUntilTemporaryExpansion(
      blockedTarget.store,
      blockedTarget.runId,
      5_000,
    );
    const blockedActivation = blockedTarget.store.queryOne<{
      state_instance_id: string;
    }>('SELECT state_instance_id FROM workflow_graph_runs WHERE id = ?', [
      blockedTarget.runId,
    ])!;
    blockedTarget.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_runs
            SET operational_state = 'action_required', row_version = row_version + 1,
                updated_at_ms = ? WHERE id = ?`,
        [5_100, blockedTarget.runId],
      );
    });
    expect(() =>
      blockedTarget.gateway.prepareTemporaryReplan({
        principal_ref: 'human:local-owner',
        source_workflow_id: blockedTarget.workflowId,
        source_activation_id: blockedActivation.state_instance_id,
        source_run_id: blockedTarget.runId,
        source_json: terminalChildSource('child_done_blocked'),
        idempotency_key: 'temporary-replan:blocked',
        now_ms: 5_101,
      }),
    ).toThrow(/source operation is blocked/);
  });

  it('applies closed pause, resume, and cancel commands with canonical replay', () => {
    const target = launchedTemporary('runtime-command');
    const row = () =>
      target.store.queryOne<{
        control: string;
        row_version: number;
      }>('SELECT control, row_version FROM workflow_graph_runs WHERE id = ?', [
        target.runId,
      ])!;
    const initial = row();
    const detail = target.gateway.getRuntimeDetail({
      principal_ref: 'human:local-owner',
      workflow_ids: [target.workflowId],
    });
    expect(detail.workflows[0]!.command_hints).toEqual([
      {
        action: 'pause',
        workflow_id: target.workflowId,
        run_id: target.runId,
        expected_target_row_version: initial.row_version,
      },
      {
        action: 'cancel',
        workflow_id: target.workflowId,
        run_id: target.runId,
        expected_target_row_version: initial.row_version,
      },
    ]);
    const pause = {
      principal_ref: 'human:local-owner',
      workflow_id: target.workflowId,
      run_id: target.runId,
      action: 'pause',
      expected_target_row_version: initial.row_version,
      idempotency_key: 'workspace-command:pause',
      operation_ref: 'proposal:pause',
      now_ms: 3_000,
    } as const;
    expect(target.gateway.submitCommand(pause).execution_result).toBe(
      'applied',
    );
    expect(row().control).toBe('paused');
    expect(
      target.gateway.submitCommand({ ...pause, now_ms: 3_001 })
        .execution_result,
    ).toBe('duplicate');
    expect(
      target.gateway.getRuntimeDetail({
        principal_ref: 'human:local-owner',
        workflow_ids: [target.workflowId],
      }).workflows[0]!.command_hints,
    ).toEqual([
      {
        action: 'resume',
        workflow_id: target.workflowId,
        run_id: target.runId,
        expected_target_row_version: row().row_version,
      },
      {
        action: 'cancel',
        workflow_id: target.workflowId,
        run_id: target.runId,
        expected_target_row_version: row().row_version,
      },
    ]);

    const paused = row();
    expect(
      target.gateway.submitCommand({
        ...pause,
        action: 'resume',
        expected_target_row_version: paused.row_version,
        idempotency_key: 'workspace-command:resume',
        operation_ref: 'proposal:resume',
        now_ms: 3_002,
      }).execution_result,
    ).toBe('applied');
    expect(row().control).toBe('resuming');
    expect(() =>
      target.gateway.submitCommand({
        ...pause,
        principal_ref: 'human:other',
        expected_target_row_version: row().row_version,
        idempotency_key: 'workspace-command:foreign',
        operation_ref: 'proposal:foreign',
        now_ms: 3_003,
      }),
    ).toThrow(/belongs to another principal/);
    expect(() =>
      target.gateway.submitCommand({ ...pause, actor: {} } as never),
    ).toThrow(/not a closed document/);

    const resumed = row();
    expect(
      target.gateway.submitCommand({
        ...pause,
        action: 'cancel',
        expected_target_row_version: resumed.row_version,
        idempotency_key: 'workspace-command:cancel',
        operation_ref: 'proposal:cancel',
        now_ms: 3_004,
      }).execution_result,
    ).toBe('applied');
    expect(row().control).toBe('cancelling');
  });

  it('runs the service with coalesced wakeups', async () => {
    const authority = {
      calls: 0,
      advance: () => {
        authority.calls += 1;
        return { processed: 0, has_more: false };
      },
    };
    const service = new WorkflowRuntimeService({
      authority,
      poll_interval_ms: 10_000,
      max_iterations_per_turn: 2,
    });
    service.wake('one');
    service.wake('two');
    await service.start();
    await service.stop();
    expect(authority.calls).toBeGreaterThanOrEqual(6);
  });
});
