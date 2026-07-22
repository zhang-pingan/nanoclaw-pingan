import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  g39FeatureReleaseActivationStoreFixtureForTest,
  rehashG39ActivationRequest,
  withG39PreviousRelease,
} from '../contracts/g3-feature-release-activation-fixtures.js';
import {
  G39_EVENT_DOMAIN,
  g39ActivationCommandId,
  g39SchemaResourceId,
} from '../contracts/g3-feature-release-activation.js';
import type {
  G39FeatureReleaseActivationRequest,
  G39RetentionClaim,
} from '../contracts/g3-feature-release-activation-types.js';
import { registryClosureId } from '../contracts/g3-registry-persistence.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { persistRegistryPersistenceBatch } from '../store/registry-persistence.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import {
  publishStagedWorkflowRelease,
  type WorkflowPublisherApprovedReviewRegistry,
} from './workflow-publisher.js';
import {
  activateFeatureRelease,
  recoverPendingFeatureReleaseActivations,
  type FeatureReleaseActivationFaultPoint,
} from './feature-release-activation.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g3-9-test-'));
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
    identityMode: 'candidate_development',
  });
  stores.push(store);
  return store;
}

function reopen(root: string): WorkflowRuntimeStore {
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'open_existing',
    identityMode: 'candidate_development',
  });
  stores.push(store);
  return store;
}

function reviewRegistry(
  fixture: ReturnType<typeof g39FeatureReleaseActivationStoreFixtureForTest>,
): WorkflowPublisherApprovedReviewRegistry {
  return {
    resolveApprovedReview: (ref, hash) =>
      ref === fixture.approved_review.review_ref &&
      hash === fixture.approved_review.review_hash
        ? structuredClone(fixture.approved_review)
        : null,
  };
}

function seedPublishedTarget(store: WorkflowRuntimeStore) {
  const fixture = g39FeatureReleaseActivationStoreFixtureForTest();
  persistRegistryPersistenceBatch(store, fixture.batch);
  store.withImmediateTransaction((transaction) => {
    for (const resourceId of fixture.prepublished_resource_ids) {
      const result = transaction.execute(
        `UPDATE workflow_registry_resources
            SET publication_state = 'published', published_at_ms = ?,
                row_version = row_version + 1
          WHERE id = ? AND publication_state = 'staged'`,
        [fixture.batch.created_at_ms, resourceId],
      );
      expect(result.changes).toBe(1);
    }
  });
  publishStagedWorkflowRelease(
    store,
    fixture.publisher_request,
    fixture.publisher_invocation,
    reviewRegistry(fixture),
  );
  return fixture;
}

function bytes(request: G39FeatureReleaseActivationRequest): Buffer {
  return Buffer.from(canonicalJson(request), 'utf8');
}

function activationCounts(store: WorkflowRuntimeStore) {
  return store.queryOne<Record<string, number>>(
    `SELECT
      (SELECT COUNT(*) FROM workflow_feature_release_activation_commands) AS commands,
      (SELECT COUNT(*) FROM workflow_feature_release_activation_invocations) AS invocations,
      (SELECT COUNT(*) FROM workflow_feature_release_activation_events) AS events,
      (SELECT COUNT(*) FROM workflow_feature_active_releases) AS pointers`,
    [],
  )!;
}

const PREVIOUS_RELEASE_HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function installActivePrevious(
  store: WorkflowRuntimeStore,
  request: G39FeatureReleaseActivationRequest,
): {
  request: G39FeatureReleaseActivationRequest;
  previousReleaseId: string;
  previousRetentionId: string;
} {
  const previousReleaseId = 'feature-release:fixture.previous@0.9.0';
  const previousRetentionId = 'retention:fixture.previous@0.9.0';
  store.withImmediateTransaction((transaction) => {
    const target = transaction.queryOne<Record<string, string | number | null>>(
      `SELECT execution_artifact_resource_id, execution_artifact_hash,
              compatibility_snapshot_ref, compatibility_snapshot_hash,
              staged_at_ms
         FROM workflow_feature_releases WHERE id = ?`,
      [request.target_release.release_id],
    )!;
    transaction.execute(
      `INSERT INTO workflow_feature_releases (
        id, feature_id, release_ref, release_version, release_hash,
        execution_artifact_resource_id, execution_artifact_hash, status,
        compatibility_snapshot_ref, compatibility_snapshot_hash, staged_at_ms,
        activated_at_ms, disabled_at_ms, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 1)`,
      [
        previousReleaseId,
        request.feature_id,
        'fixture.previous',
        '0.9.0',
        PREVIOUS_RELEASE_HASH,
        target.execution_artifact_resource_id,
        target.execution_artifact_hash,
        target.compatibility_snapshot_ref,
        target.compatibility_snapshot_hash,
        target.staged_at_ms,
        request.requested_at_ms - 1,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_retention_handles (
        id, handle_kind, feature_release_id, graph_run_id, backup_id,
        external_actor_ref, closure_manifest_id, closure_hash, status,
        created_at_ms, released_at_ms, row_version
      ) VALUES (?, 'published', ?, NULL, NULL, NULL, ?, ?, 'held', ?, NULL, 1)`,
      [
        previousRetentionId,
        previousReleaseId,
        registryClosureId(request.target_retention.closure_ref),
        request.target_retention.closure_hash,
        request.requested_at_ms - 1,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_feature_active_releases (
        feature_id, release_id, release_hash, row_version, activated_at_ms
      ) VALUES (?, ?, ?, 1, ?)`,
      [
        request.feature_id,
        previousReleaseId,
        PREVIOUS_RELEASE_HASH,
        request.requested_at_ms - 1,
      ],
    );
  });
  const previousRetention: G39RetentionClaim = {
    handle_id: previousRetentionId,
    handle_kind: 'published',
    feature_release_id: previousReleaseId,
    closure_ref: request.target_retention.closure_ref,
    closure_hash: request.target_retention.closure_hash,
    expected_status: 'held',
    expected_row_version: 1,
  };
  return {
    request: withG39PreviousRelease(
      request,
      {
        release_id: previousReleaseId,
        ref: { id: 'fixture.previous', version: '0.9.0' },
        hash: PREVIOUS_RELEASE_HASH,
        expected_lifecycle: 'active',
      },
      previousRetention,
      1,
    ),
    previousReleaseId,
    previousRetentionId,
  };
}

function transactionFacts(store: WorkflowRuntimeStore) {
  return {
    counts: activationCounts(store),
    releases: store.queryAll(
      `SELECT id, status, activated_at_ms, row_version
         FROM workflow_feature_releases ORDER BY id`,
      [],
    ),
    pointers: store.queryAll(
      `SELECT feature_id, release_id, release_hash, row_version, activated_at_ms
         FROM workflow_feature_active_releases ORDER BY feature_id`,
      [],
    ),
    activationValues: store.queryAll(
      `SELECT id, content_hash FROM workflow_values
        WHERE provenance_ref = 'icarus.feature-release-activation/1'
        ORDER BY id`,
      [],
    ),
  };
}

function insertCleanPending(
  store: WorkflowRuntimeStore,
  request: G39FeatureReleaseActivationRequest,
): void {
  const commandId = g39ActivationCommandId(
    request.idempotency_domain,
    request.idempotency_key,
  );
  const requestValueId = `activation-request:${commandId}`;
  const canonical = canonicalJson(request);
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_values (
        id, storage_kind, inline_canonical_json, blob_hash,
        immutable_external_locator, expected_hash, content_hash, byte_length,
        media_type, schema_resource_id, schema_resource_hash, provenance_ref,
        retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
        row_version
      ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
                ?, ?, 'icarus.feature-release-activation/1', 'pinned', 'live',
                NULL, ?, 1)`,
      [
        requestValueId,
        canonical,
        request.request_hash,
        Buffer.byteLength(canonical, 'utf8'),
        g39SchemaResourceId(request, 'request'),
        request.contract_schemas.request.content_hash,
        request.requested_at_ms,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_feature_release_activation_commands (
        command_id, command_type, idempotency_domain, idempotency_key,
        request_value_id, request_hash, request_schema_resource_id,
        request_schema_hash, domain_request_hash, lifecycle, created_at_ms,
        row_version
      ) VALUES (?, 'activate_feature_release', ?, ?, ?, ?, ?, ?, ?,
                'pending', ?, 0)`,
      [
        commandId,
        request.idempotency_domain,
        request.idempotency_key,
        requestValueId,
        request.request_hash,
        g39SchemaResourceId(request, 'request'),
        request.contract_schemas.request.content_hash,
        request.domain_request_hash,
        request.requested_at_ms,
      ],
    );
  });
}

function rawTamper(
  store: WorkflowRuntimeStore,
  sql: string,
  parameters: Array<string | number | null> = [],
): void {
  const database = new Database(store.databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.9 Feature Release Activation', () => {
  it('orders strict request bytes before Invocation authentication', () => {
    const store = openFresh();
    expect(() =>
      activateFeatureRelease(store, Buffer.from([0xff]), {
        invocation_kind: 'submit',
        actor_ref: '',
        auth_session_ref: '',
        requested_at_ms: -1,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'activation_request_strict_parse_invalid',
      }),
    );
    expect(activationCounts(store)).toMatchObject({
      commands: 0,
      invocations: 0,
      events: 0,
      pointers: 0,
    });
  });

  it('applies an absent pointer once, returns the original receipt on exact replay, and always conflicts on drift', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    const applied = activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      fixture.activation_invocation,
    );
    expect(applied).toMatchObject({
      disposition: 'applied',
      code: 'feature_release_activation_applied',
      invocation_no: 1,
      referenced_terminal_result: null,
      receipt: {
        active_pointer_changed: true,
        pointer: {
          previous_state: 'absent',
          previous_row_version: null,
          applied_row_version: 1,
        },
      },
    });
    expect(
      store.queryOne<{ status: string }>(
        `SELECT status FROM workflow_feature_releases WHERE id = ?`,
        [fixture.activation_request.target_release.release_id],
      ),
    ).toEqual({ status: 'active' });
    expect(
      store.queryOne<{ release_id: string; row_version: number }>(
        `SELECT release_id, row_version FROM workflow_feature_active_releases
          WHERE feature_id = ?`,
        [fixture.activation_request.feature_id],
      ),
    ).toEqual({
      release_id: fixture.activation_request.target_release.release_id,
      row_version: 1,
    });

    const duplicate = activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      {
        ...fixture.activation_invocation,
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 1,
      },
    );
    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      code: 'feature_release_activation_duplicate',
      invocation_no: 2,
      terminal_disposition: 'applied',
      receipt: applied.receipt,
    });
    expect(duplicate.referenced_terminal_result).not.toBeNull();

    const drift = structuredClone(fixture.activation_request);
    drift.requested_at_ms += 2;
    rehashG39ActivationRequest(drift);
    const firstConflict = activateFeatureRelease(store, bytes(drift), {
      ...fixture.activation_invocation,
      requested_at_ms: drift.requested_at_ms,
    });
    const repeatedConflict = activateFeatureRelease(store, bytes(drift), {
      ...fixture.activation_invocation,
      requested_at_ms: drift.requested_at_ms + 1,
    });
    for (const conflict of [firstConflict, repeatedConflict]) {
      expect(conflict).toMatchObject({
        disposition: 'conflict',
        code: 'idempotency_conflict',
        terminal_disposition: 'applied',
        receipt: null,
      });
      expect(conflict.referenced_terminal_result).toEqual(
        duplicate.referenced_terminal_result,
      );
    }
    expect(activationCounts(store)).toMatchObject({
      commands: 1,
      invocations: 4,
      pointers: 1,
    });
    expect(
      store.queryOne<{ row_version: number }>(
        `SELECT row_version FROM workflow_feature_active_releases
          WHERE feature_id = ?`,
        [fixture.activation_request.feature_id],
      ),
    ).toEqual({ row_version: 1 });
  });

  it('moves the previous active Release to draining and advances a present pointer by one', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    const previous = installActivePrevious(store, fixture.activation_request);
    const result = activateFeatureRelease(
      store,
      bytes(previous.request),
      fixture.activation_invocation,
    );
    expect(result).toMatchObject({
      disposition: 'applied',
      receipt: {
        pointer: {
          previous_state: 'present',
          previous_row_version: 1,
          applied_row_version: 2,
        },
        previous_lifecycle: 'draining',
      },
    });
    expect(
      store.queryAll<{ id: string; status: string }>(
        `SELECT id, status FROM workflow_feature_releases
          WHERE id IN (?, ?) ORDER BY id`,
        [
          previous.previousReleaseId,
          fixture.activation_request.target_release.release_id,
        ],
      ),
    ).toEqual([
      {
        id: fixture.activation_request.target_release.release_id,
        status: 'active',
      },
      {
        id: previous.previousReleaseId,
        status: 'draining',
      },
    ]);
    expect(
      store.queryOne<{ release_id: string; row_version: number }>(
        `SELECT release_id, row_version FROM workflow_feature_active_releases
          WHERE feature_id = ?`,
        [fixture.activation_request.feature_id],
      ),
    ).toEqual({
      release_id: fixture.activation_request.target_release.release_id,
      row_version: 2,
    });
    expect(
      store.queryAll<{ id: string; status: string; row_version: number }>(
        `SELECT id, status, row_version
           FROM workflow_registry_retention_handles
          WHERE id IN (?, ?) ORDER BY id`,
        [
          previous.previousRetentionId,
          previous.request.target_retention.handle_id,
        ],
      ),
    ).toEqual([
      { id: previous.previousRetentionId, status: 'held', row_version: 1 },
      {
        id: previous.request.target_retention.handle_id,
        status: 'held',
        row_version: 1,
      },
    ]);
  });

  it.each([
    {
      name: 'resource set',
      expectedCode: 'target_release_resource_set_mismatch',
      prepare: (
        store: WorkflowRuntimeStore,
        request: G39FeatureReleaseActivationRequest,
      ) => {
        store.withImmediateTransaction((transaction) => {
          transaction.execute(
            `DELETE FROM workflow_feature_release_resources
              WHERE release_id = ? AND resource_id = (
                SELECT resource_id FROM workflow_feature_release_resources
                 WHERE release_id = ? ORDER BY resource_id LIMIT 1
              )`,
            [
              request.target_release.release_id,
              request.target_release.release_id,
            ],
          );
        });
      },
    },
    {
      name: 'G3.6 compatibility',
      expectedCode: 'g3_6_preflight_rejected',
      prepare: (
        _store: WorkflowRuntimeStore,
        request: G39FeatureReleaseActivationRequest,
      ) => {
        request.compatibility_preflight.snapshot.snapshot_hash =
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        rehashG39ActivationRequest(request);
      },
    },
    {
      name: 'target lifecycle',
      expectedCode: 'target_release_lifecycle_invalid',
      prepare: (
        store: WorkflowRuntimeStore,
        request: G39FeatureReleaseActivationRequest,
      ) => {
        store.withImmediateTransaction((transaction) => {
          transaction.execute(
            `UPDATE workflow_feature_releases
                SET status = 'active', activated_at_ms = ?, row_version = row_version + 1
              WHERE id = ? AND status = 'staged'`,
            [request.requested_at_ms - 1, request.target_release.release_id],
          );
        });
      },
    },
    {
      name: 'target Retention',
      expectedCode: 'target_retention_status_mismatch',
      prepare: (
        store: WorkflowRuntimeStore,
        request: G39FeatureReleaseActivationRequest,
      ) => {
        store.withImmediateTransaction((transaction) => {
          transaction.execute(
            `UPDATE workflow_registry_retention_handles
                SET status = 'released', released_at_ms = ?,
                    row_version = row_version + 1
              WHERE id = ? AND status = 'held'`,
            [request.requested_at_ms - 1, request.target_retention.handle_id],
          );
        });
      },
    },
  ])(
    'terminalizes $name rejection as failed with no pointer mutation',
    ({ expectedCode, prepare }) => {
      const store = openFresh();
      const fixture = seedPublishedTarget(store);
      const request = structuredClone(fixture.activation_request);
      prepare(store, request);
      const releasesBefore = store.queryAll(
        `SELECT id, status, activated_at_ms, row_version
         FROM workflow_feature_releases ORDER BY id`,
        [],
      );
      const result = activateFeatureRelease(
        store,
        bytes(request),
        fixture.activation_invocation,
      );
      expect(result).toMatchObject({
        disposition: 'failed',
        code: expectedCode,
        terminal_disposition: 'failed',
        referenced_terminal_result: null,
        receipt: null,
        failure: { code: expectedCode },
      });
      expect(activationCounts(store).pointers).toBe(0);
      expect(
        store.queryAll(
          `SELECT id, status, activated_at_ms, row_version
           FROM workflow_feature_releases ORDER BY id`,
          [],
        ),
      ).toEqual(releasesBefore);
      const replay = activateFeatureRelease(store, bytes(request), {
        ...fixture.activation_invocation,
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 1,
      });
      expect(replay).toMatchObject({
        disposition: 'duplicate',
        terminal_disposition: 'failed',
        receipt: null,
      });
    },
  );

  it('terminalizes pointer CAS mismatch as conflict without Release or pointer mutation', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    const installed = installActivePrevious(store, fixture.activation_request);
    const before = transactionFacts(store);
    const result = activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      fixture.activation_invocation,
    );
    expect(result).toMatchObject({
      disposition: 'conflict',
      code: 'pointer_cas_conflict',
      terminal_disposition: 'conflict',
      referenced_terminal_result: null,
      receipt: null,
    });
    const after = transactionFacts(store);
    expect(after.releases).toEqual(before.releases);
    expect(after.pointers).toEqual(before.pointers);
    const replay = activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      {
        ...fixture.activation_invocation,
        invocation_kind: 'recovery',
        auth_session_ref: 'auth-session:pointer-conflict-recovery',
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 1,
      },
    );
    expect(replay).toMatchObject({
      disposition: 'duplicate',
      terminal_disposition: 'conflict',
      receipt: null,
    });
    expect(
      store.queryOne<{ release_id: string; row_version: number }>(
        `SELECT release_id, row_version FROM workflow_feature_active_releases`,
        [],
      ),
    ).toEqual({ release_id: installed.previousReleaseId, row_version: 1 });
  });

  it.each([
    'after_request_value',
    'after_command_pending',
    'after_verified_preflight',
    'after_previous_draining',
    'after_target_active',
    'after_pointer_cas',
    'after_receipt',
    'after_terminal_invocation',
    'after_terminal_events',
  ] satisfies FeatureReleaseActivationFaultPoint[])(
    'rolls back the %s pre-commit fault boundary',
    (faultPoint) => {
      const store = openFresh();
      const fixture = seedPublishedTarget(store);
      const request =
        faultPoint === 'after_previous_draining'
          ? installActivePrevious(store, fixture.activation_request).request
          : fixture.activation_request;
      const before = transactionFacts(store);
      expect(() =>
        activateFeatureRelease(
          store,
          bytes(request),
          fixture.activation_invocation,
          {
            faultInjector: (point) => {
              if (point === faultPoint) throw new Error(`crash:${point}`);
            },
          },
        ),
      ).toThrow(`crash:${faultPoint}`);
      expect(transactionFacts(store)).toEqual(before);
    },
  );

  it('reopens after a committed lost response and appends recovery replay without pointer DML', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    expect(() =>
      activateFeatureRelease(
        store,
        fixture.activation_request_bytes,
        fixture.activation_invocation,
        {
          faultInjector: (point) => {
            if (point === 'after_commit_before_response')
              throw new Error('response-lost');
          },
        },
      ),
    ).toThrow('response-lost');
    const root = path.dirname(store.databasePath);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recoveredStore = reopen(root);
    const replay = activateFeatureRelease(
      recoveredStore,
      fixture.activation_request_bytes,
      {
        ...fixture.activation_invocation,
        invocation_kind: 'recovery',
        auth_session_ref: 'auth-session:reopen-recovery',
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 10,
      },
    );
    expect(replay).toMatchObject({
      disposition: 'duplicate',
      terminal_disposition: 'applied',
      invocation_no: 2,
    });
    expect(
      recoveredStore.queryOne<{ row_version: number }>(
        `SELECT row_version FROM workflow_feature_active_releases`,
        [],
      ),
    ).toEqual({ row_version: 1 });
    expect(
      recoveredStore
        .queryAll<{ event_type: string }>(
          `SELECT event_type FROM workflow_feature_release_activation_events
            WHERE attempt_no = 2 ORDER BY event_no`,
          [],
        )
        .map((entry) => entry.event_type),
    ).toEqual([
      'attempt_started',
      'recovery_started',
      'recovery_succeeded',
      'terminal_replayed',
    ]);
  });

  it('bounded recovery resumes a clean pending command from its canonical request Value', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    insertCleanPending(store, fixture.activation_request);
    const recovered = recoverPendingFeatureReleaseActivations(store, {
      limit: 1,
      actor_ref: fixture.activation_request.actor_ref,
      auth_session_ref: 'auth-session:pending-recovery',
      requested_at_ms: fixture.activation_request.requested_at_ms + 20,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      disposition: 'applied',
      invocation_no: 1,
      receipt: { pointer: { applied_row_version: 1 } },
    });
    expect(
      store.queryOne<{ lifecycle: string }>(
        `SELECT lifecycle FROM workflow_feature_release_activation_commands`,
        [],
      ),
    ).toEqual({ lifecycle: 'applied' });
  });

  it('keeps pending same-key drift non-terminal, conflicts repeatedly, then recovers the bound request', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    insertCleanPending(store, fixture.activation_request);
    const drift = structuredClone(fixture.activation_request);
    drift.requested_at_ms += 1;
    rehashG39ActivationRequest(drift);
    const first = activateFeatureRelease(store, bytes(drift), {
      ...fixture.activation_invocation,
      requested_at_ms: drift.requested_at_ms,
    });
    const second = activateFeatureRelease(store, bytes(drift), {
      ...fixture.activation_invocation,
      requested_at_ms: drift.requested_at_ms + 1,
    });
    for (const result of [first, second]) {
      expect(result).toMatchObject({
        disposition: 'conflict',
        code: 'idempotency_conflict',
        terminal_disposition: null,
        referenced_terminal_result: null,
        receipt: null,
      });
    }
    expect(
      store.queryOne<{ lifecycle: string }>(
        `SELECT lifecycle FROM workflow_feature_release_activation_commands`,
        [],
      ),
    ).toEqual({ lifecycle: 'pending' });
    const recovered = recoverPendingFeatureReleaseActivations(store, {
      limit: 1,
      actor_ref: fixture.activation_request.actor_ref,
      auth_session_ref: 'auth-session:pending-after-drift',
      requested_at_ms: drift.requested_at_ms + 10,
    });
    expect(recovered[0]).toMatchObject({
      disposition: 'applied',
      invocation_no: 3,
      referenced_terminal_result: null,
    });
    expect(
      store.queryOne<{
        canonical_terminal_invocation_no: number;
        lifecycle: string;
      }>(
        `SELECT canonical_terminal_invocation_no, lifecycle
           FROM workflow_feature_release_activation_commands`,
        [],
      ),
    ).toEqual({ canonical_terminal_invocation_no: 3, lifecycle: 'applied' });
  });

  it('fails closed on inconsistent transition evidence in a pending command', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    insertCleanPending(store, fixture.activation_request);
    store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_feature_releases
            SET status = 'active', activated_at_ms = ?, row_version = row_version + 1
          WHERE id = ? AND status = 'staged'`,
        [
          fixture.activation_request.requested_at_ms,
          fixture.activation_request.target_release.release_id,
        ],
      );
    });
    const before = activationCounts(store);
    expect(() =>
      recoverPendingFeatureReleaseActivations(store, {
        limit: 1,
        actor_ref: fixture.activation_request.actor_ref,
        auth_session_ref: 'auth-session:inconsistent-pending',
        requested_at_ms: fixture.activation_request.requested_at_ms + 10,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'terminal_integrity_mismatch' }),
    );
    expect(activationCounts(store)).toEqual(before);
  });

  it.each([
    {
      name: 'command terminal result hash',
      tamper: (store: WorkflowRuntimeStore) => {
        rawTamper(
          store,
          `DROP TRIGGER "trg:activation_commands:verified_fact_transition"`,
        );
        rawTamper(
          store,
          `UPDATE workflow_feature_release_activation_commands
              SET canonical_terminal_result_hash = ?`,
          [
            'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          ],
        );
      },
    },
    {
      name: 'result Value schema',
      tamper: (store: WorkflowRuntimeStore) =>
        rawTamper(
          store,
          `UPDATE workflow_values SET inline_canonical_json = '{}', byte_length = 2
            WHERE id = (SELECT canonical_terminal_result_value_id
              FROM workflow_feature_release_activation_commands)`,
        ),
    },
    {
      name: 'receipt Value hash binding',
      tamper: (store: WorkflowRuntimeStore) =>
        rawTamper(
          store,
          `UPDATE workflow_values SET content_hash = ?
            WHERE id = (SELECT canonical_receipt_value_id
              FROM workflow_feature_release_activation_commands)`,
          [
            'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          ],
        ),
    },
    {
      name: 'Invocation hash',
      tamper: (store: WorkflowRuntimeStore) => {
        rawTamper(
          store,
          `DROP TRIGGER "trg:activation_invocations:immutable_update"`,
        );
        rawTamper(
          store,
          `UPDATE workflow_feature_release_activation_invocations
              SET invocation_hash = ? WHERE invocation_no = 1`,
          [
            'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          ],
        );
      },
    },
    {
      name: 'Invocation result schema binding',
      tamper: (store: WorkflowRuntimeStore) => {
        rawTamper(
          store,
          `DROP TRIGGER "trg:activation_invocations:immutable_update"`,
        );
        rawTamper(
          store,
          `UPDATE workflow_feature_release_activation_invocations
              SET result_schema_resource_id = 'registry-resource:schema:tampered@1.0.0',
                  referenced_terminal_result_schema_resource_id =
                    'registry-resource:schema:tampered@1.0.0'
            WHERE invocation_no = 1`,
        );
      },
    },
    {
      name: 'Event hash',
      tamper: (store: WorkflowRuntimeStore) => {
        rawTamper(
          store,
          `DROP TRIGGER "trg:activation_events:immutable_update"`,
        );
        rawTamper(
          store,
          `UPDATE workflow_feature_release_activation_events SET event_hash = ?
            WHERE event_no = 1`,
          [
            'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          ],
        );
      },
    },
    {
      name: 'Event attempt binding',
      tamper: (store: WorkflowRuntimeStore) => {
        rawTamper(
          store,
          `DROP TRIGGER "trg:activation_events:immutable_update"`,
        );
        rawTamper(
          store,
          `UPDATE workflow_feature_release_activation_events SET attempt_no = 99
            WHERE event_no = 1`,
        );
      },
    },
  ])('fails closed without forged audit after $name tamper', ({ tamper }) => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      fixture.activation_invocation,
    );
    const before = activationCounts(store);
    tamper(store);
    expect(() =>
      activateFeatureRelease(store, fixture.activation_request_bytes, {
        ...fixture.activation_invocation,
        invocation_kind: 'recovery',
        auth_session_ref: 'auth-session:tamper-recovery',
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 20,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'terminal_integrity_mismatch' }),
    );
    expect(activationCounts(store)).toEqual(before);
  });

  it('fails closed when a schema-valid Event is appended with a recomputed hash', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      fixture.activation_invocation,
    );
    const head = store.queryOne<
      Record<string, string | number | null> & {
        event_hash: string;
        event_no: number;
      }
    >(
      `SELECT command_id, event_no, attempt_no, phase, event_type, failure_code,
              verified_feature_id, verified_target_feature_release_id,
              verified_target_feature_release_ref,
              verified_target_feature_release_version,
              verified_target_feature_release_hash,
              verified_previous_feature_release_id,
              verified_previous_feature_release_ref,
              verified_previous_feature_release_version,
              verified_previous_feature_release_hash, detail_value_id,
              detail_hash, detail_schema_resource_id, detail_schema_hash,
              previous_event_hash, event_hash, occurred_at_ms
         FROM workflow_feature_release_activation_events
        ORDER BY event_no DESC LIMIT 1`,
      [],
    )!;
    const { event_hash: previousEventHash, ...headWithoutHash } = head;
    const appended: Record<string, string | number | null> & {
      event_no: number;
      phase: string;
      event_type: string;
      failure_code: string;
      previous_event_hash: string;
    } = {
      ...headWithoutHash,
      event_no: head.event_no + 1,
      phase: 'recovery',
      event_type: 'integrity_failed',
      failure_code: 'terminal_integrity_mismatch',
      previous_event_hash: previousEventHash,
    };
    const appendedHash = domainSeparatedSha256(G39_EVENT_DOMAIN, appended);
    rawTamper(
      store,
      `INSERT INTO workflow_feature_release_activation_events (
        command_id, event_no, attempt_no, phase, event_type, failure_code,
        verified_feature_id, verified_target_feature_release_id,
        verified_target_feature_release_ref,
        verified_target_feature_release_version,
        verified_target_feature_release_hash,
        verified_previous_feature_release_id,
        verified_previous_feature_release_ref,
        verified_previous_feature_release_version,
        verified_previous_feature_release_hash, detail_value_id, detail_hash,
        detail_schema_resource_id, detail_schema_hash, previous_event_hash,
        event_hash, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appended.command_id,
        appended.event_no,
        appended.attempt_no,
        appended.phase,
        appended.event_type,
        appended.failure_code,
        appended.verified_feature_id,
        appended.verified_target_feature_release_id,
        appended.verified_target_feature_release_ref,
        appended.verified_target_feature_release_version,
        appended.verified_target_feature_release_hash,
        appended.verified_previous_feature_release_id,
        appended.verified_previous_feature_release_ref,
        appended.verified_previous_feature_release_version,
        appended.verified_previous_feature_release_hash,
        appended.detail_value_id,
        appended.detail_hash,
        appended.detail_schema_resource_id,
        appended.detail_schema_hash,
        appended.previous_event_hash,
        appendedHash,
        appended.occurred_at_ms,
      ],
    );
    const before = activationCounts(store);
    expect(() =>
      activateFeatureRelease(store, fixture.activation_request_bytes, {
        ...fixture.activation_invocation,
        invocation_kind: 'recovery',
        auth_session_ref: 'auth-session:semantic-event-tamper',
        requested_at_ms: fixture.activation_invocation.requested_at_ms + 20,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'terminal_integrity_mismatch' }),
    );
    expect(activationCounts(store)).toEqual(before);
  });

  it('preserves active Release deletion and held Retention release protections', () => {
    const store = openFresh();
    const fixture = seedPublishedTarget(store);
    activateFeatureRelease(
      store,
      fixture.activation_request_bytes,
      fixture.activation_invocation,
    );
    expect(() =>
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          `DELETE FROM workflow_feature_releases WHERE id = ?`,
          [fixture.activation_request.target_release.release_id],
        );
      }),
    ).toThrow('active_or_draining_feature_release_delete_forbidden');
    expect(() =>
      store.withImmediateTransaction((transaction) => {
        transaction.execute(
          `UPDATE workflow_registry_retention_handles
              SET status = 'released', released_at_ms = ?,
                  row_version = row_version + 1
            WHERE id = ?`,
          [
            fixture.activation_request.requested_at_ms + 1,
            fixture.activation_request.target_retention.handle_id,
          ],
        );
      }),
    ).toThrow('retention_handle_release_transition_invalid');
  });

  it('produces identical semantic rows in two independent real-file databases', () => {
    const firstStore = openFresh();
    const first = seedPublishedTarget(firstStore);
    const firstResult = activateFeatureRelease(
      firstStore,
      first.activation_request_bytes,
      first.activation_invocation,
    );
    const secondStore = openFresh();
    const second = seedPublishedTarget(secondStore);
    const secondResult = activateFeatureRelease(
      secondStore,
      second.activation_request_bytes,
      second.activation_invocation,
    );
    expect(secondResult).toEqual(firstResult);
    const snapshot = (store: WorkflowRuntimeStore) => ({
      commands: store.queryAll(
        `SELECT * FROM workflow_feature_release_activation_commands ORDER BY command_id`,
        [],
      ),
      invocations: store.queryAll(
        `SELECT * FROM workflow_feature_release_activation_invocations
          ORDER BY command_id, invocation_no`,
        [],
      ),
      events: store.queryAll(
        `SELECT * FROM workflow_feature_release_activation_events
          ORDER BY command_id, event_no`,
        [],
      ),
      values: store.queryAll(
        `SELECT * FROM workflow_values
          WHERE provenance_ref = 'icarus.feature-release-activation/1'
          ORDER BY id`,
        [],
      ),
      releases: store.queryAll(
        `SELECT * FROM workflow_feature_releases ORDER BY id`,
        [],
      ),
      pointers: store.queryAll(
        `SELECT * FROM workflow_feature_active_releases ORDER BY feature_id`,
        [],
      ),
    });
    expect(snapshot(secondStore)).toEqual(snapshot(firstStore));
  });
});
