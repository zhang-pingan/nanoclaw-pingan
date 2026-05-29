import path from 'path';

import type { Workflow } from './types.js';
import { getWorkflowArtifactContract } from './workflow-artifact-contract.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';

export interface WorkflowArtifactDefinition {
  artifact_type: string;
  title: string;
  file: string;
  project_path?: string;
  source_role: string | null;
}

export const WORKFLOW_ARTIFACT_DEFINITIONS: WorkflowArtifactDefinition[] = [
  {
    artifact_type: 'plan_doc',
    title: '方案文档',
    file: 'plan.md',
    source_role: 'planner',
  },
  {
    artifact_type: 'dev_doc',
    title: '开发文档',
    file: 'dev.md',
    source_role: 'dev',
  },
  {
    artifact_type: 'test_doc',
    title: '测试文档',
    file: 'test.md',
    source_role: 'test',
  },
  {
    artifact_type: 'readme',
    title: '说明文档',
    file: 'README.md',
    source_role: 'system',
  },
];

export function getDefaultDeliverableFileNameForRole(role?: string): string {
  const matched = WORKFLOW_ARTIFACT_DEFINITIONS.find(
    (item) => item.source_role === role,
  );
  if (matched) return matched.file;
  return 'dev.md';
}

export function isValidDeliverableFileName(fileName: string): boolean {
  // A deliverable file name must be a single path segment (no traversal) with
  // a reasonable extension. The extension is no longer restricted to `.md`, so
  // workflows can declare non-Markdown deliverables (JSON/YAML/CSV/SVG…).
  const trimmed = fileName.trim();
  return (
    trimmed.length > 0 &&
    trimmed === trimmed.split(/[\\/]/).pop() &&
    /\.[a-z0-9]{1,12}$/i.test(trimmed)
  );
}

export function getDeliverableFileNameForRole(
  role?: string,
  roleConfigs?: Record<string, { deliverable_file?: string }>,
): string {
  const configuredFile = role ? roleConfigs?.[role]?.deliverable_file : '';
  if (configuredFile && isValidDeliverableFileName(configuredFile)) {
    return configuredFile;
  }
  return getDefaultDeliverableFileNameForRole(role);
}

function deliverableProjectPathPrefix(workflow: Workflow): string {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  return `projects/${workflow.service}/iteration/${deliverable || ''}/`;
}

function renderContractArtifactPath(
  workflow: Workflow,
  rawPath: string,
): string | null {
  const rendered = rawPath
    .replace(/\{\{service\}\}/g, workflow.service)
    .replace(
      /\{\{deliverable\}\}/g,
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable) ||
        '',
    )
    .trim();
  if (!rendered || rendered.includes('\0')) return null;
  const projectPath = rendered.startsWith('/workspace/')
    ? rendered.replace(/^\/workspace\//, '')
    : rendered.replace(/^\/+/, '');
  const normalized = path.posix.normalize(projectPath.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..') return null;
  if (!normalized.startsWith(deliverableProjectPathPrefix(workflow))) {
    return null;
  }
  return normalized;
}

function defaultProjectPath(workflow: Workflow, file: string): string {
  return `${deliverableProjectPathPrefix(workflow)}${file}`;
}

function fileRelativeToDeliverable(
  workflow: Workflow,
  projectPath: string,
): string {
  const prefix = deliverableProjectPathPrefix(workflow);
  return projectPath.startsWith(prefix)
    ? projectPath.slice(prefix.length)
    : projectPath;
}

function contractArtifactTitle(file: string): string {
  return path.basename(file);
}

function contractArtifactType(file: string): string {
  const extension = path.extname(file).replace(/^\./, '').toLowerCase();
  return extension ? `${extension}_artifact` : 'artifact';
}

function collectArtifactContractRefs(
  states?: Record<
    string,
    {
      role?: string;
      artifact_contract?: { ref?: string };
      handoff?: { artifact_contract_ref?: string };
      on_complete?: Record<
        string,
        { role?: string; handoff?: { artifact_contract_ref?: string } }
      >;
      on_resume?: Record<
        string,
        { role?: string; handoff?: { artifact_contract_ref?: string } }
      >;
    }
  >,
): Array<{ ref: string; sourceRole: string | null }> {
  const refs: Array<{ ref: string; sourceRole: string | null }> = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined, sourceRole: string | null): void => {
    const normalized = ref?.trim();
    if (!normalized) return;
    const key = `${normalized}\0${sourceRole || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ref: normalized, sourceRole });
  };

  for (const state of Object.values(states || {})) {
    add(state.artifact_contract?.ref, state.role || null);
    add(state.handoff?.artifact_contract_ref, state.role || null);
    for (const transition of Object.values(state.on_complete || {})) {
      add(transition.handoff?.artifact_contract_ref, transition.role || null);
    }
    for (const transition of Object.values(state.on_resume || {})) {
      add(transition.handoff?.artifact_contract_ref, transition.role || null);
    }
  }
  return refs;
}

export function resolveWorkflowArtifactDefinitions(
  roleConfigs?: Record<string, { deliverable_file?: string }>,
  workflow?: Workflow,
  states?: Parameters<typeof collectArtifactContractRefs>[0],
): WorkflowArtifactDefinition[] {
  const definitions = WORKFLOW_ARTIFACT_DEFINITIONS.map((definition) => ({
    ...definition,
    file: definition.source_role
      ? getDeliverableFileNameForRole(definition.source_role, roleConfigs)
      : definition.file,
  }));

  if (!workflow) return definitions;

  const byFile = new Map<string, WorkflowArtifactDefinition>();
  for (const definition of definitions) {
    byFile.set(defaultProjectPath(workflow, definition.file), definition);
  }

  for (const { ref, sourceRole } of collectArtifactContractRefs(states)) {
    const contract = getWorkflowArtifactContract(ref);
    for (const file of contract?.files || []) {
      const renderedPath = renderContractArtifactPath(workflow, file.path);
      if (!renderedPath || byFile.has(renderedPath)) continue;
      byFile.set(renderedPath, {
        artifact_type: contractArtifactType(renderedPath),
        title: contractArtifactTitle(renderedPath),
        file: fileRelativeToDeliverable(workflow, renderedPath),
        project_path: renderedPath,
        source_role: sourceRole,
      });
    }
  }

  return Array.from(byFile.values());
}
