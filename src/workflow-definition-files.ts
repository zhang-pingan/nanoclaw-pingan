import fs from 'fs';
import path from 'path';

import {
  WorkflowDefinitionRegistry,
  WorkflowDefinitionVersionBundle,
} from './workflow-definition.js';
import { featureResources } from './features/registry.js';

export const WORKFLOW_DEFINITION_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const WORKFLOW_DEFINITIONS_RELATIVE_DIR =
  'container/workflow-definitions';

function getContainerDir(): string {
  return path.join(process.cwd(), 'container');
}

export function getWorkflowDefinitionsDir(): string {
  return path.join(getContainerDir(), 'workflow-definitions');
}

export function validateWorkflowDefinitionKey(key: string): string | null {
  if (!key.trim()) return 'workflow definition key is required';
  if (!WORKFLOW_DEFINITION_KEY_PATTERN.test(key)) {
    return `workflow definition key "${key}" 只能包含字母、数字、下划线和中划线`;
  }
  return null;
}

export function getWorkflowDefinitionFilePath(key: string): string {
  const keyError = validateWorkflowDefinitionKey(key);
  if (keyError) throw new Error(keyError);
  return path.join(getWorkflowDefinitionsDir(), `${key}.json`);
}

function ensureWorkflowDefinitionsDir(): void {
  fs.mkdirSync(getWorkflowDefinitionsDir(), { recursive: true });
}

function isWorkflowDefinitionVersionBundle(
  input: unknown,
): input is WorkflowDefinitionVersionBundle {
  return (
    !!input &&
    typeof input === 'object' &&
    'key' in input &&
    typeof (input as { key?: unknown }).key === 'string' &&
    'versions' in input &&
    Array.isArray((input as { versions?: unknown }).versions)
  );
}

interface WorkflowDefinitionSourceDir {
  dir: string;
  label: string;
  featureId: string | null;
}

export interface WorkflowDefinitionSource {
  featureId: string | null;
  label: string;
  dir: string;
  filePath: string;
}

function getWorkflowDefinitionSourceDirs(): WorkflowDefinitionSourceDir[] {
  return [
    { dir: getWorkflowDefinitionsDir(), label: 'core', featureId: null },
    ...featureResources.list('workflowDefinitions').map((source) => ({
      dir: source.dir,
      label: `feature:${source.featureId}`,
      featureId: source.featureId,
    })),
  ];
}

function readWorkflowDefinitionBundleFile(
  dir: string,
  fileName: string,
): WorkflowDefinitionVersionBundle {
  const key = path.basename(fileName, '.json');
  const keyError = validateWorkflowDefinitionKey(key);
  if (keyError) throw new Error(`${fileName}: ${keyError}`);

  const filePath = path.join(dir, fileName);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!isWorkflowDefinitionVersionBundle(raw)) {
    throw new Error(
      `${fileName}: workflow definition 文件必须是单个 WorkflowDefinitionVersionBundle`,
    );
  }
  if (raw.key !== key) {
    throw new Error(
      `${fileName}: workflow definition key mismatch: file key "${key}" != bundle.key "${raw.key}"`,
    );
  }
  return raw;
}

export function readWorkflowDefinitionRegistryWithSources(): {
  registry: WorkflowDefinitionRegistry;
  sources: Record<string, WorkflowDefinitionSource>;
} {
  const definitions: WorkflowDefinitionRegistry['definitions'] = {};
  const definitionSources: Record<string, WorkflowDefinitionSource> = {};
  const sources = getWorkflowDefinitionSourceDirs();

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    const files = fs
      .readdirSync(source.dir)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const bundle = readWorkflowDefinitionBundleFile(source.dir, fileName);
      if (definitions[bundle.key]) {
        throw new Error(
          `workflow definition key conflict "${bundle.key}" from ${source.label}`,
        );
      }
      definitions[bundle.key] = bundle;
      definitionSources[bundle.key] = {
        featureId: source.featureId,
        label: source.label,
        dir: source.dir,
        filePath: path.join(source.dir, fileName),
      };
    }
  }

  return { registry: { definitions }, sources: definitionSources };
}

export function readWorkflowDefinitionRegistryFromDir(): WorkflowDefinitionRegistry {
  return readWorkflowDefinitionRegistryWithSources().registry;
}

export function getWorkflowDefinitionSource(
  key: string,
): WorkflowDefinitionSource | null {
  return readWorkflowDefinitionRegistryWithSources().sources[key] || null;
}

export function getWorkflowDefinitionFeatureId(key: string): string | null {
  return getWorkflowDefinitionSource(key)?.featureId || null;
}

function assertCoreWritableWorkflowDefinition(key: string): void {
  const source = getWorkflowDefinitionSource(key);
  if (source?.featureId) {
    throw new Error(
      `Workflow definition "${key}" is owned by feature "${source.featureId}" and cannot be edited from the core editor`,
    );
  }
}

export function writeWorkflowDefinitionBundle(
  bundle: WorkflowDefinitionVersionBundle,
): void {
  const keyError = validateWorkflowDefinitionKey(bundle.key);
  if (keyError) throw new Error(keyError);
  assertCoreWritableWorkflowDefinition(bundle.key);
  ensureWorkflowDefinitionsDir();
  fs.writeFileSync(
    getWorkflowDefinitionFilePath(bundle.key),
    `${JSON.stringify(bundle, null, 2)}\n`,
    'utf-8',
  );
}

export function writeWorkflowDefinitionRegistryToDir(
  registry: WorkflowDefinitionRegistry,
): void {
  ensureWorkflowDefinitionsDir();
  for (const key of Object.keys(registry.definitions)) {
    assertCoreWritableWorkflowDefinition(key);
  }

  for (const [key, bundle] of Object.entries(registry.definitions)) {
    if (bundle.key !== key) {
      throw new Error(
        `workflow definition bundle key mismatch: object key "${key}" != bundle.key "${bundle.key}"`,
      );
    }
    writeWorkflowDefinitionBundle(bundle);
  }

  const activeFiles = new Set(
    Object.keys(registry.definitions).map((key) => `${key}.json`),
  );
  for (const fileName of fs.readdirSync(getWorkflowDefinitionsDir())) {
    if (fileName.endsWith('.json') && !activeFiles.has(fileName)) {
      fs.unlinkSync(path.join(getWorkflowDefinitionsDir(), fileName));
    }
  }
}
