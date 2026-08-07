import crypto from 'node:crypto';

import type {
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
  startCollaborationFiniteRun(input: {
    readonly workflowRef: string;
    readonly operationKey: string;
    readonly promptSha256: string;
    readonly bindingConfig: Record<string, unknown>;
  }): FiniteWorkflowCreationReceipt;
  observeFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null;
  recoverFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null;
}

function promptHash(prompt: string): string {
  return `sha256:${crypto.createHash('sha256').update(prompt).digest('hex')}`;
}

function identityFromMetadata(
  providerMetadata: Record<string, unknown> | undefined,
): { readonly workflowId: string; readonly graphRunId: string } | null {
  return typeof providerMetadata?.workflow_id === 'string' &&
    typeof providerMetadata.graph_run_id === 'string'
    ? {
        workflowId: providerMetadata.workflow_id,
        graphRunId: providerMetadata.graph_run_id,
      }
    : null;
}

export class WorkflowActionExecutor implements ActionExecutor {
  readonly kind = 'workflow' as const;
  private readonly receipts = new Map<string, DispatchReceipt>();
  private readonly actions = new Map<string, PreparedAction>();
  private readonly identities = new Map<
    string,
    { readonly workflowId: string; readonly graphRunId: string }
  >();

  constructor(private readonly host: CollaborationWorkflowHostService) {}

  async prepare(request: ActionRequest): Promise<PreparedAction> {
    if (request.action.kind !== 'workflow')
      throw new Error('WorkflowActionExecutor received another action kind');
    if (!request.action.workflow_ref)
      throw new ActionBlockedError(
        'workflow_runtime_unavailable',
        'Workflow action has no workflow_ref',
      );
    return prepareWithLocalPolicy(request);
  }

  async dispatch(action: PreparedAction): Promise<DispatchReceipt> {
    const existing = this.receipts.get(action.operationKey);
    if (existing) return existing;
    let started: FiniteWorkflowCreationReceipt;
    try {
      started = this.host.startCollaborationFiniteRun({
        workflowRef: action.action.workflow_ref!,
        operationKey: action.operationKey,
        promptSha256: promptHash(action.prompt),
        bindingConfig: action.binding.config,
      });
    } catch (error) {
      throw new ActionBlockedError(
        'workflow_runtime_unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
    const executionRef = `collaboration-action:${crypto.randomUUID()}`;
    const providerMetadata = {
      workflow_id: started.workflowId,
      graph_run_id: started.activation.graphRunId,
      activation_id: started.activation.activationId,
      creation_disposition: started.disposition,
      activation_disposition: started.activation.disposition,
      workflow_ref: action.action.workflow_ref,
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
    this.identities.set(executionRef, {
      workflowId: started.workflowId,
      graphRunId: started.activation.graphRunId,
    });
    return receipt;
  }

  async observe(executionRef: string): Promise<ActionObservation> {
    const identity = this.identities.get(executionRef) ?? null;
    if (!identity)
      return this.recoveryRequired(
        executionRef,
        'Workflow execution ref is invalid',
      );
    const observation = this.host.observeFiniteRun(identity.graphRunId);
    return this.mapObservation(executionRef, identity, observation);
  }

  async recover(
    executionRef: string,
    providerMetadata?: Record<string, unknown>,
  ): Promise<ActionObservation> {
    const identity =
      this.identities.get(executionRef) ??
      identityFromMetadata(providerMetadata);
    if (!identity)
      return this.recoveryRequired(
        executionRef,
        'Workflow execution ref is invalid',
      );
    this.identities.set(executionRef, identity);
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
      format: 'icarus.collaboration-action-result/3',
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
