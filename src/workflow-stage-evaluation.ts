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
import { getWorkflowTypeConfig } from './workflow-config.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';
import { enrichWorkflowEvalEvidence } from './workflow-evidence.js';
import { parseDelegationHandoffResult } from './workflow-handoff.js';

interface ParsedDelegationPayload {
  service?: string;
  summary?: string;
  status?: string;
  verdict?: string;
  score?: number;
  deliverable?: string;
  main_branch?: string;
  work_branch?: string;
  staging_base_branch?: string;
  staging_work_branch?: string;
  access_token?: string;
  test_doc?: string;
  total?: number;
  passed?: number;
  failed?: number;
  blocked?: number;
  findings?: unknown[];
  evidence?: unknown[];
  bugs?: Array<{
    id?: string;
    title?: string;
    severity?: string;
    related_case?: string;
  }>;
  fixed_bugs?: Array<{
    id?: string;
    title?: string;
    related_case?: string;
    fix?: string;
  }>;
  error?: string;
}

function parseDelegationPayload(
  result: string | null | undefined,
): ParsedDelegationPayload {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object'
      ? (parsed as ParsedDelegationPayload)
      : {};
  } catch {
    return {};
  }
}

function getDelegationPayload(
  delegation: Delegation | null | undefined,
): ParsedDelegationPayload {
  const handoffPayload = parseDelegationHandoffResult(delegation);
  if (handoffPayload) return handoffPayload as ParsedDelegationPayload;
  return parseDelegationPayload(delegation?.result);
}

function trimText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max
    ? `${normalized.slice(0, max - 3)}...`
    : normalized;
}

function normalizeDelegationOutcome(
  delegation: Delegation | null | undefined,
): 'success' | 'failure' {
  return delegation?.outcome === 'failure' ? 'failure' : 'success';
}

function getStageLabel(workflow: Workflow, stageKey: string): string {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  return config?.status_labels[stageKey] || stageKey;
}

function pushFinding(
  findings: WorkflowEvalFinding[],
  finding: WorkflowEvalFinding,
): void {
  const exists = findings.some(
    (item) =>
      item.code === finding.code &&
      item.message === finding.message &&
      item.path === finding.path,
  );
  if (!exists) findings.push(finding);
}

function pushEvidence(
  evidence: WorkflowEvalEvidence[],
  item: WorkflowEvalEvidence,
): void {
  const exists = evidence.some(
    (entry) =>
      entry.type === item.type &&
      entry.summary === item.summary &&
      entry.path === item.path &&
      entry.refId === item.refId,
  );
  if (!exists) evidence.push(item);
}

function coerceStatus(value: unknown): WorkflowStageEvaluationStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === 'passed' ||
    normalized === 'pass' ||
    normalized === 'success' ||
    normalized === 'approved'
  ) {
    return 'passed';
  }
  if (
    normalized === 'needs_revision' ||
    normalized === 'needs-revision' ||
    normalized === 'revise' ||
    normalized === 'changes_requested' ||
    normalized === 'rejected'
  ) {
    return 'needs_revision';
  }
  if (
    normalized === 'failed' ||
    normalized === 'failure' ||
    normalized === 'error'
  ) {
    return 'failed';
  }
  if (normalized === 'pending' || normalized === 'unknown') {
    return 'pending';
  }
  return null;
}

function addStructuredVerdictEvidence(
  evidence: WorkflowEvalEvidence[],
  verdict: WorkflowStageEvaluationStatus | null,
): void {
  if (!verdict) return;
  pushEvidence(evidence, {
    type: 'message',
    summary: `skill_verdict=${verdict}`,
  });
}

function addExecutionFailureFinding(
  findings: WorkflowEvalFinding[],
  stageKey: string,
  payloadSummary: string,
  fallbackMessage: string,
): void {
  pushFinding(findings, {
    code: 'stage_execution_failed',
    severity: 'high',
    message: payloadSummary || fallbackMessage,
    stageKey,
    suggestion:
      '排查技能执行阻塞后重跑当前阶段，不要把执行失败当作业务 verdict。',
  });
}

function collectPayloadFindings(
  stageKey: string,
  payload: ParsedDelegationPayload,
): WorkflowEvalFinding[] {
  const findings: WorkflowEvalFinding[] = [];
  if (Array.isArray(payload.findings)) {
    for (const item of payload.findings) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const message =
        typeof entry.message === 'string'
          ? entry.message.trim()
          : typeof entry.summary === 'string'
            ? entry.summary.trim()
            : '';
      if (!message) continue;
      pushFinding(findings, {
        code:
          typeof entry.code === 'string' && entry.code.trim()
            ? entry.code.trim()
            : 'external_finding',
        severity:
          entry.severity === 'low' ||
          entry.severity === 'medium' ||
          entry.severity === 'high' ||
          entry.severity === 'critical'
            ? entry.severity
            : 'medium',
        message,
        stageKey,
        path:
          typeof entry.path === 'string' && entry.path.trim()
            ? entry.path.trim()
            : undefined,
        suggestion:
          typeof entry.suggestion === 'string' && entry.suggestion.trim()
            ? entry.suggestion.trim()
            : undefined,
      });
    }
  }

  if (Array.isArray(payload.bugs)) {
    for (const bug of payload.bugs) {
      if (!bug || typeof bug !== 'object') continue;
      const title = trimText(bug.title) || '测试发现问题';
      const id = trimText(bug.id);
      const relatedCase = trimText(bug.related_case);
      const severityText = trimText(bug.severity).toLowerCase();
      pushFinding(findings, {
        code: 'test_bug_found',
        severity:
          severityText === 'critical' ||
          severityText === 'high' ||
          severityText === 'medium' ||
          severityText === 'low'
            ? (severityText as WorkflowEvalFinding['severity'])
            : 'high',
        message: [id, title, relatedCase ? `case=${relatedCase}` : '']
          .filter(Boolean)
          .join(': '),
        stageKey,
      });
    }
  }

  return findings;
}

function collectPayloadEvidence(
  payload: ParsedDelegationPayload,
): WorkflowEvalEvidence[] {
  const evidence: WorkflowEvalEvidence[] = [];
  if (Array.isArray(payload.evidence)) {
    for (const item of payload.evidence) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const summary = trimText(
        typeof entry.summary === 'string' ? entry.summary : '',
      );
      if (!summary) continue;
      pushEvidence(evidence, {
        type:
          entry.type === 'artifact' ||
          entry.type === 'message' ||
          entry.type === 'workflow_state' ||
          entry.type === 'test_result' ||
          entry.type === 'user_feedback' ||
          entry.type === 'input' ||
          entry.type === 'codebase_location' ||
          entry.type === 'code' ||
          entry.type === 'command' ||
          entry.type === 'wiki' ||
          entry.type === 'log' ||
          entry.type === 'provider'
            ? entry.type
            : 'message',
        refId:
          typeof entry.refId === 'string' && entry.refId.trim()
            ? entry.refId.trim()
            : undefined,
        path:
          typeof entry.path === 'string' && entry.path.trim()
            ? entry.path.trim()
            : undefined,
        location_kind:
          typeof entry.location_kind === 'string' && entry.location_kind.trim()
            ? entry.location_kind.trim()
            : undefined,
        location_uri:
          typeof entry.location_uri === 'string' && entry.location_uri.trim()
            ? entry.location_uri.trim()
            : undefined,
        host_path:
          typeof entry.host_path === 'string' && entry.host_path.trim()
            ? entry.host_path.trim()
            : undefined,
        container_path:
          typeof entry.container_path === 'string' &&
          entry.container_path.trim()
            ? entry.container_path.trim()
            : undefined,
        root_location_uri:
          typeof entry.root_location_uri === 'string' &&
          entry.root_location_uri.trim()
            ? entry.root_location_uri.trim()
            : undefined,
        source:
          typeof entry.source === 'string' && entry.source.trim()
            ? entry.source.trim()
            : undefined,
        service:
          typeof entry.service === 'string' && entry.service.trim()
            ? entry.service.trim()
            : undefined,
        repo:
          typeof entry.repo === 'string' && entry.repo.trim()
            ? entry.repo.trim()
            : undefined,
        repoPath:
          typeof entry.repoPath === 'string' && entry.repoPath.trim()
            ? entry.repoPath.trim()
            : typeof entry.repo_path === 'string' && entry.repo_path.trim()
              ? entry.repo_path.trim()
              : undefined,
        branch:
          typeof entry.branch === 'string' && entry.branch.trim()
            ? entry.branch.trim()
            : undefined,
        commit:
          typeof entry.commit === 'string' && entry.commit.trim()
            ? entry.commit.trim()
            : undefined,
        symbol:
          typeof entry.symbol === 'string' && entry.symbol.trim()
            ? entry.symbol.trim()
            : undefined,
        url:
          typeof entry.url === 'string' && entry.url.trim()
            ? entry.url.trim()
            : undefined,
        title:
          typeof entry.title === 'string' && entry.title.trim()
            ? entry.title.trim()
            : undefined,
        command:
          typeof entry.command === 'string' && entry.command.trim()
            ? entry.command.trim()
            : undefined,
        cwd:
          typeof entry.cwd === 'string' && entry.cwd.trim()
            ? entry.cwd.trim()
            : undefined,
        exitCode:
          typeof entry.exitCode === 'number' && Number.isFinite(entry.exitCode)
            ? entry.exitCode
            : typeof entry.exit_code === 'number' &&
                Number.isFinite(entry.exit_code)
              ? entry.exit_code
              : undefined,
        hash:
          typeof entry.hash === 'string' && entry.hash.trim()
            ? entry.hash.trim()
            : undefined,
        retrievedAt:
          typeof entry.retrievedAt === 'string' && entry.retrievedAt.trim()
            ? entry.retrievedAt.trim()
            : typeof entry.retrieved_at === 'string' &&
                entry.retrieved_at.trim()
              ? entry.retrieved_at.trim()
              : undefined,
        scope:
          typeof entry.scope === 'string' && entry.scope.trim()
            ? entry.scope.trim()
            : undefined,
        locator:
          typeof entry.locator === 'string' && entry.locator.trim()
            ? entry.locator.trim()
            : undefined,
        timeRange:
          typeof entry.timeRange === 'string' && entry.timeRange.trim()
            ? entry.timeRange.trim()
            : typeof entry.time_range === 'string' && entry.time_range.trim()
              ? entry.time_range.trim()
              : undefined,
        query:
          typeof entry.query === 'string' && entry.query.trim()
            ? entry.query.trim()
            : undefined,
        reportPath:
          typeof entry.reportPath === 'string' && entry.reportPath.trim()
            ? entry.reportPath.trim()
            : typeof entry.report_path === 'string' && entry.report_path.trim()
              ? entry.report_path.trim()
              : undefined,
        lineStart:
          typeof entry.lineStart === 'number' &&
          Number.isFinite(entry.lineStart)
            ? entry.lineStart
            : typeof entry.line_start === 'number' &&
                Number.isFinite(entry.line_start)
              ? entry.line_start
              : undefined,
        lineEnd:
          typeof entry.lineEnd === 'number' && Number.isFinite(entry.lineEnd)
            ? entry.lineEnd
            : typeof entry.line_end === 'number' &&
                Number.isFinite(entry.line_end)
              ? entry.line_end
              : undefined,
        metadata:
          entry.metadata &&
          typeof entry.metadata === 'object' &&
          !Array.isArray(entry.metadata)
            ? (entry.metadata as Record<string, unknown>)
            : undefined,
        summary,
      });
    }
  }
  return evidence;
}

function addWorkflowContextEvidence(
  workflow: Workflow,
  evidence: WorkflowEvalEvidence[],
): void {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  const workBranch = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.workBranch,
  );
  const parts = [
    deliverable ? `deliverable=${deliverable}` : '',
    workBranch ? `work_branch=${workBranch}` : '',
  ].filter(Boolean);
  if (parts.length > 0) {
    pushEvidence(evidence, {
      type: 'workflow_state',
      summary: parts.join(', '),
    });
  }
}

function computeScore(
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
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

function buildSummary(
  workflow: Workflow,
  stageKey: string,
  status: WorkflowStageEvaluationStatus,
  payloadSummary: string,
  findings: WorkflowEvalFinding[],
): string {
  const stageLabel = getStageLabel(workflow, stageKey);
  const lead = payloadSummary || findings[0]?.message || '';
  const suffix = lead ? `：${truncate(lead, 180)}` : '';
  if (status === 'passed') return `${stageLabel}评测通过${suffix}`;
  if (status === 'needs_revision') return `${stageLabel}评测需回修${suffix}`;
  if (status === 'pending') return `${stageLabel}评测待补充证据${suffix}`;
  return `${stageLabel}评测失败${suffix}`;
}

function finalizeResult(input: {
  workflow: Workflow;
  stageKey: string;
  status: WorkflowStageEvaluationStatus;
  summary: string;
  findings: WorkflowEvalFinding[];
  evidence: WorkflowEvalEvidence[];
  evaluatorType: WorkflowStageEvaluatorType;
}): WorkflowStageEvalResult {
  const summary = trimText(input.summary);
  const stageLabel = getStageLabel(input.workflow, input.stageKey);
  return {
    status: input.status,
    score: computeScore(input.status, input.findings),
    summary:
      summary ||
      `${stageLabel}评测${
        input.status === 'passed'
          ? '通过'
          : input.status === 'pending'
            ? '待补充证据'
            : input.status === 'needs_revision'
              ? '需回修'
              : '失败'
      }`,
    findings: input.findings,
    evidence: input.evidence,
    evaluatorType: input.evaluatorType,
  };
}

/**
 * Generic stage-rules interpreter.
 *
 * This evaluator is intentionally free of any stage-specific (`plan`/`dev`/
 * `testing`/...) branching. Per-stage personalization — which files must
 * exist, which front matter / document sections / numeric thresholds are
 * required — is declared in the artifact contract and evaluated by the
 * `artifact` evaluator. Here we only converge the delegation's own result:
 * normalize execution outcome, coerce the structured verdict, collect any
 * worker-reported findings/evidence, and derive a final status + score.
 */
export function evaluateWorkflowStage(params: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
}): WorkflowStageEvalResult {
  const { workflow, stageKey, delegation } = params;
  const payload = getDelegationPayload(delegation);
  const outcome = normalizeDelegationOutcome(delegation);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  addWorkflowContextEvidence(workflow, evidence);

  const verdict = coerceStatus(payload.verdict) || coerceStatus(payload.status);
  addStructuredVerdictEvidence(evidence, verdict);

  const payloadSummary =
    trimText(payload.summary) || truncate(delegation?.result || '');

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure') {
    addExecutionFailureFinding(
      findings,
      stageKey,
      payloadSummary,
      `${getStageLabel(workflow, stageKey)}执行失败。`,
    );
    // An execution failure is not a business verdict. Honor an explicit
    // non-passing verdict if the skill returned one, otherwise hold the stage
    // as pending so it can be retried instead of routed forward.
    status = verdict && verdict !== 'passed' ? verdict : 'pending';
  } else if (verdict) {
    status = verdict;
  } else if (findings.some((item) => item.severity === 'critical')) {
    status = 'failed';
  } else if (findings.some((item) => item.severity === 'high')) {
    status = 'needs_revision';
  } else {
    // No coercible structured verdict — the stage cannot be auto-concluded as
    // passed, so hold it pending until a structured result is returned.
    status = 'pending';
  }

  return finalizeResult({
    workflow,
    stageKey,
    status,
    summary: buildSummary(workflow, stageKey, status, payloadSummary, findings),
    findings,
    evidence,
    evaluatorType:
      payload.findings || payload.evidence || payload.summary
        ? 'hybrid'
        : 'rules',
  });
}

export function buildWorkflowStageEvaluationRecord(params: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  result: WorkflowStageEvalResult;
}): WorkflowStageEvaluationRecord {
  const timestamp = params.delegation?.updated_at || params.workflow.updated_at;
  const id = params.delegation?.id
    ? `wf-stage-eval-${params.delegation.id}`
    : `wf-stage-eval-${params.workflow.id}-${params.stageKey}-${timestamp}`;
  const evidence = enrichWorkflowEvalEvidence({
    workflow: params.workflow,
    stageKey: params.stageKey,
    evidence: params.result.evidence,
  });
  return {
    id,
    workflow_id: params.workflow.id,
    delegation_id: params.delegation?.id || null,
    stage_key: params.stageKey,
    evaluator_type: params.result.evaluatorType,
    status: params.result.status,
    score: params.result.score,
    summary: params.result.summary,
    findings_json: JSON.stringify(params.result.findings),
    evidence_json: JSON.stringify(evidence),
    created_at: timestamp,
    updated_at: timestamp,
  };
}
