/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.icarus')) {
        // Check if it has a PID (actually running)
        const line = output.split('\n').find((l) => l.includes('com.icarus'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active icarus`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('icarus.service')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'icarus.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'WECOM_CORP_ID',
    'WECOM_APP_SECRET',
    'WECOM_AGENT_ID',
    'WECOM_APP_TOKEN',
    'WECOM_APP_ENCODING_AES_KEY',
  ]);

  const channelAuth: Record<string, string> = {
    assistant: 'available',
    web: 'available',
  };

  // Token-based channels: check .env
  if (
    (process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID) &&
    (process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET)
  ) {
    channelAuth.feishu = 'configured';
  }
  if (
    (process.env.WECOM_CORP_ID || envVars.WECOM_CORP_ID) &&
    (process.env.WECOM_APP_SECRET || envVars.WECOM_APP_SECRET) &&
    (process.env.WECOM_AGENT_ID || envVars.WECOM_AGENT_ID) &&
    (process.env.WECOM_APP_TOKEN || envVars.WECOM_APP_TOKEN) &&
    (process.env.WECOM_APP_ENCODING_AES_KEY ||
      envVars.WECOM_APP_ENCODING_AES_KEY)
  ) {
    channelAuth.wecom = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. Check registered Agents (using better-sqlite3, not sqlite3 CLI)
  let registeredAgents = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_agents')
        .get() as { count: number };
      registeredAgents = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'icarus', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // Determine overall status
  const status =
    service === 'running' &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredAgents > 0
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_AGENTS: registeredAgents,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
