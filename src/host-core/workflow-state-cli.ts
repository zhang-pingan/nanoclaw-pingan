import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOW_STATE_BACKUP_DIRECTORY,
  WORKFLOW_STATE_RELATIVE_PATHS,
  type PersistentStateBackupManifest,
} from './persistent-state.js';
import {
  type WorkflowStateInspection,
  type WorkflowStateMode,
  assertIcarusHostStopped,
  backupWorkflowState,
  discardIncompleteWorkflowStateBackup,
  gcWorkflowStateBackups,
  inspectWorkflowState,
  listWorkflowStateBackups,
  prepareWorkflowStateBackup,
  prepareWorkflowStateReset,
  resetWorkflowState,
  restoreWorkflowState,
  resumeWorkflowStateBackup,
} from './workflow-state.js';

type WorkflowStateArguments =
  | {
      readonly command: 'inspect' | 'reset';
      readonly mode: WorkflowStateMode;
      readonly runtimeHome: string;
    }
  | {
      readonly command: 'backup' | 'backups';
      readonly runtimeHome: string;
    }
  | {
      readonly command: 'restore' | 'resume' | 'discard-incomplete';
      readonly backupId: string;
      readonly runtimeHome: string;
    }
  | {
      readonly command: 'gc';
      readonly keep: number;
      readonly runtimeHome: string;
    };

function usage(): never {
  throw new Error(
    'Usage: workflow-state inspect|reset --mode <current|active> --runtime-home <path> | backup|backups --runtime-home <path> | restore|resume|discard-incomplete --backup <id> --runtime-home <path> | gc --keep <count> --runtime-home <path>',
  );
}

export function parseWorkflowStateArguments(
  args: readonly string[],
): WorkflowStateArguments {
  if (
    args.length === 5 &&
    (args[0] === 'inspect' || args[0] === 'reset') &&
    args[1] === '--mode' &&
    (args[2] === 'current' || args[2] === 'active') &&
    args[3] === '--runtime-home' &&
    args[4]
  )
    return {
      command: args[0],
      mode: args[2],
      runtimeHome: path.resolve(args[4]),
    };
  if (
    args.length === 3 &&
    (args[0] === 'backup' || args[0] === 'backups') &&
    args[1] === '--runtime-home' &&
    args[2]
  )
    return {
      command: args[0],
      runtimeHome: path.resolve(args[2]),
    };
  if (
    args.length === 5 &&
    (args[0] === 'restore' ||
      args[0] === 'resume' ||
      args[0] === 'discard-incomplete') &&
    args[1] === '--backup' &&
    args[2] &&
    args[3] === '--runtime-home' &&
    args[4]
  )
    return {
      command: args[0],
      backupId: args[2],
      runtimeHome: path.resolve(args[4]),
    };
  if (
    args.length === 5 &&
    args[0] === 'gc' &&
    args[1] === '--keep' &&
    /^[0-9]+$/.test(args[2] ?? '') &&
    args[3] === '--runtime-home' &&
    args[4]
  )
    return {
      command: 'gc',
      keep: Number(args[2]),
      runtimeHome: path.resolve(args[4]),
    };
  usage();
}

function printInspection(
  runtimeHome: string,
  inspection: WorkflowStateInspection,
  output: (line: string) => void,
): void {
  output(`workflow_state_mode=${inspection.target.mode}`);
  output(`workflow_state_target=${inspection.target.code_marker}`);
  output(
    `workflow_state_target_schema=${inspection.target.schema.database_schema_version} supported_from=${inspection.target.schema.minimum_supported_schema_version}`,
  );
  output(
    `workflow_state_current_schema=${
      inspection.decision.observed_schema
        ? String(inspection.decision.observed_schema.database_schema_version)
        : 'none'
    }`,
  );
  output(`workflow_state_decision=${inspection.decision.decision}`);
  output(`workflow_state_reason=${inspection.decision.reason}`);
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS)
    output(`workflow_state_path=${path.join(runtimeHome, relative)}`);
}

function printBackupDestination(
  runtimeHome: string,
  manifest: PersistentStateBackupManifest,
  output: (line: string) => void,
): void {
  output(`workflow_state_backup=${manifest.backup_id}`);
  output(
    `workflow_state_backup_path=${path.join(
      runtimeHome,
      WORKFLOW_STATE_BACKUP_DIRECTORY,
      manifest.backup_id,
    )}`,
  );
}

async function confirmAction(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export interface WorkflowStateCliDependencies {
  readonly projectRoot?: string;
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly hostIsRunning?: () => boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly output?: (line: string) => void;
}

async function requireConfirmation(
  question: string,
  dependencies: WorkflowStateCliDependencies,
): Promise<boolean> {
  if (
    !(dependencies.inputIsTTY ?? process.stdin.isTTY) ||
    !(dependencies.outputIsTTY ?? process.stdout.isTTY)
  )
    throw new Error('workflow_state_confirmation_requires_tty');
  return (dependencies.confirm ?? confirmAction)(question);
}

export async function runWorkflowStateCli(
  args: readonly string[],
  dependencies: WorkflowStateCliDependencies = {},
): Promise<number> {
  const options = parseWorkflowStateArguments(args);
  const projectRoot =
    dependencies.projectRoot ?? path.resolve(import.meta.dirname, '../..');
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const output = dependencies.output ?? console.log;

  if (options.command === 'inspect') {
    const inspection = inspectWorkflowState(runtimeHome, options.mode);
    printInspection(runtimeHome, inspection, output);
    return inspection.decision.decision === 'RESET_REQUIRED' ||
      inspection.decision.decision === 'UNKNOWN_BLOCKED'
      ? 78
      : 0;
  }

  if (options.command === 'backups') {
    for (const backup of listWorkflowStateBackups(runtimeHome))
      output(
        `workflow_state_backup=${backup.backup_id} status=${backup.status} operation=${backup.operation} observed_schema=${backup.observed_schema_version} target_schema=${backup.target_schema_version}`,
      );
    return 0;
  }

  if (options.command === 'backup') {
    assertIcarusHostStopped(
      projectRoot,
      runtimeHome,
      dependencies.hostIsRunning,
    );
    const preparation = prepareWorkflowStateBackup(runtimeHome, 'current');
    printInspection(runtimeHome, preparation.inspection, output);
    printBackupDestination(runtimeHome, preparation.manifest, output);
    const completed = backupWorkflowState({
      projectRoot,
      runtimeHome,
      hostIsRunning: dependencies.hostIsRunning,
      expectedManifest: preparation.manifest,
    });
    output(`workflow_state_backup_status=${completed.status}`);
    return 0;
  }

  if (options.command === 'reset') {
    assertIcarusHostStopped(
      projectRoot,
      runtimeHome,
      dependencies.hostIsRunning,
    );
    const preparation = prepareWorkflowStateReset(runtimeHome, options.mode);
    printInspection(runtimeHome, preparation.inspection, output);
    printBackupDestination(runtimeHome, preparation.manifest, output);
    const confirmed = await requireConfirmation(
      'Back up and remove exactly this Workflow Runtime DB/WAL/SHM unit?',
      dependencies,
    );
    const completed = resetWorkflowState({
      projectRoot,
      runtimeHome,
      mode: options.mode,
      confirmed,
      hostIsRunning: dependencies.hostIsRunning,
      expectedManifest: preparation.manifest,
    });
    output('workflow_state_reset=COMPLETE');
    output(`workflow_state_backup=${completed.backup_id}`);
    return 0;
  }

  if (options.command === 'restore') {
    output(`workflow_state_restore_backup=${options.backupId}`);
    for (const relative of WORKFLOW_STATE_RELATIVE_PATHS)
      output(`workflow_state_restore_path=${path.join(runtimeHome, relative)}`);
    const confirmed = await requireConfirmation(
      'Restore this Workflow Runtime backup into the live DB unit?',
      dependencies,
    );
    restoreWorkflowState({
      projectRoot,
      runtimeHome,
      backupId: options.backupId,
      confirmed,
      hostIsRunning: dependencies.hostIsRunning,
    });
    output('workflow_state_restore=COMPLETE');
    return 0;
  }

  if (options.command === 'resume') {
    const confirmed = await requireConfirmation(
      'Resume this incomplete Workflow Runtime backup operation?',
      dependencies,
    );
    const completed = resumeWorkflowStateBackup({
      projectRoot,
      runtimeHome,
      backupId: options.backupId,
      confirmed,
      hostIsRunning: dependencies.hostIsRunning,
    });
    output(`workflow_state_backup_status=${completed.status}`);
    return 0;
  }

  if (options.command === 'discard-incomplete') {
    const confirmed = await requireConfirmation(
      'Discard this incomplete backup copy?',
      dependencies,
    );
    discardIncompleteWorkflowStateBackup({
      runtimeHome,
      backupId: options.backupId,
      confirmed,
    });
    output('workflow_state_discard_incomplete=COMPLETE');
    return 0;
  }

  if (options.command !== 'gc') usage();
  const backups = listWorkflowStateBackups(runtimeHome);
  const removeCount = Math.max(0, backups.length - options.keep);
  if (removeCount === 0) {
    output('workflow_state_gc_removed=0');
    return 0;
  }
  const confirmed = await requireConfirmation(
    `Remove ${String(removeCount)} old Workflow Runtime backup(s)?`,
    dependencies,
  );
  const removed = gcWorkflowStateBackups({
    runtimeHome,
    keep: options.keep,
    confirmed,
  });
  for (const backupId of removed)
    output(`workflow_state_gc_backup=${backupId}`);
  output(`workflow_state_gc_removed=${String(removed.length)}`);
  return 0;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = await runWorkflowStateCli(process.argv.slice(2));
