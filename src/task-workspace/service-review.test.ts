import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowExecutionAdapterReadiness } from '../workflow-execution/adapter-registry.js';
import {
  cloneJson,
  TASK_WORKSPACE_TEMPORARY_REFS,
  TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE,
  WORKFLOW_AGENT_RESULT_SCHEMA_HASH,
} from '../workflow-runtime/gateway/workspace.js';
import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import type { TaskWorkspaceTimelineDeltaV1 } from './contracts.js';
import { RuntimeEventHub } from './runtime-event-hub.js';
import {
  parseTemporaryWorkflowCoordinatorResponse,
  TaskWorkspaceService,
} from './service.js';
import { TaskWorkspaceStore } from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function resolveTemporarySystemRecipe(input: {
  readonly principal_ref: string;
}) {
  return {
    recipe_ref: { id: 'ad_hoc_personal_task', version: '1.0.0' },
    recipe_hash: sha('b'),
    principal_ref: input.principal_ref,
  };
}

function openStore(): TaskWorkspaceStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-workspace-review-'),
  );
  roots.push(root);
  const store = new TaskWorkspaceStore(path.join(root, 'task-workspace.db'));
  stores.push(store);
  return store;
}

function service(
  store: TaskWorkspaceStore,
  runtimeGateway: Record<string, unknown> | null,
  coordinator: {
    chat: (input: Record<string, unknown>) => unknown;
  } | null = null,
  onTimelineDelta?: (delta: TaskWorkspaceTimelineDeltaV1) => void,
  adapterReadiness?: () => WorkflowExecutionAdapterReadiness,
  refreshAdapterReadiness?: () => Promise<WorkflowExecutionAdapterReadiness>,
  runtimeEventHub = new RuntimeEventHub(),
  timelinePollMs?: number,
): TaskWorkspaceService {
  return new TaskWorkspaceService({
    store,
    runtimeGateway: (runtimeGateway
      ? { resolveSystemRecipe: resolveTemporarySystemRecipe, ...runtimeGateway }
      : null) as never,
    runtimeEventHub,
    coordinator: coordinator as never,
    coordinatorAgentJid: () => (coordinator ? 'agent:coordinator' : null),
    adapterReadiness,
    refreshAdapterReadiness,
    timelinePollMs,
    now: () => 100,
    onTimelineDelta,
  });
}

function appendLaunch(
  store: TaskWorkspaceStore,
  mode: 'published_recipe' | 'temporary_workflow',
) {
  let session = store.createSession({
    ownerPrincipalRef: 'human:local-owner',
    title: 'Review test',
    nowMs: 1,
  });
  if (mode === 'published_recipe') {
    session = store.setRunSelection({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      selection: {
        kind: 'published_recipe',
        distribution_kind: 'pack',
        distribution_ref: { id: 'pack.test', version: '1.0.0' },
        recipe_ref: { id: 'recipe:test', version: '1.0.0' },
        recipe_hash: sha('a'),
      },
      expectedRowVersion: session.row_version,
      nowMs: 2,
    });
  }
  const message = store.appendMessage({
    sessionId: session.session_id,
    role: 'human',
    bodyText: 'run review task',
    nowMs: 3,
  });
  const launch = store.createLaunchIntent({
    sessionId: session.session_id,
    sourceMessageId: message.message.message_id,
    mode,
    selectionToken: 'expired-or-restart-invalid',
    selectedRecipeRef:
      mode === 'published_recipe'
        ? { id: 'recipe:test', version: '1.0.0' }
        : { id: 'ad_hoc_personal_task', version: '1.0.0' },
    selectedRecipeHash: mode === 'published_recipe' ? sha('a') : sha('b'),
    effectiveInput: { text: 'run review task', attachments: [] },
    attachmentManifestHash: sha('c'),
    idempotencyKey: `launch:${mode}`,
    nowMs: 4,
  });
  return { session, message: message.message, launch };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for asynchronous Workspace work');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe('TaskWorkspaceService review hardening', () => {
  it('parses only the documented Temporary Coordinator response contract', () => {
    const response = cloneJson(TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE);
    expect(
      parseTemporaryWorkflowCoordinatorResponse(JSON.stringify(response)),
    ).toEqual({
      source: (response.graph_scope as Record<string, unknown>).source,
      risk: response.risk_summary,
    });
    expect(
      parseTemporaryWorkflowCoordinatorResponse(
        JSON.stringify({
          source: (response.graph_scope as Record<string, unknown>).source,
          risk_summary: response.risk_summary,
        }),
      ),
    ).toBeNull();

    const misroutedFailure = cloneJson(response);
    const source = (misroutedFailure.graph_scope as JsonObject)
      .source as JsonObject;
    const failedEdge = (source.control_edges as JsonObject[]).find(
      (edge) => edge.id === 'codex_failed',
    )!;
    failedEdge.to_node_id = 'done';
    expect(
      parseTemporaryWorkflowCoordinatorResponse(
        JSON.stringify(misroutedFailure),
      ),
    ).toBeNull();

    const readOnlyRisk = cloneJson(response);
    (readOnlyRisk.risk_summary as JsonObject).effect_ceiling = 'read_only';
    expect(
      parseTemporaryWorkflowCoordinatorResponse(JSON.stringify(readOnlyRisk)),
    ).toBeNull();
  });

  it('fails a Temporary launch immediately when Runtime is disabled', async () => {
    const store = openStore();
    const coordinator = { chat: vi.fn() };
    const deltas: TaskWorkspaceTimelineDeltaV1[] = [];
    const workspace = service(store, null, coordinator, (delta) =>
      deltas.push(delta),
    );
    const session = workspace.createSession({
      principalRef: 'human:local-owner',
      title: 'Runtime disabled',
    });

    const launch = await workspace.run({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      text: 'run this temporary workflow',
      idempotencyKey: 'run:runtime-disabled',
    });

    expect(launch).toMatchObject({
      status: 'failed',
      last_error_code: expect.stringContaining(
        'WORKFLOW_EXECUTION_ENABLED=true',
      ),
    });
    expect(coordinator.chat).not.toHaveBeenCalled();
    expect(store.getSession(session.session_id).attention_state).toBe('failed');
    expect(
      deltas
        .flatMap((delta) => delta.entries)
        .some(
          (entry) =>
            entry.payload_json.status === 'failed' &&
            String(entry.payload_json.error_code).includes(
              'WORKFLOW_EXECUTION_ENABLED=true',
            ),
        ),
    ).toBe(true);
  });

  it('fails before planning when the Codex Adapter preflight is unavailable', async () => {
    const store = openStore();
    const coordinator = { chat: vi.fn() };
    const runtime = {
      listRecipes: vi.fn(() => ({
        format: 'icarus.workspace-recipe-catalog/1',
        expires_at_ms: 200,
        items: [
          {
            distribution_kind: 'pack',
            distribution_ref: { id: 'pack.example', version: '1.0.0' },
            recipe_ref: { id: 'pack.example.recipe', version: '1.0.0' },
            recipe_hash: sha('b'),
            display_name: 'Example Pack Recipe',
            description: null,
            launch_policy: 'confirm',
            input_summary: {},
            selection_token: 'pack-token',
          },
        ],
      })),
    };
    const deltas: TaskWorkspaceTimelineDeltaV1[] = [];
    const workspace = service(
      store,
      runtime,
      coordinator,
      (delta) => deltas.push(delta),
      () => ({
        status: 'unavailable',
        error:
          'Codex Task Adapter is unavailable: set WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true',
      }),
    );
    const session = workspace.createSession({
      principalRef: 'human:local-owner',
      title: 'Codex preflight unavailable',
    });

    expect(
      (await workspace.listRecipes(session.owner_principal_ref)).items,
    ).toMatchObject([
      { recipe_ref: { id: 'pack.example.recipe', version: '1.0.0' } },
    ]);
    const launch = await workspace.run({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      text: 'run this temporary workflow',
      idempotencyKey: 'run:codex-preflight-unavailable',
    });

    expect(launch).toMatchObject({
      status: 'failed',
      last_error_code: expect.stringContaining(
        'WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true',
      ),
    });
    expect(coordinator.chat).not.toHaveBeenCalled();
    expect(store.getSession(session.session_id)).toMatchObject({
      status: 'open',
      attention_state: 'failed',
    });
    expect(
      deltas
        .flatMap((delta) => delta.entries)
        .some(
          (entry) =>
            entry.payload_json.status === 'failed' &&
            String(entry.payload_json.error_code).includes(
              'WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true',
            ),
        ),
    ).toBe(true);
  });

  it('retries a transient Adapter launch failure without restarting the Host', async () => {
    const store = openStore();
    const coordinator = {
      chat: vi.fn(async () => ({
        ok: true as const,
        text: JSON.stringify(TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE),
        session_id: 'agent-session:readiness-retry',
        run_id: 'agent-run:readiness-retry',
        query_id: 'query:readiness-retry',
        model: 'test',
      })),
    };
    const runtime = {
      listRecipes: vi.fn(() => ({
        format: 'icarus.workspace-recipe-catalog/1',
        expires_at_ms: 1_000,
        items: [
          {
            recipe_ref: { id: 'ad_hoc_personal_task', version: '1.4.0' },
            recipe_hash: sha('b'),
            selection_token: 'temporary-token',
          },
        ],
      })),
      refreshRecipeSelection: vi.fn(() => ({
        selection_token: 'temporary-token:refreshed',
      })),
      prepareTemporaryDraft: vi.fn(() => ({
        source_hash: sha('d'),
        compiled_plan_json: { format: 'compiled-plan' },
        compiled_plan_hash: sha('e'),
        compiler_version: 'test',
        resource_closure_hash: sha('f'),
        policy_ceiling_hash: sha('1'),
        risk_summary_json: {},
      })),
    };
    const refreshReadiness = vi
      .fn<() => Promise<WorkflowExecutionAdapterReadiness>>()
      .mockResolvedValueOnce({
        status: 'unavailable',
        error: 'Codex App Server connection is temporarily unavailable',
        failureKind: 'transient',
        checkedAtMs: 100,
      })
      .mockResolvedValue({
        status: 'ready',
        error: null,
        checkedAtMs: 101,
      });
    const workspace = service(
      store,
      runtime,
      coordinator,
      undefined,
      undefined,
      refreshReadiness,
    );
    const session = workspace.createSession({
      principalRef: 'human:local-owner',
      title: 'Readiness retry',
    });

    await expect(
      workspace.run({
        sessionId: session.session_id,
        principalRef: session.owner_principal_ref,
        text: 'first attempt',
        idempotencyKey: 'run:readiness:first',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      last_error_code: 'Codex App Server connection is temporarily unavailable',
    });
    expect(coordinator.chat).not.toHaveBeenCalled();
    expect(store.getSession(session.session_id).attention_state).toBe('failed');

    await expect(
      workspace.run({
        sessionId: session.session_id,
        principalRef: session.owner_principal_ref,
        text: 'retry after recovery',
        idempotencyKey: 'run:readiness:second',
      }),
    ).resolves.toMatchObject({ mode: 'temporary_workflow' });
    await waitFor(() => coordinator.chat.mock.calls.length === 1);
    const retried = store.findLaunchIntentByIdempotencyKey(
      'run:readiness:second',
    );
    expect(retried).toMatchObject({
      status: 'awaiting_confirmation',
      last_error_code: null,
    });
    expect(store.getSession(session.session_id).attention_state).toBe(
      'waiting_user',
    );
  });

  it('makes interrupted Temporary planning actionable after Host restart', async () => {
    const initial = openStore();
    const target = appendLaunch(initial, 'temporary_workflow');
    const pending = initial.ensureCoordinatorTurn({
      sessionId: target.session.session_id,
      sourceMessageId: target.message.message_id,
      nowMs: 5,
    });
    const running = initial.claimCoordinatorTurn(pending.turn_id, 6);
    if (!running) throw new Error('Planning turn was not claimed');
    expect(running.status).toBe('running');
    const databasePath = initial.databasePath;
    initial.close();

    const restarted = new TaskWorkspaceStore(databasePath);
    stores.push(restarted);
    expect(restarted.getCoordinatorTurn(running.turn_id)).toMatchObject({
      status: 'interrupted',
      error_code: 'host_restarted',
    });
    expect(
      restarted.getLaunchIntent(target.launch.launch_intent_id).status,
    ).toBe('drafting');
    const workspace = service(restarted, null);

    await workspace.start();

    expect(
      restarted.getLaunchIntent(target.launch.launch_intent_id),
    ).toMatchObject({
      status: 'failed',
      last_error_code: 'temporary_planning_interrupted',
    });
    await workspace.stop();
  });

  it('replays Run idempotency before refreshing selection or writing another message', async () => {
    const store = openStore();
    let session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Idempotent Run',
      nowMs: 1,
    });
    session = store.setRunSelection({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      selection: {
        kind: 'published_recipe',
        distribution_kind: 'pack',
        distribution_ref: { id: 'pack.test', version: '1.0.0' },
        recipe_ref: { id: 'recipe:test', version: '1.0.0' },
        recipe_hash: sha('a'),
      },
      expectedRowVersion: session.row_version,
      nowMs: 2,
    });
    const refresh = vi
      .fn()
      .mockReturnValueOnce({ selection_token: 'fresh-token' })
      .mockImplementationOnce(() => {
        throw new Error('selection should not refresh during replay');
      });
    const runtime = {
      refreshRecipeSelection: refresh,
      launchPublished: vi.fn(() => ({
        workflowId: 'workflow:idempotent',
        intakeId: 'intake:idempotent',
        creationRequestId: 'creation:idempotent',
      })),
      findCreation: vi.fn(() => ({ found: true })),
    };
    const workspace = service(store, runtime);
    const request = {
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      text: 'run once',
      idempotencyKey: 'run:idempotent',
    };

    const first = await workspace.run(request);
    const current = store.getSession(session.session_id);
    store.setRunSelection({
      sessionId: current.session_id,
      principalRef: current.owner_principal_ref,
      selection: { kind: 'temporary_workflow' },
      expectedRowVersion: current.row_version,
      nowMs: 3,
    });
    const replay = await workspace.run(request);

    expect(replay.launch_intent_id).toBe(first.launch_intent_id);
    expect(replay.mode).toBe('published_recipe');
    expect(replay.status).toBe('linked');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.listMessages(session.session_id)).toHaveLength(1);
  });

  it('launches a confirmed Temporary draft without a public selection token', async () => {
    const store = openStore();
    const target = appendLaunch(store, 'temporary_workflow');
    const revision = store.createTemporaryRevision({
      launchIntentId: target.launch.launch_intent_id,
      sourceMessageId: target.message.message_id,
      source: { format: 'source' },
      sourceHash: sha('d'),
      compiledPlan: { format: 'plan' },
      compiledPlanHash: sha('e'),
      compilerVersion: 'test',
      resourceClosureHash: sha('f'),
      policyCeilingHash: sha('1'),
      riskSummary: {},
      nowMs: 5,
    });
    const launchTemporary = vi.fn((_request: Record<string, unknown>) => ({
      workflowId: 'workflow:temporary',
      intakeId: 'intake:temporary',
      creationRequestId: 'creation:temporary',
    }));
    const runtime = {
      launchTemporary,
    };
    const workspace = service(store, runtime);

    const result = await workspace.confirmTemporary({
      launchIntentId: target.launch.launch_intent_id,
      revisionId: revision.revision_id,
      principalRef: target.session.owner_principal_ref,
      expectedRowVersion: store.getLaunchIntent(target.launch.launch_intent_id)
        .row_version,
    });

    expect(launchTemporary.mock.calls[0]?.[0]).toMatchObject({
      confirmed_revision_id: revision.revision_id,
    });
    expect(launchTemporary.mock.calls[0]?.[0]).not.toHaveProperty(
      'selection_token',
    );
    expect(result.status).toBe('linked');
  });

  it('compiles through the System Recipe and persists Agent identity for a Temporary revision', async () => {
    const store = openStore();
    const target = appendLaunch(store, 'temporary_workflow');
    const coordinator = {
      chat: vi.fn(async (_input: Record<string, unknown>) => ({
        ok: true as const,
        text: JSON.stringify(TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE),
        session_id: 'agent-session:planner',
        run_id: 'agent-run:planner',
        query_id: 'query:planner',
        model: 'test',
      })),
    };
    const prepareTemporaryDraft = vi.fn(
      (_request: Record<string, unknown>) => ({
        source_hash: sha('d'),
        compiled_plan_json: { format: 'compiled-plan' },
        compiled_plan_hash: sha('e'),
        compiler_version: 'test',
        resource_closure_hash: sha('f'),
        policy_ceiling_hash: sha('1'),
        risk_summary_json: {},
      }),
    );
    const runtime = {
      prepareTemporaryDraft,
    };
    const workspace = service(store, runtime, coordinator);

    const revision = await workspace.reviseTemporary({
      launchIntentId: target.launch.launch_intent_id,
      principalRef: target.session.owner_principal_ref,
      instruction: 'revise the plan',
    });

    expect(prepareTemporaryDraft.mock.calls[0]?.[0]).toMatchObject({
      principal_ref: target.session.owner_principal_ref,
      source_json: (
        TEMPORARY_WORKFLOW_COORDINATOR_EXAMPLE.graph_scope as JsonObject
      ).source,
    });
    expect(prepareTemporaryDraft.mock.calls[0]?.[0]).not.toHaveProperty(
      'selection_token',
    );
    const system = String(coordinator.chat.mock.calls[0]?.[0]?.system);
    expect(system).toContain(TASK_WORKSPACE_TEMPORARY_REFS.capability.id);
    expect(system).toContain(WORKFLOW_AGENT_RESULT_SCHEMA_HASH);
    expect(system).toContain('response_schema');
    expect(revision.source_message_id).not.toBe(target.message.message_id);
    expect(
      store.getSession(target.session.session_id).coordinator_agent_session_id,
    ).toBe('agent-session:planner');
    expect(
      store.ensureCoordinatorTurn({
        sessionId: target.session.session_id,
        sourceMessageId: revision.source_message_id,
      }),
    ).toMatchObject({ status: 'completed', query_id: 'query:planner' });
  });

  it('exact-replays a creating Published intent when Runtime lookup is empty', async () => {
    const store = openStore();
    const target = appendLaunch(store, 'published_recipe');
    const launchPublished = vi.fn(() => ({
      workflowId: 'workflow:replayed',
      intakeId: 'intake:replayed',
      creationRequestId: 'creation:replayed',
    }));
    const runtime = {
      findCreation: vi.fn(() => ({ found: false })),
      refreshRecipeSelection: vi.fn(() => ({ selection_token: 'fresh-token' })),
      launchPublished,
      getRuntimeDetail: vi.fn(() => ({
        format: 'icarus.workspace-runtime-detail/1',
        freshness: 'ready',
        workflows: [],
      })),
    };
    const workspace = service(store, runtime);

    await workspace.getSession(
      target.session.session_id,
      target.session.owner_principal_ref,
    );

    expect(launchPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        selection_token: 'fresh-token',
        launch: expect.objectContaining({
          request_id: target.launch.launch_intent_id,
          creation_domain: target.launch.creation_domain,
          creation_key: target.launch.creation_key,
          effective_input_hash: target.launch.effective_input_hash,
        }),
      }),
    );
    expect(store.getLaunchIntent(target.launch.launch_intent_id).status).toBe(
      'linked',
    );
  });

  it('persists Coordinator diagnostics instead of compiling a no-op draft', async () => {
    const store = openStore();
    const coordinator = {
      chat: vi.fn(async () => ({
        ok: true as const,
        text: 'not-json',
        session_id: 'agent-session:invalid',
        run_id: 'agent-run:invalid',
        query_id: 'query:invalid',
        model: 'test',
      })),
    };
    const runtime = {
      listRecipes: () => ({
        format: 'icarus.workspace-recipe-catalog/1',
        expires_at_ms: 200,
        items: [
          {
            recipe_ref: { id: 'ad_hoc_personal_task', version: '1.0.0' },
            recipe_hash: sha('b'),
            selection_token: 'initial-token',
          },
        ],
      }),
      refreshRecipeSelection: vi.fn(() => ({ selection_token: 'fresh-token' })),
      prepareTemporaryDraft: vi.fn(),
    };
    const deltas: TaskWorkspaceTimelineDeltaV1[] = [];
    const workspace = service(store, runtime, coordinator, (delta) =>
      deltas.push(delta),
    );
    const session = workspace.createSession({
      principalRef: 'human:local-owner',
      title: 'Invalid planner output',
    });

    const launch = await workspace.run({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      text: 'plan this task',
      idempotencyKey: 'run:invalid-planner',
    });
    await waitFor(
      () => store.getLaunchIntent(launch.launch_intent_id).status === 'failed',
    );

    const failed = store.getLaunchIntent(launch.launch_intent_id);
    const turn = store.ensureCoordinatorTurn({
      sessionId: session.session_id,
      sourceMessageId: launch.source_message_id,
    });
    expect(failed.last_error_code).toMatch(/valid Temporary Workflow/);
    expect(turn).toMatchObject({
      status: 'failed',
      query_id: 'query:invalid',
    });
    expect(runtime.prepareTemporaryDraft).not.toHaveBeenCalled();
    expect(store.getSession(session.session_id).attention_state).toBe('failed');
    expect(
      deltas
        .flatMap((delta) => delta.entries)
        .some((entry) => entry.payload_json.status === 'failed'),
    ).toBe(true);
    expect(
      store
        .listTimeline(session.session_id)
        .some(
          (entry) =>
            entry.payload_json.interaction_kind === 'temporary_confirmation',
        ),
    ).toBe(false);
  });

  it('rehydrates messages and Runtime summary after an Agent session is lost', async () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Recover coordinator',
      nowMs: 1,
    });
    store.replaceCoordinatorAgentSession({
      sessionId: session.session_id,
      expectedAgentSessionId: null,
      agentSessionId: 'agent-session:missing',
      nowMs: 2,
    });
    const coordinator = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          error: 'No conversation found for session',
          run_id: 'agent-run:missing',
          query_id: 'query:missing',
        })
        .mockResolvedValueOnce({
          ok: true,
          text: 'Recovered response',
          session_id: 'agent-session:new',
          run_id: 'agent-run:new',
          query_id: 'query:new',
          model: 'test',
        }),
    };
    const workspace = service(store, null, coordinator);

    const sent = await workspace.send({
      sessionId: session.session_id,
      principalRef: session.owner_principal_ref,
      text: 'remember this request',
    });
    await waitFor(() => store.listMessages(session.session_id).length === 2);

    expect(coordinator.chat.mock.calls[0]?.[0]).toMatchObject({
      session_id: 'agent-session:missing',
    });
    expect(coordinator.chat.mock.calls[1]?.[0]).not.toHaveProperty(
      'session_id',
    );
    expect(String(coordinator.chat.mock.calls[1]?.[0]?.message)).toContain(
      'remember this request',
    );
    expect(
      store.getSession(session.session_id).coordinator_agent_session_id,
    ).toBe('agent-session:new');
    expect(store.getCoordinatorTurn(sent.turn!.turn_id)).toMatchObject({
      status: 'completed',
      query_id: 'query:new',
    });
  });

  it('persists typed Runtime Artifact links without copying inline values', async () => {
    const store = openStore();
    const target = appendLaunch(store, 'temporary_workflow');
    store.addExecutionLink({
      session_id: target.session.session_id,
      workflow_id: 'workflow:artifact',
      intake_id: 'intake:artifact',
      creation_request_id: 'creation:artifact',
      launch_intent_id: target.launch.launch_intent_id,
      created_at_ms: 5,
    });
    const runtime = {
      getRuntimeDetail: () => ({
        format: 'icarus.workspace-runtime-detail/1',
        freshness: 'ready',
        workflows: [
          {
            id: 'workflow:artifact',
            availability: 'available',
            runs: [],
            pending: [],
            artifacts: [
              {
                artifact_ref: 'value:artifact',
                artifact_hash: sha('9'),
                graph_run_id: 'run:artifact',
                node_id: 'node:artifact',
                attempt_id: 'attempt:artifact',
                media_type: 'application/json',
                byte_length: 42,
                payload_state: 'live',
                inline_value_json: { secret: 'not-copied' },
                display_json: {
                  title: 'Runtime report',
                  path: '/workspace/run-once/output/report.json',
                  relative_path: 'output/report.json',
                  download_url: '/api/artifacts/report.json',
                  media_type: 'application/json',
                  byte_length: 42,
                  payload_state: 'live',
                },
              },
            ],
          },
        ],
      }),
    };
    const workspace = service(store, runtime);

    const detail = await workspace.runtimeDetail(
      target.session.session_id,
      target.session.owner_principal_ref,
    );

    expect(detail.artifact_links).toHaveLength(1);
    expect(detail.artifact_links[0]).toMatchObject({
      workflow_id: 'workflow:artifact',
      artifact_ref: 'value:artifact',
      artifact_hash: sha('9'),
      display_json: {
        graph_run_id: 'run:artifact',
        node_id: 'node:artifact',
        title: 'Runtime report',
        relative_path: 'output/report.json',
        download_url: '/api/artifacts/report.json',
        media_type: 'application/json',
      },
    });
    expect(detail.artifact_links[0]?.display_json).not.toHaveProperty(
      'inline_value_json',
    );
  });

  it.each([
    {
      name: 'success',
      outcome: 'normal',
      errorCode: null,
      status: 'open',
      attention: 'none',
    },
    {
      name: 'failure',
      outcome: 'errored',
      errorCode: 'ad_hoc_workflow_failed',
      status: 'open',
      attention: 'failed',
    },
    {
      name: 'cancelled',
      outcome: 'cancelled',
      errorCode: null,
      status: 'open',
      attention: 'none',
    },
  ] as const)(
    'projects Runtime $name into Task attention without owning Task status',
    async (scenario) => {
      const store = openStore();
      const target = appendLaunch(store, 'temporary_workflow');
      store.addExecutionLink({
        session_id: target.session.session_id,
        workflow_id: `workflow:${scenario.name}`,
        intake_id: `intake:${scenario.name}`,
        creation_request_id: `creation:${scenario.name}`,
        launch_intent_id: target.launch.launch_intent_id,
        created_at_ms: 5,
      });
      const runtime = {
        listRecipes: () => ({
          format: 'icarus.workspace-recipe-catalog/1',
          expires_at_ms: 1_000,
          items: [
            {
              recipe_ref: {
                id: 'ad_hoc_personal_task',
                version: '1.4.0',
              },
              recipe_hash: sha('b'),
              selection_token: 'temporary-token',
            },
          ],
        }),
        getRuntimeDetail: () => ({
          format: 'icarus.workspace-runtime-detail/1',
          freshness: 'ready',
          workflows: [
            {
              id: `workflow:${scenario.name}`,
              availability: 'available',
              final_outcome_kind: scenario.outcome,
              final_error_code: scenario.errorCode,
              runs: [],
              pending: [],
              artifacts: [],
            },
          ],
        }),
      };
      const workspace = service(store, runtime);

      const result = await workspace.getSession(
        target.session.session_id,
        target.session.owner_principal_ref,
      );

      expect(result.session).toMatchObject({
        status: scenario.status,
        attention_state: scenario.attention,
      });
      await expect(
        workspace.send({
          sessionId: target.session.session_id,
          principalRef: target.session.owner_principal_ref,
          text: `follow up after ${scenario.name}`,
        }),
      ).resolves.toMatchObject({ message: { role: 'human' } });
      await expect(
        workspace.run({
          sessionId: target.session.session_id,
          principalRef: target.session.owner_principal_ref,
          text: `run again after ${scenario.name}`,
          idempotencyKey: `run:after:${scenario.name}`,
        }),
      ).resolves.toMatchObject({
        session_id: target.session.session_id,
        mode: 'temporary_workflow',
      });
    },
  );

  it.each(['completed', 'cancelled', 'archived'] as const)(
    'does not rewrite a manually %s Task during Runtime catch-up',
    async (status) => {
      const store = openStore();
      const target = appendLaunch(store, 'temporary_workflow');
      store.addExecutionLink({
        session_id: target.session.session_id,
        workflow_id: `workflow:manual:${status}`,
        intake_id: `intake:manual:${status}`,
        creation_request_id: `creation:manual:${status}`,
        launch_intent_id: target.launch.launch_intent_id,
        created_at_ms: 5,
      });
      const current = store.getSession(target.session.session_id);
      store.updateSessionStatus({
        sessionId: current.session_id,
        principalRef: current.owner_principal_ref,
        status,
        expectedRowVersion: current.row_version,
        nowMs: 6,
      });
      const workspace = service(store, {
        getRuntimeDetail: () => ({
          format: 'icarus.workspace-runtime-detail/1',
          freshness: 'ready',
          workflows: [
            {
              id: `workflow:manual:${status}`,
              availability: 'available',
              status: 'errored',
              final_outcome_kind: 'errored',
              final_error_code: 'late_runtime_failure',
              runs: [],
              pending: [],
              artifacts: [],
            },
          ],
        }),
      });

      const caughtUp = await workspace.getSession(
        target.session.session_id,
        target.session.owner_principal_ref,
      );

      expect(caughtUp.session).toMatchObject({
        status,
        attention_state: 'failed',
      });
    },
  );

  it('preserves a new Temporary confirmation across get, poll, and an old Workflow hint', async () => {
    const store = openStore();
    const old = appendLaunch(store, 'temporary_workflow');
    const oldLinked = store.updateLaunchStatus({
      launchIntentId: old.launch.launch_intent_id,
      expectedRowVersion: old.launch.row_version,
      status: 'linked',
      nowMs: 5,
    });
    store.addExecutionLink({
      session_id: old.session.session_id,
      workflow_id: 'workflow:old-success',
      intake_id: 'intake:old-success',
      creation_request_id: 'creation:old-success',
      launch_intent_id: oldLinked.launch_intent_id,
      created_at_ms: 6,
    });
    const message = store.appendMessage({
      sessionId: old.session.session_id,
      role: 'human',
      bodyText: 'plan a newer temporary task',
      nowMs: 7,
    });
    const launch = store.createLaunchIntent({
      sessionId: old.session.session_id,
      sourceMessageId: message.message.message_id,
      mode: 'temporary_workflow',
      effectiveInput: { text: 'plan a newer temporary task' },
      attachmentManifestHash: sha('d'),
      idempotencyKey: 'launch:newer-awaiting',
      nowMs: 8,
    });
    store.createTemporaryRevision({
      launchIntentId: launch.launch_intent_id,
      sourceMessageId: message.message.message_id,
      source: { format: 'source' },
      sourceHash: sha('e'),
      compiledPlan: { format: 'plan' },
      compiledPlanHash: sha('f'),
      compilerVersion: 'test',
      resourceClosureHash: sha('1'),
      policyCeilingHash: sha('2'),
      riskSummary: {},
      nowMs: 9,
    });
    const getRuntimeDetail = vi.fn(() => ({
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows: [
        {
          id: 'workflow:old-success',
          availability: 'available',
          status: 'completed',
          final_outcome_kind: 'normal',
          runs: [],
          pending: [],
          artifacts: [],
        },
      ],
    }));
    const runtimeEventHub = new RuntimeEventHub();
    const workspace = service(
      store,
      { getRuntimeDetail },
      null,
      undefined,
      undefined,
      undefined,
      runtimeEventHub,
      1,
    );

    await workspace.getSession(
      old.session.session_id,
      old.session.owner_principal_ref,
    );
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'waiting_user',
    );

    await workspace.start();
    await waitFor(() => getRuntimeDetail.mock.calls.length >= 3);
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'waiting_user',
    );

    runtimeEventHub.notify({
      workflow_id: 'workflow:old-success',
      reason: 'old_workflow_hint',
    });
    await waitFor(() => getRuntimeDetail.mock.calls.length >= 4);
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'waiting_user',
    );
    await workspace.stop();
  });

  it.each(['failed', 'unsupported'] as const)(
    'preserves a new unlinked %s Launch across old successful Workflow catch-up',
    async (status) => {
      const store = openStore();
      const old = appendLaunch(store, 'temporary_workflow');
      const oldLinked = store.updateLaunchStatus({
        launchIntentId: old.launch.launch_intent_id,
        expectedRowVersion: old.launch.row_version,
        status: 'linked',
        nowMs: 5,
      });
      store.addExecutionLink({
        session_id: old.session.session_id,
        workflow_id: 'workflow:old-success',
        intake_id: 'intake:old-success',
        creation_request_id: 'creation:old-success',
        launch_intent_id: oldLinked.launch_intent_id,
        created_at_ms: 6,
      });
      const message = store.appendMessage({
        sessionId: old.session.session_id,
        role: 'human',
        bodyText: 'start a newer launch',
        nowMs: 7,
      });
      const launch = store.createLaunchIntent({
        sessionId: old.session.session_id,
        sourceMessageId: message.message.message_id,
        mode: 'temporary_workflow',
        effectiveInput: { text: 'start a newer launch' },
        attachmentManifestHash: sha('3'),
        idempotencyKey: `launch:newer:${status}`,
        nowMs: 8,
      });
      store.updateLaunchStatus({
        launchIntentId: launch.launch_intent_id,
        expectedRowVersion: launch.row_version,
        status,
        errorCode: `${status}:test`,
        nowMs: 9,
      });
      const workspace = service(store, {
        getRuntimeDetail: () => ({
          format: 'icarus.workspace-runtime-detail/1',
          freshness: 'ready',
          workflows: [
            {
              id: 'workflow:old-success',
              availability: 'available',
              status: 'completed',
              final_outcome_kind: 'normal',
              runs: [],
              pending: [],
              artifacts: [],
            },
          ],
        }),
      });

      await workspace.getSession(
        old.session.session_id,
        old.session.owner_principal_ref,
      );

      expect(store.getSession(old.session.session_id).attention_state).toBe(
        'failed',
      );
    },
  );

  it('downgrades resolved Workspace attention to the remaining Runtime authority', async () => {
    const store = openStore();
    const old = appendLaunch(store, 'temporary_workflow');
    const oldLinked = store.updateLaunchStatus({
      launchIntentId: old.launch.launch_intent_id,
      expectedRowVersion: old.launch.row_version,
      status: 'linked',
      nowMs: 5,
    });
    store.addExecutionLink({
      session_id: old.session.session_id,
      workflow_id: 'workflow:action-required',
      intake_id: 'intake:action-required',
      creation_request_id: 'creation:action-required',
      launch_intent_id: oldLinked.launch_intent_id,
      created_at_ms: 6,
    });
    const message = store.appendMessage({
      sessionId: old.session.session_id,
      role: 'human',
      bodyText: 'plan another task',
      nowMs: 7,
    });
    const launch = store.createLaunchIntent({
      sessionId: old.session.session_id,
      sourceMessageId: message.message.message_id,
      mode: 'temporary_workflow',
      effectiveInput: { text: 'plan another task' },
      attachmentManifestHash: sha('4'),
      idempotencyKey: 'launch:attention-downgrade',
      nowMs: 8,
    });
    const revision = store.createTemporaryRevision({
      launchIntentId: launch.launch_intent_id,
      sourceMessageId: message.message.message_id,
      source: { format: 'source' },
      sourceHash: sha('5'),
      compiledPlan: { format: 'plan' },
      compiledPlanHash: sha('6'),
      compilerVersion: 'test',
      resourceClosureHash: sha('7'),
      policyCeilingHash: sha('8'),
      riskSummary: {},
      nowMs: 9,
    });
    let runtimeStatus = 'active';
    const workspace = service(store, {
      getRuntimeDetail: () => ({
        format: 'icarus.workspace-runtime-detail/1',
        freshness: 'ready',
        workflows: [
          {
            id: 'workflow:action-required',
            availability: 'available',
            status: runtimeStatus,
            operational_state:
              runtimeStatus === 'active' ? 'action_required' : 'healthy',
            final_outcome_kind: runtimeStatus === 'active' ? null : 'normal',
            runs: [],
            pending: [],
            artifacts: [],
          },
        ],
      }),
    });
    await workspace.getSession(
      old.session.session_id,
      old.session.owner_principal_ref,
    );
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'waiting_user',
    );

    const awaiting = store.getLaunchIntent(launch.launch_intent_id);
    store.confirmCurrentTemporaryRevision({
      launchIntentId: launch.launch_intent_id,
      revisionId: revision.revision_id,
      expectedRowVersion: awaiting.row_version,
      nowMs: 10,
    });
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'action_required',
    );

    runtimeStatus = 'completed';
    await workspace.getSession(
      old.session.session_id,
      old.session.owner_principal_ref,
    );
    expect(store.getSession(old.session.session_id).attention_state).toBe(
      'none',
    );
  });

  it('aggregates all linked Workflows independently of result order and event hints', async () => {
    const store = openStore();
    const target = appendLaunch(store, 'temporary_workflow');
    const newerMessage = store.appendMessage({
      sessionId: target.session.session_id,
      role: 'human',
      bodyText: 'run a second workflow',
      nowMs: 5,
    });
    const newerLaunch = store.createLaunchIntent({
      sessionId: target.session.session_id,
      sourceMessageId: newerMessage.message.message_id,
      mode: 'temporary_workflow',
      effectiveInput: { text: 'run a second workflow' },
      attachmentManifestHash: sha('d'),
      idempotencyKey: 'launch:multi-workflow:newer',
      nowMs: 6,
    });
    for (const [key, launchIntentId, createdAtMs] of [
      ['older', target.launch.launch_intent_id, 7],
      ['newer', newerLaunch.launch_intent_id, 8],
    ] as const) {
      store.addExecutionLink({
        session_id: target.session.session_id,
        workflow_id: `workflow:${key}`,
        intake_id: `intake:${key}`,
        creation_request_id: `creation:${key}`,
        launch_intent_id: launchIntentId,
        created_at_ms: createdAtMs,
      });
    }
    let workflows: JsonObject[] = [
      {
        id: 'workflow:older',
        availability: 'available',
        status: 'errored',
        final_outcome_kind: 'errored',
        runs: [{ id: 'run:older' }],
        pending: [],
        artifacts: [],
      },
      {
        id: 'workflow:newer',
        availability: 'available',
        status: 'completed',
        final_outcome_kind: 'normal',
        runs: [{ id: 'run:newer' }],
        pending: [],
        artifacts: [],
      },
    ];
    const getRuntimeDetail = vi.fn(() => ({
      format: 'icarus.workspace-runtime-detail/1',
      freshness: 'ready',
      workflows,
    }));
    const listRuntimeEvents = vi.fn((input: { workflow_id: string }) => ({
      format: 'icarus.workspace-runtime-event-page/1',
      workflow_id: input.workflow_id,
      run_id:
        input.workflow_id === 'workflow:older' ? 'run:older' : 'run:newer',
      events: [],
      next_event_seq: 0,
      has_more: false,
    }));
    let hintListener: Parameters<RuntimeEventHub['subscribe']>[0] | null = null;
    const runtimeEventHub = {
      subscribe: vi.fn(
        (listener: Parameters<RuntimeEventHub['subscribe']>[0]) => {
          hintListener = listener;
          return () => {
            hintListener = null;
          };
        },
      ),
    } as unknown as RuntimeEventHub;
    const workspace = service(
      store,
      { getRuntimeDetail, listRuntimeEvents },
      null,
      undefined,
      undefined,
      undefined,
      runtimeEventHub,
    );
    await workspace.start();
    expect(store.getSession(target.session.session_id).attention_state).toBe(
      'failed',
    );

    workflows = [...workflows].reverse();
    getRuntimeDetail.mockClear();
    listRuntimeEvents.mockClear();
    await hintListener!({
      workflow_id: 'workflow:newer',
      run_id: 'run:newer',
      reason: 'late_terminal_hint',
    });
    expect(getRuntimeDetail).toHaveBeenLastCalledWith({
      principal_ref: target.session.owner_principal_ref,
      workflow_ids: ['workflow:older', 'workflow:newer'],
    });
    expect(listRuntimeEvents).toHaveBeenCalledTimes(1);
    expect(listRuntimeEvents.mock.calls[0]?.[0]).toMatchObject({
      workflow_id: 'workflow:newer',
    });
    expect(store.getSession(target.session.session_id).attention_state).toBe(
      'failed',
    );

    workflows = [
      {
        ...workflows.find((workflow) => workflow.id === 'workflow:older')!,
        availability: 'available',
        status: 'active',
        operational_state: 'action_required',
        final_outcome_kind: null,
      },
      {
        ...workflows.find((workflow) => workflow.id === 'workflow:newer')!,
        pending: [{ id: 'wait:newer' }],
      },
    ];
    await workspace.getSession(
      target.session.session_id,
      target.session.owner_principal_ref,
    );
    expect(store.getSession(target.session.session_id).attention_state).toBe(
      'waiting_user',
    );

    workflows = workflows.map((workflow) => ({ ...workflow, pending: [] }));
    await workspace.getSession(
      target.session.session_id,
      target.session.owner_principal_ref,
    );
    expect(store.getSession(target.session.session_id).attention_state).toBe(
      'action_required',
    );
    await workspace.stop();
  });
});
