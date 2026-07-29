import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeWriteTransaction } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertGraphFact,
  stableRuntimeId,
  type GraphFactInsertInput,
} from './graph-store.js';

export interface LedgerReservationRequest {
  readonly graphRunId: string;
  readonly reservationGroupId: string;
  readonly consumer: {
    readonly workflowId?: string;
    readonly buildId?: string;
    readonly scopeId?: string;
    readonly nodeId?: string;
    readonly attemptId?: string;
    readonly waitId?: string;
    readonly effectId?: string;
    readonly factId?: string;
  };
  readonly amounts: Readonly<Record<string, number>>;
  readonly purpose: string;
  readonly settlementMode:
    | 'consume_on_create'
    | 'hold_then_release'
    | 'incremental';
  readonly nowMs: number;
}

function ledgerHash(payload: JsonObject): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-resource-ledger-entry:1\n',
    payload,
  );
}

export function reserveLedgerResources(
  transaction: WorkflowRuntimeWriteTransaction,
  request: LedgerReservationRequest,
): string[] {
  const consumerEntries = Object.entries(request.consumer).filter(
    ([, value]) => value !== undefined,
  );
  if (consumerEntries.length !== 1)
    throw new G5RuntimeError(
      'contract_invalid',
      'Ledger reservation requires exactly one consumer',
    );
  const run = transaction.queryOne<{
    ledger_seq: number;
    ledger_head_hash: Sha256Hash;
    row_version: number;
  }>(
    'SELECT ledger_seq, ledger_head_hash, row_version FROM workflow_graph_runs WHERE id = ?',
    [request.graphRunId],
  );
  if (!run)
    throw new G5RuntimeError('precondition_failed', 'Ledger Run is missing');
  const reservationIds: string[] = [];
  let sequence = run.ledger_seq;
  let previousHash = run.ledger_head_hash;
  for (const [resourceType, amount] of Object.entries(request.amounts).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new G5RuntimeError(
        'contract_invalid',
        `Invalid reservation amount for ${resourceType}`,
      );
    const account = transaction.queryOne<{
      id: string;
      hard_limit: number;
      reserved_amount: number;
      consumed_amount: number;
      row_version: number;
    }>(
      'SELECT id, hard_limit, reserved_amount, consumed_amount, row_version FROM workflow_graph_resource_accounts WHERE graph_run_id = ? AND resource_type = ?',
      [request.graphRunId, resourceType],
    );
    if (
      !account ||
      account.reserved_amount + account.consumed_amount + amount >
        account.hard_limit
    )
      throw new G5RuntimeError(
        'resource_unavailable',
        `Ledger quota exhausted: ${resourceType}`,
      );
    const reservationId = stableRuntimeId('reservation', {
      reservation_group_id: request.reservationGroupId,
      resource_type: resourceType,
    });
    const consumeNow = request.settlementMode === 'consume_on_create';
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservations (
       id, graph_run_id, reservation_group_id, consumer_workflow_id,
       consumer_build_id, consumer_scope_id, consumer_node_id,
       consumer_attempt_id, consumer_wait_id, consumer_effect_id,
       consumer_fact_id, resource_type, purpose, settlement_mode,
       reserved_remaining, consumed_amount, status, created_at_ms,
       settled_at_ms, row_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        reservationId,
        request.graphRunId,
        request.reservationGroupId,
        request.consumer.workflowId ?? null,
        request.consumer.buildId ?? null,
        request.consumer.scopeId ?? null,
        request.consumer.nodeId ?? null,
        request.consumer.attemptId ?? null,
        request.consumer.waitId ?? null,
        request.consumer.effectId ?? null,
        request.consumer.factId ?? null,
        resourceType,
        request.purpose,
        request.settlementMode,
        consumeNow ? 0 : amount,
        consumeNow ? amount : 0,
        consumeNow ? 'committed' : 'held',
        request.nowMs,
        consumeNow ? request.nowMs : null,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservation_postings (
       reservation_id, account_id, reserved_remaining, consumed_amount,
       status, row_version
     ) VALUES (?, ?, ?, ?, ?, 1)`,
      [
        reservationId,
        account.id,
        consumeNow ? 0 : amount,
        consumeNow ? amount : 0,
        consumeNow ? 'committed' : 'held',
      ],
    );
    const changed = transaction.execute(
      consumeNow
        ? 'UPDATE workflow_graph_resource_accounts SET consumed_amount = consumed_amount + ?, row_version = row_version + 1 WHERE id = ? AND row_version = ? AND reserved_amount + consumed_amount + ? <= hard_limit'
        : 'UPDATE workflow_graph_resource_accounts SET reserved_amount = reserved_amount + ?, row_version = row_version + 1 WHERE id = ? AND row_version = ? AND reserved_amount + consumed_amount + ? <= hard_limit',
      [amount, account.id, account.row_version, amount],
    ).changes;
    if (changed !== 1)
      throw new G5RuntimeError(
        'cas_conflict',
        `Ledger account changed: ${account.id}`,
      );
    sequence += 1;
    const operation = consumeNow ? 'charge' : 'reserve';
    const payload: JsonObject = {
      graph_run_id: request.graphRunId,
      ledger_seq: sequence,
      reservation_group_id: request.reservationGroupId,
      account_id: account.id,
      reservation_id: reservationId,
      operation,
      delta_reserved: consumeNow ? 0 : amount,
      delta_consumed: consumeNow ? amount : 0,
      idempotency_key: `${operation}:${reservationId}`,
      previous_chain_hash: previousHash,
      created_at_ms: request.nowMs,
    };
    const chainHash = ledgerHash(payload);
    transaction.execute(
      `INSERT INTO workflow_graph_resource_ledger_entries (
       id, graph_run_id, ledger_seq, reservation_group_id, account_id,
       reservation_id, operation, delta_reserved, delta_consumed,
       idempotency_key, previous_chain_hash, chain_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableRuntimeId('ledger-entry', {
          graph_run_id: request.graphRunId,
          ledger_seq: sequence,
        }),
        request.graphRunId,
        sequence,
        request.reservationGroupId,
        account.id,
        reservationId,
        operation,
        consumeNow ? 0 : amount,
        consumeNow ? amount : 0,
        `${operation}:${reservationId}`,
        previousHash,
        chainHash,
        request.nowMs,
      ],
    );
    previousHash = chainHash;
    reservationIds.push(reservationId);
  }
  const changed = transaction.execute(
    'UPDATE workflow_graph_runs SET ledger_seq = ?, ledger_head_hash = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND ledger_seq = ? AND ledger_head_hash = ?',
    [
      sequence,
      previousHash,
      request.nowMs,
      request.graphRunId,
      run.ledger_seq,
      run.ledger_head_hash,
    ],
  ).changes;
  if (changed !== 1)
    throw new G5RuntimeError('cas_conflict', 'Ledger head CAS failed');
  return reservationIds;
}

export function chargeAndInsertGraphFact(
  transaction: WorkflowRuntimeWriteTransaction,
  input: GraphFactInsertInput,
): 'inserted' | 'exact_replay' {
  const existing = transaction.queryOne<{ id: string }>(
    'SELECT id FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?',
    [input.graphRunId, input.factKey],
  );
  if (existing) return insertGraphFact(transaction, input);

  reserveLedgerResources(transaction, {
    graphRunId: input.graphRunId,
    reservationGroupId: stableRuntimeId('reservation-group', {
      graph_run_id: input.graphRunId,
      fact_id: input.id,
      purpose: 'fixed_point_fact',
    }),
    consumer: { factId: input.id },
    amounts: { facts_total: 1 },
    purpose: 'fixed_point_fact',
    settlementMode: 'consume_on_create',
    nowMs: input.createdAtMs,
  });
  return insertGraphFact(transaction, input);
}

export function chargeAndInsertGraphFacts(
  transaction: WorkflowRuntimeWriteTransaction,
  inputs: readonly GraphFactInsertInput[],
): void {
  if (inputs.length === 0) return;
  const graphRunId = inputs[0]!.graphRunId;
  if (
    inputs.some((input) => input.graphRunId !== graphRunId) ||
    new Set(inputs.map((input) => input.factKey)).size !== inputs.length ||
    new Set(inputs.map((input) => input.id)).size !== inputs.length
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'Batched fixed-point facts require one Run and unique identities',
    );

  const existing = transaction.queryAll<{ fact_key: string }>(
    `SELECT fact_key FROM workflow_graph_facts
      WHERE graph_run_id = ? AND fact_key IN (${inputs.map(() => '?').join(', ')})`,
    [graphRunId, ...inputs.map((input) => input.factKey)],
  );
  if (existing.length > 0) {
    for (const input of inputs) chargeAndInsertGraphFact(transaction, input);
    return;
  }

  const run = transaction.queryOne<{
    ledger_seq: number;
    ledger_head_hash: Sha256Hash;
  }>(
    'SELECT ledger_seq, ledger_head_hash FROM workflow_graph_runs WHERE id = ?',
    [graphRunId],
  );
  const account = transaction.queryOne<{
    id: string;
    hard_limit: number;
    reserved_amount: number;
    consumed_amount: number;
    row_version: number;
  }>(
    'SELECT id, hard_limit, reserved_amount, consumed_amount, row_version FROM workflow_graph_resource_accounts WHERE graph_run_id = ? AND resource_type = ?',
    [graphRunId, 'facts_total'],
  );
  if (!run)
    throw new G5RuntimeError('precondition_failed', 'Ledger Run is missing');
  if (
    !account ||
    account.reserved_amount + account.consumed_amount + inputs.length >
      account.hard_limit
  )
    throw new G5RuntimeError(
      'resource_unavailable',
      'Ledger quota exhausted: facts_total',
    );

  let sequence = run.ledger_seq;
  let previousHash = run.ledger_head_hash;
  for (const input of inputs) {
    const reservationGroupId = stableRuntimeId('reservation-group', {
      graph_run_id: graphRunId,
      fact_id: input.id,
      purpose: 'fixed_point_fact',
    });
    const reservationId = stableRuntimeId('reservation', {
      reservation_group_id: reservationGroupId,
      resource_type: 'facts_total',
    });
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservations (
       id, graph_run_id, reservation_group_id, consumer_workflow_id,
       consumer_build_id, consumer_scope_id, consumer_node_id,
       consumer_attempt_id, consumer_wait_id, consumer_effect_id,
       consumer_fact_id, resource_type, purpose, settlement_mode,
       reserved_remaining, consumed_amount, status, created_at_ms,
       settled_at_ms, row_version
     ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?,
       'facts_total', 'fixed_point_fact', 'consume_on_create', 0, 1,
       'committed', ?, ?, 1)`,
      [
        reservationId,
        graphRunId,
        reservationGroupId,
        input.id,
        input.createdAtMs,
        input.createdAtMs,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservation_postings (
       reservation_id, account_id, reserved_remaining, consumed_amount,
       status, row_version
     ) VALUES (?, ?, 0, 1, 'committed', 1)`,
      [reservationId, account.id],
    );
    sequence += 1;
    const payload: JsonObject = {
      graph_run_id: graphRunId,
      ledger_seq: sequence,
      reservation_group_id: reservationGroupId,
      account_id: account.id,
      reservation_id: reservationId,
      operation: 'charge',
      delta_reserved: 0,
      delta_consumed: 1,
      idempotency_key: `charge:${reservationId}`,
      previous_chain_hash: previousHash,
      created_at_ms: input.createdAtMs,
    };
    const chainHash = ledgerHash(payload);
    transaction.execute(
      `INSERT INTO workflow_graph_resource_ledger_entries (
       id, graph_run_id, ledger_seq, reservation_group_id, account_id,
       reservation_id, operation, delta_reserved, delta_consumed,
       idempotency_key, previous_chain_hash, chain_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'charge', 0, 1, ?, ?, ?, ?)`,
      [
        stableRuntimeId('ledger-entry', {
          graph_run_id: graphRunId,
          ledger_seq: sequence,
        }),
        graphRunId,
        sequence,
        reservationGroupId,
        account.id,
        reservationId,
        `charge:${reservationId}`,
        previousHash,
        chainHash,
        input.createdAtMs,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_facts (
       id, graph_run_id, scope_id, event_seq, causal_event_seq, causal_wave,
       fact_kind, stable_object_kind, stable_object_id, fact_key,
       payload_value_id, payload_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        graphRunId,
        input.scopeId,
        input.eventSeq,
        input.causalEventSeq,
        input.causalWave,
        input.factKind,
        input.stableObjectKind,
        input.stableObjectId,
        input.factKey,
        input.payloadValueId,
        input.payloadHash,
        input.createdAtMs,
      ],
    );
    previousHash = chainHash;
  }

  if (
    transaction.execute(
      'UPDATE workflow_graph_resource_accounts SET consumed_amount = consumed_amount + ?, row_version = row_version + ? WHERE id = ? AND row_version = ? AND reserved_amount + consumed_amount + ? <= hard_limit',
      [
        inputs.length,
        inputs.length,
        account.id,
        account.row_version,
        inputs.length,
      ],
    ).changes !== 1
  )
    throw new G5RuntimeError(
      'cas_conflict',
      `Ledger account changed: ${account.id}`,
    );
  if (
    transaction.execute(
      'UPDATE workflow_graph_runs SET ledger_seq = ?, ledger_head_hash = ?, row_version = row_version + ?, updated_at_ms = ? WHERE id = ? AND ledger_seq = ? AND ledger_head_hash = ?',
      [
        sequence,
        previousHash,
        inputs.length,
        inputs.at(-1)!.createdAtMs,
        graphRunId,
        run.ledger_seq,
        run.ledger_head_hash,
      ],
    ).changes !== 1
  )
    throw new G5RuntimeError('cas_conflict', 'Ledger head CAS failed');
}

export function chargeWorkflowLifetimeResources(
  transaction: WorkflowRuntimeWriteTransaction,
  input: {
    readonly graphRunId: string;
    readonly workflowId: string;
    readonly accountWorkflowId?: string;
    readonly reservationGroupId: string;
    readonly amounts: Readonly<Record<string, number>>;
    readonly purpose: string;
    readonly nowMs: number;
  },
): string[] {
  const run = transaction.queryOne<{
    ledger_seq: number;
    ledger_head_hash: Sha256Hash;
  }>(
    'SELECT ledger_seq, ledger_head_hash FROM workflow_graph_runs WHERE id = ?',
    [input.graphRunId],
  );
  if (!run)
    throw new G5RuntimeError('precondition_failed', 'Ledger Run is missing');

  let sequence = run.ledger_seq;
  let previousHash = run.ledger_head_hash;
  const reservationIds: string[] = [];
  for (const [resourceType, amount] of Object.entries(input.amounts).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new G5RuntimeError(
        'contract_invalid',
        `Invalid workflow lifetime charge for ${resourceType}`,
      );
    const account = transaction.queryOne<{
      id: string;
      hard_limit: number;
      reserved_amount: number;
      consumed_amount: number;
      row_version: number;
    }>(
      'SELECT id, hard_limit, reserved_amount, consumed_amount, row_version FROM workflow_graph_resource_accounts WHERE workflow_id = ? AND resource_type = ?',
      [input.accountWorkflowId ?? input.workflowId, resourceType],
    );
    if (
      !account ||
      account.reserved_amount + account.consumed_amount + amount >
        account.hard_limit
    )
      throw new G5RuntimeError(
        'resource_unavailable',
        `Workflow lifetime quota exhausted: ${resourceType}`,
      );
    const reservationId = stableRuntimeId('reservation', {
      reservation_group_id: input.reservationGroupId,
      resource_type: resourceType,
    });
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservations (
       id, graph_run_id, reservation_group_id, consumer_workflow_id,
       consumer_build_id, consumer_scope_id, consumer_node_id,
       consumer_attempt_id, consumer_wait_id, consumer_effect_id,
       consumer_fact_id, resource_type, purpose, settlement_mode,
       reserved_remaining, consumed_amount, status, created_at_ms,
       settled_at_ms, row_version
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?,
       'consume_on_create', 0, ?, 'committed', ?, ?, 1)`,
      [
        reservationId,
        input.graphRunId,
        input.reservationGroupId,
        input.workflowId,
        resourceType,
        input.purpose,
        amount,
        input.nowMs,
        input.nowMs,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_graph_resource_reservation_postings (
       reservation_id, account_id, reserved_remaining, consumed_amount,
       status, row_version
     ) VALUES (?, ?, 0, ?, 'committed', 1)`,
      [reservationId, account.id, amount],
    );
    if (
      transaction.execute(
        'UPDATE workflow_graph_resource_accounts SET consumed_amount = consumed_amount + ?, row_version = row_version + 1 WHERE id = ? AND row_version = ? AND reserved_amount + consumed_amount + ? <= hard_limit',
        [amount, account.id, account.row_version, amount],
      ).changes !== 1
    )
      throw new G5RuntimeError(
        'cas_conflict',
        `Workflow lifetime account changed: ${account.id}`,
      );
    sequence += 1;
    const payload: JsonObject = {
      graph_run_id: input.graphRunId,
      ledger_seq: sequence,
      reservation_group_id: input.reservationGroupId,
      account_id: account.id,
      reservation_id: reservationId,
      operation: 'charge',
      delta_reserved: 0,
      delta_consumed: amount,
      idempotency_key: `charge:${reservationId}`,
      previous_chain_hash: previousHash,
      created_at_ms: input.nowMs,
    };
    const chainHash = ledgerHash(payload);
    transaction.execute(
      `INSERT INTO workflow_graph_resource_ledger_entries (
       id, graph_run_id, ledger_seq, reservation_group_id, account_id,
       reservation_id, operation, delta_reserved, delta_consumed,
       idempotency_key, previous_chain_hash, chain_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'charge', 0, ?, ?, ?, ?, ?)`,
      [
        stableRuntimeId('ledger-entry', {
          graph_run_id: input.graphRunId,
          ledger_seq: sequence,
        }),
        input.graphRunId,
        sequence,
        input.reservationGroupId,
        account.id,
        reservationId,
        amount,
        `charge:${reservationId}`,
        previousHash,
        chainHash,
        input.nowMs,
      ],
    );
    previousHash = chainHash;
    reservationIds.push(reservationId);
  }
  if (
    transaction.execute(
      'UPDATE workflow_graph_runs SET ledger_seq = ?, ledger_head_hash = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND ledger_seq = ? AND ledger_head_hash = ?',
      [
        sequence,
        previousHash,
        input.nowMs,
        input.graphRunId,
        run.ledger_seq,
        run.ledger_head_hash,
      ],
    ).changes !== 1
  )
    throw new G5RuntimeError(
      'cas_conflict',
      'Workflow lifetime ledger CAS failed',
    );
  return reservationIds;
}

export function releaseLedgerReservationGroup(
  transaction: WorkflowRuntimeWriteTransaction,
  graphRunId: string,
  reservationGroupId: string,
  nowMs: number,
): number {
  const run = transaction.queryOne<{
    ledger_seq: number;
    ledger_head_hash: Sha256Hash;
    row_version: number;
  }>(
    'SELECT ledger_seq, ledger_head_hash, row_version FROM workflow_graph_runs WHERE id = ?',
    [graphRunId],
  );
  if (!run)
    throw new G5RuntimeError('precondition_failed', 'Ledger Run is missing');
  const reservations = transaction.queryAll<{
    id: string;
    reserved_remaining: number;
    status: string;
    row_version: number;
    account_id: string;
    posting_row_version: number;
    account_row_version: number;
  }>(
    `SELECT r.id, r.reserved_remaining, r.status, r.row_version,
            p.account_id, p.row_version AS posting_row_version,
            a.row_version AS account_row_version
       FROM workflow_graph_resource_reservations r
       JOIN workflow_graph_resource_reservation_postings p ON p.reservation_id = r.id
       JOIN workflow_graph_resource_accounts a ON a.id = p.account_id
      WHERE r.graph_run_id = ? AND r.reservation_group_id = ?
      ORDER BY r.resource_type COLLATE BINARY`,
    [graphRunId, reservationGroupId],
  );
  let sequence = run.ledger_seq;
  let previousHash = run.ledger_head_hash;
  let released = 0;
  for (const reservation of reservations) {
    if (reservation.status !== 'held') continue;
    if (
      transaction.execute(
        'UPDATE workflow_graph_resource_accounts SET reserved_amount = reserved_amount - ?, row_version = row_version + 1 WHERE id = ? AND row_version = ? AND reserved_amount >= ?',
        [
          reservation.reserved_remaining,
          reservation.account_id,
          reservation.account_row_version,
          reservation.reserved_remaining,
        ],
      ).changes !== 1
    )
      throw new G5RuntimeError(
        'cas_conflict',
        'Ledger release account CAS failed',
      );
    transaction.execute(
      "UPDATE workflow_graph_resource_reservation_postings SET reserved_remaining = 0, status = 'released', row_version = row_version + 1 WHERE reservation_id = ? AND account_id = ? AND row_version = ? AND status = 'held'",
      [reservation.id, reservation.account_id, reservation.posting_row_version],
    );
    transaction.execute(
      "UPDATE workflow_graph_resource_reservations SET reserved_remaining = 0, status = 'released', settled_at_ms = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ? AND status = 'held'",
      [nowMs, reservation.id, reservation.row_version],
    );
    sequence += 1;
    const payload: JsonObject = {
      graph_run_id: graphRunId,
      ledger_seq: sequence,
      reservation_group_id: reservationGroupId,
      account_id: reservation.account_id,
      reservation_id: reservation.id,
      operation: 'release',
      delta_reserved: reservation.reserved_remaining,
      delta_consumed: 0,
      idempotency_key: `release:${reservation.id}`,
      previous_chain_hash: previousHash,
      created_at_ms: nowMs,
    };
    const chainHash = ledgerHash(payload);
    transaction.execute(
      "INSERT INTO workflow_graph_resource_ledger_entries (id, graph_run_id, ledger_seq, reservation_group_id, account_id, reservation_id, operation, delta_reserved, delta_consumed, idempotency_key, previous_chain_hash, chain_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'release', ?, 0, ?, ?, ?, ?)",
      [
        stableRuntimeId('ledger-entry', {
          graph_run_id: graphRunId,
          ledger_seq: sequence,
        }),
        graphRunId,
        sequence,
        reservationGroupId,
        reservation.account_id,
        reservation.id,
        reservation.reserved_remaining,
        `release:${reservation.id}`,
        previousHash,
        chainHash,
        nowMs,
      ],
    );
    previousHash = chainHash;
    released += 1;
  }
  if (released > 0) {
    if (
      transaction.execute(
        'UPDATE workflow_graph_runs SET ledger_seq = ?, ledger_head_hash = ?, row_version = row_version + 1, updated_at_ms = ? WHERE id = ? AND ledger_seq = ? AND ledger_head_hash = ?',
        [
          sequence,
          previousHash,
          nowMs,
          graphRunId,
          run.ledger_seq,
          run.ledger_head_hash,
        ],
      ).changes !== 1
    )
      throw new G5RuntimeError(
        'cas_conflict',
        'Ledger release head CAS failed',
      );
  }
  return released;
}
