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

export function getDeliverableFileNameForRole(role?: string): string {
  const matched = WORKFLOW_ARTIFACT_DEFINITIONS.find(
    (item) => item.source_role === role,
  );
  if (matched) return matched.file;
  return 'dev.md';
}
