import fs from 'fs';
import os from 'os';
import path from 'path';

import { WorkflowRuntimeConnectionFactory } from './index.js';

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'icarus-g1-store-check-'),
);
const databasePath = path.join(temporaryRoot, 'workflow-runtime.db');

try {
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'create',
  });
  const tableCount = store.queryOne<{ table_count: number }>(
    'SELECT count(*) AS table_count FROM sqlite_schema WHERE type = ? AND name NOT LIKE ?',
    ['table', 'sqlite_%'],
  );
  if (tableCount?.table_count !== 88) {
    throw new Error(
      `Expected 88 current Workflow Runtime tables, received ${String(tableCount?.table_count)}`,
    );
  }
  const schemaVersion = store.schemaVersion;
  store.close();

  const reopened = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'open_existing',
  });
  reopened.close();

  console.log('workflow_runtime_store=check:ok');
  console.log(`workflow_runtime_schema_version=${schemaVersion}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
