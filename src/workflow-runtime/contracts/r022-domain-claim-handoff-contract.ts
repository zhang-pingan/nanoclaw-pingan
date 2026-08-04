import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';
import { buildDomainClaimHandoffSchemaPrerequisiteArtifact } from '../store/schema/domain-claim-handoff-source.js';

export const R022_SPEC_HEADING =
  '### R-022：Required Child Domain Claim Handoff 决议';
export const R022_CONTRACT_PATH =
  'conformance/r022-domain-claim-handoff/domain-claim-handoff-contract@1.json';
export const R022_PACK_PATH = 'contract-pack-r022-domain-claim-handoff.json';
export const R022_HISTORICAL_BLOCKER_SHA256 =
  '09e03107610774db306ac6ef22b8fde2001f9a54073ae44ca2d7db57720adaf3';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');
const SPEC_DOMAIN = 'icarus:workflow-r022-domain-claim-handoff-spec:1\n';
const CONTRACT_DOMAIN =
  'icarus:workflow-r022-domain-claim-handoff-contract:1\n';
const PACK_DOMAIN =
  'icarus:workflow-contract-pack-r022-domain-claim-handoff:1\n';
const MEMBER_DOMAIN =
  'icarus:workflow-r022-domain-claim-handoff-member-tree:1\n';

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
  const start = document.indexOf(R022_SPEC_HEADING);
  if (start < 0 || document.indexOf(R022_SPEC_HEADING, start + 1) >= 0) {
    throw new Error('R-022 normative section must exist exactly once');
  }
  const end = document.indexOf('\n### ', start + R022_SPEC_HEADING.length);
  if (end < 0) throw new Error('R-022 normative section is not closed');
  return document.slice(start, end).trimEnd();
}

function expectedFiles(document = readSpecDocument()): Map<string, string> {
  const section = specSection(document);
  const prerequisite = buildDomainClaimHandoffSchemaPrerequisiteArtifact();
  const blockerPath = path.join(
    projectRoot,
    'src/workflow-runtime/contracts/g6-required-child-claim-handoff-blocker.test.ts',
  );
  const blockerSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(blockerPath))
    .digest('hex');
  if (blockerSha256 !== R022_HISTORICAL_BLOCKER_SHA256) {
    throw new Error('R-022 historical Schema 9 blocker bytes drifted');
  }
  const contract = artifact(
    'icarus.workflow-r022-domain-claim-handoff-contract/1',
    'icarus.workflow-r022-domain-claim-handoff-contract',
    CONTRACT_DOMAIN,
    {
      decision_id: 'R-022',
      status:
        'R022_REQUIRED_CHILD_DOMAIN_CLAIM_HANDOFF_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      normative_spec: {
        path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
        section_heading: R022_SPEC_HEADING,
        section_raw_sha256: rawHash(section),
        section_semantic_hash: domainSeparatedSha256(SPEC_DOMAIN, section),
      },
      selected_authority: {
        database_schema_version: 10,
        predecessor_database_schema_version: 9,
        claim_model: 'owner_bound_append_history_with_exact_current_head',
        claim_id: 'owner_workflow_and_creation_key_bound',
        resource_generation: 'strict_claim_epoch',
        current_holder_proof: 'bidirectional_deferred_composite_foreign_keys',
        handoff_proof:
          'exact_parent_child_claim_schedule_creation_request_workflow_relation',
        exclusive_token_rule: 'child_equals_parent_plus_one',
        effect_claim_proof:
          'exact_operation_run_owner_resource_epoch_and_fencing_identity',
      },
      closed_rejections: [
        'rekey_released_parent',
        'reuse_parent_claim_row_for_child',
        'partial_unique_without_exact_head',
        'delete_or_ignore_released_history',
        'delete_or_reset_resource_head',
        'application_boolean_as_relationship_proof',
        'delayed_post_t8_acquire',
      ],
      schema_prerequisite: {
        path: 'src/workflow-runtime/store/schema/inputs/workflow-domain-claim-handoff-schema-prerequisite@1.json',
        hash: prerequisite.hash,
        added_table_count: 1,
        affected_table_count: 7,
        query_intent_count: 1,
      },
      historical_blocker: {
        path: 'src/workflow-runtime/contracts/g6-required-child-claim-handoff-blocker.test.ts',
        raw_sha256: `sha256:${R022_HISTORICAL_BLOCKER_SHA256}`,
        expected_test_count: 2,
        authority: 'schema9_impossibility_proof_only',
      },
      production_claim_primitives: [
        'direct_acquire_append_history',
        'release_exact_head_cas',
        'required_child_exclusive_handoff',
        'effect_claim_exact_lineage_persistence',
      ],
      fail_closed_cases: [
        'duplicate',
        'stale_claim_or_head_version',
        'tamper',
        'wrong_owner',
        'wrong_parent_child',
        'wrong_resource',
        'wrong_token',
        'wrong_schedule_creation_request_relation',
        'effect_claim_lineage',
        'migration_invalid_history_or_fault',
        'current_historical_authority_crossing',
      ],
      transaction_proof: {
        mode: 'begin_immediate',
        external_work: 'none',
        rollback:
          'parent_claim_head_child_claim_handoff_all_unchanged_on_any_failure',
        replay: 'immutable_exact_tuple_zero_dml',
      },
      implementation_boundary: {
        r022_g1_g3_g4_g5_status: 'IN_PROGRESS',
        g6_production_implementation_count: 0,
        g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
        g7_through_g9: 'NOT_READY',
      },
    },
  );
  const contractBytes = render(contract);
  const members = [
    {
      path: R022_CONTRACT_PATH,
      artifact_hash: contract.hash,
      raw_sha256: rawHash(contractBytes),
    },
  ];
  const pack = artifact(
    'icarus.workflow-contract-pack-r022-domain-claim-handoff/1',
    'icarus.workflow-contract-pack-r022-domain-claim-handoff',
    PACK_DOMAIN,
    {
      gate: 'R-022_G6_PREREQUISITE',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(MEMBER_DOMAIN, members),
      affected_gate_status: 'IN_PROGRESS',
      affected_gates: ['R-022', 'G1', 'G3', 'G4', 'G5'],
      g6_production_implementation_count: 0,
      g6_status: 'BLOCKED_PENDING_REGRESSION_NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
    },
  );
  return new Map([
    [R022_CONTRACT_PATH, contractBytes],
    [R022_PACK_PATH, render(pack)],
  ]);
}

function writeAtomic(relativePath: string, bytes: string): void {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`R-022 artifact escapes Contract root: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, 'utf8');
  fs.renameSync(temporary, absolute);
}

export function generateR022DomainClaimHandoffContract(): void {
  for (const [relativePath, bytes] of expectedFiles()) {
    writeAtomic(relativePath, bytes);
  }
}

export function checkR022DomainClaimHandoffContract(): ContractArtifactEnvelope {
  const expected = expectedFiles();
  for (const [relativePath, bytes] of expected) {
    const absolute = path.resolve(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes
    ) {
      throw new Error(`R-022 Contract artifact drift: ${relativePath}`);
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(Buffer.from(expected.get(R022_PACK_PATH)!)),
  );
}

export function buildR022DomainClaimHandoffArtifactsForTest(
  document: string,
): Map<string, string> {
  return expectedFiles(document);
}
