import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import { initWorkbenchEvents } from './workbench-events.js';
import {
  _initTestDatabase,
  createAskQuestion,
  createDelegation,
  createWorkflow as dbCreateWorkflow,
  getAllRegisteredGroups,
  getLatestWorkflowStageEvaluation,
  getWorkbenchTaskByWorkflowId,
  getWorkbenchActionItem,
  listWorkbenchEventsByTask,
  setRegisteredGroup,
  storeChatMetadata,
  updateDelegation,
  updateWorkflow,
} from './db.js';
import { PROJECT_ROOT } from './config.js';
import { RegisteredGroup } from './types.js';
import {
  approveWorkflow,
  cancelWorkflow,
  initWorkflow,
  onDelegationComplete,
} from './workflow.js';
import {
  createWorkbenchTask,
  getWorkbenchTaskDetail,
  listWorkbenchTasks,
  retryWorkbenchSubtask,
} from './workbench.js';
import {
  createWorkbenchInteractionItem,
  syncWorkbenchOnDelegationCompleted,
  syncWorkbenchOnDelegationCreated,
  syncWorkbenchOnTransition,
  syncWorkbenchOnWorkflowCreated,
  syncWorkbenchOnWorkflowUpdated,
} from './workbench-store.js';
import { buildWorkbenchBroadcastCard } from './workbench-broadcast-render.js';
import { handleWorkbenchBroadcastCardAction } from './workbench-broadcast-actions.js';
import { WORKFLOW_CONTEXT_KEYS } from './workflow-context.js';

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

const PLAN_GROUP: RegisteredGroup = {
  name: 'Plan',
  folder: 'web_plan',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
};

const PLAN_EXAMINE_GROUP: RegisteredGroup = {
  name: 'Plan Examine',
  folder: 'web_plan_examine',
  trigger: '/nc',
  added_at: '2026-04-07T00:00:00.000Z',
};

const WORKBENCH_TEST_SERVICE = 'workbench-store-test-service';

beforeEach(() => {
  _initTestDatabase();
  fs.rmSync(path.join(PROJECT_ROOT, 'projects', WORKBENCH_TEST_SERVICE), {
    recursive: true,
    force: true,
  });
  initWorkbenchEvents(() => {});
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('ops@g.us', OPS_GROUP);
  setRegisteredGroup('test@g.us', TEST_GROUP);
  setRegisteredGroup('dev@g.us', DEV_GROUP);
  setRegisteredGroup('plan@g.us', PLAN_GROUP);
  setRegisteredGroup('plan-examine@g.us', PLAN_EXAMINE_GROUP);
  storeChatMetadata('main@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('ops@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('test@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('dev@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('plan@g.us', '2026-04-07T00:00:00.000Z');
  storeChatMetadata('plan-examine@g.us', '2026-04-07T00:00:00.000Z');
  initWorkflow({
    registeredGroups: () => getAllRegisteredGroups(),
    enqueueMessageCheck: () => {},
  });
});

describe('workbench approval transition sync', () => {
  it('persists uploaded requirement files as workbench assets when creating a plan task', () => {
    const result = createWorkbenchTask({
      title: '新增昵称规则设计',
      service: 'order-service',
      sourceJid: 'main@g.us',
      startFrom: 'plan',
      workflowType: 'dev_test',
      context: {
        [WORKFLOW_CONTEXT_KEYS.requirementDescription]:
          '请为昵称规则改造输出方案。',
        [WORKFLOW_CONTEXT_KEYS.requirementFiles]: [
          '/tmp/req-a.md',
          '/tmp/req-b.png',
        ],
      },
    });

    expect(result.error).toBeUndefined();
    const taskRecord = getWorkbenchTaskByWorkflowId(result.workflowId);
    expect(taskRecord).not.toBeNull();

    const detail = getWorkbenchTaskDetail(taskRecord!.id);
    expect(detail?.assets.map((item) => item.path)).toEqual([
      '/tmp/req-b.png',
      '/tmp/req-a.md',
    ]);
    expect(
      detail?.assets.every((item) => item.asset_type === 'requirement_file'),
    ).toBe(true);
  });

  it('surfaces pending stage evaluations in workbench when evidence is missing', () => {
    dbCreateWorkflow({
      id: 'wf-plan-eval-pending',
      name: '方案评测待补证据',
      service: WORKBENCH_TEST_SERVICE,
      start_from: 'plan',
      context: {
        main_branch: '',
        work_branch: '',
        staging_base_branch: '',
        deliverable: '',
        staging_work_branch: '',
        access_token: '',
      },
      status: 'plan',
      current_delegation_id: 'wf-del-plan-eval-pending',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-plan-eval-pending');
    createDelegation({
      id: 'wf-del-plan-eval-pending',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'plan@g.us',
      target_folder: 'web_plan',
      task: '输出方案',
      status: 'completed',
      result: JSON.stringify({
        deliverable: '2026-04-07_pending_eval',
        summary: '方案已完成，但还没有产出 plan.md',
      }),
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-plan-eval-pending',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:05:00.000Z',
    });

    onDelegationComplete('wf-del-plan-eval-pending');

    const evaluation = getLatestWorkflowStageEvaluation(
      'wf-plan-eval-pending',
      'plan',
    );
    expect(evaluation?.status).toBe('pending');

    const detail = getWorkbenchTaskDetail('wb-wf-plan-eval-pending');
    expect(detail).not.toBeNull();
    expect(detail?.task.workflow_stage).toBe('plan');
    expect(detail?.evaluations[0]?.status).toBe('pending');
    expect(detail?.action_items).toHaveLength(1);
    expect(detail?.action_items[0]?.title).toContain('需要处理');
    expect(
      detail?.timeline.some((item) => item.status === 'stage_evaluated'),
    ).toBe(true);
  });

  it('marks awaiting_confirm completed and clears pending approval after approve', () => {
    dbCreateWorkflow({
      id: 'wf-predeploy',
      name: '预发部署验证',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/predeploy',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_predeploy',
        staging_work_branch: 'staging-deploy/feature-predeploy',
        access_token: '',
      },
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
    expect(detail?.task.workflow_stage).toBe('ops_deploy');
    expect(detail?.task.task_state).toBe('running');
    expect(detail?.action_items).toHaveLength(0);
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'awaiting_confirm')
        ?.status,
    ).toBe('completed');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'ops_deploy')?.status,
    ).toBe('current');
    expect(detail?.subtasks.map((item) => item.stage_key)).toEqual([
      'awaiting_confirm',
      'ops_deploy',
      'testing_confirm',
      'testing',
      'fixing',
    ]);
  });

  it('marks bypassed plan_examine_confirm completed when plan review passes directly to dev', () => {
    dbCreateWorkflow({
      id: 'wf-plan-review-pass',
      name: '方案审核通过',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/plan-review-pass',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_plan_review_pass',
        staging_work_branch: 'staging-deploy/feature-plan-review-pass',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'wf-del-plan-review-pass',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-plan-review-pass');

    updateWorkflow('wf-plan-review-pass', {
      status: 'dev',
      current_delegation_id: 'wf-del-dev',
    });
    syncWorkbenchOnTransition(
      'wf-plan-review-pass',
      'plan_examine',
      'dev',
      'wf-del-dev',
    );

    const detail = getWorkbenchTaskDetail('wb-wf-plan-review-pass');
    expect(detail).not.toBeNull();
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'plan_examine_confirm')
        ?.status,
    ).toBe('completed');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'dev')?.status,
    ).toBe('current');
  });

  it('does not emit nested action item updates while rendering broadcast cards', () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-readonly-detail',
      name: '广播卡片只读详情',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/broadcast-readonly',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_readonly',
        staging_work_branch: 'staging-deploy/feature-broadcast-readonly',
        access_token: '',
      },
      status: 'plan_examine_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-broadcast-readonly-detail');

    const taskId = 'wb-wf-broadcast-readonly-detail';
    const actionItemId =
      'wb-action-wf-broadcast-readonly-detail-plan_examine_confirm';
    let nestedPendingEvents = 0;

    initWorkbenchEvents((event) => {
      if (
        event.type === 'action_item_updated' &&
        event.payload.id === actionItemId &&
        event.payload.status === 'pending'
      ) {
        nestedPendingEvents += 1;
      }
    });

    const card = buildWorkbenchBroadcastCard({ taskId, actionItemId });

    expect(card?.header.title).toContain('确认方案修改或继续开发');
    expect(card?.buttons?.map((button) => button.label)).toEqual([
      '继续开发',
      '跳过此节点',
    ]);
    expect(card?.form?.submitButton.label).toBe('返回方案修改');
    expect(nestedPendingEvents).toBe(0);
  });

  it('uses the same testing_confirm labels in broadcast cards as workbench actions', () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-testing-confirm',
      name: '广播测试确认',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/broadcast-testing-confirm',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_testing_confirm',
        staging_work_branch: 'staging-deploy/feature-broadcast-testing-confirm',
        access_token: '',
      },
      status: 'testing_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-broadcast-testing-confirm');

    const card = buildWorkbenchBroadcastCard({
      taskId: 'wb-wf-broadcast-testing-confirm',
      actionItemId: 'wb-action-wf-broadcast-testing-confirm-testing_confirm',
    });

    expect(card?.buttons?.map((button) => button.label)).toEqual([
      '跳过鉴权直接测试',
    ]);
    expect(card?.form?.name).toBe('wb-su-wb-wf-broadcast-testing-confirm');
    expect(card?.form?.submitButton.id).toBe(
      'wb-su-wb-wf-broadcast-testing-confirm',
    );
    expect(card?.form?.submitButton.label).toBe('填写 access_token 并开始测试');
  });

  it('accepts testing_confirm submit actions when Feishu only returns action_item_id', async () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-testing-confirm-feishu-fallback',
      name: '广播测试确认飞书回调兜底',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/broadcast-testing-confirm-feishu-fallback',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_testing_confirm_feishu_fallback',
        staging_work_branch:
          'staging-deploy/feature-broadcast-testing-confirm-feishu-fallback',
        access_token: '',
      },
      status: 'testing_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated(
      'wf-broadcast-testing-confirm-feishu-fallback',
    );

    const result = await handleWorkbenchBroadcastCardAction({
      action: 'wb_broadcast_submit_access_token',
      formValue: {
        action_item_id:
          'wb-action-wf-broadcast-testing-confirm-feishu-fallback-testing_confirm',
        access_token: 'demo-token',
      },
      registeredGroups: getAllRegisteredGroups(),
      sendMessage: async () => {},
      userId: 'user-1',
    });

    expect(result.ok).toBe(true);
    expect(result.toast).toEqual({
      type: 'success',
      content: '已提交 access_token，正在开始测试。',
    });
  });

  it('renders ask-question option buttons in broadcast cards', () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-ask-options',
      name: '广播问答选项',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/broadcast-ask-options',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_ask_options',
        staging_work_branch: 'staging-deploy/feature-broadcast-ask-options',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'wf-del-broadcast-ask-options',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-broadcast-ask-options');
    createWorkbenchInteractionItem({
      workflowId: 'wf-broadcast-ask-options',
      stageKey: 'plan_examine',
      delegationId: 'wf-del-broadcast-ask-options',
      groupFolder: 'web_plan_examine',
      sourceType: 'ask_user_question',
      sourceRefId: 'ask-broadcast-ask-options',
      title: '请选择处理方式',
      body: '请选择处理方式',
      extra: {
        current_question: {
          id: 'q-broadcast-ask-options',
          question: '请选择处理方式',
          options: [
            { label: '继续' },
            { label: '回滚', description: '回退到上一轮方案' },
          ],
        },
      },
    });

    const detail = getWorkbenchTaskDetail('wb-wf-broadcast-ask-options');
    const actionItemId = detail?.action_items.find(
      (item) => item.source_ref_id === 'ask-broadcast-ask-options',
    )?.id;
    expect(actionItemId).toBeTruthy();

    const card = buildWorkbenchBroadcastCard({
      taskId: 'wb-wf-broadcast-ask-options',
      actionItemId: actionItemId!,
    });

    expect(card?.buttons?.map((button) => button.label)).toEqual([
      '继续',
      '回滚',
      '跳过',
    ]);
    expect(card?.form?.name).toBe('wb-reply-ask-broadcast-ask-options');
    expect(card?.form?.submitButton.id).toBe(
      'wb-reply-ask-broadcast-ask-options',
    );
    expect(card?.form?.submitButton.label).toBe('提交自定义答复');
    expect(card?.form?.submitButton.value).toEqual({
      action: 'wb_broadcast_reply',
      request_id: 'ask-broadcast-ask-options',
    });
    expect(card?.buttons?.[0]?.value).toEqual({
      action: 'wb_broadcast_reply',
      request_id: 'ask-broadcast-ask-options',
      answer: '继续',
    });
  });

  it('resolves ask-question broadcast replies by request_id when action_item_id is absent', async () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-ask-reply-request-id',
      name: '广播问答回调 request_id 兜底',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/broadcast-ask-reply-request-id',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_ask_reply_request_id',
        staging_work_branch:
          'staging-deploy/feature-broadcast-ask-reply-request-id',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'wf-del-broadcast-ask-reply-request-id',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-broadcast-ask-reply-request-id');
    createWorkbenchInteractionItem({
      workflowId: 'wf-broadcast-ask-reply-request-id',
      stageKey: 'plan_examine',
      delegationId: 'wf-del-broadcast-ask-reply-request-id',
      groupFolder: 'web_plan_examine',
      sourceType: 'ask_user_question',
      sourceRefId: 'aq-broadcast-reply-request-id',
      title: '请选择处理方式',
      body: '请选择处理方式',
      extra: {
        current_question: {
          id: 'q-broadcast-ask-reply-request-id',
          question: '请选择处理方式',
          options: [{ label: '继续' }],
        },
      },
    });
    createAskQuestion({
      id: 'aq-broadcast-reply-request-id',
      group_folder: 'web_plan_examine',
      chat_jid: 'plan-examine@g.us',
      status: 'pending',
      payload_json: JSON.stringify({
        questions: [
          {
            id: 'q-broadcast-ask-reply-request-id',
            question: '请选择处理方式',
            options: [{ label: '继续' }],
          },
        ],
        metadata: { source_type: 'ask_user_question' },
      }),
      answers_json: null,
      current_index: 0,
      created_at: '2026-04-07T00:00:00.000Z',
      expires_at: '2026-05-08T00:00:00.000Z',
      answered_at: null,
      responder_user_id: null,
    });

    const result = await handleWorkbenchBroadcastCardAction({
      action: 'wb_broadcast_reply',
      formValue: {
        request_id: 'aq-broadcast-reply-request-id',
        answer: '继续',
      },
      registeredGroups: getAllRegisteredGroups(),
      sendMessage: async () => {},
      userId: 'user-1',
    });

    expect(result.ok).toBe(true);
    expect(result.toast).toEqual({
      type: 'success',
      content: '答案已提交，感谢。',
    });
  });

  it('uses source_ref_id for send-message broadcast actions to keep payloads short', () => {
    dbCreateWorkflow({
      id: 'wf-broadcast-send-message',
      name: '广播消息确认',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/broadcast-send-message',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_broadcast_send_message',
        staging_work_branch: 'staging-deploy/feature-broadcast-send-message',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'wf-del-broadcast-send-message',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-broadcast-send-message');
    createWorkbenchInteractionItem({
      workflowId: 'wf-broadcast-send-message',
      stageKey: 'plan_examine',
      delegationId: 'wf-del-broadcast-send-message',
      groupFolder: 'web_plan_examine',
      sourceType: 'send_message',
      sourceRefId: 'msg-broadcast-send-message',
      title: '通知确认',
      body: '请阅读通知',
    });

    const detail = getWorkbenchTaskDetail('wb-wf-broadcast-send-message');
    const actionItemId = detail?.action_items.find(
      (item) => item.source_ref_id === 'msg-broadcast-send-message',
    )?.id;
    expect(actionItemId).toBeTruthy();

    const card = buildWorkbenchBroadcastCard({
      taskId: 'wb-wf-broadcast-send-message',
      actionItemId: actionItemId!,
    });

    expect(card?.buttons).toEqual([
      {
        id: `${actionItemId}-resolve`,
        label: '标记已读',
        value: {
          action: 'wb_broadcast_resolve',
          source_type: 'send_message',
          source_ref_id: 'msg-broadcast-send-message',
        },
      },
    ]);
  });

  it('emits task update before subtask updates during approve transition', () => {
    dbCreateWorkflow({
      id: 'wf-approve-event-order',
      name: '审批事件顺序',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/approve-order',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_approve_order',
        staging_work_branch: 'staging-deploy/feature-approve-order',
        access_token: '',
      },
      status: 'testing_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-approve-event-order');

    const emittedEvents: string[] = [];
    initWorkbenchEvents((event) => {
      emittedEvents.push(
        `${event.type}:${String(event.payload.workflowStage || event.payload.stageKey || '')}`,
      );
    });

    const result = approveWorkflow('wf-approve-event-order');
    expect(result.error).toBeUndefined();

    const firstTransitionSubtaskIdx = emittedEvents.findIndex(
      (item) => item === 'subtask_updated:testing',
    );
    const firstTransitionTaskIdx = emittedEvents.findIndex(
      (item) => item === 'task_updated:testing',
    );

    expect(firstTransitionTaskIdx).toBeGreaterThanOrEqual(0);
    expect(firstTransitionSubtaskIdx).toBeGreaterThanOrEqual(0);
    expect(firstTransitionTaskIdx).toBeLessThan(firstTransitionSubtaskIdx);
    expect(
      emittedEvents.filter((item) => item === 'task_updated:testing'),
    ).toHaveLength(1);
    expect(
      emittedEvents.filter((item) => item === 'subtask_updated:testing'),
    ).toHaveLength(1);
  });

  it('emits action_item_updated when a transition resolves current-stage interaction items', () => {
    dbCreateWorkflow({
      id: 'wf-transition-clears-interaction',
      name: '阶段切换清理互动项',
      service: 'order-service',
      start_from: 'plan',
      context: {
        main_branch: 'main',
        work_branch: 'feature/transition-clears-interaction',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_transition_clears_interaction',
        staging_work_branch:
          'staging-deploy/feature-transition-clears-interaction',
        access_token: '',
      },
      status: 'plan_examine',
      current_delegation_id: 'wf-del-transition-plan',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-transition-clears-interaction');
    createWorkbenchInteractionItem({
      workflowId: 'wf-transition-clears-interaction',
      stageKey: 'plan_examine',
      delegationId: 'wf-del-transition-plan',
      groupFolder: 'web_plan_examine',
      sourceType: 'send_message',
      sourceRefId: 'msg-transition-plan',
      title: 'Andy 消息',
      body: '请人工确认是否继续',
      createdAt: '2026-04-07T00:01:00.000Z',
    });

    const emittedEvents: Array<Record<string, unknown>> = [];
    initWorkbenchEvents((event) => {
      if (event.type === 'action_item_updated') {
        emittedEvents.push(event.payload);
      }
    });

    updateWorkflow('wf-transition-clears-interaction', {
      status: 'plan_examine_confirm',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-transition-clears-interaction',
      'plan_examine',
      'plan_examine_confirm',
    );

    expect(
      getWorkbenchActionItem(
        'wb-action-wf-transition-clears-interaction-plan_examine-send_message-msg-transition-plan',
      )?.status,
    ).toBe('resolved');
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'wb-action-wf-transition-clears-interaction-plan_examine-send_message-msg-transition-plan',
          status: 'resolved',
        }),
      ]),
    );
  });

  it('emits human-readable labels in realtime task updates', () => {
    dbCreateWorkflow({
      id: 'wf-realtime-labels',
      name: '实时标签',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/realtime-labels',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_realtime_labels',
        staging_work_branch: 'staging-deploy/feature-realtime-labels',
        access_token: '',
      },
      status: 'testing_confirm',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-realtime-labels');

    const events: Array<Record<string, unknown>> = [];
    initWorkbenchEvents((event) => {
      if (event.type === 'task_updated') {
        events.push(event.payload);
      }
    });

    const result = approveWorkflow('wf-realtime-labels');
    expect(result.error).toBeUndefined();
    expect(events).not.toHaveLength(0);
    expect(events[0]?.workflowStatus).toBe('testing');
    expect(events[0]?.workflowStatusLabel).toBe('🧪 测试中');
    expect(events[0]?.taskState).toBe('running');
    expect(events[0]?.workflowStage).toBe('testing');
    expect(events[0]?.workflowStageLabel).toBe('🧪 测试中');
  });

  it('exposes task_state for passed workflows', () => {
    dbCreateWorkflow({
      id: 'wf-terminal-flags',
      name: '终态标记',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/terminal-flags',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_terminal_flags',
        staging_work_branch: 'staging-deploy/feature-terminal-flags',
        access_token: '',
      },
      status: 'passed',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });

    syncWorkbenchOnWorkflowCreated('wf-terminal-flags');

    const detail = getWorkbenchTaskDetail('wb-wf-terminal-flags');
    const persisted = getWorkbenchTaskByWorkflowId('wf-terminal-flags');
    expect(detail).not.toBeNull();
    expect(persisted?.task_state).toBe('success');
    expect(detail?.task.workflow_status).toBe('passed');
    expect(detail?.task.task_state).toBe('success');
  });

  it('does not duplicate the same transition event when re-synced', () => {
    dbCreateWorkflow({
      id: 'wf-transition-dedupe',
      name: '部署失败去重',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/fail',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_fail',
        staging_work_branch: 'staging-deploy/feature-fail',
        access_token: '',
      },
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

    syncWorkbenchOnTransition(
      'wf-transition-dedupe',
      'ops_deploy',
      'ops_failed',
      'wf-del-1',
    );
    syncWorkbenchOnTransition(
      'wf-transition-dedupe',
      'ops_deploy',
      'ops_failed',
      'wf-del-1',
    );

    const task = getWorkbenchTaskByWorkflowId('wf-transition-dedupe');
    expect(task).not.toBeNull();

    const transitionEvents = listWorkbenchEventsByTask(task!.id).filter(
      (item) =>
        item.event_type === 'transition' &&
        item.title.includes('部署中') &&
        item.title.includes('部署失败'),
    );
    expect(transitionEvents).toHaveLength(1);
  });

  it('returns task timeline in chronological order', () => {
    dbCreateWorkflow({
      id: 'wf-timeline-order',
      name: '时间线排序',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/timeline-order',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_timeline_order',
        staging_work_branch: 'staging-deploy/feature-timeline-order',
        access_token: '',
      },
      status: 'ops_failed',
      current_delegation_id: 'wf-del-order',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:30:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-timeline-order');
    syncWorkbenchOnTransition(
      'wf-timeline-order',
      'ops_deploy',
      'ops_failed',
      'wf-del-order',
    );

    const detail = getWorkbenchTaskDetail('wb-wf-timeline-order');
    expect(detail).not.toBeNull();
    expect(detail?.timeline.map((item) => item.created_at)).toEqual([
      '2026-04-07T00:00:00.000Z',
      '2026-04-07T00:30:00.000Z',
    ]);
  });

  it('appends a new stage node when workflow re-enters deployment after fixing', () => {
    dbCreateWorkflow({
      id: 'wf-reenter-deploy',
      name: '重新部署链路',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/reenter-deploy',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_reenter_deploy',
        staging_work_branch: 'staging-deploy/feature-reenter-deploy',
        access_token: '',
      },
      status: 'fixing',
      current_delegation_id: 'wf-del-fixing-1',
      round: 1,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:20:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-reenter-deploy');

    updateWorkflow('wf-reenter-deploy', {
      status: 'testing_confirm',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-reenter-deploy',
      'ops_deploy',
      'testing_confirm',
      'wf-del-ops-1',
    );

    updateWorkflow('wf-reenter-deploy', {
      status: 'testing',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-reenter-deploy',
      'testing_confirm',
      'testing',
    );

    updateWorkflow('wf-reenter-deploy', {
      status: 'fixing',
      current_delegation_id: 'wf-del-fixing-1',
    });
    syncWorkbenchOnTransition(
      'wf-reenter-deploy',
      'testing',
      'fixing',
      'wf-del-test-1',
    );

    updateWorkflow('wf-reenter-deploy', {
      status: 'ops_deploy',
      current_delegation_id: 'wf-del-ops-2',
    });
    syncWorkbenchOnTransition(
      'wf-reenter-deploy',
      'fixing',
      'ops_deploy',
      'wf-del-ops-2',
    );

    const detail = getWorkbenchTaskDetail('wb-wf-reenter-deploy');
    expect(detail).not.toBeNull();

    const deploymentSubtasks =
      detail?.subtasks.filter((item) => item.stage_key === 'ops_deploy') || [];
    expect(deploymentSubtasks).toHaveLength(2);
    expect(deploymentSubtasks.map((item) => item.id)).toEqual([
      'wb-subtask-wb-wf-reenter-deploy-ops_deploy',
      'wb-subtask-wb-wf-reenter-deploy-ops_deploy-2',
    ]);
    expect(detail?.subtasks.map((item) => item.stage_key)).toEqual([
      'ops_deploy',
      'testing_confirm',
      'testing',
      'fixing',
      'ops_deploy',
    ]);
    expect(deploymentSubtasks.map((item) => item.status)).toEqual([
      'completed',
      'current',
    ]);
  });

  it('does not append a duplicate stage node for a failed fixing self-loop', () => {
    dbCreateWorkflow({
      id: 'wf-fixing-self-loop',
      name: '修复失败回环',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/fixing-self-loop',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_fixing_self_loop',
        staging_work_branch: 'staging-deploy/feature-fixing-self-loop',
        access_token: '',
      },
      status: 'fixing',
      current_delegation_id: 'wf-del-fixing-self-loop',
      round: 2,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    createDelegation({
      id: 'wf-del-fixing-self-loop',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'dev@g.us',
      target_folder: 'web_dev',
      task: 'fixing task',
      status: 'completed',
      result: '修复失败，需要人工介入',
      outcome: 'failure',
      requester_jid: null,
      workflow_id: 'wf-fixing-self-loop',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:10:00.000Z',
    });
    updateDelegation('wf-del-fixing-self-loop', {
      status: 'completed',
      result: '修复失败，需要人工介入',
      outcome: 'failure',
    });
    syncWorkbenchOnWorkflowCreated('wf-fixing-self-loop');

    onDelegationComplete('wf-del-fixing-self-loop');

    const detail = getWorkbenchTaskDetail('wb-wf-fixing-self-loop');
    expect(detail).not.toBeNull();
    expect(
      detail?.subtasks.filter((item) => item.stage_key === 'fixing'),
    ).toHaveLength(1);
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'fixing')?.status,
    ).toBe('failed');
    expect(
      listWorkbenchEventsByTask('wb-wf-fixing-self-loop').some((item) =>
        item.title.includes('修复中 -> 修复中'),
      ),
    ).toBe(false);
  });

  it('allows returning from a completed confirmation subtask to that node', () => {
    dbCreateWorkflow({
      id: 'wf-return-confirmation-stage',
      name: '回到确认节点',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/return-confirmation',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_return_confirmation',
        staging_work_branch: 'staging-deploy/feature-return-confirmation',
        access_token: '',
      },
      status: 'ops_deploy',
      current_delegation_id: 'wf-del-ops-return-1',
      round: 1,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-return-confirmation-stage');

    updateWorkflow('wf-return-confirmation-stage', {
      status: 'testing_confirm',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-return-confirmation-stage',
      'ops_deploy',
      'testing_confirm',
      'wf-del-ops-return-1',
    );

    updateWorkflow('wf-return-confirmation-stage', {
      status: 'testing',
      current_delegation_id: 'wf-del-test-return-1',
    });
    syncWorkbenchOnTransition(
      'wf-return-confirmation-stage',
      'testing_confirm',
      'testing',
      'wf-del-test-return-1',
    );

    updateWorkflow('wf-return-confirmation-stage', {
      status: 'fixing',
      current_delegation_id: 'wf-del-fixing-return-1',
    });
    syncWorkbenchOnTransition(
      'wf-return-confirmation-stage',
      'testing',
      'fixing',
      'wf-del-fixing-return-1',
    );

    const task = getWorkbenchTaskByWorkflowId('wf-return-confirmation-stage');
    expect(task).not.toBeNull();
    const detailBefore = getWorkbenchTaskDetail(task!.id);
    const completedConfirmation = detailBefore?.subtasks.find(
      (item) =>
        item.stage_key === 'testing_confirm' && item.status === 'completed',
    );
    expect(completedConfirmation?.stage_type).toBe('confirmation');

    const result = retryWorkbenchSubtask({
      taskId: task!.id,
      subtaskId: completedConfirmation!.id,
    });
    expect(result.error).toBeUndefined();

    const detail = getWorkbenchTaskDetail(task!.id);
    expect(detail).not.toBeNull();
    expect(detail?.task.workflow_stage).toBe('testing_confirm');
    expect(
      detail?.action_items.map((item) => `${item.stage_key}:${item.status}`),
    ).toEqual(['testing_confirm:pending']);

    const confirmationSubtasks =
      detail?.subtasks.filter((item) => item.stage_key === 'testing_confirm') ||
      [];
    expect(confirmationSubtasks).toHaveLength(2);
    expect(confirmationSubtasks.map((item) => item.status)).toEqual([
      'completed',
      'current',
    ]);
    expect(
      confirmationSubtasks.every((item) => item.stage_type === 'confirmation'),
    ).toBe(true);
  });

  it('keeps historical delegation data on the correct re-entry subtask', () => {
    dbCreateWorkflow({
      id: 'wf-reentry-delegation-history',
      name: '历史节点归属',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/reentry-history',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_reentry_history',
        staging_work_branch: 'staging-deploy/feature-reentry-history',
        access_token: '',
      },
      status: 'ops_deploy',
      current_delegation_id: 'wf-del-ops-1',
      round: 1,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-reentry-delegation-history');

    createDelegation({
      id: 'wf-del-ops-1',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'ops@g.us',
      target_folder: 'web_ops',
      task: '第一次预发部署',
      status: 'completed',
      result: '{"summary":"预发部署完成"}',
      outcome: 'success',
      requester_jid: null,
      workflow_id: 'wf-reentry-delegation-history',
      created_at: '2026-04-07T00:01:00.000Z',
      updated_at: '2026-04-07T00:02:00.000Z',
    });
    syncWorkbenchOnDelegationCreated(
      'wf-reentry-delegation-history',
      'wf-del-ops-1',
    );
    syncWorkbenchOnDelegationCompleted(
      'wf-reentry-delegation-history',
      'wf-del-ops-1',
    );

    updateWorkflow('wf-reentry-delegation-history', {
      status: 'testing_confirm',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-reentry-delegation-history',
      'ops_deploy',
      'testing_confirm',
      'wf-del-ops-1',
    );

    updateWorkflow('wf-reentry-delegation-history', {
      status: 'testing',
      current_delegation_id: 'wf-del-test-1',
    });
    syncWorkbenchOnTransition(
      'wf-reentry-delegation-history',
      'testing_confirm',
      'testing',
      'wf-del-test-1',
    );
    createDelegation({
      id: 'wf-del-test-1',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'test@g.us',
      target_folder: 'web_test',
      task: '执行测试',
      status: 'completed',
      result: '{"summary":"测试发现问题"}',
      outcome: 'failure',
      requester_jid: null,
      workflow_id: 'wf-reentry-delegation-history',
      created_at: '2026-04-07T00:03:00.000Z',
      updated_at: '2026-04-07T00:04:00.000Z',
    });
    syncWorkbenchOnDelegationCreated(
      'wf-reentry-delegation-history',
      'wf-del-test-1',
    );
    syncWorkbenchOnDelegationCompleted(
      'wf-reentry-delegation-history',
      'wf-del-test-1',
    );

    updateWorkflow('wf-reentry-delegation-history', {
      status: 'fixing',
      current_delegation_id: '',
    });
    syncWorkbenchOnTransition(
      'wf-reentry-delegation-history',
      'testing',
      'fixing',
      'wf-del-test-1',
    );

    updateWorkflow('wf-reentry-delegation-history', {
      status: 'ops_deploy',
      current_delegation_id: 'wf-del-ops-2',
    });
    syncWorkbenchOnTransition(
      'wf-reentry-delegation-history',
      'fixing',
      'ops_deploy',
      'wf-del-ops-2',
    );
    createDelegation({
      id: 'wf-del-ops-2',
      source_jid: 'main@g.us',
      source_folder: 'web_main',
      target_jid: 'ops@g.us',
      target_folder: 'web_ops',
      task: '修复后重新部署',
      status: 'pending',
      result: '',
      outcome: null,
      requester_jid: null,
      workflow_id: 'wf-reentry-delegation-history',
      created_at: '2026-04-07T00:05:00.000Z',
      updated_at: '2026-04-07T00:05:00.000Z',
    });
    syncWorkbenchOnDelegationCreated(
      'wf-reentry-delegation-history',
      'wf-del-ops-2',
    );

    const detail = getWorkbenchTaskDetail('wb-wf-reentry-delegation-history');
    expect(detail).not.toBeNull();

    const deploymentSubtasks =
      detail?.subtasks.filter((item) => item.stage_key === 'ops_deploy') || [];
    expect(deploymentSubtasks).toHaveLength(2);
    expect(deploymentSubtasks[0]?.target_folder).toBe('web_ops');
    expect(deploymentSubtasks[0]?.result).toContain('预发部署完成');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'testing')
        ?.target_folder,
    ).toBe('web_test');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'testing')?.result,
    ).toContain('测试发现问题');
    expect(deploymentSubtasks[1]?.target_folder).toBe('web_ops');
    expect(deploymentSubtasks[1]?.result).toBeUndefined();
  });

  it('returns workbench task list in reverse updated_at order', () => {
    dbCreateWorkflow({
      id: 'wf-task-order-older',
      name: '较早任务',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/task-order-older',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_task_order_older',
        staging_work_branch: 'staging-deploy/feature-task-order-older',
        access_token: '',
      },
      status: 'testing',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:10:00.000Z',
    });
    dbCreateWorkflow({
      id: 'wf-task-order-newer',
      name: '较新任务',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/task-order-newer',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_task_order_newer',
        staging_work_branch: 'staging-deploy/feature-task-order-newer',
        access_token: '',
      },
      status: 'testing',
      current_delegation_id: '',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:20:00.000Z',
    });

    syncWorkbenchOnWorkflowCreated('wf-task-order-older');
    syncWorkbenchOnWorkflowCreated('wf-task-order-newer');

    expect(
      listWorkbenchTasks()
        .map((item) => item.id)
        .slice(0, 2),
    ).toEqual(['wb-wf-task-order-newer', 'wb-wf-task-order-older']);
  });

  it('marks the active stage cancelled instead of completed when workflow is cancelled', () => {
    dbCreateWorkflow({
      id: 'wf-cancel-fixing',
      name: '取消中的修复',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/cancel-fixing',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_cancel_fixing',
        staging_work_branch: 'staging-deploy/feature-cancel-fixing',
        access_token: '',
      },
      status: 'fixing',
      current_delegation_id: 'wf-del-cancel',
      round: 1,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:20:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-cancel-fixing');

    const task = getWorkbenchTaskByWorkflowId('wf-cancel-fixing');
    expect(task).not.toBeNull();
    const fixingSubtaskBefore = getWorkbenchTaskDetail(task!.id)?.subtasks.find(
      (item) => item.stage_key === 'fixing',
    );
    expect(fixingSubtaskBefore?.status).toBe('current');

    const result = cancelWorkflow('wf-cancel-fixing');
    expect(result.error).toBeUndefined();

    const detail = getWorkbenchTaskDetail(task!.id);
    expect(detail).not.toBeNull();
    expect(detail?.task.workflow_status).toBe('cancelled');
    expect(
      detail?.subtasks.find((item) => item.stage_key === 'fixing')?.status,
    ).toBe('cancelled');
  });

  it('keeps only current-stage current-delegation interaction items pending', () => {
    dbCreateWorkflow({
      id: 'wf-stale-action-items',
      name: '互动项清理',
      service: 'order-service',
      start_from: 'testing',
      context: {
        main_branch: '',
        work_branch: 'feature/stale-items',
        staging_base_branch: 'staging',
        deliverable: '2026-04-07_stale_items',
        staging_work_branch: 'staging-deploy/feature-stale-items',
        access_token: '',
      },
      status: 'ops_deploy',
      current_delegation_id: 'wf-del-current',
      round: 0,
      source_jid: 'main@g.us',
      paused_from: null,
      workflow_type: 'dev_test',
      created_at: '2026-04-07T00:00:00.000Z',
      updated_at: '2026-04-07T00:00:00.000Z',
    });
    syncWorkbenchOnWorkflowCreated('wf-stale-action-items');

    createWorkbenchInteractionItem({
      workflowId: 'wf-stale-action-items',
      stageKey: 'ops_deploy',
      delegationId: 'wf-del-current',
      groupFolder: 'web_ops',
      sourceType: 'ask_user_question',
      sourceRefId: 'aq-current',
      title: '当前委派提问',
      body: 'current ask',
      createdAt: '2026-04-07T00:01:00.000Z',
    });
    createWorkbenchInteractionItem({
      workflowId: 'wf-stale-action-items',
      stageKey: 'ops_deploy',
      delegationId: 'wf-del-old',
      groupFolder: 'web_ops',
      sourceType: 'request_human_input',
      sourceRefId: 'rhi-old',
      title: '旧委派输入',
      body: 'old delegation',
      createdAt: '2026-04-07T00:01:01.000Z',
    });
    createWorkbenchInteractionItem({
      workflowId: 'wf-stale-action-items',
      stageKey: 'awaiting_confirm',
      delegationId: 'wf-del-current',
      groupFolder: 'web_ops',
      sourceType: 'send_message',
      sourceRefId: 'msg-old-stage',
      title: '旧阶段消息',
      body: 'old stage',
      createdAt: '2026-04-07T00:01:02.000Z',
    });

    syncWorkbenchOnWorkflowUpdated(
      'wf-stale-action-items',
      '同步当前阶段待处理项',
    );

    expect(
      getWorkbenchActionItem(
        'wb-action-wf-stale-action-items-ops_deploy-ask_user_question-aq-current',
      )?.status,
    ).toBe('pending');
    expect(
      getWorkbenchActionItem(
        'wb-action-wf-stale-action-items-ops_deploy-request_human_input-rhi-old',
      )?.status,
    ).toBe('resolved');
    expect(
      getWorkbenchActionItem(
        'wb-action-wf-stale-action-items-awaiting_confirm-send_message-msg-old-stage',
      )?.status,
    ).toBe('resolved');

    const detail = getWorkbenchTaskDetail('wb-wf-stale-action-items');
    expect(detail?.action_items.map((item) => item.id)).toEqual([
      'wb-action-wf-stale-action-items-ops_deploy-ask_user_question-aq-current',
    ]);
  });
});
