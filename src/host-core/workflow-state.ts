import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Sha256Hash } from '../workflow-runtime/contracts/types.js';
import { CURRENT_G1_SCHEMA_IDENTITIES } from '../workflow-runtime/store/runtime-store/profile.js';
import { verifyActiveHostCore } from './activation.js';
import {
  type HostCoreTargetSchemaIdentity,
  type PersistentStateDecision,
  type PersistentStateResetPlan,
  type WorkflowRuntimeSchemaCompatibility,
  buildPersistentStateResetPlan,
  currentWorkflowRuntimeSchemaCompatibility,
  decidePersistentStateCompatibility,
  discoverPersistentStateResetRecovery,
  quarantinePersistentState,
} from './persistent-state.js';

export type WorkflowStateMode = 'current' | 'active';

export interface WorkflowStateTarget {
  readonly mode: WorkflowStateMode;
  readonly code_identity: string;
  readonly version: string | null;
  readonly release_artifact_hash: Sha256Hash | null;
  readonly schema: HostCoreTargetSchemaIdentity;
  readonly schema_compatibility: WorkflowRuntimeSchemaCompatibility | null;
}

export interface WorkflowStateInspection {
  readonly target: WorkflowStateTarget;
  readonly decision: PersistentStateDecision;
}

function currentTarget(): WorkflowStateTarget {
  return {
    mode: 'current',
    code_identity: 'current_checkout',
    version: null,
    release_artifact_hash: null,
    schema: {
      database_schema_version: 11,
      database_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.schema,
      database_sqlite_schema_hash: CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema,
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
  const sqliteSchemaHash =
    active.database_sqlite_schema_hash ??
    (active.database_schema_version === 11 &&
    active.database_schema_hash === CURRENT_G1_SCHEMA_IDENTITIES.schema
      ? CURRENT_G1_SCHEMA_IDENTITIES.sqliteSchema
      : null);
  if (!sqliteSchemaHash)
    throw new Error('workflow_state_active_schema_identity_unverifiable');
  return {
    mode,
    code_identity: `${active.version} ${active.release_artifact_hash}`,
    version: active.version,
    release_artifact_hash: active.release_artifact_hash,
    schema: {
      database_schema_version: active.database_schema_version,
      database_schema_hash: active.database_schema_hash,
      database_sqlite_schema_hash: sqliteSchemaHash,
    },
    schema_compatibility: active.workflow_runtime_schema_compatibility,
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
  readonly recovery: boolean;
  readonly inspection: WorkflowStateInspection | null;
  readonly plan: PersistentStateResetPlan;
}

export function prepareWorkflowStateReset(
  runtimeHomeInput: string,
  mode: WorkflowStateMode,
): WorkflowStateResetPreparation {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const recovery = discoverPersistentStateResetRecovery(runtimeHome);
  if (recovery) return { recovery: true, inspection: null, plan: recovery };
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
    recovery: false,
    inspection,
    plan: buildPersistentStateResetPlan(inspection.decision),
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
    throw new Error('workflow_state_service_status_unverifiable');

  const pids = commandOutput('/usr/bin/pgrep', ['-f', 'dist/index.js'])
    .split(/\s+/)
    .filter(Boolean);
  const currentEntry = path.join(projectRoot, 'dist/index.js');
  const activePrefix = `${path.join(runtimeHome, 'core-releases')}${path.sep}`;
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
  readonly expectedPlan?: PersistentStateResetPlan;
  readonly onPlan?: (plan: PersistentStateResetPlan) => void;
}): PersistentStateResetPlan {
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  assertIcarusHostStopped(
    options.projectRoot,
    runtimeHome,
    options.hostIsRunning,
  );
  const preparation = prepareWorkflowStateReset(runtimeHome, options.mode);
  if (!options.confirmed) throw new Error('workflow_state_reset_cancelled');
  const plan = preparation.plan;
  if (
    options.expectedPlan &&
    options.expectedPlan.backup_identity !== plan.backup_identity
  )
    throw new Error('workflow_state_reset_plan_changed');
  options.onPlan?.(plan);
  quarantinePersistentState(runtimeHome, plan);
  return plan;
}
