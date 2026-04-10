import fs from 'fs';
import path from 'path';

import { CardConfig } from './card-config.js';
import {
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
  WorkflowDefinitionVersionBundle,
} from './workflow-definition.js';
import {
  getPublishedWorkflowDefinitions,
  normalizeWorkflowDefinitionRegistry,
} from './workflow-definition-registry.js';
import { compileWorkflowDefinition, validateWorkflowDefinition } from './workflow-compiler.js';

const SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const DEFINITIONS_PATH = path.join(SKILLS_DIR, 'workflow-definitions.json');
const CARDS_PATH = path.join(SKILLS_DIR, 'cards.json');

function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

function sortVersions(
  versions: WorkflowDefinition[],
): WorkflowDefinition[] {
  return [...versions].sort((a, b) => a.version - b.version);
}

export function readWorkflowDefinitionRegistry(): WorkflowDefinitionRegistry {
  if (!fs.existsSync(DEFINITIONS_PATH)) {
    return { definitions: {} };
  }
  const raw = JSON.parse(fs.readFileSync(DEFINITIONS_PATH, 'utf-8')) as unknown;
  return normalizeWorkflowDefinitionRegistry(raw);
}

export function writeWorkflowDefinitionRegistry(
  registry: WorkflowDefinitionRegistry,
): void {
  ensureSkillsDir();
  fs.writeFileSync(DEFINITIONS_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

export function readCardRegistry(): Record<string, Record<string, CardConfig>> {
  if (!fs.existsSync(CARDS_PATH)) return {};
  return JSON.parse(
    fs.readFileSync(CARDS_PATH, 'utf-8'),
  ) as Record<string, Record<string, CardConfig>>;
}

export function writeCardRegistry(
  cards: Record<string, Record<string, CardConfig>>,
): void {
  ensureSkillsDir();
  fs.writeFileSync(CARDS_PATH, `${JSON.stringify(cards, null, 2)}\n`, 'utf-8');
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
      const published = versions.filter((version) => version.status === 'published');
      const drafts = versions.filter((version) => version.status === 'draft');
      return {
        key: bundle.key,
        label: bundle.label,
        description: bundle.description,
        published_version: published.length ? published[published.length - 1].version : null,
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
  const registry = readWorkflowDefinitionRegistry();
  const bundle = registry.definitions[input.key] || {
    key: input.key,
    label: input.label,
    description: input.description,
    versions: [],
  };

  const existingVersions = sortVersions(bundle.versions);
  const existingDraft = existingVersions.find((version) => version.status === 'draft');
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
    (version) => !(version.status === 'draft' && version.version === nextVersion),
  );
  versions.push(definition);

  registry.definitions[input.key] = {
    key: input.key,
    label: input.label ?? bundle.label ?? definition.name,
    description: input.description ?? bundle.description ?? definition.description,
    versions: sortVersions(versions),
  };

  writeWorkflowDefinitionRegistry(registry);
  return { definition };
}

export function publishWorkflowDefinitionVersion(input: {
  key: string;
  version?: number;
}): { definition?: WorkflowDefinition; error?: string } {
  const registry = readWorkflowDefinitionRegistry();
  const bundle = registry.definitions[input.key];
  if (!bundle) {
    return { error: `Workflow definition "${input.key}" 不存在` };
  }

  const versions = sortVersions(bundle.versions);
  const target =
    (input.version
      ? versions.find((version) => version.version === input.version)
      : [...versions].reverse().find((version) => version.status === 'draft')) ||
    null;

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

  writeWorkflowDefinitionRegistry(registry);
  return {
    definition: bundle.versions.find((version) => version.version === target.version),
  };
}
