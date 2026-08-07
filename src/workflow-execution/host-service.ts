import type { WorkflowRuntimeStore } from '../workflow-runtime/gateway/connection.js';
import {
  createFiniteWorkflowRun,
  observeFiniteWorkflowRun,
  resolveFiniteWorkflowCreationInput,
  type FiniteWorkflowCreationInput,
  type FiniteWorkflowCreationReceipt,
  type FiniteWorkflowCreationTemplate,
  type FiniteWorkflowRunObservation,
} from '../workflow-runtime/gateway/execution.js';

export interface CollaborationFiniteWorkflowRequest {
  readonly workflowRef: string;
  readonly operationKey: string;
  readonly promptSha256: string;
  readonly bindingConfig: Record<string, unknown>;
}

export interface CollaborationWorkflowLaunchProfile {
  readonly format: 'icarus.collaboration-workflow-launch-profile/1';
  readonly workflow_ref: string;
  readonly prompt_sha256: string;
  readonly template: FiniteWorkflowCreationTemplate;
}

export interface WorkflowExecutionHostGateway {
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
      nowMs: this.now(),
      template: profile.template,
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
