import { describe, expect, it } from 'vitest';

import {
  getWorkflowActionHandler,
  listWorkflowActionHandlerDetails,
  listWorkflowActionHandlers,
} from './index.js';

describe('workflow action registry', () => {
  it('lists registered handlers with descriptions for web clients', () => {
    expect(listWorkflowActionHandlers()).toEqual([
      'assert.equals',
      'context.require',
      'context.set',
      'context.set_if_empty',
      'json.parse',
      'script.run_local',
    ]);

    expect(listWorkflowActionHandlerDetails()).toEqual([
      {
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
      },
      {
        name: 'context.require',
        description:
          'Fail unless all listed workflow context keys are present.',
        params: [
          {
            name: 'keys',
            type: 'string[]',
            required: true,
            description: 'Workflow context keys that must be present.',
            defaultValue: [],
          },
        ],
      },
      {
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
      },
      {
        name: 'context.set_if_empty',
        description:
          'Set workflow context keys only when the current value is empty.',
        params: [
          {
            name: 'values',
            type: 'object',
            required: true,
            description: 'Workflow context key-value pairs to set if empty.',
            defaultValue: {},
          },
        ],
      },
      {
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
      },
      {
        name: 'script.run_local',
        description: 'Run an allowed local shell script under local/shell.',
        params: [
          {
            name: 'script_path',
            type: 'string',
            required: true,
            description: 'Script path under local/shell.',
            placeholder: 'restart.sh',
          },
          {
            name: 'args',
            type: 'string[]',
            required: false,
            description: 'Arguments passed to the script.',
            defaultValue: [],
          },
          {
            name: 'timeout_ms',
            type: 'number',
            required: false,
            description: 'Optional timeout in milliseconds.',
          },
          {
            name: 'max_output_bytes',
            type: 'number',
            required: false,
            description: 'Optional maximum captured output size in bytes.',
          },
        ],
      },
    ]);
  });

  it('requires context.set values to be an object', () => {
    const handler = getWorkflowActionHandler('context.set');
    expect(handler).toBeDefined();

    const invalid = handler!.run({
      workflow: {} as never,
      stateKey: 'prepare',
      params: { work_branch: 'feature/test' },
      context: {},
      steps: {},
    });
    expect(invalid.status).toBe('failure');
    expect(invalid.error).toBe('values must be an object');

    const valid = handler!.run({
      workflow: {} as never,
      stateKey: 'prepare',
      params: { values: { work_branch: 'feature/test' } },
      context: {},
      steps: {},
    });
    expect(valid.status).toBe('success');
    expect(valid.contextPatch).toEqual({ work_branch: 'feature/test' });
  });

  it('sets context values only when current values are empty', () => {
    const handler = getWorkflowActionHandler('context.set_if_empty');
    expect(handler).toBeDefined();

    const result = handler!.run({
      workflow: {} as never,
      stateKey: 'prepare',
      params: {
        values: {
          ios_work_branch: 'feature/generated',
          work_branch: 'feature/new-server',
        },
      },
      context: {
        ios_work_branch: '',
        work_branch: 'feature/existing-server',
      },
      steps: {},
    });

    expect(result.status).toBe('success');
    expect(result.contextPatch).toEqual({
      ios_work_branch: 'feature/generated',
    });
  });
});
