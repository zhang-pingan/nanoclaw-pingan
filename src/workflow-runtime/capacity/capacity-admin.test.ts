import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { calculateDeploymentCapacityConfigHash } from '../contracts/capacity-control-plane-source.js';
import type { ReplaceDeploymentCapacityCommand } from '../contracts/capacity-control-plane-types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  createG5TestBootstrap,
  type G5TestBootstrapInstance,
} from '../runtime/g5-test-bootstrap.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  prepareCapacityChangeCAP0CAP1,
  type CapacityAuthenticatedInvocation,
} from './admin-gateway.js';
import {
  CapacitySnapshotPublisher,
  CapacitySnapshotWatcher,
  recoverCapacityPublication,
} from './publication.js';

const instances: G5TestBootstrapInstance[] = [];
const hash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g5-capacity-test:1\n', { label });

function bootstrap(key: string): G5TestBootstrapInstance {
  const instance = createG5TestBootstrap(key);
  instances.push(instance);
  return instance;
}

function seedAuditValues(store: WorkflowRuntimeStore): {
  schema: {
    rowId: string;
    resourceType: string;
    ref: { id: string; version: string };
    hash: Sha256Hash;
  };
  evidence: { id: string; hash: Sha256Hash };
  reason: { id: string; hash: Sha256Hash };
} {
  const schemaHash = hash('schema');
  const evidenceHash = hash('evidence');
  const reasonHash = hash('reason');
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES ('value:schema', 'inline', '{}', NULL, NULL, NULL, ?, 2,
       'application/json', 'resource:schema', ?, 'g5-test', 'pinned', 'live',
       NULL, 1, 1)`,
      [schemaHash, schemaHash],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_resources (
       id, resource_type, resource_id, resource_version, owner_core_ref,
       owner_pack_id, canonical_value_id, content_hash, publication_state,
       created_at_ms, published_at_ms, retired_at_ms, row_version
     ) VALUES ('resource:schema', 'schema', 'g5.capacity-result', '1.0.0',
       'icarus.core@1.0.0', NULL, 'value:schema', ?, 'published', 1, 1, NULL, 1)`,
      [schemaHash],
    );
    transaction.execute(
      `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES ('value:evidence', 'inline', '{"evidence":["core","baseline"]}',
       NULL, NULL, NULL, ?, 32, 'application/json', 'resource:schema', ?,
       'g5-test', 'workflow_audit', 'live', NULL, 1, 1)`,
      [evidenceHash, schemaHash],
    );
    transaction.execute(
      `INSERT INTO workflow_values (
       id, storage_kind, inline_canonical_json, blob_hash,
       immutable_external_locator, expected_hash, content_hash, byte_length,
       media_type, schema_resource_id, schema_resource_hash, provenance_ref,
       retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
       row_version
     ) VALUES ('value:reason', 'inline', '"local capacity tuning"',
       NULL, NULL, NULL, ?, 23, 'application/json', 'resource:schema', ?,
       'g5-test', 'workflow_audit', 'live', NULL, 1, 1)`,
      [reasonHash, schemaHash],
    );
  });
  return {
    schema: {
      rowId: 'resource:schema',
      resourceType: 'schema',
      ref: { id: 'g5.capacity-result', version: '1.0.0' },
      hash: schemaHash,
    },
    evidence: { id: 'value:evidence', hash: evidenceHash },
    reason: { id: 'value:reason', hash: reasonHash },
  };
}

function command(
  store: WorkflowRuntimeStore,
): ReplaceDeploymentCapacityCommand {
  const head = store.queryOne<{
    current_capacity_revision: number;
    current_config_hash: Sha256Hash;
  }>(
    'SELECT current_capacity_revision, current_config_hash FROM runtime_capacity_head WHERE singleton_key = 1',
    [],
  );
  if (!head) throw new Error('missing local Capacity defaults');
  const payload = {
    max_active_executions: 5,
    max_active_waits: 256,
    max_pending_signals: 2048,
    max_outbox_inflight: 16,
    max_physical_blob_bytes: 21_474_836_480,
    soft_blob_high_water_bytes: 17_179_869_184,
    minimum_free_disk_bytes: 5_368_709_120,
  };
  return {
    command_type: 'replace_deployment_capacity',
    command_id: 'capacity-command-1',
    idempotency_key: 'capacity-init-1',
    expected_capacity_revision: head.current_capacity_revision,
    expected_config_hash: head.current_config_hash,
    proposed_capacity: {
      ...payload,
      config_hash: calculateDeploymentCapacityConfigHash(payload),
    },
    reason_code: 'planned_tuning',
    reason_text: 'Exercise local Capacity administration after defaults',
    evidence_refs: ['local-owner-request'],
  };
}

function invocation(): CapacityAuthenticatedInvocation {
  return {
    authenticated: true,
    actorRef: 'human:local-owner',
    sessionActorRef: 'human:local-owner',
    actorKind: 'human',
    authSessionRef: 'auth:local-owner',
    entrypoint: 'cli',
    delegationChainRef: null,
    permissions: ['runtime.capacity.manage'],
    requestedAtMs: 10,
  };
}

afterEach(() => {
  while (instances.length > 0) instances.pop()!.cleanup();
});

describe('G5 Capacity Admin CAP0-CAP4 local administration', () => {
  it('keeps CAP1 prepared immutable, finalizes only at CAP4, and appends duplicate', () => {
    const instance = bootstrap('g5-capacity-happy');
    const values = seedAuditValues(instance.store);
    const candidate = command(instance.store);
    const prepared = prepareCapacityChangeCAP0CAP1(
      instance.store,
      candidate,
      invocation(),
      {
        evidenceManifest: values.evidence,
        reasonText: values.reason,
        resultSchema: values.schema,
      },
      11,
    );
    expect(prepared.disposition).toBe('prepared');
    if (!('publication' in prepared) || !prepared.publication)
      throw new Error('missing publication');
    const publisher = new CapacitySnapshotPublisher(
      path.join(instance.dataRoot, 'workflow-runtime-capacity.json'),
    );
    const watcher = new CapacitySnapshotWatcher();
    publisher.installCAP2(instance.store, prepared.publication, 12);
    publisher.commitHeadCAP3(instance.store, prepared.publication, 13);
    expect(
      instance.store.queryOne<{ finalized_at_ms: number | null }>(
        'SELECT finalized_at_ms FROM runtime_capacity_admin_commands WHERE command_id = ?',
        [candidate.command_id],
      )!.finalized_at_ms,
    ).toBeNull();
    watcher.publishCAP4(instance.store, publisher, values.schema, 14);
    const first = instance.store.queryOne<{
      execution_result: string;
      applied_at_ms: number | null;
    }>(
      'SELECT execution_result, applied_at_ms FROM runtime_capacity_admin_invocations WHERE command_id = ? AND invocation_no = 1',
      [candidate.command_id],
    )!;
    expect(first).toEqual({
      execution_result: 'prepared',
      applied_at_ms: null,
    });
    const deniedReplay = prepareCapacityChangeCAP0CAP1(
      instance.store,
      candidate,
      {
        ...invocation(),
        actorRef: 'system:untrusted',
        sessionActorRef: 'system:untrusted',
        requestedAtMs: 15,
      },
      {
        evidenceManifest: values.evidence,
        reasonText: values.reason,
        resultSchema: values.schema,
      },
      16,
    );
    expect(deniedReplay.disposition).toBe('denied');
    if (deniedReplay.disposition === 'authentication_rejected')
      throw new Error('unexpected authentication rejection');
    expect(deniedReplay.denialCode).toBe('permission_denied');
    const duplicate = prepareCapacityChangeCAP0CAP1(
      instance.store,
      candidate,
      { ...invocation(), requestedAtMs: 17 },
      {
        evidenceManifest: values.evidence,
        reasonText: values.reason,
        resultSchema: values.schema,
      },
      18,
    );
    expect(duplicate.disposition).toBe('duplicate');
    const conflict = prepareCapacityChangeCAP0CAP1(
      instance.store,
      {
        ...candidate,
        reason_code: 'rollback',
      },
      invocation(),
      {
        evidenceManifest: values.evidence,
        reasonText: values.reason,
        resultSchema: values.schema,
      },
      19,
    );
    expect(conflict).toMatchObject({
      disposition: 'conflict',
      denialCode: 'idempotency_conflict',
    });
    expect(
      instance.store.queryAll<{ execution_result: string }>(
        'SELECT execution_result FROM runtime_capacity_admin_invocations WHERE command_id = ? ORDER BY invocation_no',
        [candidate.command_id],
      ),
    ).toEqual([
      { execution_result: 'prepared' },
      { execution_result: 'denied' },
      { execution_result: 'duplicate' },
      { execution_result: 'conflict' },
    ]);
  });

  it('recovers rename/head crash boundaries across Store reopen and rejects tamper', () => {
    const instance = bootstrap('g5-capacity-recovery');
    const values = seedAuditValues(instance.store);
    const candidate = command(instance.store);
    const prepared = prepareCapacityChangeCAP0CAP1(
      instance.store,
      candidate,
      invocation(),
      {
        evidenceManifest: values.evidence,
        reasonText: values.reason,
        resultSchema: values.schema,
      },
      11,
    );
    if (!('publication' in prepared) || !prepared.publication)
      throw new Error('missing publication');
    const publisher = new CapacitySnapshotPublisher(
      path.join(instance.dataRoot, 'workflow-runtime-capacity.json'),
    );
    expect(() =>
      publisher.installCAP2(
        instance.store,
        prepared.publication!,
        12,
        'after_rename_before_event',
      ),
    ).toThrow(/Injected CAP2/);
    instance.closeStore();
    instance.reopenStore();
    const watcher = new CapacitySnapshotWatcher();
    const recovered = recoverCapacityPublication(
      instance.store,
      publisher,
      watcher,
      values.schema,
      20,
    );
    expect(recovered?.publication_hash).toBe(
      prepared.publication.publication_hash,
    );
    instance.closeStore();
    instance.reopenStore();
    const tampered: JsonObject = {
      ...prepared.publication,
      capacity_change_id: 'unaudited-change',
    } as unknown as JsonObject;
    fs.writeFileSync(
      publisher.publicationPath,
      `${JSON.stringify(tampered)}\n`,
      'utf8',
    );
    expect(() =>
      new CapacitySnapshotWatcher().publishCAP4(
        instance.store,
        publisher,
        values.schema,
        21,
      ),
    ).toThrow();
    const restored = recoverCapacityPublication(
      instance.store,
      publisher,
      new CapacitySnapshotWatcher(),
      values.schema,
      22,
    );
    expect(restored?.publication_hash).toBe(
      prepared.publication.publication_hash,
    );
    expect(publisher.readStrict().capacity_change_id).toBe(
      prepared.publication.capacity_change_id,
    );
    expect(
      instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM runtime_capacity_change_events WHERE change_id = ? AND event_type = 'unauthorized_file_rejected'",
        [prepared.publication.capacity_change_id],
      )!.count,
    ).toBe(1);
  });

  it('rolls CAP1 back before commit and records no prepared audit', () => {
    const instance = bootstrap('g5-capacity-rollback');
    const values = seedAuditValues(instance.store);
    const candidate = command(instance.store);
    expect(() =>
      prepareCapacityChangeCAP0CAP1(
        instance.store,
        candidate,
        invocation(),
        {
          evidenceManifest: values.evidence,
          reasonText: values.reason,
          resultSchema: values.schema,
        },
        11,
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM runtime_capacity_admin_commands WHERE command_id = ?',
        [candidate.command_id],
      )!.count,
    ).toBe(0);
  });
});
