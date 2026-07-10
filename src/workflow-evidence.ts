import type { Workflow, WorkflowEvalEvidence } from './types.js';
import { getWorkflowTypeConfig } from './workflow-config.js';
import { resolveWorkflowArtifactLocation } from './workflow-storage.js';

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function enrichWorkflowEvalEvidence(input: {
  workflow: Workflow;
  stageKey?: string;
  evidence: WorkflowEvalEvidence[];
}): WorkflowEvalEvidence[] {
  const storage = getWorkflowTypeConfig(input.workflow.workflow_type)?.storage;
  return input.evidence.map((item) => {
    if (item.location_uri && item.location_kind) return item;

    const locationInput =
      trimString(item.location_uri) || trimString(item.path);
    if (!locationInput) return item;

    try {
      const location = resolveWorkflowArtifactLocation({
        workflow: input.workflow,
        storage,
        artifactPath: locationInput,
        stageKey: input.stageKey,
      });
      return {
        ...item,
        path: item.path || location.containerPath,
        location_kind: item.location_kind || location.kind,
        location_uri: item.location_uri || location.locationUri,
        host_path: item.host_path || location.hostPath,
        container_path: item.container_path || location.containerPath,
        root_location_uri: item.root_location_uri || location.rootLocationUri,
      };
    } catch {
      return item;
    }
  });
}
