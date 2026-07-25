import { calculateArtifactHash } from '../../contracts/hash.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';
import type { LogicalTableMetadata } from '../../contracts/logical-schema-types.js';

export const NODE_OUTPUT_ENVELOPE_SCHEMA_INPUT_RELATIVE_PATH =
  'inputs/workflow-node-output-envelope-schema-authority-prerequisite@1.json';
export const NODE_OUTPUT_ENVELOPE_SCHEMA_INPUT_DOMAIN =
  'icarus:workflow-node-output-envelope-schema-authority-prerequisite:1\n';

const PREDECESSOR_GENERATORS = [
  'join_expose',
  'child_completion',
  'map_result',
] as const;
const CURRENT_GENERATORS = [
  ...PREDECESSOR_GENERATORS,
  'node_output_envelope',
] as const;

export interface NodeOutputEnvelopeSchemaPrerequisitePayload
  extends JsonObject {
  format: 'icarus.workflow-node-output-envelope-schema-authority-prerequisite/1';
  schema_id: 'workflow-runtime-schema-v1';
  database_schema_version: 7;
  predecessor_database_schema_version: 6;
  delta_mode: 'closed_generator_catalog_expansion_with_table_rebuild';
  generated_schema_generator: 'node_output_envelope';
  predecessor_generators: string[];
  current_generators: string[];
  affected_relations: JsonObject[];
  preservation: JsonObject;
  historical_schema6: JsonObject;
}

export function buildNodeOutputEnvelopeSchemaPrerequisiteArtifact(): ContractArtifactEnvelope {
  const payload: NodeOutputEnvelopeSchemaPrerequisitePayload = {
    format:
      'icarus.workflow-node-output-envelope-schema-authority-prerequisite/1',
    schema_id: 'workflow-runtime-schema-v1',
    database_schema_version: 7,
    predecessor_database_schema_version: 6,
    delta_mode: 'closed_generator_catalog_expansion_with_table_rebuild',
    generated_schema_generator: 'node_output_envelope',
    predecessor_generators: [...PREDECESSOR_GENERATORS],
    current_generators: [...CURRENT_GENERATORS],
    affected_relations: [
      {
        table: 'workflow_plan_generated_schemas',
        column: 'generator',
        check_id: 'ck:plan_generated_schemas:generator:enum',
        preservation: 'all_rows_and_exact_plan_content_foreign_keys',
      },
      {
        table: 'workflow_values',
        column: 'generated_schema_generator',
        check_id: 'ck:workflow_values:generated_schema_generator:enum',
        preservation: 'all_rows_and_all_inbound_foreign_key_targets',
      },
    ],
    preservation: {
      schema5_and_schema6_bytes: 'immutable_historical_predecessors',
      schema6_to_schema7_upgrade:
        'single_begin_immediate_rebuild_or_full_rollback',
      columns_primary_keys_unique_keys_foreign_keys_indexes_triggers:
        'exact_except_closed_generator_catalog',
      registry_and_existing_plan_generated_values: 'byte_and_row_exact',
    },
    historical_schema6: {
      schema_pack_hash:
        'sha256:3cc206a6dfb1bbaed1bb0f4305323729db23d839652d8a0e020a9a6c4d3e3dd6',
      schema_hash:
        'sha256:37f0102a9d6b0077f0d44f20182a7d5768ce32b1c0c2c3998937178b06c9b474',
      migration_path:
        'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v6.sql',
      migration_sha256:
        'sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
      sqlite_schema_identity:
        'sha256:a4936a9a71670cb30b1c974ee3cf9cd21375fb743e8c2278d8db08c685854486',
      user_version: 6,
    },
  };
  const artifact: ContractArtifactEnvelope = {
    format:
      'icarus.workflow-node-output-envelope-schema-authority-prerequisite/1',
    ref: {
      id: 'icarus.workflow-node-output-envelope-schema-authority-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: NODE_OUTPUT_ENVELOPE_SCHEMA_INPUT_DOMAIN,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function expandGeneratorCatalog(
  table: LogicalTableMetadata,
  columnName: string,
): LogicalTableMetadata {
  const result = structuredClone(table);
  const column = result.columns.find((entry) => entry.name === columnName);
  if (
    !column ||
    JSON.stringify(column.enum_values) !== JSON.stringify(PREDECESSOR_GENERATORS)
  ) {
    throw new Error(
      `Schema 6 ${table.name}.${columnName} generator catalog drifted`,
    );
  }
  column.enum_values = [...CURRENT_GENERATORS];
  return result;
}

export function applyNodeOutputEnvelopeSchemaPrerequisite(
  schema6Tables: LogicalTableMetadata[],
  artifact: ContractArtifactEnvelope,
): LogicalTableMetadata[] {
  const expected = buildNodeOutputEnvelopeSchemaPrerequisiteArtifact();
  if (artifact.format !== expected.format || artifact.hash !== expected.hash) {
    throw new Error('NodeOutputEnvelope Schema prerequisite identity drifted');
  }
  let affected = 0;
  const tables = schema6Tables.map((table) => {
    if (table.name === 'workflow_plan_generated_schemas') {
      affected += 1;
      return expandGeneratorCatalog(table, 'generator');
    }
    if (table.name === 'workflow_values') {
      affected += 1;
      return expandGeneratorCatalog(table, 'generated_schema_generator');
    }
    return structuredClone(table);
  });
  if (affected !== 2) {
    throw new Error('NodeOutputEnvelope Schema prerequisite target is absent');
  }
  return tables;
}
