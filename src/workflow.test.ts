import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  createWorkflow,
  getAllRegisteredGroups,
  getDelegationsByWorkflow,
  getWorkflow,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { PROJECT_ROOT } from './config.js';
import type { RegisteredGroup } from './types.js';
import {
  approveWorkflow,
  createNewWorkflow,
  initWorkflow,
  listDeliverables,
  onDelegationComplete,
} from './workflow.js';

const GROUPS: Array<[string, RegisteredGroup]> = [
  [
    'main@g.us',
    {
      name: 'Main',
      folder: 'web_main',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
      isMain: true,
    },
  ],
  [
    'plan@g.us',
    {
      name: 'Plan',
      folder: 'web_plan',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
  [
    'plan-examine@g.us',
    {
      name: 'Plan Examine',
      folder: 'web_plan_examine',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
  [
    'dev@g.us',
    {
      name: 'Dev',
      folder: 'web_dev',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
  [
    'dev-examine@g.us',
    {
      name: 'Dev Examine',
      folder: 'web_dev_examine',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
  [
    'ops@g.us',
    {
      name: 'Ops',
      folder: 'web_ops',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
  [
    'test@g.us',
    {
      name: 'Test',
      folder: 'web_test',
      trigger: '/nc',
      added_at: '2026-04-08T00:00:00.000Z',
    },
  ],
];

const TEST_SERVICE = 'workflow-test-service';
const ITERATION_DIR = path.join(
  PROJECT_ROOT,
  'projects',
  TEST_SERVICE,
  'iteration',
);

function writeDoc(dirName: string, fileName: string, content: string): void {
  const dir = path.join(ITERATION_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

beforeEach(() => {
  _initTestDatabase();
  fs.rmSync(path.join(PROJECT_ROOT, 'projects', TEST_SERVICE), {
    recursive: true,
    force: true,
  });
  for (const [jid, group] of GROUPS) {
    setRegisteredGroup(jid, group);
    storeChatMetadata(jid, '2026-04-08T00:00:00.000Z');
  }
  initWorkflow({
    registeredGroups: () => getAllRegisteredGroups(),
    enqueueMessageCheck: () => {},
  });
});

describe('workflow metadata and branch flow', () => {
  it('reads deliverable metadata from front matter for dev entry', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nwork_branch: feature/test_20260408\nstaging_base_branch: staging\nstaging_work_branch: staging-deploy/feature-test_20260408\ndoc_type: plan\n---\n\n# Plan\n`,
    );

    const result = createNewWorkflow({
      name: 'Test feature',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'dev',
      workflowType: 'dev_test',
      deliverable: '2026-04-08_feature',
    });

    expect(result.error).toBeUndefined();
    const workflow = getWorkflow(result.workflowId);
    expect(workflow?.work_branch).toBe('feature/test_20260408');
    expect(workflow?.staging_base_branch).toBe('staging');
    expect(workflow?.staging_work_branch).toBe(
      'staging-deploy/feature-test_20260408',
    );
  });

  it('propagates plan result fields into next delegation', () => {
    createWorkflow({
      id: 'wf-plan',
      name: 'Plan flow',
      service: TEST_SERVICE,
      start_from: 'plan',
      work_branch: '',
      deliverable: '',
      staging_base_branch: '',
      staging_work_branch: '',
      access_token: '',
      status: 'plan',
      current_delegation_id: 'del-plan',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-plan',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan@g.us',
      target_folder: 'web_plan',
      task: 'plan task',
      status: 'completed',
      result: JSON.stringify({
        service: TEST_SERVICE,
        deliverable: '2026-04-08_feature',
        work_branch: 'feature/test_20260408',
        summary: '方案已完成',
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-plan',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-plan');

    const workflow = getWorkflow('wf-plan');
    expect(workflow?.status).toBe('plan_examine');
    expect(workflow?.deliverable).toBe('2026-04-08_feature');
    expect(workflow?.work_branch).toBe('feature/test_20260408');

    const delegations = getDelegationsByWorkflow('wf-plan');
    const latest = delegations.find((item) => item.id !== 'del-plan');
    expect(latest?.task).toContain(
      `方案文件：/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/plan.md`,
    );
  });

  it('persists staging branches from ops result and sends them to testing', () => {
    createWorkflow({
      id: 'wf-ops',
      name: 'Ops flow',
      service: TEST_SERVICE,
      start_from: 'testing',
      work_branch: 'feature/test_20260408',
      deliverable: '2026-04-08_feature',
      staging_base_branch: '',
      staging_work_branch: '',
      access_token: 'abc123',
      status: 'ops_deploy',
      current_delegation_id: 'del-ops',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-ops',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'ops@g.us',
      target_folder: 'web_ops',
      task: 'ops task',
      status: 'completed',
      result: JSON.stringify({
        service: TEST_SERVICE,
        work_branch: 'feature/test_20260408',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        summary: '预发部署完成',
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-ops',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-ops');
    let workflow = getWorkflow('wf-ops');
    expect(workflow?.status).toBe('testing_confirm');
    expect(workflow?.staging_base_branch).toBe('staging');
    expect(workflow?.staging_work_branch).toBe(
      'staging-deploy/feature-test_20260408',
    );

    const approveResult = approveWorkflow('wf-ops');
    expect(approveResult.error).toBeUndefined();

    workflow = getWorkflow('wf-ops');
    expect(workflow?.status).toBe('testing');
    const delegations = getDelegationsByWorkflow('wf-ops');
    const testingDelegation = delegations.find((item) => item.id !== 'del-ops');
    expect(testingDelegation?.task).toContain(
      '工作分支：feature/test_20260408',
    );
    expect(testingDelegation?.task).toContain('预发分支：staging');
    expect(testingDelegation?.task).toContain(
      '预发工作分支：staging-deploy/feature-test_20260408',
    );
  });

  it('lists deliverables using front matter metadata instead of text scanning', () => {
    writeDoc(
      '2026-04-08_feature',
      'dev.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nwork_branch: feature/test_20260408\nstaging_base_branch: staging\nstaging_work_branch: staging-deploy/feature-test_20260408\ndoc_type: dev\n---\n\n主工作分支：feature/ignored\n下游服务工作分支：feature/downstream\n`,
    );

    const deliverables = listDeliverables(TEST_SERVICE);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].work_branch).toBe('feature/test_20260408');
    expect(deliverables[0].staging_base_branch).toBe('staging');
    expect(deliverables[0].staging_work_branch).toBe(
      'staging-deploy/feature-test_20260408',
    );
  });
});
