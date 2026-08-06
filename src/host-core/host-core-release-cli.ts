import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { selectHostCoreSnapshot, verifyActiveHostCore } from './activation.js';
import {
  assertHostCoreSnapshotId,
  createHostCoreSnapshot,
  findHostCoreSnapshotByLabel,
  listHostCoreSnapshots,
  publishHostCoreRelease,
  removeHostCoreSnapshot,
  verifyHostCoreSnapshot,
} from './release.js';

type SnapshotCommand = 'create' | 'list' | 'select' | 'verify' | 'remove';

export type ParsedHostCoreArguments =
  | {
      readonly command: 'snapshot';
      readonly snapshotCommand: SnapshotCommand;
      readonly runtimeHome: string;
      readonly snapshotId?: string;
      readonly label?: string;
      readonly fullCheck: boolean;
    }
  | {
      readonly command: 'publish' | 'activate';
      readonly runtimeHome: string;
      readonly version: string;
      readonly skipValidation: boolean;
    }
  | {
      readonly command: 'verify-active' | 'launch-active';
      readonly runtimeHome: string;
    };

function usage(): never {
  throw new Error(
    'Usage: host-core snapshot <create|list|select|verify|remove> --runtime-home <path> [--id <snapshot-id>] [--label <label>] [--full-check]',
  );
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--'))
    return undefined;
  if (args.indexOf(flag, index + 1) >= 0) usage();
  return args[index + 1];
}

function assertAllowedFlags(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.includes(value)) {
      index += 1;
      if (!args[index] || args[index]!.startsWith('--')) usage();
    } else if (!booleanFlags.includes(value)) usage();
  }
}

export function parseHostCoreReleaseArguments(
  args: readonly string[],
): ParsedHostCoreArguments {
  if (args[0] === 'verify-active' || args[0] === 'launch-active') {
    if (args.length !== 3 || args[1] !== '--runtime-home' || !args[2]) usage();
    return { command: args[0], runtimeHome: path.resolve(args[2]) };
  }
  if (args[0] === 'publish' || args[0] === 'activate') {
    assertAllowedFlags(
      args.slice(1),
      ['--version', '--runtime-home'],
      ['--skip-validation'],
    );
    const version = valueAfter(args, '--version');
    const runtimeHome = valueAfter(args, '--runtime-home');
    if (!version || !runtimeHome) usage();
    return {
      command: args[0],
      version,
      runtimeHome: path.resolve(runtimeHome),
      skipValidation: args.includes('--skip-validation'),
    };
  }
  if (args[0] !== 'snapshot') usage();
  const snapshotCommand = args[1] as SnapshotCommand | undefined;
  if (
    !snapshotCommand ||
    !['create', 'list', 'select', 'verify', 'remove'].includes(snapshotCommand)
  )
    usage();
  const rest = args.slice(2);
  const valueFlags =
    snapshotCommand === 'create'
      ? ['--runtime-home', '--label']
      : snapshotCommand === 'list'
        ? ['--runtime-home']
        : ['--runtime-home', '--id'];
  assertAllowedFlags(
    rest,
    valueFlags,
    snapshotCommand === 'create' ? ['--full-check'] : [],
  );
  const runtimeHome = valueAfter(rest, '--runtime-home');
  if (!runtimeHome) usage();
  const snapshotId = valueAfter(rest, '--id');
  if (snapshotCommand !== 'create' && snapshotCommand !== 'list' && !snapshotId)
    usage();
  return {
    command: 'snapshot',
    snapshotCommand,
    runtimeHome: path.resolve(runtimeHome),
    snapshotId: snapshotId ? assertHostCoreSnapshotId(snapshotId) : undefined,
    label: valueAfter(rest, '--label'),
    fullCheck: rest.includes('--full-check'),
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

function printSnapshot(
  prefix: string,
  snapshot: { snapshot_id: string },
): void {
  console.log(`${prefix}=${snapshot.snapshot_id}`);
}

async function runSnapshotCommand(
  options: Extract<ParsedHostCoreArguments, { command: 'snapshot' }>,
): Promise<void> {
  switch (options.snapshotCommand) {
    case 'create': {
      const snapshot = createHostCoreSnapshot({
        projectRoot: path.resolve(import.meta.dirname, '../..'),
        runtimeHome: options.runtimeHome,
        label: options.label,
        fullCheck: options.fullCheck,
      });
      printSnapshot('host_core_snapshot_created', snapshot);
      console.log(`host_core_snapshot_validation=${snapshot.validation}`);
      if (snapshot.git.dirty)
        console.warn('host_core_snapshot_warning=dirty_checkout');
      return;
    }
    case 'list':
      for (const snapshot of listHostCoreSnapshots(options.runtimeHome))
        console.log(
          `${snapshot.snapshot_id}\t${snapshot.created_at}\t${snapshot.label ?? ''}\t${snapshot.validation}`,
        );
      return;
    case 'select': {
      const active = selectHostCoreSnapshot({
        runtimeHome: options.runtimeHome,
        snapshotId: options.snapshotId!,
      });
      printSnapshot('host_core_snapshot_active', active.manifest);
      return;
    }
    case 'verify': {
      const snapshot = verifyHostCoreSnapshot(
        options.runtimeHome,
        options.snapshotId!,
      );
      printSnapshot('host_core_snapshot_verified', snapshot);
      return;
    }
    case 'remove':
      removeHostCoreSnapshot(options.runtimeHome, options.snapshotId!);
      console.log(`host_core_snapshot_removed=${options.snapshotId!}`);
  }
}

async function main(): Promise<void> {
  const options = parseHostCoreReleaseArguments(process.argv.slice(2));
  if (options.command === 'snapshot') {
    await runSnapshotCommand(options);
    return;
  }
  if (options.command === 'verify-active') {
    const active = verifyActiveHostCore(options.runtimeHome);
    printSnapshot('active_host_core_snapshot', active.manifest);
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
          name !== 'NODE_PATH',
      ),
    ) as Record<string, string>;
    execve(
      process.execPath,
      [process.execPath, active.core_entry_path],
      environment,
    );
    return;
  }

  if (options.command === 'publish') {
    const snapshot = publishHostCoreRelease({
      projectRoot: path.resolve(import.meta.dirname, '../..'),
      runtimeHome: options.runtimeHome,
      version: options.version,
      skipValidation: options.skipValidation,
    });
    printSnapshot('host_core_snapshot_created', snapshot);
    console.log('host_core_activation=unchanged');
    return;
  }
  if (options.command !== 'activate')
    throw new Error('host_core_command_invalid');

  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('host_core_activation_confirmation_requires_tty');
  const target = findHostCoreSnapshotByLabel(
    options.runtimeHome,
    options.version,
  );
  console.log(`target_host_core_snapshot=${target.snapshot_id}`);
  if (!(await confirm('Select this Host Core snapshot as active-core? [y/N] ')))
    throw new Error('host_core_activation_cancelled');
  const active = selectHostCoreSnapshot({
    runtimeHome: options.runtimeHome,
    snapshotId: target.snapshot_id,
  });
  printSnapshot('host_core_snapshot_active', active.manifest);
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
)
  await main();
