import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

export const COMPILER_SEMANTIC_CORRECTION_ROOT =
  'conformance/compiler-semantic-correction';
export const COMPILER_SEMANTIC_CORRECTION_DECISION_PATH = `${COMPILER_SEMANTIC_CORRECTION_ROOT}/semantic-correction-contract@1.json`;
export const COMPILER_ERROR_CATALOG_V2_PATH = `${COMPILER_SEMANTIC_CORRECTION_ROOT}/workflow-compiler-error-catalog@2.json`;
export const COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH = `${COMPILER_SEMANTIC_CORRECTION_ROOT}/contract-pack-compiler-semantic-correction.json`;

export const COMPILER_SEMANTIC_CORRECTION_SPEC_HEADING =
  '### R-017：G2 Working Semantic Correction 决议';

export const COMPILER_EXACT_IDENTITY_FIELDS_V2 = [
  'compiler_toolchain_manifest_ref',
  'compiler_toolchain_hash',
  'compiler_version',
  'compiler_build_hash',
  'canonical_normalizer_version',
  'canonical_normalizer_hash',
  'proof_algorithm_version',
  'proof_algorithm_hash',
  'error_catalog_ref',
  'error_catalog_hash',
  'compiled_ir_schema_ref',
  'compiled_ir_schema_hash',
  'conformance_result_schema_ref',
  'conformance_result_schema_hash',
] as const;

export const COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1 =
  'icarus:workflow-registry-dependency-closure:1\n';

const DECISION_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-contract-artifact:1\n';
const ERROR_CATALOG_DOMAIN = 'icarus:workflow-compiler-error-catalog:2\n';
const ROOT_DOMAIN =
  'icarus:workflow-contract-pack-compiler-semantic-correction:1\n';
const SPEC_SECTION_DOMAIN =
  'icarus:workflow-compiler-semantic-correction-spec-section:1\n';

function absoluteContractPath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`Semantic correction path escapes root: ${relativePath}`);
  }
  return absolute;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absoluteContractPath(relativePath))),
  );
}

function rawHash(bytes: Uint8Array): Sha256Hash {
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
  const revision = Number(format.slice(format.lastIndexOf('/') + 1));
  const value: ContractArtifactEnvelope = {
    format,
    ref: { id, version },
    version: revision,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

function specSection(): string {
  const document = fs.readFileSync(
    path.join(projectRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
    'utf8',
  );
  const start = document.indexOf(COMPILER_SEMANTIC_CORRECTION_SPEC_HEADING);
  if (start < 0) throw new Error('R-017 spec section is missing');
  const end = document.indexOf('\n### ', start + 1);
  if (end < 0) throw new Error('R-017 spec section is not closed');
  return document.slice(start, end).trimEnd();
}

function buildDecision(): ContractArtifactEnvelope {
  const section = specSection();
  return artifact(
    'icarus.workflow-compiler-semantic-correction-contract/1',
    'icarus.workflow-compiler-semantic-correction-contract',
    '1.0.0',
    DECISION_DOMAIN,
    {
      gate: 'G2',
      correction_kind: 'working_semantic_correction',
      source_ir_contract: {
        format: 'icarus.workflow-graph-scope/1',
        endpoint_model: 'ordinary_scope_local_node_id_only',
        qualified_node_id_syntax: 'absent',
        double_colon_token_semantics: 'ordinary_node_id',
        unknown_endpoint_diagnostic: 'graph_endpoint_not_found',
        parent_child_communication: 'owner_typed_ports_only',
        graph_cross_scope_edge_reachability:
          'unreachable_in_closed_source_ir_v1',
      },
      capability_cancellation_contract: {
        valid_contracts: [
          'fence_only_safe_to_abandon',
          'cooperative_safe_if_cancel_lost',
          'requires_compensation_with_compensatable_effect',
        ],
        invalid_pairing_boundary: 'capability_registry_binding',
        early_completion_cancellation_unsafe_reachability:
          'unreachable_after_capability_contract_validation',
        compensatable_early_close_result:
          'compiled_with_cancellation_safety_proof',
      },
      compiler_identity_comparison: {
        verdict_boolean_allowed: false,
        comparison_owner: 'production_compiler',
        ordered_exact_fields: [...COMPILER_EXACT_IDENTITY_FIELDS_V2],
        first_mismatch_diagnostic: 'compiler_integrity_mismatch',
        first_mismatch_phase: 'hash',
        first_mismatch_pointer_prefix: '/compiler_identity/',
        matching_control_required: true,
      },
      definition_identity: {
        domain_separator: 'icarus:workflow-definition:1\n',
        payload: 'definition_without_definition_hash',
        placeholder_hash_allowed: false,
      },
      static_lowering_topology: {
        capability_node_count: 1,
        terminal_nodes: ['success', 'failure'],
        outcome_control_edges: ['succeeded_to_success', 'failed_to_failure'],
        completion_candidate_owner: 'terminal_nodes',
      },
      structural_owner_outputs: {
        subgraph_and_expand_generator: 'child_completion',
        map_generator: 'map_result',
        generated_schema_bytes_required: true,
        parameter_hash_required: true,
        schema_hash_required: true,
        map_item_assignability_required: true,
      },
      snapshot_dependency_closure: {
        format: 'icarus.workflow-registry-dependency-closure/1',
        domain_separator: COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1,
        roots: ['capability', 'wait_contract', 'recipe'],
        member_order: 'resource_ref_ascii_ascending',
        exact_transitive_member_set_required: true,
        reachable_resource_presence_required: true,
      },
      construction_lifecycle: {
        phase: 'WORKING',
        mutable_current_artifacts: true,
        publishable: false,
        production_reachable: false,
        history_owner: 'git_and_review_worksheet',
        corrected_case_count: 40,
        per_case_isolated_snapshot_required: true,
        actual_candidate_role: 'actual_compiler_output_not_golden_oracle',
        expected_oracle_status: 'all_null_working_not_review_candidate',
        human_review_status: 'not_requested_until_prepare_rc',
        prepare_rc_precondition:
          'all_known_findings_fixed_current_checks_green_and_boundary_clean',
        rc_invalidation: 'any_bound_identity_change_returns_to_working',
        golden_semantic_review: 'not_run',
        approval: 'not_run',
        golden_seal: 'not_run',
        sealed_write: 'not_run',
        g3_through_g9: 'not_started',
      },
      spec_section_heading: COMPILER_SEMANTIC_CORRECTION_SPEC_HEADING,
      spec_section_raw_sha256: rawHash(Buffer.from(section, 'utf8')),
      spec_section_semantic_hash: domainSeparatedSha256(
        SPEC_SECTION_DOMAIN,
        section,
      ),
      construction_seed_inputs: {
        r016_root:
          'sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324',
        g2_compiler_root:
          'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77',
        g2_candidate_manifest:
          'sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2',
        resolved_draft_v3:
          'sha256:659caf9b4add7027116bf780c83b2b85dc95ca0baae9cb8b9840d760a785132b',
      },
    },
  );
}

function buildErrorCatalogV2(): ContractArtifactEnvelope {
  const historical = readArtifact(
    'catalogs/workflow-compiler-error-catalog.json',
  );
  if (
    historical.hash !==
    'sha256:a5b27ca8ed6c6ad6ffa018f085c1333f09a7eb380435fd61f03b7f260fdca540'
  ) {
    throw new Error('Historical Compiler Error Catalog drift');
  }
  const codes = historical.payload.error_codes;
  const entries = historical.payload.entries;
  if (!Array.isArray(codes)) throw new Error('Historical error codes missing');
  assertJsonObject(entries);
  const correctedEntries = Object.fromEntries(
    codes.map((codeValue) => {
      const code = String(codeValue);
      const historicalEntry = entries[code];
      assertJsonObject(historicalEntry);
      const reserved =
        code === 'graph_cross_scope_edge' ||
        code === 'early_completion_cancellation_unsafe';
      return [
        code,
        {
          ...historicalEntry,
          source_reachability:
            code === 'graph_cross_scope_edge'
              ? 'unreachable_in_closed_source_ir_v1'
              : code === 'early_completion_cancellation_unsafe'
                ? 'unreachable_after_capability_contract_validation'
                : 'reachable',
          production_emission: reserved ? 'forbidden_reserved' : 'allowed',
        },
      ];
    }),
  );
  return artifact(
    'icarus.workflow-compiler-error-catalog/2',
    'icarus.workflow-compiler-error-catalog',
    '2.0.0',
    ERROR_CATALOG_DOMAIN,
    {
      diagnostic_phases: historical.payload.diagnostic_phases,
      retryabilities: historical.payload.retryabilities,
      error_codes: codes,
      entries: correctedEntries,
      diagnostic_sort_key: historical.payload.diagnostic_sort_key,
      historical_catalog_ref: historical.ref,
      historical_catalog_hash: historical.hash,
      correction_contract_ref: {
        id: 'icarus.workflow-compiler-semantic-correction-contract',
        version: '1.0.0',
      },
    },
  );
}

function expectedFiles(): Map<string, string> {
  const decision = buildDecision();
  const errorCatalog = buildErrorCatalogV2();
  const files = new Map<string, string>([
    [COMPILER_SEMANTIC_CORRECTION_DECISION_PATH, render(decision)],
    [COMPILER_ERROR_CATALOG_V2_PATH, render(errorCatalog)],
  ]);
  const manifest = artifact(
    'icarus.workflow-contract-pack-compiler-semantic-correction/1',
    'icarus.workflow-contract-pack-compiler-semantic-correction',
    '1.0.0',
    ROOT_DOMAIN,
    {
      gate: 'G2',
      status: 'WORKING_MUTABLE_NOT_PUBLISHABLE',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      decision_ref: COMPILER_SEMANTIC_CORRECTION_DECISION_PATH,
      decision_hash: decision.hash,
      error_catalog_ref: COMPILER_ERROR_CATALOG_V2_PATH,
      error_catalog_hash: errorCatalog.hash,
      construction_seed_r016_root:
        'sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324',
      construction_seed_g2_root:
        'sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77',
      review_history_draft_v3_root:
        'sha256:659caf9b4add7027116bf780c83b2b85dc95ca0baae9cb8b9840d760a785132b',
      artifact_inventory: [...files.entries()].map(([file, contents]) => ({
        path: file,
        raw_sha256: rawHash(Buffer.from(contents, 'utf8')),
      })),
      golden_semantic_review_status: 'not_run',
      approval_status: 'not_run',
      golden_seal_status: 'not_run',
      sealed_write_status: 'not_run',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH, render(manifest));
  return files;
}

function listFiles(): string[] {
  const root = absoluteContractPath(COMPILER_SEMANTIC_CORRECTION_ROOT);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .map((name) => `${COMPILER_SEMANTIC_CORRECTION_ROOT}/${name}`)
    .sort();
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absoluteContractPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function validateBoundary(): void {
  const sealed = fs.readdirSync(absoluteContractPath('conformance/sealed'));
  if (sealed.length !== 1 || sealed[0] !== '.gitkeep') {
    throw new Error('Semantic correction crossed sealed boundary');
  }
}

export function buildCompilerSemanticCorrectionContractArtifactsForTest(): Map<
  string,
  string
> {
  return expectedFiles();
}

export function generateCompilerSemanticCorrectionContract(): ContractArtifactEnvelope {
  validateBoundary();
  const files = expectedFiles();
  for (const [relativePath, contents] of files) {
    writeAtomic(relativePath, contents);
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(
        files.get(COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH) ?? '',
        'utf8',
      ),
    ),
  );
}

export function checkCompilerSemanticCorrectionContract(): ContractArtifactEnvelope {
  validateBoundary();
  const files = expectedFiles();
  if (
    JSON.stringify(listFiles()) !== JSON.stringify([...files.keys()].sort())
  ) {
    throw new Error('Semantic correction Contract inventory drift');
  }
  for (const [relativePath, contents] of files) {
    if (
      fs.readFileSync(absoluteContractPath(relativePath), 'utf8') !== contents
    ) {
      throw new Error(`Semantic correction Contract drift: ${relativePath}`);
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(
        files.get(COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH) ?? '',
        'utf8',
      ),
    ),
  );
}
