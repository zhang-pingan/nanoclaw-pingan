import { assertJsonObject } from './strict-json.js';
import type { VersionedRef } from './types.js';

export const VERSIONED_REF_ID_PATTERN =
  '^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,253}[A-Za-z0-9])?$';
export const VERSIONED_REF_VERSION_PATTERN =
  '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$';
export const VERSIONED_REF_KEYS = ['id', 'version'] as const;
export const VERSIONED_REF_MUTABLE_VERSIONS = [
  'current',
  'head',
  'latest',
  'main',
  'master',
  'next',
  'snapshot',
] as const;

const idPattern = new RegExp(VERSIONED_REF_ID_PATTERN);
const versionPattern = new RegExp(VERSIONED_REF_VERSION_PATTERN);
const mutableVersions = new Set<string>(VERSIONED_REF_MUTABLE_VERSIONS);

export class VersionedRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionedRefError';
  }
}

export function parseVersionedRef(value: unknown): VersionedRef {
  assertJsonObject(value);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== VERSIONED_REF_KEYS.length ||
    keys.some((key, index) => key !== VERSIONED_REF_KEYS[index])
  ) {
    throw new VersionedRefError(
      'VersionedRef must contain exactly id and version',
    );
  }
  if (typeof value.id !== 'string' || !idPattern.test(value.id)) {
    throw new VersionedRefError('VersionedRef.id is not a stable ASCII id');
  }
  if (
    typeof value.version !== 'string' ||
    !versionPattern.test(value.version) ||
    mutableVersions.has(value.version.toLowerCase()) ||
    /(?:^|[._-])[xX](?:$|[._-])/.test(value.version)
  ) {
    throw new VersionedRefError(
      'VersionedRef.version must be an exact immutable version token',
    );
  }
  return { id: value.id, version: value.version };
}
