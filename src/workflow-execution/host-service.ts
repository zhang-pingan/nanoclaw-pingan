import type { WorkflowRuntimeStore } from '../workflow-runtime/gateway/connection.js';
import {
  createFiniteWorkflowRun,
  insertInlineValue,
  observeFiniteWorkflowRun,
  resolveFiniteWorkflowCreationInput,
  runtimeObjectHash,
  stableRuntimeId,
  type FiniteWorkflowCreationInput,
  type FiniteWorkflowCreationReceipt,
  type FiniteWorkflowCreationTemplate,
  type FiniteWorkflowRunObservation,
} from '../workflow-runtime/gateway/execution.js';
import type { JsonObject } from '../workflow-runtime/contracts/types.js';

export interface CollaborationFiniteWorkflowRequest {
  readonly workflowRef: string;
  readonly operationKey: string;
  readonly promptSha256: string;
  readonly actionInput: JsonObject;
  readonly bindingConfig: Record<string, unknown>;
}

export interface CollaborationWorkflowLaunchProfile {
  readonly format: 'icarus.collaboration-workflow-launch-profile/1';
  readonly workflow_ref: string;
  readonly prompt_sha256: string;
  readonly template: FiniteWorkflowCreationTemplate;
}

export interface WorkflowExecutionHostGateway {
  persistCollaborationActionInput(
    store: WorkflowRuntimeStore,
    input: {
      readonly operationKey: string;
      readonly actionInput: JsonObject;
      readonly inputSchema: FiniteWorkflowCreationTemplate['inputSchema'];
      readonly nowMs: number;
    },
  ): FiniteWorkflowCreationTemplate['input'];
  create(
    store: WorkflowRuntimeStore,
    input: FiniteWorkflowCreationInput,
  ): FiniteWorkflowCreationReceipt;
  observe(
    store: WorkflowRuntimeStore,
    graphRunId: string,
  ): FiniteWorkflowRunObservation | null;
}

const DEFAULT_GATEWAY: WorkflowExecutionHostGateway = {
  persistCollaborationActionInput(store, input) {
    const contentHash = runtimeObjectHash('value', input.actionInput);
    const id = stableRuntimeId('value', {
      source: 'collaboration_action_input_v3',
      operation_key: input.operationKey,
      content_hash: contentHash,
    });
    store.withImmediateTransaction((transaction) => {
      insertInlineValue(transaction, {
        id,
        content: input.actionInput,
        contentHash,
        schemaResourceId: input.inputSchema.rowId,
        schemaResourceHash: input.inputSchema.hash,
        provenanceRef: `collaboration:${input.operationKey}:action-input`,
        retentionClass: 'run_recovery',
        createdAtMs: input.nowMs,
      });
    });
    return { id, hash: contentHash };
  },
  create: createFiniteWorkflowRun,
  observe: observeFiniteWorkflowRun,
};

export class WorkflowExecutionHostService {
  constructor(
    private readonly runtimeStore: WorkflowRuntimeStore,
    private readonly gateway: WorkflowExecutionHostGateway = DEFAULT_GATEWAY,
    private readonly now: () => number = Date.now,
  ) {}

  startCollaborationFiniteRun(
    request: CollaborationFiniteWorkflowRequest,
  ): FiniteWorkflowCreationReceipt {
    const profile = this.resolveCollaborationLaunchProfile(request);
    const nowMs = this.now();
    const actionInput = this.gateway.persistCollaborationActionInput(
      this.runtimeStore,
      {
        operationKey: request.operationKey,
        actionInput: request.actionInput,
        inputSchema: profile.template.inputSchema,
        nowMs,
      },
    );
    const input = resolveFiniteWorkflowCreationInput({
      requestId: `collaboration:${request.operationKey}`,
      creationDomain: 'agent_group_collaboration',
      creationKey: request.operationKey,
      source: 'api',
      actor: 'system',
      launchPolicy: 'auto',
      launchAuthorization: {
        kind: 'trusted_system',
        authorizationRef: `collaboration:${request.operationKey}`,
      },
      entryPoint: 'default',
      nowMs,
      template: {
        ...profile.template,
        input: actionInput,
      },
    });
    return this.startFiniteRun(input);
  }

  startFiniteRun(
    input: FiniteWorkflowCreationInput,
  ): FiniteWorkflowCreationReceipt {
    return this.gateway.create(this.runtimeStore, input);
  }

  observeFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null {
    return this.gateway.observe(this.runtimeStore, graphRunId);
  }

  recoverFiniteRun(graphRunId: string): FiniteWorkflowRunObservation | null {
    return this.observeFiniteRun(graphRunId);
  }

  private resolveCollaborationLaunchProfile(
    request: CollaborationFiniteWorkflowRequest,
  ): CollaborationWorkflowLaunchProfile {
    const candidate = request.bindingConfig.workflow_launch_profile;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error(
        'Workflow binding requires a host-resolved workflow_launch_profile',
      );
    const profile = candidate as Record<string, unknown>;
    if (
      profile.format !== 'icarus.collaboration-workflow-launch-profile/1' ||
      profile.workflow_ref !== request.workflowRef ||
      profile.prompt_sha256 !== request.promptSha256 ||
      !profile.template ||
      typeof profile.template !== 'object' ||
      Array.isArray(profile.template)
    )
      throw new Error(
        'Workflow launch profile does not match the local action reference and prompt',
      );
    const template = profile.template as Record<string, unknown>;
    for (const dynamicField of [
      'requestId',
      'creationDomain',
      'creationKey',
      'source',
      'actor',
      'launchPolicy',
      'launchAuthorization',
      'entryPoint',
      'creationIntentHash',
      'nowMs',
    ]) {
      if (dynamicField in template)
        throw new Error(
          `Workflow launch profile must not configure host-owned ${dynamicField}`,
        );
    }
    if (
      typeof template.principalRef !== 'string' ||
      !template.recipe ||
      typeof template.recipe !== 'object' ||
      !template.routingScope ||
      typeof template.routingScope !== 'object' ||
      !template.input ||
      typeof template.input !== 'object' ||
      !template.attachments ||
      typeof template.attachments !== 'object' ||
      !template.initialActivation ||
      typeof template.initialActivation !== 'object' ||
      Array.isArray(template.initialActivation) ||
      'nowMs' in template.initialActivation
    )
      throw new Error('Workflow launch profile template is incomplete');
    return profile as unknown as CollaborationWorkflowLaunchProfile;
  }
}

export type {
  FiniteWorkflowCreationInput,
  FiniteWorkflowCreationReceipt,
  FiniteWorkflowCreationTemplate,
  FiniteWorkflowRunObservation,
};
