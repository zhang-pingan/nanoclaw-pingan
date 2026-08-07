import crypto from 'node:crypto';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import type { CollaborationExecutorBindingV3 } from '../project-space-store.js';
import { canonicalJsonStringify } from '../protocol/canonical-json.js';
import type {
  ActionDefinitionV3,
  CollaborationTurnV3,
} from '../protocol/v3-schema.js';

export type ActionExecutionState =
  | 'accepted'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'recovery_required';

export const collaborationActionResultSchema = z
  .object({
    format: z.literal('icarus.collaboration-action-result/3'),
    outcome: z.string().min(1).max(160),
    summary: z.string().min(1).max(4000),
    instruction: z.string().max(16_000).default(''),
    markers: z.array(z.string().min(1).max(160)).max(50).default([]),
    data: z.record(z.string(), z.unknown()).default({}),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().min(1),
            ref: z.string().min(1),
            sha256: z.string().optional(),
            size: z.number().int().nonnegative().optional(),
            content_type: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CollaborationActionResultV3 = z.infer<
  typeof collaborationActionResultSchema
>;

export interface ActionRequest {
  readonly executionId: string;
  readonly operationKey: string;
  readonly groupId: string;
  readonly instanceId: string;
  readonly turn: CollaborationTurnV3;
  readonly epoch: number;
  readonly action: ActionDefinitionV3;
  readonly prompt: string;
  readonly binding: CollaborationExecutorBindingV3;
}

export interface PreparedAction extends ActionRequest {
  readonly effectiveFilesystemAccess: 'read_only' | 'workspace_write';
  readonly turnId: string;
  readonly attempt: number;
  readonly fencingToken: string;
}

export interface DispatchReceipt {
  readonly executionRef: string;
  readonly providerMetadata: Record<string, unknown>;
  readonly receipt: Record<string, unknown>;
}

export interface ActionObservation {
  readonly state: ActionExecutionState;
  readonly executionRef: string;
  readonly providerMetadata: Record<string, unknown>;
  readonly result: CollaborationActionResultV3 | null;
  readonly resultHash: string | null;
  readonly recoveryReason?: string;
}

export interface CancelResult {
  readonly cancelled: boolean;
  readonly observation: ActionObservation;
}

export interface ActionExecutor {
  readonly kind: ActionDefinitionV3['kind'];
  readonly adapter?: string;
  prepare(request: ActionRequest): Promise<PreparedAction>;
  dispatch(action: PreparedAction): Promise<DispatchReceipt>;
  observe(executionRef: string): Promise<ActionObservation>;
  cancel(executionRef: string, reason: string): Promise<CancelResult>;
  recover(
    executionRef: string,
    providerMetadata?: Record<string, unknown>,
  ): Promise<ActionObservation>;
}

export class ActionBlockedError extends Error {
  constructor(
    readonly code:
      | 'executor_unconfigured'
      | 'local_permission_insufficient'
      | 'codex_app_server_unavailable'
      | 'codex_desktop_thread_unavailable'
      | 'workflow_runtime_unavailable'
      | 'result_schema_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ActionBlockedError';
  }
}

const accessRank = { read_only: 0, workspace_write: 1 } as const;

export function prepareWithLocalPolicy(request: ActionRequest): PreparedAction {
  if (!request.binding.enabled)
    throw new ActionBlockedError(
      'executor_unconfigured',
      `Executor binding is disabled for State ${request.binding.stateId}`,
    );
  const required = request.action.filesystem_access;
  if (accessRank[request.binding.filesystemAccess] < accessRank[required])
    throw new ActionBlockedError(
      'local_permission_insufficient',
      `Local ${request.binding.filesystemAccess} cap does not cover ${required}`,
    );
  if (!request.turn.fencing_token)
    throw new ActionBlockedError(
      'executor_unconfigured',
      'A fenced Turn is required before dispatch',
    );
  return {
    ...request,
    effectiveFilesystemAccess: required,
    turnId: request.turn.turn_id,
    attempt: request.turn.attempt,
    fencingToken: request.turn.fencing_token,
  };
}

export function actionResultHash(result: CollaborationActionResultV3): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJsonStringify(result))
    .digest('hex')}`;
}

export function validateActionResult(
  action: ActionDefinitionV3,
  input: unknown,
): {
  readonly result: CollaborationActionResultV3;
  readonly resultHash: string;
} {
  const result = collaborationActionResultSchema.parse(input);
  if (action.result_schema.schema) {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validate = ajv.compile(action.result_schema.schema);
    if (!validate(result.data))
      throw new ActionBlockedError(
        'result_schema_invalid',
        `Action result does not satisfy ${action.result_schema.ref}: ${ajv.errorsText(validate.errors)}`,
      );
  }
  return { result, resultHash: actionResultHash(result) };
}

export function terminalObservation(
  state: Extract<
    ActionExecutionState,
    'succeeded' | 'failed' | 'cancelled' | 'blocked'
  >,
  executionRef: string,
  providerMetadata: Record<string, unknown>,
  action: ActionDefinitionV3,
  result: unknown,
): ActionObservation {
  const validated = validateActionResult(action, result);
  return {
    state,
    executionRef,
    providerMetadata,
    result: validated.result,
    resultHash: validated.resultHash,
  };
}
