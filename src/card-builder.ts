import { CardButton, CardForm, InteractiveCard } from './types.js';
import type { CardInput } from './types.js';
import { CardActionConfig, CardConfig } from './card-config.js';
import { renderTemplate, TemplateVars } from './workflow-config.js';

export interface CardBuildContext {
  workflowId?: string;
  interruptId?: string;
  allowedActions?: string[];
  payloadSchema?: Record<string, unknown>;
  groupFolder?: string;
  vars: TemplateVars;
  roleFolders?: Record<string, string>;
}

const DEFAULT_ACTIONS: Record<
  string,
  { label: string; type?: 'primary' | 'danger' | 'default' }
> = {
  approve: { label: '✅ 确认执行', type: 'primary' },
  revise: { label: '✏️ 提交修改' },
  submit: { label: '🔐 提交并继续', type: 'primary' },
  skip: { label: '⏭ 跳过此节点' },
  pause: { label: '⏸ 暂缓' },
  cancel: { label: '❌ 取消流程', type: 'danger' },
  resume: { label: '▶ 继续', type: 'primary' },
};

const RESERVED_FORM_FIELD_NAMES = new Set([
  'action',
  'workbench_action',
  'task_id',
  'action_item_id',
  'workflow_id',
  'interrupt_id',
  'resume_action',
  'resume_payload_schema',
  'group_folder',
  'source_type',
  'source_ref_id',
  'request_id',
  'question_id',
  'answer',
  'reply_text',
  'payload',
]);

function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function schemaPropertyToInput(
  name: string,
  schema: Record<string, unknown>,
  required: boolean,
): CardInput {
  const enumValues = stringArray(schema.enum);
  const rawType = String(schema.type || 'string');
  const inputType: CardInput['type'] =
    enumValues.length > 0
      ? 'enum'
      : rawType === 'number'
        ? 'number'
        : rawType === 'integer'
          ? 'integer'
          : rawType === 'boolean'
            ? 'boolean'
            : schema.format === 'binary' || schema.format === 'file'
              ? 'file'
              : schema.format === 'password' ||
                  name.toLowerCase().includes('token')
                ? 'token'
                : 'text';
  return {
    name,
    type: inputType,
    placeholder:
      typeof schema.title === 'string'
        ? schema.title
        : typeof schema.description === 'string'
          ? schema.description
          : name,
    required,
    options: enumValues.map((value) => ({ value, label: value })),
    min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
    max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
    min_length:
      typeof schema.minLength === 'number' ? schema.minLength : undefined,
    max_length:
      typeof schema.maxLength === 'number' ? schema.maxLength : undefined,
    format:
      schema.format === 'email' ||
      schema.format === 'uri' ||
      schema.format === 'date' ||
      schema.format === 'date-time'
        ? schema.format
        : undefined,
  };
}

function schemaInputs(
  schema: Record<string, unknown> | undefined,
): CardInput[] {
  if (!schema || schema.type !== 'object') return [];
  const properties = asJsonObject(schema.properties) || {};
  const required = new Set(stringArray(schema.required));
  return Object.entries(properties)
    .filter(([name]) => name !== 'skipped')
    .map(([name, raw]) =>
      schemaPropertyToInput(name, asJsonObject(raw) || {}, required.has(name)),
    );
}

function mergeSchemaInput(input: CardInput, schemaInput: CardInput): CardInput {
  return {
    ...schemaInput,
    ...input,
    type: input.type || schemaInput.type,
    placeholder: input.placeholder || schemaInput.placeholder,
    required: input.required ?? schemaInput.required,
    options: input.options || schemaInput.options,
    min: input.min ?? schemaInput.min,
    max: input.max ?? schemaInput.max,
    min_length: input.min_length ?? schemaInput.min_length,
    max_length: input.max_length ?? schemaInput.max_length,
    format: input.format || schemaInput.format,
    error: input.error || schemaInput.error,
  };
}

function mergeFormInputsWithSchema(
  inputs: CardInput[],
  payloadSchema: Record<string, unknown> | undefined,
): CardInput[] {
  const fromSchema = schemaInputs(payloadSchema);
  if (fromSchema.length === 0) return inputs;
  const byName = new Map(fromSchema.map((input) => [input.name, input]));
  const merged = inputs.map((input) => {
    const schemaInput = byName.get(input.name);
    if (!schemaInput) return input;
    byName.delete(input.name);
    return mergeSchemaInput(input, schemaInput);
  });
  for (const input of byName.values()) merged.push(input);
  return merged.filter((input) => !RESERVED_FORM_FIELD_NAMES.has(input.name));
}

function buildButton(
  action: CardActionConfig,
  context: CardBuildContext,
): CardButton {
  const fallback = DEFAULT_ACTIONS[action.id] || { label: action.id };
  const actionKind = action.action_kind;
  if (actionKind === 'interrupt_resume') {
    if (!context.interruptId) {
      throw new Error(
        `Card action "${action.id}" requires interruptId for interrupt resume`,
      );
    }
    if (
      context.allowedActions &&
      action.resume_action &&
      !context.allowedActions.includes(action.resume_action)
    ) {
      throw new Error(
        `Card action "${action.id}" resume_action "${action.resume_action}" is not allowed by current interrupt`,
      );
    }
  }

  const platformAction =
    actionKind === 'interrupt_resume'
      ? 'workflow_interrupt_resume'
      : actionKind === 'workflow_control'
        ? action.workflow_control_action || action.id
        : action.id;

  return {
    id: action.id,
    label: action.label || fallback.label,
    type: action.type || fallback.type,
    value: {
      ...(action.value || {}),
      ...(context.workflowId ? { workflow_id: context.workflowId } : {}),
      ...(context.interruptId ? { interrupt_id: context.interruptId } : {}),
      ...(action.resume_action ? { resume_action: action.resume_action } : {}),
      ...(context.payloadSchema
        ? { resume_payload_schema: JSON.stringify(context.payloadSchema) }
        : {}),
      ...(context.groupFolder ? { group_folder: context.groupFolder } : {}),
      action: platformAction,
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
    ? renderTemplate(
        cardConfig.body_template,
        context.vars,
        context.roleFolders,
      )
    : undefined;
  const buttons = cardConfig.actions?.map((action) =>
    buildButton(action, context),
  );

  let form: CardForm | undefined;
  if (cardConfig.form) {
    form = {
      name: cardConfig.form.name,
      inputs: mergeFormInputsWithSchema(
        cardConfig.form.fields.map((field) => ({
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
        context.payloadSchema,
      ),
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
      body: renderTemplate(
        section.body_template,
        context.vars,
        context.roleFolders,
      ),
      buttons: section.actions?.map((action) => buildButton(action, context)),
    })),
  };
}
