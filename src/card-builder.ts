import { CardButton, CardForm, InteractiveCard } from './types.js';
import { CardActionConfig, CardConfig } from './card-config.js';
import { renderTemplate, TemplateVars } from './workflow-config.js';

export interface CardBuildContext {
  workflowId?: string;
  groupFolder?: string;
  vars: TemplateVars;
  roleFolders?: Record<string, string>;
}

const DEFAULT_ACTIONS: Record<
  string,
  { label: string; type?: 'primary' | 'danger' | 'default' }
> = {
  approve: { label: '✅ 确认执行', type: 'primary' },
  approve_dev: { label: '✅ 进入开发', type: 'primary' },
  skip: { label: '⏭ 跳过此节点' },
  pause: { label: '⏸ 暂缓' },
  cancel: { label: '❌ 取消流程', type: 'danger' },
  resume: { label: '▶ 继续', type: 'primary' },
  request_revision: { label: '✏️ 提交修改' },
  submit_access_token: { label: '🔐 提交 Token 并开始测试', type: 'primary' },
};

function buildButton(
  action: CardActionConfig,
  context: CardBuildContext,
): CardButton {
  const fallback = DEFAULT_ACTIONS[action.id] || { label: action.id };

  return {
    id: action.id,
    label: action.label || fallback.label,
    type: action.type || fallback.type,
    value: {
      ...(action.value || {}),
      ...(context.workflowId ? { workflow_id: context.workflowId } : {}),
      ...(context.groupFolder ? { group_folder: context.groupFolder } : {}),
      action: action.id,
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
