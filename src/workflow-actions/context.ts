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
    name: 'context.set_if_empty',
    description: 'Set workflow context keys only when the current value is empty.',
    params: [
      {
        name: 'values',
        type: 'object',
        required: true,
        description: 'Workflow context key-value pairs to set if empty.',
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
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.params.values)) {
        const current = input.context[key];
        if (
          current === undefined ||
          current === null ||
          (typeof current === 'string' && current.trim() === '')
        ) {
          patch[key] = value;
        }
      }
      return {
        status: 'success',
        contextPatch: patch,
        output: patch,
        summary:
          Object.keys(patch).length > 0
            ? `Set empty workflow context keys: ${Object.keys(patch).join(', ')}`
            : 'No empty workflow context keys were updated',
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
