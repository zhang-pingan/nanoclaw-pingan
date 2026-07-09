import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import { featureResources } from './features/registry.js';
import { logger } from './logger.js';

export interface WorkflowEvaluatorConfig {
  id: string;
  type: 'deterministic' | 'ai' | 'hybrid';
  deterministic?: {
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

function evaluatorSourceDirs(): Array<{ dir: string; label: string }> {
  return [
    { dir: evaluatorsDir(), label: 'core' },
    ...featureResources.list('workflowEvaluators').map((source) => ({
      dir: source.dir,
      label: `feature:${source.featureId}`,
    })),
  ];
}

export function loadWorkflowEvaluatorRegistry(): Record<
  string,
  WorkflowEvaluatorConfig
> {
  if (cachedEvaluators) return cachedEvaluators;
  const registry: Record<string, WorkflowEvaluatorConfig> = {};

  for (const source of evaluatorSourceDirs()) {
    if (!fs.existsSync(source.dir)) continue;
    for (const entry of fs.readdirSync(source.dir)) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = path.join(source.dir, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as
          | WorkflowEvaluatorConfig
          | WorkflowEvaluatorConfig[];
        const configs = Array.isArray(parsed) ? parsed : [parsed];
        for (const config of configs) {
          if (!config?.id || !config.type) continue;
          if (registry[config.id]) {
            throw new Error(
              `workflow evaluator id conflict "${config.id}" from ${source.label}`,
            );
          }
          registry[config.id] = config;
        }
      } catch (err) {
        logger.error(
          { err, fullPath },
          'Failed to load workflow evaluator config',
        );
        if (err instanceof Error && err.message.includes('conflict')) {
          throw err;
        }
      }
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

export function clearWorkflowEvaluatorRegistryCache(): void {
  cachedEvaluators = null;
}

export function clearWorkflowEvaluatorRegistryCacheForTest(): void {
  clearWorkflowEvaluatorRegistryCache();
}
