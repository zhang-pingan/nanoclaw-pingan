import { describe, it, expect, beforeEach } from 'vitest';

import Database from 'better-sqlite3';

import {
  BUILT_IN_CHANNELS,
  parseArgs,
  validateRegistrationChannel,
} from './register.js';

/**
 * Tests for the register step.
 *
 * Verifies: parameterized SQL (no injection), file templating,
 * apostrophe in names, .env updates.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS registered_agents (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    is_main INTEGER DEFAULT 0
  )`);
  return db;
}

describe('registration channel contract', () => {
  it('requires an explicit built-in channel', () => {
    expect(parseArgs(['--jid', 'web:main']).channel).toBe('');
    expect(validateRegistrationChannel('', 'web:main')).toBe('missing_channel');
    expect(validateRegistrationChannel('unsupported', 'unsupported:main')).toBe(
      'invalid_channel',
    );
    expect(BUILT_IN_CHANNELS).toEqual(['assistant', 'feishu', 'wecom', 'web']);
  });

  it('rejects a JID owned by a different built-in channel', () => {
    expect(validateRegistrationChannel('web', 'feishu:oc_main')).toBe(
      'jid_channel_mismatch',
    );
    expect(validateRegistrationChannel('web', 'web:main')).toBeNull();
    expect(
      validateRegistrationChannel('assistant', 'assistant:main'),
    ).toBeNull();
    expect(
      validateRegistrationChannel('wecom', 'wecom:user:zhangsan'),
    ).toBeNull();
    expect(validateRegistrationChannel('feishu', 'feishu:oc_main')).toBeNull();
  });
});

describe('parameterized SQL registration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers an Agent with parameterized query', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'web:123',
      'Test Agent',
      'test-agent',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT * FROM registered_agents WHERE jid = ?')
      .get('web:123') as {
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      requires_trigger: number;
    };

    expect(row.jid).toBe('web:123');
    expect(row.name).toBe('Test Agent');
    expect(row.folder).toBe('test-agent');
    expect(row.trigger_pattern).toBe('@Andy');
    expect(row.requires_trigger).toBe(1);
  });

  it('handles apostrophes in Agent names safely', () => {
    const name = "O'Brien's Agent";

    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'web:456',
      name,
      'obriens-agent',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT name FROM registered_agents WHERE jid = ?')
      .get('web:456') as {
      name: string;
    };

    expect(row.name).toBe(name);
  });

  it('prevents SQL injection in JID field', () => {
    const maliciousJid = "'; DROP TABLE registered_agents; --";

    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(maliciousJid, 'Evil', 'evil', '@Andy', '2024-01-01T00:00:00.000Z', 1);

    // Table should still exist and have the row
    const count = db
      .prepare('SELECT COUNT(*) as count FROM registered_agents')
      .get() as {
      count: number;
    };
    expect(count.count).toBe(1);

    const row = db.prepare('SELECT jid FROM registered_agents').get() as {
      jid: string;
    };
    expect(row.jid).toBe(maliciousJid);
  });

  it('handles requiresTrigger=false', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'user:789',
      'Personal',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT requires_trigger FROM registered_agents WHERE jid = ?')
      .get('user:789') as { requires_trigger: number };

    expect(row.requires_trigger).toBe(0);
  });

  it('stores is_main flag', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      'user:789',
      'Personal',
      'web_main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_agents WHERE jid = ?')
      .get('user:789') as { is_main: number };

    expect(row.is_main).toBe(1);
  });

  it('defaults is_main to 0', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'web:123',
      'Some Agent',
      'web_some-agent',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_agents WHERE jid = ?')
      .get('web:123') as { is_main: number };

    expect(row.is_main).toBe(0);
  });

  it('upserts on conflict', () => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO registered_agents
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    );

    stmt.run(
      'web:123',
      'Original',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );
    stmt.run(
      'web:123',
      'Updated',
      'main',
      '@Bot',
      '2024-02-01T00:00:00.000Z',
      0,
    );

    const rows = db.prepare('SELECT * FROM registered_agents').all();
    expect(rows).toHaveLength(1);

    const row = rows[0] as {
      name: string;
      trigger_pattern: string;
      requires_trigger: number;
    };
    expect(row.name).toBe('Updated');
    expect(row.trigger_pattern).toBe('@Bot');
    expect(row.requires_trigger).toBe(0);
  });
});

describe('file templating', () => {
  it('replaces assistant name in CLAUDE.md content', () => {
    let content = '# Andy\n\nYou are Andy, a personal assistant.';

    content = content.replace(/^# Andy$/m, '# Nova');
    content = content.replace(/You are Andy/g, 'You are Nova');

    expect(content).toBe('# Nova\n\nYou are Nova, a personal assistant.');
  });

  it('handles names with special regex characters', () => {
    let content = '# Andy\n\nYou are Andy.';

    const newName = 'C.L.A.U.D.E';
    content = content.replace(/^# Andy$/m, `# ${newName}`);
    content = content.replace(/You are Andy/g, `You are ${newName}`);

    expect(content).toContain('# C.L.A.U.D.E');
    expect(content).toContain('You are C.L.A.U.D.E.');
  });

  it('updates .env ASSISTANT_NAME line', () => {
    let envContent = 'SOME_KEY=value\nASSISTANT_NAME="Andy"\nOTHER=test';

    envContent = envContent.replace(
      /^ASSISTANT_NAME=.*$/m,
      'ASSISTANT_NAME="Nova"',
    );

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
    expect(envContent).toContain('SOME_KEY=value');
  });

  it('appends ASSISTANT_NAME to .env if not present', () => {
    let envContent = 'SOME_KEY=value\n';

    if (!envContent.includes('ASSISTANT_NAME=')) {
      envContent += '\nASSISTANT_NAME="Nova"';
    }

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
  });
});
