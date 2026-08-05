import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
} from '../workflow-runtime/gateway/host-core.js';
import {
  WORKFLOW_STATE_BACKUP_DIRECTORY,
  WORKFLOW_STATE_BACKUP_MANIFEST,
  WORKFLOW_STATE_DATABASE_RELATIVE,
  WORKFLOW_STATE_INCOMPLETE_MARKER,
  WORKFLOW_STATE_RELATIVE_PATHS,
  buildPersistentStateBackupManifest,
  createPersistentStateBackup,
  decidePersistentStateCompatibility,
  discardIncompletePersistentStateBackup,
  gcPersistentStateBackups,
  listPersistentStateBackups,
  parsePersistentStateBackupManifest,
  readPersistentStateBackup,
  restorePersistentStateBackup,
  resumePersistentStateBackup,
} from './persistent-state.js';
import { parseWorkflowStateArguments } from './workflow-state-cli.js';
import {
  prepareWorkflowStateReset,
  resetWorkflowState,
} from './workflow-state.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const target = {
  database_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  minimum_supported_schema_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
};
const temporaryRoots: string[] = [];

function runtimeHome(label = 'icarus-workflow-state'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

function createState(
  home: string,
  version = CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  companions = false,
): string {
  const file = path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  try {
    database.exec(
      fs.readFileSync(
        path.join(
          projectRoot,
          `src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v${String(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION)}.sql`,
        ),
        'utf8',
      ),
    );
    database.pragma(`user_version = ${String(version)}`);
  } finally {
    database.close();
  }
  if (companions) {
    fs.writeFileSync(`${file}-wal`, 'wal-copy-fixture');
    fs.writeFileSync(`${file}-shm`, 'shm-copy-fixture');
  }
  return file;
}

function decision(home: string) {
  return decidePersistentStateCompatibility(home, target);
}

function backupPath(home: string, backupId: string): string {
  return path.join(home, WORKFLOW_STATE_BACKUP_DIRECTORY, backupId);
}

function checksum(file: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function removeLiveUnit(home: string): void {
  for (const relative of WORKFLOW_STATE_RELATIVE_PATHS) {
    const file = path.join(home, relative);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Workflow state backup v3', () => {
  it('creates independent timestamp backups and copies the exact DB/WAL/SHM unit', () => {
    const home = runtimeHome();
    createState(home, CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION, true);
    const state = decision(home);
    expect(state.decision).toBe('SAME_SCHEMA');

    const first = buildPersistentStateBackupManifest(state, {
      operation: 'backup',
      now: new Date('2026-08-05T12:00:00.000Z'),
      randomSuffix: '11111111',
    });
    const second = buildPersistentStateBackupManifest(state, {
      operation: 'backup',
      now: new Date('2026-08-05T12:00:00.000Z'),
      randomSuffix: '22222222',
    });
    expect(first.backup_id).not.toBe(second.backup_id);

    for (const manifest of [first, second]) {
      const completed = createPersistentStateBackup(home, manifest, {
        completedAt: () => new Date('2026-08-05T12:00:01.000Z'),
      });
      expect(completed).toMatchObject({
        status: 'complete',
        observed_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
        target_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      });
      const root = backupPath(home, manifest.backup_id);
      expect(
        fs.existsSync(path.join(root, WORKFLOW_STATE_BACKUP_MANIFEST)),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER)),
      ).toBe(false);
      expect(completed.members.map((member) => member.backup_name)).toEqual([
        'workflow-runtime.db',
        'workflow-runtime.db-wal',
        'workflow-runtime.db-shm',
      ]);
      for (const member of completed.members) {
        const copy = path.join(root, member.backup_name);
        expect(fs.statSync(copy).size).toBe(member.byte_length);
        expect(checksum(copy)).toBe(member.checksum);
      }
    }
    expect(
      fs.existsSync(path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE)),
    ).toBe(true);
  });

  it.each([
    'before_copy',
    'during_copy',
    'after_manifest_write',
    'before_live_deletion',
  ] as const)(
    'keeps live state or a restorable backup after a %s fault',
    (faultStage) => {
      const home = runtimeHome(`icarus-state-fault-${faultStage}`);
      createState(home, 1, true);
      const resetDecision = decision(home);
      expect(resetDecision.decision).toBe('RESET_REQUIRED');
      const manifest = buildPersistentStateBackupManifest(resetDecision, {
        operation: 'reset',
        now: new Date('2026-08-05T12:01:00.000Z'),
        randomSuffix: '33333333',
      });
      expect(() =>
        createPersistentStateBackup(home, manifest, {
          fault: (stage) => {
            if (stage === faultStage) throw new Error(`fault:${stage}`);
          },
        }),
      ).toThrow(`fault:${faultStage}`);
      expect(
        fs.existsSync(path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE)),
      ).toBe(true);

      const root = backupPath(home, manifest.backup_id);
      if (faultStage === 'before_live_deletion') {
        expect(
          fs.existsSync(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER)),
        ).toBe(false);
        expect(
          readPersistentStateBackup(home, manifest.backup_id),
        ).toMatchObject({ status: 'complete' });
        removeLiveUnit(home);
      } else {
        expect(
          fs.existsSync(path.join(root, WORKFLOW_STATE_INCOMPLETE_MARKER)),
        ).toBe(true);
        const resumed = resumePersistentStateBackup(home, manifest.backup_id);
        expect(resumed.status).toBe('complete');
      }

      restorePersistentStateBackup(home, manifest.backup_id);
      const restored = new Database(
        path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE),
        { readonly: true },
      );
      try {
        expect(restored.pragma('user_version', { simple: true })).toBe(1);
        expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        restored.close();
      }
    },
  );

  it('restores a current database and rejects a current-version backup missing required structure', () => {
    const home = runtimeHome();
    createState(home);
    const manifest = buildPersistentStateBackupManifest(decision(home), {
      operation: 'backup',
      now: new Date('2026-08-05T12:02:00.000Z'),
      randomSuffix: '44444444',
    });
    createPersistentStateBackup(home, manifest);
    removeLiveUnit(home);
    expect(() =>
      restorePersistentStateBackup(home, manifest.backup_id, {
        fault: (stage) => {
          if (stage === 'during_restore') throw new Error('restore-copy-fault');
        },
      }),
    ).toThrow('restore-copy-fault');
    expect(
      fs
        .readdirSync(
          path.dirname(path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE)),
        )
        .some((name) => name.includes('.restore-')),
    ).toBe(false);
    restorePersistentStateBackup(home, manifest.backup_id);
    expect(decision(home)).toMatchObject({
      decision: 'SAME_SCHEMA',
      reason: 'same_schema_version_and_required_structure',
    });

    const invalid = runtimeHome('icarus-invalid-restore');
    const invalidFile = path.join(invalid, WORKFLOW_STATE_DATABASE_RELATIVE);
    fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
    const database = new Database(invalidFile);
    database.exec(
      `PRAGMA user_version = ${String(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION)}; CREATE TABLE placeholder (id TEXT PRIMARY KEY);`,
    );
    database.close();
    const stat = fs.statSync(invalidFile);
    const invalidManifest = parsePersistentStateBackupManifest({
      format: 'icarus.workflow-runtime-state-backup/3',
      backup_id: '20260805T120300000Z-55555555',
      created_at: '2026-08-05T12:03:00.000Z',
      completed_at: null,
      operation: 'backup',
      status: 'in_progress',
      source_relative_paths: [WORKFLOW_STATE_DATABASE_RELATIVE],
      observed_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      target_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      members: [
        {
          source_relative_path: WORKFLOW_STATE_DATABASE_RELATIVE,
          backup_name: 'workflow-runtime.db',
          byte_length: stat.size,
          checksum: checksum(invalidFile),
        },
      ],
    });
    createPersistentStateBackup(invalid, invalidManifest);
    fs.unlinkSync(invalidFile);
    expect(() =>
      restorePersistentStateBackup(invalid, invalidManifest.backup_id),
    ).toThrow('missing required table');
    expect(fs.existsSync(invalidFile)).toBe(false);
  });

  it('requires explicit incomplete handling and supports discard plus explicit GC', () => {
    const home = runtimeHome();
    createState(home, 1);
    const preparation = prepareWorkflowStateReset(home, 'current', {
      now: new Date('2026-08-05T12:04:00.000Z'),
      randomSuffix: '66666666',
    });
    expect(() =>
      createPersistentStateBackup(home, preparation.manifest, {
        fault: (stage) => {
          if (stage === 'before_copy') throw new Error('stop');
        },
      }),
    ).toThrow('stop');
    expect(() => prepareWorkflowStateReset(home, 'current')).toThrow(
      `workflow_state_incomplete_backup:${preparation.manifest.backup_id}`,
    );
    discardIncompletePersistentStateBackup(
      home,
      preparation.manifest.backup_id,
    );
    expect(listPersistentStateBackups(home)).toEqual([]);

    const current = new Database(
      path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE),
    );
    current.pragma(
      `user_version = ${String(CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION)}`,
    );
    current.close();
    const currentDecision = decision(home);
    const ids = ['77777777', '88888888', '99999999'];
    for (const [index, randomSuffix] of ids.entries()) {
      createPersistentStateBackup(
        home,
        buildPersistentStateBackupManifest(currentDecision, {
          operation: 'backup',
          now: new Date(`2026-08-05T12:0${String(5 + index)}:00.000Z`),
          randomSuffix,
        }),
      );
    }
    expect(gcPersistentStateBackups(home, 2)).toHaveLength(1);
    expect(listPersistentStateBackups(home)).toHaveLength(2);
  });

  it('rejects unsafe paths, a running Host, and missing confirmation', () => {
    const home = runtimeHome();
    const outside = path.join(
      runtimeHome('icarus-state-outside'),
      'outside.db',
    );
    fs.writeFileSync(outside, 'outside');
    fs.mkdirSync(
      path.dirname(path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE)),
      { recursive: true },
    );
    fs.symlinkSync(outside, path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE));
    expect(decision(home)).toMatchObject({
      decision: 'UNKNOWN_BLOCKED',
      reason: 'persistent_state_path_invalid',
    });

    const resetHome = runtimeHome('icarus-state-confirmation');
    createState(resetHome, 1);
    const preparation = prepareWorkflowStateReset(resetHome, 'current', {
      now: new Date('2026-08-05T12:09:00.000Z'),
      randomSuffix: 'aaaaaaaa',
    });
    expect(() =>
      resetWorkflowState({
        projectRoot,
        runtimeHome: resetHome,
        mode: 'current',
        confirmed: true,
        hostIsRunning: () => true,
        expectedManifest: preparation.manifest,
      }),
    ).toThrow('workflow_state_host_running');
    expect(() =>
      resetWorkflowState({
        projectRoot,
        runtimeHome: resetHome,
        mode: 'current',
        confirmed: false,
        hostIsRunning: () => false,
        expectedManifest: preparation.manifest,
      }),
    ).toThrow('workflow_state_reset_cancelled');
    expect(
      fs.existsSync(path.join(resetHome, WORKFLOW_STATE_DATABASE_RELATIVE)),
    ).toBe(true);
    expect(listPersistentStateBackups(resetHome)).toEqual([]);
  });

  it('parses the complete maintenance command surface', () => {
    expect(
      parseWorkflowStateArguments([
        'reset',
        '--mode',
        'active',
        '--runtime-home',
        '/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'reset', mode: 'active' });
    expect(
      parseWorkflowStateArguments(['backup', '--runtime-home', '/tmp/runtime']),
    ).toMatchObject({ command: 'backup' });
    expect(
      parseWorkflowStateArguments([
        'restore',
        '--backup',
        '20260805T120000000Z-bbbbbbbb',
        '--runtime-home',
        '/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'restore' });
    expect(
      parseWorkflowStateArguments([
        'gc',
        '--keep',
        '3',
        '--runtime-home',
        '/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'gc', keep: 3 });
  });
});
