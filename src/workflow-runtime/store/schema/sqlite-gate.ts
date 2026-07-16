import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

import Database from 'better-sqlite3';

import { parseContractArtifactEnvelope } from '../../contracts/artifact.js';
import { domainSeparatedSha256 } from '../../contracts/hash.js';
import { strictParseJsonBytes } from '../../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonValue,
} from '../../contracts/types.js';
import type { SchemaQueryFixture, SqliteEnvironmentEvidence } from './types.js';

interface SqliteProfile {
  journal_mode: 'wal';
  synchronous: 'full';
  foreign_keys: true;
  busy_timeout_ms: number;
  page_size: number;
  auto_vacuum: 'incremental';
  temp_store: 'memory';
  wal_autocheckpoint_pages: number;
  journal_size_limit_bytes: number;
  cache_size_kib: number;
  mmap_size_bytes: number;
  trusted_schema: false;
  recursive_triggers: false;
  read_uncommitted: false;
  locking_mode: 'normal';
  read_only_query_only: true;
  better_sqlite3_version: string;
  managed_node_distribution_hash: `sha256:${string}`;
  node_runtime_version: string;
  node_executable_hash: `sha256:${string}`;
}

const contractsRoot = path.resolve(import.meta.dirname, '../../contracts');
const require = createRequire(import.meta.url);

function readProfile(): SqliteProfile {
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(
        path.join(contractsRoot, 'sqlite/local_single_user_sqlite@1.json'),
      ),
    ),
  );
  return artifact.payload as unknown as SqliteProfile;
}

function rawSha256(filePath: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function scalarPragma(
  database: Database.Database,
  pragma: string,
): string | number {
  const row = database.pragma(pragma, { simple: true }) as unknown;
  if (typeof row !== 'string' && typeof row !== 'number') {
    throw new Error(`PRAGMA ${pragma} did not return a scalar`);
  }
  return row;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function configureConnection(
  database: Database.Database,
  profile: SqliteProfile,
  readOnly: boolean,
): void {
  if (!readOnly) {
    database.pragma('journal_mode = WAL');
  }
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${profile.busy_timeout_ms}`);
  database.pragma('temp_store = MEMORY');
  database.pragma(`wal_autocheckpoint = ${profile.wal_autocheckpoint_pages}`);
  database.pragma(`journal_size_limit = ${profile.journal_size_limit_bytes}`);
  database.pragma(`cache_size = -${profile.cache_size_kib}`);
  database.pragma(`mmap_size = ${profile.mmap_size_bytes}`);
  database.pragma('trusted_schema = OFF');
  database.pragma('recursive_triggers = OFF');
  database.pragma('read_uncommitted = OFF');
  database.pragma('locking_mode = NORMAL');
  database.pragma(`query_only = ${readOnly ? 'ON' : 'OFF'}`);
}

function verifyPragmas(
  database: Database.Database,
  profile: SqliteProfile,
  readOnly: boolean,
): void {
  assertEqual(
    String(scalarPragma(database, 'journal_mode')).toLowerCase(),
    profile.journal_mode,
    'journal_mode',
  );
  assertEqual(Number(scalarPragma(database, 'synchronous')), 2, 'synchronous');
  assertEqual(
    Number(scalarPragma(database, 'foreign_keys')),
    1,
    'foreign_keys',
  );
  assertEqual(
    Number(scalarPragma(database, 'busy_timeout')),
    profile.busy_timeout_ms,
    'busy_timeout',
  );
  assertEqual(
    Number(scalarPragma(database, 'page_size')),
    profile.page_size,
    'page_size',
  );
  assertEqual(Number(scalarPragma(database, 'auto_vacuum')), 2, 'auto_vacuum');
  assertEqual(Number(scalarPragma(database, 'temp_store')), 2, 'temp_store');
  assertEqual(
    Number(scalarPragma(database, 'wal_autocheckpoint')),
    profile.wal_autocheckpoint_pages,
    'wal_autocheckpoint',
  );
  assertEqual(
    Number(scalarPragma(database, 'journal_size_limit')),
    profile.journal_size_limit_bytes,
    'journal_size_limit',
  );
  assertEqual(
    Number(scalarPragma(database, 'cache_size')),
    -profile.cache_size_kib,
    'cache_size',
  );
  assertEqual(
    Number(scalarPragma(database, 'mmap_size')),
    profile.mmap_size_bytes,
    'mmap_size',
  );
  assertEqual(
    Number(scalarPragma(database, 'trusted_schema')),
    0,
    'trusted_schema',
  );
  assertEqual(
    Number(scalarPragma(database, 'recursive_triggers')),
    0,
    'recursive_triggers',
  );
  assertEqual(
    Number(scalarPragma(database, 'read_uncommitted')),
    0,
    'read_uncommitted',
  );
  assertEqual(
    String(scalarPragma(database, 'locking_mode')).toLowerCase(),
    profile.locking_mode,
    'locking_mode',
  );
  assertEqual(
    Number(scalarPragma(database, 'query_only')),
    readOnly ? 1 : 0,
    'query_only',
  );
}

export function createMigratedDatabase(
  databasePath: string,
  migrationSql: string,
): Database.Database {
  const profile = readProfile();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const bootstrap = new Database(databasePath);
  bootstrap.pragma(`page_size = ${profile.page_size}`);
  bootstrap.pragma('auto_vacuum = INCREMENTAL');
  assertEqual(
    Number(scalarPragma(bootstrap, 'page_size')),
    profile.page_size,
    'bootstrap page_size',
  );
  assertEqual(
    Number(scalarPragma(bootstrap, 'auto_vacuum')),
    2,
    'bootstrap auto_vacuum',
  );
  bootstrap.pragma('foreign_keys = ON');
  bootstrap.exec(migrationSql);
  bootstrap.pragma('journal_mode = WAL');
  bootstrap.close();

  const reopened = new Database(databasePath);
  configureConnection(reopened, profile, false);
  verifyPragmas(reopened, profile, false);
  const integrity = reopened.pragma('integrity_check', {
    simple: true,
  }) as string;
  assertEqual(integrity, 'ok', 'integrity_check');
  const foreignKeyFailures = reopened.pragma('foreign_key_check') as unknown[];
  if (foreignKeyFailures.length !== 0) {
    throw new Error('foreign_key_check returned violations');
  }
  return reopened;
}

export function verifyReadOnlyConnection(databasePath: string): void {
  const profile = readProfile();
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    configureConnection(database, profile, true);
    verifyPragmas(database, profile, true);
  } finally {
    database.close();
  }
}

export function collectSqliteEnvironmentEvidence(
  database: Database.Database,
): SqliteEnvironmentEvidence {
  const profile = readProfile();
  assertEqual(
    process.version,
    `v${profile.node_runtime_version}`,
    'Node version',
  );
  const executablePath = fs.realpathSync(process.execPath);
  assertEqual(
    rawSha256(executablePath),
    profile.node_executable_hash,
    'managed Node executable hash',
  );
  if (!executablePath.includes('/Icarus/toolchains/node/')) {
    throw new Error(
      `Node is not from the managed Icarus installation: ${executablePath}`,
    );
  }
  const packageJsonPath = require.resolve('better-sqlite3/package.json');
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    version: string;
  };
  assertEqual(
    packageJson.version,
    profile.better_sqlite3_version,
    'better-sqlite3 version',
  );
  const nativeModulePath = path.join(
    packageRoot,
    'build/Release/better_sqlite3.node',
  );
  if (!fs.existsSync(nativeModulePath)) {
    throw new Error(
      `better-sqlite3 native module is absent: ${nativeModulePath}`,
    );
  }
  const identity = database
    .prepare(
      'SELECT sqlite_version() AS sqlite_version, sqlite_source_id() AS sqlite_source_id',
    )
    .get() as { sqlite_version: string; sqlite_source_id: string };
  const compileOptions = (
    database.pragma('compile_options') as Array<{
      compile_options: string;
    }>
  )
    .map((row) => row.compile_options)
    .sort();
  return {
    managed_node_version: process.version,
    managed_node_exec_path: executablePath,
    managed_distribution_hash: profile.managed_node_distribution_hash,
    better_sqlite3_version: packageJson.version,
    native_module_path: nativeModulePath,
    native_module_sha256: rawSha256(nativeModulePath),
    sqlite_version: identity.sqlite_version,
    sqlite_source_id: identity.sqlite_source_id,
    compile_options: compileOptions,
    compile_options_hash: domainSeparatedSha256(
      'icarus:sqlite-compile-options:1\n',
      compileOptions as JsonValue,
    ),
  };
}

export function verifyQueryPlans(
  database: Database.Database,
  fixtures: SchemaQueryFixture[],
): Array<{ query_id: string; plan: string[] }> {
  return fixtures.map((fixture) => {
    const parameters = Array.from({ length: fixture.parameter_count }, () => 0);
    const rows = database
      .prepare(`EXPLAIN QUERY PLAN ${fixture.sql}`)
      .all(...parameters) as Array<{ detail: string }>;
    const plan = rows.map((row) => row.detail);
    if (!plan.some((detail) => detail.includes(fixture.required_index_id))) {
      throw new Error(
        `${fixture.query_id} did not use ${fixture.required_index_id}: ${plan.join(' | ')}`,
      );
    }
    return { query_id: fixture.query_id, plan };
  });
}

export function readSqliteProfileArtifact(): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(
        path.join(contractsRoot, 'sqlite/local_single_user_sqlite@1.json'),
      ),
    ),
  );
}
