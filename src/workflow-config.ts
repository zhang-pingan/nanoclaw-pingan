/**
 * Workflow Configuration — types, loader, template renderer, validator.
 *
 * Workflow type definitions live in container/skills/workflows.json.
 * The engine (workflow.ts) reads them once at init and drives state
 * transitions generically instead of hard-coding each workflow type.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// -------------------------------------------------------
// Config types
// -------------------------------------------------------

export interface StateTransition {
  target: string;
  /** Role to delegate to (for delegation states). */
  role?: string;
  /** Skill name for the delegation. */
  skill?: string;
  /** Task template with {{var}} placeholders. */
  task_template?: string;
  /** Increment the workflow round counter. */
  increment_round?: boolean;
  /** Notification template sent to main group. */
  notify?: string;
  /** Card key to send after transition (references cards map). */
  card?: string;
}

export interface StateConfig {
  /** State type: delegation, confirmation, terminal, system. */
  type: 'delegation' | 'confirmation' | 'terminal' | 'system';

  // --- delegation fields ---
  role?: string;
  skill?: string;
  task_template?: string;
  on_complete?: {
    success: StateTransition;
    failure: StateTransition;
  };

  // --- confirmation fields ---
  card?: string;
  on_approve?: StateTransition;
  on_revise?: StateTransition;
}

export interface RoleConfig {
  /** Channel → group folder mapping, e.g. { feishu: "feishu_plan", web: "web_plan" } */
  channels: Record<string, string>;
}

export interface EntryPointConfig {
  /** Initial state when entering via this entry point. */
  state: string;
  /** Whether the entry point requires an existing deliverable. */
  requires_deliverable?: boolean;
}

export interface CardActionConfig {
  label: string;
  type?: 'primary' | 'danger';
  action: string;
}

export interface CardConfig {
  header_template: string;
  header_color?: string;
  body_template: string;
  actions: string[];
}

export interface WorkflowTypeConfig {
  name: string;
  roles: Record<string, RoleConfig>;
  entry_points: Record<string, EntryPointConfig>;
  states: Record<string, StateConfig>;
  status_labels: Record<string, string>;
  cards: Record<string, CardConfig>;
}

// -------------------------------------------------------
// Loader
// -------------------------------------------------------

let loadedConfigs: Record<string, WorkflowTypeConfig> | null = null;
let lastLoadError: string | null = null;

export function getWorkflowConfigError(): string | null {
  return lastLoadError;
}

export function loadWorkflowConfigs(): Record<
  string,
  WorkflowTypeConfig
> | null {
  const configPath = path.join(
    process.cwd(),
    'container',
    'skills',
    'workflows.json',
  );

  if (!fs.existsSync(configPath)) {
    lastLoadError =
      'Workflow 未启用：未找到 container/skills/workflows.json';
    logger.info(lastLoadError);
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const configs = raw as Record<string, WorkflowTypeConfig>;

    for (const [typeName, config] of Object.entries(configs)) {
      const errors = validateConfig(typeName, config);
      if (errors.length > 0) {
        lastLoadError = `Workflow 配置校验失败 (${typeName}): ${errors.join('; ')}`;
        logger.error({ typeName, errors }, 'Workflow config validation failed');
        return null;
      }
    }

    loadedConfigs = configs;
    lastLoadError = null;
    logger.info({ types: Object.keys(configs) }, 'Workflow configs loaded');
    return configs;
  } catch (err) {
    lastLoadError = `Workflow 未启用：workflows.json 解析失败 — ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, 'Failed to parse workflows.json');
    return null;
  }
}

export function getWorkflowConfigs(): Record<
  string,
  WorkflowTypeConfig
> | null {
  return loadedConfigs;
}

export function getWorkflowTypeConfig(
  type: string,
): WorkflowTypeConfig | undefined {
  return loadedConfigs?.[type];
}

// -------------------------------------------------------
// Template renderer
// -------------------------------------------------------

export interface TemplateVars {
  name?: string;
  service?: string;
  branch?: string;
  id?: string;
  round?: number;
  deliverable?: string;
  delegation_result?: string;
  result_summary?: string;
  revision_text?: string;
  [key: string]: string | number | undefined;
}

/**
 * Render a template string, replacing {{key}} placeholders with values.
 * Also supports {{role_folder:ROLE_NAME}} to insert a role's group folder.
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
  roleFolders?: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+(?::\w+)?)\}\}/g, (_match, key: string) => {
    if (key.startsWith('role_folder:') && roleFolders) {
      const roleName = key.slice('role_folder:'.length);
      return roleFolders[roleName] || '';
    }
    const val = vars[key];
    return val !== undefined ? String(val) : '';
  });
}

// -------------------------------------------------------
// Validator
// -------------------------------------------------------

export function validateConfig(
  typeName: string,
  config: WorkflowTypeConfig,
): string[] {
  const errors: string[] = [];
  const stateNames = new Set(Object.keys(config.states));

  // Check role configs have valid channels
  for (const [roleName, roleConfig] of Object.entries(config.roles)) {
    if (
      !roleConfig.channels ||
      typeof roleConfig.channels !== 'object' ||
      Object.keys(roleConfig.channels).length === 0
    ) {
      errors.push(
        `${typeName}.roles.${roleName}.channels must be a non-empty object mapping channel names to group folders`,
      );
    }
  }

  // Check that all transition targets reference existing states
  for (const [stateName, state] of Object.entries(config.states)) {
    if (state.on_complete) {
      for (const [outcome, transition] of Object.entries(state.on_complete)) {
        if (!stateNames.has(transition.target)) {
          errors.push(
            `${typeName}.states.${stateName}.on_complete.${outcome}.target "${transition.target}" does not exist`,
          );
        }
        // Check role references
        if (transition.role && !config.roles[transition.role]) {
          errors.push(
            `${typeName}.states.${stateName}.on_complete.${outcome}.role "${transition.role}" not defined in roles`,
          );
        }
      }
    }
    if (state.on_approve) {
      if (!stateNames.has(state.on_approve.target)) {
        errors.push(
          `${typeName}.states.${stateName}.on_approve.target "${state.on_approve.target}" does not exist`,
        );
      }
      if (state.on_approve.role && !config.roles[state.on_approve.role]) {
        errors.push(
          `${typeName}.states.${stateName}.on_approve.role "${state.on_approve.role}" not defined in roles`,
        );
      }
    }
    if (state.on_revise) {
      if (!stateNames.has(state.on_revise.target)) {
        errors.push(
          `${typeName}.states.${stateName}.on_revise.target "${state.on_revise.target}" does not exist`,
        );
      }
      if (state.on_revise.role && !config.roles[state.on_revise.role]) {
        errors.push(
          `${typeName}.states.${stateName}.on_revise.role "${state.on_revise.role}" not defined in roles`,
        );
      }
    }
    // Check card references
    if (state.card && !config.cards[state.card]) {
      errors.push(
        `${typeName}.states.${stateName}.card "${state.card}" not defined in cards`,
      );
    }
    // Check role references in delegation states
    if (
      state.type === 'delegation' &&
      state.role &&
      !config.roles[state.role]
    ) {
      errors.push(
        `${typeName}.states.${stateName}.role "${state.role}" not defined in roles`,
      );
    }
  }

  // Check entry points reference existing states
  for (const [epName, ep] of Object.entries(config.entry_points)) {
    if (!stateNames.has(ep.state)) {
      errors.push(
        `${typeName}.entry_points.${epName}.state "${ep.state}" does not exist`,
      );
    }
  }

  // Check card references in transitions
  for (const [stateName, state] of Object.entries(config.states)) {
    if (state.on_complete) {
      for (const [outcome, transition] of Object.entries(state.on_complete)) {
        if (transition.card && !config.cards[transition.card]) {
          errors.push(
            `${typeName}.states.${stateName}.on_complete.${outcome}.card "${transition.card}" not defined in cards`,
          );
        }
      }
    }
    if (state.on_approve?.card && !config.cards[state.on_approve.card]) {
      errors.push(
        `${typeName}.states.${stateName}.on_approve.card "${state.on_approve.card}" not defined in cards`,
      );
    }
    if (state.on_revise?.card && !config.cards[state.on_revise.card]) {
      errors.push(
        `${typeName}.states.${stateName}.on_revise.card "${state.on_revise.card}" not defined in cards`,
      );
    }
  }

  return errors;
}
