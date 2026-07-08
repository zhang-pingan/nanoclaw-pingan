import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function runWorkflowGroupsInTemp(
  args: string[],
  opts: { reuseCwd?: boolean } = {},
): Promise<string> {
  if (!opts.reuseCwd) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-wfgroups-'));
    tempDirs.push(tmp);
    process.chdir(tmp);
  }
  vi.resetModules();
  const mod = await import('./workflow-groups.js');

  let output = '';
  const spy = vi.spyOn(console, 'log').mockImplementation((chunk) => {
    output += `${String(chunk)}\n`;
  });
  try {
    await mod.run(args);
  } finally {
    spy.mockRestore();
  }
  return output;
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workflow-groups setup step', () => {
  it('registers web workflow groups and creates group CLAUDE.md files', async () => {
    const output = await runWorkflowGroupsInTemp(['--channel', 'web']);

    expect(output).toContain('STATUS: success');
    expect(output).toContain('REGISTERED: 6');

    const db = new Database(path.join(process.cwd(), 'store', 'messages.db'), {
      readonly: true,
    });
    const rows = db
      .prepare(
        'SELECT jid, name, folder, requires_trigger, is_main FROM registered_groups ORDER BY folder',
      )
      .all() as Array<{
      jid: string;
      name: string;
      folder: string;
      requires_trigger: number;
      is_main: number;
    }>;
    db.close();

    expect(rows.map((row) => row.folder)).toEqual([
      'web_dev',
      'web_dev_examine',
      'web_ops',
      'web_plan',
      'web_plan_examine',
      'web_test',
    ]);
    expect(rows.find((row) => row.folder === 'web_dev')?.jid).toBe('web:dev');
    expect(rows.every((row) => row.requires_trigger === 1)).toBe(true);
    expect(rows.every((row) => row.is_main === 0)).toBe(true);
    expect(
      fs.readFileSync(
        path.join(process.cwd(), 'groups', 'web_dev', 'CLAUDE.md'),
        'utf-8',
      ),
    ).toContain('项目开发工程师');
  });

  it('preserves existing DB rows unless overwrite-db is requested', async () => {
    await runWorkflowGroupsInTemp(['--channel', 'web']);

    const dbPath = path.join(process.cwd(), 'store', 'messages.db');
    const db = new Database(dbPath);
    db.prepare(
      `UPDATE registered_groups
       SET name = ?, description = ?
       WHERE jid = ?`,
    ).run('Custom Dev', 'Custom description', 'web:dev');
    db.close();

    await runWorkflowGroupsInTemp(['--channel', 'web'], { reuseCwd: true });

    const preservedDb = new Database(dbPath, { readonly: true });
    const preserved = preservedDb
      .prepare('SELECT name, description FROM registered_groups WHERE jid = ?')
      .get('web:dev') as { name: string; description: string };
    preservedDb.close();
    expect(preserved).toEqual({
      name: 'Custom Dev',
      description: 'Custom description',
    });

    await runWorkflowGroupsInTemp(['--channel', 'web', '--overwrite-db'], {
      reuseCwd: true,
    });

    const overwrittenDb = new Database(dbPath, { readonly: true });
    const overwritten = overwrittenDb
      .prepare('SELECT name, description FROM registered_groups WHERE jid = ?')
      .get('web:dev') as { name: string; description: string };
    overwrittenDb.close();
    expect(overwritten.name).toBe('程序员');
    expect(overwritten.description).toContain('项目开发');
  });

  it('skips feishu workflow groups without a chat-id mapping', async () => {
    const output = await runWorkflowGroupsInTemp(['--channel', 'feishu']);

    expect(output).toContain('REGISTERED: 0');
    expect(output).toContain('SKIPPED: 6');
  });

  it('registers feishu workflow groups from a chat-id mapping', async () => {
    const output = await runWorkflowGroupsInTemp([
      '--channel',
      'feishu',
      '--feishu-map',
      '{"dev":"oc_dev","ops":"feishu:oc_ops"}',
    ]);

    expect(output).toContain('REGISTERED: 2');
    expect(output).toContain('SKIPPED: 4');

    const db = new Database(path.join(process.cwd(), 'store', 'messages.db'), {
      readonly: true,
    });
    const rows = db
      .prepare('SELECT jid, folder FROM registered_groups ORDER BY folder')
      .all() as Array<{ jid: string; folder: string }>;
    db.close();

    expect(rows).toEqual([
      { jid: 'feishu:oc_dev', folder: 'feishu_dev' },
      { jid: 'feishu:oc_ops', folder: 'feishu_ops' },
    ]);
  });
});
