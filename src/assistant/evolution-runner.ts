import type { AssistantEvolutionItemView } from './evolution-store.js';
import {
  AssistantEvolutionRiskLevel,
  createEvolutionArtifact,
} from './evolution-store.js';

export type EvolutionRunnerPhase =
  | 'proposal'
  | 'proposal_evaluation'
  | 'proposal_refinement'
  | 'implementation'
  | 'fixing'
  | 'review';

export interface EvolutionAgentRunner {
  (input: {
    prompt: string;
    phase: EvolutionRunnerPhase;
    item: AssistantEvolutionItemView;
  }): Promise<{ ok: boolean; text: string; error?: string }>;
}

export type EvolutionRunnerOutput =
  | EvolutionProposalOutput
  | EvolutionProposalEvaluationOutput
  | EvolutionImplementationOutput
  | EvolutionReviewOutput;

export interface EvolutionProposalOutput {
  ok: boolean;
  module_scope: string;
  direction: string;
  risk_level: AssistantEvolutionRiskLevel;
  proposal: string;
  requires_user_approval?: boolean;
  blocked_by_policy?: boolean;
  blocked_reason?: string | null;
}

export interface EvolutionProposalEvaluationOutput {
  ok: boolean;
  approved_for_implementation: boolean;
  risk_level: AssistantEvolutionRiskLevel;
  evaluation: string;
  required_changes: string[];
  blocked_by_policy?: boolean;
  blocked_reason?: string | null;
}

export interface EvolutionImplementationOutput {
  ok: boolean;
  implementation_summary: string;
  changed_files: string[];
  requires_followup?: boolean;
}

export interface EvolutionReviewOutput {
  ok: boolean;
  review_complete: boolean;
  implementation_coverage: string;
  bug_report: string | null;
  required_fixes: string[];
  risk_level: AssistantEvolutionRiskLevel;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Runner output missing string field: ${field}`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Runner output missing boolean field: ${field}`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Runner output missing string array field: ${field}`);
  }
  return value;
}

function asRiskLevel(value: unknown): AssistantEvolutionRiskLevel {
  if (
    value === 'unknown' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  ) {
    return value;
  }
  throw new Error(`Runner output has invalid risk_level: ${String(value)}`);
}

function parseStrictJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Runner output is empty');
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isObject(parsed)) throw new Error('Runner output must be a JSON object');
  return parsed;
}

function validateProposalOutput(
  value: Record<string, unknown>,
): EvolutionProposalOutput {
  return {
    ok: asBoolean(value.ok, 'ok'),
    module_scope: asString(value.module_scope, 'module_scope'),
    direction: asString(value.direction, 'direction'),
    risk_level: asRiskLevel(value.risk_level),
    proposal: asString(value.proposal, 'proposal'),
    requires_user_approval:
      typeof value.requires_user_approval === 'boolean'
        ? value.requires_user_approval
        : false,
    blocked_by_policy:
      typeof value.blocked_by_policy === 'boolean'
        ? value.blocked_by_policy
        : false,
    blocked_reason:
      typeof value.blocked_reason === 'string' ? value.blocked_reason : null,
  };
}

function validateProposalEvaluationOutput(
  value: Record<string, unknown>,
): EvolutionProposalEvaluationOutput {
  return {
    ok: asBoolean(value.ok, 'ok'),
    approved_for_implementation: asBoolean(
      value.approved_for_implementation,
      'approved_for_implementation',
    ),
    risk_level: asRiskLevel(value.risk_level),
    evaluation: asString(value.evaluation, 'evaluation'),
    required_changes: asStringArray(value.required_changes, 'required_changes'),
    blocked_by_policy:
      typeof value.blocked_by_policy === 'boolean'
        ? value.blocked_by_policy
        : false,
    blocked_reason:
      typeof value.blocked_reason === 'string' ? value.blocked_reason : null,
  };
}

function validateImplementationOutput(
  value: Record<string, unknown>,
): EvolutionImplementationOutput {
  return {
    ok: asBoolean(value.ok, 'ok'),
    implementation_summary: asString(
      value.implementation_summary,
      'implementation_summary',
    ),
    changed_files: asStringArray(value.changed_files, 'changed_files'),
    requires_followup:
      typeof value.requires_followup === 'boolean'
        ? value.requires_followup
        : false,
  };
}

function validateReviewOutput(
  value: Record<string, unknown>,
): EvolutionReviewOutput {
  return {
    ok: asBoolean(value.ok, 'ok'),
    review_complete: asBoolean(value.review_complete, 'review_complete'),
    implementation_coverage: asString(
      value.implementation_coverage,
      'implementation_coverage',
    ),
    bug_report:
      typeof value.bug_report === 'string' ? value.bug_report : null,
    required_fixes: asStringArray(value.required_fixes, 'required_fixes'),
    risk_level: asRiskLevel(value.risk_level),
  };
}

export function validateEvolutionRunnerOutput(
  phase: EvolutionRunnerPhase,
  text: string,
): EvolutionRunnerOutput {
  const value = parseStrictJson(text);
  if (phase === 'proposal' || phase === 'proposal_refinement') {
    return validateProposalOutput(value);
  }
  if (phase === 'proposal_evaluation') {
    return validateProposalEvaluationOutput(value);
  }
  if (phase === 'review') {
    return validateReviewOutput(value);
  }
  return validateImplementationOutput(value);
}

function phaseInstruction(phase: EvolutionRunnerPhase): string {
  if (phase === 'proposal') {
    return [
      '选择一个低到中风险的优化方向，先写方案，不要修改文件。',
      '输出 JSON: {"ok":true,"module_scope":"assistant|web|container|docs","direction":"...","risk_level":"low|medium|high","proposal":"...","requires_user_approval":false,"blocked_by_policy":false,"blocked_reason":null}',
    ].join('\n');
  }
  if (phase === 'proposal_evaluation') {
    return [
      '评估当前方案是否完整、可执行、符合风险策略，不要修改文件。',
      '输出 JSON: {"ok":true,"approved_for_implementation":true,"risk_level":"low|medium|high","evaluation":"...","required_changes":[],"blocked_by_policy":false,"blocked_reason":null}',
    ].join('\n');
  }
  if (phase === 'proposal_refinement') {
    return [
      '根据评估意见完善方案，不要修改代码。',
      '输出 JSON: {"ok":true,"module_scope":"assistant|web|container|docs","direction":"...","risk_level":"low|medium|high","proposal":"...","requires_user_approval":false,"blocked_by_policy":false,"blocked_reason":null}',
    ].join('\n');
  }
  if (phase === 'review') {
    return [
      '对工作分支实现做复核，不要修改文件，不要合并主分支。',
      '输出 JSON: {"ok":true,"review_complete":true,"implementation_coverage":"...","bug_report":null,"required_fixes":[],"risk_level":"low|medium|high"}',
    ].join('\n');
  }
  return [
    phase === 'fixing'
      ? '根据检查或复核反馈在当前工作分支修复问题。'
      : '在当前工作分支按方案完成最小必要实现。',
    '不要切换或合并主分支，不要 push，不要访问外部账号或密钥。',
    '输出 JSON: {"ok":true,"implementation_summary":"...","changed_files":["src/example.ts"],"requires_followup":false}',
  ].join('\n');
}

export function buildEvolutionRunnerPrompt(input: {
  item: AssistantEvolutionItemView;
  phase: EvolutionRunnerPhase;
  currentBranch?: string;
  currentCommit?: string;
  checkSummary?: string | null;
}): string {
  const item = input.item;
  return [
    '你正在执行 NanoClaw 个人助手 self-evolution 内部任务。',
    '必须使用 self-evolution skill；如果 skill 不可用，按下面边界执行。',
    '',
    '硬性边界：',
    '- 程序控制状态机、分支创建、检查和主分支采纳。',
    '- 你不得合并主分支、不得 push、不得改密钥/凭据/生产配置。',
    '- 如果发现高风险或越权事项，输出 blocked_by_policy=true。',
    '- 最终回复必须是一个严格 JSON 对象，不要 markdown，不要额外文本。',
    '',
    `阶段：${input.phase}`,
    `Item ID：${item.id}`,
    `状态：${item.status}`,
    `模块：${item.module_scope}`,
    `方向：${item.direction}`,
    `风险：${item.risk_level}`,
    `基础分支：${item.base_branch}`,
    `工作分支：${item.work_branch || ''}`,
    `当前分支：${input.currentBranch || ''}`,
    `当前提交：${input.currentCommit || ''}`,
    '',
    item.proposal ? `当前方案：\n${item.proposal}` : '',
    item.proposal_evaluation
      ? `方案评估：\n${item.proposal_evaluation}`
      : '',
    item.check_summary ? `检查摘要：\n${item.check_summary}` : '',
    item.review_summary ? `复核摘要：\n${item.review_summary}` : '',
    input.checkSummary ? `本轮反馈：\n${input.checkSummary}` : '',
    '',
    phaseInstruction(input.phase),
  ]
    .filter((part) => part !== '')
    .join('\n');
}

export async function runEvolutionPhase(input: {
  item: AssistantEvolutionItemView;
  phase: EvolutionRunnerPhase;
  agentRunner: EvolutionAgentRunner;
  currentBranch?: string;
  currentCommit?: string;
  checkSummary?: string | null;
}): Promise<EvolutionRunnerOutput> {
  const prompt = buildEvolutionRunnerPrompt(input);
  const result = await input.agentRunner({
    prompt,
    phase: input.phase,
    item: input.item,
  });
  if (!result.ok) {
    throw new Error(result.error || result.text || 'Evolution runner failed');
  }
  createEvolutionArtifact({
    itemId: input.item.id,
    artifactType: `runner_${input.phase}`,
    title: `Runner output: ${input.phase}`,
    content: result.text,
  });
  return validateEvolutionRunnerOutput(input.phase, result.text);
}
