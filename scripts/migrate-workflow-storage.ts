#!/usr/bin/env tsx
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../src/config.js';
import {
  getDatabase,
  getWorkflow,
  initDatabase,
  listUnmigratedWorkbenchArtifacts,
  updateWorkflow,
} from '../src/db.js';
import type { Workflow } from '../src/types.js';
import {
  getWorkflowTypeConfig,
  loadWorkflowConfigs,
} from '../src/workflow-config.js';
import { WORKFLOW_CONTEXT_KEYS } from '../src/workflow-context.js';
import {
  resolveWorkflowArtifactLocation,
  resolveWorkflowStorageRoot,
} from '../src/workflow-storage.js';

interface MigrationChange {
  kind: 'context_pack' | 'artifact';
  sourcePath: string;
  targetPath: string;
  locationUri?: string;
  workflowId?: string;
  artifactId?: string;
  status: 'planned' | 'copied' | 'skipped' | 'failed';
  reason?: string;
}

const mode = process.argv.includes('--migrate') ? 'migrate' : 'dry-run';
const changes: MigrationChange[] = [];

function sha256(filePath: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function ensureAuditTable(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS workflow_storage_migration_audit (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      artifact_id TEXT,
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      location_uri TEXT,
      checksum TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `);
}

function recordAudit(change: MigrationChange, checksum = ''): void {
  getDatabase()
    .prepare(
      `INSERT INTO workflow_storage_migration_audit (
        id, workflow_id, artifact_id, source_path, target_path, location_uri,
        checksum, status, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `workflow-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      change.workflowId || null,
      change.artifactId || null,
      change.sourcePath,
      change.targetPath,
      change.locationUri || null,
      checksum || null,
      change.status,
      change.reason || null,
      new Date().toISOString(),
    );
}

function copyWithChecksum(change: MigrationChange): boolean {
  if (!fs.existsSync(change.sourcePath)) {
    change.status = 'skipped';
    change.reason = 'source_missing';
    return false;
  }
  const sourceChecksum = sha256(change.sourcePath);
  if (fs.existsSync(change.targetPath)) {
    const targetChecksum = sha256(change.targetPath);
    if (targetChecksum !== sourceChecksum) {
      change.status = 'failed';
      change.reason = 'target_conflict';
      return false;
    }
    change.status = 'skipped';
    change.reason = 'target_exists_same_checksum';
    return true;
  }
  if (mode === 'migrate') {
    fs.mkdirSync(path.dirname(change.targetPath), { recursive: true });
    fs.copyFileSync(change.sourcePath, change.targetPath);
    const targetChecksum = sha256(change.targetPath);
    if (targetChecksum !== sourceChecksum) {
      change.status = 'failed';
      change.reason = 'checksum_mismatch';
      return false;
    }
    change.status = 'copied';
  }
  return true;
}

function migrateLegacyContextPacks(): void {
  const projectsDir = path.join(PROJECT_ROOT, 'projects');
  if (!fs.existsSync(projectsDir)) return;
  for (const service of fs.readdirSync(projectsDir)) {
    const workflowContextDir = path.join(
      projectsDir,
      service,
      'workflow-context',
    );
    if (!fs.existsSync(workflowContextDir)) continue;
    for (const workflowId of fs.readdirSync(workflowContextDir)) {
      const workflow = getWorkflow(workflowId);
      if (!workflow) continue;
      for (const stageKey of fs.readdirSync(
        path.join(workflowContextDir, workflowId),
      )) {
        const sourceDir = path.join(workflowContextDir, workflowId, stageKey);
        if (!fs.statSync(sourceDir).isDirectory()) continue;
        const contextRoot = resolveWorkflowStorageRoot({
          workflow,
          storage: getWorkflowTypeConfig(workflow.workflow_type)?.storage,
          root: 'context_pack_root',
          stageKey,
        });
        for (const fileName of fs.readdirSync(sourceDir)) {
          const sourcePath = path.join(sourceDir, fileName);
          if (!fs.statSync(sourcePath).isFile()) continue;
          const change: MigrationChange = {
            kind: 'context_pack',
            sourcePath,
            targetPath: path.join(contextRoot.hostPath, fileName),
            workflowId,
            status: 'planned',
          };
          changes.push(change);
          if (mode === 'migrate') {
            copyWithChecksum(change);
            recordAudit(
              change,
              fs.existsSync(sourcePath) ? sha256(sourcePath) : '',
            );
          }
        }
      }
    }
  }
}

function workflowWithDeliverable(
  workflow: Workflow,
  deliverable: string,
): Workflow {
  return {
    ...workflow,
    context: {
      ...workflow.context,
      [WORKFLOW_CONTEXT_KEYS.deliverable]: deliverable,
    },
  };
}

function migrateWorkbenchArtifacts(): void {
  const records = listUnmigratedWorkbenchArtifacts(100000);
  const legacyPattern = /^projects\/([^/]+)\/iteration\/([^/]+)\/(.+)$/;
  for (const record of records) {
    const match = record.path.match(legacyPattern);
    const workflow = getWorkflow(record.workflow_id);
    if (!match || !workflow) {
      changes.push({
        kind: 'artifact',
        sourcePath: record.path,
        targetPath: '',
        workflowId: record.workflow_id,
        artifactId: record.id,
        status: 'failed',
        reason: !match ? 'path_not_legacy_iteration' : 'workflow_missing',
      });
      continue;
    }
    const [, , deliverable, artifactPath] = match;
    const resolved = resolveWorkflowArtifactLocation({
      workflow: workflowWithDeliverable(workflow, deliverable),
      storage: getWorkflowTypeConfig(workflow.workflow_type)?.storage,
      artifactPath,
    });
    const change: MigrationChange = {
      kind: 'artifact',
      sourcePath: path.join(PROJECT_ROOT, record.path),
      targetPath: resolved.hostPath,
      locationUri: resolved.locationUri,
      workflowId: workflow.id,
      artifactId: record.id,
      status: 'planned',
    };
    changes.push(change);
    if (mode !== 'migrate') continue;
    copyWithChecksum(change);
    if (change.status === 'failed') {
      recordAudit(change);
      continue;
    }
    getDatabase()
      .prepare(
        `UPDATE workbench_artifacts
         SET location_kind = ?, location_uri = ?, host_path = ?,
             container_path = ?, feature_id = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        resolved.kind,
        resolved.locationUri,
        resolved.hostPath,
        resolved.containerPath,
        resolved.featureId || null,
        JSON.stringify({ legacy_source_path: record.path }),
        record.id,
      );
    recordAudit(
      change,
      fs.existsSync(change.sourcePath) ? sha256(change.sourcePath) : '',
    );
  }
}

function rewriteWorkflowContextPaths(): void {
  if (mode !== 'migrate') return;
  const rows = getDatabase()
    .prepare('SELECT id, context_json FROM workflows')
    .all() as Array<{ id: string; context_json: string }>;
  for (const row of rows) {
    const workflow = getWorkflow(row.id);
    if (!workflow) continue;
    const contextPackPath = String(
      workflow.context[WORKFLOW_CONTEXT_KEYS.contextPackPath] || '',
    );
    if (!contextPackPath.includes('/workspace/projects/')) continue;
    const stageMatch = contextPackPath.match(
      /workflow-context\/[^/]+\/([^/]+)\//,
    );
    const stageKey = stageMatch?.[1] || workflow.status;
    const contextRoot = resolveWorkflowStorageRoot({
      workflow,
      storage: getWorkflowTypeConfig(workflow.workflow_type)?.storage,
      root: 'context_pack_root',
      stageKey,
    });
    updateWorkflow(workflow.id, {
      context: {
        ...workflow.context,
        [WORKFLOW_CONTEXT_KEYS.contextPackPath]: `${contextRoot.containerPath}/latest.json`,
        [WORKFLOW_CONTEXT_KEYS.contextPackImmutablePath]: String(
          workflow.context[WORKFLOW_CONTEXT_KEYS.contextPackImmutablePath] ||
            '',
        ).replace(
          /^\/workspace\/projects\/[^/]+\/workflow-context\/[^/]+\/[^/]+/,
          contextRoot.containerPath,
        ),
      },
    });
  }
}

loadWorkflowConfigs();
initDatabase();
ensureAuditTable();
migrateLegacyContextPacks();
migrateWorkbenchArtifacts();
rewriteWorkflowContextPaths();

console.log(
  JSON.stringify(
    {
      mode,
      changes: changes.length,
      failed: changes.filter((item) => item.status === 'failed').length,
      skipped: changes.filter((item) => item.status === 'skipped').length,
      copied: changes.filter((item) => item.status === 'copied').length,
      details: changes,
    },
    null,
    2,
  ),
);

if (changes.some((item) => item.status === 'failed')) {
  process.exit(1);
}
