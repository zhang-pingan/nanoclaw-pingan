import {
  WorkflowDefinition,
  WorkflowCreateForm,
  WorkflowDefinitionState,
  WorkflowDefinitionTransition,
} from './workflow-definition.js';

export interface CompiledWorkflowTransition {
  target: string;
  role?: string;
  skill?: string;
  task_template?: string;
  increment_round?: boolean;
  notify?: string;
  card?: string;
}

export interface CompiledWorkflowState {
  type: 'delegation' | 'confirmation' | 'terminal' | 'system';
  role?: string;
  skill?: string;
  task_template?: string;
  card?: string;
  on_complete?: {
    success: CompiledWorkflowTransition;
    failure: CompiledWorkflowTransition;
  };
  on_approve?: CompiledWorkflowTransition;
  on_revise?: CompiledWorkflowTransition;
}

export interface CompiledWorkflowConfig {
  name: string;
  roles: Record<string, { channels: Record<string, string> }>;
  entry_points: Record<
    string,
    {
      state: string;
      requires_deliverable?: boolean;
      deliverable_role?: string;
    }
  >;
  states: Record<string, CompiledWorkflowState>;
  status_labels: Record<string, string>;
  create_form?: WorkflowCreateForm;
}

function compileTransition(
  transition: WorkflowDefinitionTransition,
): CompiledWorkflowTransition {
  return {
    target: transition.target,
    role: transition.delegate?.role,
    skill: transition.delegate?.skill,
    task_template: transition.delegate?.task_template,
    increment_round: transition.effects?.increment_round,
    notify: transition.notify?.template,
    card: transition.card?.ref,
  };
}

function compileState(
  state: WorkflowDefinitionState,
): CompiledWorkflowState {
  if (state.type === 'delegation') {
    return {
      type: 'delegation',
      role: state.delegate.role,
      skill: state.delegate.skill,
      task_template: state.delegate.task_template,
      on_complete: {
        success: compileTransition(state.on_complete.success),
        failure: compileTransition(state.on_complete.failure),
      },
    };
  }

  if (state.type === 'confirmation') {
    return {
      type: 'confirmation',
      card: state.card.ref,
      on_approve: state.on_approve
        ? compileTransition(state.on_approve)
        : undefined,
      on_revise: state.on_revise
        ? compileTransition(state.on_revise)
        : undefined,
    };
  }

  return {
    type: state.type,
  };
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): string[] {
  const errors: string[] = [];
  const stateNames = new Set(Object.keys(definition.states));
  const roleNames = new Set(Object.keys(definition.roles));
  const entryPointNames = new Set(Object.keys(definition.entry_points));
  const createFieldKeys = new Set<string>();

  if (!definition.key?.trim()) errors.push('definition.key is required');
  if (!definition.name?.trim()) errors.push('definition.name is required');

  for (const [entryKey, entry] of Object.entries(definition.entry_points)) {
    if (!stateNames.has(entry.state)) {
      errors.push(
        `${definition.key}.entry_points.${entryKey}.state "${entry.state}" does not exist`,
      );
    }
  }

  if (definition.create_form) {
    if (!Array.isArray(definition.create_form.fields)) {
      errors.push(`${definition.key}.create_form.fields must be an array`);
    } else {
      for (const [index, field] of definition.create_form.fields.entries()) {
        const fieldPath = `${definition.key}.create_form.fields[${index}]`;
        if (!field.key?.trim()) {
          errors.push(`${fieldPath}.key is required`);
        } else if (createFieldKeys.has(field.key)) {
          errors.push(`${fieldPath}.key "${field.key}" is duplicated`);
        } else {
          createFieldKeys.add(field.key);
        }
        if (!field.label?.trim()) {
          errors.push(`${fieldPath}.label is required`);
        }
        if (!['text', 'textarea', 'choice', 'requirement_select', 'file_uploads'].includes(field.type)) {
          errors.push(`${fieldPath}.type "${field.type}" is invalid`);
        }
        if (field.type === 'choice' && (!Array.isArray(field.options) || field.options.length === 0)) {
          errors.push(`${fieldPath}.options must contain at least one item for choice fields`);
        }
        const visibleWhen = field.visible_when;
        if (visibleWhen?.entry_points) {
          for (const entryPoint of visibleWhen.entry_points) {
            if (!entryPointNames.has(entryPoint)) {
              errors.push(`${fieldPath}.visible_when.entry_points contains unknown entry point "${entryPoint}"`);
            }
          }
        }
      }
      for (const [index, field] of definition.create_form.fields.entries()) {
        const equals = field.visible_when?.equals || {};
        for (const depKey of Object.keys(equals)) {
          if (!createFieldKeys.has(depKey)) {
            errors.push(
              `${definition.key}.create_form.fields[${index}].visible_when.equals references unknown field "${depKey}"`,
            );
          }
        }
      }
    }
    if (definition.create_form.name_field_keys) {
      for (const fieldKey of definition.create_form.name_field_keys) {
        if (!createFieldKeys.has(fieldKey)) {
          errors.push(
            `${definition.key}.create_form.name_field_keys references unknown field "${fieldKey}"`,
          );
        }
      }
    }
  }

  for (const [stateKey, state] of Object.entries(definition.states)) {
    if (state.type === 'delegation') {
      if (!roleNames.has(state.delegate.role)) {
        errors.push(
          `${definition.key}.states.${stateKey}.delegate.role "${state.delegate.role}" not defined in roles`,
        );
      }
      for (const [outcome, transition] of Object.entries(state.on_complete)) {
        if (!stateNames.has(transition.target)) {
          errors.push(
            `${definition.key}.states.${stateKey}.on_complete.${outcome}.target "${transition.target}" does not exist`,
          );
        }
        if (transition.delegate && !roleNames.has(transition.delegate.role)) {
          errors.push(
            `${definition.key}.states.${stateKey}.on_complete.${outcome}.delegate.role "${transition.delegate.role}" not defined in roles`,
          );
        }
      }
    }

    if (state.type === 'confirmation') {
      if (!state.card?.ref?.trim()) {
        errors.push(`${definition.key}.states.${stateKey}.card.ref is required`);
      }
      if (state.on_approve && !stateNames.has(state.on_approve.target)) {
        errors.push(
          `${definition.key}.states.${stateKey}.on_approve.target "${state.on_approve.target}" does not exist`,
        );
      }
      if (state.on_revise && !stateNames.has(state.on_revise.target)) {
        errors.push(
          `${definition.key}.states.${stateKey}.on_revise.target "${state.on_revise.target}" does not exist`,
        );
      }
      if (state.on_approve?.delegate && !roleNames.has(state.on_approve.delegate.role)) {
        errors.push(
          `${definition.key}.states.${stateKey}.on_approve.delegate.role "${state.on_approve.delegate.role}" not defined in roles`,
        );
      }
      if (state.on_revise?.delegate && !roleNames.has(state.on_revise.delegate.role)) {
        errors.push(
          `${definition.key}.states.${stateKey}.on_revise.delegate.role "${state.on_revise.delegate.role}" not defined in roles`,
        );
      }
    }
  }

  return errors;
}

export function compileWorkflowDefinition(
  definition: WorkflowDefinition,
): CompiledWorkflowConfig {
  return {
    name: definition.name,
    roles: Object.fromEntries(
      Object.entries(definition.roles).map(([roleName, role]) => [
        roleName,
        {
          channels: role.channels,
        },
      ]),
    ),
    entry_points: Object.fromEntries(
      Object.entries(definition.entry_points).map(([entryKey, entry]) => [
        entryKey,
        {
          state: entry.state,
          requires_deliverable: entry.requires_deliverable,
          deliverable_role: entry.deliverable_role,
        },
      ]),
    ),
    states: Object.fromEntries(
      Object.entries(definition.states).map(([stateKey, state]) => [
        stateKey,
        compileState(state),
      ]),
    ),
    status_labels: definition.status_labels,
    create_form: definition.create_form,
  };
}

export function compileWorkflowDefinitions(
  definitions: Record<string, WorkflowDefinition>,
): { configs: Record<string, CompiledWorkflowConfig>; errors: string[] } {
  const errors: string[] = [];
  const configs: Record<string, CompiledWorkflowConfig> = {};

  for (const [definitionKey, definition] of Object.entries(definitions)) {
    if (definition.key !== definitionKey) {
      errors.push(
        `workflow definition key mismatch: object key "${definitionKey}" != definition.key "${definition.key}"`,
      );
      continue;
    }

    const definitionErrors = validateWorkflowDefinition(definition);
    if (definitionErrors.length > 0) {
      errors.push(...definitionErrors);
      continue;
    }

    configs[definitionKey] = compileWorkflowDefinition(definition);
  }

  return { configs, errors };
}
