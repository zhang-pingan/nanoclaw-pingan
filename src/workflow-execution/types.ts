import { z } from 'zod';

import { runOnceFileSchema } from '../internal-agent-run-once/schemas.js';

export const CONTAINER_AGENT_ADAPTER_ID =
  'icarus.adapter.container-agent' as const;
export const CODEX_TASK_ADAPTER_ID = 'icarus.adapter.codex-task' as const;

export const workflowAgentDispatchRequestSchema = z.object({
  format: z.literal('icarus.workflow-agent-dispatch-request/1'),
  task: z.object({
    title: z.string().min(1).max(240),
    prompt: z.string().min(1),
    system: z.string().min(1).optional(),
    workspace_ref: z.string().min(1).max(255).optional(),
    files: z.array(runOnceFileSchema).max(128).optional().default([]),
  }),
  result_schema: z.object({
    id: z.string().min(1).max(255),
    version: z.string().min(1).max(64),
    content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type WorkflowAgentDispatchRequest = z.output<
  typeof workflowAgentDispatchRequestSchema
>;

export const workflowAgentResultSchema = z.object({
  format: z.literal('icarus.workflow-agent-result/1'),
  outcome: z.enum(['success', 'failure', 'cancelled', 'blocked']),
  summary: z.string(),
  provider: z.object({
    adapter: z.string().min(1),
    execution_id: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  }),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        sha256: z.string().min(1).optional(),
        size: z.number().int().nonnegative().optional(),
        content_type: z.string().min(1).optional(),
      }),
    )
    .default([]),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});

export type WorkflowAgentResult = z.output<typeof workflowAgentResultSchema>;

export interface WorkflowAdapterExecutionContext {
  readonly executionId: string;
  readonly operationKey: string;
  readonly requestHash: string;
  readonly adapterResourceId: string;
  readonly adapterResourceHash: string;
  readonly adapterRefId: string;
  readonly adapterRefVersion: string;
  readonly outboxId: string;
  readonly outboxAttemptKind: 'deliver' | 'reconcile';
  readonly outboxHistorySequence: number;
  readonly outboxKindAttemptNo: number;
  readonly outboxPolicyHash: string;
  readonly outboxMaxAttempts: number;
  readonly outboxDeadlineAtMs: number;
  readonly outboxLeaseOwner: string;
  readonly outboxLeaseToken: string;
  readonly requestValueId: string;
  readonly effectOperationId: string;
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly delegationId: string;
  readonly runWorkFenceEpoch: number;
  readonly scopeWorkFenceEpoch: number;
}

export type WorkflowAdapterExecutionState =
  | 'reserved'
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface WorkflowAdapterExecutionRecord {
  readonly executionId: string;
  readonly operationKey: string;
  readonly adapterRefId: string;
  readonly adapterResourceHash: string;
  readonly requestHash: string;
  readonly request: WorkflowAgentDispatchRequest;
  readonly context: WorkflowAdapterExecutionContext;
  readonly state: WorkflowAdapterExecutionState;
  readonly providerMetadata: Record<string, unknown>;
  readonly result: WorkflowAgentResult | null;
  readonly errorCode: string | null;
  readonly callbackDeliveredAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WorkflowAdapterCompletion {
  readonly state: Extract<
    WorkflowAdapterExecutionState,
    'succeeded' | 'failed' | 'cancelled' | 'blocked'
  >;
  readonly result: WorkflowAgentResult;
}

export interface WorkflowAdapterRunHandle {
  readonly providerMetadata: Record<string, unknown>;
  readonly completion: Promise<WorkflowAdapterCompletion>;
  cancel(): Promise<void>;
}

export interface WorkflowExecutionAdapter {
  readonly refId: string;
  preflight(): Promise<void>;
  start(
    context: WorkflowAdapterExecutionContext,
    request: WorkflowAgentDispatchRequest,
  ): Promise<WorkflowAdapterRunHandle>;
  recover(
    record: WorkflowAdapterExecutionRecord,
  ): Promise<WorkflowAdapterRunHandle>;
}

export function parseWorkflowAgentDispatchRequest(
  value: unknown,
): WorkflowAgentDispatchRequest {
  return workflowAgentDispatchRequestSchema.parse(value);
}
