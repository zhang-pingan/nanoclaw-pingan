import type { CardInput } from './types.js';

export type JsonObject = Record<string, unknown>;

export const CARD_FORM_RESERVED_FIELD_NAMES = new Set([
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
  'skipped',
]);

export function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return stringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function enumValues(schema: JsonObject): string[] {
  return Array.isArray(schema.enum)
    ? schema.enum
        .filter(
          (item): item is string | number | boolean =>
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean',
        )
        .map((item) => String(item))
    : [];
}

function firstSchemaType(schema: JsonObject): string {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const value = schema.type.find((item) => typeof item === 'string');
    if (typeof value === 'string') return value;
  }
  return 'string';
}

export function schemaPropertyToInput(
  name: string,
  schema: JsonObject,
  required: boolean,
): CardInput {
  const values = enumValues(schema);
  const type = firstSchemaType(schema);
  const format = typeof schema.format === 'string' ? schema.format : '';
  const inputType: CardInput['type'] =
    values.length > 0
      ? 'enum'
      : type === 'number'
        ? 'number'
        : type === 'integer'
          ? 'integer'
          : type === 'boolean'
            ? 'boolean'
            : type === 'array'
              ? 'textarea'
              : format === 'binary' || format === 'file'
                ? 'file'
                : format === 'password' || name.toLowerCase().includes('token')
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
    options: values.map((value) => ({ value, label: value })),
    min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
    max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
    min_length:
      typeof schema.minLength === 'number' ? schema.minLength : undefined,
    max_length:
      typeof schema.maxLength === 'number' ? schema.maxLength : undefined,
    format:
      format === 'email' ||
      format === 'uri' ||
      format === 'date' ||
      format === 'date-time'
        ? format
        : undefined,
  };
}

export function schemaInputs(schema: JsonObject | undefined): CardInput[] {
  if (!schema || schema.type !== 'object') return [];
  const properties = asJsonObject(schema.properties) || {};
  const required = new Set(stringArray(schema.required));
  return Object.entries(properties)
    .filter(([name]) => !CARD_FORM_RESERVED_FIELD_NAMES.has(name))
    .map(([name, raw]) =>
      schemaPropertyToInput(name, asJsonObject(raw) || {}, required.has(name)),
    );
}
