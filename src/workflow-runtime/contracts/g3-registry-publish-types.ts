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
  'execution_artifact_pin_required',
  'feature_identity_pair_mismatch',
  'compiler_version_mismatch',
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

export interface G3RegistryResourceDependency extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
}

export interface G3CompiledPlanPin extends JsonObject {
  plan_ref: string;
  plan_hash: Sha256Hash;
  plan_format: 'icarus.workflow-graph-scope-plan/2';
  compiler_version: string;
  provenance: 'golden_corpus';
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
  expected_oracle: 'golden_corpus_expected';
  production_compiler_actual_role: 'comparison_only' | 'expected_oracle';
  retention_policy_ref: VersionedRef;
  retention_policy_hash: Sha256Hash;
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

export const G3_RETENTION_POLICY_REF = {
  id: 'icarus.local-single-user-retention',
  version: '1.0.0',
} as const;

export const G3_RETENTION_POLICY_HASH =
  'sha256:3adc19f9a8ee92421faa349ec12e706f2d9862e90c0c74e53eb041794e2b805d' as const;
