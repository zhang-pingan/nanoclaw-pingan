import {
  checkG38AActivationContractRepair,
  generateG38AActivationContractRepair,
} from './g3-8a-activation-contract-repair.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: g3-8a-activation-contract-repair <generate|check>');
  process.exit(64);
}

try {
  const pack =
    command === 'generate'
      ? generateG38AActivationContractRepair()
      : checkG38AActivationContractRepair();
  console.log(`g3_8a_activation_contract_repair=${command}:ok`);
  console.log(`pack_hash=${pack.hash}`);
  console.log(`status=${String(pack.payload.g3_8a_status)}`);
  console.log(
    `production_reachable=${String(pack.payload.production_reachable)}`,
  );
  console.log(
    `required_database_schema_version=${String(pack.payload.required_database_schema_version)}`,
  );
} catch (error) {
  console.error(
    `g3_8a_activation_contract_repair=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
