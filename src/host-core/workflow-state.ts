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
  if (options.expectedPlan && options.expectedPlan.backup_id !== plan.backup_id)
    throw new Error('workflow_state_reset_plan_changed');
  options.onPlan?.(plan);
  quarantinePersistentState(runtimeHome, plan);
  return plan;
}
