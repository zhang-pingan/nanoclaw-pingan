import crypto from 'node:crypto';

import { z } from 'zod';

import {
  COLLABORATION_PROJECT_ANALYST_CAPABILITY_VERSION,
  COLLABORATION_PROJECT_ANALYST_CONTRACT_VERSION,
  buildProjectAnalystCapabilityFiles,
  buildProjectAnalystPrompt,
  buildProjectAnalystResultTemplate,
  projectAnalystRepairPrompt,
} from './analysis-capability.js';
import {
  COLLABORATION_ANALYSIS_ALLOWED_ACTION_TYPES,
  collaborationAnalysisInputSchema,
  collaborationAnalysisResultSchema,
  collaborationAnalysisScopeSchema,
  collaborationFindingDecisionSchema,
  collaborationProposedActionSchema,
  type CollaborationAnalysisFinding,
  type CollaborationAnalysisResult,
  type CollaborationAnalysisScope,
  type CollaborationProposedAction,
} from './analysis-contracts.js';
import {
  buildCollaborationAnalysisDeltaSelection,
  buildCollaborationAnalysisResourceCatalog,
  scopeCollaborationAnalysisResourceCatalog,
  type CollaborationAnalysisResourceCatalog,
} from './analysis-context.js';
import type {
  ManagedAnalysisExecutor,
  ManagedAnalysisExecutorRegistry,
  ManagedAnalysisObservation,
} from './analysis-executor.js';
import {
  buildCollaborationProjectInsight,
  buildMyItems,
} from './project-insight.js';
import type { CollaborationProjectSpaceService } from './project-space-service.js';
import type {
  CollaborationAnalysisActionApplicationRecord,
  CollaborationAnalysisFindingRecord,
  CollaborationAnalysisRunRecord,
  CollaborationAnalysisValidationError,
  CollaborationProjectSpaceGroupRecord,
  CollaborationProjectSpaceStore,
} from './project-space-store.js';
import {
  canonicalJsonStringify,
  strictParseJson,
} from './protocol/canonical-json.js';
import {
  collaborationCanonicalHashV4,
  type CollaborationProjectionV4,
} from './protocol/v4-reducer.js';

const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_EXTERNAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXTERNAL_PACKAGE_BYTES = 64 * 1024 * 1024;
const MANAGED_POLL_INTERVAL_MS = 100;
const MANAGED_MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;

const severityRank = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
} as const;

const rootBindingFields = [
  'analysis_id',
  'snapshot_head',
  'context_hash',
  'prompt_hash',
  'challenge',
] as const;

const injectionPattern =
  /(?:ignore|disregard|override).{0,40}(?:previous|system|developer|host).{0,30}(?:instruction|message|policy)|(?:reveal|print|return).{0,30}(?:system prompt|developer message|credential)|(?:execute|run).{0,20}(?:shell|command|script)|忽略.{0,30}(?:之前|系统|开发者|主机).{0,20}(?:指令|消息|策略)|(?:泄露|打印|返回).{0,20}(?:系统提示|开发者消息|凭据)|执行.{0,20}(?:命令|脚本)/iu;
const credentialPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b|(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*[^\s,;]{8,})/iu;
const absolutePathPattern =
  /(?:^|[\s"'(])(?:\/(?!\/)[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/mu;

export class CollaborationAnalysisServiceError extends Error {
  constructor(
    readonly code:
      | 'analysis_not_found'
      | 'analysis_group_mismatch'
      | 'analysis_state_conflict'
      | 'analysis_snapshot_stale'
      | 'analysis_result_invalid'
      | 'analysis_permission_denied'
      | 'analysis_confirmation_invalid'
      | 'analysis_action_conflict'
      | 'analysis_delta_base_invalid'
      | 'analysis_tool_denied',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationAnalysisServiceError';
  }
}

export interface CollaborationAnalysisRunDetail {
  readonly run: CollaborationAnalysisRunRecord;
  readonly stale: boolean;
  readonly result: ReturnType<
    CollaborationProjectSpaceStore['getLatestAnalysisResult']
  >;
  readonly results: ReturnType<
    CollaborationProjectSpaceStore['listAnalysisResults']
  >;
  readonly findings: readonly CollaborationAnalysisFindingRecord[];
  readonly applications: readonly CollaborationAnalysisActionApplicationRecord[];
  readonly exportScope: Record<string, unknown>;
  readonly allowedActionTypes: readonly CollaborationProposedAction['action'][];
  readonly repairPrompt: string | null;
}

export interface CollaborationExternalAnalysisPackage {
  readonly format: 'icarus.collaboration-analysis-package/1';
  readonly manifest: {
    readonly analysis_id: string;
    readonly group_id: string;
    readonly snapshot_head: string;
    readonly context_hash: string;
    readonly prompt_hash: string;
    readonly challenge: string;
    readonly contract_version: 1;
    readonly capability_version: 1;
  };
  readonly transfer_notice: string;
  readonly files: readonly {
    readonly path: string;
    readonly media_type: string;
    readonly encoding: 'utf8' | 'base64';
    readonly content: string;
    readonly bytes: number;
    readonly redacted: boolean;
  }[];
  readonly total_bytes: number;
}

export interface CollaborationAnalysisActionPreviewInput {
  readonly requestId: string;
  readonly findingId: string;
  readonly actionOrdinal?: number;
  readonly action: CollaborationProposedAction;
}

export interface CollaborationAnalysisActionApplyInput {
  readonly applicationId: string;
  readonly confirmationToken: string;
  readonly action?: CollaborationProposedAction;
}

type ResourceCatalog = CollaborationAnalysisResourceCatalog;

function sha256Text(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function sha256Buffer(value: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function validationError(
  code: string,
  path: string,
  message: string,
  findingId?: string,
): CollaborationAnalysisValidationError {
  return {
    code,
    path,
    message,
    ...(findingId ? { findingId } : {}),
  };
}

function zodErrors(error: z.ZodError): CollaborationAnalysisValidationError[] {
  return error.issues.map((issue) =>
    validationError(
      'schema_invalid',
      `/${issue.path.join('/')}`,
      issue.message,
    ),
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/\s+/gu, ' ');
}

function findingDedupeKey(finding: CollaborationAnalysisFinding): string {
  return sha256Text(
    canonicalJsonStringify({
      category: finding.category,
      affected_refs: [...finding.affected_refs].sort(),
      evidence_refs: [...finding.evidence_refs].sort().slice(0, 20),
      title: normalizeTitle(finding.title),
    }),
  );
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(allStrings);
}

function redactExternalText(value: string): {
  text: string;
  redacted: boolean;
} {
  let redacted = false;
  let text = value.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    () => {
      redacted = true;
      return '[private-key-redacted]';
    },
  );
  text = text.replace(
    /\bsk-[A-Za-z0-9_-]{16,}\b|\bAKIA[A-Z0-9]{16}\b/gu,
    () => {
      redacted = true;
      return '[credential-redacted]';
    },
  );
  text = text.replace(
    /((?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*)[^\s,;"']{8,}/giu,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[credential-redacted]`;
    },
  );
  text = text.replace(
    /(^|[\s"'(])(?:\/(?!\/)[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/gmu,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}[local-path-redacted]`;
    },
  );
  return { text, redacted };
}

function redactAnalysisValue(value: unknown): unknown {
  if (typeof value === 'string') return redactExternalText(value).text;
  if (Array.isArray(value)) return value.map(redactAnalysisValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactAnalysisValue(entry),
    ]),
  );
}

function findingLifecycle(
  finding: CollaborationAnalysisFinding,
  prior: CollaborationAnalysisFindingRecord | null,
): CollaborationAnalysisFindingRecord['lifecycle'] {
  if (!prior) return 'new';
  if (prior.lifecycle === 'dismissed') return 'dismissed';
  const previous = severityRank[prior.finding.severity];
  const current = severityRank[finding.severity];
  return current > previous
    ? 'worsened'
    : current < previous
      ? 'improved'
      : 'ongoing';
}

function currentHead(group: CollaborationProjectSpaceGroupRecord): string {
  if (!group.projection || !group.lastVerifiedHead)
    throw new Error('Collaboration Group has no verified snapshot');
  return group.lastVerifiedHead;
}

function findingActionErrors(input: {
  readonly finding: CollaborationAnalysisFinding;
  readonly resourceRefs: ReadonlySet<string>;
  readonly resultFindingIds: ReadonlySet<string>;
}): CollaborationAnalysisValidationError[] {
  const errors: CollaborationAnalysisValidationError[] = [];
  const findingId = input.finding.finding_id;
  const requireRef = (ref: string, path: string): void => {
    if (!input.resourceRefs.has(ref))
      errors.push(
        validationError(
          'action_ref_not_visible',
          path,
          `Proposed Action references a resource outside the frozen scope: ${ref}`,
          findingId,
        ),
      );
  };
  for (const [ordinal, action] of input.finding.proposed_actions.entries()) {
    const path = `/findings/${findingId}/proposed_actions/${String(ordinal)}`;
    switch (action.action) {
      case 'create_work_item':
        for (const id of action.parameters.related_work_item_ids)
          requireRef(
            `work_item:${id}`,
            `${path}/parameters/related_work_item_ids`,
          );
        break;
      case 'open_discussion':
        if (action.parameters.scope.type !== 'group')
          requireRef(
            `${action.parameters.scope.type}:${action.parameters.scope.ref}`,
            `${path}/parameters/scope/ref`,
          );
        for (const id of action.parameters.mentions)
          requireRef(`principal:${id}`, `${path}/parameters/mentions`);
        break;
      case 'post_progress':
        for (const id of action.parameters.work_item_refs)
          requireRef(`work_item:${id}`, `${path}/parameters/work_item_refs`);
        for (const id of action.parameters.workflow_instance_refs)
          requireRef(
            `workflow_instance:${id}`,
            `${path}/parameters/workflow_instance_refs`,
          );
        break;
      case 'watch_work_item':
        requireRef(
          `work_item:${action.parameters.work_item_id}`,
          `${path}/parameters/work_item_id`,
        );
        break;
      case 'request_information':
        for (const ref of action.parameters.affected_refs)
          requireRef(ref, `${path}/parameters/affected_refs`);
        for (const id of action.parameters.mentions)
          requireRef(`principal:${id}`, `${path}/parameters/mentions`);
        break;
      case 'publish_analysis_report':
        for (const id of action.parameters.include_finding_ids)
          if (!input.resultFindingIds.has(id))
            errors.push(
              validationError(
                'action_finding_unknown',
                `${path}/parameters/include_finding_ids`,
                `Analysis report references an unknown Finding: ${id}`,
                findingId,
              ),
            );
        break;
    }
  }
  return errors;
}

export class CollaborationAnalysisService {
  private readonly monitorTimers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => number;

  constructor(
    private readonly store: CollaborationProjectSpaceStore,
    private readonly groups: CollaborationProjectSpaceService,
    private readonly executors: ManagedAnalysisExecutorRegistry,
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    for (const group of this.store.listGroups())
      for (const run of this.store.listAnalysisRuns(group.groupId))
        if (run.status === 'running')
          this.failRunningRun(
            run.analysisId,
            new Error(
              'Managed execution ownership was lost during Host restart; manual retry is required',
            ),
          );
  }

  stop(): void {
    for (const timer of this.monitorTimers.values()) clearTimeout(timer);
    this.monitorTimers.clear();
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    for (const group of this.store.listGroups())
      for (const run of this.store.listAnalysisRuns(group.groupId))
        if (run.status === 'running')
          this.failRunningRun(
            run.analysisId,
            new Error(
              'Host stopped while managed execution was active; manual retry is required',
            ),
          );
  }

  listExecutors() {
    return this.executors.list();
  }

  listManagedExecutors() {
    return this.listExecutors();
  }

  projectInsight(groupId: string, markViewed = true) {
    const group = this.requireGroup(groupId);
    const snapshotHead = currentHead(group);
    const viewerKey = group.localPrincipalId
      ? `${group.localPrincipalId}:${group.localClientId ?? 'local'}`
      : 'observer';
    const view = this.store.getProjectView(groupId, viewerKey);
    const insight = buildCollaborationProjectInsight({
      group,
      projection: group.projection!,
      snapshotHead,
      nowMs: this.now(),
      lastViewedActivityEventId: view?.lastActivityEventId,
    });
    if (markViewed)
      this.store.markProjectViewed({
        groupId,
        viewerKey,
        lastActivityEventId:
          group.projection!.activity.at(-1)?.eventId ??
          view?.lastActivityEventId ??
          null,
        nowMs: this.now(),
      });
    return { insight };
  }

  myItems(groupId: string) {
    const group = this.requireGroup(groupId);
    currentHead(group);
    return {
      items: buildMyItems({
        group,
        projection: group.projection!,
        nowMs: this.now(),
      }),
    };
  }

  scopeOptions(groupId: string) {
    const group = this.requireGroup(groupId);
    const snapshotHead = currentHead(group);
    const records = this.store.listEventRecords(groupId);
    return {
      currentSnapshotHead: snapshotHead,
      deltaBaseSnapshots: records
        .filter((record) => record.commitHash !== snapshotHead)
        .sort((left, right) => right.commitOrder - left.commitOrder)
        .slice(0, 500)
        .map((record) => ({
          snapshotHead: record.commitHash,
          throughEventId: record.event.event_id,
          occurredAt: record.event.occurred_at,
          commitOrder: record.commitOrder,
        })),
    };
  }

  async createRun(input: {
    readonly groupId: string;
    readonly scope: CollaborationAnalysisScope;
    readonly executionChannel: 'managed_executor' | 'external_agent';
    readonly executorId?: string | null;
    readonly selectedFileIds?: readonly string[];
    readonly includeSelectedFileContents?: boolean;
  }): Promise<CollaborationAnalysisRunDetail>;
  async createRun(
    groupId: string,
    input: {
      readonly scope: CollaborationAnalysisScope;
      readonly executionChannel: 'managed_executor' | 'external_agent';
      readonly executorId?: string | null;
      readonly selectedFileIds?: readonly string[];
      readonly includeSelectedFileContents?: boolean;
    },
  ): Promise<CollaborationAnalysisRunDetail>;
  async createRun(
    groupIdOrInput:
      | string
      | {
          readonly groupId: string;
          readonly scope: CollaborationAnalysisScope;
          readonly executionChannel: 'managed_executor' | 'external_agent';
          readonly executorId?: string | null;
          readonly selectedFileIds?: readonly string[];
          readonly includeSelectedFileContents?: boolean;
        },
    maybeInput?: {
      readonly scope: CollaborationAnalysisScope;
      readonly executionChannel: 'managed_executor' | 'external_agent';
      readonly executorId?: string | null;
      readonly selectedFileIds?: readonly string[];
      readonly includeSelectedFileContents?: boolean;
    },
  ): Promise<CollaborationAnalysisRunDetail> {
    const input =
      typeof groupIdOrInput === 'string'
        ? { ...maybeInput!, groupId: groupIdOrInput }
        : groupIdOrInput;
    const scope = collaborationAnalysisScopeSchema.parse(input.scope);
    const history = await this.groups.sync(input.groupId);
    const group = this.requireGroup(input.groupId);
    const snapshotHead = currentHead(group);
    if (
      group.protocolStatus !== 'OK' ||
      history.projection.integrityStatus !== 'OK'
    )
      throw new Error(
        'Analysis Run requires a currently verified healthy snapshot',
      );
    if (history.head !== snapshotHead)
      throw new Error('Verified snapshot changed while preparing Analysis Run');
    const analysisId = `analysis_${crypto.randomUUID()}`;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const insight = buildCollaborationProjectInsight({
      group,
      projection: history.projection,
      snapshotHead,
      nowMs: this.now(),
    });
    const myItems = buildMyItems({
      group,
      projection: history.projection,
      nowMs: this.now(),
    });
    const fullCatalog = redactAnalysisValue(
      buildCollaborationAnalysisResourceCatalog(history.projection),
    ) as ResourceCatalog;
    const delta =
      scope.type === 'delta'
        ? buildCollaborationAnalysisDeltaSelection({
            scope,
            history,
            fullCatalog,
          })
        : null;
    if (scope.type === 'delta' && !delta)
      throw new CollaborationAnalysisServiceError(
        'analysis_delta_base_invalid',
        'Delta Analysis requires since_snapshot_head to be a verified commit in the current linear history',
      );
    const catalog =
      delta?.catalog ??
      scopeCollaborationAnalysisResourceCatalog({
        catalog: fullCatalog,
        scope,
        projection: history.projection,
        currentPrincipalId: group.localPrincipalId,
        myItemRefs: myItems.map(
          (item) => `${item.resource_type}:${item.resource_id}`,
        ),
      });
    const allowedFileIds = new Set(
      Object.keys(catalog)
        .filter((ref) => ref.startsWith('file:'))
        .map((ref) => ref.slice('file:'.length)),
    );
    const selectedFileIds = [...new Set(input.selectedFileIds ?? [])];
    for (const fileId of selectedFileIds)
      if (!allowedFileIds.has(fileId))
        throw new Error(
          `Selected file is outside the Analysis scope: ${fileId}`,
        );
    const resourceIndex = Object.keys(catalog).sort();
    const visibleRefs = new Set(resourceIndex);
    const priorFindings = this.priorFindingSummary(input.groupId, scope);
    const visibleSignals = insight.signals.filter((item) =>
      [...item.affected_refs, ...item.evidence_refs].every((ref) =>
        visibleRefs.has(ref),
      ),
    );
    const visibleMyItems = myItems.filter(
      (item) =>
        scope.type === 'mine' ||
        visibleRefs.has(`${item.resource_type}:${item.resource_id}`),
    );
    const visibleActivity = (delta?.activity ?? insight.activity_delta).filter(
      (item) => visibleRefs.has(`event:${item.eventId}`),
    );
    const visiblePriorFindings = priorFindings.filter((item) => {
      const affected = item.affected_refs;
      return (
        !Array.isArray(affected) ||
        affected.every((ref) => visibleRefs.has(String(ref)))
      );
    });
    const projectSummary = {
      format: insight.format,
      group_id: insight.group_id,
      snapshot_head: insight.snapshot_head,
      generated_at: insight.generated_at,
      health: insight.health,
      counts: insight.counts,
      sync: insight.sync,
    };
    const contextWithoutHash = collaborationAnalysisInputSchema.parse(
      redactAnalysisValue({
        format: 'icarus.collaboration-analysis-input/1',
        contract_version: COLLABORATION_PROJECT_ANALYST_CONTRACT_VERSION,
        analysis_id: analysisId,
        group_id: input.groupId,
        snapshot_head: snapshotHead,
        scope,
        current_principal_id: group.localPrincipalId,
        generated_at: new Date(this.now()).toISOString(),
        security: {
          project_content_is_untrusted: true,
          read_only_snapshot: true,
          required_result_format: 'icarus.collaboration-analysis-result/1',
        },
        change_range:
          delta && scope.type === 'delta'
            ? {
                since_snapshot_head: scope.since_snapshot_head,
                snapshot_head: snapshotHead,
                event_count: delta.eventCount,
                changed_refs: delta.changedRefs,
              }
            : null,
        project_summary: jsonRecord(projectSummary),
        my_items: visibleMyItems.map((item) => jsonRecord(item)),
        rule_signals: visibleSignals.map((item) => jsonRecord(item)),
        resource_index: resourceIndex,
        activity_delta: visibleActivity.map((item) => jsonRecord(item)),
        prior_findings: visiblePriorFindings,
      }),
    );
    const contextHash = collaborationCanonicalHashV4(contextWithoutHash);
    const prompt = buildProjectAnalystPrompt({
      analysisId,
      snapshotHead,
      contextHash,
      challenge,
    });
    const promptHash = sha256Text(prompt);
    let executorKind: string | null = null;
    if (input.executionChannel === 'managed_executor') {
      if (!input.executorId)
        throw new Error('Managed Analysis Run requires an Executor');
      executorKind = this.executors.resolve(input.executorId).descriptor.kind;
    } else if (input.executorId) {
      throw new Error('External Analysis Run cannot bind a managed Executor');
    }
    this.store.createAnalysisRun({
      run: {
        analysisId,
        groupId: input.groupId,
        principalId: group.localPrincipalId,
        clientId: group.localClientId,
        subscriptionMode: group.subscriptionMode,
        snapshotHead,
        scope,
        trigger: 'manual',
        executionChannel: input.executionChannel,
        executorId: input.executorId ?? null,
        executorKind,
        contractVersion: COLLABORATION_PROJECT_ANALYST_CONTRACT_VERSION,
        capabilityVersion: COLLABORATION_PROJECT_ANALYST_CAPABILITY_VERSION,
        contextHash,
        promptHash,
        challenge,
      },
      context: {
        analysisId,
        context: contextWithoutHash,
        resourceCatalog: catalog,
        resourceIndex,
        exportScope: {
          scope,
          file_count: selectedFileIds.length,
          resource_count: resourceIndex.length,
          include_selected_file_contents:
            input.includeSelectedFileContents === true,
        },
        selectedFileIds,
        promptMarkdown: prompt,
        contextHash,
        promptHash,
      },
      nowMs: this.now(),
    });
    this.store.addLocalAuditEvidence({
      groupId: input.groupId,
      evidenceType: 'analysis_run_created',
      resourceType: 'analysis_run',
      resourceId: analysisId,
      evidence: {
        analysis_id: analysisId,
        snapshot_head: snapshotHead,
        execution_channel: input.executionChannel,
        context_hash: contextHash,
        prompt_hash: promptHash,
      },
      observedAtMs: this.now(),
    });
    return this.getRun(input.groupId, analysisId);
  }

  listRuns(groupId: string): CollaborationAnalysisRunDetail[] {
    const group = this.requireGroup(groupId);
    return this.store
      .listAnalysisRuns(groupId)
      .map((run) => this.buildDetail(group, run));
  }

  list(groupId: string): CollaborationAnalysisRunDetail[] {
    return this.listRuns(groupId);
  }

  getRun(groupId: string, analysisId: string): CollaborationAnalysisRunDetail {
    const group = this.requireGroup(groupId);
    return this.buildDetail(group, this.requireRun(groupId, analysisId));
  }

  detail(groupId: string, analysisId: string): CollaborationAnalysisRunDetail {
    return this.getRun(groupId, analysisId);
  }

  async startRun(
    groupId: string,
    analysisId: string,
  ): Promise<CollaborationAnalysisRunDetail> {
    const run = this.requireFreshRun(groupId, analysisId);
    if (run.executionChannel === 'external_agent') {
      if (run.status === 'awaiting_external_result')
        return this.getRun(groupId, analysisId);
      if (!['prepared', 'invalid'].includes(run.status))
        throw this.stateConflict(run, 'start external handoff');
      this.store.transitionAnalysisRun({
        analysisId,
        expectedStatus: run.status as 'prepared' | 'invalid',
        nextStatus: 'awaiting_external_result',
        error: null,
        validationErrors: [],
        nowMs: this.now(),
      });
      return this.getRun(groupId, analysisId);
    }
    if (run.status === 'running') return this.getRun(groupId, analysisId);
    if (!['prepared', 'invalid', 'failed'].includes(run.status))
      throw this.stateConflict(run, 'start managed execution');
    await this.dispatchManaged(run);
    return this.getRun(groupId, analysisId);
  }

  startManaged(groupId: string, analysisId: string) {
    return this.startRun(groupId, analysisId);
  }

  async cancelRun(
    groupId: string,
    analysisId: string,
  ): Promise<CollaborationAnalysisRunDetail> {
    const run = this.requireRun(groupId, analysisId);
    if (['cancelled', 'completed'].includes(run.status))
      return this.getRun(groupId, analysisId);
    if (run.status === 'running') {
      if (!run.executionRef || !run.executorId)
        throw new CollaborationAnalysisServiceError(
          'analysis_state_conflict',
          'Managed execution has no observable receipt and cannot be cancelled safely',
        );
      const cancelled = await this.executors
        .resolve(run.executorId)
        .cancel(run.executionRef, 'user requested cancellation');
      if (!cancelled.cancelled)
        throw new CollaborationAnalysisServiceError(
          'analysis_state_conflict',
          'The selected managed Executor is not cancellable; the Analysis Run remains running',
        );
    }
    if (['ready_for_review', 'partially_applied'].includes(run.status)) {
      this.store.transitionAnalysisRun({
        analysisId,
        expectedStatus: run.status as 'ready_for_review' | 'partially_applied',
        nextStatus: 'completed',
        nowMs: this.now(),
      });
      return this.getRun(groupId, analysisId);
    }
    if (!['prepared', 'awaiting_external_result'].includes(run.status))
      throw this.stateConflict(run, 'cancel');
    this.store.transitionAnalysisRun({
      analysisId,
      expectedStatus: run.status as 'prepared' | 'awaiting_external_result',
      nextStatus: 'cancelled',
      nowMs: this.now(),
    });
    return this.getRun(groupId, analysisId);
  }

  cancel(groupId: string, analysisId: string) {
    return this.cancelRun(groupId, analysisId);
  }

  retryRun(groupId: string, analysisId: string) {
    return this.startRun(groupId, analysisId);
  }

  retry(groupId: string, analysisId: string) {
    return this.retryRun(groupId, analysisId);
  }

  completeReview(
    groupId: string,
    analysisId: string,
  ): CollaborationAnalysisRunDetail {
    const run = this.requireRun(groupId, analysisId);
    if (run.status === 'completed') return this.getRun(groupId, analysisId);
    if (!['ready_for_review', 'partially_applied'].includes(run.status))
      throw this.stateConflict(run, 'complete review');
    this.store.transitionAnalysisRun({
      analysisId,
      expectedStatus: run.status as 'ready_for_review' | 'partially_applied',
      nextStatus: 'completed',
      nowMs: this.now(),
    });
    return this.getRun(groupId, analysisId);
  }

  async externalPackage(
    groupId: string,
    analysisId: string,
  ): Promise<CollaborationExternalAnalysisPackage> {
    const run = this.requireFreshRun(groupId, analysisId);
    if (
      run.executionChannel !== 'external_agent' ||
      run.status !== 'awaiting_external_result'
    )
      throw this.stateConflict(run, 'export external package');
    const context = this.requireContext(analysisId);
    const schemas = buildProjectAnalystCapabilityFiles({
      resourceCatalog: context.resourceCatalog,
    });
    const manifest = {
      analysis_id: run.analysisId,
      group_id: run.groupId,
      snapshot_head: run.snapshotHead,
      context_hash: run.contextHash,
      prompt_hash: run.promptHash,
      challenge: run.challenge,
      contract_version: run.contractVersion,
      capability_version: run.capabilityVersion,
    } as const;
    const files: Array<CollaborationExternalAnalysisPackage['files'][number]> =
      [];
    const addText = (
      path: string,
      mediaType: string,
      content: string,
    ): void => {
      const redacted = redactExternalText(content);
      files.push({
        path,
        media_type: mediaType,
        encoding: 'utf8',
        content: redacted.text,
        bytes: Buffer.byteLength(redacted.text),
        redacted: redacted.redacted,
      });
    };
    addText('PROMPT.md', 'text/markdown', context.promptMarkdown);
    addText(
      'context.json',
      'application/json',
      `${JSON.stringify(context.context, null, 2)}\n`,
    );
    addText(
      'manifest.json',
      'application/json',
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    for (const file of schemas)
      if (
        file.path.startsWith('references/') ||
        file.path === 'SKILL.md' ||
        file.path === 'contracts/analysis-result.schema.json' ||
        file.path === 'resources/catalog.json'
      )
        addText(
          file.path === 'contracts/analysis-result.schema.json'
            ? 'result.schema.json'
            : file.path,
          file.path.endsWith('.json') ? 'application/json' : 'text/markdown',
          Buffer.isBuffer(file.contents)
            ? file.contents.toString('utf8')
            : file.contents,
        );
    addText(
      'result-template.json',
      'application/json',
      `${JSON.stringify(
        buildProjectAnalystResultTemplate({
          context: context.context,
          contextHash: context.contextHash,
          promptHash: context.promptHash,
          challenge: run.challenge,
        }),
        null,
        2,
      )}\n`,
    );
    if (context.exportScope.include_selected_file_contents === true)
      await this.appendExternalFiles(
        run,
        context.resourceCatalog,
        context.selectedFileIds,
        files,
      );
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    if (totalBytes > MAX_EXTERNAL_PACKAGE_BYTES)
      throw new Error('External Analysis package exceeds the 64 MiB limit');
    return {
      format: 'icarus.collaboration-analysis-package/1',
      manifest,
      transfer_notice:
        'This package leaves Icarus only when you export it. Review the file list and redaction flags before sharing it with a third-party Agent.',
      files,
      total_bytes: totalBytes,
    };
  }

  externalPrompt(groupId: string, analysisId: string): string {
    const run = this.requireFreshRun(groupId, analysisId);
    if (
      run.executionChannel !== 'external_agent' ||
      run.status !== 'awaiting_external_result'
    )
      throw this.stateConflict(run, 'copy external Prompt');
    const context = this.requireContext(analysisId);
    const capability = buildProjectAnalystCapabilityFiles({
      resourceCatalog: context.resourceCatalog,
    });
    const resultSchema = capability.find(
      (file) => file.path === 'contracts/analysis-result.schema.json',
    )?.contents;
    const template = buildProjectAnalystResultTemplate({
      context: context.context,
      contextHash: context.contextHash,
      promptHash: context.promptHash,
      challenge: run.challenge,
    });
    const rendered = `${context.promptMarkdown}\n\n## Frozen Context\n\n\`\`\`json\n${JSON.stringify(
      context.context,
      null,
      2,
    )}\n\`\`\`\n\n## Frozen Resources\n\n\`\`\`json\n${JSON.stringify(
      context.resourceCatalog,
      null,
      2,
    )}\n\`\`\`\n\n## Result Template\n\nPreserve every Host-owned field exactly.\n\n\`\`\`json\n${JSON.stringify(
      template,
      null,
      2,
    )}\n\`\`\`\n\n## Result JSON Schema\n\n\`\`\`json\n${
      Buffer.isBuffer(resultSchema)
        ? resultSchema.toString('utf8')
        : (resultSchema ?? '{}')
    }\n\`\`\`\n`;
    return redactExternalText(rendered).text;
  }

  submitExternalResult(input: {
    readonly groupId: string;
    readonly analysisId: string;
    readonly rawJson: string;
  }): CollaborationAnalysisRunDetail;
  submitExternalResult(
    groupId: string,
    analysisId: string,
    rawJson: string,
  ): CollaborationAnalysisRunDetail;
  submitExternalResult(
    groupIdOrInput:
      | string
      | {
          readonly groupId: string;
          readonly analysisId: string;
          readonly rawJson: string;
        },
    maybeAnalysisId?: string,
    maybeRawJson?: string,
  ): CollaborationAnalysisRunDetail {
    const input =
      typeof groupIdOrInput === 'string'
        ? {
            groupId: groupIdOrInput,
            analysisId: maybeAnalysisId!,
            rawJson: maybeRawJson!,
          }
        : groupIdOrInput;
    let run = this.requireRun(input.groupId, input.analysisId);
    if (run.executionChannel !== 'external_agent')
      throw new CollaborationAnalysisServiceError(
        'analysis_state_conflict',
        'Only an external Analysis Run accepts external JSON',
      );
    run = this.persistStaleIfHeadMoved(run);
    if (run.status === 'stale') {
      if (
        !['awaiting_external_result', 'invalid'].includes(
          run.staleFromStatus ?? '',
        )
      )
        throw this.stateConflict(run, 'submit external result');
      run = this.store.beginStaleExternalAnalysisAttempt({
        analysisId: run.analysisId,
        expectedAttempt: run.attempt,
        nowMs: this.now(),
      });
      this.validateAndPersist(run.analysisId, input.rawJson, null);
      return this.getRun(input.groupId, input.analysisId);
    }
    if (run.status === 'invalid') {
      run = this.store.transitionAnalysisRun({
        analysisId: run.analysisId,
        expectedStatus: 'invalid',
        nextStatus: 'awaiting_external_result',
        validationErrors: [],
        error: null,
        nowMs: this.now(),
      });
    }
    if (run.status !== 'awaiting_external_result')
      throw this.stateConflict(run, 'submit external result');
    this.store.transitionAnalysisRun({
      analysisId: run.analysisId,
      expectedStatus: 'awaiting_external_result',
      nextStatus: 'validating',
      attempt: run.attempt + 1,
      nowMs: this.now(),
    });
    this.validateAndPersist(run.analysisId, input.rawJson, null);
    return this.getRun(input.groupId, input.analysisId);
  }

  decideFinding(input: {
    readonly groupId: string;
    readonly analysisId: string;
    readonly findingId: string;
    readonly decision: z.infer<typeof collaborationFindingDecisionSchema>;
    readonly reason?: string | null;
  }): CollaborationAnalysisFindingRecord {
    const run = this.requireRun(input.groupId, input.analysisId);
    if (
      !['ready_for_review', 'partially_applied', 'stale'].includes(run.status)
    )
      throw this.stateConflict(run, 'review Finding');
    return this.store.decideAnalysisFinding({
      analysisId: input.analysisId,
      findingId: input.findingId,
      decision: collaborationFindingDecisionSchema.parse(input.decision),
      reason: input.reason,
      nowMs: this.now(),
    });
  }

  previewActions(input: {
    readonly groupId: string;
    readonly analysisId: string;
    readonly actions: readonly CollaborationAnalysisActionPreviewInput[];
  }): Array<{
    readonly application: CollaborationAnalysisActionApplicationRecord;
    readonly confirmationToken: string;
  }> {
    const run = this.requireWritableReview(input.groupId, input.analysisId);
    const group = this.requireMember(input.groupId);
    if (!input.actions.length)
      throw new Error('At least one explicit Action is required');
    const findings = new Map(
      this.store
        .listAnalysisFindings(input.analysisId)
        .map((finding) => [finding.findingId, finding]),
    );
    return input.actions.map((entry) => {
      const finding = findings.get(entry.findingId);
      if (!finding) throw new Error(`Finding not found: ${entry.findingId}`);
      if (entry.actionOrdinal !== undefined) {
        const validOrdinal =
          Number.isSafeInteger(entry.actionOrdinal) &&
          entry.actionOrdinal >= 0 &&
          entry.actionOrdinal < finding.finding.proposed_actions.length;
        if (!validOrdinal)
          throw new CollaborationAnalysisServiceError(
            'analysis_action_conflict',
            `Finding ${entry.findingId} has no proposed Action at ordinal ${String(entry.actionOrdinal)}`,
          );
      }
      const action = collaborationProposedActionSchema.parse(entry.action);
      const context = this.requireContext(input.analysisId);
      const actionErrors = findingActionErrors({
        finding: { ...finding.finding, proposed_actions: [action] },
        resourceRefs: new Set(context.resourceIndex),
        resultFindingIds: new Set(findings.keys()),
      });
      if (actionErrors.length)
        throw new CollaborationAnalysisServiceError(
          'analysis_action_conflict',
          actionErrors[0]!.message,
        );
      const operationKey = sha256Text(
        canonicalJsonStringify({
          analysis_id: input.analysisId,
          finding_id: entry.findingId,
          ...(entry.actionOrdinal === undefined
            ? {}
            : { action_ordinal: entry.actionOrdinal }),
          request_id: entry.requestId,
          action,
        }),
      );
      const confirmationToken = sha256Text(
        `${run.challenge}\0${operationKey}\0explicit-confirmation`,
      );
      const preview = this.actionPreview(group, run, action);
      const application = this.store.saveAnalysisActionPreview({
        applicationId: `analysis_action_${crypto.randomUUID()}`,
        operationKey,
        analysisId: input.analysisId,
        findingId: entry.findingId,
        actionOrdinal: entry.actionOrdinal ?? null,
        action,
        preview,
        snapshotHead: run.snapshotHead,
        confirmationTokenHash: sha256Text(confirmationToken),
        nowMs: this.now(),
      });
      return { application, confirmationToken };
    });
  }

  async applyActions(input: {
    readonly groupId: string;
    readonly analysisId: string;
    readonly actions: readonly CollaborationAnalysisActionApplyInput[];
  }): Promise<CollaborationAnalysisRunDetail> {
    const run = this.requireWritableReview(input.groupId, input.analysisId);
    this.requireMember(input.groupId);
    if (!input.actions.length)
      throw new Error('At least one confirmed Action is required');
    for (const request of input.actions) await this.applyOne(run, request);
    const refreshed = this.requireRun(input.groupId, input.analysisId);
    if (refreshed.status === 'ready_for_review')
      this.store.transitionAnalysisRun({
        analysisId: refreshed.analysisId,
        expectedStatus: 'ready_for_review',
        nextStatus: 'partially_applied',
        nowMs: this.now(),
      });
    return this.getRun(input.groupId, input.analysisId);
  }

  private async dispatchManaged(
    run: CollaborationAnalysisRunRecord,
  ): Promise<void> {
    const executor = this.managedExecutor(run);
    const context = this.requireContext(run.analysisId);
    const attempt = run.attempt + 1;
    const operationKey = `analysis:${run.analysisId}:attempt:${String(attempt)}`;
    this.store.transitionAnalysisRun({
      analysisId: run.analysisId,
      expectedStatus: run.status as 'prepared' | 'invalid' | 'failed',
      nextStatus: 'running',
      attempt,
      operationKey,
      executionRef: null,
      providerMetadata: null,
      validationErrors: [],
      error: null,
      nowMs: this.now(),
    });
    try {
      const prepared = await executor.prepare({
        analysisId: run.analysisId,
        operationKey,
        attempt,
        groupId: run.groupId,
        snapshotHead: run.snapshotHead,
        contextHash: run.contextHash,
        promptHash: run.promptHash,
        challenge: run.challenge,
        prompt: context.promptMarkdown,
        context: context.context,
        capabilityFiles: buildProjectAnalystCapabilityFiles({
          resourceCatalog: context.resourceCatalog,
        }),
      });
      const receipt = await executor.dispatch(prepared);
      this.store.recordAnalysisExecutionReceipt({
        analysisId: run.analysisId,
        attempt,
        operationKey,
        executionRef: receipt.executionRef,
        providerMetadata: receipt.providerMetadata,
        nowMs: this.now(),
      });
      this.scheduleMonitor(
        run.analysisId,
        executor,
        receipt.executionRef,
        this.now(),
      );
    } catch (error) {
      this.failRunningRun(run.analysisId, error);
    }
  }

  private scheduleMonitor(
    analysisId: string,
    executor: ManagedAnalysisExecutor,
    executionRef: string,
    startedAtMs: number,
  ): void {
    const poll = async (): Promise<void> => {
      try {
        const observation = await executor.observe(executionRef);
        if (observation.state === 'running') {
          if (this.now() - startedAtMs >= MANAGED_MAX_RUNTIME_MS) {
            this.failRunningRun(
              analysisId,
              new Error(
                'Managed Analysis exceeded the local execution deadline',
              ),
            );
            this.monitorTimers.delete(analysisId);
            return;
          }
          const timer = setTimeout(() => void poll(), MANAGED_POLL_INTERVAL_MS);
          timer.unref?.();
          this.monitorTimers.set(analysisId, timer);
          return;
        }
        this.monitorTimers.delete(analysisId);
        this.consumeManagedObservation(analysisId, observation);
      } catch (error) {
        this.monitorTimers.delete(analysisId);
        this.failRunningRun(analysisId, error);
      }
    };
    void poll();
  }

  private consumeManagedObservation(
    analysisId: string,
    observation: ManagedAnalysisObservation,
  ): void {
    const run = this.store.getAnalysisRun(analysisId);
    if (!run) return;
    if (
      observation.state === 'result_ready' &&
      observation.rawResult !== null
    ) {
      if (run.status === 'running')
        this.store.transitionAnalysisRun({
          analysisId,
          expectedStatus: 'running',
          nextStatus: 'validating',
          providerMetadata: observation.providerMetadata,
          nowMs: this.now(),
        });
      else if (run.status !== 'stale' || run.staleFromStatus !== 'running')
        return;
      this.validateAndPersist(
        analysisId,
        observation.rawResult,
        observation.providerMetadata,
      );
      return;
    }
    if (run.status !== 'running') return;
    const message =
      observation.error?.message ??
      (observation.state === 'recovery_required'
        ? 'Managed execution is no longer observable and will not be redispatched automatically'
        : 'Managed execution failed');
    this.failRunningRun(
      analysisId,
      new Error(message),
      observation.providerMetadata,
    );
  }

  private validateAndPersist(
    analysisId: string,
    rawJson: string,
    providerMetadata: Record<string, unknown> | null,
  ): void {
    const run = this.store.getAnalysisRun(analysisId);
    if (!run || !['validating', 'stale'].includes(run.status))
      throw new Error('Analysis Run is not validating');
    const remainsStale = run.status === 'stale';
    const rawBuffer = Buffer.from(rawJson, 'utf8');
    const errors: CollaborationAnalysisValidationError[] = [];
    let parsed: unknown = null;
    if (rawBuffer.byteLength > MAX_RESULT_BYTES)
      errors.push(
        validationError(
          'result_too_large',
          '/',
          `Analysis result exceeds ${String(MAX_RESULT_BYTES)} bytes`,
        ),
      );
    else {
      try {
        parsed = strictParseJson(rawJson);
      } catch (error) {
        errors.push(
          validationError(
            'json_invalid',
            '/',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    const contract = collaborationAnalysisResultSchema.safeParse(parsed);
    if (!contract.success && !errors.length)
      errors.push(...zodErrors(contract.error));
    if (!contract.success || errors.length) {
      this.persistInvalid(run, rawJson, providerMetadata, errors);
      return;
    }
    const result = contract.data;
    const expectedBindings: Record<(typeof rootBindingFields)[number], string> =
      {
        analysis_id: run.analysisId,
        snapshot_head: run.snapshotHead,
        context_hash: run.contextHash,
        prompt_hash: run.promptHash,
        challenge: run.challenge,
      };
    for (const field of rootBindingFields)
      if (result[field] !== expectedBindings[field])
        errors.push(
          validationError(
            'run_binding_mismatch',
            `/${field}`,
            `${field} does not match the Host-owned Analysis Run`,
          ),
        );
    if (result.contract_version !== run.contractVersion)
      errors.push(
        validationError(
          'contract_version_mismatch',
          '/contract_version',
          'Result contract version does not match the Analysis Run',
        ),
      );
    const summaryContent = allStrings(result.summary).join('\n');
    if (
      credentialPattern.test(summaryContent) ||
      absolutePathPattern.test(summaryContent)
    )
      errors.push(
        validationError(
          'sensitive_content_rejected',
          '/summary',
          'Analysis summary contains a Credential, token, private key, or local absolute path',
        ),
      );
    if (injectionPattern.test(summaryContent))
      errors.push(
        validationError(
          'prompt_injection_rejected',
          '/summary',
          'Analysis summary contains instruction-like content that cannot enter the review contract',
        ),
      );
    if (errors.length) {
      this.persistInvalid(run, rawJson, providerMetadata, errors);
      return;
    }
    const context = this.requireContext(analysisId);
    const refs = new Set(context.resourceIndex);
    const findingIds = new Set(
      result.findings.map((finding) => finding.finding_id),
    );
    const accepted: CollaborationAnalysisFinding[] = [];
    for (const finding of result.findings) {
      const findingErrors: CollaborationAnalysisValidationError[] = [];
      for (const [key, values] of [
        ['affected_refs', finding.affected_refs],
        ['evidence_refs', finding.evidence_refs],
      ] as const)
        for (const ref of values)
          if (!refs.has(ref))
            findingErrors.push(
              validationError(
                'evidence_not_in_snapshot',
                `/findings/${finding.finding_id}/${key}`,
                `Resource ref is not present in the frozen visible snapshot: ${ref}`,
                finding.finding_id,
              ),
            );
      const content = allStrings(finding).join('\n');
      if (credentialPattern.test(content) || absolutePathPattern.test(content))
        findingErrors.push(
          validationError(
            'sensitive_content_rejected',
            `/findings/${finding.finding_id}`,
            'Finding contains a Credential, token, private key, or local absolute path',
            finding.finding_id,
          ),
        );
      if (injectionPattern.test(content))
        findingErrors.push(
          validationError(
            'prompt_injection_rejected',
            `/findings/${finding.finding_id}`,
            'Finding contains instruction-like content that cannot enter the review contract',
            finding.finding_id,
          ),
        );
      findingErrors.push(
        ...findingActionErrors({
          finding,
          resourceRefs: refs,
          resultFindingIds: findingIds,
        }),
      );
      errors.push(...findingErrors);
      if (!findingErrors.length) accepted.push(finding);
    }
    const normalized: CollaborationAnalysisResult = {
      ...result,
      findings: accepted,
    };
    this.store.saveAnalysisResult({
      analysisId,
      attempt: run.attempt,
      rawJson,
      rawHash: sha256Buffer(Buffer.from(rawJson, 'utf8')),
      normalized,
      validationErrors: errors,
      providerMetadata,
      nowMs: this.now(),
    });
    this.persistFindings(run, normalized);
    if (remainsStale)
      this.store.updateStaleAnalysisDiagnostics({
        analysisId,
        attempt: run.attempt,
        providerMetadata,
        validationErrors: errors,
        error: null,
        nowMs: this.now(),
      });
    else
      this.store.transitionAnalysisRun({
        analysisId,
        expectedStatus: 'validating',
        nextStatus: 'ready_for_review',
        providerMetadata,
        validationErrors: errors,
        error: null,
        nowMs: this.now(),
      });
    this.store.addLocalAuditEvidence({
      groupId: run.groupId,
      evidenceType: 'analysis_result_validated',
      resourceType: 'analysis_run',
      resourceId: analysisId,
      evidence: {
        analysis_id: analysisId,
        snapshot_head: run.snapshotHead,
        raw_hash: sha256Buffer(Buffer.from(rawJson, 'utf8')),
        accepted_findings: accepted.length,
        rejected_findings: new Set(
          errors.flatMap((error) => error.findingId ?? []),
        ).size,
      },
      observedAtMs: this.now(),
    });
  }

  private persistInvalid(
    run: CollaborationAnalysisRunRecord,
    rawJson: string,
    providerMetadata: Record<string, unknown> | null,
    errors: readonly CollaborationAnalysisValidationError[],
  ): void {
    this.store.saveAnalysisResult({
      analysisId: run.analysisId,
      attempt: run.attempt,
      rawJson,
      rawHash: sha256Buffer(Buffer.from(rawJson, 'utf8')),
      normalized: null,
      validationErrors: errors,
      providerMetadata,
      nowMs: this.now(),
    });
    if (run.status === 'stale')
      this.store.updateStaleAnalysisDiagnostics({
        analysisId: run.analysisId,
        attempt: run.attempt,
        providerMetadata,
        validationErrors: errors,
        error: 'Analysis result failed Host validation',
        nowMs: this.now(),
      });
    else
      this.store.transitionAnalysisRun({
        analysisId: run.analysisId,
        expectedStatus: 'validating',
        nextStatus: 'invalid',
        providerMetadata,
        validationErrors: errors,
        error: 'Analysis result failed Host validation',
        nowMs: this.now(),
      });
  }

  private persistFindings(
    run: CollaborationAnalysisRunRecord,
    result: CollaborationAnalysisResult,
  ): void {
    const previousRun = this.store.findPriorValidAnalysisRun(run.analysisId);
    const previous = previousRun
      ? this.store.listAnalysisFindings(previousRun.analysisId)
      : [];
    const priorByDedupe = new Map(
      previous.map((entry) => [entry.dedupeKey, entry]),
    );
    const currentKeys = new Set<string>();
    const values: Array<{
      finding: CollaborationAnalysisFinding;
      dedupeKey: string;
      lifecycle: CollaborationAnalysisFindingRecord['lifecycle'];
    }> = [];
    for (const finding of result.findings) {
      const dedupeKey = findingDedupeKey(finding);
      currentKeys.add(dedupeKey);
      values.push({
        finding,
        dedupeKey,
        lifecycle: findingLifecycle(
          finding,
          priorByDedupe.get(dedupeKey) ?? null,
        ),
      });
    }
    for (const prior of previous)
      if (!currentKeys.has(prior.dedupeKey) && prior.lifecycle !== 'dismissed')
        values.push({
          finding: prior.finding,
          dedupeKey: prior.dedupeKey,
          lifecycle: 'resolved',
        });
    this.store.replaceAnalysisFindings({
      analysisId: run.analysisId,
      groupId: run.groupId,
      findings: values,
      nowMs: this.now(),
    });
  }

  private actionPreview(
    group: CollaborationProjectSpaceGroupRecord,
    run: CollaborationAnalysisRunRecord,
    action: CollaborationProposedAction,
  ): Record<string, unknown> {
    const projection = group.projection!;
    const headRevision = (type: string, id: string) =>
      projection.aggregateHeads[`${type}:${id}`]?.revision ?? 0;
    const common = {
      action: action.action,
      analysis_id: run.analysisId,
      snapshot_head: run.snapshotHead,
      actor_principal_id: group.localPrincipalId,
      actor_client_id: group.localClientId,
      requires_explicit_confirmation: true,
    };
    switch (action.action) {
      case 'create_work_item':
        return {
          ...common,
          work_item_id: `wi_analysis_${crypto.randomUUID()}`,
          expected_revision: 0,
        };
      case 'open_discussion':
      case 'request_information':
        return {
          ...common,
          thread_id: `thread_analysis_${crypto.randomUUID()}`,
          expected_revision: 0,
        };
      case 'post_progress':
      case 'publish_analysis_report': {
        const shared =
          action.action === 'publish_analysis_report' &&
          action.parameters.destination === 'shared_files';
        const aggregateId = shared ? 'shared' : group.localPrincipalId!;
        return {
          ...common,
          aggregate_type: 'workspace',
          aggregate_id: aggregateId,
          expected_revision: headRevision('workspace', aggregateId),
          ...(action.action === 'publish_analysis_report'
            ? { file_id: `file_analysis_${crypto.randomUUID()}` }
            : {}),
        };
      }
      case 'watch_work_item':
        return {
          ...common,
          work_item_id: action.parameters.work_item_id,
          expected_revision: headRevision(
            'work_item',
            action.parameters.work_item_id,
          ),
        };
    }
  }

  private async applyOne(
    run: CollaborationAnalysisRunRecord,
    request: CollaborationAnalysisActionApplyInput,
  ): Promise<void> {
    const application = this.store
      .listAnalysisActionApplications(run.analysisId)
      .find((entry) => entry.applicationId === request.applicationId);
    if (!application)
      throw new Error(
        `Analysis Action application not found: ${request.applicationId}`,
      );
    const action = request.action
      ? collaborationProposedActionSchema.parse(request.action)
      : application.action;
    if (
      canonicalJsonStringify(action) !==
      canonicalJsonStringify(application.action)
    )
      throw new CollaborationAnalysisServiceError(
        'analysis_confirmation_invalid',
        'Confirmed Action differs from its preview',
      );
    if (
      sha256Text(request.confirmationToken) !==
      application.confirmationTokenHash
    )
      throw new CollaborationAnalysisServiceError(
        'analysis_confirmation_invalid',
        'Action confirmation token is invalid',
      );
    if (application.state === 'applied') return;
    if (application.state !== 'previewed' && application.state !== 'failed')
      throw new CollaborationAnalysisServiceError(
        'analysis_action_conflict',
        'Analysis Action is already applying',
      );
    const applying = this.store.transitionAnalysisActionApplication({
      applicationId: application.applicationId,
      expectedState: application.state,
      nextState: 'applying',
      nowMs: this.now(),
    });
    try {
      const before = this.requireGroup(run.groupId);
      const beforeIds = new Set(
        before.projection?.activity.map((event) => event.eventId) ?? [],
      );
      const updated = await this.executeAction(run, applying);
      const eventIds =
        updated.projection?.activity
          .filter((event) => !beforeIds.has(event.eventId))
          .map((event) => event.eventId) ?? [];
      this.store.transitionAnalysisActionApplication({
        applicationId: application.applicationId,
        expectedState: 'applying',
        nextState: 'applied',
        resultingEventIds: eventIds,
        nowMs: this.now(),
      });
      this.store.addLocalAuditEvidence({
        groupId: run.groupId,
        evidenceType: 'analysis_action_applied',
        resourceType: 'analysis_finding',
        resourceId: application.findingId,
        evidence: {
          analysis_id: run.analysisId,
          finding_id: application.findingId,
          execution_channel: run.executionChannel,
          executor_id: run.executorId,
          snapshot_head: run.snapshotHead,
          user_confirmation_time: new Date(this.now()).toISOString(),
          resulting_event_ids: eventIds,
        },
        observedAtMs: this.now(),
      });
    } catch (error) {
      this.store.transitionAnalysisActionApplication({
        applicationId: application.applicationId,
        expectedState: 'applying',
        nextState: 'failed',
        error: error instanceof Error ? error.message : String(error),
        nowMs: this.now(),
      });
      throw error;
    }
  }

  private async executeAction(
    run: CollaborationAnalysisRunRecord,
    application: CollaborationAnalysisActionApplicationRecord,
  ): Promise<CollaborationProjectSpaceGroupRecord> {
    const group = this.requireMember(run.groupId);
    const projection = group.projection!;
    const preview = application.preview;
    const expected = Number(preview.expected_revision);
    const action = application.action;
    const assertRevision = (type: string, id: string): void => {
      const current = projection.aggregateHeads[`${type}:${id}`]?.revision ?? 0;
      if (current !== expected)
        throw new CollaborationAnalysisServiceError(
          'analysis_snapshot_stale',
          `Action target changed after preview: ${type}:${id}`,
        );
    };
    switch (action.action) {
      case 'create_work_item': {
        const workItemId = String(preview.work_item_id);
        assertRevision('work_item', workItemId);
        return this.groups.createWorkItem({
          groupId: run.groupId,
          expectedRevision: 0,
          workItemId,
          type: action.parameters.type,
          title: action.parameters.title,
          description: action.parameters.description,
          priority: action.parameters.priority,
          dueAt: action.parameters.due_at,
          labels: action.parameters.labels,
          relatedItems: action.parameters.related_work_item_ids,
        });
      }
      case 'open_discussion': {
        const threadId = String(preview.thread_id);
        assertRevision('discussion', threadId);
        return this.groups.createDiscussionWithMessage({
          groupId: run.groupId,
          expectedRevision: 0,
          threadId,
          title: action.parameters.title,
          scope: action.parameters.scope,
          body: action.parameters.body,
          mentions: action.parameters.mentions,
          origin: 'human',
        });
      }
      case 'request_information': {
        const threadId = String(preview.thread_id);
        assertRevision('discussion', threadId);
        return this.groups.createDiscussionWithMessage({
          groupId: run.groupId,
          expectedRevision: 0,
          threadId,
          title: action.parameters.title,
          scope: { type: 'group' },
          body: action.parameters.question,
          mentions: action.parameters.mentions,
          refs: action.parameters.affected_refs,
          origin: 'human',
        });
      }
      case 'post_progress': {
        const principalId = group.localPrincipalId!;
        assertRevision('workspace', principalId);
        return this.groups.postProgress({
          groupId: run.groupId,
          expectedRevision: expected,
          summary: action.parameters.summary,
          completed: action.parameters.completed,
          nextSteps: action.parameters.next_steps,
          blockers: action.parameters.blockers,
          workItemRefs: action.parameters.work_item_refs,
          workflowInstanceRefs: action.parameters.workflow_instance_refs,
          origin: 'human',
        });
      }
      case 'watch_work_item': {
        const item = projection.workItems[action.parameters.work_item_id];
        if (!item) throw new Error('Work Item no longer exists');
        assertRevision('work_item', item.work_item_id);
        return this.groups.updateWorkItemDetails({
          groupId: run.groupId,
          workItemId: item.work_item_id,
          expectedRevision: expected,
          watchers: [...new Set([...item.watchers, group.localPrincipalId!])],
        });
      }
      case 'publish_analysis_report': {
        const shared = action.parameters.destination === 'shared_files';
        const aggregateId = shared ? 'shared' : group.localPrincipalId!;
        assertRevision('workspace', aggregateId);
        const contents = Buffer.from(
          this.analysisReportMarkdown(
            run,
            action.parameters.include_finding_ids,
          ),
          'utf8',
        );
        const common = {
          groupId: run.groupId,
          expectedRevision: expected,
          fileId: String(preview.file_id),
          fileName: `${action.parameters.title.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 180) || 'project-analysis'}.md`,
          mediaType: 'text/markdown',
          contents,
          origin: 'human' as const,
        };
        return shared
          ? this.groups.publishSharedFile(common)
          : this.groups.publishPrincipalFile(common);
      }
    }
  }

  private analysisReportMarkdown(
    run: CollaborationAnalysisRunRecord,
    findingIds: readonly string[],
  ): string {
    const result = this.store.getLatestAnalysisResult(
      run.analysisId,
    )?.normalized;
    if (!result) throw new Error('Validated Analysis Result is unavailable');
    const selected = new Set(findingIds);
    const findings = result.findings.filter((finding) =>
      selected.has(finding.finding_id),
    );
    if (findings.length !== selected.size)
      throw new Error('Analysis report includes an unavailable Finding');
    return `# ${result.summary.headline}\n\nSnapshot: \`${run.snapshotHead}\`\n\n${result.summary.details}\n\n${findings
      .map(
        (finding) =>
          `## ${finding.title}\n\n- Kind: ${finding.kind}\n- Category: ${finding.category}\n- Severity: ${finding.severity}\n- Confidence: ${finding.confidence.toFixed(2)}\n- Evidence: ${finding.evidence_refs.map((ref) => `\`${ref}\``).join(', ')}\n\n${finding.summary}\n`,
      )
      .join('\n')}\n`;
  }

  private async appendExternalFiles(
    run: CollaborationAnalysisRunRecord,
    catalog: ResourceCatalog,
    selectedFileIds: readonly string[],
    files: Array<CollaborationExternalAnalysisPackage['files'][number]>,
  ): Promise<void> {
    for (const fileId of selectedFileIds) {
      const entry = this.frozenFile(catalog, fileId);
      const contents = await this.readAndVerifyFrozenFile(run, entry);
      if (contents.byteLength > MAX_EXTERNAL_FILE_BYTES)
        throw new Error(
          `Selected file exceeds external package limit: ${fileId}`,
        );
      const metadata = jsonRecord(entry.metadata);
      const text = contents.toString('utf8');
      const roundTrip = Buffer.from(text, 'utf8');
      const textual = roundTrip.equals(contents);
      const redacted = textual
        ? redactExternalText(text)
        : { text: contents.toString('base64'), redacted: false };
      files.push({
        path: `verified-files/${fileId}/${String(metadata.original_filename)}`,
        media_type:
          typeof metadata.media_type === 'string'
            ? metadata.media_type
            : 'text/plain',
        encoding: textual ? 'utf8' : 'base64',
        content: redacted.text,
        bytes: Buffer.byteLength(redacted.text),
        redacted: redacted.redacted,
      });
    }
  }

  private frozenFile(
    catalog: ResourceCatalog,
    fileId: string,
  ): Record<string, unknown> {
    const ref = `file:${fileId}`;
    if (!(ref in catalog))
      throw new CollaborationAnalysisServiceError(
        'analysis_tool_denied',
        'File is outside the frozen Analysis scope',
      );
    const entry = jsonRecord(catalog[ref]);
    const metadata = jsonRecord(entry.metadata);
    if (
      metadata.file_id !== fileId ||
      typeof entry.repository_path !== 'string' ||
      !entry.repository_path
    )
      throw new CollaborationAnalysisServiceError(
        'analysis_tool_denied',
        'Frozen file metadata is incomplete or external-only',
      );
    return entry;
  }

  private async readAndVerifyFrozenFile(
    run: CollaborationAnalysisRunRecord,
    entry: Record<string, unknown>,
  ): Promise<Buffer> {
    const metadata = jsonRecord(entry.metadata);
    const contents = await this.groups.readVerifiedFile({
      groupId: run.groupId,
      repositoryFile: String(entry.repository_path),
      verifiedCommit: run.snapshotHead,
    });
    if (
      contents.byteLength !== Number(metadata.size) ||
      sha256Buffer(contents) !== metadata.sha256
    )
      throw new CollaborationAnalysisServiceError(
        'analysis_tool_denied',
        'Verified file bytes do not match the frozen metadata hash',
      );
    return contents;
  }

  private priorFindingSummary(
    groupId: string,
    scope: CollaborationAnalysisScope,
  ): Record<string, unknown>[] {
    const previous = this.store
      .listAnalysisRuns(groupId)
      .find(
        (run) =>
          canonicalJsonStringify(run.scope) === canonicalJsonStringify(scope) &&
          [
            'ready_for_review',
            'partially_applied',
            'completed',
            'stale',
          ].includes(run.status) &&
          Boolean(
            this.store.getLatestAnalysisResult(run.analysisId)?.normalized,
          ),
      );
    if (!previous) return [];
    return this.store
      .listAnalysisFindings(previous.analysisId)
      .map((entry) => ({
        finding_id: entry.findingId,
        dedupe_key: entry.dedupeKey,
        lifecycle: entry.lifecycle,
        category: entry.finding.category,
        severity: entry.finding.severity,
        affected_refs: entry.finding.affected_refs,
      }));
  }

  private buildDetail(
    group: CollaborationProjectSpaceGroupRecord,
    run: CollaborationAnalysisRunRecord,
  ): CollaborationAnalysisRunDetail {
    const selected = this.persistStaleIfHeadMoved(run, group);
    const context = this.store.getAnalysisContext(selected.analysisId);
    return {
      run: selected,
      stale:
        group.lastVerifiedHead !== selected.snapshotHead ||
        selected.status === 'stale',
      result: this.store.getLatestAnalysisResult(selected.analysisId),
      results: this.store.listAnalysisResults(selected.analysisId),
      findings: this.store.listAnalysisFindings(selected.analysisId),
      applications: this.store.listAnalysisActionApplications(
        selected.analysisId,
      ),
      exportScope: context?.exportScope ?? {},
      allowedActionTypes: COLLABORATION_ANALYSIS_ALLOWED_ACTION_TYPES,
      repairPrompt:
        selected.status === 'invalid'
          ? projectAnalystRepairPrompt({
              validationErrors: selected.validationErrors,
            })
          : null,
    };
  }

  private managedExecutor(run: CollaborationAnalysisRunRecord) {
    if (!run.executorId)
      throw new Error('Managed Analysis Run has no Executor binding');
    return this.executors.resolve(run.executorId);
  }

  private failRunningRun(
    analysisId: string,
    error: unknown,
    providerMetadata?: Record<string, unknown>,
  ): void {
    const run = this.store.getAnalysisRun(analysisId);
    if (!run || run.status !== 'running') return;
    this.store.transitionAnalysisRun({
      analysisId,
      expectedStatus: 'running',
      nextStatus: 'failed',
      providerMetadata,
      error: error instanceof Error ? error.message : String(error),
      nowMs: this.now(),
    });
  }

  private requireGroup(groupId: string): CollaborationProjectSpaceGroupRecord {
    const group = this.store.getGroup(groupId);
    if (!group)
      throw new CollaborationAnalysisServiceError(
        'analysis_not_found',
        `Collaboration Group not found: ${groupId}`,
      );
    return group;
  }

  private requireMember(groupId: string): CollaborationProjectSpaceGroupRecord {
    const group = this.requireGroup(groupId);
    if (
      group.subscriptionMode !== 'member' ||
      !group.localPrincipalId ||
      !group.localClientId
    )
      throw new CollaborationAnalysisServiceError(
        'analysis_permission_denied',
        'Observer can review local Analysis Results but cannot apply Group actions',
      );
    return group;
  }

  private requireRun(
    groupId: string,
    analysisId: string,
  ): CollaborationAnalysisRunRecord {
    const run = this.store.getAnalysisRun(analysisId);
    if (!run)
      throw new CollaborationAnalysisServiceError(
        'analysis_not_found',
        `Analysis Run not found: ${analysisId}`,
      );
    if (run.groupId !== groupId)
      throw new CollaborationAnalysisServiceError(
        'analysis_group_mismatch',
        'Analysis Run does not belong to the requested Group',
      );
    return run;
  }

  private persistStaleIfHeadMoved(
    run: CollaborationAnalysisRunRecord,
    selectedGroup?: CollaborationProjectSpaceGroupRecord,
  ): CollaborationAnalysisRunRecord {
    const group = selectedGroup ?? this.requireGroup(run.groupId);
    if (
      group.lastVerifiedHead === run.snapshotHead ||
      run.status === 'stale' ||
      run.status === 'cancelled'
    )
      return run;
    this.store.markAnalysisRunsStale(run.groupId, currentHead(group));
    return this.store.getAnalysisRun(run.analysisId) ?? run;
  }

  private requireFreshRun(
    groupId: string,
    analysisId: string,
  ): CollaborationAnalysisRunRecord {
    const run = this.persistStaleIfHeadMoved(
      this.requireRun(groupId, analysisId),
    );
    if (run.status === 'stale')
      throw new CollaborationAnalysisServiceError(
        'analysis_snapshot_stale',
        'Analysis Run verified snapshot is stale',
      );
    return run;
  }

  private requireContext(analysisId: string) {
    const context = this.store.getAnalysisContext(analysisId);
    if (!context) throw new Error('Frozen Analysis Context is unavailable');
    return context;
  }

  private requireWritableReview(
    groupId: string,
    analysisId: string,
  ): CollaborationAnalysisRunRecord {
    const run = this.requireFreshRun(groupId, analysisId);
    if (!['ready_for_review', 'partially_applied'].includes(run.status))
      throw this.stateConflict(run, 'preview or apply Actions');
    return run;
  }

  private stateConflict(run: CollaborationAnalysisRunRecord, action: string) {
    return new CollaborationAnalysisServiceError(
      'analysis_state_conflict',
      `Cannot ${action} while Analysis Run is ${run.status}`,
    );
  }
}
