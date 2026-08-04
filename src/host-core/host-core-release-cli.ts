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
}

function usage(): never {
  throw new Error(
    'Usage: host-core-release <publish|activate> --version <version> --runtime-home <path> [--skip-validation]',
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
    flags.some((flag) => flag !== '--skip-validation') ||
    new Set(flags).size !== flags.length
  )
    usage();
  return {
    command: args[0],
    version: assertHostCoreVersion(args[2]),
    runtimeHome: path.resolve(args[4]),
    skipValidation: flags.includes('--skip-validation'),
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
  console.log(
    `current_host_core=${preflight.current ? `${preflight.current.version} ${preflight.current.release_artifact_hash}` : 'none'}`,
  );
  console.log(
    `target_host_core=${preflight.target.ref.version} ${preflight.target.release_artifact_hash}`,
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('host_core_activation_confirmation_requires_tty');
  if (!(await confirm('Select this Host Core as active-core? [y/N] ')))
    throw new Error('host_core_activation_cancelled');
  const outcome = activateHostCoreRelease({
    runtimeHome: options.runtimeHome,
    version,
    skipValidation: options.skipValidation,
    confirm: (current, target) =>
      current?.release_artifact_hash ===
        preflight.current?.release_artifact_hash &&
      current?.binding_hash === preflight.current?.binding_hash &&
      target.release_artifact_hash === preflight.target.release_artifact_hash,
  });
  console.log(`host_core_version=${outcome.version}`);
  console.log(
    `host_core_release_artifact_hash=${outcome.release_artifact_hash}`,
  );
  console.log(`host_core_binding_hash=${outcome.core_binding_hash}`);
  console.log(`host_core_readiness_status=${outcome.readiness_status}`);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  await main();
