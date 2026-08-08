import type { WorkflowExecutionAdapter } from './types.js';

export type WorkflowExecutionAdapterReadiness =
  | { readonly status: 'unchecked'; readonly error: null }
  | { readonly status: 'ready'; readonly error: null }
  | { readonly status: 'unavailable'; readonly error: string };

export class WorkflowExecutionAdapterRegistry {
  private readonly adapters = new Map<string, WorkflowExecutionAdapter>();
  private readonly readiness = new Map<
    string,
    WorkflowExecutionAdapterReadiness
  >();

  register(adapter: WorkflowExecutionAdapter): void {
    if (this.adapters.has(adapter.refId))
      throw new Error(
        `Workflow execution Adapter already registered: ${adapter.refId}`,
      );
    this.adapters.set(adapter.refId, adapter);
    this.readiness.set(adapter.refId, { status: 'unchecked', error: null });
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

  getReadiness(refId: string): WorkflowExecutionAdapterReadiness {
    this.resolve(refId);
    return this.readiness.get(refId)!;
  }

  async preflight(refId: string): Promise<WorkflowExecutionAdapterReadiness> {
    const adapter = this.resolve(refId);
    try {
      await adapter.preflight();
      const ready = { status: 'ready', error: null } as const;
      this.readiness.set(refId, ready);
      return ready;
    } catch (error) {
      const unavailable = {
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      } as const;
      this.readiness.set(refId, unavailable);
      return unavailable;
    }
  }

  async preflightAll(): Promise<
    ReadonlyMap<string, WorkflowExecutionAdapterReadiness>
  > {
    await Promise.all(
      this.list().map((adapter) => this.preflight(adapter.refId)),
    );
    return new Map(this.readiness);
  }
}
