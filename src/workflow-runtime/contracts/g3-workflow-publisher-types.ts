import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import type { G3RegistryResourceIdentity } from './g3-registry-persistence-types.js';
import type { G3RegistryPublishPreflightInput } from './g3-registry-publish-types.js';
import type { G3RetentionExecutorAbiPreflightInput } from './g3-retention-executor-abi-preflight-types.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export const G3_WORKFLOW_PUBLISHER_FORMATS = {
  request: 'icarus.workflow-staged-publish-request/1',
  approvedReview: 'icarus.workflow-approved-publish-review/1',
  receipt: 'icarus.workflow-staged-publish-receipt/1',
  result: 'icarus.workflow-staged-publish-result/1',
} as const;

export const G3_WORKFLOW_PUBLISHER_DISPOSITIONS = [
  'applied',
  'duplicate',
  'conflict',
  'failed',
] as const;

export type G3WorkflowPublisherDisposition =
  (typeof G3_WORKFLOW_PUBLISHER_DISPOSITIONS)[number];

export const G3_WORKFLOW_PUBLISHER_FAILURE_CODES = [
  'approved_review_invalid',
  'approved_review_expired',
  'approved_review_identity_mismatch',
  'caller_review_session_mismatch',
  'publish_request_invalid',
  'publish_request_hash_mismatch',
  'publish_identity_mismatch',
  'publish_foundation_preflight_failed',
  'registry_resource_preflight_failed',
  'retention_executor_abi_preflight_failed',
  'feature_release_identity_collision',
  'registry_publication_collision',
  'retention_root_identity_collision',
  'idempotency_conflict',
  'publisher_transaction_failed',
] as const;

export type G3WorkflowPublisherFailureCode =
  (typeof G3_WORKFLOW_PUBLISHER_FAILURE_CODES)[number];

export interface G3WorkflowPublisherInvocation extends JsonObject {
  invocation_kind: 'submit' | 'recovery';
  actor_ref: string;
  auth_session_ref: string;
  requested_at_ms: number;
}

export interface G3WorkflowPublisherApprovedReview extends JsonObject {
  format: typeof G3_WORKFLOW_PUBLISHER_FORMATS.approvedReview;
  review_ref: string;
  review_hash: Sha256Hash;
  decision: 'approved';
  reviewer_actor_ref: 'human:local-owner';
  reviewer_auth_session_ref: string;
  approved_at_ms: number;
  expires_at_ms: number;
  source_manifest_hash: Sha256Hash;
  compiled_plan_hash: Sha256Hash;
  execution_artifact_ref: VersionedRef;
  execution_artifact_hash: Sha256Hash;
  closure_ref: VersionedRef;
  closure_hash: Sha256Hash;
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
}

export interface G3WorkflowPublisherCanonicalValue extends JsonObject {
  value_id: string;
  semantic_ref: string;
  content: JsonObject;
  content_hash: Sha256Hash;
  schema: G3RegistryExactResourceQueryInput;
}

export interface G3WorkflowPublisherContractSchemas extends JsonObject {
  request: G3RegistryExactResourceQueryInput;
  receipt: G3RegistryExactResourceQueryInput;
  result: G3RegistryExactResourceQueryInput;
}

export interface G3WorkflowPublisherReleaseResource extends JsonObject {
  resource: G3RegistryResourceIdentity;
  role: 'closure_root' | 'closure_member';
}

export interface G3WorkflowPublisherTargetRelease extends JsonObject {
  feature_id: string;
  release_ref: VersionedRef;
  release_hash: Sha256Hash;
  execution_artifact: {
    ref: VersionedRef;
    hash: Sha256Hash;
  };
  compatibility_snapshot: {
    ref: VersionedRef;
    hash: Sha256Hash;
  };
  resources: G3WorkflowPublisherReleaseResource[];
}

export interface G3WorkflowPublisherRequest extends JsonObject {
  format: typeof G3_WORKFLOW_PUBLISHER_FORMATS.request;
  command_type: 'staged_publish';
  idempotency_domain: string;
  idempotency_key: string;
  approved_review: G3WorkflowPublisherApprovedReview;
  source_manifest: G3WorkflowPublisherCanonicalValue;
  compiled_plan: G3WorkflowPublisherCanonicalValue;
  contract_schemas: G3WorkflowPublisherContractSchemas;
  publish_preflight: G3RegistryPublishPreflightInput;
  release_resources: G3RegistryExactResourceQueryInput[];
  compatibility_preflight: G3RetentionExecutorAbiPreflightInput;
  target_release: G3WorkflowPublisherTargetRelease;
  domain_request_hash: Sha256Hash;
  request_hash: Sha256Hash;
}

export interface G3WorkflowPublisherReceipt extends JsonObject {
  format: typeof G3_WORKFLOW_PUBLISHER_FORMATS.receipt;
  command_id: string;
  outcome: 'applied' | 'failed';
  domain_request_hash: Sha256Hash;
  feature_release_ref: VersionedRef;
  feature_release_hash: Sha256Hash;
  closure_ref: VersionedRef;
  closure_hash: Sha256Hash;
  execution_artifact_ref: VersionedRef;
  execution_artifact_hash: Sha256Hash;
  release_resources: G3WorkflowPublisherReleaseResource[];
  registry_publication_count: number;
  retention_handle_id: string | null;
  failure_code: G3WorkflowPublisherFailureCode | null;
  active_pointer_changed: false;
  receipt_hash: Sha256Hash;
}

export interface G3WorkflowPublisherResult extends JsonObject {
  format: typeof G3_WORKFLOW_PUBLISHER_FORMATS.result;
  disposition: G3WorkflowPublisherDisposition;
  code:
    | 'staged_publish_applied'
    | 'staged_publish_duplicate'
    | G3WorkflowPublisherFailureCode;
  command_id: string;
  invocation_no: number;
  submitted_domain_request_hash: Sha256Hash;
  bound_domain_request_hash: Sha256Hash;
  receipt: G3WorkflowPublisherReceipt | null;
  result_hash: Sha256Hash;
}

export interface G3WorkflowPublisherContractFixture extends JsonObject {
  case_id: string;
  request: G3WorkflowPublisherRequest;
  invocation: G3WorkflowPublisherInvocation;
  expected_disposition: G3WorkflowPublisherDisposition;
  expected_code: string;
}
