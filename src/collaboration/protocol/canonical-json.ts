export function compareUnicodeCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUnicodeCodeUnits(left, right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  return value;
}

export function canonicalJsonStringify(
  value: unknown,
  space?: string | number,
): string {
  return JSON.stringify(canonicalJsonValue(value), null, space);
}
