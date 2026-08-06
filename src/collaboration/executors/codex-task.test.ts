import { describe, expect, it, vi } from 'vitest';

import type {
  CodexTaskHandle,
  CodexTurnCompletion,
} from '../../workflow-execution/codex/app-server-client.js';
import type { ActionDefinition } from '../protocol/index.js';
import type { CollaborationExecutorBinding } from '../store.js';
import {
  CodexTaskActionExecutor,
  type CollaborationCodexClient,
} from './codex-task.js';
import { ActionBlockedError, type ActionRequest } from './types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function action(): ActionDefinition {
  return {
    format: 'icarus.agent-group-action/1',
    action_id: 'implement',
    kind: 'external',
    adapter: 'codex-task',
    input: { prompt_ref: 'prompts/implement.md' },
    requirements: {
      capability: 'coding_task',
      interaction: 'visible_session',
      filesystem_access: 'workspace_write',
    },
    result_schema: { ref: 'code-change-result@1' },
  };
}

function binding(
  overrides: Partial<CollaborationExecutorBinding> = {},
): CollaborationExecutorBinding {
  return {
    groupId: 'ag_test',
    role: 'developer',
    executorKind: 'external',
    adapter: 'codex-task',
    agentJid: null,
    workspacePath: '/tmp/workspace',
    promptOverride: null,
    filesystemAccessCap: 'workspace_write',
    approvalPolicy: 'on-request',
    config: { transport: 'app_server' },
    enabled: true,
    updatedAtMs: 1,
    ...overrides,
  };
}

function request(selectedBinding = binding()): ActionRequest {
  return {
    executionId: 'collaboration:codex-1',
    operationKey: `sha256:${'a'.repeat(64)}`,
    groupId: 'ag_test',
    turnId: 'turn_1',
    epoch: 1,
    attempt: 1,
    fencingToken: `sha256:${'b'.repeat(64)}`,
    action: action(),
    prompt: 'Implement the bounded change.',
    binding: selectedBinding,
  };
}

function fakeClient(handle: CodexTaskHandle): CollaborationCodexClient {
  return {
    initialize: vi.fn(),
    startTask: vi.fn(async () => handle),
    recoverTask: vi.fn(async () => handle),
    close: vi.fn(),
  };
}

describe('CodexTaskActionExecutor', () => {
  it('dispatches once, preserves thread metadata, and maps completion', async () => {
    const completion = deferred<CodexTurnCompletion>();
    const handle: CodexTaskHandle = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      cliVersion: '0.146.0-alpha.9.2',
      completion: completion.promise,
      interrupt: vi.fn(),
    };
    const client = fakeClient(handle);
    const executor = new CodexTaskActionExecutor({
      binary: '/Applications/ChatGPT.app/Contents/Resources/codex',
      defaultCwd: '/tmp/workspace',
      desktopVisibilityConfirmed: true,
      clientFactory: () => client,
    });
    const prepared = await executor.prepare(request());
    const [first, duplicate] = await Promise.all([
      executor.dispatch(prepared),
      executor.dispatch(prepared),
    ]);

    expect(first).toEqual(duplicate);
    expect(client.startTask).toHaveBeenCalledTimes(1);
    expect(client.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspace',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    );
    expect(first.providerMetadata).toMatchObject({
      transport: 'app_server_stdio',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      ephemeral: false,
    });
    expect(first.executionRef).not.toContain('thread-1');
    completion.resolve({
      status: 'completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'Implemented',
      errorCode: null,
      errorMessage: null,
    });
    await vi.waitFor(async () => {
      expect(await executor.observe(first.executionRef)).toMatchObject({
        state: 'succeeded',
        result: { outcome: 'success', summary: 'Implemented' },
      });
    });
  });

  it('recovers through the shared App Server client using the encoded identity', async () => {
    const handle: CodexTaskHandle = {
      threadId: 'thread-r',
      turnId: 'turn-r',
      cliVersion: '0.146.0-alpha.9.2',
      completion: Promise.resolve({
        status: 'interrupted',
        threadId: 'thread-r',
        turnId: 'turn-r',
        text: '',
        errorCode: 'codex_turn_interrupted',
        errorMessage: 'Interrupted',
      }),
      interrupt: vi.fn(),
    };
    const client = fakeClient(handle);
    const executor = new CodexTaskActionExecutor({
      binary: 'codex',
      defaultCwd: '/tmp/workspace',
      desktopVisibilityConfirmed: true,
      clientFactory: () => client,
    });
    const ref = 'collaboration-action:opaque';

    expect(
      await executor.recover(ref, {
        thread_id: 'thread-r',
        turn_id: 'turn-r',
      }),
    ).toMatchObject({ state: 'running' });
    expect(client.recoverTask).toHaveBeenCalledWith('thread-r', 'turn-r');
    await vi.waitFor(async () => {
      expect(await executor.observe(ref)).toMatchObject({
        state: 'cancelled',
        result: { outcome: 'cancelled' },
      });
    });
  });

  it('fails closed for unsupported transport or unconfirmed desktop visibility', async () => {
    const hidden = new CodexTaskActionExecutor({
      binary: 'codex',
      defaultCwd: '/tmp/workspace',
      desktopVisibilityConfirmed: false,
    });
    await expect(hidden.prepare(request())).rejects.toMatchObject({
      code: 'codex_desktop_thread_unavailable',
    });
    const visible = new CodexTaskActionExecutor({
      binary: 'codex',
      defaultCwd: '/tmp/workspace',
      desktopVisibilityConfirmed: true,
    });
    await expect(
      visible.prepare(request(binding({ config: { transport: 'deep_link' } }))),
    ).rejects.toBeInstanceOf(ActionBlockedError);
  });

  it('blocks during prepare when App Server initialization fails', async () => {
    const client = fakeClient({
      threadId: 'unused-thread',
      turnId: 'unused-turn',
      cliVersion: 'unknown',
      completion: new Promise(() => {}),
      interrupt: vi.fn(),
    });
    vi.mocked(client.initialize).mockRejectedValue(
      new Error('unsupported Codex configuration'),
    );
    const executor = new CodexTaskActionExecutor({
      binary: 'codex',
      defaultCwd: '/tmp/workspace',
      desktopVisibilityConfirmed: true,
      clientFactory: () => client,
    });

    await expect(executor.prepare(request())).rejects.toMatchObject({
      code: 'codex_app_server_unavailable',
      message: 'unsupported Codex configuration',
    });
    expect(client.startTask).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
