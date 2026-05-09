import {
  WorkflowDefinition,
  WorkflowCreateForm,
  WorkflowDefinitionState,
  WorkflowDefinitionTransition,
  WorkflowDefinitionEvaluatorRef,
  WorkflowDefinitionHandoff,
  WorkflowDefinitionJsonSchemaRef,
  WorkflowDefinitionRetryPolicy,
  WorkflowDefinitionTimeoutPolicy,
} from './workflow-definition.js';

export interface CompiledWorkflowTransition {
  target: string;
  role?: string;
  skill?: string;
  task_template?: string;
  handoff?: WorkflowDefinitionHandoff;
  increment_round?: boolean;
  notify?: string;
  card?: string;
}

export interface CompiledWorkflowState {
  type: 'delegation' | 'interrupt' | 'terminal' | 'system';
  role?: string;
  skill?: string;
  task_template?: string;
  handoff?: WorkflowDefinitionHandoff;
  card?: string;
  label?: string;
  description?: string;
  retry_policy?: WorkflowDefinitionRetryPolicy;
  timeout_policy?: WorkflowDefinitionTimeoutPolicy;
  artifact_contract?: { ref: string };
  evaluator?: WorkflowDefinitionEvaluatorRef;
  rollback_hint?: { ref: string };
  on_complete?: {
    success: CompiledWorkflowTransition;
    failure: CompiledWorkflowTransition;
  };
  kind?: string;
  title?: string;
  body?: string;
  resume_payload_schema?: WorkflowDefinitionJsonSchemaRef;
  allowed_actions?: string[];
  allowed_channels?: Array<'web' | 'feishu' | 'assistant'>;
  on_resume?: Record<string, CompiledWorkflowTransition>;
  on_cancel?: CompiledWorkflowTransition;
  on_expire?: CompiledWorkflowTransition;
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
    handoff: transition.delegate?.handoff,
    increment_round: transition.effects?.increment_round,
    notify: transition.notify?.template,
    card: transition.card?.ref,
  };
}

function compileState(state: WorkflowDefinitionState): CompiledWorkflowState {
  const base = {
    label: state.label,
    description: state.description,
    retry_policy: state.retry_policy,
    timeout_policy: state.timeout_policy,
    artifact_contract: state.artifact_contract,
    evaluator: state.evaluator,
    rollback_hint: state.rollback_hint,
  };

  if (state.type === 'delegation') {
    return {
      ...base,
      type: 'delegation',
      role: state.delegate.role,
      skill: state.delegate.skill,
      task_template: state.delegate.task_template,
      handoff: state.delegate.handoff,
      on_complete: {
        success: compileTransition(state.on_complete.success),
        failure: compileTransition(state.on_complete.failure),
      },
    };
  }

  if (state.type === 'interrupt') {
    return {
      ...base,
      type: 'interrupt',
      kind: state.kind,
      card: state.card?.ref,
      title: state.title,
      body: state.body,
      resume_payload_schema: state.resume_payload_schema,
      allowed_actions: state.allowed_actions,
      allowed_channels: state.allowed_channels,
      on_resume: Object.fromEntries(
        Object.entries(state.on_resume).map(([action, transition]) => [
          action,
          compileTransition(transition),
        ]),
      ),
      on_cancel: state.on_cancel
        ? compileTransition(state.on_cancel)
        : undefined,
      on_expire: state.on_expire
        ? compileTransition(state.on_expire)
        : undefined,
    };
  }

  if (state.type === 'system') {
    return {
      ...base,
      type: 'system',
      on_complete: state.on_complete
        ? {
            success: compileTransition(state.on_complete.success),
            failure: state.on_complete.failure
              ? compileTransition(state.on_complete.failure)
              : compileTransition(state.on_complete.success),
          }
        : undefined,
    };
  }

  return {
    ...base,
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
        if (
          ![
            'text',
            'textarea',
            'choice',
            'requirement_select',
            'file_uploads',
          ].includes(field.type)
        ) {
          errors.push(`${fieldPath}.type "${field.type}" is invalid`);
        }
        if (
          field.required !== undefined &&
          typeof field.required !== 'boolean'
        ) {
          errors.push(`${fieldPath}.required must be a boolean`);
        }
        if (
          field.type === 'choice' &&
          (!Array.isArray(field.options) || field.options.length === 0)
        ) {
          errors.push(
            `${fieldPath}.options must contain at least one item for choice fields`,
          );
        }
        const visibleWhen = field.visible_when;
        if (visibleWhen?.entry_points) {
          for (const entryPoint of visibleWhen.entry_points) {
            if (!entryPointNames.has(entryPoint)) {
              errors.push(
                `${fieldPath}.visible_when.entry_points contains unknown entry point "${entryPoint}"`,
              );
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
  }

  for (const [stateKey, state] of Object.entries(definition.states)) {
    if ((state as { type?: string }).type === 'confirmation') {
      errors.push(
        `${definition.key}.states.${stateKey}.type "confirmation" is no longer supported; use "interrupt"`,
      );
      continue;
    }

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

    if (state.type === 'system' && state.on_complete) {
      for (const [outcome, transition] of Object.entries(state.on_complete)) {
        if (!transition) continue;
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

    if (state.type === 'interrupt') {
      if (!state.kind?.trim()) {
        errors.push(`${definition.key}.states.${stateKey}.kind is required`);
      }
      if (
        !Array.isArray(state.allowed_actions) ||
        state.allowed_actions.length === 0
      ) {
        errors.push(
          `${definition.key}.states.${stateKey}.allowed_actions must contain at least one action`,
        );
      }
      if (!state.on_resume || Object.keys(state.on_resume).length === 0) {
        errors.push(
          `${definition.key}.states.${stateKey}.on_resume must contain at least one transition`,
        );
      }
      if (!state.resume_payload_schema) {
        errors.push(
          `${definition.key}.states.${stateKey}.resume_payload_schema is required`,
        );
      }
      for (const action of state.allowed_actions || []) {
        if (!state.on_resume?.[action]) {
          errors.push(
            `${definition.key}.states.${stateKey}.on_resume.${action} is required for allowed action "${action}"`,
          );
        }
      }
      for (const [action, transition] of Object.entries(
        state.on_resume || {},
      )) {
        if (!stateNames.has(transition.target)) {
          errors.push(
            `${definition.key}.states.${stateKey}.on_resume.${action}.target "${transition.target}" does not exist`,
          );
        }
        if (transition.delegate && !roleNames.has(transition.delegate.role)) {
          errors.push(
            `${definition.key}.states.${stateKey}.on_resume.${action}.delegate.role "${transition.delegate.role}" not defined in roles`,
          );
        }
      }
      for (const [fieldName, transition] of [
        ['on_cancel', state.on_cancel],
        ['on_expire', state.on_expire],
      ] as const) {
        if (!transition) continue;
        if (!stateNames.has(transition.target)) {
          errors.push(
            `${definition.key}.states.${stateKey}.${fieldName}.target "${transition.target}" does not exist`,
          );
        }
        if (transition.delegate && !roleNames.has(transition.delegate.role)) {
          errors.push(
            `${definition.key}.states.${stateKey}.${fieldName}.delegate.role "${transition.delegate.role}" not defined in roles`,
          );
        }
      }
    }

    const evaluatorTransitions = state.evaluator
      ? {
          on_pass: state.evaluator.on_pass,
          on_needs_revision: state.evaluator.on_needs_revision,
          on_fail: state.evaluator.on_fail,
          on_pending: state.evaluator.on_pending,
        }
      : {};
    for (const [fieldName, transition] of Object.entries(
      evaluatorTransitions,
    )) {
      if (!transition) continue;
      if (!stateNames.has(transition.target)) {
        errors.push(
          `${definition.key}.states.${stateKey}.evaluator.${fieldName}.target "${transition.target}" does not exist`,
        );
      }
      if (transition.delegate && !roleNames.has(transition.delegate.role)) {
        errors.push(
          `${definition.key}.states.${stateKey}.evaluator.${fieldName}.delegate.role "${transition.delegate.role}" not defined in roles`,
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
