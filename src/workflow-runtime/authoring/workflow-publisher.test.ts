import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateG37ApprovedReviewHash,
  calculateG37DomainRequestHash,
  calculateG37RequestHash,
  workflowFeatureReleaseId,
} from '../contracts/g3-workflow-publisher.js';
import { g37WorkflowPublisherStoreFixtureForTest } from '../contracts/g3-workflow-publisher-fixtures.js';
import { calculateG3PublishPreflightHash } from '../contracts/g3-registry-publish-foundation.js';
import type {
  G3WorkflowPublisherApprovedReview,
  G3WorkflowPublisherRequest,
} from '../contracts/g3-workflow-publisher-types.js';
import { persistRegistryPersistenceBatch } from '../store/registry-persistence.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import {
  publishStagedWorkflowRelease,
  type WorkflowPublisherApprovedReviewRegistry,
  type WorkflowPublisherFaultPoint,
} from './workflow-publisher.js';

const stores: WorkflowRuntimeStore[] = [];
const roots: string[] = [];

function openFresh(): WorkflowRuntimeStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g3-7-test-'));
  roots.push(root);
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'create',
  });
  stores.push(store);
  return store;
}

function reopen(root: string): WorkflowRuntimeStore {
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath: path.join(root, 'workflow-runtime.db'),
    databaseMode: 'open_existing',
  });
  stores.push(store);
  return store;
}

function registry(
  review: G3WorkflowPublisherApprovedReview,
): WorkflowPublisherApprovedReviewRegistry {
  return {
    resolveApprovedReview: (ref, hash) =>
      ref === review.review_ref && hash === review.review_hash
        ? structuredClone(review)
        : null,
  };
}

function seed(store: WorkflowRuntimeStore) {
  const fixture = g37WorkflowPublisherStoreFixtureForTest();
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
  return fixture;
}

function rehashRequest(request: G3WorkflowPublisherRequest): void {
  request.domain_request_hash = calculateG37DomainRequestHash(request);
  request.request_hash = calculateG37RequestHash(request);
}

function counts(store: WorkflowRuntimeStore) {
  return store.queryOne<Record<string, number>>(
    `SELECT
      (SELECT COUNT(*) FROM workflow_publisher_commands) AS commands,
      (SELECT COUNT(*) FROM workflow_publisher_command_invocations) AS invocations,
      (SELECT COUNT(*) FROM workflow_publisher_events) AS events,
      (SELECT COUNT(*) FROM workflow_feature_releases) AS releases,
      (SELECT COUNT(*) FROM workflow_feature_release_resources) AS release_resources,
      (SELECT COUNT(*) FROM workflow_registry_retention_handles) AS handles,
      (SELECT COUNT(*) FROM workflow_registry_retention_handle_members) AS handle_members,
      (SELECT COUNT(*) FROM workflow_feature_active_releases) AS active_pointers`,
    [],
  )!;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('G3.7 WorkflowPublisher staged publish', () => {
  it('atomically publishes exact Registry, staged Release, Retention, and audit facts', () => {
    const store = openFresh();
    const fixture = seed(store);
    const result = publishStagedWorkflowRelease(
      store,
      fixture.request,
      fixture.invocation,
      registry(fixture.approved_review),
    );
    expect(result).toMatchObject({
      disposition: 'applied',
      code: 'staged_publish_applied',
      invocation_no: 1,
      receipt: {
        outcome: 'applied',
        active_pointer_changed: false,
        registry_publication_count: fixture.request.release_resources.length,
      },
    });
    expect(counts(store)).toMatchObject({
      commands: 1,
      invocations: 1,
      releases: 1,
      release_resources: fixture.request.release_resources.length,
      handles: 1,
      handle_members: fixture.request.target_release.resources.length,
      active_pointers: 0,
    });
    expect(
      store.queryOne<{ status: string }>(
        `SELECT status FROM workflow_feature_releases WHERE id = ?`,
        [workflowFeatureReleaseId(fixture.request.target_release.release_ref)],
      ),
    ).toEqual({ status: 'staged' });
    expect(
      store.queryOne<{ staged: number; published: number }>(
        `SELECT
          SUM(CASE WHEN publication_state = 'staged' THEN 1 ELSE 0 END) AS staged,
          SUM(CASE WHEN publication_state = 'published' THEN 1 ELSE 0 END) AS published
         FROM workflow_registry_resources
         WHERE id IN (${fixture.request.release_resources.map(() => '?').join(',')})`,
        fixture.request.release_resources.map(
          (entry) =>
            `registry-resource:${entry.resource_type}:${entry.ref.id}@${entry.ref.version}`,
        ),
      ),
    ).toEqual({
      staged: 0,
      published: fixture.request.release_resources.length,
    });
  });

  it('returns exact duplicate and same-key conflict while appending immutable chains', () => {
    const store = openFresh();
    const fixture = seed(store);
    const applied = publishStagedWorkflowRelease(
      store,
      fixture.request,
      fixture.invocation,
      registry(fixture.approved_review),
    );
    const duplicate = publishStagedWorkflowRelease(
      store,
      structuredClone(fixture.request),
      {
        ...fixture.invocation,
        requested_at_ms: fixture.invocation.requested_at_ms + 1,
      },
      registry(fixture.approved_review),
    );
    expect(duplicate).toMatchObject({
      disposition: 'duplicate',
      code: 'staged_publish_duplicate',
      invocation_no: 2,
      receipt: applied.receipt,
    });

    const conflictRequest = structuredClone(fixture.request);
    conflictRequest.approved_review.review_ref = 'workflow-review:conflict';
    conflictRequest.approved_review.review_hash =
      calculateG37ApprovedReviewHash(conflictRequest.approved_review);
    rehashRequest(conflictRequest);
    const conflict = publishStagedWorkflowRelease(
      store,
      conflictRequest,
      {
        ...fixture.invocation,
        requested_at_ms: fixture.invocation.requested_at_ms + 2,
      },
      registry(fixture.approved_review),
    );
    expect(conflict).toMatchObject({
      disposition: 'conflict',
      code: 'idempotency_conflict',
      invocation_no: 3,
      receipt: null,
    });
    const invocations = store.queryAll<{
      invocation_no: number;
      previous_invocation_hash: string | null;
      invocation_hash: string;
      disposition: string;
    }>(
      `SELECT invocation_no, previous_invocation_hash, invocation_hash, disposition
         FROM workflow_publisher_command_invocations ORDER BY invocation_no`,
      [],
    );
    expect(invocations.map((entry) => entry.disposition)).toEqual([
      'applied',
      'duplicate',
      'conflict',
    ]);
    expect(invocations[0].previous_invocation_hash).toBeNull();
    expect(invocations[1].previous_invocation_hash).toBe(
      invocations[0].invocation_hash,
    );
    expect(invocations[2].previous_invocation_hash).toBe(
      invocations[1].invocation_hash,
    );
    const events = store.queryAll<{
      event_no: number;
      previous_event_hash: string | null;
      event_hash: string;
    }>(
      `SELECT event_no, previous_event_hash, event_hash
         FROM workflow_publisher_events ORDER BY event_no`,
      [],
    );
    expect(events[0].previous_event_hash).toBeNull();
    for (let index = 1; index < events.length; index += 1)
      expect(events[index].previous_event_hash).toBe(
        events[index - 1].event_hash,
      );
    expect(counts(store).releases).toBe(1);
  });

  it('rolls back every crash point and recovers deterministically after reopen', () => {
    const store = openFresh();
    const fixture = seed(store);
    const before = counts(store);
    expect(() =>
      publishStagedWorkflowRelease(
        store,
        fixture.request,
        fixture.invocation,
        registry(fixture.approved_review),
        {
          faultInjector: (point) => {
            if (point === 'after_registry_publication')
              throw new Error('simulated process crash');
          },
        },
      ),
    ).toThrow('simulated process crash');
    expect(counts(store)).toEqual(before);
    expect(
      store.queryOne<{ published: number }>(
        `SELECT COUNT(*) AS published FROM workflow_registry_resources
          WHERE publication_state = 'published' AND id IN (${fixture.request.release_resources.map(() => '?').join(',')})`,
        fixture.request.release_resources.map(
          (entry) =>
            `registry-resource:${entry.resource_type}:${entry.ref.id}@${entry.ref.version}`,
        ),
      ),
    ).toEqual({ published: 0 });

    const root = path.dirname(store.databasePath);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recoveredStore = reopen(root);
    const recovery = publishStagedWorkflowRelease(
      recoveredStore,
      fixture.request,
      {
        ...fixture.invocation,
        invocation_kind: 'recovery',
        requested_at_ms: fixture.invocation.requested_at_ms + 10,
      },
      registry(fixture.approved_review),
    );
    expect(recovery).toMatchObject({
      disposition: 'applied',
      invocation_no: 1,
    });
    recoveredStore.close();
    stores.splice(stores.indexOf(recoveredStore), 1);
    const postCommit = reopen(root);
    const replay = publishStagedWorkflowRelease(
      postCommit,
      fixture.request,
      {
        ...fixture.invocation,
        invocation_kind: 'recovery',
        auth_session_ref: 'auth-session:post-crash',
        requested_at_ms: fixture.invocation.requested_at_ms + 20,
      },
      registry(fixture.approved_review),
    );
    expect(replay).toMatchObject({
      disposition: 'duplicate',
      invocation_no: 2,
      receipt: recovery.receipt,
    });
    expect(
      postCommit
        .queryAll<{ event_type: string }>(
          `SELECT event_type FROM workflow_publisher_events
          WHERE attempt_no = 2 ORDER BY event_no`,
          [],
        )
        .map((entry) => entry.event_type),
    ).toEqual(['attempt_started', 'recovery_started', 'recovery_succeeded']);
  });

  it.each([
    'after_command_pending',
    'after_registry_publication',
    'after_feature_release_resources',
    'after_retention_root',
    'before_command_finalize',
  ] satisfies WorkflowPublisherFaultPoint[])(
    'rolls back the %s fault boundary',
    (faultPoint) => {
      const store = openFresh();
      const fixture = seed(store);
      const before = counts(store);
      expect(() =>
        publishStagedWorkflowRelease(
          store,
          fixture.request,
          fixture.invocation,
          registry(fixture.approved_review),
          {
            faultInjector: (point) => {
              if (point === faultPoint) throw new Error(`crash:${point}`);
            },
          },
        ),
      ).toThrow(`crash:${faultPoint}`);
      expect(counts(store)).toEqual(before);
      expect(
        store.queryOne<{ staged: number }>(
          `SELECT COUNT(*) AS staged FROM workflow_registry_resources
            WHERE publication_state = 'staged' AND id IN (${fixture.request.release_resources.map(() => '?').join(',')})`,
          fixture.request.release_resources.map(
            (entry) =>
              `registry-resource:${entry.resource_type}:${entry.ref.id}@${entry.ref.version}`,
          ),
        ),
      ).toEqual({ staged: fixture.request.release_resources.length });
    },
  );

  it('produces byte-equivalent semantic facts in independent real-file databases', () => {
    const firstStore = openFresh();
    const first = seed(firstStore);
    const firstResult = publishStagedWorkflowRelease(
      firstStore,
      first.request,
      first.invocation,
      registry(first.approved_review),
    );
    const secondStore = openFresh();
    const second = seed(secondStore);
    const secondResult = publishStagedWorkflowRelease(
      secondStore,
      second.request,
      second.invocation,
      registry(second.approved_review),
    );
    expect(secondResult).toEqual(firstResult);
    const snapshot = (store: WorkflowRuntimeStore) => ({
      commands: store.queryAll(
        `SELECT * FROM workflow_publisher_commands ORDER BY command_id`,
        [],
      ),
      invocations: store.queryAll(
        `SELECT * FROM workflow_publisher_command_invocations ORDER BY command_id, invocation_no`,
        [],
      ),
      events: store.queryAll(
        `SELECT * FROM workflow_publisher_events ORDER BY command_id, event_no`,
        [],
      ),
      releases: store.queryAll(
        `SELECT * FROM workflow_feature_releases ORDER BY id`,
        [],
      ),
      releaseResources: store.queryAll(
        `SELECT * FROM workflow_feature_release_resources ORDER BY release_id, resource_id`,
        [],
      ),
      handles: store.queryAll(
        `SELECT * FROM workflow_registry_retention_handles ORDER BY id`,
        [],
      ),
      handleMembers: store.queryAll(
        `SELECT * FROM workflow_registry_retention_handle_members ORDER BY handle_id, resource_id`,
        [],
      ),
    });
    expect(snapshot(secondStore)).toEqual(snapshot(firstStore));
  });

  it('persists failed disposition without publishing resources or Retention roots', () => {
    const store = openFresh();
    const fixture = seed(store);
    const request = structuredClone(fixture.request);
    request.publish_preflight.retention_policy_hash =
      'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    request.publish_preflight.preflight_hash = calculateG3PublishPreflightHash(
      request.publish_preflight,
    );
    rehashRequest(request);
    const result = publishStagedWorkflowRelease(
      store,
      request,
      fixture.invocation,
      registry(fixture.approved_review),
    );
    expect(result).toMatchObject({
      disposition: 'failed',
      code: 'publish_foundation_preflight_failed',
      receipt: {
        outcome: 'failed',
        registry_publication_count: 0,
        retention_handle_id: null,
      },
    });
    expect(counts(store)).toMatchObject({
      commands: 1,
      invocations: 1,
      releases: 1,
      release_resources: 0,
      handles: 0,
      active_pointers: 0,
    });
    expect(
      store.queryOne<{ lifecycle: string; disposition: string }>(
        `SELECT c.lifecycle, i.disposition
           FROM workflow_publisher_commands c
           JOIN workflow_publisher_command_invocations i
             ON i.command_id = c.command_id`,
        [],
      ),
    ).toEqual({ lifecycle: 'failed', disposition: 'failed' });
  });

  it('rejects expired review and release collision with no partial transaction', () => {
    const expiredStore = openFresh();
    const expired = seed(expiredStore);
    expect(() =>
      publishStagedWorkflowRelease(
        expiredStore,
        expired.request,
        {
          ...expired.invocation,
          requested_at_ms: expired.approved_review.expires_at_ms,
        },
        registry(expired.approved_review),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'approved_review_expired' }),
    );
    expect(counts(expiredStore).commands).toBe(0);

    const collisionStore = openFresh();
    const collision = seed(collisionStore);
    collisionStore.withImmediateTransaction((transaction) => {
      transaction.execute(
        `INSERT INTO workflow_feature_releases (
          id, feature_id, release_ref, release_version, release_hash,
          execution_artifact_resource_id, execution_artifact_hash, status,
          staged_at_ms, activated_at_ms, disabled_at_ms, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL, NULL, 1)`,
        [
          workflowFeatureReleaseId(
            collision.request.target_release.release_ref,
          ),
          collision.request.target_release.feature_id,
          collision.request.target_release.release_ref.id,
          collision.request.target_release.release_ref.version,
          collision.request.target_release.release_hash,
          `registry-resource:feature_execution_artifact:${collision.request.target_release.execution_artifact.ref.id}@${collision.request.target_release.execution_artifact.ref.version}`,
          collision.request.target_release.execution_artifact.hash,
          collision.invocation.requested_at_ms,
        ],
      );
    });
    const before = counts(collisionStore);
    expect(() =>
      publishStagedWorkflowRelease(
        collisionStore,
        collision.request,
        collision.invocation,
        registry(collision.approved_review),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'feature_release_identity_collision' }),
    );
    expect(counts(collisionStore)).toEqual(before);
  });
});
