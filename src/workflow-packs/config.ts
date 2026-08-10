import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../config.js';
import { strictParseJsonBytes } from '../workflow-runtime/contracts/strict-json.js';
import { assertSafeWorkflowPackId } from './manifest.js';

export interface WorkflowPackDesiredConfig {
  readonly enabled: string[];
  readonly source: 'default' | 'local';
}

export const WORKFLOW_PACK_SOURCE_ROOT = path.join(
  PROJECT_ROOT,
  'workflow-packs',
);
export const WORKFLOW_PACK_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  'local',
  'workflow-packs.json',
);

function normalizeIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const ids = value.map((item, index) => {
    if (typeof item !== 'string' || !item || item.trim() !== item) {
      throw new Error(`${label}[${index}] must be a non-empty trimmed string`);
    }
    return assertSafeWorkflowPackId(item);
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export function loadWorkflowPackDesiredConfig(
  configPath = WORKFLOW_PACK_CONFIG_PATH,
): WorkflowPackDesiredConfig {
  if (!fs.existsSync(configPath)) return { enabled: [], source: 'default' };
  const parsed = strictParseJsonBytes(fs.readFileSync(configPath));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected a closed object`);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'enabled') {
    throw new Error(`${configPath}: only the enabled key is allowed`);
  }
  return {
    enabled: normalizeIds(parsed.enabled, `${configPath}: enabled`),
    source: 'local',
  };
}

export function saveWorkflowPackDesiredConfig(
  enabled: readonly string[],
  configPath = WORKFLOW_PACK_CONFIG_PATH,
): void {
  const normalized = normalizeIds([...enabled], 'enabled');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ enabled: normalized }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(temporary, configPath);
}
