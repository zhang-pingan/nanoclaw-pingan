import type {
  RunOnceAcceptedExecution,
  RunOnceLifecycle,
} from '../internal-agent-run-once/service.js';
import type {
  RunOnceRequestInput,
  RunOnceResponse,
} from '../internal-agent-run-once/schemas.js';
import {
  CONTAINER_AGENT_ADAPTER_ID,
  type WorkflowAdapterCompletion,
  type WorkflowAdapterExecutionContext,
  type WorkflowAdapterExecutionRecord,
  type WorkflowAdapterRunHandle,
  type WorkflowAgentDispatchRequest,
  type WorkflowAgentResult,
  type WorkflowExecutionAdapter,
} from './types.js';

export interface ContainerRunOnceExecutor {
  runOnce(
    input: RunOnceRequestInput,
    lifecycle?: RunOnceLifecycle,
  ): Promise<RunOnceResponse>;
}

export interface ContainerAgentAdapterOptions {
  readonly service: ContainerRunOnceExecutor;
  readonly agentJid: string;
  readonly agentExists: (agentJid: string) => boolean;
  readonly cancel?: (agentJid: string, executionId: string) => Promise<void>;
}

function resultFromRunOnce(
  context: WorkflowAdapterExecutionContext,
  response: RunOnceResponse,
): WorkflowAgentResult {
  const metadata: Record<string, unknown> = {
    mode: 'run_once',
    run_id: response.run_id,
    query_id: response.query_id,
    ...(response.trace_path ? { trace_path: response.trace_path } : {}),
    ...('model' in response ? { model: response.model } : {}),
  };
  const artifacts = (response.output_files || []).map((file) => ({
    name: file.name,
    path: file.agent_path,
    sha256: file.sha256,
    size: file.size,
    content_type: file.content_type,
    relative_path: file.relative_path,
    download_url: file.download_url,
  }));
  if (response.ok) {
    return {
      format: 'icarus.workflow-agent-result/1',
      outcome: 'success',
      summary: response.text,
      provider: {
        adapter: CONTAINER_AGENT_ADAPTER_ID,
        execution_id: context.executionId,
        metadata,
      },
      artifacts,
      error: null,
    };
  }
  return {
    format: 'icarus.workflow-agent-result/1',
    outcome: 'failure',
    summary: response.error,
    provider: {
      adapter: CONTAINER_AGENT_ADAPTER_ID,
      execution_id: context.executionId,
      metadata,
    },
    artifacts,
    error: {
      code: response.failure?.failureSubtype || 'container_agent_failed',
      message: response.error,
      retryable: response.failure?.retryable ?? true,
    },
  };
}

function orphanedCompletion(
  record: WorkflowAdapterExecutionRecord,
): WorkflowAdapterCompletion {
  return {
    state: 'failed',
    result: {
      format: 'icarus.workflow-agent-result/1',
      outcome: 'failure',
      summary:
        'The run-once container execution cannot be reattached after restart.',
      provider: {
        adapter: CONTAINER_AGENT_ADAPTER_ID,
        execution_id: record.executionId,
        metadata: record.providerMetadata,
      },
      artifacts: [],
      error: {
        code: 'container_execution_orphaned',
        message:
          'The original container process is no longer owned by this Host process.',
        retryable: true,
      },
    },
  };
}

export class ContainerAgentAdapter implements WorkflowExecutionAdapter {
  readonly refId = CONTAINER_AGENT_ADAPTER_ID;
  private readonly active = new Map<string, WorkflowAdapterRunHandle>();

  constructor(private readonly options: ContainerAgentAdapterOptions) {}

  async preflight(): Promise<void> {
    if (!this.options.agentExists(this.options.agentJid))
      throw new Error(
        `Container Agent Adapter target is not registered: ${this.options.agentJid}`,
      );
  }

  async start(
    context: WorkflowAdapterExecutionContext,
    request: WorkflowAgentDispatchRequest,
  ): Promise<WorkflowAdapterRunHandle> {
    await this.preflight();
    const existing = this.active.get(context.executionId);
    if (existing) return existing;

    let resolveAccepted!: (execution: RunOnceAcceptedExecution) => void;
    let rejectAccepted!: (error: Error) => void;
    let accepted = false;
    const acceptance = new Promise<RunOnceAcceptedExecution>(
      (resolve, reject) => {
        resolveAccepted = resolve;
        rejectAccepted = reject;
      },
    );
    const completion = this.execute(context, request, (execution) => {
      accepted = true;
      resolveAccepted(execution);
    });
    void completion.then((terminal) => {
      if (!accepted) {
        rejectAccepted(
          new Error(
            terminal.result.error?.message ||
              'Container run-once ended before a container process was accepted',
          ),
        );
      }
    });
    const acceptedExecution = await acceptance;
    const providerMetadata: Record<string, unknown> = {
      mode: 'run_once',
      agent_jid: this.options.agentJid,
      isolated_session: true,
      run_id: acceptedExecution.runId,
      query_id: acceptedExecution.queryId,
      container_name: acceptedExecution.containerName,
    };
    const trackedCompletion = completion.finally(() => {
      this.active.delete(context.executionId);
    });
    const handle: WorkflowAdapterRunHandle = {
      providerMetadata,
      completion: trackedCompletion,
      cancel: async () => {
        await this.options.cancel?.(this.options.agentJid, context.executionId);
      },
    };
    this.active.set(context.executionId, handle);
    return handle;
  }

  async recover(
    record: WorkflowAdapterExecutionRecord,
  ): Promise<WorkflowAdapterRunHandle> {
    const active = this.active.get(record.executionId);
    if (active) return active;
    return {
      providerMetadata: record.providerMetadata,
      completion: Promise.resolve(orphanedCompletion(record)),
      cancel: async () => undefined,
    };
  }

  private async execute(
    context: WorkflowAdapterExecutionContext,
    request: WorkflowAgentDispatchRequest,
    onAccepted: (execution: RunOnceAcceptedExecution) => void,
  ): Promise<WorkflowAdapterCompletion> {
    try {
      const response = await this.options.service.runOnce(
        {
          chat_jid: this.options.agentJid,
          system:
            request.task.system ||
            'Complete the requested Workflow task and return a concise result.',
          messages: [{ role: 'user', content: request.task.prompt }],
          require_result: true,
          files: request.task.files,
          metadata: {
            ...request.metadata,
            source: 'workflow_adapter',
            workflow_execution_id: context.executionId,
            workflow_attempt_id: context.attemptId,
            delegation_id: context.delegationId,
          },
        },
        { onAccepted },
      );
      const result = resultFromRunOnce(context, response);
      return {
        state: response.ok ? 'succeeded' : 'failed',
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state: 'failed',
        result: {
          format: 'icarus.workflow-agent-result/1',
          outcome: 'failure',
          summary: message,
          provider: {
            adapter: CONTAINER_AGENT_ADAPTER_ID,
            execution_id: context.executionId,
            metadata: {
              mode: 'run_once',
              agent_jid: this.options.agentJid,
            },
          },
          artifacts: [],
          error: {
            code: 'container_adapter_failed',
            message,
            retryable: true,
          },
        },
      };
    }
  }
}
