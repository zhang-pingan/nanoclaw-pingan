import { domainSeparatedSha256 } from './hash.js';
import type { JsonObject, Sha256Hash } from './types.js';

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
      'pure Compiler returns nested child source and Plan bytes while the semantic-version parent remains exact',
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
      'exact replay and reopen preserve canonical state after response loss',
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
    case_id: 'bundle_semantic_safety_drift',
    assertion: 'child semantic version or safety authority drift fails',
    behavior: 'rebind_child_plan_with_semantic_or_safety_drift',
    variants: ['compiler_version', 'runtime_safety_hash'],
    checks: [
      'compiler_semantic_version',
      'runtime_safety_authority',
      'zero_dml',
    ],
  },
  {
    case_id: 'persisted_plan_collision',
    assertion: 'same content address with different bytes fails',
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
    behavior: 'submit_stale_compile_lease_or_expiry',
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
