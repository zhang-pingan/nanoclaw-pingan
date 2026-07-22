import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';
import type {
  G3RegistryResourceDependency,
  G3RegistryResourceOwner,
  G3RegistryResourceType,
} from './g3-registry-persistence-types.js';

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS = {
  profile: 'icarus.workflow-registry-exact-resource-query-profile/1',
  input: 'icarus.workflow-registry-exact-resource-query/1',
  result: 'icarus.workflow-registry-exact-resource-query-result/1',
} as const;

export const G3_REGISTRY_PUBLICATION_STATES = [
  'staged',
  'published',
  'retired',
] as const;

export type G3RegistryPublicationState =
  (typeof G3_REGISTRY_PUBLICATION_STATES)[number];

export const G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE = [
  'query_input_invalid',
  'resource_missing',
  'resource_hash_mismatch',
  'resource_value_missing',
  'resource_value_mismatch',
  'resource_schema_binding_mismatch',
  'resource_owner_mismatch',
  'resource_publication_state_mismatch',
  'resource_dependency_mismatch',
] as const;

export type G3RegistryExactResourceQueryErrorCode =
  (typeof G3_REGISTRY_EXACT_RESOURCE_QUERY_ERROR_PRECEDENCE)[number];

export type G3RegistryExactResourceQueryCode =
  | 'exact_resource_query_ok'
  | G3RegistryExactResourceQueryErrorCode;

export interface G3RegistryExactResourceQueryProfile extends JsonObject {
  format: typeof G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.profile;
  ref: VersionedRef;
  query_identity: 'resource_type_ref_content_hash';
  resolution_mode: 'exact_only';
  value_validation: 'canonical_inline_value_and_content_hash';
  schema_validation: 'exact_resource_and_value_binding';
  owner_validation: 'exact_owner';
  publication_validation: 'exact_state';
  dependency_validation: 'exact_ordered_rows_and_target_hashes';
  error_precedence: G3RegistryExactResourceQueryErrorCode[];
  result_schema: 'closed';
  read_only: true;
  launchability_inference: false;
}

export interface G3RegistryExactResourceQueryInput extends JsonObject {
  format: typeof G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.input;
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
  schema_ref: VersionedRef;
  schema_hash: Sha256Hash;
  owner: G3RegistryResourceOwner;
  publication_state: G3RegistryPublicationState;
  dependencies: G3RegistryResourceDependency[];
}

export interface G3RegistryExactResourceQueryRecord extends JsonObject {
  resource_type: G3RegistryResourceType;
  ref: VersionedRef;
  content_hash: Sha256Hash;
  schema_ref: VersionedRef;
  schema_hash: Sha256Hash;
  owner: G3RegistryResourceOwner;
  publication_state: G3RegistryPublicationState;
  dependencies: G3RegistryResourceDependency[];
  content: JsonObject;
}

export type G3RegistryExactResourceQueryResult =
  | {
      format: typeof G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result;
      outcome: 'accepted';
      code: 'exact_resource_query_ok';
      resource_type: G3RegistryResourceType;
      ref: VersionedRef;
      content_hash: Sha256Hash;
      resource: G3RegistryExactResourceQueryRecord;
      read_only: true;
    }
  | {
      format: typeof G3_REGISTRY_EXACT_RESOURCE_QUERY_FORMATS.result;
      outcome: 'rejected';
      code: G3RegistryExactResourceQueryErrorCode;
      resource_type: G3RegistryResourceType | null;
      ref: VersionedRef | null;
      content_hash: Sha256Hash | null;
      resource: null;
      read_only: true;
    };
