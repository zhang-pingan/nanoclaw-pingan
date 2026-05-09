import type { CardButton, InteractiveCard } from './types.js';
import { buildHumanInputCard } from './human-input-card.js';
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

function mapBroadcastActionValue(
  value: Record<string, string>,
): Record<string, string> {
  if (value.action === 'workflow_interrupt_resume') {
    const resumeAction = value.resume_action;
    return {
      ...value,
      action:
        resumeAction === 'revise'
          ? 'wb_broadcast_revise'
          : resumeAction === 'submit'
            ? 'wb_broadcast_submit'
            : resumeAction === 'skip'
              ? 'wb_broadcast_skip'
              : 'wb_broadcast_confirm',
    };
  }
  if (value.action === 'ask_question_answer') {
    return {
      ...value,
      action: 'wb_broadcast_reply',
      ...(value.answer ? { reply_text: value.answer } : {}),
    };
  }
  if (value.action === 'ask_question_skip') {
    return {
      ...value,
      action: 'wb_broadcast_skip_reply',
    };
  }
  if (value.action === 'workbench_action_item') {
    return {
      ...value,
      action: 'wb_broadcast_resolve',
    };
  }
  return value;
}

function mapBroadcastButton(button: CardButton): CardButton {
  return {
    ...button,
    value: mapBroadcastActionValue(button.value),
  };
}

function mapHumanInputCardForBroadcast(card: InteractiveCard): InteractiveCard {
  return {
    ...card,
    buttons: card.buttons?.map(mapBroadcastButton),
    form: card.form
      ? {
          ...card.form,
          inputs: card.form.inputs.map((input) =>
            input.name === 'answer'
              ? { ...input, name: 'reply_text' }
              : input,
          ),
          submitButton: mapBroadcastButton(card.form.submitButton),
        }
      : undefined,
    sections: card.sections?.map((section) => ({
      ...section,
      buttons: section.buttons?.map(mapBroadcastButton),
    })),
  };
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
  } else if (item.source_type === 'workflow_interrupt') {
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

  const humanInputCard = mapHumanInputCardForBroadcast(
    buildHumanInputCard(item, detail.task),
  );
  return {
    ...humanInputCard,
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
      description: humanInputCard.body || item.body,
      extraLines:
        typeof item.extra?.validation_error === 'string' &&
        item.extra.validation_error.trim()
          ? [`校验错误: ${item.extra.validation_error.trim()}`]
          : undefined,
    }),
  };
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
