import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOW_STATE_RELATIVE_PATHS,
  type PersistentStateDecision,
} from './persistent-state.js';
import {
  type WorkflowStateInspection,
  type WorkflowStateMode,
  assertIcarusHostStopped,
  inspectWorkflowState,
  resetWorkflowState,
} from './workflow-state.js';

interface WorkflowStateArguments {
  readonly command: 'inspect' | 'reset';
  readonly mode: WorkflowStateMode;
  readonly runtimeHome: string;
}

function usage(): never {
  throw new Error(
    'Usage: workflow-state <inspect|reset> --mode <current|active> --runtime-home <path>',
  );
}

export function parseWorkflowStateArguments(
  args: readonly string[],
): WorkflowStateArguments {
  if (
    args.length !== 5 ||
    (args[0] !== 'inspect' && args[0] !== 'reset') ||
    args[1] !== '--mode' ||
    (args[2] !== 'current' && args[2] !== 'active') ||
    args[3] !== '--runtime-home' ||
    !args[4]
  )
    usage();
  return {
    command: args[0],
    mode: args[2],
    runtimeHome: path.resolve(args[4]),
  };
}

function printIdentity(
  prefix: string,
  identity: PersistentStateDecision['old_identity'],
): void {
  console.log(
    `${prefix}=${identity ? `${identity.database_schema_version} ${identity.database_sqlite_schema_hash}` : 'none'}`,
  );
}

function printInspection(
  runtimeHome: string,
  inspection: WorkflowStateInspection,
): void {
  console.log(`workflow_state_mode=${inspection.target.mode}`);
  console.log(`workflow_state_target=${inspection.target.code_identity}`);
  console.log(
    `workflow_state_target_schema=${inspection.target.schema.database_schema_version} ${inspection.target.schema.database_schema_hash} ${inspection.target.schema.database_sqlite_schema_hash}`,
  );
  printIdentity(
    'workflow_state_current_schema',
    inspection.decision.old_identity,
  );
  console.log(`workflow_state_decision=${inspection.decision.decision}`);
  console.log(`workflow_state_reason=${inspection.decision.reason}`);
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS)
    console.log(`workflow_state_path=${path.join(runtimeHome, relative)}`);
}

async function confirmReset(): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      'Quarantine exactly this Workflow Runtime DB/WAL/SHM unit? [y/N] ',
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const options = parseWorkflowStateArguments(process.argv.slice(2));
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  const runtimeHome = fs.realpathSync(options.runtimeHome);
  const inspection = inspectWorkflowState(runtimeHome, options.mode);
  printInspection(runtimeHome, inspection);
  if (options.command === 'inspect') {
    if (
      inspection.decision.decision === 'RESET_REQUIRED' ||
      inspection.decision.decision === 'UNKNOWN_BLOCKED'
    )
      process.exitCode = 78;
    return;
  }

  assertIcarusHostStopped(projectRoot, runtimeHome);
  if (inspection.decision.decision === 'UNKNOWN_BLOCKED')
    throw new Error(
      `workflow_state_unknown_blocked:${inspection.decision.reason}`,
    );
  if (inspection.decision.decision !== 'RESET_REQUIRED')
    throw new Error(
      `workflow_state_reset_not_required:${inspection.decision.decision}`,
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('workflow_state_reset_confirmation_requires_tty');
  const confirmed = await confirmReset();
  const plan = resetWorkflowState({
    projectRoot,
    runtimeHome,
    mode: options.mode,
    confirmed,
    onPlan: (candidate) => {
      console.log(
        `workflow_state_backup_identity=${candidate.backup_identity}`,
      );
      console.log(
        `workflow_state_recovery_path=${path.join(runtimeHome, candidate.backup_relative_path)}`,
      );
    },
  });
  console.log(`workflow_state_reset=QUARANTINED`);
  console.log(`workflow_state_backup_identity=${plan.backup_identity}`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  await main();
