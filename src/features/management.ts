import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  getDatabase,
  listFeatureGroupBindings,
  recordFeatureAuditEvent,
} from '../db.js';
import { logger } from '../logger.js';
import {
  loadFeatureRuntimeConfig,
  saveLocalFeatureRuntimeConfig,
} from './config.js';
import { assertPathInsideFeature, LoadedFeatureManifest } from './manifest.js';
import {
  activateConfiguredFeatures,
  scanInstalledFeatures,
} from './runtime.js';
import { getWorkflowDefinitionsDir } from '../workflow-definition-files.js';
import { clearWorkflowArtifactContractCache } from '../workflow-artifact-contract.js';
import { loadWorkflowConfigs } from '../workflow-config.js';
import { getFeatureDataRoot } from '../workflow-storage.js';
import { clearWorkflowEvaluatorRegistryCache } from '../workflow-evaluator-registry.js';
import { getFeatureOwnedTablePrefixes } from './naming.js';

export interface FeatureOwnedTableSummary {
  name: string;
  rows: number;
}

export interface FeatureDeletionSummary {
  featureId: string;
  workflowTypes: string[];
  groups: Array<{ key: string; jid: string; folder: string }>;
  projectionTables: FeatureOwnedTableSummary[];
  counts: Record<string, number>;
  paths: string[];
}

export interface FeatureManagementHostHooks {
  reloadRegisteredGroups?: () => void;
  stopFeatureGroups?: (
    groups: FeatureDeletionSummary['groups'],
    context: { featureId: string; action: 'delete_data' },
  ) => Promise<void> | void;
}

let hostHooks: FeatureManagementHostHooks = {};

export function configureFeatureManagementHostHooks(
  hooks: FeatureManagementHostHooks,
): void {
  hostHooks = { ...hooks };
}

export function listFeatureManagementInfo(): Array<{
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  description?: string;
  apiPrefix?: string;
  nav_count: number;
  resources: Record<string, string>;
}> {
  const config = loadFeatureRuntimeConfig();
  const enabled = new Set(config.enabled);
  return scanInstalledFeatures().map((feature) => ({
    id: feature.manifest.id,
    name: feature.manifest.name,
    version: feature.manifest.version,
    description: feature.manifest.description,
    enabled: enabled.has(feature.manifest.id),
    apiPrefix:
      feature.manifest.apiPrefix || `/api/features/${feature.manifest.id}`,
    nav_count: (feature.manifest.nav || []).length,
    resources: Object.fromEntries(
      Object.entries(feature.manifest.resources || {}).filter(
        ([, value]) => typeof value === 'string' && value.trim(),
      ),
    ) as Record<string, string>,
  }));
}

export function setFeatureEnabled(input: {
  featureId: string;
  enabled: boolean;
}): {
  enabled: string[];
  source: string;
  restartRequired: boolean;
  error?: string;
} {
  const config = loadFeatureRuntimeConfig();
  if (config.source === 'env') {
    return {
      enabled: config.enabled,
      source: config.source,
      restartRequired: false,
      error:
        'ICARUS_FEATURES is set; update the environment variable to change enabled features',
    };
  }
  const installed = new Set(
    scanInstalledFeatures().map((feature) => feature.manifest.id),
  );
  if (!installed.has(input.featureId)) {
    return {
      enabled: config.enabled,
      source: config.source,
      restartRequired: false,
      error: `Feature "${input.featureId}" is not installed`,
    };
  }
  const next = new Set(config.enabled);
  if (input.enabled) next.add(input.featureId);
  else next.delete(input.featureId);
  const enabled = [...next].sort((a, b) => a.localeCompare(b));
  saveLocalFeatureRuntimeConfig(enabled);
  return { enabled, source: 'local', restartRequired: true };
}

export async function setFeatureEnabledAndApply(input: {
  featureId: string;
  enabled: boolean;
}): Promise<{
  enabled: string[];
  source: string;
  restartRequired: boolean;
  runtimeApplied?: boolean;
  error?: string;
}> {
  const previous = loadFeatureRuntimeConfig();
  const result = setFeatureEnabled(input);
  if (result.error) return result;

  try {
    await activateConfiguredFeatures();
    reloadFeatureDependentRegistries();
    reloadRegisteredGroupsFromHost();
    return {
      ...result,
      restartRequired: false,
      runtimeApplied: true,
    };
  } catch (err) {
    if (previous.source !== 'env') {
      saveLocalFeatureRuntimeConfig(previous.enabled);
      try {
        await activateConfiguredFeatures();
        reloadFeatureDependentRegistries();
        reloadRegisteredGroupsFromHost();
      } catch (rollbackErr) {
        logger.error(
          { err: rollbackErr, featureId: input.featureId },
          'Feature runtime rollback failed',
        );
      }
    }
    return {
      enabled: previous.enabled,
      source: previous.source,
      restartRequired: true,
      error: `Feature runtime reload failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export function getFeatureDeletionSummary(
  featureId: string,
): FeatureDeletionSummary {
  const feature = getInstalledFeature(featureId);
  const workflowTypes = listFeatureWorkflowTypes(feature);
  const groups = listFeatureGroupBindings(featureId).map((binding) => ({
    key: binding.group_key,
    jid: binding.group_jid,
    folder: binding.group_folder,
  }));
  const groupFolders = groups.map((group) => group.folder);
  const groupJids = groups.map((group) => group.jid);
  const legacyWorkflowTypes = listLegacyWorkflowTypesSafeForDeletion(
    featureId,
    workflowTypes,
  );
  const projectionTables = listFeatureOwnedProjectionTables(featureId);
  const workflowIds = listOwnedWorkflowIds({
    featureId,
    workflowTypes: legacyWorkflowTypes,
    groupJids,
  });
  const taskIds = listOwnedWorkbenchTaskIds(workflowIds, legacyWorkflowTypes);
  const queryIds = listOwnedAgentQueryIds(
    workflowIds,
    legacyWorkflowTypes,
    groupFolders,
  );
  const counts = {
    groups: groups.length,
    workflow_types: workflowTypes.length,
    workflows: workflowIds.length,
    workbench_tasks: taskIds.length,
    agent_queries: queryIds.length,
    messages:
      countRowsByValues('messages', 'chat_jid', groupJids) +
      countRowsByValues('messages', 'workflow_id', workflowIds),
    chats: countRowsByValues('chats', 'jid', groupJids),
    sessions: countRowsByValues('sessions', 'group_folder', groupFolders),
    feature_migrations: countRows(
      'feature_migrations',
      'feature_id = ?',
      featureId,
    ),
    feature_projection_tables: projectionTables.length,
    feature_projection_rows: projectionTables.reduce(
      (sum, table) => sum + table.rows,
      0,
    ),
  };
  const featureDataRoot = getFeatureDataRoot(featureId);
  const paths = [
    featureDataRoot.rootPath,
    ...groups.flatMap((group) => [
      path.join(GROUPS_DIR, group.folder),
      path.join(DATA_DIR, 'sessions', group.folder),
      path.join(DATA_DIR, 'ipc', group.folder),
    ]),
  ];
  return { featureId, workflowTypes, groups, projectionTables, counts, paths };
}

export async function deleteFeatureData(featureId: string): Promise<{
  summary: FeatureDeletionSummary;
  restartRequired: boolean;
}> {
  const summary = getFeatureDeletionSummary(featureId);
  const config = loadFeatureRuntimeConfig();
  if (config.enabled.includes(featureId)) {
    const disabled = await setFeatureEnabledAndApply({
      featureId,
      enabled: false,
    });
    if (disabled.error) {
      throw new Error(disabled.error);
    }
  }
  await stopFeatureGroupsForDeletion(featureId, summary.groups);

  const groupFolders = summary.groups.map((group) => group.folder);
  const groupJids = summary.groups.map((group) => group.jid);
  const legacyWorkflowTypes = listLegacyWorkflowTypesSafeForDeletion(
    featureId,
    summary.workflowTypes,
  );
  const workflowIds = listOwnedWorkflowIds({
    featureId,
    workflowTypes: legacyWorkflowTypes,
    groupJids,
  });
  const taskIds = listOwnedWorkbenchTaskIds(workflowIds, legacyWorkflowTypes);
  const queryIds = listOwnedAgentQueryIds(
    workflowIds,
    legacyWorkflowTypes,
    groupFolders,
  );

  for (const targetPath of summary.paths) {
    if (!fs.existsSync(targetPath)) continue;
    fs.rmSync(targetPath, { recursive: true, force: false });
  }

  const database = getDatabase();
  database.transaction(() => {
    deleteByValues('agent_query_events', 'query_id', queryIds);
    deleteByValues('agent_query_steps', 'query_id', queryIds);
    deleteByValues('agent_queries', 'query_id', queryIds);

    deleteByValues('workbench_context_assets', 'task_id', taskIds);
    deleteByValues('workbench_comments', 'task_id', taskIds);
    deleteByValues('workbench_action_items', 'task_id', taskIds);
    deleteByValues('workbench_artifacts', 'task_id', taskIds);
    deleteByValues('workbench_events', 'task_id', taskIds);
    deleteByValues('workbench_subtasks', 'task_id', taskIds);
    deleteByValues('workbench_tasks', 'id', taskIds);

    deleteByValues('workflow_stage_evaluations', 'workflow_id', workflowIds);
    deleteByValues('workflow_outbox', 'workflow_id', workflowIds);
    deleteByValues('workflow_checkpoints', 'workflow_id', workflowIds);
    deleteByValues(
      'workflow_interrupt_resume_attempts',
      'workflow_id',
      workflowIds,
    );
    deleteByValues('workflow_events', 'workflow_id', workflowIds);
    deleteByValues('workflow_interrupts', 'workflow_id', workflowIds);
    deleteByValues('delegations', 'workflow_id', workflowIds);
    deleteByValues('messages', 'workflow_id', workflowIds);
    deleteByValues('workflows', 'id', workflowIds);

    deleteByValues('scheduled_tasks', 'group_folder', groupFolders);
    deleteByValues('ask_questions', 'group_folder', groupFolders);
    deleteByValues('memories', 'group_folder', groupFolders);
    deleteByValues('memory_metrics', 'group_folder', groupFolders);
    deleteByValues('memory_extract_config', 'group_folder', groupFolders);
    deleteByValues('sessions', 'group_folder', groupFolders);
    deleteByValues('messages', 'chat_jid', groupJids);
    deleteByValues('chats', 'jid', groupJids);
    deleteByValues('registered_groups', 'jid', groupJids);

    database
      .prepare('DELETE FROM feature_group_bindings WHERE feature_id = ?')
      .run(featureId);
    database
      .prepare('DELETE FROM feature_migrations WHERE feature_id = ?')
      .run(featureId);
    dropFeatureOwnedProjectionTables(summary.projectionTables);
    recordFeatureAuditEvent({
      featureId,
      action: 'feature.delete_data',
      status: 'success',
      metadata: { summary },
    });
  })();
  reloadRegisteredGroupsFromHost();

  return { summary, restartRequired: false };
}

function getInstalledFeature(featureId: string): LoadedFeatureManifest {
  const feature = scanInstalledFeatures().find(
    (item) => item.manifest.id === featureId,
  );
  if (!feature) throw new Error(`Feature "${featureId}" is not installed`);
  return feature;
}

function listFeatureWorkflowTypes(feature: LoadedFeatureManifest): string[] {
  const resources = feature.manifest.resources || {};
  const relativeDir =
    resources.workflowDefinitions || './container/workflow-definitions';
  const dir = assertPathInsideFeature(
    feature.root,
    relativeDir,
    'resources.workflowDefinitions',
  );
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => path.basename(fileName, '.json'))
    .sort((a, b) => a.localeCompare(b));
}

function listCoreWorkflowTypes(): Set<string> {
  const dir = getWorkflowDefinitionsDir();
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => path.basename(fileName, '.json')),
  );
}

function listLegacyWorkflowTypesSafeForDeletion(
  featureId: string,
  workflowTypes: string[],
): string[] {
  const protectedTypes = listCoreWorkflowTypes();
  for (const feature of scanInstalledFeatures()) {
    if (feature.manifest.id === featureId) continue;
    for (const workflowType of listFeatureWorkflowTypes(feature)) {
      protectedTypes.add(workflowType);
    }
  }
  return workflowTypes.filter((workflowType) => {
    if (protectedTypes.has(workflowType)) {
      logger.warn(
        { featureId, workflowType },
        'Skipping legacy feature data deletion by workflow_type because the type is also declared elsewhere',
      );
      return false;
    }
    return true;
  });
}

function countRows(table: string, where: string, ...values: unknown[]): number {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(...values) as { count: number } | undefined;
  return Number(row?.count || 0);
}

function countRowsByValues(
  table: string,
  column: string,
  values: string[],
): number {
  if (values.length === 0) return 0;
  let count = 0;
  const stmt = getDatabase().prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
  );
  for (const value of values) {
    const row = stmt.get(value) as { count: number } | undefined;
    count += Number(row?.count || 0);
  }
  return count;
}

function reloadFeatureDependentRegistries(): void {
  clearWorkflowArtifactContractCache();
  clearWorkflowEvaluatorRegistryCache();
  loadWorkflowConfigs();
}

function reloadRegisteredGroupsFromHost(): void {
  try {
    hostHooks.reloadRegisteredGroups?.();
  } catch (err) {
    logger.error({ err }, 'Feature host registered group reload failed');
  }
}

async function stopFeatureGroupsForDeletion(
  featureId: string,
  groups: FeatureDeletionSummary['groups'],
): Promise<void> {
  if (!groups.length) return;
  await hostHooks.stopFeatureGroups?.(groups, {
    featureId,
    action: 'delete_data',
  });
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function countRowsInTable(tableName: string): number {
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(tableName)}`)
    .get() as { count: number } | undefined;
  return Number(row?.count || 0);
}

function listFeatureOwnedProjectionTables(
  featureId: string,
): FeatureOwnedTableSummary[] {
  const database = getDatabase();
  const names = new Set<string>();
  const stmt = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'",
  );
  for (const prefix of getFeatureOwnedTablePrefixes(featureId)) {
    for (const row of stmt.all(`${escapeSqlLike(prefix)}%`) as Array<{
      name: string;
    }>) {
      if (!row.name.startsWith('sqlite_')) names.add(row.name);
    }
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, rows: countRowsInTable(name) }));
}

function dropFeatureOwnedProjectionTables(
  tables: FeatureOwnedTableSummary[],
): void {
  const database = getDatabase();
  for (const table of tables) {
    database.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(table.name)}`);
  }
}

function listOwnedWorkflowIds(input: {
  featureId: string;
  workflowTypes: string[];
  groupJids: string[];
}): string[] {
  const database = getDatabase();
  const ids = new Set<string>();
  for (const row of database
    .prepare('SELECT id FROM workflows WHERE feature_id = ?')
    .all(input.featureId) as Array<{ id: string }>) {
    ids.add(row.id);
  }
  const byType = database.prepare(
    'SELECT id FROM workflows WHERE workflow_type = ? AND feature_id IS NULL',
  );
  for (const workflowType of input.workflowTypes) {
    for (const row of byType.all(workflowType) as Array<{ id: string }>) {
      ids.add(row.id);
    }
  }
  const bySourceJid = database.prepare(
    'SELECT id FROM workflows WHERE source_jid = ?',
  );
  for (const groupJid of input.groupJids) {
    for (const row of bySourceJid.all(groupJid) as Array<{ id: string }>) {
      ids.add(row.id);
    }
  }
  return [...ids];
}

function listOwnedWorkbenchTaskIds(
  workflowIds: string[],
  workflowTypes: string[],
): string[] {
  const database = getDatabase();
  const ids = new Set<string>();
  const byWorkflow = database.prepare(
    'SELECT id FROM workbench_tasks WHERE workflow_id = ?',
  );
  for (const workflowId of workflowIds) {
    for (const row of byWorkflow.all(workflowId) as Array<{ id: string }>) {
      ids.add(row.id);
    }
  }
  const byType = database.prepare(
    'SELECT id FROM workbench_tasks WHERE workflow_type = ?',
  );
  for (const workflowType of workflowTypes) {
    for (const row of byType.all(workflowType) as Array<{ id: string }>) {
      ids.add(row.id);
    }
  }
  return [...ids];
}

function listOwnedAgentQueryIds(
  workflowIds: string[],
  workflowTypes: string[],
  groupFolders: string[],
): string[] {
  const database = getDatabase();
  const ids = new Set<string>();
  const addBy = (column: string, values: string[]) => {
    const stmt = database.prepare(
      `SELECT query_id FROM agent_queries WHERE ${column} = ?`,
    );
    for (const value of values) {
      for (const row of stmt.all(value) as Array<{ query_id: string }>) {
        ids.add(row.query_id);
      }
    }
  };
  addBy('workflow_id', workflowIds);
  addBy('workflow_type', workflowTypes);
  addBy('group_folder', groupFolders);
  return [...ids];
}

function deleteByValues(table: string, column: string, values: string[]): void {
  if (values.length === 0) return;
  const stmt = getDatabase().prepare(
    `DELETE FROM ${table} WHERE ${column} = ?`,
  );
  for (const value of values) stmt.run(value);
}
