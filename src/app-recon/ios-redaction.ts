import type { JsonValue } from './types.js';

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|session[_-]?id|phone|mobile|id[_-]?card|identity|latitude|longitude|location|address)/i;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const PHONE_PATTERN = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const ID_CARD_PATTERN = /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g;
const COOKIE_PAIR_PATTERN =
  /\b([A-Za-z0-9_-]*(?:token|session|sid|cookie|auth)[A-Za-z0-9_-]*)=([^;\s]+)/gi;
const COORDINATE_PAIR_PATTERN =
  /\b(?:lat|latitude|lng|lon|longitude)\s*[:=]\s*-?\d{1,3}\.\d{4,}/gi;

export interface RedactionResult<T> {
  value: T;
  fields: string[];
}

function redactString(value: string, path: string, fields: Set<string>): string {
  let next = value;
  const replacements: Array<[RegExp, string]> = [
    [JWT_PATTERN, '[redacted-jwt]'],
    [BEARER_PATTERN, 'Bearer [redacted]'],
    [PHONE_PATTERN, '[redacted-phone]'],
    [ID_CARD_PATTERN, '[redacted-id-card]'],
    [COOKIE_PAIR_PATTERN, '$1=[redacted]'],
    [COORDINATE_PAIR_PATTERN, '[redacted-coordinate]'],
  ];

  for (const [pattern, replacement] of replacements) {
    if (pattern.test(next)) {
      fields.add(path);
      next = next.replace(pattern, replacement);
    }
  }
  return next;
}

function redactValue(value: unknown, path: string, fields: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactString(value, path, fields);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, `${path}.${index}`, fields),
    );
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        fields.add(childPath);
        out[key] = child === '' || child === null || child === undefined
          ? child
          : '[redacted]';
        continue;
      }
      out[key] = redactValue(child, childPath, fields);
    }
    return out;
  }
  return String(value);
}

export function redactJson<T extends JsonValue | Record<string, unknown>>(
  value: T,
): RedactionResult<T> {
  const fields = new Set<string>();
  const redacted = redactValue(value, '', fields) as T;
  return {
    value: redacted,
    fields: Array.from(fields).sort(),
  };
}

export function redactText(value: string, path = 'text'): RedactionResult<string> {
  const fields = new Set<string>();
  return {
    value: redactString(value, path, fields),
    fields: Array.from(fields).sort(),
  };
}
