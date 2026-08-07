import type { InternalAgentChatService } from '../internal-agent-run-once/chat-service.js';
import { domainSeparatedSha256 } from '../workflow-runtime/contracts/hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import type {
  RuntimeWorkspaceGateway,
  WorkspacePublishedCreationInput,
  WorkspaceRecipeCatalog,
  WorkspaceReplanReceipt,
  WorkspaceRuntimeDetail,
  WorkspaceTemporaryReplanPreparation,
} from '../workflow-runtime/gateway/workspace.js';
import { calculateWorkspaceTemporaryReplanConfirmationHash } from '../workflow-runtime/gateway/workspace.js';
import type {
  TaskExecutionLinkV1,
  TaskLaunchIntentV1,
  TaskInteractionSubmissionV1,
  TaskPendingInteractionV1,
  TaskRuntimeCommandAction,
  TaskRuntimeCommandProposalV1,
  TaskRunSelection,
  TaskSessionV1,
  TaskTimelineEntryV1,
  TaskWorkspaceSessionLinkV1,
  TaskWorkspaceTimelineDeltaV1,
  TemporaryWorkflowDraftRevisionV1,
} from './contracts.js';
import { RuntimeEventHub, type RuntimeEventHint } from './runtime-event-hub.js';
import {
  sanitizePersonalWorkflowSource,
  TaskWorkspaceStore,
  TaskWorkspaceStoreError,
} from './store.js';

export interface TaskWorkspaceRuntimeGateway {
  listRecipes: RuntimeWorkspaceGateway['listRecipes'];
  createPublished: RuntimeWorkspaceGateway['createPublished'];
  createTemporary: RuntimeWorkspaceGateway['createTemporary'];
  launchPublished?: RuntimeWorkspaceGateway['launchPublished'];
  launchTemporary?: RuntimeWorkspaceGateway['launchTemporary'];
  prepareTemporaryDraft: RuntimeWorkspaceGateway['prepareTemporaryDraft'];
  findCreation: RuntimeWorkspaceGateway['findCreation'];
  getRuntimeDetail: RuntimeWorkspaceGateway['getRuntimeDetail'];
  listRuntimeEvents: RuntimeWorkspaceGateway['listRuntimeEvents'];
  submitInteraction: RuntimeWorkspaceGateway['submitInteraction'];
  submitCommand: RuntimeWorkspaceGateway['submitCommand'];
  extractPersonalWorkflowDraft: RuntimeWorkspaceGateway['extractPersonalWorkflowDraft'];
  preparePersonalWorkflowDraft: RuntimeWorkspaceGateway['preparePersonalWorkflowDraft'];
  publishPersonalWorkflowRelease: RuntimeWorkspaceGateway['publishPersonalWorkflowRelease'];
  activatePersonalWorkflowRelease: RuntimeWorkspaceGateway['activatePersonalWorkflowRelease'];
  listPersonalWorkflowReleases: RuntimeWorkspaceGateway['listPersonalWorkflowReleases'];
  prepareTemporaryReplan: RuntimeWorkspaceGateway['prepareTemporaryReplan'];
  applyTemporaryReplan: RuntimeWorkspaceGateway['applyTemporaryReplan'];
  reconcileTemporaryReplan: RuntimeWorkspaceGateway['reconcileTemporaryReplan'];
}

export interface TaskWorkspaceServiceOptions {
  readonly store: TaskWorkspaceStore;
  readonly runtimeGateway: TaskWorkspaceRuntimeGateway | null;
  readonly runtimeEventHub: RuntimeEventHub;
  readonly coordinator: Pick<InternalAgentChatService, 'chat'> | null;
  readonly coordinatorAgentJid: () => string | null;
  readonly preparePublishedCreation?: (input: {
    readonly session: TaskSessionV1;
    readonly launch: TaskLaunchIntentV1;
  }) =>
    | WorkspacePublishedCreationInput
    | Promise<WorkspacePublishedCreationInput>;
  readonly prepareTemporaryCreation?: (input: {
    readonly session: TaskSessionV1;
    readonly launch: TaskLaunchIntentV1;
    readonly revision: TemporaryWorkflowDraftRevisionV1;
  }) =>
    | WorkspacePublishedCreationInput
    | Promise<WorkspacePublishedCreationInput>;
  readonly timelinePollMs?: number;
  readonly now?: () => number;
  readonly onTimelineDelta?: (delta: TaskWorkspaceTimelineDeltaV1) => void;
}

export class TaskWorkspaceServiceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'conflict'
      | 'runtime_unavailable'
      | 'coordinator_unavailable'
      | 'temporary_draft_invalid',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TaskWorkspaceServiceError';
  }
}

function sha(domain: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(`icarus:task-workspace:${domain}:1\n`, value);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]! : trimmed;
}

function draftFromCoordinator(
  text: string,
  objective: string,
): {
  source: JsonObject;
  risk: JsonObject;
} {
  let parsed: JsonObject | null = null;
  try {
    parsed = asObject(JSON.parse(stripCodeFence(text)));
  } catch {
    parsed = null;
  }
  const source = asObject(parsed?.source) ?? terminalTemporarySource();
  const risk = asObject(parsed?.risk_summary) ?? {
    effect_ceiling: 'read_only',
    human_input_points: [],
    notes: [],
  };
  return {
    source,
    risk,
  };
}

function terminalTemporarySource(): JsonObject {
  return {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'dynamic_child',
    interface_ref: { id: 'fixture.interface.child', version: '1.0.0' },
    nodes: [
      {
        id: 'child_done',
        type: 'terminal',
        trigger: { type: 'root' },
        exit: 'done',
      },
    ],
    control_edges: [],
    data_edges: [],
    completion: {
      settled_rules: [
        {
          id: 'select_done',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
    requested_limits: {
      max_scopes: null,
      max_nodes: null,
      max_nodes_per_scope: null,
      max_edges_per_scope: null,
      max_nesting_depth: null,
      max_map_items: null,
      max_concurrency: null,
      max_total_attempts: null,
      max_total_waits: null,
      max_total_output_bytes: null,
      max_scope_spec_bytes: null,
      max_condition_steps: null,
      max_wait_duration_ms: null,
      max_pending_signals: null,
      max_fixed_point_facts: null,
      max_frontier_bytes: null,
    },
  };
}

function temporaryReplanSourceFromCoordinator(text: string): JsonObject | null {
  try {
    const parsed = asObject(JSON.parse(stripCodeFence(text)));
    if (!parsed) return null;
    const source = asObject(parsed.source_json) ?? asObject(parsed.source);
    if (source) return source;
    return parsed.format === 'icarus.workflow-graph-scope/1' ? parsed : null;
  } catch {
    return null;
  }
}

function storedReplanPreparation(
  replan: JsonObject,
): WorkspaceTemporaryReplanPreparation {
  const proposal = asObject(replan.proposal);
  const preparation = asObject(proposal?.preparation);
  if (
    proposal?.format !== 'icarus.task-workspace-temporary-replan-proposal/1' ||
    !preparation ||
    preparation.format !== 'icarus.workspace-temporary-replan-preparation/1'
  ) {
    throw new TaskWorkspaceServiceError(
      'conflict',
      'Temporary Replan preparation is unavailable or invalid',
    );
  }
  return preparation as WorkspaceTemporaryReplanPreparation;
}

export class TaskWorkspaceService {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly activeTurns = new Map<string, Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private unsubscribeHub: (() => void) | null = null;
  private stopping = false;

  constructor(private readonly options: TaskWorkspaceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.pollMs = options.timelinePollMs ?? 15_000;
  }

  async start(): Promise<void> {
    if (this.pollTimer) return;
    this.stopping = false;
    this.unsubscribeHub = this.options.runtimeEventHub.subscribe((hint) =>
      this.handleRuntimeHint(hint),
    );
    await this.recover();
    this.pollTimer = setInterval(() => void this.catchUpAll(), this.pollMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
    await Promise.allSettled(this.activeTurns.values());
  }

  createSession(input: {
    principalRef: string;
    title: string;
    source?: TaskSessionV1['source'];
  }): TaskSessionV1 {
    return this.options.store.createSession({
      ownerPrincipalRef: input.principalRef,
      title: input.title,
      source: input.source,
      nowMs: this.now(),
    });
  }

  listSessions(principalRef: string): TaskSessionV1[] {
    return this.options.store.listSessions(principalRef);
  }

  resolveRuntimeLink(
    workflowId: string,
    principalRef: string,
  ): {
    link: TaskWorkspaceSessionLinkV1;
    execution_link: TaskExecutionLinkV1;
  } {
    const executionLink = this.options.store.findExecutionLinkByWorkflow(
      workflowId,
      principalRef,
    );
    if (!executionLink) {
      throw new TaskWorkspaceServiceError(
        'not_found',
        'Workflow is not linked to an accessible TaskSession',
      );
    }
    return {
      link: {
        format: 'icarus.task-workspace-link/1',
        target: 'session',
        session_id: executionLink.session_id,
      },
      execution_link: executionLink,
    };
  }

  async getSession(
    sessionId: string,
    principalRef: string,
  ): Promise<{
    session: TaskSessionV1;
    execution_links: ReturnType<TaskWorkspaceStore['listExecutionLinks']>;
  }> {
    const session = this.options.store.getSession(sessionId, principalRef);
    await this.reconcileCreating(session);
    await this.catchUpSession(session);
    void this.kickCoordinator(session.session_id);
    return {
      session: this.options.store.getSession(sessionId, principalRef),
      execution_links: this.options.store.listExecutionLinks(sessionId),
    };
  }

  updateSessionStatus(input: {
    sessionId: string;
    principalRef: string;
    status: TaskSessionV1['status'];
    expectedRowVersion: number;
  }): TaskSessionV1 {
    return this.options.store.updateSessionStatus({
      sessionId: input.sessionId,
      principalRef: input.principalRef,
      status: input.status,
      expectedRowVersion: input.expectedRowVersion,
      nowMs: this.now(),
    });
  }

  setRunSelection(input: {
    sessionId: string;
    principalRef: string;
    selection: TaskRunSelection;
    expectedRowVersion: number;
  }): TaskSessionV1 {
    return this.options.store.setRunSelection({
      ...input,
      nowMs: this.now(),
    });
  }

  listRecipes(principalRef: string): WorkspaceRecipeCatalog {
    if (!this.options.runtimeGateway) {
      return {
        format: 'icarus.workspace-recipe-catalog/1',
        items: [],
        expires_at_ms: this.now(),
      };
    }
    return this.options.runtimeGateway.listRecipes({
      principal_ref: principalRef,
      now_ms: this.now(),
    });
  }

  async send(input: {
    sessionId: string;
    principalRef: string;
    text: string;
    replyToMessageId?: string | null;
  }): Promise<ReturnType<TaskWorkspaceStore['appendMessage']>> {
    this.options.store.getSession(input.sessionId, input.principalRef);
    const result = this.options.store.appendMessage({
      sessionId: input.sessionId,
      role: 'human',
      bodyText: input.text,
      replyToMessageId: input.replyToMessageId,
      createCoordinatorTurn: true,
      nowMs: this.now(),
    });
    this.emitEntries(input.sessionId, [result.timeline]);
    void this.kickCoordinator(input.sessionId);
    return result;
  }

  async run(input: {
    sessionId: string;
    principalRef: string;
    text: string;
    selectionToken?: string | null;
    idempotencyKey: string;
  }): Promise<TaskLaunchIntentV1> {
    const session = this.options.store.getSession(
      input.sessionId,
      input.principalRef,
    );
    const message = this.options.store.appendMessage({
      sessionId: input.sessionId,
      role: 'human',
      bodyText: input.text,
      createCoordinatorTurn: false,
      nowMs: this.now(),
    });
    this.emitEntries(input.sessionId, [message.timeline]);
    const temporary =
      session.current_run_selection.kind === 'temporary_workflow';
    const temporaryOuter = temporary
      ? (this.listRecipes(input.principalRef).items.find(
          (item) => item.recipe_ref.id === 'ad_hoc_personal_task',
        ) ?? null)
      : null;
    const launch = this.options.store.createLaunchIntent({
      sessionId: input.sessionId,
      sourceMessageId: message.message.message_id,
      mode: temporary ? 'temporary_workflow' : 'published_recipe',
      selectionToken: temporary
        ? (temporaryOuter?.selection_token ?? null)
        : input.selectionToken,
      selectedRecipeRef: temporary
        ? (temporaryOuter?.recipe_ref ?? null)
        : session.current_run_selection.recipe_ref,
      selectedRecipeHash: temporary
        ? (temporaryOuter?.recipe_hash ?? null)
        : session.current_run_selection.recipe_hash,
      effectiveInput: {
        format: 'icarus.task-workspace-effective-input/1',
        text: input.text,
        attachments: [],
      },
      attachmentManifestHash: sha('attachment-manifest', []),
      idempotencyKey: input.idempotencyKey,
      nowMs: this.now(),
    });
    if (temporary) {
      void this.planTemporary(session, launch, input.text).catch((error) => {
        this.failLaunch(
          this.options.store.getLaunchIntent(launch.launch_intent_id),
          error instanceof Error ? error.message : 'temporary_draft_invalid',
        );
      });
    } else {
      void this.createPublished(session, launch);
    }
    return launch;
  }

  getLaunchIntent(
    launchIntentId: string,
    principalRef: string,
  ): TaskLaunchIntentV1 {
    const launch = this.options.store.getLaunchIntent(launchIntentId);
    this.options.store.getSession(launch.session_id, principalRef);
    return launch;
  }

  async reviseTemporary(input: {
    launchIntentId: string;
    principalRef: string;
    instruction: string;
  }): Promise<TemporaryWorkflowDraftRevisionV1> {
    const launch = this.getLaunchIntent(
      input.launchIntentId,
      input.principalRef,
    );
    const session = this.options.store.getSession(
      launch.session_id,
      input.principalRef,
    );
    return this.planTemporary(session, launch, input.instruction);
  }

  async confirmTemporary(input: {
    launchIntentId: string;
    revisionId: string;
    principalRef: string;
    expectedRowVersion: number;
  }): Promise<TaskLaunchIntentV1> {
    const launch = this.getLaunchIntent(
      input.launchIntentId,
      input.principalRef,
    );
    if (
      launch.status !== 'awaiting_confirmation' ||
      launch.row_version !== input.expectedRowVersion
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Temporary confirmation is stale',
      );
    }
    const revision = this.options.store.getTemporaryRevision(input.revisionId);
    const session = this.options.store.getSession(
      launch.session_id,
      input.principalRef,
    );
    let creating = this.options.store.updateLaunchStatus({
      launchIntentId: launch.launch_intent_id,
      expectedRowVersion: launch.row_version,
      status: 'creating',
      confirmedRevisionId: revision.revision_id,
      nowMs: this.now(),
    });
    if (
      !this.options.runtimeGateway ||
      (!this.options.runtimeGateway.launchTemporary &&
        !this.options.prepareTemporaryCreation) ||
      !creating.selection_token
    ) {
      return this.failLaunch(
        creating,
        'runtime_launch_configuration_unavailable',
      );
    }
    try {
      const nowMs = this.now();
      const receipt = this.options.runtimeGateway.launchTemporary
        ? this.options.runtimeGateway.launchTemporary({
            principal_ref: session.owner_principal_ref,
            selection_token: creating.selection_token,
            authorization_ref: `temporary-confirmation:${revision.revision_id}`,
            launch: {
              request_id: creating.launch_intent_id,
              creation_domain: creating.creation_domain,
              creation_key: creating.creation_key,
              effective_input_json: creating.effective_input_json,
              effective_input_hash: creating.effective_input_hash,
              attachment_manifest_json: [],
              attachment_manifest_hash: creating.attachment_manifest_hash,
              deadline_at_ms: null,
            },
            now_ms: nowMs,
            confirmed_revision_id: revision.revision_id,
            confirmed_source_json: revision.source_json,
            confirmed_source_hash: revision.source_hash,
            confirmed_plan_hash: revision.compiled_plan_hash,
            resource_closure_hash: revision.resource_closure_hash,
            policy_ceiling_hash: revision.policy_ceiling_hash,
          })
        : this.options.runtimeGateway.createTemporary({
            principal_ref: session.owner_principal_ref,
            selection_token: creating.selection_token,
            authorization_ref: `temporary-confirmation:${revision.revision_id}`,
            creation: await this.options.prepareTemporaryCreation!({
              session,
              launch: creating,
              revision,
            }),
            now_ms: nowMs,
            confirmed_revision_id: revision.revision_id,
            confirmed_source_hash: revision.source_hash,
            confirmed_plan_hash: revision.compiled_plan_hash,
            resource_closure_hash: revision.resource_closure_hash,
            policy_ceiling_hash: revision.policy_ceiling_hash,
          });
      this.linkReceipt(creating, receipt);
      creating = this.options.store.getLaunchIntent(creating.launch_intent_id);
    } catch (error) {
      creating = this.failLaunch(
        creating,
        error instanceof Error ? error.message : 'temporary_creation_failed',
      );
    }
    return creating;
  }

  cancelLaunch(input: {
    launchIntentId: string;
    principalRef: string;
    expectedRowVersion: number;
  }): TaskLaunchIntentV1 {
    const launch = this.getLaunchIntent(
      input.launchIntentId,
      input.principalRef,
    );
    return this.options.store.updateLaunchStatus({
      launchIntentId: launch.launch_intent_id,
      expectedRowVersion: input.expectedRowVersion,
      status: 'cancelled',
      nowMs: this.now(),
    });
  }

  listMessages(sessionId: string, principalRef: string) {
    this.options.store.getSession(sessionId, principalRef);
    return this.options.store.listMessages(sessionId);
  }

  async timeline(input: {
    sessionId: string;
    principalRef: string;
    afterSessionSeq: number;
  }): Promise<TaskWorkspaceTimelineDeltaV1> {
    const session = this.options.store.getSession(
      input.sessionId,
      input.principalRef,
    );
    await this.catchUpSession(session);
    const entries = this.options.store.listTimeline(
      input.sessionId,
      input.afterSessionSeq,
    );
    return {
      type: 'task_workspace_timeline_delta',
      session_id: input.sessionId,
      after_session_seq: input.afterSessionSeq,
      entries,
      next_session_seq:
        entries.length > 0
          ? entries[entries.length - 1]!.session_seq
          : input.afterSessionSeq,
      source_state: 'ready',
    };
  }

  async runtimeDetail(
    sessionId: string,
    principalRef: string,
  ): Promise<
    WorkspaceRuntimeDetail & {
      readonly pending_interactions: readonly TaskPendingInteractionV1[];
    }
  > {
    const session = this.options.store.getSession(sessionId, principalRef);
    if (!this.options.runtimeGateway) {
      return {
        format: 'icarus.workspace-runtime-detail/1',
        freshness: 'degraded',
        workflows: [],
        pending_interactions: [],
      };
    }
    await this.catchUpSession(session);
    const detail = this.options.runtimeGateway.getRuntimeDetail({
      principal_ref: principalRef,
      workflow_ids: this.options.store
        .listExecutionLinks(sessionId)
        .map((link) => link.workflow_id),
    });
    this.syncPendingInteractions(session, detail);
    return {
      ...detail,
      pending_interactions:
        this.options.store.listPendingInteractions(sessionId),
    };
  }

  submitInteraction(input: {
    principalRef: string;
    submission: TaskInteractionSubmissionV1;
  }): {
    interaction: TaskPendingInteractionV1;
    receipt: JsonObject;
  } {
    const interaction = this.options.store.getPendingInteraction(
      input.submission.interaction_id,
    );
    this.options.store.getSession(interaction.session_id, input.principalRef);
    if (
      interaction.rendered_snapshot_hash !==
        input.submission.rendered_snapshot_hash ||
      interaction.target_row_version !==
        input.submission.expected_target_row_version ||
      !Array.isArray(interaction.rendered_snapshot_json.actions) ||
      !interaction.rendered_snapshot_json.actions.some(
        (value) => asObject(value)?.action_id === input.submission.action_id,
      )
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Task interaction snapshot or target version is stale',
      );
    }
    if (interaction.status !== 'pending') {
      return {
        interaction,
        receipt: interaction.canonical_result_json ?? {
          format: 'icarus.task-interaction-result/1',
          disposition: interaction.status,
        },
      };
    }
    const requestHash = sha('interaction-submission', {
      interaction_id: input.submission.interaction_id,
      rendered_snapshot_hash: input.submission.rendered_snapshot_hash,
      action_id: input.submission.action_id,
      payload_hash: input.submission.payload_hash,
      expected_target_row_version: input.submission.expected_target_row_version,
    });
    const domain = `interaction:${interaction.interaction_id}`;
    const prior = this.options.store.findIdempotency({
      domain,
      key: input.submission.idempotency_key,
      requestHash,
    });
    if (prior) {
      return {
        interaction: this.options.store.getPendingInteraction(
          interaction.interaction_id,
        ),
        receipt: prior,
      };
    }
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Runtime interaction handler is unavailable',
        true,
      );
    }
    const runtimeReceipt = this.options.runtimeGateway.submitInteraction({
      principal_ref: input.principalRef,
      interaction_id: interaction.interaction_id,
      wait_id: interaction.target_id,
      rendered_snapshot_hash: input.submission.rendered_snapshot_hash,
      action_id: input.submission.action_id,
      payload_json: input.submission.payload_json,
      payload_hash: input.submission.payload_hash,
      expected_target_row_version: input.submission.expected_target_row_version,
      idempotency_key: input.submission.idempotency_key,
      now_ms: this.now(),
    });
    const receipt: JsonObject = {
      format: 'icarus.task-interaction-result/1',
      disposition: runtimeReceipt.disposition,
      inbox_sequence: runtimeReceipt.inboxSequence,
      event_sequence: runtimeReceipt.eventSequence,
    };
    const status =
      runtimeReceipt.disposition === 'late'
        ? 'expired'
        : runtimeReceipt.disposition;
    const resolved = this.options.store.resolvePendingInteraction({
      interactionId: interaction.interaction_id,
      status,
      canonicalResult: receipt,
      actorRef: input.principalRef,
      nowMs: this.now(),
    });
    this.options.store.putIdempotency({
      domain,
      key: input.submission.idempotency_key,
      requestHash,
      response: receipt,
      nowMs: this.now(),
    });
    this.options.runtimeEventHub.notify({
      workflow_id: interaction.workflow_id ?? undefined,
      run_id: interaction.run_id ?? undefined,
      reason: 'workspace_interaction',
    });
    return { interaction: resolved, receipt };
  }

  retryCoordinatorTurn(input: {
    sessionId: string;
    turnId: string;
    principalRef: string;
  }) {
    this.options.store.getSession(input.sessionId, input.principalRef);
    const turn = this.options.store.retryCoordinatorTurn(
      input.turnId,
      this.now(),
    );
    void this.kickCoordinator(input.sessionId);
    return turn;
  }

  rebuildTimeline(sessionId: string, principalRef: string): void {
    this.options.store.getSession(sessionId, principalRef);
    this.options.store.rebuildRuntimeTimeline(sessionId);
    void this.catchUpSession(
      this.options.store.getSession(sessionId, principalRef),
    );
  }

  createCommandProposal(input: {
    sessionId: string;
    principalRef: string;
    workflowId: string;
    runId: string;
    action: TaskRuntimeCommandAction;
    expectedTargetRowVersion: number;
    idempotencyKey: string;
  }): TaskRuntimeCommandProposalV1 {
    this.options.store.getSession(input.sessionId, input.principalRef);
    const linked = this.options.store
      .listExecutionLinks(input.sessionId)
      .some((link) => link.workflow_id === input.workflowId);
    if (!linked) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Runtime command target is not linked to this TaskSession',
      );
    }
    return this.options.store.createCommandProposal({
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      runId: input.runId,
      action: input.action,
      expectedTargetRowVersion: input.expectedTargetRowVersion,
      idempotencyKey: input.idempotencyKey,
      nowMs: this.now(),
    });
  }

  confirmCommandProposal(input: {
    proposalId: string;
    principalRef: string;
    expectedRowVersion: number;
    proposalHash: Sha256Hash;
  }): TaskRuntimeCommandProposalV1 {
    const proposal = this.options.store.getCommandProposal(input.proposalId);
    this.options.store.getSession(
      String(proposal.session_id),
      input.principalRef,
    );
    if (!this.options.runtimeGateway) {
      return this.options.store.resolveCommandProposal({
        proposalId: input.proposalId,
        expectedRowVersion: input.expectedRowVersion,
        status: 'failed',
        receipt: { code: 'runtime_command_configuration_unavailable' },
        actorRef: input.principalRef,
        nowMs: this.now(),
      });
    }
    const applying = this.options.store.beginCommandApplication({
      proposalId: proposal.proposal_id,
      expectedRowVersion: input.expectedRowVersion,
      expectedProposalHash: input.proposalHash,
      nowMs: this.now(),
    });
    return this.applyCommandProposal(applying, input.principalRef);
  }

  private applyCommandProposal(
    proposal: TaskRuntimeCommandProposalV1,
    principalRef: string,
  ): TaskRuntimeCommandProposalV1 {
    if (!this.options.runtimeGateway) {
      return this.options.store.resolveCommandProposal({
        proposalId: proposal.proposal_id,
        expectedRowVersion: proposal.row_version,
        status: 'failed',
        receipt: { code: 'runtime_command_configuration_unavailable' },
        actorRef: principalRef,
        nowMs: this.now(),
      });
    }
    try {
      const receipt = this.options.runtimeGateway.submitCommand({
        principal_ref: principalRef,
        workflow_id: proposal.workflow_id,
        run_id: proposal.run_id,
        action: proposal.action,
        expected_target_row_version: proposal.expected_target_row_version,
        idempotency_key: proposal.idempotency_key,
        operation_ref: proposal.proposal_hash,
        now_ms: this.now(),
      });
      this.options.runtimeEventHub.notify({
        workflow_id: proposal.workflow_id,
        run_id: proposal.run_id,
        reason: 'runtime_command',
      });
      return this.options.store.resolveCommandProposal({
        proposalId: proposal.proposal_id,
        expectedRowVersion: proposal.row_version,
        status:
          receipt.execution_result === 'applied' ||
          receipt.execution_result === 'duplicate'
            ? 'applied'
            : 'failed',
        receipt: receipt as unknown as JsonObject,
        actorRef: principalRef,
        nowMs: this.now(),
      });
    } catch (error) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        error instanceof Error ? error.message : 'Runtime command failed',
        true,
      );
    }
  }

  async createReplan(input: {
    sessionId: string;
    principalRef: string;
    workflowId: string;
    runId: string;
    instruction: string;
    idempotencyKey: string;
  }): Promise<JsonObject> {
    if (!input.instruction.trim() || input.instruction.length > 100_000) {
      throw new TaskWorkspaceServiceError(
        'invalid_request',
        'Temporary Replan instruction is invalid',
      );
    }
    const prior = this.options.store.findReplanRequestByIdempotencyKey(
      input.idempotencyKey,
    );
    if (prior) {
      this.options.store.getSession(
        String(prior.session_id),
        input.principalRef,
      );
      const priorProposal = asObject(prior.proposal);
      if (
        prior.session_id !== input.sessionId ||
        prior.source_workflow_id !== input.workflowId ||
        prior.source_run_id !== input.runId ||
        priorProposal?.instruction !== input.instruction ||
        priorProposal.instruction_hash !==
          sha('replan-instruction', input.instruction)
      ) {
        throw new TaskWorkspaceServiceError(
          'conflict',
          'Replan idempotency key is bound to a different instruction or source',
        );
      }
      return prior;
    }
    const session = this.options.store.getSession(
      input.sessionId,
      input.principalRef,
    );
    const link = this.options.store
      .listExecutionLinks(input.sessionId)
      .find((candidate) => candidate.workflow_id === input.workflowId);
    if (!link) {
      throw new TaskWorkspaceServiceError(
        'not_found',
        'Source Workflow is not linked to this Task Session',
      );
    }
    const launch = this.options.store.getLaunchIntent(link.launch_intent_id);
    if (launch.mode !== 'temporary_workflow') {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Generic Replan is available only for Temporary Workflow runs',
      );
    }
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Temporary Replan Runtime preparation is unavailable',
        true,
      );
    }
    const detail = await this.runtimeDetail(
      input.sessionId,
      input.principalRef,
    );
    const workflow = detail.workflows.find(
      (candidate) => candidate.id === input.workflowId,
    );
    if (
      !workflow ||
      workflow.recipe_id !== 'ad_hoc_personal_task' ||
      !Array.isArray(workflow.runs)
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Generic Replan is available only for Temporary Workflow runs',
      );
    }
    const run = workflow.runs
      .map(asObject)
      .find((candidate) => candidate?.id === input.runId);
    if (
      !run ||
      typeof run.activation_id !== 'string' ||
      workflow.current_graph_run_id !== input.runId
    ) {
      throw new TaskWorkspaceServiceError('not_found', 'Source Run not found');
    }
    const agentJid = this.options.coordinatorAgentJid();
    if (!this.options.coordinator || !agentJid) {
      throw new TaskWorkspaceServiceError(
        'coordinator_unavailable',
        'Temporary Replan requires the Task Workspace Coordinator',
        true,
      );
    }
    const response = await this.options.coordinator.chat({
      chat_jid: agentJid,
      session_id: session.coordinator_agent_session_id ?? undefined,
      message: input.instruction,
      system:
        'Create a replacement Dynamic Child graph source for the requested Temporary Replan. Return exactly one JSON object containing source_json. Do not compile, fence, mutate Runtime, or claim the Replan was applied.',
      metadata: {
        trace_id: input.idempotencyKey,
        task_session_id: input.sessionId,
        source_workflow_id: input.workflowId,
        source_run_id: input.runId,
        purpose: 'temporary_workflow_replan',
      },
    });
    if (!response.ok) {
      throw new TaskWorkspaceServiceError(
        'coordinator_unavailable',
        response.error || 'Temporary Replan planning failed',
        true,
      );
    }
    const source = temporaryReplanSourceFromCoordinator(response.text);
    if (!source) {
      throw new TaskWorkspaceServiceError(
        'temporary_draft_invalid',
        'Coordinator did not return a valid Temporary Replan graph source',
      );
    }
    const preparation = this.options.runtimeGateway.prepareTemporaryReplan({
      principal_ref: input.principalRef,
      source_workflow_id: input.workflowId,
      source_activation_id: run.activation_id,
      source_run_id: input.runId,
      source_json: source,
      idempotency_key: input.idempotencyKey,
      now_ms: this.now(),
    });
    const authority = preparation.source_authority;
    const expectedConfirmationHash =
      calculateWorkspaceTemporaryReplanConfirmationHash({
        principal_ref: input.principalRef,
        source_workflow_id: input.workflowId,
        source_activation_id: run.activation_id,
        source_run_id: input.runId,
        replan_creation_key: preparation.replan_creation_key,
        proposal_hash: preparation.proposal_hash,
        confirmation_ref: preparation.confirmation_ref,
      });
    if (
      authority.workflow_id !== input.workflowId ||
      authority.activation_id !== run.activation_id ||
      authority.run_id !== input.runId ||
      preparation.confirmation_hash !== expectedConfirmationHash
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Runtime Replan preparation lineage or confirmation identity drifted',
      );
    }
    return this.options.store.createReplanRequest({
      sessionId: input.sessionId,
      sourceWorkflowId: input.workflowId,
      sourceActivationId: run.activation_id,
      sourceRunId: input.runId,
      sourceFrontier: preparation.source_frontier_json,
      sourceFrontierHash: authority.frontier_hash,
      proposal: {
        format: 'icarus.task-workspace-temporary-replan-proposal/1',
        instruction: input.instruction,
        instruction_hash: sha('replan-instruction', input.instruction),
        preparation,
      },
      proposalHash: preparation.proposal_hash,
      idempotencyKey: input.idempotencyKey,
      nowMs: this.now(),
    });
  }

  listReplans(sessionId: string, principalRef: string): JsonObject[] {
    this.options.store.getSession(sessionId, principalRef);
    return this.options.store.listReplanRequests(sessionId);
  }

  confirmReplan(input: {
    replanId: string;
    principalRef: string;
    expectedRowVersion: number;
    proposalHash: Sha256Hash;
  }): JsonObject {
    const replan = this.options.store.getReplanRequest(input.replanId);
    this.options.store.getSession(
      String(replan.session_id),
      input.principalRef,
    );
    if (replan.proposal_hash !== input.proposalHash) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Temporary Replan proposal hash is stale',
      );
    }
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Temporary Replan Runtime application is unavailable',
        true,
      );
    }
    const preparation = storedReplanPreparation(replan);
    const applying = this.options.store.beginReplanApplication({
      replanId: input.replanId,
      expectedRowVersion: input.expectedRowVersion,
      expectedProposalHash: input.proposalHash,
      confirmationRef: preparation.confirmation_ref,
      confirmationHash: preparation.confirmation_hash,
      nowMs: this.now(),
    });
    if (applying.status !== 'applying') return applying;
    let receipt: WorkspaceReplanReceipt;
    try {
      receipt = this.options.runtimeGateway.applyTemporaryReplan({
        principal_ref: input.principalRef,
        preparation,
        confirmation_ref: preparation.confirmation_ref,
        confirmation_hash: preparation.confirmation_hash,
        now_ms: this.now(),
      });
    } catch (error) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        error instanceof Error
          ? error.message
          : 'Temporary Replan apply failed',
        true,
      );
    }
    return this.persistReplanReceipt(applying, preparation, receipt);
  }

  cancelReplan(input: {
    replanId: string;
    principalRef: string;
    expectedRowVersion: number;
  }): JsonObject {
    const replan = this.options.store.getReplanRequest(input.replanId);
    this.options.store.getSession(
      String(replan.session_id),
      input.principalRef,
    );
    return this.options.store.cancelReplanRequest({
      replanId: input.replanId,
      expectedRowVersion: input.expectedRowVersion,
      expectedProposalHash: replan.proposal_hash as Sha256Hash,
      nowMs: this.now(),
    });
  }

  private persistReplanReceipt(
    replan: JsonObject,
    preparation: WorkspaceTemporaryReplanPreparation,
    receipt: WorkspaceReplanReceipt,
  ): JsonObject {
    const authority = preparation.source_authority;
    if (
      receipt.source_workflow_id !== replan.source_workflow_id ||
      receipt.source_activation_id !== replan.source_activation_id ||
      receipt.source_run_id !== replan.source_run_id ||
      receipt.replan_creation_key !== preparation.replan_creation_key ||
      receipt.proposal_hash !== replan.proposal_hash ||
      receipt.confirmation_ref !== preparation.confirmation_ref ||
      receipt.confirmation_hash !== preparation.confirmation_hash ||
      authority.workflow_id !== replan.source_workflow_id ||
      authority.activation_id !== replan.source_activation_id ||
      authority.run_id !== replan.source_run_id
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Runtime Replan receipt lineage does not match the durable preparation',
      );
    }
    const progressed = this.options.store.updateReplanApplication({
      replanId: String(replan.replan_id),
      expectedRowVersion: Number(replan.row_version),
      expectedProposalHash: replan.proposal_hash as Sha256Hash,
      expectedConfirmationRef: preparation.confirmation_ref,
      expectedConfirmationHash: preparation.confirmation_hash,
      sourceActivationId: receipt.source_activation_id,
      sourceFenceReceipt: receipt.source_fence_receipt,
      targetActivationId: receipt.target_activation_id,
      targetRunId: receipt.target_run_id,
      canonicalReceipt: receipt,
      lastErrorCode: receipt.disposition === 'denied' ? receipt.code : null,
      nowMs: this.now(),
    });
    const targetAvailable =
      receipt.target_activation_id !== null && receipt.target_run_id !== null;
    if (
      receipt.disposition === 'applied' ||
      (receipt.disposition === 'duplicate' && targetAvailable)
    ) {
      const resolved = this.options.store.resolveReplanApplication({
        replanId: String(replan.replan_id),
        expectedRowVersion: Number(progressed.row_version),
        expectedProposalHash: replan.proposal_hash as Sha256Hash,
        expectedConfirmationRef: preparation.confirmation_ref,
        expectedConfirmationHash: preparation.confirmation_hash,
        status: 'applied',
        canonicalReceipt: receipt,
        nowMs: this.now(),
      });
      this.options.runtimeEventHub.notify({
        workflow_id: String(replan.source_workflow_id),
        run_id: receipt.target_run_id ?? undefined,
        reason: 'temporary_replan',
      });
      return resolved;
    }
    if (receipt.disposition === 'denied') {
      return this.options.store.resolveReplanApplication({
        replanId: String(replan.replan_id),
        expectedRowVersion: Number(progressed.row_version),
        expectedProposalHash: replan.proposal_hash as Sha256Hash,
        expectedConfirmationRef: preparation.confirmation_ref,
        expectedConfirmationHash: preparation.confirmation_hash,
        status: 'failed',
        canonicalReceipt: receipt,
        lastErrorCode: receipt.code,
        nowMs: this.now(),
      });
    }
    return progressed;
  }

  async createPersonalWorkflowDraft(input: {
    sessionId: string;
    principalRef: string;
    workflowId: string;
    runId: string;
  }): Promise<JsonObject> {
    this.options.store.getSession(input.sessionId, input.principalRef);
    const linked = this.options.store
      .listExecutionLinks(input.sessionId)
      .some((link) => link.workflow_id === input.workflowId);
    if (!linked || !this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        linked ? 'runtime_unavailable' : 'conflict',
        linked
          ? 'Personal Workflow extraction is unavailable'
          : 'Personal Workflow source is not linked to this TaskSession',
        linked,
      );
    }
    const extracted = this.options.runtimeGateway.extractPersonalWorkflowDraft({
      principal_ref: input.principalRef,
      workflow_id: input.workflowId,
      run_id: input.runId,
    });
    const source = sanitizePersonalWorkflowSource(extracted.source_json);
    const compiled = this.options.runtimeGateway.preparePersonalWorkflowDraft({
      principal_ref: input.principalRef,
      source_workflow_id: input.workflowId,
      source_run_id: input.runId,
      source_json: source,
    });
    return this.options.store.createPersonalWorkflowDraft({
      ownerPrincipalRef: input.principalRef,
      sourceSessionId: input.sessionId,
      sourceWorkflowId: input.workflowId,
      sourceRunId: input.runId,
      source,
      sourceHash: compiled.source_hash,
      compiledPlan: compiled.compiled_plan_json,
      compiledPlanHash: compiled.compiled_plan_hash,
      compilerVersion: compiled.compiler_version,
      resourceClosureHash: compiled.resource_closure_hash,
      policyCeilingHash: compiled.policy_ceiling_hash,
      riskSummary: compiled.risk_summary_json,
      nowMs: this.now(),
    });
  }

  listPersonalWorkflows(principalRef: string): JsonObject[] {
    return this.options.runtimeGateway
      ? this.options.runtimeGateway.listPersonalWorkflowReleases(principalRef)
      : [];
  }

  getPersonalWorkflowDraft(draftId: string, principalRef: string): JsonObject {
    return this.options.store.getPersonalWorkflowDraft(draftId, principalRef);
  }

  advancePersonalWorkflow(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    action: 'validate' | 'dry-run' | 'review' | 'publish';
    review?: JsonObject | null;
    idempotencyKey?: string | null;
  }): JsonObject {
    const draft = this.options.store.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Personal Workflow Runtime gateway is unavailable',
        true,
      );
    }
    if (input.action === 'publish') {
      if (!input.idempotencyKey) {
        throw new TaskWorkspaceServiceError(
          'invalid_request',
          'Personal Workflow publish requires an idempotency key',
        );
      }
      const applying = this.options.store.beginPersonalWorkflowOperation({
        draftId: input.draftId,
        principalRef: input.principalRef,
        expectedRowVersion: input.expectedRowVersion,
        operation: 'publish',
        idempotencyKey: input.idempotencyKey,
        nowMs: this.now(),
      });
      return this.applyPersonalWorkflowPublication(applying);
    }
    if (input.action === 'review') {
      if (
        input.review?.approved !== true ||
        typeof input.review.display_name !== 'string' ||
        !input.review.display_name.trim()
      ) {
        throw new TaskWorkspaceServiceError(
          'invalid_request',
          'Personal Workflow review must explicitly approve a display name',
        );
      }
      return this.options.store.advancePersonalWorkflowDraft({
        draftId: input.draftId,
        principalRef: input.principalRef,
        expectedRowVersion: input.expectedRowVersion,
        status: 'reviewed',
        review: input.review,
        nowMs: this.now(),
      });
    }
    const compiled = this.options.runtimeGateway.preparePersonalWorkflowDraft({
      principal_ref: input.principalRef,
      source_workflow_id: String(draft.source_workflow_id),
      source_run_id: String(draft.source_run_id),
      source_json: draft.source as JsonObject,
    });
    if (
      compiled.source_hash !== draft.source_hash ||
      compiled.compiled_plan_hash !== draft.compiled_plan_hash
    ) {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Personal Workflow draft no longer matches its compiled review revision',
      );
    }
    return this.options.store.advancePersonalWorkflowDraft({
      draftId: input.draftId,
      principalRef: input.principalRef,
      expectedRowVersion: input.expectedRowVersion,
      status: input.action === 'validate' ? 'validated' : 'dry_run_passed',
      nowMs: this.now(),
    });
  }

  revisePersonalWorkflow(input: {
    draftId: string;
    principalRef: string;
    expectedRowVersion: number;
    source: JsonObject;
  }): JsonObject {
    const draft = this.options.store.getPersonalWorkflowDraft(
      input.draftId,
      input.principalRef,
    );
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Personal Workflow compiler is unavailable',
        true,
      );
    }
    const source = sanitizePersonalWorkflowSource(input.source);
    const compiled = this.options.runtimeGateway.preparePersonalWorkflowDraft({
      principal_ref: input.principalRef,
      source_workflow_id: String(draft.source_workflow_id),
      source_run_id: String(draft.source_run_id),
      source_json: source,
    });
    return this.options.store.revisePersonalWorkflowDraft({
      draftId: input.draftId,
      principalRef: input.principalRef,
      expectedRowVersion: input.expectedRowVersion,
      source,
      sourceHash: compiled.source_hash,
      compiledPlan: compiled.compiled_plan_json,
      compiledPlanHash: compiled.compiled_plan_hash,
      compilerVersion: compiled.compiler_version,
      resourceClosureHash: compiled.resource_closure_hash,
      policyCeilingHash: compiled.policy_ceiling_hash,
      riskSummary: compiled.risk_summary_json,
      nowMs: this.now(),
    });
  }

  activatePersonalWorkflow(input: {
    releaseId: string;
    principalRef: string;
    expectedPointerRowVersion: number | null;
    idempotencyKey: string;
  }): JsonObject {
    const draft = this.options.store.getPersonalWorkflowDraftByRelease(
      input.releaseId,
      input.principalRef,
    );
    const applying = this.options.store.beginPersonalWorkflowOperation({
      draftId: String(draft.draft_id),
      principalRef: input.principalRef,
      expectedRowVersion: Number(draft.row_version),
      operation: 'activate',
      idempotencyKey: input.idempotencyKey,
      nowMs: this.now(),
    });
    return this.applyPersonalWorkflowActivation(
      applying,
      input.expectedPointerRowVersion,
    );
  }

  private applyPersonalWorkflowPublication(draft: JsonObject): JsonObject {
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Personal Workflow publisher is unavailable',
        true,
      );
    }
    const review = asObject(draft.review);
    if (!review || typeof review.display_name !== 'string') {
      throw new TaskWorkspaceServiceError(
        'conflict',
        'Personal Workflow publication requires its reviewed metadata',
      );
    }
    const revision = draft.revision as JsonObject;
    const operationKey = String(draft.pending_operation_key);
    const receipt = this.options.runtimeGateway.publishPersonalWorkflowRelease({
      principal_ref: String(draft.owner_principal_ref),
      personal_workflow_id: String(draft.personal_workflow_id),
      release_ref: {
        id: `${String(draft.personal_workflow_id)}.release`,
        version: `1.0.${String(revision.revision_no)}`,
      },
      display_name: review.display_name.trim(),
      description:
        typeof review.description === 'string' ? review.description : null,
      source_workflow_id: String(draft.source_workflow_id),
      source_run_id: String(draft.source_run_id),
      source_json: draft.source as JsonObject,
      expected_source_hash: draft.source_hash as Sha256Hash,
      expected_plan_hash: draft.compiled_plan_hash as Sha256Hash,
      idempotency_key: operationKey,
      now_ms: this.now(),
    });
    return this.options.store.resolvePersonalWorkflowPublication({
      draftId: String(draft.draft_id),
      principalRef: String(draft.owner_principal_ref),
      expectedRowVersion: Number(draft.row_version),
      expectedOperationKey: operationKey,
      releaseId: receipt.release_id,
      releaseHash: receipt.release_hash,
      nowMs: this.now(),
    });
  }

  private applyPersonalWorkflowActivation(
    draft: JsonObject,
    expectedPointerRowVersion: number | null,
  ): JsonObject {
    if (!this.options.runtimeGateway) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Personal Workflow activation is unavailable',
        true,
      );
    }
    const operationKey = String(draft.pending_operation_key);
    const receipt = this.options.runtimeGateway.activatePersonalWorkflowRelease(
      {
        principal_ref: String(draft.owner_principal_ref),
        personal_workflow_id: String(draft.personal_workflow_id),
        release_id: String(draft.release_id),
        release_hash: draft.release_hash as Sha256Hash,
        expected_pointer_row_version: expectedPointerRowVersion,
        idempotency_key: operationKey,
        now_ms: this.now(),
      },
    );
    return this.options.store.resolvePersonalWorkflowActivation({
      draftId: String(draft.draft_id),
      principalRef: String(draft.owner_principal_ref),
      expectedRowVersion: Number(draft.row_version),
      expectedOperationKey: operationKey,
      pointerRowVersion: receipt.pointer_row_version,
      nowMs: this.now(),
    });
  }

  private async recover(): Promise<void> {
    for (const proposal of this.options.store.listApplyingCommandProposals()) {
      const session = this.options.store.getSession(proposal.session_id);
      try {
        this.applyCommandProposal(proposal, session.owner_principal_ref);
      } catch {
        // The applying marker remains durable; the next Host start retries it.
      }
    }
    for (const draft of this.options.store.listPendingPersonalWorkflowOperations()) {
      try {
        if (draft.status === 'publishing') {
          this.applyPersonalWorkflowPublication(draft);
        } else {
          this.applyPersonalWorkflowActivation(
            draft,
            draft.pointer_row_version === null
              ? null
              : Number(draft.pointer_row_version),
          );
        }
      } catch {
        // Stable operation keys make another startup retry safe after response loss.
      }
    }
    this.recoverApplyingReplans();
    const sessions = this.options.store.listSessions('human:local-owner');
    for (const session of sessions) {
      await this.reconcileCreating(session);
      await this.catchUpSession(session);
      void this.kickCoordinator(session.session_id);
    }
  }

  private recoverApplyingReplans(workflowId?: string): void {
    if (!this.options.runtimeGateway) return;
    for (const replan of this.options.store.listApplyingReplans()) {
      if (workflowId && replan.source_workflow_id !== workflowId) continue;
      if (
        typeof replan.source_activation_id !== 'string' ||
        typeof replan.confirmation_ref !== 'string' ||
        typeof replan.confirmation_hash !== 'string'
      ) {
        continue;
      }
      try {
        const session = this.options.store.getSession(
          String(replan.session_id),
        );
        const preparation = storedReplanPreparation(replan);
        let receipt = this.options.runtimeGateway.reconcileTemporaryReplan({
          principal_ref: session.owner_principal_ref,
          source_workflow_id: String(replan.source_workflow_id),
          source_activation_id: replan.source_activation_id,
          source_run_id: String(replan.source_run_id),
          replan_creation_key: preparation.replan_creation_key,
          proposal_hash: replan.proposal_hash as Sha256Hash,
          confirmation_ref: replan.confirmation_ref,
          confirmation_hash: replan.confirmation_hash as Sha256Hash,
        });
        if (
          receipt.disposition === 'denied' &&
          receipt.code === 'replan_not_submitted'
        ) {
          receipt = this.options.runtimeGateway.applyTemporaryReplan({
            principal_ref: session.owner_principal_ref,
            preparation,
            confirmation_ref: preparation.confirmation_ref,
            confirmation_hash: preparation.confirmation_hash,
            now_ms: this.now(),
          });
        }
        this.persistReplanReceipt(replan, preparation, receipt);
      } catch {
        // The applying record is the durable retry anchor for the next wake/poll.
      }
    }
  }

  private async createPublished(
    session: TaskSessionV1,
    launch: TaskLaunchIntentV1,
  ): Promise<void> {
    if (
      !this.options.runtimeGateway ||
      (!this.options.runtimeGateway.launchPublished &&
        !this.options.preparePublishedCreation) ||
      !launch.selection_token
    ) {
      this.failLaunch(launch, 'runtime_launch_configuration_unavailable');
      return;
    }
    try {
      const nowMs = this.now();
      const receipt = this.options.runtimeGateway.launchPublished
        ? this.options.runtimeGateway.launchPublished({
            principal_ref: session.owner_principal_ref,
            selection_token: launch.selection_token,
            authorization_ref: `workspace-run:${launch.launch_intent_id}`,
            launch: {
              request_id: launch.launch_intent_id,
              creation_domain: launch.creation_domain,
              creation_key: launch.creation_key,
              effective_input_json: launch.effective_input_json,
              effective_input_hash: launch.effective_input_hash,
              attachment_manifest_json: [],
              attachment_manifest_hash: launch.attachment_manifest_hash,
              deadline_at_ms: null,
            },
            now_ms: nowMs,
          })
        : this.options.runtimeGateway.createPublished({
            principal_ref: session.owner_principal_ref,
            selection_token: launch.selection_token,
            authorization_ref: `workspace-run:${launch.launch_intent_id}`,
            creation: await this.options.preparePublishedCreation!({
              session,
              launch,
            }),
            now_ms: nowMs,
          });
      this.linkReceipt(launch, receipt);
    } catch (error) {
      this.failLaunch(
        this.options.store.getLaunchIntent(launch.launch_intent_id),
        error instanceof Error ? error.message : 'published_creation_failed',
      );
    }
  }

  private linkReceipt(
    launch: TaskLaunchIntentV1,
    receipt: {
      workflowId: string;
      intakeId: string;
      creationRequestId: string;
    },
  ): void {
    this.options.store.addExecutionLink({
      session_id: launch.session_id,
      workflow_id: receipt.workflowId,
      intake_id: receipt.intakeId,
      creation_request_id: receipt.creationRequestId,
      launch_intent_id: launch.launch_intent_id,
      created_at_ms: this.now(),
    });
    const linked = this.options.store.updateLaunchStatus({
      launchIntentId: launch.launch_intent_id,
      expectedRowVersion: this.options.store.getLaunchIntent(
        launch.launch_intent_id,
      ).row_version,
      status: 'linked',
      nowMs: this.now(),
    });
    const entries = this.options.store.listTimeline(launch.session_id, 0);
    this.emitEntries(
      launch.session_id,
      entries.filter(
        (entry) =>
          entry.source_id.startsWith(launch.launch_intent_id) &&
          entry.payload_json.status === linked.status,
      ),
    );
    this.options.runtimeEventHub.notify({
      workflow_id: receipt.workflowId,
      reason: 'workspace_creation',
    });
  }

  private failLaunch(
    launch: TaskLaunchIntentV1,
    code: string,
  ): TaskLaunchIntentV1 {
    try {
      return this.options.store.updateLaunchStatus({
        launchIntentId: launch.launch_intent_id,
        expectedRowVersion: launch.row_version,
        status: 'failed',
        errorCode: code.slice(0, 500),
        nowMs: this.now(),
      });
    } catch (error) {
      if (
        error instanceof TaskWorkspaceStoreError &&
        error.code === 'conflict'
      ) {
        return this.options.store.getLaunchIntent(launch.launch_intent_id);
      }
      throw error;
    }
  }

  private async planTemporary(
    session: TaskSessionV1,
    launch: TaskLaunchIntentV1,
    instruction: string,
  ): Promise<TemporaryWorkflowDraftRevisionV1> {
    const agentJid = this.options.coordinatorAgentJid();
    let responseText = '';
    if (this.options.coordinator && agentJid) {
      const response = await this.options.coordinator.chat({
        chat_jid: agentJid,
        session_id: session.coordinator_agent_session_id ?? undefined,
        message: instruction,
        system:
          'Create or revise a Temporary Workflow draft. Return one JSON object with a graph_scope source and risk_summary. The source must use only the published Temporary Workflow envelope. Do not compile it and do not claim that Runtime execution has started.',
        metadata: {
          trace_id: launch.launch_intent_id,
          task_session_id: session.session_id,
          purpose: 'temporary_workflow_draft',
        },
      });
      if (response.ok) responseText = response.text;
    }
    const draft = draftFromCoordinator(responseText, instruction);
    if (!this.options.runtimeGateway || !launch.selection_token) {
      throw new TaskWorkspaceServiceError(
        'runtime_unavailable',
        'Temporary Workflow compiler is unavailable',
        true,
      );
    }
    const compiled = this.options.runtimeGateway.prepareTemporaryDraft({
      principal_ref: session.owner_principal_ref,
      selection_token: launch.selection_token,
      source_json: draft.source,
      now_ms: this.now(),
    });
    return this.options.store.createTemporaryRevision({
      launchIntentId: launch.launch_intent_id,
      sourceMessageId: launch.source_message_id,
      source: draft.source,
      sourceHash: compiled.source_hash,
      compiledPlan: compiled.compiled_plan_json,
      compiledPlanHash: compiled.compiled_plan_hash,
      compilerVersion: compiled.compiler_version,
      resourceClosureHash: compiled.resource_closure_hash,
      policyCeilingHash: compiled.policy_ceiling_hash,
      riskSummary: {
        ...compiled.risk_summary_json,
        coordinator_notes: draft.risk,
      },
      nowMs: this.now(),
    });
  }

  private kickCoordinator(sessionId: string): Promise<void> {
    const existing = this.activeTurns.get(sessionId);
    if (existing) return existing;
    const running = this.runCoordinatorQueue(sessionId).finally(() => {
      this.activeTurns.delete(sessionId);
    });
    this.activeTurns.set(sessionId, running);
    return running;
  }

  private async runCoordinatorQueue(sessionId: string): Promise<void> {
    if (this.stopping) return;
    const agentJid = this.options.coordinatorAgentJid();
    if (!this.options.coordinator || !agentJid) return;
    while (!this.stopping) {
      const turn = this.options.store.claimNextCoordinatorTurn(
        sessionId,
        this.now(),
      );
      if (!turn) return;
      const session = this.options.store.getSession(sessionId);
      const source = this.options.store
        .listMessages(sessionId)
        .find((message) => message.message_id === turn.source_message_id);
      if (!source?.body_text) {
        this.options.store.finishCoordinatorTurn({
          turnId: turn.turn_id,
          status: 'failed',
          queryId: null,
          errorCode: 'source_message_unavailable',
          nowMs: this.now(),
        });
        continue;
      }
      try {
        const response = await this.options.coordinator.chat({
          chat_jid: agentJid,
          session_id: session.coordinator_agent_session_id ?? undefined,
          message: source.body_text,
          system:
            'You are the Task Workspace Coordinator. Clarify requirements and explain authoritative Runtime information. Never start a Published Workflow from text and never claim a Runtime mutation succeeded without a canonical receipt.',
          metadata: {
            trace_id: turn.turn_id,
            task_session_id: sessionId,
            source_message_id: source.message_id,
          },
        });
        if (!response.ok) {
          this.options.store.finishCoordinatorTurn({
            turnId: turn.turn_id,
            status: 'failed',
            queryId: response.query_id,
            errorCode: response.error,
            agentSessionId: response.session_id,
            nowMs: this.now(),
          });
          continue;
        }
        const appended = this.options.store.appendMessage({
          sessionId,
          role: 'coordinator',
          bodyText: response.text,
          causationRef: source.message_id,
          queryId: response.query_id,
          nowMs: this.now(),
        });
        this.options.store.finishCoordinatorTurn({
          turnId: turn.turn_id,
          status: 'completed',
          queryId: response.query_id,
          agentSessionId: response.session_id,
          nowMs: this.now(),
        });
        this.emitEntries(sessionId, [appended.timeline]);
      } catch (error) {
        this.options.store.finishCoordinatorTurn({
          turnId: turn.turn_id,
          status: 'failed',
          queryId: null,
          errorCode:
            error instanceof Error ? error.message : 'coordinator_failed',
          nowMs: this.now(),
        });
      }
    }
  }

  private async reconcileCreating(session: TaskSessionV1): Promise<void> {
    if (!this.options.runtimeGateway) return;
    for (const launch of this.options.store
      .listCreatingLaunchIntents()
      .filter((candidate) => candidate.session_id === session.session_id)) {
      try {
        const found = this.options.runtimeGateway.findCreation({
          creation_domain: launch.creation_domain,
          creation_key: launch.creation_key,
          principal_ref: session.owner_principal_ref,
        });
        if (
          found.found &&
          found.workflow_id &&
          found.intake_id &&
          found.creation_request_id
        ) {
          this.linkReceipt(launch, {
            workflowId: found.workflow_id,
            intakeId: found.intake_id,
            creationRequestId: found.creation_request_id,
          });
        }
      } catch {
        // Durable LaunchIntent remains creating; next open/poll retries lookup.
      }
    }
  }

  private async handleRuntimeHint(hint: RuntimeEventHint): Promise<void> {
    for (const session of this.options.store.listSessions(
      'human:local-owner',
    )) {
      if (
        !hint.workflow_id ||
        this.options.store
          .listExecutionLinks(session.session_id)
          .some((link) => link.workflow_id === hint.workflow_id)
      ) {
        await this.catchUpSession(session, hint);
      }
    }
    this.recoverApplyingReplans(hint.workflow_id);
  }

  private async catchUpAll(): Promise<void> {
    for (const session of this.options.store.listSessions(
      'human:local-owner',
    )) {
      await this.catchUpSession(session);
    }
    this.recoverApplyingReplans();
  }

  private async catchUpSession(
    session: TaskSessionV1,
    hint?: RuntimeEventHint,
  ): Promise<void> {
    if (!this.options.runtimeGateway) return;
    const links = this.options.store
      .listExecutionLinks(session.session_id)
      .filter(
        (link) => !hint?.workflow_id || link.workflow_id === hint.workflow_id,
      );
    if (links.length === 0) return;
    const detail = this.options.runtimeGateway.getRuntimeDetail({
      principal_ref: session.owner_principal_ref,
      workflow_ids: links.map((link) => link.workflow_id),
    });
    this.syncPendingInteractions(session, detail);
    for (const workflow of detail.workflows) {
      if (!Array.isArray(workflow.runs)) continue;
      for (const value of workflow.runs) {
        const run = asObject(value);
        if (!run || typeof run.id !== 'string') continue;
        const workflowId = String(workflow.id);
        let cursor = this.options.store.getRuntimeCursor(
          session.session_id,
          workflowId,
          run.id,
        );
        let hasMore = true;
        let pages = 0;
        while (hasMore && pages < 8) {
          pages += 1;
          const page = this.options.runtimeGateway.listRuntimeEvents({
            principal_ref: session.owner_principal_ref,
            workflow_id: workflowId,
            run_id: run.id,
            after_event_seq: cursor,
            limit: 200,
          });
          const entries = this.options.store.appendRuntimeEvents({
            sessionId: session.session_id,
            workflowId,
            runId: run.id,
            expectedAfterEventSeq: cursor,
            events: page.events,
            nextEventSeq: page.next_event_seq,
            sourceState: page.has_more ? 'catching_up' : 'ready',
            nowMs: this.now(),
          });
          if (entries.length > 0) this.emitEntries(session.session_id, entries);
          cursor = page.next_event_seq;
          hasMore = page.has_more;
        }
      }
    }
  }

  private syncPendingInteractions(
    session: TaskSessionV1,
    detail: WorkspaceRuntimeDetail,
  ): void {
    for (const workflow of detail.workflows) {
      if (typeof workflow.id !== 'string' || !Array.isArray(workflow.pending)) {
        continue;
      }
      const authoritativeWaitIds = new Set<string>();
      for (const value of workflow.pending) {
        const wait = asObject(value);
        if (
          !wait ||
          typeof wait.id !== 'string' ||
          typeof wait.graph_run_id !== 'string' ||
          typeof wait.node_id !== 'string' ||
          (wait.wait_type !== 'signal' && wait.wait_type !== 'approval') ||
          !Number.isSafeInteger(wait.row_version)
        ) {
          continue;
        }
        authoritativeWaitIds.add(wait.id);
        const interactionId = `interaction:${sha('runtime-wait-interaction', {
          session_id: session.session_id,
          workflow_id: workflow.id,
          run_id: wait.graph_run_id,
          wait_id: wait.id,
        })}`;
        const snapshot: JsonObject = {
          format: 'icarus.task-interaction-rendered-snapshot/1',
          interaction_id: interactionId,
          interaction_kind: 'runtime_wait',
          workflow_id: workflow.id,
          run_id: wait.graph_run_id,
          wait_id: wait.id,
          node_id: wait.node_id,
          wait_type: wait.wait_type,
          deadline_at_ms: wait.deadline_at_ms ?? null,
          actions: [
            {
              action_id: 'submit',
              label:
                wait.wait_type === 'approval' ? 'Submit decision' : 'Submit',
            },
          ],
        };
        this.options.store.upsertPendingInteraction({
          interactionId,
          sessionId: session.session_id,
          workflowId: workflow.id,
          runId: wait.graph_run_id,
          waitId: wait.id,
          renderedSnapshot: snapshot,
          renderedSnapshotHash: sha('interaction-rendered-snapshot', snapshot),
          targetRowVersion: Number(wait.row_version),
          nowMs: this.now(),
        });
      }
      if (workflow.availability === 'available') {
        this.options.store.expireMissingPendingInteractions({
          sessionId: session.session_id,
          workflowId: workflow.id,
          authoritativeWaitIds,
          nowMs: this.now(),
        });
      }
    }
  }

  private emitEntries(
    sessionId: string,
    entries: readonly TaskTimelineEntryV1[],
  ): void {
    if (entries.length === 0) return;
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    this.options.onTimelineDelta?.({
      type: 'task_workspace_timeline_delta',
      session_id: sessionId,
      after_session_seq: first.session_seq - 1,
      entries,
      next_session_seq: last.session_seq,
      source_state: 'ready',
    });
  }
}
