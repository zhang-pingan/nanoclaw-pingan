import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
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
  schema6_prerequisite: {
    path: 'src/workflow-runtime/store/schema/inputs/workflow-generated-schema-authority-prerequisite@1.json',
    hash: 'sha256:55bf95fa677ae2d2be30575fcbe68ed8b051913379ceb131b983dfe62658dc00',
  },
  schema6_pack: {
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    hash: 'sha256:3cc206a6dfb1bbaed1bb0f4305323729db23d839652d8a0e020a9a6c4d3e3dd6',
  },
  predecessor_seal: {
    path: 'src/workflow-runtime/contracts/conformance/sealed/g2-capability-outbox-binding-v3/golden-conformance-bundle@2.json',
    hash: 'sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f',
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

function buildDecision(section: string): ContractArtifactEnvelope {
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
  const prerequisite = readPinnedArtifact(INPUTS.schema6_prerequisite).artifact;
  const schema6Pack = readPinnedArtifact(INPUTS.schema6_pack).artifact;
  const predecessor = readPinnedArtifact(INPUTS.predecessor_seal).artifact;
  if (
    prerequisite.payload.database_schema_version !== 6 ||
    prerequisite.payload.delta_hash !==
      'sha256:6705a3d4810f1fb040cd6753fcaccad40b704d76c628827472ee47add34d9804' ||
    schema6Pack.payload.schema5_source_migration_sha256 !==
      'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6' ||
    schema6Pack.payload.schema5_source_sqlite_schema_identity !==
      'sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a' ||
    schema6Pack.payload.schema5_to_schema6_upgrade_sha256 !==
      'sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d' ||
    predecessor.payload.bundle_hash !==
      'sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb'
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
        'GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
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
      },
      plan_binding: {
        plan_format: 'icarus.workflow-graph-scope-plan/2',
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
        database_schema_version: 6,
        authority_kinds: ['registry', 'plan_generated'],
        authority_shape: 'mutually_exclusive_and_complete',
        generated_content_table: 'workflow_generated_schema_contents',
        plan_binding_table: 'workflow_plan_generated_schemas',
        value_binding: 'deferred_composite_fk_to_exact_plan_generated_schema',
        published_registry_identity_for_generated_schema: 'forbidden',
        schema5_identity: 'immutable_historical_predecessor',
        schema5_to_schema6_upgrade:
          'preserve_all_legal_rows_and_inbound_fk_targets_or_rollback',
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
      schema6_delta_hash: prerequisite.payload.delta_hash,
      historical_schema5: {
        source_migration_path:
          'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql',
        source_migration_sha256:
          schema6Pack.payload.schema5_source_migration_sha256,
        sqlite_schema_identity:
          schema6Pack.payload.schema5_source_sqlite_schema_identity,
        user_version: 5,
      },
      fresh_schema6: {
        source_migration_path:
          'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v6.sql',
        source_migration_sha256: schema6Pack.payload.migration_sha256,
        dependency_manifest_role: 'canonical_migration',
        store_bootstrap_source: 'canonical_migration',
        user_version: 6,
      },
      schema5_to_schema6_upgrade_sha256:
        schema6Pack.payload.schema5_to_schema6_upgrade_sha256,
      predecessor_g2_v3_bundle_hash: predecessor.payload.bundle_hash,
    },
  );
}

function expectedFiles(document?: string): Map<string, string> {
  const decision = buildDecision(specSection(document));
  const decisionBytes = render(decision);
  const members = [
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
        'GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(MEMBER_TREE_DOMAIN, members),
      g5_status: 'BLOCKED_BY_SPEC_NOT_READY',
      g6_through_g9_status: 'NOT_READY',
    },
  );
  return new Map([
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
