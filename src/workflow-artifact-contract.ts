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

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
};

interface WorkflowArtifactContract {
  id: string;
  version: number;
  description?: string;
  files?: Array<{
    path: string;
    required: boolean;
    allowed_roots?: string[];
    must_exist?: boolean;
    frontmatter_required?: string[];
    frontmatter_schema?: Record<string, unknown>;
    max_bytes?: number;
  }>;
  payload?: {
    required?: string[];
    properties?: Record<string, unknown>;
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
      logger.error(
        { err, fullPath },
        'Failed to load workflow artifact contract',
      );
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

function readFrontMatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const raw = content.slice(4, end);
  const result: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function validateJsonSchemaSubset(
  schema: JsonSchema | undefined,
  value: unknown,
  pathName: string,
): string[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  const errors: string[] = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${pathName} must be an object`];
    }
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (objectValue[key] === undefined)
        errors.push(`${pathName}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (objectValue[key] !== undefined) {
        errors.push(
          ...validateJsonSchemaSubset(
            child,
            objectValue[key],
            `${pathName}.${key}`,
          ),
        );
      }
    }
    return errors;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${pathName} must be a string`);
    if (
      typeof value === 'string' &&
      schema.minLength !== undefined &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${pathName} must be at least ${schema.minLength} characters`,
      );
    }
    if (
      typeof value === 'string' &&
      schema.maxLength !== undefined &&
      value.length > schema.maxLength
    ) {
      errors.push(`${pathName} must be at most ${schema.maxLength} characters`);
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      errors.push(`${pathName} must be a number`);
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value))
      errors.push(`${pathName} must be an integer`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean')
      errors.push(`${pathName} must be a boolean`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${schema.enum.join(', ')}`);
  }
  return errors;
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
  for (const [key, schema] of Object.entries(
    contract.payload?.properties || {},
  )) {
    if (input.payload[key] === undefined) continue;
    for (const error of validateJsonSchemaSubset(
      schema as JsonSchema,
      input.payload[key],
      `payload.${key}`,
    )) {
      findings.push({
        code: 'artifact_contract.payload_schema_invalid',
        severity: 'high',
        message: error,
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
      const content = fs.readFileSync(fullPath, 'utf-8');
      const frontMatter = readFrontMatter(content);
      if (
        (file.frontmatter_required || file.frontmatter_schema) &&
        !frontMatter
      ) {
        findings.push({
          code: 'artifact_contract.frontmatter_missing',
          severity: 'high',
          message: `Artifact frontmatter is missing: ${file.path}`,
          stageKey: input.workflow.status,
          path: fullPath,
        });
      }
      for (const requiredKey of file.frontmatter_required || []) {
        if (frontMatter?.[requiredKey] === undefined) {
          findings.push({
            code: 'artifact_contract.frontmatter_required_missing',
            severity: 'high',
            message: `Artifact frontmatter missing required field "${requiredKey}": ${file.path}`,
            stageKey: input.workflow.status,
            path: fullPath,
          });
        }
      }
      if (file.frontmatter_schema && frontMatter) {
        for (const error of validateJsonSchemaSubset(
          file.frontmatter_schema as JsonSchema,
          frontMatter,
          `frontmatter.${file.path}`,
        )) {
          findings.push({
            code: 'artifact_contract.frontmatter_schema_invalid',
            severity: 'high',
            message: error,
            stageKey: input.workflow.status,
            path: fullPath,
          });
        }
      }
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
