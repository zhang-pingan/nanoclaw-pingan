import { describe, expect, it } from 'vitest';

import {
  listWorkflowActionHandlerDetails,
  listWorkflowActionHandlers,
} from './index.js';

describe('workflow action registry', () => {
  it('lists registered handlers with descriptions for web clients', () => {
    expect(listWorkflowActionHandlers()).toEqual([
      'assert.equals',
      'context.require',
      'context.set',
      'json.parse',
      'script.run_local',
    ]);

    expect(listWorkflowActionHandlerDetails()).toEqual([
      {
        name: 'assert.equals',
        description: 'Fail unless actual and expected are strictly equal.',
      },
      {
        name: 'context.require',
        description:
          'Fail unless all listed workflow context keys are present.',
      },
      {
        name: 'context.set',
        description: 'Set workflow context keys from values or top-level params.',
      },
      {
        name: 'json.parse',
        description: 'Parse JSON text and optionally pick a dotted path.',
      },
      {
        name: 'script.run_local',
        description: 'Run an allowed local shell script under local/shell.',
      },
    ]);
  });
});
