import type { WorkflowExecutionAdapter } from './types.js';

export class WorkflowExecutionAdapterRegistry {
  private readonly adapters = new Map<string, WorkflowExecutionAdapter>();

  register(adapter: WorkflowExecutionAdapter): void {
    if (this.adapters.has(adapter.refId))
      throw new Error(
        `Workflow execution Adapter already registered: ${adapter.refId}`,
      );
    this.adapters.set(adapter.refId, adapter);
  }

  resolve(refId: string): WorkflowExecutionAdapter {
    const adapter = this.adapters.get(refId);
    if (!adapter)
      throw new Error(`Workflow execution Adapter is not configured: ${refId}`);
    return adapter;
  }

  list(): readonly WorkflowExecutionAdapter[] {
    return [...this.adapters.values()];
  }
}
