import { CardConfig } from './card-config.js';
import {
  readCardRegistryFromDir,
  writeCardRegistryToDir,
} from './card-files.js';
import {
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
  WorkflowDefinitionVersionBundle,
} from './workflow-definition.js';
import { getPublishedWorkflowDefinitions } from './workflow-definition-registry.js';
import {
  readWorkflowDefinitionRegistryFromDir,
  validateWorkflowDefinitionKey,
  writeWorkflowDefinitionBundle,
  writeWorkflowDefinitionRegistryToDir,
} from './workflow-definition-files.js';
import {
  compileWorkflowDefinition,
  validateWorkflowDefinition,
} from './workflow-compiler.js';

function sortVersions(versions: WorkflowDefinition[]): WorkflowDefinition[] {
  return [...versions].sort((a, b) => a.version - b.version);
}

export function readWorkflowDefinitionRegistry(): WorkflowDefinitionRegistry {
  return readWorkflowDefinitionRegistryFromDir();
}

export function writeWorkflowDefinitionRegistry(
  registry: WorkflowDefinitionRegistry,
): void {
  writeWorkflowDefinitionRegistryToDir(registry);
}

export function readCardRegistry(): Record<string, Record<string, CardConfig>> {
  return readCardRegistryFromDir();
}

export function writeCardRegistry(
  cards: Record<string, Record<string, CardConfig>>,
): void {
  writeCardRegistryToDir(cards);
}

export function listWorkflowDefinitionBundles(): Array<{
  key: string;
  label?: string;
  description?: string;
  published_version: number | null;
  draft_version: number | null;
  version_count: number;
}> {
  const registry = readWorkflowDefinitionRegistry();
  return Object.values(registry.definitions)
    .map((bundle) => {
      const versions = sortVersions(bundle.versions);
      const published = versions.filter(
        (version) => version.status === 'published',
      );
      const drafts = versions.filter((version) => version.status === 'draft');
      return {
        key: bundle.key,
        label: bundle.label,
        description: bundle.description,
        published_version: published.length
          ? published[published.length - 1].version
          : null,
        draft_version: drafts.length ? drafts[drafts.length - 1].version : null,
        version_count: versions.length,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function getWorkflowDefinitionBundle(
  key: string,
): WorkflowDefinitionVersionBundle | null {
  const registry = readWorkflowDefinitionRegistry();
  return registry.definitions[key] || null;
}

export function getPublishedWorkflowDefinition(
  key: string,
): WorkflowDefinition | null {
  const registry = readWorkflowDefinitionRegistry();
  const published = getPublishedWorkflowDefinitions(registry);
  return published.definitions[key] || null;
}

export function saveWorkflowDefinitionDraft(input: {
  key: string;
  label?: string;
  description?: string;
  definition: Omit<WorkflowDefinition, 'key' | 'status' | 'version'> & {
    version?: number;
  };
}): { definition?: WorkflowDefinition; error?: string } {
  const keyError = validateWorkflowDefinitionKey(input.key);
  if (keyError) return { error: keyError };

  const registry = readWorkflowDefinitionRegistry();
  const bundle = registry.definitions[input.key] || {
    key: input.key,
    label: input.label,
    description: input.description,
    versions: [],
  };

  const existingVersions = sortVersions(bundle.versions);
  const existingDraft = existingVersions.find(
    (version) => version.status === 'draft',
  );
  const nextVersion =
    input.definition.version ||
    existingDraft?.version ||
    (existingVersions.length
      ? existingVersions[existingVersions.length - 1].version + 1
      : 1);

  const definition: WorkflowDefinition = {
    ...input.definition,
    key: input.key,
    version: nextVersion,
    status: 'draft',
  };

  const versions = existingVersions.filter(
    (version) =>
      !(version.status === 'draft' && version.version === nextVersion),
  );
  versions.push(definition);

  registry.definitions[input.key] = {
    key: input.key,
    label: input.label ?? bundle.label ?? definition.name,
    description:
      input.description ?? bundle.description ?? definition.description,
    versions: sortVersions(versions),
  };

  writeWorkflowDefinitionBundle(registry.definitions[input.key]);
  return { definition };
}

export function publishWorkflowDefinitionVersion(input: {
  key: string;
  version?: number;
}): { definition?: WorkflowDefinition; error?: string } {
  const keyError = validateWorkflowDefinitionKey(input.key);
  if (keyError) return { error: keyError };

  const registry = readWorkflowDefinitionRegistry();
  const bundle = registry.definitions[input.key];
  if (!bundle) {
    return { error: `Workflow definition "${input.key}" 不存在` };
  }

  const versions = sortVersions(bundle.versions);
  const target =
    (input.version
      ? versions.find((version) => version.version === input.version)
      : [...versions]
          .reverse()
          .find((version) => version.status === 'draft')) || null;

  if (!target) {
    return { error: `Workflow definition "${input.key}" 没有可发布的版本` };
  }

  const compiledErrors = validateWorkflowDefinition(target);
  if (compiledErrors.length > 0) {
    return { error: compiledErrors.join('; ') };
  }

  const publishable = compileWorkflowDefinition(target);
  if (!publishable) {
    return { error: `Workflow definition "${input.key}" 编译失败` };
  }

  bundle.versions = versions.map((version) => {
    if (version.version === target.version) {
      return { ...version, status: 'published' as const };
    }
    if (version.status === 'published') {
      return { ...version, status: 'archived' as const };
    }
    return version;
  });

  writeWorkflowDefinitionBundle(bundle);
  return {
    definition: bundle.versions.find(
      (version) => version.version === target.version,
    ),
  };
}

export function deleteWorkflowDefinitionVersion(input: {
  key: string;
  version: number;
}): { ok?: true; error?: string } {
  const keyError = validateWorkflowDefinitionKey(input.key);
  if (keyError) return { error: keyError };

  const registry = readWorkflowDefinitionRegistry();
  const bundle = registry.definitions[input.key];
  if (!bundle) {
    return { error: `Workflow definition "${input.key}" 不存在` };
  }

  const versions = sortVersions(bundle.versions);
  const target = versions.find((version) => version.version === input.version);
  if (!target) {
    return {
      error: `Workflow definition "${input.key}" 不存在版本 v${input.version}`,
    };
  }
  if (target.status === 'published') {
    return { error: '已发布版本不支持直接删除' };
  }

  const remaining = versions.filter(
    (version) => version.version !== input.version,
  );
  if (!remaining.length) {
    return { error: '至少需要保留一个版本' };
  }
  if (!remaining.some((version) => version.status === 'published')) {
    return { error: '删除后将没有 published 版本，无法执行' };
  }

  bundle.versions = remaining;
  writeWorkflowDefinitionBundle(bundle);
  return { ok: true };
}
