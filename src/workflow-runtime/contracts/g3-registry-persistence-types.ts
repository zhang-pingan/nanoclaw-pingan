import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';
import {
  G3_REGISTRY_RESOURCE_TYPES,
  type G3RegistryResourceType,
} from './g3-registry-publish-types.js';

export { G3_REGISTRY_RESOURCE_TYPES };
export type { G3RegistryResourceType };

export const G3_REGISTRY_PERSISTENCE_FORMATS = {
  resource: 'icarus.workflow-registry-resource/1',
  closure: 'icarus.workflow-registry-dependency-closure/1',
  snapshot: 'icarus.workflow-registry-snapshot/1',
  preflightResult: 'icarus.workflow-registry-snapshot-preflight-result/1',
} as const;

export const G3_REGISTRY_DEPENDENCY_KIND = 'registry_exact' as const;
export type G3RegistryDependencyKind = typeof G3_REGISTRY_DEPENDENCY_KIND;

export interface G3RegistryResourceOwnerCore extends JsonObject {
  kind: 'core';
  ref: VersionedRef;
}

export interface G3RegistryResourceOwnerFeature extends JsonObject {
  kind: 'feature';
  feature_id: string;
}

export type G3RegistryResourceOwner =
  | G3RegistryResourceOwnerCore
  | G3RegistryResourceOwnerFeature;

export interface G3RegistryResourceDependency extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
  dependency_kind: G3RegistryDependencyKind;
}

export interface G3RegistryResourceRecord extends JsonObject {
  format: typeof G3_REGISTRY_PERSISTENCE_FORMATS.resource;
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  owner: G3RegistryResourceOwner;
  schema_ref: VersionedRef;
  schema_hash: Sha256Hash;
  content: JsonObject;
  content_hash: Sha256Hash;
  dependencies: G3RegistryResourceDependency[];
}

export interface G3RegistryResourceIdentity extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
}

export interface G3RegistryDependencyClosureManifest extends JsonObject {
  format: typeof G3_REGISTRY_PERSISTENCE_FORMATS.closure;
  ref: VersionedRef;
  schema_ref: VersionedRef;
  schema_hash: Sha256Hash;
  root_resource_type: G3RegistryResourceType;
  root_ref: VersionedRef;
  members: G3RegistryResourceIdentity[];
  member_count: number;
  closure_hash: Sha256Hash;
  manifest_hash: Sha256Hash;
}

export interface G3RegistrySnapshot extends JsonObject {
  format: typeof G3_REGISTRY_PERSISTENCE_FORMATS.snapshot;
  ref: VersionedRef;
  closure_ref: VersionedRef;
  closure_hash: Sha256Hash;
  compiler_version: string;
  snapshot_hash: Sha256Hash;
}

export interface G3RegistryPersistenceBatch extends JsonObject {
  resources: G3RegistryResourceRecord[];
  closure: G3RegistryDependencyClosureManifest;
  snapshot: G3RegistrySnapshot;
  created_at_ms: number;
}

export interface G3RegistrySnapshotPreflightInput extends JsonObject {
  snapshot_ref: VersionedRef;
  snapshot_hash: Sha256Hash;
  expected_compiler_version: string;
}

export type G3RegistrySnapshotPreflightCode =
  | 'preflight_ok'
  | 'snapshot_missing'
  | 'snapshot_identity_mismatch'
  | 'snapshot_hash_mismatch'
  | 'snapshot_binding_mismatch'
  | 'closure_missing'
  | 'closure_identity_mismatch'
  | 'closure_hash_mismatch'
  | 'closure_manifest_hash_mismatch'
  | 'closure_member_mismatch'
  | 'resource_missing'
  | 'resource_identity_mismatch'
  | 'resource_hash_mismatch'
  | 'dependency_missing'
  | 'dependency_hash_mismatch'
  | 'dependency_cycle'
  | 'snapshot_schema_invalid';

export type G3RegistrySnapshotPreflightResult =
  | {
      format: typeof G3_REGISTRY_PERSISTENCE_FORMATS.preflightResult;
      outcome: 'accepted';
      code: 'preflight_ok';
      snapshot_ref: VersionedRef;
      snapshot_hash: Sha256Hash;
      closure_hash: Sha256Hash;
      member_count: number;
      read_only: true;
    }
  | {
      format: typeof G3_REGISTRY_PERSISTENCE_FORMATS.preflightResult;
      outcome: 'rejected';
      code: Exclude<G3RegistrySnapshotPreflightCode, 'preflight_ok'>;
      snapshot_ref: VersionedRef | null;
      snapshot_hash: Sha256Hash | null;
      closure_hash: Sha256Hash | null;
      member_count: number;
      read_only: true;
    };
