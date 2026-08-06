import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
} from '../workflow-runtime/gateway/host-core.js';
import { selectHostCoreSnapshot, verifyActiveHostCore } from './activation.js';
import { parseHostCoreReleaseArguments } from './host-core-release-cli.js';
import {
  WORKFLOW_STATE_DATABASE_RELATIVE,
  currentWorkflowRuntimeSchemaCompatibility,
  decidePersistentStateCompatibility,
} from './persistent-state.js';
import {
  HOST_CORE_SNAPSHOT_DIRECTORY,
  HOST_CORE_SNAPSHOT_FILENAME,
  installHostCoreSnapshotFromDist,
  listHostCoreSnapshots,
  removeHostCoreSnapshot,
  verifyHostCoreSnapshot,
} from './release.js';
import {
  HOST_CORE_STARTUP_SMOKE_ENV,
  HOST_CORE_STARTUP_SMOKE_MARKER,
} from './startup-smoke.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryRoots.push(root);
  return root;
}

function runtimeHome(): string {
  const root = temporaryRoot('icarus-host-core-runtime');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeDist(): string {
  const dist = path.join(temporaryRoot('icarus-host-core-dist'), 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'index.js'),
    `if (process.env[${JSON.stringify(HOST_CORE_STARTUP_SMOKE_ENV)}] === '1') console.log(${JSON.stringify(HOST_CORE_STARTUP_SMOKE_MARKER)});\n`,
  );
  return dist;
}

function installCustomEntry(home: string, source: string) {
  const dist = makeDist();
  fs.writeFileSync(path.join(dist, 'index.js'), source);
  return installHostCoreSnapshotFromDist({
    projectRoot,
    runtimeHome: home,
    distRoot: dist,
    label: 'custom',
    validation: 'smoke_passed',
    commit: '1'.repeat(40),
    dirty: true,
    includeDependencies: false,
    includeRuntimeAssets: false,
  });
}

function installSnapshot(home: string, label: string) {
  return installHostCoreSnapshotFromDist({
    projectRoot,
    runtimeHome: home,
    distRoot: makeDist(),
    label,
    validation: 'smoke_passed',
    commit: '1'.repeat(40),
    dirty: true,
    includeDependencies: false,
    includeRuntimeAssets: false,
  });
}

function manifestPath(home: string, snapshotId: string): string {
  return path.join(
    home,
    HOST_CORE_SNAPSHOT_DIRECTORY,
    snapshotId,
    HOST_CORE_SNAPSHOT_FILENAME,
  );
}

function rewriteManifest(
  home: string,
  snapshotId: string,
  update: (manifest: Record<string, any>) => void,
): void {
  const file = manifestPath(home, snapshotId);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    any
  >;
  update(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function findNativeAddon(root: string): string {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findNativeAddon(candidate);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      return candidate;
    }
  }
  return '';
}

function createSchemaDatabase(home: string, version: number): string {
  const file = path.join(home, WORKFLOW_STATE_DATABASE_RELATIVE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  try {
    database.exec(
      fs.readFileSync(
        path.join(
          projectRoot,
          'src/workflow-runtime/store/schema/migration',
          `workflow-runtime-schema-v${String(version)}.sql`,
        ),
        'utf8',
      ),
    );
  } finally {
    database.close();
  }
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Host Core snapshot CLI', () => {
  it('parses the five snapshot commands and one-cycle aliases', () => {
    expect(
      parseHostCoreReleaseArguments([
        'snapshot',
        'create',
        '--runtime-home',
        '/tmp/runtime',
        '--label',
        'known-good',
        '--full-check',
      ]),
    ).toMatchObject({
      command: 'snapshot',
      snapshotCommand: 'create',
      label: 'known-good',
      fullCheck: true,
    });
    expect(
      parseHostCoreReleaseArguments([
        'snapshot',
        'list',
        '--runtime-home',
        '/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'snapshot', snapshotCommand: 'list' });
    expect(
      parseHostCoreReleaseArguments([
        'publish',
        '--version',
        '1.2.3',
        '--runtime-home',
        '/tmp/runtime',
      ]),
    ).toMatchObject({ command: 'publish', version: '1.2.3' });
  });
});

describe('Host Core local snapshots', () => {
  it('executes the complete entry module graph during startup smoke', () => {
    const missingImportHome = runtimeHome();
    expect(() =>
      installCustomEntry(
        missingImportHome,
        `import './missing-module.js';\nconsole.log(${JSON.stringify(HOST_CORE_STARTUP_SMOKE_MARKER)});\n`,
      ),
    ).toThrow('host_core_snapshot_entry_smoke_failed');

    const topLevelFailureHome = runtimeHome();
    expect(() =>
      installCustomEntry(
        topLevelFailureHome,
        `throw new Error('top-level initialization failed');\n`,
      ),
    ).toThrow('host_core_snapshot_entry_smoke_failed');
  });

  it('requires the exact startup smoke ready marker', () => {
    const missingMarkerHome = runtimeHome();
    expect(() => installCustomEntry(missingMarkerHome, 'void 0;\n')).toThrow(
      'host_core_snapshot_entry_smoke_marker_invalid',
    );

    const incorrectMarkerHome = runtimeHome();
    expect(() =>
      installCustomEntry(
        incorrectMarkerHome,
        `console.log('icarus_host_core_startup_smoke=not-ready');\n`,
      ),
    ).toThrow('host_core_snapshot_entry_smoke_marker_invalid');
  });

  it('creates, lists, verifies, and removes a snapshot without identity inventory', () => {
    const home = runtimeHome();
    const snapshot = installSnapshot(home, 'known-good');
    const raw = fs.readFileSync(
      manifestPath(home, snapshot.snapshot_id),
      'utf8',
    );

    expect(snapshot.git.dirty).toBe(true);
    expect(snapshot.workflow_schema).toEqual({
      current_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
      minimum_supported_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    });
    expect(snapshot.node).toMatchObject({
      major: Number(process.versions.node.split('.')[0]),
      modules_abi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    });
    expect(raw).not.toMatch(
      /inventory|release_artifact|compiler|logical_schema|physical|sqlite_schema_hash|distribution_hash/,
    );
    expect(listHostCoreSnapshots(home)).toEqual([snapshot]);
    expect(verifyHostCoreSnapshot(home, snapshot.snapshot_id)).toEqual(
      snapshot,
    );

    removeHostCoreSnapshot(home, snapshot.snapshot_id);
    expect(listHostCoreSnapshots(home)).toEqual([]);
  });

  it('rejects a broken entry before selection', () => {
    const home = runtimeHome();
    const snapshot = installSnapshot(home, 'broken');
    fs.appendFileSync(
      path.join(
        home,
        HOST_CORE_SNAPSHOT_DIRECTORY,
        snapshot.snapshot_id,
        'dist/index.js',
      ),
      'tampered\n',
    );

    expect(() => verifyHostCoreSnapshot(home, snapshot.snapshot_id)).toThrow(
      'entry_checksum_mismatch',
    );
    expect(() =>
      selectHostCoreSnapshot({
        runtimeHome: home,
        snapshotId: snapshot.snapshot_id,
      }),
    ).toThrow('entry_checksum_mismatch');
    expect(fs.existsSync(path.join(home, 'active-core'))).toBe(false);
  });

  it('rejects a snapshot with a corrupt native addon', () => {
    const home = runtimeHome();
    const snapshot = installSnapshot(home, 'corrupt-native');
    const root = path.join(
      home,
      HOST_CORE_SNAPSHOT_DIRECTORY,
      snapshot.snapshot_id,
    );
    const addon = findNativeAddon(root);
    expect(addon).not.toBe('');
    fs.writeFileSync(addon, 'not-a-native-addon');
    expect(() => verifyHostCoreSnapshot(home, snapshot.snapshot_id)).toThrow(
      'host_core_native_module_incompatible',
    );
  });

  it('rejects incompatible schema and Node ABI descriptors', () => {
    const home = runtimeHome();
    const schemaMismatch = installSnapshot(home, 'schema-mismatch');
    rewriteManifest(home, schemaMismatch.snapshot_id, (manifest) => {
      manifest.workflow_schema.current_version += 1;
    });
    expect(() =>
      verifyHostCoreSnapshot(home, schemaMismatch.snapshot_id),
    ).toThrow('schema_incompatible');

    const abiMismatch = installSnapshot(home, 'abi-mismatch');
    rewriteManifest(home, abiMismatch.snapshot_id, (manifest) => {
      manifest.node.modules_abi = '9999';
    });
    expect(() => verifyHostCoreSnapshot(home, abiMismatch.snapshot_id)).toThrow(
      'node_incompatible',
    );
    expect(fs.existsSync(path.join(home, 'active-core'))).toBe(false);
  });

  it('selects atomically, protects active snapshots, and restores the previous pointer on post-switch failure', () => {
    const home = runtimeHome();
    const first = installSnapshot(home, 'first');
    const second = installSnapshot(home, 'second');
    selectHostCoreSnapshot({
      runtimeHome: home,
      snapshotId: first.snapshot_id,
    });
    const previousPointer = fs.readlinkSync(path.join(home, 'active-core'));

    expect(() =>
      selectHostCoreSnapshot({
        runtimeHome: home,
        snapshotId: second.snapshot_id,
        afterSwitch: () => {
          fs.appendFileSync(
            path.join(
              home,
              HOST_CORE_SNAPSHOT_DIRECTORY,
              second.snapshot_id,
              'dist/index.js',
            ),
            'tampered-after-switch\n',
          );
        },
      }),
    ).toThrow('entry_checksum_mismatch');
    expect(fs.readlinkSync(path.join(home, 'active-core'))).toBe(
      previousPointer,
    );
    expect(verifyActiveHostCore(home).snapshot_id).toBe(first.snapshot_id);
    expect(() => removeHostCoreSnapshot(home, first.snapshot_id)).toThrow(
      'snapshot_active',
    );
  });
});

describe('Host Core Workflow schema compatibility', () => {
  const target = {
    database_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    minimum_supported_schema_version: MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION,
  };

  it('recognizes no state and a supported older schema by integer version', () => {
    const empty = runtimeHome();
    expect(decidePersistentStateCompatibility(empty, target).decision).toBe(
      'NO_STATE',
    );

    const old = runtimeHome();
    createSchemaDatabase(old, 10);
    expect(decidePersistentStateCompatibility(old, target)).toMatchObject({
      decision: 'MIGRATION_SUPPORTED',
      observed_schema: { database_schema_version: 10 },
      reason: 'supported_schema_version_migration',
    });
  });

  it('requires focused structure smoke for a current database', () => {
    const home = runtimeHome();
    const file = createSchemaDatabase(
      home,
      CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    );
    expect(decidePersistentStateCompatibility(home, target).decision).toBe(
      'SAME_SCHEMA',
    );
    const database = new Database(file);
    try {
      database.exec('DROP INDEX "idx:capacity_head:singleton"');
    } finally {
      database.close();
    }
    expect(decidePersistentStateCompatibility(home, target)).toMatchObject({
      decision: 'UNKNOWN_BLOCKED',
      reason: 'database_required_structure_missing',
    });
  });

  it('rejects a newer or unknown schema version', () => {
    for (const [version, reason] of [
      [
        CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION + 1,
        'database_schema_newer_than_target',
      ],
      [1, 'database_schema_older_than_supported_range'],
    ] as const) {
      const home = runtimeHome();
      const file = createSchemaDatabase(home, 10);
      const database = new Database(file);
      try {
        database.pragma(`user_version = ${String(version)}`);
      } finally {
        database.close();
      }
      expect(decidePersistentStateCompatibility(home, target)).toMatchObject({
        decision:
          version > CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION
            ? 'UNKNOWN_BLOCKED'
            : 'RESET_REQUIRED',
        reason,
      });
    }
  });
});
