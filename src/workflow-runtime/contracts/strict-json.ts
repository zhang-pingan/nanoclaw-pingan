import {
  printParseErrorCode,
  visit,
  type JSONPath,
  type ParseErrorCode,
} from 'jsonc-parser';
import { types as utilTypes } from 'node:util';

import type { JsonObject, JsonValue } from './types.js';

export const STRICT_JSON_PARSER_PACKAGE = 'jsonc-parser';
export const STRICT_JSON_PARSER_VERSION = '3.3.1';
export const STRICT_JSON_PARSE_OPTIONS = {
  allowEmptyContent: false,
  allowTrailingComma: false,
  disallowComments: true,
} as const;

export type StrictJsonErrorCode =
  | 'json_syntax_invalid'
  | 'json_duplicate_key'
  | 'json_non_finite_number'
  | 'json_unsafe_integer'
  | 'json_invalid_unicode'
  | 'json_value_unsupported';

export class StrictJsonError extends Error {
  constructor(
    readonly code: StrictJsonErrorCode,
    message: string,
    readonly pointer: string,
    readonly offset: number | null = null,
    readonly line: number | null = null,
    readonly column: number | null = null,
  ) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

interface ParseIssue {
  code: StrictJsonErrorCode;
  message: string;
  pointer: string;
  offset: number;
  line: number;
  column: number;
}

function escapePointerToken(token: string | number): string {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function jsonPointer(path: JSONPath): string {
  return path.length === 0 ? '' : `/${path.map(escapePointerToken).join('/')}`;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function numberIssue(value: number): StrictJsonErrorCode | null {
  if (!Number.isFinite(value)) return 'json_non_finite_number';
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return 'json_unsafe_integer';
  }
  return null;
}

function syntaxIssue(
  error: ParseErrorCode,
  offset: number,
  line: number,
  column: number,
): ParseIssue {
  return {
    code: 'json_syntax_invalid',
    message: `Invalid strict JSON: ${printParseErrorCode(error)}`,
    pointer: '',
    offset,
    line,
    column,
  };
}

export function strictParseJson(source: string): JsonValue {
  const issues: ParseIssue[] = [];
  const objectProperties: Array<Set<string>> = [];

  visit(
    source,
    {
      onObjectBegin: () => {
        objectProperties.push(new Set());
      },
      onObjectProperty: (
        property,
        offset,
        _length,
        line,
        column,
        pathSupplier,
      ) => {
        const seen = objectProperties.at(-1);
        const path = [...pathSupplier(), property];
        if (seen?.has(property)) {
          issues.push({
            code: 'json_duplicate_key',
            message: `Duplicate object key at ${jsonPointer(path)}`,
            pointer: jsonPointer(path),
            offset,
            line,
            column,
          });
        } else {
          seen?.add(property);
        }
        if (hasUnpairedSurrogate(property)) {
          issues.push({
            code: 'json_invalid_unicode',
            message: `Unpaired surrogate in object key at ${jsonPointer(path)}`,
            pointer: jsonPointer(path),
            offset,
            line,
            column,
          });
        }
      },
      onObjectEnd: () => {
        objectProperties.pop();
      },
      onLiteralValue: (value, offset, _length, line, column, pathSupplier) => {
        const pointer = jsonPointer(pathSupplier());
        if (typeof value === 'number') {
          const code = numberIssue(value);
          if (code) {
            issues.push({
              code,
              message: `Unsupported JSON number at ${pointer || '/'}`,
              pointer,
              offset,
              line,
              column,
            });
          }
        } else if (typeof value === 'string' && hasUnpairedSurrogate(value)) {
          issues.push({
            code: 'json_invalid_unicode',
            message: `Unpaired surrogate at ${pointer || '/'}`,
            pointer,
            offset,
            line,
            column,
          });
        }
      },
      onError: (error, offset, _length, line, column) => {
        issues.push(syntaxIssue(error, offset, line, column));
      },
    },
    STRICT_JSON_PARSE_OPTIONS,
  );

  if (issues.length > 0) {
    issues.sort((left, right) => left.offset - right.offset);
    const issue = issues[0];
    throw new StrictJsonError(
      issue.code,
      issue.message,
      issue.pointer,
      issue.offset,
      issue.line,
      issue.column,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new StrictJsonError(
      'json_syntax_invalid',
      `Invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
      '',
    );
  }
  assertJsonValue(value);
  return value;
}

export function strictParseJsonBytes(source: Uint8Array): JsonValue {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new StrictJsonError(
      'json_invalid_unicode',
      'Input is not valid UTF-8',
      '',
    );
  }
  return strictParseJson(decoded);
}

export function assertJsonValue(
  value: unknown,
  pointer = '',
  ancestors: WeakSet<object> = new WeakSet(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'number') {
      const code = numberIssue(value);
      if (code) {
        throw new StrictJsonError(
          code,
          `Unsupported JSON number at ${pointer || '/'}`,
          pointer,
        );
      }
    }
    if (typeof value === 'string' && hasUnpairedSurrogate(value)) {
      throw new StrictJsonError(
        'json_invalid_unicode',
        `Unpaired surrogate at ${pointer || '/'}`,
        pointer,
      );
    }
    return;
  }

  if (typeof value !== 'object') {
    throw new StrictJsonError(
      'json_value_unsupported',
      `Non-JSON value at ${pointer || '/'}`,
      pointer,
    );
  }
  if (utilTypes.isProxy(value)) {
    throw new StrictJsonError(
      'json_value_unsupported',
      `Proxy value at ${pointer || '/'}`,
      pointer,
    );
  }
  if (ancestors.has(value)) {
    throw new StrictJsonError(
      'json_value_unsupported',
      `Cyclic value at ${pointer || '/'}`,
      pointer,
    );
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeys = new Set([
        'length',
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      if (
        ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
      ) {
        throw new StrictJsonError(
          'json_value_unsupported',
          `Array has non-JSON properties at ${pointer || '/'}`,
          pointer,
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new StrictJsonError(
            'json_value_unsupported',
            `Sparse array at ${pointer || '/'}`,
            pointer,
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new StrictJsonError(
            'json_value_unsupported',
            `Array accessor at ${pointer || '/'}`,
            pointer,
          );
        }
        assertJsonValue(
          descriptor.value,
          `${pointer}/${escapePointerToken(index)}`,
          ancestors,
        );
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StrictJsonError(
        'json_value_unsupported',
        `Non-JSON object at ${pointer || '/'}`,
        pointer,
      );
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new StrictJsonError(
          'json_value_unsupported',
          `Symbol key at ${pointer || '/'}`,
          pointer,
        );
      }
      if (hasUnpairedSurrogate(key)) {
        const keyPointer = `${pointer}/${escapePointerToken(key)}`;
        throw new StrictJsonError(
          'json_invalid_unicode',
          `Unpaired surrogate in object key at ${keyPointer}`,
          keyPointer,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new StrictJsonError(
          'json_value_unsupported',
          `Accessor or hidden property at ${pointer || '/'}`,
          pointer,
        );
      }
      assertJsonValue(
        descriptor.value,
        `${pointer}/${escapePointerToken(key)}`,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

export function assertJsonObject(value: unknown): asserts value is JsonObject {
  assertJsonValue(value);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new StrictJsonError(
      'json_value_unsupported',
      'Expected a JSON object',
      '',
    );
  }
}
