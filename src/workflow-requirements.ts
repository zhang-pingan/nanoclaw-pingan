import fs, { type Dirent } from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  getWorkflow,
  listWorkbenchArtifactsByTask,
  listWorkbenchTasks,
} from './db.js';
import type { Workflow } from './types.js';
import {
  getWorkflowArtifactFileNameForRef,
  isValidDeliverableFileName,
} from './workflow-artifacts.js';
import type { WorkflowStorageConfig } from './workflow-definition.js';
import {
  resolveWorkflowStorageRoot,
  type ResolvedStorageRoot,
} from './workflow-storage.js';
import { WORKFLOW_CONTEXT_KEYS } from './workflow-context.js';

export interface WorkflowRequirementOption {
  requirement_name: string;
  deliverables: string[];
}

interface RequirementSource {
  service: string;
  requirementName: string;
  dir: string;
  deliverables: string[];
  updatedAt: number;
  source: 'staged' | 'workflow_artifact';
  workflowId?: string;
}

export interface WorkflowRequirementFileInput {
  filename: string;
  data: Buffer;
}

const WORKFLOW_REQUIREMENTS_DIR = path.join(
  DATA_DIR,
  'workflows',
  '_requirements',
);

function assertSafePathSegment(label: string, rawValue: string): string {
  const value = String(rawValue || '').trim();
  if (!value || value === '.' || value === '..' || /[\u0000/\\]/.test(value)) {
    throw new Error(`${label} 不能为空，且不能包含路径分隔符`);
  }
  return value;
}

function pathInsideBase(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(
    path.resolve(baseDir),
    path.resolve(targetPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function safeReaddir(dir: string): Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listRegularFiles(dir: string): string[] {
  return safeReaddir(dir)
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function latestMtimeMs(dir: string, files: string[]): number {
  return files.reduce((latest, fileName) => {
    try {
      return Math.max(latest, fs.statSync(path.join(dir, fileName)).mtimeMs);
    } catch {
      return latest;
    }
  }, 0);
}

export function getWorkflowRequirementStagingDir(
  service: string,
  requirementName: string,
): string {
  const safeService = assertSafePathSegment('服务名称', service);
  const safeRequirement = assertSafePathSegment('需求名称', requirementName);
  return path.join(WORKFLOW_REQUIREMENTS_DIR, safeService, safeRequirement);
}

export function createStagedWorkflowRequirement(input: {
  service: string;
  requirementName: string;
  files: WorkflowRequirementFileInput[];
}): WorkflowRequirementOption {
  const safeService = assertSafePathSegment('服务名称', input.service);
  const safeRequirement = assertSafePathSegment(
    '需求名称',
    input.requirementName,
  );
  const files = input.files.map((file) => {
    const filename = String(file.filename || '').trim();
    if (!isValidDeliverableFileName(filename)) {
      throw new Error(`交付物文件名非法: ${file.filename}`);
    }
    return { filename, data: file.data };
  });
  if (files.length === 0) {
    throw new Error('至少需要上传一个交付物文件');
  }

  const serviceRoot = path.join(WORKFLOW_REQUIREMENTS_DIR, safeService);
  const requirementDir = path.join(serviceRoot, safeRequirement);
  if (!pathInsideBase(serviceRoot, requirementDir)) {
    throw new Error('需求名称非法');
  }
  if (fs.existsSync(requirementDir)) {
    throw new Error('需求目录已存在');
  }

  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.mkdirSync(requirementDir);
  try {
    for (const file of files) {
      fs.writeFileSync(path.join(requirementDir, file.filename), file.data);
    }
  } catch (err) {
    fs.rmSync(requirementDir, { recursive: true, force: true });
    throw err;
  }

  return {
    requirement_name: safeRequirement,
    deliverables: files
      .map((file) => file.filename)
      .sort((a, b) => a.localeCompare(b, 'zh-CN')),
  };
}

function listStagedRequirementSources(service: string): RequirementSource[] {
  const serviceRoot = path.join(
    WORKFLOW_REQUIREMENTS_DIR,
    assertSafePathSegment('服务名称', service),
  );
  const sources: RequirementSource[] = [];
  for (const entry of safeReaddir(serviceRoot)) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(serviceRoot, entry.name);
    const deliverables = listRegularFiles(dir);
    if (deliverables.length === 0) continue;
    sources.push({
      service,
      requirementName: entry.name,
      dir,
      deliverables,
      updatedAt: latestMtimeMs(dir, deliverables),
      source: 'staged',
    });
  }
  return sources;
}

function extractWorkflowArtifactParts(input: {
  location_uri?: string | null;
  container_path?: string | null;
  path?: string | null;
  host_path?: string | null;
  artifact_type?: string | null;
}): { workflowId: string; requirementName: string; fileName: string } | null {
  const locationUri = input.location_uri || '';
  const uriMatch = locationUri.match(
    /^workflow:\/\/([^/]+)\/artifacts\/([^/]+)\/(.+)$/,
  );
  if (uriMatch) {
    return {
      workflowId: uriMatch[1] || '',
      requirementName: decodeURIComponent(uriMatch[2] || ''),
      fileName: path.posix.basename(uriMatch[3] || ''),
    };
  }

  const containerPath = input.container_path || input.path || '';
  const containerMatch = containerPath.match(
    /^\/workspace\/workflows\/([^/]+)\/artifacts\/([^/]+)\/(.+)$/,
  );
  if (containerMatch) {
    return {
      workflowId: containerMatch[1] || '',
      requirementName: containerMatch[2] || '',
      fileName: path.posix.basename(containerMatch[3] || ''),
    };
  }

  const hostPath = input.host_path || '';
  const parts = hostPath.split(path.sep);
  const workflowsIndex = parts.lastIndexOf('workflows');
  if (workflowsIndex >= 0 && parts[workflowsIndex + 2] === 'artifacts') {
    return {
      workflowId: parts[workflowsIndex + 1] || '',
      requirementName: parts[workflowsIndex + 3] || '',
      fileName: parts[parts.length - 1] || '',
    };
  }

  const fallbackFile = getWorkflowArtifactFileNameForRef(
    input.artifact_type || '',
  );
  return fallbackFile
    ? { workflowId: '', requirementName: '', fileName: fallbackFile }
    : null;
}

function listPersistedWorkflowRequirementSources(
  serviceFilter: Set<string>,
): RequirementSource[] {
  const byKey = new Map<string, RequirementSource>();
  for (const task of listWorkbenchTasks()) {
    const workflow = getWorkflow(task.workflow_id);
    const service = workflow?.service || task.service;
    if (!serviceFilter.has(service)) continue;

    for (const artifact of listWorkbenchArtifactsByTask(task.id)) {
      const parts = extractWorkflowArtifactParts(artifact);
      if (!parts?.requirementName || !parts.fileName) continue;
      if (!isValidDeliverableFileName(parts.fileName)) continue;
      const hostPath = artifact.host_path || '';
      const dir = hostPath ? path.dirname(hostPath) : '';
      if (
        !dir ||
        !fs.existsSync(dir) ||
        (() => {
          try {
            return !fs.statSync(dir).isDirectory();
          } catch {
            return true;
          }
        })()
      ) {
        continue;
      }
      const key = `${service}\0${parts.requirementName}\0${dir}`;
      const existing = byKey.get(key);
      const deliverables = existing
        ? Array.from(new Set([...existing.deliverables, parts.fileName])).sort(
            (a, b) => a.localeCompare(b, 'zh-CN'),
          )
        : listRegularFiles(dir);
      if (deliverables.length === 0) continue;
      byKey.set(key, {
        service,
        requirementName: parts.requirementName,
        dir,
        deliverables,
        updatedAt: latestMtimeMs(dir, deliverables),
        source: 'workflow_artifact',
        workflowId: parts.workflowId || task.workflow_id,
      });
    }
  }
  return Array.from(byKey.values());
}

export function listWorkflowRequirementOptions(
  services: string[],
): Record<string, WorkflowRequirementOption[]> {
  const normalizedServices = services.map((service) =>
    assertSafePathSegment('服务名称', service),
  );
  const serviceFilter = new Set(normalizedServices);
  const byService = new Map<string, Map<string, RequirementSource>>();
  for (const service of normalizedServices) {
    byService.set(service, new Map());
    for (const source of listStagedRequirementSources(service)) {
      byService.get(service)!.set(source.requirementName, source);
    }
  }

  for (const source of listPersistedWorkflowRequirementSources(serviceFilter)) {
    const entries = byService.get(source.service);
    if (!entries) continue;
    const existing = entries.get(source.requirementName);
    if (!existing || source.updatedAt > existing.updatedAt) {
      entries.set(source.requirementName, source);
    }
  }

  return Object.fromEntries(
    normalizedServices.map((service) => [
      service,
      Array.from(byService.get(service)?.values() || [])
        .map((source) => ({
          requirement_name: source.requirementName,
          deliverables: source.deliverables,
        }))
        .sort((a, b) =>
          b.requirement_name.localeCompare(a.requirement_name, 'zh-CN'),
        ),
    ]),
  );
}

function hasRequiredFiles(dir: string, requiredFiles: string[]): boolean {
  return requiredFiles.every((fileName) =>
    fs.existsSync(path.join(dir, fileName)),
  );
}

function listCandidateSources(input: {
  service: string;
  requirementName: string;
  excludeWorkflowId?: string;
}): RequirementSource[] {
  const service = assertSafePathSegment('服务名称', input.service);
  const requirementName = assertSafePathSegment(
    '需求名称',
    input.requirementName,
  );
  return [
    ...listStagedRequirementSources(service),
    ...listPersistedWorkflowRequirementSources(new Set([service])),
  ]
    .filter(
      (source) =>
        source.requirementName === requirementName &&
        source.workflowId !== input.excludeWorkflowId,
    )
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'staged' ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(targetPath)) continue;
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function targetAlreadyUsable(
  targetRoot: ResolvedStorageRoot,
  requiredFiles: string[],
): boolean {
  if (!fs.existsSync(targetRoot.hostPath)) return false;
  const files = listRegularFiles(targetRoot.hostPath);
  if (files.length === 0) return false;
  return (
    requiredFiles.length === 0 ||
    hasRequiredFiles(targetRoot.hostPath, requiredFiles)
  );
}

export function materializeWorkflowRequirementForWorkflow(input: {
  workflow: Workflow;
  storage?: WorkflowStorageConfig;
  deliverable: string;
  requiredFiles?: string[];
}): { copied: boolean; source?: string; error?: string } {
  const deliverable = assertSafePathSegment('需求名称', input.deliverable);
  const requiredFiles = Array.from(
    new Set(
      (input.requiredFiles || [])
        .map((fileName) => fileName.trim())
        .filter((fileName) => isValidDeliverableFileName(fileName)),
    ),
  );
  const workflowWithDeliverable: Workflow = {
    ...input.workflow,
    context: {
      ...input.workflow.context,
      [WORKFLOW_CONTEXT_KEYS.deliverable]: deliverable,
    },
  };
  const targetRoot = resolveWorkflowStorageRoot({
    workflow: workflowWithDeliverable,
    storage: input.storage,
    root: 'artifact_root',
  });

  if (targetAlreadyUsable(targetRoot, requiredFiles)) {
    return { copied: false };
  }

  const source = listCandidateSources({
    service: input.workflow.service,
    requirementName: deliverable,
    excludeWorkflowId: input.workflow.id,
  }).find((candidate) => hasRequiredFiles(candidate.dir, requiredFiles));

  if (!source) {
    return { copied: false };
  }

  copyDirectoryContents(source.dir, targetRoot.hostPath);
  return {
    copied: true,
    source: source.workflowId
      ? `workflow:${source.workflowId}`
      : `staged:${source.service}/${source.requirementName}`,
  };
}
