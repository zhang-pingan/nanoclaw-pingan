import fs from 'node:fs';
import path from 'node:path';

import type { DeploymentRuntimeCapacityPublication } from '../contracts/capacity-control-plane-types.js';
import {
  buildDeploymentCapacityPublication,
  validateCapacityPublication,
} from '../contracts/capacity-control-plane-source.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { RuntimeRegistryRef } from '../contracts/g5-basic-runtime-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  insertInlineValue,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from '../runtime/graph-store.js';
import { appendCapacityEvent } from './admin-gateway.js';

interface CapacityLineageRow extends Record<string, unknown> {
  command_id: string;
  assigned_capacity_revision: number;
  assigned_change_id: string;
  proposed_capacity_json: string;
  proposed_config_hash: Sha256Hash;
  canonical_result_value_id: string | null;
  canonical_result_hash: Sha256Hash | null;
  finalized_at_ms: number | null;
}

interface CapacityHeadRow extends Record<string, unknown> {
  current_capacity_revision: number | null;
  current_change_id: string | null;
  current_config_hash: Sha256Hash | null;
  current_publication_hash: Sha256Hash | null;
  pending_change_id: string | null;
  row_version: number;
}

export class CapacitySnapshotPublisher {
  readonly publicationPath: string;

  constructor(publicationPath: string) {
    if (
      !path.isAbsolute(publicationPath) ||
      path.basename(publicationPath) !== 'workflow-runtime-capacity.json'
    ) {
      throw new G5RuntimeError(
        'contract_invalid',
        'Capacity publication requires an absolute workflow-runtime-capacity.json path',
      );
    }
    const parent = path.dirname(publicationPath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (
      fs.realpathSync(parent) !== parent ||
      (fs.existsSync(publicationPath) &&
        fs.lstatSync(publicationPath).isSymbolicLink())
    ) {
      throw new G5RuntimeError(
        'integrity_violation',
        'Capacity publication path is not canonical',
      );
    }
    this.publicationPath = publicationPath;
  }

  installCAP2(
    store: WorkflowRuntimeStore,
    publication: DeploymentRuntimeCapacityPublication,
    nowMs: number,
    fault?: 'after_file_fsync_before_rename' | 'after_rename_before_event',
  ): void {
    if (validateCapacityPublication(publication) !== null)
      throw new G5RuntimeError(
        'contract_invalid',
        'CAP2 publication is invalid',
      );
    const bytes = `${canonicalJson(publication as unknown as JsonValue)}\n`;
    const temporary = `${this.publicationPath}.tmp-${process.pid}-${publication.capacity_change_id}`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, bytes, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (fault === 'after_file_fsync_before_rename') {
      fs.rmSync(temporary, { force: true });
      throw new G5RuntimeError(
        'fault_injected',
        'Injected CAP2 fault before rename',
      );
    }
    fs.renameSync(temporary, this.publicationPath);
    const parentDescriptor = fs.openSync(
      path.dirname(this.publicationPath),
      'r',
    );
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
    if (fault === 'after_rename_before_event')
      throw new G5RuntimeError(
        'fault_injected',
        'Injected CAP2 fault after rename',
      );
    runImmediateG5Transaction(store, (transaction) => {
      const lineage = transaction.queryOne<CapacityLineageRow>(
        'SELECT command_id, assigned_capacity_revision, assigned_change_id, proposed_capacity_json, proposed_config_hash, canonical_result_value_id, canonical_result_hash, finalized_at_ms FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?',
        [publication.capacity_change_id],
      );
      const head = transaction.queryOne<CapacityHeadRow>(
        'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
        [],
      );
      const pendingInstall =
        head?.pending_change_id === publication.capacity_change_id;
      const committedRecovery =
        head?.pending_change_id === null &&
        head.current_capacity_revision === publication.capacity_revision &&
        head.current_change_id === publication.capacity_change_id &&
        head.current_config_hash === publication.capacity.config_hash &&
        head.current_publication_hash === publication.publication_hash;
      if (
        !lineage ||
        (!pendingInstall && !committedRecovery) ||
        lineage.proposed_config_hash !== publication.capacity.config_hash ||
        lineage.assigned_capacity_revision !== publication.capacity_revision
      )
        throw new G5RuntimeError(
          'precondition_failed',
          'CAP2 has no matching durable CAP1',
        );
      const already = transaction.queryOne<{ event_seq: number }>(
        "SELECT event_seq FROM runtime_capacity_change_events WHERE change_id = ? AND event_type = 'file_installed'",
        [publication.capacity_change_id],
      );
      if (!already)
        appendCapacityEvent(transaction, {
          changeId: publication.capacity_change_id,
          commandId: lineage.command_id,
          capacityRevision: publication.capacity_revision,
          eventType: 'file_installed',
          configHash: publication.capacity.config_hash,
          publicationHash: publication.publication_hash,
          createdAtMs: nowMs,
        });
    });
  }

  readStrict(): DeploymentRuntimeCapacityPublication {
    const parsed = strictParseJsonBytes(fs.readFileSync(this.publicationPath));
    assertJsonObject(parsed);
    const publication =
      parsed as unknown as DeploymentRuntimeCapacityPublication;
    const error = validateCapacityPublication(publication);
    if (error)
      throw new G5RuntimeError(
        'integrity_violation',
        `Capacity publication rejected: ${error}`,
      );
    if (
      `${canonicalJson(publication as unknown as JsonValue)}\n` !==
      fs.readFileSync(this.publicationPath, 'utf8')
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Capacity publication bytes are not canonical',
      );
    return publication;
  }

  commitHeadCAP3(
    store: WorkflowRuntimeStore,
    publication: DeploymentRuntimeCapacityPublication,
    nowMs: number,
    fault?: G5TransactionFault,
  ): void {
    const disk = this.readStrict();
    if (
      canonicalJson(disk as unknown as JsonValue) !==
      canonicalJson(publication as unknown as JsonValue)
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'CAP3 disk publication differs from prepared bytes',
      );
    runImmediateG5Transaction(
      store,
      (transaction) => {
        const lineage = transaction.queryOne<CapacityLineageRow>(
          'SELECT command_id, assigned_capacity_revision, assigned_change_id, proposed_capacity_json, proposed_config_hash, canonical_result_value_id, canonical_result_hash, finalized_at_ms FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?',
          [publication.capacity_change_id],
        );
        const head = transaction.queryOne<CapacityHeadRow>(
          'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
          [],
        );
        if (!lineage || !head)
          throw new G5RuntimeError(
            'precondition_failed',
            'CAP3 durable lineage is missing',
          );
        if (
          head.current_change_id === publication.capacity_change_id &&
          head.current_publication_hash === publication.publication_hash &&
          head.pending_change_id === null
        )
          return;
        if (
          head.pending_change_id !== publication.capacity_change_id ||
          lineage.assigned_capacity_revision !==
            publication.capacity_revision ||
          lineage.proposed_config_hash !== publication.capacity.config_hash
        )
          throw new G5RuntimeError(
            'cas_conflict',
            'CAP3 pending lineage changed',
          );
        const changed = transaction.execute(
          `UPDATE runtime_capacity_head
            SET current_capacity_revision = ?, current_change_id = ?,
                current_config_hash = ?, current_publication_hash = ?,
                pending_change_id = NULL, row_version = row_version + 1,
                updated_at_ms = ?
          WHERE singleton_key = 1 AND row_version = ? AND pending_change_id = ?`,
          [
            publication.capacity_revision,
            publication.capacity_change_id,
            publication.capacity.config_hash,
            publication.publication_hash,
            nowMs,
            head.row_version,
            publication.capacity_change_id,
          ],
        ).changes;
        if (changed !== 1)
          throw new G5RuntimeError('cas_conflict', 'CAP3 head CAS failed');
        appendCapacityEvent(transaction, {
          changeId: publication.capacity_change_id,
          commandId: lineage.command_id,
          capacityRevision: publication.capacity_revision,
          eventType: 'head_committed',
          configHash: publication.capacity.config_hash,
          publicationHash: publication.publication_hash,
          createdAtMs: nowMs,
        });
      },
      fault,
    );
  }
}

export class CapacitySnapshotWatcher {
  #current: Readonly<DeploymentRuntimeCapacityPublication> | null = null;

  current(): Readonly<DeploymentRuntimeCapacityPublication> | null {
    return this.#current;
  }

  publishCAP4(
    store: WorkflowRuntimeStore,
    publisher: CapacitySnapshotPublisher,
    resultSchema: RuntimeRegistryRef,
    nowMs: number,
    fault?: G5TransactionFault,
  ): Readonly<DeploymentRuntimeCapacityPublication> {
    const publication = publisher.readStrict();
    const result = runImmediateG5Transaction(
      store,
      (transaction) => {
        const head = transaction.queryOne<CapacityHeadRow>(
          'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
          [],
        );
        const lineage = transaction.queryOne<CapacityLineageRow>(
          'SELECT command_id, assigned_capacity_revision, assigned_change_id, proposed_capacity_json, proposed_config_hash, canonical_result_value_id, canonical_result_hash, finalized_at_ms FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?',
          [publication.capacity_change_id],
        );
        if (
          !head ||
          !lineage ||
          head.pending_change_id !== null ||
          head.current_capacity_revision !== publication.capacity_revision ||
          head.current_change_id !== publication.capacity_change_id ||
          head.current_config_hash !== publication.capacity.config_hash ||
          head.current_publication_hash !== publication.publication_hash
        )
          throw new G5RuntimeError(
            'precondition_failed',
            'Watcher publication does not exactly match committed head',
          );
        if (
          lineage.canonical_result_value_id &&
          lineage.canonical_result_hash &&
          lineage.finalized_at_ms !== null
        )
          return {
            id: lineage.canonical_result_value_id,
            hash: lineage.canonical_result_hash,
          };
        const payload: JsonObject = {
          format: 'icarus.capacity-admin-result/1',
          command_id: lineage.command_id,
          disposition: 'applied',
          capacity_revision: publication.capacity_revision,
          capacity_change_id: publication.capacity_change_id,
          config_hash: publication.capacity.config_hash,
          publication_hash: publication.publication_hash,
        };
        const resultHash = awaitlessCapacityResultHash(payload);
        const resultId = stableRuntimeId('capacity-result', {
          command_id: lineage.command_id,
          result_hash: resultHash,
        });
        insertInlineValue(transaction, {
          id: resultId,
          content: payload,
          contentHash: resultHash,
          schemaResourceId: resultSchema.rowId,
          schemaResourceHash: resultSchema.hash,
          provenanceRef: 'icarus.workflow-capacity-admin/1',
          retentionClass: 'workflow_audit',
          createdAtMs: nowMs,
        });
        appendCapacityEvent(transaction, {
          changeId: publication.capacity_change_id,
          commandId: lineage.command_id,
          capacityRevision: publication.capacity_revision,
          eventType: 'watcher_published',
          configHash: publication.capacity.config_hash,
          publicationHash: publication.publication_hash,
          createdAtMs: nowMs,
        });
        const changed = transaction.execute(
          'UPDATE runtime_capacity_admin_commands SET canonical_result_value_id = ?, canonical_result_hash = ?, finalized_at_ms = ? WHERE command_id = ? AND canonical_result_value_id IS NULL AND finalized_at_ms IS NULL',
          [resultId, resultHash, nowMs, lineage.command_id],
        ).changes;
        if (changed !== 1)
          throw new G5RuntimeError(
            'cas_conflict',
            'CAP4 Command finalization CAS failed',
          );
        return { id: resultId, hash: resultHash };
      },
      fault,
    );
    void result;
    this.#current = Object.freeze(structuredClone(publication));
    return this.#current;
  }
}

function awaitlessCapacityResultHash(payload: JsonObject): Sha256Hash {
  return domainSeparatedSha256('icarus:capacity-admin-result:1\n', payload);
}

export function recoverCapacityPublication(
  store: WorkflowRuntimeStore,
  publisher: CapacitySnapshotPublisher,
  watcher: CapacitySnapshotWatcher,
  resultSchema: RuntimeRegistryRef,
  nowMs: number,
): Readonly<DeploymentRuntimeCapacityPublication> | null {
  const head = store.queryOne<CapacityHeadRow>(
    'SELECT current_capacity_revision, current_change_id, current_config_hash, current_publication_hash, pending_change_id, row_version FROM runtime_capacity_head WHERE singleton_key = 1',
    [],
  );
  if (!head) return null;
  const changeId = head.pending_change_id ?? head.current_change_id;
  if (!changeId) return null;
  const lineage = store.queryOne<CapacityLineageRow>(
    'SELECT command_id, assigned_capacity_revision, assigned_change_id, proposed_capacity_json, proposed_config_hash, canonical_result_value_id, canonical_result_hash, finalized_at_ms FROM runtime_capacity_admin_commands WHERE assigned_change_id = ?',
    [changeId],
  );
  if (!lineage)
    throw new G5RuntimeError(
      'integrity_violation',
      'Capacity head has no audited command lineage',
    );
  const previous =
    lineage.assigned_capacity_revision === 1
      ? null
      : store.queryOne<{ proposed_config_hash: Sha256Hash }>(
          `SELECT proposed_config_hash
             FROM runtime_capacity_admin_commands
            WHERE assigned_capacity_revision = ?`,
          [lineage.assigned_capacity_revision - 1],
        );
  const previousConfigHash = previous?.proposed_config_hash ?? null;
  const expected = buildDeploymentCapacityPublication(
    lineage.assigned_capacity_revision,
    lineage.assigned_change_id,
    previousConfigHash,
    JSON.parse(lineage.proposed_capacity_json),
  );
  let diskState: 'absent' | 'matching' | 'unauthorized' = 'absent';
  try {
    diskState =
      canonicalJson(publisher.readStrict() as unknown as JsonValue) ===
      canonicalJson(expected as unknown as JsonValue)
        ? 'matching'
        : 'unauthorized';
  } catch {
    diskState = fs.existsSync(publisher.publicationPath)
      ? 'unauthorized'
      : 'absent';
  }
  const fileInstalled = store.queryOne<{ event_seq: number }>(
    "SELECT event_seq FROM runtime_capacity_change_events WHERE change_id = ? AND event_type = 'file_installed'",
    [changeId],
  );
  if (diskState === 'unauthorized')
    runImmediateG5Transaction(store, (transaction) => {
      appendCapacityEvent(transaction, {
        changeId,
        commandId: lineage.command_id,
        capacityRevision: expected.capacity_revision,
        eventType: 'unauthorized_file_rejected',
        configHash: expected.capacity.config_hash,
        publicationHash: expected.publication_hash,
        createdAtMs: nowMs,
      });
    });
  if (
    diskState !== 'matching' ||
    (head.pending_change_id !== null && !fileInstalled)
  )
    publisher.installCAP2(store, expected, nowMs);
  if (head.pending_change_id !== null)
    publisher.commitHeadCAP3(store, expected, nowMs);
  return watcher.publishCAP4(store, publisher, resultSchema, nowMs);
}
