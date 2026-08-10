import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT } from '../config.js';
import type { Sha256Hash } from '../workflow-runtime/contracts/types.js';
import {
  registryResourceId,
  type WorkflowRuntimeStore,
} from '../workflow-runtime/gateway/workflow-packs.js';
import {
  loadWorkflowPackDesiredConfig,
  saveWorkflowPackDesiredConfig,
  WORKFLOW_PACK_CONFIG_PATH,
  WORKFLOW_PACK_SOURCE_ROOT,
} from './config.js';
import { getWorkflowPackManagedDataRoot } from './data-roots.js';
import { parseWorkflowPackExecutionPermissions } from './permissions.js';
import {
  assertSafeWorkflowPackId,
  parseWorkflowPackManifest,
} from './manifest.js';
import {
  disableWorkflowPack,
  reconcileWorkflowPacks,
  WORKFLOW_PACK_EXECUTION_STAGING_ROOT,
  type WorkflowPackReconciliationReport,
} from './reconciler.js';

export type WorkflowPackManagementState =
  | 'enabled'
  | 'pending_restart'
  | 'invalid'
  | 'draining'
  | 'disabled'
  | 'source_missing';

export interface WorkflowPackManagementInfo {
  readonly pack_id: string;
  readonly display_name: string;
  readonly description: string | null;
  readonly version: string | null;
  readonly desired_enabled: boolean;
  readonly state: WorkflowPackManagementState;
  readonly source_present: boolean;
  readonly active_release: {
    readonly release_id: string;
    readonly release_hash: Sha256Hash;
    readonly row_version: number;
  } | null;
  readonly recipes: Array<{
    readonly id: string;
    readonly version: string;
    readonly content_hash: Sha256Hash;
  }>;
  readonly permissions: Record<string, unknown> | null;
  readonly active_run_pins: number;
  readonly error: string | null;
  readonly actions: {
    readonly disable: boolean;
    readonly uninstall: boolean;
    readonly purge: boolean;
  };
}

export interface WorkflowPackPurgePreview {
  readonly pack_id: string;
  readonly managed_paths: string[];
  readonly registry_resource_ids: string[];
  readonly retained_release_count: number;
  readonly active_run_pins: number;
  readonly preserves: readonly [
    'task_sessions',
    'runtime_history',
    'shared_artifacts',
    'audit',
    'external_workspaces',
  ];
}

interface ActiveRow extends Record<string, unknown> {
  release_id: string;
  release_hash: Sha256Hash;
  row_version: number;
  status: string;
}

interface SourceInfo {
  displayName: string;
  description: string | null;
  version: string | null;
  permissions: Record<string, unknown> | null;
  error: string | null;
}

const PRESERVED_DOMAINS = [
  'task_sessions',
  'runtime_history',
  'shared_artifacts',
  'audit',
  'external_workspaces',
] as const;

export class WorkflowPackManager {
  private report: WorkflowPackReconciliationReport | null = null;

  constructor(
    private readonly store: WorkflowRuntimeStore,
    private readonly options: {
      readonly sourceRoot?: string;
      readonly configPath?: string;
      readonly stagingRoot?: string;
      readonly uninstallArchiveRoot?: string;
      readonly now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sourceRoot(): string {
    return this.options.sourceRoot ?? WORKFLOW_PACK_SOURCE_ROOT;
  }

  private configPath(): string {
    return this.options.configPath ?? WORKFLOW_PACK_CONFIG_PATH;
  }

  private stagingRoot(): string {
    return this.options.stagingRoot ?? WORKFLOW_PACK_EXECUTION_STAGING_ROOT;
  }

  reconcileAtStartup(): WorkflowPackReconciliationReport {
    this.report = reconcileWorkflowPacks(this.store, {
      nowMs: this.now(),
      sourceRoot: this.sourceRoot(),
      configPath: this.configPath(),
      stagingRoot: this.stagingRoot(),
    });
    return this.report;
  }

  private installedIds(): string[] {
    const root = this.sourceRoot();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((packId) => fs.existsSync(path.join(root, packId, 'pack.json')))
      .sort((left, right) => left.localeCompare(right));
  }

  private sourceInfo(packId: string): SourceInfo {
    const manifestPath = path.join(this.sourceRoot(), packId, 'pack.json');
    if (!fs.existsSync(manifestPath)) {
      return {
        displayName: packId,
        description: null,
        version: null,
        permissions: null,
        error: null,
      };
    }
    try {
      const manifest = parseWorkflowPackManifest(fs.readFileSync(manifestPath));
      return {
        displayName: manifest.display_name,
        description: manifest.description,
        version: manifest.pack_ref.version,
        permissions: manifest.permissions as Record<string, unknown>,
        error: null,
      };
    } catch (error) {
      return {
        displayName: packId,
        description: null,
        version: null,
        permissions: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private active(packId: string): ActiveRow | undefined {
    return this.store.queryOne<ActiveRow>(
      `SELECT active.release_id, active.release_hash, active.row_version,
              release.status
         FROM workflow_pack_active_releases active
         JOIN workflow_pack_releases release
           ON release.id = active.release_id
          AND release.release_hash = active.release_hash
        WHERE active.pack_id = ?`,
      [packId],
    );
  }

  private activeRunPins(packId: string): number {
    return (
      this.store.queryOne<{ count: number }>(
        `SELECT count(DISTINCT active_run.id) AS count
           FROM workflow_registry_retention_handles published
           JOIN workflow_pack_releases release
             ON release.id = published.pack_release_id
           JOIN workflow_registry_retention_handles active_run
             ON active_run.closure_manifest_id = published.closure_manifest_id
            AND active_run.closure_hash = published.closure_hash
            AND active_run.handle_kind = 'active_run'
            AND active_run.status = 'held'
          WHERE release.pack_id = ? AND published.handle_kind = 'published'`,
        [packId],
      )?.count ?? 0
    );
  }

  private activePermissions(packId: string): Record<string, unknown> | null {
    const row = this.store.queryOne<{ artifact_json: string }>(
      `SELECT value.inline_canonical_json AS artifact_json
         FROM workflow_pack_active_releases active
         JOIN workflow_pack_releases release
           ON release.id = active.release_id
          AND release.release_hash = active.release_hash
          AND release.status = 'active'
         JOIN workflow_registry_resources artifact
           ON artifact.id = release.execution_artifact_resource_id
          AND artifact.content_hash = release.execution_artifact_hash
          AND artifact.resource_type = 'pack_execution_artifact'
          AND artifact.publication_state = 'published'
         JOIN workflow_values value
           ON value.id = artifact.canonical_value_id
          AND value.content_hash = artifact.content_hash
          AND value.storage_kind = 'inline' AND value.payload_state = 'live'
        WHERE active.pack_id = ?`,
      [packId],
    );
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json) as Record<string, unknown>;
    return parseWorkflowPackExecutionPermissions(artifact.permissions);
  }

  private recipes(packId: string): WorkflowPackManagementInfo['recipes'] {
    return this.store.queryAll(
      `SELECT resource.resource_id AS id,
              resource.resource_version AS version,
              release_resource.content_hash
         FROM workflow_pack_releases release
         JOIN workflow_pack_release_resources release_resource
           ON release_resource.release_id = release.id
         JOIN workflow_registry_resources resource
           ON resource.id = release_resource.resource_id
          AND resource.content_hash = release_resource.content_hash
        WHERE release.pack_id = ? AND resource.resource_type = 'recipe'
        ORDER BY resource.resource_id COLLATE BINARY,
                 resource.resource_version COLLATE BINARY`,
      [packId],
    );
  }

  list(): WorkflowPackManagementInfo[] {
    const desiredConfig = loadWorkflowPackDesiredConfig(this.configPath());
    const desired = new Set(desiredConfig.enabled);
    const installed = new Set(this.installedIds());
    const runtimeIds = this.store
      .queryAll<{
        pack_id: string;
      }>(
        'SELECT DISTINCT pack_id FROM workflow_pack_releases ORDER BY pack_id COLLATE BINARY',
        [],
      )
      .map((row) => row.pack_id);
    const ids = [...new Set([...desired, ...installed, ...runtimeIds])].sort(
      (left, right) => left.localeCompare(right),
    );
    return ids.map((packId) => {
      const source = this.sourceInfo(packId);
      const active = this.active(packId);
      const reportItem = this.report?.items.find(
        (candidate) => candidate.pack_id === packId,
      );
      let state: WorkflowPackManagementState;
      if (desired.has(packId) && !installed.has(packId))
        state = 'source_missing';
      else if (
        desired.has(packId) &&
        (source.error || reportItem?.state === 'invalid')
      )
        state = 'invalid';
      else if (active) state = desired.has(packId) ? 'enabled' : 'draining';
      else if (desired.has(packId)) state = 'pending_restart';
      else state = 'disabled';
      const activeRunPins = this.activeRunPins(packId);
      return {
        pack_id: packId,
        display_name: source.displayName,
        description: source.description,
        version: source.version,
        desired_enabled: desired.has(packId),
        state,
        source_present: installed.has(packId),
        active_release: active
          ? {
              release_id: active.release_id,
              release_hash: active.release_hash,
              row_version: active.row_version,
            }
          : null,
        recipes: this.recipes(packId),
        permissions: active ? this.activePermissions(packId) : null,
        active_run_pins: activeRunPins,
        error: source.error ?? reportItem?.error ?? null,
        actions: {
          disable: Boolean(active) || desired.has(packId),
          uninstall: !active && installed.has(packId),
          purge: !active,
        },
      };
    });
  }

  setDesiredEnabled(
    packId: string,
    enabled: boolean,
  ): {
    restart_required: true;
    desired_enabled: boolean;
    runtime_disabled: boolean;
  } {
    assertSafeWorkflowPackId(packId);
    const config = loadWorkflowPackDesiredConfig(this.configPath());
    const next = new Set(config.enabled);
    if (enabled) next.add(packId);
    else next.delete(packId);
    saveWorkflowPackDesiredConfig([...next], this.configPath());
    const disabled = enabled
      ? { disabled: false }
      : disableWorkflowPack(this.store, packId, this.now());
    return {
      restart_required: true,
      desired_enabled: enabled,
      runtime_disabled: disabled.disabled,
    };
  }

  uninstall(packId: string): {
    archived_path: string;
    restart_required: true;
  } {
    assertSafeWorkflowPackId(packId);
    if (this.active(packId)) {
      throw new Error('Workflow Pack must be disabled before uninstall');
    }
    const source = path.join(this.sourceRoot(), packId);
    if (!fs.existsSync(path.join(source, 'pack.json'))) {
      throw new Error(`Workflow Pack source is not installed: ${packId}`);
    }
    const config = loadWorkflowPackDesiredConfig(this.configPath());
    if (config.enabled.includes(packId)) {
      saveWorkflowPackDesiredConfig(
        config.enabled.filter((candidate) => candidate !== packId),
        this.configPath(),
      );
    }
    const archiveRoot =
      this.options.uninstallArchiveRoot ??
      path.join(PROJECT_ROOT, 'local', 'workflow-pack-uninstalled');
    fs.mkdirSync(archiveRoot, { recursive: true });
    const archivedPath = path.join(
      archiveRoot,
      `${packId}-${this.now().toString(10)}`,
    );
    fs.renameSync(source, archivedPath);
    return { archived_path: archivedPath, restart_required: true };
  }

  private purgeableRegistryResources(packId: string): string[] {
    return this.store
      .queryAll<{ id: string }>(
        `SELECT resource.id
           FROM workflow_registry_resources resource
          WHERE resource.owner_pack_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM workflow_pack_release_resources release_resource
               WHERE release_resource.resource_id = resource.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_registry_closure_members closure_member
               WHERE closure_member.resource_id = resource.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_registry_retention_handle_members retained
               WHERE retained.resource_id = resource.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_registry_resource_dependencies dependency
               WHERE dependency.dependency_resource_id = resource.id
            )
          ORDER BY resource.id COLLATE BINARY`,
        [packId],
      )
      .map((row) => row.id);
  }

  purgePreview(packId: string): WorkflowPackPurgePreview {
    assertSafeWorkflowPackId(packId);
    const managedRoot = getWorkflowPackManagedDataRoot(packId).root_path;
    const stagingRoot = path.join(this.stagingRoot(), packId);
    const managedPaths = [managedRoot, stagingRoot].filter((candidate) =>
      fs.existsSync(candidate),
    );
    return {
      pack_id: packId,
      managed_paths: managedPaths,
      registry_resource_ids: this.purgeableRegistryResources(packId),
      retained_release_count:
        this.store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_pack_releases WHERE pack_id = ?',
          [packId],
        )?.count ?? 0,
      active_run_pins: this.activeRunPins(packId),
      preserves: PRESERVED_DOMAINS,
    };
  }

  purge(packId: string): WorkflowPackPurgePreview {
    assertSafeWorkflowPackId(packId);
    if (this.active(packId)) {
      throw new Error('Workflow Pack must be disabled before purge');
    }
    const preview = this.purgePreview(packId);
    if (preview.active_run_pins > 0) {
      throw new Error(
        `Workflow Pack ${packId} still has ${preview.active_run_pins} active Run pin(s)`,
      );
    }
    for (const target of preview.managed_paths) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (preview.registry_resource_ids.length > 0) {
      this.store.withImmediateTransaction((transaction) => {
        for (const resourceId of preview.registry_resource_ids) {
          const row = transaction.queryOne<{
            canonical_value_id: string;
            resource_type: string;
            resource_id: string;
            resource_version: string;
            content_hash: Sha256Hash;
          }>(
            `SELECT canonical_value_id, resource_type, resource_id,
                    resource_version, content_hash
               FROM workflow_registry_resources
              WHERE id = ? AND owner_pack_id = ?`,
            [resourceId, packId],
          );
          if (!row) continue;
          const expectedId = registryResourceId({
            resource_type: row.resource_type as never,
            ref: { id: row.resource_id, version: row.resource_version },
          });
          if (expectedId !== resourceId) {
            throw new Error(
              `Registry resource identity drifted: ${resourceId}`,
            );
          }
          transaction.execute(
            'DELETE FROM workflow_registry_resource_dependencies WHERE resource_id = ?',
            [resourceId],
          );
          transaction.execute(
            'DELETE FROM workflow_registry_resources WHERE id = ? AND content_hash = ?',
            [resourceId, row.content_hash],
          );
          transaction.execute(
            `DELETE FROM workflow_values WHERE id = ?
              AND NOT EXISTS (
                SELECT 1 FROM workflow_registry_resources
                 WHERE canonical_value_id = ?
              )`,
            [row.canonical_value_id, row.canonical_value_id],
          );
        }
      });
    }
    return preview;
  }
}
