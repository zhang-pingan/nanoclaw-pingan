import type { ActionDefinition } from '../protocol/index.js';
import type { ActionExecutor } from './types.js';

function key(kind: ActionDefinition['kind'], adapter?: string): string {
  return kind === 'external' ? `${kind}:${adapter ?? ''}` : kind;
}

export class ActionExecutorRegistry {
  private readonly executors = new Map<string, ActionExecutor>();

  register(executor: ActionExecutor): void {
    const id = key(executor.kind, executor.adapter);
    if (this.executors.has(id))
      throw new Error(
        `Collaboration Action Executor already registered: ${id}`,
      );
    if (executor.kind === 'external' && !executor.adapter)
      throw new Error('External Action Executors require an adapter id');
    this.executors.set(id, executor);
  }

  resolve(action: ActionDefinition): ActionExecutor {
    const id = key(action.kind, action.adapter);
    const executor = this.executors.get(id);
    if (!executor)
      throw new Error(`Collaboration Action Executor is not configured: ${id}`);
    return executor;
  }

  list(): readonly ActionExecutor[] {
    return [...this.executors.values()];
  }
}
