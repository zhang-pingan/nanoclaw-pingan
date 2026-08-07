import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import {
  calculateWorkspaceTemporaryReplanConfirmationHash,
  type WorkspaceReplanReceipt,
  type WorkspaceTemporaryReplanPreparation,
} from '../workflow-runtime/gateway/workspace.js';
import { RuntimeEventHub } from './runtime-event-hub.js';
import { TaskWorkspaceService } from './service.js';
import { TaskWorkspaceStore } from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function openStore(): TaskWorkspaceStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-task-workspace-replan-service-'),
  );
  roots.push(root);
  const store = new TaskWorkspaceStore(path.join(root, 'task-workspace.db'));
  stores.push(store);
  return store;
}

function linkedSession(store: TaskWorkspaceStore): {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly activationId: string;
} {
  const session = store.createSession({
    ownerPrincipalRef: 'human:local-owner',
    title: 'Replan service test',
    nowMs: 1,
  });
  const message = store.appendMessage({
    sessionId: session.session_id,
    role: 'human',
    bodyText: 'Run the temporary task',
    nowMs: 2,
  });
  const launch = store.createLaunchIntent({
    sessionId: session.session_id,
    sourceMessageId: message.message.message_id,
    mode: 'temporary_workflow',
    effectiveInput: { text: 'Run the temporary task' },
    attachmentManifestHash: sha('a'),
    idempotencyKey: 'launch:replan-test',
    nowMs: 3,
  });
  const workflowId = 'workflow:source';
  store.addExecutionLink({
    session_id: session.session_id,
    workflow_id: workflowId,
    intake_id: 'intake:test',
    creation_request_id: 'creation:test',
    launch_intent_id: launch.launch_intent_id,
    created_at_ms: 4,
  });
  return {
    sessionId: session.session_id,
    workflowId,
    runId: 'run:source',
    activationId: 'activation:source',
  };
}

function preparation(target: ReturnType<typeof linkedSession>) {
  const replanCreationKey = 'temporary-replan:create:test';
  const proposalHash = sha('b');
  const confirmationRef = 'temporary-replan-confirmation:test';
  const confirmationHash = calculateWorkspaceTemporaryReplanConfirmationHash({
    principal_ref: 'human:local-owner',
    source_workflow_id: target.workflowId,
    source_activation_id: target.activationId,
    source_run_id: target.runId,
    replan_creation_key: replanCreationKey,
    proposal_hash: proposalHash,
    confirmation_ref: confirmationRef,
  });
  return {
    format: 'icarus.workspace-temporary-replan-preparation/1',
    proposal_hash: proposalHash,
    replan_creation_key: replanCreationKey,
    confirmation_ref: confirmationRef,
    confirmation_hash: confirmationHash,
    source_authority: {
      workflow_id: target.workflowId,
      workflow_row_version: 5,
      workflow_revision: 1,
      activation_id: target.activationId,
      activation_row_version: 4,
      run_id: target.runId,
      run_row_version: 7,
      run_work_fence_epoch: 0,
      manifest_seq: 3,
      manifest_head_hash: sha('9'),
      ledger_seq: 2,
      ledger_head_hash: sha('0'),
      root_scope_id: 'scope:root',
      root_scope_row_version: 6,
      root_scope_work_fence_epoch: 0,
      event_seq: 12,
      state_config_value_id: 'value:state-config',
      state_config_hash: sha('c'),
      registry_snapshot_id: 'snapshot:test',
      registry_snapshot_hash: sha('d'),
      closure_manifest_id: 'closure:test',
      closure_hash: sha('e'),
      runtime_safety_snapshot_value_id: 'value:safety',
      runtime_safety_snapshot_hash: sha('f'),
      compiler_snapshot_hash: sha('a'),
      input_snapshot_value_id: 'value:input',
      input_snapshot_hash: sha('1'),
      context_snapshot_id: 'context:test',
      context_snapshot_hash: sha('2'),
      root_plan_hash: sha('3'),
      frontier_hash: sha('4'),
      effect_safety_hash: sha('5'),
    },
    source_frontier_json: {
      active_attempts: [],
      pending_waits: [],
      event_seq: 12,
    },
    effect_safety_json: {
      active_external_attempts: [],
      unknown_effects: [],
      unfinished_compensations: [],
    },
    old_source_hash: sha('6'),
    old_plan_hash: sha('3'),
    new_source_json: {
      format: 'icarus.workflow-graph-scope/1',
      scope_key: 'dynamic_child',
    },
    new_source_hash: sha('7'),
    new_plan_json: { format: 'icarus.compiled-plan/1', nodes: [] },
    new_plan_hash: sha('8'),
    diff_json: { added_nodes: ['review_summary'] },
    risk_summary_json: { effect_ceiling: 'read_only' },
  } satisfies WorkspaceTemporaryReplanPreparation;
}

function receipt(
  prepared: WorkspaceTemporaryReplanPreparation,
  disposition: WorkspaceReplanReceipt['disposition'],
  code: string,
  target: { activationId: string; runId: string } | null = null,
): WorkspaceReplanReceipt {
  return {
    format: 'icarus.workspace-temporary-replan-receipt/1',
    disposition,
    code,
    source_workflow_id: prepared.source_authority.workflow_id,
    source_activation_id: prepared.source_authority.activation_id,
    source_run_id: prepared.source_authority.run_id,
    proposal_hash: prepared.proposal_hash,
    replan_creation_key: prepared.replan_creation_key,
    confirmation_ref: prepared.confirmation_ref,
    confirmation_hash: prepared.confirmation_hash,
    source_fence_receipt:
      disposition === 'denied'
        ? null
        : { command_id: 'command:source-fence', disposition: 'applied' },
    target_activation_id: target?.activationId ?? null,
    target_run_id: target?.runId ?? null,
  };
}

function harness(options: {
  apply: ReturnType<typeof vi.fn>;
  reconcile?: ReturnType<typeof vi.fn>;
}) {
  const store = openStore();
  const target = linkedSession(store);
  const prepared = preparation(target);
  const prepareTemporaryReplan = vi.fn(() => prepared);
  const reconcileTemporaryReplan =
    options.reconcile ??
    vi.fn(() => receipt(prepared, 'applying', 'target_pending'));
  const runtimeDetail = {
    format: 'icarus.workspace-runtime-detail/1' as const,
    freshness: 'ready' as const,
    workflows: [
      {
        id: target.workflowId,
        recipe_id: 'ad_hoc_personal_task',
        current_graph_run_id: target.runId,
        runs: [
          {
            id: target.runId,
            activation_id: target.activationId,
            lifecycle: 'executing',
            control: 'running',
            row_version: 7,
          },
        ],
        nodes: [],
        waits: [],
        pending: [],
      },
    ],
  };
  const gateway = {
    getRuntimeDetail: vi.fn(() => runtimeDetail),
    listRuntimeEvents: vi.fn((request: { after_event_seq: number }) => ({
      format: 'icarus.workspace-runtime-event-page/1' as const,
      workflow_id: target.workflowId,
      run_id: target.runId,
      events: [],
      next_event_seq: request.after_event_seq,
      has_more: false,
    })),
    prepareTemporaryReplan,
    applyTemporaryReplan: options.apply,
    reconcileTemporaryReplan,
  };
  const coordinator = {
    chat: vi.fn(async () => ({
      ok: true as const,
      text: JSON.stringify({ source_json: prepared.new_source_json }),
      query_id: 'query:replan',
      session_id: 'agent-session:replan',
      error: '',
    })),
  };
  const hub = new RuntimeEventHub();
  const service = new TaskWorkspaceService({
    store,
    runtimeGateway: gateway as never,
    runtimeEventHub: hub,
    coordinator: coordinator as never,
    coordinatorAgentJid: () => 'agent:coordinator',
    timelinePollMs: 60_000,
    now: () => 100,
  });
  return {
    store,
    target,
    prepared,
    gateway,
    coordinator,
    hub,
    service,
  };
}

async function createReplan(test: ReturnType<typeof harness>) {
  return test.service.createReplan({
    sessionId: test.target.sessionId,
    principalRef: 'human:local-owner',
    workflowId: test.target.workflowId,
    runId: test.target.runId,
    instruction: 'Replace the remaining work with a reviewed summary.',
    idempotencyKey: 'replan:create:test',
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('TaskWorkspaceService Temporary Replan', () => {
  it('prepares from an instruction, binds exact replay, and remains applying without target lineage', async () => {
    const test = harness({
      apply: vi.fn(() =>
        receipt(preparation(test.target), 'applying', 'target_pending'),
      ),
    });
    const created = await createReplan(test);
    const replayed = await createReplan(test);
    expect(replayed).toEqual(created);
    expect(test.coordinator.chat).toHaveBeenCalledOnce();
    expect(test.gateway.prepareTemporaryReplan).toHaveBeenCalledOnce();
    expect(created).toMatchObject({
      source_workflow_id: test.target.workflowId,
      source_activation_id: test.target.activationId,
      source_run_id: test.target.runId,
      source_frontier_hash: test.prepared.source_authority.frontier_hash,
      proposal_hash: test.prepared.proposal_hash,
      status: 'awaiting_confirmation',
    });
    await expect(
      test.service.createReplan({
        sessionId: test.target.sessionId,
        principalRef: 'human:local-owner',
        workflowId: test.target.workflowId,
        runId: test.target.runId,
        instruction: 'A different instruction.',
        idempotencyKey: 'replan:create:test',
      }),
    ).rejects.toThrow(/different instruction or source/);

    test.gateway.applyTemporaryReplan.mockReturnValue(
      receipt(test.prepared, 'applying', 'target_pending'),
    );
    const applying = test.service.confirmReplan({
      replanId: String(created.replan_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(created.row_version),
      proposalHash: created.proposal_hash as Sha256Hash,
    });
    expect(applying).toMatchObject({
      status: 'applying',
      source_fence_receipt: { command_id: 'command:source-fence' },
      target_activation_id: null,
      target_run_id: null,
    });
    expect(test.store.listApplyingReplans()).toEqual([applying]);
    expect(test.gateway.applyTemporaryReplan).toHaveBeenCalledWith({
      principal_ref: 'human:local-owner',
      preparation: test.prepared,
      confirmation_ref: test.prepared.confirmation_ref,
      confirmation_hash: test.prepared.confirmation_hash,
      now_ms: 100,
    });

    test.gateway.applyTemporaryReplan.mockReturnValue(
      receipt(test.prepared, 'duplicate', 'target_transition_duplicate', {
        activationId: 'activation:target',
        runId: 'run:target',
      }),
    );
    const replayResult = test.service.confirmReplan({
      replanId: String(created.replan_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(created.row_version),
      proposalHash: created.proposal_hash as Sha256Hash,
    });
    expect(replayResult).toMatchObject({
      status: 'applied',
      target_activation_id: 'activation:target',
      target_run_id: 'run:target',
    });
  });

  it('recovers a lost pre-submit response and resolves only after Runtime reports the target Run', async () => {
    const test = harness({
      apply: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('response_lost');
        })
        .mockImplementationOnce(() =>
          receipt(preparation(test.target), 'applied', 'target_reconciled', {
            activationId: 'activation:target',
            runId: 'run:target',
          }),
        ),
    });
    const created = await createReplan(test);
    expect(() =>
      test.service.confirmReplan({
        replanId: String(created.replan_id),
        principalRef: 'human:local-owner',
        expectedRowVersion: Number(created.row_version),
        proposalHash: created.proposal_hash as Sha256Hash,
      }),
    ).toThrow(/response_lost/);
    expect(test.store.listApplyingReplans()).toHaveLength(1);
    test.gateway.reconcileTemporaryReplan.mockReturnValue(
      receipt(test.prepared, 'denied', 'replan_not_submitted'),
    );

    await test.service.start();
    const recovered = test.store.getReplanRequest(String(created.replan_id));
    expect(recovered).toMatchObject({
      status: 'applied',
      source_workflow_id: test.target.workflowId,
      target_activation_id: 'activation:target',
      target_run_id: 'run:target',
      last_error_code: null,
    });
    expect(test.gateway.reconcileTemporaryReplan).toHaveBeenCalledOnce();
    expect(test.gateway.applyTemporaryReplan).toHaveBeenCalledTimes(2);
    await test.service.stop();
  });
});
