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
  'outbox_adapter',
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
  'capability_outbox_binding_mismatch',
  'capability_outbox_binding_required',
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
  compiler_version: '3.0.4';
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

export interface G3CapabilityOutboxBindingPin extends JsonObject {
  effect_type: 'capability_dispatch';
  adapter: G3RegistryResourceDependency & { resource_type: 'outbox_adapter' };
  delivery_policy: G3RegistryResourceDependency & {
    resource_type: 'outbox_policy';
  };
  policy_snapshot_source_hash: Sha256Hash;
  delivery_lane: 'normal_execution';
  reconciliation: 'not_required' | 'by_effect_key';
  idempotency: 'provider_key' | 'external_lookup';
  delivery_requirement: 'required';
}

export interface G3RegistryResourceCandidate extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  launchability: 'production' | 'test_only';
  content_hash: Sha256Hash;
  dependencies: G3RegistryResourceDependency[];
  compiled_plan_pin: G3CompiledPlanPin | null;
  execution_artifact_pin: G3ExecutionArtifactPin | null;
  capability_outbox_binding: G3CapabilityOutboxBindingPin | null;
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
    'sha256:d4dfd9e1beaea10ab7ecca33308d0624fe7ae4c45518a98729198ed7c6f09375',
  g1_schema_dependency_manifest_hash:
    'sha256:3f68cbd5618060135f7bd7f46589bc4a7b8f0647d6e8efda9bec1d8b55ce7ede',
  g1_physical_schema_identity:
    'sha256:edf59d731f72e5cfd437bed52e8faf73d306456d58a17d1f14448af1a34b26bb',
  g1_schema_hash:
    'sha256:4d096ce9c2ed47a195c36d11a6540a3c0191183a521b59a1520279a0ffaf9be2',
  g1_migration_sha256:
    'sha256:2a29e1f527f47eb43799a7a35a5272b85f5dc154c003f92f71e152788b17f530',
  g2_sealed_bundle_ref:
    'conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json',
  g2_sealed_bundle_artifact_hash:
    'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11',
  g2_sealed_bundle_hash:
    'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7',
  compiler: {
    compiler_toolchain_manifest_ref: {
      id: 'icarus.workflow-compiler-toolchain',
      version: '3.0.4',
    },
    compiler_toolchain_hash:
      'sha256:c9c5c9b9180ecb9ffde5f8456e44c4e93fc51686988c74e47faa1b2f7fae3ffa',
    compiler_version: '3.0.4',
    compiler_build_hash:
      'sha256:9333356a10b8c5345bfacc80c6071640e5e26561581f39969c7ecabc16ac97c0',
    compiled_ir_schema_ref:
      'conformance/generated-schema-join-authority-repair/compiled-scope-plan-v2-node-output-envelope-schema@1.json',
    compiled_ir_schema_hash:
      'sha256:3dd4f2be80d1e824cd2c0f02aec82830ceeb858d51fbd36c13f7574f032bf51e',
    conformance_result_schema_ref:
      'conformance/capability-outbox-execution-binding/schemas/compiler-conformance-case-result-execution-binding-schema@1.json',
    conformance_result_schema_hash:
      'sha256:ee41b9dff7eb2c97a75c81a7c15ec3bcf935ce233c29468a4ef7b7bfa047987e',
  },
};

export const G3_RETENTION_POLICY_REF = {
  id: 'icarus.local-single-user-retention',
  version: '1.0.0',
} as const;

export const G3_RETENTION_POLICY_HASH =
  'sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d' as const;
