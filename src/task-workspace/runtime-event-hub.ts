export interface RuntimeEventHint {
  readonly workflow_id?: string;
  readonly run_id?: string;
  readonly reason?: string;
}

export type RuntimeEventHintListener = (
  hint: RuntimeEventHint,
) => void | Promise<void>;

/** Best-effort Host wake hub. Runtime cursor reads remain authoritative. */
export class RuntimeEventHub {
  private readonly listeners = new Set<RuntimeEventHintListener>();

  subscribe(listener: RuntimeEventHintListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(hint: RuntimeEventHint): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(hint)).catch(() => undefined);
      } catch {
        // A wake notification is deliberately lossy; cursor polling recovers it.
      }
    }
  }
}
