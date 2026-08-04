import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  activateHostCoreRelease,
  inspectHostCoreActivation,
  verifyActiveHostCore,
} from './activation.js';
import { assertHostCoreVersion, publishHostCoreRelease } from './release.js';

interface ParsedOptions {
  readonly command: 'publish' | 'activate' | 'verify-active' | 'launch-active';
  readonly version?: string;
  readonly runtimeHome: string;
  readonly skipValidation: boolean;
  readonly resetIncompatibleState: boolean;
}

function usage(): never {
  throw new Error(
    'Usage: host-core-release <publish|activate> --version <version> --runtime-home <path> [--skip-validation] [--reset-incompatible-state]',
  );
}

export function parseHostCoreReleaseArguments(
  args: readonly string[],
): ParsedOptions {
  if (args[0] === 'verify-active' || args[0] === 'launch-active') {
    if (args.length !== 3 || args[1] !== '--runtime-home' || !args[2]) usage();
    return {
      command: args[0],
      runtimeHome: path.resolve(args[2]),
      skipValidation: false,
      resetIncompatibleState: false,
    };
  }
  if (
    (args[0] !== 'publish' && args[0] !== 'activate') ||
    args[1] !== '--version' ||
    !args[2] ||
    args[3] !== '--runtime-home' ||
    !args[4]
  )
    usage();
  const flags = args.slice(5);
  if (
    flags.some(
      (flag) =>
        flag !== '--skip-validation' && flag !== '--reset-incompatible-state',
    ) ||
    new Set(flags).size !== flags.length ||
    (args[0] === 'publish' && flags.includes('--reset-incompatible-state'))
  )
    usage();
  return {
    command: args[0],
    version: assertHostCoreVersion(args[2]),
    runtimeHome: path.resolve(args[4]),
    skipValidation: flags.includes('--skip-validation'),
    resetIncompatibleState: flags.includes('--reset-incompatible-state'),
  };
}

async function confirm(promptText: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(promptText);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const options = parseHostCoreReleaseArguments(process.argv.slice(2));
  if (options.command === 'verify-active') {
    const active = verifyActiveHostCore(options.runtimeHome);
    console.log(`active_host_core_version=${active.version}`);
    console.log(
      `active_host_core_release_artifact_hash=${active.release_artifact_hash}`,
    );
    console.log(`active_host_core_formal=${String(active.formal)}`);
    return;
  }
  if (options.command === 'launch-active') {
    const active = verifyActiveHostCore(options.runtimeHome);
    const execve = process.execve;
    if (!execve) throw new Error('host_core_active_exec_unavailable');
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) =>
          value !== undefined &&
          name !== 'NODE_OPTIONS' &&
          name !== 'NODE_PATH' &&
          name !== 'ICARUS_RUNTIME_HOME' &&
          name !== 'ICARUS_TOOLCHAIN_MANIFEST',
      ),
    ) as Record<string, string>;
    execve(
      process.execPath,
      [process.execPath, active.core_entry_path],
      environment,
    );
  }
  const version = options.version!;
  if (options.command === 'publish') {
    const result = publishHostCoreRelease({
      projectRoot: path.resolve(import.meta.dirname, '../..'),
      runtimeHome: options.runtimeHome,
      version,
      skipValidation: options.skipValidation,
    });
    console.log(`host_core_version=${result.manifest.ref.version}`);
    console.log(
      `host_core_release_artifact_hash=${result.manifest.release_artifact_hash}`,
    );
    console.log(
      `host_core_validation_status=${result.manifest.validation_status}`,
    );
    console.log('host_core_activation=unchanged');
    return;
  }

  const preflight = inspectHostCoreActivation(options.runtimeHome, version);
  const { current, target } = preflight;
  console.log(
    `current_host_core=${current ? `${current.version} ${current.release_artifact_hash}` : 'none'}`,
  );
  console.log(
    `target_host_core=${target.ref.version} ${target.release_artifact_hash}`,
  );
  console.log(
    `persistent_state_decision=${preflight.persistent_state.decision}`,
  );
  console.log(
    `persistent_state_current=${preflight.persistent_state.old_identity ? `${preflight.persistent_state.old_identity.database_schema_version} ${preflight.persistent_state.old_identity.database_sqlite_schema_hash}` : 'none'}`,
  );
  console.log(
    `persistent_state_target=${target.database_schema_version} ${target.database_schema_hash} ${target.database_sqlite_schema_hash}`,
  );
  for (const affected of preflight.persistent_state.affected_paths)
    console.log(`persistent_state_path=${affected}`);
  if (preflight.persistent_state.decision === 'UNKNOWN_BLOCKED')
    throw new Error(
      `host_core_persistent_state_unknown:${preflight.persistent_state.reason}`,
    );
  if (
    preflight.persistent_state.decision === 'RESET_REQUIRED' &&
    !options.resetIncompatibleState
  )
    throw new Error(
      `host_core_persistent_state_RESET_REQUIRED:${preflight.persistent_state.reason}`,
    );
  if (
    preflight.persistent_state.decision !== 'RESET_REQUIRED' &&
    options.resetIncompatibleState
  )
    throw new Error('host_core_persistent_state_reset_not_required');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('host_core_activation_confirmation_requires_tty');
  if (!(await confirm('Activate this Host Core? [y/N] ')))
    throw new Error('host_core_activation_cancelled');
  if (
    options.resetIncompatibleState &&
    !(await confirm(
      'Quarantine exactly the listed Workflow Runtime state paths before activation? [y/N] ',
    ))
  )
    throw new Error('host_core_persistent_state_reset_cancelled');
  const outcome = activateHostCoreRelease({
    runtimeHome: options.runtimeHome,
    version,
    skipValidation: options.skipValidation,
    resetIncompatibleState: options.resetIncompatibleState,
    confirm: (observedCurrent, observedTarget, observedPersistentState) =>
      observedCurrent?.release_artifact_hash ===
        current?.release_artifact_hash &&
      observedTarget.release_artifact_hash === target.release_artifact_hash &&
      JSON.stringify(observedPersistentState) ===
        JSON.stringify(preflight.persistent_state),
  });
  console.log(`host_core_version=${outcome.version}`);
  console.log(
    `host_core_release_artifact_hash=${outcome.release_artifact_hash}`,
  );
  console.log(`host_core_binding_hash=${outcome.core_binding_hash}`);
  console.log(
    `host_core_activation_audit_hash=${outcome.activation_audit_hash}`,
  );
  console.log(`host_core_activation_rollback=${String(outcome.rollback)}`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  await main();
