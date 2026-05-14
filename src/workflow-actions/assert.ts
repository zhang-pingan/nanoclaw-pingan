import { registerWorkflowActionHandler } from './registry.js';

export function registerAssertWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'assert.equals',
    description: 'Fail unless actual and expected are strictly equal.',
    params: [
      {
        name: 'actual',
        type: 'any',
        required: true,
        description: 'Actual value to compare.',
      },
      {
        name: 'expected',
        type: 'any',
        required: true,
        description: 'Expected value to compare against.',
      },
    ],
    run(input) {
      const actual = input.params.actual;
      const expected = input.params.expected;
      if (actual !== expected) {
        return {
          status: 'failure',
          output: { actual, expected },
          summary: `Assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          error: 'assert.equals failed',
        };
      }
      return {
        status: 'success',
        output: { actual, expected },
        summary: 'Assertion passed',
      };
    },
  });
}
