import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import { featureResources } from './features/registry.js';
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

export type WorkflowArtifactFindingSeverity =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export interface WorkflowArtifactContentCheck {
  code: string;
  severity?: WorkflowArtifactFindingSeverity;
  any_of: string[];
  message: string;
  suggestion?: string;
}

export interface WorkflowArtifactPayloadRule {
  code: string;
  severity?: WorkflowArtifactFindingSeverity;
  field: string;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  eq?: unknown;
  exists?: boolean;
  then_status?: WorkflowStageEvaluationStatus;
  message: string;
  suggestion?: string;
}

export interface WorkflowArtifactBodyPayloadFieldMatch {
  code: string;
  severity?: WorkflowArtifactFindingSeverity;
  body_field: string;
  payload_field: string;
  then_status?: WorkflowStageEvaluationStatus;
  message: string;
  suggestion?: string;
}

export interface WorkflowArtifactContract {
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
    content_checks?: WorkflowArtifactContentCheck[];
    body_required_fields?: string[];
    body_payload_field_matches?: WorkflowArtifactBodyPayloadFieldMatch[];
    max_bytes?: number;
  }>;
  payload?: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  payload_rules?: WorkflowArtifactPayloadRule[];
  allowed_artifact_roots?: string[];
}

export interface WorkflowArtifactPayloadValidationIssue {
  code:
    | 'artifact_contract.payload_missing'
    | 'artifact_contract.payload_schema_invalid';
  message: string;
  field?: string;
}

let cachedContracts: Record<string, WorkflowArtifactContract> | null = null;
let cachedContractSources: Record<string, string> | null = null;
let cachedContractSourceFeatureIds: Record<string, string | null> | null = null;

function contractsDir(): string {
  return path.join(PROJECT_ROOT, 'container', 'artifact-contracts');
}

function contractSourceDirs(): Array<{
  dir: string;
  label: string;
  featureId: string | null;
}> {
  return [
    { dir: contractsDir(), label: 'core', featureId: null },
    ...featureResources.list('artifactContracts').map((source) => ({
      dir: source.dir,
      label: `feature:${source.featureId}`,
      featureId: source.featureId,
    })),
  ];
}

export function loadWorkflowArtifactContracts(): Record<
  string,
  WorkflowArtifactContract
> {
  if (cachedContracts) return cachedContracts;
  const registry: Record<string, WorkflowArtifactContract> = {};
  const sources: Record<string, string> = {};
  const sourceFeatureIds: Record<string, string | null> = {};

  for (const source of contractSourceDirs()) {
    if (!fs.existsSync(source.dir)) continue;
    for (const entry of fs.readdirSync(source.dir)) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = path.join(source.dir, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as
          | WorkflowArtifactContract
          | WorkflowArtifactContract[];
        const contracts = Array.isArray(parsed) ? parsed : [parsed];
        for (const contract of contracts) {
          if (!contract?.id) continue;
          if (registry[contract.id]) {
            throw new Error(
              `artifact contract id conflict "${contract.id}" from ${source.label}`,
            );
          }
          registry[contract.id] = contract;
          sources[contract.id] = fullPath;
          sourceFeatureIds[contract.id] = source.featureId;
        }
      } catch (err) {
        logger.error(
          { err, fullPath },
          'Failed to load workflow artifact contract',
        );
        if (err instanceof Error && err.message.includes('conflict')) {
          throw err;
        }
      }
    }
  }

  cachedContracts = registry;
  cachedContractSources = sources;
  cachedContractSourceFeatureIds = sourceFeatureIds;
  return registry;
}

export function getWorkflowArtifactContract(
  ref: string | undefined,
): WorkflowArtifactContract | undefined {
  if (!ref) return undefined;
  return loadWorkflowArtifactContracts()[ref];
}

export function listWorkflowArtifactContracts(): Array<{
  contract: WorkflowArtifactContract;
  source_file: string | null;
  source_feature_id: string | null;
  readonly: boolean;
}> {
  const registry = loadWorkflowArtifactContracts();
  return Object.entries(registry)
    .map(([id, contract]) => ({
      contract,
      source_file: cachedContractSources?.[id] || null,
      source_feature_id: cachedContractSourceFeatureIds?.[id] || null,
      readonly: !!cachedContractSourceFeatureIds?.[id],
    }))
    .sort((a, b) => a.contract.id.localeCompare(b.contract.id));
}

function normalizeWorkflowArtifactContract(
  value: unknown,
): WorkflowArtifactContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('contract must be a JSON object');
  }
  const rawContract = value as Record<string, unknown>;
  delete rawContract.source_file;
  const contract = rawContract as unknown as WorkflowArtifactContract;
  if (typeof contract.id !== 'string' || !contract.id.trim()) {
    throw new Error('contract.id is required');
  }
  if (
    contract.version !== undefined &&
    (typeof contract.version !== 'number' || !Number.isFinite(contract.version))
  ) {
    throw new Error('contract.version must be a number');
  }
  if (contract.payload !== undefined) {
    if (
      !contract.payload ||
      typeof contract.payload !== 'object' ||
      Array.isArray(contract.payload)
    ) {
      throw new Error('contract.payload must be an object');
    }
    if (
      contract.payload.required !== undefined &&
      !Array.isArray(contract.payload.required)
    ) {
      throw new Error('contract.payload.required must be an array');
    }
  }
  if (contract.files !== undefined && !Array.isArray(contract.files)) {
    throw new Error('contract.files must be an array');
  }
  return {
    ...contract,
    id: contract.id.trim(),
    version: contract.version ?? 1,
  };
}

export function saveWorkflowArtifactContract(input: {
  ref: string;
  contract: unknown;
}): {
  contract?: WorkflowArtifactContract;
  source_file?: string;
  error?: string;
} {
  const ref = input.ref.trim();
  if (!ref) return { error: 'contract id required' };

  let contract: WorkflowArtifactContract;
  try {
    contract = normalizeWorkflowArtifactContract(input.contract);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (contract.id !== ref) {
    return { error: 'contract.id cannot be changed from this editor' };
  }

  loadWorkflowArtifactContracts();
  const sourceFeatureId = cachedContractSourceFeatureIds?.[ref] || null;
  if (sourceFeatureId) {
    return {
      error: `Artifact contract "${ref}" is owned by feature "${sourceFeatureId}" and cannot be edited from the core editor`,
    };
  }
  const sourceFile = cachedContractSources?.[ref];
  if (!sourceFile) {
    return { error: `Artifact contract "${ref}" not found` };
  }

  let parsed: WorkflowArtifactContract | WorkflowArtifactContract[];
  try {
    parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf-8')) as
      | WorkflowArtifactContract
      | WorkflowArtifactContract[];
  } catch (err) {
    return {
      error: `Failed to read source file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let next: WorkflowArtifactContract | WorkflowArtifactContract[];
  if (Array.isArray(parsed)) {
    let found = false;
    next = parsed.map((item) => {
      if (item?.id !== ref) return item;
      found = true;
      return contract;
    });
    if (!found) {
      return { error: `Artifact contract "${ref}" not found in source file` };
    }
  } else if (parsed?.id === ref) {
    next = contract;
  } else {
    return { error: `Artifact contract "${ref}" not found in source file` };
  }

  try {
    fs.writeFileSync(sourceFile, `${JSON.stringify(next, null, 2)}\n`);
    clearWorkflowArtifactContractCache();
    return { contract, source_file: sourceFile };
  } catch (err) {
    return {
      error: `Failed to save artifact contract: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

function interpolateMessage(
  message: string,
  values: Record<string, unknown>,
): string {
  return message.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = getValueByPath(values, key);
    return value === undefined || value === null ? '' : String(value);
  });
}

function getValueByPath(source: unknown, dottedPath: string): unknown {
  if (!source || typeof source !== 'object') return undefined;
  let current: unknown = source;
  for (const segment of dottedPath.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasValueAtPath(source: unknown, dottedPath: string): boolean {
  if (!source || typeof source !== 'object') return false;
  let current: unknown = source;
  for (const segment of dottedPath.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(
        current as Record<string, unknown>,
        segment,
      )
    ) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

function contentMatchesAnyOf(content: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(content);
    } catch {
      return content.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function evaluatePayloadRule(
  rule: WorkflowArtifactPayloadRule,
  payload: Record<string, unknown>,
): boolean {
  const value = getValueByPath(payload, rule.field);
  if (rule.exists !== undefined) {
    return rule.exists ? value !== undefined : value === undefined;
  }
  if (rule.eq !== undefined) {
    return value === rule.eq;
  }
  const numeric = typeof value === 'number' && Number.isFinite(value);
  if (rule.gt !== undefined) return numeric && (value as number) > rule.gt;
  if (rule.gte !== undefined) return numeric && (value as number) >= rule.gte;
  if (rule.lt !== undefined) return numeric && (value as number) < rule.lt;
  if (rule.lte !== undefined) return numeric && (value as number) <= rule.lte;
  return false;
}

const ARTIFACT_STATUS_RANK: Record<WorkflowStageEvaluationStatus, number> = {
  passed: 0,
  needs_revision: 1,
  pending: 2,
  failed: 3,
};

function worstArtifactStatus(
  statuses: WorkflowStageEvaluationStatus[],
): WorkflowStageEvaluationStatus {
  return statuses.reduce<WorkflowStageEvaluationStatus>(
    (worst, candidate) =>
      ARTIFACT_STATUS_RANK[candidate] > ARTIFACT_STATUS_RANK[worst]
        ? candidate
        : worst,
    'passed',
  );
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

export function validateWorkflowArtifactContractPayload(input: {
  contractRef: string | undefined;
  payload: Record<string, unknown>;
}): WorkflowArtifactPayloadValidationIssue[] {
  const contract = getWorkflowArtifactContract(input.contractRef);
  if (!contract) return [];

  const issues: WorkflowArtifactPayloadValidationIssue[] = [];
  for (const requiredKey of contract.payload?.required || []) {
    if (input.payload[requiredKey] === undefined) {
      issues.push({
        code: 'artifact_contract.payload_missing',
        field: requiredKey,
        message: `Payload missing required field "${requiredKey}"`,
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
      issues.push({
        code: 'artifact_contract.payload_schema_invalid',
        field: key,
        message: error,
      });
    }
  }

  return issues;
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
  const forcedStatuses: WorkflowStageEvaluationStatus[] = [];
  const semanticFindingCodes = new Set<string>();

  for (const issue of validateWorkflowArtifactContractPayload({
    contractRef: input.contractRef,
    payload: input.payload,
  })) {
    findings.push({
      code: issue.code,
      severity: 'high',
      message: issue.message,
      stageKey: input.workflow.status,
    });
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
      for (const check of file.content_checks || []) {
        if (!contentMatchesAnyOf(content, check.any_of || [])) {
          const severity = check.severity || 'medium';
          findings.push({
            code: check.code,
            severity,
            message: check.message,
            stageKey: input.workflow.status,
            path: fullPath,
            suggestion: check.suggestion,
          });
          // A failed content check means the document exists but is
          // incomplete — a revision issue, not "missing evidence". Force
          // needs_revision (or failed for critical) so the routing matches
          // the legacy stage-rules behavior instead of mapping high → pending.
          forcedStatuses.push(
            severity === 'critical' ? 'failed' : 'needs_revision',
          );
        }
      }
      const needsJsonBody =
        (file.body_required_fields && file.body_required_fields.length > 0) ||
        (file.body_payload_field_matches &&
          file.body_payload_field_matches.length > 0);
      if (needsJsonBody) {
        let body: unknown;
        let parseFailed = false;
        try {
          body = JSON.parse(content);
        } catch {
          parseFailed = true;
        }
        if (parseFailed) {
          findings.push({
            code: 'artifact_contract.body_not_json',
            severity: 'high',
            message: `Artifact body is not valid JSON: ${file.path}`,
            stageKey: input.workflow.status,
            path: fullPath,
          });
        } else {
          for (const field of file.body_required_fields || []) {
            if (!hasValueAtPath(body, field)) {
              findings.push({
                code: 'artifact_contract.body_field_missing',
                severity: 'high',
                message: `Artifact body missing required field "${field}": ${file.path}`,
                stageKey: input.workflow.status,
                path: fullPath,
              });
            }
          }
          for (const match of file.body_payload_field_matches || []) {
            const bodyValue = getValueByPath(body, match.body_field);
            const payloadValue = getValueByPath(
              input.payload,
              match.payload_field,
            );
            if (bodyValue !== payloadValue) {
              findings.push({
                code: match.code,
                severity: match.severity || 'high',
                message: interpolateMessage(match.message, {
                  body,
                  payload: input.payload,
                  body_value: bodyValue,
                  payload_value: payloadValue,
                }),
                stageKey: input.workflow.status,
                path: fullPath,
                suggestion: match.suggestion,
              });
              semanticFindingCodes.add(match.code);
              forcedStatuses.push(match.then_status || 'failed');
            }
          }
        }
      }
      evidence.push({
        type: 'artifact',
        path: fullPath,
        summary: `Artifact contract file present: ${file.path}`,
      });
    }
  }

  for (const rule of contract.payload_rules || []) {
    if (!evaluatePayloadRule(rule, input.payload)) continue;
    findings.push({
      code: rule.code,
      severity: rule.severity || 'high',
      message: interpolateMessage(rule.message, input.payload),
      stageKey: input.workflow.status,
      suggestion: rule.suggestion,
    });
    if (rule.then_status) forcedStatuses.push(rule.then_status);
  }

  // Content checks and payload rules carry their own status (forcedStatuses):
  // a failed content check is a revision issue, not "missing evidence". Only
  // structural findings (missing file/frontmatter/schema/size/body) drive the
  // severity-based status, where high means "cannot evaluate yet" → pending.
  const ruleCodes = new Set<string>();
  for (const file of contract.files || []) {
    for (const check of file.content_checks || []) ruleCodes.add(check.code);
  }
  for (const rule of contract.payload_rules || []) ruleCodes.add(rule.code);
  const structuralFindings = findings.filter(
    (item) => !ruleCodes.has(item.code) && !semanticFindingCodes.has(item.code),
  );

  const hasCritical = structuralFindings.some(
    (item) => item.severity === 'critical',
  );
  const hasHigh = structuralFindings.some((item) => item.severity === 'high');
  const severityStatus: WorkflowStageEvaluationStatus = hasCritical
    ? 'failed'
    : hasHigh
      ? 'pending'
      : structuralFindings.length > 0
        ? 'needs_revision'
        : 'passed';
  const status = worstArtifactStatus([severityStatus, ...forcedStatuses]);

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

export function clearWorkflowArtifactContractCache(): void {
  cachedContracts = null;
  cachedContractSources = null;
  cachedContractSourceFeatureIds = null;
}

export function clearWorkflowArtifactContractCacheForTest(): void {
  clearWorkflowArtifactContractCache();
}
