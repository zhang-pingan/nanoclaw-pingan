import { execFile, spawn } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import type { IosClientConfig } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEBUG_MAX_OUTPUT_BYTES = 20_000;

export interface CommandResult {
  command: string;
  args: string[];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface SimulatorDevice {
  name: string;
  udid: string;
  state: string;
}

let simulatorLock: Promise<void> = Promise.resolve();
const simulatorLockContext = new AsyncLocalStorage<boolean>();

function trimOutput(value: string, maxBytes = DEBUG_MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return `${value.slice(0, end)}\n[truncated]`;
}

export async function withIosSimulatorLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (simulatorLockContext.getStore() === true) {
    return fn();
  }
  const previous = simulatorLock;
  let release: () => void = () => {};
  simulatorLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await simulatorLockContext.run(true, fn);
  } finally {
    release();
  }
}

export async function runHostCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: (options.maxOutputBytes || DEBUG_MAX_OUTPUT_BYTES) * 2,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
        HOME: process.env.HOME,
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    });
    return {
      command,
      args,
      exit_code: 0,
      stdout: trimOutput(result.stdout || '', options.maxOutputBytes),
      stderr: trimOutput(result.stderr || '', options.maxOutputBytes),
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    const maybe = err as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      command,
      args,
      exit_code:
        typeof maybe.code === 'number'
          ? maybe.code
          : maybe.code === undefined
            ? null
            : Number(maybe.code) || null,
      stdout: trimOutput(String(maybe.stdout || ''), options.maxOutputBytes),
      stderr: trimOutput(
        String(maybe.stderr || maybe.message || ''),
        options.maxOutputBytes,
      ),
      duration_ms: Date.now() - startedAt,
    };
  }
}

function parseSimctlDevices(stdout: string): SimulatorDevice[] {
  const devices: SimulatorDevice[] = [];
  const parsed = JSON.parse(stdout) as {
    devices?: Record<string, Array<{ name?: string; udid?: string; state?: string }>>;
  };
  for (const runtimeDevices of Object.values(parsed.devices || {})) {
    for (const device of runtimeDevices) {
      if (device.name && device.udid && device.state) {
        devices.push({
          name: device.name,
          udid: device.udid,
          state: device.state,
        });
      }
    }
  }
  return devices;
}

export async function findSimulatorDevice(
  simulatorName: string,
): Promise<SimulatorDevice> {
  const result = await runHostCommand('xcrun', [
    'simctl',
    'list',
    'devices',
    'available',
    '--json',
  ]);
  if (result.exit_code !== 0) {
    throw new Error(`xcrun simctl list failed: ${result.stderr || result.stdout}`);
  }
  const devices = parseSimctlDevices(result.stdout);
  const booted = devices.find(
    (device) => device.name === simulatorName && device.state === 'Booted',
  );
  const named = devices.find((device) => device.name === simulatorName);
  const selected = booted || named || devices.find((device) => device.state === 'Booted');
  if (!selected) {
    throw new Error(`No available iOS simulator found for "${simulatorName}"`);
  }
  return selected;
}

export async function bootSimulator(udid: string): Promise<void> {
  const result = await runHostCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeoutMs: 180_000,
  });
  if (result.exit_code === 0) return;

  const boot = await runHostCommand('xcrun', ['simctl', 'boot', udid], {
    timeoutMs: 120_000,
  });
  if (
    boot.exit_code !== 0 &&
    !/already booted/i.test(`${boot.stdout}\n${boot.stderr}`)
  ) {
    throw new Error(`xcrun simctl boot failed: ${boot.stderr || boot.stdout}`);
  }
  const status = await runHostCommand('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeoutMs: 180_000,
  });
  if (status.exit_code !== 0) {
    throw new Error(`xcrun simctl bootstatus failed: ${status.stderr || status.stdout}`);
  }
}

function buildOutputPath(repoPath: string, config: IosClientConfig): string {
  const derivedData = path.join(repoPath, 'DerivedData', 'Icarus');
  const configuration = config.configuration || 'Debug';
  const appName = config.scheme.endsWith('.app') ? config.scheme : `${config.scheme}.app`;
  return path.join(
    derivedData,
    'Build',
    'Products',
    `${configuration}-iphonesimulator`,
    appName,
  );
}

export async function buildIosApp(
  repoPath: string,
  config: IosClientConfig,
  simulatorName: string,
): Promise<{ appPath: string; command: CommandResult }> {
  const derivedData = path.join(repoPath, 'DerivedData', 'Icarus');
  const args = [
    ...(config.workspace ? ['-workspace', config.workspace] : []),
    ...(config.project ? ['-project', config.project] : []),
    '-scheme',
    config.scheme,
    '-configuration',
    config.configuration || 'Debug',
    '-destination',
    `platform=iOS Simulator,name=${simulatorName}`,
    '-derivedDataPath',
    derivedData,
    'build',
  ];
  const result = await runHostCommand('xcodebuild', args, {
    cwd: repoPath,
    timeoutMs: 20 * 60 * 1000,
    maxOutputBytes: 40_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`xcodebuild failed: ${result.stderr || result.stdout}`);
  }
  const appPath = buildOutputPath(repoPath, config);
  if (!fs.existsSync(appPath)) {
    throw new Error(`xcodebuild succeeded but app was not found at ${appPath}`);
  }
  return { appPath, command: result };
}

export async function installIosApp(
  udid: string,
  appPath: string,
): Promise<void> {
  const result = await runHostCommand('xcrun', ['simctl', 'install', udid, appPath], {
    timeoutMs: 180_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`xcrun simctl install failed: ${result.stderr || result.stdout}`);
  }
}

export async function uninstallIosApp(
  udid: string,
  bundleId: string,
): Promise<void> {
  const result = await runHostCommand('xcrun', ['simctl', 'uninstall', udid, bundleId], {
    timeoutMs: 60_000,
  });
  if (
    result.exit_code !== 0 &&
    !/No such application|not installed|Invalid bundle identifier/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    throw new Error(`xcrun simctl uninstall failed: ${result.stderr || result.stdout}`);
  }
}

export async function launchIosApp(input: {
  udid: string;
  bundleId: string;
  launchArgs?: string[];
  launchEnv?: Record<string, string>;
}): Promise<void> {
  const args = ['simctl', 'launch'];
  for (const [key, value] of Object.entries(input.launchEnv || {})) {
    args.push('--env', key, value);
  }
  args.push(input.udid, input.bundleId, ...(input.launchArgs || []));
  const result = await runHostCommand('xcrun', args, { timeoutMs: 60_000 });
  if (result.exit_code !== 0) {
    throw new Error(`xcrun simctl launch failed: ${result.stderr || result.stdout}`);
  }
}

export async function terminateIosApp(
  udid: string,
  bundleId: string,
): Promise<void> {
  await runHostCommand('xcrun', ['simctl', 'terminate', udid, bundleId], {
    timeoutMs: 30_000,
  });
}

export async function openDeepLink(
  udid: string,
  url: string,
): Promise<CommandResult> {
  return runHostCommand('xcrun', ['simctl', 'openurl', udid, url], {
    timeoutMs: 30_000,
  });
}

export async function getAppContainerPath(
  udid: string,
  bundleId: string,
): Promise<string> {
  const result = await runHostCommand('xcrun', [
    'simctl',
    'get_app_container',
    udid,
    bundleId,
    'data',
  ]);
  if (result.exit_code !== 0) {
    throw new Error(
      `xcrun simctl get_app_container failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export async function runDebugShellCommand(input: {
  command: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<CommandResult> {
  const trimmed = input.command.trim();
  if (!trimmed) throw new Error('command is required');
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    const child = spawn('/bin/zsh', ['-lc', trimmed], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
        HOME: process.env.HOME,
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxBytes = input.maxBytes || DEBUG_MAX_OUTPUT_BYTES;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = trimOutput(stdout + chunk.toString('utf8'), maxBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = trimOutput(stderr + chunk.toString('utf8'), maxBytes);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, input.timeoutMs || 30_000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        command: '/bin/zsh',
        args: ['-lc', trimmed],
        exit_code: code,
        stdout,
        stderr,
        duration_ms: Date.now() - startedAt,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        command: '/bin/zsh',
        args: ['-lc', trimmed],
        exit_code: null,
        stdout,
        stderr: err.message,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}
