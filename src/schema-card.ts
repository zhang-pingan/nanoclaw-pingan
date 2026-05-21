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

function arrayEnumValues(schema: JsonObject): string[] {
  const items = asJsonObject(schema.items);
  return items ? enumValues(items) : [];
}

function firstSchemaType(schema: JsonObject): string {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const value =
      schema.type.find((item) => typeof item === 'string' && item !== 'null') ||
      schema.type.find((item) => typeof item === 'string');
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
  const arrayValues = arrayEnumValues(schema);
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
            ? 'checkbox'
            : type === 'array' && arrayValues.length > 0
              ? 'multi_select'
              : type === 'array'
                ? 'textarea'
                : format === 'binary' || format === 'file'
                  ? 'file'
                  : format === 'password' ||
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
    options: (values.length > 0 ? values : arrayValues).map((value) => ({
      value,
      label: value,
    })),
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

function schemaTypeLabel(name: string, schema: JsonObject): string {
  const values = enumValues(schema);
  if (values.length > 0) return `枚举: ${values.join(', ')}`;
  const type = firstSchemaType(schema);
  const format = typeof schema.format === 'string' ? schema.format : '';
  if (type === 'array') {
    const itemSchema = asJsonObject(schema.items) || {};
    const itemValues = enumValues(itemSchema);
    return itemValues.length > 0
      ? `多选: ${itemValues.join(', ')}`
      : '数组，使用逗号分隔或 JSON 数组';
  }
  if (format === 'binary' || format === 'file') {
    return '文件（文本命令不支持上传，请到 Web 工作台处理）';
  }
  if (format === 'password' || name.toLowerCase().includes('token')) {
    return 'token';
  }
  if (format === 'date') return '日期 YYYY-MM-DD';
  if (format === 'date-time') return '日期时间 ISO 或 YYYY-MM-DDTHH:mm';
  if (type === 'integer') return '整数';
  if (type === 'number') return '数字';
  if (type === 'boolean') return '布尔 true/false';
  return '文本';
}

function schemaConstraintLabels(schema: JsonObject): string[] {
  const constraints: string[] = [];
  if (typeof schema.minLength === 'number') {
    constraints.push(`最短 ${schema.minLength}`);
  }
  if (typeof schema.maxLength === 'number') {
    constraints.push(`最长 ${schema.maxLength}`);
  }
  if (typeof schema.minimum === 'number') {
    constraints.push(`最小 ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number') {
    constraints.push(`最大 ${schema.maximum}`);
  }
  if (typeof schema.minItems === 'number') {
    constraints.push(`至少 ${schema.minItems} 项`);
  }
  if (typeof schema.maxItems === 'number') {
    constraints.push(`最多 ${schema.maxItems} 项`);
  }
  return constraints;
}

export function schemaFieldHints(schema: JsonObject | undefined): string[] {
  if (!schema || schema.type !== 'object') return [];
  const properties = asJsonObject(schema.properties) || {};
  const required = new Set(stringArray(schema.required));
  return Object.entries(properties)
    .filter(([name]) => !CARD_FORM_RESERVED_FIELD_NAMES.has(name))
    .map(([name, raw]) => {
      const propertySchema = asJsonObject(raw) || {};
      const parts = [
        schemaTypeLabel(name, propertySchema),
        ...schemaConstraintLabels(propertySchema),
      ];
      return `- ${name}${required.has(name) ? '（必填）' : ''}: ${parts.join('，')}`;
    });
}
