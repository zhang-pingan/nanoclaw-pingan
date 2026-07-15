import {
  checkContractPackFoundation,
  generateContractPackFoundation,
} from './contract-pack.js';
import {
  checkContractPackClosedSchemas,
  generateContractPackClosedSchemas,
} from './closed-schema-pack.js';
import {
  checkContractPackCatalogProtocols,
  generateContractPackCatalogProtocols,
} from './catalog-protocol-pack.js';
import {
  checkContractPackSafetySqlite,
  generateContractPackSafetySqlite,
} from './safety-sqlite-pack.js';
import {
  checkContractPackLogicalSchema,
  generateContractPackLogicalSchema,
} from './logical-schema-pack.js';

function usage(): never {
  console.error('Usage: contract-pack <generate|check>');
  process.exit(64);
}

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  usage();
}

let currentPack:
  | 'foundation'
  | 'closed_schemas'
  | 'catalog_protocols'
  | 'safety_sqlite'
  | 'logical_schema' = 'foundation';

try {
  const foundationManifest =
    command === 'generate'
      ? generateContractPackFoundation()
      : checkContractPackFoundation();
  console.log(`contract_pack_foundation=${command}:ok`);
  console.log(`contract_pack_foundation_hash=${foundationManifest.hash}`);

  currentPack = 'closed_schemas';
  const closedSchemaManifest =
    command === 'generate'
      ? generateContractPackClosedSchemas()
      : checkContractPackClosedSchemas();
  console.log(`contract_pack_closed_schemas=${command}:ok`);
  console.log(`contract_pack_closed_schemas_hash=${closedSchemaManifest.hash}`);

  currentPack = 'catalog_protocols';
  const catalogProtocolManifest =
    command === 'generate'
      ? generateContractPackCatalogProtocols()
      : checkContractPackCatalogProtocols();
  console.log(`contract_pack_catalog_protocols=${command}:ok`);
  console.log(
    `contract_pack_catalog_protocols_hash=${catalogProtocolManifest.hash}`,
  );

  currentPack = 'safety_sqlite';
  const safetySqliteManifest =
    command === 'generate'
      ? generateContractPackSafetySqlite()
      : checkContractPackSafetySqlite();
  console.log(`contract_pack_safety_sqlite=${command}:ok`);
  console.log(`contract_pack_safety_sqlite_hash=${safetySqliteManifest.hash}`);

  currentPack = 'logical_schema';
  const logicalSchemaManifest =
    command === 'generate'
      ? generateContractPackLogicalSchema()
      : checkContractPackLogicalSchema();
  console.log(`contract_pack_logical_schema=${command}:ok`);
  console.log(
    `contract_pack_logical_schema_hash=${logicalSchemaManifest.hash}`,
  );
} catch (error) {
  console.error(
    `contract_pack_${currentPack}=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
