import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { readEnvFile } from '../env.js';

export interface FeatureRuntimeConfig {
  enabled: string[];
  source: 'default' | 'local' | 'env';
}

export const LOCAL_FEATURES_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  'local',
  'features.json',
);

function parseCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function loadFeatureRuntimeConfig(): FeatureRuntimeConfig {
  const env = readEnvFile(['ICARUS_FEATURES']);
  const envValue = process.env.ICARUS_FEATURES ?? env.ICARUS_FEATURES;
  if (envValue !== undefined) {
    return {
      enabled: unique(parseCsv(envValue)),
      source: 'env',
    };
  }

  if (!fs.existsSync(LOCAL_FEATURES_CONFIG_PATH)) {
    return { enabled: [], source: 'default' };
  }

  const parsed = JSON.parse(
    fs.readFileSync(LOCAL_FEATURES_CONFIG_PATH, 'utf-8'),
  ) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${LOCAL_FEATURES_CONFIG_PATH}: expected an object`);
  }
  const enabled = (parsed as { enabled?: unknown }).enabled;
  if (enabled === undefined) {
    return { enabled: [], source: 'local' };
  }
  if (!Array.isArray(enabled)) {
    throw new Error(`${LOCAL_FEATURES_CONFIG_PATH}: enabled must be an array`);
  }
  const ids = enabled.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(
        `${LOCAL_FEATURES_CONFIG_PATH}: enabled[${index}] must be a non-empty string`,
      );
    }
    return item.trim();
  });
  return { enabled: unique(ids), source: 'local' };
}
