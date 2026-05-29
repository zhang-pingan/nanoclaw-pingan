import path from 'path';

import {
  WorkflowDefinition,
  WorkflowCreateForm,
  WORKFLOW_CREATE_FIELD_TYPES,
  WorkflowDefinitionArtifactDisplay,
  WorkflowDefinitionState,
  WorkflowDefinitionTransition,
  WorkflowDefinitionEvaluatorRef,
  WorkflowDefinitionHandoff,
  WorkflowDefinitionJsonSchemaRef,
  WorkflowManualRequirementCreateConfig,
  WorkflowDefinitionRetryPolicy,
  WorkflowDefinitionTimeoutPolicy,
  WorkflowDefinitionSystemRun,
  WorkflowContextRequirements,
  WorkflowContextSourceType,
  WorkflowQualityGate,
  WorkflowQualityGateEvaluatorType,
} from './workflow-definition.js';
import { getWorkflowArtifactContract } from './workflow-artifact-contract.js';
import { isValidDeliverableFileName } from './workflow-artifacts.js';

const SUPPORTED_CONTEXT_SOURCE_TYPES = new Set<WorkflowContextSourceType>([
  'workflow_input',
  'artifact',
  'codebase_location',
]);

const IMPLEMENTED_QUALITY_GATE_EVALUATORS =
  new Set<WorkflowQualityGateEvaluatorType>([
    'schema',
    'artifact',
    'stage_rules',
    'context_coverage',
    'evidence',
    'consistency',
    'execution',
    'llm_judge',
  ]);

const SUPPORTED_QUALITY_GATE_EVALUATORS =
  new Set<WorkflowQualityGateEvaluatorType>([
    'schema',
    'artifact',
    'stage_rules',
    'context_coverage',
    'evidence',
    'consistency',
    'execution',
    'llm_judge',
  ]);

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
  before_delegate?: WorkflowDefinitionSystemRun;
  after_complete?: WorkflowDefinitionSystemRun;
  card?: string;
  label?: string;
  description?: string;
  retry_policy?: WorkflowDefinitionRetryPolicy;
  timeout_policy?: WorkflowDefinitionTimeoutPolicy;
  context_requirements?: WorkflowContextRequirements;
  quality_gate?: WorkflowQualityGate;
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
  run?: WorkflowDefinitionSystemRun;
}

export interface CompiledWorkflowConfig {
  name: string;
  roles: Record<
    string,
    { channels: Record<string, string>; deliverable_file?: string }
  >;
  artifacts?: WorkflowDefinitionArtifactDisplay[];
  entry_points: Record<
    string,
    {
      state: string;
      requires_deliverable?: boolean;
      deliverable_role?: string;
      manual_requirement_create?: WorkflowManualRequirementCreateConfig;
    }
  >;
  states: Record<string, CompiledWorkflowState>;
  status_labels: Record<string, string>;
  create_form?: WorkflowCreateForm;
}

function isSafeArtifactDisplayPath(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('/workspace/')
    ? trimmed.replace(/^\/workspace\//, '')
    : trimmed.replace(/^\/+/, '');
  return (
    !!trimmed &&
    !trimmed.includes('\0') &&
    !trimmed.includes('\\') &&
    !normalized.split('/').some((segment) => segment === '..') &&
    (!path.isAbsolute(trimmed) || trimmed.startsWith('/workspace/'))
  );
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
    context_requirements: state.context_requirements,
    quality_gate: state.quality_gate,
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
      before_delegate: state.before_delegate,
      after_complete: state.after_complete,
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
      run: state.run,
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
  const validateArtifactContractRef = (
    basePath: string,
    ref: string | undefined,
  ): void => {
    const value = ref?.trim();
    if (value && !getWorkflowArtifactContract(value)) {
      errors.push(`${basePath} "${value}" not found in artifact contracts`);
    }
  };
  const validateHandoffArtifactContractRef = (
    basePath: string,
    handoff: WorkflowDefinitionHandoff | undefined,
  ): void => {
    validateArtifactContractRef(
      `${basePath}.artifact_contract_ref`,
      handoff?.artifact_contract_ref,
    );
  };
  const validateActionRun = (
    basePath: string,
    run: WorkflowDefinitionSystemRun | undefined,
  ): void => {
    if (run === undefined) return;
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      errors.push(`${basePath} must be an object`);
      return;
    }
    if (run.steps !== undefined && !Array.isArray(run.steps)) {
      errors.push(`${basePath}.steps must be an array`);
      return;
    }
    const seenStepIds = new Set<string>();
    const steps = run.steps || [];
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
  };

  if (
    definition.artifacts !== undefined &&
    !Array.isArray(definition.artifacts)
  ) {
    errors.push(`${definition.key}.artifacts must be an array`);
  }
  const seenArtifactPaths = new Set<string>();
  for (const [index, artifact] of (Array.isArray(definition.artifacts)
    ? definition.artifacts
    : []
  ).entries()) {
    const artifactPath = `${definition.key}.artifacts[${index}]`;
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
      if (!isSafeArtifactDisplayPath(normalizedPath)) {
        errors.push(
          `${artifactPath}.path must be a safe relative artifact path`,
        );
      }
      if (seenArtifactPaths.has(normalizedPath)) {
        errors.push(`${artifactPath}.path "${normalizedPath}" is duplicated`);
      }
      seenArtifactPaths.add(normalizedPath);
    }
    if (artifact.source_role !== undefined) {
      if (!artifact.source_role.trim()) {
        errors.push(`${artifactPath}.source_role must be a non-empty string`);
      } else if (!roleNames.has(artifact.source_role)) {
        errors.push(
          `${artifactPath}.source_role "${artifact.source_role}" not defined in roles`,
        );
      }
    }
    if (
      artifact.required !== undefined &&
      typeof artifact.required !== 'boolean'
    ) {
      errors.push(`${artifactPath}.required must be a boolean`);
    }
  }

  const validateContextRequirements = (
    stateKey: string,
    contextRequirements: WorkflowContextRequirements | undefined,
  ): void => {
    if (contextRequirements === undefined) return;
    const basePath = `${definition.key}.states.${stateKey}.context_requirements`;
    if (
      !contextRequirements ||
      typeof contextRequirements !== 'object' ||
      Array.isArray(contextRequirements)
    ) {
      errors.push(`${basePath} must be an object`);
      return;
    }
    const policy = contextRequirements.readiness_policy;
    if (
      policy !== undefined &&
      policy !== 'record_only' &&
      policy !== 'block_if_required_missing'
    ) {
      errors.push(`${basePath}.readiness_policy "${policy}" is invalid`);
    }
    if (
      contextRequirements.allow_open_questions !== undefined &&
      typeof contextRequirements.allow_open_questions !== 'boolean'
    ) {
      errors.push(`${basePath}.allow_open_questions must be a boolean`);
    }
    if (
      contextRequirements.sources !== undefined &&
      !Array.isArray(contextRequirements.sources)
    ) {
      errors.push(`${basePath}.sources must be an array`);
    }
    const seenSourceIds = new Set<string>();
    for (const [index, source] of (Array.isArray(contextRequirements.sources)
      ? contextRequirements.sources
      : []
    ).entries()) {
      const sourcePath = `${basePath}.sources[${index}]`;
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        errors.push(`${sourcePath} must be an object`);
        continue;
      }
      if (!source.id?.trim()) {
        errors.push(`${sourcePath}.id is required`);
      } else if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(source.id)) {
        errors.push(
          `${sourcePath}.id must start with a letter or underscore and contain only letters, numbers, "_" or "-"`,
        );
      } else if (seenSourceIds.has(source.id)) {
        errors.push(`${sourcePath}.id "${source.id}" is duplicated`);
      } else {
        seenSourceIds.add(source.id);
      }
      if (
        !source.type ||
        !SUPPORTED_CONTEXT_SOURCE_TYPES.has(
          source.type as WorkflowContextSourceType,
        )
      ) {
        errors.push(`${sourcePath}.type "${source.type}" is invalid`);
      }
      if (
        source.required !== undefined &&
        typeof source.required !== 'boolean'
      ) {
        errors.push(`${sourcePath}.required must be a boolean`);
      }
      if (
        source.refs !== undefined &&
        (!Array.isArray(source.refs) ||
          !source.refs.every(
            (item) => typeof item === 'string' && item.trim().length > 0,
          ))
      ) {
        errors.push(`${sourcePath}.refs must be an array of non-empty strings`);
      }
      if (
        source.fields !== undefined &&
        (!Array.isArray(source.fields) ||
          !source.fields.every(
            (item) => typeof item === 'string' && item.trim().length > 0,
          ))
      ) {
        errors.push(
          `${sourcePath}.fields must be an array of non-empty strings`,
        );
      }
      if (
        source.on_missing !== undefined &&
        source.on_missing !== 'warn' &&
        source.on_missing !== 'block' &&
        source.on_missing !== 'needs_input'
      ) {
        errors.push(
          `${sourcePath}.on_missing "${source.on_missing}" is invalid`,
        );
      }
      if (
        source.max_age_days !== undefined &&
        (typeof source.max_age_days !== 'number' ||
          !Number.isFinite(source.max_age_days) ||
          source.max_age_days < 0)
      ) {
        errors.push(`${sourcePath}.max_age_days must be a non-negative number`);
      }
      if (
        source.verify_exists !== undefined &&
        typeof source.verify_exists !== 'boolean'
      ) {
        errors.push(`${sourcePath}.verify_exists must be a boolean`);
      }
      if (
        source.verify_mounted_for_role !== undefined &&
        typeof source.verify_mounted_for_role !== 'boolean'
      ) {
        errors.push(`${sourcePath}.verify_mounted_for_role must be a boolean`);
      }
      if (source.type === 'workflow_input' && source.refs !== undefined) {
        errors.push(`${sourcePath}.refs is not supported for workflow_input`);
      }
      if (source.type === 'artifact' && source.fields !== undefined) {
        errors.push(`${sourcePath}.fields is not supported for artifact`);
      }
      if (source.type === 'codebase_location' && source.refs !== undefined) {
        errors.push(
          `${sourcePath}.refs is not supported for codebase_location`,
        );
      }
    }

    const isBlockingPolicy = policy === 'block_if_required_missing';
    if (!isBlockingPolicy) return;
    const onBlock = contextRequirements.on_block;
    if (!onBlock?.target?.trim() || !onBlock.retry_action?.trim()) {
      errors.push(
        `${basePath}.on_block.target and .retry_action are required for blocking readiness_policy`,
      );
      return;
    }
    const targetState = definition.states[onBlock.target];
    if (!targetState) {
      errors.push(
        `${basePath}.on_block.target "${onBlock.target}" does not exist`,
      );
      return;
    }
    if (targetState.type === 'interrupt') {
      if (targetState.kind !== 'human_input') {
        errors.push(
          `${basePath}.on_block.target "${onBlock.target}" must be interrupt.kind=human_input or a context_blocked state`,
        );
      }
      if (!targetState.allowed_actions?.includes(onBlock.retry_action)) {
        errors.push(
          `${basePath}.on_block.retry_action "${onBlock.retry_action}" is not in ${onBlock.target}.allowed_actions`,
        );
      }
      if (!targetState.on_resume?.[onBlock.retry_action]) {
        errors.push(
          `${basePath}.on_block.retry_action "${onBlock.retry_action}" is not configured in ${onBlock.target}.on_resume`,
        );
      }
      return;
    }
    if (
      targetState.type !== 'system' ||
      !targetState.on_complete?.success ||
      targetState.on_complete.success.target !== stateKey
    ) {
      errors.push(
        `${basePath}.on_block.target "${onBlock.target}" must be a human_input interrupt or a context_blocked system state that resumes current stage`,
      );
    }
  };
  const validateQualityGate = (
    stateKey: string,
    qualityGate: WorkflowQualityGate | undefined,
  ): void => {
    if (qualityGate === undefined) return;
    const basePath = `${definition.key}.states.${stateKey}.quality_gate`;
    if (
      !qualityGate ||
      typeof qualityGate !== 'object' ||
      Array.isArray(qualityGate)
    ) {
      errors.push(`${basePath} must be an object`);
      return;
    }
    if (
      qualityGate.pass_policy !== undefined &&
      qualityGate.pass_policy !== 'all_blocking_pass'
    ) {
      errors.push(
        `${basePath}.pass_policy "${qualityGate.pass_policy}" is invalid`,
      );
    }
    if (
      qualityGate.evaluators !== undefined &&
      !Array.isArray(qualityGate.evaluators)
    ) {
      errors.push(`${basePath}.evaluators must be an array`);
      return;
    }
    const seenEvaluatorTypes = new Set<string>();
    for (const [index, evaluator] of (Array.isArray(qualityGate.evaluators)
      ? qualityGate.evaluators
      : []
    ).entries()) {
      const evaluatorPath = `${basePath}.evaluators[${index}]`;
      if (
        !evaluator ||
        typeof evaluator !== 'object' ||
        Array.isArray(evaluator)
      ) {
        errors.push(`${evaluatorPath} must be an object`);
        continue;
      }
      if (
        !evaluator.type ||
        !SUPPORTED_QUALITY_GATE_EVALUATORS.has(
          evaluator.type as WorkflowQualityGateEvaluatorType,
        )
      ) {
        errors.push(`${evaluatorPath}.type "${evaluator.type}" is invalid`);
      } else if (seenEvaluatorTypes.has(evaluator.type)) {
        errors.push(`${evaluatorPath}.type "${evaluator.type}" is duplicated`);
      } else {
        seenEvaluatorTypes.add(evaluator.type);
      }
      if (
        evaluator.blocking !== undefined &&
        typeof evaluator.blocking !== 'boolean'
      ) {
        errors.push(`${evaluatorPath}.blocking must be a boolean`);
      }
      if (
        evaluator.blocking === true &&
        evaluator.type &&
        !IMPLEMENTED_QUALITY_GATE_EVALUATORS.has(
          evaluator.type as WorkflowQualityGateEvaluatorType,
        )
      ) {
        errors.push(
          `${evaluatorPath}.type "${evaluator.type}" is not implemented as a blocking evaluator`,
        );
      }
    }
  };

  if (!definition.key?.trim()) errors.push('definition.key is required');
  if (!definition.name?.trim()) errors.push('definition.name is required');

  for (const [entryKey, entry] of Object.entries(definition.entry_points)) {
    if (!stateNames.has(entry.state)) {
      errors.push(
        `${definition.key}.entry_points.${entryKey}.state "${entry.state}" does not exist`,
      );
    }
    if (entry.deliverable_role && !roleNames.has(entry.deliverable_role)) {
      errors.push(
        `${definition.key}.entry_points.${entryKey}.deliverable_role "${entry.deliverable_role}" not defined in roles`,
      );
    }
    const manualCreate = entry.manual_requirement_create;
    if (manualCreate !== undefined) {
      const basePath = `${definition.key}.entry_points.${entryKey}.manual_requirement_create`;
      if (
        !manualCreate ||
        typeof manualCreate !== 'object' ||
        Array.isArray(manualCreate)
      ) {
        errors.push(`${basePath} must be an object`);
      } else {
        if (
          manualCreate.enabled !== undefined &&
          typeof manualCreate.enabled !== 'boolean'
        ) {
          errors.push(`${basePath}.enabled must be a boolean`);
        }
        if (
          manualCreate.files !== undefined &&
          !Array.isArray(manualCreate.files)
        ) {
          errors.push(`${basePath}.files must be an array`);
        }
        const seenFiles = new Set<string>();
        for (const [index, file] of (Array.isArray(manualCreate.files)
          ? manualCreate.files
          : []
        ).entries()) {
          const filePath = `${basePath}.files[${index}]`;
          if (!file || typeof file !== 'object' || Array.isArray(file)) {
            errors.push(`${filePath} must be an object`);
            continue;
          }
          if (!file.filename?.trim()) {
            errors.push(`${filePath}.filename is required`);
          } else {
            const filename = file.filename.trim();
            if (filename !== filename.split(/[\\/]/).pop()) {
              errors.push(`${filePath}.filename must be a base filename`);
            }
            if (!/\.[a-z0-9]{1,12}$/i.test(filename)) {
              errors.push(
                `${filePath}.filename must be a base filename with an extension`,
              );
            }
            if (seenFiles.has(filename)) {
              errors.push(`${filePath}.filename "${filename}" is duplicated`);
            }
            seenFiles.add(filename);
          }
          if (
            file.required !== undefined &&
            typeof file.required !== 'boolean'
          ) {
            errors.push(`${filePath}.required must be a boolean`);
          }
        }
      }
    }
  }

  for (const [roleKey, role] of Object.entries(definition.roles)) {
    const basePath = `${definition.key}.roles.${roleKey}`;
    if (
      role.deliverable_file !== undefined &&
      !isValidDeliverableFileName(role.deliverable_file)
    ) {
      errors.push(
        `${basePath}.deliverable_file must be a base filename with an extension`,
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
        if (!WORKFLOW_CREATE_FIELD_TYPES.includes(field.type)) {
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
    validateArtifactContractRef(
      `${definition.key}.states.${stateKey}.artifact_contract.ref`,
      state.artifact_contract?.ref,
    );
    validateContextRequirements(stateKey, state.context_requirements);
    validateQualityGate(stateKey, state.quality_gate);

    if (state.type === 'delegation') {
      validateHandoffArtifactContractRef(
        `${definition.key}.states.${stateKey}.delegate.handoff`,
        state.delegate.handoff,
      );
      validateActionRun(
        `${definition.key}.states.${stateKey}.before_delegate`,
        state.before_delegate,
      );
      validateActionRun(
        `${definition.key}.states.${stateKey}.after_complete`,
        state.after_complete,
      );
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
        validateHandoffArtifactContractRef(
          `${definition.key}.states.${stateKey}.on_complete.${outcome}.delegate.handoff`,
          transition.delegate?.handoff,
        );
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
        validateHandoffArtifactContractRef(
          `${definition.key}.states.${stateKey}.on_complete.${outcome}.delegate.handoff`,
          transition.delegate?.handoff,
        );
      }
    }

    if (state.type === 'system') {
      validateActionRun(`${definition.key}.states.${stateKey}.run`, state.run);
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
        validateHandoffArtifactContractRef(
          `${definition.key}.states.${stateKey}.on_resume.${action}.delegate.handoff`,
          transition.delegate?.handoff,
        );
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
        validateHandoffArtifactContractRef(
          `${definition.key}.states.${stateKey}.${fieldName}.delegate.handoff`,
          transition.delegate?.handoff,
        );
      }
    }

    for (const [fieldName, transition] of [
      ['timeout_policy.on_timeout', state.timeout_policy?.on_timeout],
      ['retry_policy.on_exhausted', state.retry_policy?.on_exhausted],
    ] as const) {
      validateHandoffArtifactContractRef(
        `${definition.key}.states.${stateKey}.${fieldName}.delegate.handoff`,
        transition?.delegate?.handoff,
      );
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
      validateHandoffArtifactContractRef(
        `${definition.key}.states.${stateKey}.evaluator.${fieldName}.delegate.handoff`,
        transition.delegate?.handoff,
      );
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
          deliverable_file: role.deliverable_file,
        },
      ]),
    ),
    artifacts: definition.artifacts,
    entry_points: Object.fromEntries(
      Object.entries(definition.entry_points).map(([entryKey, entry]) => [
        entryKey,
        {
          state: entry.state,
          requires_deliverable: entry.requires_deliverable,
          deliverable_role: entry.deliverable_role,
          manual_requirement_create: entry.manual_requirement_create,
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
