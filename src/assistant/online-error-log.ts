import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, SSH_KEY_PATH, TIMEZONE } from '../config.js';
import { logger } from '../logger.js';
import type {
  AssistantOnlineLogServiceOption,
  AssistantSettings,
  UpsertAgentInboxItemInput,
} from './types.js';

const ONLINE_ERROR_LOG_RULE_KEY = 'online.error_logs';
const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_ENTRIES_PER_INBOX = 20;
const DEFAULT_MAX_RAW_LOG_CHARS = 12000;
const SSH_TIMEOUT_MS = 60_000;
const SSH_MAX_BUFFER = 8 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface ServiceLogConfig {
  service: string;
  config: JsonRecord;
  hosts: string[];
  logsErrorPath: string;
}

interface RemoteLogFile {
  path: string;
  size: number;
  mtime: number;
}

interface SshConfig extends JsonRecord {
  target_host: string;
  target_user?: string;
  error_log_path: string;
}

interface LogLineGroupMapping {
  time: number;
  level: number;
}

export interface OnlineErrorLogRecord {
  service: string;
  host: string;
  logPath: string;
  time: string;
  level: string;
  rawLog: string;
}

export interface OnlineErrorLogScanResult {
  service: string;
  hosts: string[];
  logPath: string;
  startTime: Date;
  endTime: Date;
  scannedAt: Date;
  errors: OnlineErrorLogRecord[];
  scanErrors: Array<{ host: string; error: string }>;
}

export type OnlineErrorLogReader = (input: {
  service: string;
  host: string;
  logPath: string;
  config: JsonRecord;
  startTime: Date;
  endTime: Date;
}) => string;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function readServiceRegistry(): Record<string, JsonRecord> {
  const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
  if (!fs.existsSync(servicesPath)) return {};
  try {
    const parsed = JSON.parse(
      fs.readFileSync(servicesPath, 'utf-8'),
    ) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, config]) => isRecord(config)),
    ) as Record<string, JsonRecord>;
  } catch (err) {
    logger.warn(
      { err, servicesPath },
      'Failed to parse services.json for online error log scan',
    );
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean);
  }
  const raw = stringValue(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getServiceHosts(config: JsonRecord): string[] {
  const ssh = isRecord(config.ssh) ? config.ssh : {};
  const hosts = [
    ...toStringArray(config.log_hosts),
    ...toStringArray(ssh.target_host),
    ...toStringArray(ssh.host),
  ];
  return Array.from(new Set(hosts));
}

function getServiceLogConfig(
  service: string,
  config: JsonRecord,
): ServiceLogConfig {
  return {
    service,
    config,
    hosts: getServiceHosts(config),
    logsErrorPath: stringValue(config.logs_error),
  };
}

function buildGroupMapping(config: JsonRecord): LogLineGroupMapping | null {
  const raw = config.log_line_group_mapping;
  if (!isRecord(raw)) return null;
  const time = Number(raw.time);
  const level = Number(raw.level);
  if (!Number.isInteger(time) || time < 1 || time > 50) return null;
  if (!Number.isInteger(level) || level < 1 || level > 50) return null;
  return { time, level };
}

export function listOnlineLogServiceOptions(
  registry: Record<string, JsonRecord> = readServiceRegistry(),
): AssistantOnlineLogServiceOption[] {
  return Object.keys(registry)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((service) => {
      const item = getServiceLogConfig(service, registry[service] || {});
      const missing: string[] = [];
      if (item.hosts.length === 0) missing.push('log_hosts');
      if (!item.logsErrorPath) missing.push('logs_error');
      if (!stringValue(item.config.log_line_pattern))
        missing.push('log_line_pattern');
      if (!buildGroupMapping(item.config)) missing.push('log_line_group_mapping');
      return {
        service,
        hosts: item.hosts,
        logsErrorPath: item.logsErrorPath,
        configured: missing.length === 0,
        disabledReason:
          missing.length === 0 ? null : `缺少 ${missing.join(' / ')}`,
      };
    });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function containsWildcard(value: string): boolean {
  return /[*?[]/.test(value);
}

function assertSafeRemoteGlob(remotePath: string): void {
  if (!containsWildcard(remotePath)) return;
  if (!/^[a-zA-Z0-9_./*?[\]-]+$/.test(remotePath)) {
    throw new Error(
      `remote log glob contains unsupported characters: ${remotePath}`,
    );
  }
}

function buildProxyCommand(cfg: JsonRecord): string {
  const jumpHost = stringValue(cfg.jump_host);
  if (!jumpHost) return '';
  const jumpUser = stringValue(cfg.jump_user);
  const keyPath = stringValue(cfg.key_path || cfg.identity_file);
  const parts = ['ssh', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=60'];
  if (keyPath)
    parts.push(
      '-i',
      shellQuote(path.resolve(keyPath.replace(/^~/, process.env.HOME || ''))),
    );
  parts.push('-W', '%h:%p', `${jumpUser ? `${jumpUser}@` : ''}${jumpHost}`);
  return parts.join(' ');
}

function buildSshCommand(cfg: SshConfig): { command: string; args: string[] } {
  const targetHost = stringValue(cfg.target_host || cfg.host);
  const targetUser = stringValue(cfg.target_user || cfg.user);
  if (!targetHost) throw new Error('ssh.target_host 未配置');

  const baseArgs = [
    '-o',
    'ConnectTimeout=60',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
  ];
  const proxyCommand = buildProxyCommand(cfg);
  if (proxyCommand) {
    baseArgs.push(
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      `ProxyCommand=${proxyCommand}`,
    );
  }

  const targetKeyPath = stringValue(cfg.target_key_path);
  const keyPath =
    targetKeyPath ||
    (SSH_KEY_PATH && fs.existsSync(SSH_KEY_PATH) ? SSH_KEY_PATH : '');
  if (keyPath) baseArgs.push('-i', keyPath);

  const port = stringValue(cfg.port);
  if (port) baseArgs.push('-p', port);

  const target = `${targetUser ? `${targetUser}@` : ''}${targetHost}`;
  const password = stringValue(cfg.target_password);
  if (password) {
    return {
      command: 'sshpass',
      args: [
        '-p',
        password,
        'ssh',
        ...baseArgs,
        '-o',
        'PreferredAuthentications=password',
        '-o',
        'PubkeyAuthentication=no',
        target,
      ],
    };
  }
  return { command: 'ssh', args: [...baseArgs, target] };
}

function runSshCommand(cfg: SshConfig, remoteCommand: string): string {
  const { command, args } = buildSshCommand(cfg);
  const proc = spawnSync(command, [...args, remoteCommand], {
    encoding: 'buffer',
    maxBuffer: SSH_MAX_BUFFER,
    timeout: SSH_TIMEOUT_MS,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    const stderr = (proc.stderr || Buffer.alloc(0)).toString('utf-8').trim();
    throw new Error(`ssh failed code=${proc.status}: ${stderr || 'no stderr'}`);
  }
  return (proc.stdout || Buffer.alloc(0)).toString('utf-8');
}

export function parseRemoteLogFileLineForTests(
  line: string,
): RemoteLogFile | null {
  const parts = line.includes('\t') ? line.split('\t') : line.split('\\t');
  if (parts.length < 3) return null;
  const mtime = Number(parts[0]);
  const size = Number(parts[1]);
  const filePath = parts.slice(2).join('\t').trim();
  if (!Number.isFinite(mtime) || !Number.isFinite(size) || !filePath) {
    return null;
  }
  return { path: filePath, size, mtime };
}

function listRemoteLogFiles(
  cfg: SshConfig,
  remotePath: string,
): RemoteLogFile[] {
  assertSafeRemoteGlob(remotePath);
  const remoteCommand = containsWildcard(remotePath)
    ? `sh -lc ${shellQuote(
          `set -- ${remotePath}; ` +
          `if [ "$#" -eq 0 ] || [ "$1" = ${shellQuote(remotePath)} ]; then ` +
          `echo "no files matched: ${remotePath}" >&2; exit 1; fi; ` +
          'for f in "$@"; do [ -f "$f" ] || continue; ' +
          'printf \'%s\\t%s\\t%s\\n\' "$(stat -c %Y "$f")" "$(stat -c %s "$f")" "$f"; ' +
          'done | sort -n -k1,1 -k3,3',
      )}`
    : `sh -lc ${shellQuote(
        `f=${shellQuote(remotePath)}; ` +
          `[ -f "$f" ] || { echo "file not found: ${remotePath}" >&2; exit 1; }; ` +
          'printf \'%s\\t%s\\t%s\\n\' "$(stat -c %Y "$f")" "$(stat -c %s "$f")" "$f"',
      )}`;

  return runSshCommand(cfg, remoteCommand)
    .split('\n')
    .map(parseRemoteLogFileLineForTests)
    .filter((item): item is RemoteLogFile => Boolean(item));
}

function readRemoteFileSegments(
  cfg: SshConfig,
  segments: Array<{ path: string; startByte: number }>,
): string {
  if (segments.length === 0) return '';
  const clauses = segments.map(
    (segment) =>
      `tail -c +${Math.max(1, Math.round(segment.startByte))} ${shellQuote(segment.path)}; printf "\\n"`,
  );
  return runSshCommand(cfg, `sh -lc ${shellQuote(clauses.join('; '))}`);
}

function buildSshConfig(input: {
  host: string;
  logPath: string;
  config: JsonRecord;
}): SshConfig {
  const ssh = isRecord(input.config.ssh) ? { ...input.config.ssh } : {};
  const copyKeys = [
    'jump_host',
    'jump_user',
    'key_path',
    'identity_file',
    'target_key_path',
    'target_password',
    'port',
    'overlap_bytes',
    'max_bytes_per_file',
    'max_files',
    'timezone',
  ];
  for (const key of copyKeys) {
    if (ssh[key] === undefined && input.config[key] !== undefined) {
      ssh[key] = input.config[key];
    }
  }
  return {
    ...ssh,
    target_host: input.host,
    target_user: stringValue(
      ssh.target_user || input.config.target_user || input.config.user,
    ),
    error_log_path: stringValue(ssh.error_log_path || input.logPath),
  };
}

function readRemoteErrorLog(input: {
  service: string;
  host: string;
  logPath: string;
  config: JsonRecord;
}): string {
  const sshCfg = buildSshConfig(input);
  const remotePath = stringValue(sshCfg.error_log_path || input.logPath);
  if (!remotePath) throw new Error('logs_error 未配置');
  const files = listRemoteLogFiles(sshCfg, remotePath);
  const maxFiles = numberValue(
    input.config.online_error_log_max_files,
    DEFAULT_MAX_FILES,
    1,
    20,
  );
  const maxBytes = numberValue(
    input.config.online_error_log_max_bytes,
    DEFAULT_MAX_BYTES_PER_FILE,
    4096,
    64 * 1024 * 1024,
  );
  const selectedFiles = files.slice(-maxFiles);
  return readRemoteFileSegments(
    sshCfg,
    selectedFiles.map((file) => ({
      path: file.path,
      startByte: Math.max(1, file.size - maxBytes + 1),
    })),
  );
}

function parseDateTime(value: string): Date | null {
  const normalized = value.trim().replace(',', '.');
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/,
  );
  if (match) {
    const ms = Number((match[7] || '0').slice(0, 3).padEnd(3, '0'));
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number.isFinite(ms) ? ms : 0,
    );
  }
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isFirstLineOfEntry(line: string, pattern: RegExp): boolean {
  if (!line.trim()) return false;
  pattern.lastIndex = 0;
  return pattern.test(line.trim());
}

function groupLinesIntoEntries(lines: string[], pattern: RegExp): string[][] {
  const result: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (isFirstLineOfEntry(line, pattern)) {
      if (current) result.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) result.push(current);
  return result;
}

function buildLinePattern(config: JsonRecord): RegExp {
  const raw = stringValue(config.log_line_pattern);
  if (!raw) {
    throw new Error('log_line_pattern 未配置');
  }
  try {
    return new RegExp(raw, 's');
  } catch (err) {
    throw new Error(
      `log_line_pattern 无法编译：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function safeMatchGroup(match: RegExpMatchArray, idx: number): string {
  return (match[idx] || '').trim();
}

export function parseOnlineErrorLogText(input: {
  service: string;
  host: string;
  logPath: string;
  logText: string;
  startTime?: Date | null;
  endTime?: Date | null;
  config?: JsonRecord;
}): OnlineErrorLogRecord[] {
  const config = input.config || {};
  const pattern = buildLinePattern(config);
  const groupMapping = buildGroupMapping(config);
  if (!groupMapping) {
    throw new Error('log_line_group_mapping 未配置或无效');
  }
  const entries = groupLinesIntoEntries(input.logText.split(/\r?\n/), pattern);
  const result: OnlineErrorLogRecord[] = [];

  for (const entry of entries) {
    const firstLine = entry[0] || '';
    pattern.lastIndex = 0;
    const match = firstLine.trim().match(pattern);
    if (!match) continue;

    const time = safeMatchGroup(match, groupMapping.time);
    const level = safeMatchGroup(match, groupMapping.level);
    if (!time) continue;
    if (level.toUpperCase() !== 'ERROR') continue;

    const parsedTime = parseDateTime(time);
    if (input.startTime || input.endTime) {
      if (!parsedTime) continue;
      if (input.startTime && parsedTime < input.startTime) continue;
      if (input.endTime && parsedTime >= input.endTime) continue;
    }

    const fullEntry = entry.join('\n');

    result.push({
      service: input.service,
      host: input.host,
      logPath: input.logPath,
      time,
      level,
      rawLog: fullEntry,
    });
  }

  return result;
}

function scanOneService(input: {
  service: string;
  config: JsonRecord;
  hosts: string[];
  logPath: string;
  startTime: Date;
  endTime: Date;
  scannedAt: Date;
  readRemoteLog: OnlineErrorLogReader;
}): OnlineErrorLogScanResult {
  const errors: OnlineErrorLogRecord[] = [];
  const scanErrors: Array<{ host: string; error: string }> = [];
  for (const host of input.hosts) {
    try {
      const logText = input.readRemoteLog({
        service: input.service,
        host,
        logPath: input.logPath,
        config: input.config,
        startTime: input.startTime,
        endTime: input.endTime,
      });
      if (!logText.trim()) continue;
      errors.push(
        ...parseOnlineErrorLogText({
          service: input.service,
          host,
          logPath: input.logPath,
          logText,
          startTime: input.startTime,
          endTime: input.endTime,
          config: input.config,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scanErrors.push({ host, error: message });
      logger.warn(
        { err, service: input.service, host, logPath: input.logPath },
        'Online error log scan failed for host',
      );
    }
  }
  return {
    service: input.service,
    hosts: input.hosts,
    logPath: input.logPath,
    startTime: input.startTime,
    endTime: input.endTime,
    scannedAt: input.scannedAt,
    errors,
    scanErrors,
  };
}

function formatWindowTime(date: Date): string {
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function buildInboxBody(result: OnlineErrorLogScanResult): string {
  return `最近 ${DEFAULT_WINDOW_MINUTES} 分钟扫描到 ${result.errors.length} 条 ERROR 日志。`;
}

function buildInboxExtra(result: OnlineErrorLogScanResult): JsonRecord {
  return {
    service: result.service,
    hosts: result.hosts,
    logPath: result.logPath,
    scannedAt: result.scannedAt.toISOString(),
    window: {
      minutes: DEFAULT_WINDOW_MINUTES,
      start: formatWindowTime(result.startTime),
      end: formatWindowTime(result.endTime),
      timezone: TIMEZONE,
    },
    totalErrorCount: result.errors.length,
    scanErrors: result.scanErrors,
    logs: result.errors
      .slice(0, DEFAULT_MAX_ENTRIES_PER_INBOX)
      .map((error) => ({
        service: error.service,
        host: error.host,
        logPath: error.logPath,
        time: error.time,
        level: error.level,
        rawLog: truncateText(error.rawLog, DEFAULT_MAX_RAW_LOG_CHARS),
      })),
  };
}

function buildDedupeKey(result: OnlineErrorLogScanResult): string {
  const bucket = Math.floor(
    result.endTime.getTime() / (DEFAULT_WINDOW_MINUTES * 60 * 1000),
  );
  return `online-error-logs:${result.service}:${bucket}`;
}

function buildActionUrl(service: string): string {
  const url = new URL('http://localhost:3000/');
  url.searchParams.set('assistantTarget', 'assistant');
  url.searchParams.set('source', 'online_error_log');
  url.searchParams.set('service', service);
  return url.toString();
}

export function scanOnlineErrorLogRule(input: {
  settings: AssistantSettings;
  now?: Date;
  registry?: Record<string, JsonRecord>;
  readRemoteLog?: OnlineErrorLogReader;
}): UpsertAgentInboxItemInput[] {
  const ruleSettings = input.settings.triggerRules[ONLINE_ERROR_LOG_RULE_KEY];
  if (!ruleSettings?.enabled) return [];
  const selectedServices = Array.from(
    new Set(
      (ruleSettings.selectedServices || [])
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  if (selectedServices.length === 0) return [];

  const registry = input.registry || readServiceRegistry();
  const now = input.now || new Date();
  const endTime = now;
  const startTime = new Date(
    now.getTime() - DEFAULT_WINDOW_MINUTES * 60 * 1000,
  );
  const readRemoteLog =
    input.readRemoteLog || ((args) => readRemoteErrorLog(args));
  const items: UpsertAgentInboxItemInput[] = [];

  for (const service of selectedServices) {
    const serviceConfig = registry[service];
    if (!isRecord(serviceConfig)) continue;
    const logConfig = getServiceLogConfig(service, serviceConfig);
    if (logConfig.hosts.length === 0 || !logConfig.logsErrorPath) continue;
    const result = scanOneService({
      service,
      config: serviceConfig,
      hosts: logConfig.hosts,
      logPath: logConfig.logsErrorPath,
      startTime,
      endTime,
      scannedAt: now,
      readRemoteLog,
    });
    if (result.errors.length === 0) continue;

    items.push({
      dedupeKey: buildDedupeKey(result),
      kind: 'risk',
      priority: result.errors.length >= 5 ? 'urgent' : 'high',
      title: `线上 error 日志：${service}`,
      body: buildInboxBody(result),
      triggerRuleKey: ONLINE_ERROR_LOG_RULE_KEY,
      sourceType: 'online_error_log',
      sourceRefId: service,
      actionKind: 'open_online_error_log',
      actionLabel: '查看日志',
      actionUrl: buildActionUrl(service),
      extra: {
        onlineErrorLog: buildInboxExtra(result),
      },
    });
  }

  return items;
}
