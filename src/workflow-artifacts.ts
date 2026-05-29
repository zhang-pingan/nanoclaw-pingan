export interface WorkflowArtifactDefinition {
  artifact_type: string;
  title: string;
  file: string;
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

export function resolveWorkflowArtifactDefinitions(
  roleConfigs?: Record<string, { deliverable_file?: string }>,
): WorkflowArtifactDefinition[] {
  return WORKFLOW_ARTIFACT_DEFINITIONS.map((definition) => ({
    ...definition,
    file: definition.source_role
      ? getDeliverableFileNameForRole(definition.source_role, roleConfigs)
      : definition.file,
  }));
}
