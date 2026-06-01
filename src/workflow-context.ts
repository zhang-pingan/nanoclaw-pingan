import type { Workflow } from './types.js';

export type WorkflowContext = Record<string, unknown>;

export const WORKFLOW_CONTEXT_KEYS = {
  mainBranch: 'main_branch',
  workBranch: 'work_branch',
  iosWorkBranch: 'ios_work_branch',
  deliverable: 'deliverable',
  stagingBaseBranch: 'staging_base_branch',
  stagingWorkBranch: 'staging_work_branch',
  accessToken: 'access_token',
  requirementDescription: 'requirement_description',
  requirementFiles: 'requirement_files',
  testCaseFiles: 'test_case_files',
  requirementPreset: 'requirement_preset',
  contextPackPath: 'context_pack_path',
  contextPackImmutablePath: 'context_pack_immutable_path',
  contextPackHash: 'context_pack_hash',
  contextPackSummary: 'context_pack_summary',
  contextPackOpenQuestions: 'context_pack_open_questions',
  contextReadinessStatus: 'context_readiness_status',
  contextPackGeneratedAt: 'context_pack_generated_at',
} as const;

export function cloneWorkflowContext(
  context: WorkflowContext | null | undefined,
): WorkflowContext {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return {};
  }
  return { ...context };
}

export function parseWorkflowContext(
  raw: string | null | undefined,
): WorkflowContext {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return cloneWorkflowContext(parsed);
  } catch {
    return {};
  }
}

export function serializeWorkflowContext(context: WorkflowContext): string {
  return JSON.stringify(cloneWorkflowContext(context));
}

export function getWorkflowContextValue(
  workflow: Pick<Workflow, 'context'>,
  key: string,
): string {
  const value = workflow.context[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function mergeWorkflowContext(
  base: WorkflowContext,
  updates: WorkflowContext | null | undefined,
): WorkflowContext {
  if (!updates) return cloneWorkflowContext(base);
  return {
    ...cloneWorkflowContext(base),
    ...cloneWorkflowContext(updates),
  };
}
