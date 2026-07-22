import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export const G3_REGISTRY_RESOURCE_TYPES = [
  'artifact_contract',
  'capability',
  'card_presentation',
  'clarification_contract',
  'command_policy',
  'context_contract',
  'definition',
  'evaluator',
  'execution_policy',
  'executor_implementation',
  'feature_execution_artifact',
  'graph_policy',
  'graph_template',
  'notification_contract',
  'operational_remediation_policy',
  'outbox_policy',
  'prompt',
  'recipe',
  'root_finalization_policy',
  'routing_capability',
  'routing_scope',
  'schema',
  'scope_interface',
  'tool_binding',
  'wait_contract',
] as const;

export type G3RegistryResourceType =
  (typeof G3_REGISTRY_RESOURCE_TYPES)[number];

export const G3_PUBLISH_PREFLIGHT_ERROR_CODES = [
  'compiled_plan_pin_required',
  'execution_artifact_abi_mismatch',
  'execution_artifact_pin_required',
  'feature_identity_pair_mismatch',
  'g2_identity_mismatch',
  'preflight_hash_mismatch',
  'production_compiler_actual_oracle_forbidden',
  'publisher_side_effect_requested',
  'registry_resource_dependency_cycle',
  'registry_resource_dependency_missing',
  'registry_resource_hash_mismatch',
  'registry_resource_identity_duplicate',
  'registry_resource_order_invalid',
  'retention_identity_mismatch',
  'schema_invalid',
  'test_only_scope_mismatch',
  'test_only_promotion_forbidden',
] as const;

export type G3PublishPreflightErrorCode =
  (typeof G3_PUBLISH_PREFLIGHT_ERROR_CODES)[number];

export interface G3ExactCompilerIdentity extends JsonObject {
  compiler_toolchain_manifest_ref: VersionedRef;
  compiler_toolchain_hash: Sha256Hash;
  compiler_version: '3.0.1';
  compiler_build_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
}

export interface G3UpstreamIdentity extends JsonObject {
  g1_schema_root_hash: Sha256Hash;
  g1_schema_dependency_manifest_hash: Sha256Hash;
  g1_physical_schema_identity: Sha256Hash;
  g1_schema_hash: Sha256Hash;
  g1_migration_sha256: Sha256Hash;
  g2_sealed_bundle_ref: string;
  g2_sealed_bundle_artifact_hash: Sha256Hash;
  g2_sealed_bundle_hash: Sha256Hash;
  compiler: G3ExactCompilerIdentity;
}

export interface G3RegistryResourceDependency extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
}

export interface G3CompiledPlanPin extends JsonObject {
  plan_ref: string;
  plan_hash: Sha256Hash;
  plan_format: 'icarus.workflow-graph-scope-plan/2';
  compiler_toolchain_hash: Sha256Hash;
  compiler_build_hash: Sha256Hash;
  provenance: 'sealed_g2_expected';
}

export interface G3ExecutionArtifactPin extends JsonObject {
  ref: VersionedRef;
  artifact_hash: Sha256Hash;
  runtime_kind: 'node_bundle';
  runtime_abi_major: 1;
}

export interface G3RegistryResourceCandidate extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  launchability: 'production' | 'test_only';
  content_hash: Sha256Hash;
  dependencies: G3RegistryResourceDependency[];
  compiled_plan_pin: G3CompiledPlanPin | null;
  execution_artifact_pin: G3ExecutionArtifactPin | null;
  resource_hash: Sha256Hash;
}

export interface G3RegistryPublishPreflightInput extends JsonObject {
  format: 'icarus.workflow-registry-publish-preflight/1';
  operation: 'validate_only';
  target_registry: 'production' | 'test_only';
  fixture_scope: 'none' | 'test_only';
  feature_manifest_ref: VersionedRef | null;
  feature_manifest_hash: Sha256Hash | null;
  feature_release_ref: VersionedRef | null;
  feature_release_hash: Sha256Hash | null;
  resources: G3RegistryResourceCandidate[];
  upstream_identity: G3UpstreamIdentity;
  expected_oracle: 'sealed_g2_independent_expected';
  production_compiler_actual_role: 'comparison_only' | 'expected_oracle';
  retention_policy_ref: VersionedRef;
  retention_policy_hash: Sha256Hash;
  compatibility: {
    run_protocol_major: 1;
    executor_abi_major: 1;
    registry_schema_version: 1;
  };
  requested_registry_write: boolean;
  requested_activation: boolean;
  preflight_hash: Sha256Hash;
}

export type G3RegistryPublishPreflightResult =
  | {
      format: 'icarus.workflow-registry-publish-preflight-result/1';
      outcome: 'accepted';
      code: 'preflight_ok';
      target_registry: 'production' | 'test_only';
      resource_count: number;
      recipe_count: number;
      dependency_closure_hash: Sha256Hash;
      side_effects: 'none_by_contract';
    }
  | {
      format: 'icarus.workflow-registry-publish-preflight-result/1';
      outcome: 'rejected';
      code: G3PublishPreflightErrorCode;
      target_registry: 'production' | 'test_only' | null;
      resource_count: number;
      recipe_count: number;
      dependency_closure_hash: null;
      side_effects: 'none_by_contract';
    };

export const G3_CURRENT_UPSTREAM_IDENTITY: G3UpstreamIdentity = {
  g1_schema_root_hash:
    'sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9',
  g1_schema_dependency_manifest_hash:
    'sha256:8acbfe7b71e43ccb6b093d1c72f973ed27c54a8f04b03e8a8dc4fdc858de5d6e',
  g1_physical_schema_identity:
    'sha256:20006150a0be02a34a636a238fe706e96d3da3b9808911f4475224e93fae7933',
  g1_schema_hash:
    'sha256:adfcd0462b50991cceb9497412f8af4e0271f6769a9d810ff9e4d58011952cf1',
  g1_migration_sha256:
    'sha256:11e69e3d82c3963c3eac7d75be67ac16575e43685fdd8e5b392e97152f734e9b',
  g2_sealed_bundle_ref:
    'conformance/sealed/g2-production-compiler-replay-repair-v2/golden-conformance-bundle@2.json',
  g2_sealed_bundle_artifact_hash:
    'sha256:037009dcd6c5d6bd2888c484fe1adacded68da5c55e17ba12eb722092e4faced',
  g2_sealed_bundle_hash:
    'sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145',
  compiler: {
    compiler_toolchain_manifest_ref: {
      id: 'icarus.workflow-compiler-toolchain',
      version: '3.0.1',
    },
    compiler_toolchain_hash:
      'sha256:4e16227bf723a41207d94a8619f8b6bb50731c412cb5b298869e265097dcaccf',
    compiler_version: '3.0.1',
    compiler_build_hash:
      'sha256:4cb84d57dee323723ed60dc22394100b37cc76a3bfde793ef95ba707cd21a976',
    compiled_ir_schema_ref:
      'conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json',
    compiled_ir_schema_hash:
      'sha256:4d4e325f94b55a6767f3e8596e1e9b880df2b402d3c89f587a10a23f0eadbd46',
    conformance_result_schema_ref:
      'conformance/compiler-contract-repair/schemas/compiler-conformance-case-result-schema.json',
    conformance_result_schema_hash:
      'sha256:019a4ba80ed8ae57b6c862d9fda62d9edcb8aca9c4910fde6bbb580c09af8706',
  },
};

export const G3_RETENTION_POLICY_REF = {
  id: 'icarus.local-single-user-retention',
  version: '1.0.0',
} as const;

export const G3_RETENTION_POLICY_HASH =
  'sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d' as const;
