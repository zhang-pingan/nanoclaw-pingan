import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, Docker/AC detection, DB queries.
 */

describe('environment detection', () => {
  it('detects platform correctly', async () => {
    const { getPlatform } = await import('./platform.js');
    const platform = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(platform);
  });
});

describe('mount allowlist setup', () => {
  it('writes only the Icarus mount allowlist path', async () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-mounts-home-'),
    );
    tempDirs.push(homeDir);
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { run } = await import('./mounts.js');
    await run(['--empty']);

    const icarusConfig = path.join(
      homeDir,
      '.config',
      'icarus',
      'mount-allowlist.json',
    );
    expect(fs.existsSync(icarusConfig)).toBe(true);
    expect(JSON.parse(fs.readFileSync(icarusConfig, 'utf-8'))).toMatchObject({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
  });
});

describe('registered agents DB query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS registered_agents (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`);
  });

  it('returns 0 for empty table', () => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_agents')
      .get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('returns correct count after inserts', () => {
    db.prepare(
      `INSERT INTO registered_agents (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'web:123',
      'Agent 1',
      'agent-1',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    db.prepare(
      `INSERT INTO registered_agents (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'web:456',
      'Agent 2',
      'agent-2',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_agents')
      .get() as { count: number };
    expect(row.count).toBe(2);
  });
});

describe('credentials detection', () => {
  it('detects ANTHROPIC_API_KEY in env content', () => {
    const content =
      'SOME_KEY=value\nANTHROPIC_API_KEY=sk-ant-test123\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('detects CLAUDE_CODE_OAUTH_TOKEN in env content', () => {
    const content = 'CLAUDE_CODE_OAUTH_TOKEN=token123';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it('returns false when no credentials', () => {
    const content = 'ASSISTANT_NAME="Andy"\nOTHER=foo';
    const hasCredentials =
      /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(false);
  });
});

describe('Docker detection logic', () => {
  it('commandExists returns boolean', async () => {
    const { commandExists } = await import('./platform.js');
    expect(typeof commandExists('docker')).toBe('boolean');
    expect(typeof commandExists('nonexistent_binary_xyz')).toBe('boolean');
  });
});
