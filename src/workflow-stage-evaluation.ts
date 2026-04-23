import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { PROJECT_ROOT } from './config.js';
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
import { getDeliverableFileNameForRole } from './workflow-artifacts.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';

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

interface StageDocumentInspection {
  hostPath: string;
  workspacePath: string;
  exists: boolean;
  content: string;
  frontMatter: Record<string, unknown> | null;
}

interface RequiredPayloadField {
  name: keyof ParsedDelegationPayload;
  type: 'string' | 'number' | 'array';
}

interface StagePayloadContract {
  verdict: WorkflowStageEvaluationStatus | null;
  payloadSummary: string;
  valid: boolean;
  issues: string[];
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

function readFrontMatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  try {
    const parsed = YAML.parse(content.slice(4, end));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function inspectStageDocument(
  workflow: Workflow,
  fileName: string,
  overridePath?: string | null,
): StageDocumentInspection {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  let hostPath = overridePath?.trim()
    ? overridePath.trim()
    : deliverable
      ? path.join(
          PROJECT_ROOT,
          'projects',
          workflow.service,
          'iteration',
          deliverable,
          fileName,
        )
      : '';
  if (hostPath.startsWith('/workspace/projects/')) {
    hostPath = path.join(PROJECT_ROOT, hostPath.replace(/^\/workspace\//, ''));
  }
  const workspacePath =
    deliverable && !overridePath
      ? `/workspace/projects/${workflow.service}/iteration/${deliverable}/${fileName}`
      : hostPath;

  if (!hostPath || !fs.existsSync(hostPath)) {
    return {
      hostPath,
      workspacePath,
      exists: false,
      content: '',
      frontMatter: null,
    };
  }

  const content = fs.readFileSync(hostPath, 'utf-8');
  return {
    hostPath,
    workspacePath,
    exists: true,
    content,
    frontMatter: readFrontMatter(content),
  };
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

function hasOwnPayloadField(
  payload: ParsedDelegationPayload,
  name: keyof ParsedDelegationPayload,
): boolean {
  return Object.prototype.hasOwnProperty.call(payload, name);
}

function hasRequiredPayloadField(
  payload: ParsedDelegationPayload,
  field: RequiredPayloadField,
): boolean {
  const value = payload[field.name];
  if (field.type === 'string') {
    return typeof value === 'string' && value.trim().length > 0;
  }
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return Array.isArray(value);
}

function getStagePayloadFieldRequirements(
  stageKey: string,
): RequiredPayloadField[] {
  switch (stageKey) {
    case 'plan':
    case 'plan_examine':
    case 'dev':
    case 'dev_examine':
      return [
        { name: 'deliverable', type: 'string' },
        { name: 'main_branch', type: 'string' },
        { name: 'work_branch', type: 'string' },
      ];
    case 'ops_deploy':
      return [
        { name: 'main_branch', type: 'string' },
        { name: 'work_branch', type: 'string' },
        { name: 'staging_base_branch', type: 'string' },
        { name: 'staging_work_branch', type: 'string' },
      ];
    case 'testing':
      return [
        { name: 'deliverable', type: 'string' },
        { name: 'main_branch', type: 'string' },
        { name: 'work_branch', type: 'string' },
        { name: 'staging_base_branch', type: 'string' },
        { name: 'staging_work_branch', type: 'string' },
        { name: 'test_doc', type: 'string' },
        { name: 'total', type: 'number' },
        { name: 'passed', type: 'number' },
        { name: 'failed', type: 'number' },
        { name: 'blocked', type: 'number' },
        { name: 'bugs', type: 'array' },
      ];
    case 'fixing':
      return [
        { name: 'deliverable', type: 'string' },
        { name: 'main_branch', type: 'string' },
        { name: 'work_branch', type: 'string' },
        { name: 'staging_base_branch', type: 'string' },
        { name: 'staging_work_branch', type: 'string' },
        { name: 'test_doc', type: 'string' },
        { name: 'fixed_bugs', type: 'array' },
      ];
    default:
      return [];
  }
}

function evaluateStagePayloadContract(
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
): StagePayloadContract {
  const payloadSummary =
    trimText(payload.summary) || truncate(delegation?.result || '');
  const issues: string[] = [];

  if (!hasOwnPayloadField(payload, 'verdict') || !coerceStatus(payload.verdict)) {
    issues.push('verdict');
  }
  if (!hasOwnPayloadField(payload, 'summary') || !trimText(payload.summary)) {
    issues.push('summary');
  }
  if (!hasOwnPayloadField(payload, 'findings') || !Array.isArray(payload.findings)) {
    issues.push('findings');
  }
  if (!hasOwnPayloadField(payload, 'evidence') || !Array.isArray(payload.evidence)) {
    issues.push('evidence');
  }

  for (const field of getStagePayloadFieldRequirements(stageKey)) {
    if (!hasRequiredPayloadField(payload, field)) {
      issues.push(field.name);
    }
  }

  return {
    verdict: coerceStatus(payload.verdict),
    payloadSummary,
    valid: issues.length === 0,
    issues: Array.from(new Set(issues)),
  };
}

function addPayloadContractFinding(
  findings: WorkflowEvalFinding[],
  stageKey: string,
  issues: string[],
): void {
  if (issues.length === 0) return;
  pushFinding(findings, {
    code: 'missing_eval_contract',
    severity: 'high',
    message: `委派结果未遵循新的结构化输出契约，缺少或无效字段：${issues.join(', ')}。`,
    stageKey,
    suggestion:
      '请通过 complete_delegation.result 返回结构化 JSON，至少包含 verdict、summary、findings、evidence 以及当前 stage 的必填上下文字段。',
  });
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
    suggestion: '排查技能执行阻塞后重跑当前阶段，不要把执行失败当作业务 verdict。',
  });
}

function inferStatusFromText(
  stageKey: string,
  text: string,
): WorkflowStageEvaluationStatus | null {
  if (!text.trim()) return null;
  if (stageKey === 'plan_examine' || stageKey === 'dev_examine') {
    if (/(未通过|不通过|驳回|需修改|回修|changes requested)/i.test(text)) {
      return 'needs_revision';
    }
    if (/(通过|已通过|approve|approved)/i.test(text)) {
      return 'passed';
    }
  }
  if (stageKey === 'testing') {
    if (/(全部通过|测试通过|pass(ed)? all)/i.test(text)) return 'passed';
    if (/(缺陷|bug|失败|未通过|问题)/i.test(text)) return 'failed';
  }
  if (stageKey === 'ops_deploy') {
    if (/(部署成功|已部署|deploy(ed)? successfully)/i.test(text)) {
      return 'passed';
    }
    if (/(部署失败|回滚|failed|error)/i.test(text)) return 'failed';
  }
  if (/(失败|failed|error)/i.test(text)) return 'failed';
  if (/(需修改|待补充|未完成)/i.test(text)) return 'needs_revision';
  if (/(成功|完成|通过|success)/i.test(text)) return 'passed';
  return null;
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
          entry.type === 'user_feedback'
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
  const stagingBranch = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
  );
  const parts = [
    deliverable ? `deliverable=${deliverable}` : '',
    workBranch ? `work_branch=${workBranch}` : '',
    stagingBranch ? `staging_work_branch=${stagingBranch}` : '',
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

function hasSection(content: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
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

function evaluatePlanStage(
  workflow: Workflow,
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
): WorkflowStageEvalResult {
  const outcome = normalizeDelegationOutcome(delegation);
  const contract = evaluateStagePayloadContract(stageKey, delegation, payload);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  const planDoc = inspectStageDocument(
    workflow,
    getDeliverableFileNameForRole('planner'),
  );
  const payloadSummary = contract.payloadSummary;
  let hasRuleRevisionIssue = false;

  addWorkflowContextEvidence(workflow, evidence);
  addStructuredVerdictEvidence(evidence, contract.verdict);
  if (planDoc.exists) {
    pushEvidence(evidence, {
      type: 'artifact',
      path: planDoc.hostPath,
      summary: `发现方案文档 ${planDoc.workspacePath}`,
    });
  } else {
    pushFinding(findings, {
      code: 'missing_plan_doc',
      severity: 'high',
      message: '方案阶段完成后未找到 plan.md，无法确认交付物。',
      stageKey,
      path: planDoc.hostPath || undefined,
      suggestion: '补齐方案文档并重跑当前阶段。',
    });
  }

  if (outcome !== 'failure' && !contract.valid) {
    addPayloadContractFinding(findings, stageKey, contract.issues);
  }

  if (outcome === 'failure') {
    addExecutionFailureFinding(
      findings,
      stageKey,
      payloadSummary,
      '方案阶段执行失败。',
    );
  }

  if (planDoc.exists) {
    const frontMatter = planDoc.frontMatter;
    for (const field of ['service', 'deliverable', 'doc_type']) {
      if (
        typeof frontMatter?.[field] !== 'string' ||
        !String(frontMatter[field]).trim()
      ) {
        pushFinding(findings, {
          code: `missing_plan_front_matter_${field}`,
          severity: 'medium',
          message: `plan.md 缺少 front matter 字段 ${field}。`,
          stageKey,
          path: planDoc.hostPath,
        });
        hasRuleRevisionIssue = true;
      }
    }
    if (!hasSection(planDoc.content, [/验收标准/i, /acceptance criteria/i])) {
      pushFinding(findings, {
        code: 'missing_acceptance_criteria',
        severity: 'high',
        message: 'plan.md 缺少验收标准说明。',
        stageKey,
        path: planDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
    if (!hasSection(planDoc.content, [/范围/i, /scope/i, /边界/i])) {
      pushFinding(findings, {
        code: 'missing_scope_definition',
        severity: 'medium',
        message: 'plan.md 缺少范围或边界定义。',
        stageKey,
        path: planDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
    if (!hasSection(planDoc.content, [/风险/i, /约束/i, /限制/i])) {
      pushFinding(findings, {
        code: 'missing_risk_assessment',
        severity: 'medium',
        message: 'plan.md 缺少风险或约束说明。',
        stageKey,
        path: planDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
  }

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure' || contract.verdict === 'failed') status = 'failed';
  else if (!contract.valid || !planDoc.exists) status = 'pending';
  else if (contract.verdict === 'pending') status = 'pending';
  else if (
    contract.verdict === 'needs_revision' ||
    hasRuleRevisionIssue
  ) {
    status = 'needs_revision';
  } else {
    status = 'passed';
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

function evaluateReviewStage(
  workflow: Workflow,
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
  fileName: string,
): WorkflowStageEvalResult {
  const contract = evaluateStagePayloadContract(stageKey, delegation, payload);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  const doc = inspectStageDocument(workflow, fileName);
  const payloadSummary = contract.payloadSummary;
  const outcome = normalizeDelegationOutcome(delegation);

  addWorkflowContextEvidence(workflow, evidence);
  addStructuredVerdictEvidence(evidence, contract.verdict);
  if (doc.exists) {
    pushEvidence(evidence, {
      type: 'artifact',
      path: doc.hostPath,
      summary: `评审引用文档 ${doc.workspacePath}`,
    });
  } else {
    pushFinding(findings, {
      code: 'missing_review_artifact',
      severity: 'high',
      message: '评审阶段缺少被评审文档，无法形成有效 verdict。',
      stageKey,
      path: doc.hostPath || undefined,
      suggestion: '确认上游产物已经写入 deliverable 后再重跑。',
    });
  }

  if (outcome !== 'failure' && !contract.valid) {
    addPayloadContractFinding(findings, stageKey, contract.issues);
  }

  if (outcome === 'failure') {
    addExecutionFailureFinding(
      findings,
      stageKey,
      payloadSummary,
      '评审阶段执行失败。',
    );
  }

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure' || !contract.valid || !doc.exists) status = 'pending';
  else if (contract.verdict === 'pending') status = 'pending';
  else if (
    contract.verdict === 'failed' ||
    contract.verdict === 'needs_revision'
  ) {
    status = 'needs_revision';
  } else {
    status = 'passed';
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

function evaluateDevStage(
  workflow: Workflow,
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
): WorkflowStageEvalResult {
  const contract = evaluateStagePayloadContract(stageKey, delegation, payload);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  const devDoc = inspectStageDocument(
    workflow,
    getDeliverableFileNameForRole('dev'),
  );
  const payloadSummary = contract.payloadSummary;
  const outcome = normalizeDelegationOutcome(delegation);
  let hasRuleRevisionIssue = false;

  addWorkflowContextEvidence(workflow, evidence);
  addStructuredVerdictEvidence(evidence, contract.verdict);
  if (devDoc.exists) {
    pushEvidence(evidence, {
      type: 'artifact',
      path: devDoc.hostPath,
      summary: `发现开发文档 ${devDoc.workspacePath}`,
    });
  } else {
    pushFinding(findings, {
      code: 'missing_dev_doc',
      severity: 'high',
      message: '开发阶段未找到 dev.md，无法确认实现说明。',
      stageKey,
      path: devDoc.hostPath || undefined,
      suggestion: '补齐开发文档并重跑当前阶段。',
    });
  }

  if (outcome !== 'failure' && !contract.valid) {
    addPayloadContractFinding(findings, stageKey, contract.issues);
  }

  if (outcome === 'failure') {
    addExecutionFailureFinding(
      findings,
      stageKey,
      payloadSummary,
      '开发阶段执行失败。',
    );
  }

  if (devDoc.exists) {
    if (!hasSection(devDoc.content, [/plan\.md/i, /方案/i])) {
      pushFinding(findings, {
        code: 'missing_plan_reference',
        severity: 'medium',
        message: 'dev.md 未明确引用方案产物或方案约束。',
        stageKey,
        path: devDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
    if (
      !hasSection(devDoc.content, [
        /影响范围/i,
        /影响面/i,
        /变更范围/i,
        /scope/i,
      ])
    ) {
      pushFinding(findings, {
        code: 'missing_impact_scope',
        severity: 'medium',
        message: 'dev.md 缺少影响范围说明。',
        stageKey,
        path: devDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
    if (!hasSection(devDoc.content, [/验证/i, /自测/i, /测试/i])) {
      pushFinding(findings, {
        code: 'missing_validation_notes',
        severity: 'high',
        message: 'dev.md 缺少验证或自测说明。',
        stageKey,
        path: devDoc.hostPath,
      });
      hasRuleRevisionIssue = true;
    }
  }

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure' || contract.verdict === 'failed') status = 'failed';
  else if (!contract.valid || !devDoc.exists) status = 'pending';
  else if (contract.verdict === 'pending') status = 'pending';
  else if (
    contract.verdict === 'needs_revision' ||
    hasRuleRevisionIssue
  ) {
    status = 'needs_revision';
  } else {
    status = 'passed';
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

function evaluateOpsStage(
  workflow: Workflow,
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
): WorkflowStageEvalResult {
  const contract = evaluateStagePayloadContract(stageKey, delegation, payload);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  const payloadSummary = contract.payloadSummary;
  const outcome = normalizeDelegationOutcome(delegation);
  const stagingBaseBranch =
    trimText(payload.staging_base_branch) ||
    getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.stagingBaseBranch);
  const stagingWorkBranch =
    trimText(payload.staging_work_branch) ||
    getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.stagingWorkBranch);

  addWorkflowContextEvidence(workflow, evidence);
  addStructuredVerdictEvidence(evidence, contract.verdict);
  if (stagingBaseBranch || stagingWorkBranch) {
    pushEvidence(evidence, {
      type: 'workflow_state',
      summary: [
        stagingBaseBranch ? `staging_base_branch=${stagingBaseBranch}` : '',
        stagingWorkBranch ? `staging_work_branch=${stagingWorkBranch}` : '',
      ]
        .filter(Boolean)
        .join(', '),
    });
  } else {
    pushFinding(findings, {
      code: 'missing_deployment_branch_info',
      severity: 'high',
      message: '部署阶段未记录预发分支信息，无法确认部署证据。',
      stageKey,
      suggestion: '补齐 staging_base_branch / staging_work_branch 后重跑。',
    });
  }

  if (outcome !== 'failure' && !contract.valid) {
    addPayloadContractFinding(findings, stageKey, contract.issues);
  }

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure' || contract.verdict === 'failed') {
    status = 'failed';
    if (findings.length === 0) {
      pushFinding(findings, {
        code: 'deployment_failed',
        severity: 'critical',
        message: payloadSummary || '预发部署失败。',
        stageKey,
      });
    }
  } else if (!contract.valid || (!stagingBaseBranch && !stagingWorkBranch)) {
    status = 'pending';
  } else if (contract.verdict === 'pending') {
    status = 'pending';
  } else if (contract.verdict === 'needs_revision') {
    status = 'needs_revision';
  } else {
    status = 'passed';
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

function evaluateTestingStage(
  workflow: Workflow,
  stageKey: string,
  delegation: Delegation | null | undefined,
  payload: ParsedDelegationPayload,
): WorkflowStageEvalResult {
  const contract = evaluateStagePayloadContract(stageKey, delegation, payload);
  const findings = collectPayloadFindings(stageKey, payload);
  const evidence = collectPayloadEvidence(payload);
  const testDoc = inspectStageDocument(
    workflow,
    getDeliverableFileNameForRole('test'),
    payload.test_doc || null,
  );
  const payloadSummary = contract.payloadSummary;
  const outcome = normalizeDelegationOutcome(delegation);
  const total = typeof payload.total === 'number' ? payload.total : null;
  const passed = typeof payload.passed === 'number' ? payload.passed : null;
  const failed = typeof payload.failed === 'number' ? payload.failed : null;
  const blocked = typeof payload.blocked === 'number' ? payload.blocked : null;
  const hasStructuredResults =
    total !== null || passed !== null || failed !== null || blocked !== null;

  addWorkflowContextEvidence(workflow, evidence);
  addStructuredVerdictEvidence(evidence, contract.verdict);
  if (testDoc.exists) {
    pushEvidence(evidence, {
      type: 'artifact',
      path: testDoc.hostPath,
      summary: `发现测试文档 ${testDoc.workspacePath}`,
    });
  }
  if (hasStructuredResults) {
    pushEvidence(evidence, {
      type: 'test_result',
      summary: [
        total !== null ? `total=${total}` : '',
        passed !== null ? `passed=${passed}` : '',
        failed !== null ? `failed=${failed}` : '',
        blocked !== null ? `blocked=${blocked}` : '',
      ]
        .filter(Boolean)
        .join(', '),
    });
  }

  if (outcome !== 'failure' && !contract.valid) {
    addPayloadContractFinding(findings, stageKey, contract.issues);
  }

  if (!testDoc.exists && !hasStructuredResults && findings.length === 0) {
    pushFinding(findings, {
      code: 'missing_verification_evidence',
      severity: 'high',
      message: '测试阶段缺少 test.md 或结构化测试结果，无法确认结论。',
      stageKey,
      path: testDoc.hostPath || undefined,
      suggestion: '补齐测试文档或返回结构化测试结果后重跑。',
    });
  }

  if (
    (failed || 0) > 0 &&
    !findings.some((item) => item.code === 'test_bug_found')
  ) {
    pushFinding(findings, {
      code: 'test_cases_failed',
      severity: 'high',
      message: `测试未通过，失败用例数 ${failed}.`,
      stageKey,
    });
  }

  let status: WorkflowStageEvaluationStatus;
  if (outcome === 'failure') {
    addExecutionFailureFinding(
      findings,
      stageKey,
      payloadSummary,
      '测试阶段执行失败。',
    );
    status = 'pending';
  } else if (!contract.valid) {
    status = 'pending';
  } else if (
    (failed || 0) > 0 ||
    findings.some((item) => item.code === 'test_bug_found')
  ) {
    status = 'failed';
  } else if (
    contract.verdict === 'failed' ||
    contract.verdict === 'needs_revision'
  ) {
    status = 'failed';
    if (findings.length === 0) {
      pushFinding(findings, {
        code: 'test_execution_failed',
        severity: 'high',
        message: payloadSummary || '测试阶段未通过。',
        stageKey,
      });
    }
  } else if (!testDoc.exists && !hasStructuredResults) {
    status = 'pending';
  } else if (contract.verdict === 'pending') {
    status = 'pending';
  } else {
    status = 'passed';
  }

  return finalizeResult({
    workflow,
    stageKey,
    status,
    summary: buildSummary(workflow, stageKey, status, payloadSummary, findings),
    findings,
    evidence,
    evaluatorType:
      payload.findings ||
      payload.evidence ||
      payload.summary ||
      hasStructuredResults
        ? 'hybrid'
        : 'rules',
  });
}

export function evaluateWorkflowStage(params: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
}): WorkflowStageEvalResult {
  const payload = parseDelegationPayload(params.delegation?.result);
  switch (params.stageKey) {
    case 'plan':
      return evaluatePlanStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
      );
    case 'plan_examine':
      return evaluateReviewStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
        getDeliverableFileNameForRole('planner'),
      );
    case 'dev':
    case 'fixing':
      return evaluateDevStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
      );
    case 'dev_examine':
      return evaluateReviewStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
        getDeliverableFileNameForRole('dev'),
      );
    case 'ops_deploy':
      return evaluateOpsStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
      );
    case 'testing':
      return evaluateTestingStage(
        params.workflow,
        params.stageKey,
        params.delegation,
        payload,
      );
    default: {
      const findings = collectPayloadFindings(params.stageKey, payload);
      const evidence = collectPayloadEvidence(payload);
      addWorkflowContextEvidence(params.workflow, evidence);
      const payloadSummary =
        trimText(payload.summary) || truncate(params.delegation?.result || '');
      const textVerdict =
        coerceStatus(payload.status) ||
        coerceStatus(payload.verdict) ||
        inferStatusFromText(
          params.stageKey,
          `${payloadSummary}\n${params.delegation?.result || ''}`,
        );
      const outcome = normalizeDelegationOutcome(params.delegation);
      const status =
        textVerdict ||
        (outcome === 'failure'
          ? 'failed'
          : payloadSummary
            ? 'passed'
            : 'pending');
      return finalizeResult({
        workflow: params.workflow,
        stageKey: params.stageKey,
        status,
        summary: buildSummary(
          params.workflow,
          params.stageKey,
          status,
          payloadSummary,
          findings,
        ),
        findings,
        evidence,
        evaluatorType:
          payload.findings || payload.evidence || payload.summary
            ? 'hybrid'
            : 'rules',
      });
    }
  }
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
    evidence_json: JSON.stringify(params.result.evidence),
    created_at: timestamp,
    updated_at: timestamp,
  };
}
