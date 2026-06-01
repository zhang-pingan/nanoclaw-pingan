/**
 * Workflow Configuration — types, loader, template renderer, validator.
 *
 * Editable workflow definitions live in container/workflow-definitions/*.json.
 * Card templates live in container/cards/*.json.
 * The engine (workflow.ts) reads them once at init and drives state
 * transitions generically instead of hard-coding each workflow type.
 */
import fs from 'fs';

import { CardConfig, validateCardConfig } from './card-config.js';
import {
  CARDS_RELATIVE_DIR,
  getCardsDir,
  readCardRegistryFromDir,
} from './card-files.js';
import { logger } from './logger.js';
import {
  WorkflowCreateForm,
  WorkflowDefinitionArtifactDisplay,
  WorkflowDefinitionArtifactContractRef,
  WorkflowDefinitionEvaluatorRef,
  WorkflowDefinitionHandoff,
  WorkflowDefinitionJsonSchemaRef,
  WorkflowManualRequirementCreateConfig,
  WorkflowDefinitionRetryPolicy,
  WorkflowDefinitionRollbackHintRef,
  WorkflowDefinitionSystemRun,
  WorkflowDefinitionConditionalTransition,
  WorkflowDefinitionTimeoutPolicy,
  WorkflowContextRequirements,
  WorkflowQualityGate,
} from './workflow-definition.js';
import {
  getWorkflowDefinitionsDir,
  readWorkflowDefinitionRegistryFromDir,
  WORKFLOW_DEFINITIONS_RELATIVE_DIR,
} from './workflow-definition-files.js';
import { getPublishedWorkflowDefinitions } from './workflow-definition-registry.js';
import { compileWorkflowDefinitions } from './workflow-compiler.js';
import { isValidDeliverableFileName } from './workflow-artifacts.js';

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
  /** Typed handoff contract for this delegation. */
  handoff?: WorkflowDefinitionHandoff;
  /** Increment the workflow round counter. */
  increment_round?: boolean;
  /** Notification template sent to main group. */
  notify?: string;
  /** Card key to send after transition (references cards map). */
  card?: string;
}

export interface StateConfig {
  /** State type: delegation, interrupt, terminal, system. */
  type: 'delegation' | 'interrupt' | 'terminal' | 'system';
  label?: string;
  description?: string;
  retry_policy?: WorkflowDefinitionRetryPolicy;
  timeout_policy?: WorkflowDefinitionTimeoutPolicy;
  context_requirements?: WorkflowContextRequirements;
  quality_gate?: WorkflowQualityGate;
  artifact_contract?: WorkflowDefinitionArtifactContractRef;
  evaluator?: WorkflowDefinitionEvaluatorRef;
  rollback_hint?: WorkflowDefinitionRollbackHintRef;

  // --- delegation fields ---
  role?: string;
  skill?: string;
  task_template?: string;
  handoff?: WorkflowDefinitionHandoff;
  before_delegate?: WorkflowDefinitionSystemRun;
  after_complete?: WorkflowDefinitionSystemRun;
  on_complete?: {
    success: StateTransition;
    failure?: StateTransition;
  };
  run?: WorkflowDefinitionSystemRun;
  routes?: WorkflowDefinitionConditionalTransition[];

  // --- interrupt fields ---
  card?: string;
  kind?:
    | 'approval'
    | 'revision_request'
    | 'credential'
    | 'human_input'
    | 'external_blocker';
  title?: string;
  body?: string;
  resume_payload_schema?: WorkflowDefinitionJsonSchemaRef;
  allowed_actions?: string[];
  allowed_channels?: Array<'web' | 'feishu' | 'assistant'>;
  on_resume?: Record<string, StateTransition>;
  on_cancel?: StateTransition;
  on_expire?: StateTransition;
}

export interface RoleConfig {
  /** Channel → group folder mapping, e.g. { web: "web_plan" } */
  channels: Record<string, string>;
  /** Optional deliverable filename produced by this role, e.g. plan.md. */
  deliverable_file?: string;
}

export interface EntryPointConfig {
  /** Initial state when entering via this entry point. */
  state: string;
  /** Whether the entry point requires an existing deliverable. */
  requires_deliverable?: boolean;
  /** Which role's deliverable to look up (e.g. 'plan' or 'dev'). Defaults to 'dev'. */
  deliverable_role?: string;
  /** Optional config-driven manual requirement creation for this entry point. */
  manual_requirement_create?: WorkflowManualRequirementCreateConfig;
}

export interface WorkflowTypeConfig {
  name: string;
  roles: Record<string, RoleConfig>;
  artifacts?: WorkflowDefinitionArtifactDisplay[];
  entry_points: Record<string, EntryPointConfig>;
  states: Record<string, StateConfig>;
  status_labels: Record<string, string>;
  create_form?: WorkflowCreateForm;
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
  const definitionsDir = getWorkflowDefinitionsDir();
  const cardsDir = getCardsDir();

  if (!fs.existsSync(definitionsDir)) {
    lastLoadError = `Workflow 未启用：未找到 ${WORKFLOW_DEFINITIONS_RELATIVE_DIR}`;
    logger.info(lastLoadError);
    return null;
  }

  if (!fs.existsSync(cardsDir)) {
    lastLoadError = `Workflow 未启用：未找到 ${CARDS_RELATIVE_DIR}`;
    logger.info(lastLoadError);
    return null;
  }

  try {
    const rawCards = readCardRegistryFromDir();

    const registry = readWorkflowDefinitionRegistryFromDir();
    if (Object.keys(registry.definitions).length === 0) {
      lastLoadError = `Workflow 未启用：${WORKFLOW_DEFINITIONS_RELATIVE_DIR} 下没有 workflow definition JSON 文件`;
      logger.info(lastLoadError);
      return null;
    }

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
      logger.error(
        { errors: compiled.errors },
        'Workflow definition compile failed',
      );
      return null;
    }
    const configs = compiled.configs as Record<string, WorkflowTypeConfig>;

    for (const [typeName, config] of Object.entries(configs)) {
      const errors = validateConfig(typeName, config, rawCards[typeName] || {});
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
    lastLoadError = `Workflow 未启用：workflow definition/cards 配置解析失败 — ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err }, 'Failed to parse workflow definitions');
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
      ...(state.routes ? state.routes.map((route) => route.target) : []),
      ...(state.on_resume
        ? Object.values(state.on_resume).map((transition) => transition.target)
        : []),
      state.on_cancel?.target,
      state.on_expire?.target,
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
  workflow_type?: string;
  service?: string;
  main_branch?: string;
  work_branch?: string;
  ios_work_branch?: string;
  id?: string;
  round?: number;
  deliverable?: string;
  staging_base_branch?: string;
  staging_work_branch?: string;
  access_token?: string;
  requirement_description?: string;
  requirement_files?: string;
  plan_doc?: string;
  dev_doc?: string;
  test_doc?: string;
  product_recon_path?: string;
  impact_analysis_path?: string;
  prototype_analysis_path?: string;
  ios_test_plan_path?: string;
  acceptance_report_path?: string;
  delegation_result?: string;
  result_summary?: string;
  revision_text?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Render a template string, replacing {{key}} placeholders with values.
 * Also supports {{role_folder:ROLE_NAME}} to insert a role's group folder.
 */
function isTemplateRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getTemplatePathValue(value: unknown, pathName: string): unknown {
  if (!pathName) return undefined;
  let current = value;
  for (const part of pathName.split('.')) {
    if (!isTemplateRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveTemplateValue(
  expression: string,
  vars: TemplateVars,
  roleFolders?: Record<string, string>,
): unknown {
  const key = expression.trim();
  if (key.startsWith('role_folder:') && roleFolders) {
    const roleName = key.slice('role_folder:'.length);
    return roleFolders[roleName] || '';
  }
  if (key.startsWith('context.')) {
    return getTemplatePathValue(vars.context, key.slice('context.'.length));
  }
  if (key.includes('.')) {
    return getTemplatePathValue(vars, key);
  }
  return vars[key];
}

export function renderTemplate(
  template: string,
  vars: TemplateVars,
  roleFolders?: Record<string, string>,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) =>
    stringifyTemplateValue(resolveTemplateValue(key, vars, roleFolders)),
  );
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

  if (config.artifacts !== undefined && !Array.isArray(config.artifacts)) {
    errors.push(`${typeName}.artifacts must be an array`);
  }
  const seenArtifactPaths = new Set<string>();
  for (const [index, artifact] of (Array.isArray(config.artifacts)
    ? config.artifacts
    : []
  ).entries()) {
    const artifactPath = `${typeName}.artifacts[${index}]`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      errors.push(`${artifactPath} must be an object`);
      continue;
    }
    if (!artifact.artifact_type?.trim()) {
      errors.push(`${artifactPath}.artifact_type is required`);
    }
    if (!artifact.title?.trim()) {
      errors.push(`${artifactPath}.title is required`);
    }
    if (!artifact.path?.trim()) {
      errors.push(`${artifactPath}.path is required`);
    } else {
      const normalizedPath = artifact.path.trim();
      const scopedPath = normalizedPath.startsWith('/workspace/')
        ? normalizedPath.replace(/^\/workspace\//, '')
        : normalizedPath.replace(/^\/+/, '');
      if (
        normalizedPath.includes('\0') ||
        normalizedPath.includes('\\') ||
        scopedPath.split('/').some((segment) => segment === '..') ||
        (normalizedPath.startsWith('/') &&
          !normalizedPath.startsWith('/workspace/'))
      ) {
        errors.push(
          `${artifactPath}.path must be a safe relative artifact path`,
        );
      }
      if (seenArtifactPaths.has(normalizedPath)) {
        errors.push(`${artifactPath}.path "${normalizedPath}" is duplicated`);
      }
      seenArtifactPaths.add(normalizedPath);
    }
    if (
      artifact.source_role !== undefined &&
      !config.roles[artifact.source_role]
    ) {
      errors.push(
        `${artifactPath}.source_role "${artifact.source_role}" not defined in roles`,
      );
    }
  }

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
    if (
      roleConfig.deliverable_file !== undefined &&
      !isValidDeliverableFileName(roleConfig.deliverable_file)
    ) {
      errors.push(
        `${typeName}.roles.${roleName}.deliverable_file must be a base filename with an extension`,
      );
    }
  }

  for (const [entryPointName, entryPoint] of Object.entries(
    config.entry_points,
  )) {
    if (
      entryPoint.deliverable_role &&
      !config.roles[entryPoint.deliverable_role]
    ) {
      errors.push(
        `${typeName}.entry_points.${entryPointName}.deliverable_role "${entryPoint.deliverable_role}" not defined in roles`,
      );
    }
  }

  // Check that all transition targets reference existing states
  for (const [stateName, state] of Object.entries(config.states)) {
    if ((state as { type?: string }).type === 'confirmation') {
      errors.push(
        `${typeName}.states.${stateName}.type "confirmation" is no longer supported; use "interrupt"`,
      );
      continue;
    }
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
    if (state.on_resume) {
      for (const [action, transition] of Object.entries(state.on_resume)) {
        if (!stateNames.has(transition.target)) {
          errors.push(
            `${typeName}.states.${stateName}.on_resume.${action}.target "${transition.target}" does not exist`,
          );
        }
        if (transition.role && !config.roles[transition.role]) {
          errors.push(
            `${typeName}.states.${stateName}.on_resume.${action}.role "${transition.role}" not defined in roles`,
          );
        }
      }
    }
    if (state.on_cancel) {
      if (!stateNames.has(state.on_cancel.target)) {
        errors.push(
          `${typeName}.states.${stateName}.on_cancel.target "${state.on_cancel.target}" does not exist`,
        );
      }
      if (state.on_cancel.role && !config.roles[state.on_cancel.role]) {
        errors.push(
          `${typeName}.states.${stateName}.on_cancel.role "${state.on_cancel.role}" not defined in roles`,
        );
      }
    }
    if (state.on_expire) {
      if (!stateNames.has(state.on_expire.target)) {
        errors.push(
          `${typeName}.states.${stateName}.on_expire.target "${state.on_expire.target}" does not exist`,
        );
      }
      if (state.on_expire.role && !config.roles[state.on_expire.role]) {
        errors.push(
          `${typeName}.states.${stateName}.on_expire.role "${state.on_expire.role}" not defined in roles`,
        );
      }
    }
    if (state.type === 'interrupt') {
      if (!state.kind) {
        errors.push(`${typeName}.states.${stateName}.kind is required`);
      }
      if (
        !Array.isArray(state.allowed_actions) ||
        state.allowed_actions.length === 0
      ) {
        errors.push(
          `${typeName}.states.${stateName}.allowed_actions must contain at least one action`,
        );
      }
      if (!state.on_resume || Object.keys(state.on_resume).length === 0) {
        errors.push(
          `${typeName}.states.${stateName}.on_resume must contain at least one transition`,
        );
      }
      if (!state.resume_payload_schema) {
        errors.push(
          `${typeName}.states.${stateName}.resume_payload_schema is required`,
        );
      }
      for (const action of state.allowed_actions || []) {
        if (!state.on_resume?.[action]) {
          errors.push(
            `${typeName}.states.${stateName}.on_resume.${action} is required for allowed action "${action}"`,
          );
        }
      }
      const card = state.card ? cards[state.card] : undefined;
      const cardActions = [
        ...(card?.actions || []),
        ...(card?.form ? [card.form.submit_action] : []),
        ...(card?.sections || []).flatMap((section) => section.actions || []),
      ];
      for (const action of cardActions) {
        if (action.action_kind !== 'interrupt_resume') continue;
        if (!action.resume_action) continue;
        if (!state.allowed_actions?.includes(action.resume_action)) {
          errors.push(
            `${typeName}.states.${stateName}.card "${state.card}" action "${action.id}" resume_action "${action.resume_action}" is not in allowed_actions`,
          );
        }
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
    if (state.type === 'system' && state.run !== undefined) {
      const basePath = `${typeName}.states.${stateName}.run`;
      if (
        !state.run ||
        typeof state.run !== 'object' ||
        Array.isArray(state.run)
      ) {
        errors.push(`${basePath} must be an object`);
      } else {
        if (state.run.steps !== undefined && !Array.isArray(state.run.steps)) {
          errors.push(`${basePath}.steps must be an array`);
          continue;
        }
        const seenStepIds = new Set<string>();
        const steps = state.run.steps || [];
        for (const [index, step] of steps.entries()) {
          const stepPath = `${basePath}.steps[${index}]`;
          if (!step || typeof step !== 'object' || Array.isArray(step)) {
            errors.push(`${stepPath} must be an object`);
            continue;
          }
          if (!step.uses?.trim()) {
            errors.push(`${stepPath}.uses is required`);
          }
          if (step.id !== undefined) {
            if (!step.id.trim()) {
              errors.push(`${stepPath}.id must be a non-empty string`);
            } else if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step.id)) {
              errors.push(
                `${stepPath}.id must start with a letter or underscore and contain only letters, numbers, "_" or "-"`,
              );
            } else if (seenStepIds.has(step.id)) {
              errors.push(`${stepPath}.id "${step.id}" is duplicated`);
            } else {
              seenStepIds.add(step.id);
            }
          }
          if (
            step.with !== undefined &&
            (!step.with ||
              typeof step.with !== 'object' ||
              Array.isArray(step.with))
          ) {
            errors.push(`${stepPath}.with must be an object`);
          }
        }
      }
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
    if (state.on_resume) {
      for (const [action, transition] of Object.entries(state.on_resume)) {
        if (transition.card && !cards[transition.card]) {
          errors.push(
            `${typeName}.states.${stateName}.on_resume.${action}.card "${transition.card}" not defined in cards`,
          );
        }
      }
    }
  }

  for (const [cardKey, cardConfig] of Object.entries(cards)) {
    errors.push(
      ...validateCardConfig(`${typeName}.cards.${cardKey}`, cardConfig),
    );
  }

  return errors;
}
