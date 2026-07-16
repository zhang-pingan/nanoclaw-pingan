import type {
  StaticAbsenceNegativeCase,
  StaticAbsencePositiveCase,
} from './static-absence-types.js';

export const STATIC_ABSENCE_POSITIVE_CASES = [
  {
    case_id: 'current-production-import-closure-is-clean',
    proof_kind: 'source',
    expected_result: 'pass',
  },
  {
    case_id: 'removed-api-falls-through-to-404',
    proof_kind: 'api',
    expected_result: 'pass',
  },
  {
    case_id: 'removed-electron-dom-is-absent',
    proof_kind: 'ui',
    expected_result: 'pass',
  },
  {
    case_id: 'fresh-and-existing-schema-is-clean',
    proof_kind: 'schema',
    expected_result: 'pass',
  },
  {
    case_id: 'configured-filesystem-roots-are-clean',
    proof_kind: 'filesystem',
    expected_result: 'pass',
  },
  {
    case_id: 'active-resource-roots-are-clean',
    proof_kind: 'resource',
    expected_result: 'pass',
  },
  {
    case_id: 'protected-product-capabilities-remain-present',
    proof_kind: 'protected_capability',
    expected_result: 'pass',
  },
  {
    case_id: 'runtime-test-roots-are-isolated',
    proof_kind: 'test_root',
    expected_result: 'pass',
  },
  {
    case_id: 'candidate-is-outside-all-executable-closures',
    proof_kind: 'candidate_production',
    expected_result: 'pass',
  },
  {
    case_id: 'surface-status-contract-is-closed',
    proof_kind: 'surface',
    expected_result: 'pass',
  },
] as const satisfies readonly StaticAbsencePositiveCase[];

export const STATIC_ABSENCE_NEGATIVE_CASES = [
  {
    case_id: 'removed-source-identifier-reintroduced',
    proof_kind: 'source',
    mutation: 'add_removed_identifier',
    expected_error: 'removed_source_reachable',
  },
  {
    case_id: 'removed-source-import-reintroduced',
    proof_kind: 'source',
    mutation: 'add_removed_import',
    expected_error: 'removed_source_reachable',
  },
  {
    case_id: 'runtime-store-direct-import-bypasses-gateway',
    proof_kind: 'source',
    mutation: 'add_runtime_internal_import',
    expected_error: 'runtime_gateway_bypass',
  },
  {
    case_id: 'removed-api-exact-route-reintroduced',
    proof_kind: 'api',
    mutation: 'add_removed_exact_route',
    expected_error: 'removed_api_reachable',
  },
  {
    case_id: 'removed-api-prefix-route-reintroduced',
    proof_kind: 'api',
    mutation: 'add_removed_prefix_route',
    expected_error: 'removed_api_reachable',
  },
  {
    case_id: 'removed-navigation-reintroduced',
    proof_kind: 'ui',
    mutation: 'add_removed_nav_key',
    expected_error: 'removed_ui_reachable',
  },
  {
    case_id: 'removed-screen-reintroduced',
    proof_kind: 'ui',
    mutation: 'add_removed_screen_id',
    expected_error: 'removed_ui_reachable',
  },
  {
    case_id: 'legacy-table-reintroduced',
    proof_kind: 'schema',
    mutation: 'add_legacy_table',
    expected_error: 'legacy_schema_present',
  },
  {
    case_id: 'legacy-column-reintroduced',
    proof_kind: 'schema',
    mutation: 'add_legacy_column',
    expected_error: 'legacy_schema_present',
  },
  {
    case_id: 'legacy-index-reintroduced',
    proof_kind: 'schema',
    mutation: 'add_legacy_index',
    expected_error: 'legacy_schema_present',
  },
  {
    case_id: 'legacy-data-root-reintroduced',
    proof_kind: 'filesystem',
    mutation: 'add_legacy_data_root',
    expected_error: 'legacy_filesystem_present',
  },
  {
    case_id: 'legacy-active-resource-root-reintroduced',
    proof_kind: 'resource',
    mutation: 'add_legacy_resource_root',
    expected_error: 'legacy_resource_present',
  },
  {
    case_id: 'legacy-feature-resource-key-reintroduced',
    proof_kind: 'resource',
    mutation: 'add_removed_feature_resource_key',
    expected_error: 'legacy_resource_present',
  },
  {
    case_id: 'protected-capability-removed',
    proof_kind: 'protected_capability',
    mutation: 'remove_protected_fixture',
    expected_error: 'protected_capability_missing',
  },
  {
    case_id: 'test-data-root-uses-production-root',
    proof_kind: 'test_root',
    mutation: 'set_test_data_root_to_production',
    expected_error: 'test_root_not_isolated',
  },
  {
    case_id: 'test-store-root-uses-production-root',
    proof_kind: 'test_root',
    mutation: 'set_test_store_root_to_production',
    expected_error: 'test_root_not_isolated',
  },
  {
    case_id: 'test-root-enters-candidate-root',
    proof_kind: 'test_root',
    mutation: 'set_test_root_inside_candidate',
    expected_error: 'test_root_not_isolated',
  },
  {
    case_id: 'candidate-production-import-reachable',
    proof_kind: 'candidate_production',
    mutation: 'add_candidate_production_edge',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-test-helper-reachable',
    proof_kind: 'candidate_test_helper',
    mutation: 'add_candidate_test_helper_edge',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-setup-reachable',
    proof_kind: 'candidate_setup',
    mutation: 'add_candidate_setup_edge',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-feature-registry-reachable',
    proof_kind: 'candidate_feature_registry',
    mutation: 'add_candidate_feature_registry_ref',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-compiler-fixture-reachable',
    proof_kind: 'candidate_compiler_fixture',
    mutation: 'add_candidate_compiler_fixture',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-build-context-reachable',
    proof_kind: 'candidate_build_context',
    mutation: 'add_candidate_build_copy',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-release-artifact-reachable',
    proof_kind: 'candidate_release_artifact',
    mutation: 'add_candidate_release_pattern',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-runtime-file-read-reachable',
    proof_kind: 'candidate_runtime_file_access',
    mutation: 'add_candidate_runtime_read',
    expected_error: 'migration_candidate_reachable',
  },
  {
    case_id: 'candidate-content-used-for-source-hit-scan',
    proof_kind: 'candidate_production',
    mutation: 'scan_candidate_content_for_source_hits',
    expected_error: 'candidate_content_scan_forbidden',
  },
  {
    case_id: 'removed-surface-declares-replacement',
    proof_kind: 'surface',
    mutation: 'removed_surface_with_replacement',
    expected_error: 'surface_status_contract_invalid',
  },
  {
    case_id: 'removed-surface-lacks-removal-fixture',
    proof_kind: 'surface',
    mutation: 'removed_surface_without_fixture',
    expected_error: 'surface_status_contract_invalid',
  },
  {
    case_id: 'active-surface-lacks-contract-fixture',
    proof_kind: 'surface',
    mutation: 'active_surface_without_fixture',
    expected_error: 'surface_status_contract_invalid',
  },
  {
    case_id: 'active-surface-declares-removal-fixture',
    proof_kind: 'surface',
    mutation: 'active_surface_with_removal_fixture',
    expected_error: 'surface_status_contract_invalid',
  },
] as const satisfies readonly StaticAbsenceNegativeCase[];
