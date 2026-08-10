import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION,
  CollaborationProjectSpaceStore,
} from './project-space-store.js';

const DATABASE_BASENAME = 'collaboration.db';
const DATABASE_MEMBER_SUFFIXES = ['', '-wal', '-shm'] as const;
const ARCHIVE_FORMAT = 'icarus.collaboration-schema-archive/1';

export interface CollaborationSchemaArchiveMember {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CollaborationSchemaArchiveManifest {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly created_at: string;
  readonly reason: 'schema_incompatible';
  readonly observed_schema_version: number;
  readonly target_schema_version: number;
  readonly members: readonly CollaborationSchemaArchiveMember[];
}

export type CollaborationStorePreflightResult =
  | {
      readonly decision: 'absent';
      readonly databasePath: string;
      readonly observedSchemaVersion: null;
      readonly targetSchemaVersion: number;
      readonly archiveDirectory: null;
    }
  | {
      readonly decision: 'initialize' | 'compatible';
      readonly databasePath: string;
      readonly observedSchemaVersion: number;
      readonly targetSchemaVersion: number;
      readonly archiveDirectory: null;
    }
  | {
      readonly decision: 'archived';
      readonly databasePath: string;
      readonly observedSchemaVersion: number;
      readonly targetSchemaVersion: number;
      readonly archiveDirectory: string;
    };

export interface CollaborationStorePreflightOptions {
  readonly storeDir: string;
  readonly now?: () => Date;
}

export class CollaborationStorePreflightError extends Error {
  constructor(
    readonly code:
      | 'DATABASE_INVALID'
      | 'DATABASE_UNVERSIONED'
      | 'PATH_UNSAFE'
      | 'ARCHIVE_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CollaborationStorePreflightError';
  }
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegularFile(file: string): void {
  const stat = lstatIfPresent(file);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new CollaborationStorePreflightError(
      'PATH_UNSAFE',
      `Collaboration database member is not a regular file: ${file}`,
    );
}

function assertDatabaseUnitPaths(databasePath: string): void {
  for (const suffix of DATABASE_MEMBER_SUFFIXES) {
    const member = `${databasePath}${suffix}`;
    if (lstatIfPresent(member)) assertRegularFile(member);
  }
}

function sha256(file: string): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '');
}

function uniqueArchiveDirectory(
  storeDir: string,
  observedSchemaVersion: number,
  targetSchemaVersion: number,
  now: Date,
): string {
  const archiveRoot = path.join(storeDir, 'backups');
  const archiveRootStat = lstatIfPresent(archiveRoot);
  if (archiveRootStat) {
    if (!archiveRootStat.isDirectory() || archiveRootStat.isSymbolicLink())
      throw new CollaborationStorePreflightError(
        'PATH_UNSAFE',
        `Collaboration backup root is not a regular directory: ${archiveRoot}`,
      );
  } else fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });

  const base = `collaboration-schema-${archiveTimestamp(now)}-v${String(observedSchemaVersion)}-to-v${String(targetSchemaVersion)}`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = path.join(
      archiveRoot,
      suffix === 0 ? base : `${base}-${String(suffix)}`,
    );
    if (!lstatIfPresent(candidate)) return candidate;
  }
  throw new CollaborationStorePreflightError(
    'ARCHIVE_FAILED',
    'Could not allocate a unique Collaboration schema archive directory',
  );
}

function inspectDatabase(databasePath: string): {
  readonly version: number;
  readonly hasUserTables: boolean;
} {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    const quickCheck = database.pragma('quick_check') as Array<{
      quick_check?: unknown;
    }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok')
      throw new CollaborationStorePreflightError(
        'DATABASE_INVALID',
        `Collaboration database integrity check failed: ${JSON.stringify(quickCheck)}`,
      );
    const value = database.pragma('user_version', {
      simple: true,
    }) as unknown;
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new CollaborationStorePreflightError(
        'DATABASE_INVALID',
        `Collaboration database schema version is invalid: ${String(value)}`,
      );
    const hasUserTables = Boolean(
      database
        .prepare(
          `SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
        )
        .get(),
    );
    return { version: Number(value), hasUserTables };
  } catch (error) {
    if (error instanceof CollaborationStorePreflightError) throw error;
    throw new CollaborationStorePreflightError(
      'DATABASE_INVALID',
      `Collaboration database cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

function validateCurrentDatabase(databasePath: string): void {
  try {
    const store = new CollaborationProjectSpaceStore(databasePath);
    store.close();
  } catch (error) {
    throw new CollaborationStorePreflightError(
      'DATABASE_INVALID',
      `Current Collaboration database structure is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function archiveDatabaseUnit(input: {
  readonly storeDir: string;
  readonly databasePath: string;
  readonly observedSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly now: Date;
}): string {
  const members = DATABASE_MEMBER_SUFFIXES.map(
    (suffix) => `${input.databasePath}${suffix}`,
  ).filter((file) => lstatIfPresent(file));
  for (const member of members) assertRegularFile(member);

  const archiveDirectory = uniqueArchiveDirectory(
    input.storeDir,
    input.observedSchemaVersion,
    input.targetSchemaVersion,
    input.now,
  );
  fs.mkdirSync(archiveDirectory, { mode: 0o700 });
  let removalStarted = false;
  try {
    const archivedMembers = members.map((source) => {
      const name = path.basename(source);
      const destination = path.join(archiveDirectory, name);
      const sourceSize = fs.statSync(source).size;
      const sourceSha256 = sha256(source);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      if (
        fs.statSync(destination).size !== sourceSize ||
        sha256(destination) !== sourceSha256
      )
        throw new CollaborationStorePreflightError(
          'ARCHIVE_FAILED',
          `Collaboration database archive verification failed: ${name}`,
        );
      return { name, size: sourceSize, sha256: sourceSha256 };
    });
    const manifest: CollaborationSchemaArchiveManifest = {
      format: ARCHIVE_FORMAT,
      created_at: input.now.toISOString(),
      reason: 'schema_incompatible',
      observed_schema_version: input.observedSchemaVersion,
      target_schema_version: input.targetSchemaVersion,
      members: archivedMembers,
    };
    fs.writeFileSync(
      path.join(archiveDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    removalStarted = true;
    for (const suffix of ['-shm', '-wal', ''] as const) {
      const member = `${input.databasePath}${suffix}`;
      if (lstatIfPresent(member)) fs.unlinkSync(member);
    }
    return archiveDirectory;
  } catch (error) {
    if (!removalStarted)
      fs.rmSync(archiveDirectory, { recursive: true, force: true });
    if (error instanceof CollaborationStorePreflightError) throw error;
    throw new CollaborationStorePreflightError(
      'ARCHIVE_FAILED',
      `Collaboration database could not be archived: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function preflightCollaborationStore(
  options: CollaborationStorePreflightOptions,
): CollaborationStorePreflightResult {
  const storeDir = path.resolve(options.storeDir);
  const databasePath = path.join(storeDir, DATABASE_BASENAME);
  const targetSchemaVersion =
    CURRENT_COLLABORATION_PROJECT_SPACE_SCHEMA_VERSION;
  const databaseStat = lstatIfPresent(databasePath);
  if (!databaseStat)
    return {
      decision: 'absent',
      databasePath,
      observedSchemaVersion: null,
      targetSchemaVersion,
      archiveDirectory: null,
    };
  assertDatabaseUnitPaths(databasePath);

  const inspection = inspectDatabase(databasePath);
  if (inspection.version === 0) {
    if (inspection.hasUserTables)
      throw new CollaborationStorePreflightError(
        'DATABASE_UNVERSIONED',
        'Unversioned non-empty Collaboration database requires manual recovery',
      );
    return {
      decision: 'initialize',
      databasePath,
      observedSchemaVersion: 0,
      targetSchemaVersion,
      archiveDirectory: null,
    };
  }
  if (inspection.version === targetSchemaVersion) {
    validateCurrentDatabase(databasePath);
    return {
      decision: 'compatible',
      databasePath,
      observedSchemaVersion: inspection.version,
      targetSchemaVersion,
      archiveDirectory: null,
    };
  }

  const now = options.now?.() ?? new Date();
  const archiveDirectory = archiveDatabaseUnit({
    storeDir,
    databasePath,
    observedSchemaVersion: inspection.version,
    targetSchemaVersion,
    now,
  });
  return {
    decision: 'archived',
    databasePath,
    observedSchemaVersion: inspection.version,
    targetSchemaVersion,
    archiveDirectory,
  };
}
