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
    identityMode: 'isolated_test',
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
  const evidence = store.identityEvidence;
  const frozenInputs = store.frozenInputs;
  store.close();

  const reopened = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'open_existing',
    identityMode: 'isolated_test',
  });
  reopened.close();

  console.log('workflow_runtime_store=check:ok');
  console.log(`workflow_runtime_schema_hash=${frozenInputs.schemaHash}`);
  console.log(`workflow_runtime_schema_root_hash=${frozenInputs.g1RootHash}`);
  console.log(`sqlite_profile_hash=${frozenInputs.profileArtifactHash}`);
  console.log('sqlite_profile_status=candidate');
  console.log('sqlite_certification_status=not_certified');
  console.log(`sqlite_version=${evidence.sqlite_version}`);
  console.log(
    `sqlite_compile_options_hash=${evidence.sqlite_compile_options_hash}`,
  );
  console.log(
    `better_sqlite3_native_module_hash=${evidence.better_sqlite3_native_module_hash}`,
  );
  console.log(
    `runtime_launcher_observed_hash=${evidence.runtime_launcher_observed_hash}`,
  );
  console.log(`release_identity_status=${evidence.release_identity_status}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
