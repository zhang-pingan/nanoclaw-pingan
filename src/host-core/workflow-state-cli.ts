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
  prepareWorkflowStateReset,
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
  identity: PersistentStateDecision['observed_schema'],
  output: (line: string) => void = console.log,
): void {
  output(
    `${prefix}=${identity ? String(identity.database_schema_version) : 'none'}`,
  );
}

function printInspection(
  runtimeHome: string,
  inspection: WorkflowStateInspection,
  output: (line: string) => void = console.log,
): void {
  output(`workflow_state_mode=${inspection.target.mode}`);
  output(`workflow_state_target=${inspection.target.code_marker}`);
  output(
    `workflow_state_target_schema=${inspection.target.schema.database_schema_version} supported_from=${inspection.target.schema.minimum_supported_schema_version}`,
  );
  printIdentity(
    'workflow_state_current_schema',
    inspection.decision.observed_schema,
    output,
  );
  output(`workflow_state_decision=${inspection.decision.decision}`);
  output(`workflow_state_reason=${inspection.decision.reason}`);
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS)
    output(`workflow_state_path=${path.join(runtimeHome, relative)}`);
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

export interface WorkflowStateCliDependencies {
  readonly projectRoot?: string;
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly hostIsRunning?: () => boolean;
  readonly confirm?: () => Promise<boolean>;
  readonly output?: (line: string) => void;
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
    if (
      inspection.decision.decision === 'RESET_REQUIRED' ||
      inspection.decision.decision === 'UNKNOWN_BLOCKED'
    )
      return 78;
    return 0;
  }

  assertIcarusHostStopped(projectRoot, runtimeHome, dependencies.hostIsRunning);
  const preparation = prepareWorkflowStateReset(runtimeHome, options.mode);
  if (preparation.inspection)
    printInspection(runtimeHome, preparation.inspection, output);
  else {
    output(`workflow_state_mode=${options.mode}`);
    output('workflow_state_target=recovery_recorded');
    output(
      `workflow_state_target_schema=${preparation.plan.target_schema_version}`,
    );
    printIdentity(
      'workflow_state_current_schema',
      {
        database_schema_version: preparation.plan.observed_schema_version,
      },
      output,
    );
    output('workflow_state_decision=RESET_RECOVERY');
    output('workflow_state_reason=incomplete_quarantine_recovery');
    for (const relative of WORKFLOW_STATE_RELATIVE_PATHS)
      output(`workflow_state_path=${path.join(runtimeHome, relative)}`);
  }
  output(`workflow_state_backup=${preparation.plan.backup_id}`);
  output(
    `workflow_state_recovery_path=${path.join(runtimeHome, preparation.plan.backup_relative_path)}`,
  );
  if (
    !(dependencies.inputIsTTY ?? process.stdin.isTTY) ||
    !(dependencies.outputIsTTY ?? process.stdout.isTTY)
  )
    throw new Error('workflow_state_reset_confirmation_requires_tty');
  const confirmed = await (dependencies.confirm ?? confirmReset)();
  const plan = resetWorkflowState({
    projectRoot,
    runtimeHome,
    mode: options.mode,
    confirmed,
    hostIsRunning: dependencies.hostIsRunning,
    expectedPlan: preparation.plan,
  });
  output('workflow_state_reset=QUARANTINED');
  output(`workflow_state_backup=${plan.backup_id}`);
  return 0;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  process.exitCode = await runWorkflowStateCli(process.argv.slice(2));
