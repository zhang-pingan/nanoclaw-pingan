import fs from 'fs';
import path from 'path';

import { IosEvidenceStore } from './ios-evidence-store.js';
import { getAppContainerPath } from './ios-simulator.js';
import { redactJson } from './ios-redaction.js';
import type { IosActionWindow, IosSessionRecord, JsonObject } from './types.js';

export interface ReadTraceInput {
  session_id: string;
  after_action?: string;
  types?: string[];
  filters?: {
    path_contains?: string;
    method?: string;
    status?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonl(filePath: string): JsonObject[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2000)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isRecord(parsed) ? (parsed as JsonObject) : null;
      } catch {
        return null;
      }
    })
    .filter((item): item is JsonObject => item !== null);
}

function readRelativeTextFile(root: string, relativePath: string): string {
  if (!relativePath) return '';
  const filePath = path.resolve(path.join(root, relativePath));
  if (filePath === root || !filePath.startsWith(root + path.sep)) {
    throw new Error('trace artifact path escapes Simulator app container');
  }
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function tailLines(value: string, maxLines = 200): string[] {
  return value.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function eventMatches(event: JsonObject, input: ReadTraceInput): boolean {
  const filters = input.filters || {};
  const pathValue =
    typeof event.path === 'string'
      ? event.path
      : typeof event.url === 'string'
        ? event.url
        : '';
  if (filters.path_contains && !pathValue.includes(filters.path_contains)) {
    return false;
  }
  if (
    filters.method &&
    String(event.method || '').toUpperCase() !== filters.method.toUpperCase()
  ) {
    return false;
  }
  if (
    filters.status !== undefined &&
    Number(event.status || event.status_code) !== filters.status
  ) {
    return false;
  }
  return true;
}

function parseEventTimestamp(event: JsonObject): number | null {
  const candidates = [
    event.timestamp,
    event.time,
    event.ts,
    event.created_at,
    event.started_at,
    event.request_started_at,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 10_000_000_000 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readActionWindow(
  store: IosEvidenceStore,
  sessionId: string,
  actionId?: string,
): IosActionWindow | null {
  if (!actionId) return null;
  const evidence = store.getEvidence(sessionId, actionId);
  if (!evidence || evidence.type !== 'ACT' || !isRecord(evidence.payload)) {
    throw new Error(
      `after_action must reference an ACT evidence in this session: ${actionId}`,
    );
  }
  const timeWindow = evidence.payload.time_window;
  if (!isRecord(timeWindow)) {
    throw new Error(`ACT evidence has no time_window: ${actionId}`);
  }
  const startedAt =
    typeof timeWindow.started_at === 'string' ? timeWindow.started_at : '';
  const endedAt =
    typeof timeWindow.ended_at === 'string' ? timeWindow.ended_at : '';
  if (!startedAt || !endedAt) {
    throw new Error(`ACT evidence has incomplete time_window: ${actionId}`);
  }
  return { started_at: startedAt, ended_at: endedAt };
}

function eventWithinActionWindow(
  event: JsonObject,
  window: IosActionWindow | null,
): boolean {
  if (!window) return true;
  const timestamp = parseEventTimestamp(event);
  if (timestamp === null) return false;
  const startedAt = Date.parse(window.started_at);
  const endedAt = Date.parse(window.ended_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return false;
  return timestamp >= startedAt - 250 && timestamp <= endedAt + 1000;
}

function wantsTraceType(input: ReadTraceInput, type: string): boolean {
  return input.types?.includes(type) === true;
}

export async function readIosTrace(input: {
  store: IosEvidenceStore;
  session: IosSessionRecord;
  request: ReadTraceInput;
}): Promise<{
  network_events: JsonObject[];
  app_logs: JsonObject[];
  crashes: JsonObject[];
  evidence: string[];
}> {
  const networkLogPath =
    typeof input.session.config.automation === 'object' &&
    input.session.config.automation &&
    !Array.isArray(input.session.config.automation) &&
    typeof input.session.config.automation.network_log_path === 'string'
      ? input.session.config.automation.network_log_path
      : '';
  const appLogPath =
    typeof input.session.config.automation === 'object' &&
    input.session.config.automation &&
    !Array.isArray(input.session.config.automation) &&
    typeof input.session.config.automation.app_log_path === 'string'
      ? input.session.config.automation.app_log_path
      : '';
  const crashLogPath =
    typeof input.session.config.automation === 'object' &&
    input.session.config.automation &&
    !Array.isArray(input.session.config.automation) &&
    typeof input.session.config.automation.crash_log_path === 'string'
      ? input.session.config.automation.crash_log_path
      : '';

  const evidence: string[] = [];
  const networkEvents: JsonObject[] = [];
  const appLogs: JsonObject[] = [];
  const crashes: JsonObject[] = [];
  let appContainer: string | null = null;
  const getContainer = async () => {
    if (!appContainer) {
      appContainer = await getAppContainerPath(
        input.session.simulator_udid || 'booted',
        input.session.bundle_id,
      );
    }
    return path.resolve(appContainer);
  };
  if (input.request.types?.includes('network') !== false) {
    if (!networkLogPath) {
      throw new Error(
        'clients.ios.automation.network_log_path is required for network trace',
      );
    }
    const actionWindow = readActionWindow(
      input.store,
      input.session.session_id,
      input.request.after_action,
    );
    const root = await getContainer();
    const logPath = path.resolve(path.join(root, networkLogPath));
    if (logPath === root || !logPath.startsWith(root + path.sep)) {
      throw new Error('network_log_path escapes Simulator app container');
    }
    if (!fs.existsSync(logPath)) {
      throw new Error(`network log file does not exist: ${networkLogPath}`);
    }

    const events = parseJsonl(logPath).filter(
      (event) =>
        eventWithinActionWindow(event, actionWindow) &&
        eventMatches(event, input.request),
    );
    for (const event of events.slice(-100)) {
      const redacted = redactJson(event);
      const redactedValue = redacted.value;
      const method = String(redactedValue.method || '').toUpperCase();
      const eventPath = String(redactedValue.path || redactedValue.url || '');
      const netEvidence = input.store.createEvidence({
        type: 'NET',
        session_id: input.session.session_id,
        source: 'ios_app_read_trace',
        summary: `${method || 'HTTP'} ${eventPath || '(unknown path)'}`,
        payload: {
          ...redactedValue,
          triggered_by: input.request.after_action || null,
        } as JsonObject,
      });
      evidence.push(netEvidence.id);
      networkEvents.push({
        id: netEvidence.id,
        method,
        path: eventPath,
        status: Number(event.status || event.status_code || 0) || null,
        latency_ms: Number(event.latency_ms || event.duration_ms || 0) || null,
        triggered_by: input.request.after_action || null,
        request_summary: isRecord(redactedValue.request_summary)
          ? (redactedValue.request_summary as JsonObject)
          : isRecord(redactedValue.request)
            ? (redactedValue.request as JsonObject)
            : {},
        response_summary: isRecord(redactedValue.response_summary)
          ? (redactedValue.response_summary as JsonObject)
          : isRecord(redactedValue.response)
            ? (redactedValue.response as JsonObject)
            : {},
      });
    }
  }

  if (wantsTraceType(input.request, 'app_log') && appLogPath) {
    const root = await getContainer();
    const redacted = redactJson({
      lines: tailLines(readRelativeTextFile(root, appLogPath)),
    });
    const record = input.store.createEvidence({
      type: 'APP_LOG',
      session_id: input.session.session_id,
      source: 'ios_app_read_trace',
      summary: `App log ${appLogPath}`,
      payload: redacted.value as JsonObject,
    });
    evidence.push(record.id);
    appLogs.push({
      id: record.id,
      path: appLogPath,
      line_count: Array.isArray(redacted.value.lines)
        ? redacted.value.lines.length
        : 0,
    });
  }

  if (wantsTraceType(input.request, 'crash')) {
    if (!crashLogPath) {
      throw new Error(
        'clients.ios.automation.crash_log_path is required for crash trace',
      );
    }
    const root = await getContainer();
    const lines = tailLines(readRelativeTextFile(root, crashLogPath));
    if (lines.length > 0) {
      const redacted = redactJson({ lines });
      const record = input.store.createEvidence({
        type: 'CRASH',
        session_id: input.session.session_id,
        source: 'ios_app_read_trace',
        summary: `Crash log ${crashLogPath}`,
        payload: redacted.value as JsonObject,
      });
      evidence.push(record.id);
      crashes.push({
        id: record.id,
        path: crashLogPath,
        line_count: lines.length,
      });
    }
  }

  return {
    network_events: networkEvents,
    app_logs: appLogs,
    crashes,
    evidence,
  };
}
