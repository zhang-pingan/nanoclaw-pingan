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
import {
  checkContractPackStaticAbsence,
  generateContractPackStaticAbsence,
} from './static-absence-pack.js';
import { checkHistoricalGoldenDraft } from './golden-draft-historical.js';
import {
  checkContractPackCapacityControlPlane,
  checkHistoricalG0_9Conformance,
  generateContractPackCapacityControlPlane,
} from './capacity-control-plane-pack.js';
import { checkHistoricalCompilerContractRepair } from './compiler-contract-repair-historical.js';
import { checkCurrentSealedEraCapacityControlPlane } from './current-sealed-era-historical-checks.js';
import { assertCurrentG2SealedBoundary } from './current-g2-sealed-boundary.js';
import path from 'node:path';

function usage(): never {
  console.error('Usage: contract-pack <generate|check|archive-check>');
  process.exit(64);
}

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check' && command !== 'archive-check')
) {
  usage();
}

const action = command === 'generate' ? 'generate' : 'check';
const includeConstructionArchive = command === 'archive-check';

let currentPack:
  | 'foundation'
  | 'closed_schemas'
  | 'catalog_protocols'
  | 'safety_sqlite'
  | 'logical_schema'
  | 'static_absence'
  | 'golden_draft'
  | 'g0_historical'
  | 'capacity_control_plane'
  | 'compiler_contract_repair' = 'foundation';

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

  currentPack = 'static_absence';
  const staticAbsenceManifest =
    command === 'generate'
      ? generateContractPackStaticAbsence()
      : checkContractPackStaticAbsence();
  console.log(`contract_pack_static_absence=${command}:ok`);
  console.log(
    `contract_pack_static_absence_hash=${staticAbsenceManifest.hash}`,
  );

  if (includeConstructionArchive) {
    currentPack = 'golden_draft';
    const goldenDraftManifest = checkHistoricalGoldenDraft();
    console.log('contract_pack_golden_draft=archive:ok');
    console.log(`contract_pack_golden_draft_hash=${goldenDraftManifest.hash}`);

    currentPack = 'g0_historical';
    const g0ConformanceManifest = checkHistoricalG0_9Conformance();
    console.log('contract_pack_g0_conformance=archive:ok');
    console.log(
      `contract_pack_g0_conformance_hash=${g0ConformanceManifest.hash}`,
    );
  }

  currentPack = 'capacity_control_plane';
  const capacityControlPlaneManifest =
    assertCurrentG2SealedBoundary(
      path.join(import.meta.dirname, 'conformance/sealed'),
    ) === 'current_g2'
      ? checkCurrentSealedEraCapacityControlPlane()
      : command === 'generate'
        ? generateContractPackCapacityControlPlane()
        : checkContractPackCapacityControlPlane();
  console.log(`contract_pack_capacity_control_plane=${command}:ok`);
  console.log(
    `contract_pack_capacity_control_plane_hash=${capacityControlPlaneManifest.hash}`,
  );

  if (includeConstructionArchive) {
    currentPack = 'compiler_contract_repair';
    const compilerContractRepairManifest =
      checkHistoricalCompilerContractRepair();
    console.log('contract_pack_compiler_contract_repair=archive:ok');
    console.log(
      `contract_pack_compiler_contract_repair_hash=${compilerContractRepairManifest.hash}`,
    );
  }
} catch (error) {
  console.error(
    `contract_pack_${currentPack}=${action}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
