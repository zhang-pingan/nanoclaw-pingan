import {
  calculateRegistryResourceContentHash,
  compareAscii,
  registryClosureId,
  registryResourceId,
  registryResourceKey,
} from './g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import { g37WorkflowPublisherStoreFixtureForTest } from './g3-workflow-publisher-fixtures.js';
import {
  workflowFeatureReleaseId,
  workflowPublishedRetentionHandleId,
} from './g3-workflow-publisher.js';
import type {
  G3WorkflowPublisherApprovedReview,
  G3WorkflowPublisherInvocation,
  G3WorkflowPublisherRequest,
} from './g3-workflow-publisher-types.js';
import {
  calculateG39DomainRequestHash,
  calculateG39RequestHash,
  G39_RECEIPT_SCHEMA,
  G39_REQUEST_SCHEMA,
  G39_RESULT_SCHEMA,
  G39_SCHEMA_REFS,
  G39_SCHEMA_RESOURCE_HASHES,
} from './g3-feature-release-activation.js';
import {
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
  G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
} from './g3-retention-executor-abi-preflight.js';
import type {
  G39ActivationContractCase,
  G39ActivationFaultCase,
  G39ActivationInvocation,
  G39FeatureReleaseActivationRequest,
  G39FeatureReleaseClaim,
  G39RetentionClaim,
} from './g3-feature-release-activation-types.js';
import { canonicalJson } from './hash.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export interface G39FeatureReleaseActivationStoreFixture {
  batch: G3RegistryPersistenceBatch;
  prepublished_resource_ids: string[];
  publisher_request: G3WorkflowPublisherRequest;
  publisher_invocation: G3WorkflowPublisherInvocation;
  approved_review: G3WorkflowPublisherApprovedReview;
  activation_request: G39FeatureReleaseActivationRequest;
  activation_request_bytes: Buffer;
  activation_invocation: G39ActivationInvocation;
}

function schemaResource(
  ref: VersionedRef,
  content: JsonObject,
): G3RegistryResourceRecord {
  const contentHash = calculateRegistryResourceContentHash({
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref,
    content,
  });
  return {
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref,
    owner: {
      kind: 'core',
      ref: { id: 'icarus.core-release', version: '1.0.0' },
    },
    schema_ref: ref,
    schema_hash: contentHash,
    content,
    content_hash: contentHash,
    dependencies: [],
  };
}

function query(
  resource: G3RegistryResourceRecord,
): G3RegistryExactResourceQueryInput {
  return {
    format: 'icarus.workflow-registry-exact-resource-query/1',
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
    schema_ref: resource.schema_ref,
    schema_hash: resource.schema_hash,
    owner: resource.owner,
    publication_state: 'published',
    dependencies: resource.dependencies,
  };
}

function findSchema(
  resources: G3RegistryResourceRecord[],
  ref: VersionedRef,
): G3RegistryResourceRecord {
  const resource = resources.find(
    (entry) =>
      entry.resource_type === 'schema' &&
      entry.ref.id === ref.id &&
      entry.ref.version === ref.version,
  );
  if (!resource) throw new Error(`G3.9 fixture schema missing: ${ref.id}`);
  return resource;
}

function publishCompatibilityQueries(
  request: G39FeatureReleaseActivationRequest,
): void {
  request.compatibility_preflight.closure.root.publication_state = 'published';
  for (const entry of request.compatibility_preflight.execution_artifacts)
    entry.publication_state = 'published';
  for (const entry of request.compatibility_preflight.executor_implementations)
    entry.publication_state = 'published';
}

export function rehashG39ActivationRequest(
  request: G39FeatureReleaseActivationRequest,
): void {
  request.domain_request_hash = calculateG39DomainRequestHash(request);
  request.request_hash = calculateG39RequestHash(request);
}

export function withG39PreviousRelease(
  candidate: G39FeatureReleaseActivationRequest,
  previousRelease: G39FeatureReleaseClaim,
  previousRetention: G39RetentionClaim,
  pointerRowVersion: number,
): G39FeatureReleaseActivationRequest {
  const request = structuredClone(candidate);
  request.previous_release = previousRelease;
  request.previous_retention = previousRetention;
  request.expected_pointer = {
    state: 'present',
    row_version: pointerRowVersion,
    release: {
      release_id: previousRelease.release_id,
      ref: previousRelease.ref,
      hash: previousRelease.hash,
    },
  };
  rehashG39ActivationRequest(request);
  return request;
}

export function g39FeatureReleaseActivationStoreFixtureForTest(): G39FeatureReleaseActivationStoreFixture {
  const base = g37WorkflowPublisherStoreFixtureForTest();
  const activationSchemas = [
    schemaResource(G39_SCHEMA_REFS.request, G39_REQUEST_SCHEMA),
    schemaResource(G39_SCHEMA_REFS.receipt, G39_RECEIPT_SCHEMA),
    schemaResource(G39_SCHEMA_REFS.result, G39_RESULT_SCHEMA),
    schemaResource(
      G39_SCHEMA_REFS.compatibility_input,
      G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
    ),
    schemaResource(
      G39_SCHEMA_REFS.compatibility_result,
      G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
    ),
  ];
  for (const [key, resource] of [
    ['request', activationSchemas[0]],
    ['receipt', activationSchemas[1]],
    ['result', activationSchemas[2]],
  ] as const) {
    if (resource.content_hash !== G39_SCHEMA_RESOURCE_HASHES[key])
      throw new Error(`G3.9 ${key} schema resource identity drift`);
  }
  const resources = [...base.batch.resources, ...activationSchemas].sort(
    (left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const batch: G3RegistryPersistenceBatch = {
    ...structuredClone(base.batch),
    resources,
  };
  const compatibilityInputSchema = findSchema(
    resources,
    G39_SCHEMA_REFS.compatibility_input,
  );
  const compatibilityResultSchema = findSchema(
    resources,
    G39_SCHEMA_REFS.compatibility_result,
  );
  const compatibility = structuredClone(base.request.compatibility_preflight);
  const releaseId = workflowFeatureReleaseId(
    base.request.target_release.release_ref,
  );
  const targetResources = compatibility.retention.members.map((entry) => ({
    ...structuredClone(entry),
    role:
      entry.resource_type === compatibility.closure.root.resource_type &&
      entry.ref.id === compatibility.closure.root.ref.id &&
      entry.ref.version === compatibility.closure.root.ref.version
        ? ('closure_root' as const)
        : ('closure_member' as const),
  }));
  const activationRequest: G39FeatureReleaseActivationRequest = {
    format: 'icarus.workflow-feature-release-activation-request/1',
    command_type: 'activate_feature_release',
    idempotency_domain: 'fixture.feature-release-activation',
    idempotency_key: 'fixture.release@1.0.0',
    actor_ref: 'human:local-owner',
    auth_session_ref: 'auth-session:fixture-activation',
    requested_at_ms: base.invocation.requested_at_ms + 100,
    feature_id: base.request.target_release.feature_id,
    target_release: {
      release_id: releaseId,
      ref: base.request.target_release.release_ref,
      hash: base.request.target_release.release_hash,
      expected_lifecycle: 'staged',
      resources: targetResources,
    },
    previous_release: null,
    expected_pointer: { state: 'absent', row_version: null, release: null },
    compatibility_preflight: compatibility,
    target_retention: {
      handle_id: workflowPublishedRetentionHandleId(
        base.request.target_release.release_ref,
        compatibility.closure.ref,
      ),
      handle_kind: 'published',
      feature_release_id: releaseId,
      closure_ref: compatibility.closure.ref,
      closure_hash: compatibility.closure.closure_hash,
      expected_status: 'held',
      expected_row_version: 1,
    },
    previous_retention: null,
    contract_schemas: {
      request: query(activationSchemas[0]),
      receipt: query(activationSchemas[1]),
      result: query(activationSchemas[2]),
      compatibility_input: query(compatibilityInputSchema),
      compatibility_result: query(compatibilityResultSchema),
    },
    domain_request_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    request_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  publishCompatibilityQueries(activationRequest);
  rehashG39ActivationRequest(activationRequest);
  const activationInvocation: G39ActivationInvocation = {
    invocation_kind: 'submit',
    actor_ref: activationRequest.actor_ref,
    auth_session_ref: activationRequest.auth_session_ref,
    requested_at_ms: activationRequest.requested_at_ms,
  };
  return {
    batch,
    prepublished_resource_ids: [
      ...base.prepublished_resource_ids,
      ...activationSchemas.map(registryResourceId),
    ],
    publisher_request: structuredClone(base.request),
    publisher_invocation: structuredClone(base.invocation),
    approved_review: structuredClone(base.approved_review),
    activation_request: activationRequest,
    activation_request_bytes: Buffer.from(
      canonicalJson(activationRequest),
      'utf8',
    ),
    activation_invocation: activationInvocation,
  };
}

export function g39ActivationPositiveCases(): G39ActivationContractCase[] {
  return [
    [
      'first-applied-absent-pointer',
      'submit',
      'absent',
      'exact',
      'applied',
      'original',
      1,
    ],
    [
      'first-applied-present-pointer',
      'submit',
      'absent',
      'exact',
      'applied',
      'original',
      1,
    ],
    [
      'exact-replay-applied',
      'submit',
      'terminal_applied',
      'exact',
      'duplicate',
      'original',
      0,
    ],
    ['first-failed', 'submit', 'absent', 'exact', 'failed', null, 0],
    [
      'exact-replay-failed',
      'submit',
      'terminal_failed',
      'exact',
      'duplicate',
      null,
      0,
    ],
    [
      'same-key-domain-drift',
      'submit',
      'pending_clean',
      'drift',
      'conflict',
      null,
      0,
    ],
    [
      'repeated-domain-drift',
      'submit',
      'terminal_applied',
      'drift',
      'conflict',
      null,
      0,
    ],
    [
      'first-pointer-conflict',
      'submit',
      'absent',
      'exact',
      'conflict',
      null,
      0,
    ],
    [
      'exact-replay-pointer-conflict',
      'recovery',
      'terminal_pointer_conflict',
      'exact',
      'duplicate',
      null,
      0,
    ],
  ].map(
    ([
      case_id,
      invocation_kind,
      existing_command,
      submitted_domain,
      expected_disposition,
      expected_receipt,
      expected_pointer_transition_count,
    ]) => ({
      case_id,
      invocation_kind,
      existing_command,
      submitted_domain,
      expected_disposition,
      expected_receipt,
      expected_pointer_transition_count,
    }),
  ) as G39ActivationContractCase[];
}

export function g39ActivationFaultCases(): G39ActivationFaultCase[] {
  const rollback = [
    'after_request_value',
    'after_command_pending',
    'after_verified_preflight',
    'after_previous_draining',
    'after_target_active',
    'after_pointer_cas',
    'after_receipt',
    'after_terminal_invocation',
    'after_terminal_events',
  ].map((fault_point) => ({
    case_id: `rollback.${fault_point}`,
    fault_class: 'pre_commit' as const,
    fault_point,
    expected_outcome: 'rollback' as const,
  }));
  return [
    ...rollback,
    {
      case_id: 'post-commit-response-lost',
      fault_class: 'post_commit_recovery',
      fault_point: 'after_commit_before_response',
      expected_outcome: 'duplicate_without_pointer_dml',
    },
    {
      case_id: 'reopen-terminal-recovery',
      fault_class: 'post_commit_recovery',
      fault_point: 'reopen_after_commit',
      expected_outcome: 'duplicate_without_pointer_dml',
    },
    ...[
      'command_result_binding',
      'receipt',
      'invocation_chain',
      'event_chain',
      'result_value',
      'pending_transition_evidence',
    ].map((fault_point) => ({
      case_id: `tamper.${fault_point}`,
      fault_class: 'tamper' as const,
      fault_point,
      expected_outcome: 'fail_closed' as const,
    })),
  ];
}

export function deterministicG39FixtureDigest(): Sha256Hash {
  const fixture = g39FeatureReleaseActivationStoreFixtureForTest();
  return calculateRegistryResourceContentHash({
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref: { id: 'icarus.workflow-g3-9-fixture-digest', version: '1.0.0' },
    content: {
      request: fixture.activation_request,
      positive: g39ActivationPositiveCases(),
      fault: g39ActivationFaultCases(),
      closure_id: registryClosureId(
        fixture.activation_request.compatibility_preflight.closure.ref,
      ),
    },
  });
}
