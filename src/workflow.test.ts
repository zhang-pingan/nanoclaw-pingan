import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  createWorkflowCheckpoint,
  createWorkflowEvent,
  createWorkflowInterrupt,
  createWorkflow,
  getAllRegisteredGroups,
  getDelegationsByWorkflow,
  getLatestWorkflowStageEvaluation,
  listWorkflowStageEvaluationsByWorkflow,
  getPendingWorkflowInterruptForState,
  getWorkflowInterrupt,
  listWorkflowEvents,
  listWorkflowInterruptsByWorkflow,
  getWorkflow,
  setRegisteredGroup,
  storeChatMetadata,
  updateDelegation,
} from './db.js';
import { PROJECT_ROOT } from './config.js';
import type { RegisteredGroup } from './types.js';
import {
  createNewWorkflow,
  getAvailableWorkflowTypes,
  initWorkflow,
  onDelegationComplete,
  resumeWorkflowInterrupt,
  handleCardAction,
  returnWorkflowToInterruptStage,
  runWorkflowWatchdogOnce,
  stopWorkflowRuntimeForTest,
} from './workflow.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';
import { getWorkflowTypeConfig } from './workflow-config.js';
import type { WorkflowDefinition } from './workflow-definition.js';
import { validateWorkflowDefinition } from './workflow-compiler.js';
import { getWorkflowArtifactContract } from './workflow-artifact-contract.js';
import { getWorkflowEvaluatorConfig } from './workflow-evaluator-registry.js';

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

function resumePendingInterruptForTest(
  workflowId: string,
  stateKey: string,
  action = 'skip',
): void {
  const interrupt = getPendingWorkflowInterruptForState(workflowId, stateKey);
  expect(interrupt).toBeDefined();
  const result = resumeWorkflowInterrupt({
    interruptId: interrupt!.id,
    action,
    payload: action === 'skip' ? { skipped: true } : {},
    actor: { channel: 'system', userId: 'test' },
  });
  expect(result.ok).toBe(true);
}

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

function createWorkflowAtInterrupt(input: {
  id: string;
  state: string;
  round?: number;
}): void {
  createWorkflow({
    id: input.id,
    name: input.id,
    service: TEST_SERVICE,
    start_from: input.state,
    context: {
      main_branch: 'main',
      work_branch: 'feature/test',
      deliverable: '2026-04-08_feature',
      staging_base_branch: 'staging',
      staging_work_branch: 'staging-deploy/feature-test',
      access_token: '',
      requirement_description: 'runtime regression',
      requirement_files: [],
    },
    status: input.state,
    current_delegation_id: '',
    round: input.round || 0,
    source_jid: 'main@g.us',
    paused_from: null,
    workflow_type: 'dev_test',
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
  });
}

beforeEach(() => {
  stopWorkflowRuntimeForTest();
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

describe('durable interrupt runtime', () => {
  it('rolls back interrupt resume when transition delegation cannot be created', () => {
    stopWorkflowRuntimeForTest();
    _initTestDatabase();
    for (const [jid, group] of GROUPS) {
      setRegisteredGroup(jid, group);
      storeChatMetadata(jid, '2026-04-08T00:00:00.000Z');
    }
    initWorkflow({
      registeredGroups: () => ({
        ...getAllRegisteredGroups(),
        'ops@g.us': {
          name: 'Ops',
          folder: 'web_ops_hidden',
          trigger: '/nc',
          added_at: '2026-04-08T00:00:00.000Z',
        },
      }),
      enqueueMessageCheck: () => {},
    });
    createWorkflowAtInterrupt({
      id: 'wf-resume-fail',
      state: 'awaiting_confirm',
    });
    createWorkflowInterrupt({
      id: 'wi-resume-fail',
      workflow_id: 'wf-resume-fail',
      state_key: 'awaiting_confirm',
      kind: 'approval',
      status: 'pending',
      title: 'awaiting confirm',
      body: null,
      resume_payload_schema_json: JSON.stringify({ type: 'object' }),
      allowed_actions_json: JSON.stringify(['skip']),
      allowed_channels_json: JSON.stringify(['web', 'feishu', 'assistant']),
      assigned_role: null,
      action_payload_json: null,
      created_by: 'test',
      resumed_by: null,
      resume_action: null,
      resume_payload_json: null,
      resume_error: null,
      idempotency_key: 'workflow_interrupt:wf-resume-fail:awaiting_confirm:0:1',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
      expires_at: null,
      resumed_at: null,
      cancelled_at: null,
      expired_at: null,
    });
    const interrupt = getPendingWorkflowInterruptForState(
      'wf-resume-fail',
      'awaiting_confirm',
    );
    expect(interrupt).toBeDefined();

    const result = resumeWorkflowInterrupt({
      interruptId: interrupt!.id,
      action: 'approve',
      payload: {},
      actor: { channel: 'web', userId: 'tester' },
    });

    expect(result.ok).toBe(false);
    expect(getWorkflow('wf-resume-fail')?.status).toBe('awaiting_confirm');
    expect(
      getPendingWorkflowInterruptForState('wf-resume-fail', 'awaiting_confirm')
        ?.id,
    ).toBe(interrupt!.id);
  });

  it('creates a fresh pending interrupt when re-entering the same state', () => {
    createWorkflowAtInterrupt({
      id: 'wf-reenter-interrupt',
      state: 'plan_examine_confirm',
    });
    initWorkflow({
      registeredGroups: () => getAllRegisteredGroups(),
      enqueueMessageCheck: () => {},
    });
    const first = getPendingWorkflowInterruptForState(
      'wf-reenter-interrupt',
      'plan_examine_confirm',
    );
    expect(first).toBeDefined();

    const firstResult = resumeWorkflowInterrupt({
      interruptId: first!.id,
      action: 'revise',
      payload: { revision_text: '补充边界条件' },
      actor: { channel: 'web', userId: 'tester' },
    });
    expect(firstResult.ok).toBe(true);

    returnWorkflowToInterruptStage(
      'wf-reenter-interrupt',
      'plan_examine_confirm',
    );
    const second = getPendingWorkflowInterruptForState(
      'wf-reenter-interrupt',
      'plan_examine_confirm',
    );

    expect(second).toBeDefined();
    expect(second!.id).not.toBe(first!.id);
    expect(
      listWorkflowInterruptsByWorkflow('wf-reenter-interrupt').filter(
        (interrupt) => interrupt.state_key === 'plan_examine_confirm',
      ),
    ).toHaveLength(2);
  });

  it('expires pending interrupts through the durable watchdog transition', () => {
    const workflowId = 'wf-expire-interrupt';
    createWorkflowAtInterrupt({
      id: 'wf-expire-interrupt',
      state: 'testing_confirm',
    });
    createWorkflowInterrupt({
      id: 'wi-expired-testing-confirm',
      workflow_id: workflowId,
      state_key: 'testing_confirm',
      kind: 'credential',
      status: 'pending',
      title: 'expired',
      body: null,
      resume_payload_schema_json: JSON.stringify({ type: 'object' }),
      allowed_actions_json: JSON.stringify(['approve']),
      allowed_channels_json: JSON.stringify(['web', 'feishu', 'assistant']),
      assigned_role: null,
      action_payload_json: null,
      created_by: 'test',
      resumed_by: null,
      resume_action: null,
      resume_payload_json: null,
      resume_error: null,
      idempotency_key:
        'workflow_interrupt:wf-expire-interrupt:testing_confirm:0:expired',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
      expires_at: '2026-04-08T00:00:01.000Z',
      resumed_at: null,
      cancelled_at: null,
      expired_at: null,
    });

    runWorkflowWatchdogOnce('2026-04-08T00:00:02.000Z');

    expect(
      getPendingWorkflowInterruptForState(workflowId, 'testing_confirm'),
    ).toBeUndefined();
    expect(getWorkflow(workflowId)?.status).toBe('testing_confirm');
  });

  it('treats same-action resume with different payload as a conflict', () => {
    createWorkflowAtInterrupt({
      id: 'wf-resume-conflict',
      state: 'plan_examine_confirm',
    });
    initWorkflow({
      registeredGroups: () => getAllRegisteredGroups(),
      enqueueMessageCheck: () => {},
    });
    const interrupt = getPendingWorkflowInterruptForState(
      'wf-resume-conflict',
      'plan_examine_confirm',
    );
    expect(interrupt).toBeDefined();

    const first = resumeWorkflowInterrupt({
      interruptId: interrupt!.id,
      action: 'revise',
      payload: { revision_text: 'first' },
      actor: { channel: 'web', userId: 'tester-a' },
    });
    expect(first.ok).toBe(true);

    const second = resumeWorkflowInterrupt({
      interruptId: interrupt!.id,
      action: 'revise',
      payload: { revision_text: 'second' },
      actor: { channel: 'web', userId: 'tester-b' },
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toContain('不能再次提交');
    }
  });

  it('normalizes string form values using resume payload schema before validation', () => {
    createWorkflowAtInterrupt({
      id: 'wf-normalize-payload',
      state: 'awaiting_confirm',
    });
    createWorkflowInterrupt({
      id: 'wi-normalize-payload',
      workflow_id: 'wf-normalize-payload',
      state_key: 'awaiting_confirm',
      kind: 'approval',
      status: 'pending',
      title: 'normalize payload',
      body: null,
      resume_payload_schema_json: JSON.stringify({
        type: 'object',
        required: ['count', 'enabled'],
        properties: {
          count: { type: 'integer', minimum: 2, maximum: 5 },
          ratio: { type: 'number' },
          enabled: { type: 'boolean' },
        },
      }),
      allowed_actions_json: JSON.stringify(['approve']),
      allowed_channels_json: JSON.stringify(['web', 'feishu', 'assistant']),
      assigned_role: null,
      action_payload_json: null,
      created_by: 'test',
      resumed_by: null,
      resume_action: null,
      resume_payload_json: null,
      resume_error: null,
      idempotency_key:
        'workflow_interrupt:wf-normalize-payload:awaiting_confirm:0:normalize',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
      expires_at: null,
      resumed_at: null,
      cancelled_at: null,
      expired_at: null,
    });
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalSchema = config.states.awaiting_confirm.resume_payload_schema;
    config.states.awaiting_confirm.resume_payload_schema = {
      schema: {
        type: 'object',
        required: ['count', 'enabled'],
        properties: {
          count: { type: 'integer', minimum: 2, maximum: 5 },
          ratio: { type: 'number' },
          enabled: { type: 'boolean' },
        },
      },
    };

    try {
      const result = resumeWorkflowInterrupt({
        interruptId: 'wi-normalize-payload',
        action: 'approve',
        payload: { count: '3', ratio: '0.5', enabled: 'true' },
        actor: { channel: 'web', userId: 'tester' },
      });

      expect(result.ok).toBe(true);
      expect(
        JSON.parse(
          getWorkflowInterrupt('wi-normalize-payload')!.resume_payload_json!,
        ),
      ).toEqual({ count: 3, ratio: 0.5, enabled: true });
    } finally {
      config.states.awaiting_confirm.resume_payload_schema = originalSchema;
    }
  });

  it('isolates nested card payload and preserves the submitting channel', () => {
    createWorkflowAtInterrupt({
      id: 'wf-card-payload-isolated',
      state: 'awaiting_confirm',
    });
    createWorkflowInterrupt({
      id: 'wi-card-payload-isolated',
      workflow_id: 'wf-card-payload-isolated',
      state_key: 'awaiting_confirm',
      kind: 'approval',
      status: 'pending',
      title: 'card payload isolated',
      body: null,
      resume_payload_schema_json: JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          resume_action: { type: 'string' },
          count: { type: 'integer' },
        },
      }),
      allowed_actions_json: JSON.stringify(['approve']),
      allowed_channels_json: JSON.stringify(['web']),
      assigned_role: null,
      action_payload_json: null,
      created_by: 'test',
      resumed_by: null,
      resume_action: null,
      resume_payload_json: null,
      resume_error: null,
      idempotency_key:
        'workflow_interrupt:wf-card-payload-isolated:awaiting_confirm:0:card',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
      expires_at: null,
      resumed_at: null,
      cancelled_at: null,
      expired_at: null,
    });

    handleCardAction({
      action: 'workflow_interrupt_resume',
      user_id: 'web-user',
      message_id: 'web-card-1',
      actor_channel: 'web',
      workflow_id: 'wf-card-payload-isolated',
      form_value: {
        interrupt_id: 'wi-card-payload-isolated',
        resume_action: 'approve',
        payload: JSON.stringify({
          action: 'business-action',
          resume_action: 'business-resume',
          count: '3',
        }),
      },
    });

    const interrupt = getWorkflowInterrupt('wi-card-payload-isolated')!;
    expect(interrupt.status).toBe('resumed');
    expect(interrupt.resume_action).toBe('approve');
    expect(JSON.parse(interrupt.resume_payload_json!)).toEqual({
      action: 'business-action',
      resume_action: 'business-resume',
      count: 3,
    });
    expect(JSON.parse(interrupt.resumed_by!)).toMatchObject({
      channel: 'web',
      userId: 'web-user',
    });
  });

  it('executes due evaluator retries by creating a fresh delegation', () => {
    const workflowId = 'wf-evaluator-retry';
    const retryConfig = getWorkflowTypeConfig('dev_test')?.states.plan;
    expect(retryConfig?.type).toBe('delegation');
    retryConfig!.retry_policy = {
      max_attempts: 2,
      retry_on: ['evaluator_pending'],
      initial_delay_ms: 0,
    };
    const context = {
      main_branch: 'main',
      work_branch: 'feature/retry-evidence',
      deliverable: '2026-04-08_retry_evidence',
      staging_base_branch: 'staging',
      staging_work_branch: 'staging-deploy/retry-evidence',
      access_token: '',
      requirement_description: 'retry pending evidence',
      requirement_files: [],
      latest_evaluator_result: {
        status: 'pending',
        summary: 'missing deliverable',
      },
    };
    createWorkflow({
      id: workflowId,
      name: 'retry pending evidence',
      service: TEST_SERVICE,
      start_from: 'plan',
      context,
      status: 'plan',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createWorkflowCheckpoint({
      id: 'wf-checkpoint-wf-evaluator-retry-1',
      workflow_id: workflowId,
      state_key: 'plan',
      checkpoint_version: 1,
      checkpoint_json: JSON.stringify({
        workflowId,
        workflowType: 'dev_test',
        stateKey: 'plan',
        round: 0,
        context,
        currentDelegationId: null,
        pendingInterruptId: null,
        attempts: { plan: 2 },
        updatedAt: '2026-04-08T00:00:00.000Z',
      }),
      created_at: '2026-04-08T00:00:00.000Z',
    });
    createWorkflowEvent({
      id: 'wf-event-evaluator-retry-scheduled',
      workflow_id: workflowId,
      event_type: 'retry_scheduled',
      state_key: 'plan',
      ref_type: 'workflow_stage_evaluation',
      ref_id: 'eval-plan-pending',
      actor_json: null,
      payload_json: JSON.stringify({
        reason: 'evaluator_pending',
        next_attempt_at: '2026-04-08T00:00:01.000Z',
        attempt: 2,
      }),
      idempotency_key: `workflow_retry:${workflowId}:plan:0:2`,
      created_at: '2026-04-08T00:00:00.000Z',
    });

    runWorkflowWatchdogOnce('2026-04-08T00:00:02.000Z');

    const delegations = getDelegationsByWorkflow(workflowId);
    expect(delegations).toHaveLength(1);
    expect(delegations[0]?.target_folder).toBe('web_plan');
    expect(delegations[0]?.task).toContain('Evaluator pending retry attempt 2');
    expect(getWorkflow(workflowId)?.current_delegation_id).toBe(
      delegations[0]?.id,
    );
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

  it('rejects deliverable entry when required role file is missing', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\n---\n\n# Plan\n`,
    );

    const result = createNewWorkflow({
      title: 'Test feature',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'testing',
      workflowType: 'dev_test',
      deliverable: '2026-04-08_feature',
    });

    expect(result.error).toContain('需要交付物 dev.md');
    expect(getWorkflow(result.workflowId)).toBeUndefined();
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
    expect(delegations[0]?.task).toContain('流程类型：dev_test');
    expect(delegations[0]?.task).toContain(
      '需求描述：需要支持用户昵称输入表情',
    );
    expect(delegations[0]?.task).toContain('- /tmp/nickname-prd.md');
    expect(delegations[0]?.task).toContain('- /tmp/nickname-ui.png');
    expect(delegations[0]?.handoff_role).toBe('planner');
    expect(delegations[0]?.handoff_skill).toBe('plan-requirement');
    const contract = JSON.parse(delegations[0]?.handoff_contract_json || '{}');
    expect(contract.input_schema).toBe('workflow.plan.input.v1');
    expect(contract.output_schema).toBe('dev_test.plan.v1');
    expect(contract.artifact_contract_ref).toBe('dev_test.plan.v1');
    const input = JSON.parse(delegations[0]?.handoff_input_json || '{}');
    expect(input.stage_key).toBe('plan');
    expect(input.rendered_task).toContain('需求描述：需要支持用户昵称输入表情');
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
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
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
    expect(delegations[0]?.task).toContain('流程类型：fix_test');
    expect(delegations[0]?.task).toContain(
      'Bug 描述：用户未登录访问资料接口时返回 500',
    );
    expect(delegations[0]?.task).toContain('- /tmp/login-500.log');
    expect(delegations[0]?.task).toContain('工作分支：bugfix/login-empty-500');
    expect(delegations[0]?.task).toContain(
      '预发工作分支：staging-deploy/bugfix-login-empty-500',
    );
  });

  it('allows fix_test creation without work branches and passes blank branch lines', () => {
    const result = createNewWorkflow({
      title: '登录态为空时接口返回 500',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'fix',
      workflowType: 'fix_test',
      mainBranch: 'main',
      stagingBaseBranch: 'staging',
      context: {
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log'],
      },
    });

    expect(result.error).toBeUndefined();
    const workflow = getWorkflow(result.workflowId);
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ).toBe('');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
        ),
    ).toBe('');

    const delegations = getDelegationsByWorkflow(result.workflowId);
    expect(delegations).toHaveLength(1);
    const taskLines = delegations[0]?.task.split('\n') || [];
    expect(taskLines).toContain('主分支：main');
    expect(taskLines).toContain('预发分支：staging');
    expect(taskLines).toContain('工作分支：');
    expect(taskLines).toContain('预发工作分支：');
    expect(delegations[0]?.task).not.toContain('工作分支：N/A');
  });

  it('carries fix_test branches returned by bug fix into deploy task', () => {
    const result = createNewWorkflow({
      title: '登录态为空时接口返回 500',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'fix',
      workflowType: 'fix_test',
      mainBranch: 'main',
      stagingBaseBranch: 'staging',
      context: {
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log'],
      },
    });

    expect(result.error).toBeUndefined();
    const [fixDelegation] = getDelegationsByWorkflow(result.workflowId);
    updateDelegation(fixDelegation!.id, {
      status: 'completed',
      outcome: 'success',
      result: buildStructuredResult({
        service: TEST_SERVICE,
        main_branch: 'main',
        work_branch: 'bugfix/login-empty-500_20260408',
        staging_base_branch: 'staging',
        staging_work_branch: 'staging-deploy/bugfix-login-empty-500_20260408',
        deliverable: '2026-04-08_bugfix_login-empty-500',
        verdict: 'passed',
        summary: '已基于 main 创建工作分支并完成修复。',
      }),
    });

    onDelegationComplete(fixDelegation!.id);

    const workflow = getWorkflow(result.workflowId);
    expect(workflow?.status).toBe('ops_deploy');
    expect(
      workflow &&
        getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ).toBe('bugfix/login-empty-500_20260408');
    expect(
      workflow &&
        getWorkflowContextValue(
          workflow,
          WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
        ),
    ).toBe('staging-deploy/bugfix-login-empty-500_20260408');

    const deployDelegation = getDelegationsByWorkflow(result.workflowId).find(
      (delegation) => delegation.target_folder === 'web_ops',
    );
    expect(deployDelegation?.task).toContain('主分支：main');
    expect(deployDelegation?.task).toContain('预发分支：staging');
    expect(deployDelegation?.task).toContain(
      '工作分支：bugfix/login-empty-500_20260408',
    );
    expect(deployDelegation?.task).toContain(
      '预发工作分支：staging-deploy/bugfix-login-empty-500_20260408',
    );
  });

  it('keeps fix_test bug fix pending when result omits final work branch', () => {
    const result = createNewWorkflow({
      title: '登录态为空时接口返回 500',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'fix',
      workflowType: 'fix_test',
      mainBranch: 'main',
      stagingBaseBranch: 'staging',
      context: {
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log'],
      },
    });

    expect(result.error).toBeUndefined();
    const [fixDelegation] = getDelegationsByWorkflow(result.workflowId);
    updateDelegation(fixDelegation!.id, {
      status: 'completed',
      outcome: 'success',
      result: buildStructuredResult({
        service: TEST_SERVICE,
        main_branch: 'main',
        deliverable: '2026-04-08_bugfix_login-empty-500',
        verdict: 'passed',
        summary: '已完成修复，但未返回最终工作分支。',
      }),
    });

    onDelegationComplete(fixDelegation!.id);

    const workflow = getWorkflow(result.workflowId);
    expect(workflow?.status).toBe('bug_fix');
    expect(workflow?.current_delegation_id).toBe('');
    expect(
      getLatestWorkflowStageEvaluation(result.workflowId, 'bug_fix')?.status,
    ).toBe('pending');
    expect(getDelegationsByWorkflow(result.workflowId)).toHaveLength(1);
  });

  it('allows fix_test bug fix to omit staging branches before deploy stage', () => {
    const result = createNewWorkflow({
      title: '登录态为空时接口返回 500',
      service: TEST_SERVICE,
      sourceJid: 'main@g.us',
      startFrom: 'fix',
      workflowType: 'fix_test',
      mainBranch: 'main',
      context: {
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
        bug_files: ['/tmp/login-500.log'],
      },
    });

    expect(result.error).toBeUndefined();
    const [fixDelegation] = getDelegationsByWorkflow(result.workflowId);
    updateDelegation(fixDelegation!.id, {
      status: 'completed',
      outcome: 'success',
      result: buildStructuredResult({
        service: TEST_SERVICE,
        main_branch: 'main',
        work_branch: 'bugfix/login-empty-500_20260408',
        deliverable: '2026-04-08_bugfix_login-empty-500',
        verdict: 'passed',
        summary: '已完成修复，预发分支留给部署阶段确认。',
      }),
    });

    onDelegationComplete(fixDelegation!.id);

    const workflow = getWorkflow(result.workflowId);
    expect(workflow?.status).toBe('ops_deploy');
    expect(
      getLatestWorkflowStageEvaluation(result.workflowId, 'bug_fix')?.status,
    ).toBe('passed');

    const deployDelegation = getDelegationsByWorkflow(result.workflowId).find(
      (delegation) => delegation.target_folder === 'web_ops',
    );
    const taskLines = deployDelegation?.task.split('\n') || [];
    expect(taskLines).toContain('工作分支：bugfix/login-empty-500_20260408');
    expect(taskLines).toContain('预发分支：');
    expect(taskLines).toContain('预发工作分支：');
  });

  it('marks fix_test work branch fields optional in create form', () => {
    const fixTestConfig = getAvailableWorkflowTypes().find(
      (workflowType) => workflowType.type === 'fix_test',
    );
    const fields = fixTestConfig?.create_form?.fields || [];
    const mainBranchField = fields.find((field) => field.key === 'main_branch');
    const stagingBaseBranchField = fields.find(
      (field) => field.key === 'staging_base_branch',
    );
    const workBranchField = fields.find((field) => field.key === 'work_branch');
    const stagingWorkBranchField = fields.find(
      (field) => field.key === 'staging_work_branch',
    );

    expect(mainBranchField?.required).not.toBe(true);
    expect(stagingBaseBranchField?.required).not.toBe(true);
    expect(workBranchField?.required).not.toBe(true);
    expect(stagingWorkBranchField?.required).not.toBe(true);
    expect(workBranchField?.label).toContain('可选');
    expect(stagingWorkBranchField?.label).toContain('可选');
  });

  it('routes fix_test bug verification failure to refix and increments round', () => {
    createWorkflow({
      id: 'wf-fix-test-failed',
      name: 'Login empty token 500',
      service: TEST_SERVICE,
      start_from: 'fix',
      context: {
        bug_description: '用户未登录访问资料接口时返回 500，预期应返回 401。',
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
    expect(refixDelegation?.task).toContain('流程类型：fix_test');
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

    const planState = getWorkflowTypeConfig('dev_test')?.states.plan;
    expect(planState?.on_complete?.success.role).toBeUndefined();

    const workflow = getWorkflow('wf-plan');
    expect(workflow?.status).toBe('plan_examine');
    expect(getLatestWorkflowStageEvaluation('wf-plan', 'plan')?.status).toBe(
      'passed',
    );
    const evaluations = listWorkflowStageEvaluationsByWorkflow('wf-plan');
    expect(
      evaluations.some(
        (item) =>
          item.stage_key === 'plan:llm_judge' &&
          item.evaluator_type === 'llm_judge' &&
          item.status === 'pending',
      ),
    ).toBe(true);
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
    expect(latest?.handoff_role).toBe('plan_examiner');
    expect(latest?.handoff_skill).toBe('plan-examine');
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

  it('evaluates typed handoff result before falling back to raw result text', () => {
    writeDoc(
      '2026-04-08_feature',
      'plan.md',
      `---\nservice: ${TEST_SERVICE}\ndeliverable: 2026-04-08_feature\nmain_branch: main\nwork_branch: feature/test_20260408\ndoc_type: plan\n---\n\n# 方案\n\n## 范围\n- 支持昵称规则改造\n\n## 验收标准\n- 支持完整技术方案输出\n\n## 风险\n- 需要兼容历史数据\n`,
    );
    createWorkflow({
      id: 'wf-plan-review-typed-result',
      name: 'Plan review typed result',
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
      current_delegation_id: 'del-plan-review-typed-result',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    });
    createDelegation({
      id: 'del-plan-review-typed-result',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan-examine@g.us',
      target_folder: 'web_plan_examine',
      task: 'plan review task',
      status: 'completed',
      result: 'legacy text that is not json',
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-plan-review-typed-result',
      handoff_result_json: buildStructuredResult({
        deliverable: '2026-04-08_feature',
        main_branch: 'main',
        work_branch: 'feature/test_20260408',
        verdict: 'needs_revision',
        summary: 'typed handoff result says revision is required',
        findings: [
          {
            code: 'typed_review_issue',
            severity: 'high',
            message: 'typed result was used',
            stageKey: 'plan_examine',
          },
        ],
        evidence: [
          {
            type: 'artifact',
            path: `/workspace/projects/${TEST_SERVICE}/iteration/2026-04-08_feature/plan.md`,
            summary: 'typed evidence',
          },
        ],
      }),
      handoff_validation_status: 'valid',
      handoff_validation_errors_json: '[]',
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:01.000Z',
    });

    onDelegationComplete('del-plan-review-typed-result');

    const workflow = getWorkflow('wf-plan-review-typed-result');
    expect(workflow?.status).toBe('plan_examine_confirm');
    const evaluation = getLatestWorkflowStageEvaluation(
      'wf-plan-review-typed-result',
      'plan_examine',
    );
    expect(evaluation?.status).toBe('needs_revision');
    expect(evaluation?.summary).toContain('typed handoff result');
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

    resumePendingInterruptForTest('wf-ops', 'testing_confirm');

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
      getLatestWorkflowStageEvaluation('wf-testing-business-failure', 'testing')
        ?.status,
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
      getLatestWorkflowStageEvaluation('wf-testing-execution-failed', 'testing')
        ?.status,
    ).toBe('pending');
    expect(
      getDelegationsByWorkflow('wf-testing-execution-failed'),
    ).toHaveLength(1);
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
      manual_requirement_create: {
        enabled: true,
        files: [{ filename: 'plan.md', required: true }],
      },
    });
    expect(workflowType?.entry_points_detail.testing).toMatchObject({
      requires_deliverable: true,
      deliverable_role: 'dev',
      required_deliverable_file: 'dev.md',
      manual_requirement_create: {
        enabled: true,
        files: [
          { filename: 'dev.md', required: true },
          { filename: 'plan.md', required: false },
        ],
      },
    });
  });

  it('declares artifact contracts and sidecar evaluator refs for critical stages', () => {
    const devTest = getWorkflowTypeConfig('dev_test');
    expect(devTest?.states.plan.artifact_contract?.ref).toBe(
      'dev_test.plan.v1',
    );
    expect(devTest?.states.plan.evaluator?.ref).toBe('dev_test.plan.v1');
    expect(devTest?.states.dev.artifact_contract?.ref).toBe('dev_test.dev.v1');
    expect(devTest?.states.ops_deploy.evaluator?.ref).toBe(
      'dev_test.ops_deploy.v1',
    );
    expect(devTest?.states.testing.evaluator?.ref).toBe('dev_test.testing.v1');
    expect(getWorkflowArtifactContract('dev_test.plan.v1')).toBeDefined();
    expect(getWorkflowEvaluatorConfig('dev_test.plan.v1')?.ai?.enabled).toBe(
      true,
    );

    const fixTest = getWorkflowTypeConfig('fix_test');
    expect(fixTest?.states.bug_fix.evaluator?.ref).toBe('fix_test.bug_fix.v1');
    expect(fixTest?.states.bug_test.artifact_contract?.ref).toBe(
      'fix_test.bug_test.v1',
    );
    expect(getWorkflowArtifactContract('fix_test.bug_test.v1')).toBeDefined();
  });
});

describe('system workflow action nodes', () => {
  it('allows system run steps to be omitted or empty', () => {
    const definition: WorkflowDefinition = {
      key: 'empty_system_test',
      name: 'Empty system test',
      version: 1,
      status: 'draft',
      roles: {},
      entry_points: {
        start: {
          state: 'noop_without_run',
        },
      },
      states: {
        noop_without_run: {
          type: 'system',
          label: 'No-op without run',
          on_complete: {
            success: { target: 'noop_empty_steps' },
          },
        },
        noop_empty_steps: {
          type: 'system',
          label: 'No-op empty steps',
          run: {
            steps: [],
          },
          on_complete: {
            success: { target: 'done' },
          },
        },
        done: {
          type: 'terminal',
          label: 'Done',
        },
      },
      status_labels: {},
    };

    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it('allows delegation action hooks to be omitted or empty', () => {
    const definition: WorkflowDefinition = {
      key: 'delegation_hook_test',
      name: 'Delegation hook test',
      version: 1,
      status: 'draft',
      roles: {
        planner: {
          channels: {
            web: 'web_plan',
          },
        },
      },
      entry_points: {
        start: {
          state: 'plan',
        },
      },
      states: {
        plan: {
          type: 'delegation',
          label: 'Plan',
          delegate: {
            role: 'planner',
            skill: 'plan-requirement',
          },
          before_delegate: {
            steps: [],
          },
          after_complete: {
            steps: [],
          },
          on_complete: {
            success: { target: 'done' },
            failure: { target: 'done' },
          },
        },
        done: {
          type: 'terminal',
          label: 'Done',
        },
      },
      status_labels: {},
    };

    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it('treats system states without steps as successful no-ops', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalEntry = config.entry_points.plan;
    const originalPrepare = config.states.prepare_noop;

    config.entry_points.plan = {
      ...originalEntry,
      state: 'prepare_noop',
    };
    config.states.prepare_noop = {
      type: 'system',
      label: '无动作准备节点',
      on_complete: {
        success: { target: 'plan' },
        failure: { target: 'cancelled' },
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'System no-op feature',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'system node has no actions',
      });

      expect(result.error).toBeUndefined();
      const workflow = getWorkflow(result.workflowId);
      expect(workflow?.status).toBe('plan');

      const events = listWorkflowEvents(result.workflowId);
      expect(events.map((event) => event.event_type)).toContain(
        'system_executed',
      );
      expect(events.map((event) => event.event_type)).not.toContain(
        'system_step_completed',
      );
    } finally {
      config.entry_points.plan = originalEntry;
      if (originalPrepare) {
        config.states.prepare_noop = originalPrepare;
      } else {
        delete config.states.prepare_noop;
      }
    }
  });

  it('runs configured system steps before transitioning to a delegation state', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalEntry = config.entry_points.plan;
    const originalPrepare = config.states.prepare_context;
    const originalPlan = config.states.plan;

    config.entry_points.plan = {
      ...originalEntry,
      state: 'prepare_context',
    };
    config.states.prepare_context = {
      type: 'system',
      label: '准备上下文',
      run: {
        steps: [
          {
            id: 'prepare',
            uses: 'context.set',
            with: {
              values: {
                work_branch: 'feature/{{service}}',
                system_marker: 'prepared:{{name}}',
              },
            },
          },
        ],
      },
      on_complete: {
        success: { target: 'plan' },
        failure: { target: 'cancelled' },
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'System prepared feature',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'system node prepares context',
      });

      expect(result.error).toBeUndefined();
      const workflow = getWorkflow(result.workflowId);
      expect(workflow?.status).toBe('plan');
      expect(workflow?.context.work_branch).toBe(`feature/${TEST_SERVICE}`);
      expect(workflow?.context.system_marker).toBe(
        'prepared:System prepared feature',
      );

      const delegations = getDelegationsByWorkflow(result.workflowId);
      expect(delegations).toHaveLength(1);
      expect(delegations[0]?.task).toContain(
        `工作分支：feature/${TEST_SERVICE}`,
      );

      const events = listWorkflowEvents(result.workflowId);
      expect(events.map((event) => event.event_type)).toContain(
        'system_step_completed',
      );
      expect(events.map((event) => event.event_type)).toContain(
        'system_completed',
      );
    } finally {
      config.entry_points.plan = originalEntry;
      if (originalPrepare) {
        config.states.prepare_context = originalPrepare;
      } else {
        delete config.states.prepare_context;
      }
      config.states.plan = originalPlan;
    }
  });

  it('runs before_delegate hooks before creating a delegation', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalPlan = config.states.plan;

    config.states.plan = {
      ...originalPlan,
      before_delegate: {
        steps: [
          {
            id: 'prepare_branch',
            uses: 'context.set',
            with: {
              values: {
                work_branch: 'feature/hook-{{service}}',
                before_hook_marker: 'before:{{name}}',
              },
            },
          },
        ],
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'Before hook feature',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'before hook prepares context',
      });

      expect(result.error).toBeUndefined();
      const workflow = getWorkflow(result.workflowId);
      expect(workflow?.context.work_branch).toBe(
        `feature/hook-${TEST_SERVICE}`,
      );
      expect(workflow?.context.before_hook_marker).toBe(
        'before:Before hook feature',
      );

      const delegations = getDelegationsByWorkflow(result.workflowId);
      expect(delegations).toHaveLength(1);
      expect(delegations[0]?.task).toContain(
        `工作分支：feature/hook-${TEST_SERVICE}`,
      );

      const events = listWorkflowEvents(result.workflowId);
      expect(events.map((event) => event.event_type)).toContain(
        'workflow_hook_completed',
      );
      const hookStep = events.find(
        (event) => event.event_type === 'workflow_hook_step_completed',
      );
      expect(hookStep?.payload_json).toContain('before_delegate');
    } finally {
      config.states.plan = originalPlan;
    }
  });

  it('runs after_complete hooks before evaluating and transitioning', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalEntry = config.entry_points.plan;
    const originalCapture = config.states.capture_after_hook;
    const originalNext = config.states.next_after_hook;

    config.entry_points.plan = {
      ...originalEntry,
      state: 'capture_after_hook',
    };
    config.states.capture_after_hook = {
      type: 'delegation',
      label: '采集并后处理',
      role: 'planner',
      skill: 'plan-requirement',
      task_template: '返回结构化阶段结果',
      after_complete: {
        steps: [
          {
            id: 'copy_payload',
            uses: 'context.set',
            with: {
              values: {
                after_hook_build:
                  '{{context.latest_delegation_result.payload.build_id}}',
                after_hook_summary:
                  '{{context.latest_delegation_result.payload.summary}}',
              },
            },
          },
        ],
      },
      on_complete: {
        success: { target: 'next_after_hook' },
        failure: { target: 'cancelled' },
      },
    };
    config.states.next_after_hook = {
      type: 'delegation',
      label: '读取后处理结果',
      role: 'planner',
      skill: 'plan-requirement',
      task_template:
        'after_build={{after_hook_build}}\nafter_summary={{after_hook_summary}}',
      on_complete: {
        success: { target: 'passed' },
        failure: { target: 'cancelled' },
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'After hook feature',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'after hook normalizes result',
      });

      expect(result.error).toBeUndefined();
      const [delegation] = getDelegationsByWorkflow(result.workflowId);
      expect(delegation).toBeDefined();

      updateDelegation(delegation!.id, {
        status: 'completed',
        outcome: 'success',
        result: buildStructuredResult({
          build_id: 'build-after-123',
        }),
      });
      onDelegationComplete(delegation!.id);

      const workflow = getWorkflow(result.workflowId);
      expect(workflow?.status).toBe('next_after_hook');
      expect(workflow?.context.after_hook_build).toBe('build-after-123');
      expect(workflow?.context.after_hook_summary).toBe('阶段完成');

      const delegations = getDelegationsByWorkflow(result.workflowId);
      expect(delegations).toHaveLength(2);
      expect(delegations[1]?.task).toContain('after_build=build-after-123');
      expect(delegations[1]?.task).toContain('after_summary=阶段完成');

      const hookStep = listWorkflowEvents(result.workflowId).find(
        (event) => event.event_type === 'workflow_hook_step_completed',
      );
      expect(hookStep?.payload_json).toContain('after_complete');
    } finally {
      config.entry_points.plan = originalEntry;
      if (originalCapture) {
        config.states.capture_after_hook = originalCapture;
      } else {
        delete config.states.capture_after_hook;
      }
      if (originalNext) {
        config.states.next_after_hook = originalNext;
      } else {
        delete config.states.next_after_hook;
      }
    }
  });

  it('routes system step failures through the configured failure transition', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalEntry = config.entry_points.plan;
    const originalPrepare = config.states.prepare_failure_check;

    config.entry_points.plan = {
      ...originalEntry,
      state: 'prepare_failure_check',
    };
    config.states.prepare_failure_check = {
      type: 'system',
      label: '失败检查',
      run: {
        steps: [
          {
            id: 'check',
            uses: 'context.require',
            with: {
              keys: ['missing_required_key'],
            },
          },
        ],
      },
      on_complete: {
        success: { target: 'plan' },
        failure: { target: 'cancelled' },
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'System failure flow',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'missing key should fail',
      });

      expect(result.error).toBeUndefined();
      expect(getWorkflow(result.workflowId)?.status).toBe('cancelled');
      expect(getDelegationsByWorkflow(result.workflowId)).toHaveLength(0);

      const failedStep = listWorkflowEvents(result.workflowId).find(
        (event) => event.event_type === 'system_step_failed',
      );
      expect(failedStep?.payload_json).toContain('missing_required_key');
    } finally {
      config.entry_points.plan = originalEntry;
      if (originalPrepare) {
        config.states.prepare_failure_check = originalPrepare;
      } else {
        delete config.states.prepare_failure_check;
      }
    }
  });

  it('stores delegation payloads under stage context and resolves dotted paths', () => {
    const config = getWorkflowTypeConfig('dev_test')!;
    const originalEntry = config.entry_points.plan;
    const originalCapture = config.states.capture_result;
    const originalConsume = config.states.consume_stage_result;
    const originalNext = config.states.next_stage_from_result;

    config.entry_points.plan = {
      ...originalEntry,
      state: 'capture_result',
    };
    config.states.capture_result = {
      type: 'delegation',
      label: '采集阶段结果',
      role: 'planner',
      skill: 'plan-requirement',
      task_template: '返回结构化阶段结果',
      on_complete: {
        success: { target: 'consume_stage_result' },
        failure: { target: 'cancelled' },
      },
    };
    config.states.consume_stage_result = {
      type: 'system',
      label: '消费阶段结果',
      run: {
        steps: [
          {
            id: 'copy',
            uses: 'context.set',
            with: {
              values: {
                stage_result_url:
                  '{{context.stage_results.capture_result.deploy.url}}',
                latest_result_build_id:
                  '{{latest_delegation_result.payload.build_id}}',
                latest_result_summary:
                  '{{context.latest_delegation_result.payload.summary}}',
                deploy_object:
                  '{{context.stage_results.capture_result.deploy}}',
              },
            },
          },
        ],
      },
      on_complete: {
        success: { target: 'next_stage_from_result' },
        failure: { target: 'cancelled' },
      },
    };
    config.states.next_stage_from_result = {
      type: 'delegation',
      label: '读取阶段结果',
      role: 'planner',
      skill: 'plan-requirement',
      task_template:
        '部署地址：{{context.stage_results.capture_result.deploy.url}}\n构建：{{latest_delegation_result.payload.build_id}}',
      on_complete: {
        success: { target: 'passed' },
        failure: { target: 'cancelled' },
      },
    };

    try {
      const result = createNewWorkflow({
        title: 'Stage result flow',
        service: TEST_SERVICE,
        sourceJid: 'main@g.us',
        startFrom: 'plan',
        workflowType: 'dev_test',
        requirementDescription: 'stage result should be namespaced',
      });

      expect(result.error).toBeUndefined();
      const [delegation] = getDelegationsByWorkflow(result.workflowId);
      expect(delegation).toBeDefined();

      updateDelegation(delegation!.id, {
        status: 'completed',
        outcome: 'success',
        result: buildStructuredResult({
          main_branch: 'main-from-result',
          build_id: 'build-123',
          deploy: {
            url: 'https://staging.example.com',
            env: 'staging',
          },
        }),
      });
      onDelegationComplete(delegation!.id);

      const workflow = getWorkflow(result.workflowId);
      expect(workflow?.status).toBe('next_stage_from_result');
      expect(workflow?.context.main_branch).toBe('main-from-result');
      expect(workflow?.context.stage_result_url).toBe(
        'https://staging.example.com',
      );
      expect(workflow?.context.latest_result_build_id).toBe('build-123');
      expect(workflow?.context.latest_result_summary).toBe('阶段完成');
      expect(workflow?.context.deploy_object).toEqual({
        url: 'https://staging.example.com',
        env: 'staging',
      });
      expect(workflow?.context.stage_results).toMatchObject({
        capture_result: {
          verdict: 'passed',
          summary: '阶段完成',
          main_branch: 'main-from-result',
          build_id: 'build-123',
          deploy: {
            url: 'https://staging.example.com',
            env: 'staging',
          },
        },
      });
      expect(workflow?.context.latest_delegation_result).toMatchObject({
        state_key: 'capture_result',
        delegation_id: delegation!.id,
        payload: {
          build_id: 'build-123',
          deploy: {
            url: 'https://staging.example.com',
          },
        },
      });
      const delegations = getDelegationsByWorkflow(result.workflowId);
      expect(delegations).toHaveLength(2);
      expect(delegations[1]?.task).toContain(
        '部署地址：https://staging.example.com',
      );
      expect(delegations[1]?.task).toContain('构建：build-123');
    } finally {
      config.entry_points.plan = originalEntry;
      if (originalCapture) {
        config.states.capture_result = originalCapture;
      } else {
        delete config.states.capture_result;
      }
      if (originalConsume) {
        config.states.consume_stage_result = originalConsume;
      } else {
        delete config.states.consume_stage_result;
      }
      if (originalNext) {
        config.states.next_stage_from_result = originalNext;
      } else {
        delete config.states.next_stage_from_result;
      }
    }
  });
});
