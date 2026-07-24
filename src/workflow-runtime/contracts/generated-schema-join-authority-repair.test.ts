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
  if (start < 0) throw new Error('R-018 section missing in test');
  const end = document.indexOf('\n### ', start + 1);
  if (end < 0) throw new Error('R-018 section not closed in test');
  return document.slice(start, end).trimEnd();
}

describe('generated schema and join expose repair authority', () => {
  it('checks the deterministic closed pack and current exit-candidate boundary', () => {
    const pack = checkGeneratedSchemaJoinAuthorityRepair();
    expect(pack.payload).toMatchObject({
      status:
        'GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      member_count: 1,
      g5_status: 'BLOCKED_BY_SPEC_NOT_READY',
      g6_through_g9_status: 'NOT_READY',
    });
  });

  it('independently binds the exact R-018 bytes and semantic hash', () => {
    const document = fs.readFileSync(
      path.join(projectRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
      'utf8',
    );
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
      path: 'local/docs/dynamic-workflow-dag-framework.md',
      section_heading: GENERATED_SCHEMA_JOIN_AUTHORITY_REPAIR_SPEC_HEADING,
      section_raw_sha256: rawHash(section),
      section_semantic_hash: domainSeparatedSha256(
        'icarus:workflow-generated-schema-join-authority-spec-section:1\n',
        section,
      ),
    });
  });

  it('machine-closes content, Plan, Value, lowering, and G5 handoff semantics', () => {
    const pack = checkGeneratedSchemaJoinAuthorityRepair();
    const member = (pack.payload.members as Array<{ path: string }>)[0]!;
    const decision = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(path.resolve(contractsRoot, member.path)),
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
      database_schema_version: 6,
      authority_kinds: ['registry', 'plan_generated'],
      published_registry_identity_for_generated_schema: 'forbidden',
      schema5_identity: 'immutable_historical_predecessor',
    });
    expect(decision.payload.publication_store_runtime_handoff).toMatchObject({
      runtime_fallback: 'forbidden',
      g5_runtime_implementation: 'absent_from_this_repair',
    });
  });

  it('invalidates the pack on any normative section drift', () => {
    const document = fs.readFileSync(
      path.join(projectRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
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
