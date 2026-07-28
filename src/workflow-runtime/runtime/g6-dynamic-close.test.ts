import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  calculateCreationIntentHash,
  prepareRequiredFinalizationT0p,
} from '../creation/task-intake.js';
import { scheduleReadyNodeT4 } from './basic-scheduler.js';
import {
  finalizeChildScopeT7b,
  materializeDynamicScopeT2b,
  persistDynamicCompileResultT2a,
  recordDynamicBuildFailureT2a,
  sealExpansionManifestT4,
} from './child-runtime.js';
import { runtimeObjectHash } from './graph-store.js';
import { requestScopeCloseT7a } from './graph-runtime.js';
import {
  commitRootT8,
  recordRootFinalizationAttempt,
} from './root-finalizer.js';
import {
  initializeScopeFixedPointT3a,
  reconcileFactT3a,
  requestSettledCloseT3b,
} from './reconciler.js';
import {
  createG6MapFixture,
  g6Hash,
  type G6MapFixture,
} from './g6-test-support.js';

const fixtures: G6MapFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.instance.cleanup();
});

function currentRun(fixture: G6MapFixture) {
  return fixture.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
    next_event_seq: number;
  }>(
    `SELECT row_version, work_fence_epoch, next_event_seq
       FROM workflow_graph_runs WHERE id = ?`,
    [fixture.graphRunId],
  )!;
}

function currentScope(fixture: G6MapFixture, scopeId: string) {
  return fixture.instance.store.queryOne<{
    row_version: number;
    work_fence_epoch: number;
    lifecycle: string;
  }>(
    `SELECT row_version, work_fence_epoch, lifecycle
       FROM workflow_graph_scopes WHERE id = ? AND graph_run_id = ?`,
    [scopeId, fixture.graphRunId],
  )!;
}

function currentNode(fixture: G6MapFixture, nodeId: string) {
  return fixture.instance.store.queryOne<{
    row_version: number;
    phase: string;
    controller_state: string;
  }>(
    `SELECT row_version, phase, controller_state
       FROM workflow_graph_nodes WHERE id = ? AND graph_run_id = ?`,
    [nodeId, fixture.graphRunId],
  )!;
}

function materializeMapChildren(
  fixture: G6MapFixture,
  policy: JsonObject,
  itemKeys: readonly string[],
  nowMs: number,
  materialize = true,
): { ownerId: string; childScopeIds: string[]; buildIds: readonly string[] } {
  const owner = fixture.instance.store.queryOne<{
    id: string;
    row_version: number;
  }>(
    `SELECT id, row_version FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ? AND node_type = 'map'`,
    [fixture.graphRunId, fixture.rootScopeId],
  )!;
  const activationSequence = currentRun(fixture).next_event_seq;
  fixture.instance.store.withImmediateTransaction((transaction) => {
    expect(
      transaction.execute(
        `UPDATE workflow_graph_nodes
            SET phase = 'ready', trigger_state = 'true', input_state = 'sealed',
                trigger_cut_json = ?, trigger_cut_hash = ?,
                input_snapshot_json = ?, input_snapshot_value_id = ?,
                input_snapshot_hash = ?, activation_event_seq = ?,
                run_work_fence_epoch_at_activation = 0,
                scope_work_fence_epoch_at_activation = 0,
                row_version = row_version + 1, ready_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ? AND row_version = ? AND phase = 'pending'
            AND controller_state = 'sealing'`,
        [
          canonicalJson({ root: true }),
          g6Hash(`map-trigger-cut:${nowMs}`),
          canonicalJson({ items: [...itemKeys] }),
          fixture.seed.values.input!.id,
          fixture.seed.values.input!.hash,
          activationSequence,
          nowMs,
          nowMs,
          owner.id,
          owner.row_version,
        ],
      ).changes,
    ).toBe(1);
  });
  const readyOwner = currentNode(fixture, owner.id);
  scheduleReadyNodeT4(
    fixture.instance.store,
    { current: () => ({}) as never },
    {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      nodeId: owner.id,
      expectedNodeRowVersion: readyOwner.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: activationSequence,
      activation: { kind: 'child_owner' },
      nowMs: nowMs + 1,
    },
  );
  const runBeforeSeal = currentRun(fixture);
  const rootBeforeSeal = currentScope(fixture, fixture.rootScopeId);
  const ownerBeforeSeal = currentNode(fixture, owner.id);
  const persistedBodyPlan = fixture.instance.store.queryOne<{
    id: string;
    plan_hash: Sha256Hash;
  }>(
    `SELECT id, plan_hash FROM workflow_graph_scope_plans
      WHERE graph_run_id = ? AND plan_hash = ?`,
    [fixture.graphRunId, fixture.childPlan.plan_hash],
  )!;
  const sealed = sealExpansionManifestT4(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    ownerScopeId: fixture.rootScopeId,
    ownerNodeId: owner.id,
    expectedRunRowVersion: runBeforeSeal.row_version,
    expectedOwnerScopeRowVersion: rootBeforeSeal.row_version,
    expectedOwnerNodeRowVersion: ownerBeforeSeal.row_version,
    expectedRunWorkFenceEpoch: runBeforeSeal.work_fence_epoch,
    expectedOwnerScopeWorkFenceEpoch: rootBeforeSeal.work_fence_epoch,
    mode: 'map',
    sourceArtifact: fixture.seed.values.source!,
    manifest: { items: [...itemKeys] },
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    mapItemResultsManifestSchema:
      fixture.seed.refs.mapItemResultsManifestSchema!,
    childCompletionPolicy: policy,
    children: itemKeys.map((itemKey, itemIndex) => ({
      childKey: `item:${itemIndex}`,
      itemIndex,
      itemKey,
      itemKeyHash: runtimeObjectHash('map-item-key', itemKey),
      sourceSeedHash: fixture.childPlan.source_hash as Sha256Hash,
      sourceSnapshot: fixture.seed.values.childSource!,
      inputSnapshot: fixture.seed.values.childInput!,
      compilerSnapshotHash: g6Hash('compiler-snapshot'),
      compiledPlan: {
        id: persistedBodyPlan.id,
        hash: persistedBodyPlan.plan_hash,
      },
    })),
    nowMs: nowMs + 2,
  });
  const childScopeIds: string[] = [];
  if (materialize)
    sealed.buildIds.forEach((buildId, index) => {
      const run = currentRun(fixture);
      const root = currentScope(fixture, fixture.rootScopeId);
      const currentOwner = currentNode(fixture, owner.id);
      childScopeIds.push(
        materializeDynamicScopeT2b(fixture.instance.store, {
          graphRunId: fixture.graphRunId,
          buildId,
          expectedBuildRowVersion: 1,
          expectedRunRowVersion: run.row_version,
          expectedOwnerScopeRowVersion: root.row_version,
          expectedOwnerNodeRowVersion: currentOwner.row_version,
          expectedRunWorkFenceEpoch: run.work_fence_epoch,
          expectedOwnerScopeWorkFenceEpoch: root.work_fence_epoch,
          nowMs: nowMs + 3 + index,
        }).scopeId,
      );
    });
  return { ownerId: owner.id, childScopeIds, buildIds: sealed.buildIds };
}

function materializeSingleDynamicChild(
  fixture: G6MapFixture,
  mode: 'subgraph' | 'expand',
  nowMs: number,
): { ownerId: string; childScopeId: string } {
  const owner = fixture.instance.store.queryOne<{
    id: string;
    row_version: number;
  }>(
    `SELECT id, row_version FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ? AND node_type = ?`,
    [fixture.graphRunId, fixture.rootScopeId, mode],
  )!;
  const activationSequence = currentRun(fixture).next_event_seq;
  fixture.instance.store.withImmediateTransaction((transaction) => {
    expect(
      transaction.execute(
        `UPDATE workflow_graph_nodes
            SET phase = 'ready', trigger_state = 'true', input_state = 'sealed',
                trigger_cut_json = ?, trigger_cut_hash = ?,
                input_snapshot_json = ?, input_snapshot_value_id = ?,
                input_snapshot_hash = ?, activation_event_seq = ?,
                run_work_fence_epoch_at_activation = 0,
                scope_work_fence_epoch_at_activation = 0,
                row_version = row_version + 1, ready_at_ms = ?,
                updated_at_ms = ?
          WHERE id = ? AND row_version = ? AND phase = 'pending'
            AND controller_state = 'sealing'`,
        [
          canonicalJson({ root: true }),
          g6Hash(`${mode}-trigger-cut:${nowMs}`),
          canonicalJson({ child_source_hash: fixture.childPlan.source_hash }),
          fixture.seed.values.childSource!.id,
          fixture.seed.values.childSource!.hash,
          activationSequence,
          nowMs,
          nowMs,
          owner.id,
          owner.row_version,
        ],
      ).changes,
    ).toBe(1);
  });
  const readyOwner = currentNode(fixture, owner.id);
  scheduleReadyNodeT4(
    fixture.instance.store,
    { current: () => ({}) as never },
    {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      nodeId: owner.id,
      expectedNodeRowVersion: readyOwner.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: activationSequence,
      activation: { kind: 'child_owner' },
      nowMs: nowMs + 1,
    },
  );
  const ownerPlan = (fixture.plan.nodes as JsonObject[]).find(
    (node) => node.type === mode,
  )!;
  const persistedStaticPlan =
    mode === 'subgraph'
      ? fixture.instance.store.queryOne<{ id: string; plan_hash: Sha256Hash }>(
          `SELECT id, plan_hash FROM workflow_graph_scope_plans
            WHERE graph_run_id = ? AND plan_hash = ?`,
          [fixture.graphRunId, fixture.childPlan.plan_hash],
        )
      : undefined;
  if (mode === 'subgraph') expect(persistedStaticPlan).toBeDefined();
  const runBeforeSeal = currentRun(fixture);
  const rootBeforeSeal = currentScope(fixture, fixture.rootScopeId);
  const ownerBeforeSeal = currentNode(fixture, owner.id);
  const sealed = sealExpansionManifestT4(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    ownerScopeId: fixture.rootScopeId,
    ownerNodeId: owner.id,
    expectedRunRowVersion: runBeforeSeal.row_version,
    expectedOwnerScopeRowVersion: rootBeforeSeal.row_version,
    expectedOwnerNodeRowVersion: ownerBeforeSeal.row_version,
    expectedRunWorkFenceEpoch: runBeforeSeal.work_fence_epoch,
    expectedOwnerScopeWorkFenceEpoch: rootBeforeSeal.work_fence_epoch,
    mode,
    sourceArtifact: fixture.seed.values.childSource!,
    manifest: {
      mode,
      child_source_hash: fixture.childPlan.source_hash,
    },
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    childCompletionPolicy: ownerPlan.child_policy as JsonObject,
    children: [
      {
        childKey: 'single',
        sourceSeedHash: fixture.childPlan.source_hash as Sha256Hash,
        sourceSnapshot: fixture.seed.values.childSource!,
        inputSnapshot: fixture.seed.values.childInput!,
        compilerSnapshotHash: g6Hash('compiler-snapshot'),
        ...(persistedStaticPlan
          ? {
              compiledPlan: {
                id: persistedStaticPlan.id,
                hash: persistedStaticPlan.plan_hash,
              },
            }
          : {}),
      },
    ],
    nowMs: nowMs + 2,
  });
  if (mode === 'expand')
    expect(
      persistDynamicCompileResultT2a(fixture.instance.store, {
        graphRunId: fixture.graphRunId,
        buildId: sealed.buildIds[0]!,
        expectedBuildRowVersion: 1,
        expectedRunWorkFenceEpoch: 0,
        expectedOwnerScopeWorkFenceEpoch: 0,
        source: fixture.childSource,
        plan: fixture.childPlan,
        nowMs: nowMs + 3,
      }).disposition,
    ).toBe('compiled');
  const run = currentRun(fixture);
  const root = currentScope(fixture, fixture.rootScopeId);
  const materialized = materializeDynamicScopeT2b(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    buildId: sealed.buildIds[0]!,
    expectedBuildRowVersion: mode === 'expand' ? 2 : 1,
    expectedRunRowVersion: run.row_version,
    expectedOwnerScopeRowVersion: root.row_version,
    expectedOwnerNodeRowVersion: currentNode(fixture, owner.id).row_version,
    expectedRunWorkFenceEpoch: run.work_fence_epoch,
    expectedOwnerScopeWorkFenceEpoch: root.work_fence_epoch,
    nowMs: nowMs + 4,
  });
  return { ownerId: owner.id, childScopeId: materialized.scopeId };
}

function seedAppliedEffect(
  fixture: G6MapFixture,
  scopeId: string,
  label: string,
  nowMs: number,
): string {
  const node = fixture.instance.store.queryOne<{ id: string }>(
    `SELECT id FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ?
      ORDER BY id COLLATE BINARY LIMIT 1`,
    [fixture.graphRunId, scopeId],
  )!;
  const attemptId = `attempt:g6:${label}`;
  const effectId = `effect:g6:${label}`;
  const value = fixture.seed.values.context!;
  fixture.instance.store.withImmediateTransaction((transaction) => {
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
       ) VALUES (?, ?, ?, ?, 1, 'initial', NULL, NULL, 'terminal', 'succeeded',
         'pass', '{}', NULL, NULL, '[]', ?, ?, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'fenced', 0, 0, ?, NULL,
         NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 1, ?, ?, ?)`,
      [
        attemptId,
        fixture.graphRunId,
        scopeId,
        node.id,
        value.id,
        value.hash,
        `reservation-group:g6:${label}`,
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', NULL, 'mutable_fixture',
         'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'worker:g6',
         'lease:g6', ?, 1, ?, ?)`,
      [
        effectId,
        fixture.graphRunId,
        scopeId,
        node.id,
        attemptId,
        `operation:g6:${label}`,
        canonicalJson({ type: 'attempt' }),
        g6Hash(`effect-key-strategy:${label}`),
        value.id,
        value.hash,
        value.id,
        value.hash,
        value.id,
        value.hash,
        value.id,
        value.hash,
        value.id,
        value.hash,
        nowMs + 100,
        nowMs,
        nowMs,
      ],
    );
  });
  return effectId;
}

function settleCompensation(
  fixture: G6MapFixture,
  effectId: string,
  nowMs: number,
): void {
  const value = fixture.seed.values.context!;
  fixture.instance.store.withImmediateTransaction((transaction) => {
    expect(
      transaction.execute(
        `UPDATE workflow_graph_effect_operations
            SET status = 'compensated', compensation_value_id = ?,
                compensation_hash = ?, row_version = row_version + 1,
                updated_at_ms = ?
          WHERE id = ? AND status = 'compensation_pending'`,
        [value.id, value.hash, nowMs, effectId],
      ).changes,
    ).toBe(1);
  });
}

function completeChildNormally(
  fixture: G6MapFixture,
  childScopeId: string,
  nowMs: number,
): void {
  initializeScopeFixedPointT3a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: childScopeId,
    expectedRunRowVersion: currentRun(fixture).row_version,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs,
  });
  const terminal = fixture.instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    `SELECT id, row_version, activation_event_seq
       FROM workflow_graph_nodes
      WHERE graph_run_id = ? AND scope_id = ? AND node_type = 'terminal'`,
    [fixture.graphRunId, childScopeId],
  )!;
  const scope = currentScope(fixture, childScopeId);
  scheduleReadyNodeT4(
    fixture.instance.store,
    { current: () => ({}) as never },
    {
      graphRunId: fixture.graphRunId,
      scopeId: childScopeId,
      nodeId: terminal.id,
      expectedNodeRowVersion: terminal.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedScopeWorkFenceEpoch: scope.work_fence_epoch,
      eligibleEventSeq: terminal.activation_event_seq,
      activation: { kind: 'structural' },
      nowMs: nowMs + 1,
    },
  );
  const output = fixture.instance.store.queryOne<{
    id: string;
    hash: Sha256Hash;
  }>(
    `SELECT published_output_envelope_value_id AS id,
            published_output_envelope_hash AS hash
       FROM workflow_graph_nodes WHERE id = ?`,
    [terminal.id],
  )!;
  reconcileFactT3a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: childScopeId,
    expectedRunRowVersion: currentRun(fixture).row_version,
    factKind: 'node_terminal',
    stableObjectKind: 'node',
    stableObjectId: terminal.id,
    factKey: `g6-child-terminal:${terminal.id}`,
    payload: output,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    terminalStatus: 'succeeded',
    nowMs: nowMs + 2,
  });
  const settledScope = currentScope(fixture, childScopeId);
  requestSettledCloseT3b(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: childScopeId,
    expectedRunRowVersion: currentRun(fixture).row_version,
    expectedScopeRowVersion: settledScope.row_version,
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs: nowMs + 3,
  });
}

function prepareRequiredSchedule(
  fixture: G6MapFixture,
  transitionEffectId: string,
  nowMs: number,
) {
  const runBeforeClose = currentRun(fixture);
  const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
  const close = requestScopeCloseT7a(fixture.instance.store, {
    graphRunId: fixture.graphRunId,
    scopeId: fixture.rootScopeId,
    expectedRunRowVersion: runBeforeClose.row_version,
    expectedScopeRowVersion: rootBeforeClose.row_version,
    expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
    expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
    cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
    manifestSchema: fixture.seed.refs.fenceManifestSchema!,
    nowMs,
  });
  const workflow = fixture.instance.store.queryOne<{
    state_instance_id: string;
    root_workflow_id: string;
    ownership_hash: Sha256Hash;
    row_version: number;
  }>(
    `SELECT state_instance_id, root_workflow_id, ownership_hash, row_version
       FROM workflows WHERE id = ?`,
    [fixture.workflowId],
  )!;
  const creationDomain = `parent_workflow_lineage:${workflow.root_workflow_id}`;
  const creationKey = domainSeparatedSha256(
    'icarus:child-workflow-creation-key:1\n',
    {
      parent_workflow_id: fixture.workflowId,
      source_state_instance_id: workflow.state_instance_id,
      source_close_request_id: close.closeRequestId,
      transition_effect_id: transitionEffectId,
    },
  );
  const creationIntentHash = calculateCreationIntentHash({
    creationDomain,
    creationKey,
    principalRef: 'human:local-owner',
    ownershipHash: workflow.ownership_hash,
    routingScope: fixture.seed.refs.routingScope!,
    recipe: fixture.seed.refs.recipe!,
    entryPoint: 'default',
    inputHash: fixture.seed.values.childInput!.hash,
    attachmentManifestHash: fixture.seed.values.attachments!.hash,
  });
  const prepared = prepareRequiredFinalizationT0p(fixture.instance.store, {
    workflowId: fixture.workflowId,
    sourceStateInstanceId: workflow.state_instance_id,
    sourceRunId: fixture.graphRunId,
    rootScopeId: fixture.rootScopeId,
    closeRequestId: close.closeRequestId,
    transitionEffectId,
    recipe: fixture.seed.refs.recipe!,
    definition: fixture.seed.refs.definition!,
    executionPolicy: fixture.seed.refs.executionPolicy!,
    routingScope: fixture.seed.refs.routingScope!,
    finalizationPolicy: fixture.seed.refs.finalizationPolicy!,
    principalRef: 'human:local-owner',
    principalHash: g6Hash('principal'),
    input: fixture.seed.values.childInput!,
    attachments: fixture.seed.values.attachments!,
    routingDecision: fixture.seed.values.routing!,
    creationIntentHash,
    runtimeSafetyHash: fixture.seed.values.safety!.hash,
    maxAttempts: 3,
    deadlineAtMs: nowMs + 100,
    nowMs: nowMs + 1,
  });
  return { close, workflow, prepared };
}

describe('G6 dynamic materialization and close', () => {
  it('materializes and publishes exact subgraph and expand child completion', () => {
    for (const [index, mode] of (['subgraph', 'expand'] as const).entries()) {
      const fixture = createG6MapFixture(`single-${mode}`, {
        dynamicMode: mode,
      });
      fixtures.push(fixture);
      const nowMs = 100 + index * 100;
      const dynamic = materializeSingleDynamicChild(fixture, mode, nowMs);
      completeChildNormally(fixture, dynamic.childScopeId, nowMs + 10);
      const child = currentScope(fixture, dynamic.childScopeId);
      const parent = currentScope(fixture, fixture.rootScopeId);
      const owner = currentNode(fixture, dynamic.ownerId);
      const finalized = finalizeChildScopeT7b(fixture.instance.store, {
        graphRunId: fixture.graphRunId,
        childScopeId: dynamic.childScopeId,
        expectedChildScopeRowVersion: child.row_version,
        expectedParentScopeRowVersion: parent.row_version,
        expectedOwnerNodeRowVersion: owner.row_version,
        expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
        expectedParentScopeWorkFenceEpoch: parent.work_fence_epoch,
        fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
        mapItemResultsManifestSchema:
          fixture.seed.refs.mapItemResultsManifestSchema!,
        nowMs: nowMs + 20,
      });
      expect(finalized).toMatchObject({
        disposition: 'consumed',
        parentDisposition: 'owner_output_published',
        ownerTerminal: true,
      });
      expect(currentNode(fixture, dynamic.ownerId)).toMatchObject({
        phase: 'terminal',
        controller_state: 'settled',
      });
      expect(
        fixture.instance.store.queryOne<{ count: number }>(
          `SELECT count(*) AS count
             FROM workflow_graph_child_completion_consumptions
            WHERE graph_run_id = ? AND child_scope_id = ?
              AND disposition = 'owner_output_published'`,
          [fixture.graphRunId, dynamic.childScopeId],
        )!.count,
      ).toBe(1);
      fixture.instance.closeStore();
      fixture.instance.reopenStore();
      expect(
        finalizeChildScopeT7b(fixture.instance.store, {
          graphRunId: fixture.graphRunId,
          childScopeId: dynamic.childScopeId,
          expectedChildScopeRowVersion: child.row_version,
          expectedParentScopeRowVersion: parent.row_version,
          expectedOwnerNodeRowVersion: owner.row_version,
          expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
          expectedParentScopeWorkFenceEpoch: parent.work_fence_epoch,
          fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
          mapItemResultsManifestSchema:
            fixture.seed.refs.mapItemResultsManifestSchema!,
          nowMs: nowMs + 20,
        }).disposition,
      ).toBe('exact_replay');
    }
  });

  it('preserves a child close when its ancestor fences publication', () => {
    const fixture = createG6MapFixture('ancestor-preserves-child-close', {
      dynamicMode: 'subgraph',
    });
    fixtures.push(fixture);
    const dynamic = materializeSingleDynamicChild(fixture, 'subgraph', 250);
    completeChildNormally(fixture, dynamic.childScopeId, 260);
    const childClose = fixture.instance.store.queryOne<{
      id: string;
      reason: string;
      selected_rule_id: string | null;
      candidate_id: string | null;
      request_hash: Sha256Hash;
    }>(
      `SELECT id, reason, selected_rule_id, candidate_id, request_hash
         FROM workflow_graph_scope_close_requests
        WHERE graph_run_id = ? AND scope_id = ?`,
      [fixture.graphRunId, dynamic.childScopeId],
    )!;
    expect(childClose).toMatchObject({
      reason: 'normal',
      selected_rule_id: 'select_done',
    });

    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const ancestorClose = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: run.row_version,
      expectedScopeRowVersion: root.row_version,
      expectedRunWorkFenceEpoch: run.work_fence_epoch,
      expectedScopeWorkFenceEpoch: root.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'ancestor_failure' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 270,
    });
    expect(ancestorClose.fencedScopeIds).toEqual(
      [dynamic.childScopeId, fixture.rootScopeId].sort(),
    );
    expect(ancestorClose.createdDescendantRequestIds).toEqual([]);
    expect(
      fixture.instance.store.queryOne<typeof childClose>(
        `SELECT id, reason, selected_rule_id, candidate_id, request_hash
           FROM workflow_graph_scope_close_requests
          WHERE graph_run_id = ? AND scope_id = ?`,
        [fixture.graphRunId, dynamic.childScopeId],
      ),
    ).toEqual(childClose);

    const child = currentScope(fixture, dynamic.childScopeId);
    const fencedRoot = currentScope(fixture, fixture.rootScopeId);
    const owner = currentNode(fixture, dynamic.ownerId);
    const finalized = finalizeChildScopeT7b(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      childScopeId: dynamic.childScopeId,
      expectedChildScopeRowVersion: child.row_version,
      expectedParentScopeRowVersion: fencedRoot.row_version,
      expectedOwnerNodeRowVersion: owner.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: fencedRoot.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 271,
    });
    expect(finalized).toMatchObject({
      disposition: 'consumed',
      parentDisposition: 'non_publish_parent_fenced',
      ownerTerminal: false,
    });
    fixture.instance.closeStore();
    fixture.instance.reopenStore();
    expect(
      fixture.instance.store.queryOne<{
        close_request_id: string;
        disposition: string;
      }>(
        `SELECT child.close_request_id, consumed.disposition
           FROM workflow_graph_scopes child
           JOIN workflow_graph_child_completion_consumptions consumed
             ON consumed.graph_run_id = child.graph_run_id
            AND consumed.child_scope_id = child.id
          WHERE child.graph_run_id = ? AND child.id = ?`,
        [fixture.graphRunId, dynamic.childScopeId],
      ),
    ).toEqual({
      close_request_id: childClose.id,
      disposition: 'non_publish_parent_fenced',
    });
  });

  it('holds child and root Cuts behind successful compensation', () => {
    const childFixture = createG6MapFixture('child-compensation');
    fixtures.push(childFixture);
    const dynamic = materializeMapChildren(
      childFixture,
      { type: 'all_settled', child_error: 'record' },
      ['compensate'],
      300,
    );
    const childScopeId = dynamic.childScopeIds[0]!;
    const childEffectId = seedAppliedEffect(
      childFixture,
      childScopeId,
      'child-compensation',
      310,
    );
    const childBeforeClose = currentScope(childFixture, childScopeId);
    requestScopeCloseT7a(childFixture.instance.store, {
      graphRunId: childFixture.graphRunId,
      scopeId: childScopeId,
      expectedRunRowVersion: currentRun(childFixture).row_version,
      expectedScopeRowVersion: childBeforeClose.row_version,
      expectedRunWorkFenceEpoch: currentRun(childFixture).work_fence_epoch,
      expectedScopeWorkFenceEpoch: childBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'compensation_required' },
      manifestSchema: childFixture.seed.refs.fenceManifestSchema!,
      nowMs: 311,
    });
    expect(
      childFixture.instance.store.queryOne<{
        execution_lane: string;
        status: string;
        lease_owner: string | null;
      }>(
        `SELECT execution_lane, status, lease_owner
           FROM workflow_graph_effect_operations WHERE id = ?`,
        [childEffectId],
      ),
    ).toEqual({
      execution_lane: 'close_cleanup',
      status: 'compensation_pending',
      lease_owner: null,
    });
    const child = currentScope(childFixture, childScopeId);
    const parent = currentScope(childFixture, childFixture.rootScopeId);
    const owner = currentNode(childFixture, dynamic.ownerId);
    const finalizeInput: Parameters<typeof finalizeChildScopeT7b>[1] = {
      graphRunId: childFixture.graphRunId,
      childScopeId,
      expectedChildScopeRowVersion: child.row_version,
      expectedParentScopeRowVersion: parent.row_version,
      expectedOwnerNodeRowVersion: owner.row_version,
      expectedRunWorkFenceEpoch: currentRun(childFixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: parent.work_fence_epoch,
      fenceManifestSchema: childFixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        childFixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 312,
    };
    expect(() =>
      finalizeChildScopeT7b(childFixture.instance.store, finalizeInput),
    ).toThrow(/compensation barrier/);
    expect(
      childFixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_graph_completion_cuts
          WHERE graph_run_id = ? AND scope_id = ?`,
        [childFixture.graphRunId, childScopeId],
      )!.count,
    ).toBe(0);
    settleCompensation(childFixture, childEffectId, 313);
    expect(
      finalizeChildScopeT7b(childFixture.instance.store, finalizeInput)
        .disposition,
    ).toBe('consumed');

    const rootFixture = createG6MapFixture('root-compensation');
    fixtures.push(rootFixture);
    const rootEffectId = seedAppliedEffect(
      rootFixture,
      rootFixture.rootScopeId,
      'root-compensation',
      400,
    );
    const runBeforeRootClose = currentRun(rootFixture);
    const rootBeforeClose = currentScope(rootFixture, rootFixture.rootScopeId);
    const close = requestScopeCloseT7a(rootFixture.instance.store, {
      graphRunId: rootFixture.graphRunId,
      scopeId: rootFixture.rootScopeId,
      expectedRunRowVersion: runBeforeRootClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeRootClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
      manifestSchema: rootFixture.seed.refs.fenceManifestSchema!,
      nowMs: 401,
    });
    const workflow = rootFixture.instance.store.queryOne<{
      state_instance_id: string;
      row_version: number;
    }>('SELECT state_instance_id, row_version FROM workflows WHERE id = ?', [
      rootFixture.workflowId,
    ])!;
    const activation = rootFixture.instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_state_activations WHERE id = ?', [
      workflow.state_instance_id,
    ])!;
    const run = currentRun(rootFixture);
    const root = currentScope(rootFixture, rootFixture.rootScopeId);
    const t8Input: Parameters<typeof commitRootT8>[1] = {
      workflowId: rootFixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: rootFixture.graphRunId,
      rootScopeId: rootFixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'on_error',
      target: {
        kind: 'terminal',
        stateKey: 'failed',
        terminalKind: 'errored',
        definition: rootFixture.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: rootFixture.seed.values.stateConfig!,
        output: null,
        outputSchemaHash: null,
        errorCode: 'root_fixture_error',
        errorDetail: null,
      },
      contextValueSchema: rootFixture.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs: 402,
    };
    expect(() => commitRootT8(rootFixture.instance.store, t8Input)).toThrow(
      /compensation/,
    );
    expect(
      rootFixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_completion_cuts WHERE graph_run_id = ?',
        [rootFixture.graphRunId],
      )!.count,
    ).toBe(0);
    settleCompensation(rootFixture, rootEffectId, 403);
    expect(commitRootT8(rootFixture.instance.store, t8Input).disposition).toBe(
      'committed',
    );
  });

  it('terminalizes empty Maps and fails an impossible empty quorum', () => {
    const settledPolicy: JsonObject = {
      type: 'all_settled',
      child_error: 'record',
    };
    const settled = createG6MapFixture('map-empty-settled', {
      mapCompletionPolicy: settledPolicy,
    });
    fixtures.push(settled);
    const settledOwner = materializeMapChildren(
      settled,
      settledPolicy,
      [],
      450,
    ).ownerId;
    expect(
      settled.instance.store.queryOne<{
        phase: string;
        terminal_status: string;
        controller_state: string;
        controller_remaining_count: number;
        published_output_envelope_value_id: string;
        controller_decision_json: string;
      }>(
        `SELECT phase, terminal_status, controller_state,
                controller_remaining_count,
                published_output_envelope_value_id,
                controller_decision_json
           FROM workflow_graph_nodes WHERE id = ?`,
        [settledOwner],
      ),
    ).toMatchObject({
      phase: 'terminal',
      terminal_status: 'succeeded',
      controller_state: 'settled',
      controller_remaining_count: 0,
      published_output_envelope_value_id: expect.any(String),
      controller_decision_json: expect.any(String),
    });
    const emptyItems = settled.instance.store.queryOne<{
      inline_canonical_json: string;
    }>(
      `SELECT inline_canonical_json FROM workflow_values
        WHERE provenance_ref = ?`,
      [`t4:${settledOwner}:empty-map-item-results`],
    )!;
    expect(JSON.parse(emptyItems.inline_canonical_json)).toEqual({
      items: [],
      manifest_hash: runtimeObjectHash('map-item-results', []),
    });

    const quorumPolicy: JsonObject = {
      type: 'quorum',
      accepted_exits: ['done'],
      min_accepted: 1,
      on_reached: 'cancel_remaining',
      on_impossible: 'fail_node',
    };
    const quorum = createG6MapFixture('map-empty-quorum', {
      mapCompletionPolicy: quorumPolicy,
    });
    fixtures.push(quorum);
    const quorumOwner = materializeMapChildren(
      quorum,
      quorumPolicy,
      [],
      470,
    ).ownerId;
    expect(
      quorum.instance.store.queryOne<{
        phase: string;
        terminal_status: string;
        terminal_code: string;
        published_output_envelope_value_id: string | null;
      }>(
        `SELECT phase, terminal_status, terminal_code,
                published_output_envelope_value_id
           FROM workflow_graph_nodes WHERE id = ?`,
        [quorumOwner],
      ),
    ).toEqual({
      phase: 'terminal',
      terminal_status: 'failed',
      terminal_code: 'quorum_impossible',
      published_output_envelope_value_id: null,
    });
  });

  it('records Map build failures and reevaluates completion atomically', () => {
    const settledPolicy: JsonObject = {
      type: 'all_settled',
      child_error: 'record',
    };
    const settled = createG6MapFixture('map-build-failure-settled', {
      mapCompletionPolicy: settledPolicy,
    });
    fixtures.push(settled);
    const sealedSettled = materializeMapChildren(
      settled,
      settledPolicy,
      ['broken'],
      490,
      false,
    );
    const settledRun = currentRun(settled);
    const settledRoot = currentScope(settled, settled.rootScopeId);
    const settledOwner = currentNode(settled, sealedSettled.ownerId);
    const settledFailureInput: Parameters<
      typeof recordDynamicBuildFailureT2a
    >[1] = {
      graphRunId: settled.graphRunId,
      buildId: sealedSettled.buildIds[0]!,
      expectedBuildRowVersion: 1,
      expectedRunRowVersion: settledRun.row_version,
      expectedOwnerScopeRowVersion: settledRoot.row_version,
      expectedOwnerNodeRowVersion: settledOwner.row_version,
      expectedRunWorkFenceEpoch: settledRun.work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: settledRoot.work_fence_epoch,
      errorCode: 'child_compile_error',
      errorDetail: settled.seed.values.context!,
      fenceManifestSchema: settled.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        settled.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 493,
    };
    expect(
      recordDynamicBuildFailureT2a(settled.instance.store, settledFailureInput),
    ).toMatchObject({
      disposition: 'failed',
      ownerTerminal: true,
      mapSlotId: expect.any(String),
    });
    expect(
      recordDynamicBuildFailureT2a(settled.instance.store, settledFailureInput)
        .disposition,
    ).toBe('exact_replay');
    expect(
      settled.instance.store.queryOne<{
        build_status: string;
        outcome_state: string;
        scope_id: string | null;
        phase: string;
        terminal_status: string;
        published_output_envelope_value_id: string;
      }>(
        `SELECT b.status AS build_status, slot.outcome_state, slot.scope_id,
                owner.phase, owner.terminal_status,
                owner.published_output_envelope_value_id
           FROM workflow_graph_scope_builds b
           JOIN workflow_graph_map_item_results slot ON slot.build_id = b.id
           JOIN workflow_graph_nodes owner ON owner.id = b.owner_node_id
          WHERE b.id = ?`,
        [sealedSettled.buildIds[0]],
      ),
    ).toMatchObject({
      build_status: 'failed',
      outcome_state: 'errored',
      scope_id: null,
      phase: 'terminal',
      terminal_status: 'succeeded',
      published_output_envelope_value_id: expect.any(String),
    });

    const quorumPolicy: JsonObject = {
      type: 'quorum',
      accepted_exits: ['done'],
      min_accepted: 2,
      on_reached: 'cancel_remaining',
      on_impossible: 'fail_node',
    };
    const quorum = createG6MapFixture('map-build-failure-quorum', {
      mapCompletionPolicy: quorumPolicy,
    });
    fixtures.push(quorum);
    const sealedQuorum = materializeMapChildren(
      quorum,
      quorumPolicy,
      ['broken', 'remainder'],
      500,
      false,
    );
    const quorumRun = currentRun(quorum);
    const quorumRoot = currentScope(quorum, quorum.rootScopeId);
    const quorumOwner = currentNode(quorum, sealedQuorum.ownerId);
    const quorumFailureInput: Parameters<
      typeof recordDynamicBuildFailureT2a
    >[1] = {
      graphRunId: quorum.graphRunId,
      buildId: sealedQuorum.buildIds[0]!,
      expectedBuildRowVersion: 1,
      expectedRunRowVersion: quorumRun.row_version,
      expectedOwnerScopeRowVersion: quorumRoot.row_version,
      expectedOwnerNodeRowVersion: quorumOwner.row_version,
      expectedRunWorkFenceEpoch: quorumRun.work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: quorumRoot.work_fence_epoch,
      errorCode: 'child_compile_error',
      errorDetail: quorum.seed.values.context!,
      fenceManifestSchema: quorum.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        quorum.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 503,
    };
    expect(() =>
      recordDynamicBuildFailureT2a(quorum.instance.store, quorumFailureInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(
      quorum.instance.store.queryOne<{
        status: string;
        outcome_state: string;
      }>(
        `SELECT b.status, slot.outcome_state
           FROM workflow_graph_scope_builds b
           JOIN workflow_graph_map_item_results slot ON slot.build_id = b.id
          WHERE b.id = ?`,
        [sealedQuorum.buildIds[0]],
      ),
    ).toEqual({ status: 'compiled', outcome_state: 'open' });
    expect(
      recordDynamicBuildFailureT2a(quorum.instance.store, quorumFailureInput),
    ).toMatchObject({ disposition: 'failed', ownerTerminal: true });
    expect(
      quorum.instance.store.queryAll<{
        item_index: number;
        outcome_state: string;
        scope_id: string | null;
      }>(
        `SELECT item_index, outcome_state, scope_id
           FROM workflow_graph_map_item_results
          WHERE owner_node_id = ? ORDER BY item_index`,
        [sealedQuorum.ownerId],
      ),
    ).toEqual([
      { item_index: 0, outcome_state: 'errored', scope_id: null },
      { item_index: 1, outcome_state: 'fenced', scope_id: null },
    ]);
    expect(
      quorum.instance.store.queryOne<{
        phase: string;
        terminal_status: string;
        terminal_code: string;
      }>(
        'SELECT phase, terminal_status, terminal_code FROM workflow_graph_nodes WHERE id = ?',
        [sealedQuorum.ownerId],
      ),
    ).toEqual({
      phase: 'terminal',
      terminal_status: 'failed',
      terminal_code: 'quorum_impossible',
    });
  });

  it('rolls back stale T7a and rejects replay manifest tamper', () => {
    const rollback = createG6MapFixture('t7a-rollback');
    fixtures.push(rollback);
    const rollbackRun = currentRun(rollback);
    const rollbackRoot = currentScope(rollback, rollback.rootScopeId);
    const rollbackInput: Parameters<typeof requestScopeCloseT7a>[1] = {
      graphRunId: rollback.graphRunId,
      scopeId: rollback.rootScopeId,
      expectedRunRowVersion: rollbackRun.row_version,
      expectedScopeRowVersion: rollbackRoot.row_version,
      expectedRunWorkFenceEpoch: rollbackRun.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rollbackRoot.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'fixture_failure' },
      manifestSchema: rollback.seed.refs.fenceManifestSchema!,
      nowMs: 480,
    };
    expect(() =>
      requestScopeCloseT7a(rollback.instance.store, rollbackInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(
      rollback.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count
           FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?`,
        [rollback.graphRunId],
      )!.count,
    ).toBe(0);
    expect(() =>
      requestScopeCloseT7a(rollback.instance.store, {
        ...rollbackInput,
        expectedRunRowVersion: rollbackRun.row_version + 1,
      }),
    ).toThrow(/stale/);
    expect(
      requestScopeCloseT7a(rollback.instance.store, rollbackInput).disposition,
    ).toBe('close_requested');
    expect(
      requestScopeCloseT7a(rollback.instance.store, rollbackInput).disposition,
    ).toBe('exact_replay');
    expect(() =>
      requestScopeCloseT7a(rollback.instance.store, {
        ...rollbackInput,
        cause: { reason: 'engine_error', errorCode: 'different_failure' },
      }),
    ).toThrow(/replay close cause/);
    const manifestValue = rollback.instance.store.queryOne<{ id: string }>(
      `SELECT scope_epochs_manifest_value_id AS id
         FROM workflow_graph_subtree_fence_manifests
        WHERE graph_run_id = ?`,
      [rollback.graphRunId],
    )!;
    rollback.instance.store.withImmediateTransaction((transaction) => {
      expect(
        transaction.execute(
          `UPDATE workflow_values SET inline_canonical_json = '[]'
            WHERE id = ?`,
          [manifestValue.id],
        ).changes,
      ).toBe(1);
    });
    expect(() =>
      requestScopeCloseT7a(rollback.instance.store, rollbackInput),
    ).toThrow(/manifest Value bytes\/hash drifted/);
  });

  it('commits best-effort child delivery without blocking terminal T8', () => {
    const effectId = 'effect:best-effort-child';
    const fixture = createG6MapFixture('root-t8-best-effort', {
      errorTransitionEffects: [
        {
          id: effectId,
          type: 'start_child_workflow',
          delivery_requirement: 'best_effort',
        },
      ],
    });
    fixtures.push(fixture);
    const runBeforeClose = currentRun(fixture);
    const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
    const close = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 700,
    });
    const workflow = fixture.instance.store.queryOne<{
      state_instance_id: string;
      row_version: number;
    }>('SELECT state_instance_id, row_version FROM workflows WHERE id = ?', [
      fixture.workflowId,
    ])!;
    const activation = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_state_activations WHERE id = ?',
      [workflow.state_instance_id],
    )!;
    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const committed = commitRootT8(fixture.instance.store, {
      workflowId: fixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'on_error',
      target: {
        kind: 'terminal',
        stateKey: 'failed',
        definition: fixture.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: fixture.seed.values.stateConfig!,
        terminalKind: 'errored',
        output: null,
        outputSchemaHash: null,
        errorCode: 'root_fixture_error',
        errorDetail: null,
      },
      contextValueSchema: fixture.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [
        {
          transitionEffectId: effectId,
          effectType: 'best_effort_child_creation',
          adapter: fixture.seed.refs.outboxAdapter!,
          deliveryPolicy: fixture.seed.refs.outboxPolicy!,
          policySnapshot: fixture.seed.values.context!,
          payload: fixture.seed.values.childInput!,
          nextAttemptAtMs: 702,
          deadlineAtMs: 750,
        },
      ],
      nowMs: 701,
    });
    expect(committed.disposition).toBe('committed');
    expect(
      fixture.instance.store.queryOne<{
        effect_key: string;
        delivery_requirement: string;
        status: string;
      }>(
        `SELECT effect_key, delivery_requirement, status
           FROM workflow_outbox WHERE workflow_id = ?`,
        [fixture.workflowId],
      ),
    ).toEqual({
      effect_key: `workflow-transition:${close.closeRequestId}:${effectId}`,
      delivery_requirement: 'best_effort',
      status: 'pending',
    });
  });

  it('commits workflow cancel without Definition route fallback', () => {
    const fixture = createG6MapFixture('root-t8-global-cancel');
    fixtures.push(fixture);
    fixture.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_runs
            SET control = 'cancelling', root_cancel_scope = 'workflow',
                row_version = row_version + 1
          WHERE id = ?`,
        [fixture.graphRunId],
      );
    });
    const runBeforeClose = currentRun(fixture);
    const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
    const close = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: {
        reason: 'workflow_cancel',
        cancelPayload: { reason: 'user_cancelled' },
      },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 800,
    });
    const workflow = fixture.instance.store.queryOne<{
      state_instance_id: string;
      row_version: number;
    }>('SELECT state_instance_id, row_version FROM workflows WHERE id = ?', [
      fixture.workflowId,
    ])!;
    const activation = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_state_activations WHERE id = ?',
      [workflow.state_instance_id],
    )!;
    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const committed = commitRootT8(fixture.instance.store, {
      workflowId: fixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'workflow_cancel',
      target: { kind: 'global_cancel' },
      contextValueSchema: fixture.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs: 801,
    });
    expect(committed.targetActivation).toBeNull();
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        final_outcome_kind: string;
        final_cancel_reason: string;
        current_graph_run_id: string | null;
      }>(
        `SELECT status, final_outcome_kind, final_cancel_reason,
                current_graph_run_id
           FROM workflows WHERE id = ?`,
        [fixture.workflowId],
      ),
    ).toEqual({
      status: 'cancelled',
      final_outcome_kind: 'cancelled',
      final_cancel_reason: 'workflow_cancel',
      current_graph_run_id: null,
    });
  });

  it('reuses T1 core for a nonterminal T8 with one combined checkpoint', () => {
    const fixture = createG6MapFixture('root-t8-nonterminal', {
      errorTargetKind: 'graph',
    });
    fixtures.push(fixture);
    const runBeforeClose = currentRun(fixture);
    const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
    const close = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 900,
    });
    const workflow = fixture.instance.store.queryOne<{
      state_instance_id: string;
      row_version: number;
    }>('SELECT state_instance_id, row_version FROM workflows WHERE id = ?', [
      fixture.workflowId,
    ])!;
    const activation = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_state_activations WHERE id = ?',
      [workflow.state_instance_id],
    )!;
    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const committed = commitRootT8(fixture.instance.store, {
      workflowId: fixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'on_error',
      target: {
        kind: 'nonterminal',
        stateKey: 'next',
        activation: {
          stateType: 'graph',
          definition: fixture.seed.refs.definition!,
          definitionVersion: '1.0.0',
          stateConfig: fixture.seed.values.stateConfig!,
          registrySnapshotId: fixture.seed.snapshotId,
          registrySnapshotHash: fixture.seed.snapshotHash,
          closureManifestId: fixture.seed.closureId,
          closureHash: fixture.seed.closureHash,
          runtimeSafetySnapshot: fixture.seed.values.safety!,
          runtimeSupportedLimits: fixture.seed.refs.supportedLimits!,
          sqliteExecutionProfile: fixture.seed.refs.sqliteProfile!,
          compilerToolchain: fixture.seed.refs.compilerToolchain!,
          coreReleaseRef: 'icarus.core@1.0.0',
          coreReleaseHash: g6Hash('core-release'),
          coreBuildHash: fixture.plan.compiler_build_hash as Sha256Hash,
          databaseSchemaHash: fixture.instance.store.frozenInputs.schemaHash,
          sourceSeedHash: fixture.plan.source_hash as Sha256Hash,
          compilerSnapshotHash: g6Hash('compiler-snapshot'),
          inputSnapshot: fixture.seed.values.input!,
          runResourceLimits: {
            scopes_total: 32,
            nodes_total: 64,
            edges_total: 64,
            map_items_total: 32,
            builds_total: 32,
            build_attempts_total: 32,
            attempts_total: 32,
            waits_total: 32,
            effect_operations_total: 32,
            facts_total: 256,
            active_waits: 8,
            active_executions: 8,
          },
          checkpoint: { status: 'transition-current' },
          nowMs: 901,
        },
      },
      contextValueSchema: fixture.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs: 901,
    });
    expect(committed.targetActivation?.graphRunId).not.toBe(fixture.graphRunId);
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        state_key: string;
        current_graph_run_id: string;
      }>(
        `SELECT w.status, a.state_key, w.current_graph_run_id
           FROM workflows w JOIN workflow_state_activations a
             ON a.id = w.state_instance_id
          WHERE w.id = ?`,
        [fixture.workflowId],
      ),
    ).toEqual({
      status: 'active',
      state_key: 'next',
      current_graph_run_id: committed.targetActivation!.graphRunId,
    });
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_checkpoints WHERE workflow_id = ?',
        [fixture.workflowId],
      )?.count,
    ).toBe(2);
  });

  it('retries and exhausts Root Finalization with rollback-safe evidence', () => {
    const transitionEffectId = 'effect:preflight-exhaustion';
    const fixture = createG6MapFixture('root-finalizer-exhaustion', {
      errorTransitionEffects: [
        {
          id: transitionEffectId,
          type: 'start_child_workflow',
          delivery_requirement: 'required',
        },
      ],
    });
    fixtures.push(fixture);
    const setup = prepareRequiredSchedule(fixture, transitionEffectId, 300);
    const retryInput: Parameters<typeof recordRootFinalizationAttempt>[1] = {
      scheduleId: setup.prepared.scheduleId,
      expectedScheduleRowVersion: 1,
      frozenResolution: fixture.seed.values.routing!,
      claimPreflight: fixture.seed.values.context!,
      result: 'retryable_conflict',
      errorCode: 'claim_conflict',
      errorDetail: fixture.seed.values.context!,
      nextEligibleAtMs: 320,
      exhaustionEvidence: fixture.seed.values.context!,
      remediationPolicy: fixture.seed.refs.finalizationPolicy!,
      remediationDeadlineAtMs: 450,
      nowMs: 310,
    };
    expect(
      recordRootFinalizationAttempt(fixture.instance.store, retryInput),
    ).toMatchObject({ status: 'retry_wait', attemptNo: 1 });
    expect(
      recordRootFinalizationAttempt(fixture.instance.store, retryInput)
        .disposition,
    ).toBe('exact_replay');
    expect(() =>
      recordRootFinalizationAttempt(fixture.instance.store, {
        ...retryInput,
        expectedScheduleRowVersion: 2,
        nowMs: 319,
      }),
    ).toThrow(/not eligible/);
    const exhausted = recordRootFinalizationAttempt(fixture.instance.store, {
      ...retryInput,
      expectedScheduleRowVersion: 2,
      result: 'permanent_rejection',
      errorCode: 'claim_permanent_rejection',
      nextEligibleAtMs: undefined,
      nowMs: 320,
    });
    expect(exhausted).toMatchObject({ status: 'exhausted', attemptNo: 2 });
    expect(exhausted.blockerId).not.toBeNull();
    expect(
      recordRootFinalizationAttempt(fixture.instance.store, {
        ...retryInput,
        expectedScheduleRowVersion: 2,
        result: 'permanent_rejection',
        errorCode: 'claim_permanent_rejection',
        nextEligibleAtMs: undefined,
        nowMs: 320,
      }),
    ).toMatchObject({
      disposition: 'exact_replay',
      blockerId: exhausted.blockerId,
    });
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        attempt_count: number;
      }>(
        `SELECT status, attempt_count
           FROM workflow_root_finalization_schedules WHERE id = ?`,
        [setup.prepared.scheduleId],
      ),
    ).toEqual({ status: 'exhausted', attempt_count: 2 });
    expect(
      fixture.instance.store.queryOne<{
        run_state: string;
        workflow_state: string;
      }>(
        `SELECT r.operational_state AS run_state,
                w.operational_state AS workflow_state
           FROM workflow_graph_runs r JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
        [fixture.graphRunId],
      ),
    ).toEqual({
      run_state: 'action_required',
      workflow_state: 'action_required',
    });

    const rollbackEffectId = 'effect:preflight-rollback';
    const rollbackFixture = createG6MapFixture('root-finalizer-rollback', {
      errorTransitionEffects: [
        {
          id: rollbackEffectId,
          type: 'start_child_workflow',
          delivery_requirement: 'required',
        },
      ],
    });
    fixtures.push(rollbackFixture);
    const rollbackSetup = prepareRequiredSchedule(
      rollbackFixture,
      rollbackEffectId,
      500,
    );
    const readyInput: Parameters<typeof recordRootFinalizationAttempt>[1] = {
      scheduleId: rollbackSetup.prepared.scheduleId,
      expectedScheduleRowVersion: 1,
      frozenResolution: rollbackFixture.seed.values.routing!,
      claimPreflight: rollbackFixture.seed.values.context!,
      result: 'ready',
      exhaustionEvidence: rollbackFixture.seed.values.context!,
      remediationPolicy: rollbackFixture.seed.refs.finalizationPolicy!,
      remediationDeadlineAtMs: 650,
      nowMs: 510,
    };
    expect(() =>
      recordRootFinalizationAttempt(
        rollbackFixture.instance.store,
        readyInput,
        {
          point: 'before_commit',
        },
      ),
    ).toThrow(/Injected fault before commit/);
    expect(
      rollbackFixture.instance.store.queryOne<{
        status: string;
        attempt_count: number;
      }>(
        `SELECT status, attempt_count
           FROM workflow_root_finalization_schedules WHERE id = ?`,
        [rollbackSetup.prepared.scheduleId],
      ),
    ).toEqual({ status: 'pending', attempt_count: 0 });
    expect(
      rollbackFixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_root_finalization_attempts
          WHERE schedule_id = ?`,
        [rollbackSetup.prepared.scheduleId],
      )?.count,
    ).toBe(0);
    expect(
      recordRootFinalizationAttempt(rollbackFixture.instance.store, readyInput)
        .status,
    ).toBe('ready');
  });

  it('freezes a deterministic quorum winner and fences remaining work', () => {
    const policy: JsonObject = {
      type: 'quorum',
      accepted_exits: ['done'],
      min_accepted: 1,
      on_reached: 'cancel_remaining',
      on_impossible: 'fail_node',
    };
    const fixture = createG6MapFixture('map-quorum', {
      mapCompletionPolicy: policy,
    });
    fixtures.push(fixture);
    const dynamic = materializeMapChildren(
      fixture,
      policy,
      ['winner', 'loser'],
      200,
    );
    completeChildNormally(fixture, dynamic.childScopeIds[0]!, 220);
    const winnerScope = currentScope(fixture, dynamic.childScopeIds[0]!);
    const rootBeforeWinner = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeWinner = currentNode(fixture, dynamic.ownerId);
    const winner = finalizeChildScopeT7b(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      childScopeId: dynamic.childScopeIds[0]!,
      expectedChildScopeRowVersion: winnerScope.row_version,
      expectedParentScopeRowVersion: rootBeforeWinner.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeWinner.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: rootBeforeWinner.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 224,
    });
    expect(winner.parentDisposition).toBe('map_slot_completed');
    expect(winner.closedLoserScopeIds).toEqual([dynamic.childScopeIds[1]]);
    const decision = fixture.instance.store.queryOne<{
      controller_decision_json: string;
    }>(
      'SELECT controller_decision_json FROM workflow_graph_nodes WHERE id = ?',
      [dynamic.ownerId],
    )!;
    expect(JSON.parse(decision.controller_decision_json)).toMatchObject({
      succeeded: true,
      reason: 'quorum_reached',
      selected_indices: [0],
    });
    const loserScope = currentScope(fixture, dynamic.childScopeIds[1]!);
    const rootBeforeLoser = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeLoser = currentNode(fixture, dynamic.ownerId);
    const loser = finalizeChildScopeT7b(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      childScopeId: dynamic.childScopeIds[1]!,
      expectedChildScopeRowVersion: loserScope.row_version,
      expectedParentScopeRowVersion: rootBeforeLoser.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeLoser.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: rootBeforeLoser.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 225,
    });
    expect(loser.parentDisposition).toBe('map_slot_fenced');
    expect(loser.ownerTerminal).toBe(true);
    expect(
      fixture.instance.store.queryOne<{
        terminal_status: string;
        controller_state: string;
      }>(
        `SELECT terminal_status, controller_state
           FROM workflow_graph_nodes WHERE id = ?`,
        [dynamic.ownerId],
      ),
    ).toEqual({ terminal_status: 'succeeded', controller_state: 'settled' });
  });

  it('freezes fail-fast Map losers and consumes their late Cuts without publish', () => {
    const policy: JsonObject = {
      type: 'all_accepted',
      accepted_exits: ['done'],
      on_rejected: 'fail_fast',
    };
    const fixture = createG6MapFixture('map-fail-fast', {
      mapCompletionPolicy: policy,
    });
    fixtures.push(fixture);
    const dynamic = materializeMapChildren(
      fixture,
      policy,
      ['rejected', 'late'],
      100,
    );
    const firstRun = currentRun(fixture);
    const firstScope = currentScope(fixture, dynamic.childScopeIds[0]!);
    requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: dynamic.childScopeIds[0]!,
      expectedRunRowVersion: firstRun.row_version,
      expectedScopeRowVersion: firstScope.row_version,
      expectedRunWorkFenceEpoch: firstRun.work_fence_epoch,
      expectedScopeWorkFenceEpoch: firstScope.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'map_item_rejected' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 120,
    });
    const childBeforeFirstCut = currentScope(
      fixture,
      dynamic.childScopeIds[0]!,
    );
    const rootBeforeFirstCut = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeFirstCut = currentNode(fixture, dynamic.ownerId);
    const first = finalizeChildScopeT7b(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      childScopeId: dynamic.childScopeIds[0]!,
      expectedChildScopeRowVersion: childBeforeFirstCut.row_version,
      expectedParentScopeRowVersion: rootBeforeFirstCut.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeFirstCut.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: rootBeforeFirstCut.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 121,
    });
    expect(first.parentDisposition).toBe('map_slot_errored');
    expect(first.ownerTerminal).toBe(false);
    expect(first.closedLoserScopeIds).toEqual([dynamic.childScopeIds[1]]);
    expect(
      fixture.instance.store.queryAll<{
        item_index: number;
        outcome_state: string;
      }>(
        `SELECT item_index, outcome_state
           FROM workflow_graph_map_item_results
          WHERE owner_node_id = ? ORDER BY item_index`,
        [dynamic.ownerId],
      ),
    ).toEqual([
      { item_index: 0, outcome_state: 'errored' },
      { item_index: 1, outcome_state: 'fenced' },
    ]);
    const childBeforeLoserCut = currentScope(
      fixture,
      dynamic.childScopeIds[1]!,
    );
    const rootBeforeLoserCut = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeLoserCut = currentNode(fixture, dynamic.ownerId);
    const loser = finalizeChildScopeT7b(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      childScopeId: dynamic.childScopeIds[1]!,
      expectedChildScopeRowVersion: childBeforeLoserCut.row_version,
      expectedParentScopeRowVersion: rootBeforeLoserCut.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeLoserCut.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: rootBeforeLoserCut.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 122,
    });
    expect(loser.parentDisposition).toBe('map_slot_fenced');
    expect(loser.ownerTerminal).toBe(true);
    expect(
      fixture.instance.store.queryOne<{
        phase: string;
        terminal_status: string;
        controller_state: string;
      }>(
        `SELECT phase, terminal_status, controller_state
           FROM workflow_graph_nodes WHERE id = ?`,
        [dynamic.ownerId],
      ),
    ).toEqual({
      phase: 'terminal',
      terminal_status: 'failed',
      controller_state: 'settled',
    });
  });

  it('commits a finite required-child preflight and T8 lineage atomically', () => {
    const transitionEffectId = 'effect:required-child';
    const claimKeyHash = g6Hash('required-child-claim');
    const fixture = createG6MapFixture('root-t8-required-child', {
      errorTransitionEffects: [
        {
          id: transitionEffectId,
          type: 'start_child_workflow',
          delivery_requirement: 'required',
        },
      ],
      domainClaims: [
        {
          namespace: 'g6-test-resource',
          keyHash: claimKeyHash,
          mode: 'exclusive',
        },
      ],
    });
    fixtures.push(fixture);
    const runBeforeClose = currentRun(fixture);
    const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
    const close = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 30,
    });
    const workflow = fixture.instance.store.queryOne<{
      state_instance_id: string;
      root_workflow_id: string;
      ownership_hash: Sha256Hash;
      row_version: number;
    }>(
      `SELECT state_instance_id, root_workflow_id, ownership_hash, row_version
         FROM workflows WHERE id = ?`,
      [fixture.workflowId],
    )!;
    const creationDomain = `parent_workflow_lineage:${workflow.root_workflow_id}`;
    const creationKey = domainSeparatedSha256(
      'icarus:child-workflow-creation-key:1\n',
      {
        parent_workflow_id: fixture.workflowId,
        source_state_instance_id: workflow.state_instance_id,
        source_close_request_id: close.closeRequestId,
        transition_effect_id: transitionEffectId,
      },
    );
    const creationIntentHash = calculateCreationIntentHash({
      creationDomain,
      creationKey,
      principalRef: 'human:local-owner',
      ownershipHash: workflow.ownership_hash,
      routingScope: fixture.seed.refs.routingScope!,
      recipe: fixture.seed.refs.recipe!,
      entryPoint: 'default',
      inputHash: fixture.seed.values.childInput!.hash,
      attachmentManifestHash: fixture.seed.values.attachments!.hash,
    });
    const prepared = prepareRequiredFinalizationT0p(fixture.instance.store, {
      workflowId: fixture.workflowId,
      sourceStateInstanceId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      transitionEffectId,
      recipe: fixture.seed.refs.recipe!,
      definition: fixture.seed.refs.definition!,
      executionPolicy: fixture.seed.refs.executionPolicy!,
      routingScope: fixture.seed.refs.routingScope!,
      finalizationPolicy: fixture.seed.refs.finalizationPolicy!,
      principalRef: 'human:local-owner',
      principalHash: g6Hash('principal'),
      input: fixture.seed.values.childInput!,
      attachments: fixture.seed.values.attachments!,
      routingDecision: fixture.seed.values.routing!,
      creationIntentHash,
      runtimeSafetyHash: fixture.seed.values.safety!.hash,
      maxAttempts: 3,
      deadlineAtMs: 100,
      nowMs: 31,
    });
    const attemptInput: Parameters<typeof recordRootFinalizationAttempt>[1] = {
      scheduleId: prepared.scheduleId,
      expectedScheduleRowVersion: 1,
      frozenResolution: fixture.seed.values.routing!,
      claimPreflight: fixture.seed.values.context!,
      result: 'ready',
      exhaustionEvidence: fixture.seed.values.context!,
      remediationPolicy: fixture.seed.refs.finalizationPolicy!,
      remediationDeadlineAtMs: 100,
      nowMs: 32,
    };
    expect(
      recordRootFinalizationAttempt(fixture.instance.store, attemptInput)
        .status,
    ).toBe('ready');
    expect(
      recordRootFinalizationAttempt(fixture.instance.store, attemptInput)
        .disposition,
    ).toBe('exact_replay');
    const parentClaim = fixture.instance.store.queryOne<{
      id: string;
      row_version: number;
      fencing_token: number;
    }>(
      `SELECT id, row_version, fencing_token
         FROM workflow_domain_resource_claims
        WHERE owner_workflow_id = ? AND namespace = ? AND key_hash = ?
          AND status = 'held'`,
      [fixture.workflowId, 'g6-test-resource', claimKeyHash],
    )!;
    const claimHead = fixture.instance.store.queryOne<{ row_version: number }>(
      `SELECT row_version FROM workflow_domain_resource_heads
        WHERE namespace = ? AND key_hash = ?`,
      ['g6-test-resource', claimKeyHash],
    )!;
    const activation = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_state_activations WHERE id = ?',
      [workflow.state_instance_id],
    )!;
    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const input: Parameters<typeof commitRootT8>[1] = {
      workflowId: fixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'on_error',
      target: {
        kind: 'terminal',
        stateKey: 'failed',
        definition: fixture.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: fixture.seed.values.stateConfig!,
        terminalKind: 'errored',
        output: null,
        outputSchemaHash: null,
        errorCode: 'root_fixture_error',
        errorDetail: null,
      },
      contextValueSchema: fixture.seed.refs.schema!,
      requiredChildren: [
        {
          scheduleId: prepared.scheduleId,
          expectedScheduleRowVersion: 2,
          commandPolicy: fixture.seed.refs.commandPolicy!,
          inputSchema: fixture.seed.refs.inputSchema!,
          contextContract: fixture.seed.refs.contextContract!,
          contextSnapshot: fixture.seed.values.context!,
          ownershipHash: workflow.ownership_hash,
          recipeVersion: '1.0.0',
          definitionVersion: '1.0.0',
          deadlineAtMs: null,
          resourceLimits: {
            state_activations_total: 4,
            graph_runs_total: 4,
            descendant_workflows_total: 4,
          },
          initialActivation: {
            stateKey: 'run',
            stateType: 'graph',
            definition: fixture.seed.refs.definition!,
            definitionVersion: '1.0.0',
            stateConfig: fixture.seed.values.stateConfig!,
            registrySnapshotId: fixture.seed.snapshotId,
            registrySnapshotHash: fixture.seed.snapshotHash,
            closureManifestId: fixture.seed.closureId,
            closureHash: fixture.seed.closureHash,
            runtimeSafetySnapshot: fixture.seed.values.safety!,
            runtimeSupportedLimits: fixture.seed.refs.supportedLimits!,
            sqliteExecutionProfile: fixture.seed.refs.sqliteProfile!,
            compilerToolchain: fixture.seed.refs.compilerToolchain!,
            coreReleaseRef: 'icarus.core@1.0.0',
            coreReleaseHash: g6Hash('core-release'),
            coreBuildHash: fixture.plan.compiler_build_hash as Sha256Hash,
            databaseSchemaHash: fixture.instance.store.frozenInputs.schemaHash,
            sourceSeedHash: fixture.plan.source_hash as Sha256Hash,
            compilerSnapshotHash: g6Hash('compiler-snapshot'),
            inputSnapshot: fixture.seed.values.childInput!,
            runResourceLimits: {
              scopes_total: 8,
              nodes_total: 16,
              edges_total: 16,
              map_items_total: 8,
              builds_total: 8,
              build_attempts_total: 8,
              attempts_total: 8,
              waits_total: 8,
              effect_operations_total: 8,
              facts_total: 32,
              active_waits: 4,
              active_executions: 4,
            },
            checkpoint: { status: 'required-child-initial' },
            nowMs: 33,
          },
          claimHandoffs: [
            {
              parentClaimId: parentClaim.id,
              expectedParentClaimRowVersion: parentClaim.row_version,
              expectedHeadRowVersion: claimHead.row_version,
              expectedParentFencingToken: parentClaim.fencing_token,
            },
          ],
        },
      ],
      bestEffortOutbox: [],
      nowMs: 33,
    };
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        requiredChildren: input.requiredChildren.map((child) => ({
          ...child,
          claimHandoffs: child.claimHandoffs.map((handoff) => ({
            ...handoff,
            expectedParentFencingToken: handoff.expectedParentFencingToken + 1,
          })),
        })),
      }),
    ).toThrow(/Claim|claim|CAS|fencing/);
    expect(() =>
      commitRootT8(fixture.instance.store, input, { point: 'before_commit' }),
    ).toThrow(/Injected fault before commit/);
    expect(
      fixture.instance.store.queryOne<{ status: string }>(
        'SELECT status FROM workflow_domain_resource_claims WHERE id = ?',
        [parentClaim.id],
      )?.status,
    ).toBe('held');
    expect(
      fixture.instance.store.queryOne<{ status: string }>(
        'SELECT status FROM workflow_root_finalization_schedules WHERE id = ?',
        [prepared.scheduleId],
      )?.status,
    ).toBe('ready');
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_completion_cuts WHERE graph_run_id = ?',
        [fixture.graphRunId],
      )?.count,
    ).toBe(0);
    const committed = commitRootT8(fixture.instance.store, input);
    expect(committed.childWorkflowIds).toHaveLength(1);
    expect(commitRootT8(fixture.instance.store, input).disposition).toBe(
      'exact_replay',
    );
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        child_workflow_id: string;
      }>(
        `SELECT status, child_workflow_id
           FROM workflow_root_finalization_schedules WHERE id = ?`,
        [prepared.scheduleId],
      ),
    ).toEqual({
      status: 'succeeded',
      child_workflow_id: committed.childWorkflowIds[0],
    });
    expect(
      fixture.instance.store.queryOne<{ child_workflow_id: string }>(
        `SELECT child_workflow_id FROM workflow_relations
          WHERE parent_workflow_id = ? AND source_completion_cut_id = ?`,
        [fixture.workflowId, committed.completionCutId],
      )?.child_workflow_id,
    ).toBe(committed.childWorkflowIds[0]);
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        released_at_ms: number | null;
      }>(
        'SELECT status, released_at_ms FROM workflow_domain_resource_claims WHERE id = ?',
        [parentClaim.id],
      ),
    ).toEqual({ status: 'released', released_at_ms: 33 });
    const childClaim = fixture.instance.store.queryOne<{
      id: string;
      owner_workflow_id: string;
      fencing_token: number;
      status: string;
    }>(
      `SELECT id, owner_workflow_id, fencing_token, status
         FROM workflow_domain_resource_claims
        WHERE namespace = ? AND key_hash = ? AND status = 'held'`,
      ['g6-test-resource', claimKeyHash],
    )!;
    expect(childClaim).toMatchObject({
      owner_workflow_id: committed.childWorkflowIds[0],
      fencing_token: parentClaim.fencing_token + 1,
      status: 'held',
    });
    expect(
      fixture.instance.store.queryOne<{
        active_claim_id: string;
        active_claim_owner_workflow_id: string;
        active_fencing_token_identity: number;
      }>(
        `SELECT active_claim_id, active_claim_owner_workflow_id,
                active_fencing_token_identity
           FROM workflow_domain_resource_heads
          WHERE namespace = ? AND key_hash = ?`,
        ['g6-test-resource', claimKeyHash],
      ),
    ).toEqual({
      active_claim_id: childClaim.id,
      active_claim_owner_workflow_id: committed.childWorkflowIds[0],
      active_fencing_token_identity: childClaim.fencing_token,
    });
    expect(
      fixture.instance.store.queryOne<{ child_claim_id: string }>(
        `SELECT child_claim_id FROM workflow_domain_resource_claim_handoffs
          WHERE parent_claim_id = ?`,
        [parentClaim.id],
      )?.child_claim_id,
    ).toBe(childClaim.id);
    fixture.instance.closeStore();
    fixture.instance.reopenStore();
    expect(commitRootT8(fixture.instance.store, input)).toMatchObject({
      disposition: 'exact_replay',
      childWorkflowIds: committed.childWorkflowIds,
    });
  });

  it('commits, replays, and reopens an errored terminal root T8', () => {
    const fixture = createG6MapFixture('root-t8-error');
    fixtures.push(fixture);
    const runBeforeClose = currentRun(fixture);
    const rootBeforeClose = currentScope(fixture, fixture.rootScopeId);
    const close = requestScopeCloseT7a(fixture.instance.store, {
      graphRunId: fixture.graphRunId,
      scopeId: fixture.rootScopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: rootBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: rootBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'root_fixture_error' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 20,
    });
    const workflow = fixture.instance.store.queryOne<{
      state_instance_id: string;
      row_version: number;
    }>('SELECT state_instance_id, row_version FROM workflows WHERE id = ?', [
      fixture.workflowId,
    ])!;
    const activation = fixture.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_state_activations WHERE id = ?',
      [workflow.state_instance_id],
    )!;
    const run = currentRun(fixture);
    const root = currentScope(fixture, fixture.rootScopeId);
    const input: Parameters<typeof commitRootT8>[1] = {
      workflowId: fixture.workflowId,
      sourceActivationId: workflow.state_instance_id,
      sourceRunId: fixture.graphRunId,
      rootScopeId: fixture.rootScopeId,
      closeRequestId: close.closeRequestId,
      expectedWorkflowRowVersion: workflow.row_version,
      expectedSourceActivationRowVersion: activation.row_version,
      expectedSourceRunRowVersion: run.row_version,
      expectedRootScopeRowVersion: root.row_version,
      routeSource: 'on_error',
      target: {
        kind: 'terminal',
        stateKey: 'failed',
        definition: fixture.seed.refs.definition!,
        definitionVersion: '1.0.0',
        stateConfig: fixture.seed.values.stateConfig!,
        terminalKind: 'errored',
        output: null,
        outputSchemaHash: null,
        errorCode: 'root_fixture_error',
        errorDetail: null,
      },
      contextValueSchema: fixture.seed.refs.schema!,
      requiredChildren: [],
      bestEffortOutbox: [],
      nowMs: 21,
    };
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        expectedWorkflowRowVersion: input.expectedWorkflowRowVersion + 1,
      }),
    ).toThrow(/stale/);
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        routeSource: 'on_local_cancel',
      }),
    ).toThrow(/route/);
    expect(() =>
      commitRootT8(fixture.instance.store, input, { point: 'before_commit' }),
    ).toThrow(/Injected fault before commit/);
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_completion_cuts WHERE graph_run_id = ?',
        [fixture.graphRunId],
      )?.count,
    ).toBe(0);
    expect(
      fixture.instance.store.queryOne<{ status: string }>(
        'SELECT status FROM workflow_state_activations WHERE id = ?',
        [workflow.state_instance_id],
      )?.status,
    ).toBe('active');
    const committed = commitRootT8(fixture.instance.store, input);
    expect(committed.disposition).toBe('committed');
    expect(commitRootT8(fixture.instance.store, input).disposition).toBe(
      'exact_replay',
    );
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        routeSource: 'on_local_cancel',
      }),
    ).toThrow(/route/);
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        target: {
          kind: 'terminal',
          stateKey: 'cancelled',
          definition: fixture.seed.refs.definition!,
          definitionVersion: '1.0.0',
          stateConfig: fixture.seed.values.stateConfig!,
          terminalKind: 'errored',
          output: null,
          outputSchemaHash: null,
          errorCode: 'root_fixture_error',
          errorDetail: null,
        },
      }),
    ).toThrow(/target/);
    expect(() =>
      commitRootT8(fixture.instance.store, {
        ...input,
        contextValueSchema: fixture.seed.refs.inputSchema!,
      }),
    ).toThrow(/context-patch/);
    expect(
      fixture.instance.store.queryOne<{
        status: string;
        final_error_code: string | null;
        current_graph_run_id: string | null;
      }>(
        'SELECT status, final_error_code, current_graph_run_id FROM workflows WHERE id = ?',
        [fixture.workflowId],
      ),
    ).toEqual({
      status: 'errored',
      final_error_code: 'root_fixture_error',
      current_graph_run_id: null,
    });
    fixture.instance.closeStore();
    fixture.instance.reopenStore();
    expect(commitRootT8(fixture.instance.store, input).disposition).toBe(
      'exact_replay',
    );
    expect(
      fixture.instance.store.queryOne<{
        lifecycle: string;
        completion_cut_id: string;
      }>(
        'SELECT lifecycle, completion_cut_id FROM workflow_graph_runs WHERE id = ?',
        [fixture.graphRunId],
      ),
    ).toEqual({
      lifecycle: 'closed',
      completion_cut_id: committed.completionCutId,
    });
    fixture.instance.store.withImmediateTransaction((transaction) => {
      expect(
        transaction.execute(
          'UPDATE workflow_graph_completion_cuts SET cut_hash = ? WHERE id = ?',
          [g6Hash('tampered-t8-cut'), committed.completionCutId],
        ).changes,
      ).toBe(1);
    });
    expect(() => commitRootT8(fixture.instance.store, input)).toThrow(
      /completion Cut authority drifted/,
    );
  });

  it('commits and replays Map T4/T2a/T2b/T7a/T7b with exact SQLite lineage', () => {
    const fixture = createG6MapFixture('commit-replay');
    fixtures.push(fixture);
    const owner = fixture.instance.store.queryOne<{
      id: string;
      row_version: number;
      controller_state: string;
    }>(
      `SELECT id, row_version, controller_state
         FROM workflow_graph_nodes
        WHERE graph_run_id = ? AND scope_id = ? AND node_type = 'map'`,
      [fixture.graphRunId, fixture.rootScopeId],
    )!;
    expect(owner.controller_state).toBe('sealing');

    const activationSequence = currentRun(fixture).next_event_seq;
    fixture.instance.store.withImmediateTransaction((transaction) => {
      expect(
        transaction.execute(
          `UPDATE workflow_graph_nodes
              SET phase = 'ready', trigger_state = 'true', input_state = 'sealed',
                  trigger_cut_json = ?, trigger_cut_hash = ?,
                  input_snapshot_json = ?, input_snapshot_value_id = ?,
                  input_snapshot_hash = ?, activation_event_seq = ?,
                  run_work_fence_epoch_at_activation = 0,
                  scope_work_fence_epoch_at_activation = 0,
                  row_version = row_version + 1, ready_at_ms = 13,
                  updated_at_ms = 13
            WHERE id = ? AND row_version = ? AND phase = 'pending'
              AND controller_state = 'sealing'`,
          [
            canonicalJson({ root: true }),
            g6Hash('map-trigger-cut'),
            canonicalJson({ items: ['accepted'] }),
            fixture.seed.values.input!.id,
            fixture.seed.values.input!.hash,
            activationSequence,
            owner.id,
            owner.row_version,
          ],
        ).changes,
      ).toBe(1);
    });
    const readyOwner = currentNode(fixture, owner.id);
    expect(
      scheduleReadyNodeT4(
        fixture.instance.store,
        { current: () => ({}) as never },
        {
          graphRunId: fixture.graphRunId,
          scopeId: fixture.rootScopeId,
          nodeId: owner.id,
          expectedNodeRowVersion: readyOwner.row_version,
          expectedRunWorkFenceEpoch: 0,
          expectedScopeWorkFenceEpoch: 0,
          eligibleEventSeq: activationSequence,
          activation: { kind: 'child_owner' },
          nowMs: 14,
        },
      ).disposition,
    ).toBe('activated');

    const runBeforeSeal = currentRun(fixture);
    const rootBeforeSeal = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeSeal = currentNode(fixture, owner.id);
    const itemKeyHash = runtimeObjectHash('map-item-key', 'accepted');
    const sealInput: Parameters<typeof sealExpansionManifestT4>[1] = {
      graphRunId: fixture.graphRunId,
      ownerScopeId: fixture.rootScopeId,
      ownerNodeId: owner.id,
      expectedRunRowVersion: runBeforeSeal.row_version,
      expectedOwnerScopeRowVersion: rootBeforeSeal.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeSeal.row_version,
      expectedRunWorkFenceEpoch: runBeforeSeal.work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: rootBeforeSeal.work_fence_epoch,
      mode: 'map',
      sourceArtifact: fixture.seed.values.source!,
      manifest: { items: ['accepted'] },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      childCompletionPolicy: { type: 'all_settled', child_error: 'record' },
      children: [
        {
          childKey: 'item:0',
          itemIndex: 0,
          itemKey: 'accepted',
          itemKeyHash,
          sourceSeedHash: fixture.childPlan.source_hash as Sha256Hash,
          sourceSnapshot: fixture.seed.values.childSource!,
          inputSnapshot: fixture.seed.values.childInput!,
          compilerSnapshotHash: g6Hash('compiler-snapshot'),
          compiledPlan: fixture.instance.store.queryOne<{
            id: string;
            hash: Sha256Hash;
          }>(
            `SELECT id, plan_hash AS hash FROM workflow_graph_scope_plans
              WHERE graph_run_id = ? AND plan_hash = ?`,
            [fixture.graphRunId, fixture.childPlan.plan_hash],
          )!,
        },
      ],
      nowMs: 15,
    };
    const sealed = sealExpansionManifestT4(fixture.instance.store, sealInput);
    expect(sealed.disposition).toBe('sealed');
    expect(
      sealExpansionManifestT4(fixture.instance.store, sealInput).disposition,
    ).toBe('exact_replay');

    const runBeforeChild = currentRun(fixture);
    const rootBeforeChild = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeChild = currentNode(fixture, owner.id);
    const materializeInput: Parameters<typeof materializeDynamicScopeT2b>[1] = {
      graphRunId: fixture.graphRunId,
      buildId: sealed.buildIds[0]!,
      expectedBuildRowVersion: 1,
      expectedRunRowVersion: runBeforeChild.row_version,
      expectedOwnerScopeRowVersion: rootBeforeChild.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeChild.row_version,
      expectedRunWorkFenceEpoch: runBeforeChild.work_fence_epoch,
      expectedOwnerScopeWorkFenceEpoch: rootBeforeChild.work_fence_epoch,
      nowMs: 17,
    };
    const materialized = materializeDynamicScopeT2b(
      fixture.instance.store,
      materializeInput,
    );
    expect(materialized.disposition).toBe('materialized');
    expect(
      materializeDynamicScopeT2b(fixture.instance.store, materializeInput)
        .disposition,
    ).toBe('exact_replay');

    const runBeforeClose = currentRun(fixture);
    const childBeforeClose = currentScope(fixture, materialized.scopeId);
    const closeInput: Parameters<typeof requestScopeCloseT7a>[1] = {
      graphRunId: fixture.graphRunId,
      scopeId: materialized.scopeId,
      expectedRunRowVersion: runBeforeClose.row_version,
      expectedScopeRowVersion: childBeforeClose.row_version,
      expectedRunWorkFenceEpoch: runBeforeClose.work_fence_epoch,
      expectedScopeWorkFenceEpoch: childBeforeClose.work_fence_epoch,
      cause: { reason: 'engine_error', errorCode: 'child_fixture_error' },
      manifestSchema: fixture.seed.refs.fenceManifestSchema!,
      nowMs: 18,
    };
    const close = requestScopeCloseT7a(fixture.instance.store, closeInput);
    expect(close.disposition).toBe('close_requested');
    expect(
      requestScopeCloseT7a(fixture.instance.store, closeInput).disposition,
    ).toBe('exact_replay');

    const childBeforeCut = currentScope(fixture, materialized.scopeId);
    const rootBeforeCut = currentScope(fixture, fixture.rootScopeId);
    const ownerBeforeCut = currentNode(fixture, owner.id);
    const cutInput: Parameters<typeof finalizeChildScopeT7b>[1] = {
      graphRunId: fixture.graphRunId,
      childScopeId: materialized.scopeId,
      expectedChildScopeRowVersion: childBeforeCut.row_version,
      expectedParentScopeRowVersion: rootBeforeCut.row_version,
      expectedOwnerNodeRowVersion: ownerBeforeCut.row_version,
      expectedRunWorkFenceEpoch: currentRun(fixture).work_fence_epoch,
      expectedParentScopeWorkFenceEpoch: rootBeforeCut.work_fence_epoch,
      fenceManifestSchema: fixture.seed.refs.fenceManifestSchema!,
      mapItemResultsManifestSchema:
        fixture.seed.refs.mapItemResultsManifestSchema!,
      nowMs: 19,
    };
    const cut = finalizeChildScopeT7b(fixture.instance.store, cutInput);
    expect(cut).toMatchObject({
      disposition: 'consumed',
      parentDisposition: 'map_slot_errored',
      ownerTerminal: true,
    });
    expect(
      finalizeChildScopeT7b(fixture.instance.store, cutInput).disposition,
    ).toBe('exact_replay');
    expect(currentScope(fixture, materialized.scopeId).lifecycle).toBe(
      'closed',
    );
    expect(currentNode(fixture, owner.id)).toMatchObject({
      phase: 'terminal',
      controller_state: 'settled',
    });
    expect(
      fixture.instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count
           FROM workflow_graph_child_completion_consumptions c
           JOIN workflow_graph_completion_cuts cut
             ON cut.id = c.child_completion_cut_id
           JOIN workflow_graph_map_item_results slot
             ON slot.id = c.map_slot_id
          WHERE c.child_scope_id = ? AND slot.outcome_state = 'errored'`,
        [materialized.scopeId],
      )!.count,
    ).toBe(1);

    fixture.instance.closeStore();
    fixture.instance.reopenStore();
    expect(
      finalizeChildScopeT7b(fixture.instance.store, cutInput).disposition,
    ).toBe('exact_replay');
  });
});
