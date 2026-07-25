import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');

export const GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_ROOT =
  'conformance/generated-schema-join-authority-repair';
export const GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH = `${GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_ROOT}/generated-schema-join-authority-contract@1.json`;
export const NODE_OUTPUT_ENVELOPE_PLAN_SCHEMA_PATH = `${GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_ROOT}/compiled-scope-plan-v2-node-output-envelope-schema@1.json`;
export const GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_PACK_PATH = `${GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_ROOT}/contract-pack-generated-schema-join-authority-repair.json`;
export const GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING =
  '### R-019：Generated Schema 与 Join Expose Authority 决议';

const DECISION_DOMAIN =
  'icarus:workflow-generated-schema-join-authority-contract:1\n';
const PACK_DOMAIN =
  'icarus:workflow-contract-pack-generated-schema-join-authority-repair:1\n';
const SPEC_SECTION_DOMAIN =
  'icarus:workflow-generated-schema-join-authority-spec-section:1\n';
const MEMBER_TREE_DOMAIN =
  'icarus:workflow-generated-schema-join-authority-member-tree:1\n';
const PLAN_SCHEMA_DOMAIN =
  'icarus:workflow-compiled-scope-plan-v2-node-output-envelope-schema:1\n';

const INPUTS = Object.freeze({
  g03_pack: {
    path: 'src/workflow-runtime/contracts/contract-pack-closed-schemas.json',
    hash: 'sha256:6f7aa5b997c5a496a4eb95776a09f18e3c25753e7324a6ef1f095a23b8413d81',
  },
  current_plan_schema: {
    path: 'src/workflow-runtime/contracts/schemas/compiled-scope-plan-schema.json',
    hash: 'sha256:c2916f58f4d545ae155e15a92f50073dbd94307bcd2865f1089dcb51cbf39c62',
  },
  execution_binding_pack: {
    path: 'src/workflow-runtime/contracts/conformance/capability-outbox-execution-binding/contract-pack-capability-outbox-execution-binding.json',
    hash: 'sha256:ef76a496fdb384b98cc7cbf66451d0f07186647f3d23538a445eee886461d764',
  },
  plan_v2_schema: {
    path: 'src/workflow-runtime/contracts/conformance/capability-outbox-execution-binding/schemas/compiled-scope-plan-v2-execution-binding-schema@1.json',
    hash: 'sha256:e582abc7a221f4d1afd66d12c2a87816cb228f6139a77d9abfaa1a397844f947',
  },
  schema7_prerequisite: {
    path: 'src/workflow-runtime/store/schema/inputs/workflow-node-output-envelope-schema-authority-prerequisite@1.json',
    hash: 'sha256:cfb14fbbf3bc6ca92d09d7b77e01ff0c281e529f8419f7f155403dd08e642d02',
  },
  schema7_pack: {
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    hash: 'sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306',
  },
  predecessor_seal: {
    path: 'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v5/golden-conformance-bundle@2.json',
    hash: 'sha256:f59040be6f71d8655afcb11ab4527a6683125a7a4e683f1e734b44448f7bb72e',
  },
});

export class GeneratedSchemaJoinAuthorityRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedSchemaJoinAuthorityRepairError';
  }
}

function rawHash(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  id: string,
  version: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id, version },
    version: Number(format.slice(format.lastIndexOf('/') + 1)),
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function absoluteProjectPath(relativePath: string): string {
  const absolute = path.resolve(projectRoot, relativePath);
  if (!absolute.startsWith(`${projectRoot}${path.sep}`)) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      `Repair input escapes project root: ${relativePath}`,
    );
  }
  return absolute;
}

function readPinnedArtifact(input: { path: string; hash: string }): {
  artifact: ContractArtifactEnvelope;
  raw_bytes_hash: Sha256Hash;
} {
  const bytes = fs.readFileSync(absoluteProjectPath(input.path));
  const parsed = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
  if (parsed.hash !== input.hash) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      `Generated schema repair upstream identity drift: ${input.path}`,
    );
  }
  return { artifact: parsed, raw_bytes_hash: rawHash(bytes) };
}

function specSection(document?: string): string {
  const source =
    document ??
    fs.readFileSync(
      path.join(projectRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
      'utf8',
    );
  const start = source.indexOf(
    GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
  );
  if (start < 0) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      'R-019 generated schema authority section is missing',
    );
  }
  const end = source.indexOf('\n### ', start + 1);
  if (end < 0) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      'R-019 generated schema authority section is not closed',
    );
  }
  return source.slice(start, end).trimEnd();
}

function buildNodeOutputEnvelopePlanSchema(): ContractArtifactEnvelope {
  const predecessor = readPinnedArtifact(INPUTS.plan_v2_schema).artifact;
  const schema = structuredClone(predecessor.payload);
  assertJsonObject(schema);
  const defs = schema.$defs;
  assertJsonObject(defs);
  const compiledNode = defs.compiled_node;
  assertJsonObject(compiledNode);
  if (!Array.isArray(compiledNode.oneOf)) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      'Plan predecessor compiled_node union is missing',
    );
  }
  const hashSchema: JsonObject = {
    type: 'string',
    pattern: '^sha256:[0-9a-f]{64}$',
  };
  defs.node_output_envelope_schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'type',
      'generator',
      'canonicalizer',
      'parameter_hash',
      'schema_ref',
      'schema_raw_hash',
      'schema_hash',
      'schema_byte_length',
      'schema_json',
    ],
    properties: {
      type: { const: 'generated' },
      generator: { const: 'node_output_envelope' },
      canonicalizer: { const: 'RFC8785-JCS' },
      parameter_hash: hashSchema,
      schema_ref: {
        type: 'string',
        pattern: '^icarus-generated-schema:sha256:[0-9a-f]{64}$',
      },
      schema_raw_hash: hashSchema,
      schema_hash: hashSchema,
      schema_byte_length: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      schema_json: { $ref: '#/$defs/json_value' },
    },
  };
  for (const [index, branchValue] of compiledNode.oneOf.entries()) {
    assertJsonObject(branchValue);
    if (!Array.isArray(branchValue.required)) {
      throw new GeneratedSchemaJoinAuthorityRepairError(
        `Plan predecessor compiled_node branch ${index} required set is missing`,
      );
    }
    const required = branchValue.required.map(String);
    const outputPortsIndex = required.indexOf('output_ports');
    if (outputPortsIndex < 0 || required.includes('output_envelope_schema')) {
      throw new GeneratedSchemaJoinAuthorityRepairError(
        `Plan predecessor compiled_node branch ${index} shape drifted`,
      );
    }
    required.splice(outputPortsIndex + 1, 0, 'output_envelope_schema');
    branchValue.required = required;
    assertJsonObject(branchValue.properties);
    branchValue.properties.output_envelope_schema = {
      $ref: '#/$defs/node_output_envelope_schema',
    };
  }
  schema.$id =
    'https://icarus.local/workflow/compiled-scope-plan-v2-node-output-envelope-schema@1';
  schema.title =
    'Compiled Scope Plan v2 with canonical NodeOutputEnvelope authority';
  return artifact(
    'icarus.workflow-compiled-scope-plan-v2-node-output-envelope-schema/1',
    'icarus.workflow-compiled-scope-plan-v2-node-output-envelope-schema',
    '1.0.0',
    PLAN_SCHEMA_DOMAIN,
    schema,
  );
}

function buildDecision(
  section: string,
  planSchema: ContractArtifactEnvelope,
): ContractArtifactEnvelope {
  const upstream = Object.fromEntries(
    Object.entries(INPUTS).map(([name, input]) => {
      const value = readPinnedArtifact(input);
      return [
        name,
        {
          path: input.path,
          artifact_hash: value.artifact.hash,
          raw_bytes_hash: value.raw_bytes_hash,
        },
      ];
    }),
  );
  const prerequisite = readPinnedArtifact(INPUTS.schema7_prerequisite).artifact;
  const schema7Pack = readPinnedArtifact(INPUTS.schema7_pack).artifact;
  const predecessor = readPinnedArtifact(INPUTS.predecessor_seal).artifact;
  if (
    prerequisite.payload.database_schema_version !== 7 ||
    prerequisite.payload.predecessor_database_schema_version !== 6 ||
    prerequisite.payload.generated_schema_generator !==
      'node_output_envelope' ||
    schema7Pack.payload.schema5_source_migration_sha256 !==
      'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6' ||
    schema7Pack.payload.schema5_source_sqlite_schema_identity !==
      'sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a' ||
    schema7Pack.payload.schema5_to_schema6_upgrade_sha256 !==
      'sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d' ||
    (prerequisite.payload.historical_schema6 as JsonObject)
      .migration_sha256 !==
      'sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41' ||
    (prerequisite.payload.historical_schema6 as JsonObject)
      .sqlite_schema_identity !==
      'sha256:a4936a9a71670cb30b1c974ee3cf9cd21375fb743e8c2278d8db08c685854486' ||
    schema7Pack.payload.schema6_to_schema7_upgrade_sha256 !==
      'sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062' ||
    predecessor.payload.bundle_hash !==
      'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05'
  ) {
    throw new GeneratedSchemaJoinAuthorityRepairError(
      'Generated schema repair prerequisite or predecessor semantics drifted',
    );
  }
  return artifact(
    'icarus.workflow-generated-schema-join-authority-contract/1',
    'icarus.workflow-generated-schema-join-authority-contract',
    '1.0.0',
    DECISION_DOMAIN,
    {
      decision_id: 'R-019',
      gate: 'G2_SCHEMA_G3_GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR',
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      normative_spec: {
        path: 'local/docs/dynamic-workflow-dag-framework.md',
        section_heading: GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
        section_raw_sha256: rawHash(Buffer.from(section, 'utf8')),
        section_semantic_hash: domainSeparatedSha256(
          SPEC_SECTION_DOMAIN,
          section,
        ),
      },
      generated_schema_authority: {
        descriptor_fields: [
          'type',
          'generator',
          'canonicalizer',
          'parameter_hash',
          'schema_ref',
          'schema_raw_hash',
          'schema_hash',
          'schema_byte_length',
          'schema_json',
        ],
        schema_ref_scheme: 'icarus-generated-schema',
        schema_ref_pattern: '^icarus-generated-schema:sha256:[0-9a-f]{64}$',
        canonicalizer: 'RFC8785-JCS',
        canonical_schema_bytes: 'UTF-8(RFC8785-JCS(schema_json))',
        raw_hash: 'SHA-256(canonical_schema_bytes)',
        schema_hash_domain: 'icarus:workflow-generated-schema:2\n',
        parameter_hash_domain: 'icarus:workflow-generated-schema-parameter:2\n',
        schema_json_schema_ref_rule: 'both_required_and_equivalent',
        resolver: 'persisted_schema_content_exact_ref_only',
        network_resolver: 'forbidden',
        latest_lookup: 'forbidden',
      },
      generator_parameters: {
        join_expose: {
          required_fields: [
            'node_id',
            'output_port',
            'input_port',
            'input_schema',
            'aggregation',
            'max_bytes',
            'required',
          ],
          list_only_fields: ['item_schema', 'item_max_bytes'],
          authority: 'compiled_input_port_contract',
        },
        child_completion: {
          required_fields: ['generator', 'child_interface_ref', 'exits'],
          exits_order: 'ascii_ascending',
        },
        map_result: {
          required_fields: ['generator', 'child_interface_ref', 'exits'],
          exits_order: 'ascii_ascending',
        },
        node_output_envelope: {
          required_fields: [
            'node_id',
            'port_contract_hash',
            'output_ports',
          ],
          output_ports_authority: 'exact_compiled_node_output_ports',
          port_contract_hash_domain:
            'icarus:workflow-node-output-port-contract:1\n',
        },
      },
      plan_binding: {
        plan_format: 'icarus.workflow-graph-scope-plan/2',
        current_plan_schema_ref: NODE_OUTPUT_ENVELOPE_PLAN_SCHEMA_PATH,
        current_plan_schema_hash: planSchema.hash,
        descriptor_in_plan_hash: true,
        binding_hash_domain:
          'icarus:workflow-plan-generated-schema-binding:1\n',
        exact_fields: [
          'plan_id',
          'graph_run_id',
          'plan_hash',
          'schema_ref',
          'schema_hash',
          'generator',
          'parameter_hash',
        ],
        caller_output_ports_authority: 'forbidden',
        sealed_plan_validation:
          'canonical_bytes_and_plan_hash_before_content_or_binding_write',
        exact_node_envelope_descriptor_count: 1,
      },
      join_expose_lowering: {
        source_authority: 'input_ports_plus_expose_only',
        output_owner: 'compiler',
        expose_order: 'ascii_ascending',
        rename: 'output_name_maps_to_exact_compiled_input_port',
        output_schema_generator: 'join_expose',
        output_max_bytes: 'exact_input_max_bytes',
        single_required_rule: 'input_required_or_default_present',
        list_required_rule: 'always_true',
        downstream_assignability_proof: 'required',
        plan_proof_program_replay: 'byte_exact',
      },
      stored_value_authority: {
        database_schema_version: 7,
        predecessor_database_schema_version: 6,
        authority_kinds: ['registry', 'plan_generated'],
        authority_shape: 'mutually_exclusive_and_complete',
        generated_content_table: 'workflow_generated_schema_contents',
        plan_binding_table: 'workflow_plan_generated_schemas',
        value_binding: 'deferred_composite_fk_to_exact_plan_generated_schema',
        published_registry_identity_for_generated_schema: 'forbidden',
        node_output_envelope_authority:
          'first_class_plan_generated_exact_envelope_descriptor_tuple',
        business_port_or_input_snapshot_authority: 'forbidden',
        schema5_and_schema6_identity: 'immutable_historical_predecessors',
        schema6_to_schema7_upgrade:
          'rebuild_closed_generator_checks_preserve_rows_fks_or_rollback',
      },
      node_output_envelope_value: {
        draft: 'https://json-schema.org/draft/2020-12/schema',
        closed_port_set: 'exact_compiled_output_ports',
        port_state_union: 'required_present_optional_present_or_absent',
        content_hash_domain: 'icarus:workflow-node-output-envelope:1\n',
        content_hash_payload: ['port_contract_hash', 'ports'],
        canonical_content_fields: [
          'port_contract_hash',
          'ports',
          'envelope_hash',
        ],
        provenance_hash_domain:
          'icarus:workflow-node-output-envelope-provenance:1\n',
        present_member_provenance_hash_domain:
          'icarus:workflow-node-output-member-provenance:1\n',
        storage_kind: 'inline',
        media_type: 'application/json',
        payload_state: 'live',
        row_version: 0,
        owner: 'exact_owner_graph_run_id_only',
        present_member_validation:
          'exact_live_value_hash_schema_length_and_plan_run_provenance',
        validation_boundaries: [
          'write',
          'exact_replay',
          'read',
          'store_reopen',
          'recovery_scan',
        ],
        failure_behavior:
          'atomic_fail_closed_no_rewrite_no_latest_network_or_fallback',
      },
      publication_store_runtime_handoff: {
        publisher_validation: 'complete_hash_verified_descriptor_only',
        store_authority:
          'persisted_hash_verified_sealed_plan_plus_exact_schema_rows',
        future_runtime_consumption:
          'sealed_typed_output_contract_and_plan_generated_value_identity_only',
        canonical_node_output_envelope_required: true,
        runtime_fallback: 'forbidden',
        g5_runtime_implementation: 'absent_from_this_repair',
      },
      readiness: {
        g5: 'BLOCKED_BY_SPEC_NOT_READY',
        g6_through_g9: 'NOT_READY',
        next_required_gate: 'independent_affected_chain_whole_gate_regression',
      },
      exact_upstream_identities: upstream,
      schema7_prerequisite_hash: prerequisite.hash,
      historical_schema5: {
        source_migration_path:
          'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql',
        source_migration_sha256:
          schema7Pack.payload.schema5_source_migration_sha256,
        sqlite_schema_identity:
          schema7Pack.payload.schema5_source_sqlite_schema_identity,
        user_version: 5,
      },
      historical_schema6: {
        source_migration_path:
          'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v6.sql',
        source_migration_sha256:
          (prerequisite.payload.historical_schema6 as JsonObject)
            .migration_sha256,
        sqlite_schema_identity:
          (prerequisite.payload.historical_schema6 as JsonObject)
            .sqlite_schema_identity,
        user_version: 6,
      },
      schema5_to_schema6_upgrade_sha256:
        schema7Pack.payload.schema5_to_schema6_upgrade_sha256,
      fresh_schema7: {
        source_migration_path:
          'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v7.sql',
        source_migration_sha256: schema7Pack.payload.migration_sha256,
        dependency_manifest_role: 'canonical_migration',
        store_bootstrap_source: 'canonical_migration',
        user_version: 7,
      },
      schema6_to_schema7_upgrade_sha256:
        schema7Pack.payload.schema6_to_schema7_upgrade_sha256,
      predecessor_g2_v5_bundle_hash: predecessor.payload.bundle_hash,
    },
  );
}

function expectedFiles(document?: string): Map<string, string> {
  const planSchema = buildNodeOutputEnvelopePlanSchema();
  const planSchemaBytes = render(planSchema);
  const decision = buildDecision(specSection(document), planSchema);
  const decisionBytes = render(decision);
  const members = [
    {
      path: NODE_OUTPUT_ENVELOPE_PLAN_SCHEMA_PATH,
      artifact_hash: planSchema.hash,
      raw_bytes_hash: rawHash(planSchemaBytes),
    },
    {
      path: GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH,
      artifact_hash: decision.hash,
      raw_bytes_hash: rawHash(decisionBytes),
    },
  ];
  const pack = artifact(
    'icarus.workflow-contract-pack-generated-schema-join-authority-repair/1',
    'icarus.workflow-contract-pack-generated-schema-join-authority-repair',
    '1.0.0',
    PACK_DOMAIN,
    {
      gate: 'G2_SCHEMA_G3_GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR',
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(MEMBER_TREE_DOMAIN, members),
      g5_status: 'BLOCKED_BY_SPEC_NOT_READY',
      g6_through_g9_status: 'NOT_READY',
    },
  );
  return new Map([
    [NODE_OUTPUT_ENVELOPE_PLAN_SCHEMA_PATH, planSchemaBytes],
    [GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH, decisionBytes],
    [GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_PACK_PATH, render(pack)],
  ]);
}

function writeAtomic(relativePath: string, bytes: string): void {
  const absolute = path.resolve(contractsRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, 'utf8');
  fs.renameSync(temporary, absolute);
}

export function generateGeneratedSchemaJoinAuthorityRepair(): void {
  for (const [relativePath, bytes] of expectedFiles()) {
    writeAtomic(relativePath, bytes);
  }
}

export function checkGeneratedSchemaJoinAuthorityRepair(): ContractArtifactEnvelope {
  const expected = expectedFiles();
  for (const [relativePath, bytes] of expected) {
    const absolute = path.resolve(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes
    ) {
      throw new GeneratedSchemaJoinAuthorityRepairError(
        `Generated schema repair artifact drift: ${relativePath}`,
      );
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(
        expected.get(GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_PACK_PATH)!,
      ),
    ),
  );
}

export function buildGeneratedSchemaJoinAuthorityRepairArtifactsForTest(
  document: string,
): Map<string, string> {
  return expectedFiles(document);
}
