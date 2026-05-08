import { CardButton, CardForm, InteractiveCard } from './types.js';
import { CardActionConfig, CardConfig } from './card-config.js';
import { renderTemplate, TemplateVars } from './workflow-config.js';

export interface CardBuildContext {
  workflowId?: string;
  interruptId?: string;
  allowedActions?: string[];
  payloadSchema?: Record<string, unknown>;
  groupFolder?: string;
  vars: TemplateVars;
  roleFolders?: Record<string, string>;
}

const DEFAULT_ACTIONS: Record<
  string,
  { label: string; type?: 'primary' | 'danger' | 'default' }
> = {
  approve: { label: '✅ 确认执行', type: 'primary' },
  revise: { label: '✏️ 提交修改' },
  submit: { label: '🔐 提交并继续', type: 'primary' },
  skip: { label: '⏭ 跳过此节点' },
  pause: { label: '⏸ 暂缓' },
  cancel: { label: '❌ 取消流程', type: 'danger' },
  resume: { label: '▶ 继续', type: 'primary' },
};

function buildButton(
  action: CardActionConfig,
  context: CardBuildContext,
): CardButton {
  const fallback = DEFAULT_ACTIONS[action.id] || { label: action.id };
  const actionKind = action.action_kind;
  if (actionKind === 'interrupt_resume') {
    if (!context.interruptId) {
      throw new Error(
        `Card action "${action.id}" requires interruptId for interrupt resume`,
      );
    }
    if (
      context.allowedActions &&
      action.resume_action &&
      !context.allowedActions.includes(action.resume_action)
    ) {
      throw new Error(
        `Card action "${action.id}" resume_action "${action.resume_action}" is not allowed by current interrupt`,
      );
    }
  }

  const platformAction =
    actionKind === 'interrupt_resume'
      ? 'workflow_interrupt_resume'
      : actionKind === 'workflow_control'
        ? action.workflow_control_action || action.id
        : action.id;

  return {
    id: action.id,
    label: action.label || fallback.label,
    type: action.type || fallback.type,
    value: {
      ...(action.value || {}),
      ...(context.workflowId ? { workflow_id: context.workflowId } : {}),
      ...(context.interruptId ? { interrupt_id: context.interruptId } : {}),
      ...(action.resume_action ? { resume_action: action.resume_action } : {}),
      ...(context.payloadSchema
        ? { resume_payload_schema: JSON.stringify(context.payloadSchema) }
        : {}),
      ...(context.groupFolder ? { group_folder: context.groupFolder } : {}),
      action: platformAction,
    },
  };
}

export function buildInteractiveCard(
  cardConfig: CardConfig,
  context: CardBuildContext,
): InteractiveCard {
  const headerTitle = renderTemplate(
    cardConfig.header.title_template,
    context.vars,
    context.roleFolders,
  );
  const body = cardConfig.body_template
    ? renderTemplate(cardConfig.body_template, context.vars, context.roleFolders)
    : undefined;
  const buttons = cardConfig.actions?.map((action) =>
    buildButton(action, context),
  );

  let form: CardForm | undefined;
  if (cardConfig.form) {
    form = {
      name: cardConfig.form.name,
      inputs: cardConfig.form.fields.map((field) => ({
        name: field.name,
        placeholder: field.placeholder || field.label || '',
        type: field.type,
        options: field.options,
        required: field.required,
        min: field.min,
        max: field.max,
        min_length: field.min_length,
        max_length: field.max_length,
        format: field.format,
      })),
      submitButton: buildButton(cardConfig.form.submit_action, context),
    };
  }

  return {
    header: {
      title: headerTitle,
      color: cardConfig.header.color || 'blue',
    },
    body,
    buttons: buttons?.length ? buttons : undefined,
    form,
    sections: cardConfig.sections?.map((section) => ({
      body: renderTemplate(section.body_template, context.vars, context.roleFolders),
      buttons: section.actions?.map((action) => buildButton(action, context)),
    })),
  };
}
