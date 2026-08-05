import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
}

describe('Node runtime compatibility', () => {
  it('uses supported-major configuration in the repository and CI', () => {
    const packageJson = readJson(path.join(projectRoot, 'package.json'));
    const ci = fs.readFileSync(
      path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    expect(
      fs.readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim(),
    ).toBe('26');
    expect(packageJson.engines.node).toBe('>=26 <27');
    expect(packageJson.scripts.start).toBe(
      './local/shell/start.sh --mode current',
    );
    expect(ci).toContain('node-version: 26');
    expect(ci).toContain('configure --node');
    expect(ci).toContain('run: npm ci');
    expect(ci).toContain('Verify Node ABI and SQLite binding');
    expect(ci).not.toContain('Install pinned managed runtime');
    expect(ci.indexOf('run: npm ci')).toBeLessThan(
      ci.indexOf('Verify Node ABI and SQLite binding'),
    );
    expect(Number(process.versions.node.split('.')[0])).toBe(26);
  });

  it('loads better-sqlite3 and executes an in-memory query', () => {
    expect(process.versions.modules).toMatch(/^[1-9][0-9]*$/);
    const database = new Database(':memory:');
    try {
      expect(database.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
      database.close();
    }
  });
});
