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
  compiler_version: '3.0.2';
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
    'sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869',
  g1_schema_dependency_manifest_hash:
    'sha256:d08cfaae72c003b11a05cb1fbfa546f7cce7fad9ecb56d0746f33de294b8088c',
  g1_physical_schema_identity:
    'sha256:ba025b32bb028f2ffe5df45d9440cd0a897e0a06c076b10b6f641c265ae02090',
  g1_schema_hash:
    'sha256:49aaee7c8f046cd9a15b3bc5b77fbcf1713be2a1872078941043f5ccdca29024',
  g1_migration_sha256:
    'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
  g2_sealed_bundle_ref:
    'conformance/sealed/g2-capability-outbox-binding-v3/golden-conformance-bundle@2.json',
  g2_sealed_bundle_artifact_hash:
    'sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f',
  g2_sealed_bundle_hash:
    'sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb',
  compiler: {
    compiler_toolchain_manifest_ref: {
      id: 'icarus.workflow-compiler-toolchain',
      version: '3.0.2',
    },
    compiler_toolchain_hash:
      'sha256:90bc7c99cacaf58217dd6d07781788c844385d3c70644c4086d6c997312f60a1',
    compiler_version: '3.0.2',
    compiler_build_hash:
      'sha256:698af607955463f01a404d626586420f3dd8f7a208da87c1e138075b1518ba05',
    compiled_ir_schema_ref:
      'conformance/capability-outbox-execution-binding/schemas/compiled-scope-plan-v2-execution-binding-schema@1.json',
    compiled_ir_schema_hash:
      'sha256:f5bc0a43d5723096295b9a6fcd5a0965c3b98ca810ae8b6dc1a7072996608e06',
    conformance_result_schema_ref:
      'conformance/capability-outbox-execution-binding/schemas/compiler-conformance-case-result-execution-binding-schema@1.json',
    conformance_result_schema_hash:
      'sha256:021da33556e677984b767f99b12800be8454c7516221ec63bb16e1cb26f867f7',
  },
};

export const G3_RETENTION_POLICY_REF = {
  id: 'icarus.local-single-user-retention',
  version: '1.0.0',
} as const;

export const G3_RETENTION_POLICY_HASH =
  'sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d' as const;
