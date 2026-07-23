import type { Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeWriteTransaction } from '../store/runtime-store/index.js';
import { G5RuntimeError, stableRuntimeId } from '../runtime/graph-store.js';

export interface DomainClaimRequest {
  readonly namespace: string;
  readonly keyHash: Sha256Hash;
  readonly mode: 'shared' | 'exclusive';
  readonly ownerWorkflowId: string;
  readonly recipeResourceId: string;
  readonly recipeResourceHash: Sha256Hash;
  readonly sourceIntakeId: string;
  readonly creationKey: string;
  readonly acquiredAtMs: number;
}

export interface AcquiredDomainClaim {
  readonly claimId: string;
  readonly fencingToken: number | null;
  readonly disposition: 'acquired' | 'exact_replay';
}

export function acquireDomainClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  request: DomainClaimRequest,
): AcquiredDomainClaim {
  const claimId = stableRuntimeId('claim', {
    namespace: request.namespace,
    key_hash: request.keyHash,
    owner_workflow_id: request.ownerWorkflowId,
    creation_key: request.creationKey,
  });
  const existing = transaction.queryOne<{
    id: string;
    mode: string;
    owner_workflow_id: string;
    recipe_resource_id: string;
    recipe_resource_hash: string;
    fencing_token: number | null;
    status: string;
  }>(
    'SELECT id, mode, owner_workflow_id, recipe_resource_id, recipe_resource_hash, fencing_token, status FROM workflow_domain_resource_claims WHERE id = ?',
    [claimId],
  );
  if (existing) {
    if (
      existing.mode !== request.mode ||
      existing.owner_workflow_id !== request.ownerWorkflowId ||
      existing.recipe_resource_id !== request.recipeResourceId ||
      existing.recipe_resource_hash !== request.recipeResourceHash ||
      existing.status !== 'held'
    ) {
      throw new G5RuntimeError(
        'idempotency_conflict',
        `Domain claim collision: ${claimId}`,
      );
    }
    return {
      claimId,
      fencingToken: existing.fencing_token,
      disposition: 'exact_replay',
    };
  }
  let fencingToken: number | null = null;
  const conflicting = transaction.queryOne<{ id: string }>(
    request.mode === 'exclusive'
      ? "SELECT id FROM workflow_domain_resource_claims WHERE namespace = ? AND key_hash = ? AND status IN ('held', 'release_pending') LIMIT 1"
      : "SELECT id FROM workflow_domain_resource_claims WHERE namespace = ? AND key_hash = ? AND mode = 'exclusive' AND status IN ('held', 'release_pending') LIMIT 1",
    [request.namespace, request.keyHash],
  );
  if (conflicting)
    throw new G5RuntimeError(
      'resource_unavailable',
      'Domain resource claim conflicts with an existing holder',
    );
  if (request.mode === 'exclusive') {
    const head = transaction.queryOne<{
      current_fencing_token: number;
      row_version: number;
    }>(
      'SELECT current_fencing_token, row_version FROM workflow_domain_resource_heads WHERE namespace = ? AND key_hash = ?',
      [request.namespace, request.keyHash],
    );
    if (!head) {
      fencingToken = 1;
      transaction.execute(
        'INSERT INTO workflow_domain_resource_heads (namespace, key_hash, current_fencing_token, row_version) VALUES (?, ?, 1, 1)',
        [request.namespace, request.keyHash],
      );
    } else {
      fencingToken = head.current_fencing_token + 1;
      const changed = transaction.execute(
        'UPDATE workflow_domain_resource_heads SET current_fencing_token = ?, row_version = row_version + 1 WHERE namespace = ? AND key_hash = ? AND row_version = ?',
        [fencingToken, request.namespace, request.keyHash, head.row_version],
      ).changes;
      if (changed !== 1)
        throw new G5RuntimeError(
          'cas_conflict',
          'Domain claim head changed concurrently',
        );
    }
  }
  transaction.execute(
    `INSERT INTO workflow_domain_resource_claims (
       id, namespace, key_hash, mode, owner_workflow_id, recipe_resource_id,
       recipe_resource_hash, source_intake_id, creation_key, fencing_token,
       status, acquired_at_ms, released_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, NULL, 1)`,
    [
      claimId,
      request.namespace,
      request.keyHash,
      request.mode,
      request.ownerWorkflowId,
      request.recipeResourceId,
      request.recipeResourceHash,
      request.sourceIntakeId,
      request.creationKey,
      fencingToken,
      request.acquiredAtMs,
    ],
  );
  return { claimId, fencingToken, disposition: 'acquired' };
}
