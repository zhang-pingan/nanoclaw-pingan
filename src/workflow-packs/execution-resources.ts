import fs from 'node:fs';
import path from 'node:path';

import { strictParseJsonBytes } from '../workflow-runtime/contracts/strict-json.js';
import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import type { WorkflowRuntimeStore } from '../workflow-runtime/gateway/workflow-packs.js';
import { assertSafeWorkflowPackId } from './manifest.js';
import {
  verifyStagedWorkflowPackExecutionBundle,
  type WorkflowPackExecutionResourceFiles,
} from './loader.js';
import {
  parseWorkflowPackExecutionPermissions,
  type WorkflowPackExecutionPermissions,
} from './permissions.js';
import { WORKFLOW_PACK_EXECUTION_STAGING_ROOT } from './reconciler.js';

export {
  parseWorkflowPackExecutionPermissions,
  type WorkflowPackEffectCeiling,
  type WorkflowPackExecutionPermissions,
} from './permissions.js';

export interface WorkflowPackExecutionResourcePin {
  readonly pack_id: string;
  readonly pack_version: string;
  readonly manifest_hash: Sha256Hash;
  readonly execution_artifact_resource_id: string;
  readonly execution_artifact_hash: Sha256Hash;
  readonly execution_resource_files: WorkflowPackExecutionResourceFiles;
  readonly permissions: WorkflowPackExecutionPermissions;
  readonly registry_snapshot_id: string;
  readonly registry_snapshot_hash: Sha256Hash;
  readonly root_path: string;
}

interface PinRow extends Record<string, unknown> {
  pack_id: string;
  pack_version: string;
  manifest_hash: Sha256Hash;
  execution_artifact_resource_id: string;
  execution_artifact_hash: Sha256Hash;
  registry_snapshot_id: string;
  registry_snapshot_hash: Sha256Hash;
  execution_artifact_json: string;
}

export function resolveWorkflowPackExecutionResourcePin(
  store: WorkflowRuntimeStore,
  graphRunId: string,
  stagingRoot = WORKFLOW_PACK_EXECUTION_STAGING_ROOT,
): WorkflowPackExecutionResourcePin | null {
  const rows = store.queryAll<PinRow>(
    `SELECT release.pack_id, release.release_version AS pack_version,
            json_extract(value.inline_canonical_json, '$.manifest_hash') AS manifest_hash,
            resource.id AS execution_artifact_resource_id,
            resource.content_hash AS execution_artifact_hash,
            run.registry_snapshot_id, run.registry_snapshot_hash,
            value.inline_canonical_json AS execution_artifact_json
       FROM workflow_graph_runs run
       JOIN workflow_registry_snapshots snapshot
         ON snapshot.id = run.registry_snapshot_id
        AND snapshot.snapshot_hash = run.registry_snapshot_hash
       JOIN workflow_registry_retention_handles retention
         ON retention.id = run.registry_retention_handle_id
        AND retention.graph_run_id = run.id
        AND retention.closure_manifest_id = snapshot.closure_manifest_id
        AND retention.closure_hash = snapshot.closure_hash
        AND retention.handle_kind = 'active_run' AND retention.status = 'held'
       JOIN workflow_registry_retention_handles published
         ON published.closure_manifest_id = snapshot.closure_manifest_id
        AND published.closure_hash = snapshot.closure_hash
        AND published.handle_kind = 'published' AND published.status = 'held'
       JOIN workflow_pack_releases release
         ON release.id = published.pack_release_id
       JOIN workflow_registry_resources resource
         ON resource.id = release.execution_artifact_resource_id
        AND resource.content_hash = release.execution_artifact_hash
        AND resource.resource_type = 'pack_execution_artifact'
        AND resource.owner_pack_id = release.pack_id
        AND resource.publication_state = 'published'
       JOIN workflow_values value
         ON value.id = resource.canonical_value_id
        AND value.content_hash = resource.content_hash
        AND value.storage_kind = 'inline' AND value.payload_state = 'live'
      WHERE run.id = ?
      ORDER BY resource.id COLLATE BINARY`,
    [graphRunId],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error(
      `Workflow Run ${graphRunId} has multiple pinned Pack execution artifacts`,
    );
  }
  const row = rows[0];
  assertSafeWorkflowPackId(row.pack_id);
  if (!/^sha256:[0-9a-f]{64}$/.test(row.manifest_hash)) {
    throw new Error(`Workflow Run ${graphRunId} has an invalid manifest pin`);
  }
  const artifact = strictParseJsonBytes(
    Buffer.from(row.execution_artifact_json, 'utf8'),
  ) as JsonObject;
  const executionResourceFiles = artifact.execution_resource_files;
  const permissions = parseWorkflowPackExecutionPermissions(
    artifact.permissions,
  );
  if (
    artifact.format !== 'icarus.workflow-pack-execution-bundle/1' ||
    !artifact.pack_ref ||
    typeof artifact.pack_ref !== 'object' ||
    Array.isArray(artifact.pack_ref) ||
    artifact.pack_ref.id !== row.pack_id ||
    artifact.pack_ref.version !== row.pack_version ||
    artifact.manifest_hash !== row.manifest_hash ||
    !executionResourceFiles ||
    typeof executionResourceFiles !== 'object' ||
    Array.isArray(executionResourceFiles)
  ) {
    throw new Error(
      `Workflow Run ${graphRunId} has an invalid Pack execution artifact`,
    );
  }
  return verifyWorkflowPackExecutionResourcePin(
    {
      pack_id: row.pack_id,
      pack_version: row.pack_version,
      manifest_hash: row.manifest_hash,
      execution_artifact_resource_id: row.execution_artifact_resource_id,
      execution_artifact_hash: row.execution_artifact_hash,
      execution_resource_files:
        executionResourceFiles as WorkflowPackExecutionResourceFiles,
      permissions,
      registry_snapshot_id: row.registry_snapshot_id,
      registry_snapshot_hash: row.registry_snapshot_hash,
      root_path: path.join(
        path.resolve(stagingRoot),
        row.pack_id,
        row.manifest_hash.slice('sha256:'.length),
      ),
    },
    stagingRoot,
  );
}

export function verifyWorkflowPackExecutionResourcePin(
  pin: WorkflowPackExecutionResourcePin,
  stagingRoot = WORKFLOW_PACK_EXECUTION_STAGING_ROOT,
): WorkflowPackExecutionResourcePin {
  assertSafeWorkflowPackId(pin.pack_id);
  const root = fs.realpathSync(pin.root_path);
  const allowedRoot = fs.realpathSync(path.resolve(stagingRoot));
  if (!root.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(
      'Workflow Pack execution resource pin escapes staging root',
    );
  }
  const verifiedRoot = verifyStagedWorkflowPackExecutionBundle({
    rootPath: root,
    packId: pin.pack_id,
    packVersion: pin.pack_version,
    manifestHash: pin.manifest_hash,
    executionArtifactResourceId: pin.execution_artifact_resource_id,
    executionArtifactHash: pin.execution_artifact_hash,
    executionResourceFiles: pin.execution_resource_files,
    permissions: pin.permissions,
  });
  return { ...pin, root_path: verifiedRoot };
}
