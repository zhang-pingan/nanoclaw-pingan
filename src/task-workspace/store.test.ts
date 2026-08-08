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
  it('deletes the complete owned Workspace graph without touching other sessions', () => {
    const store = openStore();
    const retained = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Retained task',
      nowMs: 1,
    });
    const deleted = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Deleted task',
      nowMs: 2,
    });
    const run = store.createRunLaunchIntent({
      sessionId: deleted.session_id,
      messageText: 'Run and delete',
      mode: 'temporary_workflow',
      selectedRecipeRef: { id: 'ad_hoc_personal_task', version: '1.0.0' },
      selectedRecipeHash: sha('1'),
      effectiveInput: { text: 'Run and delete' },
      attachmentManifestHash: sha('2'),
      idempotencyKey: 'run:delete-graph',
      nowMs: 3,
    });
    store.addExecutionLink({
      session_id: deleted.session_id,
      workflow_id: 'workflow:delete-graph',
      intake_id: 'intake:delete-graph',
      creation_request_id: 'creation:delete-graph',
      launch_intent_id: run.launch.launch_intent_id,
      created_at_ms: 4,
    });
    const artifact = store.upsertArtifactLink({
      sessionId: deleted.session_id,
      workflowId: 'workflow:delete-graph',
      artifactRef: 'artifact:delete-graph',
      artifactHash: sha('3'),
      display: { title: 'Delete me' },
      nowMs: 5,
    });
    store.upsertPendingInteraction({
      interactionId: 'interaction:delete-graph',
      sessionId: deleted.session_id,
      workflowId: 'workflow:delete-graph',
      runId: 'run:delete-graph',
      waitId: 'wait:delete-graph',
      renderedSnapshot: { prompt: 'Delete?' },
      renderedSnapshotHash: sha('4'),
      targetRowVersion: 1,
      nowMs: 6,
    });
    store.putIdempotency({
      domain: 'interaction:interaction:delete-graph',
      key: 'interaction-submit:delete-graph',
      requestHash: sha('9'),
      response: { disposition: 'accepted' },
      nowMs: 6,
    });
    store.createCommandProposal({
      sessionId: deleted.session_id,
      workflowId: 'workflow:delete-graph',
      runId: 'run:delete-graph',
      action: 'pause',
      expectedTargetRowVersion: 1,
      idempotencyKey: 'command:delete-graph',
      nowMs: 7,
    });
    store.appendRuntimeEvents({
      sessionId: deleted.session_id,
      workflowId: 'workflow:delete-graph',
      runId: 'run:delete-graph',
      expectedAfterEventSeq: 0,
      events: [
        {
          seq: 1,
          event_type: 'run_created',
          occurred_at_ms: 8,
        },
      ],
      nextEventSeq: 1,
      nowMs: 8,
    });
    const personalDraft = store.createPersonalWorkflowDraft({
      ownerPrincipalRef: 'human:local-owner',
      sourceSessionId: deleted.session_id,
      sourceWorkflowId: 'workflow:delete-graph',
      sourceRunId: 'run:delete-graph',
      source: { format: 'test' },
      sourceHash: sha('5'),
      compiledPlan: { format: 'plan' },
      compiledPlanHash: sha('6'),
      compilerVersion: 'test',
      resourceClosureHash: sha('7'),
      policyCeilingHash: sha('8'),
      riskSummary: {},
      nowMs: 9,
    });
    store.audit({
      sessionId: deleted.session_id,
      actorKind: 'human',
      actorRef: 'human:local-owner',
      action: 'test_event',
      targetRef: deleted.session_id,
      detail: {},
      nowMs: 10,
    });

    store.deleteSession({
      sessionId: deleted.session_id,
      principalRef: 'human:local-owner',
    });

    expect(store.listSessions('human:local-owner')).toEqual([retained]);
    expect(() => store.getSession(deleted.session_id)).toThrow(/not found/i);
    expect(() => store.getArtifactLink(artifact.artifact_link_id)).toThrow(
      /not found/i,
    );
    expect(() =>
      store.getPersonalWorkflowDraft(
        String(personalDraft.draft_id),
        'human:local-owner',
      ),
    ).toThrow(/not found/i);
    expect(
      store.findExecutionLinkByWorkflow(
        'workflow:delete-graph',
        'human:local-owner',
      ),
    ).toBeNull();
    expect(
      store.findIdempotency({
        domain: 'interaction:interaction:delete-graph',
        key: 'interaction-submit:delete-graph',
        requestHash: sha('9'),
      }),
    ).toBeNull();
    store.integrityCheck();

    const replacement = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Replacement task',
      nowMs: 11,
    });
    expect(() =>
      store.createRunLaunchIntent({
        sessionId: replacement.session_id,
        messageText: 'Reuse deleted idempotency key',
        mode: 'temporary_workflow',
        selectedRecipeRef: {
          id: 'ad_hoc_personal_task',
          version: '1.0.0',
        },
        selectedRecipeHash: sha('1'),
        effectiveInput: { text: 'Reuse deleted idempotency key' },
        attachmentManifestHash: sha('2'),
        idempotencyKey: 'run:delete-graph',
        nowMs: 12,
      }),
    ).not.toThrow();
  });

  it('rejects deletion while a Coordinator turn is running', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Coordinator is running',
      nowMs: 1,
    });
    const message = store.appendMessage({
      sessionId: session.session_id,
      role: 'human',
      bodyText: 'Wait for the response',
      createCoordinatorTurn: true,
      nowMs: 2,
    });
    const turn = store.claimNextCoordinatorTurn(session.session_id, 3);
    expect(turn).not.toBeNull();

    expect(() =>
      store.deleteSession({
        sessionId: session.session_id,
        principalRef: 'human:local-owner',
      }),
    ).toThrow(/currently processing/i);

    store.finishCoordinatorTurn({
      turnId: message.turn!.turn_id,
      status: 'completed',
      queryId: null,
      nowMs: 4,
    });
    expect(() =>
      store.deleteSession({
        sessionId: session.session_id,
        principalRef: 'human:local-owner',
      }),
    ).not.toThrow();
  });

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

  it('atomically binds Run idempotency before writing the Human message', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Atomic Run',
      nowMs: 1,
    });
    const effectiveInput: JsonObject = {
      format: 'icarus.task-workspace-effective-input/1',
      text: 'Run exactly once',
      attachments: [],
    };
    const first = store.createRunLaunchIntent({
      sessionId: session.session_id,
      messageText: 'Run exactly once',
      mode: 'temporary_workflow',
      selectedRecipeRef: { id: 'ad_hoc_personal_task', version: '1.0.0' },
      selectedRecipeHash: sha('1'),
      selectionToken: 'selection:first',
      effectiveInput,
      attachmentManifestHash: sha('2'),
      idempotencyKey: 'run:atomic',
      nowMs: 2,
    });
    const replay = store.createRunLaunchIntent({
      sessionId: session.session_id,
      messageText: 'Run exactly once',
      mode: 'temporary_workflow',
      selectedRecipeRef: { id: 'ad_hoc_personal_task', version: '1.0.0' },
      selectedRecipeHash: sha('1'),
      selectionToken: 'selection:refreshed',
      effectiveInput,
      attachmentManifestHash: sha('2'),
      idempotencyKey: 'run:atomic',
      nowMs: 3,
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.launch.launch_intent_id).toBe(first.launch.launch_intent_id);
    expect(replay.message.message_id).toBe(first.message.message_id);
    expect(store.listMessages(session.session_id)).toHaveLength(1);
    expect(() =>
      store.createRunLaunchIntent({
        sessionId: session.session_id,
        messageText: 'Run exactly once',
        mode: 'temporary_workflow',
        selectedRecipeRef: {
          id: 'ad_hoc_personal_task',
          version: '1.0.0',
        },
        selectedRecipeHash: sha('1'),
        effectiveInput,
        attachmentManifestHash: sha('3'),
        idempotencyKey: 'run:atomic',
      }),
    ).toThrow(/different Session, selection, input, or attachment manifest/);
    expect(store.listMessages(session.session_id)).toHaveLength(1);
  });

  it('rejects a Published Run that does not match the Session exact Recipe', () => {
    const store = openStore();
    let session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Published Run',
      nowMs: 1,
    });
    session = store.setRunSelection({
      sessionId: session.session_id,
      principalRef: 'human:local-owner',
      selection: {
        kind: 'published_recipe',
        recipe_ref: { id: 'recipe:test', version: '2.0.0' },
        recipe_hash: sha('4'),
        recipe_kind: 'core',
      },
      expectedRowVersion: session.row_version,
      nowMs: 2,
    });
    expect(() =>
      store.createRunLaunchIntent({
        sessionId: session.session_id,
        messageText: 'Run selected Recipe',
        mode: 'published_recipe',
        selectedRecipeRef: { id: 'recipe:test', version: '1.0.0' },
        selectedRecipeHash: sha('4'),
        effectiveInput: { text: 'Run selected Recipe', attachments: [] },
        attachmentManifestHash: sha('5'),
        idempotencyKey: 'run:mismatched-selection',
      }),
    ).toThrow(/does not match the TaskSession exact selection/);
    expect(store.listMessages(session.session_id)).toEqual([]);
  });

  it('preserves failed attention for messages and clears it for a new Run', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Retry failed Run',
      nowMs: 1,
    });
    const first = store.createRunLaunchIntent({
      sessionId: session.session_id,
      messageText: 'First attempt',
      mode: 'temporary_workflow',
      effectiveInput: { text: 'First attempt', attachments: [] },
      attachmentManifestHash: sha('a'),
      idempotencyKey: 'run:first-attempt',
      nowMs: 2,
    });
    store.updateLaunchStatus({
      launchIntentId: first.launch.launch_intent_id,
      expectedRowVersion: first.launch.row_version,
      status: 'failed',
      errorCode: 'planning_failed',
      nowMs: 3,
    });

    store.appendMessage({
      sessionId: session.session_id,
      role: 'system',
      bodyText: 'Failure details',
      nowMs: 4,
    });
    expect(store.getSession(session.session_id).attention_state).toBe('failed');

    store.createRunLaunchIntent({
      sessionId: session.session_id,
      messageText: 'Second attempt',
      mode: 'temporary_workflow',
      effectiveInput: { text: 'Second attempt', attachments: [] },
      attachmentManifestHash: sha('b'),
      idempotencyKey: 'run:second-attempt',
      nowMs: 5,
    });
    expect(store.getSession(session.session_id).attention_state).toBe('none');
  });

  it('only confirms the current revision belonging to the LaunchIntent Draft', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Temporary confirmation',
      nowMs: 1,
    });
    const run = store.createRunLaunchIntent({
      sessionId: session.session_id,
      messageText: 'Plan this task',
      mode: 'temporary_workflow',
      effectiveInput: { text: 'Plan this task', attachments: [] },
      attachmentManifestHash: sha('6'),
      idempotencyKey: 'run:revision',
      nowMs: 2,
    });
    const revision = (marker: string) =>
      store.createTemporaryRevision({
        launchIntentId: run.launch.launch_intent_id,
        sourceMessageId: run.message.message_id,
        source: { scope_key: marker },
        sourceHash: sha(marker),
        compiledPlan: { plan: marker },
        compiledPlanHash: sha(marker.toUpperCase()),
        compilerVersion: 'test',
        resourceClosureHash: sha('7'),
        policyCeilingHash: sha('8'),
        riskSummary: { marker },
        nowMs: marker === 'a' ? 3 : 4,
      });
    const oldRevision = revision('a');
    const currentRevision = revision('b');
    expect(store.getSession(session.session_id).attention_state).toBe(
      'waiting_user',
    );
    const awaiting = store.getLaunchIntent(run.launch.launch_intent_id);
    expect(() =>
      store.confirmCurrentTemporaryRevision({
        launchIntentId: awaiting.launch_intent_id,
        revisionId: oldRevision.revision_id,
        expectedRowVersion: awaiting.row_version,
        nowMs: 5,
      }),
    ).toThrow(/not the current revision/);
    const confirmed = store.confirmCurrentTemporaryRevision({
      launchIntentId: awaiting.launch_intent_id,
      revisionId: currentRevision.revision_id,
      expectedRowVersion: awaiting.row_version,
      nowMs: 6,
    });
    expect(confirmed.launch).toMatchObject({
      status: 'creating',
      confirmed_draft_revision_id: currentRevision.revision_id,
    });
    expect(confirmed.revision).toEqual(currentRevision);
    expect(store.getSession(session.session_id).attention_state).toBe('none');
  });

  it('serializes persisted Coordinator turns and allows Agent session recovery', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Coordinator turns',
      nowMs: 1,
    });
    const firstMessage = store.appendMessage({
      sessionId: session.session_id,
      role: 'human',
      bodyText: 'First request',
      nowMs: 2,
    }).message;
    const secondMessage = store.appendMessage({
      sessionId: session.session_id,
      role: 'human',
      bodyText: 'Second request',
      nowMs: 3,
    }).message;
    const first = store.ensureCoordinatorTurn({
      sessionId: session.session_id,
      sourceMessageId: firstMessage.message_id,
      nowMs: 4,
    });
    const second = store.ensureCoordinatorTurn({
      sessionId: session.session_id,
      sourceMessageId: secondMessage.message_id,
      nowMs: 5,
    });
    expect(store.claimCoordinatorTurn(first.turn_id, 6)?.status).toBe(
      'running',
    );
    expect(store.claimCoordinatorTurn(second.turn_id, 7)).toBeNull();
    const finished = store.finishCoordinatorTurn({
      turnId: first.turn_id,
      status: 'completed',
      queryId: 'query:first',
      agentSessionId: 'agent-session:first',
      nowMs: 8,
    });
    expect(finished.query_id).toBe('query:first');
    expect(store.claimCoordinatorTurn(second.turn_id, 9)?.status).toBe(
      'running',
    );
    const recovered = store.replaceCoordinatorAgentSession({
      sessionId: session.session_id,
      expectedAgentSessionId: 'agent-session:first',
      agentSessionId: 'agent-session:recovered',
      nowMs: 10,
    });
    expect(recovered.coordinator_agent_session_id).toBe(
      'agent-session:recovered',
    );
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

  it('persists Runtime Artifact links without copying Artifact bytes', () => {
    const store = openStore();
    const target = linkedSession(store);
    const created = store.upsertArtifactLink({
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      artifactRef: 'value:artifact-result',
      artifactHash: sha('d'),
      display: {
        graph_run_id: 'run:test',
        node_id: 'node:result',
        media_type: 'application/json',
        byte_length: 42,
        payload_state: 'inline',
      },
      nowMs: 9,
    });
    const enriched = store.upsertArtifactLink({
      sessionId: target.sessionId,
      workflowId: target.workflowId,
      artifactRef: 'value:artifact-result',
      artifactHash: sha('d'),
      display: {
        graph_run_id: 'run:test',
        node_id: 'node:result',
        media_type: 'application/json',
        byte_length: 42,
        payload_state: 'inline',
        display_name: 'Result',
      },
      nowMs: 10,
    });
    expect(enriched.artifact_link_id).toBe(created.artifact_link_id);
    expect(
      store.listArtifactLinks(target.sessionId, target.workflowId),
    ).toEqual([enriched]);
    expect(enriched.display_json).toMatchObject({
      display_name: 'Result',
      media_type: 'application/json',
    });
    expect(
      store
        .listTimeline(target.sessionId)
        .filter((entry) => entry.kind === 'artifact_published'),
    ).toHaveLength(1);
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

  it('maps explicit Runtime event types and expires missing waits', () => {
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
        {
          seq: 2,
          event_type: 'node_terminal',
          node_id: 'node:terminal',
          occurred_at_ms: 31,
        },
        {
          seq: 3,
          event_type: 'terminal_candidate',
          node_id: 'node:candidate',
          occurred_at_ms: 32,
        },
        {
          seq: 4,
          event_type: 'wait_resolved',
          node_id: 'node:wait',
          occurred_at_ms: 33,
        },
        {
          seq: 5,
          event_type: 'wait_armed',
          node_id: 'node:pending-wait',
          occurred_at_ms: 34,
        },
        {
          seq: 6,
          event_type: 'completion_cut_committed',
          occurred_at_ms: 35,
        },
        {
          seq: 7,
          event_type: 'workflow_terminal_committed',
          occurred_at_ms: 36,
        },
      ],
      nextEventSeq: 7,
      nowMs: 30,
    });
    const runtimeKinds = store
      .listTimeline(target.sessionId)
      .filter((entry) => entry.source_kind === 'runtime')
      .map((entry) => entry.kind);
    expect(runtimeKinds).toEqual([
      'command_result',
      'node_progress',
      'node_progress',
      'node_progress',
      'pending_interaction',
      'workflow_progress',
      'workflow_completed',
    ]);

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
