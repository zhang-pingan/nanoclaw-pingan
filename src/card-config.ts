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
  for (const action of card.actions || []) {
    if (!action.id?.trim()) {
      errors.push(`${cardKey}.actions[].id is required`);
      continue;
    }
    if (actionIds.has(action.id)) {
      errors.push(`${cardKey}.actions action id "${action.id}" is duplicated`);
    }
    actionIds.add(action.id);
  }

  if (card.form) {
    if (!card.form.name?.trim()) {
      errors.push(`${cardKey}.form.name is required`);
    }
    if (!card.form.submit_action?.id?.trim()) {
      errors.push(`${cardKey}.form.submit_action.id is required`);
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

  return errors;
}
