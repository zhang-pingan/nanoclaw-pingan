/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import { getPlatform, getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';
import { renderLaunchdPlist } from './launchd.js';

function servicePath(hostLauncherPath: string, homeDir: string): string {
  return [
    path.dirname(hostLauncherPath),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/home/linuxbrew/.linuxbrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(homeDir, '.local', 'bin'),
  ].join(':');
}

export function childProcessFailureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : typeof stderr === 'string'
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return detail.trim().replaceAll(/\s*\n\s*/g, ' ');
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();
  const hostLauncherPath = path.join(
    projectRoot,
    'local',
    'shell',
    'launch-host.sh',
  );
  const runtimeToolchainPath = path.join(
    projectRoot,
    'scripts',
    'runtime-toolchain.sh',
  );

  logger.info(
    { platform, hostLauncherPath, projectRoot },
    'Setting up service',
  );

  logger.info('Configuring a compatible Node runtime and building TypeScript');
  try {
    try {
      execFileSync(
        runtimeToolchainPath,
        ['configure', '--node', process.execPath],
        {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      logger.warn(
        'Current Node is incompatible; installing the supported fallback',
      );
      execFileSync(runtimeToolchainPath, ['install'], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    execFileSync(runtimeToolchainPath, ['exec', '--', 'npm', 'run', 'build'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Compatible runtime build succeeded');
  } catch (error) {
    const diagnostic = childProcessFailureDetail(error);
    logger.error({ diagnostic }, 'Compatible runtime setup or build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      HOST_LAUNCHER: hostLauncherPath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'compatible_runtime_or_build_failed',
      DIAGNOSTIC: diagnostic,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, hostLauncherPath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, hostLauncherPath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      HOST_LAUNCHER: hostLauncherPath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function setupLaunchd(
  projectRoot: string,
  hostLauncherPath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.icarus.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = renderLaunchdPlist(projectRoot, hostLauncherPath, homeDir);

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch {
    logger.warn('launchctl load failed (may already be loaded)');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.icarus');
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    HOST_LAUNCHER: hostLauncherPath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  hostLauncherPath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, hostLauncherPath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, hostLauncherPath);
  }
}

/**
 * Kill any orphaned Icarus node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned Icarus processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

function setupSystemd(
  projectRoot: string,
  hostLauncherPath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/icarus.service';
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, hostLauncherPath);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'icarus.service');
    systemctlPrefix = 'systemctl --user';
  }

  const unit = renderSystemdUnit(
    hostLauncherPath,
    projectRoot,
    homeDir,
    runningAsRoot,
  );

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  // Detect stale docker group before starting (user systemd only)
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  // Kill orphaned Icarus processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable icarus`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start icarus`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active icarus`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    HOST_LAUNCHER: hostLauncherPath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

export function renderSystemdUnit(
  hostLauncherPath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=Icarus Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${JSON.stringify(hostLauncherPath)} --mode current
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=${servicePath(hostLauncherPath, homeDir)}
StandardOutput=append:${projectRoot}/logs/icarus.log
StandardError=append:${projectRoot}/logs/icarus.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

function setupNohupFallback(
  projectRoot: string,
  hostLauncherPath: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, 'start-icarus.sh');
  const pidFile = path.join(projectRoot, 'icarus.pid');

  const wrapper = renderNohupWrapper(hostLauncherPath, projectRoot, pidFile);

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    HOST_LAUNCHER: hostLauncherPath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

export function renderNohupWrapper(
  hostLauncherPath: string,
  projectRoot: string,
  pidFile: string,
): string {
  const lines = [
    '#!/bin/bash',
    '# start-icarus.sh — Start Icarus without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing Icarus (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting Icarus..."',
    `nohup ${JSON.stringify(hostLauncherPath)} --mode current \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/icarus.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/icarus.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "Icarus started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/icarus.log"`,
  ];
  return lines.join('\n') + '\n';
}
