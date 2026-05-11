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
  AssistantEvolutionRiskLevel,
  createEvolutionArtifact,
  createEvolutionItem,
  getActiveEvolutionItem,
  getEvolutionItem,
  getEvolutionState,
  releaseEvolutionLease,
  transitionEvolutionItem,
  tryAcquireEvolutionLease,
  updateEvolutionItem,
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

const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000;
const ENGINE_LOCK_OWNER = `assistant-evolution:${os.hostname()}:${process.pid}`;
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
  if (!evolutionLoopTimer) return;
  clearTimeout(evolutionLoopTimer);
  evolutionLoopTimer = null;
}

function scheduleNextEvolutionTick(): void {
  const settings = deps.settingsProvider();
  evolutionLoopTimer = setTimeout(
    runEvolutionLoop,
    evolutionDelayMs(settings),
  );
}

function runEvolutionLoop(): void {
  void runEvolutionTick().catch((err) => {
    logger.error({ err }, 'Assistant evolution tick failed');
  }).finally(() => {
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
): AssistantEvolutionItemView {
  if (output.blocked_by_policy || output.risk_level === 'high') {
    return updateEvolutionItem(
      item.id,
      {
        module_scope: output.module_scope,
        direction: output.direction,
        proposal: output.proposal,
        risk_level: output.risk_level,
        blocked_reason:
          output.blocked_reason || '方案触发高风险或策略阻断',
        status: 'blocked_by_policy',
      },
      'blocked_by_policy',
      { reason: output.blocked_reason || null },
    );
  }
  if (!output.ok) {
    return transitionEvolutionItem(item.id, 'failed', {
      reason: 'proposal output ok=false',
    });
  }
  return updateEvolutionItem(
    item.id,
    {
      module_scope: output.module_scope,
      direction: output.direction,
      proposal: output.proposal,
      risk_level: output.risk_level,
      auto_implement:
        settings.evolution.autoImplementEnabled &&
        isRiskAllowed(output.risk_level, settings.evolution.allowedRiskLevel),
      auto_adopt: settings.evolution.autoAdoptEnabled,
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
): AssistantEvolutionItemView {
  if (output.blocked_by_policy || output.risk_level === 'high') {
    return updateEvolutionItem(
      item.id,
      {
        proposal_evaluation: output.evaluation,
        risk_level: output.risk_level,
        blocked_reason:
          output.blocked_reason || '方案评估触发高风险或策略阻断',
        status: 'blocked_by_policy',
      },
      'blocked_by_policy',
      { reason: output.blocked_reason || null },
    );
  }

  if (!output.ok || !output.approved_for_implementation) {
    return updateEvolutionItem(
      item.id,
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
    settings.evolution.autoImplementEnabled &&
    isRiskAllowed(output.risk_level, settings.evolution.allowedRiskLevel);
  return updateEvolutionItem(
    item.id,
    {
      proposal_evaluation: output.evaluation,
      risk_level: output.risk_level,
      auto_implement: canAutoImplement,
      auto_adopt: settings.evolution.autoAdoptEnabled && output.risk_level === 'low',
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
      item.status === 'proposal_refining'
        ? 'proposal_refinement'
        : 'proposal',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionProposalOutput;
  const updated = updateFromProposal(item, output, settings);
  return {
    ok: true,
    action: 'proposal',
    itemId: updated.id,
    status: updated.status,
  };
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
  return {
    ok: true,
    action: 'proposal_evaluation',
    itemId: updated.id,
    status: updated.status,
  };
}

async function handleBranchPreparing(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
  if (await deps.git.hasDirtyWorktree()) {
    const updated = updateEvolutionItem(
      item.id,
      {
        status: 'blocked_by_policy',
        blocked_reason: '主仓库存在未提交改动，无法安全创建自我进化工作分支',
      },
      'blocked_by_policy',
      { reason: 'dirty_worktree' },
    );
    return {
      ok: true,
      action: 'blocked_dirty_worktree',
      itemId: updated.id,
      status: updated.status,
    };
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
  const updated = updateEvolutionItem(
    item.id,
    {
      base_branch: baseBranch,
      work_branch: workBranch,
      base_commit: baseCommit,
      status: 'implementing',
    },
    'branch_prepared',
    { baseBranch, workBranch, baseCommit },
  );
  return {
    ok: true,
    action: 'branch_prepared',
    itemId: updated.id,
    status: updated.status,
  };
}

async function handleImplementation(
  item: AssistantEvolutionItemView,
  fixing: boolean = false,
): Promise<EvolutionTickResult> {
  const branchInfo = await getBranchAndCommit();
  if (item.work_branch && branchInfo.branch !== item.work_branch) {
    throw new Error(
      `Current branch ${branchInfo.branch} does not match ${item.work_branch}`,
    );
  }
  const output = (await runEvolutionPhase({
    item,
    phase: fixing ? 'fixing' : 'implementation',
    agentRunner: assertAgentRunner(),
    currentBranch: branchInfo.branch,
    currentCommit: branchInfo.commit,
  })) as EvolutionImplementationOutput;
  if (!output.ok) {
    transitionEvolutionItem(item.id, 'failed', {
      reason: 'implementation output ok=false',
    });
    return {
      ok: true,
      action: 'implementation_failed',
      itemId: item.id,
      status: 'failed',
    };
  }
  const currentBranch = await deps.git.currentBranch();
  if (item.work_branch && currentBranch !== item.work_branch) {
    throw new Error(
      `Agent left expected work branch ${item.work_branch}; current ${currentBranch}`,
    );
  }
  const headCommit = await deps.git.currentCommit();
  const changedFiles = await deps.git.changedFiles(item.base_commit || undefined);
  const forbidden = hasForbiddenPath(changedFiles);
  if (forbidden) {
    const updated = updateEvolutionItem(
      item.id,
      {
        status: 'blocked_by_policy',
        blocked_reason: `实现修改了禁止路径：${forbidden}`,
        implementation_summary: output.implementation_summary,
        head_commit: headCommit,
      },
      'blocked_by_policy',
      { forbiddenPath: forbidden, changedFiles },
    );
    return {
      ok: true,
      action: 'blocked_forbidden_path',
      itemId: updated.id,
      status: updated.status,
    };
  }

  createEvolutionArtifact({
    itemId: item.id,
    artifactType: 'diff_summary',
    title: 'Changed files',
    content: changedFiles.join('\n'),
    payload: { changedFiles, runnerChangedFiles: output.changed_files },
  });

  const updated = updateEvolutionItem(
    item.id,
    {
      implementation_summary: output.implementation_summary,
      head_commit: headCommit,
      status: 'checking',
    },
    fixing ? 'fix_completed' : 'implementation_completed',
    { changedFiles },
  );
  return {
    ok: true,
    action: fixing ? 'fix_completed' : 'implementation_completed',
    itemId: updated.id,
    status: updated.status,
  };
}

async function handleChecking(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
  const changedFiles = await deps.git.changedFiles(item.base_commit || undefined);
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
    const status =
      nextRound > item.max_review_rounds ? 'failed' : 'fixing';
    const updated = updateEvolutionItem(
      item.id,
      {
        check_summary: summary,
        review_round: nextRound,
        status,
      },
      result.ok ? 'check_passed' : 'check_failed',
      { nextRound },
    );
    return {
      ok: true,
      action: result.ok ? 'check_passed' : 'check_failed',
      itemId: updated.id,
      status: updated.status,
    };
  }
  const updated = updateEvolutionItem(
    item.id,
    {
      check_summary: summary,
      status: 'reviewing',
    },
    'check_passed',
    { docsOnly },
  );
  return {
    ok: true,
    action: 'check_passed',
    itemId: updated.id,
    status: updated.status,
  };
}

async function handleReviewing(
  item: AssistantEvolutionItemView,
): Promise<EvolutionTickResult> {
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
    const status =
      nextRound > item.max_review_rounds ? 'failed' : 'fixing';
    const updated = updateEvolutionItem(
      item.id,
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
    return {
      ok: true,
      action: 'review_needs_fix',
      itemId: updated.id,
      status: updated.status,
    };
  }

  if (output.risk_level === 'high') {
    const updated = updateEvolutionItem(
      item.id,
      {
        review_summary: reviewSummary,
        risk_level: output.risk_level,
        status: 'blocked_by_policy',
        blocked_reason: '复核结果为高风险',
      },
      'blocked_by_policy',
      { reason: 'high_risk_review' },
    );
    return {
      ok: true,
      action: 'blocked_high_risk_review',
      itemId: updated.id,
      status: updated.status,
    };
  }

  const updated = updateEvolutionItem(
    item.id,
    {
      review_summary: reviewSummary,
      risk_level: output.risk_level,
      status: 'ready_for_adoption',
    },
    'review_passed',
    { riskLevel: output.risk_level },
  );
  return {
    ok: true,
    action: 'ready_for_adoption',
    itemId: updated.id,
    status: updated.status,
  };
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
    item.auto_adopt &&
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
  const settings = deps.settingsProvider();
  if (!settings.evolution.enabled) {
    return { ok: true, action: 'disabled' };
  }
  if (
    !tryAcquireEvolutionLease({
      lockOwner: ENGINE_LOCK_OWNER,
      leaseMs: deps.leaseMs,
    })
  ) {
    return { ok: true, action: 'lease_busy' };
  }

  try {
    let item = getActiveEvolutionItem();
    if (!item) {
      item = createEvolutionItem({
        status: 'discovering',
        autoImplement: settings.evolution.autoImplementEnabled,
        autoAdopt: settings.evolution.autoAdoptEnabled,
        maxReviewRounds: settings.evolution.maxReviewRounds,
        baseBranch: deps.baseBranch,
      });
      return {
        ok: true,
        action: 'item_created',
        itemId: item.id,
        status: item.status,
      };
    }
    return await advanceItem(item, settings);
  } catch (err) {
    const active = getActiveEvolutionItem();
    if (active) {
      updateEvolutionItem(
        active.id,
        {
          status: 'failed',
          blocked_reason: err instanceof Error ? err.message : String(err),
          completed_at: Date.now().toString(),
        },
        'engine_failed',
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    logger.error({ err }, 'Assistant evolution tick failed');
    return {
      ok: false,
      action: 'error',
      itemId: active?.id,
      status: active?.status,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    releaseEvolutionLease(ENGINE_LOCK_OWNER);
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
  return {
    ok: true,
    item: updateEvolutionItem(
      item.id,
      { status: 'branch_preparing', auto_implement: true },
      'implementation_approved',
    ),
  };
}

export function pauseEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  return {
    ok: true,
    item: transitionEvolutionItem(item.id, 'paused'),
  };
}

export function resumeEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  if (item.status !== 'paused') {
    throw new Error(`Cannot resume from ${item.status}`);
  }
  return {
    ok: true,
    item: transitionEvolutionItem(item.id, 'proposal_evaluating'),
  };
}

export function cancelEvolutionItem(itemId: string): {
  ok: boolean;
  item: AssistantEvolutionItemView;
} {
  const item = getEvolutionItem(itemId);
  if (!item) throw new Error('Evolution item not found');
  return {
    ok: true,
    item: transitionEvolutionItem(item.id, 'cancelled'),
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
  updateEvolutionItem(
    item.id,
    { status: 'adopting', adoption_status: 'running', adoption_error: null },
    'adoption_started',
  );

  try {
    if (await deps.git.hasDirtyWorktree()) {
      throw new Error('Worktree is dirty before adoption');
    }
    const checkout = await deps.git.checkout(item.base_branch);
    if (!checkout.ok) throw new Error(summarizeCommandResult(checkout));
    const merge = await deps.git.mergeNoFf(item.work_branch);
    if (!merge.ok) throw new Error(summarizeCommandResult(merge));
    const check = await deps.checkRunner({ itemId: item.id, phase: 'adoption' });
    createEvolutionArtifact({
      itemId: item.id,
      artifactType: 'adoption_summary',
      title: check.command,
      content: summarizeCommandResult(check),
    });
    if (!check.ok) throw new Error(summarizeCommandResult(check));
    const mergeCommit = await deps.git.currentCommit();
    const adopted = updateEvolutionItem(
      item.id,
      {
        status: 'completed',
        adoption_status: 'completed',
        merge_commit: mergeCommit,
        completed_at: Date.now().toString(),
      },
      'adoption_completed',
      { mergeCommit },
    );
    return { ok: true, item: adopted };
  } catch (err) {
    const failed = updateEvolutionItem(
      item.id,
      {
        status: 'adoption_failed',
        adoption_status: 'failed',
        adoption_error: err instanceof Error ? err.message : String(err),
      },
      'adoption_failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return { ok: false, item: failed };
  }
}

export function getEvolutionStateForApi() {
  return getEvolutionState();
}

export function startEvolutionEngine(): void {
  if (evolutionLoopStarted) {
    logger.debug('Assistant evolution engine already running');
    return;
  }
  evolutionLoopStarted = true;
  logger.info('Assistant evolution engine started');
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
  deps = {
    agentRunner: null,
    git: createDefaultEvolutionGitAdapter(),
    checkRunner: defaultEvolutionCheckRunner,
    settingsProvider: getAssistantSettings,
    leaseMs: DEFAULT_LEASE_MS,
    baseBranch: 'main',
  };
}
