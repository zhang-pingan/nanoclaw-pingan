import {
  registryClosureId,
  registryResourceId,
  registrySnapshotId,
} from '../contracts/g3-registry-persistence.js';
import type {
  G3RegistryPersistenceBatch,
  G3RegistryResourceIdentity,
  G3RegistryResourceOwner,
} from '../contracts/g3-registry-persistence-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  persistRegistryPersistenceBatchInTransaction,
  type RegistryPersistenceReceipt,
} from '../store/registry-persistence.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';

export interface WorkflowBundlePublicationRequest {
  readonly owner: G3RegistryResourceOwner;
  readonly resources: readonly G3RegistryResourceIdentity[];
  readonly registry_batch?: G3RegistryPersistenceBatch;
  readonly published_at_ms: number;
  readonly publication_ref: string;
}

export interface WorkflowBundlePublicationReceipt extends JsonObject {
  readonly format: 'icarus.workflow-bundle-publication-receipt/1';
  readonly publication_ref: string;
  readonly owner: G3RegistryResourceOwner;
  readonly resource_ids: string[];
  readonly closure_id: string | null;
  readonly closure_hash: Sha256Hash | null;
  readonly snapshot_id: string | null;
  readonly snapshot_hash: Sha256Hash | null;
  readonly persistence_disposition:
    | RegistryPersistenceReceipt['disposition']
    | 'pre_staged';
  readonly disposition: 'published' | 'exact_replay';
  readonly receipt_hash: Sha256Hash;
}

type WorkflowBundlePublicationReceiptWithoutHash = {
  readonly format: 'icarus.workflow-bundle-publication-receipt/1';
  readonly publication_ref: string;
  readonly owner: G3RegistryResourceOwner;
  readonly resource_ids: string[];
  readonly closure_id: string | null;
  readonly closure_hash: Sha256Hash | null;
  readonly snapshot_id: string | null;
  readonly snapshot_hash: Sha256Hash | null;
  readonly persistence_disposition:
    | RegistryPersistenceReceipt['disposition']
    | 'pre_staged';
  readonly disposition: 'published' | 'exact_replay';
};

export class WorkflowBundlePublisherError extends Error {
  constructor(
    readonly code:
      | 'bundle_invalid'
      | 'bundle_owner_mismatch'
      | 'bundle_publication_collision',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowBundlePublisherError';
  }
}

function ownerColumns(owner: G3RegistryResourceOwner): {
  sql: string;
  values: WorkflowRuntimeSqlValue[];
} {
  switch (owner.kind) {
    case 'core':
      return {
        sql: 'owner_core_ref = ? AND owner_pack_id IS NULL AND owner_principal_ref IS NULL',
        values: [`${owner.ref.id}@${owner.ref.version}`],
      };
    case 'pack':
      return {
        sql: 'owner_core_ref IS NULL AND owner_pack_id = ? AND owner_principal_ref IS NULL',
        values: [owner.pack_id],
      };
    case 'principal':
      return {
        sql: 'owner_core_ref IS NULL AND owner_pack_id IS NULL AND owner_principal_ref = ?',
        values: [owner.principal_ref],
      };
  }
}

function receiptWithoutHash(input: {
  request: WorkflowBundlePublicationRequest;
  persistence: RegistryPersistenceReceipt | null;
  disposition: WorkflowBundlePublicationReceipt['disposition'];
}): WorkflowBundlePublicationReceiptWithoutHash {
  const batch = input.request.registry_batch;
  return {
    format: 'icarus.workflow-bundle-publication-receipt/1',
    publication_ref: input.request.publication_ref,
    owner: input.request.owner,
    resource_ids: input.request.resources.map(registryResourceId).sort(),
    closure_id: batch ? registryClosureId(batch.closure.ref) : null,
    closure_hash: batch?.closure.closure_hash ?? null,
    snapshot_id: batch ? registrySnapshotId(batch.snapshot.ref) : null,
    snapshot_hash: batch?.snapshot.snapshot_hash ?? null,
    persistence_disposition: input.persistence?.disposition ?? 'pre_staged',
    disposition: input.disposition,
  };
}

export function publishWorkflowBundleInTransaction(
  transaction: WorkflowRuntimeWriteTransaction,
  request: WorkflowBundlePublicationRequest,
): WorkflowBundlePublicationReceipt {
  if (
    !request.publication_ref ||
    !Number.isSafeInteger(request.published_at_ms) ||
    request.published_at_ms < 0 ||
    request.resources.length === 0
  ) {
    throw new WorkflowBundlePublisherError(
      'bundle_invalid',
      'Workflow bundle publication request is invalid',
    );
  }
  if (request.registry_batch) {
    const expected = new Set(request.resources.map(registryResourceId));
    const observed = new Set(
      request.registry_batch.resources.map(registryResourceId),
    );
    if (
      expected.size !== observed.size ||
      [...expected].some((resourceId) => !observed.has(resourceId)) ||
      request.registry_batch.resources.some(
        (resource) =>
          canonicalJson(resource.owner) !== canonicalJson(request.owner),
      )
    ) {
      throw new WorkflowBundlePublisherError(
        'bundle_owner_mismatch',
        'Workflow bundle resources do not match the closed owner and membership',
      );
    }
  }
  const persistence = request.registry_batch
    ? persistRegistryPersistenceBatchInTransaction(
        transaction,
        request.registry_batch,
      )
    : null;
  const owner = ownerColumns(request.owner);
  let published = 0;
  let exactReplay = 0;
  for (const resource of request.resources) {
    const id = registryResourceId(resource);
    const row = transaction.queryOne<{
      content_hash: string;
      publication_state: string;
    }>(
      `SELECT content_hash, publication_state
         FROM workflow_registry_resources
        WHERE id = ? AND ${owner.sql}`,
      [id, ...owner.values],
    );
    if (!row || row.content_hash !== resource.content_hash) {
      throw new WorkflowBundlePublisherError(
        'bundle_owner_mismatch',
        `Workflow bundle resource ${id} is not staged for its declared owner`,
      );
    }
    if (row.publication_state === 'published') {
      exactReplay += 1;
      continue;
    }
    const result = transaction.execute(
      `UPDATE workflow_registry_resources
          SET publication_state = 'published', published_at_ms = ?,
              row_version = row_version + 1
        WHERE id = ? AND content_hash = ? AND publication_state = 'staged'
          AND published_at_ms IS NULL AND retired_at_ms IS NULL
          AND ${owner.sql}`,
      [request.published_at_ms, id, resource.content_hash, ...owner.values],
    );
    if (result.changes !== 1) {
      throw new WorkflowBundlePublisherError(
        'bundle_publication_collision',
        `Workflow bundle publication CAS failed for ${id}`,
      );
    }
    published += 1;
  }
  if (published > 0 && exactReplay > 0 && !request.registry_batch) {
    throw new WorkflowBundlePublisherError(
      'bundle_publication_collision',
      'Workflow bundle publication cannot mix staged and published members',
    );
  }
  const withoutHash = receiptWithoutHash({
    request,
    persistence,
    disposition: published > 0 ? 'published' : 'exact_replay',
  });
  return {
    ...withoutHash,
    receipt_hash: domainSeparatedSha256(
      'icarus:workflow-bundle-publication-receipt:1\n',
      withoutHash,
    ),
  };
}

export function publishWorkflowBundle(
  store: WorkflowRuntimeStore,
  request: WorkflowBundlePublicationRequest,
): WorkflowBundlePublicationReceipt {
  return store.withImmediateTransaction((transaction) =>
    publishWorkflowBundleInTransaction(transaction, request),
  );
}
