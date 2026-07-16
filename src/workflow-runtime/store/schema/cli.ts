import { checkG1Artifacts, generateG1Artifacts } from './artifacts.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: workflow-runtime-schema <generate|check>');
  process.exit(64);
}

try {
  const result =
    command === 'generate' ? generateG1Artifacts() : checkG1Artifacts();
  console.log(`workflow_runtime_schema=${command}:ok`);
  console.log(`workflow_runtime_schema_hash=${result.schemaHash}`);
  console.log(
    `workflow_runtime_schema_root_hash=${result.artifacts.at(-1)?.[1].hash}`,
  );
  console.log(`sqlite_version=${result.environmentSummary.sqlite_version}`);
  console.log(`sqlite_source_id=${result.environmentSummary.sqlite_source_id}`);
  console.log(
    `sqlite_compile_options_hash=${result.environmentSummary.compile_options_hash}`,
  );
  console.log(
    `better_sqlite3_native_module_hash=${result.environmentSummary.native_module_sha256}`,
  );
  console.log(
    `managed_node_exec_path=${result.environmentSummary.managed_node_exec_path}`,
  );
} catch (error) {
  console.error(
    `workflow_runtime_schema=${command}:failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
