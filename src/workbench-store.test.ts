import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createWorkflow as dbCreateWorkflow,
  getAllRegisteredGroups,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { RegisteredGroup } from './types.js';
import { approveWorkflow, initWorkflow } from './workflow.js';
import { getWorkbenchTaskDetail } from './workbench.js';
import { syncWorkbenchOnWorkflowCreated } from './workbench-store.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'web_main',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
  isMain: true,
};

const OPS_GROUP: RegisteredGroup = {
  name: 'Ops',
  folder: 'web_ops',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
};

const TEST_GROUP: RegisteredGroup = {
  name: 'Test',
  folder: 'web_test',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
};

const DEV_GROUP: RegisteredGroup = {
  name: 'Dev',
  folder: 'web_dev',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
};

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('ops@g.us', OPS_GROUP);
  setRegisteredGroup('test@g.us', TEST_GROUP);
  setRegisteredGroup('dev@g.us', DEV_GROUP);
  storeChatMetadata('main@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('ops@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('test@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('dev@g.us', '2026-04-07T00:00:00.000Z');
  initWorkflow({
    registeredGroups: () => getAllRegisteredGroups(),
    enqueueMessageCheck: () => {},
  });
});

describe('workbench approval transition sync', () => {
  it('marks awaiting_confirm completed and clears pending approval after approve', () => {
    dbCreateWorkflow({
      id: 'wf-predeploy',
      name: '预发部署验证',
      service: 'order-service',
      start_from: 'testing',
      branch: 'feature/predeploy',
      deliverable: '2026-04-07_predeploy',
      deploy_branch: 'staging-deploy/feature-predeploy',
      status: 'awaiting_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-predeploy');

    const result = approveWorkflow('wf-predeploy');
    expect(result.error).toBeUndefined();

    const detail = getWorkbenchTaskDetail('wb-wf-predeploy');
    expect(detail).not.toBeNull();
    expect(detail?.task.current_stage).toBe('ops_deploy');
    expect(detail?.approvals).toHaveLength(0);
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'awaiting_confirm')?.status,
    ).toBe('completed');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'ops_deploy')?.status,
    ).toBe('current');
  });
});
