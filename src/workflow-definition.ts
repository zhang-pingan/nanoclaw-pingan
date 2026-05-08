export interface WorkflowDefinitionRole {
  label?: string;
  description?: string;
  channels: Record<string, string>;
}

export interface WorkflowDefinitionEntryPoint {
  label?: string;
  description?: string;
  state: string;
  requires_deliverable?: boolean;
  deliverable_role?: string;
}

export interface WorkflowDefinitionDelegate {
  role: string;
  skill?: string;
  task_template?: string;
}

export interface WorkflowDefinitionNotify {
  template: string;
}

export interface WorkflowDefinitionCardRef {
  ref: string;
}

export interface WorkflowDefinitionEffects {
  increment_round?: boolean;
}

export interface WorkflowDefinitionRetryPolicy {
  max_attempts: number;
  backoff?: 'fixed' | 'linear' | 'exponential';
  initial_delay_ms?: number;
  max_delay_ms?: number;
  retry_on?: Array<
    | 'timeout'
    | 'transient_error'
    | 'agent_retryable_error'
    | 'evaluator_pending'
  >;
  on_exhausted?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionTimeoutPolicy {
  duration_ms: number;
  notify?: Array<'web' | 'feishu' | 'assistant' | 'main_group'>;
  on_timeout: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionJsonSchemaRef {
  ref?: string;
  schema?: Record<string, unknown>;
}

export interface WorkflowDefinitionArtifactContractRef {
  ref: string;
}

export interface WorkflowDefinitionEvaluatorRef {
  ref: string;
  on_pass?: WorkflowDefinitionTransition;
  on_needs_revision?: WorkflowDefinitionTransition;
  on_fail?: WorkflowDefinitionTransition;
  on_pending?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionRollbackHintRef {
  ref: string;
}

export interface WorkflowDefinitionTransition {
  target: string;
  delegate?: WorkflowDefinitionDelegate;
  notify?: WorkflowDefinitionNotify;
  card?: WorkflowDefinitionCardRef;
  effects?: WorkflowDefinitionEffects;
}

export interface WorkflowDefinitionStateBase {
  type: 'delegation' | 'interrupt' | 'terminal' | 'system';
  label?: string;
  description?: string;
  retry_policy?: WorkflowDefinitionRetryPolicy;
  timeout_policy?: WorkflowDefinitionTimeoutPolicy;
  artifact_contract?: WorkflowDefinitionArtifactContractRef;
  evaluator?: WorkflowDefinitionEvaluatorRef;
  rollback_hint?: WorkflowDefinitionRollbackHintRef;
}

export interface WorkflowDefinitionDelegationState extends WorkflowDefinitionStateBase {
  type: 'delegation';
  delegate: WorkflowDefinitionDelegate;
  on_complete: {
    success: WorkflowDefinitionTransition;
    failure: WorkflowDefinitionTransition;
  };
}

export type WorkflowDefinitionInterruptKind =
  | 'approval'
  | 'revision_request'
  | 'credential'
  | 'human_input'
  | 'external_blocker';

export type WorkflowDefinitionInterruptChannel = 'web' | 'feishu' | 'assistant';

export interface WorkflowDefinitionInterruptState extends WorkflowDefinitionStateBase {
  type: 'interrupt';
  kind: WorkflowDefinitionInterruptKind;
  card?: WorkflowDefinitionCardRef;
  title?: string;
  body?: string;
  resume_payload_schema: WorkflowDefinitionJsonSchemaRef;
  allowed_actions: string[];
  allowed_channels?: WorkflowDefinitionInterruptChannel[];
  on_resume: Record<string, WorkflowDefinitionTransition>;
  on_cancel?: WorkflowDefinitionTransition;
  on_expire?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionTerminalState extends WorkflowDefinitionStateBase {
  type: 'terminal';
}

export interface WorkflowDefinitionSystemState extends WorkflowDefinitionStateBase {
  type: 'system';
  on_complete?: {
    success: WorkflowDefinitionTransition;
    failure?: WorkflowDefinitionTransition;
  };
}

export type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionInterruptState
  | WorkflowDefinitionTerminalState
  | WorkflowDefinitionSystemState;

export interface WorkflowDefinitionMetadata {
  owner?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  based_on_version?: number;
}

export interface WorkflowCreateFieldCondition {
  entry_points?: string[];
  equals?: Record<string, string | string[]>;
}

export interface WorkflowCreateFieldOption {
  value: string;
  label: string;
}

export interface WorkflowCreateField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'choice' | 'requirement_select' | 'file_uploads';
  placeholder?: string;
  helper_text?: string;
  default_value?: string;
  required?: boolean;
  searchable?: boolean;
  options?: WorkflowCreateFieldOption[];
  visible_when?: WorkflowCreateFieldCondition;
}

export interface WorkflowCreateForm {
  fields: WorkflowCreateField[];
}

export interface WorkflowDefinition {
  key: string;
  name: string;
  description?: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  roles: Record<string, WorkflowDefinitionRole>;
  entry_points: Record<string, WorkflowDefinitionEntryPoint>;
  states: Record<string, WorkflowDefinitionState>;
  status_labels: Record<string, string>;
  create_form?: WorkflowCreateForm;
  metadata?: WorkflowDefinitionMetadata;
}

export interface WorkflowDefinitionVersionBundle {
  key: string;
  label?: string;
  description?: string;
  versions: WorkflowDefinition[];
}

export interface WorkflowDefinitionRegistry {
  definitions: Record<string, WorkflowDefinitionVersionBundle>;
}
