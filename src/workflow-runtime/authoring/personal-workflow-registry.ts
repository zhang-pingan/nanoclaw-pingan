import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../contracts/hash.js';
import {
  registryResourceId,
  registrySnapshotId,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceRecord,
} from '../contracts/g3-registry-persistence-types.js';
import { strictParseJsonBytes } from '../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type { RegistryPersistenceReceipt } from '../store/registry-persistence.js';
import type {
  WorkflowRuntimeReadConnection,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { publishWorkflowBundleInTransaction } from './workflow-bundle-publisher.js';

const RELEASE_HASH_DOMAIN = 'icarus:personal-workflow-release:1\n';
const POLICY_EFFECT_ENVELOPE_HASH_DOMAIN =
  'icarus:personal-workflow-policy-effect-envelope:1\n';
const PUBLISH_REQUEST_HASH_DOMAIN =
  'icarus:personal-workflow-release-publish-request:1\n';
const ACTIVATE_REQUEST_HASH_DOMAIN =
  'icarus:personal-workflow-release-activate-request:1\n';
const OPERATION_ID_DOMAIN = 'icarus:personal-workflow-release-operation:1\n';

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,253}[A-Za-z0-9])?$/;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export class PersonalWorkflowRegistryError extends Error {
  constructor(
    readonly code:
      | 'input_invalid'
      | 'principal_owner_mismatch'
      | 'release_identity_collision'
      | 'release_resource_mismatch'
      | 'idempotency_conflict'
      | 'operation_receipt_invalid'
      | 'release_missing'
      | 'active_pointer_conflict',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'PersonalWorkflowRegistryError';
  }
}

export interface PersonalWorkflowReleasePublishRequest extends JsonObject {
  format: 'icarus.personal-workflow-release-publish-request/1';
  idempotency_domain: string;
  idempotency_key: string;
  owner_principal_ref: string;
  personal_workflow_id: string;
  release_ref: VersionedRef;
  recipe: G3RegistryResourceIdentity & { resource_type: 'recipe' };
  graph_template: G3RegistryResourceIdentity & {
    resource_type: 'graph_template';
  };
  registry_batch: G3RegistryPersistenceBatch;
  compiled_plan_hash: Sha256Hash;
  compiler_version: string;
  policy_effect_envelope: JsonObject;
  requested_at_ms: number;
}

export interface PersonalWorkflowReleaseActivateRequest extends JsonObject {
  format: 'icarus.personal-workflow-release-activate-request/1';
  idempotency_domain: string;
  idempotency_key: string;
  owner_principal_ref: string;
  personal_workflow_id: string;
  release_id: string;
  release_hash: Sha256Hash;
  expected_pointer_row_version: number | null;
  requested_at_ms: number;
}

export interface PersonalWorkflowReleasePublishResult extends JsonObject {
  format: 'icarus.personal-workflow-release-publish-result/1';
  disposition: 'applied' | 'duplicate';
  operation_id: string;
  release_id: string;
  release_hash: Sha256Hash;
  owner_principal_ref: string;
  personal_workflow_id: string;
  recipe_resource_id: string;
  graph_template_resource_id: string;
  registry_snapshot_id: string;
  registry_snapshot_hash: Sha256Hash;
  registry_persistence_disposition: RegistryPersistenceReceipt['disposition'];
  active: false;
}

export interface PersonalWorkflowReleaseActivateResult extends JsonObject {
  format: 'icarus.personal-workflow-release-activate-result/1';
  disposition: 'applied' | 'duplicate';
  operation_id: string;
  release_id: string;
  release_hash: Sha256Hash;
  owner_principal_ref: string;
  personal_workflow_id: string;
  previous_release_id: string | null;
  pointer_row_version: number;
  active: true;
}

export interface ActivePersonalWorkflowRelease extends JsonObject {
  owner_principal_ref: string;
  personal_workflow_id: string;
  release_id: string;
  release_ref: VersionedRef;
  release_hash: Sha256Hash;
  recipe_ref: VersionedRef;
  recipe_hash: Sha256Hash;
  graph_template_ref: VersionedRef;
  graph_template_hash: Sha256Hash;
  registry_snapshot_id: string;
  registry_snapshot_hash: Sha256Hash;
  compiled_plan_hash: Sha256Hash;
  compiler_version: string;
  policy_effect_envelope: JsonObject;
  pointer_row_version: number;
  activated_at_ms: number;
}

interface OperationRow extends Record<string, unknown> {
  operation_id: string;
  operation_type: string;
  request_hash: string;
  disposition: string;
  result_json: string;
}

interface ReleaseRow extends Record<string, unknown> {
  id: string;
  owner_principal_ref: string;
  personal_workflow_id: string;
  release_hash: string;
  status: string;
}

interface PointerRow extends Record<string, unknown> {
  release_id: string;
  release_hash: string;
  row_version: number;
}

function invalid(message: string): never {
  throw new PersonalWorkflowRegistryError('input_invalid', message);
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    invalid(`${label} must be a closed Registry identifier`);
  }
}

function assertVersionedRef(value: VersionedRef, label: string): void {
  assertIdentifier(value?.id, `${label}.id`);
  if (
    typeof value?.version !== 'string' ||
    !VERSION_PATTERN.test(value.version)
  ) {
    invalid(`${label}.version must be an exact version`);
  }
}

function assertSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
}

function assertCommonRequest(request: {
  idempotency_domain: string;
  idempotency_key: string;
  owner_principal_ref: string;
  personal_workflow_id: string;
  requested_at_ms: number;
}): void {
  assertIdentifier(request.idempotency_domain, 'idempotency_domain');
  assertIdentifier(request.idempotency_key, 'idempotency_key');
  assertIdentifier(request.owner_principal_ref, 'owner_principal_ref');
  assertIdentifier(request.personal_workflow_id, 'personal_workflow_id');
  assertSafeTimestamp(request.requested_at_ms, 'requested_at_ms');
}

function operationId(
  operationType: 'publish' | 'activate',
  domain: string,
  key: string,
): string {
  return `personal-operation:${domainSeparatedSha256(OPERATION_ID_DOMAIN, {
    operation_type: operationType,
    idempotency_domain: domain,
    idempotency_key: key,
  }).slice(7)}`;
}

function releaseId(
  ownerPrincipalRef: string,
  personalWorkflowId: string,
  releaseRef: VersionedRef,
): string {
  return `personal-release:${domainSeparatedSha256(RELEASE_HASH_DOMAIN, {
    owner_principal_ref: ownerPrincipalRef,
    personal_workflow_id: personalWorkflowId,
    release_ref: releaseRef,
  }).slice(7)}`;
}

function resourceMatches(
  resource: G3RegistryResourceRecord,
  identity: G3RegistryResourceIdentity,
): boolean {
  return (
    resource.resource_type === identity.resource_type &&
    resource.ref.id === identity.ref.id &&
    resource.ref.version === identity.ref.version &&
    resource.content_hash === identity.content_hash
  );
}

function cloneWithDisposition<T extends JsonObject>(
  result: T,
  disposition: 'duplicate',
): T {
  return { ...structuredClone(result), disposition } as T;
}

function parseOperationResult<T extends JsonObject>(row: OperationRow): T {
  try {
    const parsed = strictParseJsonBytes(Buffer.from(row.result_json, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      canonicalJson(parsed) !== row.result_json
    ) {
      throw new Error('operation result is not a canonical object');
    }
    return parsed as T;
  } catch (error) {
    throw new PersonalWorkflowRegistryError(
      'operation_receipt_invalid',
      `Personal Workflow operation ${row.operation_id} has an invalid receipt`,
      { cause: error },
    );
  }
}

function replayOperation<T extends JsonObject>(
  transaction: WorkflowRuntimeWriteTransaction,
  operationType: 'publish' | 'activate',
  idempotencyDomain: string,
  idempotencyKey: string,
  requestHash: Sha256Hash,
): T | null {
  const row = transaction.queryOne<OperationRow>(
    `SELECT operation_id, operation_type, request_hash, disposition, result_json
       FROM workflow_personal_release_operations
      WHERE idempotency_domain = ? AND idempotency_key = ?`,
    [idempotencyDomain, idempotencyKey],
  );
  if (!row) return null;
  if (
    row.operation_type !== operationType ||
    row.request_hash !== requestHash ||
    row.disposition !== 'applied'
  ) {
    throw new PersonalWorkflowRegistryError(
      'idempotency_conflict',
      `Personal Workflow idempotency key ${idempotencyDomain}/${idempotencyKey} is bound to another request`,
    );
  }
  return parseOperationResult<T>(row);
}

function insertAppliedOperation(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    operationType: 'publish' | 'activate';
    idempotencyDomain: string;
    idempotencyKey: string;
    ownerPrincipalRef: string;
    personalWorkflowId: string;
    releaseId: string;
    releaseHash: Sha256Hash;
    requestHash: Sha256Hash;
    result: JsonObject;
    requestedAtMs: number;
  },
): void {
  transaction.execute(
    `INSERT INTO workflow_personal_release_operations (
      operation_id, idempotency_domain, idempotency_key, operation_type,
      owner_principal_ref, personal_workflow_id, target_release_id,
      target_release_hash, request_hash, disposition, result_json, failure_code,
      requested_at_ms, completed_at_ms, row_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, NULL, ?, ?, 1)`,
    [
      operationId(
        input.operationType,
        input.idempotencyDomain,
        input.idempotencyKey,
      ),
      input.idempotencyDomain,
      input.idempotencyKey,
      input.operationType,
      input.ownerPrincipalRef,
      input.personalWorkflowId,
      input.releaseId,
      input.releaseHash,
      input.requestHash,
      canonicalJson(input.result),
      input.requestedAtMs,
      input.requestedAtMs,
    ],
  );
}

function validatePublishRequest(
  request: PersonalWorkflowReleasePublishRequest,
): {
  releaseId: string;
  releaseHash: Sha256Hash;
  policyEffectEnvelopeHash: Sha256Hash;
  requestHash: Sha256Hash;
  recipe: G3RegistryResourceRecord;
  graphTemplate: G3RegistryResourceRecord;
} {
  if (request.format !== 'icarus.personal-workflow-release-publish-request/1') {
    invalid('Personal Workflow publish format is invalid');
  }
  assertCommonRequest(request);
  assertVersionedRef(request.release_ref, 'release_ref');
  assertVersionedRef(request.recipe.ref, 'recipe.ref');
  assertVersionedRef(request.graph_template.ref, 'graph_template.ref');
  parseSha256Hash(request.recipe.content_hash);
  parseSha256Hash(request.graph_template.content_hash);
  parseSha256Hash(request.compiled_plan_hash);
  assertIdentifier(request.compiler_version, 'compiler_version');
  if (
    request.recipe.resource_type !== 'recipe' ||
    request.graph_template.resource_type !== 'graph_template'
  ) {
    invalid(
      'Personal Workflow release must bind one Recipe and Graph Template',
    );
  }
  if (
    request.registry_batch.snapshot.compiler_version !==
    request.compiler_version
  ) {
    invalid(
      'Personal Workflow compiler version must match its Registry snapshot',
    );
  }
  const recipe = request.registry_batch.resources.find((resource) =>
    resourceMatches(resource, request.recipe),
  );
  const graphTemplate = request.registry_batch.resources.find((resource) =>
    resourceMatches(resource, request.graph_template),
  );
  if (!recipe || !graphTemplate) {
    throw new PersonalWorkflowRegistryError(
      'release_resource_mismatch',
      'Personal Workflow release resources are absent from the Registry batch',
    );
  }
  for (const resource of request.registry_batch.resources) {
    if (
      resource.owner.kind !== 'principal' ||
      resource.owner.principal_ref !== request.owner_principal_ref
    ) {
      throw new PersonalWorkflowRegistryError(
        'principal_owner_mismatch',
        'Every newly published Personal Workflow resource must have the authenticated principal owner',
      );
    }
  }
  const policyEffectEnvelopeHash = domainSeparatedSha256(
    POLICY_EFFECT_ENVELOPE_HASH_DOMAIN,
    request.policy_effect_envelope,
  );
  const calculatedReleaseId = releaseId(
    request.owner_principal_ref,
    request.personal_workflow_id,
    request.release_ref,
  );
  const calculatedReleaseHash = domainSeparatedSha256(RELEASE_HASH_DOMAIN, {
    owner_principal_ref: request.owner_principal_ref,
    personal_workflow_id: request.personal_workflow_id,
    release_ref: request.release_ref,
    recipe: request.recipe,
    graph_template: request.graph_template,
    registry_snapshot_ref: request.registry_batch.snapshot.ref,
    registry_snapshot_hash: request.registry_batch.snapshot.snapshot_hash,
    compiled_plan_hash: request.compiled_plan_hash,
    compiler_version: request.compiler_version,
    policy_effect_envelope_hash: policyEffectEnvelopeHash,
  });
  const requestHash = domainSeparatedSha256(
    PUBLISH_REQUEST_HASH_DOMAIN,
    request,
  );
  return {
    releaseId: calculatedReleaseId,
    releaseHash: calculatedReleaseHash,
    policyEffectEnvelopeHash,
    requestHash,
    recipe,
    graphTemplate,
  };
}

export function publishPersonalWorkflowRelease(
  store: WorkflowRuntimeStore,
  request: PersonalWorkflowReleasePublishRequest,
): PersonalWorkflowReleasePublishResult {
  const validated = validatePublishRequest(request);
  return store.withImmediateTransaction((transaction) => {
    const replay = replayOperation<PersonalWorkflowReleasePublishResult>(
      transaction,
      'publish',
      request.idempotency_domain,
      request.idempotency_key,
      validated.requestHash,
    );
    if (replay) return cloneWithDisposition(replay, 'duplicate');

    const collision = transaction.queryOne<ReleaseRow>(
      `SELECT id, owner_principal_ref, personal_workflow_id, release_hash, status
         FROM workflow_personal_releases
        WHERE id = ? OR (owner_principal_ref = ? AND personal_workflow_id = ?
                         AND release_ref = ? AND release_version = ?)`,
      [
        validated.releaseId,
        request.owner_principal_ref,
        request.personal_workflow_id,
        request.release_ref.id,
        request.release_ref.version,
      ],
    );
    if (collision) {
      throw new PersonalWorkflowRegistryError(
        'release_identity_collision',
        `Personal Workflow release ${validated.releaseId} already exists`,
      );
    }

    const publication = publishWorkflowBundleInTransaction(transaction, {
      owner: {
        kind: 'principal',
        principal_ref: request.owner_principal_ref,
      },
      resources: request.registry_batch.resources,
      registry_batch: request.registry_batch,
      published_at_ms: request.requested_at_ms,
      publication_ref: validated.releaseId,
    });

    transaction.execute(
      `INSERT INTO workflow_personal_releases (
        id, owner_principal_ref, personal_workflow_id, release_ref, release_version,
        release_hash, recipe_resource_id, recipe_resource_hash,
        graph_template_resource_id, graph_template_resource_hash,
        registry_snapshot_id, registry_snapshot_hash, compiled_plan_hash,
        compiler_version, policy_effect_envelope_json, policy_effect_envelope_hash,
        status, published_at_ms, activated_at_ms, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inactive', ?, NULL, 1)`,
      [
        validated.releaseId,
        request.owner_principal_ref,
        request.personal_workflow_id,
        request.release_ref.id,
        request.release_ref.version,
        validated.releaseHash,
        registryResourceId(validated.recipe),
        validated.recipe.content_hash,
        registryResourceId(validated.graphTemplate),
        validated.graphTemplate.content_hash,
        registrySnapshotId(request.registry_batch.snapshot.ref),
        request.registry_batch.snapshot.snapshot_hash,
        request.compiled_plan_hash,
        request.compiler_version,
        canonicalJson(request.policy_effect_envelope),
        validated.policyEffectEnvelopeHash,
        request.requested_at_ms,
      ],
    );

    for (const resource of request.registry_batch.resources) {
      const role = resourceMatches(resource, request.recipe)
        ? 'recipe'
        : resourceMatches(resource, request.graph_template)
          ? 'graph_template'
          : 'closure_member';
      transaction.execute(
        `INSERT INTO workflow_personal_release_resources (
          release_id, resource_id, content_hash, resource_role
        ) VALUES (?, ?, ?, ?)`,
        [
          validated.releaseId,
          registryResourceId(resource),
          resource.content_hash,
          role,
        ],
      );
    }

    const result: PersonalWorkflowReleasePublishResult = {
      format: 'icarus.personal-workflow-release-publish-result/1',
      disposition: 'applied',
      operation_id: operationId(
        'publish',
        request.idempotency_domain,
        request.idempotency_key,
      ),
      release_id: validated.releaseId,
      release_hash: validated.releaseHash,
      owner_principal_ref: request.owner_principal_ref,
      personal_workflow_id: request.personal_workflow_id,
      recipe_resource_id: registryResourceId(validated.recipe),
      graph_template_resource_id: registryResourceId(validated.graphTemplate),
      registry_snapshot_id: registrySnapshotId(
        request.registry_batch.snapshot.ref,
      ),
      registry_snapshot_hash: request.registry_batch.snapshot.snapshot_hash,
      registry_persistence_disposition:
        publication.persistence_disposition === 'pre_staged'
          ? 'exact_replay'
          : publication.persistence_disposition,
      active: false,
    };
    insertAppliedOperation(transaction, {
      operationType: 'publish',
      idempotencyDomain: request.idempotency_domain,
      idempotencyKey: request.idempotency_key,
      ownerPrincipalRef: request.owner_principal_ref,
      personalWorkflowId: request.personal_workflow_id,
      releaseId: validated.releaseId,
      releaseHash: validated.releaseHash,
      requestHash: validated.requestHash,
      result,
      requestedAtMs: request.requested_at_ms,
    });
    return result;
  });
}

function validateActivateRequest(
  request: PersonalWorkflowReleaseActivateRequest,
): Sha256Hash {
  if (
    request.format !== 'icarus.personal-workflow-release-activate-request/1'
  ) {
    invalid('Personal Workflow activation format is invalid');
  }
  assertCommonRequest(request);
  assertIdentifier(request.release_id, 'release_id');
  parseSha256Hash(request.release_hash);
  if (
    request.expected_pointer_row_version !== null &&
    (!Number.isSafeInteger(request.expected_pointer_row_version) ||
      request.expected_pointer_row_version < 1)
  ) {
    invalid(
      'expected_pointer_row_version must be null or a positive safe integer',
    );
  }
  return domainSeparatedSha256(ACTIVATE_REQUEST_HASH_DOMAIN, request);
}

export function activatePersonalWorkflowRelease(
  store: WorkflowRuntimeStore,
  request: PersonalWorkflowReleaseActivateRequest,
): PersonalWorkflowReleaseActivateResult {
  const requestHash = validateActivateRequest(request);
  return store.withImmediateTransaction((transaction) => {
    const replay = replayOperation<PersonalWorkflowReleaseActivateResult>(
      transaction,
      'activate',
      request.idempotency_domain,
      request.idempotency_key,
      requestHash,
    );
    if (replay) return cloneWithDisposition(replay, 'duplicate');

    const release = transaction.queryOne<ReleaseRow>(
      `SELECT id, owner_principal_ref, personal_workflow_id, release_hash, status
         FROM workflow_personal_releases
        WHERE id = ? AND release_hash = ? AND owner_principal_ref = ?
          AND personal_workflow_id = ?`,
      [
        request.release_id,
        request.release_hash,
        request.owner_principal_ref,
        request.personal_workflow_id,
      ],
    );
    if (!release) {
      throw new PersonalWorkflowRegistryError(
        'release_missing',
        `Personal Workflow release ${request.release_id} is not owned by this principal`,
      );
    }
    const pointer = transaction.queryOne<PointerRow>(
      `SELECT release_id, release_hash, row_version
         FROM workflow_personal_active_releases
        WHERE owner_principal_ref = ? AND personal_workflow_id = ?`,
      [request.owner_principal_ref, request.personal_workflow_id],
    );
    if (
      (pointer?.row_version ?? null) !== request.expected_pointer_row_version
    ) {
      throw new PersonalWorkflowRegistryError(
        'active_pointer_conflict',
        `Personal Workflow active pointer expected ${String(request.expected_pointer_row_version)}, received ${String(pointer?.row_version ?? null)}`,
      );
    }

    const alreadyActive =
      pointer?.release_id === request.release_id &&
      pointer.release_hash === request.release_hash;
    let pointerRowVersion: number;
    if (alreadyActive) {
      pointerRowVersion = pointer.row_version;
    } else if (!pointer) {
      transaction.execute(
        `UPDATE workflow_personal_releases
            SET status = 'active', activated_at_ms = ?, row_version = row_version + 1
          WHERE id = ? AND status = 'inactive'`,
        [request.requested_at_ms, request.release_id],
      );
      transaction.execute(
        `INSERT INTO workflow_personal_active_releases (
          owner_principal_ref, personal_workflow_id, release_id, release_hash,
          row_version, activated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          request.owner_principal_ref,
          request.personal_workflow_id,
          request.release_id,
          request.release_hash,
          request.requested_at_ms,
        ],
      );
      pointerRowVersion = 1;
    } else {
      transaction.execute(
        `UPDATE workflow_personal_releases
            SET status = 'inactive', row_version = row_version + 1
          WHERE id = ? AND status = 'active'`,
        [pointer.release_id],
      );
      transaction.execute(
        `UPDATE workflow_personal_releases
            SET status = 'active', activated_at_ms = ?, row_version = row_version + 1
          WHERE id = ? AND status = 'inactive'`,
        [request.requested_at_ms, request.release_id],
      );
      const updated = transaction.execute(
        `UPDATE workflow_personal_active_releases
            SET release_id = ?, release_hash = ?, row_version = row_version + 1,
                activated_at_ms = ?
          WHERE owner_principal_ref = ? AND personal_workflow_id = ?
            AND row_version = ?`,
        [
          request.release_id,
          request.release_hash,
          request.requested_at_ms,
          request.owner_principal_ref,
          request.personal_workflow_id,
          pointer.row_version,
        ],
      );
      if (updated.changes !== 1) {
        throw new PersonalWorkflowRegistryError(
          'active_pointer_conflict',
          'Personal Workflow active pointer changed during activation',
        );
      }
      pointerRowVersion = pointer.row_version + 1;
    }

    const result: PersonalWorkflowReleaseActivateResult = {
      format: 'icarus.personal-workflow-release-activate-result/1',
      disposition: 'applied',
      operation_id: operationId(
        'activate',
        request.idempotency_domain,
        request.idempotency_key,
      ),
      release_id: request.release_id,
      release_hash: request.release_hash,
      owner_principal_ref: request.owner_principal_ref,
      personal_workflow_id: request.personal_workflow_id,
      previous_release_id: pointer?.release_id ?? null,
      pointer_row_version: pointerRowVersion,
      active: true,
    };
    insertAppliedOperation(transaction, {
      operationType: 'activate',
      idempotencyDomain: request.idempotency_domain,
      idempotencyKey: request.idempotency_key,
      ownerPrincipalRef: request.owner_principal_ref,
      personalWorkflowId: request.personal_workflow_id,
      releaseId: request.release_id,
      releaseHash: request.release_hash,
      requestHash,
      result,
      requestedAtMs: request.requested_at_ms,
    });
    return result;
  });
}

interface ActiveReleaseRow extends Record<string, unknown> {
  owner_principal_ref: string;
  personal_workflow_id: string;
  release_id: string;
  release_ref: string;
  release_version: string;
  release_hash: string;
  recipe_id: string;
  recipe_version: string;
  recipe_hash: string;
  graph_template_id: string;
  graph_template_version: string;
  graph_template_hash: string;
  registry_snapshot_id: string;
  registry_snapshot_hash: string;
  compiled_plan_hash: string;
  compiler_version: string;
  policy_effect_envelope_json: string;
  pointer_row_version: number;
  activated_at_ms: number;
}

export function queryActivePersonalWorkflowReleases(
  connection: WorkflowRuntimeReadConnection | WorkflowRuntimeStore,
  ownerPrincipalRef: string,
): ActivePersonalWorkflowRelease[] {
  assertIdentifier(ownerPrincipalRef, 'owner_principal_ref');
  return connection
    .queryAll<ActiveReleaseRow>(
      `SELECT active.owner_principal_ref, active.personal_workflow_id,
              active.release_id, release.release_ref, release.release_version,
              active.release_hash, recipe.resource_id AS recipe_id,
              recipe.resource_version AS recipe_version,
              release.recipe_resource_hash AS recipe_hash,
              graph.resource_id AS graph_template_id,
              graph.resource_version AS graph_template_version,
              release.graph_template_resource_hash AS graph_template_hash,
              release.registry_snapshot_id, release.registry_snapshot_hash,
              release.compiled_plan_hash, release.compiler_version,
              release.policy_effect_envelope_json,
              active.row_version AS pointer_row_version, active.activated_at_ms
         FROM workflow_personal_active_releases AS active
         JOIN workflow_personal_releases AS release
           ON release.id = active.release_id AND release.release_hash = active.release_hash
         JOIN workflow_registry_resources AS recipe
           ON recipe.id = release.recipe_resource_id
         JOIN workflow_registry_resources AS graph
           ON graph.id = release.graph_template_resource_id
        WHERE active.owner_principal_ref = ? AND release.status = 'active'
        ORDER BY active.personal_workflow_id COLLATE BINARY`,
      [ownerPrincipalRef],
    )
    .map((row) => {
      const policyEffectEnvelope = strictParseJsonBytes(
        Buffer.from(row.policy_effect_envelope_json, 'utf8'),
      );
      if (
        typeof policyEffectEnvelope !== 'object' ||
        policyEffectEnvelope === null ||
        Array.isArray(policyEffectEnvelope) ||
        canonicalJson(policyEffectEnvelope) !== row.policy_effect_envelope_json
      ) {
        throw new PersonalWorkflowRegistryError(
          'operation_receipt_invalid',
          `Personal Workflow release ${row.release_id} has a non-canonical policy envelope`,
        );
      }
      return {
        owner_principal_ref: row.owner_principal_ref,
        personal_workflow_id: row.personal_workflow_id,
        release_id: row.release_id,
        release_ref: { id: row.release_ref, version: row.release_version },
        release_hash: parseSha256Hash(row.release_hash),
        recipe_ref: { id: row.recipe_id, version: row.recipe_version },
        recipe_hash: parseSha256Hash(row.recipe_hash),
        graph_template_ref: {
          id: row.graph_template_id,
          version: row.graph_template_version,
        },
        graph_template_hash: parseSha256Hash(row.graph_template_hash),
        registry_snapshot_id: row.registry_snapshot_id,
        registry_snapshot_hash: parseSha256Hash(row.registry_snapshot_hash),
        compiled_plan_hash: parseSha256Hash(row.compiled_plan_hash),
        compiler_version: row.compiler_version,
        policy_effect_envelope: policyEffectEnvelope as JsonObject,
        pointer_row_version: row.pointer_row_version,
        activated_at_ms: row.activated_at_ms,
      };
    });
}
