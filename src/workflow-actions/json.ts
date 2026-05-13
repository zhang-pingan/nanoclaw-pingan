import { registerWorkflowActionHandler } from './registry.js';
import { getPathValue } from './utils.js';

export function registerJsonWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'json.parse',
    description: 'Parse JSON text and optionally pick a dotted path.',
    run(input) {
      const source = input.params.source;
      if (typeof source !== 'string') {
        return {
          status: 'failure',
          error: 'source must be a string',
        };
      }
      try {
        const parsed = JSON.parse(source) as unknown;
        const output =
          typeof input.params.pick === 'string'
            ? getPathValue(parsed, input.params.pick)
            : parsed;
        return {
          status: 'success',
          output: { value: output },
          summary: 'JSON parsed',
        };
      } catch (err) {
        return {
          status: 'failure',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
