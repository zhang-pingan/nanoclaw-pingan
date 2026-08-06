import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CodexTaskHandle,
  type CodexTaskStartInput,
  type CodexTurnCompletion,
} from './codex/app-server-client.js';
import {
  codexProviderMetadata,
  normalizeCodexCompletion,
} from './codex/task-mapping.js';
import {
  CODEX_TASK_ADAPTER_ID,
  type WorkflowAdapterCompletion,
  type WorkflowAdapterExecutionContext,
  type WorkflowAdapterExecutionRecord,
  type WorkflowAdapterRunHandle,
  type WorkflowAgentDispatchRequest,
  type WorkflowAgentResult,
  type WorkflowExecutionAdapter,
} from './types.js';

export interface CodexTaskClient {
  initialize(): Promise<void>;
  startTask(input: CodexTaskStartInput): Promise<CodexTaskHandle>;
  recoverTask(threadId: string, turnId: string): Promise<CodexTaskHandle>;
  close(): void;
}

export interface CodexTaskAdapterOptions {
  readonly binary: string;
  readonly cwd: string;
  readonly model?: string;
  readonly sandbox: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly desktopVisibilityConfirmed: boolean;
  readonly requestTimeoutMs?: number;
  readonly clientFactory?: (
    options: CodexAppServerClientOptions,
  ) => CodexTaskClient;
}

function resultFromCompletion(
  context: WorkflowAdapterExecutionContext,
  completion: CodexTurnCompletion,
  metadata: Record<string, unknown>,
): WorkflowAdapterCompletion {
  const normalized = normalizeCodexCompletion(completion, metadata);
  const result: WorkflowAgentResult = {
    format: 'icarus.workflow-agent-result/1',
    outcome: normalized.outcome,
    summary: normalized.summary,
    provider: {
      adapter: CODEX_TASK_ADAPTER_ID,
      execution_id: context.executionId,
      metadata: normalized.metadata,
    },
    artifacts: [],
    error: normalized.error,
  };
  return { state: normalized.state, result };
}

export class CodexTaskAdapter implements WorkflowExecutionAdapter {
  readonly refId = CODEX_TASK_ADAPTER_ID;
  private readonly active = new Map<string, WorkflowAdapterRunHandle>();
  private readonly clientFactory: (
    options: CodexAppServerClientOptions,
  ) => CodexTaskClient;

  constructor(private readonly options: CodexTaskAdapterOptions) {
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) => new CodexAppServerClient(clientOptions));
  }

  async preflight(): Promise<void> {
    this.assertVisibilityGate();
    const client = this.createClient();
    try {
      await client.initialize();
    } finally {
      client.close();
    }
  }

  async start(
    context: WorkflowAdapterExecutionContext,
    request: WorkflowAgentDispatchRequest,
  ): Promise<WorkflowAdapterRunHandle> {
    this.assertVisibilityGate();
    const existing = this.active.get(context.executionId);
    if (existing) return existing;
    const client = this.createClient();
    try {
      await client.initialize();
      const codexHandle = await client.startTask({
        title: request.task.title,
        prompt: request.task.prompt,
        system: request.task.system,
        cwd: request.task.workspace_ref || this.options.cwd,
        model: this.options.model,
        sandbox: this.options.sandbox,
        approvalPolicy: this.options.approvalPolicy,
      });
      return this.installHandle(context, client, codexHandle);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async recover(
    record: WorkflowAdapterExecutionRecord,
  ): Promise<WorkflowAdapterRunHandle> {
    this.assertVisibilityGate();
    const existing = this.active.get(record.executionId);
    if (existing) return existing;
    const threadId = record.providerMetadata.thread_id;
    const turnId = record.providerMetadata.turn_id;
    if (typeof threadId !== 'string' || typeof turnId !== 'string')
      throw new Error(
        `Codex execution metadata is incomplete: ${record.executionId}`,
      );
    const client = this.createClient();
    try {
      await client.initialize();
      const codexHandle = await client.recoverTask(threadId, turnId);
      return this.installHandle(record.context, client, codexHandle);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private installHandle(
    context: WorkflowAdapterExecutionContext,
    client: CodexTaskClient,
    codexHandle: CodexTaskHandle,
  ): WorkflowAdapterRunHandle {
    const metadata = codexProviderMetadata(codexHandle);
    const completion = codexHandle.completion
      .then((result) => resultFromCompletion(context, result, metadata))
      .catch((error): WorkflowAdapterCompletion => {
        const message = error instanceof Error ? error.message : String(error);
        return {
          state: 'failed',
          result: {
            format: 'icarus.workflow-agent-result/1',
            outcome: 'failure',
            summary: message,
            provider: {
              adapter: CODEX_TASK_ADAPTER_ID,
              execution_id: context.executionId,
              metadata,
            },
            artifacts: [],
            error: {
              code: 'codex_app_server_failed',
              message,
              retryable: true,
            },
          },
        };
      })
      .finally(() => {
        client.close();
        this.active.delete(context.executionId);
      });
    const handle: WorkflowAdapterRunHandle = {
      providerMetadata: metadata,
      completion,
      cancel: () => codexHandle.interrupt(),
    };
    this.active.set(context.executionId, handle);
    return handle;
  }

  private createClient(): CodexTaskClient {
    return this.clientFactory({
      binary: this.options.binary,
      cwd: this.options.cwd,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
  }

  private assertVisibilityGate(): void {
    if (!this.options.desktopVisibilityConfirmed)
      throw new Error(
        'Codex App Server desktop visibility is not confirmed for this Host',
      );
  }
}
