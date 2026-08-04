import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';
import { buildMapTerminalConsumptionSchemaPrerequisiteArtifact } from '../store/schema/map-terminal-consumption-source.js';

export const R021_SPEC_HEADING =
  '### R-021：Map Terminal Child Consumption Closed Catalog 决议';
export const R021_CONTRACT_PATH =
  'conformance/r021-map-terminal-consumption/map-terminal-consumption-contract@1.json';
export const R021_PACK_PATH =
  'contract-pack-r021-map-terminal-consumption.json';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');
const SPEC_DOMAIN = 'icarus:workflow-r021-map-terminal-consumption-spec:1\n';
const CONTRACT_DOMAIN =
  'icarus:workflow-r021-map-terminal-consumption-contract:1\n';
const PACK_DOMAIN =
  'icarus:workflow-contract-pack-r021-map-terminal-consumption:1\n';
const MEMBER_DOMAIN =
  'icarus:workflow-r021-map-terminal-consumption-member-tree:1\n';

function rawHash(bytes: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function artifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function render(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readSpecDocument(): string {
  return fs.readFileSync(
    path.join(
      projectRoot,
      'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
    ),
    'utf8',
  );
}

function specSection(document: string): string {
  const start = document.indexOf(R021_SPEC_HEADING);
  if (start < 0 || document.indexOf(R021_SPEC_HEADING, start + 1) >= 0) {
    throw new Error('R-021 normative section must exist exactly once');
  }
  const end = document.indexOf('\n### ', start + R021_SPEC_HEADING.length);
  if (end < 0) throw new Error('R-021 normative section is not closed');
  return document.slice(start, end).trimEnd();
}

function expectedFiles(document = readSpecDocument()): Map<string, string> {
  const section = specSection(document);
  const prerequisite = buildMapTerminalConsumptionSchemaPrerequisiteArtifact();
  const contract = artifact(
    'icarus.workflow-r021-map-terminal-consumption-contract/1',
    'icarus.workflow-r021-map-terminal-consumption-contract',
    CONTRACT_DOMAIN,
    {
      decision_id: 'R-021',
      status:
        'R021_MAP_TERMINAL_CONSUMPTION_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      normative_spec: {
        path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
        section_heading: R021_SPEC_HEADING,
        section_raw_sha256: rawHash(section),
        section_semantic_hash: domainSeparatedSha256(SPEC_DOMAIN, section),
      },
      selected_authority: {
        database_schema_version: 9,
        predecessor_database_schema_version: 8,
        map_terminal_disposition_outcome_pairs: [
          ['map_slot_completed', 'completed'],
          ['map_slot_errored', 'errored'],
          ['map_slot_cancelled', 'cancelled'],
          ['map_slot_fenced', 'fenced'],
        ],
        non_map_dispositions: [
          'owner_output_published',
          'non_publish_parent_fenced',
          'non_publish_owner_fenced',
        ],
        non_map_slot_and_outcome: 'both_null',
        exact_lineage_enforcement:
          'preserved_six_deferred_composite_foreign_keys',
        application_query_or_boolean_preauthorization: 'forbidden_as_proof',
      },
      schema_prerequisite: {
        path: 'src/workflow-runtime/store/schema/inputs/workflow-map-terminal-consumption-schema-prerequisite@1.json',
        hash: prerequisite.hash,
        typed_relation_count: 6,
        affected_table_count: 1,
        added_candidate_key_count: 0,
        query_intent_count: 1,
      },
      preserved_schema8_authority: {
        migration_sha256:
          'sha256:b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad',
        schema7_to_schema8_upgrade_sha256:
          'sha256:544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9',
        sqlite_schema_identity:
          'sha256:fc5fe00fb26b187cf4d0b2927a97de1851fffc2ba5283811312397255ffd5b3b',
        artifact_pack: 'byte_exact',
      },
      preserved_contracts: [
        'unique_child_scope_cut',
        'unique_child_scope_consumption',
        'single_map_slot_terminal_outcome',
        't7b_atomic_cut_slot_consumption_and_policy_fact',
        'six_exact_composite_lineage_foreign_keys',
      ],
      fail_closed_cases: [
        'wrong_disposition_outcome',
        'missing_slot_or_outcome',
        'non_map_slot_or_outcome',
        'cross_run_scope_child_cut_parent_owner_map_slot_event',
        'duplicate_consumption',
        'tamper',
        'identity_drift',
        'invalid_schema8_upgrade_history',
      ],
      implementation_boundary: {
        g6_production_implementation_count: 0,
        r021_g1_g3_g4_g5_status: 'IN_PROGRESS',
        g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
        g7_through_g9: 'NOT_READY',
      },
    },
  );
  const contractBytes = render(contract);
  const members = [
    {
      path: R021_CONTRACT_PATH,
      artifact_hash: contract.hash,
      raw_sha256: rawHash(contractBytes),
    },
  ];
  const pack = artifact(
    'icarus.workflow-contract-pack-r021-map-terminal-consumption/1',
    'icarus.workflow-contract-pack-r021-map-terminal-consumption',
    PACK_DOMAIN,
    {
      gate: 'R-021_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(MEMBER_DOMAIN, members),
      affected_gate_status: 'IN_PROGRESS',
      affected_gates: ['R-021', 'G1', 'G3', 'G4', 'G5'],
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
    },
  );
  return new Map([
    [R021_CONTRACT_PATH, contractBytes],
    [R021_PACK_PATH, render(pack)],
  ]);
}

function writeAtomic(relativePath: string, bytes: string): void {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`R-021 artifact escapes Contract root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, 'utf8');
  fs.renameSync(temporary, absolute);
}

export function generateR021MapTerminalConsumptionContract(): void {
  for (const [relativePath, bytes] of expectedFiles()) {
    writeAtomic(relativePath, bytes);
  }
}

export function checkR021MapTerminalConsumptionContract(): ContractArtifactEnvelope {
  const expected = expectedFiles();
  for (const [relativePath, bytes] of expected) {
    const absolute = path.resolve(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes
    ) {
      throw new Error(`R-021 Contract artifact drift: ${relativePath}`);
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(Buffer.from(expected.get(R021_PACK_PATH)!)),
  );
}

export function buildR021MapTerminalConsumptionArtifactsForTest(
  document: string,
): Map<string, string> {
  return expectedFiles(document);
}
