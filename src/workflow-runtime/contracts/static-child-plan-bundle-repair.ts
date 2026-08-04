import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compileWorkflow } from '../compiler/compiler.js';
import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from '../compiler/identity.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  canonicalJson,
  calculateArtifactHash,
  domainSeparatedSha256,
} from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const root = 'conformance/static-child-plan-bundle-repair';

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS = Object.freeze({
  protocol: `${root}/static-child-plan-bundle-protocol@1.json`,
  positive: `${root}/positive-cases.json`,
  negative: `${root}/negative-cases.json`,
  fault: `${root}/fault-cases.json`,
  evidence: `${root}/static-child-plan-bundle-evidence@1.json`,
  pack: `${root}/contract-pack-static-child-plan-bundle-repair.json`,
});

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_SOURCE_PATHS = [
  'src/workflow-runtime/contracts/static-child-plan-bundle-types.ts',
  'src/workflow-runtime/compiler/compiler.ts',
  'src/workflow-runtime/compiler/identity.ts',
  'src/workflow-runtime/compiler/types.ts',
  'src/workflow-runtime/runtime/static-child-plan-bundle.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
] as const;

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_EVIDENCE_PATHS = [
  'src/workflow-runtime/compiler/g2-v6-frozen-replay.ts',
  'src/workflow-runtime/compiler/current-g2-golden-replay.ts',
  'src/workflow-runtime/compiler/generated-output-schema-authority.test.ts',
  'src/workflow-runtime/compiler/static-child-plan-bundle.test.ts',
  'src/workflow-runtime/contracts/current-g2-generated-output-schema-golden-authoring.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority-cli.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority.test.ts',
  'src/workflow-runtime/contracts/static-child-plan-bundle-fixture-harness.ts',
  'src/workflow-runtime/contracts/static-child-plan-bundle-repair.test.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.test.ts',
  'src/workflow-runtime/runtime/g5-basic-runtime.test.ts',
] as const;

const PREDECESSOR_SEAL_PATH =
  'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json';
const PREDECESSOR_SEAL_HASH =
  'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11';
const PREDECESSOR_BUNDLE_HASH =
  'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7';
const SNAPSHOT_DOMAIN = 'icarus:workflow-compiler-input-snapshot:2\n';
const ARCHITECTURE_PATH =
  'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md';
const FROZEN_ARCHITECTURE_RAW_SHA256 =
  'sha256:270da49017232f24bf1517eee8e847bb2123a994191ee085203573a2c5e6c3bf';
const STATUS =
  'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION';

export type StaticChildPlanBundleFixtureCategory =
  | 'positive'
  | 'negative'
  | 'fault';
export type StaticChildPlanBundleFixtureSurface = 'Compiler' | 'T2a';
export type StaticChildPlanBundleFixtureOperation =
  | 'compile_workflow'
  | 'persist_compile_result_t2a';
export type StaticChildPlanBundleFixtureDisposition =
  | 'compiled'
  | 'persisted'
  | 'replayed'
  | 'rejected'
  | 'rolled_back';

export interface StaticChildPlanBundleFixtureInput extends JsonObject {
  readonly behavior: string;
  readonly expected_surface: StaticChildPlanBundleFixtureSurface;
  readonly fixture_token: string;
  readonly variants: string[];
}

export interface StaticChildPlanBundleFixtureFault extends JsonObject {
  readonly point: string;
  readonly variants: string[];
}

export interface StaticChildPlanBundleFixtureOracle extends JsonObject {
  readonly disposition: StaticChildPlanBundleFixtureDisposition;
  readonly sqlite_state: 'not_applicable' | 'committed' | 'unchanged';
  readonly exact_error:
    | 'integrity_violation'
    | 'cas_conflict'
    | 'fault_injected'
    | null;
  readonly checks: string[];
}

export interface StaticChildPlanBundleFixtureCase extends JsonObject {
  readonly case_id: string;
  readonly assertion: string;
  readonly category: StaticChildPlanBundleFixtureCategory;
  readonly surface: StaticChildPlanBundleFixtureSurface;
  readonly handler: string;
  readonly operation: StaticChildPlanBundleFixtureOperation;
  readonly input: StaticChildPlanBundleFixtureInput;
  readonly fault: StaticChildPlanBundleFixtureFault | null;
  readonly oracle: StaticChildPlanBundleFixtureOracle;
  readonly binding_hash: Sha256Hash;
}

export interface StaticChildPlanBundleFixtureBindingInput extends JsonObject {
  readonly case_id: string;
  readonly assertion: string;
  readonly category: StaticChildPlanBundleFixtureCategory;
  readonly surface: StaticChildPlanBundleFixtureSurface;
  readonly handler: string;
  readonly operation: StaticChildPlanBundleFixtureOperation;
  readonly input: StaticChildPlanBundleFixtureInput;
  readonly fault: StaticChildPlanBundleFixtureFault | null;
  readonly oracle: StaticChildPlanBundleFixtureOracle;
}

interface CaseSeed {
  readonly case_id: string;
  readonly assertion: string;
  readonly behavior: string;
  readonly variants: readonly string[];
  readonly disposition: StaticChildPlanBundleFixtureDisposition;
  readonly exact_error: StaticChildPlanBundleFixtureOracle['exact_error'];
  readonly checks: readonly string[];
  readonly fault_point?: string;
}

const positiveCases: readonly CaseSeed[] = [
  {
    case_id: 'compiler_nested_bundle_parent_exact',
    assertion:
      'pure Compiler returns nested child source and Plan bytes while the fixed-identity parent remains exact',
    behavior: 'compile_nested_closure_and_compare_fixed_parent',
    variants: ['nested_parent'],
    disposition: 'compiled',
    exact_error: null,
    checks: [
      'parent_plan_canonical_bytes_exact',
      'bundle_membership_order_key_ref_hash',
      'nested_source_and_plan_canonical_bytes',
      'nested_lineage_exact',
    ],
  },
  {
    case_id: 'compiler_shared_content_address',
    assertion:
      'two closure members may share one byte-identical descendant Plan hash',
    behavior: 'compile_repeated_nested_factory_and_compare_shared_descendant',
    variants: ['shared_descendant'],
    disposition: 'compiled',
    exact_error: null,
    checks: [
      'closure_membership_and_order_exact',
      'shared_descendant_plan_hash',
      'shared_descendant_plan_canonical_bytes',
      'shared_descendant_source_canonical_bytes',
    ],
  },
  {
    case_id: 't2a_atomic_parent_child_schema_persistence',
    assertion:
      'T2a atomically persists parent, unique child Plans, and every generated-schema authority',
    behavior: 'persist_parent_unique_children_and_generated_schema_authorities',
    variants: ['atomic_commit'],
    disposition: 'persisted',
    exact_error: null,
    checks: [
      'parent_and_unique_child_plans_atomic',
      'generated_schema_bindings_per_unique_plan',
      'canonical_source_and_plan_bytes',
      'shared_child_content_deduplicated',
    ],
  },
  {
    case_id: 't2a_replay_reopen_response_loss',
    assertion:
      'exact replay and reopen perform zero identity drift after response loss',
    behavior: 'lose_commit_response_reopen_and_exact_replay',
    variants: ['response_loss', 'same_connection_replay', 'reopen_replay'],
    disposition: 'replayed',
    exact_error: null,
    checks: [
      'response_loss_recovery',
      'same_connection_zero_dml',
      'reopen_zero_dml',
      'canonical_database_state_exact',
    ],
  },
] as const;

const negativeCases: readonly CaseSeed[] = [
  {
    case_id: 'bundle_missing_member',
    assertion: 'missing closure member fails before SQLite',
    behavior: 'remove_last_bundle_member',
    variants: ['missing_member'],
    checks: ['closed_membership', 'zero_dml'],
  },
  {
    case_id: 'bundle_extra_member',
    assertion: 'extra closure member fails before SQLite',
    behavior: 'append_excess_bundle_member',
    variants: ['extra_member'],
    checks: ['closed_membership', 'zero_dml'],
  },
  {
    case_id: 'bundle_duplicate_member',
    assertion: 'duplicate closure member fails before SQLite',
    behavior: 'replace_member_with_duplicate_closure_entry',
    variants: ['duplicate_member'],
    checks: ['unique_membership', 'zero_dml'],
  },
  {
    case_id: 'bundle_order_drift',
    assertion: 'bundle order differing from parent closure fails',
    behavior: 'swap_parent_before_descendant_order',
    variants: ['order_drift'],
    checks: ['parent_before_descendant_ascii_order', 'zero_dml'],
  },
  {
    case_id: 'bundle_closure_alias',
    assertion: 'closure-key alias fails',
    behavior: 'replace_exact_closure_key_with_alias',
    variants: ['closure_alias'],
    checks: ['closure_key_exact', 'zero_dml'],
  },
  {
    case_id: 'bundle_unknown_field',
    assertion: 'unknown bundle or entry field fails closed',
    behavior: 'add_unknown_bundle_or_entry_field',
    variants: ['bundle_field', 'entry_field'],
    checks: ['bundle_closed_shape', 'entry_closed_shape', 'zero_dml'],
  },
  {
    case_id: 'bundle_source_tamper',
    assertion: 'child source bytes/hash mismatch fails',
    behavior: 'change_child_source_canonical_bytes',
    variants: ['source_bytes'],
    checks: ['source_hash_and_scope_binding', 'zero_dml'],
  },
  {
    case_id: 'bundle_plan_tamper',
    assertion: 'child canonical Plan bytes/hash mismatch fails',
    behavior: 'change_child_plan_without_rebinding_hash',
    variants: ['plan_bytes'],
    checks: ['plan_hash_and_canonical_bytes', 'zero_dml'],
  },
  {
    case_id: 'bundle_nested_lineage_tamper',
    assertion: 'nested child closure lineage mismatch fails',
    behavior: 'rebind_child_plan_with_incomplete_nested_lineage',
    variants: ['nested_lineage'],
    checks: ['global_nested_lineage', 'member_and_closure_hashes', 'zero_dml'],
  },
  {
    case_id: 'bundle_toolchain_safety_drift',
    assertion: 'child toolchain or safety authority drift fails',
    behavior: 'rebind_child_plan_with_authority_drift',
    variants: ['compiler_toolchain_hash', 'runtime_safety_hash'],
    checks: ['toolchain_authority', 'runtime_safety_authority', 'zero_dml'],
  },
  {
    case_id: 'persisted_plan_collision',
    assertion: 'same content-addressed identity with different bytes fails',
    behavior: 'tamper_persisted_child_plan_bytes_then_replay',
    variants: ['compiled_plan_json'],
    checks: ['content_addressed_collision', 'no_repair_on_replay'],
  },
  {
    case_id: 'persisted_child_schema_binding_missing',
    assertion: 'missing child generated-schema binding fails exact replay',
    behavior: 'delete_persisted_child_generated_schema_binding_then_replay',
    variants: ['generated_schema_binding'],
    checks: ['generated_schema_binding_set_exact', 'no_repair_on_replay'],
  },
].map((seed) => ({
  ...seed,
  disposition: 'rejected' as const,
  exact_error: 'integrity_violation' as const,
})) as readonly CaseSeed[];

const faultCases: readonly CaseSeed[] = [
  {
    case_id: 'fault_before_first_write',
    assertion:
      'fault before first write leaves Plan and binding tables unchanged',
    behavior: 'inject_before_first_t2a_write',
    variants: ['before_first_write'],
    disposition: 'rolled_back',
    exact_error: 'fault_injected',
    checks: ['plan_table_unchanged', 'schema_binding_table_unchanged'],
    fault_point: 'before_first_write',
  },
  {
    case_id: 'fault_before_commit',
    assertion:
      'fault after all inserts and before commit rolls back the complete bundle',
    behavior: 'inject_after_all_t2a_writes_before_commit',
    variants: ['before_commit'],
    disposition: 'rolled_back',
    exact_error: 'fault_injected',
    checks: [
      'parent_and_child_plan_rows_rolled_back',
      'generated_schema_rows_rolled_back',
      'build_cas_rolled_back',
    ],
    fault_point: 'before_commit',
  },
  {
    case_id: 'stale_build_row_version',
    assertion: 'stale build row version performs no Plan writes',
    behavior: 'submit_stale_build_row_version',
    variants: ['row_version'],
    disposition: 'rejected',
    exact_error: 'cas_conflict',
    checks: ['build_row_version_cas', 'zero_dml'],
    fault_point: 'stale_build_row_version',
  },
  {
    case_id: 'stale_compile_lease',
    assertion:
      'stale compile lease owner, token, or expiry performs no Plan writes',
    behavior: 'submit_stale_compile_lease_identity_or_expiry',
    variants: ['owner', 'token', 'expiry'],
    disposition: 'rejected',
    exact_error: 'cas_conflict',
    checks: [
      'lease_owner_exact',
      'lease_token_exact',
      'lease_expiry_live',
      'zero_dml',
    ],
    fault_point: 'stale_compile_lease',
  },
  {
    case_id: 'stale_work_fence',
    assertion: 'stale run or scope work fence performs no Plan writes',
    behavior: 'submit_stale_run_or_scope_work_fence',
    variants: ['run_fence', 'scope_fence'],
    disposition: 'rejected',
    exact_error: 'cas_conflict',
    checks: ['run_work_fence_exact', 'scope_work_fence_exact', 'zero_dml'],
    fault_point: 'stale_work_fence',
  },
  {
    case_id: 'reopen_tamper_recovery',
    assertion:
      'reopen replay detects Plan or generated-schema tamper without repair',
    behavior: 'reopen_then_detect_persisted_plan_or_schema_binding_tamper',
    variants: ['compiled_plan_json', 'generated_schema_binding'],
    disposition: 'rejected',
    exact_error: 'integrity_violation',
    checks: ['sqlite_reopen', 'tamper_detected', 'no_repair_on_recovery'],
    fault_point: 'reopen_tamper_recovery',
  },
] as const;

function fixtureSurface(seed: CaseSeed): StaticChildPlanBundleFixtureSurface {
  return seed.case_id.startsWith('compiler_') ? 'Compiler' : 'T2a';
}

export function calculateStaticChildPlanBundleFixtureBindingHash(
  fixture: StaticChildPlanBundleFixtureBindingInput,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-static-child-plan-bundle-fixture-binding:1\n',
    fixture as JsonObject,
  );
}

function buildFixtureCase(
  seed: CaseSeed,
  category: StaticChildPlanBundleFixtureCategory,
): StaticChildPlanBundleFixtureCase {
  const surface = fixtureSurface(seed);
  const operation =
    surface === 'Compiler'
      ? ('compile_workflow' as const)
      : ('persist_compile_result_t2a' as const);
  const withoutBinding: StaticChildPlanBundleFixtureBindingInput = {
    case_id: seed.case_id,
    assertion: seed.assertion,
    category,
    surface,
    handler:
      surface === 'Compiler'
        ? 'compile_workflow_production'
        : 'persist_static_child_plan_bundle_t2a_production',
    operation,
    input: {
      behavior: seed.behavior,
      expected_surface: surface,
      fixture_token: `static-child-plan-bundle-fixture:${seed.case_id}`,
      variants: [...seed.variants],
    },
    fault:
      category === 'fault'
        ? {
            point: seed.fault_point!,
            variants: [...seed.variants],
          }
        : null,
    oracle: {
      disposition: seed.disposition,
      sqlite_state:
        surface === 'Compiler'
          ? 'not_applicable'
          : category === 'positive'
            ? 'committed'
            : 'unchanged',
      exact_error: seed.exact_error,
      checks: [...seed.checks],
    },
  };
  return {
    ...withoutBinding,
    binding_hash:
      calculateStaticChildPlanBundleFixtureBindingHash(withoutBinding),
  };
}

export const STATIC_CHILD_PLAN_BUNDLE_POSITIVE_FIXTURES = positiveCases.map(
  (seed) => buildFixtureCase(seed, 'positive'),
);
export const STATIC_CHILD_PLAN_BUNDLE_NEGATIVE_FIXTURES = negativeCases.map(
  (seed) => buildFixtureCase(seed, 'negative'),
);
export const STATIC_CHILD_PLAN_BUNDLE_FAULT_FIXTURES = faultCases.map((seed) =>
  buildFixtureCase(seed, 'fault'),
);

function bytes(relativePath: string): Buffer {
  return fs.readFileSync(path.join(repoRoot, relativePath));
}

function rawHash(value: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function artifact(
  format: string,
  id: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const ref = { id, version: '1.0.0' };
  const base = {
    format,
    ref,
    version: 1,
    domain_separator: domain,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({
      ...base,
      hash: `sha256:${'0'.repeat(64)}`,
    }),
  };
}

function inventory(paths: readonly string[]) {
  return [...paths]
    .sort()
    .map((entry) => ({ path: entry, raw_sha256: rawHash(bytes(entry)) }));
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(bytes(relativePath)),
  );
}

function withoutVersionedCompilerAndGeneratedOutputIdentity(
  plan: JsonObject,
): JsonObject {
  const strip = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (!value || typeof value !== 'object') return value;
    if (
      value.type === 'generated' &&
      ['child_completion', 'map_result', 'node_output_envelope'].includes(
        String(value.generator),
      )
    ) {
      return { type: value.type, generator: value.generator };
    }
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        if (
          [
            'plan_hash',
            'plan_ref',
            'precompiled_plan_hash',
            'member_hash',
            'closure_hash',
            'compiler_version',
            'compiler_build_hash',
            'compiler_toolchain_ref',
            'compiler_toolchain_hash',
          ].includes(key)
        ) {
          return [];
        }
        return [[key, strip(child)]];
      }),
    );
  };
  return strip(plan) as JsonObject;
}

function compilerEvidence(): JsonObject {
  const fixtureRoot =
    'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v6';
  const source = strictParseJsonBytes(
    bytes(`${fixtureRoot}/inputs/positive.static-child-closure.source.json`),
  ) as JsonObject;
  const snapshotArtifact = readArtifact(
    `${fixtureRoot}/inputs/positive.static-child-closure.snapshot@2.json`,
  );
  const predecessorPlan = strictParseJsonBytes(
    bytes(`${fixtureRoot}/expected/positive.static-child-closure.plan.json`),
  ) as JsonObject;
  const predecessor = compileWorkflow({
    caseId: 'static-child-plan-bundle-predecessor-exact',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source)),
    inputSnapshot: snapshotArtifact.payload,
    identity: snapshotArtifact.payload
      .compiler_identity as unknown as ReturnType<
      typeof workflowCompilerIdentity
    >,
  });
  if (
    !predecessor.ok ||
    canonicalJson(predecessor.value.plan) !== canonicalJson(predecessorPlan)
  ) {
    throw new Error(
      'Static child bundle repair changed the fixed v6 parent Plan',
    );
  }

  const toolchain = buildWorkflowCompilerToolchainManifest();
  const identity = workflowCompilerIdentity(toolchain);
  const { snapshot_hash: _snapshotHash, ...snapshotWithoutHash } =
    snapshotArtifact.payload;
  void _snapshotHash;
  const currentSnapshotWithoutHash = {
    ...snapshotWithoutHash,
    compiler_identity: identity as unknown as JsonObject,
  };
  const currentSnapshot = {
    ...currentSnapshotWithoutHash,
    snapshot_hash: domainSeparatedSha256(
      SNAPSHOT_DOMAIN,
      currentSnapshotWithoutHash as JsonObject,
    ),
  };
  const current = compileWorkflow({
    caseId: 'static-child-plan-bundle-current',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source)),
    inputSnapshot: currentSnapshot,
    identity,
  });
  if (!current.ok)
    throw new Error('Current static child bundle fixture rejected');
  if (
    canonicalJson(
      withoutVersionedCompilerAndGeneratedOutputIdentity(current.value.plan),
    ) !==
    canonicalJson(
      withoutVersionedCompilerAndGeneratedOutputIdentity(predecessorPlan),
    )
  ) {
    throw new Error('Static child bundle repair changed parent Plan lowering');
  }
  const entries = current.value.staticChildPlanBundle.entries.map((entry) => ({
    closure_key: entry.closureKey,
    source_hash: domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      entry.source,
    ),
    plan_hash: entry.plan.plan_hash,
    canonical_plan_raw_sha256: rawHash(
      Buffer.from(canonicalJson(entry.plan), 'utf8'),
    ),
  }));
  return {
    compiler_version: identity.compiler_version,
    compiler_build_hash: identity.compiler_build_hash,
    compiler_toolchain_hash: identity.compiler_toolchain_hash,
    predecessor_parent_plan_exact: true,
    predecessor_parent_plan_hash: predecessor.value.plan.plan_hash,
    current_parent_plan_lowering_exact_excluding_versioned_compiler_and_generated_output_schema_identities: true,
    current_parent_plan_hash: current.value.plan.plan_hash,
    bundle_format: current.value.staticChildPlanBundle.format,
    bundle_entries: entries,
    bundle_entry_count: entries.length,
  };
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const predecessor = readArtifact(PREDECESSOR_SEAL_PATH);
  if (
    predecessor.hash !== PREDECESSOR_SEAL_HASH ||
    predecessor.payload.bundle_hash !== PREDECESSOR_BUNDLE_HASH
  ) {
    throw new Error('G2 v6 predecessor seal identity drifted');
  }
  const protocol = artifact(
    'icarus.workflow-static-child-plan-bundle-protocol/1',
    'icarus.workflow-static-child-plan-bundle-protocol',
    'icarus:workflow-static-child-plan-bundle-protocol:1\n',
    {
      status: STATUS,
      parent_plan_format: 'icarus.workflow-graph-scope-plan/2',
      bundle_format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
      bundle_entry_exact_keys: ['closureKey', 'source', 'plan'],
      parent_plan_canonical_bytes_unchanged_for_fixed_identity: true,
      persistence_transaction: 'T2a',
      persistence_semantics:
        'parent_plus_all_missing_unique_static_children_and_generated_schema_authorities',
      replay_semantics: 'verify_exact_zero_dml',
      fixture_execution: {
        record_shape:
          'closed_category_surface_handler_operation_input_fault_oracle_binding',
        binding_domain:
          'icarus:workflow-static-child-plan-bundle-fixture-binding:1\n',
        registry: 'derived_from_exact_checked_in_records',
        dispatch: 'exactly_one_registered_production_handler_per_record',
        completion:
          'missing_duplicate_unknown_malformed_unhandled_multiply_handled_or_binding_drift_fails_closed',
        compiler_handler: 'compileWorkflow',
        t2a_handler: 'persistCompileResultT2a',
        exact_once_counts: { positive: 4, negative: 12, fault: 6 },
      },
      forbidden: [
        'runtime_recompile',
        'moving_registry_resolution',
        'latest_or_fallback_resolution',
        'hash_manifest_plan_synthesis',
        'embedded_second_golden_oracle',
      ],
    },
  );
  const caseArtifact = (
    category: StaticChildPlanBundleFixtureCategory,
    cases: readonly StaticChildPlanBundleFixtureCase[],
  ) =>
    artifact(
      `icarus.workflow-static-child-plan-bundle-${category}-cases/1`,
      `icarus.workflow-static-child-plan-bundle-${category}-cases`,
      `icarus:workflow-static-child-plan-bundle-${category}-cases:1\n`,
      { cases: cases as unknown as JsonValue, case_count: cases.length },
    );
  const positive = caseArtifact(
    'positive',
    STATIC_CHILD_PLAN_BUNDLE_POSITIVE_FIXTURES,
  );
  const negative = caseArtifact(
    'negative',
    STATIC_CHILD_PLAN_BUNDLE_NEGATIVE_FIXTURES,
  );
  const fault = caseArtifact('fault', STATIC_CHILD_PLAN_BUNDLE_FAULT_FIXTURES);
  const sources = inventory(STATIC_CHILD_PLAN_BUNDLE_REPAIR_SOURCE_PATHS);
  const evidenceSources = inventory(
    STATIC_CHILD_PLAN_BUNDLE_REPAIR_EVIDENCE_PATHS,
  );
  const evidence = artifact(
    'icarus.workflow-static-child-plan-bundle-evidence/1',
    'icarus.workflow-static-child-plan-bundle-evidence',
    'icarus:workflow-static-child-plan-bundle-evidence:1\n',
    {
      compiler: compilerEvidence(),
      architecture_ref: ARCHITECTURE_PATH,
      architecture_raw_sha256: FROZEN_ARCHITECTURE_RAW_SHA256,
      real_file_sqlite: true,
      generated_schema_authority_verified_per_unique_plan: true,
      production_sources: sources,
      production_source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-source-tree:1\n',
        sources,
      ),
      evidence_sources: evidenceSources,
      evidence_source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-evidence-tree:1\n',
        evidenceSources,
      ),
    },
  );
  const members = [protocol, positive, negative, fault, evidence].map(
    (member) => ({ format: member.format, ref: member.ref, hash: member.hash }),
  );
  const pack = artifact(
    'icarus.workflow-contract-pack-static-child-plan-bundle-repair/1',
    'icarus.workflow-contract-pack-static-child-plan-bundle-repair',
    'icarus:workflow-contract-pack-static-child-plan-bundle-repair:1\n',
    {
      gates: ['G2', 'G5'],
      status: STATUS,
      predecessor_g2_v6_seal_ref: PREDECESSOR_SEAL_PATH,
      predecessor_g2_v6_seal_hash: PREDECESSOR_SEAL_HASH,
      predecessor_g2_v6_bundle_hash: PREDECESSOR_BUNDLE_HASH,
      g2_g5_closed: false,
      g6_ready: false,
      independent_review_required: true,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-member-tree:1\n',
        members,
      ),
    },
  );
  return [
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.protocol, protocol],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.positive, positive],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.negative, negative],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.fault, fault],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.evidence, evidence],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack, pack],
  ];
}

function render(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateStaticChildPlanBundleRepair(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, value] of buildArtifacts()) {
    const target = path.join(contractsRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(value), 'utf8');
    if (relativePath === STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack)
      pack = value;
  }
  if (!pack) throw new Error('Static child Plan bundle repair pack is missing');
  return pack;
}

export function checkStaticChildPlanBundleRepair(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, expected] of buildArtifacts()) {
    const target = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(target) ||
      fs.readFileSync(target, 'utf8') !== render(expected)
    ) {
      throw new Error(
        `Static child Plan bundle artifact drift: ${relativePath}`,
      );
    }
    if (relativePath === STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack)
      pack = expected;
  }
  if (!pack) throw new Error('Static child Plan bundle repair pack is missing');
  return pack;
}
