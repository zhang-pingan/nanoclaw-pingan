/**
 * Workflow Configuration — types, loader, template renderer, validator.
 *
 * Editable workflow definitions live in container/skills/workflow-definitions.json.
 * Legacy compiled workflow configs may exist in container/skills/workflows.json.
 * Card templates live in container/skills/cards.json.
 * The engine (workflow.ts) reads them once at init and drives state
 * transitions generically instead of hard-coding each workflow type.
 */
import fs from 'fs';
import path from 'path';

import { CardConfig, validateCardConfig } from './card-config.js';
import { logger } from './logger.js';
import { WorkflowDefinition } from './workflow-definition.js';
import {
  getPublishedWorkflowDefinitions,
  normalizeWorkflowDefinitionRegistry,
} from './workflow-definition-registry.js';
import { compileWorkflowDefinitions } from './workflow-compiler.js';

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
  /** Which role's deliverable to look up (e.g. 'plan' or 'dev'). Defaults to 'dev'. */
  deliverable_role?: string;
}

export interface WorkflowTypeConfig {
  name: string;
  roles: Record<string, RoleConfig>;
  entry_points: Record<string, EntryPointConfig>;
  states: Record<string, StateConfig>;
  status_labels: Record<string, string>;
}

interface RawWorkflowTypeConfig extends WorkflowTypeConfig {
  cards?: Record<string, CardConfig>;
}

// -------------------------------------------------------
// Loader
// -------------------------------------------------------

let loadedConfigs: Record<string, WorkflowTypeConfig> | null = null;
let loadedCards: Record<string, Record<string, CardConfig>> | null = null;
let lastLoadError: string | null = null;

export function getWorkflowConfigError(): string | null {
  return lastLoadError;
}

export function loadWorkflowConfigs(): Record<
  string,
  WorkflowTypeConfig
> | null {
  const workflowsPath = path.join(
    process.cwd(),
    'container',
    'skills',
    'workflows.json',
  );
  const definitionsPath = path.join(
    process.cwd(),
    'container',
    'skills',
    'workflow-definitions.json',
  );
  const cardsPath = path.join(process.cwd(), 'container', 'skills', 'cards.json');

  if (!fs.existsSync(workflowsPath)) {
    lastLoadError = 'Workflow 未启用：未找到 container/skills/workflows.json';
    logger.info(lastLoadError);
    return null;
  }

  if (!fs.existsSync(cardsPath)) {
    lastLoadError = 'Workflow 未启用：未找到 container/skills/cards.json';
    logger.info(lastLoadError);
    return null;
  }

  try {
    const rawCards = JSON.parse(
      fs.readFileSync(cardsPath, 'utf-8'),
    ) as Record<string, Record<string, CardConfig>>;

    let configs: Record<string, WorkflowTypeConfig>;
    let legacyRawWorkflows: Record<string, RawWorkflowTypeConfig> | null = null;

    if (fs.existsSync(definitionsPath)) {
      const rawDefinitions = JSON.parse(
        fs.readFileSync(definitionsPath, 'utf-8'),
      ) as WorkflowDefinition | Record<string, WorkflowDefinition>;
      const registry = normalizeWorkflowDefinitionRegistry(rawDefinitions);
      const published = getPublishedWorkflowDefinitions(registry);
      if (published.errors.length > 0) {
        lastLoadError = `Workflow definition 发布模型校验失败: ${published.errors.join('; ')}`;
        logger.error(
          { errors: published.errors },
          'Workflow definition publish model validation failed',
        );
        return null;
      }
      const compiled = compileWorkflowDefinitions(published.definitions);
      if (compiled.errors.length > 0) {
        lastLoadError = `Workflow definition 编译失败: ${compiled.errors.join('; ')}`;
        logger.error({ errors: compiled.errors }, 'Workflow definition compile failed');
        return null;
      }
      configs = compiled.configs as Record<string, WorkflowTypeConfig>;
    } else {
      legacyRawWorkflows = JSON.parse(
        fs.readFileSync(workflowsPath, 'utf-8'),
      ) as Record<string, RawWorkflowTypeConfig>;
      configs = legacyRawWorkflows as Record<string, WorkflowTypeConfig>;
    }

    for (const [typeName, config] of Object.entries(configs)) {
      const fallbackCards = legacyRawWorkflows?.[typeName]?.cards || {};
      const errors = validateConfig(
        typeName,
        config,
        rawCards[typeName] || fallbackCards,
      );
      if (errors.length > 0) {
        lastLoadError = `Workflow 配置校验失败 (${typeName}): ${errors.join('; ')}`;
        logger.error({ typeName, errors }, 'Workflow config validation failed');
        return null;
      }
    }

    loadedConfigs = configs;
    loadedCards = rawCards;
    lastLoadError = null;
    logger.info({ types: Object.keys(configs) }, 'Workflow configs loaded');
    return configs;
  } catch (err) {
    lastLoadError = `Workflow 未启用：workflow/cards 配置解析失败 — ${err instanceof Error ? err.message : String(err)}`;
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

export function getCardConfigsForType(
  workflowType: string,
): Record<string, CardConfig> | undefined {
  return loadedCards?.[workflowType];
}

export function getCardConfig(
  workflowType: string,
  cardKey: string,
): CardConfig | undefined {
  return getCardConfigsForType(workflowType)?.[cardKey];
}

export function getReachableWorkflowStages(
  workflowType: string,
  startState: string,
): string[] {
  const config = getWorkflowTypeConfig(workflowType);
  if (!config || !config.states[startState]) return [];

  const visited = new Set<string>();
  const queue = [startState];

  while (queue.length > 0) {
    const stateKey = queue.shift();
    if (!stateKey || visited.has(stateKey)) continue;
    visited.add(stateKey);

    const state = config.states[stateKey];
    if (!state) continue;

    const nextStates = [
      state.on_complete?.success?.target,
      state.on_complete?.failure?.target,
      state.on_approve?.target,
      state.on_revise?.target,
    ];

    for (const target of nextStates) {
      if (target && !visited.has(target) && config.states[target]) {
        queue.push(target);
      }
    }
  }

  return Object.keys(config.states).filter((stateKey) => {
    const state = config.states[stateKey];
    return (
      visited.has(stateKey) &&
      state.type !== 'system' &&
      state.type !== 'terminal'
    );
  });
}

// -------------------------------------------------------
// Template renderer
// -------------------------------------------------------

export interface TemplateVars {
  name?: string;
  service?: string;
  work_branch?: string;
  id?: string;
  round?: number;
  deliverable?: string;
  staging_base_branch?: string;
  staging_work_branch?: string;
  access_token?: string;
  plan_doc?: string;
  dev_doc?: string;
  test_doc?: string;
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
  cards: Record<string, CardConfig>,
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
    if (state.card && !cards[state.card]) {
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
        if (transition.card && !cards[transition.card]) {
          errors.push(
            `${typeName}.states.${stateName}.on_complete.${outcome}.card "${transition.card}" not defined in cards`,
          );
        }
      }
    }
    if (state.on_approve?.card && !cards[state.on_approve.card]) {
      errors.push(
        `${typeName}.states.${stateName}.on_approve.card "${state.on_approve.card}" not defined in cards`,
      );
    }
    if (state.on_revise?.card && !cards[state.on_revise.card]) {
      errors.push(
        `${typeName}.states.${stateName}.on_revise.card "${state.on_revise.card}" not defined in cards`,
      );
    }
  }

  for (const [cardKey, cardConfig] of Object.entries(cards)) {
    errors.push(...validateCardConfig(`${typeName}.cards.${cardKey}`, cardConfig));
  }

  return errors;
}
