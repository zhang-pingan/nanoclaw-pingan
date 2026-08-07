import { describe, expect, it, vi } from 'vitest';

import { TaskWorkspaceApiClient, TaskWorkspaceApiError } from './api-client.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TaskWorkspaceApiClient', () => {
  it('uses the HTTP session cursor as the timeline recovery path', async () => {
    const fetcher = vi.fn(async () =>
      response({
        type: 'task_workspace_timeline_delta',
        session_id: 'session:1',
        after_session_seq: 17,
        entries: [],
        next_session_seq: 17,
        source_state: 'ready',
      }),
    );
    const client = new TaskWorkspaceApiClient(fetcher);

    await client.timeline('session:1', 17);

    expect(fetcher).toHaveBeenCalledWith(
      '/api/task-workspace/sessions/session%3A1/timeline?after_session_seq=17',
      {},
    );
  });

  it('submits only a closed Runtime command action from the renderer', async () => {
    const fetcher = vi.fn(async () => response({ proposal: {} }, 201));
    const client = new TaskWorkspaceApiClient(fetcher);

    await client.createRuntimeCommandProposal(
      'session:1',
      'workflow:1',
      'run:1',
      'pause',
      7,
      'command:1',
    );

    const [, options] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(options?.body))).toEqual({
      workflow_id: 'workflow:1',
      run_id: 'run:1',
      action: 'pause',
      expected_target_row_version: 7,
      idempotency_key: 'command:1',
    });

    await client.confirmRuntimeCommand('proposal:1', 2, 'sha256:proposal');
    const [, confirmOptions] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(confirmOptions?.body))).toEqual({
      expected_row_version: 2,
      proposal_hash: 'sha256:proposal',
    });
  });

  it('preserves canonical API errors and retryability', async () => {
    const client = new TaskWorkspaceApiClient(async () =>
      response(
        {
          error: {
            code: 'selection_stale',
            message: 'Refresh the Catalog',
            retryable: false,
          },
        },
        409,
      ),
    );

    await expect(client.listRecipes()).rejects.toMatchObject<
      Partial<TaskWorkspaceApiError>
    >({
      code: 'selection_stale',
      status: 409,
      retryable: false,
      message: 'Refresh the Catalog',
    });
  });

  it('binds interaction identity to the path instead of duplicating it in the body', async () => {
    const fetcher = vi.fn(async () => response({ receipt: {} }));
    const client = new TaskWorkspaceApiClient(fetcher);

    await client.submitInteraction('interaction:1', {
      interaction_id: 'interaction:1',
      rendered_snapshot_hash: 'sha256:snapshot',
      action_id: 'approve',
      payload_json: { approved: true },
      payload_hash: 'sha256:payload',
      expected_target_row_version: 3,
      idempotency_key: 'interaction-submit:1',
    });

    const [, options] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(options?.body))).not.toHaveProperty(
      'interaction_id',
    );
  });

  it('submits only the closed Temporary Replan instruction and confirmation', async () => {
    const fetcher = vi.fn(async () => response({ replan: {} }, 201));
    const client = new TaskWorkspaceApiClient(fetcher);

    await client.createReplan(
      'session:1',
      'workflow:1',
      'run:1',
      'Use the reviewed summary.',
      'replan:1',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      workflow_id: 'workflow:1',
      run_id: 'run:1',
      instruction: 'Use the reviewed summary.',
      idempotency_key: 'replan:1',
    });

    await client.confirmReplan('replan:1', 3, 'sha256:proposal');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({
      expected_row_version: 3,
      proposal_hash: 'sha256:proposal',
    });
  });
});
