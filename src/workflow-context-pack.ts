import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT, REPOS_DIR } from './config.js';
import type { RegisteredGroup, Workflow } from './types.js';
import type {
  WorkflowContextRequirementSource,
  WorkflowContextRequirements,
} from './workflow-definition.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
  WorkflowContext,
} from './workflow-context.js';

export type WorkflowContextReadinessStatus =
  | 'ready'
  | 'warning'
  | 'needs_input'
  | 'blocked';

export interface WorkflowContextPackReadiness {
  status: WorkflowContextReadinessStatus;
  missing_required_sources: string[];
  open_questions: string[];
  conflicts: string[];
}

export interface WorkflowContextPackQueryPlanSource {
  id: string;
  type: WorkflowContextRequirementSource['type'];
  required: boolean;
  refs?: string[];
  fields?: string[];
  required_when?: Record<string, unknown>;
  on_missing?: WorkflowContextRequirementSource['on_missing'];
  service?: string;
  verify_exists?: boolean;
  verify_mounted_for_role?: boolean;
  max_age_days?: number;
}

export interface WorkflowContextPack {
  version: 1;
  workflow_id: string;
  workflow_type: string;
  stage_key: string;
  role: string;
  skill: string;
  round: number;
  attempt: number;
  service: string;
  generated_at: string;
  pack_path: string;
  immutable_pack_path: string;
  hash: string;
  readiness: WorkflowContextPackReadiness;
  prompt_summary: string;
  query_plan: {
    workflow_type: string;
    stage_key: string;
    role: string;
    skill: string;
    service: string;
    sources: WorkflowContextPackQueryPlanSource[];
  };
  input_refs: Array<Record<string, unknown>>;
  prior_artifacts: Array<Record<string, unknown>>;
  codebase_location_refs: Array<Record<string, unknown>>;
  excluded_candidates: Array<Record<string, unknown>>;
  evidence_index: Array<Record<string, unknown>>;
}

export interface WorkflowContextPackBuildResult {
  pack: WorkflowContextPack;
  contextPatch: WorkflowContext;
  hostPackPath: string;
  hostImmutablePackPath: string;
}

interface BuildContextPackInput {
  workflow: Workflow;
  stageKey: string;
  role: string;
  skill: string;
  attempt: number;
  targetFolder: string;
  registeredGroups: Record<string, RegisteredGroup>;
  contextRequirements?: WorkflowContextRequirements;
}

interface ServiceConfig {
  repo_path?: string;
  [key: string]: unknown;
}

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SENSITIVE_KEY_PATTERN =
  /(access[_-]?token|token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i;

function assertSafePathSegment(label: string, value: string): void {
  if (
    !value ||
    value !== value.trim() ||
    !SAFE_PATH_SEGMENT_PATTERN.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} "${value}" is not a safe path segment`);
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

function workspaceContextPath(
  service: string,
  workflowId: string,
  stageKey: string,
  fileName: string,
): string {
  return `/workspace/projects/${service}/workflow-context/${workflowId}/${stageKey}/${fileName}`;
}

function contextPackHostDir(
  service: string,
  workflowId: string,
  stageKey: string,
): string {
  return path.join(
    PROJECT_ROOT,
    'projects',
    service,
    'workflow-context',
    workflowId,
    stageKey,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function redactContextValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (value === undefined || value === null || value === '') return '';
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactContextValue(key, item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactContextValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

function summarizeValue(value: unknown, max = 240): string {
  if (value === undefined || value === null || value === '') return '';
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((item) => String(item)).join(', ')
        : JSON.stringify(value);
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max
    ? `${normalized.slice(0, max - 3)}...`
    : normalized;
}

function defaultFieldsForWorkflowInput(): string[] {
  return [
    WORKFLOW_CONTEXT_KEYS.requirementDescription,
    WORKFLOW_CONTEXT_KEYS.requirementFiles,
    WORKFLOW_CONTEXT_KEYS.testCaseFiles,
    WORKFLOW_CONTEXT_KEYS.mainBranch,
    WORKFLOW_CONTEXT_KEYS.workBranch,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  ];
}

function isSourceRequired(source: WorkflowContextRequirementSource): boolean {
  return source.required === true;
}

function buildQueryPlanSource(
  source: WorkflowContextRequirementSource,
): WorkflowContextPackQueryPlanSource {
  return {
    id: source.id,
    type: source.type,
    required: isSourceRequired(source),
    ...(source.refs?.length ? { refs: [...source.refs] } : {}),
    ...(source.fields?.length ? { fields: [...source.fields] } : {}),
    ...(source.required_when ? { required_when: cloneJsonObject(source.required_when) } : {}),
    ...(source.on_missing ? { on_missing: source.on_missing } : {}),
    ...(source.service ? { service: source.service } : {}),
    ...(source.verify_exists !== undefined
      ? { verify_exists: source.verify_exists }
      : {}),
    ...(source.verify_mounted_for_role !== undefined
      ? { verify_mounted_for_role: source.verify_mounted_for_role }
      : {}),
    ...(source.max_age_days !== undefined
      ? { max_age_days: source.max_age_days }
      : {}),
  };
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

function getContainerPathForRepo(service: string, repoPath: string): string {
  const currentRepo = path.relative(REPOS_DIR, PROJECT_ROOT).split(path.sep).join('/');
  if (
    service === 'icarus' ||
    repoPath === 'icarus' ||
    (currentRepo && repoPath === currentRepo)
  ) {
    return '/workspace/project';
  }
  return `/workspace/repos/${repoPath}`;
}

function groupCanMountService(
  group: RegisteredGroup | undefined,
  service: string,
): boolean {
  const services = group?.containerConfig?.services;
  if (!services || services.length === 0) return false;
  return services.includes('*') || services.includes(service);
}

function nextRefId(
  prefix: string,
  existing: Array<Record<string, unknown>>,
): string {
  const count = existing.filter((item) =>
    String(item.ref_id || '').startsWith(`${prefix}-`),
  ).length;
  return `${prefix}-${String(count + 1).padStart(3, '0')}`;
}

function artifactPathFromRef(workflow: Workflow, ref: string): string {
  if (ref.endsWith('_doc')) {
    const fileName =
      ref === 'plan_doc'
        ? 'plan.md'
        : ref === 'dev_doc'
          ? 'dev.md'
          : ref === 'test_doc'
            ? 'test.md'
            : '';
    const deliverable = getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.deliverable,
    );
    if (fileName && deliverable) {
      return `/workspace/projects/${workflow.service}/iteration/${deliverable}/${fileName}`;
    }
  }
  const contextValue = workflow.context[ref];
  return typeof contextValue === 'string' ? contextValue.trim() : '';
}

function scopedHostPathFromWorkspacePath(input: {
  workflow: Workflow;
  workspacePath: string;
  allowedKinds: Array<'deliverable' | 'context_pack'>;
}): { hostPath: string; error?: string } {
  const workspacePath = input.workspacePath.trim();
  if (!workspacePath) return { hostPath: '', error: 'path_missing' };
  if (
    workspacePath.includes('\0') ||
    workspacePath.split('/').some((segment) => segment === '..')
  ) {
    return { hostPath: '', error: 'path_invalid' };
  }

  const allowedPrefixes: string[] = [];
  if (input.allowedKinds.includes('deliverable')) {
    const deliverable = getWorkflowContextValue(
      input.workflow,
      WORKFLOW_CONTEXT_KEYS.deliverable,
    );
    if (deliverable && isSafeWorkspacePathSegment(deliverable)) {
      allowedPrefixes.push(
        `/workspace/projects/${input.workflow.service}/iteration/${deliverable}/`,
      );
    }
  }
  if (input.allowedKinds.includes('context_pack')) {
    allowedPrefixes.push(
      `/workspace/projects/${input.workflow.service}/workflow-context/${input.workflow.id}/`,
    );
  }

  if (
    allowedPrefixes.length === 0 ||
    !allowedPrefixes.some((prefix) => workspacePath.startsWith(prefix))
  ) {
    return { hostPath: '', error: 'scope_mismatch' };
  }

  if (workspacePath.startsWith('/workspace/projects/')) {
    return {
      hostPath: path.join(
        PROJECT_ROOT,
        workspacePath.replace(/^\/workspace\//, ''),
      ),
    };
  }
  return { hostPath: '', error: 'unsupported_path' };
}

function artifactStalenessReason(input: {
  modifiedAt: Date;
  maxAgeDays?: number;
  now?: Date;
}): string {
  if (input.maxAgeDays === undefined) return '';
  const now = input.now || new Date();
  const maxAgeMs = input.maxAgeDays * 24 * 60 * 60 * 1000;
  return now.getTime() - input.modifiedAt.getTime() > maxAgeMs
    ? 'stale'
    : '';
}

function collectWorkflowInputSource(input: {
  workflow: Workflow;
  source: WorkflowContextRequirementSource;
  missing: string[];
  evidence: Array<Record<string, unknown>>;
  excluded: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [];
  const fields = input.source.fields?.length
    ? input.source.fields
    : defaultFieldsForWorkflowInput();
  let presentCount = 0;
  fields.forEach((field, index) => {
    const rawValue =
      field === 'name'
        ? input.workflow.name
        : field === 'service'
          ? input.workflow.service
          : input.workflow.context[field];
    const redacted = redactContextValue(field, rawValue);
    const summary = summarizeValue(redacted);
    if (!summary) {
      input.excluded.push({
        source_id: input.source.id,
        type: input.source.type,
        field,
        reason: 'empty',
      });
      return;
    }
    presentCount += 1;
    const refId = nextRefId('INPUT', input.evidence);
    refs.push({
      ref_id: refId,
      source_id: input.source.id,
      field,
      value: redacted,
      summary,
    });
    input.evidence.push({
      ref_id: refId,
      type: 'workflow_input',
      source_id: input.source.id,
      field,
      summary,
    });
  });
  if (isSourceRequired(input.source) && presentCount < fields.length) {
    input.missing.push(input.source.id);
  }
  return refs;
}

function collectArtifactSource(input: {
  workflow: Workflow;
  source: WorkflowContextRequirementSource;
  missing: string[];
  evidence: Array<Record<string, unknown>>;
  excluded: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [];
  const sourceRefs = input.source.refs?.length ? input.source.refs : [];
  if (sourceRefs.length === 0) {
    input.excluded.push({
      source_id: input.source.id,
      type: input.source.type,
      reason: 'no_refs_configured',
    });
    if (isSourceRequired(input.source)) input.missing.push(input.source.id);
    return refs;
  }

  let foundCount = 0;
  sourceRefs.forEach((ref) => {
    const workspacePath = artifactPathFromRef(input.workflow, ref);
    const resolved = workspacePath
      ? scopedHostPathFromWorkspacePath({
          workflow: input.workflow,
          workspacePath,
          allowedKinds: ['deliverable'],
        })
      : { hostPath: '', error: 'unresolved_ref' };
    const hostPath = resolved.hostPath;
    const exists = !!hostPath && fs.existsSync(hostPath);
    const refId = nextRefId('ART', input.evidence);
    if (!workspacePath || resolved.error || !exists) {
      input.excluded.push({
        source_id: input.source.id,
        type: input.source.type,
        ref,
        path: workspacePath || '',
        reason: resolved.error || 'path_missing',
      });
      return;
    }
    const stat = fs.statSync(hostPath);
    if (!stat.isFile()) {
      input.excluded.push({
        source_id: input.source.id,
        type: input.source.type,
        ref,
        path: workspacePath,
        reason: 'not_file',
      });
      return;
    }
    const staleReason = artifactStalenessReason({
      modifiedAt: stat.mtime,
      maxAgeDays: input.source.max_age_days,
    });
    if (staleReason) {
      input.excluded.push({
        source_id: input.source.id,
        type: input.source.type,
        ref,
        path: workspacePath,
        modified_at: stat.mtime.toISOString(),
        max_age_days: input.source.max_age_days,
        reason: staleReason,
      });
      return;
    }
    foundCount += 1;
    const item = {
      ref_id: refId,
      source_id: input.source.id,
      artifact_ref: ref,
      path: workspacePath,
      host_path: hostPath,
      exists,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      summary: `${ref} at ${workspacePath}`,
    };
    refs.push(item);
    input.evidence.push({
      ref_id: refId,
      type: 'artifact',
      source_id: input.source.id,
      path: workspacePath,
      summary: item.summary,
    });
  });

  if (isSourceRequired(input.source) && foundCount === 0) {
    input.missing.push(input.source.id);
  }
  return refs;
}

function collectCodebaseLocationSource(input: {
  workflow: Workflow;
  source: WorkflowContextRequirementSource;
  targetFolder: string;
  registeredGroups: Record<string, RegisteredGroup>;
  missing: string[];
  evidence: Array<Record<string, unknown>>;
  excluded: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const service = input.source.service?.trim() || input.workflow.service;
  const allServices = readServicesConfig();
  const serviceConfig = allServices[service];
  const currentRepoRelative = path
    .relative(REPOS_DIR, PROJECT_ROOT)
    .split(path.sep)
    .join('/');
  const currentRepo = isSafeRelativeRepoPath(currentRepoRelative)
    ? currentRepoRelative
    : path.basename(PROJECT_ROOT);
  const repoPath =
    typeof serviceConfig?.repo_path === 'string'
      ? serviceConfig.repo_path.trim()
      : service === 'icarus'
        ? currentRepo || path.basename(PROJECT_ROOT)
        : '';
  const repoPathIsSafe = !repoPath || isSafeRelativeRepoPath(repoPath);
  const existsInConfig = !!serviceConfig || service === 'icarus';
  const hostPath =
    repoPath &&
    repoPathIsSafe &&
    getContainerPathForRepo(service, repoPath) === '/workspace/project'
      ? PROJECT_ROOT
      : repoPath && repoPathIsSafe
        ? path.join(REPOS_DIR, repoPath)
        : '';
  const hostPathExists = !!hostPath && fs.existsSync(hostPath);
  const containerPath =
    repoPath && repoPathIsSafe ? getContainerPathForRepo(service, repoPath) : '';
  const targetGroup = Object.values(input.registeredGroups).find(
    (group) => group.folder === input.targetFolder,
  );
  const mountedForRole =
    containerPath === '/workspace/project' ||
    groupCanMountService(targetGroup, service);
  const refId = nextRefId('CODEBASE', input.evidence);
  const item = {
    ref_id: refId,
    source_id: input.source.id,
    service,
    repo_path: repoPath,
    host_path: hostPath,
    container_path: containerPath,
    exists_in_service_config: existsInConfig,
    host_path_exists: hostPathExists,
    target_folder: input.targetFolder,
    mounted_for_role: mountedForRole,
    summary: repoPath
      ? `${service} repo location: ${containerPath}`
      : `${service} repo location is not configured`,
  };

  const failedChecks: string[] = [];
  if (!existsInConfig) failedChecks.push('service_config_missing');
  if (!repoPath) failedChecks.push('repo_path_missing');
  if (repoPath && !repoPathIsSafe) failedChecks.push('repo_path_invalid');
  if (input.source.verify_exists && !hostPathExists) {
    failedChecks.push('host_path_missing');
  }
  if (input.source.verify_mounted_for_role && !mountedForRole) {
    failedChecks.push('not_mounted_for_role');
  }
  if (failedChecks.length > 0) {
    input.excluded.push({
      source_id: input.source.id,
      type: input.source.type,
      service,
      repo_path: repoPath,
      reason: failedChecks.join(','),
    });
    if (isSourceRequired(input.source)) input.missing.push(input.source.id);
  }

  input.evidence.push({
    ref_id: refId,
    type: 'codebase_location',
    source_id: input.source.id,
    service,
    repo_path: repoPath,
    host_path: hostPath,
    container_path: containerPath,
    summary: item.summary,
  });
  return [item];
}

function readinessStatus(input: {
  policy: WorkflowContextRequirements['readiness_policy'];
  missingRequiredSources: string[];
  openQuestions: string[];
  conflicts: string[];
  excludedCandidateCount: number;
  allowOpenQuestions: boolean;
}): WorkflowContextReadinessStatus {
  const hasBlockingMissing = input.missingRequiredSources.length > 0;
  const hasBlockingQuestions =
    input.openQuestions.length > 0 && !input.allowOpenQuestions;
  if (input.policy === 'block_if_required_missing') {
    if (hasBlockingMissing || input.conflicts.length > 0) return 'blocked';
    if (hasBlockingQuestions) return 'needs_input';
  }
  if (
    input.missingRequiredSources.length > 0 ||
    input.openQuestions.length > 0 ||
    input.conflicts.length > 0 ||
    input.excludedCandidateCount > 0
  ) {
    return 'warning';
  }
  return 'ready';
}

function buildPromptSummary(pack: Pick<
  WorkflowContextPack,
  | 'readiness'
  | 'input_refs'
  | 'prior_artifacts'
  | 'codebase_location_refs'
  | 'excluded_candidates'
>): string {
  const parts = [
    `readiness=${pack.readiness.status}`,
    `inputs=${pack.input_refs.length}`,
    `artifacts=${pack.prior_artifacts.length}`,
    `codebase_locations=${pack.codebase_location_refs.length}`,
  ];
  if (pack.readiness.missing_required_sources.length > 0) {
    parts.push(
      `missing=${pack.readiness.missing_required_sources.join(', ')}`,
    );
  }
  if (pack.excluded_candidates.length > 0) {
    parts.push(`excluded=${pack.excluded_candidates.length}`);
  }
  return parts.join('; ');
}

function sha256(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function packWithCanonicalHash(pack: WorkflowContextPack): {
  pack: WorkflowContextPack;
  content: string;
} {
  const canonicalContent = `${JSON.stringify({ ...pack, hash: '' }, null, 2)}\n`;
  const finalized = { ...pack, hash: sha256(canonicalContent) };
  const content = `${JSON.stringify(finalized, null, 2)}\n`;
  return { pack: finalized, content };
}

function atomicWriteContent(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

export function buildWorkflowContextPack(
  input: BuildContextPackInput,
): WorkflowContextPackBuildResult {
  assertSafePathSegment('service', input.workflow.service);
  assertSafePathSegment('workflow_id', input.workflow.id);
  assertSafePathSegment('stage_key', input.stageKey);

  const sources = input.contextRequirements?.sources || [];
  const immutableFileName = `context-pack.r${input.workflow.round}.a${input.attempt}.json`;
  const latestFileName = 'latest.json';
  const hostDir = contextPackHostDir(
    input.workflow.service,
    input.workflow.id,
    input.stageKey,
  );
  fs.mkdirSync(hostDir, { recursive: true });

  const missingRequiredSources: string[] = [];
  const openQuestions: string[] = [];
  const conflicts: string[] = [];
  const excludedCandidates: Array<Record<string, unknown>> = [];
  const evidenceIndex: Array<Record<string, unknown>> = [];
  const inputRefs: Array<Record<string, unknown>> = [];
  const priorArtifacts: Array<Record<string, unknown>> = [];
  const codebaseLocationRefs: Array<Record<string, unknown>> = [];

  for (const source of sources) {
    if (source.type === 'workflow_input') {
      inputRefs.push(
        ...collectWorkflowInputSource({
          workflow: input.workflow,
          source,
          missing: missingRequiredSources,
          evidence: evidenceIndex,
          excluded: excludedCandidates,
        }),
      );
    } else if (source.type === 'artifact') {
      priorArtifacts.push(
        ...collectArtifactSource({
          workflow: input.workflow,
          source,
          missing: missingRequiredSources,
          evidence: evidenceIndex,
          excluded: excludedCandidates,
        }),
      );
    } else if (source.type === 'codebase_location') {
      codebaseLocationRefs.push(
        ...collectCodebaseLocationSource({
          workflow: input.workflow,
          source,
          targetFolder: input.targetFolder,
          registeredGroups: input.registeredGroups,
          missing: missingRequiredSources,
          evidence: evidenceIndex,
          excluded: excludedCandidates,
        }),
      );
    }
  }

  const readiness: WorkflowContextPackReadiness = {
    status: readinessStatus({
      policy: input.contextRequirements?.readiness_policy || 'record_only',
      missingRequiredSources,
      openQuestions,
      conflicts,
      excludedCandidateCount: excludedCandidates.length,
      allowOpenQuestions:
        input.contextRequirements?.allow_open_questions === true,
    }),
    missing_required_sources: Array.from(new Set(missingRequiredSources)),
    open_questions: openQuestions,
    conflicts,
  };
  const immutablePackPath = workspaceContextPath(
    input.workflow.service,
    input.workflow.id,
    input.stageKey,
    immutableFileName,
  );
  const latestPackPath = workspaceContextPath(
    input.workflow.service,
    input.workflow.id,
    input.stageKey,
    latestFileName,
  );
  const generatedAt = new Date().toISOString();
  const packWithoutHash: WorkflowContextPack = {
    version: 1,
    workflow_id: input.workflow.id,
    workflow_type: input.workflow.workflow_type,
    stage_key: input.stageKey,
    role: input.role,
    skill: input.skill,
    round: input.workflow.round,
    attempt: input.attempt,
    service: input.workflow.service,
    generated_at: generatedAt,
    pack_path: latestPackPath,
    immutable_pack_path: immutablePackPath,
    hash: '',
    readiness,
    prompt_summary: '',
    query_plan: {
      workflow_type: input.workflow.workflow_type,
      stage_key: input.stageKey,
      role: input.role,
      skill: input.skill,
      service: input.workflow.service,
      sources: sources.map(buildQueryPlanSource),
    },
    input_refs: inputRefs,
    prior_artifacts: priorArtifacts,
    codebase_location_refs: codebaseLocationRefs,
    excluded_candidates: excludedCandidates,
    evidence_index: evidenceIndex,
  };
  packWithoutHash.prompt_summary = buildPromptSummary(packWithoutHash);

  const hostImmutablePackPath = path.join(hostDir, immutableFileName);
  const { pack, content } = packWithCanonicalHash(packWithoutHash);
  atomicWriteContent(hostImmutablePackPath, content);
  const hostPackPath = path.join(hostDir, latestFileName);
  atomicWriteContent(hostPackPath, content);

  const openQuestionsText = readiness.open_questions.length
    ? readiness.open_questions.join('\n')
    : '无';

  return {
    pack,
    hostPackPath,
    hostImmutablePackPath,
    contextPatch: {
      [WORKFLOW_CONTEXT_KEYS.contextPackPath]: pack.pack_path,
      [WORKFLOW_CONTEXT_KEYS.contextPackImmutablePath]:
        pack.immutable_pack_path,
      [WORKFLOW_CONTEXT_KEYS.contextPackHash]: pack.hash,
      [WORKFLOW_CONTEXT_KEYS.contextPackSummary]: pack.prompt_summary,
      [WORKFLOW_CONTEXT_KEYS.contextPackOpenQuestions]: openQuestionsText,
      [WORKFLOW_CONTEXT_KEYS.contextReadinessStatus]: pack.readiness.status,
      [WORKFLOW_CONTEXT_KEYS.contextPackGeneratedAt]: pack.generated_at,
    },
  };
}

export function buildContextPackPromptInstructions(
  context: WorkflowContext,
): string {
  const latestPath = String(context[WORKFLOW_CONTEXT_KEYS.contextPackPath] || '');
  if (!latestPath) return '';
  const immutablePath = String(
    context[WORKFLOW_CONTEXT_KEYS.contextPackImmutablePath] || '',
  );
  const hash = String(context[WORKFLOW_CONTEXT_KEYS.contextPackHash] || '');
  const summary = String(
    context[WORKFLOW_CONTEXT_KEYS.contextPackSummary] || '',
  );
  const readiness = String(
    context[WORKFLOW_CONTEXT_KEYS.contextReadinessStatus] || '',
  );
  const openQuestions = String(
    context[WORKFLOW_CONTEXT_KEYS.contextPackOpenQuestions] || '',
  );
  return [
    '[Context Pack]',
    `latest: ${latestPath}`,
    immutablePath ? `immutable: ${immutablePath}` : '',
    hash ? `hash: ${hash}` : '',
    readiness ? `readiness: ${readiness}` : '',
    summary ? `summary: ${summary}` : '',
    openQuestions ? `open_questions: ${openQuestions}` : '',
    '',
    '执行前请读取 latest 指向的 Context Pack，并在产物中引用其中已有的 INPUT-*、ART-*、EVID-*，或引用你在执行阶段新增且可校验的 evidence ref。',
    '你阅读代码、检索 wiki、查看日志、运行命令或调用工具得到的新事实，必须先写入阶段产物 evidence，再被 decision、action、test result 引用。',
    'CODEBASE-* 只表示代码库位置，不能作为业务、实现或测试结论依据；不要把 excluded_candidates 当事实使用。',
  ]
    .filter(Boolean)
    .join('\n');
}
