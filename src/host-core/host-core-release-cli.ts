import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { activateHostCoreRelease, verifyActiveHostCore } from './activation.js';
import {
  assertHostCoreVersion,
  publishHostCoreRelease,
  resolveHostCoreVersion,
} from './release.js';

function pathPresent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface ParsedOptions {
  readonly command: 'publish' | 'activate' | 'verify-active';
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
  if (args[0] === 'verify-active') {
    if (args.length !== 3 || args[1] !== '--runtime-home' || !args[2]) usage();
    return {
      command: 'verify-active',
      runtimeHome: path.resolve(args[2]),
      skipValidation: false,
    };
  }
  if (
    (args[0] !== 'publish' && args[0] !== 'activate') ||
    args[1] !== '--version' ||
    !args[2] ||
    args[3] !== '--runtime-home' ||
    !args[4] ||
    (args.length !== 5 &&
      !(args.length === 6 && args[5] === '--skip-validation'))
  )
    usage();
  return {
    command: args[0],
    version: assertHostCoreVersion(args[2]),
    runtimeHome: path.resolve(args[4]),
    skipValidation: args[5] === '--skip-validation',
  };
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

  const target = resolveHostCoreVersion(options.runtimeHome, version).manifest;
  const current = pathPresent(path.join(options.runtimeHome, 'active-core'))
    ? verifyActiveHostCore(options.runtimeHome)
    : null;
  console.log(
    `current_host_core=${current ? `${current.version} ${current.release_artifact_hash}` : 'none'}`,
  );
  console.log(
    `target_host_core=${target.ref.version} ${target.release_artifact_hash}`,
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('host_core_activation_confirmation_requires_tty');
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await prompt.question('Activate this Host Core? [y/N] ');
  } finally {
    prompt.close();
  }
  if (!/^(?:y|yes)$/i.test(answer.trim()))
    throw new Error('host_core_activation_cancelled');
  const outcome = activateHostCoreRelease({
    runtimeHome: options.runtimeHome,
    version,
    skipValidation: options.skipValidation,
    confirm: (observedCurrent, observedTarget) =>
      observedCurrent?.release_artifact_hash ===
        current?.release_artifact_hash &&
      observedTarget.release_artifact_hash === target.release_artifact_hash,
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
