import fs from 'fs';
import path from 'path';

import { IosEvidenceStore } from './ios-evidence-store.js';
import { getAppContainerPath } from './ios-simulator.js';
import { redactJson } from './ios-redaction.js';
import type { IosSessionRecord, JsonObject } from './types.js';

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

  const evidence: string[] = [];
  const networkEvents: JsonObject[] = [];
  if (input.request.types?.includes('network') !== false && networkLogPath) {
    const appContainer = await getAppContainerPath(
      input.session.simulator_udid || 'booted',
      input.session.bundle_id,
    );
    const root = path.resolve(appContainer);
    const logPath = path.resolve(path.join(root, networkLogPath));
    if (logPath === root || !logPath.startsWith(root + path.sep)) {
      throw new Error('network_log_path escapes Simulator app container');
    }

    const events = parseJsonl(logPath).filter((event) =>
      eventMatches(event, input.request),
    );
    for (const event of events.slice(-100)) {
      const method = String(event.method || '').toUpperCase();
      const eventPath = String(event.path || event.url || '');
      const redacted = redactJson(event);
      const netEvidence = input.store.createEvidence({
        type: 'NET',
        session_id: input.session.session_id,
        source: 'ios_app_read_trace',
        summary: `${method || 'HTTP'} ${eventPath || '(unknown path)'}`,
        payload: {
          ...redacted.value,
          triggered_by: input.request.after_action || null,
        } as JsonObject,
        redact: false,
      });
      evidence.push(netEvidence.id);
      networkEvents.push({
        id: netEvidence.id,
        method,
        path: eventPath,
        status: Number(event.status || event.status_code || 0) || null,
        latency_ms: Number(event.latency_ms || event.duration_ms || 0) || null,
        triggered_by: input.request.after_action || null,
        request_summary:
          isRecord(redacted.value.request_summary)
            ? (redacted.value.request_summary as JsonObject)
            : isRecord(redacted.value.request)
              ? (redacted.value.request as JsonObject)
              : {},
        response_summary:
          isRecord(redacted.value.response_summary)
            ? (redacted.value.response_summary as JsonObject)
            : isRecord(redacted.value.response)
              ? (redacted.value.response as JsonObject)
              : {},
      });
    }
  }

  return {
    network_events: networkEvents,
    app_logs: [],
    crashes: [],
    evidence,
  };
}
