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
  readonly claimEpoch: number;
  readonly fencingToken: number | null;
  readonly disposition: 'acquired' | 'exact_replay';
}

interface ClaimRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  key_hash: string;
  mode: string;
  owner_workflow_id: string;
  recipe_resource_id: string;
  recipe_resource_hash: string;
  source_intake_id: string;
  creation_key: string;
  fencing_token: number | null;
  status: string;
  acquired_at_ms: number;
  released_at_ms: number | null;
  row_version: number;
  claim_epoch: number;
  fencing_token_identity: number;
  acquisition_kind: string;
  predecessor_claim_id: string | null;
  handoff_id: string | null;
  active_head_claim_id: string | null;
}

interface HeadRow extends Record<string, unknown> {
  namespace: string;
  key_hash: string;
  current_fencing_token: number;
  row_version: number;
  latest_claim_epoch: number;
  active_claim_id: string | null;
  active_claim_owner_workflow_id: string | null;
  active_claim_mode: string | null;
  active_claim_epoch: number | null;
  active_fencing_token_identity: number | null;
  active_claim_link_id: string | null;
}

const CLAIM_COLUMNS = `id, namespace, key_hash, mode, owner_workflow_id,
  recipe_resource_id, recipe_resource_hash, source_intake_id, creation_key,
  fencing_token, status, acquired_at_ms, released_at_ms, row_version,
  claim_epoch, fencing_token_identity, acquisition_kind,
  predecessor_claim_id, handoff_id, active_head_claim_id`;

function assertSafeIncrement(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new G5RuntimeError('precondition_failed', `${label} cannot advance`);
  }
  return value + 1;
}

function claimIdFor(request: DomainClaimRequest): string {
  return stableRuntimeId('claim', {
    namespace: request.namespace,
    key_hash: request.keyHash,
    owner_workflow_id: request.ownerWorkflowId,
    creation_key: request.creationKey,
  });
}

function readClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  claimId: string,
): ClaimRow | undefined {
  return transaction.queryOne<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS} FROM workflow_domain_resource_claims WHERE id = ?`,
    [claimId],
  );
}

function readHead(
  transaction: WorkflowRuntimeWriteTransaction,
  namespace: string,
  keyHash: string,
): HeadRow | undefined {
  return transaction.queryOne<HeadRow>(
    `SELECT namespace, key_hash, current_fencing_token, row_version,
            latest_claim_epoch, active_claim_id,
            active_claim_owner_workflow_id, active_claim_mode,
            active_claim_epoch, active_fencing_token_identity,
            active_claim_link_id
       FROM workflow_domain_resource_heads
      WHERE namespace = ? AND key_hash = ?`,
    [namespace, keyHash],
  );
}

function headMatchesClaim(head: HeadRow | undefined, claim: ClaimRow): boolean {
  return Boolean(
    head &&
    head.active_claim_id === claim.id &&
    head.active_claim_owner_workflow_id === claim.owner_workflow_id &&
    head.active_claim_mode === claim.mode &&
    head.active_claim_epoch === claim.claim_epoch &&
    head.active_fencing_token_identity === claim.fencing_token_identity &&
    head.active_claim_link_id === claim.id &&
    claim.active_head_claim_id === claim.id,
  );
}

function assertDirectReplay(
  existing: ClaimRow,
  request: DomainClaimRequest,
  head: HeadRow | undefined,
): AcquiredDomainClaim {
  if (
    existing.namespace !== request.namespace ||
    existing.key_hash !== request.keyHash ||
    existing.mode !== request.mode ||
    existing.owner_workflow_id !== request.ownerWorkflowId ||
    existing.recipe_resource_id !== request.recipeResourceId ||
    existing.recipe_resource_hash !== request.recipeResourceHash ||
    existing.source_intake_id !== request.sourceIntakeId ||
    existing.creation_key !== request.creationKey ||
    existing.acquired_at_ms !== request.acquiredAtMs ||
    existing.status !== 'held' ||
    existing.acquisition_kind !== 'direct' ||
    existing.predecessor_claim_id !== null ||
    existing.handoff_id !== null ||
    !headMatchesClaim(head, existing)
  ) {
    throw new G5RuntimeError(
      'idempotency_conflict',
      `Domain claim collision: ${existing.id}`,
    );
  }
  return {
    claimId: existing.id,
    claimEpoch: existing.claim_epoch,
    fencingToken: existing.fencing_token,
    disposition: 'exact_replay',
  };
}

// Frozen Schema 9 entry point retained solely by the byte-sealed R-022
// impossibility proof. Current Production callers use the Schema 10 primitive.
export function acquireDomainClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  request: DomainClaimRequest,
): AcquiredDomainClaim {
  const claimId = claimIdFor(request);
  const existing = transaction.queryOne<{
    mode: string;
    owner_workflow_id: string;
    recipe_resource_id: string;
    recipe_resource_hash: string;
    fencing_token: number | null;
    status: string;
  }>(
    'SELECT mode, owner_workflow_id, recipe_resource_id, recipe_resource_hash, fencing_token, status FROM workflow_domain_resource_claims WHERE id = ?',
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
      claimEpoch: 1,
      fencingToken: existing.fencing_token,
      disposition: 'exact_replay',
    };
  }
  const conflicting = transaction.queryOne<{ id: string }>(
    request.mode === 'exclusive'
      ? "SELECT id FROM workflow_domain_resource_claims WHERE namespace = ? AND key_hash = ? AND status IN ('held', 'release_pending') LIMIT 1"
      : "SELECT id FROM workflow_domain_resource_claims WHERE namespace = ? AND key_hash = ? AND mode = 'exclusive' AND status IN ('held', 'release_pending') LIMIT 1",
    [request.namespace, request.keyHash],
  );
  if (conflicting) {
    throw new G5RuntimeError(
      'resource_unavailable',
      'Domain resource claim conflicts with an existing holder',
    );
  }
  let fencingToken: number | null = null;
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
      fencingToken = assertSafeIncrement(
        head.current_fencing_token,
        'Fencing token',
      );
      const changed = transaction.execute(
        'UPDATE workflow_domain_resource_heads SET current_fencing_token = ?, row_version = row_version + 1 WHERE namespace = ? AND key_hash = ? AND row_version = ?',
        [fencingToken, request.namespace, request.keyHash, head.row_version],
      ).changes;
      if (changed !== 1) {
        throw new G5RuntimeError(
          'cas_conflict',
          'Domain claim head changed concurrently',
        );
      }
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
  return {
    claimId,
    claimEpoch: 1,
    fencingToken,
    disposition: 'acquired',
  };
}

export function acquireCurrentDomainClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  request: DomainClaimRequest,
): AcquiredDomainClaim {
  const claimId = claimIdFor(request);
  const existing = readClaim(transaction, claimId);
  if (existing) {
    return assertDirectReplay(
      existing,
      request,
      readHead(transaction, request.namespace, request.keyHash),
    );
  }

  const head = readHead(transaction, request.namespace, request.keyHash);
  if (head?.active_claim_id !== null && head?.active_claim_id !== undefined) {
    throw new G5RuntimeError(
      'resource_unavailable',
      'Domain resource claim conflicts with an existing holder',
    );
  }
  const claimEpoch = assertSafeIncrement(
    head?.latest_claim_epoch ?? 0,
    'Claim epoch',
  );
  const fencingToken =
    request.mode === 'exclusive'
      ? assertSafeIncrement(head?.current_fencing_token ?? 0, 'Fencing token')
      : null;
  const fencingIdentity = fencingToken ?? 0;

  if (!head) {
    transaction.execute(
      `INSERT INTO workflow_domain_resource_heads (
         namespace, key_hash, current_fencing_token, row_version,
         latest_claim_epoch, active_claim_id, active_claim_owner_workflow_id,
         active_claim_mode,
         active_claim_epoch, active_fencing_token_identity, active_claim_link_id
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.namespace,
        request.keyHash,
        fencingToken ?? 0,
        claimEpoch,
        claimId,
        request.ownerWorkflowId,
        request.mode,
        claimEpoch,
        fencingIdentity,
        claimId,
      ],
    );
  } else {
    const changed = transaction.execute(
      `UPDATE workflow_domain_resource_heads
          SET current_fencing_token = ?, latest_claim_epoch = ?,
              active_claim_id = ?, active_claim_mode = ?, active_claim_epoch = ?,
              active_claim_owner_workflow_id = ?,
              active_fencing_token_identity = ?, active_claim_link_id = ?,
              row_version = row_version + 1
        WHERE namespace = ? AND key_hash = ? AND row_version = ?
          AND active_claim_id IS NULL
          AND active_claim_owner_workflow_id IS NULL
          AND active_claim_mode IS NULL
          AND active_claim_epoch IS NULL
          AND active_fencing_token_identity IS NULL
          AND active_claim_link_id IS NULL`,
      [
        fencingToken ?? head.current_fencing_token,
        claimEpoch,
        claimId,
        request.mode,
        claimEpoch,
        request.ownerWorkflowId,
        fencingIdentity,
        claimId,
        request.namespace,
        request.keyHash,
        head.row_version,
      ],
    ).changes;
    if (changed !== 1) {
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
       status, acquired_at_ms, released_at_ms, row_version, claim_epoch,
       fencing_token_identity, acquisition_kind, predecessor_claim_id,
       handoff_id, active_head_claim_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, NULL, 1, ?, ?,
       'direct', NULL, NULL, ?)`,
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
      claimEpoch,
      fencingIdentity,
      claimId,
    ],
  );
  return {
    claimId,
    claimEpoch,
    fencingToken,
    disposition: 'acquired',
  };
}

export interface ReleaseDomainClaimRequest {
  readonly claimId: string;
  readonly ownerWorkflowId: string;
  readonly expectedClaimRowVersion: number;
  readonly expectedHeadRowVersion: number;
  readonly expectedFencingToken: number | null;
  readonly releasedAtMs: number;
}

export type DomainClaimFault =
  | 'after_parent_release'
  | 'after_head_change'
  | 'after_child_insert'
  | 'after_handoff_insert';

function injectFault(
  selected: DomainClaimFault | undefined,
  boundary: DomainClaimFault,
): void {
  if (selected === boundary) throw new Error(`injected_fault:${boundary}`);
}

export function releaseDomainClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  request: ReleaseDomainClaimRequest,
  fault?: DomainClaimFault,
): { disposition: 'released' | 'exact_replay'; claimId: string } {
  const claim = readClaim(transaction, request.claimId);
  if (!claim || claim.owner_workflow_id !== request.ownerWorkflowId) {
    throw new G5RuntimeError(
      'precondition_failed',
      'Domain claim owner mismatch',
    );
  }
  if (claim.status === 'released') {
    if (
      claim.released_at_ms !== request.releasedAtMs ||
      claim.fencing_token !== request.expectedFencingToken
    ) {
      throw new G5RuntimeError(
        'idempotency_conflict',
        'Released Domain claim replay drifted',
      );
    }
    return { disposition: 'exact_replay', claimId: claim.id };
  }
  const head = readHead(transaction, claim.namespace, claim.key_hash);
  if (
    claim.row_version !== request.expectedClaimRowVersion ||
    claim.fencing_token !== request.expectedFencingToken ||
    !headMatchesClaim(head, claim) ||
    head!.row_version !== request.expectedHeadRowVersion
  ) {
    throw new G5RuntimeError('cas_conflict', 'Domain claim release is stale');
  }
  const claimChanged = transaction.execute(
    `UPDATE workflow_domain_resource_claims
        SET status = 'released', released_at_ms = ?, active_head_claim_id = NULL,
            row_version = row_version + 1
      WHERE id = ? AND owner_workflow_id = ? AND row_version = ?
        AND status IN ('held', 'release_pending') AND active_head_claim_id = id`,
    [
      request.releasedAtMs,
      claim.id,
      claim.owner_workflow_id,
      request.expectedClaimRowVersion,
    ],
  ).changes;
  if (claimChanged !== 1)
    throw new G5RuntimeError('cas_conflict', 'Domain claim release lost CAS');
  injectFault(fault, 'after_parent_release');
  const headChanged = transaction.execute(
    `UPDATE workflow_domain_resource_heads
        SET active_claim_id = NULL, active_claim_mode = NULL,
            active_claim_owner_workflow_id = NULL,
            active_claim_epoch = NULL, active_fencing_token_identity = NULL,
            active_claim_link_id = NULL,
            row_version = row_version + 1
      WHERE namespace = ? AND key_hash = ? AND row_version = ?
        AND active_claim_id = ? AND active_claim_mode = ?
        AND active_claim_owner_workflow_id = ?
        AND active_claim_epoch = ? AND active_fencing_token_identity = ?
        AND active_claim_link_id = ?`,
    [
      claim.namespace,
      claim.key_hash,
      request.expectedHeadRowVersion,
      claim.id,
      claim.mode,
      claim.owner_workflow_id,
      claim.claim_epoch,
      claim.fencing_token_identity,
      claim.id,
    ],
  ).changes;
  if (headChanged !== 1)
    throw new G5RuntimeError(
      'cas_conflict',
      'Domain claim head release lost CAS',
    );
  injectFault(fault, 'after_head_change');
  return { disposition: 'released', claimId: claim.id };
}

export interface RequiredChildDomainClaimHandoffRequest {
  readonly parentClaimId: string;
  readonly parentWorkflowId: string;
  readonly expectedParentClaimRowVersion: number;
  readonly expectedHeadRowVersion: number;
  readonly expectedParentFencingToken: number;
  readonly child: DomainClaimRequest & { readonly mode: 'exclusive' };
  readonly rootFinalizationScheduleId: string;
  readonly creationRequestId: string;
  readonly workflowRelationId: string;
  readonly transferredAtMs: number;
}

export interface RequiredChildDomainClaimHandoffReceipt {
  readonly disposition: 'handed_off' | 'exact_replay';
  readonly handoffId: string;
  readonly parentClaimId: string;
  readonly childClaimId: string;
  readonly childClaimEpoch: number;
  readonly childFencingToken: number;
}

interface HandoffRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  key_hash: string;
  parent_claim_id: string;
  parent_workflow_id: string;
  parent_claim_epoch: number;
  parent_fencing_token: number;
  child_claim_id: string;
  child_workflow_id: string;
  child_claim_epoch: number;
  child_fencing_token: number;
  source_root_finalization_schedule_id: string;
  source_creation_request_id: string;
  source_workflow_relation_id: string;
  source_root_finalization_schedule_status: string;
  created_at_ms: number;
}

export function handoffRequiredChildDomainClaim(
  transaction: WorkflowRuntimeWriteTransaction,
  request: RequiredChildDomainClaimHandoffRequest,
  fault?: DomainClaimFault,
): RequiredChildDomainClaimHandoffReceipt {
  const childClaimId = claimIdFor(request.child);
  const handoffId = stableRuntimeId('claim-handoff', {
    parent_claim_id: request.parentClaimId,
    child_claim_id: childClaimId,
    root_finalization_schedule_id: request.rootFinalizationScheduleId,
  });
  const existing = transaction.queryOne<HandoffRow>(
    `SELECT id, namespace, key_hash, parent_claim_id, parent_workflow_id,
            parent_claim_epoch, parent_fencing_token, child_claim_id,
            child_workflow_id, child_claim_epoch, child_fencing_token,
            source_root_finalization_schedule_id, source_creation_request_id,
            source_workflow_relation_id,
            source_root_finalization_schedule_status, created_at_ms
       FROM workflow_domain_resource_claim_handoffs WHERE id = ?`,
    [handoffId],
  );
  if (existing) {
    const replayParent = readClaim(transaction, existing.parent_claim_id);
    const replayChild = readClaim(transaction, existing.child_claim_id);
    if (
      existing.parent_claim_id !== request.parentClaimId ||
      existing.parent_workflow_id !== request.parentWorkflowId ||
      existing.child_claim_id !== childClaimId ||
      existing.child_workflow_id !== request.child.ownerWorkflowId ||
      existing.namespace !== request.child.namespace ||
      existing.key_hash !== request.child.keyHash ||
      existing.source_root_finalization_schedule_id !==
        request.rootFinalizationScheduleId ||
      existing.source_creation_request_id !== request.creationRequestId ||
      existing.source_workflow_relation_id !== request.workflowRelationId ||
      existing.source_root_finalization_schedule_status !== 'succeeded' ||
      existing.created_at_ms !== request.transferredAtMs ||
      existing.parent_fencing_token !== request.expectedParentFencingToken ||
      !replayParent ||
      replayParent.status !== 'released' ||
      replayParent.released_at_ms !== request.transferredAtMs ||
      replayParent.row_version !== request.expectedParentClaimRowVersion + 1 ||
      replayParent.claim_epoch !== existing.parent_claim_epoch ||
      replayParent.fencing_token !== existing.parent_fencing_token ||
      replayParent.active_head_claim_id !== null ||
      !replayChild ||
      replayChild.namespace !== request.child.namespace ||
      replayChild.key_hash !== request.child.keyHash ||
      replayChild.mode !== 'exclusive' ||
      replayChild.owner_workflow_id !== request.child.ownerWorkflowId ||
      replayChild.recipe_resource_id !== request.child.recipeResourceId ||
      replayChild.recipe_resource_hash !== request.child.recipeResourceHash ||
      replayChild.source_intake_id !== request.child.sourceIntakeId ||
      replayChild.creation_key !== request.child.creationKey ||
      replayChild.acquired_at_ms !== request.child.acquiredAtMs ||
      !['held', 'release_pending', 'released'].includes(replayChild.status) ||
      replayChild.acquisition_kind !== 'handoff' ||
      replayChild.predecessor_claim_id !== replayParent.id ||
      replayChild.handoff_id !== existing.id ||
      replayChild.claim_epoch !== existing.child_claim_epoch ||
      replayChild.fencing_token !== existing.child_fencing_token ||
      existing.child_claim_epoch !== existing.parent_claim_epoch + 1 ||
      existing.child_fencing_token !== existing.parent_fencing_token + 1
    ) {
      throw new G5RuntimeError(
        'idempotency_conflict',
        'Domain Claim handoff replay drifted',
      );
    }
    return {
      disposition: 'exact_replay',
      handoffId,
      parentClaimId: existing.parent_claim_id,
      childClaimId: existing.child_claim_id,
      childClaimEpoch: existing.child_claim_epoch,
      childFencingToken: existing.child_fencing_token,
    };
  }

  const parent = readClaim(transaction, request.parentClaimId);
  if (
    !parent ||
    parent.owner_workflow_id !== request.parentWorkflowId ||
    parent.namespace !== request.child.namespace ||
    parent.key_hash !== request.child.keyHash ||
    parent.mode !== 'exclusive' ||
    parent.fencing_token === null ||
    parent.fencing_token !== request.expectedParentFencingToken ||
    parent.status !== 'held' ||
    parent.row_version !== request.expectedParentClaimRowVersion
  ) {
    throw new G5RuntimeError(
      'precondition_failed',
      'Required Child handoff Parent Claim is not exact/current',
    );
  }
  if (readClaim(transaction, childClaimId)) {
    throw new G5RuntimeError(
      'integrity_violation',
      'Required Child Claim exists without its exact handoff',
    );
  }
  const head = readHead(transaction, parent.namespace, parent.key_hash);
  if (
    !headMatchesClaim(head, parent) ||
    head!.row_version !== request.expectedHeadRowVersion ||
    head!.current_fencing_token !== parent.fencing_token
  ) {
    throw new G5RuntimeError(
      'cas_conflict',
      'Required Child handoff Head is stale',
    );
  }
  const childClaimEpoch = assertSafeIncrement(
    head!.latest_claim_epoch,
    'Claim epoch',
  );
  const childFencingToken = assertSafeIncrement(
    parent.fencing_token,
    'Fencing token',
  );

  const parentChanged = transaction.execute(
    `UPDATE workflow_domain_resource_claims
        SET status = 'released', released_at_ms = ?, active_head_claim_id = NULL,
            row_version = row_version + 1
      WHERE id = ? AND owner_workflow_id = ? AND row_version = ?
        AND status = 'held' AND active_head_claim_id = id`,
    [
      request.transferredAtMs,
      parent.id,
      parent.owner_workflow_id,
      request.expectedParentClaimRowVersion,
    ],
  ).changes;
  if (parentChanged !== 1)
    throw new G5RuntimeError('cas_conflict', 'Parent Claim handoff lost CAS');
  injectFault(fault, 'after_parent_release');

  const headChanged = transaction.execute(
    `UPDATE workflow_domain_resource_heads
        SET current_fencing_token = ?, latest_claim_epoch = ?,
            active_claim_id = ?, active_claim_mode = 'exclusive',
            active_claim_owner_workflow_id = ?,
            active_claim_epoch = ?, active_fencing_token_identity = ?,
            active_claim_link_id = ?,
            row_version = row_version + 1
      WHERE namespace = ? AND key_hash = ? AND row_version = ?
        AND current_fencing_token = ? AND active_claim_id = ?
        AND active_claim_owner_workflow_id = ?
        AND active_claim_mode = 'exclusive' AND active_claim_epoch = ?
        AND active_fencing_token_identity = ?`,
    [
      childFencingToken,
      childClaimEpoch,
      childClaimId,
      request.child.ownerWorkflowId,
      childClaimEpoch,
      childFencingToken,
      childClaimId,
      parent.namespace,
      parent.key_hash,
      request.expectedHeadRowVersion,
      parent.fencing_token,
      parent.id,
      parent.owner_workflow_id,
      parent.claim_epoch,
      parent.fencing_token_identity,
    ],
  ).changes;
  if (headChanged !== 1)
    throw new G5RuntimeError('cas_conflict', 'Claim Head handoff lost CAS');
  injectFault(fault, 'after_head_change');

  transaction.execute(
    `INSERT INTO workflow_domain_resource_claims (
       id, namespace, key_hash, mode, owner_workflow_id, recipe_resource_id,
       recipe_resource_hash, source_intake_id, creation_key, fencing_token,
       status, acquired_at_ms, released_at_ms, row_version, claim_epoch,
       fencing_token_identity, acquisition_kind, predecessor_claim_id,
       handoff_id, active_head_claim_id
     ) VALUES (?, ?, ?, 'exclusive', ?, ?, ?, ?, ?, ?, 'held', ?, NULL, 1,
       ?, ?, 'handoff', ?, ?, ?)`,
    [
      childClaimId,
      request.child.namespace,
      request.child.keyHash,
      request.child.ownerWorkflowId,
      request.child.recipeResourceId,
      request.child.recipeResourceHash,
      request.child.sourceIntakeId,
      request.child.creationKey,
      childFencingToken,
      request.child.acquiredAtMs,
      childClaimEpoch,
      childFencingToken,
      parent.id,
      handoffId,
      childClaimId,
    ],
  );
  injectFault(fault, 'after_child_insert');

  transaction.execute(
    `INSERT INTO workflow_domain_resource_claim_handoffs (
       id, namespace, key_hash, parent_claim_id, parent_workflow_id,
       parent_claim_mode, parent_claim_epoch, parent_fencing_token,
       child_claim_id, child_workflow_id, child_claim_mode, child_claim_epoch,
       child_fencing_token, source_root_finalization_schedule_id,
       source_creation_request_id, source_workflow_relation_id,
       source_root_finalization_schedule_status, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, 'exclusive', ?, ?, ?, ?, 'exclusive', ?, ?, ?,
       ?, ?, 'succeeded', ?)`,
    [
      handoffId,
      parent.namespace,
      parent.key_hash,
      parent.id,
      parent.owner_workflow_id,
      parent.claim_epoch,
      parent.fencing_token,
      childClaimId,
      request.child.ownerWorkflowId,
      childClaimEpoch,
      childFencingToken,
      request.rootFinalizationScheduleId,
      request.creationRequestId,
      request.workflowRelationId,
      request.transferredAtMs,
    ],
  );
  injectFault(fault, 'after_handoff_insert');

  return {
    disposition: 'handed_off',
    handoffId,
    parentClaimId: parent.id,
    childClaimId,
    childClaimEpoch,
    childFencingToken,
  };
}
