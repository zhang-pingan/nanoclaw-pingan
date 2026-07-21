import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';
import type {
  G32AErrorCode,
  G32APhase,
  G32AFeatureManifest,
  G32AResourceEntry,
} from './g3-2a-feature-manifest-intake-types.js';

export const G32_FEATURE_MANIFEST_PREFLIGHT_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-preflight/1' as const;
export const G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1' as const;
export const G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_FORMAT =
  'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile/1' as const;

export const G32_FEATURE_MANIFEST_PREFLIGHT_PHASES = [
  'strict_bytes_parse',
  'removed_unknown_structural_intake',
  'full_closed_schema',
  'manifest_hash',
  'ownership_order_path_lexical_validation',
  'root_snapshot_path_read',
  'source_hash',
  'dependency_resolution',
] as const;
export type G32FeatureManifestPreflightPhase =
  (typeof G32_FEATURE_MANIFEST_PREFLIGHT_PHASES)[number];

export interface G32FeatureManifestPreflightDiagnostic extends JsonObject {
  code: G32AErrorCode;
  phase: G32APhase;
  pointer: string;
  detail: string;
}

export interface G32FeatureManifestPreflightResult extends JsonObject {
  format: typeof G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_FORMAT;
  outcome: 'accepted' | 'rejected';
  code: G32AErrorCode;
  phase: G32FeatureManifestPreflightPhase;
  diagnostics: G32FeatureManifestPreflightDiagnostic[];
  feature_id: string | null;
  manifest_hash: Sha256Hash | null;
  reader_invoked: boolean;
  resolver_invoked: boolean;
  root_snapshot_status: 'not_invoked' | 'verified';
  source_hash_status: 'not_invoked' | 'verified';
  dependency_resolution_status: 'not_attempted' | 'resolved';
}

export interface G32ResolvedFeatureRelease extends JsonObject {
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  required_resource_refs: VersionedRef[];
}

export type G32DependencyResolver = (
  dependency: G32ADependencyRequest,
) => G32ResolvedFeatureRelease | null;

export interface G32ADependencyRequest extends JsonObject {
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  required_resource_refs: VersionedRef[];
}

export interface G32FeatureManifestPreflightOptions {
  /** Absolute workspace root containing the canonical `features/<featureId>` tree. */
  workspaceRoot?: string;
  /** Absolute source root override used only by isolated tests. */
  featureSourceRoot?: string;
  /** Alias accepted by test harnesses for the source root override. */
  rootDir?: string;
  dependencyResolver?: G32DependencyResolver;
  /** Alias retained for callers that use the semantic name. */
  resolveDependency?: G32DependencyResolver;
}

export interface G32FeatureManifestPreflightFixture extends JsonObject {
  case_id: string;
  input_text: string;
  expected_code: G32AErrorCode;
  expected_phase: G32APhase;
}

export type G32FeatureManifest = G32AFeatureManifest;
export type G32FeatureResourceEntry = G32AResourceEntry;

export const G32_FEATURE_MANIFEST_PREFLIGHT_ERROR_CODES = [
  'feature_manifest_intake_ok',
  'feature_manifest_json_syntax_invalid',
  'feature_manifest_json_duplicate_key',
  'feature_manifest_json_unsafe_integer',
  'feature_manifest_json_invalid_unicode',
  'feature_manifest_json_non_finite_number',
  'feature_manifest_removed_resource_key',
  'feature_manifest_unknown_field',
  'feature_manifest_schema_invalid',
  'feature_manifest_hash_mismatch',
  'feature_manifest_ownership_invalid',
  'feature_manifest_dependency_identity_duplicate',
  'feature_manifest_dependency_order_invalid',
  'feature_manifest_required_resource_identity_duplicate',
  'feature_manifest_required_resource_order_invalid',
  'feature_manifest_dynamic_resource_identity_duplicate',
  'feature_manifest_dynamic_resource_order_invalid',
  'feature_manifest_path_invalid',
  'feature_manifest_source_root_moved',
  'feature_manifest_source_root_symlink',
  'feature_manifest_source_path_symlink',
  'feature_manifest_source_hard_link',
  'feature_manifest_source_path_drift',
  'feature_manifest_source_hash_mismatch',
  'feature_manifest_dependency_unresolved',
] as const;
