import type { Workflow } from './types.js';
import type { WorkflowDefinitionArtifactDisplay } from './workflow-definition.js';
import type { WorkflowStorageConfig } from './workflow-definition.js';
import {
  resolveWorkflowArtifactLocation,
  type ResolvedStorageLocation,
} from './workflow-storage.js';

export interface WorkflowArtifactDefinition {
  artifact_type: string;
  title: string;
  file: string;
  path: string;
  container_path: string;
  host_path: string;
  location_kind: string;
  location_uri: string;
  feature_id?: string | null;
  location?: ResolvedStorageLocation;
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

function renderArtifactDisplayPath(
  workflow: Workflow,
  artifact: WorkflowDefinitionArtifactDisplay,
  storage?: WorkflowStorageConfig,
): WorkflowArtifactDefinition | null {
  let location: ResolvedStorageLocation;
  try {
    location = resolveWorkflowArtifactLocation({
      workflow,
      storage,
      artifactPath: artifact.path,
      root: artifact.root || 'artifact_root',
    });
  } catch {
    return null;
  }
  return {
    artifact_type: artifact.artifact_type,
    title: artifact.title,
    file: location.relativePath.split('/').pop() || location.relativePath,
    path: location.containerPath,
    container_path: location.containerPath,
    host_path: location.hostPath,
    location_kind: location.kind,
    location_uri: location.locationUri,
    feature_id: location.featureId || null,
    location,
    source_role: artifact.source_role || null,
    required: artifact.required,
  };
}

export function resolveWorkflowArtifactDefinitions(
  artifacts: WorkflowDefinitionArtifactDisplay[] | undefined,
  workflow: Workflow,
  storage?: WorkflowStorageConfig,
): WorkflowArtifactDefinition[] {
  const byLocationUri = new Map<string, WorkflowArtifactDefinition>();
  for (const artifact of artifacts || []) {
    const resolved = renderArtifactDisplayPath(workflow, artifact, storage);
    if (!resolved) continue;
    if (byLocationUri.has(resolved.location_uri)) continue;
    byLocationUri.set(resolved.location_uri, resolved);
  }
  return Array.from(byLocationUri.values());
}
