import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { RuntimeEventHub } from './runtime-event-hub.js';
import { TaskWorkspaceService } from './service.js';
import { sanitizePersonalWorkflowSource, TaskWorkspaceStore } from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function linkedStore(): {
  store: TaskWorkspaceStore;
  sessionId: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-personal-workflow-service-'),
  );
  roots.push(root);
  const store = new TaskWorkspaceStore(path.join(root, 'task-workspace.db'));
  stores.push(store);
  const session = store.createSession({
    ownerPrincipalRef: 'human:local-owner',
    title: 'Personal source',
    nowMs: 1,
  });
  const message = store.appendMessage({
    sessionId: session.session_id,
    role: 'human',
    bodyText: 'run temporary',
    nowMs: 2,
  });
  const launch = store.createLaunchIntent({
    sessionId: session.session_id,
    sourceMessageId: message.message.message_id,
    mode: 'temporary_workflow',
    effectiveInput: { text: 'run temporary' },
    attachmentManifestHash: sha('a'),
    idempotencyKey: 'launch:personal-source',
    nowMs: 3,
  });
  store.addExecutionLink({
    session_id: session.session_id,
    workflow_id: 'workflow:source',
    intake_id: 'intake:source',
    creation_request_id: 'creation:source',
    launch_intent_id: launch.launch_intent_id,
    created_at_ms: 4,
  });
  return { store, sessionId: session.session_id };
}

function gateway(overrides: Record<string, unknown> = {}) {
  let active = false;
  return {
    extractPersonalWorkflowDraft: () => ({
      format: 'icarus.workspace-personal-draft-extraction/1' as const,
      source_workflow_id: 'workflow:source',
      source_run_id: 'run:source',
      source_json: {
        format: 'icarus.workflow-graph-scope/1',
        nodes: [{ id: 'done', type: 'terminal', secret: 'remove' }],
        output_path: '/tmp/instance-only',
      },
      source_hash: sha('s'),
      compiled_plan_json: { plan_hash: sha('p') },
      compiled_plan_hash: sha('p'),
      compiler_version: 'workflow-compiler/1',
    }),
    preparePersonalWorkflowDraft: ({
      source_json,
    }: {
      source_json: JsonObject;
    }) => ({
      format: 'icarus.workspace-temporary-draft-compilation/1' as const,
      source_hash: sha('s'),
      compiled_plan_json: { plan_hash: sha('p'), source: source_json },
      compiled_plan_hash: sha('p'),
      compiler_version: 'workflow-compiler/1',
      resource_closure_hash: sha('c'),
      policy_ceiling_hash: sha('e'),
      risk_summary_json: { effect_ceiling: 'read_only' },
    }),
    publishPersonalWorkflowRelease: () => ({
      release_id: 'release:test',
      release_hash: sha('r'),
    }),
    activatePersonalWorkflowRelease: () => {
      active = true;
      return { pointer_row_version: 1 };
    },
    listPersonalWorkflowReleases: () =>
      active ? [{ release_id: 'release:test', pointer_row_version: 1 }] : [],
    getRuntimeDetail: () => ({
      format: 'icarus.workspace-runtime-detail/1' as const,
      freshness: 'ready' as const,
      workflows: [],
    }),
    listRuntimeEvents: () => ({
      format: 'icarus.workspace-runtime-event-page/1' as const,
      workflow_id: 'workflow:source',
      run_id: 'run:source',
      events: [],
      next_event_seq: 0,
      has_more: false,
    }),
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe('TaskWorkspaceService Personal Workflow', () => {
  it('extracts, reviews, publishes inactive, and activates separately', async () => {
    const fixture = linkedStore();
    const runtimeGateway = gateway();
    const service = new TaskWorkspaceService({
      store: fixture.store,
      runtimeGateway: runtimeGateway as never,
      runtimeEventHub: new RuntimeEventHub(),
      coordinator: null,
      coordinatorAgentJid: () => null,
      now: () => 10,
    });
    let draft = await service.createPersonalWorkflowDraft({
      sessionId: fixture.sessionId,
      principalRef: 'human:local-owner',
      workflowId: 'workflow:source',
      runId: 'run:source',
    });
    expect(draft.source).toEqual(
      sanitizePersonalWorkflowSource({
        format: 'icarus.workflow-graph-scope/1',
        nodes: [{ id: 'done', type: 'terminal', secret: 'remove' }],
        output_path: '/tmp/instance-only',
      }),
    );
    draft = service.advancePersonalWorkflow({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      action: 'validate',
    });
    draft = service.advancePersonalWorkflow({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      action: 'dry-run',
    });
    draft = service.advancePersonalWorkflow({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      action: 'review',
      review: {
        approved: true,
        display_name: 'Reusable task',
        description: null,
      },
    });
    draft = service.advancePersonalWorkflow({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      action: 'publish',
      idempotencyKey: 'publish:test',
    });
    expect(draft.status).toBe('published');
    expect(service.listPersonalWorkflows('human:local-owner')).toEqual([]);
    draft = service.activatePersonalWorkflow({
      releaseId: 'release:test',
      principalRef: 'human:local-owner',
      expectedPointerRowVersion: null,
      idempotencyKey: 'activate:test',
    });
    expect(draft.status).toBe('active');
    expect(service.listPersonalWorkflows('human:local-owner')).toEqual([
      { release_id: 'release:test', pointer_row_version: 1 },
    ]);
  });

  it('replays a publishing operation after Runtime response loss', async () => {
    const fixture = linkedStore();
    let loseResponse = true;
    let publishCalls = 0;
    const runtimeGateway = gateway({
      publishPersonalWorkflowRelease: () => {
        publishCalls += 1;
        if (loseResponse) throw new Error('response_lost');
        return { release_id: 'release:recovered', release_hash: sha('r') };
      },
    });
    const service = new TaskWorkspaceService({
      store: fixture.store,
      runtimeGateway: runtimeGateway as never,
      runtimeEventHub: new RuntimeEventHub(),
      coordinator: null,
      coordinatorAgentJid: () => null,
      now: () => 20,
    });
    let draft = await service.createPersonalWorkflowDraft({
      sessionId: fixture.sessionId,
      principalRef: 'human:local-owner',
      workflowId: 'workflow:source',
      runId: 'run:source',
    });
    for (const action of ['validate', 'dry-run'] as const) {
      draft = service.advancePersonalWorkflow({
        draftId: String(draft.draft_id),
        principalRef: 'human:local-owner',
        expectedRowVersion: Number(draft.row_version),
        action,
      });
    }
    draft = service.advancePersonalWorkflow({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      action: 'review',
      review: {
        approved: true,
        display_name: 'Recoverable',
        description: null,
      },
    });
    expect(() =>
      service.advancePersonalWorkflow({
        draftId: String(draft.draft_id),
        principalRef: 'human:local-owner',
        expectedRowVersion: Number(draft.row_version),
        action: 'publish',
        idempotencyKey: 'publish:recover',
      }),
    ).toThrow(/response_lost/);
    expect(fixture.store.listPendingPersonalWorkflowOperations()).toHaveLength(
      1,
    );

    loseResponse = false;
    await service.start();
    expect(
      fixture.store.getPersonalWorkflowDraft(
        String(draft.draft_id),
        'human:local-owner',
      ).status,
    ).toBe('published');
    expect(publishCalls).toBe(2);
    await service.stop();
  });
});
