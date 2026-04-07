import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createWorkflow as dbCreateWorkflow,
  getAllRegisteredGroups,
  getWorkbenchTaskByWorkflowId,
  listWorkbenchEventsByTask,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { RegisteredGroup } from './types.js';
import { approveWorkflow, initWorkflow } from './workflow.js';
import { getWorkbenchTaskDetail } from './workbench.js';
import { syncWorkbenchOnTransition, syncWorkbenchOnWorkflowCreated } from './workbench-store.js';

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
    expect(detail?.subtasks.map((item) => item.stage_key)).toEqual([
      'awaiting_confirm',
      'ops_deploy',
      'testing',
      'fixing',
    ]);
  });

  it('does not duplicate the same transition event when re-synced', () => {
    dbCreateWorkflow({
      id: 'wf-transition-dedupe',
      name: '部署失败去重',
      service: 'order-service',
      start_from: 'testing',
      branch: 'feature/fail',
      deliverable: '2026-04-07_fail',
      deploy_branch: 'staging-deploy/feature-fail',
      status: 'ops_failed',
      current_delegation_id: 'wf-del-1',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:10:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-transition-dedupe');

    syncWorkbenchOnTransition('wf-transition-dedupe', 'ops_deploy', 'ops_failed', 'wf-del-1');
    syncWorkbenchOnTransition('wf-transition-dedupe', 'ops_deploy', 'ops_failed', 'wf-del-1');

    const task = getWorkbenchTaskByWorkflowId('wf-transition-dedupe');
    expect(task).not.toBeNull();

    const transitionEvents = listWorkbenchEventsByTask(task!.id).filter(
      (item) => item.event_type === 'transition' && item.title.includes('部署中') && item.title.includes('部署失败'),
    );
    expect(transitionEvents).toHaveLength(1);
  });
});
