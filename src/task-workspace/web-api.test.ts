import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { TaskWorkspaceService } from './service.js';
import { TaskWorkspaceWebApi } from './web-api.js';

const SNAPSHOT_HASH = `sha256:${'a'.repeat(64)}`;
const PAYLOAD_HASH = `sha256:${'b'.repeat(64)}`;

interface ApiServiceStub {
  readonly createCommandProposal: ReturnType<typeof vi.fn>;
  readonly resolveRuntimeLink: ReturnType<typeof vi.fn>;
  readonly listReplans: ReturnType<typeof vi.fn>;
  readonly createReplan: ReturnType<typeof vi.fn>;
  readonly confirmReplan: ReturnType<typeof vi.fn>;
  readonly cancelReplan: ReturnType<typeof vi.fn>;
  readonly submitInteraction: ReturnType<typeof vi.fn>;
  readonly createPersonalWorkflowDraft: ReturnType<typeof vi.fn>;
  readonly revisePersonalWorkflow: ReturnType<typeof vi.fn>;
  readonly advancePersonalWorkflow: ReturnType<typeof vi.fn>;
  readonly activatePersonalWorkflow: ReturnType<typeof vi.fn>;
}

function apiServiceStub(): ApiServiceStub {
  return {
    createCommandProposal: vi.fn(() => ({ proposal_id: 'proposal:test' })),
    resolveRuntimeLink: vi.fn(() => ({
      link: {
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id: 'session:test',
      },
      execution_link: { workflow_id: 'workflow:test' },
    })),
    listReplans: vi.fn(() => [
      { replan_id: 'replan:test', status: 'awaiting_confirmation' },
    ]),
    createReplan: vi.fn(() => ({ replan_id: 'replan:test' })),
    confirmReplan: vi.fn(() => ({
      replan_id: 'replan:test',
      status: 'applying',
    })),
    cancelReplan: vi.fn(() => ({
      replan_id: 'replan:test',
      status: 'cancelled',
    })),
    submitInteraction: vi.fn(() => ({
      interaction: { interaction_id: 'interaction:test', status: 'accepted' },
      receipt: { disposition: 'accepted' },
    })),
    createPersonalWorkflowDraft: vi.fn(() => ({ draft_id: 'draft:test' })),
    revisePersonalWorkflow: vi.fn(() => ({
      draft_id: 'draft:test',
      status: 'draft',
    })),
    advancePersonalWorkflow: vi.fn(() => ({
      draft_id: 'draft:test',
      status: 'reviewed',
    })),
    activatePersonalWorkflow: vi.fn(() => ({
      draft_id: 'draft:test',
      status: 'active',
    })),
  };
}

describe('Task Workspace typed navigation Web API', () => {
  it('resolves a Runtime Workflow to an owned TaskSession link', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await getJson(
        baseUrl,
        '/api/task-workspace/runtime-links/workflows/workflow%3Atest',
      );
      expect(response).toEqual({
        status: 200,
        body: {
          link: {
            format: 'icarus.task-workspace-link/1',
            target: 'session',
            session_id: 'session:test',
          },
          execution_link: { workflow_id: 'workflow:test' },
        },
      });
    });
    expect(service.resolveRuntimeLink).toHaveBeenCalledWith(
      'workflow:test',
      'human:test-principal',
    );
  });
});

function apiFor(service: ApiServiceStub): TaskWorkspaceWebApi {
  return new TaskWorkspaceWebApi(
    service as unknown as TaskWorkspaceService,
    'human:test-principal',
  );
}

async function withApiServer(
  api: TaskWorkspaceWebApi,
  work: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    void api.handle(req, res, new URL(req.url ?? '/', 'http://localhost'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try {
    await work(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function postJson(
  baseUrl: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function getJson(
  baseUrl: string,
  pathname: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function commandBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workflow_id: 'workflow:test',
    run_id: 'run:test',
    action: 'pause',
    expected_target_row_version: 7,
    idempotency_key: 'command:test',
    ...overrides,
  };
}

function interactionBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rendered_snapshot_hash: SNAPSHOT_HASH,
    action_id: 'approve',
    payload_json: { approved: true },
    payload_hash: PAYLOAD_HASH,
    expected_target_row_version: 4,
    idempotency_key: 'interaction:test',
    ...overrides,
  };
}

function replanBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workflow_id: 'workflow:test',
    run_id: 'run:test',
    instruction: 'Replace the remaining report step with a reviewed summary.',
    idempotency_key: 'replan:test',
    ...overrides,
  };
}

function without(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const result = { ...body };
  delete result[field];
  return result;
}

function expectClosedBodyRejection(response: {
  status: number;
  body: Record<string, unknown>;
}): void {
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    error: {
      code: 'invalid_request',
      message: expect.stringContaining('Request fields must be exactly'),
      retryable: false,
    },
  });
}

describe('Task Workspace runtime command Web API', () => {
  it.each(['pause', 'resume', 'cancel'] as const)(
    'accepts the exact closed %s request and derives the authenticated principal',
    async (action) => {
      const service = apiServiceStub();
      await withApiServer(apiFor(service), async (baseUrl) => {
        const response = await postJson(
          baseUrl,
          '/api/task-workspace/sessions/session%3Atest/runtime-command-proposals',
          commandBody({ action }),
        );

        expect(response).toEqual({
          status: 201,
          body: { proposal: { proposal_id: 'proposal:test' } },
        });
      });
      expect(service.createCommandProposal).toHaveBeenCalledOnce();
      expect(service.createCommandProposal).toHaveBeenCalledWith({
        sessionId: 'session:test',
        principalRef: 'human:test-principal',
        workflowId: 'workflow:test',
        runId: 'run:test',
        action,
        expectedTargetRowVersion: 7,
        idempotencyKey: 'command:test',
      });
    },
  );

  it.each([
    ['raw command JSON', 'command_json', { command_type: 'pause_run' }],
    ['caller-selected actor', 'actor_ref', 'human:forged'],
    ['caller-selected permissions', 'permissions', ['workflow.run.pause']],
    ['caller-selected schemas', 'schemas', { audit: 'schema:forged' }],
    ['caller-selected capacity', 'capacity', { revision: 99 }],
    ['gateway operation identity', 'operation_ref', 'operation:forged'],
    ['an unknown extension', 'future_field', true],
  ])(
    'rejects %s before it reaches the service',
    async (_label, field, value) => {
      const service = apiServiceStub();
      await withApiServer(apiFor(service), async (baseUrl) => {
        const response = await postJson(
          baseUrl,
          '/api/task-workspace/sessions/session%3Atest/runtime-command-proposals',
          commandBody({ [field]: value }),
        );
        expectClosedBodyRejection(response);
      });
      expect(service.createCommandProposal).not.toHaveBeenCalled();
    },
  );

  it.each([
    'workflow_id',
    'run_id',
    'action',
    'expected_target_row_version',
    'idempotency_key',
  ])('rejects a request missing %s', async (field) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/sessions/session%3Atest/runtime-command-proposals',
        without(commandBody(), field),
      );
      expectClosedBodyRejection(response);
    });
    expect(service.createCommandProposal).not.toHaveBeenCalled();
  });

  it.each(['pause_run', 'skip', 'PAUSE', ''])(
    'rejects invalid action %j',
    async (action) => {
      const service = apiServiceStub();
      await withApiServer(apiFor(service), async (baseUrl) => {
        const response = await postJson(
          baseUrl,
          '/api/task-workspace/sessions/session%3Atest/runtime-command-proposals',
          commandBody({ action }),
        );
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          error: { code: 'invalid_request', retryable: false },
        });
      });
      expect(service.createCommandProposal).not.toHaveBeenCalled();
    },
  );
});

describe('Task Workspace Human Input Web API', () => {
  it('accepts the exact closed submission and takes interaction identity from the path', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/interactions/interaction%3Atest/submit',
        interactionBody(),
      );

      expect(response).toEqual({
        status: 200,
        body: {
          interaction: {
            interaction_id: 'interaction:test',
            status: 'accepted',
          },
          receipt: { disposition: 'accepted' },
        },
      });
    });
    expect(service.submitInteraction).toHaveBeenCalledOnce();
    expect(service.submitInteraction).toHaveBeenCalledWith({
      principalRef: 'human:test-principal',
      submission: {
        interaction_id: 'interaction:test',
        rendered_snapshot_hash: SNAPSHOT_HASH,
        action_id: 'approve',
        payload_json: { approved: true },
        payload_hash: PAYLOAD_HASH,
        expected_target_row_version: 4,
        idempotency_key: 'interaction:test',
      },
    });
  });

  it.each([
    ['Runtime Wait identity', 'wait_id', 'wait:forged'],
    ['authenticated principal', 'principal_ref', 'human:forged'],
    ['actor identity', 'actor_ref', 'human:forged'],
    ['Runtime clock', 'now_ms', 123],
    ['Workflow lineage', 'workflow_id', 'workflow:forged'],
    ['Run lineage', 'run_id', 'run:forged'],
    ['sealed output schema', 'output_schema', { id: 'schema:forged' }],
    ['Runtime Value identity', 'payload_value_id', 'value:forged'],
    ['an unknown extension', 'future_field', true],
  ])('rejects caller-supplied %s', async (_label, field, value) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/interactions/interaction%3Atest/submit',
        interactionBody({ [field]: value }),
      );
      expectClosedBodyRejection(response);
    });
    expect(service.submitInteraction).not.toHaveBeenCalled();
  });

  it.each([
    'rendered_snapshot_hash',
    'action_id',
    'payload_json',
    'payload_hash',
    'expected_target_row_version',
    'idempotency_key',
  ])('rejects a submission missing %s', async (field) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/interactions/interaction%3Atest/submit',
        without(interactionBody(), field),
      );
      expectClosedBodyRejection(response);
    });
    expect(service.submitInteraction).not.toHaveBeenCalled();
  });
});

describe('Task Workspace Temporary Replan Web API', () => {
  it('lists session Replans for the authenticated principal', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await getJson(
        baseUrl,
        '/api/task-workspace/sessions/session%3Atest/replans',
      );
      expect(response).toEqual({
        status: 200,
        body: {
          replans: [
            { replan_id: 'replan:test', status: 'awaiting_confirmation' },
          ],
        },
      });
    });
    expect(service.listReplans).toHaveBeenCalledWith(
      'session:test',
      'human:test-principal',
    );
  });

  it('accepts only the closed instruction request and derives the principal', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/sessions/session%3Atest/replans',
        replanBody(),
      );
      expect(response).toEqual({
        status: 201,
        body: { replan: { replan_id: 'replan:test' } },
      });
    });
    expect(service.createReplan).toHaveBeenCalledWith({
      sessionId: 'session:test',
      principalRef: 'human:test-principal',
      workflowId: 'workflow:test',
      runId: 'run:test',
      instruction: 'Replace the remaining report step with a reviewed summary.',
      idempotencyKey: 'replan:test',
    });
  });

  it.each([
    ['caller proposal', 'proposal', { new_plan_hash: SNAPSHOT_HASH }],
    ['source frontier', 'source_frontier', { active_nodes: [] }],
    ['source Activation', 'source_activation_id', 'activation:forged'],
    ['confirmation identity', 'confirmation_ref', 'confirmation:forged'],
    ['authenticated principal', 'principal_ref', 'human:forged'],
    ['an unknown extension', 'future_field', true],
  ])('rejects %s on create', async (_label, field, value) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      expectClosedBodyRejection(
        await postJson(
          baseUrl,
          '/api/task-workspace/sessions/session%3Atest/replans',
          replanBody({ [field]: value }),
        ),
      );
    });
    expect(service.createReplan).not.toHaveBeenCalled();
  });

  it.each(['workflow_id', 'run_id', 'instruction', 'idempotency_key'])(
    'rejects create without %s',
    async (field) => {
      const service = apiServiceStub();
      await withApiServer(apiFor(service), async (baseUrl) => {
        expectClosedBodyRejection(
          await postJson(
            baseUrl,
            '/api/task-workspace/sessions/session%3Atest/replans',
            without(replanBody(), field),
          ),
        );
      });
      expect(service.createReplan).not.toHaveBeenCalled();
    },
  );

  it('accepts only row version and proposal hash for confirmation', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/replans/replan%3Atest/confirm',
        { expected_row_version: 4, proposal_hash: SNAPSHOT_HASH },
      );
      expect(response).toEqual({
        status: 200,
        body: {
          replan: { replan_id: 'replan:test', status: 'applying' },
        },
      });
    });
    expect(service.confirmReplan).toHaveBeenCalledWith({
      replanId: 'replan:test',
      principalRef: 'human:test-principal',
      expectedRowVersion: 4,
      proposalHash: SNAPSHOT_HASH,
    });
  });

  it.each([
    ['confirmation reference', 'confirmation_ref', 'confirmation:forged'],
    ['confirmation hash', 'confirmation_hash', PAYLOAD_HASH],
    ['prepared Runtime request', 'preparation', {}],
    ['target Activation', 'target_activation_id', 'activation:forged'],
    ['target Run', 'target_run_id', 'run:forged'],
    ['an unknown extension', 'future_field', true],
  ])('rejects caller-supplied %s on confirm', async (_label, field, value) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      expectClosedBodyRejection(
        await postJson(
          baseUrl,
          '/api/task-workspace/replans/replan%3Atest/confirm',
          {
            expected_row_version: 4,
            proposal_hash: SNAPSHOT_HASH,
            [field]: value,
          },
        ),
      );
    });
    expect(service.confirmReplan).not.toHaveBeenCalled();
  });

  it.each(['expected_row_version', 'proposal_hash'])(
    'rejects confirm without %s',
    async (field) => {
      const service = apiServiceStub();
      await withApiServer(apiFor(service), async (baseUrl) => {
        expectClosedBodyRejection(
          await postJson(
            baseUrl,
            '/api/task-workspace/replans/replan%3Atest/confirm',
            without(
              { expected_row_version: 4, proposal_hash: SNAPSHOT_HASH },
              field,
            ),
          ),
        );
      });
      expect(service.confirmReplan).not.toHaveBeenCalled();
    },
  );

  it('keeps cancellation closed to the row version only', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      expect(
        await postJson(
          baseUrl,
          '/api/task-workspace/replans/replan%3Atest/cancel',
          { expected_row_version: 4 },
        ),
      ).toEqual({
        status: 200,
        body: {
          replan: { replan_id: 'replan:test', status: 'cancelled' },
        },
      });
      expectClosedBodyRejection(
        await postJson(
          baseUrl,
          '/api/task-workspace/replans/replan%3Atest/cancel',
          { expected_row_version: 4, proposal_hash: SNAPSHOT_HASH },
        ),
      );
    });
    expect(service.cancelReplan).toHaveBeenCalledOnce();
    expect(service.cancelReplan).toHaveBeenCalledWith({
      replanId: 'replan:test',
      principalRef: 'human:test-principal',
      expectedRowVersion: 4,
    });
  });
});

describe('Task Workspace Personal Workflow Web API', () => {
  it('derives draft extraction lineage from a closed request', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/task-workspace/sessions/session%3Atest/personal-workflow-drafts',
        { workflow_id: 'workflow:test', run_id: 'run:test' },
      );
      expect(response.status).toBe(201);
    });
    expect(service.createPersonalWorkflowDraft).toHaveBeenCalledWith({
      sessionId: 'session:test',
      principalRef: 'human:test-principal',
      workflowId: 'workflow:test',
      runId: 'run:test',
    });
  });

  it('accepts a closed immutable revision request', async () => {
    const service = apiServiceStub();
    const source = { format: 'icarus.workflow-graph-scope/1', nodes: [] };
    await withApiServer(apiFor(service), async (baseUrl) => {
      const response = await postJson(
        baseUrl,
        '/api/personal-workflows/drafts/draft%3Atest/revise',
        { expected_row_version: 2, source_json: source },
      );
      expect(response.status).toBe(201);
    });
    expect(service.revisePersonalWorkflow).toHaveBeenCalledWith({
      draftId: 'draft:test',
      principalRef: 'human:test-principal',
      expectedRowVersion: 2,
      source,
    });
  });

  it('binds reviewed metadata, publish idempotency, and activation CAS', async () => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      expect(
        (
          await postJson(
            baseUrl,
            '/api/personal-workflows/drafts/draft%3Atest/review',
            {
              expected_row_version: 3,
              review: {
                approved: true,
                display_name: 'Reusable task',
                description: null,
              },
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(
            baseUrl,
            '/api/personal-workflows/drafts/draft%3Atest/publish',
            { expected_row_version: 4, idempotency_key: 'publish:test' },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await postJson(
            baseUrl,
            '/api/personal-workflows/releases/release%3Atest/activate',
            {
              expected_pointer_row_version: null,
              idempotency_key: 'activate:test',
            },
          )
        ).status,
      ).toBe(200);
    });
    expect(service.advancePersonalWorkflow).toHaveBeenNthCalledWith(1, {
      draftId: 'draft:test',
      principalRef: 'human:test-principal',
      expectedRowVersion: 3,
      action: 'review',
      review: {
        approved: true,
        display_name: 'Reusable task',
        description: null,
      },
    });
    expect(service.advancePersonalWorkflow).toHaveBeenNthCalledWith(2, {
      draftId: 'draft:test',
      principalRef: 'human:test-principal',
      expectedRowVersion: 4,
      action: 'publish',
      review: null,
      idempotencyKey: 'publish:test',
    });
    expect(service.activatePersonalWorkflow).toHaveBeenCalledWith({
      releaseId: 'release:test',
      principalRef: 'human:test-principal',
      expectedPointerRowVersion: null,
      idempotencyKey: 'activate:test',
    });
  });

  it.each([
    [
      '/drafts/draft%3Atest/revise',
      { expected_row_version: 1, source_json: {}, workflow_id: 'forged' },
    ],
    [
      '/drafts/draft%3Atest/validate',
      { expected_row_version: 1, compiler_snapshot: {} },
    ],
    [
      '/drafts/draft%3Atest/publish',
      {
        expected_row_version: 1,
        idempotency_key: 'publish:test',
        release_ref: {},
      },
    ],
    [
      '/releases/release%3Atest/activate',
      {
        expected_pointer_row_version: null,
        idempotency_key: 'activate:test',
        principal_ref: 'forged',
      },
    ],
  ])('rejects passthrough fields on %s', async (suffix, body) => {
    const service = apiServiceStub();
    await withApiServer(apiFor(service), async (baseUrl) => {
      expectClosedBodyRejection(
        await postJson(baseUrl, `/api/personal-workflows${suffix}`, body),
      );
    });
    expect(service.revisePersonalWorkflow).not.toHaveBeenCalled();
    expect(service.advancePersonalWorkflow).not.toHaveBeenCalled();
    expect(service.activatePersonalWorkflow).not.toHaveBeenCalled();
  });
});
