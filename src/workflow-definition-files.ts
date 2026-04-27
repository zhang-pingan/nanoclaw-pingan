import fs from 'fs';
import path from 'path';

import {
  WorkflowDefinitionRegistry,
  WorkflowDefinitionVersionBundle,
} from './workflow-definition.js';

export const WORKFLOW_DEFINITION_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const WORKFLOW_DEFINITIONS_RELATIVE_DIR =
  'container/skills/workflow-definitions';

function getSkillsDir(): string {
  return path.join(process.cwd(), 'container', 'skills');
}

export function getWorkflowDefinitionsDir(): string {
  return path.join(getSkillsDir(), 'workflow-definitions');
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

function readWorkflowDefinitionBundleFile(
  fileName: string,
): WorkflowDefinitionVersionBundle {
  const key = path.basename(fileName, '.json');
  const keyError = validateWorkflowDefinitionKey(key);
  if (keyError) throw new Error(`${fileName}: ${keyError}`);

  const filePath = path.join(getWorkflowDefinitionsDir(), fileName);
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

export function readWorkflowDefinitionRegistryFromDir(): WorkflowDefinitionRegistry {
  const definitionsDir = getWorkflowDefinitionsDir();
  if (!fs.existsSync(definitionsDir)) {
    return { definitions: {} };
  }

  const definitions: WorkflowDefinitionRegistry['definitions'] = {};
  const files = fs
    .readdirSync(definitionsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const bundle = readWorkflowDefinitionBundleFile(fileName);
    definitions[bundle.key] = bundle;
  }

  return { definitions };
}

export function writeWorkflowDefinitionBundle(
  bundle: WorkflowDefinitionVersionBundle,
): void {
  const keyError = validateWorkflowDefinitionKey(bundle.key);
  if (keyError) throw new Error(keyError);
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
