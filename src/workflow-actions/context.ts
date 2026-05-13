import { registerWorkflowActionHandler } from './registry.js';
import { asStringArray, isRecord } from './utils.js';

export function registerContextWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'context.set',
    run(input) {
      const values = isRecord(input.params.values)
        ? input.params.values
        : input.params;
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
