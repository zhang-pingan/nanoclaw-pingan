import type { WorkflowRuntimeStore } from '../workflow-runtime/gateway/connection.js';
import {
  createFiniteWorkflowRun,
  observeFiniteWorkflowRun,
  type FiniteWorkflowCreationInput,
  type FiniteWorkflowCreationReceipt,
  type FiniteWorkflowRunObservation,
} from '../workflow-runtime/gateway/execution.js';

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
  ) {}

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
}

export type {
  FiniteWorkflowCreationInput,
  FiniteWorkflowCreationReceipt,
  FiniteWorkflowRunObservation,
};
