import fs from 'node:fs';
import path from 'node:path';

export interface WorkflowRuntimeSqliteConfig {
  readonly busyTimeoutMs: number;
  readonly pageSize: number;
  readonly walAutocheckpointPages: number;
  readonly journalSizeLimitBytes: number;
  readonly cacheSizeKib: number;
  readonly mmapSizeBytes: number;
}

export const WORKFLOW_RUNTIME_SQLITE_CONFIG: WorkflowRuntimeSqliteConfig = {
  busyTimeoutMs: 5_000,
  pageSize: 4_096,
  walAutocheckpointPages: 4_096,
  journalSizeLimitBytes: 67_108_864,
  cacheSizeKib: 32_768,
  mmapSizeBytes: 0,
};

export const CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION = 16;
export const MINIMUM_WORKFLOW_RUNTIME_SCHEMA_VERSION =
  CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION;

const migrationRoot = path.resolve(import.meta.dirname, '../schema/migration');

export function readFreshWorkflowRuntimeSchemaSql(): string {
  return fs.readFileSync(
    path.join(
      migrationRoot,
      `workflow-runtime-schema-v${CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION}.sql`,
    ),
    'utf8',
  );
}
