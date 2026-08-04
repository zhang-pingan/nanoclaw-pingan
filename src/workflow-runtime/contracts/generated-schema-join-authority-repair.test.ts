import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildGeneratedSchemaJoinAuthorityRepairArtifactsForTest,
  checkGeneratedSchemaJoinAuthorityRepair,
  GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH,
  GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
} from './generated-schema-join-authority-repair.js';
import { domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '../../..');

function rawHash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function currentSection(document: string): string {
  const start = document.indexOf(
    GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
  );
  if (start < 0) throw new Error('R-019 section missing in test');
  const end = document.indexOf('\n### ', start + 1);
  if (end < 0) throw new Error('R-019 section not closed in test');
  return document.slice(start, end).trimEnd();
}

describe('generated schema and join expose repair authority', () => {
  it('checks the deterministic closed pack and current exit-candidate boundary', () => {
    const pack = checkGeneratedSchemaJoinAuthorityRepair();
    expect(pack.payload).toMatchObject({
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: 2,
      g5_status: 'BLOCKED_BY_SPEC_NOT_READY',
      g6_through_g9_status: 'NOT_READY',
    });
  });

  it('keeps R-018 unique to Activation and binds generated authority to R-019', () => {
    const progress = fs.readFileSync(
      path.join(
        projectRoot,
        'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-runtime-implementation-progress.md',
      ),
      'utf8',
    );
    expect(progress.match(/^\| R-018 \|/gm)).toEqual(['| R-018 |']);
    expect(progress).toContain(
      '| R-018 | Feature Release Activation persistence | `DONE` |',
    );
    expect(progress.match(/^\| R-019 \|/gm)).toEqual(['| R-019 |']);
    expect(progress).toContain(
      '| R-019 | Generated Schema、Join Expose 与 NodeOutputEnvelope Authority | `CLOSED/DONE` |',
    );

    const document = fs.readFileSync(
      path.join(
        projectRoot,
        'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      ),
      'utf8',
    );
    expect(document).not.toContain(
      '### R-018：Generated Schema 与 Join Expose Authority 决议',
    );
    expect(
      document.match(
        /^### R-019：Generated Schema 与 Join Expose Authority 决议$/gm,
      ),
    ).toHaveLength(1);
    const section = currentSection(document);
    const files =
      buildGeneratedSchemaJoinAuthorityRepairArtifactsForTest(document);
    const decision = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        Buffer.from(
          files.get(GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH)!,
        ),
      ),
    );
    expect(decision.payload.normative_spec).toEqual({
      path: 'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      section_heading: GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
      section_raw_sha256: rawHash(section),
      section_semantic_hash: domainSeparatedSha256(
        'icarus:workflow-generated-schema-join-authority-spec-section:1\n',
        section,
      ),
    });
    expect(decision.payload.decision_id).toBe('R-019');
  });

  it('machine-closes content, Plan, Value, lowering, and G5 handoff semantics', () => {
    const pack = checkGeneratedSchemaJoinAuthorityRepair();
    const member = (pack.payload.members as Array<{ path: string }>).find(
      ({ path }) =>
        path === GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH,
    );
    expect(member).toBeDefined();
    const decision = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(path.resolve(contractsRoot, member!.path)),
      ),
    );
    expect(decision.payload.generated_schema_authority).toMatchObject({
      schema_json_schema_ref_rule: 'both_required_and_equivalent',
      resolver: 'persisted_schema_content_exact_ref_only',
      network_resolver: 'forbidden',
      latest_lookup: 'forbidden',
    });
    expect(decision.payload.join_expose_lowering).toMatchObject({
      source_authority: 'input_ports_plus_expose_only',
      output_owner: 'compiler',
      downstream_assignability_proof: 'required',
      plan_proof_program_replay: 'byte_exact',
    });
    expect(decision.payload.stored_value_authority).toMatchObject({
      database_schema_version: 7,
      predecessor_database_schema_version: 6,
      authority_kinds: ['registry', 'plan_generated'],
      published_registry_identity_for_generated_schema: 'forbidden',
      node_output_envelope_authority:
        'first_class_plan_generated_exact_envelope_descriptor_tuple',
      business_port_or_input_snapshot_authority: 'forbidden',
      schema5_and_schema6_identity: 'immutable_historical_predecessors',
    });
    expect(decision.payload.historical_schema5).toEqual({
      source_migration_path:
        'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql',
      source_migration_sha256:
        'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
      sqlite_schema_identity:
        'sha256:5ee3c119cc6a0e0552e2a6fe45b51c8ffd08ec7acdbac66748978ed0d21fdb0a',
      user_version: 5,
    });
    expect(decision.payload.historical_schema6).toMatchObject({
      source_migration_path:
        'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v6.sql',
      source_migration_sha256:
        'sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
      user_version: 6,
    });
    expect(decision.payload.fresh_schema7).toMatchObject({
      source_migration_path:
        'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v7.sql',
      source_migration_sha256:
        'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
      dependency_manifest_role: 'canonical_migration',
      store_bootstrap_source: 'canonical_migration',
      user_version: 7,
    });
    expect(decision.payload.node_output_envelope_value).toMatchObject({
      draft: 'https://json-schema.org/draft/2020-12/schema',
      closed_port_set: 'exact_compiled_output_ports',
      validation_boundaries: [
        'write',
        'exact_replay',
        'read',
        'store_reopen',
        'recovery_scan',
      ],
      failure_behavior:
        'atomic_fail_closed_no_rewrite_no_latest_network_or_fallback',
    });
    expect(decision.payload.publication_store_runtime_handoff).toMatchObject({
      runtime_fallback: 'forbidden',
      g5_runtime_implementation: 'absent_from_this_repair',
    });
  });

  it('invalidates the pack on any normative section drift', () => {
    const document = fs.readFileSync(
      path.join(
        projectRoot,
        'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      ),
      'utf8',
    );
    const changed = document.replace(
      '不能网络解析、按latest查找或由Runtime补齐',
      '允许按latest查找',
    );
    const original =
      buildGeneratedSchemaJoinAuthorityRepairArtifactsForTest(document);
    const drifted =
      buildGeneratedSchemaJoinAuthorityRepairArtifactsForTest(changed);
    expect(
      drifted.get(GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH),
    ).not.toBe(
      original.get(GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_DECISION_PATH),
    );
  });
});
