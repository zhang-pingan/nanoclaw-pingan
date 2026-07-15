import path from 'path';

import { DATA_DIR } from '../config.js';

export interface FeatureDataRoot {
  featureId: string;
  mode: 'managed' | 'external';
  rootPath: string;
  readonly?: boolean;
  rootId?: string;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const externalFeatureDataRoots = new Map<string, FeatureDataRoot>();

function assertSafeId(label: string, value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    !SAFE_ID_PATTERN.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    path.isAbsolute(trimmed)
  ) {
    throw new Error(`${label} "${value}" is not a safe path segment`);
  }
  return trimmed;
}

function externalRootKey(featureId: string, rootId: string): string {
  return `${featureId}:${rootId}`;
}

export function getFeatureDataRoot(featureId: string): FeatureDataRoot {
  const safeFeatureId = assertSafeId('feature_id', featureId);
  return {
    featureId: safeFeatureId,
    mode: 'managed',
    rootPath: path.join(DATA_DIR, 'features', safeFeatureId),
    readonly: false,
  };
}

export function registerExternalFeatureDataRoot(input: {
  featureId: string;
  rootId: string;
  rootPath: string;
  readonly?: boolean;
}): FeatureDataRoot {
  const featureId = assertSafeId('feature_id', input.featureId);
  const rootId = assertSafeId('external feature data root id', input.rootId);
  const root: FeatureDataRoot = {
    featureId,
    rootId,
    mode: 'external',
    rootPath: path.resolve(input.rootPath),
    readonly: input.readonly,
  };
  externalFeatureDataRoots.set(externalRootKey(featureId, rootId), root);
  return root;
}

export function getExternalFeatureDataRoot(
  featureId: string,
  rootId: string,
): FeatureDataRoot | undefined {
  return externalFeatureDataRoots.get(
    externalRootKey(
      assertSafeId('feature_id', featureId),
      assertSafeId('external feature data root id', rootId),
    ),
  );
}

export function listExternalFeatureDataRoots(
  featureId: string,
): FeatureDataRoot[] {
  const safeFeatureId = assertSafeId('feature_id', featureId);
  return Array.from(externalFeatureDataRoots.values())
    .filter((root) => root.featureId === safeFeatureId)
    .sort((a, b) => (a.rootId || '').localeCompare(b.rootId || ''));
}
