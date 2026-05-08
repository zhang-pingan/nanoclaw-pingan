export type CardPattern =
  | 'info_actions'
  | 'confirm_revise'
  | 'form_submit'
  | 'section_list';

export type CardHeaderColor =
  | 'blue'
  | 'green'
  | 'red'
  | 'orange'
  | 'purple'
  | 'grey';

export interface CardActionConfig {
  id: string;
  label?: string;
  type?: 'primary' | 'danger' | 'default';
  value?: Record<string, string>;
  action_kind?: 'interrupt_resume' | 'workflow_control' | 'external_link';
  resume_action?: string;
  workflow_control_action?:
    | 'pause_workflow'
    | 'cancel_workflow'
    | 'retry_stage'
    | 'return_to_stage';
  url?: string;
}

export interface CardFieldOption {
  value: string;
  label?: string;
}

export interface CardFieldConfig {
  name: string;
  label?: string;
  type: 'text' | 'textarea' | 'number' | 'integer' | 'boolean' | 'enum';
  placeholder?: string;
  required?: boolean;
  options?: CardFieldOption[];
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
}

export interface CardFormConfig {
  name: string;
  submit_action: CardActionConfig;
  fields: CardFieldConfig[];
}

export interface CardSectionConfig {
  body_template: string;
  actions?: CardActionConfig[];
}

export interface CardConfig {
  pattern: CardPattern;
  header: {
    title_template: string;
    color?: CardHeaderColor;
  };
  body_template?: string;
  actions?: CardActionConfig[];
  form?: CardFormConfig;
  sections?: CardSectionConfig[];
}

export function validateCardConfig(
  cardKey: string,
  card: CardConfig,
): string[] {
  const errors: string[] = [];

  if (!card.pattern) {
    errors.push(`${cardKey}.pattern is required`);
  }

  if (!card.header?.title_template?.trim()) {
    errors.push(`${cardKey}.header.title_template is required`);
  }

  const actionIds = new Set<string>();
  const validateAction = (path: string, action: CardActionConfig): void => {
    if (!action.id?.trim()) {
      errors.push(`${path}.id is required`);
      return;
    }
    if (actionIds.has(action.id)) {
      errors.push(`${cardKey}.actions action id "${action.id}" is duplicated`);
    }
    actionIds.add(action.id);
    if (
      action.action_kind &&
      !['interrupt_resume', 'workflow_control', 'external_link'].includes(
        action.action_kind,
      )
    ) {
      errors.push(`${path}.action_kind "${action.action_kind}" is invalid`);
    }
    if (action.action_kind === 'interrupt_resume' && !action.resume_action) {
      errors.push(`${path}.resume_action is required for interrupt_resume`);
    }
    if (
      action.action_kind === 'workflow_control' &&
      !action.workflow_control_action
    ) {
      errors.push(
        `${path}.workflow_control_action is required for workflow_control`,
      );
    }
    if (action.action_kind === 'external_link' && !action.url) {
      errors.push(`${path}.url is required for external_link`);
    }
  };

  for (const [index, action] of (card.actions || []).entries()) {
    validateAction(`${cardKey}.actions[${index}]`, action);
  }

  if (card.form) {
    if (!card.form.name?.trim()) {
      errors.push(`${cardKey}.form.name is required`);
    }
    if (!card.form.submit_action?.id?.trim()) {
      errors.push(`${cardKey}.form.submit_action.id is required`);
    } else {
      validateAction(`${cardKey}.form.submit_action`, card.form.submit_action);
    }
    const fieldNames = new Set<string>();
    for (const field of card.form.fields || []) {
      if (!field.name?.trim()) {
        errors.push(`${cardKey}.form.fields[].name is required`);
        continue;
      }
      if (fieldNames.has(field.name)) {
        errors.push(`${cardKey}.form field "${field.name}" is duplicated`);
      }
      fieldNames.add(field.name);
      if (field.type === 'enum' && (!field.options || field.options.length === 0)) {
        errors.push(`${cardKey}.form field "${field.name}" requires options for enum type`);
      }
    }
  }

  if (card.pattern === 'form_submit' && !card.form) {
    errors.push(`${cardKey}.form is required for pattern=form_submit`);
  }

  if (card.pattern === 'confirm_revise' && !card.form) {
    errors.push(`${cardKey}.form is required for pattern=confirm_revise`);
  }

  if (card.pattern === 'section_list' && (!card.sections || card.sections.length === 0)) {
    errors.push(`${cardKey}.sections is required for pattern=section_list`);
  }

  for (const [sectionIndex, section] of (card.sections || []).entries()) {
    for (const [actionIndex, action] of (section.actions || []).entries()) {
      validateAction(
        `${cardKey}.sections[${sectionIndex}].actions[${actionIndex}]`,
        action,
      );
    }
  }

  return errors;
}
