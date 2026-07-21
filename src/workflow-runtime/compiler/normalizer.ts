import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';

export const PLAN_DOMAIN_SEPARATOR = 'icarus:workflow-graph-plan:2\n';
export const CONDITION_PROGRAM_DOMAIN_SEPARATOR =
  'icarus:workflow-condition-program:2\n';
export const STATIC_CLOSURE_MEMBER_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure-member:1\n';
export const STATIC_CLOSURE_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure:1\n';

export function semanticHash(domain: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(domain, value);
}

export function withHash<T extends JsonObject>(
  domain: string,
  field: string,
  value: JsonObject,
): T {
  const withoutHash = { ...value };
  delete withoutHash[field];
  return {
    ...withoutHash,
    [field]: semanticHash(domain, withoutHash),
  } as T;
}

export function compareStableId(left: JsonObject, right: JsonObject): number {
  return compareAscii(String(left.id), String(right.id));
}

export function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortObjectKeys<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObjectKeys(value[key])]),
    ) as T;
  }
  return value;
}

export function expressionSteps(value: JsonValue): number {
  if (!value || typeof value !== 'object') return 1;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (sum, entry) => sum + expressionSteps(entry),
      1,
    );
  }
  if (Array.isArray(value.args)) {
    return (
      1 +
      value.args.reduce(
        (sum: number, entry: JsonValue) => sum + expressionSteps(entry),
        0,
      )
    );
  }
  if (value.arg && typeof value.arg === 'object') {
    return 1 + expressionSteps(value.arg);
  }
  return 1;
}

export function referencedEdgeIds(trigger: JsonObject): string[] {
  const edgeIds = trigger.edge_ids;
  if (!Array.isArray(edgeIds)) return [];
  return edgeIds.filter((value): value is string => typeof value === 'string');
}

export function compileTriggerProgram(trigger: JsonObject): JsonObject {
  const normalizedExpression = sortObjectKeys(trigger);
  const withoutHash = {
    normalized_expression: normalizedExpression,
    referenced_edge_ids: referencedEdgeIds(trigger).sort(),
    max_steps: expressionSteps(normalizedExpression),
  };
  return {
    ...withoutHash,
    truth_program_hash: semanticHash(
      'icarus:workflow-trigger-program:1\n',
      withoutHash,
    ),
  };
}

export function pointerTokens(pointer: string | null): string[] {
  if (!pointer) return [];
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function minimumLimit(
  ...values: Array<number | null | undefined>
): number | null {
  const concrete = values.filter(
    (value): value is number => typeof value === 'number',
  );
  return concrete.length === 0 ? null : Math.min(...concrete);
}
