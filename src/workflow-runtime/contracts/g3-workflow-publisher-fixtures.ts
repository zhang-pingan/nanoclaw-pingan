import fs from 'node:fs';
import path from 'node:path';

import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { calculateG32AFeatureManifestHash } from './g3-2a-feature-manifest-intake.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import {
  buildDependencyClosure,
  calculateRegistryResourceContentHash,
  calculateRegistrySnapshotHash,
  compareAscii,
  registryResourceId,
  registryResourceKey,
} from './g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import {
  calculateG3PublishPreflightHash,
  calculateG3RegistryResourceHash,
} from './g3-registry-publish-foundation.js';
import {
  G3_RETENTION_POLICY_HASH,
  G3_RETENTION_POLICY_REF,
  type G3RegistryResourceCandidate,
  type G3RegistryPublishPreflightInput,
} from './g3-registry-publish-types.js';
import { g3RetentionExecutorAbiStoreFixtureForTest } from './g3-retention-executor-abi-preflight.js';
import type { G3RetentionExecutorAbiPreflightInput } from './g3-retention-executor-abi-preflight-types.js';
import {
  calculateG37ApprovedReviewHash,
  calculateG37DomainRequestHash,
  calculateG37RequestHash,
  calculateG37TargetReleaseHash,
  G37_REQUEST_SCHEMA,
  G37_RECEIPT_SCHEMA,
  G37_RESULT_SCHEMA,
  G37_SCHEMA_REFS,
} from './g3-workflow-publisher.js';
import type {
  G3WorkflowPublisherApprovedReview,
  G3WorkflowPublisherInvocation,
  G3WorkflowPublisherRequest,
  G3WorkflowPublisherTargetRelease,
} from './g3-workflow-publisher-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, Sha256Hash, VersionedRef } from './types.js';

export interface G37WorkflowPublisherStoreFixture {
  batch: G3RegistryPersistenceBatch;
  prepublished_resource_ids: string[];
  request: G3WorkflowPublisherRequest;
  invocation: G3WorkflowPublisherInvocation;
  approved_review: G3WorkflowPublisherApprovedReview;
}

function readJson(relativePath: string): JsonObject {
  return strictParseJsonBytes(
    fs.readFileSync(path.join(import.meta.dirname, relativePath)),
  ) as JsonObject;
}

function artifactPayload(relativePath: string): JsonObject {
  const artifact = readJson(relativePath);
  return structuredClone(artifact.payload as JsonObject);
}

function goldenPlan(caseId: string): JsonObject {
  const corpus = readJson('../compiler/golden/cases@1.json');
  const cases = corpus.cases;
  if (!Array.isArray(cases)) throw new Error('Golden corpus cases are missing');
  const goldenCase = cases.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      entry.case_id === caseId,
  ) as JsonObject | undefined;
  const expected = goldenCase?.expected_result;
  if (
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(expected) ||
    typeof expected.normalized_plan !== 'object' ||
    expected.normalized_plan === null ||
    Array.isArray(expected.normalized_plan)
  ) {
    throw new Error(`Golden plan is missing: ${caseId}`);
  }
  return structuredClone(expected.normalized_plan as JsonObject);
}

function resourceIdentity(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceIdentity {
  return {
    resource_type: resource.resource_type,
    ref: resource.ref,
    content_hash: resource.content_hash,
  };
}

function dependency(
  resource: G3RegistryResourceRecord,
): G3RegistryResourceRecord['dependencies'][number] {
  return {
    ...resourceIdentity(resource),
    dependency_kind: 'registry_exact',
  };
}

function query(
  resource: G3RegistryResourceRecord,
  publicationState: 'staged' | 'published',
): G3RegistryExactResourceQueryInput {
  return {
    format: 'icarus.workflow-registry-exact-resource-query/1',
    ...resourceIdentity(resource),
    schema_ref: resource.schema_ref,
    schema_hash: resource.schema_hash,
    owner: resource.owner,
    publication_state: publicationState,
    dependencies: resource.dependencies,
  };
}

function schemaResource(
  ref: VersionedRef,
  content: JsonObject,
): G3RegistryResourceRecord {
  const record: G3RegistryResourceRecord = {
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref,
    owner: {
      kind: 'core',
      ref: { id: 'icarus.core-release', version: '1.0.0' },
    },
    schema_ref: ref,
    schema_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    content,
    content_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    dependencies: [],
  };
  record.content_hash = calculateRegistryResourceContentHash(record);
  record.schema_hash = record.content_hash;
  return record;
}

function featureResource(
  resourceType: G3RegistryResourceRecord['resource_type'],
  ref: VersionedRef,
  content: JsonObject,
  schema: G3RegistryResourceRecord,
  dependencies: G3RegistryResourceRecord[],
): G3RegistryResourceRecord {
  const record: G3RegistryResourceRecord = {
    format: 'icarus.workflow-registry-resource/1',
    resource_type: resourceType,
    ref,
    owner: { kind: 'feature', feature_id: 'fixture.feature' },
    schema_ref: schema.ref,
    schema_hash: schema.content_hash,
    content,
    content_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    dependencies: dependencies
      .map(dependency)
      .sort((left, right) =>
        compareAscii(registryResourceKey(left), registryResourceKey(right)),
      ),
  };
  record.content_hash = calculateRegistryResourceContentHash(record);
  return record;
}

function planPin(
  plan: JsonObject,
): NonNullable<G3RegistryResourceCandidate['compiled_plan_pin']> {
  return {
    plan_ref: 'compiler/golden/cases@1.json#positive.static-lowering',
    plan_hash: plan.plan_hash as Sha256Hash,
    plan_format: 'icarus.workflow-graph-scope-plan/2',
    compiler_version: WORKFLOW_COMPILER_VERSION,
    provenance: 'golden_corpus',
  };
}

function candidate(
  resource: G3RegistryResourceRecord,
  plan: JsonObject,
): G3RegistryResourceCandidate {
  const artifactContent = resource.content;
  const compiled =
    resource.resource_type === 'definition' ? planPin(plan) : null;
  const execution =
    resource.resource_type === 'feature_execution_artifact'
      ? {
          ref: resource.ref,
          artifact_hash: artifactContent.artifact_hash as Sha256Hash,
          runtime_kind: 'node_bundle' as const,
          runtime_abi_major: 1 as const,
        }
      : resource.resource_type === 'executor_implementation'
        ? {
            ref: artifactContent.execution_artifact_ref as VersionedRef,
            artifact_hash:
              'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as Sha256Hash,
            runtime_kind: 'node_bundle' as const,
            runtime_abi_major: 1 as const,
          }
        : null;
  const value: G3RegistryResourceCandidate = {
    resource_type: resource.resource_type,
    ref: resource.ref,
    launchability: 'test_only',
    content_hash: resource.content_hash,
    dependencies: resource.dependencies.map((entry) => ({
      resource_type: entry.resource_type,
      ref: entry.ref,
      content_hash: entry.content_hash,
    })),
    compiled_plan_pin: compiled,
    execution_artifact_pin: execution,
    capability_outbox_binding: null,
    resource_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  value.resource_hash = calculateG3RegistryResourceHash(value);
  return value;
}

function identityKey(identity: G3RegistryResourceIdentity): string {
  return registryResourceKey(identity);
}

function sourceManifest(
  publishResources: G3RegistryResourceRecord[],
): JsonObject {
  const allowedKinds = new Set([
    'definition',
    'executor_implementation',
    'recipe',
    'schema',
  ]);
  const entries = publishResources
    .filter(
      (resource) =>
        resource.owner.kind === 'feature' &&
        allowedKinds.has(resource.resource_type),
    )
    .map((resource) => ({
      kind: resource.resource_type,
      ref: resource.ref,
      source_path: `workflow-src/${resource.resource_type}/${resource.ref.id}.json`,
      expected_source_hash: resource.content_hash,
    }))
    .sort((left, right) =>
      compareAscii(
        `${left.kind}\0${left.ref.id}\0${left.ref.version}`,
        `${right.kind}\0${right.ref.id}\0${right.ref.version}`,
      ),
    );
  const manifest: JsonObject = {
    format: 'icarus.feature-manifest/2',
    feature_ref: { id: 'fixture.feature', version: '1.0.0' },
    namespace: 'fixture',
    owner_principal_ref: 'human:local-owner',
    dependencies: [],
    package_resources: {
      skills: [],
      agents: [],
      mcp: [],
      scripts: [],
      templates: [],
    },
    extension_surfaces: {
      api_entry: null,
      nav_entry: null,
      renderer_entry: null,
    },
    dynamic_workflow_resources: entries,
    ownership: {
      feature_source_root: 'features/fixture',
      workflow_source_root: 'features/fixture/workflow-src',
      execution_bundle_owner: 'feature_release',
      registry_namespace: 'fixture',
    },
    lifecycle: {
      draining_policy_ref: { id: 'fixture.draining-policy', version: '1.0.0' },
      retention_policy_ref: G3_RETENTION_POLICY_REF,
      deletion_policy_ref: { id: 'fixture.deletion-policy', version: '1.0.0' },
    },
    manifest_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest as never);
  return manifest;
}

function updateCompatibilityInput(
  base: G3RetentionExecutorAbiPreflightInput,
  batch: G3RegistryPersistenceBatch,
  releaseResources: G3RegistryExactResourceQueryInput[],
): G3RetentionExecutorAbiPreflightInput {
  const resourceByKey = new Map(
    batch.resources.map((resource) => [
      registryResourceKey(resource),
      resource,
    ]),
  );
  const root = resourceByKey.get(
    `${batch.closure.root_resource_type}\0${batch.closure.root_ref.id}@${batch.closure.root_ref.version}`,
  );
  if (!root) throw new Error('G3.7 fixture Closure root missing');
  const executionArtifacts = releaseResources.filter(
    (entry) => entry.resource_type === 'feature_execution_artifact',
  );
  const executors = releaseResources.filter(
    (entry) => entry.resource_type === 'executor_implementation',
  );
  const retentionMembers = releaseResources
    .map((entry) => ({
      resource_type: entry.resource_type,
      ref: entry.ref,
      content_hash: entry.content_hash,
    }))
    .sort((left, right) => compareAscii(identityKey(left), identityKey(right)));
  return {
    ...structuredClone(base),
    snapshot: {
      snapshot_ref: batch.snapshot.ref,
      snapshot_hash: batch.snapshot.snapshot_hash,
      expected_compiler_version: batch.snapshot.compiler_version,
    },
    closure: {
      ref: batch.closure.ref,
      closure_hash: batch.closure.closure_hash,
      root: query(root, 'staged'),
      members: batch.closure.members,
      member_count: batch.closure.member_count,
    },
    execution_artifacts: executionArtifacts,
    executor_implementations: executors,
    retention: {
      ...structuredClone(base.retention),
      members: retentionMembers,
    },
  };
}

export function g37WorkflowPublisherStoreFixtureForTest(): G37WorkflowPublisherStoreFixture {
  const base = g3RetentionExecutorAbiStoreFixtureForTest();
  const plan = goldenPlan('positive.static-lowering');
  const original = structuredClone(base.batch.resources);
  const genericSchema = original.find(
    (resource) => resource.resource_type === 'schema',
  );
  const recipe = original.find(
    (resource) => resource.resource_type === 'recipe',
  );
  if (!genericSchema || !recipe)
    throw new Error('G3.7 fixture base resources are incomplete');

  const definition = featureResource(
    'definition',
    { id: 'fixture.definition', version: '1.0.0' },
    {
      format: 'icarus.workflow-definition-published-plan/1',
      plan_ref: planPin(plan).plan_ref,
      plan_hash: plan.plan_hash,
    },
    genericSchema,
    [genericSchema],
  );
  recipe.dependencies = [...recipe.dependencies, dependency(definition)].sort(
    (left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );

  const requestSchema = schemaResource(
    G37_SCHEMA_REFS.request,
    G37_REQUEST_SCHEMA,
  );
  const receiptSchema = schemaResource(
    G37_SCHEMA_REFS.receipt,
    G37_RECEIPT_SCHEMA,
  );
  const resultSchema = schemaResource(
    G37_SCHEMA_REFS.result,
    G37_RESULT_SCHEMA,
  );
  const manifestSchemaArtifact = readJson(
    'schemas/feature-manifest-v2-schema.json',
  );
  const manifestSchema = schemaResource(
    manifestSchemaArtifact.ref as VersionedRef,
    manifestSchemaArtifact.payload as JsonObject,
  );
  const planSchemaArtifact = readJson(
    'conformance/capability-outbox-execution-binding/schemas/compiled-scope-plan-v2-execution-binding-schema@1.json',
  );
  const planSchema = schemaResource(
    planSchemaArtifact.ref as VersionedRef,
    planSchemaArtifact.payload as JsonObject,
  );
  const prepublished = [
    requestSchema,
    receiptSchema,
    resultSchema,
    manifestSchema,
    planSchema,
  ];

  const publishResources = [...original, definition].sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const allResources = [...publishResources, ...prepublished].sort(
    (left, right) =>
      compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const closure = buildDependencyClosure(
    allResources,
    { resource_type: recipe.resource_type, ref: recipe.ref },
    base.batch.closure.ref,
    { ...genericSchema.ref, hash: genericSchema.content_hash },
  );
  const snapshotWithoutHash = {
    ...structuredClone(base.batch.snapshot),
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
  };
  delete (snapshotWithoutHash as Partial<typeof snapshotWithoutHash>)
    .snapshot_hash;
  const snapshot = {
    ...snapshotWithoutHash,
    snapshot_hash: calculateRegistrySnapshotHash(snapshotWithoutHash),
  };
  const batch: G3RegistryPersistenceBatch = {
    resources: allResources,
    closure,
    snapshot,
    created_at_ms: base.batch.created_at_ms,
  };
  const releaseResourceRecords = [
    recipe,
    ...closure.members.map((member) => {
      const record = allResources.find(
        (resource) =>
          registryResourceKey(resource) === registryResourceKey(member),
      );
      if (!record) throw new Error('G3.7 fixture Closure member missing');
      return record;
    }),
  ].sort((left, right) =>
    compareAscii(registryResourceKey(left), registryResourceKey(right)),
  );
  const releaseResources = releaseResourceRecords.map((resource) =>
    query(resource, 'staged'),
  );
  let compatibility = updateCompatibilityInput(
    base.input,
    batch,
    releaseResources,
  );

  const manifest = sourceManifest(publishResources);
  const manifestRef = {
    id: 'fixture.feature-manifest',
    version: '2.0.0',
  };
  const publishCandidates = releaseResourceRecords.map((resource) =>
    candidate(resource, plan),
  );
  let publishPreflight: G3RegistryPublishPreflightInput = {
    format: 'icarus.workflow-registry-publish-preflight/1',
    operation: 'validate_only',
    target_registry: 'test_only',
    fixture_scope: 'test_only',
    feature_manifest_ref: manifestRef,
    feature_manifest_hash: manifest.manifest_hash as Sha256Hash,
    feature_release_ref: compatibility.feature_release_ref,
    feature_release_hash: compatibility.feature_release_hash,
    resources: publishCandidates,
    expected_oracle: 'golden_corpus_expected',
    production_compiler_actual_role: 'comparison_only',
    retention_policy_ref: structuredClone(G3_RETENTION_POLICY_REF),
    retention_policy_hash: G3_RETENTION_POLICY_HASH,
    compatibility: {
      run_protocol_major: 1,
      executor_abi_major: 1,
      registry_schema_version: 1,
    },
    requested_registry_write: false,
    requested_activation: false,
    preflight_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };

  const targetReleaseWithoutHash: G3WorkflowPublisherTargetRelease = {
    feature_id: 'fixture',
    release_ref: compatibility.feature_release_ref,
    release_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    execution_artifact: compatibility.feature_release_execution_artifact!,
    compatibility_snapshot: {
      ref: compatibility.snapshot.snapshot_ref,
      hash: compatibility.snapshot.snapshot_hash,
    },
    resources: releaseResources.map((entry) => ({
      resource: {
        resource_type: entry.resource_type,
        ref: entry.ref,
        content_hash: entry.content_hash,
      },
      role:
        entry.resource_type === compatibility.closure.root.resource_type &&
        entry.ref.id === compatibility.closure.root.ref.id &&
        entry.ref.version === compatibility.closure.root.ref.version
          ? 'closure_root'
          : 'closure_member',
    })),
  };
  targetReleaseWithoutHash.release_hash = calculateG37TargetReleaseHash(
    targetReleaseWithoutHash,
  );
  compatibility.feature_release_hash = targetReleaseWithoutHash.release_hash;
  compatibility.retention.feature_release_hash =
    targetReleaseWithoutHash.release_hash;
  publishPreflight.feature_release_hash = targetReleaseWithoutHash.release_hash;
  publishPreflight.preflight_hash =
    calculateG3PublishPreflightHash(publishPreflight);

  const review: G3WorkflowPublisherApprovedReview = {
    format: 'icarus.workflow-approved-publish-review/1',
    review_ref: 'workflow-review:fixture-release-1',
    review_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    decision: 'approved',
    reviewer_actor_ref: 'human:local-owner',
    reviewer_auth_session_ref: 'auth-session:fixture-review',
    approved_at_ms: 1784604172000,
    expires_at_ms: 1784607772000,
    source_manifest_hash: manifest.manifest_hash as Sha256Hash,
    compiled_plan_hash: plan.plan_hash as Sha256Hash,
    execution_artifact_ref: targetReleaseWithoutHash.execution_artifact.ref,
    execution_artifact_hash: targetReleaseWithoutHash.execution_artifact.hash,
    closure_ref: closure.ref,
    closure_hash: closure.closure_hash,
    feature_release_ref: targetReleaseWithoutHash.release_ref,
    feature_release_hash: targetReleaseWithoutHash.release_hash,
  };
  review.review_hash = calculateG37ApprovedReviewHash(review);

  const request: G3WorkflowPublisherRequest = {
    format: 'icarus.workflow-staged-publish-request/1',
    command_type: 'staged_publish',
    idempotency_domain: 'fixture.publisher',
    idempotency_key: 'release-1.0.0',
    approved_review: review,
    source_manifest: {
      value_id: 'publisher-source-manifest:fixture@1.0.0',
      semantic_ref: `${manifestRef.id}@${manifestRef.version}`,
      content: manifest,
      content_hash: manifest.manifest_hash as Sha256Hash,
      schema: query(manifestSchema, 'published'),
    },
    compiled_plan: {
      value_id: 'publisher-compiled-plan:fixture@1.0.0',
      semantic_ref: planPin(plan).plan_ref,
      content: plan,
      content_hash: plan.plan_hash as Sha256Hash,
      schema: query(planSchema, 'published'),
    },
    contract_schemas: {
      request: query(requestSchema, 'published'),
      receipt: query(receiptSchema, 'published'),
      result: query(resultSchema, 'published'),
    },
    publish_preflight: publishPreflight,
    release_resources: releaseResources,
    compatibility_preflight: compatibility,
    target_release: targetReleaseWithoutHash,
    domain_request_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    request_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  request.domain_request_hash = calculateG37DomainRequestHash(request);
  request.request_hash = calculateG37RequestHash(request);

  return {
    batch,
    prepublished_resource_ids: prepublished.map(registryResourceId),
    request,
    invocation: {
      invocation_kind: 'submit',
      actor_ref: 'human:local-owner',
      auth_session_ref: review.reviewer_auth_session_ref,
      requested_at_ms: 1784604173000,
    },
    approved_review: review,
  };
}
