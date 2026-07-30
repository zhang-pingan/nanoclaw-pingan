import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { domainSeparatedSha256 } from '../contracts/hash.js';
import { loadG8FoundationArtifacts } from '../contracts/g8-foundation-contracts.js';
import type { JsonValue } from '../contracts/types.js';
import { WorkflowRuntimeConnectionFactory } from '../store/runtime-store/index.js';

export interface RunStartupSmokeOptions {
  readonly storeDir: string;
  readonly reportOutput: string;
}

function fileBytes(filePath: string): number {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o644,
  });
  fs.renameSync(temporary, filePath);
}

export function runG8StartupSmoke(options: RunStartupSmokeOptions) {
  const storeDir = fs.realpathSync(options.storeDir);
  if (
    !fs.statSync(storeDir).isDirectory() ||
    fs.readdirSync(storeDir).length > 0
  ) {
    throw new Error(
      'Startup smoke STORE_DIR must be an existing empty directory',
    );
  }
  const artifacts = loadG8FoundationArtifacts();
  const harness = artifacts.startupSmokeHarness.payload;
  if (
    harness.harness_id !== 'local_single_user_startup_smoke@1' ||
    harness.identity_mode !== 'release_validation' ||
    harness.database_schema_version !== 11 ||
    harness.database_filename !== 'workflow-runtime.db' ||
    harness.startup_smoke_max_duration_ms !== 5000
  ) {
    throw new Error('Startup-smoke harness fixed values drifted');
  }
  const databasePath = path.join(storeDir, harness.database_filename);
  const startedAt = performance.now();
  let identityEvidence;
  let schemaHash;
  let profileArtifactHash;
  let transactionAffectedRows = -1;
  let reopenedSchemaVersion = -1;
  let integrityCheckVerified = false;
  let foreignKeyCheckVerified = false;
  try {
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'create',
      identityMode: 'release_validation',
    });
    try {
      identityEvidence = store.identityEvidence;
      schemaHash = store.frozenInputs.schemaHash;
      profileArtifactHash = store.frozenInputs.profileArtifactHash;
      transactionAffectedRows = store.withImmediateTransaction(
        (transaction) =>
          transaction.execute(
            'DELETE FROM workflow_domain_resource_heads WHERE namespace = ?',
            ['__g8_startup_smoke_absent__'],
          ).changes,
      );
    } finally {
      store.close();
    }
    const reopened = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'open_existing',
      identityMode: 'release_validation',
    });
    try {
      reopenedSchemaVersion = Number(
        reopened.queryOne<{ user_version: number }>('PRAGMA user_version', [])
          ?.user_version,
      );
      integrityCheckVerified =
        reopened.queryOne<{ integrity_check: string }>(
          'PRAGMA integrity_check',
          [],
        )?.integrity_check === 'ok';
      foreignKeyCheckVerified =
        reopened.queryAll<Record<string, unknown>>(
          'PRAGMA foreign_key_check',
          [],
        ).length === 0;
    } finally {
      reopened.close();
    }
    const durationMs = performance.now() - startedAt;
    if (durationMs > harness.startup_smoke_max_duration_ms) {
      throw new Error(
        `Startup smoke exceeded ${harness.startup_smoke_max_duration_ms} ms: ${durationMs}`,
      );
    }
    if (
      transactionAffectedRows !== 0 ||
      reopenedSchemaVersion !== 11 ||
      !integrityCheckVerified ||
      !foreignKeyCheckVerified ||
      !identityEvidence ||
      !schemaHash ||
      !profileArtifactHash
    ) {
      throw new Error('Startup smoke correctness invariant failed');
    }
    const payload = {
      format: 'icarus.startup-smoke-report/1',
      status: 'pass',
      startup_smoke_harness_ref: artifacts.startupSmokeHarness.ref,
      startup_smoke_harness_hash: artifacts.startupSmokeHarness.hash,
      startup_smoke_max_duration_ms: harness.startup_smoke_max_duration_ms,
      duration_ms: durationMs,
      database_schema_version: reopenedSchemaVersion,
      database_schema_hash: schemaHash,
      sqlite_profile_candidate_hash: profileArtifactHash,
      production_pragmas_verified: true,
      integrity_check_verified: integrityCheckVerified,
      foreign_key_check_verified: foreignKeyCheckVerified,
      reopen_verified: true,
      database_bytes: fileBytes(databasePath),
      wal_bytes: fileBytes(`${databasePath}-wal`),
      transaction_affected_rows: transactionAffectedRows,
      identity_evidence: identityEvidence,
    } as const;
    const report = {
      ...payload,
      report_hash: domainSeparatedSha256(
        'icarus:startup-smoke-report:1\n',
        payload as unknown as JsonValue,
      ),
    };
    writeJsonAtomic(path.resolve(options.reportOutput), report);
    return report;
  } finally {
    for (const suffix of ['', '-wal', '-shm'])
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}
