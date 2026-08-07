import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../workflow-runtime/contracts/types.js';

export type TaskSessionStatus = 'open' | 'completed' | 'cancelled' | 'archived';
export type TaskAttentionState =
  | 'none'
  | 'waiting_user'
  | 'action_required'
  | 'failed';

export type TaskRunSelection =
  | { readonly kind: 'temporary_workflow' }
  | {
      readonly kind: 'published_recipe';
      readonly recipe_ref: VersionedRef;
      readonly recipe_hash: Sha256Hash;
      readonly recipe_kind: 'core' | 'feature' | 'personal';
    };

export interface TaskSessionV1 {
  readonly format: 'icarus.task-session/1';
  readonly session_id: string;
  readonly owner_principal_ref: string;
  readonly title: string;
  readonly status: TaskSessionStatus;
  readonly attention_state: TaskAttentionState;
  readonly primary_thread_id: string;
  readonly coordinator_agent_session_id: string | null;
  readonly current_run_selection: TaskRunSelection;
  readonly source:
    | 'task_workspace'
    | 'global_assistant'
    | 'runtime_deep_link'
    | 'api';
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly row_version: number;
}

export type TaskMessageRole = 'human' | 'coordinator' | 'system';

export interface TaskConversationMessageV1 {
  readonly format: 'icarus.task-conversation-message/1';
  readonly message_id: string;
  readonly session_id: string;
  readonly thread_id: string;
  readonly message_seq: number;
  readonly role: TaskMessageRole;
  readonly body_json: JsonValue | null;
  readonly body_text: string | null;
  readonly body_hash: Sha256Hash;
  readonly reply_to_message_id: string | null;
  readonly causation_ref: string | null;
  readonly query_id: string | null;
  readonly created_at_ms: number;
}

export type TaskTimelineEntryKind =
  | 'human_message'
  | 'coordinator_message'
  | 'launch_status'
  | 'workflow_progress'
  | 'node_progress'
  | 'pending_interaction'
  | 'command_result'
  | 'artifact_published'
  | 'workflow_completed'
  | 'system_notice';

export interface TaskTimelineEntryV1 {
  readonly entry_id: string;
  readonly session_id: string;
  readonly session_seq: number;
  readonly kind: TaskTimelineEntryKind;
  readonly source_kind: 'workspace' | 'runtime';
  readonly source_id: string;
  readonly source_event_seq: number | null;
  readonly payload_json: JsonObject;
  readonly payload_hash: Sha256Hash;
  readonly occurred_at_ms: number;
  readonly created_at_ms: number;
}

export type CoordinatorTurnStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface CoordinatorTurnV1 {
  readonly turn_id: string;
  readonly session_id: string;
  readonly source_message_id: string;
  readonly status: CoordinatorTurnStatus;
  readonly attempt_no: number;
  readonly query_id: string | null;
  readonly error_code: string | null;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly finished_at_ms: number | null;
  readonly row_version: number;
}

export type TaskLaunchMode = 'published_recipe' | 'temporary_workflow';
export type TaskLaunchStatus =
  | 'drafting'
  | 'awaiting_confirmation'
  | 'creating'
  | 'linked'
  | 'unsupported'
  | 'failed'
  | 'cancelled';

export interface TaskLaunchIntentV1 {
  readonly launch_intent_id: string;
  readonly session_id: string;
  readonly source_message_id: string;
  readonly mode: TaskLaunchMode;
  readonly selected_recipe_ref: VersionedRef | null;
  readonly selected_recipe_hash: Sha256Hash | null;
  readonly selection_token: string | null;
  readonly effective_input_json: JsonValue;
  readonly effective_input_hash: Sha256Hash;
  readonly attachment_manifest_hash: Sha256Hash;
  readonly confirmed_draft_revision_id: string | null;
  readonly status: TaskLaunchStatus;
  readonly creation_domain: string;
  readonly creation_key: string;
  readonly idempotency_key: string;
  readonly last_error_code: string | null;
  readonly row_version: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface TemporaryWorkflowDraftRevisionV1 {
  readonly format: 'icarus.temporary-workflow-draft-revision/1';
  readonly revision_id: string;
  readonly draft_id: string;
  readonly revision_no: number;
  readonly parent_revision_id: string | null;
  readonly source_message_id: string;
  readonly source_json: JsonObject;
  readonly source_hash: Sha256Hash;
  readonly compiled_plan_json: JsonObject;
  readonly compiled_plan_hash: Sha256Hash;
  readonly compiler_version: string;
  readonly resource_closure_hash: Sha256Hash;
  readonly policy_ceiling_hash: Sha256Hash;
  readonly risk_summary_json: JsonObject;
  readonly created_at_ms: number;
}

export interface TaskExecutionLinkV1 {
  readonly link_id: string;
  readonly session_id: string;
  readonly workflow_id: string;
  readonly intake_id: string;
  readonly creation_request_id: string;
  readonly launch_intent_id: string;
  readonly created_at_ms: number;
}

export interface TaskWorkspaceSessionLinkV1 {
  readonly format: 'icarus.task-workspace-link/1';
  readonly target: 'session';
  readonly session_id: string;
}

export interface TaskInteractionSubmissionV1 {
  readonly interaction_id: string;
  readonly rendered_snapshot_hash: Sha256Hash;
  readonly action_id: string;
  readonly payload_json: JsonValue;
  readonly payload_hash: Sha256Hash;
  readonly expected_target_row_version: number;
  readonly idempotency_key: string;
}

export interface TaskPendingInteractionV1 {
  readonly format: 'icarus.task-pending-interaction/1';
  readonly interaction_id: string;
  readonly session_id: string;
  readonly workflow_id: string | null;
  readonly run_id: string | null;
  readonly target_kind: 'runtime_wait';
  readonly target_id: string;
  readonly rendered_snapshot_json: JsonObject;
  readonly rendered_snapshot_hash: Sha256Hash;
  readonly target_row_version: number;
  readonly status:
    | 'pending'
    | 'accepted'
    | 'duplicate'
    | 'conflict'
    | 'expired'
    | 'denied';
  readonly canonical_result_json: JsonObject | null;
  readonly row_version: number;
  readonly created_at_ms: number;
  readonly resolved_at_ms: number | null;
}

export type TaskRuntimeCommandAction = 'pause' | 'resume' | 'cancel';

export interface TaskRuntimeCommandProposalV1 {
  readonly format: 'icarus.task-runtime-command-proposal/1';
  readonly proposal_id: string;
  readonly session_id: string;
  readonly workflow_id: string;
  readonly run_id: string;
  readonly action: TaskRuntimeCommandAction;
  readonly expected_target_row_version: number;
  readonly proposal_hash: Sha256Hash;
  readonly status: 'pending' | 'applied' | 'failed' | 'cancelled';
  readonly canonical_receipt: JsonObject | null;
  readonly idempotency_key: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly row_version: number;
}

export interface TaskWorkspaceTimelineDeltaV1 {
  readonly type: 'task_workspace_timeline_delta';
  readonly session_id: string;
  readonly after_session_seq: number;
  readonly entries: readonly TaskTimelineEntryV1[];
  readonly next_session_seq: number;
  readonly source_state: 'ready' | 'catching_up' | 'degraded';
}
