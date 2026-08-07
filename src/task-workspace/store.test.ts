import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { calculateWorkspaceInteractionPayloadHash } from '../workflow-runtime/gateway/workspace.js';
import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { RuntimeEventHub } from './runtime-event-hub.js';
import { TaskWorkspaceService } from './service.js';
import { TaskWorkspaceStore } from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function openStore(): TaskWorkspaceStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-task-workspace-'));
  roots.push(root);
  const store = new TaskWorkspaceStore(path.join(root, 'task-workspace.db'));
  stores.push(store);
  return store;
}

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function linkedSession(store: TaskWorkspaceStore): {
  sessionId: string;
  workflowId: string;
} {
  const session = store.createSession({
    ownerPrincipalRef: 'human:local-owner',
    title: 'Workspace test',
    nowMs: 1,
  });
  const message = store.appendMessage({
    sessionId: session.session_id,
    role: 'human',
    bodyText: 'run it',
    nowMs: 2,
  });
  const launch = store.createLaunchIntent({
    sessionId: session.session_id,
    sourceMessageId: message.message.message_id,
    mode: 'temporary_workflow',
    effectiveInput: { text: 'run it' },
    attachmentManifestHash: sha('a'),
    idempotencyKey: 'launch:test',
    nowMs: 3,
  });
  const workflowId = 'workflow:test';
  store.addExecutionLink({
    session_id: session.session_id,
    workflow_id: workflowId,
    intake_id: 'intake:test',
    creation_request_id: 'creation:test',
    launch_intent_id: launch.launch_intent_id,
    created_at_ms: 4,
  });
  return { sessionId: session.session_id, workflowId };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe('TaskWorkspaceStore', () => {
  it('restores a consistent closed database backup without later writes', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-task-workspace-backup-'),
    );
    roots.push(root);
    const livePath = path.join(root, 'task-workspace.db');
    const backupPath = path.join(root, 'task-workspace.backup.db');
    let store = new TaskWorkspaceStore(livePath);
    stores.push(store);
    const retained = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Retained in backup',
      nowMs: 1,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    fs.copyFileSync(livePath, backupPath);

    store = new TaskWorkspaceStore(livePath);
    stores.push(store);
    store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Created after backup',
      nowMs: 2,
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);
    fs.copyFileSync(backupPath, livePath);

    store = new TaskWorkspaceStore(livePath);
    stores.push(store);
    expect(store.listSessions('human:local-owner')).toEqual([retained]);
  });

  it('resolves Runtime links only to TaskSessions owned by the principal', () => {
    const store = openStore();
    const target = linkedSession(store);
    expect(
      store.findExecutionLinkByWorkflow(target.workflowId, 'human:local-owner'),
    ).toMatchObject({
      session_id: target.sessionId,
      workflow_id: target.workflowId,
    });
    expect(
      store.findExecutionLinkByWorkflow(target.workflowId, 'human:foreign'),
    ).toBeNull();

    const service = new TaskWorkspaceService({
      store,
      runtimeGateway: null,
      runtimeEventHub: new RuntimeEventHub(),
      coordinator: null,
      coordinatorAgentJid: () => null,
    });
    expect(
      service.resolveRuntimeLink(target.workflowId, 'human:local-owner'),
    ).toMatchObject({
      link: {
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id: target.sessionId,
      },
      execution_link: { workflow_id: target.workflowId },
    });
    expect(() =>
      service.resolveRuntimeLink(target.workflowId, 'human:foreign'),
    ).toThrow(/not linked/);
  });

  it('binds closed command idempotency and persists an applying recovery anchor', () => {
    const store = openStore();
    const target = linkedSession(store);
    const proposal = store.createCommandProposal({
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      runId: 'run:test',
      action: 'pause',
      expectedTargetRowVersion: 7,
      idempotencyKey: 'command:test',
      nowMs: 10,
    });
    expect(
      store.createCommandProposal({
        sessionId: target.sessionId,
        workflowId: target.workflowId,
        runId: 'run:test',
        action: 'pause',
        expectedTargetRowVersion: 7,
        idempotencyKey: 'command:test',
        nowMs: 11,
      }),
    ).toEqual(proposal);
    expect(() =>
      store.createCommandProposal({
        sessionId: target.sessionId,
        workflowId: target.workflowId,
        runId: 'run:test',
        action: 'cancel',
        expectedTargetRowVersion: 7,
        idempotencyKey: 'command:test',
      }),
    ).toThrow(/different proposal/);

    const applying = store.beginCommandApplication({
      proposalId: proposal.proposal_id,
      expectedRowVersion: proposal.row_version,
      expectedProposalHash: proposal.proposal_hash,
      nowMs: 12,
    });
    expect(applying.canonical_receipt).toMatchObject({ phase: 'applying' });
    expect(store.listApplyingCommandProposals()).toEqual([applying]);
    const resolved = store.resolveCommandProposal({
      proposalId: proposal.proposal_id,
      expectedRowVersion: applying.row_version,
      status: 'applied',
      receipt: { execution_result: 'applied' },
      actorRef: 'human:local-owner',
      nowMs: 13,
    });
    expect(resolved.status).toBe('applied');
    expect(store.listApplyingCommandProposals()).toEqual([]);
    expect(
      store
        .listTimeline(target.sessionId)
        .some((entry) => entry.kind === 'command_result'),
    ).toBe(true);
  });

  it('keeps one canonical pending interaction across both Workspace surfaces', () => {
    const store = openStore();
    const target = linkedSession(store);
    const snapshot: JsonObject = {
      format: 'icarus.task-interaction-rendered-snapshot/1',
      actions: [{ action_id: 'submit' }],
    };
    const interaction = store.upsertPendingInteraction({
      interactionId: 'interaction:test',
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      runId: 'run:test',
      waitId: 'wait:test',
      renderedSnapshot: snapshot,
      renderedSnapshotHash: sha('b'),
      targetRowVersion: 3,
      nowMs: 20,
    });
    expect(store.listPendingInteractions(target.sessionId)).toEqual([
      interaction,
    ]);
    const resolved = store.resolvePendingInteraction({
      interactionId: interaction.interaction_id,
      status: 'accepted',
      canonicalResult: { disposition: 'accepted', event_sequence: 8 },
      actorRef: 'human:local-owner',
      nowMs: 21,
    });
    expect(resolved.status).toBe('accepted');
    expect(resolved.canonical_result_json).toEqual({
      disposition: 'accepted',
      event_sequence: 8,
    });
    expect(
      store
        .listTimeline(target.sessionId)
        .filter((entry) => entry.kind === 'pending_interaction'),
    ).toHaveLength(2);
  });

  it('maps Runtime command decisions and expires waits missing from authoritative detail', () => {
    const store = openStore();
    const target = linkedSession(store);
    store.appendRuntimeEvents({
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      runId: 'run:test',
      expectedAfterEventSeq: 0,
      events: [
        {
          seq: 1,
          event_type: 'runtime_command_decided',
          occurred_at_ms: 30,
        },
      ],
      nextEventSeq: 1,
      nowMs: 30,
    });
    expect(store.listTimeline(target.sessionId).at(-1)?.kind).toBe(
      'command_result',
    );

    store.upsertPendingInteraction({
      interactionId: 'interaction:expired',
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      runId: 'run:test',
      waitId: 'wait:resolved-elsewhere',
      renderedSnapshot: {
        format: 'icarus.task-interaction-rendered-snapshot/1',
        actions: [{ action_id: 'submit' }],
      },
      renderedSnapshotHash: sha('c'),
      targetRowVersion: 1,
      nowMs: 31,
    });
    const [expired] = store.expireMissingPendingInteractions({
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      authoritativeWaitIds: new Set(),
      nowMs: 32,
    });
    expect(expired?.status).toBe('expired');
    expect(expired?.canonical_result_json).toMatchObject({
      reason: 'runtime_wait_no_longer_pending',
    });
  });
});

describe('TaskWorkspaceService recovery', () => {
  it('replays a claimed Runtime command after an unknown response', async () => {
    const store = openStore();
    const target = linkedSession(store);
    let calls = 0;
    let loseResponse = true;
    const gateway = {
      listRecipes: () => ({
        format: 'icarus.workspace-recipe-catalog/1' as const,
        items: [],
        expires_at_ms: 0,
      }),
      getRuntimeDetail: () => ({
        format: 'icarus.workspace-runtime-detail/1' as const,
        freshness: 'ready' as const,
        workflows: [],
      }),
      listRuntimeEvents: () => ({
        format: 'icarus.workspace-runtime-event-page/1' as const,
        workflow_id: target.workflowId,
        run_id: 'run:test',
        events: [],
        next_event_seq: 0,
        has_more: false,
      }),
      submitCommand: () => {
        calls += 1;
        if (loseResponse) throw new Error('response_lost');
        return {
          format: 'icarus.workspace-runtime-command-receipt/1' as const,
          execution_result: 'duplicate' as const,
          denial_code: null,
          ingress_invocation_id: 'ingress:test',
          command_id: 'command:test',
          invocation_id: 'invocation:test',
          canonical_result: { disposition: 'applied' },
        };
      },
    };
    const service = new TaskWorkspaceService({
      store,
      runtimeGateway: gateway as never,
      runtimeEventHub: new RuntimeEventHub(),
      coordinator: null,
      coordinatorAgentJid: () => null,
      now: () => 30,
    });
    const proposal = service.createCommandProposal({
      sessionId: target.sessionId,
      principalRef: 'human:local-owner',
      workflowId: target.workflowId,
      runId: 'run:test',
      action: 'pause',
      expectedTargetRowVersion: 4,
      idempotencyKey: 'command:recover',
    });
    expect(() =>
      service.confirmCommandProposal({
        proposalId: proposal.proposal_id,
        principalRef: 'human:local-owner',
        expectedRowVersion: proposal.row_version,
        proposalHash: proposal.proposal_hash,
      }),
    ).toThrow(/response_lost/);
    expect(store.listApplyingCommandProposals()).toHaveLength(1);

    loseResponse = false;
    await service.start();
    expect(store.getCommandProposal(proposal.proposal_id).status).toBe(
      'applied',
    );
    expect(calls).toBe(2);
    await service.stop();
  });

  it('syncs and resolves a Runtime Wait through the closed interaction request', async () => {
    const store = openStore();
    const target = linkedSession(store);
    const payload: JsonObject = { approved: true };
    const gateway = {
      getRuntimeDetail: () => ({
        format: 'icarus.workspace-runtime-detail/1' as const,
        freshness: 'ready' as const,
        workflows: [
          {
            id: target.workflowId,
            runs: [],
            pending: [
              {
                id: 'wait:test',
                graph_run_id: 'run:test',
                node_id: 'node:test',
                wait_type: 'approval',
                row_version: 2,
                deadline_at_ms: null,
              },
            ],
          },
        ],
      }),
      listRuntimeEvents: () => ({
        format: 'icarus.workspace-runtime-event-page/1' as const,
        workflow_id: target.workflowId,
        run_id: 'run:test',
        events: [],
        next_event_seq: 0,
        has_more: false,
      }),
      submitInteraction: () => ({
        disposition: 'accepted' as const,
        inboxSequence: 1,
        eventSequence: 2,
      }),
    };
    const service = new TaskWorkspaceService({
      store,
      runtimeGateway: gateway as never,
      runtimeEventHub: new RuntimeEventHub(),
      coordinator: null,
      coordinatorAgentJid: () => null,
      now: () => 40,
    });
    const detail = await service.runtimeDetail(
      target.sessionId,
      'human:local-owner',
    );
    const interaction = detail.pending_interactions[0]!;
    const result = service.submitInteraction({
      principalRef: 'human:local-owner',
      submission: {
        interaction_id: interaction.interaction_id,
        rendered_snapshot_hash: interaction.rendered_snapshot_hash,
        action_id: 'submit',
        payload_json: payload,
        payload_hash: calculateWorkspaceInteractionPayloadHash(payload),
        expected_target_row_version: interaction.target_row_version,
        idempotency_key: 'interaction:submit',
      },
    });
    expect(result.interaction.status).toBe('accepted');
    expect(result.receipt).toMatchObject({
      disposition: 'accepted',
      event_sequence: 2,
    });
  });
});
