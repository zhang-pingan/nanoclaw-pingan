import type { CompiledScopePlanV2Document } from './compiler-contract-repair-types.js';
import type { JsonObject } from './types.js';

export interface WorkflowCompilerStaticChildPlanBundleEntry {
  closureKey: string;
  source: JsonObject;
  plan: CompiledScopePlanV2Document;
}

export interface WorkflowCompilerStaticChildPlanBundle {
  format: 'icarus.workflow-compiler-static-child-plan-bundle/1';
  entries: WorkflowCompilerStaticChildPlanBundleEntry[];
}
