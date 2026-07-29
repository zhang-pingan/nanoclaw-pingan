import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { G8MinimumMachineObservation } from '../contracts/g8-certification-types.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import type { JsonValue } from '../contracts/types.js';

function command(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
  });
  if (result.status !== 0 || result.stderr.trim().length > 0) {
    throw new Error(
      `Minimum-machine observation failed: ${path.basename(executable)} ${args.join(' ')}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function filesystemDevice(targetPath: string): string {
  const lines = command('/bin/df', ['-P', targetPath])
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const row = lines.at(-1)?.trim().split(/\s+/);
  if (!row?.[0]?.startsWith('/dev/')) {
    throw new Error('Minimum-machine target is not on a local device');
  }
  return row[0];
}

function normalizedReferenceMachine(cpuBrand: string, memoryBytes: number) {
  const cpu = cpuBrand.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const memoryGiB = Math.floor(memoryBytes / 1073741824);
  return `${cpu}_${memoryGiB}_gib_internal_apfs_ssd`;
}

export interface ObserveMinimumMachineOptions {
  readonly targetPath: string;
  readonly purpose: 'certification_reference' | 'startup_preflight';
  readonly confirmNoConcurrentBenchmarkInterference?: boolean;
}

export function observeMinimumMachineClass(
  options: ObserveMinimumMachineOptions,
): G8MinimumMachineObservation {
  const artifacts = loadG8FoundationArtifacts();
  const requirements = artifacts.minimumMachineClass.payload;
  if (
    requirements.class_id !== 'local_single_user_minimum_machine@1' ||
    requirements.platform !== 'darwin' ||
    requirements.arch !== 'arm64' ||
    requirements.cpu_family !== 'apple_silicon' ||
    requirements.minimum_cpu_generation !== 2 ||
    requirements.minimum_memory_bytes !== 17179869184 ||
    requirements.filesystem_type !== 'apfs' ||
    requirements.storage_class !== 'internal_ssd'
  ) {
    throw new Error('Minimum-machine contract fixed values drifted');
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Minimum-machine platform/architecture requirement failed');
  }
  const targetPath = path.resolve(options.targetPath);
  const cpuBrand = command('/usr/sbin/sysctl', [
    '-n',
    'machdep.cpu.brand_string',
  ]);
  const cpuGeneration = Number(cpuBrand.match(/^Apple M([0-9]+)(?:\s|$)/)?.[1]);
  if (
    !Number.isSafeInteger(cpuGeneration) ||
    cpuGeneration < requirements.minimum_cpu_generation
  ) {
    throw new Error(`Minimum CPU class requirement failed: ${cpuBrand}`);
  }
  const memoryBytes = os.totalmem();
  if (memoryBytes < requirements.minimum_memory_bytes) {
    throw new Error(`Minimum memory requirement failed: ${memoryBytes}`);
  }
  const device = filesystemDevice(targetPath);
  const diskInfo = command('/usr/sbin/diskutil', ['info', device]);
  if (
    !/^\s*File System Personality:\s*APFS\s*$/m.test(diskInfo) ||
    !/^\s*Device Location:\s*Internal\s*$/m.test(diskInfo) ||
    !/^\s*Solid State:\s*Yes\s*$/m.test(diskInfo)
  ) {
    throw new Error('Minimum APFS/internal SSD storage requirement failed');
  }
  let powerSource: 'ac_power' | 'battery' | 'not_required' = 'not_required';
  let benchmarkInterference: 'none_operator_confirmed' | 'not_applicable' =
    'not_applicable';
  if (options.purpose === 'certification_reference') {
    if (!options.confirmNoConcurrentBenchmarkInterference) {
      throw new Error(
        'Certification reference observation requires explicit no-interference confirmation',
      );
    }
    const power = command('/usr/bin/pmset', ['-g', 'batt']);
    if (!power.includes("Now drawing from 'AC Power'")) {
      throw new Error('Certification reference machine is not on AC power');
    }
    powerSource = 'ac_power';
    benchmarkInterference = 'none_operator_confirmed';
  }
  const payload = {
    format: 'icarus.minimum-machine-observation/1',
    purpose: options.purpose,
    minimum_machine_class_ref: artifacts.minimumMachineClass.ref,
    minimum_machine_class_hash: artifacts.minimumMachineClass.hash,
    cpu_brand: cpuBrand,
    cpu_generation: cpuGeneration,
    memory_bytes: memoryBytes,
    filesystem_type: 'apfs',
    filesystem_device: device,
    storage_class: 'internal_ssd',
    power_source: powerSource,
    benchmark_interference: benchmarkInterference,
    reference_machine: normalizedReferenceMachine(cpuBrand, memoryBytes),
  } as const;
  return {
    ...payload,
    observation_hash: domainSeparatedSha256(
      'icarus:minimum-machine-observation:1\n',
      payload as unknown as JsonValue,
    ),
  };
}
