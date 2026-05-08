import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

export interface WorkflowEvaluatorConfig {
  id: string;
  type: 'deterministic' | 'ai' | 'hybrid';
  deterministic?: {
    artifact_contract?: string;
    required_checks?: string[];
  };
  ai?: {
    enabled: boolean;
    model?: string;
    rubric: string;
    max_context_bytes?: number;
  };
  status_mapping?: {
    artifact_missing?: 'pending' | 'failed';
    schema_invalid?: 'failed';
    tests_failed?: 'needs_revision' | 'failed';
    ai_uncertain?: 'pending' | 'needs_revision' | 'failed';
  };
}

let cachedEvaluators: Record<string, WorkflowEvaluatorConfig> | null = null;

function evaluatorsDir(): string {
  return path.join(PROJECT_ROOT, 'container', 'workflow-evaluators');
}

export function loadWorkflowEvaluatorRegistry(): Record<
  string,
  WorkflowEvaluatorConfig
> {
  if (cachedEvaluators) return cachedEvaluators;
  const dir = evaluatorsDir();
  const registry: Record<string, WorkflowEvaluatorConfig> = {};
  if (!fs.existsSync(dir)) {
    cachedEvaluators = registry;
    return registry;
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(dir, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as
        | WorkflowEvaluatorConfig
        | WorkflowEvaluatorConfig[];
      const configs = Array.isArray(parsed) ? parsed : [parsed];
      for (const config of configs) {
        if (!config?.id || !config.type) continue;
        registry[config.id] = config;
      }
    } catch (err) {
      logger.error({ err, fullPath }, 'Failed to load workflow evaluator config');
    }
  }

  cachedEvaluators = registry;
  return registry;
}

export function getWorkflowEvaluatorConfig(
  ref: string | undefined,
): WorkflowEvaluatorConfig | undefined {
  if (!ref) return undefined;
  return loadWorkflowEvaluatorRegistry()[ref];
}

export function clearWorkflowEvaluatorRegistryCacheForTest(): void {
  cachedEvaluators = null;
}
