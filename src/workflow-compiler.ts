import {
  WorkflowDefinition,
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

  if (!definition.key?.trim()) errors.push('definition.key is required');
  if (!definition.name?.trim()) errors.push('definition.name is required');

  for (const [entryKey, entry] of Object.entries(definition.entry_points)) {
    if (!stateNames.has(entry.state)) {
      errors.push(
        `${definition.key}.entry_points.${entryKey}.state "${entry.state}" does not exist`,
      );
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
