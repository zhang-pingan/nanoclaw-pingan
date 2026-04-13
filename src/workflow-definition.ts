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

export interface WorkflowDefinitionTransition {
  target: string;
  delegate?: WorkflowDefinitionDelegate;
  notify?: WorkflowDefinitionNotify;
  card?: WorkflowDefinitionCardRef;
  effects?: WorkflowDefinitionEffects;
}

export interface WorkflowDefinitionStateBase {
  type: 'delegation' | 'confirmation' | 'terminal' | 'system';
  label?: string;
  description?: string;
}

export interface WorkflowDefinitionDelegationState
  extends WorkflowDefinitionStateBase {
  type: 'delegation';
  delegate: WorkflowDefinitionDelegate;
  on_complete: {
    success: WorkflowDefinitionTransition;
    failure: WorkflowDefinitionTransition;
  };
}

export interface WorkflowDefinitionConfirmationState
  extends WorkflowDefinitionStateBase {
  type: 'confirmation';
  card: WorkflowDefinitionCardRef;
  on_approve?: WorkflowDefinitionTransition;
  on_revise?: WorkflowDefinitionTransition;
}

export interface WorkflowDefinitionTerminalState
  extends WorkflowDefinitionStateBase {
  type: 'terminal';
}

export interface WorkflowDefinitionSystemState
  extends WorkflowDefinitionStateBase {
  type: 'system';
}

export type WorkflowDefinitionState =
  | WorkflowDefinitionDelegationState
  | WorkflowDefinitionConfirmationState
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
  type: 'text' | 'choice' | 'requirement_select';
  placeholder?: string;
  helper_text?: string;
  default_value?: string;
  searchable?: boolean;
  options?: WorkflowCreateFieldOption[];
  visible_when?: WorkflowCreateFieldCondition;
}

export interface WorkflowCreateForm {
  name_field_keys?: string[];
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
