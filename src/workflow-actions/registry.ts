import type { Workflow } from '../types.js';
import type { WorkflowContext } from '../workflow-context.js';

export type WorkflowActionStatus = 'success' | 'failure' | 'pending';

export interface WorkflowActionRunInput {
  workflow: Workflow;
  stateKey: string;
  params: Record<string, unknown>;
  context: WorkflowContext;
  steps: Record<string, unknown>;
}

export interface WorkflowActionResult {
  status: WorkflowActionStatus;
  output?: Record<string, unknown>;
  contextPatch?: WorkflowContext;
  summary?: string;
  error?: string;
}

export type WorkflowActionParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'object'
  | 'any';

export interface WorkflowActionParamDefinition {
  name: string;
  type: WorkflowActionParamType;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
  placeholder?: string;
}

export interface WorkflowActionHandler {
  name: string;
  description?: string;
  params?: WorkflowActionParamDefinition[];
  run(input: WorkflowActionRunInput): WorkflowActionResult;
}

const handlers = new Map<string, WorkflowActionHandler>();

export function registerWorkflowActionHandler(
  handler: WorkflowActionHandler,
): void {
  handlers.set(handler.name, handler);
}

export function getWorkflowActionHandler(
  name: string,
): WorkflowActionHandler | undefined {
  return handlers.get(name);
}

export function listWorkflowActionHandlers(): string[] {
  return Array.from(handlers.keys()).sort();
}

export function listWorkflowActionHandlerDetails(): Array<{
  name: string;
  description?: string;
  params?: WorkflowActionParamDefinition[];
}> {
  return Array.from(handlers.values())
    .map((handler) => ({
      name: handler.name,
      description: handler.description,
      params: handler.params,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
