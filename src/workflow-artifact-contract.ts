import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import type {
  Workflow,
  WorkflowEvalEvidence,
  WorkflowEvalFinding,
  WorkflowStageEvalResult,
  WorkflowStageEvaluationStatus,
} from './types.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';

interface WorkflowArtifactContract {
  id: string;
  version: number;
  description?: string;
  files?: Array<{
    path: string;
    required: boolean;
    allowed_roots?: string[];
    must_exist?: boolean;
    max_bytes?: number;
  }>;
  payload?: {
    required?: string[];
  };
  allowed_artifact_roots?: string[];
}

let cachedContracts: Record<string, WorkflowArtifactContract> | null = null;

function contractsDir(): string {
  return path.join(PROJECT_ROOT, 'container', 'artifact-contracts');
}

export function loadWorkflowArtifactContracts(): Record<
  string,
  WorkflowArtifactContract
> {
  if (cachedContracts) return cachedContracts;
  const dir = contractsDir();
  const registry: Record<string, WorkflowArtifactContract> = {};
  if (!fs.existsSync(dir)) {
    cachedContracts = registry;
    return registry;
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(dir, entry);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as
        | WorkflowArtifactContract
        | WorkflowArtifactContract[];
      const contracts = Array.isArray(parsed) ? parsed : [parsed];
      for (const contract of contracts) {
        if (!contract?.id) continue;
        registry[contract.id] = contract;
      }
    } catch (err) {
      logger.error({ err, fullPath }, 'Failed to load workflow artifact contract');
    }
  }

  cachedContracts = registry;
  return registry;
}

export function getWorkflowArtifactContract(
  ref: string | undefined,
): WorkflowArtifactContract | undefined {
  if (!ref) return undefined;
  return loadWorkflowArtifactContracts()[ref];
}

function resolveContractPath(workflow: Workflow, rawPath: string): string {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  const rendered = rawPath
    .replace(/\{\{service\}\}/g, workflow.service)
    .replace(/\{\{deliverable\}\}/g, deliverable || '');
  if (rendered.startsWith('/workspace/')) {
    return path.join(PROJECT_ROOT, rendered.replace(/^\/workspace\//, ''));
  }
  return path.isAbsolute(rendered)
    ? rendered
    : path.join(PROJECT_ROOT, rendered);
}

function isUnderAllowedRoot(filePath: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return true;
  const resolvedPath = path.resolve(filePath);
  return allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(
      root.startsWith('/workspace/')
        ? path.join(PROJECT_ROOT, root.replace(/^\/workspace\//, ''))
        : root,
    );
    return (
      resolvedPath === resolvedRoot ||
      resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
    );
  });
}

export function evaluateWorkflowArtifactContract(input: {
  workflow: Workflow;
  contractRef: string | undefined;
  payload: Record<string, unknown>;
}): WorkflowStageEvalResult | null {
  const contract = getWorkflowArtifactContract(input.contractRef);
  if (!contract) return null;

  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [];

  for (const requiredKey of contract.payload?.required || []) {
    if (input.payload[requiredKey] === undefined) {
      findings.push({
        code: 'artifact_contract.payload_missing',
        severity: 'high',
        message: `Payload missing required field "${requiredKey}"`,
        stageKey: input.workflow.status,
      });
    }
  }

  for (const file of contract.files || []) {
    const fullPath = resolveContractPath(input.workflow, file.path);
    const allowedRoots = [
      ...(contract.allowed_artifact_roots || []),
      ...(file.allowed_roots || []),
    ];
    if (!isUnderAllowedRoot(fullPath, allowedRoots)) {
      findings.push({
        code: 'artifact_contract.path_outside_allowed_roots',
        severity: 'critical',
        message: `Artifact path is outside allowed roots: ${file.path}`,
        stageKey: input.workflow.status,
        path: fullPath,
      });
      continue;
    }
    const exists = fs.existsSync(fullPath);
    if ((file.required || file.must_exist) && !exists) {
      findings.push({
        code: 'artifact_contract.file_missing',
        severity: 'high',
        message: `Required artifact is missing: ${file.path}`,
        stageKey: input.workflow.status,
        path: fullPath,
      });
      continue;
    }
    if (exists) {
      const stat = fs.statSync(fullPath);
      if (file.max_bytes && stat.size > file.max_bytes) {
        findings.push({
          code: 'artifact_contract.file_too_large',
          severity: 'medium',
          message: `Artifact exceeds max_bytes: ${file.path}`,
          stageKey: input.workflow.status,
          path: fullPath,
        });
      }
      evidence.push({
        type: 'artifact',
        path: fullPath,
        summary: `Artifact contract file present: ${file.path}`,
      });
    }
  }

  const hasCritical = findings.some((item) => item.severity === 'critical');
  const hasHigh = findings.some((item) => item.severity === 'high');
  const status: WorkflowStageEvaluationStatus = hasCritical
    ? 'failed'
    : hasHigh
      ? 'pending'
      : findings.length > 0
        ? 'needs_revision'
        : 'passed';

  return {
    status,
    score: status === 'passed' ? 100 : status === 'needs_revision' ? 60 : 0,
    summary:
      status === 'passed'
        ? `Artifact contract ${contract.id} passed`
        : `Artifact contract ${contract.id} found ${findings.length} issue(s)`,
    findings,
    evidence,
    evaluatorType: 'rules',
  };
}

export function clearWorkflowArtifactContractCacheForTest(): void {
  cachedContracts = null;
}
