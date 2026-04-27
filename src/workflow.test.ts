import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  createWorkflow,
  getAllRegisteredGroups,
  getDelegationsByWorkflow,
  getLatestWorkflowStageEvaluation,
  getWorkflow,
  setRegisteredGroup,
  storeChatMetadata,
  updateDelegation,
} from './db.js';
import { PROJECT_ROOT } from './config.js';
import type { RegisteredGroup } from './types.js';
import {
  approveWorkflow,
  createNewWorkflow,
  getAvailableWorkflowTypes,
  initWorkflow,
  onDelegationComplete,
} from './workflow.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';

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

function buildStructuredResult(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    verdict: 'passed',
    summary: '阶段完成',
    findings: [],
    evidence: [
      {
        type: 'message',
        summary: '已产出结构化评测结果',
      },
    ],
    ...overrides,
  });
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
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nmain_branch: main\nwork_branch: feature/test_20260408\nstaging_base_branch: staging\nstaging_work_branch: staging-deploy/feature-test_20260408\ndoc_type: plan\n---\n\n# Plan\n`,
    );

    const result = createNewWorkflow({
      title: 'Test feature',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'dev',
      workflowType: 'dev_test',
      deliverable: '2026-04-08_feature',
    });

    expect(result.error).toBeUndefined();
    const workflow = getWorkflow(result.workflowId);
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.mainBranch),
    ).toBe('main');
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ).toBe('feature/test_20260408');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingBaseBranch,
        ),
    ).toBe('staging');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
        ),
    ).toBe('staging-deploy/feature-test_20260408');
  });

  it('injects requirement description and attachment paths into the plan delegation task', () => {
    const result = createNewWorkflow({
      title: '用户昵称支持表情并限制长度',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'plan',
      workflowType: 'dev_test',
      requirementDescription:
        '需要支持用户昵称输入表情，昵称最长 20 个可见字符，并兼容历史数据展示。',
      requirementFiles: ['/tmp/nickname-prd.md', '/tmp/nickname-ui.png'],
    });

    expect(result.error).toBeUndefined();
    const workflow = getWorkflow(result.workflowId);
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.requirementDescription,
        ),
    ).toContain('昵称最长 20 个可见字符');

    const delegations = getDelegationsByWorkflow(result.workflowId);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]?.task).toContain(
      '需求描述：需要支持用户昵称输入表情',
    );
    expect(delegations[0]?.task).toContain('- /tmp/nickname-prd.md');
    expect(delegations[0]?.task).toContain('- /tmp/nickname-ui.png');
  });

  it('starts fix_test from the single fix entry with bug context', () => {
    const result = createNewWorkflow({
      title: '登录态为空时接口返回 500',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'fix',
      workflowType: 'fix_test',
      workBranch: 'bugfix/login-empty-500',
      stagingWorkBranch: 'staging-deploy/bugfix-login-empty-500',
      context: {
        bug_description:
          '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log', '/tmp/login-500.png'],
      },
    });

    expect(result.error).toBeUndefined();
    const workflow = getWorkflow(result.workflowId);
    expect(workflow?.status).toBe('bug_fix');
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ).toBe('bugfix/login-empty-500');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
        ),
    ).toBe('staging-deploy/bugfix-login-empty-500');

    const delegations = getDelegationsByWorkflow(result.workflowId);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]?.target_folder).toBe('web_dev');
    expect(delegations[0]?.task).toContain('Bug 描述：用户未登录访问资料接口时返回 500');
    expect(delegations[0]?.task).toContain('- /tmp/login-500.log');
    expect(delegations[0]?.task).toContain('工作分支：bugfix/login-empty-500');
    expect(delegations[0]?.task).toContain(
      '预发工作分支：staging-deploy/bugfix-login-empty-500',
    );
  });

  it('routes fix_test bug verification failure to refix and increments round', () => {
    createWorkflow({
      id: 'wf-fix-test-failed',
      name: 'Login empty token 500',
      service: TEST_SERVICE,
      start_from: 'fix',
      context: {
        bug_description:
          '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log'],
        work_branch: 'bugfix/login-empty-500',
        staging_work_branch: 'staging-deploy/bugfix-login-empty-500',
        deliverable: '2026-04-08_bugfix_login-empty-500',
      },
      status: 'bug_test',
      current_delegation_id: 'del-bug-test-failed',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'fix_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-bug-test-failed',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'test@g.us',
      target_folder: 'web_test',
      task: 'bug test task',
      status: 'completed',
      result: buildStructuredResult({
        service: TEST_SERVICE,
        work_branch: 'bugfix/login-empty-500',
        staging_work_branch: 'staging-deploy/bugfix-login-empty-500',
        deliverable: '2026-04-08_bugfix_login-empty-500',
        test_doc: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_bugfix_login-empty-500/fix-test.md`,
        total: 3,
        passed: 2,
        failed: 1,
        blocked: 0,
        bugs: [
          {
            id: 'BUG-001',
            title: '未登录访问资料接口仍返回 500',
            severity: 'high',
            related_case: 'TC-001',
          },
        ],
        verdict: 'failed',
        summary: 'Bug 验证未通过，需要复修。',
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-fix-test-failed',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-bug-test-failed');

    const workflow = getWorkflow('wf-fix-test-failed');
    expect(workflow?.status).toBe('bug_refix');
    expect(workflow?.round).toBe(1);
    expect(
      getLatestWorkflowStageEvaluation('wf-fix-test-failed', 'bug_test')
        ?.status,
    ).toBe('failed');

    const delegations = getDelegationsByWorkflow('wf-fix-test-failed');
    const refixDelegation = delegations.find(
      (item) => item.id !== 'del-bug-test-failed',
    );
    expect(refixDelegation?.target_folder).toBe('web_dev');
    expect(refixDelegation?.task).toContain('Round 1');
    expect(refixDelegation?.task).toContain('BUG-001');
    expect(refixDelegation?.task).toContain(
      '/workspace/projects/workflow-test-service/iteration/2026-04-08_bugfix_login-empty-500/fix-test.md',
    );
  });

  it('propagates plan result fields into next delegation', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\ndoc_type: plan\n---\n\n# 方案\n\n## 范围\n- 支持昵称规则改造\n\n## 验收标准\n- 支持完整技术方案输出\n\n## 风险\n- 需要兼容历史数据\n`,
    );
    createWorkflow({
      id: 'wf-plan',
      name: 'Plan flow',
      service: TEST_SERVICE,
      start_from: 'plan',
      context: {
        main_branch: '',
        work_branch: '',
        deliverable: '',
        staging_base_branch: '',
        staging_work_branch: '',
        access_token: '',
        requirement_description: '为用户昵称功能输出完整技术方案。',
        requirement_files: ['/tmp/plan-input.md'],
      },
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
      result: buildStructuredResult({
        service: TEST_SERVICE,
        deliverable: '2026-04-08_feature',
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        summary: '方案已完成，可以进入审核',
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
    expect(getLatestWorkflowStageEvaluation('wf-plan', 'plan')?.status).toBe(
      'passed',
    );
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable),
    ).toBe('2026-04-08_feature');
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.mainBranch),
    ).toBe('main');
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ).toBe('feature/test_20260408');

    const delegations = getDelegationsByWorkflow('wf-plan');
    const latest = delegations.find((item) => item.id !== 'del-plan');
    expect(latest?.task).toContain(
      `方案文件：/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/plan.md`,
    );
    expect(latest?.task).toContain(
      '原始需求描述：为用户昵称功能输出完整技术方案。',
    );
    expect(latest?.task).toContain('- /tmp/plan-input.md');
  });

  it('keeps the current stage when evaluation evidence is missing', () => {
    createWorkflow({
      id: 'wf-plan-pending',
      name: 'Plan pending flow',
      service: TEST_SERVICE,
      start_from: 'plan',
      context: {
        main_branch: '',
        work_branch: '',
        deliverable: '',
        staging_base_branch: '',
        staging_work_branch: '',
        access_token: '',
      },
      status: 'plan',
      current_delegation_id: 'del-plan-pending',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-plan-pending',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan@g.us',
      target_folder: 'web_plan',
      task: 'plan task',
      status: 'completed',
      result: JSON.stringify({
        service: TEST_SERVICE,
        deliverable: '2026-04-08_missing_plan_doc',
        main_branch: 'main',
        work_branch: 'feature/test_missing_plan_doc',
        summary: '方案已完成，但暂未写出文档',
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-plan-pending',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-plan-pending');

    const workflow = getWorkflow('wf-plan-pending');
    expect(workflow?.status).toBe('plan');
    expect(workflow?.current_delegation_id).toBe('');
    const evaluation = getLatestWorkflowStageEvaluation(
      'wf-plan-pending',
      'plan',
    );
    expect(evaluation?.status).toBe('pending');
    expect(evaluation?.summary).toContain('待补充证据');
  });

  it('routes plan review revision verdict while keeping outcome success', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nmain_branch: main\nwork_branch: feature/test_20260408\ndoc_type: plan\n---\n\n# 方案\n\n## 范围\n- 支持昵称规则改造\n\n## 验收标准\n- 支持完整技术方案输出\n\n## 风险\n- 需要兼容历史数据\n`,
    );
    createWorkflow({
      id: 'wf-plan-review-needs-revision',
      name: 'Plan review needs revision',
      service: TEST_SERVICE,
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'del-plan-review-needs-revision',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-plan-review-needs-revision',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan-examine@g.us',
      target_folder: 'web_plan_examine',
      task: 'plan review task',
      status: 'completed',
      result: buildStructuredResult({
        deliverable: '2026-04-08_feature',
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        verdict: 'needs_revision',
        summary: '方案缺少回滚方案，需补充后再复审。',
        findings: [
          {
            code: 'missing_rollback_plan',
            severity: 'high',
            message: '未说明发布失败后的回滚步骤。',
            stageKey: 'plan_examine',
            path: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/plan.md`,
            suggestion: '补充回滚条件、步骤和影响说明。',
          },
        ],
        evidence: [
          {
            type: 'artifact',
            path: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/plan.md`,
            summary: '已审阅 plan.md',
          },
        ],
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-plan-review-needs-revision',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-plan-review-needs-revision');

    const workflow = getWorkflow('wf-plan-review-needs-revision');
    expect(workflow?.status).toBe('plan_examine_confirm');
    expect(
      getLatestWorkflowStageEvaluation(
        'wf-plan-review-needs-revision',
        'plan_examine',
      )?.status,
    ).toBe('needs_revision');
  });

  it('keeps plan review pending when legacy outcome failure lacks eval contract', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nmain_branch: main\nwork_branch: feature/test_20260408\ndoc_type: plan\n---\n\n# 方案\n\n## 范围\n- 支持昵称规则改造\n\n## 验收标准\n- 支持完整技术方案输出\n\n## 风险\n- 需要兼容历史数据\n`,
    );
    createWorkflow({
      id: 'wf-plan-review-legacy-outcome',
      name: 'Plan review legacy outcome',
      service: TEST_SERVICE,
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'del-plan-review-legacy-outcome',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-plan-review-legacy-outcome',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan-examine@g.us',
      target_folder: 'web_plan_examine',
      task: 'plan review task',
      status: 'completed',
      result: JSON.stringify({
        conclusion: '不通过',
        summary: '方案缺少回滚方案。',
      }),
      outcome: 'failure',
      requester_jid: null,
      workflow_id: 'wf-plan-review-legacy-outcome',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-plan-review-legacy-outcome');

    const workflow = getWorkflow('wf-plan-review-legacy-outcome');
    expect(workflow?.status).toBe('plan_examine');
    expect(workflow?.current_delegation_id).toBe('');
    expect(
      getLatestWorkflowStageEvaluation(
        'wf-plan-review-legacy-outcome',
        'plan_examine',
      )?.status,
    ).toBe('pending');
  });

  it('persists staging branches from ops result and sends them to testing', () => {
    createWorkflow({
      id: 'wf-ops',
      name: 'Ops flow',
      service: TEST_SERVICE,
      start_from: 'testing',
      context: {
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: '',
        staging_work_branch: '',
        access_token: 'abc123',
      },
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
      result: buildStructuredResult({
        service: TEST_SERVICE,
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        summary: '预发部署完成，可以进入测试确认',
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
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.mainBranch),
    ).toBe('main');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingBaseBranch,
        ),
    ).toBe('staging');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
        ),
    ).toBe('staging-deploy/feature-test_20260408');

    const approveResult = approveWorkflow('wf-ops');
    expect(approveResult.error).toBeUndefined();

    workflow = getWorkflow('wf-ops');
    expect(workflow?.status).toBe('testing');
    const delegations = getDelegationsByWorkflow('wf-ops');
    const testingDelegation = delegations.find((item) => item.id !== 'del-ops');
    expect(testingDelegation?.task).toContain('主分支：main');
    expect(testingDelegation?.task).toContain(
      '工作分支：feature/test_20260408',
    );
    expect(testingDelegation?.task).toContain('预发分支：staging');
    expect(testingDelegation?.task).toContain(
      '预发工作分支：staging-deploy/feature-test_20260408',
    );
  });

  it('routes testing failure verdict to fixing while keeping outcome success', () => {
    writeDoc(
      '2026-04-08_feature',
      'test.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nmain_branch: main\nwork_branch: feature/test_20260408\nstaging_base_branch: staging\nstaging_work_branch: staging-deploy/feature-test_20260408\ndoc_type: test\n---\n\n# 测试报告\n`,
    );
    createWorkflow({
      id: 'wf-testing-business-failure',
      name: 'Testing business failure',
      service: TEST_SERVICE,
      start_from: 'testing',
      context: {
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: 'abc123',
      },
      status: 'testing',
      current_delegation_id: 'del-testing-business-failure',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-testing-business-failure',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'test@g.us',
      target_folder: 'web_test',
      task: 'testing task',
      status: 'completed',
      result: buildStructuredResult({
        deliverable: '2026-04-08_feature',
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        test_doc: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/test.md`,
        total: 10,
        passed: 8,
        failed: 2,
        blocked: 0,
        bugs: [
          {
            id: 'BUG-001',
            title: '昵称长度超限时接口未返回预期错误',
            severity: 'high',
            related_case: 'TC-001',
          },
        ],
        verdict: 'failed',
        summary: '测试发现 2 个失败用例，需要进入修复。',
        findings: [
          {
            code: 'bug_detected',
            severity: 'high',
            message: 'BUG-001 昵称长度超限时接口未返回预期错误。',
            stageKey: 'testing',
            path: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/test.md`,
            suggestion: '补充昵称长度校验与错误返回。',
          },
        ],
        evidence: [
          {
            type: 'artifact',
            path: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/test.md`,
            summary: '测试报告记录了失败用例和 BUG',
          },
        ],
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-testing-business-failure',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-testing-business-failure');

    const workflow = getWorkflow('wf-testing-business-failure');
    expect(workflow?.status).toBe('fixing');
    expect(
      getLatestWorkflowStageEvaluation(
        'wf-testing-business-failure',
        'testing',
      )?.status,
    ).toBe('failed');

    const delegations = getDelegationsByWorkflow('wf-testing-business-failure');
    const fixingDelegation = delegations.find(
      (item) => item.id !== 'del-testing-business-failure',
    );
    expect(fixingDelegation?.task).toContain('BUG-001');
  });

  it('keeps testing stage pending when execution fails without structured verdict', () => {
    createWorkflow({
      id: 'wf-testing-execution-failed',
      name: 'Testing execution failed',
      service: TEST_SERVICE,
      start_from: 'testing',
      context: {
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: '',
      },
      status: 'testing',
      current_delegation_id: 'del-testing-execution-failed',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-testing-execution-failed',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'test@g.us',
      target_folder: 'web_test',
      task: 'testing task',
      status: 'completed',
      result: JSON.stringify({
        summary: '缺少 access_token，未执行接口测试。',
      }),
      outcome: 'failure',
      requester_jid: null,
      workflow_id: 'wf-testing-execution-failed',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-testing-execution-failed');

    const workflow = getWorkflow('wf-testing-execution-failed');
    expect(workflow?.status).toBe('testing');
    expect(workflow?.current_delegation_id).toBe('');
    expect(
      getLatestWorkflowStageEvaluation(
        'wf-testing-execution-failed',
        'testing',
      )?.status,
    ).toBe('pending');
    expect(getDelegationsByWorkflow('wf-testing-execution-failed')).toHaveLength(
      1,
    );
  });

  it('keeps fixing failed without creating a passive self-loop delegation', () => {
    createWorkflow({
      id: 'wf-fixing-failed',
      name: 'Fixing failed flow',
      service: TEST_SERVICE,
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/test_20260408',
        deliverable: '2026-04-08_feature',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/feature-test_20260408',
        access_token: 'abc123',
      },
      status: 'fixing',
      current_delegation_id: 'del-fixing',
      round: 2,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-fixing',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'dev@g.us',
      target_folder: 'web_dev',
      task: 'fixing task',
      status: 'completed',
      result: '修复失败，需要人工介入',
      outcome: 'failure',
      requester_jid: null,
      workflow_id: 'wf-fixing-failed',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });
    updateDelegation('del-fixing', {
      status: 'completed',
      result: '修复失败，需要人工介入',
      outcome: 'failure',
    });

    onDelegationComplete('del-fixing');

    const workflow = getWorkflow('wf-fixing-failed');
    expect(workflow?.status).toBe('fixing');
    expect(workflow?.current_delegation_id).toBe('');
    expect(getDelegationsByWorkflow('wf-fixing-failed')).toHaveLength(1);
  });

  it('exposes required deliverable file names for entry points', () => {
    const workflowType = getAvailableWorkflowTypes().find(
      (item) => item.type === 'dev_test',
    );

    expect(workflowType?.entry_points_detail.dev).toMatchObject({
      requires_deliverable: true,
      deliverable_role: 'planner',
      required_deliverable_file: 'plan.md',
    });
    expect(workflowType?.entry_points_detail.testing).toMatchObject({
      requires_deliverable: true,
      required_deliverable_file: 'dev.md',
    });
  });
});
