import { describe, expect, it, vi } from 'vitest';

import type { RunOnceResponse } from '../internal-agent-run-once/schemas.js';
import {
  CodexTaskAdapter,
  type CodexTaskClient,
} from './codex-task-adapter.js';
import { ContainerAgentAdapter } from './container-agent-adapter.js';
import type {
  CodexTaskHandle,
  CodexTurnCompletion,
} from './codex/app-server-client.js';
import type {
  WorkflowAdapterExecutionContext,
  WorkflowAdapterExecutionRecord,
  WorkflowAgentDispatchRequest,
} from './types.js';

const context: WorkflowAdapterExecutionContext = {
  executionId: 'execution-1',
  operationKey: 'operation-1',
  requestHash:
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  adapterResourceId: 'adapter-row',
  adapterResourceHash:
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  adapterRefId: 'icarus.adapter.container-agent',
  adapterRefVersion: '0.1.0',
  outboxId: 'outbox-1',
  outboxAttemptKind: 'deliver',
  outboxHistorySequence: 1,
  outboxKindAttemptNo: 1,
  outboxPolicyHash:
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  outboxMaxAttempts: 3,
  outboxDeadlineAtMs: 20_000,
  outboxLeaseOwner: 'worker',
  outboxLeaseToken: 'token',
  requestValueId: 'request-value',
  effectOperationId: 'effect-1',
  graphRunId: 'run-1',
  scopeId: 'scope-1',
  nodeId: 'node-1',
  attemptId: 'attempt-1',
  delegationId: 'delegation-1',
  runWorkFenceEpoch: 1,
  scopeWorkFenceEpoch: 1,
};

const request: WorkflowAgentDispatchRequest = {
  format: 'icarus.workflow-agent-dispatch-request/1',
  task: {
    title: 'Implement task',
    prompt: 'Complete the requested work',
    system: 'Follow the task exactly',
    files: [],
  },
  result_schema: {
    id: 'result.schema',
    version: '1.0.0',
    content_hash:
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  },
  metadata: { source: 'test' },
};

function executionRecord(
  overrides: Partial<WorkflowAdapterExecutionRecord> = {},
): WorkflowAdapterExecutionRecord {
  return {
    executionId: context.executionId,
    operationKey: context.operationKey,
    adapterRefId: context.adapterRefId,
    adapterResourceHash: context.adapterResourceHash,
    requestHash: context.requestHash,
    request,
    context,
    state: 'running',
    providerMetadata: {},
    result: null,
    errorCode: null,
    callbackDeliveredAtMs: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

describe('ContainerAgentAdapter', () => {
  it('uses the internal run-once service and maps its result', async () => {
    const response: RunOnceResponse = {
      ok: true,
      text: 'container complete',
      run_id: 'run-once-1',
      query_id: 'query-1',
      model: 'test-model',
      output_files: [
        {
          name: 'report.json',
          agent_path: '/workspace/run-once/output/report.json',
          relative_path: 'output/report.json',
          size: 42,
          sha256: 'a'.repeat(64),
          content_type: 'application/json',
          download_url: '/api/internal-agent/runs/run-once-1/files/report.json',
        },
      ],
    };
    const runOnce = vi.fn(async (_input, lifecycle) => {
      lifecycle?.onAccepted({
        runId: 'run-once-1',
        queryId: 'query-1',
        containerName: 'container-1',
      });
      return response;
    });
    const adapter = new ContainerAgentAdapter({
      service: { runOnce },
      agentJid: 'main@test',
      agentExists: () => true,
    });
    const handle = await adapter.start(context, request);

    await expect(handle.completion).resolves.toMatchObject({
      state: 'succeeded',
      result: {
        outcome: 'success',
        summary: 'container complete',
        artifacts: [
          expect.objectContaining({
            name: 'report.json',
            path: '/workspace/run-once/output/report.json',
            relative_path: 'output/report.json',
            download_url:
              '/api/internal-agent/runs/run-once-1/files/report.json',
          }),
        ],
      },
    });
    expect(runOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'main@test',
        require_result: true,
        messages: [{ role: 'user', content: request.task.prompt }],
        metadata: expect.objectContaining({
          source: 'workflow_adapter',
          workflow_execution_id: context.executionId,
        }),
      }),
      expect.objectContaining({ onAccepted: expect.any(Function) }),
    );
  });

  it('returns a retryable orphan result after Host restart', async () => {
    const adapter = new ContainerAgentAdapter({
      service: { runOnce: vi.fn() },
      agentJid: 'main@test',
      agentExists: () => true,
    });
    const handle = await adapter.recover(executionRecord());

    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      result: {
        error: { code: 'container_execution_orphaned', retryable: true },
      },
    });
  });
});

describe('CodexTaskAdapter', () => {
  it('persists App Server thread identity and maps completion', async () => {
    const completion: CodexTurnCompletion = {
      status: 'completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'codex complete',
      errorCode: null,
      errorMessage: null,
    };
    const codexHandle: CodexTaskHandle = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      cliVersion: '0.144.5',
      completion: Promise.resolve(completion),
      interrupt: vi.fn(),
    };
    const client: CodexTaskClient = {
      initialize: vi.fn(),
      startTask: vi.fn(async () => codexHandle),
      recoverTask: vi.fn(),
      close: vi.fn(),
    };
    const adapter = new CodexTaskAdapter({
      binary: 'codex',
      cwd: '/workspace',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      desktopVisibilityConfirmed: true,
      clientFactory: () => client,
    });
    const handle = await adapter.start(context, request);

    expect(handle.providerMetadata).toMatchObject({
      transport: 'app_server_stdio',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      cli_version: '0.144.5',
      ephemeral: false,
    });
    await expect(handle.completion).resolves.toMatchObject({
      state: 'succeeded',
      result: { outcome: 'success', summary: 'codex complete' },
    });
  });

  it('recovers by persisted thread and turn ids', async () => {
    const codexHandle: CodexTaskHandle = {
      threadId: 'thread-r',
      turnId: 'turn-r',
      cliVersion: '0.144.5',
      completion: Promise.resolve({
        status: 'interrupted',
        threadId: 'thread-r',
        turnId: 'turn-r',
        text: '',
        errorCode: 'codex_turn_interrupted',
        errorMessage: 'interrupted',
      }),
      interrupt: vi.fn(),
    };
    const client: CodexTaskClient = {
      initialize: vi.fn(),
      startTask: vi.fn(),
      recoverTask: vi.fn(async () => codexHandle),
      close: vi.fn(),
    };
    const adapter = new CodexTaskAdapter({
      binary: 'codex',
      cwd: '/workspace',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      desktopVisibilityConfirmed: true,
      clientFactory: () => client,
    });
    const record = executionRecord({
      adapterRefId: 'icarus.adapter.codex-task',
      providerMetadata: { thread_id: 'thread-r', turn_id: 'turn-r' },
    });
    const handle = await adapter.recover(record);

    expect(client.recoverTask).toHaveBeenCalledWith('thread-r', 'turn-r');
    await expect(handle.completion).resolves.toMatchObject({
      state: 'cancelled',
      result: { outcome: 'cancelled' },
    });
  });

  it('fails closed when desktop visibility is not confirmed', async () => {
    const adapter = new CodexTaskAdapter({
      binary: 'codex',
      cwd: '/workspace',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      desktopVisibilityConfirmed: false,
    });

    await expect(adapter.preflight()).rejects.toThrow(
      /WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true/,
    );
    await expect(adapter.start(context, request)).rejects.toThrow(
      /WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED=true/,
    );
  });
});
