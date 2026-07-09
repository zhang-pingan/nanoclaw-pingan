import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT, REPOS_DIR } from './config.js';
import type {
  Delegation,
  Workflow,
  WorkflowEvalEvidence,
  WorkflowEvalFinding,
  WorkflowStageEvalResult,
  WorkflowStageEvaluationRecord,
  WorkflowStageEvaluationStatus,
  WorkflowStageEvaluatorType,
} from './types.js';
import type {
  WorkflowQualityGate,
  WorkflowStorageConfig,
} from './workflow-definition.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';
import { getWorkflowTypeConfig } from './workflow-config.js';
import { parseDelegationHandoffResult } from './workflow-handoff.js';
import {
  isPathInsideResolvedRoot,
  resolveWorkflowArtifactLocation,
  resolveWorkflowStorageRoot,
  resolveWorkspacePathToHost,
} from './workflow-storage.js';

type Severity = WorkflowEvalFinding['severity'];

interface TraceabilityRefObject {
  id?: string;
  ref_id?: string;
  evidence?: unknown;
  evidence_refs?: unknown;
  source_refs?: unknown;
  covered_by?: unknown;
  [key: string]: unknown;
}

interface TraceabilityCoverageEntry {
  source_id?: string;
  sourceId?: string;
  covered_by?: unknown;
  coveredBy?: unknown;
  evidence?: unknown;
  evidence_refs?: unknown;
  evidenceRefs?: unknown;
  [key: string]: unknown;
}

export interface WorkflowTraceabilityArtifact {
  version?: number;
  statements?: TraceabilityRefObject[];
  decisions?: TraceabilityRefObject[];
  assumptions?: TraceabilityRefObject[];
  risks?: TraceabilityRefObject[];
  actions?: TraceabilityRefObject[];
  acceptance_criteria?: TraceabilityRefObject[];
  checks?: TraceabilityRefObject[];
  test_results?: TraceabilityRefObject[];
  evidence?: Array<Record<string, unknown>>;
  coverage?: TraceabilityCoverageEntry[];
  open_questions?: unknown[];
  [key: string]: unknown;
}

interface LoadedTraceability {
  traceability: WorkflowTraceabilityArtifact | null;
  hostPath: string;
  workspacePath: string;
  source: 'payload' | 'file' | 'missing' | 'invalid';
  error?: string;
}

interface LoadedContextPack {
  pack: Record<string, unknown> | null;
  hostPath: string;
  workspacePath: string;
  source: 'file' | 'missing' | 'invalid';
  error?: string;
}

interface ServiceConfig {
  repo_path?: string;
  [key: string]: unknown;
}

export interface WorkflowQualityGateComponentRecordInput {
  evaluatorType: WorkflowStageEvaluatorType;
  result: WorkflowStageEvalResult;
}

export interface WorkflowQualityGateEvaluation {
  finalResult: WorkflowStageEvalResult;
  componentResults: WorkflowQualityGateComponentRecordInput[];
  sourceEvaluationIds: string[];
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean),
      ),
    );
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readServicesConfig(): Record<string, ServiceConfig> {
  const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
  if (!fs.existsSync(servicesPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    return isPlainObject(parsed)
      ? (parsed as Record<string, ServiceConfig>)
      : {};
  } catch {
    return {};
  }
}

function isSafeWorkspacePathSegment(value: string): boolean {
  const segment = value.trim();
  return (
    !!segment &&
    !segment.includes('\0') &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !path.isAbsolute(segment)
  );
}

function isSafeRelativeRepoPath(repoPath: string): boolean {
  const normalized = repoPath.trim();
  return (
    !!normalized &&
    !normalized.includes('\0') &&
    !normalized.includes('\\') &&
    !path.isAbsolute(normalized) &&
    normalized.split('/').every((segment) => {
      return !!segment && segment !== '.' && segment !== '..';
    })
  );
}

function currentRepoPath(): string {
  const relative = path
    .relative(REPOS_DIR, PROJECT_ROOT)
    .split(path.sep)
    .join('/');
  return isSafeRelativeRepoPath(relative)
    ? relative
    : path.basename(PROJECT_ROOT);
}

function serviceRepoPath(workflow: Workflow): string {
  const configured = readServicesConfig()[workflow.service]?.repo_path;
  const repoPath =
    typeof configured === 'string'
      ? configured.trim()
      : workflow.service === 'icarus'
        ? currentRepoPath()
        : '';
  return repoPath && isSafeRelativeRepoPath(repoPath) ? repoPath : '';
}

function workspacePathMatchesPrefix(
  workspacePath: string,
  prefix: string,
): boolean {
  return workspacePath === prefix || workspacePath.startsWith(`${prefix}/`);
}

function getDelegationPayload(
  delegation: Delegation | null | undefined,
): Record<string, unknown> {
  const handoffPayload = parseDelegationHandoffResult(delegation);
  if (handoffPayload) return handoffPayload;
  if (!delegation?.result) return {};
  return parseJsonObject(delegation.result) || {};
}

type ScopedWorkspacePathKind = 'deliverable' | 'context_pack';

function scopedWorkspacePrefixes(
  workflow: Workflow,
  storage: WorkflowStorageConfig | undefined,
  kinds: ScopedWorkspacePathKind[],
): string[] {
  const prefixes: string[] = [];
  if (kinds.includes('deliverable')) {
    prefixes.push(
      resolveWorkflowStorageRoot({
        workflow,
        storage,
        root: 'artifact_root',
      }).containerPath,
    );
  }
  if (kinds.includes('context_pack')) {
    prefixes.push(
      resolveWorkflowStorageRoot({
        workflow,
        storage,
        root: 'context_pack_root',
        stageKey: workflow.status,
      }).containerPath,
    );
  }
  return prefixes;
}

function scopedWorkspaceToHostPath(input: {
  workflow: Workflow;
  workspacePath: string;
  allowedKinds: ScopedWorkspacePathKind[];
  storage?: WorkflowStorageConfig;
}): { hostPath: string; error?: string } {
  const workspacePath = input.workspacePath.trim();
  if (!workspacePath) return { hostPath: '', error: 'path_missing' };
  if (
    workspacePath.includes('\0') ||
    workspacePath.split('/').some((segment) => segment === '..')
  ) {
    return { hostPath: '', error: 'path_invalid' };
  }
  const resolved = resolveWorkspacePathToHost(workspacePath);
  if (!resolved) return { hostPath: '', error: 'unsupported_path' };
  const prefixes = scopedWorkspacePrefixes(
    input.workflow,
    input.storage,
    input.allowedKinds,
  );
  if (
    prefixes.length === 0 ||
    !prefixes.some((prefix) => workspacePath.startsWith(prefix))
  ) {
    return { hostPath: '', error: 'scope_mismatch' };
  }
  const allowedRoots = input.allowedKinds.map((kind) =>
    resolveWorkflowStorageRoot({
      workflow: input.workflow,
      storage: input.storage,
      root: kind === 'deliverable' ? 'artifact_root' : 'context_pack_root',
      stageKey: input.workflow.status,
    }),
  );
  if (
    !allowedRoots.some((root) =>
      isPathInsideResolvedRoot(resolved.hostPath, root),
    )
  ) {
    return { hostPath: '', error: 'scope_mismatch' };
  }
  return { hostPath: resolved.hostPath };
}

function workspaceEvidenceScopeError(input: {
  workflow: Workflow;
  workspacePath: string;
  evidenceType: WorkflowEvalEvidence['type'];
}): string {
  const workspacePath = input.workspacePath.trim();
  if (!workspacePath) return '';
  if (!workspacePath.startsWith('/workspace/')) return '';
  if (
    workspacePath.includes('\0') ||
    workspacePath.split('/').some((segment) => segment === '..')
  ) {
    return 'path_invalid';
  }
  if (input.evidenceType === 'code') {
    const repoPath = serviceRepoPath(input.workflow);
    if (
      repoPath &&
      workspacePathMatchesPrefix(workspacePath, `/workspace/repos/${repoPath}`)
    ) {
      return '';
    }
    if (
      repoPath &&
      (repoPath === 'icarus' || repoPath === currentRepoPath()) &&
      workspacePathMatchesPrefix(workspacePath, '/workspace/project')
    ) {
      return '';
    }
    return 'scope_mismatch';
  }
  const resolved = scopedWorkspaceToHostPath({
    workflow: input.workflow,
    workspacePath,
    allowedKinds: ['deliverable'],
    storage: getWorkflowTypeConfig(input.workflow.workflow_type)?.storage,
  });
  return resolved.error || '';
}

function defaultTraceabilityWorkspacePath(workflow: Workflow): string {
  try {
    return resolveWorkflowArtifactLocation({
      workflow,
      storage: getWorkflowTypeConfig(workflow.workflow_type)?.storage,
      artifactPath: 'traceability.json',
    }).containerPath;
  } catch {
    return '';
  }
}

function loadJsonFile(input: {
  workflow: Workflow;
  workspacePath: string;
  allowedKinds: ScopedWorkspacePathKind[];
  storage?: WorkflowStorageConfig;
}): LoadedContextPack {
  const workspacePath = input.workspacePath;
  if (!workspacePath) {
    return {
      pack: null,
      hostPath: '',
      workspacePath: '',
      source: 'missing',
      error: 'path_missing',
    };
  }
  const resolved = scopedWorkspaceToHostPath(input);
  if (resolved.error) {
    return {
      pack: null,
      hostPath: '',
      workspacePath,
      source: 'invalid',
      error: resolved.error,
    };
  }
  const hostPath = resolved.hostPath;
  if (!hostPath || !fs.existsSync(hostPath)) {
    return {
      pack: null,
      hostPath,
      workspacePath,
      source: 'missing',
      error: 'file_missing',
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(hostPath, 'utf-8'));
    return isPlainObject(parsed)
      ? { pack: parsed, hostPath, workspacePath, source: 'file' }
      : {
          pack: null,
          hostPath,
          workspacePath,
          source: 'invalid',
          error: 'json_not_object',
        };
  } catch (err) {
    return {
      pack: null,
      hostPath,
      workspacePath,
      source: 'invalid',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function loadContextPack(workflow: Workflow): LoadedContextPack {
  const workspacePath = trimText(
    workflow.context[WORKFLOW_CONTEXT_KEYS.contextPackPath],
  );
  return loadJsonFile({
    workflow,
    workspacePath,
    allowedKinds: ['context_pack'],
    storage: getWorkflowTypeConfig(workflow.workflow_type)?.storage,
  });
}

function loadTraceability(input: {
  workflow: Workflow;
  payload: Record<string, unknown>;
}): LoadedTraceability {
  if (isPlainObject(input.payload.traceability)) {
    return {
      traceability: input.payload.traceability as WorkflowTraceabilityArtifact,
      hostPath: '',
      workspacePath: 'payload.traceability',
      source: 'payload',
    };
  }

  const configuredPath =
    trimText(input.payload.traceability_path) ||
    trimText(input.payload.traceabilityPath);
  const workspacePath =
    configuredPath || defaultTraceabilityWorkspacePath(input.workflow);
  if (!workspacePath) {
    return {
      traceability: null,
      hostPath: '',
      workspacePath: '',
      source: 'missing',
      error: 'deliverable_missing',
    };
  }

  const loaded = loadJsonFile({
    workflow: input.workflow,
    workspacePath,
    allowedKinds: ['deliverable'],
    storage: getWorkflowTypeConfig(input.workflow.workflow_type)?.storage,
  });
  if (!loaded.pack) {
    return {
      traceability: null,
      hostPath: loaded.hostPath,
      workspacePath: loaded.workspacePath,
      source: loaded.source,
      error: loaded.error,
    };
  }
  return {
    traceability: loaded.pack as WorkflowTraceabilityArtifact,
    hostPath: loaded.hostPath,
    workspacePath: loaded.workspacePath,
    source: 'file',
  };
}

function pushFinding(
  findings: WorkflowEvalFinding[],
  finding: WorkflowEvalFinding,
): void {
  if (
    !findings.some(
      (item) =>
        item.code === finding.code &&
        item.path === finding.path &&
        item.message === finding.message,
    )
  ) {
    findings.push(finding);
  }
}

function pushEvidence(
  evidence: WorkflowEvalEvidence[],
  item: WorkflowEvalEvidence,
): void {
  if (
    !evidence.some(
      (entry) =>
        entry.type === item.type &&
        entry.refId === item.refId &&
        entry.path === item.path &&
        entry.summary === item.summary,
    )
  ) {
    evidence.push(item);
  }
}

function worstStatus(
  statuses: WorkflowStageEvaluationStatus[],
): WorkflowStageEvaluationStatus {
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('needs_revision')) return 'needs_revision';
  return 'passed';
}

function statusFromFindings(
  findings: WorkflowEvalFinding[],
): WorkflowStageEvaluationStatus {
  if (findings.some((item) => item.severity === 'critical')) return 'failed';
  if (findings.some((item) => item.severity === 'high')) {
    return 'needs_revision';
  }
  if (findings.length > 0) return 'needs_revision';
  return 'passed';
}

function scoreForStatus(
  status: WorkflowStageEvaluationStatus,
  findings: WorkflowEvalFinding[],
): number {
  let score =
    status === 'passed'
      ? 100
      : status === 'needs_revision'
        ? 60
        : status === 'pending'
          ? 40
          : 20;
  for (const finding of findings) {
    score -=
      finding.severity === 'critical'
        ? 25
        : finding.severity === 'high'
          ? 15
          : finding.severity === 'medium'
            ? 8
            : 4;
  }
  return Math.max(0, Math.min(100, score));
}

function makeResult(input: {
  evaluatorType: WorkflowStageEvaluatorType;
  status?: WorkflowStageEvaluationStatus;
  score?: number;
  summary: string;
  findings?: WorkflowEvalFinding[];
  evidence?: WorkflowEvalEvidence[];
}): WorkflowStageEvalResult {
  const findings = input.findings || [];
  const status = input.status || statusFromFindings(findings);
  return {
    evaluatorType: input.evaluatorType,
    status,
    score: input.score ?? scoreForStatus(status, findings),
    summary: input.summary,
    findings,
    evidence: input.evidence || [],
  };
}

function cloneResultWithType(
  result: WorkflowStageEvalResult,
  evaluatorType: WorkflowStageEvaluatorType,
): WorkflowStageEvalResult {
  return {
    ...result,
    evaluatorType,
  };
}

function evaluateSchema(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  payload: Record<string, unknown>;
}): WorkflowStageEvalResult {
  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [];
  const validationStatus = input.delegation?.handoff_validation_status || '';
  const validationErrors = (() => {
    try {
      const parsed = JSON.parse(
        input.delegation?.handoff_validation_errors_json || '[]',
      );
      return Array.isArray(parsed)
        ? parsed.map((item) => String(item)).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  })();

  if (validationStatus === 'invalid' || validationStatus === 'not_json') {
    pushFinding(findings, {
      code: 'schema.handoff_validation_failed',
      severity: 'high',
      message: `Handoff result validation failed: ${validationErrors.join('; ') || validationStatus}`,
      stageKey: input.stageKey,
    });
  } else {
    for (const key of ['verdict', 'summary', 'findings', 'evidence']) {
      if (input.payload[key] === undefined) {
        pushFinding(findings, {
          code: 'schema.required_field_missing',
          severity: 'high',
          message: `Payload missing required field "${key}"`,
          stageKey: input.stageKey,
          path: key,
        });
      }
    }
    if (
      input.payload.verdict !== undefined &&
      !['passed', 'failed', 'needs_revision', 'pending'].includes(
        String(input.payload.verdict),
      )
    ) {
      pushFinding(findings, {
        code: 'schema.verdict_invalid',
        severity: 'high',
        message:
          'Payload verdict must be passed, failed, needs_revision, or pending',
        stageKey: input.stageKey,
        path: 'verdict',
      });
    }
    if (
      input.payload.summary !== undefined &&
      typeof input.payload.summary !== 'string'
    ) {
      pushFinding(findings, {
        code: 'schema.summary_invalid',
        severity: 'high',
        message: 'Payload summary must be a string',
        stageKey: input.stageKey,
        path: 'summary',
      });
    }
    if (
      input.payload.findings !== undefined &&
      !Array.isArray(input.payload.findings)
    ) {
      pushFinding(findings, {
        code: 'schema.findings_invalid',
        severity: 'high',
        message: 'Payload findings must be an array',
        stageKey: input.stageKey,
        path: 'findings',
      });
    }
    if (
      input.payload.evidence !== undefined &&
      !Array.isArray(input.payload.evidence)
    ) {
      pushFinding(findings, {
        code: 'schema.evidence_invalid',
        severity: 'high',
        message: 'Payload evidence must be an array',
        stageKey: input.stageKey,
        path: 'evidence',
      });
    }
  }

  if (validationStatus) {
    pushEvidence(evidence, {
      type: 'message',
      summary: `handoff_validation_status=${validationStatus}`,
    });
  }
  return makeResult({
    evaluatorType: 'schema',
    status: findings.length > 0 ? 'pending' : 'passed',
    summary:
      findings.length > 0
        ? `Schema evaluator found ${findings.length} issue(s)`
        : 'Schema evaluator passed',
    findings,
    evidence,
  });
}

function collectContextPackEvidenceRefs(
  pack: Record<string, unknown> | null,
): Set<string> {
  const refs = new Set<string>();
  const arrays = [
    pack?.evidence_index,
    pack?.input_refs,
    pack?.prior_artifacts,
    pack?.codebase_location_refs,
  ];
  for (const value of arrays) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const ref = trimText(item.ref_id) || trimText(item.refId);
      if (ref) refs.add(ref);
    }
  }
  return refs;
}

function requiredInputRefs(pack: Record<string, unknown> | null): string[] {
  if (!pack) return [];
  const requiredSourceIds = new Set<string>();
  const queryPlan = isPlainObject(pack.query_plan) ? pack.query_plan : {};
  const sources = Array.isArray(queryPlan.sources) ? queryPlan.sources : [];
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    if (source.type === 'workflow_input' && source.required === true) {
      const id = trimText(source.id);
      if (id) requiredSourceIds.add(id);
    }
  }
  const refs: string[] = [];
  for (const item of Array.isArray(pack.input_refs) ? pack.input_refs : []) {
    if (!isPlainObject(item)) continue;
    const sourceId = trimText(item.source_id) || trimText(item.sourceId);
    const ref = trimText(item.ref_id) || trimText(item.refId);
    if (ref && requiredSourceIds.has(sourceId)) refs.push(ref);
  }
  return Array.from(new Set(refs));
}

function traceId(item: TraceabilityRefObject): string {
  return trimText(item.id) || trimText(item.ref_id);
}

function collectTraceRefs(value: unknown): string[] {
  return normalizeList(value);
}

function traceObjectEvidenceRefs(item: TraceabilityRefObject): string[] {
  return [
    ...collectTraceRefs(item.evidence),
    ...collectTraceRefs(item.evidence_refs),
    ...collectTraceRefs(item.evidenceRefs),
  ];
}

function traceObjectSourceRefs(item: TraceabilityRefObject): string[] {
  return [
    ...collectTraceRefs(item.source_refs),
    ...collectTraceRefs(item.sourceRefs),
  ];
}

function coverageEvidenceRefs(item: TraceabilityCoverageEntry): string[] {
  return [
    ...collectTraceRefs(item.evidence),
    ...collectTraceRefs(item.evidence_refs),
    ...collectTraceRefs(item.evidenceRefs),
  ];
}

function coverageCoveredBy(item: TraceabilityCoverageEntry): string[] {
  return [
    ...collectTraceRefs(item.covered_by),
    ...collectTraceRefs(item.coveredBy),
  ];
}

function traceEvidenceRef(item: Record<string, unknown>): string {
  return (
    trimText(item.ref_id) ||
    trimText(item.refId) ||
    trimText(item.id) ||
    trimText(item.ref)
  );
}

function payloadEvidenceRefs(payload: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  if (!Array.isArray(payload.evidence)) return refs;
  for (const item of payload.evidence) {
    if (!isPlainObject(item)) continue;
    const ref =
      trimText(item.refId) || trimText(item.ref_id) || trimText(item.id);
    if (ref) refs.add(ref);
  }
  return refs;
}

function knownEvidenceRefs(input: {
  contextPack: Record<string, unknown> | null;
  traceability: WorkflowTraceabilityArtifact | null;
  payload: Record<string, unknown>;
}): Set<string> {
  const refs = collectContextPackEvidenceRefs(input.contextPack);
  for (const ref of payloadEvidenceRefs(input.payload)) refs.add(ref);
  for (const item of Array.isArray(input.traceability?.evidence)
    ? input.traceability.evidence
    : []) {
    const ref = traceEvidenceRef(item);
    if (ref) refs.add(ref);
  }
  return refs;
}

function allTraceEvidence(input: {
  traceability: WorkflowTraceabilityArtifact | null;
  payload: Record<string, unknown>;
}): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(input.payload.evidence)) {
    for (const item of input.payload.evidence) {
      if (isPlainObject(item)) items.push(item);
    }
  }
  if (Array.isArray(input.traceability?.evidence)) {
    for (const item of input.traceability.evidence) {
      if (isPlainObject(item)) items.push(item);
    }
  }
  return items;
}

function evaluateContextCoverage(input: {
  workflow: Workflow;
  stageKey: string;
  contextPack: LoadedContextPack;
  traceability: LoadedTraceability;
  allowOpenQuestions?: boolean;
}): WorkflowStageEvalResult {
  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [];

  if (!input.contextPack.pack) {
    pushEvidence(evidence, {
      type: 'workflow_state',
      path: input.contextPack.workspacePath || undefined,
      summary: `Context Pack not available; context coverage was not enforced (${input.contextPack.error || 'missing'})`,
    });
    return makeResult({
      evaluatorType: 'context_coverage',
      status: 'passed',
      summary: 'Context coverage skipped because no Context Pack was recorded',
      findings,
      evidence,
    });
  }

  if (!input.traceability.traceability) {
    pushFinding(findings, {
      code: 'traceability.artifact_missing',
      severity: 'high',
      message: `Traceability artifact is required: ${input.traceability.workspacePath || 'traceability.json'}`,
      stageKey: input.stageKey,
      path: input.traceability.hostPath || input.traceability.workspacePath,
      suggestion:
        'Write traceability.json with statements, decisions, actions, evidence, coverage, and open_questions.',
    });
  } else {
    pushEvidence(evidence, {
      type: input.traceability.source === 'payload' ? 'message' : 'artifact',
      path:
        input.traceability.source === 'payload'
          ? undefined
          : input.traceability.hostPath || input.traceability.workspacePath,
      summary: `Traceability artifact loaded from ${input.traceability.workspacePath}`,
    });
  }

  const traceability = input.traceability.traceability;
  if (!traceability) {
    return makeResult({
      evaluatorType: 'context_coverage',
      status: 'needs_revision',
      summary:
        'Context coverage failed because traceability artifact is missing',
      findings,
      evidence,
    });
  }

  if (!Array.isArray(traceability.coverage)) {
    pushFinding(findings, {
      code: 'traceability.coverage_missing',
      severity: 'high',
      message: 'traceability.json must include coverage array',
      stageKey: input.stageKey,
      path: input.traceability.hostPath || input.traceability.workspacePath,
    });
  }

  const coveredSourceIds = new Set(
    (Array.isArray(traceability.coverage) ? traceability.coverage : [])
      .map((item) => trimText(item.source_id) || trimText(item.sourceId))
      .filter(Boolean),
  );
  for (const ref of requiredInputRefs(input.contextPack.pack)) {
    if (!coveredSourceIds.has(ref)) {
      pushFinding(findings, {
        code: 'context_coverage.required_input_uncovered',
        severity: 'high',
        message: `Required Context Pack input ${ref} is not covered by traceability.coverage`,
        stageKey: input.stageKey,
        path: input.traceability.hostPath || input.traceability.workspacePath,
      });
    }
  }

  const knownTraceIds = new Set<string>();
  for (const list of [
    traceability.statements,
    traceability.decisions,
    traceability.actions,
    traceability.acceptance_criteria,
    traceability.checks,
    traceability.test_results,
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = traceId(item);
      if (id) knownTraceIds.add(id);
    }
  }

  for (const [index, item] of (Array.isArray(traceability.coverage)
    ? traceability.coverage
    : []
  ).entries()) {
    const sourceId = trimText(item.source_id) || trimText(item.sourceId);
    if (!sourceId) {
      pushFinding(findings, {
        code: 'context_coverage.source_id_missing',
        severity: 'high',
        message: `coverage[${index}] is missing source_id`,
        stageKey: input.stageKey,
        path: input.traceability.hostPath || input.traceability.workspacePath,
      });
    }
    const coveredBy = coverageCoveredBy(item);
    if (coveredBy.length === 0) {
      pushFinding(findings, {
        code: 'context_coverage.covered_by_missing',
        severity: 'high',
        message: `coverage[${index}] for ${sourceId || 'unknown source'} is missing covered_by`,
        stageKey: input.stageKey,
        path: input.traceability.hostPath || input.traceability.workspacePath,
      });
    }
    for (const ref of coveredBy) {
      if (!knownTraceIds.has(ref)) {
        pushFinding(findings, {
          code: 'context_coverage.covered_by_unknown',
          severity: 'medium',
          message: `coverage[${index}] references unknown traceability item ${ref}`,
          stageKey: input.stageKey,
          path: input.traceability.hostPath || input.traceability.workspacePath,
        });
      }
    }
  }

  const openQuestions = Array.isArray(traceability.open_questions)
    ? traceability.open_questions.filter((item) => String(item || '').trim())
    : [];
  if (openQuestions.length > 0 && !input.allowOpenQuestions) {
    pushFinding(findings, {
      code: 'context_coverage.open_questions_present',
      severity: 'high',
      message: `Traceability has unresolved open questions: ${openQuestions.length}`,
      stageKey: input.stageKey,
      path: input.traceability.hostPath || input.traceability.workspacePath,
    });
  }

  const requiredSections: Array<keyof WorkflowTraceabilityArtifact> = [
    'statements',
    'decisions',
    'actions',
    'acceptance_criteria',
    'evidence',
  ];
  for (const section of requiredSections) {
    const value = traceability[section];
    if (!Array.isArray(value) || value.length === 0) {
      pushFinding(findings, {
        code: 'traceability.required_section_empty',
        severity: 'high',
        message: `traceability.json must include non-empty ${section}`,
        stageKey: input.stageKey,
        path: input.traceability.hostPath || input.traceability.workspacePath,
      });
    }
  }

  return makeResult({
    evaluatorType: 'context_coverage',
    summary:
      findings.length > 0
        ? `Context coverage found ${findings.length} issue(s)`
        : 'Context coverage passed',
    findings,
    evidence,
  });
}

function evidenceType(
  item: Record<string, unknown>,
): WorkflowEvalEvidence['type'] {
  const type = trimText(item.type);
  if (
    type === 'artifact' ||
    type === 'message' ||
    type === 'workflow_state' ||
    type === 'test_result' ||
    type === 'user_feedback' ||
    type === 'input' ||
    type === 'codebase_location' ||
    type === 'code' ||
    type === 'command' ||
    type === 'wiki' ||
    type === 'log' ||
    type === 'provider'
  ) {
    return type;
  }
  return 'message';
}

function hasAnyField(item: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => trimText(item[field]));
}

function validateEvidenceWorkspacePaths(input: {
  workflow: Workflow;
  item: Record<string, unknown>;
  evidenceType: WorkflowEvalEvidence['type'];
  missing: (message: string, severity?: Severity) => void;
}): void {
  for (const field of ['path', 'reportPath', 'report_path']) {
    const value = trimText(input.item[field]);
    if (!value) continue;
    const scopeError = workspaceEvidenceScopeError({
      workflow: input.workflow,
      workspacePath: value,
      evidenceType: input.evidenceType,
    });
    if (scopeError) {
      input.missing(
        `${field} is outside current artifact root (${scopeError}): ${value}`,
      );
    }
  }
}

function validateEvidenceItem(input: {
  workflow: Workflow;
  stageKey: string;
  item: Record<string, unknown>;
  index: number;
  findings: WorkflowEvalFinding[];
  tracePath: string;
}): void {
  const ref = traceEvidenceRef(input.item);
  const type = evidenceType(input.item);
  const summary = trimText(input.item.summary);
  const fieldPath = ref || `evidence[${input.index}]`;
  const missing = (message: string, severity: Severity = 'high') =>
    pushFinding(input.findings, {
      code: 'evidence.source_incomplete',
      severity,
      message: `${fieldPath}: ${message}`,
      stageKey: input.stageKey,
      path: input.tracePath || undefined,
    });

  if (!ref) missing('missing ref_id/refId/id');
  if (!summary) missing('missing summary');

  if (type === 'code') {
    if (!trimText(input.item.path)) missing('code evidence requires path');
    if (
      !hasAnyField(input.item, [
        'branch',
        'commit',
        'repoPath',
        'repo_path',
        'repo',
      ])
    ) {
      missing('code evidence requires branch, commit, repo, or repoPath');
    }
    const hasLocator =
      typeof input.item.lineStart === 'number' ||
      typeof input.item.line_start === 'number' ||
      typeof input.item.lineEnd === 'number' ||
      typeof input.item.line_end === 'number' ||
      !!trimText(input.item.symbol);
    if (!hasLocator) {
      missing('code evidence should include symbol or line range', 'medium');
    }
  } else if (type === 'command') {
    if (!trimText(input.item.command))
      missing('command evidence requires command');
    if (!trimText(input.item.cwd)) missing('command evidence requires cwd');
    if (
      typeof input.item.exitCode !== 'number' &&
      typeof input.item.exit_code !== 'number'
    ) {
      missing('command evidence requires exitCode');
    }
  } else if (type === 'test_result') {
    if (
      !hasAnyField(input.item, ['command', 'reportPath', 'report_path', 'path'])
    ) {
      missing('test_result evidence requires command, reportPath, or path');
    }
  } else if (type === 'wiki') {
    if (!trimText(input.item.url)) missing('wiki evidence requires url');
    if (!hasAnyField(input.item, ['retrievedAt', 'retrieved_at'])) {
      missing('wiki evidence requires retrieved_at/retrievedAt');
    }
  } else if (type === 'log') {
    if (!hasAnyField(input.item, ['source', 'reportPath', 'report_path'])) {
      missing('log evidence requires source or reportPath');
    }
    if (!hasAnyField(input.item, ['timeRange', 'time_range', 'query'])) {
      missing('log evidence requires timeRange or query');
    }
  } else if (type === 'provider') {
    if (!trimText(input.item.source))
      missing('provider evidence requires source');
    if (
      !hasAnyField(input.item, ['path', 'url', 'reportPath', 'report_path']) &&
      !isPlainObject(input.item.metadata)
    ) {
      missing('provider evidence requires path, url, reportPath, or metadata');
    }
  }

  const service = trimText(input.item.service);
  if (service && service !== input.workflow.service) {
    missing(
      `evidence service "${service}" is outside current workflow service "${input.workflow.service}"`,
    );
  }
  validateEvidenceWorkspacePaths({
    workflow: input.workflow,
    item: input.item,
    evidenceType: type,
    missing,
  });
}

function evaluateEvidence(input: {
  workflow: Workflow;
  stageKey: string;
  payload: Record<string, unknown>;
  contextPack: LoadedContextPack;
  traceability: LoadedTraceability;
}): WorkflowStageEvalResult {
  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [];
  const trace = input.traceability.traceability;
  const knownRefs = knownEvidenceRefs({
    contextPack: input.contextPack.pack,
    traceability: trace,
    payload: input.payload,
  });
  const tracePath =
    input.traceability.hostPath || input.traceability.workspacePath || '';

  if (trace) {
    for (const [index, item] of allTraceEvidence({
      traceability: trace,
      payload: input.payload,
    }).entries()) {
      validateEvidenceItem({
        workflow: input.workflow,
        stageKey: input.stageKey,
        item,
        index,
        findings,
        tracePath,
      });
    }

    for (const listName of [
      'decisions',
      'actions',
      'acceptance_criteria',
      'checks',
      'test_results',
    ] as const) {
      const list = Array.isArray(trace[listName]) ? trace[listName] : [];
      for (const [index, item] of list.entries()) {
        const id = traceId(item) || `${listName}[${index}]`;
        const refs = evidenceRefsForTraceObject(item);
        if (refs.length === 0) {
          pushFinding(findings, {
            code: 'evidence.required_ref_missing',
            severity: 'high',
            message: `${id} must cite at least one evidence ref`,
            stageKey: input.stageKey,
            path: tracePath || undefined,
          });
        }
        for (const ref of refs) {
          if (!knownRefs.has(ref)) {
            pushFinding(findings, {
              code: 'evidence.ref_unknown',
              severity: 'high',
              message: `${id} references unknown evidence ${ref}`,
              stageKey: input.stageKey,
              path: tracePath || undefined,
            });
          }
          if (/^CODEBASE-\d+/i.test(ref)) {
            pushFinding(findings, {
              code: 'evidence.codebase_ref_misused',
              severity: 'high',
              message: `${id} uses ${ref} as decision/action evidence; CODEBASE-* can only prove repository location`,
              stageKey: input.stageKey,
              path: tracePath || undefined,
            });
          }
        }
      }
    }

    for (const [index, item] of (Array.isArray(trace.coverage)
      ? trace.coverage
      : []
    ).entries()) {
      for (const ref of coverageEvidenceRefs(item)) {
        if (!knownRefs.has(ref)) {
          pushFinding(findings, {
            code: 'evidence.coverage_ref_unknown',
            severity: 'high',
            message: `coverage[${index}] references unknown evidence ${ref}`,
            stageKey: input.stageKey,
            path: tracePath || undefined,
          });
        }
      }
    }
  } else if (input.contextPack.pack) {
    pushFinding(findings, {
      code: 'traceability.artifact_missing',
      severity: 'high',
      message:
        'Evidence evaluator requires traceability artifact when Context Pack is present',
      stageKey: input.stageKey,
      path: tracePath || undefined,
    });
  }

  if (knownRefs.size > 0) {
    pushEvidence(evidence, {
      type: 'workflow_state',
      summary: `known_evidence_refs=${knownRefs.size}`,
    });
  }

  return makeResult({
    evaluatorType: 'evidence',
    summary:
      findings.length > 0
        ? `Evidence evaluator found ${findings.length} issue(s)`
        : 'Evidence evaluator passed',
    findings,
    evidence,
  });
}

function evidenceRefsForTraceObject(item: TraceabilityRefObject): string[] {
  return traceObjectEvidenceRefs(item);
}

function evaluateConsistency(input: {
  workflow: Workflow;
  stageKey: string;
  payload: Record<string, unknown>;
  traceability: LoadedTraceability;
}): WorkflowStageEvalResult {
  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [];
  const payloadDeliverable = trimText(input.payload.deliverable);
  if (payloadDeliverable && !isSafeWorkspacePathSegment(payloadDeliverable)) {
    pushFinding(findings, {
      code: 'consistency.deliverable_invalid',
      severity: 'high',
      message: `Payload deliverable is not a safe path segment: ${payloadDeliverable}`,
      stageKey: input.stageKey,
      path: 'deliverable',
    });
  }
  const checks: Array<[string, string]> = [
    ['service', input.workflow.service],
    [
      'deliverable',
      getWorkflowContextValue(
        input.workflow,
        WORKFLOW_CONTEXT_KEYS.deliverable,
      ),
    ],
    [
      'main_branch',
      getWorkflowContextValue(input.workflow, WORKFLOW_CONTEXT_KEYS.mainBranch),
    ],
    [
      'work_branch',
      getWorkflowContextValue(input.workflow, WORKFLOW_CONTEXT_KEYS.workBranch),
    ],
  ];

  for (const [key, expected] of checks) {
    const actual = trimText(input.payload[key]);
    if (actual && expected && actual !== expected) {
      pushFinding(findings, {
        code: 'consistency.payload_context_mismatch',
        severity: 'high',
        message: `Payload ${key}="${actual}" does not match workflow context "${expected}"`,
        stageKey: input.stageKey,
        path: key,
      });
    }
  }

  const tracePath = input.traceability.workspacePath;
  const deliverable = getWorkflowContextValue(
    input.workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  if (
    tracePath &&
    deliverable &&
    tracePath !== 'payload.traceability' &&
    !tracePath.startsWith(
      `${
        resolveWorkflowStorageRoot({
          workflow: input.workflow,
          storage: getWorkflowTypeConfig(input.workflow.workflow_type)?.storage,
          root: 'artifact_root',
        }).containerPath
      }/`,
    )
  ) {
    pushFinding(findings, {
      code: 'consistency.traceability_path_mismatch',
      severity: 'high',
      message: `Traceability path is outside current artifact root: ${tracePath}`,
      stageKey: input.stageKey,
      path: input.traceability.hostPath || tracePath,
    });
  }

  pushEvidence(evidence, {
    type: 'workflow_state',
    summary: `workflow_context service=${input.workflow.service}, deliverable=${deliverable || ''}`,
  });

  return makeResult({
    evaluatorType: 'consistency',
    summary:
      findings.length > 0
        ? `Consistency evaluator found ${findings.length} issue(s)`
        : 'Consistency evaluator passed',
    findings,
    evidence,
  });
}

function evaluateExecution(input: {
  workflow: Workflow;
  stageKey: string;
  payload: Record<string, unknown>;
  traceability: LoadedTraceability;
}): WorkflowStageEvalResult {
  const findings: WorkflowEvalFinding[] = [];
  const trace = input.traceability.traceability;
  const evidenceItems = allTraceEvidence({
    traceability: trace,
    payload: input.payload,
  });
  const executionEvidence = evidenceItems.filter((item) => {
    const type = evidenceType(item);
    return type === 'command' || type === 'test_result' || type === 'provider';
  });
  if (executionEvidence.length === 0) {
    pushFinding(findings, {
      code: 'execution.evidence_missing',
      severity: 'high',
      message:
        'Execution evaluator requires command, test_result, or provider evidence',
      stageKey: input.stageKey,
      path: input.traceability.hostPath || input.traceability.workspacePath,
    });
  }
  return makeResult({
    evaluatorType: 'execution',
    summary:
      findings.length > 0
        ? `Execution evaluator found ${findings.length} issue(s)`
        : 'Execution evaluator passed',
    findings,
    evidence: [
      {
        type: 'workflow_state',
        summary: `execution_evidence=${executionEvidence.length}`,
      },
    ],
  });
}

function configuredEvaluators(
  qualityGate: WorkflowQualityGate | undefined,
): Array<{ type: WorkflowStageEvaluatorType; blocking: boolean }> {
  const evaluators = qualityGate?.evaluators || [];
  if (evaluators.length === 0) {
    return [
      { type: 'schema', blocking: true },
      { type: 'artifact', blocking: true },
      { type: 'stage_rules', blocking: true },
    ];
  }
  return evaluators.map((item) => ({
    type: item.type as WorkflowStageEvaluatorType,
    blocking: item.blocking === true,
  }));
}

function mergeLegacyEvaluationResults(input: {
  stageEvaluation: WorkflowStageEvalResult;
  contractEvaluation: WorkflowStageEvalResult | null;
  missingArtifactStatus?: WorkflowStageEvaluationStatus;
}): WorkflowStageEvalResult {
  if (!input.contractEvaluation) return input.stageEvaluation;
  const contractStatus =
    input.contractEvaluation.status === 'pending'
      ? input.missingArtifactStatus || 'pending'
      : input.contractEvaluation.status;
  const severityRank: Record<WorkflowStageEvalResult['status'], number> = {
    passed: 0,
    needs_revision: 1,
    pending: 2,
    failed: 3,
  };
  const status =
    severityRank[contractStatus] > severityRank[input.stageEvaluation.status]
      ? contractStatus
      : input.stageEvaluation.status;
  return {
    status,
    score: Math.min(
      input.stageEvaluation.score,
      input.contractEvaluation.score,
    ),
    summary:
      status === input.stageEvaluation.status
        ? input.stageEvaluation.summary
        : input.contractEvaluation.summary,
    findings: [
      ...input.contractEvaluation.findings,
      ...input.stageEvaluation.findings,
    ],
    evidence: [
      ...input.contractEvaluation.evidence,
      ...input.stageEvaluation.evidence,
    ],
    evaluatorType: 'hybrid',
  };
}

function componentRecordId(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  evaluatorType: WorkflowStageEvaluatorType;
  timestamp: string;
}): string {
  const base = input.delegation?.id
    ? `wf-stage-eval-${input.delegation.id}`
    : `wf-stage-eval-${input.workflow.id}-${input.stageKey}-${input.timestamp}`;
  return `${base}-${input.evaluatorType}`;
}

function primaryRecordId(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  timestamp: string;
}): string {
  return input.delegation?.id
    ? `wf-stage-eval-${input.delegation.id}`
    : `wf-stage-eval-${input.workflow.id}-${input.stageKey}-${input.timestamp}`;
}

export function buildWorkflowQualityGateEvaluation(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  qualityGate?: WorkflowQualityGate;
  stageEvaluation: WorkflowStageEvalResult;
  contractEvaluation: WorkflowStageEvalResult | null;
  missingArtifactStatus?: WorkflowStageEvaluationStatus;
  allowOpenQuestions?: boolean;
}): WorkflowQualityGateEvaluation {
  if (!input.qualityGate) {
    return {
      finalResult: mergeLegacyEvaluationResults({
        stageEvaluation: input.stageEvaluation,
        contractEvaluation: input.contractEvaluation,
        missingArtifactStatus: input.missingArtifactStatus,
      }),
      componentResults: [],
      sourceEvaluationIds: [],
    };
  }

  const payload = getDelegationPayload(input.delegation);
  const contextPack = loadContextPack(input.workflow);
  const traceability = loadTraceability({ workflow: input.workflow, payload });
  const evaluatorConfig = configuredEvaluators(input.qualityGate);
  const resultsByType = new Map<
    WorkflowStageEvaluatorType,
    WorkflowStageEvalResult
  >();
  resultsByType.set(
    'schema',
    evaluateSchema({
      workflow: input.workflow,
      stageKey: input.stageKey,
      delegation: input.delegation,
      payload,
    }),
  );
  if (input.contractEvaluation) {
    resultsByType.set(
      'artifact',
      cloneResultWithType(input.contractEvaluation, 'artifact'),
    );
  } else {
    resultsByType.set(
      'artifact',
      makeResult({
        evaluatorType: 'artifact',
        status: 'passed',
        summary:
          'Artifact evaluator skipped because no artifact contract is configured',
      }),
    );
  }
  resultsByType.set(
    'stage_rules',
    cloneResultWithType(input.stageEvaluation, 'stage_rules'),
  );
  resultsByType.set(
    'context_coverage',
    evaluateContextCoverage({
      workflow: input.workflow,
      stageKey: input.stageKey,
      contextPack,
      traceability,
      allowOpenQuestions: input.allowOpenQuestions === true,
    }),
  );
  resultsByType.set(
    'evidence',
    evaluateEvidence({
      workflow: input.workflow,
      stageKey: input.stageKey,
      payload,
      contextPack,
      traceability,
    }),
  );
  resultsByType.set(
    'consistency',
    evaluateConsistency({
      workflow: input.workflow,
      stageKey: input.stageKey,
      payload,
      traceability,
    }),
  );
  resultsByType.set(
    'execution',
    evaluateExecution({
      workflow: input.workflow,
      stageKey: input.stageKey,
      payload,
      traceability,
    }),
  );
  resultsByType.set(
    'llm_judge',
    makeResult({
      evaluatorType: 'llm_judge',
      status: 'pending',
      score: input.stageEvaluation.score,
      summary:
        'LLM judge runs as a sidecar and is not part of deterministic aggregation yet',
      evidence: [
        {
          type: 'workflow_state',
          summary: 'llm_judge_sidecar=true',
        },
      ],
    }),
  );

  const selectedResults = evaluatorConfig
    .map((item) => ({
      ...item,
      result: resultsByType.get(item.type),
    }))
    .filter(
      (
        item,
      ): item is {
        type: WorkflowStageEvaluatorType;
        blocking: boolean;
        result: WorkflowStageEvalResult;
      } => !!item.result,
    );
  const blockingResults = selectedResults.filter((item) => item.blocking);
  const aggregateStatus = worstStatus(
    (blockingResults.length > 0 ? blockingResults : selectedResults).map(
      (item) => item.result.status,
    ),
  );
  const sourceEvaluationIds = selectedResults.map(
    (item) => `${input.stageKey}:${item.type}`,
  );
  const findings: WorkflowEvalFinding[] = [];
  const evidence: WorkflowEvalEvidence[] = [
    {
      type: 'workflow_state',
      summary: `quality_gate_policy=${input.qualityGate.pass_policy || 'all_blocking_pass'}`,
      metadata: {
        source_evaluation_ids: sourceEvaluationIds,
        blocking_evaluators: blockingResults.map((item) => item.type),
      },
    },
  ];

  for (const item of selectedResults) {
    if (item.blocking && item.result.status !== 'passed') {
      pushFinding(findings, {
        code: 'quality_gate.blocking_evaluator_not_passed',
        severity:
          item.result.status === 'failed'
            ? 'critical'
            : item.result.status === 'pending'
              ? 'high'
              : 'high',
        message: `${item.type} evaluator is blocking and returned ${item.result.status}: ${item.result.summary}`,
        stageKey: input.stageKey,
      });
    }
    for (const finding of item.result.findings) {
      pushFinding(findings, {
        ...finding,
        code: `${item.type}.${finding.code}`,
      });
    }
  }

  const finalScore = Math.min(
    ...selectedResults.map((item) => item.result.score),
    aggregateStatus === 'passed' ? 100 : 60,
  );

  return {
    finalResult: {
      evaluatorType: 'quality_gate',
      status: aggregateStatus,
      score: Number.isFinite(finalScore) ? finalScore : 0,
      summary:
        aggregateStatus === 'passed'
          ? `Quality gate passed (${blockingResults.length} blocking evaluator(s))`
          : `Quality gate ${aggregateStatus}: ${blockingResults
              .filter((item) => item.result.status !== 'passed')
              .map((item) => `${item.type}=${item.result.status}`)
              .join(', ')}`,
      findings,
      evidence,
    },
    componentResults: selectedResults
      .filter((item) => item.type !== 'llm_judge')
      .map((item) => ({
        evaluatorType: item.type,
        result: item.result,
      })),
    sourceEvaluationIds,
  };
}

export function buildWorkflowQualityGateRecords(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  evaluation: WorkflowQualityGateEvaluation;
}): {
  finalRecord: WorkflowStageEvaluationRecord;
  componentRecords: WorkflowStageEvaluationRecord[];
} {
  const timestamp = input.delegation?.updated_at || input.workflow.updated_at;
  const componentRecords = input.evaluation.componentResults.map((item) => ({
    id: componentRecordId({
      workflow: input.workflow,
      stageKey: input.stageKey,
      delegation: input.delegation,
      evaluatorType: item.evaluatorType,
      timestamp,
    }),
    workflow_id: input.workflow.id,
    delegation_id: input.delegation?.id || null,
    stage_key: `${input.stageKey}:${item.evaluatorType}`,
    evaluator_type: item.evaluatorType,
    status: item.result.status,
    score: item.result.score,
    summary: item.result.summary,
    findings_json: JSON.stringify(item.result.findings),
    evidence_json: JSON.stringify(item.result.evidence),
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const finalRecord: WorkflowStageEvaluationRecord = {
    id: primaryRecordId({
      workflow: input.workflow,
      stageKey: input.stageKey,
      delegation: input.delegation,
      timestamp,
    }),
    workflow_id: input.workflow.id,
    delegation_id: input.delegation?.id || null,
    stage_key: input.stageKey,
    evaluator_type: input.evaluation.finalResult.evaluatorType,
    status: input.evaluation.finalResult.status,
    score: input.evaluation.finalResult.score,
    summary: input.evaluation.finalResult.summary,
    findings_json: JSON.stringify(input.evaluation.finalResult.findings),
    evidence_json: JSON.stringify(input.evaluation.finalResult.evidence),
    created_at: timestamp,
    updated_at: timestamp,
  };
  return { finalRecord, componentRecords };
}
