import type { JsonObject } from '../workflow-runtime/contracts/types.js';

export type WorkflowPackEffectCeiling =
  | 'read_only'
  | 'workspace_write'
  | 'external_write';

export interface WorkflowPackExecutionPermissions extends JsonObject {
  readonly host_actions: string[];
  readonly file_scopes: string[];
  readonly mcp_servers: string[];
  readonly effect_ceiling: WorkflowPackEffectCeiling;
}

const EFFECT_CEILINGS = new Set<WorkflowPackEffectCeiling>([
  'read_only',
  'workspace_write',
  'external_write',
]);

export function parseWorkflowPackExecutionPermissions(
  value: unknown,
): WorkflowPackExecutionPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow Pack execution permissions are invalid');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(
        ['effect_ceiling', 'file_scopes', 'host_actions', 'mcp_servers'].sort(),
      ) ||
    !EFFECT_CEILINGS.has(candidate.effect_ceiling as WorkflowPackEffectCeiling)
  ) {
    throw new Error('Workflow Pack execution permissions are invalid');
  }
  const list = (field: 'host_actions' | 'file_scopes' | 'mcp_servers') => {
    const entries = candidate[field];
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) => typeof entry !== 'string' || entry.length === 0,
      ) ||
      new Set(entries).size !== entries.length
    ) {
      throw new Error(
        `Workflow Pack execution permissions ${field} are invalid`,
      );
    }
    return [...entries].sort();
  };
  return {
    host_actions: list('host_actions'),
    file_scopes: list('file_scopes'),
    mcp_servers: list('mcp_servers'),
    effect_ceiling: candidate.effect_ceiling as WorkflowPackEffectCeiling,
  };
}
