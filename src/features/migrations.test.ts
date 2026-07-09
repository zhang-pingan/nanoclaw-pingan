import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
let tempDir: string | null = null;

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('feature migrations', () => {
  it('rejects migrations that reference protected core tables', async () => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-feature-migration-'),
    );
    process.chdir(tempDir);
    const migrationDir = path.join(
      tempDir,
      'features',
      'example-feature',
      'host',
      'migrations',
    );
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationDir, '001_bad.sql'),
      "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES ('x', 'x', 'x', '@Andy', 'now');\n",
      'utf-8',
    );
    const db = await import('../db.js');
    db._initTestDatabase();
    const migrations = await import('./migrations.js');

    expect(() =>
      migrations.runFeatureMigrations({
        featureId: 'example-feature',
        dir: migrationDir,
      }),
    ).toThrow(/protected core table/);
  });
});
