import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { IosEvidenceStore } from './ios-evidence-store.js';
import { writeIosReport } from './ios-report-writer.js';

const tempDirs: string[] = [];

function makeStore(): IosEvidenceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ios-store-'));
  tempDirs.push(dir);
  return new IosEvidenceStore({ rootDir: dir });
}

function createSession(store: IosEvidenceStore, sessionId = 'SESSION-001') {
  store.createSessionRecord({
    session_id: sessionId,
    service: 'catstory',
    purpose: 'test',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    simulator_name: 'iPhone 16',
    simulator_udid: 'SIM-001',
    bundle_id: 'com.example.catstory',
    build_id: 'BUILD-001',
    state_id: 'STATE-001',
    ios_repo_host_path: '/tmp/catstory-ios',
    backend_repo_host_path: null,
    config: {
      service: 'catstory',
      automation: {},
    },
  });
  store.createEvidence({
    id: sessionId,
    type: 'SESSION',
    session_id: sessionId,
    source: 'test',
    summary: 'session',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('IosEvidenceStore', () => {
  it('rejects claims that reference missing evidence', () => {
    const store = makeStore();
    createSession(store);

    expect(() =>
      store.createClaim({
        session_id: 'SESSION-001',
        statement: '保存会触发 PATCH /api/user/profile',
        supported_by: ['NET-404'],
        confidence: 'high',
      }),
    ).toThrow('Unresolved evidence refs: NET-404');
  });

  it('creates claim evidence when refs exist', () => {
    const store = makeStore();
    createSession(store);
    store.createEvidence({
      id: 'NET-001',
      type: 'NET',
      session_id: 'SESSION-001',
      source: 'test',
      summary: 'PATCH /api/user/profile',
    });

    const claim = store.createClaim({
      session_id: 'SESSION-001',
      statement: '保存会触发 PATCH /api/user/profile',
      supported_by: ['NET-001'],
      confidence: 'high',
    });

    expect(claim.id).toBe('CLAIM-001');
    expect(store.evidenceExists('SESSION-001', 'CLAIM-001')).toBe(true);
  });
});

describe('writeIosReport', () => {
  it('reports missing required fields and unresolved evidence refs', () => {
    const store = makeStore();
    createSession(store);

    const result = writeIosReport(store, {
      session_id: 'SESSION-001',
      kind: 'product_recon',
      path: 'projects/{{service}}/iteration/demo/product-recon.json',
      required_fields: ['version', 'platform'],
      body: {
        version: 1,
        evidence: ['NET-404'],
      },
    });

    expect(result.status).toBe('error');
    expect(result.missing_fields).toEqual(['platform']);
    expect(result.unresolved_evidence_refs).toEqual(['NET-404']);
  });

  it('redacts sensitive fields before writing report', () => {
    const store = makeStore();
    createSession(store);
    const projectTestDir = `__ios-report-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const net = store.createEvidence({
      id: 'NET-001',
      type: 'NET',
      session_id: 'SESSION-001',
      source: 'test',
      summary: 'network',
    });

    const result = writeIosReport(store, {
      session_id: 'SESSION-001',
      kind: 'product_recon',
      path: `projects/catstory/iteration/${projectTestDir}/product-recon.json`,
      required_fields: ['version', 'evidence'],
      body: {
        version: 1,
        evidence: [net.id],
        app_log: [{ token: 'secret-token', phone: '13800138000' }],
      },
    });

    expect(result.status).toBe('success');
    expect(result.redacted_fields).toContain('app_log.0.token');
    expect(result.redacted_fields).toContain('app_log.0.phone');
    const written = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'projects',
          'catstory',
          'iteration',
          projectTestDir,
          'product-recon.json',
        ),
        'utf-8',
      ),
    );
    expect(written.app_log[0].token).toBe('[redacted]');
    expect(written.app_log[0].phone).toBe('[redacted]');
    fs.rmSync(path.join(process.cwd(), 'projects', 'catstory', 'iteration', projectTestDir), {
      recursive: true,
      force: true,
    });
  });
});
