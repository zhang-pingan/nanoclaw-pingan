import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';
import { buildChildCompletionLineageSchemaPrerequisiteArtifact } from '../store/schema/child-completion-lineage-source.js';

export const R020_SPEC_HEADING =
  '### R-020：T7b Child Cut / Parent Consumption Database Lineage 决议';
export const R020_CONTRACT_PATH =
  'conformance/r020-child-consumption-lineage/child-consumption-lineage-contract@1.json';
export const R020_PACK_PATH =
  'contract-pack-r020-child-consumption-lineage.json';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');
const SPEC_DOMAIN = 'icarus:workflow-r020-child-consumption-lineage-spec:1\n';
const CONTRACT_DOMAIN =
  'icarus:workflow-r020-child-consumption-lineage-contract:1\n';
const PACK_DOMAIN =
  'icarus:workflow-contract-pack-r020-child-consumption-lineage:1\n';
const MEMBER_DOMAIN =
  'icarus:workflow-r020-child-consumption-lineage-member-tree:1\n';

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
  const start = document.indexOf(R020_SPEC_HEADING);
  if (start < 0 || document.indexOf(R020_SPEC_HEADING, start + 1) >= 0) {
    throw new Error('R-020 normative section must exist exactly once');
  }
  const end = document.indexOf('\n### ', start + R020_SPEC_HEADING.length);
  if (end < 0) throw new Error('R-020 normative section is not closed');
  return document.slice(start, end).trimEnd();
}

function expectedFiles(document = readSpecDocument()): Map<string, string> {
  const section = specSection(document);
  const prerequisite = buildChildCompletionLineageSchemaPrerequisiteArtifact();
  const contract = artifact(
    'icarus.workflow-r020-child-consumption-lineage-contract/1',
    'icarus.workflow-r020-child-consumption-lineage-contract',
    CONTRACT_DOMAIN,
    {
      decision_id: 'R-020',
      status:
        'R020_CHILD_CONSUMPTION_LINEAGE_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      normative_spec: {
        path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
        section_heading: R020_SPEC_HEADING,
        section_raw_sha256: rawHash(section),
        section_semantic_hash: domainSeparatedSha256(SPEC_DOMAIN, section),
      },
      selected_authority: {
        database_schema_version: 8,
        predecessor_database_schema_version: 7,
        enforcement: 'six_deferred_composite_foreign_keys_plus_candidate_keys',
        exact_scope_cut_run_lineage:
          'graph_run_id_child_scope_id_child_completion_cut_id',
        application_query_or_boolean_preauthorization: 'forbidden_as_proof',
        single_column_foreign_keys: 'insufficient_as_proof',
      },
      schema_prerequisite: {
        path: 'src/workflow-runtime/store/schema/inputs/workflow-child-completion-lineage-schema-prerequisite@1.json',
        hash: prerequisite.hash,
        typed_relation_count: 6,
        affected_table_count: 3,
        query_intent_count: 1,
      },
      preserved_contracts: [
        'unique_child_scope_cut',
        'unique_child_scope_consumption',
        'single_map_slot_terminal_outcome',
        't7b_atomic_cut_and_parent_consumption',
      ],
      fail_closed_cases: [
        'cross_scope_child_and_cut',
        'same_scope_id_different_run',
        'same_run_different_scope',
        'wrong_parent_scope',
        'wrong_owner_node',
        'wrong_map_slot',
        'wrong_map_slot_child_scope',
        'wrong_map_slot_terminal_outcome',
        'cross_run_disposition_event',
        'invalid_schema7_upgrade_history',
      ],
      historical_preservation: {
        schema_5_6_7_migrations: 'byte_exact',
        existing_upgrades_through_6_to_7: 'byte_exact',
        schema_7_artifact_pack: 'byte_exact',
      },
      implementation_boundary: {
        g6_production_implementation_count: 0,
        r020_and_g6_done_claim: 'forbidden',
        g7_through_g9: 'NOT_READY',
      },
    },
  );
  const contractBytes = render(contract);
  const members = [
    {
      path: R020_CONTRACT_PATH,
      artifact_hash: contract.hash,
      raw_sha256: rawHash(contractBytes),
    },
  ];
  const pack = artifact(
    'icarus.workflow-contract-pack-r020-child-consumption-lineage/1',
    'icarus.workflow-contract-pack-r020-child-consumption-lineage',
    PACK_DOMAIN,
    {
      gate: 'R-020_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(MEMBER_DOMAIN, members),
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      g7_through_g9_status: 'NOT_READY',
    },
  );
  return new Map([
    [R020_CONTRACT_PATH, contractBytes],
    [R020_PACK_PATH, render(pack)],
  ]);
}

function writeAtomic(relativePath: string, bytes: string): void {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`R-020 artifact escapes Contract root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, 'utf8');
  fs.renameSync(temporary, absolute);
}

export function generateR020ChildConsumptionLineageContract(): void {
  for (const [relativePath, bytes] of expectedFiles()) {
    writeAtomic(relativePath, bytes);
  }
}

export function checkR020ChildConsumptionLineageContract(): ContractArtifactEnvelope {
  const expected = expectedFiles();
  for (const [relativePath, bytes] of expected) {
    const absolute = path.resolve(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes
    ) {
      throw new Error(`R-020 Contract artifact drift: ${relativePath}`);
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(Buffer.from(expected.get(R020_PACK_PATH)!)),
  );
}

export function buildR020ChildConsumptionLineageArtifactsForTest(
  document: string,
): Map<string, string> {
  return expectedFiles(document);
}
