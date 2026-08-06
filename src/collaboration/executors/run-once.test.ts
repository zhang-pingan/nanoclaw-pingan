import { describe, expect, it, vi } from 'vitest';

import type { RunOnceResponse } from '../../internal-agent-run-once/schemas.js';
import type { ActionDefinition } from '../protocol/index.js';
import type { CollaborationExecutorBinding } from '../store.js';
import { RunOnceActionExecutor, type RunOnceService } from './run-once.js';
import {
  ActionBlockedError,
  actionResultHash,
  prepareWithLocalPolicy,
  validateActionResult,
  type ActionRequest,
} from './types.js';

function action(resultSchema?: Record<string, unknown>): ActionDefinition {
  return {
    format: 'icarus.agent-group-action/1',
    action_id: 'implement',
    kind: 'run_once',
    input: { prompt_ref: 'prompts/implement.md' },
    requirements: {
      capability: 'coding_task',
      interaction: 'visible_session',
      filesystem_access: 'workspace_write',
    },
    result_schema: {
      ref: 'code-change-result@1',
      ...(resultSchema ? { schema: resultSchema } : {}),
    },
  };
}

function binding(
  cap: CollaborationExecutorBinding['filesystemAccessCap'] = 'workspace_write',
): CollaborationExecutorBinding {
  return {
    groupId: 'ag_test',
    role: 'developer',
    executorKind: 'run_once',
    adapter: null,
    agentJid: 'web:main',
    workspacePath: '/tmp/workspace',
    promptOverride: null,
    filesystemAccessCap: cap,
    approvalPolicy: 'on-request',
    config: {},
    enabled: true,
    updatedAtMs: 1,
  };
}

function request(
  selectedAction = action(),
  selectedBinding = binding(),
): ActionRequest {
  return {
    executionId: 'collaboration:1',
    operationKey: `sha256:${'a'.repeat(64)}`,
    groupId: 'ag_test',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    fencingToken: `sha256:${'b'.repeat(64)}`,
    action: selectedAction,
    prompt: 'Implement the task.',
    binding: selectedBinding,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RunOnceActionExecutor', () => {
  it('intersects remote requirements with the local permission cap', () => {
    expect(() =>
      prepareWithLocalPolicy(request(action(), binding('read_only'))),
    ).toThrow(ActionBlockedError);
    expect(
      prepareWithLocalPolicy(request(action(), binding('workspace_write')))
        .effectiveFilesystemAccess,
    ).toBe('workspace_write');
  });

  it('dispatches once per operation key and maps the terminal result', async () => {
    const result = deferred<RunOnceResponse>();
    const runOnce = vi.fn<RunOnceService['runOnce']>(
      async (_input, lifecycle) => {
        lifecycle?.onAccepted({
          runId: 'run-1',
          queryId: 'query-1',
          containerName: 'container-1',
        });
        return result.promise;
      },
    );
    const preflightWorkspace = vi.fn();
    const executor = new RunOnceActionExecutor({
      preflightWorkspace,
      runOnce,
    });
    const prepared = await executor.prepare(request());
    expect(preflightWorkspace).toHaveBeenCalledWith({
      chatJid: 'web:main',
      workspace: {
        host_path: '/tmp/workspace',
        access: 'workspace_write',
      },
    });
    const [first, duplicate] = await Promise.all([
      executor.dispatch(prepared),
      executor.dispatch(prepared),
    ]);
    expect(first).toEqual(duplicate);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          host_path: '/tmp/workspace',
          access: 'workspace_write',
        },
      }),
      expect.any(Object),
    );
    expect(await executor.observe(first.executionRef)).toMatchObject({
      state: 'running',
      providerMetadata: { run_id: 'run-1', query_id: 'query-1' },
    });
    result.resolve({
      ok: true,
      text: 'Implemented safely',
      run_id: 'run-1',
      query_id: 'query-1',
      model: 'test-model',
      output_files: [],
    });
    await vi.waitFor(async () => {
      expect(await executor.observe(first.executionRef)).toMatchObject({
        state: 'succeeded',
        result: {
          outcome: 'success',
          summary: 'Implemented safely',
          data: { model: 'test-model' },
        },
      });
    });
  });

  it('requires manual recovery after the run-once process is lost', async () => {
    const executor = new RunOnceActionExecutor({
      preflightWorkspace: vi.fn(),
      runOnce: vi.fn(),
    });
    expect(await executor.recover('run-once:missing')).toMatchObject({
      state: 'recovery_required',
      recoveryReason: expect.stringMatching(/do not redispatch/),
    });
  });

  it('blocks before claim when the configured workspace fails preflight', async () => {
    const executor = new RunOnceActionExecutor({
      preflightWorkspace: vi.fn(() => {
        throw new Error('No mount allowlist configured');
      }),
      runOnce: vi.fn(),
    });

    await expect(executor.prepare(request())).rejects.toMatchObject({
      code: 'local_permission_insufficient',
      message: expect.stringMatching(/No mount allowlist configured/),
    });
  });

  it('validates the declared result schema before a result can advance the FSM', () => {
    const selectedAction = action({
      type: 'object',
      additionalProperties: false,
      required: ['approved'],
      properties: { approved: { type: 'boolean' } },
    });
    expect(() =>
      validateActionResult(selectedAction, {
        format: 'icarus.collaboration-action-result/1',
        outcome: 'success',
        summary: 'missing approved field',
        data: {},
        artifacts: [],
        error: null,
      }),
    ).toThrow(/does not satisfy code-change-result@1/);
  });

  it('hashes result objects with locale-independent code-unit key order', () => {
    const result = {
      format: 'icarus.collaboration-action-result/1' as const,
      outcome: 'success' as const,
      summary: 'deterministic',
      data: Object.fromEntries(
        ['\uE000', '\u{10000}', '\u00E4', 'a', 'Z'].map((key) => [key, key]),
      ),
      artifacts: [],
      error: null,
    };
    const expected = actionResultHash(result);
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => -1);
    try {
      expect(actionResultHash(result)).toBe(expected);
    } finally {
      localeCompare.mockRestore();
    }
  });
});
