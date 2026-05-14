import { registerWorkflowActionHandler } from './registry.js';
import { asStringArray, isRecord } from './utils.js';

export function registerContextWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'context.set',
    description: 'Set workflow context keys from values.',
    params: [
      {
        name: 'values',
        type: 'object',
        required: true,
        description: 'Workflow context key-value pairs to set.',
        defaultValue: {},
      },
    ],
    run(input) {
      if (!isRecord(input.params.values)) {
        return {
          status: 'failure',
          error: 'values must be an object',
        };
      }
      const values = input.params.values;
      return {
        status: 'success',
        contextPatch: values,
        output: values,
        summary: `Updated workflow context keys: ${Object.keys(values).join(', ')}`,
      };
    },
  });

  registerWorkflowActionHandler({
    name: 'context.require',
    description: 'Fail unless all listed workflow context keys are present.',
    params: [
      {
        name: 'keys',
        type: 'string[]',
        required: true,
        description: 'Workflow context keys that must be present.',
        defaultValue: [],
      },
    ],
    run(input) {
      const keys = asStringArray(input.params.keys);
      const missing = keys.filter((key) => {
        const value = input.context[key];
        return value === undefined || value === null || value === '';
      });
      if (missing.length > 0) {
        return {
          status: 'failure',
          output: { missing },
          summary: `Missing required workflow context keys: ${missing.join(', ')}`,
          error: `Missing required workflow context keys: ${missing.join(', ')}`,
        };
      }
      return {
        status: 'success',
        output: { keys },
        summary: `Required workflow context keys are present: ${keys.join(', ')}`,
      };
    },
  });
}
