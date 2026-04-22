import type {
  AskQuestionField,
  AskQuestionItem,
  CardButton,
  CardInput,
  InteractiveCard,
} from './types.js';
import { getWorkbenchTaskDetail } from './workbench.js';

function headerColorForTaskState(
  taskState: 'running' | 'success' | 'failed' | 'cancelled',
): InteractiveCard['header']['color'] {
  if (taskState === 'success') return 'green';
  if (taskState === 'failed') return 'red';
  if (taskState === 'cancelled') return 'grey';
  return 'orange';
}

function buildWorkbenchBroadcastBody(input: {
  taskTitle: string;
  service: string;
  taskState: string;
  workflowStatusLabel: string;
  workflowStageLabel: string;
  description?: string;
  extraLines?: string[];
}): string {
  return [
    `任务: ${input.taskTitle}`,
    `服务: ${input.service}`,
    `任务状态: ${input.taskState}`,
    `流程状态: ${input.workflowStatusLabel}`,
    `当前阶段: ${input.workflowStageLabel}`,
    input.description ? `说明: ${input.description}` : '',
    ...(input.extraLines || []),
  ]
    .filter(Boolean)
    .join('\n');
}

function getWorkbenchApprovalLabels(input: {
  approvalType: string;
  actionMode?: 'approve_only' | 'approve_or_revise' | 'input_required';
}): { approve: string; revise: string; skip: string } {
  switch (input.approvalType) {
    case 'plan_confirm':
      return {
        approve: '进入开发',
        revise: '返回方案修改',
        skip: '跳过此节点',
      };
    case 'plan_examine_confirm':
      return {
        approve: '继续开发',
        revise: '返回方案修改',
        skip: '跳过此节点',
      };
    case 'dev_examine_confirm':
      return {
        approve: '继续后续流程',
        revise: '返回开发修正',
        skip: '跳过此节点',
      };
    case 'awaiting_confirm':
      return { approve: '开始预发部署', revise: '', skip: '跳过此节点' };
    case 'testing_confirm':
      return {
        approve: '',
        revise: '填写 access_token 并开始测试',
        skip: '跳过鉴权直接测试',
      };
    default:
      return {
        approve: '通过',
        revise: input.actionMode === 'approve_or_revise' ? '驳回并修改' : '',
        skip: '跳过此节点',
      };
  }
}

function getCurrentAskQuestion(item: {
  extra?: Record<string, unknown>;
}): AskQuestionItem | null {
  const current = item.extra?.current_question;
  if (!current || typeof current !== 'object') return null;
  return current as AskQuestionItem;
}

function isAskFormQuestion(question: AskQuestionItem | null): boolean {
  return Array.isArray(question?.fields) && question.fields.length > 0;
}

function askFieldPlaceholder(field: AskQuestionField): string {
  return field.description || field.label;
}

function askFieldInputType(field: AskQuestionField): CardInput['type'] {
  if (field.enum && field.enum.length > 0) return 'enum';
  if (
    field.type === 'number' ||
    field.type === 'integer' ||
    field.type === 'boolean'
  ) {
    return field.type;
  }
  return 'text';
}

function buildAskQuestionButtons(input: {
  itemId: string;
  taskId: string;
  actionItemId: string;
  requestId?: string;
  question: AskQuestionItem | null;
}): CardButton[] {
  const skipButton: CardButton = {
    id: `${input.itemId}-skip`,
    label: '跳过',
    value: {
      action: 'wb_broadcast_skip_reply',
      task_id: input.taskId,
      action_item_id: input.actionItemId,
      ...(input.requestId ? { request_id: input.requestId } : {}),
    },
  };

  if (
    !input.question ||
    isAskFormQuestion(input.question) ||
    input.question.multi_select === true ||
    !Array.isArray(input.question.options) ||
    input.question.options.length === 0
  ) {
    return [skipButton];
  }

  return [
    ...input.question.options.map((opt, index) => ({
      id: `${input.itemId}-answer-${index}`,
      label: opt.label,
      value: {
        action: 'wb_broadcast_reply',
        task_id: input.taskId,
        action_item_id: input.actionItemId,
        answer: opt.label,
        ...(input.requestId ? { request_id: input.requestId } : {}),
      },
    })),
    skipButton,
  ];
}

function buildAskQuestionForm(input: {
  itemId: string;
  taskId: string;
  actionItemId: string;
  requestId?: string;
  question: AskQuestionItem | null;
}): InteractiveCard['form'] {
  const formToken = input.requestId || input.itemId;
  if (input.question && isAskFormQuestion(input.question)) {
    return {
      name: `wb-reply-${formToken}`,
      inputs: (input.question.fields || []).map((field) => ({
        name: field.id,
        placeholder: askFieldPlaceholder(field),
        type: askFieldInputType(field),
        options: field.enum?.map((opt) => ({
          value: opt.value,
          label: opt.label,
        })),
        required: field.required === true,
        min: field.min,
        max: field.max,
        min_length: field.min_length,
        max_length: field.max_length,
        format: field.format,
      })),
      submitButton: {
        id: `wb-reply-${formToken}`,
        label: '提交',
        type: 'primary',
        value: {
          action: 'wb_broadcast_reply',
          task_id: input.taskId,
          action_item_id: input.actionItemId,
          ...(input.requestId ? { request_id: input.requestId } : {}),
        },
      },
    };
  }

  if (input.question?.multi_select) {
    return {
      name: `wb-reply-${formToken}`,
      inputs: [
        {
          name: 'reply_text',
          type: 'textarea',
          placeholder: '输入多个选项或自定义文本，逗号分隔',
          required: true,
        },
      ],
      submitButton: {
        id: `wb-reply-${formToken}`,
        label: '提交答复',
        type: 'primary',
        value: {
          action: 'wb_broadcast_reply',
          task_id: input.taskId,
          action_item_id: input.actionItemId,
          ...(input.requestId ? { request_id: input.requestId } : {}),
        },
      },
    };
  }

  return {
    name: `wb-reply-${formToken}`,
    inputs: [
      {
        name: 'reply_text',
        type: 'textarea',
        placeholder:
          input.question &&
          Array.isArray(input.question.options) &&
          input.question.options.length > 0
            ? '输入自定义答复'
            : '输入答复内容',
        required: true,
      },
    ],
    submitButton: {
      id: `wb-reply-${formToken}`,
      label:
        input.question &&
        Array.isArray(input.question.options) &&
        input.question.options.length > 0
          ? '提交自定义答复'
          : '提交答复',
      type: 'primary',
      value: {
        action: 'wb_broadcast_reply',
        task_id: input.taskId,
        action_item_id: input.actionItemId,
        ...(input.requestId ? { request_id: input.requestId } : {}),
      },
    },
  };
}

export function buildWorkbenchBroadcastResolvedText(input: {
  taskId: string;
  actionItemId: string;
  nextStatus: string;
}): string | null {
  const detail = getWorkbenchTaskDetail(input.taskId, { sync: false });
  if (!detail) return null;
  return [
    '工作台待办已更新',
    `任务: ${detail.task.title}`,
    `任务状态: ${detail.task.task_state}`,
    `流程状态: ${detail.task.workflow_status_label}`,
    `当前阶段: ${detail.task.workflow_stage_label}`,
    `待办ID: ${input.actionItemId}`,
    `新状态: ${input.nextStatus}`,
  ].join('\n');
}

export function buildWorkbenchBroadcastFallbackText(input: {
  taskId: string;
  actionItemId: string;
}): string | null {
  const detail = getWorkbenchTaskDetail(input.taskId, { sync: false });
  if (!detail) return null;

  const item = detail.action_items.find(
    (entry) => entry.id === input.actionItemId,
  );
  if (!item || item.status !== 'pending') return null;

  const lines = [
    `【${item.title}】`,
    `任务: ${detail.task.title}`,
    `服务: ${detail.task.service}`,
    `任务状态: ${detail.task.task_state}`,
    `流程状态: ${detail.task.workflow_status_label}`,
    `当前阶段: ${detail.task.workflow_stage_label}`,
    item.body ? `说明: ${item.body}` : '',
    `待办ID: ${item.id}`,
    '卡片发送失败，已自动降级为文本消息。',
  ].filter(Boolean);

  if (
    (item.source_type === 'ask_user_question' ||
      item.source_type === 'request_human_input') &&
    item.source_ref_id
  ) {
    lines.push(`可在广播群回复: /answer ${item.source_ref_id} <你的答复>`);
    lines.push(`如需跳过，可回复: /answer ${item.source_ref_id} --skip`);
  } else if (item.source_type === 'workflow') {
    lines.push('请到工作台或支持卡片操作的群里处理该待办。');
  } else if (item.source_type === 'send_message') {
    lines.push('该待办需要人工确认后在工作台中处理。');
  }

  return lines.join('\n');
}

export function buildWorkbenchBroadcastCard(input: {
  taskId: string;
  actionItemId: string;
}): InteractiveCard | null {
  const detail = getWorkbenchTaskDetail(input.taskId, { sync: false });
  if (!detail) return null;

  const item = detail.action_items.find(
    (entry) => entry.id === input.actionItemId,
  );
  if (!item || item.status !== 'pending') return null;

  const card: InteractiveCard = {
    header: {
      title: `工作台待办：${item.title}`,
      color: headerColorForTaskState(detail.task.task_state),
    },
    body: buildWorkbenchBroadcastBody({
      taskTitle: detail.task.title,
      service: detail.task.service,
      taskState: detail.task.task_state,
      workflowStatusLabel: detail.task.workflow_status_label,
      workflowStageLabel: detail.task.workflow_stage_label,
      description: item.body,
      extraLines:
        typeof item.extra?.validation_error === 'string' &&
        item.extra.validation_error.trim()
          ? [`校验错误: ${item.extra.validation_error.trim()}`]
          : undefined,
    }),
  };

  if (item.source_type === 'workflow') {
    const labels = getWorkbenchApprovalLabels({
      approvalType: item.stage_key || detail.task.workflow_status,
      actionMode: item.action_mode,
    });
    const buttons: CardButton[] = [];
    if (item.action_mode !== 'input_required' && labels.approve) {
      buttons.push({
        id: `${item.id}-confirm`,
        label: labels.approve,
        type: 'primary' as const,
        value: {
          action: 'wb_broadcast_confirm',
          task_id: detail.task.id,
          action_item_id: item.id,
        },
      });
    }
    buttons.push({
      id: `${item.id}-skip`,
      label: labels.skip || '跳过此节点',
      value: {
        action: 'wb_broadcast_skip',
        task_id: detail.task.id,
        action_item_id: item.id,
      },
    });
    if (item.action_mode === 'approve_or_revise') {
      card.form = {
        name: `wb-revise-${item.id}`,
        inputs: [
          {
            name: 'revision_text',
            type: 'textarea',
            placeholder: '输入修改意见',
            required: true,
          },
        ],
        submitButton: {
          id: `${item.id}-revise`,
          label: labels.revise || '返回方案修改',
          value: {
            action: 'wb_broadcast_revise',
            task_id: detail.task.id,
            action_item_id: item.id,
          },
        },
      };
    } else if (item.action_mode === 'input_required') {
      card.form = {
        name: `wb-submit-${item.id}`,
        inputs: [
          {
            name: 'access_token',
            type: 'text',
            placeholder: '请输入 access_token',
            required: true,
          },
        ],
        submitButton: {
          id: `${item.id}-submit-access-token`,
          label: labels.revise || '填写 access_token 并开始测试',
          type: 'primary',
          value: {
            action: 'wb_broadcast_submit_access_token',
            task_id: detail.task.id,
            action_item_id: item.id,
          },
        },
      };
    }
    if (buttons.length > 0) card.buttons = buttons;
    return card;
  }

  if (
    item.source_type === 'ask_user_question' ||
    item.source_type === 'request_human_input'
  ) {
    const requestId = item.source_ref_id || undefined;
    const question = getCurrentAskQuestion(item);
    card.form = buildAskQuestionForm({
      itemId: item.id,
      taskId: detail.task.id,
      actionItemId: item.id,
      requestId,
      question,
    });
    card.buttons = buildAskQuestionButtons({
      itemId: item.id,
      taskId: detail.task.id,
      actionItemId: item.id,
      requestId,
      question,
    });
    return card;
  }

  if (item.source_type === 'send_message') {
    card.buttons = [
      {
        id: `${item.id}-resolve`,
        label: '标记已读',
        value: {
          action: 'wb_broadcast_resolve',
          task_id: detail.task.id,
          action_item_id: item.id,
        },
      },
    ];
    return card;
  }

  return card;
}

export function buildWorkbenchBroadcastActionFeedbackCard(input: {
  taskId: string;
  actionItemId: string;
  statusText: string;
}): InteractiveCard | null {
  const detail = getWorkbenchTaskDetail(input.taskId, { sync: false });
  if (!detail) return null;

  const item = detail.action_items.find(
    (entry) => entry.id === input.actionItemId,
  );
  if (!item) return null;

  return {
    header: {
      title: `工作台待办：${item.title}`,
      color: headerColorForTaskState(detail.task.task_state),
    },
    body: buildWorkbenchBroadcastBody({
      taskTitle: detail.task.title,
      service: detail.task.service,
      taskState: detail.task.task_state,
      workflowStatusLabel: detail.task.workflow_status_label,
      workflowStageLabel: detail.task.workflow_stage_label,
      description: item.body,
      extraLines: [`处理状态: ${input.statusText}`],
    }),
  };
}
