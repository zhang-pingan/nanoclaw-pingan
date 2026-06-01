import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { IosEvidenceStore } from './ios-evidence-store.js';
import { redactJson } from './ios-redaction.js';
import type { JsonObject, JsonValue } from './types.js';

export interface WriteIosReportInput {
  session_id: string;
  kind: string;
  path: string;
  required_fields?: string[];
  body: JsonObject;
}

export interface WriteIosReportResult {
  [key: string]: unknown;
  status: 'success' | 'error';
  path: string;
  kind: string;
  redacted_fields: string[];
  missing_fields: string[];
  unresolved_evidence_refs: string[];
  error?: string;
}

const EVIDENCE_REF_PATTERN =
  /^(SESSION|BUILD|STATE|OBS|SCREEN|SCREENSHOT|UI|ACT|FLOW|NET|APPLOG|CRASH|CLIENT_CODE|SERVER_CODE|CASE|ASSERT|CLAIM|DEBUG)-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getPathValue(body: JsonObject, dottedPath: string): unknown {
  const parts = dottedPath.split('.').filter(Boolean);
  let current: unknown = body;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function valuePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function collectEvidenceRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    if (EVIDENCE_REF_PATTERN.test(value)) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs);
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) collectEvidenceRefs(child, refs);
  }
}

function renderReportPath(rawPath: string, service: string): string {
  const rendered = rawPath
    .replace(/\{\{service\}\}/g, service)
    .replace(/\{\{deliverable\}\}/g, 'ios-app-recon')
    .trim();
  if (!rendered || rendered.includes('\0')) {
    throw new Error('report path is required');
  }
  if (path.isAbsolute(rendered)) {
    throw new Error('report path must be relative to project root');
  }
  const normalized = path.posix.normalize(rendered.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('report path traversal blocked');
  }
  if (!normalized.endsWith('.json')) {
    throw new Error('ios_app_write_report only writes JSON files');
  }
  const servicePrefix = `projects/${service}/`;
  const projectPath = normalized.startsWith('projects/')
    ? normalized
    : path.posix.normalize(
        `${servicePrefix}iteration/ios-app-recon/${normalized}`,
      );
  if (
    projectPath === `projects/${service}` ||
    !projectPath.startsWith(servicePrefix)
  ) {
    throw new Error(
      `ios_app_write_report path must stay under ${servicePrefix}`,
    );
  }
  return projectPath;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempPath, filePath);
}

export function writeIosReport(
  store: IosEvidenceStore,
  input: WriteIosReportInput,
): WriteIosReportResult {
  try {
    const session = store.getSession(input.session_id);
    const redacted = redactJson(input.body);
    const missingFields = (input.required_fields || []).filter(
      (field) => !valuePresent(getPathValue(redacted.value, field)),
    );

    const refs = new Set<string>();
    collectEvidenceRefs(redacted.value, refs);
    const unresolved = Array.from(refs)
      .filter((ref) => !store.evidenceExists(input.session_id, ref))
      .sort();

    if (missingFields.length > 0 || unresolved.length > 0) {
      return {
        status: 'error',
        path: input.path,
        kind: input.kind,
        redacted_fields: redacted.fields,
        missing_fields: missingFields,
        unresolved_evidence_refs: unresolved,
        error: [
          missingFields.length > 0
            ? `missing required fields: ${missingFields.join(', ')}`
            : '',
          unresolved.length > 0
            ? `unresolved evidence refs: ${unresolved.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
      };
    }

    const projectPath = renderReportPath(input.path, session.service);
    const hostPath = path.resolve(path.join(PROJECT_ROOT, projectPath));
    const projectRoot = path.resolve(PROJECT_ROOT);
    if (hostPath !== projectRoot && !hostPath.startsWith(projectRoot + path.sep)) {
      throw new Error('report path escapes project root');
    }

    writeJsonAtomic(hostPath, redacted.value);
    store.createEvidence({
      type: 'ASSERT',
      session_id: input.session_id,
      source: 'ios_app_write_report',
      summary: `${input.kind} report written to ${projectPath}`,
      artifact_path: projectPath,
      payload: {
        kind: input.kind,
        path: projectPath,
        required_fields: input.required_fields || [],
      } as unknown as JsonValue,
    });

    return {
      status: 'success',
      path: projectPath,
      kind: input.kind,
      redacted_fields: redacted.fields,
      missing_fields: [],
      unresolved_evidence_refs: [],
    };
  } catch (err) {
    return {
      status: 'error',
      path: input.path,
      kind: input.kind,
      redacted_fields: [],
      missing_fields: [],
      unresolved_evidence_refs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
