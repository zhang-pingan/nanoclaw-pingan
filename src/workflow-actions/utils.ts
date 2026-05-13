export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function getPathValue(value: unknown, pathName: string): unknown {
  if (!pathName) return undefined;
  let current = value;
  for (const part of pathName.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
