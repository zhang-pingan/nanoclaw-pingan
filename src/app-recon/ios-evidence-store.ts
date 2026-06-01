import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { redactJson, redactText } from './ios-redaction.js';
import type {
  IosClaimRecord,
  IosClaimType,
  IosConfidence,
  IosEvidenceRecord,
  IosEvidenceType,
  IosSessionRecord,
  JsonObject,
  JsonValue,
} from './types.js';

export const IOS_RECON_DATA_DIR = path.join(DATA_DIR, 'ios-app-recon');

const EVIDENCE_PREFIX_BY_TYPE: Record<IosEvidenceType, string> = {
  SESSION: 'SESSION',
  BUILD: 'BUILD',
  STATE: 'STATE',
  OBS: 'OBS',
  SCREEN: 'SCREEN',
  SCREENSHOT: 'SCREENSHOT',
  UI_TREE: 'UI',
  ACT: 'ACT',
  FLOW: 'FLOW',
  NET: 'NET',
  APP_LOG: 'APPLOG',
  CRASH: 'CRASH',
  CLIENT_CODE: 'CLIENT_CODE',
  SERVER_CODE: 'SERVER_CODE',
  CASE: 'CASE',
  ASSERT: 'ASSERT',
  CLAIM: 'CLAIM',
  DEBUG: 'DEBUG',
};

export interface EvidenceStoreOptions {
  rootDir?: string;
}

export interface CreateEvidenceInput {
  type: IosEvidenceType;
  session_id: string;
  source: string;
  summary: string;
  payload?: JsonValue;
  artifact_path?: string;
  id?: string;
  redact?: boolean;
}

export interface CreateClaimInput {
  session_id: string;
  type?: IosClaimType;
  statement: string;
  supported_by: string[];
  confidence?: IosConfidence;
  limitations?: string[];
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

export class IosEvidenceStore {
  readonly rootDir: string;

  constructor(options: EvidenceStoreOptions = {}) {
    this.rootDir = options.rootDir || IOS_RECON_DATA_DIR;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, 'sessions', sanitizeSegment(sessionId));
  }

  artifactsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'artifacts');
  }

  deliverablesDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'deliverables');
  }

  private countersPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'counters.json');
  }

  private evidenceIndexPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'evidence-index.json');
  }

  private claimsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'claims.json');
  }

  private sessionsIndexPath(): string {
    return path.join(this.rootDir, 'sessions-index.json');
  }

  private globalCountersPath(): string {
    return path.join(this.rootDir, 'counters.json');
  }

  nextGlobalId(type: IosEvidenceType): string {
    const counters = readJsonFile<Record<string, number>>(
      this.globalCountersPath(),
      {},
    );
    const prefix = EVIDENCE_PREFIX_BY_TYPE[type];
    const next = (counters[prefix] || 0) + 1;
    counters[prefix] = next;
    writeJsonAtomic(this.globalCountersPath(), counters);
    return `${prefix}-${String(next).padStart(3, '0')}`;
  }

  nextId(sessionId: string, type: IosEvidenceType): string {
    const counters = readJsonFile<Record<string, number>>(
      this.countersPath(sessionId),
      {},
    );
    const prefix = EVIDENCE_PREFIX_BY_TYPE[type];
    const next = (counters[prefix] || 0) + 1;
    counters[prefix] = next;
    writeJsonAtomic(this.countersPath(sessionId), counters);
    return `${prefix}-${String(next).padStart(3, '0')}`;
  }

  createSessionRecord(
    record: Omit<IosSessionRecord, 'artifact_dir'> & { artifact_dir?: string },
  ): IosSessionRecord {
    const session: IosSessionRecord = {
      ...record,
      artifact_dir: record.artifact_dir || this.artifactsDir(record.session_id),
    };
    ensureDir(this.artifactsDir(session.session_id));
    ensureDir(this.deliverablesDir(session.session_id));
    writeJsonAtomic(path.join(this.sessionDir(session.session_id), 'session.json'), session);

    const sessions = readJsonFile<Record<string, string>>(
      this.sessionsIndexPath(),
      {},
    );
    sessions[session.session_id] = path.relative(this.rootDir, this.sessionDir(session.session_id));
    writeJsonAtomic(this.sessionsIndexPath(), sessions);
    return session;
  }

  getSession(sessionId: string): IosSessionRecord {
    const sessionPath = path.join(this.sessionDir(sessionId), 'session.json');
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Unknown iOS app recon session: ${sessionId}`);
    }
    return JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as IosSessionRecord;
  }

  updateSession(session: IosSessionRecord): void {
    const updated = {
      ...session,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(this.sessionDir(session.session_id), 'session.json'), updated);
  }

  listEvidence(sessionId: string): IosEvidenceRecord[] {
    return readJsonFile<IosEvidenceRecord[]>(
      this.evidenceIndexPath(sessionId),
      [],
    );
  }

  getEvidence(sessionId: string, id: string): IosEvidenceRecord | null {
    return this.listEvidence(sessionId).find((item) => item.id === id) || null;
  }

  evidenceExists(sessionId: string, id: string): boolean {
    return this.getEvidence(sessionId, id) !== null;
  }

  assertEvidenceRefs(sessionId: string, refs: string[]): void {
    const existing = new Set(this.listEvidence(sessionId).map((item) => item.id));
    const missing = refs.filter((ref) => !existing.has(ref));
    if (missing.length > 0) {
      throw new Error(`Unresolved evidence refs: ${missing.join(', ')}`);
    }
  }

  createEvidence(input: CreateEvidenceInput): IosEvidenceRecord {
    const redactedPayload =
      input.payload !== undefined && input.redact !== false
        ? redactJson(input.payload)
        : { value: input.payload, fields: [] };
    const redactedSummary =
      input.redact !== false
        ? redactText(input.summary, 'summary')
        : { value: input.summary, fields: [] };
    const record: IosEvidenceRecord = {
      id: input.id || this.nextId(input.session_id, input.type),
      type: input.type,
      created_at: new Date().toISOString(),
      session_id: input.session_id,
      source: input.source,
      summary: redactedSummary.value,
      artifact_path: input.artifact_path,
      payload: redactedPayload.value as JsonValue | undefined,
      redaction: {
        applied:
          redactedPayload.fields.length > 0 ||
          redactedSummary.fields.length > 0,
        fields: [...redactedPayload.fields, ...redactedSummary.fields].sort(),
      },
    };

    const evidence = this.listEvidence(input.session_id);
    if (evidence.some((item) => item.id === record.id)) {
      throw new Error(`Evidence id already exists: ${record.id}`);
    }
    evidence.push(record);
    writeJsonAtomic(this.evidenceIndexPath(input.session_id), evidence);
    writeJsonAtomic(
      path.join(this.sessionDir(input.session_id), 'evidence', `${record.id}.json`),
      record,
    );
    return record;
  }

  listClaims(sessionId: string): IosClaimRecord[] {
    return readJsonFile<IosClaimRecord[]>(this.claimsPath(sessionId), []);
  }

  createClaim(input: CreateClaimInput): IosClaimRecord {
    const statement = input.statement.trim();
    if (!statement) throw new Error('claim statement is required');
    if (!Array.isArray(input.supported_by) || input.supported_by.length === 0) {
      throw new Error('claim supported_by must contain at least one evidence id');
    }
    this.assertEvidenceRefs(input.session_id, input.supported_by);

    const rawClaim: IosClaimRecord = {
      id: this.nextId(input.session_id, 'CLAIM'),
      type: input.type || 'current_behavior',
      statement,
      supported_by: input.supported_by,
      confidence: input.confidence || 'medium',
      limitations: input.limitations || [],
      created_at: new Date().toISOString(),
      session_id: input.session_id,
    };
    const claim = redactJson(rawClaim as unknown as JsonObject)
      .value as unknown as IosClaimRecord;

    const claims = this.listClaims(input.session_id);
    claims.push(claim);
    writeJsonAtomic(this.claimsPath(input.session_id), claims);
    this.createEvidence({
      id: claim.id,
      type: 'CLAIM',
      session_id: input.session_id,
      source: 'ios_app_write_claims',
      summary: statement,
      payload: claim as unknown as JsonObject,
    });
    return claim;
  }

  writeArtifact(
    sessionId: string,
    relativePath: string,
    body: string | Buffer,
  ): string {
    const artifactRoot = path.resolve(this.artifactsDir(sessionId));
    const resolved = path.resolve(path.join(artifactRoot, relativePath));
    if (resolved !== artifactRoot && !resolved.startsWith(artifactRoot + path.sep)) {
      throw new Error('artifact path escapes session artifact directory');
    }
    ensureDir(path.dirname(resolved));
    fs.writeFileSync(resolved, body);
    return path.relative(this.sessionDir(sessionId), resolved);
  }
}

export function createIosEvidenceStore(
  options: EvidenceStoreOptions = {},
): IosEvidenceStore {
  return new IosEvidenceStore(options);
}
