import type { JsonObject, Sha256Hash } from './types.js';

export type ProductSurfaceKind =
  | 'launch'
  | 'control'
  | 'projection'
  | 'authoring'
  | 'resource_schema';

export type ProductSurfaceStatus = 'active' | 'removed';

export interface WorkflowRuntimeAbsenceBaseline extends JsonObject {
  format: 'icarus.workflow-runtime-absence-baseline/1';
  source_core_build_hash: Sha256Hash;
  generated_by_tool_hash: Sha256Hash;
  production_source_absence_hash: Sha256Hash;
  removed_api_negative_fixture_hash: Sha256Hash;
  removed_ui_negative_fixture_hash: Sha256Hash;
  schema_absence_hash: Sha256Hash;
  filesystem_absence_hash: Sha256Hash;
  active_resource_absence_hash: Sha256Hash;
  protected_capability_fixture_hash: Sha256Hash;
  test_data_root_isolation_hash: Sha256Hash;
  migration_candidate_boundary_hash: Sha256Hash;
  baseline_hash: Sha256Hash;
}

export interface ProductSurfaceCoverageEntry extends JsonObject {
  surface_id: string;
  surface_kind: ProductSurfaceKind;
  owner_feature_id: string | null;
  status: ProductSurfaceStatus;
  replacement_ref: string | null;
  contract_fixture_hash: Sha256Hash | null;
  removal_fixture_hash: Sha256Hash | null;
  entry_hash: Sha256Hash;
}

export interface ProductSurfaceCoverageManifest extends JsonObject {
  format: 'icarus.product-surface-coverage/1';
  source_core_build_hash: Sha256Hash;
  generated_by_tool_hash: Sha256Hash;
  entries: ProductSurfaceCoverageEntry[];
  active_surface_count: number;
  removed_surface_count: number;
  manifest_hash: Sha256Hash;
}

export interface MigrationCandidateBoundaryManifest extends JsonObject {
  format: 'icarus.migration-candidate-boundary/1';
  source_core_build_hash: Sha256Hash;
  candidate_root: 'local/migration-candidates/';
  archive_manifest_hash: Sha256Hash;
  checksum_manifest_hash: Sha256Hash;
  archived_file_count: number;
  production_import_reachability_hash: Sha256Hash;
  test_helper_reachability_hash: Sha256Hash;
  setup_reachability_hash: Sha256Hash;
  feature_registry_reachability_hash: Sha256Hash;
  compiler_fixture_reachability_hash: Sha256Hash;
  build_context_reachability_hash: Sha256Hash;
  release_artifact_reachability_hash: Sha256Hash;
  boundary_hash: Sha256Hash;
}

export interface StaticAbsenceProofEvidence {
  source_core_build_hash: Sha256Hash;
  generated_by_tool_hash: Sha256Hash;
  production_files: string[];
  production_import_edges: Array<{ from: string; to: string }>;
  production_source_hits: string[];
  web_routes: Array<{
    source_file: string;
    match_kind: 'exact' | 'prefix' | 'regex';
    pattern: string;
    methods: string[];
  }>;
  removed_api_hits: string[];
  dom_ids: string[];
  dom_nav_keys: string[];
  removed_ui_hits: string[];
  configured_filesystem_roots: string[];
  legacy_schema_hits: string[];
  legacy_filesystem_hits: string[];
  active_resource_hits: string[];
  feature_manifest_files: string[];
  protected_fixture_hashes: Record<string, Sha256Hash>;
  test_root_violations: string[];
  candidate_boundary: MigrationCandidateBoundaryManifest;
  candidate_runtime_file_access_hits: string[];
  candidate_scanned_content_file_count: number;
}

export interface ProtectedCapabilityFixtureSeed {
  fixture_id: string;
  source_module_suffix: string;
  source_identifier: string | null;
  api_route: string | null;
  dom_id: string | null;
  dom_nav_key: string | null;
}

export interface ProductSurfaceSeed {
  surface_id: string;
  surface_kind: ProductSurfaceKind;
  owner_feature_id: string | null;
  status: ProductSurfaceStatus;
  replacement_ref: string | null;
  protected_fixture_id: string | null;
  removal_fixture_kind: StaticAbsenceFixtureKind | null;
}

export type StaticAbsenceFixtureKind =
  | 'source'
  | 'api'
  | 'ui'
  | 'schema'
  | 'filesystem'
  | 'resource'
  | 'protected_capability'
  | 'test_root'
  | 'candidate_production'
  | 'candidate_test_helper'
  | 'candidate_setup'
  | 'candidate_feature_registry'
  | 'candidate_compiler_fixture'
  | 'candidate_build_context'
  | 'candidate_release_artifact'
  | 'candidate_runtime_file_access'
  | 'surface';

export interface StaticAbsencePositiveCase extends JsonObject {
  case_id: string;
  proof_kind: StaticAbsenceFixtureKind;
  expected_result: 'pass';
}

export interface StaticAbsenceNegativeCase extends JsonObject {
  case_id: string;
  proof_kind: StaticAbsenceFixtureKind;
  mutation: string;
  expected_error: string;
}

export const ABSENCE_BASELINE_KEYS = [
  'format',
  'source_core_build_hash',
  'generated_by_tool_hash',
  'production_source_absence_hash',
  'removed_api_negative_fixture_hash',
  'removed_ui_negative_fixture_hash',
  'schema_absence_hash',
  'filesystem_absence_hash',
  'active_resource_absence_hash',
  'protected_capability_fixture_hash',
  'test_data_root_isolation_hash',
  'migration_candidate_boundary_hash',
  'baseline_hash',
] as const satisfies readonly (keyof WorkflowRuntimeAbsenceBaseline)[];

export const PRODUCT_SURFACE_MANIFEST_KEYS = [
  'format',
  'source_core_build_hash',
  'generated_by_tool_hash',
  'entries',
  'active_surface_count',
  'removed_surface_count',
  'manifest_hash',
] as const satisfies readonly (keyof ProductSurfaceCoverageManifest)[];

export const PRODUCT_SURFACE_ENTRY_KEYS = [
  'surface_id',
  'surface_kind',
  'owner_feature_id',
  'status',
  'replacement_ref',
  'contract_fixture_hash',
  'removal_fixture_hash',
  'entry_hash',
] as const satisfies readonly (keyof ProductSurfaceCoverageEntry)[];

export const MIGRATION_CANDIDATE_BOUNDARY_KEYS = [
  'format',
  'source_core_build_hash',
  'candidate_root',
  'archive_manifest_hash',
  'checksum_manifest_hash',
  'archived_file_count',
  'production_import_reachability_hash',
  'test_helper_reachability_hash',
  'setup_reachability_hash',
  'feature_registry_reachability_hash',
  'compiler_fixture_reachability_hash',
  'build_context_reachability_hash',
  'release_artifact_reachability_hash',
  'boundary_hash',
] as const satisfies readonly (keyof MigrationCandidateBoundaryManifest)[];

export const PRODUCT_SURFACE_KINDS = [
  'launch',
  'control',
  'projection',
  'authoring',
  'resource_schema',
] as const satisfies readonly ProductSurfaceKind[];

export const PRODUCT_SURFACE_STATUSES = [
  'active',
  'removed',
] as const satisfies readonly ProductSurfaceStatus[];

export const STATIC_ABSENCE_SOURCE_ROOTS = [
  'src',
  'electron',
  'assistant',
  'container/agent-runner/src',
] as const;

export const STATIC_ABSENCE_TOOL_SOURCE_FILES = [
  'src/workflow-runtime/contracts/static-absence-types.ts',
  'src/workflow-runtime/contracts/static-absence-artifacts.ts',
  'src/workflow-runtime/contracts/static-absence-source.ts',
  'src/workflow-runtime/contracts/static-absence-fixtures.ts',
  'src/workflow-runtime/contracts/static-absence-pack.ts',
] as const;

export const REMOVED_SOURCE_MODULE_BASENAMES = [
  'card-builder',
  'card-config',
  'card-files',
  'workbench',
  'workbench-query',
  'workbench-store',
  'workflow',
  'workflow-compiler',
  'workflow-context',
  'workflow-definition',
] as const;

export const REMOVED_SOURCE_IDENTIFIERS = [
  'WORKBENCH_BROADCAST_TARGETS',
  'deleteAllWorkbenchTaskData',
  'getAllWorkflows',
  'initWorkflow',
  'query_workbench_tasks',
  'syncWorkbenchOnWorkflowCreated',
  'workbench_task_ids',
  'workflowAssets',
] as const;

export const REMOVED_API_FIXTURES = [
  { path: '/api/workflow-definitions', method: 'GET' },
  { path: '/api/workflow-definitions/example', method: 'GET' },
  { path: '/api/workflow-artifact-contracts', method: 'GET' },
  { path: '/api/workflow-actions', method: 'GET' },
  { path: '/api/cards', method: 'GET' },
  { path: '/api/cards/example', method: 'GET' },
  { path: '/api/workflow/create-options', method: 'GET' },
  { path: '/api/workflow/requirement', method: 'POST' },
  { path: '/api/workbench/tasks', method: 'GET' },
  { path: '/api/workbench/tasks/example/retry', method: 'POST' },
] as const;

export const REMOVED_DOM_NAV_KEYS = [
  'cards-management',
  'workbench',
  'workflow-definitions',
] as const;

export const REMOVED_DOM_SCREEN_IDS = [
  'cards-management-screen',
  'workbench-screen',
  'workflow-definitions-screen',
] as const;

export const REMOVED_FEATURE_RESOURCE_KEYS = [
  'artifactContracts',
  'cards',
  'workflowDefinitions',
  'workflowEvaluators',
] as const;

export const REMOVED_RESOURCE_ROOT_BASENAMES = [
  'artifact-contracts',
  'cards',
  'workflow-definitions',
  'workflow-evaluators',
] as const;

export const REMOVED_DATA_ROOT_BASENAMES = [
  'workbench',
  'workflow-assets',
  'workflow-context',
  'workflow-history',
] as const;

export const LEGACY_SQLITE_TABLES = [
  'workbench_action_items',
  'workbench_artifacts',
  'workbench_comments',
  'workbench_context_assets',
  'workbench_events',
  'workbench_subtasks',
  'workbench_tasks',
  'workflow_checkpoints',
  'workflow_events',
  'workflow_interrupt_resume_attempts',
  'workflow_interrupts',
  'workflow_outbox',
  'workflow_stage_evaluations',
  'workflows',
] as const;

export const LEGACY_SQLITE_COLUMNS = [
  'agent_queries.stage_key',
  'agent_queries.workflow_id',
  'agent_queries.workflow_type',
  'assistant_chat_messages.workflow_id',
  'delegations.workflow_id',
  'messages.workflow_id',
] as const;

export const LEGACY_SQLITE_INDEX_PREFIXES = [
  'idx_workbench_',
  'idx_workflow_',
] as const;

export const PROTECTED_CAPABILITY_FIXTURES = [
  {
    fixture_id: 'delegation',
    source_module_suffix: '/db.ts',
    source_identifier: 'createDelegation',
    api_route: null,
    dom_id: null,
    dom_nav_key: null,
  },
  {
    fixture_id: 'scheduled_task',
    source_module_suffix: '/task-scheduler.ts',
    source_identifier: null,
    api_route: '/api/tasks',
    dom_id: null,
    dom_nav_key: null,
  },
  {
    fixture_id: 'agent_container',
    source_module_suffix: '/container-runner.ts',
    source_identifier: 'runContainerAgent',
    api_route: null,
    dom_id: null,
    dom_nav_key: null,
  },
  {
    fixture_id: 'trace',
    source_module_suffix: '/agent-query-trace.ts',
    source_identifier: 'agentQueryTraceManager',
    api_route: '/api/agent-queries',
    dom_id: 'trace-monitor-screen',
    dom_nav_key: 'trace-monitor',
  },
  {
    fixture_id: 'feature_runtime',
    source_module_suffix: '/features/runtime.ts',
    source_identifier: 'activateConfiguredFeatures',
    api_route: '/api/features/enabled',
    dom_id: 'feature-runtime-screen',
    dom_nav_key: null,
  },
  {
    fixture_id: 'interactive_card_channel',
    source_module_suffix: '/types.ts',
    source_identifier: 'InteractiveCard',
    api_route: '/api/card-action',
    dom_id: null,
    dom_nav_key: null,
  },
  {
    fixture_id: 'ask_user_question',
    source_module_suffix: '/ask-user-question.ts',
    source_identifier: null,
    api_route: null,
    dom_id: null,
    dom_nav_key: null,
  },
  {
    fixture_id: 'assistant',
    source_module_suffix: '/channels/web.ts',
    source_identifier: null,
    api_route: '/api/assistant/state',
    dom_id: 'assistant-screen',
    dom_nav_key: 'assistant',
  },
  {
    fixture_id: 'today_plan',
    source_module_suffix: '/today-plan.ts',
    source_identifier: null,
    api_route: '/api/today-plan',
    dom_id: 'today-plan-screen',
    dom_nav_key: null,
  },
  {
    fixture_id: 'memory',
    source_module_suffix: '/memory-pack.ts',
    source_identifier: null,
    api_route: '/api/memory',
    dom_id: 'memory-management-screen',
    dom_nav_key: 'memory-management',
  },
  {
    fixture_id: 'wiki',
    source_module_suffix: '/wiki.ts',
    source_identifier: null,
    api_route: '/api/wiki/pages',
    dom_id: 'knowledge-management-screen',
    dom_nav_key: 'knowledge-management',
  },
  {
    fixture_id: 'chat',
    source_module_suffix: '/channels/web.ts',
    source_identifier: 'WebChannel',
    api_route: '/api/messages',
    dom_id: 'main-screen',
    dom_nav_key: null,
  },
] as const satisfies readonly ProtectedCapabilityFixtureSeed[];

export const PRODUCT_SURFACE_SEEDS = [
  ...PROTECTED_CAPABILITY_FIXTURES.map((fixture) => ({
    surface_id: `protected.${fixture.fixture_id}`,
    surface_kind:
      fixture.fixture_id === 'trace'
        ? ('projection' as const)
        : ('launch' as const),
    owner_feature_id: null,
    status: 'active' as const,
    replacement_ref: `protected-capability:${fixture.fixture_id}`,
    protected_fixture_id: fixture.fixture_id,
    removal_fixture_kind: null,
  })),
  {
    surface_id: 'removed.workflow_management_launch',
    surface_kind: 'launch',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'api',
  },
  {
    surface_id: 'removed.workflow_management_control',
    surface_kind: 'control',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'api',
  },
  {
    surface_id: 'removed.workflow_management_projection',
    surface_kind: 'projection',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'ui',
  },
  {
    surface_id: 'removed.workflow_management_authoring',
    surface_kind: 'authoring',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'source',
  },
  {
    surface_id: 'removed.card_management',
    surface_kind: 'authoring',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'ui',
  },
  {
    surface_id: 'removed.workbench_launch',
    surface_kind: 'launch',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'api',
  },
  {
    surface_id: 'removed.workbench_control',
    surface_kind: 'control',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'source',
  },
  {
    surface_id: 'removed.workbench_projection',
    surface_kind: 'projection',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'ui',
  },
  {
    surface_id: 'removed.legacy_feature_resource_keys',
    surface_kind: 'resource_schema',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'resource',
  },
  {
    surface_id: 'removed.migration_candidate_launch',
    surface_kind: 'launch',
    owner_feature_id: null,
    status: 'removed',
    replacement_ref: null,
    protected_fixture_id: null,
    removal_fixture_kind: 'candidate_production',
  },
] as const satisfies readonly ProductSurfaceSeed[];
