import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
} from '../workflow-runtime/gateway/host-core.js';
import { verifyActiveHostCore } from './activation.js';
import {
  type HostCoreTargetSchema,
  type PersistentStateBackupManifest,
  type PersistentStateBackupSummary,
  type PersistentStateDecision,
  type PersistentStateOperationHooks,
  buildPersistentStateBackupManifest,
  type WorkflowRuntimeSchemaCompatibility,
  createPersistentStateBackup,
  currentWorkflowRuntimeSchemaCompatibility,
  decidePersistentStateCompatibility,
  discardIncompletePersistentStateBackup,
  gcPersistentStateBackups,
  listPersistentStateBackups,
  restorePersistentStateBackup,
  resumePersistentStateBackup,
} from './persistent-state.js';

export type WorkflowStateMode = 'current' | 'active';

export interface WorkflowStateTarget {
  readonly mode: WorkflowStateMode;
  readonly code_marker: string;
  readonly snapshot_id: string | null;
  readonly schema: HostCoreTargetSchema;
  readonly schema_compatibility: WorkflowRuntimeSchemaCompatibility;
}

export interface WorkflowStateInspection {
  readonly target: WorkflowStateTarget;
  readonly decision: PersistentStateDecision;
}

function currentTarget(): WorkflowStateTarget {
  return {
    mode: 'current',
    code_marker: 'current_checkout',
    snapshot_id: null,
    schema: {
      database_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      minimum_supported_schema_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    },
    schema_compatibility: currentWorkflowRuntimeSchemaCompatibility(),
  };
}

export function resolveWorkflowStateTarget(
  runtimeHomeInput: string,
  mode: WorkflowStateMode,
): WorkflowStateTarget {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  if (mode === 'current') return currentTarget();
  const active = verifyActiveHostCore(runtimeHome);
  return {
    mode,
    code_marker: `snapshot:${active.snapshot_id}`,
    snapshot_id: active.snapshot_id,
    schema: {
      database_schema_version: active.manifest.workflow_schema.current_version,
      minimum_supported_schema_version:
        active.manifest.workflow_schema.minimum_supported_version,
    },
    schema_compatibility: {
      format: 'icarus.workflow-runtime-schema-compatibility/2',
      current_version: active.manifest.workflow_schema.current_version,
      minimum_supported_version:
        active.manifest.workflow_schema.minimum_supported_version,
    },
  };
}

export function inspectWorkflowState(
  runtimeHomeInput: string,
  mode: WorkflowStateMode,
): WorkflowStateInspection {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const target = resolveWorkflowStateTarget(runtimeHome, mode);
  return {
    target,
    decision: decidePersistentStateCompatibility(
      runtimeHome,
      target.schema,
      target.schema_compatibility,
    ),
  };
}

export interface WorkflowStateResetPreparation {
  readonly inspection: WorkflowStateInspection;
  readonly manifest: PersistentStateBackupManifest;
}

function assertNoIncompleteBackups(runtimeHome: string): void {
  const incomplete = listPersistentStateBackups(runtimeHome).filter(
    (backup) => backup.status === 'in_progress',
  );
  if (incomplete.length > 0)
    throw new Error(
      `workflow_state_incomplete_backup:${incomplete
        .map((backup) => backup.backup_id)
        .join(',')}`,
    );
}

export function prepareWorkflowStateReset(
  runtimeHomeInput: string,
  mode: WorkflowStateMode,
  options: { readonly now?: Date; readonly randomSuffix?: string } = {},
): WorkflowStateResetPreparation {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  assertNoIncompleteBackups(runtimeHome);
  const inspection = inspectWorkflowState(runtimeHome, mode);
  if (inspection.decision.decision === 'UNKNOWN_BLOCKED')
    throw new Error(
      `workflow_state_unknown_blocked:${inspection.decision.reason}`,
    );
  if (inspection.decision.decision !== 'RESET_REQUIRED')
    throw new Error(
      `workflow_state_reset_not_required:${inspection.decision.decision}`,
    );
  return {
    inspection,
    manifest: buildPersistentStateBackupManifest(inspection.decision, {
      operation: 'reset',
      ...options,
    }),
  };
}

export function prepareWorkflowStateBackup(
  runtimeHomeInput: string,
  mode: WorkflowStateMode,
  options: { readonly now?: Date; readonly randomSuffix?: string } = {},
): WorkflowStateResetPreparation {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  assertNoIncompleteBackups(runtimeHome);
  const inspection = inspectWorkflowState(runtimeHome, mode);
  return {
    inspection,
    manifest: buildPersistentStateBackupManifest(inspection.decision, {
      operation: 'backup',
      ...options,
    }),
  };
}

function commandOutput(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status === 0) return result.stdout;
  if (result.status === 1) return '';
  throw new Error('workflow_state_process_status_unverifiable');
}

export function isIcarusHostRunning(
  projectRootInput: string,
  runtimeHomeInput: string,
): boolean {
  const projectRoot = fs.realpathSync(projectRootInput);
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const launchTarget = `gui/${String(process.getuid?.() ?? 0)}/com.icarus`;
  const launch = spawnSync('launchctl', ['print', launchTarget], {
    stdio: 'ignore',
  });
  if (launch.status === 0) return true;
  if (launch.status === null)
    throw new Error('workflow_state_process_status_unverifiable');

  const pids = commandOutput('/usr/bin/pgrep', ['-f', 'dist/index.js'])
    .split(/\s+/)
    .filter(Boolean);
  const currentEntry = path.join(projectRoot, 'dist/index.js');
  const activePrefix = `${path.join(runtimeHome, 'host-core-snapshots')}${path.sep}`;
  for (const pid of pids) {
    if (!/^[1-9][0-9]*$/.test(pid))
      throw new Error('workflow_state_process_status_unverifiable');
    const command = commandOutput('/bin/ps', [
      '-p',
      pid,
      '-o',
      'command=',
    ]).trim();
    if (
      command.includes(currentEntry) ||
      (command.includes(activePrefix) && command.includes('/dist/index.js'))
    )
      return true;
  }
  return false;
}

export function assertIcarusHostStopped(
  projectRoot: string,
  runtimeHome: string,
  hostIsRunning: () => boolean = () =>
    isIcarusHostRunning(projectRoot, runtimeHome),
): void {
  if (hostIsRunning()) throw new Error('workflow_state_host_running');
}

export function resetWorkflowState(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly mode: WorkflowStateMode;
  readonly confirmed: boolean;
  readonly hostIsRunning?: () => boolean;
  readonly expectedManifest?: PersistentStateBackupManifest;
  readonly hooks?: PersistentStateOperationHooks;
}): PersistentStateBackupManifest {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  assertIcarusHostStopped(
    options.projectRoot,
    runtimeHome,
    options.hostIsRunning,
  );
  if (!options.confirmed) throw new Error('workflow_state_reset_cancelled');
  assertNoIncompleteBackups(runtimeHome);
  const inspection = inspectWorkflowState(runtimeHome, options.mode);
  if (inspection.decision.decision !== 'RESET_REQUIRED')
    throw new Error(
      `workflow_state_reset_not_required:${inspection.decision.decision}`,
    );
  const manifest =
    options.expectedManifest ??
    buildPersistentStateBackupManifest(inspection.decision, {
      operation: 'reset',
    });
  if (
    manifest.operation !== 'reset' ||
    manifest.observed_schema_version !==
      inspection.decision.observed_schema?.database_schema_version ||
    manifest.target_schema_version !==
      inspection.decision.target_schema.database_schema_version ||
    JSON.stringify(manifest.members) !==
      JSON.stringify(inspection.decision.members)
  )
    throw new Error('workflow_state_reset_plan_changed');
  return createPersistentStateBackup(runtimeHome, manifest, options.hooks);
}

export function backupWorkflowState(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly mode?: WorkflowStateMode;
  readonly hostIsRunning?: () => boolean;
  readonly expectedManifest?: PersistentStateBackupManifest;
  readonly hooks?: PersistentStateOperationHooks;
}): PersistentStateBackupManifest {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  assertIcarusHostStopped(
    options.projectRoot,
    runtimeHome,
    options.hostIsRunning,
  );
  assertNoIncompleteBackups(runtimeHome);
  const preparation = options.expectedManifest
    ? null
    : prepareWorkflowStateBackup(runtimeHome, options.mode ?? 'current');
  const manifest = options.expectedManifest ?? preparation!.manifest;
  if (manifest.operation !== 'backup')
    throw new Error('workflow_state_backup_plan_invalid');
  return createPersistentStateBackup(runtimeHome, manifest, options.hooks);
}

export function listWorkflowStateBackups(
  runtimeHomeInput: string,
): PersistentStateBackupSummary[] {
  return listPersistentStateBackups(runtimeHomeInput);
}

export function resumeWorkflowStateBackup(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly backupId: string;
  readonly confirmed: boolean;
  readonly hostIsRunning?: () => boolean;
  readonly hooks?: PersistentStateOperationHooks;
}): PersistentStateBackupManifest {
  if (!options.confirmed) throw new Error('workflow_state_resume_cancelled');
  assertIcarusHostStopped(
    options.projectRoot,
    options.runtimeHome,
    options.hostIsRunning,
  );
  return resumePersistentStateBackup(
    options.runtimeHome,
    options.backupId,
    options.hooks,
  );
}

export function restoreWorkflowState(options: {
  readonly projectRoot: string;
  readonly runtimeHome: string;
  readonly backupId: string;
  readonly confirmed: boolean;
  readonly hostIsRunning?: () => boolean;
  readonly hooks?: PersistentStateOperationHooks;
}): void {
  if (!options.confirmed) throw new Error('workflow_state_restore_cancelled');
  assertIcarusHostStopped(
    options.projectRoot,
    options.runtimeHome,
    options.hostIsRunning,
  );
  restorePersistentStateBackup(
    options.runtimeHome,
    options.backupId,
    options.hooks,
  );
}

export function discardIncompleteWorkflowStateBackup(options: {
  readonly runtimeHome: string;
  readonly backupId: string;
  readonly confirmed: boolean;
}): void {
  if (!options.confirmed) throw new Error('workflow_state_discard_cancelled');
  discardIncompletePersistentStateBackup(options.runtimeHome, options.backupId);
}

export function gcWorkflowStateBackups(options: {
  readonly runtimeHome: string;
  readonly keep: number;
  readonly confirmed: boolean;
}): string[] {
  if (!options.confirmed) throw new Error('workflow_state_gc_cancelled');
  return gcPersistentStateBackups(options.runtimeHome, options.keep);
}
