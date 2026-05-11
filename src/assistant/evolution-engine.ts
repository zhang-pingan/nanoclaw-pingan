import os from 'os';

import { logger } from '../logger.js';
import type { AssistantSettings } from './types.js';
import { getAssistantSettings } from './agent-inbox-store.js';
import {
  CommandResult,
  createDefaultEvolutionGitAdapter,
  defaultEvolutionCheckRunner,
  EvolutionCheckRunner,
  EvolutionGitAdapter,
} from './evolution-git.js';
import {
  EvolutionAgentRunner,
  EvolutionImplementationOutput,
  EvolutionProposalEvaluationOutput,
  EvolutionProposalOutput,
  EvolutionReviewOutput,
  runEvolutionPhase,
} from './evolution-runner.js';
import {
  AssistantEvolutionItemView,
  AssistantEvolutionStatus,
  AssistantEvolutionRiskLevel,
  TERMINAL_EVOLUTION_STATUSES,
  createEvolutionArtifact,
  createEvolutionItem,
  getEvolutionItem,
  getEvolutionState,
  listActiveEvolutionItems,
  releaseEvolutionLease,
  renewEvolutionLease,
  transitionEvolutionItemIfStatus,
  tryAcquireEvolutionLease,
  updateEvolutionItemIfStatus,
  WAITING_EVOLUTION_STATUSES,
} from './evolution-store.js';

export interface EvolutionEngineDeps {
  agentRunner?: EvolutionAgentRunner | null;
  git?: EvolutionGitAdapter;
  checkRunner?: EvolutionCheckRunner;
  settingsProvider?: () => AssistantSettings;
  leaseMs?: number;
  baseBranch?: string;
}

export interface EvolutionTickResult {
  ok: boolean;
  action: string;
  itemId?: string;
  status?: string;
  error?: string;
}

export interface EvolutionScheduleState {
  loopStarted: boolean;
  tickRunning: boolean;
  intervalMinutes: number;
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTickAction: string | null;
  lastTickStatus: string | null;
  lastTickOk: boolean | null;
  lastTickError: string | null;
  nextTickAt: string | null;
}

const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000;
const ENGINE_LOCK_OWNER = `assistant-evolution:${os.hostname()}:${process.pid}`;
const LEASE_RENEW_INTERVAL_MS = 60_000;
const MAX_AUTO_ADVANCE_STEPS = 20;
const PAUSABLE_RUNNING_STATUSES = [
  'discovering',
  'proposal_drafting',
  'proposal_evaluating',
  'proposal_refining',
  'waiting_user_approval',
  'branch_preparing',
  'implementing',
  'checking',
  'reviewing',
  'fixing',
  'ready_for_adoption',
  'blocked_by_policy',
  'adoption_failed',
] satisfies AssistantEvolutionItemView['status'][];
const CANCELLABLE_STATUSES = [
  ...PAUSABLE_RUNNING_STATUSES,
] satisfies AssistantEvolutionItemView['status'][];
const NON_BLOCKING_MANUAL_WAIT_STATUSES = [
  'ready_for_adoption',
] satisfies AssistantEvolutionItemView['status'][];
const AUTO_ADVANCE_STOP_STATUSES = [
  'waiting_user_approval',
  'ready_for_adoption',
  'paused',
  'blocked_by_policy',
  'adoption_failed',
  ...TERMINAL_EVOLUTION_STATUSES,
] satisfies AssistantEvolutionItemView['status'][];
const FORBIDDEN_CHANGED_PATHS = [
  '.env',
  '.ssh',
  'mount-allowlist',
  'sender-allowlist',
  'container-runtime',
  'credential-proxy',
  'mysql-proxy',
];

let evolutionLoopStarted = false;
let evolutionLoopTimer: NodeJS.Timeout | null = null;
let evolutionNextTickAt: string | null = null;
let evolutionTickRunning = false;
let evolutionLastTickStartedAt: string | null = null;
let evolutionLastTickFinishedAt: string | null = null;
let evolutionLastTickAction: string | null = null;
let evolutionLastTickStatus: string | null = null;
let evolutionLastTickOk: boolean | null = null;
let evolutionLastTickError: string | null = null;
let deps: Required<Omit<EvolutionEngineDeps, 'agentRunner'>> & {
  agentRunner: EvolutionAgentRunner | null;
} = {
  agentRunner: null,
  git: createDefaultEvolutionGitAdapter(),
  checkRunner: defaultEvolutionCheckRunner,
  settingsProvider: getAssistantSettings,
  leaseMs: DEFAULT_LEASE_MS,
  baseBranch: 'main',
};

function evolutionDelayMs(settings: AssistantSettings): number {
  return Math.max(settings.evolution.scanIntervalMinutes, 5) * 60 * 1000;
}

function clearEvolutionLoopTimer(): void {
  if (evolutionLoopTimer) {
    clearTimeout(evolutionLoopTimer);
    evolutionLoopTimer = null;
  }
  evolutionNextTickAt = null;
}

function scheduleNextEvolutionTick(): void {
  const settings = deps.settingsProvider();
  const delayMs = evolutionDelayMs(settings);
  evolutionNextTickAt = String(Date.now() + delayMs);
  evolutionLoopTimer = setTimeout(runEvolutionLoop, delayMs);
}

function runEvolutionLoop(): void {
  evolutionLoopTimer = null;
  evolutionNextTickAt = null;
  void runEvolutionTick()
    .catch((err) => {
      logger.error({ err }, 'Assistant evolution tick failed');
    })
    .finally(() => {
      scheduleNextEvolutionTick();
    });
}

function riskRank(level: AssistantEvolutionRiskLevel): number {
  if (level === 'low') return 1;
  if (level === 'medium') return 2;
  if (level === 'high') return 3;
  return 0;
}

function isRiskAllowed(
  risk: AssistantEvolutionRiskLevel,
  allowed: AssistantSettings['evolution']['allowedRiskLevel'],
): boolean {
  if (risk === 'unknown') return false;
  return riskRank(risk) <= riskRank(allowed);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'change';
}

function summarizeCommandResult(result: CommandResult): string {
  return [
    `$ ${result.command}`,
    result.ok ? 'status: passed' : 'status: failed',
    result.stdout ? `stdout:\n${result.stdout.slice(-6000)}` : '',
    result.stderr ? `stderr:\n${result.stderr.slice(-6000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function hasForbiddenPath(files: string[]): string | null {
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    if (
      FORBIDDEN_CHANGED_PATHS.some((pattern) => normalized.includes(pattern))
    ) {
      return normalized;
    }
  }
  return null;
}

function terminalOrWaitingInterruption(
  itemId: string,
): EvolutionTickResult | null {
  const latest = getEvolutionItem(itemId);
  if (!latest) {
    return {
      ok: true,
      action: 'interrupted',
      itemId,
      status: 'missing',
    };
  }
  if (
    latest.status === 'paused' ||
    TERMINAL_EVOLUTION_STATUSES.includes(latest.status)
  ) {
    return {
      ok: true,
      action: 'interrupted',
      itemId,
      status: latest.status,
    };
  }
  return null;
}

function completeExpectedStatusUpdate(
  item: AssistantEvolutionItemView,
  updated: AssistantEvolutionItemView | null,
  action: string,
): EvolutionTickResult {
  if (updated) {
    return {
      ok: true,
      action,
      itemId: updated.id,
      status: updated.status,
    };
  }
  const interrupted = terminalOrWaitingInterruption(item.id);
  if (interrupted) return interrupted;
  const latest = getEvolutionItem(item.id);
  return {
    ok: false,
    action: 'status_conflict',
    itemId: item.id,
    status: latest?.status,
    error: `Evolution item status changed while processing ${item.status}`,
  };
}

function isTerminalStatus(status: AssistantEvolutionStatus): boolean {
  return TERMINAL_EVOLUTION_STATUSES.includes(status);
}

function isAutoAdvanceStopStatus(status: AssistantEvolutionStatus): boolean {
  return AUTO_ADVANCE_STOP_STATUSES.includes(status);
}

function isNonBlockingManualWaitStatus(
  item: AssistantEvolutionItemView,
  settings: AssistantSettings,
): boolean {
  return (
    NON_BLOCKING_MANUAL_WAIT_STATUSES.includes(item.status as never) &&
    !(
      item.risk_level === 'low' &&
      settings.evolution.autoAdoptEnabled
    )
  );
}

function findBlockingEvolutionItem(
  settings: AssistantSettings,
): AssistantEvolutionItemView | null {
  const items = listActiveEvolutionItems();
  for (const item of items) {
    if (isNonBlockingManualWaitStatus(item, settings)) continue;
    return item;
  }
  return null;
}

async function changedFilesSinceBase(
  baseCommit: string | null,
): Promise<string[]> {
  const committed = await deps.git.changedFiles(baseCommit || undefined);
  const worktree = await deps.git.worktreeChangedFiles();
  return Array.from(new Set([...committed, ...worktree])).sort();
}

async function assertOnWorkBranch(item: AssistantEvolutionItemView): Promise<void> {
  if (!item.work_branch) return;
  const branch = await deps.git.currentBranch();
  if (branch !== item.work_branch) {
    throw new Error(
      `Current branch ${branch} does not match ${item.work_branch}`,
    );
  }
}

async function checkoutWorkBranchIfNeeded(
  item: AssistantEvolutionItemView,
): Promise<void> {
  if (!item.work_branch) return;
  const branch = await deps.git.currentBranch();
  if (branch === item.work_branch) return;
  const checkout = await deps.git.checkout(item.work_branch);
  if (!checkout.ok) {
    throw new Error(summarizeCommandResult(checkout));
  }
}

async function commitWorkBranchChanges(
  item: AssistantEvolutionItemView,
): Promise<string> {
  const add = await deps.git.addAll();
  if (!add.ok) {
    throw new Error(summarizeCommandResult(add));
  }
  const commit = await deps.git.commit(
    `assistant evolution: ${item.direction}`,
  );
  if (!commit.ok) {
    throw new Error(summarizeCommandResult(commit));
  }
  return deps.git.currentCommit();
}

async function stashPolicyBlockedChanges(
  item: AssistantEvolutionItemView,
  reason: string,
): Promise<void> {
  if (!(await deps.git.hasDirtyWorktree())) return;
  const stash = await deps.git.stashPush(
    `assistant evolution blocked ${item.id}: ${reason}`,
  );
  createEvolutionArtifact({
    itemId: item.id,
    artifactType: 'blocked_worktree_cleanup',
    title: stash.command,
    content: summarizeCommandResult(stash),
  });
  if (!stash.ok) {
    throw new Error(summarizeCommandResult(stash));
  }
}

async function createDiffArtifacts(
  item: AssistantEvolutionItemView,
  changedFiles: string[],
  runnerChangedFiles?: string[],
): Promise<void> {
  createEvolutionArtifact({
    itemId: item.id,
    artifactType: 'diff_summary',
    title: 'Changed files',
    content: changedFiles.join('\n'),
    payload: { changedFiles, runnerChangedFiles: runnerChangedFiles || [] },
  });

  const diffText = await deps.git.diff(item.base_commit || undefined);
  createEvolutionArtifact({
    itemId: item.id,
    artifactType: 'diff',
    title: 'Full diff',
    content: diffText.slice(-200_000),
    payload: {
      truncated: diffText.length > 200_000,
      byteLength: diffText.length,
    },
  });
}

async function getBranchAndCommit(): Promise<{
  branch: string;
  commit: string;
}> {
  return {
    branch: await deps.git.currentBranch(),
    commit: await deps.git.currentCommit(),
  };
}

function assertAgentRunner(): EvolutionAgentRunner {
  if (!deps.agentRunner) {
    throw new Error('Evolution agent runner is not configured');
  }
  return deps.agentRunner;
}

function updateFromProposal(
  item: AssistantEvolutionItemView,
  output: EvolutionProposalOutput,
  settings: AssistantSettings,
): AssistantEvolutionItemView | null {
  if (output.blocked_by_policy || output.risk_level === 'high') {
    return updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        module_scope: output.module_scope,
        direction: output.direction,
        proposal: output.proposal,
        risk_level: output.risk_level,
        blocked_reason: output.blocked_reason || '方案触发高风险或策略阻断',
        status: 'blocked_by_policy',
      },
      'blocked_by_policy',
      { reason: output.blocked_reason || null },
    );
  }
  if (!output.ok) {
    return transitionEvolutionItemIfStatus(item.id, item.status, 'failed', {
      reason: 'proposal output ok=false',
    });
  }
  return updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      module_scope: output.module_scope,
      direction: output.direction,
      proposal: output.proposal,
      risk_level: output.risk_level,
      auto_implement:
        !output.requires_user_approval &&
        settings.evolution.autoImplementEnabled &&
        isRiskAllowed(output.risk_level, settings.evolution.allowedRiskLevel),
      auto_adopt:
        settings.evolution.autoAdoptEnabled &&
        !output.requires_user_approval &&
        output.risk_level === 'low',
      status: 'proposal_evaluating',
    },
    'proposal_written',
    { riskLevel: output.risk_level },
  );
}

function updateFromEvaluation(
  item: AssistantEvolutionItemView,
  output: EvolutionProposalEvaluationOutput,
  settings: AssistantSettings,
): AssistantEvolutionItemView | null {
  if (output.blocked_by_policy || output.risk_level === 'high') {
    return updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        proposal_evaluation: output.evaluation,
        risk_level: output.risk_level,
        blocked_reason: output.blocked_reason || '方案评估触发高风险或策略阻断',
        status: 'blocked_by_policy',
      },
      'blocked_by_policy',
      { reason: output.blocked_reason || null },
    );
  }

  if (!output.ok || !output.approved_for_implementation) {
    return updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        proposal_evaluation: output.evaluation,
        risk_level: output.risk_level,
        status: 'proposal_refining',
      },
      'proposal_needs_refinement',
      { requiredChanges: output.required_changes },
    );
  }

  const canAutoImplement =
    item.auto_implement &&
    settings.evolution.autoImplementEnabled &&
    isRiskAllowed(output.risk_level, settings.evolution.allowedRiskLevel);
  return updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      proposal_evaluation: output.evaluation,
      risk_level: output.risk_level,
      auto_implement: canAutoImplement,
      auto_adopt:
        item.auto_adopt &&
        settings.evolution.autoAdoptEnabled &&
        output.risk_level === 'low',
      status: canAutoImplement ? 'branch_preparing' : 'waiting_user_approval',
    },
    'proposal_evaluated',
    { approvedForImplementation: true, autoImplement: canAutoImplement },
  );
}

async function handleProposalPhase(
  item: AssistantEvolutionItemView,
  settings: AssistantSettings,
): Promise<EvolutionTickResult> {
  const branchInfo = await getBranchAndCommit();
  const output = (await runEvolutionPhase({
    item,
    phase:
      item.status === 'proposal_refining' ? 'proposal_refinement' : 'proposal',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionProposalOutput;
  const updated = updateFromProposal(item, output, settings);
  return completeExpectedStatusUpdate(item, updated, 'proposal');
}

async function handleEvaluationPhase(
  item: AssistantEvolutionItemView,
  settings: AssistantSettings,
): Promise<EvolutionTickResult> {
  const branchInfo = await getBranchAndCommit();
  const output = (await runEvolutionPhase({
    item,
    phase: 'proposal_evaluation',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionProposalEvaluationOutput;
  const updated = updateFromEvaluation(item, output, settings);
  return completeExpectedStatusUpdate(item, updated, 'proposal_evaluation');
}

async function handleBranchPreparing(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
  if (await deps.git.hasDirtyWorktree()) {
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        status: 'blocked_by_policy',
        blocked_reason: '主仓库存在未提交改动，无法安全创建自我进化工作分支',
      },
      'blocked_by_policy',
      { reason: 'dirty_worktree' },
    );
    return completeExpectedStatusUpdate(item, updated, 'blocked_dirty_worktree');
  }

  const baseBranch = item.base_branch || deps.baseBranch;
  const checkout = await deps.git.checkout(baseBranch);
  if (!checkout.ok) {
    throw new Error(summarizeCommandResult(checkout));
  }
  const baseCommit = await deps.git.currentCommit();
  const workBranch =
    item.work_branch || `evolution/${item.id}-${slugify(item.direction)}`;
  if (await deps.git.branchExists(workBranch)) {
    throw new Error(`Evolution work branch already exists: ${workBranch}`);
  }
  const branch = await deps.git.createBranch(workBranch);
  if (!branch.ok) {
    throw new Error(summarizeCommandResult(branch));
  }
  const updated = updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      base_branch: baseBranch,
      work_branch: workBranch,
      base_commit: baseCommit,
      status: 'implementing',
    },
    'branch_prepared',
    { baseBranch, workBranch, baseCommit },
  );
  return completeExpectedStatusUpdate(item, updated, 'branch_prepared');
}

async function handleImplementation(
  item: AssistantEvolutionItemView,
  fixing: boolean = false,
): Promise<EvolutionTickResult> {
  await checkoutWorkBranchIfNeeded(item);
  await assertOnWorkBranch(item);
  const branchInfo = await getBranchAndCommit();
  const output = (await runEvolutionPhase({
    item,
    phase: fixing ? 'fixing' : 'implementation',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionImplementationOutput;
  const interruption = terminalOrWaitingInterruption(item.id);
  if (interruption) return interruption;
  if (output.blocked_by_policy) {
    const changedFiles = await changedFilesSinceBase(item.base_commit);
    if (changedFiles.length) {
      await createDiffArtifacts(item, changedFiles, output.changed_files);
    }
    await stashPolicyBlockedChanges(item, 'runner_policy_block');
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        status: 'blocked_by_policy',
        blocked_reason: output.blocked_reason || '实现阶段触发策略阻断',
        implementation_summary: output.implementation_summary,
        head_commit: await deps.git.currentCommit(),
      },
      'blocked_by_policy',
      { reason: output.blocked_reason || null, changedFiles },
    );
    return completeExpectedStatusUpdate(item, updated, 'blocked_by_policy');
  }
  if (!output.ok) {
    const updated = transitionEvolutionItemIfStatus(
      item.id,
      item.status,
      'failed',
      {
        reason: 'implementation output ok=false',
      },
    );
    return completeExpectedStatusUpdate(item, updated, 'implementation_failed');
  }
  await assertOnWorkBranch(item);
  const changedFiles = await changedFilesSinceBase(item.base_commit);
  const forbidden = hasForbiddenPath(changedFiles);
  if (forbidden) {
    await createDiffArtifacts(item, changedFiles, output.changed_files);
    await stashPolicyBlockedChanges(item, `forbidden_path:${forbidden}`);
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        status: 'blocked_by_policy',
        blocked_reason: `实现修改了禁止路径：${forbidden}`,
        implementation_summary: output.implementation_summary,
        head_commit: await deps.git.currentCommit(),
      },
      'blocked_by_policy',
      { forbiddenPath: forbidden, changedFiles },
    );
    return completeExpectedStatusUpdate(item, updated, 'blocked_forbidden_path');
  }
  const headCommit = (await deps.git.hasDirtyWorktree())
    ? await commitWorkBranchChanges(item)
    : await deps.git.currentCommit();

  await createDiffArtifacts(item, changedFiles, output.changed_files);

  const updated = updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      implementation_summary: output.implementation_summary,
      head_commit: headCommit,
      status: 'checking',
      ...(fixing ? { adoption_status: null, adoption_error: null } : {}),
    },
    fixing ? 'fix_completed' : 'implementation_completed',
    { changedFiles },
  );
  return completeExpectedStatusUpdate(
    item,
    updated,
    fixing ? 'fix_completed' : 'implementation_completed',
  );
}

async function handleChecking(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
  await checkoutWorkBranchIfNeeded(item);
  await assertOnWorkBranch(item);
  const changedFiles = await changedFilesSinceBase(item.base_commit);
  const docsOnly =
    changedFiles.length > 0 &&
    changedFiles.every((file) => /\.(md|mdx|txt)$/i.test(file));
  const result = docsOnly
    ? {
        ok: true,
        stdout: 'Documentation-only change; fixed checks skipped by policy.',
        stderr: '',
        command: 'skip-docs-only-check',
      }
    : await deps.checkRunner({ itemId: item.id, phase: 'check' });
  const summary = summarizeCommandResult(result);
  createEvolutionArtifact({
    itemId: item.id,
    artifactType: 'check_output',
    title: result.command,
    content: summary,
  });
  if (!result.ok) {
    const nextRound = item.review_round + 1;
    const status = nextRound > item.max_review_rounds ? 'failed' : 'fixing';
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        check_summary: summary,
        review_round: nextRound,
        status,
      },
      result.ok ? 'check_passed' : 'check_failed',
      { nextRound },
    );
    return completeExpectedStatusUpdate(item, updated, 'check_failed');
  }
  const updated = updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      check_summary: summary,
      status: 'reviewing',
    },
    'check_passed',
    { docsOnly },
  );
  return completeExpectedStatusUpdate(item, updated, 'check_passed');
}

async function handleReviewing(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
  await checkoutWorkBranchIfNeeded(item);
  await assertOnWorkBranch(item);
  const branchInfo = await getBranchAndCommit();
  const output = (await runEvolutionPhase({
    item,
    phase: 'review',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionReviewOutput;
  const reviewSummary = [
    output.implementation_coverage,
    output.bug_report ? `Bug: ${output.bug_report}` : '',
    output.required_fixes.length
      ? `Required fixes:\n${output.required_fixes.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!output.ok || !output.review_complete || output.required_fixes.length) {
    const nextRound = item.review_round + 1;
    const status = nextRound > item.max_review_rounds ? 'failed' : 'fixing';
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        review_summary: reviewSummary,
        bug_report: output.bug_report,
        risk_level: output.risk_level,
        review_round: nextRound,
        status,
      },
      'review_needs_fix',
      { nextRound, requiredFixes: output.required_fixes },
    );
    return completeExpectedStatusUpdate(item, updated, 'review_needs_fix');
  }

  if (output.risk_level === 'high' || output.risk_level === 'unknown') {
    const updated = updateEvolutionItemIfStatus(
      item.id,
      item.status,
      {
        review_summary: reviewSummary,
        risk_level: output.risk_level,
        status: 'blocked_by_policy',
        blocked_reason:
          output.risk_level === 'high' ? '复核结果为高风险' : '复核结果风险未知',
      },
      'blocked_by_policy',
      { reason: `${output.risk_level}_risk_review` },
    );
    return completeExpectedStatusUpdate(
      item,
      updated,
      output.risk_level === 'high'
        ? 'blocked_high_risk_review'
        : 'blocked_unknown_risk_review',
    );
  }

  const updated = updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      review_summary: reviewSummary,
      risk_level: output.risk_level,
      status: 'ready_for_adoption',
    },
    'review_passed',
    { riskLevel: output.risk_level },
  );
  return completeExpectedStatusUpdate(item, updated, 'ready_for_adoption');
}

async function advanceItem(
  item: AssistantEvolutionItemView,
  settings: AssistantSettings,
): Promise<EvolutionTickResult> {
  if (item.status === 'discovering' || item.status === 'proposal_drafting') {
    return handleProposalPhase(item, settings);
  }
  if (item.status === 'proposal_evaluating') {
    return handleEvaluationPhase(item, settings);
  }
  if (item.status === 'proposal_refining') {
    return handleProposalPhase(item, settings);
  }
  if (item.status === 'branch_preparing') {
    return handleBranchPreparing(item);
  }
  if (item.status === 'implementing') {
    return handleImplementation(item);
  }
  if (item.status === 'fixing') {
    return handleImplementation(item, true);
  }
  if (item.status === 'checking') {
    return handleChecking(item);
  }
  if (item.status === 'reviewing') {
    return handleReviewing(item);
  }
  if (
    item.status === 'ready_for_adoption' &&
    settings.evolution.autoAdoptEnabled &&
    item.risk_level === 'low'
  ) {
    const result = await adoptEvolutionItem(item.id);
    return {
      ok: result.ok,
      action: result.ok ? 'auto_adopted' : 'auto_adoption_failed',
      itemId: result.item.id,
      status: result.item.status,
    };
  }
  if (WAITING_EVOLUTION_STATUSES.includes(item.status)) {
    return {
      ok: true,
      action: 'waiting',
      itemId: item.id,
      status: item.status,
    };
  }
  return {
    ok: true,
    action: 'noop',
    itemId: item.id,
    status: item.status,
  };
}

async function advanceItemUntilStop(
  initialItem: AssistantEvolutionItemView,
  settings: AssistantSettings,
): Promise<EvolutionTickResult> {
  let item: AssistantEvolutionItemView | null = initialItem;
  let lastResult: EvolutionTickResult = {
    ok: true,
    action: 'noop',
    itemId: initialItem.id,
    status: initialItem.status,
  };
  let steps = 0;

  while (item && !isAutoAdvanceStopStatus(item.status)) {
    steps += 1;
    if (steps > MAX_AUTO_ADVANCE_STEPS) {
      const failed = transitionEvolutionItemIfStatus(
        item.id,
        item.status,
        'failed',
        { reason: 'auto advance step limit exceeded' },
      );
      return {
        ok: false,
        action: 'auto_advance_step_limit_exceeded',
        itemId: item.id,
        status: failed?.status || getEvolutionItem(item.id)?.status,
        error: 'Evolution auto advance step limit exceeded',
      };
    }
    lastResult = await advanceItem(item, settings);
    const latest = getEvolutionItem(item.id);
    if (!latest) {
      return {
        ok: true,
        action: 'interrupted',
        itemId: item.id,
        status: 'missing',
      };
    }
    item = latest;
  }

  if (item && item.status === 'ready_for_adoption') {
    lastResult = await advanceItem(item, settings);
    const latest = getEvolutionItem(item.id);
    if (latest) item = latest;
  }

  return {
    ...lastResult,
    itemId: item?.id || lastResult.itemId,
    status: item?.status || lastResult.status,
  };
}

export function configureEvolutionEngine(input: EvolutionEngineDeps): void {
  deps = {
    agentRunner:
      input.agentRunner === undefined ? deps.agentRunner : input.agentRunner,
    git: input.git || deps.git,
    checkRunner: input.checkRunner || deps.checkRunner,
    settingsProvider: input.settingsProvider || deps.settingsProvider,
    leaseMs: input.leaseMs || deps.leaseMs,
    baseBranch: input.baseBranch || deps.baseBranch,
  };
}

export async function runEvolutionTick(): Promise<EvolutionTickResult> {
  evolutionLastTickStartedAt = Date.now().toString();
  evolutionTickRunning = true;
  let tickResult: EvolutionTickResult | null = null;

  try {
    const settings = deps.settingsProvider();
    if (!settings.evolution.enabled) {
      tickResult = { ok: true, action: 'disabled' };
      return tickResult;
    }
    if (
      !tryAcquireEvolutionLease({
        lockOwner: ENGINE_LOCK_OWNER,
        leaseMs: deps.leaseMs,
      })
    ) {
      tickResult = { ok: true, action: 'lease_busy' };
      return tickResult;
    }

    const heartbeatMs = Math.max(
      50,
      Math.min(LEASE_RENEW_INTERVAL_MS, Math.floor(deps.leaseMs / 3)),
    );
    const leaseHeartbeat = setInterval(() => {
      const renewed = renewEvolutionLease({
        lockOwner: ENGINE_LOCK_OWNER,
        leaseMs: deps.leaseMs,
      });
      if (!renewed) {
        logger.warn('Assistant evolution lease heartbeat lost ownership');
      }
    }, heartbeatMs);

    try {
      const blockingItem = findBlockingEvolutionItem(settings);
      if (blockingItem) {
        tickResult = await advanceItemUntilStop(blockingItem, settings);
        return tickResult;
      }

      const item = createEvolutionItem({
        status: 'discovering',
        autoImplement: settings.evolution.autoImplementEnabled,
        autoAdopt: settings.evolution.autoAdoptEnabled,
        maxReviewRounds: settings.evolution.maxReviewRounds,
        baseBranch: deps.baseBranch,
      });
      tickResult = await advanceItemUntilStop(item, settings);
      tickResult = {
        ...tickResult,
        action:
          tickResult.action === 'noop'
            ? 'item_created'
            : `item_created_${tickResult.action}`,
        itemId: tickResult.itemId || item.id,
        status: tickResult.status || item.status,
      };
      return tickResult;
    } catch (err) {
      const active = findBlockingEvolutionItem(settings);
      let failedStatus = active?.status;
      if (active) {
        if (active.status === 'paused') {
          tickResult = {
            ok: true,
            action: 'interrupted',
            itemId: active.id,
            status: active.status,
          };
          return tickResult;
        }
        const failed = updateEvolutionItemIfStatus(
          active.id,
          active.status,
          {
            status: 'failed',
            blocked_reason: err instanceof Error ? err.message : String(err),
            completed_at: Date.now().toString(),
          },
          'engine_failed',
          { error: err instanceof Error ? err.message : String(err) },
        );
        failedStatus = failed?.status || getEvolutionItem(active.id)?.status;
      }
      logger.error({ err }, 'Assistant evolution tick failed');
      tickResult = {
        ok: false,
        action: 'error',
        itemId: active?.id,
        status: failedStatus,
        error: err instanceof Error ? err.message : String(err),
      };
      return tickResult;
    } finally {
      clearInterval(leaseHeartbeat);
      releaseEvolutionLease(ENGINE_LOCK_OWNER);
    }
  } finally {
    evolutionTickRunning = false;
    evolutionLastTickFinishedAt = Date.now().toString();
    evolutionLastTickAction = tickResult?.action || 'unknown';
    evolutionLastTickStatus = tickResult?.status || null;
    evolutionLastTickOk = tickResult?.ok ?? false;
    evolutionLastTickError =
      tickResult?.error || (tickResult ? null : 'Evolution tick ended abruptly');
  }
}

export function approveEvolutionImplementation(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (item.status !== 'waiting_user_approval') {
    throw new Error(`Cannot approve implementation from ${item.status}`);
  }
  const updated = updateEvolutionItemIfStatus(
    item.id,
    'waiting_user_approval',
    { status: 'branch_preparing', auto_implement: true },
    'implementation_approved',
  );
  if (!updated) {
    const latest = getEvolutionItem(item.id);
    throw new Error(
      `Cannot approve implementation from ${latest?.status || 'missing'}`,
    );
  }
  return {
    ok: true,
    item: updated,
  };
}

export function pauseEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (item.status === 'paused') {
    return { ok: true, item };
  }
  if (isTerminalStatus(item.status)) {
    throw new Error(`Cannot pause terminal item from ${item.status}`);
  }
  if (item.status === 'adopting') {
    throw new Error('Cannot pause while adoption is running');
  }
  const updated = updateEvolutionItemIfStatus(
    item.id,
    item.status,
    {
      status: 'paused',
      resume_status: PAUSABLE_RUNNING_STATUSES.includes(item.status as never)
        ? item.status
        : null,
    },
    'status_changed',
    { status: 'paused', resumeStatus: item.status },
  );
  if (!updated) {
    const latest = getEvolutionItem(item.id);
    throw new Error(`Cannot pause from ${latest?.status || 'missing'}`);
  }
  return {
    ok: true,
    item: updated,
  };
}

export function resumeEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (item.status === 'adoption_failed') {
    const updated = updateEvolutionItemIfStatus(
      item.id,
      'adoption_failed',
      {
        status: 'fixing',
        adoption_status: null,
        adoption_error: null,
        resume_status: null,
      },
      'adoption_repair_requested',
    );
    if (!updated) {
      const latest = getEvolutionItem(item.id);
      throw new Error(`Cannot resume from ${latest?.status || 'missing'}`);
    }
    return {
      ok: true,
      item: updated,
    };
  }
  if (item.status !== 'paused') {
    throw new Error(`Cannot resume from ${item.status}`);
  }
  const nextStatus = item.resume_status || 'proposal_evaluating';
  const updated = updateEvolutionItemIfStatus(
    item.id,
    'paused',
    { status: nextStatus, resume_status: null },
    'status_changed',
    { status: nextStatus },
  );
  if (!updated) {
    const latest = getEvolutionItem(item.id);
    throw new Error(`Cannot resume from ${latest?.status || 'missing'}`);
  }
  return {
    ok: true,
    item: updated,
  };
}

export function cancelEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (isTerminalStatus(item.status)) {
    throw new Error(`Cannot cancel terminal item from ${item.status}`);
  }
  if (!CANCELLABLE_STATUSES.includes(item.status as never)) {
    throw new Error(`Cannot cancel from ${item.status}`);
  }
  const cancelled = transitionEvolutionItemIfStatus(
    item.id,
    item.status,
    'cancelled',
    {
      previousStatus: item.status,
    },
  );
  if (!cancelled) {
    const latest = getEvolutionItem(item.id);
    throw new Error(`Cannot cancel from ${latest?.status || 'missing'}`);
  }
  return {
    ok: true,
    item: cancelled,
  };
}

export async function adoptEvolutionItem(itemId: string): Promise<{
  ok: boolean;
  item: AssistantEvolutionItemView;
}> {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (item.status !== 'ready_for_adoption') {
    throw new Error(`Cannot adopt from ${item.status}`);
  }
  if (!item.work_branch) {
    throw new Error('Evolution item has no work branch');
  }
  const adopting = updateEvolutionItemIfStatus(
    item.id,
    'ready_for_adoption',
    { status: 'adopting', adoption_status: 'running', adoption_error: null },
    'adoption_started',
  );
  if (!adopting) {
    const latest = getEvolutionItem(item.id);
    throw new Error(`Cannot adopt from ${latest?.status || 'missing'}`);
  }

  let mergePrepared = false;
  let mergeCommitted = false;
  try {
    if (await deps.git.hasDirtyWorktree()) {
      throw new Error('Worktree is dirty before adoption');
    }
    const checkout = await deps.git.checkout(item.base_branch);
    if (!checkout.ok) throw new Error(summarizeCommandResult(checkout));
    const merge = await deps.git.mergeNoFfNoCommit(item.work_branch);
    mergePrepared = true;
    if (!merge.ok) throw new Error(summarizeCommandResult(merge));
    const check = await deps.checkRunner({
      itemId: item.id,
      phase: 'adoption',
    });
    createEvolutionArtifact({
      itemId: item.id,
      artifactType: 'adoption_summary',
      title: check.command,
      content: summarizeCommandResult(check),
    });
    if (!check.ok) throw new Error(summarizeCommandResult(check));
    const commit = await deps.git.commit(
      `adopt assistant evolution: ${item.direction}`,
    );
    if (!commit.ok) throw new Error(summarizeCommandResult(commit));
    mergeCommitted = true;
    const mergeCommit = await deps.git.currentCommit();
    const adopted = updateEvolutionItemIfStatus(
      item.id,
      'adopting',
      {
        status: 'completed',
        adoption_status: 'completed',
        merge_commit: mergeCommit,
        completed_at: Date.now().toString(),
      },
      'adoption_completed',
      { mergeCommit },
    );
    return { ok: true, item: adopted || getEvolutionItem(item.id)! };
  } catch (err) {
    if (mergePrepared && !mergeCommitted) {
      const abort = await deps.git.mergeAbort();
      createEvolutionArtifact({
        itemId: item.id,
        artifactType: 'adoption_summary',
        title: abort.command,
        content: summarizeCommandResult(abort),
      });
    }
    const failed = updateEvolutionItemIfStatus(
      item.id,
      'adopting',
      {
        status: 'adoption_failed',
        adoption_status: 'failed',
        adoption_error: err instanceof Error ? err.message : String(err),
      },
      'adoption_failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return { ok: false, item: failed || getEvolutionItem(item.id)! };
  }
}

export function getEvolutionScheduleState(): EvolutionScheduleState {
  const settings = deps.settingsProvider();
  return {
    loopStarted: evolutionLoopStarted,
    tickRunning: evolutionTickRunning,
    intervalMinutes: settings.evolution.scanIntervalMinutes,
    lastTickStartedAt: evolutionLastTickStartedAt,
    lastTickFinishedAt: evolutionLastTickFinishedAt,
    lastTickAction: evolutionLastTickAction,
    lastTickStatus: evolutionLastTickStatus,
    lastTickOk: evolutionLastTickOk,
    lastTickError: evolutionLastTickError,
    nextTickAt:
      evolutionLoopStarted && settings.evolution.enabled
        ? evolutionNextTickAt
        : null,
  };
}

export function getEvolutionStateForApi() {
  const settings = deps.settingsProvider();
  const state = getEvolutionState();
  const blockingItem = findBlockingEvolutionItem(settings);
  return {
    ...state,
    activeItem: blockingItem
      ? getEvolutionItem(blockingItem.id, { includeDetails: true })
      : null,
    schedule: getEvolutionScheduleState(),
  };
}

export function startEvolutionEngine(): void {
  if (evolutionLoopStarted) {
    logger.debug('Assistant evolution engine already running');
    return;
  }
  evolutionLoopStarted = true;
  logger.info('Assistant evolution engine started');
  evolutionNextTickAt = String(Date.now() + 10_000);
  evolutionLoopTimer = setTimeout(runEvolutionLoop, 10_000);
}

export function rescheduleEvolutionEngine(): void {
  if (!evolutionLoopStarted) return;
  clearEvolutionLoopTimer();
  scheduleNextEvolutionTick();
}

/** @internal - for tests only. */
export function _resetEvolutionEngineForTests(): void {
  clearEvolutionLoopTimer();
  evolutionLoopStarted = false;
  evolutionTickRunning = false;
  evolutionLastTickStartedAt = null;
  evolutionLastTickFinishedAt = null;
  evolutionLastTickAction = null;
  evolutionLastTickStatus = null;
  evolutionLastTickOk = null;
  evolutionLastTickError = null;
  deps = {
    agentRunner: null,
    git: createDefaultEvolutionGitAdapter(),
    checkRunner: defaultEvolutionCheckRunner,
    settingsProvider: getAssistantSettings,
    leaseMs: DEFAULT_LEASE_MS,
    baseBranch: 'main',
  };
}
