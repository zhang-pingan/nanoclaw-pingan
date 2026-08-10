import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import {
  publishWorkflowBundleInTransaction,
  registryClosureId,
  registryResourceId,
  workflowPackReleaseId,
  workflowPublishedRetentionHandleId,
  type WorkflowRuntimeStore,
  type WorkflowRuntimeWriteTransaction,
} from '../workflow-runtime/gateway/workflow-packs.js';
import { canonicalJson } from '../workflow-runtime/contracts/hash.js';
import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import {
  loadWorkflowPackDesiredConfig,
  WORKFLOW_PACK_CONFIG_PATH,
  WORKFLOW_PACK_SOURCE_ROOT,
} from './config.js';
import {
  loadWorkflowPack,
  stageWorkflowPackExecutionResources,
  type LoadedWorkflowPack,
  type WorkflowPackHostBindingAllowlist,
} from './loader.js';

export type WorkflowPackReconciliationState =
  | 'enabled'
  | 'invalid'
  | 'disabled'
  | 'source_missing';

export interface WorkflowPackReconciliationItem {
  readonly pack_id: string;
  readonly desired_enabled: boolean;
  readonly state: WorkflowPackReconciliationState;
  readonly release_id: string | null;
  readonly release_hash: Sha256Hash | null;
  readonly error: string | null;
  readonly execution_staging_path: string | null;
}

export interface WorkflowPackReconciliationReport {
  readonly reconciled_at_ms: number;
  readonly items: WorkflowPackReconciliationItem[];
}

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  pack_id: string;
  release_ref: string;
  release_version: string;
  release_hash: Sha256Hash;
  execution_artifact_resource_id: string | null;
  execution_artifact_hash: Sha256Hash | null;
  status: 'staged' | 'active' | 'draining' | 'disabled' | 'deleting';
  activated_at_ms: number | null;
  disabled_at_ms: number | null;
  row_version: number;
}

interface PointerRow extends Record<string, unknown> {
  pack_id: string;
  release_id: string;
  release_hash: Sha256Hash;
  row_version: number;
}

export const WORKFLOW_PACK_EXECUTION_STAGING_ROOT = path.join(
  DATA_DIR,
  'workflow-pack-execution',
);

export function loadCoreWorkflowPackBindingAllowlist(
  store: WorkflowRuntimeStore,
): WorkflowPackHostBindingAllowlist {
  const rows = store.queryAll<{
    resource_type: string;
    resource_id: string;
    resource_version: string;
  }>(
    `SELECT resource_type, resource_id, resource_version
       FROM workflow_registry_resources
      WHERE owner_core_ref IS NOT NULL AND owner_pack_id IS NULL
        AND owner_principal_ref IS NULL AND publication_state = 'published'
        AND resource_type IN ('capability', 'executor_implementation', 'outbox_adapter')`,
    [],
  );
  const refs = (resourceType: string): ReadonlySet<string> =>
    new Set(
      rows
        .filter((row) => row.resource_type === resourceType)
        .map((row) => `${row.resource_id}@${row.resource_version}`),
    );
  const systemRecipe = store.queryOne<{ inline_canonical_json: string }>(
    `SELECT value.inline_canonical_json
       FROM workflow_registry_resources resource
       JOIN workflow_values value
         ON value.id = resource.canonical_value_id
        AND value.content_hash = resource.content_hash
        AND value.storage_kind = 'inline' AND value.payload_state = 'live'
      WHERE resource.resource_type = 'recipe'
        AND resource.owner_core_ref IS NOT NULL
        AND resource.owner_pack_id IS NULL
        AND resource.owner_principal_ref IS NULL
        AND resource.publication_state = 'published'
        AND json_extract(value.inline_canonical_json, '$.catalog_visibility') = 'system_only'
        AND json_type(value.inline_canonical_json, '$.compiler_input_snapshot') = 'object'
      ORDER BY resource.id COLLATE BINARY LIMIT 1`,
    [],
  );
  const compilerSnapshot = systemRecipe
    ? ((JSON.parse(systemRecipe.inline_canonical_json) as JsonObject)
        .compiler_input_snapshot as JsonObject)
    : null;
  return {
    capabilities: refs('capability'),
    executors: refs('executor_implementation'),
    adapters: refs('outbox_adapter'),
    compilerSnapshot,
  };
}

function exactReleaseResources(
  transaction: WorkflowRuntimeWriteTransaction,
  releaseId: string,
): Array<{ resource_id: string; content_hash: string; resource_role: string }> {
  return transaction.queryAll(
    `SELECT resource_id, content_hash, resource_role
       FROM workflow_pack_release_resources
      WHERE release_id = ? ORDER BY resource_id COLLATE BINARY`,
    [releaseId],
  );
}

function insertOrVerifyRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  pack: LoadedWorkflowPack,
  nowMs: number,
): ReleaseRow {
  const releaseId = workflowPackReleaseId(pack.manifest.pack_ref);
  const executionArtifactId = registryResourceId(pack.executionArtifact);
  const existing = transaction.queryOne<ReleaseRow>(
    `SELECT id, pack_id, release_ref, release_version, release_hash,
            execution_artifact_resource_id, execution_artifact_hash, status,
            activated_at_ms, disabled_at_ms, row_version
       FROM workflow_pack_releases
      WHERE id = ? OR (pack_id = ? AND release_ref = ? AND release_version = ?)`,
    [
      releaseId,
      pack.manifest.pack_ref.id,
      pack.manifest.pack_ref.id,
      pack.manifest.pack_ref.version,
    ],
  );
  const expectedResources = pack.registryBatch.resources
    .map((resource) => ({
      resource_id: registryResourceId(resource),
      content_hash: resource.content_hash,
      resource_role:
        resource.resource_type === 'pack_execution_artifact'
          ? 'closure_root'
          : 'closure_member',
    }))
    .sort((left, right) => left.resource_id.localeCompare(right.resource_id));
  if (existing) {
    if (
      existing.id !== releaseId ||
      existing.pack_id !== pack.manifest.pack_ref.id ||
      existing.release_ref !== pack.manifest.pack_ref.id ||
      existing.release_version !== pack.manifest.pack_ref.version ||
      existing.release_hash !== pack.releaseHash ||
      existing.execution_artifact_resource_id !== executionArtifactId ||
      existing.execution_artifact_hash !==
        pack.executionArtifact.content_hash ||
      canonicalJson(exactReleaseResources(transaction, releaseId)) !==
        canonicalJson(expectedResources)
    ) {
      throw new Error(
        `Workflow Pack release identity collision at ${releaseId}`,
      );
    }
    return existing;
  }
  transaction.execute(
    `INSERT INTO workflow_pack_releases (
      id, pack_id, release_ref, release_version, release_hash,
      execution_artifact_resource_id, execution_artifact_hash, status,
      staged_at_ms, activated_at_ms, disabled_at_ms, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL, NULL, 1)`,
    [
      releaseId,
      pack.manifest.pack_ref.id,
      pack.manifest.pack_ref.id,
      pack.manifest.pack_ref.version,
      pack.releaseHash,
      executionArtifactId,
      pack.executionArtifact.content_hash,
      nowMs,
    ],
  );
  for (const resource of expectedResources) {
    transaction.execute(
      `INSERT INTO workflow_pack_release_resources (
        release_id, resource_id, content_hash, resource_role
      ) VALUES (?, ?, ?, ?)`,
      [
        releaseId,
        resource.resource_id,
        resource.content_hash,
        resource.resource_role,
      ],
    );
  }
  const handleId = workflowPublishedRetentionHandleId(
    pack.manifest.pack_ref,
    pack.registryBatch.closure.ref,
  );
  transaction.execute(
    `INSERT INTO workflow_registry_retention_handles (
      id, handle_kind, pack_release_id, graph_run_id, backup_id,
      external_actor_ref, closure_manifest_id, closure_hash, status,
      created_at_ms, released_at_ms, row_version
    ) VALUES (?, 'published', ?, NULL, NULL, NULL, ?, ?, 'held', ?, NULL, 1)`,
    [
      handleId,
      releaseId,
      registryClosureId(pack.registryBatch.closure.ref),
      pack.registryBatch.closure.closure_hash,
      nowMs,
    ],
  );
  for (const resource of expectedResources) {
    transaction.execute(
      `INSERT INTO workflow_registry_retention_handle_members (
        handle_id, resource_id, content_hash
      ) VALUES (?, ?, ?)`,
      [handleId, resource.resource_id, resource.content_hash],
    );
  }
  return transaction.queryOne<ReleaseRow>(
    `SELECT id, pack_id, release_ref, release_version, release_hash,
            execution_artifact_resource_id, execution_artifact_hash, status,
            activated_at_ms, disabled_at_ms, row_version
       FROM workflow_pack_releases WHERE id = ?`,
    [releaseId],
  )!;
}

function transitionReleaseToActive(
  transaction: WorkflowRuntimeWriteTransaction,
  release: ReleaseRow,
  nowMs: number,
): void {
  if (release.status === 'active') return;
  if (!['staged', 'draining', 'disabled'].includes(release.status)) {
    throw new Error(
      `Workflow Pack release ${release.id} cannot activate from ${release.status}`,
    );
  }
  const activatedAt = release.activated_at_ms ?? nowMs;
  const result = transaction.execute(
    `UPDATE workflow_pack_releases
        SET status = 'active', activated_at_ms = ?, disabled_at_ms = NULL,
            row_version = row_version + 1
      WHERE id = ? AND release_hash = ? AND status = ? AND row_version = ?`,
    [
      activatedAt,
      release.id,
      release.release_hash,
      release.status,
      release.row_version,
    ],
  );
  if (result.changes !== 1) {
    throw new Error(
      `Workflow Pack release activation CAS failed: ${release.id}`,
    );
  }
}

function drainRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  releaseId: string,
  releaseHash: Sha256Hash,
): void {
  const result = transaction.execute(
    `UPDATE workflow_pack_releases
        SET status = 'draining', row_version = row_version + 1
      WHERE id = ? AND release_hash = ? AND status = 'active'`,
    [releaseId, releaseHash],
  );
  if (result.changes !== 1) {
    throw new Error(`Workflow Pack release drain CAS failed: ${releaseId}`);
  }
}

function finishDisabledRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  releaseId: string,
  releaseHash: Sha256Hash,
  nowMs: number,
): void {
  const result = transaction.execute(
    `UPDATE workflow_pack_releases
        SET status = 'disabled', disabled_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND release_hash = ? AND status = 'draining'`,
    [nowMs, releaseId, releaseHash],
  );
  if (result.changes !== 1) {
    throw new Error(`Workflow Pack release disable CAS failed: ${releaseId}`);
  }
}

function activateRelease(
  transaction: WorkflowRuntimeWriteTransaction,
  release: ReleaseRow,
  nowMs: number,
): void {
  const pointer = transaction.queryOne<PointerRow>(
    `SELECT pack_id, release_id, release_hash, row_version
       FROM workflow_pack_active_releases WHERE pack_id = ?`,
    [release.pack_id],
  );
  if (
    pointer?.release_id === release.id &&
    pointer.release_hash === release.release_hash &&
    release.status === 'active'
  ) {
    return;
  }
  if (pointer)
    drainRelease(transaction, pointer.release_id, pointer.release_hash);
  transitionReleaseToActive(transaction, release, nowMs);
  if (pointer) {
    const updated = transaction.execute(
      `UPDATE workflow_pack_active_releases
          SET release_id = ?, release_hash = ?, row_version = row_version + 1,
              activated_at_ms = ?
        WHERE pack_id = ? AND release_id = ? AND release_hash = ?
          AND row_version = ?`,
      [
        release.id,
        release.release_hash,
        nowMs,
        release.pack_id,
        pointer.release_id,
        pointer.release_hash,
        pointer.row_version,
      ],
    );
    if (updated.changes !== 1) {
      throw new Error(
        `Workflow Pack active pointer CAS failed: ${release.pack_id}`,
      );
    }
    finishDisabledRelease(
      transaction,
      pointer.release_id,
      pointer.release_hash,
      nowMs,
    );
  } else {
    transaction.execute(
      `INSERT INTO workflow_pack_active_releases (
        pack_id, release_id, release_hash, row_version, activated_at_ms
      ) VALUES (?, ?, ?, 1, ?)`,
      [release.pack_id, release.id, release.release_hash, nowMs],
    );
  }
}

export function publishAndActivateWorkflowPack(
  store: WorkflowRuntimeStore,
  pack: LoadedWorkflowPack,
  nowMs: number,
): { release_id: string; release_hash: Sha256Hash } {
  return store.withImmediateTransaction((transaction) => {
    publishWorkflowBundleInTransaction(transaction, {
      owner: { kind: 'pack', pack_id: pack.manifest.pack_ref.id },
      resources: pack.registryBatch.resources,
      registry_batch: pack.registryBatch,
      published_at_ms: nowMs,
      publication_ref: `pack:${pack.manifest.pack_ref.id}@${pack.manifest.pack_ref.version}`,
    });
    const release = insertOrVerifyRelease(transaction, pack, nowMs);
    activateRelease(transaction, release, nowMs);
    return { release_id: release.id, release_hash: release.release_hash };
  });
}

export function disableWorkflowPack(
  store: WorkflowRuntimeStore,
  packId: string,
  nowMs: number,
): { disabled: boolean; release_id: string | null } {
  return store.withImmediateTransaction((transaction) => {
    const pointer = transaction.queryOne<PointerRow>(
      `SELECT pack_id, release_id, release_hash, row_version
         FROM workflow_pack_active_releases WHERE pack_id = ?`,
      [packId],
    );
    if (!pointer) return { disabled: false, release_id: null };
    drainRelease(transaction, pointer.release_id, pointer.release_hash);
    const deleted = transaction.execute(
      `DELETE FROM workflow_pack_active_releases
        WHERE pack_id = ? AND release_id = ? AND release_hash = ?
          AND row_version = ?`,
      [packId, pointer.release_id, pointer.release_hash, pointer.row_version],
    );
    if (deleted.changes !== 1) {
      throw new Error(
        `Workflow Pack active pointer delete CAS failed: ${packId}`,
      );
    }
    finishDisabledRelease(
      transaction,
      pointer.release_id,
      pointer.release_hash,
      nowMs,
    );
    return { disabled: true, release_id: pointer.release_id };
  });
}

function installedPackDirectories(sourceRoot: string): string[] {
  if (!fs.existsSync(sourceRoot)) return [];
  return fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((packId) =>
      fs.existsSync(path.join(sourceRoot, packId, 'pack.json')),
    )
    .sort((left, right) => left.localeCompare(right));
}

export function reconcileWorkflowPacks(
  store: WorkflowRuntimeStore,
  options: {
    readonly nowMs?: number;
    readonly sourceRoot?: string;
    readonly configPath?: string;
    readonly stagingRoot?: string;
  } = {},
): WorkflowPackReconciliationReport {
  const nowMs = options.nowMs ?? Date.now();
  const sourceRoot = options.sourceRoot ?? WORKFLOW_PACK_SOURCE_ROOT;
  const configPath = options.configPath ?? WORKFLOW_PACK_CONFIG_PATH;
  const stagingRoot =
    options.stagingRoot ?? WORKFLOW_PACK_EXECUTION_STAGING_ROOT;
  const config = loadWorkflowPackDesiredConfig(configPath);
  const desired = new Set(config.enabled);
  const installed = new Set(installedPackDirectories(sourceRoot));
  const activeIds = store
    .queryAll<{
      pack_id: string;
    }>(
      'SELECT pack_id FROM workflow_pack_active_releases ORDER BY pack_id COLLATE BINARY',
      [],
    )
    .map((row) => row.pack_id);
  const allIds = [...new Set([...desired, ...installed, ...activeIds])].sort(
    (left, right) => left.localeCompare(right),
  );
  const allowlist = loadCoreWorkflowPackBindingAllowlist(store);
  const items: WorkflowPackReconciliationItem[] = [];
  for (const packId of allIds) {
    if (!desired.has(packId)) {
      disableWorkflowPack(store, packId, nowMs);
      items.push({
        pack_id: packId,
        desired_enabled: false,
        state: 'disabled',
        release_id: null,
        release_hash: null,
        error: null,
        execution_staging_path: null,
      });
      continue;
    }
    if (!installed.has(packId)) {
      items.push({
        pack_id: packId,
        desired_enabled: true,
        state: 'source_missing',
        release_id: null,
        release_hash: null,
        error: `Workflow Pack source is missing: ${path.join(sourceRoot, packId)}`,
        execution_staging_path: null,
      });
      continue;
    }
    try {
      const pack = loadWorkflowPack({
        packRoot: path.join(sourceRoot, packId),
        allowlist,
        nowMs,
      });
      const executionStagingPath = stageWorkflowPackExecutionResources({
        pack,
        stagingRoot,
      });
      const release = publishAndActivateWorkflowPack(store, pack, nowMs);
      items.push({
        pack_id: packId,
        desired_enabled: true,
        state: 'enabled',
        release_id: release.release_id,
        release_hash: release.release_hash,
        error: null,
        execution_staging_path: executionStagingPath,
      });
    } catch (error) {
      items.push({
        pack_id: packId,
        desired_enabled: true,
        state: 'invalid',
        release_id: null,
        release_hash: null,
        error: error instanceof Error ? error.message : String(error),
        execution_staging_path: null,
      });
    }
  }
  return { reconciled_at_ms: nowMs, items };
}
