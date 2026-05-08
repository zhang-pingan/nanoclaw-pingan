import fs from 'fs';
import path from 'path';

import { callAnthropicMessages } from './agent-api.js';
import { PROJECT_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import type {
  Delegation,
  Workflow,
  WorkflowEvalEvidence,
  WorkflowEvalFinding,
  WorkflowStageEvalResult,
  WorkflowStageEvaluationRecord,
  WorkflowStageEvaluationStatus,
} from './types.js';
import type { WorkflowEvaluatorConfig } from './workflow-evaluator-registry.js';

const LLM_JUDGE_STAGE_SUFFIX = ':llm_judge';
const DEFAULT_CONTEXT_BYTES = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function coerceStatus(value: unknown): WorkflowStageEvaluationStatus {
  if (typeof value !== 'string') return 'pending';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'passed' || normalized === 'pass') return 'passed';
  if (
    normalized === 'needs_revision' ||
    normalized === 'needs-revision' ||
    normalized === 'revise'
  ) {
    return 'needs_revision';
  }
  if (normalized === 'failed' || normalized === 'failure') return 'failed';
  return 'pending';
}

function clampScore(value: unknown, fallback: number): number {
  const score =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function parseFindings(
  stageKey: string,
  value: unknown,
): WorkflowEvalFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: WorkflowEvalFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const message = trimText(entry.message || entry.summary);
    if (!message) continue;
    const severity = entry.severity;
    findings.push({
      code: trimText(entry.code) || 'llm_judge_finding',
      severity:
        severity === 'critical' ||
        severity === 'high' ||
        severity === 'medium' ||
        severity === 'low'
          ? severity
          : 'medium',
      message,
      stageKey,
      path: trimText(entry.path) || undefined,
      suggestion: trimText(entry.suggestion) || undefined,
    });
  }
  return findings;
}

function parseEvidence(value: unknown): WorkflowEvalEvidence[] {
  if (!Array.isArray(value)) return [];
  const evidence: WorkflowEvalEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const summary = trimText(entry.summary);
    if (!summary) continue;
    const type = entry.type;
    evidence.push({
      type:
        type === 'artifact' ||
        type === 'message' ||
        type === 'workflow_state' ||
        type === 'test_result' ||
        type === 'user_feedback'
          ? type
          : 'message',
      refId: trimText(entry.refId) || undefined,
      path: trimText(entry.path) || undefined,
      summary,
    });
  }
  return evidence;
}

function sidecarRecordId(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  primaryEvaluationId: string;
}): string {
  if (input.delegation?.id) {
    return `wf-stage-llm-judge-${input.delegation.id}`;
  }
  return `wf-stage-llm-judge-${input.workflow.id}-${input.stageKey}-${input.primaryEvaluationId}`;
}

function recordTimestamp(input: {
  workflow: Workflow;
  delegation?: Delegation | null;
}): string {
  return input.delegation?.updated_at || input.workflow.updated_at;
}

function buildSidecarRecord(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  primaryEvaluationId: string;
  result: WorkflowStageEvalResult;
  updatedAt?: string;
}): WorkflowStageEvaluationRecord {
  const timestamp = input.updatedAt || recordTimestamp(input);
  return {
    id: sidecarRecordId(input),
    workflow_id: input.workflow.id,
    delegation_id: input.delegation?.id || null,
    stage_key: `${input.stageKey}${LLM_JUDGE_STAGE_SUFFIX}`,
    evaluator_type: 'llm_judge',
    status: input.result.status,
    score: input.result.score,
    summary: input.result.summary,
    findings_json: JSON.stringify(input.result.findings),
    evidence_json: JSON.stringify(input.result.evidence),
    created_at: recordTimestamp(input),
    updated_at: timestamp,
  };
}

export function buildQueuedWorkflowLlmJudgeRecord(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  primaryEvaluationId: string;
  deterministicEvaluation: WorkflowStageEvalResult;
  evaluatorConfig?: WorkflowEvaluatorConfig;
}): WorkflowStageEvaluationRecord | null {
  const aiConfig = input.evaluatorConfig?.ai;
  if (!aiConfig?.enabled) return null;

  return buildSidecarRecord({
    workflow: input.workflow,
    stageKey: input.stageKey,
    delegation: input.delegation,
    primaryEvaluationId: input.primaryEvaluationId,
    result: {
      status: 'pending',
      score: input.deterministicEvaluation.score,
      summary: `LLM judge sidecar queued; deterministic verdict is ${input.deterministicEvaluation.status}.`,
      findings: [],
      evidence: [
        {
          type: 'workflow_state',
          refId: input.primaryEvaluationId,
          summary: [
            `sidecar_for=${input.primaryEvaluationId}`,
            `evaluator=${input.evaluatorConfig?.id || 'unknown'}`,
            aiConfig.model ? `model=${aiConfig.model}` : '',
            `deterministic_status=${input.deterministicEvaluation.status}`,
          ]
            .filter(Boolean)
            .join(', '),
        },
        {
          type: 'message',
          summary: `rubric=${truncate(aiConfig.rubric, 220)}`,
        },
      ],
      evaluatorType: 'llm_judge',
    },
  });
}

export function shouldRunWorkflowLlmJudgeNow(): boolean {
  const env = readEnvFile(['NANOCLAW_WORKFLOW_LLM_JUDGE_RUN']);
  return (
    (
      process.env.NANOCLAW_WORKFLOW_LLM_JUDGE_RUN ||
      env.NANOCLAW_WORKFLOW_LLM_JUDGE_RUN ||
      ''
    )
      .trim()
      .toLowerCase() === 'true'
  );
}

function getLlmJudgeTimeoutMs(): number {
  const env = readEnvFile(['NANOCLAW_WORKFLOW_LLM_JUDGE_TIMEOUT_MS']);
  return Math.max(
    1000,
    Number.parseInt(
      process.env.NANOCLAW_WORKFLOW_LLM_JUDGE_TIMEOUT_MS ||
        env.NANOCLAW_WORKFLOW_LLM_JUDGE_TIMEOUT_MS ||
        String(DEFAULT_TIMEOUT_MS),
      10,
    ) || DEFAULT_TIMEOUT_MS,
  );
}

function safeArtifactPath(rawPath: string): string | null {
  const resolved = path.resolve(rawPath);
  const allowedRoot = path.resolve(PROJECT_ROOT, 'projects');
  if (
    resolved === allowedRoot ||
    resolved.startsWith(`${allowedRoot}${path.sep}`)
  ) {
    return resolved;
  }
  return null;
}

function collectArtifactSnippets(
  evaluation: WorkflowStageEvalResult,
  maxBytes: number,
): string {
  const snippets: string[] = [];
  let remaining = maxBytes;
  const paths = new Set(
    evaluation.evidence
      .map((item) => item.path)
      .filter((item): item is string => Boolean(item)),
  );
  for (const rawPath of paths) {
    if (remaining <= 0) break;
    const safePath = safeArtifactPath(rawPath);
    if (!safePath || !fs.existsSync(safePath)) continue;
    const content = fs.readFileSync(safePath, 'utf-8').slice(0, remaining);
    remaining -= Buffer.byteLength(content, 'utf-8');
    snippets.push(`--- artifact: ${rawPath}\n${content}`);
  }
  return snippets.join('\n\n');
}

function buildJudgePrompt(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  deterministicEvaluation: WorkflowStageEvalResult;
  evaluatorConfig: WorkflowEvaluatorConfig;
}): string {
  const aiConfig = input.evaluatorConfig.ai;
  const maxBytes = aiConfig?.max_context_bytes || DEFAULT_CONTEXT_BYTES;
  const artifactSnippets = collectArtifactSnippets(
    input.deterministicEvaluation,
    maxBytes,
  );
  return [
    `workflow_id: ${input.workflow.id}`,
    `workflow_type: ${input.workflow.workflow_type}`,
    `stage_key: ${input.stageKey}`,
    `service: ${input.workflow.service}`,
    `deterministic_status: ${input.deterministicEvaluation.status}`,
    `deterministic_score: ${input.deterministicEvaluation.score}`,
    `deterministic_summary: ${input.deterministicEvaluation.summary}`,
    `deterministic_findings: ${JSON.stringify(input.deterministicEvaluation.findings)}`,
    `deterministic_evidence: ${JSON.stringify(input.deterministicEvaluation.evidence)}`,
    `delegation_result: ${truncate(input.delegation?.result || '', maxBytes)}`,
    `rubric: ${aiConfig?.rubric || ''}`,
    artifactSnippets ? `artifact_snippets:\n${artifactSnippets}` : '',
    [
      'Return strict JSON only with fields:',
      'status: passed | failed | needs_revision | pending',
      'score: integer 0-100',
      'summary: string',
      'findings: array of {code,severity,message,stageKey,path?,suggestion?}',
      'evidence: array of {type,refId?,path?,summary}',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parseJudgeResponse(input: {
  stageKey: string;
  text: string;
  fallback: WorkflowStageEvalResult;
  model: string;
}): WorkflowStageEvalResult {
  const parsed = parseJsonObject(input.text);
  if (!parsed) {
    return {
      status: 'pending',
      score: input.fallback.score,
      summary: 'LLM judge response could not be parsed as structured JSON.',
      findings: [
        {
          code: 'llm_judge_parse_failed',
          severity: 'medium',
          message:
            truncate(input.text, 500) || 'LLM judge returned empty text.',
          stageKey: input.stageKey,
        },
      ],
      evidence: [{ type: 'message', summary: `model=${input.model}` }],
      evaluatorType: 'llm_judge',
    };
  }

  const status = coerceStatus(parsed.status);
  return {
    status,
    score: clampScore(parsed.score, input.fallback.score),
    summary:
      trimText(parsed.summary) || `LLM judge completed with verdict ${status}.`,
    findings: parseFindings(input.stageKey, parsed.findings),
    evidence: [
      { type: 'message', summary: `model=${input.model}` },
      ...parseEvidence(parsed.evidence),
    ],
    evaluatorType: 'llm_judge',
  };
}

export async function runWorkflowLlmJudgeSidecar(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  primaryEvaluationId: string;
  deterministicEvaluation: WorkflowStageEvalResult;
  evaluatorConfig?: WorkflowEvaluatorConfig;
}): Promise<WorkflowStageEvaluationRecord | null> {
  if (!input.evaluatorConfig?.ai?.enabled) return null;

  try {
    const response = await callAnthropicMessages(
      {
        system:
          'You are a workflow stage quality judge. Evaluate the stage output against the rubric. Return strict JSON only.',
        messages: [
          {
            role: 'user',
            content: buildJudgePrompt({
              workflow: input.workflow,
              stageKey: input.stageKey,
              delegation: input.delegation,
              deterministicEvaluation: input.deterministicEvaluation,
              evaluatorConfig: input.evaluatorConfig,
            }),
          },
        ],
        model: input.evaluatorConfig.ai.model,
        max_tokens: 1200,
        temperature: 0,
      },
      fetch,
      getLlmJudgeTimeoutMs(),
    );
    return buildSidecarRecord({
      workflow: input.workflow,
      stageKey: input.stageKey,
      delegation: input.delegation,
      primaryEvaluationId: input.primaryEvaluationId,
      result: parseJudgeResponse({
        stageKey: input.stageKey,
        text: response.text,
        fallback: input.deterministicEvaluation,
        model: response.model,
      }),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildSidecarRecord({
      workflow: input.workflow,
      stageKey: input.stageKey,
      delegation: input.delegation,
      primaryEvaluationId: input.primaryEvaluationId,
      result: {
        status: 'pending',
        score: input.deterministicEvaluation.score,
        summary: `LLM judge sidecar did not complete: ${truncate(message, 220)}`,
        findings: [
          {
            code: 'llm_judge_unavailable',
            severity: 'low',
            message,
            stageKey: input.stageKey,
            suggestion:
              'Set NANOCLAW_WORKFLOW_LLM_JUDGE_RUN=true and configure the agent API credentials to execute the sidecar judge.',
          },
        ],
        evidence: [
          {
            type: 'workflow_state',
            refId: input.primaryEvaluationId,
            summary: `sidecar_for=${input.primaryEvaluationId}`,
          },
        ],
        evaluatorType: 'llm_judge',
      },
      updatedAt: new Date().toISOString(),
    });
  }
}
