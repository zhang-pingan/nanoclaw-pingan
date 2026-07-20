import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildCompilerSemanticCorrectionContractArtifactsForTest,
  checkCompilerSemanticCorrectionContract,
  COMPILER_ERROR_CATALOG_V2_PATH,
  COMPILER_SEMANTIC_CORRECTION_DECISION_PATH,
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
  COMPILER_SEMANTIC_CORRECTION_ROOT,
} from './compiler-semantic-correction-contract.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function treeDigest(): string {
  const root = path.join(contractsRoot, COMPILER_SEMANTIC_CORRECTION_ROOT);
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(root).sort()) {
    hash.update(name, 'utf8');
    hash.update(fs.readFileSync(path.join(root, name)));
  }
  return hash.digest('hex');
}

function artifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G2 working semantic correction Contract', () => {
  it('rebuilds deterministic current bytes and checks them read-only', () => {
    const first = [
      ...buildCompilerSemanticCorrectionContractArtifactsForTest(),
    ];
    const second = [
      ...buildCompilerSemanticCorrectionContractArtifactsForTest(),
    ];
    expect(second).toEqual(first);
    const before = treeDigest();
    const root = checkCompilerSemanticCorrectionContract();
    expect(root.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(treeDigest()).toBe(before);
  });

  it('keeps the construction Contract mutable and production unreachable', () => {
    const decision = artifact(
      COMPILER_SEMANTIC_CORRECTION_DECISION_PATH,
    ).payload;
    expect(decision.correction_kind).toBe('working_semantic_correction');
    expect(decision.construction_lifecycle).toMatchObject({
      phase: 'WORKING',
      mutable_current_artifacts: true,
      publishable: false,
      production_reachable: false,
      history_owner: 'git_history_only',
      human_review_status: 'not_requested_until_prepare_rc',
    });
    expect(decision.construction_seed_inputs).not.toHaveProperty(
      'resolved_draft_v3',
    );
    expect(
      artifact(COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH).payload,
    ).toMatchObject({
      status: 'WORKING_MUTABLE_NOT_PUBLISHABLE',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
    });
    expect(
      artifact(COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH).payload,
    ).not.toHaveProperty('review_history_draft_v3_root');
  });

  it('does not make mutable Markdown or Git history a current dependency', () => {
    const source = fs.readFileSync(
      path.join(contractsRoot, 'compiler-semantic-correction-contract.ts'),
      'utf8',
    );
    expect(source).not.toContain('dynamic-workflow-dag-framework.md');
    expect(source).not.toContain('git log');
    expect(source).not.toContain('git show');
    expect(source).not.toContain('/.git/');
  });

  it('records the unique reachability and identity conclusions', () => {
    const decision = artifact(
      COMPILER_SEMANTIC_CORRECTION_DECISION_PATH,
    ).payload;
    expect(decision.source_ir_contract).toMatchObject({
      qualified_node_id_syntax: 'absent',
      double_colon_token_semantics: 'ordinary_node_id',
      unknown_endpoint_diagnostic: 'graph_endpoint_not_found',
      graph_cross_scope_edge_reachability: 'unreachable_in_closed_source_ir_v1',
    });
    expect(decision.capability_cancellation_contract).toMatchObject({
      invalid_pairing_boundary: 'capability_registry_binding',
      early_completion_cancellation_unsafe_reachability:
        'unreachable_after_capability_contract_validation',
    });
    expect(decision.compiler_identity_comparison).toMatchObject({
      verdict_boolean_allowed: false,
      comparison_owner: 'production_compiler',
      matching_control_required: true,
    });
    expect(
      (
        decision.compiler_identity_comparison as {
          ordered_exact_fields: unknown[];
        }
      ).ordered_exact_fields,
    ).toHaveLength(14);
  });

  it('marks both unreachable diagnostics reserved in a valid v2 catalog', () => {
    const catalog = artifact(COMPILER_ERROR_CATALOG_V2_PATH);
    expect(catalog.version).toBe(2);
    for (const code of [
      'graph_cross_scope_edge',
      'early_completion_cancellation_unsafe',
    ]) {
      expect(catalog.payload.entries).toHaveProperty(
        `${code}.production_emission`,
        'forbidden_reserved',
      );
    }
  });
});
