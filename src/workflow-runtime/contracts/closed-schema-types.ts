import type { JsonObject, JsonValue, VersionedRef } from './types.js';

export const WORKFLOW_STATE_TYPES = [
  'delegation',
  'system',
  'interrupt',
  'graph',
  'terminal',
] as const;
export type WorkflowStateType = (typeof WORKFLOW_STATE_TYPES)[number];

export const GRAPH_NODE_TYPES = [
  'delegation',
  'system',
  'wait',
  'join',
  'subgraph',
  'expand',
  'map',
  'terminal',
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const WORKFLOW_COMMAND_TYPES = [
  'pause_run',
  'resume_run',
  'cancel_run',
  'cancel_workflow',
  'skip_node',
  'advance_retry_schedule',
  'reconcile_effect',
  'submit_effect_receipt',
  'verify_effect_not_applied',
  'remediate_operational_blocker',
  'restore_integrity',
  'request_administrative_abandon',
  'confirm_administrative_abandon',
] as const;
export type WorkflowCommandType = (typeof WORKFLOW_COMMAND_TYPES)[number];

export const WORKFLOW_COMMAND_REASON_CODES = [
  'operator_requested',
  'investigation',
  'superseded',
  'invalid_input',
  'no_longer_needed',
  'dependency_recovered',
  'credential_restored',
  'receipt_recovered',
  'provider_reconciled',
  'not_applied_verified',
  'backup_restored',
  'hash_revalidated',
  'deadline_enforced',
  'safety_enforced',
  'unrecoverable_state',
  'external_effect_unverifiable',
  'data_loss_accepted',
] as const;
export type WorkflowCommandReasonCode =
  (typeof WORKFLOW_COMMAND_REASON_CODES)[number];

export const PACK_WORKFLOW_RESOURCE_KINDS = [
  'recipe',
  'routing_scope',
  'execution_policy',
  'definition',
  'command_policy',
  'context_contract',
  'schema',
  'scope_interface',
  'graph_template',
  'graph_policy',
  'card_presentation',
] as const;
export type PackWorkflowResourceKind =
  (typeof PACK_WORKFLOW_RESOURCE_KINDS)[number];

export const WORKFLOW_VALUE_BINDING_SOURCES = [
  'workflow_input',
  'context_slot',
  'completed_output',
  'artifact',
  'constant',
] as const;

export type WorkflowValueBinding =
  | { source: 'workflow_input'; pointer?: string }
  | { source: 'context_slot'; slot: string; pointer?: string }
  | { source: 'completed_output'; port: string; pointer?: string }
  | { source: 'artifact'; ref: string; json_pointer?: string }
  | { source: 'constant'; value: JsonValue };

export const WORKFLOW_GRAPH_INPUT_BINDING_SOURCES = [
  'workflow_input',
  'context_slot',
  'artifact',
  'constant',
] as const;
export type WorkflowGraphInputBinding = Exclude<
  WorkflowValueBinding,
  { source: 'completed_output' }
>;

export const WORKFLOW_TRANSITION_EFFECT_INPUT_SOURCES = [
  'context_slot',
  'completed_output',
  'constant',
] as const;
export type WorkflowTransitionEffectInputBinding = Extract<
  WorkflowValueBinding,
  { source: 'context_slot' | 'completed_output' | 'constant' }
>;

interface WorkflowTransitionEffectBase {
  id: string;
  type: 'start_child_workflow';
  recipe_ref: VersionedRef;
  routing_scope_ref: VersionedRef;
  principal_binding: 'inherit_parent_principal';
  creation_domain: 'parent_workflow_lineage';
  relation_kind: 'follow_up' | 'background' | 'validation' | 'domain_defined';
  input_bindings: Record<string, WorkflowTransitionEffectInputBinding>;
}

export type WorkflowTransitionEffect = WorkflowTransitionEffectBase &
  (
    | {
        delivery_requirement: 'required';
        finalization_policy_ref: VersionedRef;
        outbox_delivery_policy_ref?: never;
      }
    | {
        delivery_requirement: 'best_effort';
        finalization_policy_ref?: never;
        outbox_delivery_policy_ref: VersionedRef;
      }
  );

export interface WorkflowDefinitionStateBase {
  type: WorkflowStateType;
  label?: string;
  description?: string;
}

export type WorkflowDefinitionState = WorkflowDefinitionStateBase &
  (
    | {
        type: 'delegation' | 'system';
        capability_ref: VersionedRef;
        policy: JsonObject;
        input_bindings: Record<string, WorkflowGraphInputBinding>;
        retry_request: JsonObject | null;
        timeout_ms: number | null;
        on_complete: {
          success: WorkflowTransitionDocument;
          failure: WorkflowTransitionDocument;
        };
        on_error: WorkflowTransitionDocument;
        on_local_cancel: WorkflowTransitionDocument;
      }
    | {
        type: 'interrupt';
        wait: JsonObject;
        policy: JsonObject;
        input_bindings: Record<string, WorkflowGraphInputBinding>;
        on_resume: Record<string, WorkflowTransitionDocument>;
        on_expire: WorkflowTransitionDocument | null;
        on_wait_cancelled: WorkflowTransitionDocument | null;
        on_error: WorkflowTransitionDocument;
        on_local_cancel: WorkflowTransitionDocument;
      }
    | {
        type: 'graph';
        graph_source: JsonObject;
        input_bindings?: Record<string, WorkflowGraphInputBinding>;
        root_interface_ref: VersionedRef;
        policy: JsonObject;
        exit_routes: Record<string, WorkflowTransitionDocument>;
        on_error: WorkflowTransitionDocument;
        on_local_cancel: WorkflowTransitionDocument;
        on_temporary_replan?: WorkflowTransitionDocument;
      }
    | {
        type: 'terminal';
        terminal_kind: 'normal';
        output_binding: WorkflowValueBinding;
      }
    | {
        type: 'terminal';
        terminal_kind: 'errored';
        error_code: string;
        error_binding: WorkflowValueBinding | null;
      }
  );

export interface WorkflowDefinitionDocument {
  format: 'icarus.workflow-definition/1';
  ref: VersionedRef;
  owner_pack_id: string | null;
  name: string;
  context_contract_ref: VersionedRef;
  entry_points: Record<string, { state_key: string }>;
  states: Record<string, WorkflowDefinitionState>;
  definition_hash: string;
}

export interface WorkflowRecipeDocument {
  format: 'icarus.workflow-recipe/1';
  ref: VersionedRef;
  owner_pack_id?: string | null;
  catalog_visibility: 'system_only' | 'selectable';
  system_purposes?: Array<'temporary_workflow' | 'personal_workflow'>;
  name: string;
  description?: string | null;
  recipe_family?: string;
  task_kinds?: string[];
  workflow_definition_ref: VersionedRef;
  entry_point: string;
  initial_state_key?: string;
  workflow_execution_policy_ref: VersionedRef;
  context_contract_ref: VersionedRef;
  workflow_command_policy_ref: VersionedRef;
  input_schema_ref: VersionedRef;
  output_schema_ref: VersionedRef;
  routing_scope_ref: VersionedRef;
  launch_policy: 'auto' | 'confirm' | 'manual_only';
  effect_ceiling: 'read_only' | 'mutable_effects' | 'irreversible';
  input_summary: JsonObject;
  derived_effect_summary?: {
    max_impact: 'read_only' | 'mutable_effects' | 'irreversible';
    recovery_kinds: Array<'pure' | 'idempotent' | 'compensatable'>;
    permission_refs: string[];
    dependency_closure_hash: string;
  };
  required_permissions?: string[];
  allowed_child_recipe_refs?: VersionedRef[];
  resource_claims?: Array<{
    id: string;
    namespace: string;
    mode: 'shared' | 'exclusive';
    key_json_pointers: string[];
    hold_until: 'workflow_terminal';
  }>;
  recipe_hash?: string;
}

interface WorkflowRuntimeCommandBase {
  command_id: string;
  idempotency_key: string;
  expected_row_version: number;
  reason_code: WorkflowCommandReasonCode;
  reason_text?: string;
  evidence_refs: string[];
}

type CommandTarget<K extends string> = { [P in K]: string };

export type WorkflowRuntimeCommandDocument = WorkflowRuntimeCommandBase &
  (
    | {
        command_type: 'pause_run' | 'resume_run' | 'cancel_run';
        target: CommandTarget<'run_id'>;
      }
    | {
        command_type: 'cancel_workflow' | 'request_administrative_abandon';
        target: CommandTarget<'workflow_id'>;
      }
    | {
        command_type: 'confirm_administrative_abandon';
        target: CommandTarget<'workflow_id'>;
        confirmation_ref: string;
      }
    | {
        command_type: 'skip_node';
        target: CommandTarget<'node_id'>;
      }
    | {
        command_type: 'advance_retry_schedule';
        target: CommandTarget<'retry_schedule_id'>;
      }
    | {
        command_type:
          | 'reconcile_effect'
          | 'submit_effect_receipt'
          | 'verify_effect_not_applied';
        target: CommandTarget<'effect_operation_id'>;
      }
    | {
        command_type: 'remediate_operational_blocker' | 'restore_integrity';
        target: CommandTarget<'operational_blocker_id'>;
      }
  );

export interface WorkflowTransitionDocument {
  target: string;
  context_patch?: {
    set: Record<string, WorkflowValueBinding>;
    clear: string[];
  };
  notify?: {
    contract_ref: VersionedRef;
    input_bindings: Record<string, WorkflowValueBinding>;
  };
  card?: { ref: VersionedRef };
  effects?: { operations: WorkflowTransitionEffect[] };
}

export interface PackWorkflowResourceEntry {
  kind: PackWorkflowResourceKind;
  ref: VersionedRef;
  source_path: string;
  expected_source_hash: string;
}

export interface WorkflowPackManifestDocument {
  format: 'icarus.workflow-pack/1';
  pack_ref: VersionedRef;
  display_name: string;
  description: string | null;
  namespace: string;
  owner_principal_ref: string;
  dependencies: JsonObject[];
  workflow_resources: PackWorkflowResourceEntry[];
  execution_resources: JsonObject;
  permissions: JsonObject;
  manifest_hash: string;
}

export interface CardPresentationDocument {
  format: 'icarus.card-presentation/1';
  ref: VersionedRef;
  owner_pack_id: string | null;
  template_ref: VersionedRef;
  template_hash: string;
  variable_schema_ref: VersionedRef;
  variable_schema_hash: string;
  supported_channel_adapters: JsonObject[];
  render_limits: JsonObject;
  fallback_text_template_ref: VersionedRef;
  actions: Array<{
    action_id: string;
    label: string;
    binding:
      | {
          action_kind: 'wait_signal';
          wait_contract_ref: VersionedRef;
          action_value: string;
          correlation_variable: string;
        }
      | {
          action_kind: 'business_command';
          business_command_contract_ref: VersionedRef;
          command_input_variable: string;
        }
      | {
          action_kind: 'runtime_command';
          command_type: WorkflowCommandType;
          target_binding:
            | 'workflow'
            | 'run'
            | 'node'
            | 'retry_schedule'
            | 'effect_operation'
            | 'operational_blocker';
        };
    required_permission: string;
    idempotency_domain: 'card_interaction';
    expires_after_ms: number;
  }>;
  snapshot_retention_policy_ref: VersionedRef;
  deterministic_render_fixture_ref: string;
  deterministic_render_fixture_hash: string;
  contract_hash: string;
}

export interface GraphScopeSourceDocument {
  format: 'icarus.workflow-graph-scope/1';
  scope_key: string;
  label?: string;
  interface_ref: VersionedRef;
  nodes: Array<JsonObject & { id: string; type: GraphNodeType }>;
  route_groups?: JsonObject[];
  control_edges: JsonObject[];
  data_edges: JsonObject[];
  completion: JsonObject;
  requested_limits: JsonObject;
  metadata?: Record<string, JsonValue>;
}

export interface CompiledScopePlanDocument {
  format: 'icarus.workflow-graph-scope-plan/2';
  compiler_version: string;
  plan_hash: string;
  source_hash: string;
  interface_snapshot_hash: string;
  policy_snapshot_hash: string;
  effective_policy_snapshot: JsonObject;
  capability_catalog_hash: string;
  wait_contract_catalog_hash: string;
  interface_snapshot: JsonObject;
  nodes: JsonObject[];
  route_groups: JsonObject[];
  control_edges: JsonObject[];
  data_edges: JsonObject[];
  completion: JsonObject;
  complexity_summary: JsonObject;
  static_child_plan_closure: JsonObject;
  effective_limits: JsonObject;
  effective_usage_budget: JsonObject;
  runtime_safety_snapshot: JsonObject;
  runtime_safety_hash: string;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type RequiredKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? never : Key;
}[keyof Value];
type _WorkflowValueBindingSources = Assert<
  Equal<
    WorkflowValueBinding['source'],
    (typeof WORKFLOW_VALUE_BINDING_SOURCES)[number]
  >
>;
type _WorkflowGraphInputBindingSources = Assert<
  Equal<
    WorkflowGraphInputBinding['source'],
    (typeof WORKFLOW_GRAPH_INPUT_BINDING_SOURCES)[number]
  >
>;
type _WorkflowTransitionEffectInputSources = Assert<
  Equal<
    WorkflowTransitionEffectInputBinding['source'],
    (typeof WORKFLOW_TRANSITION_EFFECT_INPUT_SOURCES)[number]
  >
>;

export const WORKFLOW_DEFINITION_KEYS = [
  'format',
  'ref',
  'owner_pack_id',
  'name',
  'context_contract_ref',
  'entry_points',
  'states',
  'definition_hash',
] as const satisfies readonly (keyof WorkflowDefinitionDocument)[];
type _WorkflowDefinitionKeys = Assert<
  Equal<
    keyof WorkflowDefinitionDocument,
    (typeof WORKFLOW_DEFINITION_KEYS)[number]
  >
>;
export const WORKFLOW_DEFINITION_REQUIRED_KEYS = [
  'format',
  'ref',
  'owner_pack_id',
  'name',
  'context_contract_ref',
  'entry_points',
  'states',
  'definition_hash',
] as const satisfies readonly RequiredKeys<WorkflowDefinitionDocument>[];

export const WORKFLOW_RECIPE_KEYS = [
  'format',
  'ref',
  'owner_pack_id',
  'catalog_visibility',
  'system_purposes',
  'name',
  'description',
  'recipe_family',
  'task_kinds',
  'workflow_definition_ref',
  'entry_point',
  'initial_state_key',
  'workflow_execution_policy_ref',
  'context_contract_ref',
  'workflow_command_policy_ref',
  'input_schema_ref',
  'output_schema_ref',
  'routing_scope_ref',
  'launch_policy',
  'effect_ceiling',
  'input_summary',
  'derived_effect_summary',
  'required_permissions',
  'allowed_child_recipe_refs',
  'resource_claims',
  'recipe_hash',
] as const satisfies readonly (keyof WorkflowRecipeDocument)[];
type _WorkflowRecipeKeys = Assert<
  Equal<keyof WorkflowRecipeDocument, (typeof WORKFLOW_RECIPE_KEYS)[number]>
>;
export const WORKFLOW_RECIPE_REQUIRED_KEYS = [
  'format',
  'ref',
  'catalog_visibility',
  'name',
  'workflow_definition_ref',
  'entry_point',
  'workflow_execution_policy_ref',
  'context_contract_ref',
  'workflow_command_policy_ref',
  'input_schema_ref',
  'output_schema_ref',
  'routing_scope_ref',
  'launch_policy',
  'effect_ceiling',
  'input_summary',
] as const satisfies readonly RequiredKeys<WorkflowRecipeDocument>[];

export const WORKFLOW_RUNTIME_COMMAND_KEYS = [
  'command_id',
  'idempotency_key',
  'expected_row_version',
  'reason_code',
  'reason_text',
  'evidence_refs',
  'command_type',
  'target',
] as const satisfies readonly (keyof WorkflowRuntimeCommandDocument)[];
type _WorkflowRuntimeCommandKeys = Assert<
  Equal<
    keyof WorkflowRuntimeCommandDocument,
    (typeof WORKFLOW_RUNTIME_COMMAND_KEYS)[number]
  >
>;
export const WORKFLOW_RUNTIME_COMMAND_REQUIRED_KEYS = [
  'command_id',
  'idempotency_key',
  'expected_row_version',
  'reason_code',
  'evidence_refs',
  'command_type',
  'target',
] as const satisfies readonly RequiredKeys<WorkflowRuntimeCommandDocument>[];

export const WORKFLOW_TRANSITION_KEYS = [
  'target',
  'context_patch',
  'notify',
  'card',
  'effects',
] as const satisfies readonly (keyof WorkflowTransitionDocument)[];
type _WorkflowTransitionKeys = Assert<
  Equal<
    keyof WorkflowTransitionDocument,
    (typeof WORKFLOW_TRANSITION_KEYS)[number]
  >
>;
export const WORKFLOW_TRANSITION_REQUIRED_KEYS = [
  'target',
] as const satisfies readonly RequiredKeys<WorkflowTransitionDocument>[];

export const PACK_MANIFEST_KEYS = [
  'format',
  'pack_ref',
  'display_name',
  'description',
  'namespace',
  'owner_principal_ref',
  'dependencies',
  'workflow_resources',
  'execution_resources',
  'permissions',
  'manifest_hash',
] as const satisfies readonly (keyof WorkflowPackManifestDocument)[];
type _WorkflowPackManifestKeys = Assert<
  Equal<keyof WorkflowPackManifestDocument, (typeof PACK_MANIFEST_KEYS)[number]>
>;
export const PACK_MANIFEST_REQUIRED_KEYS = [
  'format',
  'pack_ref',
  'display_name',
  'description',
  'namespace',
  'owner_principal_ref',
  'dependencies',
  'workflow_resources',
  'execution_resources',
  'permissions',
  'manifest_hash',
] as const satisfies readonly RequiredKeys<WorkflowPackManifestDocument>[];

export const CARD_PRESENTATION_KEYS = [
  'format',
  'ref',
  'owner_pack_id',
  'template_ref',
  'template_hash',
  'variable_schema_ref',
  'variable_schema_hash',
  'supported_channel_adapters',
  'render_limits',
  'fallback_text_template_ref',
  'actions',
  'snapshot_retention_policy_ref',
  'deterministic_render_fixture_ref',
  'deterministic_render_fixture_hash',
  'contract_hash',
] as const satisfies readonly (keyof CardPresentationDocument)[];
type _CardPresentationKeys = Assert<
  Equal<keyof CardPresentationDocument, (typeof CARD_PRESENTATION_KEYS)[number]>
>;
export const CARD_PRESENTATION_REQUIRED_KEYS = [
  'format',
  'ref',
  'owner_pack_id',
  'template_ref',
  'template_hash',
  'variable_schema_ref',
  'variable_schema_hash',
  'supported_channel_adapters',
  'render_limits',
  'fallback_text_template_ref',
  'actions',
  'snapshot_retention_policy_ref',
  'deterministic_render_fixture_ref',
  'deterministic_render_fixture_hash',
  'contract_hash',
] as const satisfies readonly RequiredKeys<CardPresentationDocument>[];

export const GRAPH_SCOPE_SOURCE_KEYS = [
  'format',
  'scope_key',
  'label',
  'interface_ref',
  'nodes',
  'route_groups',
  'control_edges',
  'data_edges',
  'completion',
  'requested_limits',
  'metadata',
] as const satisfies readonly (keyof GraphScopeSourceDocument)[];
type _GraphScopeSourceKeys = Assert<
  Equal<
    keyof GraphScopeSourceDocument,
    (typeof GRAPH_SCOPE_SOURCE_KEYS)[number]
  >
>;
export const GRAPH_SCOPE_SOURCE_REQUIRED_KEYS = [
  'format',
  'scope_key',
  'interface_ref',
  'nodes',
  'control_edges',
  'data_edges',
  'completion',
  'requested_limits',
] as const satisfies readonly RequiredKeys<GraphScopeSourceDocument>[];

export const COMPILED_SCOPE_PLAN_KEYS = [
  'format',
  'compiler_version',
  'plan_hash',
  'source_hash',
  'interface_snapshot_hash',
  'policy_snapshot_hash',
  'effective_policy_snapshot',
  'capability_catalog_hash',
  'wait_contract_catalog_hash',
  'interface_snapshot',
  'nodes',
  'route_groups',
  'control_edges',
  'data_edges',
  'completion',
  'complexity_summary',
  'static_child_plan_closure',
  'effective_limits',
  'effective_usage_budget',
  'runtime_safety_snapshot',
  'runtime_safety_hash',
] as const satisfies readonly (keyof CompiledScopePlanDocument)[];
type _CompiledScopePlanKeys = Assert<
  Equal<
    keyof CompiledScopePlanDocument,
    (typeof COMPILED_SCOPE_PLAN_KEYS)[number]
  >
>;
export const COMPILED_SCOPE_PLAN_REQUIRED_KEYS = [
  'format',
  'compiler_version',
  'plan_hash',
  'source_hash',
  'interface_snapshot_hash',
  'policy_snapshot_hash',
  'effective_policy_snapshot',
  'capability_catalog_hash',
  'wait_contract_catalog_hash',
  'interface_snapshot',
  'nodes',
  'route_groups',
  'control_edges',
  'data_edges',
  'completion',
  'complexity_summary',
  'static_child_plan_closure',
  'effective_limits',
  'effective_usage_budget',
  'runtime_safety_snapshot',
  'runtime_safety_hash',
] as const satisfies readonly RequiredKeys<CompiledScopePlanDocument>[];

export type ClosedSchemaTypeConformance =
  | _WorkflowValueBindingSources
  | _WorkflowGraphInputBindingSources
  | _WorkflowTransitionEffectInputSources
  | _WorkflowDefinitionKeys
  | _WorkflowRecipeKeys
  | _WorkflowRuntimeCommandKeys
  | _WorkflowTransitionKeys
  | _WorkflowPackManifestKeys
  | _CardPresentationKeys
  | _GraphScopeSourceKeys
  | _CompiledScopePlanKeys;
