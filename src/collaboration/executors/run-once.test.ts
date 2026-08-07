import { describe, expect, it, vi } from 'vitest';

import type { RunOnceResponse } from '../../internal-agent-run-once/schemas.js';
import type { CollaborationExecutorBindingV3 } from '../project-space-store.js';
import type {
  ActionDefinitionV3,
  CollaborationTurnV3,
} from '../protocol/v3-schema.js';
import { RunOnceActionExecutor, type RunOnceService } from './run-once.js';
import {
  ActionBlockedError,
  actionResultHash,
  prepareWithLocalPolicy,
  validateActionResult,
  type ActionRequest,
} from './types.js';

const hash = (value: string) => `sha256:${value.repeat(64)}`;

function action(resultSchema?: Record<string, unknown>): ActionDefinitionV3 {
  return {
    format: 'icarus.collaboration-action/1',
    action_id: 'implement',
    name: 'Implement',
    owner_principal_id: 'principal_alice',
    version: 1,
    kind: 'run_once',
    adapter: null,
    workflow_ref: null,
    prompt_ref: 'prompts/implement.md',
    prompt_hash: hash('e'),
    executor_policy: 'principal_selected',
    filesystem_access: 'workspace_write',
    result_schema: {
      ref: 'code-change-result@1',
      schema: resultSchema ?? null,
    },
  };
}

function binding(
  cap: CollaborationExecutorBindingV3['filesystemAccess'] = 'workspace_write',
): CollaborationExecutorBindingV3 {
  return {
    groupId: 'group_test',
    instanceId: 'instance_1',
    stateId: 'development',
    principalId: 'principal_alice',
    clientId: 'client_1',
    actionHash: hash('d'),
    promptHash: hash('e'),
    executorId: 'executor_local',
    executorKind: 'run_once',
    workspacePath: '/tmp/workspace',
    filesystemAccess: cap,
    approvalPolicy: 'on-request',
    config: { agent_jid: 'web:main' },
    enabled: true,
    updatedAtMs: 1,
  };
}

function turn(): CollaborationTurnV3 {
  return {
    format: 'icarus.collaboration-turn/1',
    turn_id: 'turn_1',
    workflow_instance_id: 'instance_1',
    state_id: 'development',
    assignee_principal_id: 'principal_alice',
    claimant_principal_id: 'principal_alice',
    claimant_client_id: 'client_1',
    executor_id: 'executor_local',
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
    recovery_reason: null,
  };
}

function request(
  selectedAction = action(),
  selectedBinding = binding(),
): ActionRequest {
  return {
    executionId: 'collaboration:1',
    operationKey: hash('a'),
    groupId: 'group_test',
    instanceId: 'instance_1',
    turn: turn(),
    epoch: 1,
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
        format: 'icarus.collaboration-action-result/3',
        outcome: 'success',
        summary: 'missing approved field',
        instruction: '',
        markers: [],
        data: {},
        artifacts: [],
        error: null,
      }),
    ).toThrow(/does not satisfy code-change-result@1/);
  });

  it('hashes result objects with locale-independent code-unit key order', () => {
    const result = {
      format: 'icarus.collaboration-action-result/3' as const,
      outcome: 'success' as const,
      summary: 'deterministic',
      instruction: '',
      markers: [],
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
