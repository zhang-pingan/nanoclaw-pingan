import { checkContractPackFoundation } from './contract-pack.js';
import { checkContractPackClosedSchemas } from './closed-schema-pack.js';
import { checkContractPackCatalogProtocols } from './catalog-protocol-pack.js';
import { checkContractPackSafetySqlite } from './safety-sqlite-pack.js';
import { checkContractPackLogicalSchema } from './logical-schema-pack.js';
import { checkContractPackStaticAbsence } from './static-absence-pack.js';
import { checkCurrentSealedEraCapacityControlPlane } from './current-sealed-era-historical-checks.js';

function usage(): never {
  console.error('Usage: contract-pack check');
  process.exit(64);
}

const command = process.argv[2];
if (process.argv.length !== 3 || command !== 'check') {
  usage();
}

let currentPack:
  | 'foundation'
  | 'closed_schemas'
  | 'catalog_protocols'
  | 'safety_sqlite'
  | 'logical_schema'
  | 'static_absence'
  | 'capacity_control_plane' = 'foundation';

try {
  const foundationManifest = checkContractPackFoundation();
  console.log('contract_pack_foundation=check:ok');
  console.log(`contract_pack_foundation_hash=${foundationManifest.hash}`);

  currentPack = 'closed_schemas';
  const closedSchemaManifest = checkContractPackClosedSchemas();
  console.log('contract_pack_closed_schemas=check:ok');
  console.log(`contract_pack_closed_schemas_hash=${closedSchemaManifest.hash}`);

  currentPack = 'catalog_protocols';
  const catalogProtocolManifest = checkContractPackCatalogProtocols();
  console.log('contract_pack_catalog_protocols=check:ok');
  console.log(
    `contract_pack_catalog_protocols_hash=${catalogProtocolManifest.hash}`,
  );

  currentPack = 'safety_sqlite';
  const safetySqliteManifest = checkContractPackSafetySqlite();
  console.log('contract_pack_safety_sqlite=check:ok');
  console.log(`contract_pack_safety_sqlite_hash=${safetySqliteManifest.hash}`);

  currentPack = 'logical_schema';
  const logicalSchemaManifest = checkContractPackLogicalSchema();
  console.log('contract_pack_logical_schema=check:ok');
  console.log(
    `contract_pack_logical_schema_hash=${logicalSchemaManifest.hash}`,
  );

  currentPack = 'static_absence';
  const staticAbsenceManifest = checkContractPackStaticAbsence();
  console.log('contract_pack_static_absence=check:ok');
  console.log(
    `contract_pack_static_absence_hash=${staticAbsenceManifest.hash}`,
  );

  currentPack = 'capacity_control_plane';
  const capacityControlPlaneManifest =
    checkCurrentSealedEraCapacityControlPlane();
  console.log('contract_pack_capacity_control_plane=check:ok');
  console.log(
    `contract_pack_capacity_control_plane_hash=${capacityControlPlaneManifest.hash}`,
  );
} catch (error) {
  console.error(
    `contract_pack_${currentPack}=check:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
