import path from 'path';

import type { Workflow } from './types.js';
import type { WorkflowDefinitionArtifactDisplay } from './workflow-definition.js';
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
  required?: boolean;
}

export function isValidDeliverableFileName(fileName: string): boolean {
  // A deliverable file name must be a single path segment (no traversal) with
  // a reasonable extension. The extension is no longer restricted to `.md`, so
  // workflows can declare non-Markdown deliverables (JSON/YAML/CSV/SVG...).
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
  return configuredFile && isValidDeliverableFileName(configuredFile)
    ? configuredFile
    : '';
}

const WORKFLOW_ARTIFACT_REF_FILES: Record<string, string> = {
  plan_doc: 'plan.md',
  dev_doc: 'dev.md',
  test_doc: 'test.md',
  product_recon: 'product-recon.json',
  impact_analysis: 'impact-analysis.json',
  prototype_analysis: 'prototype-analysis.json',
  acceptance_report: 'acceptance-report.json',
  traceability: 'traceability.json',
  readme: 'README.md',
};

export function getWorkflowArtifactFileNameForRef(ref: string): string {
  return WORKFLOW_ARTIFACT_REF_FILES[ref] || '';
}

function deliverableProjectPathPrefix(workflow: Workflow): string {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  return `projects/${workflow.service}/iteration/${deliverable || ''}/`;
}

function renderArtifactDisplayPath(
  workflow: Workflow,
  rawPath: string,
): { file: string; projectPath: string } | null {
  const deliverablePrefix = deliverableProjectPathPrefix(workflow);
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
    : rendered.startsWith('projects/')
      ? rendered
      : `${deliverablePrefix}${rendered.replace(/^\/+/, '')}`;
  const normalized = path.posix.normalize(projectPath.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..') return null;
  if (!normalized.startsWith(deliverablePrefix)) return null;
  return {
    file: normalized.slice(deliverablePrefix.length),
    projectPath: normalized,
  };
}

export function resolveWorkflowArtifactDefinitions(
  artifacts: WorkflowDefinitionArtifactDisplay[] | undefined,
  workflow: Workflow,
): WorkflowArtifactDefinition[] {
  const byProjectPath = new Map<string, WorkflowArtifactDefinition>();
  for (const artifact of artifacts || []) {
    const resolved = renderArtifactDisplayPath(workflow, artifact.path);
    if (!resolved) continue;
    if (byProjectPath.has(resolved.projectPath)) continue;
    byProjectPath.set(resolved.projectPath, {
      artifact_type: artifact.artifact_type,
      title: artifact.title,
      file: resolved.file,
      project_path: resolved.projectPath,
      source_role: artifact.source_role || null,
      required: artifact.required,
    });
  }
  return Array.from(byProjectPath.values());
}
