import { describe, expect, it } from 'vitest';

import { parseCreateWorkflowCommand } from './index.js';

describe('parseCreateWorkflowCommand', () => {
  it('reads staging_work_branch only', () => {
    const content = JSON.stringify({
      command: '/create-workflow',
      data: {
        name: 'testing workflow',
        service: 'demo-service',
        workflow_type: 'dev_test',
        start_from: 'testing',
        deliverable: '2026-04-08_feature',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
      },
    });

    expect(parseCreateWorkflowCommand(content)).toEqual({
      isCreateWorkflowCommand: true,
      data: {
        name: 'testing workflow',
        service: 'demo-service',
        workflow_type: 'dev_test',
        start_from: 'testing',
        deliverable: '2026-04-08_feature',
        work_branch: undefined,
        staging_base_branch: undefined,
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: undefined,
      },
    });
  });
});
