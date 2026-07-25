import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import { evaluateG32AFeatureManifest } from './g3-2a-feature-manifest-intake.js';
import { validateRegistryExactResourceQueryInput } from './g3-registry-exact-resource-query.js';
import type { G3RegistryExactResourceQueryInput } from './g3-registry-exact-resource-query-types.js';
import {
  calculateRegistryResourceContentHash,
  compareAscii,
  registryResourceKey,
} from './g3-registry-persistence.js';
import type { G3RegistryResourceIdentity } from './g3-registry-persistence-types.js';
import {
  calculateG3PublishPreflightHash,
  calculateG3RegistryResourceHash,
  evaluateG3RegistryPublishPreflight,
} from './g3-registry-publish-foundation.js';
import {
  G3_CURRENT_UPSTREAM_IDENTITY,
  type G3RegistryResourceCandidate,
} from './g3-registry-publish-types.js';
import { validateRetentionExecutorAbiPreflightInput } from './g3-retention-executor-abi-preflight.js';
import {
  G3_WORKFLOW_PUBLISHER_DISPOSITIONS,
  G3_WORKFLOW_PUBLISHER_FAILURE_CODES,
  G3_WORKFLOW_PUBLISHER_FORMATS,
  type G3WorkflowPublisherApprovedReview,
  type G3WorkflowPublisherReceipt,
  type G3WorkflowPublisherRequest,
  type G3WorkflowPublisherResult,
  type G3WorkflowPublisherTargetRelease,
} from './g3-workflow-publisher-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import { assertGeneratedSchemaAuthority } from './generated-schema-authority.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_VERSION_PATTERN,
} from './versioned-ref.js';

export const G37_REQUEST_DOMAIN = 'icarus:workflow-staged-publish-request:1\n';
export const G37_DOMAIN_REQUEST_DOMAIN =
  'icarus:workflow-staged-publish-domain-request:1\n';
export const G37_APPROVED_REVIEW_DOMAIN =
  'icarus:workflow-approved-publish-review:1\n';
export const G37_TARGET_RELEASE_DOMAIN =
  'icarus:workflow-staged-feature-release:1\n';
export const G37_RECEIPT_DOMAIN = 'icarus:workflow-staged-publish-receipt:1\n';
export const G37_RESULT_DOMAIN = 'icarus:workflow-staged-publish-result:1\n';
export const G37_INVOCATION_DOMAIN = 'icarus:workflow-publisher-invocation:1\n';
export const G37_EVENT_DOMAIN = 'icarus:workflow-publisher-event:1\n';
export const G37_COMMAND_ID_DOMAIN = 'icarus:workflow-publisher-command-id:1\n';

export const G37_SCHEMA_REFS = {
  request: {
    id: 'icarus.workflow-staged-publish-request-schema',
    version: '1.0.0',
  },
  receipt: {
    id: 'icarus.workflow-staged-publish-receipt-schema',
    version: '1.0.0',
  },
  result: {
    id: 'icarus.workflow-staged-publish-result-schema',
    version: '1.0.0',
  },
} as const;

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };
const refSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: VERSIONED_REF_ID_PATTERN,
    },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: VERSIONED_REF_VERSION_PATTERN,
    },
  },
};
const identitySchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['resource_type', 'ref', 'content_hash'],
  properties: {
    resource_type: { type: 'string', minLength: 1 },
    ref: { $ref: '#/$defs/ref' },
    content_hash: hashSchema,
  },
};
const releaseResourceSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['resource', 'role'],
  properties: {
    resource: { $ref: '#/$defs/identity' },
    role: { enum: ['closure_root', 'closure_member'] },
  },
};

export const G37_REQUEST_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-staged-publish-request/1',
  title: 'WorkflowStagedPublishRequestV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'command_type',
    'idempotency_domain',
    'idempotency_key',
    'approved_review',
    'source_manifest',
    'compiled_plan',
    'contract_schemas',
    'publish_preflight',
    'release_resources',
    'compatibility_preflight',
    'target_release',
    'domain_request_hash',
    'request_hash',
  ],
  properties: {
    format: { const: G3_WORKFLOW_PUBLISHER_FORMATS.request },
    command_type: { const: 'staged_publish' },
    idempotency_domain: { type: 'string', minLength: 1, maxLength: 255 },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 512 },
    approved_review: {
      type: 'object',
      additionalProperties: false,
      required: [
        'format',
        'review_ref',
        'review_hash',
        'decision',
        'reviewer_actor_ref',
        'reviewer_auth_session_ref',
        'approved_at_ms',
        'expires_at_ms',
        'source_manifest_hash',
        'compiled_plan_hash',
        'execution_artifact_ref',
        'execution_artifact_hash',
        'closure_ref',
        'closure_hash',
        'feature_release_ref',
        'feature_release_hash',
      ],
      properties: {
        format: { const: G3_WORKFLOW_PUBLISHER_FORMATS.approvedReview },
        review_ref: { type: 'string', minLength: 1, maxLength: 512 },
        review_hash: hashSchema,
        decision: { const: 'approved' },
        reviewer_actor_ref: { const: 'human:local-owner' },
        reviewer_auth_session_ref: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
        },
        approved_at_ms: { type: 'integer', minimum: 0 },
        expires_at_ms: { type: 'integer', minimum: 0 },
        source_manifest_hash: hashSchema,
        compiled_plan_hash: hashSchema,
        execution_artifact_ref: { $ref: '#/$defs/ref' },
        execution_artifact_hash: hashSchema,
        closure_ref: { $ref: '#/$defs/ref' },
        closure_hash: hashSchema,
        feature_release_ref: { $ref: '#/$defs/ref' },
        feature_release_hash: hashSchema,
      },
    },
    source_manifest: { $ref: '#/$defs/canonical_value' },
    compiled_plan: { $ref: '#/$defs/canonical_value' },
    contract_schemas: {
      type: 'object',
      additionalProperties: false,
      required: ['request', 'receipt', 'result'],
      properties: {
        request: { type: 'object' },
        receipt: { type: 'object' },
        result: { type: 'object' },
      },
    },
    publish_preflight: { type: 'object' },
    release_resources: {
      type: 'array',
      minItems: 1,
      maxItems: 4097,
      items: { type: 'object' },
    },
    compatibility_preflight: { type: 'object' },
    target_release: {
      type: 'object',
      additionalProperties: false,
      required: [
        'feature_id',
        'release_ref',
        'release_hash',
        'execution_artifact',
        'compatibility_snapshot',
        'resources',
      ],
      properties: {
        feature_id: { type: 'string', minLength: 1, maxLength: 255 },
        release_ref: { $ref: '#/$defs/ref' },
        release_hash: hashSchema,
        execution_artifact: { $ref: '#/$defs/ref_hash' },
        compatibility_snapshot: { $ref: '#/$defs/ref_hash' },
        resources: {
          type: 'array',
          minItems: 1,
          maxItems: 4097,
          items: { $ref: '#/$defs/release_resource' },
        },
      },
    },
    domain_request_hash: hashSchema,
    request_hash: hashSchema,
  },
  $defs: {
    ref: refSchema,
    identity: identitySchema,
    release_resource: releaseResourceSchema,
    ref_hash: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'hash'],
      properties: { ref: { $ref: '#/$defs/ref' }, hash: hashSchema },
    },
    canonical_value: {
      type: 'object',
      additionalProperties: false,
      required: [
        'value_id',
        'semantic_ref',
        'content',
        'content_hash',
        'schema',
      ],
      properties: {
        value_id: { type: 'string', minLength: 1, maxLength: 512 },
        semantic_ref: { type: 'string', minLength: 1, maxLength: 1024 },
        content: { type: 'object' },
        content_hash: hashSchema,
        schema: { type: 'object' },
      },
    },
  },
};

export const G37_RECEIPT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-staged-publish-receipt/1',
  title: 'WorkflowStagedPublishReceiptV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'command_id',
    'outcome',
    'domain_request_hash',
    'feature_release_ref',
    'feature_release_hash',
    'closure_ref',
    'closure_hash',
    'execution_artifact_ref',
    'execution_artifact_hash',
    'release_resources',
    'registry_publication_count',
    'retention_handle_id',
    'failure_code',
    'active_pointer_changed',
    'receipt_hash',
  ],
  properties: {
    format: { const: G3_WORKFLOW_PUBLISHER_FORMATS.receipt },
    command_id: { type: 'string', minLength: 1 },
    outcome: { enum: ['applied', 'failed'] },
    domain_request_hash: hashSchema,
    feature_release_ref: { $ref: '#/$defs/ref' },
    feature_release_hash: hashSchema,
    closure_ref: { $ref: '#/$defs/ref' },
    closure_hash: hashSchema,
    execution_artifact_ref: { $ref: '#/$defs/ref' },
    execution_artifact_hash: hashSchema,
    release_resources: {
      type: 'array',
      minItems: 1,
      maxItems: 4097,
      items: { $ref: '#/$defs/release_resource' },
    },
    registry_publication_count: { type: 'integer', minimum: 0 },
    retention_handle_id: {
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
    },
    failure_code: {
      anyOf: [
        { enum: [...G3_WORKFLOW_PUBLISHER_FAILURE_CODES] },
        { type: 'null' },
      ],
    },
    active_pointer_changed: { const: false },
    receipt_hash: hashSchema,
  },
  $defs: {
    ref: refSchema,
    identity: identitySchema,
    release_resource: releaseResourceSchema,
  },
};

export const G37_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://icarus.local/schemas/workflow-staged-publish-result/1',
  title: 'WorkflowStagedPublishResultV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'disposition',
    'code',
    'command_id',
    'invocation_no',
    'submitted_domain_request_hash',
    'bound_domain_request_hash',
    'receipt',
    'result_hash',
  ],
  properties: {
    format: { const: G3_WORKFLOW_PUBLISHER_FORMATS.result },
    disposition: { enum: [...G3_WORKFLOW_PUBLISHER_DISPOSITIONS] },
    code: { type: 'string', minLength: 1 },
    command_id: { type: 'string', minLength: 1 },
    invocation_no: { type: 'integer', minimum: 1 },
    submitted_domain_request_hash: hashSchema,
    bound_domain_request_hash: hashSchema,
    receipt: { anyOf: [{ $ref: '#/$defs/receipt' }, { type: 'null' }] },
    result_hash: hashSchema,
  },
  $defs: {
    ref: refSchema,
    identity: identitySchema,
    release_resource: releaseResourceSchema,
    receipt: (() => {
      const schema = structuredClone(G37_RECEIPT_SCHEMA) as JsonObject;
      delete schema.$schema;
      delete schema.$id;
      delete schema.title;
      delete schema.$defs;
      return schema;
    })(),
  },
};

function schemaResourceHash(ref: VersionedRef, schema: JsonObject): Sha256Hash {
  return calculateRegistryResourceContentHash({
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref,
    content: schema,
  });
}

export const G37_SCHEMA_RESOURCE_HASHES = {
  request: schemaResourceHash(G37_SCHEMA_REFS.request, G37_REQUEST_SCHEMA),
  receipt: schemaResourceHash(G37_SCHEMA_REFS.receipt, G37_RECEIPT_SCHEMA),
  result: schemaResourceHash(G37_SCHEMA_REFS.result, G37_RESULT_SCHEMA),
} as const;

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateRequestSchema = ajv.compile(G37_REQUEST_SCHEMA as AnySchema);
const validateReceiptSchema = ajv.compile(G37_RECEIPT_SCHEMA as AnySchema);
const validateResultSchema = ajv.compile(G37_RESULT_SCHEMA as AnySchema);

const compiledPlanArtifact = strictParseJsonBytes(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      'conformance/generated-schema-join-authority-repair/compiled-scope-plan-v2-node-output-envelope-schema@1.json',
    ),
  ),
) as JsonObject;
const validateCompiledPlan = ajv.compile(
  compiledPlanArtifact.payload as AnySchema,
);

export class G3WorkflowPublisherContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'G3WorkflowPublisherContractError';
  }
}

function assertPlanGeneratedSchemaAuthorities(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertPlanGeneratedSchemaAuthorities(entry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'generated') assertGeneratedSchemaAuthority(value);
  for (const child of Object.values(value)) {
    assertPlanGeneratedSchemaAuthorities(child);
  }
}

function without<T extends JsonObject>(value: T, fields: string[]): JsonObject {
  const cloned = structuredClone(value) as JsonObject;
  for (const field of fields) delete cloned[field];
  return cloned;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function refText(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

function identityKey(identity: G3RegistryResourceIdentity): string {
  return registryResourceKey(identity);
}

function queryIdentity(
  query: G3RegistryExactResourceQueryInput,
): G3RegistryResourceIdentity {
  return {
    resource_type: query.resource_type,
    ref: query.ref,
    content_hash: query.content_hash,
  };
}

function sortIdentities(
  identities: G3RegistryResourceIdentity[],
): G3RegistryResourceIdentity[] {
  return [...identities].sort((left, right) =>
    compareAscii(identityKey(left), identityKey(right)),
  );
}

export function calculateG37ApprovedReviewHash(
  review: G3WorkflowPublisherApprovedReview,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_APPROVED_REVIEW_DOMAIN,
    without(review, ['review_hash']),
  );
}

export function calculateG37TargetReleaseHash(
  release: G3WorkflowPublisherTargetRelease,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_TARGET_RELEASE_DOMAIN,
    without(release, ['release_hash']),
  );
}

export function calculateG37DomainRequestHash(
  request: G3WorkflowPublisherRequest,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_DOMAIN_REQUEST_DOMAIN,
    without(request, [
      'idempotency_domain',
      'idempotency_key',
      'domain_request_hash',
      'request_hash',
    ]),
  );
}

export function calculateG37RequestHash(
  request: G3WorkflowPublisherRequest,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_REQUEST_DOMAIN,
    without(request, ['request_hash']),
  );
}

export function calculateG37ReceiptHash(
  receipt: G3WorkflowPublisherReceipt,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_RECEIPT_DOMAIN,
    without(receipt, ['receipt_hash']),
  );
}

export function calculateG37ResultHash(
  result: G3WorkflowPublisherResult,
): Sha256Hash {
  return domainSeparatedSha256(
    G37_RESULT_DOMAIN,
    without(result, ['result_hash']),
  );
}

export function validateG37WorkflowPublisherReceipt(
  candidate: unknown,
): asserts candidate is G3WorkflowPublisherReceipt {
  if (!(validateReceiptSchema(candidate) as boolean)) {
    throw new G3WorkflowPublisherContractError(
      'publish_request_invalid',
      ajv.errorsText(validateReceiptSchema.errors),
    );
  }
  const receipt = candidate as G3WorkflowPublisherReceipt;
  if (calculateG37ReceiptHash(receipt) !== receipt.receipt_hash) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Canonical Publisher receipt hash mismatch',
    );
  }
}

export function workflowPublisherCommandId(
  idempotencyDomain: string,
  idempotencyKey: string,
): string {
  return `publisher-command:${domainSeparatedSha256(G37_COMMAND_ID_DOMAIN, {
    idempotency_domain: idempotencyDomain,
    idempotency_key: idempotencyKey,
  }).slice(7)}`;
}

export function workflowFeatureReleaseId(ref: VersionedRef): string {
  return `feature-release:${refText(ref)}`;
}

export function workflowPublishedRetentionHandleId(
  release: VersionedRef,
  closure: VersionedRef,
): string {
  return `retention:published:${refText(release)}:${refText(closure)}`;
}

function assertContractSchemaBinding(
  query: G3RegistryExactResourceQueryInput,
  ref: VersionedRef,
  hash: Sha256Hash,
  label: string,
): void {
  if (
    query.resource_type !== 'schema' ||
    !sameRef(query.ref, ref) ||
    query.content_hash !== hash ||
    !sameRef(query.schema_ref, ref) ||
    query.schema_hash !== hash ||
    query.owner.kind !== 'core' ||
    query.publication_state !== 'published' ||
    query.dependencies.length !== 0
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      `${label} schema binding is not the exact published G3.7 schema resource`,
    );
  }
}

function assertCandidateMatchesQuery(
  candidate: G3RegistryResourceCandidate,
  query: G3RegistryExactResourceQueryInput,
): void {
  const dependencies = query.dependencies.map((dependency) => ({
    resource_type: dependency.resource_type,
    ref: dependency.ref,
    content_hash: dependency.content_hash,
  }));
  if (
    candidate.resource_type !== query.resource_type ||
    !sameRef(candidate.ref, query.ref) ||
    candidate.content_hash !== query.content_hash ||
    canonicalJson(candidate.dependencies) !== canonicalJson(dependencies)
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      `G3.1 candidate differs from G3.5 query at ${identityKey(queryIdentity(query))}`,
    );
  }
}

export function validateG37WorkflowPublisherRequest(
  candidate: unknown,
): asserts candidate is G3WorkflowPublisherRequest {
  if (!(validateRequestSchema(candidate) as boolean)) {
    throw new G3WorkflowPublisherContractError(
      'publish_request_invalid',
      ajv.errorsText(validateRequestSchema.errors),
    );
  }
  const request = candidate as G3WorkflowPublisherRequest;
  if (
    calculateG37DomainRequestHash(request) !== request.domain_request_hash ||
    calculateG37RequestHash(request) !== request.request_hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_request_hash_mismatch',
      'Publisher request or domain request hash mismatch',
    );
  }
  if (
    calculateG37ApprovedReviewHash(request.approved_review) !==
    request.approved_review.review_hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'approved_review_identity_mismatch',
      'Approved review hash mismatch',
    );
  }
  if (
    calculateG37TargetReleaseHash(request.target_release) !==
    request.target_release.release_hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Target Feature Release hash mismatch',
    );
  }

  for (const query of [
    request.source_manifest.schema,
    request.compiled_plan.schema,
    request.contract_schemas.request,
    request.contract_schemas.receipt,
    request.contract_schemas.result,
    ...request.release_resources,
  ]) {
    validateRegistryExactResourceQueryInput(query);
  }
  validateRetentionExecutorAbiPreflightInput(request.compatibility_preflight);

  assertContractSchemaBinding(
    request.contract_schemas.request,
    G37_SCHEMA_REFS.request,
    G37_SCHEMA_RESOURCE_HASHES.request,
    'request',
  );
  assertContractSchemaBinding(
    request.contract_schemas.receipt,
    G37_SCHEMA_REFS.receipt,
    G37_SCHEMA_RESOURCE_HASHES.receipt,
    'receipt',
  );
  assertContractSchemaBinding(
    request.contract_schemas.result,
    G37_SCHEMA_REFS.result,
    G37_SCHEMA_RESOURCE_HASHES.result,
    'result',
  );

  const manifestResult = evaluateG32AFeatureManifest(
    request.source_manifest.content,
  );
  if (
    manifestResult.outcome !== 'accepted' ||
    manifestResult.manifest_hash !== request.source_manifest.content_hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Source manifest is not the exact accepted canonical manifest identity',
    );
  }
  if (!(validateCompiledPlan(request.compiled_plan.content) as boolean)) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      `Compiled plan is not closed Compiled IR v2: ${ajv.errorsText(validateCompiledPlan.errors)}`,
    );
  }
  const plan = request.compiled_plan.content;
  try {
    assertPlanGeneratedSchemaAuthorities(plan);
  } catch (error) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      `Compiled plan generated schema authority is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const computedPlanHash = domainSeparatedSha256(
    'icarus:workflow-graph-plan:2\n',
    without(plan, ['plan_hash']),
  );
  if (
    plan.plan_hash !== computedPlanHash ||
    request.compiled_plan.content_hash !== computedPlanHash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Compiled plan hash mismatch',
    );
  }

  if (
    calculateG3PublishPreflightHash(request.publish_preflight) !==
    request.publish_preflight.preflight_hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'G3.1 preflight hash mismatch',
    );
  }
  for (const resource of request.publish_preflight.resources) {
    if (calculateG3RegistryResourceHash(resource) !== resource.resource_hash) {
      throw new G3WorkflowPublisherContractError(
        'publish_identity_mismatch',
        `G3.1 resource hash mismatch at ${registryResourceKey(resource as never)}`,
      );
    }
  }

  const queries = request.release_resources;
  const queryKeys = queries.map((query) => identityKey(queryIdentity(query)));
  if (
    new Set(queryKeys).size !== queryKeys.length ||
    canonicalJson(queryKeys) !==
      canonicalJson(
        [...queryKeys].sort((left, right) => compareAscii(left, right)),
      ) ||
    queries.some((query) => query.publication_state !== 'staged')
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Release resource queries must be unique, ASCII ordered, and staged',
    );
  }
  if (request.publish_preflight.resources.length !== queries.length) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'G3.1 and G3.5 resource sets have different cardinality',
    );
  }
  request.publish_preflight.resources.forEach((resource, index) =>
    assertCandidateMatchesQuery(resource, queries[index]),
  );

  const targetResources = request.target_release.resources;
  const expectedTargetResources = queries.map((query) => ({
    resource: queryIdentity(query),
    role:
      query.resource_type ===
        request.compatibility_preflight.closure.root.resource_type &&
      sameRef(query.ref, request.compatibility_preflight.closure.root.ref)
        ? ('closure_root' as const)
        : ('closure_member' as const),
  }));
  if (
    canonicalJson(targetResources) !== canonicalJson(expectedTargetResources) ||
    targetResources.filter((entry) => entry.role === 'closure_root').length !==
      1
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Target Feature Release resource set is not the exact Closure root/member set',
    );
  }

  const compatibility = request.compatibility_preflight;
  const expectedRetentionMembers = sortIdentities(
    targetResources.map((entry) => entry.resource),
  );
  if (
    canonicalJson(expectedRetentionMembers) !==
      canonicalJson(compatibility.retention.members) ||
    !sameRef(
      request.target_release.release_ref,
      compatibility.feature_release_ref,
    ) ||
    request.target_release.release_hash !==
      compatibility.feature_release_hash ||
    !sameRef(
      request.target_release.release_ref,
      compatibility.retention.feature_release_ref,
    ) ||
    request.target_release.release_hash !==
      compatibility.retention.feature_release_hash ||
    !sameRef(
      request.target_release.compatibility_snapshot.ref,
      compatibility.core_compatibility.ref,
    ) ||
    request.target_release.compatibility_snapshot.hash !==
      compatibility.core_compatibility.compatibility_hash ||
    compatibility.feature_release_execution_artifact === null ||
    !sameRef(
      request.target_release.execution_artifact.ref,
      compatibility.feature_release_execution_artifact.ref,
    ) ||
    request.target_release.execution_artifact.hash !==
      compatibility.feature_release_execution_artifact.hash
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Target Feature Release differs from G3.6 compatibility/retention identity',
    );
  }

  const preflight = request.publish_preflight;
  const planPins = preflight.resources
    .map((resource) => resource.compiled_plan_pin)
    .filter((pin) => pin !== null);
  if (
    preflight.feature_manifest_ref === null ||
    preflight.feature_manifest_hash !== request.source_manifest.content_hash ||
    request.source_manifest.semantic_ref !==
      refText(preflight.feature_manifest_ref) ||
    preflight.feature_release_ref === null ||
    !sameRef(
      preflight.feature_release_ref,
      request.target_release.release_ref,
    ) ||
    preflight.feature_release_hash !== request.target_release.release_hash ||
    planPins.length === 0 ||
    !planPins.some(
      (pin) =>
        pin.plan_ref === request.compiled_plan.semantic_ref &&
        pin.plan_hash === request.compiled_plan.content_hash,
    )
  ) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Source manifest, compiled plan, or Feature Release differs from G3.1',
    );
  }

  const manifestFeatureRef = request.source_manifest.content.feature_ref as
    | VersionedRef
    | undefined;
  const featureId = manifestFeatureRef?.id.endsWith('.feature')
    ? manifestFeatureRef.id.slice(0, -'.feature'.length)
    : null;
  if (featureId !== request.target_release.feature_id) {
    throw new G3WorkflowPublisherContractError(
      'publish_identity_mismatch',
      'Target feature_id differs from the canonical source manifest owner',
    );
  }

  const review = request.approved_review;
  if (
    review.source_manifest_hash !== request.source_manifest.content_hash ||
    review.compiled_plan_hash !== request.compiled_plan.content_hash ||
    !sameRef(
      review.execution_artifact_ref,
      request.target_release.execution_artifact.ref,
    ) ||
    review.execution_artifact_hash !==
      request.target_release.execution_artifact.hash ||
    !sameRef(review.closure_ref, compatibility.closure.ref) ||
    review.closure_hash !== compatibility.closure.closure_hash ||
    !sameRef(review.feature_release_ref, request.target_release.release_ref) ||
    review.feature_release_hash !== request.target_release.release_hash ||
    review.approved_at_ms >= review.expires_at_ms
  ) {
    throw new G3WorkflowPublisherContractError(
      'approved_review_identity_mismatch',
      'Approved review does not bind the exact Publish identity',
    );
  }
}

export function evaluateG37PublishFoundation(
  request: G3WorkflowPublisherRequest,
): ReturnType<typeof evaluateG3RegistryPublishPreflight> {
  return evaluateG3RegistryPublishPreflight(request.publish_preflight);
}

export function buildG37Receipt(
  input: Omit<G3WorkflowPublisherReceipt, 'receipt_hash'>,
): G3WorkflowPublisherReceipt {
  const receipt = {
    ...input,
    receipt_hash: `sha256:${'0'.repeat(64)}` as Sha256Hash,
  } as G3WorkflowPublisherReceipt;
  receipt.receipt_hash = calculateG37ReceiptHash(receipt);
  if (!(validateReceiptSchema(receipt) as boolean))
    throw new G3WorkflowPublisherContractError(
      'publish_request_invalid',
      ajv.errorsText(validateReceiptSchema.errors),
    );
  return receipt;
}

export function buildG37Result(
  input: Omit<G3WorkflowPublisherResult, 'result_hash'>,
): G3WorkflowPublisherResult {
  const result = {
    ...input,
    result_hash: `sha256:${'0'.repeat(64)}` as Sha256Hash,
  } as G3WorkflowPublisherResult;
  result.result_hash = calculateG37ResultHash(result);
  if (!(validateResultSchema(result) as boolean))
    throw new G3WorkflowPublisherContractError(
      'publish_request_invalid',
      ajv.errorsText(validateResultSchema.errors),
    );
  return result;
}

export function g37SchemasForTest(): {
  request: JsonObject;
  receipt: JsonObject;
  result: JsonObject;
} {
  return {
    request: structuredClone(G37_REQUEST_SCHEMA),
    receipt: structuredClone(G37_RECEIPT_SCHEMA),
    result: structuredClone(G37_RESULT_SCHEMA),
  };
}

export const G37_UPSTREAM_IDENTITIES = {
  g1_schema_root_hash: G3_CURRENT_UPSTREAM_IDENTITY.g1_schema_root_hash,
  g3_1_pack_hash:
    'sha256:54355b3c74eb311e495ea31effcbfca6e3ce7547f2ccae663805556060b0b685',
  g3_3_pack_hash:
    'sha256:746280b172ab970a953a20aaaf3dbff557fa7aaecfad6e20bcedc0a0171d72cb',
  g3_5_pack_hash:
    'sha256:0ef337e5b94dcbd279589a7522744462e7a5240e12be54cd47f6afd413675ed1',
  g3_6_pack_hash:
    'sha256:207c7604cf8157dc6e17fe4440bdb6651fed22018e094d0a4342e4dce3c1117d',
} as const;
