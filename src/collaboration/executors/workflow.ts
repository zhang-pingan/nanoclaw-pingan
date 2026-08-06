import crypto from 'node:crypto';

import type {
  FiniteWorkflowCreationInput,
  FiniteWorkflowCreationReceipt,
  FiniteWorkflowRunObservation,
} from '../../workflow-execution/host-service.js';
import {
  ActionBlockedError,
  actionResultHash,
  collaborationActionResultSchema,
  prepareWithLocalPolicy,
  terminalObservation,
  type ActionExecutor,
  type ActionObservation,
  type ActionRequest,
  type CancelResult,
  type DispatchReceipt,
  type PreparedAction,
} from './types.js';

export interface CollaborationWorkflowHostService {
  startFiniteRun(
    input: FiniteWorkflowCreationInput,
  ): FiniteWorkflowCreationReceipt;
  observeFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null;
  recoverFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null;
}

function promptHash(prompt: string): string {
  return `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
}

function configuredCreationInput(
  action: PreparedAction,
): FiniteWorkflowCreationInput {
  const configured = action.binding.config.workflow_creation_input;
  if (
    !configured ||
    typeof configured !== 'object' ||
    Array.isArray(configured)
  )
    throw new ActionBlockedError(
      'workflow_runtime_unavailable',
      'Workflow binding requires a complete host-resolved workflow_creation_input',
    );
  const input = configured as Record<string, unknown>;
  if (
    input.creationDomain !== 'agent_group_collaboration' ||
    input.creationKey !== action.operationKey ||
    input.source !== 'api' ||
    typeof input.requestId !== 'string' ||
    typeof input.principalRef !== 'string' ||
    typeof input.initialActivation !== 'object'
  )
    throw new ActionBlockedError(
      'workflow_runtime_unavailable',
      'Workflow creation input must be assembled by the host for this collaboration operation',
    );
  if (action.binding.config.prompt_sha256 !== promptHash(action.prompt))
    throw new ActionBlockedError(
      'workflow_runtime_unavailable',
      'Workflow binding prompt hash is stale; the host must rebuild its input snapshot',
    );
  return configured as FiniteWorkflowCreationInput;
}

function executionIdentity(executionRef: string): {
  readonly workflowId: string;
  readonly graphRunId: string;
} | null {
  if (!executionRef.startsWith('workflow:')) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(executionRef.slice('workflow:'.length), 'base64url').toString(
        'utf8',
      ),
    ) as { workflowId?: unknown; graphRunId?: unknown };
    return typeof parsed.workflowId === 'string' &&
      typeof parsed.graphRunId === 'string'
      ? { workflowId: parsed.workflowId, graphRunId: parsed.graphRunId }
      : null;
  } catch {
    return null;
  }
}

function workflowExecutionRef(workflowId: string, graphRunId: string): string {
  return `workflow:${Buffer.from(JSON.stringify({ workflowId, graphRunId })).toString('base64url')}`;
}

export class WorkflowActionExecutor implements ActionExecutor {
  readonly kind = 'workflow' as const;
  private readonly receipts = new Map<string, DispatchReceipt>();
  private readonly actions = new Map<string, PreparedAction>();

  constructor(private readonly host: CollaborationWorkflowHostService) {}

  async prepare(request: ActionRequest): Promise<PreparedAction> {
    if (request.action.kind !== 'workflow')
      throw new Error('WorkflowActionExecutor received another action kind');
    if (!request.action.input.workflow_ref)
      throw new ActionBlockedError(
        'workflow_runtime_unavailable',
        'Workflow action has no workflow_ref',
      );
    return prepareWithLocalPolicy(request);
  }

  async dispatch(action: PreparedAction): Promise<DispatchReceipt> {
    const existing = this.receipts.get(action.operationKey);
    if (existing) return existing;
    const creationInput = configuredCreationInput(action);
    const started = this.host.startFiniteRun(creationInput);
    const executionRef = workflowExecutionRef(
      started.workflowId,
      started.activation.graphRunId,
    );
    const providerMetadata = {
      workflow_id: started.workflowId,
      graph_run_id: started.activation.graphRunId,
      activation_id: started.activation.activationId,
      creation_disposition: started.disposition,
      activation_disposition: started.activation.disposition,
      workflow_ref: action.action.input.workflow_ref,
    };
    const receipt: DispatchReceipt = {
      executionRef,
      providerMetadata,
      receipt: {
        accepted: true,
        operation_key: action.operationKey,
        workflow_id: started.workflowId,
        graph_run_id: started.activation.graphRunId,
      },
    };
    this.receipts.set(action.operationKey, receipt);
    this.actions.set(executionRef, action);
    return receipt;
  }

  async observe(executionRef: string): Promise<ActionObservation> {
    const identity = executionIdentity(executionRef);
    if (!identity)
      return this.recoveryRequired(
        executionRef,
        'Workflow execution ref is invalid',
      );
    const observation = this.host.observeFiniteRun(identity.graphRunId);
    return this.mapObservation(executionRef, identity, observation);
  }

  async recover(executionRef: string): Promise<ActionObservation> {
    const identity = executionIdentity(executionRef);
    if (!identity)
      return this.recoveryRequired(
        executionRef,
        'Workflow execution ref is invalid',
      );
    const observation = this.host.recoverFiniteRun(identity.graphRunId);
    return this.mapObservation(executionRef, identity, observation);
  }

  async cancel(executionRef: string, _reason: string): Promise<CancelResult> {
    return { cancelled: false, observation: await this.observe(executionRef) };
  }

  private mapObservation(
    executionRef: string,
    identity: { readonly workflowId: string; readonly graphRunId: string },
    observation: FiniteWorkflowRunObservation | null,
  ): ActionObservation {
    const providerMetadata = {
      workflow_id: identity.workflowId,
      graph_run_id: identity.graphRunId,
      ...(observation
        ? {
            lifecycle: observation.lifecycle,
            control: observation.control,
            operational_state: observation.operationalState,
          }
        : {}),
    };
    if (!observation)
      return this.recoveryRequired(
        executionRef,
        'Workflow run is missing from the connected Runtime Store',
        providerMetadata,
      );
    if (
      observation.state === 'running' ||
      observation.state === 'waiting_approval'
    )
      return {
        state: observation.state,
        executionRef,
        providerMetadata,
        result: null,
        resultHash: null,
      };
    const outcome =
      observation.state === 'succeeded'
        ? 'success'
        : observation.state === 'cancelled'
          ? 'cancelled'
          : 'failure';
    const result = collaborationActionResultSchema.parse({
      format: 'icarus.collaboration-action-result/1',
      outcome,
      summary:
        observation.state === 'succeeded'
          ? `Workflow completed via ${observation.exitName ?? 'default exit'}`
          : `Workflow ended as ${outcome}`,
      data: {
        workflow_id: identity.workflowId,
        graph_run_id: identity.graphRunId,
        outcome_kind: observation.outcomeKind,
        exit_name: observation.exitName,
        output: observation.output,
        output_hash: observation.outputHash,
      },
      artifacts: [],
      error:
        outcome === 'success'
          ? null
          : {
              code: observation.errorCode ?? `workflow_${outcome}`,
              message: `Workflow ended as ${outcome}`,
              retryable: outcome === 'failure',
            },
    });
    const action = this.actions.get(executionRef);
    if (action)
      return terminalObservation(
        observation.state,
        executionRef,
        providerMetadata,
        action.action,
        result,
      );
    return {
      state: observation.state,
      executionRef,
      providerMetadata,
      result,
      resultHash: actionResultHash(result),
    };
  }

  private recoveryRequired(
    executionRef: string,
    recoveryReason: string,
    providerMetadata: Record<string, unknown> = {},
  ): ActionObservation {
    return {
      state: 'recovery_required',
      executionRef,
      providerMetadata,
      result: null,
      resultHash: null,
      recoveryReason,
    };
  }
}
