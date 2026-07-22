import {
  checkG3RegistryExactResourceQuery,
  generateG3RegistryExactResourceQuery,
} from './g3-registry-exact-resource-query.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-registry-exact-resource-query <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateG3RegistryExactResourceQuery()
      : checkG3RegistryExactResourceQuery();
  console.log(`g3_registry_exact_resource_query=${command}:ok`);
  console.log(`manifest_hash=${manifest.hash}`);
  console.log(`slice=${String(manifest.payload.slice)}`);
  console.log(
    `positive_case_count=${String(manifest.payload.positive_case_count)}`,
  );
  console.log(
    `negative_case_count=${String(manifest.payload.negative_case_count)}`,
  );
} catch (error) {
  console.error(
    `g3_registry_exact_resource_query=${command}:failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
