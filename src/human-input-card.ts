import { getWorkflow, getWorkflowInterrupt } from './db.js';
import { buildInteractiveCard } from './card-builder.js';
import { logger } from './logger.js';
import type {
  AskQuestionField,
  AskQuestionItem,
  CardButton,
  CardInput,
  InteractiveCard,
  Workflow,
  WorkflowInterruptActorChannel,
} from './types.js';
import type { WorkbenchActionItem, WorkbenchTaskItem } from './workbench.js';
import {
  getCardConfig,
  getWorkflowTypeConfig,
  renderTemplate,
  type TemplateVars,
} from './workflow-config.js';
import { WORKFLOW_CONTEXT_KEYS } from './workflow-context.js';
import { getDeliverableFileNameForRole } from './workflow-artifacts.js';
import {
  asJsonObject,
  schemaInputs,
  stringArray,
  type JsonObject,
} from './schema-card.js';

const ASK_ACTION_ANSWER = 'ask_question_answer';
const ASK_ACTION_SKIP = 'ask_question_skip';

function parseJsonObject(
  raw: string | null | undefined,
): JsonObject | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function channelArray(value: unknown): WorkflowInterruptActorChannel[] {
  return stringArray(value).filter(
    (item): item is WorkflowInterruptActorChannel =>
      item === 'web' ||
      item === 'feishu' ||
      item === 'assistant' ||
      item === 'system',
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case 'approve':
      return '确认';
    case 'reject':
      return '拒绝';
    case 'revise':
      return '提交修改';
    case 'submit':
      return '提交';
    case 'resume':
      return '继续';
    case 'skip':
      return '跳过';
    case 'cancel':
      return '取消';
    default:
      return action;
  }
}

function actionButtonType(action: string): CardButton['type'] {
  if (action === 'approve' || action === 'submit' || action === 'resume') {
    return 'primary';
  }
  if (action === 'reject' || action === 'cancel') return 'danger';
  return undefined;
}

function baseWorkbenchValue(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): Record<string, string> {
  return {
    action: 'workbench_action_item',
    task_id: task.id,
    action_item_id: item.id,
  };
}

function baseWorkflowValue(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): Record<string, string> {
  const workflowId =
    typeof item.extra?.workflowId === 'string'
      ? item.extra.workflowId
      : task.id.startsWith('wb-')
        ? task.id.slice(3)
        : task.id;
  return {
    action: 'workflow_interrupt_resume',
    workflow_id: workflowId,
    interrupt_id:
      typeof item.extra?.interruptId === 'string'
        ? item.extra.interruptId
        : String(item.source_ref_id || ''),
  };
}

function withResumeAction(
  base: Record<string, string>,
  resumeAction: string,
): Record<string, string> {
  return {
    ...base,
    resume_action: resumeAction,
  };
}

function buildTemplateVars(task: WorkbenchTaskItem): TemplateVars {
  const context = task.context || {};
  const workflowConfig = task.workflow_type
    ? getWorkflowTypeConfig(task.workflow_type)
    : null;
  const deliverableFile = (role: string) =>
    getDeliverableFileNameForRole(role, workflowConfig?.roles);
  const contextVars = Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? value
        : value === undefined || value === null
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value),
    ]),
  ) as TemplateVars;
  return {
    ...contextVars,
    name: task.title,
    workflow_type: task.workflow_type,
    service: task.service,
    main_branch:
      typeof context[WORKFLOW_CONTEXT_KEYS.mainBranch] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.mainBranch] as string)
        : '',
    work_branch:
      typeof context[WORKFLOW_CONTEXT_KEYS.workBranch] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.workBranch] as string)
        : '',
    staging_base_branch:
      typeof context[WORKFLOW_CONTEXT_KEYS.stagingBaseBranch] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.stagingBaseBranch] as string)
        : '',
    staging_work_branch:
      typeof context[WORKFLOW_CONTEXT_KEYS.stagingWorkBranch] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.stagingWorkBranch] as string)
        : '',
    access_token:
      typeof context[WORKFLOW_CONTEXT_KEYS.accessToken] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.accessToken] as string)
        : '',
    id: task.id.startsWith('wb-') ? task.id.slice(3) : task.id,
    round: task.round,
    deliverable:
      typeof context[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.deliverable] as string)
        : 'N/A',
    requirement_description:
      typeof context[WORKFLOW_CONTEXT_KEYS.requirementDescription] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.requirementDescription] as string)
        : task.title,
    requirement_files: Array.isArray(
      context[WORKFLOW_CONTEXT_KEYS.requirementFiles],
    )
      ? (context[WORKFLOW_CONTEXT_KEYS.requirementFiles] as unknown[])
          .filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          )
          .map((item) => `- ${item}`)
          .join('\n') || '无'
      : '无',
    plan_doc: `/workspace/projects/${task.service}/iteration/${
      typeof context[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.deliverable] as string)
        : ''
    }/${deliverableFile('planner')}`,
    dev_doc: `/workspace/projects/${task.service}/iteration/${
      typeof context[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.deliverable] as string)
        : ''
    }/${deliverableFile('dev')}`,
    test_doc: `/workspace/projects/${task.service}/iteration/${
      typeof context[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
        ? (context[WORKFLOW_CONTEXT_KEYS.deliverable] as string)
        : ''
    }/${deliverableFile('test')}`,
    delegation_result: '',
    result_summary: '',
    revision_text: '',
  };
}

function getWorkflowForTask(task: WorkbenchTaskItem): Workflow | undefined {
  return getWorkflow(task.id.startsWith('wb-') ? task.id.slice(3) : task.id);
}

function renderWorkflowBodyFallback(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): string {
  const workflow =
    (typeof item.extra?.workflowId === 'string'
      ? getWorkflow(item.extra.workflowId)
      : undefined) || getWorkflowForTask(task);
  const state = workflow
    ? getWorkflowTypeConfig(workflow.workflow_type)?.states[workflow.status]
    : undefined;
  const cardConfig =
    workflow && state?.card
      ? getCardConfig(workflow.workflow_type, state.card)
      : undefined;
  if (cardConfig?.body_template) {
    return renderTemplate(cardConfig.body_template, buildTemplateVars(task));
  }
  return item.body || '';
}

function buildWorkflowCardFromDsl(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): InteractiveCard | null {
  const interruptId =
    typeof item.extra?.interruptId === 'string'
      ? item.extra.interruptId
      : item.source_ref_id;
  const interrupt = interruptId ? getWorkflowInterrupt(interruptId) : undefined;
  const workflow = interrupt
    ? getWorkflow(interrupt.workflow_id)
    : getWorkflowForTask(task);
  if (!workflow) return null;
  const state = getWorkflowTypeConfig(workflow.workflow_type)?.states[
    interrupt?.state_key || item.stage_key || workflow.status
  ];
  if (!state?.card) return null;
  const cardConfig = getCardConfig(workflow.workflow_type, state.card);
  if (!cardConfig) return null;
  const payloadSchema =
    parseJsonObject(interrupt?.resume_payload_schema_json) ||
    (item.extra?.payloadSchema &&
    typeof item.extra.payloadSchema === 'object' &&
    !Array.isArray(item.extra.payloadSchema)
      ? asJsonObject(item.extra.payloadSchema)
      : undefined);
  try {
    const card = buildInteractiveCard(cardConfig, {
      workflowId: workflow.id,
      interruptId: interrupt?.id || interruptId || undefined,
      allowedActions: stringArray(
        interrupt
          ? JSON.parse(interrupt.allowed_actions_json)
          : item.extra?.allowedActions,
      ),
      payloadSchema,
      vars: buildTemplateVars(task),
    });
    card.allowed_channels = interrupt
      ? channelArray(interrupt.allowed_channels_json)
      : channelArray(item.extra?.allowedChannels);
    return card;
  } catch (err) {
    logger.warn(
      {
        err,
        taskId: task.id,
        actionItemId: item.id,
        workflowId: workflow.id,
        cardKey: state.card,
      },
      'Failed to build workflow card from DSL; falling back to default human input card',
    );
    return null;
  }
}

function buildDefaultWorkflowCard(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): InteractiveCard {
  const actions = stringArray(item.extra?.allowedActions);
  const payloadSchema =
    item.extra?.payloadSchema &&
    typeof item.extra.payloadSchema === 'object' &&
    !Array.isArray(item.extra.payloadSchema)
      ? asJsonObject(item.extra.payloadSchema)
      : undefined;
  const base = baseWorkflowValue(item, task);
  const buttons: CardButton[] = actions
    .filter((action) => !['revise', 'submit'].includes(action))
    .map((action) => ({
      id: `${item.id}-${action}`,
      label: actionLabel(action),
      type: actionButtonType(action),
      value: withResumeAction(base, action),
    }));
  const inputs = schemaInputs(payloadSchema);
  const formAction =
    actions.find((action) => ['submit', 'revise'].includes(action)) ||
    (inputs.length > 0
      ? actions.find((action) => !['skip', 'cancel', 'reject'].includes(action))
      : undefined);
  const card: InteractiveCard = {
    header: {
      title: item.title,
      color: item.item_type === 'credential' ? 'orange' : 'blue',
    },
    body: renderWorkflowBodyFallback(item, task),
    buttons: buttons.length > 0 ? buttons : undefined,
    allowed_channels: channelArray(item.extra?.allowedChannels),
  };
  if (formAction) {
    card.form = {
      name: `human-input-${item.id}`,
      inputs:
        inputs.length > 0
          ? inputs
          : [
              {
                name: formAction === 'revise' ? 'revision_text' : 'reply_text',
                type: 'textarea',
                placeholder:
                  formAction === 'revise' ? '输入修改意见' : '输入内容',
                required: true,
              },
            ],
      submitButton: {
        id: `${item.id}-${formAction}`,
        label: actionLabel(formAction),
        type: actionButtonType(formAction),
        value: withResumeAction(base, formAction),
      },
    };
  }
  return card;
}

function currentAskQuestion(item: WorkbenchActionItem): AskQuestionItem | null {
  const current = item.extra?.current_question;
  if (current && typeof current === 'object') return current as AskQuestionItem;
  const questions = item.extra?.questions;
  return Array.isArray(questions) && questions[0]
    ? (questions[0] as AskQuestionItem)
    : null;
}

function askFieldInputType(field: AskQuestionField): CardInput['type'] {
  if (field.enum && field.enum.length > 0) return 'enum';
  if (field.type === 'number' || field.type === 'integer') {
    return field.type;
  }
  if (field.type === 'boolean') return 'checkbox';
  return 'text';
}

function buildAskCard(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): InteractiveCard {
  const requestId = item.source_ref_id || String(item.extra?.request_id || '');
  const question = currentAskQuestion(item);
  const groupFolder = item.group_folder || '';
  const answerValue = {
    action: ASK_ACTION_ANSWER,
    group_folder: groupFolder,
    request_id: requestId,
    task_id: task.id,
    action_item_id: item.id,
    ...(question?.id ? { question_id: question.id } : {}),
  };
  const skipValue = {
    action: ASK_ACTION_SKIP,
    group_folder: groupFolder,
    request_id: requestId,
    task_id: task.id,
    action_item_id: item.id,
    ...(question?.id ? { question_id: question.id } : {}),
  };
  const body = [
    question?.question || item.body,
    typeof item.extra?.validation_error === 'string' &&
    item.extra.validation_error.trim()
      ? `校验错误: ${item.extra.validation_error.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const card: InteractiveCard = {
    header: {
      title: item.title,
      color: item.source_type === 'request_human_input' ? 'purple' : 'blue',
    },
    body,
    buttons: [
      ...(question &&
      !question.multi_select &&
      !question.fields?.length &&
      Array.isArray(question.options)
        ? question.options.map((option, index) => ({
            id: `${item.id}-answer-${index}`,
            label: option.label,
            value: { ...answerValue, answer: option.label },
          }))
        : []),
      {
        id: `${item.id}-skip`,
        label: '跳过',
        value: skipValue,
      },
    ],
  };

  if (question?.fields?.length) {
    const validationErrors =
      item.extra?.validation_errors &&
      typeof item.extra.validation_errors === 'object'
        ? (item.extra.validation_errors as Record<string, string>)
        : undefined;
    card.form = {
      name: `human-input-${requestId || item.id}`,
      inputs: question.fields.map((field) => ({
        name: field.id,
        placeholder: field.description || field.label,
        type: askFieldInputType(field),
        options: field.enum?.map((option) => ({
          value: option.value,
          label: option.label,
        })),
        required: field.required === true,
        min: field.min,
        max: field.max,
        min_length: field.min_length,
        max_length: field.max_length,
        format: field.format,
        error: validationErrors?.[field.id],
      })),
      submitButton: {
        id: `${item.id}-submit-answer`,
        label: '提交',
        type: 'primary',
        value: answerValue,
      },
    };
    return card;
  }

  if (question?.multi_select || item.replyable) {
    card.form = {
      name: `human-input-${requestId || item.id}`,
      inputs: [
        {
          name: 'answer',
          type: 'textarea',
          placeholder:
            question?.multi_select === true
              ? '输入多个选项或自定义文本，逗号分隔'
              : question?.options?.length
                ? '输入自定义答复'
                : '输入答复内容',
          required: true,
        },
      ],
      submitButton: {
        id: `${item.id}-submit-answer`,
        label: question?.options?.length ? '提交自定义答复' : '提交答复',
        type: 'primary',
        value: answerValue,
      },
    };
  }

  return card;
}

function buildSendMessageCard(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): InteractiveCard {
  return {
    header: { title: item.title, color: 'grey' },
    body: item.body,
    buttons: [
      {
        id: `${item.id}-resolve`,
        label: '标记已读',
        value: {
          ...baseWorkbenchValue(item, task),
          action: 'workbench_action_item',
          workbench_action: 'resolve',
        },
      },
    ],
  };
}

export function buildHumanInputCard(
  item: WorkbenchActionItem,
  task: WorkbenchTaskItem,
): InteractiveCard {
  if (item.source_type === 'workflow_interrupt') {
    return (
      buildWorkflowCardFromDsl(item, task) ||
      buildDefaultWorkflowCard(item, task)
    );
  }
  if (
    item.source_type === 'ask_user_question' ||
    item.source_type === 'request_human_input'
  ) {
    return buildAskCard(item, task);
  }
  return buildSendMessageCard(item, task);
}
