import fs from 'fs';
import path from 'path';

import { DATA_DIR, AGENTS_DIR } from '../config.js';
import {
  getDatabase,
  listFeatureAgentBindings,
  recordFeatureAuditEvent,
} from '../db.js';
import { logger } from '../logger.js';
import {
  loadFeatureRuntimeConfig,
  saveLocalFeatureRuntimeConfig,
} from './config.js';
import { LoadedFeatureManifest } from './manifest.js';
import {
  activateConfiguredFeatures,
  scanInstalledFeatures,
} from './runtime.js';
import {
  getFeatureDataRoot,
  listExternalFeatureDataRoots,
} from './data-roots.js';
import { getFeatureOwnedTablePrefixes } from './naming.js';

export interface FeatureOwnedTableSummary {
  name: string;
  rows: number;
}

export interface FeatureDeletionSummary {
  featureId: string;
  agents: Array<{ key: string; jid: string; folder: string }>;
  projectionTables: FeatureOwnedTableSummary[];
  externalDataRoots: Array<{
    rootId: string;
    rootPath: string;
    readonly: boolean;
  }>;
  counts: Record<string, number>;
  paths: string[];
}

export interface FeatureManagementHostHooks {
  reloadRegisteredAgents?: () => void;
  stopFeatureAgents?: (
    agents: FeatureDeletionSummary['agents'],
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
    reloadRegisteredAgentsFromHost();
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
        reloadRegisteredAgentsFromHost();
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
  getInstalledFeature(featureId);
  const agents = listFeatureAgentBindings(featureId).map((binding) => ({
    key: binding.agent_key,
    jid: binding.agent_jid,
    folder: binding.agent_folder,
  }));
  const agentFolders = agents.map((agent) => agent.folder);
  const agentJids = agents.map((agent) => agent.jid);
  const projectionTables = listFeatureOwnedProjectionTables(featureId);
  const externalDataRoots = listExternalFeatureDataRoots(featureId).map(
    (root) => ({
      rootId: root.rootId || '',
      rootPath: root.rootPath,
      readonly: root.readonly !== false,
    }),
  );
  const queryIds = listOwnedAgentQueryIds(agentFolders);
  const counts = {
    agents: agents.length,
    agent_queries: queryIds.length,
    messages: countRowsByValues('messages', 'chat_jid', agentJids),
    chats: countRowsByValues('chats', 'jid', agentJids),
    sessions: countRowsByValues('sessions', 'agent_folder', agentFolders),
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
    external_feature_data_roots: externalDataRoots.length,
  };
  const featureDataRoot = getFeatureDataRoot(featureId);
  const paths = [
    featureDataRoot.rootPath,
    ...agents.flatMap((agent) => [
      path.join(AGENTS_DIR, agent.folder),
      path.join(DATA_DIR, 'sessions', agent.folder),
      path.join(DATA_DIR, 'ipc', agent.folder),
    ]),
  ];
  return {
    featureId,
    agents,
    projectionTables,
    externalDataRoots,
    counts,
    paths,
  };
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
  await stopFeatureAgentsForDeletion(featureId, summary.agents);

  const agentFolders = summary.agents.map((agent) => agent.folder);
  const agentJids = summary.agents.map((agent) => agent.jid);
  const queryIds = listOwnedAgentQueryIds(agentFolders);

  for (const targetPath of summary.paths) {
    if (!fs.existsSync(targetPath)) continue;
    fs.rmSync(targetPath, { recursive: true, force: false });
  }

  const database = getDatabase();
  database.transaction(() => {
    deleteByValues('agent_query_events', 'query_id', queryIds);
    deleteByValues('agent_query_steps', 'query_id', queryIds);
    deleteByValues('agent_queries', 'query_id', queryIds);

    deleteByValues('scheduled_tasks', 'agent_folder', agentFolders);
    deleteByValues('ask_questions', 'agent_folder', agentFolders);
    deleteByValues('memories', 'agent_folder', agentFolders);
    deleteByValues('memory_metrics', 'agent_folder', agentFolders);
    deleteByValues('memory_extract_config', 'agent_folder', agentFolders);
    deleteByValues('sessions', 'agent_folder', agentFolders);
    deleteByValues('messages', 'chat_jid', agentJids);
    deleteByValues('chats', 'jid', agentJids);
    deleteByValues('registered_agents', 'jid', agentJids);

    database
      .prepare('DELETE FROM feature_agent_bindings WHERE feature_id = ?')
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
  reloadRegisteredAgentsFromHost();

  return { summary, restartRequired: false };
}

function getInstalledFeature(featureId: string): LoadedFeatureManifest {
  const feature = scanInstalledFeatures().find(
    (item) => item.manifest.id === featureId,
  );
  if (!feature) throw new Error(`Feature "${featureId}" is not installed`);
  return feature;
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

function reloadRegisteredAgentsFromHost(): void {
  try {
    hostHooks.reloadRegisteredAgents?.();
  } catch (err) {
    logger.error({ err }, 'Feature host registered agent reload failed');
  }
}

async function stopFeatureAgentsForDeletion(
  featureId: string,
  agents: FeatureDeletionSummary['agents'],
): Promise<void> {
  if (!agents.length) return;
  await hostHooks.stopFeatureAgents?.(agents, {
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

function listOwnedAgentQueryIds(agentFolders: string[]): string[] {
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
  addBy('agent_folder', agentFolders);
  return [...ids];
}

function deleteByValues(table: string, column: string, values: string[]): void {
  if (values.length === 0) return;
  const stmt = getDatabase().prepare(
    `DELETE FROM ${table} WHERE ${column} = ?`,
  );
  for (const value of values) stmt.run(value);
}
