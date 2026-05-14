import { registerWorkflowActionHandler } from './registry.js';
import { getPathValue } from './utils.js';

export function registerJsonWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'json.parse',
    description: 'Parse JSON text and optionally pick a dotted path.',
    params: [
      {
        name: 'source',
        type: 'string',
        required: true,
        description: 'JSON text to parse.',
        placeholder: '{{steps.step_1.value}}',
      },
      {
        name: 'pick',
        type: 'string',
        required: false,
        description: 'Optional dotted path to pick from the parsed JSON.',
        placeholder: 'data.items.0',
      },
    ],
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
