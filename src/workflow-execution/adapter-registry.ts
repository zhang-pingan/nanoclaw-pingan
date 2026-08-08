import type { WorkflowExecutionAdapter } from './types.js';

export type WorkflowExecutionAdapterFailureKind = 'configuration' | 'transient';

export type WorkflowExecutionAdapterReadiness =
  | {
      readonly status: 'unchecked';
      readonly error: null;
      readonly failureKind?: null;
      readonly checkedAtMs?: null;
    }
  | {
      readonly status: 'ready';
      readonly error: null;
      readonly failureKind?: null;
      readonly checkedAtMs?: number;
    }
  | {
      readonly status: 'unavailable';
      readonly error: string;
      readonly failureKind?: WorkflowExecutionAdapterFailureKind;
      readonly checkedAtMs?: number;
    };

export interface WorkflowExecutionAdapterRegistryOptions {
  readonly readinessTtlMs?: number;
  readonly preflightTimeoutMs?: number;
  readonly now?: () => number;
}

export class WorkflowExecutionAdapterUnavailableError extends Error {
  constructor(
    message: string,
    readonly failureKind: WorkflowExecutionAdapterFailureKind,
  ) {
    super(message);
    this.name = 'WorkflowExecutionAdapterUnavailableError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureKind(error: unknown): WorkflowExecutionAdapterFailureKind {
  if (error instanceof WorkflowExecutionAdapterUnavailableError)
    return error.failureKind;
  const message = errorMessage(error);
  return /(?:set|missing|required|not configured)[^\n]*WORKFLOW_[A-Z0-9_]+|WORKFLOW_[A-Z0-9_]+[^\n]*(?:must|required)/i.test(
    message,
  )
    ? 'configuration'
    : 'transient';
}

export class WorkflowExecutionAdapterRegistry {
  private readonly adapters = new Map<string, WorkflowExecutionAdapter>();
  private readonly readiness = new Map<
    string,
    WorkflowExecutionAdapterReadiness
  >();
  private readonly inFlight = new Map<
    string,
    Promise<WorkflowExecutionAdapterReadiness>
  >();
  private readonly readinessTtlMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: WorkflowExecutionAdapterRegistryOptions = {}) {
    this.readinessTtlMs = options.readinessTtlMs ?? 15_000;
    this.preflightTimeoutMs = options.preflightTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  register(adapter: WorkflowExecutionAdapter): void {
    if (this.adapters.has(adapter.refId))
      throw new Error(
        `Workflow execution Adapter already registered: ${adapter.refId}`,
      );
    this.adapters.set(adapter.refId, adapter);
    this.readiness.set(adapter.refId, {
      status: 'unchecked',
      error: null,
      failureKind: null,
      checkedAtMs: null,
    });
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

  markReady(refId: string): WorkflowExecutionAdapterReadiness {
    this.resolve(refId);
    const ready = {
      status: 'ready',
      error: null,
      failureKind: null,
      checkedAtMs: this.now(),
    } as const;
    this.readiness.set(refId, ready);
    return ready;
  }

  markUnavailable(
    refId: string,
    error: unknown,
  ): WorkflowExecutionAdapterReadiness {
    this.resolve(refId);
    const unavailable = {
      status: 'unavailable',
      error: errorMessage(error),
      failureKind: failureKind(error),
      checkedAtMs: this.now(),
    } as const;
    this.readiness.set(refId, unavailable);
    return unavailable;
  }

  async refresh(
    refId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<WorkflowExecutionAdapterReadiness> {
    const adapter = this.resolve(refId);
    const current = this.getReadiness(refId);
    if (
      !options.force &&
      typeof current.checkedAtMs === 'number' &&
      this.now() - current.checkedAtMs < this.readinessTtlMs
    ) {
      return current;
    }
    const pending = this.inFlight.get(refId);
    if (pending) return pending;
    let timeout: NodeJS.Timeout | null = null;
    const refresh = Promise.race([
      adapter.preflight(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Workflow execution Adapter preflight timed out after ${this.preflightTimeoutMs}ms`,
              ),
            ),
          this.preflightTimeoutMs,
        );
        timeout.unref?.();
      }),
    ])
      .then(() => this.markReady(refId))
      .catch((error) => this.markUnavailable(refId, error))
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        this.inFlight.delete(refId);
      });
    this.inFlight.set(refId, refresh);
    return refresh;
  }

  async preflight(refId: string): Promise<WorkflowExecutionAdapterReadiness> {
    return this.refresh(refId, { force: true });
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
