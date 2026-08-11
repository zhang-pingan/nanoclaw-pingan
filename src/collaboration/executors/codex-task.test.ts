import { describe, expect, it, vi } from 'vitest';

import type {
  CodexTaskHandle,
  CodexTurnCompletion,
} from '../../workflow-execution/codex/app-server-client.js';
import type { CollaborationExecutorBindingV4 } from '../project-space-store.js';
import type {
  ActionDefinitionV4,
  CollaborationTurnV4,
} from '../protocol/v4-schema.js';
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

const hash = (value: string) => `sha256:${value.repeat(64)}`;

function action(): ActionDefinitionV4 {
  return {
    format: 'icarus.collaboration-action/1',
    action_id: 'implement',
    name: 'Implement',
    owner_principal_id: 'principal_alice',
    version: 1,
    kind: 'external',
    adapter: 'codex-task',
    workflow_ref: null,
    prompt_ref: 'prompts/implement.md',
    prompt_hash: hash('e'),
    executor_policy: 'principal_selected',
    filesystem_access: 'workspace_write',
    result_schema: { ref: 'code-change-result@1', schema: null },
  };
}

function binding(
  overrides: Partial<CollaborationExecutorBindingV4> = {},
): CollaborationExecutorBindingV4 {
  return {
    groupId: 'group_test',
    instanceId: 'instance_1',
    stateId: 'development',
    principalId: 'principal_alice',
    clientId: 'client_1',
    actionHash: hash('d'),
    promptHash: hash('e'),
    executorId: 'executor_codex',
    executorKind: 'external',
    workspacePath: '/tmp/workspace',
    filesystemAccess: 'workspace_write',
    approvalPolicy: 'on-request',
    config: { adapter: 'codex-task', transport: 'app_server' },
    enabled: true,
    updatedAtMs: 1,
    ...overrides,
  };
}

function turn(): CollaborationTurnV4 {
  return {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_1',
    workflow_instance_id: 'instance_1',
    state_id: 'development',
    assignee_principal_id: 'principal_alice',
    claimant_principal_id: 'principal_alice',
    claimant_client_id: 'client_1',
    executor_id: 'executor_codex',
    attempt: 1,
    fencing_token: hash('b'),
    execution_mode: 'automatic',
    state: 'running',
    action_ref: 'actions/implement/action.json',
    action_hash: hash('d'),
    prompt_hash: hash('e'),
    input_hash: hash('f'),
    idempotency_key: hash('a'),
    incoming_handoff: null,
    incoming_handoff_hash: null,
    timeout_policy_snapshot: null,
    start_deadline_at: null,
    execution_deadline_at: null,
    deadline_snapshot_hash: hash('0'),
    created_at: '2026-08-06T00:00:00.000Z',
    started_at: '2026-08-06T00:00:01.000Z',
    completed_at: null,
    outcome: null,
    handoff: null,
    handoff_hash: null,
    executor_result: null,
    executor_result_hash: null,
    completion_hash: null,
    recovery_reason: null,
  };
}

function request(selectedBinding = binding()): ActionRequest {
  return {
    executionId: 'collaboration:codex-1',
    operationKey: hash('a'),
    groupId: 'group_test',
    instanceId: 'instance_1',
    turn: turn(),
    epoch: 1,
    action: action(),
    prompt: 'Implement the bounded change.',
    state: {
      label: 'Development',
      description: 'Implement the bounded change.',
      assignee: { type: 'principal', principal_id: 'principal_alice' },
      terminal: false,
      transitions: [
        {
          outcome: 'ready_for_test',
          label: 'Ready for test',
          target_state: 'testing',
        },
      ],
    },
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
      text: JSON.stringify({
        format: 'icarus.collaboration-action-result/4',
        outcome: 'ready_for_test',
        summary: 'Implemented',
        instruction: '',
        markers: [],
        data: {},
        artifacts: [],
        error: null,
      }),
      errorCode: null,
      errorMessage: null,
    });
    await vi.waitFor(async () => {
      expect(await executor.observe(first.executionRef)).toMatchObject({
        state: 'succeeded',
        result: { outcome: 'ready_for_test', summary: 'Implemented' },
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
        result: null,
        resultHash: null,
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
      visible.prepare(
        request(
          binding({
            config: { adapter: 'codex-task', transport: 'deep_link' },
          }),
        ),
      ),
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
