import type { InteractiveCard } from './types.js';
import { getWorkbenchTaskDetail } from './workbench.js';

function headerColorForTaskState(
  taskState: 'running' | 'success' | 'failed' | 'cancelled',
): InteractiveCard['header']['color'] {
  if (taskState === 'success') return 'green';
  if (taskState === 'failed') return 'red';
  if (taskState === 'cancelled') return 'grey';
  return 'orange';
}

export function buildWorkbenchBroadcastResolvedText(input: {
  taskId: string;
  actionItemId: string;
  nextStatus: string;
}): string | null {
  const detail = getWorkbenchTaskDetail(input.taskId);
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

export function buildWorkbenchBroadcastCard(input: {
  taskId: string;
  actionItemId: string;
}): InteractiveCard | null {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return null;

  const item = detail.action_items.find((entry) => entry.id === input.actionItemId);
  if (!item || item.status !== 'pending') return null;

  const card: InteractiveCard = {
    header: {
      title: `工作台待办：${item.title}`,
      color: headerColorForTaskState(detail.task.task_state),
    },
    body: [
      `任务: ${detail.task.title}`,
      `服务: ${detail.task.service}`,
      `任务状态: ${detail.task.task_state}`,
      `流程状态: ${detail.task.workflow_status_label}`,
      `当前阶段: ${detail.task.workflow_stage_label}`,
      item.body ? `说明: ${item.body}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };

  if (item.source_type === 'workflow') {
    const buttons = [];
    if (item.action_mode === 'approve_only' || item.action_mode === 'approve_or_revise') {
      buttons.push({
        id: `${item.id}-confirm`,
        label: '确认',
        type: 'primary' as const,
        value: {
          action: 'wb_broadcast_confirm',
          task_id: detail.task.id,
          action_item_id: item.id,
        },
      });
    }
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
          label: '提交修改意见',
          type: 'danger',
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
          label: '提交并继续',
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
    card.form = {
      name: `wb-reply-${item.id}`,
      inputs: [
        {
          name: 'reply_text',
          type: 'textarea',
          placeholder: '输入答复内容',
          required: true,
        },
      ],
      submitButton: {
        id: `${item.id}-reply`,
        label: '提交答复',
        type: 'primary',
        value: {
          action: 'wb_broadcast_reply',
          task_id: detail.task.id,
          action_item_id: item.id,
        },
      },
    };
    card.buttons = [
      {
        id: `${item.id}-skip`,
        label: '跳过',
        value: {
          action: 'wb_broadcast_skip_reply',
          task_id: detail.task.id,
          action_item_id: item.id,
        },
      },
    ];
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
